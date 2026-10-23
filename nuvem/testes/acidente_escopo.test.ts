/**
 * F1 do módulo de acidentes, pelas telas: o escopo (o servidor comum vê só as
 * próprias — as que comunicou e aquelas em que é o acidentado; a equipe do
 * campus, as do campus; sem permissão, 403), o comunicar pelo formulário (com
 * a recusa que devolve o digitado), a triagem pelos popups (com o 409 da tela
 * velha), a resposta à complementação e a fila sem nome. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Campos, type Cliente } from "./ajuda.js";
import { dados, servidorFicticio, titular } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const como = (login: string) => entrar(novoCliente(), login);

function formulario(extra: Campos = {}): Campos {
  return {
    env_indice: "1",
    env_1_sou_eu: "1",
    env_1_vinculo: "SERVIDOR",
    env_1_condicao: "ACIDENTADO",
    env_1_houve_lesao: "SIM",
    especie: "TIPICO",
    data_evento: somar_dias(hoje_iso(), -2),
    hora_evento: "10:15",
    jornada: "01:30",
    local_tipo: "LABORATORIO",
    local_especificacao: "Laboratório fictício, bancada 2",
    local_uf: "MG",
    descricao: "A bandeja escorregou da prateleira durante a arrumação.",
    test_1_nome: "Testemunha Fictícia",
    test_1_contato: "ramal 999",
    declaracao: "1",
    ...extra,
  };
}

async function campus(sigla: string) {
  return (await db.select().from(e.campus).where(eq(e.campus.sigla, sigla)))[0]!;
}

describe("comunicar pela tela", () => {
  it("o servidor comum comunica e cai na ficha, que mostra o protocolo e o relato", async () => {
    await titular(db);
    const cli = await como("servidor_consulta");
    const r = await cli.post("/acidentes/comunicar", formulario(), { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/acidentes\/\d+\?mensagem=/);
    const ficha = await cli.get(r.location!);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toMatch(/CAT-\d{4}-0001/);
    expect(ficha.text).toContain("A bandeja escorregou");
    // o titular não tem os botões da triagem
    expect(ficha.text).not.toContain("Pedir complementação");
  });

  it("a recusa devolve o formulário com o que foi digitado e o erro", async () => {
    await titular(db);
    const cli = await como("servidor_consulta");
    const r = await cli.post("/acidentes/comunicar", formulario({ declaracao: "", local_especificacao: "Sala 33 do prédio fictício" }), { seguir: false });
    expect(r.status).toBe(422);
    expect(r.text).toContain("declaração");
    expect(r.text).toContain("Sala 33 do prédio fictício");
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(0);
  });

  it("CPF digitado no formulário não chega ao banco nem volta na tela", async () => {
    await titular(db);
    const cli = await como("servidor_consulta");
    // a borda mascara o número; o serviço recusa o que sobrar (o termo, ou o número)
    const r = await cli.post("/acidentes/comunicar", formulario({ descricao: "Fulano, CPF 123.456.789-09, caiu" }), { seguir: false });
    expect(r.status).toBe(422);
    expect(r.text).not.toContain("123.456.789-09");
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(0);
  });

  it("o envolvido a mais chega por HTMX, com o botão do seguinte", async () => {
    await titular(db);
    const cli = await como("servidor_consulta");
    const r = await cli.get("/acidentes/comunicar/envolvido?i=2");
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="env_indice" value="2"');
    expect(r.text).toContain("envolvido?i=3");
  });
});

describe("escopo", () => {
  it("o servidor comum vê só as próprias: as que comunicou e aquelas em que é o acidentado", async () => {
    const { usuario } = await titular(db);
    const minha = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    // outra pessoa comunica um acidente de terceiro
    const outro_sv = await servidorFicticio(db, "7000009");
    await criarUsuario(db, { login: "colega", perfis: ["servidor_consulta"], servidor_id: outro_sv.id });
    const colega = await usuarioAtual(db, "colega");
    const alheia = await db.transaction((tx) =>
      comunicacao.comunicar(tx, colega, dados({ envolvidos: [{ ...dados().envolvidos[0]!, sou_eu: true }] })),
    );
    const cli = await como("servidor_consulta");
    expect((await cli.get(`/acidentes/${minha.id}`)).status).toBe(200);
    expect((await cli.get(`/acidentes/${alheia.id}`, { seguir: false })).status).toBe(404);
    const lista = await cli.get("/acidentes/minhas");
    expect(lista.text).toContain(minha.protocolo);
    expect(lista.text).not.toContain(alheia.protocolo);
  });

  it("quem comunicou o acidente de outra pessoa acompanha o que enviou", async () => {
    const { usuario } = await titular(db);
    const acidentado = await servidorFicticio(db, "7000010");
    const oc = await db.transaction((tx) =>
      comunicacao.comunicar(tx, usuario, dados({ envolvidos: [{ ...dados().envolvidos[0]!, sou_eu: false, siape: acidentado.siape }] })),
    );
    expect(oc.servidor_id).toBe(acidentado.id);
    const cli = await como("servidor_consulta");
    expect((await cli.get(`/acidentes/${oc.id}`)).status).toBe(200);
  });

  it("a equipe do campus vê as do campus, e não as dos outros", async () => {
    const { usuario } = await titular(db);
    const [a, b] = [await campus("DIA"), await campus("MUC")];
    const no_a = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados({ fatos: { ...dados().fatos, campus_id: a.id } })));
    const no_b = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados({ fatos: { ...dados().fatos, campus_id: b.id } })));
    await criarUsuario(db, { login: "tec_a", perfis: ["tecnico_seguranca"], campus_id: a.id });
    const cli = await como("tec_a");
    expect((await cli.get(`/acidentes/${no_a.id}`)).status).toBe(200);
    expect((await cli.get(`/acidentes/${no_b.id}`, { seguir: false })).status).toBe(404);
    const fila = await cli.get("/acidentes/fila");
    expect(fila.text).toContain(no_a.protocolo);
    expect(fila.text).not.toContain(no_b.protocolo);
  });

  it("sem permissão do módulo, 403", async () => {
    for (const login of ["auditor_interno", "admin_ti", "consulta_progep"]) {
      const cli = await como(login);
      expect((await cli.get("/acidentes/fila", { seguir: false })).status, login).toBe(403);
      expect((await cli.get("/acidentes/comunicar", { seguir: false })).status, login).toBe(403);
    }
  });

  it("a fila não traz nome de ninguém", async () => {
    const { usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const cli = await como("coordenador_csso");
    const fila = await cli.get("/acidentes/fila");
    expect(fila.text).toContain(oc.protocolo);
    expect(fila.text).not.toContain("Titular Fictício");
    expect(fila.text).not.toContain("Testemunha Fictícia");
  });

  it("a fila filtra por situação e por protocolo", async () => {
    const { usuario } = await titular(db);
    const a = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const b = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados({ fatos: { ...dados().fatos, especie: "TRAJETO" } })));
    const cli = await como("coordenador_csso");
    const por_especie = await cli.get("/acidentes/fila?especie=TRAJETO");
    expect(por_especie.text).toContain(b.protocolo);
    expect(por_especie.text).not.toContain(a.protocolo);
    const por_protocolo = await cli.get(`/acidentes/fila?protocolo=${a.protocolo}`);
    expect(por_protocolo.text).toContain(a.protocolo);
    expect(por_protocolo.text).not.toContain(b.protocolo);
  });
});

describe("a triagem pelas telas", () => {
  async function comunicada() {
    const { usuario } = await titular(db);
    return db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
  }

  it("assumir, pedir complementação e o comunicante responde pela tela", async () => {
    const oc = await comunicada();
    const equipe = await como("tecnico_seguranca");
    const ficha = await equipe.get(`/acidentes/${oc.id}`);
    expect(ficha.text).toContain("Pedir complementação");
    expect((await equipe.post(`/acidentes/${oc.id}/assumir`, { versao: String(oc.versao) }, { seguir: false })).status).toBe(303);
    const [v2] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    expect(v2!.estado).toBe("EM_TRIAGEM");
    const r = await equipe.post(`/acidentes/${oc.id}/complementacao`, { versao: String(v2!.versao), pedido: "Qual era o equipamento?" }, { seguir: false });
    expect(r.status).toBe(303);

    const tit = await como("servidor_consulta");
    const minhas = await tit.get("/acidentes/minhas");
    expect(minhas.text).toContain("Responder à complementação");
    const tela = await tit.get(`/acidentes/${oc.id}/complementar`);
    expect(tela.text).toContain("Qual era o equipamento?");
    const resp = await tit.post(`/acidentes/${oc.id}/complementar`, { resposta: "Uma bandeja de inox." }, { seguir: false });
    expect(resp.status).toBe(303);
    const [v3] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    expect(v3!.estado).toBe("EM_TRIAGEM");
    expect(v3!.cat_sp_versao).toBe(2);
  });

  it("a tela velha recebe 409 e não grava", async () => {
    const oc = await comunicada();
    const equipe = await como("tecnico_seguranca");
    await equipe.post(`/acidentes/${oc.id}/assumir`, { versao: String(oc.versao) });
    const r = await equipe.post(`/acidentes/${oc.id}/estado`, { versao: String(oc.versao), destino: "EM_INVESTIGACAO" }, { seguir: false });
    expect(r.status).toBe(409);
    expect(r.text).toContain("alterada por outra pessoa");
    const [agora] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    expect(agora!.estado).toBe("EM_TRIAGEM");
  });

  it("cancelar sem motivo é 422 e o popup reabre com o erro", async () => {
    const oc = await comunicada();
    const equipe = await como("tecnico_seguranca");
    const r = await equipe.post(`/acidentes/${oc.id}/cancelar`, { versao: String(oc.versao), motivo: "" }, { seguir: false });
    expect(r.status).toBe(422);
    expect(r.text).toContain('id="cancelar" aria-labelledby="cancelar-titulo" open');
  });

  it("retificar pela tela gera a versão 2 sem mudar a situação", async () => {
    const oc = await comunicada();
    const equipe = await como("tecnico_seguranca");
    const r = await equipe.post(
      `/acidentes/${oc.id}/retificar`,
      { ...formulario(), local_especificacao: "Laboratório fictício, bancada 9", motivo: "Bancada informada errada", versao: String(oc.versao), data_evento: oc.data_evento },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [agora] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    expect(agora!.cat_sp_versao).toBe(2);
    expect(agora!.estado).toBe("RECEBIDA");
    expect(agora!.local_especificacao).toBe("Laboratório fictício, bancada 9");
  });

  it("o servidor comum não tria", async () => {
    const oc = await comunicada();
    const tit = await como("servidor_consulta");
    expect((await tit.post(`/acidentes/${oc.id}/assumir`, { versao: String(oc.versao) }, { seguir: false })).status).toBe(403);
  });
});

describe("o módulo seguro na produção (§4: até a F6 e a emenda da ROPA)", () => {
  it("acidentesLiberado: produção só com CSSO_MODULO_ACIDENTES=sim; fora dela, por padrão", async () => {
    const { acidentesLiberado } = await import("../src/config.js");
    expect(acidentesLiberado({ CSSO_AMBIENTE: "producao" })).toBe(false);
    expect(acidentesLiberado({ CSSO_AMBIENTE: "produção", CSSO_MODULO_ACIDENTES: "sim" })).toBe(true);
    expect(acidentesLiberado({ CSSO_AMBIENTE: "teste" })).toBe(true);
    expect(acidentesLiberado({ CSSO_AMBIENTE: "teste", CSSO_MODULO_ACIDENTES: "nao" })).toBe(false);
  });

  it("desligado, toda rota do módulo é 404, inclusive para a coordenação", async () => {
    process.env.CSSO_MODULO_ACIDENTES = "nao";
    try {
      const cli = await como("coordenador_csso");
      for (const caminho of ["/acidentes", "/acidentes/comunicar", "/acidentes/fila", "/acidentes/minhas", "/acidentes/1"]) {
        expect((await cli.get(caminho, { seguir: false })).status, caminho).toBe(404);
      }
      expect((await cli.post("/acidentes/comunicar", formulario(), { seguir: false })).status).toBe(404);
    } finally {
      delete process.env.CSSO_MODULO_ACIDENTES;
    }
  });
});
