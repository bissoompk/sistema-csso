/**
 * O autocadastro do servidor no primeiro acesso (25/10/2026): o sistema não lê
 * o SIAPE, e quem ainda não está no cadastro de servidores se cadastra em
 * /ativar-acesso. O cadastro só nasce quando o link enviado ao e-mail
 * institucional digitado é confirmado; a tela responde igual a todo pedido.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as servico from "../src/servicos/ativar_acesso.js";
import { bancoLimpo, contas, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;
let n_ip = 0;

await bancoLimpo();
beforeAll(() => {
  servico.ajuste.piso_ms = 50;
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
});

const SIAPE = "3456789";
const EMAIL = "joao.novo@ufvjm.edu.br";
const SENHA = "uma frase de senha 2026";

function ip_novo() {
  n_ip += 1;
  return { cabecalhos: { "x-nf-client-connection-ip": `203.0.113.${(n_ip % 250) + 1}` } };
}

async function lotacao_e_cargo() {
  const [cargo] = await db.insert(e.cargo).values({ nome: "Técnico em Laboratório" }).returning();
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  return { cargo: cargo!, unidade: unidade! };
}

function pedir(campos: Record<string, string>, c: Cliente = cliente) {
  return c.post("/ativar-acesso", { siape: SIAPE, email: EMAIL, nome: "João Novo da Silva", nova: SENHA, confirmacao: SENHA, ...campos }, ip_novo());
}

async function caixa() {
  return db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
}

async function token_do_email(): Promise<string> {
  const linhas = (await caixa()).filter((l) => l.tipo === servico.TIPO_LINK);
  return linhas.at(-1)!.corpo!.match(/\/ativar-acesso\/([A-Za-z0-9_-]+)/)![1]!;
}

const sem_nonce = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce=""');

describe("autocadastro do servidor", () => {
  it("SIAPE fora do cadastro: o link vai ao e-mail digitado e o cadastro só nasce na confirmação", async () => {
    const { cargo, unidade } = await lotacao_e_cargo();
    const r = await pedir({ cargo_id: String(cargo.id), unidade_uorg_id: String(unidade.id) });
    expect(r.status).toBe(200);
    expect(r.text).toContain(servico.RESPOSTA_PADRAO.slice(0, 40));
    const enviados = await caixa();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.destinatario).toBe(EMAIL);
    expect(enviados[0]!.corpo).toContain("O cadastro só é criado quando você confirma");
    // o e-mail não leva nome nem SIAPE
    expect(enviados[0]!.corpo).not.toContain(SIAPE);
    expect(enviados[0]!.corpo).not.toContain("João");
    // antes de confirmar, nada no cadastro
    expect(await db.select().from(e.servidor).where(eq(e.servidor.siape, SIAPE))).toEqual([]);

    const token = await token_do_email();
    const tela = await cliente.get(`/ativar-acesso/${token}`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Confirme o seu e-mail");
    // abrir não cria
    expect(await db.select().from(e.servidor).where(eq(e.servidor.siape, SIAPE))).toEqual([]);

    const ok = await cliente.post(`/ativar-acesso/${token}`, {}, { seguir: false });
    expect(ok.status).toBe(303);
    // quem confirmou o e-mail entra logado, sem passar pela tela de entrada (26/10/2026)
    expect(ok.location).toBe("/?ativado=1");
    const [sv] = await db.select().from(e.servidor).where(eq(e.servidor.siape, SIAPE));
    expect([sv!.nome, sv!.email, sv!.cargo_id, sv!.unidade_uorg_id, sv!.situacao]).toEqual([
      "João Novo da Silva",
      EMAIL,
      cargo.id,
      unidade.id,
      "ATIVO",
    ]);
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.servidor_id, sv!.id));
    expect(conta!.email).toBe(EMAIL);
    const periodos = await db.select().from(e.servidor_lotacao).where(eq(e.servidor_lotacao.servidor_id, sv!.id));
    expect(periodos).toHaveLength(1);
    const ev = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.SERVIDOR_AUTOCADASTRADO));
    expect(ev.map((x) => x.entidade_id)).toEqual([sv!.id]);
    // a linha do pedido não guarda mais nem os dados nem a senha
    const linhas = await db.select().from(e.ativacao_acesso);
    expect(linhas.every((l) => l.dados_cadastro === null && l.senha_hash === null)).toBe(true);
    // e entra com a senha escolhida
    const login = await novoCliente().post("/login", { login: EMAIL, senha: SENHA }, { seguir: false });
    expect(login.status).toBe(303);
    expect(login.location).not.toContain("/login");
  });

  it("a tela é a mesma para quem está no cadastro, para quem se cadastra e para quem não casa", async () => {
    await db.insert(e.servidor).values({ siape: "1112223", nome: "Já Cadastrada", email: "ja.cadastrada@ufvjm.edu.br" });
    const respostas = [
      await pedir({}),
      await pedir({ siape: "1112223", email: "ja.cadastrada@ufvjm.edu.br" }),
      await pedir({ siape: "1112223", email: "outra@ufvjm.edu.br" }),
    ];
    for (const r of respostas) expect(r.status).toBe(200);
    expect(new Set(respostas.map((r) => sem_nonce(r.text))).size).toBe(1);
    // quem já está no cadastro: o nome digitado não muda nada
    const [ja] = await db.select().from(e.servidor).where(eq(e.servidor.siape, "1112223"));
    expect(ja!.nome).toBe("Já Cadastrada");
  });

  it("e-mail fora do domínio institucional é recusado na tela, igual para qualquer SIAPE", async () => {
    await db.insert(e.servidor).values({ siape: "1112223", nome: "Já Cadastrada", email: "ja.cadastrada@ufvjm.edu.br" });
    const a = await pedir({ email: "joao@gmail.com" });
    const b = await pedir({ siape: "1112223", email: "joao@gmail.com" });
    for (const r of [a, b]) {
      expect(r.status).toBe(422);
      expect(r.text).toContain("@ufvjm.edu.br");
    }
    expect(await caixa()).toHaveLength(0);
  });

  it("e-mail que já é de outro servidor: e-mail neutro, sem link e sem cadastro", async () => {
    await db.insert(e.servidor).values({ siape: "1112223", nome: "Outra Pessoa", email: EMAIL });
    const r = await pedir({});
    expect(r.status).toBe(200);
    const enviados = await caixa();
    expect(enviados.map((x) => x.tipo)).toEqual([servico.TIPO_NEUTRO]);
    expect(await db.select().from(e.servidor).where(eq(e.servidor.siape, SIAPE))).toEqual([]);
  });

  it("SIAPE cadastrado pela equipe entre o pedido e a confirmação: o link deixa de valer", async () => {
    await pedir({});
    const token = await token_do_email();
    await db.insert(e.servidor).values({ siape: SIAPE, nome: "Cadastrado pela Equipe", email: "outro.email@ufvjm.edu.br" });
    expect((await cliente.get(`/ativar-acesso/${token}`)).status).toBe(404);
    expect((await cliente.post(`/ativar-acesso/${token}`, {}, { seguir: false })).status).toBe(404);
    const servidores = await db.select().from(e.servidor).where(eq(e.servidor.siape, SIAPE));
    expect(servidores.map((s) => s.nome)).toEqual(["Cadastrado pela Equipe"]);
  });

  it("a tela do primeiro acesso pede nome, cargo e lotação e não diz mais que os dados vêm do SIAPE", async () => {
    const tela = await cliente.get("/ativar-acesso");
    expect(tela.text).toContain('name="nome"');
    expect(tela.text).toContain('name="cargo_id"');
    expect(tela.text).toContain('name="unidade_uorg_id"');
    expect(tela.text).toContain("o cadastro é criado com estes dados quando você confirmar o e-mail");
  });
});
