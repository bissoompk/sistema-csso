/**
 * Lote 3 (24/11/2026): o certificado e a carga em HORAS ou TEMPOS.
 *
 * - O certificado NOVO congela a unidade e escreve a carga pela função única ("10 tempos", "4h30").
 * - O certificado JÁ EMITIDO (congelado sem unidade) reimprime igual: "4,5 horas", e a segunda via
 *   confere com o hash gravado.
 * - Os resumos do titular somam horas e tempos em separado.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-carga-cert-"));

import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { ContextoCertificado } from "../src/servicos/certificado.js";
import { texto_de_certificacao } from "../src/servicos/certificado_pdf.js";
import * as certificados_titular from "../src/servicos/certificados_titular.js";
import * as documento from "../src/servicos/documento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import { normalizar_fluxo } from "../src/servicos/textos.js";
import { bancoLimpo, type Cliente } from "./ajuda.js";
import * as servico_turma from "../src/servicos/turma.js";
import { INICIO, _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

const texto = (bytes: Uint8Array) => normalizar_fluxo(documento.extrair_texto(bytes));

async function emitido(d: Parameters<typeof _cenario>[2]) {
  const usuario = await _usuario(db);
  const cen = await _cenario(db, usuario, d);
  const r = await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
  const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, r.certificado.id));
  return { usuario, cen, r, cert: cert! };
}

describe("o certificado novo congela a unidade", () => {
  it("em TEMPOS: '10 tempos' no .docx, no PDF e na validação; nada em horas", async () => {
    const { r, cert } = await emitido({ carga: "10", unidade: "TEMPOS", horas: "10" });
    const k = cert.contexto_congelado as Record<string, unknown>;
    expect([k.carga_horaria, k.carga_unidade]).toEqual(["10", "TEMPOS"]);
    const docx = texto(r.bytes);
    expect(docx).toContain("10 tempos");
    expect(docx).not.toMatch(/10 horas|10 h\b/);
    const ctx = servico.montar_contexto(db, cert);
    const pdf = texto_de_certificacao(ctx);
    // lote 4 (redação 4): "com carga horária de 10 tempos", como o .docx e o Anexo I do CBMMG
    expect(pdf).toContain(", com carga horária de 10 tempos");
    expect(pdf).not.toContain("com carga de");
    const validacao = (await cliente.get(`/validar/${cert.chave_validacao}`)).text;
    expect(validacao).toContain("10 tempos");
  });

  it("em HORAS com fração: '4h30' (a função única), e a frase do PDF continua 'carga horária'", async () => {
    const { r, cert } = await emitido({ carga: "4.5", horas: "4.5" });
    expect((cert.contexto_congelado as Record<string, unknown>).carga_unidade).toBe("HORAS");
    expect(texto(r.bytes)).toContain("4h30");
    expect(texto_de_certificacao(servico.montar_contexto(db, cert))).toContain(", com carga horária de 4h30");
  });

  it("em HORAS inteiras, o texto é o mesmo de antes do lote 3: '8 horas'", async () => {
    const { r } = await emitido({});
    expect(texto(r.bytes)).toContain("8 horas");
  });
});

describe("certificado já emitido não muda", () => {
  it("o congelado sem unidade (de antes do lote 3) reimprime '4,5 horas', como saiu", async () => {
    const { usuario, cert } = await emitido({ carga: "4.5", horas: "4.5" });
    // o congelado como o lote 2 gravava: sem `carga_unidade`
    const { carga_unidade: _fora, ...antigo } = cert.contexto_congelado as Record<string, unknown>;
    const ctx = ContextoCertificado.descongelar(antigo);
    expect(ctx.carga_unidade).toBeNull();
    expect(texto_de_certificacao(ctx)).toContain(", com carga horária de 4,5 horas");
    await db.update(e.certificado).set({ contexto_congelado: antigo }).where(eq(e.certificado.id, cert.id));
    const [relido] = await db.select().from(e.certificado).where(eq(e.certificado.id, cert.id));
    const segunda = await servico.segunda_via(db, usuario, relido!);
    expect(texto(segunda.bytes)).toContain("4,5 horas");
    expect(texto(segunda.bytes)).not.toContain("4h30");
  });

  it("o congelado sem unidade e carga inteira reimprime idêntico, e a segunda via confere com o hash", async () => {
    const { usuario, r, cert } = await emitido({});
    const antes = texto(r.bytes);
    const { carga_unidade: _fora, ...antigo } = cert.contexto_congelado as Record<string, unknown>;
    await db.update(e.certificado).set({ contexto_congelado: antigo }).where(eq(e.certificado.id, cert.id));
    const [relido] = await db.select().from(e.certificado).where(eq(e.certificado.id, cert.id));
    const segunda = await servico.segunda_via(db, usuario, relido!);
    expect(texto(segunda.bytes)).toBe(antes);
    expect(segunda.confere).toBe(true);
    expect(segunda.hash_conteudo).toBe(cert.hash_conteudo);
  });
});

describe("somas separadas no resumo do titular", () => {
  it("'8 horas · 10 tempos': horas e tempos não se somam", async () => {
    const um = await emitido({});
    // um segundo certificado, do mesmo servidor, num treinamento em tempos
    const [t] = await db
      .insert(e.treinamento)
      .values({ codigo: "BRIG", nome: "Brigada — CBMMG", carga_horaria_horas: "10", carga_unidade: "TEMPOS", validade_meses: 12, codigo_curto: "BRIG" })
      .returning();
    // outra turma, com a mesma pessoa inscrita (um certificado ativo por inscrição)
    const turma2 = await servico_turma.criar_turma(db, um.usuario, {
      treinamento: t!,
      data_inicio: INICIO,
      data_fim: INICIO,
      local: "Pátio do Corpo de Bombeiros",
    });
    const inscricao2 = await servico_turma.inscrever(db, um.usuario, turma2, um.cen.inscricao.participante);
    const contexto = { ...(um.cert.contexto_congelado as Record<string, unknown>), carga_horaria: "10", carga_unidade: "TEMPOS", treinamento_nome: t!.nome };
    await db.insert(e.certificado).values({
      ...um.cert,
      id: undefined as never,
      inscricao_id: inscricao2.id,
      numero: um.cert.numero + 1,
      chave_validacao: um.cert.chave_validacao.replace(/-0001-/, "-0002-"),
      numero_impresso: null,
      treinamento_id: t!.id,
      contexto_congelado: contexto,
    });
    const dados = await certificados_titular.do_titular(db, um.cen.servidor.id, "2026-11-24");
    expect(dados.resumo.somas).toEqual({ HORAS: 480, TEMPOS: 10 });
    expect(dados.resumo.carga_texto).toBe("8 horas · 10 tempos");
    expect(dados.cartoes.map((c) => c.carga_horaria).sort()).toEqual(["10 tempos", "8 horas"]);
  });
});
