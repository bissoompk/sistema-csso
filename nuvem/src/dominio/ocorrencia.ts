/**
 * Ocorrências de urgência e emergência (28/10/2026): o registro geral de um
 * mal-estar, queda, acidente ou socorro de QUALQUER pessoa na universidade
 * (servidor, discente, terceirizado, visitante), sem CAT/SP. É o «Informar
 * ocorrência de urgência/emergência» do sistema PROACE antigo, refeito.
 *
 * Os códigos abaixo são o que o banco grava; o rótulo é o que a tela mostra.
 * A lista de tipos é curta e fechada de propósito (a pessoa marca, não digita),
 * com «Outra» e um campo aberto para o que não couber.
 */

export const SITUACOES = ["REGISTRADA", "EM_ACOMPANHAMENTO", "CONCLUIDA", "CANCELADA"] as const;
export type Situacao = (typeof SITUACOES)[number];
export const ROTULO_SITUACAO: Record<string, string> = {
  REGISTRADA: "Registrada",
  EM_ACOMPANHAMENTO: "Em acompanhamento",
  CONCLUIDA: "Concluída",
  CANCELADA: "Cancelada",
};
/** Depois de concluída ou cancelada a ocorrência não muda mais. */
export const SITUACOES_ENCERRADAS: ReadonlySet<string> = new Set(["CONCLUIDA", "CANCELADA"]);

export const TIPOS = [
  "PERFUROCORTANTE",
  "CORTE",
  "DESMAIO",
  "PARADA_CARDIORRESPIRATORIA",
  "QUEDA",
  "ACIDENTE_VEICULO",
  "CRISE_CONVULSIVA",
  "FRATURA",
  "ANIMAL_PECONHENTO",
  "QUEIMADURA",
  "MAL_SUBITO",
  "OUTRA",
] as const;
export const ROTULO_TIPO: Record<string, string> = {
  PERFUROCORTANTE: "Acidente com material perfurocortante",
  CORTE: "Corte",
  DESMAIO: "Desmaio",
  PARADA_CARDIORRESPIRATORIA: "Parada cardiorrespiratória",
  QUEDA: "Queda",
  ACIDENTE_VEICULO: "Acidente com veículo",
  CRISE_CONVULSIVA: "Crise convulsiva",
  FRATURA: "Fratura",
  ANIMAL_PECONHENTO: "Picada de animal peçonhento",
  QUEIMADURA: "Queimadura",
  MAL_SUBITO: "Mal-estar súbito",
  OUTRA: "Outra ocorrência",
};

export const VINCULOS = ["ESTUDANTE", "SERVIDOR", "TERCEIRIZADO", "OUTRO"] as const;
export const ROTULO_VINCULO: Record<string, string> = {
  ESTUDANTE: "Estudante",
  SERVIDOR: "Servidor",
  TERCEIRIZADO: "Terceirizado",
  OUTRO: "Outro (visitante, acompanhante…)",
};

export const NIVEIS_ENSINO = ["GRADUACAO", "POS_GRADUACAO", "NAO_SEI"] as const;
export const ROTULO_NIVEL_ENSINO: Record<string, string> = {
  GRADUACAO: "Graduação",
  POS_GRADUACAO: "Pós-graduação",
  NAO_SEI: "Não sei",
};

export const SIM_NAO_NAO_SEI = ["SIM", "NAO", "NAO_SEI"] as const;
export const ROTULO_SIM_NAO: Record<string, string> = { SIM: "Sim", NAO: "Não", NAO_SEI: "Não sei" };

export const MEIOS_DESLOCAMENTO = ["BOMBEIROS", "SAMU", "VEICULO_UFVJM", "VEICULO_PARTICULAR", "OUTRO"] as const;
export const ROTULO_MEIO_DESLOCAMENTO: Record<string, string> = {
  BOMBEIROS: "Corpo de Bombeiros",
  SAMU: "SAMU",
  VEICULO_UFVJM: "Veículo da UFVJM",
  VEICULO_PARTICULAR: "Veículo particular",
  OUTRO: "Outro",
};

/** `OCO-2026-0001`: o ano e o número andam juntos no protocolo. */
export const PADRAO_PROTOCOLO = "^OCO-[0-9]{4}-[0-9]{4,}$";
export function protocolo_de(ano: number, numero: number): string {
  return `OCO-${ano}-${String(numero).padStart(4, "0")}`;
}

/** Os tipos gravados (texto separado por vírgula) como lista, sem repetir nem aceitar código fora do catálogo. */
export function tipos_da_lista(texto: string | null | undefined): string[] {
  return [...new Set((texto ?? "").split(",").map((t) => t.trim()).filter((t) => (TIPOS as readonly string[]).includes(t)))];
}
