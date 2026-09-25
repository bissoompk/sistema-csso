/**
 * Devolve um backup cifrado (ou uma exportação em claro) a um banco VAZIO.
 * O `backup.restaurar` do Python, da linha de comando.
 *
 *     npx tsx ferramentas/restaurar-backup.ts <arquivo.enc|arquivo.zip> [--anexos <pasta>] [--permitir-remoto]
 *
 * - O banco de destino é o do `DATABASE_URL`, e tem de estar MIGRADO e SEM
 *   DADOS (`npm run db:migrar`, e não `db:semear`): restaurar em cima de um
 *   banco vivo misturaria duas histórias, e a cadeia da trilha deixaria de
 *   fechar. Por isso a ferramenta recusa banco com qualquer `usuario`.
 * - Os anexos voltam para o armazenamento configurado (Supabase Storage, ou a
 *   pasta local).
 * - A senha do `.enc` é `CSSO_BACKUP_SENHA`.
 * - Pacote do backup DIÁRIO (tem `anexos.json`): os anexos não estão dentro
 *   dele, e sim cifrados um a um em `backups/anexos/<sha256>.enc`. Eles são
 *   lidos de `--anexos <pasta>` (a pasta `backups/anexos` baixada do bucket)
 *   ou, sem a opção, do próprio armazenamento configurado. Cada um é conferido
 *   pelo SHA-256 antes de voltar.
 * - Fora de localhost pede `--permitir-remoto`, como o ambiente de teste.
 *
 * Restaurar é feito para conferir antes de trocar: o destino recomendado é um
 * banco novo, e a troca da URL da instalação é decisão de quem responde por ela.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";
import { bancoLocal } from "./ambiente-teste.js";

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

export async function principal(argv: string[]): Promise<number> {
  carregarEnvLocal();
  const anexosPasta = valor(argv, "--anexos");
  const arquivo = argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] === "--anexos" && a === anexosPasta));
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
    let arquivos = 0;
    for (const [nome, bytes] of aberto.arquivos) {
      if (!nome.startsWith("anexos/")) continue;
      await arm.gravar(nome, bytes);
      arquivos += 1;
    }
    const faltando: string[] = [];
    if (aberto.anexos_separados) {
      const pasta = valor(argv, "--anexos");
      for (const { storage_key } of aberto.anexos_separados) {
        // o índice vem de dentro do pacote, mas a chave é refeita aqui e não lida
        // dele: `storage_key` é `ab/<sha256>` e nada além disso vira caminho
        const m = /^([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(storage_key);
        if (!m || m[1] !== m[2]!.slice(0, 2)) throw new Error(`storage_key inesperado no índice: ${storage_key}`);
        const copia = backup.chave_do_anexo_no_backup(storage_key);
        let cifrado: Uint8Array;
        try {
          cifrado = pasta
            ? new Uint8Array(readFileSync(path.join(pasta, path.basename(copia))))
            : await arm.ler(copia);
        } catch {
          faltando.push(storage_key);
          continue;
        }
        const bytes = backup.decifrar(cifrado, backup.senha_padrao());
        if (createHash("sha256").update(bytes).digest("hex") !== m[2]) {
          // cópia que não é o que diz ser não volta — e a restauração não termina "ok"
          faltando.push(`${storage_key} (SHA-256 não confere)`);
          continue;
        }
        await arm.gravar(`anexos/${storage_key}`, bytes);
        arquivos += 1;
      }
    }
    const linhas = Object.values(contagem).reduce((a, b) => a + b, 0);
    console.log(`[restaurar] ${Object.keys(contagem).length} tabelas, ${linhas} linhas, ${arquivos} arquivo(s).`);
    if (faltando.length) {
      console.error(`[restaurar] ATENÇÃO: ${faltando.length} anexo(s) sem cópia íntegra: ${faltando.slice(0, 5).join(", ")}${faltando.length > 5 ? "…" : ""}`);
      return 5;
    }
  } finally {
    await fecharBanco();
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
