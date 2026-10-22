/**
 * Processos, demandas, pendências e laudos no celular (lote C do plano de
 * celular: P2, P7, P11, P13, P15, P18, P19 e P20).
 *
 * O que é regra aqui:
 *
 * - as visões salvas de /processos são uma faixa que rola de lado
 *   (`.fileira.rola`), e não seis linhas empurrando a lista (P18);
 * - a caixinha de marcar o processo mora num `label.marca-linha` junto com o
 *   NUP, na célula-título (P19) — e a tabela continua com 6 colunas;
 * - /pendencias e /laudos usam o contrato `table.empilhavel`: uma célula-título
 *   (Tarefa; Nº SIAPE), o resto com `data-coluna` e a ação em `td.acao-linha`
 *   (P7), e as células curtas em `td.curta` (P15);
 * - o NUP abre o teclado numérico e não puxa o autocompletar (P13);
 * - o anexo de processo diz ao seletor o que aceita, sem `capture` (P20);
 * - o título livre da trilha (o assunto da demanda) leva `title`, porque no
 *   celular ele corta com reticências (P2);
 * - o alternador Quadro/Tabela é um grupo rotulado (P11).
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as pendencias from "../src/servicos/pendencias.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { cenario } from "./ajuda_processos.js";

/** As linhas de dado (sem thead, sem a linha de vazio) da primeira `<table>`. */
function tabela(html: string): { abre: string; cabeca: string; linhas: string[] } {
  const m = /<table\b([^>]*)>([\s\S]*?)<\/table>/.exec(html);
  expect(m, "a tela não tem tabela").toBeTruthy();
  const cabeca = /<thead>([\s\S]*?)<\/thead>/.exec(m![2]!)?.[1] ?? "";
  const corpo = m![2]!.replace(/<thead>[\s\S]*?<\/thead>/, "");
  const linhas = [...corpo.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1]!).filter((l) => !/colspan=/.test(l));
  return { abre: m![1]!, cabeca, linhas };
}

function celulas(linha: string): [string, string][] {
  return [...linha.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map((x) => [x[1]!, x[2]!]);
}

/** O contrato `empilhavel`: uma célula-título só, o resto rotulado ou ação. */
function confere_contrato(html: string, titulo: RegExp, rotulos: string[]) {
  const { abre, linhas } = tabela(html);
  expect(abre).toMatch(/class="[^"]*\bempilhavel\b/);
  expect(linhas.length, "a tela renderizou sem linhas de dado").toBeGreaterThan(0);
  for (const linha of linhas) {
    const tds = celulas(linha);
    const sem_rotulo = tds.filter(([a]) => !/data-coluna=/.test(a) && !/\bacao-linha\b/.test(a));
    expect(sem_rotulo, "uma célula-título por linha").toHaveLength(1);
    expect(sem_rotulo[0]![1]).toMatch(titulo);
    const ditos = tds.map(([a]) => /data-coluna="([^"]*)"/.exec(a)?.[1]).filter(Boolean);
    expect(ditos).toEqual(rotulos);
    expect(tds.some(([a]) => /class="[^"]*\bcurta\b/.test(a)), "nenhuma célula curta").toBe(true);
  }
  return linhas;
}

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const cen = await cenario(db);
const coord = await usuarioAtual(db, "coordenador_csso");
await pendencias.abrir(db, {
  tipo: "CONFERIR_LAUDO", chave: `conferir:laudo:${cen.laudo_id}`, descricao: "Conferir o laudo do LEAC", usuario: coord,
});
const cliente: Cliente = await entrar(novoCliente(), "coordenador_csso");

const ASSUNTO = "Chefia da FAMED pergunta sobre o laudo do laboratório de análises clínicas, com assunto bem comprido";
let demanda_id = 0;
const telas: Record<string, string> = {};

beforeAll(async () => {
  const r = await cliente.post(
    "/demandas",
    { assunto: ASSUNTO, canal: "EMAIL", solicitante_nome: "Chefia da FAMED", data_chegada: "2026-10-01", descricao: "Pediu orientação." },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 300)).toBe(303);
  demanda_id = Number(r.location!.split("/demandas/")[1]!.split("?")[0]);
  for (const url of ["/processos", "/kanban", "/pendencias", "/laudos", "/processos/novo",
    `/processos/${cen.processo_id}?aba=anexos`, `/demandas/${demanda_id}`]) {
    const resp = await cliente.get(url);
    expect(resp.status, url).toBe(200);
    telas[url] = resp.text;
  }
});

describe("/processos no celular", () => {
  it("as visões salvas são uma fileira que rola de lado (P18)", () => {
    expect(telas["/processos"]).toMatch(/<div class="fileira rola">\s*<span class="rotulo-grupo">Visões<\/span>/);
  });

  it("a caixinha de marcar fica num label.marca-linha com o NUP, na célula-título (P19)", () => {
    const { cabeca, linhas } = tabela(telas["/processos"]!);
    expect(linhas.length).toBeGreaterThan(0);
    for (const linha of linhas) {
      const tds = celulas(linha);
      expect(tds, "seis colunas: a caixinha não tem coluna própria").toHaveLength(6);
      expect(tds[0]![0]).not.toMatch(/data-coluna=/);
      expect(tds[0]![1]).toMatch(/<label class="marca-linha"><input type="checkbox" name="processo_id"[^>]*class="marcar"[\s\S]*<a class="mono" href="\/processos\/\d+">[\s\S]*<\/a><\/label>/);
    }
    expect(cabeca).toMatch(/<th scope="col"><label class="marca-linha"><input type="checkbox" id="marcar-todos"[^>]*>NUP<\/label><\/th>/);
    expect((cabeca.match(/<th\b/g) ?? []).length).toBe(6);
  });

  it("as células curtas dividem a linha do cartão (P15)", () => {
    const [linha] = tabela(telas["/processos"]!).linhas;
    const curtas = celulas(linha!).filter(([a]) => /\bcurta\b/.test(a)).map(([a]) => /data-coluna="([^"]*)"/.exec(a)![1]);
    expect(curtas).toEqual(["Estado", "Dias · responsável", "Prazo"]);
  });

  it("o alternador Quadro/Tabela é um grupo rotulado, antes da lista e do quadro (P11)", () => {
    for (const url of ["/processos", "/kanban"]) {
      const html = telas[url]!;
      const i = html.indexOf('<div class="alternador" role="group" aria-label="Ver a lista como">');
      expect(i, url).toBeGreaterThan(0);
      const fim = html.indexOf(url === "/kanban" ? 'class="rolagem-quadro"' : "<table");
      expect(i).toBeLessThan(fim);
    }
    expect(telas["/kanban"]).toMatch(/id="kanban-exercicio" type="number" inputmode="numeric"/);
  });
});

describe("/pendencias e /laudos viram cartões (P7)", () => {
  it("/pendencias: Tarefa de título, o resto rotulado, concluir em acao-linha", () => {
    const linhas = confere_contrato(telas["/pendencias"]!, /class="tarefa"/, ["Responsável", "Prazo", "Onde"]);
    expect(celulas(linhas[0]!).at(-1)![0]).toMatch(/class="acao-linha"/);
  });

  it("/laudos: Nº SIAPE de título, o resto rotulado", () => {
    confere_contrato(telas["/laudos"]!, /<a class="mono" href="\/laudos\/\d+">/,
      ["Unidade", "Tipo", "Subscritor", "Emissão", "Última conferência", "Pareceres", "Situação"]);
  });
});

describe("campos e trilha", () => {
  it("o NUP abre o teclado numérico e não puxa autocompletar (P13)", () => {
    expect(telas["/processos/novo"]).toMatch(/<input id="nup"[^>]*inputmode="numeric"[^>]*autocomplete="off"/);
    expect(telas[`/demandas/${demanda_id}`]).toMatch(/<input id="nup"[^>]*inputmode="numeric"[^>]*autocomplete="off"/);
  });

  it("o anexo do processo tem accept e não tem capture (P20)", () => {
    const m = /<input id="anexo-arquivo"[^>]*>/.exec(telas[`/processos/${cen.processo_id}?aba=anexos`]!);
    expect(m, "o campo de anexo não renderizou").toBeTruthy();
    expect(m![0]).toMatch(/accept="application\/pdf,image\/\*,[^"]*\.docx/);
    expect(m![0]).not.toMatch(/\bcapture\b/);
  });

  it("o assunto na trilha de /demandas/:id leva title (P2)", () => {
    const html = telas[`/demandas/${demanda_id}`]!;
    expect(html).toContain(`<span class="atual" aria-current="page" title="${ASSUNTO}">${ASSUNTO}</span>`);
  });

  // Sem exceção: a cor do tipo no cartão do kanban saiu do `style=` para
  // `data-cor-tipo` (csso.css + csso.js).
  it("nenhum style= ou <style> inline nas telas do lote", () => {
    for (const [url, html] of Object.entries(telas)) {
      expect(html, url).not.toMatch(/\sstyle=/);
      expect(html, url).not.toMatch(/<style\b/);
    }
  });
});
