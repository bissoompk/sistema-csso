/**
 * NUVEM (24/10/2026): os locais de treinamento — onde a turma acontece,
 * cadastrado uma vez (tela `/treinamentos/locais`).
 *
 * **O texto livre continua.** `turma.local` é o que o certificado, a agenda
 * (.ics), o e-mail de inscrição, a lista de presença e o painel sempre leram.
 * A turma que escolhe um local cadastrado (`turma.local_id`) grava nele o NOME
 * do local, e é assim que todos esses leitores mostram o cadastrado sem mudar
 * uma linha; a turma antiga (ou de "outro local") fica com o texto que tem.
 * Renomear o local leva o nome novo às turmas ainda não encerradas; a
 * concluída e a cancelada ficam com o nome do dia, como o certificado.
 *
 * **Os avisos não bloqueiam.** Vagas acima da capacidade do local e outra
 * turma no mesmo local, em dia e horário que se cruzam, saem ao salvar a
 * turma e na ficha dela — quem planeja decide (duas turmas pequenas cabem na
 * mesma sala; a capacidade cadastrada pode estar velha).
 */
import { and, asc, count, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  campus as tabela_campus,
  local_treinamento as tabela_local,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import type { UsuarioAtual } from "./rbac.js";

/** A mesma permissão que cadastra o catálogo de treinamentos. */
export const PERMISSAO = "treinamento.gerenciar";
export const TELA = "/treinamentos/locais";

export const LOCAL_CRIADO = "LOCAL_TREINAMENTO_CRIADO";
export const LOCAL_INATIVADO = "LOCAL_TREINAMENTO_INATIVADO";
export const LOCAL_REATIVADO = "LOCAL_TREINAMENTO_REATIVADO";

export type LocalRegistro = typeof tabela_local.$inferSelect;
export type LocalCarregado = LocalRegistro & { campus: typeof tabela_campus.$inferSelect | null };

/** O cadastro ou a edição que não pode ser gravado; a mensagem é de tela. */
export class LocalRecusado extends RegraViolada {}

export interface DadosLocal {
  nome: string;
  campus_id: number | null;
  endereco: string | null;
  capacidade: number | null;
  observacoes: string | null;
}

// a turma que ainda muda: é ela que recebe o nome novo e que entra nos avisos
const NAO_ENCERRADAS = ["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"] as const;

/** O mesmo nome em caixa e espaço diferentes é o mesmo local. */
function _chave(nome: string): string {
  return nome.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

async function _conferir(tx: Executor, d: DadosLocal, proprio_id: number | null): Promise<DadosLocal> {
  const nome = d.nome.trim().replace(/\s+/g, " ");
  if (!nome) throw new LocalRecusado("Preencha o nome do local: o campo não pode ficar em branco.");
  if (nome.length > 160) throw new LocalRecusado("O nome do local passa de 160 caracteres: abrevie (o endereço tem campo próprio).");
  if (d.capacidade !== null && !(Number.isInteger(d.capacidade) && d.capacidade > 0)) {
    throw new LocalRecusado("Capacidade: informe quantas pessoas cabem (um número maior que zero), ou deixe em branco.");
  }
  let sigla = "";
  if (d.campus_id !== null) {
    const [c] = await tx.select().from(tabela_campus).where(eq(tabela_campus.id, d.campus_id));
    if (!c) throw new LocalRecusado("O campus escolhido não existe mais: escolha outro.");
    sigla = c.sigla;
  }
  // o mesmo nome no mesmo campus (ou os dois sem campus) é o mesmo lugar: na
  // lista da turma, duas linhas iguais obrigariam a adivinhar qual é qual
  const mesmos = await tx
    .select({ id: tabela_local.id, nome: tabela_local.nome })
    .from(tabela_local)
    .where(
      and(
        d.campus_id === null ? sql`${tabela_local.campus_id} IS NULL` : eq(tabela_local.campus_id, d.campus_id),
        proprio_id === null ? undefined : ne(tabela_local.id, proprio_id),
      ),
    );
  const igual = mesmos.find((l) => _chave(l.nome) === _chave(nome));
  if (igual) {
    throw new LocalRecusado(
      `Já existe o local “${igual.nome}”${sigla ? ` no campus ${sigla}` : " sem campus"} — use o “Editar” da linha dele.`,
    );
  }
  return {
    nome,
    campus_id: d.campus_id,
    endereco: d.endereco?.trim() || null,
    capacidade: d.capacidade,
    observacoes: d.observacoes?.trim() || null,
  };
}

/** A lista da tela: ativos primeiro, por nome; com o campus e quantas turmas usam. */
export async function listar(tx: Executor): Promise<(LocalCarregado & { turmas: number })[]> {
  const [locais, usos] = await Promise.all([
    tx.query.local_treinamento.findMany({
      with: { campus: true },
      orderBy: [asc(tabela_local.nome), asc(tabela_local.id)],
    }) as Promise<LocalCarregado[]>,
    tx
      .select({ id: tabela_turma.local_id, n: count() })
      .from(tabela_turma)
      .where(ne(tabela_turma.situacao, "CANCELADA"))
      .groupBy(tabela_turma.local_id),
  ]);
  const por = new Map(usos.map((u) => [u.id, Number(u.n)]));
  return locais
    .map((l) => ({ ...l, turmas: por.get(l.id) ?? 0 }))
    .sort((a, b) => Number(b.ativo) - Number(a.ativo));
}

/**
 * O que o seletor da turma oferece: os ativos e, se a turma já aponta para um
 * inativo, ele — fora da lista, o navegador escolheria "outro local" e salvar
 * a turma desfaria o vínculo sem ninguém pedir.
 */
export async function opcoes(tx: Executor, atual_id: number | null = null): Promise<LocalCarregado[]> {
  const todos = (await tx.query.local_treinamento.findMany({
    with: { campus: true },
    orderBy: [asc(tabela_local.nome), asc(tabela_local.id)],
  })) as LocalCarregado[];
  return todos.filter((l) => l.ativo || l.id === atual_id);
}

export async function criar(tx: Executor, usuario: UsuarioAtual, d: DadosLocal): Promise<LocalRegistro> {
  usuario.exigir(PERMISSAO);
  const limpo = await _conferir(tx, d, null);
  const [novo] = await tx
    .insert(tabela_local)
    .values({ ...limpo, criado_por: usuario.id })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "local_treinamento",
    entidade_id: novo!.id,
    tipo_evento: LOCAL_CRIADO,
    descricao: novo!.nome + (novo!.capacidade !== null ? ` (capacidade ${novo!.capacidade})` : ""),
    usuario,
  });
  return novo!;
}

/**
 * Grava a edição com o diff campo a campo. O nome novo vai também para as
 * turmas não encerradas do local (cada uma com o diff dela na trilha): o
 * cartaz que ainda circula diz onde a turma vai ser.
 */
export async function editar(
  tx: Executor,
  usuario: UsuarioAtual,
  local_id: number,
  d: DadosLocal,
): Promise<{ local: LocalRegistro; turmas_renomeadas: number }> {
  usuario.exigir(PERMISSAO);
  const [atual] = await tx.select().from(tabela_local).where(eq(tabela_local.id, local_id));
  if (!atual) throw new LocalRecusado("Local não encontrado.");
  const limpo = await _conferir(tx, d, local_id);
  const antes: Record<string, unknown> = {};
  for (const k of Object.keys(limpo)) antes[k] = atual[k as keyof LocalRegistro];
  await tx.update(tabela_local).set(limpo).where(eq(tabela_local.id, local_id));
  await auditoria.registrar_diferencas(tx, {
    entidade: "local_treinamento",
    entidade_id: local_id,
    antes,
    depois: { ...limpo },
    usuario,
  });
  let turmas_renomeadas = 0;
  if (limpo.nome !== atual.nome) {
    const turmas = await tx
      .select({ id: tabela_turma.id, local: tabela_turma.local })
      .from(tabela_turma)
      .where(and(eq(tabela_turma.local_id, local_id), inArray(tabela_turma.situacao, [...NAO_ENCERRADAS])));
    for (const t of turmas) {
      if (t.local === limpo.nome) continue;
      await tx.update(tabela_turma).set({ local: limpo.nome }).where(eq(tabela_turma.id, t.id));
      await auditoria.registrar_diferencas(tx, {
        entidade: "turma",
        entidade_id: t.id,
        antes: { local: t.local },
        depois: { local: limpo.nome },
        usuario,
      });
      turmas_renomeadas += 1;
    }
  }
  return { local: { ...atual, ...limpo }, turmas_renomeadas };
}

/** Inativar tira o local da escolha; a turma que já o tem continua com ele. */
export async function mudar_ativo(tx: Executor, usuario: UsuarioAtual, local_id: number, ativo: boolean): Promise<LocalRegistro> {
  usuario.exigir(PERMISSAO);
  const [atual] = await tx.select().from(tabela_local).where(eq(tabela_local.id, local_id));
  if (!atual) throw new LocalRecusado("Local não encontrado.");
  if (atual.ativo === ativo) return atual;
  await tx.update(tabela_local).set({ ativo }).where(eq(tabela_local.id, local_id));
  await auditoria.registrar(tx, {
    entidade: "local_treinamento",
    entidade_id: local_id,
    tipo_evento: ativo ? LOCAL_REATIVADO : LOCAL_INATIVADO,
    descricao: atual.nome,
    campo: "ativo",
    valor_anterior: atual.ativo,
    valor_novo: ativo,
    usuario,
  });
  return { ...atual, ativo };
}

/**
 * O local que a turma escolheu, conferido: existe, está ativo (ou é o que a
 * turma já tinha) e é do campus da turma, quando os dois têm campus. Devolve
 * o local ou a recusa em texto — quem chama (`turma.ts`) a lança como regra
 * da turma, sem este módulo depender daquele.
 */
export async function conferir_para_turma(
  tx: Executor,
  local_id: number,
  campus_id: number | null,
  atual_id: number | null,
): Promise<LocalCarregado | string> {
  const local = (await tx.query.local_treinamento.findFirst({
    where: eq(tabela_local.id, local_id),
    with: { campus: true },
  })) as LocalCarregado | undefined;
  if (!local) return "O local escolhido não existe mais: escolha outro, ou use “outro local” e escreva onde.";
  if (!local.ativo && local.id !== atual_id) {
    return `O local “${local.nome}” está inativo: escolha outro, ou reative-o em Locais.`;
  }
  if (local.campus_id !== null && campus_id !== null && local.campus_id !== campus_id) {
    const [da_turma] = await tx.select().from(tabela_campus).where(eq(tabela_campus.id, campus_id));
    return (
      `O local “${local.nome}” é do campus ${local.campus?.sigla ?? ""}, e a turma é do campus ` +
      `${da_turma?.sigla ?? ""}. Escolha um local deste campus, ou corrija o campus da turma.`
    );
  }
  return local;
}

// ---------------------------------------------------------------------
// Os avisos (não bloqueiam)
// ---------------------------------------------------------------------
interface TurmaNoLocal {
  id: number;
  local_id: number | null;
  vagas: number | null;
  data_inicio: string;
  data_fim: string;
  hora_inicio: string | null;
  hora_fim: string | null;
  situacao: string;
}

/** Sem hora é o dia inteiro; sem hora de fim, até o fim do dia. */
function _faixa(t: { hora_inicio: string | null; hora_fim: string | null }): [string, string] {
  if (!t.hora_inicio) return ["00:00:00", "24:00:00"];
  return [t.hora_inicio, t.hora_fim ?? "24:00:00"];
}

/** As duas turmas ocupam a sala ao mesmo tempo em algum dia? (as datas já se cruzam) */
export function horarios_se_cruzam(
  a: { hora_inicio: string | null; hora_fim: string | null },
  b: { hora_inicio: string | null; hora_fim: string | null },
): boolean {
  const [a0, a1] = _faixa(a);
  const [b0, b1] = _faixa(b);
  // a que termina às 12h e a que começa às 12h não se chocam
  return a0 < b1 && b0 < a1;
}

function _periodo(t: { data_inicio: string; data_fim: string; hora_inicio: string | null; hora_fim: string | null }): string {
  const dias =
    t.data_inicio === t.data_fim
      ? `em ${datas_br.numerica(t.data_inicio)}`
      : `de ${datas_br.numerica(t.data_inicio)} a ${datas_br.numerica(t.data_fim)}`;
  if (!t.hora_inicio) return `${dias}, dia inteiro`;
  const h = (x: string) => {
    const [hh, mm] = x.split(":");
    return `${Number(hh)}h${mm && mm !== "00" ? mm : ""}`;
  };
  return t.hora_fim ? `${dias}, ${h(t.hora_inicio)} às ${h(t.hora_fim)}` : `${dias}, a partir das ${h(t.hora_inicio)}`;
}

/**
 * Os avisos do local da turma: vagas acima da capacidade e choque de sala
 * (outra turma não cancelada no mesmo local, com datas e horários que se
 * cruzam). A turma cancelada ou concluída não recebe aviso: não vai mais
 * ocupar sala nenhuma.
 */
export async function avisos_da_turma(tx: Executor, turma: TurmaNoLocal): Promise<string[]> {
  if (turma.local_id === null || !(NAO_ENCERRADAS as readonly string[]).includes(turma.situacao)) return [];
  const [local] = await tx.select().from(tabela_local).where(eq(tabela_local.id, turma.local_id));
  if (!local) return [];
  const avisos: string[] = [];
  if (local.capacidade !== null && turma.vagas !== null && turma.vagas > local.capacidade) {
    avisos.push(
      `Vagas acima da capacidade: a turma tem ${turma.vagas} vagas e o local “${local.nome}” ` +
        `comporta ${local.capacidade} pessoa(s).`,
    );
  }
  const vizinhas = await tx
    .select({
      id: tabela_turma.id,
      codigo: tabela_turma.codigo,
      data_inicio: tabela_turma.data_inicio,
      data_fim: tabela_turma.data_fim,
      hora_inicio: tabela_turma.hora_inicio,
      hora_fim: tabela_turma.hora_fim,
    })
    .from(tabela_turma)
    .where(
      and(
        eq(tabela_turma.local_id, turma.local_id),
        ne(tabela_turma.id, turma.id),
        ne(tabela_turma.situacao, "CANCELADA"),
        lte(tabela_turma.data_inicio, turma.data_fim),
        gte(tabela_turma.data_fim, turma.data_inicio),
      ),
    )
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_turma.id));
  for (const outra of vizinhas) {
    if (!horarios_se_cruzam(turma, outra)) continue;
    avisos.push(`Choque de sala: a turma ${outra.codigo} também usa “${local.nome}” ${_periodo(outra)}.`);
  }
  return avisos;
}

/** "Atenção: …" para o recado de quem acabou de salvar; vazio sem aviso. */
export function frase_dos_avisos(avisos: readonly string[]): string {
  return avisos.length ? ` Atenção: ${avisos.join(" ")}` : "";
}
