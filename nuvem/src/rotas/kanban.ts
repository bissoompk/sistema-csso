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
import { formulario, usuarioCom } from "../dependencias.js";
import { fragmento, pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import { tipo_processo } from "../db/esquema/index.js";
import {
  COLUNAS_KANBAN,
  ESTADO_PARA_COLUNA,
  TransicaoInvalida,
  coluna_de,
  estado_para_coluna,
} from "../dominio/estados.js";
import * as repo from "../repositorios/processos.js";
import {
  RequisitoDeSaidaNaoAtendido,
  estados_sem_documento,
  fluxo_curto_de,
  mover,
  responsaveis_possiveis,
  resumir,
  resumir_varios,
  sla_vigente,
} from "../servicos/processo.js";
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
  // o quadro do setor (com a lista nominal de responsáveis) é da equipe: o
  // `processo.ver` do titular (D16) vê os próprios processos em /processos
  usuario.exigir_na_equipe("processo.ver");
  const tx = c.get("tx");
  const filtro = _filtro(c);
  const colunas = await repo.kanban(tx, usuario, filtro);
  const sla = await sla_vigente(tx);
  const resumos: Record<string, unknown[]> = {};
  let total = 0;
  const todos = await resumir_varios(tx, Object.values(colunas).flat(), sla);
  for (const [codigo, lista] of Object.entries(colunas)) {
    resumos[codigo] = todos.splice(0, lista.length);
    total += lista.length;
  }
  return pagina(c, "paginas/kanban.html", usuario, {
    resumos: dicionario(resumos),
    total_cartoes: total,
    filtro,
    busca: filtro.q,
    tipos: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    responsaveis: await responsaveis_possiveis(tx),
    estados_disponiveis: Object.keys(ESTADO_PARA_COLUNA).sort(),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

rotas.post("/kanban/mover/:processo_id", async (c) => {
  // a permissão antes de ler o formulário (e de dizer se o processo existe)
  const usuario = await usuarioCom(c, "processo.status");
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

  // A coluna vira estado pela máquina do tipo: o primeiro passo direto que cai
  // nela ou, no adicional, o salto até o estado mais próximo adiante. Sem
  // nenhum, o padrão da coluna — e a recusa diz para onde dá para ir.
  // Os estados do parecer ficam de fora enquanto o parecer não existe: soltar
  // em "Aguardando" um processo em elaboração de parecer pede documento, e não
  // vira "pronto para assinatura" sem ele.
  const curto = await fluxo_curto_de(tx, processo);
  const evitar = await estados_sem_documento(tx, processo, curto);
  const destino =
    f.opcional("estado") ??
    estado_para_coluna(processo.estado_tecnico, coluna, curto, evitar) ??
    ESTADO_PADRAO_DA_COLUNA[coluna] ??
    "EM_TRIAGEM";
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
    const rotulo = Object.fromEntries(COLUNAS_KANBAN)[coluna_de(processo.estado_tecnico, curto)] ?? coluna;
    return _de_volta_ao_quadro(c, "mensagem", `Processo ${processo.nup} movido para “${rotulo}”.`);
  }
  return fragmento(c, "partes/cartao_kanban.html", {
    r: await resumir(tx, processo),
    usuario,
    coluna: coluna_de(processo.estado_tecnico, curto),
  });
});
