/**
 * NUVEM: modelo de certificado enviado pela tela — upload, leitura dos
 * marcadores (inclusive «texto livre» partido em vários runs do Word),
 * conversão, sugestão de campo, mapa salvo de uma vez, exemplo preenchido e a
 * emissão (com segunda via) a partir do arquivo no armazenamento.
 *
 * A fixture é o modelo real do setor:
 * `testes/fixtures/Modelo_Certificado_Brigadista_Organico_CSSO.docx`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import PizZip from "pizzip";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as anexos from "../src/servicos/anexos.js";
import * as backup from "../src/servicos/backup.js";
import { obterArmazenamento } from "../src/servicos/armazenamento.js";
import * as certificado from "../src/servicos/certificado.js";
import * as documento from "../src/servicos/documento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as envio from "../src/servicos/modelo_certificado_envio.js";
import * as servico_turma from "../src/servicos/turma.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const BRIGADISTA = new Uint8Array(
  readFileSync(path.join(aqui, "fixtures", "Modelo_Certificado_Brigadista_Organico_CSSO.docx")),
);

let amb: AmbienteDeTeste;
let db: Banco;
let cliente: Cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  await contas(db);
});

/** Um .docx mínimo com o corpo dado (parágrafos já em WordprocessingML). */
function docx_minimo(corpo: string): Uint8Array {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      corpo +
      "</w:body></w:document>",
  );
  return zip.generate({ type: "uint8array" });
}

const run = (t: string, negrito = false) =>
  `<w:r>${negrito ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const par = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;

function texto(bytes: Uint8Array): string {
  return documento.extrair_texto(bytes);
}

/** GET que devolve os bytes (o `Cliente` dos testes decodifica como texto). */
async function baixar(caminho: string): Promise<{ status: number; tipo: string; bytes: Uint8Array }> {
  const cab = new Headers();
  cab.set("cookie", [...cliente.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
  const res = await amb.app.fetch(new Request(new URL(caminho, "http://testserver"), { headers: cab }));
  return { status: res.status, tipo: res.headers.get("content-type") ?? "", bytes: new Uint8Array(await res.arrayBuffer()) };
}

function arquivo(bytes: Uint8Array, nome = "Modelo_Certificado_Brigadista_Organico_CSSO.docx"): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], nome, { type: envio.TIPO_DOCX });
}

async function enviar(nome = "Brigadista", bytes = BRIGADISTA, nome_arquivo?: string) {
  return cliente.post(
    "/treinamentos/modelos",
    { nome, orientacao: "PAISAGEM", arquivo: "", docx: arquivo(bytes, nome_arquivo) },
    { seguir: false },
  );
}

async function modelo_por_nome(nome: string) {
  const m = await db.query.certificado_modelo.findFirst({
    where: eq(e.certificado_modelo.nome, nome),
    with: { tags: { orderBy: (t, { asc: a }) => [a(t.ordem), a(t.id)] } },
  });
  return m!;
}

// =====================================================================
// Leitura e conversão
// =====================================================================
describe("leitura dos marcadores", () => {
  it("o modelo do Brigadista: cada «» vira um marcador, repetido ganha _2, _3 na ordem do documento", () => {
    const { marcadores, bytes } = envio.converter_docx_enviado(BRIGADISTA);
    const nomes = marcadores.map((m) => m.marcador);
    expect(nomes.slice(0, 4)).toEqual([
      "nome_completo_do_participante",
      "campo_000_000_000_00",
      "nome_do_a_responsavel_pela_formacao",
      "campo_000_000_000_00_2",
    ]);
    expect(nomes).toContain("dd_mm_aaaa");
    expect(nomes).toContain("dd_mm_aaaa_2");
    // textos diferentes com o mesmo nome («cidade» e «Cidade») também se separam
    expect(nomes.filter((n) => n.startsWith("cidade"))).toEqual(["cidade", "cidade_2"]);
    expect(nomes.filter((n) => /^aaaa(_\d)?$/.test(n))).toEqual(["aaaa", "aaaa_2", "aaaa_3"]);
    expect(new Set(nomes).size).toBe(nomes.length);
    // o rótulo original fica, para a tela
    const participante = marcadores.find((m) => m.marcador === "nome_completo_do_participante")!;
    expect(participante.rotulo).toBe("NOME COMPLETO DO PARTICIPANTE");
    // o trecho ao redor diz qual CPF é qual
    expect(marcadores.find((m) => m.marcador === "campo_000_000_000_00")!.antes).toContain("portador(a) do CPF");
    expect(marcadores.find((m) => m.marcador === "campo_000_000_000_00_2")!.antes).toContain("RESPONSÁVEL PELA FORMAÇÃO");
    expect(marcadores.find((m) => m.marcador === "dd_mm_aaaa")!.antes).toContain("período de");

    // o convertido não tem mais «» e tem um {nome} por marcador
    const corpo = new PizZip(bytes).file("word/document.xml")!.asText();
    expect(texto(bytes)).not.toMatch(/[«»]/);
    for (const n of nomes) expect(corpo).toContain(`{${n}}`);
  });

  it("junta o marcador que o Word partiu em vários runs, nos dois formatos", () => {
    const origem = docx_minimo(
      par(run("Certificamos que «NOME "), run("DO PARTI", true), run("CIPANTE» concluiu ")) +
        par(run("o curso {{ cur"), run("so }} em «cidade»."), run("{{curso}}")),
    );
    const { marcadores, bytes } = envio.converter_docx_enviado(origem);
    expect(marcadores.map((m) => [m.marcador, m.rotulo])).toEqual([
      ["nome_do_participante", "NOME DO PARTICIPANTE"],
      ["curso", "curso"],
      ["cidade", "cidade"],
    ]);
    expect(texto(bytes)).toContain("Certificamos que {nome_do_participante} concluiu");
  });

  it("o convertido renderiza: os valores entram e nenhuma chave sobra", async () => {
    const { marcadores, bytes } = envio.converter_docx_enviado(BRIGADISTA);
    const valores = Object.fromEntries(marcadores.map((m) => [m.marcador, `<${m.marcador}>`]));
    valores.nome_completo_do_participante = "Maria Aparecida de Souza";
    const saida = texto(await documento.renderizar_bytes(bytes, valores));
    expect(saida).toContain("Certificamos que:\nMaria Aparecida de Souza");
    expect(saida).toContain("Curso realizado no período de <dd_mm_aaaa> a <dd_mm_aaaa_2>.");
    expect(saida).not.toMatch(/[{}«»]/);
  });

  it("recusa o que não é .docx, o que não tem marcador e a chave solta", () => {
    expect(() => envio.converter_docx_enviado(new TextEncoder().encode("%PDF-1.7 não é zip"))).toThrow(envio.ModeloInvalido);
    const zip_qualquer = new PizZip();
    zip_qualquer.file("leia.txt", "oi");
    expect(() => envio.converter_docx_enviado(zip_qualquer.generate({ type: "uint8array" }))).toThrow(/documento do Word/);
    expect(() => envio.converter_docx_enviado(docx_minimo(par(run("Sem marcador nenhum."))))).toThrow(/nenhum marcador/);
    expect(() => envio.converter_docx_enviado(docx_minimo(par(run("«nome» e {solta}"))))).toThrow(/chave/);
    expect(() => envio.converter_docx_enviado(docx_minimo(par(run("{{ nome do aluno }}"))))).toThrow(/não é um nome válido/);
    expect(() => envio.converter_docx_enviado(docx_minimo(par(run("{% if x %}«a»{% endif %}"))))).toThrow(/\{%/);
    expect(() => envio.abrir_docx(new Uint8Array(envio.LIMITE_BYTES + 1))).toThrow(/limite/);
  });
});

// =====================================================================
// Sugestão
// =====================================================================
describe("sugestão de campo", () => {
  it("sugere pelo texto, pela ocorrência e pelo texto de antes", () => {
    const { marcadores } = envio.converter_docx_enviado(BRIGADISTA);
    const sugestao = Object.fromEntries(marcadores.map((m) => [m.marcador, certificado.sugerir_campo(m)]));
    expect(sugestao).toMatchObject({
      nome_completo_do_participante: "participante_nome",
      nome_do_a_responsavel_pela_formacao: "instrutor_nome",
      campo_000_000_000_00: "participante_cpf",
      campo_000_000_000_00_2: "instrutor_cpf",
      credenciamento_cbmmg_n_registro_crea_mg: "instrutor_registro",
      endereco_completo_do_local_do_curso: "turma_local",
      nome_do_campus: "turma_campus_curto",
      cidade: "turma_campus_cidade",
      cidade_2: "cidade",
      dd_mm_aaaa: "turma_data_inicio",
      dd_mm_aaaa_2: "turma_data_fim",
      dd: "certificado_dia",
      mes: "certificado_mes_extenso",
      aaaa: "certificado_ano",
      aaaa_3: "certificado_ano",
      n: "certificado_numero",
      n_2: "certificado_numero",
    });
    // «___ %»: nota final e frequência se separam pelo que vem antes
    const pct = marcadores.filter((m) => m.rotulo === "___ %").map((m) => sugestao[m.marcador]);
    expect(pct).toEqual(["nota_final_percentual", "frequencia_percentual"]);
    // o que não tem par no vocabulário fica sem sugestão, e não com um chute
    expect(sugestao["edificacao_ou_setor_para_o_qual_houve_a"]).toBeNull();
    expect(sugestao["campo"]).toBeNull();
  });

  it("campo novo no vocabulário ganha sugestão sem mexer nas regras", () => {
    // o vocabulário sem os campos de instrutor e de CPF, que já casariam sozinhos
    const base = Object.fromEntries(
      Object.entries(certificado.CAMPOS_CERTIFICADO).filter(([k]) => !k.startsWith("instrutor_") && !k.endsWith("_cpf")),
    );
    const m = { marcador: "matricula_no_conselho", rotulo: "Matrícula no conselho", antes: "", ocorrencia: 1 };
    expect(envio.sugerir_campo(m, base)).toBeNull();
    const com_novo = { ...base, instrutor_matricula_conselho: { rotulo: "Matrícula no conselho do instrutor" } };
    expect(envio.sugerir_campo(m, com_novo)).toBe("instrutor_matricula_conselho");
    // o CPF vai para o campo de CPF do participante quando o vocabulário tiver um
    const cpf = { marcador: "campo_000_000_000_00", rotulo: "000.000.000-00", antes: "portador(a) do CPF ", ocorrencia: 1 };
    expect(envio.sugerir_campo(cpf, base)).toBeNull();
    expect(envio.sugerir_campo(cpf, certificado.CAMPOS_CERTIFICADO)).toBe(
      "participante_cpf",
    );
  });

  it("modelo do repositório traz chave, link e QR da validação, já sugeridos", () => {
    const origem = readFileSync(path.join(aqui, "..", "modelos-docx", "origem", "Modelo_Certificado_Brigadista_Organico_CSSO.docx"));
    const { marcadores } = envio.converter_docx_enviado(new Uint8Array(origem));
    const sugestao = Object.fromEntries(marcadores.map((m) => [m.marcador, certificado.sugerir_campo(m)]));
    expect(sugestao["chave_de_validacao"]).toBe("certificado_chave");
    expect(sugestao["link_de_validacao"]).toBe("certificado_url_validacao");
    expect(sugestao["link_de_validacao_2"]).toBe("certificado_url_validacao");
    expect(sugestao["qr_code"]).toBe("certificado_qrcode");
    // «endereço completo do local do curso» continua sendo o local da turma
    expect(sugestao["endereco_completo_do_local_do_curso"]).toBe("turma_local");
    // «___ %» depois de "Nota final" é o aproveitamento: a nota de 0 a 10 vezes 10
    const pct = certificado.CAMPOS_CERTIFICADO.nota_final_percentual!.obter;
    expect(pct({ nota_final: "9.50" } as never)).toBe("95%");
    expect(pct({ nota_final: "8.33" } as never)).toBe("83,3%");
    expect(pct({ nota_final: null } as never)).toBe("");
  });
});

// =====================================================================
// A tela
// =====================================================================
describe("envio pela tela", () => {
  it("cadastra o modelo com o arquivo, grava o convertido e lista os marcadores com o trecho", async () => {
    await entrar(cliente, "coordenador_csso");
    const resposta = await enviar();
    expect(resposta.status).toBe(303);
    const modelo = await modelo_por_nome("Brigadista");
    expect(modelo.arquivo).toBe("Modelo_Certificado_Brigadista_Organico_CSSO.docx");
    expect(modelo.arquivo_sha256).toBe(anexos.digerir(BRIGADISTA));
    expect(modelo.arquivo_enviado!.marcadores.length).toBeGreaterThan(20);
    const chave = certificado.chave_do_modelo(modelo)!;
    expect(await obterArmazenamento().existe(chave)).toBe(true);
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "CERTIFICADO_MODELO_CRIADO"));
    expect(evento!.descricao).toContain("enviado pela tela");

    const ficha = (await cliente.get(`/treinamentos/modelos/${modelo.id}`)).text;
    expect(ficha).toContain("NOME COMPLETO DO PARTICIPANTE");
    expect(ficha).toContain("portador(a) do CPF");
    expect(ficha).toContain("falta escolher");
    expect(ficha).toContain("Aplicar sugestões");
    expect(ficha).toContain("(sugerido)");
    // nada de jargão de programador na tela de quem envia
    const lista = (await cliente.get("/treinamentos/modelos")).text;
    for (const tela of [ficha, lista]) {
      expect(tela).not.toContain("app/templates");
      expect(tela).not.toContain("converter-modelos");
    }
  });

  it("recusa arquivo que não é .docx, com a mensagem na tela e sem gravar", async () => {
    await entrar(cliente, "coordenador_csso");
    const pdf = await enviar("Errado", new TextEncoder().encode("%PDF-1.7"), "certificado.pdf");
    expect(pdf.text).toContain("Envie um arquivo .docx");
    const falso = await enviar("Falso", new TextEncoder().encode("não sou zip"), "certificado.docx");
    expect(falso.text).toContain("não é um documento do Word");
    expect(await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.nome, "Falso"))).toEqual([]);
  });

  it("aplicar sugestões, completar com 'deixar em branco' e conferir o exemplo", async () => {
    await entrar(cliente, "coordenador_csso");
    await enviar();
    let modelo = await modelo_por_nome("Brigadista");

    // antes de mapear, o exemplo mostra o que falta
    const cru = await baixar(`/treinamentos/modelos/${modelo.id}/exemplo`);
    expect(cru.status).toBe(200);
    expect(cru.tipo).toContain("wordprocessingml");
    expect(texto(cru.bytes)).toContain("[falta: NOME COMPLETO DO PARTICIPANTE]");

    const aplicado = await cliente.post(`/treinamentos/modelos/${modelo.id}/tags/sugeridas`, {}, { seguir: false });
    expect(aplicado.status).toBe(303);
    modelo = await modelo_por_nome("Brigadista");
    const mapa = Object.fromEntries(modelo.tags.map((t) => [t.marcador, t.campo]));
    expect(mapa.dd_mm_aaaa).toBe("turma_data_inicio");
    expect(mapa.dd_mm_aaaa_2).toBe("turma_data_fim");

    // o resto, de uma vez: "deixar em branco" (nunca bloqueia)
    const faltam = modelo.arquivo_enviado!.marcadores.filter((m) => !Object.hasOwn(mapa, m.marcador));
    expect(faltam.length).toBeGreaterThan(0);
    const campos: Record<string, string> = {};
    for (const m of faltam) {
      campos[`campo__${m.marcador}`] = "em_branco";
      campos[`obrigatorio__${m.marcador}`] = "1";
    }
    // e troca um já mapeado: a trilha registra a diferença
    campos["campo__cidade_2"] = "setor_emissor_sigla";
    campos["obrigatorio__cidade_2"] = "1";
    const salvo = await cliente.post(`/treinamentos/modelos/${modelo.id}/mapa`, campos, { seguir: false });
    expect(salvo.status).toBe(303);
    expect(decodeURIComponent(salvo.location!)).toContain("Todos os marcadores têm dado");
    modelo = await modelo_por_nome("Brigadista");
    expect(modelo.tags).toHaveLength(modelo.arquivo_enviado!.marcadores.length);
    expect(modelo.tags.filter((t) => t.campo === "em_branco").every((t) => !t.obrigatorio)).toBe(true);
    expect(modelo.tags.find((t) => t.marcador === "cidade_2")!.campo).toBe("setor_emissor_sigla");

    const ficha = (await cliente.get(`/treinamentos/modelos/${modelo.id}`)).text;
    expect(ficha).toContain("o mapa cobre o arquivo");

    const exemplo = await baixar(`/treinamentos/modelos/${modelo.id}/exemplo`);
    const t = texto(exemplo.bytes);
    expect(t).toContain("Maria Aparecida de Souza");
    expect(t).toContain("Curso realizado no período de 03/03/2026 a 05/03/2026.");
    expect(t).not.toContain("[falta:");
    expect(t).not.toMatch(/[{}«»]/);

    // esvaziar o seletor tira a ligação
    await cliente.post(`/treinamentos/modelos/${modelo.id}/mapa`, { campo__cidade_2: "" }, { seguir: false });
    modelo = await modelo_por_nome("Brigadista");
    expect(modelo.tags.find((t) => t.marcador === "cidade_2")).toBeUndefined();
  });

  it("o mapa aceita texto fixo, campo da turma e campo do participante", async () => {
    await entrar(cliente, "coordenador_csso");
    await enviar();
    let modelo = await modelo_por_nome("Brigadista");
    // a lacuna «___» propõe como nome o rótulo que vem antes dela no Word
    const antes_de_salvar = (await cliente.get(`/treinamentos/modelos/${modelo.id}`)).text;
    expect(antes_de_salvar).toContain('name="detalhe__campo" value="Prevenção e combate a incêndio"');
    expect(antes_de_salvar).toContain('name="detalhe__campo_2" value="Primeiros socorros"');
    // o menu diz "Instrutores": o endereço com esse nome leva à tela
    const instrutores = await cliente.get("/treinamentos/instrutores", { seguir: false });
    expect(instrutores.location).toBe("/treinamentos/assinaturas");
    const r = await cliente.post(
      `/treinamentos/modelos/${modelo.id}/mapa`,
      {
        campo__edificacao_ou_setor_para_o_qual_houve_a: "@TURMA",
        detalhe__edificacao_ou_setor_para_o_qual_houve_a: "Local de atuação do brigadista",
        obrigatorio__edificacao_ou_setor_para_o_qual_houve_a: "1",
        campo__campo: "@PARTICIPANTE",
        detalhe__campo: "Nota – Prevenção e combate a incêndio",
        campo__credenciamento_cbmmg_n_registro_crea_mg: "@TEXTO_FIXO",
        detalhe__credenciamento_cbmmg_n_registro_crea_mg: "Registro CREA-MG nº 12345",
      },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    modelo = await modelo_por_nome("Brigadista");
    const por = Object.fromEntries(modelo.tags.map((t) => [t.marcador, t]));
    const local = por["edificacao_ou_setor_para_o_qual_houve_a"]!;
    expect([local.tipo, local.rotulo, local.obrigatorio]).toEqual(["TURMA", "Local de atuação do brigadista", true]);
    expect([por["campo"]!.tipo, por["campo"]!.rotulo]).toEqual(["PARTICIPANTE", "Nota – Prevenção e combate a incêndio"]);
    const fixo = por["credenciamento_cbmmg_n_registro_crea_mg"]!;
    expect([fixo.tipo, fixo.texto_fixo]).toEqual(["TEXTO_FIXO", "Registro CREA-MG nº 12345"]);
    // a ficha mostra a escolha gravada no seletor
    expect((await cliente.get(`/treinamentos/modelos/${modelo.id}`)).text).toContain('value="@TURMA" selected');
    // o exemplo mostra o texto fixo e o nome do campo, não "[falta: ...]"
    const ex = texto((await baixar(`/treinamentos/modelos/${modelo.id}/exemplo`)).bytes);
    expect(ex).toContain("Local de atuação do brigadista: [Local de atuação do brigadista], Campus");
    expect(ex).toContain("Prevenção e combate a incêndio: [Nota – Prevenção e combate a incêndio]");
    expect(ex).toContain("Registro CREA-MG nº 12345");

    // sem o nome do campo, recusa sem gravar
    const sem_nome = await cliente.post(`/treinamentos/modelos/${modelo.id}/mapa`, {
      campo__campo_2: "@PARTICIPANTE",
      detalhe__campo_2: "",
    });
    expect(sem_nome.text).toContain("Dê um nome ao campo");
  });

  it("campo fora do vocabulário é recusado sem salvar meio mapa", async () => {
    await entrar(cliente, "coordenador_csso");
    await enviar();
    const modelo = await modelo_por_nome("Brigadista");
    const r = await cliente.post(`/treinamentos/modelos/${modelo.id}/mapa`, {
      campo__nome_completo_do_participante: "participante_nome",
      campo__cidade: "cpf_inventado",
    });
    expect(r.text).toContain("Campo desconhecido");
    expect((await modelo_por_nome("Brigadista")).tags).toEqual([]);
  });

  it("versão nova com outro arquivo leva só o mapa dos marcadores que ele ainda tem", async () => {
    await entrar(cliente, "coordenador_csso");
    await enviar();
    const v1 = await modelo_por_nome("Brigadista");
    await cliente.post(`/treinamentos/modelos/${v1.id}/tags/sugeridas`, {}, { seguir: false });
    const novo = docx_minimo(par(run("Certificamos que «NOME COMPLETO DO PARTICIPANTE» esteve em «Cidade»")));
    const r = await cliente.post(
      `/treinamentos/modelos/${v1.id}/versao`,
      { docx: arquivo(novo, "brigadista_v2.docx") },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [v2] = await db
      .select()
      .from(e.certificado_modelo)
      .where(eq(e.certificado_modelo.versao, 2));
    expect(v2!.arquivo).toBe("brigadista_v2.docx");
    const tags = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.modelo_id, v2!.id));
    expect(tags.map((t) => t.marcador).sort()).toEqual(["cidade", "nome_completo_do_participante"]);
  });
});

// =====================================================================
// Emissão a partir do arquivo enviado
// =====================================================================
describe("emissão com o modelo enviado", () => {
  it("emite do armazenamento, congela a chave do arquivo e a segunda via confere", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const preparado = envio.preparar_envio(BRIGADISTA);
    await obterArmazenamento().gravar(
      envio.chave_no_armazenamento(preparado.enviado.sha256_convertido),
      preparado.convertido,
    );
    const [modelo] = await db
      .insert(e.certificado_modelo)
      .values({
        treinamento_id: cen.treinamento.id,
        nome: "Brigadista enviado",
        arquivo: "brigadista.docx",
        arquivo_sha256: preparado.sha256_origem,
        arquivo_enviado: preparado.enviado,
      })
      .returning();
    let ordem = 0;
    for (const m of preparado.enviado.marcadores) {
      const campo = certificado.sugerir_campo(m) ?? "em_branco";
      await db.insert(e.certificado_modelo_tag).values({
        modelo_id: modelo!.id,
        marcador: m.marcador,
        campo,
        ordem: ++ordem,
        obrigatorio: campo === "participante_nome",
      });
    }
    await db.update(e.treinamento).set({ modelo_vigente_id: modelo!.id }).where(eq(e.treinamento.id, cen.treinamento.id));
    // relê: a turma carregada no cenário ainda aponta o modelo de antes
    const turma = (await servico_turma.carregar_turma(db, cen.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id, turma))!;

    const emitido = await servico.emitir(db, usuario, inscricao, { gerar_pdf: false });
    const t = texto(emitido.bytes);
    expect(t).toContain("Marco Antônio Alves Schetino");
    expect(t).toContain("Formação do Curso de Brigadista");
    expect(t).not.toMatch(/[{}«»]/);
    const congelado = emitido.certificado.contexto_congelado as Record<string, unknown>;
    expect(congelado.modelo_chave).toBe(envio.chave_no_armazenamento(preparado.enviado.sha256_convertido));
    expect(emitido.certificado.modelo_sha256).toBe(preparado.sha256_origem);

    const segunda = await servico.segunda_via(db, usuario, emitido.certificado);
    expect(segunda.confere).toBe(true);
    expect(servico.do_modelo_enviado(emitido.certificado)).toBe(true);

    // o papel é o Word: o PDF da casa não tem o layout nem os campos dele
    await entrar(cliente, "coordenador_csso");
    const pdf = await cliente.get(`/certificados/${emitido.certificado.id}/pdf`, { seguir: false });
    expect([pdf.status, pdf.location]).toEqual([303, `/certificados/${emitido.certificado.id}/documento`]);
    const ficha = (await cliente.get(`/certificados/${emitido.certificado.id}`)).text;
    expect(ficha).toContain("Baixar Word (.docx)");
    expect(ficha).not.toContain(`/certificados/${emitido.certificado.id}/pdf"`);
    const aba = (await cliente.get(`/turmas/${turma.id}?aba=emissao`)).text;
    expect(aba).toContain(`/turmas/${turma.id}/certificados.zip`);
    expect(aba).not.toContain(`/turmas/${turma.id}/certificados.pdf`);
    const lote = await baixar(`/turmas/${turma.id}/certificados.zip`);
    expect([lote.status, lote.tipo]).toEqual([200, "application/zip"]);
    const dentro = new PizZip(lote.bytes);
    const nomes = Object.keys(dentro.files);
    expect(nomes).toHaveLength(1);
    expect(texto(dentro.file(nomes[0]!)!.asUint8Array())).toContain("Marco Antônio Alves Schetino");

    // o arquivo do modelo vai no backup, junto com os anexos
    const feito = await backup.fazer_backup(db, { senha: "senha-do-teste" });
    const aberto = backup.restaurar(await obterArmazenamento().ler(feito.chave), "senha-do-teste");
    expect(aberto.arquivos.has(certificado.chave_do_modelo(modelo!)!)).toBe(true);
  });
});
