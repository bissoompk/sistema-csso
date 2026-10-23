/**
 * O número do certificado novo (22/10/2026) e a validação pública por ele.
 *
 * - número impresso = sigla do setor promotor + código curto do treinamento +
 *   ano + sequência anual de 4 dígitos (`CSSO-NR35-2026-0001`); sem setor, o
 *   prefixo é `SISA`;
 * - chave de validação = número + 5 sorteados (`CSSO-NR35-2026-0001-K7QMX`);
 * - sequência por prefixo e por ano, sem buraco, sob concorrência real, e o
 *   ROLLBACK devolve o número;
 * - o certificado de antes continua `27/2026`; a anulação não reaproveita;
 * - número/chave não mudam depois de gravados (trava do banco);
 * - /validar aceita a chave nova, a antiga e a nova sem traços; o número
 *   sozinho e o lixo não validam.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-numeracao-cert-"));
process.env.CSSO_POOL_MAX = "6";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import {
  Certificado as C,
  PADRAO_CHAVE_NOVA,
  PADRAO_NUMERO_IMPRESSO,
  montar_numero_impresso,
  prefixo_do_numero,
  sigla_para_numero,
} from "../src/dominio/treinamento.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { chave_valida, gerar_chave, normalizar_chave } from "../src/servicos/certificado.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as numeracao from "../src/servicos/numeracao.js";
import * as servico_turma from "../src/servicos/turma.js";
import * as validacao from "../src/servicos/validacao_certificado.js";
import { bancoLimpo, type Cliente } from "./ajuda.js";
import { _cenario, _usuario, type Cenario } from "./ajuda_certificado.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  validacao.limpar_limites();
});
afterEach(() => validacao.limpar_limites());

const RE_NUMERO = new RegExp(`^${PADRAO_NUMERO_IMPRESSO}$`);
const RE_CHAVE = new RegExp(`^${PADRAO_CHAVE_NOVA}$`);
const ANO = new Date().getFullYear();

async function _cenario_com(d: { sigla?: string | null } = {}): Promise<Cenario & { usuario: UsuarioAtual }> {
  const usuario = await _usuario(db);
  const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
  if (d.sigla !== undefined) {
    const [campus] = await db.select().from(e.campus).limit(1);
    const [unidade] = await db
      .insert(e.unidade_uorg)
      .values({
        sigla: d.sigla,
        nome_oficial: `SETOR DE TESTE ${d.sigla ?? "SEM SIGLA"}`,
        nome_extenso: `Setor de Teste ${d.sigla ?? ""}`.trim(),
        tipo: "COORDENADORIA",
        campus_id: campus!.id,
        promove_treinamento: true,
      })
      .returning();
    await db.update(e.turma).set({ unidade_promotora_id: unidade!.id }).where(eq(e.turma.id, cen.turma.id));
  }
  const turma = (await servico_turma.carregar_turma(db, cen.turma.id))!;
  const reler = async (i: { id: number }) => (await servico_turma.carregar_inscricao(db, i.id, turma))!;
  return { ...cen, turma, inscricao: await reler(cen.inscricao), outras: await Promise.all(cen.outras.map(reler)), usuario };
}

async function _certificado(id: number) {
  return (await db.select().from(e.certificado).where(eq(e.certificado.id, id)))[0]!;
}

// =====================================================================
// Formato
// =====================================================================
describe("formato do número e da chave", () => {
  it("as peças: sigla limpa, prefixo, número de 4 dígitos", () => {
    expect(sigla_para_numero("SecSisa")).toBe("SECSISA");
    expect(sigla_para_numero("Pró-Reitoria")).toBe("PROREITORIA");
    expect(sigla_para_numero(null)).toBe("SISA");
    expect(sigla_para_numero("  ")).toBe("SISA");
    expect(prefixo_do_numero("CSSO", "NR35")).toBe("CSSO-NR35");
    expect(montar_numero_impresso("CSSO-NR35", 2026, 1)).toBe("CSSO-NR35-2026-0001");
    expect(montar_numero_impresso("CSSO-NR35", 2026, 12345)).toBe("CSSO-NR35-2026-12345");
    expect(RE_NUMERO.test("CSSO-NR35-2026-0001")).toBe(true);
    expect(RE_CHAVE.test("CSSO-NR35-2026-0001-K7QMX")).toBe(true);
    // o número sozinho não é chave; O/I/L/U não entram no sorteio
    expect(chave_valida("CSSO-NR35-2026-0001")).toBe(false);
    expect(chave_valida("CSSO-NR35-2026-0001-K7QMO")).toBe(false);
    expect(chave_valida("CSSO-NR35-2026-0001-K7QMX")).toBe(true);
    // a antiga continua valendo
    expect(chave_valida(gerar_chave(2026))).toBe(true);
  });

  it("emitido com setor promotor: CSSO-NR35-ano-0001 e a chave é o número + 5", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const { certificado } = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    expect(certificado.numero_impresso).toBe(`CSSO-NR35-${ANO}-0001`);
    expect(certificado.chave_validacao).toMatch(new RegExp(`^CSSO-NR35-${ANO}-0001-[A-Z0-9]{5}$`));
    expect(RE_CHAVE.test(certificado.chave_validacao)).toBe(true);
    expect(C.rotulo(certificado)).toBe(`CSSO-NR35-${ANO}-0001`);
    const congelado = certificado.contexto_congelado as Record<string, unknown>;
    expect(congelado.numero_impresso).toBe(certificado.numero_impresso);
    expect(String(congelado.url_validacao)).toMatch(new RegExp(`/validar/${certificado.chave_validacao}$`));
    // o endereço sai da configuração, nunca de um domínio fixo
    expect(String(congelado.url_validacao)).not.toContain("cssosisa");
    // a trilha guarda o número novo
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'certificado' AND ${e.historico_evento.entidade_id} = ${certificado.id}
                 AND ${e.historico_evento.tipo_evento} = ${servico.CERTIFICADO_EMITIDO}`);
    expect(evento!.descricao).toContain(`Certificado CSSO-NR35-${ANO}-0001 `);
  });

  it("sem setor promotor (ou setor sem sigla), o prefixo é SISA", async () => {
    const cen = await _cenario_com({ sigla: null });
    const { certificado } = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    expect(certificado.numero_impresso).toBe(`SISA-NR35-${ANO}-0001`);
  });
});

// =====================================================================
// Sequência
// =====================================================================
describe("sequência por prefixo e por ano", () => {
  it("0001, 0002 no mesmo treinamento; outro treinamento recomeça", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const a = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const b = (await servico.emitir(db, cen.usuario, cen.outras[0]!, { gerar_pdf: false })).certificado;
    expect([a.numero_impresso, b.numero_impresso]).toEqual([`CSSO-NR35-${ANO}-0001`, `CSSO-NR35-${ANO}-0002`]);

    // outro código curto (outro prefixo) recomeça em 0001
    await db.update(e.treinamento).set({ codigo_curto: "ALTURA" }).where(eq(e.treinamento.id, cen.treinamento.id));
    await servico.anular(db, cen.usuario, b, "teste: reemitir com outro código");
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.outras[0]!.id))!;
    const c = (await servico.emitir(db, cen.usuario, inscricao, { gerar_pdf: false })).certificado;
    expect(c.numero_impresso).toBe(`CSSO-ALTURA-${ANO}-0001`);
    // e o que já saiu não mudou
    expect((await _certificado(a.id)).numero_impresso).toBe(`CSSO-NR35-${ANO}-0001`);
  });

  it("ano novo recomeça; prefixos diferentes não se misturam", async () => {
    const r = await db.transaction(async (tx) => [
      (await numeracao.proximo_numero_impresso(tx, "CSSO-NR35", 2091, montar_numero_impresso)).numero_impresso,
      (await numeracao.proximo_numero_impresso(tx, "CSSO-NR35", 2091, montar_numero_impresso)).numero_impresso,
      (await numeracao.proximo_numero_impresso(tx, "CSSO-NR35", 2092, montar_numero_impresso)).numero_impresso,
      (await numeracao.proximo_numero_impresso(tx, "CSQV-NR35", 2091, montar_numero_impresso)).numero_impresso,
    ]);
    expect(r).toEqual(["CSSO-NR35-2091-0001", "CSSO-NR35-2091-0002", "CSSO-NR35-2092-0001", "CSQV-NR35-2091-0001"]);
  });

  it("recusa prefixo fora do formato antes de abrir sequência", async () => {
    await expect(
      db.transaction((tx) => numeracao.proximo_numero_impresso(tx, "csso nr35", 2091, montar_numero_impresso)),
    ).rejects.toBeInstanceOf(numeracao.NumeracaoIndisponivel);
    await expect(
      db.transaction((tx) => numeracao.proximo_numero_impresso(tx, "CSSO-NR35", 20911, montar_numero_impresso)),
    ).rejects.toBeInstanceOf(numeracao.NumeracaoIndisponivel);
  });

  it("concorrência real: duas transações no mesmo prefixo recebem 0001 e 0002, sem buraco", async () => {
    const numeros = await Promise.all(
      Array.from({ length: 2 }, () =>
        db.transaction(async (tx) => {
          const r = await numeracao.proximo_numero_impresso(tx, "CSSO-PAR", 2093, montar_numero_impresso);
          await new Promise((ok) => setTimeout(ok, 30)); // o documento sendo montado
          return r.numero_impresso;
        }),
      ),
    );
    expect([...numeros].sort()).toEqual(["CSSO-PAR-2093-0001", "CSSO-PAR-2093-0002"]);

    // em rajada, o mesmo: nenhum repete, nenhum pula
    const rajada = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.transaction(async (tx) => (await numeracao.proximo_numero_impresso(tx, "CSSO-RAJ", 2093, montar_numero_impresso)).sequencia),
      ),
    );
    expect([...rajada].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("ROLLBACK devolve o número — inclusive para quem estava esperando a trava", async () => {
    let liberar!: () => void;
    const segura = new Promise<void>((ok) => (liberar = ok));
    let primeira_pegou!: () => void;
    const pegou = new Promise<void>((ok) => (primeira_pegou = ok));

    const primeira = db.transaction(async (tx) => {
      const r = await numeracao.proximo_numero_impresso(tx, "CSSO-RB", 2094, montar_numero_impresso);
      expect(r.numero_impresso).toBe("CSSO-RB-2094-0001");
      primeira_pegou();
      await segura;
      throw new Error("desfaz");
    });
    await pegou;
    // a segunda espera a trava da linha (prefixo, ano) da primeira
    const segunda = db.transaction(
      async (tx) => (await numeracao.proximo_numero_impresso(tx, "CSSO-RB", 2094, montar_numero_impresso)).numero_impresso,
    );
    await new Promise((ok) => setTimeout(ok, 50));
    liberar();
    await expect(primeira).rejects.toThrow("desfaz");
    // a primeira desfez: a segunda recebe o 0001 que voltou, e não o 0002
    expect(await segunda).toBe("CSSO-RB-2094-0001");
  });

  it("emissão que falha dentro da transação não gasta número", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    await expect(
      db.transaction(async (tx) => {
        await servico.emitir(tx, cen.usuario, cen.inscricao, { gerar_pdf: false });
        throw new Error("desfaz a emissão");
      }),
    ).rejects.toThrow("desfaz a emissão");
    const { certificado } = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    expect(certificado.numero_impresso).toBe(`CSSO-NR35-${ANO}-0001`);
  });
});

// =====================================================================
// O que já existe, a anulação e a imutabilidade
// =====================================================================
describe("o antigo, a anulação e a trava", () => {
  it("o certificado de antes mantém n/ano na tela da validação", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const novo = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    // um certificado emitido antes de 22/10/2026: sem número impresso, chave antiga
    const { id: _id, ...resto } = novo;
    await servico.anular(db, cen.usuario, novo, "abre lugar para o antigo");
    const chave_antiga = gerar_chave(ANO);
    const [antigo] = await db
      .insert(e.certificado)
      .values({
        ...resto,
        inscricao_id: cen.outras[0]!.id,
        numero: 27,
        ano: ANO,
        numero_impresso: null,
        chave_validacao: chave_antiga,
        contexto_congelado: { ...(resto.contexto_congelado as object), numero: 27, ano: ANO, numero_impresso: undefined },
      })
      .returning();
    expect(C.rotulo(antigo!)).toBe(`27/${ANO}`);
    const r = await validacao.consultar(db, chave_antiga);
    expect(r.encontrado).toBe(true);
    expect(r.numero).toBe(`27/${ANO}`);
    const tela = (await cliente.get(`/validar/${chave_antiga}`)).text;
    expect(tela).toContain(`Certificado <span class="mono">27/${ANO}</span>`);
  });

  it("anulação não reaproveita o número", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const a = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    await servico.anular(db, cen.usuario, a, "teste: reemissão");
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id))!;
    const b = (await servico.emitir(db, cen.usuario, inscricao, { gerar_pdf: false })).certificado;
    expect(b.numero_impresso).toBe(`CSSO-NR35-${ANO}-0002`);
    const anulado = await _certificado(a.id);
    expect(anulado.situacao).toBe("ANULADO");
    expect(anulado.numero_impresso).toBe(`CSSO-NR35-${ANO}-0001`);
  });

  it("a trava recusa mudar número impresso, chave, número e ano; o resto muda", async () => {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const a = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const tentar = (campos: Record<string, unknown>) =>
      db.update(e.certificado).set(campos as never).where(eq(e.certificado.id, a.id));
    // o erro do driver vem embrulhado: a mensagem da trava está na causa
    const recusa = async (campos: Record<string, unknown>) => {
      try {
        await tentar(campos);
      } catch (erro) {
        const causa = (erro as { cause?: { message?: string } }).cause?.message ?? (erro as Error).message;
        return causa;
      }
      return "aceitou";
    };
    expect(await recusa({ numero_impresso: `CSSO-NR35-${ANO}-0099` })).toMatch(/nao mudam depois de emitidos/);
    expect(await recusa({ chave_validacao: `${a.numero_impresso}-ZZZZZ` })).toMatch(/nao mudam depois de emitidos/);
    expect(await recusa({ numero: a.numero + 1 })).toMatch(/nao mudam depois de emitidos/);
    expect(await recusa({ numero_impresso: null })).toMatch(/nao mudam depois de emitidos/);
    await tentar({ hash_conteudo: "outro" });
    expect((await _certificado(a.id)).hash_conteudo).toBe("outro");
  });
});

// =====================================================================
// /validar
// =====================================================================
describe("/validar com a chave nova e a antiga", () => {
  async function _dois() {
    const cen = await _cenario_com({ sigla: "CSSO" });
    const novo = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    return { cen, novo };
  }

  const negativa = async (digitada: string) => {
    const corpo = (await cliente.get(`/validar/${encodeURIComponent(digitada)}`)).text;
    // o exemplo impresso na tela contém "CSSO-NR35-2026-0001": fora da comparação
    return corpo
      .replaceAll("CSSO-NR35-2026-0001-K7QMX", "«exemplo»")
      .replaceAll(normalizar_chave(digitada), "«digitado»").replace(/nonce="[^"]*"/g, 'nonce="«marca»"');
  };

  it("a chave nova valida, com 'CSSO confirma' e sem o nome do titular", async () => {
    const { novo, cen } = await _dois();
    const tela = (await cliente.get(`/validar/${novo.chave_validacao}`)).text;
    expect(tela).toContain("Certificado autêntico");
    expect(tela).toContain("CSSO confirma");
    expect(tela).toContain("Sistema SISA");
    expect(tela).toContain(`<span class="mono">${novo.numero_impresso}</span>`);
    expect(tela).not.toContain(cen.servidor.nome);
    for (const pedaco of cen.servidor.nome.split(/\s+/)) expect(tela, pedaco).not.toContain(pedaco);
  });

  it("a nova sem traços (e em minúscula) também valida, e responde com a chave canônica", async () => {
    const { novo } = await _dois();
    const compacta = novo.chave_validacao.replaceAll("-", "").toLowerCase();
    const r = await validacao.consultar(db, compacta);
    expect(r.encontrado).toBe(true);
    expect(r.chave).toBe(novo.chave_validacao);
    // com traços no lugar errado, idem: sem traços, a comparação é a mesma
    const torta = novo.chave_validacao.replace("-NR35-", "-NR-35-");
    expect((await validacao.consultar(db, torta)).encontrado).toBe(true);
    // pelo formulário: a URL leva o que foi digitado e a tela confirma
    const tela = await cliente.get(`/validar/${compacta}`);
    expect(tela.text).toContain("Certificado autêntico");
    // e a conferência de nome funciona a partir dela
    const confere = await cliente.post(`/validar/${compacta}/conferir`, { nome: "Marco Antônio Alves Schetino" });
    expect(confere.text).toContain("<strong>Confere.</strong>");
  });

  it("a chave antiga continua validando", async () => {
    const { novo, cen } = await _dois();
    await servico.anular(db, cen.usuario, novo, "abre lugar para o antigo");
    const { id: _id, ...resto } = novo;
    const chave_antiga = gerar_chave(ANO);
    await db.insert(e.certificado).values({
      ...resto,
      situacao: "EMITIDO",
      inscricao_id: cen.outras[0]!.id,
      numero: 31,
      ano: ANO,
      numero_impresso: null,
      chave_validacao: chave_antiga,
    });
    const tela = (await cliente.get(`/validar/${chave_antiga}`)).text;
    expect(tela).toContain("Certificado autêntico");
    // e sem traços, como antes
    expect((await cliente.get(`/validar/${chave_antiga.replaceAll("-", "").toLowerCase()}`)).text).toContain(
      "Certificado autêntico",
    );
  });

  it("só o número impresso não valida — e a tela orienta a usar o código do QR", async () => {
    const { novo } = await _dois();
    const r = await validacao.consultar(db, novo.numero_impresso);
    expect(r.encontrado).toBe(false);
    expect((await validacao.consultar(db, novo.numero_impresso!.replaceAll("-", ""))).encontrado).toBe(false);
    expect((await validacao.consultar(db, C.rotulo({ ...novo, numero_impresso: null }))).encontrado).toBe(false);
    const tela = (await cliente.get(`/validar/${novo.numero_impresso}`)).text;
    expect(tela).toContain("Não foi possível confirmar");
    expect(tela).toContain("só o número do certificado");
    expect(tela).toContain("código completo do QR");
    // o número de um certificado que NÃO existe recebe a mesma orientação: a
    // tela decide pelo formato, não pelo banco
    expect(await negativa(novo.numero_impresso!)).toBe(await negativa(`CSSO-NR35-${ANO}-0777`));
  });

  it("lixo, chave nova inexistente e prefixo da chave negam igual", async () => {
    const { novo } = await _dois();
    const inexistente = `${novo.numero_impresso}-ZZZZZ`;
    const lixo = "nao-e-uma-chave";
    const a = await negativa(inexistente);
    const b = await negativa(lixo);
    const c = await negativa(novo.chave_validacao.slice(0, -1));
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toContain("Não foi possível confirmar");
    expect(a).not.toContain("só o número do certificado");
  });

  it("o limite por IP vale para a chave nova", async () => {
    const { novo } = await _dois();
    for (let i = 0; i < validacao.LIMITE_CURTO; i++) await cliente.get(`/validar/${novo.chave_validacao}`);
    const excedeu = await cliente.get(`/validar/${novo.chave_validacao}`);
    expect(excedeu.status).toBe(429);
  });
});

describe("chave nova não se confunde com CPF (22/10/2026)", () => {
  it("parece_cpf não dispara para número ou chave com 11 algarismos", async () => {
    const { parece_cpf } = await import("../src/servicos/textos.js");
    expect(parece_cpf("SISA-NR35-2026-0002-5CWBY")).toBe(false);
    expect(parece_cpf("CSSO-NR352-2026-0001")).toBe(false);
    expect(parece_cpf("123.456.789-01")).toBe(true);
    expect(parece_cpf("12345678901")).toBe(true);
  });
});
