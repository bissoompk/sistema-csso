/**
 * Fatia A da paridade com o IntegraSST: o titular comunica o EPI que está com
 * ele (extravio ou troca), retira na janela de 24 h, e a equipe trata.
 *
 * As entregas nascem no BALCÃO (`ajuda_epi_ficha.entregar`), e não pelo pedido:
 * o fluxo do pedido é da fatia B.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as epi_comunicacao from "../src/servicos/epi_comunicacao.js";
import * as pendencias from "../src/servicos/pendencias.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { bancoPorTeste, cenario as montar, entregar, FICHAS, recado, registros, virar_o_titular } from "./ajuda_epi_ficha";

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

async function recusa_do_banco(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (erro) {
    const x = erro as Error & { cause?: Error };
    return `${x.message} ${x.cause?.message ?? ""}`;
  }
  return "(o banco aceitou)";
}

/** Entrega no balcão e amarra `servidor_consulta` ao servidor que recebeu. */
async function entrega_com_titular() {
  const c = await montar(db);
  const coord = await como("coordenador_csso");
  expect((await entregar(coord, c)).status).toBe(303);
  const [registro] = await registros(db);
  await virar_o_titular(db, c.servidor, "servidor_consulta");
  const titular = await como("servidor_consulta");
  return { c, coord, titular, registro: registro! };
}

function comunicar(cli: Cliente, registro_id: number, tipo = "DESGASTE", observacao = "") {
  return cli.post(`${FICHAS}/registros/${registro_id}/comunicar`, { tipo, observacao }, { seguir: false });
}

async function comunicacoes() {
  return db.select().from(e.epi_comunicacao_titular).orderBy(asc(e.epi_comunicacao_titular.id));
}

async function pendencia_da(id: number) {
  const [p] = await db
    .select()
    .from(e.pendencia)
    .where(eq(e.pendencia.chave, epi_comunicacao.chave_da_pendencia(id)));
  return p ?? null;
}

async function eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

async function envelhecer(id: number, horas: number) {
  await db.execute(
    sql`UPDATE epi_comunicacao_titular SET criado_em = now() - make_interval(hours => ${horas}) WHERE id = ${id}`,
  );
}

describe("comunicar", () => {
  it("o titular comunica, a pendência abre sem responsável e a trilha não nomeia", async () => {
    const { titular, registro } = await entrega_com_titular();
    const tela = await titular.get(`${FICHAS}/${registro.servidor_id}`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain(`#comunicar-${registro.id}`);

    const r = await comunicar(titular, registro.id, "EXTRAVIADO", "perdi no laboratório");
    expect(r.status).toBe(303);
    const [com] = await comunicacoes();
    expect(com!.registro_id).toBe(registro.id);
    expect(com!.servidor_id).toBe(registro.servidor_id);
    expect(com!.tipo).toBe("EXTRAVIADO");
    expect(com!.observacao).toBe("perdi no laboratório");

    const p = await pendencia_da(com!.id);
    expect(p!.tipo).toBe("EPI_COMUNICACAO_A_TRATAR");
    expect(p!.responsavel_id).toBeNull();
    expect(p!.concluida).toBe(false);
    expect(p!.entidade).toBe("epi_comunicacao_titular");
    expect(p!.entidade_id).toBe(com!.id);

    const [ev] = await eventos("EPI_COMUNICACAO_REGISTRADA");
    expect(ev!.descricao).toContain(`#${registro.servidor_id}`);
    expect(ev!.descricao).not.toContain("Joana");
    expect(ev!.descricao).toContain("sem cobrança");

    // a comunicação não mexe na ficha nem no estoque
    expect((await registros(db)).length).toBe(1);

    // depois de comunicar: o pedido de troca já preenchido
    const depois = await titular.get(r.location!);
    expect(depois.status).toBe(200);
    expect(depois.text).toContain(
      `/epis/requisicoes/nova?item=${registro.epi_item_id}&amp;tamanho=M&amp;motivo=PERDA&amp;finalidade=PERDA&amp;comunicacao=${com!.id}`,
    );
    // e a linha não oferece outra comunicação
    expect(depois.text).not.toContain(`#comunicar-${registro.id}`);
  });

  it("registro de outra pessoa recebe 403 — titular de outra ficha e equipe", async () => {
    const { c, coord, registro } = await entrega_com_titular();
    const [outro] = await db.insert(e.servidor).values({ siape: "5555555", nome: "Outra Pessoa" }).returning();
    await virar_o_titular(db, outro!.id, "servidor_consulta");
    const intruso = await como("servidor_consulta");
    expect((await comunicar(intruso, registro.id)).status).toBe(403);
    // a equipe não comunica em nome do titular
    expect((await comunicar(coord, registro.id)).status).toBe(403);
    // registro inexistente: a mesma resposta
    expect((await comunicar(intruso, 999999)).status).toBe(403);
    expect(await comunicacoes()).toEqual([]);
    expect(c.servidor).toBe(registro.servidor_id);
  });

  it("comunicação aberta duplicada é recusada", async () => {
    const { titular, registro } = await entrega_com_titular();
    expect((await comunicar(titular, registro.id)).status).toBe(303);
    const r = await comunicar(titular, registro.id, "TEMPO_DE_USO");
    expect(recado(r)).toContain("já há uma comunicação aberta");
    expect((await comunicacoes()).length).toBe(1);
  });

  it("situação fora da lista é recusada", async () => {
    const { titular, registro } = await entrega_com_titular();
    const r = await comunicar(titular, registro.id, "ROUBADO");
    expect(recado(r)).toContain("Escolha a situação");
    expect(await comunicacoes()).toEqual([]);
  });

  it("registro estornado é recusado", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    expect(
      (await coord.post(`${FICHAS}/registros/${registro.id}/estorno`, { motivo: "digitado errado" }, { seguir: false }))
        .status,
    ).toBe(303);
    const r = await comunicar(titular, registro.id);
    expect(recado(r)).toContain("estornado");
    expect(await comunicacoes()).toEqual([]);
  });

  it("registro já devolvido por inteiro é recusado; o que não é ENTREGA também", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    expect(
      (
        await coord.post(
          `${FICHAS}/registros/${registro.id}/devolucao`,
          { quantidade: String(registro.quantidade), motivo: "desligamento", motivo_codigo: "DESLIGAMENTO", data_evento: "" },
          { seguir: false },
        )
      ).status,
    ).toBe(303);
    expect(recado(await comunicar(titular, registro.id))).toContain("já foi devolvido");
    const devolucao = (await registros(db)).find((x) => x.tipo === "DEVOLUCAO")!;
    expect(recado(await comunicar(titular, devolucao.id))).toContain("só se comunica sobre uma entrega");
    expect(await comunicacoes()).toEqual([]);
  });
});

describe("retirar", () => {
  it("o titular retira com menos de 24 h: nada se apaga e a pendência fecha", async () => {
    const { titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    await envelhecer(com!.id, 23);
    const r = await titular.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("retirada");
    const [depois] = await comunicacoes();
    expect(depois!.retirada_em).not.toBeNull();
    expect(depois!.retirada_por).not.toBeNull();
    expect(depois!.tratada_em).toBeNull();
    expect((await pendencia_da(com!.id))!.concluida).toBe(true);
    expect((await eventos("EPI_COMUNICACAO_RETIRADA")).length).toBe(1);
    // retirada, a linha volta a aceitar comunicação
    expect((await comunicar(titular, registro.id, "TEMPO_DE_USO")).status).toBe(303);
    expect((await comunicacoes()).length).toBe(2);
  });

  it("depois de 24 h o titular é recusado; a equipe ainda retira", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    await envelhecer(com!.id, 25);
    const r = await titular.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    expect(recado(r)).toContain("passou das 24 horas");
    expect((await comunicacoes())[0]!.retirada_em).toBeNull();
    expect((await pendencia_da(com!.id))!.concluida).toBe(false);

    const pela_equipe = await coord.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    expect(pela_equipe.status).toBe(303);
    expect((await comunicacoes())[0]!.retirada_em).not.toBeNull();
    expect((await pendencia_da(com!.id))!.concluida).toBe(true);
  });

  it("outra pessoa sem epi.entregar recebe 403", async () => {
    const { titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    const [outro] = await db.insert(e.servidor).values({ siape: "5555556", nome: "Outra Pessoa" }).returning();
    await virar_o_titular(db, outro!.id, "servidor_consulta");
    const intruso = await como("servidor_consulta");
    expect((await intruso.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false })).status).toBe(403);
  });
});

describe("tratar", () => {
  it("a equipe trata depois de 24 h, a pendência fecha e a ficha mostra", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id, "PERDA_DE_EFICACIA");
    const [com] = await comunicacoes();
    await envelhecer(com!.id, 48);

    const ficha = await coord.get(`${FICHAS}/${registro.servidor_id}`);
    expect(ficha.text).toContain(`#tratar-comunicacao-${com!.id}`);
    // a devolução já vem com o motivo comunicado escolhido
    expect(ficha.text).toMatch(/<option value="PERDA_DE_EFICACIA" selected>/);

    // o titular não trata
    expect(
      (await titular.post(`/epis/comunicacoes/${com!.id}/tratar`, { tratamento: "x" }, { seguir: false })).status,
    ).toBe(403);

    const vazio = await coord.post(`/epis/comunicacoes/${com!.id}/tratar`, { tratamento: "  " }, { seguir: false });
    expect(recado(vazio)).toContain("o que foi feito");

    const r = await coord.post(
      `/epis/comunicacoes/${com!.id}/tratar`,
      { tratamento: "substituto entregue no balcão" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [depois] = await comunicacoes();
    expect(depois!.tratada_em).not.toBeNull();
    expect(depois!.tratamento).toBe("substituto entregue no balcão");
    expect((await pendencia_da(com!.id))!.concluida).toBe(true);
    expect((await eventos("EPI_COMUNICACAO_TRATADA")).length).toBe(1);

    // tratada não se retira nem se trata de novo
    const de_novo = await coord.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    expect(recado(de_novo)).toContain("já foi retirada ou tratada");

    // o titular vê o desfecho na própria ficha
    const minha = await titular.get(`${FICHAS}/${registro.servidor_id}`);
    expect(minha.text).toContain("comunicação tratada");
    expect(minha.text).toContain("substituto entregue no balcão");
  });

  it("contar_abertas e a âncora da pendência", async () => {
    const { titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    const coord = await usuarioAtual(db, "coordenador_csso");
    const servidor = await usuarioAtual(db, "servidor_consulta");
    expect(await epi_comunicacao.contar_abertas(db, coord)).toBe(1);
    expect(await epi_comunicacao.contar_abertas(db, servidor)).toBe(0);

    const p = (await pendencia_da(com!.id))!;
    const leitura = (await pendencias.leitura(db, coord, [p])).get(p.id)!;
    expect(leitura.onde.at(-1)!.href).toBe(`/epis/comunicacoes/${com!.id}`);
    const cli = await como("coordenador_csso");
    const r = await cli.get(`/epis/comunicacoes/${com!.id}`, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain(`${FICHAS}/${registro.servidor_id}`);
    const lista = await cli.get(FICHAS);
    expect(lista.text).toContain("comunicação(ões) de titulares");
  });
});

describe("devolução trata a comunicação aberta", () => {
  it("devolver a entrega comunicada trata a comunicação, fecha a pendência e registra a origem", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id, "EXTRAVIADO");
    const [com] = await comunicacoes();
    expect((await pendencia_da(com!.id))!.concluida).toBe(false);

    const r = await coord.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "1", motivo: "reposição combinada", motivo_codigo: "EXTRAVIADO", data_evento: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const devolucao = (await registros(db)).find((x) => x.tipo === "DEVOLUCAO")!;
    const [depois] = await comunicacoes();
    expect(depois!.tratada_em).not.toBeNull();
    expect(depois!.tratada_por).not.toBeNull();
    expect(depois!.retirada_em).toBeNull();
    expect(depois!.tratamento).toContain(`registro nº ${devolucao.id}`);
    expect((await pendencia_da(com!.id))!.concluida).toBe(true);
    const tratadas = await eventos("EPI_COMUNICACAO_TRATADA");
    expect(tratadas.length).toBe(1);
    expect(tratadas[0]!.entidade_id).toBe(com!.id);
    expect(tratadas[0]!.campo).toBe("origem");
    expect(String(tratadas[0]!.valor_novo)).toContain("DEVOLUCAO");
    expect(tratadas[0]!.descricao).toContain(`devolução nº ${devolucao.id}`);
    // a comunicação já tratada não se retira mais
    const ret = await titular.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    expect(recado(ret)).toContain("já foi retirada ou tratada");
  });

  it("devolução sem comunicação aberta não grava evento de comunicação", async () => {
    const { coord, titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    await titular.post(`/epis/comunicacoes/${com!.id}/retirar`, {}, { seguir: false });
    await coord.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "1", motivo: "desgaste", motivo_codigo: "DESGASTE", data_evento: "" },
      { seguir: false },
    );
    const [depois] = await comunicacoes();
    expect(depois!.retirada_em).not.toBeNull();
    expect(depois!.tratada_em).toBeNull();
    expect((await eventos("EPI_COMUNICACAO_TRATADA")).length).toBe(0);
  });
});

describe("devolução com motivo codificado", () => {
  it("a devolução grava motivo_codigo; código fora da lista é recusado", async () => {
    const { coord, registro } = await entrega_com_titular();
    const ruim = await coord.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "1", motivo: "x", motivo_codigo: "INVENTADO", data_evento: "" },
      { seguir: false },
    );
    expect(recado(ruim)).toContain("motivo da devolução na lista");
    const r = await coord.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "1", motivo: "rasgou na palma", motivo_codigo: "DESGASTE", data_evento: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const devolucao = (await registros(db)).find((x) => x.tipo === "DEVOLUCAO")!;
    expect(devolucao.motivo_codigo).toBe("DESGASTE");
    expect(devolucao.motivo).toBe("rasgou na palma");
    // a forma canônica leva o código, e a conferência continua limpa
    const ficha = await coord.get(`${FICHAS}/${registro.servidor_id}`);
    expect(ficha.text).not.toContain("divergência(s)");
  });
});

describe("travas do banco", () => {
  it("a trigger recusa UPDATE de motivo_codigo na ficha", async () => {
    const { coord, registro } = await entrega_com_titular();
    await coord.post(
      `${FICHAS}/registros/${registro.id}/devolucao`,
      { quantidade: "1", motivo: "desgaste", motivo_codigo: "DESGASTE", data_evento: "" },
      { seguir: false },
    );
    const devolucao = (await registros(db)).find((x) => x.tipo === "DEVOLUCAO")!;
    const msg = await recusa_do_banco(
      db.execute(sql`UPDATE epi_ficha_registro SET motivo_codigo = 'OUTRO' WHERE id = ${devolucao.id}`),
    );
    expect(msg).not.toBe("(o banco aceitou)");
    // nem de nulo para valor, na entrega
    const msg2 = await recusa_do_banco(
      db.execute(sql`UPDATE epi_ficha_registro SET motivo_codigo = 'OUTRO' WHERE id = ${registro.id}`),
    );
    expect(msg2).not.toBe("(o banco aceitou)");
  });

  it("a trigger recusa DELETE da comunicação", async () => {
    const { titular, registro } = await entrega_com_titular();
    await comunicar(titular, registro.id);
    const [com] = await comunicacoes();
    const msg = await recusa_do_banco(db.execute(sql`DELETE FROM epi_comunicacao_titular WHERE id = ${com!.id}`));
    expect(msg).not.toBe("(o banco aceitou)");
    expect((await comunicacoes()).length).toBe(1);
  });
});
