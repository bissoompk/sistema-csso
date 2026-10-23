/**
 * /inscricao/:token — o cartaz da turma, aberto, em que se PEDE a vaga sem
 * conta. A regra (e o porquê de não haver e-mail) mora em
 * `servicos/inscricao_publica.ts`.
 *
 * Como /validar: sem sessão, `noindex` e `no-store`, e o envio passa por um
 * limite por IP. Ao contrário dela, a página mostra a turma — o token é um
 * sorteio de 192 bits, e quem o tem recebeu o cartaz.
 *
 * **POST-redirecionamento-GET.** O pedido aceito responde 303 para o próprio
 * cartaz, e o GET mostra "pedido recebido" com o nome e o e-mail que chegaram:
 * recarregar a página não reenvia o formulário (o celular perguntava "reenviar
 * os dados?", e a resposta "sim" era o pedido repetido). O que foi recebido
 * viaja num cookie curto, só deste caminho e só deste navegador — nunca na URL,
 * que vai para o histórico e para o log. A recusa de digitação continua
 * respondendo na hora (422), com o que foi digitado de volta nos campos.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario } from "../dependencias.js";
import { ROTULO_VINCULO } from "../dominio/treinamento.js";
import * as email from "../servicos/email.js";
import * as servico from "../servicos/inscricao_publica.js";
import { RegraDaTurma } from "../servicos/turma.js";
import { pagina, redirecionar } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";
import { vista_turma } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

/** O cookie do "pedido recebido": 15 minutos, preso ao caminho do token. */
export const COOKIE_RECEBIDO = "csso_pedido_recebido";
const VIDA_RECEBIDO_S = 15 * 60;

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  // o token está no caminho: não sai para outro site no Referer
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

// o vínculo nasce sem escolha: "Servidor da UFVJM" pré-marcado fazia o
// terceirizado mandar o pedido sem SIAPE e receber a recusa
const VAZIO: servico.Pedido = { nome: "", vinculo: "", siape: "", email: "", organizacao: "", consentimento: false };

interface Recebido {
  nome: string;
  email: string;
}

function _ler_recebido(c: Ctx): Recebido | null {
  const bruto = getCookie(c, COOKIE_RECEBIDO);
  if (!bruto) return null;
  try {
    const dado = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Partial<Recebido>;
    if (typeof dado.nome !== "string" || typeof dado.email !== "string") return null;
    return { nome: dado.nome.slice(0, 160), email: dado.email.slice(0, 160) };
  } catch {
    return null;
  }
}

async function _tela(
  c: Ctx,
  d: {
    link: servico.TurmaDoLink | null;
    pedido?: servico.Pedido;
    erro?: string | null;
    recebido?: Recebido | null;
    excedeu?: boolean;
    status?: number;
  },
): Promise<Response> {
  const saida = await pagina(
    c,
    "paginas/inscricao_publica.html",
    null,
    {
      turma: d.link ? vista_turma(d.link.turma) : null,
      fechada: d.link?.fechada ?? "",
      pedido: d.pedido ?? VAZIO,
      // `erro_formulario`, e não `erro`: a casca imprime `erro` no topo da
      // página, e o aviso saía duas vezes — lá e dentro do cartão do formulário
      erro_formulario: d.erro ?? null,
      recebido: d.recebido ?? null,
      excedeu: d.excedeu ?? false,
      resposta_padrao: servico.RESPOSTA_PADRAO,
      linha_neutra: servico.LINHA_NEUTRA,
      // os vínculos da UFVJM sempre; "Comunidade externa" só na turma marcada
      vinculos: servico.VINCULOS_DA_UFVJM,
      vinculos_externos: d.link?.turma.aceita_comunidade_externa ? servico.VINCULOS_COMUNIDADE_EXTERNA : [],
      rotulo_externos: servico.ROTULO_COMUNIDADE_EXTERNA,
      publico: d.link ? servico.publico_da_turma(d.link.turma) : "",
      rotulo_vinculo: ROTULO_VINCULO,
      acao: c.req.path,
    },
    d.status ?? (d.link ? 200 : 404),
  );
  return _sem_rastro(saida);
}

rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const link = await servico.turma_do_token(c.get("tx"), c.req.param("token"));
  // "pedir para outra pessoa": o formulário limpo de novo, no mesmo aparelho
  if (c.req.query("novo") !== undefined) {
    deleteCookie(c, COOKIE_RECEBIDO, { path: c.req.path });
    return _tela(c, { link });
  }
  const recebido = link ? _ler_recebido(c) : null;
  return _tela(c, { link, recebido });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  // o relógio começa antes de qualquer consulta: o tempo da resposta não pode
  // dizer se a pessoa já estava inscrita (`servico.esperar_o_piso`)
  const inicio = performance.now();
  const tx = c.get("tx");
  const ip = ipDoCliente(c);
  const f = await formulario(c);
  const pedido: servico.Pedido = {
    nome: f.texto("nome"),
    vinculo: f.texto("vinculo"),
    siape: f.texto("siape"),
    email: f.texto("email"),
    organizacao: f.texto("organizacao"),
    consentimento: f.texto("consentimento") === "sim",
  };
  // o limite vem antes de olhar o token: senão ele vira o oráculo do token
  if (!(await servico.dentro_do_limite(tx, ip))) {
    return _tela(c, { link: null, pedido, excedeu: true, status: 429 });
  }
  const link = await servico.turma_do_token(tx, c.req.param("token"));
  if (!link || link.fechada) return _tela(c, { link, pedido });
  // o campo que gente não vê: robô preenche, e recebe a mesma resposta
  if (!f.texto("site").trim()) {
    try {
      await tx.transaction((sp) => servico.pedir(sp as typeof tx, link.turma, pedido, ip));
    } catch (erro) {
      if (erro instanceof servico.PedidoInvalido || erro instanceof RegraDaTurma) {
        return _tela(c, { link, pedido, erro: erro.message, status: 422 });
      }
      throw erro;
    }
  }
  // o aviso ao e-mail do cadastro, se houve, está na fila: acordar o envio
  // SEMPRE (e sem esperar), para o tempo não separar quem casou de quem não
  void email.acordar_envio();
  await servico.esperar_o_piso(inicio);
  // sem oráculo: a pessoa nova, a repetida e o robô recebem a mesma resposta,
  // que só devolve o que ela mesma digitou
  const recebido: Recebido = { nome: pedido.nome.trim().replace(/\s+/g, " "), email: pedido.email.trim() };
  setCookie(c, COOKIE_RECEBIDO, Buffer.from(JSON.stringify(recebido), "utf8").toString("base64url"), {
    path: c.req.path,
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: VIDA_RECEBIDO_S,
  });
  return _sem_rastro(redirecionar(c, c.req.path));
});
