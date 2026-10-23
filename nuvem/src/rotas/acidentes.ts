/**
 * /acidentes/* — o módulo Análise de Acidentes (CAT/SP).
 *
 * A F0 entregou as portas; a F1 (esta) entrega o dia a dia: comunicar, a fila
 * com filtros, o painel, a ficha com as abas de comunicação e de envolvidos, a
 * triagem (assumir, mudar a situação, pedir complementação, cancelar, retificar
 * a CAT/SP, prorrogar o prazo) e a resposta à complementação. As abas das
 * fatias seguintes continuam sendo `include ... ignore missing` na ficha.
 *
 * Regras que valem em toda tela:
 *
 * - a permissão do item E o acesso ao módulo (`acidentes`); quem só alcança o
 *   que é dele (escopo próprio) entra pela porta do titular;
 * - toda leitura passa por `escopo_ocorrencias`: a ocorrência fora do alcance
 *   é 404, igual à inexistente — e a restrita (acidentado menor de idade) só
 *   existe para quem instrui o caso;
 * - nenhuma LISTA traz nome: o protocolo identifica. O nome vive na ficha, na
 *   aba de envolvidos, sob a RN-19 (`identificar`, com a família nominal do
 *   módulo: quem tria, investiga ou encaminha ao SIASS).
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { acidentesLiberado } from "../config.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import {
  acidente_agente_causador,
  acidente_agente_doenca,
  acidente_cat_sp,
  acidente_comunicante,
  acidente_complementacao,
  acidente_ocorrencia,
  acidente_parte_corpo,
  acidente_situacao_geradora,
  campus as tabela_campus,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { ESTADOS_ACIDENTE, ROTULO_ACIDENTE, ACIDENTE_ENCERRADO, ACIDENTE_CANCELAVEL, TRANSICOES_ACIDENTE } from "../dominio/estados.js";
import {
  CONDICOES_ENVOLVIDO,
  ESPECIES,
  LOCAIS_DE_TRANSITO,
  LOCAIS_TIPO,
  MENSAGEM_MENOR_DE_IDADE,
  MOTIVOS_CANCELAMENTO,
  ROTULO_CONDICAO_ENVOLVIDO,
  ROTULO_ESPECIE,
  ROTULO_LOCAL_TIPO,
  ROTULO_MOTIVO_CANCELAMENTO,
  ROTULO_ORIGEM,
  ROTULO_ORIGEM_CAT_SP,
  ROTULO_SIM_NAO_NAO_SEI,
  ROTULO_VINCULO_ACIDENTADO,
  SIM_NAO_NAO_SEI,
  VINCULOS_ACIDENTADO,
} from "../dominio/acidente.js";
import { somar_dias } from "../dominio/datas.js";
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import { ESCOPO_PROPRIO, type UsuarioAtual } from "../servicos/rbac.js";
import { escopo_ocorrencias, filtro_restrita, pode_ver_restrita_sst } from "../servicos/acidente_acesso.js";
import * as comunicacao from "../servicos/acidente_comunicacao.js";
import * as triagem from "../servicos/acidente_triagem.js";
import { hoje } from "../servicos/datas_br.js";
import { comMensagem, fragmento, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

// Enquanto o módulo está seguro na produção (`acidentesLiberado`, §4 da
// especificação), toda rota dele é 404 — igual a uma rota que não existe.
const _modulo_liberado = async (_c: Ctx, seguir: () => Promise<void>) => {
  if (!acidentesLiberado()) throw new ErroHttp(404, "Página não encontrada.");
  await seguir();
};
rotas.use("/acidentes", _modulo_liberado);
rotas.use("/acidentes/*", _modulo_liberado);

export const PAINEL = "/acidentes";
export const COMUNICAR = "/acidentes/comunicar";
export const FILA = "/acidentes/fila";
export const ACOES = "/acidentes/acoes";
export const INDICADORES = "/acidentes/indicadores";
export const MINHAS = "/acidentes/minhas";

/** As abas da ficha, na ordem; o `include` de cada uma é de uma fatia. */
export const ABAS_FICHA: readonly (readonly [string, string])[] = [
  ["comunicacao", "Comunicação"],
  ["envolvidos", "Envolvidos"],
  ["saude", "Saúde"],
  ["investigacao", "Investigação"],
  ["checklist", "Checklist"],
  ["entrevistas", "Entrevistas"],
  ["relatorios", "Relatórios"],
  ["acoes", "Ações"],
  ["siass", "SIASS"],
  ["historico", "Histórico"],
];

/** A família nominal do módulo (RN-19): quem conduz o caso lê o nome. */
export const NOMINAIS_ACIDENTE: readonly string[] = Object.freeze(["acidente.triar", "acidente.investigar", "acidente.siass"]);

const POR_PAGINA = 50;
/** "Vencendo": o prazo efetivo cai nos próximos dias. */
const DIAS_PRAZO_VENCENDO = 3;
/** Os estados em que o prazo do art. 214 ainda corre (ainda não encaminhada nem encerrada). */
const PRAZO_CORRE: readonly string[] = ["RECEBIDA", "EM_TRIAGEM", "AGUARDANDO_COMPLEMENTACAO", "EM_INVESTIGACAO", "RELATORIO_EMITIDO"];

function _recados(c: Ctx) {
  return { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null };
}

async function _porta(c: Ctx, ...permissoes: string[]): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  for (const p of permissoes) usuario.exigir(p);
  exigir_acesso_ao_modulo(usuario, "acidentes");
  return usuario;
}

/**
 * A porta das telas do TITULAR (painel pessoal, comunicar, minhas, ficha): quem
 * só alcança o que é dele (escopo próprio) não é da equipe do módulo e não passa
 * por `acesso ao módulo`; a equipe, sim. O escopo da consulta é quem limita o
 * que cada um enxerga.
 */
async function _porta_titular(c: Ctx, permissao: string): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  usuario.exigir(permissao);
  if (usuario.escopo_de(permissao) !== ESCOPO_PROPRIO) exigir_acesso_ao_modulo(usuario, "acidentes");
  return usuario;
}

function _pessoal(usuario: UsuarioAtual): boolean {
  return usuario.escopo_de("acidente.ver") === ESCOPO_PROPRIO;
}

/** O recorte de toda lista: escopo + restrita + o filtro da tela. */
function _onde(usuario: UsuarioAtual, ...filtros: (SQL | undefined)[]): SQL | undefined {
  const partes = [escopo_ocorrencias(usuario), filtro_restrita(usuario), ...filtros].filter((p): p is SQL => !!p);
  return partes.length ? and(...partes) : undefined;
}

const COLUNAS_LISTA = {
  id: acidente_ocorrencia.id,
  protocolo: acidente_ocorrencia.protocolo,
  estado: acidente_ocorrencia.estado,
  especie: acidente_ocorrencia.especie,
  origem: acidente_ocorrencia.origem,
  data_evento: acidente_ocorrencia.data_evento,
  campus_id: acidente_ocorrencia.campus_id,
  responsavel_id: acidente_ocorrencia.responsavel_id,
  prazo_comunicacao: acidente_ocorrencia.prazo_comunicacao,
  prazo_prorrogado_ate: acidente_ocorrencia.prazo_prorrogado_ate,
};

const CONTEXTO_LISTA = {
  ROTULO_ACIDENTE,
  ROTULO_ESPECIE,
  ROTULO_ORIGEM,
  ACIDENTE_ENCERRADO: [...ACIDENTE_ENCERRADO],
  ESTADOS_ACIDENTE,
  ESPECIES,
};

async function _campi(c: Ctx) {
  return c.get("tx").select().from(tabela_campus).orderBy(asc(tabela_campus.sigla));
}

// =====================================================================
// Painel
// =====================================================================
/** O prazo efetivo (o prorrogado, se houver) cai até `limite` e o prazo ainda corre. */
function _vencendo(limite: string): SQL {
  return and(
    inArray(acidente_ocorrencia.estado, [...PRAZO_CORRE]),
    or(
      and(isNull(acidente_ocorrencia.prazo_prorrogado_ate), lte(acidente_ocorrencia.prazo_comunicacao, limite)),
      lte(acidente_ocorrencia.prazo_prorrogado_ate, limite),
    ),
  )!;
}

async function _contar(c: Ctx, usuario: UsuarioAtual, filtro?: SQL): Promise<number> {
  const [r] = await c.get("tx").select({ n: count() }).from(acidente_ocorrencia).where(_onde(usuario, filtro));
  return Number(r?.n ?? 0);
}

rotas.get(PAINEL, async (c) => {
  const usuario = await _porta_titular(c, "acidente.ver");
  const tx = c.get("tx");
  if (_pessoal(usuario)) {
    const minhas = await _contar(c, usuario);
    return pagina(c, "paginas/acidentes_painel.html", usuario, {
      pessoal: true,
      minhas,
      pode_comunicar: usuario.pode("acidente.comunicar"),
      ..._recados(c),
    });
  }
  const por_estado = await tx
    .select({ estado: acidente_ocorrencia.estado, n: count() })
    .from(acidente_ocorrencia)
    .where(_onde(usuario))
    .groupBy(acidente_ocorrencia.estado);
  const contagem: Record<string, number> = Object.fromEntries(por_estado.map((l) => [l.estado, Number(l.n)]));
  const limite = somar_dias(hoje(), DIAS_PRAZO_VENCENDO);
  const vencendo = await _contar(c, usuario, _vencendo(limite));
  return pagina(c, "paginas/acidentes_painel.html", usuario, {
    pessoal: false,
    contagem,
    vencendo,
    dias_vencendo: DIAS_PRAZO_VENCENDO,
    cartoes: ESTADOS_ACIDENTE.map((e) => ({ estado: e, rotulo: ROTULO_ACIDENTE[e], n: contagem[e] ?? 0 })),
    pode_comunicar: usuario.pode("acidente.comunicar"),
    ..._recados(c),
  });
});

// =====================================================================
// Fila
// =====================================================================
function _filtros_da_fila(c: Ctx) {
  const q = c.req.query.bind(c.req);
  const estado = (q("estado") ?? "").trim();
  const especie = (q("especie") ?? "").trim();
  const campus = (q("campus") ?? "").trim();
  const de = (q("de") ?? "").trim();
  const ate = (q("ate") ?? "").trim();
  const protocolo = (q("protocolo") ?? "").trim().toUpperCase();
  return {
    estado: (ESTADOS_ACIDENTE as readonly string[]).includes(estado) || estado === "ABERTAS" || estado === "VENCENDO" ? estado : "",
    especie: (ESPECIES as readonly string[]).includes(especie) ? especie : "",
    campus: /^\d+$/.test(campus) ? campus : "",
    de: /^\d{4}-\d{2}-\d{2}$/.test(de) ? de : "",
    ate: /^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate : "",
    minhas: q("minhas") === "1",
    protocolo: /^[A-Z0-9-]{1,16}$/.test(protocolo) ? protocolo : "",
  };
}

rotas.get(FILA, async (c) => {
  const usuario = await _porta(c, "acidente.ver");
  const tx = c.get("tx");
  const f = _filtros_da_fila(c);
  const condicoes: SQL[] = [];
  if (f.estado === "ABERTAS") condicoes.push(inArray(acidente_ocorrencia.estado, ESTADOS_ACIDENTE.filter((e) => !ACIDENTE_ENCERRADO.has(e))));
  else if (f.estado === "VENCENDO") {
    const limite = somar_dias(hoje(), DIAS_PRAZO_VENCENDO);
    condicoes.push(_vencendo(limite));
  } else if (f.estado) condicoes.push(eq(acidente_ocorrencia.estado, f.estado));
  if (f.especie) condicoes.push(eq(acidente_ocorrencia.especie, f.especie));
  if (f.campus) condicoes.push(eq(acidente_ocorrencia.campus_id, Number(f.campus)));
  if (f.de) condicoes.push(gte(acidente_ocorrencia.data_evento, f.de));
  if (f.ate) condicoes.push(lte(acidente_ocorrencia.data_evento, f.ate));
  if (f.minhas) condicoes.push(eq(acidente_ocorrencia.responsavel_id, usuario.id));
  if (f.protocolo) condicoes.push(ilike(acidente_ocorrencia.protocolo, `%${f.protocolo}%`));
  const onde = _onde(usuario, ...condicoes);
  const [total_r] = await tx.select({ n: count() }).from(acidente_ocorrencia).where(onde);
  const total = Number(total_r?.n ?? 0);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const bruto = Number(c.req.query("pagina") ?? "1");
  const pag = Number.isInteger(bruto) && bruto >= 1 ? Math.min(bruto, paginas) : 1;
  const ocorrencias = await tx
    .select(COLUNAS_LISTA)
    .from(acidente_ocorrencia)
    .where(onde)
    .orderBy(desc(acidente_ocorrencia.data_evento), desc(acidente_ocorrencia.id))
    .limit(POR_PAGINA)
    .offset((pag - 1) * POR_PAGINA);
  const consulta = new URLSearchParams(
    Object.entries({ ...f, minhas: f.minhas ? "1" : "" }).filter(([, v]) => v) as [string, string][],
  ).toString();
  return pagina(c, "paginas/acidentes_fila.html", usuario, {
    ...CONTEXTO_LISTA,
    titulo_tela: "Fila de ocorrências",
    subtitulo: "As ocorrências ao seu alcance, da mais recente para a mais antiga. Nenhuma linha traz nome: o protocolo identifica.",
    ocorrencias,
    filtros: f,
    campi: await _campi(c),
    pagina: pag,
    por_pagina: POR_PAGINA,
    total,
    consulta,
    hoje: hoje(),
    ..._recados(c),
  });
});

// =====================================================================
// Minhas
// =====================================================================
rotas.get(MINHAS, async (c) => {
  const usuario = await _porta_titular(c, "acidente.ver");
  // o que a pessoa comunicou e o que aconteceu com ela (acidentada servidora);
  // o id vem da sessão, nunca da URL
  const dela: SQL[] = [eq(acidente_ocorrencia.criado_por, usuario.id)];
  if (usuario.servidor_id !== null) dela.push(eq(acidente_ocorrencia.servidor_id, usuario.servidor_id));
  const ocorrencias = await c
    .get("tx")
    .select(COLUNAS_LISTA)
    .from(acidente_ocorrencia)
    .where(_onde(usuario, or(...dela)))
    .orderBy(desc(acidente_ocorrencia.data_evento), desc(acidente_ocorrencia.id))
    .limit(200);
  // a complementação que espera a resposta desta pessoa
  const ids = ocorrencias.filter((o) => o.estado === "AGUARDANDO_COMPLEMENTACAO").map((o) => o.id);
  const a_responder = new Set<number>();
  if (ids.length) {
    const linhas = await c
      .get("tx")
      .select({ ocorrencia_id: acidente_comunicante.ocorrencia_id, usuario_id: acidente_comunicante.usuario_id })
      .from(acidente_comunicante)
      .where(inArray(acidente_comunicante.ocorrencia_id, ids));
    for (const l of linhas) if (l.usuario_id === usuario.id) a_responder.add(l.ocorrencia_id);
  }
  return pagina(c, "paginas/acidentes_minhas.html", usuario, {
    ...CONTEXTO_LISTA,
    ocorrencias,
    a_responder: [...a_responder],
    pode_comunicar: usuario.pode("acidente.comunicar"),
    hoje: hoje(),
    ..._recados(c),
  });
});

// =====================================================================
// Comunicar
// =====================================================================
async function _catalogos(c: Ctx) {
  const tx = c.get("tx");
  const [agentes, doencas, situacoes, partes, campi] = await Promise.all([
    tx.select().from(acidente_agente_causador).where(eq(acidente_agente_causador.ativo, true)).orderBy(asc(acidente_agente_causador.ordem)),
    tx.select().from(acidente_agente_doenca).where(eq(acidente_agente_doenca.ativo, true)).orderBy(asc(acidente_agente_doenca.ordem)),
    tx
      .select()
      .from(acidente_situacao_geradora)
      .where(eq(acidente_situacao_geradora.ativo, true))
      .orderBy(asc(acidente_situacao_geradora.ordem)),
    tx.select().from(acidente_parte_corpo).where(eq(acidente_parte_corpo.ativo, true)).orderBy(asc(acidente_parte_corpo.ordem)),
    _campi(c),
  ]);
  // os agentes causadores, agrupados pela classe (o `optgroup` da tela)
  const grupos: { grupo: string; itens: typeof agentes }[] = [];
  for (const a of agentes) {
    const g = a.grupo ?? "Outros";
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.grupo === g) ultimo.itens.push(a);
    else grupos.push({ grupo: g, itens: [a] });
  }
  return { agentes_por_grupo: grupos, doencas, situacoes, partes_corpo: partes, campi };
}

const CONTEXTO_FORM = {
  ESPECIES,
  ROTULO_ESPECIE,
  LOCAIS_TIPO,
  ROTULO_LOCAL_TIPO,
  LOCAIS_DE_TRANSITO: [...LOCAIS_DE_TRANSITO],
  SIM_NAO_NAO_SEI,
  ROTULO_SIM_NAO_NAO_SEI,
  VINCULOS_ACIDENTADO,
  ROTULO_VINCULO_ACIDENTADO,
  CONDICOES_ENVOLVIDO,
  ROTULO_CONDICAO_ENVOLVIDO,
  MAXIMO_ENVOLVIDOS: comunicacao.MAXIMO_ENVOLVIDOS,
  MAXIMO_TESTEMUNHAS: comunicacao.MAXIMO_TESTEMUNHAS,
};

type Formulario = Awaited<ReturnType<typeof formulario>>;

function _inteiro(f: Formulario, nome: string): number | null {
  return f.inteiro(nome);
}

/** "HH:MM" de jornada → minutos. */
function _minutos(bruto: string | null): number | null {
  const v = (bruto ?? "").trim();
  if (!v) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function _ler_fatos(f: Formulario): comunicacao.Fatos {
  return {
    especie: f.texto("especie"),
    data_evento: f.texto("data_evento"),
    hora_evento: f.opcional("hora_evento"),
    minutos_apos_inicio_jornada: _minutos(f.opcional("jornada")),
    ultimo_dia_trabalho: f.opcional("ultimo_dia_trabalho"),
    local_tipo: f.texto("local_tipo"),
    local_especificacao: f.texto("local_especificacao"),
    campus_id: _inteiro(f, "campus_id"),
    local_municipio: f.opcional("local_municipio"),
    local_uf: f.opcional("local_uf"),
    local_cnpj_contratada: f.opcional("local_cnpj_contratada"),
    transito_registro_policial: f.opcional("transito_registro_policial"),
    transito_numero_bo: f.opcional("transito_numero_bo"),
    transito_vitima_terceiros: f.opcional("transito_vitima_terceiros"),
    agente_causador_id: _inteiro(f, "agente_causador_id"),
    agente_doenca_id: _inteiro(f, "agente_doenca_id"),
    situacao_geradora_id: _inteiro(f, "situacao_geradora_id"),
  };
}

function _ler_relato(f: Formulario): comunicacao.Relato {
  return { descricao: f.texto("descricao"), atividade_no_momento: f.opcional("atividade_no_momento") };
}

/** Os índices dos envolvidos que vieram no formulário (`env_indice`), na ordem. */
function _indices(f: Formulario): number[] {
  const vistos = new Set<number>();
  const saida: number[] = [];
  for (const v of f.todos("env_indice")) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 99 && !vistos.has(n)) {
      vistos.add(n);
      saida.push(n);
    }
  }
  return saida.length ? saida : [1];
}

function _ler_envolvidos(f: Formulario, indices: number[]): comunicacao.Envolvido[] {
  return indices.map((i) => {
    const p = (campo: string) => `env_${i}_${campo}`;
    return {
      vinculo: f.texto(p("vinculo")),
      sou_eu: f.texto(p("sou_eu")) === "1",
      siape: f.opcional(p("siape")),
      nome_externo: f.opcional(p("nome_externo")),
      identificacao_externa: f.opcional(p("identificacao_externa")),
      empresa_contratada: f.opcional(p("empresa_contratada")),
      condicao: f.texto(p("condicao")),
      houve_lesao: f.opcional(p("houve_lesao")),
      contato_investigacao: f.opcional(p("contato_investigacao")),
      menor_de_idade: f.texto(p("menor_de_idade")) === "1",
      saude: {
        partes_corpo_ids: f
          .todos(p("partes"))
          .map(Number)
          .filter((n) => Number.isInteger(n)),
        houve_atendimento: f.opcional(p("houve_atendimento")),
        houve_afastamento: f.opcional(p("houve_afastamento")),
        houve_internacao: f.opcional(p("houve_internacao")),
        houve_obito: f.opcional(p("houve_obito")),
      },
    };
  });
}

function _ler_testemunhas(f: Formulario): comunicacao.Testemunha[] {
  const saida: comunicacao.Testemunha[] = [];
  for (let i = 1; i <= comunicacao.MAXIMO_TESTEMUNHAS; i++) {
    saida.push({
      nome: f.texto(`test_${i}_nome`),
      vinculo: f.opcional(`test_${i}_vinculo`),
      contato: f.opcional(`test_${i}_contato`),
    });
  }
  return saida;
}

/**
 * O que foi digitado, para a recusa devolver o formulário como estava. Sai do
 * formulário JÁ MASCARADO (`formulario`): o CPF digitado não volta na tela.
 */
function _digitado(f: Formulario): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const nome of new Set(f.dados.keys())) {
    const valores = f.todos(nome);
    saida[nome] = valores.length > 1 ? valores : (valores[0] ?? "");
  }
  return saida;
}

async function _tela_comunicar(
  c: Ctx,
  usuario: UsuarioAtual,
  d: { digitado?: Record<string, unknown>; indices?: number[]; erro?: string | null; campo_erro?: string | null } = {},
  status = 200,
) {
  return pagina(
    c,
    "paginas/acidentes_comunicar.html",
    usuario,
    {
      ...CONTEXTO_FORM,
      ...(await _catalogos(c)),
      d: d.digitado ?? {},
      indices: d.indices ?? [1],
      proximo_indice: Math.max(...(d.indices ?? [1])) + 1,
      tem_servidor: usuario.servidor_id !== null,
      hoje: hoje(),
      erro_form: d.erro ?? null,
      campo_erro: d.campo_erro ?? null,
      recusado: !!d.erro,
    },
    status,
  );
}

rotas.get(COMUNICAR, async (c) => {
  const usuario = await _porta_titular(c, "acidente.comunicar");
  return _tela_comunicar(c, usuario);
});

/** Um envolvido a mais (HTMX): o cartão N e o botão que pede o N+1. */
rotas.get(`${COMUNICAR}/envolvido`, async (c) => {
  const usuario = await _porta_titular(c, "acidente.comunicar");
  const i = Number(c.req.query("i") ?? "");
  if (!Number.isInteger(i) || i < 2 || i > comunicacao.MAXIMO_ENVOLVIDOS) throw new ErroHttp(404, "Envolvido fora da faixa.");
  return fragmento(c, "partes/acidente_envolvido_htmx.html", {
    ...CONTEXTO_FORM,
    partes_corpo: (await _catalogos(c)).partes_corpo,
    usuario,
    i,
    d: {},
    tem_servidor: false,
    proximo_indice: i + 1,
  });
});

rotas.post(COMUNICAR, async (c) => {
  const usuario = await _porta_titular(c, "acidente.comunicar");
  const f = await formulario(c);
  const indices = _indices(f);
  const dados: comunicacao.DadosComunicacao = {
    fatos: _ler_fatos(f),
    relato: _ler_relato(f),
    envolvidos: _ler_envolvidos(f, indices),
    testemunhas: _ler_testemunhas(f),
    sou_chefia: f.texto("sou_chefia") === "1",
    declarou_veracidade: f.texto("declaracao") === "1",
  };
  let ocorrencia: comunicacao.Ocorrencia;
  try {
    ocorrencia = await c.get("tx").transaction((sp) => comunicacao.comunicar(sp, usuario, dados));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return _tela_comunicar(
      c,
      usuario,
      {
        digitado: _digitado(f),
        indices,
        erro: erro.message,
        campo_erro: erro instanceof comunicacao.ComunicacaoRecusada ? erro.campo : null,
      },
      422,
    );
  }
  const texto =
    `Comunicação ${ocorrencia.protocolo} enviada à equipe de segurança do trabalho. ` +
    "O prazo legal (10 dias da data do acidente) é acompanhado por ela." +
    (ocorrencia.restrita_sst ? ` ${MENSAGEM_MENOR_DE_IDADE}` : "");
  // a restrita (menor de idade) não abre para quem não é da SST: volta à lista
  const ve_a_ficha = !ocorrencia.restrita_sst || pode_ver_restrita_sst(usuario);
  return redirecionar(c, comMensagem(ve_a_ficha ? `/acidentes/${ocorrencia.id}` : MINHAS, texto));
});

// =====================================================================
// As telas das fatias seguintes: a porta existe e responde
// =====================================================================
rotas.get(ACOES, async (c) => {
  const usuario = await _porta(c, "acidente.ver");
  return pagina(c, "paginas/acidentes_em_construcao.html", usuario, {
    titulo_tela: "Plano de ação",
    texto: "O plano de ação, com os prazos de cada medida, chega numa etapa seguinte do módulo.",
  });
});

rotas.get(INDICADORES, async (c) => {
  const usuario = await _porta(c, "indicador.ver", "acidente.ver");
  return pagina(c, "paginas/acidentes_em_construcao.html", usuario, {
    titulo_tela: "Indicadores de acidentes",
    texto: "A série histórica e as taxas de frequência e de gravidade chegam numa etapa seguinte do módulo.",
  });
});

// =====================================================================
// A ficha
// =====================================================================
/** A ocorrência no alcance da conta, ou 404 (igual à inexistente). */
async function _ocorrencia(c: Ctx, usuario: UsuarioAtual, id: number): Promise<comunicacao.Ocorrencia> {
  const [ocorrencia] = await c
    .get("tx")
    .select()
    .from(acidente_ocorrencia)
    .where(_onde(usuario, eq(acidente_ocorrencia.id, id)));
  if (!ocorrencia) throw new ErroHttp(404, "A ocorrência não existe ou está fora do seu escopo.");
  return ocorrencia;
}

function _id(c: Ctx): number {
  return Number(c.req.param("id"));
}

async function _rotulo_de(c: Ctx, tabela: typeof acidente_agente_causador | typeof acidente_agente_doenca | typeof acidente_situacao_geradora, id: number | null) {
  if (id === null) return null;
  const [l] = await c.get("tx").select({ rotulo: tabela.rotulo }).from(tabela).where(eq(tabela.id, id));
  return l?.rotulo ?? null;
}

async function _tela_ficha(c: Ctx, usuario: UsuarioAtual, ocorrencia: comunicacao.Ocorrencia, extra: Record<string, unknown> = {}, status = 200) {
  const tx = c.get("tx");
  const pedida = c.req.query("aba") ?? "";
  const aba = (extra.aba as string | undefined) ?? (ABAS_FICHA.some(([k]) => k === pedida) ? pedida : "comunicacao");
  const vigente = await comunicacao.cat_sp_vigente(tx, ocorrencia);
  const versoes = await tx
    .select({
      versao: acidente_cat_sp.versao,
      origem: acidente_cat_sp.origem,
      motivo_retificacao: acidente_cat_sp.motivo_retificacao,
      registrada_em: acidente_cat_sp.registrada_em,
      hash_conteudo: acidente_cat_sp.hash_conteudo,
    })
    .from(acidente_cat_sp)
    .where(eq(acidente_cat_sp.ocorrencia_id, ocorrencia.id))
    .orderBy(desc(acidente_cat_sp.versao));
  const complementacoes = await tx
    .select()
    .from(acidente_complementacao)
    .where(eq(acidente_complementacao.ocorrencia_id, ocorrencia.id))
    .orderBy(asc(acidente_complementacao.id));
  const [responsavel] = ocorrencia.responsavel_id
    ? await tx.select({ nome: tabela_usuario.nome }).from(tabela_usuario).where(eq(tabela_usuario.id, ocorrencia.responsavel_id))
    : [];
  const [campus] = ocorrencia.campus_id
    ? await tx.select().from(tabela_campus).where(eq(tabela_campus.id, ocorrencia.campus_id))
    : [];
  const envolvidos = await comunicacao.envolvidos_de(tx, ocorrencia.id);
  const conduz = NOMINAIS_ACIDENTE.some((p) => usuario.pode(p)) || ocorrencia.criado_por === usuario.id;
  const contexto = (vigente?.contexto_congelado ?? null) as comunicacao.ContextoCatSp | null;
  const pode_triar = usuario.pode("acidente.triar") && !ACIDENTE_ENCERRADO.has(ocorrencia.estado);
  const destinos = pode_triar
    ? triagem.DESTINOS_DA_TRIAGEM.filter((d) => TRANSICOES_ACIDENTE[ocorrencia.estado]?.has(d))
    : [];
  // a retificação abre com os valores vigentes (ou com o que foi digitado, na recusa)
  const digitado = extra.digitado as Record<string, unknown> | undefined;
  const d_ret =
    digitado && extra.popup_aberto === "retificar"
      ? digitado
      : {
          ...ocorrencia,
          jornada:
            ocorrencia.minutos_apos_inicio_jornada === null
              ? ""
              : `${String(Math.floor(ocorrencia.minutos_apos_inicio_jornada / 60)).padStart(2, "0")}:${String(ocorrencia.minutos_apos_inicio_jornada % 60).padStart(2, "0")}`,
          hora_evento: ocorrencia.hora_evento ? ocorrencia.hora_evento.slice(0, 5) : "",
          descricao: contexto?.relato.descricao ?? "",
          atividade_no_momento: contexto?.relato.atividade_no_momento ?? "",
        };
  return pagina(
    c,
    "paginas/acidente_ficha.html",
    usuario,
    {
      ...CONTEXTO_LISTA,
      ...CONTEXTO_FORM,
      ROTULO_MOTIVO_CANCELAMENTO,
      ROTULO_ORIGEM_CAT_SP,
      MOTIVOS_CANCELAMENTO,
      ocorrencia,
      abas: ABAS_FICHA,
      aba,
      hoje: hoje(),
      vigente,
      contexto,
      versoes,
      complementacoes,
      complementacao_aberta: complementacoes.find((x) => x.respondida_em === null) ?? null,
      responsavel_nome: responsavel?.nome ?? null,
      campus,
      agente_rotulo: await _rotulo_de(c, acidente_agente_causador, ocorrencia.agente_causador_id),
      doenca_rotulo: await _rotulo_de(c, acidente_agente_doenca, ocorrencia.agente_doenca_id),
      situacao_rotulo: await _rotulo_de(c, acidente_situacao_geradora, ocorrencia.situacao_geradora_id),
      acidentados: envolvidos.acidentados,
      testemunhas: envolvidos.testemunhas,
      // RN-19: o nome de quem não é servidor e das testemunhas segue a mesma família
      ve_nomes: conduz,
      nominais_rn19: NOMINAIS_ACIDENTE,
      pode_triar,
      pode_cancelar: pode_triar && ACIDENTE_CANCELAVEL.has(ocorrencia.estado),
      pode_complementar: pode_triar && TRANSICOES_ACIDENTE[ocorrencia.estado]?.has("AGUARDANDO_COMPLEMENTACAO"),
      pode_responder: ocorrencia.estado === "AGUARDANDO_COMPLEMENTACAO" && (await triagem.pode_responder(tx, usuario, ocorrencia)),
      destinos,
      ...(pode_triar ? await _catalogos(c) : {}),
      d: d_ret,
      pre: "ret",
      prazo_efetivo: ocorrencia.prazo_prorrogado_ate ?? ocorrencia.prazo_comunicacao,
      ..._recados(c),
      ...extra,
    },
    status,
  );
}

rotas.get("/acidentes/:id{[0-9]+}", async (c) => {
  const usuario = await _porta_titular(c, "acidente.ver");
  const ocorrencia = await _ocorrencia(c, usuario, _id(c));
  return _tela_ficha(c, usuario, ocorrencia);
});

// =====================================================================
// A triagem: cada ato num POST, com a versão lida
// =====================================================================
/**
 * O esqueleto de todo ato da equipe: porta, ocorrência no alcance, versão lida,
 * o serviço num savepoint. A recusa volta à ficha com o erro (409 quando outra
 * pessoa mudou a ocorrência; 422 nas demais), e o popup do ato reabre.
 */
async function _ato(
  c: Ctx,
  popup: string,
  executar: (sp: Executor, usuario: UsuarioAtual, oc: comunicacao.Ocorrencia, f: Formulario, versao: number) => Promise<unknown>,
  sucesso: (oc: comunicacao.Ocorrencia) => string,
) {
  const usuario = await _porta(c, "acidente.triar");
  const ocorrencia = await _ocorrencia(c, usuario, _id(c));
  const f = await formulario(c);
  const versao = f.inteiro("versao") ?? -1;
  try {
    await c.get("tx").transaction((sp) => executar(sp, usuario, ocorrencia, f, versao));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    const atual = await _ocorrencia(c, usuario, ocorrencia.id);
    const conflito = erro instanceof triagem.OcorrenciaAlterada;
    return _tela_ficha(
      c,
      usuario,
      atual,
      { aba: "comunicacao", erro: erro.message, popup_aberto: conflito ? null : popup, digitado: _digitado(f) },
      conflito ? 409 : 422,
    );
  }
  return redirecionar(c, comMensagem(`/acidentes/${ocorrencia.id}`, sucesso(ocorrencia)));
}

rotas.post("/acidentes/:id{[0-9]+}/assumir", (c) =>
  _ato(
    c,
    "assumir",
    (sp, u, oc, _f, v) => triagem.assumir(sp, u, oc, v),
    (oc) => `Você assumiu ${oc.protocolo}. O prazo legal passa a ser acompanhado por você.`,
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/estado", (c) =>
  _ato(
    c,
    "mudar-estado",
    (sp, u, oc, f, v) => triagem.mudar_estado(sp, u, oc, f.texto("destino"), v),
    (oc) => `${oc.protocolo}: situação alterada para ${ROTULO_ACIDENTE[oc.estado] ?? oc.estado}.`,
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/complementacao", (c) =>
  _ato(
    c,
    "pedir-complementacao",
    (sp, u, oc, f, v) => triagem.pedir_complementacao(sp, u, oc, f.texto("pedido"), v),
    (oc) => `Complementação pedida a quem comunicou ${oc.protocolo}. O prazo da resposta é de 5 dias.`,
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/cancelar", (c) =>
  _ato(
    c,
    "cancelar",
    (sp, u, oc, f, v) => triagem.cancelar(sp, u, oc, f.texto("motivo"), f.opcional("texto"), v),
    (oc) => `${oc.protocolo} cancelada. O registro fica, com o motivo — nada foi apagado.`,
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/retificar", (c) =>
  _ato(
    c,
    "retificar",
    (sp, u, oc, f, v) => triagem.retificar(sp, u, oc, { fatos: _ler_fatos(f), relato: _ler_relato(f), motivo: f.texto("motivo") }, v),
    (oc) => `CAT/SP de ${oc.protocolo} retificada: versão ${oc.cat_sp_versao}. A anterior continua guardada.`,
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/prazo", (c) =>
  _ato(
    c,
    "prorrogar",
    (sp, u, oc, f, v) => triagem.prorrogar_prazo(sp, u, oc, f.texto("ate"), f.texto("motivo"), v),
    (oc) => `Prazo de ${oc.protocolo} prorrogado. O prazo legal continua registrado ao lado.`,
  ),
);

// =====================================================================
// A resposta à complementação (quem comunicou ou o próprio acidentado)
// =====================================================================
async function _tela_complementar(c: Ctx, usuario: UsuarioAtual, oc: comunicacao.Ocorrencia, d: { erro?: string; resposta?: string } = {}, status = 200) {
  const pedido = await triagem.complementacao_aberta(c.get("tx"), oc.id);
  return pagina(
    c,
    "paginas/acidente_complementar.html",
    usuario,
    { ocorrencia: oc, pedido, erro_form: d.erro ?? null, resposta: d.resposta ?? "", ..._recados(c) },
    status,
  );
}

async function _porta_complementar(c: Ctx) {
  const usuario = await _porta_titular(c, "acidente.ver");
  const oc = await _ocorrencia(c, usuario, _id(c));
  if (!(await triagem.pode_responder(c.get("tx"), usuario, oc))) {
    throw new ErroHttp(403, "Só quem comunicou o acidente, ou o próprio acidentado, responde a complementação.");
  }
  return { usuario, oc };
}

rotas.get("/acidentes/:id{[0-9]+}/complementar", async (c) => {
  const { usuario, oc } = await _porta_complementar(c);
  return _tela_complementar(c, usuario, oc);
});

rotas.post("/acidentes/:id{[0-9]+}/complementar", async (c) => {
  const { usuario, oc } = await _porta_complementar(c);
  const f = await formulario(c);
  const resposta = f.texto("resposta");
  try {
    await c.get("tx").transaction((sp) => triagem.responder_complementacao(sp, usuario, oc, resposta));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return _tela_complementar(c, usuario, oc, { erro: erro.message, resposta }, 422);
  }
  return redirecionar(
    c,
    comMensagem(`/acidentes/${oc.id}`, `Resposta enviada. A CAT/SP de ${oc.protocolo} ganhou a versão ${oc.cat_sp_versao}.`),
  );
});
