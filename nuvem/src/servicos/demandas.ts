/**
 * Demandas — o que chegou por fora do SEI, e o que se fez dele.
 * Porte de `app/servicos/demandas.py`.
 *
 * O problema, nas palavras de quem opera o setor: *"quero ter a possibilidade de
 * colocar demandas que chegaram para mim por e-mail ou presencialmente, que ainda
 * não viraram ou não vão virar processo SEI, mas precisam de encaminhamentos,
 * como organizar isso para eu não perder essa demanda"*.
 *
 * Três decisões de projeto atravessam este arquivo inteiro:
 *
 * 1. **A equipe toda enxerga.** A lista não é filtrada por dono — é a fila do
 *    setor. Demanda que só uma pessoa vê some quando ela entra de férias.
 * 2. **O vínculo com o processo SEI existe, e é uma chave estrangeira.**
 *    Encerrar como `VIROU_PROCESSO` exige o `processo.id` real; sem processo
 *    cadastrado, a recusa diz onde cadastrá-lo em vez de aceitar um NUP digitado
 *    à mão.
 * 3. **O prazo é opcional e cobra.** Com prazo, a demanda abre pendência e entra
 *    no sino; `_sincronizar_pendencia` é o único lugar que decide isso.
 *
 * **RN-21 em todo texto livre, e este é o campo mais perigoso do sistema.** Cada
 * campo de texto passa por `textos.exigir_texto_limpo` antes de qualquer
 * gravação — e a recusa sobe como exceção para a rota devolver o formulário com
 * o que foi digitado.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  demanda as tabela_demanda,
  demanda_encaminhamento,
  pendencia as tabela_pendencia,
  processo as tabela_processo,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import {
  CANAIS_DEMANDA,
  DESFECHOS_DEMANDA,
  ROTULO_DESFECHO_DEMANDA,
  exigir_transicao_demanda,
} from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export type Demanda = typeof tabela_demanda.$inferSelect;
export type DemandaEncaminhamento = typeof demanda_encaminhamento.$inferSelect;

export const PERMISSAO_VER = "demanda.ver";
export const PERMISSAO_ESCREVER = "demanda.registrar";

export const TIPO_PENDENCIA = "DEMANDA_COM_PRAZO";
/** O aviso que vai para QUEM DEMANDOU, e não para a CSSO. */
export const TIPO_AVISO_DESFECHO = "DEMANDA_DESFECHO_A_LER";

/** Recusa de regra de negócio — sai na tela como aviso, não como 500. */
export class RegraDaDemanda extends RegraViolada {}

/**
 * A chave idempotente da pendência do prazo. Uma por demanda, para sempre: a
 * demanda que perdeu o prazo e o recuperou volta para a MESMA linha do sino.
 */
export function chave_pendencia(demanda_id: number): string {
  return `demanda:${demanda_id}`;
}

export function chave_aviso_desfecho(demanda_id: number): string {
  return `demanda:desfecho:${demanda_id}`;
}

async function _gravar(tx: Executor, demanda: Demanda, campos: Partial<Demanda>): Promise<void> {
  await tx.update(tabela_demanda).set(campos).where(eq(tabela_demanda.id, demanda.id));
  Object.assign(demanda, campos);
}

// ---------------------------------------------------------------------
// A pendência do prazo — o único lugar que decide se a demanda cobra
// ---------------------------------------------------------------------
/**
 * Põe a fila de tarefas em dia com o que a demanda diz agora.
 *
 * - encerrada, ou sem prazo  → conclui a tarefa, se houver;
 * - com prazo e sem tarefa   → abre;
 * - com prazo e com tarefa concluída → **reabre a mesma**, e não abre outra;
 * - com prazo e tarefa aberta → reconfere prazo, dono e descrição.
 */
export async function _sincronizar_pendencia(
  tx: Executor,
  demanda: Demanda,
  usuario: UsuarioAtual | null,
): Promise<pendencias.Pendencia | null> {
  const [existente] = await tx
    .select()
    .from(tabela_pendencia)
    .where(eq(tabela_pendencia.chave, chave_pendencia(demanda.id)));

  if (demanda.estado === "ENCERRADA" || demanda.prazo === null) {
    if (existente && !existente.concluida && usuario) await pendencias.concluir(tx, existente, usuario);
    return existente ?? null;
  }

  const descricao = `${demanda.assunto} — demanda de ${demanda.solicitante_nome}`;
  if (!existente) {
    return pendencias.abrir(tx, {
      tipo: TIPO_PENDENCIA,
      chave: chave_pendencia(demanda.id),
      descricao,
      usuario,
      entidade: "demanda",
      entidade_id: demanda.id,
      responsavel_id: demanda.responsavel_id,
      prazo: demanda.prazo,
    });
  }
  if (existente.concluida && usuario) {
    await pendencias.reabrir(tx, existente, usuario, "a demanda voltou a ter prazo");
  }
  const campos = { descricao, responsavel_id: demanda.responsavel_id, prazo: demanda.prazo };
  await tx.update(tabela_pendencia).set(campos).where(eq(tabela_pendencia.id, existente.id));
  Object.assign(existente, campos);
  return existente;
}

// ---------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------
/**
 * `strip`, depois RN-21 — e devolve `null` para o que ficou vazio. `campo` é o
 * RÓTULO DA TELA, e não o nome da coluna.
 *
 * Na demanda o termo de saúde é AVISO (`MencaoDeSaude`), e passa com
 * `confirmado`: "servidora gestante solicita afastamento de área insalubre" é
 * a demanda de rotina. CPF e CID continuam recusados.
 */
export function _limpar(valor: string | null | undefined, campo: string, confirmado = false): string | null {
  const texto = (valor ?? "").trim();
  if (!texto) return null;
  textos.exigir_texto_limpo(texto, campo, textos.CONTEXTO_AVISO_SAUDE, confirmado);
  return texto;
}

/** Quem demandou e não foi dito nem escolhido do cadastro. */
export const SOLICITANTE_NAO_IDENTIFICADO = "não identificado";

/** RESOLVIDA sem relato: a CHECK do banco quer texto, e o texto diz que não houve. */
export const RELATO_PADRAO_RESOLVIDA = "Resolvida, sem relato por escrito.";

/** A trilha da confirmação de RN-21, um evento por campo que trouxe termo de saúde. */
async function _registrar_mencoes(
  tx: Executor,
  usuario: UsuarioAtual,
  demanda_id: number,
  campos: [string, string | null][],
): Promise<void> {
  for (const [campo, texto] of campos) {
    await auditoria.registrar_mencao_de_saude(tx, { entidade: "demanda", entidade_id: demanda_id, campo, texto, usuario });
  }
}

function repr(valor: string): string {
  // o `{canal!r}` do Python
  return `'${valor.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export interface DadosRegistro {
  assunto: string;
  canal: string;
  solicitante_nome: string;
  data_chegada?: string | null;
  descricao?: string | null;
  solicitante_servidor_id?: number | null;
  solicitante_unidade_uorg_id?: number | null;
  responsavel_id?: number | null;
  prazo?: string | null;
  confirmo_mencao_saude?: boolean;
}

/**
 * Grava a demanda que acabou de chegar. Os três padrões que fazem isto caber em
 * trinta segundos moram aqui: data de hoje, responsável = quem está
 * cadastrando, e o canal mais comum primeiro no seletor.
 */
export async function registrar(tx: Executor, usuario: UsuarioAtual, d: DadosRegistro): Promise<Demanda> {
  usuario.exigir(PERMISSAO_ESCREVER);

  if (!(CANAIS_DEMANDA as readonly string[]).includes(d.canal)) {
    throw new RegraDaDemanda(`Canal desconhecido: ${repr(d.canal)}.`);
  }
  const ok = d.confirmo_mencao_saude ?? false;
  const assunto_limpo = _limpar(d.assunto, "assunto", ok);
  if (assunto_limpo === null) {
    throw new RegraDaDemanda(
      "O assunto é obrigatório — é a linha que aparece na fila, e sem ela " + "a demanda vira uma data sem conteúdo.",
    );
  }
  // Em branco: o nome do servidor escolhido do cadastro; sem ele, "não identificado".
  let solicitante = _limpar(d.solicitante_nome, "quem demandou", ok);
  if (solicitante === null && d.solicitante_servidor_id) {
    const [srv] = await tx
      .select({ nome: tabela_servidor.nome })
      .from(tabela_servidor)
      .where(eq(tabela_servidor.id, d.solicitante_servidor_id));
    solicitante = srv?.nome ?? null;
  }
  solicitante ??= SOLICITANTE_NAO_IDENTIFICADO;
  const descricao = _limpar(d.descricao, "descrição da demanda", ok);

  const [demanda] = await tx
    .insert(tabela_demanda)
    .values({
      data_chegada: d.data_chegada || hoje_iso(),
      canal: d.canal,
      solicitante_nome: solicitante,
      solicitante_servidor_id: d.solicitante_servidor_id ?? null,
      solicitante_unidade_uorg_id: d.solicitante_unidade_uorg_id ?? null,
      assunto: assunto_limpo,
      descricao,
      responsavel_id: d.responsavel_id || usuario.id,
      prazo: d.prazo || null,
      estado: "ABERTA",
      criada_por: usuario.id,
    })
    .returning();

  await auditoria.registrar(tx, {
    entidade: "demanda",
    entidade_id: demanda!.id,
    tipo_evento: "DEMANDA_REGISTRADA",
    descricao: `${demanda!.assunto} — chegou por ${d.canal.toLowerCase()} em ${demanda!.data_chegada}`,
    usuario,
  });
  if (ok) {
    await _registrar_mencoes(tx, usuario, demanda!.id, [
      ["assunto", assunto_limpo],
      ["quem demandou", solicitante],
      ["descrição da demanda", descricao],
    ]);
  }
  await _sincronizar_pendencia(tx, demanda!, usuario);
  return demanda!;
}

/**
 * Passa a demanda para outra pessoa. É o antídoto direto da frase que originou
 * a funcionalidade: férias acontecem. A pendência acompanha.
 */
export async function atribuir(
  tx: Executor,
  usuario: UsuarioAtual,
  demanda: Demanda,
  responsavel_id: number | null,
): Promise<Demanda> {
  usuario.exigir(PERMISSAO_ESCREVER);
  if (demanda.estado === "ENCERRADA") throw new RegraDaDemanda("Demanda encerrada não muda de responsável.");
  const anterior = demanda.responsavel_id;
  if (anterior === responsavel_id) return demanda;
  await _gravar(tx, demanda, { responsavel_id });
  await auditoria.registrar(tx, {
    entidade: "demanda",
    entidade_id: demanda.id,
    tipo_evento: "DEMANDA_RESPONSAVEL_ALTERADO",
    descricao: demanda.assunto,
    campo: "responsavel_id",
    valor_anterior: anterior,
    valor_novo: responsavel_id,
    usuario,
  });
  await _sincronizar_pendencia(tx, demanda, usuario);
  return demanda;
}

/**
 * A transição ABERTA -> EM_ANDAMENTO, com a linha na trilha. Acontece por DOIS
 * caminhos — o botão e o primeiro encaminhamento —, e toda transição deixa
 * rastro.
 */
async function _passar_a_andamento(tx: Executor, demanda: Demanda, usuario: UsuarioAtual, motivo: string): Promise<void> {
  exigir_transicao_demanda(demanda.estado, "EM_ANDAMENTO");
  await _gravar(tx, demanda, { estado: "EM_ANDAMENTO" });
  await auditoria.registrar(tx, {
    entidade: "demanda",
    entidade_id: demanda.id,
    tipo_evento: "DEMANDA_EM_ANDAMENTO",
    descricao: `${demanda.assunto} — ${motivo}`,
    campo: "estado",
    valor_anterior: "ABERTA",
    valor_novo: "EM_ANDAMENTO",
    usuario,
  });
}

/** ABERTA -> EM_ANDAMENTO. É a diferença entre "ninguém pegou" e "estou nisso". */
export async function iniciar(tx: Executor, usuario: UsuarioAtual, demanda: Demanda): Promise<Demanda> {
  usuario.exigir(PERMISSAO_ESCREVER);
  await _passar_a_andamento(tx, demanda, usuario, "alguém assumiu o caso");
  return demanda;
}

// ---------------------------------------------------------------------
// Encaminhamento — append-only (RN-31)
// ---------------------------------------------------------------------
/**
 * Registra o que foi pedido, a quem e quando. Nada se apaga depois.
 *
 * Encaminhar uma demanda ABERTA a põe EM_ANDAMENTO no mesmo ato: pedir alguma
 * coisa a alguém **é** estar cuidando dela.
 */
export async function encaminhar(
  tx: Executor,
  usuario: UsuarioAtual,
  demanda: Demanda,
  d: { para_quem: string; pedido: string; data_encaminhamento?: string | null; confirmo_mencao_saude?: boolean },
): Promise<DemandaEncaminhamento> {
  usuario.exigir(PERMISSAO_ESCREVER);
  if (demanda.estado === "ENCERRADA") {
    throw new RegraDaDemanda(
      "Demanda encerrada não recebe encaminhamento — o desfecho já está " +
        "escrito. Se o assunto voltou, registre uma demanda nova: a data de " +
        "chegada é outra, e esta continua legível ao lado.",
    );
  }
  const ok = d.confirmo_mencao_saude ?? false;
  const destino = _limpar(d.para_quem, "para quem", ok);
  if (destino === null) throw new RegraDaDemanda("Diga para quem a demanda foi encaminhada.");
  const texto = _limpar(d.pedido, "o que foi pedido", ok);
  if (texto === null) {
    throw new RegraDaDemanda(
      "Escreva o que foi pedido. Encaminhamento sem isso é um carimbo de " +
        "data: seis meses depois ninguém sabe o que se esperava de volta.",
    );
  }

  const [encaminhamento] = await tx
    .insert(demanda_encaminhamento)
    .values({
      demanda_id: demanda.id,
      data_encaminhamento: d.data_encaminhamento || hoje_iso(),
      para_quem: destino,
      pedido: texto,
      registrado_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "demanda",
    entidade_id: demanda.id,
    tipo_evento: "DEMANDA_ENCAMINHADA",
    descricao: `${demanda.assunto} — para ${destino}`,
    comentario: texto,
    usuario,
  });
  if (ok) {
    await _registrar_mencoes(tx, usuario, demanda.id, [
      ["para quem", destino],
      ["o que foi pedido", texto],
    ]);
  }
  if (demanda.estado === "ABERTA") {
    await _passar_a_andamento(tx, demanda, usuario, `encaminhada a ${destino}`);
  }
  return encaminhamento!;
}

// ---------------------------------------------------------------------
// Encerramento com desfecho obrigatório — onde está o valor
// ---------------------------------------------------------------------
/**
 * Fecha a demanda dizendo COMO ela terminou. Sem desfecho não encerra.
 *
 * - `RESOLVIDA` — o que foi feito, por escrito, se houver o que dizer (opcional);
 * - `VIROU_PROCESSO` — o processo REAL (`processo_id`). Sem processo no sistema,
 *   a rota o cadastra ali mesmo (NUP + tipo), na mesma transação;
 * - `ENCAMINHADA` — para qual setor e em que data;
 * - `SEM_PROVIDENCIA` — o motivo: "não vamos fazer nada" é decisão legítima, e
 *   o que não pode é ela ser tomada por esquecimento.
 */
export async function encerrar(
  tx: Executor,
  usuario: UsuarioAtual,
  demanda: Demanda,
  d: {
    desfecho: string;
    relato?: string | null;
    processo_id?: number | null;
    setor?: string | null;
    data_desfecho?: string | null;
    confirmo_mencao_saude?: boolean;
  },
): Promise<Demanda> {
  usuario.exigir(PERMISSAO_ESCREVER);
  exigir_transicao_demanda(demanda.estado, "ENCERRADA");
  const desfecho = d.desfecho;
  if (!(DESFECHOS_DEMANDA as readonly string[]).includes(desfecho)) {
    throw new RegraDaDemanda("Escolha um desfecho: é ele que diz como terminou.");
  }

  const ok = d.confirmo_mencao_saude ?? false;
  let texto = _limpar(d.relato, "o desfecho da demanda", ok);
  const destino = _limpar(d.setor, "setor de destino", ok);
  const processo_id = d.processo_id ?? null;
  let data_desfecho = d.data_desfecho ?? null;

  if (desfecho === "VIROU_PROCESSO") {
    const existe =
      processo_id !== null &&
      (await tx.select({ id: tabela_processo.id }).from(tabela_processo).where(eq(tabela_processo.id, processo_id)))
        .length > 0;
    if (!existe) {
      throw new RegraDaDemanda(
        "Este desfecho aponta para um processo que existe no sistema, e " +
          "esse processo não foi encontrado. Cadastre-o em “Novo processo” " +
          "e volte: é o que faz a demanda virar um link para o processo, " +
          "em vez de um número anotado.",
      );
    }
  } else if (desfecho === "ENCAMINHADA") {
    if (destino === null) {
      throw new RegraDaDemanda(
        "Diga para qual setor a demanda foi encaminhada — sem isso o " +
          "encerramento não diz onde o assunto está agora.",
      );
    }
    data_desfecho = data_desfecho || hoje_iso();
  }
  // RESOLVIDA dispensa o relato (o banco guarda a frase-padrão); "sem
  // providência" continua pedindo o motivo — é decisão de não fazer.
  if (desfecho === "RESOLVIDA" && texto === null) texto = RELATO_PADRAO_RESOLVIDA;
  if (desfecho === "SEM_PROVIDENCIA" && texto === null) {
    throw new RegraDaDemanda("Falta o desfecho por escrito — escreva o motivo de não haver providência.");
  }

  await _gravar(tx, demanda, {
    estado: "ENCERRADA",
    desfecho,
    desfecho_relato: texto,
    desfecho_processo_id: desfecho === "VIROU_PROCESSO" ? processo_id : null,
    desfecho_setor: desfecho === "ENCAMINHADA" ? destino : null,
    desfecho_data: desfecho === "ENCAMINHADA" ? data_desfecho : null,
    encerrada_em: agora_utc(),
    encerrada_por: usuario.id,
  });

  await auditoria.registrar(tx, {
    entidade: "demanda",
    entidade_id: demanda.id,
    tipo_evento: "DEMANDA_ENCERRADA",
    descricao: `${demanda.assunto} — ${ROTULO_DESFECHO_DEMANDA[desfecho]}`,
    campo: "desfecho",
    valor_novo: desfecho,
    comentario: texto || destino,
    // o processo que a demanda gerou entra na trilha do PROCESSO também: é lá
    // que alguém, meses depois, pergunta de onde aquilo veio
    processo_id: demanda.desfecho_processo_id,
    usuario,
  });
  if (ok) {
    await _registrar_mencoes(tx, usuario, demanda.id, [
      ["o desfecho da demanda", texto],
      ["setor de destino", destino],
    ]);
  }
  // encerrada não cobra mais nada: a tarefa do prazo sai do sino junto
  await _sincronizar_pendencia(tx, demanda, usuario);
  await avisar_quem_demandou(tx, demanda, usuario);
  return demanda;
}

// ---------------------------------------------------------------------
// O aviso de quem demandou
// ---------------------------------------------------------------------
/**
 * A conta de quem pediu: a conta ativa vinculada ao servidor solicitante.
 * Sem vínculo com o cadastro — chefia de fora, PROGEP, alguém que ligou —
 * não há a quem avisar pelo sistema, e o retorno continua sendo pelo canal
 * por onde a demanda chegou.
 */
export async function conta_de_quem_demandou(tx: Executor, demanda: Demanda): Promise<number | null> {
  if (demanda.solicitante_servidor_id === null) return null;
  const [conta] = await tx
    .select({ id: tabela_usuario.id })
    .from(tabela_usuario)
    .where(and(eq(tabela_usuario.servidor_id, demanda.solicitante_servidor_id), eq(tabela_usuario.ativo, true)))
    .orderBy(asc(tabela_usuario.id))
    .limit(1);
  return conta?.id ?? null;
}

/** "12/03/2026" a partir de "2026-03-12". */
function _data(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/**
 * Põe o desfecho no sino de quem demandou. A pessoa pediu no balcão ou por
 * e-mail e, até aqui, só sabia do resultado se alguém lembrasse de avisá-la.
 *
 * O texto inteiro vai NA descrição, e não num link: quem demandou não tem
 * `demanda.ver` (a fila é do setor, e nomeia outros solicitantes), então a
 * frase é tudo o que ela lê. É o relato que a CSSO escreveu ao encerrar —
 * escrito, a partir de agora, sabendo que chega a quem pediu. Ela lê a frase
 * como titular (`pendencias.titular_de` resolve a demanda pelo solicitante).
 *
 * Uma vez por demanda (chave fixa): encerrada não reabre. Quem encerra a
 * própria demanda não recebe aviso do que acabou de fazer.
 */
export async function avisar_quem_demandou(tx: Executor, demanda: Demanda, usuario: UsuarioAtual): Promise<void> {
  if (demanda.estado !== "ENCERRADA" || demanda.desfecho === null) return;
  const dono = await conta_de_quem_demandou(tx, demanda);
  if (dono === null || dono === usuario.id) return;

  let detalhe = "";
  if (demanda.desfecho === "VIROU_PROCESSO" && demanda.desfecho_processo_id !== null) {
    const [proc] = await tx
      .select({ nup: tabela_processo.nup })
      .from(tabela_processo)
      .where(eq(tabela_processo.id, demanda.desfecho_processo_id));
    detalhe = proc ? ` O assunto segue no processo SEI ${proc.nup}.` : "";
  } else if (demanda.desfecho === "ENCAMINHADA") {
    detalhe =
      ` Foi encaminhada a ${demanda.desfecho_setor}` +
      (demanda.desfecho_data ? ` em ${_data(demanda.desfecho_data)}` : "") +
      ": é lá que o assunto segue agora.";
  } else if (
    demanda.desfecho === "RESOLVIDA" &&
    demanda.desfecho_relato &&
    demanda.desfecho_relato !== RELATO_PADRAO_RESOLVIDA
  ) {
    detalhe = ` O que foi feito: ${demanda.desfecho_relato}`;
  } else if (demanda.desfecho === "SEM_PROVIDENCIA" && demanda.desfecho_relato) {
    detalhe = ` Motivo: ${demanda.desfecho_relato}`;
  }
  const descricao =
    `Sua demanda “${demanda.assunto}”, recebida em ${_data(demanda.data_chegada)}, foi encerrada: ` +
    `${(ROTULO_DESFECHO_DEMANDA[demanda.desfecho] ?? demanda.desfecho).toLowerCase()}.${detalhe}` +
    " Dúvidas ou discordância: fale com a CSSO. Marque como concluído depois de ler.";

  await pendencias.abrir(tx, {
    tipo: TIPO_AVISO_DESFECHO,
    chave: chave_aviso_desfecho(demanda.id),
    descricao,
    entidade: "demanda",
    entidade_id: demanda.id,
    responsavel_id: dono,
    usuario,
  });
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
/**
 * A fila do setor, sem filtro de escopo — e isso é decisão, não esquecimento.
 * Demanda não tem campus nem `servidor_id` de dono; o corte é o de PERMISSÃO,
 * na rota.
 *
 * A ordenação é a da urgência: por prazo, as sem prazo por último, e a mais
 * nova primeiro no empate — a mesma de `pendencias.abertas`.
 */
export async function listar(
  tx: Executor,
  filtros: { estado?: string; responsavel_id?: number | null; busca?: string } = {},
): Promise<Demanda[]> {
  const condicoes: (SQL | undefined)[] = [];
  if (filtros.estado) condicoes.push(eq(tabela_demanda.estado, filtros.estado));
  if (filtros.responsavel_id !== null && filtros.responsavel_id !== undefined) {
    condicoes.push(eq(tabela_demanda.responsavel_id, filtros.responsavel_id));
  }
  let itens = await tx
    .select()
    .from(tabela_demanda)
    .where(and(...condicoes))
    .orderBy(asc(tabela_demanda.id));

  const alvo = textos.chave_busca(filtros.busca ?? "");
  if (alvo) {
    // A busca NÃO casa `solicitante_nome` (RN-19): um filtro que respondesse
    // "sim, é este" amarraria o nome ao código opaco da sessão. O casamento é
    // por ASSUNTO, que é texto do trabalho e não da pessoa.
    itens = itens.filter((d) => textos.chave_busca(d.assunto).includes(alvo));
  }

  return itens.sort((a, b) => {
    if ((a.prazo === null) !== (b.prazo === null)) return a.prazo === null ? 1 : -1;
    if (a.prazo !== null && b.prazo !== null && a.prazo !== b.prazo) return a.prazo < b.prazo ? -1 : 1;
    return b.id - a.id;
  });
}

/**
 * O número que vai em cada ficha de filtro da tela. Sai da lista COMPLETA e não
 * da filtrada.
 */
export async function contar_por_estado(tx: Executor): Promise<Record<string, number>> {
  const contagem: Record<string, number> = {};
  for (const d of await tx.select({ estado: tabela_demanda.estado }).from(tabela_demanda)) {
    contagem[d.estado] = (contagem[d.estado] ?? 0) + 1;
  }
  return contagem;
}
