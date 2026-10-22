/**
 * /laudos — laudo técnico. Sem data de validade (IN 15/2022, art. 10, §3º).
 * Porte de `app/rotas/laudos.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioCom } from "../dependencias.js";
import { comMensagem, numeroDaPagina, pagina, recortar, redirecionar, salvar_com_diff } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  laudo_posto,
  laudo_tecnico,
  parecer_tecnico,
  posto_trabalho,
  tipo_adicional,
  unidade_uorg,
} from "../db/esquema/index.js";
import * as auditoria from "../servicos/auditoria.js";
import * as datas_br from "../servicos/datas_br.js";
import * as servico_parecer from "../servicos/parecer.js";
import type { UsuarioAtual } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

export const RODAPE_FILA =
  "o laudo não tem prazo de validade (IN 15/2022, art. 10, §3º); esta lista é " +
  "apenas fila de trabalho, não vencimento.";

export const SITUACOES_LAUDO: readonly (readonly [string, string])[] = [
  ["VIGENTE", "Vigentes"],
  ["SUPERADO", "Superados"],
];

function _id(c: Ctx): number {
  const v = c.req.param("laudo_id");
  if (!v || !/^\d+$/.test(v)) throw new ErroHttp(422, "Parâmetro inválido: laudo_id");
  return Number(v);
}

/**
 * O laudo do caminho, ou 404 — ANTES de qualquer gravação. Sem isto a
 * conferência de um laudo inexistente respondia "Conferência registrada." (o
 * UPDATE não achava linha e ninguém olhava) e o vínculo de posto dava 500 na
 * chave estrangeira.
 */
async function _laudo_ou_404(c: Ctx) {
  const [laudo] = await c.get("tx").select().from(laudo_tecnico).where(eq(laudo_tecnico.id, _id(c)));
  if (!laudo) throw new ErroHttp(404, "Laudo não encontrado.");
  return laudo;
}

/**
 * A data do formulário que é FATO OCORRIDO (emissão, avaliação): data real e
 * nunca depois de hoje. Laudo "emitido em 05/05/2031" entrava vigente e ia para
 * a fila de conferência. Devolve `[data, null]` ou `[null, recusa]`.
 */
function _data_ocorrida(texto: string, rotulo: string): [string | null, string | null] {
  try {
    const data = datas_br.ler_data_formulario(texto, rotulo);
    if (data !== null) datas_br.exigir_ate_hoje(data, rotulo);
    return [data, null];
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return [null, erro.message];
  }
}

/**
 * Quem pode subscrever laudo HOJE: habilitação vigente (IN 15/2022, art. 10,
 * §2º, I). É a lista do cadastro e a conferência da gravação — a mesma função.
 */
const _subscritores_vigentes = (c: Ctx) => servico_parecer.habilitados_vigentes(c.get("tx"));

/**
 * A fila, com o popup de cadastro em branco ou com o que foi digitado.
 * `digitado` não entra na URL, e por isso a recusa renderiza a própria tela em
 * vez de redirecionar.
 */
async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  situacao = "",
  q = "",
  o: { erro?: string | null; digitado?: Record<string, unknown> } = {},
) {
  const tx = c.get("tx");
  const todos = await tx.query.laudo_tecnico.findMany({
    with: { unidade: true, subscritor: true, tipo_adicional: true },
    orderBy: [desc(laudo_tecnico.numero_siape)],
  });
  const resumo: Record<string, number> = {};
  for (const [codigo] of SITUACOES_LAUDO) resumo[codigo] = 0;
  for (const laudo of todos) resumo[laudo.status] = (resumo[laudo.status] ?? 0) + 1;

  const busca = q.trim().toLowerCase();
  const laudos = todos.filter(
    (laudo) =>
      (!situacao || laudo.status === situacao) &&
      (!busca ||
        laudo.numero_siape.toLowerCase().includes(busca) ||
        (laudo.unidade !== null && laudo.unidade.nome_extenso.toLowerCase().includes(busca)) ||
        (laudo.subscritor !== null && laudo.subscritor.nome.toLowerCase().includes(busca))),
  );
  // O recorte entra ANTES do laço de `derivados`: aquele laço é uma consulta
  // por laudo, e paginando primeiro são 50, não 200.
  const recorte = recortar(laudos, numeroDaPagina(c));
  const derivados: Record<number, unknown[]> = {};
  for (const laudo of recorte.itens) {
    derivados[laudo.id] = await tx.select().from(parecer_tecnico).where(eq(parecer_tecnico.laudo_id, laudo.id));
  }
  return pagina(c, "paginas/laudos.html", usuario, {
    laudos: recorte.itens,
    recorte,
    derivados,
    situacoes: SITUACOES_LAUDO,
    filtro_situacao: situacao,
    resumo: dicionario(resumo),
    total: todos.length,
    q,
    unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
    tipos: await tx.select().from(tipo_adicional).orderBy(asc(tipo_adicional.id)),
    // só quem tem habilitação vigente: subscritor vencido no cadastro produzia
    // laudo que nenhum parecer consegue sustentar
    subscritores: (await _subscritores_vigentes(c)).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
    hoje: datas_br.hoje(),
    rodape_fila: RODAPE_FILA,
    erro: o.erro ?? null,
    digitado: dicionario(o.digitado ?? {}),
  });
}

/**
 * A fila dos laudos. A contagem das fichas sai da lista COMPLETA, e não da
 * filtrada: "Superados (0)" só porque o filtro excluiu os superados não
 * informaria nada.
 */
rotas.get("/laudos", async (c) => {
  const usuario = await usuarioCom(c, "laudo.ver");
  return _tela_lista(c, usuario, c.req.query("situacao") ?? "", c.req.query("q") ?? "");
});

rotas.post("/laudos", async (c) => {
  const usuario = await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const tipo_adicional_id = f.inteiro("tipo_adicional_id");
  const unidade_uorg_id = f.inteiro("unidade_uorg_id");
  if (!f.tem("numero_siape") || tipo_adicional_id === null || unidade_uorg_id === null) {
    throw new ErroHttp(422, "Campo obrigatório ausente: número do laudo, tipo de adicional ou unidade.");
  }
  const numero_siape = f.texto("numero_siape").trim();
  const subscritor_id = f.texto("subscritor_id");
  const data_emissao = f.texto("data_emissao");
  const coletivo = f.texto("coletivo");
  // Tudo o que foi digitado, guardado antes da primeira recusa.
  const digitado = { numero_siape, tipo_adicional_id, unidade_uorg_id, subscritor_id, data_emissao, coletivo };
  const recusar = (erro: string) => _tela_lista(c, usuario, "", "", { erro, digitado });
  if (!/^\d{5}-\d{3}\.\d{3}\/\d{4}$/.test(numero_siape)) {
    return recusar("Número de laudo inválido — o formato do laudo SIAPE é 26255-000.125/2019.");
  }
  // Antes do INSERT, e não pela violação da UNIQUE: a violação era a página de
  // erro 500 (e queimava um id da sequência), sem o que foi digitado.
  const [repetido] = await tx
    .select({ id: laudo_tecnico.id })
    .from(laudo_tecnico)
    .where(eq(laudo_tecnico.numero_siape, numero_siape));
  if (repetido) return recusar("Já existe laudo com este número.");
  const ano = Number(numero_siape.slice(-4));
  if (ano > Number(datas_br.hoje().slice(0, 4))) {
    return recusar(`O ano do número do laudo (${ano}) ainda não chegou — confira o número.`);
  }
  const [emissao, recusa_data] = _data_ocorrida(data_emissao, "Data de emissão");
  if (recusa_data) return recusar(recusa_data);
  // O subscritor é obrigatório e tem de estar habilitado hoje: é ele que dá ao
  // laudo a validade técnica (IN 15/2022, art. 10, §2º, I).
  const vigentes = await _subscritores_vigentes(c);
  const subscritor = /^\d+$/.test(subscritor_id) ? vigentes.find((h) => h.id === Number(subscritor_id)) : undefined;
  if (!subscritor) return recusar("Escolha o subscritor do laudo entre os profissionais com habilitação vigente.");
  const [tipo] = await tx.select({ id: tipo_adicional.id }).from(tipo_adicional).where(eq(tipo_adicional.id, tipo_adicional_id));
  if (!tipo) return recusar("Tipo de adicional inválido: escolha um da lista.");
  const [unidade] = await tx.select({ id: unidade_uorg.id }).from(unidade_uorg).where(eq(unidade_uorg.id, unidade_uorg_id));
  if (!unidade) return recusar("Unidade inválida: escolha uma da lista.");
  const [laudo] = await tx
    .insert(laudo_tecnico)
    .values({
      numero_siape,
      ano,
      tipo_adicional_id,
      unidade_uorg_id,
      subscritor_id: subscritor.id,
      data_emissao: emissao,
      coletivo: coletivo === "1",
    })
    .returning();
  return redirecionar(c, `/laudos/${laudo!.id}`);
});

rotas.get("/laudos/:laudo_id{[0-9]+}", async (c) => {
  const usuario = await usuarioCom(c, "laudo.ver");
  const tx = c.get("tx");
  const laudo = await tx.query.laudo_tecnico.findFirst({
    where: eq(laudo_tecnico.id, _id(c)),
    with: {
      unidade: true,
      tipo_adicional: true,
      subscritor: true,
      postos: { with: { posto: { with: { unidade: true } } } },
    },
  });
  if (!laudo) return redirecionar(c, "/laudos");
  const derivados = await tx.query.parecer_tecnico.findMany({
    where: eq(parecer_tecnico.laudo_id, laudo.id),
    with: { servidor: true },
    orderBy: [asc(parecer_tecnico.id)],
  });
  const vigentes = await _subscritores_vigentes(c);
  const meses = laudo.data_ultima_conferencia
    ? datas_br.meses_entre(laudo.data_ultima_conferencia, datas_br.hoje())
    : null;
  return pagina(c, "paginas/laudo_ficha.html", usuario, {
    laudo,
    derivados,
    meses_desde_conferencia: meses,
    postos: await tx.query.posto_trabalho.findMany({ with: { unidade: true }, orderBy: [asc(posto_trabalho.nome)] }),
    // o subscritor atual entra na lista mesmo com a habilitação vencida: editar
    // a data do laudo não pode obrigar a trocar quem o assinou
    subscritores: [
      ...vigentes,
      ...(laudo.subscritor && !vigentes.some((h) => h.id === laudo.subscritor_id) ? [laudo.subscritor] : []),
    ].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
    hoje: datas_br.hoje(),
    rodape_fila: RODAPE_FILA,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/**
 * Os dados que o cadastro não pede e a ficha mostrava como "—" sem ter onde
 * preencher: emissão, avaliação, subscritor e o nº do documento SEI. Grava e
 * audita campo a campo (`salvar_com_diff`), como todo catálogo. Número, tipo e
 * unidade NÃO se editam: são a identidade do laudo, e corrigi-los é laudo novo
 * que supera este.
 */
rotas.post("/laudos/:laudo_id{[0-9]+}/editar", async (c) => {
  const usuario = await usuarioCom(c, "laudo.criar");
  const laudo = await _laudo_ou_404(c);
  const f = await formulario(c);
  const volta = `/laudos/${laudo.id}`;
  const recusar = (erro: string) => redirecionar(c, comMensagem(volta, erro, "erro"));
  const [emissao, recusa_emissao] = _data_ocorrida(f.texto("data_emissao"), "Data de emissão");
  if (recusa_emissao) return recusar(recusa_emissao);
  const [avaliacao, recusa_avaliacao] = _data_ocorrida(f.texto("data_avaliacao"), "Data da avaliação");
  if (recusa_avaliacao) return recusar(recusa_avaliacao);
  if (emissao && avaliacao && avaliacao > emissao) {
    return recusar("A avaliação do ambiente vem antes da emissão do laudo: confira as duas datas.");
  }
  const bruto = f.texto("subscritor_id");
  let subscritor_id = laudo.subscritor_id;
  if (bruto && Number(bruto) !== laudo.subscritor_id) {
    // trocar de subscritor só para quem está habilitado hoje; manter o atual
    // continua valendo mesmo que a habilitação dele tenha vencido depois
    const novo = /^\d+$/.test(bruto) ? (await _subscritores_vigentes(c)).find((h) => h.id === Number(bruto)) : undefined;
    if (!novo) return recusar("Escolha o subscritor do laudo entre os profissionais com habilitação vigente.");
    subscritor_id = novo.id;
  }
  if (!subscritor_id) return recusar("O laudo precisa de subscritor habilitado.");
  const sei = f.texto("numero_documento_sei").trim();
  if (sei && !/^\d{1,10}$/.test(sei)) {
    return recusar("Nº do documento SEI: só os dígitos do número do documento, até 10.");
  }
  return salvar_com_diff(
    c,
    usuario,
    laudo_tecnico,
    laudo.id,
    { data_emissao: emissao, data_avaliacao: avaliacao, subscritor_id, numero_documento_sei: sei || null },
    { permissao: "laudo.criar", rotulo: "Laudo", volta },
  );
});

rotas.post("/laudos/:laudo_id{[0-9]+}/postos", async (c) => {
  const usuario = await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo = await _laudo_ou_404(c);
  const posto_trabalho_id = (await formulario(c)).inteiro("posto_trabalho_id");
  if (posto_trabalho_id === null) throw new ErroHttp(422, "Escolha o posto de trabalho.");
  const [posto] = await tx.select().from(posto_trabalho).where(eq(posto_trabalho.id, posto_trabalho_id));
  if (!posto) return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Posto inválido: escolha um da lista.", "erro"));
  const [ja] = await tx
    .select()
    .from(laudo_posto)
    .where(and(eq(laudo_posto.laudo_id, laudo.id), eq(laudo_posto.posto_trabalho_id, posto_trabalho_id)));
  if (ja) return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Este posto já está vinculado ao laudo."));
  await tx.insert(laudo_posto).values({ laudo_id: laudo.id, posto_trabalho_id });
  await auditoria.registrar(tx, {
    entidade: "laudo_tecnico",
    entidade_id: laudo.id,
    tipo_evento: "LAUDO_POSTO_VINCULADO",
    descricao: `Posto ${posto.nome} vinculado ao laudo ${laudo.numero_siape}.`,
    usuario,
  });
  return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Posto vinculado."));
});

/**
 * O par do vínculo, que faltava: posto vinculado por engano só saía por SQL.
 * Pede confirmação na tela (a camada diz o que muda); aqui só se confere e se
 * registra na trilha, porque o posto é o que liga o laudo a quem trabalha nele.
 */
rotas.post("/laudos/:laudo_id{[0-9]+}/postos/:posto_id{[0-9]+}/desvincular", async (c) => {
  const usuario = await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo = await _laudo_ou_404(c);
  const posto_id = Number(c.req.param("posto_id"));
  const [vinculo] = await tx
    .select()
    .from(laudo_posto)
    .where(and(eq(laudo_posto.laudo_id, laudo.id), eq(laudo_posto.posto_trabalho_id, posto_id)));
  if (!vinculo) return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Este posto não estava vinculado ao laudo.", "erro"));
  const [posto] = await tx.select().from(posto_trabalho).where(eq(posto_trabalho.id, posto_id));
  await tx.delete(laudo_posto).where(and(eq(laudo_posto.laudo_id, laudo.id), eq(laudo_posto.posto_trabalho_id, posto_id)));
  await auditoria.registrar(tx, {
    entidade: "laudo_tecnico",
    entidade_id: laudo.id,
    tipo_evento: "LAUDO_POSTO_DESVINCULADO",
    descricao: `Posto ${posto ? posto.nome : `nº ${posto_id}`} desvinculado do laudo ${laudo.numero_siape}.`,
    usuario,
  });
  return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Posto desvinculado."));
});

rotas.post("/laudos/:laudo_id{[0-9]+}/conferencia", async (c) => {
  await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo = await _laudo_ou_404(c);
  const f = await formulario(c);
  if (!f.texto("motivo").trim()) {
    return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Escreva o motivo da conferência.", "erro"));
  }
  await tx
    .update(laudo_tecnico)
    .set({ data_ultima_conferencia: datas_br.hoje(), motivo_ultima_conferencia: f.texto("motivo").trim() })
    .where(eq(laudo_tecnico.id, laudo.id));
  return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Conferência registrada."));
});

rotas.post("/laudos/:laudo_id{[0-9]+}/superar", async (c) => {
  // a permissão na primeira linha: a recusa é 403 antes de ler o formulário
  // (o serviço confere de novo, porque é ele a regra)
  const usuario = await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo = await _laudo_ou_404(c);
  const f = await formulario(c);
  if (!f.texto("motivo").trim()) {
    return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Escreva o motivo da superação.", "erro"));
  }
  if (laudo.status !== "VIGENTE") {
    return redirecionar(c, comMensagem(`/laudos/${laudo.id}`, "Este laudo já estava superado."));
  }
  // A caixa de ciência da camada vale também aqui: `required` no HTML é
  // conforto, e quem posta direto não pode mandar pareceres para reavaliação
  // sem a confirmação que a tela pede.
  const [derivado] = await tx
    .select({ id: parecer_tecnico.id })
    .from(parecer_tecnico)
    .where(eq(parecer_tecnico.laudo_id, laudo.id))
    .limit(1);
  if (derivado && f.texto("ciente") !== "1") {
    return redirecionar(
      c,
      comMensagem(`/laudos/${laudo.id}`, "Marque a caixa de ciência: os pareceres deste laudo vão para reavaliação.", "erro"),
    );
  }
  const substituto_id = f.texto("substituto_id");
  const [substituto] = /^\d+$/.test(substituto_id)
    ? await tx.select().from(laudo_tecnico).where(eq(laudo_tecnico.id, Number(substituto_id)))
    : [];
  const derivados = await servico_parecer.marcar_laudo_superado(tx, laudo, usuario, f.texto("motivo").trim(), substituto ?? null);
  return redirecionar(
    c,
    comMensagem(`/laudos/${laudo.id}`, `Laudo superado; ${derivados.length} parecer(es) em reavaliação.`),
  );
});
