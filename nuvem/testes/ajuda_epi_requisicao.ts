/**
 * Montagem comum dos testes da requisição de EPI (fatias 4 e 5).
 *
 * `sessao` do pytest = uma transação desfeita no fim de cada teste
 * (`desfeito`): o protocolo `EPI-AAAA-0001` e o SIAPE fixo do cenário só
 * funcionam porque cada teste começa do banco semeado.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { obterBanco, type Executor, type Tx } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";

export const HOJE = hoje();
export const DAQUI_A_UM_ANO = somar_dias(HOJE, 365);

export const REQUERENTE = ["epi.requisitar", "epi.ver"];
export const ANALISTA = ["epi.requisitar", "epi.analisar", "epi.ver", "epi.entregar"];

class Desfazer extends Error {}

/** Roda `f` numa transação que é desfeita no fim — o `sessao` do conftest. */
export async function desfeito(f: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await obterBanco().transaction(async (tx) => {
      await f(tx);
      throw new Desfazer();
    });
  } catch (erro) {
    if (!(erro instanceof Desfazer)) throw erro;
  }
}

let _hash: string | null = null;
async function hash(): Promise<string> {
  _hash ??= await autenticacao.gerar_hash("SenhaDeTeste2026");
  return _hash;
}

/** Um `UsuarioAtual` com linha real em `usuario` (as FKs apontam para ela). */
export async function usuario(
  tx: Executor,
  o: { permissoes?: string[]; login?: string; servidor_id?: number | null; perfis?: string[] } = {},
): Promise<UsuarioAtual> {
  const login = o.login ?? "analista";
  const [registro] = await tx
    .insert(e.usuario)
    .values({
      login,
      nome: `Operador ${login}`,
      email: `${login}@teste.ufvjm.edu.br`,
      senha_hash: await hash(),
      precisa_trocar_senha: false,
      servidor_id: o.servidor_id ?? null,
    })
    .returning();
  return new UsuarioAtual({
    id: registro!.id,
    login,
    nome: registro!.nome,
    permissoes: o.permissoes ?? ANALISTA,
    perfis: o.perfis ?? ["coordenador_csso"],
    servidor_id: o.servidor_id ?? null,
  });
}

export interface Cenario {
  servidor: typeof e.servidor.$inferSelect;
  item: typeof e.epi_item.$inferSelect;
  entrada: typeof e.epi_entrada_estoque.$inferSelect;
  unidade: typeof e.unidade_uorg.$inferSelect;
  outra_unidade: typeof e.unidade_uorg.$inferSelect;
  posto: typeof e.posto_trabalho.$inferSelect | null;
  lotacao: typeof e.servidor_lotacao.$inferSelect;
}

/** Um servidor com lotação datada, um item de catálogo e um lote com saldo. */
export async function cenario(
  tx: Executor,
  o: {
    quantidade_maxima?: number | null;
    periodo_maximo_meses?: number | null;
    exige_justificativa?: boolean;
    recebido?: number;
    siape?: string;
    nome?: string;
  } = {},
): Promise<Cenario> {
  const recebido = o.recebido ?? 10;
  const [categoria] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [outra_unidade] = await tx
    .select()
    .from(e.unidade_uorg)
    .where(ne(e.unidade_uorg.id, unidade!.id))
    .orderBy(asc(e.unidade_uorg.id))
    .limit(1);
  const [posto] = await tx
    .select()
    .from(e.posto_trabalho)
    .where(eq(e.posto_trabalho.unidade_uorg_id, unidade!.id))
    .orderBy(asc(e.posto_trabalho.id))
    .limit(1);
  const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);

  const [servidor] = await tx
    .insert(e.servidor)
    .values({
      siape: o.siape ?? "7654321",
      nome: o.nome ?? "Joana Ribeiro de Almeida",
      cargo_id: cargo!.id,
      funcao: "Chefe de Laboratório",
      unidade_uorg_id: unidade!.id,
    })
    .returning();
  const [item] = await tx
    .insert(e.epi_item)
    .values({
      nome: "Luva de proteção química nitrílica",
      categoria_id: categoria!.id,
      fabricante: "Fabricante Exemplo Ltda",
      marca: "Nitri",
      modelo: "NX-200",
      exige_ca: true,
      numero_ca: "41234",
      validade_ca: DAQUI_A_UM_ANO,
      unidade_medida: "PAR",
      tamanhos: "P\nM\nG",
      vida_util_meses: 6,
      quantidade_padrao: 1,
      quantidade_maxima: o.quantidade_maxima ?? null,
      periodo_maximo_meses: o.periodo_maximo_meses ?? null,
      exige_justificativa: o.exige_justificativa ?? false,
    })
    .returning();
  const [lotacao] = await tx
    .insert(e.servidor_lotacao)
    .values({
      servidor_id: servidor!.id,
      unidade_uorg_id: unidade!.id,
      cargo_id: cargo!.id,
      funcao: "Chefe de Laboratório",
      vigencia_inicio: somar_dias(HOJE, -400),
    })
    .returning();
  if (posto) {
    await tx.insert(e.lotacao_posto).values({ lotacao_id: lotacao!.id, posto_trabalho_id: posto.id, ordem: 1 });
  }
  const [entrada] = await tx
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item!.id,
      tamanho: "M",
      empenho: "2026NE000123",
      data_entrada: somar_dias(HOJE, -30),
      quantidade_recebida: recebido,
      lote: "L-2026-08",
      numero_ca: "41234",
      validade_ca: DAQUI_A_UM_ANO,
    })
    .returning();
  await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: recebido });
  return {
    servidor: servidor!,
    item: item!,
    entrada: entrada!,
    unidade: unidade!,
    outra_unidade: outra_unidade!,
    posto: posto ?? null,
    lotacao: lotacao!,
  };
}

/** Um segundo item do catálogo, sem tamanho (o `EpiItem(...)` solto dos testes). */
export async function outro_item(tx: Executor, cen: Cenario, nome: string, numero_ca: string) {
  const [item] = await tx
    .insert(e.epi_item)
    .values({ nome, categoria_id: cen.item.categoria_id, exige_ca: true, numero_ca, quantidade_padrao: 1 })
    .returning();
  return item!;
}

export async function motivo(tx: Executor, codigo = "SEM_EXPOSICAO") {
  const [m] = await tx.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, codigo));
  return m!;
}

/** Rascunho com uma linha, pronto para enviar. */
export async function pedido_pronto(
  tx: Executor,
  cen: Cenario,
  u: UsuarioAtual,
  o: { quantidade?: number; justificativa?: string } = {},
) {
  const requisicao = await servico.criar_rascunho(tx, u, {
    servidor: cen.servidor,
    descricao_atividade: "Manipulação de reagentes no laboratório de análises",
  });
  await servico.adicionar_item(tx, u, requisicao, {
    item: cen.item,
    quantidade: o.quantidade ?? 2,
    tamanho: "M",
    justificativa: o.justificativa ?? "",
  });
  return requisicao;
}

export async function eventos(tx: Executor, entidade: string, entidade_id: number) {
  return tx
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.entidade, entidade), eq(e.historico_evento.entidade_id, entidade_id)))
    .orderBy(asc(e.historico_evento.id));
}

/** `requisicao.itens` (relido do banco). */
export function itens(tx: Executor, requisicao: { id: number }) {
  return servico.itens_de(tx, requisicao.id);
}

/** O `sessao.refresh(requisicao)`. */
export async function reler(tx: Executor, requisicao: { id: number }) {
  const [r] = await tx.select().from(e.epi_requisicao).where(eq(e.epi_requisicao.id, requisicao.id));
  return r ?? null;
}

export async function reler_linha(tx: Executor, linha: { id: number }) {
  const [r] = await tx.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.id, linha.id));
  return r ?? null;
}

/** Espera a promessa ser recusada com `classe` e devolve o erro. */
export async function recusa<T extends Error>(p: Promise<unknown>, classe: new (...a: any[]) => T): Promise<T> {
  try {
    await p;
  } catch (erro) {
    if (erro instanceof classe) return erro;
    throw erro;
  }
  throw new Error(`esperava ${classe.name}, e a operação passou`);
}
