/**
 * Configurações conforme o perfil (23/10/2026): cada bloco de /config só sai
 * para quem tem o módulo liberado (com o nível por módulo aplicado) e a
 * permissão dele; o título de seção vazio não sai; sem bloco nenhum, a tela
 * recusa com recado curto e a engrenagem some; e as rotas POST recusam com 403
 * quem não vê o bloco — a tela não é a barreira.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { PERFIS_DE_TESTE, bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

/** O marcador de cada bloco no HTML. */
const MARCA = {
  secao_setor: '<h2 class="secao-hub">Configuração do setor</h2>',
  setor_emissor: "<h2>Setor emissor</h2>",
  sla: "<h2>SLA por coluna</h2>",
  editar_sla: 'action="/config/sla"',
  integracao_sei: "<h2>Integração com o SEI</h2>",
  retirada_epi: "<h2>Retirada de EPI</h2>",
  secao_sistema: '<h2 class="secao-hub">Sistema</h2>',
  onde_mora: "<h2>Onde o dado mora</h2>",
  backup: 'action="/config/backup"',
  exportar_tudo: 'action="/config/exportar-tudo"',
} as const;
type Bloco = keyof typeof MARCA;

const PROCESSOS: Bloco[] = ["secao_setor", "setor_emissor", "sla", "integracao_sei"];

/** perfil → blocos esperados; `null` = não entra (403). */
const ESPERADO: Record<string, Bloco[] | null> = {
  coordenador_csso: [...PROCESSOS, "editar_sla", "retirada_epi", "secao_sistema", "exportar_tudo"],
  tecnico_seguranca: [...PROCESSOS, "retirada_epi"],
  secretaria_csso: [...PROCESSOS],
  auditor_interno: null,
  superintendente: [...PROCESSOS, "editar_sla", "retirada_epi", "secao_sistema", "onde_mora", "backup", "exportar_tudo"],
  administrador_sistema: [...PROCESSOS, "editar_sla", "retirada_epi", "secao_sistema", "onde_mora", "backup", "exportar_tudo"],
  admin_ti: ["secao_sistema", "onde_mora", "backup"],
  consulta_progep: null,
  servidor_consulta: null,
  engenheiro_seguranca: [...PROCESSOS, "retirada_epi"],
  medico_trabalho: [...PROCESSOS, "retirada_epi"],
  almoxarife_sesmt: ["secao_setor", "retirada_epi"],
};

async function conta_id(login: string): Promise<number> {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

async function nivel(login: string, modulo: string, valor: "SEM_ACESSO" | "CONSULTA" | "OPERACAO") {
  await amb.db.insert(e.usuario_nivel_modulo).values({ usuario_id: await conta_id(login), modulo, nivel: valor });
}

function blocos_no(html: string): Bloco[] {
  return (Object.keys(MARCA) as Bloco[]).filter((b) => html.includes(MARCA[b]));
}

describe("/config mostra só os blocos do perfil", () => {
  it("toda conta de teste está no mapa", () => {
    expect(Object.keys(ESPERADO).sort()).toEqual(PERFIS_DE_TESTE.map(([p]) => p).sort());
  });

  it.each(PERFIS_DE_TESTE.map(([p]) => p))("%s", async (perfil) => {
    const c = await entrar(amb.novoCliente(), perfil);
    const r = await c.get("/config");
    const espera = ESPERADO[perfil]!;
    if (espera === null) {
      expect(r.status, perfil).toBe(403);
      expect(r.text).toContain("Não há configuração liberada para o seu perfil de acesso.");
      expect(r.text).not.toContain("PostgreSQL");
      expect((await c.get("/modulos")).text).not.toContain('href="/config"');
      return;
    }
    expect(r.status, perfil).toBe(200);
    expect(r.text).not.toContain("Template render error");
    expect(blocos_no(r.text).sort(), perfil).toEqual([...espera].sort());
    // o host do banco só vai a quem vê "Onde o dado mora"
    expect(r.text.includes("PostgreSQL"), perfil).toBe(espera.includes("onde_mora"));
    expect((await c.get("/modulos")).text, perfil).toContain('href="/config"');
  });
});

describe("o nível por módulo manda", () => {
  it("EPI em Sem acesso: o coordenador não vê a Retirada de EPI", async () => {
    await nivel("coordenador_csso", "epis", "SEM_ACESSO");
    const c = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await c.get("/config");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(MARCA.retirada_epi);
    expect(r.text).toContain(MARCA.sla);
  });

  it("EPI em Sem acesso: o almoxarife fica sem bloco — 403 e sem engrenagem", async () => {
    await nivel("almoxarife_sesmt", "epis", "SEM_ACESSO");
    const c = await entrar(amb.novoCliente(), "almoxarife_sesmt");
    expect((await c.get("/config")).status).toBe(403);
    expect((await c.get("/modulos")).text).not.toContain('href="/config"');
  });

  it("Processos SEI em Sem acesso: some a seção do processo, e gravar SLA é 403", async () => {
    await nivel("coordenador_csso", "processos-sei", "SEM_ACESSO");
    const c = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await c.get("/config");
    expect(r.status).toBe(200);
    for (const b of ["setor_emissor", "sla", "integracao_sei", "editar_sla"] as const) {
      expect(r.text, b).not.toContain(MARCA[b]);
    }
    // a retirada de EPI continua, e com ela o título da seção
    expect(r.text).toContain(MARCA.retirada_epi);
    expect(r.text).toContain(MARCA.secao_setor);
    expect((await c.post("/config/sla", { sla_A_FAZER: "3" }, { seguir: false })).status).toBe(403);
  });

  it("Processos SEI em Consulta: lê o SLA, mas o formulário some e o POST é 403", async () => {
    await nivel("coordenador_csso", "processos-sei", "CONSULTA");
    const c = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await c.get("/config");
    expect(r.text).toContain(MARCA.sla);
    expect(r.text).toContain(MARCA.setor_emissor);
    expect(r.text).not.toContain(MARCA.editar_sla);
    expect(r.text).not.toContain("Editar os prazos");
    expect((await c.post("/config/sla", { sla_A_FAZER: "3" }, { seguir: false })).status).toBe(403);
  });

  it("título de seção vazio não sai", async () => {
    const admin = await entrar(amb.novoCliente(), "admin_ti");
    expect((await admin.get("/config")).text).not.toContain(MARCA.secao_setor);
    const tecnico = await entrar(amb.novoCliente(), "tecnico_seguranca");
    expect((await tecnico.get("/config")).text).not.toContain(MARCA.secao_sistema);
  });
});

describe("as rotas POST não confiam no template", () => {
  const CASOS: [string, string][] = [
    ["/config/sla", "tecnico_seguranca"],
    ["/config/sla", "almoxarife_sesmt"],
    ["/config/sla", "admin_ti"],
    ["/config/sla", "servidor_consulta"],
    ["/config/backup", "coordenador_csso"],
    ["/config/backup", "almoxarife_sesmt"],
    ["/config/backup", "servidor_consulta"],
    ["/config/exportar-tudo", "tecnico_seguranca"],
    ["/config/exportar-tudo", "admin_ti"],
    ["/config/exportar-tudo", "almoxarife_sesmt"],
    ["/config/exportar-tudo", "servidor_consulta"],
  ];
  it.each(CASOS)("%s recusa %s com 403", async (rota, perfil) => {
    const c = await entrar(amb.novoCliente(), perfil);
    expect((await c.post(rota, {}, { seguir: false })).status).toBe(403);
  });

  it("quem tem o bloco grava o SLA", async () => {
    const c = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await c.post("/config/sla", { sla_A_FAZER: "9" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="sla_A_FAZER" value="9"');
  });
});
