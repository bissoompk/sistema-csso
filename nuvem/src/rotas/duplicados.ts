/**
 * As decisões "é a mesma pessoa" / "não é a mesma pessoa" (23/10/2026,
 * `servicos/duplicados.ts`) tomadas fora da ficha da turma e do lote:
 *
 * - na conferência dos pedidos pelo link (`/turmas/pedidos`): "parece com
 *   PTC-…" em cada pedido, com "usar este cadastro" e "não é a mesma pessoa";
 * - na tela de juntar cadastros (`/treinamentos/participantes`): "não são a
 *   mesma pessoa" para o grupo inteiro, que tira o grupo do contador.
 *
 * Mora num arquivo próprio para não crescer `turmas.ts` e `treinamentos.ts`.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as duplicados from "../servicos/duplicados.js";
import * as mesclagem from "../servicos/mesclagem.js";
import * as pedidos_link from "../servicos/pedidos_link.js";
import * as servico_participante from "../servicos/participante.js";
import type { Executor } from "../db/cliente.js";
import { erro as _erro, id_opcional, volta as _volta } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const PEDIDOS = "/turmas/pedidos";
export const PARTICIPANTES = "/treinamentos/participantes";

/** `"<inscricao_id>:<participante_id>"`, o valor do botão da linha. */
function _par(valor: string): [number, number] | null {
  const m = /^(\d+):(\d+)$/.exec((valor ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** A volta: a tela dos pedidos, ou a aba Inscrições da turma de onde veio. */
function _destino(turma_id: string): string {
  const id = id_opcional(turma_id);
  return id ? `/turmas/${id}?aba=inscricoes` : PEDIDOS;
}

rotas.post(`${PEDIDOS}/usar-cadastro`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const f = await formulario(c);
  const volta = _destino(f.texto("turma_id"));
  const par = _par(f.texto("par"));
  if (!par) return _erro(c, volta, "Escolha o cadastro.");
  const tx = c.get("tx");
  let r: Awaited<ReturnType<typeof pedidos_link.usar_cadastro>>;
  try {
    r = await tx.transaction((sp) => pedidos_link.usar_cadastro(sp as Executor, usuario, par[0], par[1]));
  } catch (erro) {
    if (erro instanceof RegraViolada) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(
    c,
    volta,
    `Pedido de ${r.turma} ligado a ${r.mantido.identificador_publico}: os dois cadastros viraram um. ` +
      "O pedido continua a conferir.",
  );
});

rotas.post(`${PEDIDOS}/nao-e-a-mesma`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const f = await formulario(c);
  const volta = _destino(f.texto("turma_id"));
  const par = _par(f.texto("par"));
  if (!par) return _erro(c, volta, "Escolha o cadastro.");
  let r: Awaited<ReturnType<typeof pedidos_link.nao_e_a_mesma>>;
  try {
    r = await pedidos_link.nao_e_a_mesma(c.get("tx"), usuario, par[0], par[1]);
  } catch (erro) {
    if (erro instanceof RegraViolada) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, `${r.pedido} e ${r.outro} ficam como pessoas diferentes: o aviso não volta.`);
});

/**
 * "Não são a mesma pessoa", na tela de juntar: todo par do grupo fica
 * gravado, e o grupo sai da lista e do contador.
 */
rotas.post(`${PARTICIPANTES}/distintos`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("participante.mesclar");
  const f = await formulario(c);
  const volta = f.texto("volta").startsWith(PARTICIPANTES) ? f.texto("volta") : PARTICIPANTES;
  const tx = c.get("tx");
  const ids = [...new Set(f.todos("membro_id").map((v) => id_opcional(v)).filter((v): v is number => v !== null))];
  const pessoas = [];
  for (const id of ids.slice(0, 20)) {
    const p = await servico_participante.carregar(tx, id);
    if (p && p.ativo && p.mesclado_em_id === null) pessoas.push(p);
  }
  if (pessoas.length < 2) return _erro(c, volta, "Nada foi gravado: o grupo precisa de dois cadastros ativos.");
  let gravados = 0;
  for (let i = 0; i < pessoas.length; i++) {
    for (let j = i + 1; j < pessoas.length; j++) {
      if (await duplicados.marcar_distintos(tx, usuario, pessoas[i]!.id, pessoas[j]!.id, "JUNCAO")) gravados += 1;
    }
  }
  return _volta(
    c,
    volta,
    `${pessoas.map((p) => p.identificador_publico).join(", ")}: ficam como pessoas diferentes ` +
      `(${gravados} par(es) gravado(s)) e saem dos possíveis duplicados.`,
  );
});


/**
 * Desfazer uma junção (26/10/2026): devolve ao cadastro juntado o que a
 * junção moveu (`mesclagem.desfazer`). Quem faz é quem pode juntar
 * (`participante.mesclar`), com o motivo, e escolhe se o par fica gravado como
 * "não são a mesma pessoa" (marcado de saída: desfazer costuma ser a
 * correção de quem juntou errado).
 */
rotas.post(`${PARTICIPANTES}/desfazer`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("participante.mesclar");
  const f = await formulario(c);
  const volta = f.texto("volta").startsWith(PARTICIPANTES) ? f.texto("volta") : `${PARTICIPANTES}?feitas=1`;
  const id = id_opcional(f.texto("mesclagem_id"));
  if (id === null) return _erro(c, volta, "Escolha a junção.");
  const tx = c.get("tx");
  let r: Awaited<ReturnType<typeof mesclagem.desfazer>>;
  try {
    r = await tx.transaction((sp) =>
      mesclagem.desfazer(sp as Executor, usuario, id, f.texto("motivo"), f.texto("distintos") === "sim"),
    );
  } catch (erro) {
    if (erro instanceof RegraViolada) return _erro(c, volta, `Nada foi desfeito. ${erro.message}`);
    throw erro;
  }
  return _volta(
    c,
    volta,
    `Junção desfeita: ${r.absorvido} voltou a ser um cadastro à parte, com ${r.inscricoes} inscrição(ões), ` +
      `${r.certificados} certificado(s) e ${r.emails} e-mail(s).` +
      (r.ficou_para_tras ? ` ${r.ficou_para_tras} item(ns) que já não estavam com ${r.mantido} ficaram onde estão.` : "") +
      (r.distintos ? " Os dois ficam como pessoas diferentes: o aviso não volta." : ""),
  );
});
