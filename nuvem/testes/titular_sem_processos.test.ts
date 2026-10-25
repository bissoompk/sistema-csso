/**
 * Por padrão o servidor e o discente não veem Processos SEI nem Adicionais
 * (25/10/2026). Quem administra acesso libera, por pessoa, os PRÓPRIOS
 * processos, pareceres e o adicional: «Consulta» em Processos SEI, em Usuários.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { ESCOPO_PROPRIO, MATRIZ_PERFIS, PERMISSOES_DO_TITULAR } from "../src/servicos/rbac.js";
import { semear_rbac } from "../src/servicos/sementes.js";
import * as auditoria from "../src/servicos/auditoria.js";
import { bancoLimpo, contas, criarUsuario, entrar, liberarProcessos, usuarioAtual } from "./ajuda";
import { cenario } from "./ajuda_processos.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const HTML = { cabecalhos: { accept: "text/html" } };

const caso = await cenario(db);
const conta = await criarUsuario(db, { login: "srv_padrao", perfis: ["servidor_consulta"], servidor_id: caso.servidor_id });

async function nivel_gravado(usuario_id: number) {
  const [n] = await db
    .select()
    .from(e.usuario_nivel_modulo)
    .where(and(eq(e.usuario_nivel_modulo.usuario_id, usuario_id), eq(e.usuario_nivel_modulo.modulo, "processos-sei")));
  return n?.nivel ?? null;
}

describe("o padrão: sem Processos SEI nem Adicionais", () => {
  it("nem o titular, nem o servidor_consulta, nem o discente têm processo ou parecer", async () => {
    expect(PERMISSOES_DO_TITULAR.has("processo.ver")).toBe(false);
    expect(PERMISSOES_DO_TITULAR.has("parecer.ver")).toBe(false);
    for (const perfil of ["servidor_consulta", "discente", "terceirizado"]) {
      expect(MATRIZ_PERFIS[perfil]!.permissoes, perfil).not.toContain("processo.ver");
      expect(MATRIZ_PERFIS[perfil]!.permissoes, perfil).not.toContain("parecer.ver");
    }
    for (const login of ["srv_padrao", "discente"]) {
      const u = await usuarioAtual(db, login);
      expect(u.pode("processo.ver"), login).toBe(false);
      expect(u.pode("parecer.ver"), login).toBe(false);
    }
  });

  it("as telas respondem acesso negado, e o menu não as oferece", async () => {
    const cli = await entrar(novoCliente(), "srv_padrao");
    for (const caminho of ["/processos", "/adicionais", `/processos/${caso.processo_id}`]) {
      expect((await cli.get(caminho, { ...HTML, seguir: false })).status, caminho).toBe(403);
    }
    const inicio = await cli.get("/", HTML);
    expect(inicio.status).toBe(200);
    expect(inicio.text).not.toContain('href="/adicionais"');
    expect(inicio.text).not.toContain('href="/processos"');
    const discente = await entrar(novoCliente(), "discente");
    expect((await discente.get("/adicionais", { ...HTML, seguir: false })).status).toBe(403);
    expect((await discente.get("/processos", { ...HTML, seguir: false })).status).toBe(403);
  });

  it("Minha atividade não mostra os processos nem oferece o filtro", async () => {
    await auditoria.registrar(db, {
      entidade: "processo",
      entidade_id: caso.processo_id,
      processo_id: caso.processo_id,
      tipo_evento: "PROCESSO_CRIADO",
      descricao: "Processo criado.",
      usuario: null,
    });
    const cli = await entrar(novoCliente(), "srv_padrao");
    const tela = (await cli.get("/minha-atividade", HTML)).text;
    expect(tela).toContain("Minha atividade");
    expect(tela).not.toContain("?tipo=processos");
    expect(tela).not.toContain("Processo aberto");
    // liberado, o processo volta
    await liberarProcessos(db, conta.id);
    try {
      const liberada = (await (await entrar(novoCliente(), "srv_padrao")).get("/minha-atividade", HTML)).text;
      expect(liberada).toContain("?tipo=processos");
      expect(liberada).toContain("Processo aberto");
    } finally {
      await liberarProcessos(db, conta.id, false);
    }
  });

  it("o banco já gravado perde a permissão no semeio, com a trilha", async () => {
    const [pf] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "servidor_consulta"));
    const [perm] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "processo.ver"));
    await db.insert(e.perfil_permissao).values({ perfil_id: pf!.id, permissao_id: perm!.id }).onConflictDoNothing();
    await semear_rbac(db);
    const restou = await db
      .select()
      .from(e.perfil_permissao)
      .where(and(eq(e.perfil_permissao.perfil_id, pf!.id), eq(e.perfil_permissao.permissao_id, perm!.id)));
    expect(restou).toHaveLength(0);
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "perfil"), eq(e.historico_evento.entidade_id, pf!.id)));
    expect(trilha.some((t) => (t.descricao ?? "").includes("'processo.ver' retirada do perfil 'servidor_consulta'"))).toBe(true);
  });
});

describe("a liberação por pessoa, em Usuários", () => {
  it("a tela oferece a escolha para a conta do servidor sem perfil de equipe", async () => {
    const adm = await entrar(novoCliente(), "administrador_sistema");
    const tela = (await adm.get("/usuarios", HTML)).text;
    expect(tela).toContain("Processos SEI e Adicionais (os próprios)");
    expect(tela).toContain(`action="/usuarios/${conta.id}/niveis"`);
  });

  it("«Consulta» devolve os próprios processos, pareceres e o adicional — nunca os dos outros", async () => {
    const adm = await entrar(novoCliente(), "administrador_sistema");
    const r = await adm.post(`/usuarios/${conta.id}/niveis`, { "nivel_processos-sei": "CONSULTA" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Acesso por módulo");
    expect(await nivel_gravado(conta.id)).toBe("CONSULTA");
    const u = await usuarioAtual(db, "srv_padrao");
    expect(u.escopo_de("processo.ver")).toBe(ESCOPO_PROPRIO);
    expect(u.escopo_de("parecer.ver")).toBe(ESCOPO_PROPRIO);
    const cli = await entrar(novoCliente(), "srv_padrao");
    expect((await cli.get("/adicionais", HTML)).status).toBe(200);
    expect((await cli.get("/processos", HTML)).status).toBe(200);
    expect((await cli.get(`/processos/${caso.processo_id}`, HTML)).status).toBe(200);
    // o de outra pessoa continua fora
    const outro = await cenario(db, { nup: "23086.740001/2024-11", siape: "3600001", laudo: "26255-000.811/2019", numero_portaria: "991" });
    expect((await cli.get(`/processos/${outro.processo_id}`, { ...HTML, seguir: false })).status).toBe(404);
    // e voltar ao padrão tira de novo
    await adm.post(`/usuarios/${conta.id}/niveis`, { "nivel_processos-sei": "PADRAO" }, { seguir: false });
    expect(await nivel_gravado(conta.id)).toBeNull();
    expect((await usuarioAtual(db, "srv_padrao")).pode("processo.ver")).toBe(false);
  });

  it("Operação é recusada para quem não tem perfil de equipe", async () => {
    const adm = await entrar(novoCliente(), "administrador_sistema");
    const r = await adm.post(`/usuarios/${conta.id}/niveis`, { "nivel_processos-sei": "OPERACAO" }, HTML);
    expect(r.text).toContain("só consulta os próprios processos");
    expect(await nivel_gravado(conta.id)).toBeNull();
  });

  it("a conta sem servidor e a do discente não recebem a liberação", async () => {
    const adm = await entrar(novoCliente(), "administrador_sistema");
    for (const login of ["servidor_consulta", "discente"]) {
      const [alvo] = await db.select().from(e.usuario).where(eq(e.usuario.login, login));
      const r = await adm.post(`/usuarios/${alvo!.id}/niveis`, { "nivel_processos-sei": "CONSULTA" }, HTML);
      expect(r.text, login).toContain("Só a conta ligada a um servidor");
      expect(await nivel_gravado(alvo!.id), login).toBeNull();
    }
  });
});
