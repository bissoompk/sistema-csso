/**
 * O monitor de reciclagem: quem tem certificado que vence, quando, e o alerta
 * de 30 dias.
 *
 * Só conta o certificado **em vigor** de cada pessoa em cada treinamento — o
 * último emitido, não anulado. O antigo de quem já se reciclou não é
 * vencimento de ninguém: a pessoa tem o novo. E o último que não expira
 * (`data_vencimento` nula) tira a pessoa do monitor.
 *
 * O alerta é uma pendência por certificado, sem responsável (é do setor), que
 * a varredura noturna abre quando o vencimento entra na janela e fecha quando
 * a pessoa se recicla ou o certificado é anulado. Só abre para quem ainda
 * está na janela: o vencido de anos atrás aparece no monitor, mas não vira
 * uma enxurrada de tarefas no dia em que esta rotina começa a rodar.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  participante as tabela_participante,
  pendencia as tabela_pendencia,
  treinamento as tabela_treinamento,
} from "../db/esquema/index.js";
import { somar_dias } from "../dominio/datas.js";
import { Certificado, DIAS_AVISO_RECICLAGEM } from "../dominio/treinamento.js";
import * as datas_br from "./datas_br.js";
import * as aviso_reciclagem from "./aviso_reciclagem.js";
import * as pendencias from "./pendencias.js";
import { ESCOPO_PROPRIO, aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import * as setor_equipe from "./setor_equipe.js";
import * as textos from "./textos.js";

export const TIPO_PENDENCIA = "CERTIFICADO_A_VENCER";

export function chave_da_pendencia(certificado: { id: number }): string {
  return `certificado-${certificado.id}-a-vencer`;
}

export interface LinhaReciclagem {
  id: number;
  rotulo: string;
  participante_nome: string;
  participante_identificador: string;
  participante_lotacao: string;
  treinamento_id: number;
  treinamento_nome: string;
  turma_codigo: string;
  data_emissao: string;
  data_vencimento: string;
  situacao: "VENCIDO" | "A_VENCER" | "VALIDO";
}

/**
 * O certificado em vigor de cada par participante × treinamento, quando ele
 * expira. `onde` recorta antes (o escopo de quem lê); o "último" é decidido
 * entre os que sobraram — o titular de escopo próprio só vê os dele, e os
 * dele bastam para saber qual é o último.
 */
async function _em_vigor(tx: Executor, onde: SQL | undefined) {
  const linhas = await tx
    .select({
      id: tabela_certificado.id,
      numero: tabela_certificado.numero,
      ano: tabela_certificado.ano,
      participante_id: tabela_certificado.participante_id,
      treinamento_id: tabela_certificado.treinamento_id,
      data_emissao: tabela_certificado.data_emissao,
      data_vencimento: tabela_certificado.data_vencimento,
      // o nome que o papel diz (o congelado), como na lista de certificados
      participante_nome: sql<string | null>`${tabela_certificado.contexto_congelado}->>'participante_nome'`,
      participante_lotacao: sql<string | null>`${tabela_certificado.contexto_congelado}->>'participante_lotacao'`,
      turma_codigo: sql<string | null>`${tabela_certificado.contexto_congelado}->>'turma_codigo'`,
      treinamento_congelado: sql<string | null>`${tabela_certificado.contexto_congelado}->>'treinamento_nome'`,
      treinamento_nome: tabela_treinamento.nome,
      participante_identificador: tabela_participante.identificador_publico,
    })
    .from(tabela_certificado)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_certificado.treinamento_id))
    .innerJoin(tabela_participante, eq(tabela_participante.id, tabela_certificado.participante_id))
    .where(and(eq(tabela_certificado.situacao, "EMITIDO"), onde))
    .orderBy(asc(tabela_certificado.data_emissao), asc(tabela_certificado.ano), asc(tabela_certificado.numero));
  // em ordem de emissão: o último a entrar no mapa é o em vigor
  const ultimo = new Map<string, (typeof linhas)[number]>();
  for (const l of linhas) ultimo.set(`${l.participante_id}:${l.treinamento_id}`, l);
  return [...ultimo.values()].filter((l) => l.data_vencimento !== null);
}

export interface Filtros {
  situacao?: string;
  treinamento_id?: number | null;
  busca?: string;
}

/**
 * As linhas do monitor, do vencimento mais próximo ao mais distante, e a
 * contagem por situação (antes do filtro de situação, para as fichas dizerem
 * quantos há em cada uma).
 */
export async function monitor(
  tx: Executor,
  usuario: UsuarioAtual,
  hoje: string,
  filtros: Filtros = {},
): Promise<{ itens: LinhaReciclagem[]; contagem: Record<string, number> }> {
  // o monitor é a tela de `certificado.ver`: o alcance é o dela (D1/D9)
  const onde: (SQL | undefined)[] = [aplicar_escopo(usuario, tabela_certificado, "certificado.ver")];
  // NUVEM: a equipe vê o vencimento das turmas do próprio setor (`setor_equipe.ts`)
  if (usuario.escopo_de("certificado.ver") !== ESCOPO_PROPRIO) onde.push(setor_equipe.condicao_setor_certificado(usuario));
  if (filtros.treinamento_id) onde.push(eq(tabela_certificado.treinamento_id, filtros.treinamento_id));
  const termo = textos.chave_busca(filtros.busca ?? "");
  let itens: LinhaReciclagem[] = (await _em_vigor(tx, and(...onde))).map((l) => ({
    id: l.id,
    rotulo: Certificado.rotulo(l),
    participante_nome: l.participante_nome ?? "",
    participante_identificador: l.participante_identificador,
    participante_lotacao: l.participante_lotacao ?? "",
    treinamento_id: l.treinamento_id,
    treinamento_nome: l.treinamento_congelado || l.treinamento_nome,
    turma_codigo: l.turma_codigo ?? "",
    data_emissao: l.data_emissao,
    data_vencimento: l.data_vencimento!,
    situacao: Certificado.situacao_reciclagem(l, hoje),
  }));
  // nome, identificador, lotação, curso ou turma — o que o setor tem na mão
  if (termo) {
    itens = itens.filter((x) =>
      textos
        .chave_busca(
          [x.participante_nome, x.participante_identificador, x.participante_lotacao, x.treinamento_nome, x.turma_codigo].join(" "),
        )
        .includes(termo),
    );
  }
  const contagem: Record<string, number> = { VENCIDO: 0, A_VENCER: 0, VALIDO: 0 };
  for (const x of itens) contagem[x.situacao]! += 1;
  if (filtros.situacao && filtros.situacao in contagem) itens = itens.filter((x) => x.situacao === filtros.situacao);
  itens.sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento) || a.participante_nome.localeCompare(b.participante_nome));
  return { itens, contagem };
}

export interface ResultadoVarredura {
  abertas: number;
  fechadas: number;
  /** avisos por e-mail postos na fila (só com o automático ligado) */
  avisados: number;
}

/**
 * Abre o alerta de quem entrou na janela e fecha o de quem saiu dela por ter
 * se reciclado (o certificado deixou de ser o em vigor) ou ter o certificado
 * anulado. Idempotente: a chave é o certificado.
 */
export async function varrer(tx: Executor, hoje: string): Promise<ResultadoVarredura> {
  const resultado: ResultadoVarredura = { abertas: 0, fechadas: 0, avisados: 0 };
  const automatico = await aviso_reciclagem.automatico_ligado(tx);
  const em_vigor = await _em_vigor(tx, undefined);
  const vigentes = new Set(em_vigor.map((l) => l.id));
  const limite = somar_dias(hoje, DIAS_AVISO_RECICLAGEM);
  for (const l of em_vigor) {
    if (l.data_vencimento! < hoje || l.data_vencimento! > limite) continue;
    const chave = chave_da_pendencia(l);
    const [ja] = await tx.select({ id: tabela_pendencia.id }).from(tabela_pendencia).where(eq(tabela_pendencia.chave, chave));
    if (ja) continue;
    // sem nome: a tarefa circula no sino do setor (ver `turma.ts`, a de confirmação)
    await pendencias.abrir(tx, {
      tipo: TIPO_PENDENCIA,
      chave,
      descricao:
        `Certificado ${Certificado.rotulo(l)} · ${l.treinamento_congelado || l.treinamento_nome} · ` +
        `participante ${l.participante_identificador} vence em ${datas_br.numerica(l.data_vencimento!)}. ` +
        "Programe a reciclagem.",
      entidade: "certificado",
      entidade_id: l.id,
      prazo: l.data_vencimento,
    });
    resultado.abertas += 1;
    // o aviso ao participante sai no mesmo dia em que a tarefa do setor nasce
    if (automatico && (await aviso_reciclagem.avisar_pela_rotina(tx, l.id, hoje))) resultado.avisados += 1;
  }
  const abertas = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.tipo, TIPO_PENDENCIA), eq(tabela_pendencia.concluida, false)));
  for (const p of abertas) {
    if (p.entidade_id !== null && vigentes.has(p.entidade_id)) continue;
    await pendencias.concluir_pela_rotina(tx, p, "o participante se reciclou ou o certificado foi anulado");
    resultado.fechadas += 1;
  }
  return resultado;
}

/** Os certificados de uma lista que estão na janela de aviso (para a ficha). */
export async function na_janela(tx: Executor, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const linhas = await tx
    .select({ entidade_id: tabela_pendencia.entidade_id })
    .from(tabela_pendencia)
    .where(
      and(
        eq(tabela_pendencia.tipo, TIPO_PENDENCIA),
        eq(tabela_pendencia.concluida, false),
        inArray(tabela_pendencia.entidade_id, ids),
      ),
    );
  return new Set(linhas.map((l) => l.entidade_id!));
}
