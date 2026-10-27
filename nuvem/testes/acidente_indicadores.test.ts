/**
 * F8 do módulo de acidentes: o hub e os indicadores. Célula com menos de 5
 * casos sai suprimida, com a supressão secundária; o CSV sai com BOM e com a
 * fórmula neutralizada; a permissão vem antes do período; todo número do hub
 * leva a uma lista. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as comunicar from "../src/servicos/acidente_comunicacao.js";
import * as indicadores from "../src/servicos/acidente_indicadores.js";
import { bancoLimpo, contas, entrar, ORIGEM, usuarioAtual, type Cliente } from "./ajuda.js";
import { dados, titular } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;
let app: Awaited<ReturnType<typeof bancoLimpo>>["app"];

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  app = amb.app;
  await contas(db);
});

/** `n` comunicações da espécie, todas do mesmo titular fictício. */
async function comunicados(especie: string, n: number, campus_id: number | null = null) {
  const { usuario } = await titular(db).catch(async () => ({ usuario: await usuarioAtual(db, "servidor_consulta") }));
  const base = dados();
  for (let i = 0; i < n; i++) {
    await db.transaction((tx) => comunicar.comunicar(tx, usuario, dados({ fatos: { ...base.fatos, especie, campus_id } })));
  }
}

const periodo = () => {
  const ano = new Date().getFullYear();
  return { inicio: `${ano - 1}-01-01`, fim: `${ano}-12-31` };
};

describe("os números", () => {
  it("recorte com menos de 5 casos sai suprimido, e a secundária esconde o menor dos outros quando sobraria um só", async () => {
    await comunicados("TIPICO", 6);
    await comunicados("INCIDENTE", 1);
    const coord = await usuarioAtual(db, "coordenador_csso");
    const d = await db.transaction((tx) => indicadores.calcular(tx, coord, periodo()));
    expect(d.total).toBe("7");
    // 1 caso suprimido sozinho devolveria o número por subtração: o outro se esconde junto
    expect(Object.values(d.por_especie)).toEqual(["—", "—"]);
  });

  it("com duas células pequenas só elas somem; a grande aparece", async () => {
    await comunicados("TIPICO", 6);
    await comunicados("INCIDENTE", 2);
    await comunicados("OUTRO", 1);
    const coord = await usuarioAtual(db, "coordenador_csso");
    const d = await db.transaction((tx) => indicadores.calcular(tx, coord, periodo()));
    expect(Object.values(d.por_especie).sort()).toEqual(["6", "—", "—"]);
  });

  it("o total abaixo de 5 também sai suprimido; o período sem casos não quebra", async () => {
    await comunicados("TIPICO", 3);
    const coord = await usuarioAtual(db, "coordenador_csso");
    const d = await db.transaction((tx) => indicadores.calcular(tx, coord, periodo()));
    expect(d.total).toBe("—");
    const vazio = await db.transaction((tx) => indicadores.calcular(tx, coord, { inicio: "1990-01-01", fim: "1990-12-31" }));
    expect(vazio.total).toBe("—");
    expect(vazio.por_especie).toEqual({});
  });

  it("os afastamentos só aparecem a quem lê o detalhe clínico", async () => {
    await comunicados("TIPICO", 6);
    const coord = await usuarioAtual(db, "coordenador_csso");
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    expect((await db.transaction((tx) => indicadores.calcular(tx, coord, periodo()))).afastamento).not.toBeNull();
    expect((await db.transaction((tx) => indicadores.calcular(tx, tecnico, periodo()))).afastamento).toBeNull();
  });
});

describe("pela tela", () => {
  it("a permissão vem antes do período: quem não vê indicadores recebe 403, não o 422 da data torta", async () => {
    const cli = await entrar(novoCliente(), "servidor_consulta");
    expect((await cli.get("/acidentes/indicadores?inicio=lixo", { seguir: false })).status).toBe(403);
    expect((await cli.get("/acidentes/indicadores/exportar?inicio=lixo", { seguir: false })).status).toBe(403);
    const coord = await entrar(novoCliente(), "coordenador_csso");
    expect((await coord.get("/acidentes/indicadores?inicio=lixo", { seguir: false })).status).toBe(422);
    expect((await coord.get("/acidentes/indicadores", { seguir: false })).status).toBe(200);
  });

  it("o CSV sai com BOM, ponto e vírgula e a fórmula neutralizada", async () => {
    const [campus] = await db.select().from(e.campus).limit(1);
    await db.update(e.campus).set({ sigla: "=EVIL" }).where(sql`${e.campus.id} = ${campus!.id}`);
    await comunicados("TIPICO", 6, campus!.id);
    const coord = await entrar(novoCliente(), "coordenador_csso");
    const r = await coord.get("/acidentes/indicadores/exportar", { seguir: false });
    expect(r.status).toBe(200);
    expect(String(r.headers.get("content-type"))).toContain("text/csv");
    // os bytes crus: o `text()` do fetch engole o BOM, e é o BOM que se confere
    const cookie = [...coord.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const cru = await app.fetch(new Request(`${ORIGEM}/acidentes/indicadores/exportar`, { headers: { cookie } }));
    const bytes = new Uint8Array(await cru.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text).toContain("dimensao;categoria;casos");
    expect(r.text).toContain("'=EVIL");
    expect(r.text).not.toMatch(/(^|;)=EVIL/m);
  });
});

describe("o hub", () => {
  it("mostra o plano com as vencidas e os indicadores, cada um com link; a secretaria não vê o plano", async () => {
    const coord = await entrar(novoCliente(), "coordenador_csso");
    const hub = await coord.get("/acidentes");
    expect(hub.text).toContain('href="/acidentes/acoes?mostrar=vencidas"');
    expect(hub.text).toContain('href="/acidentes/indicadores"');
    const sec = await entrar(novoCliente(), "secretaria_csso");
    const h2 = await sec.get("/acidentes");
    expect(h2.text).not.toContain("/acidentes/acoes?mostrar=vencidas");
  });

  it("a versão pessoal (servidor comum) não tem plano nem indicadores", async () => {
    const cli = await entrar(novoCliente(), "servidor_consulta");
    const hub = await cli.get("/acidentes");
    expect(hub.text).not.toContain("/acidentes/indicadores");
    expect(hub.text).not.toContain("/acidentes/acoes");
  });
});
