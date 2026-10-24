/**
 * "Cadastre-se" do terceirizado e do discente (23/10/2026): o PEDIDO de conta.
 *
 * O servidor não passa por aqui: o cadastro de servidores já diz quem ele é, e
 * o primeiro acesso dele é o de `ativar_acesso.ts` (SIAPE + e-mail do
 * cadastro). Para terceirizado e discente o desenho é:
 *
 * - **A pessoa escolhe a senha no pedido (24/10/2026) e confirma o e-mail.**
 *   O pedido nasce `AGUARDANDO_EMAIL`, com a senha em hash, e um link
 *   "Confirmar e-mail" vai ao endereço digitado. Quem digitou o e-mail de outra
 *   pessoa não passa daqui: a confirmação está na caixa do dono.
 * - **Confirmado, a conta é liberada na hora** (24/10/2026, a pedido da
 *   coordenação: "não preciso autorizar todos"). Nasce com a senha escolhida, o
 *   perfil do vínculo (`terceirizado` ou `discente`) e NUNCA ligada a servidor.
 *   Quem cria conta (`usuario.criar_conta`) bloqueia, desbloqueia ou exclui em
 *   "Contas do Cadastre-se"; excluir só apaga a conta sem registros, e a que
 *   tem é bloqueada no lugar. Os pedidos de antes, que ficaram na fila, ainda se
 *   aprovam ou recusam ali.
 * - **Sem oráculo.** A tela responde a mesma frase a todo pedido, com piso de
 *   tempo. E-mail que já tem conta, que é de servidor ou que já tem pedido na
 *   fila não abre outro pedido: o dono recebe uma mensagem neutra dizendo o
 *   caminho (com o teto por destinatário de `ativar_acesso`).
 * - **Discente, só com e-mail institucional** (`DOMINIO_DISCENTE`). Pedido só de
 *   maior de 18 anos (LGPD art. 14: dado de criança e adolescente pede
 *   consentimento dos pais, e este fluxo não o colhe).
 * - **Trilha sem nome nem e-mail.** Os eventos dizem o número do pedido e o
 *   vínculo. O pedido decidido é apagado em `DIAS_DO_PEDIDO` (a conta, se
 *   houve, guarda o que precisa).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  atribuicao,
  sessao as tabela_sessao,
  pedido_conta as tabela,
  pendencia as tabela_pendencia,
  perfil as tabela_perfil,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { normalizar_email } from "../dominio/treinamento.js";
import * as ativar_acesso from "./ativar_acesso.js";
import * as auditoria from "./auditoria.js";
import * as autenticacao from "./autenticacao.js";
import * as email from "./email.js";
import * as pendencias from "./pendencias.js";
import { PERFIL_POR_VINCULO, PERFIS_EXTERNOS, perfis_vigentes, type UsuarioAtual } from "./rbac.js";

export const CAMINHO = "/cadastre-se";
export const VINCULOS = ["TERCEIRIZADO", "DISCENTE"] as const;
export type Vinculo = (typeof VINCULOS)[number];
export const ROTULO_VINCULO: Readonly<Record<Vinculo, string>> = { TERCEIRIZADO: "Terceirizado", DISCENTE: "Discente" };
export const DOMINIO_DISCENTE = "ufvjm.edu.br";
export const PEDIDOS_POR_HORA_POR_IP = 5;
export const DIAS_DO_PEDIDO = 90;
/** O link da conta aprovada vale mais que o do "Esqueci": a pessoa pode demorar a ver. */
export const VALIDADE_DO_LINK_MS = 72 * 3_600_000;
export const TIPO_PENDENCIA = "CONTA_A_CONFERIR";
export const TIPO_NEUTRO = "PEDIDO_CONTA_NEUTRO";
export const TIPO_RECUSA = "PEDIDO_CONTA_RECUSADO";
export const TIPO_CONFIRMAR = "PEDIDO_CONTA_CONFIRMAR";
export const TIPO_APROVADO = "PEDIDO_CONTA_APROVADO";
export const CAMINHO_CONFIRMAR = `${CAMINHO}/confirmar`;
export const VALIDADE_CONFIRMACAO_MS = 24 * 3_600_000;
/** O pedido que ninguém confirmou sai antes do prazo geral. */
export const DIAS_SEM_CONFIRMACAO = 3;

export const PEDIDO_DE_CONTA_RECEBIDO = "PEDIDO_DE_CONTA_RECEBIDO";
export const PEDIDO_DE_CONTA_APROVADO = "PEDIDO_DE_CONTA_APROVADO";
export const PEDIDO_DE_CONTA_RECUSADO = "PEDIDO_DE_CONTA_RECUSADO";

export const RESPOSTA_PADRAO =
  "Enviamos ao e-mail informado um link para você confirmar que ele é seu. A conta é liberada assim " +
  "que você confirmar. Confira também a caixa de spam.";

export class DadosInvalidos extends Error {
  constructor(
    message: string,
    readonly campo: string,
  ) {
    super(message);
  }
}
export class DecisaoRecusada extends Error {}

export type Pedido = typeof tabela.$inferSelect;

export interface DadosPedido {
  vinculo: string;
  nome: string;
  email: string;
  organizacao: string;
  matricula: string;
  maior_de_idade: boolean;
  nova?: string;
  confirmacao?: string;
}

const _CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/;

/** Confere e limpa o que foi digitado; o erro diz o campo (é igual para todo mundo). */
export function limpar(
  d: DadosPedido,
): Omit<DadosPedido, "vinculo" | "maior_de_idade" | "nova" | "confirmacao"> & { vinculo: Vinculo } {
  const vinculo = d.vinculo.trim() as Vinculo;
  if (!VINCULOS.includes(vinculo)) throw new DadosInvalidos("Escolha o vínculo: terceirizado ou discente.", "o vínculo");
  const nome = d.nome.replace(/\s+/g, " ").trim();
  if (nome.length < 5 || !nome.includes(" ")) throw new DadosInvalidos("Digite o nome completo.", "o nome");
  if (nome.length > 160) throw new DadosInvalidos("O nome passa de 160 caracteres.", "o nome");
  if (/\d/.test(nome)) throw new DadosInvalidos("O nome não leva números.", "o nome");
  const mail = d.email.trim();
  if (mail.length > 160 || !email.email_valido(mail)) throw new DadosInvalidos("Digite o e-mail completo.", "o e-mail");
  if (vinculo === "DISCENTE" && !normalizar_email(mail).endsWith(`@${DOMINIO_DISCENTE}`)) {
    throw new DadosInvalidos(`Discente pede com o e-mail institucional (@${DOMINIO_DISCENTE}).`, "o e-mail");
  }
  const organizacao = d.organizacao.replace(/\s+/g, " ").trim();
  if (!organizacao) {
    throw new DadosInvalidos(
      vinculo === "TERCEIRIZADO" ? "Informe a empresa em que você trabalha." : "Informe o seu curso.",
      vinculo === "TERCEIRIZADO" ? "a empresa" : "o curso",
    );
  }
  if (organizacao.length > 160) throw new DadosInvalidos("O texto passa de 160 caracteres.", "a empresa ou o curso");
  const matricula = d.matricula.trim();
  if (matricula.length > 30) throw new DadosInvalidos("A matrícula passa de 30 caracteres.", "a matrícula");
  if (_CPF.test(organizacao) || _CPF.test(matricula)) {
    throw new DadosInvalidos("CPF não entra no pedido de conta.", "a empresa ou o curso");
  }
  if (!d.maior_de_idade) {
    throw new DadosInvalidos(
      "O pedido de conta é só para maiores de 18 anos. Menor de idade procura a equipe da Sisa.",
      "a idade",
    );
  }
  return { vinculo, nome, email: mail, organizacao, matricula };
}

async function _hash_da_senha(d: DadosPedido): Promise<string> {
  try {
    return await ativar_acesso.hash_da_senha_escolhida(d.nova ?? "", d.confirmacao ?? "");
  } catch (erro) {
    if (erro instanceof ativar_acesso.DadosInvalidos) throw new DadosInvalidos(erro.message, "a senha");
    throw erro;
  }
}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** O e-mail já está no sistema: conta, cadastro de servidor ou pedido na fila. */
async function _ja_existe(tx: Executor, alvo: string): Promise<boolean> {
  const [conta] = await tx
    .select({ id: tabela_usuario.id })
    .from(tabela_usuario)
    .where(sql`lower(${tabela_usuario.email}) = ${alvo} OR lower(${tabela_usuario.login}) = ${alvo}`)
    .limit(1);
  if (conta) return true;
  const [servidor] = await tx
    .select({ id: tabela_servidor.id })
    .from(tabela_servidor)
    .where(sql`lower(btrim(${tabela_servidor.email})) = ${alvo}`)
    .limit(1);
  if (servidor) return true;
  const [pedido] = await tx
    .select({ id: tabela.id })
    .from(tabela)
    .where(and(eq(tabela.email_normalizado, alvo), eq(tabela.situacao, "PENDENTE")))
    .limit(1);
  return !!pedido;
}

const ASSINATURA = "Superintendência Integrada de Saúde (Sisa) — UFVJM\nMensagem enviada pelo Sistema SISA.\n";

export function corpo_neutro(): string {
  return (
    "Olá.\n\n" +
    "Recebemos um pedido de conta no Sistema SISA com este e-mail, mas ele já está no sistema " +
    "(numa conta, num pedido em análise ou no cadastro de servidores).\n\n" +
    "- Se você já tem conta, use \"Esqueci minha senha\" na tela de entrada.\n" +
    "- Se você é servidor da UFVJM, use \"Primeiro acesso\" e escolha \"Servidor\".\n" +
    "- Se a conta foi bloqueada, procure a equipe da Sisa.\n\n" +
    "Se não foi você, ignore esta mensagem.\n\n" +
    ASSINATURA
  );
}

export function corpo_da_confirmacao(link: string): string {
  return (
    "Olá.\n\n" +
    "Foi feito um pedido de conta no Sistema SISA com este e-mail. Para confirmar que ele é seu, abra o " +
    "link abaixo nas próximas 24 horas e clique em \"Confirmar\":\n\n" +
    `${link}\n\n` +
    "Confirmado, a conta é liberada na hora: entre com este e-mail e a senha que você escolheu.\n\n" +
    "SE NÃO FOI VOCÊ QUE PEDIU, NÃO CONFIRME: ignore esta mensagem e o pedido é apagado.\n\n" +
    ASSINATURA
  );
}

export function corpo_da_liberacao(base_url: string): string {
  return (
    "Olá.\n\n" +
    "O seu pedido de conta no Sistema SISA foi aprovado pela equipe da Sisa. A conta já está liberada: " +
    `entre em ${base_url}/login com este e-mail e a senha que você escolheu no pedido.\n\n` +
    "Esqueceu a senha? Use \"Esqueci minha senha\" na tela de entrada.\n\n" +
    ASSINATURA
  );
}

export function corpo_da_aprovacao(link: string): string {
  return (
    "Olá.\n\n" +
    "O seu pedido de conta no Sistema SISA foi aprovado pela equipe da Sisa. Para definir a senha, use o " +
    "link abaixo nos próximos 3 dias. Ele serve uma vez só:\n\n" +
    `${link}\n\n` +
    "Depois, entre com este e-mail e a senha que escolheu. Se o link vencer, use \"Esqueci minha senha\" " +
    "na tela de entrada.\n\n" +
    ASSINATURA
  );
}

export function corpo_da_recusa(): string {
  return (
    "Olá.\n\n" +
    "O seu pedido de conta no Sistema SISA não foi aprovado. Se acha que houve engano, procure a equipe " +
    "da Sisa.\n\n" +
    "Para comunicar acidente e se inscrever em treinamento, não é preciso conta: use o link que o seu " +
    "setor ou a turma divulgar.\n\n" +
    ASSINATURA
  );
}

/**
 * O pedido. Não devolve nada de propósito: a rota responde sempre
 * `RESPOSTA_PADRAO`. Lança `DadosInvalidos` só para o que está mal digitado
 * (a senha incluída: a política é a mesma para todo mundo).
 */
export async function pedir(
  tx: Executor,
  d: DadosPedido,
  ip: string | null,
  base_url: string,
  agora: Date = new Date(),
): Promise<void> {
  const limpo = limpar(d);
  const senha_hash = await _hash_da_senha(d);
  const [recentes] = await tx
    .select({ n: count() })
    .from(tabela)
    .where(and(ip === null ? sql`${tabela.ip} IS NULL` : eq(tabela.ip, ip), gt(tabela.criado_em, new Date(agora.getTime() - 3_600_000))));
  if (Number(recentes?.n ?? 0) >= PEDIDOS_POR_HORA_POR_IP) return;
  const alvo = normalizar_email(limpo.email);
  if (await _ja_existe(tx, alvo)) {
    // o registro conta para o teto por IP, sem nada da pessoa
    await tx.insert(tabela).values({ ...limpo, nome: "", email: "", email_normalizado: "", organizacao: "", matricula: null, situacao: "DESCARTADO", ip, criado_em: agora });
    if (await ativar_acesso.no_teto_do_destinatario(tx, limpo.email, agora)) return;
    await email.enfileirar(tx, {
      tipo: TIPO_NEUTRO,
      destinatario: limpo.email,
      assunto: ativar_acesso.ASSUNTO,
      corpo: corpo_neutro(),
      expira_em: new Date(agora.getTime() + 24 * 3_600_000),
    });
    return;
  }
  // o pedido anterior do mesmo e-mail que ninguém confirmou dá lugar a este:
  // ninguém bloqueia o e-mail de outra pessoa pedindo antes dela
  await _descartar(tx, and(eq(tabela.email_normalizado, alvo), eq(tabela.situacao, "AGUARDANDO_EMAIL")));
  if (await ativar_acesso.no_teto_do_destinatario(tx, limpo.email, agora)) return;
  const token = randomBytes(24).toString("base64url");
  await tx.insert(tabela).values({
    ...limpo,
    matricula: limpo.matricula || null,
    email_normalizado: alvo,
    situacao: "AGUARDANDO_EMAIL",
    senha_hash,
    token_hash: _hash(token),
    token_expira_em: new Date(agora.getTime() + VALIDADE_CONFIRMACAO_MS),
    ip,
    criado_em: agora,
  });
  await email.enfileirar(tx, {
    tipo: TIPO_CONFIRMAR,
    destinatario: limpo.email,
    assunto: ativar_acesso.ASSUNTO,
    corpo: corpo_da_confirmacao(`${base_url}${CAMINHO_CONFIRMAR}/${token}`),
    expira_em: new Date(agora.getTime() + VALIDADE_CONFIRMACAO_MS),
  });
}

/** Apaga o dado da pessoa e deixa a linha só para o teto por IP. */
async function _descartar(tx: Executor, onde: ReturnType<typeof and>): Promise<void> {
  await tx
    .update(tabela)
    .set({ situacao: "DESCARTADO", nome: "", email: "", email_normalizado: "", organizacao: "", matricula: null, senha_hash: null, token_hash: null })
    .where(onde);
}

/** O pedido à espera da confirmação deste link, ou `null` (vencido, usado, inventado). */
export async function pedido_a_confirmar(tx: Executor, token: string, agora: Date = new Date()): Promise<Pedido | null> {
  if (!token || token.length > 64) return null;
  const [pedido] = await tx.select().from(tabela).where(eq(tabela.token_hash, _hash(token)));
  if (!pedido || pedido.situacao !== "AGUARDANDO_EMAIL") return null;
  if (!pedido.token_expira_em || pedido.token_expira_em <= agora) return null;
  return pedido;
}

/**
 * O clique em "Confirmar" (POST: abrir o link não confirma). Desde 24/10/2026
 * a conta é LIBERADA na hora, sem a conferência da equipe: quem cuida das
 * contas bloqueia ou exclui depois, em "Contas do Cadastre-se". Se o e-mail
 * entrou no sistema nesse meio-tempo, o pedido é descartado.
 */
export async function confirmar_email(
  tx: Executor,
  token: string,
  ip: string | null,
  base_url: string,
  agora: Date = new Date(),
): Promise<"liberada" | "descartado" | null> {
  const achado = await pedido_a_confirmar(tx, token, agora);
  if (!achado) return null;
  const [pedido] = await tx.select().from(tabela).where(eq(tabela.id, achado.id)).for("update");
  if (!pedido || pedido.situacao !== "AGUARDANDO_EMAIL") return null;
  if (await _ja_existe(tx, pedido.email_normalizado)) {
    await _descartar(tx, eq(tabela.id, pedido.id));
    return "descartado";
  }
  const [confirmado] = await tx
    .update(tabela)
    .set({ situacao: "PENDENTE", email_confirmado_em: agora, token_hash: null, token_expira_em: null })
    .where(eq(tabela.id, pedido.id))
    .returning();
  await auditoria.registrar(tx, {
    entidade: "pedido_conta",
    entidade_id: pedido.id,
    tipo_evento: PEDIDO_DE_CONTA_RECEBIDO,
    descricao: `Pedido de conta nº ${pedido.id} (${ROTULO_VINCULO[pedido.vinculo as Vinculo].toLowerCase()}) recebido pelo Cadastre-se, com o e-mail confirmado.`,
    usuario_nome: ativar_acesso.ATOR,
    ip,
  });
  await _liberar(tx, confirmado!, null, base_url);
  return "liberada";
}

export async function fila(tx: Executor): Promise<{ pendentes: Pedido[]; decididos: Pedido[] }> {
  const pendentes = await tx.select().from(tabela).where(eq(tabela.situacao, "PENDENTE")).orderBy(tabela.id);
  const decididos = await tx
    .select()
    .from(tabela)
    .where(sql`${tabela.situacao} IN ('APROVADO','RECUSADO')`)
    .orderBy(desc(tabela.decidido_em))
    .limit(30);
  return { pendentes, decididos };
}

export async function contar_pendentes(tx: Executor): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(tabela).where(eq(tabela.situacao, "PENDENTE"));
  return Number(r?.n ?? 0);
}

async function _pendente(tx: Executor, id: number): Promise<Pedido> {
  const [pedido] = await tx.select().from(tabela).where(eq(tabela.id, id)).for("update");
  if (!pedido || pedido.situacao === "DESCARTADO") throw new DecisaoRecusada("Pedido não encontrado.");
  if (pedido.situacao !== "PENDENTE") throw new DecisaoRecusada(`O pedido nº ${id} já foi decidido.`);
  return pedido;
}

async function _fechar_pendencia(tx: Executor, pedido: Pedido, motivo: string): Promise<void> {
  const [p] = await tx.select().from(tabela_pendencia).where(eq(tabela_pendencia.chave, `pedido_conta:${pedido.id}`));
  if (p && !p.concluida) await pendencias.concluir_pela_rotina(tx, p, motivo);
}

/** Quem libera a conta: a pessoa da equipe, ou a liberação automática do Cadastre-se. */
export const ATOR_AUTOMATICO = "liberação automática do Cadastre-se";

/**
 * Cria a conta do pedido: a senha escolhida (o pedido de antes de 24/10/2026,
 * sem ela, nasce sem senha e recebe o link para defini-la), o perfil do
 * vínculo e nunca servidor. `ator` nulo é a liberação automática.
 */
async function _liberar(tx: Executor, pedido: Pedido, ator: UsuarioAtual | null, base_url: string): Promise<Pedido> {
  const quem = ator ? { usuario: ator } : { usuario_nome: ATOR_AUTOMATICO };
  const alvo = pedido.email_normalizado;
  const [conta_igual] = await tx
    .select({ id: tabela_usuario.id })
    .from(tabela_usuario)
    .where(sql`lower(${tabela_usuario.email}) = ${alvo} OR lower(${tabela_usuario.login}) = ${alvo}`)
    .limit(1);
  if (conta_igual) throw new DecisaoRecusada("Já existe uma conta com este e-mail: recuse o pedido e oriente a pessoa a usar \"Esqueci minha senha\".");
  const [servidor_igual] = await tx
    .select({ id: tabela_servidor.id })
    .from(tabela_servidor)
    .where(sql`lower(btrim(${tabela_servidor.email})) = ${alvo}`)
    .limit(1);
  if (servidor_igual) throw new DecisaoRecusada("Este e-mail é de um servidor do cadastro: a conta dele é a de servidor. Recuse o pedido.");
  const vinculo = pedido.vinculo as Vinculo;
  const codigo = PERFIL_POR_VINCULO[vinculo]!;
  const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.codigo, codigo));
  if (!perfil || !perfil.ativo) throw new Error(`perfil '${codigo}' ausente ou inativo: o banco não foi semeado`);
  const [conta] = await tx
    .insert(tabela_usuario)
    .values({
      login: autenticacao.login_do_email(pedido.email),
      nome: pedido.nome,
      email: pedido.email,
      senha_hash: pedido.senha_hash ?? ativar_acesso.SEM_SENHA,
      servidor_id: null,
      precisa_trocar_senha: false,
    })
    .returning();
  await tx.insert(atribuicao).values({
    usuario_id: conta!.id,
    perfil_id: perfil.id,
    vigencia_inicio: hoje_iso(),
    ato_normativo: ator
      ? `Pedido de conta nº ${pedido.id} conferido pela equipe (${vinculo.toLowerCase()})`
      : `Pedido de conta nº ${pedido.id} com o e-mail confirmado, liberado automaticamente (${vinculo.toLowerCase()})`,
    concedido_por: ator?.id ?? null,
  });
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta!.id,
    tipo_evento: "USUARIO_CRIADO",
    descricao: `Conta '${conta!.login}' criada pelo pedido de conta nº ${pedido.id}${pedido.senha_hash ? ", com a senha escolhida no pedido" : ", sem senha utilizável"}.`,
    ...quem,
  });
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta!.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao: `Perfil ${codigo} concedido a '${conta!.login}' pelo vínculo do pedido de conta nº ${pedido.id} (${vinculo.toLowerCase()}).`,
    ...quem,
  });
  const [feito] = await tx
    .update(tabela)
    .set({ situacao: "APROVADO", decidido_por: ator?.id ?? null, decidido_em: new Date(), usuario_id: conta!.id, senha_hash: null })
    .where(eq(tabela.id, pedido.id))
    .returning();
  await auditoria.registrar(tx, {
    entidade: "pedido_conta",
    entidade_id: pedido.id,
    tipo_evento: PEDIDO_DE_CONTA_APROVADO,
    descricao: `Pedido de conta nº ${pedido.id} ${ator ? "aprovado" : "liberado automaticamente"}: conta nº ${conta!.id} criada.`,
    ...quem,
  });
  await _fechar_pendencia(tx, pedido, "pedido de conta aprovado");
  if (!pedido.senha_hash) {
    await ativar_acesso.emitir_link_da_conta(tx, conta!, base_url, { validade_ms: VALIDADE_DO_LINK_MS, corpo: corpo_da_aprovacao });
  } else if (ator) {
    // a liberação automática acontece na tela da própria pessoa, que já lê
    // "conta liberada"; o e-mail é para quem esperava a equipe
    await email.enfileirar(tx, {
      tipo: TIPO_APROVADO,
      destinatario: pedido.email,
      assunto: ativar_acesso.ASSUNTO,
      corpo: corpo_da_liberacao(base_url),
      expira_em: new Date(Date.now() + 72 * 3_600_000),
    });
  }
  return feito!;
}

/** Aprova o pedido que ficou na fila (os de antes da liberação automática). */
export async function aprovar(tx: Executor, usuario: UsuarioAtual, id: number, base_url: string): Promise<Pedido> {
  usuario.exigir("usuario.criar_conta");
  return _liberar(tx, await _pendente(tx, id), usuario, base_url);
}

export async function recusar(tx: Executor, usuario: UsuarioAtual, id: number, motivo: string): Promise<Pedido> {
  usuario.exigir("usuario.criar_conta");
  const pedido = await _pendente(tx, id);
  const texto = motivo.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!texto) throw new DecisaoRecusada("Escreva o motivo da recusa (fica no registro; não vai no e-mail).");
  const [feito] = await tx
    .update(tabela)
    .set({ situacao: "RECUSADO", decidido_por: usuario.id, decidido_em: new Date(), motivo: texto, senha_hash: null })
    .where(eq(tabela.id, pedido.id))
    .returning();
  await auditoria.registrar(tx, {
    entidade: "pedido_conta",
    entidade_id: pedido.id,
    tipo_evento: PEDIDO_DE_CONTA_RECUSADO,
    descricao: `Pedido de conta nº ${pedido.id} recusado.`,
    usuario,
  });
  await _fechar_pendencia(tx, pedido, "pedido de conta recusado");
  await email.enfileirar(tx, {
    tipo: TIPO_RECUSA,
    destinatario: pedido.email,
    assunto: ativar_acesso.ASSUNTO,
    corpo: corpo_da_recusa(),
    expira_em: new Date(Date.now() + 72 * 3_600_000),
  });
  return feito!;
}

/** Apaga os pedidos passado o prazo (os decididos, os descartados e os esquecidos na fila). */
export async function expurgar(tx: Executor, agora: Date = new Date(), dias = DIAS_DO_PEDIDO): Promise<number> {
  const limite = new Date(agora.getTime() - dias * 86_400_000);
  const velhos = await tx.select().from(tabela).where(lt(tabela.criado_em, limite));
  for (const p of velhos) if (p.situacao === "PENDENTE") await _fechar_pendencia(tx, p, "pedido de conta expirou sem decisão");
  const r = await tx.delete(tabela).where(lt(tabela.criado_em, limite)).returning({ id: tabela.id });
  // o que ninguém confirmou sai antes, com a senha guardada
  const sem_confirmacao = await tx
    .delete(tabela)
    .where(
      and(
        eq(tabela.situacao, "AGUARDANDO_EMAIL"),
        lt(tabela.criado_em, new Date(agora.getTime() - DIAS_SEM_CONFIRMACAO * 86_400_000)),
      ),
    )
    .returning({ id: tabela.id });
  return r.length + sem_confirmacao.length;
}

// ---------------------------------------------------------------------
// Contas do Cadastre-se: bloquear, desbloquear, excluir (24/10/2026)
// ---------------------------------------------------------------------
export const CONTA_BLOQUEADA = "USUARIO_INATIVADO";
export const CONTA_DESBLOQUEADA = "USUARIO_ATIVADO";
export const CONTA_EXCLUIDA = "USUARIO_EXCLUIDO";

export interface ContaExterna {
  id: number;
  nome: string;
  email: string;
  ativo: boolean;
  vinculo: Vinculo;
  organizacao: string | null;
  criado_em: Date | null;
}

/** As contas de terceirizado e discente (do Cadastre-se ou criadas pela equipe), mais novas primeiro. */
export async function contas_externas(tx: Executor): Promise<ContaExterna[]> {
  const linhas = await tx
    .select({
      id: tabela_usuario.id,
      nome: tabela_usuario.nome,
      email: tabela_usuario.email,
      ativo: tabela_usuario.ativo,
      codigo: tabela_perfil.codigo,
      criado_em: tabela_usuario.criado_em,
    })
    .from(tabela_usuario)
    .innerJoin(atribuicao, eq(atribuicao.usuario_id, tabela_usuario.id))
    .innerJoin(tabela_perfil, eq(tabela_perfil.id, atribuicao.perfil_id))
    .where(and(isNull(tabela_usuario.servidor_id), inArray(tabela_perfil.codigo, [...PERFIS_EXTERNOS]), isNull(atribuicao.vigencia_fim)))
    .orderBy(desc(tabela_usuario.id))
    .limit(300);
  const ids = [...new Set(linhas.map((l) => l.id))];
  const pedidos = ids.length
    ? await tx.select({ usuario_id: tabela.usuario_id, organizacao: tabela.organizacao }).from(tabela).where(inArray(tabela.usuario_id, ids))
    : [];
  const org = new Map(pedidos.map((p) => [p.usuario_id, p.organizacao]));
  const vistas = new Set<number>();
  const contas: ContaExterna[] = [];
  for (const l of linhas) {
    if (vistas.has(l.id)) continue;
    vistas.add(l.id);
    contas.push({
      id: l.id,
      nome: l.nome,
      email: l.email,
      ativo: l.ativo,
      vinculo: l.codigo === "discente" ? "DISCENTE" : "TERCEIRIZADO",
      organizacao: org.get(l.id) ?? null,
      criado_em: l.criado_em ?? null,
    });
  }
  return contas;
}

/** Só a conta de terceirizado ou discente, sem servidor, se bloqueia ou exclui por aqui. */
async function _conta_externa(tx: Executor, id: number) {
  const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, id)).for("update");
  if (!conta) throw new DecisaoRecusada("Conta não encontrada.");
  const { perfis } = await perfis_vigentes(tx, conta.id, null, { incluir_futuras: true });
  const externa = perfis.some((p) => PERFIS_EXTERNOS.includes(p));
  const outros = perfis.filter((p) => !PERFIS_EXTERNOS.includes(p));
  if (conta.servidor_id !== null || !externa || outros.length) {
    throw new DecisaoRecusada("Por aqui só se cuida de conta de terceirizado ou discente. As outras ficam em Usuários.");
  }
  return conta;
}

export async function bloquear(tx: Executor, usuario: UsuarioAtual, id: number, bloquear_sim = true): Promise<string> {
  usuario.exigir("usuario.criar_conta");
  const conta = await _conta_externa(tx, id);
  if (conta.ativo === !bloquear_sim) return conta.nome;
  await tx.update(tabela_usuario).set({ ativo: !bloquear_sim }).where(eq(tabela_usuario.id, conta.id));
  if (bloquear_sim) await autenticacao.revogar_do_usuario(tx, conta.id);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: bloquear_sim ? CONTA_BLOQUEADA : CONTA_DESBLOQUEADA,
    descricao: `Conta '${conta.login}' ${bloquear_sim ? "bloqueada (inativada)" : "desbloqueada"} em Contas do Cadastre-se.`,
    usuario,
  });
  return conta.nome;
}

function _violou_chave(erro: unknown): boolean {
  for (let e: any = erro; e; e = e.cause) if (e.code === "23503") return true;
  return false;
}

/**
 * Exclui a conta que ainda não tem registro no sistema (inscrição, comunicação,
 * certificado, trilha). Com registro, ela não se apaga — a trilha é encadeada e
 * os registros apontam para ela —, e é BLOQUEADA no lugar.
 */
export async function excluir(tx: Executor, usuario: UsuarioAtual, id: number): Promise<{ resultado: "excluida" | "bloqueada"; nome: string }> {
  usuario.exigir("usuario.criar_conta");
  const conta = await _conta_externa(tx, id);
  try {
    await tx.transaction(async (sp) => {
      await sp.delete(atribuicao).where(eq(atribuicao.usuario_id, conta.id));
      await sp.delete(tabela_sessao).where(eq(tabela_sessao.usuario_id, conta.id));
      await sp.update(tabela).set({ usuario_id: null }).where(eq(tabela.usuario_id, conta.id));
      await sp.delete(tabela_usuario).where(eq(tabela_usuario.id, conta.id));
    });
  } catch (erro) {
    if (!_violou_chave(erro)) throw erro;
    await bloquear(tx, usuario, conta.id, true);
    return { resultado: "bloqueada", nome: conta.nome };
  }
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: CONTA_EXCLUIDA,
    // o número da conta, sem nome nem e-mail: a conta e o dado dela saíram
    descricao: `Conta nº ${conta.id} (terceirizado ou discente, sem registros no sistema) excluída em Contas do Cadastre-se.`,
    usuario,
  });
  return { resultado: "excluida", nome: conta.nome };
}

