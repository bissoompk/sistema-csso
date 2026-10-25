/**
 * /processos e /processos/{id} — lista, ficha, anexos, checklist e histórico.
 * Porte de `app/rotas/processos.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { ErroHttp, PermissaoNegada, RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioCom, usuarioLogado, type Formulario } from "../dependencias.js";
import { fragmento, pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  anexo as tabela_anexo,
  checklist,
  checklist_item,
  checklist_modelo,
  historico_evento,
  parecer_tecnico,
  pendencia,
  processo as tabela_processo,
  servidor as tabela_servidor,
  tipo_processo,
  unidade_uorg,
} from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { ChecklistModelo } from "../dominio/dominios.js";
import {
  CADEIA_ADICIONAL,
  INCISOS_ART11,
  ORIGENS_DA_TRIAGEM,
  ROTULO_ESTADO_TELA,
  TransicaoInvalida,
  destinos_do_processo,
  passos_diretos,
  pode_transitar,
  rotulo_tela_do_ascii,
} from "../dominio/estados.js";
import { ROTULO_CATEGORIA_ANEXO_TELA } from "../dominio/processo.js";
import * as repo from "../repositorios/processos.js";
import * as anexo_acesso from "../servicos/anexo_acesso.js";
import * as servico_anexos from "../servicos/anexos.js";
import * as auditoria from "../servicos/auditoria.js";
import * as datas_br from "../servicos/datas_br.js";
import * as servico_nup from "../servicos/nup.js";
import * as servico_parecer from "../servicos/parecer.js";
import * as pendencias from "../servicos/pendencias.js";
import * as sei from "../servicos/sei.js";
import * as servico_servidores from "../servicos/servidores.js";
import { ESCOPO_PROPRIO } from "../servicos/rbac.js";
import * as textos from "../servicos/textos.js";
import { alteracao_na_tela } from "../servicos/trilha_tela.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import {
  CHAVES_AGRUPAMENTO,
  RequisitoDeSaidaNaoAtendido,
  agrupar,
  ProcessoRecusado,
  aplicar_checklist_modelo,
  corrigir_dados,
  criar as criar_processo,
  estados_sem_documento_de,
  fluxo_curto_de,
  mover,
  requisitos_de_saida,
  SAIDAS_DA_TRIAGEM_SEM_DOCUMENTO,
  responsaveis_possiveis,
  resumir,
  resumir_varios,
  sla_vigente,
  voltar_do_sobrestamento,
  type Processo,
} from "../servicos/processo.js";

export const rotas = new Hono<Ambiente>();

export const VISOES_SALVAS: readonly (readonly [string, string])[] = [
  ["Minha fila", "?responsavel_id=eu"],
  // A visão que o cartão "Precisam de você hoje" do painel conta: o link do
  // cartão precisa de um destino que aplique o MESMO critério.
  ["Precisam de você hoje", "?precisam=1"],
  ["Atrasados", "?atrasados=1"],
  ["Parados há mais de 90 dias", "?dias=90"],
  ["Sem nº SEI", "?sem_numero_sei=1"],
  ["Sem percentual", "?sem_percentual=1"],
  ["Reavaliação pendente – químicos", "?reavaliacao_pendente=1"],
  ["Campus Avançados", "?repositorio=1"],
  ["Sem parecer assinado anexado", "?sem_parecer_assinado=1"],
];

/** Os estados na ordem em que a tela os escreve (pelo rótulo de TELA) — só os códigos. */
function _codigos_por_rotulo(): string[] {
  return Object.entries(ROTULO_ESTADO_TELA)
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([codigo]) => codigo);
}

const digitos = (v: string | undefined | null) => (v && /^\d+$/.test(v) ? Number(v) : null);

function _filtro(c: Ctx, usuario: UsuarioAtual): repo.Filtro {
  const p = (k: string) => c.req.query(k) ?? "";
  const responsavel = p("responsavel_id");
  return new repo.Filtro({
    q: p("q") || null,
    estado: p("estado") || null,
    tipo: p("tipo") || null,
    exercicio: digitos(p("exercicio")),
    responsavel_id: responsavel === "eu" ? usuario.id : digitos(responsavel),
    unidade_id: digitos(p("unidade_id")),
    atrasados: p("atrasados") === "1",
    precisam: p("precisam") === "1",
    sem_numero_sei: p("sem_numero_sei") === "1",
    repositorio: p("repositorio") === "1",
    dias_parado: digitos(p("dias")),
    sem_percentual: p("sem_percentual") === "1",
    reavaliacao_pendente: p("reavaliacao_pendente") === "1",
    sem_parecer_assinado: p("sem_parecer_assinado") === "1",
    agrupar: p("agrupar") || null,
    pagina: digitos(p("pagina")) ?? 1,
  });
}

function _id(c: Ctx, nome = "processo_id"): number {
  const v = c.req.param(nome);
  if (!v || !/^\d+$/.test(v)) throw new ErroHttp(422, `Parâmetro inválido: ${nome}`);
  return Number(v);
}

function exigidos(f: Formulario, ...nomes: string[]): void {
  const faltando = nomes.filter((n) => typeof f.dados.get(n) !== "string");
  if (faltando.length) throw new ErroHttp(422, `Campo obrigatório ausente: ${faltando.join(", ")}`);
}

/** Quem tem alguma ação de lote — a coluna de caixas e o formulário só saem para ele. */
function _pode_lote(usuario: UsuarioAtual): boolean {
  return usuario.pode("processo.status") || usuario.pode("processo.atribuir") || usuario.pode("processo.editar");
}

rotas.get("/processos", async (c) => {
  const usuario = await usuarioCom(c, "processo.ver");
  const tx = c.get("tx");
  const filtro = _filtro(c, usuario);
  let [itens, total] = await repo.listar(tx, usuario, filtro);
  // A página é APARADA, e só pode ser aparada depois: o total sai da própria
  // consulta. A segunda consulta só acontece quando alguém digita um número
  // fora da faixa na URL.
  const ultima = Math.max(1, Math.ceil(total / filtro.por_pagina));
  if (filtro.pagina > ultima) {
    filtro.pagina = ultima;
    [itens, total] = await repo.listar(tx, usuario, filtro);
  }
  const sla = await sla_vigente(tx);
  const resumos = await resumir_varios(tx, itens, sla);
  let grupos = null;
  if (filtro.agrupar && Object.hasOwn(CHAVES_AGRUPAMENTO, filtro.agrupar)) {
    const g: Record<string, unknown[]> = {};
    const do_processo = new Map(resumos.map((r) => [r.processo.id, r]));
    for (const [rotulo, lista] of agrupar(itens, filtro.agrupar)) {
      g[rotulo] = lista.map((p) => do_processo.get(p.id)!);
    }
    grupos = Object.keys(g).length ? dicionario(g) : null;
  }
  // Quem só alcança o PRÓPRIO processo (servidor) não tem fila, SLA nem
  // campus a recortar: as visões de trabalho do setor não dizem nada a ele.
  // Pela permissão da lista, e não pela conta: o almoxarife ligado a servidor
  // lê só os próprios processos (concessão do titular), e a tela é a dele.
  const so_o_proprio = usuario.escopo_de("processo.ver") === ESCOPO_PROPRIO;
  return pagina(c, "paginas/processos.html", usuario, {
    resumos,
    grupos,
    pode_lote: _pode_lote(usuario),
    chaves_agrupamento: dicionario(CHAVES_AGRUPAMENTO),
    total,
    filtro,
    busca: filtro.q,
    estados_lote: _codigos_por_rotulo(),
    tipos: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    unidades: await repo.unidades_com_processo(tx, usuario),
    responsaveis: so_o_proprio ? [] : await responsaveis_possiveis(tx),
    estados: _codigos_por_rotulo(),
    visoes: so_o_proprio ? [] : VISOES_SALVAS,
    // o quadro é da equipe (`/kanban` exige na equipe): o titular não o vê
    com_quadro: usuario.pode_na_equipe("processo.ver"),
    incisos: dicionario(INCISOS_ART11),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

// A permissão de cada ação do lote, conferida UMA vez, antes do primeiro
// processo: sem ela a recusa é do pedido, e não "N não passaram" um a um.
const PERMISSAO_DA_ACAO_DE_LOTE: Readonly<Record<string, { permissao: string; verbo: string }>> = {
  estado: { permissao: "processo.status", verbo: "mover processos de estado" },
  responsavel: { permissao: "processo.atribuir", verbo: "atribuir responsável" },
  prazo: { permissao: "processo.editar", verbo: "definir prazo" },
};

/** Ação em lote que não mente: relata um a um o que passou e o que não. */
rotas.post("/processos/lote", async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão antes do formulário: sem ação de lote nenhuma, nem se lê
  if (!_pode_lote(usuario)) usuario.exigir("processo.status");
  const tx = c.get("tx");
  const f = await formulario(c);
  const ids = f
    .todos("processo_id")
    .filter((v) => /^\d+$/.test(v))
    .map(Number);
  const acao = f.texto("acao");
  const feitos: string[] = [];
  const recusados: string[] = [];
  const voltar = (mensagem: string | null, erro: string | null) => {
    let destino = "/processos?" + f.texto("voltar_para");
    const parametros = Object.entries({ mensagem, erro })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    if (parametros) destino += (destino.endsWith("?") ? "" : "&") + parametros;
    return redirecionar(c, destino);
  };

  // O que vale para o lote inteiro é conferido uma vez, antes do primeiro
  // processo: um prazo que não é data, ou um responsável que não pode ser
  // responsável, não é recusa "de um processo" — é do pedido.
  let prazo: string | null = null;
  let responsavel_id: number | null = null;
  const exige = PERMISSAO_DA_ACAO_DE_LOTE[acao];
  if (exige && !usuario.pode(exige.permissao)) {
    return voltar(null, `Você não tem permissão para ${exige.verbo}: nenhum processo foi alterado.`);
  }
  if (acao === "prazo") {
    try {
      // prazo é data futura de propósito: só tem de ser uma data que existe
      prazo = datas_br.ler_data_formulario(f.texto("prazo"), "Prazo");
    } catch (erro) {
      if (!(erro instanceof RegraViolada)) throw erro;
      return voltar(null, erro.message);
    }
  } else if (acao === "responsavel") {
    const escolhido = f.texto("responsavel_id").trim();
    if (escolhido) {
      const id = digitos(escolhido);
      const possiveis = await responsaveis_possiveis(tx);
      if (id === null || !possiveis.some((r) => r.id === id)) {
        return voltar(
          null,
          "Responsável inválido: escolha uma conta ativa que trabalhe processos (com permissão de editar ou mover).",
        );
      }
      responsavel_id = id;
    }
  }
  if (!ids.length) return voltar(null, "Nenhum processo selecionado: marque ao menos um na lista.");

  for (const processo_id of ids) {
    const processo = await repo.por_id(tx, usuario, processo_id);
    if (processo === null) {
      recusados.push(`#${processo_id}: fora do seu escopo`);
      continue;
    }
    try {
      if (acao === "estado") {
        await mover(tx, processo, f.texto("destino"), usuario, {
          comentario: f.opcional("comentario"),
          inciso_art11: f.opcional("inciso_art11"),
        });
      } else if (acao === "responsavel") {
        await tx.update(tabela_processo).set({ responsavel_id }).where(eq(tabela_processo.id, processo.id));
        await auditoria.registrar(tx, {
          entidade: "processo",
          entidade_id: processo.id,
          processo_id: processo.id,
          tipo_evento: "RESPONSAVEL_ALTERADO",
          descricao: "Responsável definido em lote.",
          usuario,
        });
      } else if (acao === "prazo") {
        await tx.update(tabela_processo).set({ prazo }).where(eq(tabela_processo.id, processo.id));
      } else {
        recusados.push(`${processo.nup}: ação desconhecida`);
        continue;
      }
      feitos.push(processo.nup);
    } catch (erro) {
      if (erro instanceof RequisitoDeSaidaNaoAtendido) recusados.push(`${processo.nup}: ${erro.motivos.join("; ")}`);
      else if (erro instanceof TransicaoInvalida) recusados.push(`${processo.nup}: ${erro.message}`);
      else if (erro instanceof PermissaoNegada) recusados.push(`${processo.nup}: ${erro.message}`);
      else throw erro;
    }
  }

  const mensagem = feitos.length ? `${feitos.length} processo(s) atualizado(s).` : null;
  const erro = recusados.length ? `${recusados.length} não passaram — ` + recusados.slice(0, 5).join(" · ") : null;
  return voltar(mensagem, erro);
});

// ---------------------------------------------------------------------
// Novo processo
// ---------------------------------------------------------------------
/**
 * A tela do processo novo, em branco ou com o que foi digitado de volta. Uma
 * função só para os dois casos: duplicá-las foi o que fez a recusa esquecer
 * metade dos campos.
 */
async function _tela_novo(
  c: Ctx,
  usuario: UsuarioAtual,
  erro: string | null = null,
  digitado: Record<string, unknown> = {},
  aviso_saude = false,
  // o campo de onde a recusa veio: a tela escreve a frase ao lado dele
  campo_do_erro: string | null = null,
  // o NUP digitado já é de outro processo: a tela oferece abri-lo
  processo_existente_id: number | null = null,
) {
  const tx = c.get("tx");
  const tipos = await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome));
  // O tipo que a tela abre escolhido é o adicional ocupacional — o caso de uso
  // do módulo. Antes vinha "Acidente em Serviço", só por ser o primeiro em
  // ordem alfabética, e quem não reparava autuava o adicional na máquina curta.
  const padrao = tipos.find((t) => t.codigo === TIPO_PADRAO_NOVO);
  const d: Record<string, unknown> = { tipo_processo_id: padrao?.id ?? null, ...digitado };
  return pagina(c, "paginas/processo_novo.html", usuario, {
    erro,
    campo_do_erro,
    processo_existente_id: usuario.pode("processo.ver") ? processo_existente_id : null,
    hoje_iso: datas_br.hoje(),
    // RN-21 em aviso: a tela oferece "confirmo que a menção é necessária"
    aviso_saude,
    digitado: dicionario(d),
    tipos,
    ..._contexto_servidores(usuario, await servico_servidores.buscar(tx, "", usuario), "", d.servidor_id),
    unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
  });
}

export const TIPO_PADRAO_NOVO = "ADICIONAL_OCUPACIONAL";

/** O que `partes/processo_servidores.html` lê — a página e a rota da busca. */
function _contexto_servidores(
  usuario: UsuarioAtual,
  servidores: { id: number }[],
  q: string,
  escolhido: unknown,
): Record<string, unknown> {
  // a busca que achou UMA pessoa já a deixa escolhida: é quase sempre o SIAPE
  // digitado inteiro, e escolher de novo na lista de um item é clique à toa
  const unico = q && servidores.length === 1 ? servidores[0]!.id : null;
  return {
    servidores,
    q_servidor: q,
    servidor_escolhido: escolhido || unico,
    // RN-19: quem não lê nome procura pelo SIAPE, e a dica diz isso
    busca_so_siape: !usuario.ve_dado_nominal,
  };
}

/** O `<select>` de "Corrigir dados" abre só com o servidor escolhido. */
async function _servidor_da_correcao(
  tx: Ctx["var"]["tx"],
  usuario: UsuarioAtual,
  processo: { servidor_id: number | null; servidor: { id: number } | null },
  digitado: string | undefined,
): Promise<Record<string, unknown>> {
  const escolhido = digitado !== undefined ? digitado : processo.servidor_id;
  let lista: { id: number }[] = processo.servidor ? [processo.servidor] : [];
  if (escolhido && /^\d+$/.test(String(escolhido)) && Number(escolhido) !== processo.servidor_id) {
    lista = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, Number(escolhido)));
  }
  return { ..._contexto_servidores(usuario, lista, "", escolhido), servidores_so_o_escolhido: true };
}

/**
 * Fragmento HTMX: a busca de servidor do processo novo. A regra é a de
 * `/servidores` (`servidores.buscar`): o SIAPE acha para todo mundo; o nome, só
 * para quem já podia ler aquele nome — e a opção sai com o código opaco para
 * quem não pode (RN-19).
 */
rotas.get("/processos/novo/servidores", async (c) => {
  const usuario = await usuarioCom(c, "processo.criar");
  const q = (c.req.query("q") ?? "").trim();
  return fragmento(c, "partes/processo_servidores.html", {
    usuario,
    ..._contexto_servidores(usuario, await servico_servidores.buscar(c.get("tx"), q, usuario), q, c.req.query("servidor_id")),
  });
});

rotas.get("/processos/novo", async (c) => {
  const usuario = await usuarioCom(c, "processo.criar");
  return _tela_novo(c, usuario);
});

rotas.post("/processos/novo", async (c) => {
  const usuario = await usuarioCom(c, "processo.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  exigidos(f, "nup", "tipo_processo_id");
  const tipo_processo_id = f.inteiro("tipo_processo_id");
  const nup = f.texto("nup");
  const servidor_id = f.texto("servidor_id");
  const unidade_uorg_id = f.texto("unidade_uorg_id");
  const data_autuacao = f.texto("data_autuacao");
  const observacoes = f.texto("observacoes");
  const dispensar_dv = f.texto("dispensar_dv");
  // Tudo o que foi digitado, guardado antes da primeira recusa.
  const digitado: Record<string, unknown> = {
    nup,
    tipo_processo_id,
    servidor_id,
    unidade_uorg_id,
    data_autuacao,
    observacoes,
    dispensar_dv,
  };
  // do formato em diante vale o NUP normalizado (a regra mora em `servico.criar`)
  const resultado = servico_nup.validar(nup);
  if (resultado.formato_ok) digitado.nup = resultado.valor;
  // Os campos de escolha voltam à tela com a recusa, e não como 422 cru nem
  // 500: um id de servidor que não é número (ou não existe), um tipo que sumiu.
  const recusar = (mensagem: string, campo: string) => _tela_novo(c, usuario, mensagem, digitado, false, campo);
  const tipo_existe =
    tipo_processo_id !== null &&
    (await tx.select({ id: tipo_processo.id }).from(tipo_processo).where(eq(tipo_processo.id, tipo_processo_id))).length > 0;
  if (!tipo_existe) return recusar("Tipo de processo inválido: escolha um da lista.", "tipo");
  const servidor = await _id_existente(tx, servidor_id, "servidor");
  if (servidor === undefined) {
    return recusar("Servidor inválido: busque pelo nome ou SIAPE e escolha um da lista.", "servidor");
  }
  const unidade = await _id_existente(tx, unidade_uorg_id, "unidade");
  if (unidade === undefined) return recusar("Unidade inválida: escolha uma da lista.", "unidade");
  let autuacao: string | null;
  try {
    // a autuação é fato ocorrido: data real, e nunca depois de hoje
    autuacao = datas_br.ler_data_formulario(data_autuacao, "Data de autuação");
    if (autuacao !== null) datas_br.exigir_ate_hoje(autuacao, "Data de autuação");
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return recusar(erro.message, "data_autuacao");
  }
  let processo: Processo;
  try {
    processo = await criar_processo(tx, usuario, {
      nup,
      tipo_processo_id: tipo_processo_id!,
      servidor_id: servidor,
      unidade_uorg_id: unidade,
      data_autuacao: autuacao,
      observacoes,
      dispensar_dv: dispensar_dv === "1",
      confirmo_mencao_saude: f.texto("confirmo_mencao_saude") === "1",
    });
  } catch (erro) {
    if (!(erro instanceof ProcessoRecusado || erro instanceof textos.TextoProibido)) throw erro;
    const campo = erro instanceof textos.TextoProibido ? "observacoes" : erro.campo ?? "nup";
    const existente = erro instanceof ProcessoRecusado ? erro.existente_id : null;
    return _tela_novo(c, usuario, erro.message, digitado, erro instanceof textos.MencaoDeSaude, campo, existente);
  }
  return redirecionar(c, `/processos/${processo.id}`);
});

/**
 * O id escolhido num `<select>`: `null` quando vazio, `undefined` quando não é
 * número ou não existe — e aí a tela recusa com a frase, em vez de o banco
 * recusar com 500.
 */
async function _id_existente(
  tx: Ctx["var"]["tx"],
  bruto: string,
  qual: "servidor" | "unidade",
): Promise<number | null | undefined> {
  const texto = bruto.trim();
  if (!texto) return null;
  if (!/^\d+$/.test(texto)) return undefined;
  const id = Number(texto);
  const tabela = qual === "servidor" ? tabela_servidor : unidade_uorg;
  const [linha] = await tx.select({ id: tabela.id }).from(tabela).where(eq(tabela.id, id));
  return linha ? id : undefined;
}

// ---------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------
interface OpcoesFicha {
  aba?: string;
  mensagem?: string | null;
  erro?: string | null;
  /**
   * A recusa do "Mover de estado": sai UMA vez, dentro da camada reaberta com
   * o que foi escolhido e digitado — e não na faixa do topo também.
   */
  erro_mover?: string | null;
  mover_digitado?: Record<string, string>;
  /** a recusa do link do SEI, também dentro da própria camada */
  erro_sei?: string | null;
  sei_digitado?: string;
  /** a recusa de "Corrigir dados", dentro da camada reaberta com o digitado */
  erro_dados?: string | null;
  campo_dados?: string | null;
  dados_digitados?: Record<string, string>;
  aviso_saude_dados?: boolean;
  /** o anexo idêntico que voltou em OUTRA categoria: a tela oferece reclassificar */
  reclassificar?: { anexo_id: number; de: string; para: string; nome: string } | null;
  /** o comentário que a RN-21 recusou, de volta para dentro do campo */
  comentario_digitado?: string;
  /** a recusa foi termo de saúde (aviso): a camada oferece a confirmação */
  aviso_saude?: boolean;
}

async function _ficha(c: Ctx, usuario: UsuarioAtual, processo_id: number, o: OpcoesFicha = {}): Promise<Response> {
  usuario.exigir("processo.ver");
  const tx = c.get("tx");
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) {
    // A MESMA frase para "não existe" e "fora do escopo" (e com status 404).
    throw new ErroHttp(404, "O processo não existe ou está fora do seu escopo.");
  }

  const hoje = datas_br.hoje();
  // A ficha lê de muitas tabelas, e nenhuma leitura depende de outra: saem
  // juntas, numa ida ao banco (ver `db/cliente.ts`).
  const [, pareceres, eventos, checklists, modelos_crus, pendentes, curto, resumo, anexos, faltas_saida] = await Promise.all([
    // Quem decide é a relação titular/terceiro, e não `ve_dado_nominal`.
    auditoria.registrar_leitura_nominal(tx, usuario, "processo.servidor", {
      servidor_id: processo.servidor_id,
      processo_id: processo.id,
    }),
    tx.query.parecer_tecnico.findMany({
      where: eq(parecer_tecnico.processo_id, processo.id),
      with: { laudo: true, signatario: true },
      orderBy: [desc(parecer_tecnico.ano), desc(parecer_tecnico.numero)],
    }),
    tx
      .select()
      .from(historico_evento)
      .where(eq(historico_evento.processo_id, processo.id))
      .orderBy(desc(historico_evento.ocorrido_em), desc(historico_evento.id)),
    tx.query.checklist.findMany({
      where: eq(checklist.processo_id, processo.id),
      with: { itens: { orderBy: (i, { asc: a }) => [a(i.id)] } },
      orderBy: [asc(checklist.ordem), asc(checklist.id)],
    }),
    tx
      .select()
      .from(checklist_modelo)
      .where(
        and(
          eq(checklist_modelo.ativo, true),
          or(isNull(checklist_modelo.tipo_processo_id), eq(checklist_modelo.tipo_processo_id, processo.tipo_processo_id)),
        ),
      )
      .orderBy(asc(checklist_modelo.id)),
    tx
      .select()
      .from(pendencia)
      .where(and(eq(pendencia.processo_id, processo.id), eq(pendencia.concluida, false)))
      .orderBy(asc(pendencia.id)),
    fluxo_curto_de(tx, processo),
    resumir(tx, processo, null, { com_destinos: false }),
    servico_anexos.listar(tx, "processo", processo.id),
    requisitos_de_saida(tx, processo, ""),
  ]);
  // D14: a lista e a trilha mostram só o parecer que a conta LÊ
  // (`parecer.escopo_de_leitura`). A Consulta PROGEP lê o documento, e não o
  // rascunho: aqui ela via o número, a situação e o signatário de cada
  // rascunho, e na trilha os eventos da edição dele. A lista crua continua
  // decidindo o que a máquina do processo admite (`sem_documento`), que é
  // regra do processo e não leitura do parecer.
  const legiveis = new Set(
    pareceres.length
      ? (
          await tx
            .select({ id: parecer_tecnico.id })
            .from(parecer_tecnico)
            .where(and(eq(parecer_tecnico.processo_id, processo.id), servico_parecer.escopo_de_leitura(usuario)))
        ).map((l) => l.id)
      : [],
  );
  const pareceres_tela = pareceres.filter((p) => legiveis.has(p.id));
  const eventos_legiveis = eventos.filter(
    (ev) => ev.entidade !== "parecer_tecnico" || legiveis.has(ev.entidade_id),
  );
  // os pareceres já vieram na leitura acima: o que falta sai deles, sem consulta
  const sem_documento = estados_sem_documento_de(
    pareceres.map((p) => p.situacao),
    curto,
  );
  const modelos = modelos_crus.map((m) => ({ ...m, lista_de_itens: ChecklistModelo.lista_de_itens(m) }));
  const pendencias_do_processo = pendentes.map((p) => ({
    ...p,
    atrasada: (quando?: string) => pendencias.atrasada(p, quando ?? hoje),
  }));

  // Só o que a máquina do TIPO admite, na ordem do fluxo, em duas partes: o
  // PRÓXIMO PASSO (as saídas diretas, com o seguinte da cadeia primeiro) e o
  // salto de vários estados, que a tela guarda recolhido e cobra confirmação.
  // Os estados do parecer cujo documento não existe ficam de fora dos dois — só
  // o próprio parecer leva o processo até eles.
  const origem = processo.estado_tecnico;
  const diretos = passos_diretos(origem, curto, sem_documento);
  const seguinte = CADEIA_ADICIONAL[CADEIA_ADICIONAL.indexOf(origem) + 1];
  const proximos = curto || !seguinte || !diretos.includes(seguinte) ? diretos : [seguinte, ...diretos.filter((d) => d !== seguinte)];
  const saltos = destinos_do_processo(origem, curto, sem_documento).filter((d) => !diretos.includes(d));
  // As pendências da triagem (portaria e formulário) não travam TODA saída:
  // entrar na triagem, pedir o documento, sobrestar e arquivar continuam
  // abertos. O aviso dizia "a máquina recusa a saída" no Recebido, e o
  // "Em triagem" passava — a tela desmentia o próprio aviso.
  const livres_das_faltas =
    faltas_saida.length && ORIGENS_DA_TRIAGEM.has(origem)
      ? [...proximos, ...saltos, "SOBRESTADO"]
          .filter((d, i, todos) => SAIDAS_DA_TRIAGEM_SEM_DOCUMENTO.has(d) && todos.indexOf(d) === i)
          .map((d) => ROTULO_ESTADO_TELA[d] ?? d)
      : [];
  // O texto da trilha de estado é gravado em ASCII e com "->" (é digerido pela
  // cadeia de hash): a tela acentua na exibição, sem tocar no gravado.
  const eventos_tela = eventos_legiveis.map((ev) => ({
    ...ev,
    descricao_tela:
      ev.tipo_evento === auditoria.ESTADO_ALTERADO
        ? rotulo_tela_do_ascii(ev.descricao)
        : ev.tipo_evento === "CAMPO_ALTERADO"
          ? alteracao_na_tela(ev)
          : ev.descricao,
  }));
  // "Corrigir dados": as listas só quando a camada vai ser desenhada
  const aba = o.aba ?? c.req.query("aba") ?? "dados";
  const com_correcao = aba === "dados" && usuario.pode("processo.editar");
  const servidor_trocavel = !pareceres.some((p) => p.situacao !== "ANULADO");
  const correcao = com_correcao
    ? {
        unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
        // Só o servidor de hoje (ou o escolhido na recusa): a lista inteira
        // custava uma consulta grande a cada abertura da ficha, e a busca da
        // camada (a mesma do processo novo) traz os outros quando se digita.
        ...(servidor_trocavel ? await _servidor_da_correcao(tx, usuario, processo, o.dados_digitados?.servidor_id) : {}),
      }
    : {};
  return pagina(c, "paginas/processo_ficha.html", usuario, {
    processo,
    resumo,
    ...correcao,
    servidor_trocavel,
    hoje_iso: datas_br.hoje(),
    erro_dados: o.erro_dados ?? null,
    campo_dados: o.campo_dados ?? null,
    dados_digitados: o.dados_digitados ? dicionario(o.dados_digitados) : null,
    aviso_saude_dados: o.aviso_saude_dados ?? false,
    aba,
    pareceres: pareceres_tela,
    eventos: eventos_tela,
    checklists,
    modelos_checklist: modelos,
    pendencias_do_processo,
    anexos,
    categorias: servico_anexos.CATEGORIAS_PROCESSO,
    rotulos_categoria: dicionario(ROTULO_CATEGORIA_ANEXO_TELA),
    proximos,
    saltos,
    livres_das_faltas,
    sem_documento: [...sem_documento],
    incisos: dicionario(INCISOS_ART11),
    faltas_saida,
    erro_mover: o.erro_mover ?? null,
    mover_digitado: dicionario(o.mover_digitado ?? {}),
    erro_sei: o.erro_sei ?? null,
    sei_digitado: o.sei_digitado ?? null,
    reclassificar: o.reclassificar ?? null,
    passos_sei: sei.PASSOS_INCLUSAO,
    mensagem: o.mensagem !== undefined ? o.mensagem : (c.req.query("mensagem") ?? null),
    erro: o.erro !== undefined ? o.erro : (c.req.query("erro") ?? null),
    comentario_digitado: o.comentario_digitado ?? c.req.query("comentario_digitado") ?? "",
    aviso_saude: o.aviso_saude ?? false,
  });
}

rotas.get("/processos/:processo_id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  return _ficha(c, usuario, _id(c));
});

// A confirmação do salto: avançar vários estados de uma vez grava um passo por
// estado pulado, cada um em nome de quem moveu — e quem confirma é a pessoa,
// não o `<details>` aberto.
export const CONFIRMACAO_SALTO = "Para avançar vários passos de uma vez, marque “Confirmo pular etapas”.";

const _ABAS = new Set(["dados", "parecer", "anexos", "checklist", "historico"]);

rotas.post("/processos/:processo_id{[0-9]+}/estado", async (c) => {
  const usuario = await usuarioCom(c, "processo.status");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  // "Avançar vários passos" manda o destino num campo próprio; escolhido, ele
  // vale no lugar do "Próximo passo".
  const salto = f.texto("destino_salto").trim();
  const destino = salto || f.texto("destino").trim();
  const aba = _ABAS.has(f.texto("aba")) ? f.texto("aba") : "dados";
  const digitado = {
    destino: f.texto("destino"),
    destino_salto: salto,
    comentario: f.texto("comentario"),
    inciso_art11: f.texto("inciso_art11"),
    confirmo_salto: f.texto("confirmo_salto"),
  };
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  const recusar = (motivo: string) =>
    _ficha(c, usuario, processo_id, { aba: "dados", erro_mover: motivo, mover_digitado: digitado });
  if (!destino) return recusar("Escolha para onde o processo vai.");
  try {
    if (destino === "__voltar__") await voltar_do_sobrestamento(tx, processo, usuario);
    else {
      const curto = await fluxo_curto_de(tx, processo);
      if (!pode_transitar(processo.estado_tecnico, destino, curto) && digitado.confirmo_salto !== "1") {
        return recusar(CONFIRMACAO_SALTO);
      }
      await mover(tx, processo, destino, usuario, {
        comentario: f.opcional("comentario"),
        // o inciso só vale para o indeferimento; nos outros destinos é ignorado
        inciso_art11: destino === "INDEFERIDO_TECNICAMENTE" ? f.opcional("inciso_art11") : null,
      });
    }
  } catch (erro) {
    if (!(erro instanceof TransicaoInvalida || erro instanceof RequisitoDeSaidaNaoAtendido)) throw erro;
    const motivos = erro instanceof RequisitoDeSaidaNaoAtendido ? erro.motivos : [erro.message];
    return recusar(motivos.join(" · "));
  }
  const rotulo = ROTULO_ESTADO_TELA[processo.estado_tecnico] ?? processo.estado_tecnico;
  const mensagem = `Processo movido para “${rotulo}”.`;
  return redirecionar(c, `/processos/${processo_id}?aba=${aba}&mensagem=${encodeURIComponent(mensagem)}`);
});

// O link permanente do SEI é o que vira o botão "Abrir no SEI ↗" da ficha: só
// endereço do SEI da casa entra, e não qualquer texto. `https://sei.` cobre o
// SEI da UFVJM e o de outro órgão que tramite o processo.
export const PREFIXO_LINK_SEI = "https://sei.";

rotas.post("/processos/:processo_id{[0-9]+}/sei", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  const digitado = f.texto("url_permanente").trim();
  if (digitado && !(digitado.toLowerCase().startsWith(PREFIXO_LINK_SEI) && URL.canParse(digitado))) {
    return _ficha(c, usuario, processo_id, {
      aba: "dados",
      erro_sei:
        `Link do SEI inválido: ele começa com ${PREFIXO_LINK_SEI} — copie o “link para acesso direto” ` +
        "do processo, lá no SEI.",
      sei_digitado: digitado,
    });
  }
  const antes = processo.url_permanente;
  const depois = digitado || null;
  if (antes !== depois) {
    await tx.update(tabela_processo).set({ url_permanente: depois }).where(eq(tabela_processo.id, processo.id));
    await auditoria.registrar_diferencas(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      antes: { url_permanente: antes },
      depois: { url_permanente: depois },
      usuario,
      processo_id: processo.id,
    });
  }
  const mensagem = depois ? "Link do SEI salvo." : "Link do SEI removido.";
  return redirecionar(c, `/processos/${processo_id}?aba=dados&mensagem=${encodeURIComponent(mensagem)}`);
});

rotas.post("/processos/:processo_id{[0-9]+}/dados", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  const f = await formulario(c);
  const digitado: Record<string, string> = {};
  for (const campo of ["servidor_id", "unidade_uorg_id", "data_autuacao", "data_solicitacao_sest", "observacoes"]) {
    digitado[campo] = f.texto(campo);
  }
  const recusar = (erro: string, campo: string, aviso_saude = false) =>
    _ficha(c, usuario, processo_id, {
      aba: "dados",
      erro_dados: erro,
      campo_dados: campo,
      dados_digitados: digitado,
      aviso_saude_dados: aviso_saude,
    });
  // sem o campo no formulário (o processo já tem parecer), o servidor não muda
  const traz_servidor = f.tem("servidor_id");
  const servidor = traz_servidor ? await _id_existente(tx, digitado.servidor_id!, "servidor") : null;
  if (servidor === undefined) return recusar("Servidor inválido: escolha um da lista.", "servidor");
  const unidade = await _id_existente(tx, digitado.unidade_uorg_id!, "unidade");
  if (unidade === undefined) return recusar("Unidade inválida: escolha uma da lista.", "unidade");
  let autuacao: string | null;
  let solicitacao: string | null;
  try {
    autuacao = datas_br.ler_data_formulario(digitado.data_autuacao!, "Data de autuação");
    solicitacao = datas_br.ler_data_formulario(digitado.data_solicitacao_sest!, "Solicitação no SEST");
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return recusar(erro.message, "data_autuacao");
  }
  let alterados: number;
  try {
    alterados = await corrigir_dados(tx, usuario, processo, {
      ...(traz_servidor ? { servidor_id: servidor } : {}),
      unidade_uorg_id: unidade,
      data_autuacao: autuacao,
      data_solicitacao_sest: solicitacao,
      observacoes: digitado.observacoes!,
      confirmo_mencao_saude: f.texto("confirmo_mencao_saude") === "1",
    });
  } catch (erro) {
    if (erro instanceof textos.TextoProibido) {
      return recusar(erro.message, "observacoes", erro instanceof textos.MencaoDeSaude);
    }
    if (!(erro instanceof ProcessoRecusado)) throw erro;
    return recusar(erro.message, erro.campo ?? "observacoes");
  }
  const mensagem = alterados ? "Dados do processo corrigidos." : "Nada mudou: os dados já eram esses.";
  return redirecionar(c, `/processos/${processo_id}?aba=dados&mensagem=${encodeURIComponent(mensagem)}`);
});

rotas.post("/processos/:processo_id{[0-9]+}/anexos", async (c) => {
  const usuario = await usuarioCom(c, "anexo.enviar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  const arquivo = f.dados.get("arquivo");
  if (!(arquivo instanceof File)) throw new ErroHttp(422, "Campo obrigatório ausente: arquivo");
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  const categoria = f.texto("categoria", "OUTRO") || "OUTRO";
  let resultado: servico_anexos.ResultadoAnexo;
  try {
    resultado = await servico_anexos.guardar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      nome_original: arquivo.name || "arquivo",
      conteudo: new Uint8Array(await arquivo.arrayBuffer()),
      mime_type: arquivo.type || "application/octet-stream",
      categoria,
      usuario,
      processo_id: processo.id,
      numero_documento_sei: f.opcional("numero_documento_sei"),
    });
  } catch (erro) {
    // DESVIO: o teto de 4 MB por anexo da nuvem (DESVIOS.md) volta como recusa
    // na própria aba, com a saída escrita.
    if (!(erro instanceof servico_anexos.AnexoGrandeDemais)) throw erro;
    desfazer(c);
    return _ficha(c, usuario, processo_id, { aba: "anexos", erro: erro.message });
  }
  let mensagem: string;
  let reclassificar: OpcoesFicha["reclassificar"] = null;
  if (resultado.duplicado && resultado.anexo.categoria !== categoria && resultado.anexo.ativo) {
    // O mesmo arquivo, mandado de novo com OUTRA categoria, quase sempre é a
    // correção de uma escolha errada no primeiro envio: a tela oferece trocar
    // a categoria (com registro na trilha), em vez de só dizer "ignorado".
    const rotulo = (cat: string) => ROTULO_CATEGORIA_ANEXO_TELA[cat] ?? cat;
    mensagem =
      `Este arquivo já está anexado como “${rotulo(resultado.anexo.categoria)}” — nada foi duplicado. ` +
      `Se a categoria certa é “${rotulo(categoria)}”, reclassifique abaixo.`;
    reclassificar = {
      anexo_id: resultado.anexo.id,
      de: resultado.anexo.categoria,
      para: categoria,
      nome: resultado.anexo.nome_original,
    };
  } else if (resultado.duplicado) mensagem = "Arquivo idêntico já anexado neste processo — ignorado.";
  else if (resultado.tambem_em > 1) {
    // `tambem_em` conta este processo junto
    const outros = resultado.tambem_em - 1;
    mensagem = `Anexado. Este mesmo arquivo também está em ${outros === 1 ? "outro processo" : `outros ${outros} processos`}.`;
  } else mensagem = "Anexo enviado.";
  return _ficha(c, usuario, processo_id, { aba: "anexos", mensagem, reclassificar });
});

/** Troca a categoria de um anexo do processo — a saída do reenvio idêntico. */
rotas.post("/processos/:processo_id{[0-9]+}/anexos/:anexo_id{[0-9]+}/categoria", async (c) => {
  const usuario = await usuarioCom(c, "anexo.enviar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const anexo_id = _id(c, "anexo_id");
  const f = await formulario(c);
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  const [anexo] = await tx
    .select()
    .from(tabela_anexo)
    .where(
      and(
        eq(tabela_anexo.id, anexo_id),
        eq(tabela_anexo.entidade, "processo"),
        eq(tabela_anexo.entidade_id, processo.id),
        eq(tabela_anexo.ativo, true),
      ),
    );
  if (!anexo) return _ficha(c, usuario, processo_id, { aba: "anexos", erro: "Anexo não encontrado neste processo." });
  try {
    await servico_anexos.reclassificar(tx, anexo, f.texto("categoria"), usuario, processo.id);
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return _ficha(c, usuario, processo_id, { aba: "anexos", erro: erro.message });
  }
  const rotulo = ROTULO_CATEGORIA_ANEXO_TELA[anexo.categoria] ?? anexo.categoria;
  return _ficha(c, usuario, processo_id, { aba: "anexos", mensagem: `Anexo reclassificado como “${rotulo}”.` });
});

/** O `filename=` do `FileResponse` do Starlette (com `filename*` para acento). */
export function disposicao(nome: string, tipo = "attachment"): string {
  const ascii = /^[\x20-\x7e]*$/.test(nome) && !nome.includes('"');
  if (ascii) return `${tipo}; filename="${nome}"`;
  return `${tipo}; filename*=utf-8''${encodeURIComponent(nome)}`;
}

/**
 * O download herda a autorização do dono do anexo — `servicos/anexo_acesso`.
 *
 * A rota não tem regra própria: resolve o id, delega e serve o arquivo. Aqui
 * mora só a **forma da recusa**, e ela é uma só para os quatro casos (id
 * inexistente, anexo desativado, dono fora do escopo, entidade sem regra):
 * responder 404 num e 403 noutro devolveria a enumeração pela porta dos fundos.
 */
rotas.get("/anexos/:anexo_id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const anexo_id = _id(c, "anexo_id");
  const [anexo] = await tx.select().from(tabela_anexo).where(eq(tabela_anexo.id, anexo_id));
  try {
    await anexo_acesso.liberar(tx, usuario, anexo ?? null);
  } catch (erro) {
    if (erro instanceof PermissaoNegada) throw new ErroHttp(404, anexo_acesso.INDISPONIVEL);
    throw erro;
  }
  const conteudo = await servico_anexos.ler_conteudo(anexo!);
  return c.body(conteudo as unknown as ArrayBuffer, 200, {
    "content-type": servico_anexos.tipo_para_servir(anexo!.mime_type),
    "content-disposition": disposicao(anexo!.nome_original),
  });
});

rotas.post("/processos/:processo_id{[0-9]+}/checklist", async (c) => {
  await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  exigidos(f, "nome");
  const [novo] = await tx.insert(checklist).values({ processo_id, nome: f.texto("nome") }).returning();
  let ordem = 1;
  for (const linha of f
    .texto("itens")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    await tx.insert(checklist_item).values({ checklist_id: novo!.id, descricao: linha, ordem: ordem++ });
  }
  return redirecionar(c, `/processos/${processo_id}?aba=checklist`);
});

rotas.post("/processos/:processo_id{[0-9]+}/checklist-modelo", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  const modelo_id = f.inteiro("modelo_id");
  if (modelo_id === null) throw new ErroHttp(422, "Campo obrigatório ausente: modelo_id");
  const processo = await repo.por_id(tx, usuario, processo_id);
  const [modelo] = await tx.select().from(checklist_modelo).where(eq(checklist_modelo.id, modelo_id));
  if (processo !== null && modelo) await aplicar_checklist_modelo(tx, processo, modelo, usuario);
  return redirecionar(c, `/processos/${processo_id}?aba=checklist`);
});

rotas.post("/checklist-item/:item_id{[0-9]+}", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const [item] = await tx
    .select()
    .from(checklist_item)
    .where(eq(checklist_item.id, _id(c, "item_id")));
  if (!item) return redirecionar(c, "/processos");
  const concluido = !item.concluido;
  await tx
    .update(checklist_item)
    .set({
      concluido,
      concluido_em: concluido ? agora_utc() : null,
      concluido_por: concluido ? usuario.id : null,
    })
    .where(eq(checklist_item.id, item.id));
  const [dono] = await tx.select().from(checklist).where(eq(checklist.id, item.checklist_id));
  return redirecionar(c, `/processos/${dono!.processo_id}?aba=checklist`);
});

/**
 * Comentário no histórico, com o filtro da RN-21 antes de gravar. A recusa
 * é deliberada; o que estava errado no Python antigo era a FORMA (página branca
 * sem o texto digitado). Aqui a ficha volta com o texto dentro do campo.
 */
rotas.post("/processos/:processo_id{[0-9]+}/comentario", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  exigidos(f, "comentario");
  const comentario = f.texto("comentario");
  // RN-21 em aviso: termo de saúde volta com a caixa de confirmação; CPF/CID não passam
  const confirmado = f.texto("confirmo_mencao_saude") === "1";
  try {
    textos.exigir_texto_limpo(comentario, "comentário", textos.CONTEXTO_AVISO_SAUDE, confirmado);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    return _ficha(c, usuario, processo_id, {
      aba: "historico",
      erro: erro.message,
      comentario_digitado: comentario,
      aviso_saude: erro instanceof textos.MencaoDeSaude,
    });
  }
  if (confirmado) {
    await auditoria.registrar_mencao_de_saude(tx, {
      entidade: "processo",
      entidade_id: processo_id,
      processo_id,
      campo: "comentário",
      texto: comentario,
      usuario,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "processo",
    entidade_id: processo_id,
    processo_id,
    tipo_evento: "COMENTARIO",
    descricao: comentario.trim(),
    comentario: comentario.trim(),
    usuario,
  });
  return redirecionar(c, `/processos/${processo_id}?aba=historico`);
});

