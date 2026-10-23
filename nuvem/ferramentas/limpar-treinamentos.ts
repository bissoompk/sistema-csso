/**
 * Limpeza do módulo Certificados e Treinamentos — para recomeçar o cadastro com
 * dados corretos (pedido de 23/10/2026).
 *
 *     npm run limpar-treinamentos -- --copia <pasta fora do repositório> --simular
 *     npm run limpar-treinamentos -- --copia <pasta fora do repositório> [--confirmar <identidade>]
 *
 * APAGA (tudo do módulo): treinamento, turma, inscrição (com a situação, a
 * nota/frequência e os pedidos pelo link), presença, certificados emitidos
 * (e os valores por turma/inscrição), participantes e e-mails, mesclagens e
 * pares de duplicados, instrutores/assinaturas, turma_instrutor/ajudante,
 * `acesso_participante`, o vínculo EPI x treinamento (`epi_item_treinamento`),
 * os avisos na fila de e-mail e as pendências ligados a isso e os anexos do
 * módulo (rubricas, PDFs). Os arquivos do armazenamento que ficariam órfãos
 * (PDF/DOCX de certificado, lista de presença, blobs de anexo) são apagados
 * DEPOIS do commit do banco.
 *
 * MANTÉM: modelos de certificado (`certificado_modelo` e `_tag`; o vínculo do
 * modelo com um treinamento é desfeito — passa a modelo genérico), a numeração
 * (`certificado_sequencia*`, `turma_sequencia`: número usado não se reaproveita),
 * servidores, usuários, perfis, setores promotores, catálogos, EPI, processos e
 * a TRILHA de auditoria (append-only, hash-encadeada) — que ganha UM evento,
 * `DADOS_DE_TREINAMENTO_APAGADOS`, com as contagens e sem dado pessoal.
 *
 * Como funciona, nesta ordem:
 *
 * 1. Lê do catálogo do Postgres as chaves estrangeiras e confere que NENHUMA
 *    tabela fora da lista (e fora das mantidas) referencia linhas que serão
 *    apagadas, e que nenhum gatilho de DELETE existe nas tabelas apagadas.
 *    Se houver, aborta listando — nada é gravado.
 * 2. Mostra a identidade do banco (`identidadeDoBanco`, nunca URL nem senha) e
 *    as contagens por tabela; pede que se DIGITE a identidade (ou
 *    `--confirmar <identidade>`).
 * 3. UMA transação: trava as tabelas, grava a CÓPIA LOCAL (JSON, permissão 600,
 *    em `--copia`, fora do repositório) com todas as linhas que serão apagadas,
 *    apaga por DELETE na ordem topológica (nunca TRUNCATE ... CASCADE; nenhuma
 *    trava de trilha é desligada), registra o evento pela via oficial
 *    (`auditoria.registrar`), confere que tudo zerou e que o que ficava ficou.
 *    Qualquer divergência desfaz tudo.
 * 4. Depois do commit apaga os arquivos órfãos do armazenamento (falha ali não
 *    desfaz o banco: é relatada) e confere de novo.
 *
 * `--simular` faz o passo 3 numa transação e dá ROLLBACK (não grava a cópia, não
 * mexe no armazenamento, não pede confirmação) e imprime o que seria feito.
 *
 * Idempotente: com tudo vazio não faz nada e diz isso.
 *
 * A cópia contém DADOS PESSOAIS (nome, CPF, e-mail): guarde-a em lugar seguro e
 * apague-a quando não for mais necessária. Nada pessoal vai ao terminal: só contagens.
 */
import { createInterface } from "node:readline/promises";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { carregarEnvLocal } from "./env-local.js";
import type { Executor } from "../src/db/cliente.js";

export const ATOR = "linha de comando (limpeza de treinamentos)";
export const TIPO_EVENTO = "DADOS_DE_TREINAMENTO_APAGADOS";

/** Tabelas esvaziadas por inteiro. A ordem de DELETE sai do catálogo (topológica). */
export const TABELAS_APAGAR: readonly string[] = [
  "treinamento",
  "turma",
  "turma_instrutor",
  "turma_ajudante",
  "turma_presenca",
  "inscricao",
  "participante",
  "participante_email",
  "participante_mesclagem",
  "participante_par_distinto",
  "certificado",
  "certificado_valor_turma",
  "certificado_valor_inscricao",
  "assinatura_instrutor",
  "acesso_participante",
  "epi_item_treinamento",
];

const ENTIDADES_DO_MODULO = ["certificado", "assinatura_instrutor", "turma", "inscricao", "treinamento", "participante"];
const TIPOS_DE_EMAIL = ["CERTIFICADO", "RECICLAGEM_AVISO", "AVISO_CADASTRO_EXISTENTE", "AVISO_PEDIDO_REPETIDO"];

/** Tabelas apagadas só em parte: o filtro (SQL fixo; `{anexos}` = ids de anexo do módulo). */
export const TABELAS_PARCIAIS: Readonly<Record<string, string>> = {
  email_saida: `certificado_id IS NOT NULL OR inscricao_id IS NOT NULL OR tipo IN (${TIPOS_DE_EMAIL.map((t) => `'${t}'`).join(", ")})`,
  pendencia: `entidade IN (${ENTIDADES_DO_MODULO.map((t) => `'${t}'`).join(", ")})`,
  anexo: `entidade IN (${ENTIDADES_DO_MODULO.map((t) => `'${t}'`).join(", ")}) OR id IN (SELECT arquivo_pdf_anexo_id FROM certificado WHERE arquivo_pdf_anexo_id IS NOT NULL) OR id IN (SELECT imagem_anexo_id FROM assinatura_instrutor WHERE imagem_anexo_id IS NOT NULL)`,
};

/** Tabela mantida cuja coluna é ZERADA (em vez de a linha ser apagada). */
export const DESVINCULAR = { tabela: "certificado_modelo", coluna: "treinamento_id" } as const;

/** Mantidas: contagem antes e depois tem de ser igual (a trilha ganha 1). */
export const TABELAS_MANTIDAS: readonly string[] = [
  "certificado_modelo",
  "certificado_modelo_tag",
  "certificado_sequencia",
  "certificado_sequencia_prefixo",
  "turma_sequencia",
  "servidor",
  "usuario",
  "perfil",
  "atribuicao",
  "equipe_setor_promotor",
  "campus",
  "cargo",
  "epi_item",
  "epi_requisicao",
  "epi_ficha_registro",
  "processo",
  "historico_evento",
];

export interface Saida {
  log: (linha: string) => void;
  erro: (linha: string) => void;
  perguntar: (pergunta: string) => Promise<string>;
}

async function perguntarNoTerminal(pergunta: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(pergunta);
  } finally {
    rl.close();
  }
}

const SAIDA_PADRAO: Saida = {
  log: (l) => console.log(l),
  erro: (l) => console.error(l),
  perguntar: perguntarNoTerminal,
};

export interface Opcoes {
  copia: string;
  simular: boolean;
  confirmar: string | null;
}

const USO =
  "uso: npm run limpar-treinamentos -- --copia <pasta fora do repositório> [--simular] [--confirmar <identidade do banco>]";

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

/** A raiz do repositório git que contém `inicio` (ou null). */
function raizDoRepositorio(inicio: string): string | null {
  let dir = path.resolve(inicio);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

function dentroDe(filho: string, pai: string): boolean {
  const rel = path.relative(pai, filho);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const copia = (valor(argv, "--copia") ?? "").trim();
  if (!copia) return "falta --copia <pasta> (a cópia local dos dados antes de apagar é obrigatória)";
  const destino = path.resolve(copia);
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  for (const raiz of [raizDoRepositorio(aqui), raizDoRepositorio(process.cwd())]) {
    if (raiz && dentroDe(destino, raiz)) {
      return `--copia não pode ficar dentro do repositório (${raiz}): a cópia tem dados pessoais`;
    }
  }
  return { copia: destino, simular: argv.includes("--simular"), confirmar: valor(argv, "--confirmar") };
}

// =====================================================================
// Catálogo do Postgres
// =====================================================================
interface Fk {
  nome: string;
  filho: string;
  pai: string;
  colunas: string[];
  cascata: boolean;
}

type Linhas = Record<string, unknown>[];

async function consultar(tx: Executor, consulta: string): Promise<Linhas> {
  return (await tx.execute(sql.raw(consulta))) as unknown as Linhas;
}

async function contar(tx: Executor, tabela: string, onde?: string): Promise<number> {
  const [l] = await consultar(tx, `SELECT count(*)::int AS n FROM public."${tabela}"${onde ? ` WHERE ${onde}` : ""}`);
  return Number(l!.n);
}

export async function chavesEstrangeiras(tx: Executor): Promise<Fk[]> {
  const linhas = await consultar(
    tx,
    `SELECT c.conname AS nome, f.relname AS filho, p.relname AS pai, c.confdeltype AS tipo,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS colunas
       FROM pg_constraint c
       JOIN pg_class f ON f.oid = c.conrelid
       JOIN pg_class p ON p.oid = c.confrelid
       JOIN pg_namespace nf ON nf.oid = f.relnamespace AND nf.nspname = 'public'
       JOIN pg_namespace np ON np.oid = p.relnamespace AND np.nspname = 'public'
      WHERE c.contype = 'f'`,
  );
  return linhas.map((l) => ({
    nome: String(l.nome),
    filho: String(l.filho),
    pai: String(l.pai),
    colunas: Array.isArray(l.colunas) ? (l.colunas as string[]) : String(l.colunas).replace(/[{}]/g, "").split(","),
    cascata: l.tipo === "c",
  }));
}

/** Ordem de DELETE: filhos antes dos pais (só entre as tabelas da lista). */
export function ordemTopologica(tabelas: readonly string[], fks: Fk[]): string[] {
  const conjunto = new Set(tabelas);
  // arestas "o pai só sai depois do filho"; as em cascata se resolvem sozinhas
  // e só são largadas quando formam ciclo (participante <-> participante_email)
  const arestas = fks.filter((f) => f.filho !== f.pai && conjunto.has(f.filho) && conjunto.has(f.pai));
  const ordem: string[] = [];
  const pendentes = new Set(tabelas);
  let comCascata = true;
  while (pendentes.size) {
    const bloqueado = (t: string) =>
      arestas.some((f) => f.pai === t && pendentes.has(f.filho) && (comCascata || !f.cascata));
    const livre = tabelas.filter((t) => pendentes.has(t) && !bloqueado(t));
    if (!livre.length) {
      if (comCascata) {
        comCascata = false;
        continue;
      }
      throw new Error("ciclo de chaves estrangeiras entre as tabelas a apagar que a cascata não resolve");
    }
    for (const t of livre) {
      ordem.push(t);
      pendentes.delete(t);
    }
    comCascata = true;
  }
  return ordem;
}

export interface Pendencia {
  descricao: string;
}

/**
 * NENHUMA tabela fora da lista (e fora das tratadas) pode referenciar linhas
 * que serão apagadas; nenhum gatilho de DELETE/TRUNCATE nas tabelas apagadas;
 * todas as tabelas da lista existem.
 */
export async function conferirGrafo(tx: Executor): Promise<{ problemas: string[]; ordem: string[]; fks: Fk[] }> {
  const problemas: string[] = [];
  const existentes = new Set(
    (await consultar(tx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((l) => String(l.tablename)),
  );
  for (const t of [...TABELAS_APAGAR, ...Object.keys(TABELAS_PARCIAIS), DESVINCULAR.tabela, ...TABELAS_MANTIDAS]) {
    if (!existentes.has(t)) problemas.push(`a tabela '${t}' da lista não existe neste banco (esquema diferente do esperado)`);
  }
  if (problemas.length) return { problemas, ordem: [], fks: [] };

  const fks = await chavesEstrangeiras(tx);
  const total = new Set(TABELAS_APAGAR);
  const parciais = new Set(Object.keys(TABELAS_PARCIAIS));
  const tratadas = new Set([...total, ...parciais]);

  for (const f of fks) {
    if (f.filho === f.pai) continue;
    const colunasNaoNulas = f.colunas.map((c) => `"${c}" IS NOT NULL`).join(" AND ");
    if (total.has(f.pai) && !tratadas.has(f.filho)) {
      const n = await contar(tx, f.filho, colunasNaoNulas);
      if (n > 0 && !(f.filho === DESVINCULAR.tabela && f.colunas.join() === DESVINCULAR.coluna)) {
        problemas.push(
          `${f.filho}.${f.colunas.join(",")} referencia ${f.pai} (apagada) em ${n} linha(s): tabela fora da lista`,
        );
      }
    }
    if (parciais.has(f.pai) && !tratadas.has(f.filho)) {
      // quem aponta para as linhas que sairiam de uma tabela parcial (anexo, e-mail, pendência)
      const cols = f.colunas.length === 1 ? `"${f.colunas[0]}"` : null;
      if (cols) {
        const n = await contar(
          tx,
          f.filho,
          `${cols} IN (SELECT id FROM public."${f.pai}" WHERE ${TABELAS_PARCIAIS[f.pai]})`,
        );
        if (n > 0) problemas.push(`${f.filho}.${f.colunas[0]} referencia linhas de ${f.pai} que seriam apagadas (${n} linha(s))`);
      }
    }
  }

  const gatilhos = await consultar(
    tx,
    `SELECT c.relname AS tabela, t.tgname AS gatilho
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND ((t.tgtype & 8) <> 0 OR (t.tgtype & 32) <> 0)`,
  );
  const alvo = new Set([...total, ...parciais]);
  for (const g of gatilhos) {
    if (alvo.has(String(g.tabela))) {
      problemas.push(`a tabela ${g.tabela} tem o gatilho ${g.gatilho} em DELETE/TRUNCATE: a ferramenta não passa por cima de trava`);
    }
  }
  return { problemas, ordem: ordemTopologica(TABELAS_APAGAR, fks), fks };
}

// =====================================================================
// Contagens
// =====================================================================
export interface Contagens {
  /** linhas que serão apagadas, por tabela (parciais só as do filtro) */
  apagar: Record<string, number>;
  /** a contagem total das tabelas parciais, para conferir o que sobra */
  totalParcial: Record<string, number>;
  mantidas: Record<string, number>;
  modelosVinculados: number;
}

export async function contagens(tx: Executor): Promise<Contagens> {
  const apagar: Record<string, number> = {};
  const totalParcial: Record<string, number> = {};
  const mantidas: Record<string, number> = {};
  for (const t of TABELAS_APAGAR) apagar[t] = await contar(tx, t);
  for (const [t, onde] of Object.entries(TABELAS_PARCIAIS)) {
    apagar[t] = await contar(tx, t, onde);
    totalParcial[t] = await contar(tx, t);
  }
  for (const t of TABELAS_MANTIDAS) mantidas[t] = await contar(tx, t);
  const modelosVinculados = await contar(tx, DESVINCULAR.tabela, `"${DESVINCULAR.coluna}" IS NOT NULL`);
  return { apagar, totalParcial, mantidas, modelosVinculados };
}

export function totalAApagar(c: Contagens): number {
  return Object.values(c.apagar).reduce((a, b) => a + b, 0) + c.modelosVinculados;
}

// =====================================================================
// A execução (dentro de uma transação de quem chama)
// =====================================================================
export interface Resultado {
  antes: Contagens;
  depois: Contagens;
  ordem: string[];
  arquivoCopia: string | null;
  /** chaves do armazenamento que ficam órfãs (sem dado pessoal) */
  chaves: string[];
  idsCertificados: number[];
}

class Simulado extends Error {
  constructor(public resultado: Resultado) {
    super("simulação: rollback");
  }
}

const idsEm = (ids: number[]) => (ids.length ? ids.map((i) => Number(i)).join(",") : "NULL");

async function listarChaves(tx: Executor): Promise<{ chaves: string[]; idsCertificados: number[] }> {
  const chaves = new Set<string>();
  // blobs dos anexos do módulo, salvo se um anexo que fica usa o mesmo blob
  const { caminho_saida } = await import("../src/servicos/lista_presenca.js");
  const { chave_no_armazenamento } = await import("../src/servicos/anexos.js");
  const anexos = await consultar(
    tx,
    `SELECT DISTINCT storage_key FROM public.anexo WHERE (${TABELAS_PARCIAIS.anexo})
        AND storage_key NOT IN (SELECT storage_key FROM public.anexo WHERE NOT (${TABELAS_PARCIAIS.anexo}))`,
  );
  for (const a of anexos) chaves.add(chave_no_armazenamento(String(a.storage_key)));
  const certs = await consultar(tx, `SELECT id, arquivo_docx FROM public.certificado`);
  for (const c of certs) if (c.arquivo_docx) chaves.add(String(c.arquivo_docx));
  const turmas = await consultar(tx, `SELECT ano, codigo FROM public.turma`);
  for (const t of turmas) chaves.add(caminho_saida({ ano: Number(t.ano), codigo: String(t.codigo) }));
  return { chaves: [...chaves].sort(), idsCertificados: certs.map((c) => Number(c.id)) };
}

async function gravarCopia(tx: Executor, dir: string, identidade: string): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tabelas: Record<string, unknown> = {};
  const dump = async (t: string, onde?: string) => {
    const [l] = await consultar(
      tx,
      `SELECT coalesce(json_agg(x), '[]'::json) AS dados FROM public."${t}" x${onde ? ` WHERE ${onde}` : ""}`,
    );
    const bruto = l!.dados;
    tabelas[t] = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
  };
  for (const t of TABELAS_APAGAR) await dump(t);
  for (const [t, onde] of Object.entries(TABELAS_PARCIAIS)) await dump(t, onde);
  await dump(DESVINCULAR.tabela, `"${DESVINCULAR.coluna}" IS NOT NULL`);
  const agora = new Date();
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const arquivo = path.join(dir, `copia-treinamentos-${identidade.replace(/[^A-Za-z0-9._-]/g, "_")}-${carimbo}.json`);
  const conteudo = {
    aviso: "CONTÉM DADOS PESSOAIS (nomes, CPF, e-mails). Guarde em lugar seguro e apague quando não for mais necessária.",
    gerada_em: agora.toISOString(),
    banco: identidade,
    nota: "'certificado_modelo' lista só os modelos que estavam vinculados a um treinamento (a coluna treinamento_id foi zerada). Os arquivos (PDF/DOCX/blobs) não estão aqui.",
    tabelas,
  };
  writeFileSync(arquivo, JSON.stringify(conteudo), { mode: 0o600, flag: "wx" });
  chmodSync(arquivo, 0o600);
  return arquivo;
}

export function descricaoDoEvento(antes: Contagens): string {
  const partes = Object.entries(antes.apagar).map(([t, n]) => `${t}=${n}`);
  return (
    `Dados do módulo Certificados e Treinamentos apagados pela linha de comando ` +
    `(ferramentas/limpar-treinamentos.ts), com cópia local feita antes: ${partes.join(", ")}; ` +
    `modelos de certificado desvinculados de treinamento=${antes.modelosVinculados}. ` +
    `Mantidos: modelos de certificado, numeração, servidores, usuários, perfis, setores promotores, catálogos, EPI, processos e esta trilha.`
  );
}

/**
 * O trabalho, na transação de quem chama. Lança se algo não fecha (a transação
 * desfaz). `simular`: não grava a cópia e lança `Simulado` ao fim, para o
 * ROLLBACK.
 */
export async function executar(
  tx: Executor,
  o: { copia: string; simular: boolean; identidade: string },
): Promise<Resultado> {
  const auditoria = await import("../src/servicos/auditoria.js");
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '15s'`));
  const nomes = [...TABELAS_APAGAR, ...Object.keys(TABELAS_PARCIAIS), DESVINCULAR.tabela];
  await tx.execute(sql.raw(`LOCK TABLE ${nomes.map((t) => `public."${t}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`));

  const grafo = await conferirGrafo(tx);
  if (grafo.problemas.length) throw new Error(`grafo de chaves não confere:\n  - ${grafo.problemas.join("\n  - ")}`);
  const antes = await contagens(tx);
  const { chaves, idsCertificados } = await listarChaves(tx);
  const arquivoCopia = o.simular ? null : await gravarCopia(tx, o.copia, o.identidade);

  // 1. avisos e pendências ligados ao módulo (e-mail aponta para certificado/inscrição)
  for (const t of ["email_saida", "pendencia"]) {
    await tx.execute(sql.raw(`DELETE FROM public."${t}" WHERE ${TABELAS_PARCIAIS[t]}`));
  }
  // 2. os modelos ficam; só deixam de apontar para o treinamento que vai embora
  await tx.execute(
    sql.raw(`UPDATE public."${DESVINCULAR.tabela}" SET "${DESVINCULAR.coluna}" = NULL WHERE "${DESVINCULAR.coluna}" IS NOT NULL`),
  );
  // 3. anexos do módulo: o conjunto é fixado ANTES, porque o filtro olha as tabelas que vão sumir
  const [ids] = await consultar(
    tx,
    `SELECT coalesce(array_agg(id), '{}') AS ids FROM public.anexo WHERE ${TABELAS_PARCIAIS.anexo}`,
  );
  const idsAnexo = (Array.isArray(ids!.ids) ? ids!.ids : String(ids!.ids).replace(/[{}]/g, "").split(",").filter(Boolean)).map(Number);
  // 4. as tabelas do módulo, filhos antes dos pais
  for (const t of grafo.ordem) await tx.execute(sql.raw(`DELETE FROM public."${t}"`));
  // 5. os anexos, que dependiam de certificado e assinatura
  if (idsAnexo.length) await tx.execute(sql.raw(`DELETE FROM public.anexo WHERE id IN (${idsEm(idsAnexo)})`));

  // 6. a trilha: UM evento, pela via oficial
  await auditoria.registrar(tx, {
    entidade: "instalacao",
    entidade_id: 0,
    tipo_evento: TIPO_EVENTO,
    descricao: descricaoDoEvento(antes),
    usuario_nome: ATOR,
  });

  // 7. conferência: zerou o que devia, ficou o que devia
  const depois = await contagens(tx);
  const erros: string[] = [];
  for (const [t, n] of Object.entries(depois.apagar)) if (n !== 0) erros.push(`${t} ainda tem ${n} linha(s)`);
  if (depois.modelosVinculados !== 0) erros.push(`${DESVINCULAR.tabela} ainda aponta para treinamento em ${depois.modelosVinculados} linha(s)`);
  for (const [t, n] of Object.entries(antes.mantidas)) {
    const esperado = t === "historico_evento" ? n + 1 : n;
    if (depois.mantidas[t] !== esperado) erros.push(`${t}: eram ${n}, deveria ficar ${esperado}, ficou ${depois.mantidas[t]}`);
  }
  for (const [t, n] of Object.entries(antes.totalParcial)) {
    const esperado = n - antes.apagar[t]!;
    if (depois.totalParcial[t] !== esperado) erros.push(`${t}: deveria sobrar ${esperado}, sobrou ${depois.totalParcial[t]}`);
  }
  if (erros.length) throw new Error(`conferência final falhou (nada foi gravado):\n  - ${erros.join("\n  - ")}`);

  const resultado: Resultado = { antes, depois, ordem: grafo.ordem, arquivoCopia, chaves, idsCertificados };
  if (o.simular) throw new Simulado(resultado);
  return resultado;
}

// =====================================================================
// Armazenamento (depois do commit)
// =====================================================================
export interface RelatorioArmazenamento {
  encontrados: number;
  apagados: number;
  falhas: number;
}

export async function apagarOrfaos(
  chaves: string[],
  idsCertificados: number[],
  apagar: boolean,
): Promise<RelatorioArmazenamento> {
  const { obterArmazenamento } = await import("../src/servicos/armazenamento.js");
  const arm = obterArmazenamento();
  const todas = new Set(chaves);
  let falhas = 0;
  try {
    // PDFs em cache: `certificados-pdf/<id>-<resumo>.pdf`
    const ids = new Set(idsCertificados.map(String));
    for (const item of await arm.listar("certificados-pdf")) {
      const id = item.nome.split("-")[0] ?? "";
      if (ids.has(id)) todas.add(item.chave);
    }
  } catch {
    falhas += 1;
  }
  let encontrados = 0;
  let apagados = 0;
  for (const chave of todas) {
    try {
      if (!(await arm.existe(chave))) continue;
      encontrados += 1;
      if (apagar) {
        await arm.remover(chave);
        apagados += 1;
      }
    } catch {
      falhas += 1;
    }
  }
  return { encontrados, apagados, falhas };
}

// =====================================================================
// A linha de comando
// =====================================================================
function mostrar(saida: Saida, titulo: string, linhas: Record<string, number>) {
  saida.log(titulo);
  for (const [t, n] of Object.entries(linhas)) saida.log(`    ${t.padEnd(32)} ${String(n).padStart(8)}`);
}

export async function principal(argv: string[], saida: Saida = SAIDA_PADRAO): Promise<number> {
  carregarEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    saida.erro("DATABASE_URL ausente.");
    return 1;
  }
  const opcoes = lerOpcoes(argv);
  if (typeof opcoes === "string") {
    saida.erro(`ERRO: ${opcoes}`);
    saida.erro(USO);
    return 1;
  }
  const { identidadeDoBanco } = await import("../src/servicos/instalacao.js");
  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const identidade = identidadeDoBanco(url);
  const banco = abrirBancoAvulso(url);
  try {
    // 1. grafo + contagens, sem gravar nada
    const grafo = await conferirGrafo(banco.db);
    if (grafo.problemas.length) {
      saida.erro("ERRO: o grafo de chaves estrangeiras não confere com a lista. Nada foi alterado:");
      for (const p of grafo.problemas) saida.erro(`  - ${p}`);
      return 2;
    }
    const antes = await contagens(banco.db);

    saida.log("=".repeat(66));
    saida.log(` LIMPEZA DE TREINAMENTOS${opcoes.simular ? " — SIMULAÇÃO (rollback)" : ""}`);
    saida.log("=".repeat(66));
    saida.log(`  Banco (identidade): ${identidade}`);
    saida.log("");
    mostrar(saida, "  A APAGAR (linhas):", antes.apagar);
    saida.log(`    ${"modelos desvinculados".padEnd(32)} ${String(antes.modelosVinculados).padStart(8)}  (o modelo fica; só perde o treinamento)`);
    saida.log("");
    mostrar(saida, "  A MANTER (linhas):", antes.mantidas);
    saida.log("");

    if (totalAApagar(antes) === 0) {
      saida.log("Nada a apagar: o módulo já está vazio. Nada foi alterado.");
      return 0;
    }

    if (!opcoes.simular) {
      saida.log("ATENÇÃO: a cópia local conterá DADOS PESSOAIS (nome, CPF, e-mail). Guarde-a em lugar seguro.");
      saida.log(`  Pasta da cópia: ${opcoes.copia}`);
      const digitado =
        opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
      if (digitado.trim() !== identidade) {
        saida.erro("Confirmação não confere. Nada foi alterado.");
        return 3;
      }
    }

    // 2. a transação
    let resultado: Resultado;
    try {
      resultado = await banco.db.transaction((tx) =>
        executar(tx, { copia: opcoes.copia, simular: opcoes.simular, identidade }),
      );
    } catch (erro) {
      if (erro instanceof Simulado) {
        resultado = erro.resultado;
      } else {
        const msg = erro instanceof Error ? erro.message : String(erro);
        saida.erro(`ERRO: ${msg.split("\n\n")[0]}`);
        saida.erro("Nada foi gravado (a transação foi desfeita).");
        return 4;
      }
    }

    // 3. armazenamento
    let arm: RelatorioArmazenamento | null = null;
    try {
      arm = await apagarOrfaos(resultado.chaves, resultado.idsCertificados, !opcoes.simular);
    } catch {
      arm = null;
    }

    saida.log("");
    saida.log(`  Ordem dos DELETEs: e-mails e pendências do módulo, ${resultado.ordem.join(" > ")}, anexos do módulo.`);
    if (opcoes.simular) {
      saida.log("SIMULAÇÃO: tudo feito numa transação e DESFEITO (rollback). Nada foi gravado, nenhuma cópia nem arquivo mexido.");
      if (arm) saida.log(`  Arquivos órfãos no armazenamento que seriam apagados: ${arm.encontrados}`);
      saida.log("  Conferência dentro da transação: tudo zerou e o que fica ficou.");
      return arm && arm.falhas === 0 ? 0 : 5;
    }
    saida.log(`Cópia local gravada (permissão 600): ${resultado.arquivoCopia}`);
    saida.log("  Contém DADOS PESSOAIS: guarde em lugar seguro.");
    saida.log("Banco: apagado e conferido (1 evento DADOS_DE_TREINAMENTO_APAGADOS na trilha).");
    let codigo = 0;
    if (!arm) {
      saida.erro("ATENÇÃO: não foi possível limpar o armazenamento (o banco JÁ foi apagado). Arquivos órfãos ficaram.");
      codigo = 5;
    } else {
      saida.log(`Armazenamento: ${arm.apagados} arquivo(s) órfão(s) apagado(s) de ${arm.encontrados} encontrado(s).`);
      if (arm.falhas) {
        saida.erro(`ATENÇÃO: ${arm.falhas} falha(s) ao limpar o armazenamento (o banco JÁ foi apagado). Rode de novo não adianta: apague os arquivos à mão.`);
        codigo = 5;
      }
    }

    // 4. conferência final, fora da transação
    const depois = await contagens(banco.db);
    const sobra = Object.entries(depois.apagar).filter(([, n]) => n !== 0);
    if (sobra.length) {
      saida.erro(`ERRO: depois do commit ainda há linhas: ${sobra.map(([t, n]) => `${t}=${n}`).join(", ")}`);
      return 6;
    }
    mostrar(saida, "  Depois (mantidas):", depois.mantidas);
    saida.log("Conferido: tudo do módulo zerou e o que devia ficar ficou.");
    return codigo;
  } finally {
    await banco.fechar();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
