/**
 * Fatia C da paridade com o IntegraSST — a foto e o PDF de orientação de um
 * item do catálogo de EPI (`L:EPI_Backend.js:5-47`, `L:EPI_Frontend.html:380-464`).
 *
 * O que muda em relação ao legado:
 *
 * 1. **Sem link público.** O legado subia o arquivo numa pasta do Drive e o
 *    compartilhava com "qualquer pessoa com o link". Aqui o arquivo fica no
 *    Storage (`anexos.guardar`, categoria `EPI_CATALOGO`) e só sai por rota
 *    com login (`/epis/catalogo/{id}/imagem` e `/orientacao`).
 * 2. **O tipo é o dos BYTES.** A extensão e o `File.type` vêm de quem envia;
 *    um texto chamado `manual.pdf` entraria como PDF. Conferimos a assinatura
 *    do arquivo (`%PDF-`, PNG, JPEG, WEBP), como no comprovante da ficha.
 * 3. **Trocar não apaga.** O anexo antigo continua existindo; o item passa a
 *    apontar para o novo. É o que deixa a ficha antiga no PDF que valia no dia
 *    da entrega (`epi_ficha_registro.orientacao_anexo_id`, Decisão 4).
 * 4. **Formulário sem arquivo novo mantém o atual** (`L:EPI_Frontend.html:1038-1058`).
 * 5. **Um arquivo por requisição.** Foto e PDF têm envios separados
 *    (`POST /epis/catalogo/{id}/imagem` e `/orientacao`), para nenhum corpo
 *    passar dos 6 MB da função do Netlify; a edição do item não leva arquivo.
 */
import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  anexo as tabela_anexo,
  epi_ficha_registro,
  epi_item,
} from "../db/esquema/index.js";
import {
  ENTIDADE_ANEXO_EPI_ITEM,
  EPI_CATALOGO_IMAGEM_MAX_BYTES,
  EPI_CATALOGO_IMAGEM_TIPOS,
  EPI_CATALOGO_PDF_MAX_BYTES,
} from "../dominio/epi.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexos from "./anexos.js";
import type { Anexo } from "./anexos.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export const EPI_ITEM_IMAGEM_ENVIADA = "EPI_ITEM_IMAGEM_ENVIADA";
export const EPI_ITEM_ORIENTACAO_ENVIADA = "EPI_ITEM_ORIENTACAO_ENVIADA";
export const CATEGORIA_ANEXO = "EPI_CATALOGO";

type EpiItem = typeof epi_item.$inferSelect;

/** Arquivo recusado na conferência — nada foi gravado. */
export class ArquivoDoCatalogoRecusado extends RegraViolada {
  constructor(
    mensagem: string,
    /** o campo do formulário que falhou: a tela o marca */
    public campo: "imagem" | "orientacao",
  ) {
    super(mensagem);
  }
}

export interface ArquivoEnviado {
  conteudo: Uint8Array;
  nome_original: string;
}

function _megas(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function _comeca(
  conteudo: Uint8Array,
  assinatura: readonly number[],
  desde = 0,
): boolean {
  return (
    conteudo.byteLength >= desde + assinatura.length &&
    assinatura.every((b, i) => conteudo[desde + i] === b)
  );
}

/**
 * O tipo da imagem pelos PRIMEIROS BYTES: PNG, JPEG ou WEBP (`RIFF....WEBP`).
 * Qualquer outra coisa é `null` — inclusive SVG, que é texto e carrega script.
 */
export function tipo_da_imagem(
  conteudo: Uint8Array,
): (typeof EPI_CATALOGO_IMAGEM_TIPOS)[number] | null {
  if (_comeca(conteudo, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (_comeca(conteudo, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    _comeca(conteudo, [0x52, 0x49, 0x46, 0x46]) &&
    _comeca(conteudo, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  return null;
}

/** `%PDF-` no começo do arquivo. */
export function eh_pdf(conteudo: Uint8Array): boolean {
  return _comeca(conteudo, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

/** Confere a foto e devolve o tipo dos bytes — ou levanta, sem gravar nada. */
export function conferir_imagem(a: ArquivoEnviado): string {
  if (!a.conteudo.byteLength)
    throw new ArquivoDoCatalogoRecusado("A foto enviada veio vazia.", "imagem");
  if (a.conteudo.byteLength > EPI_CATALOGO_IMAGEM_MAX_BYTES) {
    throw new ArquivoDoCatalogoRecusado(
      `A foto tem ${_megas(a.conteudo.byteLength)} e o limite é ${_megas(EPI_CATALOGO_IMAGEM_MAX_BYTES)}. ` +
        "Reduza a imagem (uma foto de celular redimensionada para 1200 px basta) e envie de novo.",
      "imagem",
    );
  }
  const tipo = tipo_da_imagem(a.conteudo);
  if (tipo === null) {
    throw new ArquivoDoCatalogoRecusado(
      "A foto não é uma imagem JPEG, PNG ou WEBP (o conteúdo do arquivo foi conferido, não só o nome). Nada foi gravado.",
      "imagem",
    );
  }
  return tipo;
}

/** Confere o PDF de orientação — ou levanta, sem gravar nada. */
export function conferir_orientacao(a: ArquivoEnviado): string {
  if (!a.conteudo.byteLength)
    throw new ArquivoDoCatalogoRecusado(
      "O PDF de orientação veio vazio.",
      "orientacao",
    );
  if (a.conteudo.byteLength > EPI_CATALOGO_PDF_MAX_BYTES) {
    throw new ArquivoDoCatalogoRecusado(
      `O PDF de orientação tem ${_megas(a.conteudo.byteLength)} e o limite é ${_megas(EPI_CATALOGO_PDF_MAX_BYTES)}. ` +
        "Reduza o PDF (imprimir em PDF com qualidade menor) e envie de novo.",
      "orientacao",
    );
  }
  if (!eh_pdf(a.conteudo)) {
    throw new ArquivoDoCatalogoRecusado(
      "O arquivo de orientação não é um PDF (o conteúdo do arquivo foi conferido, não só o nome). Nada foi gravado.",
      "orientacao",
    );
  }
  return "application/pdf";
}

/** Qual dos dois arquivos do item: a foto ou o PDF de orientação. */
export type QualArquivo = "imagem" | "orientacao";

/**
 * Guarda UM arquivo do item: a foto OU o PDF de orientação — nunca os dois na
 * mesma chamada. Cada um tem o seu envio (e a sua requisição): a função do
 * Netlify recusa corpo acima de 6 MB, e foto (2 MB) + PDF (4 MB) + o resto do
 * multipart passavam disso. O arquivo é conferido ANTES de gravar; o anexo
 * antigo nunca é apagado — o item só passa a apontar para o novo.
 */
export async function enviar(
  tx: Executor,
  usuario: UsuarioAtual,
  item: EpiItem,
  qual: QualArquivo,
  arquivo: ArquivoEnviado,
): Promise<Anexo> {
  usuario.exigir("epi.catalogo");
  if (qual === "imagem") {
    const tipo = conferir_imagem(arquivo);
    return _trocar(tx, usuario, item, arquivo, tipo, "imagem_anexo_id");
  }
  const tipo = conferir_orientacao(arquivo);
  return _trocar(tx, usuario, item, arquivo, tipo, "orientacao_anexo_id");
}

async function _trocar(
  tx: Executor,
  usuario: UsuarioAtual,
  item: EpiItem,
  arquivo: ArquivoEnviado,
  mime_type: string,
  coluna: "imagem_anexo_id" | "orientacao_anexo_id",
): Promise<Anexo> {
  const resultado = await anexos.guardar(tx, {
    entidade: ENTIDADE_ANEXO_EPI_ITEM,
    entidade_id: item.id,
    nome_original: arquivo.nome_original,
    conteudo: arquivo.conteudo,
    // o tipo dos bytes, e não o que o navegador disse
    mime_type,
    categoria: CATEGORIA_ANEXO,
    usuario,
  });
  const anterior = item[coluna];
  const novo = resultado.anexo.id;
  if (anterior === novo) return resultado.anexo;
  await tx
    .update(epi_item)
    .set({ [coluna]: novo })
    .where(eq(epi_item.id, item.id));
  item[coluna] = novo;
  const foto = coluna === "imagem_anexo_id";
  await auditoria.registrar(tx, {
    entidade: "epi_item",
    entidade_id: item.id,
    tipo_evento: foto ? EPI_ITEM_IMAGEM_ENVIADA : EPI_ITEM_ORIENTACAO_ENVIADA,
    descricao:
      `${foto ? "Foto" : "PDF de orientação"} de '${item.nome}' ` +
      `${anterior === null ? "enviado" : "trocado"} · anexo ${novo} ` +
      `· SHA-256 ${resultado.anexo.sha256.slice(0, 12)}` +
      (anterior === null ? "" : ` (o anexo ${anterior} continua guardado)`),
    campo: coluna,
    valor_anterior: anterior,
    valor_novo: novo,
    usuario,
  });
  return resultado.anexo;
}

/**
 * Quem pode ver a foto e o PDF de orientação: quem lê o catálogo
 * (`epi.ver`), quem pede EPI (`epi.requisitar`) e o titular de uma ficha.
 * O arquivo não nomeia ninguém, mas não é público: fica atrás do login.
 */
export async function pode_ler(
  tx: Executor,
  usuario: UsuarioAtual,
): Promise<boolean> {
  if (usuario.pode("epi.ver") || usuario.pode("epi.requisitar")) return true;
  if (usuario.servidor_id === null) return false;
  const [linha] = await tx
    .select({ id: epi_ficha_registro.id })
    .from(epi_ficha_registro)
    .where(eq(epi_ficha_registro.servidor_id, usuario.servidor_id))
    .limit(1);
  return Boolean(linha);
}

/** O anexo vigente do item (foto ou PDF), ou `null`. Só anexo do próprio item. */
export async function anexo_vigente(
  tx: Executor,
  item: EpiItem,
  qual: "imagem" | "orientacao",
): Promise<Anexo | null> {
  const id =
    qual === "imagem" ? item.imagem_anexo_id : item.orientacao_anexo_id;
  if (id === null) return null;
  return anexo_do_catalogo(tx, id);
}

/** Um anexo do catálogo pelo id — só se for mesmo do catálogo (`entidade = epi_item`). */
export async function anexo_do_catalogo(
  tx: Executor,
  id: number,
): Promise<Anexo | null> {
  const [anexo] = await tx
    .select()
    .from(tabela_anexo)
    .where(
      and(
        eq(tabela_anexo.id, id),
        eq(tabela_anexo.entidade, ENTIDADE_ANEXO_EPI_ITEM),
      ),
    );
  return anexo ?? null;
}
