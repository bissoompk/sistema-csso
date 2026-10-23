/**
 * Login é o e-mail (23/10/2026): converte as contas que já existiam, na
 * publicação, depois de migrar e semear (`preparar-publicacao.mjs`).
 *
 *     npm run db:converter-logins
 *
 * Só faz alguma coisa no banco com a MARCA DE PRODUÇÃO (`instalacao`); no de
 * teste e no local, avisa e sai sem tocar em nada. Idempotente: a conta cujo
 * login já é o e-mail fica como está. A conta em conflito (e-mail vazio,
 * repetido, ou já usado como login de outra) não é convertida e aparece aqui,
 * no log do deploy, com o motivo — corrige-se o e-mail em Usuários e a próxima
 * publicação a converte. Ver `src/servicos/login_email.ts`.
 */
import { carregarEnvLocal } from "./env-local.js";

carregarEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente.");
  process.exit(1);
}
const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
const { converter_logins_para_email } = await import("../src/servicos/login_email.js");
try {
  const r = await obterBanco().transaction((tx) => converter_logins_para_email(tx));
  if (!r.producao) {
    console.log("[logins] banco sem marca de produção: nenhum login convertido (as contas de teste ficam como estão).");
  } else {
    for (const c of r.convertidas) console.log(`[logins] conta ${c.id}: '${c.de}' → '${c.para}'`);
    for (const p of r.puladas) console.warn(`[logins] ATENÇÃO: conta ${p.id} ('${p.login}') NÃO convertida: ${p.motivo}.`);
    console.log(
      `[logins] ${r.convertidas.length} convertida(s), ${r.ja_certas} já com o e-mail como login, ` +
        `${r.puladas.length} pulada(s) por conflito.`,
    );
  }
} finally {
  await fecharBanco();
}
