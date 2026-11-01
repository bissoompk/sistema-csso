/**
 * O segundo fator da entrada: TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) de um
 * aplicativo autenticador — OPCIONAL, cada pessoa liga o seu (01/11/2026,
 * revisão para dados reais). Sem biblioteca: é HMAC do `node:crypto`.
 *
 * - O segredo mora cifrado (AES-256-GCM, chave derivada de `CSSO_CHAVE_SECRETA`).
 *   Trocar a chave derruba as sessões E inutiliza os segredos: quem tinha o
 *   segundo fator o recadastra (a administração pode desligá-lo da conta).
 * - O mesmo código não vale duas vezes (`ultimo_passo`), e a janela é de um
 *   passo para cada lado (relógio do celular um pouco fora).
 * - Os códigos de recuperação (8, de uso único) entram no lugar do código do
 *   aplicativo quando o celular se perdeu. Só o HMAC fica no banco.
 * - A trilha diz QUE o fator foi ligado, desligado ou usado o código de
 *   recuperação; nunca o segredo nem os códigos.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { usuario_codigo_recuperacao, usuario_segundo_fator } from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export const EMISSOR = "Sistema SISA UFVJM";
export const PASSO_SEGUNDOS = 30;
export const DIGITOS = 6;
export const CODIGOS_DE_RECUPERACAO = 8;

export const SEGUNDO_FATOR_LIGADO = "SEGUNDO_FATOR_LIGADO";
export const SEGUNDO_FATOR_DESLIGADO = "SEGUNDO_FATOR_DESLIGADO";
export const SEGUNDO_FATOR_RECUPERACAO_USADA = "SEGUNDO_FATOR_RECUPERACAO_USADA";

// ---------------------------------------------------------------------
// base32 e TOTP
// ---------------------------------------------------------------------
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32_codificar(bytes: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let saida = "";
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

export function base32_decodificar(texto: string): Buffer {
  const limpo = texto.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let valor = 0;
  const saida: number[] = [];
  for (const ch of limpo) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error("base32 inválido");
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      saida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(saida);
}

/** O código de 6 dígitos do passo `passo` (contador do RFC 4226). */
export function codigo_do_passo(segredo: Uint8Array, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = createHmac("sha1", segredo).update(contador).digest();
  const desvio = h[h.length - 1]! & 0x0f;
  const n =
    ((h[desvio]! & 0x7f) << 24) | (h[desvio + 1]! << 16) | (h[desvio + 2]! << 8) | h[desvio + 3]!;
  return String(n % 10 ** DIGITOS).padStart(DIGITOS, "0");
}

export function passo_de(agora: Date): number {
  return Math.floor(agora.getTime() / 1000 / PASSO_SEGUNDOS);
}

/**
 * O passo em que `codigo` confere (janela de ±1), ou null. `ultimo_passo` é o
 * último já usado: passo igual ou anterior é recusado (código repetido).
 */
export function passo_que_confere(
  segredo: Uint8Array,
  codigo: string,
  ultimo_passo: number | null,
  agora: Date = new Date(),
): number | null {
  const limpo = codigo.replace(/\s/g, "");
  if (!/^\d{6}$/.test(limpo)) return null;
  const atual = passo_de(agora);
  let achado: number | null = null;
  for (const passo of [atual - 1, atual, atual + 1]) {
    const esperado = codigo_do_passo(segredo, passo);
    // compara os três sempre (tempo constante entre os passos)
    if (timingSafeEqual(Buffer.from(esperado), Buffer.from(limpo)) && achado === null) achado = passo;
  }
  if (achado === null) return null;
  if (ultimo_passo !== null && achado <= ultimo_passo) return null;
  return achado;
}

export function uri_otpauth(login: string, segredo_base32: string): string {
  const rotulo = encodeURIComponent(`${EMISSOR}:${login}`);
  return `otpauth://totp/${rotulo}?secret=${segredo_base32}&issuer=${encodeURIComponent(EMISSOR)}&algorithm=SHA1&digits=${DIGITOS}&period=${PASSO_SEGUNDOS}`;
}

// ---------------------------------------------------------------------
// Cifra do segredo
// ---------------------------------------------------------------------
function _chave(): Buffer {
  return Buffer.from(hkdfSync("sha256", obterConfig().chaveSecreta, "sisa-segundo-fator", "segredo-totp", 32));
}

export function cifrar(segredo: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", _chave(), iv);
  const dados = Buffer.concat([c.update(segredo), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dados]).toString("base64");
}

export function decifrar(texto: string): Buffer | null {
  try {
    const bruto = Buffer.from(texto, "base64");
    const d = createDecipheriv("aes-256-gcm", _chave(), bruto.subarray(0, 12));
    d.setAuthTag(bruto.subarray(12, 28));
    return Buffer.concat([d.update(bruto.subarray(28)), d.final()]);
  } catch {
    // chave trocada ou registro adulterado: o fator não confere (a entrada falha)
    return null;
  }
}

// ---------------------------------------------------------------------
// Códigos de recuperação
// ---------------------------------------------------------------------
const LETRAS_RECUPERACAO = "abcdefghjkmnpqrstuvwxyz23456789";

function _novo_codigo_de_recuperacao(): string {
  const parte = () => Array.from({ length: 5 }, () => LETRAS_RECUPERACAO[randomInt(LETRAS_RECUPERACAO.length)]).join("");
  return `${parte()}-${parte()}`;
}

function _normalizar_recuperacao(texto: string): string {
  return texto.trim().toLowerCase().replace(/[\s_]/g, "");
}

function _hash_recuperacao(codigo: string): string {
  return createHmac("sha256", obterConfig().chaveSecreta).update(`recuperacao:${_normalizar_recuperacao(codigo)}`).digest("hex");
}

function _parece_recuperacao(texto: string): boolean {
  return /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(_normalizar_recuperacao(texto));
}

// ---------------------------------------------------------------------
// Cadastro, uso e desligamento
// ---------------------------------------------------------------------
export async function ativo(tx: Executor, usuario_id: number): Promise<boolean> {
  const [l] = await tx.select({ ativo_em: usuario_segundo_fator.ativo_em }).from(usuario_segundo_fator).where(eq(usuario_segundo_fator.usuario_id, usuario_id));
  return Boolean(l?.ativo_em);
}

export async function codigos_restantes(tx: Executor, usuario_id: number): Promise<number> {
  const l = await tx
    .select({ id: usuario_codigo_recuperacao.id })
    .from(usuario_codigo_recuperacao)
    .where(and(eq(usuario_codigo_recuperacao.usuario_id, usuario_id), isNull(usuario_codigo_recuperacao.usado_em)));
  return l.length;
}

export class SegundoFatorJaLigado extends Error {}

/** Começa o cadastro: gera o segredo (ainda não vale) e devolve o que o aplicativo precisa. */
export async function iniciar_cadastro(tx: Executor, usuario_id: number, login: string): Promise<{ segredo: string; uri: string }> {
  if (await ativo(tx, usuario_id)) throw new SegundoFatorJaLigado("o segundo fator já está ligado nesta conta");
  const bruto = randomBytes(20);
  const segredo = base32_codificar(bruto);
  await tx
    .insert(usuario_segundo_fator)
    .values({ usuario_id, segredo_cifrado: cifrar(bruto), ativo_em: null, ultimo_passo: null })
    .onConflictDoUpdate({
      target: usuario_segundo_fator.usuario_id,
      set: { segredo_cifrado: cifrar(bruto), ativo_em: null, ultimo_passo: null },
    });
  return { segredo, uri: uri_otpauth(login, segredo) };
}

/** O cadastro ainda não confirmado (a pessoa errou o código e tenta de novo sem reescanear). */
export async function cadastro_pendente(tx: Executor, usuario_id: number, login: string): Promise<{ segredo: string; uri: string } | null> {
  const [l] = await tx.select().from(usuario_segundo_fator).where(eq(usuario_segundo_fator.usuario_id, usuario_id));
  if (!l || l.ativo_em) return null;
  const bruto = decifrar(l.segredo_cifrado);
  if (!bruto) return null;
  const segredo = base32_codificar(bruto);
  return { segredo, uri: uri_otpauth(login, segredo) };
}

/** Confirma o cadastro com um código do aplicativo e devolve os códigos de recuperação (só desta vez). */
export async function confirmar_cadastro(
  tx: Executor,
  usuario: UsuarioAtual,
  codigo: string,
  agora: Date = new Date(),
): Promise<string[] | null> {
  const [l] = await tx.select().from(usuario_segundo_fator).where(eq(usuario_segundo_fator.usuario_id, usuario.id)).for("update");
  if (!l || l.ativo_em) return null;
  const segredo = decifrar(l.segredo_cifrado);
  if (!segredo) return null;
  const passo = passo_que_confere(segredo, codigo, null, agora);
  if (passo === null) return null;
  await tx.update(usuario_segundo_fator).set({ ativo_em: agora, ultimo_passo: passo }).where(eq(usuario_segundo_fator.usuario_id, usuario.id));
  const codigos = await _gerar_codigos_de_recuperacao(tx, usuario.id);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: usuario.id,
    tipo_evento: SEGUNDO_FATOR_LIGADO,
    descricao: `Conta '${usuario.login}': segundo fator (aplicativo autenticador) ligado.`,
    usuario,
  });
  return codigos;
}

async function _gerar_codigos_de_recuperacao(tx: Executor, usuario_id: number): Promise<string[]> {
  await tx.delete(usuario_codigo_recuperacao).where(eq(usuario_codigo_recuperacao.usuario_id, usuario_id));
  const codigos = Array.from({ length: CODIGOS_DE_RECUPERACAO }, _novo_codigo_de_recuperacao);
  await tx.insert(usuario_codigo_recuperacao).values(codigos.map((c) => ({ usuario_id, codigo_hash: _hash_recuperacao(c) })));
  return codigos;
}

/**
 * Confere o que a pessoa digitou na entrada: o código do aplicativo ou um
 * código de recuperação (que se gasta). Devolve se vale. A conta já veio
 * travada (`FOR UPDATE`) de quem chama.
 */
export async function conferir_na_entrada(
  tx: Executor,
  conta: { id: number; login: string },
  entrada: string,
  agora: Date = new Date(),
): Promise<boolean> {
  const [l] = await tx.select().from(usuario_segundo_fator).where(eq(usuario_segundo_fator.usuario_id, conta.id)).for("update");
  if (!l || !l.ativo_em) return false;
  if (_parece_recuperacao(entrada)) {
    const gasto = await tx
      .update(usuario_codigo_recuperacao)
      .set({ usado_em: agora })
      .where(
        and(
          eq(usuario_codigo_recuperacao.usuario_id, conta.id),
          eq(usuario_codigo_recuperacao.codigo_hash, _hash_recuperacao(entrada)),
          isNull(usuario_codigo_recuperacao.usado_em),
        ),
      )
      .returning({ id: usuario_codigo_recuperacao.id });
    if (!gasto.length) return false;
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: conta.id,
      tipo_evento: SEGUNDO_FATOR_RECUPERACAO_USADA,
      descricao: `Conta '${conta.login}': entrou com um código de recuperação do segundo fator.`,
      usuario: null,
      usuario_nome: conta.login,
    });
    return true;
  }
  const segredo = decifrar(l.segredo_cifrado);
  if (!segredo) return false;
  const passo = passo_que_confere(segredo, entrada, l.ultimo_passo, agora);
  if (passo === null) return false;
  await tx.update(usuario_segundo_fator).set({ ultimo_passo: passo }).where(eq(usuario_segundo_fator.usuario_id, conta.id));
  return true;
}

/** Desliga o segundo fator da conta (o dono, ou a administração) e apaga o segredo e os códigos. */
export async function desligar(
  tx: Executor,
  alvo: { id: number; login: string },
  quem: UsuarioAtual,
): Promise<boolean> {
  const apagados = await tx.delete(usuario_segundo_fator).where(eq(usuario_segundo_fator.usuario_id, alvo.id)).returning({ id: usuario_segundo_fator.usuario_id });
  await tx.delete(usuario_codigo_recuperacao).where(eq(usuario_codigo_recuperacao.usuario_id, alvo.id));
  if (!apagados.length) return false;
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: SEGUNDO_FATOR_DESLIGADO,
    descricao:
      quem.id === alvo.id
        ? `Conta '${alvo.login}': segundo fator desligado pela própria pessoa.`
        : `Conta '${alvo.login}': segundo fator desligado pela administração.`,
    usuario: quem,
  });
  return true;
}
