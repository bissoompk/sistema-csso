/**
 * Fatia 5 de Gestão de EPI: a reserva de lote, e o que ela promete.
 * Porte de `testes/integracao/test_epi_reserva.py`.
 *
 * A reserva existe para impedir que dois pedidos prometam o mesmo par de
 * botas: RN-24 (inclusive a corrida de duas reservas simultâneas), RN-25 nos
 * DOIS momentos, `reservado()` verdadeiro, reserva não é movimento, a promessa
 * se desfaz onde perdeu o lastro, e a máquina de estado como guarda.
 */
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { TransicaoInvalida } from "../src/dominio/estados.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, naTransacao } from "./ajuda";
import { DAQUI_A_UM_ANO, HOJE, desfeito, itens, recusa, reler, reler_linha, usuario } from "./ajuda_epi_requisicao";

const { db, url, cliente } = await bancoLimpo();
const CONTAS = await contas(db);

// O almoxarife da §8: opera estoque e entrega, não decide o direito ao item.
const ALMOXARIFE = ["epi.ver", "epi.estoque", "epi.entregar"];
// uma conta só para armar o pedido inteiro; a separação de função tem teste na fatia 4
const TUDO = ["epi.ver", "epi.requisitar", "epi.analisar", "epi.estoque", "epi.entregar"];

type Item = typeof e.epi_item.$inferSelect;
type Entrada = typeof e.epi_entrada_estoque.$inferSelect;
type Servidor = typeof e.servidor.$inferSelect;

// =====================================================================
// Montagem
// =====================================================================
let sequencia = 0;
const operador = (tx: Executor, permissoes = TUDO, login = "operador") =>
  usuario(tx, { permissoes, login: `${login}${++sequencia}` });

async function lote(
  tx: Executor,
  item: Item,
  o: { recebido: number; validade_ca: string | null; lote?: string; numero_ca?: string; tamanho?: string | null },
): Promise<Entrada> {
  const [entrada] = await tx
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item.id,
      tamanho: o.tamanho === undefined ? "M" : o.tamanho,
      empenho: "2026NE000123",
      data_entrada: somar_dias(HOJE, -60),
      quantidade_recebida: o.recebido,
      lote: o.lote ?? "L-2026-08",
      numero_ca: o.numero_ca ?? "41234",
      validade_ca: o.validade_ca,
    })
    .returning();
  await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: o.recebido });
  return entrada!;
}

/** Um servidor, um item de catálogo com tamanhos e (talvez) um lote. */
async function cenario(
  tx: Executor,
  o: {
    recebido?: number;
    validade_ca?: string | null;
    com_lote?: boolean;
    siape?: string;
    nome?: string;
    nome_item?: string;
  } = {},
): Promise<{ servidor: Servidor; item: Item; entrada: Entrada | null }> {
  // os testes que GRAVAM (corrida, tela) usam item próprio: o lote deles fica
  // no banco do arquivo e mudaria o "há lote elegível" dos testes desfeitos
  const nome_item = o.nome_item ?? "Luva de proteção química nitrílica";
  const [categoria] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [unidade] = await tx.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [servidor] = await tx
    .insert(e.servidor)
    .values({
      siape: o.siape ?? "7654321",
      nome: o.nome ?? "Joana Ribeiro de Almeida",
      cargo_id: cargo!.id,
      unidade_uorg_id: unidade!.id,
    })
    .returning();
  let [item] = await tx.select().from(e.epi_item).where(eq(e.epi_item.nome, nome_item));
  if (!item) {
    [item] = await tx
      .insert(e.epi_item)
      .values({
        nome: nome_item,
        categoria_id: categoria!.id,
        fabricante: "Fabricante Exemplo Ltda",
        modelo: "NX-200",
        exige_ca: true,
        numero_ca: "41234",
        validade_ca: DAQUI_A_UM_ANO,
        unidade_medida: "PAR",
        tamanhos: "P\nM\nG",
        quantidade_padrao: 1,
      })
      .returning();
  }
  const entrada =
    o.com_lote ?? true
      ? await lote(tx, item!, { recebido: o.recebido ?? 10, validade_ca: o.validade_ca ?? DAQUI_A_UM_ANO })
      : null;
  return { servidor: servidor!, item: item!, entrada };
}

/** Um pedido enviado, analisado e com a linha em APROVADO. Devolve a LINHA. */
async function pedido_analisado(
  tx: Executor,
  cen: { servidor: Servidor; item: Item },
  u: UsuarioAtual,
  o: { quantidade?: number; servidor?: Servidor } = {},
) {
  const requisicao = await servico.criar_rascunho(tx, u, {
    servidor: o.servidor ?? cen.servidor,
    descricao_atividade: "Manipulação de reagentes no laboratório de análises",
  });
  await servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: o.quantidade ?? 2, tamanho: "M" });
  await servico.enviar(tx, u, requisicao);
  await servico.iniciar_analise(tx, u, requisicao);
  const linha = (await itens(tx, requisicao))[0]!;
  await servico.aprovar_item(tx, u, linha);
  await servico.concluir_analise(tx, u, requisicao);
  return linha;
}

async function eventos_de_item(tx: Executor, linha_id: number): Promise<string[]> {
  const evs = await tx
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.entidade, servico.ENTIDADE_ITEM), eq(e.historico_evento.entidade_id, linha_id)))
    .orderBy(asc(e.historico_evento.id));
  return evs.map((ev) => ev.tipo_evento);
}

const envelope = async (tx: Executor, linha: { requisicao_id: number }) => (await reler(tx, { id: linha.requisicao_id }))!;

// =====================================================================
// 1. `reservado()` deixou de ser zero
// =====================================================================
describe("reservado() é verdade", () => {
  it("bate com a soma das linhas em RESERVADO", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 10 });
      const entrada = cen.entrada!;
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);

      const reservada = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, reservada, { entrada });
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(3);

      const outra = await cenario(tx, { com_lote: false, siape: "1112223", nome: "Carlos Menezes" });
      const cancelada = await pedido_analisado(tx, cen, u, { quantidade: 2, servidor: outra.servidor });
      await servico.reservar_item(tx, u, cancelada, { entrada });
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(5);

      await servico.cancelar_item(tx, u, cancelada, "servidor mudou de posto");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(3);
    }));

  it("a versão agregada não diverge da individual", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 10 });
      const segundo = await lote(tx, cen.item, { recebido: 6, validade_ca: DAQUI_A_UM_ANO, lote: "L-2026-09" });
      const terceiro = await lote(tx, cen.item, { recebido: 4, validade_ca: DAQUI_A_UM_ANO, lote: "L-2026-10" });
      const primeira = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, primeira, { entrada: cen.entrada! });
      const outra = await cenario(tx, { com_lote: false, siape: "1112223", nome: "Carlos Menezes" });
      const segunda = await pedido_analisado(tx, cen, u, { quantidade: 2, servidor: outra.servidor });
      await servico.reservar_item(tx, u, segunda, { entrada: segundo });

      const agregado = await epi_estoque.reservas_de_todos(tx);
      for (const entrada of [cen.entrada!, segundo, terceiro]) {
        expect(agregado.get(entrada.id) ?? 0, entrada.lote!).toBe(await epi_estoque.reservado(tx, entrada.id));
      }
      // o lote sem reserva nenhuma não aparece no agregado
      expect(agregado.has(terceiro.id)).toBe(false);
    }));

  it("reservar não mexe no físico e desconta do disponível", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 10 });
      const entrada = cen.entrada!;
      const movimentos_antes = (await epi_estoque.extrato(tx, entrada.id)).length;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 4 });
      await servico.reservar_item(tx, u, linha, { entrada });
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(10);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(4);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(6);
      expect((await epi_estoque.extrato(tx, entrada.id)).length).toBe(movimentos_antes);
    }));

  it("a tela do estoque passa a mostrar a reserva sozinha", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 10 });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 4 });
      await servico.reservar_item(tx, u, linha, { entrada: cen.entrada! });
      const painel = await epi_estoque.panorama(tx);
      const l = painel.flatMap((i) => i.lotes).find((x) => x.entrada.id === cen.entrada!.id)!;
      expect([l.fisico, l.reservado, l.disponivel]).toEqual([10, 4, 6]);
    }));
});

// =====================================================================
// 2. RN-24 — saldo nunca fica negativo
// =====================================================================
describe("RN-24", () => {
  it("a entrega de balcão não leva o que um pedido reservou", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 4 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, linha, { entrada });
      const avulso = await cenario(tx, { com_lote: false, siape: "1112223", nome: "Carlos Menezes" });
      const falha = await recusa(
        epi_ficha.registrar_entrega(tx, u, {
          servidor: avulso.servidor,
          item: cen.item,
          quantidade: 2,
          entrada,
          tamanho: "M",
        }),
        epi_ficha.EntregaBloqueada,
      );
      expect(falha.message).toContain("1 disponível");
      const registro = await epi_ficha.registrar_entrega(tx, u, {
        servidor: avulso.servidor,
        item: cen.item,
        quantidade: 1,
        entrada,
        tamanho: "M",
      });
      expect(registro.quantidade).toBe(1);
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(3);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(3);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(0);
    }));

  it("recusa reservar três de um lote com dois", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 2 });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      const falha = await recusa(
        servico.reservar_item(tx, u, linha, { entrada: cen.entrada!, quantidade: 3 }),
        servico.RequisicaoBloqueada,
      );
      expect(falha.message).toContain("RN-24");
      expect(linha.estado).toBe("APROVADO");
      expect(linha.quantidade_reservada).toBe(0);
    }));

  it("recusa entregar três de um lote com dois", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 2 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      const falha = await recusa(
        servico.entregar_item(tx, u, linha, { entrada, quantidade: 3 }),
        epi_ficha.EntregaBloqueada,
      );
      expect(falha.message).toContain("2 disponível");

      await servico.reservar_item(tx, u, linha, { entrada, quantidade: 2 });
      const falha2 = await recusa(servico.entregar_item(tx, u, linha, { quantidade: 3 }), servico.RequisicaoBloqueada);
      expect(falha2.message).toContain("a reserva é de 2");

      await servico.entregar_item(tx, u, linha);
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(0);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
      expect(linha.quantidade_entregue).toBe(2);
    }));

  it("reservar não passa do que outro pedido já prometeu", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const primeira = await pedido_analisado(tx, cen, u, { quantidade: 4 });
      await servico.reservar_item(tx, u, primeira, { entrada });
      const outra = await cenario(tx, { com_lote: false, siape: "1112223", nome: "Carlos Menezes" });
      const segunda = await pedido_analisado(tx, cen, u, { quantidade: 3, servidor: outra.servidor });
      const falha = await recusa(
        servico.reservar_item(tx, u, segunda, { entrada, quantidade: 3 }),
        servico.RequisicaoBloqueada,
      );
      expect(falha.message).toContain("físico 5");
      expect(falha.message).toContain("4 já prometido");
    }));

  it("duas reservas simultâneas do mesmo lote não somam mais que o disponível", async () => {
    // A corrida de verdade, em duas conexões. No Postgres é o `FOR UPDATE` na
    // linha do lote (o `BEGIN IMMEDIATE` do SQLite) que as enfileira.
    const alvo = await naTransacao(async (tx) => {
      const u = await usuario(tx, { permissoes: TUDO, login: "almoxarife_corrida" });
      const cen = await cenario(tx, { recebido: 3, siape: "3000001", nome: "Corrida Um", nome_item: "Luva da corrida" });
      const outra = await cenario(tx, { com_lote: false, siape: "3000002", nome: "Corrida Dois", nome_item: "Luva da corrida" });
      const primeira = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      const segunda = await pedido_analisado(tx, cen, u, { quantidade: 2, servidor: outra.servidor });
      return { entrada: cen.entrada!.id, usuario: u.id, linhas: [primeira.id, segunda.id] };
    });
    const sql = postgres(url, { max: 4, prepare: false, onnotice: () => {} });
    const banco2 = drizzle(sql, { schema: e });
    try {
      const reservar = (linha_id: number) =>
        banco2
          .transaction(async (tx) => {
            const [conta] = await tx.select().from(e.usuario).where(eq(e.usuario.id, alvo.usuario));
            const op = new UsuarioAtual({
              id: conta!.id,
              login: conta!.login,
              nome: conta!.nome,
              permissoes: ALMOXARIFE,
              perfis: ["almoxarife_sesmt"],
            });
            const [linha] = await tx.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.id, linha_id));
            const [entrada] = await tx
              .select()
              .from(e.epi_entrada_estoque)
              .where(eq(e.epi_entrada_estoque.id, alvo.entrada));
            await servico.reservar_item(tx, op, linha!, { entrada: entrada!, quantidade: 2 });
            return "reservou";
          })
          .catch((erro) => {
            if (erro instanceof servico.RequisicaoBloqueada) return "recusado";
            throw erro;
          });
      const resultados = (await Promise.all(alvo.linhas.map(reservar))).sort();
      expect(resultados).toEqual(["recusado", "reservou"]);
      await naTransacao(async (tx) => {
        expect(await epi_estoque.reservado(tx, alvo.entrada)).toBe(2);
        expect(await epi_estoque.disponivel(tx, alvo.entrada)).toBe(1);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

// =====================================================================
// 3. RN-25 — o CA, nos DOIS momentos
// =====================================================================
describe("RN-25", () => {
  it("recusa reservar lote com CA vencido", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5, validade_ca: somar_dias(HOJE, -10) });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      const falha = await recusa(servico.reservar_item(tx, u, linha, { entrada: cen.entrada! }), servico.RequisicaoBloqueada);
      expect(falha.message).toContain("venceu em");
      expect(linha.estado).toBe("APROVADO");
    }));

  it("recusa reservar lote sem validade de CA", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      await tx
        .update(e.epi_entrada_estoque)
        .set({ validade_ca: null })
        .where(eq(e.epi_entrada_estoque.id, cen.entrada!.id));
      cen.entrada!.validade_ca = null;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      const falha = await recusa(servico.reservar_item(tx, u, linha, { entrada: cen.entrada! }), servico.RequisicaoBloqueada);
      expect(falha.message).toContain("não tem validade de CA registrada");
    }));

  it("confere de novo na entrega quando o CA vence no intervalo", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const venceu_ontem = somar_dias(HOJE, -1);
      const cen = await cenario(tx, { recebido: 5, validade_ca: venceu_ontem });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada, quando: somar_dias(venceu_ontem, -30) });
      expect(linha.estado).toBe("RESERVADO");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(2);
      const falha = await recusa(servico.entregar_item(tx, u, linha), epi_ficha.EntregaBloqueada);
      expect(falha.message).toContain("CA vencido não se entrega");
    }));

  it("lote de CA vencido continua com saldo físico e fica indisponível", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { recebido: 7, validade_ca: somar_dias(HOJE, -30) });
      const entrada = cen.entrada!;
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(7);
      const lotes = await epi_estoque.lotes_de(tx, cen.item, { tamanho: "M" });
      const candidato = lotes.find((l) => l.entrada.id === entrada.id)!;
      expect(candidato.saldo).toBe(7);
      expect(candidato.pode_sair).toBe(false);
      expect(candidato.impedimento).toContain("venceu em");
      const linha_do_item = (await epi_estoque.panorama(tx)).find((i) => i.item.id === cen.item.id)!;
      expect(linha_do_item.preso_em_lote_vencido).toBe(7);
      expect(linha_do_item.disponivel).toBe(0);
    }));
});

// =====================================================================
// 4. As transições da máquina D
// =====================================================================
describe("as transições da reserva", () => {
  it("a primeira reserva leva a requisição para EM_ATENDIMENTO", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      expect((await envelope(tx, linha)).estado).toBe("ANALISADA");
      await servico.reservar_item(tx, u, linha, { entrada: cen.entrada! });
      expect((await envelope(tx, linha)).estado).toBe("EM_ATENDIMENTO");
      await servico.entregar_item(tx, u, linha);
      expect(linha.estado).toBe("ENTREGUE");
      expect((await envelope(tx, linha)).estado).toBe("ATENDIDA");
    }));

  it("entregar item reservado grava movimento e ficha na mesma transação", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada });
      const registro = await servico.entregar_item(tx, u, linha);
      expect(registro.requisicao_item_id).toBe(linha.id);
      expect(registro.entrada_id).toBe(entrada.id);
      expect(registro.numero_ca_snapshot).toBe(entrada.numero_ca);
      const saida = (await epi_estoque.extrato(tx, entrada.id))
        .map((m) => m.movimento)
        .find((m) => m.tipo === epi_estoque.SAIDA)!;
      expect(saida.quantidade).toBe(-2);
      expect(saida.ficha_registro_id).toBe(registro.id);
      expect(saida.requisicao_item_id).toBe(linha.id);
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(3);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(3);
    }));

  it("a entrega de item reservado não troca de lote", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const outro = await lote(tx, cen.item, { recebido: 5, validade_ca: DAQUI_A_UM_ANO, lote: "L-2026-09" });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada: cen.entrada! });
      const falha = await recusa(servico.entregar_item(tx, u, linha, { entrada: outro }), servico.RequisicaoBloqueada);
      expect(falha.message).toContain("L-2026-08");
      expect(falha.message.toLowerCase()).toContain("solte a reserva");
    }));

  it("soltar reserva exige motivo e devolve o item para SEM_ESTOQUE", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada });
      const falha = await recusa(servico.soltar_reserva(tx, u, linha, "   "), servico.RequisicaoBloqueada);
      expect(falha.message).toContain("obrigatório");
      expect(linha.estado).toBe("RESERVADO");
      await servico.soltar_reserva(tx, u, linha, "unidades foram para a brigada de emergência");
      expect(linha.estado).toBe("SEM_ESTOQUE");
      expect(linha.quantidade_reservada).toBe(0);
      expect(linha.entrada_id).toBeNull();
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(5);
      expect(await eventos_de_item(tx, linha.id)).toContain(servico.EPI_ITEM_RESERVA_SOLTA);
    }));

  it("marcar sem estoque é recusado quando há lote elegível", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      const falha = await recusa(servico.marcar_sem_estoque(tx, u, linha), servico.RequisicaoBloqueada);
      expect(falha.message).toContain("há lote elegível");
      expect(linha.estado).toBe("APROVADO");
    }));

  it("marcar sem estoque passa quando não há lote elegível", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { com_lote: false });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.marcar_sem_estoque(tx, u, linha, { complemento: "empenho 2026NE000456 em entrega" });
      expect(linha.estado).toBe("SEM_ESTOQUE");
      expect(await eventos_de_item(tx, linha.id)).toContain(servico.EPI_ITEM_SEM_ESTOQUE);
      // o envelope NÃO anda: sem estoque não é começo de atendimento
      expect((await envelope(tx, linha)).estado).toBe("ANALISADA");
    }));

  it("SEM_ESTOQUE volta para RESERVADO quando o almoxarifado reserva", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { com_lote: false });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.marcar_sem_estoque(tx, u, linha);
      const entrada = await epi_estoque.registrar_entrada(tx, u, {
        item: cen.item,
        quantidade_recebida: 6,
        tamanho: "M",
        lote: "L-2026-11",
        numero_ca: "41234",
        validade_ca: DAQUI_A_UM_ANO,
      });
      // a entrada NÃO reservou sozinha
      expect((await reler_linha(tx, linha))!.estado).toBe("SEM_ESTOQUE");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
      const esperando = await servico.itens_esperando_estoque(tx, { epi_item_id: cen.item.id, tamanho: "M" });
      expect(esperando.map((i) => i.id)).toEqual([linha.id]);
      await servico.reservar_item(tx, u, linha, { entrada });
      expect(linha.estado).toBe("RESERVADO");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(2);
    }));

  it("a máquina recusa toda transição de reserva não declarada", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const requisicao = await servico.criar_rascunho(tx, u, {
        servidor: cen.servidor,
        descricao_atividade: "Manipulação de reagentes",
      });
      await servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "M" });
      await servico.enviar(tx, u, requisicao);
      const solicitada = (await itens(tx, requisicao))[0]!;
      for (const destino of ["RESERVADO", "SEM_ESTOQUE"]) {
        await recusa(
          servico._mover_item(tx, solicitada, destino, u, { tipo_evento: servico.EPI_ITEM_RESERVADO }),
          TransicaoInvalida,
        );
      }
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada: cen.entrada! });
      for (const destino of ["APROVADO", "SOLICITADO", "RECUSADO"]) {
        await recusa(servico._mover_item(tx, linha, destino, u, { tipo_evento: servico.EPI_ITEM_APROVADO }), TransicaoInvalida);
      }
      await servico.soltar_reserva(tx, u, linha, "lote separado para outro caso");
      await recusa(servico._mover_item(tx, linha, "ENTREGUE", u, { tipo_evento: servico.EPI_ITEM_ENTREGUE }), TransicaoInvalida);
    }));

  it("reservar e soltar exigem a permissão de estoque", () =>
    desfeito(async (tx) => {
      const dono = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const linha = await pedido_analisado(tx, cen, dono, { quantidade: 2 });
      const analista = await operador(tx, ["epi.ver", "epi.requisitar", "epi.analisar"], "analista");
      await recusa(servico.reservar_item(tx, analista, linha, { entrada: cen.entrada! }), PermissaoNegada);
      await recusa(servico.marcar_sem_estoque(tx, analista, linha), PermissaoNegada);
      await servico.reservar_item(tx, dono, linha, { entrada: cen.entrada! });
      await recusa(servico.soltar_reserva(tx, analista, linha, "não deveria passar"), PermissaoNegada);
    }));

  it("reservar recusa lote de outro item e de outro tamanho", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const [oculos] = await tx
        .insert(e.epi_item)
        .values({
          nome: "Óculos de proteção",
          categoria_id: cen.item.categoria_id,
          exige_ca: true,
          numero_ca: "55555",
          validade_ca: DAQUI_A_UM_ANO,
          quantidade_padrao: 1,
        })
        .returning();
      const de_outro = await lote(tx, oculos!, { recebido: 5, validade_ca: DAQUI_A_UM_ANO, lote: "L-OC-01" });
      const tamanho_p = await lote(tx, cen.item, { recebido: 5, validade_ca: DAQUI_A_UM_ANO, lote: "L-2026-P", tamanho: "P" });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      const f1 = await recusa(servico.reservar_item(tx, u, linha, { entrada: de_outro }), servico.RequisicaoBloqueada);
      expect(f1.message).toContain("outro item do catálogo");
      const f2 = await recusa(servico.reservar_item(tx, u, linha, { entrada: tamanho_p }), servico.RequisicaoBloqueada);
      expect(f2.message).toContain("tamanho");
    }));
});

// =====================================================================
// 5. A promessa se desfaz onde perdeu o lastro
// =====================================================================
describe("a promessa se desfaz onde perdeu o lastro", () => {
  it("cancelar item reservado solta a reserva", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, linha, { entrada });
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(2);
      await servico.cancelar_item(tx, u, linha, "servidor foi desligado");
      expect(linha.estado).toBe("CANCELADO");
      expect(linha.quantidade_reservada).toBe(0);
      expect(linha.entrada_id).toBeNull();
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(5);
    }));

  it("cancelar o pedido inteiro solta as reservas dele", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, linha, { entrada });
      await servico.cancelar(tx, u, await envelope(tx, linha), "pedido substituído por outro protocolo");
      expect((await reler_linha(tx, linha))!.estado).toBe("CANCELADO");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(5);
    }));

  it("descartar o lote solta a reserva que ficou sem lastro", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 6 });
      const entrada = cen.entrada!;
      const outra = await cenario(tx, { com_lote: false, siape: "1112223", nome: "Carlos Menezes" });
      const antiga = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, antiga, { entrada });
      const nova = await pedido_analisado(tx, cen, u, { quantidade: 3, servidor: outra.servidor });
      await servico.reservar_item(tx, u, nova, { entrada });
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(5);

      // sobram 2 físicos: a promessa de 5 não cabe, e a mais nova cai
      await epi_estoque.descartar(tx, u, {
        entrada,
        quantidade: 4,
        motivo: "caixa molhada em alagamento do almoxarifado",
      });
      expect((await reler_linha(tx, nova))!.estado).toBe("SEM_ESTOQUE");
      expect((await reler_linha(tx, antiga))!.estado).toBe("RESERVADO");
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(2);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(2);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(0);
      const [ev] = await tx
        .select()
        .from(e.historico_evento)
        .where(
          and(
            eq(e.historico_evento.entidade, servico.ENTIDADE_ITEM),
            eq(e.historico_evento.entidade_id, nova.id),
            eq(e.historico_evento.tipo_evento, servico.EPI_ITEM_RESERVA_SOLTA),
          ),
        );
      expect(String(ev!.comentario)).toContain("descartadas");
    }));

  it("inativar o lote solta todas as reservas dele", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 10 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada });
      await epi_estoque.atualizar_lote(tx, u, {
        entrada,
        nota_fiscal: "",
        fornecedor_contato: "",
        observacao: "",
        ativo: false,
        motivo_inativacao: "recolhimento do fabricante por defeito de costura",
      });
      expect((await reler_linha(tx, linha))!.estado).toBe("SEM_ESTOQUE");
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
      // o saldo físico continua lá: inativar não é descartar
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(10);
    }));

  it("ajuste de inventário para menos solta o que não cabe", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 6 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 5 });
      await servico.reservar_item(tx, u, linha, { entrada });
      await epi_estoque.ajustar(tx, u, { entrada, contagem: 3, motivo: "contagem do inventário anual" });
      expect((await reler_linha(tx, linha))!.estado).toBe("SEM_ESTOQUE");
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(3);
      expect(await epi_estoque.reservado(tx, entrada.id)).toBe(0);
    }));

  it("reserva parcial entregue inteira devolve o item para SEM_ESTOQUE", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 2 });
      const entrada = cen.entrada!;
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 5 });
      await servico.reservar_item(tx, u, linha, { entrada, quantidade: 2 });
      await servico.entregar_item(tx, u, linha);
      expect(linha.quantidade_entregue).toBe(2);
      expect(servico.quantidade_devida(linha)).toBe(3);
      expect(linha.estado).toBe("SEM_ESTOQUE");
      expect(linha.quantidade_reservada).toBe(0);
      expect(linha.entrada_id).toBeNull();
      // o envelope continua em atendimento: ainda deve 3
      expect((await envelope(tx, linha)).estado).toBe("EM_ATENDIMENTO");
    }));

  it("reserva solta e reservada de novo noutro lote", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const entrada = cen.entrada!;
      const outro = await lote(tx, cen.item, { recebido: 4, validade_ca: DAQUI_A_UM_ANO, lote: "L-2026-09" });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 3 });
      await servico.reservar_item(tx, u, linha, { entrada });
      await servico.soltar_reserva(tx, u, linha, "lote trocado a pedido do setor");
      await servico.reservar_item(tx, u, linha, { entrada: outro });
      expect(linha.estado).toBe("RESERVADO");
      expect(linha.entrada_id).toBe(outro.id);
      expect(await epi_estoque.disponivel(tx, entrada.id)).toBe(5);
      expect(await epi_estoque.disponivel(tx, outro.id)).toBe(1);
      expect(await epi_estoque.saldo_fisico(tx, entrada.id)).toBe(5);
      expect(await epi_estoque.saldo_fisico(tx, outro.id)).toBe(4);
    }));

  it("recusar item reservado não é caminho, e o estado não muda", () =>
    desfeito(async (tx) => {
      const u = await operador(tx);
      const cen = await cenario(tx, { recebido: 5 });
      const linha = await pedido_analisado(tx, cen, u, { quantidade: 2 });
      await servico.reservar_item(tx, u, linha, { entrada: cen.entrada! });
      const [m] = await tx.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, "SEM_EXPOSICAO"));
      await recusa(servico.recusar_item(tx, u, linha, { motivo: m! }), servico.RequisicaoBloqueada);
      expect(linha.estado).toBe("RESERVADO");
    }));
});

// =====================================================================
// 6. Pela tela — o que só a tela pode quebrar
// =====================================================================
let siape_tela = 4000000;
/** Um pedido analisado, com a linha em APROVADO, pronto para reservar (gravado). */
async function pedido_pela_tela(o: { recebido?: number; validade_ca?: string | null; com_lote?: boolean } = {}) {
  return naTransacao(async (tx) => {
    const op = await operador(tx, TUDO, "montagem");
    const cen = await cenario(tx, {
      recebido: o.recebido ?? 5,
      validade_ca: o.validade_ca ?? null,
      com_lote: o.com_lote ?? true,
      siape: String(++siape_tela),
      nome: `Servidora de tela ${siape_tela}`,
      nome_item: `Luva da tela ${siape_tela}`,
    });
    const linha = await pedido_analisado(tx, cen, op, { quantidade: 2 });
    return {
      requisicao: linha.requisicao_id,
      linha: linha.id,
      entrada: cen.entrada ? cen.entrada.id : null,
      item: cen.item.id,
    };
  });
}

const estado_da_linha = (linha_id: number) => naTransacao(async (tx) => (await reler_linha(tx, { id: linha_id }))!);

async function como(perfil: string) {
  await cliente.get("/sair");
  cliente.cookies.clear();
  await entrar(cliente, CONTAS[perfil]![0]);
}

describe("pela tela", () => {
  it("a ficha do pedido oferece reservar a quem opera o estoque", async () => {
    // sem outro pedido no mesmo lote: a tela conta "5 em estoque"
    const dados = await pedido_pela_tela({ validade_ca: DAQUI_A_UM_ANO });
    const caminho = `/epis/requisicoes/${dados.requisicao}`;
    await como("engenheiro_seguranca");
    let corpo = (await cliente.get(caminho)).text;
    expect(corpo).not.toContain("Reservar lote");

    await como("almoxarife_sesmt");
    const r = await cliente.get(caminho);
    expect(r.status).toBe(200);
    corpo = r.text;
    expect(corpo).toContain("Reservar lote");
    expect(corpo).toContain("Marcar como sem estoque");
    expect(corpo).toContain("L-2026-08");
    expect(corpo).toContain("5 em estoque");
  });

  it("a tela reserva, solta e mostra o lote reservado", async () => {
    const dados = await pedido_pela_tela();
    const caminho = `/epis/requisicoes/${dados.requisicao}`;
    await como("almoxarife_sesmt");
    let r = await cliente.post(
      `${caminho}/itens/${dados.linha}/reservar`,
      { entrada_id: String(dados.entrada), quantidade: "2" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect((await estado_da_linha(dados.linha)).estado).toBe("RESERVADO");

    const corpo = (await cliente.get(caminho)).text.replace(/\r\n/g, "\n");
    expect(corpo).toContain("2\n            reservado(s) no lote L-2026-08");
    expect(corpo).toContain("Soltar a reserva");

    r = await cliente.post(
      `${caminho}/itens/${dados.linha}/soltar-reserva`,
      { motivo: "lote separado para a brigada de emergência" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const linha = await estado_da_linha(dados.linha);
    expect(linha.estado).toBe("SEM_ESTOQUE");
    expect(linha.quantidade_reservada).toBe(0);
  });

  it("a tela recusa reservar sem dizer o lote", async () => {
    const dados = await pedido_pela_tela();
    await como("almoxarife_sesmt");
    const r = await cliente.post(
      `/epis/requisicoes/${dados.requisicao}/itens/${dados.linha}/reservar`,
      { entrada_id: "", quantidade: "2" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Escolha o lote");
    expect((await estado_da_linha(dados.linha)).estado).toBe("APROVADO");
  });

  it("CA vencido é etiqueta vermelha, com o botão desabilitado e o motivo", async () => {
    const dados = await pedido_pela_tela({ recebido: 5, validade_ca: somar_dias(HOJE, -15) });
    await como("almoxarife_sesmt");
    const corpo = (await cliente.get(`/epis/requisicoes/${dados.requisicao}`)).text;
    expect(corpo).toContain("L-2026-08");
    expect(corpo).toContain("pilula erro");
    expect(corpo).toContain("venceu em");
    expect(corpo).toContain("INDISPONÍVEL");
    expect(corpo).toContain("Botão desabilitado");
    expect(corpo).toContain("renovar o CA do lote");

    const r = await cliente.post(
      `/epis/requisicoes/${dados.requisicao}/itens/${dados.linha}/reservar`,
      { entrada_id: String(dados.entrada), quantidade: "2" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect((await estado_da_linha(dados.linha)).estado).toBe("APROVADO");
  });

  it("a tela do estoque não diz mais que reservar não existe", async () => {
    const dados = await pedido_pela_tela();
    await como("almoxarife_sesmt");
    await cliente.post(
      `/epis/requisicoes/${dados.requisicao}/itens/${dados.linha}/reservar`,
      { entrada_id: String(dados.entrada), quantidade: "2" },
      { seguir: false },
    );
    const r = await cliente.get("/epis/estoque");
    expect(r.status).toBe(200);
    const corpo = r.text;
    expect(corpo).toContain("Reservado");
    expect(corpo).toContain("Reserva não é movimento");
    expect(corpo).toContain('<td class="numerico">5</td>');
    expect(corpo).toContain('<td class="numerico">2</td>');
    expect(corpo).toContain('<td class="numerico">3</td>');
  });

  it("a entrada de lote avisa quem espera em vez de reservar sozinha", async () => {
    // item próprio: os outros testes da tela deixaram itens esperando o mesmo EPI
    const dados = await naTransacao(async (tx) => {
      const op = await operador(tx, TUDO, "montagem");
      const cen = await cenario(tx, { com_lote: false, siape: String(++siape_tela), nome: "Espera Lote" });
      const [item] = await tx
        .insert(e.epi_item)
        .values({
          nome: "Bota de segurança com biqueira",
          categoria_id: cen.item.categoria_id,
          exige_ca: true,
          numero_ca: "41234",
          validade_ca: DAQUI_A_UM_ANO,
          tamanhos: "M",
          quantidade_padrao: 1,
        })
        .returning();
      const linha = await pedido_analisado(tx, { servidor: cen.servidor, item: item! }, op, { quantidade: 2 });
      return { requisicao: linha.requisicao_id, linha: linha.id, item: item!.id };
    });
    await como("almoxarife_sesmt");
    await cliente.post(
      `/epis/requisicoes/${dados.requisicao}/itens/${dados.linha}/sem-estoque`,
      { complemento: "" },
      { seguir: false },
    );
    expect((await estado_da_linha(dados.linha)).estado).toBe("SEM_ESTOQUE");

    const r = await cliente.post(
      "/epis/estoque",
      {
        item_id: String(dados.item),
        quantidade_recebida: "12",
        data_entrada: HOJE,
        tamanho: "M",
        lote: "L-2026-12",
        numero_ca: "41234",
        validade_ca: DAQUI_A_UM_ANO,
      },
      { seguir: false },
    );
    const recado = decodeURIComponent(r.location ?? "");
    expect(recado).toContain("1 item(ns) de pedido(s) esperam este equipamento");
    expect(recado).toContain("a reserva não é automática");
    expect((await estado_da_linha(dados.linha)).estado).toBe("SEM_ESTOQUE");
  });
});
