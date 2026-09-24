/**
 * /demandas — o que chegou por e-mail ou no balcão e ainda não é processo SEI.
 * Porte de `app/rotas/demandas.py`.
 *
 * A tela é da **base compartilhada**, ao lado de Pendências, e não de Processos
 * SEI: a demanda é transversal. A regra de negócio inteira mora em
 * `servicos/demandas.ts`; aqui só chegam a leitura da fila, a montagem da tela e
 * a tradução do que veio do formulário — inclusive a única tradução que tem
 * substância, que é resolver o NUP digitado para o `processo.id` real do
 * desfecho `VIROU_PROCESSO`.
 */
import { Hono } from "hono";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import {
  atribuicao,
  demanda as tabela_demanda,
  perfil,
  perfil_permissao,
  permissao,
  processo as tabela_processo,
  servidor as tabela_servidor,
  unidade_uorg,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import type { Executor } from "../db/cliente.js";
import { hoje_iso } from "../dominio/datas.js";
import { Demanda as DemandaDominio } from "../dominio/demanda.js";
import {
  CANAIS_DEMANDA,
  DESFECHOS_DEMANDA,
  ROTULO_CANAL_DEMANDA,
  ROTULO_DEMANDA,
  ROTULO_DESFECHO_DEMANDA,
  TransicaoInvalida,
} from "../dominio/estados.js";
import * as servico from "../servicos/demandas.js";
import * as servico_nup from "../servicos/nup.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { numeroDaPagina, pagina, recortar, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

// As fichas de filtro da fila, na ordem da máquina. "Em aberto" vem primeiro e
// é o padrão da tela: é a pergunta de quem abre a lista na segunda-feira.
export const VISOES: readonly (readonly [string, string])[] = [
  ["", "Em aberto"],
  ["ABERTA", "Abertas"],
  ["EM_ANDAMENTO", "Em andamento"],
  ["ENCERRADA", "Encerradas"],
];

/**
 * Redireciona com o recado, codificado: um `&` no meio da mensagem encerraria a
 * query string ali e o recado sumiria.
 */
export function _voltar(c: Ctx, destino: string, recado: { mensagem?: string; erro?: string } = {}): Response {
  const p = new URLSearchParams();
  if (recado.mensagem) p.set("mensagem", recado.mensagem);
  if (recado.erro) p.set("erro", recado.erro);
  const sufixo = [...p.keys()].length ? "?" + p.toString().replace(/\+/g, "%20") : "";
  return redirecionar(c, destino + sufixo);
}

/**
 * Quem pode receber uma demanda: conta ativa que ABRE a tela de demandas.
 *
 * O filtro é por `demanda.ver` — tarefa com dono que o dono não consegue abrir
 * é lista que ninguém lê —, e não por `demanda.registrar`: quem lê a fila pode
 * ser dono do acompanhamento. A vigência da atribuição entra na consulta.
 */
export async function _pessoas(tx: Executor) {
  const hoje = hoje_iso();
  const com_a_permissao = tx
    .select({ id: atribuicao.usuario_id })
    .from(atribuicao)
    .innerJoin(perfil, eq(perfil.id, atribuicao.perfil_id))
    .innerJoin(perfil_permissao, eq(perfil_permissao.perfil_id, perfil.id))
    .innerJoin(permissao, eq(permissao.id, perfil_permissao.permissao_id))
    .where(
      and(
        eq(perfil.ativo, true),
        eq(permissao.codigo, servico.PERMISSAO_VER),
        lte(atribuicao.vigencia_inicio, hoje),
        or(isNull(atribuicao.vigencia_fim), gte(atribuicao.vigencia_fim, hoje)),
      ),
    );
  return tx
    .select()
    .from(tabela_usuario)
    .where(and(eq(tabela_usuario.ativo, true), inArray(tabela_usuario.id, com_a_permissao)))
    .orderBy(asc(tabela_usuario.nome));
}

/** A demanda com o que a tela lê dela, e o `atrasada(hoje)` do modelo. */
async function _carregar(tx: Executor, ids: number[]) {
  if (!ids.length) return [];
  const linhas = await tx.query.demanda.findMany({
    where: inArray(tabela_demanda.id, ids),
    with: {
      servidor: true,
      unidade: true,
      responsavel: true,
      processo: true,
      encaminhamentos: { with: { autor: true }, orderBy: (e, { asc: cr }) => [cr(e.id)] },
    },
  });
  const por_id = new Map(linhas.map((l) => [l.id, l]));
  return ids
    .map((id) => por_id.get(id))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => ({ ...l, atrasada: (hoje?: string) => DemandaDominio.atrasada(l, hoje) }));
}

type Digitado = Record<string, string>;
type Recado = { mensagem?: string | null; erro?: string | null; digitado?: Digitado | null };

async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  filtro: { estado?: string; minhas?: string; q?: string } = {},
  extra: Recado = {},
) {
  const tx = c.get("tx");
  const estado = filtro.estado ?? "";
  const minhas = filtro.minhas ?? "";
  const q = filtro.q ?? "";
  let lista = await servico.listar(tx, {
    estado,
    responsavel_id: minhas === "1" ? usuario.id : null,
    busca: q,
  });
  if (!estado) {
    // "Em aberto" é a visão padrão: encerrada não some da tela — tem ficha
    // própria — mas sai da fila, que é a lista do que ainda cobra alguém.
    lista = lista.filter((d) => d.estado !== "ENCERRADA");
  }
  const recorte = recortar(lista, numeroDaPagina(c));
  const hoje = hoje_iso();
  const demandas = await _carregar(
    tx,
    recorte.itens.map((d) => d.id),
  );
  return pagina(c, "paginas/demandas.html", usuario, {
    demandas,
    recorte,
    contagem: await servico.contar_por_estado(tx),
    visoes: VISOES,
    filtro_estado: estado,
    apenas_minhas: minhas === "1",
    q,
    hoje,
    atrasadas: lista.filter((d) => DemandaDominio.atrasada(d, hoje)).length,
    canais: CANAIS_DEMANDA,
    rotulo_canal: ROTULO_CANAL_DEMANDA,
    rotulo_estado_demanda: ROTULO_DEMANDA,
    rotulo_desfecho: ROTULO_DESFECHO_DEMANDA,
    servidores: await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.id)),
    unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
    pessoas: await _pessoas(tx),
    pode_escrever: usuario.pode(servico.PERMISSAO_ESCREVER),
    mensagem: extra.mensagem ?? null,
    erro: extra.erro ?? null,
    digitado: extra.digitado ?? {},
  });
}

async function _tela_ficha(c: Ctx, usuario: UsuarioAtual, demanda_id: number, extra: Recado = {}) {
  const tx = c.get("tx");
  const [demanda] = await _carregar(tx, [demanda_id]);
  return pagina(c, "paginas/demanda_ficha.html", usuario, {
    demanda,
    hoje: hoje_iso(),
    rotulo_canal: ROTULO_CANAL_DEMANDA,
    rotulo_estado_demanda: ROTULO_DEMANDA,
    rotulo_desfecho: ROTULO_DESFECHO_DEMANDA,
    desfechos: DESFECHOS_DEMANDA,
    pessoas: await _pessoas(tx),
    pode_escrever: usuario.pode(servico.PERMISSAO_ESCREVER),
    mensagem: extra.mensagem ?? null,
    erro: extra.erro ?? null,
    digitado: extra.digitado ?? {},
  });
}

// ---------------------------------------------------------------------
// Traduções do formulário
// ---------------------------------------------------------------------
export function _id(bruto: string | null | undefined): number | null {
  return bruto && /^\d+$/.test(bruto) ? Number(bruto) : null;
}

/** `<input type=date>` manda AAAA-MM-DD ou vazio. Vazio é ausência, não erro. */
export function _data(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  if (!texto) return null;
  const dia = texto.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  let valida = false;
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    valida =
      d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  }
  // o `date.fromisoformat` do Python levanta ValueError, que a rota devolve à tela
  if (!valida) throw new RegraViolada(`Invalid isoformat string: '${dia}'`);
  return dia;
}

/** As recusas que voltam à tela (o `except (RegraDaDemanda, TextoProibido, ValueError, TransicaoInvalida)`). */
function recusavel(erro: unknown): erro is Error {
  return erro instanceof RegraViolada || erro instanceof TransicaoInvalida;
}

/**
 * O NUP digitado vira o `processo.id` real — ou uma recusa que diz o caminho.
 *
 * O desfecho `VIROU_PROCESSO` promete rastreabilidade: clicar na demanda e
 * chegar no processo. Isso exige chave estrangeira, e chave estrangeira exige
 * que o processo exista — por isso a saída é **recusar dizendo onde
 * cadastrar**. O NUP é aceito colado sujo, e o DV não bloqueia (RN-10).
 */
async function _processo_do_nup(tx: Executor, bruto: string): Promise<[number | null, string | null]> {
  const texto = (bruto ?? "").trim();
  if (!texto) {
    return [null, "Informe o NUP do processo que a demanda gerou — é ele que liga uma " + "coisa à outra."];
  }
  let valor: string;
  try {
    valor = servico_nup.normalizar(texto);
  } catch {
    return [null, `“${texto}” não é um NUP: o formato é 23086.021284/2024-56, com 17 ` + "dígitos."];
  }
  const [proc] = await tx
    .select({ id: tabela_processo.id })
    .from(tabela_processo)
    .where(eq(tabela_processo.nup, valor));
  if (!proc) {
    return [
      null,
      `Não há processo ${valor} cadastrado no sistema. Cadastre-o em “Novo ` +
        "processo” e volte para encerrar a demanda — assim ela vira um link " +
        "para o processo, e não um número anotado.",
    ];
  }
  return [proc.id, null];
}

async function _demanda(tx: Executor, id: number) {
  const [d] = await tx.select().from(tabela_demanda).where(eq(tabela_demanda.id, id));
  return d ?? null;
}

// ---------------------------------------------------------------------
// A fila
// ---------------------------------------------------------------------
rotas.get("/demandas", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(servico.PERMISSAO_VER);
  return _tela_lista(
    c,
    usuario,
    { estado: c.req.query("estado") ?? "", minhas: c.req.query("minhas") ?? "", q: c.req.query("q") ?? "" },
    { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null },
  );
});

rotas.post("/demandas", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(servico.PERMISSAO_VER);
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado ANTES da primeira recusa.
  const d: Digitado = {
    assunto: f.texto("assunto"),
    canal: f.texto("canal", "EMAIL"),
    solicitante_nome: f.texto("solicitante_nome"),
    data_chegada: f.texto("data_chegada"),
    descricao: f.texto("descricao"),
    solicitante_servidor_id: f.texto("solicitante_servidor_id"),
    solicitante_unidade_uorg_id: f.texto("solicitante_unidade_uorg_id"),
    responsavel_id: f.texto("responsavel_id"),
    prazo: f.texto("prazo"),
  };
  const tx = c.get("tx");
  let demanda: servico.Demanda;
  try {
    demanda = await servico.registrar(tx, usuario, {
      assunto: d.assunto!,
      canal: d.canal!,
      solicitante_nome: d.solicitante_nome!,
      data_chegada: _data(d.data_chegada),
      descricao: d.descricao,
      solicitante_servidor_id: _id(d.solicitante_servidor_id),
      solicitante_unidade_uorg_id: _id(d.solicitante_unidade_uorg_id),
      responsavel_id: _id(d.responsavel_id),
      prazo: _data(d.prazo),
    });
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    desfazer(c);
    return _tela_lista(c, usuario, {}, { erro: falha.message, digitado: d });
  }
  return _voltar(c, `/demandas/${demanda.id}`, { mensagem: "Demanda registrada." });
});

// ---------------------------------------------------------------------
// A ficha
// ---------------------------------------------------------------------
rotas.get("/demandas/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(servico.PERMISSAO_VER);
  const id = Number(c.req.param("id"));
  const demanda = await _demanda(c.get("tx"), id);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  return _tela_ficha(c, usuario, id, { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null });
});

/** O começo comum dos quatro POSTs da ficha: a demanda, ou o recado de que ela não existe. */
async function _alvo(c: Ctx, usuario: UsuarioAtual) {
  const id = Number(c.req.param("id"));
  const demanda = await _demanda(c.get("tx"), id);
  if (!demanda) usuario.exigir(servico.PERMISSAO_VER);
  return { id, demanda };
}

rotas.post("/demandas/:id{[0-9]+}/iniciar", async (c) => {
  const usuario = await usuarioLogado(c);
  const { id, demanda } = await _alvo(c, usuario);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  try {
    await servico.iniciar(c.get("tx"), usuario, demanda);
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    desfazer(c);
    return _voltar(c, `/demandas/${id}`, { erro: falha.message });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Demanda em andamento." });
});

rotas.post("/demandas/:id{[0-9]+}/atribuir", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c, usuario);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  try {
    await servico.atribuir(c.get("tx"), usuario, demanda, _id(f.texto("responsavel_id")));
  } catch (falha) {
    if (!(falha instanceof servico.RegraDaDemanda)) throw falha;
    desfazer(c);
    return _voltar(c, `/demandas/${id}`, { erro: falha.message });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Responsável alterado." });
});

rotas.post("/demandas/:id{[0-9]+}/encaminhar", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c, usuario);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  const d: Digitado = {
    forma: "encaminhar",
    para_quem: f.texto("para_quem"),
    pedido: f.texto("pedido"),
    data_encaminhamento: f.texto("data_encaminhamento"),
  };
  try {
    await servico.encaminhar(c.get("tx"), usuario, demanda, {
      para_quem: d.para_quem!,
      pedido: d.pedido!,
      data_encaminhamento: _data(d.data_encaminhamento),
    });
  } catch (falha) {
    if (!(falha instanceof RegraViolada)) throw falha;
    desfazer(c);
    return _tela_ficha(c, usuario, id, { erro: falha.message, digitado: d });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Encaminhamento registrado." });
});

rotas.post("/demandas/:id{[0-9]+}/encerrar", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c, usuario);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  const tx = c.get("tx");
  const d: Digitado = {
    forma: "encerrar",
    desfecho: f.texto("desfecho"),
    relato: f.texto("relato"),
    nup: f.texto("nup"),
    setor: f.texto("setor"),
    data_desfecho: f.texto("data_desfecho"),
  };
  let processo_id: number | null = null;
  if (d.desfecho === "VIROU_PROCESSO") {
    const [achado, recusa] = await _processo_do_nup(tx, d.nup!);
    if (recusa) return _tela_ficha(c, usuario, id, { erro: recusa, digitado: d });
    processo_id = achado;
  }
  try {
    await servico.encerrar(tx, usuario, demanda, {
      desfecho: d.desfecho!,
      relato: d.relato,
      processo_id,
      setor: d.setor,
      data_desfecho: _data(d.data_desfecho),
    });
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    desfazer(c);
    return _tela_ficha(c, usuario, id, { erro: falha.message, digitado: d });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Demanda encerrada." });
});
