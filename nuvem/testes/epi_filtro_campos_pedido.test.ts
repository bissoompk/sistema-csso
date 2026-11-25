/**
 * Filtro de saúde (RN-21, lista ampliada do EPI) campo a campo no pedido de EPI — 24/11/2026.
 * Cada campo que fala da PESSOA recusa pelo menos três termos, "lesão" e variações inclusive, e
 * não grava nada. Rotina de trabalho e riscos declarados descrevem o posto: lá só a lista antiga.
 */
import { describe, expect, it } from "vitest";
import * as servico from "../src/servicos/epi_requisicao.js";
import { MencaoDeSaude, TextoProibido } from "../src/servicos/textos.js";
import * as mencao from "../src/nucleo/mencao_saude.js";
import { bancoLimpo } from "./ajuda";
import {
  ANALISTA,
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  motivo,
  pedido_pronto,
  recusa,
  reler,
  reler_linha,
  rascunho,
  titular,
  usuario,
} from "./ajuda_epi_requisicao";

await bancoLimpo();

/** Pelo menos três termos por campo; "lesão" e variações sempre entre eles. */
const TERMOS = [
  "Servidor com lesão no ombro",
  "está com o braço lesionado",
  "lesoes nas mãos",
  "relata alergia ao látex",
  "trouxe atestado médico",
];

type Tx = Parameters<Parameters<typeof desfeito>[0]>[0];

/** Pedido enviado e em análise com o analista. */
async function em_analise(tx: Tx) {
  const cen = await cenario(tx);
  const analista = await usuario(tx, { login: "analista", permissoes: ANALISTA });
  const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
  const requisicao = await pedido_pronto(tx, cen, requerente);
  const dono = await titular(tx, requerente, requisicao);
  await servico.enviar(tx, dono, requisicao, { termo_aceito: true });
  await servico.iniciar_analise(tx, analista, requisicao);
  const [linha] = await itens(tx, requisicao);
  return { cen, analista, requerente, dono, requisicao, linha: linha! };
}

/** Cada termo é recusado com a mensagem do EPI, e o histórico não ganha evento com o texto. */
async function cada_termo_recusado(tx: Tx, entidade_id: number, tentar: (texto: string) => Promise<unknown>) {
  for (const t of TERMOS) {
    const erro = await recusa(tentar(t), TextoProibido);
    expect(erro.message, t).toContain("no EPI");
  }
  const texto_do_historico = JSON.stringify(await eventos(tx, "epi_requisicao", entidade_id));
  for (const t of TERMOS) expect(texto_do_historico, t).not.toContain(t);
}

describe("filtro de saúde por campo — pedido de EPI (24/11/2026)", () => {
  it("justificativa da aprovação do item: lista ampliada, nada gravado", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.aprovar_item(tx, analista, linha, { justificativa: t }));
      expect((await reler_linha(tx, linha)).estado).toBe("SOLICITADO");
      const gravada = (await reler_linha(tx, linha)).justificativa ?? "";
      for (const t of TERMOS) expect(gravada).not.toContain(t);
      // texto sem dado de saúde passa
      await servico.aprovar_item(tx, analista, linha, { justificativa: "Troca por desgaste do par anterior." });
      expect((await reler_linha(tx, linha)).estado).toBe("APROVADO");
    }));

  it("parecer da análise: lista ampliada, a análise não conclui", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      await servico.aprovar_item(tx, analista, linha);
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.concluir_analise(tx, analista, requisicao, { parecer: t }));
      expect((await reler(tx, requisicao)).estado).toBe("EM_ANALISE");
    }));

  it("complemento da recusa do item: lista ampliada, o item não é recusado", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      const outro = await motivo(tx, "OUTRO");
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.recusar_item(tx, analista, linha, { motivo: outro, complemento: t }));
      expect((await reler_linha(tx, linha)).estado).toBe("SOLICITADO");
    }));

  it("complemento do indeferimento: lista ampliada, o pedido não é indeferido", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      const m = await motivo(tx);
      await servico.recusar_item(tx, analista, linha, { motivo: m });
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.indeferir(tx, analista, requisicao, { motivo: m, complemento: t }));
      expect((await reler(tx, requisicao)).estado).toBe("EM_ANALISE");
    }));

  it("motivo do cancelamento do pedido: lista ampliada, o pedido não é cancelado", () =>
    desfeito(async (tx) => {
      const { dono, requisicao } = await em_analise(tx);
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.cancelar(tx, dono, requisicao, t));
      expect((await reler(tx, requisicao)).estado).toBe("EM_ANALISE");
    }));

  it("motivo do cancelamento do item: lista ampliada, o item não é cancelado", () =>
    desfeito(async (tx) => {
      const { dono, requisicao, linha } = await em_analise(tx);
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.cancelar_item(tx, dono, linha, t));
      expect((await reler_linha(tx, linha)).estado).toBe("SOLICITADO");
    }));

  it("motivo da devolução à fila: lista ampliada, o pedido continua com o analista", () =>
    desfeito(async (tx) => {
      const { analista, requisicao } = await em_analise(tx);
      await cada_termo_recusado(tx, requisicao.id, (t) => servico.devolver_para_fila(tx, analista, requisicao, t));
      const relida = await reler(tx, requisicao);
      expect(relida.estado).toBe("EM_ANALISE");
      expect(relida.analisado_por).toBe(analista.id);
    }));

  it("justificativa do item e da urgência, no rascunho do titular: lista ampliada", () =>
    desfeito(async (tx) => {
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const cen = await cenario(tx);
      const r = await rascunho(tx, requerente, { servidor: cen.servidor });
      const dono = await titular(tx, requerente, r);
      for (const t of TERMOS) {
        await recusa(servico.adicionar_item(tx, dono, r, { motivo: "USO_INICIAL", item: cen.item, quantidade: 1, tamanho: "M", justificativa: t }), TextoProibido);
        await recusa(servico.atualizar_rascunho(tx, dono, r, { urgencia: "URGENTE", justificativa_urgencia: t }), TextoProibido);
      }
      expect(await itens(tx, r)).toEqual([]);
    }));

  it("rotina de trabalho e riscos declarados: 'lesão' e 'dermatite' do posto passam com a caixa (lote 5, ajuste 2); a lista antiga não", () =>
    desfeito(async (tx) => {
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const cen = await cenario(tx);
      for (const texto of ["Risco de lesão por corte.", "Risco de dermatite de contato.", "Risco de lesões por impacto e de lesionar as mãos."]) {
        await recusa(rascunho(tx, requerente, { servidor: cen.servidor, descricao_atividade: texto, riscos_declarados: texto }), MencaoDeSaude);
        const r = await mencao.com_confirmacao(true, () =>
          rascunho(tx, requerente, { servidor: cen.servidor, descricao_atividade: texto, riscos_declarados: texto }),
        );
        expect([r.descricao_atividade, r.riscos_declarados]).toEqual([texto, texto]);
      }
      for (const t of ["Servidora gestante", "ver diagnóstico", "CID M75"]) {
        await recusa(rascunho(tx, requerente, { servidor: cen.servidor, descricao_atividade: t }), TextoProibido);
        await recusa(rascunho(tx, requerente, { servidor: cen.servidor, riscos_declarados: t }), TextoProibido);
      }
    }));
});
