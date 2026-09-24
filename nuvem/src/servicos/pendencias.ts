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
  agora_utc,
  epi_ficha_registro,
  epi_requisicao,
  epi_requisicao_item,
  pendencia as tabela_pendencia,
} from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { Pendencia as PendenciaDominio } from "../dominio/auditoria.js";
import { RegraViolada } from "../nucleo/erros.js";
import { ganchos } from "../web.js";
import * as auditoria from "./auditoria.js";
import { ESCOPO_PROPRIO, PermissaoNegada, type UsuarioAtual } from "./rbac.js";

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
  // a demanda com prazo: sem prazo não abre pendência nenhuma
  DEMANDA_COM_PRAZO: ["Demanda com prazo a cumprir", 15],
  // nasce SEM responsável: é do setor
  TURMA_INSCRICAO_A_CONFIRMAR: ["Confirmar inscrição pedida pelo próprio servidor", 10],
};

// ---------------------------------------------------------------------
// Quem entra em /pendencias
// ---------------------------------------------------------------------
// Uma lista explícita de permissões de LEITURA de módulo — aceitar "qualquer
// permissão" deixaria entrar o admin_ti, que tem `indicador.ver` e, por decisão
// de projeto, não vê conteúdo técnico. Módulo novo acrescenta a sua aqui.
// (A história completa de cada entrada está no Python.)
export const PERMISSOES_VER: readonly string[] = ["processo.ver", "treinamento.ver", "epi.ver", "demanda.ver"];

// Fechar pendência dos outros é ato de quem opera o módulo. Fechar a PRÓPRIA
// pendência não depende desta lista: ver `pode_concluir`.
export const PERMISSOES_CONCLUIR: readonly string[] = ["processo.editar", "treinamento.gerenciar", "epi.entregar"];

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
 * Fecha quem opera o módulo — e sempre o dono da tarefa.
 *
 * O responsável fecha a própria pendência mesmo sem permissão de escrita: foi a
 * ele que a regra atribuiu o trabalho, e tarefa que o dono não consegue riscar
 * da lista vira lista que ninguém lê.
 */
export function pode_concluir(usuario: UsuarioAtual | null | undefined, pendencia: Pick<Pendencia, "responsavel_id">): boolean {
  if (!pode_ver(usuario)) return false;
  if (pendencia.responsavel_id !== null && pendencia.responsavel_id === usuario!.id) return true;
  return PERMISSOES_CONCLUIR.some((c) => usuario!.pode(c));
}

export function exigir_concluir(usuario: UsuarioAtual, pendencia: Pick<Pendencia, "responsavel_id">): void {
  exigir_ver(usuario); // a mensagem certa para quem nem vê a tela
  if (!pode_concluir(usuario, pendencia)) {
    throw new PermissaoNegada(
      PERMISSOES_CONCLUIR[0]!,
      "Concluir pendência de outra pessoa exige permissão de escrita no " +
        "módulo: " +
        PERMISSOES_CONCLUIR.join(", ") +
        ".",
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
  if (!usuario || usuario.escopo !== ESCOPO_PROPRIO) return undefined;
  return eq(tabela_pendencia.responsavel_id, usuario.id);
}

// A âncora que sabe dizer DE QUEM é a tarefa. Entidade nova entra aqui quando
// tiver como responder a pergunta — chave ausente cai no lado seguro (`null`).
const _TITULAR_POR_ENTIDADE: readonly string[] = ["epi_requisicao", "epi_requisicao_item", "epi_ficha_registro"];

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

/** Devolve [total abertas, atrasadas]. */
export async function contar_abertas(tx: Executor, usuario: UsuarioAtual | null = null): Promise<[number, number]> {
  const itens = await abertas(tx, usuario);
  const hoje = hoje_iso();
  return [itens.length, itens.filter((p) => atrasada(p, hoje)).length];
}

// ---------------------------------------------------------------------
// Ligação com a casca (`web.ts`): o sino do topo é esta regra.
// ---------------------------------------------------------------------
ganchos.podeVerPendencias = (usuario) => pode_ver(usuario);
ganchos.sino = (c, usuario) => contar_abertas(c.get("tx"), usuario);
