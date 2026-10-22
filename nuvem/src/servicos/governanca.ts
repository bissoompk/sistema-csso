/**
 * Quem concede perfil — a trava de concorrência e a cobertura no tempo (D17).
 *
 * `perfil.conceder` é a única porta de entrada de pessoal: sem nenhuma conta
 * ativa com ela, ninguém cria conta nem concede acesso, e o sistema só volta
 * pela linha de comando (`ferramentas/redefinir-senha.ts --conceder-superintendente`).
 * As travas de /usuarios (não encerrar, não inativar a última) olhavam só o
 * dia de hoje e sem lock: duas pessoas encerrando ao mesmo tempo passavam as
 * duas, e a concessão com fim marcado vencia sozinha sem aviso nenhum.
 */
import { and, eq, like, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { pendencia as tabela_pendencia } from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { vigente_em } from "../dominio/organizacao.js";
import * as datas_br from "./datas_br.js";
import * as pendencias from "./pendencias.js";

/** Chave da advisory lock que serializa conceder, encerrar e inativar (`'gove'` em ASCII). */
export const TRAVA_GOVERNANCA = 0x676f7665;

/**
 * Serializa os atos que mudam quem concede perfil. Vale até o fim da
 * transação: a segunda requisição espera a primeira gravar e então confere a
 * trava "última conta que concede" com o banco já mudado.
 */
export async function travar(tx: Executor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TRAVA_GOVERNANCA})`);
}

/** As concessões de perfil que dá `perfil.conceder`, de conta ativa e perfil ativo. */
async function _concessoes_que_concedem(tx: Executor) {
  const todas = await tx.query.atribuicao.findMany({
    with: { usuario: true, perfil: { with: { perfil_permissoes: { with: { permissao: true } } } } },
  });
  return todas.filter(
    (a) =>
      a.usuario.ativo &&
      a.perfil.ativo &&
      a.perfil.perfil_permissoes.some((pp) => pp.permissao.codigo === "perfil.conceder"),
  );
}

/**
 * As contas ATIVAS com concessão vigente em `dia` de perfil que tem
 * `perfil.conceder` — opcionalmente sem a atribuição `sem_atribuicao` ou sem a
 * conta `sem_conta`.
 */
export async function contas_que_concedem(
  tx: Executor,
  fora: { sem_atribuicao?: number; sem_conta?: number } = {},
  dia: string = hoje_iso(),
): Promise<number[]> {
  const ids = (await _concessoes_que_concedem(tx))
    .filter((a) => a.id !== fora.sem_atribuicao && a.usuario_id !== fora.sem_conta && vigente_em(a, dia))
    .map((a) => a.usuario_id);
  return [...new Set(ids)];
}

/**
 * O primeiro dia, a partir de `hoje`, em que ninguém concede perfil — somando
 * as concessões vigentes e as futuras que emendam nelas. `null` quando a
 * cobertura não tem fim (alguma concessão sem termo a alcança).
 */
export async function fim_da_cobertura(tx: Executor, hoje: string = hoje_iso()): Promise<string | null> {
  const periodos = (await _concessoes_que_concedem(tx)).filter(
    (a) => a.vigencia_fim === null || a.vigencia_fim >= hoje,
  );
  let dia = hoje;
  for (;;) {
    const cobrem = periodos.filter((a) => vigente_em(a, dia));
    if (!cobrem.length) return dia;
    if (cobrem.some((a) => a.vigencia_fim === null)) return null;
    // a mais longa das que cobrem o dia; o dia seguinte ao fim dela é o próximo a conferir
    dia = somar_dias(cobrem.map((a) => a.vigencia_fim!).sort().at(-1)!, 1);
  }
}

export const TIPO_PENDENCIA = "COBERTURA_DE_CONCESSAO_A_VENCER";
/** Quantos dias antes do vencimento o sino avisa. */
export const JANELA_DE_AVISO_DIAS = 30;

function _chave(fim: string, usuario_id: number): string {
  return `cobertura-conceder-${fim}-${usuario_id}`;
}

/** O texto do aviso. Sem nome de ninguém: é a mesma frase para quem concede. */
export function texto_do_aviso(fim: string): string {
  return (
    `A partir de ${datas_br.numerica(fim)} ninguém concede perfil: a última concessão de quem ` +
    "concede perfil vence no dia anterior. Conceda o perfil de superintendente a outra conta, " +
    "ou uma concessão nova, antes disso (Usuários)."
  );
}

/**
 * Abre no sino de cada conta que concede perfil hoje o aviso de que a
 * cobertura acaba em até `JANELA_DE_AVISO_DIAS`, e fecha o aviso que deixou de
 * valer (outra concessão emendou, ou a data mudou). Idempotente: roda na
 * varredura noturna e depois de cada ato de /usuarios que mexe em concessão.
 *
 * Cobertura que já acabou HOJE não abre aviso: não há a quem avisar, e o
 * remédio é a linha de comando.
 */
export async function sincronizar_aviso_de_cobertura(
  tx: Executor,
  hoje: string = hoje_iso(),
): Promise<{ fim: string | null; abertas: number; fechadas: number }> {
  const fim = await fim_da_cobertura(tx, hoje);
  const valem = new Set<string>();
  let abertas = 0;
  if (fim !== null && fim > hoje && fim <= somar_dias(hoje, JANELA_DE_AVISO_DIAS)) {
    for (const usuario_id of await contas_que_concedem(tx, {}, hoje)) {
      const chave = _chave(fim, usuario_id);
      valem.add(chave);
      const p = await pendencias.abrir(tx, {
        tipo: TIPO_PENDENCIA,
        chave,
        descricao: texto_do_aviso(fim),
        responsavel_id: usuario_id,
        prazo: somar_dias(fim, -1),
      });
      if (!p.concluida) abertas += 1;
    }
  }
  let fechadas = 0;
  const em_aberto = await tx
    .select()
    .from(tabela_pendencia)
    .where(
      and(
        eq(tabela_pendencia.tipo, TIPO_PENDENCIA),
        eq(tabela_pendencia.concluida, false),
        like(tabela_pendencia.chave, "cobertura-conceder-%"),
      ),
    );
  for (const p of em_aberto) {
    if (valem.has(p.chave)) continue;
    await pendencias.concluir_pela_rotina(tx, p, "a cobertura de quem concede perfil mudou");
    fechadas += 1;
  }
  return { fim, abertas, fechadas };
}
