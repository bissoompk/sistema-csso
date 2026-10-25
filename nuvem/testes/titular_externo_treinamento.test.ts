/**
 * NUVEM (23/10/2026): o terceirizado e o discente (contas sem `servidor_id`,
 * perfis `terceirizado`/`discente`) pedem a própria vaga, veem "Meus
 * treinamentos", desistem e leem "Meus certificados" — pelo participante ligado
 * à conta (`participante.usuario_id`, `servicos/titular_externo.ts`). O
 * servidor continua pelo `servidor_id`.
 *
 * Banco limpo por teste: as asserções contam participantes e inscrições.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-titular-externo-"));

import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as anexos from "../src/servicos/anexos.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";
import * as titular_externo from "../src/servicos/titular_externo.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, naTransacao, usuarioAtual, type Cliente, type Resposta } from "./ajuda.js";
import { INICIO, _modelo_com_tags, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

const HOJE = hoje_iso();
const FUTURO = somar_dias(HOJE, 30);

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
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
});

// =====================================================================
// Montagem
// =====================================================================
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

let treinamento_id: number | null = null;
async function treinamento(): Promise<number> {
  if (treinamento_id !== null) {
    const [ainda] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, treinamento_id));
    if (ainda) return treinamento_id;
  }
  const r = await cliente.post("/treinamentos/catalogo", NR35, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, NR35.codigo));
  treinamento_id = t!.id;
  return t!.id;
}

/** Uma turma com inscrições abertas, criada pelo coordenador na tela. */
async function turma_aberta(): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(await treinamento()), data_inicio: FUTURO, data_fim: FUTURO, local: "Auditório" },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const id = (await db.select().from(e.turma).orderBy(asc(e.turma.id))).at(-1)!.id;
  await db.update(e.turma).set({ situacao: "INSCRICOES_ABERTAS" }).where(eq(e.turma.id, id));
  return id;
}

async function conta(login: string) {
  const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

async function logado(login: string): Promise<Cliente> {
  const c = novoCliente();
  await entrar(c, login);
  return c;
}

async function participantes() {
  return db.select().from(e.participante).orderBy(asc(e.participante.id));
}

async function inscricoes() {
  return db.select().from(e.inscricao).orderBy(asc(e.inscricao.id));
}

/** O trecho "Minhas inscrições" da tela. */
function minhas(html: string): string {
  const i = html.indexOf('<h2 id="minhas">');
  expect(i).toBeGreaterThan(-1);
  return html.slice(i);
}

/**
 * Treinamento com modelo, turma concluída com `pessoa` aprovada, certificado
 * emitido. Tudo pelos serviços (a montagem de `portal_certificados`).
 */
async function certificado_de(pessoa: servico_participante.ParticipanteCarregado, operador: UsuarioAtual, codigo = "BRIG") {
  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo, nome: `Brigada ${codigo}`, carga_horaria_horas: "4", validade_meses: 12, norma_referencia: "NR-23" })
    .returning();
  const modelo = await _modelo_com_tags(db, t!);
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, t!.id));
  const [fresco] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id));
  const [instrutor] = await db
    .insert(e.assinatura_instrutor)
    .values({
      nome: `Instrutora ${codigo}`,
      titulo: "Engenheira de Segurança do Trabalho",
      conselho: "CREA",
      registro_conselho: `MG-${codigo}`,
      externo: true,
      vigencia_inicio: "2020-01-01",
    })
    .returning();
  const turma = await servico_turma.criar_turma(db, operador, {
    treinamento: fresco!,
    data_inicio: INICIO,
    data_fim: INICIO,
    local: "Auditório",
    nota_minima_aprovacao: null,
  });
  await servico_turma.vincular_instrutor(db, operador, turma, { ...instrutor!, servidor: null } as never);
  const inscricao = await servico_turma.inscrever(db, operador, turma, pessoa);
  await servico_turma.mudar_situacao(db, operador, turma, "EM_ANDAMENTO");
  await servico_presenca.lancar_presenca(db, operador, inscricao, { data: INICIO, presente: true, horas: "4" });
  await servico_turma.mudar_situacao(db, operador, turma, "CONCLUIDA");
  const fresca = (await servico_turma.carregar_turma(db, turma.id))!;
  const relida = (await servico_turma.carregar_inscricao(db, inscricao.id, fresca))!;
  return (await servico.emitir(db, operador, relida)).certificado;
}

// =====================================================================
// Inscrição própria
// =====================================================================
describe("o terceirizado e o discente pedem a própria vaga", () => {
  it("inscrever-se cria o participante ligado à conta, com o vínculo do perfil e os dados da conta", async () => {
    const id = await turma_aberta();
    const c = await logado("terceirizado");
    const r = await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    expect(await msg(c, r)).toContain("Inscrição confirmada em");

    const terceirizado = await conta("terceirizado");
    const [p, ...resto] = await participantes();
    expect(resto).toHaveLength(0);
    expect(p!.usuario_id).toBe(terceirizado.id);
    expect(p!.servidor_id).toBeNull();
    expect(p!.vinculo).toBe("TERCEIRIZADO");
    expect(p!.nome).toBe(terceirizado.nome);
    const emails = await db.select().from(e.participante_email).where(eq(e.participante_email.participante_id, p!.id));
    expect(emails.map((x) => x.email_normalizado)).toEqual([terceirizado.email.toLowerCase()]);

    const [i] = await inscricoes();
    expect(i!.participante_id).toBe(p!.id);
    // havendo vaga, a inscrição já nasce confirmada (25/10/2026)
    expect(i!.situacao).toBe("CONFIRMADA");
    expect(i!.inscrito_por).toBe(terceirizado.id);

    // a trilha da criação não leva o nome da pessoa
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "participante"));
    expect(trilha.map((x) => x.tipo_evento)).toContain("PARTICIPANTE_CRIADO");
    for (const ev of trilha) expect(ev.descricao).not.toContain(terceirizado.nome);
  });

  it("a inscrição aparece em Meus treinamentos, sem o aviso de conta sem servidor", async () => {
    const id = await turma_aberta();
    const c = await logado("discente");
    const antes = texto((await c.get("/turmas/minhas")).text);
    expect(antes).not.toContain("Sua conta não está ligada a um cadastro de servidor");
    await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const tela = (await c.get("/turmas/minhas")).text;
    expect(tela).not.toContain("Sua conta não está ligada a um cadastro de servidor");
    expect(minhas(tela)).toContain(`href="/turmas/${id}"`);
    expect(minhas(tela)).toContain(`/turmas/minhas/${id}/agenda.ics`);
    const [p] = await participantes();
    expect(p!.vinculo).toBe("DISCENTE");
    // a agenda da própria turma
    const ics = await c.get(`/turmas/minhas/${id}/agenda.ics`);
    expect(ics.status).toBe(200);
    // e a ficha da turma mostra a própria inscrição, sem o botão de pedir de novo
    const ficha = texto((await c.get(`/turmas/${id}`)).text);
    expect(ficha).not.toContain(`action="/turmas/${id}/inscrever-me"`);
  });

  it("a ficha da turma aberta oferece o pedido à conta externa ainda sem inscrição", async () => {
    const id = await turma_aberta();
    const c = await logado("terceirizado");
    const ficha = (await c.get(`/turmas/${id}`)).text;
    expect(ficha).toContain(`/turmas/${id}/inscrever-me`);
  });

  it("a segunda inscrição não cria outro participante", async () => {
    const a = await turma_aberta();
    const b = await turma_aberta();
    const c = await logado("terceirizado");
    await c.post(`/turmas/${a}/inscrever-me`, {}, { seguir: false });
    await c.post(`/turmas/${b}/inscrever-me`, {}, { seguir: false });
    const todos = await participantes();
    expect(todos).toHaveLength(1);
    const lista = await inscricoes();
    expect(lista).toHaveLength(2);
    expect(new Set(lista.map((i) => i.participante_id))).toEqual(new Set([todos[0]!.id]));
    // pedir de novo a mesma turma é recusado, sem participante novo
    const de_novo = await c.post(`/turmas/${a}/inscrever-me`, {}, { seguir: false });
    expect(de_novo.status).toBe(303);
    expect(await participantes()).toHaveLength(1);
    expect(await inscricoes()).toHaveLength(2);
  });

  it("desistir funciona para a conta externa", async () => {
    const id = await turma_aberta();
    const c = await logado("discente");
    await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const r = await c.post(`/turmas/${id}/desistir`, { motivo: "mudança de horário" }, { seguir: false });
    expect(await msg(c, r)).toContain("Desistência registrada");
    const [i] = await inscricoes();
    expect(i!.situacao).toBe("CANCELADA");
    expect(i!.motivo_cancelamento).toBe("mudança de horário");
  });

  it("o cadastro externo com o e-mail CONFIRMADO da conta é ligado a ela, não duplicado", async () => {
    const terceirizado = await conta("terceirizado");
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const ja = await naTransacao(async (tx) => {
      const p = await servico_participante.criar_externo(tx, {
        nome: "Nome do Cadastro Antigo",
        vinculo: "TERCEIRIZADO",
        organizacao: "Limpeza & Cia",
        usuario: coordenador,
      });
      await servico_participante.registrar_email(tx, p, terceirizado.email, {
        origem: "INSCRICAO_PUBLICA",
        confirmado_em: new Date(),
      });
      return p;
    });
    const id = await turma_aberta();
    const c = await logado("terceirizado");
    await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const todos = await participantes();
    expect(todos).toHaveLength(1);
    expect(todos[0]!.id).toBe(ja.id);
    expect(todos[0]!.usuario_id).toBe(terceirizado.id);
    // o cadastro antigo fica como estava: a ligação não reescreve o nome
    expect(todos[0]!.nome).toBe("Nome do Cadastro Antigo");
    const [i] = await inscricoes();
    expect(i!.participante_id).toBe(ja.id);
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, ja.id));
    const ligacao = trilha.find((x) => x.entidade === "participante" && x.campo === "usuario_id");
    expect(ligacao?.descricao).toContain(ja.identificador_publico);
    expect(ligacao?.descricao).not.toContain("Nome do Cadastro Antigo");
  });

  it("o e-mail igual mas NÃO confirmado não liga: nasce outro participante", async () => {
    const terceirizado = await conta("terceirizado");
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    await naTransacao((tx) =>
      servico_participante.criar_externo(tx, {
        nome: "Alguém Digitou Este E-mail",
        vinculo: "VISITANTE",
        email: terceirizado.email,
        usuario: coordenador,
      }),
    );
    const id = await turma_aberta();
    const c = await logado("terceirizado");
    await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const todos = await participantes();
    expect(todos).toHaveLength(2);
    expect(todos[0]!.usuario_id).toBeNull();
    expect(todos[1]!.usuario_id).toBe(terceirizado.id);
  });

  it("a conta externa não vê nem desiste da inscrição de outro participante", async () => {
    const id = await turma_aberta();
    // a discente se inscreve; um externo sem conta é inscrito pela equipe
    const d = await logado("discente");
    await d.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    await naTransacao(async (tx) => {
      const outro = await servico_participante.criar_externo(tx, { nome: "Pessoa Sem Conta", vinculo: "TERCEIRIZADO", usuario: coordenador });
      await servico_turma.inscrever(tx, coordenador, (await servico_turma.carregar_turma(tx, id))!, outro);
    });

    const t = await logado("terceirizado");
    const tela = (await t.get("/turmas/minhas")).text;
    expect(minhas(tela)).not.toContain(`href="/turmas/${id}"`);
    const r = await t.post(`/turmas/${id}/desistir`, {}, { seguir: false });
    expect(await msg(t, r)).toContain("Você não tem inscrição em");
    expect((await t.get(`/turmas/minhas/${id}/agenda.ics`)).status).toBe(404);
    // nada mudou nas duas inscrições
    expect((await inscricoes()).map((i) => i.situacao).filter((s) => s === "CANCELADA")).toHaveLength(0);

    // o serviço também recusa a inscrição alheia
    const usuario_t = await usuarioAtual(db, "terceirizado");
    const [alheia] = await servico_turma.inscricoes_do_titular(db, await usuarioAtual(db, "discente"));
    expect(alheia).toBeDefined();
    await expect(servico_turma.desistir(db, usuario_t, alheia!)).rejects.toThrow("Esta inscrição não é sua.");
    expect(await servico_turma.inscricoes_do_titular(db, usuario_t)).toHaveLength(0);
  });
});

// =====================================================================
// Meus certificados
// =====================================================================
describe("Meus certificados da conta externa", () => {
  it("o certificado emitido para o participante da conta aparece, abre a ficha e entra no comprovante", async () => {
    const operador = await _usuario(db);
    const usuario_t = await usuarioAtual(db, "terceirizado");
    const pessoa = await naTransacao((tx) => titular_externo.garantir_participante_da_conta(tx, usuario_t));
    const certificado = await certificado_de(pessoa, operador);

    const c = await logado("terceirizado");
    const tela = texto((await c.get("/certificados/meus")).text);
    expect(tela).not.toContain("Sua conta não está ligada a um cadastro de servidor");
    expect(tela).toContain("1 certificado emitido");
    expect(tela).toContain(`titulo-cert-${certificado.id}"`);

    const ficha = await c.get(`/certificados/${certificado.id}`, { seguir: false });
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain(certificado.chave_validacao);

    const comprovante = await c.get("/certificados/meus/comprovante", { seguir: false });
    expect(comprovante.status).toBe(200);
    expect(texto(comprovante.text)).toContain((await conta("terceirizado")).nome);
    expect(comprovante.text).toContain(`/validar/${certificado.chave_validacao}`);

    // com certificado, o menu oferece o comprovante
    expect(ficha.text).toContain('href="/certificados/meus/comprovante"');

    // a segunda via do próprio sai só em PDF: o Word é da equipe (25/10/2026)
    const via = await c.get(`/certificados/${certificado.id}/documento`, { seguir: false });
    expect(via.status).toBe(303);
    expect(via.location).toBe(`/certificados/${certificado.id}/pdf`);
    const pdf = await c.get(`/certificados/${certificado.id}/pdf`, { seguir: false });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("pdf");
  });

  it("a conta externa não vê o certificado de outro participante", async () => {
    const operador = await _usuario(db);
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const outro = await naTransacao((tx) =>
      servico_participante.criar_externo(tx, { nome: "Pessoa Sem Conta", vinculo: "TERCEIRIZADO", usuario: coordenador }),
    );
    const alheio = await certificado_de(outro, operador, "BRIGA");
    const usuario_d = await usuarioAtual(db, "discente");
    const minha = await naTransacao((tx) => titular_externo.garantir_participante_da_conta(tx, usuario_d));
    const meu = await certificado_de(minha, operador, "BRIGB");

    // o terceirizado, sem participante ainda: lista vazia, sem comprovante
    const t = await logado("terceirizado");
    const vazia = (await t.get("/certificados/meus")).text;
    expect(vazia).not.toContain(`titulo-cert-${alheio.id}"`);
    expect(vazia).not.toContain(`titulo-cert-${meu.id}"`);
    // sem certificado, o menu não oferece o comprovante
    expect(vazia).not.toContain('href="/certificados/meus/comprovante"');
    const sem = await t.get("/certificados/meus/comprovante", { seguir: false });
    expect(sem.status).toBe(303);
    expect(sem.location).toBe("/certificados/meus");

    // a discente vê o dela e não o do outro, nem pela URL
    const d = await logado("discente");
    const lista = (await d.get("/certificados/meus")).text;
    expect(lista).toContain(`titulo-cert-${meu.id}"`);
    expect(lista).not.toContain(`titulo-cert-${alheio.id}"`);
    const ficha = await d.get(`/certificados/${alheio.id}`, { seguir: false });
    expect(ficha.status).toBe(303);
    expect(ficha.location).toBe("/certificados/meus");
    const via = await d.get(`/certificados/${alheio.id}/documento`, { seguir: false });
    expect(via.status).toBe(303);
    // a segunda via pelo serviço também recusa (pede `certificado.ver`)
    await expect(servico.segunda_via(db, usuario_d, alheio)).rejects.toThrow();
  });
});

describe("o anexo do certificado da conta externa (25/10/2026)", () => {
  it("baixa o anexo do próprio certificado e não o do certificado de outra pessoa", async () => {
    const operador = await _usuario(db);
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const usuario_t = await usuarioAtual(db, "terceirizado");
    const pessoa = await naTransacao((tx) => titular_externo.garantir_participante_da_conta(tx, usuario_t));
    const meu = await certificado_de(pessoa, operador, "BRIGC");
    const outro = await naTransacao((tx) =>
      servico_participante.criar_externo(tx, { nome: "Pessoa Sem Conta", vinculo: "TERCEIRIZADO", usuario: coordenador }),
    );
    const alheio = await certificado_de(outro, operador, "BRIGD");
    const pdf = new TextEncoder().encode("%PDF-1.4\n% anexo de teste\n");
    const anexar = (certificado_id: number, nome: string) =>
      naTransacao((tx) =>
        anexos.guardar(tx, {
          entidade: "certificado",
          entidade_id: certificado_id,
          nome_original: nome,
          conteudo: Uint8Array.from([...pdf, ...new TextEncoder().encode(nome)]),
          mime_type: "application/pdf",
          categoria: "CERTIFICADO",
          usuario: operador,
        }),
      );
    const do_meu = await anexar(meu.id, "lista-assinada.pdf");
    const do_alheio = await anexar(alheio.id, "lista-alheia.pdf");

    const t = await logado("terceirizado");
    const baixado = await t.get(`/anexos/${do_meu.anexo.id}`, { seguir: false });
    expect(baixado.status).toBe(200);
    const recusado = await t.get(`/anexos/${do_alheio.anexo.id}`, { seguir: false });
    expect([403, 404]).toContain(recusado.status);
    // a conta sem participante (a discente que nunca se inscreveu) também não baixa
    const d = await logado("discente");
    expect([403, 404]).toContain((await d.get(`/anexos/${do_meu.anexo.id}`, { seguir: false })).status);
  });
});

// =====================================================================
// O servidor continua como antes
// =====================================================================
describe("o servidor segue pelo servidor_id", () => {
  it("inscreve-se, vê a inscrição e o certificado; o participante dele não tem conta ligada", async () => {
    const [s] = await db.insert(e.servidor).values({ siape: "1110654", nome: "Adelaide Nunes Prata" }).returning();
    await db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "servidor_consulta"));
    const id = await turma_aberta();
    const c = await logado("servidor_consulta");
    const r = await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    expect(await msg(c, r)).toContain("Inscrição confirmada em");
    const [p] = await participantes();
    expect(p!.servidor_id).toBe(s!.id);
    expect(p!.usuario_id).toBeNull();
    expect(p!.vinculo).toBe("SERVIDOR");
    expect(minhas((await c.get("/turmas/minhas")).text)).toContain(`href="/turmas/${id}"`);

    const operador = await _usuario(db);
    const pessoa = (await servico_participante.carregar(db, p!.id))!;
    const certificado = await certificado_de(pessoa, operador);
    const tela = (await c.get("/certificados/meus")).text;
    expect(tela).toContain(`titulo-cert-${certificado.id}"`);
    expect((await c.get(`/certificados/${certificado.id}`, { seguir: false })).status).toBe(200);
    expect((await c.get("/certificados/meus/comprovante", { seguir: false })).status).toBe(200);

    const r2 = await c.post(`/turmas/${id}/desistir`, {}, { seguir: false });
    expect(await msg(c, r2)).toContain("Desistência registrada");
  });

  it("a conta sem servidor e sem perfil externo continua sem titular", async () => {
    const id = await turma_aberta();
    const c = await logado("servidor_consulta");
    const tela = texto((await c.get("/turmas/minhas")).text);
    expect(tela).toContain("Sua conta não está ligada a um cadastro de servidor");
    const r = await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    expect(await msg(c, r)).toContain("Sua conta não está ligada a um cadastro de servidor");
    expect(await participantes()).toHaveLength(0);
  });
});
