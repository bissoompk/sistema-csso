/**
 * O painel não pode afirmar dois números para o mesmo fato.
 * Porte de `testes/integracao/test_painel_contadores.py`.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as repo from "../src/repositorios/processos.js";
import { precisa_de_atencao, resumir } from "../src/servicos/processo.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

// mais que os oito que cabem no cartão: é o que faz o corte aparecer
const QUANTOS = 11;
const { db, novoCliente } = await bancoLimpo();
await contas(db);

const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
const [tipo] = await db.select().from(e.tipo_processo).orderBy(asc(e.tipo_processo.id)).limit(1);
for (let n = 0; n < QUANTOS; n++) {
  await db.insert(e.processo).values({
    nup: `23086.00${700 + n}0/2026-11`,
    tipo_processo_id: tipo!.id,
    etapa_id: etapa!.id,
    estado_tecnico: "RECEBIDO",
    data_autuacao: "2026-01-05",
    ano_referencia: 2026,
  });
}

/** O total que `/processos` publica no subtítulo, nas três formas dele. */
function total_da_lista(corpo: string): number {
  if (corpo.includes("Nenhum processo no filtro atual.")) return 0;
  let achado = /(\d+) de (\d+) processo\(s\) no filtro atual/.exec(corpo);
  if (achado) return Number(achado[2]);
  achado = /(\d+) processo\(s\) no filtro atual/.exec(corpo);
  expect(achado, "subtítulo de /processos não encontrado").not.toBeNull();
  return Number(achado![1]);
}

describe("painel", () => {
  it("o contador do cartão não para em oito", async () => {
    const corpo = (await (await entrar(novoCliente(), "coordenador_csso")).get("/")).text;
    expect(corpo).toContain(`8 de ${QUANTOS}`);
  });

  it("o link do cartão leva à lista que ele conta", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    expect((await cliente.get("/")).text).toContain('href="/processos?precisam=1">Ver todos');
    expect(total_da_lista((await cliente.get("/processos?precisam=1")).text)).toBe(QUANTOS);
  });

  it("KPI do SLA e a fila dele também concordam", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const painel = (await cliente.get("/")).text;
    const kpi = /Acima do SLA<\/div>\s*<div class="medida"><span class="valor">(\d+)<\/span>/.exec(painel);
    expect(kpi, painel.slice(0, 500)).not.toBeNull();
    expect(total_da_lista((await cliente.get("/processos?atrasados=1")).text)).toBe(Number(kpi![1]));
  });

  it("o critério do cartão é o critério do filtro", async () => {
    const usuario = new UsuarioAtual({
      id: 1,
      login: "conferente",
      nome: "Conferente",
      permissoes: ["processo.ver", "exposicao.ver"],
      perfis: ["coordenador_csso"],
    });
    const [, total] = await repo.listar(db, usuario, new repo.Filtro({ precisam: true, por_pagina: 1000 }));
    const [todos] = await repo.listar(db, usuario, new repo.Filtro({ por_pagina: 1000 }));
    let a_mao = 0;
    for (const p of todos) if (precisa_de_atencao(await resumir(db, p))) a_mao += 1;
    expect(total).toBe(a_mao);
  });

  it("superintendente sem perfil operacional recebe a dica", async () => {
    const corpo = (await (await entrar(novoCliente(), "superintendente")).get("/")).text;
    if (corpo.includes("Painel")) expect(corpo).toContain("Próximo passo: conceder o perfil operacional");
  });
});
