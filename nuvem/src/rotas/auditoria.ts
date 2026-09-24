/**
 * /auditoria — trilha append-only com diff campo a campo.
 * Porte de `app/rotas/auditoria.py`.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { acesso_dado_sensivel, historico_evento, usuario as tabela_usuario } from "../db/esquema/index.js";
import {
  ConferenciaEmCurso,
  conferir_fora_da_transacao,
  janela_integra,
  ultima_conferencia,
} from "../servicos/auditoria.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { pagina } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const POR_PAGINA = 100;

function _inteiro(bruto: string | undefined | null): number | null {
  return bruto && /^\d+$/.test(bruto) ? Number(bruto) : null;
}

async function _trilha(c: Ctx, usuario: UsuarioAtual, recado: { mensagem?: string | null; erro?: string | null } = {}) {
  usuario.exigir("auditoria.ver");
  const tx = c.get("tx");
  // num POST (conferir) os filtros não viajam: a tela volta à primeira página
  const get = c.req.method === "GET";
  const filtro_usuario = get ? _inteiro(c.req.query("usuario_id")) : null;
  const filtro_entidade = (get && c.req.query("entidade")) || null;
  const filtro_tipo = (get && c.req.query("tipo_evento")) || null;
  const pagina_num = (get && _inteiro(c.req.query("pagina_num"))) || 1;

  const condicoes: (SQL | undefined)[] = [];
  if (filtro_usuario) condicoes.push(eq(historico_evento.usuario_id, filtro_usuario));
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
  return pagina(c, "paginas/auditoria.html", usuario, {
    eventos,
    janela_ok: ok,
    janela_defeito: defeito,
    conferencia: await ultima_conferencia(tx),
    tipos,
    entidades,
    filtro_usuario,
    filtro_entidade,
    filtro_tipo,
    pagina_num,
    mensagem: recado.mensagem ?? (get ? c.req.query("mensagem") : null) ?? null,
    erro: recado.erro ?? (get ? c.req.query("erro") : null) ?? null,
    usuarios: await tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome)),
    acessos: await tx.select().from(acesso_dado_sensivel).orderBy(desc(acesso_dado_sensivel.id)).limit(50),
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
