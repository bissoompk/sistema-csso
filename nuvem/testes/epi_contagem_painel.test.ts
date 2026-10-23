/**
 * Fatia G da paridade de EPI: a contagem do que espera a equipe — pedidos a
 * analisar (`epi.analisar`) e comunicações do titular a tratar
 * (`epi.entregar`) — no painel `/epis` e no Início. Origem: `L:Core.js:656-686`
 * (o selo de pendentes). A contagem no MENU foi recusada (DESVIOS, 22/10).
 *
 * Os pedidos nascem por INSERT direto, e não por `enviar()`: o envio está
 * mudando (termo NR-06 e motivo por item, fatia B). `termo_exigido = false`
 * é o pedido anterior à 0015, que a CHECK admite sem termo.
 */
import { describe, expect, it } from "vitest";
import { asc, eq, isNotNull, isNull } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import * as contagens from "../src/servicos/epi_contagens.js";
import { contar_abertas } from "../src/servicos/epi_comunicacao.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, usuarioAtual } from "./ajuda";

const { novoCliente } = await bancoLimpo();

interface Mundo {
  campus_a: number;
  campus_b: number;
}

let _n = 0;
async function _servidor(tx: Executor, unidade_id: number, nome: string) {
  const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [s] = await tx
    .insert(e.servidor)
    .values({ siape: `88${String(++_n).padStart(5, "0")}`, nome, cargo_id: cargo!.id, unidade_uorg_id: unidade_id })
    .returning();
  return s!;
}

async function _pedido(
  tx: Executor,
  o: { servidor_id: number; solicitado_por_id: number; campus_id: number | null; estado: string; numero: number },
) {
  const rascunho = o.estado === "RASCUNHO";
  await tx.insert(e.epi_requisicao).values({
    servidor_id: o.servidor_id,
    solicitado_por_id: o.solicitado_por_id,
    campus_id: o.campus_id,
    estado: o.estado,
    protocolo: rascunho ? null : `EPI-2026-${String(o.numero).padStart(4, "0")}`,
    numero: rascunho ? null : o.numero,
    ano: rascunho ? null : 2026,
    enviada_em: rascunho ? null : new Date(),
    termo_exigido: false,
  });
}

async function _comunicacao(
  tx: Executor,
  o: { servidor: typeof e.servidor.$inferSelect; item_id: number; por: number; retirada?: boolean },
) {
  const [registro] = await tx
    .insert(e.epi_ficha_registro)
    .values({
      servidor_id: o.servidor.id,
      epi_item_id: o.item_id,
      tipo: "ENTREGA",
      quantidade: 1,
      data_evento: "2026-10-01",
      nome_epi_snapshot: "Luva nitrílica",
      categoria_snapshot: "Proteção dos membros superiores",
      nome_servidor_snapshot: o.servidor.nome,
      siape_snapshot: o.servidor.siape,
      entregue_por: o.por,
    })
    .returning();
  await tx.insert(e.epi_comunicacao_titular).values({
    registro_id: registro!.id,
    servidor_id: o.servidor.id,
    tipo: "EXTRAVIADO",
    criado_por: o.por,
    retirada_em: o.retirada ? new Date() : null,
    retirada_por: o.retirada ? o.por : null,
  });
}

/**
 * Dois campi com uma unidade cada. No campus A: um pedido ENVIADA, um
 * EM_ANALISE, um ANALISADA (não conta) e um RASCUNHO (não conta); no B: um
 * ENVIADA. Comunicações: uma aberta em A, uma aberta em B e uma retirada em A.
 */
const mundo: Mundo = await naTransacao(async (tx) => {
  await contas(tx);
  const unidades = await tx
    .select({ id: e.unidade_uorg.id, campus_id: e.unidade_uorg.campus_id })
    .from(e.unidade_uorg)
    .where(isNotNull(e.unidade_uorg.campus_id))
    .orderBy(asc(e.unidade_uorg.id));
  const ua = unidades[0]!;
  const ub = unidades.find((u) => u.campus_id !== ua.campus_id)!;
  expect(ub, "o banco-modelo precisa de unidades em dois campi").toBeTruthy();
  const [coord] = await tx.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  await criarUsuario(tx, { login: "tecnico_campus_a", perfis: ["tecnico_seguranca"], campus_id: ua.campus_id });

  const sa = await _servidor(tx, ua.id, "Servidora do Campus A");
  const sb = await _servidor(tx, ub.id, "Servidor do Campus B");
  const por = coord!.id;
  await _pedido(tx, { servidor_id: sa.id, solicitado_por_id: por, campus_id: ua.campus_id, estado: "ENVIADA", numero: 9001 });
  await _pedido(tx, { servidor_id: sa.id, solicitado_por_id: por, campus_id: ua.campus_id, estado: "EM_ANALISE", numero: 9002 });
  await _pedido(tx, { servidor_id: sa.id, solicitado_por_id: por, campus_id: ua.campus_id, estado: "ANALISADA", numero: 9003 });
  await _pedido(tx, { servidor_id: sa.id, solicitado_por_id: por, campus_id: ua.campus_id, estado: "RASCUNHO", numero: 0 });
  await _pedido(tx, { servidor_id: sb.id, solicitado_por_id: por, campus_id: ub.campus_id, estado: "ENVIADA", numero: 9004 });

  const [categoria] = await tx.select().from(e.epi_categoria).limit(1);
  const [item] = await tx
    .insert(e.epi_item)
    .values({ nome: "Luva nitrílica", categoria_id: categoria!.id, exige_ca: false, quantidade_padrao: 1 })
    .returning();
  await _comunicacao(tx, { servidor: sa, item_id: item!.id, por });
  await _comunicacao(tx, { servidor: sb, item_id: item!.id, por });
  await _comunicacao(tx, { servidor: sa, item_id: item!.id, por, retirada: true });
  return { campus_a: ua.campus_id!, campus_b: ub.campus_id! };
});

async function _pagina(login: string, caminho: string): Promise<string> {
  const cliente = await entrar(novoCliente(), login);
  const r = await cliente.get(caminho, { seguir: false });
  expect(r.status, `${login} em ${caminho}`).toBe(200);
  return r.text;
}

/** O número de um `.cartao-resumo` pelo rótulo (o template põe o valor logo depois). */
function _valor(html: string, rotulo: string): number | null {
  const i = html.indexOf(rotulo);
  if (i < 0) return null;
  const m = /<span class="valor">\s*(\d+)\s*<\/span>/.exec(html.slice(i));
  return m ? Number(m[1]) : null;
}

/** O bloco de cartões da fatia G (o primeiro `.grade-resumo` da tela). */
function _cartoes(html: string): string {
  const i = html.indexOf('<div class="grade-resumo">');
  expect(i, "a grade de cartões").toBeGreaterThanOrEqual(0);
  // os cartões não têm `<div>` dentro: o primeiro `</div>` fecha a grade
  return html.slice(i, html.indexOf("</div>", i));
}

describe("serviço: epi_contagens", () => {
  it("conta ENVIADA + EM_ANALISE no escopo da fila; ANALISADA e RASCUNHO ficam de fora", async () => {
    await naTransacao(async (tx) => {
      const coord = await usuarioAtual(tx, "coordenador_csso");
      expect(await contagens.pedidos_a_analisar(tx, coord)).toEqual({ enviadas: 2, em_analise: 1, total: 3 });
    });
  });

  it("quem atende um campus não conta o pedido do outro", async () => {
    await naTransacao(async (tx) => {
      const tec = await usuarioAtual(tx, "tecnico_campus_a");
      expect(tec.alcance("epi.ver").campi).toEqual([mundo.campus_a]);
      expect(await contagens.pedidos_a_analisar(tx, tec)).toEqual({ enviadas: 1, em_analise: 1, total: 2 });
      const c = await contagens.contagens(tx, tec);
      expect(c.a_analisar?.total).toBe(2);
      // comunicação: a aberta do campus B e a retirada do A não contam
      expect(c.comunicacoes?.total).toBe(1);
    });
  });

  it("sem a permissão do ato, nem cartão nem consulta", async () => {
    await naTransacao(async (tx) => {
      const sec = await usuarioAtual(tx, "secretaria_csso");
      expect(await contagens.contagens(tx, sec)).toEqual({ a_analisar: null, comunicacoes: null });
      const eng = await usuarioAtual(tx, "engenheiro_seguranca");
      const c = await contagens.contagens(tx, eng);
      expect(c.a_analisar?.total).toBe(3);
      expect(c.comunicacoes).toBeNull();
    });
  });

  it("a versão do Início (uma ida ao banco) dá o mesmo que contagens e contar_abertas", async () => {
    await naTransacao(async (tx) => {
      for (const login of [
        "coordenador_csso",
        "tecnico_campus_a",
        "engenheiro_seguranca",
        "almoxarife_sesmt",
        "secretaria_csso",
        "servidor_consulta",
        "auditor_interno",
      ]) {
        const u = await usuarioAtual(tx, login);
        const [uma, duas] = await Promise.all([contagens.contagens_numa_ida(tx, u), contagens.contagens(tx, u)]);
        expect(uma, login).toEqual(duas);
        if (u.pode("epi.entregar")) expect(uma.comunicacoes?.total, login).toBe(await contar_abertas(tx, u));
      }
    });
  });

  it("o link leva à fila filtrada: os que nem começaram primeiro", () => {
    expect(contagens.link_da_fila({ enviadas: 2, em_analise: 1, total: 3 })).toBe("/epis/requisicoes?estado=ENVIADA");
    expect(contagens.link_da_fila({ enviadas: 0, em_analise: 1, total: 1 })).toBe("/epis/requisicoes?estado=EM_ANALISE");
  });
});

describe("painel /epis", () => {
  it("o analista com epi.entregar vê os dois cartões, com o número certo e o link", async () => {
    const html = await _pagina("coordenador_csso", "/epis");
    expect(_valor(html, "Pedidos a analisar")).toBe(3);
    expect(_valor(html, "Comunicações do titular a tratar")).toBe(2);
    expect(html).toContain('href="/epis/requisicoes?estado=ENVIADA"');
    expect(html).toContain('href="/epis/requisicoes?estado=EM_ANALISE"');
    expect(html).toContain('href="/epis/fichas"');
    // RN-19: só número — o nome do servidor do pedido não sai no cartão (a
    // lista "Entregas do mês" mais abaixo é outra regra, a de `epi.ficha`)
    expect(_cartoes(html)).not.toContain("Servidora do Campus A");
  });

  it("o técnico de um campus conta só o campus dele", async () => {
    const html = await _pagina("tecnico_campus_a", "/epis");
    expect(_valor(html, "Pedidos a analisar")).toBe(2);
    expect(_valor(html, "Comunicações do titular a tratar")).toBe(1);
  });

  it("sem epi.analisar não há cartão de pedidos; sem epi.entregar, não há o de comunicações", async () => {
    const sec = await _pagina("secretaria_csso", "/epis");
    expect(sec).not.toContain("Pedidos a analisar");
    expect(sec).not.toContain("Comunicações do titular a tratar");
    const eng = await _pagina("engenheiro_seguranca", "/epis");
    expect(_valor(eng, "Pedidos a analisar")).toBe(3);
    expect(eng).not.toContain("Comunicações do titular a tratar");
  });

  it("o almoxarife (epi.entregar sem epi.analisar) vê só as comunicações", async () => {
    const html = await _pagina("almoxarife_sesmt", "/epis");
    expect(html).not.toContain("Pedidos a analisar");
    expect(_valor(html, "Comunicações do titular a tratar")).toBe(2);
  });
});

describe("Início (/)", () => {
  it("o analista vê a contagem de pedidos e a de comunicações", async () => {
    const html = await _pagina("coordenador_csso", "/");
    expect(_valor(html, "EPI · pedidos a analisar")).toBe(3);
    expect(_valor(html, "EPI · comunicações do titular")).toBe(2);
    expect(html).toContain('href="/epis/requisicoes?estado=ENVIADA"');
    expect(_cartoes(html)).not.toContain("Servidora do Campus A");
  });

  it("o técnico de um campus vê o número do campus dele", async () => {
    const html = await _pagina("tecnico_campus_a", "/");
    expect(_valor(html, "EPI · pedidos a analisar")).toBe(2);
    expect(_valor(html, "EPI · comunicações do titular")).toBe(1);
  });

  it("quem não tem epi.analisar não vê a contagem", async () => {
    const html = await _pagina("secretaria_csso", "/");
    expect(html).not.toContain("EPI · pedidos a analisar");
    expect(html).not.toContain("EPI · comunicações do titular");
    const eng = await _pagina("engenheiro_seguranca", "/");
    expect(_valor(eng, "EPI · pedidos a analisar")).toBe(3);
    expect(eng).not.toContain("EPI · comunicações do titular");
  });

  it("com tudo resolvido, o Início não mostra cartão de EPI (zero não ocupa a tela)", async () => {
    // o auditor (S, sem epi.analisar) e o servidor (P) também não veem nada
    expect(await _pagina("auditor_interno", "/")).not.toContain("EPI · pedidos a analisar");
    expect(await _pagina("servidor_consulta", "/")).not.toContain("EPI · pedidos a analisar");
    await naTransacao(async (tx) => {
      await tx.update(e.epi_requisicao).set({ estado: "ANALISADA" }).where(eq(e.epi_requisicao.estado, "ENVIADA"));
      await tx.update(e.epi_requisicao).set({ estado: "ANALISADA" }).where(eq(e.epi_requisicao.estado, "EM_ANALISE"));
      const [coord] = await tx.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
      await tx
        .update(e.epi_comunicacao_titular)
        .set({ tratada_em: new Date(), tratada_por: coord!.id, tratamento: "Reposto" })
        .where(isNull(e.epi_comunicacao_titular.retirada_em));
    });
    const html = await _pagina("coordenador_csso", "/");
    expect(html).not.toContain("EPI · pedidos a analisar");
    expect(html).not.toContain("EPI · comunicações do titular");
    // no /epis o cartão continua, com zero e a frase (é a tela do módulo)
    const epis = await _pagina("coordenador_csso", "/epis");
    expect(_valor(epis, "Pedidos a analisar")).toBe(0);
    expect(epis).toContain("Nenhum pedido esperando decisão.");
  });
});
