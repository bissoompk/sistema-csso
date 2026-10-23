/**
 * Módulo de acidentes (CAT/SP), fundação (F0): o esquema e as travas.
 *
 * O que se prova aqui, contra o banco de verdade:
 * - a CAT/SP, o relatório, o encaminhamento e a decisão pericial são
 *   append-only (UPDATE, DELETE e TRUNCATE recusados);
 * - a ocorrência não se apaga, a identidade dela não muda, o estado final não
 *   sai do lugar, e os fatos do evento só mudam junto de uma versão nova da
 *   CAT/SP; o trâmite (estado, responsável, prazo prorrogado) muda livremente;
 * - o nível 2 da saúde só vai a NULL junto do carimbo de expurgo;
 * - o acidentado tem uma única identificação e nenhum CPF;
 * - as listas de `travas.ts` cobrem TODAS as colunas da ocorrência.
 *
 * Só há dados fictícios: nenhum nome, CPF ou fato real.
 */
import { getTableColumns, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bancoLimpo, naTransacao } from "./ajuda";
import { acidente_ocorrencia } from "../src/db/esquema/index";
import { OCORRENCIA_FATOS, OCORRENCIA_IDENTIDADE, OCORRENCIA_TRAMITE } from "../src/db/travas";
import { montar_protocolo } from "../src/dominio/acidente";
import type { Executor } from "../src/db/cliente";

await bancoLimpo();

const HASH = "a".repeat(64);

async function nova_ocorrencia(tx: Executor, numero: number): Promise<number> {
  const protocolo = montar_protocolo(2030, numero);
  const r: any = await tx.execute(sql`
    INSERT INTO acidente_ocorrencia
      (protocolo, ano, numero, especie, origem, data_evento, local_tipo, local_especificacao, prazo_comunicacao, criado_em)
    VALUES (${protocolo}, 2030, ${numero}, 'TIPICO', 'SST', '2030-03-01', 'ESTABELECIMENTO_UFVJM', 'Sala fictícia', '2030-03-11', now())
    RETURNING id`);
  return (r.rows ?? r)[0].id as number;
}

async function nova_cat_sp(tx: Executor, ocorrencia_id: number, versao: number, substitui_id: number | null = null) {
  const motivo = versao > 1 ? "retificação fictícia" : null;
  const r: any = await tx.execute(sql`
    INSERT INTO acidente_cat_sp (ocorrencia_id, versao, contexto_congelado, hash_conteudo, motivo_retificacao, substitui_id, origem, registrada_em)
    VALUES (${ocorrencia_id}, ${versao}, '{}', ${HASH}, ${motivo}, ${substitui_id}, 'COMUNICACAO', now())
    RETURNING id`);
  return (r.rows ?? r)[0].id as number;
}

/** O banco recusou, e a mensagem (ou a constraint) da causa casa com `trecho`. */
async function recusa(f: (tx: Executor) => Promise<unknown>, trecho: RegExp | string) {
  let texto: string | null = null;
  try {
    await naTransacao(f);
  } catch (erro: any) {
    texto = [erro?.message, erro?.cause?.message, erro?.cause?.constraint_name].filter(Boolean).join(" | ");
  }
  expect(texto, "o banco aceitou o que devia recusar").not.toBeNull();
  if (typeof trecho === "string") expect(texto).toContain(trecho);
  else expect(texto).toMatch(trecho);
}

describe("travas das tabelas append-only", () => {
  it("a CAT/SP não aceita UPDATE, DELETE nem TRUNCATE; a versão seguinte é linha nova", async () => {
    const { oc, cat } = await naTransacao(async (tx) => {
      const oc = await nova_ocorrencia(tx, 1);
      return { oc, cat: await nova_cat_sp(tx, oc, 1) };
    });
    await recusa((tx) => tx.execute(sql`UPDATE acidente_cat_sp SET hash_conteudo = ${"b".repeat(64)} WHERE id = ${cat}`), /append-only/);
    await recusa((tx) => tx.execute(sql`DELETE FROM acidente_cat_sp WHERE id = ${cat}`), /append-only/);
    await recusa((tx) => tx.execute(sql`TRUNCATE acidente_cat_sp CASCADE`), /append-only|TRUNCATE/);
    // a retificação é a versão 2, que aponta a 1 e traz o motivo
    await naTransacao((tx) => nova_cat_sp(tx, oc, 2, cat));
    // versão 2 sem motivo ou sem substituída é recusada pelo CHECK
    await recusa(
      (tx) =>
        tx.execute(sql`
          INSERT INTO acidente_cat_sp (ocorrencia_id, versao, contexto_congelado, hash_conteudo, origem, registrada_em)
          VALUES (${oc}, 3, '{}', ${HASH}, 'RETIFICACAO_SST', now())`),
      /ck_acid_cat_retificacao/,
    );
  });

  it("as demais tabelas append-only recusam UPDATE e DELETE (a trava vale antes de qualquer linha)", async () => {
    // sem linhas, o gatilho por linha não dispara; o de TRUNCATE sim
    for (const tabela of ["acidente_relatorio", "acidente_encaminhamento", "acidente_decisao_pericial"]) {
      await recusa((tx) => tx.execute(sql.raw(`TRUNCATE ${tabela} CASCADE`)), /append-only|TRUNCATE/);
    }
  });
});

describe("a ocorrência", () => {
  it("não se apaga", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 2));
    await recusa((tx) => tx.execute(sql`DELETE FROM acidente_ocorrencia WHERE id = ${oc}`), /guardada para sempre/);
    await recusa((tx) => tx.execute(sql`TRUNCATE acidente_ocorrencia CASCADE`), /guardada para sempre/);
  });

  it("a identidade nunca muda", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 3));
    await recusa((tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET origem = 'CHEFIA' WHERE id = ${oc}`), /nao mudam/);
    await recusa((tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET tipo_cat = 'REABERTURA' WHERE id = ${oc}`), /./);
  });

  it("o trâmite muda livremente", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 4));
    await naTransacao((tx) =>
      tx.execute(sql`UPDATE acidente_ocorrencia SET estado = 'EM_TRIAGEM', versao = versao + 1 WHERE id = ${oc}`),
    );
    const r: any = await naTransacao((tx) => tx.execute(sql`SELECT estado FROM acidente_ocorrencia WHERE id = ${oc}`));
    expect((r.rows ?? r)[0].estado).toBe("EM_TRIAGEM");
  });

  it("o estado final não sai do lugar", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 5));
    await naTransacao((tx) =>
      tx.execute(sql`
        UPDATE acidente_ocorrencia SET estado = 'CANCELADA', cancelamento_motivo = 'DUPLICADA' WHERE id = ${oc}`),
    );
    await recusa((tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET estado = 'RECEBIDA' WHERE id = ${oc}`), /estado final/);
  });

  it("os fatos do evento só mudam por retificação, com versão nova da CAT/SP", async () => {
    const { oc, cat } = await naTransacao(async (tx) => {
      const oc = await nova_ocorrencia(tx, 6);
      return { oc, cat: await nova_cat_sp(tx, oc, 1) };
    });
    // sem versão nova: recusado
    await recusa(
      (tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET local_especificacao = 'Outro lugar' WHERE id = ${oc}`),
      /retificacao/,
    );
    // subir a versão para uma que NÃO existe: recusado
    await recusa((tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET cat_sp_versao = 2 WHERE id = ${oc}`), /nao existe/);
    // com a versão 2 gravada na mesma transação: aceito
    await naTransacao(async (tx) => {
      await nova_cat_sp(tx, oc, 2, cat);
      await tx.execute(
        sql`UPDATE acidente_ocorrencia SET local_especificacao = 'Outro lugar', cat_sp_versao = 2 WHERE id = ${oc}`,
      );
    });
    // e a versão não volta
    await recusa((tx) => tx.execute(sql`UPDATE acidente_ocorrencia SET cat_sp_versao = 1 WHERE id = ${oc}`), /nao volta/);
  });

  it("o prazo de comunicação é a data do acidente mais 10 dias, e o protocolo bate com o número", async () => {
    await recusa(
      (tx) =>
        tx.execute(sql`
          INSERT INTO acidente_ocorrencia (protocolo, ano, numero, especie, origem, data_evento, local_tipo, local_especificacao, prazo_comunicacao, criado_em)
          VALUES ('CAT-2030-0099', 2030, 99, 'TIPICO', 'SST', '2030-03-01', 'ESTABELECIMENTO_UFVJM', 'x', '2030-03-12', now())`),
      /ck_acid_oc_prazo/,
    );
    await recusa(
      (tx) =>
        tx.execute(sql`
          INSERT INTO acidente_ocorrencia (protocolo, ano, numero, especie, origem, data_evento, local_tipo, local_especificacao, prazo_comunicacao, criado_em)
          VALUES ('CAT-2030-0001', 2030, 98, 'TIPICO', 'SST', '2030-03-01', 'ESTABELECIMENTO_UFVJM', 'x', '2030-03-11', now())`),
      /ck_acid_oc_numero/,
    );
  });

  it("as listas de colunas de travas.ts cobrem todas as colunas da ocorrência, cada uma uma vez", () => {
    const colunas = Object.values(getTableColumns(acidente_ocorrencia)).map((c) => c.name).sort();
    const declaradas = [...OCORRENCIA_IDENTIDADE, ...OCORRENCIA_FATOS, ...OCORRENCIA_TRAMITE].sort();
    expect(declaradas).toEqual(colunas);
    expect(new Set(declaradas).size).toBe(declaradas.length);
  });
});

describe("o acidentado", () => {
  it("tem exatamente uma identificação e nenhum CPF", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 7));
    // nenhuma identificação
    await recusa(
      (tx) =>
        tx.execute(sql`
          INSERT INTO acidentado (ocorrencia_id, ordem, vinculo, condicao, criado_em) VALUES (${oc}, 1, 'TERCEIRIZADO', 'ACIDENTADO', now())`),
      /ck_acidentado_identificacao/,
    );
    // identificação com forma de CPF
    for (const cpf of ["123.456.789-09", "12345678909"]) {
      await recusa(
        (tx) =>
          tx.execute(sql`
            INSERT INTO acidentado (ocorrencia_id, ordem, vinculo, condicao, nome_externo, identificacao_externa, criado_em)
            VALUES (${oc}, 1, 'TERCEIRIZADO', 'ACIDENTADO', 'Pessoa Fictícia', ${cpf}, now())`),
        /ck_acidentado_sem_cpf/,
      );
    }
    // matrícula comum passa; não se apaga
    await naTransacao((tx) =>
      tx.execute(sql`
        INSERT INTO acidentado (ocorrencia_id, ordem, vinculo, condicao, nome_externo, identificacao_externa, criado_em)
        VALUES (${oc}, 1, 'TERCEIRIZADO', 'ACIDENTADO', 'Pessoa Fictícia', 'MAT-4521', now())`),
    );
    await recusa((tx) => tx.execute(sql`DELETE FROM acidentado WHERE ocorrencia_id = ${oc}`), /guardado para sempre/);
  });
});

describe("a saúde: dois níveis", () => {
  it("o nível 2 só vai a NULL junto do carimbo de expurgo e depois não volta", async () => {
    const oc = await naTransacao((tx) => nova_ocorrencia(tx, 8));
    const acidentado_id = await naTransacao(async (tx) => {
      const r: any = await tx.execute(sql`
        INSERT INTO acidentado (ocorrencia_id, ordem, vinculo, condicao, nome_externo, criado_em)
        VALUES (${oc}, 1, 'TERCEIRIZADO', 'ACIDENTADO', 'Pessoa Fictícia', now()) RETURNING id`);
      return (r.rows ?? r)[0].id as number;
    });
    await naTransacao((tx) =>
      tx.execute(sql`
        INSERT INTO acidente_saude (acidentado_id, houve_afastamento, dias_afastamento, origem, registrado_em)
        VALUES (${acidentado_id}, 'SIM', 12, 'REGISTRADO_MEDICO', now())`),
    );
    await recusa(
      (tx) => tx.execute(sql`UPDATE acidente_saude SET dias_afastamento = NULL WHERE acidentado_id = ${acidentado_id}`),
      /carimbo de expurgo/,
    );
    await naTransacao((tx) =>
      tx.execute(sql`
        UPDATE acidente_saude SET dias_afastamento = NULL, detalhe_expurgado_em = now() WHERE acidentado_id = ${acidentado_id}`),
    );
    await recusa(
      (tx) => tx.execute(sql`UPDATE acidente_saude SET dias_afastamento = 3 WHERE acidentado_id = ${acidentado_id}`),
      /nao se preenche de novo/,
    );
    await recusa((tx) => tx.execute(sql`DELETE FROM acidente_saude WHERE acidentado_id = ${acidentado_id}`), /guardado para sempre/);
  });
});
