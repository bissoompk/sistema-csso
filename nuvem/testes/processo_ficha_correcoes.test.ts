/**
 * O que o teste de Processos no navegador achou na ficha e no processo novo:
 * corrigir a identificação depois de criado, o NUP repetido que leva ao
 * processo que já o tem, o aviso de pendências da triagem que dizia "recusa a
 * saída" com saídas abertas, e a trilha que mostrava `None -> 'https://…'`.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { nup_dv } from "../src/servicos/nup.js";
import { ProcessoRecusado, corrigir_dados } from "../src/servicos/processo.js";
import { alteracao_na_tela } from "../src/servicos/trilha_tela.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { cenario } from "./ajuda_processos.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const coordenador = await usuarioAtual(db, "coordenador_csso");

const FORMULARIO = { accept: "text/html,application/xhtml+xml" };
let seq = 0;

function nup_novo(): string {
  const sequencial = String(630000 + ++seq).padStart(6, "0");
  return `23086.${sequencial}/2025-${nup_dv(`23086${sequencial}2025`)}`;
}

async function processo_em(estado: string, campos: Partial<typeof e.processo.$inferInsert> = {}) {
  const [tipo] = await db.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
  const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "EM_ANDAMENTO"));
  const [p] = await db
    .insert(e.processo)
    .values({ nup: nup_novo(), tipo_processo_id: tipo!.id, etapa_id: etapa!.id, estado_tecnico: estado, ...campos })
    .returning();
  return p!;
}

async function ler(id: number) {
  const [p] = await db.select().from(e.processo).where(eq(e.processo.id, id));
  return p!;
}

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
const [servidor] = await db.insert(e.servidor).values({ siape: "6300001", nome: "Servidora da Correção" }).returning();

describe("corrigir os dados do processo", () => {
  it("unidade, datas e observações mudam, e cada campo vai para a trilha", async () => {
    const p = await processo_em("LAUDO_EM_ELABORACAO");
    const n = await corrigir_dados(db, coordenador, p, {
      unidade_uorg_id: unidade!.id,
      data_autuacao: "2025-03-10",
      data_solicitacao_sest: null,
      observacoes: "  Pedido da chefia  ",
    });
    expect(n).toBe(3);
    const depois = await ler(p.id);
    expect(depois.unidade_uorg_id).toBe(unidade!.id);
    expect(depois.data_autuacao).toBe("2025-03-10");
    expect(depois.observacoes).toBe("Pedido da chefia");
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.processo_id, p.id), eq(e.historico_evento.tipo_evento, "CAMPO_ALTERADO")));
    expect(trilha.map((t) => t.campo).sort()).toEqual(["data_autuacao", "observacoes", "unidade_uorg_id"]);
    // o mesmo de novo: nada muda, nada vai para a trilha
    expect(
      await corrigir_dados(db, coordenador, depois, {
        unidade_uorg_id: unidade!.id,
        data_autuacao: "2025-03-10",
        data_solicitacao_sest: null,
        observacoes: "Pedido da chefia",
      }),
    ).toBe(0);
  });

  it("data futura é recusada e nada é gravado", async () => {
    const p = await processo_em("RECEBIDO");
    const erro = await corrigir_dados(db, coordenador, p, {
      unidade_uorg_id: null,
      data_autuacao: "2099-01-01",
      data_solicitacao_sest: null,
      observacoes: null,
    }).catch((x) => x);
    expect(erro).toBeInstanceOf(ProcessoRecusado);
    expect(erro.campo).toBe("data_autuacao");
    expect((await ler(p.id)).data_autuacao).toBeNull();
  });

  it("o servidor só muda enquanto não há parecer", async () => {
    const p = await processo_em("RECEBIDO");
    await corrigir_dados(db, coordenador, p, {
      servidor_id: servidor!.id,
      unidade_uorg_id: null,
      data_autuacao: null,
      data_solicitacao_sest: null,
      observacoes: null,
    });
    expect((await ler(p.id)).servidor_id).toBe(servidor!.id);

    const c = await cenario(db, { nup: "23086.730001/2024-11", siape: "3500001", laudo: "26255-000.801/2019", numero_portaria: "981" });
    const q = await processo_em("PARECER_EM_ELABORACAO");
    await db.update(e.parecer_tecnico).set({ processo_id: q.id }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const erro = await corrigir_dados(db, coordenador, q, {
      servidor_id: servidor!.id,
      unidade_uorg_id: null,
      data_autuacao: null,
      data_solicitacao_sest: null,
      observacoes: null,
    }).catch((x) => x);
    expect(erro).toBeInstanceOf(ProcessoRecusado);
    expect(erro.message).toContain("Anule o parecer");
    expect((await ler(q.id)).servidor_id).toBeNull();
  });

  it("pela ficha: a camada aparece, a recusa volta dentro dela, e o salvamento redireciona", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("RECEBIDO");
    const ficha = (await cliente.get(`/processos/${p.id}`, { cabecalhos: FORMULARIO })).text;
    expect(ficha).toContain(`action="/processos/${p.id}/dados"`);
    expect(ficha).toContain('name="servidor_id"');
    const recusa = await cliente.post(
      `/processos/${p.id}/dados`,
      { unidade_uorg_id: "", data_autuacao: "2099-01-01", data_solicitacao_sest: "", observacoes: "x" },
      { cabecalhos: FORMULARIO },
    );
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("ainda não chegou");
    expect(recusa.text).toContain('value="2099-01-01"');
    const ok = await cliente.post(
      `/processos/${p.id}/dados`,
      { unidade_uorg_id: String(unidade!.id), data_autuacao: "", data_solicitacao_sest: "", observacoes: "" },
      { seguir: false },
    );
    expect(ok.status).toBe(303);
    expect(decodeURIComponent(ok.location!)).toContain("Dados do processo corrigidos.");
    expect((await ler(p.id)).unidade_uorg_id).toBe(unidade!.id);
  });

  it("quem só lê processos não corrige", async () => {
    const cliente = await como("servidor_consulta");
    const p = await processo_em("RECEBIDO");
    const r = await cliente.post(`/processos/${p.id}/dados`, { unidade_uorg_id: String(unidade!.id) }, { seguir: false });
    expect(r.status).toBe(403);
    expect((await ler(p.id)).unidade_uorg_id).toBeNull();
  });
});

describe("processo novo com NUP repetido", () => {
  it("a recusa traz o link para o processo que já tem o NUP", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("RECEBIDO");
    const [tipo] = await db.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
    const r = await cliente.post("/processos/novo", { nup: p.nup, tipo_processo_id: String(tipo!.id) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("já existe processo com este NUP");
    expect(r.text).toContain(`href="/processos/${p.id}"`);
  });
});

describe("aviso de pendências da triagem", () => {
  it("no Recebido, diz quais saídas continuam abertas sem a portaria e o formulário", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("RECEBIDO");
    const ficha = (await cliente.get(`/processos/${p.id}`, { cabecalhos: FORMULARIO })).text;
    expect(ficha).toContain("anexe a portaria de localização");
    expect(ficha).toMatch(/Continuam abertos, sem elas:[^<]*Em triagem/);
  });
});

describe("trilha do processo na tela", () => {
  it("diz o campo pelo nome, sem o repr do Python", () => {
    const sei = { campo: "url_permanente", valor_anterior: null, valor_novo: "https://sei.x/1", descricao: "url_permanente: None -> 'https://sei.x/1'" };
    expect(alteracao_na_tela(sei)).toBe("Link do SEI: https://sei.x/1");
    expect(alteracao_na_tela({ campo: "laudo_id", valor_anterior: null, valor_novo: 3, descricao: "" })).toBe("Laudo técnico: preenchido");
    expect(alteracao_na_tela({ campo: "laudo_id", valor_anterior: 3, valor_novo: 4, descricao: "" })).toBe("Laudo técnico: alterado");
    expect(alteracao_na_tela({ campo: "texto_recomendacao", valor_anterior: "a", valor_novo: null, descricao: "" })).toBe("Recomendação: apagado");
    expect(alteracao_na_tela({ campo: "data_autuacao", valor_anterior: "2025-01-02", valor_novo: "2025-01-03", descricao: "" })).toBe(
      "Data de autuação: 02/01/2025 → 03/01/2025",
    );
  });

  it("a ficha mostra a frase nova", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("RECEBIDO");
    await cliente.post(`/processos/${p.id}/sei`, { url_permanente: "https://sei.ufvjm.edu.br/sei/x?id=1" }, { seguir: false });
    const ficha = (await cliente.get(`/processos/${p.id}?aba=historico`, { cabecalhos: FORMULARIO })).text;
    expect(ficha).toContain("Link do SEI: https://sei.ufvjm.edu.br/sei/x?id=1");
    expect(ficha).not.toContain("None -&gt;");
    expect(ficha).not.toContain("None ->");
  });
});

describe("editor do parecer depois da emissão", () => {
  it("o rascunho local só existe no parecer editável", async () => {
    const cliente = await como("coordenador_csso");
    const c = await cenario(db, { nup: "23086.730002/2024-11", siape: "3500002", laudo: "26255-000.802/2019", numero_portaria: "982" });
    await db.update(e.parecer_tecnico).set({ situacao: "RASCUNHO" }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    expect((await cliente.get(`/pareceres/${c.parecer_id}`, { cabecalhos: FORMULARIO })).text).toContain("data-rascunho-local=");
    // emitido: a camada «Emitir» guardava o rascunho, e ele reaparecia ("Repus…") no imutável
    await db.update(e.parecer_tecnico).set({ situacao: "EMITIDO", numero: 981 }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    expect((await cliente.get(`/pareceres/${c.parecer_id}`, { cabecalhos: FORMULARIO })).text).not.toContain("data-rascunho-local=");
  });
});
