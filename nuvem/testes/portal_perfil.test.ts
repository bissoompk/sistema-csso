/**
 * NUVEM (Portal do servidor, 22/10/2026): "Meu perfil" é `/minha-conta` em
 * seções `<details>` — Dados funcionais (o próprio servidor corrige cargo, função
 * e lotação desde 25/10/2026), Contato e acesso,
 * Segurança, Treinamentos e certificados (resumo) e Privacidade. Sem CPF, RG ou
 * nascimento; conta de equipe sem servidor continua com Contato e Segurança.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-portal-perfil-"));

import { describe, expect, it } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import { iniciais } from "../src/rotas/minha_conta.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, criarUsuario, entrar } from "./ajuda";
import { _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

const amb = await bancoLimpo();
const { db } = amb;
await contas(db);

// o servidor com cargo, função, lotação (com campus) e um certificado emitido
const operador = await _usuario(db);
const cen = await _cenario(db, operador);
const [cargo] = await db.insert(e.cargo).values({ nome: "Técnico de Laboratório - Área Química" }).returning();
const [unidade] = await db.select().from(e.unidade_uorg).where(isNotNull(e.unidade_uorg.sigla)).limit(1);
const [campus] = await db.select().from(e.campus).where(eq(e.campus.id, unidade!.campus_id));
await db
  .update(e.servidor)
  .set({ cargo_id: cargo!.id, unidade_uorg_id: unidade!.id, funcao: "Chefe de Laboratório" })
  .where(eq(e.servidor.id, cen.servidor.id));
const turma = (await servico_turma.carregar_turma(db, cen.turma.id))!;
await emissao.emitir(db, operador, (await servico_turma.carregar_inscricao(db, cen.inscricao.id, turma))!, {
  gerar_pdf: false,
});
// CPF no cadastro do participante: o perfil não pode mostrá-lo
const CPF = "52998224725";
await db.update(e.participante).set({ cpf: CPF }).where(eq(e.participante.servidor_id, cen.servidor.id));

await criarUsuario(db, {
  login: "titular_perfil",
  nome: "Marco Antônio Alves Schetino",
  perfis: ["servidor_consulta"],
  servidor_id: cen.servidor.id,
});
const cliente = await entrar(amb.novoCliente(), "titular_perfil");
const tela = await cliente.get("/minha-conta");

describe("Meu perfil: cabeçalho e seções", () => {
  it("abre, com as iniciais, o nome e os chips de lotação, cargo, campus e situação", () => {
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain("Template render error");
    expect(tela.text).toContain('<h1 class="oculto">Meu perfil</h1>');
    expect(tela.text).toContain('<span class="perfil-iniciais" aria-hidden="true">MS</span>');
    expect(tela.text).toContain('<p class="perfil-nome">Marco Antônio Alves Schetino</p>');
    expect(tela.text).toContain(`title="Cargo">Técnico de Laboratório - Área Química</li>`);
    expect(tela.text).toContain(`title="Campus">${campus!.nome}</li>`);
    expect(tela.text).toContain(`title="Lotação">${unidade!.sigla}</li>`);
    expect(tela.text).toMatch(/title="Situação funcional">\s*<span class="pilula ok"[^>]*>ativo<\/span>/);
  });

  it("as cinco seções, em <details>, com Dados funcionais aberta primeiro", () => {
    const ordem = ["dados-funcionais", "contato", "seguranca", "treinamentos", "privacidade"].map((id) =>
      tela.text.indexOf(`<details class="perfil-secao" id="${id}"`),
    );
    for (const pos of ordem) expect(pos).toBeGreaterThan(-1);
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
    expect(tela.text).toContain('<details class="perfil-secao" id="dados-funcionais" open>');
    expect(tela.text).toContain('<details class="perfil-secao" id="contato">');
    for (const titulo of ["Dados funcionais", "Contato e acesso", "Segurança", "Treinamentos e certificados", "Privacidade (LGPD)"]) {
      expect(tela.text).toContain(`<span class="perfil-secao-titulo">${titulo}</span>`);
    }
  });

  it("Dados funcionais: SIAPE, cargo, função, lotação e campus, com a fonte e sem o link da ficha", () => {
    expect(tela.text).toContain('<dt>Matrícula SIAPE</dt><dd class="mono">1110654</dd>');
    expect(tela.text).toContain("<dt>Função</dt><dd>Chefe de Laboratório</dd>");
    expect(tela.text).toContain(`<dt>Lotação</dt><dd>${unidade!.sigla} · ${unidade!.nome_extenso}</dd>`);
    expect(tela.text).toContain(`<dt>Campus</dt><dd>${campus!.nome}</dd>`);
    // o sistema não lê o SIAPE (25/10/2026): os dados são do servidor ou da equipe
    expect(tela.text).toContain("Informados por você ou pela equipe da Sisa — o sistema não lê o SIAPE.");
    expect(tela.text).not.toContain("Fonte: SIAPE");
    expect(tela.text).toContain('action="/minha-conta/funcionais"');
    // a ficha completa é da equipe (403 para o servidor): sem o link (27/10/2026)
    expect(tela.text).not.toContain("Ver minha ficha completa");
  });

  it("Contato e acesso continua com os dois formulários; Segurança leva a /trocar-senha e diz a inatividade", () => {
    expect(tela.text).toContain('action="/minha-conta/dados"');
    expect(tela.text).toContain('action="/minha-conta/email"');
    expect(tela.text).toContain('href="/trocar-senha"');
    expect(tela.text).toContain("depois de 60 minutos sem uso");
    expect(tela.text).not.toContain("/minha-conta/sessoes");
  });

  it("Treinamentos e certificados: o resumo e os links", () => {
    expect(tela.text).toMatch(/<strong>1\s+certificado válido<\/strong>\s+· 8 h de capacitação/);
    expect(tela.text).toContain('href="/certificados/meus"');
    expect(tela.text).toContain('href="/turmas/minhas"');
  });

  it("Privacidade: LGPD art. 18 e o link de Minha atividade", () => {
    expect(tela.text).toContain("(art. 18)");
    expect(tela.text).toContain('<a href="/minha-atividade">Minha atividade</a>');
  });

  it("sem CPF, RG ou data de nascimento", () => {
    expect(tela.text).not.toContain(CPF);
    expect(tela.text).not.toContain("529.982.247-25");
    expect(tela.text).not.toMatch(/\bCPF\b/);
    expect(tela.text).not.toMatch(/\bRG\b/);
    expect(tela.text).not.toMatch(/nascimento/i);
  });

  it("o SIAPE não se muda por aqui: o formulário de contato o ignora e não há campo dele", async () => {
    for (const caminho of ["/minha-conta/dados-funcionais", "/minha-conta/servidor"]) {
      const r = await cliente.post(caminho, { siape: "9999999", cargo: "outro" }, { seguir: false });
      expect(r.status, caminho).toBe(404);
    }
    await cliente.post("/minha-conta/dados", { nome: "Marco Antônio Alves Schetino", siape: "9999999", funcao: "x" });
    const [s] = await db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor.id));
    expect(s!.siape).toBe("1110654");
    expect(s!.funcao).toBe("Chefe de Laboratório");
    expect(tela.text).not.toMatch(/<input[^>]+name="siape"/);
  });

  it("o próprio servidor corrige cargo, função e lotação: período novo, trilha, e o SIAPE não muda", async () => {
    const [novo_cargo] = await db.insert(e.cargo).values({ nome: "Assistente em Administração" }).returning();
    const [outra] = await db
      .select()
      .from(e.unidade_uorg)
      .where(sql`${e.unidade_uorg.id} <> ${unidade!.id}`)
      .limit(1);
    // sem mudança nenhuma: "Nada mudou", e nada é gravado
    const igual = await cliente.post(
      "/minha-conta/funcionais",
      { cargo_id: String(cargo!.id), funcao: "Chefe de Laboratório", unidade_uorg_id: String(unidade!.id) },
      { seguir: false },
    );
    expect(decodeURIComponent(igual.location!)).toContain("Nada mudou");
    const r = await cliente.post(
      "/minha-conta/funcionais",
      { cargo_id: String(novo_cargo!.id), funcao: "Secretário do Departamento", unidade_uorg_id: String(outra!.id), siape: "9999999" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Dados funcionais atualizados");
    const [s] = await db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor.id));
    expect([s!.siape, s!.cargo_id, s!.funcao, s!.unidade_uorg_id]).toEqual(["1110654", novo_cargo!.id, "Secretário do Departamento", outra!.id]);
    const periodos = await db.select().from(e.servidor_lotacao).where(eq(e.servidor_lotacao.servidor_id, cen.servidor.id));
    expect(periodos.at(-1)!.observacao).toBe("Informado pelo próprio servidor em Meu perfil.");
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "servidor"), eq(e.historico_evento.tipo_evento, "LOTACAO_ALTERADA")));
    expect(trilha.some((t) => t.entidade_id === cen.servidor.id)).toBe(true);
    const depois = (await cliente.get("/minha-conta")).text;
    expect(depois).toContain("<dt>Função</dt><dd>Secretário do Departamento</dd>");
  });
});

describe("Meu perfil: conta de equipe sem servidor", () => {
  it("vê Contato e Segurança, aberta no Contato, sem Dados funcionais nem resumo de certificados", async () => {
    const equipe = await entrar(amb.novoCliente(), "engenheiro_seguranca");
    const r = await equipe.get("/minha-conta");
    expect(r.status).toBe(200);
    expect(r.text).toContain('<details class="perfil-secao" id="contato" open>');
    expect(r.text).toContain('<details class="perfil-secao" id="seguranca">');
    expect(r.text).not.toContain('id="dados-funcionais"');
    expect(r.text).not.toContain('id="treinamentos"');
    expect(r.text).toContain('<li class="chip">Conta de equipe</li>');
    // a conta sem servidor se liga sozinha (25/10/2026): «Sou servidor da UFVJM»
    expect(r.text).toContain('id="sou-servidor"');
    expect(r.text).toContain('action="/minha-conta/sou-servidor"');
    expect(r.text).not.toContain("Dados funcionais, só leitura");
    expect(r.text).not.toContain('href="/minha-atividade"');
  });

  it("Sou servidor da UFVJM: o SIAPE novo cria o cadastro e liga a conta na hora", async () => {
    const [cargo] = await db.insert(e.cargo).values({ nome: "Engenheiro de Segurança do Trabalho" }).returning();
    const equipe = await entrar(amb.novoCliente(), "engenheiro_seguranca");
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "engenheiro_seguranca"));
    const r = await equipe.post(
      "/minha-conta/sou-servidor",
      { siape: "7778889", nome: "Engenheira da Equipe", cargo_id: String(cargo!.id), unidade_uorg_id: String(unidade!.id) },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Cadastro de servidor criado e ligado à sua conta");
    const [sv] = await db.select().from(e.servidor).where(eq(e.servidor.siape, "7778889"));
    expect([sv!.nome, sv!.cargo_id, sv!.unidade_uorg_id, sv!.email]).toEqual(["Engenheira da Equipe", cargo!.id, unidade!.id, conta!.email]);
    const [depois] = await db.select().from(e.usuario).where(eq(e.usuario.id, conta!.id));
    expect(depois!.servidor_id).toBe(sv!.id);
    // agora a conta tem Dados funcionais, e o «Sou servidor» some
    const tela = (await equipe.get("/minha-conta")).text;
    expect(tela).toContain('id="dados-funcionais"');
    expect(tela).not.toContain('id="sou-servidor"');
  });

  it("Sou servidor da UFVJM: o SIAPE de outra pessoa (outro e-mail) é recusado; o do mesmo e-mail só liga", async () => {
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "engenheiro_seguranca"));
    await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.id, conta!.id));
    await db.insert(e.servidor).values({ siape: "5556667", nome: "Outra Pessoa", email: "outra.pessoa@ufvjm.edu.br" });
    const equipe = await entrar(amb.novoCliente(), "engenheiro_seguranca");
    const alheio = await equipe.post("/minha-conta/sou-servidor", { siape: "5556667", nome: "Quem Tenta" });
    expect(alheio.text).toContain("já está no cadastro com outro e-mail");
    expect((await db.select().from(e.usuario).where(eq(e.usuario.id, conta!.id)))[0]!.servidor_id).toBeNull();
    const [meu] = await db.insert(e.servidor).values({ siape: "5556668", nome: "Cadastrado pela Equipe", email: conta!.email }).returning();
    const ok = await equipe.post("/minha-conta/sou-servidor", { siape: "5556668", nome: "Qualquer" }, { seguir: false });
    expect(decodeURIComponent(ok.location!)).toContain("Conta ligada ao seu cadastro de servidor");
    expect((await db.select().from(e.usuario).where(eq(e.usuario.id, conta!.id)))[0]!.servidor_id).toBe(meu!.id);
    // o nome do cadastro não muda pelo que foi digitado
    expect((await db.select().from(e.servidor).where(eq(e.servidor.id, meu!.id)))[0]!.nome).toBe("Cadastrado pela Equipe");
  });

  it("com erro no formulário, a seção de contato vem aberta", async () => {
    const r = await cliente.post("/minha-conta/dados", { nome: "", telefone: "", ramal: "" });
    expect(r.text).toContain("Os dados não foram alterados");
    expect(r.text).toContain('<details class="perfil-secao" id="contato" open>');
    expect(r.text).toContain('<details class="perfil-secao" id="dados-funcionais">');
  });
});

describe("iniciais", () => {
  it("primeira e última palavra, sem preposição", () => {
    expect(iniciais("Mariana Alves Rocha")).toBe("MR");
    expect(iniciais("João da Silva")).toBe("JS");
    expect(iniciais("Ana")).toBe("A");
    expect(iniciais("  ")).toBe("?");
    expect(iniciais("élida dos santos")).toBe("ÉS");
  });
});
