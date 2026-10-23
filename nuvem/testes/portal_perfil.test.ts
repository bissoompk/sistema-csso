/**
 * NUVEM (Portal do servidor, 22/10/2026): "Meu perfil" é `/minha-conta` em
 * seções `<details>` — Dados funcionais (só leitura), Contato e acesso,
 * Segurança, Treinamentos e certificados (resumo) e Privacidade. Sem CPF, RG ou
 * nascimento; conta de equipe sem servidor continua com Contato e Segurança.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-portal-perfil-"));

import { describe, expect, it } from "vitest";
import { eq, isNotNull } from "drizzle-orm";
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

  it("Dados funcionais: SIAPE, cargo, função, lotação e campus, com a fonte e o link da ficha", () => {
    expect(tela.text).toContain('<dt>Matrícula SIAPE</dt><dd class="mono">1110654</dd>');
    expect(tela.text).toContain("<dt>Função</dt><dd>Chefe de Laboratório</dd>");
    expect(tela.text).toContain(`<dt>Lotação</dt><dd>${unidade!.sigla} · ${unidade!.nome_extenso}</dd>`);
    expect(tela.text).toContain(`<dt>Campus</dt><dd>${campus!.nome}</dd>`);
    expect(tela.text).toContain("Fonte: SIAPE / Pró-Reitoria de Gestão de Pessoas.");
    expect(tela.text).toContain(`<a href="/servidores/${cen.servidor.id}">Ver minha ficha completa →</a>`);
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

  it("dados funcionais não aceitam POST: não há rota, e o formulário de contato ignora o SIAPE", async () => {
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
    expect(r.text).toContain("Esta conta não está ligada a um cadastro de servidor.");
    expect(r.text).not.toContain('href="/minha-atividade"');
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
