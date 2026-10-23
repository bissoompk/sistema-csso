/**
 * F4 do módulo de acidentes: o checklist de campo. A base tem as seções 0 a 7;
 * os pontos específicos (seção 8) vêm pela espécie e por PALAVRA INTEIRA do
 * caso — sem os falsos positivos do legado ("impressora" não é prensa,
 * "motorista" não é moto). Salvar grava marcados e observações. Fictício.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as checklist from "../src/servicos/acidente_checklist.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { dados, em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

describe("os temas do caso", () => {
  it("casam por palavra inteira, sem acento e sem caixa", () => {
    expect(checklist.temas_do_caso("Caiu da ESCADA do almoxarifado", "TIPICO")).toEqual(["altura"]);
    expect(checklist.temas_do_caso("Choque elétrico no quadro", "TIPICO")).toEqual(["eletrico"]);
    expect(checklist.temas_do_caso("Mão na prensa hidráulica", "TIPICO")).toEqual(["maquina"]);
  });

  it("sem os falsos positivos do legado", () => {
    expect(checklist.temas_do_caso("Tropeçou no cabo da impressora", "TIPICO")).toEqual([]);
    expect(checklist.temas_do_caso("O motorista desceu do caminhão parado", "TIPICO")).toEqual([]);
    expect(checklist.temas_do_caso("Escorregou no piso molhado", "TIPICO")).toEqual([]);
  });

  it("a espécie trajeto e o óbito declarado acionam os seus pontos", () => {
    expect(checklist.temas_do_caso("Na volta para casa", "TRAJETO")).toEqual(["trajeto"]);
    expect(checklist.temas_do_caso("Queda", "TIPICO", true)).toEqual(["obito"]);
  });
});

describe("o checklist da ocorrência", () => {
  it("nasce na primeira abertura com a base (seções 0 a 7) e os específicos do caso, e não duplica", async () => {
    const d = dados();
    d.relato.descricao = "Subiu na escada para pegar a caixa e a escada cedeu.";
    d.relato.atividade_no_momento = "Arrumação de caixas";
    d.fatos.local_especificacao = "Almoxarifado central, corredor 2";
    const { oc } = await em_investigacao(db, { relato: d.relato, fatos: d.fatos });
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.get(`/acidentes/${oc.id}?aba=checklist`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Preparação");
    expect(r.text).toContain("NR-35");
    await cli.get(`/acidentes/${oc.id}?aba=checklist`);
    const itens = await db.select().from(e.acidente_checklist_item).where(eq(e.acidente_checklist_item.ocorrencia_id, oc.id));
    expect(new Set(itens.filter((i) => i.origem === "BASE").map((i) => i.secao))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(itens.filter((i) => i.secao === 8).length).toBe(checklist.ESPECIFICOS.altura!.itens.length);
    expect(itens.length).toBe(checklist.BASE.length + checklist.ESPECIFICOS.altura!.itens.length);
  });

  it("salvar grava marcados e observações; item da equipe se acrescenta e sai; o da base não sai", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    await cli.get(`/acidentes/${oc.id}?aba=checklist`);
    const itens = await db.select().from(e.acidente_checklist_item).where(eq(e.acidente_checklist_item.ocorrencia_id, oc.id));
    const [a, b] = [itens[0]!, itens[1]!];
    const r = await cli.post(`/acidentes/${oc.id}/checklist`, { marcado: [String(a.id)], [`obs_${b.id}`]: "não se aplica" }, { seguir: false });
    expect(r.status).toBe(303);
    const depois = await db.select().from(e.acidente_checklist_item).where(eq(e.acidente_checklist_item.ocorrencia_id, oc.id));
    expect(depois.find((i) => i.id === a.id)!.marcado).toBe(true);
    expect(depois.find((i) => i.id === b.id)!.observacao).toBe("não se aplica");
    await cli.post(`/acidentes/${oc.id}/checklist/item`, { secao: "5", texto: "Conferir a ordem de serviço do setor" });
    const [manual] = await db.select().from(e.acidente_checklist_item).where(eq(e.acidente_checklist_item.origem, "MANUAL"));
    expect(manual!.secao).toBe(5);
    expect((await cli.post(`/acidentes/${oc.id}/checklist/item/${manual!.id}/desativar`, {}, { seguir: false })).status).toBe(303);
    expect((await cli.post(`/acidentes/${oc.id}/checklist/item/${a.id}/desativar`, {}, { seguir: false })).status).toBe(422);
  });
});
