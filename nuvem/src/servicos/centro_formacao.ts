/**
 * O Centro de Formação que promove o curso de brigada (Portaria CBMMG nº 54/2020, art. 43, II, e
 * Anexo I: "promovido pelo Centro de Formação ___, CNPJ ___"). Lote 4 (25/11/2026).
 *
 * Fica em `parametro` (o coordenador muda sozinho, sem deploy). O certificado emitido congela os
 * dois valores do dia: trocar aqui não mexe em certificado já emitido.
 */
import { eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { parametro as tabela_parametro } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import { cnpj_valido } from "./epi_estoque.js";
import type { UsuarioAtual } from "./rbac.js";

export const CHAVE_NOME = "brigada.centro_formacao_nome";
export const CHAVE_CNPJ = "brigada.centro_formacao_cnpj";
export const PARAMETRO_ALTERADO = "BRIGADA_CENTRO_FORMACAO";

export class CentroInvalido extends RegraViolada {}

export interface CentroFormacao {
  nome: string | null;
  /** 14 caracteres, sem pontuação */
  cnpj: string | null;
}

export async function ler(tx: Executor): Promise<CentroFormacao> {
  const linhas = await tx.select().from(tabela_parametro).where(inArray(tabela_parametro.chave, [CHAVE_NOME, CHAVE_CNPJ]));
  const de = (k: string) => (linhas.find((l) => l.chave === k)?.valor ?? "").trim() || null;
  return { nome: de(CHAVE_NOME), cnpj: de(CHAVE_CNPJ) };
}

/** "12.345.678/0001-90" */
export function formatar_cnpj(cnpj: string | null | undefined): string {
  const c = (cnpj ?? "").trim();
  if (c.length !== 14) return c;
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

export function ler_cnpj(bruto: string): string | null {
  const c = bruto.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!c) return null;
  if (c.length !== 14) throw new CentroInvalido(`CNPJ do centro de formação com ${c.length} caractere(s): o CNPJ tem 14.`);
  if (!cnpj_valido(c)) throw new CentroInvalido("CNPJ do centro de formação inválido: o dígito verificador não confere.");
  return c;
}

async function _gravar(tx: Executor, chave: string, valor: string | null, descricao: string): Promise<void> {
  if (valor === null) {
    await tx.delete(tabela_parametro).where(eq(tabela_parametro.chave, chave));
    return;
  }
  await tx
    .insert(tabela_parametro)
    .values({ chave, valor, descricao })
    .onConflictDoUpdate({ target: tabela_parametro.chave, set: { valor } });
}

/** Grava os dois; devolve se algo mudou. A trilha leva o antes e o depois (dado público). */
export async function definir(
  tx: Executor,
  usuario: UsuarioAtual,
  d: { nome: string; cnpj: string },
): Promise<boolean> {
  const nome = d.nome.replace(/\s+/g, " ").trim() || null;
  if (nome && nome.length > 200) throw new CentroInvalido("O nome do centro de formação tem no máximo 200 caracteres.");
  const cnpj = ler_cnpj(d.cnpj);
  const antes = await ler(tx);
  if (antes.nome === nome && antes.cnpj === cnpj) return false;
  await _gravar(tx, CHAVE_NOME, nome, "Nome do Centro de Formação no certificado de brigada (CBMMG)");
  await _gravar(tx, CHAVE_CNPJ, cnpj, "CNPJ do Centro de Formação no certificado de brigada (CBMMG)");
  await auditoria.registrar(tx, {
    entidade: "parametro",
    entidade_id: 0,
    tipo_evento: PARAMETRO_ALTERADO,
    descricao:
      `Centro de formação da brigada: ${nome ?? "—"}, CNPJ ${formatar_cnpj(cnpj) || "—"} ` +
      `(antes: ${antes.nome ?? "—"}, CNPJ ${formatar_cnpj(antes.cnpj) || "—"})`,
    usuario,
  });
  return true;
}
