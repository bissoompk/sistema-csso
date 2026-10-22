/**
 * /adicionais — máquina B do direito, e /pendencias — o sino.
 * Porte de `app/rotas/adicionais.py`. O serviço de pendências é da base
 * (`servicos/pendencias.ts`); esta rota só o chama.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioCom, usuarioLogado } from "../dependencias.js";
import { numeroDaPagina, pagina, recortar, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import { adicional_vigencia, parecer_tecnico, pendencia, percentual_aplicavel } from "../db/esquema/index.js";
import { TransicaoInvalida } from "../dominio/estados.js";
import { ParecerTecnico } from "../dominio/processo.js";
import * as datas_br from "../servicos/datas_br.js";
import * as direito from "../servicos/direito.js";
import * as servico_pendencias from "../servicos/pendencias.js";
import { ESCOPO_PROPRIO, aplicar_escopo } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

/** O `urlencode` do Python (espaço vira `+`), como o `_voltar` original. */
function _voltar(c: Ctx, destino: string, o: { mensagem?: string; erro?: string } = {}): Response {
  const p = new URLSearchParams();
  if (o.mensagem) p.set("mensagem", o.mensagem);
  if (o.erro) p.set("erro", o.erro);
  const sufixo = p.toString() ? `${destino.includes("?") ? "&" : "?"}${p.toString()}` : "";
  return redirecionar(c, destino + sufixo);
}

function _id(c: Ctx, nome: string): number {
  const v = c.req.param(nome);
  if (!v || !/^\d+$/.test(v)) throw new ErroHttp(422, `Parâmetro inválido: ${nome}`);
  return Number(v);
}

function _data(v: string | null, rotulo: string): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ErroHttp(422, `Informe uma data válida em “${rotulo}”.`);
  return v;
}

rotas.get("/adicionais", async (c) => {
  const usuario = await usuarioCom(c, "processo.ver");
  const tx = c.get("tx");
  const estado = c.req.query("estado") || null;
  // `order_by` explícito: lista paginada sem ordem definida repete e perde
  // linhas. `adicional_vigencia` tem `servidor_id`, a coluna que o escopo usa.
  const vigencias = await tx.query.adicional_vigencia.findMany({
    where: and(aplicar_escopo(usuario, adicional_vigencia, "processo.ver"), estado ? eq(adicional_vigencia.estado, estado) : undefined),
    with: {
      servidor: true,
      tipo_adicional: true,
      percentual: true,
      parecer: { with: { laudo: true } },
    },
    orderBy: [asc(adicional_vigencia.id)],
  });

  const com_direito = new Set(
    (await tx.select({ parecer_id: adicional_vigencia.parecer_id }).from(adicional_vigencia)).map((v) => v.parecer_id),
  );
  const propostas_possiveis = (
    await tx.query.parecer_tecnico.findMany({
      where: and(
        inArray(parecer_tecnico.situacao, ["EMITIDO", "ASSINADO"]),
        aplicar_escopo(usuario, parecer_tecnico, "parecer.ver"),
      ),
      with: { servidor: true, laudo: true },
      orderBy: [asc(parecer_tecnico.id)],
    })
  ).filter((p) => !com_direito.has(p.id));

  const lacunas: Record<number, string[]> = {};
  for (const servidor_id of new Set(vigencias.map((v) => v.servidor_id))) {
    const achadas = await direito.lacunas_na_linha_do_tempo(tx, servidor_id);
    if (achadas.length) lacunas[servidor_id] = achadas;
  }

  // O recorte só entra DEPOIS de `lacunas`: o aviso de integridade vale para a
  // seleção inteira e não pode encolher ao virar a página.
  const recorte = recortar(vigencias, numeroDaPagina(c));
  return pagina(c, "paginas/adicionais.html", usuario, {
    vigencias: recorte.itens,
    recorte,
    propostas_possiveis,
    percentuais: await tx.query.percentual_aplicavel.findMany({
      with: { tipo_adicional: true },
      orderBy: [asc(percentual_aplicavel.id)],
    }),
    motivos: dicionario(direito.MOTIVOS_SUSPENSAO),
    lacunas: dicionario(lacunas),
    filtro_estado: estado,
    // O titular (escopo próprio) vê o PRÓPRIO adicional: um cartão com a frase
    // inteira, e não a tabela de gestão com filtros de estado e uma coluna de
    // ações vazia para uma linha só.
    vista_do_titular: usuario.escopo_de("processo.ver") === ESCOPO_PROPRIO,
    hoje: datas_br.hoje(),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

async function _vigencia(c: Ctx) {
  const [v] = await c
    .get("tx")
    .select()
    .from(adicional_vigencia)
    .where(eq(adicional_vigencia.id, _id(c, "vigencia_id")));
  return v ?? null;
}

/** Recusa de regra ou de máquina volta à lista com a frase; o resto sobe. */
async function _tentar(c: Ctx, acao: () => Promise<unknown>, sucesso: string): Promise<Response> {
  try {
    await acao();
  } catch (falha) {
    if (falha instanceof direito.RegraDoDireito || falha instanceof TransicaoInvalida) {
      return _voltar(c, "/adicionais", { erro: falha.message });
    }
    throw falha;
  }
  return _voltar(c, "/adicionais", { mensagem: sucesso });
}

// Toda ação desta tela pede `parecer.emitir`, e pede na PRIMEIRA linha: quem não
// a tem recebe 403, e não um 422 sobre um campo do formulário que ele nem
// deveria ver. O serviço confere de novo — é ele a regra.
rotas.post("/adicionais/propor/:parecer_id{[0-9]+}", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const tx = c.get("tx");
  const parecer = await tx.query.parecer_tecnico.findFirst({
    // o escopo da leitura vale para a escrita: parecer fora dele "não existe"
    where: and(eq(parecer_tecnico.id, _id(c, "parecer_id")), aplicar_escopo(usuario, parecer_tecnico, "parecer.emitir")),
    with: {
      tipo_adicional: true,
      tipo_movimento: true,
      exposicoes: { with: { percentual: true }, orderBy: (e, { asc: a }) => [a(e.id)] },
    },
  });
  if (!parecer) return _voltar(c, "/adicionais", { erro: "Parecer não encontrado." });
  // O serviço devolve o direito que já existe sem criar outro (é idempotente);
  // a frase é que não pode dizer "proposto" de novo — nada foi proposto agora.
  const [ja] = await tx
    .select({ id: adicional_vigencia.id })
    .from(adicional_vigencia)
    .where(eq(adicional_vigencia.parecer_id, parecer.id));
  if (ja) return _voltar(c, "/adicionais", { erro: "Este parecer já tem direito registrado." });
  try {
    await direito.propor(tx, parecer, usuario);
  } catch (falha) {
    if (falha instanceof direito.RegraDoDireito) return _voltar(c, "/adicionais", { erro: falha.message });
    throw falha;
  }
  return _voltar(c, "/adicionais", { mensagem: `Direito proposto a partir de ${ParecerTecnico.rotulo(parecer)}.` });
});

rotas.post("/adicionais/:vigencia_id{[0-9]+}/conceder", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const f = await formulario(c);
  if (!f.tem("portaria_concessao")) throw new ErroHttp(422, "Informe a portaria de concessão.");
  const vigencia = await _vigencia(c);
  if (!vigencia) return _voltar(c, "/adicionais", { erro: "Adicional não encontrado." });
  const d = {
    portaria_concessao: f.texto("portaria_concessao"),
    data_portaria: _data(f.opcional("data_portaria"), "Data da portaria"),
    data_inicio: _data(f.opcional("data_inicio"), "Efeito financeiro a partir de"),
  };
  return _tentar(c, () => direito.conceder(c.get("tx"), vigencia, usuario, d), "Adicional em vigor.");
});

rotas.post("/adicionais/:vigencia_id{[0-9]+}/suspender", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const f = await formulario(c);
  if (!f.tem("motivo")) throw new ErroHttp(422, "Escolha o motivo da suspensão.");
  const vigencia = await _vigencia(c);
  if (!vigencia) return _voltar(c, "/adicionais", { erro: "Adicional não encontrado." });
  return _tentar(
    c,
    () => direito.suspender(c.get("tx"), vigencia, usuario, { motivo: f.texto("motivo"), base_legal: f.opcional("base_legal") }),
    "Adicional suspenso.",
  );
});

rotas.post("/adicionais/:vigencia_id{[0-9]+}/cessar", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const f = await formulario(c);
  const data_fim = _data(f.opcional("data_fim"), "Data de término");
  const vigencia = await _vigencia(c);
  if (!vigencia) return _voltar(c, "/adicionais", { erro: "Adicional não encontrado." });
  // A caixa de confirmação da camada vale também aqui: cessar não tem volta, e
  // `required` no HTML não protege quem posta direto.
  if (f.texto("ciente") !== "1") {
    return _voltar(c, "/adicionais", { erro: "Marque “Confirmo a cessação deste adicional.” para cessar." });
  }
  return _tentar(
    c,
    () => direito.cessar(c.get("tx"), vigencia, usuario, { data_fim, motivo: f.texto("motivo", "CESSACAO_RISCO") }),
    "Adicional cessado.",
  );
});

rotas.post("/adicionais/:vigencia_id{[0-9]+}/retomar", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const f = await formulario(c);
  const data_inicio = _data(f.opcional("data_inicio"), "Vigente a partir de");
  const vigencia = await _vigencia(c);
  if (!vigencia) return _voltar(c, "/adicionais", { erro: "Adicional não encontrado." });
  return _tentar(c, () => direito.retomar(c.get("tx"), vigencia, usuario, data_inicio), "Adicional retomado.");
});

rotas.post("/adicionais/:vigencia_id{[0-9]+}/alterar", async (c) => {
  const usuario = await usuarioCom(c, "parecer.emitir");
  const f = await formulario(c);
  const percentual_id = f.inteiro("percentual_id");
  if (percentual_id === null || !f.tem("motivo")) throw new ErroHttp(422, "Escolha o novo percentual e escreva o motivo.");
  const vigencia = await _vigencia(c);
  if (!vigencia) return _voltar(c, "/adicionais", { erro: "Adicional não encontrado." });
  return _tentar(
    c,
    () => direito.alterar(c.get("tx"), vigencia, usuario, { percentual_id, motivo: f.texto("motivo") }),
    "Percentual alterado.",
  );
});

// ---------------------------------------------------------------------
// Pendências (o sino)
// ---------------------------------------------------------------------
rotas.get("/pendencias", async (c) => {
  const usuario = await usuarioLogado(c);
  servico_pendencias.exigir_ver(usuario);
  const tx = c.get("tx");
  const minhas = c.req.query("minhas") === "1";
  const hoje = datas_br.hoje();
  const abertas = await servico_pendencias.abertas(tx, usuario, minhas);
  // As mais RECENTES primeiro: por id crescente a seção parava nas 30 primeiras
  // conclusões da história, e as de hoje sumiam. O id desempata o mesmo instante.
  const concluidas_linhas = await tx
    .select()
    .from(pendencia)
    .where(and(eq(pendencia.concluida, true), servico_pendencias.no_escopo(usuario)))
    .orderBy(desc(pendencia.concluida_em), desc(pendencia.id))
    .limit(30);
  // A frase (RN-19 já decidida) e o "onde" de cada linha — o mesmo serviço que
  // a API usa, e por isso a mesma resposta nos dois lugares.
  const leitura = await servico_pendencias.leitura(tx, usuario, [...abertas, ...concluidas_linhas]);

  // `atrasada` era método do modelo; a tela o chama como método.
  const responsaveis = new Map<number, { id: number; nome: string }>();
  const ids = [...new Set(abertas.map((p) => p.responsavel_id).filter((x): x is number => x !== null))];
  if (ids.length) {
    for (const u of await tx.query.usuario.findMany({ where: (t, { inArray: em }) => em(t.id, ids) })) {
      responsaveis.set(u.id, u);
    }
  }
  const vestir = (p: servico_pendencias.Pendencia) => ({
    ...p,
    responsavel: p.responsavel_id !== null ? (responsaveis.get(p.responsavel_id) ?? null) : null,
    atrasada: (quando?: string) => servico_pendencias.atrasada(p, quando ?? hoje),
    leitura: leitura.get(p.id)!,
  });
  const itens = abertas.map(vestir);
  return pagina(c, "paginas/pendencias.html", usuario, {
    pendencias: itens,
    concluidas: concluidas_linhas.map(vestir),
    tipos: servico_pendencias.TIPOS,
    // o botão aparece pendência a pendência; esconder botão nunca foi a
    // checagem — a rota refaz a mesma conta
    concluiveis: abertas.filter((p) => servico_pendencias.pode_concluir(usuario, p)).map((p) => p.id),
    apenas_minhas: minhas,
    hoje,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

rotas.post("/pendencias/:pendencia_id{[0-9]+}/concluir", async (c) => {
  const usuario = await usuarioLogado(c);
  // 403 antes de qualquer leitura: quem não pode ver a tela não descobre por
  // aqui quais ids existem
  servico_pendencias.exigir_ver(usuario);
  const tx = c.get("tx");
  const volta = c.req.query("minhas") === "1" ? "/pendencias?minhas=1" : "/pendencias";
  // O escopo da leitura vale para a escrita: pendência fora dele "não existe",
  // com a mesma frase da que não existe.
  const [p] = await tx
    .select()
    .from(pendencia)
    .where(and(eq(pendencia.id, _id(c, "pendencia_id")), servico_pendencias.no_escopo(usuario)));
  if (!p) return _voltar(c, volta, { erro: "Pendência não encontrada." });
  servico_pendencias.exigir_concluir(usuario, p);
  // Concluir de novo não grava nada (o serviço já não regravava), e a resposta
  // deixa de fingir que acabou de concluir.
  if (p.concluida) return _voltar(c, volta, { mensagem: "Esta pendência já estava concluída." });
  await servico_pendencias.concluir(tx, p, usuario);
  return _voltar(c, volta, { mensagem: "Pendência concluída." });
});
