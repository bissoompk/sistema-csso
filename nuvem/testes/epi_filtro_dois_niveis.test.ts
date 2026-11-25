/**
 * Filtro de saúde do EPI em dois níveis (24/11/2026). Nos campos que falam da pessoa:
 * - BLOQUEIO (só fala da saúde de alguém): recusado com ou sem a caixa;
 * - AVISO (vocabulário técnico de quem analisa EPI): grava só com "confirmo que a menção é
 *   necessária", e a confirmação vai para a trilha com o nome de quem marcou.
 * Rotina de trabalho, riscos declarados, catálogo e lote ficam como estavam.
 */
import { describe, expect, it } from "vitest";
import * as mencao from "../src/nucleo/mencao_saude.js";
import { MENCAO_SAUDE_CONFIRMADA } from "../src/servicos/auditoria.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import * as textos from "../src/servicos/textos.js";
import { MencaoDeSaude, TextoProibido } from "../src/servicos/textos.js";
import { bancoLimpo } from "./ajuda";
import {
  ANALISTA,
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  pedido_pronto,
  recusa,
  reler,
  reler_linha,
  rascunho,
  titular,
  usuario,
} from "./ajuda_epi_requisicao";

await bancoLimpo();

type Tx = Parameters<Parameters<typeof desfeito>[0]>[0];
const PESSOA = textos.CONTEXTO_EPI_PESSOA;

/** O vocabulário técnico que o reteste mostrou recusado. */
const TECNICOS = [
  "Fornecer máscara cirúrgica ao técnico do centro cirúrgico.",
  "Atividade de manipulação de medicamentos no laboratório.",
  "Exposição a hepatite B no manejo de material biológico.",
  "Equipamento operado pelo servidor durante a coleta.",
  "Risco de lesão por corte na vidraria.",
];
const DUROS = [
  "Servidora relata alergia ao látex.",
  "Servidor com dermatite nas mãos.",
  "Está com tendinite e lombalgia.",
  "Apresentou laudo médico.",
  "Servidora gestante.",
];

async function em_analise(tx: Tx) {
  const cen = await cenario(tx);
  const analista = await usuario(tx, { login: "analista", permissoes: ANALISTA });
  const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
  const requisicao = await pedido_pronto(tx, cen, requerente);
  await servico.enviar(tx, await titular(tx, requerente, requisicao), requisicao, { termo_aceito: true });
  await servico.iniciar_analise(tx, analista, requisicao);
  const [linha] = await itens(tx, requisicao);
  return { cen, analista, requisicao, linha: linha! };
}

const marcada = <T>(f: () => Promise<T>) => mencao.com_confirmacao(true, f);

describe("filtro em dois níveis — o filtro (24/11/2026)", () => {
  it("o grupo de aviso é recusado sem a caixa (MencaoDeSaude) e passa com ela", () => {
    for (const t of TECNICOS) {
      expect(() => textos.exigir_texto_limpo(t, "parecer da análise", PESSOA), t).toThrow(MencaoDeSaude);
      expect(mencao.com_confirmacao(true, () => textos.exigir_texto_limpo(t, "parecer da análise", PESSOA))).toBe(t);
    }
  });

  it("'servidor com lesão no ombro' também exige a caixa", () => {
    const t = "servidor com lesão no ombro";
    expect(() => textos.exigir_texto_limpo(t, "observação da entrega", PESSOA)).toThrow(MencaoDeSaude);
    expect(mencao.com_confirmacao(true, () => textos.exigir_texto_limpo(t, "observação da entrega", PESSOA))).toBe(t);
  });

  it("o grupo de bloqueio e a lista antiga recusam com ou sem a caixa, e a recusa não oferece a caixa", () => {
    for (const t of DUROS) {
      for (const marcar of [false, true]) {
        let erro: unknown = null;
        try {
          mencao.com_confirmacao(marcar, () => textos.exigir_texto_limpo(t, "parecer da análise", PESSOA));
        } catch (e) {
          erro = e;
        }
        expect(erro, `${t} (caixa ${marcar})`).toBeInstanceOf(TextoProibido);
        expect(erro, t).not.toBeInstanceOf(MencaoDeSaude);
      }
    }
  });

  it("termo do bloqueio no mesmo texto de um termo de aviso recusa, mesmo com a caixa", () => {
    const t = "Máscara cirúrgica para servidor com asma.";
    expect(() => mencao.com_confirmacao(true, () => textos.exigir_texto_limpo(t, "parecer da análise", PESSOA))).toThrow(/asma/);
  });

  it("cada termo do pedido está em exatamente um dos grupos", () => {
    const bloqueio = new Set(textos.TERMOS_SAUDE_EPI_BLOQUEIO);
    for (const t of textos.TERMOS_SAUDE_EPI_AVISO) expect(bloqueio.has(t), t).toBe(false);
    expect(textos.TERMOS_SAUDE_EPI_AVISO.slice().sort()).toEqual(
      ["cancer", "cirurgia", "cirurgica", "cirurgico", "hepatite", "hiv", "lesao", "lesoes", "medicacao", "medicamento", "medicamentos", "operada", "operado", "tumor"],
    );
  });

  it("rotina de trabalho, riscos declarados, catálogo e lote ficam como estavam (sem caixa)", () => {
    for (const ctx of [textos.CONTEXTO_EPI_POSTO, textos.CONTEXTO_EPI_MATERIAL]) {
      for (const t of TECNICOS) expect(textos.exigir_texto_limpo(t, "campo", ctx)).toBe(t);
      expect(() => textos.exigir_texto_limpo("servidora gestante", "campo", ctx)).toThrow(TextoProibido);
    }
  });
});

describe("filtro em dois níveis — parecer e justificativa da aprovação (24/11/2026)", () => {
  it("parecer técnico: recusado sem a caixa; com ela grava, e a trilha tem a confirmação com o nome", async () => {
    for (const t of TECNICOS) {
      await desfeito(async (tx) => {
        const { analista, requisicao, linha } = await em_analise(tx);
        await servico.aprovar_item(tx, analista, linha);
        await recusa(servico.concluir_analise(tx, analista, requisicao, { parecer: t }), MencaoDeSaude);
        expect((await reler(tx, requisicao)).estado).toBe("EM_ANALISE");
        await marcada(() => servico.concluir_analise(tx, analista, requisicao, { parecer: t }));
        const relida = await reler(tx, requisicao);
        expect(relida.estado).toBe("ANALISADA");
        expect(relida.parecer_analise).toBe(t);
        const confirmacoes = (await eventos(tx, "epi_requisicao", requisicao.id)).filter((ev) => ev.tipo_evento === MENCAO_SAUDE_CONFIRMADA);
        expect(confirmacoes, t).toHaveLength(1);
        expect(confirmacoes[0]!.campo).toBe("parecer da análise");
        expect(confirmacoes[0]!.usuario_id).toBe(analista.id);
        expect(confirmacoes[0]!.descricao).toContain(`por ${analista.nome}`);
      });
    }
  });

  it("justificativa da aprovação técnica: recusada sem a caixa; com ela grava, e a trilha registra", async () => {
    for (const t of TECNICOS) {
      await desfeito(async (tx) => {
        const { analista, linha } = await em_analise(tx);
        await recusa(servico.aprovar_item(tx, analista, linha, { justificativa: t }), MencaoDeSaude);
        expect((await reler_linha(tx, linha)).estado).toBe("SOLICITADO");
        await marcada(() => servico.aprovar_item(tx, analista, linha, { justificativa: t }));
        const relida = await reler_linha(tx, linha);
        expect(relida.estado).toBe("APROVADO");
        expect(relida.justificativa).toBe(t);
        const confirmacoes = (await eventos(tx, "epi_requisicao_item", linha.id)).filter((ev) => ev.tipo_evento === MENCAO_SAUDE_CONFIRMADA);
        expect(confirmacoes, t).toHaveLength(1);
        expect(confirmacoes[0]!.campo).toBe("justificativa do item");
        expect(confirmacoes[0]!.usuario_id).toBe(analista.id);
      });
    }
  });

  it("o grupo de bloqueio continua recusado no parecer e na justificativa, com ou sem a caixa", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      for (const t of DUROS) {
        await recusa(marcada(() => servico.aprovar_item(tx, analista, linha, { justificativa: t })), TextoProibido);
        await recusa(servico.aprovar_item(tx, analista, linha, { justificativa: t }), TextoProibido);
      }
      await servico.aprovar_item(tx, analista, linha);
      for (const t of DUROS) {
        await recusa(marcada(() => servico.concluir_analise(tx, analista, requisicao, { parecer: t })), TextoProibido);
      }
      expect((await reler(tx, requisicao)).estado).toBe("EM_ANALISE");
      const trilha = await eventos(tx, "epi_requisicao", requisicao.id);
      expect(trilha.some((ev) => ev.tipo_evento === MENCAO_SAUDE_CONFIRMADA)).toBe(false);
    }));

  it("caixa marcada sem termo de aviso no texto não registra confirmação nenhuma", () =>
    desfeito(async (tx) => {
      const { analista, requisicao, linha } = await em_analise(tx);
      await marcada(() => servico.aprovar_item(tx, analista, linha, { justificativa: "troca por desgaste" }));
      await marcada(() => servico.concluir_analise(tx, analista, requisicao, { parecer: "Aprovado como pedido." }));
      const trilha = [...(await eventos(tx, "epi_requisicao", requisicao.id)), ...(await eventos(tx, "epi_requisicao_item", linha.id))];
      expect(trilha.some((ev) => ev.tipo_evento === MENCAO_SAUDE_CONFIRMADA)).toBe(false);
    }));

  it("riscos declarados do pedido: 'risco de lesão por corte' passa sem caixa (como antes)", () =>
    desfeito(async (tx) => {
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const cen = await cenario(tx);
      const r = await rascunho(tx, requerente, { servidor: cen.servidor, riscos_declarados: "Risco de lesão por corte." });
      expect(r.riscos_declarados).toBe("Risco de lesão por corte.");
    }));
});
