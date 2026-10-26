/**
 * Etapa 2 dos duplicados (26/10/2026): o aviso "você já tem cadastro" leva os
 * botões «sou eu» / «não fui eu». A resposta é só um selo para a equipe: não
 * aceita a vaga, não acrescenta o e-mail digitado e só confirma o e-mail do
 * cadastro que recebeu o aviso.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as aviso_cadastro from "../src/servicos/aviso_cadastro_existente.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as servico_participante from "../src/servicos/participante.js";
import { bancoLimpo, contas, entrar, naTransacao, type Cliente } from "./ajuda";

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
};
const INICIO = somar_dias(hoje_iso(), 30);
const TURMA = {
  data_inicio: INICIO,
  data_fim: somar_dias(INICIO, 1),
  local: "Auditório do Campus JK",
  frequencia_minima_percentual: "75",
};
const PEDIDO_SERVIDOR = {
  nome: "Maria Souza",
  vinculo: "SERVIDOR",
  siape: "1110654",
  email: "atacante@exemplo.com",
  organizacao: "",
  consentimento: "sim",
};

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
  inscricao_publica.tempo_de_resposta.piso_ms = 0;
  inscricao_publica.tempo_de_resposta.variacao_ms = 0;
});

async function _com_link(): Promise<string> {
  await entrar(cliente, "coordenador_csso");
  const r0 = await cliente.post("/treinamentos/catalogo", NR35, { seguir: false });
  expect(r0.status, r0.text.slice(0, 300)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, NR35.codigo));
  const r1 = await cliente.post("/turmas", { treinamento_id: String(t!.id), ...TURMA }, { seguir: false });
  expect(r1.status, r1.text.slice(0, 300)).toBe(303);
  const [turma] = await db.select().from(e.turma);
  await db
    .update(e.turma)
    .set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(hoje_iso(), 10) })
    .where(eq(e.turma.id, turma!.id));
  const r = await cliente.post(`/turmas/${turma!.id}/link-publico`, {});
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]!;
}

/** O servidor da base, o pedido casado pelo SIAPE e o token que foi no aviso. */
async function _pedido_avisado(): Promise<{ token_inscricao: string; token: string; corpo: string }> {
  const token_inscricao = await _com_link();
  await db.insert(e.servidor).values({ siape: "1110654", nome: "Maria Aparecida Souza Lima", email: "maria.lima@ufvjm.edu.br" });
  const r = await novoCliente().post(`/inscricao/${token_inscricao}`, PEDIDO_SERVIDOR, { seguir: false });
  expect(r.status).toBe(303);
  const [aviso] = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, aviso_cadastro.TIPO_AVISO));
  expect(aviso, "o aviso deveria estar na fila").toBeDefined();
  const corpo = aviso!.corpo ?? "";
  const token = corpo.match(/\/aviso-cadastro\/([A-Za-z0-9_-]+)/)?.[1];
  expect(token, corpo).toBeDefined();
  return { token_inscricao, token: token!, corpo };
}

describe("o aviso leva os botões", () => {
  it("o e-mail traz o link e o nome do treinamento, e nada do que foi digitado nem a turma", async () => {
    const { corpo, token } = await _pedido_avisado();
    expect(corpo).toContain("Trabalho em Altura — NR-35");
    expect(corpo).toContain(`/aviso-cadastro/${token}`);
    for (const proibido of ["Maria", "Souza", "1110654", "atacante", "PTC-", "TUR-", "Auditório"]) {
      expect(corpo, proibido).not.toContain(proibido);
    }
    // só o hash do token fica no banco
    const [linha] = await db.select().from(e.aviso_cadastro);
    expect(linha!.token_hash).toHaveLength(64);
    expect(linha!.token_hash).not.toContain(token);
    expect(linha!.resposta).toBeNull();
  });

  it("abrir o link não responde; a página mostra os dois botões e só o treinamento", async () => {
    const { token } = await _pedido_avisado();
    const r = await novoCliente().get(`/aviso-cadastro/${token}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Trabalho em Altura");
    expect(r.text).toContain('value="SOU_EU"');
    expect(r.text).toContain('value="NAO_FUI_EU"');
    for (const proibido of ["Maria", "1110654", "atacante", "PTC-"]) expect(r.text, proibido).not.toContain(proibido);
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect((await db.select().from(e.aviso_cadastro))[0]!.resposta).toBeNull();
  });
});

describe("«sim, fui eu»", () => {
  it("grava o selo e confirma o e-mail do cadastro, sem aceitar a vaga nem acrescentar o e-mail digitado", async () => {
    const { token, token_inscricao } = await _pedido_avisado();
    void token_inscricao;
    const [antes] = await db.select().from(e.participante_email).where(eq(e.participante_email.email_normalizado, "maria.lima@ufvjm.edu.br"));
    expect(antes!.confirmado_em).toBeNull();
    const r = await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Obrigado, anotamos");

    const [aviso] = await db.select().from(e.aviso_cadastro);
    expect(aviso!.resposta).toBe("SOU_EU");
    const [depois] = await db.select().from(e.participante_email).where(eq(e.participante_email.id, antes!.id));
    expect(depois!.confirmado_em).not.toBeNull();
    // o e-mail digitado pelo visitante NUNCA entra no cadastro
    const emails = (await db.select().from(e.participante_email)).map((m) => m.email_normalizado);
    expect(emails).not.toContain("atacante@exemplo.com");
    // a vaga continua com a equipe
    const [pedido] = await db.select().from(e.inscricao);
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");
    // a trilha diz o fato, sem endereço
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "AVISO_CADASTRO_RESPONDIDO"));
    expect(ev!.descricao).toContain("«sou eu»");
    expect(ev!.descricao).not.toContain("@");
  });

  it("a equipe vê o selo na conferência, e o pedido continua a conferir", async () => {
    const { token } = await _pedido_avisado();
    expect((await cliente.get("/turmas/pedidos")).text).not.toContain("disse «sou eu»");
    await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    const tela = (await cliente.get("/turmas/pedidos")).text;
    expect(tela).toContain("o titular do cadastro disse «sou eu»");
  });
});

describe("«não fui eu»", () => {
  it("grava o selo, não confirma e-mail nem recusa o pedido sozinho", async () => {
    const { token } = await _pedido_avisado();
    const r = await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "NAO_FUI_EU" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("não foi você");
    const [aviso] = await db.select().from(e.aviso_cadastro);
    expect(aviso!.resposta).toBe("NAO_FUI_EU");
    const confirmados = (await db.select().from(e.participante_email)).filter((m) => m.confirmado_em !== null);
    expect(confirmados).toHaveLength(0);
    const [pedido] = await db.select().from(e.inscricao);
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");
    const tela = (await cliente.get("/turmas/pedidos")).text;
    expect(tela).toContain("o titular do cadastro disse «não fui eu»");
    expect(tela).toContain("o titular do cadastro disse que não pediu");
  });

  it("a primeira resposta vale: o outro botão depois devolve o que ficou", async () => {
    const { token } = await _pedido_avisado();
    await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "NAO_FUI_EU" });
    const r = await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    expect(r.text).toContain("não foi você");
    expect((await db.select().from(e.aviso_cadastro))[0]!.resposta).toBe("NAO_FUI_EU");
    // e o e-mail NÃO foi confirmado pelo «sou eu» que não valeu
    expect((await db.select().from(e.participante_email)).filter((m) => m.confirmado_em !== null)).toHaveLength(0);
  });

  it("«não fui eu» pesa mais que «sou eu» no selo, se houver dois avisos do mesmo pedido", async () => {
    const { token } = await _pedido_avisado();
    const [pedido] = await db.select().from(e.inscricao);
    const [primeiro] = await db.select().from(e.aviso_cadastro);
    await db.insert(e.aviso_cadastro).values({
      participante_id: primeiro!.participante_id,
      inscricao_id: pedido!.id,
      email_id: primeiro!.email_id,
      token_hash: "a".repeat(64),
      expira_em: new Date(Date.now() + 86_400_000),
      resposta: "NAO_FUI_EU",
      respondida_em: new Date(),
    });
    await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    const selos = await naTransacao((tx) => aviso_cadastro.selos(tx, [pedido!.id]));
    expect(selos.get(pedido!.id)).toBe("NAO_FUI_EU");
  });
});

describe("link que não vale", () => {
  it("token desconhecido e token vencido são o mesmo 404", async () => {
    const { token } = await _pedido_avisado();
    const desconhecido = await novoCliente().get("/aviso-cadastro/naoexiste123");
    expect(desconhecido.status).toBe(404);
    await db.update(e.aviso_cadastro).set({ expira_em: new Date(Date.now() - 1000) });
    const vencido = await novoCliente().get(`/aviso-cadastro/${token}`);
    expect(vencido.status).toBe(404);
    const resposta = await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    expect(resposta.status).toBe(404);
    expect((await db.select().from(e.aviso_cadastro))[0]!.resposta).toBeNull();
  });

  it("resposta fora dos dois botões é recusada e nada é gravado", async () => {
    const { token } = await _pedido_avisado();
    const r = await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "TALVEZ" });
    expect(r.status).toBe(422);
    expect((await db.select().from(e.aviso_cadastro))[0]!.resposta).toBeNull();
  });

  it("e-mail que passou a ser de dois cadastros não é confirmado pelo «sou eu»", async () => {
    const { token } = await _pedido_avisado();
    const [aviso] = await db.select().from(e.aviso_cadastro);
    const [alvo] = await db.select().from(e.participante_email).where(eq(e.participante_email.id, aviso!.email_id!));
    // outro cadastro passa a ter o mesmo endereço, sem confirmação
    await naTransacao((tx) =>
      servico_participante.criar_externo(tx, {
        nome: "Outra Pessoa Qualquer",
        vinculo: "TERCEIRIZADO",
        email: alvo!.email,
        organizacao: "Empresa X",
      }),
    );
    await novoCliente().post(`/aviso-cadastro/${token}`, { resposta: "SOU_EU" });
    expect((await db.select().from(e.aviso_cadastro))[0]!.resposta).toBe("SOU_EU");
    expect((await db.select().from(e.participante_email)).filter((m) => m.confirmado_em !== null)).toHaveLength(0);
  });
});
