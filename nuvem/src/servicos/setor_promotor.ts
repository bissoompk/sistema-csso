/**
 * NUVEM: os setores que podem promover turma (`unidade_uorg.promove_treinamento`).
 *
 * A unidade promotora continua aparecendo onde sempre apareceu (", promovido
 * por …" no certificado, a lista de turmas, o "Promoção" da inscrição pública,
 * a lista de presença, os indicadores). O que muda é o que se ESCOLHE: só os
 * setores que o próprio setor cadastrou para isso — no começo, os da Sisa
 * (`sementes.SETORES_PROMOTORES_INICIAIS`, migração 0011). A estrutura da UFVJM
 * inteira continua em `unidade_uorg`, para lotação, parecer e EPI.
 *
 * A turma antiga que já aponta para uma unidade fora da lista fica com ela: a
 * edição não obriga a trocar, e o seletor mostra o valor gravado como "fora da
 * lista atual" (a guarda está em `turma.criar_turma` e `turma.editar_turma`).
 */
import { asc, eq, or } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { unidade_uorg as tabela_unidade } from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export type Unidade = typeof tabela_unidade.$inferSelect;

/** Quem mantém a lista: a mesma permissão do catálogo de treinamentos. */
export const PERMISSAO = "treinamento.gerenciar";
export const TELA = "/treinamentos/setores-promotores";

/** A frase do seletor de turma, para quem não acha o setor que procura. */
export const DICA =
  "Só aparecem os setores cadastrados para promover treinamentos " +
  "(Treinamentos → Setores promotores).";

/** A unidade num seletor de turma: `fora_da_lista` é o valor antigo que fica. */
export type Opcao = Unidade & { fora_da_lista: boolean };

/** Os setores promotores, pelo nome. */
export async function listar(tx: Executor): Promise<Unidade[]> {
  return tx
    .select()
    .from(tabela_unidade)
    .where(eq(tabela_unidade.promove_treinamento, true))
    .orderBy(asc(tabela_unidade.nome_extenso));
}

/**
 * As opções do seletor "Unidade promotora": os promotores e, quando a turma já
 * aponta para outra unidade, essa também — marcada, para a edição não apagá-la
 * em silêncio. Uma consulta só.
 */
export async function opcoes(tx: Executor, atual_id: number | null = null): Promise<Opcao[]> {
  const onde =
    atual_id === null
      ? eq(tabela_unidade.promove_treinamento, true)
      : or(eq(tabela_unidade.promove_treinamento, true), eq(tabela_unidade.id, atual_id));
  const linhas = await tx.select().from(tabela_unidade).where(onde).orderBy(asc(tabela_unidade.nome_extenso));
  return linhas.map((u) => ({ ...u, fora_da_lista: !u.promove_treinamento }));
}

/**
 * A recusa da unidade escolhida, ou `null` quando ela serve. Quem chama
 * (`turma.ts`) já deixou passar o valor que a turma tinha.
 */
export async function recusa(tx: Executor, unidade_id: number): Promise<string | null> {
  const [u] = await tx
    .select({ id: tabela_unidade.id, nome: tabela_unidade.nome_extenso, promove: tabela_unidade.promove_treinamento })
    .from(tabela_unidade)
    .where(eq(tabela_unidade.id, unidade_id));
  if (!u) return "Unidade promotora não encontrada.";
  if (!u.promove) {
    return (
      `${u.nome} não está entre os setores que promovem treinamentos. ` +
      "Escolha um setor da lista ou peça a quem gerencia o catálogo de treinamentos " +
      "para incluí-lo em Treinamentos → Setores promotores."
    );
  }
  return null;
}

/** A recusa da tela de setores promotores, que a rota traduz em aviso. */
export class SetorPromotorRecusado extends Error {}

/**
 * Inclui ou retira a unidade da lista, com o diff na trilha (o mesmo
 * `CAMPO_ALTERADO` da edição em linha dos catálogos). Turma que já aponta
 * para a unidade retirada não muda (ver o cabeçalho).
 */
export async function marcar(tx: Executor, usuario: UsuarioAtual, unidade_id: number, promove: boolean): Promise<Unidade> {
  usuario.exigir(PERMISSAO);
  const [u] = await tx.select().from(tabela_unidade).where(eq(tabela_unidade.id, unidade_id));
  if (!u) throw new SetorPromotorRecusado("Unidade não encontrada.");
  if (promove && !u.ativo) {
    throw new SetorPromotorRecusado(`${u.nome_extenso} está inativa no catálogo de unidades — reative-a antes.`);
  }
  if (u.promove_treinamento === promove) return u;
  const [nova] = await tx
    .update(tabela_unidade)
    .set({ promove_treinamento: promove })
    .where(eq(tabela_unidade.id, unidade_id))
    .returning();
  await auditoria.registrar_diferencas(tx, {
    entidade: "unidade_uorg",
    entidade_id: unidade_id,
    antes: { promove_treinamento: u.promove_treinamento },
    depois: { promove_treinamento: promove },
    usuario,
  });
  return nova!;
}
