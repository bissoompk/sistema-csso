/**
 * Filtro de saúde (RN-21, lista ampliada do EPI) campo a campo na ficha de EPI, pela tela — 24/11/2026.
 * Reproduz o reteste: "servidor com lesão no ombro" na observação da entrega gravava o registro.
 * Cada campo recusa pelo menos três termos, "lesão" e variações inclusive, e não grava nada.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";
import { bancoPorTeste, cenario as montar, entregar, ENTREGAS, FICHAS, recado, registros } from "./ajuda_epi_ficha";

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

const TERMOS = [
  "servidor com lesão no ombro",
  "punho lesionado",
  "lesões nas mãos",
  "relata alergia ao látex",
  "trouxe atestado médico",
];

function coordenador(): Promise<Cliente> {
  return entrar(novoCliente(), "coordenador_csso");
}

describe("filtro de saúde por campo — ficha de EPI (24/11/2026)", () => {
  it("observação da entrega: cada termo é recusado e nenhum registro é gravado", async () => {
    const c = await montar(db);
    const cli = await coordenador();
    for (const t of TERMOS) {
      const r = await entregar(cli, c, { observacao: t });
      expect(recado(r), t).toContain("dado de saúde");
    }
    expect(await registros(db)).toEqual([]);
    // sem o termo, a mesma entrega grava
    expect((await entregar(cli, c, { observacao: "entregue no balcão do almoxarifado" })).status).toBe(303);
    expect(await registros(db)).toHaveLength(1);
  });

  it("justificativa da exceção ao máximo: cada termo é recusado e nenhum registro é gravado", async () => {
    const c = await montar(db);
    const cli = await coordenador();
    for (const t of TERMOS) {
      const r = await entregar(cli, c, { justificativa_excecao: t });
      expect(recado(r), t).toContain("dado de saúde");
    }
    expect(await registros(db)).toEqual([]);
  });

  it("motivo da devolução: cada termo é recusado e a devolução não é gravada", async () => {
    const c = await montar(db);
    const cli = await coordenador();
    expect((await entregar(cli, c)).status).toBe(303);
    const [entrega] = await registros(db);
    for (const t of TERMOS) {
      const r = await cli.post(`${FICHAS}/registros/${entrega!.id}/devolucao`, { quantidade: "1", motivo: t, data_evento: "" }, { seguir: false });
      expect(recado(r), t).toContain("dado de saúde");
    }
    expect(await registros(db)).toHaveLength(1);
  });

  it("motivo do estorno (cancelamento da entrega): cada termo é recusado e o estorno não é gravado", async () => {
    const c = await montar(db);
    const cli = await coordenador();
    expect((await entregar(cli, c)).status).toBe(303);
    const [entrega] = await registros(db);
    for (const t of TERMOS) {
      const r = await cli.post(`${FICHAS}/registros/${entrega!.id}/estorno`, { motivo: t }, { seguir: false });
      expect(recado(r), t).toContain("dado de saúde");
    }
    expect(await registros(db)).toHaveLength(1);
  });

  it("complemento da recusa de entrega: cada termo é recusado e a recusa não é registrada", async () => {
    await montar(db);
    const cli = await coordenador();
    const [motivo] = await db.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, "OUTRO"));
    const recusas = () => db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "EPI_ENTREGA_RECUSADA"));
    for (const t of TERMOS) {
      const r = await cli.post(
        `${ENTREGAS}/recusa`,
        { motivo_id: String(motivo!.id), a_quem: "terceirizado da limpeza", unidade: "FAMED", complemento: t },
        { seguir: false },
      );
      expect(recado(r), t).toContain("dado de saúde");
    }
    expect(await recusas()).toEqual([]);
  });
});
