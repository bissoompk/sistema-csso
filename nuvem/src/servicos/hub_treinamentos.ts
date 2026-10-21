/**
 * O que a página inicial do módulo mostra: quanto espera em cada passo do
 * trabalho. É o "Centro de Certificações e Inscrições" do IntegraSST, que
 * abria em cartões numerados; aqui cada cartão diz também o que há nele.
 *
 * Só conta: as listas moram nas telas para onde cada cartão leva, e as
 * contagens são as delas (a fila de emissão, o monitor de reciclagem, a caixa
 * de e-mails), para que o número do cartão e o da tela nunca discordem.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import * as email from "./email.js";
import * as fila_emissao from "./fila_emissao.js";
import type { UsuarioAtual } from "./rbac.js";
import * as reciclagem from "./reciclagem.js";
import * as servico_turma from "./turma.js";

/** Quantas turmas a vir a página lista abaixo dos cartões. */
export const PROXIMAS = 6;

export interface ProximaTurma {
  id: number;
  codigo: string;
  treinamento: string;
  data_inicio: string;
  data_fim: string;
  local: string | null;
  situacao: string;
}

export interface ResumoHub {
  turmas: Record<string, number>;
  pedidos_a_conferir: number;
  fila: Record<fila_emissao.Etapa, number>;
  reciclagem: Record<string, number>;
  emails: Record<string, number> | null;
  proximas: ProximaTurma[];
}

export async function resumo(tx: Executor, usuario: UsuarioAtual, hoje: string): Promise<ResumoHub> {
  const escopo = servico_turma.consulta_no_escopo(usuario);

  const por_situacao = await tx
    .select({ situacao: tabela_turma.situacao, n: count() })
    .from(tabela_turma)
    .where(escopo)
    .groupBy(tabela_turma.situacao);
  const turmas: Record<string, number> = {};
  for (const linha of por_situacao) turmas[linha.situacao] = Number(linha.n);

  const [pedidos] = await tx
    .select({ n: count() })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(and(escopo, eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")));

  const { contagem: fila } = await fila_emissao.fila(tx, usuario, {});
  const { contagem: recicl } = await reciclagem.monitor(tx, usuario, hoje, {});

  const proximas = await tx
    .select({
      id: tabela_turma.id,
      codigo: tabela_turma.codigo,
      treinamento: tabela_treinamento.nome,
      data_inicio: tabela_turma.data_inicio,
      data_fim: tabela_turma.data_fim,
      local: tabela_turma.local,
      situacao: tabela_turma.situacao,
    })
    .from(tabela_turma)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(and(escopo, inArray(tabela_turma.situacao, ["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"])))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_turma.id))
    .limit(PROXIMAS);

  return {
    turmas,
    pedidos_a_conferir: Number(pedidos?.n ?? 0),
    fila,
    reciclagem: recicl,
    emails: usuario.pode("certificado.emitir") ? await email.contagem(tx) : null,
    proximas,
  };
}
