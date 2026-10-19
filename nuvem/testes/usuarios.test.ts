/**
 * /usuarios, /perfis e /habilitacoes — governança de acesso — e a matriz de
 * rotas (CA-17) das telas da base compartilhada.
 * Porte de `test_rotas_permissoes.py` (as linhas das telas da base),
 * `test_popup_de_cadastro.py` (os três cadastros de /usuarios) e
 * `test_web_fluxo.py` (/perfis).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { ato_pendente } from "../src/rotas/usuarios.js";
import { carregar_usuario_atual } from "../src/servicos/rbac.js";
import * as redefinirSenha from "../ferramentas/redefinir-senha.js";
import { bancoLimpo, contas, entrar, naTransacao, SENHA_TESTE, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

const abertos = (corpo: string) => [...corpo.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]);

// (caminho, perfil que vê, perfil que NÃO vê) — só as telas da base
const MATRIZ: [string, string, string | null][] = [
  ["/demandas", "coordenador_csso", "admin_ti"],
  ["/servidores", "coordenador_csso", "admin_ti"],
  ["/catalogos", "coordenador_csso", "admin_ti"],
  ["/auditoria", "auditor_interno", "secretaria_csso"],
  ["/config", "coordenador_csso", "almoxarife_sesmt"],
  ["/config", "admin_ti", null],
  ["/perfis", "coordenador_csso", "admin_ti"],
  ["/usuarios", "superintendente", "secretaria_csso"],
  ["/usuarios", "admin_ti", null],
];

describe("CA-17: toda rota tem fluxo feliz e negativa", () => {
  it.each(MATRIZ)("%s abre para %s e nega a %s", async (caminho, perfil, negado) => {
    await entrar(amb.cliente, perfil);
    const r = await amb.cliente.get(caminho);
    expect(r.status, `${caminho} como ${perfil}`).toBe(200);
    expect(r.text).not.toContain("Template render error");
    if (negado) {
      await entrar(amb.cliente, negado);
      expect((await amb.cliente.get(caminho)).status, `${caminho} deveria negar ${negado}`).toBe(403);
    }
  });

  it.each(MATRIZ)("%s sem sessão vai para o login", async (caminho) => {
    const r = await amb.novoCliente().get(caminho, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("backup exige permissão", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    expect((await amb.cliente.post("/config/backup")).status).toBe(403);
  });
});

describe("contas", () => {
  it("criar conta mostra a senha provisória uma vez e obriga a trocar", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/usuarios", { login: "novo", nome: "Conta Nova", email: "novo@teste.ufvjm.edu.br" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Senha provisória:");
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "novo"));
    expect(conta!.precisa_trocar_senha).toBe(true);
    const evento = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "USUARIO_CRIADO"));
    expect(evento).toHaveLength(1);
  });

  it("login repetido volta o popup preenchido, sem 500", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/usuarios", { login: "admin_ti", nome: "Outra Pessoa", email: "outra@teste.ufvjm.edu.br" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Já existe conta com este login");
    expect(abertos(r.text)).toEqual(["nova-conta"]);
    expect(r.text).toContain('value="Outra Pessoa"');
  });

  it("resetar senha revoga as sessões e força a troca", async () => {
    const outro = amb.novoCliente();
    await entrar(outro, "secretaria_csso");
    const [alvo] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria_csso"));
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post(`/usuarios/${alvo!.id}/senha`);
    expect(r.text).toContain("Nova senha provisória de secretaria_csso");
    // a sessão aberta caiu
    expect((await outro.get("/demandas", { seguir: false })).status).toBe(303);
    const [depois] = await amb.db.select().from(e.usuario).where(eq(e.usuario.id, alvo!.id));
    expect(depois!.precisa_trocar_senha).toBe(true);
  });

  it("inativar derruba a sessão e a conta não entra mais; reativar devolve", async () => {
    const [alvo] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria_csso"));
    await entrar(amb.cliente, "admin_ti");
    await amb.cliente.post(`/usuarios/${alvo!.id}/inativar`, {}, { seguir: false });
    const tentativa = await amb.novoCliente().post("/login", { login: "secretaria_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(tentativa.status).not.toBe(303);
    await amb.cliente.post(`/usuarios/${alvo!.id}/inativar`, {}, { seguir: false });
    await entrar(amb.novoCliente(), "secretaria_csso");
  });
});

describe("perfil e habilitação", () => {
  it("conceder perfil grava sem JavaScript (action no usuário 0)", async () => {
    await entrar(amb.cliente, "superintendente");
    expect((await amb.cliente.get("/usuarios")).text).toContain('action="/usuarios/0/atribuicoes"');
    const [alvo] = await amb.db.select().from(e.usuario).orderBy(asc(e.usuario.id)).limit(1);
    const [perfil] = await amb.db.select().from(e.perfil).orderBy(asc(e.perfil.id)).limit(1);
    const r = await amb.cliente.post(
      "/usuarios/0/atribuicoes",
      { usuario_alvo: String(alvo!.id), perfil_id: String(perfil!.id), ato_normativo: "Portaria Reitoria nº 1.553/2026" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const gravadas = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.ato_normativo, "Portaria Reitoria nº 1.553/2026"));
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]!.usuario_id).toBe(alvo!.id);
  });

  it("concessão sem ato normativo entra como pendente, com quem e quando", async () => {
    await entrar(amb.cliente, "superintendente");
    const [alvo] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria_csso"));
    const [perfil] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "tecnico_seguranca"));
    const r = await amb.cliente.post(
      "/usuarios/0/atribuicoes",
      { usuario_alvo: String(alvo!.id), perfil_id: String(perfil!.id), ato_normativo: "   " },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [gravada] = await amb.db
      .select()
      .from(e.atribuicao)
      .where(and(eq(e.atribuicao.usuario_id, alvo!.id), eq(e.atribuicao.perfil_id, perfil!.id)));
    expect(gravada!.ato_normativo).toBe(ato_pendente({ login: "superintendente" }));
    expect(gravada!.ato_normativo).toMatch(/^Pendente — informado por superintendente em \d{2}\/\d{2}\/\d{4}$/);
    expect((await amb.cliente.get("/usuarios")).text).not.toMatch(/id="perf-ato"[^>]*required/);
  });

  it("a recusa da habilitação reabre só o popup de onde ela veio", async () => {
    await entrar(amb.cliente, "superintendente");
    const corpo = (
      await amb.cliente.post("/habilitacoes", {
        nome: "Fulano de Tal",
        habilitacao: "ENG_SEG_TRABALHO",
        titulo_assinatura: "Eng. Seg. do Trabalho",
        conselho: "CREA",
        registro_conselho: "MG-123456",
        externo: "1",
        justificativa_art10_par5: "   ",
      })
    ).text;
    expect(abertos(corpo)).toEqual(["atestar-habilitacao"]);
    expect(corpo).toContain('value="Fulano de Tal"');
    expect(corpo).toContain('value="MG-123456"');
    expect(corpo).toContain("Habilitação externa exige justificativa");
  });

  it("habilitação atestada entra na lista e na trilha", async () => {
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(
      "/habilitacoes",
      { nome: "Beltrana Médica", habilitacao: "MED_TRABALHO", titulo_assinatura: "Médica do Trabalho", conselho: "CRM" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect((await amb.cliente.get("/usuarios")).text).toContain("Beltrana Médica");
    const eventos = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "HABILITACAO_ATESTADA"));
    expect(eventos).toHaveLength(1);
  });

  it("/perfis lista as permissões de cada perfil e marca parecer.assinar", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const corpo = (await amb.cliente.get("/perfis")).text;
    expect(corpo).toContain("coordenador_csso");
    expect(corpo).toContain("demanda.registrar");
    expect(corpo).toContain("só funciona somada a habilitação técnica");
  });

  it("perfis vigentes aparecem na lista de contas", async () => {
    await entrar(amb.cliente, "admin_ti");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    // o nome do perfil, e não o código
    expect(corpo).toContain("Coordenador da CSSO");
    expect(corpo).toMatch(/pilula info sem-ponto[^>]*>Almoxarife do SESMT</);
  });
});

async function conta(login: string) {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

async function vigentes(login: string) {
  return (await carregar_usuario_atual(amb.db, (await conta(login)).id)).perfis;
}

async function atribuicaoDe(login: string, perfil: string) {
  const u = await conta(login);
  const todas = await amb.db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, u.id), with: { perfil: true } });
  return todas.find((a) => a.perfil.codigo === perfil)!;
}

async function eventos(tipo: string) {
  return amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("encerrar concessão e corrigir o ato", () => {
  it("encerrar tira o perfil já hoje e fica na trilha", async () => {
    await entrar(amb.cliente, "superintendente");
    const a = await atribuicaoDe("secretaria_csso", "secretaria_csso");
    expect(await vigentes("secretaria_csso")).toContain("secretaria_csso");
    const r = await amb.cliente.post(`/usuarios/atribuicoes/${a.id}/encerrar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(await vigentes("secretaria_csso")).not.toContain("secretaria_csso");
    expect(await eventos("PERFIL_ENCERRADO")).toHaveLength(1);
    // a linha não some: fica com o fim
    const [linha] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.id, a.id));
    expect(linha!.vigencia_fim).not.toBeNull();
  });

  it("Gerir traz o botão de encerrar e o campo do ato", async () => {
    await entrar(amb.cliente, "superintendente");
    const a = await atribuicaoDe("secretaria_csso", "secretaria_csso");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    expect(corpo).toContain(`action="/usuarios/atribuicoes/${a.id}/encerrar"`);
    expect(corpo).toContain(`action="/usuarios/atribuicoes/${a.id}/ato"`);
  });

  it("não encerra a última concessão de quem concede perfil", async () => {
    await entrar(amb.cliente, "superintendente");
    const a = await atribuicaoDe("superintendente", "superintendente");
    const r = await amb.cliente.post(`/usuarios/atribuicoes/${a.id}/encerrar`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("é a última concessão vigente de quem concede perfil");
    expect(await vigentes("superintendente")).toContain("superintendente");
    expect(await eventos("PERFIL_ENCERRADO")).toHaveLength(0);
  });

  it("havendo outro superintendente, encerra o próprio", async () => {
    await entrar(amb.cliente, "superintendente");
    const [perfil] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "superintendente"));
    const outro = await conta("coordenador_csso");
    await amb.cliente.post(
      "/usuarios/0/atribuicoes",
      { usuario_alvo: String(outro.id), perfil_id: String(perfil!.id), ato_normativo: "Portaria 1/2026" },
      { seguir: false },
    );
    const a = await atribuicaoDe("superintendente", "superintendente");
    expect((await amb.cliente.post(`/usuarios/atribuicoes/${a.id}/encerrar`, {}, { seguir: false })).status).toBe(303);
    expect(await vigentes("superintendente")).not.toContain("superintendente");
  });

  it("encerrar e corrigir o ato pedem perfil.conceder", async () => {
    const a = await atribuicaoDe("secretaria_csso", "secretaria_csso");
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.post(`/usuarios/atribuicoes/${a.id}/encerrar`)).status).toBe(403);
    expect((await amb.cliente.post(`/usuarios/atribuicoes/${a.id}/ato`, { ato_normativo: "x" })).status).toBe(403);
  });

  it("o ato BOOTSTRAP vira o ato real, com antes e depois na trilha", async () => {
    const a = await atribuicaoDe("superintendente", "superintendente");
    await amb.db.update(e.atribuicao).set({ ato_normativo: "BOOTSTRAP — substituir pelo ato real" }).where(eq(e.atribuicao.id, a.id));
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(
      `/usuarios/atribuicoes/${a.id}/ato`,
      { ato_normativo: "Portaria Reitoria nº 1.553/2026" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [linha] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.id, a.id));
    expect(linha!.ato_normativo).toBe("Portaria Reitoria nº 1.553/2026");
    const [ev] = await eventos("ATO_NORMATIVO_ALTERADO");
    expect(JSON.stringify(ev!.valor_anterior)).toContain("BOOTSTRAP");
    expect(JSON.stringify(ev!.valor_novo)).toContain("1.553/2026");
  });
});

describe("conta com perfil e servidor no mesmo envio", () => {
  async function servidor(siape: string, nome: string, email: string | null = null) {
    const [s] = await amb.db.insert(e.servidor).values({ siape, nome, email }).returning();
    return s!;
  }

  it("cria a conta já com o perfil e o servidor escolhido", async () => {
    const s = await servidor("7654321", "Joana Prado");
    const [perfil] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "servidor_consulta"));
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post("/usuarios", {
      login: "joana",
      nome: "Joana Prado",
      email: "joana@teste.ufvjm.edu.br",
      perfil_id: String(perfil!.id),
      servidor: "7654321 — Joana Prado",
    });
    expect(r.text).toContain("Senha provisória:");
    expect((await conta("joana")).servidor_id).toBe(s.id);
    expect(await vigentes("joana")).toEqual(["servidor_consulta"]);
    const a = await atribuicaoDe("joana", "servidor_consulta");
    expect(a.ato_normativo).toMatch(/^Pendente — informado por superintendente/);
    expect(await eventos("SERVIDOR_VINCULADO")).toHaveLength(1);
  });

  it("em branco, vincula sozinho o servidor de mesmo e-mail", async () => {
    const s = await servidor("1112223", "Rui Teles", "Rui.Teles@ufvjm.edu.br");
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post("/usuarios", { login: "rui", nome: "Rui Teles", email: "rui.teles@ufvjm.edu.br" });
    expect(r.text).toContain("pelo e-mail");
    expect((await conta("rui")).servidor_id).toBe(s.id);
  });

  it("servidor que não existe volta o popup preenchido, sem criar nada", async () => {
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post("/usuarios", { login: "x1", nome: "X", email: "x1@teste.ufvjm.edu.br", servidor: "9999999" });
    expect(abertos(r.text)).toEqual(["nova-conta"]);
    expect(r.text).toContain("servidor não encontrado");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "x1"))).toHaveLength(0);
  });

  it("admin_ti cria conta, mas não com perfil nem servidor (nem pelo e-mail)", async () => {
    await servidor("3334445", "Ana Lis", "ana@ufvjm.edu.br");
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/usuarios", { login: "ana", nome: "Ana Lis", email: "ana@ufvjm.edu.br", servidor: "3334445" });
    expect(r.text).toContain("pedem a permissão perfil.conceder");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "ana"))).toHaveLength(0);
    await amb.cliente.post("/usuarios", { login: "ana", nome: "Ana Lis", email: "ana@ufvjm.edu.br" });
    expect((await conta("ana")).servidor_id).toBeNull();
    // e a página dele não traz a lista nominal de servidores (RN-19)
    expect((await amb.cliente.get("/usuarios")).text).not.toContain('id="lista-servidores"');
  });

  it("vincular e desvincular depois, com a trilha; um servidor, uma conta", async () => {
    const s = await servidor("5556667", "Davi Couto");
    const alvo = await conta("secretaria_csso");
    await entrar(amb.cliente, "superintendente");
    expect((await amb.cliente.post(`/usuarios/${alvo.id}/servidor`, { servidor: "davi couto" }, { seguir: false })).status).toBe(303);
    expect((await conta("secretaria_csso")).servidor_id).toBe(s.id);
    // o mesmo servidor em outra conta é recusado
    const outra = await conta("tecnico_seguranca");
    const r = await amb.cliente.post(`/usuarios/${outra.id}/servidor`, { servidor: "5556667" });
    expect(r.text).toContain("já está vinculado à conta &#39;secretaria_csso&#39;");
    expect((await conta("tecnico_seguranca")).servidor_id).toBeNull();
    await amb.cliente.post(`/usuarios/${alvo.id}/servidor`, { servidor: "" }, { seguir: false });
    expect((await conta("secretaria_csso")).servidor_id).toBeNull();
    expect(await eventos("SERVIDOR_VINCULADO")).toHaveLength(1);
    expect(await eventos("SERVIDOR_DESVINCULADO")).toHaveLength(1);
  });

  it("Gerir sugere o servidor de mesmo e-mail; vincular pede perfil.conceder", async () => {
    const alvo = await conta("secretaria_csso");
    await servidor("8889990", "Secretária Teste", alvo.email);
    await entrar(amb.cliente, "superintendente");
    expect((await amb.cliente.get("/usuarios")).text).toContain('value="8889990 — Secretária Teste"');
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.post(`/usuarios/${alvo.id}/servidor`, { servidor: "8889990" })).status).toBe(403);
  });
});

describe("redefinir-senha pela linha de comando", () => {
  it("gera provisória, obriga a troca, derruba sessões e audita como linha de comando", async () => {
    const sessao = amb.novoCliente();
    await entrar(sessao, "superintendente");
    const feito = await naTransacao((tx) => redefinirSenha.redefinir(tx, "superintendente"));
    expect(feito!.senha.length).toBeGreaterThan(8);
    expect((await conta("superintendente")).precisa_trocar_senha).toBe(true);
    expect((await sessao.get("/usuarios", { seguir: false })).status).toBe(303);
    await entrar(amb.novoCliente(), "superintendente", feito!.senha);
    const [ev] = await eventos("SENHA_RESETADA");
    expect(ev!.usuario_nome).toBe(redefinirSenha.ATOR);
    expect(ev!.usuario_id).toBeNull();
  });

  it("login inexistente não altera nada", async () => {
    expect(await naTransacao((tx) => redefinirSenha.redefinir(tx, "ninguem"))).toBeNull();
    expect(await eventos("SENHA_RESETADA")).toHaveLength(0);
  });

  it("--reativar devolve a entrada à conta inativa", async () => {
    await amb.db.update(e.usuario).set({ ativo: false }).where(eq(e.usuario.login, "superintendente"));
    const feito = await naTransacao((tx) => redefinirSenha.redefinir(tx, "superintendente", true));
    expect((await conta("superintendente")).ativo).toBe(true);
    await entrar(amb.novoCliente(), "superintendente", feito!.senha);
    expect(await eventos("USUARIO_ATIVADO")).toHaveLength(1);
  });
});
