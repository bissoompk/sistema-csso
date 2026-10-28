/**
 * "Cursos abertos para você" no início do servidor, e o link da próxima
 * turma no aviso de reciclagem: as duas pontas ligam a conta à vitrine pública
 * sem criar tratamento novo. O cálculo usa só o que é do próprio titular (os
 * certificados dele e as inscrições dele) e a turma divulgada, que já é pública.
 *
 * Ordem das sugestões (sem dado sensível):
 *   1. reciclagem: a turma é de um treinamento com certificado dele vencido ou
 *      a vencer em até 90 dias ("Seu certificado vence em 12/2026");
 *   2. o mesmo campus do titular;
 *   3. a data mais próxima.
 * A turma em que ele já pediu vaga não some: sai depois das outras, com
 * "Você já pediu vaga" no lugar do botão. A cheia e a que ele abandonou não entram.
 */
import type { Executor } from "../db/cliente.js";
import * as datas_br from "./datas_br.js";
import type { UsuarioAtual } from "./rbac.js";
import * as servico_turma from "./turma.js";
import { COM_TURMA, type TurmaCarregada } from "./turma.js";
import { and, asc, eq } from "drizzle-orm";
import { turma as tabela_turma } from "../db/esquema/index.js";
import { curso_publico, type CursoPublico } from "./vitrine.js";

export const JANELA_RECICLAGEM_DIAS = 90;
export const MAXIMO = 3;

export interface CertificadoDoTitular {
  treinamento_id: number;
  /** `null` = sem vencimento: não puxa reciclagem */
  data_vencimento: string | null;
}

export interface Sugestao {
  turma_id: number;
  curso: CursoPublico;
  /** "Seu certificado vence em 12/2026" */
  motivo: string | null;
  ja_pediu: boolean;
}

export interface Sugestoes {
  /** sem `turma.inscrever_se` só aparece o link para a vitrine */
  pode_pedir: boolean;
  itens: Sugestao[];
}

function _motivo(vencimento: string, hoje: string): string {
  const [ano, mes] = vencimento.split("-");
  return vencimento < hoje ? `Seu certificado venceu em ${mes}/${ano}` : `Seu certificado vence em ${mes}/${ano}`;
}

export async function sugerir(
  tx: Executor,
  usuario: UsuarioAtual,
  titular: { certificados: CertificadoDoTitular[]; campus: string | null },
  hoje: string = datas_br.hoje(),
): Promise<Sugestoes> {
  if (!usuario.pode("turma.inscrever_se")) return { pode_pedir: false, itens: [] };
  const limite = datas_br.somar_dias(hoje, JANELA_RECICLAGEM_DIAS);
  // o vencimento mais urgente de cada treinamento
  const vence = new Map<number, string>();
  for (const c of titular.certificados) {
    if (c.data_vencimento === null || c.data_vencimento > limite) continue;
    const atual = vence.get(c.treinamento_id);
    if (atual === undefined || c.data_vencimento < atual) vence.set(c.treinamento_id, c.data_vencimento);
  }
  const minhas = new Map<number, string>();
  for (const i of await servico_turma.inscricoes_do_titular(tx, usuario)) minhas.set(i.turma_id, i.situacao);

  const abertas = (await servico_turma.turmas_abertas(tx, hoje)).filter((t) => t.divulgar_na_vitrine);
  const candidatas: { turma: TurmaCarregada; curso: CursoPublico; motivo: string | null; ja: boolean }[] = [];
  for (const turma of abertas) {
    const minha = minhas.get(turma.id);
    if (minha === "CANCELADA") continue;
    const curso = await curso_publico(tx, turma, hoje);
    if (curso.cheia && minha === undefined) continue;
    const v = vence.get(turma.treinamento_id);
    candidatas.push({ turma, curso, motivo: v ? _motivo(v, hoje) : null, ja: minha !== undefined });
  }
  const peso = (c: (typeof candidatas)[number]) =>
    (c.ja ? 100 : 0) + (c.motivo ? 0 : 10) + (titular.campus && c.curso.campus === titular.campus ? 0 : 1);
  candidatas.sort((a, b) => peso(a) - peso(b) || a.turma.data_inicio.localeCompare(b.turma.data_inicio) || a.turma.codigo.localeCompare(b.turma.codigo));
  return {
    pode_pedir: true,
    itens: candidatas.slice(0, MAXIMO).map((c) => ({ turma_id: c.turma.id, curso: c.curso, motivo: c.motivo, ja_pediu: c.ja })),
  };
}

/**
 * A próxima turma divulgada de um treinamento, com inscrição aberta: o que o
 * aviso de reciclagem aponta. `null` quando não há.
 */
export async function proxima_do_treinamento(tx: Executor, treinamento_id: number, hoje: string = datas_br.hoje()): Promise<TurmaCarregada | null> {
  const itens = (await tx.query.turma.findMany({
    where: and(eq(tabela_turma.treinamento_id, treinamento_id), eq(tabela_turma.divulgar_na_vitrine, true), eq(tabela_turma.situacao, "INSCRICOES_ABERTAS")),
    with: COM_TURMA as never,
    orderBy: [asc(tabela_turma.data_inicio), asc(tabela_turma.codigo)],
  })) as unknown as TurmaCarregada[];
  return itens.find((t) => !servico_turma.aberta_a_pedido_proprio(t, hoje)) ?? null;
}
