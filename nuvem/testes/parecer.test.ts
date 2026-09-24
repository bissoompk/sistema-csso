/**
 * Regras do parecer técnico no SERVIÇO: setor emissor, recomendação, RN-01 a
 * RN-08, RN-11, RN-13 a RN-15, RN-22, CA-07, CA-09 a CA-11, CA-16, CA-19, e a
 * metade do §7 de EPI que mora no parecer (a trava "EPI não cessa
 * periculosidade" e a prova congelada).
 *
 * Porte de `test_parecer_regras.py`, `test_emissao.py`, da parte de serviço de
 * `test_epi_adicional.py` e de `test_pdf.py`/`test_concorrencia_emissao.py` no
 * que é regra (e não LibreOffice nem trava do SQLite). O ouro do documento
 * (`test_parecer_ouro.py`) está em `documento.test.ts`.
 *
 * Cada teste roda numa transação desfeita no fim (`desfeita`): é o `sessao` do
 * conftest, que morria com o teste.
 */
import { describe, expect, it } from "vitest";
import { and, asc, count, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import * as servico from "../src/servicos/parecer.js";
import type { ParecerCompleto } from "../src/servicos/parecer.js";
import * as documento from "../src/servicos/documento.js";
import * as numeracao from "../src/servicos/numeracao.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { obterArmazenamento } from "../src/servicos/armazenamento.js";
import { normalizar_fluxo } from "../src/servicos/textos.js";
import { mover } from "../src/servicos/processo.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo } from "./ajuda";
import { atores, cenario, desfeita, erroNoSavepoint, parecerDe, type Atores, type Cenario } from "./ajuda_processos";

const { db } = await bancoLimpo();

const SEM = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["parecer.ver"], perfis: [] });

/** O `sessao` + `atores` + `cenario` do conftest, numa transação desfeita. */
function comCenario(f: (tx: Executor, a: Atores, c: Cenario, p: ParecerCompleto) => Promise<void>) {
  return desfeita(db, async (tx) => {
    const a = await atores(tx);
    const c = await cenario(tx);
    await f(tx, a, c, await parecerDe(tx, c.parecer_id));
  });
}

async function pegar<T>(q: Promise<T[]>): Promise<T> {
  const [l] = await q;
  if (!l) throw new Error("ausente");
  return l;
}

async function textoDoDocx(chave: string): Promise<string> {
  return normalizar_fluxo(documento.extrair_texto(await obterArmazenamento().ler(chave)));
}

async function eventos(tx: Executor, tipo: string) {
  return tx.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

/** O texto que o erro do PostgreSQL carrega (o Drizzle embrulha na `cause`). */
function mensagem(erro: Error | null): string {
  if (!erro) return "";
  const causa = (erro as { cause?: Error }).cause;
  return `${erro.message} ${causa ? causa.message : ""}`;
}

// =====================================================================
// test_parecer_regras.py
// =====================================================================
describe("setor emissor e recomendação", () => {
  it("setor emissor vigente por data", async () => {
    const antigo = await servico.setor_emissor_vigente(db, "2025-02-11");
    const intermediario = await servico.setor_emissor_vigente(db, "2026-02-11");
    const novo = await servico.setor_emissor_vigente(db, "2026-07-01");
    expect(antigo!.sigla_composta).toBe("SEST/DASA/PROGEP");
    expect(antigo!.nome_extenso).toBe("Serviço Especializado em Segurança do Trabalho");
    // mesma sigla, cabeçalho diferente em 2026
    expect(intermediario!.sigla_composta).toBe("SEST/DASA/PROGEP");
    expect(intermediario!.nome_extenso).toBe("Seção de Segurança do Trabalho");
    expect(novo!.sigla_composta).toBe("CSSO/Sisa");
  });

  it("a cidade é a do setor emissor, não a do campus avaliado", async () => {
    for (const setor of await db.select().from(e.setor_emissor)) expect(setor.cidade).toBe("Diamantina");
  });

  it("parecer de 18/06/2026 ainda sai com a sigla antiga", async () => {
    expect((await servico.setor_emissor_vigente(db, "2026-06-18"))!.sigla_composta).toBe("SEST/DASA/PROGEP");
  });

  it("sem setor vigente devolve null", async () => {
    await desfeita(db, async (tx) => {
      const setores = await tx.select().from(e.setor_emissor).orderBy(asc(e.setor_emissor.id));
      for (const [i, s] of setores.entries()) {
        await tx
          .update(e.setor_emissor)
          .set({ vigencia_inicio: `2030-01-${String(1 + i).padStart(2, "0")}`, vigencia_fim: null })
          .where(eq(e.setor_emissor.id, s.id));
      }
      expect(await servico.setor_emissor_vigente(tx, "2026-01-01")).toBeNull();
    });
  });

  it.each([
    ["RECONHECER_DIREITO_PORTARIA_V1", "a partir da data da Portaria de Localização: 17 de Setembro de 2024"],
    ["RECONHECER_DIREITO_PORTARIA_V2", "a partir da portaria de localização 17 de setembro de 2024"],
    ["RECONHECER_DIREITO_SOLICITACAO", "a partir da data da solicitação 17/09/2024"],
  ])("três variantes de recomendação: %s", async (codigo, esperado) => {
    const modelo = await pegar(
      db
        .select()
        .from(e.texto_padrao)
        .where(and(eq(e.texto_padrao.categoria, "RECOMENDACAO"), eq(e.texto_padrao.codigo, codigo))),
    );
    const texto = servico.montar_recomendacao(
      codigo,
      "adicional de insalubridade",
      "Agente Biológico",
      "2024-09-17",
      modelo.template,
    );
    expect(
      texto.startsWith(
        "Reconhecer o direito ao adicional de insalubridade caracterizado pela exposição ao Agente Biológico",
      ),
    ).toBe(true);
    expect(texto.endsWith(esperado)).toBe(true);
  });
});

describe("RN-22 radiológicos, RN-13, permissões", () => {
  const rad = (codigo: string | null, extra: Record<string, unknown> = {}) =>
    ({
      tipo_adicional: codigo ? { codigo } : null,
      horas_semanais_fonte: null,
      portaria_designacao_dirigente_id: null,
      area_radiologica: null,
      ...extra,
    }) as unknown as ParecerCompleto;

  it("raios X exige os três requisitos", () => {
    const bloqueios = servico._validar_radiologico(rad("RAIOS_X"));
    expect(bloqueios.some((b) => b.includes("12 horas semanais"))).toBe(true);
    expect(bloqueios.some((b) => b.includes("designação do dirigente"))).toBe(true);
    expect(bloqueios.some((b) => b.includes("CONTROLADA"))).toBe(true);
    expect(
      servico._validar_radiologico(
        rad("RAIOS_X", { horas_semanais_fonte: "20", portaria_designacao_dirigente_id: 1, area_radiologica: "CONTROLADA" }),
      ),
    ).toEqual([]);
  });

  it("irradiação exige área", () => {
    expect(servico._validar_radiologico(rad("IRRADIACAO_IONIZANTE")).some((b) => b.includes("CNEN"))).toBe(true);
    expect(servico._validar_radiologico(rad("IRRADIACAO_IONIZANTE", { area_radiologica: "SUPERVISIONADA" }))).toEqual([]);
  });

  it("insalubridade não dispara a regra radiológica; sem tipo também não", () => {
    expect(servico._validar_radiologico(rad("INSALUBRIDADE"))).toEqual([]);
    expect(servico._validar_radiologico(rad(null))).toEqual([]);
  });

  it("RN-13: revisão exige o parecer anterior", async () => {
    await desfeita(db, async (tx) => {
      const revisao = await pegar(tx.select().from(e.tipo_movimento).where(eq(e.tipo_movimento.codigo, "REVISAO")));
      const [p] = await tx
        .insert(e.parecer_tecnico)
        .values({ numero: 0, ano: 2026, situacao: "RASCUNHO", tipo_movimento_id: revisao.id })
        .returning();
      const validacao = await servico.validar(tx, await parecerDe(tx, p!.id));
      expect(validacao.bloqueios.some((b) => b.includes("parecer anterior"))).toBe(true);
    });
  });

  it("emitir, anular e superar laudo exigem permissão", async () => {
    await desfeita(db, async (tx) => {
      const [p] = await tx.insert(e.parecer_tecnico).values({ numero: 0, ano: 2026, situacao: "RASCUNHO" }).returning();
      const parecer = await parecerDe(tx, p!.id);
      await expect(servico.emitir(tx, parecer, SEM)).rejects.toBeInstanceOf(PermissaoNegada);
      await expect(servico.anular(tx, parecer, SEM, "motivo qualquer")).rejects.toBeInstanceOf(PermissaoNegada);
      const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
      const insal = await pegar(tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE")));
      const [laudo] = await tx
        .insert(e.laudo_tecnico)
        .values({ numero_siape: "26255-000.999/2019", ano: 2019, tipo_adicional_id: insal.id, unidade_uorg_id: unidade!.id })
        .returning();
      const so_laudo = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["laudo.ver"], perfis: [] });
      await expect(servico.marcar_laudo_superado(tx, laudo!, so_laudo, "motivo")).rejects.toBeInstanceOf(PermissaoNegada);
    });
  });

  it("exposição principal sem exposição é null; classificação sem horas fica nula", () => {
    expect(servico.exposicao_principal({ exposicoes: [] })).toBeNull();
    expect(servico.classificar_exposicao(null, 160)).toEqual([null, null]);
    expect(servico.classificar_exposicao(160, null)).toEqual([null, null]);
    expect(servico.classificar_exposicao(0, 160)).toEqual([null, null]);
  });
});

// =====================================================================
// test_emissao.py
// =====================================================================
describe("emissão ponta a ponta", () => {
  it("reproduz o parecer 1/2025", () =>
    comCenario(async (tx, a, _c, p) => {
      const resultado = await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      expect(p.situacao).toBe("EMITIDO");
      expect(p.numero).toBeGreaterThanOrEqual(1);
      expect(p.sigla_emissora_snapshot).toBe("SEST/DASA/PROGEP");
      const texto = await textoDoDocx(resultado.docx);
      expect(texto).toContain("Marco Antônio Alves Schetino");
      expect(texto).toContain("250 - Faculdade De Medicina De Diamantina");
      expect(texto).toContain("Diamantina, 11 de fevereiro de 2025");
      expect(texto).toContain("Nº 26255-000.125/2019");
      expect(texto).toContain("Médio (10%)");
      // e o que foi gravado é o que ficou na memória
      const gravado = await parecerDe(tx, p.id);
      expect(gravado.situacao).toBe("EMITIDO");
      expect(gravado.hash_conteudo).toHaveLength(64);
      expect(gravado.contexto_congelado).toBeTruthy();
    }));

  it("CA-11: acentuação ponta a ponta; o nome do arquivo sai sem acento", () =>
    comCenario(async (tx, a, _c, p) => {
      const resultado = await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      expect(await textoDoDocx(resultado.docx)).toContain("Marco Antônio Alves Schetino");
      const nome = resultado.docx.split("/").pop()!;
      expect(nome).toContain("Antonio");
      expect(nome).not.toContain("Antônio");
    }));

  it("CA-10: a técnica emite, mas não assina — 403 e ASSINATURA_NEGADA", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.TECNICA, { gerar_pdf: false });
      await expect(servico.assinar(tx, p, a.TECNICA)).rejects.toBeInstanceOf(PermissaoNegada);
      expect(p.situacao).toBe("EMITIDO");
      expect((await eventos(tx, "ASSINATURA_NEGADA")).length).toBeGreaterThan(0);
    }));

  it("CA-10 espelho: a técnica move o kanban", () =>
    comCenario(async (tx, a, c) => {
      const [processo] = await tx.select().from(e.processo).where(eq(e.processo.id, c.processo_id));
      await mover(tx, processo!, "PARECER_PRONTO_P_ASSINATURA", a.TECNICA);
      expect(processo!.estado_tecnico).toBe("PARECER_PRONTO_P_ASSINATURA");
    }));

  it("RN-04 lista o que falta", () =>
    comCenario(async (tx, _a, _c, p) => {
      p.portaria_id = null;
      p.texto_recomendacao = null;
      const v = await servico.validar(tx, p);
      expect(v.ok).toBe(false);
      expect(v.faltantes).toContain("portaria de localização");
      expect(v.faltantes).toContain("recomendação");
    }));

  it("RN-05: marco diverge da portaria", () =>
    comCenario(async (tx, _a, _c, p) => {
      p.data_marco_inicial = "2024-09-18";
      const v = await servico.validar(tx, p);
      expect(v.bloqueios.some((b) => b.includes("diverge da data de publicação"))).toBe(true);
    }));

  it("RN-05: marco anterior ao laudo bloqueia", () =>
    comCenario(async (tx, _a, _c, p) => {
      p.laudo!.data_emissao = "2025-01-01";
      const v = await servico.validar(tx, p);
      expect(v.bloqueios.some((b) => b.includes("não há laudo que caracterize"))).toBe(true);
    }));

  it("RN-05: prescrição é aviso, não bloqueio", () =>
    comCenario(async (tx, _a, _c, p) => {
      p.portaria!.data_publicacao = "2019-07-01";
      p.portaria!.ano = 2019;
      p.data_marco_inicial = "2019-07-01";
      const v = await servico.validar(tx, p);
      expect(v.ok).toBe(true);
      expect(v.avisos.some((x) => x.includes("prescrição quinquenal"))).toBe(true);
    }));

  it("RN-06: agente químico exige reavaliação", () =>
    comCenario(async (tx, _a, c, p) => {
      const quimico = await pegar(
        tx.select().from(e.agente_nocivo).where(eq(e.agente_nocivo.descricao, "Manipulação de produtos químicos")),
      );
      await tx
        .update(e.exposicao)
        .set({ agente_nocivo_id: quimico.id, fundamentacao_id: quimico.fundamentacao_id! })
        .where(eq(e.exposicao.id, p.exposicoes[0]!.id));
      const v = await servico.validar(tx, await parecerDe(tx, c.parecer_id));
      expect(v.bloqueios.some((b) => b.includes("avaliação quantitativa"))).toBe(true);
    }));

  it("CA-19: eventual sem exceção bloqueia", () =>
    comCenario(async (tx, _a, _c, p) => {
      const exposicao = p.exposicoes[0]!;
      exposicao.horas_exposicao_mensais = "40";
      exposicao.jornada_mensal_horas = "160";
      servico.aplicar_classificacao(exposicao);
      expect(exposicao.classificacao_exposicao).toBe("EVENTUAL");
      const v = await servico.validar(tx, p);
      expect(v.bloqueios.some((b) => b.includes("art. 9º"))).toBe(true);
    }));

  it("CA-19: eventual com exceção emite e registra EXCECAO_ART9_APLICADA", () =>
    comCenario(async (tx, a, c, p) => {
      const x = {
        horas_exposicao_mensais: "40" as string | number | null,
        jornada_mensal_horas: "160" as string | number | null,
        percentual_jornada: null as string | number | null,
        classificacao_exposicao: null as string | null,
        classificacao_origem: "CALCULADA",
      };
      servico.aplicar_classificacao(x);
      await tx
        .update(e.exposicao)
        .set({
          horas_exposicao_mensais: "40",
          jornada_mensal_horas: "160",
          percentual_jornada: String(x.percentual_jornada),
          classificacao_exposicao: x.classificacao_exposicao,
          classificacao_origem: x.classificacao_origem,
          excecao_art9_par_unico: true,
          justificativa_art9: "Anexo 14 da NR-15 dispensa habitualidade neste caso.",
        })
        .where(eq(e.exposicao.id, p.exposicoes[0]!.id));
      const recarregado = await parecerDe(tx, c.parecer_id);
      await servico.emitir(tx, recarregado, a.COORDENADOR, { gerar_pdf: false });
      expect(recarregado.situacao).toBe("EMITIDO");
      expect((await eventos(tx, "EXCECAO_ART9_APLICADA")).length).toBeGreaterThan(0);
    }));

  it("classificação é calculada", () => {
    expect(servico.classificar_exposicao(160, 160)).toEqual([100, "PERMANENTE"]);
    expect(servico.classificar_exposicao(80, 160)).toEqual([50, "HABITUAL"]);
    expect(servico.classificar_exposicao(40, 160)).toEqual([25, "EVENTUAL"]);
  });

  it("RN-08: percentual de outro adicional bloqueia", () =>
    comCenario(async (tx, _a, c, p) => {
      const peric = await pegar(tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "PERICULOSIDADE")));
      const outro = await pegar(
        tx
          .select()
          .from(e.percentual_aplicavel)
          .where(and(eq(e.percentual_aplicavel.tipo_adicional_id, peric.id), eq(e.percentual_aplicavel.grau, "UNICO"))),
      );
      await tx.update(e.exposicao).set({ percentual_id: outro.id }).where(eq(e.exposicao.id, p.exposicoes[0]!.id));
      const v = await servico.validar(tx, await parecerDe(tx, c.parecer_id));
      expect(v.bloqueios.some((b) => b.includes("outro tipo de adicional"))).toBe(true);
    }));

  it("CA-09: domínio legal dos percentuais", async () => {
    const esperado: Record<string, [string, number][]> = {
      INSALUBRIDADE: [["MINIMO", 5], ["MEDIO", 10], ["MAXIMO", 20]],
      IRRADIACAO_IONIZANTE: [["MINIMO", 5], ["MEDIO", 10], ["MAXIMO", 20]],
      PERICULOSIDADE: [["UNICO", 10]],
      RAIOS_X: [["UNICO", 10]],
    };
    for (const [codigo, pares] of Object.entries(esperado)) {
      const adicional = await pegar(db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, codigo)));
      const reais = await db
        .select()
        .from(e.percentual_aplicavel)
        .where(eq(e.percentual_aplicavel.tipo_adicional_id, adicional.id));
      expect(new Set(reais.map((p) => `${p.grau}:${Math.trunc(Number(p.valor))}`)), codigo).toEqual(
        new Set(pares.map(([g, v]) => `${g}:${v}`)),
      );
      for (const p of reais) expect(p.base_calculo).toBe("vencimento do cargo efetivo");
    }
    // a escala celetista 10/20/40 não existe em lugar nenhum
    for (const p of await db.select().from(e.percentual_aplicavel)) {
      expect([5, 10, 20]).toContain(Math.trunc(Number(p.valor)));
    }
  });

  it("RN-14: parecer emitido é imutável", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      await expect(servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false })).rejects.toBeInstanceOf(
        servico.EmissaoBloqueada,
      );
    }));

  it("anulação exige motivo", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      await expect(servico.anular(tx, p, a.COORDENADOR, "  ")).rejects.toBeInstanceOf(servico.AnulacaoSemMotivo);
      await servico.anular(tx, p, a.COORDENADOR, "erro material no percentual");
      expect(p.situacao).toBe("ANULADO");
      expect(p.motivo_anulacao).toBeTruthy();
      expect((await parecerDe(tx, p.id)).situacao).toBe("ANULADO");
    }));

  it("RN-11: cascata de reavaliação", () =>
    comCenario(async (tx, a, c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      const [vigencia] = await tx
        .insert(e.adicional_vigencia)
        .values({
          servidor_id: p.servidor_id!,
          parecer_id: p.id,
          tipo_adicional_id: p.tipo_adicional_id!,
          percentual_id: p.exposicoes[0]!.percentual_id,
          estado: "VIGENTE",
        })
        .returning();
      const [laudo] = await tx.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
      await servico.marcar_laudo_superado(tx, laudo!, a.COORDENADOR, "mudança no processo de trabalho");
      const [depois] = await tx.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.id, vigencia!.id));
      expect(depois!.estado).toBe("EM_REAVALIACAO");
      expect(laudo!.status).toBe("SUPERADO");
      const [gravado] = await tx.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
      expect(gravado!.status).toBe("SUPERADO");
      const pend = await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "REAVALIACAO_LAUDO"));
      expect(pend.some((x) => x.laudo_id === c.laudo_id && x.parecer_id === p.id)).toBe(true);
    }));

  it("RN-09: um único adicional vigente (o índice do banco)", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      const comum = {
        servidor_id: p.servidor_id!,
        parecer_id: p.id,
        tipo_adicional_id: p.tipo_adicional_id!,
        percentual_id: p.exposicoes[0]!.percentual_id,
        estado: "VIGENTE",
      };
      await tx.insert(e.adicional_vigencia).values(comum);
      const erro = await erroNoSavepoint(tx, (sp) => sp.insert(e.adicional_vigencia).values(comum));
      expect(mensagem(erro)).toContain("uq_adicional_vigente");
    }));

  it("CA-16: o banco recusa signatário sem habilitação", () =>
    comCenario(async (tx, _a, c) => {
      const [fatima] = await tx
        .insert(e.profissional_habilitado)
        .values({
          nome: "Fátima (registro indevido)",
          habilitacao: "ENG_SEG_TRABALHO",
          titulo_assinatura: "Téc. Seg. do Trabalho",
          vigencia_inicio: "2030-01-01", // ainda não vigente em 2025
        })
        .returning();
      const erro = await erroNoSavepoint(tx, (sp) =>
        sp
          .update(e.parecer_tecnico)
          .set({ signatario_id: fatima!.id, situacao: "EMITIDO" })
          .where(eq(e.parecer_tecnico.id, c.parecer_id)),
      );
      expect(mensagem(erro)).toContain("art.10");
    }));

  it("CA-16: histórico é append-only; a cadeia fecha", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      const [evento] = await tx.select({ id: e.historico_evento.id }).from(e.historico_evento).limit(1);
      const upd = await erroNoSavepoint(tx, (sp) =>
        sp.execute(sql`UPDATE historico_evento SET descricao='adulterado' WHERE id=${evento!.id}`),
      );
      expect(mensagem(upd)).toContain("append-only");
      const del = await erroNoSavepoint(tx, (sp) => sp.execute(sql`DELETE FROM historico_evento WHERE id=${evento!.id}`));
      expect(mensagem(del)).toContain("append-only");
      const [ok, defeito] = await auditoria.cadeia_integra(tx);
      expect(ok, `cadeia rompida em ${defeito}`).toBe(true);
    }));

  it("sem LibreOffice a degradação continua muda: sai o .docx com o aviso, sem PDF_NAO_GERADO", () =>
    comCenario(async (tx, a, _c, p) => {
      const resultado = await servico.emitir(tx, p, a.COORDENADOR);
      expect(resultado.pdf).toBeNull();
      expect(resultado.aviso_pdf ?? "").toContain("PDF indisponível");
      expect(p.situacao).toBe("EMITIDO");
      expect(await eventos(tx, auditoria.PDF_NAO_GERADO)).toEqual([]);
    }));

  it("a emissão abre a pendência de incluir no SEI e congela o contexto", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      const [pend] = await tx.select().from(e.pendencia).where(eq(e.pendencia.chave, `sei:parecer:${p.id}`));
      expect(pend!.tipo).toBe("INCLUIR_NO_SEI");
      const gravado = await parecerDe(tx, p.id);
      // RN-15: renomear o agente no catálogo não muda o que já saiu
      await tx
        .update(e.agente_nocivo)
        .set({ descricao: "Nome novo no catálogo" })
        .where(eq(e.agente_nocivo.id, gravado.exposicoes[0]!.agente_nocivo_id));
      const contexto = await servico.montar_contexto(tx, await parecerDe(tx, p.id));
      expect(contexto.agentes_nocivos).toEqual(["Contato permanente com material infecto-contagiante"]);
    }));
});

describe("numeração (CA-07; o que é regra em test_concorrencia_emissao)", () => {
  it("50 números distintos e contíguos, sem colidir com RESERVADO", () =>
    desfeita(db, async (tx) => {
      await tx.insert(e.parecer_tecnico).values([
        { numero: 7, ano: 2026, situacao: "RESERVADO" },
        { numero: 9, ano: 2026, situacao: "RESERVADO" },
      ]);
      await numeracao.recontar_sequencia(tx);
      const numeros: number[] = [];
      for (let i = 0; i < 50; i++) numeros.push(await numeracao.proximo_numero_parecer(tx, 2026));
      expect(new Set(numeros).size).toBe(50);
      expect(numeros).not.toContain(7);
      expect(numeros).not.toContain(9);
      const menor = Math.min(...numeros);
      expect([...numeros].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => menor + i));
    }));

  it("número único por ano", () =>
    desfeita(db, async (tx) => {
      await tx.insert(e.parecer_tecnico).values({ numero: 1, ano: 2026, situacao: "RASCUNHO" });
      const erro = await erroNoSavepoint(tx, (sp) =>
        sp.insert(e.parecer_tecnico).values({ numero: 1, ano: 2026, situacao: "RASCUNHO" }),
      );
      expect(mensagem(erro)).toContain("uq_parecer");
    }));

  it("lacunas de numeração", () =>
    desfeita(db, async (tx) => {
      for (const numero of [1, 2, 5]) await tx.insert(e.parecer_tecnico).values({ numero, ano: 2026, situacao: "RASCUNHO" });
      await numeracao.recontar_sequencia(tx);
      expect(await numeracao.lacunas_de_numeracao(tx, 2026)).toEqual([3, 4]);
    }));

  it("emissão recusada não consome número", () =>
    comCenario(async (tx, a, c, p) => {
      p.texto_recomendacao = null;
      await tx.update(e.parecer_tecnico).set({ texto_recomendacao: null }).where(eq(e.parecer_tecnico.id, c.parecer_id));
      const [antes] = await tx.select().from(e.parecer_sequencia).where(eq(e.parecer_sequencia.ano, 2025));
      await expect(servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false })).rejects.toBeInstanceOf(
        servico.EmissaoBloqueada,
      );
      const [depois] = await tx.select().from(e.parecer_sequencia).where(eq(e.parecer_sequencia.ano, 2025));
      expect(depois?.ultimo_numero ?? 0).toBe(antes?.ultimo_numero ?? 0);
      const gravado = await parecerDe(tx, c.parecer_id);
      expect(gravado.numero).toBe(0);
      expect(gravado.situacao).toBe("RASCUNHO");
    }));
});

// =====================================================================
// §7 do desenho de EPI — a metade do parecer (test_epi_adicional.py)
// =====================================================================
const ENTREGA = "2024-10-01";
const AVALIACAO = "2025-02-11";
const CA_VENCE_DEPOIS = "2030-01-01";

async function habilitar_coordenador(tx: Executor, a: Atores) {
  await tx
    .update(e.profissional_habilitado)
    .set({ usuario_id: a.coord_id })
    .where(eq(e.profissional_habilitado.nome, "Fabrício Raimundi Andrade"));
}

/** O mesmo servidor, outro parecer — e outro adicional (periculosidade). */
async function parecer_de_periculosidade(tx: Executor, c: Cenario, base: ParecerCompleto) {
  const peric = await pegar(tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "PERICULOSIDADE")));
  const unico = await pegar(
    tx.select().from(e.percentual_aplicavel).where(eq(e.percentual_aplicavel.tipo_adicional_id, peric.id)).limit(1),
  );
  const agente = await pegar(tx.select().from(e.agente_nocivo).orderBy(asc(e.agente_nocivo.id)).limit(1));
  const [p] = await tx
    .insert(e.parecer_tecnico)
    .values({
      // `uq_parecer` é (numero, ano) e o parecer do cenário já ocupa o 0/2025
      numero: 99,
      ano: 2025,
      situacao: "RASCUNHO",
      processo_id: c.processo_id,
      servidor_id: c.servidor_id,
      laudo_id: c.laudo_id,
      tipo_adicional_id: peric.id,
      unidade_uorg_id: base.unidade_uorg_id,
    })
    .returning();
  await tx.insert(e.exposicao).values({
    parecer_id: p!.id,
    agente_nocivo_id: agente.id,
    percentual_id: unico.id,
    fundamentacao_id: agente.fundamentacao_id!,
    principal: true,
  });
  const parecer = await parecerDe(tx, p!.id);
  return { parecer, exposicao: parecer.exposicoes[0]! };
}

async function lote(tx: Executor, validade_ca: string) {
  const categoria = await pegar(
    tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES")),
  );
  const [item] = await tx
    .insert(e.epi_item)
    .values({
      nome: "Luva de proteção química nitrílica",
      categoria_id: categoria.id,
      fabricante: "Fabricante Exemplo Ltda",
      exige_ca: true,
      numero_ca: "41234",
      validade_ca,
      unidade_medida: "PAR",
      vida_util_meses: 6,
    })
    .returning();
  const [entrada] = await tx
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item!.id,
      tamanho: "M",
      data_entrada: datas_br.somar_dias(ENTREGA, -30),
      quantidade_recebida: 20,
      lote: "L-2024-09",
      numero_ca: "41234",
      validade_ca,
    })
    .returning();
  await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 20 });
  return { item: item!, entrada: entrada! };
}

async function entregar(tx: Executor, a: Atores, c: Cenario, l: Awaited<ReturnType<typeof lote>>, quando = ENTREGA) {
  const almoxarife = new UsuarioAtual({
    id: a.fatima_id,
    login: "fatima",
    nome: "Fátima",
    permissoes: ["epi.ver", "epi.entregar", "epi.estoque", "epi.ficha"],
    perfis: ["almoxarife_sesmt"],
  });
  const [servidor] = await tx.select().from(e.servidor).where(eq(e.servidor.id, c.servidor_id));
  return epi_ficha.registrar_entrega(tx, almoxarife, {
    servidor: servidor!,
    item: l.item,
    quantidade: 2,
    entrada: l.entrada,
    tamanho: "M",
    data_evento: quando,
  });
}

describe("§7.1 — EPI neutraliza insalubridade; EPI não cessa periculosidade", () => {
  it("EPI não cessa periculosidade — e nada é gravado", () =>
    comCenario(async (tx, a, c, p) => {
      await habilitar_coordenador(tx, a);
      const { parecer, exposicao } = await parecer_de_periculosidade(tx, c, p);
      const erro = await servico
        .registrar_avaliacao_de_epi(tx, parecer, exposicao, a.COORDENADOR, {
          valor: "NEUTRALIZA",
          justificativa: "luva isolante classe 2 com CA vigente",
        })
        .catch((x: Error) => x);
      expect(erro).toBeInstanceOf(servico.AvaliacaoDeEpiRecusada);
      expect((erro as Error).message).toContain("não cessa periculosidade");
      const [gravada] = await tx.select().from(e.exposicao).where(eq(e.exposicao.id, exposicao.id));
      expect(gravada!.epi_neutraliza).toBe("NAO_AVALIADO");
      expect(gravada!.justificativa_epi).toBeNull();
      expect(gravada!.epi_avaliado_em).toBeNull();
    }));

  it("periculosidade ainda aceita dizer que não neutraliza", () =>
    comCenario(async (tx, a, c, p) => {
      await habilitar_coordenador(tx, a);
      const { parecer, exposicao } = await parecer_de_periculosidade(tx, c, p);
      await servico.registrar_avaliacao_de_epi(tx, parecer, exposicao, a.COORDENADOR, { valor: "NAO_NEUTRALIZA" });
      expect(exposicao.epi_neutraliza).toBe("NAO_NEUTRALIZA");
      expect(exposicao.epi_avaliado_em).toBe(datas_br.hoje());
    }));

  it("EPI neutraliza insalubridade (o outro sentido)", () =>
    comCenario(async (tx, a, _c, p) => {
      await habilitar_coordenador(tx, a);
      const exposicao = p.exposicoes[0]!;
      expect(p.tipo_adicional!.codigo).toBe("INSALUBRIDADE");
      await servico.registrar_avaliacao_de_epi(tx, p, exposicao, a.COORDENADOR, {
        valor: "NEUTRALIZA_PARCIAL",
        justificativa: "respirador semifacial com filtro P3, CA vigente na data da avaliação",
        quando: AVALIACAO,
      });
      const [gravada] = await tx.select().from(e.exposicao).where(eq(e.exposicao.id, exposicao.id));
      expect(gravada!.epi_neutraliza).toBe("NEUTRALIZA_PARCIAL");
      expect(gravada!.epi_avaliado_em).toBe(AVALIACAO);
      expect(gravada!.justificativa_epi).toContain("filtro P3");
      expect((await eventos(tx, servico.EPI_NEUTRALIZACAO_AVALIADA)).length).toBe(1);
    }));

  it("os radiológicos não são neutralizáveis (lista branca)", () => {
    expect([...servico.CODIGOS_NEUTRALIZAVEIS_POR_EPI]).toEqual(["INSALUBRIDADE"]);
    for (const codigo of ["PERICULOSIDADE", "IRRADIACAO_IONIZANTE", "RAIOS_X"]) {
      expect(servico.CODIGOS_NEUTRALIZAVEIS_POR_EPI.has(codigo)).toBe(false);
    }
  });

  it("alegar neutralização exige habilitação vigente (RN-01)", () =>
    comCenario(async (tx, a, _c, p) => {
      await expect(
        servico.registrar_avaliacao_de_epi(tx, p, p.exposicoes[0]!, a.COORDENADOR, {
          valor: "NEUTRALIZA",
          justificativa: "máscara PFF2",
        }),
      ).rejects.toBeInstanceOf(servico.AvaliacaoDeEpiRecusada);
      expect(p.exposicoes[0]!.epi_neutraliza).toBe("NAO_AVALIADO");
    }));

  it("neutralizar sem justificativa é recusado", () =>
    comCenario(async (tx, a, _c, p) => {
      await habilitar_coordenador(tx, a);
      const erro = await servico
        .registrar_avaliacao_de_epi(tx, p, p.exposicoes[0]!, a.COORDENADOR, { valor: "NEUTRALIZA", justificativa: "   " })
        .catch((x: Error) => x);
      expect(erro).toBeInstanceOf(servico.AvaliacaoDeEpiRecusada);
      expect((erro as Error).message).toContain("justificativa");
    }));

  it("as CHECKs do §7.2 cobram no banco: o porquê e o domínio", () =>
    comCenario(async (tx, _a, _c, p) => {
      const id = p.exposicoes[0]!.id;
      const sem_porque = await erroNoSavepoint(tx, (sp) =>
        sp.update(e.exposicao).set({ epi_neutraliza: "NEUTRALIZA", justificativa_epi: null }).where(eq(e.exposicao.id, id)),
      );
      expect(mensagem(sem_porque)).toContain("ck_exposicao_epi_justificada");
      const fora = await erroNoSavepoint(tx, (sp) =>
        sp.update(e.exposicao).set({ epi_neutraliza: "TALVEZ" }).where(eq(e.exposicao.id, id)),
      );
      expect(mensagem(fora)).toContain("ck_exposicao_epi");
    }));
});

describe("§7.2 — a prova congelada na emissão", () => {
  it("entrega depois da emissão não reescreve o congelado", () =>
    comCenario(async (tx, a, c, p) => {
      const l = await lote(tx, CA_VENCE_DEPOIS);
      await entregar(tx, a, c, l);
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      const congelado = (p.contexto_congelado as Record<string, any>).epi;
      expect(congelado.referencia).toBe(AVALIACAO);
      expect(congelado.fichas).toHaveLength(1);
      expect(congelado.fichas[0].ca).toBe("41234");
      expect(congelado.fichas[0].entregue_em).toBe(ENTREGA);
      expect(congelado.exposicoes[0].epi_neutraliza).toBe("NAO_AVALIADO");

      // a entrega nova é fato posterior — e não toca o documento
      const hoje = datas_br.hoje();
      await entregar(tx, a, c, l, hoje);
      const gravado = await parecerDe(tx, p.id);
      expect((gravado.contexto_congelado as Record<string, any>).epi).toEqual(congelado);
      // e a leitura de hoje enxerga as duas: o congelado não é a ficha, é a prova
      expect(await epi_ficha.entregas_ate(tx, c.servidor_id, hoje)).toHaveLength(2);
    }));

  it("a chave epi não muda o texto do documento", () =>
    comCenario(async (tx, a, _c, p) => {
      await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      expect(p.contexto_congelado).toHaveProperty("epi");
      const contexto = await servico.montar_contexto(tx, await parecerDe(tx, p.id));
      expect(contexto).not.toHaveProperty("epi");
      expect(contexto.como_dicionario()).not.toHaveProperty("epi");
    }));
});

void count;
