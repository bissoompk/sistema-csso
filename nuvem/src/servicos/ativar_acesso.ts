/**
 * "Ativar meu acesso" e "Esqueci minha senha" (23/10/2026): a tela pública em
 * que o SERVIDOR cria a própria conta ou redefine a senha, sem passar pela
 * equipe. É o mesmo desenho de `acesso_participante.ts` e de
 * `aviso_cadastro_existente.ts`:
 *
 * **Sem oráculo.** A tela responde a MESMA frase (`RESPOSTA_PADRAO`) a todo
 * pedido, com um tempo de resposta que não baixa de um piso (`ajuste.piso_ms`).
 * De fora não se sabe se o SIAPE existe, se o e-mail confere, se há conta,
 * se ela está inativa nem se o envio de e-mail está ligado.
 *
 * **Quem prova ser o dono é a caixa do e-mail do CADASTRO.** O servidor
 * informa SIAPE + e-mail institucional; só quando os dois batem com o cadastro
 * `servidor` o sistema enfileira (pela caixa `email_saida`) um link de uso
 * único, válido por 1 h, SÓ para o e-mail que está no cadastro (nunca o
 * digitado). O banco guarda o SHA-256 do token. O texto do e-mail não leva
 * nome, SIAPE nem qualquer dado do cadastro.
 *
 * **Tetos contados no banco** (a instância do Netlify some a cada minuto):
 * por endereço de rede (`PEDIDOS_POR_HORA_POR_IP`, na tabela `ativacao_acesso`)
 * e por destinatário (`ENVIOS_POR_HORA`/`ENVIOS_POR_DIA`, na própria
 * `email_saida`). Sem captcha. Passado o teto, a tela responde igual e nada sai.
 *
 * **O link só define a senha.** Abri-lo (GET) não gasta o token — leitor de
 * e-mail pré-visualiza links; gasta o POST da senha nova. O que o link faz é
 * decidido de novo na hora de gravar (`decidir`):
 *
 * - não há conta: cria (login = e-mail do cadastro, perfil de titular
 *   `servidor_consulta`, ligada ao servidor);
 * - há conta ATIVA: só redefine a senha (revoga as sessões, zera bloqueio e
 *   tentativas) e NUNCA concede perfil — conta de equipe redefine a dela e
 *   segue com o que tinha;
 * - conta INATIVA, conta de Administrador do sistema ou de superintendente
 *   (ou com `perfil.conceder`), ou conta de outro servidor: não é atendida por
 *   aqui. O e-mail diz, neutro, "procure a equipe".
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  ativacao_acesso as tabela,
  atribuicao,
  email_saida,
  perfil as tabela_perfil,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { normalizar_email } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as autenticacao from "./autenticacao.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as governanca from "./governanca.js";
import { PERFIS_EXTERNOS, TOPO_DA_HIERARQUIA, eh_conta_de_governo, perfis_vigentes } from "./rbac.js";

export const CAMINHO = "/ativar-acesso";
export const VALIDADE_MS = 3_600_000;
export const TIPO_LINK = "ATIVAR_ACESSO";
export const TIPO_NEUTRO = "ATIVAR_ACESSO_NEUTRO";
/** Os e-mails que contam para o teto por destinatário (inclui o neutro do Cadastre-se). */
export const TIPOS: readonly string[] = [TIPO_LINK, TIPO_NEUTRO, "PEDIDO_CONTA_NEUTRO"];
export const CAMINHO_ESQUECI = "/esqueci-senha";
export const PEDIDOS_POR_HORA_POR_IP = 8;
export const ENVIOS_POR_HORA = 2;
export const ENVIOS_POR_DIA = 5;
export const DIAS_DO_REGISTRO = 7;
export const PERFIL_DO_TITULAR = "servidor_consulta";
export const ATOR = "o próprio titular";
/** Cadastro que já saiu do quadro: não ganha conta nova por aqui. */
const SITUACOES_FORA = ["APOSENTADO", "EXONERADO"];

/**
 * Valor de `usuario.senha_hash` da conta criada no cadastro do servidor, antes
 * de ele escolher a senha. Não começa com `$argon2`: `conferir_senha` o recusa
 * sem tentar verificar, então nenhuma senha digitada entra nessa conta.
 */
export const SEM_SENHA = "!sem-senha";
export const ACESSO_CRIADO_NO_CADASTRO = "ACESSO_CRIADO_NO_CADASTRO";
export const ACESSO_ENCERRADO_NA_SAIDA = "ACESSO_ENCERRADO_NA_SAIDA";
export const ACESSO_MANTIDO_NA_SAIDA = "ACESSO_MANTIDO_NA_SAIDA";
export const ACESSO_EMAIL_ACOMPANHOU_CADASTRO = "ACESSO_EMAIL_ACOMPANHOU_CADASTRO";

export const PEDIDO_DE_ACESSO_RECUSADO = "PEDIDO_DE_ACESSO_RECUSADO";
export const ACESSO_ATIVADO = "ACESSO_ATIVADO";
export const SENHA_REDEFINIDA_POR_LINK = "SENHA_REDEFINIDA_POR_LINK";

/** O piso do tempo de resposta do pedido; o teste o baixa. */
export const ajuste = { piso_ms: 1200 };

export const RESPOSTA_PADRAO =
  "Se os dados conferem com o cadastro de servidores, enviamos ao e-mail institucional cadastrado " +
  "um link para definir a senha, válido por 1 hora e de uso único. Confira também a caixa de spam. " +
  "Se não chegar, procure a equipe responsável.";

export const RESPOSTA_ESQUECI =
  "Se este e-mail é o de uma conta do Sistema SISA, enviamos para ele um link para definir a senha, " +
  "válido por 1 hora e de uso único. Confira também a caixa de spam. Se não chegar, procure a equipe responsável.";

export class DadosInvalidos extends Error {}
export class LinkInvalido extends Error {}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Espera o que falta para `ajuste.piso_ms` desde `inicio` (resposta com tempo constante). */
export async function esperar_piso(inicio: number): Promise<void> {
  const falta = ajuste.piso_ms - (Date.now() - inicio);
  if (falta > 0) await new Promise((r) => setTimeout(r, falta));
}

type Servidor = typeof tabela_servidor.$inferSelect;
type Conta = typeof tabela_usuario.$inferSelect;

export type Decisao =
  | { tipo: "criar" }
  | { tipo: "redefinir"; conta: Conta }
  | { tipo: "recusar"; motivo: string; conta?: Conta };

/** Quem o link pode alcançar, ou o motivo de não alcançar. */
export async function decidir(tx: Executor, servidor: Servidor): Promise<Decisao> {
  const alvo = normalizar_email(servidor.email);
  const contas = await tx
    .select()
    .from(tabela_usuario)
    .where(
      sql`${tabela_usuario.servidor_id} = ${servidor.id}
        OR lower(${tabela_usuario.email}) = ${alvo} OR lower(${tabela_usuario.login}) = ${alvo}`,
    );
  if (!contas.length) {
    return SITUACOES_FORA.includes(servidor.situacao)
      ? { tipo: "recusar", motivo: "cadastro de servidor que saiu do quadro" }
      : { tipo: "criar" };
  }
  if (contas.length > 1) return { tipo: "recusar", motivo: "mais de uma conta ligada ao mesmo servidor ou e-mail" };
  const conta = contas[0]!;
  if (conta.servidor_id !== null && conta.servidor_id !== servidor.id) {
    return { tipo: "recusar", motivo: "o e-mail pertence à conta de outro servidor", conta };
  }
  const { perfis } = await perfis_vigentes(tx, conta.id, null, { incluir_futuras: true });
  // a conta de terceirizado ou discente com o e-mail do servidor não é dele:
  // o link do servidor não a adota (quem decide é a equipe, em Usuários)
  if (conta.servidor_id === null && perfis.some((p) => PERFIS_EXTERNOS.includes(p))) {
    return { tipo: "recusar", motivo: "o e-mail do servidor é o de uma conta de terceirizado ou discente", conta };
  }
  return decidir_conta(tx, conta);
}

/** A conta que o link alcança: ativa e fora da administração. */
export async function decidir_conta(tx: Executor, conta: Conta): Promise<Decisao> {
  if (!conta.ativo) return { tipo: "recusar", motivo: "conta inativa (quem decide é a equipe)", conta };
  const { perfis, permissoes } = await perfis_vigentes(tx, conta.id, null, { incluir_futuras: true });
  if (perfis.some((p) => TOPO_DA_HIERARQUIA.includes(p)) || permissoes.has("perfil.conceder")) {
    return { tipo: "recusar", motivo: "conta de administração (outro administrador ou a linha de comando redefine)", conta };
  }
  return { tipo: "redefinir", conta };
}

const ASSINATURA = "Superintendência Integrada de Saúde (Sisa) — UFVJM\nMensagem enviada pelo Sistema SISA.\n";
export const ASSUNTO = "Acesso ao Sistema SISA · UFVJM";

export function corpo_do_link(link: string, expira_em: Date): string {
  return (
    "Olá.\n\n" +
    "Alguém (provavelmente você) pediu para ativar o acesso ou redefinir a senha do Sistema SISA " +
    "com este e-mail institucional. Para definir a senha, use o link abaixo até " +
    `${datas_br.numerica(datas_br.hoje(expira_em))}, às ` +
    `${expira_em.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}. ` +
    "Ele serve uma vez só:\n\n" +
    `${link}\n\n` +
    "Se não foi você, ignore esta mensagem: sem o link, nada muda.\n\n" +
    ASSINATURA
  );
}

export function corpo_neutro(): string {
  return (
    "Olá.\n\n" +
    "Recebemos um pedido de ativação de acesso ou de redefinição de senha do Sistema SISA com este " +
    "e-mail, mas ele não pode ser atendido por este caminho. Procure a equipe responsável pelo sistema " +
    "(Sisa/UFVJM).\n\n" +
    "Se não foi você, ignore esta mensagem.\n\n" +
    ASSINATURA
  );
}

export async function no_teto_do_destinatario(tx: Executor, para: string, agora: Date): Promise<boolean> {
  const contar = async (ms: number) => {
    const [r] = await tx
      .select({ n: count() })
      .from(email_saida)
      .where(
        and(
          inArray(email_saida.tipo, [...TIPOS]),
          sql`lower(${email_saida.destinatario}) = ${para.trim().toLowerCase()}`,
          gt(email_saida.criado_em, new Date(agora.getTime() - ms)),
        ),
      );
    return Number(r?.n ?? 0);
  };
  return (await contar(3_600_000)) >= ENVIOS_POR_HORA || (await contar(86_400_000)) >= ENVIOS_POR_DIA;
}

/**
 * O pedido. Não devolve nada de propósito: a rota responde sempre
 * `RESPOSTA_PADRAO`. Lança `DadosInvalidos` só para o que nem parece SIAPE ou
 * e-mail (erro de digitação, igual para todo mundo).
 */
export async function pedir(
  tx: Executor,
  d: { siape: string; email: string },
  ip: string | null,
  base_url: string,
  agora: Date = new Date(),
): Promise<void> {
  const siape = d.siape.trim();
  if (!/^\d{7}$/.test(siape)) throw new DadosInvalidos("Digite o SIAPE com 7 dígitos.");
  if (!email.email_valido(d.email)) throw new DadosInvalidos("Digite o e-mail institucional completo.");
  const marcar = await _registrar_pedido(tx, ip, agora);
  if (!marcar) return;
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, siape));
  if (!servidor) return;
  await _atender_servidor(tx, servidor, d.email, ip, base_url, agora, marcar);
}

type Marcar = (v: Partial<typeof tabela.$inferInsert>) => Promise<unknown>;

/** O teto por endereço de rede; dentro dele, a linha do pedido (e como marcá-la). */
async function _registrar_pedido(tx: Executor, ip: string | null, agora: Date): Promise<Marcar | null> {
  const [recentes] = await tx
    .select({ n: count() })
    .from(tabela)
    .where(
      and(
        ip === null ? isNull(tabela.ip) : eq(tabela.ip, ip),
        gt(tabela.criado_em, new Date(agora.getTime() - 3_600_000)),
      ),
    );
  if (Number(recentes?.n ?? 0) >= PEDIDOS_POR_HORA_POR_IP) return null;
  const [registro] = await tx.insert(tabela).values({ ip, criado_em: agora }).returning({ id: tabela.id });
  return (v) => tx.update(tabela).set(v).where(eq(tabela.id, registro!.id));
}

async function _neutro(tx: Executor, para: string, agora: Date): Promise<void> {
  await email.enfileirar(tx, {
    tipo: TIPO_NEUTRO,
    destinatario: para,
    assunto: ASSUNTO,
    corpo: corpo_neutro(),
    expira_em: new Date(agora.getTime() + 24 * 3_600_000),
  });
}

async function _atender_servidor(
  tx: Executor,
  servidor: Servidor,
  digitado: string,
  ip: string | null,
  base_url: string,
  agora: Date,
  marcar: Marcar,
): Promise<void> {
  const cadastrado = (servidor.email ?? "").trim();
  if (!cadastrado || !email.email_valido(cadastrado)) {
    await marcar({ servidor_id: servidor.id, resultado: "SEM_EMAIL" });
    return;
  }
  if (normalizar_email(cadastrado) !== normalizar_email(digitado)) return;
  if (await no_teto_do_destinatario(tx, cadastrado, agora)) return;

  const decisao = await decidir(tx, servidor);
  if (decisao.tipo === "recusar") {
    await marcar({ servidor_id: servidor.id, resultado: "NEUTRO" });
    await _neutro(tx, cadastrado, agora);
    await auditoria.registrar(tx, {
      entidade: decisao.conta ? "usuario" : "servidor",
      entidade_id: decisao.conta ? decisao.conta.id : servidor.id,
      tipo_evento: PEDIDO_DE_ACESSO_RECUSADO,
      // o motivo e nada do cadastro: nem nome, nem SIAPE, nem e-mail
      descricao: `Pedido de ativação de acesso não atendido por esta via: ${decisao.motivo}. A tela respondeu como a todos.`,
      usuario_nome: ATOR,
      ip,
    });
    return;
  }
  const token = randomBytes(24).toString("base64url");
  const expira_em = new Date(agora.getTime() + VALIDADE_MS);
  await marcar({ token_hash: _hash(token), servidor_id: servidor.id, resultado: "LINK", expira_em });
  await email.enfileirar(tx, {
    tipo: TIPO_LINK,
    destinatario: cadastrado,
    assunto: ASSUNTO,
    corpo: corpo_do_link(`${base_url}${CAMINHO}/${token}`, expira_em),
    expira_em,
  });
}

/**
 * "Esqueci minha senha" só com o e-mail, para qualquer conta (23/10/2026): a
 * do terceirizado e a do discente não têm SIAPE. O link vai ao e-mail DA
 * CONTA. E-mail sem conta, mas de um servidor do cadastro, segue o caminho do
 * servidor (é o primeiro acesso dele). Mesma resposta, mesmos tetos.
 */
export async function pedir_por_email(
  tx: Executor,
  digitado: string,
  ip: string | null,
  base_url: string,
  agora: Date = new Date(),
): Promise<void> {
  if (!email.email_valido(digitado.trim())) throw new DadosInvalidos("Digite o e-mail completo.");
  const marcar = await _registrar_pedido(tx, ip, agora);
  if (!marcar) return;
  const alvo = normalizar_email(digitado);
  const contas = await tx
    .select()
    .from(tabela_usuario)
    .where(sql`lower(${tabela_usuario.email}) = ${alvo} OR lower(${tabela_usuario.login}) = ${alvo}`);
  if (contas.length > 1) return;
  const conta = contas[0];
  if (!conta) {
    const servidores = await tx.select().from(tabela_servidor).where(sql`lower(btrim(${tabela_servidor.email})) = ${alvo}`);
    if (servidores.length === 1) await _atender_servidor(tx, servidores[0]!, digitado, ip, base_url, agora, marcar);
    return;
  }
  if (conta.servidor_id !== null) {
    // a conta de servidor segue a regra do servidor (o e-mail do cadastro)
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, conta.servidor_id));
    if (servidor && normalizar_email(servidor.email ?? "") === alvo) {
      await _atender_servidor(tx, servidor, digitado, ip, base_url, agora, marcar);
      return;
    }
  }
  if (!email.email_valido(conta.email) || (await no_teto_do_destinatario(tx, conta.email, agora))) return;
  const decisao = await decidir_conta(tx, conta);
  if (decisao.tipo === "recusar") {
    await marcar({ usuario_id: conta.id, resultado: "NEUTRO" });
    await _neutro(tx, conta.email, agora);
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: conta.id,
      tipo_evento: PEDIDO_DE_ACESSO_RECUSADO,
      descricao: `Pedido de redefinição de senha não atendido por esta via: ${decisao.motivo}. A tela respondeu como a todos.`,
      usuario_nome: ATOR,
      ip,
    });
    return;
  }
  await emitir_link_da_conta(tx, conta, base_url, { agora, marcar });
}

/**
 * O link de uso único para a CONTA definir a senha, no e-mail dela. Serve ao
 * "Esqueci minha senha" e à conta aprovada no Cadastre-se (que espera mais:
 * `validade_ms` e o texto próprio).
 */
export async function emitir_link_da_conta(
  tx: Executor,
  conta: Pick<Conta, "id" | "email">,
  base_url: string,
  o: { validade_ms?: number; corpo?: (link: string, expira_em: Date) => string; agora?: Date; marcar?: Marcar } = {},
): Promise<void> {
  const agora = o.agora ?? new Date();
  const token = randomBytes(24).toString("base64url");
  const expira_em = new Date(agora.getTime() + (o.validade_ms ?? VALIDADE_MS));
  const valores = { token_hash: _hash(token), usuario_id: conta.id, resultado: "LINK", expira_em };
  if (o.marcar) await o.marcar(valores);
  else await tx.insert(tabela).values({ ...valores, ip: null, criado_em: agora });
  await email.enfileirar(tx, {
    tipo: TIPO_LINK,
    destinatario: conta.email,
    assunto: ASSUNTO,
    corpo: (o.corpo ?? corpo_do_link)(`${base_url}${CAMINHO}/${token}`, expira_em),
    expira_em,
  });
}

export type Origem = Pick<auditoria.DadosRegistro, "usuario" | "usuario_nome" | "ip" | "user_agent">;

export type ResultadoDoAcesso = "criada" | "ja_tem_conta" | "sem_email" | "fora_do_quadro" | "recusada";

async function _perfil_do_titular(tx: Executor) {
  const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.codigo, PERFIL_DO_TITULAR));
  if (!perfil || !perfil.ativo) throw new Error(`perfil '${PERFIL_DO_TITULAR}' ausente ou inativo: o banco não foi semeado`);
  return perfil;
}

/**
 * O e-mail do cadastro foi corrigido antes de o titular ativar o acesso: a conta
 * (ainda sem senha) acompanha, e o login continua sendo o e-mail. Conta com
 * senha NÃO é tocada (o titular já entra com o login que tem; quem muda é ele,
 * em «Meus dados»), nem a que colidiria com outra conta.
 */
async function _acompanhar_email(tx: Executor, conta: Conta, cadastrado: string, origem: Origem): Promise<void> {
  if (conta.senha_hash !== SEM_SENHA || normalizar_email(conta.email ?? "") === normalizar_email(cadastrado)) return;
  const alvo = normalizar_email(cadastrado);
  const [outra] = await tx
    .select({ id: tabela_usuario.id })
    .from(tabela_usuario)
    .where(sql`${tabela_usuario.id} <> ${conta.id} AND (lower(${tabela_usuario.email}) = ${alvo} OR lower(${tabela_usuario.login}) = ${alvo})`)
    .limit(1);
  if (outra) return;
  await tx
    .update(tabela_usuario)
    .set({ email: cadastrado, login: autenticacao.login_do_email(cadastrado) })
    .where(eq(tabela_usuario.id, conta.id));
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: ACESSO_EMAIL_ACOMPANHOU_CADASTRO,
    descricao: "E-mail e login da conta, ainda sem senha, acompanharam a correção do e-mail no cadastro do servidor.",
    ...origem,
  });
}

/**
 * O servidor ativo com e-mail institucional passa a ter conta (22/10/2026: não
 * há separação entre servidor e conta). A conta nasce SEM senha utilizável
 * (`SEM_SENHA`); o titular a define por "Ativar meu acesso" ou "Esqueci minha
 * senha". Nenhum e-mail sai daqui. Quem já tem conta (ou cujo e-mail já é de
 * outra) não é tocado.
 */
export async function garantir_acesso(tx: Executor, servidor: Servidor, origem: Origem): Promise<ResultadoDoAcesso> {
  const cadastrado = (servidor.email ?? "").trim();
  if (!cadastrado || !email.email_valido(cadastrado)) return "sem_email";
  if (servidor.situacao !== "ATIVO") return "fora_do_quadro";
  const decisao = await decidir(tx, servidor);
  if (decisao.tipo === "redefinir") {
    await _acompanhar_email(tx, decisao.conta, cadastrado, origem);
    return "ja_tem_conta";
  }
  if (decisao.tipo === "recusar") return decisao.conta ? "ja_tem_conta" : "recusada";
  const perfil = await _perfil_do_titular(tx);
  const [conta] = await tx
    .insert(tabela_usuario)
    .values({
      login: autenticacao.login_do_email(cadastrado),
      nome: servidor.nome,
      email: cadastrado,
      senha_hash: SEM_SENHA,
      servidor_id: servidor.id,
      precisa_trocar_senha: false,
    })
    .returning();
  await tx.insert(atribuicao).values({
    usuario_id: conta!.id,
    perfil_id: perfil.id,
    vigencia_inicio: hoje_iso(),
    ato_normativo: "Acesso criado no cadastro do servidor",
  });
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta!.id,
    tipo_evento: ACESSO_CRIADO_NO_CADASTRO,
    descricao:
      `Conta criada com o cadastro do servidor, com o perfil ${PERFIL_DO_TITULAR} e sem senha utilizável: ` +
      "o titular define a senha por 'Ativar meu acesso'. Nenhum e-mail foi enviado.",
    ...origem,
  });
  return "criada";
}

/**
 * O servidor saiu do quadro (aposentado ou exonerado): a conta dele é inativada
 * e as sessões, encerradas. Fica como está — e o motivo na trilha — a conta de
 * administração e a última que concede perfil: inativá-las tira o governo do
 * sistema, e isso é decisão de quem concede (`/usuarios`). Reativar é sempre
 * ato da equipe: voltar a ser ativo no cadastro não reativa a conta.
 */
export async function encerrar_acesso(
  tx: Executor,
  servidor: Servidor,
  origem: Origem,
): Promise<"inativada" | "sem_conta" | "ja_inativa" | "mantida"> {
  if (!SITUACOES_FORA.includes(servidor.situacao)) return "sem_conta";
  await governanca.travar(tx);
  const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.servidor_id, servidor.id)).limit(1);
  if (!conta) return "sem_conta";
  if (!conta.ativo) return "ja_inativa";
  const { permissoes: com_futuras } = await perfis_vigentes(tx, conta.id, null, { incluir_futuras: true });
  const { permissoes: hoje } = await perfis_vigentes(tx, conta.id);
  const ultima =
    hoje.has("perfil.conceder") && !(await governanca.contas_que_concedem(tx, { sem_conta: conta.id })).length;
  if (eh_conta_de_governo(com_futuras) || ultima) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: conta.id,
      tipo_evento: ACESSO_MANTIDO_NA_SAIDA,
      descricao:
        `O servidor ficou ${servidor.situacao === "APOSENTADO" ? "aposentado" : "exonerado"}, mas a conta é de ` +
        "administração (ou a última que concede perfil) e NÃO foi inativada: quem concede perfil decide em Usuários.",
      ...origem,
    });
    return "mantida";
  }
  await tx.update(tabela_usuario).set({ ativo: false }).where(eq(tabela_usuario.id, conta.id));
  const encerradas = await autenticacao.revogar_do_usuario(tx, conta.id);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: ACESSO_ENCERRADO_NA_SAIDA,
    descricao:
      `Conta inativada porque o servidor ficou ${servidor.situacao === "APOSENTADO" ? "aposentado" : "exonerado"} ` +
      `no cadastro; ${encerradas} sessão(ões) encerrada(s).`,
    ...origem,
  });
  await governanca.sincronizar_aviso_de_cobertura(tx);
  return "inativada";
}

export type SituacaoDoAcesso = "ATIVO" | "AGUARDANDO_ATIVACAO" | "SEM_ACESSO";

/** Para a ficha do servidor: o acesso dele ao sistema e, quando não há, por quê. */
export async function situacao_do_acesso(
  tx: Executor,
  servidor: Servidor,
): Promise<{ situacao: SituacaoDoAcesso; motivo: string | null }> {
  const [conta] = await tx
    .select()
    .from(tabela_usuario)
    .where(eq(tabela_usuario.servidor_id, servidor.id))
    .limit(1);
  if (conta) {
    if (!conta.ativo) return { situacao: "SEM_ACESSO", motivo: "conta inativa" };
    if (SITUACOES_FORA.includes(servidor.situacao)) {
      return { situacao: "ATIVO", motivo: "o servidor saiu do quadro e a conta segue ativa: quem concede perfil decide em Usuários" };
    }
    return conta.senha_hash === SEM_SENHA
      ? { situacao: "AGUARDANDO_ATIVACAO", motivo: null }
      : { situacao: "ATIVO", motivo: null };
  }
  const email_ok = !!(servidor.email ?? "").trim() && email.email_valido(servidor.email!.trim());
  if (!email_ok) return { situacao: "SEM_ACESSO", motivo: "falta o e-mail institucional no cadastro" };
  if (servidor.situacao !== "ATIVO") return { situacao: "SEM_ACESSO", motivo: "servidor não está ativo" };
  return { situacao: "SEM_ACESSO", motivo: "sem conta" };
}

async function _linha_valida(tx: Executor, token: string, agora: Date) {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.token_hash, _hash(token)));
  if (!linha || linha.usado_em !== null || !linha.expira_em || linha.expira_em <= agora) return null;
  // o link de troca de e-mail não define senha
  if ((linha.servidor_id === null && linha.usuario_id === null) || linha.email_novo !== null) {
    return null;
  }
  return linha;
}

/** O link ainda serve para definir a senha? (Abrir não o gasta.) */
export async function link_vale(tx: Executor, token: string, agora: Date = new Date()): Promise<boolean> {
  const linha = await _linha_valida(tx, token, agora);
  if (!linha) return false;
  if (linha.usuario_id !== null) {
    const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, linha.usuario_id));
    return !!conta && (await decidir_conta(tx, conta)).tipo !== "recusar";
  }
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, linha.servidor_id!));
  if (!servidor?.email) return false;
  return (await decidir(tx, servidor)).tipo !== "recusar";
}

export interface Contexto {
  ip?: string | null;
  user_agent?: string | null;
}

/**
 * Grava a senha. Erros de senha (`SenhaRecusada`) NÃO gastam o link; o link
 * vencido, já usado ou que deixou de valer é `LinkInvalido`.
 */
export async function definir_senha(
  tx: Executor,
  token: string,
  nova: string,
  confirmacao: string,
  contexto: Contexto = {},
  agora: Date = new Date(),
): Promise<"criada" | "redefinida"> {
  const linha = await _linha_valida(tx, token, agora);
  if (!linha) throw new LinkInvalido("link inválido ou vencido");
  if (nova !== confirmacao) throw new autenticacao.SenhaRecusada("A confirmação não confere.");
  const problemas = autenticacao.politica_de_senha(nova);
  if (problemas.length) throw new autenticacao.SenhaRecusada("Senha fraca: " + problemas.join("; "));
  if (linha.usuario_id !== null) return _definir_da_conta(tx, linha, nova, contexto, agora);
  // um servidor por vez: dois links do mesmo servidor não criam duas contas
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, linha.servidor_id!)).for("update");
  if (!servidor?.email) throw new LinkInvalido("link inválido ou vencido");
  const decisao = await decidir(tx, servidor);
  if (decisao.tipo === "recusar") throw new LinkInvalido("link inválido ou vencido");
  // o gasto é atômico: de dois envios do mesmo link, um só ganha
  const gasto = await tx
    .update(tabela)
    .set({ usado_em: agora_utc() })
    .where(and(eq(tabela.id, linha.id), isNull(tabela.usado_em)))
    .returning({ id: tabela.id });
  if (!gasto.length) throw new LinkInvalido("link inválido ou vencido");
  // os outros links do mesmo servidor caem junto
  await tx
    .update(tabela)
    .set({ usado_em: agora_utc() })
    .where(and(eq(tabela.servidor_id, servidor.id), isNull(tabela.usado_em)));

  const origem = { usuario_nome: ATOR, ip: contexto.ip ?? null, user_agent: contexto.user_agent ?? null };
  const senha_hash = await autenticacao.gerar_hash(nova);
  if (decisao.tipo === "criar") {
    const perfil = await _perfil_do_titular(tx);
    const cadastrado = servidor.email.trim();
    const [conta] = await tx
      .insert(tabela_usuario)
      .values({
        login: autenticacao.login_do_email(cadastrado),
        nome: servidor.nome,
        email: cadastrado,
        senha_hash,
        servidor_id: servidor.id,
        // a senha foi escolhida agora, pelo próprio dono: não é provisória
        precisa_trocar_senha: false,
      })
      .returning();
    await tx.insert(atribuicao).values({
      usuario_id: conta!.id,
      perfil_id: perfil.id,
      vigencia_inicio: hoje_iso(),
      ato_normativo: "Ativação do próprio acesso pelo titular (Ativar meu acesso)",
    });
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: conta!.id,
      tipo_evento: ACESSO_ATIVADO,
      descricao:
        "Conta criada pelo próprio titular, pelo link enviado ao e-mail do cadastro de servidores, " +
        `com o perfil ${PERFIL_DO_TITULAR}.`,
      ...origem,
    });
    return "criada";
  }
  await tx
    .update(tabela_usuario)
    .set({ senha_hash, precisa_trocar_senha: false, tentativas_falhas: 0, bloqueado_ate: null })
    .where(eq(tabela_usuario.id, decisao.conta.id));
  const encerradas = await autenticacao.revogar_do_usuario(tx, decisao.conta.id);
  if (decisao.conta.senha_hash === SEM_SENHA) {
    // primeira senha da conta criada no cadastro: é a ativação do acesso
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: decisao.conta.id,
      tipo_evento: ACESSO_ATIVADO,
      descricao: "Acesso ativado pelo próprio titular: definiu a primeira senha pelo link enviado ao e-mail do cadastro.",
      ...origem,
    });
    return "redefinida";
  }
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: decisao.conta.id,
    tipo_evento: SENHA_REDEFINIDA_POR_LINK,
    descricao:
      "Senha redefinida pelo próprio titular, pelo link enviado ao e-mail do cadastro de servidores; " +
      `bloqueio e tentativas zerados, ${encerradas} sessão(ões) encerrada(s). Nenhum perfil foi concedido.`,
    ...origem,
  });
  return "redefinida";
}

/** O link de uma conta (Esqueci por e-mail, conta aprovada no Cadastre-se): só define a senha. */
async function _definir_da_conta(
  tx: Executor,
  linha: typeof tabela.$inferSelect,
  nova: string,
  contexto: Contexto,
  agora: Date,
): Promise<"criada" | "redefinida"> {
  const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, linha.usuario_id!)).for("update");
  if (!conta || (await decidir_conta(tx, conta)).tipo === "recusar") throw new LinkInvalido("link inválido ou vencido");
  const gasto = await tx
    .update(tabela)
    .set({ usado_em: agora_utc() })
    .where(and(eq(tabela.id, linha.id), isNull(tabela.usado_em)))
    .returning({ id: tabela.id });
  if (!gasto.length) throw new LinkInvalido("link inválido ou vencido");
  await tx.update(tabela).set({ usado_em: agora_utc() }).where(and(eq(tabela.usuario_id, conta.id), isNull(tabela.usado_em)));
  const origem = { usuario_nome: ATOR, ip: contexto.ip ?? null, user_agent: contexto.user_agent ?? null };
  await tx
    .update(tabela_usuario)
    .set({ senha_hash: await autenticacao.gerar_hash(nova), precisa_trocar_senha: false, tentativas_falhas: 0, bloqueado_ate: null })
    .where(eq(tabela_usuario.id, conta.id));
  const encerradas = await autenticacao.revogar_do_usuario(tx, conta.id);
  const primeira = conta.senha_hash === SEM_SENHA;
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: primeira ? ACESSO_ATIVADO : SENHA_REDEFINIDA_POR_LINK,
    descricao: primeira
      ? "Acesso ativado pelo próprio titular: definiu a primeira senha pelo link enviado ao e-mail da conta."
      : "Senha redefinida pelo próprio titular, pelo link enviado ao e-mail da conta; " +
        `bloqueio e tentativas zerados, ${encerradas} sessão(ões) encerrada(s). Nenhum perfil foi concedido.`,
    ...origem,
  });
  return primeira ? "criada" : "redefinida";
}

// ---------------------------------------------------------------------
// Troca do e-mail em Meus dados (23/10/2026): o e-mail é o login e o destino
// do "Esqueci minha senha", então o endereço novo só vale quando o link
// enviado a ELE é aberto pela própria conta. Sem isto, a conta passava a
// entrar com um e-mail que ninguém provou ter.
// ---------------------------------------------------------------------
export const CAMINHO_TROCA_EMAIL = "/minha-conta/email";
export const VALIDADE_TROCA_EMAIL_MS = 24 * 3_600_000;
export const TIPO_TROCA_EMAIL = "TROCA_EMAIL";

export function corpo_da_troca(link: string): string {
  return (
    "Olá.\n\n" +
    "Foi pedido, em Meus dados do Sistema SISA, que este passe a ser o e-mail de entrada da conta. Para " +
    "confirmar, abra o link abaixo nas próximas 24 horas, entrando no sistema com a conta de sempre:\n\n" +
    `${link}\n\n` +
    "Até lá, o e-mail de entrada continua o anterior. Se não foi você, ignore esta mensagem.\n\n" +
    ASSINATURA
  );
}

export async function pedir_troca_de_email(
  tx: Executor,
  conta_id: number,
  email_novo: string,
  base_url: string,
  agora: Date = new Date(),
): Promise<void> {
  // um pedido por vez: o anterior cai
  await tx
    .update(tabela)
    .set({ usado_em: agora_utc() })
    .where(and(eq(tabela.usuario_id, conta_id), isNull(tabela.usado_em), sql`${tabela.email_novo} IS NOT NULL`));
  const token = randomBytes(24).toString("base64url");
  const expira_em = new Date(agora.getTime() + VALIDADE_TROCA_EMAIL_MS);
  await tx.insert(tabela).values({
    token_hash: _hash(token),
    usuario_id: conta_id,
    email_novo,
    resultado: "EMAIL",
    expira_em,
    ip: null,
    criado_em: agora,
  });
  await email.enfileirar(tx, {
    tipo: TIPO_TROCA_EMAIL,
    destinatario: email_novo,
    assunto: ASSUNTO,
    corpo: corpo_da_troca(`${base_url}${CAMINHO_TROCA_EMAIL}/${token}`),
    expira_em,
  });
}

/** O e-mail novo que o link confirma, gastando-o; `null` se não vale para esta conta. */
export async function gastar_troca_de_email(
  tx: Executor,
  conta_id: number,
  token: string,
  agora: Date = new Date(),
): Promise<string | null> {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.token_hash, _hash(token)));
  if (!linha || linha.email_novo === null || linha.usuario_id !== conta_id) return null;
  if (linha.usado_em !== null || !linha.expira_em || linha.expira_em <= agora) return null;
  const gasto = await tx
    .update(tabela)
    .set({ usado_em: agora_utc() })
    .where(and(eq(tabela.id, linha.id), isNull(tabela.usado_em)))
    .returning({ id: tabela.id });
  return gasto.length ? linha.email_novo : null;
}

/** Apaga o registro dos pedidos (IP) passado o prazo. */
export async function expurgar(tx: Executor, agora: Date = new Date(), dias = DIAS_DO_REGISTRO): Promise<number> {
  const r = await tx
    .delete(tabela)
    .where(lt(tabela.criado_em, new Date(agora.getTime() - dias * 86_400_000)))
    .returning({ id: tabela.id });
  return r.length;
}

/** Para /config: servidores ativos sem e-mail e os SIAPE que pediram ativação nos últimos dias. */
export async function sem_email(tx: Executor): Promise<{ ativos_sem_email: number; pediram: string[] }> {
  const [r] = await tx
    .select({ n: count() })
    .from(tabela_servidor)
    .where(and(eq(tabela_servidor.situacao, "ATIVO"), sql`coalesce(btrim(${tabela_servidor.email}), '') = ''`));
  const linhas = await tx
    .select({ siape: tabela_servidor.siape })
    .from(tabela)
    .innerJoin(tabela_servidor, eq(tabela_servidor.id, tabela.servidor_id))
    .where(eq(tabela.resultado, "SEM_EMAIL"))
    .groupBy(tabela_servidor.siape)
    .orderBy(tabela_servidor.siape)
    .limit(30);
  return { ativos_sem_email: Number(r?.n ?? 0), pediram: linhas.map((l) => l.siape) };
}
