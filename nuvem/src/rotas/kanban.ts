/**
 * /kanban — operação diária. Arrastar-e-soltar por `fetch`, no script da tela.
 * Porte de `app/rotas/kanban.py`.
 *
 * `mover_cartao` responde **fragmento**, e não redirect, dos dois lados: o
 * cartão novo quando passa, e `partes/erro_movimento.html` com 422 quando a
 * máquina de estados recusa. A exceção é o formulário comum do menu "mover
 * para…" do cartão (sem JavaScript): para ESSE pedido a rota devolve o quadro
 * inteiro (303), com a mensagem ou a recusa na faixa. Quem distingue os dois é
 * `_quer_pagina`.
 */
import { Hono } from "hono";
import { asc } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { formulario, usuarioCom, usuarioLogado } from "../dependencias.js";
import { fragmento, pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import { tipo_processo, usuario as tabela_usuario } from "../db/esquema/index.js";
import { COLUNAS_KANBAN, ESTADO_PARA_COLUNA, TransicaoInvalida, coluna_de } from "../dominio/estados.js";
import * as repo from "../repositorios/processos.js";
import { RequisitoDeSaidaNaoAtendido, mover, resumir, sla_vigente } from "../servicos/processo.js";
import { ErroHttp } from "../nucleo/erros.js";

export const rotas = new Hono<Ambiente>();

// Estado padrão ao soltar um cartão numa coluna (a coluna é visão; o estado é verdade)
export const ESTADO_PADRAO_DA_COLUNA: Readonly<Record<string, string>> = {
  NAO_INICIADO: "NAO_INICIADO",
  A_FAZER: "EM_TRIAGEM",
  EM_ANDAMENTO: "AGUARDANDO_INSPECAO",
  AGUARDANDO: "PENDENTE_DOCUMENTO",
  CONCLUIDO: "CONCLUIDO",
};

/**
 * Pedido de formulário comum (sem JavaScript), e não do `fetch` do quadro. O
 * `fetch` manda `X-Requested-With: fetch`; o navegador submetendo um `<form>`
 * pede `text/html`. A suíte, que chama a rota direto, aceita qualquer coisa —
 * e continua recebendo o fragmento.
 */
function _quer_pagina(c: Ctx): boolean {
  if (c.req.header("x-requested-with") === "fetch") return false;
  if (c.req.header("hx-request") === "true") return false;
  return (c.req.header("accept") ?? "").includes("text/html");
}

function _de_volta_ao_quadro(c: Ctx, campo: string, texto: string): Response {
  return redirecionar(c, `/kanban?${campo}=${encodeURIComponent(texto)}`);
}

const digitos = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

function _filtro(c: Ctx): repo.Filtro {
  const p = (k: string) => c.req.query(k) ?? "";
  return new repo.Filtro({
    q: p("q") || null,
    tipo: p("tipo") || null,
    exercicio: digitos(p("exercicio")),
    responsavel_id: digitos(p("responsavel_id")),
    atrasados: p("atrasados") === "1",
    // `precisam` entra pela mesma razão de `atrasados`: o alternador
    // Quadro/Tabela reproduz o filtro pela querystring.
    precisam: p("precisam") === "1",
    repositorio: p("repositorio") === "1",
  });
}

rotas.get("/kanban", async (c) => {
  const usuario = await usuarioCom(c, "processo.ver");
  const tx = c.get("tx");
  const filtro = _filtro(c);
  const colunas = await repo.kanban(tx, usuario, filtro);
  const sla = await sla_vigente(tx);
  const resumos: Record<string, unknown[]> = {};
  let total = 0;
  for (const [codigo, lista] of Object.entries(colunas)) {
    resumos[codigo] = [];
    for (const p of lista) resumos[codigo]!.push(await resumir(tx, p, sla));
    total += lista.length;
  }
  return pagina(c, "paginas/kanban.html", usuario, {
    resumos: dicionario(resumos),
    total_cartoes: total,
    filtro,
    busca: filtro.q,
    tipos: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    responsaveis: await tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome)),
    estados_disponiveis: Object.keys(ESTADO_PARA_COLUNA).sort(),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

rotas.post("/kanban/mover/:processo_id", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const pagina_inteira = _quer_pagina(c);
  const f = await formulario(c);
  if (!f.tem("coluna")) throw new ErroHttp(422, "Campo obrigatório ausente: coluna");
  const coluna = f.texto("coluna");
  const processo_id = Number(c.req.param("processo_id"));
  const processo = Number.isInteger(processo_id) ? await repo.por_id(tx, usuario, processo_id) : null;
  if (processo === null) {
    if (pagina_inteira) return _de_volta_ao_quadro(c, "erro", "Processo não encontrado.");
    return c.html("<div class='aviso aviso-erro'>Processo não encontrado.</div>", 404);
  }

  const destino = f.opcional("estado") ?? ESTADO_PADRAO_DA_COLUNA[coluna] ?? "EM_TRIAGEM";
  try {
    await mover(tx, processo, destino, usuario, {
      comentario: f.opcional("comentario"),
      inciso_art11: f.opcional("inciso_art11"),
    });
  } catch (erro) {
    if (!(erro instanceof TransicaoInvalida || erro instanceof RequisitoDeSaidaNaoAtendido)) throw erro;
    desfazer(c);
    const motivos = erro instanceof RequisitoDeSaidaNaoAtendido ? erro.motivos : [erro.message];
    if (pagina_inteira) return _de_volta_ao_quadro(c, "erro", motivos.join(" · "));
    return fragmento(c, "partes/erro_movimento.html", { motivos, processo }, 422);
  }
  if (pagina_inteira) {
    const rotulo = Object.fromEntries(COLUNAS_KANBAN)[coluna_de(processo.estado_tecnico)] ?? coluna;
    return _de_volta_ao_quadro(c, "mensagem", `Processo ${processo.nup} movido para “${rotulo}”.`);
  }
  return fragmento(c, "partes/cartao_kanban.html", {
    r: await resumir(tx, processo),
    usuario,
    coluna: coluna_de(processo.estado_tecnico),
  });
});
