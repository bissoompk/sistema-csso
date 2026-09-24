/**
 * Fatia 2 de Certificados e Treinamentos: turma, participante e inscrição.
 * Porte de `testes/integracao/test_turmas.py`.
 *
 * Os testes exercitam o cenário do usuário pela porta da frente (HTTP) sempre
 * que possível. Onde a granularidade da permissão não existe em nenhum perfil
 * real, o teste monta o `UsuarioAtual` à mão e chama o serviço, que é onde a
 * recusa mora.
 *
 * O `banco` do pytest era um banco novo POR TESTE, e várias asserções contam
 * com isso (`select(Turma).scalar_one()`, o código TUR-AAAA-0001). Aqui cada
 * teste chama `bancoLimpo()` no `beforeEach` — é um CREATE DATABASE TEMPLATE,
 * barato.
 */
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { Participante as P } from "../src/dominio/treinamento.js";
import { agora_utc } from "../src/db/esquema/base.js";
import type { Banco } from "../src/db/cliente.js";
import * as numeracao from "../src/servicos/numeracao.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_turma from "../src/servicos/turma.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, naTransacao, type Campos, type Cliente, type Resposta } from "./ajuda";

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
};

// datas relativas a hoje: "não se abre inscrição para turma que já terminou"
// tornaria um literal um teste que falha no ano que vem
const INICIO = somar_dias(hoje_iso(), 30);
const FIM = somar_dias(INICIO, 2);
const ANO = Number(INICIO.slice(0, 4));
const PRIMEIRA = `TUR-${ANO}-0001`;
const SEGUNDA = `TUR-${ANO}-0002`;
const comAno = (d: string, ano: number) => `${ano}${d.slice(4)}`;
const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const TURMA = {
  data_inicio: INICIO,
  data_fim: FIM,
  local: "Auditório do Campus JK",
  frequencia_minima_percentual: "75",
};

// =====================================================================
// Montagem
// =====================================================================
let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

// a primeira chamada, na coleta, registra o `afterAll` que apaga TODOS os
// bancos que este arquivo criar
await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});

async function _criar_treinamento(c: Cliente, dados: Record<string, string> = {}): Promise<number> {
  const r = await c.post("/treinamentos/catalogo", { ...NR35, ...dados }, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const codigo = dados.codigo ?? NR35.codigo;
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo));
  return t!.id;
}

function _criar_turma(c: Cliente, treinamento_id: number, dados: Campos = {}) {
  return c.post("/turmas", { treinamento_id: String(treinamento_id), ...TURMA, ...dados }, { seguir: false });
}

async function _id_da_turma(codigo = PRIMEIRA): Promise<number> {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.codigo, codigo));
  return t!.id;
}

async function _turma(id: number) {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!;
}

/** Coordenador logado, um treinamento no catálogo e a primeira turma aberta. */
async function turma_aberta() {
  await entrar(cliente, "coordenador_csso");
  const treinamento_id = await _criar_treinamento(cliente);
  expect((await _criar_turma(cliente, treinamento_id)).status).toBe(303);
  return { treinamento_id, turma_id: await _id_da_turma() };
}

async function _criar_servidor(siape = "1110654", nome = "Marco Antônio Alves Schetino", email: string | null = null) {
  const [s] = await db.insert(e.servidor).values({ siape, nome, email }).returning();
  return s!.id;
}

/** Um `UsuarioAtual` com exatamente estas permissões, e a linha de `usuario`. */
async function _usuario_com(permissoes: string[], login = "operador"): Promise<UsuarioAtual> {
  const [u] = await db
    .insert(e.usuario)
    .values({
      login,
      nome: "Operador de teste",
      email: `${login}@teste.ufvjm.edu.br`,
      senha_hash: "nao-usado-neste-teste",
      precisa_trocar_senha: false,
    })
    .returning();
  return new UsuarioAtual({ id: u!.id, login, nome: "Operador de teste", permissoes, perfis: ["coordenador_csso"] });
}

/** O texto da página onde o aviso é renderizado, venha por 200 ou por 303. */
async function _mensagem(c: Cliente, resposta: Resposta): Promise<string> {
  if (resposta.status === 200) return resposta.text;
  expect(resposta.status, resposta.text.slice(0, 500)).toBe(303);
  return (await c.get(resposta.location!)).text;
}

/** O HTML escapa o apóstrofo e as aspas; a asserção compara o texto. */
function _texto(html: string): string {
  return html
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function _msg(c: Cliente, resposta: Resposta): Promise<string> {
  return _texto(await _mensagem(c, resposta));
}

async function _turmas() {
  return db.select().from(e.turma).orderBy(asc(e.turma.id));
}
async function _inscricoes() {
  return db.select().from(e.inscricao).orderBy(asc(e.inscricao.id));
}
async function _participantes() {
  return db.select().from(e.participante).orderBy(asc(e.participante.id));
}

// =====================================================================
// Numeração — RN-03 generalizada
// =====================================================================
describe("numeração", () => {
  it("turma recebe número sequencial por ano", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    await _criar_turma(cliente, treinamento_id);
    await _criar_turma(cliente, treinamento_id);
    const seguinte = comAno(INICIO, ANO + 1);
    await _criar_turma(cliente, treinamento_id, { data_inicio: seguinte, data_fim: seguinte });
    expect((await _turmas()).map((t) => t.codigo)).toEqual([PRIMEIRA, SEGUNDA, `TUR-${ANO + 1}-0001`]);
  });

  it("pula número já gravado", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const ja_numerada = `${ANO}-01-05`;
    await db.insert(e.turma).values({
      treinamento_id,
      numero: 1,
      ano: ANO,
      codigo: PRIMEIRA,
      data_inicio: ja_numerada,
      data_fim: ja_numerada,
      frequencia_minima_percentual: "75",
    });
    expect((await _criar_turma(cliente, treinamento_id)).status).toBe(303);
    const [nova] = await db.select().from(e.turma).where(eq(e.turma.data_inicio, INICIO));
    expect(nova!.numero).toBe(2);
    expect(nova!.codigo).toBe(SEGUNDA);
  });

  it("a numeração do parecer continua igual", async () => {
    await naTransacao(async (tx) => {
      expect(await numeracao.proximo_numero_parecer(tx, 2026)).toBe(1);
      expect(await numeracao.proximo_numero_parecer(tx, 2026)).toBe(2);
      expect(await numeracao.proximo_numero_parecer(tx, 2025)).toBe(1);
    });
  });

  it("recusa tabela fora da lista", async () => {
    await expect(
      naTransacao((tx) => numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "usuario", tabela_alvo: "usuario" })),
    ).rejects.toBeInstanceOf(numeracao.SequenciaDesconhecida);
    await expect(
      naTransacao((tx) =>
        numeracao.proximo_numero(tx, 2026, { tabela_sequencia: "turma_sequencia", tabela_alvo: "parecer_tecnico" }),
      ),
    ).rejects.toBeInstanceOf(numeracao.SequenciaDesconhecida);
    await expect(
      naTransacao((tx) =>
        numeracao.proximo_numero(tx, 2026, {
          tabela_sequencia: "turma_sequencia",
          tabela_alvo: "turma",
          coluna: "id; DROP TABLE turma",
        }),
      ),
    ).rejects.toBeInstanceOf(numeracao.SequenciaDesconhecida);
  });
});

// =====================================================================
// Turma — abertura
// =====================================================================
describe("abertura de turma", () => {
  it("abrir turma pela tela", async () => {
    const { turma_id } = await turma_aberta();
    const turma = (await servico_turma.carregar_turma(db, turma_id))!;
    expect(turma.codigo).toBe(PRIMEIRA);
    expect(turma.situacao).toBe("PLANEJADA");
    expect(turma.local).toBe("Auditório do Campus JK");
    // a carga da turma vazia significa "usa a do catálogo", e não zero
    expect(turma.carga_horaria_horas).toBeNull();
    expect(Number(turma.carga_horaria_horas || turma.treinamento.carga_horaria_horas)).toBe(8);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'turma' AND ${e.historico_evento.tipo_evento} = 'TURMA_CRIADA'`);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain(PRIMEIRA);
    expect((await cliente.get("/turmas")).text).toContain(PRIMEIRA);
  });

  it("o ano da turma vem do início", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const seguinte = `${ANO + 1}-01-11`;
    await _criar_turma(cliente, treinamento_id, { data_inicio: seguinte, data_fim: seguinte });
    const turmas = await _turmas();
    expect(turmas).toHaveLength(1);
    expect([turmas[0]!.ano, turmas[0]!.codigo]).toEqual([ANO + 1, `TUR-${ANO + 1}-0001`]);
  });

  it("turma de treinamento inativo é recusada", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    // sem `ativo` marcado: o catálogo desativa
    await cliente.post(
      `/treinamentos/catalogo/${treinamento_id}`,
      { nome: NR35.nome, carga_horaria_horas: "8", validade_meses: "24" },
      { seguir: false },
    );
    const texto = await _msg(cliente, await _criar_turma(cliente, treinamento_id));
    expect(texto).toContain("está inativo no catálogo");
    expect(await _turmas()).toHaveLength(0);
  });

  it("data fim antes do início é recusada", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const texto = await _msg(cliente, await _criar_turma(cliente, treinamento_id, { data_inicio: FIM, data_fim: INICIO }));
    expect(texto).toContain("não pode ser anterior ao início");
  });

  it("data em branco não vira hoje", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const texto = await _msg(cliente, await _criar_turma(cliente, treinamento_id, { data_inicio: "" }));
    expect(texto).toContain("Informe a data de início");
    expect(await _turmas()).toHaveLength(0);
  });

  it("vagas e nota fora da faixa são recusadas", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    expect(await _msg(cliente, await _criar_turma(cliente, treinamento_id, { vagas: "0" }))).toContain("maior que zero");
    expect(await _msg(cliente, await _criar_turma(cliente, treinamento_id, { nota_minima_aprovacao: "11" }))).toContain(
      "entre 0 e 10",
    );
  });
});

// =====================================================================
// Turma — edição
// =====================================================================
describe("edição de turma", () => {
  it("registra diff campo a campo", async () => {
    const { turma_id } = await turma_aberta();
    const r = await cliente.post(`/turmas/${turma_id}`, { ...TURMA, local: "Sala 3 do IECT", vagas: "20" }, { seguir: false });
    expect(r.status).toBe(303);
    const turma = await _turma(turma_id);
    expect([turma.local, turma.vagas]).toEqual(["Sala 3 do IECT", 20]);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'turma' AND ${e.historico_evento.tipo_evento} = 'CAMPO_ALTERADO'`);
    const diffs = Object.fromEntries(eventos.map((ev) => [ev.campo, [ev.valor_anterior, ev.valor_novo]]));
    expect(diffs.local).toEqual(["Auditório do Campus JK", "Sala 3 do IECT"]);
    expect(diffs).toHaveProperty("vagas");
    // campo que não mudou não vira evento
    expect(diffs).not.toHaveProperty("data_inicio");
  });

  it("adiar a turma para outro ano é recusado", async () => {
    const { turma_id } = await turma_aberta();
    const texto = await _msg(
      cliente,
      await cliente.post(
        `/turmas/${turma_id}`,
        { ...TURMA, data_inicio: comAno(INICIO, ANO + 1), data_fim: comAno(FIM, ANO + 1) },
        { seguir: false },
      ),
    );
    expect(texto).toContain("Cancele esta turma e abra outra");
    expect((await _turma(turma_id)).data_inicio).toBe(INICIO);
  });

  it("turma cancelada não se edita", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}/situacao`, { destino: "CANCELADA", motivo: "instrutor adoeceu" }, { seguir: false });
    const texto = await _msg(cliente, await cliente.post(`/turmas/${turma_id}`, { ...TURMA, local: "outro lugar" }, { seguir: false }));
    expect(texto).toContain("não se edita");
    expect((await _turma(turma_id)).local).toBe("Auditório do Campus JK");
  });

  it("reduzir vagas para menos que os inscritos", async () => {
    const { turma_id } = await turma_aberta();
    for (const [siape, nome] of [
      ["1110654", "Marco Antônio"],
      ["2165804", "Fabrício Andrade"],
    ]) {
      const servidor_id = await _criar_servidor(siape, nome);
      await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(servidor_id) }, { seguir: false });
    }
    const texto = await _msg(cliente, await cliente.post(`/turmas/${turma_id}`, { ...TURMA, vagas: "1" }, { seguir: false }));
    expect(texto).toContain("deixaria gente inscrita fora da conta");
  });
});

// =====================================================================
// Máquina E — a turma
// =====================================================================
describe("máquina E", () => {
  const passar = (turma_id: number, destino: string, motivo?: string) =>
    cliente.post(`/turmas/${turma_id}/situacao`, motivo ? { destino, motivo } : { destino }, { seguir: false });

  it("caminho feliz da turma", async () => {
    const { turma_id } = await turma_aberta();
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"]) {
      expect((await passar(turma_id, destino)).status).toBe(303);
      expect((await _turma(turma_id)).situacao).toBe(destino);
    }
    expect((await _turma(turma_id)).concluida_em).not.toBeNull();
    const estados = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'turma' AND ${e.historico_evento.campo} = 'situacao'`)
      .orderBy(asc(e.historico_evento.id));
    expect(estados.map((ev) => [ev.valor_anterior, ev.valor_novo])).toEqual([
      ["PLANEJADA", "INSCRICOES_ABERTAS"],
      ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"],
      ["EM_ANDAMENTO", "CONCLUIDA"],
    ]);
  });

  it("fechar inscrições sem cancelar a turma", async () => {
    const { turma_id } = await turma_aberta();
    await passar(turma_id, "INSCRICOES_ABERTAS");
    await passar(turma_id, "PLANEJADA");
    expect((await _turma(turma_id)).situacao).toBe("PLANEJADA");
  });

  it("pular de planejada para concluída é recusado", async () => {
    const { turma_id } = await turma_aberta();
    expect(await _msg(cliente, await passar(turma_id, "CONCLUIDA"))).toContain("Transição proibida");
    expect((await _turma(turma_id)).situacao).toBe("PLANEJADA");
  });

  it("cancelar sem motivo é recusado", async () => {
    const { turma_id } = await turma_aberta();
    expect(await _msg(cliente, await passar(turma_id, "CANCELADA"))).toContain("exige o motivo");
    expect((await _turma(turma_id)).situacao).toBe("PLANEJADA");
  });

  it("concluir leva à confirmação e não executa no primeiro clique", async () => {
    const { turma_id } = await turma_aberta();
    const servidor_id = await _criar_servidor();
    await passar(turma_id, "INSCRICOES_ABERTAS");
    await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(servidor_id) }, { seguir: false });
    await passar(turma_id, "EM_ANDAMENTO");
    const ficha = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(ficha, "o botão de concluir ainda executa").toContain('href="#concluir-turma"');
    expect(ficha).toContain('id="concluir-turma"');
    expect(ficha, "a confirmação não diz quantos").toContain("apura 1 inscrito(s)");
    expect(ficha).toContain("não tem volta");
    expect((await _turma(turma_id)).situacao, "concluiu sozinha").toBe("EM_ANDAMENTO");
  });

  it("a confirmação de concluir some quando não há para onde ir", async () => {
    const { turma_id } = await turma_aberta();
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"]) await passar(turma_id, destino);
    const ficha = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(ficha).not.toContain('id="concluir-turma"');
    expect(ficha).toContain("é situação final");
  });

  it("turma concluída é terminal", async () => {
    const { turma_id } = await turma_aberta();
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"]) await passar(turma_id, destino);
    expect(await _msg(cliente, await passar(turma_id, "EM_ANDAMENTO"))).toContain("Transição proibida");
    expect((await _turma(turma_id)).situacao).toBe("CONCLUIDA");
  });

  it("turma cancelada é terminal", async () => {
    const { turma_id } = await turma_aberta();
    await passar(turma_id, "CANCELADA", "sem quórum");
    expect(await _msg(cliente, await passar(turma_id, "PLANEJADA"))).toContain("Transição proibida");
    const turma = await _turma(turma_id);
    expect([turma.situacao, turma.motivo_cancelamento]).toEqual(["CANCELADA", "sem quórum"]);
  });

  it("abrir inscrição de turma que já terminou é recusado", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const ontem = somar_dias(hoje_iso(), -30);
    await _criar_turma(cliente, treinamento_id, { data_inicio: ontem, data_fim: ontem });
    const [turma] = await _turmas();
    expect(await _msg(cliente, await passar(turma!.id, "INSCRICOES_ABERTAS"))).toContain("não há como abrir inscrição");
  });

  it("concluir exige permissão própria", async () => {
    const { turma_id } = await turma_aberta();
    const operador = await _usuario_com(["turma.criar", "turma.inscrever"]);
    const turma = (await servico_turma.carregar_turma(db, turma_id))!;
    await servico_turma.mudar_situacao(db, operador, turma, "INSCRICOES_ABERTAS");
    await servico_turma.mudar_situacao(db, operador, turma, "EM_ANDAMENTO");
    const erro = await servico_turma.mudar_situacao(db, operador, turma, "CONCLUIDA").catch((x) => x);
    expect(erro).toBeInstanceOf(PermissaoNegada);
    expect((erro as PermissaoNegada).codigo).toBe("turma.concluir");
    await expect(
      servico_turma.mudar_situacao(db, operador, turma, "CANCELADA", { motivo: "qualquer" }),
    ).rejects.toBeInstanceOf(PermissaoNegada);
  });
});

// =====================================================================
// Instrutores da turma
// =====================================================================
async function _criar_assinatura(c: Cliente, nome = "Fabrício Raimundi Andrade", inicio = "2020-01-01", fim = "") {
  const r = await c.post(
    "/treinamentos/assinaturas",
    { nome, externo: "1", titulo: "Eng. Seg. do Trabalho", vigencia_inicio: inicio, vigencia_fim: fim },
    { seguir: false },
  );
  expect(r.status).toBe(303);
  const [a] = await db.select().from(e.assinatura_instrutor).where(eq(e.assinatura_instrutor.nome, nome));
  return a!.id;
}

describe("instrutores da turma", () => {
  it("vincular e desvincular instrutor", async () => {
    const { turma_id } = await turma_aberta();
    const instrutor_id = await _criar_assinatura(cliente);
    const r = await cliente.post(
      `/turmas/${turma_id}/instrutores`,
      { assinatura_instrutor_id: String(instrutor_id), assina_certificado: "1" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    let turma = (await servico_turma.carregar_turma(db, turma_id))!;
    expect(turma.instrutores.map((v) => v.instrutor.nome)).toEqual(["Fabrício Raimundi Andrade"]);
    expect(turma.instrutores[0]!.assina_certificado).toBe(true);

    await cliente.post(
      `/turmas/${turma_id}/instrutores`,
      { assinatura_instrutor_id: String(instrutor_id), remover: "1" },
      { seguir: false },
    );
    turma = (await servico_turma.carregar_turma(db, turma_id))!;
    expect(turma.instrutores).toEqual([]);
  });

  it("instrutor repetido é recusado", async () => {
    const { turma_id } = await turma_aberta();
    const instrutor_id = await _criar_assinatura(cliente);
    await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) }, { seguir: false });
    const texto = await _msg(
      cliente,
      await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) }, { seguir: false }),
    );
    expect(texto).toContain("já é instrutor desta turma");
  });

  it("instrutor fora de vigência é recusado", async () => {
    const { turma_id } = await turma_aberta();
    const instrutor_id = await _criar_assinatura(cliente, "Antiga Instrutora", "2019-01-01", "2024-12-31");
    const texto = await _msg(
      cliente,
      await cliente.post(`/turmas/${turma_id}/instrutores`, { assinatura_instrutor_id: String(instrutor_id) }, { seguir: false }),
    );
    expect(texto).toContain(`não vigora em ${br(INICIO)}`);
    // e nem chega a ser oferecida na tela
    expect((await cliente.get(`/turmas/${turma_id}`)).text).not.toContain("Antiga Instrutora");
  });
});

// =====================================================================
// Participante — o ponteiro, o externo e o e-mail
// =====================================================================
describe("participante", () => {
  it("servidor vira ponteiro e nunca copia o nome", async () => {
    const { turma_id } = await turma_aberta();
    const servidor_id = await _criar_servidor();
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(servidor_id) }, { seguir: false });
    expect(r.status).toBe(303);
    const [linha] = await _participantes();
    const pessoa = (await servico_participante.carregar(db, linha!.id))!;
    expect(pessoa.servidor_id).toBe(servidor_id);
    expect(pessoa.nome).toBeNull();
    expect(pessoa.vinculo).toBe("SERVIDOR");
    expect(P.nome_exibicao(pessoa)).toBe("Marco Antônio Alves Schetino");
    // corrigir o cadastro corrige a exibição, porque não há cópia
    await db.update(e.servidor).set({ nome: "Marco Antônio A. Schetino" }).where(eq(e.servidor.id, servidor_id));
    expect(P.nome_exibicao((await servico_participante.carregar(db, linha!.id))!)).toBe("Marco Antônio A. Schetino");
  });

  it("o mesmo servidor não vira dois participantes", async () => {
    const { treinamento_id, turma_id } = await turma_aberta();
    const servidor_id = await _criar_servidor();
    await _criar_turma(cliente, treinamento_id);
    const outra_id = await _id_da_turma(SEGUNDA);
    for (const id of [turma_id, outra_id]) {
      await cliente.post(`/turmas/${id}/inscricoes`, { servidor_id: String(servidor_id) }, { seguir: false });
    }
    expect(await _participantes()).toHaveLength(1);
    expect(await _inscricoes()).toHaveLength(2);
  });

  it("externo recebe identificador público opaco", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(
      `/turmas/${turma_id}/inscricoes`,
      { nome: "Maria Aparecida de Souza", vinculo: "TERCEIRIZADO", organizacao: "Limpeza Ltda", email: "maria@exemplo.com.br" },
      { seguir: false },
    );
    const lista = await _participantes();
    expect(lista).toHaveLength(1);
    const pessoa = (await servico_participante.carregar(db, lista[0]!.id))!;
    expect(pessoa.identificador_publico).toMatch(/^PTC-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(pessoa.nome).toBe("Maria Aparecida de Souza");
    expect(pessoa.servidor_id).toBeNull();
    expect(P.nome_exibicao(pessoa)).toBe("Maria Aparecida de Souza");
  });

  it("não há coluna de CPF em nenhuma tabela nova", async () => {
    for (const tabela of ["participante", "participante_email", "turma", "inscricao"]) {
      const colunas = (await db.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tabela}`,
      )) as unknown as { column_name: string }[];
      expect(colunas.length, tabela).toBeGreaterThan(0);
      expect(colunas.some((c) => c.column_name.toLowerCase().includes("cpf")), tabela).toBe(false);
    }
  });

  it("cadastrar externo com vínculo de servidor é recusado", async () => {
    const { turma_id } = await turma_aberta();
    const texto = await _msg(
      cliente,
      await cliente.post(`/turmas/${turma_id}/inscricoes`, { nome: "Alguém", vinculo: "SERVIDOR" }, { seguir: false }),
    );
    expect(texto).toContain("entra pelo cadastro de servidor");
    expect(await _participantes()).toHaveLength(0);
  });

  it("e-mail inválido não deixa participante gravado", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(
      `/turmas/${turma_id}/inscricoes`,
      { nome: "Alguém", vinculo: "VISITANTE", email: "sem-arroba" },
      { seguir: false },
    );
    expect(await _participantes()).toHaveLength(0);
    expect(await _inscricoes()).toHaveLength(0);
  });

  it("e-mail normalizado nasce do e-mail bruto", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(
      `/turmas/${turma_id}/inscricoes`,
      { nome: "Maria Aparecida de Souza", vinculo: "VISITANTE", email: "  Maria.Souza@UFVJM.EDU.BR  " },
      { seguir: false },
    );
    const enderecos = await db.select().from(e.participante_email);
    expect(enderecos).toHaveLength(1);
    expect(enderecos[0]!.email).toBe("Maria.Souza@UFVJM.EDU.BR");
    expect(enderecos[0]!.email_normalizado).toBe("maria.souza@ufvjm.edu.br");
    expect(enderecos[0]!.confirmado_em).toBeNull();
  });

  it("e-mail inválido é recusado", async () => {
    const { turma_id } = await turma_aberta();
    const texto = await _msg(
      cliente,
      await cliente.post(
        `/turmas/${turma_id}/inscricoes`,
        { nome: "Alguém", vinculo: "VISITANTE", email: "sem-arroba" },
        { seguir: false },
      ),
    );
    expect(texto).toContain("E-mail invalido");
  });

  it("inscrição recusada não deixa participante órfão", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, vagas: "1" }, { seguir: false });
    await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(await _criar_servidor()) }, { seguir: false });
    const texto = await _msg(
      cliente,
      await cliente.post(
        `/turmas/${turma_id}/inscricoes`,
        { nome: "Maria Aparecida de Souza", vinculo: "TERCEIRIZADO", email: "maria@exemplo.com.br" },
        { seguir: false },
      ),
    );
    expect(texto).toContain("não tem vaga");
    // só o ponteiro do servidor que entrou
    expect((await _participantes()).map((p) => p.nome)).toEqual([null]);
    expect(await db.select().from(e.participante_email)).toEqual([]);
  });

  it("dois e-mails da mesma pessoa reconciliam o histórico", async () => {
    const { treinamento_id, turma_id: primeira } = await turma_aberta();
    await cliente.post(
      `/turmas/${primeira}/inscricoes`,
      { nome: "Maria Aparecida de Souza", vinculo: "DISCENTE", email: "maria@gmail.com" },
      { seguir: false },
    );
    await _criar_turma(cliente, treinamento_id);
    const segunda = await _id_da_turma(SEGUNDA);
    const [pessoa_linha] = await _participantes();
    const pessoa_id = pessoa_linha!.id;
    // inscrever a MESMA pessoa com o endereço novo acrescenta o endereço
    await cliente.post(
      `/turmas/${segunda}/inscricoes`,
      { participante_id: String(pessoa_id), email: "maria@ufvjm.edu.br" },
      { seguir: false },
    );
    const pessoas = await _participantes();
    expect(pessoas).toHaveLength(1);
    const carregada = (await servico_participante.carregar(db, pessoas[0]!.id))!;
    expect(carregada.emails.map((x) => x.email_normalizado).sort()).toEqual(["maria@gmail.com", "maria@ufvjm.edu.br"]);
    // a busca por qualquer um dos dois devolve a mesma pessoa; `certificado.ver`
    // porque endereço é identificação nominal (RN-19)
    const quem_inscreve = await _usuario_com(["certificado.ver"], "reconciliador");
    const por_pessoal = await servico_participante.por_email(db, "MARIA@gmail.com");
    const por_institucional = await servico_participante.por_email(db, "maria@ufvjm.edu.br");
    expect(por_pessoal!.id).toBe(pessoa_id);
    expect(por_institucional!.id).toBe(pessoa_id);
    expect(await servico_participante.buscar(db, "maria@ufvjm.edu.br", quem_inscreve)).toHaveLength(1);
  });

  it("e-mail confirmado pertence a um participante só", async () => {
    const [um, outro] = await naTransacao(async (tx) => [
      await servico_participante.criar_externo(tx, { nome: "Maria A. de Souza", vinculo: "VISITANTE", email: "maria@x.com" }),
      await servico_participante.criar_externo(tx, { nome: "Maria Aparecida", vinculo: "VISITANTE", email: "maria@x.com" }),
    ]);
    // duas linhas NÃO confirmadas convivem: é o sinal da duplicata
    expect(um.id).not.toBe(outro.id);
    await naTransacao((tx) => servico_participante.registrar_email(tx, um, "maria@x.com", { confirmado_em: agora_utc() }));
    // o segundo bate no índice parcial: posse de caixa não se divide
    // o IntegrityError do Python: o Drizzle embrulha o erro do Postgres em `cause`
    const erro = await naTransacao((tx) =>
      servico_participante.registrar_email(tx, outro, "maria@x.com", { confirmado_em: agora_utc() }),
    ).catch((x) => x);
    expect(erro).toBeInstanceOf(Error);
    expect(String((erro as { cause?: unknown }).cause ?? erro)).toMatch(/uq_email_confirmado/);
  });
});

// =====================================================================
// Inscrição — máquina F
// =====================================================================
describe("inscrição — máquina F", () => {
  const inscrever = (turma_id: number, dados: Campos) => cliente.post(`/turmas/${turma_id}/inscricoes`, dados, { seguir: false });
  const mudar = (turma_id: number, inscricao_id: number, dados: Campos) =>
    cliente.post(`/turmas/${turma_id}/inscricoes/${inscricao_id}`, dados, { seguir: false });

  it("inscrever e confirmar", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    expect([inscricao!.situacao, inscricao!.origem]).toEqual(["INSCRITA", "INTERNA"]);
    await mudar(turma_id, inscricao!.id, { destino: "CONFIRMADA" });
    const [depois] = await _inscricoes();
    expect(depois!.situacao).toBe("CONFIRMADA");
    expect(depois!.confirmada_em).not.toBeNull();
    expect(depois!.confirmada_por).not.toBeNull();
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'inscricao' AND ${e.historico_evento.campo} = 'situacao'`);
    expect(eventos).toHaveLength(1);
    expect([eventos[0]!.valor_anterior, eventos[0]!.valor_novo]).toEqual(["INSCRITA", "CONFIRMADA"]);
  });

  it("inscrição duplicada é recusada", async () => {
    const { turma_id } = await turma_aberta();
    const dados = { servidor_id: String(await _criar_servidor()) };
    await inscrever(turma_id, dados);
    expect(await _msg(cliente, await inscrever(turma_id, dados))).toContain(`já consta em ${PRIMEIRA}`);
    expect(await _inscricoes()).toHaveLength(1);
  });

  it("turma sem vaga recusa inscrição", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, vagas: "1" }, { seguir: false });
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const texto = await _msg(cliente, await inscrever(turma_id, { servidor_id: String(await _criar_servidor("2165804", "Fabrício")) }));
    expect(texto).toContain("não tem vaga");
  });

  it("cancelar inscrição libera a vaga", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, vagas: "1" }, { seguir: false });
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    await mudar(turma_id, inscricao!.id, { destino: "CANCELADA", motivo: "desistiu" });
    const r = await inscrever(turma_id, { servidor_id: String(await _criar_servidor("2165804", "Fabrício")) });
    expect(r.status).toBe(303);
    expect((await _inscricoes()).map((i) => i.situacao).sort()).toEqual(["CANCELADA", "INSCRITA"]);
  });

  it("cancelar inscrição sem motivo é recusado", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    expect(await _msg(cliente, await mudar(turma_id, inscricao!.id, { destino: "CANCELADA" }))).toContain("exige o motivo");
    expect((await _inscricoes())[0]!.situacao).toBe("INSCRITA");
  });

  it("confirmar inscrição cancelada é recusado", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    await mudar(turma_id, inscricao!.id, { destino: "CANCELADA", motivo: "desistiu" });
    expect(await _msg(cliente, await mudar(turma_id, inscricao!.id, { destino: "CONFIRMADA" }))).toContain(
      "Transição proibida",
    );
    expect((await _inscricoes())[0]!.situacao).toBe("CANCELADA");
  });

  it("aprovar por fora da tela também é recusado", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const operador = await _usuario_com(["turma.inscrever"]);
    const [linha] = await _inscricoes();
    const inscricao = (await servico_turma.carregar_inscricao(db, linha!.id))!;
    await expect(servico_turma.mudar_situacao_inscricao(db, operador, inscricao, "APROVADO")).rejects.toBeInstanceOf(
      servico_turma.RegraDaTurma,
    );
    await expect(servico_turma.mudar_situacao_inscricao(db, operador, inscricao, "INVENTADA")).rejects.toBeInstanceOf(
      servico_turma.RegraDaTurma,
    );
  });

  it("presença e resultado não se digitam", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    await mudar(turma_id, inscricao!.id, { destino: "CONFIRMADA" });
    for (const derivado of ["PRESENTE", "APROVADO"]) {
      expect(await _msg(cliente, await mudar(turma_id, inscricao!.id, { destino: derivado })), derivado).toContain(
        "não se digitam",
      );
    }
    expect(servico_turma.SITUACAO_DERIVADA).toBeTruthy();
    expect((await _inscricoes())[0]!.situacao).toBe("CONFIRMADA");
  });

  it("turma cancelada não recebe inscrição", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}/situacao`, { destino: "CANCELADA", motivo: "sem quórum" }, { seguir: false });
    expect(await _msg(cliente, await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) }))).toContain(
      "não recebe inscrição",
    );
    expect(await _inscricoes()).toHaveLength(0);
  });

  it("inscrição sem ninguém escolhido é recusada", async () => {
    const { turma_id } = await turma_aberta();
    expect(await _msg(cliente, await inscrever(turma_id, {}))).toContain("Escolha alguém já cadastrado");
  });
});

// =====================================================================
// Permissão
// =====================================================================
describe("permissão", () => {
  it.each([
    ["/turmas", { treinamento_id: "1", ...TURMA }],
    ["/turmas/1/situacao", { destino: "INSCRICOES_ABERTAS" }],
    ["/turmas/1/inscricoes", { nome: "Alguém", vinculo: "VISITANTE" }],
    ["/turmas/1/instrutores", { assinatura_instrutor_id: "1" }],
  ] as [string, Campos][])("escrita negada para quem só consulta: %s", async (caminho, dados) => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    await _criar_turma(cliente, treinamento_id);
    await _criar_assinatura(cliente);
    // os ids 1 do parametrize são os do banco novo
    expect(await _id_da_turma()).toBe(1);

    const auditor = novoCliente();
    await entrar(auditor, "auditor_interno");
    const r = await auditor.post(caminho, dados);
    expect(r.status, caminho).toBe(403);
  });

  it("a secretaria monta a turma e inscreve", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const secretaria = novoCliente();
    await entrar(secretaria, "secretaria_csso");
    expect((await _criar_turma(secretaria, treinamento_id)).status).toBe(303);
    const turma_id = await _id_da_turma();
    const r = await secretaria.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(await _criar_servidor()) }, { seguir: false });
    expect(r.status).toBe(303);
    const inscricoes = await _inscricoes();
    expect(inscricoes).toHaveLength(1);
    expect(inscricoes[0]!.situacao).toBe("INSCRITA");
  });

  it("a CSSO continua achando participante pelo nome na ficha", async () => {
    const { treinamento_id } = await turma_aberta();
    // a pessoa tem de ser PARTICIPANTE e estar inscrita em OUTRA turma
    const outra = await _id_da_turma();
    expect(
      (await cliente.post(`/turmas/${outra}/inscricoes`, { servidor_id: String(await _criar_servidor()) }, { seguir: false }))
        .status,
    ).toBe(303);
    expect((await _criar_turma(cliente, treinamento_id, { codigo: SEGUNDA })).status).toBe(303);
    const vazia = await _id_da_turma(SEGUNDA);
    const corpo = (await cliente.get(`/turmas/${vazia}?aba=inscricoes&busca=Marco`)).text;
    expect(
      corpo,
      "a coordenação procurou pelo primeiro nome e não achou: a rota deixou de repassar o usuário para a busca",
    ).toContain("Marco Antônio Alves Schetino");
  });

  it("a ficha da turma abre para quem só consulta", async () => {
    const { turma_id } = await turma_aberta();
    const auditor = novoCliente();
    await entrar(auditor, "auditor_interno");
    const corpo = (await auditor.get(`/turmas/${turma_id}`)).text;
    expect(corpo).toContain(PRIMEIRA);
    // sem permissão de escrita, nenhum formulário de ação aparece
    expect(corpo).not.toContain(`action="/turmas/${turma_id}/situacao"`);
    expect((await auditor.get(`/turmas/${turma_id}?aba=inscricoes`)).text).not.toContain("Cadastrar participante externo");
  });
});
