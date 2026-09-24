/**
 * NUP — Número Único de Protocolo (Portaria Interministerial MJ/MP 1.677/2015).
 * Porte de `app/servicos/nup.py`.
 *
 * Formato: OOOOO.SSSSSS/AAAA-DD  ->  23086.021284/2024-56
 *
 * Algoritmo dos dígitos verificadores (módulo 11 com a regra específica do NUP;
 * a variante genérica "resto 0 ou 1 -> dígito 0" erra 4 dos 16 NUPs reais):
 *
 *     base15 = orgao(5) || sequencial(6) || ano(4)
 *     DV1: soma = SUM(digito[i] * peso[i]) com pesos 16..2
 *          dv = 11 - (soma mod 11); DV1 = 1 se dv == 11, 0 se dv == 10, senão dv
 *     DV2: mesma conta sobre base15||DV1 com pesos 17..2
 */

export const PADRAO = /^(\d{5})\.(\d{6})\/(\d{4})-(\d{2})$/;
export const ORGAO_UFVJM = "23086";

/** O `ValueError` do Python: a mensagem é a mesma. */
export class NupInvalido extends Error {}

function _digito(base: string, peso_inicial: number): number {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (peso_inicial - i);
  const dv = 11 - (soma % 11);
  if (dv === 11) return 1;
  if (dv === 10) return 0;
  return dv;
}

/** Recebe os 15 dígitos (órgão+sequencial+ano) e devolve os 2 DV. */
export function nup_dv(base15: string): string {
  if (!/^\d{15}$/.test(base15)) throw new NupInvalido("base do NUP deve ter exatamente 15 digitos");
  const dv1 = _digito(base15, 16);
  const dv2 = _digito(base15 + String(dv1), 17);
  return `${dv1}${dv2}`;
}

/** O `repr()` do Python para a mensagem de erro (aspas simples). */
function repr(v: unknown): string {
  const s = String(v);
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`;
}

/**
 * Aceita colagem suja ('23086 021284 2024 56', sem pontuação, com espaços)
 * e devolve no formato canônico. Lança `NupInvalido` se não der 17 dígitos.
 */
export function normalizar(bruto: string | null | undefined): string {
  if (!bruto) throw new NupInvalido("NUP vazio");
  const digitos = String(bruto).replace(/\D/g, "");
  if (digitos.length !== 17) {
    throw new NupInvalido(`NUP deve ter 17 digitos (encontrados ${digitos.length}): ${repr(bruto)}`);
  }
  return `${digitos.slice(0, 5)}.${digitos.slice(5, 11)}/${digitos.slice(11, 15)}-${digitos.slice(15)}`;
}

export function formato_ok(nup: string | null | undefined): boolean {
  return Boolean(nup) && PADRAO.test(nup!);
}

export function dv_ok(nup: string): boolean {
  const m = PADRAO.exec(nup);
  if (!m) return false;
  const [, orgao, seq, ano, dv] = m;
  return nup_dv(orgao! + seq! + ano!) === dv;
}

export interface ResultadoNup {
  valor: string;
  formato_ok: boolean;
  dv_ok: boolean;
  aviso: string | null;
  readonly valido: boolean;
}

function resultado(valor: string, fmt: boolean, dv: boolean, aviso: string | null): ResultadoNup {
  return Object.freeze({
    valor,
    formato_ok: fmt,
    dv_ok: dv,
    aviso,
    get valido() {
      return fmt && dv;
    },
  });
}

/** RN-10: formato inválido bloqueia; DV inválido é aviso NÃO bloqueante. */
export function validar(bruto: string | null | undefined): ResultadoNup {
  let valor: string;
  try {
    valor = normalizar(bruto);
  } catch (erro) {
    return resultado(String(bruto ?? ""), false, false, (erro as Error).message);
  }
  if (!dv_ok(valor)) {
    return resultado(valor, true, false, "dígito verificador não confere — confirme no SEI");
  }
  return resultado(valor, true, true, null);
}

/** Todos os NUPs da UFVJM presentes num texto livre (descrição de cartão). */
export function extrair(texto: string | null | undefined): string[] {
  if (!texto) return [];
  return texto.match(/23086\.\d{6}\/\d{4}-\d{2}/g) ?? [];
}
