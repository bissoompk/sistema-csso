/**
 * Brigada orgânica (Portaria CBMMG nº 54/2020) — as regras puras do lote 4 (25/11/2026).
 * Referência do texto oficial: `docs/especificacoes/brigada-cbmmg/REFERENCIAS.md`.
 *
 * - Nota de 0 a 100 por disciplina; aprovação com o mínimo de cada disciplina (70, art. 40) e a
 *   frequência mínima da turma (75%).
 * - Nota final = média aritmética simples das disciplinas (art. 42, § 3º), com duas casas,
 *   exibida em percentual sem casas quando inteira ("85%", "77,5%").
 * - Quem pode dar o nível básico (arts. 59 e 63) e o que cada um precisa para o certificado sair.
 *
 * A nota de 0 a 10 dos treinamentos em horas não muda: ela não passa por aqui.
 */

export const PROFISSOES = ["TECNICO_SEG", "ENGENHEIRO_SEG", "ENG_ARQ_ESPEC_SEG", "MILITAR"] as const;
export type Profissao = (typeof PROFISSOES)[number];

export const ROTULO_PROFISSAO: Readonly<Record<Profissao, string>> = {
  TECNICO_SEG: "Técnico(a) em Segurança do Trabalho",
  ENGENHEIRO_SEG: "Engenheiro(a) de Segurança do Trabalho",
  ENG_ARQ_ESPEC_SEG: "Engenheiro(a) ou Arquiteto(a) com especialização em Segurança do Trabalho",
  MILITAR: "Militar das Forças Armadas",
};

export function profissao_de(valor: string | null | undefined): Profissao | null {
  return (PROFISSOES as readonly string[]).includes(valor ?? "") ? (valor as Profissao) : null;
}

/** Engenheiros (e arquitetos especializados) valem pelo registro no conselho (art. 43, II, g). */
export function vale_pelo_registro(p: Profissao | null): boolean {
  return p === "ENGENHEIRO_SEG" || p === "ENG_ARQ_ESPEC_SEG";
}

export interface DadosDoResponsavel {
  nome: string | null | undefined;
  profissao: string | null | undefined;
  credenciamento_cbmmg: string | null | undefined;
  conselho: string | null | undefined;
  registro_conselho: string | null | undefined;
  tem_cpf: boolean;
}

/**
 * O que falta no responsável pela formação para o certificado de brigada sair. Frases curtas,
 * já com o nome, para a lista de bloqueios da emissão.
 */
export function pendencias_do_responsavel(r: DadosDoResponsavel): string[] {
  const quem = r.nome?.trim() || "o responsável pela formação";
  const faltam: string[] = [];
  const p = profissao_de(r.profissao);
  if (!p) {
    faltam.push(`falta a profissão de ${quem} (técnico, engenheiro, engenheiro ou arquiteto especializado, ou militar), em Assinaturas`);
  } else if (vale_pelo_registro(p)) {
    if (!r.conselho?.trim() || !r.registro_conselho?.trim()) {
      faltam.push(`falta o conselho e o número de registro de ${quem}, em Assinaturas`);
    }
  } else if (!r.credenciamento_cbmmg?.trim()) {
    faltam.push(`falta o número de credenciamento no CBMMG de ${quem}, em Assinaturas`);
  }
  if (!r.tem_cpf) faltam.push(`falta o CPF de ${quem}, em Assinaturas`);
  return faltam;
}

/**
 * A linha do credenciamento como sai no certificado: "Credenciamento CBMMG nº 123" (técnico e
 * militar), "CREA-MG 12345/D" (engenheiro), ou os dois quando o engenheiro também é credenciado.
 */
export function linha_de_credenciamento(r: {
  profissao: string | null | undefined;
  credenciamento_cbmmg: string | null | undefined;
  registro: string | null | undefined;
}): string {
  const partes: string[] = [];
  const cred = r.credenciamento_cbmmg?.trim();
  const reg = r.registro?.trim();
  if (vale_pelo_registro(profissao_de(r.profissao)) && reg) partes.push(`Registro ${reg}`);
  if (cred) partes.push(`Credenciamento CBMMG nº ${cred}`);
  return partes.join(" · ");
}

// ---------------------------------------------------------------------
// Nota
// ---------------------------------------------------------------------
/** Centésimos inteiros de um texto decimal ("77.5" → 7750). */
function centesimos(valor: string): number {
  const [int, frac = ""] = valor.trim().split(".");
  const sinal = int!.startsWith("-") ? -1 : 1;
  return sinal * (Math.abs(Number(int)) * 100 + Number((frac + "00").slice(0, 2)));
}

function de_centesimos(c: number): string {
  const int = Math.floor(c / 100);
  return `${int}.${String(c % 100).padStart(2, "0")}`;
}

/** Lê a nota digitada (0 a 100; vírgula ou ponto; até duas casas). `null` = vazio. */
export function ler_nota(bruto: string | null | undefined): string | null {
  const t = (bruto ?? "").trim().replace(",", ".").replace(/%$/, "").trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) throw new NotaInvalida("Nota da disciplina: use um número de 0 a 100, com até duas casas.");
  const c = centesimos(t);
  if (c < 0 || c > 10_000) throw new NotaInvalida("Nota da disciplina: use um número de 0 a 100.");
  return de_centesimos(c);
}

export class NotaInvalida extends Error {}

/** Média aritmética simples, duas casas, meio para cima (art. 42, § 3º). */
export function media(notas: readonly string[]): string | null {
  if (!notas.length) return null;
  const soma = notas.reduce((s, n) => s + centesimos(n), 0);
  // lote 5 (25/11/2026, decisão do coordenador): CORTA na segunda casa, sem arredondar para
  // cima — 90 e 69,99 dão 79,995, que fica 79,99, e nunca 80. A nota exibida nunca passa da
  // obtida. A aprovação não olha a média: compara cada disciplina, exata, com o mínimo.
  return de_centesimos(Math.floor(soma / notas.length));
}

/** "85%", "77,5%", "77,25%": percentual sem casas quando inteira, sem zero à direita. */
export function exibir_nota(valor: string | null | undefined): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  const c = centesimos(String(valor));
  const int = Math.floor(c / 100);
  const frac = String(c % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${int},${frac}%` : `${int}%`;
}

/** Compara duas notas em texto (sem passar por ponto flutuante). */
export function comparar_nota(a: string, b: string): number {
  return Math.sign(centesimos(a) - centesimos(b));
}

// ---------------------------------------------------------------------
// Disciplinas
// ---------------------------------------------------------------------
export type TipoLinha = "TEORICA" | "PRATICA";
export const ROTULO_LINHA: Readonly<Record<TipoLinha, string>> = { TEORICA: "Teórica", PRATICA: "Prática" };

export interface DisciplinaDados {
  nome: string;
  teorica: number;
  pratica: number;
}

/** O total de tempos das disciplinas. */
export function total_de_tempos(lista: readonly DisciplinaDados[]): number {
  return lista.reduce((s, d) => s + d.teorica + d.pratica, 0);
}
