/**
 * Os pedidos que chegaram pelo link público, de todas as turmas, para aceitar
 * ou recusar de uma vez.
 *
 * No IntegraSST o formulário público já inscrevia: a CSSO não fazia nada. Aqui
 * o pedido nasce `AGUARDANDO_EMAIL` e só vira inscrição quando alguém confere
 * (`inscricao_publica.ts`), o que numa turma de 30 pessoas eram 60 cliques, um
 * pedido por vez. A regra de cada aceite continua a de sempre
 * (`turma.mudar_situacao_inscricao`, com a vaga conferida sob trava); o lote
 * só põe cada pedido no seu savepoint, e o que travar fica como estava, com o
 * motivo no relatório.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { TransicaoInvalida } from "../dominio/estados.js";
import { Participante } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import { nome_exibicao } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import * as servico_turma from "./turma.js";

/** Teto de um lote: o mesmo do teto de pedidos em espera por turma. */
export const LIMITE_LOTE = 200;

export interface PedidoNaFila {
  inscricao_id: number;
  turma_id: number;
  nome: string;
  identificador: string;
  vinculo: string;
  organizacao: string | null;
  email: string;
  observacao: string | null;
  criado_em: Date;
}

export interface TurmaComPedidos {
  id: number;
  codigo: string;
  treinamento: string;
  data_inicio: string;
  vagas: number | null;
  vagas_restantes: number | null;
  pedidos: PedidoNaFila[];
}

/** Os pedidos a conferir, agrupados pela turma, da turma mais próxima à mais distante. */
export async function a_conferir(tx: Executor, usuario: UsuarioAtual): Promise<TurmaComPedidos[]> {
  const linhas = await tx
    .select({ id: tabela_inscricao.id, turma_id: tabela_inscricao.turma_id })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(and(servico_turma.consulta_no_escopo(usuario), eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_inscricao.id))
    .limit(LIMITE_LOTE * 5);
  if (!linhas.length) return [];

  const turmas = await tx
    .select({
      id: tabela_turma.id,
      codigo: tabela_turma.codigo,
      treinamento: tabela_treinamento.nome,
      data_inicio: tabela_turma.data_inicio,
      vagas: tabela_turma.vagas,
    })
    .from(tabela_turma)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(inArray(tabela_turma.id, [...new Set(linhas.map((l) => l.turma_id))]))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_turma.id));

  const saida = new Map<number, TurmaComPedidos>();
  for (const t of turmas) {
    saida.set(t.id, {
      ...t,
      vagas_restantes: await servico_turma.vagas_restantes(tx, t as never),
      pedidos: [],
    });
  }
  for (const l of linhas) {
    const i = await servico_turma.carregar_inscricao(tx, l.id);
    if (!i) continue;
    saida.get(l.turma_id)!.pedidos.push({
      inscricao_id: i.id,
      turma_id: i.turma_id,
      nome: nome_exibicao(i.participante),
      identificador: i.participante.identificador_publico,
      vinculo: i.participante.vinculo,
      organizacao: i.participante.organizacao,
      email: Participante.email_exibicao(i.participante),
      observacao: i.observacao,
      criado_em: i.inscrito_em,
    });
  }
  return [...saida.values()].filter((t) => t.pedidos.length);
}

export interface ResultadoLote {
  feitos: number;
  travados: { inscricao_id: number; quem: string; motivo: string }[];
}

/**
 * Aceita (`INSCRITA`) ou recusa (`CANCELADA`, com motivo) os pedidos marcados.
 * Pedido fora do escopo, de outra situação ou que não existe é ignorado em
 * silêncio, como a fila de emissão faz com o que não está nela.
 */
export async function decidir(
  tx: Executor,
  usuario: UsuarioAtual,
  ids: number[],
  destino: "INSCRITA" | "CANCELADA",
  motivo: string | null = null,
): Promise<ResultadoLote> {
  usuario.exigir("turma.inscrever");
  if (destino === "CANCELADA" && !(motivo ?? "").trim()) {
    throw new RegraViolada("Para recusar, escreva o motivo: ele fica registrado na inscrição.");
  }
  const resultado: ResultadoLote = { feitos: 0, travados: [] };
  for (const id of [...new Set(ids)].slice(0, LIMITE_LOTE)) {
    const inscricao = await servico_turma.carregar_inscricao(tx, id);
    if (!inscricao || inscricao.situacao !== "AGUARDANDO_EMAIL") continue;
    if (!(await servico_turma.no_escopo(tx, usuario, inscricao.turma_id))) continue;
    try {
      await tx.transaction(async (sp) =>
        servico_turma.mudar_situacao_inscricao(sp as Executor, usuario, inscricao, destino, { motivo }),
      );
      resultado.feitos += 1;
    } catch (erro) {
      if (!(erro instanceof RegraViolada || erro instanceof TransicaoInvalida)) throw erro;
      resultado.travados.push({ inscricao_id: id, quem: nome_exibicao(inscricao.participante), motivo: erro.message });
    }
  }
  return resultado;
}
