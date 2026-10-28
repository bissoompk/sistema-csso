/**
 * "Quero ser avisado" da vitrine (/cursos/avise-me): consentimento, confirmação
 * pelo e-mail, resposta sempre igual, saída por POST, aviso da turma sem
 * repetição, chave de ligar, retenção e trilha sem e-mail. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as aviso from "../src/servicos/aviso_interesse.js";
import * as email from "../src/servicos/email.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import { COM_TURMA, type TurmaCarregada } from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();

const HOJE = hoje_iso();
let seq = 0;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
  inscricao_publica.tempo_de_resposta.piso_ms = 0;
  inscricao_publica.tempo_de_resposta.variacao_ms = 0;
  email.definir_transporte(null);
});

async function _cenario() {
  const [campus_a] = await db.insert(e.campus).values({ sigla: "AVA", nome: "Campus Aviso A", cidade: "Diamantina" }).returning();
  const [campus_b] = await db.insert(e.campus).values({ sigla: "AVB", nome: "Campus Aviso B", cidade: "Teófilo Otoni" }).returning();
  const [setor] = await db.insert(e.unidade_uorg).values({ sigla: "SAV", nome_oficial: "SETOR AVISO", nome_extenso: "Setor do Aviso", tipo: "INSTITUTO", campus_id: campus_a!.id }).returning();
  const [outro_setor] = await db.insert(e.unidade_uorg).values({ sigla: "OUT", nome_oficial: "OUTRO SETOR", nome_extenso: "Outro Setor", tipo: "INSTITUTO", campus_id: campus_a!.id }).returning();
  const [curso] = await db.insert(e.treinamento).values({ codigo: "AV-1", nome: "Curso do Aviso", carga_horaria_horas: "8", validade_meses: 12 }).returning();
  const [outro_curso] = await db.insert(e.treinamento).values({ codigo: "AV-2", nome: "Outro Curso", carga_horaria_horas: "8", validade_meses: 12 }).returning();
  return { campus_a: campus_a!, campus_b: campus_b!, setor: setor!, outro_setor: outro_setor!, curso: curso!, outro_curso: outro_curso! };
}
type Cen = Awaited<ReturnType<typeof _cenario>>;

async function _turma(c: Cen, extra: Partial<typeof e.turma.$inferInsert> = {}): Promise<TurmaCarregada> {
  seq += 1;
  const [t] = await db
    .insert(e.turma)
    .values({
      treinamento_id: c.curso.id,
      numero: 900 + seq,
      ano: Number(HOJE.slice(0, 4)),
      codigo: `AVI-${HOJE.slice(0, 4)}-${String(seq).padStart(4, "0")}`,
      data_inicio: somar_dias(HOJE, 20),
      data_fim: somar_dias(HOJE, 21),
      situacao: "INSCRICOES_ABERTAS",
      inscricao_aberta_ate: somar_dias(HOJE, 10),
      unidade_promotora_id: c.setor.id,
      campus_id: c.campus_a.id,
      local: "Auditório",
      vagas: 10,
      divulgar_na_vitrine: true,
      divulgada_em: new Date(),
      descricao: "Curso de formação com conteúdo prático, voltado a servidores da universidade.",
      publico_alvo: ["SERVIDOR"],
      ...extra,
    })
    .returning();
  return (await db.query.turma.findFirst({ where: eq(e.turma.id, t!.id), with: COM_TURMA as never })) as unknown as TurmaCarregada;
}

const MEU = { nome: "Beatriz Fictícia", email: "beatriz@exemplo.test", consentimento: true, campus_id: null as number | null };

async function _caixa(tipo: string) {
  return (await db.select().from(e.email_saida)).filter((m) => m.tipo === tipo);
}
function _token_da_confirmacao(corpo: string): string {
  return /\/cursos\/avise-me\/confirmar\/(\S+)/.exec(corpo)![1]!;
}
async function _confirmado(dados: Partial<typeof MEU> & { tipo: string; alvo: number | null }) {
  await aviso.cadastrar(db, { ...MEU, ...dados }, "203.0.113.9");
  const caixa = await _caixa(aviso.TIPO_CONFIRMAR);
  expect(await aviso.confirmar(db, _token_da_confirmacao(caixa[caixa.length - 1]!.corpo!))).toBe(true);
}

describe("o cadastro", () => {
  it("a resposta é a mesma para e-mail novo, repetido e inválido, e nada sai antes da confirmação", async () => {
    const c = await _cenario();
    const novo = await aviso.cadastrar(db, { ...MEU, tipo: "TREINAMENTO", alvo: c.curso.id }, "203.0.113.9");
    const repetido = await aviso.cadastrar(db, { ...MEU, tipo: "TREINAMENTO", alvo: c.curso.id }, "203.0.113.9");
    expect(novo).toBe(aviso.RESPOSTA_PADRAO);
    expect(repetido).toBe(novo);
    // e-mail inválido: o formulário trata igual (a rota devolve a resposta padrão), e nada é gravado
    await expect(aviso.cadastrar(db, { ...MEU, email: "isto-nao-e-email", tipo: "QUALQUER", alvo: null }, null)).rejects.toThrow("email");
    expect(await db.select().from(e.aviso_interesse)).toHaveLength(1);
    // um e-mail de confirmação só (o reenvio dentro de uma hora não repete) e nenhum aviso de turma
    expect(await _caixa(aviso.TIPO_CONFIRMAR)).toHaveLength(1);
    await aviso.avisar_turma(db, await _turma(c));
    expect(await _caixa(aviso.TIPO_TURMA)).toHaveLength(0);
    const [linha] = await db.select().from(e.aviso_interesse);
    expect(linha!.confirmado_em).toBeNull();
    expect(linha!.consentimento_versao).toBe(aviso.VERSAO_DO_TEXTO);
  });

  it("sem a caixa de consentimento marcada, nada é gravado", async () => {
    const c = await _cenario();
    await expect(aviso.cadastrar(db, { ...MEU, consentimento: false, tipo: "TREINAMENTO", alvo: c.curso.id }, null)).rejects.toThrow("consentimento");
    await expect(aviso.cadastrar(db, { ...MEU, tipo: "TREINAMENTO", alvo: 999999 }, null)).rejects.toThrow("alvo");
    expect(await db.select().from(e.aviso_interesse)).toHaveLength(0);
  });

  it("o reenvio da confirmação espera uma hora", async () => {
    const c = await _cenario();
    const t0 = new Date();
    await aviso.cadastrar(db, { ...MEU, tipo: "QUALQUER", alvo: null }, null, t0);
    await aviso.cadastrar(db, { ...MEU, tipo: "QUALQUER", alvo: null }, null, new Date(t0.getTime() + 30 * 60_000));
    expect(await _caixa(aviso.TIPO_CONFIRMAR)).toHaveLength(1);
    await aviso.cadastrar(db, { ...MEU, tipo: "QUALQUER", alvo: null }, null, new Date(Date.now() + 61 * 60_000));
    expect(await _caixa(aviso.TIPO_CONFIRMAR)).toHaveLength(2);
    expect(c.curso.id).toBeGreaterThan(0);
  });

  it("o token de confirmação vale uma vez e expira em 7 dias", async () => {
    await _cenario();
    await aviso.cadastrar(db, { ...MEU, tipo: "QUALQUER", alvo: null }, null);
    const token = _token_da_confirmacao((await _caixa(aviso.TIPO_CONFIRMAR))[0]!.corpo!);
    expect(await aviso.confirmar(db, token, new Date(Date.now() + 8 * 86_400_000))).toBe(false);
    expect(await aviso.confirmar(db, "token-que-nao-existe-de-jeito-nenhum")).toBe(false);
    expect(await aviso.confirmar(db, token)).toBe(true);
    // já confirmado: o hash foi apagado, o link não vale de novo
    expect(await aviso.confirmar(db, token)).toBe(false);
    const [linha] = await db.select().from(e.aviso_interesse);
    expect(linha!.confirmacao_hash).toBeNull();
    expect(linha!.expira_em).not.toBeNull();
  });
});

describe("a saída", () => {
  it("abrir o link não cancela; só o POST cancela, e sair duas vezes é sair", async () => {
    const c = await _cenario();
    await _confirmado({ tipo: "QUALQUER", alvo: null });
    const [linha] = await db.select().from(e.aviso_interesse);
    const token = aviso.token_de_saida(linha!.id);
    const visitante = novoCliente();
    const pagina = await visitante.get(`/cursos/avise-me/sair/${token}`);
    expect(pagina.status).toBe(200);
    expect(pagina.text).toContain("Confirmar saída");
    expect((await db.select().from(e.aviso_interesse))[0]!.cancelado_em).toBeNull();
    const saiu = await visitante.post(`/cursos/avise-me/sair/${token}`, {}, { seguir: false });
    expect(saiu.status).toBe(200);
    expect(saiu.text).toContain("você saiu");
    expect((await db.select().from(e.aviso_interesse))[0]!.cancelado_em).not.toBeNull();
    expect((await visitante.post(`/cursos/avise-me/sair/${token}`, {}, { seguir: false })).status).toBe(200);
    // cancelado não recebe aviso
    await aviso.definir_ativo(db, await usuarioAtual(db, "coordenador_csso"), true);
    expect(await aviso.avisar_turma(db, await _turma(c))).toBe(0);
  });

  it("token adulterado ou de outro cadastro não vale", async () => {
    await _cenario();
    await _confirmado({ tipo: "QUALQUER", alvo: null });
    const [linha] = await db.select().from(e.aviso_interesse);
    const token = aviso.token_de_saida(linha!.id);
    expect(aviso.id_do_token_de_saida(token)).toBe(linha!.id);
    expect(aviso.id_do_token_de_saida(`${linha!.id + 1}.${token.split(".")[1]}`)).toBeNull();
    expect(aviso.id_do_token_de_saida(token.slice(0, -1) + "x")).toBeNull();
    expect((await novoCliente().post(`/cursos/avise-me/sair/${linha!.id}.${"A".repeat(32)}`, {}, { seguir: false })).status).toBe(404);
  });
});

describe("o aviso da turma", () => {
  it("casa por treinamento, por setor, por qualquer e por campus, e não repete na republicação", async () => {
    const c = await _cenario();
    await aviso.definir_ativo(db, await usuarioAtual(db, "coordenador_csso"), true);
    await _confirmado({ email: "curso@exemplo.test", tipo: "TREINAMENTO", alvo: c.curso.id });
    await _confirmado({ email: "outro@exemplo.test", tipo: "TREINAMENTO", alvo: c.outro_curso.id });
    await _confirmado({ email: "setor@exemplo.test", tipo: "SETOR", alvo: c.setor.id });
    await _confirmado({ email: "outrosetor@exemplo.test", tipo: "SETOR", alvo: c.outro_setor.id });
    await _confirmado({ email: "qualquer@exemplo.test", tipo: "QUALQUER", alvo: null });
    await _confirmado({ email: "campusb@exemplo.test", tipo: "QUALQUER", alvo: null, campus_id: c.campus_b.id });
    await _confirmado({ email: "campusa@exemplo.test", tipo: "QUALQUER", alvo: null, campus_id: c.campus_a.id });
    // e uma pessoa que pediu e NÃO confirmou
    await aviso.cadastrar(db, { ...MEU, email: "naoconfirmou@exemplo.test", tipo: "QUALQUER", alvo: null }, null);

    const turma = await _turma(c);
    expect(await aviso.avisar_turma(db, turma)).toBe(4);
    const para = (await _caixa(aviso.TIPO_TURMA)).map((m) => m.destinatario).sort();
    expect(para).toEqual(["campusa@exemplo.test", "curso@exemplo.test", "qualquer@exemplo.test", "setor@exemplo.test"]);
    // republicar não manda de novo
    expect(await aviso.avisar_turma(db, turma)).toBe(0);
    expect(await _caixa(aviso.TIPO_TURMA)).toHaveLength(4);

    const msg = (await _caixa(aviso.TIPO_TURMA)).find((m) => m.destinatario === "curso@exemplo.test")!;
    expect(msg.corpo).toContain(`/cursos/${turma.codigo}`);
    expect(msg.corpo).toMatch(/\/cursos\/avise-me\/sair\/\d+\.[A-Za-z0-9_-]{32}/);
    expect(msg.expira_em).not.toBeNull();
    expect((await aviso.contar_para_turma(db, turma)).aguardando).toBe(4);
  });

  it("chave desligada: o cadastro funciona e nada é enfileirado; turma não divulgada ou fechada também não", async () => {
    const c = await _cenario();
    await _confirmado({ tipo: "QUALQUER", alvo: null });
    expect(await aviso.ativo(db)).toBe(false);
    expect(await aviso.avisar_turma(db, await _turma(c))).toBe(0);
    await aviso.definir_ativo(db, await usuarioAtual(db, "coordenador_csso"), true);
    expect(await aviso.avisar_turma(db, await _turma(c, { divulgar_na_vitrine: false }))).toBe(0);
    expect(await aviso.avisar_turma(db, await _turma(c, { situacao: "PLANEJADA", inscricao_aberta_ate: null }))).toBe(0);
    expect(await aviso.avisar_turma(db, await _turma(c))).toBe(1);
  });

  it("publicar pela tela avisa quem pediu, e o aviso sai com List-Unsubscribe", async () => {
    const c = await _cenario();
    await aviso.definir_ativo(db, await usuarioAtual(db, "coordenador_csso"), true);
    await _confirmado({ tipo: "TREINAMENTO", alvo: c.curso.id });
    const coord = await usuarioAtual(db, "coordenador_csso");
    const turma = await _turma(c, { divulgar_na_vitrine: false, divulgada_em: null, criado_por: coord.id });
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(`/turmas/${turma.id}/vitrine`, { divulgar: "sim", modalidade: "PRESENCIAL", publico: ["SERVIDOR"] }, { seguir: false });
    expect(r.status).toBe(303);
    expect(await _caixa(aviso.TIPO_TURMA)).toHaveLength(1);

    const enviados: email.Mensagem[] = [];
    email.definir_transporte(async (m) => void enviados.push(m));
    await email.processar_fila(db);
    email.definir_transporte(null);
    const aviso_enviado = enviados.find((m) => m.assunto.startsWith("Inscrições abertas"));
    expect(aviso_enviado?.cabecalhos?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(aviso_enviado?.cabecalhos?.["List-Unsubscribe"]).toMatch(/^<https?:\/\/.+\/cursos\/avise-me\/sair\/\d+\./);
    // a confirmação não leva o cabeçalho
    expect(enviados.find((m) => m.assunto.startsWith("Confirme"))?.cabecalhos).toBeUndefined();
  });
});

describe("a retenção e a trilha", () => {
  it("apaga o não confirmado em 7 dias, o expirado, o cancelado em 30 e limpa o IP em 90", async () => {
    await _cenario();
    await aviso.cadastrar(db, { ...MEU, email: "a@exemplo.test", tipo: "QUALQUER", alvo: null }, "203.0.113.1");
    await _confirmado({ email: "b@exemplo.test", tipo: "QUALQUER", alvo: null });
    await _confirmado({ email: "c@exemplo.test", tipo: "QUALQUER", alvo: null });
    const linhas = await db.select().from(e.aviso_interesse);
    const por = (m: string) => linhas.find((l) => l.email === m)!;
    const dias = (n: number) => new Date(Date.now() - n * 86_400_000);
    await db.update(e.aviso_interesse).set({ criado_em: dias(8) }).where(eq(e.aviso_interesse.id, por("a@exemplo.test").id));
    await db.update(e.aviso_interesse).set({ expira_em: somar_dias(HOJE, -1) }).where(eq(e.aviso_interesse.id, por("b@exemplo.test").id));
    await db.update(e.aviso_interesse).set({ cancelado_em: dias(31) }).where(eq(e.aviso_interesse.id, por("c@exemplo.test").id));
    const r = await aviso.expurgar(db);
    expect(r).toMatchObject({ nao_confirmados: 1, expirados: 1, cancelados: 1 });
    expect(await db.select().from(e.aviso_interesse)).toHaveLength(0);

    await _confirmado({ email: "d@exemplo.test", tipo: "QUALQUER", alvo: null });
    const [d] = await db.select().from(e.aviso_interesse);
    expect(d!.ip_consentimento).toBe("203.0.113.9");
    await db.update(e.aviso_interesse).set({ consentimento_em: dias(91) });
    expect((await aviso.expurgar(db)).ips).toBe(1);
    expect((await db.select().from(e.aviso_interesse))[0]!.ip_consentimento).toBeNull();
  });

  it("a trilha tem o id e nunca o e-mail nem o nome", async () => {
    await _cenario();
    await _confirmado({ tipo: "QUALQUER", alvo: null });
    const [linha] = await db.select().from(e.aviso_interesse);
    await aviso.descadastrar(db, aviso.token_de_saida(linha!.id));
    const eventos = (await db.select().from(e.historico_evento)).filter((h) => h.entidade === "aviso_interesse");
    expect(eventos.map((h) => h.tipo_evento).sort()).toEqual(["AVISO_INTERESSE_CANCELADO", "AVISO_INTERESSE_CONFIRMADO", "AVISO_INTERESSE_CRIADO"]);
    const tudo = JSON.stringify(eventos);
    expect(tudo).not.toContain("beatriz");
    expect(tudo).not.toContain("Beatriz");
    expect(tudo).toContain(`#${linha!.id}`);
  });

  it("o pedido de acesso do titular encontra o cadastro pelo e-mail, sem devolver nome", async () => {
    await _cenario();
    await _confirmado({ tipo: "QUALQUER", alvo: null });
    expect(await aviso.do_titular(db, "BEATRIZ@exemplo.test")).toEqual([{ tipo: "QUALQUER", confirmado: true }]);
    expect(await aviso.do_titular(db, "ninguem@exemplo.test")).toEqual([]);
  });
});

describe("as telas", () => {
  it("o estado vazio traz o formulário com o setor do filtro marcado; sem JS, sem estilo inline", async () => {
    const c = await _cenario();
    const visitante = novoCliente();
    const lista = await visitante.get(`/cursos?setor=${c.setor.sigla}`);
    expect(lista.status).toBe(200);
    expect(lista.text).toContain("Quero ser avisado");
    expect(lista.text).toContain(`value="SETOR:${c.setor.id}" checked`);
    expect(lista.text).toContain("Concordo em receber e-mails da SISA sobre a abertura de turmas");
    // a caixa de consentimento nasce desmarcada e não há campo de telefone
    expect(lista.text).not.toMatch(/name="consentimento"[^>]*checked/);
    expect(lista.text).not.toMatch(/telefone|celular/i);
    expect(lista.text).not.toMatch(/\sstyle=/);
  });

  it("a ficha de turma cheia oferece o aviso do curso; a aberta não", async () => {
    const c = await _cenario();
    const aberta = await _turma(c);
    const cheia = await _turma(c, { vagas: 1 });
    const [serv] = await db.insert(e.servidor).values({ siape: "7900001", nome: "Alguém Fictício", unidade_uorg_id: c.setor.id }).returning();
    const { de_servidor } = await import("../src/servicos/participante.js");
    const p = await de_servidor(db, serv!);
    await db.insert(e.inscricao).values({ turma_id: cheia.id, participante_id: p.id, situacao: "CONFIRMADA" });
    const visitante = novoCliente();
    const ficha_cheia = await visitante.get(`/cursos/${cheia.codigo}`);
    expect(ficha_cheia.text).toContain(`value="TREINAMENTO:${c.curso.id}" checked`);
    expect((await visitante.get(`/cursos/${aberta.codigo}`)).text).not.toContain('action="/cursos/avise-me"');
  });

  it("o POST responde igual para novo, repetido e inválido, e o robô da isca não grava", async () => {
    const c = await _cenario();
    const v = novoCliente();
    const campos = { nome: "Beatriz Fictícia", email: "beatriz@exemplo.test", interesse: `TREINAMENTO:${c.curso.id}`, consentimento: "sim", campus: "" };
    const novo = await v.post("/cursos/avise-me", campos, { seguir: false });
    const repetido = await v.post("/cursos/avise-me", campos, { seguir: false });
    const invalido = await v.post("/cursos/avise-me", { ...campos, email: "nao-e-email" }, { seguir: false });
    for (const r of [novo, repetido, invalido]) {
      expect(r.status).toBe(200);
      expect(r.text).toContain(aviso.RESPOSTA_PADRAO);
    }
    const isca = await v.post("/cursos/avise-me", { ...campos, email: "robo@exemplo.test", site: "http://spam" }, { seguir: false });
    expect(isca.text).toContain(aviso.RESPOSTA_PADRAO);
    expect((await db.select().from(e.aviso_interesse)).map((l) => l.email)).toEqual(["beatriz@exemplo.test"]);
    // sem consentimento marcado, o formulário reclama e nada é gravado
    const sem = await v.post("/cursos/avise-me", { ...campos, email: "outra@exemplo.test", consentimento: "" }, { seguir: false });
    expect(sem.status).toBe(422);
    expect(await db.select().from(e.aviso_interesse)).toHaveLength(1);
  });

  it("o link de confirmação abre a página de pronto; o inválido dá 410", async () => {
    await _cenario();
    await aviso.cadastrar(db, { ...MEU, tipo: "QUALQUER", alvo: null }, null);
    const token = _token_da_confirmacao((await _caixa(aviso.TIPO_CONFIRMAR))[0]!.corpo!);
    const v = novoCliente();
    expect((await v.get(`/cursos/avise-me/confirmar/${token}`)).text).toContain("você será avisado");
    expect((await v.get(`/cursos/avise-me/confirmar/${token}`)).status).toBe(410);
  });
});

describe("a ficha da turma para a equipe", () => {
  it("mostra só a contagem, sem nome nem e-mail, e quem gerencia liga e desliga a chave", async () => {
    const c = await _cenario();
    await _confirmado({ tipo: "TREINAMENTO", alvo: c.curso.id });
    const coord = await usuarioAtual(db, "coordenador_csso");
    const turma = await _turma(c, { criado_por: coord.id });
    await entrar(cliente, "coordenador_csso");
    const ficha = await cliente.get(`/turmas/${turma.id}?aba=inscricoes`);
    expect(ficha.text).toContain("1 pessoa aguarda aviso de turma como esta");
    expect(ficha.text).toContain("O aviso está desligado");
    expect(ficha.text).not.toContain("beatriz@exemplo.test");
    expect(ficha.text).not.toContain("Beatriz");
    const liga = await cliente.post("/turmas/vitrine/aviso-interesse", { ligado: "sim", volta: `/turmas/${turma.id}?aba=inscricoes` }, { seguir: false });
    expect(liga.status).toBe(303);
    expect(await aviso.ativo(db)).toBe(true);
    expect((await cliente.get(`/turmas/${turma.id}?aba=inscricoes`)).text).toContain("O aviso está ligado");
    await cliente.post("/turmas/vitrine/aviso-interesse", { ligado: "nao" }, { seguir: false });
    expect(await aviso.ativo(db)).toBe(false);
  });

  it("quem não gerencia treinamentos não mexe na chave", async () => {
    await _cenario();
    const servidor = await entrar(novoCliente(), "servidor_consulta");
    const r = await servidor.post("/turmas/vitrine/aviso-interesse", { ligado: "sim" }, { seguir: false });
    expect(r.status).toBe(403);
    expect(await aviso.ativo(db)).toBe(false);
  });
});
