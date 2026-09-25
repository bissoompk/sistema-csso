/**
 * As rotinas agendadas, à mão — o `BACKUP-AGORA.bat` e o `conferir_cadeia`
 * do Python. Rodam contra o banco do `DATABASE_URL` e o armazenamento
 * configurado (Supabase Storage com `SUPABASE_URL`, senão a pasta local).
 *
 *     npx tsx ferramentas/rotinas.ts backup      # backup cifrado + retenção
 *     npx tsx ferramentas/rotinas.ts noturnas    # sessões, pendências, cadeia
 *
 * Saída 0 = tudo certo; 1 = alguma rotina falhou (o motivo sai na tela e em
 * `rotina_execucao`).
 */
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";

export async function principal(argv: string[]): Promise<number> {
  carregarEnvLocal();
  const acao = argv[0];
  if (!process.env.DATABASE_URL || !["backup", "noturnas"].includes(acao ?? "")) {
    console.error("uso: rotinas <backup|noturnas>  (com DATABASE_URL)");
    return 2;
  }
  const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
  const rotinas = await import("../src/servicos/rotinas.js");
  try {
    if (acao === "backup") {
      const r = await rotinas.backup_diario(obterBanco());
      (r.ok ? console.log : console.error)(`[backup] ${r.ok ? "ok" : "FALHA"} em ${r.ms} ms — ${r.detalhe}`);
      return r.ok ? 0 : 1;
    }
    const r = await rotinas.rotinas_noturnas(obterBanco());
    for (const p of r.passos) (p.ok ? console.log : console.error)(`[${p.rotina}] ${p.ok ? "ok" : "FALHA"} — ${p.detalhe}`);
    return r.ok ? 0 : 1;
  } finally {
    await fecharBanco();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
