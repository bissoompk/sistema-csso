/**
 * A conta pelo lado de quem a usa: os defeitos de autenticação do relatório de
 * governança de acesso (22/10/2026).
 *
 * - D5: a troca não aceita a senha atual de novo (a provisória continuava valendo);
 * - D6: o bloqueio vencido recomeça a contagem (um erro bastava para bloquear de novo);
 * - D8: a tela da troca diz que as OUTRAS sessões caem, e confirma quantas caíram;
 * - D21: SENHA_TROCADA, CONTA_BLOQUEADA, PERMISSAO_ACRESCENTADA_AO_PERFIL e o
 *   filtro "Conta afetada" de /auditoria;
 * - D26: o login inexistente também "bloqueia", e a mensagem não diz se a conta existe;
 * - D28: o primeiro acesso pela tela não obriga a trocar a senha recém-escolhida.
 */
import { describe, expect, it } from "vitest";
import { and, desc, eq, like } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { obterConfig } from "../src/config.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as auditoria from "../src/servicos/auditoria.js";
import { semear_rbac } from "../src/servicos/sementes.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, SENHA_TESTE } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

async function contaDe(login: string) {
  const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

async function eventosDe(tipo: string, conta_id?: number) {
  const condicoes = [eq(e.historico_evento.tipo_evento, tipo)];
  if (conta_id !== undefined) {
    condicoes.push(eq(e.historico_evento.entidade, "usuario"), eq(e.historico_evento.entidade_id, conta_id));
  }
  return db
    .select()
    .from(e.historico_evento)
    .where(and(...condicoes))
    .orderBy(desc(e.historico_evento.id));
}

const UMA_HORA_ATRAS = () => new Date(Date.now() - 3600_000);

// =====================================================================
// D5 — a senha nova não pode ser a atual
// =====================================================================
describe("D5: troca para a mesma senha", () => {
  it("a troca obrigatória recusa repetir a provisória, no campo da senha nova", async () => {
    await criarUsuario(db, { login: "d5_provisoria", perfis: ["secretaria_csso"], precisa_trocar_senha: true });
    const cliente = novoCliente();
    await entrar(cliente, "d5_provisoria");
    const r = await cliente.post("/trocar-senha", { senha_atual: SENHA_TESTE, nova: SENHA_TESTE, confirmacao: SENHA_TESTE });
    expect(r.status).toBe(200);
    expect(r.text).toContain(autenticacao.ERRO_SENHA_REPETIDA);
    // a mensagem fala da "atual", mas o erro é do campo da nova
    expect(r.text).toMatch(/id="nova"[\s\S]*?erro-campo">A senha nova é igual/);
    expect((await contaDe("d5_provisoria")).precisa_trocar_senha).toBe(true);
    expect(await eventosDe(auditoria.SENHA_TROCADA, (await contaDe("d5_provisoria")).id)).toHaveLength(0);
  });

  it("o serviço recusa também, fora da tela", async () => {
    await criarUsuario(db, { login: "d5_servico", perfis: ["secretaria_csso"] });
    const conta = await contaDe("d5_servico");
    await expect(naTransacao((tx) => autenticacao.trocar_senha(tx, conta, SENHA_TESTE))).rejects.toThrow(
      autenticacao.ERRO_SENHA_REPETIDA,
    );
  });
});

// =====================================================================
// D6 — bloqueio vencido recomeça a contagem
// =====================================================================
describe("D6: depois do bloqueio vencido", () => {
  it("no login, um erro conta como o primeiro, e não bloqueia de novo", async () => {
    await criarUsuario(db, { login: "d6_login", perfis: ["coordenador_csso"] });
    const max = obterConfig().maxTentativas;
    await db
      .update(e.usuario)
      .set({ tentativas_falhas: max, bloqueado_ate: UMA_HORA_ATRAS() })
      .where(eq(e.usuario.login, "d6_login"));
    const cliente = novoCliente();
    const r = await cliente.post("/login", { login: "d6_login", senha: "errada-de-novo" });
    expect(r.text).toContain("inválidos");
    expect(r.text).not.toContain("Conta bloqueada até");
    const conta = await contaDe("d6_login");
    expect(conta.tentativas_falhas).toBe(1);
    expect(conta.bloqueado_ate).toBeNull();
    // e a senha certa entra na hora
    await entrar(cliente, "d6_login");
  });

  it("na troca de senha, o mesmo recomeço (e não derruba as sessões)", async () => {
    await criarUsuario(db, { login: "d6_troca", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    await entrar(cliente, "d6_troca");
    const max = obterConfig().maxTentativas;
    await db
      .update(e.usuario)
      .set({ tentativas_falhas: max, bloqueado_ate: UMA_HORA_ATRAS() })
      .where(eq(e.usuario.login, "d6_troca"));
    const r = await cliente.post("/trocar-senha", { senha_atual: "errada", nova: "nova-senha-26", confirmacao: "nova-senha-26" });
    expect(r.text).toContain("Senha atual incorreta.");
    expect(r.text).toContain(`Restam ${max - 1} tentativas`);
    expect((await contaDe("d6_troca")).bloqueado_ate).toBeNull();
    expect((await cliente.get("/trocar-senha", { seguir: false })).status).toBe(200);
  });
});

// =====================================================================
// D8 — o texto da troca e a confirmação
// =====================================================================
describe("D8: a tela da troca diz o que acontece às sessões", () => {
  it("o texto diz que as outras sessões caem, e a volta conta quantas", async () => {
    await criarUsuario(db, { login: "d8", perfis: ["coordenador_csso"] });
    const eu = novoCliente();
    const outra = novoCliente();
    await entrar(eu, "d8");
    await entrar(outra, "d8");
    const tela = await eu.get("/trocar-senha");
    expect(tela.text).toContain("As outras sessões abertas desta conta");
    expect(tela.text).not.toContain("as sessões abertas continuam abertas");

    const r = await eu.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova: "outra-senha-d8", confirmacao: "outra-senha-d8" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(r.location).toBe("/trocar-senha?feita=1");
    const volta = await eu.get(r.location!);
    expect(volta.text).toContain("Senha trocada");
    expect(volta.text).toContain("1 outra sessão aberta desta conta");
    expect(volta.text).toContain('href="/inicio"');
    expect((await outra.get("/kanban", { seguir: false })).location).toContain("/login");
  });

  it("quem ainda precisa trocar vê o formulário, mesmo com ?feita na URL", async () => {
    await criarUsuario(db, { login: "d8_forjado", perfis: ["secretaria_csso"], precisa_trocar_senha: true });
    const cliente = novoCliente();
    await entrar(cliente, "d8_forjado");
    const r = await cliente.get("/trocar-senha?feita=3");
    expect(r.text).not.toContain("Senha trocada");
    expect(r.text).toContain('name="senha_atual"');
  });
});

// =====================================================================
// D21 — a trilha da conta
// =====================================================================
describe("D21: eventos de conta na trilha", () => {
  it("SENHA_TROCADA, com quem agiu e quantas sessões caíram", async () => {
    await criarUsuario(db, { login: "d21_troca", perfis: ["coordenador_csso"], precisa_trocar_senha: true });
    const cliente = novoCliente();
    await entrar(cliente, "d21_troca");
    await cliente.post("/trocar-senha", { senha_atual: SENHA_TESTE, nova: "trocada-d21-x", confirmacao: "trocada-d21-x" });
    const conta = await contaDe("d21_troca");
    const [ev] = await eventosDe(auditoria.SENHA_TROCADA, conta.id);
    expect(ev).toBeDefined();
    expect(ev!.usuario_id).toBe(conta.id);
    expect(ev!.descricao).toContain("'d21_troca'");
    expect(ev!.descricao).toContain("(troca obrigatória)");
    expect(ev!.descricao).toContain("0 outra(s) sessão(ões) encerrada(s)");
    expect(auditoria.rotulo_evento(auditoria.SENHA_TROCADA)).toBe("Senha trocada pelo próprio dono");
  });

  it("CONTA_BLOQUEADA pelo login: uma vez, como 'sistema', com o IP", async () => {
    await criarUsuario(db, { login: "d21_bloqueio", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    const max = obterConfig().maxTentativas;
    for (let i = 0; i < max + 2; i++) {
      await cliente.post("/login", { login: "d21_bloqueio", senha: "errada" }, { cabecalhos: { "x-nf-client-connection-ip": "10.9.8.7" } });
    }
    const conta = await contaDe("d21_bloqueio");
    const eventos = await eventosDe(auditoria.CONTA_BLOQUEADA, conta.id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.usuario_id).toBeNull();
    expect(eventos[0]!.usuario_nome).toBe("sistema");
    expect(eventos[0]!.ip).toBe("10.9.8.7");
    expect(eventos[0]!.descricao).toContain("na entrada");
  });

  it("CONTA_BLOQUEADA pela troca de senha, como a própria conta", async () => {
    await criarUsuario(db, { login: "d21_bloqueio_troca", perfis: ["coordenador_csso"] });
    const cliente = novoCliente();
    await entrar(cliente, "d21_bloqueio_troca");
    const max = obterConfig().maxTentativas;
    for (let i = 0; i < max; i++) {
      await cliente.post("/trocar-senha", { senha_atual: "errada", nova: "nova-senha-26", confirmacao: "nova-senha-26" });
    }
    const conta = await contaDe("d21_bloqueio_troca");
    const [ev] = await eventosDe(auditoria.CONTA_BLOQUEADA, conta.id);
    expect(ev!.usuario_id).toBe(conta.id);
    expect(ev!.descricao).toContain("na troca de senha");
  });

  it("o semeio grava a permissão acrescentada a perfil já gravado, e só uma vez", async () => {
    const [pf] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "secretaria_csso"));
    const [pp] = await db
      .select({ permissao_id: e.perfil_permissao.permissao_id, codigo: e.permissao.codigo })
      .from(e.perfil_permissao)
      .innerJoin(e.permissao, eq(e.permissao.id, e.perfil_permissao.permissao_id))
      .where(eq(e.perfil_permissao.perfil_id, pf!.id))
      .limit(1);
    await db
      .delete(e.perfil_permissao)
      .where(and(eq(e.perfil_permissao.perfil_id, pf!.id), eq(e.perfil_permissao.permissao_id, pp!.permissao_id)));
    await naTransacao((tx) => semear_rbac(tx));
    await naTransacao((tx) => semear_rbac(tx));
    const eventos = (await eventosDe(auditoria.PERMISSAO_ACRESCENTADA_AO_PERFIL)).filter(
      (ev) => ev.entidade === "perfil" && ev.entidade_id === pf!.id,
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.valor_novo).toBe(pp!.codigo);
    expect(eventos[0]!.descricao).toContain(`'${pp!.codigo}'`);
    expect(eventos[0]!.usuario_nome).toBe("sistema");
  });

  it("/auditoria?conta_id: o que fizeram com a conta, e nada de outra", async () => {
    await criarUsuario(db, { login: "d21_alvo", perfis: ["secretaria_csso"] });
    await criarUsuario(db, { login: "d21_outra", perfis: ["secretaria_csso"] });
    const alvo = await contaDe("d21_alvo");
    const outra = await contaDe("d21_outra");
    const [atrib] = await db.select().from(e.atribuicao).where(eq(e.atribuicao.usuario_id, alvo.id));
    await naTransacao(async (tx) => {
      // um ato de OUTRA pessoa sobre a conta (a concessão), um da conta sobre
      // si (a troca), uma habilitação que foi ligada a ela e um evento alheio
      await auditoria.registrar(tx, {
        entidade: "atribuicao",
        entidade_id: atrib!.id,
        tipo_evento: "PERFIL_CONCEDIDO",
        descricao: "Perfil secretaria_csso concedido — marcador-da-concessao",
        usuario_nome: "Superintendente de Teste",
      });
      await auditoria.registrar(tx, {
        entidade: "profissional_habilitado",
        entidade_id: 999_999,
        tipo_evento: "HABILITACAO_DESVINCULADA",
        descricao: "marcador-da-habilitacao desligado da conta.",
        campo: "usuario_id",
        valor_anterior: String(alvo.id),
        valor_novo: null,
      });
      await auditoria.registrar(tx, {
        entidade: "usuario",
        entidade_id: outra.id,
        tipo_evento: "USUARIO_INATIVADO",
        descricao: "marcador-de-outra-conta",
      });
    });
    const sessao = novoCliente();
    await entrar(sessao, "d21_alvo");
    await sessao.post("/trocar-senha", { senha_atual: SENHA_TESTE, nova: "alvo-trocou-26", confirmacao: "alvo-trocou-26" });

    const auditor = novoCliente();
    await entrar(auditor, "admin_ti");
    const r = await auditor.get(`/auditoria?conta_id=${alvo.id}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Conta afetada");
    expect(r.text).toContain(`<option value="${alvo.id}" selected>`);
    expect(r.text).toContain("marcador-da-concessao");
    // a descrição da habilitação traz o nome do profissional: sai suprimida
    // (RN-19) para o admin_ti, mas a linha está lá
    expect(r.text).toContain("Habilitação desligada da conta");
    expect(r.text).toContain("Senha trocada pelo próprio dono");
    expect(r.text).not.toContain("marcador-de-outra-conta");
    // o filtro viaja na paginação
    expect(r.text).toContain(`conta_id=${alvo.id}`);
  });
});

// =====================================================================
// D26 — o bloqueio não diz se a conta existe
// =====================================================================
describe("D26: o login inexistente também bloqueia", () => {
  it("a mesma sequência de respostas da conta real, sem guardar o identificador", async () => {
    await criarUsuario(db, { login: "d26_real", perfis: ["coordenador_csso"] });
    const max = obterConfig().maxTentativas;
    const respostas = async (login: string) => {
      const cliente = novoCliente();
      const textos: string[] = [];
      for (let i = 0; i < max + 1; i++) {
        const r = await cliente.post("/login", { login, senha: "errada" });
        textos.push(r.text.includes("Conta bloqueada até") ? "bloqueada" : r.text.includes("inválidos") ? "invalida" : "?");
      }
      return textos;
    };
    const real = await respostas("d26_real");
    const inexistente = await respostas("ninguem-d26@ufvjm.edu.br");
    expect(real).toEqual([...Array(max).fill("invalida"), "bloqueada"]);
    expect(inexistente).toEqual(real);
    // o contador é por HMAC: o texto digitado não fica na tabela
    const linhas = await db.select().from(e.limite_login_ip).where(like(e.limite_login_ip.ip, "conta:%"));
    expect(linhas.length).toBeGreaterThan(0);
    for (const l of linhas) expect(l.ip).not.toContain("ninguem");
  });

  it("a conta inativa também, e a caixa do identificador não abre outro contador", async () => {
    await criarUsuario(db, { login: "d26_inativa", perfis: ["coordenador_csso"], ativo: false });
    const max = obterConfig().maxTentativas;
    const cliente = novoCliente();
    for (let i = 0; i < max; i++) {
      await cliente.post("/login", { login: i % 2 ? "D26_INATIVA" : "d26_inativa", senha: SENHA_TESTE });
    }
    const r = await cliente.post("/login", { login: "d26_inativa", senha: SENHA_TESTE });
    expect(r.text).toContain("Conta bloqueada até");
  });
});

// =====================================================================
// D28 — o primeiro acesso não é senha provisória
// =====================================================================
describe("D28: primeiro acesso", () => {
  it("o serviço mantém a troca obrigatória por padrão (linha de comando, senha gerada)", async () => {
    const { db: virgem } = await bancoLimpo();
    const conta = await autenticacao.criar_primeiro_superintendente(
      virgem,
      "Pela linha de comando",
      "cli@ufvjm.edu.br",
      "gerada-pela-cli-26",
    );
    expect(conta.precisa_trocar_senha).toBe(true);
  });
});
