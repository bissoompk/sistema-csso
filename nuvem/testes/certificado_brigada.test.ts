/**
 * Lote 4 (25/11/2026): a brigada orgânica do CBMMG (Portaria nº 54/2020, art. 40, 42 § 3º, 43 II e
 * Anexo I) — disciplinas com nota de 0 a 100, média simples, os bloqueios da emissão e o modelo
 * "Brigada CBMMG v1", frente e verso, com o .docx e o PDF dizendo o mesmo texto.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-brigada-"));

import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as brigada from "../src/dominio/brigada.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as centro_formacao from "../src/servicos/centro_formacao.js";
import { ContextoCertificado, MODELO_BRIGADA_NOME } from "../src/servicos/certificado.js";
import * as certificado_pdf from "../src/servicos/certificado_pdf.js";
import * as cpf_certificado from "../src/servicos/cpf_certificado.js";
import * as disciplinas from "../src/servicos/disciplinas.js";
import * as documento from "../src/servicos/documento.js";
import * as envio_certificado from "../src/servicos/envio_certificado.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import { criar_modelo_brigada } from "../src/servicos/sementes.js";
import * as servico_turma from "../src/servicos/turma.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, type Cliente } from "./ajuda.js";
import { INICIO, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

// CPFs e CNPJ de exemplo com dígito verificador válido (não são de ninguém)
const CPF_ALUNO = "52998224725";
const CPF_INSTRUTOR = "11144477735";
const CNPJ = "11222333000181";

const espacos = (t: string) => t.replace(/\s+/g, " ").trim();

interface Brigada {
  usuario: UsuarioAtual;
  treinamento: typeof e.treinamento.$inferSelect;
  instrutor: typeof e.assinatura_instrutor.$inferSelect;
  turma: servico_turma.TurmaCarregada;
  inscricao: servico_turma.InscricaoCarregada;
}

/**
 * Treinamento de 10 tempos com duas disciplinas (incêndio 3+3, socorros 2+2), modelo "Brigada CBMMG
 * v1", centro de formação, local com endereço e um técnico credenciado. A turma fica concluída.
 */
async function cenario(
  d: {
    notas?: [string | null, string | null];
    tempos_presentes?: number;
    sem?: ("cpf_aluno" | "local_atuacao" | "centro" | "endereco" | "profissao" | "credenciamento" | "cpf_instrutor")[];
    profissao?: string;
    concluir?: boolean;
  } = {},
): Promise<Brigada> {
  const sem = new Set(d.sem ?? []);
  const usuario = await _usuario(db);
  if (!sem.has("centro")) await centro_formacao.definir(db, usuario, { nome: "Centro de Formação da UFVJM", cnpj: CNPJ });
  let [campus] = await db.select().from(e.campus).limit(1);
  if (!campus) [campus] = await db.insert(e.campus).values({ sigla: "JK", nome: "Campus JK", cidade: "Diamantina", uf: "MG" }).returning();
  const [local] = await db
    .insert(e.local_treinamento)
    .values({
      nome: "Auditório da Brigada",
      campus_id: campus!.id,
      endereco: sem.has("endereco") ? null : "Rodovia MGT 367, km 583, nº 5000, Alto da Jacuba",
    })
    .returning();
  const [treinamento] = await db
    .insert(e.treinamento)
    .values({
      codigo: "BRIG-QA",
      codigo_curto: "BRIGQA",
      nome: "Brigadista Orgânico Nível Básico",
      carga_horaria_horas: "10",
      carga_unidade: "TEMPOS",
      validade_meses: 24,
      validade_origem: "NORMA",
      validade_citacao: "Portaria CBMMG nº 54/2020",
    })
    .returning();
  await disciplinas.salvar(db, usuario, treinamento!, [
    { nome: "Prevenção e Combate a Incêndio", teorica: 3, pratica: 3 },
    { nome: "Primeiros Socorros", teorica: 2, pratica: 2 },
  ]);
  const [ja] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.nome, MODELO_BRIGADA_NOME));
  const modelo = ja ?? (await criar_modelo_brigada(db));
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, treinamento!.id));

  const [instrutor] = await db
    .insert(e.assinatura_instrutor)
    .values({
      nome: "Joana Instrutora",
      titulo: "Técnica em Segurança do Trabalho",
      externo: true,
      vigencia_inicio: "2020-01-01",
      profissao: sem.has("profissao") ? null : (d.profissao ?? "TECNICO_SEG"),
      credenciamento_cbmmg: sem.has("credenciamento") ? null : "CBM-4321",
      conselho: d.profissao === "ENGENHEIRO_SEG" ? "CREA" : null,
      registro_conselho: d.profissao === "ENGENHEIRO_SEG" ? "MG-98765/D" : null,
    })
    .returning();
  if (!sem.has("cpf_instrutor")) await cpf_certificado.definir_do_instrutor(db, usuario, instrutor!.id, CPF_INSTRUTOR);

  const [servidor] = await db.insert(e.servidor).values({ siape: "2223334", nome: "Carlos Brigadista" }).returning();
  const pessoa = await servico_participante.de_servidor(db, servidor!, usuario);
  if (!sem.has("cpf_aluno")) await cpf_certificado.definir_do_participante(db, usuario, pessoa, CPF_ALUNO);

  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, treinamento!.id));
  let turma = await servico_turma.criar_turma(db, usuario, {
    treinamento: t!,
    data_inicio: INICIO,
    data_fim: INICIO,
    local: "Auditório da Brigada",
    campus_id: campus!.id,
  });
  await db
    .update(e.turma)
    .set({ local_id: local!.id, local_atuacao_padrao: sem.has("local_atuacao") ? null : "Campus JK — Diamantina" })
    .where(eq(e.turma.id, turma.id));
  turma = (await servico_turma.carregar_turma(db, turma.id))!;
  await servico_turma.vincular_instrutor(db, usuario, turma, { ...instrutor!, servidor: null });
  turma = (await servico_turma.carregar_turma(db, turma.id))!;
  let inscricao = await servico_turma.inscrever(db, usuario, turma, (await servico_participante.carregar(db, pessoa.id))!);
  await servico_turma.mudar_situacao(db, usuario, turma, "EM_ANDAMENTO");
  turma = (await servico_turma.carregar_turma(db, turma.id))!;
  inscricao = (await servico_turma.carregar_inscricao(db, inscricao.id, turma))!;
  await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: INICIO, presente: true, quantidade: d.tempos_presentes ?? 10 });
  const [n1, n2] = d.notas ?? ["85", "70"];
  const [d1, d2] = turma.treinamento.disciplinas;
  if (n1 !== null) await servico_presenca.lancar_nota_disciplina(db, usuario, inscricao, d1!.id, n1);
  if (n2 !== null) await servico_presenca.lancar_nota_disciplina(db, usuario, inscricao, d2!.id, n2);
  if (d.concluir ?? true) await servico_turma.mudar_situacao(db, usuario, turma, "CONCLUIDA");
  turma = (await servico_turma.carregar_turma(db, turma.id))!;
  inscricao = (await servico_turma.carregar_inscricao(db, inscricao.id, turma))!;
  return { usuario, treinamento: t!, instrutor: instrutor!, turma, inscricao };
}

async function emitido(d: Parameters<typeof cenario>[0] = {}) {
  const b = await cenario(d);
  const r = await servico.emitir(db, b.usuario, b.inscricao, { gerar_pdf: false });
  const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, r.certificado.id));
  return { ...b, r, cert: cert! };
}

// ---------------------------------------------------------------------
describe("nota da brigada (art. 40 e 42, § 3º)", () => {
  it("média simples cortada na segunda casa (sem arredondar para cima) e a exibição em percentual ('85%', '77,5%')", () => {
    expect(brigada.media(["85.00", "70.00"])).toBe("77.50");
    expect(brigada.media(["80", "75", "71"])).toBe("75.33");
    // lote 5: corta na segunda casa, sem arredondar para cima
    expect(brigada.media(["70.01", "70.00"])).toBe("70.00"); // 70,005 → 70,00
    expect(brigada.media(["90", "69.99"])).toBe("79.99"); // 79,995 → 79,99, nunca 80
    expect(brigada.exibir_nota("85.00")).toBe("85%");
    expect(brigada.exibir_nota("77.50")).toBe("77,5%");
    expect(brigada.exibir_nota("75.33")).toBe("75,33%");
    expect(brigada.ler_nota("77,5")).toBe("77.50");
    expect(() => brigada.ler_nota("100,5")).toThrow(brigada.NotaInvalida);
    expect(() => brigada.ler_nota("abc")).toThrow(brigada.NotaInvalida);
  });

  it("a nota final é a média das disciplinas, na escala 100; aprova com 70 em cada uma e frequência de 75%", async () => {
    const { inscricao } = await cenario({ notas: ["85", "70"] });
    expect(inscricao.situacao).toBe("APROVADO");
    expect(inscricao.nota_escala).toBe(100);
    expect(inscricao.nota_final).toBe("77.50");
  });

  it("90 e 69,99: reprovado, com a nota final exibida 79,99% (e não 80%)", async () => {
    const { inscricao, turma } = await cenario({ notas: ["90", "69.99"] });
    expect(inscricao.situacao).toBe("REPROVADO");
    expect(inscricao.nota_final).toBe("79.99");
    expect(brigada.exibir_nota(inscricao.nota_final)).toBe("79,99%");
    expect(servico_presenca.avaliar(turma, inscricao).motivos.join("; ")).toContain("Primeiros Socorros");
  });

  it("70 e 70: aprovado, com a nota final exibida 70% — a aprovação compara cada disciplina exata com 70", async () => {
    const { inscricao } = await cenario({ notas: ["70", "70"] });
    expect(inscricao.situacao).toBe("APROVADO");
    expect(brigada.exibir_nota(inscricao.nota_final)).toBe("70%");
  });

  it("69,99 numa disciplina reprova, mesmo com a média acima de 70", async () => {
    const { inscricao, turma } = await cenario({ notas: ["100", "69.99"] });
    expect(inscricao.situacao).toBe("REPROVADO");
    const motivos = servico_presenca.avaliar(turma, inscricao).motivos.join("; ");
    expect(motivos).toContain("Primeiros Socorros");
  });

  it("frequência abaixo de 75% reprova, com as notas boas", async () => {
    const { inscricao } = await cenario({ tempos_presentes: 7 });
    expect(inscricao.situacao).toBe("REPROVADO");
  });

  it("turma de brigada recusa a nota única de 0 a 10", async () => {
    const b = await cenario({ concluir: false });
    await expect(servico_presenca.lancar_nota(db, b.usuario, b.inscricao, "9")).rejects.toThrow(/por disciplina/);
  });
});

describe("disciplinas do treinamento", () => {
  it("a soma das disciplinas tem de ser a carga do treinamento", async () => {
    const usuario = await _usuario(db);
    const [t] = await db
      .insert(e.treinamento)
      .values({ codigo: "BRIG-X", codigo_curto: "BRIGX", nome: "Brigada X", carga_horaria_horas: "10", carga_unidade: "TEMPOS", validade_meses: 0 })
      .returning();
    await expect(disciplinas.salvar(db, usuario, t!, [{ nome: "Incêndio", teorica: 3, pratica: 3 }])).rejects.toThrow(
      "A soma das disciplinas não fecha com a carga: 3 + 3 = 6 tempos, mas a carga do treinamento é 10 tempos.",
    );
  });

  it("só existem em treinamento em tempos", async () => {
    const usuario = await _usuario(db);
    const [t] = await db
      .insert(e.treinamento)
      .values({ codigo: "NR-X", codigo_curto: "NRX", nome: "NR X", carga_horaria_horas: "8", validade_meses: 0 })
      .returning();
    await expect(disciplinas.salvar(db, usuario, t!, [{ nome: "A", teorica: 8, pratica: 0 }])).rejects.toThrow(/tempos/);
  });

  it("depois da primeira turma os tempos travam; o nome se corrige até o primeiro certificado", async () => {
    const b = await cenario();
    const atuais = disciplinas.como_dados(await disciplinas.carregar(db, b.treinamento.id));
    // tempos: recusado
    const trocados = atuais.map((d, i) => (i === 0 ? { ...d, teorica: 4, pratica: 2 } : d));
    await expect(disciplinas.salvar(db, b.usuario, b.treinamento, trocados)).rejects.toThrow(/não mudam depois que o treinamento tem turma/);
    // nome: aceito (sem certificado ainda)
    const renomeados = atuais.map((d, i) => (i === 1 ? { ...d, nome: "Primeiros Socorros Básicos" } : d));
    expect(await disciplinas.salvar(db, b.usuario, b.treinamento, renomeados)).toBe(true);
    // com certificado emitido, nem o nome
    const turma = (await servico_turma.carregar_turma(db, b.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, b.inscricao.id, turma))!;
    await servico.emitir(db, b.usuario, inscricao, { gerar_pdf: false });
    const de_novo = renomeados.map((d, i) => (i === 1 ? { ...d, nome: "Socorros" } : d));
    await expect(disciplinas.salvar(db, b.usuario, b.treinamento, de_novo)).rejects.toThrow(/certificado emitido/);
  });
});

describe("bloqueios da emissão de brigada: o que falta e de quem", () => {
  it.each([
    ["cpf_aluno", /falta o CPF de Carlos Brigadista/],
    ["local_atuacao", /falta o local de atuação de Carlos Brigadista/],
    ["centro", /falta o nome do centro de formação/],
    ["endereco", /falta o endereço completo do local "Auditório da Brigada" \(de TUR-\d{4}-\d{4}\): complete em Treinamentos › Locais/],
    ["profissao", /falta a profissão de Joana Instrutora/],
    ["credenciamento", /falta o número de credenciamento no CBMMG de Joana Instrutora/],
    ["cpf_instrutor", /falta o CPF de Joana Instrutora/],
  ] as const)("sem %s, bloqueia", async (falta, frase) => {
    const b = await cenario({ sem: [falta] });
    const v = await servico.validar(db, b.inscricao);
    expect(v.bloqueios.join(" | ")).toMatch(frase);
    await expect(servico.emitir(db, b.usuario, b.inscricao, { gerar_pdf: false })).rejects.toThrow();
  });

  it("turma com local só digitado, fora do cadastro de Locais, bloqueia dizendo qual", async () => {
    const b = await cenario();
    await db.update(e.turma).set({ local_id: null }).where(eq(e.turma.id, b.turma.id));
    const turma = (await servico_turma.carregar_turma(db, b.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, b.inscricao.id, turma))!;
    const v = await servico.validar(db, inscricao);
    expect(v.bloqueios.join(" | ")).toMatch(/não usa um local do cadastro de Locais \("Auditório da Brigada" foi digitado\)/);
  });

  it("nota de disciplina faltando bloqueia com o nome da disciplina e da pessoa", async () => {
    const b = await cenario({ notas: ["85", null] });
    const v = await servico.validar(db, b.inscricao);
    expect(v.bloqueios.join(" | ")).toMatch(/falta a nota de Primeiros Socorros de Carlos Brigadista/);
  });

  it("engenheiro vale pelo registro no conselho: emite sem credenciamento, e o registro sai na linha do instrutor", async () => {
    const { r } = await emitido({ profissao: "ENGENHEIRO_SEG", sem: ["credenciamento"] });
    expect(espacos(documento.extrair_texto(r.bytes))).toContain("Instrutor: Joana Instrutora, CPF 111.444.777-35, Registro CREA MG-98765/D");
  });
});

describe("modelo Brigada CBMMG v1", () => {
  it("o congelado guarda o bloco da brigada e a segunda via confere com o hash", async () => {
    const { cert, usuario } = await emitido();
    const k = cert.contexto_congelado as Record<string, any>;
    expect(k.nota_escala).toBe(100);
    expect(k.brigada.centro_cnpj).toBe("11.222.333/0001-81");
    expect(k.brigada.endereco).toMatch(/Alto da Jacuba, Diamantina\/MG$/);
    expect(k.brigada.local_atuacao).toBe("Campus JK — Diamantina");
    expect(k.brigada.disciplinas).toEqual([
      { nome: "Prevenção e Combate a Incêndio", teorica: 3, pratica: 3, nota: "85.00" },
      { nome: "Primeiros Socorros", teorica: 2, pratica: 2, nota: "70.00" },
    ]);
    const segunda = await servico.segunda_via(db, usuario, cert);
    expect(segunda.confere).toBe(true);
  });

  it("paridade .docx × PDF, frente e verso: o mesmo texto, palavra a palavra", async () => {
    const { r, cert } = await emitido();
    const docx = espacos(documento.extrair_texto(r.bytes));
    const registro: certificado_pdf.TextoDesenhado[] = [];
    await certificado_pdf.gerar_pdf([servico.montar_contexto(db, cert)], [], { registro });
    const pagina = (n: number) => espacos(registro.filter((t) => t.pagina === n).map((t) => t.texto).join(" "));
    expect(registro.some((t) => t.pagina === 1)).toBe(true);
    const corte = docx.indexOf("DISCIPLINAS E NOTAS");
    expect(corte).toBeGreaterThan(0);
    expect(pagina(0)).toBe(docx.slice(0, corte).trim());
    expect(pagina(1)).toBe(docx.slice(corte).trim());
  });

  it("a frente segue o Anexo I e o art. 43, II; o verso tem o quadro, a nota final e a equivalência do tempo", async () => {
    const { r } = await emitido();
    const docx = espacos(documento.extrair_texto(r.bytes));
    expect(docx).toContain(
      "Certificamos que Carlos Brigadista, portador(a) do CPF 529.982.247-25, concluiu com êxito a Formação do Curso de " +
        "Brigadista Orgânico Nível Básico, com carga horária de 10 tempos, conforme Lei Estadual nº 22.839/2018 e Portaria 54/2020 do CBMMG, " +
        "promovido pelo Centro de Formação Centro de Formação da UFVJM, CNPJ 11.222.333/0001-81, realizado no endereço situado à " +
        "Rodovia MGT 367, km 583, nº 5000, Alto da Jacuba, Diamantina/MG.",
    );
    expect(docx).toContain("Local de atuação do brigadista: Campus JK — Diamantina.");
    expect(docx).toMatch(/Curso realizado no período de \d\d\/\d\d\/\d{4} a \d\d\/\d\d\/\d{4}\./);
    expect(docx).toContain("Instrutor: Joana Instrutora, CPF 111.444.777-35, Credenciamento CBMMG nº CBM-4321");
    expect(docx).toContain("Prevenção e Combate a Incêndio 6 t Teórica 3 t 85% Prática 3 t 85%");
    expect(docx).toContain("Primeiros Socorros 4 t Teórica 2 t 70% Prática 2 t 70%");
    expect(docx).toContain("NOTA FINAL 77,5%");
    expect(docx).toContain("Cada tempo (t) equivale a 50 minutos.");
    expect(docx).not.toMatch(/identidade|\bRG\b/);
  });

  it("a citação legal da carga vem do texto fixo do modelo, editável, e não do código", async () => {
    const b = await cenario();
    const modelo_id = b.turma.treinamento.modelo_vigente_id!;
    await db
      .update(e.certificado_modelo_tag)
      .set({ texto_fixo: "conforme a norma de teste" })
      .where(eq(e.certificado_modelo_tag.modelo_id, modelo_id));
    const turma = (await servico_turma.carregar_turma(db, b.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, b.inscricao.id, turma))!;
    const r = await servico.emitir(db, b.usuario, inscricao, { gerar_pdf: false });
    expect(espacos(documento.extrair_texto(r.bytes))).toContain("com carga horária de 10 tempos, conforme a norma de teste, promovido");
  });

  it("a identidade fica pronta para entrar depois: o congelado sem ela sai igual, e com ela entra no lugar previsto", async () => {
    const { cert } = await emitido();
    const ctx = ContextoCertificado.descongelar({ ...(cert.contexto_congelado as Record<string, unknown>), participante_identidade: "MG-12.345.678" });
    const frente = certificado_pdf.textos_da_brigada(ctx).frente[1]!.map((t) => t.texto).join("");
    expect(frente).toContain("portador(a) do CPF 529.982.247-25 e identidade MG-12.345.678, concluiu");
    const sem = certificado_pdf.textos_da_brigada(servico.montar_contexto(db, cert)).frente[1]!.map((t) => t.texto).join("");
    expect(sem).toContain("portador(a) do CPF 529.982.247-25, concluiu");
  });

  it("o modelo de brigada nunca vira o genérico automático de quem não aponta modelo", async () => {
    const b = await cenario();
    await db.update(e.treinamento).set({ modelo_vigente_id: null }).where(eq(e.treinamento.id, b.treinamento.id));
    const turma = (await servico_turma.carregar_turma(db, b.turma.id))!;
    const [modelo] = await servico.modelo_da_turma(db, turma);
    expect(modelo?.nome ?? null).not.toBe(MODELO_BRIGADA_NOME);
  });
});

describe("a carga em tempos no PDF: 'com carga horária de' desde a redação 4", () => {
  it("o novo sai 'com carga horária de 10 tempos'; o emitido na redação 3 reimprime 'com carga de 10 tempos'", async () => {
    const { cert } = await emitido();
    const congelado = cert.contexto_congelado as Record<string, unknown>;
    const comum = ContextoCertificado.descongelar({ ...congelado, brigada: null });
    expect(certificado_pdf.texto_de_certificacao(comum)).toContain(", com carga horária de 10 tempos");
    const antigo = ContextoCertificado.descongelar({ ...congelado, brigada: null, redacao: 3 });
    expect(certificado_pdf.texto_de_certificacao(antigo)).toContain(", com carga de 10 tempos");
  });
});

describe("CPF da brigada: por inteiro só no .docx/PDF", () => {
  it("/validar não mostra o CPF do aluno nem o do instrutor", async () => {
    const { cert } = await emitido();
    const pagina = (await cliente.get(`/validar/${cert.chave_validacao}`)).text;
    expect(pagina).toContain(cert.numero_impresso!);
    for (const cpf of [CPF_ALUNO, CPF_INSTRUTOR]) {
      expect(pagina).not.toContain(cpf);
      expect(pagina).not.toContain(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`);
    }
  });

  it("a vitrine pública de cursos não mostra o CPF", async () => {
    await emitido();
    const pagina = (await cliente.get("/cursos")).text;
    for (const cpf of [CPF_ALUNO, CPF_INSTRUTOR]) {
      expect(pagina).not.toContain(cpf);
      expect(pagina).not.toContain(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`);
    }
  });

  it("/validar e a vitrine não trazem nem a palavra CPF (a regra de antes do lote 4 continua)", async () => {
    const { cert } = await emitido();
    for (const caminho of [`/validar/${cert.chave_validacao}`, "/cursos"]) {
      const pagina = (await cliente.get(caminho)).text;
      expect(pagina, caminho).not.toMatch(/\bCPF\b/);
    }
  });

  it("o e-mail do certificado não leva o CPF, nem o número nem a palavra", async () => {
    const { cert, usuario } = await emitido();
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, cert.participante_id));
    await db.update(e.servidor).set({ email: "carlos.brigadista@exemplo.test" }).where(eq(e.servidor.id, p!.servidor_id!));
    const r = await envio_certificado.pedir_envio(db, usuario, [cert.id]);
    expect(r.enfileirados).toBe(1);
    const [m] = await db.select().from(e.email_saida).where(eq(e.email_saida.certificado_id, cert.id));
    const texto = `${m!.assunto}\n${m!.corpo ?? ""}`;
    for (const cpf of [CPF_ALUNO, CPF_INSTRUTOR]) {
      expect(texto).not.toContain(cpf);
      expect(texto).not.toContain(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`);
    }
    expect(texto).not.toMatch(/\bCPF\b/);
  });

  it("a trilha da emissão não leva o CPF", async () => {
    const { cert } = await emitido();
    const eventos = await db.select().from(e.historico_evento);
    const tudo = JSON.stringify(eventos);
    expect(tudo).not.toContain(CPF_ALUNO);
    expect(tudo).not.toContain(CPF_INSTRUTOR);
    expect(cert.id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
describe("lote 5 (T8): a brigada também leva a unidade promotora no contexto", () => {
  it("o congelado traz a sigla e o nome da unidade promotora, e a segunda via confere depois de renomeada", async () => {
    const b = await cenario();
    const [u] = await db.select().from(e.unidade_uorg).limit(1);
    await db
      .update(e.unidade_uorg)
      .set({ sigla: "UPB", nome_extenso: "Unidade Promotora da Brigada", promove_treinamento: true })
      .where(eq(e.unidade_uorg.id, u!.id));
    await db.update(e.turma).set({ unidade_promotora_id: u!.id }).where(eq(e.turma.id, b.turma.id));
    const turma = (await servico_turma.carregar_turma(db, b.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, b.inscricao.id, turma))!;
    const r = await servico.emitir(db, b.usuario, inscricao, { gerar_pdf: false });
    const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, r.certificado.id));
    const ctx = cert!.contexto_congelado as Record<string, unknown>;
    expect([ctx.setor_sigla, ctx.setor_nome]).toEqual(["UPB", "Unidade Promotora da Brigada"]);
    await db.update(e.unidade_uorg).set({ nome_extenso: "Renomeada Depois" }).where(eq(e.unidade_uorg.id, u!.id));
    const via = await servico.segunda_via(db, b.usuario, cert!);
    expect(via.confere).toBe(true);
    expect(via.hash_conteudo).toBe(cert!.hash_conteudo);
  });
});
