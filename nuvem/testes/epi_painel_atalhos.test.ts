/**
 * A primeira tela de EPI com os cartões do IntegraSST: os cinco da equipe
 * ("Gestão de Segurança do Trabalho (EPI)") e os três do titular ("Portal do
 * Servidor (EPI)"). Cada cartão só aparece para quem tem o ato que ele abre.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { ESCOPO_PROPRIO } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
const logins = Object.keys(await contas(db));

// o titular só vê os atalhos quando a conta está ligada a um servidor
{
  const [cargo] = await db.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [uorg] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [s] = await db
    .insert(e.servidor)
    .values({ siape: "8899001", nome: "Titular dos Atalhos", cargo_id: cargo!.id, unidade_uorg_id: uorg!.id })
    .returning();
  await db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "servidor_consulta"));
}

const EQUIPE: [string, string, (u: Awaited<ReturnType<typeof usuarioAtual>>) => boolean][] = [
  ["Analisar requisições", 'href="/epis/requisicoes"', (u) => u.pode("epi.analisar")],
  ["Controle de estoque", 'href="/epis/estoque"', (u) => u.pode("epi.estoque")],
  ["Catálogo de EPIs", 'href="/epis/catalogo"', (u) => u.pode("epi.catalogo")],
  ["Relatórios e indicadores", 'href="/epis/relatorios"', (u) => u.pode("indicador.ver")],
  ["Fichas de EPI", 'href="/epis/fichas"', (u) => u.pode("epi.ficha")],
];

function _hub(html: string): string {
  const i = html.indexOf('<div class="acoes-hub">');
  expect(i, "a grade de atalhos").toBeGreaterThanOrEqual(0);
  return html.slice(i, html.indexOf("</div>", i));
}

describe("primeira tela de EPI: atalhos do IntegraSST", () => {
  it("cada conta vê só os cartões dos atos que tem", async () => {
    let equipe = 0;
    let pessoal = 0;
    for (const login of logins) {
      const r = await (await entrar(novoCliente(), login)).get("/epis", { seguir: false });
      if (r.status !== 200) continue;
      const u = await usuarioAtual(db, login);
      const hub = _hub(r.text);
      if (u.escopo_de("epi.ver") === ESCOPO_PROPRIO) {
        pessoal++;
        expect(hub, login).toContain("Visualizar requisições");
        expect(hub, login).toContain('href="/epis/fichas/minha"');
        expect(hub.includes("Fazer requisição"), login).toBe(u.pode("epi.requisitar"));
        expect(hub, login).not.toContain("Controle de estoque");
      } else {
        equipe++;
        for (const [titulo, href, pode] of EQUIPE) {
          expect(hub.includes(titulo), `${login}: ${titulo}`).toBe(pode(u));
          if (pode(u)) expect(hub, `${login}: ${titulo}`).toContain(href);
        }
      }
    }
    expect(equipe, "ao menos uma conta da equipe abriu /epis").toBeGreaterThan(0);
    expect(pessoal, "ao menos uma conta de titular abriu /epis").toBeGreaterThan(0);
  });
});
