/**
 * O `npm run build` do Netlify. Não há o que compilar para o navegador (as
 * telas são renderizadas no servidor e o front React já vem pronto em
 * `public/estaticos/app`): o trabalho da publicação é deixar o BANCO na
 * versão do código que vai ao ar — migrar, semear e, no banco de produção,
 * converter os logins antigos para o e-mail (`converter-logins.ts`).
 *
 * Sem `DATABASE_URL` (uma prévia de branch sem banco, por exemplo) a
 * migração é pulada com aviso, e a publicação segue.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function rodar(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/**
 * Minifica as folhas e os scripts da casca (`csso.css` 278 KB, `csso.js` 66 KB)
 * NA CÓPIA DA PUBLICAÇÃO: o repositório guarda o fonte legível e só o que vai
 * ao CDN é minificado. O esbuild já vem com o `tsx`; sem ele, avisa e segue.
 * Os nomes não mudam, então nenhum template precisa saber. O `sw.js` fica de fora.
 */
function minificar_casca() {
  const esbuild = "node_modules/.bin/esbuild";
  if (!existsSync(esbuild)) {
    console.warn("[publicacao] esbuild ausente: css/js NAO minificados nesta publicacao.");
    return;
  }
  const arquivos = [
    "public/estaticos/css/csso.css",
    "public/estaticos/css/tema.css",
    "public/estaticos/css/celular.css",
    "public/estaticos/js/csso.js",
    "public/estaticos/js/celular.js",
    "public/estaticos/js/gravador.js",
  ];
  for (const a of arquivos) {
    rodar(esbuild, [a, "--minify", "--allow-overwrite", "--log-level=warning", `--outfile=${a}`]);
  }
}

minificar_casca();

// So o deploy de PRODUCAO mexe no banco. A previa de um PR ou de uma branch
// (CONTEXT=deploy-preview ou branch-deploy) usa a mesma DATABASE_URL quando ela
// vale para todos os contextos: migrar e semear dali alteraria o banco real
// com codigo ainda nao aprovado. Fora do Netlify (CONTEXT ausente) vale o
// comportamento de sempre, para a publicacao feita a mao.
const contexto = (process.env.CONTEXT || "").trim();
if (!process.env.DATABASE_URL) {
  console.warn("[publicacao] DATABASE_URL ausente: banco NAO migrado nesta publicacao.");
} else if (contexto && contexto !== "production") {
  console.warn(`[publicacao] contexto '${contexto}': banco NAO migrado (so o deploy de producao migra).`);
} else {
  rodar("npx", ["tsx", "ferramentas/migrar.ts"]);
  rodar("npx", ["tsx", "ferramentas/semear.ts"]);
  // Login é o e-mail (23/10/2026): só converte no banco com a marca de produção
  rodar("npx", ["tsx", "ferramentas/converter-logins.ts"]);
}
