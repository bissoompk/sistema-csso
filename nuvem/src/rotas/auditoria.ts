/**
 * /auditoria — trilha append-only com diff campo a campo.
 * Porte de `app/rotas/auditoria.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import {
  acesso_dado_sensivel,
  atribuicao,
  historico_evento,
  profissional_habilitado,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import {
  BOOTSTRAP_SUPERINTENDENTE,
  CONTA_BLOQUEADA,
  ConferenciaEmCurso,
  PERMISSAO_ACRESCENTADA_AO_PERFIL,
  PERMISSAO_RETIRADA_DO_PERFIL,
  SENHA_TROCADA,
  conferir_fora_da_transacao,
  janela_integra,
  ultima_conferencia,
} from "../servicos/auditoria.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import * as identificacao from "../servicos/identificacao.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { pagina } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const POR_PAGINA = 100;
export const ACESSOS_POR_PAGINA = 50;

/**
 * Os eventos de CONTA, SENHA, BACKUP e EXPORTAÇÃO, cuja descrição o perfil que
 * audita lê mesmo sem `exposicao.ver` (M67). A lista é explícita, por tipo, e
 * não um prefixo: tipo novo entra suprimido até alguém olhar o que ele grava.
 * O texto deles é de governança de acesso — "Conta 'x' inativada", "Perfil y
 * concedido — ato: Portaria z", "backup_….enc (… bytes)" — e não do trabalho
 * técnico. Sem isto o `admin_ti`, que existe para auditar acesso, lia
 * "conteúdo suprimido (RN-19)" até nos eventos que ele mesmo gerou.
 *
 * O que continua passando pela RN-19 é a conta ligada a servidor: o login
 * dela pode ser o nome da pessoa, e a frase sai suprimida para quem não lê o
 * nome daquele servidor (`descricao_na_tela`). Nada aqui muda o texto gravado,
 * que é o que entra no hash da cadeia.
 */
export const EVENTOS_DE_CONTA_E_SISTEMA: ReadonlySet<string> = new Set([
  "USUARIO_CRIADO",
  "USUARIO_ATIVADO",
  "USUARIO_INATIVADO",
  "SENHA_RESETADA",
  "SENHA_RESET_RECUSADO",
  SENHA_TROCADA,
  CONTA_BLOQUEADA,
  PERMISSAO_ACRESCENTADA_AO_PERFIL,
  PERMISSAO_RETIRADA_DO_PERFIL,
  "SERVIDOR_VINCULADO",
  "SERVIDOR_DESVINCULADO",
  "PERFIL_CONCEDIDO",
  "PERFIL_ENCERRADO",
  // a governança da conta e da habilitação (D2, D3, D7, D10, D11, D23): são
  // justamente os eventos que quem audita acesso precisa ler
  "PERFIL_CANCELADO",
  "PERFIL_CONCESSAO_RECUSADA",
  "USUARIO_ALTERADO",
  "CONTA_DESBLOQUEADA",
  "HABILITACAO_ENCERRADA",
  "HABILITACAO_CORRIGIDA",
  "HABILITACAO_RECUSADA",
  "ATO_NORMATIVO_ALTERADO",
  BOOTSTRAP_SUPERINTENDENTE,
  "BACKUP_EXECUTADO",
  "EXPORTACAO_COMPLETA",
]);

type Evento = typeof historico_evento.$inferSelect;

/**
 * A conta de que cada evento de conta fala (o `entidade_id` do `usuario`, ou a
 * dona da atribuição) e o servidor a que ela está ligada hoje — numa consulta
 * por tabela, não por linha.
 */
async function _servidor_das_contas(tx: Executor, eventos: Evento[]) {
  const do_tipo = eventos.filter((e) => EVENTOS_DE_CONTA_E_SISTEMA.has(e.tipo_evento));
  const ids_atribuicao = do_tipo.filter((e) => e.entidade === "atribuicao").map((e) => e.entidade_id);
  const dona = new Map<number, number>();
  if (ids_atribuicao.length) {
    for (const a of await tx
      .select({ id: atribuicao.id, usuario_id: atribuicao.usuario_id })
      .from(atribuicao)
      .where(inArray(atribuicao.id, ids_atribuicao))) {
      dona.set(a.id, a.usuario_id);
    }
  }
  // a habilitação fala da conta a que está ligada: o servidor dela é o envolvido
  const ids_habilitacao = do_tipo.filter((e) => e.entidade === "profissional_habilitado").map((e) => e.entidade_id);
  const conta_da_habilitacao = new Map<number, number | null>();
  if (ids_habilitacao.length) {
    for (const h of await tx
      .select({ id: profissional_habilitado.id, usuario_id: profissional_habilitado.usuario_id })
      .from(profissional_habilitado)
      .where(inArray(profissional_habilitado.id, ids_habilitacao))) {
      conta_da_habilitacao.set(h.id, h.usuario_id);
    }
  }
  const conta_do_evento = new Map<number, number | null>();
  for (const e of do_tipo) {
    if (e.entidade === "usuario") conta_do_evento.set(e.id, e.entidade_id);
    else if (e.entidade === "atribuicao") conta_do_evento.set(e.id, dona.get(e.entidade_id) ?? null);
    else if (e.entidade === "profissional_habilitado") {
      conta_do_evento.set(e.id, conta_da_habilitacao.get(e.entidade_id) ?? null);
    }
  }
  const contas = [...new Set([...conta_do_evento.values()].filter((v): v is number => v !== null))];
  const servidor_da_conta = new Map<number, number | null>();
  if (contas.length) {
    for (const u of await tx
      .select({ id: tabela_usuario.id, servidor_id: tabela_usuario.servidor_id })
      .from(tabela_usuario)
      .where(inArray(tabela_usuario.id, contas))) {
      servidor_da_conta.set(u.id, u.servidor_id);
    }
  }
  return { conta_do_evento, servidor_da_conta };
}

/**
 * A descrição que a tela escreve. Fora da lista, a regra de sempre
 * (`texto_livre`: a frase inteira, ou suprimida). Na lista: evento de sistema
 * sai inteiro; evento de conta sai inteiro se nenhum servidor está envolvido —
 * nem o ligado hoje à conta, nem o de antes ou depois de um vínculo — ou se
 * quem lê pode ver o nome de todos eles.
 */
function descricao_na_tela(
  e: Evento,
  usuario: UsuarioAtual,
  contas: Awaited<ReturnType<typeof _servidor_das_contas>>,
): string {
  if (!e.descricao) return "—";
  if (!EVENTOS_DE_CONTA_E_SISTEMA.has(e.tipo_evento)) return identificacao.texto_livre(e.descricao, usuario, { vazio: "—" });
  // o perfil não é de ninguém: a frase diz o código do perfil e o da permissão
  if (e.entidade === "sistema" || e.entidade === "perfil") return e.descricao;
  const conta = contas.conta_do_evento.get(e.id);
  if (conta === undefined || conta === null) return identificacao.texto_livre(e.descricao, usuario, { vazio: "—" });
  const envolvidos = [contas.servidor_da_conta.get(conta) ?? null];
  if (e.campo === "servidor_id") envolvidos.push(_inteiro(e.valor_anterior), _inteiro(e.valor_novo));
  const todos_visiveis = envolvidos
    .filter((id): id is number => id !== null)
    .every((id) => identificacao.pode_ver_nominal(usuario, id));
  return todos_visiveis ? e.descricao : identificacao.TEXTO_SUPRIMIDO;
}

/**
 * Os eventos que FALAM de uma conta (D21), qualquer que seja quem agiu: os da
 * própria conta (criação, senha, bloqueio, vínculo com servidor), os das
 * concessões dela, e os das habilitações ligadas a ela hoje ou que um dia
 * foram ligadas ou desligadas dela. O filtro "Usuário" responde "o que esta
 * pessoa fez"; este responde "o que fizeram com esta conta" — a pergunta de
 * quem revisa um acesso. É a URL do "Histórico desta conta".
 */
function _da_conta(conta_id: number): SQL {
  const id_texto = String(conta_id);
  const habilitacoes = sql`(select ${profissional_habilitado.id} from ${profissional_habilitado} where ${profissional_habilitado.usuario_id} = ${conta_id})`;
  const atribuicoes = sql`(select ${atribuicao.id} from ${atribuicao} where ${atribuicao.usuario_id} = ${conta_id})`;
  return or(
    and(eq(historico_evento.entidade, "usuario"), eq(historico_evento.entidade_id, conta_id)),
    and(eq(historico_evento.entidade, "atribuicao"), sql`${historico_evento.entidade_id} in ${atribuicoes}`),
    and(
      eq(historico_evento.entidade, "profissional_habilitado"),
      or(
        sql`${historico_evento.entidade_id} in ${habilitacoes}`,
        and(
          eq(historico_evento.campo, "usuario_id"),
          or(
            sql`(${historico_evento.valor_anterior} #>> '{}') = ${id_texto}`,
            sql`(${historico_evento.valor_novo} #>> '{}') = ${id_texto}`,
          ),
        ),
      ),
    ),
  )!;
}

function _inteiro(bruto: unknown): number | null {
  const texto = bruto === null || bruto === undefined ? "" : String(bruto);
  return /^\d+$/.test(texto) ? Number(texto) : null;
}

async function _trilha(c: Ctx, usuario: UsuarioAtual, recado: { mensagem?: string | null; erro?: string | null } = {}) {
  usuario.exigir("auditoria.ver");
  const tx = c.get("tx");
  // num POST (conferir) os filtros não viajam: a tela volta à primeira página
  const get = c.req.method === "GET";
  const filtro_usuario = get ? _inteiro(c.req.query("usuario_id")) : null;
  const filtro_conta = get ? _inteiro(c.req.query("conta_id")) : null;
  const filtro_entidade = (get && c.req.query("entidade")) || null;
  const filtro_tipo = (get && c.req.query("tipo_evento")) || null;
  const pagina_num = (get && _inteiro(c.req.query("pagina_num"))) || 1;
  const pagina_acessos = (get && _inteiro(c.req.query("pagina_acessos"))) || 1;

  const condicoes: (SQL | undefined)[] = [];
  if (filtro_usuario) condicoes.push(eq(historico_evento.usuario_id, filtro_usuario));
  if (filtro_conta) condicoes.push(_da_conta(filtro_conta));
  if (filtro_entidade) condicoes.push(eq(historico_evento.entidade, filtro_entidade));
  if (filtro_tipo) condicoes.push(eq(historico_evento.tipo_evento, filtro_tipo));
  const eventos = await tx
    .select()
    .from(historico_evento)
    .where(and(...condicoes))
    .orderBy(desc(historico_evento.id))
    .limit(POR_PAGINA)
    .offset((Math.max(pagina_num, 1) - 1) * POR_PAGINA);
  // A JANELA, e não a cadeia inteira (Q-2): o que a pessoa tem diante dos olhos
  // são 100 eventos, e conferir os 100 não cresce com a idade do sistema.
  const [ok, defeito] = await janela_integra(tx, eventos);
  const tipos = (await tx.selectDistinct({ t: historico_evento.tipo_evento }).from(historico_evento)).map((l) => l.t).sort();
  const entidades = (await tx.selectDistinct({ e: historico_evento.entidade }).from(historico_evento)).map((l) => l.e).sort();
  // RN-19 no "antes → depois": a janela acima confere o gravado; a tela recebe
  // a cópia com o valor nominal suprimido para quem não lê nome.
  const contas = await _servidor_das_contas(tx, eventos);
  const eventos_tela = eventos.map((e) => ({
    ...e,
    valor_anterior: identificacao.valor_da_trilha(e.valor_anterior, e.campo, usuario),
    valor_novo: identificacao.valor_da_trilha(e.valor_novo, e.campo, usuario),
    descricao_tela: descricao_na_tela(e, usuario, contas),
  }));
  // Os acessos a dado sensível com o NOME da conta que leu (era "#7"), como a
  // coluna "Usuário" da trilha acima, e paginados: um a mais diz se há próxima.
  const acessos = await tx
    .select({
      id: acesso_dado_sensivel.id,
      ocorrido_em: acesso_dado_sensivel.ocorrido_em,
      usuario_id: acesso_dado_sensivel.usuario_id,
      usuario_nome: tabela_usuario.nome,
      usuario_login: tabela_usuario.login,
      campo: acesso_dado_sensivel.campo,
      servidor_id: acesso_dado_sensivel.servidor_id,
      finalidade: acesso_dado_sensivel.finalidade,
    })
    .from(acesso_dado_sensivel)
    .leftJoin(tabela_usuario, eq(tabela_usuario.id, acesso_dado_sensivel.usuario_id))
    .orderBy(desc(acesso_dado_sensivel.id))
    .limit(ACESSOS_POR_PAGINA + 1)
    .offset((pagina_acessos - 1) * ACESSOS_POR_PAGINA);
  // os filtros viajam na paginação da trilha: sem eles, "próxima" devolvia a
  // trilha inteira a partir da página 2
  const eixos = new URLSearchParams();
  if (filtro_usuario) eixos.set("usuario_id", String(filtro_usuario));
  if (filtro_conta) eixos.set("conta_id", String(filtro_conta));
  if (filtro_entidade) eixos.set("entidade", filtro_entidade);
  if (filtro_tipo) eixos.set("tipo_evento", filtro_tipo);
  return pagina(c, "paginas/auditoria.html", usuario, {
    eventos: eventos_tela,
    janela_ok: ok,
    janela_defeito: defeito,
    conferencia: await ultima_conferencia(tx),
    tipos,
    entidades,
    filtro_usuario,
    filtro_conta,
    filtro_entidade,
    filtro_tipo,
    pagina_num,
    mensagem: recado.mensagem ?? (get ? c.req.query("mensagem") : null) ?? null,
    erro: recado.erro ?? (get ? c.req.query("erro") : null) ?? null,
    usuarios: await tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome)),
    acessos: acessos.slice(0, ACESSOS_POR_PAGINA),
    acessos_ha_mais: acessos.length > ACESSOS_POR_PAGINA,
    pagina_acessos,
    acessos_por_pagina: ACESSOS_POR_PAGINA,
    eixos: eixos.toString(),
  });
}

rotas.get("/auditoria", async (c) => _trilha(c, await usuarioLogado(c)));

/**
 * O passe completo, sob demanda. POST, e não GET: é um efeito colateral (uma
 * linha em `conferencia_cadeia`) e uma varredura da trilha inteira. Quem abre
 * a trilha pode conferi-la.
 */
rotas.post("/auditoria/conferir", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("auditoria.ver");
  let resultado;
  try {
    resultado = await conferir_fora_da_transacao(c.get("tx"), { usuario });
  } catch (falha) {
    if (!(falha instanceof ConferenciaEmCurso)) throw falha;
    return _trilha(c, usuario, { erro: falha.message });
  }
  if (resultado.integra) {
    return _trilha(c, usuario, {
      mensagem: `Cadeia conferida: ${resultado.eventos} evento(s), encadeamento íntegro (${resultado.duracao_ms} ms).`,
    });
  }
  return _trilha(c, usuario, {
    erro:
      `O encadeamento não fecha a partir do evento ${resultado.primeiro_defeito_id}. ` +
      "Preserve o banco como está e trate como incidente.",
  });
});
