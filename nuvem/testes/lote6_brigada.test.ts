/**
 * Lote 6 (25/11/2026): a frequência mínima da turma em TEMPOS (brigada) não fica abaixo de 75%
 * (Portaria CBMMG nº 54/2020, art. 40); acima, à escolha. Em HORAS, nada muda.
 */
import { desc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

const INICIO = somar_dias(hoje(), 5);
let db: Banco;
let cliente: Cliente;

beforeEach(async () => {
  let novoCliente: () => Cliente;
  ({ db, novoCliente } = await bancoLimpo());
  await contas(db);
  cliente = novoCliente();
  await entrar(cliente, "coordenador_csso");
});

async function treinamento(unidade: "HORAS" | "TEMPOS") {
  const r = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: `FREQ-${unidade}`, nome: `Frequência ${unidade}`, carga_horaria_horas: "10", carga_unidade: unidade, validade_meses: "24" },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 400)).toBe(303);
  const [t] = await db.select().from(e.treinamento).orderBy(desc(e.treinamento.id)).limit(1);
  return t!;
}

const abrir = (treinamento_id: number, frequencia: string) =>
  cliente.post(
    "/turmas",
    { treinamento_id: String(treinamento_id), data_inicio: INICIO, data_fim: INICIO, local: "Pátio", frequencia_minima_percentual: frequencia },
    { seguir: false },
  );

describe("lote 6 — frequência mínima da turma em TEMPOS", () => {
  it("74,99% é recusado com a citação da portaria; nada é gravado", async () => {
    const t = await treinamento("TEMPOS");
    const r = await abrir(t.id, "74.99");
    expect(r.status).toBe(200);
    expect(r.text).toContain("não fica abaixo de 75%");
    expect(r.text).toContain("Portaria CBMMG nº 54/2020, art. 40");
    expect(await db.select().from(e.turma)).toHaveLength(0);
  });

  it("75% e 80% são aceitos", async () => {
    const t = await treinamento("TEMPOS");
    for (const f of ["75", "80"]) expect((await abrir(t.id, f)).status, f).toBe(303);
    const turmas = await db.select().from(e.turma);
    expect(turmas.map((x) => Number(x.frequencia_minima_percentual)).sort()).toEqual([75, 80]);
  });

  it("editar a turma em TEMPOS para menos de 75% é recusado", async () => {
    const t = await treinamento("TEMPOS");
    expect((await abrir(t.id, "75")).status).toBe(303);
    const [turma] = await db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
    const tela = (await cliente.get(`/turmas/${turma!.id}`)).text;
    expect(tela).toContain("75");
    const r = await cliente.post(
      `/turmas/${turma!.id}`,
      { data_inicio: INICIO, data_fim: INICIO, local: "Pátio", frequencia_minima_percentual: "70" },
      { seguir: false },
    );
    const texto = r.status === 303 ? (await cliente.get(r.location!)).text : r.text;
    expect(texto).toContain("não fica abaixo de 75%");
    const [depois] = await db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
    expect(Number(depois!.frequencia_minima_percentual)).toBe(75);
  });

  it("em HORAS, 60% continua permitido", async () => {
    const t = await treinamento("HORAS");
    expect((await abrir(t.id, "60")).status).toBe(303);
  });
});
