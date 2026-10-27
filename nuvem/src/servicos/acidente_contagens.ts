/**
 * As contagens do hub do módulo de acidentes (fatia F8): só números, cada um
 * com o link para a lista que o explica (RN-19: nunca nome). O recorte de escopo
 * e de ocorrência restrita é o da rota (`onde`).
 */
import { and, count, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_acao, acidente_ocorrencia } from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { ESTADOS_ABERTOS } from "./acidente_acao.js";

/** Ações do plano em aberto e com o prazo já passado, nos casos ao alcance. */
export async function acoes_vencidas(tx: Executor, onde: SQL | undefined): Promise<number> {
  const condicoes = [inArray(acidente_acao.estado, [...ESTADOS_ABERTOS]), lt(acidente_acao.prazo, hoje_iso()), onde].filter((c): c is SQL => !!c);
  const [linha] = await tx
    .select({ n: count() })
    .from(acidente_acao)
    .innerJoin(acidente_ocorrencia, eq(acidente_ocorrencia.id, acidente_acao.ocorrencia_id))
    .where(and(...condicoes));
  return Number(linha?.n ?? 0);
}
