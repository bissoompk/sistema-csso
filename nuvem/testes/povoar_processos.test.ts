/**
 * O povoamento de Processos SEI (dentro do `povoar` do ambiente de teste) deixa
 * as telas com o que o Python deixava: onze processos, três pareceres, dois
 * adicionais vigentes, o L2 superado e a pendência de reavaliação.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { povoar } from "../ferramentas/ambiente-teste.js";
import { bancoLimpo, naTransacao } from "./ajuda";

await bancoLimpo();

describe("povoar_processos", () => {
  it("povoa sobre a base e as contagens batem", async () => {
    // `povoar` já chama `povoar_processos` e, no fim, `envelhecer_pendencias`
    const resumo = await naTransacao((tx) => povoar(tx));
    expect(resumo.processos).toBe(11);
    expect(resumo.pareceres).toBe(3);
    await naTransacao(async (tx) => {
      expect(await tx.select().from(e.processo)).toHaveLength(11);
      const pareceres = await tx.select().from(e.parecer_tecnico);
      expect(pareceres.map((p) => p.situacao).sort()).toEqual(["ASSINADO", "ASSINADO", "RASCUNHO"]);
      expect(await tx.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.estado, "VIGENTE"))).toHaveLength(2);
      const reav = await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "REAVALIACAO_LAUDO"));
      expect(reav).toHaveLength(1);
    });
    expect(resumo.pendencias_atrasadas).toBeGreaterThanOrEqual(2);
  });
});
