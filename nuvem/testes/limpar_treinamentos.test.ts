/**
 * A limpeza do módulo Certificados e Treinamentos (23/10/2026,
 * `ferramentas/limpar-treinamentos.ts`): simular não muda nada; a execução real
 * zera as tabelas da lista, mantém modelos/numeração/servidores/usuários/EPI e
 * a trilha (que ganha UM evento), apaga os arquivos órfãos só depois do commit,
 * deixa uma cópia local com permissão 600, recusa confirmação errada, é
 * idempotente e aborta se uma tabela fora da lista referencia as apagadas.
 *
 * NUNCA toca banco de produção: roda no clone de teste do `bancoLimpo()`.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-limpar-arq-"));

import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { definirArmazenamento, obterArmazenamento } from "../src/servicos/armazenamento.js";
import * as anexos from "../src/servicos/anexos.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import * as lista_presenca from "../src/servicos/lista_presenca.js";
import * as mesclagem from "../src/servicos/mesclagem.js";
import * as servico_participante from "../src/servicos/participante.js";
import { identidadeDoBanco } from "../src/servicos/instalacao.js";
import * as ferramenta from "../ferramentas/limpar-treinamentos.js";
import { bancoLimpo, contas, designarAjudante, naTransacao, usuarioAtual } from "./ajuda.js";
import { _cenario, _usuario, type Cenario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let url: string;
let copia: string;
await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  url = amb.url;
  definirArmazenamento(null);
  copia = mkdtempSync(path.join(tmpdir(), "csso-limpar-copia-"));
  await contas(db);
});

function saida(respostas: string[] = []) {
  const linhas: string[] = [];
  const erros: string[] = [];
  return {
    linhas,
    erros,
    tudo: () => [...linhas, ...erros].join("\n"),
    s: {
      log: (l: string) => linhas.push(l),
      erro: (l: string) => erros.push(l),
      perguntar: async () => respostas.shift() ?? "",
    },
  };
}
const identidade = () => identidadeDoBanco(url);

/** A contagem de TODA tabela de `public` (para provar que nada mais mexeu). */
async function tudo(): Promise<Record<string, number>> {
  const nomes = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)) as unknown as {
    tablename: string;
  }[];
  const r: Record<string, number> = {};
  for (const { tablename } of nomes) {
    const [l] = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM public."${tablename}"`))) as unknown as { n: number }[];
    r[tablename] = l!.n;
  }
  return r;
}

interface Montado {
  cen: Cenario;
  chaves: { docx: string; pdf: string; lista: string; rubrica: string; mantido: string };
  certificado_id: number;
}

/** treinamento+turma+inscrição+presença+certificado+arquivos+externo+e-mail+instrutor+pedido+par. */
async function montar(): Promise<Montado> {
  const usuario = await _usuario(db);
  const cen = await _cenario(db, usuario);
  const emitido = await emissao.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
  const cert = emitido.certificado;
  const arm = obterArmazenamento();
  const pdf = `certificados-pdf/${cert.id}-abc123.pdf`;
  await arm.gravar(pdf, new Uint8Array([37, 80, 68, 70]), "application/pdf");
  const lista = lista_presenca.caminho_saida({ ano: cen.turma.ano, codigo: cen.turma.codigo });
  await arm.gravar(lista, new Uint8Array([1, 2, 3]));

  // rubrica do instrutor (anexo do módulo) e um anexo que NÃO é do módulo
  const rubrica = await naTransacao((tx) =>
    anexos.guardar(tx, {
      entidade: "assinatura_instrutor",
      entidade_id: cen.instrutor.id,
      nome_original: "rubrica.png",
      conteudo: new Uint8Array([9, 9, 9, 1]),
      mime_type: "image/png",
      categoria: "RUBRICA_INSTRUTOR",
      usuario,
    }),
  );
  await db.update(e.assinatura_instrutor).set({ imagem_anexo_id: rubrica.anexo.id }).where(eq(e.assinatura_instrutor.id, cen.instrutor.id));
  // a qualificação do instrutor e o comprovante dela (saem com o instrutor)
  const [qualificacao] = await db
    .insert(e.instrutor_qualificacao)
    .values({
      instrutor_id: cen.instrutor.id,
      descricao: "Formação de instrutor NR-35",
      treinamento_id: cen.treinamento.id,
      instituicao: "SENAI",
      data_emissao: "2025-01-10",
      criado_por: usuario.id,
    })
    .returning();
  const comprovante = await naTransacao((tx) =>
    anexos.guardar(tx, {
      entidade: "instrutor_qualificacao",
      entidade_id: qualificacao!.id,
      nome_original: "diploma.pdf",
      conteudo: new Uint8Array([37, 80, 68, 70, 45, 1]),
      mime_type: "application/pdf",
      categoria: "QUALIFICACAO_INSTRUTOR",
      usuario,
    }),
  );
  await db
    .update(e.instrutor_qualificacao)
    .set({ comprovante_anexo_id: comprovante.anexo.id })
    .where(eq(e.instrutor_qualificacao.id, qualificacao!.id));
  const manter = await naTransacao((tx) =>
    anexos.guardar(tx, {
      entidade: "processo",
      entidade_id: 999,
      nome_original: "outro.pdf",
      conteudo: new Uint8Array([7, 7, 7, 7]),
      mime_type: "application/pdf",
      categoria: "OUTRO",
      usuario,
    }),
  );

  // participante externo com e-mail, outro para o pedido pelo link e um par de duplicados
  const ana = await naTransacao((tx) =>
    servico_participante.criar_externo(tx, { nome: "Ana Externa Sigilosa", vinculo: "TERCEIRIZADO", email: "ana.sigilosa@empresa.com.br" }),
  );
  const bia = await naTransacao((tx) =>
    servico_participante.criar_externo(tx, { nome: "Bia Pedido Link", vinculo: "TERCEIRIZADO", email: "bia.link@empresa.com.br" }),
  );
  const cris = await naTransacao((tx) => servico_participante.criar_externo(tx, { nome: "Cris Duplicada", vinculo: "TERCEIRIZADO" }));
  const cris2 = await naTransacao((tx) => servico_participante.criar_externo(tx, { nome: "Cris Duplicada B", vinculo: "TERCEIRIZADO" }));
  const coord = await usuarioAtual(db, "coordenador_csso");
  await naTransacao((tx) => mesclagem.mesclar(tx, coord, cris.id, cris2.id, "mesma pessoa"));
  const [a, b] = ana.id < bia.id ? [ana.id, bia.id] : [bia.id, ana.id];
  await db.insert(e.participante_par_distinto).values({ participante_a_id: a, participante_b_id: b, origem: "JUNCAO", decidido_por: coord.id });
  const [pedido_bia] = await db
    .insert(e.inscricao)
    .values({ turma_id: cen.turma.id, participante_id: bia.id, situacao: "AGUARDANDO_EMAIL", origem: "PUBLICA" })
    .returning();
  // o aviso de cadastro existente com os botões «sou eu» / «não fui eu» (26/10/2026)
  await db.insert(e.aviso_cadastro).values({
    participante_id: bia.id,
    inscricao_id: pedido_bia!.id,
    token_hash: "c".repeat(64),
    expira_em: new Date(Date.now() + 3600_000),
  });

  await designarAjudante(db, cen.turma.id, "coordenador_csso");
  await db.insert(e.certificado_valor_turma).values({ turma_id: cen.turma.id, marcador: "LOCAL_X", valor: "Sala 1" });
  await db.insert(e.certificado_valor_inscricao).values({ inscricao_id: cen.inscricao.id, marcador: "FUNCAO_X", valor: "Líder" });

  // filas e acessos: do módulo (saem) e do EPI (ficam)
  await db.insert(e.email_saida).values([
    { tipo: "CERTIFICADO", destinatario: "ana.sigilosa@empresa.com.br", assunto: "Seu certificado", certificado_id: cert.id },
    { tipo: "AVISO_CADASTRO_EXISTENTE", destinatario: "bia.link@empresa.com.br", assunto: "Cadastro existente" },
    { tipo: "EPI_DECISAO", destinatario: "servidor@ufvjm.edu.br", assunto: "Pedido de EPI" },
  ]);
  await db.insert(e.acesso_participante).values({
    token_hash: "a".repeat(64),
    email_normalizado: "ana.sigilosa@empresa.com.br",
    expira_em: new Date(Date.now() + 3600_000),
  });
  // avaliação de reação: um convite por link e uma resposta anônima
  await db.insert(e.avaliacao_reacao_convite).values({ inscricao_id: cen.inscricao.id, token_hash: "b".repeat(64), expira_em: "2099-12-31" });
  await db.insert(e.avaliacao_reacao_resposta).values({
    turma_id: cen.turma.id,
    versao: "v1",
    nota_conteudo: 5,
    nota_instrutor: 5,
    nota_material: 4,
    nota_local: 4,
    nota_carga: 3,
    nota_recomendaria: 5,
    respondida_em: "2026-10-24",
  });
  await db.insert(e.pendencia).values({
    tipo: "RECICLAGEM",
    descricao: "reciclagem a vencer",
    entidade: "certificado",
    entidade_id: cert.id,
    chave: `limpar-teste-${cert.id}`,
  });

  // EPI (fica), com o vínculo ao treinamento (sai)
  const [cat] = await db.select().from(e.epi_categoria).limit(1);
  const [item] = await db.insert(e.epi_item).values({ nome: "Capacete de teste", categoria_id: cat!.id, exige_ca: false }).returning();
  await db.insert(e.epi_item_treinamento).values({ epi_item_id: item!.id, treinamento_id: cen.treinamento.id });

  const [mantido] = await db.select().from(e.anexo).where(eq(e.anexo.id, manter.anexo.id));
  return {
    cen,
    certificado_id: cert.id,
    chaves: {
      docx: cert.arquivo_docx ?? emissao.caminho_saida(cert),
      pdf,
      lista,
      rubrica: anexos.chave_no_armazenamento(rubrica.anexo.storage_key),
      mantido: anexos.chave_no_armazenamento(mantido!.storage_key),
    },
  };
}

const TABELAS_ZERO = [...ferramenta.TABELAS_APAGAR];

describe("limpar-treinamentos", () => {
  it("monta o cenário: tudo existe antes", async () => {
    const m = await montar();
    const antes = await tudo();
    for (const t of TABELAS_ZERO) expect(antes[t], t).toBeGreaterThan(0);
    const arm = obterArmazenamento();
    for (const c of Object.values(m.chaves)) expect(await arm.existe(c), c).toBe(true);
  });

  it("--simular não altera nada: banco, trilha, armazenamento e cópia", async () => {
    const m = await montar();
    const antes = await tudo();
    const o = saida();
    expect(await ferramenta.principal(["--copia", copia, "--simular"], o.s)).toBe(0);
    expect(await tudo()).toEqual(antes);
    expect(readdirSync(copia)).toHaveLength(0);
    const arm = obterArmazenamento();
    for (const c of Object.values(m.chaves)) expect(await arm.existe(c), c).toBe(true);
    expect(o.tudo()).toContain("SIMULAÇÃO");
    expect(o.tudo()).toContain(identidade());
    const [l] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, ferramenta.TIPO_EVENTO));
    expect(l).toBeUndefined();
  });

  it("confirmação errada não grava nada", async () => {
    await montar();
    const antes = await tudo();
    const o = saida(["banco-errado"]);
    expect(await ferramenta.principal(["--copia", copia], o.s)).toBe(3);
    expect(await ferramenta.principal(["--copia", copia, "--confirmar", "outra"], saida().s)).toBe(3);
    expect(await tudo()).toEqual(antes);
    expect(readdirSync(copia)).toHaveLength(0);
  });

  it("exige --copia e recusa pasta dentro do repositório", async () => {
    expect(await ferramenta.principal([], saida().s)).toBe(1);
    const o = saida();
    expect(await ferramenta.principal(["--copia", path.resolve(process.cwd(), "copia-no-repo")], o.s)).toBe(1);
    expect(o.tudo()).toContain("repositório");
  });

  it("execução real: zera a lista, mantém o resto, acrescenta um evento na trilha, apaga os órfãos e deixa a cópia", async () => {
    const m = await montar();
    const antes = await tudo();
    const [eventosAntes] = (await db.execute(sql`SELECT count(*)::int AS n FROM historico_evento`)) as unknown as { n: number }[];
    const modelosAntes = await db.select().from(e.certificado_modelo);
    const tagsAntes = await db.select().from(e.certificado_modelo_tag);
    const seqAntes = await db.select().from(e.certificado_sequencia);
    expect(modelosAntes.some((x) => x.treinamento_id !== null)).toBe(true);

    const o = saida([identidade()]);
    expect(await ferramenta.principal(["--copia", copia], o.s)).toBe(0);

    const depois = await tudo();
    for (const t of TABELAS_ZERO) expect(depois[t], t).toBe(0);
    // parciais: só o do módulo saiu
    expect(depois.email_saida).toBe(1);
    expect((await db.select().from(e.email_saida))[0]!.tipo).toBe("EPI_DECISAO");
    expect(depois.pendencia).toBe(antes.pendencia! - 1);
    // a rubrica e o comprovante de qualificação do instrutor
    expect(depois.anexo).toBe(antes.anexo! - 2);
    // nada mais mexeu, exceto a trilha (+1)
    const mexidas = new Set([...TABELAS_ZERO, "email_saida", "pendencia", "anexo", "historico_evento"]);
    for (const [t, n] of Object.entries(antes)) if (!mexidas.has(t)) expect(depois[t], t).toBe(n);
    expect(depois.historico_evento).toBe(antes.historico_evento! + 1);
    expect(eventosAntes!.n).toBe(antes.historico_evento);
    // modelos, tags e numeração intactos (modelo só perde o vínculo)
    const modelosDepois = await db.select().from(e.certificado_modelo);
    expect(modelosDepois.map((x) => x.id).sort()).toEqual(modelosAntes.map((x) => x.id).sort());
    expect(modelosDepois.every((x) => x.treinamento_id === null)).toBe(true);
    expect(await db.select().from(e.certificado_modelo_tag)).toHaveLength(tagsAntes.length);
    expect(await db.select().from(e.certificado_sequencia)).toEqual(seqAntes);
    expect(depois.servidor).toBe(antes.servidor);
    expect(depois.usuario).toBe(antes.usuario);
    expect(depois.epi_item).toBe(1);

    // a trilha: um evento, com rótulo, sem dado pessoal, e a cadeia continua íntegra
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, ferramenta.TIPO_EVENTO));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.usuario_nome).toBe(ferramenta.ATOR);
    expect(eventos[0]!.descricao).toMatch(/certificado=1/);
    expect(eventos[0]!.descricao).not.toMatch(/Marco|Ana|Bia|Cris|sigilosa|@/);
    expect(auditoria.ROTULO_EVENTO[ferramenta.TIPO_EVENTO]).toBeTruthy();
    expect(auditoria.rotulo_evento(ferramenta.TIPO_EVENTO)).toContain("apagados");
    expect(await naTransacao((tx) => auditoria.cadeia_integra(tx))).toEqual([true, null]);

    // armazenamento: órfãos saíram, o blob de anexo que fica permanece
    const arm = obterArmazenamento();
    expect(await arm.existe(m.chaves.docx)).toBe(false);
    expect(await arm.existe(m.chaves.pdf)).toBe(false);
    expect(await arm.existe(m.chaves.lista)).toBe(false);
    expect(await arm.existe(m.chaves.rubrica)).toBe(false);
    expect(await arm.existe(m.chaves.mantido)).toBe(true);

    // cópia local: permissão 600, com as linhas
    const arquivos = readdirSync(copia);
    expect(arquivos).toHaveLength(1);
    const caminho = path.join(copia, arquivos[0]!);
    expect(statSync(caminho).mode & 0o777).toBe(0o600);
    const json = JSON.parse(readFileSync(caminho, "utf8"));
    expect(json.aviso).toContain("DADOS PESSOAIS");
    expect(json.tabelas.certificado).toHaveLength(antes.certificado!);
    expect(json.tabelas.participante).toHaveLength(antes.participante!);
    expect(JSON.stringify(json.tabelas.participante_email)).toContain("ana.sigilosa@empresa.com.br");
    expect(json.tabelas.email_saida).toHaveLength(2);

    // o terminal só tem contagens
    expect(o.tudo()).not.toMatch(/Ana Externa|sigilosa|Bia Pedido|Marco Ant/);
    expect(o.tudo()).toContain(identidade());

    // idempotente: de novo, nada a fazer e nenhum evento novo
    const o2 = saida();
    expect(await ferramenta.principal(["--copia", copia], o2.s)).toBe(0);
    expect(o2.tudo()).toContain("Nada a apagar");
    expect((await tudo()).historico_evento).toBe(depois.historico_evento);
    expect(readdirSync(copia)).toHaveLength(1);
  });

  it("aborta, sem gravar, se uma tabela fora da lista referencia as apagadas", async () => {
    await montar();
    const intruso = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await intruso.unsafe(`CREATE TABLE intruso (id int PRIMARY KEY, treinamento_id int REFERENCES treinamento(id))`);
      const [t] = await intruso`SELECT id FROM treinamento LIMIT 1`;
      await intruso`INSERT INTO intruso VALUES (1, ${t!.id})`;
      const antes = await tudo();
      const o = saida([identidade()]);
      expect(await ferramenta.principal(["--copia", copia, "--confirmar", identidade()], o.s)).toBe(2);
      expect(o.tudo()).toContain("intruso.treinamento_id");
      const depois = await tudo();
      expect(depois).toEqual(antes);
      expect(readdirSync(copia)).toHaveLength(0);
    } finally {
      await intruso.unsafe(`DROP TABLE IF EXISTS intruso`);
      await intruso.end({ timeout: 5 });
    }
  });

  it("não passa por cima de gatilho de DELETE numa tabela apagada", async () => {
    await montar();
    const adm = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await adm.unsafe(`
        CREATE FUNCTION trava_teste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trava'; END $$;
        CREATE TRIGGER trg_trava_teste BEFORE DELETE ON turma_ajudante FOR EACH ROW EXECUTE FUNCTION trava_teste();`);
      const antes = await tudo();
      const o = saida();
      expect(await ferramenta.principal(["--copia", copia, "--confirmar", identidade()], o.s)).toBe(2);
      expect(o.tudo()).toContain("trg_trava_teste");
      expect(await tudo()).toEqual(antes);
    } finally {
      await adm.unsafe(`DROP TRIGGER IF EXISTS trg_trava_teste ON turma_ajudante; DROP FUNCTION IF EXISTS trava_teste()`);
      await adm.end({ timeout: 5 });
    }
  });

  it("a ordem de DELETE vem do catálogo: filhos antes dos pais", async () => {
    const grafo = await naTransacao((tx) => ferramenta.conferirGrafo(tx));
    expect(grafo.problemas).toEqual([]);
    const pos = (t: string) => grafo.ordem.indexOf(t);
    expect(pos("turma_presenca")).toBeLessThan(pos("inscricao"));
    expect(pos("inscricao")).toBeLessThan(pos("turma"));
    expect(pos("certificado")).toBeLessThan(pos("inscricao"));
    expect(pos("certificado")).toBeLessThan(pos("treinamento"));
    expect(pos("turma")).toBeLessThan(pos("treinamento"));
    expect(pos("participante_mesclagem")).toBeLessThan(pos("participante"));
    expect(pos("epi_item_treinamento")).toBeLessThan(pos("treinamento"));
    expect(grafo.ordem.sort()).toEqual([...ferramenta.TABELAS_APAGAR].sort());
  });
});

// limpa a pasta de arquivos do arquivo de teste ao fim (a de cópias é por teste, em tmpdir)
import { afterAll } from "vitest";
afterAll(() => {
  rmSync(process.env.CSSO_DIR_ARQUIVOS!, { recursive: true, force: true });
});
