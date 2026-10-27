/**
 * F3 do módulo de acidentes: a saúde do acidentado. Níveis por perfil;
 * finalidade antes do conteúdo; um registro de acesso a cada abertura; evento
 * quando quem lê não conduz o caso; o titular lê tudo sem registro; a trilha
 * não carrega valores; o nível 2 não se apaga; a declaração do comunicante vira
 * linha e pendência, e o médico a confirma. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as saude from "../src/servicos/acidente_saude.js";
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

const VAZIO: saude.DadosSaude = {
  natureza_lesao_id: null,
  parte_corpo_ids: [],
  lateralidade: null,
  houve_atendimento: null,
  houve_afastamento: null,
  houve_internacao: null,
  houve_obito: null,
  houve_sequela: null,
  dias_afastamento: null,
  afastamento_inicio: null,
  afastamento_retorno: null,
  dias_internacao: null,
  data_obito: null,
  dias_debitados: null,
  primeiro_socorro_por: null,
  primeiro_socorro_unidade: null,
  atendimento_em: null,
  duracao_tratamento_dias: null,
  deve_afastar: null,
  descricao_lesao: null,
  diagnostico_provavel: null,
  cid: null,
  observacoes_saude: null,
};

async function cenario() {
  const c = await em_investigacao(db);
  const [acid] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, c.oc.id));
  return { ...c, acid: acid! };
}

const acessos = (acidentado_id: number) =>
  db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.acidentado_id, acidentado_id));

describe("a declaração do comunicante", () => {
  it("vira linha DECLARADO_COMUNICANTE e abre a pendência para o médico", async () => {
    const { oc, acid } = await cenario();
    const [linha] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, acid.id));
    expect(linha!.origem).toBe("DECLARADO_COMUNICANTE");
    expect(linha!.houve_atendimento).toBe("SIM");
    const [p] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, `ACIDENTE_SAUDE_REGISTRAR:${oc.id}`));
    expect(p).toBeTruthy();
    expect(p!.descricao).not.toMatch(/SIM|NAO/);
  });
});

describe("a leitura", () => {
  it("exige a finalidade antes do conteúdo e não grava acesso quando recusa", async () => {
    const { oc, acid, equipe } = await cenario();
    await expect(db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, null))).rejects.toThrow(/finalidade/);
    await expect(db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, "QUALQUER"))).rejects.toThrow(/finalidade/);
    expect(await acessos(acid.id)).toHaveLength(0);
  });

  it("grava um acesso a cada abertura, com o acidentado e a finalidade", async () => {
    const { oc, acid, equipe } = await cenario();
    await db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, "INVESTIGACAO"));
    await db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, "INVESTIGACAO"));
    const a = await acessos(acid.id);
    expect(a).toHaveLength(2);
    expect(a[0]!.campo).toBe("acidente_saude_nivel_1");
    expect(a[0]!.acidente_id).toBe(oc.id);
    expect(a[0]!.finalidade).toBeTruthy();
  });

  it("nível 1 por quem tem saude_ver; nível 2 só com saude_detalhe_ver", async () => {
    const { oc, acid, equipe } = await cenario();
    const l = await db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, "INVESTIGACAO"));
    expect(l.fatos.houve_atendimento).toBe("SIM");
    expect(l.detalhe).toBeNull();
    // o técnico não tem o detalhe clínico
    await expect(db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 2, "INVESTIGACAO"))).rejects.toThrow();
    const medico = await usuarioAtual(db, "medico_trabalho");
    const l2 = await db.transaction((tx) => saude.ler(tx, medico, oc, acid.id, 2, "CLASSIFICACAO_GRAVIDADE"));
    expect(l2.detalhe).not.toBeNull();
  });

  it("quem não lê saúde é recusado (secretaria)", async () => {
    const { oc, acid } = await cenario();
    const secretaria = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => saude.ler(tx, secretaria, oc, acid.id, 1, "INVESTIGACAO"))).rejects.toThrow();
    expect(await acessos(acid.id)).toHaveLength(0);
  });

  it("quem lê sem conduzir o caso deixa evento na trilha, sem valores", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    expect(oc.responsavel_id).not.toBe(medico.id);
    await db.transaction((tx) => saude.ler(tx, medico, oc, acid.id, 1, "CLASSIFICACAO_GRAVIDADE"));
    const evs = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_SAUDE_FORA_RESPONSAVEL"), eq(e.historico_evento.entidade_id, oc.id)));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.descricao).toContain(oc.protocolo);
    expect(evs[0]!.descricao).not.toMatch(/\bSim\b|\bSIM\b/);
  });

  it("o responsável pelo caso não deixa evento, só o acesso", async () => {
    const { oc, acid, equipe } = await cenario();
    expect(oc.responsavel_id).toBe(equipe.id);
    await db.transaction((tx) => saude.ler(tx, equipe, oc, acid.id, 1, "INVESTIGACAO"));
    const evs = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_SAUDE_FORA_RESPONSAVEL"));
    expect(evs).toHaveLength(0);
  });

  it("o titular lê tudo da própria ocorrência, sem finalidade e sem registro", async () => {
    const { oc, acid } = await cenario();
    // o titular já foi ligado ao cadastro de servidor pelo cenário
    const usuario = await usuarioAtual(db, "servidor_consulta");
    const l = await db.transaction((tx) => saude.ler(tx, usuario, oc, acid.id, 2, null));
    expect(l.titular).toBe(true);
    expect(l.fatos.houve_atendimento).toBe("SIM");
    expect(await acessos(acid.id)).toHaveLength(0);
  });
});

describe("o registro do médico", () => {
  it("grava os campos clínicos do Anexo III, normaliza o CID e não os põe na trilha", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    await db.transaction((tx) =>
      saude.registrar(tx, medico, oc, acid.id, {
        ...VAZIO, houve_atendimento: "SIM", duracao_tratamento_dias: 15, deve_afastar: "SIM",
        descricao_lesao: "Corte superficial", diagnostico_provavel: "Ferimento", cid: "s610", observacoes_saude: "Retorno em 7 dias",
      }, 1),
    );
    const [linha] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, acid.id));
    expect(linha).toMatchObject({ duracao_tratamento_dias: 15, deve_afastar: "SIM", cid: "S61.0" });
    const evs = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, oc.id));
    expect(JSON.stringify(evs)).not.toMatch(/Corte superficial|S61\.0|Retorno em 7/);
    expect(JSON.stringify(evs)).toMatch(/CID/);
    const l2 = await db.transaction((tx) => saude.ler(tx, medico, oc, acid.id, 2, "INVESTIGACAO"));
    expect(l2.detalhe).toMatchObject({ cid: "S61.0", descricao_lesao: "Corte superficial" });
    const l1 = await db.transaction((tx) => saude.ler(tx, medico, oc, acid.id, 1, "INVESTIGACAO"));
    expect(l1.detalhe).toBeNull();
  });

  it("recusa CID inválido e impede apagar campo clínico sem expurgo", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    await expect(db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, cid: "XYZ" }, 1))).rejects.toThrow(/CID/);
    await db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, cid: "S61.0" }, 1));
    await expect(db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, cid: null }, 2))).rejects.toThrow(/corrija-o/);
  });

  it("confirma a declaração: origem muda, a pendência fecha e a trilha não leva valores", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    const r = await db.transaction((tx) =>
      saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, houve_atendimento: "SIM", houve_afastamento: "SIM", dias_afastamento: 7, primeiro_socorro_por: "Brigadista" }, 1),
    );
    expect(r.criada).toBe(false);
    expect(r.campos).toEqual(expect.arrayContaining(["houve_afastamento", "dias_afastamento", "primeiro_socorro_por"]));
    const [linha] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, acid.id));
    expect(linha!.origem).toBe("REGISTRADO_MEDICO");
    expect(linha!.versao).toBe(2);
    const [p] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, `ACIDENTE_SAUDE_REGISTRAR:${oc.id}`));
    expect(p!.concluida).toBe(true);
    const evs = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "ACIDENTE_SAUDE_ALTERADA"), eq(e.historico_evento.entidade_id, oc.id)));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.descricao).toContain("dias de afastamento");
    expect(evs[0]!.descricao).not.toContain("Brigadista");
    expect(evs[0]!.descricao).not.toMatch(/\b7\b/);
  });

  it("quem não tem saude_registrar é recusado (técnico, só nível 1)", async () => {
    const { oc, acid, equipe } = await cenario();
    await expect(db.transaction((tx) => saude.registrar(tx, equipe, oc, acid.id, VAZIO, 1))).rejects.toThrow();
  });

  it("versão velha dá conflito e nada se grava", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    await db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, houve_obito: "NAO" }, 1));
    await expect(
      db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, houve_obito: "SIM" }, 1)),
    ).rejects.toBeInstanceOf(saude.SaudeAlterada);
    const [linha] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, acid.id));
    expect(linha!.houve_obito).toBe("NAO");
  });

  it("recusa apagar o nível 2 já preenchido, com a frase certa (a trigger só deixa com expurgo)", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    await db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, dias_afastamento: 3 }, 1));
    await expect(
      db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO }, 2)),
    ).rejects.toThrow(/corrija-o, não o apague/);
    await expect(db.execute(sql`UPDATE acidente_saude SET dias_afastamento = NULL WHERE acidentado_id = ${acid.id}`)).rejects.toThrow();
  });

  it("valida: data do óbito só com óbito Sim, retorno depois do início, valor fora da lista", async () => {
    const { oc, acid } = await cenario();
    const medico = await usuarioAtual(db, "medico_trabalho");
    const tenta = (d: Partial<saude.DadosSaude>) => db.transaction((tx) => saude.registrar(tx, medico, oc, acid.id, { ...VAZIO, ...d }, 1));
    await expect(tenta({ data_obito: "2026-10-01", houve_obito: "NAO" })).rejects.toThrow(/óbito/);
    await expect(tenta({ afastamento_inicio: "2026-10-10", afastamento_retorno: "2026-10-01" })).rejects.toThrow(/retorno/);
    await expect(tenta({ houve_atendimento: "TALVEZ" })).rejects.toThrow(/inválido/);
    await expect(tenta({ dias_afastamento: -2 })).rejects.toThrow(/dias/);
  });
});

describe("pela tela", () => {
  it("sem finalidade a tela recusa (422) e não mostra o conteúdo; com ela, mostra e registra o acesso", async () => {
    const { oc, acid } = await cenario();
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const sem = await cli.get(`/acidentes/${oc.id}/saude?acidentado=${acid.id}&nivel=1`, { seguir: false });
    expect(sem.status).toBe(422);
    expect(sem.text).toContain("finalidade");
    expect(await acessos(acid.id)).toHaveLength(0);
    const com = await cli.get(`/acidentes/${oc.id}/saude?acidentado=${acid.id}&nivel=1&finalidade=INVESTIGACAO`, { seguir: false });
    expect(com.status).toBe(200);
    expect(com.text).toContain("Declarado por quem comunicou");
    expect(await acessos(acid.id)).toHaveLength(1);
  });

  it("a secretaria não abre a saúde", async () => {
    const { oc, acid } = await cenario();
    const cli = await entrar(novoCliente(), "secretaria_csso");
    const r = await cli.get(`/acidentes/${oc.id}/saude?acidentado=${acid.id}&nivel=1&finalidade=INVESTIGACAO`, { seguir: false });
    expect([403, 404, 422]).toContain(r.status);
    expect(await acessos(acid.id)).toHaveLength(0);
  });

  it("o médico registra pelo formulário e volta à aba", async () => {
    const { oc, acid } = await cenario();
    const cli = await entrar(novoCliente(), "medico_trabalho");
    const r = await cli.post(
      `/acidentes/${oc.id}/saude`,
      { acidentado_id: String(acid.id), versao: "1", finalidade: "CLASSIFICACAO_GRAVIDADE", houve_atendimento: "SIM", dias_afastamento: "2" },
      { seguir: false },
    );
    expect([302, 303]).toContain(r.status);
    const [linha] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, acid.id));
    expect(linha!.dias_afastamento).toBe(2);
  });
});
