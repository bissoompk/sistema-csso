/**
 * Avaliação de reação (`servicos/avaliacao_reacao.ts`): as duas portas de
 * quem responde e as duas telas da equipe.
 *
 * - `/turmas/minhas/:turma_id/avaliar` — pela conta, a partir de "Meus
 *   treinamentos". Como o resto daquela tela, a rota não aceita "quem".
 * - `/avaliacao/:token` — pelo link do e-mail, sem sessão. Como
 *   /certificados/acesso: `noindex`, `no-store` e, com o token no caminho,
 *   `no-referrer`. O GET não gasta o link; o POST gasta.
 * - `/turmas/:turma_id/avaliacao` — o resultado da turma (a aba "Avaliação de
 *   reação" da ficha), com o piso de anonimato.
 * - `/treinamentos/avaliacao-de-reacao` — o consolidado por treinamento e por
 *   instrutor, com o mesmo piso.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import * as servico from "../servicos/avaliacao_reacao.js";
import * as datas_br from "../servicos/datas_br.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import * as servico_turma from "../servicos/turma.js";
import type { InscricaoCarregada, TurmaCarregada } from "../servicos/turma.js";
import { pagina, redirecionar } from "../web.js";
import { ABAS, MINHAS, PERMISSOES_DAS_ABAS_NOMINAIS, TURMAS } from "./turmas.js";
import { erro as _erro, recados, volta as _volta, vista_turma } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const CONSOLIDADO = "/treinamentos/avaliacao-de-reacao";

function _sem_rastro(resposta: Response): Response {
  resposta.headers.set("x-robots-tag", "noindex, nofollow");
  resposta.headers.set("cache-control", "no-store");
  resposta.headers.set("referrer-policy", "no-referrer");
  return resposta;
}

/** Os instrutores, só os nomes, para a pergunta do item "instrutor(es)". */
function _instrutores(turma: TurmaCarregada): string[] {
  return turma.instrutores.map((v) => v.instrutor.nome);
}

/**
 * O formulário (as duas portas usam o mesmo). `usuario` nulo é o link sem
 * conta: a página sai sem a casca, como /validar.
 */
async function _tela_formulario(
  c: Ctx,
  usuario: UsuarioAtual | null,
  d: {
    turma?: TurmaCarregada | null;
    acao?: string;
    impedimento?: string;
    erro?: string | null;
    marcado?: Record<string, string>;
    invalido?: boolean;
    obrigado?: boolean;
    status?: number;
  },
): Promise<Response> {
  if (d.turma) vista_turma(d.turma);
  const resposta = await pagina(
    c,
    "paginas/avaliacao_reacao.html",
    usuario,
    {
      turma: d.turma ?? null,
      instrutores: d.turma ? _instrutores(d.turma) : [],
      acao: d.acao ?? "",
      impedimento: d.impedimento ?? "",
      erro: d.erro ?? null,
      marcado: d.marcado ?? {},
      invalido: d.invalido ?? false,
      obrigado: d.obrigado ?? false,
      itens: servico.ITENS,
      notas: servico.NOTAS,
      tamanho_comentario: servico.TAMANHO_COMENTARIO,
      rotulo_comentario: servico.ROTULO_COMENTARIO,
      prazo: d.turma ? servico.prazo_ate(d.turma) : "",
      pela_conta: usuario !== null,
    },
    d.status ?? 200,
  );
  return usuario === null ? _sem_rastro(resposta) : resposta;
}

// =====================================================================
// Pela conta
// =====================================================================
async function _minha(c: Ctx, usuario: UsuarioAtual): Promise<InscricaoCarregada | null> {
  return servico.inscricao_do_titular(c.get("tx"), usuario, Number(c.req.param("turma_id")));
}

rotas.get(`${MINHAS}/:turma_id{[0-9]+}/avaliar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const minha = await _minha(c, usuario);
  // a turma em que ele não está inscrito é a mesma da que não existe
  if (!minha) return _erro(c, MINHAS, "Turma não encontrada entre as suas inscrições.");
  return _tela_formulario(c, usuario, {
    turma: minha.turma,
    acao: `${MINHAS}/${minha.turma_id}/avaliar`,
    impedimento: servico.impedimento(minha),
  });
});

rotas.post(`${MINHAS}/:turma_id{[0-9]+}/avaliar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const f = await formulario(c);
  const minha = await _minha(c, usuario);
  if (!minha) return _erro(c, MINHAS, "Turma não encontrada entre as suas inscrições.");
  const ler = (nome: string) => f.texto(nome);
  try {
    const respostas = servico.ler_respostas(ler);
    await c.get("tx").transaction((sp) => servico.responder_pela_conta(sp, usuario, minha, respostas));
  } catch (erro) {
    if (!(erro instanceof servico.AvaliacaoRecusada)) throw erro;
    return _tela_formulario(c, usuario, {
      turma: minha.turma,
      acao: `${MINHAS}/${minha.turma_id}/avaliar`,
      impedimento: servico.impedimento(minha),
      erro: erro.message,
      marcado: servico.marcado(ler),
      status: 422,
    });
  }
  return _volta(
    c,
    MINHAS,
    `Obrigado! Sua avaliação de ${minha.turma.codigo} foi registrada sem o seu nome: a equipe vê só o conjunto das respostas.`,
    "#minhas",
  );
});

// =====================================================================
// Pelo link do e-mail, sem conta
// =====================================================================
rotas.get(`${servico.CAMINHO}/:token`, async (c) => {
  const aberto = await servico.abrir_link(c.get("tx"), c.req.param("token"));
  if (!aberto) return _tela_formulario(c, null, { invalido: true, status: 404 });
  return _tela_formulario(c, null, {
    turma: aberto.inscricao.turma,
    acao: `${servico.CAMINHO}/${c.req.param("token")}`,
    impedimento: aberto.impedimento,
  });
});

rotas.post(`${servico.CAMINHO}/:token`, async (c) => {
  const f = await formulario(c);
  const token = c.req.param("token");
  const tx = c.get("tx");
  const ler = (nome: string) => f.texto(nome);
  try {
    const respostas = servico.ler_respostas(ler);
    const feita = await tx.transaction((sp) => servico.responder_pelo_link(sp, token, respostas));
    if (!feita) return _tela_formulario(c, null, { invalido: true, status: 404 });
    return _tela_formulario(c, null, { turma: feita.turma, obrigado: true });
  } catch (erro) {
    if (!(erro instanceof servico.AvaliacaoRecusada)) throw erro;
    const aberto = await servico.abrir_link(tx, token);
    if (!aberto) return _tela_formulario(c, null, { invalido: true, status: 404 });
    return _tela_formulario(c, null, {
      turma: aberto.inscricao.turma,
      acao: `${servico.CAMINHO}/${token}`,
      impedimento: aberto.impedimento,
      erro: erro.message,
      marcado: servico.marcado(ler),
      status: 422,
    });
  }
});

// =====================================================================
// O resultado, para a equipe
// =====================================================================
rotas.get(`${TURMAS}/:turma_id{[0-9]+}/avaliacao`, async (c) => {
  const usuario = await usuarioLogado(c);
  servico.exigir_resultado(usuario);
  const tx = c.get("tx");
  const turma = await servico_turma.no_escopo(tx, usuario, Number(c.req.param("turma_id")), servico.PERMISSOES_DO_RESULTADO);
  if (!turma) return redirecionar(c, TURMAS);
  vista_turma(turma);
  const ve_nominal = PERMISSOES_DAS_ABAS_NOMINAIS.some((p) => usuario.pode(p));
  return pagina(c, "paginas/turma_avaliacao_reacao.html", usuario, {
    turma,
    abas: ve_nominal ? ABAS : ABAS.slice(0, 1),
    r: await servico.resultado_da_turma(tx, turma),
    itens: servico.ITENS,
    notas: servico.NOTAS,
    versao: servico.VERSAO,
    terminou: servico.turma_terminou(turma, datas_br.hoje()),
    prazo: servico.prazo_ate(turma),
    consolidado: CONSOLIDADO,
    ...recados(c),
  });
});

rotas.get(CONSOLIDADO, async (c) => {
  const usuario = await usuarioLogado(c);
  servico.exigir_resultado(usuario);
  return pagina(c, "paginas/treinamentos_avaliacao_reacao.html", usuario, {
    r: await servico.consolidado(c.get("tx"), usuario),
    itens: servico.ITENS,
    versao: servico.VERSAO,
  });
});
