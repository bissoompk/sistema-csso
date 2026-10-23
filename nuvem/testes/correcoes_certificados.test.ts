/**
 * Correções do lote "certificados, treinamentos e validação": um teste por
 * defeito de regra, permissão ou validação (e pelas melhorias que mudam
 * comportamento), com o número do item ao lado do nome.
 *
 * Banco limpo por teste (`bancoLimpo` no `beforeEach`): várias asserções
 * contam certificados e modelos do banco inteiro.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-correcoes-cert-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as acesso from "../src/servicos/acesso_participante.js";
import * as aviso_reciclagem from "../src/servicos/aviso_reciclagem.js";
import {
  CAMPOS_CERTIFICADO,
  ContextoCertificado,
  MODELO_PADRAO_ARQUIVO,
  MODELO_PADRAO_NOME,
  chave_valida,
  normalizar_chave,
  norma_no_nome,
} from "../src/servicos/certificado.js";
import { gerar_pdf } from "../src/servicos/certificado_pdf.js";
import * as conversor_pdf from "../src/servicos/conversor_pdf.js";
import * as documento from "../src/servicos/documento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as hub from "../src/servicos/hub_treinamentos.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as retificacao from "../src/servicos/retificacao.js";
import { semear_modelo_certificado } from "../src/servicos/sementes.js";
import * as servico_turma from "../src/servicos/turma.js";
import * as validacao from "../src/servicos/validacao_certificado.js";
import { normalizar_fluxo } from "../src/servicos/textos.js";
import { bancoLimpo, contas, entrar, naTransacao, usuarioAtual, type Cliente } from "./ajuda.js";
import { TODAS, _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  validacao.limpar_limites();
  acesso.limpar_limites();
});
afterEach(() => {
  delete process.env.CSSO_SMTP_URL;
  delete process.env.CSSO_EMAIL_REMETENTE;
});

function _ligar_email() {
  process.env.CSSO_SMTP_URL = "smtp://teste:teste@localhost:2525";
  process.env.CSSO_EMAIL_REMETENTE = "CSSO <csso@teste.br>";
}

const _docx = (bytes: Uint8Array) => normalizar_fluxo(documento.extrair_texto(bytes));

/**
 * O texto do PDF da casa: as strings dos `Tj` de cada página (o pdf-lib grava
 * a Helvetica em WinAnsi, em hexadecimal), uma por linha desenhada.
 */
function _texto_pdf(bytes: Uint8Array): string {
  const bruto = Buffer.from(bytes);
  const pedacos: string[] = [];
  let inicio = bruto.indexOf("stream");
  while (inicio !== -1) {
    const corpo = bruto.indexOf("\n", inicio) + 1;
    const fim = bruto.indexOf("endstream", corpo);
    if (fim === -1) break;
    let conteudo: Buffer = bruto.subarray(corpo, fim);
    try {
      conteudo = inflateSync(conteudo);
    } catch {
      // stream sem compressão
    }
    for (const m of conteudo.toString("latin1").matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      pedacos.push(new TextDecoder("windows-1252").decode(Buffer.from(m[1]!, "hex")));
    }
    inicio = bruto.indexOf("stream", fim + 9);
  }
  return pedacos.join("\n");
}

/** O cenário de sempre, apontado para o genérico vigente da semente (o v2). */
async function _no_padrao_da_casa(d: { validade_meses?: number } = {}) {
  const usuario = await _usuario(db);
  const cen = await _cenario(db, usuario);
  await db
    .update(e.treinamento)
    .set({ modelo_vigente_id: null, validade_meses: d.validade_meses ?? 0 })
    .where(eq(e.treinamento.id, cen.treinamento.id));
  const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id))!;
  return { ...cen, usuario, inscricao };
}

// =====================================================================
// D28, D29, D30, M45 — o texto do certificado novo (Padrão da casa v2)
// =====================================================================
describe("D28/D29/D30/M45: o certificado novo escreve as frases inteiras", () => {
  it("a norma não se repete quando o nome já a traz", () => {
    expect(norma_no_nome("Uso e conservação de EPI — NR-6", "NR-6")).toBe(true);
    expect(norma_no_nome("Trabalho em Altura (nr 35)", "NR-35")).toBe(true);
    expect(norma_no_nome("Segurança NR35", "NR-35")).toBe(true);
    expect(norma_no_nome("Uso de EPI — NR-60", "NR-6")).toBe(false);
    expect(norma_no_nome("Primeiros socorros", "NR-7")).toBe(false);
  });

  it("emissão nova sai no v2: sem 'NR-35 NR-35', sem 'promovido por ,' e com 'Validade: indeterminada'", async () => {
    const cen = await _no_padrao_da_casa({ validade_meses: 0 });
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao);
    expect(emitido.certificado.modelo_arquivo).toBe(MODELO_PADRAO_ARQUIVO);
    const texto = _docx(emitido.bytes);
    expect(texto).toContain("concluiu o treinamento Trabalho em Altura — NR-35, com carga horária");
    expect(texto).not.toContain("NR-35 NR-35");
    expect(texto).not.toContain("promovido por ,");
    expect(texto).toContain("em Auditório do Campus JK, com frequência de 100%");
    expect(texto).toContain(`Certificado nº ${emitido.certificado.numero_impresso} · Validade: indeterminada`);
    expect(texto).not.toContain("não expira");
    // o PDF diz o mesmo
    const pdf = _texto_pdf((await servico.pdf_do_certificado(db, cen.usuario, emitido.certificado)).bytes);
    expect(pdf).toContain("Validade: indeterminada");
    expect(pdf).not.toContain("NR-35 NR-35");
    expect(pdf).not.toContain("promovido por");
    // M45: o espaço antes do travessão chega ao texto do PDF (antes cada
    // palavra era um desenho, e quem copiava lia "Trabalho— CREA")
    expect(pdf).toContain("Engenheiro de Segurança do Trabalho — CREA MG-123456");
  });

  it("com validade e unidade promotora, as frases aparecem inteiras", async () => {
    const cen = await _no_padrao_da_casa({ validade_meses: 24 });
    const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
    await db.update(e.turma).set({ unidade_promotora_id: unidade!.id }).where(eq(e.turma.id, cen.turma.id));
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id))!;
    const emitido = await servico.emitir(db, cen.usuario, inscricao);
    const texto = _docx(emitido.bytes);
    expect(texto).toContain(`, promovido por ${unidade!.nome_extenso}, com frequência`);
    expect(texto).toMatch(/· válido até \d{2}\/\d{2}\/\d{4}/);
  });

  it("o certificado de antes (v1, sem `redacao`) reimprime igual, defeito incluído (RN-15)", async () => {
    const antigo = ContextoCertificado.descongelar({
      participante_nome: "Ana",
      treinamento_nome: "Uso e conservação de EPI — NR-6",
      treinamento_norma: "NR-6",
      treinamento_conteudo: "",
      carga_horaria: "4",
      turma_data_inicio: "2026-01-10",
      turma_data_fim: "2026-01-10",
      data_emissao: "2026-01-12",
      data_vencimento: null,
      numero: 9,
      ano: 2026,
      instrutores: [],
      mapa_tags: {},
      modelo_arquivo: "certificado_padrao_v1.docx",
    });
    expect(antigo.redacao).toBe(1);
    // o nome sai em negrito e a norma não: dois desenhos colados na mesma linha
    const pdf = _texto_pdf(await gerar_pdf([antigo])).replaceAll("\n", "");
    expect(pdf).toContain("Uso e conservação de EPI — NR-6 NR-6");
    expect(pdf).toContain("válido até não expira");
    // o mesmo contexto na redação nova
    const novo = ContextoCertificado.descongelar({ ...antigo.congelar(), redacao: 2 });
    const pdf_novo = _texto_pdf(await gerar_pdf([novo]));
    expect(pdf_novo).not.toContain("NR-6 NR-6");
    expect(pdf_novo).toContain("Validade: indeterminada");
    expect(CAMPOS_CERTIFICADO.certificado_frase_validade!.obter(novo)).toBe("Validade: indeterminada");
  });

  it("a semente promove o 'Padrão da casa' do v1 ao v2 uma vez só, e a v1 fica para as segundas vias", async () => {
    const modelos = await db
      .select()
      .from(e.certificado_modelo)
      .where(and(isNull(e.certificado_modelo.treinamento_id), eq(e.certificado_modelo.nome, MODELO_PADRAO_NOME)))
      .orderBy(asc(e.certificado_modelo.versao));
    expect(modelos.map((m) => [m.versao, m.arquivo, m.vigente])).toEqual([
      [1, "certificado_padrao_v1.docx", false],
      [2, "certificado_padrao_v2.docx", true],
    ]);
    const tags = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.modelo_id, modelos[1]!.id));
    const mapa = Object.fromEntries(tags.map((t) => [t.marcador, t.campo]));
    expect(mapa.curso_e_norma).toBe("treinamento_nome_e_norma");
    expect(mapa.trecho_promotora).toBe("turma_trecho_promotora");
    expect(mapa.frase_validade).toBe("certificado_frase_validade");
    expect(mapa).not.toHaveProperty("norma");
    await naTransacao((tx) => semear_modelo_certificado(tx));
    expect(await db.select().from(e.certificado_modelo)).toHaveLength(2);
  });
});

// =====================================================================
// D31 — o anulado sai com a tarja, e o hash continua o da emissão
// =====================================================================
describe("D31: segunda via do anulado carimbada", () => {
  it("PDF e Word do anulado dizem ANULADO e o substituto; o texto conferido não muda", async () => {
    const cen = await _no_padrao_da_casa({ validade_meses: 24 });
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao);
    const r = await db.transaction((tx) =>
      retificacao.retificar(tx, cen.usuario, emitido.certificado, "nome social", {}),
    );
    const [antigo] = await db.select().from(e.certificado).where(eq(e.certificado.id, emitido.certificado.id));
    const tarja = await servico.tarja_do_anulado(db, antigo!);
    expect(tarja).toMatch(new RegExp(`^ANULADO em \\d{2}/\\d{2}/\\d{4} — substituído por ${r.novo.numero_impresso}$`));

    const via = await servico.segunda_via(db, cen.usuario, antigo!);
    expect(via.confere).toBe(true);
    expect(via.hash_conteudo).toBe(antigo!.hash_conteudo);
    expect(_docx(via.bytes).startsWith(tarja!)).toBe(true);

    const pdf = _texto_pdf((await servico.pdf_do_certificado(db, cen.usuario, antigo!)).bytes);
    expect(pdf).toContain(tarja!);
    expect(pdf).toContain("ANULADO");
    // o válido não leva tarja
    const [novo] = await db.select().from(e.certificado).where(eq(e.certificado.id, r.novo.id));
    expect(await servico.tarja_do_anulado(db, novo!)).toBeNull();
    expect(_texto_pdf((await servico.pdf_do_certificado(db, cen.usuario, novo!)).bytes)).not.toContain("ANULADO");
  });

  it("o PDF guardado do modelo enviado não serve depois de anulado (outra chave)", () => {
    const valido = conversor_pdf.chave_do_pdf(7, "abc", "def");
    expect(conversor_pdf.chave_do_pdf(7, "abc", "def", "")).toBe(valido);
    expect(conversor_pdf.chave_do_pdf(7, "abc", "def", "ANULADO em 01/01/2026")).not.toBe(valido);
  });
});

// =====================================================================
// D35, D44, M44 — indicadores
// =====================================================================
describe("D35/D44/M44: indicadores", () => {
  it("D35: sem exposicao.ver, a taxa some quando um dos lados está suprimido, e '—' não acende o alerta", async () => {
    await contas(db);
    const usuario = await _usuario(db);
    // 2 aprovados (suprimidos, abaixo de 5) e 6 reprovados: a taxa (25%) devolveria os 2
    await _cenario(db, usuario, {
      extras: [
        ["2220001", "Ana Lima", "8"],
        ["3330001", "R Um", "1"],
        ["3330002", "R Dois", "1"],
        ["3330003", "R Três", "1"],
        ["3330004", "R Quatro", "1"],
        ["3330005", "R Cinco", "1"],
        ["3330006", "R Seis", "1"],
      ],
    });
    await entrar(cliente, "secretaria_csso");
    const tela = (await cliente.get("/treinamentos/indicadores?periodo=todo")).text;
    expect(tela).toContain("— aprovado(s), 6 reprovado(s)");
    expect(tela).not.toContain("25%");
    expect(tela).not.toMatch(/class="kpi alerta"/);
    // quem vê nome vê a taxa
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/treinamentos/indicadores?periodo=todo")).text).toContain("25%");
  });

  it("D44: intervalo invertido avisa em vez de mostrar tudo zerado; De/Até só com 'De… até…'", async () => {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/indicadores?periodo=intervalo&de=2026-12-31&ate=2026-01-01")).text;
    expect(tela).toContain("A data inicial é posterior à final");
    expect(tela).not.toContain("Turmas iniciadas de 31/12/2026 a 01/01/2026");
    expect(tela).not.toContain("Taxa de aprovação");
    expect(tela).toContain('data-mostra-quando="periodo=intervalo"');
    const certo = (await cliente.get("/treinamentos/indicadores?periodo=intervalo&de=2026-01-01&ate=2026-12-31")).text;
    expect(certo).toContain("Turmas iniciadas de 01/01/2026 a 31/12/2026");
    expect(certo).not.toContain("A data inicial é posterior à final");
  });
});

// =====================================================================
// D40 — a chave com ou sem traços, e por trecho
// =====================================================================
describe("D40: busca e validação pela chave sem traços", () => {
  it("normalizar_chave refaz os traços", () => {
    expect(normalizar_chave("csso2026r9r68vj7vgp")).toBe("CSSO-2026-R9R68-VJ7VG-P");
    expect(normalizar_chave(" CSSO 2026–R9R68–VJ7VG–P ")).toBe("CSSO-2026-R9R68-VJ7VG-P");
    expect(normalizar_chave("2026R9R68VJ7VGP")).toBe("CSSO-2026-R9R68-VJ7VG-P");
    expect(normalizar_chave("CSSO-2026-R9R68-VJ7VG-P")).toBe("CSSO-2026-R9R68-VJ7VG-P");
    // o que não tem o tamanho da chave fica como veio (sem espaço, em caixa alta)
    expect(normalizar_chave("r9r68")).toBe("R9R68");
  });

  it("/certificados acha pela chave sem traços e por um trecho; /validar aceita a chave sem traços", async () => {
    await contas(db);
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const emitido = await servico.emitir(db, usuario, cen.inscricao);
    const chave = emitido.certificado.chave_validacao;
    expect(chave_valida(chave)).toBe(true);
    await entrar(cliente, "coordenador_csso");
    // 22/10/2026: o número impresso; a chave nova termina nos 5 sorteados
    const rotulo = emitido.certificado.numero_impresso!;
    for (const termo of [chave.replaceAll("-", "").toLowerCase(), chave.slice(-5), chave.slice(-7)]) {
      const tela = (await cliente.get(`/certificados?busca=${encodeURIComponent(termo)}`)).text;
      expect(tela, termo).toContain(rotulo);
    }
    // revisão: o pedaço curto não casa com a chave — "csso" e o ano estão em
    // toda chave, e listariam todos os certificados
    for (const termo of ["csso", chave.slice(-5, -1)]) {
      const tela = (await cliente.get(`/certificados?busca=${encodeURIComponent(termo)}`)).text;
      expect(tela, termo).not.toContain(`>${rotulo}<`);
    }
    const publica = await novoCliente().get(`/validar/${chave.replaceAll("-", "").toLowerCase()}`);
    expect(publica.text).toContain("Certificado autêntico");
  });
});

// =====================================================================
// D43 — a fila que não emitiu ninguém responde erro
// =====================================================================
describe("D43: emitir pela fila sem ninguém válido", () => {
  it("0 emitidos vira erro, e não 'OK: 0 certificado(s)'", async () => {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post("/certificados/fila/emitir", { inscricao_id: "99999" }, { seguir: false });
    expect(r.status).toBe(303);
    const destino = decodeURIComponent(r.cabecalho("location") ?? "");
    expect(destino).toContain("erro=Nenhum dos marcados pôde ser emitido.");
    expect(destino).not.toContain("mensagem=");
  });
});

// =====================================================================
// D52, M56 — o link por e-mail lista só os do titular
// =====================================================================
describe("D52/M56: acesso pelo link do e-mail", () => {
  async function _dois_com_o_mesmo_email(confirmar_o_primeiro: boolean) {
    const usuario = await _usuario(db, TODAS, "montador");
    const d = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
    await servico.emitir_lote(db, usuario, d.turma);
    const marco = (await servico_participante.carregar(db, d.inscricao.participante_id))!;
    const ana = (await servico_participante.carregar(db, d.outras[0]!.participante_id))!;
    await servico_participante.registrar_email(db, marco, "casa@exemplo.com", {
      confirmado_em: confirmar_o_primeiro ? new Date() : null,
    });
    await servico_participante.registrar_email(db, ana, "casa@exemplo.com");
    const certificados = await db.select().from(e.certificado).orderBy(asc(e.certificado.id));
    return {
      do_marco: certificados.find((c) => c.participante_id === marco.id)!,
      da_ana: certificados.find((c) => c.participante_id === ana.id)!,
    };
  }

  async function _token(): Promise<string> {
    _ligar_email();
    await novoCliente().post(acesso.CAMINHO, { email: "casa@exemplo.com" });
    const [linha] = (await db.select().from(e.email_saida)).filter((x) => x.tipo === acesso.TIPO_EMAIL);
    return linha!.corpo!.match(/\/certificados\/acesso\/([A-Za-z0-9_-]{20,})/)![1]!;
  }

  it("e-mail sem confirmação em dois cadastros: não lista nenhum e manda procurar a equipe responsável", async () => {
    const h = await _dois_com_o_mesmo_email(false);
    const token = await _token();
    const aberto = (await acesso.abrir(db, token))!;
    expect(aberto.ambiguo).toBe(true);
    expect(aberto.certificados).toEqual([]);
    const publico = novoCliente();
    const tela = await publico.get(`${acesso.CAMINHO}/${token}`);
    expect(tela.text).toContain("Este e-mail está no cadastro de mais de uma pessoa");
    expect(tela.text).not.toContain("Trabalho em Altura");
    expect((await publico.get(`${acesso.CAMINHO}/${token}/${h.do_marco.id}`)).status).toBe(404);
    expect((await publico.get(`${acesso.CAMINHO}/${token}/${h.da_ana.id}`)).status).toBe(404);
  });

  it("e-mail confirmado: só os do dono, com o nome dele e quanto falta para o link vencer", async () => {
    const h = await _dois_com_o_mesmo_email(true);
    const token = await _token();
    const publico = novoCliente();
    const tela = await publico.get(`${acesso.CAMINHO}/${token}`);
    expect(tela.text).toContain("Certificados de <strong>Marco Antônio Alves Schetino</strong>");
    expect(tela.text).toMatch(/vence às <strong>\d{2}:\d{2}<\/strong> \(daqui a (1 h( \d+ min)?|\d+ min)\)/);
    // os cartões de "Meus certificados" (Portal do servidor, 22/10/2026)
    expect(tela.text).toContain('<ul class="grade-cert" role="list">');
    expect(tela.text).toContain(`${acesso.CAMINHO}/${token}/${h.do_marco.id}`);
    expect(tela.text).not.toContain(`${acesso.CAMINHO}/${token}/${h.da_ana.id}`);
    expect((await publico.get(`${acesso.CAMINHO}/${token}/${h.da_ana.id}`)).status).toBe(404);
  });

  it("o tempo que falta, por extenso curto", () => {
    const agora = new Date("2026-10-21T12:00:00Z");
    const mais = (min: number) => new Date(agora.getTime() + min * 60_000);
    expect(acesso.tempo_restante(mais(107), agora)).toBe("1 h 47 min");
    expect(acesso.tempo_restante(mais(120), agora)).toBe("2 h");
    expect(acesso.tempo_restante(mais(12), agora)).toBe("12 min");
    expect(acesso.tempo_restante(mais(0.5), agora)).toBe("menos de 1 min");
  });
});

// =====================================================================
// D57 — sem envio de e-mail, nada de convite para o acesso por e-mail
// =====================================================================
describe("D57: convite do acesso por e-mail só com o envio ligado", () => {
  it("/validar e o link vencido não levam a um beco sem saída", async () => {
    const publico = novoCliente();
    const sem = (await publico.get("/validar")).text;
    expect(sem).not.toContain('href="/certificados/acesso"');
    expect(sem).toContain("Peça ao setor que promoveu o treinamento.");
    const vencido = (await publico.get(`${acesso.CAMINHO}/token-que-nao-existe-123456`)).text;
    expect(vencido).not.toContain("Pedir um link novo");
    _ligar_email();
    expect((await publico.get("/validar")).text).toContain('href="/certificados/acesso"');
    expect((await publico.get(`${acesso.CAMINHO}/token-que-nao-existe-123456`)).text).toContain("Pedir um link novo");
  });
});

// =====================================================================
// D58 — a porta padrão do link público
// =====================================================================
describe("D58: o endereço de desenvolvimento usa a porta do servidor local", () => {
  it("sem parâmetro nem ambiente, cai em 127.0.0.1:8766 (ou na PORTA definida)", async () => {
    const guardado = { PORTA: process.env.PORTA, CSSO_URL_PUBLICA: process.env.CSSO_URL_PUBLICA, URL: process.env.URL };
    try {
      delete process.env.PORTA;
      delete process.env.CSSO_URL_PUBLICA;
      delete process.env.URL;
      expect(await servico.url_base_validacao(db)).toBe("http://127.0.0.1:8766");
      process.env.PORTA = "9123";
      expect(await servico.url_base_validacao(db)).toBe("http://127.0.0.1:9123");
    } finally {
      for (const [k, v] of Object.entries(guardado)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// =====================================================================
// M34 — a frase do genérico, no presente
// =====================================================================
describe("M34: o aviso do modelo genérico", () => {
  it("diz que o certificado SAI no genérico, antes de sair", async () => {
    const cen = await _no_padrao_da_casa();
    const [, aviso] = await servico.modelo_da_turma(db, cen.inscricao.turma);
    expect(aviso).toContain("não tem modelo próprio — sai no modelo genérico Padrão da casa v2");
  });
});

// =====================================================================
// M43 — o aviso de reciclagem diz por que cada um ficou de fora
// =====================================================================
describe("M43: aviso de reciclagem", () => {
  it("separa anulado, sem vencimento e fora do escopo na frase", () => {
    const frase = aviso_reciclagem.resumo({
      enfileirados: 0,
      sem_email: 0,
      ja_avisados: 0,
      anulados: 1,
      sem_vencimento: 2,
      fora: 3,
    });
    expect(frase).toContain("1 anulado(s)");
    expect(frase).toContain("2 sem vencimento");
    expect(frase).toContain("3 fora do seu escopo");
  });

  it("o certificado sem vencimento conta como tal, e não como 'fora'", async () => {
    const cen = await _no_padrao_da_casa({ validade_meses: 0 });
    const emitido = await servico.emitir(db, cen.usuario, cen.inscricao);
    const r = await aviso_reciclagem.avisar_marcados(db, cen.usuario, [emitido.certificado.id, 99999]);
    expect([r.sem_vencimento, r.anulados, r.fora]).toEqual([1, 0, 1]);
  });

  it("o interruptor do automático mora na configuração recolhida", async () => {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/certificados/vencimentos")).text;
    expect(tela).toContain('<details class="recolhido" id="configuracao">');
    expect(tela).toContain('role="switch"');
    // desmarcado e salvo, desliga
    await cliente.post("/certificados/vencimentos/automatico", { ligado: "sim" });
    expect(await aviso_reciclagem.automatico_ligado(db)).toBe(true);
    await cliente.post("/certificados/vencimentos/automatico", {});
    expect(await aviso_reciclagem.automatico_ligado(db)).toBe(false);
  });
});

// =====================================================================
// M31 — o início do módulo
// =====================================================================
describe("M31: os cartões do início", () => {
  it("numerados sem buraco e sem prometer o que o perfil não faz", async () => {
    await contas(db);
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    const r = await hub.resumo(db, secretaria, "2026-10-21");
    const cartoes = hub.cartoes(secretaria, r);
    expect(cartoes.map((c) => c.numero)).toEqual(cartoes.map((_, i) => i + 1));
    const textos = cartoes.map((c) => `${c.titulo} ${c.descricao}`).join(" | ");
    expect(textos).not.toContain("corrigir e anular");
    expect(textos).not.toContain(".docx");
    expect(cartoes.map((c) => c.titulo)).toContain("Reciclagem");

    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const do_coordenador = hub.cartoes(coordenador, await hub.resumo(db, coordenador, "2026-10-21"));
    expect(do_coordenador.map((c) => c.titulo)).toContain("Instrutores");
    expect(do_coordenador.find((c) => c.titulo === "Emitidos")!.descricao).toContain("corrigir e anular");

    await entrar(cliente, "secretaria_csso");
    const tela = (await cliente.get("/treinamentos")).text;
    expect(tela).toContain("Certificados e Treinamentos");
    expect(tela).not.toContain("Centro de Certificações e Inscrições");
    expect(tela).not.toContain("Vencimentos (NR)");
  });
});

// =====================================================================
// M37 — o catálogo
// =====================================================================
describe("M37: catálogo", () => {
  it("carga em número brasileiro, cabeçalho da reciclagem e a edição na ficha da linha", async () => {
    await contas(db);
    await db.insert(e.treinamento).values({
      codigo: "NR-10",
      nome: "Segurança em Instalações e Serviços em Eletricidade — NR-10",
      carga_horaria_horas: "16.5",
      validade_meses: 24,
    });
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    expect(tela).toContain("16,5 h");
    expect(tela).not.toContain("16.5");
    expect(tela).toContain("(meses, 0 = não vence)");
    expect(tela).toContain("Segurança em Instalações e Serviços em Eletricidade — NR-10");
    expect(tela).toMatch(/<dialog class="popup" id="editar-trein-\d+"/);
  });
});

// =====================================================================
// M42 — participantes
// =====================================================================
describe("M42: participantes", () => {
  it("o termo da busca local não vai para a busca global do cabeçalho", async () => {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/participantes?busca=TESTE")).text;
    expect(tela).toContain('id="busca-participante" type="search" name="busca" value="TESTE"');
    const global = /id="busca-global"[^>]*value="([^"]*)"/.exec(tela);
    if (global) expect(global[1]).toBe("");
  });
});

// =====================================================================
// M50 — meus certificados
// =====================================================================
describe("M50: meus certificados", () => {
  it("o anulado vai para a seção recolhida com o substituto; o válido tem o link de validação", async () => {
    await contas(db);
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const emitido = await servico.emitir(db, usuario, cen.inscricao);
    const r = await db.transaction((tx) => retificacao.retificar(tx, usuario, emitido.certificado, "nome social", {}));
    // a conta do servidor titular
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "servidor_consulta"));
    await db.update(e.usuario).set({ servidor_id: cen.servidor.id }).where(eq(e.usuario.id, conta!.id));
    await entrar(cliente, "servidor_consulta");
    const tela = (await cliente.get("/certificados/meus")).text;
    // Portal do servidor (22/10/2026): cartões; o anulado na seção recolhida
    const recolhido = tela.indexOf("<summary>Certificados anulados");
    expect(recolhido).toBeGreaterThan(-1);
    const depois = tela.slice(recolhido);
    expect(depois).toContain(`${emitido.certificado.numero_impresso}`);
    expect(depois).toContain("Anulado → substituído por");
    expect(depois).toContain(`href="/certificados/${r.novo.id}"`);
    expect(depois).toContain("Baixar cópia anulada");
    const antes = tela.slice(0, recolhido);
    expect(antes).toContain(`data-copiar="validacao-${r.novo.id}"`);
    expect(antes).toContain(`/validar/${r.novo.chave_validacao}`);
    expect(antes).not.toContain(`/certificados/${emitido.certificado.id}/pdf`);
    expect(tela).toContain('<ul class="grade-cert" role="list">');
    expect(tela).toContain("1 certificado emitido");
  });
});

// =====================================================================
// M55 — o resultado da validação vem antes do campo
// =====================================================================
describe("M55: validação pública", () => {
  it("o selo vem no topo, o 'confere' fica junto do nome, e a explicação recolhida", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const emitido = await servico.emitir(db, usuario, cen.inscricao);
    const chave = emitido.certificado.chave_validacao;
    const publico = novoCliente();
    const tela = (await publico.get(`/validar/${chave}`)).text;
    expect(tela.indexOf("Certificado autêntico")).toBeLessThan(tela.indexOf('name="chave"'));
    expect(tela).toContain('<details class="recolhido">');
    const conferido = (await publico.post(`/validar/${chave}/conferir`, { nome: "Fulano de Tal" })).text;
    const campo = conferido.indexOf('id="nome"');
    const nao_confere = conferido.indexOf("Não confere.");
    expect(campo).toBeGreaterThan(-1);
    expect(nao_confere).toBeGreaterThan(campo);
    expect(nao_confere).toBeLessThan(conferido.indexOf("Conferir o nome"));
  });
});

// =====================================================================
// M35 — a ficha do certificado anulado
// =====================================================================
describe("M35: ficha do certificado", () => {
  it("dicionário e trilha recolhidos; no anulado, a cópia é secundária e o substituto vem em destaque", async () => {
    await contas(db);
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const emitido = await servico.emitir(db, usuario, cen.inscricao);
    const r = await db.transaction((tx) => retificacao.retificar(tx, usuario, emitido.certificado, "nome social", {}));
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get(`/certificados/${emitido.certificado.id}`)).text;
    expect(tela).toContain("<summary>O dicionário de tags congelado");
    expect(tela).toContain("<summary>Trilha");
    expect(tela).toContain(`Abrir o substituto ${r.novo.numero_impresso}`);
    expect(tela).toContain("Baixar cópia anulada");
    expect(tela).not.toMatch(/<a class="botao" href="\/certificados\/\d+\/pdf"/);
  });
});
