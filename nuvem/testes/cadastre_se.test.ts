/**
 * "Primeiro acesso / Cadastre-se" e "Esqueci minha senha" (23/10/2026,
 * `servicos/pedido_conta.ts` e `servicos/ativar_acesso.ts`): terceirizado e
 * discente PEDEM a conta, a equipe confere, e só então a conta nasce, com o
 * perfil do vínculo e o link da senha no e-mail do pedido. Dados fictícios.
 */
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as ativar_acesso from "../src/servicos/ativar_acesso.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as servico from "../src/servicos/pedido_conta.js";
import { carregar_usuario_atual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;
let n_ip = 0;

beforeAll(() => {
  ativar_acesso.ajuste.piso_ms = 50;
});
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});

function ip_novo() {
  n_ip += 1;
  return { cabecalhos: { "x-nf-client-connection-ip": `203.0.113.${(n_ip % 250) + 1}` } };
}

const SENHA = "Uma frase de senha 2026";
const TERC = {
  vinculo: "TERCEIRIZADO",
  nome: "Joana Fictícia Lima",
  email: "joana.ficticia@empresa-exemplo.com.br",
  organizacao: "Empresa Exemplo Ltda",
  matricula: "Restaurante universitário",
  maior_de_idade: "1",
  nova: SENHA,
  confirmacao: SENHA,
};
const DISC = { ...TERC, vinculo: "DISCENTE", email: "pedro.ficticio@ufvjm.edu.br", organizacao: "Engenharia Civil", matricula: "20261234" };

const pedir = (campos: Record<string, string>, c: Cliente = cliente) => c.post("/cadastre-se", campos, ip_novo());
const caixa = () => db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
const pedidos = () => db.select().from(e.pedido_conta).orderBy(asc(e.pedido_conta.id));
const conta = async (email: string) => (await db.select().from(e.usuario).where(eq(e.usuario.email, email)))[0];

function token_de(corpo: string): string {
  return corpo.match(/\/ativar-acesso\/([A-Za-z0-9_-]+)/)![1]!;
}

/** O caminho do último link "Confirmar e-mail" enviado a este endereço. */
async function link_de_confirmacao(para: string): Promise<string> {
  const m = (await caixa()).filter((x) => x.tipo === servico.TIPO_CONFIRMAR && x.destinatario === para).pop()!;
  return m.corpo!.match(/\/cadastre-se\/confirmar\/[A-Za-z0-9_-]+/)![0];
}

/** Pede e confirma o e-mail: o pedido chega à fila da equipe. */
async function pedir_e_confirmar(campos: Record<string, string>) {
  await pedir(campos);
  const r = await cliente.post(await link_de_confirmacao(campos.email!), {});
  expect(r.text).toContain("E-mail confirmado");
}

describe("o pedido", () => {
  it("a tela pergunta o vínculo, e o servidor segue para o primeiro acesso pelo cadastro", async () => {
    const r = await cliente.get("/cadastre-se");
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/ativar-acesso"');
    expect(r.text).toContain("vinculo=TERCEIRIZADO");
    expect(r.text).toContain("vinculo=DISCENTE");
    const t = (await cliente.get("/cadastre-se?vinculo=DISCENTE")).text;
    expect(t).toContain("Matrícula");
    expect(t).toContain('name="nova"');
    expect(t).toContain('name="confirmacao"');
  });

  it("o login tem Primeiro acesso e Esqueci minha senha", async () => {
    const t = (await cliente.get("/login")).text;
    expect(t).toContain('href="/cadastre-se"');
    expect(t).toContain('href="/esqueci-senha"');
  });

  it("o pedido espera a confirmação do e-mail; abrir o link não confirma; o botão libera a conta", async () => {
    const r = await pedir(TERC);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirme o seu e-mail");
    expect(r.text).not.toContain(SENHA);
    let [p] = await pedidos();
    expect(p).toMatchObject({ situacao: "AGUARDANDO_EMAIL", vinculo: "TERCEIRIZADO", nome: TERC.nome });
    expect(p!.senha_hash).toMatch(/^\$argon2/);
    expect(await conta(TERC.email)).toBeUndefined();
    const caminho = await link_de_confirmacao(TERC.email);
    // abrir (o leitor de e-mail pré-visualiza) não confirma
    expect((await cliente.get(caminho)).text).toContain("Confirmar o e-mail");
    expect((await pedidos())[0]!.situacao).toBe("AGUARDANDO_EMAIL");
    const ok = await cliente.post(caminho, {});
    expect(ok.text).toContain("Conta liberada");
    [p] = await pedidos();
    expect(p).toMatchObject({ situacao: "APROVADO", token_hash: null, senha_hash: null, decidido_por: null });
    expect(p!.email_confirmado_em).not.toBeNull();
    // a conta nasce na hora, com a senha escolhida e o perfil do vínculo, sem servidor
    const c = (await conta(TERC.email))!;
    expect(c).toMatchObject({ servidor_id: null, nome: TERC.nome, ativo: true });
    const atual = await carregar_usuario_atual(db, c.id);
    expect(atual.pode("treinamento.ver")).toBe(true);
    expect(atual.pode("acidente.comunicar")).toBe(true);
    expect(atual.pode("epi.requisitar")).toBe(false);
    await entrar(novoCliente(), c.login, SENHA);
    // nenhuma tarefa para a equipe, e a trilha sem nome nem e-mail
    expect(await db.select().from(e.pendencia).where(eq(e.pendencia.tipo, "CONTA_A_CONFERIR"))).toHaveLength(0);
    for (const tipo of [servico.PEDIDO_DE_CONTA_RECEBIDO, servico.PEDIDO_DE_CONTA_APROVADO]) {
      const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
      expect(ev!.descricao).not.toContain("Joana");
      expect(ev!.descricao).not.toContain("@");
    }
    // o link não serve de novo
    expect((await cliente.get(caminho)).status).toBe(404);
  });

  it("senha fraca ou que não confere é recusada, e a senha não volta para a tela", async () => {
    const r = await pedir({ ...TERC, nova: "curta", confirmacao: "curta" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Senha fraca");
    expect(r.text).toContain(TERC.nome);
    const r2 = await pedir({ ...TERC, confirmacao: "Outra frase de senha 2026" });
    expect(r2.status).toBe(422);
    expect(r2.text).toContain("A confirmação da senha não confere");
    expect(r2.text).not.toContain(SENHA);
    expect(await pedidos()).toHaveLength(0);
  });

  it("discente só com e-mail institucional; e só maior de idade", async () => {
    const r = await pedir({ ...DISC, email: "pedro@gmail.com" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("@ufvjm.edu.br");
    const r2 = await pedir({ ...DISC, maior_de_idade: "" });
    expect(r2.status).toBe(422);
    expect(r2.text).toContain("18 anos");
    expect(await pedidos()).toHaveLength(0);
  });

  it("e-mail que já está no sistema não abre pedido: o dono recebe a mensagem neutra, a tela é a mesma", async () => {
    await db.insert(e.servidor).values({ siape: "7654321", nome: "Servidora Fictícia", email: "serv.ficticia@ufvjm.edu.br", situacao: "ATIVO" });
    const r = await pedir({ ...DISC, email: "serv.ficticia@ufvjm.edu.br" });
    expect(r.text).toContain("Confirme o seu e-mail");
    await pedir_e_confirmar(TERC);
    const r3 = await pedir(TERC); // o segundo pedido do mesmo e-mail, que já tem conta
    expect(r3.text).toContain("Confirme o seu e-mail");
    expect((await pedidos()).filter((p) => p.situacao === "APROVADO")).toHaveLength(1);
    const neutros = (await caixa()).filter((m) => m.tipo === servico.TIPO_NEUTRO);
    expect(neutros.map((m) => m.destinatario).sort()).toEqual([TERC.email, "serv.ficticia@ufvjm.edu.br"].sort());
  });

  it("o pedido não confirmado dá lugar ao novo: ninguém bloqueia o e-mail de outra pessoa", async () => {
    await pedir({ ...TERC, nome: "Alguém Que Não É Joana" });
    const antigo = await link_de_confirmacao(TERC.email);
    await pedir(TERC);
    expect((await cliente.get(antigo)).status).toBe(404);
    const vivos = (await pedidos()).filter((p) => p.situacao === "AGUARDANDO_EMAIL");
    expect(vivos).toHaveLength(1);
    expect(vivos[0]!.nome).toBe(TERC.nome);
    const descartado = (await pedidos()).find((p) => p.situacao === "DESCARTADO")!;
    expect(descartado).toMatchObject({ nome: "", email: "", senha_hash: null });
  });

  it("teto por endereço de rede", async () => {
    const mesmo = { cabecalhos: { "x-nf-client-connection-ip": "203.0.113.250" } };
    for (let i = 0; i < servico.PEDIDOS_POR_HORA_POR_IP + 2; i++) {
      await cliente.post("/cadastre-se", { ...TERC, email: `p${i}@exemplo.org` }, mesmo);
    }
    expect(await pedidos()).toHaveLength(servico.PEDIDOS_POR_HORA_POR_IP);
  });
});

describe("Contas do Cadastre-se: bloquear, desbloquear, excluir", () => {
  const conta_de = async (mail: string) => (await conta(mail))!;
  const acao = async (c: Cliente, id: number, qual: string) => c.post(`/usuarios/pedidos/contas/${id}/${qual}`, {});

  it("quem não cria conta não abre a tela", async () => {
    const r = await (await entrar(novoCliente(), "secretaria_csso")).get("/usuarios/pedidos", { seguir: false });
    expect(r.status).toBe(403);
  });

  it("a tela lista as contas, com o vínculo e a empresa ou o curso", async () => {
    await pedir_e_confirmar(DISC);
    const sup = await entrar(novoCliente(), "superintendente");
    expect((await sup.get("/usuarios")).text).toContain('href="/usuarios/pedidos"');
    const t = (await sup.get("/usuarios/pedidos")).text;
    expect(t).toContain(DISC.nome);
    expect(t).toContain("Engenharia Civil");
    expect(t).toContain("Bloquear");
  });

  it("bloquear tira o acesso e encerra a sessão; desbloquear devolve", async () => {
    await pedir_e_confirmar(TERC);
    const c = await conta_de(TERC.email);
    const dele = await entrar(novoCliente(), c.login, SENHA);
    const sup = await entrar(novoCliente(), "superintendente");
    expect((await acao(sup, c.id, "bloquear")).text).toContain("bloqueada");
    expect((await conta_de(TERC.email)).ativo).toBe(false);
    expect((await dele.get("/turmas/minhas", { seguir: false })).status).toBe(303);
    expect((await novoCliente().post("/login", { login: c.login, senha: SENHA }, { seguir: false })).status).not.toBe(303);
    await acao(sup, c.id, "desbloquear");
    await entrar(novoCliente(), c.login, SENHA);
  });

  it("excluir apaga a conta sem registros", async () => {
    await pedir_e_confirmar(DISC);
    const c = await conta_de(DISC.email);
    const sup = await entrar(novoCliente(), "superintendente");
    expect((await acao(sup, c.id, "excluir")).text).toContain("excluída");
    expect(await conta(DISC.email)).toBeUndefined();
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.CONTA_EXCLUIDA));
    expect(ev!.descricao).not.toContain(DISC.nome);
    expect(ev!.descricao).not.toContain("@");
    // o e-mail fica livre para um pedido novo
    await pedir_e_confirmar(DISC);
    expect(await conta(DISC.email)).toBeDefined();
  });

  it("a conta com registros não se apaga: é bloqueada no lugar", async () => {
    await pedir_e_confirmar(DISC);
    const c = await conta_de(DISC.email);
    // um registro que aponta para a conta (a trilha encadeada não se apaga)
    await auditoria.registrar(db, { entidade: "usuario", entidade_id: c.id, tipo_evento: "PERFIL_CONCEDIDO", descricao: "teste", usuario: await carregar_usuario_atual(db, c.id) });
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await acao(sup, c.id, "excluir");
    expect(r.text).toContain("foi bloqueada no lugar");
    expect((await conta_de(DISC.email)).ativo).toBe(false);
  });

  it("por aqui não se bloqueia nem exclui conta de servidor ou de equipe", async () => {
    const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await acao(sup, coord!.id, "excluir");
    expect(r.status).toBe(422);
    expect(r.text).toContain("só se cuida de conta de terceirizado ou discente");
    expect((await db.select().from(e.usuario).where(eq(e.usuario.id, coord!.id)))[0]!.ativo).toBe(true);
  });

  it("o pedido velho é apagado pela rotina, e o não confirmado sai em 3 dias", async () => {
    await pedir_e_confirmar(TERC);
    await pedir(DISC);
    expect(await servico.expurgar(db, new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    expect((await pedidos()).map((p) => p.situacao)).toEqual(["APROVADO"]);
    expect(await servico.expurgar(db, new Date(Date.now() + 91 * 86_400_000))).toBe(1);
    expect(await pedidos()).toHaveLength(0);
    // a conta continua
    expect(await conta(TERC.email)).toBeDefined();
  });
});

describe("Esqueci minha senha, para qualquer conta", () => {
  const pedir_link = (mail: string) => cliente.post("/esqueci-senha", { email: mail }, ip_novo());

  it("a conta sem servidor recebe o link no e-mail dela e redefine", async () => {
    const c = await criarUsuario(db, { login: "terc.ficticio@exemplo.org", email: "terc.ficticio@exemplo.org", perfis: ["terceirizado"] });
    const r = await pedir_link("Terc.Ficticio@exemplo.org");
    expect(r.text).toContain("Verifique o seu e-mail");
    const m = (await caixa()).find((x) => x.tipo === ativar_acesso.TIPO_LINK)!;
    expect(m.destinatario).toBe("terc.ficticio@exemplo.org");
    const token = token_de(m.corpo!);
    const s = await cliente.post(`/ativar-acesso/${token}`, { nova: "Outra frase de senha 2026", confirmacao: "Outra frase de senha 2026" }, { seguir: false });
    expect(s.headers.get("location")).toContain("motivo=redefinida");
    await entrar(novoCliente(), c.login, "Outra frase de senha 2026");
  });

  it("e-mail desconhecido, conta inativa e conta de administração: a mesma tela, e nenhum link", async () => {
    await criarUsuario(db, { login: "inativa@exemplo.org", email: "inativa@exemplo.org", ativo: false });
    const [sup] = await db.select().from(e.usuario).where(eq(e.usuario.login, "superintendente"));
    const telas = [
      (await pedir_link("ninguem@exemplo.org")).text,
      (await pedir_link("inativa@exemplo.org")).text,
      (await pedir_link(sup!.email)).text,
    ];
    for (const t of telas) expect(t).toContain(ativar_acesso.RESPOSTA_ESQUECI);
    expect((await caixa()).filter((x) => x.tipo === ativar_acesso.TIPO_LINK)).toHaveLength(0);
    expect((await caixa()).filter((x) => x.tipo === ativar_acesso.TIPO_NEUTRO)).toHaveLength(2);
  });

  it("o servidor sem conta, pelo e-mail do cadastro, recebe o link de ativação", async () => {
    await db.insert(e.servidor).values({ siape: "1112223", nome: "Servidor Fictício", email: "serv.sem.conta@ufvjm.edu.br", situacao: "ATIVO" });
    await pedir_link("serv.sem.conta@ufvjm.edu.br");
    const m = (await caixa()).find((x) => x.tipo === ativar_acesso.TIPO_LINK)!;
    expect(m.destinatario).toBe("serv.sem.conta@ufvjm.edu.br");
  });
});

describe("o link do servidor não adota a conta externa com o mesmo e-mail", () => {
  it("SIAPE + e-mail de servidor cujo e-mail é de conta de terceirizado: neutro, sem link", async () => {
    await criarUsuario(db, { login: "mesmo@ufvjm.edu.br", email: "mesmo@ufvjm.edu.br", perfis: ["discente"] });
    await db.insert(e.servidor).values({ siape: "3334445", nome: "Servidor Fictício", email: "mesmo@ufvjm.edu.br", situacao: "ATIVO" });
    await cliente.post("/ativar-acesso", { siape: "3334445", email: "mesmo@ufvjm.edu.br" }, ip_novo());
    expect((await caixa()).filter((x) => x.tipo === ativar_acesso.TIPO_LINK)).toHaveLength(0);
    expect((await caixa()).filter((x) => x.tipo === ativar_acesso.TIPO_NEUTRO)).toHaveLength(1);
  });
});

describe("primeiro acesso do servidor com a senha escolhida na tela", () => {
  const SIAPE = "4445556";
  const MAIL = "servidora.ficticia@ufvjm.edu.br";
  const servidora = () =>
    db.insert(e.servidor).values({ siape: SIAPE, nome: "Servidora Fictícia Alves", email: MAIL, situacao: "ATIVO" }).returning();
  const ativar = (extra: Record<string, string> = { nova: SENHA, confirmacao: SENHA }) =>
    cliente.post("/ativar-acesso", { siape: SIAPE, email: MAIL, ...extra }, ip_novo());
  const ultimo_link = async () => (await caixa()).filter((m) => m.tipo === ativar_acesso.TIPO_LINK).pop()!;

  it("o link só confirma: abrir não ativa, o botão cria a conta com a senha escolhida e sai o aviso", async () => {
    await servidora();
    expect((await cliente.get("/ativar-acesso")).text).toContain('name="nova"');
    const r = await ativar();
    expect(r.text).toContain(ativar_acesso.RESPOSTA_PADRAO);
    const m = await ultimo_link();
    expect(m.destinatario).toBe(MAIL);
    expect(m.corpo).toContain("NÃO CONFIRME");
    const token = token_de(m.corpo!);
    const tela = await cliente.get(`/ativar-acesso/${token}`);
    expect(tela.text).toContain("Confirmar e ativar o acesso");
    expect(tela.text).not.toContain('name="nova"');
    expect(await conta(MAIL)).toBeUndefined();
    const s = await cliente.post(`/ativar-acesso/${token}`, {}, { seguir: false });
    // entra logado (26/10/2026): a sessão abre no clique do e-mail, sem a tela de entrada
    expect(s.headers.get("location")).toBe("/?ativado=1");
    expect(s.headers.get("set-cookie") ?? "").toMatch(/csso_sessao=[^;]+;.*HttpOnly/i);
    const inicio = await cliente.get("/?ativado=1");
    expect(inicio.status).toBe(200);
    expect(inicio.text).toContain("Acesso ativado");
    const c = (await conta(MAIL))!;
    expect(c.servidor_id).not.toBeNull();
    expect(c.ultimo_login_em).not.toBeNull();
    // e a senha escolhida continua valendo na entrada comum
    await entrar(novoCliente(), c.login, SENHA);
    const aviso = (await caixa()).find((x) => x.tipo === ativar_acesso.TIPO_AVISO_ATIVADO)!;
    expect(aviso.destinatario).toBe(MAIL);
    expect(aviso.corpo).toContain("Esqueci minha senha");
    // a senha guardada saiu do registro do link
    const linhas = await db.select().from(e.ativacao_acesso);
    expect(linhas.every((l) => l.senha_hash === null)).toBe(true);
  });

  it("a conta criada no cadastro (ainda sem senha) também ativa com a senha escolhida", async () => {
    const [s] = await servidora();
    await criarUsuario(db, { login: MAIL, email: MAIL, servidor_id: s!.id, perfis: ["servidor_consulta"] });
    await db.update(e.usuario).set({ senha_hash: ativar_acesso.SEM_SENHA }).where(eq(e.usuario.email, MAIL));
    await ativar();
    const token = token_de((await ultimo_link()).corpo!);
    expect((await cliente.get(`/ativar-acesso/${token}`)).text).toContain("Confirmar e ativar o acesso");
    await cliente.post(`/ativar-acesso/${token}`, {});
    await entrar(novoCliente(), MAIL, SENHA);
  });

  it("conta que já tem senha não a troca por um clique: o link volta a pedir a senha", async () => {
    const [s] = await servidora();
    await criarUsuario(db, { login: MAIL, email: MAIL, servidor_id: s!.id, perfis: ["servidor_consulta"] });
    await ativar();
    const m = await ultimo_link();
    expect(m.corpo).not.toContain("NÃO CONFIRME");
    const token = token_de(m.corpo!);
    expect((await cliente.get(`/ativar-acesso/${token}`)).text).toContain("Defina a sua senha");
    // sem a senha nova, o POST não troca nada
    expect((await cliente.post(`/ativar-acesso/${token}`, {})).status).toBe(422);
    await entrar(novoCliente(), MAIL);
  });

  it("senha fraca ou que não confere: o erro é o mesmo para qualquer SIAPE, e nada sai", async () => {
    await servidora();
    const r = await ativar({ nova: "curta", confirmacao: "curta" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Senha fraca");
    const r2 = await cliente.post("/ativar-acesso", { siape: "9999999", email: MAIL, nova: "curta", confirmacao: "curta" }, ip_novo());
    expect(r2.status).toBe(422);
    expect(await caixa()).toHaveLength(0);
  });
});
