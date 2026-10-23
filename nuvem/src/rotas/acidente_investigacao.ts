/**
 * A investigação da ocorrência (fatia F4): MAPA, linha do tempo, barreiras,
 * checklist de campo, entrevistas e evidências. Todos os atos são POST da
 * ficha (`/acidentes/:id/...`), com `acidente.investigar`; a leitura é a da
 * própria ficha (`rotas/acidentes.ts`, abas Investigação, Checklist e
 * Entrevistas). A regra mora nos serviços `acidente_investigacao`,
 * `acidente_checklist` e `acidente_entrevista`.
 *
 * A recusa volta à aba com o erro (422); o "Salvar" do MAPA com versão velha
 * volta com 409 e o que foi digitado ao lado do que está gravado — nada se
 * perde e nada sobrescreve o colega.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { RegraViolada } from "../nucleo/erros.js";
import { formulario } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import * as checklist from "../servicos/acidente_checklist.js";
import type { Ocorrencia } from "../servicos/acidente_comunicacao.js";
import * as entrevista from "../servicos/acidente_entrevista.js";
import * as investigacao from "../servicos/acidente_investigacao.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, redirecionar } from "../web.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

type Formulario = Awaited<ReturnType<typeof formulario>>;

async function _arquivo(f: Formulario, nome: string): Promise<entrevista.Arquivo | null> {
  const a = f.arquivo(nome);
  if (!a) return null;
  return { nome: a.name, conteudo: new Uint8Array(await a.arrayBuffer()) };
}

/**
 * O esqueleto de todo ato: porta, ocorrência no alcance, o serviço num
 * savepoint. Sucesso volta à aba com a mensagem; recusa, à aba com o erro.
 */
async function _ato(
  c: Ctx,
  aba: string,
  executar: (sp: Executor, usuario: UsuarioAtual, oc: Ocorrencia, f: Formulario) => Promise<unknown>,
  sucesso: string,
) {
  const usuario = await acidentes.porta(c, "acidente.investigar");
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, Number(c.req.param("id")));
  const f = await formulario(c);
  try {
    await c.get("tx").transaction((sp) => executar(sp, usuario, ocorrencia, f));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    const conflito = erro instanceof investigacao.InvestigacaoAlterada;
    return acidentes.tela_ficha(
      c,
      usuario,
      await acidentes.ocorrencia_no_alcance(c, usuario, ocorrencia.id),
      {
        aba,
        erro: erro.message,
        digitado: acidentes.digitado(f),
        // o que a pessoa digitou e não foi gravado, campo a campo, ao lado do gravado
        nao_gravado: conflito
          ? investigacao.CAMPOS_TEXTO.map(([campo, rotulo]) => [rotulo, f.texto(campo)]).filter(([, v]) => (v as string).trim())
          : null,
      },
      conflito ? 409 : 422,
    );
  }
  return redirecionar(c, comMensagem(`/acidentes/${ocorrencia.id}?aba=${aba}`, sucesso));
}

// ---------------------------------------------------------------------
// MAPA
// ---------------------------------------------------------------------
rotas.post("/acidentes/:id{[0-9]+}/investigacao", (c) =>
  _ato(
    c,
    "investigacao",
    (sp, u, oc, f) => {
      const dados: investigacao.DadosInvestigacao = {};
      for (const [campo] of investigacao.CAMPOS_TEXTO) dados[campo] = f.texto(campo);
      for (const [campo] of investigacao.CAMPOS_ESCOLHA) dados[campo] = f.texto(campo);
      return investigacao.salvar(sp, u, oc, dados, f.inteiro("versao") ?? -1);
    },
    "Investigação salva.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/investigacao/linha", (c) =>
  _ato(
    c,
    "investigacao",
    (sp, u, oc, f) => investigacao.acrescentar_evento(sp, u, oc, { momento: f.texto("momento"), descricao: f.texto("descricao") }),
    "Momento acrescentado à linha do tempo.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/investigacao/linha/:lid{[0-9]+}/desativar", (c) =>
  _ato(
    c,
    "investigacao",
    (sp, u, oc) => investigacao.desativar(sp, u, oc, "linha", Number(c.req.param("lid"))),
    "Momento tirado da linha do tempo (o registro fica na trilha).",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/investigacao/barreiras", (c) =>
  _ato(
    c,
    "investigacao",
    (sp, u, oc, f) =>
      investigacao.acrescentar_barreira(sp, u, oc, { tipo: f.texto("tipo"), situacao: f.texto("situacao"), descricao: f.texto("descricao") }),
    "Barreira acrescentada.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/investigacao/barreiras/:bid{[0-9]+}/desativar", (c) =>
  _ato(
    c,
    "investigacao",
    (sp, u, oc) => investigacao.desativar(sp, u, oc, "barreira", Number(c.req.param("bid"))),
    "Barreira tirada da lista (o registro fica na trilha).",
  ),
);

// ---------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------
rotas.post("/acidentes/:id{[0-9]+}/checklist", (c) =>
  _ato(
    c,
    "checklist",
    (sp, u, oc, f) => {
      const marcados = new Set(f.todos("marcado").map(Number).filter(Number.isInteger));
      const observacoes = new Map<number, string>();
      for (const chave of new Set(f.dados.keys())) {
        const m = /^obs_(\d+)$/.exec(chave);
        if (m) observacoes.set(Number(m[1]), f.texto(chave));
      }
      return checklist.salvar(sp, u, oc, marcados, observacoes);
    },
    "Checklist salvo.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/checklist/item", (c) =>
  _ato(c, "checklist", (sp, u, oc, f) => checklist.acrescentar(sp, u, oc, f.inteiro("secao") ?? -1, f.texto("texto")), "Item acrescentado."),
);

rotas.post("/acidentes/:id{[0-9]+}/checklist/item/:iid{[0-9]+}/desativar", (c) =>
  _ato(c, "checklist", (sp, u, oc) => checklist.desativar(sp, u, oc, Number(c.req.param("iid"))), "Item tirado do checklist."),
);

// ---------------------------------------------------------------------
// Entrevistas e evidências
// ---------------------------------------------------------------------
rotas.post("/acidentes/:id{[0-9]+}/entrevistas", (c) =>
  _ato(
    c,
    "entrevistas",
    async (sp, u, oc, f) =>
      entrevista.registrar(
        sp,
        u,
        oc,
        {
          entrevistado_nome: f.texto("entrevistado_nome"),
          entrevistado_vinculo: f.opcional("entrevistado_vinculo"),
          realizada_em: f.opcional("realizada_em"),
          entrevistadores: f.opcional("entrevistadores"),
          relato: f.opcional("relato"),
          consentiu_gravacao: f.texto("consentiu_gravacao") === "1",
        },
        await _arquivo(f, "audio"),
      ),
    "Entrevista registrada.",
  ),
);

rotas.post("/acidentes/:id{[0-9]+}/evidencias", (c) =>
  _ato(
    c,
    "entrevistas",
    async (sp, u, oc, f) => {
      const arquivo = await _arquivo(f, "arquivo");
      if (!arquivo) throw new RegraViolada("Escolha o arquivo da evidência.");
      return entrevista.anexar_evidencia(sp, u, oc, arquivo, f.opcional("descricao"));
    },
    "Evidência anexada.",
  ),
);
