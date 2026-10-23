/**
 * NUVEM (23/10/2026): o titular que NÃO é servidor — a conta do terceirizado
 * ou do discente (perfis `terceirizado`/`discente`, `rbac.PERFIS_EXTERNOS`).
 *
 * O servidor é identificado pelo `usuario.servidor_id`, e tudo o que é "meu"
 * (inscrições, certificados) sai de `participante.servidor_id`. A conta externa
 * nunca tem `servidor_id`; o elo dela é `participante.usuario_id` (migração
 * 0022): uma conta, um participante. Este módulo é o lugar ÚNICO das duas
 * perguntas — "a conta é titular externo?" e "qual é o participante dela?" —,
 * e Turmas e Certificados leem daqui.
 *
 * Mesma propriedade de segurança do pedido próprio (`turma.inscrever_se`): o
 * participante sai da SESSÃO (o id da conta), nunca de parâmetro da tela.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { participante as tabela_participante, usuario as tabela_usuario } from "../db/esquema/index.js";
import { normalizar_email } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as servico_participante from "./participante.js";
import type { ParticipanteCarregado } from "./participante.js";
import { PERFIS_EXTERNOS, type UsuarioAtual } from "./rbac.js";

type ContaDoTitular = Pick<UsuarioAtual, "id" | "servidor_id" | "perfis">;

/** O vínculo do participante que nasce para cada perfil externo. */
const VINCULO_POR_PERFIL: Readonly<Record<string, string>> = Object.freeze({
  terceirizado: "TERCEIRIZADO",
  discente: "DISCENTE",
});

/**
 * A conta é de terceirizado ou discente: sem cadastro de servidor e com um dos
 * perfis externos. A conta ligada a servidor segue pelo ramo do servidor, mesmo
 * que tenha ficado com perfil externo por engano.
 */
export function eh_titular_externo(usuario: Pick<ContaDoTitular, "servidor_id" | "perfis">): boolean {
  return usuario.servidor_id === null && usuario.perfis.some((p) => PERFIS_EXTERNOS.includes(p));
}

/**
 * A conta tem em nome de quem agir no que é "dela": o servidor ligado, ou o
 * perfil externo. É o que as telas de "Meus treinamentos" e "Meus
 * certificados" perguntavam com `servidor_id !== null`.
 */
export function tem_titular(usuario: Pick<ContaDoTitular, "servidor_id" | "perfis">): boolean {
  return usuario.servidor_id !== null || eh_titular_externo(usuario);
}

/** O vínculo do participante da conta externa, pelo perfil. */
export function vinculo_da_conta(usuario: Pick<ContaDoTitular, "perfis">): string {
  for (const p of usuario.perfis) {
    const v = VINCULO_POR_PERFIL[p];
    if (v) return v;
  }
  return "TERCEIRIZADO";
}

/**
 * O participante ligado à conta externa (`participante.usuario_id`), ou `null`
 * — também para a conta que não é titular externo: o servidor tem o dele por
 * `servidor_id`, e uma conta da equipe não tem participante.
 */
export async function participante_da_conta(tx: Executor, usuario: ContaDoTitular): Promise<ParticipanteCarregado | null> {
  if (!eh_titular_externo(usuario)) return null;
  const [linha] = await tx
    .select({ id: tabela_participante.id })
    .from(tabela_participante)
    .where(eq(tabela_participante.usuario_id, usuario.id));
  return linha ? servico_participante.carregar(tx, linha.id) : null;
}

/** Só o id de `participante_da_conta` — uma consulta, sem carregar e-mails. */
export async function id_do_participante_da_conta(tx: Executor, usuario: ContaDoTitular): Promise<number | null> {
  if (!eh_titular_externo(usuario)) return null;
  const [linha] = await tx
    .select({ id: tabela_participante.id })
    .from(tabela_participante)
    .where(eq(tabela_participante.usuario_id, usuario.id));
  return linha?.id ?? null;
}

/**
 * O participante da conta externa, criando-o na primeira vez (o primeiro
 * pedido de vaga). Idempotente: a segunda chamada devolve a mesma linha, e o
 * UNIQUE de `participante.usuario_id` segura a corrida.
 *
 * Antes de criar, o cadastro que JÁ existe: o participante externo, sem conta,
 * ativo e não absorvido, com o e-mail CONFIRMADO igual ao da conta (o login é o
 * e-mail) é a mesma pessoa — a que já fez treinamento pelo link público, por
 * exemplo — e é ligado à conta, para o histórico dela aparecer. E-mail não
 * confirmado não liga: não prova a posse da caixa.
 *
 * O nome e o e-mail do participante novo vêm da CONTA no banco (não da tela).
 */
export async function garantir_participante_da_conta(tx: Executor, usuario: UsuarioAtual): Promise<ParticipanteCarregado> {
  const existente = await participante_da_conta(tx, usuario);
  if (existente) return existente;
  const [conta] = await tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome, email: tabela_usuario.email })
    .from(tabela_usuario)
    .where(eq(tabela_usuario.id, usuario.id));
  if (!conta) throw new Error(`conta ${usuario.id} inexistente`);

  const email = normalizar_email(conta.email ?? "");
  for (const candidato of email ? await servico_participante.por_email_todos(tx, email) : []) {
    const confirmado = candidato.emails.some((e) => e.email_normalizado === email && e.confirmado_em !== null);
    if (
      !confirmado ||
      candidato.servidor_id !== null ||
      candidato.usuario_id !== null ||
      !candidato.ativo ||
      candidato.mesclado_em_id !== null
    ) {
      continue;
    }
    // a condição repetida no UPDATE: outra conta pode ter ligado no meio
    const ligados = await tx
      .update(tabela_participante)
      .set({ usuario_id: conta.id })
      .where(and(eq(tabela_participante.id, candidato.id), isNull(tabela_participante.usuario_id)))
      .returning({ id: tabela_participante.id });
    if (!ligados.length) continue;
    candidato.usuario_id = conta.id;
    await auditoria.registrar(tx, {
      entidade: "participante",
      entidade_id: candidato.id,
      tipo_evento: "PARTICIPANTE_CORRIGIDO",
      // a identidade pública e o id da conta; nem nome nem e-mail
      descricao: `${candidato.identificador_publico} · ligado à conta #${conta.id} pelo e-mail confirmado`,
      campo: "usuario_id",
      valor_anterior: null,
      valor_novo: String(conta.id),
      usuario,
    });
    return candidato;
  }

  const novo = await servico_participante.criar_externo(tx, {
    nome: conta.nome,
    vinculo: vinculo_da_conta(usuario),
    email: conta.email ?? "",
    usuario,
  });
  await tx.update(tabela_participante).set({ usuario_id: conta.id }).where(eq(tabela_participante.id, novo.id));
  novo.usuario_id = conta.id;
  return novo;
}
