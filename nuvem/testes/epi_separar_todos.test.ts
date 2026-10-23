/**
 * "Separar todos" no pedido de EPI: a reserva de cada item reservável com lote
 * disponível, num ato só — a mesma auditoria e a mesma pendência da reserva
 * item a item, e UM e-mail de retirada listando os itens separados.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import { redefinirConfig } from "../src/config.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as epi_email from "../src/servicos/epi_email.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Resposta } from "./ajuda";
import {
  DAQUI_A_UM_ANO,
  HOJE,
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  outro_item,
  pedido_pronto,
  recusa,
  reler,
  usuario,
  type Cenario,
} from "./ajuda_epi_requisicao";

await bancoLimpo();

const FILA = "/epis/requisicoes";
const DO_SERVIDOR = "joana.almeida@ufvjm.edu.br";

function ligar_email(): void {
  process.env.CSSO_EPI_EMAIL = "sim";
  process.env.CSSO_EPI_EMAIL_SETOR = "sesmt.epi@ufvjm.edu.br";
  redefinirConfig();
}

afterEach(() => {
  delete process.env.CSSO_EPI_EMAIL;
  delete process.env.CSSO_EPI_EMAIL_SETOR;
  redefinirConfig();
});

/** Um lote a mais do item do cenário. */
async function lote(
  tx: Executor,
  cen: Cenario,
  o: { tamanho?: string | null; lote: string; quantidade?: number; validade_ca?: string; data_entrada?: string },
) {
  const [entrada] = await tx
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: cen.item.id,
      tamanho: o.tamanho === undefined ? "M" : o.tamanho,
      data_entrada: o.data_entrada ?? somar_dias(HOJE, -10),
      quantidade_recebida: o.quantidade ?? 10,
      lote: o.lote,
      numero_ca: "41234",
      validade_ca: o.validade_ca ?? DAQUI_A_UM_ANO,
    })
    .returning();
  await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: o.quantidade ?? 10 });
  return entrada!;
}

/**
 * Pedido analisado com três linhas: luva M (2, lote do cenário), luva G (1,
 * lote próprio) e um avental sem lote nenhum no estoque.
 */
async function montar(tx: Executor) {
  const cen = await cenario(tx);
  await tx.update(e.servidor).set({ email: DO_SERVIDOR }).where(eq(e.servidor.id, cen.servidor.id));
  const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana", servidor_id: cen.servidor.id });
  const analista = await usuario(tx, { login: "analista" });
  const almoxarife = await usuario(tx, { login: "almox", permissoes: ["epi.ver", "epi.estoque"] });
  const requisicao = await pedido_pronto(tx, cen, requerente);
  await servico.adicionar_item(tx, requerente, requisicao, { motivo: "USO_INICIAL", item: cen.item, quantidade: 1, tamanho: "G" });
  const avental = await outro_item(tx, cen, "Avental de PVC", "55555");
  await servico.adicionar_item(tx, requerente, requisicao, { motivo: "USO_INICIAL", item: avental, quantidade: 1 });
  const lote_g = await lote(tx, cen, { tamanho: "G", lote: "LOTE-G" });
  await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
  await servico.iniciar_analise(tx, analista, requisicao);
  await servico.aprovar_tudo(tx, analista, (await reler(tx, requisicao))!);
  return { cen, requerente, analista, almoxarife, requisicao: (await reler(tx, requisicao))!, lote_g, avental };
}

const retiradas = async (tx: Executor) =>
  (await tx.select().from(e.email_saida).orderBy(asc(e.email_saida.id))).filter((l) => l.tipo === epi_email.TIPO_RETIRADA);

describe("Separar todos (serviço)", () => {
  it("separa num ato todo item com estoque; o sem estoque fica e sai em 'faltaram'", () =>
    desfeito(async (tx) => {
      const { cen, almoxarife, requisicao, lote_g } = await montar(tx);
      const r = await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, requisicao));
      expect(r.separados.map((s) => [s.nome, s.tamanho, s.quantidade, s.lote])).toEqual([
        [cen.item.nome, "M", 2, "L-2026-08"],
        [cen.item.nome, "G", 1, "LOTE-G"],
      ]);
      expect(r.faltaram).toHaveLength(1);
      expect(r.faltaram[0]!.nome).toBe("Avental de PVC");
      expect(r.faltaram[0]!.motivo).toContain("não há lote deste item no estoque");

      const [m, g, av] = await itens(tx, requisicao);
      expect([m!.estado, m!.entrada_id, m!.quantidade_reservada]).toEqual(["RESERVADO", cen.entrada.id, 2]);
      expect([g!.estado, g!.entrada_id, g!.quantidade_reservada]).toEqual(["RESERVADO", lote_g.id, 1]);
      expect(av!.estado).toBe("APROVADO");
      expect((await reler(tx, requisicao))!.estado).toBe("EM_ATENDIMENTO");
      expect(await epi_estoque.disponivel(tx, cen.entrada.id)).toBe(8);

      // pendência de retirada por item reservado, como na reserva individual
      const tarefas = await tx
        .select()
        .from(e.pendencia)
        .where(and(eq(e.pendencia.tipo, servico.TIPO_PENDENCIA_RETIRADA), eq(e.pendencia.concluida, false)));
      expect(tarefas.map((t) => t.chave).sort()).toEqual(
        [servico.chave_da_pendencia_de_retirada(m!.id), servico.chave_da_pendencia_de_retirada(g!.id)].sort(),
      );
    }));

  it("escolhe o lote que vence primeiro e pula lote com CA vencido ou sem disponível", () =>
    desfeito(async (tx) => {
      const { cen, almoxarife, requisicao } = await montar(tx);
      await lote(tx, cen, { lote: "VENCIDO", validade_ca: somar_dias(HOJE, -1) });
      const cedo = await lote(tx, cen, { lote: "VENCE-CEDO", validade_ca: somar_dias(HOJE, 30) });
      await lote(tx, cen, { lote: "POUCO", quantidade: 1, validade_ca: somar_dias(HOJE, 5) });
      const r = await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, requisicao));
      expect(r.separados[0]!.lote).toBe("VENCE-CEDO");
      expect((await itens(tx, requisicao))[0]!.entrada_id).toBe(cedo.id);
    }));

  it("lote já prometido a outro pedido: o disponível manda, e o que faltou segue item a item", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx, { recebido: 3 });
      const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana", servidor_id: cen.servidor.id });
      const analista = await usuario(tx, { login: "analista" });
      const almoxarife = await usuario(tx, { login: "almox", permissoes: ["epi.ver", "epi.estoque"] });
      const analisado = async () => {
        const req = await pedido_pronto(tx, cen, requerente, { quantidade: 2 });
        await servico.enviar(tx, requerente, req, { termo_aceito: true });
        await servico.iniciar_analise(tx, analista, req);
        await servico.aprovar_tudo(tx, analista, (await reler(tx, req))!);
        return (await reler(tx, req))!;
      };
      const primeiro = await analisado();
      const segundo = await analisado();
      await servico.reservar_item(tx, almoxarife, (await itens(tx, primeiro))[0]!, { entrada: cen.entrada });
      expect(await epi_estoque.disponivel(tx, cen.entrada.id)).toBe(1);

      const r = await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, segundo));
      expect(r.separados).toHaveLength(0);
      expect(r.faltaram).toHaveLength(1);
      expect(r.faltaram[0]!.motivo).toContain("o pedido deve 2 e o lote com mais disponível tem 1");
      expect(await epi_estoque.disponivel(tx, cen.entrada.id)).toBe(1);
      // o que faltou continua reservável item a item (reserva parcial)
      const linha = (await itens(tx, segundo))[0]!;
      expect(linha.estado).toBe("APROVADO");
      await servico.reservar_item(tx, almoxarife, linha, { entrada: cen.entrada, quantidade: 1 });
      expect((await itens(tx, segundo))[0]!.estado).toBe("RESERVADO");
    }));

  it("sem epi.estoque é recusado como permissão, e nada muda", () =>
    desfeito(async (tx) => {
      const { analista, requisicao } = await montar(tx);
      await recusa(servico.reservar_todos(tx, analista, requisicao), PermissaoNegada);
      expect((await itens(tx, requisicao)).every((l) => l.estado === "APROVADO")).toBe(true);
    }));

  it("a auditoria de cada item é a mesma da reserva individual", () =>
    desfeito(async (tx) => {
      const { cen, requerente, analista, almoxarife, requisicao } = await montar(tx);
      await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, requisicao));
      const linha_lote = (await itens(tx, requisicao))[0]!;

      // um segundo pedido, reservado item a item no mesmo lote
      const outro = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, outro, { termo_aceito: true });
      await servico.iniciar_analise(tx, analista, outro);
      await servico.aprovar_tudo(tx, analista, (await reler(tx, outro))!);
      const linha_unica = (await itens(tx, outro))[0]!;
      await servico.reservar_item(tx, almoxarife, linha_unica, { entrada: cen.entrada });

      const forma = async (linha_id: number) =>
        (await eventos(tx, servico.ENTIDADE_ITEM, linha_id))
          .filter((ev) => ev.tipo_evento === servico.EPI_ITEM_RESERVADO)
          .map((ev) => ({
            tipo: ev.tipo_evento,
            descricao: ev.descricao,
            campo: ev.campo,
            antes: ev.valor_anterior,
            depois: ev.valor_novo,
            usuario: ev.usuario_id,
          }));
      const do_lote = await forma(linha_lote.id);
      expect(do_lote).toHaveLength(1);
      expect(do_lote).toEqual(await forma(linha_unica.id));
      expect(do_lote[0]!.descricao).toContain("2 × lote L-2026-08 (CA 41234)");
    }));

  it("com e-mail ligado sai UM e-mail de retirada listando os itens separados", () =>
    desfeito(async (tx) => {
      ligar_email();
      const { almoxarife, requisicao } = await montar(tx);
      const antes = (await retiradas(tx)).length;
      await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, requisicao));
      const r = (await retiradas(tx)).slice(antes);
      expect(r).toHaveLength(1);
      expect(r[0]!.destinatario).toBe(DO_SERVIDOR);
      expect(r[0]!.corpo).toContain("Há 2 itens");
      expect(r[0]!.corpo).toContain("2 × Luva de proteção química nitrílica (tamanho M)");
      expect(r[0]!.corpo).toContain("1 × Luva de proteção química nitrílica (tamanho G)");
      expect(r[0]!.corpo).not.toContain("Avental");
      const evs = (await eventos(tx, servico.ENTIDADE, requisicao.id)).filter(
        (x) => x.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO && x.descricao.includes("retirada"),
      );
      expect(evs).toHaveLength(1);
    }));

  it("pedido fora do atendimento, ou sem item a separar, é recusado com motivo", () =>
    desfeito(async (tx) => {
      const { cen, requerente, almoxarife, requisicao } = await montar(tx);
      await tx.transaction((ato) => servico.reservar_todos(ato, almoxarife, requisicao));
      // só sobrou o avental, sem lote: o ato roda e não separa nada
      const r = await servico.reservar_todos(tx, almoxarife, requisicao);
      expect(r.separados).toHaveLength(0);
      expect(r.faltaram).toHaveLength(1);
      const rascunho = await pedido_pronto(tx, cen, requerente);
      const erro = await recusa(servico.reservar_todos(tx, almoxarife, rascunho), servico.RequisicaoBloqueada);
      expect(erro.motivos[0]).toContain("separar exige a requisição analisada");
    }));
});

// =====================================================================
// Pela tela
// =====================================================================
function recado(r: Resposta): string {
  return r.location ? decodeURIComponent(r.location) : r.text;
}

/** Pedido analisado e GRAVADO (a tela lê de outra conexão). */
async function pedido_web() {
  const amb = await bancoLimpo();
  const ct = await contas(amb.db);
  const dados = await amb.db.transaction(async (tx) => {
    const cen = await cenario(tx);
    const coordenador = await usuarioAtual(tx, "coordenador_csso");
    const requisicao = await pedido_pronto(tx, cen, coordenador);
    const avental = await outro_item(tx, cen, "Avental de PVC", "55555");
    await servico.adicionar_item(tx, coordenador, requisicao, { motivo: "USO_INICIAL", item: avental, quantidade: 1 });
    await servico.enviar(tx, coordenador, requisicao, { termo_aceito: true });
    const analista = await usuario(tx, { login: "analista_web" });
    await servico.iniciar_analise(tx, analista, requisicao);
    await servico.aprovar_tudo(tx, analista, (await reler(tx, requisicao))!);
    return { cen, requisicao_id: requisicao.id, avental };
  });
  const como = (perfil: string) => entrar(amb.novoCliente(), ct[perfil]![0]);
  return { amb, como, ...dados };
}

describe("Separar todos (tela)", () => {
  it("botão na ficha para quem tem epi.estoque; o POST separa e o recado diz o que faltou", async () => {
    const { amb, como, cen, requisicao_id } = await pedido_web();
    const tecnico = await como("tecnico_seguranca");
    const ficha = (await tecnico.get(`${FILA}/${requisicao_id}`)).text;
    expect(ficha).toContain(`action="${FILA}/${requisicao_id}/separar-todos"`);
    expect(ficha).toContain("Separar todos");

    const r = await tecnico.post(`${FILA}/${requisicao_id}/separar-todos`, {}, { seguir: false });
    expect(r.status, recado(r)).toBe(303);
    const texto = recado(r);
    expect(texto).toContain("mensagem=");
    expect(texto).toContain("1 item separado");
    expect(texto).toContain("2 × 'Luva de proteção química nitrílica' (tamanho M) no lote L-2026-08");
    expect(texto).toContain("Faltou 1 item");
    expect(texto).toContain("'Avental de PVC' — não há lote deste item no estoque");
    expect(texto).toContain("#itens-do-pedido");

    const linhas = await amb.db
      .select()
      .from(e.epi_requisicao_item)
      .where(eq(e.epi_requisicao_item.requisicao_id, requisicao_id))
      .orderBy(asc(e.epi_requisicao_item.id));
    expect(linhas.map((l) => l.estado)).toEqual(["RESERVADO", "APROVADO"]);
    expect(linhas[0]!.entrada_id).toBe(cen.entrada.id);

    // nada mais separável: o botão some
    const depois = (await tecnico.get(`${FILA}/${requisicao_id}`)).text;
    expect(depois).not.toContain(`/separar-todos"`);
  });

  it("sem epi.estoque: 403, nenhum botão, e nada reservado", async () => {
    const { amb, como, requisicao_id } = await pedido_web();
    const medico = await como("medico_trabalho");
    expect((await medico.get(`${FILA}/${requisicao_id}`)).text).not.toContain("/separar-todos");
    const r = await medico.post(`${FILA}/${requisicao_id}/separar-todos`, {}, { seguir: false });
    expect(r.status).toBe(403);
    const linhas = await amb.db.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.requisicao_id, requisicao_id));
    expect(linhas.every((l) => l.estado === "APROVADO")).toBe(true);
  });

  it("item a item continua funcionando ao lado do botão", async () => {
    const { amb, como, cen, requisicao_id } = await pedido_web();
    const tecnico = await como("tecnico_seguranca");
    const [luva] = await amb.db
      .select()
      .from(e.epi_requisicao_item)
      .where(eq(e.epi_requisicao_item.requisicao_id, requisicao_id))
      .orderBy(asc(e.epi_requisicao_item.id));
    const r = await tecnico.post(
      `${FILA}/${requisicao_id}/itens/${luva!.id}/reservar`,
      { entrada_id: String(cen.entrada.id), quantidade: "1" },
      { seguir: false },
    );
    expect(r.status, recado(r)).toBe(303);
    const [depois] = await amb.db.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.id, luva!.id));
    expect([depois!.estado, depois!.quantidade_reservada]).toEqual(["RESERVADO", 1]);
    // a linha já reservada não volta a ser separada; o avental continua sem lote
    const s = await tecnico.post(`${FILA}/${requisicao_id}/separar-todos`, {}, { seguir: false });
    expect(recado(s)).toContain("erro=");
    expect(recado(s)).toContain("Nenhum item separado");
  });
});
