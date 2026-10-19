/**
 * Redefine a senha de uma conta pela linha de comando — para quando o único
 * superintendente esquece a dele e não sobra ninguém na tela que possa
 * redefinir (a própria senha não se redefine por /usuarios).
 *
 *     npm run redefinir-senha -- --login fabricio [--reativar]
 *
 * Gera uma senha provisória (`senha_provisoria()`), obriga a troca no próximo
 * login, desbloqueia a conta, derruba as sessões abertas e grava
 * `SENHA_RESETADA` na trilha com o ator "linha de comando". A senha aparece
 * UMA vez, no terminal, e não fica gravada em lugar nenhum. `--reativar`
 * também reativa a conta inativa (`USUARIO_ATIVADO`, mesmo ator).
 *
 * Quem roda isto tem o `DATABASE_URL` — já pode tudo no banco. A ferramenta
 * não abre porta nenhuma: só faz pelo caminho auditado o que um UPDATE à mão
 * faria sem rastro.
 */
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { carregarEnvLocal } from "./env-local.js";
import type { Executor } from "../src/db/cliente.js";

export const ATOR = "linha de comando";

export interface Saida {
  log: (linha: string) => void;
  erro: (linha: string) => void;
}

const SAIDA_PADRAO: Saida = { log: (l) => console.log(l), erro: (l) => console.error(l) };

/** O trabalho, sem o terminal. Devolve a senha provisória, ou `null` se o login não existe. */
export async function redefinir(
  tx: Executor,
  login: string,
  reativar = false,
): Promise<{ senha: string; nome: string; ativo: boolean } | null> {
  const { usuario } = await import("../src/db/esquema/index.js");
  const autenticacao = await import("../src/servicos/autenticacao.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const [alvo] = await tx.select().from(usuario).where(eq(usuario.login, login));
  if (!alvo) return null;
  const senha = autenticacao.senha_provisoria();
  await tx
    .update(usuario)
    .set({
      senha_hash: await autenticacao.gerar_hash(senha),
      precisa_trocar_senha: true,
      tentativas_falhas: 0,
      bloqueado_ate: null,
      ...(reativar ? { ativo: true } : {}),
    })
    .where(eq(usuario.id, alvo.id));
  await autenticacao.revogar_do_usuario(tx, alvo.id);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: "SENHA_RESETADA",
    descricao: `Senha de '${alvo.login}' redefinida pela linha de comando (ferramentas/redefinir-senha.ts) e sessões revogadas.`,
    usuario_nome: ATOR,
  });
  if (reativar && !alvo.ativo) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: "USUARIO_ATIVADO",
      descricao: `Conta '${alvo.login}' ativada pela linha de comando.`,
      usuario_nome: ATOR,
    });
  }
  return { senha, nome: alvo.nome, ativo: alvo.ativo || reativar };
}

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

export async function principal(argv: string[], saida: Saida = SAIDA_PADRAO): Promise<number> {
  carregarEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    saida.erro("DATABASE_URL ausente.");
    return 1;
  }
  const login = (valor(argv, "--login") ?? "").trim();
  if (!login) {
    saida.erro("uso: npm run redefinir-senha -- --login <login> [--reativar]");
    return 1;
  }
  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const banco = abrirBancoAvulso(url);
  let feito: Awaited<ReturnType<typeof redefinir>>;
  try {
    feito = await banco.db.transaction((tx) => redefinir(tx, login, argv.includes("--reativar")));
  } finally {
    await banco.fechar();
  }
  if (!feito) {
    saida.erro(`ERRO: não existe conta com o login '${login}'. Nada foi alterado.`);
    return 2;
  }
  saida.log(`Conta:             ${login} (${feito.nome})`);
  saida.log(`Senha provisória:  ${feito.senha}`);
  saida.log("Aparece só agora. O sistema exige a troca no próximo login; as sessões abertas caíram.");
  if (!feito.ativo) saida.log("ATENÇÃO: a conta está INATIVA — rode de novo com --reativar para poder entrar.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
