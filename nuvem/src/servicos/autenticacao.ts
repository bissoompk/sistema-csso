/**
 * Login próprio: Argon2id, sessão server-side, bloqueio por tentativas.
 * Porte de `app/servicos/autenticacao.py`.
 *
 * **Hash compatível com o Python.** O Argon2id sai de `hash-wasm` (WebAssembly,
 * sem binário nativo — a função do Netlify não compila addon), em formato PHC
 * (`$argon2id$v=19$m=65536,t=3,p=2$<sal>$<hash>`), com os MESMOS parâmetros do
 * `PasswordHasher` do argon2-cffi usado lá: 32 bytes de hash, 16 de sal. Um
 * banco migrado do Python continua aceitando as senhas de antes, e a
 * verificação lê os parâmetros do próprio hash, como o `verify` do argon2-cffi.
 */
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import { and, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { atribuicao, limite_login_ip, perfil, sessao, usuario } from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { obterConfig } from "../config.js";
import { hoje_iso } from "../dominio/datas.js";
import * as auditoria from "./auditoria.js";
import { CONTA_BLOQUEADA, SENHA_TROCADA } from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import { local_formatado } from "./datas_br.js";
import { global } from "../web.js";

export const COOKIE_SESSAO = "csso_sessao";
export const ERRO_GENERICO = "Usuário ou senha inválidos.";

export type Usuario = typeof usuario.$inferSelect;
export type Sessao = typeof sessao.$inferSelect;

/**
 * O custo do Argon2id em PRODUÇÃO: 64 MiB / 3 passagens / 2 threads, o perfil
 * recomendado pelo RFC 9106 para servidor. Constante nomeada para que um teste
 * se amarre a ela: a suíte troca o custo por um barato (`_definir_parametros`),
 * e o que impede essa troca de vazar para produção é alguém afirmar, em teste,
 * que estes números continuam sendo estes.
 */
export const PARAMETROS_ARGON2_PRODUCAO = Object.freeze({ time_cost: 3, memory_cost: 65536, parallelism: 2 });
/** hash_len e salt_len padrão do argon2-cffi */
const TAMANHO_HASH = 32;
const TAMANHO_SAL = 16;

type ParametrosArgon2 = { time_cost: number; memory_cost: number; parallelism: number };
let _parametros: ParametrosArgon2 = { ...PARAMETROS_ARGON2_PRODUCAO };

/** Só para a suíte de testes (o `_hasher` trocado do conftest do Python). */
export function _definir_parametros(p: ParametrosArgon2 | null): void {
  _parametros = p ? { ...p } : { ...PARAMETROS_ARGON2_PRODUCAO };
}
export function _parametros_atuais(): Readonly<ParametrosArgon2> {
  return _parametros;
}

export class FalhaDeAutenticacao extends Error {
  constructor(mensagem: string = ERRO_GENERICO) {
    super(mensagem);
  }
}

/** Erro de política (o `ValueError` do Python). */
export class SenhaRecusada extends Error {}
/** Primeiro acesso quando já há conta (o `PermissionError` do Python). */
export class PrimeiroAcessoRecusado extends Error {}

export async function gerar_hash(senha: string): Promise<string> {
  return argon2id({
    password: senha,
    salt: randomBytes(TAMANHO_SAL),
    iterations: _parametros.time_cost,
    memorySize: _parametros.memory_cost,
    parallelism: _parametros.parallelism,
    hashLength: TAMANHO_HASH,
    outputType: "encoded",
  });
}

export async function conferir_senha(hash_armazenado: string, senha: string): Promise<boolean> {
  if (!hash_armazenado || !hash_armazenado.startsWith("$argon2")) return false;
  try {
    return await argon2Verify({ password: senha, hash: hash_armazenado });
  } catch {
    // hash torto (InvalidHashError do Python): não confere, não derruba
    return false;
  }
}

/**
 * HMAC-SHA256 do token com `CSSO_CHAVE_SECRETA`.
 *
 * O ganho não é sigilo do token (48 bytes aleatórios já bastam): é ter o que
 * ROTACIONAR. Trocar a chave invalida, no mesmo gesto e sem tocar no banco,
 * toda sessão aberta de todo mundo.
 */
export function _hash_token(token: string): string {
  return createHmac("sha256", obterConfig().chaveSecreta).update(token, "utf8").digest("hex");
}

/**
 * Política para a internet aberta (revisão de segurança, 25/09/2026). Era 6,
 * letras e números, a pedido, quando o sistema só existia na máquina do
 * setor. Exposto, o que segura a senha fraca não é o bloqueio por tentativas:
 * 5 chutes por conta a cada 15 minutos, em centenas de contas, acham quem usou
 * `ufvjm2026`. A recomendação atual (NIST SP 800-63B) é comprimento, sem
 * regra de composição, e recusar as senhas que todo mundo tenta primeiro.
 *
 * Voltou a 6 a pedido do setor (22/10/2026): dez caracteres era a queixa de
 * quem usa. O que segura a senha curta passa a ser o resto da política — a
 * lista de triviais, os caracteres distintos — e o bloqueio por tentativas.
 */
export const TAMANHO_MINIMO_SENHA = 6;
/** Caracteres diferentes exigidos: `aaaaaa` e `121212` têm seis, e nada de senha. */
export const MINIMO_CARACTERES_DISTINTOS = 5;

/**
 * Senhas recusadas mesmo respeitando o tamanho: as primeiras de toda lista
 * vazada e as que o próprio contexto sugere (instituição, cidades dos campi,
 * o nome do sistema). Comparadas em minúsculas. Os itens curtos vêm da
 * política antiga e ficam: custam nada e a lista é também documentação.
 */
export const SENHAS_TRIVIAIS: ReadonlySet<string> = new Set([
  "admin",
  "admin1",
  "senha1",
  "123456",
  "1234567",
  "12345678",
  "abc123",
  "csso01",
  "ufvjm1",
  "mudar1",
  "teste1",
  "senha123",
  "123456789012",
  "senha123456",
  // vazadas, com 10 ou mais caracteres
  "0123456789",
  "1234567890",
  "12345678910",
  "0987654321",
  "1111111111",
  "1q2w3e4r5t",
  "1q2w3e4r5t6y",
  "qwertyuiop",
  "qwerty1234",
  "qwerty12345",
  "asdfghjkl1",
  "password12",
  "password123",
  "password1234",
  "iloveyou12",
  "abcdefghij",
  "abc1234567",
  "abcd123456",
  "a123456789",
  "aa12345678",
  "senha12345",
  "senha1234567",
  "minhasenha",
  "minhasenha1",
  "mudar12345",
  "mudar123456",
  "trocar1234",
  "teste12345",
  "teste123456",
  "admin12345",
  "admin123456",
  "adminadmin",
  "administrador",
  "administrador1",
  "brasil1234",
  "brasil12345",
  "flamengo123",
  "corinthians",
  "palmeiras1",
  "cruzeiro123",
  "atletico123",
  // a instituição e os campi
  "ufvjm12345",
  "ufvjm123456",
  "ufvjm2025",
  "ufvjm2026",
  "ufvjm2027",
  "ufvjm@2026",
  "csso123456",
  "csso2026sisa",
  "sisaufvjm1",
  "diamantina",
  "diamantina1",
  "diamantina123",
  "teofilootoni",
  "teofilootoni1",
  "janauba123",
  "unai123456",
  "progep2026",
]);

// Alfabeto sem 0/O/1/l/I: a senha provisória é ditada e digitada à mão.
const _ALFABETO_CLARO = "abcdefghijkmnpqrstuvwxyz";
const _DIGITOS_CLAROS = "23456789";

/**
 * Legível, para o coordenador ditar, em dois blocos de quatro letras e dois
 * dígitos (`kfwp-tmzq-47`): ≈ 43 bits, contra os 26 da de seis caracteres.
 * Troca obrigatória no 1º acesso, em toda rota.
 */
export function senha_provisoria(): string {
  const letras = (n: number) => {
    let saida = "";
    for (let i = 0; i < n; i++) saida += _ALFABETO_CLARO[randomInt(_ALFABETO_CLARO.length)];
    return saida;
  };
  let numeros = "";
  for (let i = 0; i < 2; i++) numeros += _DIGITOS_CLAROS[randomInt(_DIGITOS_CLAROS.length)];
  return `${letras(4)}-${letras(4)}-${numeros}`;
}

/**
 * Os problemas da senha, na ordem em que a tela os mostra. Lista vazia = aceita.
 * `templates/partes/senha.html` espelha estas mesmas regras na barra de força.
 */
export function politica_de_senha(senha: string): string[] {
  const problemas: string[] = [];
  // `len` do Python conta code points, não unidades UTF-16
  const caracteres = [...senha];
  if (caracteres.length < TAMANHO_MINIMO_SENHA) {
    problemas.push(`mínimo de ${TAMANHO_MINIMO_SENHA} caracteres`);
  }
  if (senha && new Set(caracteres).size < MINIMO_CARACTERES_DISTINTOS) {
    problemas.push(`use pelo menos ${MINIMO_CARACTERES_DISTINTOS} caracteres diferentes`);
  }
  if (SENHAS_TRIVIAIS.has(senha.toLowerCase())) problemas.push("senha trivial");
  return problemas;
}

/**
 * O login da conta: o PRÓPRIO e-mail cadastrado, aparado e em minúsculas
 * (23/10/2026, DESVIOS.md "Login é o e-mail"). Era só a parte local
 * (`usuario_a_partir_do_email`), e "fabricio" e "fabricio@" de outro domínio
 * disputavam o mesmo login. A coluna `login` continua obrigatória e única; ela
 * só deixou de ser um segundo identificador para alguém lembrar.
 */
export function login_do_email(email: string): string {
  return casefold((email ?? "").trim());
}

/** `str.casefold()`: minúsculas + o ß alemão (o único caso que o `toLowerCase` não cobre e importa aqui). */
function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss");
}

/**
 * Acha a conta pelo e-mail ou pelo usuário, sem depender de maiúsculas.
 * 'Bisso' e 'bisso' são a mesma pessoa; a SENHA continua sensível a caixa.
 */
export async function buscar_por_login(tx: Executor, login: string): Promise<Usuario | null> {
  const procurado = (login ?? "").trim();
  if (!procurado) return null;
  const achados = await tx
    .select()
    .from(usuario)
    .where(or(eq(usuario.email, procurado), eq(usuario.login, procurado)));
  if (achados.length === 1) return achados[0]!;
  if (achados.length > 1) {
    // o `scalar_one_or_none` do Python levantaria: e-mail de um igual ao login
    // de outro. Prefere-se o casamento pelo e-mail, que é a credencial de entrada.
    return achados.find((u) => u.email === procurado) ?? achados[0]!;
  }
  const alvo = casefold(procurado);
  // No Python a varredura era em Python, conta por conta; aqui o banco compara
  // em minúsculas — o mesmo resultado, sem trazer a tabela inteira.
  const [candidato] = await tx
    .select()
    .from(usuario)
    .where(or(sql`lower(${usuario.email}) = ${alvo}`, sql`lower(${usuario.login}) = ${alvo}`))
    .orderBy(usuario.id)
    .limit(1);
  return candidato ?? null;
}

let _hash_isca: Promise<string> | null = null;
let _parametros_da_isca: ParametrosArgon2 | null = null;

/**
 * Confere a senha contra um hash descartável, com os parâmetros correntes:
 * iguala o tempo da recusa sem conta ao da recusa por senha errada.
 */
async function _gastar_argon2(senha: string): Promise<void> {
  if (!_hash_isca || _parametros_da_isca !== _parametros) {
    _parametros_da_isca = _parametros;
    _hash_isca = gerar_hash(randomBytes(18).toString("base64url"));
  }
  await conferir_senha(await _hash_isca, senha);
}

export async function autenticar(
  tx: Executor,
  login: string,
  senha: string,
  ip: string | null = null,
  user_agent: string | null = null,
): Promise<[Usuario, string]> {
  const cfg = obterConfig();
  const agora = agora_utc();

  // O teto por endereço vem ANTES de tudo: não custa Argon2 nem diz nada da conta.
  const ip_ate = await ip_bloqueado_ate(tx, ip, agora);
  if (ip_ate) {
    throw new FalhaDeAutenticacao(
      `Muitas tentativas de entrada a partir deste endereço. Tente de novo depois de ${local_formatado(ip_ate)}.`,
    );
  }

  const achada = await buscar_por_login(tx, login);
  // A linha da conta TRAVADA até o fim da requisição: sem isto, N tentativas
  // em paralelo liam todas `tentativas_falhas` igual, passavam todas pelo
  // bloqueio e gravavam +1 cada uma por cima da outra — o limite de 5 por
  // janela virava quantas o atacante conseguisse disparar de uma vez.
  const conta = achada
    ? ((await tx.select().from(usuario).where(eq(usuario.id, achada.id)).for("update"))[0] ?? null)
    : null;

  if (!conta || !conta.ativo) {
    // Mesmo custo de Argon2 da conta que existe: sem isto, "usuário não
    // existe" respondia em milissegundos e "senha errada" em centenas deles —
    // a lista de e-mails válidos saía pelo cronômetro.
    await _gastar_argon2(senha);
    await registrar_falha_ip(tx, ip, agora);
    // O bloqueio também é encenado (D26): só a conta ativa bloqueava, e a
    // sexta tentativa num e-mail qualquer dizia, pela mensagem, se ele existia.
    const ate = await _bloqueio_encenado(tx, login, agora);
    throw new FalhaDeAutenticacao(ate ? _mensagem_de_bloqueio(ate) : ERRO_GENERICO);
  }

  if (conta.bloqueado_ate && conta.bloqueado_ate > agora) {
    await _gastar_argon2(senha);
    await registrar_falha_ip(tx, ip, agora);
    throw new FalhaDeAutenticacao(_mensagem_de_bloqueio(conta.bloqueado_ate));
  }

  if (!(await conferir_senha(conta.senha_hash, senha))) {
    const { tentativas, bloqueado_ate } = _proxima_falha(conta, agora);
    await tx
      .update(usuario)
      .set({ tentativas_falhas: tentativas, bloqueado_ate })
      .where(eq(usuario.id, conta.id));
    await registrar_falha_ip(tx, ip, agora);
    if (bloqueado_ate && bloqueado_ate !== conta.bloqueado_ate) {
      await _registrar_bloqueio(tx, conta, bloqueado_ate, "na entrada", { ip, user_agent });
    }
    // A falha tem de ficar gravada: a rota devolve a tela (retorno normal), e
    // o middleware dá COMMIT — como o `s.flush()` + commit do Python.
    throw new FalhaDeAutenticacao();
  }

  // A senha que entrou certa mas não passa na política de HOJE (as de 6
  // caracteres da política anterior) vira troca obrigatória: o único momento
  // em que o sistema conhece a senha em claro é este, e ela não é guardada.
  const precisa_trocar_senha = conta.precisa_trocar_senha || politica_de_senha(senha).length > 0;
  await tx
    .update(usuario)
    .set({ tentativas_falhas: 0, bloqueado_ate: null, ultimo_login_em: agora, precisa_trocar_senha })
    .where(eq(usuario.id, conta.id));
  conta.tentativas_falhas = 0;
  conta.bloqueado_ate = null;
  conta.ultimo_login_em = agora;
  conta.precisa_trocar_senha = precisa_trocar_senha;

  const token = randomBytes(48).toString("base64url");
  await tx.insert(sessao).values({
    token_hash: _hash_token(token),
    usuario_id: conta.id,
    criada_em: agora,
    expira_em: new Date(agora.getTime() + cfg.sessaoHoras * 3600_000),
    ip,
    user_agent,
  });
  await expurgar_sessoes(tx, agora);
  await expurgar_limites_ip(tx, agora);
  return [conta, token];
}

// ---------------------------------------------------------------------
// Bloqueio da conta: o contador, a mensagem, a trilha e a encenação
// ---------------------------------------------------------------------

/** Dizer a hora e a saída é o que transforma a recusa em instrução. */
function _mensagem_de_bloqueio(ate: Date): string {
  return (
    `Conta bloqueada até ${local_formatado(ate)} por ` +
    `${obterConfig().maxTentativas} tentativas malsucedidas seguidas. Espere e tente ` +
    "de novo; se a senha se perdeu, quem administra o sistema redefine — " +
    "não há redefinição por e-mail."
  );
}

/**
 * O contador depois de mais uma senha errada. Bloqueio que já venceu recomeça
 * a conta do zero (D6): sem isto o contador continuava em 5, e o primeiro erro
 * depois do prazo bloqueava de novo, com a mensagem "5 tentativas seguidas"
 * para quem tinha errado uma vez.
 */
function _proxima_falha(
  conta: Pick<Usuario, "tentativas_falhas" | "bloqueado_ate">,
  agora: Date,
): { tentativas: number; bloqueado_ate: Date | null } {
  const cfg = obterConfig();
  const vencido = conta.bloqueado_ate !== null && conta.bloqueado_ate <= agora;
  const tentativas = (vencido ? 0 : conta.tentativas_falhas) + 1;
  if (tentativas >= cfg.maxTentativas) {
    return { tentativas, bloqueado_ate: new Date(agora.getTime() + cfg.bloqueioMinutos * 60_000) };
  }
  return { tentativas, bloqueado_ate: vencido ? null : conta.bloqueado_ate };
}

/**
 * CONTA_BLOQUEADA na trilha (D21): o bloqueio é o sinal de que alguém tentou
 * a senha de outra pessoa, e até aqui só existia na coluna da conta, que o
 * próximo login certo zera. Sem conta na sessão (a entrada), quem age é o
 * "sistema"; na troca de senha, é a própria sessão.
 */
async function _registrar_bloqueio(
  tx: Executor,
  conta: Pick<Usuario, "id" | "login">,
  ate: Date,
  onde: string,
  contexto: { usuario?: UsuarioAtual | null; ip?: string | null; user_agent?: string | null } = {},
): Promise<void> {
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: CONTA_BLOQUEADA,
    descricao:
      `Conta '${conta.login}' bloqueada até ${local_formatado(ate)} depois de ` +
      `${obterConfig().maxTentativas} tentativas malsucedidas seguidas ${onde}.`,
    campo: "bloqueado_ate",
    valor_novo: ate.toISOString(),
    usuario: contexto.usuario ?? null,
    ip: contexto.ip ?? null,
    user_agent: contexto.user_agent ?? null,
  });
}

/**
 * A chave do contador encenado: um HMAC do identificador digitado, nunca o
 * texto (o e-mail que alguém tentou é dado pessoal de quem o digitou, e às
 * vezes é a senha colada no campo errado). O prefixo separa estas linhas das
 * de endereço, que dividem a tabela `limite_login_ip`.
 */
export const PREFIXO_CHAVE_ENCENADA = "conta:";
function _chave_encenada(login: string): string {
  const digest = createHmac("sha256", obterConfig().chaveSecreta).update(casefold(login.trim()), "utf8").digest("hex");
  return (PREFIXO_CHAVE_ENCENADA + digest).slice(0, 64);
}

/**
 * O bloqueio de quem não tem conta ativa, igual ao de quem tem (D26): conta as
 * falhas seguidas daquele identificador e, no teto, devolve a mesma mensagem
 * "Conta bloqueada até…" pelo mesmo tempo. Devolve a hora do bloqueio em
 * curso (ou do que esta falha abriu, que só aparece na tentativa seguinte,
 * como na conta real), ou `null`.
 *
 * Usa a tabela do teto por endereço, com chave própria, para não criar
 * migração por um contador que se apaga sozinho: `expurgar_limites_ip` já
 * remove a linha um dia depois da última tentativa. A `janela_inicio` aqui é
 * a hora da última falha.
 */
async function _bloqueio_encenado(tx: Executor, login: string, agora: Date): Promise<Date | null> {
  if (!login.trim()) return null;
  const chave = _chave_encenada(login);
  const [linha] = await tx.select().from(limite_login_ip).where(eq(limite_login_ip.ip, chave)).for("update");
  if (linha?.bloqueado_ate && linha.bloqueado_ate > agora) return linha.bloqueado_ate;
  const proxima = _proxima_falha(
    { tentativas_falhas: linha?.falhas ?? 0, bloqueado_ate: linha?.bloqueado_ate ?? null },
    agora,
  );
  await tx
    .insert(limite_login_ip)
    .values({ ip: chave, falhas: proxima.tentativas, janela_inicio: agora, bloqueado_ate: proxima.bloqueado_ate })
    .onConflictDoUpdate({
      target: limite_login_ip.ip,
      set: { falhas: proxima.tentativas, janela_inicio: agora, bloqueado_ate: proxima.bloqueado_ate },
    });
  return null;
}

// ---------------------------------------------------------------------
// Teto de falhas por endereço (não existe no Python — ver DESVIOS.md)
// ---------------------------------------------------------------------

function _inteiro_env(nome: string, padrao: number): number {
  const n = Number.parseInt(process.env[nome] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

/**
 * Falhas de um mesmo endereço, em qualquer conta, antes do bloqueio do
 * endereço. Folgado de propósito: a rede da UFVJM sai para a internet por
 * poucos endereços (NAT), e um teto baixo bloquearia o campus inteiro por causa
 * de meia dúzia de senhas erradas. `CSSO_MAX_FALHAS_IP=0` desliga.
 */
export function max_falhas_por_ip(): number {
  if ((process.env.CSSO_MAX_FALHAS_IP ?? "").trim() === "0") return Number.POSITIVE_INFINITY;
  return _inteiro_env("CSSO_MAX_FALHAS_IP", 30);
}
/** A janela em que as falhas se somam (e a duração do bloqueio do endereço). */
export function janela_ip_minutos(): number {
  return _inteiro_env("CSSO_JANELA_IP_MINUTOS", 15);
}

/** O endereço como chave: sem ele (teste, script local) não há teto. */
function _chave_ip(ip: string | null): string | null {
  if (max_falhas_por_ip() === Number.POSITIVE_INFINITY) return null;
  const limpo = (ip ?? "").trim().slice(0, 64);
  return limpo || null;
}

export async function ip_bloqueado_ate(tx: Executor, ip: string | null, agora: Date = agora_utc()): Promise<Date | null> {
  const chave = _chave_ip(ip);
  if (!chave) return null;
  const [linha] = await tx.select().from(limite_login_ip).where(eq(limite_login_ip.ip, chave));
  return linha?.bloqueado_ate && linha.bloqueado_ate > agora ? linha.bloqueado_ate : null;
}

/**
 * Soma uma falha ao endereço, num só comando (duas requisições em paralelo
 * não se sobrescrevem). Janela vencida recomeça a conta; chegar ao teto
 * bloqueia o endereço por uma janela.
 */
export async function registrar_falha_ip(tx: Executor, ip: string | null, agora: Date = agora_utc()): Promise<void> {
  const chave = _chave_ip(ip);
  if (!chave) return;
  const janela_ms = janela_ip_minutos() * 60_000;
  const inicio_valido = new Date(agora.getTime() - janela_ms);
  const bloqueio = new Date(agora.getTime() + janela_ms);
  const max = max_falhas_por_ip();
  // Date solto num `sql` não passa pelo mapeamento da coluna: vai como texto ISO.
  const vencida = sql`${limite_login_ip.janela_inicio} < ${inicio_valido.toISOString()}::timestamptz`;
  const falhas = sql`CASE WHEN ${vencida} THEN 1 ELSE ${limite_login_ip.falhas} + 1 END`;
  await tx
    .insert(limite_login_ip)
    .values({ ip: chave, falhas: 1, janela_inicio: agora, bloqueado_ate: max <= 1 ? bloqueio : null })
    .onConflictDoUpdate({
      target: limite_login_ip.ip,
      set: {
        falhas,
        janela_inicio: sql`CASE WHEN ${vencida} THEN ${agora.toISOString()}::timestamptz ELSE ${limite_login_ip.janela_inicio} END`,
        bloqueado_ate: sql`CASE WHEN (${falhas}) >= ${max} THEN ${bloqueio.toISOString()}::timestamptz ELSE ${limite_login_ip.bloqueado_ate} END`,
      },
    });
}

/** O endereço é dado pessoal: a linha some um dia depois da última janela. */
export async function expurgar_limites_ip(tx: Executor, agora: Date = agora_utc()): Promise<number> {
  const limite = new Date(agora.getTime() - 86_400_000);
  const apagadas = await tx
    .delete(limite_login_ip)
    .where(and(lt(limite_login_ip.janela_inicio, limite), or(isNull(limite_login_ip.bloqueado_ate), lt(limite_login_ip.bloqueado_ate, agora))))
    .returning({ ip: limite_login_ip.ip });
  return apagadas.length;
}

/** `log_retencao_dias` do Python (90): o mesmo prazo do registro de acesso. */
export function log_retencao_dias(): number {
  const bruto = process.env.CSSO_LOG_RETENCAO_DIAS;
  const n = bruto ? Number.parseInt(bruto, 10) : NaN;
  return Number.isFinite(n) ? n : 90;
}

/**
 * Apaga as sessões expiradas há mais do que o prazo da política (90 dias após
 * `expira_em`, por causa do IP que a linha guarda). Devolve quantas.
 * Roda a cada login: é o login que faz a tabela crescer, então é ele que a poda.
 */
export async function expurgar_sessoes(tx: Executor, agora: Date | null = null): Promise<number> {
  const limite = new Date((agora ?? agora_utc()).getTime() - log_retencao_dias() * 86_400_000);
  const apagadas = await tx.delete(sessao).where(lt(sessao.expira_em, limite)).returning({ id: sessao.id });
  return apagadas.length;
}

/** De quanto em quanto tempo o `ultimo_uso_em` é regravado: não a cada clique. */
const PASSO_ULTIMO_USO_MS = 60_000;

/**
 * A sessão do cookie, se ainda vale. Além do teto absoluto (`expira_em`, 12 h),
 * cai a sessão parada há mais de `sessaoInatividadeMinutos` (revisão de
 * segurança, 25/09/2026): na internet, o computador deixado aberto na sala de
 * outra unidade não pode continuar logado até o fim do expediente. Sessenta
 * minutos desde 22/10/2026 (eram duas horas), e não quinze, porque o parecer se
 * escreve com o processo SEI aberto do lado: o navegador avisa aos 55 minutos,
 * e digitar num formulário renova a sessão (csso.js, bloco 12).
 *
 * A TOLERÂNCIA DE UM PASSO. O `ultimo_uso_em` só é regravado de minuto em
 * minuto (`PASSO_ULTIMO_USO_MS`), então ele pode estar até um passo atrás do
 * último pedido de verdade. Conferir o limite cru contra ele derrubaria a
 * sessão até um minuto ANTES do que o aviso do navegador promete. Por isso a
 * sessão cai quando a coluna passa de `limite + passo`: nunca antes de 60
 * minutos sem pedido, e no máximo aos 61.
 */
/**
 * A conta da sessão como SUBCONSULTA: carrega-se a identidade junto com a
 * sessão. Nomes escritos por extenso, e não `${sessao.usuario_id}`: dentro da
 * consulta relacional do Drizzle a coluna sairia com o apelido da tabela de fora.
 */
export function conta_da_sessao(token: string): SQL {
  return sql`(select s.usuario_id from sessao s where s.token_hash = ${_hash_token(token)})`;
}

export async function sessao_valida(tx: Executor, token: string | null | undefined): Promise<Sessao | null> {
  if (!token) return null;
  const [registro] = await tx.select().from(sessao).where(eq(sessao.token_hash, _hash_token(token)));
  const agora = agora_utc();
  if (!registro || registro.revogada || registro.expira_em <= agora) return null;
  const inatividade_ms = obterConfig().sessaoInatividadeMinutos * 60_000;
  const ultimo = registro.ultimo_uso_em ?? registro.criada_em;
  if (inatividade_ms > 0 && agora.getTime() - ultimo.getTime() > inatividade_ms + PASSO_ULTIMO_USO_MS) return null;
  if (agora.getTime() - ultimo.getTime() > PASSO_ULTIMO_USO_MS) {
    await tx.update(sessao).set({ ultimo_uso_em: agora }).where(eq(sessao.id, registro.id));
    registro.ultimo_uso_em = agora;
  }
  return registro;
}

export async function revogar(tx: Executor, token: string): Promise<void> {
  await tx.update(sessao).set({ revogada: true }).where(eq(sessao.token_hash, _hash_token(token)));
}

/** Derruba as sessões do usuário. `exceto_token` poupa a sessão corrente. */
export async function revogar_do_usuario(
  tx: Executor,
  usuario_id: number,
  exceto_token: string | null = null,
): Promise<number> {
  const preservado = exceto_token ? _hash_token(exceto_token) : null;
  const abertas = await tx
    .select({ id: sessao.id, token_hash: sessao.token_hash })
    .from(sessao)
    .where(and(eq(sessao.usuario_id, usuario_id), eq(sessao.revogada, false)));
  let contador = 0;
  for (const registro of abertas) {
    if (preservado !== null && registro.token_hash === preservado) continue;
    await tx.update(sessao).set({ revogada: true }).where(eq(sessao.id, registro.id));
    contador += 1;
  }
  return contador;
}

/**
 * A senha atual na troca de senha, com o MESMO teto de tentativas do login
 * (M74). Sem ele, uma sessão aberta numa máquina compartilhada testava senhas
 * sem limite pela tela de troca — e a senha atual é o que se descobre para
 * entrar de outro lugar depois.
 *
 * O contador é o da conta (`tentativas_falhas`), o mesmo do login: as falhas
 * são "tentativas malsucedidas seguidas" de uma conta só, venha de onde vier.
 * Errar abaixo do teto diz quantas restam; atingir o teto bloqueia a conta
 * pelo tempo do login e derruba TODAS as sessões, inclusive esta — quem
 * estava ali sem saber a senha sai junto. Acertar zera o contador.
 *
 * Devolve `null` (conferiu), ou a recusa: `bloqueada` diz se a sessão caiu.
 */
export async function conferir_senha_atual(
  tx: Executor,
  conta_id: number,
  senha: string,
  contexto: { usuario?: UsuarioAtual | null; ip?: string | null; user_agent?: string | null } = {},
): Promise<{ mensagem: string; bloqueada: boolean } | null> {
  const cfg = obterConfig();
  const agora = agora_utc();
  // travada até o fim da requisição, pelo mesmo motivo do login: tentativas em
  // paralelo não podem ler o mesmo contador
  const [conta] = await tx.select().from(usuario).where(eq(usuario.id, conta_id)).for("update");
  if (!conta) return { mensagem: "Senha atual incorreta.", bloqueada: false };
  if (await conferir_senha(conta.senha_hash, senha)) {
    if (conta.tentativas_falhas) await tx.update(usuario).set({ tentativas_falhas: 0 }).where(eq(usuario.id, conta.id));
    return null;
  }
  // o mesmo contador do login, com o mesmo recomeço depois do bloqueio vencido (D6)
  const { tentativas, bloqueado_ate: proximo_bloqueio } = _proxima_falha(conta, agora);
  if (tentativas >= cfg.maxTentativas) {
    const bloqueado_ate = proximo_bloqueio!;
    await tx.update(usuario).set({ tentativas_falhas: tentativas, bloqueado_ate }).where(eq(usuario.id, conta.id));
    await revogar_do_usuario(tx, conta.id);
    await _registrar_bloqueio(tx, conta, bloqueado_ate, "na troca de senha", contexto);
    return {
      mensagem:
        `Senha atual incorreta pela ${cfg.maxTentativas}ª vez seguida. Por segurança a conta ficou bloqueada até ` +
        `${local_formatado(bloqueado_ate)} e as sessões abertas foram encerradas. Se a senha se perdeu, quem ` +
        "administra o sistema redefine — não há redefinição por e-mail.",
      bloqueada: true,
    };
  }
  await tx
    .update(usuario)
    .set({ tentativas_falhas: tentativas, bloqueado_ate: proximo_bloqueio })
    .where(eq(usuario.id, conta.id));
  const restam = cfg.maxTentativas - tentativas;
  return {
    mensagem:
      `Senha atual incorreta. ${restam === 1 ? "Resta 1 tentativa" : `Restam ${restam} tentativas`} ` +
      "antes de a conta ser bloqueada.",
    bloqueada: false,
  };
}

/** A recusa de repetir a senha atual. Começa por "A senha nova": a tela a põe no campo da nova. */
export const ERRO_SENHA_REPETIDA = "A senha nova é igual à atual: escolha outra.";

/**
 * Grava a senha nova e derruba as OUTRAS sessões. Devolve quantas caíram.
 * Trocar a própria senha é o gesto de quem desconfia que alguém a viu;
 * `token_atual` poupa quem está trocando.
 *
 * A senha nova não pode ser a atual (D5). Sem esta recusa, a troca obrigatória
 * aceitava digitar a provisória de novo, e a provisória — que quem redefiniu
 * viu e ditou — continuava valendo para sempre. A redefinição pelo
 * administrador só é contida porque a troca obrigatória tira dele a senha.
 *
 * Grava SENHA_TROCADA (D21): a troca pelo próprio dono não deixava rastro, e
 * é o primeiro fato que se procura quando alguém diz "não fui eu".
 */
export async function trocar_senha(
  tx: Executor,
  conta: Pick<Usuario, "id">,
  nova: string,
  token_atual: string | null = null,
  contexto: { usuario?: UsuarioAtual | null; ip?: string | null; user_agent?: string | null } = {},
): Promise<number> {
  const problemas = politica_de_senha(nova);
  if (problemas.length) throw new SenhaRecusada("Senha fraca: " + problemas.join("; "));
  const [atual] = await tx.select().from(usuario).where(eq(usuario.id, conta.id)).for("update");
  if (!atual) throw new SenhaRecusada("Conta não encontrada.");
  if (await conferir_senha(atual.senha_hash, nova)) throw new SenhaRecusada(ERRO_SENHA_REPETIDA);
  await tx
    .update(usuario)
    .set({ senha_hash: await gerar_hash(nova), precisa_trocar_senha: false })
    .where(eq(usuario.id, conta.id));
  const encerradas = await revogar_do_usuario(tx, conta.id, token_atual);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: atual.id,
    tipo_evento: SENHA_TROCADA,
    descricao:
      `Senha da conta '${atual.login}' trocada pela própria conta` +
      (atual.precisa_trocar_senha ? " (troca obrigatória)" : "") +
      `; ${encerradas} outra(s) sessão(ões) encerrada(s).`,
    usuario: contexto.usuario ?? null,
    usuario_nome: contexto.usuario ? null : atual.nome,
    ip: contexto.ip ?? null,
    user_agent: contexto.user_agent ?? null,
  });
  return encerradas;
}

// ---------------------------------------------------------------------
// Bootstrap: /primeiro-acesso
// ---------------------------------------------------------------------
export async function existe_algum_usuario(tx: Executor): Promise<boolean> {
  const linhas = await tx.select({ id: usuario.id }).from(usuario).limit(1);
  return linhas.length > 0;
}

/**
 * Única concessão de perfil feita sem `perfil.conceder`. Auditada.
 *
 * `precisa_trocar_senha` vale `true` por padrão: é o caminho da linha de
 * comando (`producao-iniciar`), que GERA a senha e a mostra no terminal, e a
 * senha mostrada é provisória de fato. A tela /primeiro-acesso passa `false`
 * (D28): ali a pessoa acabou de escolher a senha, ninguém mais a viu, e a
 * troca obrigatória logo na entrada a chamava de "provisória".
 */
export async function criar_primeiro_superintendente(
  tx: Executor,
  nome: string,
  email: string,
  senha: string,
  opcoes: { precisa_trocar_senha?: boolean } = {},
): Promise<Usuario> {
  if (await existe_algum_usuario(tx)) {
    throw new PrimeiroAcessoRecusado("já existe usuário cadastrado — use /usuarios");
  }
  const problemas = politica_de_senha(senha);
  if (problemas.length) throw new SenhaRecusada("Senha fraca: " + problemas.join("; "));
  email = email.trim();
  // o login é o e-mail (23/10/2026): não há mais um segundo identificador
  const login = login_do_email(email);

  const [conta] = await tx
    .insert(usuario)
    .values({ login, nome, email, senha_hash: await gerar_hash(senha), precisa_trocar_senha: opcoes.precisa_trocar_senha ?? true })
    .returning();
  const [superintendente] = await tx.select().from(perfil).where(eq(perfil.codigo, "superintendente"));
  if (!superintendente) throw new Error("perfil 'superintendente' ausente: o banco não foi semeado");
  await tx.insert(atribuicao).values({
    usuario_id: conta!.id,
    perfil_id: superintendente.id,
    coordenadoria: "Sisa",
    vigencia_inicio: hoje_iso(),
    ato_normativo: "BOOTSTRAP — substituir pelo ato real",
  });
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta!.id,
    tipo_evento: auditoria.BOOTSTRAP_SUPERINTENDENTE,
    descricao:
      `Primeiro acesso: conta '${login}' criada com perfil superintendente ` +
      "(ato normativo pendente de substituição).",
    usuario_nome: nome,
  });
  return conta!;
}

// A barra de força da senha (primeiro acesso e troca) mede a política de
// verdade: precisa dos mesmos números e da mesma lista que `politica_de_senha`
// usa. Global de template registrado aqui, no dono dos números (ver `web.ts`).
global("POLITICA_SENHA", {
  minimo: TAMANHO_MINIMO_SENHA,
  distintos: MINIMO_CARACTERES_DISTINTOS,
  triviais: [...SENHAS_TRIVIAIS].sort(),
});
