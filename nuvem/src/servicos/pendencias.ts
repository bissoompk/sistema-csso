/**
 * Pendências com dono e prazo. Alimentam a RN-06 e o sino do topo.
 * Porte de `app/servicos/pendencias.py`.
 *
 * Carregar este módulo liga os ganchos `sino` e `podeVerPendencias` da casca
 * (`web.ts`): o sino decora TODA tela, e quem decide se ele aparece e quanto ele
 * conta é esta regra — não uma segunda cópia dela na casca.
 */
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_ocorrencia,
  agora_utc,
  certificado,
  demanda,
  epi_comunicacao_titular,
  epi_ficha_registro,
  epi_requisicao,
  epi_requisicao_item,
  laudo_tecnico,
  parecer_tecnico,
  pendencia as tabela_pendencia,
  processo,
  turma,
} from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { Pendencia as PendenciaDominio } from "../dominio/auditoria.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { ganchos } from "../web.js";
import * as auditoria from "./auditoria.js";
import { NOMINAIS_FORA_DO_EPI, pode_ver_nominal } from "./identificacao.js";
import { ESCOPO_TOTAL, ESCOPO_UNIDADE, PermissaoNegada, type UsuarioAtual } from "./rbac.js";

export type Pendencia = typeof tabela_pendencia.$inferSelect;

// tipo -> [rótulo, prazo padrão em dias]
//
// Os comentários de cada tipo (por que existe, por que aquele prazo, e os dois
// que ainda NÃO nascem — CONFERIR_LAUDO e REGISTRO_DE_OPCAO) estão em
// `app/servicos/pendencias.py`, e valem aqui sem mudança: a lista é a mesma.
export const TIPOS: Record<string, readonly [string, number]> = {
  AVALIACAO_QUANTITATIVA: ["Avaliação quantitativa de agente químico", 180],
  REAVALIACAO_LAUDO: ["Reavaliação por laudo superado", 90],
  INCLUIR_NO_SEI: ["Incluir o parecer assinado no SEI", 10],
  // declarado, mas ainda não nasce: falta decidir o MARCO de quem nunca foi conferido
  CONFERIR_LAUDO: ["Conferir laudo sem conferência há mais de 24 meses", 60],
  // declarado, mas ainda não nasce: falta a PORTA (`registro_opcao_anexo_id`)
  REGISTRO_DE_OPCAO: ["Anexar o registro de opção do servidor", 30],
  CONFLITO_NUMERACAO: ["Resolver conflito de numeração da migração", 30],
  COMPROVANTE_EPI_PENDENTE: ["Anexar o comprovante assinado de EPI", 10],
  // RN-25: o prazo real é a própria validade do CA; 60 é só o padrão
  CA_A_VENCER: ["Certificado de Aprovação do lote a vencer", 60],
  // §7.2 do desenho de EPI: o módulo de EPI NUNCA escreve em `adicional_vigencia`
  REAVALIAR_ADICIONAL_POR_EPI: ["Reavaliar o adicional após entrega de EPI", 90],
  // RN-32: o prazo real é a própria `previsao_troca`
  TROCA_EPI_DEVIDA: ["Troca de EPI vencida (vida útil esgotada)", 30],
  EPI_SEM_ESTOQUE: ["Item de requisição de EPI esperando estoque", 30],
  // os dois avisos do REQUERENTE (fatia do servidor comum)
  EPI_DECISAO_A_LER: ["Ler a decisão do seu pedido de EPI", 15],
  EPI_RETIRADA_DISPONIVEL: ["Retirar o EPI reservado para você", 15],
  // 0015 (paridade com o IntegraSST): o titular comunicou extravio ou pediu
  // troca do EPI que está com ele; nasce sem responsável (é do almoxarifado)
  EPI_COMUNICACAO_A_TRATAR: ["Tratar a comunicação do titular sobre o EPI", 10],
  // a demanda com prazo: sem prazo não abre pendência nenhuma
  DEMANDA_COM_PRAZO: ["Demanda com prazo a cumprir", 15],
  // o aviso de QUEM DEMANDOU, quando a equipe encerra (só se ele tem conta)
  DEMANDA_DESFECHO_A_LER: ["Ler o desfecho da sua demanda", 15],
  // nasce SEM responsável: é do setor
  TURMA_INSCRICAO_A_CONFIRMAR: ["Confirmar inscrição pedida pelo próprio participante", 10],
  // o prazo real é o próprio vencimento; nasce sem responsável (é do setor)
  CERTIFICADO_A_VENCER: ["Programar a reciclagem de certificado a vencer", 30],
  // D17: a última concessão de `perfil.conceder` vence pela data e ninguém
  // ficaria para conceder perfil; o prazo real é o último dia coberto
  // (`governanca.sincronizar_aviso_de_cobertura`)
  COBERTURA_DE_CONCESSAO_A_VENCER: ["Garantir quem conceda perfil depois do vencimento", 30],
  // --- Acidentes (CAT/SP, 23/10/2026). A âncora é `acidente_ocorrencia`; a
  // descrição de cada uma leva só o protocolo, nunca o nome nem o que aconteceu.
  // Prazos da decisão D13: triagem 2, complementação 5, investigação 30, perícia 60.
  // nasce SEM responsável (é da fila da CSSO) e depois fica com quem assumiu
  ACIDENTE_TRIAR: ["Triar a comunicação de acidente", 2],
  // o prazo real é a data do acidente + 10 dias (art. 214 da Lei 8.112); a
  // prorrogação registrada o move. Varrida pela rotina noturna
  ACIDENTE_PRAZO_COMUNICACAO: ["Encaminhar a comunicação de acidente dentro do prazo legal", 10],
  // o responsável é o comunicante logado; o vencimento avisa a equipe
  ACIDENTE_COMPLEMENTACAO: ["Complementar a comunicação de acidente", 5],
  // nasce SEM responsável (fila do médico do trabalho)
  ACIDENTE_SAUDE_REGISTRAR: ["Confirmar e registrar a saúde declarada na comunicação de acidente", 5],
  ACIDENTE_INVESTIGAR: ["Investigar o acidente e emitir o relatório", 30],
  // o prazo real é o da própria ação do plano
  ACIDENTE_ACAO_PRAZO: ["Cumprir a ação do plano de um acidente", 30],
  ACIDENTE_AGUARDA_PERICIA: ["Acompanhar a decisão da perícia do SIASS", 60],
  // o Cadastre-se do terceirizado e do discente (`pedido_conta.ts`): nasce sem
  // responsável e se fecha sozinha quando o pedido é aprovado ou recusado
  CONTA_A_CONFERIR: ["Conferir pedido de conta de terceirizado ou discente", 5],
};

// ---------------------------------------------------------------------
// Quem entra em /pendencias
// ---------------------------------------------------------------------
// Uma lista explícita de permissões de LEITURA de módulo — aceitar "qualquer
// permissão" deixaria entrar o admin_ti, que tem `auditoria.ver` e
// `backup.executar` (e tinha `indicador.ver` até 22/10/2026) e, por decisão de
// projeto, não vê conteúdo técnico. Módulo novo acrescenta a sua aqui.
// (A história completa de cada entrada está no Python.)
export const PERMISSOES_VER: readonly string[] = ["processo.ver", "treinamento.ver", "epi.ver", "demanda.ver", "acidente.ver"];

// Fechar pendência dos outros é ato de quem opera o MÓDULO DELA: a permissão
// é a de escrita do módulo onde a tarefa se cumpre, tipo a tipo. Era uma lista
// única ("processo.editar, treinamento.gerenciar, epi.entregar") valendo para
// todo tipo — e o almoxarife, que só escreve em EPI e demanda, fechava a tarefa
// de parecer de outra pessoa; a secretaria via "concluir" em troca de EPI que
// ela nem consegue ler. Fechar a PRÓPRIA pendência não depende deste mapa: ver
// `pode_concluir`. Tipo novo entra aqui junto com a sua linha em `TIPOS` (um
// teste confere); tipo fora do mapa só o responsável fecha — o lado seguro.
export const PERMISSAO_CONCLUIR_POR_TIPO: Readonly<Record<string, string>> = Object.freeze({
  AVALIACAO_QUANTITATIVA: "processo.editar",
  REAVALIACAO_LAUDO: "processo.editar",
  INCLUIR_NO_SEI: "processo.editar",
  // a conferência do laudo é rota de `laudo.criar`: quem não pode registrá-la
  // não pode dar a tarefa por feita
  CONFERIR_LAUDO: "laudo.criar",
  REGISTRO_DE_OPCAO: "processo.editar",
  CONFLITO_NUMERACAO: "processo.editar",
  COMPROVANTE_EPI_PENDENTE: "epi.entregar",
  CA_A_VENCER: "epi.entregar",
  // a entrega de EPI só ABRE a tarefa; reavaliar o adicional é ato de parecer
  // (§7.2 do desenho de EPI), e por isso é do módulo de processos
  REAVALIAR_ADICIONAL_POR_EPI: "processo.editar",
  TROCA_EPI_DEVIDA: "epi.entregar",
  EPI_SEM_ESTOQUE: "epi.entregar",
  EPI_DECISAO_A_LER: "epi.entregar",
  EPI_RETIRADA_DISPONIVEL: "epi.entregar",
  EPI_COMUNICACAO_A_TRATAR: "epi.entregar",
  DEMANDA_COM_PRAZO: "demanda.registrar",
  DEMANDA_DESFECHO_A_LER: "demanda.registrar",
  // confirmar a inscrição é `turma.inscrever` (é o botão da aba de inscrições);
  // `treinamento.gerenciar` é o catálogo, e deixaria de fora a secretaria, que é
  // quem confirma
  TURMA_INSCRICAO_A_CONFIRMAR: "turma.inscrever",
  CERTIFICADO_A_VENCER: "treinamento.gerenciar",
  COBERTURA_DE_CONCESSAO_A_VENCER: "perfil.conceder",
  // acidentes: quem fecha a tarefa dos outros é quem escreve naquela etapa
  ACIDENTE_TRIAR: "acidente.triar",
  ACIDENTE_PRAZO_COMUNICACAO: "acidente.siass",
  ACIDENTE_COMPLEMENTACAO: "acidente.triar",
  ACIDENTE_SAUDE_REGISTRAR: "acidente.saude_registrar",
  ACIDENTE_INVESTIGAR: "acidente.investigar",
  ACIDENTE_ACAO_PRAZO: "acidente.investigar",
  ACIDENTE_AGUARDA_PERICIA: "acidente.siass",
  CONTA_A_CONFERIR: "usuario.criar_conta",
});

export function pode_ver(usuario: UsuarioAtual | null | undefined): boolean {
  return !!usuario && PERMISSOES_VER.some((c) => usuario.pode(c));
}

export function exigir_ver(usuario: UsuarioAtual): void {
  if (!pode_ver(usuario)) {
    throw new PermissaoNegada(
      PERMISSOES_VER[0]!,
      "As pendências são de quem opera algum módulo. É preciso ao menos " +
        "uma destas permissões: " +
        PERMISSOES_VER.join(", ") +
        ".",
    );
  }
}

/**
 * Fecha quem escreve no módulo da tarefa — e sempre o dono dela.
 *
 * O responsável fecha a própria pendência mesmo sem permissão de escrita: foi a
 * ele que a regra atribuiu o trabalho, e tarefa que o dono não consegue riscar
 * da lista vira lista que ninguém lê. O escopo de leitura não mora aqui: quem
 * chama já recortou por `no_escopo` (a lista) ou procura a pendência com ele (a
 * rota de concluir).
 */
export function pode_concluir(
  usuario: UsuarioAtual | null | undefined,
  pendencia: Pick<Pendencia, "responsavel_id" | "tipo">,
): boolean {
  if (!pode_ver(usuario)) return false;
  if (pendencia.responsavel_id !== null && pendencia.responsavel_id === usuario!.id) return true;
  const permissao = Object.hasOwn(PERMISSAO_CONCLUIR_POR_TIPO, pendencia.tipo)
    ? PERMISSAO_CONCLUIR_POR_TIPO[pendencia.tipo]
    : undefined;
  return permissao !== undefined && usuario!.pode(permissao);
}

export function exigir_concluir(usuario: UsuarioAtual, pendencia: Pick<Pendencia, "responsavel_id" | "tipo">): void {
  exigir_ver(usuario); // a mensagem certa para quem nem vê a tela
  if (!pode_concluir(usuario, pendencia)) {
    const permissao = Object.hasOwn(PERMISSAO_CONCLUIR_POR_TIPO, pendencia.tipo)
      ? PERMISSAO_CONCLUIR_POR_TIPO[pendencia.tipo]!
      : null;
    // sem permissão de módulo declarada não há o que pedir: a tela de 403 não
    // pode mandar a pessoa buscar uma permissão que não existe
    if (permissao === null) throw new ErroHttp(403, "Esta pendência só pode ser concluída pelo responsável por ela.");
    throw new PermissaoNegada(
      permissao,
      "Concluir pendência de outra pessoa exige permissão de escrita no módulo desta tarefa.",
    );
  }
}

/** Vermelho na tela (o `Pendencia.atrasada()` do modelo). */
export function atrasada(pendencia: Pick<Pendencia, "concluida" | "prazo">, hoje: string = hoje_iso()): boolean {
  return PendenciaDominio.atrasada(pendencia, hoje);
}

export interface DadosAbertura {
  tipo: string;
  chave: string;
  descricao: string;
  usuario?: UsuarioAtual | null;
  processo_id?: number | null;
  parecer_id?: number | null;
  laudo_id?: number | null;
  entidade?: string | null;
  entidade_id?: number | null;
  responsavel_id?: number | null;
  /** 'AAAA-MM-DD' */
  prazo?: string | null;
}

/**
 * Idempotente por `chave`: a mesma regra não abre duas pendências iguais.
 *
 * `entidade`/`entidade_id` são a âncora dos módulos que não têm processo,
 * parecer nem laudo. O par vai junto ou não vai: meia âncora não leva a lugar
 * nenhum, e a CHECK do banco recusa.
 */
export async function abrir(tx: Executor, d: DadosAbertura): Promise<Pendencia> {
  const entidade = d.entidade ?? null;
  const entidade_id = d.entidade_id ?? null;
  if ((entidade === null) !== (entidade_id === null)) {
    throw new RegraViolada("entidade e entidade_id andam juntos: informe os dois ou nenhum");
  }

  const [existente] = await tx.select().from(tabela_pendencia).where(eq(tabela_pendencia.chave, d.chave));
  if (existente) return existente;

  const dias = TIPOS[d.tipo]?.[1] ?? 30;
  const [pendencia] = await tx
    .insert(tabela_pendencia)
    .values({
      tipo: d.tipo,
      chave: d.chave,
      descricao: d.descricao,
      processo_id: d.processo_id ?? null,
      parecer_id: d.parecer_id ?? null,
      laudo_id: d.laudo_id ?? null,
      entidade,
      entidade_id,
      responsavel_id: d.responsavel_id || (d.usuario ? d.usuario.id : null),
      prazo: d.prazo || somar_dias(hoje_iso(), dias),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "pendencia",
    entidade_id: pendencia!.id,
    processo_id: d.processo_id ?? null,
    tipo_evento: "PENDENCIA_ABERTA",
    descricao: `${TIPOS[d.tipo]?.[0] ?? d.tipo}: ${d.descricao}`,
    usuario: d.usuario ?? null,
  });
  return pendencia!;
}

/**
 * A tarefa voltou a ter objeto — a mesma tarefa, e não uma segunda.
 *
 * Existe porque a idempotência de `abrir` é por CHAVE, e não por chave-em-
 * aberto: chamada de novo, ela devolve a pendência CONCLUÍDA sem reabrir nada.
 * Reabrir, e não abrir outra com chave nova: o histórico da tarefa é um só. A
 * ida e a volta ficam na trilha, que é onde elas se leem.
 */
export async function reabrir(tx: Executor, pendencia: Pendencia, usuario: UsuarioAtual, motivo: string): Promise<Pendencia> {
  if (!pendencia.concluida) return pendencia;
  const mudanca = { concluida: false, concluida_em: null, concluida_por: null };
  await tx.update(tabela_pendencia).set(mudanca).where(eq(tabela_pendencia.id, pendencia.id));
  Object.assign(pendencia, mudanca);
  await auditoria.registrar(tx, {
    entidade: "pendencia",
    entidade_id: pendencia.id,
    processo_id: pendencia.processo_id,
    tipo_evento: "PENDENCIA_REABERTA",
    descricao: `${pendencia.descricao} — ${motivo}`,
    comentario: motivo,
    usuario,
  });
  return pendencia;
}

/**
 * A tarefa que perdeu o objeto, fechada por quem não é ninguém.
 *
 * A rotina não é uma pessoa, e pôr o nome de alguém como "quem fechou" seria
 * mentir na trilha: `concluida_por` fica nulo e a linha da auditoria sai com
 * `usuario_nome` dizendo que foi a rotina, e por quê.
 */
export async function concluir_pela_rotina(tx: Executor, pendencia: Pendencia, motivo: string): Promise<Pendencia> {
  if (pendencia.concluida) return pendencia;
  const mudanca = { concluida: true, concluida_em: agora_utc(), concluida_por: null };
  await tx.update(tabela_pendencia).set(mudanca).where(eq(tabela_pendencia.id, pendencia.id));
  Object.assign(pendencia, mudanca);
  await auditoria.registrar(tx, {
    entidade: "pendencia",
    entidade_id: pendencia.id,
    processo_id: pendencia.processo_id,
    tipo_evento: "PENDENCIA_CONCLUIDA",
    descricao: `${pendencia.descricao} — fechada pela rotina de varredura: ${motivo}`,
    usuario: null,
    usuario_nome: "rotina de varredura",
  });
  return pendencia;
}

export async function concluir(tx: Executor, pendencia: Pendencia, usuario: UsuarioAtual): Promise<Pendencia> {
  if (pendencia.concluida) return pendencia;
  const mudanca = { concluida: true, concluida_em: agora_utc(), concluida_por: usuario.id };
  await tx.update(tabela_pendencia).set(mudanca).where(eq(tabela_pendencia.id, pendencia.id));
  Object.assign(pendencia, mudanca);
  await auditoria.registrar(tx, {
    entidade: "pendencia",
    entidade_id: pendencia.id,
    processo_id: pendencia.processo_id,
    tipo_evento: "PENDENCIA_CONCLUIDA",
    descricao: pendencia.descricao,
    usuario,
  });
  return pendencia;
}

/**
 * A fila do setor, recortada pelo escopo de quem abre a tela.
 *
 * `Pendencia` **não** tem `servidor_id`, e por isso não passa por
 * `aplicar_escopo`. A âncora de dono que a pendência tem é `responsavel_id`:
 * no escopo próprio, a pessoa vê só o que a regra atribuiu a ela. Isso importa
 * porque a `descricao` é texto livre e nomeia terceiros.
 *
 * Adaptação do Drizzle (ver `rbac.aplicar_escopo`): devolve a CONDIÇÃO
 * (`undefined` = sem recorte), e quem consulta faz `where(and(...))`.
 */
export function no_escopo(usuario: UsuarioAtual | null | undefined): SQL | undefined {
  if (!usuario || ve_a_fila_do_setor(usuario)) return undefined;
  return eq(tabela_pendencia.responsavel_id, usuario.id);
}

/**
 * A fila inteira é de quem lê algum módulo ALÉM do próprio dado: uma das
 * `PERMISSOES_VER` com escopo de unidade ou total. Era o escopo da CONTA
 * (`usuario.escopo`), e com as funções do titular (D16) toda conta ligada a
 * servidor passou a ter `processo.ver` e `epi.ver` — o `admin_ti` ligado a
 * servidor, cuja conta é de escopo A, abria /pendencias e lia a fila inteira do
 * setor, com texto livre que nomeia terceiros. Agora a pergunta é por
 * permissão: quem só alcança o próprio (o titular) ou só o agregado (o
 * `admin_ti`) vê o que a regra atribuiu a ele, e nada mais.
 */
export function ve_a_fila_do_setor(usuario: UsuarioAtual): boolean {
  return PERMISSOES_VER.some((p) => {
    const nivel = usuario.escopo_de(p);
    return nivel === ESCOPO_TOTAL || nivel === ESCOPO_UNIDADE;
  });
}

// As âncoras de EPI, onde `epi.ficha` é nominal na própria definição; fora
// delas a família nominal é a das telas que não são de EPI (D15).
const _ENTIDADES_DE_EPI: readonly string[] = [
  "epi_requisicao",
  "epi_requisicao_item",
  "epi_ficha_registro",
  "epi_comunicacao_titular",
];

// A âncora que sabe dizer DE QUEM é a tarefa. Entidade nova entra aqui quando
// tiver como responder a pergunta — chave ausente cai no lado seguro (`null`).
const _TITULAR_POR_ENTIDADE: readonly string[] = [
  "epi_requisicao",
  "epi_requisicao_item",
  "epi_ficha_registro",
  "epi_comunicacao_titular",
  "demanda",
  "acidente_ocorrencia",
];

/**
 * `{pendencia.id: servidor_id}` — a outra metade do M-1, do lado da leitura.
 *
 * O titular deixa de ser tratado como terceiro sobre o próprio dado (LGPD art.
 * 18, II): a lista passa a saber de quem é a frase pela ÂNCORA, que já está na
 * linha. Não alarga nada — `pode_ver_nominal` continua decidindo. Uma consulta
 * por entidade, e não uma por linha.
 */
export async function titular_de(tx: Executor, itens: Pendencia[]): Promise<Map<number, number | null>> {
  const por_entidade = new Map<string, Set<number>>();
  for (const p of itens) {
    if (p.entidade && _TITULAR_POR_ENTIDADE.includes(p.entidade) && p.entidade_id) {
      if (!por_entidade.has(p.entidade)) por_entidade.set(p.entidade, new Set());
      por_entidade.get(p.entidade)!.add(p.entidade_id);
    }
  }
  const dono = new Map<string, number | null>();
  for (const [entidade, conjunto] of por_entidade) {
    const ids = [...conjunto];
    let linhas: { id: number; servidor_id: number | null }[];
    if (entidade === "epi_requisicao_item") {
      // o item não tem `servidor_id`: quem o tem é o envelope dele
      linhas = await tx
        .select({ id: epi_requisicao_item.id, servidor_id: epi_requisicao.servidor_id })
        .from(epi_requisicao_item)
        .innerJoin(epi_requisicao, eq(epi_requisicao_item.requisicao_id, epi_requisicao.id))
        .where(inArray(epi_requisicao_item.id, ids));
    } else if (entidade === "demanda") {
      // o titular da demanda é quem a pediu — quando o pedido veio de alguém do cadastro
      linhas = await tx
        .select({ id: demanda.id, servidor_id: demanda.solicitante_servidor_id })
        .from(demanda)
        .where(inArray(demanda.id, ids));
    } else if (entidade === "epi_comunicacao_titular") {
      linhas = await tx
        .select({ id: epi_comunicacao_titular.id, servidor_id: epi_comunicacao_titular.servidor_id })
        .from(epi_comunicacao_titular)
        .where(inArray(epi_comunicacao_titular.id, ids));
    } else if (entidade === "acidente_ocorrencia") {
      // o titular da ocorrência é o acidentado principal (quando é servidor)
      linhas = await tx
        .select({ id: acidente_ocorrencia.id, servidor_id: acidente_ocorrencia.servidor_id })
        .from(acidente_ocorrencia)
        .where(inArray(acidente_ocorrencia.id, ids));
    } else if (entidade === "epi_requisicao") {
      linhas = await tx
        .select({ id: epi_requisicao.id, servidor_id: epi_requisicao.servidor_id })
        .from(epi_requisicao)
        .where(inArray(epi_requisicao.id, ids));
    } else {
      linhas = await tx
        .select({ id: epi_ficha_registro.id, servidor_id: epi_ficha_registro.servidor_id })
        .from(epi_ficha_registro)
        .where(inArray(epi_ficha_registro.id, ids));
    }
    for (const l of linhas) dono.set(`${entidade}:${l.id}`, l.servidor_id);
  }
  const resultado = new Map<number, number | null>();
  for (const p of itens) resultado.set(p.id, dono.get(`${p.entidade ?? ""}:${p.entidade_id ?? 0}`) ?? null);
  return resultado;
}

// ---------------------------------------------------------------------
// Como a linha se lê na tela (e na API)
// ---------------------------------------------------------------------
/** Um lugar aonde a tarefa leva: o rótulo legível e o link, quando a rota deixa entrar. */
export interface Ancora {
  rotulo: string;
  href: string | null;
}

/** A frase da tarefa já decidida pela RN-19, e os lugares dela. */
export interface Leitura {
  texto: string;
  onde: Ancora[];
}

// A âncora dos módulos sem processo: (nome do lugar, prefixo, sufixo, permissão
// que a rota exige). A permissão entra no mapa porque o link só pode existir
// para quem a rota deixa entrar — oferecer porta trancada é a mesma mentira do
// menu. Era um mapa no template e uma cópia dele na API; os dois passaram a
// ler este. Entidade sem tela (o item do pedido) tem rótulo e não tem link.
const _LUGAR_DA_ENTIDADE: Readonly<Record<string, readonly [string, string, string, string | null]>> = {
  epi_ficha_registro: ["Ficha de EPI — entrega nº", "/epis/fichas/registros/", "", "epi.ficha"],
  epi_entrada_estoque: ["Estoque de EPI — lote nº", "/epis/estoque/", "/movimentos", "epi.ver"],
  epi_requisicao: ["Pedido de EPI nº", "/epis/requisicoes/", "", "epi.ver"],
  epi_requisicao_item: ["Item do pedido de EPI nº", "", "", null],
  // a comunicação do titular (fatia A) não tem tela própria: a rota leva à
  // ficha, onde ela aparece na linha da entrega
  epi_comunicacao_titular: ["Comunicação do titular sobre EPI nº", "/epis/comunicacoes/", "", "epi.ficha"],
  demanda: ["Demanda nº", "/demandas/", "", "demanda.ver"],
  // a tarefa é sobre uma INSCRIÇÃO e a âncora é a TURMA: a inscrição não tem
  // tela própria, e o botão de confirmar mora na aba de inscrições
  turma: ["Inscrições da turma", "/turmas/", "?aba=inscricoes", "turma.inscrever"],
  certificado: ["Certificado", "/certificados/", "", "certificado.ver"],
  // o número que se mostra é o protocolo (`CAT-2026-0001`); o texto não leva nome
  acidente_ocorrencia: ["Ocorrência de acidente", "/acidentes/", "", "acidente.ver"],
  // a fila é uma tela só; o número leva à linha do pedido
  pedido_conta: ["Pedido de conta nº", "/usuarios/pedidos#pedido-", "", "usuario.criar_conta"],
};

async function _mapa<T extends { id: number }>(
  ids: Set<number>,
  ler: (lista: number[]) => Promise<T[]>,
): Promise<Map<number, T>> {
  if (!ids.size) return new Map();
  return new Map((await ler([...ids])).map((l) => [l.id, l]));
}

/**
 * `{pendencia.id: {texto, onde}}` — o que cada linha mostra a ESTE usuário.
 *
 * O texto: quem lê o nome (`pode_ver_nominal`, com o titular resolvido por
 * `titular_de`) lê a descrição gravada. Quem não lê recebia "conteúdo suprimido
 * (RN-19)" em toda linha, e a lista da secretaria era uma coluna de frases
 * iguais — inclusive a da demanda que ela mesma registrou. Agora recebe uma
 * frase NEUTRA montada do tipo e da âncora, que não passa pela descrição e por
 * isso não carrega nome nenhum: "Demanda: <assunto>" (o assunto é o que
 * /demandas já mostra a quem tem `demanda.ver`), "Anexar o comprovante
 * assinado de EPI — entrega nº 7". A descrição gravada não muda (ela entra no
 * digest da trilha).
 *
 * O "onde": rótulo legível no lugar do nome da tabela, e o número de quem tem
 * a permissão de ler (o NUP só para `processo.ver`, o laudo só para `laudo.ver`).
 * Uma consulta por tipo de âncora, e não uma por linha.
 */
export async function leitura(tx: Executor, usuario: UsuarioAtual, itens: Pendencia[]): Promise<Map<number, Leitura>> {
  const de_quem = await titular_de(tx, itens);
  const ids = (f: (p: Pendencia) => number | null, entidade?: string) =>
    new Set(
      itens
        .filter((p) => entidade === undefined || p.entidade === entidade)
        .map(f)
        .filter((x): x is number => x !== null && x !== undefined),
    );
  const processos = await _mapa(ids((p) => p.processo_id), (l) =>
    tx.select({ id: processo.id, nup: processo.nup }).from(processo).where(inArray(processo.id, l)),
  );
  const pareceres = await _mapa(ids((p) => p.parecer_id), (l) =>
    tx
      .select({ id: parecer_tecnico.id, numero: parecer_tecnico.numero, ano: parecer_tecnico.ano })
      .from(parecer_tecnico)
      .where(inArray(parecer_tecnico.id, l)),
  );
  const laudos = await _mapa(ids((p) => p.laudo_id), (l) =>
    tx
      .select({ id: laudo_tecnico.id, numero: laudo_tecnico.numero_siape })
      .from(laudo_tecnico)
      .where(inArray(laudo_tecnico.id, l)),
  );
  const demandas = await _mapa(ids((p) => p.entidade_id, "demanda"), (l) =>
    tx.select({ id: demanda.id, assunto: demanda.assunto }).from(demanda).where(inArray(demanda.id, l)),
  );
  const turmas = await _mapa(ids((p) => p.entidade_id, "turma"), (l) =>
    tx.select({ id: turma.id, codigo: turma.codigo }).from(turma).where(inArray(turma.id, l)),
  );
  const certificados = await _mapa(ids((p) => p.entidade_id, "certificado"), (l) =>
    tx
      .select({ id: certificado.id, numero: certificado.numero, ano: certificado.ano, numero_impresso: certificado.numero_impresso })
      .from(certificado)
      .where(inArray(certificado.id, l)),
  );

  const ocorrencias = await _mapa(ids((p) => p.entidade_id, "acidente_ocorrencia"), (l) =>
    tx
      .select({ id: acidente_ocorrencia.id, protocolo: acidente_ocorrencia.protocolo })
      .from(acidente_ocorrencia)
      .where(inArray(acidente_ocorrencia.id, l)),
  );

  const resultado = new Map<number, Leitura>();
  for (const p of itens) {
    const onde: Ancora[] = [];
    if (p.processo_id) {
      const ve = usuario.pode("processo.ver");
      const nup = processos.get(p.processo_id)?.nup;
      onde.push({
        rotulo: ve && nup ? `Processo ${nup}` : "Processo SEI",
        href: ve ? `/processos/${p.processo_id}` : null,
      });
    }
    if (p.parecer_id) {
      const ve = usuario.pode("parecer.ver");
      const pa = pareceres.get(p.parecer_id);
      onde.push({
        rotulo: ve && pa ? (pa.numero ? `Parecer ${pa.numero}/${pa.ano}` : `Parecer em rascunho (${pa.ano})`) : "Parecer técnico",
        href: ve ? `/pareceres/${p.parecer_id}` : null,
      });
    }
    if (p.laudo_id) {
      const ve = usuario.pode("laudo.ver");
      const la = laudos.get(p.laudo_id);
      onde.push({ rotulo: ve && la ? `Laudo ${la.numero}` : "Laudo técnico", href: ve ? `/laudos/${p.laudo_id}` : null });
    }
    if (p.entidade && p.entidade_id) {
      const lugar = Object.hasOwn(_LUGAR_DA_ENTIDADE, p.entidade) ? _LUGAR_DA_ENTIDADE[p.entidade] : undefined;
      if (lugar) {
        let numero = String(p.entidade_id);
        if (p.entidade === "turma") numero = turmas.get(p.entidade_id)?.codigo ?? numero;
        if (p.entidade === "acidente_ocorrencia") numero = ocorrencias.get(p.entidade_id)?.protocolo ?? numero;
        if (p.entidade === "certificado") {
          const ce = certificados.get(p.entidade_id);
          if (ce) numero = `nº ${ce.numero_impresso || `${ce.numero}/${ce.ano}`}`;
        }
        const pode = lugar[3] !== null && usuario.pode(lugar[3]);
        onde.push({ rotulo: `${lugar[0]} ${numero}`, href: pode ? `${lugar[1]}${p.entidade_id}${lugar[2]}` : null });
      } else {
        // entidade que ainda não declarou o seu lugar: diz que há registro, sem
        // o nome da tabela, que não significa nada para quem lê
        onde.push({ rotulo: `Registro nº ${p.entidade_id}`, href: null });
      }
    }

    let texto: string;
    if (!p.descricao) texto = "—";
    else if (
      // `epi.ficha` lê o nome só na tarefa de EPI: a descrição da demanda diz
      // "— demanda de <nome>", e o almoxarife a lia inteira enquanto a
      // secretaria, na mesma fila, recebia a frase neutra (D15)
      pode_ver_nominal(
        usuario,
        de_quem.get(p.id) ?? null,
        null,
        p.entidade && _ENTIDADES_DE_EPI.includes(p.entidade) ? undefined : NOMINAIS_FORA_DO_EPI,
      )
    )
      texto = p.descricao;
    else if (p.entidade === "demanda" && p.entidade_id && usuario.pode("demanda.ver") && demandas.has(p.entidade_id)) {
      texto = `Demanda: ${demandas.get(p.entidade_id)!.assunto}`;
    } else {
      const rotulo = Object.hasOwn(TIPOS, p.tipo) ? TIPOS[p.tipo]![0] : "Tarefa";
      // o rótulo do lugar em minúscula, como continuação da frase do tipo
      const complemento = onde.length ? onde[onde.length - 1]!.rotulo : "";
      texto = complemento ? `${rotulo} — ${complemento.charAt(0).toLowerCase()}${complemento.slice(1)}` : rotulo;
    }
    resultado.set(p.id, { texto, onde });
  }
  return resultado;
}

export async function abertas(
  tx: Executor,
  usuario: UsuarioAtual | null = null,
  apenas_minhas = false,
): Promise<Pendencia[]> {
  const condicoes: (SQL | undefined)[] = [eq(tabela_pendencia.concluida, false), no_escopo(usuario)];
  if (apenas_minhas && usuario) condicoes.push(eq(tabela_pendencia.responsavel_id, usuario.id));
  const itens = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(...condicoes))
    .orderBy(asc(tabela_pendencia.id));
  // sem prazo vai para o fim; atrasadas primeiro (ordenação estável, como o `sorted` do Python)
  return itens.sort((a, b) => {
    if ((a.prazo === null) !== (b.prazo === null)) return a.prazo === null ? 1 : -1;
    if (a.prazo === null || b.prazo === null || a.prazo === b.prazo) return 0;
    return a.prazo < b.prazo ? -1 : 1;
  });
}

/**
 * Devolve [total abertas, atrasadas]. `apenas_minhas`: só as que a regra
 * atribuiu à conta — é a conta do sino.
 */
export async function contar_abertas(
  tx: Executor,
  usuario: UsuarioAtual | null = null,
  apenas_minhas = false,
): Promise<[number, number]> {
  const itens = await abertas(tx, usuario, apenas_minhas);
  const hoje = hoje_iso();
  return [itens.length, itens.filter((p) => atrasada(p, hoje)).length];
}

// ---------------------------------------------------------------------
// Ligação com a casca (`web.ts`): o sino do topo é esta regra.
// ---------------------------------------------------------------------
// O sino conta as pendências DA PESSOA (responsável = a conta), e não a fila do
// setor: um número que é o mesmo para todo mundo ("40" em toda tela) deixa de
// ser aviso pessoal. A fila inteira continua em /pendencias; o sino leva a
// /pendencias?minhas=1, que é exatamente o que ele contou.
ganchos.podeVerPendencias = (usuario) => pode_ver(usuario);
ganchos.sino = async (c, usuario) => {
  const lidas = c.get("sino_antecipado");
  if (!lidas) return contar_abertas(c.get("tx"), usuario, true);
  // as linhas já lidas, no mesmo recorte de `abertas(..., apenas_minhas)`
  const itens = lidas.filter((p) => p.responsavel_id === usuario.id);
  const hoje = hoje_iso();
  return [itens.length, itens.filter((p) => atrasada(p, hoje)).length];
};
/**
 * Tela inteira (GET que não é HTMX nem API) lê as pendências abertas na mesma
 * ida ao banco da sessão: sem isto, o sino era mais uma ida só para ele, no fim.
 * Lê sem recorte (ainda não se sabe quem é); o recorte vem no `sino` acima.
 */
ganchos.anteciparSino = async (c) => {
  if (c.req.method !== "GET" || c.req.header("hx-request") || new URL(c.req.url).pathname.startsWith("/api/")) return;
  try {
    c.set(
      "sino_antecipado",
      await c
        .get("tx")
        .select({
          responsavel_id: tabela_pendencia.responsavel_id,
          prazo: tabela_pendencia.prazo,
          concluida: tabela_pendencia.concluida,
          // o tipo vai junto para a Visão geral (`/inicio`) contar as pendências
          // de cada módulo sem outra ida ao banco (`servicos/visao_geral.ts`)
          tipo: tabela_pendencia.tipo,
        })
        .from(tabela_pendencia)
        .where(eq(tabela_pendencia.concluida, false)),
    );
  } catch {
    // o sino nunca derruba a tela: sem a leitura antecipada, ele lê sozinho
  }
};
