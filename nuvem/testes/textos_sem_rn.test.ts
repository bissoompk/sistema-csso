/**
 * NUVEM: os códigos de regra de negócio ("RN-19", "(RN-03)"...) são vocabulário
 * da equipe, não do usuário. Eles continuam nos comentários Nunjucks `{# … #}`,
 * no código, nos testes e no DESVIOS.md; no texto que chega ao navegador, não.
 *
 * Duas guardas: (1) estática — cada template, sem os `{# … #}`, não traz o
 * código; (2) dinâmica — um conjunto representativo de páginas, renderizadas
 * com contas de perfis diferentes, não o traz no HTML (sem `<!-- -->`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar } from "./ajuda";

const CODIGO_RN = /\bRN-\d+/;
const RAIZ_TEMPLATES = join(import.meta.dirname, "..", "templates");

function templates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? templates(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
  );
}

/** As linhas (1-based) de `texto` que, fora dos comentários, citam uma RN. */
function linhas_com_rn(texto: string, comentario: RegExp): string[] {
  // troca o comentário por espaços preservando as quebras: o número da linha continua o mesmo
  const sem = texto.replace(comentario, (m) => m.replace(/[^\n]/g, " "));
  return sem
    .split("\n")
    .flatMap((l, i) => (CODIGO_RN.test(l) ? [`${i + 1}: ${l.trim()}`] : []));
}

describe("textos sem código de RN — templates", () => {
  it("nenhum template cita RN fora de {# … #}", () => {
    const achados = templates(RAIZ_TEMPLATES).flatMap((f) =>
      linhas_com_rn(readFileSync(f, "utf8"), /\{#[\s\S]*?#\}/g).map((l) => `${f.slice(RAIZ_TEMPLATES.length + 1)}:${l}`),
    );
    expect(achados).toEqual([]);
  });
});

const { db, cliente } = await bancoLimpo();
await contas(db);

/**
 * Exceção conhecida: a `base_normativa` do perfil "Secretaria da CSSO" vem do
 * BANCO (semeada de `MATRIZ_PERFIS` em `rbac.ts`, gravada só na criação do
 * perfil) e ainda diz "dado mascarado - RN-19". Corrigi-la pede mexer em
 * `rbac.ts` e atualizar a linha já gravada — fica para depois do módulo de
 * acidentes, que está mexendo no RBAC. Remova daqui quando for feito.
 */
const EXCECOES: readonly string[] = ["Sem acesso a exposicao (dado mascarado - RN-19)."];

const PAGINAS: Record<string, readonly string[]> = {
  coordenador_csso: [
    "/inicio",
    "/painel",
    "/kanban",
    "/processos",
    "/processos/novo",
    "/servidores",
    "/buscar?q=12345678901",
    "/demandas",
    "/pendencias",
    "/config",
    "/catalogos",
    "/relatorios",
    "/adicionais",
    "/laudos",
    "/importar",
    "/importar/reconciliacao",
    "/turmas",
    "/treinamentos",
    "/treinamentos/indicadores",
    "/treinamentos/assinaturas",
    "/certificados",
    "/epis",
    "/epis/requisicoes",
    "/epis/relatorios",
    "/minha-atividade",
  ],
  almoxarife_sesmt: [
    "/epis",
    "/epis/estoque",
    "/epis/entregas",
    "/epis/entregas/nova",
    "/epis/catalogo",
    "/epis/catalogo/motivos-recusa",
    "/epis/fichas",
    "/epis/requisicoes",
    "/celular",
    "/demandas",
  ],
  servidor_consulta: [
    "/inicio",
    "/epis/requisicoes",
    "/epis/requisicoes/nova",
    "/epis/fichas/minha",
    "/certificados/meus",
    "/turmas/minhas",
    "/minha-atividade",
  ],
  admin_ti: ["/inicio", "/usuarios", "/perfis", "/perfis/niveis", "/modulos", "/auditoria", "/config"],
};

describe("textos sem código de RN — páginas renderizadas", () => {
  for (const [conta, caminhos] of Object.entries(PAGINAS)) {
    it(`${conta}: nenhuma página mostra código de RN`, async () => {
      await entrar(cliente, conta);
      let renderizadas = 0;
      const achados: string[] = [];
      for (const caminho of caminhos) {
        const r = await cliente.get(caminho);
        expect(r.status, caminho).toBeLessThan(500);
        if (r.status === 200) renderizadas++;
        let html = r.text;
        for (const ex of EXCECOES) html = html.split(ex).join("");
        for (const l of linhas_com_rn(html, /<!--[\s\S]*?-->/g)) achados.push(`${caminho} ${l}`);
      }
      expect(achados).toEqual([]);
      // a guarda só vale se as páginas renderizam de fato (e não caem todas no login)
      expect(renderizadas).toBeGreaterThanOrEqual(Math.ceil(caminhos.length / 2));
    });
  }
});
