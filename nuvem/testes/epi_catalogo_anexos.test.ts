/**
 * Fatia C da paridade de EPI com o IntegraSST: a foto e o PDF de orientação do
 * item do catálogo, e o PDF congelado na ficha (Decisão 4).
 *
 * O que protegem: o tipo é o dos BYTES (não o nome nem o mime declarado); há
 * tamanho máximo; UM arquivo por requisição (a foto em `/imagem`, o PDF em
 * `/orientacao`, para nenhum corpo passar dos 6 MB do Netlify), e mandar os
 * dois juntos é recusado; a edição do item é formulário comum, sem arquivo;
 * formulário sem arquivo novo mantém o atual; envio só com
 * `epi.catalogo`; leitura só para quem usa o módulo; e a ficha antiga continua
 * no PDF do dia da entrega mesmo depois de o catálogo trocar o arquivo.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import {
  EPI_CATALOGO_IMAGEM_MAX_BYTES,
  EPI_CATALOGO_PDF_MAX_BYTES,
  ENTIDADE_ANEXO_EPI_ITEM,
} from "../src/dominio/epi.js";
import { bancoLimpo, contas, criarUsuario, entrar, PERFIS_DE_TESTE, usuarioAtual, type Cliente } from "./ajuda";
import { bancoPorTeste, cenario as montar, entregar, recado, registros, type Cenario } from "./ajuda_epi_ficha";

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(nome = "foto.png", extra = "imagem", tipo = "image/png"): File {
  return new File([new Uint8Array([...PNG, ...new TextEncoder().encode(extra)])], nome, { type: tipo });
}
function pdf(texto: string, nome = "orientacao.pdf"): File {
  return new File([new TextEncoder().encode(`%PDF-1.4 ${texto}`)], nome, { type: "application/pdf" });
}

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

async function item(c: Cenario) {
  const [i] = await db.select().from(e.epi_item).where(eq(e.epi_item.id, c.item));
  return i!;
}

async function anexos_do_catalogo() {
  return db.select().from(e.anexo).where(eq(e.anexo.entidade, ENTIDADE_ANEXO_EPI_ITEM)).orderBy(asc(e.anexo.id));
}

/** Um envio por arquivo: a foto vai para `/imagem`, o PDF para `/orientacao`. */
function enviar_foto(cli: Cliente, c: Cenario, foto: File, extra: Record<string, File> = {}) {
  return cli.post(`/epis/catalogo/${c.item}/imagem`, { imagem: foto, ...extra }, { seguir: false, multipart: true });
}
function enviar_pdf(cli: Cliente, c: Cenario, arquivo: File, extra: Record<string, File> = {}) {
  return cli.post(`/epis/catalogo/${c.item}/orientacao`, { orientacao: arquivo, ...extra }, { seguir: false, multipart: true });
}
/** Os dois, cada um na sua requisição (como a tela manda). */
async function enviar_os_dois(cli: Cliente, c: Cenario, foto: File, arquivo: File) {
  expect((await enviar_foto(cli, c, foto)).status).toBe(303);
  expect((await enviar_pdf(cli, c, arquivo)).status).toBe(303);
}

/** Os campos de texto da edição do item, como estão no banco. */
function campos_da_edicao(i: typeof e.epi_item.$inferSelect): Record<string, string> {
  return {
    nome: i.nome,
    categoria_id: String(i.categoria_id),
    unidade_medida: i.unidade_medida,
    exige_ca: "1",
    numero_ca: i.numero_ca!,
    validade_ca: i.validade_ca!,
    quantidade_padrao: String(i.quantidade_padrao),
    modelo: i.modelo!,
    descricao: i.descricao ?? "",
    ativo: "1",
  };
}

/** A mensagem do banco: o Drizzle embrulha o erro do Postgres em `cause`. */
async function recusa_do_banco(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (erro) {
    const x = erro as Error & { cause?: Error };
    return `${x.message} ${x.cause?.message ?? ""}`;
  }
  return "(o banco aceitou)";
}

describe("conferência do arquivo", () => {
  it("PDF com bytes de PNG é recusado, e nada é gravado", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const r = await enviar_pdf(cli, c, png("manual.pdf", "x", "application/pdf"));
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("não é um PDF");
    expect((await item(c)).orientacao_anexo_id).toBeNull();
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("imagem com bytes de texto é recusada, e nada é gravado", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const texto = new File([new TextEncoder().encode("<svg onload=alert(1)>")], "foto.jpg", { type: "image/jpeg" });
    const r = await enviar_foto(cli, c, texto);
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("não é uma imagem JPEG, PNG ou WEBP");
    expect((await item(c)).imagem_anexo_id).toBeNull();
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("foto acima do tamanho é recusada", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const grande = new Uint8Array(EPI_CATALOGO_IMAGEM_MAX_BYTES + 1);
    grande.set(PNG);
    const r = await enviar_foto(cli, c, new File([grande], "grande.png", { type: "image/png" }));
    expect(recado(r)).toContain("o limite é 2,0 MB");
    expect((await item(c)).imagem_anexo_id).toBeNull();
  });

  it("PDF acima do tamanho é recusado", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const grande = new Uint8Array(EPI_CATALOGO_PDF_MAX_BYTES + 1);
    grande.set(new TextEncoder().encode("%PDF-1.4"));
    const r = await enviar_pdf(cli, c, new File([grande], "grande.pdf", { type: "application/pdf" }));
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("o limite é 4,0 MB");
    expect((await item(c)).orientacao_anexo_id).toBeNull();
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("WEBP e PNG de verdade entram, com o tipo dos bytes e categoria EPI_CATALOGO", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    // o navegador disse octet-stream; o que vale é o conteúdo
    const webp = new File(
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50])],
      "foto.webp",
      { type: "application/octet-stream" },
    );
    const r = await enviar_foto(cli, c, webp);
    expect(recado(r)).toContain("Foto de");
    expect(recado(r)).toContain("gravado");
    // a volta reabre o popup “Foto e orientação” do item
    expect(r.cabecalho("location")).toContain(`arquivos=${c.item}`);
    const r2 = await enviar_pdf(cli, c, pdf("v1"));
    expect(recado(r2)).toContain("PDF de orientação de");
    const i = await item(c);
    const [foto, manual] = await anexos_do_catalogo();
    expect(i.imagem_anexo_id).toBe(foto!.id);
    expect(i.orientacao_anexo_id).toBe(manual!.id);
    expect(foto!.mime_type).toBe("image/webp");
    expect(foto!.categoria).toBe("EPI_CATALOGO");
    expect(manual!.mime_type).toBe("application/pdf");
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "epi_item"));
    expect(eventos.map((x) => x.tipo_evento)).toEqual(
      expect.arrayContaining(["EPI_ITEM_IMAGEM_ENVIADA", "EPI_ITEM_ORIENTACAO_ENVIADA"]),
    );
  });
});

describe("um arquivo por envio", () => {
  it("cada envio aceita o seu arquivo, e só ele", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    await enviar_foto(cli, c, png());
    let i = await item(c);
    expect(i.imagem_anexo_id).not.toBeNull();
    expect(i.orientacao_anexo_id).toBeNull();
    await enviar_pdf(cli, c, pdf("v1"));
    i = await item(c);
    expect(i.orientacao_anexo_id).not.toBeNull();
    expect(await anexos_do_catalogo()).toHaveLength(2);
  });

  it("a foto e o PDF na MESMA requisição são recusados, nos dois endereços, sem gravar nada", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const r1 = await enviar_foto(cli, c, png(), { orientacao: pdf("junto") });
    expect(r1.status).toBe(303);
    expect(recado(r1)).toContain("Envie um arquivo por vez");
    const r2 = await enviar_pdf(cli, c, pdf("junto"), { imagem: png() });
    expect(r2.status).toBe(303);
    expect(recado(r2)).toContain("Envie um arquivo por vez");
    const i = await item(c);
    expect(i.imagem_anexo_id).toBeNull();
    expect(i.orientacao_anexo_id).toBeNull();
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("o campo errado no endereço certo não grava (o PDF no envio da foto)", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const r = await cli.post(`/epis/catalogo/${c.item}/imagem`, { orientacao: pdf("x") }, { seguir: false, multipart: true });
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("Envie um arquivo por vez");
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("a rota antiga dos dois juntos (/anexos) não existe mais", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const r = await cli.post(`/epis/catalogo/${c.item}/anexos`, { imagem: png() }, { seguir: false, multipart: true });
    expect(r.status).toBe(404);
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });

  it("a tela traz dois formulários multipart separados, e a edição sem multipart", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const t = (await cli.get("/epis/catalogo")).text;
    expect(t).toContain(`action="/epis/catalogo/${c.item}/imagem" enctype="multipart/form-data"`);
    expect(t).toContain(`action="/epis/catalogo/${c.item}/orientacao" enctype="multipart/form-data"`);
    expect(t).toContain("Enviar foto");
    expect(t).toContain("Enviar PDF de orientação");
    expect(t).toContain("tem direito autoral");
    // o popup de edição: formulário comum, sem campo de arquivo
    const edicao = t.slice(t.indexOf(`id="editar-epi-${c.item}"`));
    const form = edicao.slice(0, edicao.indexOf("</form>"));
    expect(form).toContain(`action="/epis/catalogo/${c.item}"`);
    expect(form).not.toContain("multipart");
    expect(form).not.toContain('type="file"');
    // a volta do envio reabre o popup dos arquivos, e não o de edição
    await enviar_foto(cli, c, png());
    const volta = (await cli.get(`/epis/catalogo?arquivos=${c.item}&mensagem=ok`)).text;
    expect(volta).toMatch(new RegExp(`id="arq-epi-${c.item}"\\s+aria-labelledby="arq-epi-${c.item}-titulo" open`));
    expect(volta).not.toMatch(new RegExp(`id="editar-epi-${c.item}" aria-labelledby="editar-epi-${c.item}-titulo" open`));
    expect(volta).toContain('class="epi-foto-atual"');
  });
});

describe("troca e manutenção do atual", () => {
  it("envio sem arquivo mantém o atual; trocar não apaga o antigo", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    await enviar_foto(cli, c, png("a.png", "primeira"));
    const antes = (await item(c)).imagem_anexo_id;
    expect(antes).not.toBeNull();

    // os envios vazios
    const vazio = await cli.post(`/epis/catalogo/${c.item}/imagem`, {}, { seguir: false, multipart: true });
    expect(recado(vazio)).toContain("a foto atual continua");
    const vazio_pdf = await cli.post(`/epis/catalogo/${c.item}/orientacao`, {}, { seguir: false, multipart: true });
    expect(recado(vazio_pdf)).toContain("o PDF de orientação atual continua");
    expect((await item(c)).imagem_anexo_id).toBe(antes);

    // trocar: ponteiro novo, o antigo continua guardado
    const r = await enviar_foto(cli, c, png("b.png", "segunda"));
    expect(recado(r)).toContain("O arquivo anterior continua guardado");
    const novo = (await item(c)).imagem_anexo_id;
    expect(novo).not.toBe(antes);
    const ids = (await anexos_do_catalogo()).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([antes, novo]));
  });

  it("a edição comum (sem multipart) grava e não mexe na foto nem no PDF", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    await enviar_os_dois(cli, c, png(), pdf("v1"));
    const antes = await item(c);
    const ed = await cli.post(
      `/epis/catalogo/${c.item}`,
      { ...campos_da_edicao(antes), descricao: "descrição nova" },
      { seguir: false },
    );
    expect(ed.status).toBe(303);
    const depois = await item(c);
    expect(depois.descricao).toBe("descrição nova");
    expect(depois.imagem_anexo_id).toBe(antes.imagem_anexo_id);
    expect(depois.orientacao_anexo_id).toBe(antes.orientacao_anexo_id);
  });

  it("a edição com arquivo é recusada: nada grava e o popup volta com o digitado", async () => {
    const c = await montar(db);
    const cli = await como("tecnico_seguranca");
    const antes = await item(c);
    const ed = await cli.post(
      `/epis/catalogo/${c.item}`,
      { ...campos_da_edicao(antes), descricao: "não grava", imagem: png() },
      { seguir: false },
    );
    expect(ed.status).toBe(200);
    expect(ed.text).toContain("A edição do item não recebe arquivo");
    expect(ed.text).toContain("não grava");
    const fim = await item(c);
    expect(fim.imagem_anexo_id).toBeNull();
    expect(fim.descricao).toBe(antes.descricao);
    expect(await anexos_do_catalogo()).toHaveLength(0);
  });
});

describe("permissões", () => {
  it("quem não tem epi.catalogo recebe 403 no envio", async () => {
    const c = await montar(db);
    const u = await usuarioAtual(db, "almoxarife_sesmt");
    expect(u.pode("epi.catalogo")).toBe(false);
    const cli = await como("almoxarife_sesmt");
    const r = await enviar_foto(cli, c, png());
    expect(r.status).toBe(403);
    expect((await enviar_pdf(cli, c, pdf("v1"))).status).toBe(403);
    expect((await item(c)).imagem_anexo_id).toBeNull();
  });

  it("quem não usa o módulo de EPI recebe 403 na leitura; quem usa lê com cabeçalhos seguros", async () => {
    const c = await montar(db);
    await enviar_os_dois(await como("tecnico_seguranca"), c, png(), pdf("v1"));

    // uma conta sem epi.ver, sem epi.requisitar e sem ficha
    let alheio: string | null = null;
    for (const [login] of PERFIS_DE_TESTE) {
      const u = await usuarioAtual(db, login);
      if (!u.pode("epi.ver") && !u.pode("epi.requisitar") && u.servidor_id === null) alheio = login;
    }
    if (!alheio) {
      await criarUsuario(db, { login: "sem_epi", perfis: [] });
      alheio = "sem_epi";
    }
    const fora = await como(alheio);
    expect((await fora.get(`/epis/catalogo/${c.item}/imagem`)).status).toBe(403);
    expect((await fora.get(`/epis/catalogo/${c.item}/orientacao`)).status).toBe(403);

    const dentro = await como("almoxarife_sesmt");
    const foto = await dentro.get(`/epis/catalogo/${c.item}/imagem`);
    expect(foto.status).toBe(200);
    expect(foto.cabecalho("content-type")).toBe("image/png");
    expect(foto.cabecalho("x-content-type-options")).toBe("nosniff");
    const manual = await dentro.get(`/epis/catalogo/${c.item}/orientacao`);
    expect(manual.status).toBe(200);
    expect(manual.cabecalho("content-type")).toBe("application/pdf");
    expect(manual.cabecalho("content-disposition")).toContain("attachment");
    expect(manual.text).toContain("%PDF-1.4 v1");
  });

  it("o titular (conta ligada a servidor, sem perfil) lê a foto e o PDF congelado da própria ficha", async () => {
    const c = await montar(db);
    const tec = await como("tecnico_seguranca");
    await enviar_os_dois(tec, c, png(), pdf("v1"));
    await entregar(tec, c);
    await criarUsuario(db, { login: "titular_sem_perfil", perfis: [], servidor_id: c.servidor });
    const titular = await como("titular_sem_perfil");
    expect((await titular.get(`/epis/catalogo/${c.item}/imagem`)).status).toBe(200);
    const [registro] = await registros(db);
    const congelado = await titular.get(`/epis/fichas/registros/${registro!.id}/orientacao`);
    expect(congelado.status).toBe(200);
    expect(congelado.text).toContain("%PDF-1.4 v1");
    // e a ficha de OUTRA pessoa não abre
    await criarUsuario(db, { login: "outro_titular", perfis: [] });
    const [outro] = await db
      .insert(e.servidor)
      .values({ siape: "1112223", nome: "Outra Pessoa", cargo_id: null, unidade_uorg_id: null })
      .returning();
    await db.update(e.usuario).set({ servidor_id: outro!.id }).where(eq(e.usuario.login, "outro_titular"));
    const alheio = await (await como("outro_titular")).get(`/epis/fichas/registros/${registro!.id}/orientacao`, {
      seguir: false,
    });
    expect(alheio.status).toBe(303);
    expect(recado(alheio)).toContain("Não há PDF de orientação");
  });
});

describe("o PDF congelado na ficha (Decisão 4)", () => {
  it("trocar o PDF não muda a ficha antiga; a entrega nova aponta para o novo", async () => {
    const c = await montar(db);
    const tec = await como("tecnico_seguranca");
    await enviar_pdf(tec, c, pdf("versão 1"));
    const v1 = (await item(c)).orientacao_anexo_id!;
    const r1 = await entregar(tec, c);
    expect(r1.status).toBe(303);

    await enviar_pdf(tec, c, pdf("versão 2"));
    const v2 = (await item(c)).orientacao_anexo_id!;
    expect(v2).not.toBe(v1);
    await entregar(tec, c);

    const [antiga, nova] = await registros(db);
    expect(antiga!.orientacao_anexo_id).toBe(v1);
    expect(nova!.orientacao_anexo_id).toBe(v2);

    // a rota da ficha serve o congelado, não o vigente
    const baixado = await tec.get(`/epis/fichas/registros/${antiga!.id}/orientacao`);
    expect(baixado.status).toBe(200);
    expect(baixado.text).toContain("versão 1");
    expect((await tec.get(`/epis/fichas/registros/${nova!.id}/orientacao`)).text).toContain("versão 2");

    // e a ficha mostra o link de cada linha
    const ficha = await tec.get(`/epis/fichas/${c.servidor}`);
    expect(ficha.text).toContain(`/epis/fichas/registros/${antiga!.id}/orientacao`);
    expect(ficha.text).toContain(`/epis/fichas/registros/${nova!.id}/orientacao`);
  });

  it("a ficha conferida continua sem divergência com o PDF congelado", async () => {
    const c = await montar(db);
    const tec = await como("tecnico_seguranca");
    await enviar_pdf(tec, c, pdf("v1"));
    await entregar(tec, c);
    const { conferir } = await import("../src/servicos/epi_ficha.js");
    expect(await conferir(db, c.servidor)).toEqual([]);
  });

  it("a trava recusa UPDATE de orientacao_anexo_id", async () => {
    const c = await montar(db);
    const tec = await como("tecnico_seguranca");
    await enviar_pdf(tec, c, pdf("v1"));
    await entregar(tec, c);
    await enviar_pdf(tec, c, pdf("v2"));
    const v2 = (await item(c)).orientacao_anexo_id!;
    const [registro] = await registros(db);
    const msg = await recusa_do_banco(
      db.update(e.epi_ficha_registro).set({ orientacao_anexo_id: v2 }).where(eq(e.epi_ficha_registro.id, registro!.id)),
    );
    expect(msg).not.toBe("(o banco aceitou)");
    const [mesmo] = await registros(db);
    expect(mesmo!.orientacao_anexo_id).not.toBe(v2);
  });
});
