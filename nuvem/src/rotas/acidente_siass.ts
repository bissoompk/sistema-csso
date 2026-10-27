/**
 * O SIASS e a conclusão (fatia F7): encaminhar, registrar a decisão da perícia
 * e concluir. POST da ficha (`/acidentes/:id/siass...`), com `acidente.siass`;
 * a leitura é a aba SIASS da ficha. A regra mora em `servicos/acidente_siass`.
 * A recusa volta à aba com o erro (422).
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { RegraViolada } from "../nucleo/erros.js";
import { formulario } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import type { Ocorrencia } from "../servicos/acidente_comunicacao.js";
import * as siass from "../servicos/acidente_siass.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, redirecionar } from "../web.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

type Formulario = Awaited<ReturnType<typeof formulario>>;

async function _ato(
  c: Ctx,
  executar: (sp: Executor, usuario: UsuarioAtual, oc: Ocorrencia, f: Formulario) => Promise<unknown>,
  sucesso: string,
) {
  const usuario = await acidentes.porta(c, "acidente.siass");
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, Number(c.req.param("id")));
  const f = await formulario(c);
  try {
    await c.get("tx").transaction((sp) => executar(sp, usuario, ocorrencia, f));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return acidentes.tela_ficha(
      c,
      usuario,
      await acidentes.ocorrencia_no_alcance(c, usuario, ocorrencia.id),
      { aba: "siass", erro: erro.message, digitado: acidentes.digitado(f) },
      422,
    );
  }
  return redirecionar(c, comMensagem(`/acidentes/${ocorrencia.id}?aba=siass`, sucesso));
}

rotas.post("/acidentes/:id{[0-9]+}/siass", (c) =>
  _ato(
    c,
    (sp, u, oc, f) =>
      siass.encaminhar(sp, u, oc, { meio: f.texto("meio"), nup_sei: f.opcional("nup_sei"), encaminhado_em: f.texto("encaminhado_em"), observacao: f.opcional("observacao") }, f.inteiro("versao_ocorrencia") ?? -1),
    "Encaminhamento registrado.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/siass/decisao", (c) =>
  _ato(
    c,
    (sp, u, oc, f) =>
      siass.registrar_decisao(sp, u, oc, { resultado: f.texto("resultado"), decidida_em: f.texto("decidida_em"), numero_cat_siass: f.opcional("numero_cat_siass"), observacao: f.opcional("observacao") }),
    "Decisão da perícia registrada.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/siass/concluir", (c) =>
  _ato(c, (sp, u, oc, f) => siass.concluir(sp, u, oc, f.opcional("motivo"), f.inteiro("versao_ocorrencia") ?? -1), "Ocorrência concluída."),
);
