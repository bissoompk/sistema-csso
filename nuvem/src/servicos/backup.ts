/**
 * Backup cifrado e exportação completa. Porte de `app/servicos/backup.py`.
 *
 * Critério do EXPORTAR-TUDO: "desligue o sistema para sempre; com este zip o
 * setor trabalha amanhã".
 *
 * **O que mudou na nuvem (DESVIOS.md).** No Python o backup era o `VACUUM INTO`
 * do arquivo SQLite + as pastas `dados/anexos` e `dados/documentos`, cifrado
 * num `.enc` gravado em disco. Aqui não há arquivo de banco nem disco:
 *
 * - **O banco vai como dump lógico**: uma entrada `banco/<tabela>.json` por
 *   tabela do esquema `public`, gerada pelo próprio Postgres (`json_agg`) na
 *   transação da requisição — que é um retrato consistente (MVCC), o papel que o
 *   `VACUUM INTO` fazia. `restaurar_no_banco` devolve esse dump a um banco
 *   migrado e vazio (`json_populate_recordset`).
 * - **Os arquivos vão pelos anexos**: todo `anexo` (inclusive o comprovante de
 *   EPI assinado e o PDF do parecer assinado) entra em `anexos/<storage_key>`.
 *   Os documentos GERADOS (.docx do parecer, certificado, lista, comprovante)
 *   não entram: o armazenamento não se lista, e eles se regeneram do contexto
 *   congelado no banco — que vai inteiro.
 * - **O envelope cifrado é o MESMO** (`CSSOBK01` + sal + nonce + AES-256-GCM,
 *   PBKDF2-SHA256 com 390 mil iterações, o mágico como dado associado): o
 *   `decifrar` do Python abre um backup feito aqui, e vice-versa. O recheio é o
 *   zip de sempre, com `banco/` no lugar de `csso.db`.
 * - **O destino é o armazenamento** (`backups/…enc`, bucket privado do Supabase
 *   Storage), e não uma pasta: não há pasta. A trava de "nuvem sincronizada
 *   pessoal" (LGPD arts. 33-36, 39 e 46) continua valendo para quem passar um
 *   destino explícito. O Supabase faz o backup físico dele do Postgres; este é
 *   o backup do SETOR, que ele guarda e abre com a senha dele.
 * - **A exportação volta para o navegador** e fica uma cópia em
 *   `exportacoes/…zip` — como no Python, "uma cópia fica e não é apagada
 *   sozinha".
 *
 * O pacote inteiro passa pela memória (já era assim no Python) e a função tem
 * 60 s: é o teto que chega primeiro se o acervo de anexos crescer.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import PizZip from "pizzip";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  anexo as tabela_anexo,
  laudo_tecnico,
  parecer_tecnico,
  processo as tabela_processo,
  servidor as tabela_servidor,
  stg_planilha_parecer,
} from "../db/esquema/index.js";
import { UnidadeUorg } from "../dominio/organizacao.js";
import { RegraViolada } from "../nucleo/erros.js";
import { chave_no_armazenamento } from "./anexos.js";
import { ArquivoAusente, obterArmazenamento } from "./armazenamento.js";

export const MAGICO = Buffer.from("CSSOBK01", "latin1");
export const ITERACOES = 390_000;
export const ZIP_MAGICO = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** A pasta do dump lógico dentro do pacote (no Python: o arquivo `csso.db`). */
export const PASTA_BANCO = "banco";
export const PASTAS_DO_PACOTE = ["anexos", "documentos"] as const;
export const PREFIXO_BACKUP = "backups";
export const PREFIXO_EXPORTACAO = "exportacoes";

export const NUVENS_PROIBIDAS = ["onedrive", "dropbox", "google drive", "\\meu drive", "icloud"];

// CA-14: as 24 colunas rotuladas (A-X) na ordem e com os rótulos originais
export const CABECALHO_PLANILHA = [
  "Data da Solicitação no SEST",
  "Nº do Parecer",
  "Nome do Servidor",
  "Ano",
  "Data",
  "Laudo de ",
  "Unidade",
  "Posto de Trabalho",
  "UORG",
  "Tipo de Laudo",
  "Nº do Processo",
  "Matricula",
  "Cargo",
  "Função",
  "Laudo SIAPE",
  "Agente nocivo à saúde",
  "Tipo de Risco",
  "Percentual Aplicável",
  "Portaria de Localização",
  "Fundamentação Legal",
  "Alteração",
  "Recomendação Técnica:",
  "Reavaliação",
  "Pró Reitor",
];

export const LEIA_ME_EXPORT = `CONTEÚDO DESTE PACOTE
=====================
Pareceres.xlsx  — a planilha nas 24 colunas originais (A–X) + col_Y_sem_cabecalho
csv/            — CSVs UTF-8 com BOM e separador ';' (abrem direto no Excel pt-BR)
banco/          — o banco completo, uma tabela por arquivo JSON (dump lógico do
                  PostgreSQL; volta a um banco vazio com ferramentas/restaurar-backup.ts)
anexos/         — todos os arquivos anexados, nomeados pelo SHA-256

ATENÇÃO — DADOS PESSOAIS DE SERVIDORES (LGPD arts. 33-36, 39 e 46)
Este pacote contém dados pessoais. NÃO o coloque em nuvem pessoal ou de
terceiros. Qualquer destino em nuvem exige autorização formal da UFVJM e
contrato de operador.

O processo oficial é o SEI. Este sistema é apoio da CSSO.
`;

export class DestinoProibido extends RegraViolada {}

/** Senha do backup: `CSSO_BACKUP_SENHA` (o `backup_senha` do `config.py`). */
export function senha_padrao(): string {
  return process.env.CSSO_BACKUP_SENHA || "backup-inseguro-troque";
}

export interface ResultadoBackup {
  /** a chave no armazenamento (o `arquivo` do Python) */
  chave: string;
  nome: string;
  tamanho: number;
  cifrado: boolean;
  /** quantos arquivos de anexo entraram — "backup feito" sem este número escondeu o defeito por doze versões */
  arquivos: number;
  tabelas: number;
}

export function _conferir_destino(destino: string): void {
  const alvo = destino.toLowerCase();
  for (const nuvem of NUVENS_PROIBIDAS) {
    if (alvo.includes(nuvem)) {
      throw new DestinoProibido(
        `Destino em nuvem sincronizada (${nuvem}). Backup contém dados ` +
          "pessoais de servidores: use disco local ou rede institucional " +
          "(LGPD arts. 33-36, 39 e 46).",
      );
    }
  }
}

function _chave(senha: string, sal: Uint8Array): Buffer {
  return pbkdf2Sync(Buffer.from(senha, "utf8"), sal, ITERACOES, 32, "sha256");
}

/** `MAGICO + sal(16) + nonce(12) + AES-256-GCM(conteudo) + tag(16)` — o formato do Python. */
export function cifrar(conteudo: Uint8Array, senha: string): Uint8Array {
  const sal = randomBytes(16);
  const nonce = randomBytes(12);
  const cifra = createCipheriv("aes-256-gcm", _chave(senha, sal), nonce);
  cifra.setAAD(MAGICO);
  const corpo = Buffer.concat([cifra.update(conteudo), cifra.final(), cifra.getAuthTag()]);
  return new Uint8Array(Buffer.concat([MAGICO, sal, nonce, corpo]));
}

export function decifrar(pacote: Uint8Array, senha: string): Uint8Array {
  const b = Buffer.from(pacote);
  if (!b.subarray(0, 8).equals(MAGICO)) throw new RegraViolada("arquivo não é um backup do sistema CSSO");
  const sal = b.subarray(8, 24);
  const nonce = b.subarray(24, 36);
  const dados = b.subarray(36, b.length - 16);
  const tag = b.subarray(b.length - 16);
  const decifra = createDecipheriv("aes-256-gcm", _chave(senha, sal), nonce);
  decifra.setAAD(MAGICO);
  decifra.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decifra.update(dados), decifra.final()]));
}

function _carimbo(agora = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${agora.getUTCFullYear()}${p(agora.getUTCMonth() + 1)}${p(agora.getUTCDate())}-` +
    `${p(agora.getUTCHours())}${p(agora.getUTCMinutes())}${p(agora.getUTCSeconds())}`
  );
}

// ---------------------------------------------------------------------
// O dump lógico (o `VACUUM INTO` da nuvem)
// ---------------------------------------------------------------------
async function _tabelas(tx: Executor): Promise<string[]> {
  const linhas = (await tx.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )) as unknown as { tablename: string }[];
  return linhas.map((l) => l.tablename);
}

function _ident(nome: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) throw new Error(`nome de tabela inesperado: ${nome}`);
  return `"${nome}"`;
}

/**
 * `{tabela: texto JSON das linhas}` — o texto sai do Postgres e NÃO é
 * reparseado: `numeric` continua com as casas, `jsonb` da trilha continua com a
 * forma que o digest da cadeia conhece, `timestamptz` sai com fuso.
 */
export async function despejar_banco(tx: Executor): Promise<Map<string, string>> {
  const dump = new Map<string, string>();
  for (const tabela of await _tabelas(tx)) {
    const [linha] = (await tx.execute(
      sql.raw(`SELECT coalesce(json_agg(t), '[]'::json)::text AS j FROM ${_ident(tabela)} t`),
    )) as unknown as { j: string }[];
    dump.set(tabela, linha!.j);
  }
  return dump;
}

/**
 * Devolve o dump a um banco MIGRADO e VAZIO. Roda com
 * `session_replication_role = replica` — travas de append-only e chaves
 * estrangeiras não disparam durante a carga (a ordem entre tabelas deixa de
 * importar, e a trilha volta como era, não como uma trilha nova) — e depois
 * põe cada sequência de identidade no máximo carregado.
 */
export async function restaurar_no_banco(tx: Executor, dump: Map<string, string>): Promise<Record<string, number>> {
  const contagem: Record<string, number> = {};
  const existentes = new Set(await _tabelas(tx));
  await tx.execute(sql`SET LOCAL session_replication_role = replica`);
  for (const [tabela, texto] of dump) {
    if (!existentes.has(tabela)) continue;
    const linhas = (await tx.execute(
      sql`${sql.raw(`INSERT INTO ${_ident(tabela)} SELECT * FROM json_populate_recordset(NULL::${_ident(tabela)}, `)}${texto}::json) RETURNING 1`,
    )) as unknown as unknown[];
    contagem[tabela] = linhas.length;
  }
  await tx.execute(sql`SET LOCAL session_replication_role = origin`);
  const identidades = (await tx.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_identity = 'YES'`)) as unknown as { table_name: string; column_name: string }[];
  for (const { table_name, column_name } of identidades) {
    await tx.execute(
      sql.raw(
        `SELECT setval(pg_get_serial_sequence('${_ident(table_name)}', '${column_name}'), ` +
          `coalesce((SELECT max("${column_name}") FROM ${_ident(table_name)}), 0) + 1, false)`,
      ),
    );
  }
  return contagem;
}

/** Os anexos: `[nome no pacote, bytes]`. Blob ausente não derruba o backup — mas é contado fora. */
async function _arquivos_de_anexo(tx: Executor): Promise<{ arquivos: [string, Uint8Array][]; ausentes: string[] }> {
  const arm = obterArmazenamento();
  const vistos = new Set<string>();
  const arquivos: [string, Uint8Array][] = [];
  const ausentes: string[] = [];
  const linhas = await tx.select({ storage_key: tabela_anexo.storage_key }).from(tabela_anexo).orderBy(asc(tabela_anexo.id));
  for (const { storage_key } of linhas) {
    if (!storage_key || vistos.has(storage_key)) continue;
    vistos.add(storage_key);
    try {
      arquivos.push([`anexos/${storage_key}`, await arm.ler(chave_no_armazenamento(storage_key))]);
    } catch (erro) {
      if (!(erro instanceof ArquivoAusente)) throw erro;
      ausentes.push(storage_key);
    }
  }
  return { arquivos, ausentes };
}

/** Zip com o banco em `banco/` e os arquivos em `anexos/`. */
async function _empacotar(tx: Executor): Promise<{ pacote: Uint8Array; arquivos: number; tabelas: number }> {
  const zip = new PizZip();
  const dump = await despejar_banco(tx);
  for (const [tabela, texto] of dump) zip.file(`${PASTA_BANCO}/${tabela}.json`, texto);
  const { arquivos } = await _arquivos_de_anexo(tx);
  for (const [nome, bytes] of arquivos) zip.file(nome, bytes, { binary: true });
  const pacote = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as Uint8Array;
  return { pacote, arquivos: arquivos.length, tabelas: dump.size };
}

/**
 * Dump lógico + anexos, tudo cifrado, gravado no armazenamento.
 *
 * `destino` é o prefixo no armazenamento (padrão `backups`). A cópia em claro
 * só existe em memória: não há instante em que dado pessoal em claro fique no
 * destino do backup.
 */
export async function fazer_backup(
  tx: Executor,
  opcoes: { destino?: string; senha?: string } = {},
): Promise<ResultadoBackup> {
  const pasta = opcoes.destino ?? PREFIXO_BACKUP;
  _conferir_destino(pasta);
  const { pacote, arquivos, tabelas } = await _empacotar(tx);
  const cifrado = cifrar(pacote, opcoes.senha ?? senha_padrao());
  const nome = `csso-${_carimbo()}.enc`;
  const chave = `${pasta}/${nome}`;
  await obterArmazenamento().gravar(chave, cifrado, "application/octet-stream");
  return { chave, nome, tamanho: cifrado.length, cifrado: true, arquivos, tabelas };
}

export interface Restaurado {
  /** `{tabela: texto JSON}` — ou `null` quando o pacote é de um backup do Python (SQLite) */
  banco: Map<string, string> | null;
  /** o `.db` cru do SQLite, quando o pacote veio do sistema Python */
  sqlite: Uint8Array | null;
  /** `anexos/...` e `documentos/...` com os bytes */
  arquivos: Map<string, Uint8Array>;
}

/** Recusa nome de entrada que escape da pasta (`../`) — restaurar é o gesto que se faz às pressas. */
function _nome_seguro(nome: string): boolean {
  const partes = nome.split("/");
  return !nome.startsWith("/") && !nome.includes("\\") && partes.every((p) => p !== ".." && p !== "");
}

/**
 * Abre o pacote: devolve o banco e os arquivos. Lê também o recheio dos
 * backups do Python — o `.db` cru (até a 1.30.0) e o zip com `csso.db` — para
 * que nenhum backup existente deixe de abrir.
 */
export function restaurar(pacote: Uint8Array, senha: string = senha_padrao()): Restaurado {
  const conteudo = Buffer.from(decifrar(pacote, senha));
  if (!conteudo.subarray(0, 4).equals(ZIP_MAGICO)) {
    // backup do Python até a 1.30.0: o recheio é o `.db` cru, sem anexo nenhum
    return { banco: null, sqlite: new Uint8Array(conteudo), arquivos: new Map() };
  }
  const zip = new PizZip(conteudo);
  const banco = new Map<string, string>();
  let sqlite: Uint8Array | null = null;
  const arquivos = new Map<string, Uint8Array>();
  for (const nome of Object.keys(zip.files).sort()) {
    const entrada = zip.files[nome]!;
    if (entrada.dir) continue;
    if (!_nome_seguro(nome)) throw new RegraViolada(`caminho fora do destino no pacote de backup: ${nome}`);
    if (nome === "csso.db") sqlite = entrada.asUint8Array();
    else if (nome.startsWith(`${PASTA_BANCO}/`) && nome.endsWith(".json")) {
      banco.set(nome.slice(PASTA_BANCO.length + 1, -5), entrada.asText());
    } else if ((PASTAS_DO_PACOTE as readonly string[]).includes(nome.split("/", 1)[0]!)) {
      arquivos.set(nome, entrada.asUint8Array());
    }
  }
  return { banco: banco.size ? banco : null, sqlite, arquivos };
}

// ---------------------------------------------------------------------
// Exportação completa
// ---------------------------------------------------------------------
function _t(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export async function _linhas_planilha(tx: Executor): Promise<string[][]> {
  const pareceres = await tx.query.parecer_tecnico.findMany({
    orderBy: [asc(parecer_tecnico.ano), asc(parecer_tecnico.numero)],
    with: {
      processo: true,
      servidor: { with: { cargo: true } },
      tipo_movimento: true,
      unidade: true,
      postos: { with: { posto: true } },
      tipo_adicional: true,
      laudo: true,
      exposicoes: {
        with: { agente_nocivo: { with: { tipo_risco: true } }, percentual: true, fundamentacao: true },
      },
      portaria: true,
      destinatario: true,
    },
  });
  const linhas: string[][] = [];
  for (const p of pareceres) {
    const principal = p.exposicoes.find((e) => e.principal) ?? null;
    const postos = [...p.postos]
      .sort((a, b) => a.ordem - b.ordem)
      .map((pp) => pp.posto.nome)
      .join(" / ");
    const [orfa] = await tx
      .select({ y: stg_planilha_parecer.col_Y_sem_cabecalho })
      .from(stg_planilha_parecer)
      .where(
        and(
          isNotNull(stg_planilha_parecer.arquivo),
          eq(stg_planilha_parecer.col_b_numero_parecer, String(p.numero)),
          eq(stg_planilha_parecer.col_d_ano, String(p.ano)),
        ),
      )
      .limit(1);
    linhas.push([
      _t(p.processo?.data_solicitacao_sest),
      String(p.numero),
      _t(p.servidor?.nome),
      String(p.ano),
      _t(p.data_emissao),
      _t(p.tipo_movimento?.nome),
      _t(p.unidade?.nome_extenso),
      postos,
      p.unidade ? UnidadeUorg.uorg_bruto(p.unidade) : "",
      _t(p.tipo_adicional?.nome),
      _t(p.processo?.nup),
      _t(p.servidor?.siape),
      p.cargo_snapshot || _t(p.servidor?.cargo?.nome),
      _t(p.funcao_snapshot),
      _t(p.laudo?.numero_siape),
      _t(principal?.agente_nocivo?.descricao),
      _t(principal?.agente_nocivo?.tipo_risco?.nome),
      _t(principal?.percentual?.rotulo),
      _t(p.portaria?.texto_original),
      _t(principal?.fundamentacao?.texto),
      _t(p.texto_alteracao),
      _t(p.texto_recomendacao),
      _t(p.texto_reavaliacao),
      _t(p.destinatario?.nome),
      _t(orfa?.y),
    ]);
  }
  return linhas;
}

/** O `csv.writer(delimiter=';', QUOTE_MINIMAL)` do Python, com BOM (Excel pt-BR). */
export function _csv_bytes(cabecalho: string[], linhas: string[][]): Uint8Array {
  const campo = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const texto = [cabecalho, ...linhas].map((l) => l.map(campo).join(";") + "\r\n").join("");
  return new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texto, "utf8")]));
}

async function _planilha_bytes(linhas: string[][]): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Planilha1");
  ws.addRow([...CABECALHO_PLANILHA, "col_Y_sem_cabecalho"]);
  for (const linha of linhas) ws.addRow(linha);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export interface ResultadoExportacao {
  chave: string;
  nome: string;
  bytes: Uint8Array;
}

/** O zip EM CLARO com tudo. Uma cópia fica no armazenamento (`exportacoes/`). */
export async function exportar_tudo(tx: Executor, opcoes: { destino?: string } = {}): Promise<ResultadoExportacao> {
  const pasta = opcoes.destino ?? PREFIXO_EXPORTACAO;
  _conferir_destino(pasta);
  const nome = `csso-export-${_carimbo()}.zip`;

  const linhas = await _linhas_planilha(tx);
  const zip = new PizZip();
  zip.file("LEIA-ME-DO-EXPORT.txt", LEIA_ME_EXPORT);
  zip.file("Pareceres.xlsx", await _planilha_bytes(linhas), { binary: true });
  zip.file("csv/pareceres.csv", _csv_bytes([...CABECALHO_PLANILHA, "col_Y_sem_cabecalho"], linhas), { binary: true });

  const processos = await tx.query.processo.findMany({
    orderBy: [asc(tabela_processo.nup)],
    with: { servidor: true, unidade: true },
  });
  zip.file(
    "csv/processos.csv",
    _csv_bytes(
      ["NUP", "Estado", "Situação", "Servidor", "SIAPE", "Unidade", "Autuação"],
      processos.map((p) => [
        p.nup,
        p.estado_tecnico,
        p.situacao,
        _t(p.servidor?.nome),
        _t(p.servidor?.siape),
        _t(p.unidade?.nome_extenso),
        _t(p.data_autuacao),
      ]),
    ),
    { binary: true },
  );
  const laudos = await tx.query.laudo_tecnico.findMany({
    orderBy: [asc(laudo_tecnico.numero_siape)],
    with: { unidade: true, subscritor: true },
  });
  zip.file(
    "csv/laudos.csv",
    _csv_bytes(
      ["Nº SIAPE", "Unidade", "Subscritor", "Emissão", "Última conferência", "Status"],
      laudos.map((l) => [
        l.numero_siape,
        _t(l.unidade?.nome_extenso),
        _t(l.subscritor?.nome),
        _t(l.data_emissao),
        _t(l.data_ultima_conferencia),
        l.status,
      ]),
    ),
    { binary: true },
  );
  const servidores = await tx.query.servidor.findMany({
    orderBy: [asc(tabela_servidor.nome)],
    with: { cargo: true, unidade: true },
  });
  zip.file(
    "csv/servidores.csv",
    _csv_bytes(
      ["SIAPE", "Nome", "Cargo", "Unidade", "Situação"],
      servidores.map((sv) => [sv.siape, sv.nome, _t(sv.cargo?.nome), _t(sv.unidade?.nome_extenso), sv.situacao]),
    ),
    { binary: true },
  );

  // o banco inteiro, no mesmo formato do backup: é o que o `restaurar-backup` lê
  for (const [tabela, texto] of await despejar_banco(tx)) zip.file(`${PASTA_BANCO}/${tabela}.json`, texto);
  const { arquivos } = await _arquivos_de_anexo(tx);
  for (const [nome_arquivo, bytes] of arquivos) zip.file(nome_arquivo, bytes, { binary: true });

  const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as Uint8Array;
  const chave = `${pasta}/${nome}`;
  await obterArmazenamento().gravar(chave, bytes, "application/zip");
  return { chave, nome, bytes };
}
