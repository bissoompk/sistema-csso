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
import { COM_TURMA, type TurmaCarregada } from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda";

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

describe("a vitrine para fora dela", () => {
  it("a tela de entrada aponta para a vitrine", async () => {
    const r = await novoCliente().get("/login");
    expect(r.text).toContain('href="/cursos"');
  });

  it("a ficha tem Open Graph (com a arte como imagem, quando há) e a lista aponta para o feed", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    expect((await _publicar(id)).status).toBe(303);
    const v = novoCliente();
    const ficha = (await v.get(`/cursos/${codigo}`)).text;
    expect(ficha).toContain('property="og:title" content="Trabalho em Altura');
    expect(ficha).toContain(`property="og:url" content="http://127.0.0.1:8766/cursos/${codigo}"`);
    expect(ficha).toContain('name="twitter:card" content="summary"');
    expect(ficha).not.toContain("og:image");
    const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    const [a] = await db
      .insert(e.anexo)
      .values({ entidade: "turma", entidade_id: id, nome_arquivo: "a.png", nome_original: "a.png", mime_type: "image/png", tamanho_bytes: 10, sha256: "a".repeat(64), storage_key: "x", categoria: "TURMA_ARTE" } as never)
      .returning();
    await db.update(e.turma).set({ arte_anexo_id: a!.id }).where(eq(e.turma.id, t!.id));
    const com_arte = (await v.get(`/cursos/${codigo}`)).text;
    expect(com_arte).toContain(`property="og:image" content="http://127.0.0.1:8766/cursos/${codigo}/arte?v=${a!.id}"`);
    expect(com_arte).toContain("summary_large_image");
    const lista = (await v.get("/cursos")).text;
    expect(lista).toContain('href="/cursos.json"');
    expect(lista).toContain('property="og:title" content="Cursos da SISA');
  });

  it("o feed /cursos.json traz só o aberto e o que vem em breve, sem dado pessoal, para qualquer origem", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    expect((await novoCliente().get("/cursos.json")).json().cursos).toEqual([]);
    expect((await _publicar(id)).status).toBe(303);
    const r = await novoCliente().get("/cursos.json");
    expect(r.status).toBe(200);
    expect(r.cabecalho("content-type")).toContain("application/json");
    expect(r.cabecalho("access-control-allow-origin")).toBe("*");
    const corpo = r.json<{ cursos: Record<string, unknown>[] }>();
    expect(corpo.cursos).toHaveLength(1);
    expect(corpo.cursos[0]).toMatchObject({ codigo, situacao: "abertas", url: `http://127.0.0.1:8766/cursos/${codigo}`, vagas_restantes: 10 });
    expect(Object.keys(corpo.cursos[0]!)).not.toContain("instrutor");
    expect(JSON.stringify(corpo)).not.toMatch(/@|siape/i);
    // encerrada some do feed
    await db.update(e.turma).set({ situacao: "CONCLUIDA", data_inicio: somar_dias(hoje_iso(), -3), data_fim: somar_dias(hoje_iso(), -2), ano: Number(somar_dias(hoje_iso(), -3).slice(0, 4)) }).where(eq(e.turma.id, id));
    expect((await novoCliente().get("/cursos.json")).json().cursos).toEqual([]);
  });

  it("o contador de capacitados só aparece com 5 aprovados ou mais, e é só o número", async () => {
    const id = await _turma();
    const codigo = await _codigo(id);
    expect((await _publicar(id)).status).toBe(303);
    await db.update(e.turma).set({ situacao: "CONCLUIDA", data_inicio: somar_dias(hoje_iso(), -3), data_fim: somar_dias(hoje_iso(), -2), ano: Number(somar_dias(hoje_iso(), -3).slice(0, 4)), inscricao_aberta_ate: null }).where(eq(e.turma.id, id));
    const alfabeto = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    const inscrever = async (n: number) => {
      const [p] = await db.insert(e.participante).values({ nome: `Pessoa ${n}`, vinculo: "VISITANTE", identificador_publico: `PTC-${alfabeto[n]!.repeat(8)}` } as never).returning();
      await db.insert(e.inscricao).values({ turma_id: id, participante_id: p!.id, situacao: "APROVADO", origem: "INTERNA" } as never);
    };
    for (let i = 0; i < 4; i++) await inscrever(i);
    const v = novoCliente();
    expect((await v.get("/cursos?aba=realizados")).text).not.toContain("pessoas foram capacitadas");
    await inscrever(4);
    const pagina = (await v.get("/cursos?aba=realizados")).text;
    expect(pagina).toContain("<strong>5</strong> pessoas foram capacitadas");
    expect(pagina).not.toContain("Pessoa 1");
    expect(codigo).toMatch(/^TUR-/);
  });

  it("a inscrição pública mostra vagas, validade do certificado e conteúdo, sem o CSSO fixo", async () => {
    const id = await _turma();
    const [antes] = await db.select().from(e.turma).where(eq(e.turma.id, id));
    await db.update(e.treinamento).set({ conteudo_programatico: "Teoria básica\nPrática supervisionada" }).where(eq(e.treinamento.id, antes!.treinamento_id));
    const turma = (await db.query.turma.findFirst({ where: eq(e.turma.id, id), with: COM_TURMA as never })) as unknown as TurmaCarregada;
    const token = await inscricao_publica.gerar_link(db, await usuarioAtual(db, "coordenador_csso"), turma);
    const pagina = (await novoCliente().get(`/inscricao/${token}`)).text;
    expect(pagina).toContain("10 vagas restantes");
    expect(pagina).toContain("Vale 24 meses");
    expect(pagina).toContain("Teoria básica");
    expect(pagina).toContain("Prática supervisionada");
    // o texto visível (fora de <script>, <style> e atributos) não tem a sigla fixa
    const visivel = pagina.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]*>/g, " ");
    // (o aviso de configuração do ambiente de teste cita CSSO_CHAVE_SECRETA: variável, não rótulo)
    expect(visivel.match(/[\s\S]{0,40}\bCSSO\b(?!_)[\s\S]{0,40}/g) ?? [], "ocorrências de CSSO no texto visível").toEqual([]);
  });

  it("a equipe revê o link no ar (mesmo token), com trilha; sem sal ou desligado, não", async () => {
    const id = await _turma();
    const carregar = async () =>
      (await db.query.turma.findFirst({ where: eq(e.turma.id, id), with: COM_TURMA as never })) as unknown as TurmaCarregada;
    const coord = await usuarioAtual(db, "coordenador_csso");
    const token = await inscricao_publica.gerar_link(db, coord, await carregar());
    expect(await inscricao_publica.ver_link(db, coord, await carregar())).toBe(token);
    expect((await novoCliente().get(`/inscricao/${token}`)).status).toBe(200);
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "INSCRICAO_LINK_VISTO"));
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha)).not.toContain(token);
    // trocar o link troca o token revisto
    const novo = await inscricao_publica.gerar_link(db, coord, await carregar());
    expect(novo).not.toBe(token);
    expect(await inscricao_publica.ver_link(db, coord, await carregar())).toBe(novo);
    // link de antes do sal: só gerando de novo
    await db.update(e.turma).set({ inscricao_token_sal: null }).where(eq(e.turma.id, id));
    expect(await inscricao_publica.ver_link(db, coord, await carregar())).toBeNull();
    // desligado: nada a rever
    await inscricao_publica.gerar_link(db, coord, await carregar());
    await inscricao_publica.desligar_link(db, coord, await carregar());
    expect(await inscricao_publica.ver_link(db, coord, await carregar())).toBeNull();
  });
});
