/**
 * O relatório técnico (fatia F6): emitir, retificar e baixar o PDF. Emitir e
 * retificar são POST da ficha, com `acidente.relatorio_emitir`; baixar passa
 * pela porta dos anexos (`anexo_acesso`), que confere o escopo, exige a saúde
 * para a variante completa e registra a leitura. A regra mora em
 * `servicos/acidente_relatorio`.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario } from "../dependencias.js";
import * as relatorio from "../servicos/acidente_relatorio.js";
import { comMensagem, redirecionar } from "../web.js";
import * as acidentes from "./acidentes.js";
import { baixar } from "./turmas.js";

export const rotas = new Hono<Ambiente>();

async function _ato(c: import("../nucleo/contexto.js").Ctx, sucesso: string, executar: (sp: import("../db/cliente.js").Executor, usuario: Awaited<ReturnType<typeof acidentes.porta>>, oc: Awaited<ReturnType<typeof acidentes.ocorrencia_no_alcance>>, f: Awaited<ReturnType<typeof formulario>>) => Promise<unknown>) {
  const usuario = await acidentes.porta(c, "acidente.relatorio_emitir");
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
      { aba: "relatorios", erro: erro.message, digitado: acidentes.digitado(f) },
      422,
    );
  }
  return redirecionar(c, comMensagem(`/acidentes/${ocorrencia.id}?aba=relatorios`, sucesso));
}

rotas.post("/acidentes/:id{[0-9]+}/relatorio", (c) =>
  _ato(c, "Relatório emitido.", (sp, u, oc, f) => relatorio.emitir(sp, u, oc, f.inteiro("versao_ocorrencia") ?? -1)),
);

rotas.post("/acidentes/:id{[0-9]+}/relatorio/retificar", (c) =>
  _ato(c, "Relatório retificado: a versão anterior continua disponível, marcada como retificada.", (sp, u, oc, f) =>
    relatorio.retificar(sp, u, oc, f.texto("motivo")),
  ),
);

rotas.get("/acidentes/:id{[0-9]+}/relatorio/:versao{[0-9]+}/:arquivo{[A-Z_]+\\.pdf}", async (c) => {
  const usuario = await acidentes.porta_titular(c, "acidente.ver");
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, Number(c.req.param("id")));
  try {
    const r = await c.get("tx").transaction((sp) => relatorio.baixar(sp, usuario, ocorrencia, Number(c.req.param("versao")), c.req.param("arquivo").replace(/\.pdf$/, "")));
    return baixar(c, r.bytes, r.nome, "application/pdf");
  } catch (erro) {
    if (erro instanceof relatorio.RelatorioInexistente) throw new ErroHttp(404, erro.message);
    throw erro;
  }
});
