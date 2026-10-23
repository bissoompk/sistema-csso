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

const TERC = {
  vinculo: "TERCEIRIZADO",
  nome: "Joana Fictícia Lima",
  email: "joana.ficticia@empresa-exemplo.com.br",
  organizacao: "Empresa Exemplo Ltda",
  matricula: "Restaurante universitário",
  maior_de_idade: "1",
};
const DISC = { ...TERC, vinculo: "DISCENTE", email: "pedro.ficticio@ufvjm.edu.br", organizacao: "Engenharia Civil", matricula: "20261234" };

const pedir = (campos: Record<string, string>, c: Cliente = cliente) => c.post("/cadastre-se", campos, ip_novo());
const caixa = () => db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
const pedidos = () => db.select().from(e.pedido_conta).orderBy(asc(e.pedido_conta.id));
const conta = async (email: string) => (await db.select().from(e.usuario).where(eq(e.usuario.email, email)))[0];

function token_de(corpo: string): string {
  return corpo.match(/\/ativar-acesso\/([A-Za-z0-9_-]+)/)![1]!;
}

describe("o pedido", () => {
  it("a tela pergunta o vínculo, e o servidor segue para o primeiro acesso pelo cadastro", async () => {
    const r = await cliente.get("/cadastre-se");
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/ativar-acesso"');
    expect(r.text).toContain("vinculo=TERCEIRIZADO");
    expect(r.text).toContain("vinculo=DISCENTE");
    expect((await cliente.get("/cadastre-se?vinculo=DISCENTE")).text).toContain("Matrícula");
  });

  it("o login tem Primeiro acesso e Esqueci minha senha", async () => {
    const t = (await cliente.get("/login")).text;
    expect(t).toContain('href="/cadastre-se"');
    expect(t).toContain('href="/esqueci-senha"');
  });

  it("o pedido não cria conta: fica na fila, com pendência, e a resposta é a padrão", async () => {
    const r = await pedir(TERC);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Pedido recebido");
    expect(await conta(TERC.email)).toBeUndefined();
    const [p] = await pedidos();
    expect(p).toMatchObject({ situacao: "PENDENTE", vinculo: "TERCEIRIZADO", nome: TERC.nome });
    const [pend] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, `pedido_conta:${p!.id}`));
    expect(pend).toMatchObject({ tipo: "CONTA_A_CONFERIR", concluida: false, responsavel_id: null });
    expect(pend!.descricao).not.toContain("Joana");
    const ev = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.PEDIDO_DE_CONTA_RECEBIDO));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.descricao).not.toContain("Joana");
    expect(ev[0]!.descricao).not.toContain("@");
    expect(await caixa()).toHaveLength(0);
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
    expect(r.text).toContain("Pedido recebido");
    await pedir(TERC);
    const r3 = await pedir(TERC); // o segundo pedido do mesmo e-mail
    expect(r3.text).toContain("Pedido recebido");
    expect((await pedidos()).filter((p) => p.situacao === "PENDENTE")).toHaveLength(1);
    const neutros = (await caixa()).filter((m) => m.tipo === servico.TIPO_NEUTRO);
    expect(neutros.map((m) => m.destinatario).sort()).toEqual([TERC.email, "serv.ficticia@ufvjm.edu.br"].sort());
  });

  it("teto por endereço de rede", async () => {
    const mesmo = { cabecalhos: { "x-nf-client-connection-ip": "203.0.113.250" } };
    for (let i = 0; i < servico.PEDIDOS_POR_HORA_POR_IP + 2; i++) {
      await cliente.post("/cadastre-se", { ...TERC, email: `p${i}@exemplo.org` }, mesmo);
    }
    expect(await pedidos()).toHaveLength(servico.PEDIDOS_POR_HORA_POR_IP);
  });
});

describe("a conferência da equipe", () => {
  it("quem não cria conta não abre a fila", async () => {
    const r = await (await entrar(novoCliente(), "secretaria_csso")).get("/usuarios/pedidos", { seguir: false });
    expect(r.status).toBe(403);
  });

  it("aprovar cria a conta com o perfil do vínculo, sem servidor e sem senha, e manda o link", async () => {
    await pedir(DISC);
    const [p] = await pedidos();
    const sup = await entrar(novoCliente(), "superintendente");
    expect((await sup.get("/usuarios")).text).toContain('href="/usuarios/pedidos"');
    expect((await sup.get("/usuarios/pedidos")).text).toContain(DISC.nome);
    const r = await sup.post(`/usuarios/pedidos/${p!.id}/aprovar`, {});
    expect(r.status).toBe(200);
    expect(r.text).toContain("aprovado");
    const c = (await conta(DISC.email))!;
    expect(c).toMatchObject({ servidor_id: null, senha_hash: ativar_acesso.SEM_SENHA, nome: DISC.nome });
    const atual = await carregar_usuario_atual(db, c.id);
    expect(atual.pode("treinamento.ver")).toBe(true);
    expect(atual.pode("acidente.comunicar")).toBe(true);
    expect(atual.pode("epi.requisitar")).toBe(false);
    const [pend] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, `pedido_conta:${p!.id}`));
    expect(pend!.concluida).toBe(true);
    // o link define a senha e a pessoa entra
    const mensagem = (await caixa()).find((m) => m.tipo === ativar_acesso.TIPO_LINK)!;
    expect(mensagem.destinatario).toBe(DISC.email);
    const token = token_de(mensagem.corpo!);
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(200);
    const s = await cliente.post(`/ativar-acesso/${token}`, { nova: "Uma frase de senha 2026", confirmacao: "Uma frase de senha 2026" }, { seguir: false });
    expect(s.status).toBe(303);
    expect(s.headers.get("location")).toContain("/login?motivo=ativada");
    await entrar(novoCliente(), c.login, "Uma frase de senha 2026");
    // o link não serve de novo
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(404);
  });

  it("recusar avisa a pessoa sem o motivo e não cria conta", async () => {
    await pedir(TERC);
    const [p] = await pedidos();
    const sup = await entrar(novoCliente(), "superintendente");
    expect((await sup.post(`/usuarios/pedidos/${p!.id}/recusar`, { motivo: "" })).status).toBe(422);
    await sup.post(`/usuarios/pedidos/${p!.id}/recusar`, { motivo: "Empresa sem contrato vigente" });
    expect(await conta(TERC.email)).toBeUndefined();
    const [r] = await pedidos();
    expect(r).toMatchObject({ situacao: "RECUSADO", motivo: "Empresa sem contrato vigente" });
    const aviso = (await caixa()).find((m) => m.tipo === servico.TIPO_RECUSA)!;
    expect(aviso.destinatario).toBe(TERC.email);
    expect(aviso.corpo).not.toContain("contrato");
    // decidido não se decide de novo
    expect((await sup.post(`/usuarios/pedidos/${p!.id}/aprovar`, {})).status).toBe(422);
  });

  it("aprovar recusa o e-mail que ganhou conta depois do pedido", async () => {
    await pedir(TERC);
    const [p] = await pedidos();
    await criarUsuario(db, { login: "outra", email: TERC.email });
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await sup.post(`/usuarios/pedidos/${p!.id}/aprovar`, {});
    expect(r.status).toBe(422);
    expect(r.text).toContain("Já existe uma conta");
  });

  it("o pedido velho é apagado pela rotina", async () => {
    await pedir(TERC);
    const n = await servico.expurgar(db, new Date(Date.now() + 91 * 86_400_000));
    expect(n).toBe(1);
    expect(await pedidos()).toHaveLength(0);
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
