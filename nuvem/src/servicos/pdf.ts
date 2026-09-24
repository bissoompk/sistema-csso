/**
 * Conversão .docx -> .pdf. Porte de `app/servicos/pdf.py`.
 *
 * **Desvio (DESVIOS.md): não há LibreOffice na nuvem.** A função do Netlify
 * não tem o `soffice` e não caberia nele (o pacote passa de 300 MB e a
 * conversão a frio leva de 2 a 8 s, contra 60 s de teto por requisição e 250 MB
 * de pacote). O Python já tinha a degradação elegante como regra 3 — "sem
 * soffice, entrega o .docx com aviso" —, e aqui ela é o caminho de sempre:
 * `disponivel()` é falso, e `converter`/`converter_fora_da_transacao` devolvem
 * o mesmo `ResultadoPdf` que o Python devolvia numa máquina sem LibreOffice
 * (`gerado=false`, `AVISO_SEM_PDF`, `indisponivel=true`).
 *
 * `indisponivel=true` é o que mantém a trilha limpa: "não há LibreOffice nesta
 * instalação" é configuração declarada, não incidente, e não vira
 * `PDF_NAO_GERADO` (ver o Python).
 *
 * Nunca falhe a emissão por causa do PDF.
 */
import type { Executor } from "../db/cliente.js";

export const AVISO_SEM_PDF =
  "PDF indisponível — abra o .docx no Word e use Salvar como PDF. " +
  "Instale o LibreOffice para gerar o PDF automaticamente.";

export const TEMPO_LIMITE = 180;

export interface ResultadoPdf {
  gerado: boolean;
  /** No Python, o caminho do PDF; aqui não há PDF, então é sempre null. */
  caminho: string | null;
  aviso: string | null;
  /**
   * Separa "não há LibreOffice nesta máquina" de "havia e não deu certo" — só
   * o segundo merece linha na trilha.
   */
  indisponivel: boolean;
}

/** Na nuvem não há `soffice` para localizar. */
export function localizar_soffice(): string | null {
  return null;
}

export function disponivel(): boolean {
  return localizar_soffice() !== null;
}

/**
 * A mesma resposta do Python quando o `soffice` falta. Os parâmetros ficam
 * (o .docx e o destino) para quem chama não mudar de forma.
 */
export function converter(_docx?: unknown, _saida?: unknown): ResultadoPdf {
  return { gerado: false, caminho: null, aviso: AVISO_SEM_PDF, indisponivel: true };
}

/**
 * No Python: "sem LibreOffice não há o que soltar — `converter` volta na
 * hora, com o aviso; comitar ali seria mexer no contrato de transação de quem
 * chama sem ganhar nada". Na nuvem é sempre esse ramo: nada é comitado.
 */
export function converter_fora_da_transacao(_tx: Executor, docx?: unknown, saida?: unknown): ResultadoPdf {
  return converter(docx, saida);
}
