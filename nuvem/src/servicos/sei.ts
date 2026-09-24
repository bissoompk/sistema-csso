/**
 * Interface com o SEI — DEFINIDA E VAZIA, de propósito.
 * Porte de `app/servicos/sei.py`.
 *
 * A v1 NÃO integra com o SEI: nenhuma API, nenhum scraping. O número do
 * processo é digitado (validado em `nup.ts`) e `numero_documento_sei` /
 * `url_permanente` são campos manuais.
 *
 * Este módulo existe para que, quando a integração for autorizada, exista um
 * único ponto de acoplamento — e para deixar explícito que hoje nada aqui está
 * ligado.
 */

export const VERSAO_SEI_ALVO = "4.0.12.15";
export const BASE_SEI = "sei.ufvjm.edu.br";
export const UNIDADE_SEI = "csso.sisa";

export const PASSOS_INCLUSAO: readonly string[] = Object.freeze([
  "No SEI, abra o processo pelo NUP.",
  "Incluir Documento -> Externo.",
  "Tipo do Documento: Parecer Técnico.",
  "Anexe o PDF gerado pelo sistema e assine no SEI.",
  "Volte aqui e preencha o nº do documento SEI, a data e o link permanente.",
]);

/** Integração com o SEI está fora do escopo da v1 (§1 do prompt). */
export class NaoImplementadoNaV1 extends Error {}

export interface DocumentoSei {
  readonly numero: string;
  readonly url_permanente: string | null;
}

/** Contrato que uma futura integração deverá cumprir. */
export interface ClienteSei {
  incluir_documento_externo(nup: string, caminho_pdf: string, tipo: string): DocumentoSei;
  consultar_processo(nup: string): Record<string, unknown>;
}

/** Implementação padrão: recusa qualquer chamada, com mensagem clara. */
export class ClienteSeiIndisponivel implements ClienteSei {
  incluir_documento_externo(_nup: string, _caminho_pdf: string, _tipo: string): DocumentoSei {
    throw new NaoImplementadoNaV1(
      "A v1 nao integra com o SEI. Inclua o documento manualmente: " + PASSOS_INCLUSAO.join(" "),
    );
  }

  consultar_processo(_nup: string): Record<string, unknown> {
    throw new NaoImplementadoNaV1("A v1 nao consulta o SEI. Digite o NUP.");
  }
}

export function obter_cliente(): ClienteSei {
  return new ClienteSeiIndisponivel();
}
