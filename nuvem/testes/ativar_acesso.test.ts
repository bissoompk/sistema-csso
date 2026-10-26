/**
 * "Ativar meu acesso / Esqueci minha senha" (23/10/2026, `servicos/ativar_acesso.ts`):
 * a resposta é a mesma para qualquer pedido, o e-mail só vai ao endereço do
 * cadastro e o link de uso único define a senha (cria a conta de titular ou
 * redefine a existente, sem nunca conceder perfil).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as email from "../src/servicos/email.js";
import * as servico from "../src/servicos/ativar_acesso.js";
import { bancoLimpo, contas, criarUsuario, entrar, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;
let n_ip = 0;

await bancoLimpo();
beforeAll(() => {
  servico.ajuste.piso_ms = 150;
});
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});
afterEach(() => {
  delete process.env.CSSO_SMTP_URL;
  delete process.env.CSSO_EMAIL_REMETENTE;
});

const SIAPE = "1234567";
const EMAIL = "maria.souza@ufvjm.edu.br";
const NOME = "Maria das Dores Souza";

async function servidor(v: { siape?: string; email?: string | null; nome?: string; situacao?: string } = {}) {
  const [s] = await db
    .insert(e.servidor)
    .values({
      siape: v.siape ?? SIAPE,
      nome: v.nome ?? NOME,
      email: v.email === undefined ? EMAIL : v.email,
      situacao: v.situacao ?? "ATIVO",
    })
    .returning();
  return s!;
}

/** Um IP novo por pedido, para o teto por endereço não interferir. */
function ip_novo() {
  n_ip += 1;
  return { cabecalhos: { "x-nf-client-connection-ip": `198.51.100.${(n_ip % 250) + 1}` } };
}

function pedir(siape: string, mail: string, opcoes = ip_novo(), c: Cliente = cliente) {
  return c.post("/ativar-acesso", { siape, email: mail }, opcoes);
}

const sem_nonce = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce=""');

async function caixa() {
  return db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
}

/** O token que foi para o e-mail do cadastro (o banco só tem o hash). */
async function token_do_email(): Promise<string> {
  const linhas = (await caixa()).filter((l) => l.tipo === servico.TIPO_LINK);
  const m = linhas[linhas.length - 1]!.corpo!.match(/\/ativar-acesso\/([A-Za-z0-9_-]+)/);
  return m![1]!;
}

async function eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("a resposta é a mesma, sempre", () => {
  it("SIAPE+e-mail certos, SIAPE errado, e-mail errado e inexistente dão a mesma tela e o mesmo status", async () => {
    await servidor();
    const respostas = [
      await pedir(SIAPE, EMAIL),
      await pedir("7654321", EMAIL),
      await pedir(SIAPE, "outra.pessoa@ufvjm.edu.br"),
      await pedir("9999999", "ninguem@ufvjm.edu.br"),
    ];
    for (const r of respostas) expect(r.status).toBe(200);
    const corpos = respostas.map((r) => sem_nonce(r.text));
    expect(new Set(corpos).size).toBe(1);
    expect(corpos[0]).toContain(servico.RESPOSTA_PADRAO.slice(0, 40));
    // só o pedido certo enfileirou
    expect(await caixa()).toHaveLength(1);
  });

  it("o tempo de resposta não baixa do piso em nenhum dos casos", async () => {
    await servidor();
    for (const [s, m] of [
      [SIAPE, EMAIL],
      ["7654321", EMAIL],
      [SIAPE, "outra.pessoa@ufvjm.edu.br"],
      ["9999999", "ninguem@ufvjm.edu.br"],
    ] as const) {
      const t0 = Date.now();
      await pedir(s, m);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(servico.ajuste.piso_ms - 5);
    }
  });

  it("a resposta é a mesma com o envio de e-mail desligado, e o pedido fica na fila", async () => {
    await servidor();
    expect(email.configurado()).toBe(false);
    const r = await pedir(SIAPE, EMAIL);
    expect(r.text).toContain("Enviamos um link de uso único ao e-mail institucional");
    const [linha] = await caixa();
    expect(linha!.situacao).toBe("PENDENTE");
  });

  it("dado que nem parece SIAPE ou e-mail é erro de digitação (422), igual para todos", async () => {
    const a = await pedir("12", EMAIL);
    const b = await pedir(SIAPE, "sem-arroba");
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
    expect(a.text).toContain("SIAPE com 7 dígitos");
  });
});

describe("limites contados no banco", () => {
  it("por endereço de rede: passado o teto, a tela responde igual e nada sai", async () => {
    await servidor();
    const mesmo = { cabecalhos: { "x-nf-client-connection-ip": "203.0.113.7" } };
    let ultima = "";
    for (let i = 0; i < servico.PEDIDOS_POR_HORA_POR_IP + 3; i++) {
      const r = await pedir("9999999", "ninguem@ufvjm.edu.br", mesmo);
      expect(r.status).toBe(200);
      ultima = sem_nonce(r.text);
    }
    expect(ultima).toContain("Verifique o seu e-mail");
    const linhas = await db.select().from(e.ativacao_acesso).where(eq(e.ativacao_acesso.ip, "203.0.113.7"));
    expect(linhas).toHaveLength(servico.PEDIDOS_POR_HORA_POR_IP);
    // o pedido certo, vindo desse mesmo endereço já no teto, não manda nada
    await pedir(SIAPE, EMAIL, mesmo);
    expect(await caixa()).toHaveLength(0);
  });

  it("por destinatário: de vários endereços, só ENVIOS_POR_HORA e-mails vão ao mesmo cadastro", async () => {
    await servidor();
    for (let i = 0; i < 5; i++) await pedir(SIAPE, EMAIL);
    expect(await caixa()).toHaveLength(servico.ENVIOS_POR_HORA);
  });
});

describe("o e-mail", () => {
  it("vai só ao endereço do cadastro (não ao digitado) e não leva dado pessoal", async () => {
    const s = await servidor({ email: "Maria.Souza@ufvjm.edu.br" });
    await pedir(SIAPE, "  MARIA.SOUZA@UFVJM.EDU.BR ");
    const [linha] = await caixa();
    expect(linha!.destinatario).toBe("Maria.Souza@ufvjm.edu.br");
    expect(linha!.tipo).toBe(servico.TIPO_LINK);
    const texto = `${linha!.assunto}\n${linha!.corpo}`;
    for (const proibido of [NOME, "Maria", "Souza", SIAPE, String(s.id) + "@", "RN-"]) expect(texto).not.toContain(proibido);
    expect(linha!.corpo).toContain("/ativar-acesso/");
    expect(linha!.expira_em).not.toBeNull();
  });

  it("servidor sem e-mail no cadastro: nada é enviado e a equipe vê a ocorrência em /config", async () => {
    await servidor({ email: null });
    await pedir(SIAPE, "qualquer@ufvjm.edu.br");
    expect(await caixa()).toHaveLength(0);
    process.env.CSSO_SMTP_URL = "smtps://u%40x.com:SENHA-SECRETA-123@smtp.exemplo.com:465";
    process.env.CSSO_EMAIL_REMETENTE = '"Sistema SISA" <csso.sisa@ufvjm.edu.br>';
    await entrar(cliente, "superintendente");
    const r = await cliente.get("/config");
    expect(r.text).toContain("Servidores ativos sem e-mail");
    expect(r.text).toContain(SIAPE);
  });
});

describe("o link", () => {
  it("o banco guarda só o hash; abrir não gasta; vale uma vez; vence", async () => {
    await servidor();
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const [linha] = await db.select().from(e.ativacao_acesso).where(eq(e.ativacao_acesso.resultado, "LINK"));
    expect(linha!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(await db.select().from(e.ativacao_acesso))).not.toContain(token);
    // abrir (GET) duas vezes não gasta
    expect((await cliente.get(`/ativar-acesso/${token}`)).text).toContain("Defina a sua senha");
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(200);
    const ok = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" }, { seguir: false });
    expect(ok.status).toBe(303);
    // segunda vez: link inválido
    const de_novo = await cliente.post(`/ativar-acesso/${token}`, { nova: "outra-frase-2026", confirmacao: "outra-frase-2026" });
    expect(de_novo.status).toBe(404);
    expect(de_novo.text).toContain("Link vencido ou inválido");
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(404);
  });

  it("vencido não serve", async () => {
    await servidor();
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    await db.update(e.ativacao_acesso).set({ expira_em: new Date(Date.now() - 1000) });
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(404);
    const r = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" });
    expect(r.status).toBe(404);
    expect(await db.select().from(e.usuario).where(eq(e.usuario.email, EMAIL))).toHaveLength(0);
  });

  it("token inventado não serve", async () => {
    expect((await cliente.get("/ativar-acesso/abc123")).status).toBe(404);
    expect((await cliente.post("/ativar-acesso/abc123", { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" })).status).toBe(404);
  });

  it("senha fora da política é recusada e não gasta o link", async () => {
    await servidor();
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const fraca = await cliente.post(`/ativar-acesso/${token}`, { nova: "123", confirmacao: "123" });
    expect(fraca.status).toBe(422);
    expect(fraca.text).toContain("Senha fraca");
    const diferente = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "outra-coisa" });
    expect(diferente.text).toContain("A confirmação não confere");
    expect(await db.select().from(e.usuario).where(eq(e.usuario.email, EMAIL))).toHaveLength(0);
    const ok = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" }, { seguir: false });
    expect(ok.status).toBe(303);
  });
});

describe("cria a conta do titular", () => {
  it("login = e-mail, perfil servidor_consulta, ligada ao servidor, e entra com a senha escolhida", async () => {
    const s = await servidor();
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const r = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/login?motivo=ativada");
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.email, EMAIL));
    expect(conta!.login).toBe(EMAIL);
    expect(conta!.servidor_id).toBe(s.id);
    expect(conta!.nome).toBe(NOME);
    expect(conta!.precisa_trocar_senha).toBe(false);
    const atribuicoes = await db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, conta!.id), with: { perfil: true } });
    expect(atribuicoes.map((a) => a.perfil.codigo)).toEqual(["servidor_consulta"]);
    const tela = await cliente.get(r.location!);
    expect(tela.text).toContain("Acesso ativado");
    await entrar(novoCliente(), EMAIL, "frase-longa-2026");
  });

  it("depois de criada, o pedido seguinte só redefine (não cria uma segunda conta)", async () => {
    await servidor();
    await pedir(SIAPE, EMAIL);
    const t1 = await token_do_email();
    await cliente.post(`/ativar-acesso/${t1}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" });
    await db.delete(e.email_saida);
    await pedir(SIAPE, EMAIL);
    const t2 = await token_do_email();
    const r = await cliente.post(`/ativar-acesso/${t2}`, { nova: "nova-frase-2027", confirmacao: "nova-frase-2027" }, { seguir: false });
    expect(r.location).toBe("/login?motivo=redefinida");
    expect(await db.select().from(e.usuario).where(eq(e.usuario.email, EMAIL))).toHaveLength(1);
    await entrar(novoCliente(), EMAIL, "nova-frase-2027");
  });
});

describe("o primeiro acesso entra logado depois de confirmar o e-mail (26/10/2026)", () => {
  const SENHA = "frase-longa-2026";

  it("o clique de confirmação abre a sessão e leva ao Início; o mesmo link, de novo, não abre outra", async () => {
    await servidor();
    await cliente.post("/ativar-acesso", { siape: SIAPE, email: EMAIL, nova: SENHA, confirmacao: SENHA }, ip_novo());
    const token = await token_do_email();
    const novo = novoCliente();
    // abrir o link não ativa nem entra (leitor de e-mail que pré-visualiza)
    expect((await novo.get(`/ativar-acesso/${token}`)).status).toBe(200);
    expect((await novo.get("/quem-sou-eu")).json().autenticado).toBe(false);
    const ok = await novo.post(`/ativar-acesso/${token}`, {}, { seguir: false });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/?ativado=1");
    expect((await novo.get("/quem-sou-eu")).json().autenticado).toBe(true);
    const inicio = await novo.get("/?ativado=1");
    expect(inicio.status).toBe(200);
    expect(inicio.text).toContain("Acesso ativado");
    // a sessão é de quem confirmou, e só dele
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.email, EMAIL));
    expect(conta!.ultimo_login_em).not.toBeNull();
    expect(await db.select().from(e.sessao).where(eq(e.sessao.usuario_id, conta!.id))).toHaveLength(1);
    // o clique repetido não abre sessão nenhuma
    const outro = novoCliente();
    const de_novo = await outro.post(`/ativar-acesso/${token}`, {}, { seguir: false });
    expect(de_novo.status).toBe(404);
    expect((await outro.get("/quem-sou-eu")).json().autenticado).toBe(false);
    expect(await db.select().from(e.sessao).where(eq(e.sessao.usuario_id, conta!.id))).toHaveLength(1);
  });

  it("o link que ainda pede a senha (Esqueci minha senha) continua voltando ao login, sem sessão", async () => {
    const s = await servidor();
    await criarUsuario(db, { login: EMAIL, email: EMAIL, nome: NOME, servidor_id: s.id, perfis: ["servidor_consulta"] });
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const novo = novoCliente();
    const r = await novo.post(`/ativar-acesso/${token}`, { nova: SENHA, confirmacao: SENHA }, { seguir: false });
    expect(r.location).toBe("/login?motivo=redefinida");
    expect(r.headers.get("set-cookie") ?? "").not.toContain("csso_sessao=");
    expect((await novo.get("/quem-sou-eu")).json().autenticado).toBe(false);
  });
});

describe("esqueci minha senha (conta que já existe)", () => {
  it("troca a senha, revoga as sessões abertas e zera bloqueio e tentativas", async () => {
    const s = await servidor();
    const conta = await criarUsuario(db, { login: EMAIL, email: EMAIL, nome: NOME, servidor_id: s.id, perfis: ["servidor_consulta"] });
    const aberto = novoCliente();
    await entrar(aberto, EMAIL);
    expect((await aberto.get("/quem-sou-eu")).json().autenticado).toBe(true);
    await db
      .update(e.usuario)
      .set({ tentativas_falhas: 4, bloqueado_ate: new Date(Date.now() + 3_600_000) })
      .where(eq(e.usuario.id, conta.id));
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const r = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" }, { seguir: false });
    expect(r.location).toBe("/login?motivo=redefinida");
    const [depois] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta.id));
    expect(depois!.tentativas_falhas).toBe(0);
    expect(depois!.bloqueado_ate).toBeNull();
    expect((await aberto.get("/quem-sou-eu")).json().autenticado).toBe(false);
    const sessoes = await db.select().from(e.sessao).where(eq(e.sessao.usuario_id, conta.id));
    expect(sessoes.every((x) => x.revogada)).toBe(true);
    await entrar(novoCliente(), EMAIL, "frase-longa-2026");
    // e nenhum perfil novo
    const perfis = await db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, conta.id), with: { perfil: true } });
    expect(perfis.map((a) => a.perfil.codigo)).toEqual(["servidor_consulta"]);
  });

  it("conta de equipe redefine a senha, mas o fluxo não concede perfil nenhum", async () => {
    const s = await servidor();
    const conta = await criarUsuario(db, { login: "coord_maria", email: EMAIL, servidor_id: s.id, perfis: ["tecnico_seguranca"] });
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" });
    await entrar(novoCliente(), "coord_maria", "frase-longa-2026");
    const perfis = await db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, conta.id), with: { perfil: true } });
    expect(perfis.map((a) => a.perfil.codigo)).toEqual(["tecnico_seguranca"]);
  });

  it("conta inativa NÃO é reativada: a tela é igual, o e-mail é neutro e a senha não muda", async () => {
    const s = await servidor();
    const conta = await criarUsuario(db, { login: EMAIL, email: EMAIL, servidor_id: s.id, perfis: ["servidor_consulta"], ativo: false });
    const [antes] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta.id));
    const r = await pedir(SIAPE, EMAIL);
    expect(r.status).toBe(200);
    const [linha] = await caixa();
    expect(linha!.tipo).toBe(servico.TIPO_NEUTRO);
    expect(linha!.corpo).toContain("Procure a equipe");
    expect(linha!.corpo).not.toContain("/ativar-acesso/");
    expect(linha!.corpo).not.toContain(NOME);
    const [depois] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta.id));
    expect(depois!.ativo).toBe(false);
    expect(depois!.senha_hash).toBe(antes!.senha_hash);
    expect(await db.select().from(e.ativacao_acesso).where(eq(e.ativacao_acesso.resultado, "LINK"))).toHaveLength(0);
  });

  it.each(["administrador_sistema", "superintendente"])("a conta de %s não redefine por aqui", async (perfil) => {
    const s = await servidor();
    const conta = await criarUsuario(db, { login: EMAIL, email: EMAIL, servidor_id: s.id, perfis: [perfil] });
    const [antes] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta.id));
    await pedir(SIAPE, EMAIL);
    const [linha] = await caixa();
    expect(linha!.tipo).toBe(servico.TIPO_NEUTRO);
    expect(linha!.corpo).toContain("Procure a equipe");
    const [depois] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta.id));
    expect(depois!.senha_hash).toBe(antes!.senha_hash);
  });

  it("um link já emitido deixa de valer se a conta virou de administração antes do uso", async () => {
    const s = await servidor();
    const conta = await criarUsuario(db, { login: EMAIL, email: EMAIL, servidor_id: s.id, perfis: ["servidor_consulta"] });
    await pedir(SIAPE, EMAIL);
    const token = await token_do_email();
    const [perfil] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "superintendente"));
    await db.insert(e.atribuicao).values({ usuario_id: conta.id, perfil_id: perfil!.id, vigencia_inicio: "2020-01-01" });
    const r = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" });
    expect(r.status).toBe(404);
  });
});

describe("auditoria", () => {
  it("grava os eventos com o ator 'o próprio titular' e sem dado pessoal", async () => {
    const s = await servidor();
    await pedir(SIAPE, EMAIL);
    const t1 = await token_do_email();
    await cliente.post(`/ativar-acesso/${t1}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" });
    await db.delete(e.email_saida);
    await pedir(SIAPE, EMAIL);
    const t2 = await token_do_email();
    await cliente.post(`/ativar-acesso/${t2}`, { nova: "nova-frase-2027", confirmacao: "nova-frase-2027" });
    // uma conta inativa gera o evento de recusa
    const s2 = await servidor({ siape: "7654321", email: "joao@ufvjm.edu.br", nome: "João Pereira" });
    await criarUsuario(db, { login: "joao@ufvjm.edu.br", email: "joao@ufvjm.edu.br", servidor_id: s2.id, ativo: false });
    await pedir("7654321", "joao@ufvjm.edu.br");

    const ativado = await eventos("ACESSO_ATIVADO");
    const redefinida = await eventos("SENHA_REDEFINIDA_POR_LINK");
    const recusado = await eventos("PEDIDO_DE_ACESSO_RECUSADO");
    expect(ativado).toHaveLength(1);
    expect(redefinida).toHaveLength(1);
    expect(recusado).toHaveLength(1);
    for (const ev of [...ativado, ...redefinida, ...recusado]) {
      expect(ev.usuario_nome).toBe("o próprio titular");
      const texto = `${ev.descricao} ${ev.comentario ?? ""}`;
      for (const proibido of [NOME, "Maria", "Souza", SIAPE, "João", "7654321", "@ufvjm"]) expect(texto).not.toContain(proibido);
    }
    expect(s.id).toBeGreaterThan(0);
  });
});

describe("telas", () => {
  it("o login tem o link, e nenhuma tela do fluxo mostra código (RN-xx)", async () => {
    expect((await cliente.get("/login")).text).toContain('href="/cadastre-se"');
    expect((await cliente.get("/login")).text).toContain("Primeiro acesso / Cadastre-se");
    expect((await cliente.get("/cadastre-se")).text).toContain('href="/ativar-acesso"');
    await servidor();
    const telas = [
      (await cliente.get("/ativar-acesso")).text,
      (await pedir(SIAPE, EMAIL)).text,
      (await pedir("12", EMAIL)).text,
      (await cliente.get("/ativar-acesso/inventado")).text,
    ];
    const token = await token_do_email();
    telas.push((await cliente.get(`/ativar-acesso/${token}`)).text);
    telas.push((await cliente.post(`/ativar-acesso/${token}`, { nova: "1", confirmacao: "1" })).text);
    telas.push((await cliente.get("/login?motivo=ativada")).text, (await cliente.get("/login?motivo=redefinida")).text);
    for (const t of telas) expect(t).not.toMatch(/RN-\d/);
  });

  it("nenhuma tela do fluxo revela o nome da pessoa", async () => {
    await servidor();
    const r = await pedir(SIAPE, EMAIL);
    expect(r.text).not.toContain("Maria");
    const token = await token_do_email();
    expect((await cliente.get(`/ativar-acesso/${token}`)).text).not.toContain("Maria");
  });
});

describe("/config: envio de e-mail", () => {
  it("diz não configurado (com os nomes que faltam) e depois configurado, sem mostrar valor nenhum", async () => {
    await entrar(cliente, "superintendente");
    const sem = await cliente.get("/config");
    expect(sem.text).toContain("Envio de e-mail");
    expect(sem.text).toContain("não configurado");
    expect(sem.text).toContain("CSSO_SMTP_URL");
    process.env.CSSO_SMTP_URL = "smtps://csso.sisa%40ufvjm.edu.br:SENHA-SECRETA-123@smtp.gmail.com:465";
    process.env.CSSO_EMAIL_REMETENTE = '"Sistema SISA" <csso.sisa@ufvjm.edu.br>';
    const com = await cliente.get("/config");
    expect(com.text).toContain("configurado");
    expect(com.text).not.toContain("não configurado");
    for (const segredo of ["SENHA-SECRETA-123", "smtp.gmail.com", "csso.sisa"]) expect(com.text).not.toContain(segredo);
  });

  it("mostra a fila: pendentes e falhos", async () => {
    await servidor();
    await pedir(SIAPE, EMAIL);
    await entrar(cliente, "superintendente");
    const r = await cliente.get("/config");
    expect(r.text).toMatch(/Na fila \(pendentes\)<\/dt><dd>1<\/dd>/);
  });

  it("quem não tem backup.executar não vê o bloco", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/config");
    expect(r.text).not.toContain('id="envio-email"');
  });
});

describe("a ferramenta testar-email", () => {
  it("sem configuração, diz o que falta; com URL, nunca imprime a senha", async () => {
    const { principal } = await import("../ferramentas/testar-email.js");
    const saidas: string[] = [];
    const saida = { log: (l: string) => saidas.push(l), erro: (l: string) => saidas.push(l) };
    expect(await principal(["--para", "a@b.com"], saida)).toBe(2);
    expect(saidas.join("\n")).toContain("CSSO_SMTP_URL");
    process.env.CSSO_SMTP_URL = "smtps://u%40x.com:SENHA-SECRETA-123@127.0.0.1:1";
    process.env.CSSO_EMAIL_REMETENTE = '"T" <u@x.com>';
    saidas.length = 0;
    expect(await principal(["--para", "a@b.com"], saida)).toBe(3);
    const tudo = saidas.join("\n");
    expect(tudo).not.toContain("SENHA-SECRETA-123");
    expect(tudo).not.toContain("smtps://");
    expect(tudo).toContain("127.0.0.1");
  });

  it("mascara a credencial em qualquer erro", () => {
    process.env.CSSO_SMTP_URL = "smtps://u%40x.com:SENHA-SECRETA-123@smtp.exemplo.com:465";
    const limpo = email.sem_segredos("falhou em smtps://u%40x.com:SENHA-SECRETA-123@smtp.exemplo.com:465 senha SENHA-SECRETA-123");
    expect(limpo).not.toContain("SENHA-SECRETA-123");
  });
});
