/**
 * Só quem pegou o pedido de EPI decide (24/11/2026). Outra pessoa da equipe assume antes, por ação
 * explícita e com motivo, que fica na trilha com os dois nomes. Reproduz o reteste: a EPI-2026-0002
 * estava com uma analista e outra aprovou o item e concluiu sem pegar o pedido.
 */
import { describe, expect, it } from "vitest";
import * as servico from "../src/servicos/epi_requisicao.js";
import { TextoProibido } from "../src/servicos/textos.js";
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
  titular,
  usuario,
} from "./ajuda_epi_requisicao";

await bancoLimpo();

type Tx = Parameters<Parameters<typeof desfeito>[0]>[0];

/** Pedido enviado e pego pela Perpétua; a Nádia é da mesma equipe. */
async function com_a_perpetua(tx: Tx) {
  const cen = await cenario(tx);
  const perpetua = await usuario(tx, { login: "perpetua", permissoes: ANALISTA });
  const nadia = await usuario(tx, { login: "nadia", permissoes: ANALISTA });
  const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
  const requisicao = await pedido_pronto(tx, cen, requerente);
  await servico.enviar(tx, await titular(tx, requerente, requisicao), requisicao, { termo_aceito: true });
  await servico.iniciar_analise(tx, perpetua, requisicao);
  const [linha] = await itens(tx, requisicao);
  return { cen, perpetua, nadia, requerente, requisicao, linha: linha! };
}

describe("assumir a análise (24/11/2026)", () => {
  it("outra pessoa não decide item, não conclui, não indefere, não devolve e não aprova tudo", () =>
    desfeito(async (tx) => {
      const { nadia, requisicao, linha } = await com_a_perpetua(tx);
      const m = await motivo(tx);
      const tentativas: [string, () => Promise<unknown>][] = [
        ["aprovar item", () => servico.aprovar_item(tx, nadia, linha)],
        ["recusar item", () => servico.recusar_item(tx, nadia, linha, { motivo: m })],
        ["concluir", () => servico.concluir_analise(tx, nadia, requisicao, { parecer: "ok" })],
        ["indeferir", () => servico.indeferir(tx, nadia, requisicao, { motivo: m })],
        ["devolver à fila", () => servico.devolver_para_fila(tx, nadia, requisicao, "sem base para decidir")],
        ["aprovar tudo", () => servico.aprovar_tudo(tx, nadia, requisicao)],
      ];
      for (const [ato, tentar] of tentativas) {
        const erro = await recusa(tentar(), servico.AnaliseComOutraPessoa);
        expect(erro.message, ato).toContain("em análise com Operador perpetua");
        expect(erro.message, ato).toContain("Assumir a análise");
      }
      expect((await reler_linha(tx, linha)).estado).toBe("SOLICITADO");
      const relida = await reler(tx, requisicao);
      expect(relida.estado).toBe("EM_ANALISE");
      expect(relida.analisado_por).not.toBe(nadia.id);
    }));

  it("depois de assumir, decide e conclui; a trilha tem os dois nomes e o motivo; 'Analisado por' é quem assumiu", () =>
    desfeito(async (tx) => {
      const { perpetua, nadia, requisicao, linha } = await com_a_perpetua(tx);
      await servico.assumir_analise(tx, nadia, requisicao, "Perpétua de férias; pedido parado há 5 dias");
      expect((await reler(tx, requisicao)).analisado_por).toBe(nadia.id);

      const [evento] = (await eventos(tx, "epi_requisicao", requisicao.id)).filter(
        (ev) => ev.tipo_evento === servico.EPI_REQUISICAO_ANALISE_ASSUMIDA,
      );
      expect(evento).toBeDefined();
      expect(evento!.descricao).toContain("análise assumida por Operador nadia");
      expect(evento!.descricao).toContain("estava com Operador perpetua");
      expect(evento!.comentario).toBe("Perpétua de férias; pedido parado há 5 dias");
      expect(evento!.valor_anterior).toBe("Operador perpetua");
      expect(evento!.valor_novo).toBe("Operador nadia");
      expect(evento!.usuario_id).toBe(nadia.id);

      await servico.aprovar_item(tx, nadia, linha);
      await servico.concluir_analise(tx, nadia, requisicao, { parecer: "Aprovado como pedido." });
      const relida = await reler(tx, requisicao);
      expect(relida.estado).toBe("ANALISADA");
      expect(relida.analisado_por).toBe(nadia.id);
      expect((await reler_linha(tx, linha)).decidido_por).toBe(nadia.id);
      expect(relida.analisado_por).not.toBe(perpetua.id);
    }));

  it("depois de assumir, quem estava passa a ser a 'outra pessoa'; e quem assumiu devolve à fila", () =>
    desfeito(async (tx) => {
      const { perpetua, nadia, requisicao, linha } = await com_a_perpetua(tx);
      await servico.assumir_analise(tx, nadia, requisicao, "redistribuição da fila pela coordenação");
      await recusa(servico.aprovar_item(tx, perpetua, linha), servico.AnaliseComOutraPessoa);
      await servico.devolver_para_fila(tx, nadia, requisicao, "falta a descrição do posto");
      const relida = await reler(tx, requisicao);
      expect(relida.estado).toBe("ENVIADA");
      expect(relida.analisado_por).toBeNull();
    }));

  it("quem pegou continua decidindo e devolvendo sem assumir nada", () =>
    desfeito(async (tx) => {
      const { perpetua, requisicao, linha } = await com_a_perpetua(tx);
      await servico.aprovar_item(tx, perpetua, linha);
      await servico.concluir_analise(tx, perpetua, requisicao);
      expect((await reler(tx, requisicao)).estado).toBe("ANALISADA");
    }));

  it("o motivo é obrigatório e passa pelo filtro de saúde da pessoa", () =>
    desfeito(async (tx) => {
      const { perpetua, nadia, requisicao } = await com_a_perpetua(tx);
      await recusa(servico.assumir_analise(tx, nadia, requisicao, "   "), servico.RequisicaoBloqueada);
      for (const t of ["Perpétua com dermatite, afastada", "colega em licença médica", "trouxe atestado médico"]) {
        await recusa(servico.assumir_analise(tx, nadia, requisicao, t), TextoProibido);
      }
      expect((await reler(tx, requisicao)).analisado_por).toBe(perpetua.id);
      const trilha = await eventos(tx, "epi_requisicao", requisicao.id);
      expect(trilha.some((ev) => ev.tipo_evento === servico.EPI_REQUISICAO_ANALISE_ASSUMIDA)).toBe(false);
    }));

  it("ninguém assume o próprio pedido (RN-28)", () =>
    desfeito(async (tx) => {
      const { cen, requisicao } = await com_a_perpetua(tx);
      const o_proprio = await usuario(tx, { login: "proprio", permissoes: ANALISTA, servidor_id: cen.servidor.id });
      await recusa(servico.assumir_analise(tx, o_proprio, requisicao, "quero decidir"), servico.AutoanaliseProibida);
    }));

  it("só se assume pedido em análise: na fila o caminho é iniciar a análise; e não se assume o que já é seu", () =>
    desfeito(async (tx) => {
      const { perpetua, nadia, requisicao } = await com_a_perpetua(tx);
      const erro = await recusa(servico.assumir_analise(tx, perpetua, requisicao, "x"), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("já está em análise com você");
      await servico.devolver_para_fila(tx, perpetua, requisicao, "devolvo para redistribuir");
      const na_fila = await recusa(servico.assumir_analise(tx, nadia, requisicao, "x"), servico.RequisicaoBloqueada);
      expect(na_fila.message).toContain("Iniciar análise");
    }));

  it("reconsideração: quem reabre o indeferido passa a ser o responsável (como antes)", () =>
    desfeito(async (tx) => {
      const { perpetua, nadia, requisicao, linha } = await com_a_perpetua(tx);
      const m = await motivo(tx);
      await servico.recusar_item(tx, perpetua, linha, { motivo: m });
      await servico.indeferir(tx, perpetua, requisicao, { motivo: m });
      await servico.reconsiderar(tx, nadia, requisicao, "fato novo: o posto mudou");
      const relida = await reler(tx, requisicao);
      expect(relida.estado).toBe("EM_ANALISE");
      expect(relida.analisado_por).toBe(nadia.id);
    }));
});
