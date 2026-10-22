/**
 * NUVEM: setores promotores (`servicos/setor_promotor.ts`). A unidade promotora
 * da turma sai só da lista que o setor mantém — no começo, os da Sisa —, e a
 * turma antiga com unidade fora da lista fica com ela.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { SETORES_PROMOTORES_INICIAIS, semear } from "../src/servicos/sementes.js";
import { bancoLimpo, contas, entrar, naTransacao, type Cliente } from "./ajuda";

const aqui = path.dirname(fileURLToPath(import.meta.url));

const NR35 = { codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24" };
const INICIO = somar_dias(hoje_iso(), 30);
const FIM = somar_dias(INICIO, 1);
const TURMA = { data_inicio: INICIO, data_fim: FIM, frequencia_minima_percentual: "75" };

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

async function _promotoras(): Promise<string[]> {
  const linhas = await db
    .select({ sigla: e.unidade_uorg.sigla })
    .from(e.unidade_uorg)
    .where(eq(e.unidade_uorg.promove_treinamento, true));
  return linhas.map((l) => l.sigla!).sort();
}

async function _treinamento(c: Cliente): Promise<number> {
  const r = await c.post("/treinamentos/catalogo", NR35, { seguir: false });
  expect(r.status, r.text.slice(0, 300)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, NR35.codigo));
  return t!.id;
}

/** As opções (value → rótulo) do <select> de id `id`. */
function _opcoes(html: string, id: string): Map<string, string> {
  const inicio = html.indexOf(`id="${id}"`);
  expect(inicio, `select #${id} ausente`).toBeGreaterThan(-1);
  const trecho = html.slice(inicio, html.indexOf("</select>", inicio));
  const saida = new Map<string, string>();
  for (const m of trecho.matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)) saida.set(m[1]!, m[2]!.trim());
  return saida;
}

const ordenado = (xs: string[]) => [...xs].sort();

describe("lista inicial", () => {
  it("os seis setores da Sisa nascem promotores, e só eles", async () => {
    expect(await _promotoras()).toEqual(ordenado([...SETORES_PROMOTORES_INICIAIS]));
  });

  it("rodar a semente de novo não remarca o setor que foi desmarcado", async () => {
    const csqv = await _unidade("CSQV");
    await db.update(e.unidade_uorg).set({ promove_treinamento: false }).where(eq(e.unidade_uorg.id, csqv.id));
    await naTransacao((tx) => semear(tx));
    await naTransacao((tx) => semear(tx));
    expect(await _promotoras()).toEqual(ordenado(SETORES_PROMOTORES_INICIAIS.filter((s) => s !== "CSQV")));
    // nem desmarcar todos faz a lista voltar
    await db.update(e.unidade_uorg).set({ promove_treinamento: false });
    await naTransacao((tx) => semear(tx));
    expect(await _promotoras()).toEqual([]);
  });

  it("a migração 0011 marca os da Sisa no banco que já tinha as unidades", async () => {
    await db.update(e.unidade_uorg).set({ promove_treinamento: false });
    const arquivo = readFileSync(path.join(aqui, "../src/db/migracoes/0011_setor_promotor.sql"), "utf8");
    const [, atualizacao] = arquivo.split("--> statement-breakpoint");
    await db.execute(sql.raw(atualizacao!));
    expect(await _promotoras()).toEqual(ordenado([...SETORES_PROMOTORES_INICIAIS]));
  });
});

describe("turma", () => {
  it("o seletor da turma nova oferece só os promotores, pelo nome, com a dica", async () => {
    await entrar(cliente, "coordenador_csso");
    await _treinamento(cliente);
    const html = (await cliente.get("/turmas")).text;
    const opcoes = _opcoes(html, "nova-unidade");
    const promotoras = await db
      .select()
      .from(e.unidade_uorg)
      .where(eq(e.unidade_uorg.promove_treinamento, true));
    expect(new Set(opcoes.keys())).toEqual(new Set(promotoras.map((u) => String(u.id))));
    const nomes = [...opcoes.values()];
    expect(nomes).toEqual([...nomes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(nomes).not.toContain("Faculdade de Medicina de Diamantina");
    expect(html).toContain("Só aparecem os setores cadastrados para promover treinamentos");
  });

  it("abrir turma com unidade fora da lista é recusado; com promotora, passa", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento(cliente);
    const famed = await _unidade("FAMED");
    const recusa = await cliente.post(
      "/turmas",
      { treinamento_id: String(treinamento_id), ...TURMA, unidade_promotora_id: String(famed.id) },
      { seguir: false },
    );
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("não está entre os setores que promovem treinamentos");
    expect(await db.select().from(e.turma)).toHaveLength(0);

    const csso = await _unidade("CSSO");
    const ok = await cliente.post(
      "/turmas",
      { treinamento_id: String(treinamento_id), ...TURMA, unidade_promotora_id: String(csso.id) },
      { seguir: false },
    );
    expect(ok.status).toBe(303);
    const [turma] = await db.select().from(e.turma);
    expect(turma!.unidade_promotora_id).toBe(csso.id);
  });

  it("a turma antiga fica com a unidade fora da lista, e não troca para outra fora dela", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento(cliente);
    expect((await cliente.post("/turmas", { treinamento_id: String(treinamento_id), ...TURMA }, { seguir: false })).status).toBe(303);
    const [turma] = await db.select().from(e.turma);
    const famed = await _unidade("FAMED");
    // o dado de antes da regra: gravado direto, como estava no banco
    await db.update(e.turma).set({ unidade_promotora_id: famed.id }).where(eq(e.turma.id, turma!.id));

    const ficha = (await cliente.get(`/turmas/${turma!.id}`)).text;
    const opcoes = _opcoes(ficha, "unidade_promotora_id");
    expect(opcoes.get(String(famed.id))).toBe("Faculdade de Medicina de Diamantina (fora da lista atual)");
    expect(ficha).toMatch(new RegExp(`<option value="${famed.id}" selected>`));

    // editar outro campo não obriga a trocar
    const editar = (unidade: number) =>
      cliente.post(
        `/turmas/${turma!.id}`,
        { ...TURMA, local: "Sala 2", unidade_promotora_id: String(unidade) },
        { seguir: false },
      );
    const r = await editar(famed.id);
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Turma atualizada");
    let [depois] = await db.select().from(e.turma).where(eq(e.turma.id, turma!.id));
    expect(depois!.local).toBe("Sala 2");
    expect(depois!.unidade_promotora_id).toBe(famed.id);

    // mas não troca para OUTRA unidade fora da lista
    const fammuc = await _unidade("FAMMUC");
    const recusa = await editar(fammuc.id);
    expect(decodeURIComponent(recusa.location!)).toContain("não está entre os setores que promovem treinamentos");
    [depois] = await db.select().from(e.turma).where(eq(e.turma.id, turma!.id));
    expect(depois!.unidade_promotora_id).toBe(famed.id);

    // e trocar por um promotor, ou esvaziar, segue livre
    const csso = await _unidade("CSSO");
    expect(decodeURIComponent((await editar(csso.id)).location!)).toContain("Turma atualizada");
    [depois] = await db.select().from(e.turma).where(eq(e.turma.id, turma!.id));
    expect(depois!.unidade_promotora_id).toBe(csso.id);
  });

  it("o filtro de /turmas lista os promotores e a unidade antiga que promoveu turma", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _treinamento(cliente);
    expect((await cliente.post("/turmas", { treinamento_id: String(treinamento_id), ...TURMA }, { seguir: false })).status).toBe(303);
    const [turma] = await db.select().from(e.turma);
    const famed = await _unidade("FAMED");
    await db.update(e.turma).set({ unidade_promotora_id: famed.id }).where(eq(e.turma.id, turma!.id));
    const filtro = _opcoes((await cliente.get("/turmas")).text, "f-setor");
    const csso = await _unidade("CSSO");
    const dodo = await _unidade("DODO");
    expect(filtro.has(String(csso.id))).toBe(true);
    expect(filtro.has(String(famed.id))).toBe(true);
    expect(filtro.has(String(dodo.id))).toBe(false);
  });
});

describe("tela de setores promotores", () => {
  it("incluir e retirar pedem treinamento.gerenciar e ficam na trilha", async () => {
    const famed = await _unidade("FAMED");
    const cpel = await _unidade("CPEL");

    // a secretaria vê a lista, mas não mexe nela
    const secretaria = await entrar(novoCliente(), "secretaria_csso");
    const vista = await secretaria.get("/treinamentos/setores-promotores");
    expect(vista.status).toBe(200);
    expect(vista.text).toContain("Coordenadoria de Promoção e Educação em Saúde");
    expect(vista.text).not.toContain("retirar da lista");
    expect((await secretaria.post("/treinamentos/setores-promotores", { unidade_id: String(famed.id) }, { seguir: false })).status).toBe(403);
    expect((await secretaria.post(`/treinamentos/setores-promotores/${cpel.id}/retirar`, {}, { seguir: false })).status).toBe(403);
    expect((await _unidade("FAMED")).promove_treinamento).toBe(false);
    expect((await _unidade("CPEL")).promove_treinamento).toBe(true);

    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/setores-promotores")).text;
    expect(_opcoes(tela, "setor-unidade").has(String(famed.id))).toBe(true);
    const incluir = await cliente.post("/treinamentos/setores-promotores", { unidade_id: String(famed.id) }, { seguir: false });
    expect(incluir.status).toBe(303);
    expect((await _unidade("FAMED")).promove_treinamento).toBe(true);
    const retirar = await cliente.post(`/treinamentos/setores-promotores/${cpel.id}/retirar`, {}, { seguir: false });
    expect(retirar.status).toBe(303);
    expect((await _unidade("CPEL")).promove_treinamento).toBe(false);

    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(
        and(
          eq(e.historico_evento.entidade, "unidade_uorg"),
          eq(e.historico_evento.campo, "promove_treinamento"),
          inArray(e.historico_evento.entidade_id, [famed.id, cpel.id]),
        ),
      );
    expect(eventos.map((ev) => [ev.entidade_id, ev.valor_anterior, ev.valor_novo]).sort()).toEqual(
      [
        [famed.id, false, true],
        [cpel.id, true, false],
      ].sort(),
    );
    expect(eventos.every((ev) => ev.usuario_id !== null)).toBe(true);

    // o seletor da turma nova acompanha a lista
    await _treinamento(cliente);
    const opcoes = _opcoes((await cliente.get("/turmas")).text, "nova-unidade");
    expect(opcoes.has(String(famed.id))).toBe(true);
    expect(opcoes.has(String(cpel.id))).toBe(false);
  });

  it("unidade inativa não entra na lista", async () => {
    const dzo = await _unidade("DZO");
    await db.update(e.unidade_uorg).set({ ativo: false }).where(eq(e.unidade_uorg.id, dzo.id));
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post("/treinamentos/setores-promotores", { unidade_id: String(dzo.id) }, { seguir: false });
    expect(decodeURIComponent(r.location!)).toContain("está inativa");
    expect((await _unidade("DZO")).promove_treinamento).toBe(false);
  });

  it("o salvar da linha em Unidades / UORG não mexe na marca", async () => {
    await entrar(cliente, "coordenador_csso");
    const csso = await _unidade("CSSO");
    const r = await cliente.post(
      `/catalogos/unidades-uorg/${csso.id}`,
      {
        nome_oficial: csso.nome_oficial,
        nome_extenso: csso.nome_extenso,
        tipo: csso.tipo,
        campus_id: String(csso.campus_id),
        sigla: csso.sigla ?? "",
        ativo: "1",
      },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect((await _unidade("CSSO")).promove_treinamento).toBe(true);
  });
});
