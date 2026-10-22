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
import { getCookie } from "hono/cookie";
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
import { ESCOPO_PROPRIO, PermissaoNegada, type UsuarioAtual } from "../servicos/rbac.js";
import { cadastrar_pelo_fragmento, fragmento_servidores } from "./epi_fichas.js";

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

/**
 * `{usuario_id: nome}` para a ficha. O nome, e não o id.
 *
 * RN-19 (revisão de privacidade, 25/09/2026): a conta que ABRIU o pedido é,
 * muitas vezes, a do próprio requerente (`servidor_consulta`). Escrever o nome
 * da conta em "Aberto por" desfazia, na mesma tela, o `SRV-xxxx` do titular.
 * Conta vinculada a servidor passa por `identificar(...)`, como o titular;
 * conta de equipe sem vínculo continua saindo pelo nome (é o ator, não o
 * titular).
 */
async function _nomes_de(
  tx: Tx,
  ids: (number | null | undefined)[],
  quem?: { c: Ctx; usuario: UsuarioAtual },
): Promise<Dic> {
  const alvos = [...new Set(ids.filter((i): i is number => i !== null && i !== undefined))];
  if (!alvos.length) return dic({});
  const linhas = await tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome, servidor_id: tabela_usuario.servidor_id })
    .from(tabela_usuario)
    .where(inArray(tabela_usuario.id, alvos));
  const semente = quem
    ? identificacao.semente_de({ cookies: { get: (n: string) => getCookie(quem.c, n) ?? null } })
    : "";
  return dic(
    new Map(
      linhas.map((u) => {
        if (u.servidor_id === null || (quem && identificacao.pode_ver_nominal(quem.usuario, u.servidor_id))) {
          return [u.id, u.nome];
        }
        return [u.id, textos.identificador_opaco(u.servidor_id, semente)];
      }),
    ),
  );
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
  opcoes: { recusa?: string | null; linha_id?: number | null; sucesso?: string | null } = {},
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
    ], { c, usuario }),
    editavel: servico.EDITAVEL.has(requisicao.estado),
    pode_requisitar: usuario.pode("epi.requisitar"),
    pode_analisar: usuario.pode("epi.analisar"),
    pode_entregar: usuario.pode("epi.entregar"),
    pode_estocar: usuario.pode("epi.estoque"),
    pode_cancelar: servico.pode_cancelar(usuario, requisicao),
    // a gaveta da linha recusada reabre
    digitado: dic(
      opcoes.linha_id !== undefined && opcoes.linha_id !== null ? { forma: `item-${opcoes.linha_id}` } : {},
    ),
    recusa: opcoes.recusa ?? null,
    // o recado de sucesso da troca parcial: sem ele aprovar, recusar e
    // reservar trocavam a lista em silêncio, e a pessoa não sabia se o clique
    // tinha valido
    sucesso: opcoes.sucesso ?? null,
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
  const bruto_estado = c.req.query("estado") ?? "";
  // Estado desconhecido não vira "todos" em silêncio: a lista sai inteira, mas
  // a tela diz que o filtro foi ignorado (o endereço colado de outro lugar, ou
  // um código antigo, mostrava tudo como se fosse o recorte pedido).
  const estado_valido = Object.hasOwn(ROTULO_EPI_REQUISICAO, bruto_estado);
  const estado = estado_valido ? bruto_estado : "";
  const estados = estado_valido ? [estado] : [];
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
    // a conta de escopo próprio só vê os próprios pedidos: para ela a tela é
    // "Meus pedidos", e não a fila do setor
    meus_pedidos: usuario.escopo_de("epi.ver") === ESCOPO_PROPRIO,
    filtro_ignorado: bruto_estado && !estado_valido ? bruto_estado : null,
    mensagem: c.req.query("mensagem") ?? null,
    erro: recado,
  });
});

// =====================================================================
// O formulário do pedido — declarado ANTES de `/epis/requisicoes/:id`
// (as rotas de id só casam dígitos, então a ordem não é mais o que protege)
// =====================================================================
// A nota de rodapé do seletor: quem digita não precisa ser quem vai usar.
export const NOTA_SERVIDOR = "A chefia ou a secretaria podem abrir o pedido por alguém da equipe.";

/**
 * O formulário do pedido. Duas formas, decididas pelo ESCOPO da conta:
 *
 * - **Próprio** (o servidor comum): o pedido é dele, e o campo "quem vai usar"
 *   vem preenchido e travado com o próprio nome — sem busca e sem a lista do
 *   cadastro inteiro em `SRV-xxxx`, que não servia a ninguém e deixava pedir em
 *   nome de terceiros. A chefia também sai: a lista dela era a mesma lista de
 *   códigos, e o campo é opcional.
 * - **Unidade ou total** (chefia, secretaria, SESMT): a busca de servidor
 *   continua, para pedir pela equipe.
 *
 * O primeiro item vem na MESMA tela (equipamento, tamanho, quantidade) com o
 * botão "Enviar pedido": o caso comum — uma luva, uma bota — sai num envio só,
 * em vez de rascunho → popup de item → popup de envio. O modelo continua o
 * mesmo (rascunho + itens): "Salvar e acrescentar outro item" leva à ficha do
 * rascunho, onde os outros itens entram.
 */
async function _tela_nova(
  c: Ctx,
  usuario: UsuarioAtual,
  opcoes: {
    q?: string;
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, unknown>;
    item_id?: number | null;
  } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const q = opcoes.q ?? "";
  // pelo escopo de `epi.requisitar`, e não da conta (D16): o almoxarife pede
  // só para si, pela concessão do titular
  const proprio = usuario.escopo_de("epi.requisitar") === ESCOPO_PROPRIO;
  const [eu] =
    proprio && usuario.servidor_id !== null
      ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, usuario.servidor_id))
      : [];
  const digitado = opcoes.digitado ?? {};
  const item_id = opcoes.item_id ?? _id(String(digitado["item_id"] ?? ""));
  const item = await _item_do_catalogo(tx, item_id);
  return pagina(c, "paginas/epis_requisicao_nova.html", usuario, {
    proprio,
    eu: eu ?? null,
    // a lista de servidores só existe para quem pede por outro
    servidores: proprio ? [] : await servico_servidores.buscar(tx, q, usuario),
    nota: NOTA_SERVIDOR,
    q,
    finalidades: FINALIDADES_REQUISICAO.map((cod) => [cod, ROTULO_FINALIDADE[cod] ?? cod]),
    urgencias: URGENCIAS_REQUISICAO.map((cod) => [cod, ROTULO_URGENCIA[cod] ?? cod]),
    catalogo: await _itens_ativos(tx),
    item_escolhido: item && item.ativo ? vestir_item(item) : null,
    hoje: hoje(),
    digitado: dic(digitado),
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
    // "Pedir troca", da ficha do titular, chega com o item já escolhido
    item_id: _id(c.req.query("item")),
  });
});

const SERVIDOR_NOVO_NO_PEDIDO = "/epis/requisicoes/servidores/novo";

/** Fragmento HTMX: a busca de servidor sem recarregar o formulário. */
rotas.get("/epis/requisicoes/servidores", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  return fragmento_servidores(c, usuario, {
    q: c.req.query("q") ?? "",
    nota: NOTA_SERVIDOR,
    url_cadastro: SERVIDOR_NOVO_NO_PEDIDO,
  });
});

/** Ninguém achado: cadastra SIAPE e nome ali mesmo e volta com a pessoa escolhida. */
rotas.post(SERVIDOR_NOVO_NO_PEDIDO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  return cadastrar_pelo_fragmento(c, usuario, { nota: NOTA_SERVIDOR, url_cadastro: SERVIDOR_NOVO_NO_PEDIDO });
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

/**
 * O rascunho — e, quando a tela já trouxe o item, a linha e o envio no mesmo
 * POST. **Não consome protocolo** se não houver envio (RN-03). As três coisas
 * correm num SAVEPOINT só: recusada qualquer uma, nada fica gravado e a tela
 * volta com tudo o que foi digitado — cabeçalho e item.
 */
rotas.post(FILA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.requisitar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const q = f.texto("q");
  const proprio = usuario.escopo_de("epi.requisitar") === ESCOPO_PROPRIO;
  // tudo o que foi digitado, guardado antes da primeira recusa
  const digitado = {
    // escopo próprio: o campo travado manda o próprio id; vazio vale o mesmo.
    // Outro id NÃO é corrigido em silêncio — o serviço o recusa (403).
    servidor_id: f.texto("servidor_id") || (proprio && usuario.servidor_id !== null ? String(usuario.servidor_id) : ""),
    chefia_servidor_id: proprio ? "" : f.texto("chefia_servidor_id"),
    finalidade: f.texto("finalidade", "ROTINA"),
    descricao_atividade: f.texto("descricao_atividade"),
    riscos_declarados: f.texto("riscos_declarados"),
    urgencia: f.texto("urgencia", "NORMAL"),
    justificativa_urgencia: f.texto("justificativa_urgencia"),
    item_id: f.texto("item_id"),
    quantidade: f.texto("quantidade"),
    tamanho: f.texto("tamanho"),
    justificativa: f.texto("justificativa"),
  };
  const acao = f.texto("acao");
  const recusar = (erro: string) => _tela_nova(c, usuario, { q, erro, digitado });

  if (proprio && usuario.servidor_id === null) {
    return recusar(
      "Sua conta não está ligada a um cadastro de servidor, e o pedido de EPI é sempre de um servidor. " +
        "Peça a quem administra as contas que faça a ligação, informando o seu SIAPE.",
    );
  }
  const servidor_id = _id(digitado.servidor_id);
  const [servidor] = servidor_id
    ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, servidor_id))
    : [];
  if (!servidor) return recusar("Escolha o servidor que vai usar o equipamento.");
  const chefia_id = _id(digitado.chefia_servidor_id);
  const [chefia] = chefia_id ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, chefia_id)) : [];

  // o item da própria tela: opcional para salvar, obrigatório para enviar
  const item = await _item_do_catalogo(tx, _id(digitado.item_id));
  if (acao === "enviar" && !item) return recusar("Escolha o equipamento antes de enviar: pedido sem item não é enviado.");
  const quantas = item ? _inteiro(digitado.quantidade) : null;
  if (item && quantas === null) return recusar("Quantidade inválida: informe um número maior que zero.");

  const r = await tentar(c, async (sp) => {
    const requisicao = await servico.criar_rascunho(sp, usuario, {
      servidor,
      chefia_servidor_id: chefia ? chefia.id : null,
      finalidade: digitado.finalidade,
      descricao_atividade: digitado.descricao_atividade,
      riscos_declarados: digitado.riscos_declarados,
      urgencia: digitado.urgencia,
      justificativa_urgencia: digitado.justificativa_urgencia,
    });
    if (item) {
      await servico.adicionar_item(sp, usuario, requisicao, {
        item,
        quantidade: quantas!,
        tamanho: digitado.tamanho,
        justificativa: digitado.justificativa,
      });
    }
    if (acao === "enviar") await servico.enviar(sp, usuario, requisicao);
    return requisicao;
  });
  if (!r.ok) return recusar(_motivos(r.falha));
  if (acao === "enviar") {
    return _volta(
      c,
      _ficha(r.valor.id),
      `Pedido enviado ao SESMT com o protocolo ${r.valor.protocolo}. Você acompanha a análise por aqui.`,
    );
  }
  return _volta(
    c,
    _ficha(r.valor.id),
    item
      ? `Rascunho salvo com '${item.nome}'. Acrescente outros itens abaixo e envie quando terminar.`
      : "Rascunho salvo. Acrescente os itens e envie — o número do pedido só é gerado no envio.",
  );
});

// =====================================================================
// A ficha do pedido
// =====================================================================
/**
 * A requisição desta URL, no escopo de quem pediu — ou `null`. `permissao` é
 * a do ato: mexer no pedido é `epi.requisitar`, e o alcance é o dela (D16) —
 * o almoxarife lê a fila do setor e edita só o próprio pedido.
 */
async function _requisicao(
  c: Ctx,
  usuario: UsuarioAtual,
  requisicao_id: number | null,
  permissao: string | readonly string[] = "epi.ver",
) {
  if (requisicao_id === null) return null;
  return servico.no_escopo(c.get("tx"), usuario, requisicao_id, permissao);
}

/** A linha, conferida contra a requisição da URL — e contra o escopo dela. */
async function _linha(
  c: Ctx,
  usuario: UsuarioAtual,
  requisicao_id: number | null,
  linha_id: number | null,
  permissao: string | readonly string[] = "epi.ver",
) {
  if (requisicao_id === null || linha_id === null) return null;
  if ((await _requisicao(c, usuario, requisicao_id, permissao)) === null) return null;
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

/**
 * A trilha com o nome de quem agiu passado pela mesma regra de `_nomes_de`:
 * quando quem agiu é o próprio requerente (conta vinculada ao servidor), o
 * `usuario_nome` gravado na trilha desfazia o `SRV-xxxx` do titular na mesma
 * tela (revisão de privacidade, 25/09/2026). A linha gravada não muda.
 */
async function _trilha_para_tela(
  c: Ctx,
  usuario: UsuarioAtual,
  eventos: Awaited<ReturnType<typeof _trilha>>,
) {
  const atores = await _nomes_de(c.get("tx"), eventos.map((e) => e.usuario_id), { c, usuario });
  return eventos.map((e) => ({
    ...e,
    usuario_nome: e.usuario_id !== null ? (atores.get(e.usuario_id) ?? e.usuario_nome) : e.usuario_nome,
  }));
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
    corrigir_item_id?: number | null;
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
    ], { c, usuario }),
    eventos: await _trilha_para_tela(c, usuario, await _trilha(tx, requisicao)),
    // a lista da chefia só existe para quem edita o rascunho e não é de escopo próprio
    servidores:
      servico.EDITAVEL.has(requisicao.estado) && usuario.escopo_de("epi.requisitar") !== ESCOPO_PROPRIO
        ? await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome))
        : [],
    editavel: servico.EDITAVEL.has(requisicao.estado),
    // o estado admite cancelar E nada saiu ainda
    cancelavel:
      EPI_REQUISICAO_CANCELAVEL.has(requisicao.estado) && !requisicao.itens.some((l) => l.quantidade_entregue > 0),
    pode_requisitar: usuario.pode("epi.requisitar"),
    pode_analisar: usuario.pode("epi.analisar"),
    proprio: usuario.escopo_de("epi.requisitar") === ESCOPO_PROPRIO,
    // requerente, quem abriu ou quem analisa — a mesma pergunta que o serviço faz
    pode_cancelar: servico.pode_cancelar(usuario, requisicao),
    // o botão de indeferir só aparece quando ele funciona
    indeferivel: servico.indeferivel(requisicao, requisicao.itens),
    // a guia é papel de balcão: só faz sentido com item aprovado a retirar
    tem_aprovado: requisicao.itens.some((l) => ["APROVADO", "RESERVADO", "SEM_ESTOQUE", "ENTREGUE"].includes(l.estado)),
    // servidor e secretaria leem a trilha de vez em quando; quem decide a lê sempre
    trilha_aberta: usuario.pode("epi.analisar") || usuario.pode("epi.estoque") || usuario.pode("epi.entregar"),
    // o atalho "aprovar tudo como pedido": analista que não é o requerente
    // (RN-28) e ainda há item sem decisão
    aprova_tudo:
      usuario.pode("epi.analisar") &&
      ["ENVIADA", "EM_ANALISE"].includes(requisicao.estado) &&
      (usuario.servidor_id === null || usuario.servidor_id !== requisicao.servidor_id) &&
      requisicao.itens.some((l) => l.estado === "SOLICITADO"),
    pode_entregar: usuario.pode("epi.entregar"),
    // reservar, soltar e marcar falta são do almoxarifado (§4.3)
    pode_estocar: usuario.pode("epi.estoque"),
    // ONDE RETIRAR: parâmetro de instalação; vazio, a tela diz que não sabe
    local_retirada: obterConfig().epiLocalRetirada.trim(),
    mensagem: opcoes.mensagem ?? null,
    erro: opcoes.erro ?? null,
    digitado: dic(opcoes.digitado ?? {}),
    item_escolhido: opcoes.item_escolhido ? vestir_item(opcoes.item_escolhido) : null,
    corrigir_item_id: opcoes.corrigir_item_id ?? null,
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
    corrigir_item_id: _id(c.req.query("corrigir_item")),
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
    nomes: await _nomes_de(tx, [requisicao.analisado_por], { c, usuario }),
  });
});

// =====================================================================
// O rascunho — o único estado em que o conteúdo se edita
// =====================================================================
rotas.post(`${FILA}/:requisicao_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão vem ANTES da busca, em toda rota de escrita
  usuario.exigir("epi.requisitar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), "epi.requisitar");
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
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), "epi.requisitar");
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
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), "epi.requisitar");
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
  const linha = await _linha(c, usuario, requisicao_id, linha_id, "epi.requisitar");
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
  const linha = await _linha(c, usuario, requisicao_id, _param_id(c, "linha_id"), "epi.requisitar");
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
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), "epi.requisitar");
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
/**
 * A permissão do ATO: a porta (basta uma da lista) e o alcance com que a linha
 * se procura. Era só a porta, e a linha se achava pelo alcance de `epi.ver`
 * (D9): o técnico recortado no campus JK que também tinha `consulta_progep`
 * (sem campus) analisava e entregava pedido de todos os campi — e, com a
 * concessão do titular (D16), o próprio pedido feito em outro campus.
 */
function _exigir_ato(usuario: UsuarioAtual, ato: string | readonly string[]): void {
  const lista = typeof ato === "string" ? [ato] : ato;
  if (!lista.some((p) => usuario.pode(p))) throw new PermissaoNegada(lista[0]!);
}

function acao_de_envelope(
  sufixo: string,
  executar: (sp: Tx, usuario: UsuarioAtual, requisicao: servico.EpiRequisicao, f: Form) => Promise<unknown>,
  recado: (requisicao: servico.EpiRequisicao) => string,
  ato: string | readonly string[] = "epi.analisar",
) {
  rotas.post(`${FILA}/:requisicao_id{[0-9]+}/${sufixo}`, async (c) => {
    const usuario = await usuarioLogado(c);
    _exigir_ato(usuario, ato);
    const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), ato);
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
    "Análise concluída. O que foi aprovado pode ser entregue; o pedido passa a " +
    `${ROTULO_EPI_REQUISICAO.EM_ATENDIMENTO!.toLowerCase()} e depois a ${ROTULO_EPI_REQUISICAO.ATENDIDA!.toLowerCase()} ` +
    "sozinho, conforme as entregas.",
);

/** ENVIADA/EM_ANALISE → ANALISADA de uma vez: tudo aprovado como pedido. */
acao_de_envelope(
  "aprovar-tudo",
  (sp, usuario, requisicao) => servico.aprovar_tudo(sp, usuario, requisicao),
  (requisicao) =>
    `${servico.identificacao(requisicao)} aprovado como pedido e com a análise concluída. ` +
    "Agora é entregar, item a item.",
);

/** EM_ANALISE → INDEFERIDA, com o motivo do catálogo (RN-27). */
rotas.post(`${FILA}/:requisicao_id{[0-9]+}/indeferir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.analisar");
  const requisicao = await _requisicao(c, usuario, _param_id(c, "requisicao_id"), "epi.analisar");
  if (!requisicao) return redirecionar(c, FILA);
  const destino = _ficha(requisicao.id);
  const f = await formulario(c);
  const motivo = await _motivo(c.get("tx"), _id(f.texto("motivo_id")));
  if (!motivo) return _erro(c, destino, "Escolha o motivo do indeferimento na lista.");
  // contados ANTES: o recado só fala dos itens recusados no ato quando houve algum
  const sem_decisao = (await servico.itens_de(c.get("tx"), requisicao.id)).filter((i) => i.estado === "SOLICITADO").length;
  const r = await tentar(c, (sp) =>
    servico.indeferir(sp, usuario, requisicao, {
      motivo,
      complemento: f.texto("complemento"),
      parecer: f.texto("parecer"),
    }),
  );
  if (!r.ok) return _erro(c, destino, _motivos(r.falha));
  return _volta(
    c,
    destino,
    `Pedido indeferido: ${motivo.rotulo}.` +
      (sem_decisao ? " Os itens que estavam sem decisão foram recusados com o mesmo motivo." : ""),
  );
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
  // a primeira porta é a permissão; quem, entre os que a têm, pode cancelar
  // ESTE pedido é o serviço que decide (`servico.pode_cancelar`)
  ["epi.requisitar", "epi.analisar"],
);

// =====================================================================
// A análise e a reserva — item a item. Troca parcial quando vem do HTMX.
// =====================================================================
type Preparo = { recusa: string } | { dados: Record<string, any> };

interface AcaoDeItem {
  sufixo: string;
  /** a permissão do ato (basta uma da lista): a porta e o alcance da linha */
  permissao: string | readonly string[];
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
    _exigir_ato(usuario, a.permissao);
    const requisicao_id = _param_id(c, "requisicao_id")!;
    const linha_id = _param_id(c, "linha_id")!;
    const destino = _ficha(requisicao_id);
    const linha = await _linha(c, usuario, requisicao_id, linha_id, a.permissao);
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
    if (parcial) return _secao_dos_itens(c, usuario, requisicao_id, { sucesso: a.recado(linha, nome, dados) });
    return _volta(c, destino, a.recado(linha, nome, dados), ANCORA_ITENS);
  });
}

/** SOLICITADO → APROVADO, com a RN-26 contada na ficha. */
acao_de_item({
  sufixo: "aprovar",
  permissao: "epi.analisar",
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
        " O máximo do item foi excedido e a exceção ficou registrada com o " +
        "seu nome, com a justificativa por escrito.";
    }
    return recado;
  },
});

/** SOLICITADO → RECUSADO. RN-27: fundamentada, catalogada e congelada. */
acao_de_item({
  sufixo: "recusar",
  permissao: "epi.analisar",
  preparar: async (c, f) => {
    const motivo = await _motivo(c.get("tx"), _id(f.texto("motivo_id")));
    if (!motivo) {
      return {
        recusa:
          "Escolha o motivo da recusa na lista: é o texto dele que vai para o requerente.",
      };
    }
    return { dados: { motivo } };
  },
  executar: (sp, usuario, linha, f, d) =>
    servico.recusar_item(sp, usuario, linha, { motivo: d.motivo, complemento: f.texto("complemento") }),
  recado: (_linha, nome, d) =>
    `'${nome}' recusado: ${d.motivo.rotulo}. ` + "O texto que vai para o requerente ficou guardado na linha.",
});

/** A linha sai do pedido sem virar recusa. Motivo obrigatório. */
acao_de_item({
  sufixo: "cancelar",
  permissao: ["epi.analisar", "epi.requisitar"],
  executar: (sp, usuario, linha, f) => servico.cancelar_item(sp, usuario, linha, f.texto("motivo")),
  recado: (_linha, nome) => `'${nome}' cancelado no pedido, com o motivo na trilha.`,
});

/** APROVADO ou SEM_ESTOQUE → RESERVADO. RN-24 e RN-25 na porta. */
acao_de_item({
  sufixo: "reservar",
  permissao: "epi.estoque",
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
  permissao: "epi.estoque",
  executar: (sp, usuario, linha, f) => servico.soltar_reserva(sp, usuario, linha, f.texto("motivo")),
  recado: (_linha, nome) =>
    `Reserva de '${nome}' solta, com o motivo na trilha. O item voltou a ` +
    "esperar estoque e as unidades voltaram ao disponível.",
});

/** APROVADO → SEM_ESTOQUE: o item é devido e a prateleira não tem. */
acao_de_item({
  sufixo: "sem-estoque",
  permissao: "epi.estoque",
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
  const linha = await _linha(c, usuario, requisicao_id, _param_id(c, "linha_id"), "epi.entregar");
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
  if (!r.ok) {
    // CA do catálogo faltando: a volta leva o item, e a tela o link para corrigi-lo
    const corrigir = r.falha instanceof epi_ficha.EntregaBloqueada ? r.falha.item_a_corrigir : null;
    return _erro(c, corrigir ? `${destino}?corrigir_item=${corrigir}` : destino, _motivos(r.falha));
  }
  return _volta(
    c,
    destino,
    `Entrega registrada na ficha (registro ${r.valor.id}). Imprima o ` +
      "comprovante na ficha do servidor, colha a assinatura e anexe o " +
      "digitalizado — sem ele a entrega tem registro e não tem prova.",
    ANCORA_ITENS,
  );
});
