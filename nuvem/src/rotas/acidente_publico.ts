/**
 * A comunicação de acidente por link (fatia F2): `/acidente/:token`, aberto e
 * sem conta, e a tela da equipe que gera e desliga o link (`/acidentes/link`).
 * A regra mora em `servicos/acidente_publico.ts`.
 *
 * Como `/inscricao/:token`: sem sessão, `noindex`, `no-store` e
 * `referrer-policy: no-referrer` (o token está no caminho). O envio aceito
 * responde 303 para o próprio link, e o GET mostra o protocolo — recarregar não
 * reenvia. O protocolo viaja num cookie curto, preso ao caminho deste link e a
 * este navegador; nunca na URL.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { acidentesLiberado } from "../config.js";
import { campus as tabela_campus } from "../db/esquema/index.js";
import { asc } from "drizzle-orm";
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import * as comunicacao from "../servicos/acidente_comunicacao.js";
import * as servico from "../servicos/acidente_publico.js";
import { hoje } from "../servicos/datas_br.js";
import { comMensagem, pagina, redirecionar } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

/** O cookie do "comunicação recebida": 30 minutos, preso ao caminho do token. */
export const COOKIE_RECEBIDO = "csso_acidente_recebido";
const VIDA_RECEBIDO_S = 30 * 60;
/** Quantos envolvidos o formulário por link mostra (o 1º é obrigatório). */
export const ENVOLVIDOS_NO_LINK = 3;
export const TESTEMUNHAS_NO_LINK = 2;

const _modulo_liberado = async (_c: Ctx, seguir: () => Promise<void>) => {
  if (!acidentesLiberado()) throw new ErroHttp(404, "Página não encontrada.");
  await seguir();
};
rotas.use(`${servico.CAMINHO}/*`, _modulo_liberado);

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

function _ler_recebido(c: Ctx): string | null {
  const bruto = getCookie(c, COOKIE_RECEBIDO) ?? "";
  // "OK" é a resposta do campo-isca: recebida, sem protocolo
  return bruto === "OK" || /^CAT-\d{4}-\d{4,}$/.test(bruto) ? bruto : null;
}

async function _tela(
  c: Ctx,
  d: {
    link: servico.Link | null;
    digitado?: Record<string, unknown>;
    erro?: string | null;
    recebido?: string | null;
    excedeu?: boolean;
    status?: number;
  },
): Promise<Response> {
  const saida = await pagina(
    c,
    "paginas/acidente_publico.html",
    null,
    {
      ...acidentes.CONTEXTO_FORM,
      ...(d.link ? await acidentes.catalogos(c) : {}),
      link: d.link,
      d: d.digitado ?? {},
      erro_formulario: d.erro ?? null,
      recebido: d.recebido ?? null,
      excedeu: d.excedeu ?? false,
      envolvidos_no_link: ENVOLVIDOS_NO_LINK,
      testemunhas_no_link: TESTEMUNHAS_NO_LINK,
      hoje: hoje(),
      acao: c.req.path,
    },
    d.status ?? (d.link ? 200 : 404),
  );
  return _sem_rastro(saida);
}

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const link = await servico.link_do_token(c.get("tx"), c.req.param("token"));
  if (c.req.query("novo") !== undefined) {
    deleteCookie(c, COOKIE_RECEBIDO, { path: c.req.path });
    return _tela(c, { link });
  }
  return _tela(c, { link, recebido: link ? _ler_recebido(c) : null });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  const tx = c.get("tx");
  const ip = ipDoCliente(c);
  const f = await formulario(c);
  const digitado = acidentes.digitado(f);
  // o limite vem antes de olhar o token: senão ele vira o oráculo do token
  if (!(await servico.dentro_do_limite(tx, ip))) {
    return _tela(c, { link: null, digitado, excedeu: true, status: 429 });
  }
  const link = await servico.link_do_token(tx, c.req.param("token"));
  if (!link) return _tela(c, { link: null });
  let protocolo: string;
  if (f.texto("site").trim()) {
    // o robô que preencheu o campo-isca recebe a mesma resposta, sem gravar nada
    await servico.registrar_isca(tx, link);
    protocolo = "";
  } else {
    if (f.texto("consentimento") !== "1") {
      return _tela(c, {
        link,
        digitado,
        erro: "Marque que leu o aviso de privacidade para enviar a comunicação.",
        status: 422,
      });
    }
    const indices = Array.from({ length: ENVOLVIDOS_NO_LINK }, (_v, i) => i + 1);
    // os cartões vazios (sem nome) não contam; o 1º é obrigatório
    const envolvidos = acidentes
      .ler_envolvidos(f, indices)
      .filter((e, i) => i === 0 || (e.nome_externo ?? "").trim())
      // um campo só para "SIAPE, matrícula ou crachá": 7 dígitos é SIAPE, o resto é identificação externa
      .map((e) => {
        const bruto = (e.siape ?? "").trim();
        return /^\d{7}$/.test(bruto) ? e : { ...e, siape: null, identificacao_externa: bruto || null };
      });
    const dados: comunicacao.DadosComunicacao = {
      fatos: acidentes.ler_fatos(f),
      relato: acidentes.ler_relato(f),
      envolvidos,
      testemunhas: acidentes.ler_testemunhas(f),
      sou_chefia: false,
      declarou_veracidade: f.texto("declaracao") === "1",
      comunicante: { nome: f.texto("com_nome"), email: f.texto("com_email"), vinculo: f.texto("com_vinculo") },
      token_envio: f.texto("envio"),
    };
    try {
      const oc = await tx.transaction((sp) => servico.comunicar(sp, link, dados, ip));
      protocolo = oc.protocolo;
    } catch (erro) {
      if (!(erro instanceof RegraViolada)) throw erro;
      return _tela(c, { link, digitado, erro: erro.message, status: erro instanceof servico.TetoAtingido ? 503 : 422 });
    }
  }
  // o robô ganha o mesmo 303 e a mesma tela "recebida", sem protocolo
  setCookie(c, COOKIE_RECEBIDO, protocolo || "OK", {
    path: c.req.path,
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: VIDA_RECEBIDO_S,
  });
  return _sem_rastro(redirecionar(c, c.req.path));
});

// =====================================================================
// A equipe: o link do setor
// =====================================================================
export const LINK = "/acidentes/link";

async function _porta_equipe(c: Ctx) {
  const usuario = await usuarioLogado(c);
  usuario.exigir("acidente.triar");
  exigir_acesso_ao_modulo(usuario, "acidentes");
  return usuario;
}

async function _tela_link(c: Ctx, usuario: Awaited<ReturnType<typeof _porta_equipe>>, extra: Record<string, unknown> = {}) {
  const tx = c.get("tx");
  const resposta = await pagina(c, "paginas/acidente_link.html", usuario, {
    links: await servico.links_ativos(tx),
    campi: await tx.select().from(tabela_campus).orderBy(asc(tabela_campus.sigla)),
    em_espera: await servico.em_espera(tx),
    teto: servico.ajuste.teto_em_espera,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
    ...extra,
  });
  // a tela que mostra o link novo não fica em cache
  resposta.headers.set("cache-control", "no-store");
  return resposta;
}

rotas.get(LINK, async (c) => {
  const usuario = await _porta_equipe(c);
  return _tela_link(c, usuario);
});

rotas.post(LINK, async (c) => {
  const usuario = await _porta_equipe(c);
  const f = await formulario(c);
  let token: string;
  try {
    token = await c.get("tx").transaction((sp) => servico.gerar_link(sp, usuario, f.inteiro("campus_id")));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return redirecionar(c, comMensagem(LINK, erro.message, "erro"));
  }
  // o token aparece UMA vez, nesta resposta; o banco só tem o hash
  const origem = (process.env.CSSO_URL_PUBLICA || new URL(c.req.url).origin).replace(/\/+$/, "");
  return _tela_link(c, usuario, { link_novo: `${origem}${servico.CAMINHO}/${token}` });
});

rotas.post(`${LINK}/:id{[0-9]+}/desligar`, async (c) => {
  const usuario = await _porta_equipe(c);
  await c.get("tx").transaction((sp) => servico.desligar_link(sp, usuario, Number(c.req.param("id"))));
  return redirecionar(c, comMensagem(LINK, "Link desligado. Quem abrir o endereço antigo vê “link inválido”."));
});
