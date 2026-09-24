/**
 * /epis/estoque — o saldo por item e por lote, e o livro razão de cada um.
 * Porte de `app/rotas/epi_estoque.py` (fatia 3 do desenho).
 *
 * O que esta tela existe para tornar visível:
 * 1. Saldo é soma de movimentos, e a tela mostra a soma — cada número tem um
 *    extrato append-only atrás dele.
 * 2. O lote vencido continua no estoque, marcado. Some da lista de entrega, não desta.
 * 3. Quantidade não se edita: muda por movimento.
 * 4. Físico, reservado e disponível lado a lado (RN-24): quem conta a prateleira
 *    encontra o físico.
 */
import { Hono } from "hono";
import { asc, eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import { epi_entrada_estoque, epi_item, usuario as tabela_usuario } from "../db/esquema/index.js";
import * as servico from "../servicos/epi_estoque.js";
import * as epi_requisicao from "../servicos/epi_requisicao.js";
import * as datas_br from "../servicos/datas_br.js";
import { TextoProibido } from "../servicos/textos.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const ESTOQUE = "/epis/estoque";
export const NOVA_ENTRADA = ESTOQUE + "/nova-entrada";

/** Codificado: um `&` no nome do fornecedor cortava o recado no `Location`. */
function _volta(c: Ctx, mensagem: string, destino = ESTOQUE): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "mensagem"));
}

function _erro(c: Ctx, mensagem: string, destino = ESTOQUE): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "erro"));
}

/** Inteiro não negativo, ou `null` quando vazio ou com lixo. */
function _inteiro(bruto: string | null | undefined): number | null {
  const limpo = (bruto || "").trim();
  return /^\d+$/.test(limpo) ? Number(limpo) : null;
}

/** `date.fromisoformat(limpo[:10])`, ou `null`. */
function _data(bruto: string | null | undefined): string | null {
  const limpo = (bruto || "").trim();
  if (!limpo) return null;
  const iso = limpo.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return iso;
}

async function _lote(tx: Executor, entrada_id: number) {
  const [entrada] = await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, entrada_id));
  return entrada ?? null;
}

async function _item(tx: Executor, item_id: number) {
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, item_id));
  return item ?? null;
}

/** `{usuario_id: nome}` para o extrato. Uma consulta, não uma por linha. */
async function _nomes_de(tx: Executor, ids: (number | null)[]): Promise<Record<number, string>> {
  const alvos = [...new Set(ids.filter((i): i is number => i !== null))];
  if (!alvos.length) return {};
  const linhas = await tx
    .select({ id: tabela_usuario.id, nome: tabela_usuario.nome })
    .from(tabela_usuario)
    .where(inArray(tabela_usuario.id, alvos));
  return Object.fromEntries(linhas.map((u) => [u.id, u.nome]));
}

/** As falhas do serviço em texto de tela (`" · ".join(motivos)`). */
function _texto_da_falha(falha: unknown): string | null {
  if (falha instanceof servico.EstoqueBloqueado) return falha.motivos.join(" · ");
  if (falha instanceof TextoProibido) return falha.message;
  return null;
}

// =====================================================================
// A tela
// =====================================================================
rotas.get(ESTOQUE, async (c) => {
  const usuario = await usuarioLogado(c);
  // abre em leitura para quem tem `epi.ver`; escrever pede `epi.estoque`
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const q = c.req.query("q") ?? "";
  const hoje = datas_br.hoje();
  const linhas = await servico.panorama(tx, { quando: hoje, busca: q });
  // o que pede decisão, contado no topo: saldo que existe e não pode sair
  const lotes_impedidos = linhas.flatMap((linha) =>
    linha.lotes
      .filter((lote) => lote.impedido && lote.fisico)
      // o template lê `l.entrada.item.nome` (relação que o SQLAlchemy carregava)
      .map((lote) => ({ entrada: { ...lote.entrada, item: linha.item }, fisico: lote.fisico, impedimento: lote.impedimento })),
  );
  return pagina(c, "paginas/epis_estoque.html", usuario, {
    linhas,
    q,
    hoje,
    lotes_impedidos,
    preso: lotes_impedidos.reduce((s, l) => s + l.fisico, 0),
    pode_escrever: usuario.pode("epi.estoque"),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

// =====================================================================
// A entrada de lote — página, e não popup (dezenove campos não cabem num diálogo
// de 1366×768). Declarada antes das rotas com `:entrada_id`.
// =====================================================================
async function _tela_nova_entrada(
  c: Ctx,
  usuario: UsuarioAtual,
  r: { erro?: string | null; campo_com_erro?: string | null; digitado?: Record<string, string> | null } = {},
): Promise<Response> {
  const itens = await c.get("tx").select().from(epi_item).where(eq(epi_item.ativo, true)).orderBy(asc(epi_item.nome));
  return pagina(c, "paginas/epis_estoque_nova_entrada.html", usuario, {
    hoje: datas_br.hoje(),
    itens,
    digitado: r.digitado ?? {},
    campo_com_erro: r.campo_com_erro ?? null,
    erro: r.erro ?? null,
  });
}

rotas.get(NOVA_ENTRADA, async (c) => {
  const usuario = await usuarioLogado(c);
  // a mesma permissão da POST que grava — conferida, não presumida
  usuario.exigir("epi.estoque");
  return _tela_nova_entrada(c, usuario);
});

const CAMPOS_ENTRADA = [
  "item_id",
  "quantidade_recebida",
  "data_entrada",
  "tamanho",
  "pregao",
  "item_pregao",
  "empenho",
  "nota_fiscal",
  "quantidade_empenhada",
  "valor_unitario",
  "fornecedor_nome",
  "fornecedor_cnpj",
  "fornecedor_contato",
  "lote",
  "numero_ca",
  "validade_ca",
  "data_fabricacao",
  "observacao",
] as const;

/** A entrada do lote: a compra pública e o primeiro movimento do razão. */
rotas.post(ESTOQUE, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.estoque");
  const tx = c.get("tx");
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado antes da primeira recusa
  const d: Record<string, string> = {};
  for (const n of CAMPOS_ENTRADA) d[n] = f.texto(n, "");

  // `campo` é o <input> que a tela vai marcar e focar; em branco quando quem
  // recusa é o serviço (o motivo pode cruzar campos)
  const recusar = (mensagem: string, campo: string | null = null) =>
    _tela_nova_entrada(c, usuario, { erro: mensagem, campo_com_erro: campo, digitado: d });

  const item = /^\d+$/.test(d.item_id!.trim()) ? await _item(tx, Number(d.item_id!.trim())) : null;
  if (!item) return recusar("Escolha o item do catálogo a que o lote pertence.", "item_id");

  const recebida = _inteiro(d.quantidade_recebida);
  if (recebida === null || recebida <= 0) {
    return recusar("Quantidade recebida inválida: informe um número maior que zero.", "quantidade_recebida");
  }
  const empenhada = _inteiro(d.quantidade_empenhada);
  if (d.quantidade_empenhada!.trim() && empenhada === null) return recusar("Quantidade empenhada inválida.", "quantidade_empenhada");

  const quando = _data(d.data_entrada);
  if (d.data_entrada!.trim() && quando === null) return recusar("Data de entrada inválida.", "data_entrada");
  const validade = _data(d.validade_ca);
  if (d.validade_ca!.trim() && validade === null) return recusar("Validade do CA inválida.", "validade_ca");
  const fabricacao = _data(d.data_fabricacao);
  if (d.data_fabricacao!.trim() && fabricacao === null) return recusar("Data de fabricação inválida.", "data_fabricacao");

  // a MESMA função que o serviço usa, chamada aqui só para APONTAR o campo
  try {
    servico.normalizar_cnpj(d.fornecedor_cnpj);
  } catch (falha) {
    if (falha instanceof servico.EstoqueBloqueado) return recusar(falha.motivos.join(" · "), "fornecedor_cnpj");
    throw falha;
  }

  let entrada: servico.EpiEntradaEstoque;
  try {
    const valor = servico.valor_decimal(d.valor_unitario);
    entrada = await servico.registrar_entrada(tx, usuario, {
      item,
      quantidade_recebida: recebida,
      data_entrada: quando,
      tamanho: d.tamanho,
      pregao: d.pregao,
      item_pregao: d.item_pregao,
      empenho: d.empenho,
      nota_fiscal: d.nota_fiscal,
      fornecedor_nome: d.fornecedor_nome,
      fornecedor_cnpj: d.fornecedor_cnpj,
      fornecedor_contato: d.fornecedor_contato,
      quantidade_empenhada: empenhada,
      valor_unitario: valor,
      lote: d.lote,
      numero_ca: d.numero_ca,
      validade_ca: validade,
      data_fabricacao: fabricacao,
      observacao: d.observacao,
    });
  } catch (falha) {
    const texto = _texto_da_falha(falha);
    if (texto === null) throw falha;
    desfazer(c);
    return recusar(texto);
  }

  let recado = `Lote ${entrada.lote || "sem número"} de '${item.nome}' registrado com ` + `${recebida} em estoque.`;
  const impedimento = servico.impedimento_do_lote(entrada, item, datas_br.hoje());
  if (impedimento) {
    recado += ` ATENÇÃO: o lote não pode ser entregue — ${impedimento}.`;
  } else {
    // o sistema AVISA quem está esperando; a reserva continua sendo ato de gente
    const esperando = await epi_requisicao.itens_esperando_estoque(tx, { epi_item_id: item.id, tamanho: entrada.tamanho });
    if (esperando.length) {
      recado +=
        ` ${esperando.length} item(ns) de pedido(s) esperam este ` +
        "equipamento — a reserva não é automática: abra o pedido e " +
        "reserve o lote, para que fique registrado quem decidiu.";
    }
  }
  return _volta(c, recado);
});

// A permissão vem ANTES da busca nas três rotas de escrita: quem não pode
// escrever recebe a mesma resposta para lote que existe e para lote que não.
rotas.post(`${ESTOQUE}/:entrada_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.estoque");
  const tx = c.get("tx");
  const entrada = await _lote(tx, Number(c.req.param("entrada_id")));
  if (!entrada) return redirecionar(c, ESTOQUE);
  const f = await formulario(c);
  try {
    await servico.atualizar_lote(tx, usuario, {
      entrada,
      nota_fiscal: f.texto("nota_fiscal"),
      fornecedor_contato: f.texto("fornecedor_contato"),
      observacao: f.texto("observacao"),
      ativo: f.texto("ativo") === "1",
      motivo_inativacao: f.texto("motivo_inativacao"),
    });
  } catch (falha) {
    const texto = _texto_da_falha(falha);
    if (texto === null) throw falha;
    desfazer(c);
    return _erro(c, texto);
  }
  return _volta(c, `Lote ${entrada.lote || entrada.id} atualizado.`);
});

/** A única forma legítima de o saldo do sistema encontrar a prateleira. */
rotas.post(`${ESTOQUE}/:entrada_id{[0-9]+}/ajuste`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.estoque");
  const tx = c.get("tx");
  const entrada = await _lote(tx, Number(c.req.param("entrada_id")));
  if (!entrada) return redirecionar(c, ESTOQUE);
  const f = await formulario(c);
  const contada = _inteiro(f.texto("contagem"));
  if (contada === null) return _erro(c, "Contagem inválida: informe quantas unidades você contou.");
  let movimento;
  try {
    movimento = await servico.ajustar(tx, usuario, { entrada, contagem: contada, motivo: f.texto("motivo") });
  } catch (falha) {
    const texto = _texto_da_falha(falha);
    if (texto === null) throw falha;
    desfazer(c);
    return _erro(c, texto);
  }
  const sinal = movimento.quantidade >= 0 ? `+${movimento.quantidade}` : String(movimento.quantidade);
  return _volta(
    c,
    `Inventário registrado no lote ${entrada.lote || entrada.id}: ` +
      `${sinal}, saldo agora ${contada}. ` +
      "A linha do razão guarda a contagem, o motivo e o seu nome.",
  );
});

rotas.post(`${ESTOQUE}/:entrada_id{[0-9]+}/descarte`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.estoque");
  const tx = c.get("tx");
  const entrada = await _lote(tx, Number(c.req.param("entrada_id")));
  if (!entrada) return redirecionar(c, ESTOQUE);
  const f = await formulario(c);
  const quantas = _inteiro(f.texto("quantidade"));
  if (quantas === null) return _erro(c, "Quantidade a descartar inválida.");
  try {
    await servico.descartar(tx, usuario, { entrada, quantidade: quantas, motivo: f.texto("motivo") });
  } catch (falha) {
    const texto = _texto_da_falha(falha);
    if (texto === null) throw falha;
    desfazer(c);
    return _erro(c, texto);
  }
  return _volta(
    c,
    `${quantas} unidade(s) descartada(s) do lote ${entrada.lote || entrada.id}. ` +
      "O descarte é decisão registrada: a linha fica no razão, com o motivo.",
  );
});

/** O extrato do lote: cada movimento, o motivo e o saldo que ele deixou. */
rotas.get(`${ESTOQUE}/:entrada_id{[0-9]+}/movimentos`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const entrada = await _lote(tx, Number(c.req.param("entrada_id")));
  if (!entrada) return redirecionar(c, ESTOQUE);
  const item = (await _item(tx, entrada.epi_item_id))!;
  const hoje = datas_br.hoje();
  const linhas = await servico.extrato(tx, entrada.id);
  return pagina(c, "paginas/epis_estoque_movimentos.html", usuario, {
    entrada,
    item,
    linhas,
    // o nome de quem registrou, e não o id
    nomes: await _nomes_de(
      tx,
      linhas.map((l) => l.movimento.registrado_por),
    ),
    fisico: await servico.saldo_fisico(tx, entrada.id),
    reservado: await servico.reservado(tx, entrada.id),
    impedimento: servico.impedimento_do_lote(entrada, item, hoje),
    hoje,
    pode_escrever: usuario.pode("epi.estoque"),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});
