/**
 * Devolve um backup cifrado (ou uma exportação em claro) a um banco VAZIO.
 * O `backup.restaurar` do Python, da linha de comando.
 *
 *     npx tsx ferramentas/restaurar-backup.ts <arquivo.enc|arquivo.zip> [--permitir-remoto]
 *
 * - O banco de destino é o do `DATABASE_URL`, e tem de estar MIGRADO e SEM
 *   DADOS (`npm run db:migrar`, e não `db:semear`): restaurar em cima de um
 *   banco vivo misturaria duas histórias, e a cadeia da trilha deixaria de
 *   fechar. Por isso a ferramenta recusa banco com qualquer `usuario`.
 * - Os anexos voltam para o armazenamento configurado (Supabase Storage, ou a
 *   pasta local).
 * - A senha do `.enc` é `CSSO_BACKUP_SENHA`.
 * - Fora de localhost pede `--permitir-remoto`, como o ambiente de teste.
 *
 * Restaurar é feito para conferir antes de trocar: o destino recomendado é um
 * banco novo, e a troca da URL da instalação é decisão de quem responde por ela.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";
import { bancoLocal } from "./ambiente-teste.js";

export async function principal(argv: string[]): Promise<number> {
  carregarEnvLocal();
  const arquivo = argv.find((a) => !a.startsWith("--"));
  const url = process.env.DATABASE_URL;
  if (!arquivo || !url) {
    console.error("uso: restaurar-backup <arquivo.enc|arquivo.zip> (com DATABASE_URL apontando para um banco vazio)");
    return 1;
  }
  if (!bancoLocal(url) && !argv.includes("--permitir-remoto")) {
    console.error("ERRO: o banco do .env não está em localhost. Confirme com --permitir-remoto.");
    return 2;
  }
  const backup = await import("../src/servicos/backup.js");
  const PizZip = (await import("pizzip")).default;
  const bruto = new Uint8Array(readFileSync(arquivo));
  let aberto;
  if (Buffer.from(bruto.subarray(0, 8)).equals(backup.MAGICO)) {
    aberto = backup.restaurar(bruto);
  } else {
    // exportação em claro: o mesmo zip, sem o envelope
    const zip = new PizZip(bruto);
    const banco = new Map<string, string>();
    const arquivos = new Map<string, Uint8Array>();
    for (const [nome, entrada] of Object.entries(zip.files)) {
      if (entrada.dir) continue;
      if (nome.startsWith("banco/") && nome.endsWith(".json")) banco.set(nome.slice(6, -5), entrada.asText());
      else if (nome.startsWith("anexos/")) arquivos.set(nome, entrada.asUint8Array());
    }
    aberto = { banco, sqlite: null, arquivos };
  }
  if (!aberto.banco) {
    console.error(
      "Este pacote é um backup do sistema Python (SQLite). Ele não volta ao PostgreSQL por aqui: " +
        "use a migração de dados do Python para o porte.",
    );
    return 3;
  }
  const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
  const { usuario } = await import("../src/db/esquema/index.js");
  const { obterArmazenamento } = await import("../src/servicos/armazenamento.js");
  try {
    const db = obterBanco(url);
    const existentes = await db.select({ id: usuario.id }).from(usuario).limit(1);
    if (existentes.length) {
      console.error("ERRO: o banco de destino já tem dados. Restaure num banco migrado e vazio.");
      return 4;
    }
    const contagem = await db.transaction((tx) => backup.restaurar_no_banco(tx, aberto.banco!));
    const arm = obterArmazenamento();
    for (const [nome, bytes] of aberto.arquivos) {
      if (nome.startsWith("anexos/")) await arm.gravar(nome, bytes);
    }
    const linhas = Object.values(contagem).reduce((a, b) => a + b, 0);
    console.log(`[restaurar] ${Object.keys(contagem).length} tabelas, ${linhas} linhas, ${aberto.arquivos.size} arquivo(s).`);
  } finally {
    await fecharBanco();
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
