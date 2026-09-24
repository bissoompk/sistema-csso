/**
 * /processos e /processos/{id} — lista, ficha, anexos, checklist e histórico.
 * Porte de `app/rotas/processos.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { ErroHttp, PermissaoNegada } from "../nucleo/erros.js";
import { formulario, usuarioCom, usuarioLogado, type Formulario } from "../dependencias.js";
import { pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  anexo as tabela_anexo,
  checklist,
  checklist_item,
  checklist_modelo,
  fluxo_etapa,
  historico_evento,
  parecer_tecnico,
  pendencia,
  processo as tabela_processo,
  servidor as tabela_servidor,
  tipo_processo,
  unidade_uorg,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { ChecklistModelo } from "../dominio/dominios.js";
import { INCISOS_ART11, ROTULO_ESTADO_TELA, TRANSICOES, TransicaoInvalida } from "../dominio/estados.js";
import * as repo from "../repositorios/processos.js";
import * as anexo_acesso from "../servicos/anexo_acesso.js";
import * as servico_anexos from "../servicos/anexos.js";
import * as auditoria from "../servicos/auditoria.js";
import * as datas_br from "../servicos/datas_br.js";
import * as servico_nup from "../servicos/nup.js";
import * as pendencias from "../servicos/pendencias.js";
import * as sei from "../servicos/sei.js";
import * as textos from "../servicos/textos.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import {
  CHAVES_AGRUPAMENTO,
  RequisitoDeSaidaNaoAtendido,
  agrupar,
  aplicar_checklist_modelo,
  mover,
  requisitos_de_saida,
  resumir,
  sla_vigente,
  voltar_do_sobrestamento,
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
  const resumos = [];
  for (const p of itens) resumos.push(await resumir(tx, p, sla));
  let grupos = null;
  if (filtro.agrupar && Object.hasOwn(CHAVES_AGRUPAMENTO, filtro.agrupar)) {
    const g: Record<string, unknown[]> = {};
    for (const [rotulo, lista] of agrupar(itens, filtro.agrupar)) {
      g[rotulo] = [];
      for (const p of lista) g[rotulo]!.push(await resumir(tx, p, sla));
    }
    grupos = Object.keys(g).length ? dicionario(g) : null;
  }
  return pagina(c, "paginas/processos.html", usuario, {
    resumos,
    grupos,
    chaves_agrupamento: dicionario(CHAVES_AGRUPAMENTO),
    total,
    filtro,
    busca: filtro.q,
    estados_lote: _codigos_por_rotulo(),
    tipos: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    unidades: await repo.unidades_com_processo(tx, usuario),
    responsaveis: await tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome)),
    estados: _codigos_por_rotulo(),
    visoes: VISOES_SALVAS,
    incisos: dicionario(INCISOS_ART11),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/** Ação em lote que não mente: relata um a um o que passou e o que não. */
rotas.post("/processos/lote", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const ids = f
    .todos("processo_id")
    .filter((v) => /^\d+$/.test(v))
    .map(Number);
  const acao = f.texto("acao");
  const feitos: string[] = [];
  const recusados: string[] = [];

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
        usuario.exigir("processo.atribuir");
        await tx
          .update(tabela_processo)
          .set({ responsavel_id: digitos(f.texto("responsavel_id")) })
          .where(eq(tabela_processo.id, processo.id));
        await auditoria.registrar(tx, {
          entidade: "processo",
          entidade_id: processo.id,
          processo_id: processo.id,
          tipo_evento: "RESPONSAVEL_ALTERADO",
          descricao: "Responsável definido em lote.",
          usuario,
        });
      } else if (acao === "prazo") {
        usuario.exigir("processo.editar");
        const prazo = f.opcional("prazo");
        if (prazo !== null && !/^\d{4}-\d{2}-\d{2}$/.test(prazo)) throw new ErroHttp(422, "Prazo inválido.");
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
  let destino = "/processos?" + f.texto("voltar_para");
  const parametros = Object.entries({ mensagem, erro })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");
  if (parametros) destino += (destino.endsWith("?") ? "" : "&") + parametros;
  return redirecionar(c, destino);
});

// ---------------------------------------------------------------------
// Novo processo
// ---------------------------------------------------------------------
/**
 * A tela do processo novo, em branco ou com o que foi digitado de volta. Uma
 * função só para os dois casos: duplicá-las foi o que fez a recusa esquecer
 * metade dos campos.
 */
async function _tela_novo(c: Ctx, usuario: UsuarioAtual, erro: string | null = null, digitado: Record<string, unknown> = {}) {
  const tx = c.get("tx");
  return pagina(c, "paginas/processo_novo.html", usuario, {
    erro,
    digitado: dicionario(digitado),
    tipos: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.nome)),
    servidores: await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)),
    unidades: await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso)),
  });
}

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
  if (tipo_processo_id === null) throw new ErroHttp(422, "tipo_processo_id inválido");
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
  const resultado = servico_nup.validar(nup);
  if (!resultado.formato_ok) return _tela_novo(c, usuario, resultado.aviso || "NUP inválido", digitado);
  // do formato em diante vale o NUP normalizado
  digitado.nup = resultado.valor;
  if (!resultado.dv_ok && dispensar_dv !== "1") {
    return _tela_novo(c, usuario, `${resultado.aviso}. Marque 'confirmei no SEI' para prosseguir.`, digitado);
  }
  if ((await repo.por_nup(tx, usuario, resultado.valor)) !== null) {
    return _tela_novo(c, usuario, "já existe processo com este NUP", digitado);
  }
  try {
    textos.exigir_texto_limpo(observacoes, "observações");
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    return _tela_novo(c, usuario, erro.message, digitado);
  }

  const [etapa] = await tx.select().from(fluxo_etapa).where(eq(fluxo_etapa.codigo, "A_FAZER"));
  const [processo] = await tx
    .insert(tabela_processo)
    .values({
      nup: resultado.valor,
      tipo_processo_id,
      etapa_id: etapa!.id,
      estado_tecnico: "RECEBIDO",
      servidor_id: servidor_id ? Number(servidor_id) : null,
      unidade_uorg_id: unidade_uorg_id ? Number(unidade_uorg_id) : null,
      data_autuacao: data_autuacao || null,
      ano_referencia: Number(datas_br.hoje().slice(0, 4)),
      observacoes: observacoes || null,
      nup_dv_dispensado: !resultado.dv_ok,
      responsavel_id: usuario.id,
    })
    .returning();

  await auditoria.registrar(tx, {
    entidade: "processo",
    entidade_id: processo!.id,
    processo_id: processo!.id,
    tipo_evento: "PROCESSO_CRIADO",
    descricao: `Processo ${processo!.nup} criado.`,
    usuario,
  });
  if (!resultado.dv_ok) {
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo!.id,
      processo_id: processo!.id,
      tipo_evento: auditoria.NUP_DV_DISPENSADO,
      descricao: `DV do NUP ${processo!.nup} dispensado por confirmação manual.`,
      usuario,
    });
  }
  return redirecionar(c, `/processos/${processo!.id}`);
});

// ---------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------
interface OpcoesFicha {
  aba?: string;
  mensagem?: string | null;
  erro?: string | null;
  /** o comentário que a RN-21 recusou, de volta para dentro do campo */
  comentario_digitado?: string;
}

async function _ficha(c: Ctx, usuario: UsuarioAtual, processo_id: number, o: OpcoesFicha = {}): Promise<Response> {
  usuario.exigir("processo.ver");
  const tx = c.get("tx");
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) {
    // A MESMA frase para "não existe" e "fora do escopo" (e com status 404).
    throw new ErroHttp(404, "O processo não existe ou está fora do seu escopo.");
  }

  // Quem decide é a relação titular/terceiro, e não `ve_dado_nominal`.
  await auditoria.registrar_leitura_nominal(tx, usuario, "processo.servidor", {
    servidor_id: processo.servidor_id,
    processo_id: processo.id,
  });

  const pareceres = await tx.query.parecer_tecnico.findMany({
    where: eq(parecer_tecnico.processo_id, processo.id),
    with: { laudo: true, signatario: true },
    orderBy: [desc(parecer_tecnico.ano), desc(parecer_tecnico.numero)],
  });
  const eventos = await tx
    .select()
    .from(historico_evento)
    .where(eq(historico_evento.processo_id, processo.id))
    .orderBy(desc(historico_evento.ocorrido_em), desc(historico_evento.id));
  const checklists = await tx.query.checklist.findMany({
    where: eq(checklist.processo_id, processo.id),
    with: { itens: { orderBy: (i, { asc: a }) => [a(i.id)] } },
    orderBy: [asc(checklist.ordem), asc(checklist.id)],
  });
  const modelos = (
    await tx
      .select()
      .from(checklist_modelo)
      .where(
        and(
          eq(checklist_modelo.ativo, true),
          or(isNull(checklist_modelo.tipo_processo_id), eq(checklist_modelo.tipo_processo_id, processo.tipo_processo_id)),
        ),
      )
      .orderBy(asc(checklist_modelo.id))
  ).map((m) => ({ ...m, lista_de_itens: ChecklistModelo.lista_de_itens(m) }));
  const hoje = datas_br.hoje();
  const pendencias_do_processo = (
    await tx
      .select()
      .from(pendencia)
      .where(and(eq(pendencia.processo_id, processo.id), eq(pendencia.concluida, false)))
      .orderBy(asc(pendencia.id))
  ).map((p) => ({ ...p, atrasada: (quando?: string) => pendencias.atrasada(p, quando ?? hoje) }));

  const saidas = Object.hasOwn(TRANSICOES, processo.estado_tecnico) ? [...TRANSICOES[processo.estado_tecnico]!] : [];
  return pagina(c, "paginas/processo_ficha.html", usuario, {
    processo,
    resumo: await resumir(tx, processo),
    aba: o.aba ?? c.req.query("aba") ?? "dados",
    pareceres,
    eventos,
    checklists,
    modelos_checklist: modelos,
    pendencias_do_processo,
    anexos: await servico_anexos.listar(tx, "processo", processo.id),
    categorias: servico_anexos.CATEGORIAS_PROCESSO,
    destinos: saidas.sort(),
    incisos: dicionario(INCISOS_ART11),
    faltas_saida: await requisitos_de_saida(tx, processo, ""),
    passos_sei: sei.PASSOS_INCLUSAO,
    mensagem: o.mensagem !== undefined ? o.mensagem : (c.req.query("mensagem") ?? null),
    erro: o.erro !== undefined ? o.erro : (c.req.query("erro") ?? null),
    comentario_digitado: o.comentario_digitado ?? c.req.query("comentario_digitado") ?? "",
  });
}

rotas.get("/processos/:processo_id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  return _ficha(c, usuario, _id(c));
});

rotas.post("/processos/:processo_id{[0-9]+}/estado", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  exigidos(f, "destino");
  const destino = f.texto("destino");
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo === null) return redirecionar(c, "/processos");
  try {
    if (destino === "__voltar__") await voltar_do_sobrestamento(tx, processo, usuario);
    else {
      await mover(tx, processo, destino, usuario, {
        comentario: f.opcional("comentario"),
        inciso_art11: f.opcional("inciso_art11"),
      });
    }
    return redirecionar(c, `/processos/${processo_id}?aba=historico`);
  } catch (erro) {
    if (!(erro instanceof TransicaoInvalida || erro instanceof RequisitoDeSaidaNaoAtendido)) throw erro;
    const motivos = erro instanceof RequisitoDeSaidaNaoAtendido ? erro.motivos : [erro.message];
    return _ficha(c, usuario, processo_id, { erro: motivos.join(" · ") });
  }
});

rotas.post("/processos/:processo_id{[0-9]+}/sei", async (c) => {
  const usuario = await usuarioCom(c, "processo.editar");
  const tx = c.get("tx");
  const processo_id = _id(c);
  const f = await formulario(c);
  const processo = await repo.por_id(tx, usuario, processo_id);
  if (processo !== null) {
    const antes = processo.url_permanente;
    const depois = f.texto("url_permanente") || null;
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
  return redirecionar(c, `/processos/${processo_id}`);
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
  let resultado: servico_anexos.ResultadoAnexo;
  try {
    resultado = await servico_anexos.guardar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      nome_original: arquivo.name || "arquivo",
      conteudo: new Uint8Array(await arquivo.arrayBuffer()),
      mime_type: arquivo.type || "application/octet-stream",
      categoria: f.texto("categoria", "OUTRO") || "OUTRO",
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
  if (resultado.duplicado) mensagem = "Arquivo idêntico já anexado neste processo — ignorado.";
  else if (resultado.tambem_em > 1) {
    mensagem = `Anexado. Este mesmo arquivo também está em ${resultado.tambem_em} processos.`;
  } else mensagem = "Anexo enviado.";
  return _ficha(c, usuario, processo_id, { aba: "anexos", mensagem });
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
    "content-type": anexo!.mime_type,
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
  try {
    textos.exigir_texto_limpo(comentario, "comentário");
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    return _ficha(c, usuario, processo_id, {
      aba: "historico",
      erro: erro.message,
      comentario_digitado: comentario,
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

