/**
 * A frase de tela de um `CAMPO_ALTERADO` da trilha do processo.
 *
 * A descrição gravada é a do Python — `campo: repr(antes) -> repr(depois)` — e
 * entra na cadeia de hash, então não muda. Na ficha do processo ela aparecia
 * crua: `url_permanente: None -> 'https://…'`, `laudo_id: None -> 1`, o texto
 * inteiro da recomendação entre aspas. Aqui a tela diz o campo pelo nome e o
 * que aconteceu com ele; o número de um id (que a tela não resolve) e o corpo
 * de um texto longo ficam de fora — estão no registro e no Histórico do parecer.
 */
import * as datas_br from "./datas_br.js";

export const ROTULO_CAMPO: Record<string, string> = {
  url_permanente: "Link do SEI",
  servidor_id: "Servidor",
  data_autuacao: "Data de autuação",
  data_solicitacao_sest: "Solicitação no SEST",
  observacoes: "Observações",
  data_marco_inicial: "Data do marco inicial",
  justificativa_marco: "Justificativa do marco",
  laudo_id: "Laudo técnico",
  tipo_adicional_id: "Tipo de adicional",
  tipo_movimento_id: "Movimento",
  tipo_marco_id: "Tipo de marco",
  unidade_uorg_id: "Unidade",
  uorg_id: "UORG",
  portaria_id: "Portaria de localização",
  signatario_id: "Signatário",
  destinatario_id: "Destinatário",
  setor_emissor_id: "Setor emissor",
  modelo_arquivo: "Modelo",
  numero: "Número",
  ano: "Ano",
  data_emissao: "Data de emissão",
  texto_recomendacao: "Recomendação",
  texto_alteracao: "Texto da alteração",
  texto_reavaliacao: "Texto da reavaliação",
  numero_documento_sei: "Nº do documento SEI",
  categoria: "Categoria",
};

const vazio = (v: unknown) => v === null || v === undefined || v === "";

function rotulo(campo: string): string {
  if (Object.hasOwn(ROTULO_CAMPO, campo)) return ROTULO_CAMPO[campo]!;
  const sem_id = campo.replace(/_id$/, "").replaceAll("_", " ");
  return sem_id.charAt(0).toUpperCase() + sem_id.slice(1);
}

function valor(v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return datas_br.numerica(v);
  if (typeof v === "boolean") return v ? "sim" : "não";
  return String(v);
}

export function alteracao_na_tela(ev: {
  campo: string | null;
  valor_anterior: unknown;
  valor_novo: unknown;
  descricao: string | null;
}): string {
  if (!ev.campo) return ev.descricao ?? "";
  const nome = rotulo(ev.campo);
  const a = ev.valor_anterior, d = ev.valor_novo;
  // o id não diz nada a quem lê, e o texto longo não cabe numa linha da trilha
  const so_o_fato = ev.campo.endsWith("_id") || ev.campo.startsWith("texto_") ||
    [a, d].some((v) => typeof v === "string" && v.length > 80);
  if (so_o_fato) {
    if (vazio(a)) return `${nome}: preenchido`;
    if (vazio(d)) return `${nome}: apagado`;
    return `${nome}: alterado`;
  }
  if (vazio(a)) return `${nome}: ${valor(d)}`;
  if (vazio(d)) return `${nome}: ${valor(a)} → (vazio)`;
  return `${nome}: ${valor(a)} → ${valor(d)}`;
}
