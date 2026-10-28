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
import { qr_png } from "../servicos/qr.js";
import * as aviso_interesse from "../servicos/aviso_interesse.js";
import * as vitrine from "../servicos/vitrine.js";
import * as divulgacao from "../servicos/vitrine_divulgacao.js";
import * as anexos from "../servicos/anexos.js";
import * as vitrine_arte from "../servicos/vitrine_arte.js";
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

/** O formulário "Quero ser avisado": os interesses possíveis, o marcado, os campi. */
async function _avise(
  tx: Ambiente["Variables"]["tx"],
  d: { treinamento_id?: number | null; setor?: { id: number; nome: string } | null; erro?: string | null },
) {
  const interesses: { valor: string; rotulo: string }[] = [];
  if (d.treinamento_id) interesses.push({ valor: `TREINAMENTO:${d.treinamento_id}`, rotulo: "Este curso" });
  if (d.setor) interesses.push({ valor: `SETOR:${d.setor.id}`, rotulo: `Cursos do setor ${d.setor.nome}` });
  interesses.push({ valor: "QUALQUER:", rotulo: "Qualquer curso da SISA" });
  return {
    interesses,
    padrao: interesses[0]!.valor,
    campi: (await aviso_interesse.opcoes_do_formulario(tx)).campi,
    texto_de_finalidade: aviso_interesse.TEXTO_DE_FINALIDADE,
    erro: d.erro ?? null,
  };
}

rotas.get(CURSOS, async (c) => {
  const q = (n: string) => (c.req.query(n) ?? "").trim().slice(0, 40);
  const pedida = q("aba");
  const aba = vitrine.ABAS.some((a) => a.chave === pedida) ? (pedida as vitrine.Aba) : "abertas";
  const filtros = { aba, setor: q("setor"), campus: q("campus"), modalidade: q("modalidade") };
  const lista = await vitrine.listar(c.get("tx"), filtros);
  // o setor do filtro vira o interesse já marcado no "Quero ser avisado"
  const setor = filtros.setor ? await vitrine.setor_por_sigla(c.get("tx"), filtros.setor) : null;
  return _publica(
    await pagina(c, "paginas/vitrine.html", null, {
      ...lista,
      avise: await _avise(c.get("tx"), { setor }),
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
  const url_ficha = divulgacao.url_da_ficha(await emissao.url_base_validacao(c.get("tx")), curso.codigo);
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
      avise: await _avise(c.get("tx"), {
        treinamento_id: turma.treinamento_id,
        setor: turma.unidade_promotora ? { id: turma.unidade_promotora.id, nome: turma.unidade_promotora.sigla ?? turma.unidade_promotora.nome_extenso } : null,
      }),
      divulgue: { url: url_ficha, whatsapp: divulgacao.link_whatsapp(curso, url_ficha), email: divulgacao.link_email(curso, url_ficha) },
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

// ---------------------------------------------------------------------
// "Quero ser avisado"
// ---------------------------------------------------------------------
function _sem_cache(r: Response): Response {
  return _publica(r, false);
}

async function _resultado(c: Ctx, modo: string, extra: Record<string, unknown> = {}, status = 200): Promise<Response> {
  return _sem_cache(await pagina(c, "paginas/vitrine_avise.html", null, { modo, ...extra }, status));
}

/** Resolve "TREINAMENTO:12", "SETOR:5" ou "QUALQUER:" em tipo e alvo. */
function _interesse(bruto: string): { tipo: string; alvo: number | null } {
  const [tipo = "", resto = ""] = bruto.split(":");
  const alvo = /^\d{1,9}$/.test(resto) ? Number(resto) : null;
  return { tipo, alvo };
}

rotas.post(`${CURSOS}/avise-me`, async (c) => {
  const inicio = performance.now();
  const tx = c.get("tx");
  const ip = ipDoCliente(c);
  const f = await formulario(c);
  if (!(await inscricao.dentro_do_limite(tx, ip))) return _resultado(c, "limite", {}, 429);
  const { tipo, alvo } = _interesse(f.texto("interesse"));
  const campus = /^\d{1,9}$/.test(f.texto("campus")) ? Number(f.texto("campus")) : null;
  const dados = { nome: f.texto("nome"), email: f.texto("email"), tipo, alvo, campus_id: campus, consentimento: f.texto("consentimento") === "sim" };
  // o campo que gente não vê: robô preenche, e recebe a mesma resposta
  if (!f.texto("site").trim()) {
    try {
      await tx.transaction((sp) => aviso_interesse.cadastrar(sp as typeof tx, dados, ip));
    } catch (erro) {
      if (!(erro instanceof aviso_interesse.CadastroInvalido)) throw erro;
      // e-mail inválido recebe a MESMA resposta do novo e do repetido; os outros erros são do formulário
      if (erro.message !== "email") {
        await inscricao.esperar_o_piso(inicio);
        const msg = "Preencha o nome, escolha o interesse e marque a concordância para receber os avisos.";
        return _sem_cache(
          await pagina(c, "paginas/vitrine_avise.html", null, { modo: "resposta", resposta: msg }, 422),
        );
      }
    }
  }
  void email.acordar_envio();
  await inscricao.esperar_o_piso(inicio);
  return _resultado(c, "resposta", { resposta: aviso_interesse.RESPOSTA_PADRAO });
});

rotas.get(`${CURSOS}/avise-me/confirmar/:token`, async (c) => {
  const ok = await c.get("tx").transaction((sp) => aviso_interesse.confirmar(sp as Parameters<typeof aviso_interesse.confirmar>[0], c.req.param("token")));
  return _resultado(c, ok ? "confirmado" : "confirmar_invalido", {}, ok ? 200 : 410);
});

// abrir o link NÃO cancela (o leitor de e-mail pré-carrega links): só o POST
rotas.get(`${CURSOS}/avise-me/sair/:token`, async (c) => {
  const token = c.req.param("token");
  if (!(await aviso_interesse.saida_valida(c.get("tx"), token))) return _resultado(c, "sair_invalido", {}, 404);
  return _resultado(c, "sair", { token });
});

rotas.post(`${CURSOS}/avise-me/sair/:token`, async (c) => {
  const ok = await c.get("tx").transaction((sp) => aviso_interesse.descadastrar(sp as Parameters<typeof aviso_interesse.descadastrar>[0], c.req.param("token")));
  return _resultado(c, ok ? "saiu" : "sair_invalido", {}, ok ? 200 : 404);
});

/** A ficha de um código, só se estiver publicada e viva; senão 404 sem corpo útil. */
async function _publicada(c: Ctx) {
  const f = await vitrine.ficha(c.get("tx"), c.req.param("codigo") ?? "");
  return f.tipo === "ok" ? f.curso : null;
}

function _arquivo(corpo: ConstructorParameters<typeof Response>[0], tipo: string, nome: string | null): Response {
  const r = new Response(corpo, { headers: { "content-type": tipo } });
  if (nome) r.headers.set("content-disposition", `attachment; filename="${nome}"`);
  return _publica(r);
}

/**
 * A arte enviada, só enquanto a turma está divulgada e viva. O tipo sai fixo, o
 * que foi conferido nos bytes; `nosniff` e `inline` impedem que vire página. O
 * endereço leva `?v=<anexo>`: trocar a arte troca o endereço, então o cache de
 * um dia não segura a arte velha.
 */
rotas.get(`${CURSOS}/:codigo/arte`, async (c) => {
  const f = await vitrine.ficha(c.get("tx"), c.req.param("codigo") ?? "");
  if (f.tipo !== "ok") return _publica(new Response("Não encontrado", { status: 404 }), false);
  const anexo = await vitrine_arte.vigente(c.get("tx"), f.turma);
  if (!anexo) return _publica(new Response("Não encontrado", { status: 404 }), false);
  const r = new Response((await anexos.ler_conteudo(anexo)) as unknown as ArrayBuffer, {
    headers: {
      "content-type": anexos.tipo_para_servir(anexo.mime_type),
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "public, max-age=86400",
      etag: `"${anexo.sha256}"`,
    },
  });
  return r;
});

rotas.get(`${CURSOS}/:codigo/qr.png`, async (c) => {
  const curso = await _publicada(c);
  if (!curso) return _publica(new Response("Não encontrado", { status: 404 }), false);
  const url = divulgacao.url_da_ficha(await emissao.url_base_validacao(c.get("tx")), curso.codigo);
  return _arquivo(qr_png(url, 6), "image/png", null);
});

rotas.get(`${CURSOS}/:codigo/cartaz.pdf`, async (c) => {
  const curso = await _publicada(c);
  if (!curso) return _publica(new Response("Não encontrado", { status: 404 }), false);
  const url = divulgacao.url_da_ficha(await emissao.url_base_validacao(c.get("tx")), curso.codigo);
  return _arquivo(await divulgacao.cartaz_pdf(curso, url), "application/pdf", `cartaz-${curso.codigo}.pdf`);
});

rotas.get(`${CURSOS}/:codigo/agenda.ics`, async (c) => {
  const curso = await _publicada(c);
  if (!curso) return _publica(new Response("Não encontrado", { status: 404 }), false);
  const a = divulgacao.agenda(curso, await emissao.url_base_validacao(c.get("tx")));
  return _arquivo(a.texto, "text/calendar; charset=utf-8", a.nome);
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
