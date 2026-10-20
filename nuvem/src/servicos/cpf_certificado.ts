/**
 * CPF só para o certificado (decisão do dono do sistema, 19/10/2026).
 *
 * O certificado de Brigadista Orgânico (norma do CBMMG) traz o CPF do
 * participante e o do responsável pela formação. Fora disso o sistema continua
 * sem CPF: todo campo livre o mascara na porta (`dependencias.semCpf`), e a
 * busca o recusa. As regras deste dado, todas aqui:
 *
 * 1. **Onde mora.** `participante.cpf` (servidor ou externo: uma linha por
 *    pessoa, sem cópia em `servidor`) e `assinatura_instrutor.cpf`. Só dígitos,
 *    com dígito verificador conferido; o banco cobra o formato.
 * 2. **Por onde entra.** Só pelo campo `cpf_certificado`
 *    (`dependencias.CAMPO_CPF_CERTIFICADO`), o único que escapa da máscara.
 *    Em branco = não mexe; apagar é ato próprio.
 * 3. **O que sai.** Na tela, no máximo `textos.CPF_MASCARADO` (nenhum dígito);
 *    nunca em lista, busca, CSV, API ou log. A trilha registra QUE mudou, nunca
 *    o valor. O número inteiro só sai no documento do certificado, e só quando
 *    o modelo do treinamento tem marcador para ele (`participante_cpf`,
 *    `instrutor_cpf`) — só então ele é congelado no contexto.
 * 4. **Quem altera.** Quem já gerencia a pessoa: `turma.inscrever` para o
 *    participante, `assinatura.gerenciar` para o instrutor (as rotas cobram).
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { assinatura_instrutor as tabela_assinatura, participante as tabela_participante } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export class CpfInvalido extends RegraViolada {}

/** Os campos do vocabulário que pedem o CPF — e só eles fazem o CPF ser congelado. */
export const CAMPO_CPF_PARTICIPANTE = "participante_cpf";
export const CAMPO_CPF_INSTRUTOR = "instrutor_cpf";

/** O que a tela mostra: a máscara sem dígito, ou "não informado". */
export function exibir(cpf: string | null | undefined): string {
  return cpf ? textos.CPF_MASCARADO : "não informado";
}

/**
 * Lê o campo do formulário: `undefined` = não mexer (em branco), `null` =
 * apagar, string = os onze dígitos conferidos. A mensagem de recusa não ecoa o
 * que foi digitado.
 */
export function ler_campo(bruto: string | null | undefined, apagar = false): string | null | undefined {
  if (apagar) return null;
  const limpo = (bruto ?? "").trim();
  if (!limpo) return undefined;
  const digitos = textos.cpf_digitos(limpo);
  if (digitos === null) throw new CpfInvalido("CPF inválido: confira os dígitos (11 números, com o verificador).");
  return digitos;
}

/** A frase da trilha: o fato, sem o valor. */
function _frase(antes: string | null, depois: string | null): string | null {
  if (antes === depois) return null;
  if (antes === null) return "CPF informado";
  if (depois === null) return "CPF apagado";
  return "CPF substituído";
}

export async function definir_do_participante(
  tx: Executor,
  usuario: UsuarioAtual | null,
  participante: { id: number; identificador_publico: string; cpf?: string | null },
  novo: string | null,
): Promise<boolean> {
  const [atual] = await tx
    .select({ cpf: tabela_participante.cpf })
    .from(tabela_participante)
    .where(eq(tabela_participante.id, participante.id));
  const frase = _frase(atual?.cpf ?? null, novo);
  if (frase === null) return false;
  await tx.update(tabela_participante).set({ cpf: novo }).where(eq(tabela_participante.id, participante.id));
  participante.cpf = novo;
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: participante.id,
    tipo_evento: "PARTICIPANTE_CPF_ALTERADO",
    // RN-19 na escrita: a identidade pública, e nunca o número
    descricao: `${participante.identificador_publico} · ${frase}`,
    usuario,
  });
  return true;
}

export async function definir_do_instrutor(
  tx: Executor,
  usuario: UsuarioAtual | null,
  assinatura_id: number,
  novo: string | null,
): Promise<boolean> {
  const [atual] = await tx
    .select({ cpf: tabela_assinatura.cpf, nome: tabela_assinatura.nome })
    .from(tabela_assinatura)
    .where(eq(tabela_assinatura.id, assinatura_id));
  if (!atual) return false;
  const frase = _frase(atual.cpf ?? null, novo);
  if (frase === null) return false;
  await tx.update(tabela_assinatura).set({ cpf: novo }).where(eq(tabela_assinatura.id, assinatura_id));
  await auditoria.registrar(tx, {
    entidade: "assinatura_instrutor",
    entidade_id: assinatura_id,
    tipo_evento: "ASSINATURA_INSTRUTOR_CPF_ALTERADO",
    // o nome do instrutor já sai na trilha da assinatura (é o ator que assina)
    descricao: `${atual.nome} · ${frase}`,
    usuario,
  });
  return true;
}

/**
 * O dump da exportação EM CLARO sem CPF (`backup.sem_credenciais`): a coluna
 * vira null e o contexto congelado perde as chaves. O backup cifrado leva tudo.
 */
export function sem_cpf_no_dump(tabela: string, linhas: Record<string, unknown>[]): boolean {
  if (tabela === "participante" || tabela === "assinatura_instrutor") {
    for (const l of linhas) if ("cpf" in l) l.cpf = null;
    return true;
  }
  if (tabela === "certificado") {
    for (const l of linhas) {
      const ctx = l.contexto_congelado;
      if (ctx && typeof ctx === "object") sem_cpf_no_contexto(ctx as Record<string, unknown>);
    }
    return true;
  }
  return false;
}

/** Tira o CPF de um contexto congelado de certificado (no lugar). */
export function sem_cpf_no_contexto(ctx: Record<string, unknown>): Record<string, unknown> {
  delete ctx.participante_cpf;
  for (const i of (ctx.instrutores as Record<string, unknown>[] | undefined) ?? []) {
    if (i && typeof i === "object") delete i.cpf;
  }
  return ctx;
}
