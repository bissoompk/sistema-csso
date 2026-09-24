/**
 * /laudos — laudo técnico. Sem data de validade (IN 15/2022, art. 10, §3º).
 * Porte de `app/rotas/laudos.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioCom, usuarioLogado } from "../dependencias.js";
import { numeroDaPagina, pagina, recortar, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  laudo_posto,
  laudo_tecnico,
  parecer_tecnico,
  posto_trabalho,
  profissional_habilitado,
  tipo_adicional,
  unidade_uorg,
} from "../db/esquema/index.js";
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
    subscritores: await tx.select().from(profissional_habilitado).orderBy(asc(profissional_habilitado.id)),
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
    throw new ErroHttp(422, "Campo obrigatório ausente: numero_siape, tipo_adicional_id, unidade_uorg_id");
  }
  const numero_siape = f.texto("numero_siape");
  const subscritor_id = f.texto("subscritor_id");
  const data_emissao = f.texto("data_emissao");
  const coletivo = f.texto("coletivo");
  // Tudo o que foi digitado, guardado antes da primeira recusa.
  const digitado = { numero_siape, tipo_adicional_id, unidade_uorg_id, subscritor_id, data_emissao, coletivo };
  if (!/^\d{5}-\d{3}\.\d{3}\/\d{4}$/.test(numero_siape.trim())) {
    return _tela_lista(c, usuario, "", "", {
      erro: "Número de laudo inválido — o formato do laudo SIAPE é 26255-000.125/2019.",
      digitado,
    });
  }
  const [laudo] = await tx
    .insert(laudo_tecnico)
    .values({
      numero_siape: numero_siape.trim(),
      ano: Number(numero_siape.trim().slice(-4)),
      tipo_adicional_id,
      unidade_uorg_id,
      subscritor_id: subscritor_id ? Number(subscritor_id) : null,
      data_emissao: data_emissao || null,
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
  const meses = laudo.data_ultima_conferencia
    ? datas_br.meses_entre(laudo.data_ultima_conferencia, datas_br.hoje())
    : null;
  return pagina(c, "paginas/laudo_ficha.html", usuario, {
    laudo,
    derivados,
    meses_desde_conferencia: meses,
    postos: await tx.query.posto_trabalho.findMany({ with: { unidade: true }, orderBy: [asc(posto_trabalho.nome)] }),
    rodape_fila: RODAPE_FILA,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

rotas.post("/laudos/:laudo_id{[0-9]+}/postos", async (c) => {
  await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo_id = _id(c);
  const posto_trabalho_id = (await formulario(c)).inteiro("posto_trabalho_id");
  if (posto_trabalho_id === null) throw new ErroHttp(422, "Campo obrigatório ausente: posto_trabalho_id");
  const [ja] = await tx
    .select()
    .from(laudo_posto)
    .where(and(eq(laudo_posto.laudo_id, laudo_id), eq(laudo_posto.posto_trabalho_id, posto_trabalho_id)));
  if (!ja) await tx.insert(laudo_posto).values({ laudo_id, posto_trabalho_id });
  return redirecionar(c, `/laudos/${laudo_id}`);
});

rotas.post("/laudos/:laudo_id{[0-9]+}/conferencia", async (c) => {
  await usuarioCom(c, "laudo.criar");
  const tx = c.get("tx");
  const laudo_id = _id(c);
  const f = await formulario(c);
  if (!f.tem("motivo")) throw new ErroHttp(422, "Campo obrigatório ausente: motivo");
  await tx
    .update(laudo_tecnico)
    .set({ data_ultima_conferencia: datas_br.hoje(), motivo_ultima_conferencia: f.texto("motivo") })
    .where(eq(laudo_tecnico.id, laudo_id));
  return redirecionar(c, `/laudos/${laudo_id}?mensagem=${encodeURIComponent("Conferência registrada.")}`);
});

rotas.post("/laudos/:laudo_id{[0-9]+}/superar", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const laudo_id = _id(c);
  const f = await formulario(c);
  if (!f.tem("motivo")) throw new ErroHttp(422, "Campo obrigatório ausente: motivo");
  const [laudo] = await tx.select().from(laudo_tecnico).where(eq(laudo_tecnico.id, laudo_id));
  if (!laudo) return redirecionar(c, "/laudos");
  const substituto_id = f.texto("substituto_id");
  const [substituto] = substituto_id
    ? await tx.select().from(laudo_tecnico).where(eq(laudo_tecnico.id, Number(substituto_id)))
    : [];
  const derivados = await servico_parecer.marcar_laudo_superado(tx, laudo, usuario, f.texto("motivo"), substituto ?? null);
  return redirecionar(
    c,
    `/laudos/${laudo_id}?mensagem=${encodeURIComponent(`Laudo superado; ${derivados.length} parecer(es) em reavaliação.`)}`,
  );
});
