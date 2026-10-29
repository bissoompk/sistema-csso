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
export const RODAPE_INSTITUCIONAL = "Sistema de apoio da SISA";

export interface Config {
  bancoUrl: string;
  chaveSecreta: string;
  sessaoHoras: number;
  /** 0 desliga. 60 desde 22/10/2026 (era 120): com aviso aos 55 no navegador. */
  sessaoInatividadeMinutos: number;
  maxTentativas: number;
  bloqueioMinutos: number;
  cookieSeguro: "auto" | "sim" | "nao";
  ambiente: string;
  fusoExibicao: string;
  epiLocalRetirada: string;
  /**
   * E-mail do pedido de EPI (paridade com o IntegraSST, 22/10/2026). DESLIGADO
   * por padrão: só vale com `CSSO_EPI_EMAIL=sim` — e, mesmo ligado, a mensagem
   * só sai quando o SMTP estiver configurado (`email.configurado()`); até lá ela
   * espera na caixa de saída.
   */
  epiEmailLigado: boolean;
  /** Endereço do SETOR avisado quando chega pedido (`CSSO_EPI_EMAIL_SETOR`). Vazio: não avisa o setor. */
  epiEmailSetor: string;
  /**
   * E-mail do módulo de acidentes (D6, 23/10/2026): DESLIGADO por padrão, só
   * com `CSSO_ACIDENTE_EMAIL=sim`; o corpo leva só protocolo, o que aconteceu e
   * o link. `CSSO_ACIDENTE_EMAIL_SETOR` é o endereço avisado da comunicação nova.
   */
  acidenteEmailLigado: boolean;
  acidenteEmailSetor: string;
  /**
   * E-mail do módulo de ocorrências de urgência e emergência (28/10/2026), no
   * padrão do de acidentes: DESLIGADO por padrão, só com `CSSO_OCORRENCIA_EMAIL=sim`;
   * o corpo leva só o protocolo e o link, nunca o relato. `CSSO_OCORRENCIA_EMAIL_SETOR`
   * é o endereço da equipe avisada de cada ocorrência nova.
   */
  ocorrenciaEmailLigado: boolean;
  ocorrenciaEmailSetor: string;
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

export const CHAVE_SECRETA_EXEMPLO = "desenvolvimento-inseguro-troque";
/** 32 bytes em base64url dão 43 caracteres; abaixo de 32 é chave digitada à mão. */
export const TAMANHO_MINIMO_CHAVE = 32;
/** A senha dos backups cifrados: abaixo disto o PBKDF2 protege pouco. */
export const TAMANHO_MINIMO_SENHA_BACKUP = 16;

/** `CSSO_AMBIENTE=producao` (aceita `produção`, qualquer caixa). */
export function ehProducao(ambiente: string = process.env.CSSO_AMBIENTE ?? ""): boolean {
  const a = ambiente.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return a === "producao";
}

/**
 * O módulo de acidentes está liberado nesta instalação? A especificação (§4)
 * segura a PRODUÇÃO até o relatório (F6) e a emenda da ROPA (dado de saúde):
 * sem `CSSO_MODULO_ACIDENTES=sim`, a produção mostra o módulo como "em
 * desenvolvimento" e as rotas `/acidentes*` respondem 404. Fora da produção
 * vale por padrão; `CSSO_MODULO_ACIDENTES=nao` desliga em qualquer ambiente.
 */
export function acidentesLiberado(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CSSO_MODULO_ACIDENTES ?? "").trim().toLowerCase();
  if (v === "sim") return true;
  if (v === "nao" || v === "não") return false;
  return !ehProducao(env.CSSO_AMBIENTE ?? "");
}

/**
 * O módulo de ocorrências de urgência e emergência (28/10/2026) guarda o
 * relato de saúde de qualquer pessoa na universidade. Como o de acidentes, na
 * produção só abre com `CSSO_MODULO_OCORRENCIAS=sim` (depois que o encarregado
 * confere a ROPA); antes, aparece "em desenvolvimento" e as rotas dão 404. Fora
 * da produção vale por padrão; `nao` desliga em qualquer ambiente.
 */
export function ocorrenciasLiberado(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CSSO_MODULO_OCORRENCIAS ?? "").trim().toLowerCase();
  if (v === "sim") return true;
  if (v === "nao" || v === "não") return false;
  return !ehProducao(env.CSSO_AMBIENTE ?? "");
}

export class ConfiguracaoInsegura extends Error {
  constructor(readonly problemas: string[]) {
    super(
      "CSSO_AMBIENTE=producao recusado — configuração insegura: " +
        problemas.join(" | ") +
        " Corrija as variáveis de ambiente no painel do Netlify e publique de novo.",
    );
  }
}

/**
 * O que impede a PRODUÇÃO de subir. Em homologação e desenvolvimento os mesmos
 * problemas viram aviso na tela (`inseguro`); em produção, com dado pessoal
 * real, o sistema não atende ninguém até corrigir. Só diz o NOME da variável,
 * nunca o valor.
 */
export function problemasDeProducao(env: NodeJS.ProcessEnv = process.env): string[] {
  const problemas: string[] = [];
  const chave = env.CSSO_CHAVE_SECRETA?.trim() ?? "";
  if (!chave || chave.includes("troque") || chave.length < TAMANHO_MINIMO_CHAVE) {
    problemas.push(`CSSO_CHAVE_SECRETA ausente, de exemplo ou com menos de ${TAMANHO_MINIMO_CHAVE} caracteres.`);
  }
  // `CSSO_BACKUP_SENHA` saiu daqui (19/10/2026): sem ela o sistema inteiro
  // ficava fora do ar por causa de UMA rotina. Quem recusa é o próprio backup
  // (`rotinas.conferir_senha_do_backup`, no diário e no botão de /config).
  if ((env.CSSO_COOKIE_SEGURO ?? "").trim().toLowerCase() === "nao") {
    problemas.push("CSSO_COOKIE_SEGURO=nao: o cookie de sessão sairia sem Secure.");
  }
  if (!(env.DATABASE_URL ?? env.CSSO_BANCO_URL ?? "").trim()) {
    problemas.push("DATABASE_URL ausente.");
  }
  return problemas;
}

/** Lança `ConfiguracaoInsegura` em produção com configuração insegura; fora dela, nada. */
export function exigirConfiguracaoDeProducao(env: NodeJS.ProcessEnv = process.env): void {
  if (!ehProducao(env.CSSO_AMBIENTE ?? "")) return;
  const problemas = problemasDeProducao(env);
  if (problemas.length) throw new ConfiguracaoInsegura(problemas);
}

export function obterConfig(): Config {
  if (_config) return _config;
  const env = process.env;
  // Produção com segredo de exemplo não sobe: lança aqui, antes de qualquer
  // banco, tela ou backup — e lança de novo a cada requisição até corrigir.
  exigirConfiguracaoDeProducao(env);
  // Vazia vale como ausente: o `.env.exemplo` traz `CSSO_CHAVE_SECRETA=` em
  // branco, e um HMAC de chave vazia passava calado (nem o aviso saía).
  const chaveSecreta = env.CSSO_CHAVE_SECRETA?.trim() || CHAVE_SECRETA_EXEMPLO;
  const modo = (env.CSSO_COOKIE_SEGURO ?? "auto").trim().toLowerCase();
  const inseguro: string[] = [];
  if (chaveSecreta.includes("troque")) {
    inseguro.push("CSSO_CHAVE_SECRETA ainda e o valor de exemplo.");
  } else if (chaveSecreta.length < TAMANHO_MINIMO_CHAVE) {
    inseguro.push(`CSSO_CHAVE_SECRETA tem menos de ${TAMANHO_MINIMO_CHAVE} caracteres.`);
  }
  if (!["auto", "sim", "nao"].includes(modo)) {
    inseguro.push(
      `CSSO_COOKIE_SEGURO='${modo}' nao e um valor valido (auto, sim ou nao). Valendo: auto.`,
    );
  }
  if ((env.CSSO_PRIMEIRO_ACESSO_REMOTO ?? "").trim().toLowerCase() === "sim") {
    inseguro.push(
      "CSSO_PRIMEIRO_ACESSO_REMOTO=sim: desligue assim que o primeiro superintendente existir.",
    );
  }
  // não barra a subida (ver `problemasDeProducao`), mas avisa em produção:
  // sem ela o backup é recusado
  const senhaBackup = env.CSSO_BACKUP_SENHA?.trim() ?? "";
  if (ehProducao(env.CSSO_AMBIENTE ?? "") && (!senhaBackup || senhaBackup.includes("troque") || senhaBackup.length < TAMANHO_MINIMO_SENHA_BACKUP)) {
    inseguro.push(
      `CSSO_BACKUP_SENHA ausente, de exemplo ou com menos de ${TAMANHO_MINIMO_SENHA_BACKUP} caracteres: o backup de producao sera recusado.`,
    );
  }
  const bancoUrl = env.DATABASE_URL ?? env.CSSO_BANCO_URL ?? "";
  if (!bancoUrl) inseguro.push("DATABASE_URL nao configurada: o sistema nao tem banco.");
  _config = {
    bancoUrl,
    chaveSecreta,
    sessaoHoras: inteiro("CSSO_SESSAO_HORAS", 12),
    sessaoInatividadeMinutos: inteiro("CSSO_SESSAO_INATIVIDADE_MINUTOS", 60),
    maxTentativas: inteiro("CSSO_MAX_TENTATIVAS", 5),
    bloqueioMinutos: inteiro("CSSO_BLOQUEIO_MINUTOS", 15),
    cookieSeguro: (["auto", "sim", "nao"].includes(modo) ? modo : "auto") as Config["cookieSeguro"],
    ambiente: env.CSSO_AMBIENTE ?? "nuvem",
    fusoExibicao: env.CSSO_FUSO_EXIBICAO ?? "America/Sao_Paulo",
    epiLocalRetirada: env.CSSO_EPI_LOCAL_RETIRADA ?? "",
    epiEmailLigado: (env.CSSO_EPI_EMAIL ?? "").trim().toLowerCase() === "sim",
    epiEmailSetor: (env.CSSO_EPI_EMAIL_SETOR ?? "").trim(),
    acidenteEmailLigado: (env.CSSO_ACIDENTE_EMAIL ?? "").trim().toLowerCase() === "sim",
    acidenteEmailSetor: (env.CSSO_ACIDENTE_EMAIL_SETOR ?? "").trim(),
    ocorrenciaEmailLigado: (env.CSSO_OCORRENCIA_EMAIL ?? "").trim().toLowerCase() === "sim",
    ocorrenciaEmailSetor: (env.CSSO_OCORRENCIA_EMAIL_SETOR ?? "").trim(),
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
