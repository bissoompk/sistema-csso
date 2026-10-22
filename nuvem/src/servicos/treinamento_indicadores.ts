/**
 * Os indicadores de treinamento: o que o setor fez num período, por setor
 * promotor e por treinamento.
 *
 * O recorte é a TURMA: o período é o da `data_inicio` dela, e o setor é a
 * unidade promotora. Turma cancelada fica fora de tudo — ela não treinou
 * ninguém —, menos do contador próprio, que diz quantas foram.
 *
 * As contagens são de inscrições (a pessoa que fez dois cursos conta duas
 * vezes), como no IntegraSST. A supressão da RN-19 é da rota: aqui só se conta.
 */
import { and, count, eq, gte, inArray, lte, ne, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import { INSCRICAO_OCUPA_VAGA } from "../dominio/estados.js";
import { aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import * as setor_equipe from "./setor_equipe.js";

export const SEM_SETOR = "(sem setor promotor)";
export const TOP_TREINAMENTOS = 10;

const ATIVAS = new Set(["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"]);

export interface Filtros {
  /** 'AAAA-MM-DD', inclusive; null = sem limite */
  de: string | null;
  ate: string | null;
  unidade_promotora_id: number | null;
}

export interface Indicadores {
  turmas: number;
  turmas_ativas: number;
  turmas_concluidas: number;
  turmas_canceladas: number;
  participantes: number;
  aguardando_confirmacao: number;
  aprovados: number;
  reprovados: number;
  faltas: number;
  emitidos: number;
  /** aprovado sem certificado emitido */
  pendentes: number;
  /** aprovados ÷ (aprovados + reprovados), em %; null sem resultado ainda */
  taxa_aprovacao: number | null;
  turmas_por_setor: Record<string, number>;
  participantes_por_treinamento: Record<string, number>;
}

/**
 * O recorte das turmas que o indicador conta: o alcance de `indicador.ver`, e
 * não o filtro de linha de `treinamento.ver` (D1, regressão). Com "o agregado
 * nunca é linha", o `admin_ti` sem servidor contava zero; ligado a servidor,
 * caía no "cartaz" do titular e contava a instituição inteira — o número
 * dependia do vínculo. O agregado (A), o total e a unidade sem campus contam
 * tudo (a supressão RN-19 é da tela); o campus da concessão recorta pelo campus
 * da turma.
 */
function _recorte(usuario: UsuarioAtual): SQL | undefined {
  // NUVEM: e o setor promotor — cada setor conta as turmas que promove
  // (`setor_equipe.ts`); quem vê todos os setores conta a instituição
  const setor = setor_equipe.condicao_setor_turma(usuario);
  const alcance = usuario.alcance("indicador.ver");
  if (alcance.total || alcance.unidade || alcance.agregado) return setor;
  return and(aplicar_escopo(usuario, tabela_turma, "indicador.ver"), setor);
}

export async function calcular(tx: Executor, usuario: UsuarioAtual, f: Filtros): Promise<Indicadores> {
  const onde: (SQL | undefined)[] = [_recorte(usuario)];
  if (f.de) onde.push(gte(tabela_turma.data_inicio, f.de));
  if (f.ate) onde.push(lte(tabela_turma.data_inicio, f.ate));
  if (f.unidade_promotora_id) onde.push(eq(tabela_turma.unidade_promotora_id, f.unidade_promotora_id));
  const turmas = await tx
    .select({
      id: tabela_turma.id,
      situacao: tabela_turma.situacao,
      setor: tabela_unidade.sigla,
      setor_nome: tabela_unidade.nome_extenso,
      treinamento: tabela_treinamento.nome,
    })
    .from(tabela_turma)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .leftJoin(tabela_unidade, eq(tabela_unidade.id, tabela_turma.unidade_promotora_id))
    .where(and(...onde));

  const r: Indicadores = {
    turmas: 0,
    turmas_ativas: 0,
    turmas_concluidas: 0,
    turmas_canceladas: 0,
    participantes: 0,
    aguardando_confirmacao: 0,
    aprovados: 0,
    reprovados: 0,
    faltas: 0,
    emitidos: 0,
    pendentes: 0,
    taxa_aprovacao: null,
    turmas_por_setor: {},
    participantes_por_treinamento: {},
  };
  const validas = turmas.filter((t) => t.situacao !== "CANCELADA");
  r.turmas_canceladas = turmas.length - validas.length;
  r.turmas = validas.length;
  const treinamento_da_turma = new Map<number, string>();
  for (const t of validas) {
    if (ATIVAS.has(t.situacao)) r.turmas_ativas += 1;
    if (t.situacao === "CONCLUIDA") r.turmas_concluidas += 1;
    const setor = t.setor_nome ? (t.setor ? `${t.setor_nome} (${t.setor})` : t.setor_nome) : SEM_SETOR;
    r.turmas_por_setor[setor] = (r.turmas_por_setor[setor] ?? 0) + 1;
    treinamento_da_turma.set(t.id, t.treinamento);
  }
  if (!validas.length) return r;

  const ids = validas.map((t) => t.id);
  const por_situacao = await tx
    .select({ turma_id: tabela_inscricao.turma_id, situacao: tabela_inscricao.situacao, n: count() })
    .from(tabela_inscricao)
    .where(inArray(tabela_inscricao.turma_id, ids))
    .groupBy(tabela_inscricao.turma_id, tabela_inscricao.situacao);
  const por_treinamento: Record<string, number> = {};
  for (const l of por_situacao) {
    const n = Number(l.n);
    if (INSCRICAO_OCUPA_VAGA.has(l.situacao)) {
      r.participantes += n;
      const nome = treinamento_da_turma.get(l.turma_id)!;
      por_treinamento[nome] = (por_treinamento[nome] ?? 0) + n;
    }
    if (l.situacao === "INSCRITA" || l.situacao === "AGUARDANDO_EMAIL") r.aguardando_confirmacao += n;
    if (l.situacao === "APROVADO") r.aprovados += n;
    if (l.situacao === "REPROVADO") r.reprovados += n;
    if (l.situacao === "AUSENTE") r.faltas += n;
  }
  // o certificado em vigor de cada aprovado: um por inscrição (o anulado não conta)
  const [emitidos] = await tx
    .select({ n: count() })
    .from(tabela_certificado)
    .innerJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_certificado.inscricao_id))
    .where(and(inArray(tabela_inscricao.turma_id, ids), eq(tabela_certificado.situacao, "EMITIDO")));
  r.emitidos = Number(emitidos?.n ?? 0);
  const [aprovados_com] = await tx
    .select({ n: count() })
    .from(tabela_certificado)
    .innerJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_certificado.inscricao_id))
    .where(
      and(
        inArray(tabela_inscricao.turma_id, ids),
        eq(tabela_certificado.situacao, "EMITIDO"),
        eq(tabela_inscricao.situacao, "APROVADO"),
      ),
    );
  r.pendentes = Math.max(0, r.aprovados - Number(aprovados_com?.n ?? 0));
  const com_resultado = r.aprovados + r.reprovados;
  r.taxa_aprovacao = com_resultado ? Math.round((r.aprovados * 1000) / com_resultado) / 10 : null;
  // os que mais treinaram, do maior para o menor
  r.participantes_por_treinamento = Object.fromEntries(
    Object.entries(por_treinamento)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_TREINAMENTOS),
  );
  return r;
}

/** Os setores que já promoveram turma, para o filtro (só os que a conta alcança). */
export async function setores_promotores(tx: Executor, usuario: UsuarioAtual | null = null) {
  return tx
    .selectDistinct({ id: tabela_unidade.id, nome: tabela_unidade.nome_extenso, sigla: tabela_unidade.sigla })
    .from(tabela_turma)
    .innerJoin(tabela_unidade, eq(tabela_unidade.id, tabela_turma.unidade_promotora_id))
    .where(and(ne(tabela_turma.situacao, "CANCELADA"), usuario ? _recorte(usuario) : undefined))
    .orderBy(tabela_unidade.nome_extenso);
}
