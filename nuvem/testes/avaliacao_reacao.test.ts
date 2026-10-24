/**
 * Avaliação de reação (24/10/2026, `servicos/avaliacao_reacao.ts`): quem pode
 * responder, a resposta única pela conta e pelo link, o link de uso único e
 * sem oráculo, o anonimato (a tabela da resposta não aponta para ninguém e a
 * trilha não diz quem), o piso de 3 e quem lê o resultado.
 *
 * Banco limpo por teste. O envio de e-mail é ligado só onde o convite importa
 * (sem ele, a conclusão não gera link nenhum).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as servico from "../src/servicos/avaliacao_reacao.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import * as servico_turma from "../src/servicos/turma.js";
import type { InscricaoCarregada, TurmaCarregada } from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { INICIO, _usuario } from "./ajuda_certificado.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
});
afterEach(() => {
  delete process.env.CSSO_SMTP_URL;
  delete process.env.CSSO_EMAIL_REMETENTE;
});

const HOJE = datas_br.hoje();

function _ligar_email() {
  process.env.CSSO_SMTP_URL = "smtp://teste.invalid:25";
  process.env.CSSO_EMAIL_REMETENTE = "sisa@teste.ufvjm.edu.br";
}

/** Respostas completas do formulário, com o comentário opcional. */
function _formulario(nota = 4, comentario = ""): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const item of servico.ITENS) campos[item.campo] = String(nota);
  campos.comentario = comentario;
  return campos;
}

function _respostas(nota = 4, comentario = ""): servico.Respostas {
  const f = _formulario(nota, comentario);
  return servico.ler_respostas((n) => f[n] ?? "");
}

interface Turma {
  usuario: UsuarioAtual;
  turma: TurmaCarregada;
  presentes: InscricaoCarregada[];
  ausente: InscricaoCarregada;
  servidor: typeof e.servidor.$inferSelect;
  pelo_servidor: InscricaoCarregada;
}

let _sequencia = 0;

/**
 * Um treinamento com instrutor, uma turma de `presentes` externos (com e-mail)
 * mais um servidor presente e um externo que faltou. Conclui se `concluir`.
 */
async function _turma(d: { presentes?: number; concluir?: boolean; usuario?: UsuarioAtual } = {}): Promise<Turma> {
  const n = ++_sequencia;
  const usuario = d.usuario ?? (await _usuario(db, undefined, `operador${n}`));
  const [treinamento] = await db
    .insert(e.treinamento)
    .values({ codigo: `AVR-${n}`, nome: `Primeiros Socorros ${n}`, carga_horaria_horas: "4" })
    .returning();
  const [instrutor] = await db
    .insert(e.assinatura_instrutor)
    .values({ nome: `Instrutora Externa ${n}`, externo: true, vigencia_inicio: "2020-01-01" })
    .returning();
  const turma = await servico_turma.criar_turma(db, usuario, {
    treinamento: treinamento!,
    data_inicio: INICIO,
    data_fim: INICIO,
    local: "Sala 1",
  });
  await servico_turma.vincular_instrutor(db, usuario, turma, { ...instrutor!, servidor: null } as never);
  const inscritos: InscricaoCarregada[] = [];
  for (let i = 0; i < (d.presentes ?? 3) + 1; i++) {
    const pessoa = await servico_participante.criar_externo(db, {
      nome: `Pessoa ${n}-${i} Avaliadora`,
      vinculo: "TERCEIRIZADO",
      email: `pessoa${n}.${i}@empresa.com.br`,
    });
    inscritos.push(await servico_turma.inscrever(db, usuario, turma, pessoa));
  }
  const [servidor] = await db.insert(e.servidor).values({ siape: String(2000000 + n), nome: `Servidor Avaliador ${n}` }).returning();
  const do_servidor = await servico_turma.inscrever(db, usuario, turma, await servico_participante.de_servidor(db, servidor!, usuario));
  await servico_turma.mudar_situacao(db, usuario, turma, "EM_ANDAMENTO");
  const ausente = inscritos.pop()!;
  for (const i of [...inscritos, do_servidor]) {
    await servico_presenca.lancar_presenca(db, usuario, i, { data: INICIO, presente: true, horas: "4" });
  }
  await servico_presenca.lancar_presenca(db, usuario, ausente, { data: INICIO, presente: false, horas: "0" });
  if (d.concluir ?? true) await servico_turma.mudar_situacao(db, usuario, turma, "CONCLUIDA");
  const fresca = (await servico_turma.carregar_turma(db, turma.id))!;
  const reler = async (i: { id: number }) => (await servico_turma.carregar_inscricao(db, i.id, fresca))!;
  return {
    usuario,
    turma: fresca,
    presentes: await Promise.all(inscritos.map(reler)),
    ausente: await reler(ausente),
    servidor: servidor!,
    pelo_servidor: await reler(do_servidor),
  };
}

/** Os tokens dos convites, tirados do texto dos e-mails (o banco só tem o hash). */
async function _tokens(): Promise<Map<number, string>> {
  const emails = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, servico.TIPO_EMAIL));
  const saida = new Map<number, string>();
  for (const m of emails) {
    const achado = /\/avaliacao\/([A-Za-z0-9_-]+)/.exec(m.corpo ?? "");
    if (achado && m.inscricao_id) saida.set(m.inscricao_id, achado[1]!);
  }
  return saida;
}

async function _contar_respostas(turma_id: number): Promise<number> {
  const [l] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(e.avaliacao_reacao_resposta)
    .where(eq(e.avaliacao_reacao_resposta.turma_id, turma_id));
  return Number(l?.n ?? 0);
}

/** Liga a conta `servidor_consulta` ao servidor e entra com ela. */
async function _entrar_titular(servidor_id: number): Promise<Cliente> {
  await contas(db);
  await db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, "servidor_consulta"));
  return entrar(novoCliente(), "servidor_consulta");
}

// =====================================================================
describe("quem pode responder", () => {
  it("quem frequentou a turma que terminou; nunca quem faltou, nem antes do fim, nem na cancelada, nem depois do prazo", async () => {
    const t = await _turma({ concluir: false });
    const presente = t.presentes[0]!;
    // o dia da turma já passou (INICIO é anteontem): mesmo sem concluir, abre
    expect(servico.pode_avaliar(presente, HOJE)).toBe(true);
    // no próprio dia, sem concluir, ainda não
    expect(servico.impedimento(presente, INICIO)).toContain("abre quando a turma terminar");
    expect(servico.impedimento(t.ausente, HOJE)).toContain("quem frequentou");
    // o prazo: até PRAZO_DIAS depois do fim
    expect(servico.pode_avaliar(presente, somar_dias(INICIO, servico.PRAZO_DIAS))).toBe(true);
    expect(servico.impedimento(presente, somar_dias(INICIO, servico.PRAZO_DIAS + 1))).toContain("prazo");
    // a cancelada
    expect(servico.impedimento({ ...presente, turma: { ...presente.turma, situacao: "CANCELADA" } }, HOJE)).toContain("cancelada");
    // a inscrição cancelada não avalia, mesmo com presença
    expect(servico.pode_avaliar({ ...presente, situacao: "CANCELADA" }, HOJE)).toBe(false);
    // já respondida
    expect(servico.impedimento({ ...presente, avaliacao_respondida: true }, HOJE)).toContain("já avaliou");
  });

  it("a concluída no mesmo dia do fim já abre", async () => {
    const t = await _turma();
    expect(servico.turma_terminou(t.turma, t.turma.data_fim)).toBe(true);
  });
});

// =====================================================================
describe("o convite por e-mail na conclusão", () => {
  it("sai um link por inscrito que frequentou e tem e-mail; concluir de novo não repete", async () => {
    _ligar_email();
    const t = await _turma({ presentes: 3 });
    const tokens = await _tokens();
    // os 3 externos presentes (o servidor do teste não tem e-mail; o ausente não avalia)
    expect([...tokens.keys()].sort()).toEqual(t.presentes.map((i) => i.id).sort());
    const convites = await db.select().from(e.avaliacao_reacao_convite);
    expect(convites).toHaveLength(3);
    // o banco guarda só o hash, nunca o token
    for (const c of convites) expect([...tokens.values()]).not.toContain(c.token_hash);
    expect(convites[0]!.expira_em).toBe(servico.prazo_ate(t.turma));
    // idempotente
    expect(await servico.convidar_turma(db, t.usuario, t.turma)).toBe(0);
    expect(await _tokens()).toEqual(tokens);
    // a trilha conta os convites, sem endereço
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, servico.AVALIACAO_REACAO_CONVITES), eq(e.historico_evento.entidade_id, t.turma.id)));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).not.toContain("@");
  });

  it("sem o envio de e-mail ligado, nenhum link nasce", async () => {
    await _turma();
    expect(await db.select().from(e.avaliacao_reacao_convite)).toHaveLength(0);
    expect(await _tokens()).toEqual(new Map());
  });
});

// =====================================================================
describe("pelo link, sem conta", () => {
  it("abrir não gasta; responder gasta; o link usado e o inventado recebem a mesma resposta", async () => {
    _ligar_email();
    const t = await _turma();
    const token = (await _tokens()).get(t.presentes[0]!.id)!;
    const anonimo = novoCliente();

    const aberto = await anonimo.get(`/avaliacao/${token}`);
    expect(aberto.status).toBe(200);
    expect(aberto.text).toContain("Como foi o treinamento?");
    expect(aberto.text).toContain(t.turma.treinamento.nome);
    expect(aberto.cabecalho("x-robots-tag")).toContain("noindex");
    expect(aberto.cabecalho("cache-control")).toContain("no-store");
    expect(aberto.cabecalho("referrer-policy")).toBe("no-referrer");
    // sem dado da pessoa na página
    expect(aberto.text).not.toContain("Avaliadora");
    expect(aberto.text).not.toContain("@empresa.com.br");
    // abrir de novo continua valendo
    expect((await anonimo.get(`/avaliacao/${token}`)).status).toBe(200);

    // a recusa (nota faltando) não gasta o link
    const incompleto = _formulario(5);
    delete incompleto.nota_local;
    const recusa = await anonimo.post(`/avaliacao/${token}`, incompleto);
    expect(recusa.status).toBe(422);
    expect(recusa.text).toContain("Responda “O local e a infraestrutura”");
    expect(await _contar_respostas(t.turma.id)).toBe(0);

    const feito = await anonimo.post(`/avaliacao/${token}`, _formulario(5, "Aula muito boa."));
    expect(feito.status).toBe(200);
    expect(feito.text).toContain("Obrigado!");
    expect(await _contar_respostas(t.turma.id)).toBe(1);

    // gasto: GET e POST dizem "não vale mais", e com a mesma página do inventado
    const usado = await anonimo.get(`/avaliacao/${token}`);
    const inventado = await anonimo.get(`/avaliacao/${"x".repeat(token.length)}`);
    expect(usado.status).toBe(404);
    expect(inventado.status).toBe(404);
    // iguais, tirada a marca (nonce) que muda a cada resposta
    const sem_marca = (html: string) => html.replace(/nonce="[^"]*"/g, "");
    expect(sem_marca(usado.text)).toBe(sem_marca(inventado.text));
    expect((await anonimo.post(`/avaliacao/${token}`, _formulario(1))).status).toBe(404);
    expect(await _contar_respostas(t.turma.id)).toBe(1);
  });

  it("o link vencido não abre", async () => {
    _ligar_email();
    const t = await _turma();
    const token = (await _tokens()).get(t.presentes[0]!.id)!;
    expect(await servico.abrir_link(db, token, somar_dias(servico.prazo_ate(t.turma), 1))).toBeNull();
    // e a rotina apaga o convite vencido
    expect(await servico.expurgar_convites(db, somar_dias(servico.prazo_ate(t.turma), 1))).toBe(3);
  });

  it("o comentário recusa CPF e termo de saúde, com o rótulo da tela", () => {
    expect(() => _respostas(4, "Meu CPF é 529.982.247-25")).toThrow(/Comentário/);
    expect(() => _respostas(4, "número 52998224725 aqui")).toThrow(/CPF/);
    expect(() => _respostas(4, "Falei da minha doença")).toThrow(/Comentário/);
    expect(() => _respostas(4, "x".repeat(servico.TAMANHO_COMENTARIO + 1))).toThrow(/1000/);
    expect(_respostas(4, "  ótimo  ").comentario).toBe("ótimo");
    expect(_respostas(4).comentario).toBeNull();
  });
});

// =====================================================================
describe("pela conta, em Meus treinamentos", () => {
  it("o botão aparece na turma elegível; responder uma vez marca a inscrição e apaga o convite; a segunda é recusada", async () => {
    _ligar_email();
    const t = await _turma();
    // o servidor ganhou e-mail depois: o convite dele é feito à mão, para provar
    // que responder pela conta invalida o link
    await db.insert(e.avaliacao_reacao_convite).values({ inscricao_id: t.pelo_servidor.id, token_hash: "c".repeat(64), expira_em: "2099-12-31" });
    const titular = await _entrar_titular(t.servidor.id);

    const minhas = await titular.get("/turmas/minhas");
    expect(minhas.text).toContain(`/turmas/minhas/${t.turma.id}/avaliar`);

    const tela = await titular.get(`/turmas/minhas/${t.turma.id}/avaliar`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("A resposta é anônima");

    const feito = await titular.post(`/turmas/minhas/${t.turma.id}/avaliar`, _formulario(3), { seguir: false });
    expect(feito.status).toBe(303);
    expect(feito.location).toContain("/turmas/minhas");
    const [marcada] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, t.pelo_servidor.id));
    expect(marcada!.avaliacao_respondida).toBe(true);
    expect(await db.select().from(e.avaliacao_reacao_convite).where(eq(e.avaliacao_reacao_convite.inscricao_id, t.pelo_servidor.id))).toHaveLength(0);

    // depois: sem botão, com "avaliação enviada"; e a segunda resposta não entra
    const depois = await titular.get("/turmas/minhas");
    expect(depois.text).not.toContain(`/turmas/minhas/${t.turma.id}/avaliar"`);
    expect(depois.text).toContain("avaliação enviada");
    const segunda = await titular.post(`/turmas/minhas/${t.turma.id}/avaliar`, _formulario(1));
    expect(segunda.status).toBe(422);
    expect(segunda.text).toContain("já avaliou");
    expect(await _contar_respostas(t.turma.id)).toBe(1);
  });

  it("o link e a conta disputando a mesma inscrição: só uma resposta entra", async () => {
    _ligar_email();
    const t = await _turma();
    const alvo = t.presentes[0]!;
    const token = (await _tokens()).get(alvo.id)!;
    // a conta respondeu primeiro (o serviço direto: o externo do teste não tem conta)
    await db.update(e.inscricao).set({ avaliacao_respondida: true }).where(eq(e.inscricao.id, alvo.id));
    const r = await novoCliente().post(`/avaliacao/${token}`, _formulario(5));
    expect(r.status).toBe(422);
    expect(await _contar_respostas(t.turma.id)).toBe(0);
  });

  it("a turma em que ele não está inscrito não abre o formulário", async () => {
    const t = await _turma();
    const [outro] = await db.insert(e.servidor).values({ siape: "2999999", nome: "Outro Servidor" }).returning();
    const titular = await _entrar_titular(outro!.id);
    const r = await titular.get(`/turmas/minhas/${t.turma.id}/avaliar`);
    expect(r.url).toContain("/turmas/minhas");
    expect(r.text).toContain("Turma não encontrada entre as suas inscrições");
    const p = await titular.post(`/turmas/minhas/${t.turma.id}/avaliar`, _formulario(5));
    expect(p.text).toContain("Turma não encontrada entre as suas inscrições");
    expect(await _contar_respostas(t.turma.id)).toBe(0);
  });
});

// =====================================================================
describe("anonimato", () => {
  it("a tabela da resposta não aponta para inscrição, participante nem conta, e não guarda hora", async () => {
    const colunas = (await db.execute(
      sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'avaliacao_reacao_resposta'`,
    )) as unknown as { column_name: string; data_type: string }[];
    const nomes = colunas.map((c) => c.column_name);
    expect(nomes).toContain("turma_id");
    for (const proibida of ["inscricao_id", "participante_id", "usuario_id", "servidor_id", "ip", "email"]) {
      expect(nomes).not.toContain(proibida);
    }
    expect(colunas.filter((c) => c.data_type.startsWith("timestamp"))).toEqual([]);
    expect(colunas.find((c) => c.column_name === "id")!.data_type).toBe("uuid");
    const chaves = (await db.execute(
      sql`SELECT ccu.table_name AS alvo FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'avaliacao_reacao_resposta' AND tc.constraint_type = 'FOREIGN KEY'`,
    )) as unknown as { alvo: string }[];
    expect(chaves.map((c) => c.alvo)).toEqual(["turma"]);
  });

  it("a trilha diz que a turma recebeu uma resposta, nunca de quem", async () => {
    const t = await _turma();
    const alvo = t.presentes[0]!;
    await servico.responder_pela_conta(db, await _titular_externo(alvo), alvo, _respostas(5, "bom"));
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.AVALIACAO_REACAO_RECEBIDA));
    expect(eventos).toHaveLength(1);
    const ev = eventos[0]!;
    expect(ev.entidade).toBe("turma");
    expect(ev.entidade_id).toBe(t.turma.id);
    expect(ev.usuario_id).toBeNull();
    expect(ev.ip).toBeNull();
    const texto = JSON.stringify(ev);
    expect(texto).not.toContain(alvo.participante.identificador_publico);
    expect(texto).not.toContain("Avaliadora");
    expect(texto).not.toContain(`"${alvo.id}"`);
    // nenhum outro evento citou a inscrição nesta resposta
    const da_inscricao = await db.select().from(e.historico_evento).where(and(eq(e.historico_evento.entidade, "inscricao"), eq(e.historico_evento.entidade_id, alvo.id)));
    expect(da_inscricao.some((x) => x.tipo_evento.startsWith("AVALIACAO"))).toBe(false);
    // a resposta guarda o dia, sem hora
    const [resposta] = await db.select().from(e.avaliacao_reacao_resposta);
    expect(resposta!.respondida_em).toBe(HOJE);
  });
});

/** A conta de terceirizado do externo inscrito (linha real em `usuario`, ligada ao participante). */
async function _titular_externo(inscricao: InscricaoCarregada): Promise<UsuarioAtual> {
  const base = await _usuario(db, ["treinamento.ver", "turma.inscrever_se"], `externo${inscricao.id}`);
  await db.update(e.participante).set({ usuario_id: base.id }).where(eq(e.participante.id, inscricao.participante_id));
  inscricao.participante.usuario_id = base.id;
  return new UsuarioAtual({
    id: base.id,
    login: base.login,
    nome: base.nome,
    permissoes: ["treinamento.ver", "turma.inscrever_se"],
    perfis: ["terceirizado"],
  });
}

// =====================================================================
describe("o resultado e o piso de 3", () => {
  async function _responder(t: Turma, quantas: number, comentario = (i: number) => `comentário ${i}`) {
    for (let i = 0; i < quantas; i++) {
      const alvo = t.presentes[i]!;
      await servico.responder_pela_conta(db, await _titular_externo(alvo), alvo, _respostas(i + 3 > 5 ? 5 : i + 3, comentario(i)));
    }
  }

  it("com menos de 3 respostas, só a contagem: nem média, nem distribuição, nem comentário", async () => {
    const t = await _turma({ presentes: 3 });
    await _responder(t, 2);
    const r = await servico.resultado_da_turma(db, t.turma);
    expect(r.respostas).toBe(2);
    // 3 externos presentes + o servidor
    expect(r.elegiveis).toBe(4);
    expect(r.abaixo_do_piso).toBe(true);
    expect(r.itens).toEqual([]);
    expect(r.comentarios).toEqual([]);

    await contas(db);
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    const tela = await equipe.get(`/turmas/${t.turma.id}/avaliacao`);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("2</strong> resposta(s) de <strong>4</strong>");
    expect(tela.text).toContain("a partir de 3 respostas");
    expect(tela.text).not.toContain("comentário 0");
    expect(tela.text).not.toContain("Média</th>");
  });

  it("com 3, a média, a distribuição e os comentários", async () => {
    const t = await _turma({ presentes: 3 });
    await _responder(t, 3);
    const r = await servico.resultado_da_turma(db, t.turma);
    expect(r.abaixo_do_piso).toBe(false);
    // notas 3, 4 e 5 em todo item
    expect(r.itens.map((i) => i.media)).toEqual(servico.ITENS.map(() => "4,0"));
    expect(r.itens[0]!.distribuicao).toEqual([0, 0, 1, 1, 1]);
    expect([...r.comentarios].sort()).toEqual(["comentário 0", "comentário 1", "comentário 2"]);

    await contas(db);
    const equipe = await entrar(novoCliente(), "coordenador_csso");
    const tela = await equipe.get(`/turmas/${t.turma.id}/avaliacao`);
    expect(tela.text).toContain("4,0");
    expect(tela.text).toContain("comentário 1");
    // a aba aparece na ficha
    expect((await equipe.get(`/turmas/${t.turma.id}`)).text).toContain(`/turmas/${t.turma.id}/avaliacao`);
  });

  it("os comentários saem embaralhados", () => {
    const lista = Array.from({ length: 30 }, (_, i) => i);
    const ordens = new Set(Array.from({ length: 5 }, () => servico.embaralhar(lista).join(",")));
    expect(ordens.size).toBeGreaterThan(1);
    expect([...servico.embaralhar(lista)].sort((a, b) => a - b)).toEqual(lista);
  });

  it("o consolidado: média por treinamento e por instrutor, com o mesmo piso", async () => {
    const cheia = await _turma({ presentes: 3 });
    await _responder(cheia, 3);
    const rala = await _turma({ presentes: 3 });
    await _responder(rala, 1);
    await contas(db);
    const coord = await entrar(novoCliente(), "coordenador_csso");
    const tela = await coord.get("/treinamentos/avaliacao-de-reacao");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain(cheia.turma.treinamento.nome);
    expect(tela.text).toContain(rala.turma.treinamento.nome);
    expect(tela.text).toContain(cheia.turma.instrutores[0]!.instrutor.nome);
    expect(tela.text).toContain("médias não exibidas");

    const r = await servico.consolidado(db, await usuarioAtual(db, "coordenador_csso"));
    const linha_cheia = r.por_treinamento.find((l) => l.id === cheia.turma.treinamento_id)!;
    const linha_rala = r.por_treinamento.find((l) => l.id === rala.turma.treinamento_id)!;
    expect(linha_cheia.medias[0]).toBe("4,0");
    expect(linha_rala.abaixo_do_piso).toBe(true);
    expect(linha_rala.medias).toEqual([]);
    expect(r.por_instrutor.find((l) => l.nome === rala.turma.instrutores[0]!.instrutor.nome)!.medias).toEqual([]);
  });
});

// =====================================================================
describe("quem lê o resultado", () => {
  it("o titular não lê o resultado da turma nem o consolidado; a ficha não mostra a aba a ele", async () => {
    const t = await _turma();
    const titular = await _entrar_titular(t.servidor.id);
    expect((await titular.get(`/turmas/${t.turma.id}/avaliacao`)).status).toBe(403);
    expect((await titular.get("/treinamentos/avaliacao-de-reacao")).status).toBe(403);
    expect((await titular.get(`/turmas/${t.turma.id}`)).text).not.toContain(`/turmas/${t.turma.id}/avaliacao`);
  });

  it("sem sessão, nada abre", async () => {
    const t = await _turma();
    const r = await cliente.get(`/turmas/${t.turma.id}/avaliacao`, { seguir: false });
    expect(r.status).not.toBe(200);
    expect((await cliente.get("/treinamentos/avaliacao-de-reacao", { seguir: false })).status).not.toBe(200);
  });

  it("quem só consulta (auditor, sem permissão de operar turma) não lê", async () => {
    const t = await _turma();
    await contas(db);
    const auditor = await entrar(novoCliente(), "auditor_interno");
    expect((await auditor.get(`/turmas/${t.turma.id}/avaliacao`)).status).toBe(403);
  });
});
