/**
 * Entrar, sair, trocar senha, primeiro acesso, bloqueio e sessão.
 *
 * Porte de `test_politica_senha.py`, `test_login_robusto.py`,
 * `test_retencao_sessao.py`, das partes de autenticação (CA-12) de
 * `test_web_fluxo.py` e de `test_rotas_permissoes.py` (quem-sou-eu, sair).
 * Onde o Python usava `/kanban` ou `/processos` como "tela que exige sessão",
 * aqui entra `/modulos` — as telas dos módulos são portadas por outro trecho.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { count, eq, lt } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { agora_utc } from "../src/db/esquema/base.js";
import { obterConfig, redefinirConfig } from "../src/config.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import { bancoLimpo, contas, entrar, naTransacao, SENHA_TESTE } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

// =====================================================================
// Política de senha
// =====================================================================
describe("política de senha", () => {
  it("mínimo é seis", () => {
    expect(autenticacao.TAMANHO_MINIMO_SENHA).toBe(6);
  });

  it.each(["csso26", "Fab2026", "Lab7x9", "a1b2c3"])("aceita %s", (senha) => {
    expect(autenticacao.politica_de_senha(senha)).toEqual([]);
  });

  it.each([
    ["a1b2", "mínimo de 6 caracteres"],
    ["", "mínimo de 6 caracteres"],
    ["somenteletras", "misture letras e números"],
    ["123456789", "misture letras e números"],
    ["abc123", "senha trivial"],
    ["Senha123", "senha trivial"],
  ])("recusa %j (%s)", (senha, problema) => {
    expect(autenticacao.politica_de_senha(senha)).toContain(problema);
  });

  it("hash continua Argon2id", async () => {
    const hash = await autenticacao.gerar_hash("csso26");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("csso26");
    expect(await autenticacao.conferir_senha(hash, "csso26")).toBe(true);
    expect(await autenticacao.conferir_senha(hash, "csso27")).toBe(false);
  });

  it("hash é salgado", async () => {
    expect(await autenticacao.gerar_hash("csso26")).not.toBe(await autenticacao.gerar_hash("csso26"));
  });

  it("hash torto não confere e não derruba", async () => {
    expect(await autenticacao.conferir_senha("nao-e-hash", "x")).toBe(false);
    expect(await autenticacao.conferir_senha("$argon2id$lixo", "x")).toBe(false);
  });

  it("confere o hash que o argon2-cffi do Python gravou (PHC compatível)", async () => {
    // gerado por `PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2).hash('abc')`
    const python = "$argon2id$v=19$m=65536,t=3,p=2$iWURK7phZM9kpNgaH67+wQ$Jl3VspNMd9lEJf/yDYxKte8DOqz/KnJnYtYGW9LvCnw";
    expect(await autenticacao.conferir_senha(python, "abc")).toBe(true);
    expect(await autenticacao.conferir_senha(python, "abd")).toBe(false);
  });

  it("o custo de produção continua o do RFC 9106", () => {
    expect({ ...autenticacao.PARAMETROS_ARGON2_PRODUCAO }).toEqual({
      time_cost: 3,
      memory_cost: 65536,
      parallelism: 2,
    });
  });

  it("o hasher de produção nasce dos parâmetros de produção", () => {
    // lê a fonte, e não o parâmetro do processo (que a suíte trocou pelo barato)
    const fonte = readFileSync(new URL("../src/servicos/autenticacao.ts", import.meta.url), "utf8");
    expect(fonte).toContain("let _parametros: ParametrosArgon2 = { ...PARAMETROS_ARGON2_PRODUCAO };");
  });

  it("o global POLITICA_SENHA leva os mesmos números ao template", async () => {
    const r = await novoCliente().get("/login");
    expect(r.status).toBe(200);
    // a barra de força só está no primeiro acesso e na troca; renderiza a troca
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const troca = await cliente.get("/trocar-senha");
    expect(troca.text).toContain('"minimo":6');
    expect(troca.text).toContain('"senha123456"');
  });

  it("nenhuma senha em claro no banco", async () => {
    for (const u of await db.select().from(e.usuario)) {
      expect(u.senha_hash).not.toContain(SENHA_TESTE);
      expect(u.senha_hash.startsWith("$argon2id$")).toBe(true);
    }
  });
});

// =====================================================================
// Login robusto
// =====================================================================
describe("login", () => {
  it("ignora maiúsculas no identificador", async () => {
    const cliente = novoCliente();
    for (const variante of ["coordenador_csso", "COORDENADOR_CSSO", "Coordenador_CSSO"]) {
      const r = await cliente.post("/login", { login: variante, senha: SENHA_TESTE }, { seguir: false });
      expect(r.status, variante).toBe(303);
      await cliente.get("/sair");
    }
  });

  it("ignora espaços em volta", async () => {
    const r = await novoCliente().post("/login", { login: "  coordenador_csso  ", senha: SENHA_TESTE }, { seguir: false });
    expect(r.status).toBe(303);
  });

  it("a senha continua sensível a maiúsculas", async () => {
    const r = await novoCliente().post("/login", { login: "coordenador_csso", senha: SENHA_TESTE.toLowerCase() });
    expect(r.text).toContain("inválidos");
  });

  it("o erro aparece uma vez só", async () => {
    const r = await novoCliente().post("/login", { login: "ninguem", senha: "x" });
    expect(r.text.split("Usuário ou senha inválidos.").length - 1).toBe(1);
  });

  it("usuário inexistente não bloqueia conta alheia", async () => {
    // os testes deste arquivo dividem o banco: zera o que as senhas erradas de antes deixaram
    await db.update(e.usuario).set({ tentativas_falhas: 0, bloqueado_ate: null });
    const cliente = novoCliente();
    for (let i = 0; i < 6; i++) await cliente.post("/login", { login: "nao_existe", senha: "x" });
    for (const u of await db.select().from(e.usuario)) {
      expect(u.tentativas_falhas).toBe(0);
      expect(u.bloqueado_ate).toBeNull();
    }
  });

  it("buscar_por_login", async () => {
    expect(await autenticacao.buscar_por_login(db, "AUDITOR_INTERNO")).not.toBeNull();
    expect(await autenticacao.buscar_por_login(db, " auditor_interno ")).not.toBeNull();
    expect(await autenticacao.buscar_por_login(db, "auditor_intern")).toBeNull();
    expect(await autenticacao.buscar_por_login(db, "")).toBeNull();
    expect(await autenticacao.buscar_por_login(db, null as unknown as string)).toBeNull();
  });

  it("entra pelo e-mail, sem depender de caixa nem de espaço", async () => {
    const conta = (await autenticacao.buscar_por_login(db, "auditor_interno"))!;
    expect(conta.email).toBeTruthy();
    expect((await autenticacao.buscar_por_login(db, conta.email))!.id).toBe(conta.id);
    expect((await autenticacao.buscar_por_login(db, conta.email.toUpperCase()))!.id).toBe(conta.id);
    expect((await autenticacao.buscar_por_login(db, `  ${conta.email}  `))!.id).toBe(conta.id);
    expect(await autenticacao.buscar_por_login(db, "ninguem@ufvjm.edu.br")).toBeNull();
  });

  it("a tela aceita o e-mail, e o nome de usuário antigo continua valendo", async () => {
    const email = (await autenticacao.buscar_por_login(db, "coordenador_csso"))!.email;
    const r = await novoCliente().post("/login", { login: email, senha: SENHA_TESTE }, { seguir: false });
    expect(r.status).toBe(303);
    const r2 = await novoCliente().post("/login", { login: "coordenador_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(r2.status).toBe(303);
  });

  it("a tela de login pede e-mail", async () => {
    const corpo = (await novoCliente().get("/login")).text;
    expect(corpo).toContain("E-mail");
    expect(corpo).toContain("nome@ufvjm.edu.br");
    expect(corpo).not.toContain("Usuário</label>");
  });

  it("login não vaza o identificador perto do título", async () => {
    const r = await novoCliente().post("/login", { login: "inexistente", senha: "x" });
    expect(r.text).toContain("Usuário ou senha inválidos");
    expect(r.text.split("<title>")[1]!.slice(0, 400)).not.toContain("inexistente");
  });

  it("o identificador volta ao formulário; a senha nunca", async () => {
    const r = await novoCliente().post("/login", { login: "coordenador_csso", senha: "SenhaErrada99" });
    expect(r.text).toContain('value="coordenador_csso"');
    expect(r.text).not.toContain("SenhaErrada99");
    // devolve a tentativa: a conta não pode ficar travada para os outros testes
    await db.update(e.usuario).set({ tentativas_falhas: 0 }).where(eq(e.usuario.login, "coordenador_csso"));
  });

  it("usuário derivado do e-mail", () => {
    const d = autenticacao.usuario_a_partir_do_email;
    expect(d("Fabricio.Andrade@ufvjm.edu.br")).toBe("fabricio.andrade");
    expect(d("nome+marca@dominio.br")).toBe("nomemarca");
    expect(d("")).toBe("usuario");
    expect(d("@só.acento")).toBe("usuario");
  });

  it("login leva ao despachante /inicio, e não ao painel", async () => {
    const r = await novoCliente().post("/login", { login: "almoxarife_sesmt", senha: SENHA_TESTE }, { seguir: false });
    expect(r.location).toBe("/inicio");
  });

  it("o login só devolve para dentro do sistema", async () => {
    const cliente = novoCliente();
    for (const fora of ["https://evil.example", "//evil.example", "/\\evil.example", "inicio"]) {
      const tela = await cliente.get("/login?" + new URLSearchParams({ proximo: fora }).toString());
      expect(tela.text, fora).toContain('name="proximo" value="/inicio"');
      const r = await cliente.post(
        "/login",
        { login: "coordenador_csso", senha: SENHA_TESTE, proximo: fora },
        { seguir: false },
      );
      expect(r.location, fora).toBe("/inicio");
      await cliente.get("/sair");
    }
    const r = await cliente.post(
      "/login",
      { login: "coordenador_csso", senha: SENHA_TESTE, proximo: "/processos?estado=EM_TRIAGEM" },
      { seguir: false },
    );
    expect(r.location).toBe("/processos?estado=EM_TRIAGEM");
  });

  it("quem precisa trocar a senha vai para /trocar-senha, com a faixa", async () => {
    const { criarUsuario } = await import("./ajuda");
    await criarUsuario(db, { login: "provisoria", perfis: ["secretaria_csso"], precisa_trocar_senha: true });
    const cliente = novoCliente();
    const r = await cliente.post("/login", { login: "provisoria", senha: SENHA_TESTE }, { seguir: false });
    expect(r.location).toBe("/trocar-senha");
    const tela = await cliente.get("/trocar-senha");
    expect(tela.status).toBe(200);
  });

  it("/quem-sou-eu", async () => {
    const cliente = novoCliente();
    expect((await cliente.get("/quem-sou-eu")).json()).toEqual({ autenticado: false });
    await entrar(cliente, "coordenador_csso");
    const dados = (await cliente.get("/quem-sou-eu")).json();
    expect(dados.autenticado).toBe(true);
    expect(dados.permissoes).toContain("parecer.assinar");
    expect(dados.perfis).toEqual(["coordenador_csso"]);
  });

  it("sair revoga a sessão", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const token = cliente.cookies.get(autenticacao.COOKIE_SESSAO)!;
    await cliente.get("/sair", { seguir: false });
    expect(await autenticacao.sessao_valida(db, token)).toBeNull();
    expect((await cliente.get("/modulos", { seguir: false })).status).toBe(303);
  });

  it("sem sessão, tela vai para o login", async () => {
    const r = await novoCliente().get("/modulos", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });
});

// =====================================================================
// Troca de senha e sessões
// =====================================================================
describe("troca de senha e sessões", () => {
  it("depois de trocar a senha, a antiga não serve", async () => {
    const { criarUsuario } = await import("./ajuda");
    await criarUsuario(db, { login: "troca1", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    await entrar(cliente, "troca1");
    const r = await cliente.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova: "novasenha1", confirmacao: "novasenha1" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(r.location).toBe("/inicio");
    await cliente.get("/sair");
    const velha = await cliente.post("/login", { login: "troca1", senha: SENHA_TESTE });
    expect(velha.text).toContain("inválidos");
    const nova = await cliente.post("/login", { login: "troca1", senha: "novasenha1" }, { seguir: false });
    expect(nova.status).toBe(303);
  });

  it("recusas da troca: atual errada, confirmação, senha fraca", async () => {
    const { criarUsuario } = await import("./ajuda");
    await criarUsuario(db, { login: "troca2", perfis: ["secretaria_csso"] });
    const cliente = novoCliente();
    await entrar(cliente, "troca2");
    let r = await cliente.post("/trocar-senha", { senha_atual: "errada", nova: "novasenha1", confirmacao: "novasenha1" });
    expect(r.text).toContain("Senha atual incorreta.");
    r = await cliente.post("/trocar-senha", { senha_atual: SENHA_TESTE, nova: "novasenha1", confirmacao: "outra123" });
    expect(r.text).toContain("A confirmação não confere.");
    r = await cliente.post("/trocar-senha", { senha_atual: SENHA_TESTE, nova: "abc123", confirmacao: "abc123" });
    expect(r.text).toContain("Senha fraca");
  });

  it("a autotroca de senha derruba as OUTRAS sessões e poupa a de quem trocou (I-1)", async () => {
    const { criarUsuario } = await import("./ajuda");
    await criarUsuario(db, { login: "troca3", perfis: ["coordenador_csso"] });
    const eu = novoCliente();
    const outra = novoCliente();
    await entrar(eu, "troca3");
    await entrar(outra, "troca3");
    expect((await outra.get("/modulos")).status).toBe(200);
    const r = await eu.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova: "trocada2026", confirmacao: "trocada2026" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const caiu = await outra.get("/modulos", { seguir: false });
    expect(caiu.status).toBe(303);
    expect(caiu.location).toContain("/login");
    expect((await eu.get("/modulos")).status).toBe(200);
  });

  it("o reset por administrador continua derrubando tudo", async () => {
    await naTransacao(async (tx) => {
      const [conta, token] = await autenticacao.autenticar(tx, "auditor_interno", SENHA_TESTE);
      expect(await autenticacao.sessao_valida(tx, token)).not.toBeNull();
      expect(await autenticacao.revogar_do_usuario(tx, conta.id)).toBeGreaterThanOrEqual(1);
      expect(await autenticacao.sessao_valida(tx, token)).toBeNull();
    });
  });

  it("sessão revogada é rejeitada imediatamente (CA-12)", async () => {
    const { criarUsuario } = await import("./ajuda");
    const conta = await criarUsuario(db, { login: "revogada", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    await entrar(cliente, "revogada");
    expect((await cliente.get("/modulos")).status).toBe(200);
    await naTransacao((tx) => autenticacao.revogar_do_usuario(tx, conta.id));
    const r = await cliente.get("/modulos", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("o token de sessão é assinado com a chave secreta (I-4)", () => {
    const original = process.env.CSSO_CHAVE_SECRETA;
    try {
      process.env.CSSO_CHAVE_SECRETA = "chave-de-teste-a";
      redefinirConfig();
      const com_a = autenticacao._hash_token("token-qualquer");
      process.env.CSSO_CHAVE_SECRETA = "chave-de-teste-b";
      redefinirConfig();
      const com_b = autenticacao._hash_token("token-qualquer");
      expect(com_a).not.toBe(com_b);
      expect(com_a.length).toBe(64);
      expect(com_a).not.toBe(createHash("sha256").update("token-qualquer").digest("hex"));
    } finally {
      process.env.CSSO_CHAVE_SECRETA = original;
      redefinirConfig();
    }
  });

  it("rotacionar a chave secreta derruba toda sessão aberta", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/modulos")).status).toBe(200);
    const original = process.env.CSSO_CHAVE_SECRETA;
    try {
      process.env.CSSO_CHAVE_SECRETA = "chave-rotacionada-depois-do-incidente";
      redefinirConfig();
      const depois = await cliente.get("/modulos", { seguir: false });
      expect(depois.status).toBe(303);
      expect(depois.location).toContain("/login");
    } finally {
      process.env.CSSO_CHAVE_SECRETA = original;
      redefinirConfig();
    }
  });
});

// =====================================================================
// Bloqueio e a tela de login que explica
// =====================================================================
describe("bloqueio e sessão expirada", () => {
  it("CA-12: bloqueia depois das tentativas, e diz até quando e a saída", async () => {
    const { criarUsuario } = await import("./ajuda");
    await criarUsuario(db, { login: "bloqueavel", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    const max = obterConfig().maxTentativas;
    for (let i = 0; i < max; i++) {
      const r = await cliente.post("/login", { login: "bloqueavel", senha: "errada" });
      expect(r.text).toContain("inválidos");
    }
    const r = await cliente.post("/login", { login: "bloqueavel", senha: SENHA_TESTE });
    expect(r.text.toLowerCase()).toContain("bloqueada");
    expect(r.text).toContain("Conta bloqueada até");
    expect(r.text).toContain("tentativas malsucedidas seguidas");
    expect(r.text).toContain("quem administra o sistema redefine");
    expect(r.text).not.toContain("temporariamente");
  });

  it("sessão expirada volta ao login com o motivo e o filtro", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    await cliente.get("/sair");
    cliente.cookies.set(autenticacao.COOKIE_SESSAO, "sessao-que-nao-vale-mais");
    const r = await cliente.get("/modulos?estado=EM_TRIAGEM&pagina=3", { seguir: false });
    expect(r.status).toBe(303);
    const destino = r.location!;
    expect(destino.startsWith("/login?")).toBe(true);
    expect(destino).toContain("motivo=sessao");
    expect(destino).toContain("proximo=%2Fmodulos%3Festado%3DEM_TRIAGEM%26pagina%3D3");
    const tela = await cliente.get(destino);
    expect(tela.text).toContain("Sua sessão expirou");
    expect(tela.text).toContain('value="/modulos?estado=EM_TRIAGEM&amp;pagina=3"');
  });

  it("envio com sessão expirada diz que nada foi gravado (proximo = Referer)", async () => {
    const cliente = novoCliente();
    cliente.cookies.set(autenticacao.COOKIE_SESSAO, "expirada");
    const r = await cliente.post(
      "/trocar-senha",
      { senha_atual: "x", nova: "y", confirmacao: "y" },
      { seguir: false, cabecalhos: { referer: "http://testserver/modulos?q=abc" } },
    );
    expect(r.status).toBe(303);
    expect(r.location).toContain("motivo=envio");
    expect(r.location).toContain("proximo=%2Fmodulos%3Fq%3Dabc");
    const tela = await cliente.get(r.location!);
    expect(tela.text).toContain("não foi salvo");
  });

  it("chegar sem cookie nenhum não é sessão expirada", async () => {
    const cliente = novoCliente();
    const r = await cliente.get("/modulos", { seguir: false });
    expect(r.location).not.toContain("motivo=");
    const tela = await cliente.get(r.location!);
    expect(tela.text).not.toContain("sessão expirou");
  });
});

// =====================================================================
// Retenção da sessão (90 dias após expirar)
// =====================================================================
describe("retenção de sessão", () => {
  async function sessao(usuario_id: number, expirou_ha_dias: number, revogada = false): Promise<number> {
    const expira = new Date(agora_utc().getTime() - expirou_ha_dias * 86_400_000);
    const [s] = await db
      .insert(e.sessao)
      .values({
        token_hash: `${usuario_id}-${expirou_ha_dias}-${revogada}-${Math.random()}`.padEnd(64, "0").slice(0, 64),
        usuario_id,
        criada_em: new Date(expira.getTime() - 12 * 3600_000),
        expira_em: expira,
        ip: "10.0.73.50",
        revogada,
      })
      .returning();
    return s!.id;
  }
  async function conta(): Promise<number> {
    const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    return u!.id;
  }

  it("expurgo apaga só o que passou do prazo", async () => {
    await db.delete(e.sessao);
    const id = await conta();
    const vencida = await sessao(id, 91);
    const vencida_revogada = await sessao(id, 200, true);
    const no_prazo = await sessao(id, 89);
    const viva = await sessao(id, -0.5);
    expect(await naTransacao((tx) => autenticacao.expurgar_sessoes(tx))).toBe(2);
    const restantes = new Set((await db.select({ id: e.sessao.id }).from(e.sessao)).map((l) => l.id));
    expect(restantes.has(vencida)).toBe(false);
    expect(restantes.has(vencida_revogada)).toBe(false);
    expect(restantes.has(no_prazo)).toBe(true);
    expect(restantes.has(viva)).toBe(true);
  });

  it("o prazo é o mesmo do registro de acesso", async () => {
    await db.delete(e.sessao);
    const id = await conta();
    await sessao(id, 31);
    await sessao(id, 29);
    process.env.CSSO_LOG_RETENCAO_DIAS = "30";
    try {
      expect(await naTransacao((tx) => autenticacao.expurgar_sessoes(tx))).toBe(1);
    } finally {
      delete process.env.CSSO_LOG_RETENCAO_DIAS;
    }
  });

  it("o login poda a tabela, e a sessão nova continua valendo", async () => {
    await sessao(await conta(), 120);
    const cliente = novoCliente();
    const r = await cliente.post("/login", { login: "coordenador_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(r.status).toBe(303);
    const limite = new Date(agora_utc().getTime() - 90 * 86_400_000);
    const [velhas] = await db.select({ n: count() }).from(e.sessao).where(lt(e.sessao.expira_em, limite));
    const [vivas] = await db.select({ n: count() }).from(e.sessao);
    expect(Number(velhas!.n)).toBe(0);
    expect(Number(vivas!.n)).toBeGreaterThanOrEqual(1);
    expect((await cliente.get("/modulos", { seguir: false })).status).toBe(200);
  });
});
