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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { Participante as P } from "../src/dominio/treinamento.js";
import { agora_utc } from "../src/db/esquema/base.js";
import type { Banco } from "../src/db/cliente.js";
import * as numeracao from "../src/servicos/numeracao.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_turma from "../src/servicos/turma.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as privacidade from "../src/servicos/privacidade.js";
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

// a primeira chamada, na coleta, clona o banco do arquivo e registra o
// `afterAll` que fecha a conexão; as do `beforeEach` o restauram no lugar
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
async function turma_aberta(dados: Campos = {}) {
  await entrar(cliente, "coordenador_csso");
  const treinamento_id = await _criar_treinamento(cliente);
  expect((await _criar_turma(cliente, treinamento_id, dados)).status).toBe(303);
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

  // concluir pede o curso terminado (D25): a turma de hoje anda o caminho todo
  const DE_HOJE = { data_inicio: hoje_iso(), data_fim: hoje_iso() };

  it("caminho feliz da turma", async () => {
    const { turma_id } = await turma_aberta(DE_HOJE);
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

  // NUVEM: de planejada direto a concluída só a turma que já terminou (curso já dado)
  it("pular de planejada para concluída antes do fim é recusado", async () => {
    const { turma_id } = await turma_aberta();
    expect(await _msg(cliente, await passar(turma_id, "CONCLUIDA"))).toContain("só se conclui turma que já aconteceu");
    expect((await _turma(turma_id)).situacao).toBe("PLANEJADA");
  });

  it("cancelar sem motivo é recusado", async () => {
    const { turma_id } = await turma_aberta();
    expect(await _msg(cliente, await passar(turma_id, "CANCELADA"))).toContain("exige o motivo");
    expect((await _turma(turma_id)).situacao).toBe("PLANEJADA");
  });

  it("concluir leva à confirmação e não executa no primeiro clique", async () => {
    const { turma_id } = await turma_aberta(DE_HOJE);
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

  it("a confirmação de concluir prevê a apuração e avisa de quem está sem presença", async () => {
    const { turma_id } = await turma_aberta(DE_HOJE);
    const servidor_id = await _criar_servidor();
    await passar(turma_id, "INSCRICOES_ABERTAS");
    await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(servidor_id) }, { seguir: false });
    await passar(turma_id, "EM_ANDAMENTO");
    const antes = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(antes).toContain('id="previa-apuracao"');
    expect(antes).toContain("0 aprovado(s) e 1 reprovado(s)");
    expect(antes).toContain("1 inscrito(s) ainda sem nenhuma presença lançada");
    expect(antes).toContain("não há presença registrada");
    expect(antes).toContain(`href="/turmas/${turma_id}?aba=presencas"`);

    await cliente.post(`/turmas/${turma_id}/presencas/todos`, {}, { seguir: false });
    const depois = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(depois).toContain("1 aprovado(s) e 0 reprovado(s)");
    expect(depois).not.toContain("sem nenhuma presença lançada");
  });

  it("a confirmação de concluir some quando não há para onde ir", async () => {
    const { turma_id } = await turma_aberta(DE_HOJE);
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CONCLUIDA"]) await passar(turma_id, destino);
    const ficha = (await cliente.get(`/turmas/${turma_id}`)).text;
    expect(ficha).not.toContain('id="concluir-turma"');
    expect(ficha).toContain("é situação final");
  });

  it("turma concluída é terminal", async () => {
    const { turma_id } = await turma_aberta(DE_HOJE);
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

  it("CPF só nas colunas autorizadas (certificado, 19/10/2026; Anexo III da CAT/SP, 27/10/2026), em nenhuma outra", async () => {
    // "guardar CPF só para certificado": participante.cpf e assinatura_instrutor.cpf
    // — e, desde 27/10/2026 (decisão do dono do sistema), o bloco restrito do Anexo III da CAT/SP
    // (`acidente_identificacao.cpf`: ver `servicos/acidente_identificacao.ts` e o DESVIOS.md)
    const colunas = (await db.execute(
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name ILIKE '%cpf%' ORDER BY 1, 2`,
    )) as unknown as { table_name: string; column_name: string }[];
    expect(colunas.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "acidente_identificacao.cpf",
      "assinatura_instrutor.cpf",
      "participante.cpf",
    ]);
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
    expect(texto).toContain("E-mail inválido");
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

  it("inscrever já confirma a vaga, sem segundo clique", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    // 25/10/2026: com a vaga conferida, não há o que a equipe decidir depois
    expect([inscricao!.situacao, inscricao!.origem]).toEqual(["CONFIRMADA", "INTERNA"]);
    expect(inscricao!.confirmada_em).not.toBeNull();
    expect(inscricao!.confirmada_por).not.toBeNull();
  });

  it("a inscrição antiga ainda INSCRITA continua se confirmando pela linha", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    await db.update(e.inscricao).set({ situacao: "INSCRITA", confirmada_em: null, confirmada_por: null }).where(eq(e.inscricao.id, inscricao!.id));
    await mudar(turma_id, inscricao!.id, { destino: "CONFIRMADA" });
    const [depois] = await _inscricoes();
    expect(depois!.situacao).toBe("CONFIRMADA");
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(sql`${e.historico_evento.entidade} = 'inscricao' AND ${e.historico_evento.campo} = 'situacao'`);
    expect(eventos.map((ev) => [ev.valor_anterior, ev.valor_novo])).toEqual([["INSCRITA", "CONFIRMADA"]]);
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
    expect((await _inscricoes()).map((i) => i.situacao).sort()).toEqual(["CANCELADA", "CONFIRMADA"]);
  });

  it("cancelar inscrição sem motivo é recusado", async () => {
    const { turma_id } = await turma_aberta();
    await inscrever(turma_id, { servidor_id: String(await _criar_servidor()) });
    const [inscricao] = await _inscricoes();
    expect(await _msg(cliente, await mudar(turma_id, inscricao!.id, { destino: "CANCELADA" }))).toContain("exige o motivo");
    expect((await _inscricoes())[0]!.situacao).toBe("CONFIRMADA");
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
    expect(inscricoes[0]!.situacao).toBe("CONFIRMADA");
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

// =====================================================================
// Inscrição em lote
// =====================================================================
describe("inscrição em lote", () => {
  const LISTA = [
    "Nome\tE-mail\tEmpresa",
    "1110654",
    "Gorete Vasconcelos Pimenta",
    "Maria Aparecida de Souza\tmaria@limpatudo.com.br\tLimpa Tudo Ltda\t(38) 99911-2233",
    "João Pereira; joao@limpatudo.com.br",
    "9999999",
  ].join("\n");

  async function _inscritos(turma_id: number) {
    return db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma_id));
  }

  it("conferir não grava nada e diz o que cada linha seria", async () => {
    const { turma_id } = await turma_aberta();
    await _criar_servidor();
    await _criar_servidor("2220001", "Gorete Vasconcelos Pimenta");
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, { lista: LISTA, vinculo: "TERCEIRIZADO", acao: "conferir" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Nada foi gravado ainda");
    expect(r.text).toContain("servidor, pelo SIAPE");
    expect(r.text).toContain("servidor, pelo nome");
    expect(r.text).toContain("externo novo");
    expect(r.text).toContain("SIAPE 9999999 não está no cadastro");
    expect(r.text).toContain("não guardado: telefone");
    expect(await _inscritos(turma_id)).toHaveLength(0);
    expect(await db.select().from(e.participante)).toHaveLength(0);
  });

  it("inscrever grava as válidas, cria os externos e deixa só a recusada na caixa", async () => {
    const { turma_id } = await turma_aberta();
    await _criar_servidor();
    await _criar_servidor("2220001", "Gorete Vasconcelos Pimenta");
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, {
      lista: LISTA,
      vinculo: "TERCEIRIZADO",
      organizacao: "Contratada",
      acao: "inscrever",
    });
    expect(r.text).toContain("4 inscrito(s)");
    expect(await _inscritos(turma_id)).toHaveLength(4);
    const externos = await db.select().from(e.participante).where(eq(e.participante.vinculo, "TERCEIRIZADO"));
    expect(Object.fromEntries(externos.map((p) => [p.nome, p.organizacao]))).toEqual({
      "Maria Aparecida de Souza": "Limpa Tudo Ltda",
      "João Pereira": "Contratada",
    });
    // a caixa volta só com a linha recusada
    expect(r.text).toMatch(/<textarea[^>]*>9999999<\/textarea>/);

    // a mesma lista de novo: ninguém em dobro, e o e-mail acha quem já existe
    const de_novo = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, { lista: LISTA, vinculo: "TERCEIRIZADO", acao: "inscrever" });
    expect(de_novo.text).toContain("0 inscrito(s)");
    expect(de_novo.text).toContain("4 já estava(m) na turma");
    expect(de_novo.text).toContain("já participou, pelo e-mail");
    expect(await db.select().from(e.participante)).toHaveLength(4);
  });

  it("o CPF colado chega mascarado e não é guardado", async () => {
    const { turma_id } = await turma_aberta();
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, {
      lista: "Ana Lima\t529.982.247-25\tana@x.com.br",
      vinculo: "VISITANTE",
      acao: "inscrever",
    });
    expect(r.text).toContain("não guardado: CPF");
    expect(r.text).not.toContain("529.982.247-25");
    const [ana] = await db.select().from(e.participante);
    expect(ana!.cpf).toBeNull();
  });

  it("dois servidores com o mesmo nome é recusa, não palpite; e a vaga acaba", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, vagas: "1" }, { seguir: false });
    await _criar_servidor("1110001", "José da Silva");
    await _criar_servidor("1110002", "José da Silva");
    await _criar_servidor("1110003", "Ana Lima");
    await _criar_servidor("1110004", "Bruno Costa");
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, {
      lista: "José da Silva\nAna Lima\nBruno Costa",
      vinculo: "OUTRO",
      acao: "inscrever",
    });
    expect(r.text).toContain("Há 2 servidores com este nome: informe o SIAPE.");
    expect(r.text).toContain("não tem vaga");
    expect(await _inscritos(turma_id)).toHaveLength(1);
  });

  it("quem não inscreve não abre a tela", async () => {
    const { turma_id } = await turma_aberta();
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.get(`/turmas/${turma_id}/inscricoes/lote`)).status).toBe(403);
    expect((await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, { lista: "1110654", vinculo: "OUTRO", acao: "inscrever" })).status).toBe(403);
  });
});

// =====================================================================
// Descrição do evento
// =====================================================================
describe("descrição do evento", () => {
  const TEXTO = "Formação de brigadistas, com prática de combate a incêndio & evacuação";

  it("nasce com a turma, aparece na ficha e a próxima turma do treinamento a oferece", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    expect((await _criar_turma(cliente, treinamento_id, { descricao: TEXTO })).status).toBe(303);
    const primeira = await _id_da_turma();
    expect((await _turma(primeira)).descricao).toBe(TEXTO);
    expect((await cliente.get(`/turmas/${primeira}`)).text).toContain("Formação de brigadistas, com prática de combate a incêndio &amp; evacuação");

    // a lista põe a última descrição na opção do treinamento, para o botão copiar
    const lista = (await cliente.get("/turmas")).text;
    expect(lista).toMatch(new RegExp(`<option value="${treinamento_id}"[^>]*data-descricao="Formação de brigadistas`));
    expect(lista).toContain('data-reusar-descricao="nova-descricao"');

    // a segunda turma, sem descrição, oferece a da primeira na edição
    expect((await _criar_turma(cliente, treinamento_id)).status).toBe(303);
    const segunda = await _id_da_turma(SEGUNDA);
    expect((await _turma(segunda)).descricao).toBeNull();
    const ficha = (await cliente.get(`/turmas/${segunda}`)).text;
    expect(ficha).toContain('id="reusar-descricao-ficha"');
    expect(ficha).toContain(`data-texto="Formação de brigadistas`);
    // a primeira não oferece a si mesma
    expect((await cliente.get(`/turmas/${primeira}`)).text).not.toContain('id="reusar-descricao-ficha"');
  });

  it("editar a turma grava a descrição, e apagar o texto apaga", async () => {
    const { turma_id } = await turma_aberta();
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, descricao: "Turma do Campus JK" }, { seguir: false });
    expect((await _turma(turma_id)).descricao).toBe("Turma do Campus JK");
    await cliente.post(`/turmas/${turma_id}`, { ...TURMA, descricao: "  " }, { seguir: false });
    expect((await _turma(turma_id)).descricao).toBeNull();
  });
});

// =====================================================================
// Inscrição pública por link
// =====================================================================
describe("inscrição pública por link", () => {
  beforeEach(() => inscricao_publica.limpar_limites());

  const PEDIDO = {
    nome: "Joana Prestes da Silva",
    vinculo: "TERCEIRIZADO",
    siape: "",
    email: "joana@empresa.com.br",
    organizacao: "Limpeza & Cia",
    consentimento: "sim",
  };

  /** Turma em inscrições abertas, com prazo, e o link gerado pela tela. */
  async function com_link(campos: Partial<typeof e.turma.$inferInsert> = {}) {
    const { turma_id } = await turma_aberta();
    await db
      .update(e.turma)
      .set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(hoje_iso(), 10), ...campos })
      .where(eq(e.turma.id, turma_id));
    const r = await cliente.post(`/turmas/${turma_id}/link-publico`, {});
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    const token = r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]!;
    return { turma_id, token, pagina: r };
  }

  async function _pendencias_da_turma(turma_id: number) {
    return db.select().from(e.pendencia).where(eq(e.pendencia.entidade_id, turma_id));
  }

  it("gera o link uma vez, guarda só o hash, e o público vê a turma sem sessão", async () => {
    const { turma_id, token, pagina } = await com_link();
    expect(pagina.text).toContain("data:image/png;base64,");
    expect(pagina.cabecalho("cache-control")).toBe("no-store");
    const turma = await _turma(turma_id);
    expect(turma.inscricao_publica).toBe(true);
    expect(turma.inscricao_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(turma.inscricao_token_hash).not.toContain(token);

    const publico = novoCliente();
    const r = await publico.get(`/inscricao/${token}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Trabalho em Altura");
    expect(r.text).toContain("Pedir a vaga");
    expect(r.cabecalho("x-robots-tag")).toContain("noindex");
    expect(r.cabecalho("cache-control")).toBe("no-store");
    expect((await publico.get("/inscricao/token-que-nao-existe")).status).toBe(404);
    // a ficha diz que está no ar, sem o token
    const ficha = (await cliente.get(`/turmas/${turma_id}?aba=inscricoes`)).text;
    expect(ficha).toContain("no ar até");
    expect(ficha).not.toContain(token);
  });

  it("sem data de fechamento, ou com a turma fora de inscrições abertas, não há link", async () => {
    const { turma_id } = await turma_aberta();
    const r = await cliente.post(`/turmas/${turma_id}/link-publico`, {}, { seguir: false });
    expect(await _msg(cliente, r)).toContain("Defina antes até quando");
    await db.update(e.turma).set({ inscricao_aberta_ate: somar_dias(hoje_iso(), 5) }).where(eq(e.turma.id, turma_id));
    const r2 = await cliente.post(`/turmas/${turma_id}/link-publico`, {}, { seguir: false });
    expect(await _msg(cliente, r2)).toContain("só se inscreve em turma com inscrições abertas");
    expect((await _turma(turma_id)).inscricao_publica).toBe(false);
  });

  it("o pedido fica a conferir, não ocupa vaga, abre a pendência e guarda o IP", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    const publico = novoCliente();
    const IP = { cabecalhos: { "x-nf-client-connection-ip": "200.131.1.10" } };
    const r = await publico.post(`/inscricao/${token}`, PEDIDO, IP);
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    expect(_texto(r.text)).toContain(inscricao_publica.RESPOSTA_PADRAO);
    const [i] = await _inscricoes();
    expect(i!.situacao).toBe("AGUARDANDO_EMAIL");
    expect(i!.origem).toBe("PUBLICA");
    expect(i!.ip_inscricao).toBe("200.131.1.10");
    expect(i!.inscrito_por).toBeNull();
    const [p] = await _participantes();
    expect(p!.nome).toBe("Joana Prestes da Silva");
    expect(p!.vinculo).toBe("TERCEIRIZADO");
    const [email] = await db.select().from(e.participante_email);
    expect(email!.origem).toBe("INSCRICAO_PUBLICA");
    expect(email!.confirmado_em).toBeNull();
    const turma = await _turma(turma_id);
    await naTransacao(async (tx) => expect(await servico_turma.vagas_restantes(tx, turma)).toBe(1));
    const [pendencia] = await _pendencias_da_turma(turma_id);
    expect(pendencia!.tipo).toBe("TURMA_INSCRICAO_A_CONFIRMAR");
    expect(pendencia!.descricao).toContain("pelo link público");
    expect(pendencia!.descricao).not.toContain("Joana");
    expect(pendencia!.responsavel_id).toBeNull();
    // a mesma pessoa de novo: nenhum segundo registro, e a mesma resposta
    const de_novo = await publico.post(`/inscricao/${token}`, PEDIDO);
    expect(_texto(de_novo.text)).toContain(inscricao_publica.RESPOSTA_PADRAO);
    expect(await _inscricoes()).toHaveLength(1);
    expect(await _participantes()).toHaveLength(1);
    // na ficha, como pedido pelo link
    const ficha = (await cliente.get(`/turmas/${turma_id}?aba=inscricoes`)).text;
    expect(ficha).toContain("Pedido pelo link (a conferir)");
    expect(ficha).toContain("Aceitar o pedido");
  });

  it("o SIAPE só liga ao cadastro do servidor quando o nome confere", async () => {
    const { token } = await com_link();
    const servidor_id = await _criar_servidor();
    const publico = novoCliente();
    // SIAPE de outra pessoa: vira participante novo, com a nota para a CSSO
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Fulano de Tal", vinculo: "SERVIDOR", siape: "1110654", email: "" });
    let [p] = await _participantes();
    expect(p!.servidor_id).toBeNull();
    expect(p!.vinculo).toBe("OUTRO");
    expect((await _inscricoes())[0]!.observacao).toContain("não confere");
    // o próprio: o pedido entra no participante do servidor
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "marco schetino", vinculo: "SERVIDOR", siape: "1110654", email: "" });
    const participantes = await _participantes();
    expect(participantes).toHaveLength(2);
    expect(participantes[1]!.servidor_id).toBe(servidor_id);
    expect((await _inscricoes())[1]!.observacao).toBeNull();
  });

  it("recusa CPF, nome incompleto e pedido sem a ciência — sem gravar nada", async () => {
    const { token } = await com_link();
    const publico = novoCliente();
    const cpf = await publico.post(`/inscricao/${token}`, { ...PEDIDO, organizacao: "123.456.789-09" });
    expect(cpf.status).toBe(422);
    expect(cpf.text).toContain("Não informe CPF");
    expect((await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Joana" })).text).toContain("nome completo");
    const sem = await publico.post(`/inscricao/${token}`, { ...PEDIDO, consentimento: "" });
    expect(sem.text).toContain("concordar");
    // o que foi digitado volta (menos o que não deve)
    expect(sem.text).toContain('value="Joana Prestes da Silva"');
    expect(await _inscricoes()).toHaveLength(0);
    expect(await _participantes()).toHaveLength(0);
  });

  it("robô no campo-armadilha recebe a mesma resposta e não grava", async () => {
    const { token } = await com_link();
    const r = await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, site: "http://spam" });
    expect(_texto(r.text)).toContain(inscricao_publica.RESPOSTA_PADRAO);
    expect(await _inscricoes()).toHaveLength(0);
  });

  it("limita os envios por IP", async () => {
    const { token } = await com_link();
    const publico = novoCliente();
    for (let n = 0; n < inscricao_publica.LIMITE_POR_JANELA; n++) {
      await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Joana", consentimento: "" });
    }
    const r = await publico.post(`/inscricao/${token}`, PEDIDO);
    expect(r.status).toBe(429);
    expect(await _inscricoes()).toHaveLength(0);
  });

  it("aceitar já confirma a vaga, diz quem conferiu e fecha a pendência; sem vaga, recusa", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, PEDIDO);
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    const [a, b] = await _inscricoes();
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/${a!.id}`, { destino: "INSCRITA" }, { seguir: false });
    expect(await _msg(cliente, r)).toContain("confirmada");
    const [aceita] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, a!.id));
    expect(aceita!.situacao).toBe("CONFIRMADA");
    expect(aceita!.conferida_por).not.toBeNull();
    expect(aceita!.conferida_em).not.toBeNull();
    const pendencias = await _pendencias_da_turma(turma_id);
    expect(pendencias.find((x) => x.chave === `inscricao-${a!.id}-a-confirmar`)!.concluida).toBe(true);
    // a única vaga foi: o segundo pedido não entra
    const cheia = await cliente.post(`/turmas/${turma_id}/inscricoes/${b!.id}`, { destino: "INSCRITA" }, { seguir: false });
    expect(await _msg(cliente, cheia)).toContain("não tem vaga");
    // recusar é cancelar com motivo
    await cliente.post(`/turmas/${turma_id}/inscricoes/${b!.id}`, { destino: "CANCELADA", motivo: "turma cheia" }, { seguir: false });
    const [recusada] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, b!.id));
    expect(recusada!.situacao).toBe("CANCELADA");
    expect(recusada!.conferida_por).toBeNull();
    // quem deixou e-mail fica sabendo; o motivo escrito para a trilha não vai
    const todos = await db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
    // cada pedido com e-mail recebeu antes o link de confirmação (25/10/2026)
    expect(todos.filter((x) => x.tipo === "INSCRICAO_CONFIRMAR").map((x) => x.inscricao_id)).toEqual([a!.id, b!.id]);
    const avisos = todos.filter((x) => x.tipo !== "INSCRICAO_CONFIRMAR");
    expect(avisos.map((x) => [x.tipo, x.destinatario, x.inscricao_id])).toEqual([
      ["INSCRICAO_ACEITA", "joana@empresa.com.br", a!.id],
      ["INSCRICAO_RECUSADA", "pedro@x.com", b!.id],
    ]);
    expect(avisos[0]!.corpo).toContain("A vaga é sua");
    expect(avisos[1]!.corpo).not.toContain("turma cheia");
  });

  it("com o link ligado, apagar o prazo de inscrição explica em vez de dar erro 500", async () => {
    const { turma_id } = await com_link();
    const antes = await _turma(turma_id);
    const r = await cliente.post(
      `/turmas/${turma_id}`,
      { data_inicio: antes.data_inicio, data_fim: antes.data_fim, inscricao_aberta_ate: "", frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(await _msg(cliente, r)).toContain("link público de inscrição desta turma está ligado");
    expect((await _turma(turma_id)).inscricao_aberta_ate).toBe(antes.inscricao_aberta_ate);
  });

  async function token_da_confirmacao(para: string): Promise<string> {
    const [m] = await db
      .select()
      .from(e.email_saida)
      .where(and(eq(e.email_saida.tipo, "INSCRICAO_CONFIRMAR"), eq(e.email_saida.destinatario, para)))
      .orderBy(desc(e.email_saida.id))
      .limit(1);
    return m!.corpo!.match(/\/inscricao\/confirmar\/([A-Za-z0-9_-]+)/)![1]!;
  }

  it("quem confirma o e-mail do pedido tem a inscrição confirmada sozinha, e a tarefa da equipe fecha", async () => {
    const { turma_id, token } = await com_link({ vagas: 5 });
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, PEDIDO);
    const [pedido] = await _inscricoes();
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");
    const link = await token_da_confirmacao(PEDIDO.email);
    // abrir não confirma (leitor de e-mail pré-visualiza links)
    const tela = await publico.get(`/inscricao/confirmar/${link}`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Confirmar a inscrição");
    expect((await db.select().from(e.inscricao).where(eq(e.inscricao.id, pedido!.id)))[0]!.situacao).toBe("AGUARDANDO_EMAIL");
    const ok = await publico.post(`/inscricao/confirmar/${link}`, {});
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("Inscrição confirmada");
    const [depois] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, pedido!.id));
    expect(depois!.situacao).toBe("CONFIRMADA");
    expect(depois!.email_confirmado_em).not.toBeNull();
    expect(depois!.confirmacao_token_hash).toBeNull();
    const pendencias = await _pendencias_da_turma(turma_id);
    expect(pendencias.find((x) => x.chave === `inscricao-${pedido!.id}-a-confirmar`)!.concluida).toBe(true);
    // o link serve uma vez
    expect((await publico.post(`/inscricao/confirmar/${link}`, {})).status).toBe(404);
  });

  it("sem vaga na hora de confirmar, o e-mail fica confirmado e o pedido continua com a equipe", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, PEDIDO);
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    await publico.post(`/inscricao/confirmar/${await token_da_confirmacao(PEDIDO.email)}`, {});
    const r = await publico.post(`/inscricao/confirmar/${await token_da_confirmacao("pedro@x.com")}`, {});
    expect(r.text).toContain("As vagas de");
    const situacoes = (await _inscricoes()).map((i) => [i.situacao, i.email_confirmado_em !== null]);
    expect(situacoes).toEqual([
      ["CONFIRMADA", true],
      ["AGUARDANDO_EMAIL", true],
    ]);
    const pendencias = await _pendencias_da_turma(turma_id);
    expect(pendencias.filter((x) => !x.concluida)).toHaveLength(1);
  });

  it("o pedido sem e-mail e o que casou com um servidor por outro e-mail não recebem o link", async () => {
    const { token } = await com_link({ vagas: 5 });
    await _criar_servidor("1234567", "Servidora do Cadastro", "servidora@ufvjm.edu.br");
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, email: "" });
    await publico.post(`/inscricao/${token}`, {
      ...PEDIDO,
      nome: "Servidora do Cadastro",
      vinculo: "SERVIDOR",
      siape: "1234567",
      email: "outro.endereco@gmail.com",
    });
    const confirmacoes = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, "INSCRICAO_CONFIRMAR"));
    expect(confirmacoes).toEqual([]);
    expect((await _inscricoes()).every((i) => i.situacao === "AGUARDANDO_EMAIL")).toBe(true);
  });

  it("aceita os pedidos marcados de uma vez; mais pedidos do que vagas não aceita nenhum da turma", async () => {
    const { turma_id, token } = await com_link({ vagas: 2 });
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, PEDIDO);
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Maria Quitéria de Jesus", email: "maria@x.com" });
    const [a, b, c] = await _inscricoes();
    const tela = (await cliente.get("/turmas/pedidos")).text;
    expect(tela).toContain("Joana Prestes da Silva");
    expect(tela).toContain("3 pedido(s)");
    // três marcados para duas vagas: nenhum entra — quem fica de fora é escolha
    // de quem confere, e não a ordem da lista (M38)
    const demais = await cliente.post("/turmas/pedidos", { acao: "aceitar", inscricao_id: [String(a!.id), String(b!.id), String(c!.id)] });
    expect(demais.status, demais.text.slice(0, 500)).toBe(200);
    expect(_texto(demais.text)).toContain("3 pedidos marcados e 2 vagas livres — nenhum foi aceito; desmarque 1");
    expect((await _inscricoes()).map((x) => x.situacao)).toEqual(["AGUARDANDO_EMAIL", "AGUARDANDO_EMAIL", "AGUARDANDO_EMAIL"]);
    const r = await cliente.post("/turmas/pedidos", { acao: "aceitar", inscricao_id: [String(a!.id), String(b!.id)] });
    expect(_texto(r.text)).toContain("2 pedido(s) aceito(s)");
    const situacoes = (await _inscricoes()).map((x) => x.situacao);
    expect(situacoes).toEqual(["CONFIRMADA", "CONFIRMADA", "AGUARDANDO_EMAIL"]);
    // recusar sem motivo não passa; com motivo, cancela
    const sem = await cliente.post("/turmas/pedidos", { acao: "recusar", inscricao_id: String(c!.id) }, { seguir: false });
    expect(await _msg(cliente, sem)).toContain("escreva o motivo");
    await cliente.post(
      "/turmas/pedidos",
      { acao: "recusar", motivo: "turma cheia", inscricao_id: String(c!.id), turma_id: String(turma_id) },
      { seguir: false },
    );
    expect((await _inscricoes())[2]!.situacao).toBe("CANCELADA");
  });

  it("turma lotada fecha o link: o cartaz avisa e o pedido não grava", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, PEDIDO);
    const [a] = await _inscricoes();
    await cliente.post(`/turmas/${turma_id}/inscricoes/${a!.id}`, { destino: "INSCRITA" }, { seguir: false });
    const cartaz = await publico.get(`/inscricao/${token}`);
    expect(_texto(cartaz.text)).toContain("se esgotaram");
    expect(cartaz.text).not.toContain("Pedir a vaga");
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    expect(await _inscricoes()).toHaveLength(1);
  });

  it("abrir a turma já com link: nasce com inscrições abertas e mostra o link uma vez", async () => {
    await entrar(cliente, "coordenador_csso");
    const treinamento_id = await _criar_treinamento(cliente);
    const sem_prazo = await _criar_turma(cliente, treinamento_id, { abertura: "LINK" });
    expect(_texto(sem_prazo.text)).toContain("precisa de “inscrições até”");
    expect(await _turmas()).toHaveLength(0);
    const r = await _criar_turma(cliente, treinamento_id, { abertura: "LINK", inscricao_aberta_ate: somar_dias(hoje_iso(), 10) });
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    expect(r.text).toContain("Copiar link");
    expect(r.text).toContain("Mensagem pronta");
    const token = r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]!;
    const turma = await _turma(await _id_da_turma());
    expect(turma.situacao).toBe("INSCRICOES_ABERTAS");
    expect(turma.inscricao_publica).toBe(true);
    expect((await novoCliente().get(`/inscricao/${token}`)).text).toContain("Pedir a vaga");
  });

  it("o banco recusa tirar o pedido da espera sem conferência", async () => {
    const { token } = await com_link();
    await novoCliente().post(`/inscricao/${token}`, PEDIDO);
    const [i] = await _inscricoes();
    await expect(db.update(e.inscricao).set({ situacao: "INSCRITA" }).where(eq(e.inscricao.id, i!.id))).rejects.toThrow();
  });

  it("trocar o link mata o anterior; desligar mata o atual", async () => {
    const { turma_id, token } = await com_link();
    const r = await cliente.post(`/turmas/${turma_id}/link-publico`, {});
    const novo = r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]!;
    expect(novo).not.toBe(token);
    const publico = novoCliente();
    expect((await publico.get(`/inscricao/${token}`)).status).toBe(404);
    expect((await publico.get(`/inscricao/${novo}`)).status).toBe(200);
    await cliente.post(`/turmas/${turma_id}/link-publico/desligar`, {}, { seguir: false });
    expect((await publico.get(`/inscricao/${novo}`)).status).toBe(404);
    expect((await _turma(turma_id)).inscricao_token_hash).toBeNull();
  });

  it("prazo vencido ou turma em andamento: o link mostra que fechou e não grava", async () => {
    const { turma_id, token } = await com_link();
    await db.update(e.turma).set({ situacao: "EM_ANDAMENTO" }).where(eq(e.turma.id, turma_id));
    const r = await novoCliente().post(`/inscricao/${token}`, PEDIDO);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Pedir a vaga");
    expect(await _inscricoes()).toHaveLength(0);
  });

  it("quem não edita turma não gera nem desliga o link", async () => {
    const { turma_id } = await turma_aberta();
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.post(`/turmas/${turma_id}/link-publico`, {})).status).toBe(403);
    expect((await cliente.post(`/turmas/${turma_id}/link-publico/desligar`, {})).status).toBe(403);
  });

  it("o IP do pedido sai depois de 90 dias", async () => {
    const { token } = await com_link();
    await novoCliente().post(`/inscricao/${token}`, PEDIDO, { cabecalhos: { "x-nf-client-connection-ip": "200.131.1.10" } });
    await naTransacao(async (tx) => {
      expect(await privacidade.expurgar_ip_de_inscricao(tx)).toBe(0);
      const daqui = new Date(Date.now() + 91 * 86_400_000);
      expect(await privacidade.expurgar_ip_de_inscricao(tx, daqui)).toBe(1);
    });
    expect((await _inscricoes())[0]!.ip_inscricao).toBeNull();
  });
});

describe("início do módulo", () => {
  it("mostra os passos e o que espera em cada um; quem não vê certificado não entra", async () => {
    const { turma_id } = await turma_aberta();
    await db.update(e.turma).set({ situacao: "INSCRICOES_ABERTAS" }).where(eq(e.turma.id, turma_id));
    const r = await cliente.get("/treinamentos");
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    const texto = _texto(r.text);
    expect(texto).toContain("Certificados e Treinamentos");
    expect(texto).toContain("1 com inscrição aberta");
    expect(texto).toContain("0 a conferir");
    expect(texto).toContain(PRIMEIRA);
    const servidor = novoCliente();
    await entrar(servidor, "servidor_consulta");
    expect((await servidor.get("/treinamentos", { seguir: false })).status).toBe(403);
  });
});
