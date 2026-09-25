/**
 * Implantação: deixa o banco do `DATABASE_URL` pronto para DADO REAL.
 *
 *     npx tsx ferramentas/producao-iniciar.ts \
 *       --login fabricio --nome "Fabrício ..." --email fabricio@ufvjm.edu.br \
 *       --url-publica https://csso.exemplo.ufvjm.edu.br
 *
 * O que faz, nesta ordem:
 *
 * 1. Mostra que banco é (a referência do projeto Supabase, ou host/banco) e o
 *    que há nele, e pede que se DIGITE essa identidade. Sem isso não segue.
 *    (`--confirmar <identidade>` faz o mesmo sem teclado — para o teste.)
 * 2. Apaga as TABELAS de `public` e o esquema `drizzle` (nunca o esquema
 *    `public`: ver `apagar-banco.ts`), migra e aplica as travas.
 * 3. Numa transação: semeia catálogos e perfis (`semear`), grava a URL
 *    pública do certificado (`certificado.url_publica` — ela vai congelada no
 *    QR), grava a MARCA DE PRODUÇÃO e cria o primeiro superintendente com
 *    senha provisória forte, mostrada UMA vez, com troca obrigatória no
 *    primeiro login (`criar_primeiro_superintendente`).
 *
 * Por que pela linha de comando: assim `/primeiro-acesso` nunca precisa ser
 * aberto na internet (`CSSO_PRIMEIRO_ACESSO_REMOTO` fica desligado).
 *
 * Depois da marca, esta ferramenta e o `ambiente-teste` recusam este banco
 * para sempre. Rodar de novo é recusado — não há bandeira que apague produção.
 */
import { randomInt } from "node:crypto";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";

export interface Opcoes {
  login: string;
  nome: string;
  email: string;
  urlPublica: string;
  confirmar: string | null;
}

// sem 0/O/1/l/I: a senha é lida na tela e digitada à mão uma vez
const LETRAS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITOS = "23456789";

/** 20 caracteres (~113 bits), com letra e dígito — passa na `politica_de_senha` com folga. */
export function senhaProvisoriaForte(tamanho = 20): string {
  const todos = LETRAS + DIGITOS;
  for (;;) {
    let s = "";
    for (let i = 0; i < tamanho; i++) s += todos[randomInt(todos.length)];
    if (/[a-zA-Z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

/**
 * A URL pública do certificado: https, sem caminho além da raiz, sem query.
 * Devolve a forma normalizada (sem barra no fim) ou lança com o motivo.
 */
export function normalizarUrlPublica(bruta: string): string {
  let u: URL;
  try {
    u = new URL(bruta.trim());
  } catch {
    throw new Error(`--url-publica não é uma URL: ${bruta}`);
  }
  if (u.protocol !== "https:") throw new Error("--url-publica tem de ser https:// (vai impressa no QR do certificado)");
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error("--url-publica não pode ser localhost: é o endereço que quem recebe o certificado vai abrir");
  }
  if (u.search || u.hash || u.username || u.password) throw new Error("--url-publica sem query, âncora ou credencial");
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const login = (valor(argv, "--login") ?? "").trim();
  const nome = (valor(argv, "--nome") ?? "").trim();
  const email = (valor(argv, "--email") ?? "").trim();
  const url = valor(argv, "--url-publica") ?? "";
  const faltam = [
    !login && "--login",
    !nome && "--nome",
    !email && "--email",
    !url && "--url-publica",
  ].filter(Boolean);
  if (faltam.length) return `faltam: ${faltam.join(", ")}`;
  if (!/^[a-z0-9._-]{3,64}$/.test(login)) return "--login: 3 a 64 caracteres, só a-z, 0-9, ponto, hífen e sublinhado";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return `--email inválido: ${email}`;
  let urlPublica: string;
  try {
    urlPublica = normalizarUrlPublica(url);
  } catch (erro) {
    return (erro as Error).message;
  }
  return { login, nome, email, urlPublica, confirmar: valor(argv, "--confirmar") };
}

/** O que há no banco antes de apagar — para a pessoa ver o que vai perder. */
async function inventario(url: string): Promise<string> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15 });
  try {
    const [t] = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    if (!t?.n) return "banco vazio (nenhuma tabela em public)";
    const partes = [`${t.n} tabela(s) em public`];
    for (const tabela of ["usuario", "servidor", "processo", "historico_evento"]) {
      const [r] = await sql`SELECT to_regclass(${"public." + tabela}) IS NOT NULL AS ok`;
      if (!r?.ok) continue;
      const [c] = await sql.unsafe(`SELECT count(*)::int AS n FROM public."${tabela}"`);
      partes.push(`${c!.n} ${tabela}`);
    }
    return partes.join(", ");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface Saida {
  log: (linha: string) => void;
  erro: (linha: string) => void;
  perguntar: (pergunta: string) => Promise<string>;
}

async function perguntarNoTerminal(pergunta: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(pergunta);
  } finally {
    rl.close();
  }
}

const SAIDA_PADRAO: Saida = {
  log: (l) => console.log(l),
  erro: (l) => console.error(l),
  perguntar: perguntarNoTerminal,
};

export interface Implantado {
  identidade: string;
  login: string;
  senha: string;
}

/**
 * O trabalho, sem o terminal. Devolve a senha provisória (quem chama mostra).
 * Lança `BancoDeProducao` se o banco já tem a marca.
 */
export async function implantar(url: string, o: Opcoes, marcadaPor: string): Promise<Implantado> {
  const { identidadeDoBanco, gravarMarca } = await import("../src/servicos/instalacao.js");
  const { apagarEMigrar } = await import("./apagar-banco.js");
  const identidade = identidadeDoBanco(url);
  await apagarEMigrar(url, "Implantar produção");

  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const { semear } = await import("../src/servicos/sementes.js");
  const { parametro } = await import("../src/db/esquema/index.js");
  const { PARAMETRO_URL_PUBLICA } = await import("../src/servicos/emissao_certificado.js");
  const autenticacao = await import("../src/servicos/autenticacao.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const senha = senhaProvisoriaForte();
  const banco = abrirBancoAvulso(url);
  try {
    await banco.db.transaction(async (tx) => {
      await semear(tx);
      await tx
        .insert(parametro)
        .values({
          chave: PARAMETRO_URL_PUBLICA,
          valor: o.urlPublica,
          descricao: "Raiz do endereço público de validação — congelada no QR de cada certificado emitido",
        })
        .onConflictDoUpdate({ target: parametro.chave, set: { valor: o.urlPublica } });
      await gravarMarca(tx, identidade, marcadaPor);
      const conta = await autenticacao.criar_primeiro_superintendente(tx, o.login, o.nome, o.email, senha);
      await auditoria.registrar(tx, {
        entidade: "parametro",
        entidade_id: 0,
        tipo_evento: "IMPLANTACAO_PRODUCAO",
        descricao:
          `Banco implantado como PRODUÇÃO por ferramentas/producao-iniciar.ts (${identidade}); ` +
          `URL pública do certificado: ${o.urlPublica}.`,
        campo: PARAMETRO_URL_PUBLICA,
        valor_novo: o.urlPublica,
        usuario_nome: conta.nome,
      });
    });
  } finally {
    await banco.fechar();
  }
  return { identidade, login: o.login, senha };
}

export async function principal(argv: string[], saida: Saida = SAIDA_PADRAO): Promise<number> {
  carregarEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    saida.erro("DATABASE_URL ausente.");
    return 1;
  }
  const opcoes = lerOpcoes(argv);
  if (typeof opcoes === "string") {
    saida.erro(`ERRO: ${opcoes}`);
    saida.erro(
      "uso: producao-iniciar --login <login> --nome <nome> --email <email> --url-publica https://<endereço> [--confirmar <identidade>]",
    );
    return 1;
  }
  const { identidadeDoBanco, marcaDoBanco } = await import("../src/servicos/instalacao.js");
  const identidade = identidadeDoBanco(url);
  const marca = await marcaDoBanco(url);
  if (marca) {
    saida.erro(
      `ERRO: ${identidade} já está marcado como PRODUÇÃO (desde ${new Date(marca.marcada_em).toISOString().slice(0, 10)}, ` +
        `por ${marca.marcada_por}). Nada foi apagado. Ver PRODUCAO.md.`,
    );
    return 3;
  }

  saida.log("=".repeat(66));
  saida.log(" IMPLANTAÇÃO DE PRODUÇÃO — este banco vai ser APAGADO e recomeçar vazio");
  saida.log("=".repeat(66));
  saida.log(`  Banco:        ${url.replace(/:[^:@/]*@/, ":***@")}`);
  saida.log(`  Identidade:   ${identidade}`);
  saida.log(`  Hoje ele tem: ${await inventario(url)}`);
  saida.log(`  URL pública:  ${opcoes.urlPublica}   (congelada no QR de todo certificado)`);
  if (/\.netlify\.app$/i.test(new URL(opcoes.urlPublica).hostname)) {
    saida.log("  ATENÇÃO: a URL pública é um *.netlify.app. Se um domínio institucional vier depois,");
    saida.log("           os certificados já emitidos continuarão apontando para este endereço.");
  }
  saida.log(`  1º superintendente: ${opcoes.login} (${opcoes.nome}, ${opcoes.email})`);
  saida.log("");
  const digitado = opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
  if (digitado.trim() !== identidade) {
    saida.erro("Confirmação não confere. Nada foi apagado.");
    return 2;
  }

  const marcadaPor = `${opcoes.login} via producao-iniciar (${os.userInfo().username}@${os.hostname()})`;
  const { BancoDeProducao } = await import("../src/servicos/instalacao.js");
  let feito: Implantado;
  try {
    feito = await implantar(url, opcoes, marcadaPor);
  } catch (erro) {
    if (erro instanceof BancoDeProducao) {
      saida.erro(`ERRO: ${erro.message}`);
      return 3;
    }
    throw erro;
  }
  saida.log("");
  saida.log("=".repeat(66));
  saida.log(" PRODUÇÃO IMPLANTADA");
  saida.log("=".repeat(66));
  saida.log(`  Banco marcado como PRODUÇÃO: ${feito.identidade}`);
  saida.log(`  Login:             ${feito.login}`);
  saida.log(`  Senha provisória:  ${feito.senha}`);
  saida.log("");
  saida.log("  Esta senha aparece SÓ AGORA e não fica gravada em lugar nenhum.");
  saida.log("  O sistema exige a troca no primeiro login. Não a envie por chat nem e-mail.");
  saida.log("=".repeat(66));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
