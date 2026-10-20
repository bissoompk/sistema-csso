/**
 * O PDF fiel do modelo enviado: o .docx do setor passa por um LibreOffice
 * (Gotenberg) fora da Netlify, que não roda LibreOffice. O PDF da casa
 * (`certificado_pdf.ts`) desenha só o layout padrão; o modelo enviado tem o
 * layout dele.
 *
 * Sem `CSSO_CONVERSOR_PDF_URL` o conversor está desligado e o papel do modelo
 * enviado é o próprio Word. Com ele, o PDF de cada certificado é convertido
 * na primeira vez e guardado no armazenamento; as seguintes leem o guardado.
 */
import { createHash } from "node:crypto";
import { global } from "../web.js";
import { obterArmazenamento } from "./armazenamento.js";

/** Tempo máximo da conversão: a função da Netlify não espera muito mais. */
const LIMITE_MS = 20_000;

export class ConversorIndisponivel extends Error {}

export function configurado(): boolean {
  return Boolean((process.env.CSSO_CONVERSOR_PDF_URL || "").trim());
}

// as telas oferecem o PDF do modelo enviado só com o conversor ligado
global("pdf_fiel", configurado);

function _cabecalhos(): Record<string, string> {
  const usuario = process.env.CSSO_CONVERSOR_PDF_USUARIO || "";
  const senha = process.env.CSSO_CONVERSOR_PDF_SENHA || "";
  if (!usuario) return {};
  return { Authorization: `Basic ${Buffer.from(`${usuario}:${senha}`).toString("base64")}` };
}

/** O .docx em PDF pelo LibreOffice do conversor. Lança `ConversorIndisponivel`. */
export async function converter_docx(bytes: Uint8Array, nome: string): Promise<Uint8Array> {
  const base = (process.env.CSSO_CONVERSOR_PDF_URL || "").trim().replace(/\/+$/, "");
  if (!base) throw new ConversorIndisponivel("O conversor de PDF não está configurado.");
  const formulario = new FormData();
  formulario.append("files", new Blob([bytes as Uint8Array<ArrayBuffer>]), nome.endsWith(".docx") ? nome : `${nome}.docx`);
  let resposta: Response;
  try {
    resposta = await fetch(`${base}/forms/libreoffice/convert`, {
      method: "POST",
      body: formulario,
      headers: _cabecalhos(),
      signal: AbortSignal.timeout(LIMITE_MS),
    });
  } catch (erro) {
    throw new ConversorIndisponivel(`O conversor de PDF não respondeu (${(erro as Error).name}).`);
  }
  if (!resposta.ok) throw new ConversorIndisponivel(`O conversor de PDF recusou o documento (HTTP ${resposta.status}).`);
  const pdf = new Uint8Array(await resposta.arrayBuffer());
  // o que não começa por %PDF não é PDF (página de erro de um proxy, por exemplo)
  if (new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") {
    throw new ConversorIndisponivel("O conversor de PDF devolveu algo que não é PDF.");
  }
  return pdf;
}

/**
 * A chave do PDF guardado. O .docx não serve de chave (o zip leva a hora em
 * que foi gerado); servem o texto do certificado e o arquivo do modelo — se
 * um dos dois muda, o PDF guardado não vale mais.
 */
export function chave_do_pdf(certificado_id: number, hash_conteudo: string, modelo_sha256: string): string {
  const resumo = createHash("sha256").update(`${hash_conteudo}\u0000${modelo_sha256}`).digest("hex").slice(0, 32);
  return `certificados-pdf/${certificado_id}-${resumo}.pdf`;
}

/** O PDF guardado na chave ou, sem ele, o convertido agora (e guardado). */
export async function pdf_guardado_ou_convertido(
  chave: string,
  gerar_docx: () => Promise<{ bytes: Uint8Array; nome: string }>,
): Promise<Uint8Array> {
  const armazenamento = obterArmazenamento();
  if (await armazenamento.existe(chave)) return armazenamento.ler(chave);
  const docx = await gerar_docx();
  const pdf = await converter_docx(docx.bytes, docx.nome);
  await armazenamento.gravar(chave, pdf, "application/pdf");
  return pdf;
}
