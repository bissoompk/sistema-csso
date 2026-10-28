/**
 * A vitrine pública de cursos (/cursos): só a turma publicada aparece, cada aba
 * recebe as turmas certas, o pedido de vaga grava pelo mesmo caminho do link por
 * token, e a página pública não leva dado pessoal nem estilo ou script no HTML.
 * Dados fictícios.
 */
import { readFileSync } from "node:fs";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as divulgacao from "../src/servicos/vitrine_divulgacao.js";
import * as arte from "../src/servicos/vitrine_arte.js";
import { matriz_qr } from "../src/servicos/qr.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
  inscricao_publica.tempo_de_resposta.piso_ms = 0;
  inscricao_publica.tempo_de_resposta.variacao_ms = 0;
});

const INICIO = () => somar_dias(hoje_iso(), 30);
const DESCRICAO = "Capacitação para o trabalho em altura, com teoria, prática e avaliação ao final do curso.";

/** Uma turma com inscrições abertas e tudo o que a publicação pede, ainda não publicada. */
async function _turma(extra: Partial<typeof e.turma.$inferInsert> = {}, vagas = 10): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  const rt = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8", validade_meses: "24", norma_referencia: "NR-35" },
    { seguir: false },
  );
  expect(rt.status, rt.text.slice(0, 200)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "NR-35"));
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(t!.id), data_inicio: INICIO(), data_fim: somar_dias(INICIO(), 1), local: "Auditório do Campus JK", vagas: String(vagas) },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 200)).toBe(303);
  const [turma] = await db.select().from(e.turma);
  const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
  await db
    .update(e.turma)
    .set({
      situacao: "INSCRICOES_ABERTAS",
      inscricao_aberta_ate: somar_dias(hoje_iso(), 10),
      unidade_promotora_id: unidade!.id,
      descricao: DESCRICAO,
      publico_alvo: ["SERVIDOR"],
      ...extra,
    })
    .where(eq(e.turma.id, turma!.id));
  return turma!.id;
}

async function _codigo(id: number): Promise<string> {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!.codigo;
}

async function _publicar(id: number, extra: Record<string, string | string[]> = {}) {
  return cliente.post(
    `/turmas/${id}/vitrine`,
    { divulgar: "sim", modalidade: "PRESENCIAL", publico: ["SERVIDOR"], ...extra },
    { seguir: false },
  );
}

describe("a vitrine pública", () => {
  it("turma não publicada não aparece na lista nem tem ficha", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    const visitante = novoCliente();
    const lista = await visitante.get("/cursos");
    expect(lista.status).toBe(200);
    expect(lista.text).not.toContain(codigo);
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(404);
  });

  it("publicar pede o que falta, e depois aparece em Inscrições abertas com ficha", async () => {
    const id = await _turma({ descricao: null, publico_alvo: [] });
    const codigo = await _codigo(id);
    const recusa = await cliente.post(`/turmas/${id}/vitrine`, { divulgar: "sim", modalidade: "PRESENCIAL" }, { seguir: false });
    expect(recusa.status).toBe(303);
    const [antes] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(antes!.divulgar_na_vitrine).toBe(false);

    await db.update(e.turma).set({ descricao: DESCRICAO }).where(eq(e.turma.id, id));
    const ok = await _publicar(id);
    expect(ok.status).toBe(303);
    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(depois!.divulgar_na_vitrine).toBe(true);
    expect(depois!.divulgada_em).not.toBeNull();

    const visitante = novoCliente();
    const lista = await visitante.get("/cursos");
    expect(lista.text).toContain("Trabalho em Altura");
    expect(lista.text).toContain("Inscrições abertas (1)");
    expect(lista.text).toContain("Certificado incluso");
    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Pedir a vaga");
    expect(ficha.text).toContain("Auditório do Campus JK");
  });

  it("turma cancelada some; encerrada há mais de 90 dias responde 410", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(200);
    await db.update(e.turma).set({ situacao: "CANCELADA", motivo_cancelamento: "teste" }).where(eq(e.turma.id, id));
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(404);
    const antigo = somar_dias(hoje_iso(), -120);
    await db
      .update(e.turma)
      .set({ situacao: "CONCLUIDA", motivo_cancelamento: null, data_inicio: somar_dias(antigo, -1), data_fim: antigo, inscricao_aberta_ate: null })
      .where(eq(e.turma.id, id));
    expect((await visitante.get(`/cursos/${codigo}`)).status).toBe(410);
  });

  it("cada aba recebe as turmas certas", async () => {
    const id = await _turma();
    await _publicar(id);
    const visitante = novoCliente();
    const hoje = hoje_iso();
    // planejada e futura: Em breve
    await db.update(e.turma).set({ situacao: "PLANEJADA", inscricao_aberta_ate: null }).where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=breve")).text).toContain("Trabalho em Altura");
    expect((await visitante.get("/cursos?aba=abertas")).text).not.toContain("curso-cartao");
    // prazo terminou ontem: sai de Abertas
    await db.update(e.turma).set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(hoje, -1) }).where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=abertas")).text).not.toContain("curso-cartao");
    // prazo termina hoje: ainda aberta, com o selo
    await db.update(e.turma).set({ inscricao_aberta_ate: hoje }).where(eq(e.turma.id, id));
    const hoje_aba = await visitante.get("/cursos?aba=abertas");
    expect(hoje_aba.text).toContain("Encerra hoje");
    // concluída há 10 dias: Realizados
    const fim = somar_dias(hoje, -10);
    await db
      .update(e.turma)
      .set({ situacao: "CONCLUIDA", data_inicio: somar_dias(fim, -1), data_fim: fim, inscricao_aberta_ate: null })
      .where(eq(e.turma.id, id));
    expect((await visitante.get("/cursos?aba=realizados")).text).toContain("Trabalho em Altura");
  });

  it("turma lotada fica em Abertas com o selo e sem formulário", async () => {
    const id = await _turma({}, 1);
    const codigo = await _codigo(id);
    await _publicar(id);
    const [turma] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    const [part] = await db.insert(e.participante).values({ nome: "Fulano de Teste", vinculo: "VISITANTE", identificador_publico: "PTC-23456789" } as never).returning();
    await db.insert(e.inscricao).values({ turma_id: turma!.id, participante_id: part!.id, situacao: "CONFIRMADA", origem: "INTERNA" } as never);
    const visitante = novoCliente();
    expect((await visitante.get("/cursos")).text).toContain("Turma cheia");
    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.text).toContain("As vagas desta turma se esgotaram");
    expect(ficha.text).not.toContain("Pedir a vaga");
  });

  it("o pedido de vaga grava a inscrição; turma fechada não grava", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    const pedido = { nome: "Maria de Teste", vinculo: "DISCENTE", siape: "", email: "maria@exemplo.com", organizacao: "", consentimento: "sim", site: "" };
    const r = await visitante.post(`/cursos/${codigo}/inscricao`, pedido, { seguir: false });
    expect(r.status).toBe(303);
    const [n] = await db.select({ n: count() }).from(e.inscricao).where(eq(e.inscricao.turma_id, id));
    expect(Number(n!.n)).toBe(1);

    await db.update(e.turma).set({ situacao: "PLANEJADA" }).where(eq(e.turma.id, id));
    await visitante.post(`/cursos/${codigo}/inscricao`, { ...pedido, nome: "Outra Pessoa", email: "outra@exemplo.com" }, { seguir: false });
    const [m] = await db.select({ n: count() }).from(e.inscricao).where(eq(e.inscricao.turma_id, id));
    expect(Number(m!.n)).toBe(1);
  });

  it("o HTML público não leva nome, e-mail nem SIAPE de inscrito, nem estilo ou script inline", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    await _publicar(id);
    const visitante = novoCliente();
    await visitante.post(
      `/cursos/${codigo}/inscricao`,
      { nome: "Maria de Teste", vinculo: "DISCENTE", siape: "", email: "maria@exemplo.com", organizacao: "", consentimento: "sim", site: "" },
      { seguir: false },
    );
    const outro = novoCliente();
    for (const caminho of ["/cursos", `/cursos/${codigo}`]) {
      const html = (await outro.get(caminho)).text;
      expect(html, caminho).not.toContain("Maria de Teste");
      expect(html, caminho).not.toContain("maria@exemplo.com");
      expect(html, caminho).not.toMatch(/\sstyle="/);
    }
  });

  it("os templates da vitrine não escrevem estilo nem script no HTML", () => {
    for (const t of ["paginas/vitrine.html", "paginas/vitrine_curso.html", "partes/vitrine_cartao.html", "partes/inscricao_formulario.html"]) {
      const fonte = readFileSync(new URL(`../templates/${t}`, import.meta.url), "utf8");
      expect(fonte, t).not.toMatch(/\sstyle=|<script|<style/);
    }
  });

  it("quem não tem turma.criar não publica", async () => {
    const id = await _turma();
    const servidor = await entrar(novoCliente(), "servidor_consulta");
    const r = await servidor.post(`/turmas/${id}/vitrine`, { divulgar: "sim", modalidade: "PRESENCIAL", publico: ["SERVIDOR"] }, { seguir: false });
    expect(r.status).toBe(403);
    const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(t!.divulgar_na_vitrine).toBe(false);
  });
});

describe("a divulgação da ficha", () => {
  it("turma não publicada não entrega QR, cartaz nem agenda", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    const visitante = novoCliente();
    for (const f of ["qr.png", "cartaz.pdf", "agenda.ics"]) {
      expect((await visitante.get(`/cursos/${codigo}/${f}`)).status, f).toBe(404);
    }
  });

  it("publicada: a ficha traz o bloco Divulgue e os três arquivos saem", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    expect((await _publicar(id)).status).toBe(303);
    const visitante = novoCliente();
    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.text).toContain("Divulgue");
    expect(ficha.text).toContain(`/cursos/${codigo}/cartaz.pdf`);
    expect(ficha.text).toContain("https://wa.me/?text=");
    expect(ficha.text).toContain(`value="http://127.0.0.1:8766/cursos/${codigo}"`);

    const qr = await visitante.get(`/cursos/${codigo}/qr.png`);
    expect(qr.status).toBe(200);
    expect(qr.cabecalho("content-type")).toBe("image/png");
    expect(qr.text).toContain("PNG");

    const pdf = await visitante.get(`/cursos/${codigo}/cartaz.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.cabecalho("content-type")).toBe("application/pdf");
    expect(pdf.text.startsWith("%PDF")).toBe(true);
    expect(pdf.cabecalho("content-disposition")).toContain(`cartaz-${codigo}.pdf`);

    const agenda = await visitante.get(`/cursos/${codigo}/agenda.ics`);
    expect(agenda.status).toBe(200);
    expect(agenda.cabecalho("content-type")).toContain("text/calendar");
    expect(agenda.text).toContain("BEGIN:VCALENDAR");
    expect(agenda.text).toContain(`/cursos/${codigo}`);
    expect(agenda.text).not.toMatch(/\/turmas\/\d+/);
    expect(agenda.text.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it("o QR codifica o endereço absoluto da ficha e o texto do WhatsApp o leva junto", () => {
    const url = divulgacao.url_da_ficha("https://exemplo.ufvjm.test/", "TUR-2026-0031");
    expect(url).toBe("https://exemplo.ufvjm.test/cursos/TUR-2026-0031");
    expect(matriz_qr(url).tamanho).toBeGreaterThan(20);
    const curso = { titulo: "NR-35 Trabalho em altura", aberta: true, data_inicio: "2026-11-18", data_fim: "2026-11-19", local: "Campus JK", campus: null, modalidade: "PRESENCIAL" };
    const link = divulgacao.link_whatsapp(curso as never, url);
    expect(decodeURIComponent(link)).toContain("Inscrições abertas: NR-35 Trabalho em altura · 18/11/2026 a 19/11/2026");
    expect(decodeURIComponent(link)).toContain(url);
  });

  it("o cartaz troca o que a Helvetica não desenha por interrogação, sem derrubar", () => {
    expect(divulgacao.so_winansi("Água — ação ✓ 日本")).toBe("Água — ação ? ??");
  });
});

// ---- imagens mínimas, montadas à mão: o que importa é o cabeçalho e o que se esconde nele ----
function _u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function _bloco_png(tipo: string, dados: Buffer): Buffer {
  return Buffer.concat([_u32(dados.length), Buffer.from(tipo, "latin1"), dados, Buffer.alloc(4)]);
}
const SEGREDO = "GPS-LAT-19.8S";
function _png(l = 800, a = 1000): Uint8Array {
  const ihdr = Buffer.concat([_u32(l), _u32(a), Buffer.from([8, 0, 0, 0, 0])]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      _bloco_png("IHDR", ihdr),
      _bloco_png("tEXt", Buffer.from(`Comment\0${SEGREDO}`)),
      _bloco_png("IDAT", Buffer.from([1, 2, 3])),
      _bloco_png("IEND", Buffer.alloc(0)),
    ]),
  );
}
function _jpeg(l = 800, a = 1000): Uint8Array {
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from(SEGREDO)]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, a >> 8, a & 255, l >> 8, l & 255, 1, 1, 0x11, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xda, 0, 4, 0, 0, 9, 9, 0xff, 0xd9])]));
}
function _webp(l = 800, a = 1000): Uint8Array {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;
  vp8x.writeUIntLE(l - 1, 4, 3);
  vp8x.writeUIntLE(a - 1, 7, 3);
  const bloco = (t: string, d: Buffer) => {
    const c = Buffer.alloc(8);
    c.write(t, 0, "latin1");
    c.writeUInt32LE(d.length, 4);
    return Buffer.concat([c, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const corpo = Buffer.concat([Buffer.from("WEBP"), bloco("VP8X", vp8x), bloco("EXIF", Buffer.from(SEGREDO + "!")), bloco("VP8L", Buffer.from([0x2f, 1, 2, 3]))]);
  const topo = Buffer.alloc(8);
  topo.write("RIFF", 0, "latin1");
  topo.writeUInt32LE(corpo.length, 4);
  return new Uint8Array(Buffer.concat([topo, corpo]));
}
const _tem = (b: Uint8Array, t: string) => Buffer.from(b).includes(Buffer.from(t));

describe("a arte da turma", () => {
  it("lê o tamanho de PNG, JPEG e WEBP pelo cabeçalho", () => {
    expect(arte.dimensoes(_png(800, 1000), "image/png")).toEqual({ largura: 800, altura: 1000 });
    expect(arte.dimensoes(_jpeg(900, 1125), "image/jpeg")).toEqual({ largura: 900, altura: 1125 });
    expect(arte.dimensoes(_webp(1080, 1350), "image/webp")).toEqual({ largura: 1080, altura: 1350 });
  });

  it("tira o EXIF, o texto do PNG e o bloco EXIF do WEBP, sem mexer nas dimensões", () => {
    for (const [img, tipo, limpar] of [
      [_png(), "image/png", arte.limpar_png],
      [_jpeg(), "image/jpeg", arte.limpar_jpeg],
      [_webp(), "image/webp", arte.limpar_webp],
    ] as const) {
      expect(_tem(img, SEGREDO), tipo).toBe(true);
      const limpo = limpar(img);
      expect(_tem(limpo, SEGREDO), tipo).toBe(false);
      expect(arte.dimensoes(limpo, tipo), tipo).toEqual({ largura: 800, altura: 1000 });
    }
  });

  it("recusa SVG com nome de PNG, GIF, imagem pequena, grande e o que passa de 3 MB", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => arte.conferir({ conteudo: svg })).toThrow(/PNG, JPEG ou WEBP/);
    expect(() => arte.conferir({ conteudo: new TextEncoder().encode("GIF89a....") })).toThrow(/PNG, JPEG ou WEBP/);
    expect(() => arte.conferir({ conteudo: _png(300, 375) })).toThrow(/mínimo/);
    expect(() => arte.conferir({ conteudo: _png(3000, 3750) })).toThrow(/máximo/);
    expect(() => arte.conferir({ conteudo: new Uint8Array(4 * 1024 * 1024) })).toThrow(/limite é 3 MB/);
    expect(arte.foge_da_proporcao({ largura: 1000, altura: 1000 })).toBe(true);
    expect(arte.foge_da_proporcao({ largura: 800, altura: 1000 })).toBe(false);
  });

  it("envio grava sem metadados, aparece na vitrine só com a turma publicada, e remover volta à capa", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    const arquivo = new File([_png() as unknown as ArrayBuffer], "cartaz.png", { type: "image/png" });
    const sem_declaracao = await cliente.post(`/turmas/${id}/vitrine/arte`, { arte: arquivo, arte_alt: "Cartaz" }, { seguir: false });
    expect(sem_declaracao.status).toBe(303);
    expect((await db.select().from(e.turma).where(eq(e.turma.id, id)))[0]!.arte_anexo_id).toBeNull();

    const ok = await cliente.post(`/turmas/${id}/vitrine/arte`, { arte: arquivo, arte_alt: "Cartaz do curso", declaracao: "sim" }, { seguir: false });
    expect(ok.status).toBe(303);
    const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(t!.arte_anexo_id).not.toBeNull();
    expect(t!.arte_alt).toBe("Cartaz do curso");
    const [anexo] = await db.select().from(e.anexo).where(eq(e.anexo.id, t!.arte_anexo_id!));
    expect(anexo!.categoria).toBe("TURMA_ARTE");
    expect(anexo!.mime_type).toBe("image/png");

    const visitante = novoCliente();
    // ainda não publicada: a arte não sai
    expect((await visitante.get(`/cursos/${codigo}/arte`)).status).toBe(404);
    expect((await _publicar(id)).status).toBe(303);
    const img = await visitante.get(`/cursos/${codigo}/arte`);
    expect(img.status).toBe(200);
    expect(img.cabecalho("content-type")).toBe("image/png");
    expect(img.cabecalho("x-content-type-options")).toBe("nosniff");
    expect(img.cabecalho("content-disposition")).toBe("inline");
    expect(img.cabecalho("cache-control")).toContain("max-age=86400");
    expect(img.text).not.toContain(SEGREDO);

    const ficha = await visitante.get(`/cursos/${codigo}`);
    expect(ficha.text).toContain(`/cursos/${codigo}/arte?v=${t!.arte_anexo_id}`);
    expect(ficha.text).toContain('alt="Cartaz do curso"');
    expect((await visitante.get("/cursos")).text).toContain(`/cursos/${codigo}/arte?v=`);

    expect((await cliente.post(`/turmas/${id}/vitrine/arte/remover`, {}, { seguir: false })).status).toBe(303);
    expect((await visitante.get(`/cursos/${codigo}/arte`)).status).toBe(404);
    expect((await visitante.get(`/cursos/${codigo}`)).text).not.toContain("/arte?v=");
    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    expect(depois!.arte_anexo_id).toBeNull();
    // o arquivo antigo continua guardado
    expect((await db.select().from(e.anexo).where(eq(e.anexo.id, t!.arte_anexo_id!))).length).toBe(1);
  });

  it("quem não tem turma.criar não envia arte", async () => {
    const id = await _turma();
    const servidor = await entrar(novoCliente(), "servidor_consulta");
    const arquivo = new File([_png() as unknown as ArrayBuffer], "x.png", { type: "image/png" });
    const r = await servidor.post(`/turmas/${id}/vitrine/arte`, { arte: arquivo, declaracao: "sim" }, { seguir: false });
    expect(r.status).toBe(403);
    expect((await db.select().from(e.turma).where(eq(e.turma.id, id)))[0]!.arte_anexo_id).toBeNull();
  });
});
