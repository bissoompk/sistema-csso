/**
 * Turmas e treinamentos no celular (lote B do plano de celular).
 *
 * - P7/P15: as listas viram cartões (`table.empilhavel`), cada célula fora da
 *   célula-título diz o próprio nome (`data-coluna`), e a ação fica em
 *   `td.acao-linha` — inclusive os rádios Manter/Juntar de /participantes;
 * - P13: o campo numérico abre o teclado de números (`inputmode`), e o e-mail do
 *   externo abre o de e-mail. A carga horária é DECIMAL (`_decimal` em
 *   `rotas/turmas.ts` aceita "4,5"), por isso `inputmode="decimal"` e sem
 *   `pattern`: um `[0-9]*` ali recusaria no navegador o que o servidor aceita;
 * - P18: as fichas de situação de /turmas numa `fileira rola`, com o filtro em
 *   linha fora dela.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const FUTURO = somar_dias(hoje_iso(), 30);

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const cliente = await entrar(novoCliente(), "coordenador_csso");

async function ok(url: string, campos: Record<string, string>) {
  const r = await cliente.post(url, campos, { seguir: false });
  expect(r.status, r.text.slice(0, 400)).toBe(303);
}

await ok("/treinamentos/catalogo", {
  codigo: "NR-35", nome: "Trabalho em Altura — NR-35", carga_horaria_horas: "8",
  validade_meses: "24", norma_referencia: "NR-35",
});
const [trein] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "NR-35"));
async function nova_turma(): Promise<number> {
  await ok("/turmas", { treinamento_id: String(trein!.id), data_inicio: FUTURO, data_fim: FUTURO, local: "Auditório" });
  return (await db.select().from(e.turma).orderBy(asc(e.turma.id))).at(-1)!.id;
}
const t1 = await nova_turma();
const t2 = await nova_turma();
await ok("/treinamentos/assinaturas", {
  nome: "Fabrício Raimundi Andrade", externo: "1", titulo: "Eng. Seg. do Trabalho", vigencia_inicio: "2020-01-01", vigencia_fim: "",
});
const [assin] = await db.select().from(e.assinatura_instrutor);
await ok(`/turmas/${t1}/instrutores`, { assinatura_instrutor_id: String(assin!.id), assina_certificado: "1" });
// a mesma pessoa externa nas duas turmas: um par de possíveis duplicados
for (const t of [t1, t2]) {
  await ok(`/turmas/${t}/inscricoes`, {
    nome: "Maria Aparecida de Souza", vinculo: "TERCEIRIZADO", organizacao: "Limpeza Ltda", email: "maria@exemplo.com.br",
    confirmar_novo: "1", // "é outra pessoa": força o par que a tela de juntar mostra
  });
}

// uma inscrição cancelada: a linha sem nenhuma ação
const [sv] = await db.insert(e.servidor).values({ siape: "1110654", nome: "Adelaide Nunes Prata" }).returning();
await ok(`/turmas/${t1}/inscricoes`, { servidor_id: String(sv!.id) });
const cancelada = (await db.select().from(e.inscricao).orderBy(asc(e.inscricao.id))).at(-1)!.id;
await ok(`/turmas/${t1}/inscricoes/${cancelada}`, { destino: "CANCELADA", motivo: "desistiu" });

const telas = {
  turmas: (await cliente.get("/turmas")).text,
  turma: (await cliente.get(`/turmas/${t1}`)).text,
  inscricoes: (await cliente.get(`/turmas/${t1}?aba=inscricoes`)).text,
  inicio: (await cliente.get("/treinamentos")).text,
  catalogo: (await cliente.get("/treinamentos/catalogo")).text,
  participantes: (await cliente.get("/treinamentos/participantes")).text,
};

/** O `<input>` inteiro de um id. */
function campo(html: string, id: string): string {
  const m = new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  expect(m, `falta #${id}`).toBeTruthy();
  return m![0];
}

/** As tabelas da página, cada uma com a tag de abertura e o corpo. */
function tabelas(html: string): { tag: string; corpo: string }[] {
  return [...html.matchAll(/(<table\b[^>]*>)([\s\S]*?)<\/table>/g)].map((m) => ({ tag: m[1]!, corpo: m[2]! }));
}

/** A tabela cujo cabeçalho tem este rótulo. */
function tabela_com(html: string, th: string) {
  const t = tabelas(html).find((x) => x.corpo.includes(`<th scope="col">${th}</th>`) || x.corpo.includes(`<th>${th}</th>`));
  expect(t, `nenhuma tabela com a coluna ${th}`).toBeTruthy();
  return t!;
}

/** As linhas do corpo (fora do `<thead>`), cada uma com as tags de abertura dos `<td>`. */
function linhas(corpo: string): string[][] {
  const sem_cabeca = corpo.replace(/<thead>[\s\S]*?<\/thead>/, "");
  return [...sem_cabeca.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1]!.matchAll(/<td\b[^>]*>/g)].map((x) => x[0]))
    .filter((tds) => tds.length > 1);
}

/** Empilhável, e só a célula-título (e a de ação) sem `data-coluna`. */
function confere_empilhavel(html: string, th: string, titulos = 1) {
  const t = tabela_com(html, th);
  expect(t.tag).toMatch(/class="[^"]*\bempilhavel\b/);
  const ls = linhas(t.corpo);
  expect(ls.length, `sem linhas na tabela de ${th}`).toBeGreaterThan(0);
  for (const tds of ls) {
    const sem = tds.filter((td) => !/data-coluna=/.test(td) && !/\bacao-linha\b/.test(td));
    expect(sem.length, `células sem data-coluna em ${th}: ${sem.join(" ")}`).toBeLessThanOrEqual(titulos);
  }
  return ls;
}

describe("as listas de turmas viram cartões (P7/P15)", () => {
  it("/turmas: empilhável, com as células curtas marcadas", () => {
    const [l] = confere_empilhavel(telas.turmas, "Período");
    expect(l!.filter((td) => /\bcurta\b/.test(td))).toHaveLength(4);
    expect(l!.some((td) => /\bacao-linha\b/.test(td))).toBe(true);
  });

  it("instrutores da ficha: empilhável, com o \"tirar\" em acao-linha", () => {
    const [l] = confere_empilhavel(telas.turma, "Certificado");
    expect(l!.at(-1)).toMatch(/class="acao-linha"/);
  });

  it("inscrições da ficha: empilhável, com as ações (gavetas) em acao-linha", () => {
    const t = tabela_com(telas.inscricoes, "Origem");
    const ls = confere_empilhavel(telas.inscricoes, "Origem");
    expect(ls[0]!.at(-1)).toMatch(/class="acao-linha"/);
    expect(t.corpo).toMatch(/<td class="acao-linha">[\s\S]*?abre-gaveta/);
    for (const rot of ["Identificador", "Vínculo", "E-mail", "Situação", "Origem"]) {
      expect(t.corpo).toContain(`data-coluna="${rot}"`);
    }
  });

  it("inscrição cancelada não deixa a faixa de ações vazia (td:empty some no cartão)", () => {
    expect(telas.inscricoes).toContain("desistiu");
    expect(telas.inscricoes).not.toMatch(/<td class="acao-linha">\s+<\/td>/);
  });

  it("emissão da ficha: empilhável, com o \"emitir\" em acao-linha", async () => {
    await db.update(e.turma).set({ situacao: "CONCLUIDA" }).where(eq(e.turma.id, t1));
    const html = (await cliente.get(`/turmas/${t1}?aba=emissao`)).text;
    confere_empilhavel(html, "O que falta");
    expect(html).not.toMatch(/<td class="acao-linha">\s+<\/td>/);
  });

  it("/treinamentos: as próximas turmas empilham", () => {
    confere_empilhavel(telas.inicio, "Treinamento");
  });

  it("/treinamentos/catalogo continua empilhável (código e nome são o título)", () => {
    confere_empilhavel(telas.catalogo, "Carga", 2);
  });

  it("/treinamentos/participantes: empilhável, com Manter e Juntar em acao-linha", () => {
    const ls = confere_empilhavel(telas.participantes, "Manter");
    for (const tds of ls) {
      expect(tds[0]).toMatch(/class="acao-linha curta" data-coluna="Manter"/);
      expect(tds[1]).toMatch(/class="acao-linha curta" data-coluna="Juntar"/);
    }
    expect(telas.participantes).toMatch(/data-coluna="Manter"><label class="alvo-marca"><input type="radio" name="mantido_id"/);
    expect(telas.participantes).toMatch(/data-coluna="Juntar"><label class="alvo-marca"><input type="checkbox" name="absorvido_id"/);
  });
});

describe("o teclado certo para cada campo (P13)", () => {
  it("#nova-turma: vagas numérica, carga, nota e frequência decimais", () => {
    expect(campo(telas.turmas, "nova-vagas")).toMatch(/inputmode="numeric" pattern="\[0-9\]\*"/);
    expect(campo(telas.turmas, "nova-carga")).toContain('inputmode="decimal"');
    expect(campo(telas.turmas, "nova-carga")).not.toContain("pattern=");
    expect(campo(telas.turmas, "nova-nota")).toContain('inputmode="decimal"');
    expect(campo(telas.turmas, "nova-freq")).toContain('inputmode="decimal"');
  });

  it("ficha: editar e retificar com o mesmo teclado", () => {
    expect(campo(telas.turma, "vagas")).toMatch(/inputmode="numeric" pattern="\[0-9\]\*"/);
    for (const id of ["carga", "nota_minima_aprovacao", "frequencia_minima_percentual"]) {
      expect(campo(telas.turma, id), id).toContain('inputmode="decimal"');
    }
    // a retificação só aparece na turma concluída: confere-se no molde
    const molde = readFileSync(path.resolve(__dirname, "../templates/paginas/turma_ficha.html"), "utf-8");
    expect(/<input id="r-carga"[^>]*>/.exec(molde)?.[0]).toContain('inputmode="decimal"');
  });

  it("o e-mail do externo é type=email", () => {
    const html = telas.inscricoes.includes('id="ext-email"') ? telas.inscricoes : telas.turma;
    expect(campo(html, "ext-email")).toMatch(/type="email" autocomplete="email"/);
  });
});

describe("a fileira de situação de /turmas (P18)", () => {
  it("as fichas rolam de lado; o filtro em linha fica fora da faixa", () => {
    const m = /<div class="fileira rola">([\s\S]*?)<\/div>/.exec(telas.turmas);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('class="ficha-filtro');
    expect(m![1]).not.toContain("filtro-inline");
    expect(telas.turmas).toContain('class="filtro-inline"');
  });
});

describe("a trilha da ficha (P2)", () => {
  it("o último nível é o código da turma, curto", () => {
    expect(telas.turma).toMatch(/<span class="atual mono" aria-current="page">TUR-\d{4}-\d{4}<\/span>/);
  });
});
