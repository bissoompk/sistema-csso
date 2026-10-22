/**
 * NUVEM: as turmas por setor promotor — o recorte da EQUIPE.
 *
 * Cada setor (a CSSO, a CPEL, …) vê e gere só as turmas que ele promove, e o
 * que pende delas: as inscrições, os pedidos pelo link, a emissão, o envio do
 * certificado, a reciclagem e os indicadores. As regras:
 *
 * - quem tem `turma.todos_os_setores` (a coordenação, a auditoria, a consulta
 *   da PROGEP) vê todas;
 * - a turma sem `unidade_promotora_id` (as de antes dos setores) é da CSSO, e
 *   a vê quem está vinculado à CSSO (`usuario.setor_csso`);
 * - a conta de equipe sem setor nenhum não vê turma nenhuma — e a tela diz por
 *   quê (`sem_setor`, a parte `partes/aviso_sem_setor.html`);
 * - o TITULAR não passa por aqui: a própria inscrição e o próprio certificado
 *   são dele, de qualquer setor. Quem combina este recorte com o escopo
 *   (`turma.consulta_no_escopo`, `emissao_certificado.no_escopo`) só o aplica
 *   ao alcance de equipe;
 * - o `UsuarioAtual` montado à mão (`concessoes === null`, testes unitários)
 *   não é recortado, como no resto do RBAC.
 *
 * Aqui só há CONDIÇÕES: quem consulta as combina com as dele.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder, type PgColumn } from "drizzle-orm/pg-core";
import {
  certificado as tabela_certificado,
  email_saida as tabela_email,
  inscricao as tabela_inscricao,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import type { UsuarioAtual } from "./rbac.js";

export const PERMISSAO_TODOS = "turma.todos_os_setores";

/** As permissões que fazem de uma conta "da equipe" do módulo, para o aviso. */
const PERMISSOES_DA_EQUIPE = [
  "treinamento.ver",
  "certificado.ver",
  "certificado.emitir",
  "turma.criar",
  "turma.inscrever",
  "turma.avaliar",
  "indicador.ver",
];

/** A frase do aviso, também para quem a mostra fora da parte. */
export const AVISO_SEM_SETOR =
  "Sua conta não está vinculada a nenhum setor promotor, por isso as turmas e os certificados " +
  "dos setores não aparecem aqui. Peça à coordenação para vincular você ao seu setor.";

/** Sem recorte de setor: vê todos, ou é a conta montada à mão (compatibilidade). */
export function ve_todos(usuario: UsuarioAtual): boolean {
  return usuario.concessoes === null || usuario.pode(PERMISSAO_TODOS);
}

/** O setor promotor (`unidade_uorg.id`) da turma é um dos que a conta alcança? */
export function alcanca_setor(usuario: UsuarioAtual, unidade_promotora_id: number | null): boolean {
  if (ve_todos(usuario)) return true;
  if (unidade_promotora_id === null) return usuario.setor_csso;
  return usuario.setores_promotores.includes(unidade_promotora_id);
}

/**
 * A conta de equipe do módulo sem setor nenhum (e sem ver todos): as telas da
 * equipe mostram o aviso. O titular puro não é "sem setor": não é da equipe.
 */
export function sem_setor(usuario: UsuarioAtual): boolean {
  if (ve_todos(usuario) || usuario.setores_promotores.length) return false;
  return usuario.pode_na_equipe(PERMISSOES_DA_EQUIPE);
}

/**
 * A condição sobre a coluna do setor promotor da turma: `undefined` sem recorte;
 * senão os setores da conta e, para a CSSO, a turma sem setor; `false` para a
 * conta sem setor.
 */
export function condicao_setor_turma(
  usuario: UsuarioAtual,
  coluna: PgColumn = tabela_turma.unidade_promotora_id,
): SQL | undefined {
  if (ve_todos(usuario)) return undefined;
  const partes: SQL[] = [];
  if (usuario.setores_promotores.length) partes.push(inArray(coluna, [...usuario.setores_promotores]));
  if (usuario.setor_csso) partes.push(isNull(coluna));
  if (!partes.length) return sql`false`;
  return partes.length === 1 ? partes[0] : or(...partes);
}

/** As inscrições das turmas do setor da conta (subconsulta), ou `undefined` sem recorte. */
function _inscricoes_do_setor(usuario: UsuarioAtual) {
  const cond = condicao_setor_turma(usuario);
  if (cond === undefined) return undefined;
  return new QueryBuilder()
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(cond);
}

/**
 * A condição sobre `certificado`: o da turma de um setor da conta. Todo
 * certificado tem inscrição, e toda inscrição tem turma — o importado também
 * (numa turma sem setor, que conta como da CSSO). `incluir_proprio` deixa
 * passar o certificado do próprio titular, de qualquer setor (a ficha dele).
 */
export function condicao_setor_certificado(usuario: UsuarioAtual, incluir_proprio = false): SQL | undefined {
  const sub = _inscricoes_do_setor(usuario);
  if (sub === undefined) return undefined;
  const do_setor = inArray(tabela_certificado.inscricao_id, sub);
  if (!incluir_proprio || usuario.servidor_id === null) return do_setor;
  return or(eq(tabela_certificado.servidor_id, usuario.servidor_id), do_setor);
}

/**
 * A condição sobre `email_saida` (a caixa de envios do módulo): o e-mail de
 * certificado ou de inscrição de turma do setor. O que não aponta para nenhum
 * dos dois (o link de acesso aos certificados, por exemplo) fica com a CSSO,
 * que sempre cuidou da caixa.
 */
export function condicao_setor_email(usuario: UsuarioAtual): SQL | undefined {
  const sub = _inscricoes_do_setor(usuario);
  if (sub === undefined) return undefined;
  const certificados_do_setor = new QueryBuilder()
    .select({ id: tabela_certificado.id })
    .from(tabela_certificado)
    .where(inArray(tabela_certificado.inscricao_id, sub));
  const partes: (SQL | undefined)[] = [
    and(isNotNull(tabela_email.certificado_id), inArray(tabela_email.certificado_id, certificados_do_setor)),
    and(isNull(tabela_email.certificado_id), isNotNull(tabela_email.inscricao_id), inArray(tabela_email.inscricao_id, sub)),
  ];
  if (usuario.setor_csso) partes.push(and(isNull(tabela_email.certificado_id), isNull(tabela_email.inscricao_id)));
  return or(...partes);
}
