/**
 * O auxílio à análise (fatia 5): regras determinísticas sobre fatos já lidos.
 * Cada regra tem um caso; a leitura do banco e a tela têm um cada. Nada aqui
 * abre saúde nem identificação (só a presença).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as analise from "../src/servicos/acidente_analise.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { dados, em_investigacao } from "./acidente_ajuda.js";

const BASE: analise.FatosAnalise = {
  hoje: "2026-10-27",
  oc: {
    especie: "TIPICO", estado: "EM_INVESTIGACAO", data_evento: "2026-10-20", hora_evento: "10:00:00", minutos_apos_inicio_jornada: 90,
    ultimo_dia_trabalho: null, local_municipio: "Diamantina", local_uf: "MG", local_cnpj_contratada: null, transito_registro_policial: null,
    agente_causador_id: 1, agente_doenca_id: null, situacao_geradora_id: 1, prazo_comunicacao: "2026-10-30", prazo_prorrogado_ate: null,
    criado_em: new Date("2026-10-21T12:00:00Z"),
  },
  acidentados: [{ ordem: 1, vinculo: "SERVIDOR", empresa_contratada: null, houve_lesao: "SIM", menor_de_idade: false, responsavel_legal_solicitado: false, tem_identificacao: true, saude: { confirmada: true, com_partes: true } }],
  testemunhas: { total: 0, com_contato: 0 },
  investigacao: { campos_preenchidos: 13, campos_total: 13 },
  contagens: { entrevistas: 1, barreiras: 1, evidencias: 1, checklist_marcados: 3, acoes: 1, acoes_vencidas: 0 },
  relatorios: 0, encaminhamentos: 0, decisoes: 0,
};
const com = (oc: Partial<analise.FatosAnalise["oc"]> = {}, resto: Partial<analise.FatosAnalise> = {}): analise.FatosAnalise => ({ ...BASE, ...resto, oc: { ...BASE.oc, ...oc } });
const textos = (f: analise.FatosAnalise) => analise.avaliar(f).map((a) => a.texto).join("\n");

describe("sugestões por família do agente causador", () => {
  const maquina = { agente: { ordem: 70, rotulo: "MÁQUINA DE FUNDIR" } };

  it("sem agente escolhido ou fora da investigação, não sugere nada", () => {
    expect(textos(com({}, { agente: null }))).not.toMatch(/família/);
    expect(textos(com({ estado: "RELATORIO_EMITIDO" }, maquina))).not.toMatch(/família/);
  });

  it("agente de máquina com plano sem ação do tipo sugerido: lista os tipos que faltam, avisando que é sugestão", () => {
    const t = textos(com({}, { ...maquina, tipos_de_acao: ["TREINAMENTO"] }));
    expect(t).toMatch(/família máquinas e transportadores/);
    expect(t).toMatch(/Engenharia \/ proteção coletiva \(proteção de partes móveis/);
    expect(t).toMatch(/Procedimento \(bloqueio e etiquetagem/);
    expect(t).not.toMatch(/Treinamento \/ orientação \(operação segura/);
    expect(t).toMatch(/A equipe de segurança decide/);
  });

  it("some quando o plano já tem uma ação de cada tipo sugerido", () => {
    const todos = ["ENGENHARIA", "PROCEDIMENTO", "TREINAMENTO", "SINALIZACAO"];
    expect(textos(com({}, { ...maquina, tipos_de_acao: todos }))).not.toMatch(/família/);
  });
});

describe("avaliar", () => {
  it("o caso completo só tem o próximo passo: emitir o relatório", () => {
    const r = analise.avaliar(BASE);
    expect(r.map((a) => a.nivel)).toEqual(["PROXIMO_PASSO"]);
    expect(r[0]!.texto).toMatch(/emitir o relatório/);
  });

  it("lacunas do Anexo III na comunicação", () => {
    const t = textos(com({ hora_evento: null, minutos_apos_inicio_jornada: null, local_uf: null, situacao_geradora_id: null, agente_causador_id: null }));
    expect(t).toMatch(/Hora do acidente/);
    expect(t).toMatch(/Após quantas horas/);
    expect(t).toMatch(/Município e UF/);
    expect(t).toMatch(/Situação geradora/);
    expect(t).toMatch(/Tabela II/);
  });

  it("doença pede agente da Tabela III e último dia trabalhado; trajeto pede o registro policial", () => {
    expect(textos(com({ especie: "DOENCA_TRABALHO", agente_causador_id: null, agente_doenca_id: null }))).toMatch(/Tabela III[\s\S]*Último dia trabalhado/);
    expect(textos(com({ especie: "TRAJETO" }))).toMatch(/registro policial/);
  });

  it("empresa contratada sem CNPJ; menor sem responsável; terceirizado sem empresa", () => {
    const a = { ...BASE.acidentados[0]!, empresa_contratada: "Empresa X", menor_de_idade: true, vinculo: "TERCEIRIZADO" };
    const t = textos(com({}, { acidentados: [a, { ...a, ordem: 2, empresa_contratada: null }] }));
    expect(t).toMatch(/CNPJ/);
    expect(t).toMatch(/menor de idade/);
    expect(t).toMatch(/terceirizado sem empresa/);
  });

  it("por envolvido: sem identificação, saúde ausente, só declarada, sem parte do corpo", () => {
    const base = BASE.acidentados[0]!;
    expect(textos(com({}, { acidentados: [{ ...base, tem_identificacao: false }] }))).toMatch(/identificação pessoal/);
    expect(textos(com({}, { acidentados: [{ ...base, saude: null }] }))).toMatch(/saúde ainda não foi registrada/);
    const so_declarada = textos(com({}, { acidentados: [{ ...base, saude: { confirmada: false, com_partes: false } }] }));
    expect(so_declarada).toMatch(/médico confirmar/);
    expect(so_declarada).toMatch(/Tabela I\)/);
  });

  it("testemunhas sem endereço", () => {
    expect(textos(com({}, { testemunhas: { total: 2, com_contato: 1 } }))).toMatch(/1 testemunha\(s\) sem endereço/);
  });

  it("não fecha: espécie contra tabela, jornada impossível, último dia depois do acidente", () => {
    expect(textos(com({ agente_doenca_id: 2 }))).toMatch(/típico com agente causador de DOENÇA/);
    expect(textos(com({ especie: "DOENCA_TRABALHO", agente_doenca_id: 2, agente_causador_id: 2, ultimo_dia_trabalho: "2026-10-01" }))).toMatch(/de ACIDENTE/);
    expect(textos(com({ minutos_apos_inicio_jornada: 2000 }))).toMatch(/24 horas/);
    expect(textos(com({ ultimo_dia_trabalho: "2026-10-01" }))).toMatch(/anterior ao acidente/);
    expect(analise.avaliar(com({ agente_doenca_id: 2 }))[0]!.nivel).toBe("INCONSISTENCIA");
  });

  it("prazo do art. 214: fora do prazo avisa; prorrogado não", () => {
    const tarde = { criado_em: new Date("2026-11-05T12:00:00Z") };
    expect(textos(com(tarde))).toMatch(/6 dia\(s\) depois do prazo/);
    expect(textos(com({ ...tarde, prazo_prorrogado_ate: "2026-11-10" }))).not.toMatch(/depois do prazo/);
  });

  it("próximos passos da investigação, e as ações vencidas", () => {
    const t = textos(com({}, { investigacao: { campos_preenchidos: 10, campos_total: 13 }, contagens: { entrevistas: 0, barreiras: 0, evidencias: 0, checklist_marcados: 0, acoes: 0, acoes_vencidas: 2 } }));
    for (const re of [/faltam 3 de 13/, /nenhum item marcado/, /entrevista/, /barreiras/, /evidências/, /Propor ações/, /2 ação\(ões\)/]) expect(t).toMatch(re);
  });

  it("próximo passo por estado: relatório emitido e encaminhada sem decisão", () => {
    expect(textos(com({ estado: "RELATORIO_EMITIDO" }))).toMatch(/Encaminhar o relatório ao SIASS/);
    expect(textos(com({ estado: "ENCAMINHADA_SIASS" }))).toMatch(/decisão pericial/);
    expect(textos(com({ estado: "ENCAMINHADA_SIASS" }, { decisoes: 1 }))).not.toMatch(/decisão pericial/);
  });
});

describe("do banco e pela tela", () => {
  let db: Banco;
  let novoCliente: () => Cliente;
  beforeEach(async () => {
    const amb = await bancoLimpo();
    db = amb.db;
    novoCliente = amb.novoCliente;
    await contas(db);
  });

  it("lê o caso sem abrir saúde nem identificação (nada de acesso gravado)", async () => {
    const { oc } = await em_investigacao(db);
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    const r = await db.transaction((tx) => analise.do_caso(tx, tecnico, oc));
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((a) => a.nivel === "PROXIMO_PASSO")).toBe(true);
    expect(await db.select().from(e.acesso_dado_sensivel)).toHaveLength(0);
    expect(await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id))).toHaveLength(1);
  });

  it("com o agente causador escolhido, sugere pela família e deixa de sugerir quando o plano cobre", async () => {
    const [maquina] = await db.select().from(e.acidente_agente_causador).where(eq(e.acidente_agente_causador.ordem, 64));
    expect(maquina).toBeTruthy();
    // os fatos do evento não mudam depois (trigger): o caso já nasce com o agente
    const { oc } = await em_investigacao(db, { fatos: { ...dados().fatos, agente_causador_id: maquina!.id } });
    const [atual] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    const r = await db.transaction((tx) => analise.do_caso(tx, tecnico, atual!));
    const sugestao = r.find((a) => /família máquinas e transportadores/.test(a.texto));
    expect(sugestao?.nivel).toBe("PROXIMO_PASSO");
    expect(sugestao?.texto).toContain(maquina!.rotulo);
  });

  it("quem não investiga nem encaminha é negado", async () => {
    const { oc } = await em_investigacao(db);
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => analise.do_caso(tx, secretaria, oc))).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("a aba Análise aparece para o técnico e mostra os apontamentos", async () => {
    const { oc } = await em_investigacao(db);
    const tecnico = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await tecnico.get(`/acidentes/${oc.id}?aba=analise`, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Análise do caso");
    expect(r.text).toContain("Próximo passo");
  });
});
