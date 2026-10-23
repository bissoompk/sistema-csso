/**
 * Redefine a senha de uma conta pela linha de comando — para quando o único
 * superintendente esquece a dele e não sobra ninguém na tela que possa
 * redefinir (a própria senha não se redefine por /usuarios).
 *
 *     npm run redefinir-senha -- --email fabricio@ufvjm.edu.br [--reativar] [--conceder-superintendente [--manter-senha]]
 *
 * O login é o e-mail (23/10/2026): `--email` e `--login` são a mesma coisa, e
 * a conta se acha pelo e-mail OU pelo login antigo, sem caixa — como na tela
 * de entrada (`buscar_por_login`). `--login <nome antigo>` continua valendo.
 *
 * Gera uma senha provisória (`senha_provisoria()`), obriga a troca no próximo
 * login, desbloqueia a conta, derruba as sessões abertas e grava
 * `SENHA_RESETADA` na trilha com o ator "linha de comando". A senha aparece
 * UMA vez, no terminal, e não fica gravada em lugar nenhum. `--reativar`
 * também reativa a conta inativa (`USUARIO_ATIVADO`, mesmo ator).
 *
 * `--conceder-superintendente` (D17) é a outra porta que só a linha de comando
 * abre: quando a última concessão de `perfil.conceder` venceu (ou foi
 * encerrada à mão) e não sobra ninguém na tela que conceda perfil. Concede o
 * perfil de superintendente à conta, sem termo e em todos os campi, com o ato
 * "Linha de comando — recuperação de acesso" (corrija depois em Gerir) e
 * `PERFIL_CONCEDIDO` na trilha com o mesmo ator. Com `--manter-senha` só
 * concede, sem redefinir a senha (a pessoa sabe a dela; faltava o perfil).
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
): Promise<{ senha: string; nome: string; email: string; ativo: boolean } | null> {
  const { usuario } = await import("../src/db/esquema/index.js");
  const autenticacao = await import("../src/servicos/autenticacao.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const alvo = await autenticacao.buscar_por_login(tx, login);
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
  return { senha, nome: alvo.nome, email: alvo.email, ativo: alvo.ativo || reativar };
}

/**
 * Concede superintendente pela linha de comando. Devolve `"concedido"`, `"ja_tinha"`
 * (já há concessão vigente sem termo nem fim próximo — nada muda) ou `null` se o
 * login não existe. Toma a mesma trava de governança da tela.
 */
export async function conceder_superintendente(
  tx: Executor,
  login: string,
): Promise<"concedido" | "ja_tinha" | null> {
  const { perfil, atribuicao } = await import("../src/db/esquema/index.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const governanca = await import("../src/servicos/governanca.js");
  const { hoje_iso } = await import("../src/dominio/datas.js");
  const { vigente_em } = await import("../src/dominio/organizacao.js");
  const datas_br = await import("../src/servicos/datas_br.js");
  const { buscar_por_login } = await import("../src/servicos/autenticacao.js");
  await governanca.travar(tx);
  const alvo = await buscar_por_login(tx, login);
  if (!alvo) return null;
  const [sup] = await tx.select().from(perfil).where(eq(perfil.codigo, "superintendente"));
  if (!sup) throw new Error("o perfil superintendente não existe: rode a semente (ferramentas/semear.ts) antes.");
  const hoje = hoje_iso();
  const atuais = await tx.select().from(atribuicao).where(eq(atribuicao.usuario_id, alvo.id));
  if (atuais.some((a) => a.perfil_id === sup.id && a.campus_id === null && a.vigencia_fim === null && vigente_em(a, hoje))) {
    return "ja_tinha";
  }
  const ato = `Linha de comando — recuperação de acesso (ferramentas/redefinir-senha.ts) em ${datas_br.numerica(hoje)}`;
  const [nova] = await tx
    .insert(atribuicao)
    .values({ usuario_id: alvo.id, perfil_id: sup.id, campus_id: null, vigencia_inicio: hoje, vigencia_fim: null, ato_normativo: ato })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: nova!.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao:
      `Perfil superintendente concedido a '${alvo.login}' (todos os campi; vigência ${datas_br.numerica(hoje)} ` +
      `a sem termo) pela linha de comando — ato: ${ato}`,
    usuario_nome: ATOR,
  });
  await governanca.sincronizar_aviso_de_cobertura(tx, hoje);
  return "concedido";
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
  const login = (valor(argv, "--email") ?? valor(argv, "--login") ?? "").trim();
  if (!login) {
    saida.erro(
      "uso: npm run redefinir-senha -- --email <e-mail> [--reativar] [--conceder-superintendente [--manter-senha]]",
    );
    return 1;
  }
  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const banco = abrirBancoAvulso(url);
  const conceder = argv.includes("--conceder-superintendente");
  const so_conceder = conceder && argv.includes("--manter-senha");
  let feito: Awaited<ReturnType<typeof redefinir>>;
  let concessao: Awaited<ReturnType<typeof conceder_superintendente>>;
  try {
    // tudo numa transação: login inexistente não deixa meia recuperação
    [concessao, feito] = await banco.db.transaction(async (tx) => {
      const c = conceder ? await conceder_superintendente(tx, login) : null;
      const r = !so_conceder && (!conceder || c) ? await redefinir(tx, login, argv.includes("--reativar")) : null;
      return [c, r] as const;
    });
  } finally {
    await banco.fechar();
  }
  if (conceder && concessao === null) {
    saida.erro(`ERRO: não existe conta com o e-mail (ou login) '${login}'. Nada foi alterado.`);
    return 2;
  }
  if (concessao === "concedido") saida.log(`Perfil superintendente concedido a ${login}, sem termo. Corrija o ato em Gerir.`);
  if (concessao === "ja_tinha") saida.log(`${login} já tem superintendente vigente e sem termo: nada concedido.`);
  if (so_conceder) return 0;
  if (!feito) {
    saida.erro(`ERRO: não existe conta com o e-mail (ou login) '${login}'. Nada foi alterado.`);
    return 2;
  }
  saida.log(`Conta:             ${feito.nome} — entra com o e-mail ${feito.email}`);
  saida.log(`Senha provisória:  ${feito.senha}`);
  saida.log("Aparece só agora. O sistema exige a troca no próximo login; as sessões abertas caíram.");
  if (!feito.ativo) saida.log("ATENÇÃO: a conta está INATIVA — rode de novo com --reativar para poder entrar.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
