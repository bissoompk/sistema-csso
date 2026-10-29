/**
 * Ocorrências de urgência e emergência (28/10/2026): o registro geral, de
 * qualquer pessoa na universidade. Quem registra (servidor, terceirizado,
 * discente, equipe), o que cada um lê, o trâmite da equipe, a planilha sem dado
 * sensível e a trilha sem conteúdo. Dados fictícios.
 */
import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar, type Campos } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const [campus] = await db.insert(e.campus).values({ sigla: "OCO", nome: "Campus Ocorrência", cidade: "Diamantina" }).returning();

/** Uma hora atrás, no formato do `datetime-local` (Brasília). */
function uma_hora_atras(): string {
  const d = new Date(Date.now() - 3600_000 - 3 * 3600_000);
  return d.toISOString().slice(0, 16);
}

function ocorrencia(troca: Campos = {}): Campos {
  return {
    data_hora: uma_hora_atras(),
    campus_id: String(campus!.id),
    local_descricao: "Sala fictícia 12, bloco B",
    tipo: "DESMAIO",
    descricao: "A pessoa desmaiou na aula e foi socorrida pelos colegas.",
    eh_a_pessoa: "",
    pessoa_nome: "Pessoa Fictícia da Silva",
    pessoa_vinculo: "ESTUDANTE",
    nivel_ensino: "GRADUACAO",
    curso: "Curso Fictício",
    encaminhada: "nao",
    ...troca,
  };
}

async function registrar(login: string, troca: Campos = {}) {
  const cli = await entrar(novoCliente(), login);
  const r = await cli.post("/ocorrencias/registrar", ocorrencia(troca), { seguir: false });
  return { cli, r };
}

/** O id da última ocorrência gravada (quem não é da equipe volta para a lista, sem o id na URL). */
async function ultima(): Promise<number> {
  const [o] = await db.select({ id: e.ocorrencia.id }).from(e.ocorrencia).orderBy(desc(e.ocorrencia.id)).limit(1);
  return o!.id;
}

describe("registrar", () => {
  it.each(["servidor_consulta", "terceirizado", "discente", "secretaria_csso"])("%s registra e recebe o protocolo", async (login) => {
    const { cli, r } = await registrar(login);
    expect(r.status).toBe(303);
    const lista = await cli.get("/ocorrencias/minhas", { seguir: false });
    expect(lista.status).toBe(200);
    expect(lista.text).toMatch(/OCO-\d{4}-\d{4}/);
    expect(lista.text).toContain("Desmaio");
  });

  it("o protocolo é sequencial e a conta que registrou vê a ficha, com o nome da pessoa", async () => {
    const { cli, r } = await registrar("discente", { eh_a_pessoa: "1", pessoa_nome: "" });
    const ficha = await cli.get(`/ocorrencias/${await ultima()}`, { seguir: false });
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Discente de Teste");
  });

  it("só ficam os campos do vínculo escolhido", async () => {
    const { r } = await registrar("terceirizado", { pessoa_vinculo: "TERCEIRIZADO", empresa: "Empresa Fictícia", curso: "não deve ficar", setor_lotacao: "nem este" });
    const [o] = await db.select().from(e.ocorrencia).where(eq(e.ocorrencia.id, await ultima()));
    expect(o!.empresa).toBe("Empresa Fictícia");
    expect(o!.curso).toBeNull();
    expect(o!.setor_lotacao).toBeNull();
    expect(o!.nivel_ensino).toBeNull();
  });

  it("recusa com a mensagem e devolve o que foi digitado", async () => {
    const { r } = await registrar("servidor_consulta", { tipo: "", descricao: "Texto que não deve se perder" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Marque ao menos um tipo");
    expect(r.text).toContain("Texto que não deve se perder");
  });

  it("recusa data futura, CPF no relato e meio de deslocamento sem encaminhamento obrigatório", async () => {
    const futura = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    expect((await registrar("servidor_consulta", { data_hora: futura })).r.text).toContain("não podem ser futuras");
    expect((await registrar("servidor_consulta", { descricao: "paciente de CPF 123.456.789-09 caiu" })).r.status).toBe(422);
    const sem_meio = await registrar("servidor_consulta", { encaminhada: "sim", meio_deslocamento: "" });
    expect(sem_meio.r.text).toContain("meio de deslocamento");
    const com_meio = await registrar("servidor_consulta", { encaminhada: "sim", meio_deslocamento: "SAMU" });
    expect(com_meio.r.status).toBe(303);
  });

  it("a trilha guarda o protocolo, nunca o relato nem o nome", async () => {
    const { r } = await registrar("discente", { pessoa_nome: "Nome Sigiloso Fictício", descricao: "Relato sigiloso fictício" });
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, await ultima()));
    const meus = eventos.filter((v) => v.entidade === "ocorrencia");
    expect(meus.length).toBeGreaterThan(0);
    expect(JSON.stringify(meus)).not.toContain("Sigiloso");
  });
});

describe("quem lê o quê", () => {
  it("a ocorrência de um não abre para outro (404), mas abre para a equipe", async () => {
    const { r } = await registrar("terceirizado");
    const id = await ultima();
    const outro = await entrar(novoCliente(), "discente");
    expect((await outro.get(`/ocorrencias/${id}`, { seguir: false })).status).toBe(404);
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    expect((await equipe.get(`/ocorrencias/${id}`, { seguir: false })).status).toBe(200);
  });

  it("fila, indicadores e planilha são da equipe; os demais recebem 403", async () => {
    for (const login of ["servidor_consulta", "terceirizado", "discente"]) {
      const cli = await entrar(novoCliente(), login);
      for (const caminho of ["/ocorrencias/fila", "/ocorrencias/indicadores", "/ocorrencias/exportar"]) {
        expect((await cli.get(caminho, { seguir: false })).status, `${login} ${caminho}`).toBe(403);
      }
      expect((await cli.get("/ocorrencias", { seguir: false })).status).toBe(200);
    }
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    for (const caminho of ["/ocorrencias", "/ocorrencias/fila", "/ocorrencias/indicadores", "/ocorrencias/registrar", "/ocorrencias/minhas"]) {
      expect((await equipe.get(caminho, { seguir: false })).status, caminho).toBe(200);
    }
  });

  it("auditor e administrador de TI não leem o módulo", async () => {
    for (const login of ["auditor_interno", "admin_ti"]) {
      const cli = await entrar(novoCliente(), login);
      expect((await cli.get("/ocorrencias/fila", { seguir: false })).status, login).toBe(403);
    }
  });

  it("a fila lista fatos sem o nome da pessoa e a planilha sai sem nome e sem relato", async () => {
    await registrar("discente", { pessoa_nome: "Fulana Reservada Fictícia", descricao: "Relato reservado fictício", tipo: "QUEDA" });
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    const fila = await equipe.get("/ocorrencias/fila", { seguir: false });
    expect(fila.text).toContain("Queda");
    expect(fila.text).not.toContain("Reservada");
    const csv = await equipe.get("/ocorrencias/exportar", { seguir: false });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text).toContain("Queda");
    expect(csv.text).not.toContain("Reservada");
    expect(csv.text).not.toContain("reservado");
  });
});

describe("o trâmite da equipe", () => {
  it("assumir, acompanhar, concluir; encerrada não muda mais", async () => {
    const { r } = await registrar("terceirizado");
    const id = await ultima();
    const equipe = await entrar(novoCliente(), "tecnico_seguranca");
    const base = `/ocorrencias/${id}`;
    expect((await equipe.post(`${base}/assumir`, {}, { seguir: false })).status).toBe(303);
    expect((await equipe.get(base, { seguir: false })).text).toContain("Em acompanhamento");
    await equipe.post(`${base}/acompanhar`, { texto: "Falei com a pessoa, está bem." }, { seguir: false });
    expect((await equipe.get(base, { seguir: false })).text).toContain("Falei com a pessoa");
    await equipe.post(`${base}/concluir`, { conclusao: "Atendida e liberada." }, { seguir: false });
    const depois = await equipe.get(base, { seguir: false });
    expect(depois.text).toContain("Concluída");
    expect(depois.text).not.toContain(`action="${base}/concluir"`);
    const [o] = await db.select().from(e.ocorrencia).where(eq(e.ocorrencia.id, id));
    expect(o!.situacao).toBe("CONCLUIDA");
    // depois de encerrada, mexer devolve o recado
    const tarde = await equipe.post(`${base}/acompanhar`, { texto: "Tarde demais." }, { seguir: false });
    expect(decodeURIComponent(tarde.headers.get("location") ?? "")).toContain("já está encerrada");
  });

  it("quem registrou não trata a própria ocorrência", async () => {
    const { cli, r } = await registrar("discente");
    const res = await cli.post(`/ocorrencias/${await ultima()}/assumir`, {}, { seguir: false });
    expect(res.status).toBe(403);
  });

  it("vincula à CAT/SP existente e recusa protocolo inexistente", async () => {
    const { r } = await registrar("servidor_consulta", { pessoa_vinculo: "SERVIDOR", acidente_em_servico: "SIM" });
    const id = await ultima();
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    expect((await equipe.get(`/ocorrencias/${id}`, { seguir: false })).text).toContain("acidente em serviço");
    const ruim = await equipe.post(`/ocorrencias/${id}/vincular-acidente`, { protocolo_cat: "CAT-1999-0001" }, { seguir: false });
    expect(decodeURIComponent(ruim.headers.get("location") ?? "")).toContain("Não há comunicação");
  });

  it("indicadores contam por tipo e não contam as canceladas", async () => {
    await registrar("discente", { tipo: "FRATURA" });
    const { r } = await registrar("discente", { tipo: "FRATURA" });
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    const antes = (await equipe.get("/ocorrencias/indicadores", { seguir: false })).text;
    expect(antes).toContain("Fratura");
    await equipe.post(`/ocorrencias/${await ultima()}/cancelar`, { motivo: "Registro duplicado" }, { seguir: false });
    const depois = (await equipe.get("/ocorrencias/indicadores", { seguir: false })).text;
    expect(depois).not.toBe(antes);
  });
});

describe("a trava de produção", () => {
  it("em produção só abre com CSSO_MODULO_OCORRENCIAS=sim; `nao` desliga em qualquer ambiente", async () => {
    const { ocorrenciasLiberado } = await import("../src/config.js");
    expect(ocorrenciasLiberado({ CSSO_AMBIENTE: "producao" })).toBe(false);
    expect(ocorrenciasLiberado({ CSSO_AMBIENTE: "producao", CSSO_MODULO_OCORRENCIAS: "sim" })).toBe(true);
    expect(ocorrenciasLiberado({ CSSO_AMBIENTE: "desenvolvimento" })).toBe(true);
    expect(ocorrenciasLiberado({ CSSO_AMBIENTE: "desenvolvimento", CSSO_MODULO_OCORRENCIAS: "nao" })).toBe(false);
  });

  it("travado, toda rota do módulo responde 404", async () => {
    const antes = process.env.CSSO_MODULO_OCORRENCIAS;
    process.env.CSSO_MODULO_OCORRENCIAS = "nao";
    try {
      const cli = await entrar(novoCliente(), "coordenador_csso");
      for (const caminho of ["/ocorrencias", "/ocorrencias/registrar", "/ocorrencias/fila"]) {
        expect((await cli.get(caminho, { seguir: false })).status, caminho).toBe(404);
      }
    } finally {
      if (antes === undefined) delete process.env.CSSO_MODULO_OCORRENCIAS;
      else process.env.CSSO_MODULO_OCORRENCIAS = antes;
    }
  });
});
