/**
 * Fases 2 e 3 da migração: planilha de pareceres e quadro do Trello.
 * Porte de `integracao/test_importacao_trello.py`, da parte dos anexos de
 * `integracao/test_reconciliacao.py`, da parte com banco de
 * `unitarios/test_separacao_backlog.py`, de `test_pendencias_e_sla.py`
 * (conflito de numeração) e dos testes puros de
 * `integracao/test_importacao_planilha.py`.
 *
 * A planilha real (`entrada/CSSO_Planilha_Pareceres_2026.xlsx`) não existe
 * aqui — no Python aqueles testes também eram pulados sem ela. No lugar dela
 * vai uma planilha SINTÉTICA, montada com o exceljs, que exercita as mesmas
 * regras: classificação, ano inferido, rejeição, reimportação, simulação,
 * conflito de numeração, pendência herdada e de-para de posto.
 */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as imp from "../src/servicos/importacao_trello.js";
import * as planilha from "../src/servicos/importacao_planilha.js";
import * as repo from "../src/repositorios/processos.js";
import { recontar_sequencia } from "../src/servicos/numeracao.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar } from "./ajuda";
import { desfeita } from "./ajuda_processos";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const QUADRO = JSON.parse(readFileSync(new URL("./fixtures/trello_quadro.json", import.meta.url), "utf8"));
const quadro = () => structuredClone(QUADRO);

let _n = 0;
async function operador(tx: Executor, permissoes = ["catalogo.gerenciar"]): Promise<UsuarioAtual> {
  const u = await criarUsuario(tx, { login: `migrador${++_n}`, nome: "Migrador" });
  return new UsuarioAtual({ id: u.id, login: u.login, nome: "Migrador", permissoes, perfis: ["coordenador_csso"] });
}

/** Falha na hora, sem sair da máquina (o `sem_rede` do Python). */
const sem_rede: imp.BuscarAnexo = async (url) => {
  const erro = new Error(`a suíte não vai à rede: ${url}`);
  erro.name = "ConnectionError";
  throw erro;
};

const ARQUIVOS_FALSOS: Record<string, Uint8Array> = {
  "https://exemplo/a.pdf": new TextEncoder().encode("%PDF-1.4 parecer assinado do Genilton"),
  "https://exemplo/b.pdf": new TextEncoder().encode("%PDF-1.4 laudo do Marcilio"),
};
const buscar_falso: imp.BuscarAnexo = async (url) => {
  if (!(url in ARQUIVOS_FALSOS)) {
    const erro = new Error(`URL expirada: ${url}`);
    erro.name = "FileNotFoundError";
    throw erro;
  }
  return ARQUIVOS_FALSOS[url]!;
};

async function processoPorNup(tx: Executor, nup: string) {
  return tx.query.processo.findFirst({ where: eq(e.processo.nup, nup), with: { tipo_processo: true } });
}

// =====================================================================
// Trello
// =====================================================================
describe("importação do Trello", () => {
  const comImportado = <T>(f: (tx: Executor, r: imp.RelatorioTrello, op: UsuarioAtual) => Promise<T>) =>
    desfeita(db, async (tx) => {
      const op = await operador(tx);
      const r = await imp.importar(tx, quadro(), op, true, sem_rede);
      return f(tx, r, op);
    });

  it("staging guarda cartões e ações", () =>
    comImportado(async (tx) => {
      expect((await tx.select().from(e.stg_trello_cartao)).length).toBe(11);
      expect((await tx.select().from(e.stg_trello_acao)).length).toBe(3);
    }));

  it("lista não mapeada vira rejeitada", () =>
    comImportado(async (tx, r) => {
      expect(r.listas_desconhecidas.has("Lista que ninguém mapeou")).toBe(true);
      const [rej] = await tx.select().from(e.migracao_rejeitada).where(eq(e.migracao_rejeitada.ref, "c010"));
      expect(rej!.motivo).toContain("não mapeada");
      expect(await processoPorNup(tx, "23086.009245/2026-42")).toBeUndefined();
    }));

  it("cartão não processo", () =>
    comImportado(async (tx) => {
      const refs = (
        await tx.select().from(e.migracao_rejeitada).where(eq(e.migracao_rejeitada.motivo, imp.MOTIVO_NAO_PROCESSO))
      ).map((r) => r.ref);
      for (const ref of ["c007", "c008", "c009"]) expect(refs).toContain(ref);
    }));

  it("mapa de listas para estado", () =>
    comImportado(async (tx) => {
      const p = (await processoPorNup(tx, "23086.003498/2015-50"))!;
      expect(p.estado_tecnico).toBe("EM_TRIAGEM");
      expect(p.origem_migracao).toBe("TRELLO");
      expect(p.origem_ref).toBe("c001");
      expect(p.pronto_para_emissao).toBe(true);
    }));

  it("lista de concluídos traz o exercício", () =>
    comImportado(async (tx) => {
      const p = (await processoPorNup(tx, "23086.021284/2024-56"))!;
      expect(p.ano_referencia).toBe(2025);
      expect(p.situacao).toBe("CONCLUIDO");
    }));

  it("repositórios são marcados", () =>
    comImportado(async (tx) => {
      expect((await processoPorNup(tx, "23086.005413/2026-21"))!.origem_repositorio).toBe(true);
      const apos = (await processoPorNup(tx, "23086.001198/2008-15"))!;
      expect(apos.tipo_processo.codigo).toBe("APOSENTADORIA_ESPECIAL");
      expect(apos.situacao).toBe("CONCLUIDO");
    }));

  it("cartão fechado vira arquivado", () =>
    comImportado(async (tx) => {
      expect((await processoPorNup(tx, "23086.008530/2026-46"))!.estado_tecnico).toBe("ARQUIVADO");
    }));

  it("checklists importados", () =>
    comImportado(async (tx) => {
      const p = (await processoPorNup(tx, "23086.003498/2015-50"))!;
      const cls = await tx.query.checklist.findMany({ where: eq(e.checklist.processo_id, p.id), with: { itens: true } });
      expect(cls.length).toBe(1);
      expect(cls[0]!.nome).toBe("Instrução");
      expect(cls[0]!.itens.length).toBe(2);
      expect(cls[0]!.itens.filter((i) => i.concluido).length).toBe(1);
    }));

  it("ações preservam a data original", () =>
    comImportado(async (tx) => {
      const eventos = await tx.select().from(e.historico_evento).where(eq(e.historico_evento.origem, "MIGRACAO_TRELLO"));
      expect(eventos.length).toBe(3);
      const criacao = eventos.find((x) => x.origem_ref === "a001")!;
      expect(criacao.ocorrido_em.toISOString()).toBe("2021-02-03T13:05:00.000Z");
      expect(criacao.registrado_em.getTime()).toBeGreaterThan(criacao.ocorrido_em.getTime());
      expect(criacao.usuario_nome).toBe("Fátima da Silva");
    }));

  it("candidatos extraídos não são vinculados", () =>
    comImportado(async (tx, r) => {
      const [c] = await tx.select().from(e.stg_trello_cartao).where(eq(e.stg_trello_cartao.card_id, "c002"));
      expect(c!.parecer_candidato).toBe("1/2025");
      expect(c!.laudo_candidato).toBe("26255-000.110/2022");
      expect(r.conflitos_numeracao.some((x) => x.parecer_candidato === "1/2025")).toBe(true);
    }));

  it("órfãos de processo", () => comImportado(async (_tx, r) => expect(r.orfaos_processo).toContain("Sebastião Aparecido")));

  it("o fixture não vai à rede e mantém o ramo de anexo perdido", () =>
    comImportado(async (tx, r) => {
      expect(r.anexos).toBe(0);
      expect(r.anexos_perdidos.length).toBe(2);
      expect(r.anexos_perdidos.every(([, motivo]) => motivo.startsWith("ConnectionError"))).toBe(true);
      const rej = await tx.select().from(e.migracao_rejeitada).where(like(e.migracao_rejeitada.motivo, "falha ao baixar%"));
      expect(rej.length).toBe(2);
      expect(rej.every((x) => (x.payload as Record<string, unknown>).url)).toBe(true);
    }));

  it("reimportar é idempotente", () =>
    comImportado(async (tx, _r, op) => {
      const antes = (await tx.select().from(e.processo)).length;
      const eventos = (await tx.select().from(e.historico_evento)).length;
      await imp.importar(tx, quadro(), op, true, sem_rede);
      expect((await tx.select().from(e.processo)).length).toBe(antes);
      expect((await tx.select().from(e.historico_evento)).length).toBe(eventos);
    }));

  it("simulação calcula sem gravar", () =>
    desfeita(db, async (tx) => {
      const op = await operador(tx);
      const antes = (await tx.select().from(e.historico_evento)).length;
      const r = await imp.importar(tx, quadro(), op, false, sem_rede);
      expect(r.processos).toBeGreaterThan(0);
      expect(r.eventos).toBeGreaterThan(0);
      expect(r.conflitos_numeracao.length).toBeGreaterThan(0);
      expect((await tx.select().from(e.processo)).length).toBe(0);
      expect((await tx.select().from(e.historico_evento)).length).toBe(antes);
    }));

  it("simulação e carga contam o mesmo", async () => {
    const ensaio = await desfeita(db, async (tx) => imp.importar(tx, quadro(), await operador(tx), false, sem_rede));
    const real = await desfeita(db, async (tx) => imp.importar(tx, quadro(), await operador(tx), true, sem_rede));
    expect(ensaio.processos).toBe(real.processos);
    expect(ensaio.backlog_historico).toBe(real.backlog_historico);
    expect(ensaio.backlog_pendente).toBe(real.backlog_pendente);
  });

  it("extratores de identificador", () => {
    expect(imp.parecer_candidato("Flávio Rodrigues de Matos - 06-2025")).toBe("6/2025");
    expect(imp.parecer_candidato("Relatório de Anatomia Humana")).toBeNull();
    expect(imp.laudo_candidato("Laudo 26255-000.1102022")).toBe("26255-000.110/2022");
  });

  it.each([
    ["Parecer_Tecnico_05-2026 (1234567).pdf", "1234567"],
    ["SEI_1486577_Oficio_24.pdf", "1486577"],
    ["SEI 1911207 Documento Check List.pdf", "1911207"],
    ["LTCAT.pdf", null],
    ["SEI_12345_curto.pdf", null],
  ])("número do documento SEI no nome: %s", (nome, esperado) => expect(imp.documento_sei_de_anexo(nome)).toBe(esperado));
});

describe("anexos do Trello", () => {
  const anexosDe = (tx: Executor) => tx.select().from(e.anexo);

  it("são baixados e guardados", () =>
    desfeita(db, async (tx) => {
      const r = await imp.importar(tx, quadro(), await operador(tx, ["catalogo.gerenciar", "anexo.enviar"]), true, buscar_falso);
      expect(r.anexos).toBe(2);
      expect(r.anexos_perdidos).toEqual([]);
      const guardados = await anexosDe(tx);
      expect(guardados.length).toBe(2);
      expect(guardados.map((a) => a.nome_original)).toContain("Parecer_Tecnico_05-2026 (1234567).pdf");
      expect(guardados.every((a) => a.sha256.length === 64)).toBe(true);
      expect(guardados.every((a) => a.origem_migracao === "TRELLO")).toBe(true);
    }));

  it("número SEI e categoria saem do nome", () =>
    desfeita(db, async (tx) => {
      await imp.importar(tx, quadro(), await operador(tx), true, buscar_falso);
      const [parecer] = await tx.select().from(e.anexo).where(like(e.anexo.nome_original, "Parecer%"));
      expect(parecer!.numero_documento_sei).toBe("1234567");
      expect(parecer!.categoria).toBe("PARECER_ASSINADO");
      const [laudo] = await tx.select().from(e.anexo).where(like(e.anexo.nome_original, "Laudo%"));
      expect(laudo!.categoria).toBe("LAUDO");
      expect(imp.categoria_do_anexo("Portaria FAMED.pdf")).toBe("PORTARIA");
      expect(imp.categoria_do_anexo("qualquer coisa.txt")).toBe("OUTRO");
    }));

  it("sem rede o anexo vira pendência com a URL", () =>
    desfeita(db, async (tx) => {
      const r = await imp.importar(tx, quadro(), await operador(tx), true, null);
      expect(r.anexos).toBe(0);
      expect(r.anexos_perdidos.length).toBe(2);
      expect(r.anexos_perdidos.some(([, m]) => m.includes("https://exemplo/"))).toBe(true);
      const rej = await tx.select().from(e.migracao_rejeitada).where(like(e.migracao_rejeitada.motivo, "anexo%"));
      expect(rej.length).toBe(2);
      expect(rej.every((x) => (x.payload as Record<string, unknown>).url)).toBe(true);
    }));

  it("URL expirada não derruba a carga", () =>
    desfeita(db, async (tx) => {
      const sempre_falha: imp.BuscarAnexo = async () => {
        const erro = new Error("a URL expirou");
        erro.name = "TimeoutError";
        throw erro;
      };
      const r = await imp.importar(tx, quadro(), await operador(tx), true, sempre_falha);
      expect(r.processos).toBeGreaterThan(0);
      expect(r.anexos_perdidos.length).toBe(2);
      expect(r.anexos_perdidos.some(([, m]) => m.includes("TimeoutError"))).toBe(true);
    }));

  it("anexo duplicado não entra duas vezes", () =>
    desfeita(db, async (tx) => {
      const op = await operador(tx);
      await imp.importar(tx, quadro(), op, true, buscar_falso);
      const r = await imp.importar(tx, quadro(), op, true, buscar_falso);
      expect(r.anexos).toBe(0);
      expect(r.anexos_duplicados).toBe(2);
      expect((await anexosDe(tx)).length).toBe(2);
    }));

  it("laudo candidato entra no relatório", () =>
    desfeita(db, async (tx) => {
      const r = await imp.importar(tx, quadro(), await operador(tx), true, buscar_falso);
      expect(r.laudos_candidatos.some((c) => c.laudo_candidato === "26255-000.110/2022")).toBe(true);
    }));
});

describe("separação do backlog no importador", () => {
  const ANTIGO = "2021-05-20T10:00:00.000Z";
  // "recente" relativo a hoje: a classificação usa o dia corrente
  const RECENTE = new Date(Date.now() - 10 * 86_400_000).toISOString();

  it("o pendente sobe para a fila; o histórico fica no repositório", () =>
    desfeita(db, async (tx) => {
      const q = {
        id: "q1",
        name: "SEI",
        lists: [{ id: "l6", name: "Adicional Ocupacional" }],
        cards: [
          { id: "hist1", name: "MARIA DA SILVA PARADA", desc: "SEI 23086.003498/2015-50", idList: "l6", dateLastActivity: ANTIGO },
          { id: "pend1", name: "JOAO SOUZA ATIVO", desc: "SEI 23086.002365/2016-47", idList: "l6", dateLastActivity: RECENTE },
        ],
        actions: [],
      };
      const r = await imp.importar(tx, q, await operador(tx, ["catalogo.gerenciar", "anexo.enviar"]), true, null);
      expect(r.backlog_historico).toBe(1);
      expect(r.backlog_pendente).toBe(1);
      expect(r.motivos_pendente[0]!.cartao).toBe("JOAO SOUZA ATIVO");
      const hist = (await processoPorNup(tx, "23086.003498/2015-50"))!;
      const pend = (await processoPorNup(tx, "23086.002365/2016-47"))!;
      expect(hist.origem_repositorio).toBe(true);
      expect(hist.estado_tecnico).toBe("RECEBIDO");
      expect(pend.origem_repositorio).toBe(false);
      expect(pend.estado_tecnico).toBe("EM_TRIAGEM");
    }));

  it("indicadores ignoram o repositório", () =>
    desfeita(db, async (tx) => {
      const u = await criarUsuario(tx, { login: `ind${++_n}` });
      const atual = new UsuarioAtual({ id: u.id, login: u.login, nome: "Indicador", permissoes: ["processo.ver"], perfis: ["coordenador_csso"] });
      const [tipo] = await tx.select().from(e.tipo_processo).limit(1);
      const [etapa] = await tx.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
      await tx.insert(e.processo).values([
        { nup: "23086.000608/2026-84", tipo_processo_id: tipo!.id, etapa_id: etapa!.id, estado_tecnico: "EM_TRIAGEM", origem_repositorio: false },
        { nup: "23086.000540/2026-33", tipo_processo_id: tipo!.id, etapa_id: etapa!.id, estado_tecnico: "RECEBIDO", origem_repositorio: true },
      ]);
      const kpis = await repo.indicadores(tx, atual);
      expect(kpis.total).toBe(1);
      expect(kpis.a_fazer).toBe(1);
    }));
});

// =====================================================================
// Planilha
// =====================================================================
describe("planilha — regras puras", () => {
  it("analisa a portaria nas seis variantes", () => {
    const exemplos: [string, string, string, string][] = [
      ["PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024", "FAMED", "35", "2024-09-17"],
      ["PORTARIA FCA Nº 001, DE 05 DE MARÇO DE 2024", "FCA", "1", "2024-03-05"],
      ["PORTARIA/IECT Nº 001/IECT, DE 16 DE JANEIRO DE 2026", "IECT", "1", "2026-01-16"],
      ["PORTARIA/FCBS Nº 07, DE 09 DE FEVEREIRO DE 2026", "FCBS", "7", "2026-02-09"],
      ["PORTARIA/FAMMUC Nº 01/2026, DE 07 DE JANEIRO DE 2026", "FAMMUC", "1", "2026-01-07"],
      ["Portaria/ICA Nº 79, de 12 de novembro de 2024", "ICA", "79", "2024-11-12"],
    ];
    for (const [texto, emissor, numero, quando] of exemplos) {
      const a = planilha.analisar_portaria(texto);
      expect(a, texto).not.toBeNull();
      expect(a!.emissor).toBe(emissor);
      expect(a!.numero).toBe(numero);
      expect(a!.data).toBe(quando);
      expect(a!.texto).toBe(texto);
    }
  });

  it("extrai o marco das três formas", () => {
    const casos: [string, string, string][] = [
      ["... a partir da data da Portaria de Localização: 17 de setembro de 2024", "PORTARIA_LOCALIZACAO", "2024-09-17"],
      ["... a partir da portaria de localização 12 de novembro de 2024", "PORTARIA_LOCALIZACAO", "2024-11-12"],
      ["... a partir da data da solicitação 01/05/2026", "SOLICITACAO_SEST", "2026-05-01"],
    ];
    for (const [texto, codigo, quando] of casos) {
      const m = planilha.extrair_marco(texto);
      expect(m).not.toBeNull();
      expect(m!.codigo).toBe(codigo);
      expect(m!.data).toBe(quando);
    }
  });
});

const RECOMENDACAO =
  "Reconhecer o direito ao adicional de insalubridade caracterizado pela exposição ao Agente " +
  "Biológico, a partir da data da Portaria de Localização: 09 de fevereiro de 2026";

type Linha = Partial<Record<(typeof planilha.COLUNAS)[number], unknown>>;

/** A planilha sintética: as colunas A..Y na ordem de `COLUNAS`. */
async function montarPlanilha(linhas: (Linha | null)[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Pareceres");
  ws.addRow(planilha.COLUNAS.map((c) => c));
  for (const linha of linhas) {
    ws.addRow(linha === null ? [] : planilha.COLUNAS.map((c) => (linha[c] ?? null) as ExcelJS.CellValue));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const COMPLETA: Linha = {
  col_b_numero_parecer: 1,
  col_c_nome_servidor: "Ana Teste da Silva",
  col_d_ano: 2026,
  col_e_data: new Date(Date.UTC(2026, 1, 11)),
  col_f_laudo_de: "concessão",
  col_g_unidade: "Faculdade de Medicina de Diamantina",
  col_h_posto_trabalho: "Laboratório Escola de análises Clínicas (LEAC)",
  col_i_uorg: "250 - FACULDADE DE MEDICINA DE DIAMANTINA",
  col_j_tipo_laudo: "Insalubridade",
  col_k_numero_processo: "23086.000608/2026-84",
  col_l_matricula: "1234567",
  col_m_cargo: "TECNICO DE LABORATORIO AREA",
  col_n_funcao: "Técnica",
  col_o_laudo_siape: "26255-000.125/2019",
  col_p_agente_nocivo: "Contato permanente com material infecto-contagiante",
  col_q_tipo_risco: "Biológico",
  col_r_percentual: "Médio (10%)",
  col_s_portaria: "PORTARIA/FAMED Nº 035, DE 09 DE FEVEREIRO DE 2026",
  col_t_fundamentacao: "NR-15, Anexo 14",
  col_v_recomendacao: RECOMENDACAO,
  col_x_pro_reitor: "MARINA FERREIRA DA COSTA",
};

const LINHAS: (Linha | null)[] = [
  COMPLETA, // linha 2 — COMPLETA, emitido
  { col_b_numero_parecer: 2, col_d_ano: 2026 }, // linha 3 — RESERVA
  { col_b_numero_parecer: 3 }, // linha 4 — RESERVA com ano herdado
  {
    // linha 5 — PARCIAL: sem percentual, agente sinônimo químico, posto com grafia errada
    ...COMPLETA,
    col_b_numero_parecer: 4,
    col_c_nome_servidor: "Claudia Teste",
    col_l_matricula: "7654321",
    col_k_numero_processo: "23086.000540/2026-33",
    col_h_posto_trabalho: "Central de Esterelização de Materiais (CME)",
    col_p_agente_nocivo: "Manuseio de substâncias químicas",
    col_r_percentual: null,
  },
  null, // linha 6 — vazia, pulada
  { col_c_nome_servidor: "Sem número" }, // linha 7 — rejeitada
  { ...COMPLETA, col_b_numero_parecer: 5, col_k_numero_processo: null, col_l_matricula: "1111111" }, // linha 8 — sem NUP
];

describe("planilha — carga sintética", () => {
  const ARQUIVO = "planilha-sintetica.xlsx";

  const carregar = async (tx: Executor, aplicar = true, linhas = LINHAS) =>
    planilha.importar(tx, { nome: ARQUIVO, conteudo: await montarPlanilha(linhas) }, await operador(tx), aplicar);
  const parecer = (tx: Executor, numero: number, ano = 2026) =>
    tx.query.parecer_tecnico.findFirst({
      where: and(eq(e.parecer_tecnico.numero, numero), eq(e.parecer_tecnico.ano, ano)),
      with: { tipo_marco: true, exposicoes: { with: { agente_nocivo: true } }, postos: { with: { posto: true } } },
    });
  const linha = (r: planilha.RelatorioImportacao, n: number) => r.linhas.find((l) => l.linha === n)!;

  it("staging guarda as 25 colunas", () =>
    desfeita(db, async (tx) => {
      await carregar(tx);
      const regs = await tx.select().from(e.stg_planilha_parecer);
      expect(regs.length).toBe(6);
      expect(regs.every((r) => r.arquivo === ARQUIVO)).toBe(true);
      expect("col_Y_sem_cabecalho" in regs[0]!).toBe(true);
      // RN-18: a data da célula entra como AAAA-MM-DD, sem deslocar
      expect(regs.find((r) => r.linha_origem === 2)!.col_e_data).toBe("2026-02-11");
    }));

  it("classifica, emite, reserva e rejeita linha a linha", () =>
    desfeita(db, async (tx) => {
      const r = await carregar(tx);
      expect(r.total).toBe(6);
      expect(linha(r, 2).classificacao).toBe("COMPLETA");
      expect(linha(r, 2).acao).toBe("emitido");
      expect(linha(r, 3).classificacao).toBe("RESERVA");
      expect(linha(r, 7).acao).toBe("rejeitada");
      for (const l of r.linhas) expect(["emitido", "rascunho", "reservado", "rejeitada", "ignorada"]).toContain(l.acao);
      const p1 = (await parecer(tx, 1))!;
      expect(p1.situacao).toBe("EMITIDO");
      expect(p1.texto_recomendacao_literal).toBe(true);
      expect(p1.data_emissao).toBe("2026-02-11");
      expect(p1.data_marco_inicial).toBe("2026-02-09");
      expect(p1.tipo_marco!.codigo).toBe("PORTARIA_LOCALIZACAO");
      expect((await parecer(tx, 2))!.situacao).toBe("RESERVADO");
      const [rej] = await tx.select().from(e.migracao_rejeitada).where(eq(e.migracao_rejeitada.ref, `${ARQUIVO}:7`));
      expect(rej!.motivo).toContain("sem número de parecer");
    }));

  it("linha só com número herda o ano da vizinha (ANO_INFERIDO)", () =>
    desfeita(db, async (tx) => {
      const r = await carregar(tx);
      expect(linha(r, 4).classificacao).toBe("RESERVA");
      expect(linha(r, 4).ano).toBe(2026);
      const p = (await parecer(tx, 3))!;
      expect(p.situacao).toBe("RESERVADO");
      expect(p.ano_inferido).toBe(true);
      const eventos = await tx.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ANO_INFERIDO"));
      expect(eventos.length).toBeGreaterThan(0);
    }));

  it("parcial sem percentual entra como rascunho, com agente canônico e posto corrigido", () =>
    desfeita(db, async (tx) => {
      const r = await carregar(tx);
      expect(linha(r, 5).classificacao).toBe("PARCIAL");
      expect(linha(r, 5).pendencias).toContain("Percentual aplicável ausente");
      const p = (await parecer(tx, 4))!;
      expect(p.situacao).toBe("RASCUNHO");
      const nomes = (await tx.select().from(e.posto_trabalho)).map((x) => x.nome);
      expect(nomes).not.toContain("Central de Esterelização de Materiais (CME)");
      expect(p.postos.map((pp) => pp.posto.nome)).toEqual(["Central de Esterilização de Materiais (CME)"]);
    }));

  it("sem NUP entra sem processo", () =>
    desfeita(db, async (tx) => {
      const r = await carregar(tx);
      expect(linha(r, 8).pendencias).toContain("sem número de processo (NUP)");
      expect((await parecer(tx, 5))!.processo_id).toBeNull();
    }));

  it("sinônimo de agente vai para o canônico e a RN-06 abre a pendência do migrado", () =>
    desfeita(db, async (tx) => {
      // com percentual, o parecer químico ganha exposição e pendência
      await carregar(tx, true, [{ ...(LINHAS[3] as Linha), col_r_percentual: "Médio (10%)" }]);
      const p = (await parecer(tx, 4))!;
      expect(p.exposicoes.map((x) => x.agente_nocivo.descricao)).toEqual(["Manipulação de produtos químicos"]);
      const abertas = await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "AVALIACAO_QUANTITATIVA"));
      expect(abertas.length).toBeGreaterThan(0);
      expect(abertas.every((x) => x.prazo !== null)).toBe(true);
      expect(abertas.every((x) => x.descricao.includes("migrado"))).toBe(true);
    }));

  it("portaria normaliza o número preservando o literal", () =>
    desfeita(db, async (tx) => {
      await carregar(tx);
      const portarias = await tx.select().from(e.portaria_localizacao);
      expect(portarias.length).toBeGreaterThan(0);
      for (const p of portarias) {
        expect(!p.numero.startsWith("0") || p.numero === "0").toBe(true);
        expect(p.texto_original).toBeTruthy();
      }
      expect(portarias.some((p) => p.texto_original.includes("Nº 035") && p.numero === "35")).toBe(true);
    }));

  it("marco da solicitação vai para o processo", () =>
    desfeita(db, async (tx) => {
      await carregar(tx, true, [
        { ...COMPLETA, col_v_recomendacao: "Reconhecer o direito ... a partir da data da solicitação 01/05/2026" },
      ]);
      const p = (await parecer(tx, 1))!;
      expect(p.tipo_marco!.codigo).toBe("SOLICITACAO_SEST");
      expect(p.data_marco_inicial).toBe("2026-05-01");
      const [proc] = await tx.select().from(e.processo).where(eq(e.processo.id, p.processo_id!));
      expect(proc!.data_solicitacao_sest).toBe("2026-05-01");
    }));

  it("reimportar não duplica", () =>
    desfeita(db, async (tx) => {
      await carregar(tx);
      const antes = (await tx.select().from(e.parecer_tecnico)).length;
      await carregar(tx);
      expect((await tx.select().from(e.parecer_tecnico)).length).toBe(antes);
    }));

  it("a recontagem põe a sequência no maior número", () =>
    desfeita(db, async (tx) => {
      await carregar(tx);
      await recontar_sequencia(tx);
      const [seq] = await tx.select().from(e.parecer_sequencia).where(eq(e.parecer_sequencia.ano, 2026));
      const maximo = Math.max(...(await tx.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.ano, 2026))).map((p) => p.numero));
      expect(seq!.ultimo_numero).toBe(maximo);
    }));

  it("simulação não grava parecer", () =>
    desfeita(db, async (tx) => {
      const r = await carregar(tx, false);
      expect(r.linhas.every((l) => l.acao === "simulada" || l.acao === "rejeitada")).toBe(true);
      expect((await tx.select().from(e.parecer_tecnico)).length).toBe(0);
    }));

  it("carga sobre número do sistema abre CONFLITO_NUMERACAO; a recarga não inventa outro", () =>
    desfeita(db, async (tx) => {
      const [dosistema] = await tx
        .insert(e.parecer_tecnico)
        .values({ numero: 12, ano: 2025, situacao: "RASCUNHO" })
        .returning();
      const linhas = [{ col_b_numero_parecer: 12, col_d_ano: 2025 }];
      await carregar(tx, true, linhas);
      const [achado] = await tx
        .select()
        .from(e.parecer_tecnico)
        .where(and(eq(e.parecer_tecnico.numero, 12), eq(e.parecer_tecnico.ano, 2025)));
      expect(achado!.id).toBe(dosistema!.id);
      const conflitos = await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "CONFLITO_NUMERACAO"));
      expect(conflitos.length).toBe(1);
      expect(conflitos[0]!.parecer_id).toBe(dosistema!.id);
      expect(conflitos[0]!.descricao).toContain("12/2025");
      await carregar(tx, true, linhas);
      expect((await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "CONFLITO_NUMERACAO"))).length).toBe(1);
    }));

  it("a recarga da mesma linha não inventa conflito", () =>
    desfeita(db, async (tx) => {
      const linhas = [{ col_b_numero_parecer: 77, col_d_ano: 2025 }];
      await carregar(tx, true, linhas);
      await carregar(tx, true, linhas);
      expect((await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "CONFLITO_NUMERACAO"))).length).toBe(0);
    }));
});

// =====================================================================
// As telas
// =====================================================================
describe("rotas de importação", () => {
  it("a planilha pela tela: simulação não grava, aplicação grava", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const arquivo = new File([(await montarPlanilha([COMPLETA, { col_b_numero_parecer: 2, col_d_ano: 2026 }])) as unknown as ArrayBuffer], "tela.xlsx");
    const sim = await cliente.post("/importar/planilha", { arquivo }, { cabecalhos: { accept: "text/html" } });
    expect(sim.status).toBe(200);
    expect(sim.text).toContain("simulação — nada foi gravado");
    expect((await db.select().from(e.stg_planilha_parecer).where(eq(e.stg_planilha_parecer.arquivo, "tela.xlsx"))).length).toBe(0);

    const real = await cliente.post("/importar/planilha", { arquivo, aplicar: "1" }, { cabecalhos: { accept: "text/html" } });
    expect(real.status).toBe(200);
    expect(real.text).toContain("aplicada");
    const regs = await db.select().from(e.stg_planilha_parecer).where(eq(e.stg_planilha_parecer.arquivo, "tela.xlsx"));
    expect(regs.length).toBe(2);
  });

  it("o quadro pela tela, em simulação", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const arquivo = new File([JSON.stringify(QUADRO)], "quadro.json", { type: "application/json" });
    const r = await cliente.post("/importar/trello", { arquivo }, { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Lista que ninguém mapeou");
    expect(r.text).toContain("simulação — nada foi gravado");
  });

  it("a tela de importar exige catalogo.gerenciar", async () => {
    const coord = await entrar(novoCliente(), "coordenador_csso");
    expect((await coord.get("/importar", { cabecalhos: { accept: "text/html" } })).status).toBe(200);
    const sec = await entrar(novoCliente(), "secretaria_csso");
    expect((await sec.get("/importar", { cabecalhos: { accept: "text/html" } })).status).toBe(403);
  });
});
