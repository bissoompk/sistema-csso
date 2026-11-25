/**
 * Lote 3 (24/11/2026, T13): a carga só aparece pela função única (`dominio/carga.ts` e os filtros
 * `carga`, `carga_turma`, `carga_base`, `carga_campo`, `carga_congelada`). Este teste varre os
 * modelos e o código e falha se alguém voltar a escrever "h" ou "horas" ao lado da carga à mão —
 * foi assim que "4,5 h" e "2,3 h" chegaram à tela, e que um curso em tempos sairia "10 h".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "..");

function arquivos(dir: string, ext: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) saida.push(...arquivos(p, ext));
    else if (p.endsWith(ext)) saida.push(p);
  }
  return saida;
}

function achados(lista: string[], padroes: RegExp[], permitidos: RegExp[] = []): string[] {
  const saida: string[] = [];
  for (const p of lista) {
    const linhas = readFileSync(p, "utf-8").split("\n");
    linhas.forEach((linha, i) => {
      const onde = `${path.relative(RAIZ, p)}:${i + 1}`;
      if (permitidos.some((r) => r.test(onde) || r.test(linha))) return;
      if (padroes.some((r) => r.test(linha))) saida.push(`${onde}: ${linha.trim()}`);
    });
  }
  return saida;
}

describe("a carga só sai pela função única (T13)", () => {
  it("nenhum modelo de tela escreve a carga com |num e 'h' ou 'horas' ao lado", () => {
    const modelos = arquivos(path.join(RAIZ, "templates"), ".html");
    expect(modelos.length).toBeGreaterThan(50);
    const errados = achados(modelos, [
      // a carga, a presença ou o total passados por |num (o número cru, sem unidade)
      /(carga_horaria_horas|carga_efetiva|carga_horas|carga_horaria|\.horas\b|\.quantidade\b|presente_base)\s*\|\s*num\b/,
      // qualquer número seguido de " h" ou " horas" escrito à mão no modelo
      /\|\s*num\s*\}\}\s*(h|horas)\b/,
      /\|\s*num\s*\)\s*~\s*' ?h\b/,
      // o total presente da linha da grade era `linha.horas`
      /linha\.horas\b/,
    ]);
    expect(errados).toEqual([]);
  });

  it("nenhum serviço ou rota monta 'Xh' ou 'X horas' da carga à mão", () => {
    const codigo = arquivos(path.join(RAIZ, "src"), ".ts");
    const errados = achados(
      codigo,
      [
        /numero(_br)?\([^)]*(carga|horas|quantidade)[^)]*\)\)?\s*\}\s*(h|horas)\b/,
        /\$\{[^}]*(carga|horas|lancadas|quantidade)[^}]*\}\s*h\b/,
        /\$\{[^}]*(carga|lancadas|quantidade)[^}]*\} horas/,
      ],
      [
        // o congelado antigo reimpresso igual: "4,5 horas" (certificado emitido não muda)
        /src\/servicos\/certificado\.ts:\d+/,
        // "há 3 h" e "prazo de 2 h 30 min" são relógio, não carga de treinamento
        /src\/servicos\/datas_br\.ts:\d+/,
        /src\/servicos\/acesso_participante\.ts:\d+/,
        /src\/dominio\/carga\.ts:\d+/,
      ],
    );
    expect(errados).toEqual([]);
  });

  it("o congelado antigo é o único caminho que ainda escreve 'N horas' à mão", () => {
    const fonte = readFileSync(path.join(RAIZ, "src/servicos/certificado.ts"), "utf-8");
    const linhas = fonte.split("\n").filter((l) => /\$\{numero_br\(c\.carga_horaria\)\} horas/.test(l));
    expect(linhas).toHaveLength(1);
    expect(fonte).toContain("if (!c.carga_unidade) return `${numero_br(c.carga_horaria)} horas`;");
  });
});
