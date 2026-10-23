/**
 * Os pedidos que chegaram pelo link público, de todas as turmas, para aceitar
 * ou recusar de uma vez.
 *
 * No IntegraSST o formulário público já inscrevia: a equipe não fazia nada. Aqui
 * o pedido nasce `AGUARDANDO_EMAIL` e só vira inscrição quando alguém confere
 * (`inscricao_publica.ts`), o que numa turma de 30 pessoas eram 60 cliques, um
 * pedido por vez. A regra de cada aceite continua a de sempre
 * (`turma.mudar_situacao_inscricao`, com a vaga conferida sob trava); o lote
 * só põe cada pedido no seu savepoint, e o que travar fica como estava, com o
 * motivo no relatório.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { TransicaoInvalida } from "../dominio/estados.js";
import { Participante } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as duplicados from "./duplicados.js";
import * as mesclagem from "./mesclagem.js";
import { nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import * as servico_turma from "./turma.js";
import * as dono_turma from "./dono_turma.js";

/** Teto de um lote: o mesmo do teto de pedidos em espera por turma. */
export const LIMITE_LOTE = 200;

export interface PedidoNaFila {
  inscricao_id: number;
  turma_id: number;
  nome: string;
  identificador: string;
  vinculo: string;
  organizacao: string | null;
  email: string;
  observacao: string | null;
  criado_em: Date;
  /**
   * Com quem o pedido parece (23/10/2026, `duplicados.procurar`): o `PTC-…`
   * sempre, o nome só para quem pode lê-lo. O visitante não vê nada disto.
   */
  parecidos: duplicados.ParecidoNaTela[];
}

export interface TurmaComPedidos {
  id: number;
  codigo: string;
  treinamento: string;
  data_inicio: string;
  vagas: number | null;
  vagas_restantes: number | null;
  pedidos: PedidoNaFila[];
  /** NUVEM: a conta decide os pedidos desta turma (`dono_turma.ts`)? Senão, o aviso */
  pode_decidir: boolean;
  aviso_dono: string;
}

/** Os pedidos a conferir, agrupados pela turma, da turma mais próxima à mais distante. */
export async function a_conferir(tx: Executor, usuario: UsuarioAtual): Promise<TurmaComPedidos[]> {
  const linhas = await tx
    .select({ id: tabela_inscricao.id, turma_id: tabela_inscricao.turma_id })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    // o alcance de `turma.inscrever`, a permissão da tela e do ato (D9)
    .where(and(servico_turma.consulta_no_escopo(usuario, "turma.inscrever"), eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_inscricao.id))
    .limit(LIMITE_LOTE * 5);
  if (!linhas.length) return [];

  const turmas = await tx
    .select({
      id: tabela_turma.id,
      codigo: tabela_turma.codigo,
      treinamento: tabela_treinamento.nome,
      data_inicio: tabela_turma.data_inicio,
      vagas: tabela_turma.vagas,
    })
    .from(tabela_turma)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(inArray(tabela_turma.id, [...new Set(linhas.map((l) => l.turma_id))]))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_turma.id));

  const saida = new Map<number, TurmaComPedidos>();
  const direitos = await dono_turma.direitos_nas_turmas(tx, usuario, turmas.map((t) => t.id));
  for (const t of turmas) {
    const d = direitos.get(t.id);
    saida.set(t.id, {
      ...t,
      vagas_restantes: await servico_turma.vagas_restantes(tx, t as never),
      pedidos: [],
      pode_decidir: d ? d.pode(dono_turma.INSCRICOES) : false,
      aviso_dono: d ? dono_turma.recusa_de(d, dono_turma.INSCRICOES) : "",
    });
  }
  for (const l of linhas) {
    const i = await servico_turma.carregar_inscricao(tx, l.id);
    if (!i) continue;
    saida.get(l.turma_id)!.pedidos.push({
      inscricao_id: i.id,
      turma_id: i.turma_id,
      nome: nome_exibicao(i.participante),
      identificador: i.participante.identificador_publico,
      vinculo: i.participante.vinculo,
      organizacao: i.participante.organizacao,
      email: Participante.email_exibicao(i.participante),
      observacao: i.observacao,
      criado_em: i.inscrito_em,
      parecidos: duplicados.na_tela(await duplicados.procurar(tx, duplicados.alvo_do_cadastro(i.participante)), usuario),
    });
  }
  return [...saida.values()].filter((t) => t.pedidos.length);
}

// ---------------------------------------------------------------------
// "Parece com PTC-…": usar o cadastro que já existe, ou não é a mesma pessoa
// ---------------------------------------------------------------------
export class DecisaoRecusada extends RegraViolada {}

async function _pedido_no_escopo(tx: Executor, usuario: UsuarioAtual, inscricao_id: number) {
  const inscricao = await servico_turma.carregar_inscricao(tx, inscricao_id);
  if (!inscricao || inscricao.situacao !== "AGUARDANDO_EMAIL" || inscricao.origem !== "PUBLICA") {
    throw new DecisaoRecusada("Este pedido já foi decidido ou não existe mais.");
  }
  if (!(await servico_turma.no_escopo(tx, usuario, inscricao.turma_id, "turma.inscrever"))) {
    throw new DecisaoRecusada("Este pedido já foi decidido ou não existe mais.");
  }
  return inscricao;
}

async function _parecido_do_pedido(tx: Executor, pessoa: ParticipanteCarregado, participante_id: number) {
  const achados = await duplicados.procurar(tx, duplicados.alvo_do_cadastro(pessoa), { limite: 50 });
  const outro = achados.find((p) => p.pessoa.id === participante_id);
  if (!outro) throw new DecisaoRecusada("Esse cadastro não está entre os parecidos deste pedido.");
  return outro.pessoa;
}

/** O cadastro "novo" do pedido: só tem este pedido, e nenhum certificado. */
async function _so_este_pedido(tx: Executor, participante_id: number): Promise<boolean> {
  const [ins] = await tx
    .select({ n: count() })
    .from(tabela_inscricao)
    .where(eq(tabela_inscricao.participante_id, participante_id));
  const [cer] = await tx
    .select({ n: count() })
    .from(tabela_certificado)
    .where(eq(tabela_certificado.participante_id, participante_id));
  return Number(ins?.n ?? 0) === 1 && Number(cer?.n ?? 0) === 0;
}

/**
 * "É a mesma pessoa: usar este cadastro." Junta o cadastro do pedido ao que já
 * existia (`mesclagem`), e o pedido passa a ser dele — continua a conferir:
 * aceitar é outro passo. O de servidor é sempre o que fica.
 *
 * Basta `turma.inscrever` quando o que se junta é o cadastro que o próprio
 * pedido criou (só este pedido, nenhum certificado): é desfazer uma duplicata
 * de minutos. Juntar dois cadastros com história continua pedindo
 * `participante.mesclar`, a régua da tela de junção.
 */
export async function usar_cadastro(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao_id: number,
  participante_id: number,
): Promise<{ mantido: ParticipanteCarregado; turma: string }> {
  usuario.exigir("turma.inscrever");
  const inscricao = await _pedido_no_escopo(tx, usuario, inscricao_id);
  const do_pedido = inscricao.participante;
  const outro = await _parecido_do_pedido(tx, do_pedido, participante_id);
  const [mantido, absorvido] = do_pedido.servidor_id !== null ? [do_pedido, outro] : [outro, do_pedido];
  if (!usuario.pode("participante.mesclar") && !(absorvido.id === do_pedido.id && (await _so_este_pedido(tx, do_pedido.id)))) {
    throw new DecisaoRecusada(
      `${absorvido.identificador_publico} já tem outras inscrições ou certificados: juntar os dois cadastros ` +
        "é com quem pode juntar cadastros duplicados.",
    );
  }
  await mesclagem._mesclar(
    tx,
    usuario,
    mantido.id,
    absorvido.id,
    `Mesma pessoa: pedido pelo link em ${inscricao.turma.codigo} conferido como ${mantido.identificador_publico}`,
  );
  return { mantido, turma: inscricao.turma.codigo };
}

/** "Não é a mesma pessoa": o par fica gravado e não volta como parecido. */
export async function nao_e_a_mesma(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao_id: number,
  participante_id: number,
): Promise<{ pedido: string; outro: string }> {
  usuario.exigir("turma.inscrever");
  const inscricao = await _pedido_no_escopo(tx, usuario, inscricao_id);
  const outro = await _parecido_do_pedido(tx, inscricao.participante, participante_id);
  await duplicados.marcar_distintos(tx, usuario, inscricao.participante.id, outro.id, "CONFERENCIA");
  return { pedido: inscricao.participante.identificador_publico, outro: outro.identificador_publico };
}

export interface ResultadoLote {
  feitos: number;
  travados: { inscricao_id: number; quem: string; motivo: string }[];
  /** turmas em que se marcou mais pedidos do que há vaga: nenhum deles foi aceito */
  excedidas: { codigo: string; vagas: number; marcados: number }[];
}

/**
 * Aceita (`INSCRITA`) ou recusa (`CANCELADA`, com motivo) os pedidos marcados.
 * Pedido fora do escopo, de outra situação ou que não existe é ignorado em
 * silêncio, como a fila de emissão faz com o que não está nela.
 *
 * Aceitar mais pedidos de uma turma do que ela tem de vaga livre é recusado
 * para a turma inteira, antes de aceitar qualquer um: aceitar "na ordem da
 * lista" decidia por quem marcou quem ficava de fora. A pessoa desmarca o
 * excesso e escolhe.
 */
export async function decidir(
  tx: Executor,
  usuario: UsuarioAtual,
  ids: number[],
  destino: "INSCRITA" | "CANCELADA",
  motivo: string | null = null,
): Promise<ResultadoLote> {
  usuario.exigir("turma.inscrever");
  if (destino === "CANCELADA" && !(motivo ?? "").trim()) {
    throw new RegraViolada("Para recusar, escreva o motivo: ele fica registrado na inscrição.");
  }
  const resultado: ResultadoLote = { feitos: 0, travados: [], excedidas: [] };
  const validas: servico_turma.InscricaoCarregada[] = [];
  const no_escopo: servico_turma.InscricaoCarregada[] = [];
  for (const id of [...new Set(ids)].slice(0, LIMITE_LOTE)) {
    const inscricao = await servico_turma.carregar_inscricao(tx, id);
    if (!inscricao || inscricao.situacao !== "AGUARDANDO_EMAIL") continue;
    if (!(await servico_turma.no_escopo(tx, usuario, inscricao.turma_id, "turma.inscrever"))) continue;
    no_escopo.push(inscricao);
  }
  // NUVEM: a regra de dono (`dono_turma.ts`) — o pedido da turma que a conta
  // só consulta fica como estava, com o aviso de quem é a turma
  const direitos = await dono_turma.direitos_nas_turmas(tx, usuario, no_escopo.map((i) => i.turma_id));
  for (const inscricao of no_escopo) {
    const d = direitos.get(inscricao.turma_id);
    if (d && d.pode(dono_turma.INSCRICOES)) {
      validas.push(inscricao);
      continue;
    }
    resultado.travados.push({
      inscricao_id: inscricao.id,
      quem: nome_exibicao(inscricao.participante),
      motivo: d ? dono_turma.recusa_de(d, dono_turma.INSCRICOES) : "Turma não encontrada.",
    });
  }
  const barradas = new Set<number>();
  if (destino === "INSCRITA") {
    const por_turma = new Map<number, servico_turma.InscricaoCarregada[]>();
    for (const i of validas) por_turma.set(i.turma_id, [...(por_turma.get(i.turma_id) ?? []), i]);
    for (const lista of por_turma.values()) {
      const turma = lista[0]!.turma;
      const livres = await servico_turma.vagas_restantes(tx, turma);
      if (livres !== null && lista.length > livres) {
        resultado.excedidas.push({ codigo: turma.codigo, vagas: livres, marcados: lista.length });
        barradas.add(turma.id);
      }
    }
  }
  for (const inscricao of validas) {
    if (barradas.has(inscricao.turma_id)) continue;
    const id = inscricao.id;
    try {
      await tx.transaction(async (sp) =>
        servico_turma.mudar_situacao_inscricao(sp as Executor, usuario, inscricao, destino, { motivo }),
      );
      resultado.feitos += 1;
    } catch (erro) {
      if (!(erro instanceof RegraViolada || erro instanceof TransicaoInvalida)) throw erro;
      resultado.travados.push({ inscricao_id: id, quem: nome_exibicao(inscricao.participante), motivo: erro.message });
    }
  }
  return resultado;
}
