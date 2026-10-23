/**
 * Portal do servidor, frente TURMAS (22/10/2026): hora de início e de fim da
 * turma, filtros por turno e por treinamento, a agenda .ics e o público
 * "Comunidade externa" na inscrição pública.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import type { Banco } from "../src/db/cliente.js";
import * as email from "../src/servicos/email.js";
import * as ics from "../src/servicos/ics.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as servico_turma from "../src/servicos/turma.js";
import { RegraDaTurma } from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Campos, type Cliente, type Resposta } from "./ajuda";

const HOJE = hoje_iso();
const FUTURO = somar_dias(HOJE, 30);

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
};
const NR10 = { codigo: "NR-10", nome: "Segurança em Eletricidade — NR-10", carga_horaria_horas: "40" };

const PEDIDO = {
  nome: "Joana Prestes da Silva",
  vinculo: "TERCEIRIZADO",
  siape: "",
  email: "joana@empresa.com.br",
  organizacao: "Limpeza & Cia",
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
  inscricao_publica.limpar_limites();
});

afterEach(() => email.definir_transporte(null));

function texto(html: string): string {
  return html
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function msg(c: Cliente, r: Resposta): Promise<string> {
  if (r.status === 200) return texto(r.text);
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return texto((await c.get(r.location!)).text);
}

async function treinamento(dados: Record<string, string> = NR35): Promise<number> {
  const [ja] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, dados.codigo!));
  if (ja) return ja.id;
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post("/treinamentos/catalogo", dados, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, dados.codigo!));
  return t!.id;
}

/** Abre a turma pela tela; devolve a resposta e a última turma gravada. */
async function abrir(dados: Campos = {}, de: Record<string, string> = NR35) {
  const t = await treinamento(de);
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(t), data_inicio: FUTURO, data_fim: FUTURO, local: "Auditório", ...dados },
    { seguir: false },
  );
  const ultima = (await db.select().from(e.turma).orderBy(asc(e.turma.id))).at(-1);
  return { r, turma: ultima };
}

async function turma(dados: Campos = {}, de: Record<string, string> = NR35): Promise<number> {
  const { r, turma: t } = await abrir(dados, de);
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return t!.id;
}

async function ler_turma(id: number) {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!;
}

/** O formulário de edição como a tela manda, com os campos que a turma tem. */
async function editar(id: number, mudanca: Campos) {
  const t = await ler_turma(id);
  return cliente.post(
    `/turmas/${id}`,
    {
      data_inicio: t.data_inicio,
      data_fim: t.data_fim,
      local: t.local ?? "",
      frequencia_minima_percentual: "75",
      ...mudanca,
    },
    { seguir: false },
  );
}

/** A conta `servidor_consulta` ligada a um cadastro de servidor. */
async function servidor_logado(siape = "1110654", nome = "Adelaide Nunes Prata") {
  const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
  await db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "servidor_consulta"));
  const c = novoCliente();
  await entrar(c, "servidor_consulta");
  return { c, servidor: s! };
}

async function abrir_inscricoes(id: number) {
  await db
    .update(e.turma)
    .set({ situacao: "INSCRICOES_ABERTAS", inscricao_aberta_ate: somar_dias(HOJE, 10) })
    .where(eq(e.turma.id, id));
}

async function com_link(dados: Campos = {}) {
  const id = await turma(dados);
  await abrir_inscricoes(id);
  const r = await cliente.post(`/turmas/${id}/link-publico`, {});
  expect(r.status, r.text.slice(0, 500)).toBe(200);
  return { turma_id: id, token: r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]!, tela_link: texto(r.text) };
}

// =====================================================================
// Hora da turma
// =====================================================================
describe("hora da turma", () => {
  it("o cadastro grava a hora e a ficha, a lista e o link mostram “8h às 17h”", async () => {
    const id = await turma({ hora_inicio: "08:00", hora_fim: "17:00" });
    const t = await ler_turma(id);
    expect(t.hora_inicio).toBe("08:00:00");
    expect(t.hora_fim).toBe("17:00:00");
    const ficha = texto((await cliente.get(`/turmas/${id}`)).text);
    expect(ficha).toContain("8h às 17h");
    // o popup de edição devolve a hora no formato do <input type="time">
    expect(ficha).toMatch(/name="hora_inicio"[^>]*value="08:00"/);
    expect(texto((await cliente.get("/turmas")).text)).toContain("8h às 17h");
    // meia hora sai como "8h30"
    const outra = await turma({ hora_inicio: "08:30", hora_fim: "12:00" });
    expect(texto((await cliente.get(`/turmas/${outra}`)).text)).toContain("8h30 às 12h");
  });

  it("hora inválida e fim antes do início são recusados com mensagem clara", async () => {
    const antes = (await db.select().from(e.turma)).length;
    const ruim = await abrir({ hora_inicio: "25:00", hora_fim: "" });
    expect(await msg(cliente, ruim.r)).toContain("Hora de início: use HH:MM");
    const invertida = await abrir({ hora_inicio: "17:00", hora_fim: "08:00" });
    expect(await msg(cliente, invertida.r)).toContain("A hora de término (8h) tem de ser depois da hora de início (17h)");
    const so_fim = await abrir({ hora_inicio: "", hora_fim: "12:00" });
    expect(await msg(cliente, so_fim.r)).toContain("Informe a hora de início");
    expect((await db.select().from(e.turma)).length).toBe(antes);
    // e na edição
    const id = await turma({ hora_inicio: "08:00", hora_fim: "12:00" });
    const r = await editar(id, { hora_inicio: "14:00", hora_fim: "13:00" });
    expect(await msg(cliente, r)).toContain("tem de ser depois da hora de início");
    expect((await ler_turma(id)).hora_fim).toBe("12:00:00");
    // e no serviço, sem tela
    expect(() => servico_turma.normalizar_hora("8:7", "Hora de início")).toThrow(RegraDaTurma);
    expect(servico_turma.normalizar_hora("8h", "x")).toBe("08:00:00");
  });

  it("turma sem hora segue igual: dia inteiro, e a edição antiga não apaga a hora", async () => {
    const sem = await turma();
    const t = await ler_turma(sem);
    expect(t.hora_inicio).toBeNull();
    expect(t.hora_fim).toBeNull();
    expect(t.aceita_comunidade_externa).toBe(false);
    const ficha = texto((await cliente.get(`/turmas/${sem}`)).text);
    expect(ficha).toContain("dia inteiro (sem hora definida)");
    // o formulário sem os campos novos (tela antiga) não mexe na hora gravada
    const com = await turma({ hora_inicio: "08:00", hora_fim: "17:00" });
    const r = await cliente.post(
      `/turmas/${com}`,
      { data_inicio: FUTURO, data_fim: FUTURO, local: "Sala 2", frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const depois = await ler_turma(com);
    expect(depois.local).toBe("Sala 2");
    expect(depois.hora_inicio).toBe("08:00:00");
  });

  it("a alteração da hora e do público vai para a trilha como CAMPO_ALTERADO", async () => {
    const id = await turma({ hora_inicio: "08:00", hora_fim: "12:00" });
    // mesma hora, digitada de outro jeito, não é mudança
    await editar(id, { hora_inicio: "08:00", hora_fim: "12:00" });
    const sem_mudanca = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "turma"), eq(e.historico_evento.entidade_id, id), eq(e.historico_evento.campo, "hora_inicio")));
    expect(sem_mudanca).toHaveLength(0);
    const r = await editar(id, {
      hora_inicio: "13:30",
      hora_fim: "17:00",
      publico_no_formulario: "1",
      aceita_comunidade_externa: "1",
    });
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "turma"), eq(e.historico_evento.entidade_id, id)));
    const por_campo = Object.fromEntries(eventos.filter((x) => x.campo).map((x) => [x.campo, x]));
    expect(por_campo.hora_inicio!.tipo_evento).toBe("CAMPO_ALTERADO");
    expect(por_campo.hora_inicio!.valor_anterior).toBe("08:00:00");
    expect(por_campo.hora_inicio!.valor_novo).toBe("13:30:00");
    expect(por_campo.hora_fim!.valor_novo).toBe("17:00:00");
    expect(por_campo.aceita_comunidade_externa!.valor_novo).toBe(true);
    // desmarcar: a caixa vazia com a marca do formulário vale "não"
    await editar(id, { publico_no_formulario: "1" });
    expect((await ler_turma(id)).aceita_comunidade_externa).toBe(false);
  });
});

// =====================================================================
// Filtros
// =====================================================================
describe("filtros por turno e por treinamento", () => {
  it("o turno filtra /turmas pela hora de início; valor fora da lista é ignorado", async () => {
    const manha = await turma({ hora_inicio: "08:00", hora_fim: "12:00" });
    const tarde = await turma({ hora_inicio: "14:00", hora_fim: "18:00" });
    const noite = await turma({ hora_inicio: "19:00", hora_fim: "22:00" });
    const inteiro = await turma();
    const codigos = Object.fromEntries(
      await Promise.all([manha, tarde, noite, inteiro].map(async (id) => [id, (await ler_turma(id)).codigo])),
    );
    const casos: [string, number][] = [
      ["manha", manha],
      ["tarde", tarde],
      ["noite", noite],
      ["dia_inteiro", inteiro],
    ];
    for (const [turno, esperado] of casos) {
      const html = (await cliente.get(`/turmas?turno=${turno}`)).text;
      for (const id of [manha, tarde, noite, inteiro]) {
        if (id === esperado) expect(html, turno).toContain(codigos[id]);
        else expect(html, turno).not.toContain(codigos[id]);
      }
    }
    const todas = (await cliente.get("/turmas?turno=madrugada';--")).text;
    for (const id of [manha, tarde, noite, inteiro]) expect(todas).toContain(codigos[id]);
  });

  it("/turmas/minhas filtra por treinamento (com o nome e “Ver todas”) e por turno", async () => {
    const nr35 = await turma({ hora_inicio: "08:00", hora_fim: "12:00" });
    const nr10 = await turma({ hora_inicio: "19:00", hora_fim: "22:00" }, NR10);
    await abrir_inscricoes(nr35);
    await abrir_inscricoes(nr10);
    const c35 = (await ler_turma(nr35)).codigo;
    const c10 = (await ler_turma(nr10)).codigo;
    const t35 = (await ler_turma(nr35)).treinamento_id;
    const { c } = await servidor_logado();
    const filtrada = texto((await c.get(`/turmas/minhas?treinamento=${t35}`)).text);
    expect(filtrada).toContain(c35);
    expect(filtrada).not.toContain(c10);
    expect(filtrada).toContain("Mostrando as turmas de");
    expect(filtrada).toContain(NR35.nome);
    expect(filtrada).toContain('href="/turmas/minhas#abertas">Ver todas');
    expect(filtrada).toContain('id="abertas"');
    // id que não existe é ignorado (lista inteira, sem a faixa do filtro)
    const ignorada = texto((await c.get("/turmas/minhas?treinamento=999999")).text);
    expect(ignorada).toContain(c35);
    expect(ignorada).toContain(c10);
    expect(ignorada).not.toContain("Mostrando as turmas de");
    // turno
    const noite = texto((await c.get("/turmas/minhas?turno=noite")).text);
    expect(noite).toContain(c10);
    expect(noite).not.toContain(c35);
    expect(noite).toMatch(/turno=noite#abertas" aria-current="true">Noite/);
    expect(noite).toContain("19h às 22h");
    // treinamento sem turma aberta: o vazio diz que avisaremos
    const t10 = (await ler_turma(nr10)).treinamento_id;
    const nenhuma = texto((await c.get(`/turmas/minhas?treinamento=${t10}&turno=manha`)).text);
    expect(nenhuma).toContain("Nenhuma turma aberta nesta seleção.");
  });
});

// =====================================================================
// Agenda .ics
// =====================================================================
describe("agenda .ics", () => {
  const BASE = {
    id: 7,
    codigo: "TUR-2026-0007",
    situacao: "PLANEJADA",
    local: "Auditório; bloco A, sala 2",
    campus: { nome: "Campus JK" },
    treinamento: { nome: "Trabalho em Altura — NR-35" },
    unidade_promotora: { sigla: "CSSO", nome_extenso: "Coordenadoria de Saúde e Segurança Ocupacional" },
  };
  const AGORA = new Date(Date.UTC(2026, 9, 22, 12, 0, 0));

  it("gera RFC 5545: CRLF, dobra em 75 octetos, escape, UID, dia inteiro e com hora", () => {
    const inteiro = ics.gerar(
      { ...BASE, data_inicio: "2026-11-18", data_fim: "2026-11-18", hora_inicio: null, hora_fim: null },
      { url_base: "https://sisa.ufvjm.edu.br", link: "https://sisa.ufvjm.edu.br/turmas/7", agora: AGORA },
    );
    expect(inteiro.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(inteiro.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(inteiro.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    for (const linha of inteiro.split("\r\n")) expect(Buffer.byteLength(linha, "utf8")).toBeLessThanOrEqual(75);
    const desdobrado = inteiro.replaceAll("\r\n ", "");
    expect(desdobrado).toContain("UID:turma-TUR-2026-0007@sisa.ufvjm.edu.br\r\n");
    expect(desdobrado).toContain("DTSTAMP:20261022T120000Z");
    expect(desdobrado).toContain("DTSTART;VALUE=DATE:20261118\r\n");
    expect(desdobrado).toContain("DTEND;VALUE=DATE:20261119\r\n");
    expect(desdobrado).toContain("LOCATION:Auditório\\; bloco A\\, sala 2\\, Campus JK\r\n");
    expect(desdobrado).toContain("https://sisa.ufvjm.edu.br/turmas/7");
    expect(desdobrado.match(/BEGIN:VEVENT/g)).toHaveLength(1);

    // com hora, dois dias: um VEVENT por dia, em UTC (Brasília + 3h), UID por dia
    const com_hora = ics
      .gerar(
        { ...BASE, data_inicio: "2026-11-18", data_fim: "2026-11-19", hora_inicio: "08:00:00", hora_fim: "17:30:00" },
        { url_base: "https://sisa.ufvjm.edu.br/", link: "https://sisa.ufvjm.edu.br/turmas/7", agora: AGORA },
      )
      .replaceAll("\r\n ", "");
    expect(com_hora.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(com_hora).toContain("DTSTART:20261118T110000Z");
    expect(com_hora).toContain("DTEND:20261118T203000Z");
    expect(com_hora).toContain("DTSTART:20261119T110000Z");
    expect(com_hora).toContain("UID:turma-TUR-2026-0007-20261118@sisa.ufvjm.edu.br");
    expect(com_hora).toContain("UID:turma-TUR-2026-0007-20261119@sisa.ufvjm.edu.br");
    expect(com_hora).not.toContain("VALUE=DATE");

    // escape e dobra isolados
    expect(ics.escapar("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    const longa = "DESCRIPTION:" + "ação ".repeat(40);
    const dobrada = ics.dobrar(longa);
    for (const l of dobrada.split("\r\n")) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    expect(dobrada.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(dobrada.replaceAll("\r\n ", "")).toBe(longa);
  });

  it("só o titular inscrito baixa; o endereço sai da URL base, nunca “cssosisa”", async () => {
    await db
      .insert(e.parametro)
      .values({ chave: "certificado.url_publica", valor: "https://sisa.exemplo.edu.br" })
      .onConflictDoUpdate({ target: e.parametro.chave, set: { valor: "https://sisa.exemplo.edu.br" } });
    const id = await turma({ hora_inicio: "08:00", hora_fim: "17:00" });
    const outra = await turma();
    await abrir_inscricoes(id);
    await abrir_inscricoes(outra);
    const { c } = await servidor_logado();
    // sem inscrição: 404
    expect((await c.get(`/turmas/minhas/${id}/agenda.ics`)).status).toBe(404);
    const pedido = await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    expect(pedido.status).toBe(303);
    const minhas = texto((await c.get("/turmas/minhas")).text);
    expect(minhas).toContain(`href="/turmas/minhas/${id}/agenda.ics"`);
    expect(minhas).toContain("Adicionar à agenda");
    const r = await c.get(`/turmas/minhas/${id}/agenda.ics`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/calendar");
    const codigo = (await ler_turma(id)).codigo;
    const corpo = r.text.replaceAll("\r\n ", "");
    expect(corpo).toContain(`UID:turma-${codigo}@sisa.exemplo.edu.br`);
    expect(corpo).toContain(`https://sisa.exemplo.edu.br/turmas/${id}`);
    expect(corpo).toContain("DTSTART:" + FUTURO.replaceAll("-", "") + "T110000Z");
    expect(corpo.toLowerCase()).not.toContain("cssosisa");
    // a turma de outra pessoa (sem inscrição minha) continua recusada
    expect((await c.get(`/turmas/minhas/${outra}/agenda.ics`)).status).toBe(404);
    // desistiu: a agenda sai junto
    await c.post(`/turmas/${id}/desistir`, { motivo: "férias" }, { seguir: false });
    expect((await c.get(`/turmas/minhas/${id}/agenda.ics`)).status).toBe(404);
  });

  it("o e-mail de inscrição aceita leva o .ics anexo", async () => {
    const { turma_id, token } = await com_link({ hora_inicio: "08:00", hora_fim: "12:00" });
    await novoCliente().post(`/inscricao/${token}`, PEDIDO);
    const [pedido] = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma_id));
    const r = await cliente.post("/turmas/pedidos", { inscricao_id: String(pedido!.id) }, { seguir: false });
    expect(r.status).toBe(303);
    const enviados: email.Mensagem[] = [];
    email.definir_transporte(async (m) => {
      enviados.push(m);
    });
    await email.processar_fila(db);
    const aceito = enviados.find((m) => m.assunto.startsWith("Inscrição confirmada"));
    expect(aceito).toBeTruthy();
    expect(aceito!.anexos).toHaveLength(1);
    expect(aceito!.anexos[0]!.tipo).toContain("text/calendar");
    expect(aceito!.anexos[0]!.nome).toMatch(/^TUR-\d{4}-\d{4}\.ics$/);
    expect(Buffer.from(aceito!.anexos[0]!.bytes).toString("utf8")).toContain("BEGIN:VEVENT");
  });
});

// =====================================================================
// Comunidade externa
// =====================================================================
describe("público: comunidade externa", () => {
  it("sem a marca, VISITANTE e OUTRO não aparecem e são recusados no serviço", async () => {
    const { turma_id, token, tela_link } = await com_link();
    expect(tela_link).toContain("Servidores, terceirizados e discentes da UFVJM");
    const cartaz = texto((await novoCliente().get(`/inscricao/${token}`)).text);
    expect(cartaz).not.toContain('value="VISITANTE"');
    expect(cartaz).not.toContain('value="OUTRO"');
    expect(cartaz).not.toContain("Comunidade externa");
    expect(cartaz).toContain('value="TERCEIRIZADO"');
    const r = await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, vinculo: "VISITANTE" }, { seguir: false });
    // erro de formulário comum (422), não a resposta padrão
    expect(r.status).toBe(422);
    expect(texto(r.text)).toContain("Esta turma é para a comunidade da UFVJM");
    expect(texto(r.text)).not.toContain(inscricao_publica.RESPOSTA_PADRAO);
    expect(await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma_id))).toHaveLength(0);
    // direto no serviço, sem tela
    const t = (await servico_turma.carregar_turma(db, turma_id))!;
    await expect(
      inscricao_publica.pedir(
        db,
        t,
        { ...PEDIDO, vinculo: "OUTRO", consentimento: true },
        "127.0.0.1",
      ),
    ).rejects.toBeInstanceOf(inscricao_publica.PedidoInvalido);
  });

  it("com a marca, o grupo “Comunidade externa” aparece e o VISITANTE é aceito", async () => {
    const { turma_id, token, tela_link } = await com_link({ aceita_comunidade_externa: "1" });
    expect((await ler_turma(turma_id)).aceita_comunidade_externa).toBe(true);
    expect(tela_link).toContain("e a comunidade externa");
    const cartaz = texto((await novoCliente().get(`/inscricao/${token}`)).text);
    expect(cartaz).toContain('<optgroup label="Comunidade externa">');
    expect(cartaz).toContain('value="VISITANTE"');
    expect(cartaz).toContain("Para: Servidores, terceirizados e discentes da UFVJM, e a comunidade externa");
    const r = await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, vinculo: "VISITANTE" }, { seguir: false });
    expect(r.status).toBe(303);
    const [pedido] = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma_id));
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");
    const [pessoa] = await db.select().from(e.participante).where(eq(e.participante.id, pedido!.participante_id));
    expect(pessoa!.vinculo).toBe("VISITANTE");
    // a ficha diz o público
    expect(texto((await cliente.get(`/turmas/${turma_id}`)).text)).toContain("e a comunidade externa");
  });

  it("o serviço da turma grava a marca e a hora (sem tela)", async () => {
    const t = await treinamento();
    const [registro] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, t));
    const u = await usuarioAtual(db, "coordenador_csso");
    const nova = await servico_turma.criar_turma(db, u, {
      treinamento: registro!,
      data_inicio: FUTURO,
      data_fim: FUTURO,
      hora_inicio: "18:30",
      aceita_comunidade_externa: true,
    });
    expect(nova.hora_inicio).toBe("18:30:00");
    expect(nova.hora_fim).toBeNull();
    expect(servico_turma.horario_curto(nova)).toBe("a partir das 18h30");
    expect(servico_turma.turno_de(nova.hora_inicio)).toBe("noite");
    expect(inscricao_publica.vinculos_aceitos(nova)).toContain("VISITANTE");
  });
});
