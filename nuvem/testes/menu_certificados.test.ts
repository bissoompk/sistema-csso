/**
 * NUVEM: o menu de Certificados e Treinamentos em grupos (22/10/2026) — o
 * subtítulo de cada grupo, a ordem que cada perfil vê e os rótulos novos no
 * destaque e na trilha. A regra dos grupos está em `modulos.test.ts`; aqui é
 * o HTML que sai da casca.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

/** O bloco das telas do módulo ativo, de `<div class="menu menu-modulo"` até o fim da lateral. */
function menu_modulo(corpo: string): string {
  const lateral = corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));
  const inicio = lateral.indexOf('class="menu menu-modulo"');
  expect(inicio, "a lateral não tem o menu do módulo").toBeGreaterThan(-1);
  const fim = lateral.indexOf('class="menu menu-base"');
  return lateral.slice(inicio, fim === -1 ? undefined : fim);
}

function hrefs(trecho: string): string[] {
  return [...trecho.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!);
}

async function tela(perfil: string, caminho: string): Promise<string> {
  const cliente = novoCliente();
  await entrar(cliente, perfil);
  const r = await cliente.get(caminho);
  expect(r.status, caminho).toBe(200);
  return r.text;
}

describe("menu de Certificados e Treinamentos em grupos", () => {
  it("cada grupo é um group com o subtítulo que o nomeia", async () => {
    const corpo = await tela("coordenador_csso", "/turmas");
    expect(corpo).toContain('class="menu menu-modulo" role="group"');
    const menu = menu_modulo(corpo);
    const rotulados = [...menu.matchAll(/aria-labelledby="(grupo-certificados-\d+)"/g)].map((m) => m[1]!);
    expect(rotulados.length).toBe(4);
    for (const id of rotulados) expect(menu, id).toContain(`id="${id}"`);
    // o subtítulo não é título: o esqueleto de títulos da tela não muda
    expect(menu).not.toMatch(/<h[1-6]/);
  });

  it("a secretaria vê as telas na ordem dos grupos", async () => {
    const menu = menu_modulo(await tela("secretaria_csso", "/turmas"));
    expect(hrefs(menu)).toEqual([
      "/treinamentos",
      "/turmas",
      "/turmas/pedidos",
      "/certificados/fila",
      "/certificados",
      "/certificados/emails",
      "/certificados/vencimentos",
      "/treinamentos/indicadores",
      "/treinamentos/catalogo",
      "/treinamentos/setores-promotores",
      "/treinamentos/locais",
      // o seletor de módulos da lateral: a secretaria também triaria acidentes (23/10/2026)
      "/acidentes",
      "/ocorrencias",
    ]);
  });

  it("com servidor vinculado, Meus treinamentos e Meus certificados vão para o bloco Meu espaço, depois da base", async () => {
    const sem = menu_modulo(await tela("coordenador_csso", "/turmas"));
    expect(sem).not.toContain(">Meu espaço<");
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "7650001", nome: "Coordenador Vinculado", unidade_uorg_id: unidade!.id })
      .returning();
    await db.update(e.usuario).set({ servidor_id: servidor!.id }).where(eq(e.usuario.id, conta!.id));
    try {
      const corpo = await tela("coordenador_csso", "/turmas");
      const com = menu_modulo(corpo);
      // o grupo do módulo some, e os dois itens não aparecem duas vezes
      expect(com).not.toContain(">Meu espaço<");
      expect(hrefs(com)).not.toContain("/turmas/minhas");
      const lateral = corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));
      const bloco = lateral.slice(lateral.indexOf('class="menu menu-meu ao-lado"'));
      expect(lateral.indexOf('class="menu menu-meu ao-lado"')).toBeGreaterThan(lateral.indexOf('class="menu menu-base"'));
      expect(hrefs(bloco).slice(0, 2)).toEqual(["/turmas/minhas", "/certificados/meus"]);
      expect(lateral.split('href="/certificados/meus"').length - 1).toBe(1);
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.id, conta!.id));
    }
  });

  it.each([
    ["/certificados/emails", "Envios por e-mail"],
    ["/certificados", "Emitidos"],
  ])("em %s o destaque e a trilha dizem %s", async (caminho, rotulo) => {
    const corpo = await tela("coordenador_csso", caminho);
    expect(menu_modulo(corpo)).toMatch(
      new RegExp(`<a href="${caminho}"[^>]*aria-current="page"[^>]*>.*?<span>${rotulo}</span></a>`, "s"),
    );
    expect(corpo).toMatch(new RegExp(`<nav class="trilha"[^>]*>[\\s\\S]*?<a href="${caminho}">${rotulo}</a>`));
  });

  it("o admin de TI não abre os Indicadores: indicador.ver saiu do perfil (22/10/2026)", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "admin_ti");
    expect((await cliente.get("/treinamentos/indicadores")).status).toBe(403);
    const lateral = (await cliente.get("/auditoria")).text;
    expect(lateral).not.toContain('href="/treinamentos/indicadores"');
  });

  it("o mapa dos módulos mostra os mesmos grupos", async () => {
    const corpo = await tela("coordenador_csso", "/modulos");
    for (const titulo of ["Turmas e inscrições", "Acompanhamento", "Cadastros"]) {
      expect(corpo, titulo).toContain(`<h3 class="rotulo-grupo-mapa">${titulo}</h3>`);
    }
  });
});
