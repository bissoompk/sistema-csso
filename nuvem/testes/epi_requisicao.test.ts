/**
 * Fatia 4 de Gestão de EPI: a requisição — protocolo, decisão e prazo.
 * Porte de `testes/integracao/test_epi_requisicao.py`.
 *
 * Em ordem de gravidade: RN-28 (quem analisa não é quem requisita), o
 * congelamento da lotação no envio, RN-27 (a negativa recebida é a que fica),
 * RN-03 no protocolo, RN-26 contando a FICHA, e a máquina de estado como guarda.
 */
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { TransicaoInvalida } from "../src/dominio/estados.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as numeracao from "../src/servicos/numeracao.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { PERMISSOES, PermissaoNegada, modulo_da_permissao } from "../src/servicos/rbac.js";
import { TextoProibido } from "../src/servicos/textos.js";
import { bancoLimpo } from "./ajuda";
import {
  HOJE,
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  motivo,
  outro_item,
  pedido_pronto,
  recusa,
  reler,
  reler_linha,
  usuario,
} from "./ajuda_epi_requisicao";

const { url } = await bancoLimpo();

// =====================================================================
// 1. RN-03 — o protocolo
// =====================================================================
describe("RN-03 — o protocolo", () => {
  it("rascunho não consome protocolo e o envio consome", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      expect(requisicao.protocolo).toBeNull();
      expect(requisicao.numero).toBeNull();
      expect(requisicao.ano).toBeNull();

      await servico.enviar(tx, u, requisicao, { quando: "2026-03-04" });
      expect(requisicao.protocolo).toBe("EPI-2026-0001");
      expect([requisicao.numero, requisicao.ano]).toEqual([1, 2026]);
      expect(requisicao.enviada_em).not.toBeNull();
    }));

  it("rascunho excluído não gasta número e o seguinte é o primeiro", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const descartado = await pedido_pronto(tx, cen, u);
      await servico.excluir_rascunho(tx, u, descartado);
      const outro = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, outro, { quando: "2026-03-04" });
      expect(outro.protocolo).toBe("EPI-2026-0001");
    }));

  it("cinquenta protocolos concorrentes sem buraco nem repetição", async () => {
    // RN-03 sob concorrência: nunca `MAX(numero)+1`. Oito conexões de verdade.
    const sql = postgres(url, { max: 8, prepare: false, onnotice: () => {} });
    const db = drizzle(sql, { schema: e });
    try {
      const numeros = await Promise.all(
        Array.from({ length: 50 }, () =>
          db.transaction((tx) => numeracao.proximo_numero_requisicao_epi(tx, 2031)),
        ),
      );
      expect(new Set(numeros).size).toBe(50);
      expect([...numeros].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("a numeração da requisição recusa alvo errado", () =>
    desfeito(async (tx) => {
      await recusa(
        numeracao.proximo_numero(tx, 2026, {
          tabela_sequencia: "epi_requisicao_sequencia",
          tabela_alvo: "parecer_tecnico",
        }),
        numeracao.SequenciaDesconhecida,
      );
    }));
});

// =====================================================================
// 2. O snapshot congelado no envio
// =====================================================================
describe("o snapshot congelado no envio", () => {
  it("a lotação não muda quando o servidor troca de setor", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      const congelados = [
        requisicao.unidade_uorg_id,
        requisicao.posto_trabalho_id,
        requisicao.cargo_snapshot,
        requisicao.funcao_snapshot,
      ];
      expect(congelados[0]).toBe(cen.unidade.id);
      expect(congelados[2]).toBeTruthy();

      // a pessoa é transferida DEPOIS do envio, e o cadastro atual muda junto
      await tx.update(e.servidor_lotacao).set({ vigencia_fim: HOJE }).where(eq(e.servidor_lotacao.id, cen.lotacao.id));
      await tx
        .update(e.servidor)
        .set({ unidade_uorg_id: cen.outra_unidade.id, funcao: "Assessora" })
        .where(eq(e.servidor.id, cen.servidor.id));
      await tx.insert(e.servidor_lotacao).values({
        servidor_id: cen.servidor.id,
        unidade_uorg_id: cen.outra_unidade.id,
        funcao: "Assessora",
        vigencia_inicio: somar_dias(HOJE, 1),
      });
      const depois = (await reler(tx, requisicao))!;
      expect([depois.unidade_uorg_id, depois.posto_trabalho_id, depois.cargo_snapshot, depois.funcao_snapshot]).toEqual(
        congelados,
      );
    }));
});

// =====================================================================
// 3. RN-29 — justificativa onde o catálogo exige
// =====================================================================
describe("RN-29", () => {
  it("item que exige justificativa não é enviado sem ela", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx, { exige_justificativa: true });
      const requisicao = await pedido_pronto(tx, cen, u);
      const erro = await recusa(servico.enviar(tx, u, requisicao), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("exige justificativa");
      // e o pedido continua rascunho, sem número gasto
      expect(requisicao.estado).toBe("RASCUNHO");
      expect(requisicao.protocolo).toBeNull();

      await servico.editar_item(tx, u, (await itens(tx, requisicao))[0]!, {
        quantidade: 2,
        tamanho: "M",
        justificativa: "Manipulação diária de solvente orgânico no LEAC",
      });
      await servico.enviar(tx, u, requisicao);
      expect(requisicao.estado).toBe("ENVIADA");
    }));

  it("pedido sem item não sai do rascunho", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await servico.criar_rascunho(tx, u, { servidor: cen.servidor });
      const erro = await recusa(servico.enviar(tx, u, requisicao), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("nenhum item");
    }));
});

// =====================================================================
// 4. RN-30 — texto livre passa pelo filtro da RN-21
// =====================================================================
describe("RN-30", () => {
  it("rotina de trabalho com termo de saúde é recusada", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      await recusa(
        servico.criar_rascunho(tx, u, {
          servidor: cen.servidor,
          descricao_atividade: "Estou grávida e não posso pegar peso no setor",
        }),
        TextoProibido,
      );
    }));

  it("justificativa do item e motivo de cancelamento também passam", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await servico.criar_rascunho(tx, u, { servidor: cen.servidor });
      await recusa(
        servico.adicionar_item(tx, u, requisicao, {
          item: cen.item,
          quantidade: 1,
          tamanho: "M",
          justificativa: "Tem diagnóstico de dermatite pelo médico do trabalho",
        }),
        TextoProibido,
      );
      await servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "M" });
      await servico.enviar(tx, u, requisicao);
      await recusa(servico.cancelar(tx, u, requisicao, "Servidora afastada por atestado médico"), TextoProibido);
    }));
});

// =====================================================================
// 5. RN-28 — quem analisa não é quem requisita
// =====================================================================
describe("RN-28", () => {
  it("analisar o próprio pedido é recusado", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const dono = await usuario(tx, { login: "tecnico", servidor_id: cen.servidor.id });
      const requisicao = await pedido_pronto(tx, cen, dono);
      await servico.enviar(tx, dono, requisicao);
      await recusa(servico.iniciar_analise(tx, dono, requisicao), servico.AutoanaliseProibida);
      expect(requisicao.estado).toBe("ENVIADA");
      expect(requisicao.analisado_por).toBeNull();
    }));

  it("a mensagem cita as duas saídas legítimas", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const dono = await usuario(tx, { login: "tecnico", servidor_id: cen.servidor.id });
      const requisicao = await pedido_pronto(tx, cen, dono);
      await servico.enviar(tx, dono, requisicao);
      const erro = await recusa(servico.iniciar_analise(tx, dono, requisicao), servico.AutoanaliseProibida);
      expect(erro.message).toContain("outra pessoa");
      expect(erro.message).toContain("balcão");
      expect(erro.message).toContain("/epis/entregas/nova");
      expect(erro.message).toContain("RN-28");
      // é PermissaoNegada: a rota devolve 403, e não 500
      expect(erro).toBeInstanceOf(PermissaoNegada);
      expect(erro.codigo).toBe("epi.analisar");
    }));

  it("alcança todas as operações de análise", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const dono = await usuario(tx, { login: "tecnico", servidor_id: cen.servidor.id });
      const outro = await usuario(tx, { login: "colega" });
      const requisicao = await pedido_pronto(tx, cen, dono);
      await servico.enviar(tx, dono, requisicao);
      await servico.iniciar_analise(tx, outro, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;
      const m = await motivo(tx);
      await recusa(servico.aprovar_item(tx, dono, linha), servico.AutoanaliseProibida);
      await recusa(servico.recusar_item(tx, dono, linha, { motivo: m }), servico.AutoanaliseProibida);
      await recusa(servico.concluir_analise(tx, dono, requisicao), servico.AutoanaliseProibida);
      await recusa(servico.devolver_para_fila(tx, dono, requisicao, "não sei decidir"), servico.AutoanaliseProibida);
      await recusa(servico.indeferir(tx, dono, requisicao, { motivo: m }), servico.AutoanaliseProibida);
    }));

  it("o dono do pedido ainda recebe EPI pela entrega de balcão", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const dono = await usuario(tx, { login: "tecnico", servidor_id: cen.servidor.id });
      const registro = await epi_ficha.registrar_entrega(tx, dono, {
        servidor: cen.servidor,
        item: cen.item,
        quantidade: 1,
        entrada: cen.entrada,
        tamanho: "M",
      });
      expect(registro.id).toBeTruthy();
      expect(registro.requisicao_item_id).toBeNull(); // balcão não tem pedido
    }));

  it("quem não tem a permissão de analisar é barrado antes da RN-28", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "secretaria" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      const erro = await recusa(servico.iniciar_analise(tx, requerente, requisicao), PermissaoNegada);
      expect(erro).not.toBeInstanceOf(servico.AutoanaliseProibida);
    }));
});

// =====================================================================
// 6. RN-26 — a janela conta a FICHA
// =====================================================================
async function balcao(tx: Parameters<Parameters<typeof desfeito>[0]>[0], cen: Awaited<ReturnType<typeof cenario>>, u: Awaited<ReturnType<typeof usuario>>) {
  return epi_ficha.registrar_entrega(tx, u, {
    servidor: cen.servidor,
    item: cen.item,
    quantidade: 1,
    entrada: cen.entrada,
    tamanho: "M",
  });
}

describe("RN-26", () => {
  it("a janela estoura pela ficha, e não por requisições aprovadas", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { quantidade_maxima: 1, periodo_maximo_meses: 12 });
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      await balcao(tx, cen, analista);
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;
      const erro = await recusa(servico.aprovar_item(tx, analista, linha), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("a ficha registra 1");
      expect((await reler_linha(tx, linha))!.estado).toBe("SOLICITADO");
    }));

  it("a exceção exige autorização e justificativa, e vira evento", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { quantidade_maxima: 1, periodo_maximo_meses: 12 });
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      await balcao(tx, cen, analista);
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;

      const erro = await recusa(
        servico.aprovar_item(tx, analista, linha, { autorizar_excesso: true }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("justificativa por escrito");

      await servico.aprovar_item(tx, analista, linha, {
        autorizar_excesso: true,
        justificativa: "Par anterior rasgou em serviço; incidente registrado no LEAC",
      });
      expect(linha.estado).toBe("APROVADO");
      expect(linha.excedeu_maximo).toBe(true);
      expect(linha.autorizado_por).toBe(analista.id);
      const tipos = (await eventos(tx, "epi_requisicao_item", linha.id)).map((ev) => ev.tipo_evento);
      expect(tipos).toContain(servico.EPI_MAXIMO_EXCEDIDO);
    }));

  it("aprovar mais do que se pediu é recusado", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 2 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const erro = await recusa(
        servico.aprovar_item(tx, analista, (await itens(tx, requisicao))[0]!, { quantidade_aprovada: 5 }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("foram pedidos 2");
    }));

  it("aprovar zero manda recusar com motivo", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const erro = await recusa(
        servico.aprovar_item(tx, analista, (await itens(tx, requisicao))[0]!, { quantidade_aprovada: 0 }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("RN-27");
    }));
});

// =====================================================================
// 7. RN-27 — a recusa fundamentada, catalogada e congelada
// =====================================================================
describe("RN-27", () => {
  async function em_analise(tx: Parameters<Parameters<typeof desfeito>[0]>[0]) {
    const cen = await cenario(tx);
    const analista = await usuario(tx, { login: "analista" });
    const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
    const requisicao = await pedido_pronto(tx, cen, requerente);
    await servico.enviar(tx, requerente, requisicao);
    await servico.iniciar_analise(tx, analista, requisicao);
    return { cen, analista, requerente, requisicao };
  }

  it("o texto da recusa sobrevive à edição do catálogo", () =>
    desfeito(async (tx) => {
      const { analista, requisicao } = await em_analise(tx);
      const m = await motivo(tx, "SEM_EXPOSICAO");
      const texto_do_dia = m.texto;
      const linha = await servico.recusar_item(tx, analista, (await itens(tx, requisicao))[0]!, { motivo: m });
      expect(linha.estado).toBe("RECUSADO");
      expect(linha.texto_recusa_snapshot).toBe(texto_do_dia);

      await tx
        .update(e.epi_motivo_recusa)
        .set({ texto: "Texto novo, escrito depois, que não vale para a recusa de ontem." })
        .where(eq(e.epi_motivo_recusa.id, m.id));
      expect((await reler_linha(tx, linha))!.texto_recusa_snapshot).toBe(texto_do_dia);
    }));

  it("o código do motivo vai para a trilha e a contagem sai dela", () =>
    desfeito(async (tx) => {
      const { analista, requisicao } = await em_analise(tx);
      const linha = await servico.recusar_item(tx, analista, (await itens(tx, requisicao))[0]!, {
        motivo: await motivo(tx, "VINCULO_NAO_ATENDIDO"),
      });
      const evento = (await eventos(tx, "epi_requisicao_item", linha.id)).find(
        (ev) => ev.tipo_evento === servico.EPI_ITEM_RECUSADO,
      )!;
      expect(evento.campo).toBe("estado");
      expect(evento.valor_anterior).toBe("SOLICITADO");
      expect((evento.valor_novo as Record<string, unknown>)["motivo"]).toBe("VINCULO_NAO_ATENDIDO");
    }));

  it("motivo que exige complemento não passa sem ele", () =>
    desfeito(async (tx) => {
      const { analista, requisicao } = await em_analise(tx);
      const erro = await recusa(
        servico.recusar_item(tx, analista, (await itens(tx, requisicao))[0]!, { motivo: await motivo(tx, "OUTRO") }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("complemento");
    }));
});

// =====================================================================
// 8. RN-31 — só rascunho some de verdade
// =====================================================================
describe("RN-31", () => {
  it("rascunho some e deixa evento na trilha", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      const identificador = requisicao.id;
      await servico.excluir_rascunho(tx, u, requisicao);
      expect(await reler(tx, { id: identificador })).toBeNull();
      expect(await itens(tx, { id: identificador })).toEqual([]);
      const tipos = (await eventos(tx, "epi_requisicao", identificador)).map((ev) => ev.tipo_evento);
      expect(tipos).toContain(servico.EPI_REQUISICAO_EXCLUIDA);
    }));

  it("requisição enviada não se exclui: cancela com motivo", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      const erro = await recusa(servico.excluir_rascunho(tx, u, requisicao), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("RN-31");
      await servico.cancelar(tx, u, requisicao, "A compra saiu por outro caminho");
      expect(requisicao.estado).toBe("CANCELADA");
      expect(requisicao.motivo_cancelamento).toBeTruthy();
      // o protocolo NÃO volta para a sequência: ele circulou
      expect(requisicao.protocolo).toBe(`EPI-${HOJE.slice(0, 4)}-0001`);
    }));

  it("cancelar sem motivo é recusado", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      await recusa(servico.cancelar(tx, u, requisicao, "   "), servico.RequisicaoBloqueada);
    }));

  it("cancelar leva os itens abertos junto", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      await servico.cancelar(tx, u, requisicao, "Servidora mudou de posto");
      expect((await itens(tx, requisicao)).map((i) => i.estado)).toEqual(["CANCELADO"]);
    }));

  it("editar pedido protocolado é recusado", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;
      for (const chamada of [
        () => servico.atualizar_rascunho(tx, u, requisicao),
        () => servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "P" }),
        () => servico.remover_item(tx, u, linha),
      ]) {
        await recusa(chamada(), servico.RequisicaoBloqueada);
      }
    }));

  it("o mesmo item e tamanho não entram duas vezes", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      const erro = await recusa(
        servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "M" }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("some as quantidades");
    }));
});

// =====================================================================
// 9. As duas máquinas de estado
// =====================================================================
describe("as duas máquinas de estado", () => {
  it("a máquina do envelope recusa toda transição não declarada", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await recusa(
        servico._mover(tx, requisicao, "EM_ANALISE", u, { tipo_evento: servico.EPI_REQUISICAO_EM_ANALISE }),
        TransicaoInvalida,
      );
      await servico.enviar(tx, u, requisicao);
      for (const destino of ["ANALISADA", "ATENDIDA", "EM_ATENDIMENTO", "INDEFERIDA"]) {
        await recusa(
          servico._mover(tx, requisicao, destino, u, { tipo_evento: servico.EPI_REQUISICAO_ANALISADA }),
          TransicaoInvalida,
        );
      }
    }));

  it("a máquina do item recusa toda transição não declarada", () =>
    desfeito(async (tx) => {
      const u = await usuario(tx);
      const cen = await cenario(tx);
      const requisicao = await pedido_pronto(tx, cen, u);
      await servico.enviar(tx, u, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;
      for (const destino of ["ENTREGUE", "RESERVADO", "SEM_ESTOQUE"]) {
        await recusa(servico._mover_item(tx, linha, destino, u, { tipo_evento: servico.EPI_ITEM_ENTREGUE }), TransicaoInvalida);
      }
    }));

  it("terminal é terminal: recusado não volta", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const linha = await servico.recusar_item(tx, analista, (await itens(tx, requisicao))[0]!, {
        motivo: await motivo(tx),
      });
      await recusa(
        servico._mover_item(tx, linha, "APROVADO", analista, { tipo_evento: servico.EPI_ITEM_APROVADO }),
        TransicaoInvalida,
      );
    }));

  it("concluir a análise exige todo item decidido e um aprovado", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const oculos = await outro_item(tx, cen, "Óculos de proteção", "55555");
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.adicionar_item(tx, requerente, requisicao, { item: oculos, quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const [primeira, segunda] = await itens(tx, requisicao);
      await servico.aprovar_item(tx, analista, primeira!);
      const erro = await recusa(servico.concluir_analise(tx, analista, requisicao), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("sem decisão");
      await servico.recusar_item(tx, analista, segunda!, { motivo: await motivo(tx) });
      await servico.concluir_analise(tx, analista, requisicao, { parecer: "Luva devida" });
      expect(requisicao.estado).toBe("ANALISADA");
    }));

  it("indeferir exige todo item recusado e motivo do catálogo", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      await servico.aprovar_item(tx, analista, (await itens(tx, requisicao))[0]!);
      const erro = await recusa(
        servico.indeferir(tx, analista, requisicao, { motivo: await motivo(tx) }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("TODO item");
    }));

  it("a reconsideração traz o indeferido de volta, com motivo", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      await servico.recusar_item(tx, analista, (await itens(tx, requisicao))[0]!, { motivo: await motivo(tx) });
      await servico.indeferir(tx, analista, requisicao, { motivo: await motivo(tx) });
      expect(requisicao.estado).toBe("INDEFERIDA");
      expect(requisicao.motivo_recusa_id).not.toBeNull();

      await recusa(servico.reconsiderar(tx, analista, requisicao, ""), servico.RequisicaoBloqueada);
      await servico.reconsiderar(tx, analista, requisicao, "A chefia trouxe a descrição correta da atividade");
      expect(requisicao.estado).toBe("EM_ANALISE");
      // os itens NÃO voltam sozinhos
      expect((await itens(tx, requisicao))[0]!.estado).toBe("RECUSADO");
      const tipos = (await eventos(tx, "epi_requisicao", requisicao.id)).map((ev) => ev.tipo_evento);
      expect(tipos).toContain(servico.EPI_REQUISICAO_RECONSIDERADA);
    }));

  it("devolver para a fila solta o analista", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      expect(requisicao.analisado_por).toBe(analista.id);
      await servico.devolver_para_fila(tx, analista, requisicao, "Falta a descrição do posto");
      expect(requisicao.estado).toBe("ENVIADA");
      expect(requisicao.analisado_por).toBeNull();
    }));

  it("toda transição do envelope entra na trilha no formato de processo.mover", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const evs = await eventos(tx, "epi_requisicao", requisicao.id);
      expect(evs.map((ev) => ev.tipo_evento)).toEqual([
        servico.EPI_REQUISICAO_CRIADA,
        servico.EPI_REQUISICAO_ENVIADA,
        servico.EPI_REQUISICAO_EM_ANALISE,
      ]);
      expect(evs[1]!.campo).toBe("estado");
      expect([evs[1]!.valor_anterior, evs[1]!.valor_novo]).toEqual(["RASCUNHO", "ENVIADA"]);
    }));
});

// =====================================================================
// 10. A entrega — APROVADO direto para ENTREGUE, e a ATENDIDA automática
// =====================================================================
describe("a entrega", () => {
  async function analisado(
    tx: Parameters<Parameters<typeof desfeito>[0]>[0],
    o: { quantidade?: number; aprovada?: number; concluir?: boolean } = {},
  ) {
    const cen = await cenario(tx, { recebido: 10 });
    const analista = await usuario(tx, { login: "analista" });
    const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
    const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: o.quantidade ?? 2 });
    await servico.enviar(tx, requerente, requisicao);
    await servico.iniciar_analise(tx, analista, requisicao);
    const linha = (await itens(tx, requisicao))[0]!;
    await servico.aprovar_item(tx, analista, linha, { quantidade_aprovada: o.aprovada ?? null });
    if (o.concluir ?? true) await servico.concluir_analise(tx, analista, requisicao);
    return { cen, analista, requerente, requisicao, linha };
  }

  it("entregar reaproveita a ficha, baixa o lote e amarra o pedido", () =>
    desfeito(async (tx) => {
      const { cen, analista, linha } = await analisado(tx);
      const antes = await epi_estoque.saldo_fisico(tx, cen.entrada.id);
      const registro = await servico.entregar_item(tx, analista, linha, { entrada: cen.entrada });
      expect(await epi_estoque.saldo_fisico(tx, cen.entrada.id)).toBe(antes - 2);
      expect(registro.requisicao_item_id).toBe(linha.id);
      const [movimento] = await tx
        .select()
        .from(e.epi_movimento_estoque)
        .where(eq(e.epi_movimento_estoque.ficha_registro_id, registro.id));
      expect(movimento!.requisicao_item_id).toBe(linha.id);
      expect(registro.numero_ca_snapshot).toBe("41234");
    }));

  it("ATENDIDA chega sozinha quando o último item sai", () =>
    desfeito(async (tx) => {
      const { cen, analista, requisicao, linha } = await analisado(tx);
      expect(requisicao.estado).toBe("ANALISADA");
      await servico.entregar_item(tx, analista, linha, { entrada: cen.entrada, quantidade: 1 });
      expect((await reler(tx, requisicao))!.estado).toBe("EM_ATENDIMENTO");
      expect(linha.estado).toBe("APROVADO");
      expect(servico.quantidade_devida(linha)).toBe(1);
      await servico.entregar_item(tx, analista, linha, { entrada: cen.entrada, quantidade: 1 });
      expect(linha.estado).toBe("ENTREGUE");
      expect((await reler(tx, requisicao))!.estado).toBe("ATENDIDA");
      const tipos = (await eventos(tx, "epi_requisicao", requisicao.id)).map((ev) => ev.tipo_evento);
      expect(tipos.slice(-2)).toEqual([servico.EPI_REQUISICAO_EM_ATENDIMENTO, servico.EPI_REQUISICAO_ATENDIDA]);
    }));

  it("item recusado não impede a ATENDIDA", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { recebido: 10 });
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const protetor = await outro_item(tx, cen, "Protetor auricular", "33333");
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 1 });
      await servico.adicionar_item(tx, requerente, requisicao, { item: protetor, quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const [a, b] = await itens(tx, requisicao);
      await servico.aprovar_item(tx, analista, a!);
      await servico.recusar_item(tx, analista, b!, { motivo: await motivo(tx) });
      await servico.concluir_analise(tx, analista, requisicao);
      await servico.entregar_item(tx, analista, a!, { entrada: cen.entrada });
      expect((await reler(tx, requisicao))!.estado).toBe("ATENDIDA");
    }));

  it("cancelar o último item aprovado também fecha o pedido", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { recebido: 10 });
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const avental = await outro_item(tx, cen, "Avental de raspa", "22222");
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 1 });
      await servico.adicionar_item(tx, requerente, requisicao, { item: avental, quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const [a, b] = await itens(tx, requisicao);
      await servico.aprovar_item(tx, analista, a!);
      await servico.aprovar_item(tx, analista, b!);
      await servico.concluir_analise(tx, analista, requisicao);
      await servico.entregar_item(tx, analista, a!, { entrada: cen.entrada });
      expect((await reler(tx, requisicao))!.estado).toBe("EM_ATENDIMENTO");
      await servico.cancelar_item(tx, analista, b!, "Item veio pelo almoxarifado central");
      expect((await reler(tx, requisicao))!.estado).toBe("ATENDIDA");
    }));

  it("entregar mais do que foi aprovado é recusado", () =>
    desfeito(async (tx) => {
      const { cen, analista, linha } = await analisado(tx, { aprovada: 1 });
      const erro = await recusa(
        servico.entregar_item(tx, analista, linha, { entrada: cen.entrada, quantidade: 2 }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("foram aprovados 1");
    }));

  it("entregar antes de a análise terminar é recusado", () =>
    desfeito(async (tx) => {
      const { cen, analista, linha } = await analisado(tx, { concluir: false });
      const erro = await recusa(
        servico.entregar_item(tx, analista, linha, { entrada: cen.entrada }),
        servico.RequisicaoBloqueada,
      );
      expect(erro.message).toContain("analisada");
    }));

  it("cancelar pedido com entrega registrada é recusado", () =>
    desfeito(async (tx) => {
      const { cen, analista, requisicao, linha } = await analisado(tx);
      await servico.entregar_item(tx, analista, linha, { entrada: cen.entrada, quantidade: 1 });
      const erro = await recusa(servico.cancelar(tx, analista, requisicao, "desisti"), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("não se desfaz");
    }));

  it("a exceção da RN-26 autorizada na aprovação não trava o balcão", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { quantidade_maxima: 1, periodo_maximo_meses: 12, recebido: 10 });
      const analista = await usuario(tx, { login: "analista" });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      await balcao(tx, cen, analista);
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 1 });
      await servico.enviar(tx, requerente, requisicao);
      await servico.iniciar_analise(tx, analista, requisicao);
      const linha = (await itens(tx, requisicao))[0]!;
      await servico.aprovar_item(tx, analista, linha, {
        autorizar_excesso: true,
        justificativa: "Par anterior rasgou em serviço",
      });
      await servico.concluir_analise(tx, analista, requisicao);
      const registro = await servico.entregar_item(tx, analista, linha, { entrada: cen.entrada });
      expect(registro.requisicao_item_id).toBe(linha.id);
    }));
});

// =====================================================================
// 11. Permissões
// =====================================================================
describe("permissões", () => {
  it("as duas permissões novas existem e estão no módulo EPI", () => {
    for (const codigo of ["epi.requisitar", "epi.analisar"]) {
      expect(PERMISSOES[codigo]).toBeTruthy();
      expect(modulo_da_permissao(codigo)).toBe("EPI");
    }
  });

  it("o seed concede as permissões aos perfis da matriz", () =>
    desfeito(async (tx) => {
      const esperado: Record<string, string[]> = {
        coordenador_csso: ["epi.requisitar", "epi.analisar"],
        engenheiro_seguranca: ["epi.requisitar", "epi.analisar"],
        medico_trabalho: ["epi.requisitar", "epi.analisar"],
        tecnico_seguranca: ["epi.requisitar", "epi.analisar"],
        secretaria_csso: ["epi.requisitar"],
        servidor_consulta: ["epi.requisitar"],
      };
      const permissoes_de = async (codigo: string) => {
        const perfil = await tx.query.perfil.findFirst({
          where: eq(e.perfil.codigo, codigo),
          with: { perfil_permissoes: { with: { permissao: true } } },
        });
        return new Set(perfil!.perfil_permissoes.map((pp) => pp.permissao.codigo));
      };
      for (const [codigo, permissoes] of Object.entries(esperado)) {
        const tem = await permissoes_de(codigo);
        for (const p of permissoes) expect(tem.has(p), `${codigo} sem ${p}`).toBe(true);
      }
      // quem só opera a prateleira não decide o direito ao item
      expect((await permissoes_de("almoxarife_sesmt")).has("epi.analisar")).toBe(false);
    }));

  it("sem epi.requisitar não se abre rascunho", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const ninguem = await usuario(tx, { permissoes: ["epi.ver"], login: "curioso" });
      await recusa(servico.criar_rascunho(tx, ninguem, { servidor: cen.servidor }), PermissaoNegada);
    }));
});
