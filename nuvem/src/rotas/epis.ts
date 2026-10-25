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
import { PermissaoNegada } from "../nucleo/erros.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import { epi_categoria, epi_item, epi_motivo_recusa } from "../db/esquema/index.js";
import {
  EPI_CATALOGO_IMAGEM_MAX_BYTES,
  EPI_CATALOGO_PDF_MAX_BYTES,
  EpiCategoria,
  EpiItem,
  UNIDADES_MEDIDA,
} from "../dominio/epi.js";
import * as anexos from "../servicos/anexos.js";
import * as auditoria from "../servicos/auditoria.js";
import * as catalogo_anexos from "../servicos/epi_catalogo_anexos.js";
import * as epi_treinamento from "../servicos/epi_treinamento.js";
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

/**
 * Os tamanhos, um por linha. O campo pede "um por linha", mas "P, M, G" é como
 * muita gente escreve (25/10/2026: virava UM tamanho chamado "P, M, G" e a
 * entrada de lote ficava sem opção). Separa também por ponto e vírgula e pela
 * vírgula entre palavras — não pela de número: a luva "8,5" é um tamanho só.
 */
export function tamanhos_digitados(bruto: string | null | undefined): string | null {
  const partes = (bruto ?? "")
    .split(/\r?\n|;|,\s+|(?<=\D),(?=\D)/)
    .map((t) => t.trim())
    .filter(Boolean);
  return partes.length ? [...new Set(partes)].join("\n") : null;
}

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
 * Lê o formulário e devolve `[campos, erro, campo]` — campos ou erro, nunca os
 * dois. `campo` é o `name` do campo que falhou: a tela o marca e põe o foco
 * nele (antes a marca ia sempre para o Nome, qualquer que fosse o erro).
 * Cadastro e edição passam pela MESMA conferência, e ela roda antes do banco
 * para a pessoa ler a regra e não o nome de uma constraint.
 */
export function _campos_do_item(f: Record<string, string>): [CamposItem | null, string, string] {
  const nome_limpo = (f.nome || "").trim();
  if (!nome_limpo) return [null, "O nome do EPI não pode ficar em branco.", "nome"];
  if (!/^\d+$/.test((f.categoria_id || "").trim())) return [null, "Escolha a categoria da NR-6.", "categoria_id"];

  const padrao = _inteiro(f.quantidade_padrao);
  if (padrao === null) return [null, "Quantidade padrão inválida: informe um número maior que zero.", "quantidade_padrao"];

  // O par (máxima, janela) anda junto: "2 por ano" é regra, "2" não é nada (RN-26)
  const maxima = _inteiro(f.quantidade_maxima);
  const janela = _inteiro(f.periodo_maximo_meses);
  const tem_maxima = Boolean((f.quantidade_maxima || "").trim());
  const tem_janela = Boolean((f.periodo_maximo_meses || "").trim());
  if (tem_maxima !== tem_janela) {
    return [
      null,
      "Quantidade máxima e período andam juntos: " + "'2 por 12 meses' é regra, '2' sozinho não quer dizer nada.",
      tem_maxima ? "periodo_maximo_meses" : "quantidade_maxima",
    ];
  }
  if (tem_maxima && (maxima === null || janela === null)) {
    return [null, "Quantidade máxima e período: informe números maiores que zero.", "quantidade_maxima"];
  }
  if (maxima !== null && maxima < padrao) return [null, "A quantidade máxima não pode ser menor que a padrão.", "quantidade_maxima"];

  const vida_util = _inteiro(f.vida_util_meses);
  if ((f.vida_util_meses || "").trim() && vida_util === null) {
    return [null, "Vida útil inválida: informe meses inteiros maiores que zero.", "vida_util_meses"];
  }

  // RN-25 nasce aqui: item que exige CA sem número é item que a entrega não sabe conferir
  const exige = _marcado(f.exige_ca ?? "");
  const ca = _texto(f.numero_ca);
  if (exige && !ca) {
    return [
      null,
      "Item que exige CA precisa do número do CA: " + "sem ele não há o que conferir na hora de entregar.",
      "numero_ca",
    ];
  }

  const validade = _data(f.validade_ca);
  if ((f.validade_ca || "").trim() && validade === null) return [null, "Data de validade do CA inválida.", "validade_ca"];

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
      tamanhos: tamanhos_digitados(f.tamanhos),
      vida_util_meses: vida_util,
      quantidade_padrao: padrao,
      quantidade_maxima: maxima,
      periodo_maximo_meses: janela,
      exige_justificativa: _marcado(f.exige_justificativa ?? ""),
      exige_treinamento: _marcado(f.exige_treinamento ?? ""),
    },
    "",
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
/** O item como o formulário o lê: tudo texto, caixa marcada é `"1"`. */
function _em_texto(i: typeof epi_item.$inferSelect): Record<string, string> {
  const texto = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const saida: Record<string, string> = {};
  for (const n of CAMPOS_ITEM) {
    const v = (i as Record<string, unknown>)[n];
    saida[n] = typeof v === "boolean" ? (v ? "1" : "") : texto(v);
  }
  saida["ativo"] = i.ativo ? "1" : "";
  return saida;
}

async function _tela_catalogo(
  c: Ctx,
  usuario: UsuarioAtual,
  r: {
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, string> | null;
    /** só este item: é o destino do link "corrigir o CA" da entrega recusada */
    item_id?: number | null;
    /** de qual popup veio a recusa: o id do item editado, ou nulo (o cadastro) */
    editando_id?: number | null;
    /** o campo que a recusa aponta (D21: a marca ia sempre para o Nome) */
    campo_erro?: string | null;
    /** fatia E: abre o popup de treinamentos deste item (e não o de edição) */
    abrir_treinamentos?: boolean;
    /** fatia C: abre o popup “Foto e orientação” deste item */
    abrir_arquivos?: boolean;
  } = {},
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
  // Fatia E: os treinamentos vinculados a cada item (uma consulta para o
  // catálogo inteiro) e, como o CA vencido, o aviso conta o catálogo inteiro:
  // item que exige treinamento sem nenhum vinculado é regra que não se confere
  const vinculos = await epi_treinamento.vinculados(
    tx,
    itens.map((i) => i.id),
  );
  const treinamentos_de = Object.fromEntries(itens.map((i) => [i.id, vinculos.get(i.id) ?? []]));
  const ids_vinculados_de = Object.fromEntries(itens.map((i) => [i.id, (vinculos.get(i.id) ?? []).map((t) => t.id)]));
  const exige_sem_vinculo = itens.filter((i) => i.exige_treinamento && i.ativo && !(vinculos.get(i.id) ?? []).length);
  const so_um = r.item_id ? itens.filter((i) => i.id === r.item_id) : null;
  const recorte = recortar(so_um ?? itens, numeroDaPagina(c));
  // cada item da página em TEXTO, na forma do digitado: o popup de editar é o
  // mesmo formulário do cadastro, e lê os dois do mesmo jeito
  const itens_em_texto = Object.fromEntries(recorte.itens.map((i) => [i.id, _em_texto(i)]));
  return pagina(c, "paginas/epis_catalogo.html", usuario, {
    so_um: so_um !== null,
    itens_em_texto,
    // fatia C: o limite escrito no formulário é o mesmo que o serviço confere
    limites_arquivo: {
      imagem: `${EPI_CATALOGO_IMAGEM_MAX_BYTES / 1024 / 1024} MB`,
      pdf: `${EPI_CATALOGO_PDF_MAX_BYTES / 1024 / 1024} MB`,
    },
    editando_id: r.editando_id ?? null,
    campo_erro: r.campo_erro ?? null,
    abas: ABAS,
    aba: CATALOGO,
    itens: recorte.itens,
    recorte,
    com_ca_vencido,
    treinamentos_de,
    ids_vinculados_de,
    exige_sem_vinculo,
    // a lista para escolher só interessa a quem pode vincular
    treinamentos_do_catalogo: usuario.pode("epi.catalogo") ? await epi_treinamento.treinamentos_do_catalogo(tx) : [],
    abrir_treinamentos: r.abrir_treinamentos ?? false,
    abrir_arquivos: r.abrir_arquivos ?? false,
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
  const item_id = c.req.query("item_id") ?? "";
  // `?treinamentos=<id>`: a volta do vincular/desvincular reabre o popup de
  // treinamentos daquele item, e não o de edição (que é o do `item_id`)
  const do_treinamento = c.req.query("treinamentos") ?? "";
  // `?arquivos=<id>`: a volta do envio da foto ou do PDF reabre o popup
  // “Foto e orientação” daquele item
  const dos_arquivos = c.req.query("arquivos") ?? "";
  const alvo = /^\d+$/.test(do_treinamento)
    ? do_treinamento
    : /^\d+$/.test(dos_arquivos)
      ? dos_arquivos
      : item_id;
  return _tela_catalogo(c, usuario, {
    mensagem: c.req.query("mensagem"),
    erro: c.req.query("erro"),
    item_id: /^\d+$/.test(alvo) ? Number(alvo) : null,
    abrir_treinamentos: /^\d+$/.test(do_treinamento),
    abrir_arquivos: !/^\d+$/.test(do_treinamento) && /^\d+$/.test(dos_arquivos),
  });
});

rotas.post(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const digitado = _campos(await formulario(c), CAMPOS_ITEM);
  // Renderiza a tela de novo com o popup reaberto e o digitado — nunca redireciona
  const recusar = (mensagem: string, campo_erro: string | null = null) =>
    _tela_catalogo(c, usuario, { erro: mensagem, digitado, campo_erro });

  const [campos, erro, campo] = _campos_do_item(digitado);
  if (campos === null) return recusar(erro, campo);
  const [categoria] = await tx.select().from(epi_categoria).where(eq(epi_categoria.id, campos.categoria_id));
  if (!categoria) return recusar("Categoria não encontrada.", "categoria_id");
  if (await _homonimo(tx, campos.nome, campos.modelo)) {
    return recusar(
      `Já existe '${campos.nome}' com esse modelo. ` + "Para cadastrar outro, informe o modelo que os distingue.",
      "modelo",
    );
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
async function _tela_categorias(
  c: Ctx,
  usuario: UsuarioAtual,
  r: {
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, string> | null;
    /** de qual popup veio a recusa: o id da categoria editada */
    editando_id?: number | null;
  } = {},
): Promise<Response> {
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
    editando_id: r.editando_id ?? null,
    mensagem: r.mensagem ?? null,
    erro: r.erro ?? null,
    digitado: r.digitado ?? null,
  });
}

rotas.get(CATEGORIAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  return _tela_categorias(c, usuario, { mensagem: c.req.query("mensagem"), erro: c.req.query("erro") });
});

/**
 * Só o rótulo, a referência e a ordem. Não há cadastro de categoria nova: a
 * lista é o Anexo I da NR-6, e criar a décima pela tela seria inventar norma.
 */
rotas.post(`${CATEGORIAS}/:categoria_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão antes de ler o formulário: quem não pode editar não recebe
  // "preencha o campo" (o `salvar_com_diff` confere de novo)
  usuario.exigir("epi.catalogo");
  const f = await formulario(c);
  const categoria_id = Number(c.req.param("categoria_id"));
  const digitado: Record<string, string> = {
    ..._campos(f, ["nome", "referencia_nr6", "ordem"]),
    ativo: f.texto("ativo", ""),
  };
  // A recusa reabre o popup DESTA categoria com o digitado, como no catálogo de
  // itens: voltar para a lista com a faixa vermelha perdia o que foi escrito.
  const recusar = (mensagem: string) =>
    _tela_categorias(c, usuario, { erro: mensagem, digitado, editando_id: categoria_id });
  const nome = (digitado.nome || "").trim();
  // o `required` do campo segura o navegador; isto segura quem posta sem ele —
  // categoria sem nome sairia em branco no formulário do item e na ficha
  if (!nome) return recusar("O nome da categoria não pode ficar em branco.");
  const numero = _inteiro(f.texto("ordem", "1"));
  return salvar_com_diff(
    c,
    usuario,
    epi_categoria,
    categoria_id,
    {
      nome,
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
  r: {
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, string> | null;
    /** de qual popup veio a recusa: o id do motivo editado, ou nulo (o cadastro) */
    editando_id?: number | null;
  } = {},
): Promise<Response> {
  const itens = await c.get("tx").select().from(epi_motivo_recusa).orderBy(asc(epi_motivo_recusa.codigo));
  return pagina(c, "paginas/epis_motivos.html", usuario, {
    abas: ABAS,
    aba: MOTIVOS,
    itens,
    editando_id: r.editando_id ?? null,
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
  usuario.exigir("epi.catalogo");
  const f = await formulario(c);
  const motivo_id = Number(c.req.param("motivo_id"));
  const digitado = _campos(f, ["rotulo", "texto", "base_normativa", "exige_complemento", "ativo"]);
  // A recusa reabre o popup DESTE motivo com o digitado — antes voltava para a
  // lista com a faixa vermelha, e o texto da negativa escrito se perdia.
  const recusar = (mensagem: string) =>
    _tela_motivos(c, usuario, { erro: mensagem, digitado, editando_id: motivo_id });
  const corpo = f.texto("texto").trim();
  if (!corpo) return recusar("O texto da recusa não pode ficar em branco.");
  const rotulo = f.texto("rotulo").trim();
  // o `required` do campo segura o navegador; isto segura quem posta sem ele —
  // motivo sem rótulo sairia em branco na lista e no "Editar · " do popup
  if (!rotulo) return recusar("O rótulo do motivo não pode ficar em branco.");
  return salvar_com_diff(
    c,
    usuario,
    epi_motivo_recusa,
    motivo_id,
    {
      rotulo,
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
// Foto e PDF de orientação do item (fatia C da paridade com o IntegraSST)
// =====================================================================
/** O arquivo do formulário, já em bytes — ou `null` quando não veio. */
async function _arquivo(f: Formulario, nome: string): Promise<catalogo_anexos.ArquivoEnviado | null> {
  const arquivo = f.arquivo(nome);
  if (!arquivo) return null;
  return { conteudo: new Uint8Array(await arquivo.arrayBuffer()), nome_original: arquivo.name || nome };
}

/** O outro campo de arquivo — o que NÃO pode vir junto. */
const _OUTRO: Record<catalogo_anexos.QualArquivo, catalogo_anexos.QualArquivo> = {
  imagem: "orientacao",
  orientacao: "imagem",
};
const _NOME_ARQUIVO: Record<catalogo_anexos.QualArquivo, string> = {
  imagem: "a foto",
  orientacao: "o PDF de orientação",
};

/**
 * Um envio = UM arquivo (a função do Netlify recusa corpo acima de 6 MB, e a
 * foto de 2 MB mais o PDF de 4 MB passavam disso). A foto vai por
 * `POST /epis/catalogo/{id}/imagem` e o PDF por `.../orientacao` — o mesmo
 * endereço que os SERVE no GET. Veio o outro campo junto: recusa, sem gravar
 * nenhum dos dois. Veio vazio: o atual continua.
 */
async function _receber_arquivo(c: Ctx, qual: catalogo_anexos.QualArquivo): Promise<Response> {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const item = await _item(tx, c.req.param("item_id") ?? "");
  if (!item) return redirecionar(c, comMensagem(CATALOGO, "Item de EPI não encontrado.", "erro"));
  const destino = `${CATALOGO}?arquivos=${item.id}`;
  const f = await formulario(c);
  const outro = _OUTRO[qual];
  if (f.arquivo(outro)) {
    return redirecionar(
      c,
      comMensagem(
        destino,
        `Envie um arquivo por vez: este botão grava só ${_NOME_ARQUIVO[qual]}, e veio também ${_NOME_ARQUIVO[outro]}. ` +
          "Nada foi gravado — use o botão de cada um.",
        "erro",
      ),
    );
  }
  const arquivo = await _arquivo(f, qual);
  if (!arquivo) {
    return _volta(
      c,
      destino,
      qual === "imagem"
        ? "Nenhuma foto nova escolhida: a foto atual continua."
        : "Nenhum PDF novo escolhido: o PDF de orientação atual continua.",
    );
  }
  const tinha = qual === "imagem" ? item.imagem_anexo_id : item.orientacao_anexo_id;
  try {
    await tx.transaction(async (sp) => catalogo_anexos.enviar(sp, usuario, item, qual, arquivo));
  } catch (falha) {
    if (falha instanceof catalogo_anexos.ArquivoDoCatalogoRecusado || falha instanceof anexos.AnexoGrandeDemais) {
      return redirecionar(c, comMensagem(destino, falha.message, "erro"));
    }
    throw falha;
  }
  const o_que = qual === "imagem" ? "Foto" : "PDF de orientação";
  return _volta(
    c,
    destino,
    `${o_que} de '${item.nome}' gravado.` + (tinha === null ? "" : " O arquivo anterior continua guardado."),
  );
}

async function _item(tx: Executor, bruto: string): Promise<typeof epi_item.$inferSelect | null> {
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, Number(bruto)));
  return item ?? null;
}

// =====================================================================
// Treinamento exigido pelo item (fatia E da paridade com o IntegraSST)
// =====================================================================
/**
 * Vincula ou desvincula um treinamento do catálogo de Certificados ao item. Um
 * formulário por ato (`acao` = vincular | desvincular), com auditoria no
 * serviço. Vincular a item que não exigia treinamento passa a exigir.
 */
rotas.post(`${CATALOGO}/:item_id{[0-9]+}/treinamentos`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.catalogo");
  const tx = c.get("tx");
  const item = await _item(tx, c.req.param("item_id"));
  if (!item) return redirecionar(c, comMensagem(CATALOGO, "Item de EPI não encontrado.", "erro"));
  const destino = `${CATALOGO}?treinamentos=${item.id}`;
  const f = await formulario(c);
  const acao = f.texto("acao", "").trim();
  const treinamento_id = _inteiro(f.texto("treinamento_id", ""));
  if (treinamento_id === null) return redirecionar(c, comMensagem(destino, "Escolha o treinamento.", "erro"));
  if (acao !== "vincular" && acao !== "desvincular") {
    return redirecionar(c, comMensagem(destino, "Ação desconhecida.", "erro"));
  }
  try {
    const recado = await tx.transaction(async (sp) => {
      if (acao === "vincular") {
        const r = await epi_treinamento.vincular(sp, usuario, item, treinamento_id);
        return (
          `'${item.nome}' passa a exigir ${r.treinamento.nome}.` +
          (r.passou_a_exigir ? " O item foi marcado como “exige treinamento”." : "")
        );
      }
      const r = await epi_treinamento.desvincular(sp, usuario, item, treinamento_id);
      return (
        `'${item.nome}' deixa de exigir ${r.treinamento.nome}.` +
        (r.restam === 0 && item.exige_treinamento
          ? " Nenhum treinamento vinculado: o item continua marcado como “exige treinamento”, e a entrega não tem o que conferir."
          : "")
      );
    });
    return _volta(c, destino, recado);
  } catch (falha) {
    if (falha instanceof epi_treinamento.VinculoRecusado) return redirecionar(c, comMensagem(destino, falha.message, "erro"));
    throw falha;
  }
});

rotas.post(`${CATALOGO}/:item_id{[0-9]+}/imagem`, (c) => _receber_arquivo(c, "imagem"));
rotas.post(`${CATALOGO}/:item_id{[0-9]+}/orientacao`, (c) => _receber_arquivo(c, "orientacao"));

/**
 * A foto e o PDF vigentes do item. Atrás do login, e não por link público
 * como no legado (Drive "qualquer pessoa com o link"). Lê quem tem `epi.ver`,
 * quem pede EPI e o titular de uma ficha.
 */
async function _servir(c: Ctx, qual: "imagem" | "orientacao"): Promise<Response> {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  if (!(await catalogo_anexos.pode_ler(tx, usuario))) {
    throw new PermissaoNegada("epi.ver", "A foto e a orientação do catálogo de EPI são para quem usa o módulo de EPI.");
  }
  const item = await _item(tx, c.req.param("item_id") ?? "");
  const anexo = item ? await catalogo_anexos.anexo_vigente(tx, item, qual) : null;
  if (!anexo) return c.text(qual === "imagem" ? "Este item não tem foto." : "Este item não tem PDF de orientação.", 404);
  const conteudo = await anexos.ler_conteudo(anexo);
  return c.body(conteudo as unknown as ArrayBuffer, 200, {
    "content-type": anexos.tipo_para_servir(anexo.mime_type),
    "x-content-type-options": "nosniff",
    // a URL da tela leva `?v=<anexo>`: trocar a foto troca o endereço
    "cache-control": "private, max-age=3600",
    "content-disposition": disposicao(anexo.nome_original, qual === "imagem" ? "inline" : "attachment"),
  });
}

/** `Content-Disposition` com o nome em RFC 5987. */
export function disposicao(nome: string, modo: "inline" | "attachment" = "attachment"): string {
  const ascii = /^[\x20-\x7e]*$/.test(nome) && !nome.includes('"');
  return ascii ? `${modo}; filename="${nome}"` : `${modo}; filename*=utf-8''${encodeURIComponent(nome)}`;
}

rotas.get(`${CATALOGO}/:item_id{[0-9]+}/imagem`, (c) => _servir(c, "imagem"));
rotas.get(`${CATALOGO}/:item_id{[0-9]+}/orientacao`, (c) => _servir(c, "orientacao"));

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
  const digitado = { ..._campos(f, CAMPOS_ITEM), ativo: f.texto("ativo", "") };
  // A recusa reabre o popup DESTE item com o digitado e o campo marcado —
  // antes voltava para a lista com a faixa vermelha, e o que foi escrito no
  // popup se perdia.
  const recusar = (mensagem: string, campo_erro: string | null = null) =>
    _tela_catalogo(c, usuario, { erro: mensagem, digitado, editando_id: item_id, campo_erro });
  const [campos, erro, campo] = _campos_do_item(digitado);
  if (campos === null) return recusar(erro, campo);
  const [categoria] = await tx.select().from(epi_categoria).where(eq(epi_categoria.id, campos.categoria_id));
  if (!categoria) return recusar("Categoria não encontrada.", "categoria_id");
  if (await _homonimo(tx, campos.nome, campos.modelo, item_id)) {
    return recusar(`Já existe outro item '${campos.nome}' com esse modelo.`, "modelo");
  }
  campos.ativo = _marcado(f.texto("ativo"));
  // A edição é formulário comum, sem arquivo: foto e PDF têm envios próprios
  // (`/imagem`, `/orientacao`), um arquivo por requisição. Arquivo que chegue
  // aqui (página antiga aberta, envio montado à mão) é RECUSADO, e não
  // ignorado: ignorar calado faria a pessoa achar que a foto foi trocada. O
  // popup volta com o digitado, e nada é gravado.
  if (f.arquivo("imagem") || f.arquivo("orientacao")) {
    return recusar(
      "A edição do item não recebe arquivo. Nada foi gravado: salve os dados sem o arquivo " +
        "e envie a foto ou o PDF pelo botão “Foto e orientação” da linha do item.",
    );
  }
  return salvar_com_diff(c, usuario, epi_item, item_id, campos, {
    permissao: "epi.catalogo",
    rotulo: "Item de EPI",
    volta: CATALOGO,
  });
});
