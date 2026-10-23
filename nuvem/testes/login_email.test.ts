/**
 * Login é o e-mail (23/10/2026, DESVIOS.md): o Cadastrar conta não pede mais
 * login, editar o e-mail leva o login junto, e a publicação converte as contas
 * antigas — só no banco com a marca de produção.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as auditoria from "../src/servicos/auditoria.js";
import { gravarMarca } from "../src/servicos/instalacao.js";
import { converter_logins_para_email } from "../src/servicos/login_email.js";
import * as producaoIniciar from "../ferramentas/producao-iniciar.js";
import * as redefinirSenha from "../ferramentas/redefinir-senha.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, SENHA_TESTE, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

const conta = async (id: number) => (await amb.db.select().from(e.usuario).where(eq(e.usuario.id, id)))[0]!;
const porEmail = async (email: string) =>
  (await amb.db.select().from(e.usuario).where(eq(e.usuario.email, email)))[0];
const eventos = (tipo: string) =>
  amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo)).orderBy(asc(e.historico_evento.id));

describe("Cadastrar conta", () => {
  it("o formulário não tem mais o campo Login", async () => {
    await entrar(amb.cliente, "admin_ti");
    const tela = (await amb.cliente.get("/usuarios")).text;
    expect(tela).not.toContain('id="conta-login"');
    expect(tela).not.toMatch(/id="ed-conta-\d+-login"/);
    expect(tela).toContain('<label for="conta-email">E-mail (login)</label>');
  });

  it("sem campo login, grava login = e-mail aparado e em minúsculas", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/usuarios", { nome: "Maria Nova", email: "  Maria.Nova@UFVJM.edu.br " });
    expect(r.status).toBe(200);
    expect(r.text).toContain("A pessoa entra com o e-mail Maria.Nova@UFVJM.edu.br");
    const nova = (await porEmail("Maria.Nova@UFVJM.edu.br"))!;
    expect(nova.login).toBe("maria.nova@ufvjm.edu.br");
    const senha = r.text.match(/Senha provisória: ([a-z0-9-]+)/)![1]!;
    // entra pelo e-mail, em qualquer caixa
    const entrou = await amb.novoCliente().post("/login", { login: "MARIA.NOVA@ufvjm.edu.br", senha }, { seguir: false });
    expect(entrou.status).toBe(303);
    expect(entrou.location).toBe("/trocar-senha");
  });

  it("um `login` que ainda venha no formulário é ignorado", async () => {
    await entrar(amb.cliente, "admin_ti");
    await amb.cliente.post("/usuarios", { login: "apelido", nome: "Rui", email: "rui@ufvjm.edu.br" });
    expect((await porEmail("rui@ufvjm.edu.br"))!.login).toBe("rui@ufvjm.edu.br");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "apelido"))).toHaveLength(0);
  });

  it("e-mail repetido (sem caixa) é recusado com mensagem clara, e nada é gravado", async () => {
    await entrar(amb.cliente, "admin_ti");
    await amb.cliente.post("/usuarios", { nome: "Ana", email: "ana@ufvjm.edu.br" });
    const r = await amb.cliente.post("/usuarios", { nome: "Outra Ana", email: "ANA@ufvjm.edu.br" });
    expect(r.text).toContain("o e-mail ANA@ufvjm.edu.br já é o login da conta de Ana");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.nome, "Outra Ana"))).toHaveLength(0);
  });

  it("o que não é e-mail é recusado", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/usuarios", { nome: "Sem Arroba", email: "semarroba" });
    expect(r.text).toContain("isto não parece um e-mail");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.nome, "Sem Arroba"))).toHaveLength(0);
  });
});

describe("Editar conta", () => {
  it("mudar o e-mail muda o login, auditado; mudar só o nome não toca no login", async () => {
    const alvo = await criarUsuario(amb.db, { login: "pessoa.antiga", email: "pessoa@teste.ufvjm.edu.br" });
    await entrar(amb.cliente, "superintendente");
    await amb.cliente.post(`/usuarios/${alvo.id}/dados`, { nome: "Pessoa Renomeada", email: alvo.email });
    expect((await conta(alvo.id)).login).toBe("pessoa.antiga");

    await amb.cliente.post(`/usuarios/${alvo.id}/dados`, { nome: "Pessoa Renomeada", email: "Pessoa.Nova@ufvjm.edu.br" });
    const depois = await conta(alvo.id);
    expect(depois.email).toBe("Pessoa.Nova@ufvjm.edu.br");
    expect(depois.login).toBe("pessoa.nova@ufvjm.edu.br");
    const campos = (await eventos("USUARIO_ALTERADO")).filter((x) => x.entidade_id === alvo.id).map((x) => x.campo);
    expect(campos).toEqual(expect.arrayContaining(["nome", "login", "email"]));
    await entrar(amb.novoCliente(), "pessoa.nova@ufvjm.edu.br");
  });

  it("e-mail de outra conta é recusado na edição", async () => {
    const alvo = await criarUsuario(amb.db, { login: "edita", email: "edita@teste.ufvjm.edu.br" });
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(`/usuarios/${alvo.id}/dados`, {
      nome: alvo.nome,
      email: "Coordenador_CSSO@teste.ufvjm.edu.br",
    });
    expect(r.text).toContain("já é o login da conta de Coordenador de Teste");
    expect((await conta(alvo.id)).login).toBe("edita");
  });

  it("em Minha conta, trocar o e-mail leva o login junto", async () => {
    const alvo = await criarUsuario(amb.db, { login: "titular", email: "titular@teste.ufvjm.edu.br" });
    await entrar(amb.cliente, "titular");
    await amb.cliente.post("/minha-conta/email", { email: "Titular.Novo@ufvjm.edu.br", senha_atual: SENHA_TESTE });
    expect((await conta(alvo.id)).login).toBe("titular.novo@ufvjm.edu.br");
  });
});

describe("Entrada", () => {
  it("entra pelo e-mail e, nas contas de teste, pelo login antigo; o rótulo é E-mail", async () => {
    const email = (await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso")))[0]!.email;
    await entrar(amb.novoCliente(), email);
    await entrar(amb.novoCliente(), email.toUpperCase());
    await entrar(amb.novoCliente(), "coordenador_csso");
    expect((await amb.novoCliente().get("/login")).text).toContain('<label for="login">E-mail</label>');
  });
});

describe("conversão das contas antigas na publicação", () => {
  it("sem a marca de produção, nada muda (banco de teste e contas de teste ficam como estão)", async () => {
    const antes = await amb.db.select({ id: e.usuario.id, login: e.usuario.login }).from(e.usuario).orderBy(asc(e.usuario.id));
    const r = await naTransacao((tx) => converter_logins_para_email(tx));
    expect(r.producao).toBe(false);
    expect(r.convertidas).toEqual([]);
    const depois = await amb.db.select({ id: e.usuario.id, login: e.usuario.login }).from(e.usuario).orderBy(asc(e.usuario.id));
    expect(depois).toEqual(antes);
    expect(await eventos(auditoria.LOGIN_CONVERTIDO_PARA_EMAIL)).toHaveLength(0);
  });

  it("com a marca: converte, audita, pula conflitos e é idempotente", async () => {
    // e-mail vazio, e o e-mail que é o login (que não sai) de outra conta: os conflitos
    const vazio = await criarUsuario(amb.db, { login: "bloqueia@ufvjm.edu.br", email: "" });
    const bloqueada = await criarUsuario(amb.db, { login: "bloqueada", email: "Bloqueia@ufvjm.edu.br" });
    const dono = await criarUsuario(amb.db, { login: "disputado@ufvjm.edu.br", email: "dono@ufvjm.edu.br" });
    const disputa = await criarUsuario(amb.db, { login: "disputa", email: "Disputado@ufvjm.edu.br" });
    // a cadeia: a conta cujo e-mail era o login antigo de outra que converte antes
    const encadeada = await criarUsuario(amb.db, { login: "encadeada", email: "Anterior@ufvjm.edu.br" });
    const anterior = await criarUsuario(amb.db, { login: "anterior@ufvjm.edu.br", email: "outro@ufvjm.edu.br" });
    await gravarMarca(amb.db, "teste/marca", "vitest");

    const r = await naTransacao((tx) => converter_logins_para_email(tx));
    expect(r.producao).toBe(true);

    const coord = (await porEmail("coordenador_csso@teste.ufvjm.edu.br"))!;
    expect(coord.login).toBe("coordenador_csso@teste.ufvjm.edu.br");
    expect((await conta(dono.id)).login).toBe("dono@ufvjm.edu.br");
    expect((await conta(anterior.id)).login).toBe("outro@ufvjm.edu.br");
    expect((await conta(encadeada.id)).login).toBe("anterior@ufvjm.edu.br");
    // a disputa só converte se o dono largou o login — e largou: converte também
    expect((await conta(disputa.id)).login).toBe("disputado@ufvjm.edu.br");
    // o e-mail vazio fica, e quem dependia do login dele também; os dois são informados
    expect((await conta(vazio.id)).login).toBe("bloqueia@ufvjm.edu.br");
    expect((await conta(bloqueada.id)).login).toBe("bloqueada");
    expect(r.puladas).toEqual([
      { id: vazio.id, login: "bloqueia@ufvjm.edu.br", motivo: "e-mail vazio" },
      { id: bloqueada.id, login: "bloqueada", motivo: `o e-mail 'bloqueia@ufvjm.edu.br' já é o login de outra conta (id ${vazio.id})` },
    ]);

    const ev = await eventos(auditoria.LOGIN_CONVERTIDO_PARA_EMAIL);
    expect(ev).toHaveLength(r.convertidas.length);
    const doCoord = ev.find((x) => x.entidade_id === coord.id)!;
    expect(doCoord.campo).toBe("login");
    expect(doCoord.valor_anterior).toBe("coordenador_csso");
    expect(doCoord.valor_novo).toBe("coordenador_csso@teste.ufvjm.edu.br");
    expect(auditoria.rotulo_evento(auditoria.LOGIN_CONVERTIDO_PARA_EMAIL)).toBe("Login convertido para o e-mail");
    expect((await auditoria.cadeia_integra(amb.db))[0]).toBe(true);

    // de novo: nada a converter, nenhum evento a mais
    const r2 = await naTransacao((tx) => converter_logins_para_email(tx));
    expect(r2.convertidas).toEqual([]);
    expect(r2.puladas.map((p) => p.id)).toEqual([vazio.id, bloqueada.id]);
    expect(await eventos(auditoria.LOGIN_CONVERTIDO_PARA_EMAIL)).toHaveLength(ev.length);

    // a conta convertida entra pelo e-mail; o login antigo deixou de existir
    await entrar(amb.novoCliente(), "coordenador_csso@teste.ufvjm.edu.br");
    const antigo = await amb.novoCliente().post("/login", { login: "coordenador_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(antigo.status).toBe(200);
  });

  it("o mesmo e-mail (com espaço) em duas contas: nenhuma das duas converte", async () => {
    const a = await criarUsuario(amb.db, { login: "gemea.a", email: "gemea@ufvjm.edu.br" });
    const b = await criarUsuario(amb.db, { login: "gemea.b", email: " gemea@ufvjm.edu.br" });
    await gravarMarca(amb.db, "teste/marca", "vitest");
    const r = await naTransacao((tx) => converter_logins_para_email(tx));
    expect((await conta(a.id)).login).toBe("gemea.a");
    expect((await conta(b.id)).login).toBe("gemea.b");
    expect(r.puladas.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.puladas[0]!.motivo).toContain("mais de uma conta");
  });

  it("a sessão aberta não cai com a conversão", async () => {
    const cliente = amb.novoCliente();
    await entrar(cliente, "tecnico_seguranca");
    await gravarMarca(amb.db, "teste/marca", "vitest");
    await naTransacao((tx) => converter_logins_para_email(tx));
    expect((await cliente.get("/minha-conta")).status).toBe(200);
  });
});

describe("linha de comando", () => {
  it("producao-iniciar não exige --login; o antigo é aceito e ignorado", () => {
    const base = ["--nome", "Fulano", "--email", "Fulano@ufvjm.edu.br", "--url-publica", "https://sisa.ufvjm.edu.br"];
    const ok = producaoIniciar.lerOpcoes(base) as producaoIniciar.Opcoes;
    expect(ok.email).toBe("Fulano@ufvjm.edu.br");
    expect(ok.loginIgnorado).toBeNull();
    const antigo = producaoIniciar.lerOpcoes(["--login", "fulano", ...base]) as producaoIniciar.Opcoes;
    expect(antigo.loginIgnorado).toBe("fulano");
  });

  it("redefinir-senha acha a conta pelo e-mail e pelo login antigo", async () => {
    const email = (await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "superintendente")))[0]!.email;
    expect(await naTransacao((tx) => redefinirSenha.redefinir(tx, email.toUpperCase()))).not.toBeNull();
    expect(await naTransacao((tx) => redefinirSenha.redefinir(tx, "superintendente"))).not.toBeNull();
  });
});
