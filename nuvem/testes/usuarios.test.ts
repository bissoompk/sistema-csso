/**
 * /usuarios, /perfis e /habilitacoes — governança de acesso — e a matriz de
 * rotas (CA-17) das telas da base compartilhada.
 * Porte de `test_rotas_permissoes.py` (as linhas das telas da base),
 * `test_popup_de_cadastro.py` (os três cadastros de /usuarios) e
 * `test_web_fluxo.py` (/perfis).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar, SENHA_TESTE, type AmbienteDeTeste } from "./ajuda";

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

  it("concessão sem ato normativo volta com o que foi escolhido", async () => {
    await entrar(amb.cliente, "superintendente");
    const [alvo] = await amb.db.select().from(e.usuario).orderBy(asc(e.usuario.id)).limit(1);
    const corpo = (
      await amb.cliente.post("/usuarios/0/atribuicoes", {
        usuario_alvo: String(alvo!.id),
        perfil_id: "1",
        ato_normativo: "   ",
        vigencia_inicio: "2026-03-01",
      })
    ).text;
    expect(abertos(corpo)).toEqual(["conceder-perfil"]);
    expect(corpo).toContain('value="2026-03-01"');
    expect(corpo).toContain("Sem o ato normativo não há concessão");
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
    expect(corpo).toContain("coordenador_csso");
    expect(corpo).toMatch(/pilula info sem-ponto[^>]*>almoxarife_sesmt</);
  });
});
