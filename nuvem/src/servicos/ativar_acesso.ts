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
import { TOPO_DA_HIERARQUIA, perfis_vigentes } from "./rbac.js";

export const CAMINHO = "/ativar-acesso";
export const VALIDADE_MS = 3_600_000;
export const TIPO_LINK = "ATIVAR_ACESSO";
export const TIPO_NEUTRO = "ATIVAR_ACESSO_NEUTRO";
export const TIPOS: readonly string[] = [TIPO_LINK, TIPO_NEUTRO];
export const PEDIDOS_POR_HORA_POR_IP = 8;
export const ENVIOS_POR_HORA = 2;
export const ENVIOS_POR_DIA = 5;
export const DIAS_DO_REGISTRO = 7;
export const PERFIL_DO_TITULAR = "servidor_consulta";
export const ATOR = "o próprio titular";
/** Cadastro que já saiu do quadro: não ganha conta nova por aqui. */
const SITUACOES_FORA = ["APOSENTADO", "EXONERADO"];

export const PEDIDO_DE_ACESSO_RECUSADO = "PEDIDO_DE_ACESSO_RECUSADO";
export const ACESSO_ATIVADO = "ACESSO_ATIVADO";
export const SENHA_REDEFINIDA_POR_LINK = "SENHA_REDEFINIDA_POR_LINK";

/** O piso do tempo de resposta do pedido; o teste o baixa. */
export const ajuste = { piso_ms: 1200 };

export const RESPOSTA_PADRAO =
  "Se os dados conferem com o cadastro de servidores, enviamos ao e-mail institucional cadastrado " +
  "um link para definir a senha, válido por 1 hora e de uso único. Confira também a caixa de spam. " +
  "Se não chegar, procure a equipe responsável.";

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

async function _no_teto_do_destinatario(tx: Executor, para: string, agora: Date): Promise<boolean> {
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
  const [recentes] = await tx
    .select({ n: count() })
    .from(tabela)
    .where(
      and(
        ip === null ? isNull(tabela.ip) : eq(tabela.ip, ip),
        gt(tabela.criado_em, new Date(agora.getTime() - 3_600_000)),
      ),
    );
  if (Number(recentes?.n ?? 0) >= PEDIDOS_POR_HORA_POR_IP) return;
  const [registro] = await tx.insert(tabela).values({ ip, criado_em: agora }).returning({ id: tabela.id });
  const marcar = (v: Partial<typeof tabela.$inferInsert>) => tx.update(tabela).set(v).where(eq(tabela.id, registro!.id));

  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, siape));
  if (!servidor) return;
  const cadastrado = (servidor.email ?? "").trim();
  if (!cadastrado || !email.email_valido(cadastrado)) {
    await marcar({ servidor_id: servidor.id, resultado: "SEM_EMAIL" });
    return;
  }
  if (normalizar_email(cadastrado) !== normalizar_email(d.email)) return;
  if (await _no_teto_do_destinatario(tx, cadastrado, agora)) return;

  const decisao = await decidir(tx, servidor);
  if (decisao.tipo === "recusar") {
    await marcar({ servidor_id: servidor.id, resultado: "NEUTRO" });
    await email.enfileirar(tx, {
      tipo: TIPO_NEUTRO,
      destinatario: cadastrado,
      assunto: ASSUNTO,
      corpo: corpo_neutro(),
      expira_em: new Date(agora.getTime() + 24 * 3_600_000),
    });
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

async function _linha_valida(tx: Executor, token: string, agora: Date) {
  if (!token || token.length > 64) return null;
  const [linha] = await tx.select().from(tabela).where(eq(tabela.token_hash, _hash(token)));
  if (!linha || linha.usado_em !== null || !linha.expira_em || linha.expira_em <= agora || linha.servidor_id === null) {
    return null;
  }
  return linha;
}

/** O link ainda serve para definir a senha? (Abrir não o gasta.) */
export async function link_vale(tx: Executor, token: string, agora: Date = new Date()): Promise<boolean> {
  const linha = await _linha_valida(tx, token, agora);
  if (!linha) return false;
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
    const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.codigo, PERFIL_DO_TITULAR));
    if (!perfil || !perfil.ativo) throw new Error(`perfil '${PERFIL_DO_TITULAR}' ausente ou inativo: o banco não foi semeado`);
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
