/**
 * /epis/requisicoes — o pedido formal de EPI: fila, formulário e análise.
 * Porte de `app/rotas/epi_requisicoes.py`.
 *
 * Quatro coisas que estas telas existem para tornar visíveis:
 * 1. a decisão é POR ITEM, e a tela mostra isso;
 * 2. a recusa é um seletor de motivo do catálogo, nunca uma caixa vazia;
 * 3. o bloqueio da RN-26 tem caminho de saída na própria tela;
 * 4. CA vencido é etiqueta vermelha e botão desabilitado COM o motivo ao lado.
 *
 * O que estas rotas deliberadamente NÃO oferecem: botão para `EM_ATENDIMENTO` e
 * para `ATENDIDA` — as duas transições são do sistema (`sincronizar_atendimento`).
 *
 * **A recusa que re-renderiza** (o `s.rollback()` seguido de tela): aqui o
 * serviço roda num SAVEPOINT (`tx.transaction` dentro da transação da
 * requisição). Recusado, o savepoint desfaz o que o serviço tinha escrito e a
 * tela é montada relendo o banco — o mesmo efeito do rollback do Python, sem
 * perder a transação da requisição. `PermissaoNegada` (a RN-28) sobe inteira
 * para o `onError`, que a rende como 403 com a mensagem.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Tx } from "../db/cliente.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { obterConfig } from "../config.js";
import { dicionario, type Dicionario } from "../dicionario.js";
import { comMensagem, fragmento, global, pagina, redirecionar } from "../web.js";
import {
  epi_entrada_estoque,
  epi_item,
  epi_motivo_recusa,
  epi_requisicao,
  epi_requisicao_item,
  historico_evento,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { EpiItem as EpiItemDominio, FINALIDADES_REQUISICAO, URGENCIAS_REQUISICAO } from "../dominio/epi.js";
import {
  EPI_ITEM_DECIDIDO,
  EPI_REQUISICAO_CANCELAVEL,
  EPI_REQUISICAO_ENCERRADA,
  ROTULO_EPI_ITEM,
  ROTULO_EPI_REQUISICAO,
  TransicaoInvalida,
} from "../dominio/estados.js";
import * as auditoria from "../servicos/auditoria.js";
import * as epi_estoque from "../servicos/epi_estoque.js";
import * as epi_ficha from "../servicos/epi_ficha.js";
import * as identificacao from "../servicos/identificacao.js";
import * as servico from "../servicos/epi_requisicao.js";
import * as servico_servidores from "../servicos/servidores.js";
import * as textos from "../servicos/textos.js";
import { hoje } from "../servicos/datas_br.js";
import { PermissaoNegada, type UsuarioAtual } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

export const FILA = "/epis/requisicoes";
export const NOVA = "/epis/requisicoes/nova";

// Rótulo da finalidade e da urgência na tela: o vocabulário fechado mora em
// ASCII (vai para o CHECK do banco) e a tela escreve com acento.
export const ROTULO_FINALIDADE: Record<string, string> = {
  PRIMEIRA_ENTREGA: "Primeira entrega",
  ROTINA: "Reposição de rotina",
  SUBSTITUICAO: "Substituição por desgaste",
  DANO: "Dano",
  PERDA: "Perda",
};
export const ROTULO_URGENCIA: Record<string, string> = { NORMAL: "Normal", URGENTE: "Urgente" };

// O destino do 303 das ações de item: a lista de itens, e não o topo da ficha.
export const ANCORA_ITENS = "#itens-do-pedido";

type Form = Awaited<ReturnType<typeof formulario>>;

// =====================================================================
// O dicionário do Jinja nos templates
// =====================================================================
/**
 * Os templates desta tela (portados do Jinja) leem `nomes.get(id, '—')`,
 * `rotulos.items()` e `resumo.get(...)` — o contexto leva dicionários.
 */
export type Dic = Dicionario<any>;
/** O `dicionario()` compartilhado (`src/dicionario.ts`), com o nome curto desta rota. */
export function dic(origem: Record<string, unknown> | Map<unknown, unknown> = {}): Dic {
  return dicionario(origem as Record<string, unknown>);
}
// o `{}` do Jinja (`d if ... else {}`, `digitado or {}`): o literal do
// Nunjucks não tem `.get`, então os templates desta tela usam este vazio
global("sem_digitado", Object.freeze(dic({})));

// =====================================================================
// As `@property` do modelo, vestidas para o template
// =====================================================================
type ItemBruto = typeof epi_item.$inferSelect;
export function vestir_item<T extends ItemBruto>(item: T) {
  return {
    ...item,
    lista_de_tamanhos: EpiItemDominio.lista_de_tamanhos(item),
    lista_de_normas: EpiItemDominio.lista_de_normas(item),
    regra_de_quantidade: EpiItemDominio.regra_de_quantidade(item),
  };
}
function vestir_linha<L extends servico.EpiRequisicaoItem & { item: ItemBruto }>(linha: L) {
  return {
    ...linha,
    item: vestir_item(linha.item),
    quantidade_devida: servico.quantidade_devida(linha),
    decidido: EPI_ITEM_DECIDIDO.has(linha.estado),
  };
}
function vestir_requisicao<
  R extends servico.EpiRequisicao & { itens: (servico.EpiRequisicaoItem & { item: ItemBruto })[] },
>(r: R) {
  return {
    ...r,
    identificacao: servico.identificacao(r),
    encerrada: EPI_REQUISICAO_ENCERRADA.has(r.estado),
    itens: r.itens.map(vestir_linha),
  };
}

/** A requisição com tudo o que as telas leem (o `lazy="selectin"` do Python). */
async function carregar(tx: Tx, requisicao_id: number) {
  const r = await tx.query.epi_requisicao.findFirst({
    where: eq(epi_requisicao.id, requisicao_id),
    with: {
      servidor: true,
      chefia: true,
      unidade: { with: { campus: true } },
      motivo_recusa: true,
      itens: {
        with: { item: { with: { categoria: true } }, motivo_recusa: true },
        orderBy: [asc(epi_requisicao_item.id)],
      },
    },
  });
  return r ? vestir_requisicao(r) : null;
}
type RequisicaoTela = NonNullable<Awaited<ReturnType<typeof carregar>>>;

// =====================================================================
// Recados, recusas e savepoint
// =====================================================================
/**
 * O recado vai codificado na query string, e a ÂNCORA vai DEPOIS dela: o
 * fragmento encerra a URL, e `#itens&mensagem=…` viraria parte da âncora.
 */
function _aviso(c: Ctx, destino: string, campo: string, mensagem: string, ancora = ""): Response {
  return redirecionar(c, comMensagem(destino, mensagem, campo) + ancora);
}
const _volta = (c: Ctx, destino: string, mensagem: string, ancora = "") => _aviso(c, destino, "mensagem", mensagem, ancora);
const _erro = (c: Ctx, destino: string, mensagem: string, ancora = "") => _aviso(c, destino, "erro", mensagem, ancora);

/** A lista inteira de motivos, e não o primeiro. */
function _motivos(falha: Error): string {
  const motivos = (falha as { motivos?: string[] }).motivos;
  return motivos && motivos.length ? motivos.join(" · ") : falha.message;
}

type Classe = new (...a: any[]) => Error;

/** As recusas de regra que a tela sabe escrever (o `except (...)` do Python). */
function recusavel(erro: unknown, extras: Classe[]): erro is Error {
  if (erro instanceof PermissaoNegada) return false;
  return (
    erro instanceof servico.RequisicaoBloqueada ||
    erro instanceof textos.TextoProibido ||
    erro instanceof TransicaoInvalida ||
    extras.some((classe) => erro instanceof classe)
  );
}

/**
 * Roda o serviço num SAVEPOINT. Recusa de regra volta como `{ ok: false }`,
 * com o que o serviço escreveu desfeito; qualquer outra coisa sobe.
 */
async function tentar<T>(
  c: Ctx,
  f: (tx: Tx) => Promise<T>,
  ...extras: Classe[]
): Promise<{ ok: true; valor: T } | { ok: false; falha: Error }> {
  const tx = c.get("tx");
  try {
    const valor = await tx.transaction(async (sp) => f(sp as unknown as Tx));
    return { ok: true, valor };
  } catch (erro) {
    if (recusavel(erro, extras)) return { ok: false, falha: erro };
    throw erro;
  }
}

function _e_htmx(c: Ctx): boolean {
  return c.req.header("HX-Request") === "true";
}

function _inteiro(bruto: string): number | null {
  const limpo = (bruto || "").trim();
  return /^\d+$/.test(limpo) ? Number(limpo) : null;
}
function _id(bruto: string | null | undefined): number | null {
  return _inteiro(bruto ?? "");
}
function _marcado(valor: string): boolean {
  return valor === "1";
}
function _ficha(requisicao_id: number): string {
  return `${FILA}/${requisicao_id}`;
}
function _param_id(c: Ctx, nome: string): number | null {
  return _id(c.req.param(nome));
}

async function _itens_ativos(tx: Tx) {
  return tx.select().from(epi_item).where(eq(epi_item.ativo, true)).orderBy(asc(epi_item.nome));
}
async function _motivos_ativos(tx: Tx) {
  return tx
    .select()
    .from(epi_motivo_recusa)
    .where(eq(epi_motivo_recusa.ativo, true))
    .orderBy(asc(epi_motivo_recusa.rotulo));
}

/** `{usuario_id: nome}` para a ficha. O nome, e não o id. */
async function _nomes_de(tx: Tx, ids: (number | null | undefined)[]): Promise<Dic> {
  const alvos = [...new Set(ids.filter((i): i is number => i !== null && i !== undefined))];
  if (!alvos.length) return dic({});
  const linhas = await tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome })
    .from(tabela_usuario)
    .where(inArray(tabela_usuario.id, alvos));
  return dic(new Map(linhas.map((u) => [u.id, u.nome])));
}

async function _entrada(tx: Tx, entrada_id: number | null) {
  if (entrada_id === null) return null;
  const [e] = await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, entrada_id));
  return e ?? null;
}
async function _item_do_catalogo(tx: Tx, item_id: number | null) {
  if (item_id === null) return null;
  const [i] = await tx.select().from(epi_item).where(eq(epi_item.id, item_id));
  return i ?? null;
}
async function _motivo(tx: Tx, motivo_id: number | null) {
  if (motivo_id === null) return null;
  const [m] = await tx.select().from(epi_motivo_recusa).where(eq(epi_motivo_recusa.id, motivo_id));
  return m ?? null;
}

// =====================================================================
// A troca parcial da lista de itens
// =====================================================================
/**
 * Os lotes candidatos, a reserva de cada linha e o impedimento dela HOJE — as
 * MESMAS contas para a ficha inteira e para o fragmento, para que um não
 * discorde do outro (o CA reconferido na data de hoje é a conta que uma cópia
 * esqueceria).
 */
async function _lotes_e_reservas(tx: Tx, requisicao: RequisicaoTela, dia: string) {
  const lotes = new Map<number, epi_estoque.LoteDisponivel[]>();
  const reservas = new Map<number, typeof epi_entrada_estoque.$inferSelect>();
  const impedidas = new Map<number, string>();
  for (const linha of requisicao.itens) {
    if (["APROVADO", "RESERVADO", "SEM_ESTOQUE"].includes(linha.estado)) {
      lotes.set(linha.id, await epi_estoque.lotes_de(tx, linha.item, { quando: dia, tamanho: linha.tamanho || null }));
    }
    if (linha.estado === "RESERVADO" && linha.entrada_id) {
      const entrada = await _entrada(tx, linha.entrada_id);
      if (entrada) {
        reservas.set(linha.id, entrada);
        impedidas.set(linha.id, epi_estoque.impedimento_do_lote(entrada, linha.item, dia));
      }
    }
  }
  return { lotes: dic(lotes), reservas: dic(reservas), reservas_impedidas: dic(impedidas) };
}

async function _secao_dos_itens(
  c: Ctx,
  usuario: UsuarioAtual,
  requisicao_id: number,
  opcoes: { recusa?: string | null; linha_id?: number | null } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const requisicao = (await carregar(tx, requisicao_id))!;
  const dia = hoje();
  const extras = await _lotes_e_reservas(tx, requisicao, dia);
  return fragmento(c, "partes/itens_do_pedido.html", {
    usuario,
    requisicao,
    itens: requisicao.itens,
    hoje: dia,
    rotulos: dic(ROTULO_EPI_REQUISICAO),
    rotulos_item: dic(ROTULO_EPI_ITEM),
    motivos: await _motivos_ativos(tx),
    ...extras,
    nomes: await _nomes_de(tx, [
      ...requisicao.itens.map((l) => l.decidido_por),
      ...requisicao.itens.map((l) => l.autorizado_por),
    ]),
    editavel: servico.EDITAVEL.has(requisicao.estado),
    pode_requisitar: usuario.pode("epi.requisitar"),
    pode_analisar: usuario.pode("epi.analisar"),
    pode_entregar: usuario.pode("epi.entregar"),
    pode_estocar: usuario.pode("epi.estoque"),
    // a gaveta da linha recusada reabre
    digitado: dic(
      opcoes.linha_id !== undefined && opcoes.linha_id !== null ? { forma: `item-${opcoes.linha_id}` } : {},
    ),
    recusa: opcoes.recusa ?? null,
  });
}

/** A recusa no formato de quem chamou: 200 com a seção (HTMX) ou 303 com a faixa. */
async function _parcial_ou_erro(
  c: Ctx,
  usuario: UsuarioAtual,
  requisicao_id: number,
  mensagem: string,
  parcial: boolean,
  linha_id: number | null = null,
): Promise<Response> {
  if (parcial) return _secao_dos_itens(c, usuario, requisicao_id, { recusa: mensagem, linha_id });
  return _erro(c, _ficha(requisicao_id), mensagem, ANCORA_ITENS);
}

// =====================================================================
// A busca da fila — e o que ela recusa
// =====================================================================
export const RECADO_CPF =
  "A busca não aceita CPF: o sistema não armazena CPF em campo nenhum " +
  "(decisão 1 do desenho — quem pede EPI é servidor, e servidor se identifica " +
  "por SIAPE). Procure pelo protocolo, pelo nome, pelo SIAPE ou pelo e-mail.";

/** Protocolo para todo mundo; a identificação do servidor pela regra da RN-19. */
function _casa_a_busca(
  requisicao: { protocolo: string | null; servidor: identificacao.ServidorBuscavel | null },
  alvo: string,
  usuario: UsuarioAtual,
): boolean {
  if (textos.chave_busca(requisicao.protocolo || "").includes(alvo)) return true;
  return identificacao.casa_a_busca(alvo, requisicao.servidor, usuario);
}

// =====================================================================
// A fila
// =====================================================================
rotas.get(FILA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const q = c.req.query("q") ?? "";
  const estado = c.req.query("estado") ?? "";
  const estados = Object.hasOwn(ROTULO_EPI_REQUISICAO, estado) ? [estado] : [];
  const ids = (await servico.fila(tx, usuario, { estados })).map((r) => r.id);
  let linhas = ids.length
    ? (
        await tx.query.epi_requisicao.findMany({
          where: inArray(epi_requisicao.id, ids),
          with: {
            servidor: true,
            unidade: { with: { campus: true } },
            itens: { with: { item: true }, orderBy: [asc(epi_requisicao_item.id)] },
          },
          orderBy: [asc(epi_requisicao.id)],
        })
      ).map(vestir_requisicao)
    : [];

  let recado = c.req.query("erro") ?? null;
  if (q.trim()) {
    if (textos.parece_cpf(q)) {
      linhas = [];
      recado = recado || RECADO_CPF;
    } else {
      const alvo = textos.chave_busca(q);
      linhas = linhas.filter((r) => _casa_a_busca(r, alvo, usuario));
    }
  }
  const resumo = await servico.resumo_de_estados(tx, usuario);
  return pagina(c, "paginas/epis_requisicoes.html", usuario, {
    linhas,
    q,
    estado,
    resumo: dic(resumo),
    total_resumo: Object.values(resumo).reduce((s, n) => s + n, 0),
    rotulos: dic(ROTULO_EPI_REQUISICAO),
    rotulos_finalidade: dic(ROTULO_FINALIDADE),
    // dias parados, calculado agora e nunca gravado
    dias: dic(new Map(linhas.map((r) => [r.id, servico.prazo_em_analise(r)]))),
    hoje: hoje(),
    pode_requisitar: usuario.pode("epi.requisitar"),
    pode_analisar: usuario.pode("epi.analisar"),
    mensagem: c.req.query("mensagem") ?? null,
    erro: recado,
  });
});

// =====================================================================
// O formulário do pedido — declarado ANTES de `/epis/requisicoes/:id`
// (as rotas de id só casam dígitos, então a ordem não é mais o que protege)
// =====================================================================
// A nota de rodapé do seletor: a RN-28 é assunto do pedido, não do balcão.
export const NOTA_SERVIDOR =
  "A RN-28 não se aplica a quem digita, e sim a quem vai usar: " + "a chefia pode abrir o pedido da equipe.";

async function _tela_nova(
  c: Ctx,
  usuario: UsuarioAtual,
  opcoes: { q?: string; mensagem?: string | null; erro?: string | null; digitado?: Record<string, unknown> } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const q = opcoes.q ?? "";
  return pagina(c, "paginas/epis_requisicao_nova.html", usuario, {
    servidores: await servico_servidores.buscar(tx, q, usuario),
    nota: NOTA_SERVIDOR,
    q,
    finalidades: FINALIDADES_REQUISICAO.map((cod) => [cod, ROTULO_FINALIDADE[cod] ?? cod]),
    urgencias: URGENCIAS_REQUISICAO.map((cod) => [cod, ROTULO_URGENCIA[cod] ?? cod]),
    digitado: dic(opcoes.digitado ?? {}),
    mensagem: opcoes.mensagem ?? null,
    erro: opcoes.erro ?? null,
  });
}

rotas.get(NOVA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  return _tela_nova(c, usuario, {
    q: c.req.query("q") ?? "",
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/** Fragmento HTMX: a busca de servidor sem recarregar o formulário. */
rotas.get("/epis/requisicoes/servidores", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const q = c.req.query("q") ?? "";
  return fragmento(c, "partes/epi_requisicao_servidores.html", {
    usuario,
    servidores: await servico_servidores.buscar(c.get("tx"), q, usuario),
    nota: NOTA_SERVIDOR,
    q,
  });
});

/** Fragmento HTMX: escolhido o item, aparecem quantidade, tamanhos e a RN-29. */
rotas.get("/epis/requisicoes/item-opcoes", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const item = await _item_do_catalogo(c.get("tx"), _id(c.req.query("item_id")));
  return fragmento(c, "partes/epi_requisicao_opcoes.html", {
    usuario,
    item: item ? vestir_item(item) : null,
    hoje: hoje(),
  });
});

/** Fragmento HTMX: escolhido o tamanho, o saldo daquele tamanho. */
rotas.get("/epis/requisicoes/item-saldo", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const tx = c.get("tx");
  const item = await _item_do_catalogo(tx, _id(c.req.query("item_id")));
  const limpo = (c.req.query("tamanho") ?? "").trim();
  return fragmento(c, "partes/epi_requisicao_saldo.html", {
    usuario,
    item: item ? vestir_item(item) : null,
    tamanho: limpo,
    lotes: item ? await epi_estoque.lotes_de(tx, item, { tamanho: limpo || null }) : [],
    hoje: hoje(),
  });
});

/** O rascunho. **Não consome protocolo** — quem o consome é o envio (RN-03). */
rotas.post(FILA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const q = f.texto("q");
  // tudo o que foi digitado, guardado antes da primeira recusa
  const digitado = {
    servidor_id: f.texto("servidor_id"),
    chefia_servidor_id: f.texto("chefia_servidor_id"),
    finalidade: f.texto("finalidade", "ROTINA"),
    descricao_atividade: f.texto("descricao_atividade"),
    riscos_declarados: f.texto("riscos_declarados"),
    urgencia: f.texto("urgencia", "NORMAL"),
    justificativa_urgencia: f.texto("justificativa_urgencia"),
  };
  const servidor_id = _id(digitado.servidor_id);
  const [servidor] = servidor_id
    ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, servidor_id))
    : [];
  if (!servidor) {
    return _tela_nova(c, usuario, { q, erro: "Escolha o servidor que vai usar o equipamento.", digitado });
  }
  const chefia_id = _id(digitado.chefia_servidor_id);
  const [chefia] = chefia_id ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, chefia_id)) : [];
  const r = await tentar(c, (sp) =>
    servico.criar_rascunho(sp, usuario, {
      servidor,
      chefia_servidor_id: chefia ? chefia.id : null,
      finalidade: digitado.finalidade,
      descricao_atividade: digitado.descricao_atividade,
      riscos_declarados: digitado.riscos_declarados,
      urgencia: digitado.urgencia,
      justificativa_urgencia: digitado.justificativa_urgencia,
    }),
  );
  if (!r.ok) return _tela_nova(c, usuario, { q, erro: _motivos(r.falha), digitado });
  return _volta(
    c,
    _ficha(r.valor.id),
    "Rascunho aberto. Acrescente os itens e envie — o protocolo é consumido " +
      "no envio, e rascunho abandonado não gasta número.",
  );
});

// =====================================================================
// A ficha do pedido
// =====================================================================
/** A requisição desta URL, no escopo de quem pediu — ou `null`. */
async function _requisicao(c: Ctx, usuario: UsuarioAtual, requisicao_id: number | null) {
  if (requisicao_id === null) return null;
  return servico.no_escopo(c.get("tx"), usuario, requisicao_id);
}

/** A linha, conferida contra a requisição da URL — e contra o escopo dela. */
async function _linha(c: Ctx, usuario: UsuarioAtual, requisicao_id: number | null, linha_id: number | null) {
  if (requisicao_id === null || linha_id === null) return null;
  if ((await _requisicao(c, usuario, requisicao_id)) === null) return null;
  const [linha] = await c.get("tx").select().from(epi_requisicao_item).where(eq(epi_requisicao_item.id, linha_id));
  if (!linha || linha.requisicao_id !== requisicao_id) return null;
  return linha;
}

/** O envelope e os itens na mesma linha do tempo. */
async function _trilha(tx: Tx, requisicao: RequisicaoTela) {
  const ids_de_item = requisicao.itens.map((l) => l.id);
  let condicao = and(eq(historico_evento.entidade, servico.ENTIDADE), eq(historico_evento.entidade_id, requisicao.id));
  if (ids_de_item.length) {
    condicao = or(
      condicao,
      and(eq(historico_evento.entidade, servico.ENTIDADE_ITEM), inArray(historico_evento.entidade_id, ids_de_item)),
    );
  }
  return tx
    .select()
    .from(historico_evento)
    .where(condicao)
    .orderBy(desc(historico_evento.ocorrido_em), desc(historico_evento.id));
}

async function _tela_ficha(
  c: Ctx,
  usuario: UsuarioAtual,
  requisicao_id: number,
  opcoes: {
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, unknown>;
    item_escolhido?: ItemBruto | null;
  } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const requisicao = (await carregar(tx, requisicao_id))!;
  const dia = hoje();
  const extras = await _lotes_e_reservas(tx, requisicao, dia);
  return pagina(c, "paginas/epis_requisicao_ficha.html", usuario, {
    requisicao,
    itens: requisicao.itens,
    hoje: dia,
    dias_no_estado: servico.prazo_em_analise(requisicao),
    rotulos: dic(ROTULO_EPI_REQUISICAO),
    rotulos_item: dic(ROTULO_EPI_ITEM),
    rotulo_finalidade: ROTULO_FINALIDADE[requisicao.finalidade] ?? requisicao.finalidade,
    rotulo_urgencia: ROTULO_URGENCIA[requisicao.urgencia] ?? requisicao.urgencia,
    finalidades: FINALIDADES_REQUISICAO.map((cod) => [cod, ROTULO_FINALIDADE[cod] ?? cod]),
    urgencias: URGENCIAS_REQUISICAO.map((cod) => [cod, ROTULO_URGENCIA[cod] ?? cod]),
    catalogo: await _itens_ativos(tx),
    motivos: await _motivos_ativos(tx),
    ...extras,
    nomes: await _nomes_de(tx, [
      requisicao.analisado_por,
      requisicao.solicitado_por_id,
      ...requisicao.itens.map((l) => l.decidido_por),
      ...requisicao.itens.map((l) => l.autorizado_por),
    ]),
    eventos: await _trilha(tx, requisicao),
    servidores: await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)),
    editavel: servico.EDITAVEL.has(requisicao.estado),
    // o estado admite cancelar E nada saiu ainda
    cancelavel:
      EPI_REQUISICAO_CANCELAVEL.has(requisicao.estado) && !requisicao.itens.some((l) => l.quantidade_entregue > 0),
    pode_requisitar: usuario.pode("epi.requisitar"),
    pode_analisar: usuario.pode("epi.analisar"),
    pode_entregar: usuario.pode("epi.entregar"),
    // reservar, soltar e marcar falta são do almoxarifado (§4.3)
    pode_estocar: usuario.pode("epi.estoque"),
    // ONDE RETIRAR: parâmetro de instalação; vazio, a tela diz que não sabe
    local_retirada: obterConfig().epiLocalRetirada.trim(),
    mensagem: opcoes.mensagem ?? null,
    erro: opcoes.erro ?? null,
    digitado: dic(opcoes.digitado ?? {}),
    item_escolhido: opcoes.item_escolhido ? vestir_item(opcoes.item_escolhido) : null,
  });
}

rotas.get(`${FILA}/:requisicao_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const achada = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!achada) return redirecionar(c, FILA);
  // A fila não registra e esta tela registra: a URL nomeia UMA pessoa, e o que
  // se lê dela é cargo, unidade, rotina e riscos declarados (ROPA §0.2).
  await auditoria.registrar_leitura_nominal(c.get("tx"), usuario, "epi_requisicao.nominal", {
    servidor_id: achada.servidor_id,
    finalidade: "consulta da requisição de EPI — rotina de trabalho e riscos " + "declarados pelo requerente",
  });
  return _tela_ficha(c, usuario, achada.id, {
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/**
 * A guia de entrega, para imprimir e levar ao balcão. Sai do CONGELADO. É
 * HTML e não .docx de propósito: papel de conferência, não documento assinado.
 */
rotas.get(`${FILA}/:requisicao_id{[0-9]+}/guia`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const achada = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!achada) return redirecionar(c, FILA);
  // registro PRÓPRIO: a guia é o papel nominal que circula no balcão
  await auditoria.registrar_leitura_nominal(tx, usuario, "epi_requisicao.guia", {
    servidor_id: achada.servidor_id,
    finalidade: "impressão da guia de entrega de EPI para conferência no balcão",
  });
  const requisicao = (await carregar(tx, achada.id))!;
  return pagina(c, "paginas/epis_requisicao_guia.html", usuario, {
    requisicao,
    itens: requisicao.itens,
    hoje: hoje(),
    rotulos: dic(ROTULO_EPI_REQUISICAO),
    rotulos_item: dic(ROTULO_EPI_ITEM),
    rotulo_finalidade: ROTULO_FINALIDADE[requisicao.finalidade] ?? requisicao.finalidade,
    nomes: await _nomes_de(tx, [requisicao.analisado_por]),
  });
});

// =====================================================================
// O rascunho — o único estado em que o conteúdo se edita
// =====================================================================
rotas.post(`${FILA}/:requisicao_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão vem ANTES da busca, em toda rota de escrita
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!requisicao) return redirecionar(c, FILA);
  const f = await formulario(c);
  const digitado = {
    forma: "cabecalho",
    chefia_servidor_id: f.texto("chefia_servidor_id"),
    finalidade: f.texto("finalidade", "ROTINA"),
    urgencia: f.texto("urgencia", "NORMAL"),
    justificativa_urgencia: f.texto("justificativa_urgencia"),
    descricao_atividade: f.texto("descricao_atividade"),
    riscos_declarados: f.texto("riscos_declarados"),
  };
  const r = await tentar(c, (sp) =>
    servico.atualizar_rascunho(sp, usuario, requisicao, {
      chefia_servidor_id: _id(digitado.chefia_servidor_id),
      finalidade: digitado.finalidade,
      descricao_atividade: digitado.descricao_atividade,
      riscos_declarados: digitado.riscos_declarados,
      urgencia: digitado.urgencia,
      justificativa_urgencia: digitado.justificativa_urgencia,
    }),
  );
  // a recusa redesenha a tela com o DIGITADO, e não com a versão do banco
  if (!r.ok) return _tela_ficha(c, usuario, requisicao.id, { erro: _motivos(r.falha), digitado });
  return _volta(c, _ficha(requisicao.id), "Rascunho atualizado.");
});

/** RN-31 — o único estado que some de verdade, e o evento sobrevive a ele. */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/excluir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!requisicao) return redirecionar(c, FILA);
  const r = await tentar(c, (sp) => servico.excluir_rascunho(sp, usuario, requisicao));
  if (!r.ok) return _erro(c, _ficha(requisicao.id), _motivos(r.falha));
  return _volta(
    c,
    FILA,
    "Rascunho excluído. O evento da exclusão fica na trilha: apagar sem " +
      "rastro seria repetir o defeito da planilha, em que a linha sumia e nada " +
      "dizia que ela existiu.",
  );
});

rotas.post(`${FILA}/:requisicao_id{[0-9]+}/itens`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!requisicao) return redirecionar(c, FILA);
  const f = await formulario(c);
  const item = await _item_do_catalogo(c.get("tx"), _id(f.texto("item_id")));
  const digitado = {
    forma: "item-novo",
    item_id: f.texto("item_id"),
    quantidade: f.texto("quantidade"),
    tamanho: f.texto("tamanho"),
    justificativa: f.texto("justificativa"),
  };
  const recusar = (mensagem: string) =>
    _tela_ficha(c, usuario, requisicao.id, { erro: mensagem, digitado, item_escolhido: item });
  if (!item) return recusar("Escolha o equipamento no catálogo.");
  const quantas = _inteiro(digitado.quantidade);
  if (quantas === null) return recusar("Quantidade inválida: informe um número maior que zero.");
  const r = await tentar(c, (sp) =>
    servico.adicionar_item(sp, usuario, requisicao, {
      item,
      quantidade: quantas,
      tamanho: digitado.tamanho,
      justificativa: digitado.justificativa,
    }),
  );
  if (!r.ok) return recusar(_motivos(r.falha));
  return _volta(c, _ficha(requisicao.id), `'${item.nome}' acrescentado ao pedido.`);
});

rotas.post(`${FILA}/:requisicao_id{[0-9]+}/itens/:linha_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const requisicao_id = _param_id(c, "requisicao_id")!;
  const linha_id = _param_id(c, "linha_id")!;
  const destino = _ficha(requisicao_id);
  const linha = await _linha(c, usuario, requisicao_id, linha_id);
  if (!linha) return redirecionar(c, destino);
  const f = await formulario(c);
  // a forma leva o id da linha: o formulário de editar se repete por item
  const digitado = {
    forma: `item-${linha_id}`,
    quantidade: f.texto("quantidade"),
    tamanho: f.texto("tamanho"),
    justificativa: f.texto("justificativa"),
  };
  const recusar = (mensagem: string) => _tela_ficha(c, usuario, requisicao_id, { erro: mensagem, digitado });
  const quantas = _inteiro(digitado.quantidade);
  if (quantas === null) return recusar("Quantidade inválida: informe um número maior que zero.");
  const r = await tentar(c, (sp) =>
    servico.editar_item(sp, usuario, linha, {
      quantidade: quantas,
      tamanho: digitado.tamanho,
      justificativa: digitado.justificativa,
    }),
  );
  if (!r.ok) return recusar(_motivos(r.falha));
  return _volta(c, destino, "Item atualizado.", ANCORA_ITENS);
});

/** Some de verdade — mas só dentro do rascunho, que também some. */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/itens/:linha_id{[0-9]+}/remover`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const requisicao_id = _param_id(c, "requisicao_id")!;
  const destino = _ficha(requisicao_id);
  const linha = await _linha(c, usuario, requisicao_id, _param_id(c, "linha_id"));
  if (!linha) return redirecionar(c, destino);
  const nome = (await _item_do_catalogo(c.get("tx"), linha.epi_item_id))!.nome;
  const r = await tentar(c, (sp) => servico.remover_item(sp, usuario, linha));
  if (!r.ok) return _erro(c, destino, _motivos(r.falha));
  return _volta(c, destino, `'${nome}' removido do rascunho.`, ANCORA_ITENS);
});

/** RASCUNHO → ENVIADA. É aqui que o pedido vira documento. */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/enviar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!requisicao) return redirecionar(c, FILA);
  const destino = _ficha(requisicao.id);
  const r = await tentar(c, (sp) => servico.enviar(sp, usuario, requisicao));
  if (!r.ok) return _erro(c, destino, _motivos(r.falha));
  return _volta(
    c,
    destino,
    `Pedido protocolado como ${r.valor.protocolo}. A lotação, o cargo e a ` +
      "função ficaram congelados como estavam hoje.",
  );
});

// =====================================================================
// A análise — envelope. `AutoanaliseProibida` NÃO é capturada: sobe até o
// `onError`, que a rende como 403 com a mensagem inteira (as duas saídas).
// =====================================================================
function acao_de_envelope(
  sufixo: string,
  executar: (sp: Tx, usuario: UsuarioAtual, requisicao: servico.EpiRequisicao, f: Form) => Promise<unknown>,
  recado: (requisicao: servico.EpiRequisicao) => string,
  permissao: (usuario: UsuarioAtual) => void = (u) => u.exigir("epi.analisar"),
) {
  rotas.post(`${FILA}/:requisicao_id{[0-9]+}/${sufixo}`, async (c) => {
    const usuario = await usuarioLogado(c);
    permissao(usuario);
    const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
    if (!requisicao) return redirecionar(c, FILA);
    const destino = _ficha(requisicao.id);
    const f = await formulario(c);
    const r = await tentar(c, (sp) => executar(sp, usuario, requisicao, f));
    if (!r.ok) return _erro(c, destino, _motivos(r.falha));
    return _volta(c, destino, recado(requisicao));
  });
}

acao_de_envelope(
  "analise",
  (sp, usuario, requisicao) => servico.iniciar_analise(sp, usuario, requisicao),
  (requisicao) => `${servico.identificacao(requisicao)} está em análise com você.`,
);

/** EM_ANALISE → ENVIADA. Decidir sem base é pior do que devolver. */
acao_de_envelope(
  "devolver",
  (sp, usuario, requisicao, f) => servico.devolver_para_fila(sp, usuario, requisicao, f.texto("motivo")),
  () => "Pedido devolvido à fila, com o motivo na trilha.",
);

acao_de_envelope(
  "concluir",
  (sp, usuario, requisicao, f) => servico.concluir_analise(sp, usuario, requisicao, { parecer: f.texto("parecer") }),
  () =>
    "Análise concluída. O que foi aprovado pode ser entregue; " +
    "`EM_ATENDIMENTO` e `ATENDIDA` chegam sozinhas, conforme as entregas.",
);

/** EM_ANALISE → INDEFERIDA, com o motivo do catálogo (RN-27). */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/indeferir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.analisar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"));
  if (!requisicao) return redirecionar(c, FILA);
  const destino = _ficha(requisicao.id);
  const f = await formulario(c);
  const motivo = await _motivo(c.get("tx"), _id(f.texto("motivo_id")));
  if (!motivo) return _erro(c, destino, "Escolha o motivo do indeferimento no catálogo.");
  const r = await tentar(c, (sp) =>
    servico.indeferir(sp, usuario, requisicao, {
      motivo,
      complemento: f.texto("complemento"),
      parecer: f.texto("parecer"),
    }),
  );
  if (!r.ok) return _erro(c, destino, _motivos(r.falha));
  return _volta(c, destino, `Pedido indeferido com o motivo ${motivo.codigo}.`);
});

/** INDEFERIDA → EM_ANALISE. O único caminho de volta de um terminal. */
acao_de_envelope(
  "reconsiderar",
  (sp, usuario, requisicao, f) => servico.reconsiderar(sp, usuario, requisicao, f.texto("motivo")),
  () =>
    "Pedido reaberto para análise. As recusas de item NÃO voltaram sozinhas: " +
    "cada uma foi decisão própria, e desfazê-las em bloco reescreveria em " +
    "silêncio negativas que talvez estivessem certas.",
);

/** A desistência, com motivo — dos dois lados. */
acao_de_envelope(
  "cancelar",
  (sp, usuario, requisicao, f) => servico.cancelar(sp, usuario, requisicao, f.texto("motivo")),
  () => "Pedido cancelado, com o motivo registrado.",
  (u) => {
    if (!(u.pode("epi.requisitar") || u.pode("epi.analisar"))) throw new PermissaoNegada("epi.requisitar");
  },
);

// =====================================================================
// A análise e a reserva — item a item. Troca parcial quando vem do HTMX.
// =====================================================================
type Preparo = { recusa: string } | { dados: Record<string, any> };

interface AcaoDeItem {
  sufixo: string;
  permissao: (usuario: UsuarioAtual) => void;
  /** a recusa de FORMATO, antes do serviço, ou os dados já convertidos */
  preparar?: (c: Ctx, f: Form) => Promise<Preparo>;
  executar: (
    sp: Tx,
    usuario: UsuarioAtual,
    linha: servico.EpiRequisicaoItem,
    f: Form,
    dados: Record<string, any>,
  ) => Promise<unknown>;
  recado: (linha: servico.EpiRequisicaoItem, nome: string, dados: Record<string, any>) => string;
}

function acao_de_item(a: AcaoDeItem) {
  rotas.post(`${FILA}/:requisicao_id{[0-9]+}/itens/:linha_id{[0-9]+}/${a.sufixo}`, async (c) => {
    const usuario = await usuarioLogado(c);
    a.permissao(usuario);
    const requisicao_id = _param_id(c, "requisicao_id")!;
    const linha_id = _param_id(c, "linha_id")!;
    const destino = _ficha(requisicao_id);
    const linha = await _linha(c, usuario, requisicao_id, linha_id);
    if (!linha) return redirecionar(c, destino);
    const nome = (await _item_do_catalogo(c.get("tx"), linha.epi_item_id))!.nome;
    const parcial = _e_htmx(c);
    const f = await formulario(c);
    let dados: Record<string, any> = {};
    if (a.preparar) {
      const p = await a.preparar(c, f);
      if ("recusa" in p) return _parcial_ou_erro(c, usuario, requisicao_id, p.recusa, parcial, linha_id);
      dados = p.dados;
    }
    const r = await tentar(c, (sp) => a.executar(sp, usuario, linha, f, dados));
    if (!r.ok) return _parcial_ou_erro(c, usuario, requisicao_id, _motivos(r.falha), parcial, linha_id);
    if (parcial) return _secao_dos_itens(c, usuario, requisicao_id);
    return _volta(c, destino, a.recado(linha, nome, dados), ANCORA_ITENS);
  });
}

/** SOLICITADO → APROVADO, com a RN-26 contada na ficha. */
acao_de_item({
  sufixo: "aprovar",
  permissao: (u) => u.exigir("epi.analisar"),
  preparar: async (_c, f) => {
    const bruto = f.texto("quantidade_aprovada");
    const quantas = _inteiro(bruto);
    if (bruto.trim() && quantas === null) return { recusa: "Quantidade aprovada inválida." };
    return { dados: { quantas } };
  },
  executar: (sp, usuario, linha, f, d) =>
    servico.aprovar_item(sp, usuario, linha, {
      quantidade_aprovada: d.quantas,
      justificativa: f.texto("justificativa"),
      autorizar_excesso: _marcado(f.texto("autorizar_excesso")),
    }),
  recado: (linha, nome) => {
    let recado = `'${nome}': ${linha.quantidade_aprovada} aprovado(s).`;
    if (linha.excedeu_maximo) {
      recado +=
        " O máximo da RN-26 foi excedido e a exceção ficou registrada com o " +
        "seu nome, com a justificativa por escrito.";
    }
    return recado;
  },
});

/** SOLICITADO → RECUSADO. RN-27: fundamentada, catalogada e congelada. */
acao_de_item({
  sufixo: "recusar",
  permissao: (u) => u.exigir("epi.analisar"),
  preparar: async (c, f) => {
    const motivo = await _motivo(c.get("tx"), _id(f.texto("motivo_id")));
    if (!motivo) {
      return {
        recusa:
          "Escolha o motivo da recusa no catálogo: negativa em texto livre sai " +
          "diferente a cada vez, não cita norma e não se conta (RN-27).",
      };
    }
    return { dados: { motivo } };
  },
  executar: (sp, usuario, linha, f, d) =>
    servico.recusar_item(sp, usuario, linha, { motivo: d.motivo, complemento: f.texto("complemento") }),
  recado: (_linha, nome, d) =>
    `'${nome}' recusado com o motivo ${d.motivo.codigo}. ` +
    "O texto que vai para o requerente ficou congelado na linha.",
});

/** A linha sai do pedido sem virar recusa. Motivo obrigatório. */
acao_de_item({
  sufixo: "cancelar",
  permissao: (u) => {
    if (!(u.pode("epi.requisitar") || u.pode("epi.analisar"))) throw new PermissaoNegada("epi.analisar");
  },
  executar: (sp, usuario, linha, f) => servico.cancelar_item(sp, usuario, linha, f.texto("motivo")),
  recado: (_linha, nome) => `'${nome}' cancelado no pedido, com o motivo na trilha.`,
});

/** APROVADO ou SEM_ESTOQUE → RESERVADO. RN-24 e RN-25 na porta. */
acao_de_item({
  sufixo: "reservar",
  permissao: (u) => u.exigir("epi.estoque"),
  preparar: async (c, f) => {
    const entrada = await _entrada(c.get("tx"), _id(f.texto("entrada_id")));
    if (!entrada) {
      return {
        recusa:
          "Escolha o lote da reserva: reservar sem dizer de qual lote seria " +
          "prometer um número, e o que a pessoa vai calçar é uma caixa.",
      };
    }
    const bruto = f.texto("quantidade");
    const quantas = _inteiro(bruto);
    if (bruto.trim() && quantas === null) return { recusa: "Quantidade a reservar inválida." };
    return { dados: { entrada, quantas } };
  },
  executar: (sp, usuario, linha, _f, d) =>
    servico.reservar_item(sp, usuario, linha, { entrada: d.entrada, quantidade: d.quantas }),
  recado: (linha, nome, d) =>
    `${linha.quantidade_reservada} × '${nome}' reservado(s) no lote ` +
    `${d.entrada.lote || "sem número"}. As unidades saíram do disponível dos ` +
    "outros pedidos e continuam no saldo físico — reserva não é movimento.",
});

/** RESERVADO → SEM_ESTOQUE, com o motivo por escrito. */
acao_de_item({
  sufixo: "soltar-reserva",
  permissao: (u) => u.exigir("epi.estoque"),
  executar: (sp, usuario, linha, f) => servico.soltar_reserva(sp, usuario, linha, f.texto("motivo")),
  recado: (_linha, nome) =>
    `Reserva de '${nome}' solta, com o motivo na trilha. O item voltou a ` +
    "esperar estoque e as unidades voltaram ao disponível.",
});

/** APROVADO → SEM_ESTOQUE: o item é devido e a prateleira não tem. */
acao_de_item({
  sufixo: "sem-estoque",
  permissao: (u) => u.exigir("epi.estoque"),
  executar: (sp, usuario, linha, f) =>
    servico.marcar_sem_estoque(sp, usuario, linha, { complemento: f.texto("complemento") }),
  recado: (_linha, nome) =>
    `'${nome}' marcado como sem estoque. Ele passa a aparecer na fila de quem ` +
    "espera lote — a reserva continua sendo ato de quem opera o almoxarifado, " +
    "e não efeito automático da próxima entrada.",
});

/**
 * APROVADO/RESERVADO → ENTREGUE, reaproveitando a entrega da fatia 2. SEM troca
 * parcial: entregar muda o estado do PEDIDO, a trilha e o sino.
 */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/itens/:linha_id{[0-9]+}/entregar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const requisicao_id = _param_id(c, "requisicao_id")!;
  const destino = _ficha(requisicao_id);
  const linha = await _linha(c, usuario, requisicao_id, _param_id(c, "linha_id"));
  if (!linha) return redirecionar(c, destino);
  const f = await formulario(c);
  const entrada = await _entrada(c.get("tx"), _id(f.texto("entrada_id")));
  const bruto = f.texto("quantidade");
  const quantas = _inteiro(bruto);
  if (bruto.trim() && quantas === null) return _erro(c, destino, "Quantidade a entregar inválida.");
  const r = await tentar(
    c,
    (sp) =>
      servico.entregar_item(sp, usuario, linha, {
        entrada,
        quantidade: quantas,
        observacao: f.texto("observacao"),
      }),
    // a entrega delegada levanta a exceção da FICHA (CA do lote, janela)
    epi_ficha.EntregaBloqueada,
    epi_estoque.EstoqueBloqueado,
  );
  if (!r.ok) return _erro(c, destino, _motivos(r.falha));
  return _volta(
    c,
    destino,
    `Entrega registrada na ficha (registro ${r.valor.id}). Imprima o ` +
      "comprovante na ficha do servidor, colha a assinatura e anexe o " +
      "digitalizado — sem ele a entrega tem registro e não tem prova.",
    ANCORA_ITENS,
  );
});
