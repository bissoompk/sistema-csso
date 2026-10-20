/**
 * A fila de emissão: todas as inscrições de todas as turmas, pela etapa em que
 * estão — do inscrito ao certificado emitido.
 *
 * A aba Emissão de cada turma continua sendo onde se emite uma turma inteira;
 * esta fila é a visão de cima, para achar o que ficou para trás (o aprovado de
 * março sem certificado) e emitir de várias turmas de uma vez.
 *
 * "Travado" é o aprovado que a emissão recusaria agora — a MESMA validação da
 * emissão (`emissao_certificado.validar` + o modelo da turma), com os motivos
 * dela. Os passos do IntegraSST ("gerar protocolo", "gerar PDF", "disparar
 * e-mail") aqui são um só: emitir dá número e chave, e o PDF sai do congelado
 * quando alguém o pede. O sistema não envia e-mail (ROPA).
 */
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { Certificado } from "../dominio/treinamento.js";
import * as servico_emissao from "./emissao_certificado.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import * as servico_turma from "./turma.js";

export const ETAPAS = ["AGUARDANDO", "TRAVADO", "EMITIDO", "INSCRITO", "FALTOU", "REPROVADO"] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ROTULO_ETAPA: Readonly<Record<Etapa, string>> = {
  AGUARDANDO: "Aguardando emissão",
  TRAVADO: "Travados",
  EMITIDO: "Emitidos",
  INSCRITO: "Em curso",
  FALTOU: "Faltaram",
  REPROVADO: "Reprovados",
};

/** A tela mostra no máximo isto de uma vez; a busca e os filtros recortam. */
export const LIMITE_LINHAS = 500;

export interface LinhaFila {
  inscricao_id: number;
  turma_id: number;
  turma_codigo: string;
  turma_fim: string;
  treinamento_nome: string;
  participante_nome: string;
  participante_identificador: string;
  siape: string;
  etapa: Etapa;
  certificado_id: number | null;
  certificado_rotulo: string;
  motivos: string[];
}

export interface Filtros {
  etapa?: string;
  treinamento_id?: number | null;
  busca?: string;
}

function _etapa(situacao: string, turma_situacao: string, emitido: boolean): Etapa | null {
  if (emitido) return "EMITIDO";
  if (situacao === "CANCELADA") return null;
  if (situacao === "AUSENTE") return "FALTOU";
  if (situacao === "REPROVADO") return "REPROVADO";
  if (situacao === "APROVADO" && turma_situacao === "CONCLUIDA") return "AGUARDANDO";
  return turma_situacao === "CANCELADA" ? null : "INSCRITO";
}

/**
 * Os motivos de cada aprovado ainda sem certificado: `{inscricao_id: motivos}`,
 * vazio para quem a emissão aceitaria. Uma carga de turma por turma.
 */
async function _bloqueios(tx: Executor, inscricao_ids: number[]): Promise<Map<number, string[]>> {
  const saida = new Map<number, string[]>();
  if (!inscricao_ids.length) return saida;
  const linhas = await tx
    .select({ id: tabela_inscricao.id, turma_id: tabela_inscricao.turma_id })
    .from(tabela_inscricao)
    .where(inArray(tabela_inscricao.id, inscricao_ids));
  const por_turma = new Map<number, Set<number>>();
  for (const l of linhas) {
    if (!por_turma.has(l.turma_id)) por_turma.set(l.turma_id, new Set());
    por_turma.get(l.turma_id)!.add(l.id);
  }
  for (const [turma_id, ids] of por_turma) {
    const turma = await servico_turma.carregar_turma(tx, turma_id);
    if (!turma) continue;
    const [modelo, sem_modelo] = await servico_emissao.modelo_da_turma(tx, turma);
    for (const inscricao of await servico_turma.inscricoes_da_turma(tx, turma)) {
      if (!ids.has(inscricao.id)) continue;
      const validacao = await servico_emissao.validar(tx, inscricao);
      const motivos = [...validacao.bloqueios];
      if (modelo === null) motivos.push(sem_modelo || "não há modelo de certificado para esta turma");
      saida.set(inscricao.id, motivos);
    }
  }
  return saida;
}

export async function fila(
  tx: Executor,
  usuario: UsuarioAtual,
  filtros: Filtros = {},
): Promise<{ itens: LinhaFila[]; contagem: Record<Etapa, number>; cortado: boolean }> {
  const onde: (SQL | undefined)[] = [servico_turma.consulta_no_escopo(usuario)];
  if (filtros.treinamento_id) onde.push(eq(tabela_turma.treinamento_id, filtros.treinamento_id));
  const linhas = await tx
    .select({
      inscricao_id: tabela_inscricao.id,
      situacao: tabela_inscricao.situacao,
      turma_id: tabela_turma.id,
      turma_codigo: tabela_turma.codigo,
      turma_situacao: tabela_turma.situacao,
      turma_fim: tabela_turma.data_fim,
      treinamento_nome: tabela_treinamento.nome,
      externo_nome: tabela_participante.nome,
      identificador: tabela_participante.identificador_publico,
      servidor_nome: tabela_servidor.nome,
      siape: tabela_servidor.siape,
      certificado_id: tabela_certificado.id,
      certificado_numero: tabela_certificado.numero,
      certificado_ano: tabela_certificado.ano,
    })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_inscricao.participante_id))
    .leftJoin(tabela_servidor, eq(tabela_servidor.id, tabela_participante.servidor_id))
    // o em vigor: um EMITIDO por inscrição (`uq_certificado_ativo`)
    .leftJoin(
      tabela_certificado,
      and(eq(tabela_certificado.inscricao_id, tabela_inscricao.id), eq(tabela_certificado.situacao, "EMITIDO")),
    )
    .where(and(...onde));

  let itens: LinhaFila[] = [];
  for (const l of linhas) {
    const etapa = _etapa(l.situacao, l.turma_situacao, l.certificado_id !== null);
    if (etapa === null) continue;
    itens.push({
      inscricao_id: l.inscricao_id,
      turma_id: l.turma_id,
      turma_codigo: l.turma_codigo,
      turma_fim: l.turma_fim,
      treinamento_nome: l.treinamento_nome,
      participante_nome: l.servidor_nome ?? l.externo_nome ?? "",
      participante_identificador: l.identificador,
      siape: l.siape ?? "",
      etapa,
      certificado_id: l.certificado_id,
      certificado_rotulo:
        l.certificado_numero !== null ? Certificado.rotulo({ numero: l.certificado_numero, ano: l.certificado_ano! }) : "",
      motivos: [],
    });
  }
  const termo = textos.chave_busca(filtros.busca ?? "");
  if (termo) {
    itens = itens.filter((x) =>
      textos
        .chave_busca([x.participante_nome, x.participante_identificador, x.siape, x.turma_codigo, x.treinamento_nome].join(" "))
        .includes(termo),
    );
  }
  // o aguardando que a emissão recusaria vira travado, com o motivo
  const bloqueios = await _bloqueios(
    tx,
    itens.filter((x) => x.etapa === "AGUARDANDO").map((x) => x.inscricao_id),
  );
  for (const x of itens) {
    const motivos = bloqueios.get(x.inscricao_id);
    if (motivos && motivos.length) {
      x.etapa = "TRAVADO";
      x.motivos = motivos;
    }
  }
  const contagem = Object.fromEntries(ETAPAS.map((e) => [e, 0])) as Record<Etapa, number>;
  for (const x of itens) contagem[x.etapa] += 1;
  const etapa = (ETAPAS as readonly string[]).includes(filtros.etapa ?? "") ? filtros.etapa : "AGUARDANDO";
  itens = itens.filter((x) => x.etapa === etapa);
  // a turma que terminou há mais tempo primeiro: é a que está esperando
  itens.sort(
    (a, b) =>
      a.turma_fim.localeCompare(b.turma_fim) ||
      a.turma_codigo.localeCompare(b.turma_codigo) ||
      a.participante_nome.localeCompare(b.participante_nome),
  );
  const cortado = itens.length > LIMITE_LINHAS;
  return { itens: itens.slice(0, LIMITE_LINHAS), contagem, cortado };
}

export interface ResultadoFila {
  emitidos: number;
  travados: { inscricao_id: number; quem: string; motivo: string }[];
}

/**
 * Emite as inscrições escolhidas, turma a turma, pelo lote da emissão (cada
 * item no seu savepoint): o travado não derruba os outros.
 */
export async function emitir_escolhidas(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao_ids: number[],
): Promise<ResultadoFila> {
  usuario.exigir("certificado.emitir");
  const resultado: ResultadoFila = { emitidos: 0, travados: [] };
  if (!inscricao_ids.length) return resultado;
  const linhas = await tx
    .select({ id: tabela_inscricao.id, turma_id: tabela_inscricao.turma_id })
    .from(tabela_inscricao)
    .where(inArray(tabela_inscricao.id, inscricao_ids));
  const por_turma = new Map<number, number[]>();
  for (const l of linhas) por_turma.set(l.turma_id, [...(por_turma.get(l.turma_id) ?? []), l.id]);
  for (const [turma_id, ids] of por_turma) {
    // o escopo de quem emite: turma fora dele não é emitida (nem dita)
    const turma = await servico_turma.no_escopo(tx, usuario, turma_id);
    if (!turma) continue;
    const relatorio = await servico_emissao.emitir_lote(tx, usuario, turma, { inscricao_ids: ids });
    resultado.emitidos += relatorio.emitidos.length;
    for (const item of relatorio.travados) {
      resultado.travados.push({
        inscricao_id: item.inscricao.id,
        quem: `${turma.codigo} · ${item.inscricao.participante.identificador_publico}`,
        motivo: item.erro ?? "",
      });
    }
  }
  return resultado;
}
