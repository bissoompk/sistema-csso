/**
 * `/api/v1` — a mesma regra, em JSON, para o balcão de EPI, a chamada e o app.
 * Porte de `app/rotas/api.py`.
 *
 * **O que a API NÃO é.** Não é uma segunda implementação. Cada rota chama o
 * MESMO serviço que a tela chama (`epi_ficha.registrar_entrega`,
 * `presenca.lancar_presenca`, `servidores.buscar`), com as mesmas recusas e a
 * mesma trilha. O que muda é a forma da resposta: JSON no lugar de HTML.
 *
 * **Autenticação e privacidade, iguais às da tela.**
 * - A sessão é o MESMO cookie da tela; sem sessão, 401 em JSON (o `onError` de
 *   `src/app.ts` decide pelo caminho `/api/`).
 * - A RN-19 vale linha a linha, pela MESMA função da tela (`identificar`).
 * - Todo POST exige `X-Requested-With: fetch` — a guarda contra CSRF de quem usa
 *   cookie: um `<form>` de outro site posta com o cookie, mas não escreve esse
 *   cabeçalho, e a CSP (`connect-src 'self'`) barra o `fetch` de outra origem.
 *
 * **A transação.** Toda recusa aqui é `RecusaDaApi` LANÇADA: o `onError` a
 * rende em `{erro, motivos}` e o middleware de `app.ts` desfaz a transação da
 * requisição — é o `s.rollback()` antes do `raise` do Python. O `s.commit()` do
 * caminho feliz é o COMMIT do middleware.
 *
 * **Sem Swagger, de propósito**: o contrato está em `src/esquemas/api.ts`, e o
 * único índice é `GET /api/v1`, que exige sessão.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { RecusaDaApi, RegraViolada } from "../nucleo/erros.js";
import { usuarioLogado } from "../dependencias.js";
import { VERSAO } from "../config.js";
import * as contrato from "../esquemas/api.js";
import {
  epi_entrada_estoque,
  epi_item,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  turma as tabela_turma,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { EpiItem as EpiItemDominio } from "../dominio/epi.js";
import { ROTULO_INSCRICAO, ROTULO_TURMA, TransicaoInvalida } from "../dominio/estados.js";
import { Turma } from "../dominio/treinamento.js";
import * as auditoria from "../servicos/auditoria.js";
import * as epi_estoque from "../servicos/epi_estoque.js";
import * as epi_ficha from "../servicos/epi_ficha.js";
import * as identificacao from "../servicos/identificacao.js";
import * as servico_pendencias from "../servicos/pendencias.js";
import * as servico_presenca from "../servicos/presenca.js";
import * as servico_servidores from "../servicos/servidores.js";
import * as servico_turma from "../servicos/turma.js";
import { nome_exibicao } from "../servicos/participante.js";
import { hoje } from "../servicos/datas_br.js";
import type { UsuarioAtual } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

const PREFIXO = "/api/v1";
export const CABECALHO_FETCH = "x-requested-with";

/** A guarda de CSRF dos POSTs — ver o cabeçalho do módulo. */
export function exigir_fetch(c: Ctx): void {
  if ((c.req.header(CABECALHO_FETCH) ?? "").toLowerCase() !== "fetch") {
    throw new RecusaDaApi(403, "Cabeçalho X-Requested-With: fetch obrigatório nos envios da API.", [
      "É a guarda contra envio forjado por outro site. Use fetch() da própria origem.",
    ]);
  }
}

/** A semente do identificador opaco: o prefixo do cookie de sessão (`identificacao.semente_de`). */
function semente(c: Ctx): string {
  return identificacao.semente_de({ cookies: { get: (nome: string) => getCookie(c, nome) ?? null } });
}

/** O id do caminho (a rota só casa dígitos). */
function id(c: Ctx, nome: string): number {
  return Number(c.req.param(nome));
}

// =====================================================================
// Índice e identidade
// =====================================================================
rotas.get(PREFIXO, async (c) => {
  await usuarioLogado(c);
  return c.json({
    versao: VERSAO,
    rotas: [
      "GET  /api/v1/eu",
      "GET  /api/v1/pendencias",
      "GET  /api/v1/epis/servidores?q=",
      "GET  /api/v1/epis/itens",
      "GET  /api/v1/epis/itens/{item_id}/lotes",
      "POST /api/v1/epis/entregas",
      "GET  /api/v1/epis/fichas/{servidor_id}",
      "GET  /api/v1/turmas?situacao=EM_ANDAMENTO",
      "GET  /api/v1/turmas/{turma_id}/presencas",
      "POST /api/v1/turmas/{turma_id}/presencas",
    ],
    envios: "todo POST exige o cabeçalho X-Requested-With: fetch",
  });
});

rotas.get(`${PREFIXO}/eu`, async (c) => {
  const usuario = await usuarioLogado(c);
  const corpo: contrato.Eu = {
    id: usuario.id,
    nome: usuario.nome,
    login: usuario.login,
    perfis: [...usuario.perfis],
    permissoes: [...usuario.permissoes].sort(),
    servidor_id: usuario.servidor_id,
    versao: VERSAO,
  };
  return c.json(corpo);
});

// =====================================================================
// A fila de pendências — o "o que eu faço agora?" do app
// =====================================================================
// A âncora de cada pendência vai para o SISTEMA COMPLETO. O mapa é o mesmo de
// `paginas/pendencias.html`, inclusive a permissão que cada porta exige —
// oferecer porta trancada é a mesma mentira do menu, em JSON.
const ANCORAS_POR_ENTIDADE: Readonly<Record<string, readonly [string, string, string]>> = {
  epi_ficha_registro: ["/epis/fichas/registros/", "", "epi.ficha"],
  epi_entrada_estoque: ["/epis/estoque/", "/movimentos", "epi.ver"],
  epi_requisicao: ["/epis/requisicoes/", "", "epi.ver"],
  demanda: ["/demandas/", "", "demanda.ver"],
  turma: ["/turmas/", "?aba=inscricoes", "turma.inscrever"],
};

type Pendencia = typeof tabela_pendencia.$inferSelect;

function _onde(p: Pendencia, usuario: UsuarioAtual): string | null {
  if (p.processo_id && usuario.pode("processo.ver")) return `/processos/${p.processo_id}`;
  if (p.parecer_id && usuario.pode("parecer.ver")) return `/pareceres/${p.parecer_id}`;
  if (p.laudo_id && usuario.pode("laudo.ver")) return `/laudos/${p.laudo_id}`;
  const ancora = Object.hasOwn(ANCORAS_POR_ENTIDADE, p.entidade ?? "") ? ANCORAS_POR_ENTIDADE[p.entidade!] : undefined;
  if (ancora && p.entidade_id && usuario.pode(ancora[2])) return `${ancora[0]}${p.entidade_id}${ancora[1]}`;
  return null;
}

rotas.get(`${PREFIXO}/pendencias`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  servico_pendencias.exigir_ver(usuario);
  const itens = await servico_pendencias.abertas(tx, usuario);
  const de_quem = await servico_pendencias.titular_de(tx, itens);
  const ids_responsaveis = [...new Set(itens.map((p) => p.responsavel_id).filter((x): x is number => x !== null))];
  const responsaveis = new Map(
    ids_responsaveis.length
      ? (
          await tx
            .select({ id: tabela_usuario.id, nome: tabela_usuario.nome })
            .from(tabela_usuario)
            .where(inArray(tabela_usuario.id, ids_responsaveis))
        ).map((u) => [u.id, u.nome])
      : [],
  );
  // "hoje" é o dia em America/Sao_Paulo, não o `date.today()` do processo (UTC na função)
  const dia = hoje();
  const linhas: contrato.PendenciaResumo[] = itens.map((p) => ({
    id: p.id,
    tipo: p.tipo,
    rotulo_tipo: (Object.hasOwn(servico_pendencias.TIPOS, p.tipo) ? servico_pendencias.TIPOS[p.tipo]![0] : p.tipo),
    // a descrição pode citar nome e SIAPE: passa pela RN-19 como na tela
    descricao: String(identificacao.texto_livre(p.descricao, usuario, { sobre: de_quem.get(p.id) ?? null })),
    prazo: p.prazo,
    atrasada: Boolean(p.prazo && servico_pendencias.atrasada(p, dia)),
    responsavel: p.responsavel_id !== null ? (responsaveis.get(p.responsavel_id) ?? null) : null,
    onde: _onde(p, usuario),
  }));
  const corpo: contrato.Pendencias = {
    abertas: linhas.length,
    atrasadas: linhas.filter((l) => l.atrasada).length,
    itens: linhas,
  };
  return c.json(corpo);
});

// =====================================================================
// O balcão de EPI
// =====================================================================
/**
 * Quem pode receber — a busca de `/epis/entregas/servidores`, em JSON. Mesma
 * permissão do balcão (`epi.entregar`) e mesma RN-19 por linha: o SIAPE acha
 * para todo mundo, o nome só acha para quem pode lê-lo.
 */
rotas.get(`${PREFIXO}/epis/servidores`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const s = semente(c);
  const saida: contrato.ServidorResumo[] = [];
  for (const sv of await servico_servidores.buscar(tx, c.req.query("q") ?? "", usuario)) {
    const quem = identificacao.identificar(sv, usuario, s);
    saida.push({ id: sv.id, rotulo: quem.com_siape, nominal: quem.nominal });
  }
  return c.json(saida);
});

type ItemBruto = typeof epi_item.$inferSelect;

function _item_resumo(item: ItemBruto): contrato.ItemResumo {
  return {
    id: item.id,
    nome: item.nome,
    unidade_medida: item.unidade_medida,
    quantidade_padrao: item.quantidade_padrao,
    quantidade_maxima: item.quantidade_maxima,
    regra_de_quantidade: EpiItemDominio.regra_de_quantidade(item),
    tamanhos: EpiItemDominio.lista_de_tamanhos(item),
    exige_ca: item.exige_ca,
    numero_ca: item.numero_ca,
    validade_ca: item.validade_ca,
  };
}

rotas.get(`${PREFIXO}/epis/itens`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const ativos = await c.get("tx").select().from(epi_item).where(eq(epi_item.ativo, true)).orderBy(asc(epi_item.nome));
  return c.json(ativos.map(_item_resumo));
});

/**
 * Os lotes do item, inclusive os impedidos — com o motivo escrito (RN-25). O
 * lote com CA vencido não some da lista: sumir seria saldo mudando sem rastro.
 */
rotas.get(`${PREFIXO}/epis/itens/:item_id{[0-9]+}/lotes`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, id(c, "item_id")));
  if (!item) throw new RecusaDaApi(404, "Item não encontrado no catálogo.");
  const saida: contrato.LoteResumo[] = (await epi_estoque.lotes_de(tx, item)).map((lote) => ({
    entrada_id: lote.entrada.id,
    rotulo: lote.rotulo,
    saldo: lote.saldo,
    impedimento: lote.impedimento,
    pode_sair: lote.pode_sair,
    tamanho: lote.entrada.tamanho,
    numero_ca: lote.entrada.numero_ca,
    validade_ca: lote.entrada.validade_ca,
  }));
  return c.json(saida);
});

/**
 * A entrega inteira, pelo MESMO serviço do balcão — ficha, baixa de estoque e
 * trilha numa transação. As conferências de forma que a tela faz antes do
 * serviço (quem recebe, item, data futura) são as mesmas, com as mesmas frases;
 * o resto — RN-24, RN-25, RN-26 — é do serviço.
 */
rotas.post(`${PREFIXO}/epis/entregas`, async (c) => {
  exigir_fetch(c);
  const usuario = await usuarioLogado(c);
  const corpo = contrato.nova_entrega(await contrato.corpo_json(c.req));
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, corpo.servidor_id));
  if (!servidor) throw new RecusaDaApi(422, "Escolha o servidor que vai receber o EPI.");
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, corpo.item_id));
  if (!item) throw new RecusaDaApi(422, "Escolha o item do catálogo.");
  const entrada = corpo.entrada_id
    ? ((await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, corpo.entrada_id)))[0] ?? null)
    : null;
  if (corpo.entrada_id && entrada === null) throw new RecusaDaApi(422, "Lote de estoque não encontrado.");
  if (corpo.data_evento && corpo.data_evento > hoje()) throw new RecusaDaApi(422, "A entrega não pode ter data futura.");
  let registro;
  try {
    registro = await epi_ficha.registrar_entrega(tx, usuario, {
      servidor,
      item,
      quantidade: corpo.quantidade,
      entrada,
      tamanho: corpo.tamanho,
      data_evento: corpo.data_evento,
      observacao: corpo.observacao,
      justificativa_excecao: corpo.justificativa_excecao,
    });
  } catch (falha) {
    // `EntregaBloqueada` e `TextoProibido` (as duas são `RegraViolada`); a
    // permissão negada sobe inteira para o 403
    if (!(falha instanceof RegraViolada)) throw falha;
    const motivos = (falha as { motivos?: string[] }).motivos;
    throw new RecusaDaApi(422, "A entrega foi recusada.", motivos?.length ? [...motivos] : [falha.message]);
  }
  const saida: contrato.EntregaRegistrada = {
    registro_id: registro.id,
    servidor_id: servidor.id,
    ficha: `/epis/fichas/${servidor.id}`,
    comprovante: `/epis/fichas/registros/${registro.id}/comprovante`,
    mensagem:
      `Entrega registrada (registro ${registro.id}). Imprima o comprovante, ` +
      "colha a assinatura e anexe o digitalizado.",
  };
  return c.json(saida, 201);
});

/** A ficha do servidor — `epi.ficha` ou o próprio titular, como na tela. */
rotas.get(`${PREFIXO}/epis/fichas/:servidor_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const servidor_id = id(c, "servidor_id");
  epi_ficha.exigir_leitura_da_ficha(usuario, servidor_id);
  const tx = c.get("tx");
  const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, servidor_id));
  if (!servidor) throw new RecusaDaApi(404, "Servidor não encontrado.");
  // a MESMA linha de leitura nominal da tela (`/epis/fichas/{id}`): o campo e a
  // finalidade são os de lá, para a consulta de acesso não distinguir a porta
  await auditoria.registrar_leitura_nominal(tx, usuario, "epi_ficha", {
    servidor_id: servidor.id,
    finalidade: "consulta da ficha de EPI do servidor (API)",
  });
  const quem = identificacao.identificar(servidor, usuario, semente(c));
  const dia = hoje();
  const linhas: contrato.LinhaFicha[] = (await epi_ficha.linha_do_tempo(tx, servidor_id)).map((linha) => {
    const r = linha.registro;
    return {
      registro_id: r.id,
      tipo: r.tipo,
      data: r.data_evento,
      epi: r.nome_epi_snapshot,
      quantidade: r.quantidade,
      tamanho: r.tamanho_snapshot,
      numero_ca: r.numero_ca_snapshot,
      validade_ca: r.validade_ca_snapshot,
      lote: r.lote_snapshot,
      previsao_troca: r.previsao_troca,
      estornado: linha.estornado,
      sem_comprovante: linha.sem_comprovante,
      ca_vencido: linha.ca_vencido_em(dia),
      troca_vencida: linha.troca_vencida_em(dia),
    };
  });
  const corpo: contrato.Ficha = { servidor_id: servidor.id, servidor: quem.com_siape, nominal: quem.nominal, linhas };
  return c.json(corpo);
});

// =====================================================================
// A chamada
// =====================================================================
type TurmaComTreinamento = typeof tabela_turma.$inferSelect & { treinamento: { nome: string; carga_horaria_horas: string } };

async function _turma_resumo(c: Ctx, turma: TurmaComTreinamento): Promise<contrato.TurmaResumo> {
  return {
    id: turma.id,
    codigo: turma.codigo,
    treinamento: turma.treinamento.nome,
    situacao: turma.situacao,
    data_inicio: turma.data_inicio,
    data_fim: turma.data_fim,
    dias: servico_presenca.dias_da_turma(turma),
    carga_efetiva: servico_presenca.numero(Turma.carga_efetiva(turma)),
    inscritos: await servico_turma.inscricoes_que_ocupam_vaga(c.get("tx"), turma),
  };
}

/**
 * As turmas no escopo de quem pede, por situação — em andamento por padrão,
 * que é a única em que se lança presença sem retificar.
 */
rotas.get(`${PREFIXO}/turmas`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  const situacao = c.req.query("situacao") ?? "EM_ANDAMENTO";
  if (!Object.hasOwn(ROTULO_TURMA, situacao)) {
    throw new RecusaDaApi(422, `Situação desconhecida: ${situacao}.`, Object.keys(ROTULO_TURMA).sort());
  }
  const turmas = await c.get("tx").query.turma.findMany({
    where: and(servico_turma.consulta_no_escopo(usuario), eq(tabela_turma.situacao, situacao)),
    with: { treinamento: true },
    orderBy: [desc(tabela_turma.data_inicio)],
  });
  const saida: contrato.TurmaResumo[] = [];
  for (const turma of turmas) saida.push(await _turma_resumo(c, turma));
  return c.json(saida);
});

function _linha_presenca(linha: servico_presenca.LinhaDaGrade, pode_nominal: boolean): contrato.LinhaPresenca {
  const participante = linha.inscricao.participante;
  const por_dia: Record<string, contrato.PresencaDia> = {};
  for (const [dia, p] of Object.entries(linha.por_dia)) {
    por_dia[dia] = { presente: p.presente, horas: servico_presenca.numero(p.horas) };
  }
  return {
    inscricao_id: linha.inscricao.id,
    participante: pode_nominal ? nome_exibicao(participante) : participante.identificador_publico,
    nominal: pode_nominal,
    por_dia,
    horas: servico_presenca.numero(linha.horas),
    frequencia: servico_presenca.numero(linha.frequencia),
    aprovado: linha.avaliacao.aprovado,
    situacao: Object.hasOwn(ROTULO_INSCRICAO, linha.inscricao.situacao)
      ? ROTULO_INSCRICAO[linha.inscricao.situacao]!
      : linha.inscricao.situacao,
  };
}

async function _grade(c: Ctx, turma: servico_turma.TurmaCarregada, usuario: UsuarioAtual): Promise<contrato.GradePresenca> {
  // a grade é a lista de chamada transcrita: nomeia a mesma gente que a aba de
  // inscrições, e a permissão que a abre é a que baixa a folha nominal (.docx)
  const pode_nominal = usuario.pode("turma.avaliar");
  return {
    turma_id: turma.id,
    codigo: turma.codigo,
    dias: servico_presenca.dias_da_turma(turma),
    carga_efetiva: servico_presenca.numero(Turma.carga_efetiva(turma)),
    retificando: turma.situacao !== "EM_ANDAMENTO",
    linhas: (await servico_presenca.grade_da_turma(c.get("tx"), turma)).map((l) => _linha_presenca(l, pode_nominal)),
  };
}

rotas.get(`${PREFIXO}/turmas/:turma_id{[0-9]+}/presencas`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  const turma = await servico_turma.no_escopo(c.get("tx"), usuario, id(c, "turma_id"));
  if (!turma) throw new RecusaDaApi(404, "Turma não encontrada ou fora do seu escopo.");
  return c.json(await _grade(c, turma, usuario));
});

/**
 * Um dia, um inscrito — pelo MESMO serviço da grade. Relançar corrige. Devolve
 * a grade inteira: no celular a lista é a folha do dia, e a frequência de quem
 * acabou de ser marcado muda ao lado do nome.
 */
rotas.post(`${PREFIXO}/turmas/:turma_id{[0-9]+}/presencas`, async (c) => {
  exigir_fetch(c);
  const usuario = await usuarioLogado(c);
  const corpo = contrato.nova_presenca(await contrato.corpo_json(c.req));
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const turma = await servico_turma.no_escopo(tx, usuario, id(c, "turma_id"));
  if (!turma) throw new RecusaDaApi(404, "Turma não encontrada ou fora do seu escopo.");
  const inscricao = (await servico_turma.inscricoes_da_turma(tx, turma)).find((i) => i.id === corpo.inscricao_id);
  if (!inscricao) throw new RecusaDaApi(422, "Inscrição não encontrada nesta turma.");
  let horas: string | null = null;
  if (corpo.horas.trim()) {
    horas = servico_presenca.para_decimal(corpo.horas.replace(",", "."));
    // a frase é da rota, como na tela
    if (horas === null) throw new RecusaDaApi(422, "Horas do dia inválidas: informe um número.");
  }
  try {
    await servico_presenca.lancar_presenca(tx, usuario, inscricao, {
      data: corpo.data,
      presente: corpo.presente,
      horas,
      justificativa: corpo.justificativa.trim() || null,
      motivo: corpo.motivo.trim() || null,
    });
  } catch (erro) {
    // RegraDaTurma e TransicaoInvalida (o `ValueError` do Python); a frase é a do serviço
    if (erro instanceof RegraViolada || erro instanceof TransicaoInvalida) {
      throw new RecusaDaApi(422, "O lançamento foi recusado.", [erro.message]);
    }
    throw erro;
  }
  // a grade relida do banco, com a presença que acabou de entrar
  const fresca = (await servico_turma.no_escopo(tx, usuario, turma.id))!;
  return c.json(await _grade(c, fresca, usuario));
});
