/**
 * A aba Identificação da ocorrência: a identificação pessoal do acidentado e o
 * contato das testemunhas (Anexo III da CAT/SP), bloco RESTRITO. A regra mora em
 * `servicos/acidente_identificacao`; aqui só a porta, a ocorrência no alcance e a
 * volta à ficha.
 *
 * Abrir é GET e grava o acesso (`acesso_dado_sensivel`) a cada abertura, com a
 * finalidade escolhida antes. O próprio acidentado entra pela porta do titular e
 * lê sem finalidade. O CPF nunca aparece por inteiro na tela.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import * as identificacao from "../servicos/acidente_identificacao.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

rotas.get("/acidentes/:id{[0-9]+}/identificacao", async (c) => {
  const usuario = await acidentes.porta_titular(c, "acidente.ver");
  const oc_id = Number(c.req.param("id"));
  const acidentado_id = Number(c.req.query("acidentado"));
  const finalidade = c.req.query("finalidade") || null;
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, oc_id);
  const base = { aba: "identificacao", ident_aberta: { acidentado_id, finalidade } };
  try {
    const lida = await c.get("tx").transaction((sp) => identificacao.ler(sp, usuario, ocorrencia, acidentado_id, finalidade));
    return acidentes.tela_ficha(c, usuario, ocorrencia, { ...base, ident_lida: lida });
  } catch (erro) {
    if (erro instanceof identificacao.IdentificacaoInexistente) throw new ErroHttp(404, erro.message);
    if (!(erro instanceof RegraViolada)) throw erro;
    return acidentes.tela_ficha(c, usuario, ocorrencia, { ...base, erro: erro.message }, 422);
  }
});
