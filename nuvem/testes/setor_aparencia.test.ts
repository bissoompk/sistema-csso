/**
 * NUVEM (Portal do servidor, 22/10/2026): cor e ícone do setor promotor —
 * a paleta do `csso.css` (contraste AA calculado aqui, a partir da folha) e o
 * popup "Aparência" de Treinamentos → Setores promotores
 * (`rotas/setores_aparencia.ts`, `setor_promotor.definir_aparencia`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { APARENCIA_SETOR_INICIAL, CORES_SETOR, ICONES_SETOR } from "../src/dominio/organizacao.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(aqui, "../public/estaticos/css/csso.css"), "utf8");
const TELA = "/treinamentos/setores-promotores";

// ---------------------------------------------------------------------
// contraste (WCAG 2.x, luminância relativa)
// ---------------------------------------------------------------------
function luminancia(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** O trecho da subseção PORTAL/SETOR da folha. */
function subsecao(): string {
  const ini = CSS.indexOf("/* ---------- PORTAL/SETOR");
  const fim = CSS.indexOf("/* ---------- fim PORTAL/SETOR ---------- */");
  expect(ini).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(ini);
  return CSS.slice(ini, fim);
}

/** `--paleta-{chave}{sufixo}: #hex` no `:root` da subseção. */
function token(bloco: string, chave: string, sufixo = ""): string {
  const m = bloco.match(new RegExp(`--paleta-${chave}${sufixo}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  expect(m, `--paleta-${chave}${sufixo} ausente`).not.toBeNull();
  return m![1]!;
}

describe("paleta do csso.css", () => {
  it("cobre todas as chaves de CORES_SETOR, mais o padrão, com os quatro tokens", () => {
    const bloco = subsecao();
    for (const chave of [...CORES_SETOR, "padrao"]) {
      const regra = bloco.match(new RegExp(`\\.setor--${chave}\\b[^{]*\\{([^}]*)\\}`));
      expect(regra, `.setor--${chave} ausente`).not.toBeNull();
      for (const t of ["--setor-cor", "--setor-fundo", "--setor-texto", "--setor-borda"]) {
        expect(regra![1], `${t} em .setor--${chave}`).toContain(`${t}:`);
      }
    }
    expect(bloco).toMatch(/\.setor--padrao[^{]*\{[^}]*--setor-cor:\s*var\(--acento\)/);
    expect(bloco).toMatch(/\.selo-setor\s*\{/);
    expect(bloco).toMatch(/\.selo-setor\.solido\s*\{[^}]*background:\s*var\(--setor-cor\);\s*color:\s*#fff/);
  });

  it("cada cor passa o AA: sólido × branco e texto × pastel ≥ 4,5", () => {
    const bloco = subsecao();
    for (const chave of CORES_SETOR) {
      const solido = token(bloco, chave);
      const fundo = token(bloco, chave, "-fundo");
      const texto = token(bloco, chave, "-texto");
      expect(contraste(solido, "#ffffff"), `${chave}: ${solido} × branco`).toBeGreaterThanOrEqual(4.5);
      expect(contraste(texto, fundo), `${chave}: ${texto} × ${fundo}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("os cinco setores da Sisa têm cores distintas entre si", () => {
    const bloco = subsecao();
    const cores = Object.values(APARENCIA_SETOR_INICIAL).map((a) => token(bloco, a.cor).toLowerCase());
    expect(new Set(cores).size).toBe(5);
    // e o petróleo da CPOS não é o azul da CSSO
    expect(token(bloco, "petroleo").toLowerCase()).not.toBe(token(bloco, "azul").toLowerCase());
  });

  it("a prévia do popup conhece todas as cores e todos os ícones", () => {
    const bloco = subsecao();
    for (const chave of CORES_SETOR) expect(bloco).toContain(`input[name="cor"][value="${chave}"]:checked`);
    expect(bloco).toContain(`input[name="cor"][value=""]:checked`);
    for (const ic of ICONES_SETOR) expect(bloco).toContain(`.previa-ico--${ic} `);
  });
});

// ---------------------------------------------------------------------
// tela e POST
// ---------------------------------------------------------------------
let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});

async function _unidade(sigla: string) {
  const [u] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla));
  return u!;
}

async function _eventos(unidade_id: number) {
  return db
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.entidade, "unidade_uorg"), eq(e.historico_evento.entidade_id, unidade_id)));
}

describe("tela de setores promotores", () => {
  it("mostra o selo de cada setor, o popup com cores e ícones nomeados, sem style nem script inline", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get(TELA);
    expect(r.status).toBe(200);
    const csso = await _unidade("CSSO");
    expect(csso.cor_setor).toBe("azul");
    expect(r.text).toMatch(/<span class="selo-setor setor--azul\s*"[^>]*>[\s\S]*?#shield-plus[\s\S]*?<span>CSSO<\/span>/);
    expect(r.text).toMatch(/selo-setor setor--petroleo[\s\S]*?<span>CPOS<\/span>/);
    // o popup da CSSO, com a cor gravada marcada e cada cor com o nome escrito
    expect(r.text).toContain(`href="#aparencia-${csso.id}"`);
    expect(r.text).toContain(`action="${TELA}/${csso.id}/aparencia"`);
    expect(r.text).toContain("Cor do sistema");
    for (const nome of ["Azul", "Verde-petróleo", "Âmbar", "Grafite"]) expect(r.text).toContain(`<span>${nome}</span>`);
    expect(r.text).toContain("<span>Escudo (segurança)</span>");
    expect(r.text).toMatch(/name="cor" value="azul" checked/);
    expect(r.text).not.toMatch(/\sstyle=/);
    expect(r.text).not.toMatch(/<style[\s>]/);
    // o único <script> embutido é o da casca, com o nonce da CSP; o da tela, nenhum
    expect(r.text).not.toMatch(/<script(?![^>]*\s(?:src|nonce)=)[^>]*>/);
    const modelo = readFileSync(path.join(aqui, "../templates/paginas/setores_promotores.html"), "utf8");
    expect(modelo).not.toMatch(/<script|<style|\sstyle=/);
  });

  it("quem só vê a lista vê o selo, mas não a Aparência", async () => {
    const secretaria = await entrar(novoCliente(), "secretaria_csso");
    const r = await secretaria.get(TELA);
    expect(r.status).toBe(200);
    expect(r.text).toContain("selo-setor setor--azul");
    expect(r.text).not.toContain("/aparencia");
  });
});

describe("POST da aparência", () => {
  it("grava cor e ícone, com a trilha CAMPO_ALTERADO", async () => {
    await entrar(cliente, "coordenador_csso");
    const cpel = await _unidade("CPEL");
    const r = await cliente.post(`${TELA}/${cpel.id}/aparencia`, { cor: "vinho", icone: "award" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Aparência de CPEL gravada");
    const depois = await _unidade("CPEL");
    expect([depois.cor_setor, depois.icone_setor]).toEqual(["vinho", "award"]);
    const eventos = await _eventos(cpel.id);
    expect(eventos.map((ev) => [ev.tipo_evento, ev.campo, ev.valor_anterior, ev.valor_novo]).sort()).toEqual(
      [
        ["CAMPO_ALTERADO", "cor_setor", "roxo", "vinho"],
        ["CAMPO_ALTERADO", "icone_setor", "mortarboard", "award"],
      ].sort(),
    );
    expect(eventos.every((ev) => ev.usuario_id !== null)).toBe(true);
    // a lista mostra o selo novo
    expect((await cliente.get(TELA)).text).toMatch(/selo-setor setor--vinho[\s\S]*?#award[\s\S]*?<span>CPEL<\/span>/);
  });

  it("vazio é a cor do sistema e selo sem ícone; repetir não grava de novo", async () => {
    await entrar(cliente, "coordenador_csso");
    const csqv = await _unidade("CSQV");
    expect((await cliente.post(`${TELA}/${csqv.id}/aparencia`, { cor: "", icone: "" }, { seguir: false })).status).toBe(303);
    const depois = await _unidade("CSQV");
    expect([depois.cor_setor, depois.icone_setor]).toEqual([null, null]);
    expect((await cliente.get(TELA)).text).toMatch(/selo-setor setor--padrao[^>]*>\s*<span>CSQV<\/span>/);
    const n = (await _eventos(csqv.id)).length;
    await cliente.post(`${TELA}/${csqv.id}/aparencia`, { cor: "", icone: "" }, { seguir: false });
    expect(await _eventos(csqv.id)).toHaveLength(n);
  });

  it("recusa cor ou ícone fora da paleta, com aviso e sem gravar", async () => {
    await entrar(cliente, "coordenador_csso");
    const csso = await _unidade("CSSO");
    const cor = await cliente.post(`${TELA}/${csso.id}/aparencia`, { cor: "#ff0000", icone: "award" }, { seguir: false });
    expect(cor.status).toBe(303);
    expect(decodeURIComponent(cor.location!)).toContain("Cor fora da paleta");
    const icone = await cliente.post(`${TELA}/${csso.id}/aparencia`, { cor: "verde", icone: "caveira" }, { seguir: false });
    expect(decodeURIComponent(icone.location!)).toContain("Ícone fora da lista");
    const depois = await _unidade("CSSO");
    expect([depois.cor_setor, depois.icone_setor]).toEqual(["azul", "shield-plus"]);
    expect(await _eventos(csso.id)).toHaveLength(0);
  });

  it("unidade que não promove treinamento é recusada", async () => {
    await entrar(cliente, "coordenador_csso");
    const famed = await _unidade("FAMED");
    const r = await cliente.post(`${TELA}/${famed.id}/aparencia`, { cor: "verde", icone: "" }, { seguir: false });
    expect(decodeURIComponent(r.location!)).toContain("não está entre os setores promotores");
    expect((await _unidade("FAMED")).cor_setor).toBeNull();
  });

  it("exige treinamento.gerenciar: servidor comum e secretaria recebem 403", async () => {
    const csso = await _unidade("CSSO");
    for (const login of ["servidor_consulta", "secretaria_csso"]) {
      const c = await entrar(novoCliente(), login);
      const r = await c.post(`${TELA}/${csso.id}/aparencia`, { cor: "vinho", icone: "award" }, { seguir: false });
      expect(r.status, login).toBe(403);
    }
    expect((await _unidade("CSSO")).cor_setor).toBe("azul");
  });
});
