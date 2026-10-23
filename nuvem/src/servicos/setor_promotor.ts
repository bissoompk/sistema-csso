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
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { CORES_SETOR, ICONES_SETOR } from "../dominio/organizacao.js";
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

/**
 * NUVEM: a frase do seletor para quem não vê todos os setores
 * (`setor_equipe.ts`): só aparecem os setores da própria conta.
 */
export const DICA_DOS_MEUS =
  "Só aparecem os setores promotores a que a sua conta está vinculada. " +
  "Para outro setor, peça à coordenação.";

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
export async function opcoes(
  tx: Executor,
  atual_id: number | null = null,
  // NUVEM: os setores da conta, quando ela não vê todos (`setor_equipe.ts`);
  // o valor gravado na turma fica, como fica o de fora da lista
  so_estes: readonly number[] | null = null,
): Promise<Opcao[]> {
  const promotores =
    so_estes === null
      ? eq(tabela_unidade.promove_treinamento, true)
      : and(eq(tabela_unidade.promove_treinamento, true), inArray(tabela_unidade.id, [...so_estes, -1]));
  const onde = atual_id === null ? promotores : or(promotores, eq(tabela_unidade.id, atual_id));
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

// =====================================================================
// NUVEM (Portal do servidor, 22/10/2026): a aparência do setor promotor
// =====================================================================

/**
 * A cor e o ícone do setor (`unidade_uorg.cor_setor`/`icone_setor`), da
 * paleta FECHADA de `dominio/organizacao.ts`. `null` é a cor do sistema (o
 * `.setor--padrao` do CSS) e, no ícone, selo sem ícone. O valor de fora da
 * paleta é recusado aqui, antes do CHECK do banco, para virar aviso e não 500.
 * A trilha é o `CAMPO_ALTERADO` de sempre, campo a campo.
 */
export async function definir_aparencia(
  tx: Executor,
  usuario: UsuarioAtual,
  unidade_id: number,
  cor: string | null,
  icone: string | null,
): Promise<Unidade> {
  usuario.exigir(PERMISSAO);
  if (cor !== null && !(CORES_SETOR as readonly string[]).includes(cor)) {
    throw new SetorPromotorRecusado("Cor fora da paleta do sistema — escolha uma das cores da lista.");
  }
  if (icone !== null && !(ICONES_SETOR as readonly string[]).includes(icone)) {
    throw new SetorPromotorRecusado("Ícone fora da lista do sistema — escolha um dos ícones oferecidos.");
  }
  const [u] = await tx.select().from(tabela_unidade).where(eq(tabela_unidade.id, unidade_id));
  if (!u) throw new SetorPromotorRecusado("Unidade não encontrada.");
  if (!u.promove_treinamento) {
    throw new SetorPromotorRecusado(`${u.nome_extenso} não está entre os setores promotores — inclua-a antes.`);
  }
  if (u.cor_setor === cor && u.icone_setor === icone) return u;
  const [nova] = await tx
    .update(tabela_unidade)
    .set({ cor_setor: cor, icone_setor: icone })
    .where(eq(tabela_unidade.id, unidade_id))
    .returning();
  await auditoria.registrar_diferencas(tx, {
    entidade: "unidade_uorg",
    entidade_id: unidade_id,
    antes: { cor_setor: u.cor_setor, icone_setor: u.icone_setor },
    depois: { cor_setor: cor, icone_setor: icone },
    usuario,
  });
  return nova!;
}
