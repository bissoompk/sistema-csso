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
import { asc, eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import {
  demanda as tabela_demanda,
  processo as tabela_processo,
  servidor as tabela_servidor,
  tipo_processo,
  unidade_uorg,
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
import { ler_data_formulario } from "../servicos/datas_br.js";
import * as servico from "../servicos/demandas.js";
import * as servico_nup from "../servicos/nup.js";
import * as servico_processo from "../servicos/processo.js";
import { MencaoDeSaude } from "../servicos/textos.js";
import { NOMINAIS_FORA_DO_EPI } from "../servicos/identificacao.js";
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
 * Quem pode receber uma demanda — a regra mora no serviço
 * (`pessoas_que_recebem`), que a usa também para recusar o POST forjado.
 */
export async function _pessoas(tx: Executor) {
  return servico.pessoas_que_recebem(tx);
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
type Recado = {
  mensagem?: string | null;
  erro?: string | null;
  digitado?: Digitado | null;
  /** a recusa foi termo de saúde (aviso): o formulário oferece a confirmação */
  aviso_saude?: boolean;
};

async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  filtro: { estado?: string; minhas?: string; q?: string } = {},
  extra: Recado = {},
) {
  const tx = c.get("tx");
  const estado = _visao(filtro.estado);
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
    // quem não vê nome digita o SIAPE (M65): a lista de códigos opacos nem vai
    servidores: _escolhe_pelo_nome(usuario)
      ? await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.id))
      : [],
    escolhe_por_siape: !_escolhe_pelo_nome(usuario),
    nominais_rn19: NOMINAIS_FORA_DO_EPI,
    unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
    pessoas: await _pessoas(tx),
    pode_escrever: usuario.pode(servico.PERMISSAO_ESCREVER),
    mensagem: extra.mensagem ?? null,
    erro: extra.erro ?? null,
    digitado: extra.digitado ?? {},
    aviso_saude: extra.aviso_saude ?? false,
  });
}

async function _tela_ficha(c: Ctx, usuario: UsuarioAtual, demanda_id: number, extra: Recado = {}) {
  const tx = c.get("tx");
  const [demanda] = await _carregar(tx, [demanda_id]);
  return pagina(c, "paginas/demanda_ficha.html", usuario, {
    demanda,
    nominais_rn19: NOMINAIS_FORA_DO_EPI,
    hoje: hoje_iso(),
    rotulo_canal: ROTULO_CANAL_DEMANDA,
    rotulo_estado_demanda: ROTULO_DEMANDA,
    rotulo_desfecho: ROTULO_DESFECHO_DEMANDA,
    desfechos: DESFECHOS_DEMANDA,
    pessoas: await _pessoas(tx),
    pode_escrever: usuario.pode(servico.PERMISSAO_ESCREVER),
    // quem demandou tem conta: o desfecho chega a ele, e o formulário avisa
    avisa_solicitante: demanda ? (await servico.conta_de_quem_demandou(tx, demanda)) !== null : false,
    // o encerramento como "virou processo" cadastra o processo ali mesmo
    tipos_processo: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    mensagem: extra.mensagem ?? null,
    erro: extra.erro ?? null,
    digitado: extra.digitado ?? {},
    aviso_saude: extra.aviso_saude ?? false,
  });
}

// ---------------------------------------------------------------------
// Traduções do formulário
// ---------------------------------------------------------------------
export function _id(bruto: string | null | undefined): number | null {
  return bruto && /^\d+$/.test(bruto) ? Number(bruto) : null;
}

/**
 * `<input type=date>` manda AAAA-MM-DD ou vazio; o celular e a extensão que
 * cola às vezes mandam dd/mm/aaaa. Vazio é ausência, não erro; o resto passa
 * por `ler_data_formulario`, que recusa com o rótulo do campo em português.
 */
export function _data(bruto: string | null | undefined, rotulo: string): string | null {
  return ler_data_formulario(bruto, rotulo);
}

/** O código da ficha de filtro — e o estado desconhecido cai em "Em aberto". */
export function _visao(bruto: string | null | undefined): string {
  const codigo = (bruto ?? "").trim();
  return VISOES.some(([c]) => c === codigo) ? codigo : "";
}

/**
 * Quem escolhe quem demandou pela lista de nomes do cadastro (M65). D15: é
 * `exposicao.ver` cobrindo o alcance de `demanda.ver`, e não mais
 * `ve_dado_nominal` — que inclui `epi.ficha`, e com ela o almoxarife via o
 * nome de quem demanda adicional enquanto a secretaria, na mesma fila, via o
 * código opaco. A demanda não é tela de EPI; a família é a de fora dele.
 */
function _escolhe_pelo_nome(usuario: UsuarioAtual): boolean {
  return usuario.ve_dado_nominal_em("demanda.ver");
}

/**
 * M65: quem não vê nome escolhe o servidor do cadastro pelo SIAPE — um select
 * de "SRV-xxxx" não deixa escolher ninguém. O SIAPE casa para todo mundo
 * (mesma regra da busca de /servidores, `casa_a_busca`), então conferir que ele
 * existe não é oráculo de nome. Vazio é "sem vínculo".
 */
async function _servidor_do_siape(tx: Executor, bruto: string | null | undefined): Promise<number | null> {
  const siape = (bruto ?? "").replace(/\D/g, "");
  if (!(bruto ?? "").trim()) return null;
  if (!/^\d{7}$/.test(siape)) {
    throw new servico.RegraDaDemanda("SIAPE do servidor: são 7 dígitos. Deixe em branco se quem pediu não é do cadastro.");
  }
  const [srv] = await tx.select({ id: tabela_servidor.id }).from(tabela_servidor).where(eq(tabela_servidor.siape, siape));
  if (!srv) {
    throw new servico.RegraDaDemanda(
      `Não há servidor com o SIAPE ${siape} no cadastro. Confira o número, ou deixe em branco e escreva quem demandou.`,
    );
  }
  return srv.id;
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
async function _processo_do_nup(tx: Executor, bruto: string): Promise<[number | null, string | null, boolean]> {
  const texto = (bruto ?? "").trim();
  if (!texto) {
    return [null, "Informe o NUP do processo que a demanda gerou — é ele que liga uma " + "coisa à outra.", false];
  }
  let valor: string;
  try {
    valor = servico_nup.normalizar(texto);
  } catch {
    return [null, `“${texto}” não é um NUP: o formato é 23086.021284/2024-56, com 17 ` + "dígitos.", false];
  }
  const [proc] = await tx
    .select({ id: tabela_processo.id })
    .from(tabela_processo)
    .where(eq(tabela_processo.nup, valor));
  if (!proc) {
    return [
      null,
      `Não há processo ${valor} cadastrado no sistema. Escolha o tipo do ` +
        "processo no mesmo formulário e ele é cadastrado agora — a demanda vira " +
        "um link para ele, e não um número anotado.",
      true,
    ];
  }
  return [proc.id, null, false];
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
  usuario.exigir(servico.PERMISSAO_ESCREVER);
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado ANTES da primeira recusa.
  const d: Digitado = {
    assunto: f.texto("assunto"),
    canal: f.texto("canal", "EMAIL"),
    solicitante_nome: f.texto("solicitante_nome"),
    data_chegada: f.texto("data_chegada"),
    descricao: f.texto("descricao"),
    solicitante_servidor_id: f.texto("solicitante_servidor_id"),
    solicitante_siape: f.texto("solicitante_siape"),
    solicitante_unidade_uorg_id: f.texto("solicitante_unidade_uorg_id"),
    responsavel_id: f.texto("responsavel_id"),
    prazo: f.texto("prazo"),
    confirmo_mencao_saude: f.texto("confirmo_mencao_saude"),
  };
  const tx = c.get("tx");
  let demanda: servico.Demanda;
  try {
    const solicitante_servidor_id = _escolhe_pelo_nome(usuario)
      ? _id(d.solicitante_servidor_id)
      : await _servidor_do_siape(tx, d.solicitante_siape);
    demanda = await servico.registrar(tx, usuario, {
      assunto: d.assunto!,
      canal: d.canal!,
      solicitante_nome: d.solicitante_nome!,
      data_chegada: _data(d.data_chegada, "Data de chegada"),
      descricao: d.descricao,
      solicitante_servidor_id,
      solicitante_unidade_uorg_id: _id(d.solicitante_unidade_uorg_id),
      responsavel_id: _id(d.responsavel_id),
      prazo: _data(d.prazo, "Prazo"),
      confirmo_mencao_saude: d.confirmo_mencao_saude === "1",
    });
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    desfazer(c);
    return _tela_lista(c, usuario, {}, { erro: falha.message, digitado: d, aviso_saude: falha instanceof MencaoDeSaude });
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

/**
 * O começo comum dos quatro POSTs da ficha: a demanda, ou o recado de que ela
 * não existe. A permissão de escrita já foi exigida na primeira linha de cada
 * POST — antes do formulário e de qualquer consulta (D77).
 */
async function _alvo(c: Ctx) {
  const id = Number(c.req.param("id"));
  const demanda = await _demanda(c.get("tx"), id);
  return { id, demanda };
}

rotas.post("/demandas/:id{[0-9]+}/iniciar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(servico.PERMISSAO_ESCREVER);
  const { id, demanda } = await _alvo(c);
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
  usuario.exigir(servico.PERMISSAO_ESCREVER);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c);
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
  usuario.exigir(servico.PERMISSAO_ESCREVER);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c);
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
      data_encaminhamento: _data(d.data_encaminhamento, "Data do encaminhamento"),
      confirmo_mencao_saude: f.texto("confirmo_mencao_saude") === "1",
    });
  } catch (falha) {
    if (!(falha instanceof RegraViolada)) throw falha;
    desfazer(c);
    return _tela_ficha(c, usuario, id, { erro: falha.message, digitado: d, aviso_saude: falha instanceof MencaoDeSaude });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Encaminhamento registrado." });
});

rotas.post("/demandas/:id{[0-9]+}/encerrar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(servico.PERMISSAO_ESCREVER);
  const f = await formulario(c);
  const { id, demanda } = await _alvo(c);
  if (!demanda) return _voltar(c, "/demandas", { erro: "Demanda não encontrada." });
  const tx = c.get("tx");
  const d: Digitado = {
    forma: "encerrar",
    desfecho: f.texto("desfecho"),
    relato: f.texto("relato"),
    nup: f.texto("nup"),
    setor: f.texto("setor"),
    data_desfecho: f.texto("data_desfecho"),
    tipo_processo_id: f.texto("tipo_processo_id"),
    dispensar_dv: f.texto("dispensar_dv"),
  };
  const confirmado = f.texto("confirmo_mencao_saude") === "1";
  try {
    let processo_id: number | null = null;
    if (d.desfecho === "VIROU_PROCESSO") {
      const [achado, recusa, nao_cadastrado] = await _processo_do_nup(tx, d.nup!);
      const tipo = _id(d.tipo_processo_id);
      if (achado !== null) processo_id = achado;
      else if (nao_cadastrado && tipo !== null) {
        // o processo nasce aqui, na mesma transação do encerramento: recusa
        // adiante desfaz os dois. NUP e DV passam pela MESMA regra do
        // formulário de processo novo.
        usuario.exigir("processo.criar");
        const novo = await servico_processo.criar(tx, usuario, {
          nup: d.nup!,
          tipo_processo_id: tipo,
          servidor_id: demanda.solicitante_servidor_id,
          unidade_uorg_id: demanda.solicitante_unidade_uorg_id,
          dispensar_dv: d.dispensar_dv === "1",
        });
        processo_id = novo.id;
      } else return _tela_ficha(c, usuario, id, { erro: recusa, digitado: d });
    }
    await servico.encerrar(tx, usuario, demanda, {
      desfecho: d.desfecho!,
      relato: d.relato,
      processo_id,
      setor: d.setor,
      // a data só vale para "encaminhada" (é a do encaminhamento); nos outros
      // desfechos o campo nem é lido — data errada ali não recusa nada
      data_desfecho: d.desfecho === "ENCAMINHADA" ? _data(d.data_desfecho, "Data do encaminhamento") : null,
      confirmo_mencao_saude: confirmado,
    });
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    desfazer(c);
    return _tela_ficha(c, usuario, id, { erro: falha.message, digitado: d, aviso_saude: falha instanceof MencaoDeSaude });
  }
  return _voltar(c, `/demandas/${id}`, { mensagem: "Demanda encerrada." });
});
