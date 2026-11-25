/**
 * Lote 5 (25/11/2026), a parte de treinamentos: T6 e T7 (avisos nos popups de concluir e de
 * emitir), T8 (cabeçalho da unidade promotora, congelado), T9 (o primeiro lançamento tira a turma
 * de "Planejada", na trilha), T11 (a ordem do e-mail do certificado e a origem na tela),
 * T12 (rótulos), T14 (a âncora do cartão de inscrever), B2 (o "tempos presentes" sem escape) e
 * B4 (modelo, origem da validade e disciplinas já no cadastrar).
 */
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { ROTULO_VINCULO } from "../src/dominio/treinamento.js";
import { hoje } from "../src/servicos/datas_br.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import * as envio from "../src/servicos/envio_certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import * as servico_turma from "../src/servicos/turma.js";
import { comMensagem } from "../src/web.js";
import { bancoLimpo, contas, entrar, type Cliente, type Resposta } from "./ajuda.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";

const INICIO = somar_dias(hoje(), -3);

let db: Banco;
let novoCliente: () => Cliente;
let cliente: Cliente;

beforeEach(async () => {
  ({ db, novoCliente } = await bancoLimpo());
  await contas(db);
  cliente = novoCliente();
  await entrar(cliente, "coordenador_csso");
});

async function mensagem(r: Resposta): Promise<string> {
  expect(r.status, r.text.slice(0, 600)).toBe(303);
  return (await cliente.get(r.location!)).text;
}

/** Treinamento e turma pela tela; a turma fica PLANEJADA, com início há três dias. */
async function turma_planejada(unidade: "HORAS" | "TEMPOS" = "HORAS") {
  const r = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: "QA-L5", nome: "Treinamento do lote 5", carga_horaria_horas: "4", carga_unidade: unidade, validade_meses: "12" },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).orderBy(desc(e.treinamento.id)).limit(1);
  const rt = await cliente.post(
    "/turmas",
    { treinamento_id: String(t!.id), data_inicio: INICIO, data_fim: INICIO, local: "Sala", frequencia_minima_percentual: "75" },
    { seguir: false },
  );
  expect(rt.status, rt.text.slice(0, 500)).toBe(303);
  const [turma] = await db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
  expect(turma!.situacao).toBe("PLANEJADA");
  return { t: t!, turma: turma! };
}

// =====================================================================
describe("T9 — o primeiro lançamento tira a turma de Planejada, e a trilha registra", () => {
  it("presença lançada em turma Planejada: Em andamento, com nome e motivo na trilha", async () => {
    const usuario = await _usuario(db);
    const { turma } = await turma_planejada();
    const carregada = (await servico_turma.carregar_turma(db, turma.id))!;
    const [s] = await db.insert(e.servidor).values({ siape: "5556667", nome: "Rita Lançada" }).returning();
    const pessoa = await servico_participante.de_servidor(db, s!, usuario);
    const inscricao = await servico_turma.inscrever(db, usuario, carregada, pessoa);
    await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: INICIO, presente: true, quantidade: 240 });

    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, turma.id));
    expect(depois!.situacao).toBe("EM_ANDAMENTO");
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "turma"), eq(e.historico_evento.entidade_id, turma.id), eq(e.historico_evento.campo, "situacao")));
    const linha = trilha.find((h) => h.valor_novo === "EM_ANDAMENTO");
    expect(linha, JSON.stringify(trilha)).toBeTruthy();
    expect(linha!.valor_anterior).toBe("PLANEJADA");
    expect(linha!.descricao).toContain("Planejada -> Em andamento — primeiro lançamento de presença ou nota");
    expect(linha!.usuario_nome).toBe(usuario.nome);

    // o segundo lançamento não grava outra mudança
    await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: INICIO, presente: true, quantidade: 200 });
    const de_novo = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade_id, turma.id), eq(e.historico_evento.valor_novo, "EM_ANDAMENTO")));
    expect(de_novo).toHaveLength(1);
  });

  it("a aba de presença avisa, antes de salvar, que o lançamento muda a situação", async () => {
    const { turma } = await turma_planejada();
    const aba = (await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text;
    if (aba.includes('id="aviso-planejada"')) {
      expect(aba).toContain("Em andamento");
    } else {
      // sem inscrito a folha não abre: o aviso aparece com a folha
      const [s] = await db.insert(e.servidor).values({ siape: "5556668", nome: "Rui Inscrito" }).returning();
      await mensagem(await cliente.post(`/turmas/${turma.id}/inscricoes`, { servidor_id: String(s!.id) }, { seguir: false }));
      const com_folha = (await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text;
      expect(com_folha).toContain('id="aviso-planejada"');
    }
  });

  it("turma Em andamento não mostra o aviso", async () => {
    const { turma } = await turma_planejada();
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"]) {
      expect((await cliente.post(`/turmas/${turma.id}/situacao`, { destino }, { seguir: false })).status).toBe(303);
    }
    expect((await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text).not.toContain('id="aviso-planejada"');
  });
});

// =====================================================================
describe("T6 — o popup de concluir diz o que a conclusão não bloqueia", () => {
  it("turma Planejada, sem instrutor que assine: os dois avisos no popup", async () => {
    const { turma } = await turma_planejada();
    const ficha = (await cliente.get(`/turmas/${turma.id}`)).text;
    expect(ficha).toContain('id="concluir-turma"');
    expect(ficha).toContain('id="concluir-planejada"');
    expect(ficha).toContain('id="concluir-sem-assinatura"');
  });

  it("inscrito sem nota numa turma com nota mínima: o popup conta quem sairá reprovado", async () => {
    const usuario = await _usuario(db);
    const { turma } = await turma_planejada();
    await db.update(e.turma).set({ nota_minima_aprovacao: "7" }).where(eq(e.turma.id, turma.id));
    const carregada = (await servico_turma.carregar_turma(db, turma.id))!;
    const [s] = await db.insert(e.servidor).values({ siape: "5556669", nome: "Sem Nota" }).returning();
    const inscricao = await servico_turma.inscrever(db, usuario, carregada, await servico_participante.de_servidor(db, s!, usuario));
    await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: INICIO, presente: true, quantidade: 240 });
    const ficha = (await cliente.get(`/turmas/${turma.id}`)).text;
    expect(ficha).toContain('id="concluir-sem-nota"');
    expect(ficha).toContain("1 inscrito(s) sem nota");
    // já está Em andamento (T9): o aviso de Planejada sai
    expect(ficha).not.toContain('id="concluir-planejada"');
  });
});

// =====================================================================
describe("T7 — o popup de emitir avisa quem assina sem qualificação", () => {
  it("instrutor que assina sem qualificação NR-35: o aviso aparece no popup, sem bloquear", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const aba = (await cliente.get(`/turmas/${cen.turma.id}?aba=emissao`)).text;
    expect(aba).toContain('id="emitir-lote"');
    expect(aba).toContain('id="emitir-sem-qualificacao"');
    expect(aba).toContain("Fabrício Raimundi Andrade");
  });
});

// =====================================================================
describe("T8 — o cabeçalho é da unidade promotora, e o emitido não muda", () => {
  it("com unidade promotora, sai o nome dela; a segunda via continua conferindo depois de renomeada", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const [u] = await db.select().from(e.unidade_uorg).limit(1);
    await db.update(e.unidade_uorg).set({ sigla: "UPT", nome_extenso: "Unidade Promotora de Teste", promove_treinamento: true }).where(eq(e.unidade_uorg.id, u!.id));
    await db.update(e.turma).set({ unidade_promotora_id: u!.id }).where(eq(e.turma.id, cen.turma.id));
    const turma = (await servico_turma.carregar_turma(db, cen.turma.id))!;
    const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id, turma))!;
    const r = await emissao.emitir(db, usuario, inscricao, { gerar_pdf: false });
    const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, r.certificado.id));
    const ctx = cert!.contexto_congelado as Record<string, unknown>;
    expect([ctx.setor_sigla, ctx.setor_nome]).toEqual(["UPT", "Unidade Promotora de Teste"]);

    await db.update(e.unidade_uorg).set({ nome_extenso: "Outro Nome Depois" }).where(eq(e.unidade_uorg.id, u!.id));
    const via = await emissao.segunda_via(db, usuario, cert!);
    expect(via.confere).toBe(true);
    expect(via.hash_conteudo).toBe(cert!.hash_conteudo);
  });

  it("sem unidade promotora, continua o setor emissor", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const r = await emissao.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
    const ctx = r.certificado.contexto_congelado as Record<string, unknown>;
    expect(ctx.setor_nome).not.toBe("Unidade Promotora de Teste");
  });
});

// =====================================================================
describe("T11 — a ordem do e-mail do certificado e a origem na tela", () => {
  it("participante → conta (Minha conta) → cadastro funcional", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const r = await emissao.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
    const cert = r.certificado;
    const pid = cen.inscricao.participante_id;
    // sem e-mail do participante
    await db.update(e.participante).set({ email_principal_id: null }).where(eq(e.participante.id, pid));
    await db.delete(e.participante_email).where(eq(e.participante_email.participante_id, pid));
    await db.update(e.servidor).set({ email: "funcional@ufvjm.edu.br" }).where(eq(e.servidor.id, cen.servidor.id));
    expect(await envio.destinatario_com_origem(db, cert)).toEqual({ endereco: "funcional@ufvjm.edu.br", origem: "SERVIDOR" });

    await db.update(e.usuario).set({ servidor_id: cen.servidor.id, email: "conta@ufvjm.edu.br" }).where(eq(e.usuario.login, "tecnico_seguranca"));
    expect(await envio.destinatario_com_origem(db, cert)).toEqual({ endereco: "conta@ufvjm.edu.br", origem: "CONTA" });

    const [pe] = await db.insert(e.participante_email).values({ participante_id: pid, email: "pessoal@exemplo.com", email_normalizado: "pessoal@exemplo.com" }).returning();
    await db.update(e.participante).set({ email_principal_id: pe!.id }).where(eq(e.participante.id, pid));
    expect(await envio.destinatario_com_origem(db, cert)).toEqual({ endereco: "pessoal@exemplo.com", origem: "PARTICIPANTE" });

    const origens = await envio.origens_dos_envios(db, [
      { id: 1, certificado_id: cert.id, destinatario: "conta@ufvjm.edu.br" },
      { id: 2, certificado_id: cert.id, destinatario: "funcional@ufvjm.edu.br" },
      { id: 3, certificado_id: cert.id, destinatario: "sumiu@exemplo.com" },
    ]);
    expect(origens[1]).toBe(envio.ROTULO_ORIGEM.CONTA);
    expect(origens[2]).toBe(envio.ROTULO_ORIGEM.SERVIDOR);
    expect(origens[3]).toBe("o cadastro mudou depois deste envio");
  });

  it("a tela E-mails diz onde o SMTP se configura, na produção e no servidor de teste", async () => {
    const tela = (await cliente.get("/certificados/emails")).text;
    expect(tela).toContain("no painel do Netlify");
    expect(tela).toContain("no servidor de teste, no ambiente do processo que o roda");
  });
});

// =====================================================================
describe("T12 — rótulos", () => {
  it("o vínculo de servidor diz 'Servidor(a) da UFVJM'", () => {
    expect(ROTULO_VINCULO["SERVIDOR"]).toBe("Servidor(a) da UFVJM");
  });
});

// =====================================================================
describe("T14 — a busca de inscrever volta ancorada no cartão", () => {
  it("comMensagem põe a consulta antes da âncora", () => {
    expect(comMensagem("/turmas/1?aba=inscricoes#inscrever-participante", "ok")).toBe("/turmas/1?aba=inscricoes&mensagem=ok#inscrever-participante");
    expect(comMensagem("/turmas/1", "ok")).toBe("/turmas/1?mensagem=ok");
  });

  it("inscrever com a busca aberta volta para #inscrever-participante; sem busca, sem âncora", async () => {
    const { turma } = await turma_planejada();
    const [s1] = await db.insert(e.servidor).values({ siape: "5556670", nome: "Ana Busca" }).returning();
    const [s2] = await db.insert(e.servidor).values({ siape: "5556671", nome: "Beto Sem Busca" }).returning();
    const com = await cliente.post(`/turmas/${turma.id}/inscricoes`, { servidor_id: String(s1!.id), busca: "Ana" }, { seguir: false });
    expect(com.status).toBe(303);
    expect(com.location).toMatch(/\?aba=inscricoes&busca=Ana.*#inscrever-participante$/);
    const sem = await cliente.post(`/turmas/${turma.id}/inscricoes`, { servidor_id: String(s2!.id) }, { seguir: false });
    expect(sem.location).not.toContain("#");
    const aba = (await cliente.get(`/turmas/${turma.id}?aba=inscricoes`)).text;
    expect(aba).toContain('id="inscrever-participante"');
    expect(aba).toContain(`action="/turmas/${turma.id}#inscrever-participante"`);
  });
});

// =====================================================================
describe("B2 — a nota da aba de presença sai em negrito, não escapada", () => {
  it("em TEMPOS diz 'tempos presentes', em HORAS 'horas presentes', sem &lt;strong", async () => {
    for (const unidade of ["TEMPOS", "HORAS"] as const) {
      ({ db, novoCliente } = await bancoLimpo());
      await contas(db);
      cliente = novoCliente();
      await entrar(cliente, "coordenador_csso");
      const { turma } = await turma_planejada(unidade);
      const [s] = await db.insert(e.servidor).values({ siape: "5556672", nome: "Caio Grade" }).returning();
      await mensagem(await cliente.post(`/turmas/${turma.id}/inscricoes`, { servidor_id: String(s!.id) }, { seguir: false }));
      const aba = (await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text;
      expect(aba).not.toContain("&lt;strong");
      expect(aba).toContain(unidade === "TEMPOS" ? "<strong>tempos presentes</strong>" : "<strong>horas presentes</strong>");
    }
  });
});

// =====================================================================
describe("B4 — modelo, origem da validade e disciplinas já no cadastrar", () => {
  const base = { codigo: "BRIG-L5", nome: "Brigada do lote 5", carga_horaria_horas: "10", validade_meses: "24" };
  const disciplinas = {
    disc_presente: "1",
    disc_nome_1: "Prevenção e Combate a Incêndio",
    disc_teorica_1: "3",
    disc_pratica_1: "3",
    disc_nome_2: "Primeiros Socorros",
    disc_teorica_2: "2",
    disc_pratica_2: "2",
  };

  it("o popup de cadastrar traz modelo, origem e o quadro marcado para só aparecer em TEMPOS", async () => {
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    expect(tela).toContain('id="novo-modelo"');
    expect(tela).toContain('id="novo-validade-origem"');
    expect(tela).toContain('id="novo-validade-citacao"');
    expect(tela).toContain('data-mostra-quando="carga_unidade=TEMPOS"');
  });

  it("em TEMPOS, cadastra com origem, citação e disciplinas numa vez só", async () => {
    const r = await cliente.post(
      "/treinamentos/catalogo",
      { ...base, carga_unidade: "TEMPOS", validade_origem: "NORMA", validade_citacao: "Portaria CBMMG nº 54/2020", ...disciplinas },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIG-L5"));
    expect([t!.validade_origem, t!.validade_citacao]).toEqual(["NORMA", "Portaria CBMMG nº 54/2020"]);
    const ds = await db.select().from(e.treinamento_disciplina).where(eq(e.treinamento_disciplina.treinamento_id, t!.id));
    expect(ds).toHaveLength(2);
  });

  it("em HORAS com disciplina preenchida (sem JavaScript), recusa e nada é gravado", async () => {
    const r = await cliente.post("/treinamentos/catalogo", { ...base, carga_unidade: "HORAS", ...disciplinas }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("aviso-erro");
    expect(await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIG-L5"))).toHaveLength(0);
    expect(r.text).toContain('value="Primeiros Socorros"');
  });

  it("em HORAS com o quadro vazio (sem JavaScript), cadastra normalmente", async () => {
    const r = await cliente.post("/treinamentos/catalogo", { ...base, carga_unidade: "HORAS", disc_presente: "1" }, { seguir: false });
    expect(r.status, r.text.slice(0, 500)).toBe(303);
    expect(await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIG-L5"))).toHaveLength(1);
  });

  it("disciplinas que não fecham com a carga: recusa sem gravar o treinamento", async () => {
    const r = await cliente.post(
      "/treinamentos/catalogo",
      { ...base, carga_unidade: "TEMPOS", ...disciplinas, disc_pratica_2: "1" },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("3 + 3 + 2 + 1 = 9 tempos, mas a carga do treinamento é 10 tempos");
    expect(await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIG-L5"))).toHaveLength(0);
  });

  it("origem sem citação é recusada", async () => {
    const r = await cliente.post("/treinamentos/catalogo", { ...base, carga_unidade: "HORAS", validade_origem: "NORMA" }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Diga a norma que fixa a validade");
  });

  it("modelo de outro treinamento ou superado não entra no cadastro", async () => {
    const [m] = await db.select().from(e.certificado_modelo).limit(1);
    const [outro] = await db.insert(e.treinamento).values({ codigo: "OUTRO", nome: "Outro", carga_horaria_horas: "1" }).returning();
    await db.update(e.certificado_modelo).set({ treinamento_id: outro!.id }).where(eq(e.certificado_modelo.id, m!.id));
    const r = await cliente.post("/treinamentos/catalogo", { ...base, carga_unidade: "HORAS", modelo_vigente_id: String(m!.id) }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Escolha um modelo genérico vigente");
  });
});
