/**
 * Entrevistas e evidências da investigação (fatia F4).
 *
 * - **Gravação só com consentimento registrado.** Sem a caixa "consentimento
 *   obtido" a entrevista é recusada se trouxer áudio; com ela, fica gravado
 *   quem registrou o consentimento (o banco também confere, por CHECK). O
 *   legado mostrava o aviso e não registrava nada.
 * - **Tipo pelos bytes.** O tipo do arquivo é o que os primeiros bytes dizem,
 *   não o que o navegador declara: áudio em WebM, Ogg, WAV, MP3 ou MP4/M4A;
 *   evidência em PDF, PNG, JPEG, GIF ou WebP. Teto de 4 MB por arquivo (o da
 *   função na nuvem, `anexos.LIMITE_BYTES`).
 * - **Restrito.** Relato e arquivos são dado de terceiro, de guarda permanente:
 *   o anexo nasce na categoria `EVIDENCIA_ACIDENTE` (RESTRITO), que só quem
 *   investiga ou encaminha ao SIASS baixa (`anexo_acesso.dono_acidente`).
 *   Foto de lesão não entra: a tela avisa, e o médico do trabalho é quem trata
 *   de saúde.
 * - **Trilha sem nome.** Os eventos dizem o protocolo e o que foi registrado,
 *   nunca quem foi entrevistado nem o que disse.
 */
import { asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_entrevista, acidente_evidencia, anexo as tabela_anexo } from "../db/esquema/index.js";
import { VINCULOS_ACIDENTADO } from "../dominio/acidente.js";
import { ComunicacaoRecusada, type Ocorrencia } from "./acidente_comunicacao.js";
import { editavel } from "./acidente_investigacao.js";
import * as anexos from "./anexos.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export interface Arquivo {
  nome: string;
  conteudo: Uint8Array;
}

/** O tipo pelos primeiros bytes; `null` quando não é nenhum dos aceitos. */
export function tipo_do_audio(b: Uint8Array): string | null {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  return null;
}

export function tipo_da_evidencia(b: Uint8Array): string | null {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

function _exigir(usuario: UsuarioAtual, ocorrencia: Ocorrencia): void {
  usuario.exigir("acidente.investigar");
  if (!editavel(ocorrencia)) {
    throw new ComunicacaoRecusada(`A investigação de ${ocorrencia.protocolo} está travada: o relatório já saiu.`, null);
  }
}

function _tamanho(arquivo: Arquivo): void {
  if (!arquivo.conteudo.byteLength) throw new ComunicacaoRecusada("O arquivo veio vazio.", "o arquivo");
  if (arquivo.conteudo.byteLength > anexos.LIMITE_BYTES) throw new anexos.AnexoGrandeDemais(arquivo.conteudo.byteLength);
}

function _relato(valor: string | null | undefined): string | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  if (v.length > 20000) throw new ComunicacaoRecusada("O relato passa de 20 mil caracteres.", "o relato");
  if (/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(v)) {
    throw new ComunicacaoRecusada("O relato tem um número com formato de CPF. CPF não entra na investigação.", "o relato");
  }
  try {
    textos.exigir_texto_limpo(v, "relato", textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new ComunicacaoRecusada(
      "O relato tem termo de saúde ou dado sensível. Registre o que a pessoa contou sobre o trabalho e o evento; " +
        "o que for de saúde fica com o médico do trabalho.",
      "o relato",
    );
  }
  return v;
}

/** "AAAA-MM-DDTHH:MM" do campo da tela, no fuso de Brasília. */
function _momento(valor: string | null | undefined): Date | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw new ComunicacaoRecusada("A data e a hora da entrevista não conferem.", "quando");
  const d = new Date(`${v}:00-03:00`);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 3_600_000) {
    throw new ComunicacaoRecusada("A entrevista não pode ser no futuro.", "quando");
  }
  return d;
}

export interface DadosEntrevista {
  entrevistado_nome: string;
  entrevistado_vinculo: string | null;
  realizada_em: string | null;
  entrevistadores: string | null;
  relato: string | null;
  consentiu_gravacao: boolean;
}

export async function registrar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  d: DadosEntrevista,
  audio: Arquivo | null,
): Promise<typeof acidente_entrevista.$inferSelect> {
  _exigir(usuario, ocorrencia);
  const nome = (d.entrevistado_nome ?? "").replace(/\s+/g, " ").trim();
  if (!nome || nome.length > 160) throw new ComunicacaoRecusada("Informe quem foi entrevistado.", "o entrevistado");
  if (/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(nome)) {
    throw new ComunicacaoRecusada("O nome tem um número com formato de CPF.", "o entrevistado");
  }
  const vinculo = (d.entrevistado_vinculo ?? "").trim() || null;
  if (vinculo && !(VINCULOS_ACIDENTADO as readonly string[]).includes(vinculo)) {
    throw new ComunicacaoRecusada("Escolha o vínculo na lista.", "o vínculo");
  }
  const relato = _relato(d.relato);
  let anexo_audio_id: number | null = null;
  if (audio) {
    if (!d.consentiu_gravacao) {
      throw new ComunicacaoRecusada(
        "A gravação só entra com o consentimento do entrevistado registrado: marque “consentimento obtido” " +
          "ou registre a entrevista sem o áudio.",
        "o consentimento",
      );
    }
    _tamanho(audio);
    const mime = tipo_do_audio(audio.conteudo);
    if (!mime) {
      throw new ComunicacaoRecusada("O arquivo de áudio não é WebM, Ogg, WAV, MP3 nem M4A.", "o áudio");
    }
    const r = await anexos.guardar(tx, {
      entidade: "acidente_ocorrencia",
      entidade_id: ocorrencia.id,
      nome_original: audio.nome || "gravacao",
      conteudo: audio.conteudo,
      mime_type: mime,
      categoria: "EVIDENCIA_ACIDENTE",
      usuario,
    });
    anexo_audio_id = r.anexo.id;
  }
  const [linha] = await tx
    .insert(acidente_entrevista)
    .values({
      ocorrencia_id: ocorrencia.id,
      entrevistado_nome: nome,
      entrevistado_vinculo: vinculo,
      realizada_em: _momento(d.realizada_em),
      entrevistadores: (d.entrevistadores ?? "").trim().slice(0, 400) || null,
      relato,
      consentiu_gravacao: d.consentiu_gravacao,
      consentimento_registrado_por: d.consentiu_gravacao ? usuario.id : null,
      anexo_audio_id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ENTREVISTA_REGISTRADA,
    descricao:
      `${ocorrencia.protocolo}: entrevista registrada` +
      (d.consentiu_gravacao ? ", com consentimento para gravar registrado" : ", sem consentimento para gravar") +
      ".",
    usuario,
  });
  if (anexo_audio_id) {
    await auditoria.registrar(tx, {
      entidade: "acidente_ocorrencia",
      entidade_id: ocorrencia.id,
      tipo_evento: auditoria.ACIDENTE_GRAVACAO_ANEXADA,
      descricao: `${ocorrencia.protocolo}: gravação da entrevista anexada (consentimento registrado).`,
      usuario,
    });
  }
  return linha!;
}

export async function anexar_evidencia(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  arquivo: Arquivo,
  descricao: string | null,
): Promise<void> {
  _exigir(usuario, ocorrencia);
  _tamanho(arquivo);
  const mime = tipo_da_evidencia(arquivo.conteudo);
  if (!mime) throw new ComunicacaoRecusada("A evidência vai em PDF ou imagem (PNG, JPEG, GIF, WebP).", "o arquivo");
  const desc = (descricao ?? "").trim().slice(0, 1000) || null;
  if (desc) _relato(desc);
  const r = await anexos.guardar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    nome_original: arquivo.nome || "evidencia",
    conteudo: arquivo.conteudo,
    mime_type: mime,
    categoria: "EVIDENCIA_ACIDENTE",
    usuario,
  });
  if (r.duplicado) throw new ComunicacaoRecusada("Este arquivo já está entre as evidências do caso.", "o arquivo");
  await tx.insert(acidente_evidencia).values({ ocorrencia_id: ocorrencia.id, anexo_id: r.anexo.id, descricao: desc });
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_EVIDENCIA_ANEXADA,
    descricao: `${ocorrencia.protocolo}: evidência anexada (${mime}).`,
    usuario,
  });
}

export async function entrevistas(tx: Executor, ocorrencia_id: number) {
  return tx
    .select()
    .from(acidente_entrevista)
    .where(eq(acidente_entrevista.ocorrencia_id, ocorrencia_id))
    .orderBy(asc(acidente_entrevista.id));
}

export async function evidencias(tx: Executor, ocorrencia_id: number) {
  return tx
    .select({
      id: acidente_evidencia.id,
      descricao: acidente_evidencia.descricao,
      citada_no_relatorio: acidente_evidencia.citada_no_relatorio,
      anexo_id: tabela_anexo.id,
      nome_original: tabela_anexo.nome_original,
      mime_type: tabela_anexo.mime_type,
      enviado_em: tabela_anexo.enviado_em,
    })
    .from(acidente_evidencia)
    .innerJoin(tabela_anexo, eq(tabela_anexo.id, acidente_evidencia.anexo_id))
    .where(eq(acidente_evidencia.ocorrencia_id, ocorrencia_id))
    .orderBy(asc(acidente_evidencia.id));
}
