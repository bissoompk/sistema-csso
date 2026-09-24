/**
 * Fatia 2 de Gestão de EPI: a ficha — a prova legal de que o EPI foi entregue.
 * Porte de `testes/integracao/test_epi_ficha.py`.
 *
 * O que protegem, em ordem de gravidade: o congelamento (RN-15), CA vencido
 * não sai e quem manda é o do LOTE (RN-25), append-only (correção é ESTORNO),
 * e a janela da decisão 8 (registro sem prova é pendência).
 *
 * Cada teste ganha banco novo (`beforeEach`), como o fixture `banco` do pytest:
 * vários deles contam a tabela inteira (`_registros() == []`).
 *
 * Fora do porte: `test_a_lista_da_trava_cobre_todas_as_colunas_do_modelo` já
 * está em `testes/esquema/travas.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as documento from "../src/servicos/documento.js";
import * as comprovante_epi from "../src/servicos/comprovante_epi.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as identificacao from "../src/servicos/identificacao.js";
import { obterArmazenamento } from "../src/servicos/armazenamento.js";
import { bancoPorTeste } from "./ajuda_epi_ficha";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";
import {
  cenario as montar,
  DAQUI_A_UM_ANO,
  entregar,
  FICHAS,
  ENTREGAS,
  HOJE,
  movimentos_do_lote,
  NOVA,
  ONTEM,
  recado,
  registros,
  virar_o_titular,
} from "./ajuda_epi_ficha";

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

/** A mensagem do banco: o Drizzle embrulha o erro do Postgres em `cause`. */
async function recusa_do_banco(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (erro) {
    const e = erro as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ""}`;
  }
  return "(o banco aceitou)";
}

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

async function pendencias_de(tipo: string) {
  return db.select().from(e.pendencia).where(eq(e.pendencia.tipo, tipo));
}

// =====================================================================
// 1. O congelamento — RN-15 aplicada ao EPI
// =====================================================================
describe("congelamento", () => {
  it("a entrega congela o que valia no ato", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    expect((await entregar(cli, c)).status).toBe(303);

    const [registro] = await registros(db);
    expect(registro!.tipo).toBe("ENTREGA");
    expect(registro!.nome_epi_snapshot).toBe("Luva de proteção química nitrílica");
    expect(registro!.categoria_snapshot).toBe("Proteção dos membros superiores");
    expect(registro!.numero_ca_snapshot).toBe("41234");
    expect(registro!.validade_ca_snapshot).toBe(DAQUI_A_UM_ANO);
    expect(registro!.lote_snapshot).toBe("L-2026-08");
    expect(registro!.tamanho_snapshot).toBe("M");
    expect(registro!.siape_snapshot).toBe("7654321");
    expect(registro!.nome_servidor_snapshot).toBe("Joana Ribeiro de Almeida");
    // RN-32: a previsão de troca é congelada
    expect(registro!.previsao_troca).toBe(datas_br.somar_meses(HOJE, 6));
    const congelado = registro!.contexto_congelado as Record<string, unknown>;
    expect(congelado["empenho"]).toBe("2026NE000123");
    expect(congelado["pregao"]).toBe("90012/2025");
  });

  it("o extrato do lote não publica a matrícula de quem recebeu", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    expect((await entregar(cli, c)).status).toBe(303);
    const [saida] = await db.select().from(e.epi_movimento_estoque).where(eq(e.epi_movimento_estoque.tipo, "SAIDA"));
    expect(saida!.motivo ?? "").not.toContain("7654321");
    const corpo = (await cli.get(`/epis/estoque/${c.entrada}/movimentos`)).text;
    expect(corpo).not.toContain("7654321");
  });

  it("a devolução também não publica a matrícula no razão", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    expect((await entregar(cli, c)).status).toBe(303);
    const [entrega] = await registros(db);
    const devolucao = await cli.post(
      `${FICHAS}/registros/${entrega!.id}/devolucao`,
      { quantidade: "1", motivo: "desgaste no uso", data_evento: "" },
      { seguir: false },
    );
    expect(devolucao.status, devolucao.text).toBe(303);
    const razao = (await movimentos_do_lote(db, c)).map((m) => [m.tipo, m.motivo ?? ""] as const);
    expect(razao.some(([tipo]) => tipo === "DEVOLUCAO")).toBe(true);
    for (const [, motivo] of razao) expect(motivo).not.toContain("7654321");
    expect((await cli.get(`/epis/estoque/${c.entrada}/movimentos`)).text).not.toContain("7654321");
  });

  it("o extrato suprime a matrícula que o razão já gravou", async () => {
    const c = await montar(db);
    await db
      .insert(e.epi_movimento_estoque)
      .values({ entrada_id: c.entrada, tipo: "SAIDA", quantidade: -1, motivo: "entrega ao SIAPE 7654321" });
    const cli = await como("servidor_consulta");
    const r = await cli.get(`/epis/estoque/${c.entrada}/movimentos`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("7654321");
    expect(r.text).toContain(identificacao.TEXTO_SUPRIMIDO);
  });

  it("o extrato continua legível para quem vê exposição", async () => {
    const c = await montar(db);
    await db
      .insert(e.epi_movimento_estoque)
      .values({ entrada_id: c.entrada, tipo: "SAIDA", quantidade: -1, motivo: "entrega ao SIAPE 7654321" });
    const cli = await como("coordenador_csso");
    const corpo = (await cli.get(`/epis/estoque/${c.entrada}/movimentos`)).text;
    expect(corpo).toContain("entrega ao SIAPE 7654321");
    expect(corpo).not.toContain(identificacao.TEXTO_SUPRIMIDO);
  });

  it("renomear o item não reescreve a entrega de ontem", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    await db.update(e.epi_item).set({ nome: "Luva de procedimento", numero_ca: "99999" }).where(eq(e.epi_item.id, c.item));
    const [registro] = await registros(db);
    expect(registro!.nome_epi_snapshot).toBe("Luva de proteção química nitrílica");
    expect(registro!.numero_ca_snapshot).toBe("41234");
    const corpo = (await cli.get(`${FICHAS}/${c.servidor}`)).text;
    expect(corpo).toContain("Luva de proteção química nitrílica");
    expect(corpo).not.toContain("Luva de procedimento");
  });

  it("o comprovante sai dos snapshots e reimprime igual", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id: registro_id, data_evento }] = (await registros(db)) as unknown as [{ id: number; data_evento: string }];

    const primeira = await cli.get(`${FICHAS}/registros/${registro_id}/comprovante`);
    expect(primeira.status).toBe(200);
    expect(primeira.cabecalho("content-disposition")).toContain("Comprovante_EPI");

    const chave = comprovante_epi.caminho_saida(registro_id, Number(data_evento.slice(0, 4)));
    const texto_antes = documento.texto_normalizado(await obterArmazenamento().ler(chave));
    // o catálogo muda embaixo, e o papel não pode mudar junto
    await db.update(e.epi_item).set({ nome: "Luva qualquer coisa", numero_ca: "00000" }).where(eq(e.epi_item.id, c.item));

    await cli.get(`${FICHAS}/registros/${registro_id}/comprovante`);
    expect(documento.texto_normalizado(await obterArmazenamento().ler(chave))).toBe(texto_antes);
    expect(texto_antes).toContain("Luva de proteção química nitrílica");
    expect(texto_antes).toContain("41234");
    expect(texto_antes).toContain("NR-6");
    expect(texto_antes).toContain("7654321");
  });
});

// =====================================================================
// 2. RN-25 — CA vencido não se entrega, e quem manda é o do lote
// =====================================================================
describe("RN-25", () => {
  it("CA vencido no lote bloqueia a entrega", async () => {
    const c = await montar(db, { validade_ca_lote: ONTEM });
    const cli = await como("coordenador_csso");
    expect(recado(await entregar(cli, c))).toContain("CA vencido");
    expect(await registros(db)).toEqual([]);
  });

  it("o CA que vale é o do lote e não o do catálogo", async () => {
    const c = await montar(db, { validade_ca_catalogo: DAQUI_A_UM_ANO, validade_ca_lote: ONTEM });
    const cli = await como("coordenador_csso");
    expect(recado(await entregar(cli, c))).toContain("venceu em");
    expect(await registros(db)).toEqual([]);
  });

  it("lote sem validade de CA também não sai", async () => {
    const c = await montar(db, { validade_ca_lote: null });
    const cli = await como("coordenador_csso");
    expect(recado(await entregar(cli, c))).toContain("não tem validade de CA");
    expect(await registros(db)).toEqual([]);
  });

  it("o lote vencido não some da tela", async () => {
    const c = await montar(db, { validade_ca_lote: ONTEM });
    const cli = await como("coordenador_csso");
    const corpo = (await cli.get(`/epis/entregas/opcoes?item_id=${c.item}`)).text;
    expect(corpo).toContain("L-2026-08");
    expect(corpo).toContain("INDISPONÍVEL");
  });
});

// =====================================================================
// 3. RN-24 — saldo nunca fica negativo, e a baixa é pelo razão
// =====================================================================
describe("RN-24", () => {
  it("entregar mais do que o lote tem é recusado", async () => {
    const c = await montar(db, { recebido: 2 });
    const cli = await como("coordenador_csso");
    expect(recado(await entregar(cli, c, { quantidade: 3 }))).toContain("2 disponível(is)");
    expect(await registros(db)).toEqual([]);
  });

  it("a entrega baixa o lote pelo livro razão", async () => {
    const c = await montar(db, { recebido: 10 });
    const cli = await como("coordenador_csso");
    await entregar(cli, c, { quantidade: 3 });
    const [registro] = await registros(db);
    expect(await epi_estoque.saldo_fisico(db, c.entrada)).toBe(7);
    const saidas = await db.select().from(e.epi_movimento_estoque).where(eq(e.epi_movimento_estoque.tipo, "SAIDA"));
    expect(saidas).toHaveLength(1);
    expect(saidas[0]!.quantidade).toBe(-3);
    expect(saidas[0]!.ficha_registro_id).toBe(registro!.id);
  });
});

// =====================================================================
// 4. A janela da decisão 8 — registro sem prova é pendência
// =====================================================================
describe("decisão 8", () => {
  it("entrega sem comprovante abre pendência e aparece na tela", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const ps = await pendencias_de("COMPROVANTE_EPI_PENDENTE");
    expect(ps).toHaveLength(1);
    expect(ps[0]!.concluida).toBe(false);
    expect(ps[0]!.entidade).toBe("epi_ficha_registro");
    expect(ps[0]!.responsavel_id).not.toBeNull();

    const corpo = (await cli.get(`${FICHAS}/${c.servidor}`)).text;
    expect(corpo).toContain("sem comprovante");
    expect(corpo).toContain("registro e sem prova");
    expect((await cli.get(FICHAS)).text).toContain("1 pendente(s)");
  });

  it("a pendência leva até a ficha", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [registro] = await registros(db);
    const fila = (await cli.get("/pendencias")).text;
    expect(fila).toContain(`href="${FICHAS}/registros/${registro!.id}?de=pendencias"`);
    const salto = await cli.get(`${FICHAS}/registros/${registro!.id}`, { seguir: false });
    expect(salto.status).toBe(303);
    expect(salto.location).toBe(`${FICHAS}/${c.servidor}`);
  });

  it("anexar o assinado fecha a janela", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id: registro_id }] = (await registros(db)) as unknown as [{ id: number }];
    const r = await cli.post(
      `${FICHAS}/registros/${registro_id}/comprovante`,
      { arquivo: new File([new TextEncoder().encode("%PDF-1.4 assinatura")], "assinado.pdf", { type: "application/pdf" }) },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("SHA-256");

    const [registro] = await db.select().from(e.epi_ficha_registro).where(eq(e.epi_ficha_registro.id, registro_id));
    expect(registro!.comprovante_anexo_id).not.toBeNull();
    expect(registro!.recebimento_confirmado_em).not.toBeNull();
    const [anexo] = await db.select().from(e.anexo).where(eq(e.anexo.id, registro!.comprovante_anexo_id!));
    expect(anexo!.categoria).toBe("FICHA_EPI");
    expect(anexo!.nivel_acesso).toBe("RESTRITO");
    expect(anexo!.assinado).toBe(true);
    const [pendencia] = await pendencias_de("COMPROVANTE_EPI_PENDENTE");
    expect(pendencia!.concluida).toBe(true);

    const corpo = (await cli.get(`${FICHAS}/${c.servidor}`)).text;
    expect(corpo).not.toContain("sem comprovante");
    expect(corpo).toContain("comprovante ·");
  });

  it("trocar o comprovante já anexado é recusado", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    const pdf = (t: string, n: string) => new File([new TextEncoder().encode(t)], n, { type: "application/pdf" });
    await cli.post(`${FICHAS}/registros/${id}/comprovante`, { arquivo: pdf("%PDF-1.4 um", "a.pdf") });
    const segunda = await cli.post(
      `${FICHAS}/registros/${id}/comprovante`,
      { arquivo: pdf("%PDF-1.4 dois", "b.pdf") },
      { seguir: false },
    );
    expect(recado(segunda)).toContain("já tem comprovante");
  });
});

// =====================================================================
// 5. Append-only — a trava do banco, revista sem afrouxar a prova
// =====================================================================
async function linha_direta(siape: string, nome: string, item_nome: string) {
  const [categoria] = await db.select().from(e.epi_categoria).orderBy(asc(e.epi_categoria.id)).limit(1);
  const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  const [item] = await db
    .insert(e.epi_item)
    .values({ nome: item_nome, categoria_id: categoria!.id, exige_ca: false, quantidade_padrao: 1 })
    .returning();
  const [servidor] = await db.insert(e.servidor).values({ siape, nome, unidade_uorg_id: unidade!.id }).returning();
  const [registro] = await db
    .insert(e.epi_ficha_registro)
    .values({
      servidor_id: servidor!.id,
      epi_item_id: item!.id,
      tipo: "ENTREGA",
      quantidade: 1,
      data_evento: HOJE,
      nome_epi_snapshot: item!.nome,
      categoria_snapshot: "X",
      nome_servidor_snapshot: servidor!.nome,
      siape_snapshot: servidor!.siape,
      entregue_por: coord!.id,
    })
    .returning();
  return { registro: registro!, servidor: servidor! };
}

describe("append-only", () => {
  it("o conteúdo da ficha continua inalterável", async () => {
    const { registro } = await linha_direta("1212121", "Alvo", "Bota de segurança");
    for (const [coluna, valor] of [
      ["quantidade", 9],
      ["nome_epi_snapshot", "outra coisa"],
      ["siape_snapshot", "9999999"],
      ["motivo", "rasura"],
      ["data_evento", "2020-01-01"],
    ] as const) {
      expect(
        await recusa_do_banco(
          db.execute(sql`UPDATE epi_ficha_registro SET ${sql.identifier(coluna)} = ${valor} WHERE id = ${registro.id}`),
        ),
        coluna,
      ).toMatch(/append-only/);
    }
    expect(await recusa_do_banco(db.execute(sql`DELETE FROM epi_ficha_registro WHERE id = ${registro.id}`))).toMatch(
      /append-only/,
    );
  });

  it("as três colunas de completude se preenchem uma vez só", async () => {
    const { registro } = await linha_direta("1313131", "Alvo 2", "Capacete");
    const primeiro = (
      await auditoria.registrar(db, {
        entidade: "epi_ficha_registro",
        entidade_id: registro.id,
        tipo_evento: "EPI_ENTREGUE",
        descricao: "primeiro",
      })
    ).id;
    const segundo = (
      await auditoria.registrar(db, {
        entidade: "epi_ficha_registro",
        entidade_id: registro.id,
        tipo_evento: "EPI_ENTREGUE",
        descricao: "segundo",
      })
    ).id;
    await db.execute(sql`UPDATE epi_ficha_registro SET evento_id = ${primeiro} WHERE id = ${registro.id}`);
    expect(
      await recusa_do_banco(db.execute(sql`UPDATE epi_ficha_registro SET evento_id = ${segundo} WHERE id = ${registro.id}`)),
    ).toMatch(/append-only/);
  });
});

// =====================================================================
// 6. Estorno — a única forma de corrigir
// =====================================================================
describe("estorno", () => {
  it("estorno é linha nova e a errada continua visível", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c, { quantidade: 5 });
    const [original] = await registros(db);
    const r = await cli.post(
      `${FICHAS}/registros/${original!.id}/estorno`,
      { motivo: "quantidade digitada errada" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const todos = await registros(db);
    expect(todos).toHaveLength(2);
    const estorno = todos[1]!;
    expect(estorno.tipo).toBe("ESTORNO");
    expect(estorno.registro_estornado_id).toBe(original!.id);
    expect(estorno.motivo).toBe("quantidade digitada errada");
    expect(estorno.nome_epi_snapshot).toBe(original!.nome_epi_snapshot);
    const corpo = (await cli.get(`${FICHAS}/${c.servidor}`)).text;
    expect(corpo).toContain(`estornado pelo nº ${estorno.id}`);
    expect(corpo).toContain("estorna o nº");
  });

  it("estorno sem motivo é recusado", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    const r = await cli.post(`${FICHAS}/registros/${id}/estorno`, { motivo: "   " }, { seguir: false });
    expect(recado(r)).toContain("exige o motivo");
    expect(await registros(db)).toHaveLength(1);
  });

  it("estorno fecha a pendência do comprovante", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await cli.post(`${FICHAS}/registros/${id}/estorno`, { motivo: "lançamento em duplicidade" });
    const [pendencia] = await pendencias_de("COMPROVANTE_EPI_PENDENTE");
    expect(pendencia!.concluida).toBe(true);
  });

  it("o estorno não devolve saldo ao estoque", async () => {
    const c = await montar(db, { recebido: 10 });
    const cli = await como("coordenador_csso");
    await entregar(cli, c, { quantidade: 4 });
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await cli.post(`${FICHAS}/registros/${id}/estorno`, { motivo: "servidor errado" });
    expect(await epi_estoque.saldo_fisico(db, c.entrada)).toBe(6);
  });
});

// =====================================================================
// 7. A amarração com a cadeia de hash (§6.2)
// =====================================================================
describe("cadeia de hash", () => {
  it("a linha da ficha aponta para o evento que a registrou", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [registro] = await registros(db);
    expect(registro!.evento_id).not.toBeNull();
    const [evento] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.id, registro!.evento_id!));
    expect(evento!.tipo_evento).toBe("EPI_ENTREGUE");
    expect(evento!.valor_novo).toEqual(epi_ficha.forma_canonica(registro!));
    expect(await auditoria.cadeia_integra(db)).toEqual([true, null]);
    expect(await epi_ficha.conferir(db, c.servidor)).toEqual([]);
  });

  it("a conferência acusa linha sem evento", async () => {
    const { servidor } = await linha_direta("1414141", "Sem evento", "Avental");
    const achados = await epi_ficha.conferir(db, servidor.id);
    expect(achados).toHaveLength(1);
    expect(achados[0]!.detalhe).toContain("não aponta para nenhum evento");
  });
});

// =====================================================================
// 8. RN-26 — a máxima conta o que a FICHA registra
// =====================================================================
describe("RN-26", () => {
  it("máximo excedido bloqueia até alguém assinar a exceção", async () => {
    const c = await montar(db, { quantidade_maxima: 2, periodo_maximo_meses: 12 });
    const cli = await como("coordenador_csso");
    expect((await entregar(cli, c, { quantidade: 2 })).status).toBe(303);
    expect(recado(await entregar(cli, c, { quantidade: 2 }))).toContain("já recebeu 2");
    expect(await registros(db)).toHaveLength(1);
    const com_excecao = await entregar(cli, c, {
      quantidade: 2,
      justificativa_excecao: "par danificado em incidente no laboratório",
    });
    expect(com_excecao.status).toBe(303);
    expect(await registros(db)).toHaveLength(2);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "EPI_MAXIMO_EXCEDIDO"));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain("par danificado");
  });

  it("a linha estornada não conta para o máximo", async () => {
    const c = await montar(db, { quantidade_maxima: 2, periodo_maximo_meses: 12 });
    const cli = await como("coordenador_csso");
    await entregar(cli, c, { quantidade: 2 });
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await cli.post(`${FICHAS}/registros/${id}/estorno`, { motivo: "servidor errado" });
    expect((await entregar(cli, c, { quantidade: 2 })).status).toBe(303);
  });
});

// =====================================================================
// 9. RN-27 e as decisões 3 e 7 — a recusa fundamentada
// =====================================================================
describe("recusa fundamentada", () => {
  it("a recusa congela o texto do motivo na trilha", async () => {
    await montar(db);
    const cli = await como("coordenador_csso");
    const [motivo] = await db
      .select()
      .from(e.epi_motivo_recusa)
      .where(eq(e.epi_motivo_recusa.codigo, "VINCULO_NAO_ATENDIDO"));
    const texto_original = motivo!.texto;
    const r = await cli.post(
      `${ENTREGAS}/recusa`,
      {
        motivo_id: String(motivo!.id),
        a_quem: "chefia da FAMED, em nome da equipe de limpeza contratada",
        unidade: "FAMED",
        complemento: "",
      },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(recado(r)).toContain("VINCULO_NAO_ATENDIDO");

    const ler = async () =>
      db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "EPI_ENTREGA_RECUSADA"));
    let [evento] = await ler();
    const valor = evento!.valor_novo as Record<string, string>;
    expect(valor["motivo"]).toBe("VINCULO_NAO_ATENDIDO");
    expect(valor["texto"]).toBe(texto_original);
    expect(valor["texto"]).toContain("empresa contratante");
    expect(evento!.entidade).toBe("epi_motivo_recusa");

    await db
      .update(e.epi_motivo_recusa)
      .set({ texto: "Texto novo, editado depois." })
      .where(eq(e.epi_motivo_recusa.id, motivo!.id));
    [evento] = await ler();
    expect((evento!.valor_novo as Record<string, string>)["texto"]).toBe(texto_original);
  });

  it("motivo que exige complemento não passa sem ele", async () => {
    const cli = await como("coordenador_csso");
    const [outro] = await db.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, "OUTRO"));
    const r = await cli.post(
      `${ENTREGAS}/recusa`,
      { motivo_id: String(outro!.id), a_quem: "alguém", complemento: "" },
      { seguir: false },
    );
    expect(recado(r)).toContain("exige o complemento");
  });
});

// =====================================================================
// 10. RN-21 e RN-30 — texto livre passa pelo filtro
// =====================================================================
describe("texto livre", () => {
  it("observação com dado de saúde é recusada", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    const r = await entregar(cli, c, { observacao: "Servidora gestante, afastada do setor." });
    expect(recado(r)).toContain("termo proibido");
    expect(await registros(db)).toEqual([]);
  });

  it("entrega com data futura é recusada", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    const r = await entregar(cli, c, { data_evento: datas_br.somar_dias(HOJE, 1) });
    expect(recado(r)).toContain("data futura");
    expect(await registros(db)).toEqual([]);
  });
});

// =====================================================================
// 11. Permissões e RN-23
// =====================================================================
describe("permissões", () => {
  it.each([
    ["coordenador_csso", 200, 200],
    ["tecnico_seguranca", 200, 200],
    ["engenheiro_seguranca", 200, 403],
    ["medico_trabalho", 200, 403],
    ["auditor_interno", 200, 403],
    ["consulta_progep", 200, 403],
    ["secretaria_csso", 403, 403],
    ["servidor_consulta", 403, 403],
    ["admin_ti", 403, 403],
  ])("%s: fichas %i, entrega %i", async (perfil, fichas, entrega) => {
    const cli = await como(perfil);
    expect((await cli.get(FICHAS)).status).toBe(fichas);
    expect((await cli.get(NOVA)).status).toBe(entrega);
  });

  it("o titular vê a própria ficha sem epi.ficha", async () => {
    const c = await montar(db);
    const coord = await como("coordenador_csso");
    await entregar(coord, c);
    await virar_o_titular(db, c.servidor, "servidor_consulta");
    const cli = await como("servidor_consulta");
    const minha = await cli.get(`${FICHAS}/${c.servidor}`);
    expect(minha.status).toBe(200);
    expect(minha.text).toContain("Joana Ribeiro de Almeida");
    const [outro] = await db.insert(e.servidor).values({ siape: "5555555", nome: "Outra Pessoa" }).returning();
    expect((await cli.get(`${FICHAS}/${outro!.id}`)).status).toBe(403);
  });

  it("ler a ficha de outro entra em acesso_dado_sensivel", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    await cli.get(`${FICHAS}/${c.servidor}`);
    const campos = new Set(
      (await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.servidor_id, c.servidor))).map(
        (a) => a.campo,
      ),
    );
    expect(campos.has("epi_ficha")).toBe(true);
  });

  it("baixar o comprovante assinado também é registrado", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await cli.post(`${FICHAS}/registros/${id}/comprovante`, {
      arquivo: new File([new TextEncoder().encode("%PDF-1.4 x")], "a.pdf", { type: "application/pdf" }),
    });
    expect((await cli.get(`${FICHAS}/registros/${id}/anexo`)).status).toBe(200);
    const campos = new Set((await db.select().from(e.acesso_dado_sensivel)).map((a) => a.campo));
    expect(campos.has("anexo.FICHA_EPI")).toBe(true);
  });

  it("imprimir o próprio comprovante não entra em acesso_dado_sensivel", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await virar_o_titular(db, c.servidor);
    expect((await cli.get(`${FICHAS}/registros/${id}/comprovante`)).status).toBe(200);
    const acessos = await db
      .select()
      .from(e.acesso_dado_sensivel)
      .where(eq(e.acesso_dado_sensivel.servidor_id, c.servidor));
    const impressoes = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "EPI_COMPROVANTE_IMPRESSO"));
    expect(acessos).toEqual([]);
    expect(impressoes.length).toBeGreaterThan(0);
  });

  it("baixar o próprio comprovante assinado não entra em acesso_dado_sensivel", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const [{ id }] = (await registros(db)) as unknown as [{ id: number }];
    await cli.post(`${FICHAS}/registros/${id}/comprovante`, {
      arquivo: new File([new TextEncoder().encode("%PDF-1.4 x")], "a.pdf", { type: "application/pdf" }),
    });
    await virar_o_titular(db, c.servidor);
    expect((await cli.get(`${FICHAS}/registros/${id}/anexo`)).status).toBe(200);
    const campos = new Set((await db.select().from(e.acesso_dado_sensivel)).map((a) => a.campo));
    const baixados = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "ANEXO_BAIXADO"));
    expect(campos.has("anexo.FICHA_EPI")).toBe(false);
    expect(baixados.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// 12. A ficha embutida em /servidores/{id}
// =====================================================================
describe("ficha no cadastro do servidor", () => {
  it("a ficha de EPI aparece no cadastro do servidor", async () => {
    const c = await montar(db);
    const cli = await como("coordenador_csso");
    await entregar(cli, c);
    const corpo = (await cli.get(`/servidores/${c.servidor}`)).text;
    expect(corpo).toContain("EPI recebido");
    expect(corpo).toContain("Luva de proteção química nitrílica");
    expect(corpo).toContain(`href="/epis/fichas/${c.servidor}"`);
  });

  it("quem não vê a ficha não vê a seção", async () => {
    const c = await montar(db);
    await entregar(await como("coordenador_csso"), c);
    const corpo = (await (await como("secretaria_csso")).get(`/servidores/${c.servidor}`)).text;
    expect(corpo).not.toContain("EPI recebido");
  });
});
