/**
 * Fatia 4 de Certificados e Treinamentos: a emissão congelada.
 * Porte de `testes/integracao/test_certificados.py` (e do que ainda faz
 * sentido de `test_concorrencia_emissao.py`).
 *
 * O critério de pronto da fatia é uma frase: **o certificado sai, e a segunda
 * via sai idêntica**. Cada teste de congelamento traz, junto, a **prova de que a
 * alteração morde**: monta o contexto a partir do catálogo de hoje e exige que o
 * texto renderizado seja DIFERENTE.
 *
 * Diferença de forma: no Python o cenário vivia numa sessão sem commit; aqui o
 * executor dos serviços é o `db` (cada comando confirma sozinho) e cada teste
 * ganha banco limpo (`bancoLimpo()` no `beforeEach`), porque vários contam os
 * certificados do banco inteiro.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-certificados-"));

import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { ALFABETO_IDENTIFICADOR, Certificado as C } from "../src/dominio/treinamento.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as servico_certificado from "../src/servicos/certificado.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as documento from "../src/servicos/documento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as servico_pdf from "../src/servicos/pdf.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import * as reciclagem from "../src/servicos/reciclagem.js";
import * as fila_emissao from "../src/servicos/fila_emissao.js";
import * as indicadores from "../src/servicos/treinamento_indicadores.js";
import { periodo_de } from "../src/rotas/treinamentos.js";
import { PermissaoNegada, type UsuarioAtual } from "../src/servicos/rbac.js";
import { normalizar_fluxo } from "../src/servicos/textos.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, designarAjudante, entrar, type Cliente } from "./ajuda.js";
import { INICIO, MAPA_SUGERIDO, OBRIGATORIOS, TODAS, _cenario, _modelo_com_tags, _usuario, type Cenario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

const menos = (...fora: string[]) => [...TODAS].filter((p) => !fora.includes(p));

function _texto(bytes: Uint8Array): string {
  return normalizar_fluxo(documento.extrair_texto(bytes));
}

async function cenario_certificado(): Promise<Cenario & { usuario: UsuarioAtual }> {
  const usuario = await _usuario(db);
  return { ...(await _cenario(db, usuario)), usuario };
}

async function _certificado(id: number) {
  return (await db.select().from(e.certificado).where(eq(e.certificado.id, id)))[0]!;
}

async function _inscricao(id: number) {
  return (await servico_turma.carregar_inscricao(db, id))!;
}

/**
 * Como o documento sairia SE não houvesse congelamento: contexto do catálogo
 * de hoje, com o mesmo número, ano, data e chave.
 */
async function _texto_do_catalogo_de_hoje(cert: servico.CertificadoRegistro, inscricao: servico_turma.InscricaoCarregada) {
  const [modelo] = await servico.modelo_da_turma(db, inscricao.turma);
  const contexto = await servico.montar_contexto_para_emitir(db, inscricao, {
    numero: cert.numero,
    ano: cert.ano,
    data_emissao: cert.data_emissao,
    chave: cert.chave_validacao,
    modelo: modelo!,
  });
  return _texto((await servico_certificado.renderizar(contexto, null)).bytes);
}

async function _tags_por_marcador(modelo_id: number) {
  const tags = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.modelo_id, modelo_id));
  return Object.fromEntries(tags.map((t) => [t.marcador, t]));
}

async function _trocar_campo(tag_id: number, campo: string) {
  await db.update(e.certificado_modelo_tag).set({ campo }).where(eq(e.certificado_modelo_tag.id, tag_id));
}

// =====================================================================
// O teste-espelho da RN-15
// =====================================================================
describe("RN-15: a segunda via sai do congelado", () => {
  it("segunda via sai idêntica com o catálogo inteiro trocado", async () => {
    const cen = await cenario_certificado();
    const { usuario } = cen;
    const emitido = await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
    let cert = emitido.certificado;
    const antes = _texto(emitido.bytes);
    expect(cert.contexto_congelado).toBeTruthy();
    expect(antes).toContain("Marco Antônio Alves Schetino");
    expect(antes).toContain("Trabalho em Altura");
    expect(antes).toContain(cert.chave_validacao);

    // ---- agora o catálogo inteiro muda embaixo do certificado ----
    await db
      .update(e.treinamento)
      .set({
        nome: "Brigada de Incêndio — OUTRO CURSO",
        carga_horaria_horas: "40",
        conteudo_programatico: "Conteúdo programático completamente trocado",
        norma_referencia: "NR-23",
        validade_meses: 60,
      })
      .where(eq(e.treinamento.id, cen.treinamento.id));
    await db.update(e.turma).set({ local: "Sala trocada depois da emissão" }).where(eq(e.turma.id, cen.turma.id));
    await db
      .update(e.assinatura_instrutor)
      .set({ nome: "Outro Instrutor Qualquer", titulo: "Título trocado" })
      .where(eq(e.assinatura_instrutor.id, cen.instrutor.id));
    // a troca mais silenciosa de todas: o mapa de tags
    const v1 = await _tags_por_marcador(cen.modelo.id);
    await _trocar_campo(v1.nome_do_aluno!.id, "assinante_nome");
    await _trocar_campo(v1.assinante!.id, "participante_nome");
    // e uma versão nova do modelo, publicada e apontada pelo catálogo
    await db.update(e.certificado_modelo).set({ vigente: false }).where(eq(e.certificado_modelo.id, cen.modelo.id));
    const nova = await _modelo_com_tags(db, cen.treinamento, { versao: 2 });
    const v2 = await _tags_por_marcador(nova.id);
    await _trocar_campo(v2.nome_do_aluno!.id, "assinante_nome");
    await _trocar_campo(v2.assinante!.id, "participante_nome");
    await db.update(e.treinamento).set({ modelo_vigente_id: nova.id }).where(eq(e.treinamento.id, cen.treinamento.id));

    // ---- reimprime ----
    cert = await _certificado(cert.id);
    const segunda = await servico.segunda_via(db, usuario, cert);
    const depois = _texto(segunda.bytes);
    expect(depois).toBe(antes);
    expect(segunda.confere).toBe(true);
    expect(segunda.hash_conteudo).toBe(cert.hash_conteudo);
    expect(depois).not.toContain("Brigada de Incêndio");
    expect(depois).not.toContain("Outro Instrutor Qualquer");
    expect(depois).not.toContain("Sala trocada");

    // ---- e a prova de que o teste não passou por acidente ----
    const como_seria = await _texto_do_catalogo_de_hoje(cert, await _inscricao(cen.inscricao.id));
    expect(como_seria).not.toBe(antes);
    expect(como_seria).toContain("Brigada de Incêndio");
  });

  it("o mapa de tags congelado é o que manda na reimpressão", async () => {
    const cen = await cenario_certificado();
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    const antes = _texto(emitido.bytes);
    const tags = await _tags_por_marcador(cen.modelo.id);
    await _trocar_campo(tags.nome_do_aluno!.id, "assinante_nome");
    await _trocar_campo(tags.assinante!.id, "participante_nome");

    const cert = await _certificado(emitido.certificado.id);
    expect(_texto((await servico.segunda_via(db, cen.usuario, cert)).bytes)).toBe(antes);

    const como_seria = await _texto_do_catalogo_de_hoje(cert, await _inscricao(cen.inscricao.id));
    expect(como_seria).not.toBe(antes);
    expect(como_seria).toContain("Certificamos que Fabrício Raimundi Andrade");
    expect(antes).toContain("Certificamos que Marco Antônio Alves Schetino");
  });

  it("contexto congelado sobrevive à ida e volta pelo banco", async () => {
    const cen = await cenario_certificado();
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    const original = servico_certificado.ContextoCertificado.descongelar(
      emitido.certificado.contexto_congelado as Record<string, unknown>,
    );
    const voltou = servico.montar_contexto(db, await _certificado(emitido.certificado.id));
    // DESVIO de tipo: decimal é texto e data é 'AAAA-MM-DD' (o Python conferia Decimal/date)
    expect(typeof voltou.carga_horaria).toBe("string");
    expect(voltou.data_emissao).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof voltou.mapa_tags).toBe("object");
    expect(voltou.congelar()).toEqual(original.congelar());
    expect(Object.keys(voltou.como_dicionario()).sort()).toEqual(Object.keys(original.como_dicionario()).sort());
    expect(new Set(Object.keys(voltou.mapa_tags))).toEqual(new Set(Object.keys(MAPA_SUGERIDO)));
    expect(voltou.tags_obrigatorias).toEqual([...OBRIGATORIOS].sort());
  });
});

// =====================================================================
// A chave de validação
// =====================================================================
describe("chave de validação", () => {
  it("tem formato, alfabeto e dígito verificador", () => {
    const chave = servico_certificado.gerar_chave(2026);
    const [prefixo, ano, bloco1, bloco2, digito] = chave.split("-");
    expect(prefixo).toBe("CSSO");
    expect(ano).toBe("2026");
    expect(bloco1!.length).toBe(5);
    expect(bloco2!.length).toBe(5);
    expect(digito!.length).toBe(1);
    expect(servico_certificado.chave_valida(chave)).toBe(true);
    const sorteados = bloco1! + bloco2! + digito!;
    for (const c of "01OILU") expect(sorteados).not.toContain(c);
  });

  it.each([10, 12, 16, 20])("um caractere trocado na posição %i é recusado pelo DV", (posicao) => {
    const chave = servico_certificado.montar_chave(2026, "K7QMX3FTB9");
    const original = chave[posicao];
    const trocado = [...ALFABETO_IDENTIFICADOR].find((c) => c !== original)!;
    const errada = chave.slice(0, posicao) + trocado + chave.slice(posicao + 1);
    expect(servico_certificado.chave_valida(chave)).toBe(true);
    expect(servico_certificado.chave_valida(errada)).toBe(false);
  });

  it("transposição de dois caracteres é recusada", () => {
    const chave = servico_certificado.montar_chave(2026, "K7QMX3FTB9");
    const trocada = servico_certificado.montar_chave(2026, "7KQMX3FTB9");
    expect(chave.at(-1)).not.toBe(trocada.at(-1));
  });

  it("normalizar chave não conserta caractere ambíguo", () => {
    expect(servico_certificado.normalizar_chave(" csso-2026-k7qmx-3ftb9-h ")).toBe("CSSO-2026-K7QMX-3FTB9-H");
    expect(servico_certificado.normalizar_chave("csso-2026-KOQMX-3FTB9-H")).toContain("O");
  });

  it("a chave gravada é válida e única", async () => {
    const cen = await cenario_certificado();
    const cert = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    expect(servico_certificado.chave_valida(cert.chave_validacao)).toBe(true);
    // 22/10/2026: a chave é o número impresso mais 5 sorteados
    expect(cert.chave_validacao.startsWith(`${cert.numero_impresso}-`)).toBe(true);
    expect(cert.numero_impresso).toMatch(new RegExp(`-${cert.ano}-\\d{4}$`));
    expect((cert.contexto_congelado as Record<string, unknown>).chave_validacao).toBe(cert.chave_validacao);
  });
});

// =====================================================================
// Recusas
// =====================================================================
async function _bloqueio(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (erro) {
    expect(erro).toBeInstanceOf(servico.EmissaoBloqueada);
    return (erro as Error).message;
  }
  throw new Error("a emissão devia ter sido bloqueada");
}

describe("recusas", () => {
  it("reprovado não recebe certificado", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario, { horas: "4" }); // 4h de 8h = 50%
    expect(dados.inscricao.situacao).toBe("REPROVADO");
    const msg = await _bloqueio(servico.emitir(db, usuario, dados.inscricao, { gerar_pdf: false }));
    expect(msg.toLowerCase()).toContain("reprovado");
    // UM motivo, com o gênero neutro: a frequência não sai duas vezes (M34)
    expect(msg).toContain("reprovado(a)");
    expect(msg.match(/frequência de 50%/g)).toHaveLength(1);
    expect(await db.select().from(e.certificado)).toHaveLength(0);
  });

  it("turma não concluída não emite", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario);
    // escrito direto: a máquina não admite reabrir turma concluída
    await db.update(e.turma).set({ situacao: "EM_ANDAMENTO", concluida_em: null }).where(eq(e.turma.id, dados.turma.id));
    await db.update(e.inscricao).set({ situacao: "PRESENTE" }).where(eq(e.inscricao.id, dados.inscricao.id));
    const msg = await _bloqueio(servico.emitir(db, usuario, await _inscricao(dados.inscricao.id), { gerar_pdf: false }));
    expect(msg).toContain("não foi concluída");
  });

  it("turma sem instrutor que assina não emite", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario);
    await db.update(e.turma_instrutor).set({ assina_certificado: false }).where(eq(e.turma_instrutor.turma_id, dados.turma.id));
    const msg = await _bloqueio(servico.emitir(db, usuario, await _inscricao(dados.inscricao.id), { gerar_pdf: false }));
    expect(msg).toContain("instrutor marcado para assinar");
  });

  it("marcador sem linha no dicionário bloqueia a emissão", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario);
    await db
      .delete(e.certificado_modelo_tag)
      .where(and(eq(e.certificado_modelo_tag.modelo_id, dados.modelo.id), eq(e.certificado_modelo_tag.marcador, "nome_do_aluno")));
    const msg = await _bloqueio(servico.emitir(db, usuario, await _inscricao(dados.inscricao.id), { gerar_pdf: false }));
    expect(msg).toContain("marcador sem linha no dicionário");
    expect(msg).toContain("nome_do_aluno");
  });

  it("campo fora do vocabulário bloqueia a emissão", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario);
    await db
      .update(e.certificado_modelo_tag)
      .set({ campo: "campo_que_nao_existe" })
      .where(and(eq(e.certificado_modelo_tag.modelo_id, dados.modelo.id), eq(e.certificado_modelo_tag.marcador, "curso")));
    const msg = await _bloqueio(servico.emitir(db, usuario, await _inscricao(dados.inscricao.id), { gerar_pdf: false }));
    expect(msg).toContain("não existe no vocabulário");
  });

  it("emitir sem permissão é negado", async () => {
    const cen = await cenario_certificado();
    const sem = await _usuario(db, menos("certificado.emitir"), "sem_emitir");
    await expect(servico.emitir(db, sem, cen.inscricao, { gerar_pdf: false })).rejects.toBeInstanceOf(PermissaoNegada);
    expect(await db.select().from(e.certificado)).toHaveLength(0);
  });

  it("segunda via sem permissão de ver é negada", async () => {
    const cen = await cenario_certificado();
    const cert = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const sem = await _usuario(db, menos("certificado.ver"), "sem_ver");
    await expect(servico.segunda_via(db, sem, cert)).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("número não é consumido quando a emissão é recusada", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario, { horas: "4" });
    await _bloqueio(servico.emitir(db, usuario, dados.inscricao, { gerar_pdf: false }));
    const ano = datas_br.partes(datas_br.hoje())[0];
    const linhas = await db.execute(sql`SELECT ultimo_numero FROM certificado_sequencia WHERE ano = ${ano}`);
    const consumido = (linhas as unknown as { ultimo_numero: number }[])[0]?.ultimo_numero ?? null;
    expect([null, 0]).toContain(consumido);
  });
});

// =====================================================================
// Anulação e reemissão
// =====================================================================
describe("anulação e reemissão", () => {
  it("anular libera a reemissão e o número não volta", async () => {
    const cen = await cenario_certificado();
    const { usuario, inscricao } = cen;
    const primeiro = (await servico.emitir(db, usuario, inscricao, { gerar_pdf: false })).certificado;
    const numero_antigo = primeiro.numero;
    const chave_antiga = primeiro.chave_validacao;

    const msg = await _bloqueio(servico.emitir(db, usuario, inscricao, { gerar_pdf: false }));
    expect(msg).toContain("já tem o certificado");

    await servico.anular(db, usuario, primeiro, "nome social");
    const segundo = (await servico.emitir(db, usuario, inscricao, { gerar_pdf: false })).certificado;

    const relido = await _certificado(primeiro.id);
    expect(relido.situacao).toBe("ANULADO");
    expect(relido.motivo_anulacao).toBe("nome social");
    expect(relido.anulado_em).not.toBeNull();
    expect(relido.chave_validacao).toBe(chave_antiga);
    expect(segundo.numero).toBe(numero_antigo + 1);
    expect(segundo.chave_validacao).not.toBe(chave_antiga);
    expect(segundo.situacao).toBe("EMITIDO");
  });

  it("anular exige motivo e não anula duas vezes", async () => {
    const cen = await cenario_certificado();
    const cert = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    await expect(servico.anular(db, cen.usuario, cert, "   ")).rejects.toThrow(/motivo/);
    expect(cert.situacao).toBe("EMITIDO");
    await servico.anular(db, cen.usuario, cert, "erro de digitação no nome");
    await expect(servico.anular(db, cen.usuario, cert, "de novo")).rejects.toThrow(/já está anulado/);
  });

  it("anular sem permissão é negado", async () => {
    const cen = await cenario_certificado();
    const cert = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const tecnico = await _usuario(db, menos("certificado.anular"), "tecnico");
    await expect(servico.anular(db, tecnico, cert, "motivo qualquer")).rejects.toBeInstanceOf(PermissaoNegada);
    expect((await _certificado(cert.id)).situacao).toBe("EMITIDO");
  });

  it("segunda via de certificado anulado continua saindo", async () => {
    const cen = await cenario_certificado();
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false });
    const antes = _texto(emitido.bytes);
    await servico.anular(db, cen.usuario, emitido.certificado, "reemissão por nome social");
    const segunda = await servico.segunda_via(db, cen.usuario, emitido.certificado);
    // o mesmo texto, com a tarja de ANULADO na frente (posta depois do hash)
    const tarja = await servico.tarja_do_anulado(db, emitido.certificado);
    expect(tarja).toMatch(/^ANULADO em \d{2}\/\d{2}\/\d{4} — /);
    expect(_texto(segunda.bytes)).toBe(`${tarja} ${antes}`);
    expect(segunda.confere).toBe(true);
    expect(segunda.hash_conteudo).toBe(emitido.certificado.hash_conteudo);
    expect(C.situacao_publica(emitido.certificado, datas_br.hoje())).toBe("ANULADO");
  });
});

// =====================================================================
// Lote
// =====================================================================
describe("lote", () => {
  it("emite todos e um item que trava não derruba os outros", async () => {
    const usuario = await _usuario(db);
    const dados = await _cenario(db, usuario, {
      extras: [
        ["2220001", "Ana Lima", "8"],
        ["3330002", "Bruno Sá", "8"],
        ["4440003", "Carla Dias", "2"], // 25% de frequência: reprovada
      ],
    });
    const [ana, bruno, carla] = dados.outras as [
      servico_turma.InscricaoCarregada,
      servico_turma.InscricaoCarregada,
      servico_turma.InscricaoCarregada,
    ];
    expect(carla.situacao).toBe("REPROVADO");

    const ja = (await servico.emitir(db, usuario, ana, { gerar_pdf: false })).certificado;

    // a folha do Bruno some, mas a coluna derivada continua dizendo 100%
    await db.delete(e.turma_presenca).where(eq(e.turma_presenca.inscricao_id, bruno.id));
    expect((await _inscricao(bruno.id)).frequencia_percentual).toBe("100.00");

    const turma = (await servico_turma.carregar_turma(db, dados.turma.id))!;
    const relatorio = await servico.emitir_lote(db, usuario, turma, { gerar_pdf: false });
    const por_id = new Map(relatorio.itens.map((i) => [i.inscricao.id, i]));

    expect(por_id.has(ja.inscricao_id)).toBe(false);
    expect(por_id.has(carla.id)).toBe(false);
    expect(por_id.get(bruno.id)!.erro).toBeTruthy();
    expect(por_id.get(bruno.id)!.ok).toBe(false);
    expect(por_id.get(dados.inscricao.id)!.ok).toBe(true);
    expect(relatorio.emitidos).toHaveLength(1);
    expect(relatorio.travados).toHaveLength(1);
    expect(relatorio.resumo).toBe("1 emitido(s), 1 travado(s)");

    const emitidos = await db.select().from(e.certificado);
    expect(emitidos).toHaveLength(2);
    expect(new Set(emitidos.map((c) => c.numero))).toEqual(new Set([1, 2]));
  });

  it("lote sem permissão é negado antes do laço", async () => {
    const cen = await cenario_certificado();
    const sem = await _usuario(db, ["treinamento.ver"], "so_le");
    await expect(servico.emitir_lote(db, sem, cen.turma, { gerar_pdf: false })).rejects.toBeInstanceOf(PermissaoNegada);
  });
});

// =====================================================================
// A guarda que a fatia 3 deixou marcada
// =====================================================================
describe("certificado válido trava a retificação", () => {
  it("retificar resultado de quem tem certificado é recusado", async () => {
    const cen = await cenario_certificado();
    const { usuario, inscricao } = cen;
    const cert = (await servico.emitir(db, usuario, inscricao, { gerar_pdf: false })).certificado;

    let erro: Error | null = null;
    try {
      await servico_presenca.lancar_presenca(db, usuario, inscricao, {
        data: INICIO,
        presente: true,
        horas: "4",
        motivo: "corrigindo a folha",
      });
    } catch (e_) {
      erro = e_ as Error;
    }
    expect(erro).toBeInstanceOf(servico_turma.RegraDaTurma);
    expect(erro!.message).toContain(C.rotulo(cert));
    expect(erro!.message).toContain("não se reescreve");

    await expect(
      servico_presenca.lancar_nota(db, usuario, inscricao, "3", { motivo: "corrigindo a nota" }),
    ).rejects.toBeInstanceOf(servico_turma.RegraDaTurma);

    const relida = await _inscricao(inscricao.id);
    expect(relida.situacao).toBe("APROVADO");
    expect(relida.frequencia_percentual).toBe("100.00");
    expect(relida.nota_final).toBeNull();
  });

  it("anulado o certificado, a retificação volta a ser possível", async () => {
    const cen = await cenario_certificado();
    const { usuario, inscricao } = cen;
    const cert = (await servico.emitir(db, usuario, inscricao, { gerar_pdf: false })).certificado;
    await servico.anular(db, usuario, cert, "presença lançada errado");
    await servico_presenca.lancar_presenca(db, usuario, inscricao, {
      data: INICIO,
      presente: true,
      horas: "4",
      motivo: "folha refeita depois da anulação",
    });
    expect(inscricao.frequencia_percentual).toBe("50.00");
    expect(inscricao.situacao).toBe("REPROVADO");
  });
});

// =====================================================================
// Trilha de auditoria
// =====================================================================
describe("trilha", () => {
  it("a emissão entra na trilha sem quebrar a cadeia", async () => {
    const cen = await cenario_certificado();
    const cert = (await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    await servico.segunda_via(db, cen.usuario, cert);
    await servico.anular(db, cen.usuario, cert, "teste da trilha");
    const tipos = (
      await db
        .select()
        .from(e.historico_evento)
        .where(and(eq(e.historico_evento.entidade, "certificado"), eq(e.historico_evento.entidade_id, cert.id)))
    ).map((x) => x.tipo_evento);
    expect(tipos).toContain(servico.CERTIFICADO_EMITIDO);
    expect(tipos).toContain(servico.CERTIFICADO_SEGUNDA_VIA);
    expect(tipos).toContain(servico.CERTIFICADO_ANULADO);
    const [ok, defeito] = await auditoria.cadeia_integra(db);
    expect(ok, `cadeia de auditoria quebrada no evento ${defeito}`).toBe(true);
  });
});

// =====================================================================
// PDF — porte de `test_concorrencia_emissao.py`
// =====================================================================
describe("PDF (test_concorrencia_emissao.py)", () => {
  it("sem LibreOffice a degradação continua muda", async () => {
    // Na nuvem não há LibreOffice (PORTE.md §8): o PDF não é gravado na emissão
    // — sai na hora, com o QR, por /certificados/{id}/pdf. Sem aviso e sem
    // PDF_NAO_GERADO.
    expect(servico_pdf.disponivel()).toBe(false);
    const cen = await cenario_certificado();
    const resultado = await servico.emitir(db, cen.usuario, cen.inscricao, { gerar_pdf: true });
    expect(resultado.pdf).toBeNull();
    expect(resultado.aviso_pdf).toBeNull();
    expect(resultado.certificado.situacao).toBe("EMITIDO");
    expect(resultado.certificado.arquivo_pdf_anexo_id).toBeNull();
    expect(Buffer.from(resultado.bytes.slice(0, 2)).toString()).toBe("PK");
    const tipos = (
      await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, resultado.certificado.id))
    ).map((x) => x.tipo_evento);
    expect(tipos).not.toContain(auditoria.PDF_NAO_GERADO);
  });

  // Os outros testes do arquivo simulam o LibreOffice (`monkeypatch` de
  // `pdf.disponivel`/`pdf.converter`) para provar que a conversão roda FORA da
  // transação da emissão e que a falha do anexo não desfaz o certificado. Na
  // nuvem não há LibreOffice nem segunda transação: o caminho não existe.
  it.skip("conversão de PDF fora da transação / falha do anexo — sem LibreOffice na nuvem (DESVIOS.md)", () => {});
});

// =====================================================================
// Pela porta da frente
// =====================================================================
async function cenario_http() {
  await contas(db);
  const montador = await _usuario(db, TODAS, "montador");
  const dados = await _cenario(db, montador, { extras: [["2220001", "Ana Lima", "8"]] });
  return { turma_id: dados.turma.id, inscricao_id: dados.inscricao.id, outra_id: dados.outras[0]!.id };
}

async function _certificados_gravados() {
  return (await db.select().from(e.certificado).orderBy(asc(e.certificado.id))).map((c) => ({
    id: c.id,
    rotulo: C.rotulo(c),
    situacao: c.situacao,
    chave: c.chave_validacao,
  }));
}

describe("rotas", () => {
  it("emitir pela aba de emissão e ver a ficha", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    const aba = await cliente.get(`/turmas/${h.turma_id}?aba=emissao`);
    expect(aba.status).toBe(200);
    expect(aba.text).toContain("Emissão dos certificados");
    expect(aba.text).toContain("apto");

    const resposta = await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.inscricao_id }, { seguir: false });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("emitido");

    const gravados = await _certificados_gravados();
    expect(gravados).toHaveLength(1);
    const ficha = await cliente.get(`/certificados/${gravados[0]!.id}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Marco Antônio Alves Schetino");
    expect(ficha.text).toContain(gravados[0]!.chave);
    expect(ficha.text.toLowerCase()).toContain("dicionário de tags congelado");
    expect(ficha.text).toContain("nome_do_aluno");
  });

  it("emissão em lote pela tela", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    const resposta = await cliente.post(`/turmas/${h.turma_id}/certificados`, {}, { seguir: false });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("2 emitido(s), 0 travado(s)");
    expect(await _certificados_gravados()).toHaveLength(2);
  });

  it("a emissão em lote diz quantos números vai consumir", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    const aba = (await cliente.get(`/turmas/${h.turma_id}?aba=emissao`)).text;
    expect(aba).toContain("Emitir 2 certificado(s)…");
    expect(aba).toContain('href="#emitir-lote"');
    expect(aba).toContain('id="emitir-lote"');
    expect(aba).toContain("consome 2 número(s) da sequência do ano");
    expect(aba).toContain("número consumido não volta");
    expect(aba).toContain("Marco Antônio Alves Schetino");
    expect(aba).toContain("Ana Lima");
  });

  it("emitido o lote, a confirmação some", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/turmas/${h.turma_id}/certificados`, {}, { seguir: false });
    const aba = (await cliente.get(`/turmas/${h.turma_id}?aba=emissao`)).text;
    expect(aba).not.toContain('id="emitir-lote"');
    expect(aba).toContain("Ninguém apto a emitir nesta turma agora");
  });

  it("lista e busca por chave", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.inscricao_id }, { seguir: false });
    const gravado = (await _certificados_gravados())[0]!;
    const lista = await cliente.get("/certificados");
    expect(lista.status).toBe(200);
    expect(lista.text).toContain(gravado.rotulo);
    const achou = await cliente.get(`/certificados?busca=${gravado.chave.toLowerCase()}`);
    expect(achou.text).toContain("Marco Antônio");
    const vazio = await cliente.get("/certificados?busca=CSSO-2026-AAAAA-AAAAA-A");
    expect(vazio.text).toContain("Nenhum certificado nesta seleção");
  });

  it("segunda via pela rota sai em .docx", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.inscricao_id }, { seguir: false });
    const gravado = (await _certificados_gravados())[0]!;
    const resposta = await cliente.get(`/certificados/${gravado.id}/documento`);
    expect(resposta.status).toBe(200);
    expect(resposta.cabecalho("content-type")!.startsWith("application/vnd.openxmlformats")).toBe(true);
    expect(resposta.text.slice(0, 2)).toBe("PK");
  });

  it("anular pela tela exige motivo e não grava a recusa", async () => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.inscricao_id }, { seguir: false });
    const gravado = (await _certificados_gravados())[0]!;

    const recusa = await cliente.post(`/certificados/${gravado.id}/anular`, { motivo: "   " }, { seguir: false });
    expect(recusa.status).toBe(303);
    expect((await cliente.get(recusa.location!)).text).toContain("motivo");
    expect((await _certificados_gravados())[0]!.situacao).toBe("EMITIDO");

    const ok = await cliente.post(`/certificados/${gravado.id}/anular`, { motivo: "nome social" }, { seguir: false });
    expect(ok.status).toBe(303);
    expect((await _certificados_gravados())[0]!.situacao).toBe("ANULADO");
    const ficha = await cliente.get(`/certificados/${gravado.id}`);
    expect(ficha.text).toContain("Anulado");
    expect(ficha.text).toContain("nome social");
  });

  it.each([
    ["coordenador_csso", true, true, true],
    ["engenheiro_seguranca", true, true, true],
    ["tecnico_seguranca", true, true, false],
    ["secretaria_csso", true, true, false],
    ["consulta_progep", true, false, false],
    ["auditor_interno", true, false, false],
    ["servidor_consulta", false, false, false],
    ["admin_ti", false, false, false],
  ] as const)("permissão por perfil em cada rota: %s", async (perfil, pode_ver, pode_emitir, pode_anular) => {
    const h = await cenario_http();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.inscricao_id }, { seguir: false });
    const gravado = (await _certificados_gravados())[0]!;
    // regra de dono (23/10/2026): a turma é do coordenador; o perfil testado
    // entra como ajudante da emissão, e o que se mede aqui é o RBAC
    await designarAjudante(db, h.turma_id, perfil, { emissao: true });

    await entrar(cliente, perfil);
    const esperado = pode_ver ? 200 : 403;
    expect((await cliente.get("/certificados")).status, "/certificados").toBe(esperado);
    expect((await cliente.get(`/certificados/${gravado.id}`)).status).toBe(esperado);
    expect((await cliente.get(`/certificados/${gravado.id}/documento`)).status).toBe(esperado);

    const emissao = await cliente.post(`/turmas/${h.turma_id}/certificados`, { inscricao_id: h.outra_id }, { seguir: false });
    expect(emissao.status).toBe(pode_emitir ? 303 : 403);

    const anulacao = await cliente.post(`/certificados/${gravado.id}/anular`, { motivo: "teste de permissão" }, { seguir: false });
    expect(anulacao.status).toBe(pode_anular ? 303 : 403);
    if (!pode_anular) expect((await _certificados_gravados())[0]!.situacao).toBe("EMITIDO");
  });

  it("rotas de certificado exigem sessão", async () => {
    for (const caminho of ["/certificados", "/certificados/1", "/certificados/1/documento"]) {
      const resposta = await cliente.get(caminho, { seguir: false });
      expect(resposta.status).toBe(303);
      expect(resposta.location).toContain("/login");
    }
  });
});

// =====================================================================
// Monitor de reciclagem
// =====================================================================
describe("reciclagem: o monitor e o aviso de 60 dias (JANELA_A_VENCER_DIAS)", () => {
  const HOJE = "2026-10-20";

  async function _dois_emitidos() {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
    const a = (await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const b = (await servico.emitir(db, usuario, cen.outras[0]!, { gerar_pdf: false })).certificado;
    // Marco vence em 10 dias; Ana venceu ontem
    await db.update(e.certificado).set({ data_vencimento: "2026-10-30" }).where(eq(e.certificado.id, a.id));
    await db.update(e.certificado).set({ data_vencimento: "2026-10-19" }).where(eq(e.certificado.id, b.id));
    return { usuario, a, b };
  }

  it("situação: vencido, a vencer em até 60 dias, válido", () => {
    expect(C.situacao_reciclagem({ data_vencimento: "2026-10-19" }, HOJE)).toBe("VENCIDO");
    expect(C.situacao_reciclagem({ data_vencimento: "2026-10-20" }, HOJE)).toBe("A_VENCER");
    expect(C.situacao_reciclagem({ data_vencimento: "2026-12-19" }, HOJE)).toBe("A_VENCER");
    expect(C.situacao_reciclagem({ data_vencimento: "2026-12-20" }, HOJE)).toBe("VALIDO");
  });

  it("o monitor lista o em vigor de cada pessoa, conta por situação e busca pelo nome", async () => {
    const { usuario, a } = await _dois_emitidos();
    const tudo = await reciclagem.monitor(db, usuario, HOJE);
    expect(tudo.contagem).toEqual({ VENCIDO: 1, A_VENCER: 1, VALIDO: 0 });
    expect(tudo.itens.map((x) => x.participante_nome)).toEqual(["Ana Lima", "Marco Antônio Alves Schetino"]);
    const busca = await reciclagem.monitor(db, usuario, HOJE, { busca: "marco antonio" });
    expect(busca.itens.map((x) => x.id)).toEqual([a.id]);
    const so_a_vencer = await reciclagem.monitor(db, usuario, HOJE, { situacao: "A_VENCER" });
    expect(so_a_vencer.itens.map((x) => x.id)).toEqual([a.id]);
  });

  it("quem se reciclou sai do monitor; o aviso abre na janela e fecha com a reciclagem", async () => {
    const { usuario, a, b } = await _dois_emitidos();
    const primeira = await reciclagem.varrer(db, HOJE);
    // só o de Marco está na janela; o de Ana já venceu antes de a rotina olhar
    expect(primeira).toEqual({ abertas: 1, fechadas: 0, avisados: 0 });
    const [aviso] = await db.select().from(e.pendencia).where(eq(e.pendencia.tipo, reciclagem.TIPO_PENDENCIA));
    expect(aviso).toMatchObject({ entidade: "certificado", entidade_id: a.id, prazo: "2026-10-30", responsavel_id: null });
    expect(aviso!.descricao).not.toContain("Marco");
    expect(await reciclagem.varrer(db, HOJE)).toEqual({ abertas: 0, fechadas: 0, avisados: 0 });

    // a reciclagem: um certificado novo do mesmo treinamento para a mesma
    // pessoa. Só a pessoa e o treinamento contam; a inscrição emprestada (a de
    // Ana, anulada antes) é para não precisar de uma segunda turma.
    const { id: _id, ...resto } = await _certificado(a.id);
    await servico.anular(db, usuario, await _certificado(b.id), "teste da reciclagem");
    await db.insert(e.certificado).values({
      ...resto,
      inscricao_id: b.inscricao_id,
      numero: 900,
      // inserido à mão: com a chave antiga, sem número impresso (o do original é único)
      numero_impresso: null,
      chave_validacao: servico_certificado.gerar_chave(2026),
      // depois do original, que foi emitido hoje (a data fixa quebrava na virada do dia)
      data_emissao: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      data_vencimento: "2028-10-25",
    });
    const monitor = await reciclagem.monitor(db, usuario, "2026-10-26");
    expect(monitor.itens.find((x) => x.participante_nome.startsWith("Marco"))!.data_vencimento).toBe("2028-10-25");
    expect(await reciclagem.varrer(db, "2026-10-26")).toEqual({ abertas: 0, fechadas: 1, avisados: 0 });
  });

  it("a tela do monitor abre para quem lê certificados, e não busca CPF", async () => {
    await _dois_emitidos();
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = await cliente.get("/certificados/vencimentos");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Ana Lima");
    expect(tela.text).toContain("Marco Antônio Alves Schetino");
    expect((await cliente.get("/certificados/vencimentos?busca=123.456.789-09")).text).toContain("não busca por CPF");
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.get("/certificados/vencimentos")).status).toBe(403);
  });
});

// =====================================================================
// Indicadores de treinamento
// =====================================================================
describe("indicadores de treinamento", () => {
  async function _cenario_indicadores() {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
    await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
    return { usuario, cen };
  }

  it("conta turmas, participantes, emitidos, pendentes e a taxa de aprovação", async () => {
    const { usuario } = await _cenario_indicadores();
    const r = await indicadores.calcular(db, usuario, { de: null, ate: null, unidade_promotora_id: null });
    expect(r).toMatchObject({
      turmas: 1,
      turmas_concluidas: 1,
      turmas_ativas: 0,
      participantes: 2,
      aprovados: 2,
      reprovados: 0,
      emitidos: 1,
      pendentes: 1,
      taxa_aprovacao: 100,
    });
    expect(r.participantes_por_treinamento).toEqual({ "Trabalho em Altura — NR-35": 2 });
    // fora do período, nada
    const vazio = await indicadores.calcular(db, usuario, { de: "1990-01-01", ate: "1990-12-31", unidade_promotora_id: null });
    expect(vazio.turmas).toBe(0);
    expect(vazio.taxa_aprovacao).toBeNull();
  });

  it("o período: ano atual, anterior, todo e intervalo", () => {
    const hoje = "2026-10-20";
    expect(periodo_de("", "", "", hoje)).toEqual(["2026-01-01", "2026-12-31", "ano_atual"]);
    expect(periodo_de("ano_anterior", "", "", hoje)).toEqual(["2025-01-01", "2025-12-31", "ano_anterior"]);
    expect(periodo_de("todo", "", "", hoje)).toEqual([null, null, "todo"]);
    expect(periodo_de("intervalo", "2026-03-01", "", hoje)).toEqual(["2026-03-01", null, "intervalo"]);
    expect(periodo_de("intervalo", "torto", "", hoje)).toEqual(["2026-01-01", "2026-12-31", "ano_atual"]);
  });

  it("a tela mostra os números a quem vê nome e suprime as pessoas para quem não vê", async () => {
    await _cenario_indicadores();
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = await cliente.get("/treinamentos/indicadores?periodo=todo");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Treinamentos com mais participantes");
    expect(tela.text).toContain("Trabalho em Altura — NR-35");
    expect(tela.text).toContain("100%");
    await entrar(cliente, "secretaria_csso");
    const suprimida = await cliente.get("/treinamentos/indicadores?periodo=todo");
    expect(suprimida.status).toBe(200);
    expect(suprimida.text).not.toContain("100%");
    expect(suprimida.text).toMatch(/Participantes<\/div>\s*<div class="medida"><span class="valor">—</);
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.get("/treinamentos/indicadores")).status).toBe(403);
  });
});

// =====================================================================
// Fila de emissão
// =====================================================================
describe("fila de emissão entre turmas", () => {
  async function _cenario_fila() {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
    return { usuario, cen };
  }

  it("separa aguardando, emitido e travado, com o motivo da emissão", async () => {
    const { usuario, cen } = await _cenario_fila();
    let r = await fila_emissao.fila(db, usuario);
    expect(r.contagem).toMatchObject({ AGUARDANDO: 2, TRAVADO: 0, EMITIDO: 0 });
    await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
    r = await fila_emissao.fila(db, usuario, { etapa: "EMITIDO" });
    expect(r.itens.map((x) => x.participante_nome)).toEqual(["Marco Antônio Alves Schetino"]);
    expect(r.itens[0]!.certificado_rotulo).toMatch(/^[A-Z0-9]+-[A-Z0-9]+-\d{4}-\d{4}$/);
    // o instrutor perde a vigência antes do curso: a emissão recusaria, a fila diz por quê
    await db.update(e.assinatura_instrutor).set({ vigencia_fim: "2001-01-01", vigencia_inicio: "2000-01-01" });
    r = await fila_emissao.fila(db, usuario, { etapa: "TRAVADO" });
    expect(r.itens.map((x) => x.participante_nome)).toEqual(["Ana Lima"]);
    expect(r.itens[0]!.motivos.join(" ")).toMatch(/vig/i);
    expect(r.contagem.AGUARDANDO).toBe(0);
  });

  it("busca por nome e turma, e emite os marcados pela tela", async () => {
    await _cenario_fila();
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = await cliente.get("/certificados/fila?busca=ana+lima");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Ana Lima");
    expect(tela.text).not.toContain("Marco Antônio");
    const [ana] = await db
      .select({ id: e.inscricao.id })
      .from(e.inscricao)
      .innerJoin(e.participante, eq(e.participante.id, e.inscricao.participante_id))
      .innerJoin(e.servidor, eq(e.servidor.id, e.participante.servidor_id))
      .where(eq(e.servidor.nome, "Ana Lima"));
    const resposta = await cliente.post("/certificados/fila/emitir", { inscricao_id: [String(ana!.id)] }, { seguir: false });
    expect(resposta.status).toBe(303);
    expect((await cliente.get(resposta.location!)).text).toContain("1 certificado(s) emitido(s).");
    expect(await db.select().from(e.certificado)).toHaveLength(1);
    expect((await cliente.get("/certificados/fila?busca=123.456.789-09")).text).toContain("não busca por CPF");
  });

  it("quem não lê certificado não abre a fila, e quem não emite não emite", async () => {
    await _cenario_fila();
    await contas(db);
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.get("/certificados/fila")).status).toBe(403);
    await entrar(cliente, "auditor_interno");
    const tela = await cliente.get("/certificados/fila");
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain('action="/certificados/fila/emitir"');
    expect((await cliente.post("/certificados/fila/emitir", { inscricao_id: ["1"] })).status).toBe(403);
  });
});

describe("descrição do evento no certificado", () => {
  it("é congelada na emissão e o marcador «descrição do evento» a sugere", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    await db.update(e.turma).set({ descricao: "Formação de brigadistas do Campus JK" }).where(eq(e.turma.id, cen.turma.id));
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id))!;
    const { certificado } = await servico.emitir(db, usuario, inscricao, { gerar_pdf: false });
    expect(certificado.contexto_congelado.turma_descricao).toBe("Formação de brigadistas do Campus JK");
    const contexto = servico.montar_contexto(db, certificado);
    expect(servico_certificado.CAMPOS_CERTIFICADO.turma_descricao!.obter(contexto)).toBe("Formação de brigadistas do Campus JK");
    // o certificado emitido antes do campo lê vazio, sem quebrar
    const antigo = { ...certificado.contexto_congelado };
    delete antigo.turma_descricao;
    expect(servico_certificado.ContextoCertificado.descongelar(antigo).turma_descricao).toBe("");
    expect(
      servico_certificado.sugerir_campo({ marcador: "descricao", rotulo: "descrição do evento", antes: "", depois: "", ocorrencia: 1 }),
    ).toBe("turma_descricao");
  });
});
