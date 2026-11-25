/**
 * As disciplinas do treinamento em TEMPOS (brigada, lote 4 — 25/11/2026): o agrupador do quadro
 * do verso e as linhas teórica e prática. Regras:
 *
 * - Só existem em treinamento em TEMPOS, e a soma das linhas tem de ser a carga do treinamento.
 * - Depois da primeira turma, tipo e tempos travam (a turma já se apura por elas). O nome ainda
 *   se corrige (erro de digitação) enquanto nenhum certificado do treinamento foi emitido.
 * - Toda mudança vai para a trilha, com o antes.
 */
import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  treinamento as tabela_treinamento,
  treinamento_disciplina as tabela_disciplina,
  treinamento_disciplina_linha as tabela_linha,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import * as brigada from "../dominio/brigada.js";
import * as carga from "../dominio/carga.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export const DISCIPLINAS_ALTERADAS = "TREINAMENTO_DISCIPLINAS";
/** Quantas linhas o formulário oferece. */
export const MAXIMO = 8;

export class RegraDasDisciplinas extends RegraViolada {}

export type LinhaRegistro = typeof tabela_linha.$inferSelect;
export type DisciplinaRegistro = typeof tabela_disciplina.$inferSelect;
export type DisciplinaCarregada = DisciplinaRegistro & { linhas: LinhaRegistro[] };

/** Para o `with` do drizzle: as disciplinas na ordem do quadro, com as linhas (teórica antes). */
export const COM_DISCIPLINAS = {
  orderBy: (d: typeof tabela_disciplina, { asc: a }: { asc: typeof asc }) => [a(d.ordem)],
  with: { linhas: { orderBy: (l: typeof tabela_linha, { desc: d }: { desc: typeof asc }) => [d(l.tipo)] } },
} as const;

export async function carregar(tx: Executor, treinamento_id: number): Promise<DisciplinaCarregada[]> {
  return (await tx.query.treinamento_disciplina.findMany({
    where: eq(tabela_disciplina.treinamento_id, treinamento_id),
    ...(COM_DISCIPLINAS as object),
  })) as unknown as DisciplinaCarregada[];
}

/** Tempos da linha de um tipo (0 quando a disciplina não tem a linha). */
export function tempos(d: { linhas: readonly LinhaRegistro[] }, tipo: brigada.TipoLinha): number {
  return d.linhas.find((l) => l.tipo === tipo)?.tempos ?? 0;
}

export function total(d: { linhas: readonly LinhaRegistro[] }): number {
  return d.linhas.reduce((s, l) => s + l.tempos, 0);
}

/** Em dados simples, para o formulário e a trilha. */
export function como_dados(lista: readonly DisciplinaCarregada[]): brigada.DisciplinaDados[] {
  return lista.map((d) => ({ nome: d.nome, teorica: tempos(d, "TEORICA"), pratica: tempos(d, "PRATICA") }));
}

function frase(lista: readonly brigada.DisciplinaDados[]): string {
  if (!lista.length) return "nenhuma";
  return lista.map((d) => `${d.nome} (teórica ${d.teorica} t, prática ${d.pratica} t)`).join("; ");
}

/**
 * Lê as linhas do formulário (`disc_nome_N`, `disc_teorica_N`, `disc_pratica_N`, N = 1..MAXIMO).
 * Linha com nome vazio e sem tempos é ignorada.
 */
export function ler_formulario(campo: (nome: string) => string): brigada.DisciplinaDados[] {
  const saida: brigada.DisciplinaDados[] = [];
  for (let n = 1; n <= MAXIMO; n++) {
    const nome = (campo(`disc_nome_${n}`) ?? "").replace(/\s+/g, " ").trim();
    const t = campo(`disc_teorica_${n}`).trim();
    const p = campo(`disc_pratica_${n}`).trim();
    if (!nome && !t && !p) continue;
    if (!nome) throw new RegraDasDisciplinas(`Disciplina ${n}: falta o nome.`);
    const ler = (v: string, qual: string) => {
      if (!v) return 0;
      if (!/^\d+$/.test(v)) throw new RegraDasDisciplinas(`${nome}: os tempos da parte ${qual} são um número inteiro.`);
      return Number(v);
    };
    const d = { nome, teorica: ler(t, "teórica"), pratica: ler(p, "prática") };
    if (d.teorica + d.pratica === 0) throw new RegraDasDisciplinas(`${nome}: informe os tempos da parte teórica, da prática ou das duas.`);
    saida.push(d);
  }
  return saida;
}

async function _turmas(tx: Executor, treinamento_id: number): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(tabela_turma).where(eq(tabela_turma.treinamento_id, treinamento_id));
  return Number(r?.n ?? 0);
}

async function _certificados(tx: Executor, treinamento_id: number): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(tabela_certificado)
    .where(and(eq(tabela_certificado.treinamento_id, treinamento_id), ne(tabela_certificado.situacao, "ANULADO")));
  return Number(r?.n ?? 0);
}

/**
 * Grava a lista inteira de disciplinas do treinamento. Devolve se algo mudou.
 */
export async function salvar(
  tx: Executor,
  usuario: UsuarioAtual,
  treinamento: typeof tabela_treinamento.$inferSelect,
  nova: readonly brigada.DisciplinaDados[],
): Promise<boolean> {
  if (treinamento.carga_unidade !== "TEMPOS") {
    throw new RegraDasDisciplinas("Disciplinas com nota existem só no treinamento com a carga em tempos (brigada).");
  }
  const nomes = new Set<string>();
  for (const d of nova) {
    const k = d.nome.toLocaleLowerCase("pt-BR");
    if (nomes.has(k)) throw new RegraDasDisciplinas(`A disciplina “${d.nome}” aparece duas vezes.`);
    nomes.add(k);
  }
  const total_carga = carga.para_base(treinamento.carga_horaria_horas, "TEMPOS");
  const soma = brigada.total_de_tempos(nova);
  if (nova.length && soma !== total_carga) {
    throw new RegraDasDisciplinas(
      `A soma das disciplinas (${carga.exibir_base(soma, "TEMPOS")}) tem de ser igual à carga do treinamento ` +
        `(${carga.exibir_base(total_carga, "TEMPOS")}).`,
    );
  }
  const atuais = await carregar(tx, treinamento.id);
  const antes = como_dados(atuais);
  const igual = (a: brigada.DisciplinaDados, b: brigada.DisciplinaDados) =>
    a.nome === b.nome && a.teorica === b.teorica && a.pratica === b.pratica;
  if (antes.length === nova.length && antes.every((a, i) => igual(a, nova[i]!))) return false;

  const turmas = await _turmas(tx, treinamento.id);
  if (turmas > 0) {
    // travado: só o nome, na mesma ordem, com os mesmos tempos
    const so_nome =
      antes.length === nova.length && antes.every((a, i) => a.teorica === nova[i]!.teorica && a.pratica === nova[i]!.pratica);
    if (!so_nome) {
      throw new RegraDasDisciplinas(
        `As disciplinas não mudam depois que o treinamento tem turma (${turmas}): a turma já se apura por elas. ` +
          "Só o nome se corrige, enquanto nenhum certificado foi emitido.",
      );
    }
    const emitidos = await _certificados(tx, treinamento.id);
    if (emitidos > 0) {
      throw new RegraDasDisciplinas(
        `O nome das disciplinas não muda depois que o treinamento tem certificado emitido (${emitidos}): ` +
          "o certificado já saiu com ele.",
      );
    }
    for (let i = 0; i < atuais.length; i++) {
      if (atuais[i]!.nome !== nova[i]!.nome) {
        await tx.update(tabela_disciplina).set({ nome: nova[i]!.nome }).where(eq(tabela_disciplina.id, atuais[i]!.id));
      }
    }
  } else {
    // sem turma: a lista é refeita inteira (nenhuma nota aponta para ela ainda)
    await tx.delete(tabela_disciplina).where(eq(tabela_disciplina.treinamento_id, treinamento.id));
    for (let i = 0; i < nova.length; i++) {
      const d = nova[i]!;
      const [criada] = await tx
        .insert(tabela_disciplina)
        .values({ treinamento_id: treinamento.id, ordem: i + 1, nome: d.nome })
        .returning();
      const linhas = [
        ...(d.teorica ? [{ disciplina_id: criada!.id, tipo: "TEORICA", tempos: d.teorica }] : []),
        ...(d.pratica ? [{ disciplina_id: criada!.id, tipo: "PRATICA", tempos: d.pratica }] : []),
      ];
      if (linhas.length) await tx.insert(tabela_linha).values(linhas);
    }
  }
  await auditoria.registrar(tx, {
    entidade: "treinamento",
    entidade_id: treinamento.id,
    tipo_evento: DISCIPLINAS_ALTERADAS,
    descricao: `${treinamento.codigo}: disciplinas — ${frase(nova)} (antes: ${frase(antes)})`,
    usuario,
  });
  return true;
}
