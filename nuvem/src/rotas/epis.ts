/**
 * /epis/* — o catálogo do módulo Gestão de EPI. Porte de `app/rotas/epis.py`.
 *
 * Fatia 1 do desenho: o item de EPI, a taxonomia da NR-6 e os motivos de
 * recusa. Lista com edição em linha, formulário de cadastro em popup e diff
 * campo a campo na auditoria.
 *
 * Duas coisas que esta tela existe para desfazer: `validade_ca` APARECE (no
 * legado a coluna existia e não estava no formulário), e as colunas que
 * governam a requisição (padrão, máxima, justificativa) aparecem — regra que
 * ninguém consegue ver não é regra, é armadilha.
 */
import { Hono } from "hono";
import { and, asc, count, eq, isNull, ne, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import { epi_categoria, epi_item, epi_motivo_recusa } from "../db/esquema/index.js";
import { EpiCategoria, EpiItem, UNIDADES_MEDIDA } from "../dominio/epi.js";
import * as auditoria from "../servicos/auditoria.js";
import * as datas_br from "../servicos/datas_br.js";
import * as textos from "../servicos/textos.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, numeroDaPagina, pagina, recortar, redirecionar, salvar_com_diff } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const CATALOGO = "/epis/catalogo";
export const CATEGORIAS = "/epis/catalogo/categorias";
export const MOTIVOS = "/epis/catalogo/motivos-recusa";

// Rótulo e caminho das três abas: a mesma lista em três telas.
export const ABAS: readonly (readonly [string, string])[] = [
  [CATALOGO, "Itens de EPI"],
  [CATEGORIAS, "Categorias (NR-6)"],
  [MOTIVOS, "Motivos de recusa"],
];

function _texto(valor: string | null | undefined): string | null {
  return (valor || "").trim() || null;
}

function _marcado(valor: string): boolean {
  return valor === "1";
}

/** O recado vai codificado: um `&` no rótulo encerrava a query string ali. */
function _volta(c: Ctx, destino: string, mensagem: string): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "mensagem"));
}

/** Não deu: banner vermelho. */
function _erro(c: Ctx, destino: string, mensagem: string): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "erro"));
}

/** Inteiro positivo, ou `null` quando vem vazio OU com lixo (quem chama distingue). */
function _inteiro(valor: string | null | undefined): number | null {
  const limpo = (valor || "").trim();
  if (!/^\d+$/.test(limpo)) return null;
  const numero = Number(limpo);
  return numero > 0 ? numero : null;
}

/** `date.fromisoformat(limpo[:10])`, ou `null`. */
export function _data(valor: string | null | undefined): string | null {
  const limpo = (valor || "").trim();
  if (!limpo) return null;
  const iso = limpo.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return iso;
}

/** Os valores de texto de um formulário, com `""` para o que não veio (`Form("")`). */
function _campos(f: Awaited<ReturnType<typeof formulario>>, nomes: readonly string[]): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const n of nomes) saida[n] = f.texto(n, "");
  return saida;
}

const CAMPOS_ITEM = [
  "nome",
  "categoria_id",
  "descricao",
  "codigo_ecampus",
  "codigo_catmat",
  "fabricante",
  "marca",
  "modelo",
  "normas",
  "exige_ca",
  "numero_ca",
  "validade_ca",
  "unidade_medida",
  "tamanhos",
  "vida_util_meses",
  "quantidade_padrao",
  "quantidade_maxima",
  "periodo_maximo_meses",
  "exige_justificativa",
  "exige_treinamento",
] as const;

type CamposItem = {
  nome: string;
  categoria_id: number;
  descricao: string | null;
  codigo_ecampus: string | null;
  codigo_catmat: string | null;
  fabricante: string | null;
  marca: string | null;
  modelo: string | null;
  normas: string | null;
  exige_ca: boolean;
  numero_ca: string | null;
  validade_ca: string | null;
  unidade_medida: string;
  tamanhos: string | null;
  vida_util_meses: number | null;
  quantidade_padrao: number;
  quantidade_maxima: number | null;
  periodo_maximo_meses: number | null;
  exige_justificativa: boolean;
  exige_treinamento: boolean;
  ativo?: boolean;
};

/**
 * Lê o formulário e devolve `[campos, erro]` — um dos dois é sempre vazio.
 * Cadastro e edição passam pela MESMA conferência, e ela roda antes do banco
 * para a pessoa ler a regra e não o nome de uma constraint.
 */
export function _campos_do_item(f: Record<string, string>): [CamposItem | null, string] {
  const nome_limpo = (f.nome || "").trim();
  if (!nome_limpo) return [null, "O nome do EPI não pode ficar em branco."];
  if (!/^\d+$/.test((f.categoria_id || "").trim())) return [null, "Escolha a categoria da NR-6."];

  const padrao = _inteiro(f.quantidade_padrao);
  if (padrao === null) return [null, "Quantidade padrão inválida: informe um número maior que zero."];

  // O par (máxima, janela) anda junto: "2 por ano" é regra, "2" não é nada (RN-26)
  const maxima = _inteiro(f.quantidade_maxima);
  const janela = _inteiro(f.periodo_maximo_meses);
  const tem_maxima = Boolean((f.quantidade_maxima || "").trim());
  const tem_janela = Boolean((f.periodo_maximo_meses || "").trim());
  if (tem_maxima !== tem_janela) {
    return [
      null,
      "Quantidade máxima e período andam juntos: " + "'2 por 12 meses' é regra, '2' sozinho não quer dizer nada.",
    ];
  }
  if (tem_maxima && (maxima === null || janela === null)) {
    return [null, "Quantidade máxima e período: informe números maiores que zero."];
  }
  if (maxima !== null && maxima < padrao) return [null, "A quantidade máxima não pode ser menor que a padrão."];

  const vida_util = _inteiro(f.vida_util_meses);
  if ((f.vida_util_meses || "").trim() && vida_util === null) {
    return [null, "Vida útil inválida: informe meses inteiros maiores que zero."];
  }

  // RN-25 nasce aqui: item que exige CA sem número é item que a entrega não sabe conferir
  const exige = _marcado(f.exige_ca ?? "");
  const ca = _texto(f.numero_ca);
  if (exige && !ca) {
    return [
      null,
      "Item que exige CA precisa do número do CA: " + "sem ele não há o que conferir na hora de entregar.",
    ];
  }

  const validade = _data(f.validade_ca);
  if ((f.validade_ca || "").trim() && validade === null) return [null, "Data de validade do CA inválida."];

  return [
    {
      nome: nome_limpo,
      categoria_id: Number(f.categoria_id!.trim()),
      descricao: _texto(f.descricao),
      codigo_ecampus: _texto(f.codigo_ecampus),
      codigo_catmat: _texto(f.codigo_catmat),
      fabricante: _texto(f.fabricante),
      marca: _texto(f.marca),
      modelo: _texto(f.modelo),
      normas: _texto(f.normas),
      exige_ca: exige,
      numero_ca: ca,
      validade_ca: validade,
      unidade_medida: (_texto(f.unidade_medida) || "UNIDADE").toUpperCase().slice(0, 20),
      tamanhos: _texto(f.tamanhos),
      vida_util_meses: vida_util,
      quantidade_padrao: padrao,
      quantidade_maxima: maxima,
      periodo_maximo_meses: janela,
      exige_justificativa: _marcado(f.exige_justificativa ?? ""),
      exige_treinamento: _marcado(f.exige_treinamento ?? ""),
    },
    "",
  ];
}

/**
 * O par (nome, modelo) é a chave de negócio. Conferido aqui além do índice
 * porque `NULL` não colide com `NULL`: dois itens de mesmo nome e sem modelo
 * passariam pelo unique.
 */
async function _homonimo(tx: Executor, nome: string, modelo: string | null, excluir: number | null = null) {
  const condicoes: SQL[] = [eq(epi_item.nome, nome), modelo === null ? isNull(epi_item.modelo) : eq(epi_item.modelo, modelo)];
  if (excluir !== null) condicoes.push(ne(epi_item.id, excluir));
  const [achado] = await tx.select().from(epi_item).where(and(...condicoes));
  return achado ?? null;
}

async function _categorias(tx: Executor) {
  const linhas = await tx.select().from(epi_categoria).orderBy(asc(epi_categoria.ordem), asc(epi_categoria.nome));
  return linhas.map((c) => ({ ...c, rotulo: EpiCategoria.rotulo(c) }));
}

// =====================================================================
// Itens de EPI
// =====================================================================
async function _tela_catalogo(
  c: Ctx,
  usuario: UsuarioAtual,
  r: { mensagem?: string | null; erro?: string | null; digitado?: Record<string, string> | null } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const categorias = await _categorias(tx);
  const por_categoria = new Map(categorias.map((cat) => [cat.id, cat]));
  const brutos = await tx.select().from(epi_item).orderBy(asc(epi_item.nome), asc(epi_item.modelo));
  const itens = brutos.map((i) => ({
    ...i,
    categoria: por_categoria.get(i.categoria_id) ?? null,
    lista_de_tamanhos: EpiItem.lista_de_tamanhos(i),
    lista_de_normas: EpiItem.lista_de_normas(i),
    regra_de_quantidade: EpiItem.regra_de_quantidade(i),
  }));
  // O aviso vermelho conta o CATÁLOGO INTEIRO, e não a página: um alerta de CA
  // vencido que encolhe ao virar de página é pior do que alerta nenhum.
  const hoje = datas_br.hoje();
  const com_ca_vencido = itens.filter((i) => i.exige_ca && i.ativo && (i.validade_ca === null || i.validade_ca < hoje));
  const recorte = recortar(itens, numeroDaPagina(c));
  return pagina(c, "paginas/epis_catalogo.html", usuario, {
    abas: ABAS,
    aba: CATALOGO,
    itens: recorte.itens,
    recorte,
    com_ca_vencido,
    categorias,
    unidades: UNIDADES_MEDIDA,
    hoje,
    mensagem: r.mensagem ?? null,
    erro: r.erro ?? null,
    digitado: r.digitado ?? null,
  });
}

rotas.get(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  // abre em leitura para quem tem `epi.ver`; editar pede `epi.catalogo`
  usuario.exigir("epi.ver");
  return _tela_catalogo(c, usuario, { mensagem: c.req.query("mensagem"), erro: c.req.query("erro") });
});

rotas.post(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const digitado = _campos(await formulario(c), CAMPOS_ITEM);
  // Renderiza a tela de novo com o popup reaberto e o digitado — nunca redireciona
  const recusar = (mensagem: string) => _tela_catalogo(c, usuario, { erro: mensagem, digitado });

  const [campos, erro] = _campos_do_item(digitado);
  if (campos === null) return recusar(erro);
  const [categoria] = await tx.select().from(epi_categoria).where(eq(epi_categoria.id, campos.categoria_id));
  if (!categoria) return recusar("Categoria não encontrada.");
  if (await _homonimo(tx, campos.nome, campos.modelo)) {
    return recusar(`Já existe '${campos.nome}' com esse modelo. ` + "Para cadastrar outro, informe o modelo que os distingue.");
  }
  const [item] = await tx.insert(epi_item).values(campos).returning();
  await auditoria.registrar(tx, {
    entidade: "epi_item",
    entidade_id: item!.id,
    tipo_evento: "EPI_ITEM_CRIADO",
    descricao: `${item!.nome} · ${categoria.nome} · ` + `CA ${item!.numero_ca || "—"} · ${EpiItem.regra_de_quantidade(item!)}`,
    usuario,
  });
  return _volta(c, CATALOGO, `'${item!.nome}' cadastrado.`);
});

// =====================================================================
// Categorias da NR-6
// =====================================================================
rotas.get(CATEGORIAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const itens = await _categorias(tx);
  // quantos itens estão em cada categoria: desativar uma em uso esconde o item do formulário
  const contagens = await tx
    .select({ categoria_id: epi_item.categoria_id, n: count() })
    .from(epi_item)
    .groupBy(epi_item.categoria_id);
  const em_uso: Record<number, number> = {};
  for (const cat of itens) em_uso[cat.id] = 0;
  for (const l of contagens) em_uso[l.categoria_id] = Number(l.n);
  return pagina(c, "paginas/epis_categorias.html", usuario, {
    abas: ABAS,
    aba: CATEGORIAS,
    itens,
    em_uso,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/**
 * Só o rótulo, a referência e a ordem. Não há cadastro de categoria nova: a
 * lista é o Anexo I da NR-6, e criar a décima pela tela seria inventar norma.
 */
rotas.post(`${CATEGORIAS}/:categoria_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const numero = _inteiro(f.texto("ordem", "1"));
  return salvar_com_diff(
    c,
    usuario,
    epi_categoria,
    Number(c.req.param("categoria_id")),
    {
      nome: f.texto("nome").trim(),
      referencia_nr6: _texto(f.texto("referencia_nr6")),
      ordem: numero !== null ? numero : 1,
      ativo: _marcado(f.texto("ativo")),
    },
    { permissao: "epi.catalogo", rotulo: "Categoria", volta: CATEGORIAS },
  );
});

// =====================================================================
// Motivos de recusa
// =====================================================================
async function _tela_motivos(
  c: Ctx,
  usuario: UsuarioAtual,
  r: { mensagem?: string | null; erro?: string | null; digitado?: Record<string, string> | null } = {},
): Promise<Response> {
  const itens = await c.get("tx").select().from(epi_motivo_recusa).orderBy(asc(epi_motivo_recusa.codigo));
  return pagina(c, "paginas/epis_motivos.html", usuario, {
    abas: ABAS,
    aba: MOTIVOS,
    itens,
    mensagem: r.mensagem ?? null,
    erro: r.erro ?? null,
    digitado: r.digitado ?? null,
  });
}

rotas.get(MOTIVOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  return _tela_motivos(c, usuario, { mensagem: c.req.query("mensagem"), erro: c.req.query("erro") });
});

/**
 * Motivo novo. O código é caixa alta e não se edita depois: é citado no
 * relatório de recusas por motivo, e caixa mista viraria duas grafias.
 */
rotas.post(MOTIVOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const digitado = _campos(await formulario(c), ["codigo", "rotulo", "texto", "base_normativa", "exige_complemento"]);
  const recusar = (mensagem: string) => _tela_motivos(c, usuario, { erro: mensagem, digitado });

  const codigo_limpo = (digitado.codigo || "").trim().toUpperCase().replaceAll(" ", "_");
  // `str.isalnum()` do Python aceita letra acentuada; `\p{L}\p{N}` também
  if (!codigo_limpo || !/^[\p{L}\p{N}]+$/u.test(codigo_limpo.replaceAll("_", ""))) {
    return recusar("Código inválido: use letras maiúsculas, números e sublinhado " + "(VINCULO_NAO_ATENDIDO).");
  }
  const corpo = (digitado.texto || "").trim();
  if (!corpo) return recusar("O texto da recusa não pode ficar em branco.");
  const [ja] = await tx.select().from(epi_motivo_recusa).where(eq(epi_motivo_recusa.codigo, codigo_limpo));
  if (ja) return recusar(`Já existe o motivo ${codigo_limpo}.`);

  const [motivo] = await tx
    .insert(epi_motivo_recusa)
    .values({
      codigo: codigo_limpo,
      rotulo: (digitado.rotulo || "").trim() || codigo_limpo,
      // aspas retas viram curvas uma vez, aqui — nunca a cada render
      texto: textos.aspas_curvas(corpo),
      base_normativa: _texto(digitado.base_normativa),
      exige_complemento: _marcado(digitado.exige_complemento ?? ""),
      dispositivo_conferido_em: datas_br.hoje(),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "epi_motivo_recusa",
    entidade_id: motivo!.id,
    tipo_evento: "EPI_MOTIVO_RECUSA_CRIADO",
    descricao: `${motivo!.codigo} · ${motivo!.rotulo}`,
    usuario,
  });
  return _volta(c, MOTIVOS, `Motivo ${codigo_limpo} cadastrado.`);
});

/**
 * Editar o motivo NÃO reescreve a negativa que já saiu: o que a protege é
 * `epi_requisicao_item.texto_recusa_snapshot` (RN-27).
 */
rotas.post(`${MOTIVOS}/:motivo_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const corpo = f.texto("texto").trim();
  if (!corpo) return _erro(c, MOTIVOS, "O texto da recusa não pode ficar em branco.");
  return salvar_com_diff(
    c,
    usuario,
    epi_motivo_recusa,
    Number(c.req.param("motivo_id")),
    {
      rotulo: f.texto("rotulo").trim(),
      texto: textos.aspas_curvas(corpo),
      base_normativa: _texto(f.texto("base_normativa")),
      exige_complemento: _marcado(f.texto("exige_complemento")),
      ativo: _marcado(f.texto("ativo")),
      dispositivo_conferido_em: datas_br.hoje(),
    },
    { permissao: "epi.catalogo", rotulo: "Motivo de recusa", volta: MOTIVOS },
  );
});

// =====================================================================
// Edição do item — por último, pela mesma razão do Python (ordem de declaração)
// =====================================================================
/** Renomear é seguro para o que já saiu: a entrega congela nome, CA e lote (RN-15). */
rotas.post(`${CATALOGO}/:item_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const item_id = Number(c.req.param("item_id"));
  const f = await formulario(c);
  const [campos, erro] = _campos_do_item(_campos(f, CAMPOS_ITEM));
  if (campos === null) return _erro(c, CATALOGO, erro);
  const [categoria] = await tx.select().from(epi_categoria).where(eq(epi_categoria.id, campos.categoria_id));
  if (!categoria) return _erro(c, CATALOGO, "Categoria não encontrada.");
  if (await _homonimo(tx, campos.nome, campos.modelo, item_id)) {
    return _erro(c, CATALOGO, `Já existe outro item '${campos.nome}' com esse modelo.`);
  }
  campos.ativo = _marcado(f.texto("ativo"));
  return salvar_com_diff(c, usuario, epi_item, item_id, campos, {
    permissao: "epi.catalogo",
    rotulo: "Item de EPI",
    volta: CATALOGO,
  });
});
