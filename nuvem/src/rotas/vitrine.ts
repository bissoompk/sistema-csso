/**
 * /cursos e /cursos/:codigo — a vitrine pública de cursos da SISA: sem conta,
 * sem cookie de rastreio e sem dado pessoal. A regra mora em
 * `servicos/vitrine.ts`; o pedido de vaga grava pelo mesmo `inscricao_publica.pedir`
 * do link por token (mesmo limite por IP, mesmo campo-isca, mesma resposta).
 *
 * Diferença do `/inscricao/:token`: a turma divulgada é pública por definição, e
 * a página pode ser indexada. O POST, ao contrário, nunca é cacheado.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import { ROTULO_VINCULO } from "../dominio/treinamento.js";
import * as email from "../servicos/email.js";
import * as emissao from "../servicos/emissao_certificado.js";
import * as inscricao from "../servicos/inscricao_publica.js";
import { RegraDaTurma } from "../servicos/turma.js";
import * as vitrine from "../servicos/vitrine.js";
import { pagina, redirecionar } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";
import { COOKIE_RECEBIDO } from "./inscricao_publica.js";

export const rotas = new Hono<Ambiente>();

export const CURSOS = "/cursos";
const VIDA_RECEBIDO_S = 15 * 60;
const VAZIO: inscricao.Pedido = { nome: "", vinculo: "", siape: "", email: "", organizacao: "", consentimento: false };

function _publica(resposta: Response, cache = true): Response {
  resposta.headers.set("cache-control", cache ? "public, max-age=300" : "no-store");
  return resposta;
}

rotas.get(CURSOS, async (c) => {
  const q = (n: string) => (c.req.query(n) ?? "").trim().slice(0, 40);
  const pedida = q("aba");
  const aba = vitrine.ABAS.some((a) => a.chave === pedida) ? (pedida as vitrine.Aba) : "abertas";
  const filtros = { aba, setor: q("setor"), campus: q("campus"), modalidade: q("modalidade") };
  const lista = await vitrine.listar(c.get("tx"), filtros);
  return _publica(
    await pagina(c, "paginas/vitrine.html", null, {
      ...lista,
      filtros,
      abas: vitrine.ABAS,
      modalidades: vitrine.MODALIDADES,
    }),
  );
});

async function _ficha(
  c: Ctx,
  d: { pedido?: inscricao.Pedido; erro?: string | null; recebido?: boolean; excedeu?: boolean; status?: number } = {},
): Promise<Response> {
  const f = await vitrine.ficha(c.get("tx"), c.req.param("codigo") ?? "");
  if (f.tipo === "inexistente") return _publica(await pagina(c, "paginas/vitrine_curso.html", null, { curso: null }, 404), false);
  if (f.tipo === "encerrada") {
    return _publica(await pagina(c, "paginas/vitrine_curso.html", null, { curso: null, encerrada: true }, 410), false);
  }
  const { turma, curso } = f;
  const promotor = curso.setor?.sigla ?? "";
  const resposta = await pagina(
    c,
    "paginas/vitrine_curso.html",
    null,
    {
      curso,
      pedido: d.pedido ?? VAZIO,
      erro_formulario: d.erro ?? null,
      recebido: d.recebido ? _ler_recebido(c) : null,
      excedeu: d.excedeu ?? false,
      resposta_padrao: inscricao.RESPOSTA_PADRAO,
      linha_neutra: inscricao.LINHA_NEUTRA,
      vinculos: inscricao.VINCULOS_DA_UFVJM,
      vinculos_externos: turma.aceita_comunidade_externa ? inscricao.VINCULOS_COMUNIDADE_EXTERNA : [],
      rotulo_externos: inscricao.ROTULO_COMUNIDADE_EXTERNA,
      rotulo_vinculo: ROTULO_VINCULO,
      publico: inscricao.publico_da_turma(turma),
      equipe_de: promotor ? ` da ${promotor}` : " responsável",
      acao: `${CURSOS}/${curso.codigo}/inscricao`,
    },
    d.status ?? 200,
  );
  // com formulário na resposta (erro, recebido) a página é pessoal: sem cache
  return _publica(resposta, !d.pedido && !d.recebido && !d.excedeu);
}

function _ler_recebido(c: Ctx): { nome: string; email: string } | null {
  const bruto = getCookie(c, COOKIE_RECEBIDO);
  if (!bruto) return null;
  try {
    const dado = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as { nome?: unknown; email?: unknown };
    if (typeof dado.nome !== "string" || typeof dado.email !== "string") return null;
    return { nome: dado.nome.slice(0, 160), email: dado.email.slice(0, 160) };
  } catch {
    return null;
  }
}

rotas.get(`${CURSOS}/:codigo`, async (c) => {
  const caminho = `${CURSOS}/${c.req.param("codigo")}`;
  if (c.req.query("novo") !== undefined) {
    deleteCookie(c, COOKIE_RECEBIDO, { path: caminho });
    return _ficha(c);
  }
  return _ficha(c, { recebido: Boolean(getCookie(c, COOKIE_RECEBIDO)) });
});

rotas.post(`${CURSOS}/:codigo/inscricao`, async (c) => {
  const inicio = performance.now();
  const tx = c.get("tx");
  const ip = ipDoCliente(c);
  const f = await formulario(c);
  const pedido: inscricao.Pedido = {
    nome: f.texto("nome"),
    vinculo: f.texto("vinculo"),
    siape: f.texto("siape"),
    email: f.texto("email"),
    organizacao: f.texto("organizacao"),
    consentimento: f.texto("consentimento") === "sim",
  };
  // o limite vem antes de olhar a turma: o mesmo contador do /inscricao
  if (!(await inscricao.dentro_do_limite(tx, ip))) return _ficha(c, { pedido, excedeu: true, status: 429 });
  const achada = await vitrine.ficha(tx, c.req.param("codigo") ?? "");
  if (achada.tipo !== "ok") return _ficha(c, { pedido });
  const { turma, curso } = achada;
  // turma fechada ou cheia: a ficha mostra o motivo, sem gravar nada
  if (!curso.aberta || curso.cheia) return _ficha(c, { pedido });
  // o campo que gente não vê: robô preenche, e recebe a mesma resposta
  if (!f.texto("site").trim()) {
    try {
      const base_url = await emissao.url_base_validacao(tx);
      await tx.transaction((sp) => inscricao.pedir(sp as typeof tx, turma, pedido, ip, null, new Date(), base_url));
    } catch (erro) {
      if (erro instanceof inscricao.PedidoInvalido || erro instanceof RegraDaTurma) {
        return _ficha(c, { pedido, erro: erro.message, status: 422 });
      }
      throw erro;
    }
  }
  void email.acordar_envio();
  await inscricao.esperar_o_piso(inicio);
  const recebido = { nome: pedido.nome.trim().replace(/\s+/g, " "), email: pedido.email.trim() };
  setCookie(c, COOKIE_RECEBIDO, Buffer.from(JSON.stringify(recebido), "utf8").toString("base64url"), {
    path: `${CURSOS}/${curso.codigo}`,
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: VIDA_RECEBIDO_S,
  });
  return _publica(redirecionar(c, `${CURSOS}/${curso.codigo}#inscricao`), false);
});
