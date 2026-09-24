/**
 * O `npm run build` do Netlify. Não há o que compilar para o navegador (as
 * telas são renderizadas no servidor e o front React já vem pronto em
 * `public/estaticos/app`): o trabalho da publicação é deixar o BANCO na
 * versão do código que vai ao ar.
 *
 * Sem `DATABASE_URL` (uma prévia de branch sem banco, por exemplo) a
 * migração é pulada com aviso, e a publicação segue.
 */
import { spawnSync } from "node:child_process";

function rodar(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.env.DATABASE_URL) {
  console.warn("[publicacao] DATABASE_URL ausente: banco NAO migrado nesta publicacao.");
} else {
  rodar("npx", ["tsx", "ferramentas/migrar.ts"]);
  rodar("npx", ["tsx", "ferramentas/semear.ts"]);
}
