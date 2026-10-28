/**
 * Correções do lote "turmas e inscrições": um teste por defeito de regra,
 * permissão ou validação (e pelas melhorias que mudam comportamento), com o
 * número do item ao lado do nome.
 *
 * Banco limpo por teste (`bancoLimpo` no `beforeEach`, um CREATE DATABASE
 * TEMPLATE): várias asserções contam turmas, inscrições e participantes.
 */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import type { Banco } from "../src/db/cliente.js";
import * as inscricao_publica from "../src/servicos/inscricao_publica.js";
import * as pedidos_link from "../src/servicos/pedidos_link.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import * as servico_turma from "../src/servicos/turma.js";
import { RegraDaTurma } from "../src/servicos/turma.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Campos, type Cliente, type Resposta } from "./ajuda";

const HOJE = hoje_iso();
const ONTEM = somar_dias(HOJE, -1);
const AMANHA = somar_dias(HOJE, 1);
const FUTURO = somar_dias(HOJE, 30);
const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
};

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

// =====================================================================
// Montagem
// =====================================================================
/** O HTML escapa o apóstrofo e as aspas; a asserção compara o texto. */
function texto(html: string): string {
  return html
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** O texto da página onde o aviso é renderizado, venha por 200 ou por 303. */
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

/** Coordenador logado e uma turma aberta pela tela; devolve o id. */
async function turma(dados: Campos = {}): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post(
    "/turmas",
    { treinamento_id: String(await treinamento()), data_inicio: FUTURO, data_fim: FUTURO, local: "Auditório", ...dados },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return (await db.select().from(e.turma).orderBy(asc(e.turma.id))).at(-1)!.id;
}

async function ler_turma(id: number) {
  const [t] = await db.select().from(e.turma).where(eq(e.turma.id, id));
  return t!;
}

async function por_situacao(id: number, situacao: string, campos: Partial<typeof e.turma.$inferInsert> = {}) {
  await db.update(e.turma).set({ situacao, ...campos }).where(eq(e.turma.id, id));
}

async function servidor(siape = "1110654", nome = "Adelaide Nunes Prata") {
  const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
  return s!;
}

/** A conta `servidor_consulta` ligada a um cadastro de servidor. */
async function servidor_logado(siape = "1110654", nome = "Adelaide Nunes Prata") {
  const s = await servidor(siape, nome);
  await db.update(e.usuario).set({ servidor_id: s.id }).where(eq(e.usuario.login, "servidor_consulta"));
  const c = novoCliente();
  await entrar(c, "servidor_consulta");
  return { c, servidor: s };
}

async function inscrever_servidor(turma_id: number, siape: string, nome: string) {
  const s = await servidor(siape, nome);
  const r = await cliente.post(`/turmas/${turma_id}/inscricoes`, { servidor_id: String(s.id) }, { seguir: false });
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return (await db.select().from(e.inscricao).orderBy(asc(e.inscricao.id))).at(-1)!.id;
}

async function inscricoes() {
  return db.select().from(e.inscricao).orderBy(asc(e.inscricao.id));
}

async function participantes() {
  return db.select().from(e.participante).orderBy(asc(e.participante.id));
}

/** Turma com inscrições abertas e o link gerado pela tela; devolve o token. */
async function com_link(campos: Partial<typeof e.turma.$inferInsert> = {}) {
  const id = await turma();
  await por_situacao(id, "INSCRICOES_ABERTAS", { inscricao_aberta_ate: somar_dias(HOJE, 10), ...campos });
  const r = await cliente.post(`/turmas/${id}/link-publico`, {});
  expect(r.status, r.text.slice(0, 500)).toBe(200);
  return { turma_id: id, token: r.text.match(/\/inscricao\/([A-Za-z0-9_-]{20,})/)![1]! };
}

// =====================================================================
// Datas da turma (D25, D26, D27, D42)
// =====================================================================
describe("datas da turma", () => {
  it("D25: turma em andamento não se conclui antes do último dia", async () => {
    const id = await turma({ data_inicio: HOJE, data_fim: AMANHA });
    await por_situacao(id, "EM_ANDAMENTO");
    const r = await cliente.post(`/turmas/${id}/situacao`, { destino: "CONCLUIDA" }, { seguir: false });
    expect(await msg(cliente, r)).toContain(`termina em ${br(AMANHA)}: só se conclui turma que já aconteceu`);
    expect((await ler_turma(id)).situacao).toBe("EM_ANDAMENTO");
    // a ficha não oferece o botão e diz quando ele aparece
    const ficha = texto((await cliente.get(`/turmas/${id}`)).text);
    expect(ficha).not.toContain('id="concluir-turma"');
    expect(ficha).toContain(`aparece a partir de ${br(AMANHA)}`);
    // no último dia, conclui
    await db.update(e.turma).set({ data_fim: HOJE }).where(eq(e.turma.id, id));
    await cliente.post(`/turmas/${id}/situacao`, { destino: "CONCLUIDA" }, { seguir: false });
    expect((await ler_turma(id)).situacao).toBe("CONCLUIDA");
  });

  it("D26: presença em dia que ainda não chegou é recusada, uma a uma e na folha do dia", async () => {
    const id = await turma({ data_inicio: HOJE, data_fim: AMANHA });
    await por_situacao(id, "EM_ANDAMENTO");
    const inscricao_id = await inscrever_servidor(id, "1110654", "Adelaide Nunes Prata");
    const um = await cliente.post(
      `/turmas/${id}/presencas`,
      { inscricao_id: String(inscricao_id), data: AMANHA, horas: "4", presente: "1" },
      { seguir: false },
    );
    expect(await msg(cliente, um)).toContain(`${br(AMANHA)} ainda não chegou`);
    const coluna = await cliente.post(`/turmas/${id}/presencas/dia`, { data: AMANHA, horas: "4" }, { seguir: false });
    expect(await msg(cliente, coluna)).toContain("ainda não chegou");
    expect(await db.select().from(e.turma_presenca)).toHaveLength(0);
    // hoje continua aceito
    await cliente.post(
      `/turmas/${id}/presencas`,
      { inscricao_id: String(inscricao_id), data: HOJE, horas: "4", presente: "1" },
      { seguir: false },
    );
    expect(await db.select().from(e.turma_presenca)).toHaveLength(1);
  });

  it("D27: “inscrições até” depois do início é recusado no cadastro e na edição", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(
      "/turmas",
      {
        treinamento_id: String(await treinamento()),
        data_inicio: FUTURO,
        data_fim: FUTURO,
        abertura: "LINK",
        inscricao_aberta_ate: somar_dias(FUTURO, 5),
      },
      { seguir: false },
    );
    expect(texto(r.text)).toContain(`As inscrições têm de fechar até o início da turma (${br(FUTURO)})`);
    expect(await db.select().from(e.turma)).toHaveLength(0);
    const id = await turma();
    const editar = await cliente.post(
      `/turmas/${id}`,
      { data_inicio: FUTURO, data_fim: FUTURO, inscricao_aberta_ate: somar_dias(FUTURO, 1), frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    expect(await msg(cliente, editar)).toContain("têm de fechar até o início");
    expect((await ler_turma(id)).inscricao_aberta_ate).toBeNull();
  });

  it("D27: a turma que já começou não recebe pedido próprio nem pelo link, mesmo com prazo gravado depois", async () => {
    const { turma_id, token } = await com_link();
    // a turma antiga, de antes da regra: começou ontem e o prazo ia até depois
    await db
      .update(e.turma)
      .set({ data_inicio: ONTEM, data_fim: AMANHA, inscricao_aberta_ate: somar_dias(HOJE, 20) })
      .where(eq(e.turma.id, turma_id));
    const t = (await servico_turma.carregar_turma(db, turma_id))!;
    expect(servico_turma.aberta_a_pedido_proprio(t)).toContain(`começou em ${br(ONTEM)}`);
    const cartaz = texto((await novoCliente().get(`/inscricao/${token}`)).text);
    expect(cartaz).toContain("não recebe mais pedido de vaga");
    expect(cartaz).not.toContain("Pedir a vaga</button>");
    const { c } = await servidor_logado();
    expect(texto((await c.get("/turmas/minhas")).text)).not.toContain(t.codigo);
  });

  it("D42: prazo de inscrição já passado é recusado antes de criar a turma, sem código", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(
      "/turmas",
      {
        treinamento_id: String(await treinamento()),
        data_inicio: FUTURO,
        data_fim: FUTURO,
        abertura: "LINK",
        inscricao_aberta_ate: somar_dias(HOJE, -20),
      },
      { seguir: false },
    );
    const t = texto(r.text);
    expect(t).toContain("O prazo de inscrição já passou.");
    expect(t).not.toMatch(/As inscrições de TUR-/);
    expect(await db.select().from(e.turma)).toHaveLength(0);
    // a numeração não andou: a próxima turma é a 0001
    await turma();
    expect((await db.select().from(e.turma))[0]!.codigo).toMatch(/-0001$/);
  });
});

// =====================================================================
// Mensagens (D41)
// =====================================================================
describe("mensagens de validação (D41)", () => {
  it("concordância certa e sem código interno", async () => {
    await entrar(cliente, "coordenador_csso");
    const base = { treinamento_id: String(await treinamento()), data_fim: FUTURO };
    const vagas = await cliente.post("/turmas", { ...base, data_inicio: FUTURO, vagas: "abc" }, { seguir: false });
    expect(texto(vagas.text)).toContain("O número de vagas é inválido: informe um número inteiro.");
    const data = await cliente.post("/turmas", { ...base, data_inicio: "2026-02-31" }, { seguir: false });
    expect(texto(data.text)).toContain("A data de início é inválida");
    const carga = await cliente.post("/turmas", { ...base, data_inicio: FUTURO, carga_horaria_horas: "x" }, { seguir: false });
    expect(texto(carga.text)).toContain("A carga horária é inválida: informe um número.");
  });

  it("horas negativas dizem que são negativas, e não “presença de zero hora”", async () => {
    const id = await turma({ data_inicio: HOJE, data_fim: AMANHA });
    await por_situacao(id, "EM_ANDAMENTO");
    const inscricao_id = await inscrever_servidor(id, "1110654", "Adelaide Nunes Prata");
    const r = await cliente.post(
      `/turmas/${id}/presencas`,
      { inscricao_id: String(inscricao_id), data: HOJE, horas: "-1", presente: "1" },
      { seguir: false },
    );
    const t = await msg(cliente, r);
    expect(t).toContain("As horas do dia não podem ser negativas.");
    expect(t).not.toContain("zero hora");
    const nota = await cliente.post(`/turmas/${id}/notas`, { inscricao_id: String(inscricao_id), nota: "abc" }, { seguir: false });
    expect(await msg(cliente, nota)).toContain("A nota é inválida: informe um número.");
  });

  it("retificar com fim antes do início diz isso", async () => {
    const id = await turma({ data_inicio: HOJE, data_fim: HOJE });
    await por_situacao(id, "CONCLUIDA");
    const r = await cliente.post(
      `/turmas/${id}/retificar`,
      { data_inicio: HOJE, data_fim: ONTEM, motivo: "data trocada" },
      { seguir: false },
    );
    const t = await msg(cliente, r);
    expect(t).toContain("O fim da turma não pode ser anterior ao início.");
    expect(t).not.toContain("fora do período novo");
  });

  it("participante: acento em e-mail e vínculo", async () => {
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    await expect(
      servico_participante.criar_externo(db, { nome: "Fulano de Tal", vinculo: "XYZ", usuario: coordenador }),
    ).rejects.toThrow("Vínculo desconhecido: XYZ.");
    await expect(
      servico_participante.criar_externo(db, { nome: "Fulano de Tal", vinculo: "OUTRO", email: "abc", usuario: coordenador }),
    ).rejects.toThrow("E-mail inválido");
  });

  it("excluir turma cancelada não manda cancelar de novo", async () => {
    const id = await turma();
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const t = (await servico_turma.carregar_turma(db, id))!;
    await servico_turma.mudar_situacao(db, coordenador, t, "CANCELADA", { motivo: "sem quórum" });
    const erro = (await servico_turma.excluir_turma(db, coordenador, t, "engano").catch((x) => x)) as Error;
    expect(erro).toBeInstanceOf(RegraDaTurma);
    expect(erro.message).toContain("Ela já está cancelada");
    expect(erro.message).not.toContain("Cancele a turma");
  });
});

// =====================================================================
// Meus treinamentos (D32, D45, D63, M40, M49, M59)
// =====================================================================
describe("meus treinamentos", () => {
  it("D32: quem desistiu vê “Você desistiu” no cartaz e na recusa de pedir de novo", async () => {
    const id = await turma();
    await por_situacao(id, "INSCRICOES_ABERTAS");
    const { c } = await servidor_logado();
    await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    await c.post(`/turmas/${id}/desistir`, { motivo: "férias" }, { seguir: false });
    const tela = texto((await c.get("/turmas/minhas")).text);
    expect(tela).toContain("Você desistiu — fale com a equipe responsável");
    expect(tela).not.toContain("já inscrito");
    const de_novo = await c.post(`/turmas/${id}/inscrever-me`, {}, { seguir: false });
    const t = await msg(c, de_novo);
    expect(t).toContain("Você desistiu de");
    expect(t).toContain("fale com a equipe responsável");
    expect(t).not.toContain("como cancelada");
  });

  it("D45: a trilha diz “Meus treinamentos” uma vez só", async () => {
    const { c } = await servidor_logado();
    const html = (await c.get("/turmas/minhas")).text;
    const trilha = html.slice(html.indexOf('class="trilha"'), html.indexOf("</nav>", html.indexOf('class="trilha"')));
    expect(trilha.split("Meus treinamentos").length - 1).toBe(1);
  });

  it("D63: o pedido feito pelo link pode ser retirado pelo próprio servidor", async () => {
    const { turma_id, token } = await com_link();
    const { c } = await servidor_logado();
    await novoCliente().post(`/inscricao/${token}`, {
      ...PEDIDO,
      nome: "Adelaide Prata",
      vinculo: "SERVIDOR",
      siape: "1110654",
      email: "",
    });
    const [pedido] = await inscricoes();
    expect(pedido!.situacao).toBe("AGUARDANDO_EMAIL");
    const tela = texto((await c.get("/turmas/minhas")).text);
    expect(tela).toContain("Pedido em análise");
    expect(tela).toContain("Retirar o pedido");
    const r = await c.post(`/turmas/${turma_id}/desistir`, {}, { seguir: false });
    expect(await msg(c, r)).toContain("retirado");
    const [depois] = await inscricoes();
    expect(depois!.situacao).toBe("CANCELADA");
    expect(depois!.motivo_cancelamento).toBe("Pedido retirado pelo próprio.");
  });

  it("M40/M49: vagas por extenso, a lotada no fim, a desistência com confirmação", async () => {
    await entrar(cliente, "coordenador_csso");
    const lotada = await turma({ vagas: "1", data_inicio: somar_dias(HOJE, 5), data_fim: somar_dias(HOJE, 5) });
    await por_situacao(lotada, "INSCRICOES_ABERTAS");
    await inscrever_servidor(lotada, "2220001", "Bruno Lima Souza");
    const livre = await turma({ vagas: "3" });
    await por_situacao(livre, "INSCRICOES_ABERTAS");
    const { c } = await servidor_logado();
    const tela = texto((await c.get("/turmas/minhas")).text);
    expect(tela).toContain("Restam 3 vagas");
    expect(tela).toContain("Lotada");
    const [cod_lotada, cod_livre] = [(await ler_turma(lotada)).codigo, (await ler_turma(livre)).codigo];
    // a lotada começa antes, mas vai para o fim
    expect(tela.indexOf(cod_livre)).toBeLessThan(tela.indexOf(cod_lotada));
    expect(tela).toContain("Escolha uma turma e clique em");
    await c.post(`/turmas/${livre}/inscrever-me`, {}, { seguir: false });
    const depois = texto((await c.get("/turmas/minhas")).text);
    expect(depois).toContain("Restam 2 vagas");
    expect(depois).toContain('id="desistir-');
    expect(depois).toContain("A vaga volta para a turma.");
  });

  it("M59: sem turma aberta, o vazio avisa o servidor sem apontar o catálogo da equipe", async () => {
    const { c } = await servidor_logado();
    const bruto = (await c.get("/turmas/minhas")).text;
    const tela = texto(bruto);
    expect(tela).toContain("Nenhuma turma aberta agora");
    // o catálogo é da equipe (403 para o servidor): o link só aparece para quem lê
    expect(tela).toContain("volte aqui quando a equipe abrir inscrições");
    expect(bruto).not.toContain('href="/treinamentos/catalogo"');
  });
});

// =====================================================================
// Pedidos pelo link (D34, M38) e link da turma (D36)
// =====================================================================
describe("pedidos pelo link", () => {
  it("D34: as caixas nascem desmarcadas, com “marcar todos desta turma”", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    await novoCliente().post(`/inscricao/${token}`, PEDIDO);
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    const html = (await cliente.get("/turmas/pedidos")).text;
    expect(html).not.toMatch(/name="inscricao_id"[^>]*checked/);
    expect(html).toContain(`data-marca-grupo="turma-${turma_id}"`);
    expect(html.split(`data-grupo="turma-${turma_id}"`).length - 1).toBe(2);
    expect(texto(html)).toContain("1 vaga livre de 1");
  });

  it("M38: aceitar acima das vagas não aceita nenhum pedido daquela turma", async () => {
    const { turma_id, token } = await com_link({ vagas: 1 });
    await novoCliente().post(`/inscricao/${token}`, PEDIDO);
    await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, nome: "Pedro Alvares Cabral", email: "pedro@x.com" });
    const ids = (await inscricoes()).map((i) => i.id);
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const r = await pedidos_link.decidir(db, coordenador, ids, "INSCRITA");
    expect(r.feitos).toBe(0);
    expect(r.excedidas).toEqual([{ codigo: (await ler_turma(turma_id)).codigo, vagas: 1, marcados: 2 }]);
    expect((await inscricoes()).every((i) => i.situacao === "AGUARDANDO_EMAIL")).toBe(true);
    // a ficha não oferece "aceitar todos" quando eles não cabem
    const ficha = texto((await cliente.get(`/turmas/${turma_id}?aba=inscricoes`)).text);
    expect(ficha).not.toContain("Aceitar os 2 pedidos");
    expect(ficha).toContain("escolha quem aceitar");
  });

  it("D36: turma concluída com link mostra só “Desligar o link”", async () => {
    const { turma_id } = await com_link();
    await db.update(e.turma).set({ situacao: "CONCLUIDA", data_inicio: ONTEM, data_fim: ONTEM }).where(eq(e.turma.id, turma_id));
    const ficha = texto((await cliente.get(`/turmas/${turma_id}?aba=inscricoes`)).text);
    expect(ficha).not.toContain("Gerar um link novo");
    expect(ficha).toContain("Desligar o link");
  });
});

// =====================================================================
// Formulário público (D51, D55, M54)
// =====================================================================
describe("formulário público", () => {
  it("D51: o mesmo e-mail de duas pessoas e o pedido repetido sem e-mail não duplicam", async () => {
    const { token } = await com_link();
    const publico = novoCliente();
    const email = "joana.teste@exemplo.com";
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Xavier Souza Silva", email });
    await publico.post(`/inscricao/${token}?novo=1`, { ...PEDIDO, nome: "Joana Ávila Prestes", email });
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Joana Ávila Prestes", email });
    expect(await inscricoes()).toHaveLength(2);
    expect(await participantes()).toHaveLength(2);
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Fulano Sem Email", email: "" });
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "fulano  sem email", email: "" });
    expect(await inscricoes()).toHaveLength(3);
    expect(await participantes()).toHaveLength(3);
  });

  it("D55: o erro aparece uma vez só, dentro do formulário", async () => {
    const { token } = await com_link();
    const r = await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, vinculo: "SERVIDOR", siape: "" });
    expect(r.status).toBe(422);
    expect(texto(r.text).split("informe o SIAPE (6 ou 7 dígitos)").length - 1).toBe(1);
  });

  it("M54: envio aceito redireciona (PRG) e mostra o que chegou; recarregar não reenvia", async () => {
    const { token } = await com_link();
    const publico = novoCliente();
    const r = await publico.post(`/inscricao/${token}`, PEDIDO, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/inscricao/${token}`);
    const tela = texto((await publico.get(r.location!)).text);
    expect(tela).toContain(inscricao_publica.RESPOSTA_PADRAO);
    expect(tela).toContain("Joana Prestes da Silva");
    expect(tela).toContain("joana@empresa.com.br");
    expect(tela).not.toContain("Pedir a vaga</button>");
    // recarregar é GET: nada novo
    await publico.get(`/inscricao/${token}`);
    expect(await inscricoes()).toHaveLength(1);
    // "outra pessoa" volta ao formulário limpo, com o vínculo sem padrão
    const outra = texto((await publico.get(`/inscricao/${token}?novo=1`)).text);
    expect(outra).toContain("Pedir a vaga</button>");
    expect(outra).toMatch(/<option value="" selected>Selecione<\/option>/);
    expect(outra).toContain('data-mostra-quando="vinculo=SERVIDOR"');
  });

  it("M54: o nome não aceita < > { }", async () => {
    const { token } = await com_link();
    const r = await novoCliente().post(`/inscricao/${token}`, { ...PEDIDO, nome: "Joana <b>Silva</b>" });
    expect(r.status).toBe(422);
    expect(texto(r.text)).toContain("não podem ter os caracteres < > { }");
    expect(await inscricoes()).toHaveLength(0);
  });
});

// =====================================================================
// Lista de turmas e ficha para quem não opera (D62, M41)
// =====================================================================
describe("telas de quem não opera a turma", () => {
  it("D62: o servidor não recebe ícones de abas que não vê", async () => {
    const id = await turma({ data_inicio: ONTEM, data_fim: ONTEM });
    await por_situacao(id, "CONCLUIDA");
    const coord = (await cliente.get("/turmas")).text;
    expect(coord).toContain(`/turmas/${id}?aba=presencas`);
    expect(coord).toContain(`/turmas/${id}?aba=emissao`);
    const { c } = await servidor_logado();
    const lista = (await c.get("/turmas")).text;
    expect(lista).not.toContain("?aba=presencas");
    expect(lista).not.toContain("?aba=emissao");
    expect(lista).not.toContain("?aba=inscricoes");
  });

  it("M41: na ficha, o servidor vê a situação e a própria inscrição, e não as regras da máquina", async () => {
    const id = await turma({ data_inicio: ONTEM, data_fim: ONTEM });
    const { c, servidor: s } = await servidor_logado();
    const t = (await servico_turma.carregar_turma(db, id))!;
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const pessoa = await servico_participante.de_servidor(db, s, coordenador);
    await servico_turma.inscrever(db, coordenador, t, pessoa);
    await por_situacao(id, "CONCLUIDA");
    const ficha = texto((await c.get(`/turmas/${id}`)).text);
    expect(ficha).not.toContain("é situação final");
    expect(ficha).toContain("Minha inscrição:");
    expect(texto((await cliente.get(`/turmas/${id}`)).text)).toContain("é situação final");
  });
});

// =====================================================================
// Cadastro de externo (M36)
// =====================================================================
describe("cadastro de externo (M36)", () => {
  it("pergunta se é a mesma pessoa antes de criar, e grava a nova só com a resposta", async () => {
    const id = await turma();
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const ja = await servico_participante.criar_externo(db, {
      nome: "Wagner Estrela Lopes",
      vinculo: "TERCEIRIZADO",
      usuario: coordenador,
    });
    const dados = { nome: "wagner lopes", vinculo: "TERCEIRIZADO", organizacao: "Empresa X" };
    const r = await cliente.post(`/turmas/${id}/inscricoes`, dados, { seguir: false });
    expect(r.status).toBe(200);
    const t = texto(r.text);
    expect(t).toContain("É a mesma pessoa?");
    expect(t).toContain(ja.identificador_publico);
    expect(t).toContain('value="wagner lopes"');
    expect(await participantes()).toHaveLength(1);
    expect(await inscricoes()).toHaveLength(0);
    // "sim": inscreve o cadastro que já existe
    await cliente.post(`/turmas/${id}/inscricoes`, { ...dados, participante_id: String(ja.id) }, { seguir: false });
    expect((await inscricoes()).map((i) => i.participante_id)).toEqual([ja.id]);
    // "não, é outra": grava a pessoa nova
    const id2 = await turma();
    await cliente.post(`/turmas/${id2}/inscricoes`, { ...dados, confirmar_novo: "1" }, { seguir: false });
    expect(await participantes()).toHaveLength(2);
  });

  it("RN-19: quem não lê nomes não recebe a pergunta (não vira oráculo)", async () => {
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    await servico_participante.criar_externo(db, { nome: "Wagner Estrela Lopes", vinculo: "TERCEIRIZADO", usuario: coordenador });
    const sem_nome = new UsuarioAtual({ id: coordenador.id, login: "x", nome: "x", permissoes: ["turma.inscrever"], perfis: [] });
    expect(await servico_participante.parecidos(db, { nome: "Wagner Lopes" }, sem_nome)).toHaveLength(0);
    expect(await servico_participante.parecidos(db, { nome: "Wagner Lopes" }, coordenador)).toHaveLength(1);
  });
});

// =====================================================================
// A folha de presença num envio (M33)
// =====================================================================
describe("a folha de presença (M33)", () => {
  it("caixa marcada vale a carga do dia; desmarcada num dia lançado é falta; o futuro não entra", async () => {
    const id = await turma({ data_inicio: ONTEM, data_fim: AMANHA, carga_horaria_horas: "12" });
    await por_situacao(id, "EM_ANDAMENTO");
    const a = await inscrever_servidor(id, "1110654", "Adelaide Nunes Prata");
    const b = await inscrever_servidor(id, "2220001", "Bruno Lima Souza");
    const ficha = (await cliente.get(`/turmas/${id}?aba=presencas`)).text;
    expect(ficha).toContain('action="/turmas/' + id + '/presencas/folha"');
    expect(ficha).toMatch(new RegExp(`value="${a}_${AMANHA}"[^>]* disabled`));
    const r = await cliente.post(
      `/turmas/${id}/presencas/folha`,
      { presente: [`${a}_${ONTEM}`, `${a}_${HOJE}`, `${b}_${HOJE}`, `${a}_${AMANHA}`], [`h_${b}_${HOJE}`]: "2" },
      { seguir: false },
    );
    expect(await msg(cliente, r)).toContain("Folha salva: 4 presença(s)");
    const presencas = await db.select().from(e.turma_presenca).orderBy(asc(e.turma_presenca.inscricao_id), asc(e.turma_presenca.data));
    // 12 h em 3 dias: 4 h por dia; b chegou atrasado hoje (2 h) e faltou ontem
    expect(presencas.map((p) => [p.inscricao_id, p.data, p.presente, Number(p.horas)])).toEqual([
      [a, ONTEM, true, 4],
      [a, HOJE, true, 4],
      [b, ONTEM, false, 0],
      [b, HOJE, true, 2],
    ]);
    // salvar de novo sem mudar nada não grava nada
    const igual = await cliente.post(
      `/turmas/${id}/presencas/folha`,
      { presente: [`${a}_${ONTEM}`, `${a}_${HOJE}`, `${b}_${HOJE}`], [`h_${a}_${ONTEM}`]: "4", [`h_${a}_${HOJE}`]: "4", [`h_${b}_${HOJE}`]: "2" },
      { seguir: false },
    );
    expect(await msg(cliente, igual)).toContain("Nada mudou na folha.");
  });

  it("a coluna Situação é curta e diz o que falta", async () => {
    const id = await turma({ data_inicio: HOJE, data_fim: HOJE, nota_minima_aprovacao: "7" });
    await por_situacao(id, "EM_ANDAMENTO");
    await inscrever_servidor(id, "1110654", "Adelaide Nunes Prata");
    const t = (await servico_turma.carregar_turma(db, id))!;
    const [linha] = await servico_presenca.grade_da_turma(db, t);
    expect(linha!.resumo).toBe("Faltam presença e nota");
  });
});

// =====================================================================
// Acréscimos da revisão
// =====================================================================
describe("revisão do lote", () => {
  it("D27: a turma antiga com prazo depois do início ainda se edita, se o prazo e o início não mudam", async () => {
    const id = await turma();
    await db.update(e.turma).set({ inscricao_aberta_ate: somar_dias(FUTURO, 3) }).where(eq(e.turma.id, id));
    const base = {
      data_inicio: FUTURO,
      data_fim: FUTURO,
      inscricao_aberta_ate: somar_dias(FUTURO, 3),
      frequencia_minima_percentual: "75",
    };
    const local = await cliente.post(`/turmas/${id}`, { ...base, local: "Sala nova" }, { seguir: false });
    expect(await msg(cliente, local)).toContain("Turma atualizada.");
    expect((await ler_turma(id)).local).toBe("Sala nova");
    // mexer no início confere o prazo de novo
    const inicio = await cliente.post(
      `/turmas/${id}`,
      { ...base, data_inicio: somar_dias(FUTURO, 1), data_fim: somar_dias(FUTURO, 1) },
      { seguir: false },
    );
    expect(await msg(cliente, inicio)).toContain("têm de fechar até o início");
  });

  it("D51: mesmo nome com e-mails diferentes são duas pessoas, e nenhum pedido some", async () => {
    const { token } = await com_link();
    const publico = novoCliente();
    await publico.post(`/inscricao/${token}`, { ...PEDIDO, nome: "Carlos Pereira Lima", email: "carlos1@exemplo.com" });
    await publico.post(`/inscricao/${token}?novo=1`, { ...PEDIDO, nome: "Carlos Pereira Lima", email: "carlos2@exemplo.com" });
    expect(await inscricoes()).toHaveLength(2);
    // o repetido sem e-mail ainda casa com o pedido em espera
    await publico.post(`/inscricao/${token}?novo=1`, { ...PEDIDO, nome: "Carlos Pereira Lima", email: "" });
    expect(await inscricoes()).toHaveLength(2);
  });

  it("situacao: destino que é nome de propriedade do objeto não passa pela permissão", async () => {
    const id = await turma();
    const r = await cliente.post(`/turmas/${id}/situacao`, { destino: "constructor" }, { seguir: false });
    expect(r.status).not.toBe(500);
    expect((await ler_turma(id)).situacao).toBe("PLANEJADA");
  });

  it("M36: o curinga do nome digitado não vira curinga do SQL", async () => {
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    await servico_participante.criar_externo(db, { nome: "Wagner Estrela Lopes", vinculo: "TERCEIRIZADO", usuario: coordenador });
    expect(await servico_participante.parecidos(db, { nome: "W% Lopes" }, coordenador)).toHaveLength(0);
    expect(await servico_participante.parecidos(db, { nome: "Wágner Lopes" }, coordenador)).toHaveLength(1);
  });
});

// =====================================================================
// Integração: pedidos que os lotes deixaram uns para os outros
// =====================================================================
describe("integração dos lotes", () => {
  it("D41: o serviço da retificação também confere o período antes da presença", async () => {
    const { retificar_turma } = await import("../src/servicos/retificacao.js");
    const id = await turma({ data_inicio: HOJE, data_fim: HOJE });
    await por_situacao(id, "EM_ANDAMENTO");
    const inscricao_id = await inscrever_servidor(id, "1110654", "Adelaide Nunes Prata");
    const lancou = await cliente.post(
      `/turmas/${id}/presencas`,
      { inscricao_id: String(inscricao_id), data: HOJE, horas: "4", presente: "1" },
      { seguir: false },
    );
    expect(lancou.status).toBeLessThan(400);
    expect(await db.select().from(e.turma_presenca)).not.toHaveLength(0);
    await por_situacao(id, "CONCLUIDA");
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    const carregada = (await servico_turma.carregar_turma(db, id))!;
    // a presença de HOJE cairia "fora do período novo"; o erro é o período invertido
    await expect(
      retificar_turma(db, coordenador, carregada, { data_inicio: AMANHA, data_fim: HOJE }, "datas trocadas"),
    ).rejects.toThrow("O fim da turma não pode ser anterior ao início.");
  });

  it("M84: mudar a situação sem nenhuma permissão de destino é 403 antes do formulário", async () => {
    const id = await turma({ data_inicio: FUTURO, data_fim: FUTURO });
    const antes = (await ler_turma(id)).situacao;
    await entrar(cliente, "servidor_consulta");
    const r = await cliente.post(`/turmas/${id}/situacao`, {}, { seguir: false });
    expect(r.status).toBe(403);
    // o destino que é nome de propriedade do objeto continua sem passar
    await entrar(cliente, "coordenador_csso");
    const c = await cliente.post(`/turmas/${id}/situacao`, { destino: "constructor" }, { seguir: false });
    expect(c.status).not.toBe(500);
    expect((await ler_turma(id)).situacao).toBe(antes);
  });
});
