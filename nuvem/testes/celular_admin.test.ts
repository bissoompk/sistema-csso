/**
 * Servidores, administração e base compartilhada no celular (lote E do plano
 * de celular).
 *
 * - /servidores, /auditoria (as duas tabelas) e os históricos de
 *   /servidores/:id viram cartões (`table.empilhavel`): a célula-título sem
 *   rótulo, as outras com `data-coluna` ou `td.acao-linha` (P7, P8, P15);
 * - as tabelas de números de /relatorios e /config rolam de lado com a
 *   primeira coluna parada (`table.coluna-fixa`, P8);
 * - /perfis vem recolhido: um `details.cartao.perfil` fechado por perfil, um
 *   índice de âncoras no topo e cada permissão numa `perm-pilula` (P12);
 * - e-mail e telefone do setor emissor abrem o teclado certo (P13).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste;
let servidorId = 0;

/** As `<table ...>` de um HTML, cada uma com a abertura e o miolo. */
function tabelas(html: string): { abre: string; corpo: string }[] {
  return [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/g)].map((m) => ({ abre: m[1]!, corpo: m[2]! }));
}

/** Os atributos dos `<td>` de cada `<tr>` do corpo (fora do `<thead>`). */
function linhas(corpo: string): string[][] {
  const semCabeca = corpo.replace(/<thead>[\s\S]*?<\/thead>/, "");
  return [...semCabeca.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1]!.matchAll(/<td\b([^>]*)>/g)].map((t) => t[1]!));
}

/**
 * Contrato do cartão empilhado: exatamente uma célula-título (sem rótulo e sem
 * ser a ação) por linha; todo o resto tem `data-coluna` ou é `acao-linha`.
 */
function confereEmpilhavel(corpo: string) {
  const ls = linhas(corpo).filter((tds) => !(tds.length === 1 && /colspan/.test(tds[0]!)));
  expect(ls.length, "a lista veio vazia: o teste não conferiu nenhuma linha").toBeGreaterThan(0);
  for (const tds of ls) {
    const titulos = tds.filter((td) => !/data-coluna="[^"]+"/.test(td) && !/class="[^"]*\bacao-linha\b/.test(td));
    expect(titulos, `linha com ${titulos.length} célula(s)-título: ${tds.join(" | ")}`).toHaveLength(1);
  }
}

beforeAll(async () => {
  amb = await bancoLimpo();
  const db = amb.db;
  await contas(db);
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  const [cargo] = await db.select().from(e.cargo).limit(1);
  const [servidor] = await db.insert(e.servidor).values({
    siape: "7654321", nome: "Joana Ribeiro de Almeida", cargo_id: cargo!.id, unidade_uorg_id: unidade!.id,
  }).returning();
  servidorId = servidor!.id;
  await db.insert(e.servidor_lotacao).values({
    servidor_id: servidorId, unidade_uorg_id: unidade!.id, cargo_id: cargo!.id,
    vigencia_inicio: "2024-01-01", documento: "Portaria 1/2024",
  });
});

describe("listas em cartões (P7, P8)", () => {
  it("/servidores é empilhavel, com o nome de título", async () => {
    const c = await entrar(amb.cliente, "coordenador_csso");
    const html = (await c.get("/servidores")).text;
    const [t] = tabelas(html);
    expect(t!.abre).toMatch(/class="empilhavel"/);
    confereEmpilhavel(t!.corpo);
    expect(t!.corpo).toMatch(/<td data-coluna="Identificação"><a class="mono" href="\/servidores\//);
    expect(t!.corpo).toMatch(/<td class="nome">\s*Joana Ribeiro de Almeida/);
    expect(t!.corpo).toMatch(/class="curta" data-coluna="Situação"/);
  });

  it("/servidores/:id: os históricos são empilhavel", async () => {
    const c = await entrar(amb.cliente, "coordenador_csso");
    const html = (await c.get(`/servidores/${servidorId}`)).text;
    const ts = tabelas(html);
    expect(ts.length).toBeGreaterThan(0);
    for (const t of ts) expect(t.abre).toMatch(/class="empilhavel"/);
    confereEmpilhavel(ts[0]!.corpo); // a lotação, com o Período de título
    // As tabelas que dependem de processo, parecer, adicional e EPI: o molde.
    const molde = readFileSync("templates/paginas/servidor_ficha.html", "utf8");
    expect(molde.match(/<table\b[^>]*>/g)).toEqual(Array(5).fill('<table class="empilhavel">'));
  });

  it("/auditoria: as duas tabelas são empilhavel, com a conta de título", async () => {
    // A leitura da ficha acima gravou acesso a dado sensível (RN-23); o
    // cadastro abaixo põe um evento na trilha.
    const co = await entrar(amb.cliente, "coordenador_csso");
    expect((await co.post("/servidores", { siape: "1110654", nome: "Marco Teste" }, { seguir: false })).status).toBe(303);
    const c = await entrar(amb.cliente, "admin_ti");
    const html = (await c.get("/auditoria")).text;
    const ts = tabelas(html);
    expect(ts).toHaveLength(2);
    for (const t of ts) {
      expect(t.abre).toMatch(/class="empilhavel"/);
      confereEmpilhavel(t.corpo);
    }
    // A conta em `<td>` puro: é o contexto que a varredura da RN-19 aceita.
    expect(ts[0]!.corpo).toMatch(/<td>[^<]+<\/td>\s*<td data-coluna="Evento"><span class="nome">/);
  });

  it("/relatorios e /config: tabelas de números com a coluna fixa", async () => {
    const c = await entrar(amb.cliente, "coordenador_csso");
    const rel = tabelas((await c.get("/relatorios")).text);
    expect(rel.filter((t) => /coluna-fixa/.test(t.abre)).length).toBeGreaterThanOrEqual(3);
    const cfg = tabelas((await c.get("/config")).text);
    expect(cfg.filter((t) => /coluna-fixa/.test(t.abre)).length).toBe(2);
  });
});

describe("/perfis recolhido (P12)", () => {
  it("um details.cartao.perfil fechado por perfil, com índice e perm-pilula", async () => {
    const c = await entrar(amb.cliente, "admin_ti");
    const r = await c.get("/perfis");
    expect(r.status).toBe(200);
    const total = Number(r.text.match(/<span class="contador">(\d+) perfis<\/span>/)![1]);
    expect(total).toBeGreaterThan(5);
    const cartoes = [...r.text.matchAll(/<details class="cartao perfil" id="perfil-([a-z_]+)"(\s+open)?>/g)];
    expect(cartoes).toHaveLength(total);
    expect(cartoes.every((m) => !m[2]), "cartão de perfil aberto por padrão").toBe(true);
    for (const [, codigo] of cartoes) expect(r.text).toContain(`href="#perfil-${codigo}"`);
    expect(r.text).toMatch(/<summary>\s*<h2>[^<]+<\/h2>\s*<span class="mono discreto">[a-z_]+<\/span>\s*<span class="nota a-direita">\d+ permissões<\/span>/);
    expect(r.text).toMatch(/class="pilula perm-pilula sem-ponto/);
    // A funcionalidade de antes continua lá.
    expect(r.text).toContain("Alcance:");
    expect(r.text).toContain("só funciona somada a habilitação técnica");
  });
});

describe("teclado certo (P13)", () => {
  it("setor emissor: e-mail e telefone", async () => {
    const c = await entrar(amb.cliente, "coordenador_csso");
    const html = (await c.get("/catalogos/setores-emissores")).text;
    expect(html).toMatch(/<input id="set-email" name="email" type="email" autocomplete="email"/);
    expect(html).toMatch(/<input id="set-tel" name="telefone" type="tel" autocomplete="tel"/);
    expect(html).toMatch(/<input id="ed-setor-emissor-\d+-email" name="email" type="email"/);
    expect(html).toMatch(/<input id="ed-setor-emissor-\d+-tel" name="telefone" type="tel"/);
  });
});

describe("sem estilo nem script inline", () => {
  it("nos moldes do lote", () => {
    for (const nome of ["servidores", "servidor_ficha", "auditoria", "perfis", "relatorios", "config",
      "catalogo_lista", "usuarios", "perfis_niveis", "setores_promotores", "minha_conta"]) {
      const molde = readFileSync(`templates/paginas/${nome}.html`, "utf8");
      expect(molde, nome).not.toMatch(/\sstyle=|<style|<script>/);
    }
  });
});
