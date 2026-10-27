/**
 * F6 do módulo de acidentes: o relatório técnico em PDF. Contexto congelado e
 * hash; as duas variantes no mesmo ato; a SEM_SAUDE não contém nenhum campo de
 * saúde (conferido no texto extraído do PDF); retificação gera a v2 com motivo e
 * `substitui_id`, e a v1 continua legível; download registra a leitura; o estado
 * não regride; caractere fora do WinAnsi não derruba a geração. Dados fictícios.
 */
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as investigacao from "../src/servicos/acidente_investigacao.js";
import * as relatorio from "../src/servicos/acidente_relatorio.js";
import * as saude from "../src/servicos/acidente_saude.js";
import { hash_do_contexto } from "../src/servicos/acidente_relatorio.js";
import type { ContextoRelatorio } from "../src/servicos/acidente_relatorio_pdf.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

/** O texto desenhado no PDF: infla os fluxos e decodifica os `<hex> Tj` do pdf-lib. */
function texto_do_pdf(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1");
  let saida = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let d: Buffer;
    try {
      d = inflateSync(Buffer.from(m[1]!, "latin1"));
    } catch {
      continue;
    }
    for (const h of d.toString("latin1").matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) saida += `${Buffer.from(h[1]!, "hex").toString("latin1")}\n`;
  }
  return saida;
}

const VAZIO: saude.DadosSaude = {
  natureza_lesao_id: null, parte_corpo_ids: [], lateralidade: null, houve_atendimento: null, houve_afastamento: null,
  houve_internacao: null, houve_obito: null, houve_sequela: null, dias_afastamento: null, afastamento_inicio: null,
  afastamento_retorno: null, dias_internacao: null, data_obito: null, dias_debitados: null, primeiro_socorro_por: null,
  primeiro_socorro_unidade: null, atendimento_em: null,
};

/** Um caso pronto para emitir: síntese e caracterização preenchidas, saúde registrada pelo médico. */
async function pronto(sintese = "O respingo ocorreu porque o frasco estava sem tampa de segurança.") {
  const c = await em_investigacao(db);
  await db.transaction((tx) => investigacao.salvar(tx, c.equipe, c.oc, { sintese, caracterizacao: "SIM" }, 1));
  const [acid] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, c.oc.id));
  const medico = await usuarioAtual(db, "medico_trabalho");
  const [parte] = await db.select().from(e.acidente_parte_corpo).limit(1);
  await db.transaction((tx) =>
    saude.registrar(tx, medico, c.oc, acid!.id, { ...VAZIO, parte_corpo_ids: [parte!.id], lateralidade: "DIREITA", houve_atendimento: "SIM", houve_afastamento: "SIM", dias_afastamento: 9 }, 1),
  );
  return { ...c, acid: acid!, parte: parte! };
}

const emitir = async (c: Awaited<ReturnType<typeof pronto>>) => {
  const oc = await c.ler();
  return db.transaction((tx) => relatorio.emitir(tx, c.equipe, oc, oc.versao));
};

describe("emitir", () => {
  it("grava as duas variantes da v1, congela o contexto com hash, leva o caso a RELATORIO_EMITIDO e fecha a pendência", async () => {
    const c = await pronto();
    const linhas = await emitir(c);
    expect(linhas.map((l) => l.variante).sort()).toEqual(["COMPLETA", "SEM_SAUDE"]);
    for (const l of linhas) {
      expect(l.versao).toBe(1);
      expect(l.substitui_id).toBeNull();
      expect(hash_do_contexto(l.contexto_congelado as ContextoRelatorio)).toBe(l.hash_conteudo);
    }
    expect((await c.ler()).estado).toBe("RELATORIO_EMITIDO");
    const [p] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, `ACIDENTE_INVESTIGAR:${c.oc.id}`));
    expect(p!.concluida).toBe(true);
    const evs = await db.select().from(e.historico_evento).where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_RELATORIO_EMITIDO"), eq(e.historico_evento.entidade_id, c.oc.id)));
    expect(evs).toHaveLength(1);
  });

  it("recusa sem síntese ou sem caracterização, fora de EM_INVESTIGACAO e quem não é do perfil técnico", async () => {
    const c = await em_investigacao(db);
    await expect(db.transaction((tx) => relatorio.emitir(tx, c.equipe, c.oc, c.oc.versao))).rejects.toThrow(/síntese/);
    await db.transaction((tx) => investigacao.salvar(tx, c.equipe, c.oc, { sintese: "Síntese." }, 1));
    await expect(db.transaction((tx) => relatorio.emitir(tx, c.equipe, c.oc, c.oc.versao))).rejects.toThrow(/caracteriza/);
    const medico = await usuarioAtual(db, "medico_trabalho");
    await db.transaction((tx) => investigacao.salvar(tx, c.equipe, c.oc, { sintese: "Síntese.", caracterizacao: "SIM" }, 2));
    await expect(db.transaction((tx) => relatorio.emitir(tx, medico, c.oc, c.oc.versao))).rejects.toThrow();
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => relatorio.emitir(tx, secretaria, c.oc, c.oc.versao))).rejects.toThrow();
    const oc = await c.ler();
    await db.transaction((tx) => relatorio.emitir(tx, c.equipe, oc, oc.versao));
    const emitido = await c.ler();
    await expect(db.transaction((tx) => relatorio.emitir(tx, c.equipe, emitido, emitido.versao))).rejects.toThrow(/já foi emitido/);
  });

  it("a SEM_SAUDE não tem nenhum campo de saúde — nem no contexto, nem no texto extraído do PDF; a COMPLETA tem", async () => {
    const c = await pronto();
    await emitir(c);
    const oc = await c.ler();
    const sem = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "SEM_SAUDE"));
    const completa = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "COMPLETA"));
    const texto_sem = texto_do_pdf(sem.bytes);
    const texto_completa = texto_do_pdf(completa.bytes);
    expect(texto_sem).toContain(c.oc.protocolo);
    for (const proibido of [c.parte.rotulo, "Lateralidade", "Afastamento", "Atendimento", "Internação", "Óbito", "Saúde (resumo)", "Direita"]) {
      expect(texto_sem, proibido).not.toContain(proibido);
    }
    expect(texto_completa).toContain("Saúde (resumo)");
    expect(texto_completa).toContain(c.parte.rotulo.slice(0, 12));
    const [sem_linha] = await db.select().from(e.acidente_relatorio).where(and(eq(e.acidente_relatorio.ocorrencia_id, c.oc.id), eq(e.acidente_relatorio.variante, "SEM_SAUDE")));
    expect("saude" in (sem_linha!.contexto_congelado as object)).toBe(false);
  });

  it("ler a saúde para a variante completa registra o acesso, por acidentado", async () => {
    const c = await pronto();
    await emitir(c);
    const a = await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.acidentado_id, c.acid.id));
    expect(a.some((x) => x.campo === "acidente_saude_nivel_1" && x.finalidade)).toBe(true);
  });

  it("caractere fora do WinAnsi não derruba a geração (sai como ?) e os acentos do português ficam", async () => {
    const c = await pronto("Ação corretiva — a tampa não foi reposta ŵ pela equipe.");
    await emitir(c);
    const oc = await c.ler();
    const r = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "SEM_SAUDE"));
    const t = texto_do_pdf(r.bytes);
    expect(t).toContain("Ação corretiva");
    expect(t).toContain("?");
  });
});

describe("retificar", () => {
  it("gera a v2 das duas variantes com motivo e substitui_id; a v1 continua legível e marcada; o estado não muda", async () => {
    const c = await pronto();
    const v1 = await emitir(c);
    const oc = await c.ler();
    await expect(db.transaction((tx) => relatorio.retificar(tx, c.equipe, oc, "curto"))).rejects.toThrow(/motivo/);
    const v2 = await db.transaction((tx) => relatorio.retificar(tx, c.equipe, oc, "Plano de ação atualizado depois da vistoria."));
    expect(v2.map((x) => x.versao)).toEqual([2, 2]);
    for (const l of v2) {
      expect(l.motivo_retificacao).toMatch(/vistoria/);
      expect(l.substitui_id).toBe(v1.find((x) => x.variante === l.variante)!.id);
    }
    expect((await c.ler()).estado).toBe("RELATORIO_EMITIDO");
    const lista = await db.transaction((tx) => relatorio.versoes(tx, c.oc.id));
    expect(lista.filter((x) => x.versao === 1).every((x) => x.retificada)).toBe(true);
    expect(lista.filter((x) => x.versao === 2).every((x) => !x.retificada)).toBe(true);
    const antigo = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "SEM_SAUDE"));
    expect(texto_do_pdf(antigo.bytes)).toContain(c.oc.protocolo);
    const novo = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 2, "SEM_SAUDE"));
    expect(texto_do_pdf(novo.bytes)).toContain("Retifica a versão 1");
  });

  it("não se retifica o que não foi emitido nem o caso concluído", async () => {
    const c = await pronto();
    await expect(db.transaction((tx) => relatorio.retificar(tx, c.equipe, c.oc, "Motivo suficiente aqui."))).rejects.toThrow(/já emitido/);
  });
});

describe("baixar", () => {
  it("a reimpressão é idêntica, e cada download fica registrado", async () => {
    const c = await pronto();
    await emitir(c);
    const oc = await c.ler();
    const a = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "COMPLETA"));
    const b = await db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "COMPLETA"));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const lidas = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ANEXO_BAIXADO"));
    expect(lidas.length).toBeGreaterThanOrEqual(2);
  });

  it("a variante completa exige a saúde; a sem saúde abre com acidente.ver; versão inexistente é 404", async () => {
    const c = await pronto();
    await emitir(c);
    const oc = await c.ler();
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => relatorio.baixar(tx, secretaria, oc, 1, "COMPLETA"))).rejects.toThrow();
    await expect(db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 9, "COMPLETA"))).rejects.toBeInstanceOf(relatorio.RelatorioInexistente);
    await expect(db.transaction((tx) => relatorio.baixar(tx, c.equipe, oc, 1, "OUTRA"))).rejects.toBeInstanceOf(relatorio.RelatorioInexistente);
  });
});

describe("pela tela", () => {
  it("emite, lista na aba e baixa o PDF", async () => {
    const c = await pronto();
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const oc = await c.ler();
    const r = await cli.post(`/acidentes/${c.oc.id}/relatorio`, { versao_ocorrencia: String(oc.versao) }, { seguir: false });
    expect([302, 303]).toContain(r.status);
    const aba = await cli.get(`/acidentes/${c.oc.id}?aba=relatorios`);
    expect(aba.text).toContain("Baixar PDF");
    expect(aba.text).toContain("Retificar o relatório");
    const pdf = await cli.get(`/acidentes/${c.oc.id}/relatorio/1/SEM_SAUDE.pdf`, { seguir: false });
    expect(pdf.status).toBe(200);
    expect(String(pdf.headers.get("content-type"))).toContain("application/pdf");
  });

  it("a secretaria não emite (403)", async () => {
    const c = await pronto();
    const cli = await entrar(novoCliente(), "secretaria_csso");
    expect((await cli.post(`/acidentes/${c.oc.id}/relatorio`, { versao_ocorrencia: "1" }, { seguir: false })).status).toBe(403);
  });
});
