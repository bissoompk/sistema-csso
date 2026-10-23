/**
 * /acidentes/* — o esqueleto do módulo Análise de Acidentes (CAT/SP), fatia F0.
 *
 * A fundação entrega as portas: cada tela do menu abre (200) para quem a vê, e
 * a ficha da ocorrência tem as abas declaradas, cada uma um `include` que as
 * fatias seguintes preenchem SEM mexer neste arquivo nem na ficha
 * (`partes/acidente_aba_<nome>.html`, com `ignore missing`):
 *
 * - F1: comunicação (formulário, triagem, complementação) e a aba "comunicacao";
 * - F2: formulário por link; F3: saúde; F4: investigação; F5: ações e SIASS.
 *
 * Duas regras valem desde já:
 *
 * - toda tela pede a permissão do item E o acesso ao módulo (`acidentes`): o
 *   "Sem acesso" do módulo fecha o que o perfil abriria;
 * - a lista e a ficha passam por `aplicar_escopo(..., "acidente.ver")`: quem não
 *   alcança a ocorrência recebe 404, igual a inexistente. Nenhuma lista traz
 *   nome: o protocolo identifica, e o nome só vive na ficha, na aba que o lê.
 */
import { Hono } from "hono";
import { and, count, desc, eq, or, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { usuarioLogado } from "../dependencias.js";
import { acidente_ocorrencia } from "../db/esquema/index.js";
import { ESTADOS_ACIDENTE, ROTULO_ACIDENTE, ACIDENTE_ENCERRADO } from "../dominio/estados.js";
import { ROTULO_ESPECIE, ROTULO_ORIGEM } from "../dominio/acidente.js";
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import { aplicar_escopo, ESCOPO_PROPRIO, type UsuarioAtual } from "../servicos/rbac.js";
import { pode_ver_restrita_sst } from "../servicos/acidente_acesso.js";
import { hoje } from "../servicos/datas_br.js";
import { pagina } from "../web.js";

export const rotas = new Hono<Ambiente>();

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

const LIMITE_FILA = 200;

async function _porta(c: Ctx, ...permissoes: string[]): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  for (const p of permissoes) usuario.exigir(p);
  exigir_acesso_ao_modulo(usuario, "acidentes");
  return usuario;
}

/**
 * A porta das telas do TITULAR (comunicar, minhas, ficha): quem só alcança o
 * que é dele (escopo próprio, a concessão do servidor comum) não é da equipe do
 * módulo e não passa por `acesso ao módulo`; a equipe, sim. O escopo da consulta
 * é quem limita o que cada um enxerga.
 */
async function _porta_titular(c: Ctx, permissao: string): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  usuario.exigir(permissao);
  if (usuario.escopo_de(permissao) !== ESCOPO_PROPRIO) exigir_acesso_ao_modulo(usuario, "acidentes");
  return usuario;
}

async function _lista(c: Ctx, usuario: UsuarioAtual, filtro?: SQL) {
  const escopo = aplicar_escopo(usuario, acidente_ocorrencia, "acidente.ver");
  const onde = filtro && escopo ? and(escopo, filtro) : (filtro ?? escopo);
  return c
    .get("tx")
    .select({
      id: acidente_ocorrencia.id,
      protocolo: acidente_ocorrencia.protocolo,
      estado: acidente_ocorrencia.estado,
      especie: acidente_ocorrencia.especie,
      origem: acidente_ocorrencia.origem,
      data_evento: acidente_ocorrencia.data_evento,
      prazo_comunicacao: acidente_ocorrencia.prazo_comunicacao,
      prazo_prorrogado_ate: acidente_ocorrencia.prazo_prorrogado_ate,
    })
    .from(acidente_ocorrencia)
    .where(onde)
    .orderBy(desc(acidente_ocorrencia.data_evento), desc(acidente_ocorrencia.id))
    .limit(LIMITE_FILA);
}

const CONTEXTO_LISTA = { ROTULO_ACIDENTE, ROTULO_ESPECIE, ROTULO_ORIGEM, ACIDENTE_ENCERRADO: [...ACIDENTE_ENCERRADO] };

rotas.get(PAINEL, async (c) => {
  const usuario = await _porta(c, "acidente.ver");
  const escopo = aplicar_escopo(usuario, acidente_ocorrencia, "acidente.ver");
  const por_estado = await c
    .get("tx")
    .select({ estado: acidente_ocorrencia.estado, n: count() })
    .from(acidente_ocorrencia)
    .where(escopo)
    .groupBy(acidente_ocorrencia.estado);
  const contagem: Record<string, number> = Object.fromEntries(por_estado.map((l) => [l.estado, Number(l.n)]));
  const cartoes = ESTADOS_ACIDENTE.map((e) => ({ estado: e, rotulo: ROTULO_ACIDENTE[e], n: contagem[e] ?? 0 }));
  return pagina(c, "paginas/acidentes_painel.html", usuario, {
    cartoes,
    pode_comunicar: usuario.pode("acidente.comunicar"),
  });
});

rotas.get(FILA, async (c) => {
  const usuario = await _porta(c, "acidente.ver");
  const ocorrencias = await _lista(c, usuario);
  return pagina(c, "paginas/acidentes_fila.html", usuario, {
    ...CONTEXTO_LISTA,
    titulo_tela: "Fila de ocorrências",
    subtitulo: "As ocorrências ao seu alcance, da mais recente para a mais antiga.",
    ocorrencias,
    hoje: hoje(),
    limite: LIMITE_FILA,
  });
});

rotas.get(MINHAS, async (c) => {
  const usuario = await _porta_titular(c, "acidente.ver");
  // o que a pessoa comunicou e o que aconteceu com ela (acidentada servidora)
  const dela: SQL[] = [eq(acidente_ocorrencia.criado_por, usuario.id)];
  if (usuario.servidor_id !== null) dela.push(eq(acidente_ocorrencia.servidor_id, usuario.servidor_id));
  const ocorrencias = await _lista(c, usuario, or(...dela));
  return pagina(c, "paginas/acidentes_fila.html", usuario, {
    ...CONTEXTO_LISTA,
    titulo_tela: "Minhas comunicações",
    subtitulo: "Os acidentes que você comunicou ou em que foi o acidentado.",
    ocorrencias,
    hoje: hoje(),
    limite: LIMITE_FILA,
  });
});

// As três telas que as fatias seguintes preenchem: a porta já existe e responde.
rotas.get(COMUNICAR, async (c) => {
  const usuario = await _porta_titular(c, "acidente.comunicar");
  return pagina(c, "paginas/acidentes_em_construcao.html", usuario, {
    titulo_tela: "Comunicar acidente",
    texto: "O formulário de comunicação chega na próxima etapa do módulo.",
  });
});

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

rotas.get("/acidentes/:id{[0-9]+}", async (c) => {
  const usuario = await _porta_titular(c, "acidente.ver");
  const id = Number(c.req.param("id"));
  const escopo = aplicar_escopo(usuario, acidente_ocorrencia, "acidente.ver");
  const [ocorrencia] = await c
    .get("tx")
    .select()
    .from(acidente_ocorrencia)
    .where(escopo ? and(eq(acidente_ocorrencia.id, id), escopo) : eq(acidente_ocorrencia.id, id));
  // fora do escopo é igual a inexistente: o 404 não confirma que existe
  if (!ocorrencia) throw new ErroHttp(404, "A ocorrência não existe ou está fora do seu escopo.");
  // a ocorrência restrita (acidentado menor de idade) é só da equipe de SST
  if (ocorrencia.restrita_sst && !pode_ver_restrita_sst(usuario)) {
    throw new ErroHttp(404, "A ocorrência não existe ou está fora do seu escopo.");
  }
  const pedida = c.req.query("aba") ?? "";
  const aba = ABAS_FICHA.some(([k]) => k === pedida) ? pedida : "comunicacao";
  return pagina(c, "paginas/acidente_ficha.html", usuario, {
    ...CONTEXTO_LISTA,
    ocorrencia,
    abas: ABAS_FICHA,
    aba,
    hoje: hoje(),
  });
});
