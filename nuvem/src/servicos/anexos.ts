/**
 * RN-12 — anexos com dedup por SHA-256 e blob compartilhado.
 * Porte de `app/servicos/anexos.py`.
 *
 * O blob é endereçado pelo conteúdo (`<sha[:2]>/<sha>`, o mesmo
 * `storage_key` do Python) e mora no armazenamento (`armazenamento.ts`:
 * Supabase Storage na nuvem, pasta local em desenvolvimento), sob o prefixo
 * `anexos/`. O mesmo arquivo anexado a dois processos ocupa um blob só.
 *
 * **Desvio: limite de tamanho** (ver DESVIOS.md). O Python não tinha limite —
 * o arquivo chegava pela rede local do setor. Na nuvem o corpo da requisição
 * da função do Netlify para em 6 MB, e o binário do multipart chega à função
 * codificado (≈4,5 MB úteis). Arquivo acima de `LIMITE_BYTES` é recusado aqui
 * com a saída escrita, em vez de estourar como 500 sem explicação.
 */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { anexo as tabela_anexo } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import { obterArmazenamento } from "./armazenamento.js";
import type { UsuarioAtual } from "./rbac.js";
import { slug_ascii } from "./textos.js";

export type Anexo = typeof tabela_anexo.$inferSelect;

// O que se anexa a um processo do adicional ocupacional. É o que a tela do
// processo oferece.
export const CATEGORIAS_PROCESSO = [
  "PARECER_ASSINADO",
  "LAUDO",
  "PORTARIA",
  "DESPACHO",
  "FORMULARIO",
  "RELATORIO_CAMPO",
  "FOTO",
  "OUTRO",
] as const;

// Categoria não é rótulo: é ela que decide QUANDO o arquivo pode ser
// eliminado (`docs/POLITICA_RETENCAO.md` §2.1) — daí RUBRICA_INSTRUTOR ter
// nome próprio em vez de 'FOTO'.
export const CATEGORIAS_EPI = ["MANUAL_EPI", "FICHA_EPI"] as const;
export const CATEGORIAS_CERTIFICADOS = ["RUBRICA_INSTRUTOR", "LISTA_PRESENCA", "CERTIFICADO"] as const;
export const CATEGORIAS_ACIDENTES = ["CAT_SP", "RELATORIO_INVESTIGACAO", "EVIDENCIA_ACIDENTE"] as const;

// O conjunto que `guardar` aceita e que `ck_anexo_cat` admite — as duas listas
// têm de casar, e um teste compara. A lista do CHECK é a de `dominio/auditoria`.
export const CATEGORIAS: readonly string[] = [
  ...CATEGORIAS_PROCESSO,
  ...CATEGORIAS_EPI,
  ...CATEGORIAS_CERTIFICADOS,
  ...CATEGORIAS_ACIDENTES,
];

// Categoria que nasce restrita: o documento nomeia pessoa e diz algo sobre a
// condição dela no trabalho.
export const NIVEL_POR_CATEGORIA: Readonly<Record<string, string>> = {
  FORMULARIO: "RESTRITO",
  FICHA_EPI: "RESTRITO",
  LISTA_PRESENCA: "RESTRITO",
  CERTIFICADO: "RESTRITO",
  CAT_SP: "RESTRITO",
  RELATORIO_INVESTIGACAO: "RESTRITO",
  EVIDENCIA_ACIDENTE: "RESTRITO",
};

/**
 * O teto do arquivo na nuvem: 4 MB. Abaixo do corpo máximo da função do
 * Netlify (6 MB, ≈4,5 MB de binário depois da codificação) com folga para os
 * outros campos do formulário.
 */
export const LIMITE_BYTES = 4 * 1024 * 1024;

export class AnexoGrandeDemais extends RegraViolada {
  constructor(public tamanho: number) {
    super(
      `O arquivo tem ${(tamanho / 1024 / 1024).toFixed(1).replace(".", ",")} MB e o limite é ` +
        `${LIMITE_BYTES / 1024 / 1024} MB por arquivo nesta instalação. ` +
        "Reduza o PDF (\"Salvar como PDF reduzido\" ou imprimir em PDF com qualidade menor) " +
        "ou divida-o em partes, e envie de novo.",
    );
  }
}

export interface ResultadoAnexo {
  anexo: Anexo;
  duplicado: boolean;
  tambem_em: number;
}

export function digerir(conteudo: Uint8Array): string {
  return createHash("sha256").update(conteudo).digest("hex");
}

/** O `storage_key` do blob — o mesmo formato do Python (`ab/abcdef...`). */
export function chave_do_blob(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`sha256 invalido: ${sha256}`);
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/** A chave no armazenamento: o `storage_key` sob o prefixo `anexos/`. */
export function chave_no_armazenamento(storage_key: string): string {
  return `anexos/${storage_key}`;
}

/** `Path(nome).stem` e `.suffix` do Python. */
function haste_e_sufixo(nome: string): [string, string] {
  const base = nome.split("/").pop() ?? nome;
  const i = base.lastIndexOf(".");
  if (i > 0 && i < base.length - 1) return [base.slice(0, i), base.slice(i)];
  return [base, ""];
}

export async function guardar(
  tx: Executor,
  d: {
    entidade: string;
    entidade_id: number;
    nome_original: string;
    conteudo: Uint8Array;
    mime_type: string;
    categoria: string;
    usuario: UsuarioAtual;
    processo_id?: number | null;
    numero_documento_sei?: string | null;
    assinado?: boolean;
    origem_migracao?: string | null;
    origem_ref?: string | null;
  },
): Promise<ResultadoAnexo> {
  if (!CATEGORIAS.includes(d.categoria)) throw new RegraViolada(`categoria inválida: ${d.categoria}`);
  if (d.conteudo.byteLength > LIMITE_BYTES) throw new AnexoGrandeDemais(d.conteudo.byteLength);

  const sha256 = digerir(d.conteudo);

  const [existente] = await tx
    .select()
    .from(tabela_anexo)
    .where(
      and(
        eq(tabela_anexo.entidade, d.entidade),
        eq(tabela_anexo.entidade_id, d.entidade_id),
        eq(tabela_anexo.sha256, sha256),
      ),
    );
  if (existente) {
    await auditoria.registrar(tx, {
      entidade: "anexo",
      entidade_id: existente.id,
      processo_id: d.processo_id ?? null,
      tipo_evento: auditoria.ANEXO_DUPLICADO,
      descricao:
        `Arquivo '${d.nome_original}' ignorado: já anexado como ` +
        `'${existente.nome_original}' (mesmo SHA-256).`,
      usuario: d.usuario,
    });
    return { anexo: existente, duplicado: true, tambem_em: await quantos_processos(tx, sha256) };
  }

  if (d.categoria === "PARECER_ASSINADO") {
    await tx
      .update(tabela_anexo)
      .set({ ativo: false })
      .where(
        and(
          eq(tabela_anexo.entidade, d.entidade),
          eq(tabela_anexo.entidade_id, d.entidade_id),
          eq(tabela_anexo.categoria, "PARECER_ASSINADO"),
          eq(tabela_anexo.ativo, true),
        ),
      );
  }

  const storage_key = chave_do_blob(sha256);
  const armazenamento = obterArmazenamento();
  const chave = chave_no_armazenamento(storage_key);
  if (!(await armazenamento.existe(chave))) {
    await armazenamento.gravar(chave, d.conteudo, d.mime_type || "application/octet-stream");
  }

  const [haste, sufixo] = haste_e_sufixo(d.nome_original);
  const [anexo] = await tx
    .insert(tabela_anexo)
    .values({
      entidade: d.entidade,
      entidade_id: d.entidade_id,
      nome_arquivo: [...slug_ascii(haste)].slice(0, 200).join("") + sufixo.toLowerCase(),
      nome_original: d.nome_original,
      mime_type: d.mime_type || "application/octet-stream",
      tamanho_bytes: d.conteudo.byteLength,
      sha256,
      storage_key,
      categoria: d.categoria,
      nivel_acesso: NIVEL_POR_CATEGORIA[d.categoria] ?? "PUBLICO",
      numero_documento_sei: d.numero_documento_sei ?? null,
      assinado: d.assinado ?? false,
      origem_migracao: d.origem_migracao ?? null,
      origem_ref: d.origem_ref ?? null,
      enviado_por: d.usuario.id,
    })
    .returning();

  await auditoria.registrar(tx, {
    entidade: "anexo",
    entidade_id: anexo!.id,
    processo_id: d.processo_id ?? null,
    tipo_evento: "ANEXO_ENVIADO",
    descricao: `'${d.nome_original}' (${d.categoria}, ${d.conteudo.byteLength} bytes).`,
    usuario: d.usuario,
  });
  return { anexo: anexo!, duplicado: false, tambem_em: await quantos_processos(tx, sha256) };
}

/** O `guardar_arquivo` do Python, a partir do `File` do formulário. */
export async function guardar_arquivo(
  tx: Executor,
  arquivo: File,
  d: Omit<Parameters<typeof guardar>[1], "conteudo" | "nome_original" | "mime_type"> & { mime_type?: string },
): Promise<ResultadoAnexo> {
  // recusa antes de ler: o `File` já está na memória, mas não precisa virar
  // uma segunda cópia para ser recusado
  if (arquivo.size > LIMITE_BYTES) throw new AnexoGrandeDemais(arquivo.size);
  return guardar(tx, {
    ...d,
    conteudo: new Uint8Array(await arquivo.arrayBuffer()),
    nome_original: arquivo.name,
    mime_type: d.mime_type ?? arquivo.type,
  });
}

async function quantos_processos(tx: Executor, sha256: string): Promise<number> {
  const linhas = await tx
    .select({ entidade: tabela_anexo.entidade, entidade_id: tabela_anexo.entidade_id })
    .from(tabela_anexo)
    .where(eq(tabela_anexo.sha256, sha256));
  return new Set(linhas.map((l) => `${l.entidade}\u0000${l.entidade_id}`)).size;
}

export async function listar(tx: Executor, entidade: string, entidade_id: number): Promise<Anexo[]> {
  return tx
    .select()
    .from(tabela_anexo)
    .where(
      and(eq(tabela_anexo.entidade, entidade), eq(tabela_anexo.entidade_id, entidade_id), eq(tabela_anexo.ativo, true)),
    )
    .orderBy(desc(tabela_anexo.enviado_em));
}

/** O conteúdo do anexo (o `caminho_absoluto` + `read_bytes` do Python). */
export async function ler_conteudo(anexo: Pick<Anexo, "storage_key">): Promise<Uint8Array> {
  return obterArmazenamento().ler(chave_no_armazenamento(anexo.storage_key));
}

/** O conteúdo do blob pelo SHA-256 (a rubrica do certificado). */
export async function ler_blob(sha256: string): Promise<Uint8Array> {
  return obterArmazenamento().ler(chave_no_armazenamento(chave_do_blob(sha256)));
}

export async function blob_existe(sha256: string): Promise<boolean> {
  return obterArmazenamento().existe(chave_no_armazenamento(chave_do_blob(sha256)));
}
