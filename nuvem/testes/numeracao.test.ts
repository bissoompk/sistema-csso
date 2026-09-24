/**
 * RN-03 — numeração sequencial por ano. Porte da parte de numeração de
 * `test_servicos_diversos.py` e do essencial de `test_concorrencia_emissao.py`
 * no nível do serviço: sob concorrência, nenhum número repete e nenhum pula.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

process.env.CSSO_POOL_MAX = "6";

import { bancoLimpo, naTransacao } from "./ajuda";
import * as numeracao from "../src/servicos/numeracao";

const { db } = await bancoLimpo();

describe("numeracao", () => {
  it("nunca usa MAX(numero)+1, SEQUENCE nem UUID (só o código conta)", () => {
    const fonte = readFileSync(new URL("../src/servicos/numeracao.ts", import.meta.url), "utf8");
    // tira comentários: a proibição aparece de propósito na documentação
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codigo.replace(/\s/g, "")).not.toContain("MAX(numero)+1");
    expect(codigo.toLowerCase()).not.toContain("uuid");
    expect(codigo.toUpperCase()).not.toContain("CREATE SEQUENCE");
    expect(codigo).toContain("parecer_sequencia");
  });

  it("recusa tabela fora da lista fechada, par trocado e coluna não admitida", async () => {
    await expect(
      naTransacao((tx) => numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "usuario; DROP", tabela_alvo: "x" })),
    ).rejects.toBeInstanceOf(numeracao.SequenciaDesconhecida);
    await expect(
      naTransacao((tx) => numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "turma_sequencia", tabela_alvo: "certificado" })),
    ).rejects.toThrow(/numera 'turma'/);
    await expect(
      naTransacao((tx) =>
        numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "turma_sequencia", tabela_alvo: "turma", coluna: "id" }),
      ),
    ).rejects.toThrow(/coluna de numeracao nao admitida/);
    await expect(
      naTransacao((tx) => numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "toString", tabela_alvo: "x" })),
    ).rejects.toBeInstanceOf(numeracao.SequenciaDesconhecida);
  });

  it("sequencial por ano, reiniciando no ano novo", async () => {
    const a = await naTransacao(async (tx) => [
      await numeracao.proximo_numero_turma(tx, 2030),
      await numeracao.proximo_numero_turma(tx, 2030),
      await numeracao.proximo_numero_turma(tx, 2031),
    ]);
    expect(a).toEqual([1, 2, 1]);
  });

  it("rollback devolve o número (ele só é gasto quando o ato comita)", async () => {
    await expect(
      db.transaction(async (tx) => {
        expect(await numeracao.proximo_numero_certificado(tx, 2040)).toBe(1);
        throw new Error("desfaz");
      }),
    ).rejects.toThrow("desfaz");
    expect(await naTransacao((tx) => numeracao.proximo_numero_certificado(tx, 2040))).toBe(1);
  });

  it("sob concorrência: nenhum número repete e nenhum pula", async () => {
    const numeros = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.transaction(async (tx) => {
          const n = await numeracao.proximo_numero_parecer(tx, 2050);
          await new Promise((r) => setTimeout(r, 5)); // o documento sendo montado
          return n;
        }),
      ),
    );
    expect([...numeros].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("pula número já ocupado na tabela alvo (o RESERVADO da migração)", async () => {
    await naTransacao(async (tx) => {
      // só o número importa: FKs e travas desligadas nesta transação de teste
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`INSERT INTO epi_requisicao (protocolo, numero, ano, servidor_id, solicitado_por_id, entrou_no_estado_em, criado_em, estado, enviada_em)
            VALUES ('EPI-2060-0002', 2, 2060, 999999, 999999, now(), now(), 'ENVIADA', now())`,
      );
    });
    const r = await naTransacao(async (tx) => [
      await numeracao.proximo_numero_requisicao_epi(tx, 2060),
      await numeracao.proximo_numero_requisicao_epi(tx, 2060),
    ]);
    expect(r).toEqual([1, 3]);
  });

  it("recontar e lacunas", async () => {
    await naTransacao(async (tx) => {
      await tx.execute(sql`INSERT INTO parecer_sequencia (ano, ultimo_numero) VALUES (2070, 0)`);
    });
    const recontado = await naTransacao((tx) => numeracao.recontar_sequencia(tx));
    expect(recontado instanceof Map).toBe(true);
    await naTransacao(async (tx) => {
      await tx.execute(sql`UPDATE parecer_sequencia SET ultimo_numero = 4 WHERE ano = 2070`);
    });
    expect(await naTransacao((tx) => numeracao.lacunas_de_numeracao(tx, 2070))).toEqual([1, 2, 3, 4]);
  });
});
