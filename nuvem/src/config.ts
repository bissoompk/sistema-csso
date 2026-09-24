/**
 * Configuração do sistema na nuvem. Tudo vem do ambiente (painel do Netlify
 * em produção, `.env` local em desenvolvimento) — nada fica no código.
 *
 * Os nomes seguem o `CSSO_` do sistema Python para quem conhece um reconhecer
 * o outro. O que era de máquina local (porta, TLS, LibreOffice, diretórios)
 * não existe aqui: quem termina o HTTPS é o Netlify, os arquivos vão para o
 * Supabase Storage e o banco é o Postgres do Supabase.
 */

export const VERSAO = "2.0.0-nuvem";
export const RODAPE_INSTITUCIONAL = "Sistema de apoio da CSSO. O processo oficial e o SEI.";

export interface Config {
  bancoUrl: string;
  chaveSecreta: string;
  sessaoHoras: number;
  maxTentativas: number;
  bloqueioMinutos: number;
  cookieSeguro: "auto" | "sim" | "nao";
  ambiente: string;
  fusoExibicao: string;
  epiLocalRetirada: string;
  supabaseUrl: string;
  supabaseChaveServico: string;
  bucketArquivos: string;
  inseguro: string[];
}

function inteiro(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto.trim() === "") return padrao;
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) ? n : padrao;
}

let _config: Config | null = null;

export function obterConfig(): Config {
  if (_config) return _config;
  const env = process.env;
  const chaveSecreta = env.CSSO_CHAVE_SECRETA ?? "desenvolvimento-inseguro-troque";
  const modo = (env.CSSO_COOKIE_SEGURO ?? "auto").trim().toLowerCase();
  const inseguro: string[] = [];
  if (chaveSecreta.includes("troque")) {
    inseguro.push("CSSO_CHAVE_SECRETA ainda e o valor de exemplo.");
  }
  if (!["auto", "sim", "nao"].includes(modo)) {
    inseguro.push(
      `CSSO_COOKIE_SEGURO='${modo}' nao e um valor valido (auto, sim ou nao). Valendo: auto.`,
    );
  }
  const bancoUrl = env.DATABASE_URL ?? env.CSSO_BANCO_URL ?? "";
  if (!bancoUrl) inseguro.push("DATABASE_URL nao configurada: o sistema nao tem banco.");
  _config = {
    bancoUrl,
    chaveSecreta,
    sessaoHoras: inteiro("CSSO_SESSAO_HORAS", 12),
    maxTentativas: inteiro("CSSO_MAX_TENTATIVAS", 5),
    bloqueioMinutos: inteiro("CSSO_BLOQUEIO_MINUTOS", 15),
    cookieSeguro: (["auto", "sim", "nao"].includes(modo) ? modo : "auto") as Config["cookieSeguro"],
    ambiente: env.CSSO_AMBIENTE ?? "nuvem",
    fusoExibicao: env.CSSO_FUSO_EXIBICAO ?? "America/Sao_Paulo",
    epiLocalRetirada: env.CSSO_EPI_LOCAL_RETIRADA ?? "",
    supabaseUrl: env.SUPABASE_URL ?? "",
    supabaseChaveServico: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    bucketArquivos: env.CSSO_BUCKET ?? "csso",
    inseguro,
  };
  return _config;
}

/** Só para os testes, que trocam o ambiente entre um caso e outro. */
export function redefinirConfig(): void {
  _config = null;
}
