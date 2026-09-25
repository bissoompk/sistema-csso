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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { atribuicao, limite_login_ip, perfil, sessao, usuario } from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { obterConfig } from "../config.js";
import { hoje_iso } from "../dominio/datas.js";
import * as auditoria from "./auditoria.js";
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

export const TAMANHO_MINIMO_SENHA = 6;

/** Senhas triviais recusadas mesmo respeitando o tamanho mínimo. */
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
]);

// Alfabeto sem 0/O/1/l/I: a senha provisória é ditada e digitada à mão.
const _ALFABETO_CLARO = "abcdefghijkmnpqrstuvwxyz";
const _DIGITOS_CLAROS = "23456789";

/** Curta e legível, para o coordenador ditar. Troca obrigatória no 1º acesso. */
export function senha_provisoria(): string {
  let letras = "";
  for (let i = 0; i < 4; i++) letras += _ALFABETO_CLARO[randomInt(_ALFABETO_CLARO.length)];
  let numeros = "";
  for (let i = 0; i < 2; i++) numeros += _DIGITOS_CLAROS[randomInt(_DIGITOS_CLAROS.length)];
  return letras + numeros;
}

/** `str.isalpha()` / `str.isdigit()` do Python (Unicode, e falsos na string vazia). */
function soLetras(s: string): boolean {
  return s.length > 0 && /^\p{L}+$/u.test(s);
}
function soDigitos(s: string): boolean {
  return s.length > 0 && /^\p{Nd}+$/u.test(s);
}

/**
 * Política curta, a pedido do coordenador: 6 caracteres, letras e números.
 * O que segura o risco é o bloqueio por tentativas somado ao Argon2id e às
 * sessões revogáveis. Registrado em PENDENCIAS.md.
 */
export function politica_de_senha(senha: string): string[] {
  const problemas: string[] = [];
  // `len` do Python conta code points, não unidades UTF-16
  if ([...senha].length < TAMANHO_MINIMO_SENHA) {
    problemas.push(`mínimo de ${TAMANHO_MINIMO_SENHA} caracteres`);
  }
  if (soLetras(senha) || soDigitos(senha)) problemas.push("misture letras e números");
  if (SENHAS_TRIVIAIS.has(senha.toLowerCase())) problemas.push("senha trivial");
  return problemas;
}

/**
 * Deriva o nome de usuário do e-mail: a parte local, só `[a-z0-9._-]`, até 64.
 * A coluna `login` é obrigatória e única, mas deixou de ser digitada.
 */
export function usuario_a_partir_do_email(email: string): string {
  const local = (email ?? "").trim().split("@")[0] ?? "";
  const limpo = casefold(local).replace(/[^a-z0-9._-]/g, "").slice(0, 64);
  return limpo || "usuario";
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
    throw new FalhaDeAutenticacao();
  }

  if (conta.bloqueado_ate && conta.bloqueado_ate > agora) {
    await _gastar_argon2(senha);
    await registrar_falha_ip(tx, ip, agora);
    // Dizer a hora e a saída é o que transforma a recusa em instrução.
    throw new FalhaDeAutenticacao(
      `Conta bloqueada até ${local_formatado(conta.bloqueado_ate)} por ` +
        `${cfg.maxTentativas} tentativas malsucedidas seguidas. Espere e tente ` +
        "de novo; se a senha se perdeu, quem administra o sistema redefine — " +
        "não há redefinição por e-mail.",
    );
  }

  if (!(await conferir_senha(conta.senha_hash, senha))) {
    const tentativas = conta.tentativas_falhas + 1;
    const bloqueado_ate =
      tentativas >= cfg.maxTentativas ? new Date(agora.getTime() + cfg.bloqueioMinutos * 60_000) : conta.bloqueado_ate;
    await tx
      .update(usuario)
      .set({ tentativas_falhas: tentativas, bloqueado_ate })
      .where(eq(usuario.id, conta.id));
    await registrar_falha_ip(tx, ip, agora);
    // A falha tem de ficar gravada: a rota devolve a tela (retorno normal), e
    // o middleware dá COMMIT — como o `s.flush()` + commit do Python.
    throw new FalhaDeAutenticacao();
  }

  await tx
    .update(usuario)
    .set({ tentativas_falhas: 0, bloqueado_ate: null, ultimo_login_em: agora })
    .where(eq(usuario.id, conta.id));
  conta.tentativas_falhas = 0;
  conta.bloqueado_ate = null;
  conta.ultimo_login_em = agora;

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

export async function sessao_valida(tx: Executor, token: string | null | undefined): Promise<Sessao | null> {
  if (!token) return null;
  const [registro] = await tx.select().from(sessao).where(eq(sessao.token_hash, _hash_token(token)));
  if (!registro || registro.revogada || registro.expira_em <= agora_utc()) return null;
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
 * Grava a senha nova e derruba as OUTRAS sessões. Devolve quantas caíram.
 * Trocar a própria senha é o gesto de quem desconfia que alguém a viu;
 * `token_atual` poupa quem está trocando.
 */
export async function trocar_senha(
  tx: Executor,
  conta: Pick<Usuario, "id">,
  nova: string,
  token_atual: string | null = null,
): Promise<number> {
  const problemas = politica_de_senha(nova);
  if (problemas.length) throw new SenhaRecusada("Senha fraca: " + problemas.join("; "));
  await tx
    .update(usuario)
    .set({ senha_hash: await gerar_hash(nova), precisa_trocar_senha: false })
    .where(eq(usuario.id, conta.id));
  return revogar_do_usuario(tx, conta.id, token_atual);
}

// ---------------------------------------------------------------------
// Bootstrap: /primeiro-acesso
// ---------------------------------------------------------------------
export async function existe_algum_usuario(tx: Executor): Promise<boolean> {
  const linhas = await tx.select({ id: usuario.id }).from(usuario).limit(1);
  return linhas.length > 0;
}

/** Única concessão de perfil feita sem `perfil.conceder`. Auditada. */
export async function criar_primeiro_superintendente(
  tx: Executor,
  login: string,
  nome: string,
  email: string,
  senha: string,
): Promise<Usuario> {
  if (await existe_algum_usuario(tx)) {
    throw new PrimeiroAcessoRecusado("já existe usuário cadastrado — use /usuarios");
  }
  const problemas = politica_de_senha(senha);
  if (problemas.length) throw new SenhaRecusada("Senha fraca: " + problemas.join("; "));

  const [conta] = await tx
    .insert(usuario)
    .values({ login, nome, email, senha_hash: await gerar_hash(senha), precisa_trocar_senha: true })
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
  triviais: [...SENHAS_TRIVIAIS].sort(),
});
