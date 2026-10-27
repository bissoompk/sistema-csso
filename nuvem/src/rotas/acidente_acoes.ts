/**
 * O plano de ação do acidente (fatia F5): criar, editar, iniciar, concluir e
 * cancelar ações. Todos os atos são POST da ficha (`/acidentes/:id/acoes...`),
 * com `acidente.investigar`; a leitura é a aba Plano de ação da ficha e a
 * lista `/acidentes/acoes` (`rotas/acidentes.ts`). A regra mora no serviço
 * `acidente_acao`. A recusa volta à aba com o erro (422); versão velha, 409.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { RegraViolada, ErroHttp } from "../nucleo/erros.js";
import { formulario } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import type { Ocorrencia } from "../servicos/acidente_comunicacao.js";
import * as plano from "../servicos/acidente_acao.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, redirecionar } from "../web.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

type Formulario = Awaited<ReturnType<typeof formulario>>;

function _dados(f: Formulario): plano.DadosAcao {
  return {
    achado: f.opcional("achado"),
    acao: f.texto("acao"),
    tipo_acao: f.texto("tipo_acao"),
    responsavel_usuario_id: f.texto("responsavel") === "eu" ? -1 : null,
    responsavel_unidade_uorg_id: f.inteiro("unidade"),
    responsavel_texto: f.opcional("responsavel_texto"),
    prazo: f.opcional("prazo"),
    prioridade: f.texto("prioridade", "MEDIA"),
  };
}

async function _ato(
  c: Ctx,
  executar: (sp: Executor, usuario: UsuarioAtual, oc: Ocorrencia, f: Formulario) => Promise<unknown>,
  sucesso: string,
) {
  const usuario = await acidentes.porta(c, "acidente.investigar");
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, Number(c.req.param("id")));
  const f = await formulario(c);
  try {
    await c.get("tx").transaction((sp) => executar(sp, usuario, ocorrencia, f));
  } catch (erro) {
    if (erro instanceof plano.AcaoInexistente) throw new ErroHttp(404, erro.message);
    if (!(erro instanceof RegraViolada)) throw erro;
    return acidentes.tela_ficha(
      c,
      usuario,
      await acidentes.ocorrencia_no_alcance(c, usuario, ocorrencia.id),
      { aba: "acoes", erro: erro.message, digitado: acidentes.digitado(f), acao_com_erro: Number(c.req.param("aid")) || null },
      erro instanceof plano.AcaoAlterada ? 409 : 422,
    );
  }
  return redirecionar(c, comMensagem(`/acidentes/${ocorrencia.id}?aba=acoes`, sucesso));
}

/** "eu" no formulário é a conta de quem registra; vazio é quem conduz o caso. */
function _com_eu(d: plano.DadosAcao, usuario: UsuarioAtual): plano.DadosAcao {
  return d.responsavel_usuario_id === -1 ? { ...d, responsavel_usuario_id: usuario.id } : d;
}

rotas.post("/acidentes/:id{[0-9]+}/acoes", (c) =>
  _ato(c, (sp, u, oc, f) => plano.criar(sp, u, oc, _com_eu(_dados(f), u)), "Ação acrescentada ao plano."),
);

rotas.post("/acidentes/:id{[0-9]+}/acoes/:aid{[0-9]+}/editar", (c) =>
  _ato(
    c,
    (sp, u, oc, f) => plano.alterar(sp, u, oc, Number(c.req.param("aid")), _com_eu(_dados(f), u), f.inteiro("versao") ?? -1),
    "Ação alterada.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/acoes/:aid{[0-9]+}/iniciar", (c) =>
  _ato(c, (sp, u, oc, f) => plano.iniciar(sp, u, oc, Number(c.req.param("aid")), f.inteiro("versao") ?? -1), "Ação em andamento."),
);

rotas.post("/acidentes/:id{[0-9]+}/acoes/:aid{[0-9]+}/concluir", (c) =>
  _ato(
    c,
    async (sp, u, oc, f) => {
      const a = f.arquivo("evidencia");
      const evidencia = a ? { nome: a.name, conteudo: new Uint8Array(await a.arrayBuffer()) } : null;
      return plano.concluir(sp, u, oc, Number(c.req.param("aid")), f.texto("conclusao"), evidencia, f.inteiro("versao") ?? -1);
    },
    "Ação concluída.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/acoes/:aid{[0-9]+}/cancelar", (c) =>
  _ato(
    c,
    (sp, u, oc, f) => plano.cancelar(sp, u, oc, Number(c.req.param("aid")), f.texto("motivo"), f.inteiro("versao") ?? -1),
    "Ação cancelada (continua no plano, riscada).",
  ),
);
