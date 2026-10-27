/**
 * A aba Saúde da ocorrência (fatia F3): abrir a saúde de um acidentado (com a
 * finalidade escolhida ANTES, nível 1 ou 2) e registrar/corrigir (médico do
 * trabalho). A regra mora em `servicos/acidente_saude`; aqui só a porta, a
 * ocorrência no alcance e a volta à ficha.
 *
 * Abrir é GET e grava o acesso (`acesso_dado_sensivel`) a cada abertura. O
 * próprio acidentado entra pela porta do titular (`acidente.ver`, escopo
 * próprio) e lê sem finalidade.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario } from "../dependencias.js";
import * as saude from "../servicos/acidente_saude.js";
import { comMensagem, redirecionar } from "../web.js";
import * as acidentes from "./acidentes.js";

export const rotas = new Hono<Ambiente>();

function _dados(f: Awaited<ReturnType<typeof formulario>>): saude.DadosSaude {
  return {
    natureza_lesao_id: f.inteiro("natureza_lesao_id"),
    parte_corpo_ids: f.todos("parte_corpo_id").map(Number).filter(Number.isInteger),
    lateralidade: f.opcional("lateralidade"),
    houve_atendimento: f.opcional("houve_atendimento"),
    houve_afastamento: f.opcional("houve_afastamento"),
    houve_internacao: f.opcional("houve_internacao"),
    houve_obito: f.opcional("houve_obito"),
    houve_sequela: f.opcional("houve_sequela"),
    dias_afastamento: f.inteiro("dias_afastamento"),
    afastamento_inicio: f.opcional("afastamento_inicio"),
    afastamento_retorno: f.opcional("afastamento_retorno"),
    dias_internacao: f.inteiro("dias_internacao"),
    data_obito: f.opcional("data_obito"),
    dias_debitados: f.inteiro("dias_debitados"),
    primeiro_socorro_por: f.opcional("primeiro_socorro_por"),
    primeiro_socorro_unidade: f.opcional("primeiro_socorro_unidade"),
    atendimento_em: f.opcional("atendimento_em"),
    duracao_tratamento_dias: f.inteiro("duracao_tratamento_dias"),
    deve_afastar: f.opcional("deve_afastar"),
    descricao_lesao: f.opcional("descricao_lesao"),
    diagnostico_provavel: f.opcional("diagnostico_provavel"),
    cid: f.opcional("cid"),
    observacoes_saude: f.opcional("observacoes_saude"),
  };
}

function _nivel(valor: string | null): saude.Nivel {
  return valor === "2" ? 2 : 1;
}

/** Abre a saúde de um acidentado e mostra a ficha na aba Saúde. */
async function _abrir(
  c: import("../nucleo/contexto.js").Ctx,
  usuario: Awaited<ReturnType<typeof acidentes.porta_titular>>,
  oc_id: number,
  acidentado_id: number,
  nivel: saude.Nivel,
  finalidade: string | null,
  extra: Record<string, unknown> = {},
  status = 200,
) {
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, oc_id);
  const base = { aba: "saude", saude_aberta: { acidentado_id, nivel, finalidade } };
  try {
    const lida = await c.get("tx").transaction((sp) => saude.ler(sp, usuario, ocorrencia, acidentado_id, nivel, finalidade));
    return acidentes.tela_ficha(c, usuario, ocorrencia, { ...base, saude_lida: lida, ...extra }, status);
  } catch (erro) {
    if (erro instanceof saude.SaudeInexistente) throw new ErroHttp(404, erro.message);
    if (!(erro instanceof RegraViolada)) throw erro;
    return acidentes.tela_ficha(c, usuario, ocorrencia, { ...base, erro: erro.message }, 422);
  }
}

rotas.get("/acidentes/:id{[0-9]+}/saude", async (c) => {
  const usuario = await acidentes.porta_titular(c, "acidente.ver");
  return _abrir(
    c,
    usuario,
    Number(c.req.param("id")),
    Number(c.req.query("acidentado")),
    _nivel(c.req.query("nivel") ?? null),
    c.req.query("finalidade") || null,
  );
});

rotas.post("/acidentes/:id{[0-9]+}/saude", async (c) => {
  const usuario = await acidentes.porta(c, "acidente.saude_registrar");
  const oc_id = Number(c.req.param("id"));
  const ocorrencia = await acidentes.ocorrencia_no_alcance(c, usuario, oc_id);
  const f = await formulario(c);
  const acidentado_id = f.inteiro("acidentado_id") ?? -1;
  try {
    await c.get("tx").transaction((sp) => saude.registrar(sp, usuario, ocorrencia, acidentado_id, _dados(f), f.inteiro("versao") ?? -1));
  } catch (erro) {
    if (erro instanceof saude.SaudeInexistente) throw new ErroHttp(404, erro.message);
    if (!(erro instanceof RegraViolada)) throw erro;
    // volta à saúde aberta (nova abertura, com a mesma finalidade) com o erro e o digitado
    const conflito = erro instanceof saude.SaudeAlterada;
    return _abrir(c, usuario, oc_id, acidentado_id, 2, f.opcional("finalidade"), { erro: erro.message, saude_digitado: acidentes.digitado(f) }, conflito ? 409 : 422);
  }
  return redirecionar(c, comMensagem(`/acidentes/${oc_id}?aba=saude`, "Saúde registrada."));
});
