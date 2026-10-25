/**
 * Prevenção de cadastros duplicados (23/10/2026, etapa 1 das decisões do
 * usuário): o critério único de "parecido", o par "não é a mesma pessoa", o
 * link público no modelo "esqueci a senha", a conferência dos pedidos, a
 * ficha da turma, a prévia do lote, a importação SIAPE, o suspeito, o e-mail
 * confirmado pelo link e o contador no lugar do item de menu.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as modulos from "../src/modulos.js";
import * as acesso_participante from "../src/servicos/acesso_participante.js";
import * as aviso_cadastro from "../src/servicos/aviso_cadastro_existente.js";
import * as duplicados from "../src/servicos/duplicados.js";
import * as email from "../src/servicos/email.js";
import * as importacao_servidores from "../src/servicos/importacao_servidores.js";
import * as inscricao_lote from "../src/servicos/inscricao_lote.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as mesclagem from "../src/servicos/mesclagem.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_turma from "../src/servicos/turma.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, naTransacao, usuarioAtual, type Cliente, type Resposta } from "./ajuda";

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
  // o piso de tempo só no teste que o mede
  inscricao_publica.tempo_de_resposta.piso_ms = 0;
  inscricao_publica.tempo_de_resposta.variacao_ms = 0;
});

function _texto(html: string): string {
  return html
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function _mensagem(c: Cliente, r: Resposta): Promise<string> {
  if (r.status === 200) return r.text;
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return (await c.get(r.location!)).text;
}

/** Coordenador logado, um treinamento e uma turma; devolve o id. */
async function _turma(codigo = NR35.codigo): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  let [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo));
  if (!t) {
    const r = await cliente.post("/treinamentos/catalogo", { ...NR35, codigo }, { seguir: false });
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo));
  }
  const antes = await db.select({ id: e.turma.id }).from(e.turma);
  const r = await cliente.post("/turmas", { treinamento_id: String(t!.id), ...TURMA }, { seguir: false });
  expect(r.status, r.text.slice(0, 300)).toBe(303);
  const depois = await db.select({ id: e.turma.id }).from(e.turma);
  return depois.map((x) => x.id).find((id) => !antes.some((a) => a.id === id))!;
}

/** Turma com o link público no ar; devolve o token. */
async function _com_link(): Promise<{ turma_id: number; token: string }> {
  const turma_id = await _turma();
  await db
    .update(e.turma)
    .set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(hoje_iso(), 10) })
    .where(eq(e.turma.id, turma_id));
  const r = await cliente.post(`/turmas/${turma_id}/link-publico`, {});
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return { turma_id, token: r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]! };
}

const PEDIDO = {
  nome: "Joana Prestes da Silva",
  vinculo: "TERCEIRIZADO",
  siape: "",
  email: "joana@empresa.com.br",
  organizacao: "Limpeza & Cia",
  consentimento: "sim",
};

async function _externo(nome: string, email_: string | null = null, vinculo = "TERCEIRIZADO") {
  return naTransacao((tx) =>
    servico_participante.criar_externo(tx, { nome, vinculo, email: email_ ?? undefined, organizacao: "Limpeza & Cia" }),
  );
}

async function _avisos() {
  return db.select().from(e.email_saida).where(eq(e.email_saida.tipo, aviso_cadastro.TIPO_AVISO));
}

async function _todos_avisos() {
  return (await db.select().from(e.email_saida)).filter((m) => aviso_cadastro.TIPOS.includes(m.tipo));
}

/** Um usuário com exatamente estas permissões (sem leitura nominal, por exemplo). */
async function _usuario_com(permissoes: string[], login = "operador"): Promise<UsuarioAtual> {
  const [u] = await db
    .insert(e.usuario)
    .values({ login, nome: "Operador", email: `${login}@teste.ufvjm.edu.br`, senha_hash: "x", precisa_trocar_senha: false })
    .returning();
  return new UsuarioAtual({ id: u!.id, login, nome: "Operador", permissoes, perfis: ["coordenador_csso"] });
}

// =====================================================================
// Critério único
// =====================================================================
describe("critério único de parecido", () => {
  it("nome: primeiro igual e sobrenomes contidos, sem acento nem partícula; uma palavra não parece ninguém", () => {
    expect(duplicados.nomes_parecidos("Maria Souza", "Maria Aparecida Souza Lima")).toBe(true);
    expect(duplicados.nomes_parecidos("Joana Silva", "Joana da Silva")).toBe(true);
    expect(duplicados.nomes_parecidos("JOÃO PEREIRA", "joao pereira")).toBe(true);
    expect(duplicados.nomes_parecidos("Maria Aparecida Lopes", "Maria Lopes")).toBe(true);
    expect(duplicados.nomes_parecidos("Maria Silva", "Maria Souza")).toBe(false);
    expect(duplicados.nomes_parecidos("Zé Santos", "José Santos")).toBe(false);
    expect(duplicados.nomes_parecidos("Maria", "Maria")).toBe(false);
    // o recorte SQL tira acento além da lista antiga (ñ, ý, ø…)
    expect(duplicados.partes_do_nome("Íñigo Muñoz d'Ávila")).toEqual(["inigo", "munoz", "avila"]);
  });

  it("procurar acha pelo nome parecido e pelo e-mail, com o motivo, do mais forte ao mais fraco", async () => {
    const a = await _externo("Joana da Silva", "joana@empresa.com.br");
    const b = await _externo("Joana Silva");
    const c = await _externo("Pedro Alves", "joana@empresa.com.br");
    const achados = await naTransacao((tx) =>
      duplicados.procurar(tx, { nome: "Joana Prestes da Silva", emails: ["JOANA@empresa.com.br"] }),
    );
    expect(achados.map((x) => [x.pessoa.id, x.motivo])).toEqual([
      [a.id, "EMAIL_NOME"],
      [c.id, "EMAIL"],
      [b.id, "NOME"],
    ]);
  });
});

// =====================================================================
// Par "não é a mesma pessoa"
// =====================================================================
describe("par não é a mesma pessoa", () => {
  it("gravado, não volta em procurar, nem nos grupos, nem no contador", async () => {
    const a = await _externo("Joana da Silva");
    const b = await _externo("Joana Silva");
    const coord = await usuarioAtual(db, "coordenador_csso");
    expect(await naTransacao((tx) => duplicados.contar(tx))).toBe(1);
    await naTransacao((tx) => duplicados.marcar_distintos(tx, coord, b.id, a.id, "JUNCAO"));
    // idempotente, e sempre a < b
    expect(await naTransacao((tx) => duplicados.marcar_distintos(tx, coord, a.id, b.id, "JUNCAO"))).toBe(false);
    const pares = await db.select().from(e.participante_par_distinto);
    expect(pares).toHaveLength(1);
    expect(pares[0]!.participante_a_id).toBe(Math.min(a.id, b.id));
    const achados = await naTransacao((tx) =>
      duplicados.procurar(tx, duplicados.alvo_do_cadastro(b)),
    );
    expect(achados.map((x) => x.pessoa.id)).not.toContain(a.id);
    expect(await naTransacao((tx) => duplicados.contar(tx))).toBe(0);
    expect(await naTransacao((tx) => mesclagem.possiveis_duplicados(tx))).toHaveLength(0);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "PARTICIPANTES_DISTINTOS"));
    expect(ev!.descricao).toContain(a.identificador_publico);
    expect(ev!.descricao).not.toContain("Joana");
  });

  it("a tela de juntar grava 'não são a mesma pessoa' para o grupo inteiro", async () => {
    const a = await _externo("Joana da Silva");
    const b = await _externo("Joana Silva");
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/participantes")).text;
    expect(tela).toContain("Não são a mesma pessoa");
    const r = await cliente.post(
      "/treinamentos/participantes/distintos",
      { membro_id: [a.id, b.id], volta: "/treinamentos/participantes" },
      { seguir: false },
    );
    expect(_texto(await _mensagem(cliente, r))).toContain("ficam como pessoas diferentes");
    expect(await naTransacao((tx) => duplicados.contar(tx))).toBe(0);
  });

  it("a junção registra o que moveu, sem dado pessoal", async () => {
    const a = await _externo("Joana da Silva", "joana@empresa.com.br");
    const b = await _externo("Joana Silva", "joana@empresa.com.br");
    await naTransacao((tx) => servico_participante.registrar_email(tx, b, "outra@empresa.com.br"));
    const coord = await usuarioAtual(db, "coordenador_csso");
    await naTransacao((tx) => mesclagem.mesclar(tx, coord, a.id, b.id, "mesma pessoa"));
    const [reg] = await db.select().from(e.participante_mesclagem);
    expect(reg!.mantido_id).toBe(a.id);
    expect(reg!.absorvido_id).toBe(b.id);
    expect(reg!.movido.emails_movidos).toHaveLength(1);
    expect(reg!.movido.emails_repetidos).toHaveLength(1);
    expect(reg!.movido.absorvido_tinha_cpf).toBe(false);
    expect(JSON.stringify(reg!.movido)).not.toContain("@");
  });
});

// =====================================================================
// Link público — "esqueci a senha"
// =====================================================================
describe("link público: resposta idêntica e aviso só ao e-mail do cadastro", () => {
  it("pessoa nova, pessoa com cadastro e já inscrita recebem a MESMA tela, com a linha neutra", async () => {
    const { token } = await _com_link();
    await _externo("Joana da Silva", "joana@empresa.com.br");
    const telas: string[] = [];
    for (const pedido of [
      { ...PEDIDO, nome: "Carlos Nunes Prado", email: "carlos@empresa.com.br" }, // novo
      PEDIDO, // casa pelo e-mail + nome
      PEDIDO, // agora já está na turma
    ]) {
      const visitante = novoCliente();
      const r = await visitante.post(`/inscricao/${token}`, pedido, { seguir: false });
      expect(r.status).toBe(303);
      const tela = _texto((await visitante.get(r.location!)).text);
      expect(tela).toContain(inscricao_publica.RESPOSTA_PADRAO);
      expect(tela).toContain(inscricao_publica.LINHA_NEUTRA);
      expect(tela).not.toMatch(/PTC-/);
      expect(tela).not.toMatch(/já tem cadastro conosco|já está inscrit/i);
      telas.push(
        tela
          .replace(pedido.nome, "<nome>")
          .replace(pedido.email, "<email>")
          .replace(/nonce="[^"]*"/g, "nonce")
          .replace(/name="csrf[^"]*" value="[^"]*"/g, "csrf"),
      );
    }
    expect(telas[1]).toBe(telas[0]);
    expect(telas[2]).toBe(telas[0]);
  });

  // 25/10/2026: o pedido com e-mail recebe o link de confirmação NO ENDEREÇO
  // DIGITADO (confirmado, havendo vaga, a inscrição sai confirmada sozinha).
  // Quando o pedido casou pelo e-mail, é o mesmo endereço do cadastro, e o
  // aviso de cadastro existente não vai junto: a confirmação basta.
  async function _confirmacoes() {
    return db.select().from(e.email_saida).where(eq(e.email_saida.tipo, inscricao_publica.TIPO_EMAIL_CONFIRMAR));
  }

  it("casou por e-mail + nome: vai só o link de confirmação, sem nome nem dado digitado", async () => {
    const { token } = await _com_link();
    await _externo("Joana da Silva", "Joana@Empresa.com.br");
    const r = await novoCliente().post(`/inscricao/${token}`, PEDIDO, { seguir: false });
    expect(r.status).toBe(303);
    expect(await _todos_avisos()).toHaveLength(0);
    const [confirmacao, ...resto] = await _confirmacoes();
    expect(resto).toHaveLength(0);
    expect(confirmacao!.destinatario.toLowerCase()).toBe("joana@empresa.com.br");
    for (const proibido of ["Joana", "Prestes", "Silva", "Limpeza", "PTC-"]) {
      expect(confirmacao!.corpo).not.toContain(proibido);
      expect(confirmacao!.assunto).not.toContain(proibido);
    }
  });

  it("e-mail digitado que não é do cadastro, ou só o nome parecido: nada vai ao cadastro de ninguém", async () => {
    const { token } = await _com_link();
    await _externo("Joana da Silva", "joana@empresa.com.br");
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, email: "outra@gmail.com" }, { seguir: false });
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, nome: "Joana Silva", email: "" }, { seguir: false });
    expect(await _todos_avisos()).toHaveLength(0);
    // só o link de confirmação do próprio pedido, ao endereço digitado nele
    expect((await db.select().from(e.email_saida)).map((m) => [m.tipo, m.destinatario])).toEqual([
      [inscricao_publica.TIPO_EMAIL_CONFIRMAR, "outra@gmail.com"],
    ]);
  });

  it("casou por SIAPE + nome: o aviso vai ao institucional, nunca ao digitado, e no máximo 1 por 24 h", async () => {
    const { token } = await _com_link();
    await db.insert(e.servidor).values({ siape: "1110654", nome: "Maria Aparecida Souza Lima", email: "maria.lima@ufvjm.edu.br" });
    const pedido = { ...PEDIDO, nome: "Maria Souza", vinculo: "SERVIDOR", siape: "1110654", email: "atacante@exemplo.com" };
    for (let i = 0; i < 3; i++) {
      const r = await novoCliente().post(`/inscricao/${token}`, pedido, { seguir: false });
      expect(r.status).toBe(303);
    }
    const avisos = await _todos_avisos();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.destinatario).toBe("maria.lima@ufvjm.edu.br");
    expect((await db.select().from(e.email_saida)).map((m) => m.destinatario)).not.toContain("atacante@exemplo.com");
    // o pedido ficou no servidor (SIAPE forte com nome parecido), e não num externo paralelo
    const externos = await db.select().from(e.participante).where(eq(e.participante.vinculo, "OUTRO"));
    expect(externos).toHaveLength(0);
  });

  it("já inscrito recebe o aviso 'não precisa pedir de novo'", async () => {
    const { token } = await _com_link();
    await _externo("Joana da Silva", "joana@empresa.com.br");
    await novoCliente().post(`/inscricao/${token}`, PEDIDO, { seguir: false });
    await novoCliente().post(`/inscricao/${token}`, PEDIDO, { seguir: false });
    // o primeiro pedido levou o link de confirmação (no lugar do aviso); o repetido, o aviso
    const tipos = (await _todos_avisos()).map((m) => m.tipo).sort();
    expect(tipos).toEqual([aviso_cadastro.TIPO_REPETIDO]);
    expect(await _confirmacoes()).toHaveLength(1);
    const repetido = (await _todos_avisos()).find((m) => m.tipo === aviso_cadastro.TIPO_REPETIDO)!;
    expect(repetido.corpo).toContain("não é preciso pedir de novo");
  });

  it("brecha fechada: o e-mail institucional mal formado não chega ao visitante (nem 422)", async () => {
    const { token } = await _com_link();
    await db.insert(e.servidor).values({ siape: "1234567", nome: "Rafael Costa Moura", email: "rafael-sem-arroba" });
    const visitante = novoCliente();
    const r = await visitante.post(
      `/inscricao/${token}`,
      { ...PEDIDO, nome: "Rafael Costa Moura", vinculo: "SERVIDOR", siape: "1234567", email: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(r.text).not.toContain("rafael-sem-arroba");
    const tela = (await visitante.get(r.location!)).text;
    expect(tela).not.toContain("rafael-sem-arroba");
    expect(tela).not.toContain("E-mail inválido");
    // e a recusa de dado do cadastro, quando houver, é genérica
    expect(inscricao_publica.RECUSA_GENERICA).not.toMatch(/@|'/);
  });

  it("limite por IP no banco: o nono envio da janela recebe 429", async () => {
    const { token } = await _com_link();
    const IP = { cabecalhos: { "x-nf-client-connection-ip": "200.131.9.9" } };
    for (let i = 0; i < inscricao_publica.LIMITE_POR_JANELA; i++) {
      await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, consentimento: "" }, IP);
    }
    const r = await novoCliente().post(`/inscricao/${token}`, PEDIDO, IP);
    expect(r.status).toBe(429);
    const [linha] = await db
      .select()
      .from(e.limite_login_ip)
      .where(eq(e.limite_login_ip.ip, `${inscricao_publica.PREFIXO_CHAVE_IP}200.131.9.9`));
    expect(linha!.falhas).toBe(inscricao_publica.LIMITE_POR_JANELA + 1);
  });

  it("tempo constante: o pedido repetido não responde mais cedo que o piso", async () => {
    const { token } = await _com_link();
    inscricao_publica.tempo_de_resposta.piso_ms = 300;
    inscricao_publica.tempo_de_resposta.variacao_ms = 0;
    const tempos: number[] = [];
    for (const pedido of [PEDIDO, PEDIDO]) {
      const t0 = performance.now();
      await novoCliente().post(`/inscricao/${token}`, pedido, { seguir: false });
      tempos.push(performance.now() - t0);
    }
    for (const t of tempos) expect(t).toBeGreaterThanOrEqual(295);
  });
});

// =====================================================================
// Conferência dos pedidos pelo link
// =====================================================================
describe("conferência: parece com PTC-…", () => {
  it("mostra o parecido (com nome para quem lê), e 'não é a mesma pessoa' não volta", async () => {
    const { token } = await _com_link();
    const antigo = await _externo("Joana da Silva");
    // sem e-mail: não casa, nasce externo novo, e a equipe vê a semelhança
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, email: "" }, { seguir: false });
    const tela = (await cliente.get("/turmas/pedidos")).text;
    expect(tela).toContain(`parece com <span class="mono">${antigo.identificador_publico}</span>`);
    expect(tela).toContain("Joana da Silva");
    const [pedido] = await db.select().from(e.inscricao).where(eq(e.inscricao.situacao, "AGUARDANDO_EMAIL"));
    const r = await cliente.post(
      "/turmas/pedidos/nao-e-a-mesma",
      { par: `${pedido!.id}:${antigo.id}` },
      { seguir: false },
    );
    expect(_texto(await _mensagem(cliente, r))).toContain("ficam como pessoas diferentes");
    const depois = (await cliente.get("/turmas/pedidos")).text;
    expect(depois).not.toContain(`parece com <span class="mono">${antigo.identificador_publico}</span>`);
  });

  it("sem leitura nominal: o PTC aparece, o nome do outro cadastro não", async () => {
    const { turma_id, token } = await _com_link();
    const antigo = await _externo("Joana da Silva");
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, email: "" }, { seguir: false });
    const sem_nome = await _usuario_com(["turma.inscrever", "treinamento.ver"]);
    const turmas = await naTransacao(async (tx) => {
      // o escopo de `turma.inscrever` do operador inventado: o da turma
      void turma_id;
      return (await import("../src/servicos/pedidos_link.js")).a_conferir(tx, sem_nome);
    });
    const p = turmas.flatMap((t) => t.pedidos)[0];
    expect(p).toBeDefined();
    const x = p!.parecidos.find((y) => y.id === antigo.id)!;
    expect(x.identificador).toBe(antigo.identificador_publico);
    expect(x.nome).toBeNull();
  });

  it("'usar este' junta o cadastro novo do pedido ao existente, e o pedido continua a conferir", async () => {
    const { turma_id, token } = await _com_link();
    const antigo = await _externo("Joana da Silva");
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, email: "" }, { seguir: false });
    const [pedido] = await db.select().from(e.inscricao).where(eq(e.inscricao.situacao, "AGUARDANDO_EMAIL"));
    const r = await cliente.post("/turmas/pedidos/usar-cadastro", { par: `${pedido!.id}:${antigo.id}` }, { seguir: false });
    expect(_texto(await _mensagem(cliente, r))).toContain(`ligado a ${antigo.identificador_publico}`);
    const [depois] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, pedido!.id));
    expect(depois!.participante_id).toBe(antigo.id);
    expect(depois!.situacao).toBe("AGUARDANDO_EMAIL");
    expect(depois!.turma_id).toBe(turma_id);
    expect(await db.select().from(e.participante_mesclagem)).toHaveLength(1);
  });
});

// =====================================================================
// Ficha da turma
// =====================================================================
describe("ficha da turma", () => {
  it("escolher servidor da base com externo parecido pergunta antes; 'juntar' liga os dois", async () => {
    const turma_id = await _turma();
    const externo = await _externo("Marco Antônio Schetino", "marco@ufvjm.edu.br");
    const [s] = await db
      .insert(e.servidor)
      .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino", email: "marco@ufvjm.edu.br" })
      .returning();
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(s!.id) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("parece já ter cadastro");
    expect(r.text).toContain(externo.identificador_publico);
    expect(await db.select().from(e.inscricao)).toHaveLength(0);
    const r2 = await cliente.post(
      `/turmas/${turma_id}/inscricoes`,
      { servidor_id: String(s!.id), juntar_externo_id: String(externo.id) },
      { seguir: false },
    );
    expect(r2.status).toBe(303);
    const [absorvido] = await db.select().from(e.participante).where(eq(e.participante.id, externo.id));
    expect(absorvido!.mesclado_em_id).not.toBeNull();
    expect(await db.select().from(e.inscricao)).toHaveLength(1);
  });

  it("'não é a mesma pessoa' ao cadastrar externo grava o par", async () => {
    const turma_id = await _turma();
    const antigo = await _externo("Joana da Silva");
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes`, { nome: "Joana Silva", vinculo: "TERCEIRIZADO" });
    expect(r.text).toContain("É a mesma pessoa?");
    await cliente.post(
      `/turmas/${turma_id}/inscricoes`,
      { nome: "Joana Silva", vinculo: "TERCEIRIZADO", confirmar_novo: "1", parecido_id: String(antigo.id) },
      { seguir: false },
    );
    expect(await db.select().from(e.participante_par_distinto)).toHaveLength(1);
  });
});

// =====================================================================
// Lote
// =====================================================================
describe("prévia do lote", () => {
  it("a linha parecida pergunta (usar este / criar novo); a escolha vale linha a linha", async () => {
    const turma_id = await _turma();
    const antigo = await _externo("Joana da Silva");
    const lista = "Joana Silva; Limpeza & Cia\nCarlos Nunes Prado";
    const r = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, { lista, vinculo: "TERCEIRIZADO", acao: "conferir" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("a decidir");
    expect(r.text).toContain(`parece com <span class="mono">${antigo.identificador_publico}</span>`);
    const chave = r.text.match(/name="escolha_([0-9a-f]{12})"/)![1]!;
    expect(chave).toBe(inscricao_lote.chave_da_linha("Joana Silva; Limpeza & Cia"));
    // gravar sem escolher: a linha não entra, e volta para a caixa
    const g = await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, { lista, vinculo: "TERCEIRIZADO", acao: "inscrever" });
    expect(g.text).toContain("Joana Silva; Limpeza &amp; Cia");
    expect((await db.select().from(e.inscricao)).length).toBe(1);
    // "usar este": inscreve o cadastro existente
    await cliente.post(`/turmas/${turma_id}/inscricoes/lote`, {
      lista: "Joana Silva; Limpeza & Cia",
      vinculo: "TERCEIRIZADO",
      acao: "inscrever",
      [`escolha_${chave}`]: String(antigo.id),
    });
    const [ins] = await db
      .select()
      .from(e.inscricao)
      .where(and(eq(e.inscricao.turma_id, turma_id), eq(e.inscricao.participante_id, antigo.id)));
    expect(ins).toBeDefined();
  });

  it("'criar novo' cria o externo e grava o par", async () => {
    const turma_id = await _turma();
    const antigo = await _externo("Joana da Silva");
    const coord = await usuarioAtual(db, "coordenador_csso");
    const turma = (await naTransacao((tx) => servico_turma.carregar_turma(tx, turma_id)))!;
    const desfechos = await naTransacao((tx) =>
      inscricao_lote.processar(tx, coord, turma, "Joana Silva", { vinculo: "TERCEIRIZADO", organizacao: "" }, false,
        new Map([[inscricao_lote.chave_da_linha("Joana Silva"), "novo" as const]])),
    );
    expect(desfechos[0]!.resultado).toBe("INSCRITA");
    const [par] = await db.select().from(e.participante_par_distinto);
    expect([par!.participante_a_id, par!.participante_b_id]).toContain(antigo.id);
  });

  it("e-mail conhecido com outro nome também pergunta, em vez de cair calado na pessoa", async () => {
    const turma_id = await _turma();
    await _externo("Pedro Alves", "setor@empresa.com.br");
    const coord = await usuarioAtual(db, "coordenador_csso");
    const turma = (await naTransacao((tx) => servico_turma.carregar_turma(tx, turma_id)))!;
    const desfechos = await naTransacao((tx) =>
      inscricao_lote.processar(tx, coord, turma, "Carla Mendes; setor@empresa.com.br", { vinculo: "TERCEIRIZADO", organizacao: "" }, true),
    );
    expect(desfechos[0]!.resultado).toBe("A_DECIDIR");
  });

  it("sem leitura nominal: não pergunta (RN-19), cria e marca como suspeito, em silêncio", async () => {
    const turma_id = await _turma();
    await _externo("Joana da Silva");
    const sem_nome = await _usuario_com(["turma.inscrever", "treinamento.ver"]);
    const turma = (await naTransacao((tx) => servico_turma.carregar_turma(tx, turma_id)))!;
    const desfechos = await naTransacao((tx) =>
      inscricao_lote.processar(tx, sem_nome, turma, "Joana Silva", { vinculo: "TERCEIRIZADO", organizacao: "" }, false),
    );
    expect(desfechos[0]!.resultado).toBe("INSCRITA");
    expect(desfechos[0]!.como).toBe("externo novo");
    expect(desfechos[0]!.parecidos).toHaveLength(0);
    const [novo] = await db.select().from(e.participante).where(eq(e.participante.nome, "Joana Silva"));
    expect(novo!.suspeita_duplicado_em).not.toBeNull();
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "PARTICIPANTE_SUSPEITO_DUPLICADO"));
    expect(ev!.descricao).not.toContain("Joana");
  });
});

// =====================================================================
// Importação SIAPE
// =====================================================================
describe("importação SIAPE", () => {
  it("só sugere: o servidor novo parecido com externo sai no relatório, e ninguém é ligado", async () => {
    const externo = await _externo("Marco Antônio Schetino", "marco@ufvjm.edu.br");
    const coord = await usuarioAtual(db, "coordenador_csso");
    const r = await naTransacao((tx) =>
      importacao_servidores.importar(tx, coord, [
        { linha: 2, siape: "1110654", nome: "Marco Antônio Alves Schetino", cargo: "", uorg: "", email: "marco@ufvjm.edu.br", campus: "" },
      ]),
    );
    expect(r.criados).toBe(1);
    expect(r.parecidos).toHaveLength(1);
    expect(r.parecidos[0]!.externos[0]!.identificador).toBe(externo.identificador_publico);
    const [depois] = await db.select().from(e.participante).where(eq(e.participante.id, externo.id));
    expect(depois!.mesclado_em_id).toBeNull();
    expect(depois!.servidor_id).toBeNull();
    expect(await db.select().from(e.participante).where(eq(e.participante.vinculo, "SERVIDOR"))).toHaveLength(0);
  });
});

// =====================================================================
// E-mail confirmado pelo link mágico
// =====================================================================
describe("confirmado_em pelo link de acesso", () => {
  it("abrir o link confirma o e-mail do cadastro; e-mail de dois cadastros não confirma", async () => {
    const p = await _externo("Joana da Silva", "joana@empresa.com.br");
    await _externo("Pedro Alves", "dividido@empresa.com.br");
    await _externo("Paula Alves", "dividido@empresa.com.br");
    const token = (nome: string) => nome.padEnd(32, "x");
    const hash = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
    const expira_em = new Date(Date.now() + 3_600_000);
    await db.insert(e.acesso_participante).values([
      { token_hash: hash(token("um")), email_normalizado: "joana@empresa.com.br", expira_em },
      { token_hash: hash(token("dois")), email_normalizado: "dividido@empresa.com.br", expira_em },
    ]);
    await naTransacao((tx) => acesso_participante.abrir(tx, token("um")));
    await naTransacao((tx) => acesso_participante.abrir(tx, token("dois")));
    const [confirmado] = await db
      .select()
      .from(e.participante_email)
      .where(eq(e.participante_email.participante_id, p.id));
    expect(confirmado!.confirmado_em).not.toBeNull();
    const divididos = await db
      .select()
      .from(e.participante_email)
      .where(eq(e.participante_email.email_normalizado, "dividido@empresa.com.br"));
    expect(divididos.every((m) => m.confirmado_em === null)).toBe(true);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "EMAIL_CONFIRMADO_PELO_LINK"));
    expect(ev!.descricao).not.toContain("@");
  });
});

// =====================================================================
// Menu e contador
// =====================================================================
describe("menu sem a junção, contador no Início de Treinamentos", () => {
  it("o item saiu do menu; a rota continua; o cartão 'Possíveis duplicados' conta os grupos", async () => {
    const certificados = modulos.por_codigo("certificados")!;
    expect(certificados.itens.map((i) => i.caminho)).not.toContain("/treinamentos/participantes");
    await entrar(cliente, "coordenador_csso");
    // sem duplicado: sem cartão
    expect((await cliente.get("/treinamentos")).text).not.toContain("Possíveis duplicados");
    await _externo("Joana da Silva");
    await _externo("Joana Silva");
    const inicio = (await cliente.get("/treinamentos")).text;
    expect(inicio).toContain("Possíveis duplicados");
    expect(inicio).toContain("1 possíveis duplicados");
    expect(inicio).toContain('href="/treinamentos/participantes"');
    // a lateral não tem o item
    const lateral = inicio.slice(0, inicio.indexOf("<main") > 0 ? inicio.indexOf("<main") : inicio.length);
    expect(lateral).not.toContain("Juntar duplicados");
    expect((await cliente.get("/treinamentos/participantes")).status).toBe(200);
  });

  it("o atalho da ficha abre a junção com a pessoa e quem parece com ela", async () => {
    const a = await _externo("Joana da Silva");
    const b = await _externo("Joana Silva");
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get(`/treinamentos/participantes?de=${a.id}`)).text;
    expect(tela).toContain(`Quem parece com <span class="mono">${a.identificador_publico}</span>`);
    expect(tela).toContain(b.identificador_publico);
  });

  it("quem não tem participante.mesclar não vê o cartão", async () => {
    await _externo("Joana da Silva");
    await _externo("Joana Silva");
    await entrar(cliente, "secretaria_csso");
    const sec = await usuarioAtual(db, "secretaria_csso");
    if (!sec.pode("participante.mesclar")) {
      expect((await cliente.get("/treinamentos")).text).not.toContain("Possíveis duplicados");
    }
  });
});
