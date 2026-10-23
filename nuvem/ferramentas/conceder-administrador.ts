/**
 * Concede o perfil Administrador do sistema pela linha de comando — e, se a
 * conta ainda não existe, cria a conta junto.
 *
 *     npm run conceder-administrador -- --email fabricio@ufvjm.edu.br [--nome "Fabrício ..."] [--confirmar <identidade>]
 *
 * O Administrador do sistema (`rbac.PERFIL_ADMINISTRADOR_SISTEMA`) é o perfil
 * acima de todos: só quem já o tem o concede na tela, e por isso a PRIMEIRA
 * concessão só sai por aqui.
 *
 * A conta é identificada pelo E-MAIL (o login de toda conta é o e-mail; a
 * comparação é sem caixa, no e-mail ou no login). `--login` continua aceito
 * como sinônimo, para conta antiga cujo login ainda não é o e-mail.
 *
 * - Conta existe: concede o perfil, em todos os campi e sem termo, com o ato
 *   "Linha de comando — concessão do Administrador do sistema" (corrija depois
 *   em Gerir) e `PERFIL_CONCEDIDO` na trilha com o ator "linha de comando".
 *   A senha da conta NÃO muda. Se ela já tem a concessão vigente sem termo,
 *   nada é gravado.
 * - Conta não existe e veio `--nome`: cria a conta com login = e-mail
 *   (minúsculas, sem espaços), senha provisória forte (`senhaProvisoriaForte`)
 *   mostrada UMA vez no terminal e troca obrigatória no primeiro login
 *   (`USUARIO_CRIADO` na trilha, mesmo ator), e concede o perfil.
 *
 * Antes de gravar mostra a identidade do banco (`identidadeDoBanco`, nunca a
 * URL nem a senha do banco) e pede que se DIGITE essa identidade, como o
 * `producao-iniciar`. `--confirmar <identidade>` faz o mesmo sem teclado (para
 * o teste). Confirmação errada: nada é gravado.
 *
 * A senha provisória não é gravada em lugar nenhum (só o hash Argon2id vai ao
 * banco); não a envie por chat nem e-mail.
 *
 * Quem roda isto tem o `DATABASE_URL` — já pode tudo no banco. A ferramenta
 * não abre porta nenhuma: só faz pelo caminho auditado o que um INSERT à mão
 * faria sem rastro.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { eq, or, sql } from "drizzle-orm";
import { carregarEnvLocal } from "./env-local.js";
import type { Executor } from "../src/db/cliente.js";

export const ATOR = "linha de comando";
export const ATO = "Linha de comando — concessão do Administrador do sistema";

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

export interface Opcoes {
  /** o e-mail (ou o login antigo) que identifica a conta */
  chave: string;
  email: string | null;
  nome: string | null;
  confirmar: string | null;
}

const USO =
  'uso: npm run conceder-administrador -- --email <e-mail> [--nome "<nome completo>"] [--confirmar <identidade do banco>]';

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

/** O login de conta nova: o e-mail, aparado e em minúsculas. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const email = (valor(argv, "--email") ?? "").trim();
  const login = (valor(argv, "--login") ?? "").trim();
  const nome = (valor(argv, "--nome") ?? "").trim();
  if (!email && !login) return "falta --email (o e-mail da conta)";
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return `--email inválido: ${email}`;
  return {
    chave: email ? normalizarEmail(email) : login,
    email: email ? normalizarEmail(email) : null,
    nome: nome || null,
    confirmar: valor(argv, "--confirmar"),
  };
}

/** A conta pelo e-mail ou pelo login, sem caixa. */
async function acharConta(tx: Executor, chave: string) {
  const { usuario } = await import("../src/db/esquema/index.js");
  const achadas = await tx
    .select()
    .from(usuario)
    .where(or(sql`lower(${usuario.email}) = lower(${chave})`, sql`lower(${usuario.login}) = lower(${chave})`));
  return achadas;
}

export type Plano =
  | { tipo: "conceder"; login: string; nome: string; ativo: boolean }
  | { tipo: "criar"; login: string; nome: string; email: string }
  | { tipo: "erro"; mensagem: string };

/** O que vai ser feito — sem gravar nada. */
export async function planejar(tx: Executor, o: Opcoes): Promise<Plano> {
  const achadas = await acharConta(tx, o.chave);
  if (achadas.length > 1) {
    return { tipo: "erro", mensagem: `mais de uma conta responde por '${o.chave}' (e-mail de uma, login de outra). Use --login.` };
  }
  const [conta] = achadas;
  if (conta) return { tipo: "conceder", login: conta.login, nome: conta.nome, ativo: conta.ativo };
  if (!o.email) return { tipo: "erro", mensagem: `não existe conta com o login '${o.chave}'. Para criar, use --email e --nome.` };
  if (!o.nome) return { tipo: "erro", mensagem: `não existe conta com o e-mail '${o.email}'. Para criá-la, informe também --nome.` };
  return { tipo: "criar", login: o.email, nome: o.nome, email: o.email };
}

export interface Feito {
  login: string;
  nome: string;
  criada: boolean;
  concedido: boolean;
  ativo: boolean;
  /** só quando a conta foi criada agora */
  senha: string | null;
}

/**
 * O trabalho, numa transação de quem chama. Toma a trava de governança, como a
 * tela. Lança se o perfil não foi semeado ou se o plano é erro.
 */
export async function executar(tx: Executor, o: Opcoes): Promise<Feito> {
  const { usuario, perfil, atribuicao } = await import("../src/db/esquema/index.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const autenticacao = await import("../src/servicos/autenticacao.js");
  const governanca = await import("../src/servicos/governanca.js");
  const { PERFIL_ADMINISTRADOR_SISTEMA } = await import("../src/servicos/rbac.js");
  const { hoje_iso } = await import("../src/dominio/datas.js");
  const { vigente_em } = await import("../src/dominio/organizacao.js");
  const datas_br = await import("../src/servicos/datas_br.js");
  const { senhaProvisoriaForte } = await import("./producao-iniciar.js");

  await governanca.travar(tx);
  const [adm] = await tx.select().from(perfil).where(eq(perfil.codigo, PERFIL_ADMINISTRADOR_SISTEMA));
  if (!adm) throw new Error(`o perfil ${PERFIL_ADMINISTRADOR_SISTEMA} não existe: rode a semente (npm run db:semear) antes.`);
  const plano = await planejar(tx, o);
  if (plano.tipo === "erro") throw new Error(plano.mensagem);
  const hoje = hoje_iso();

  let senha: string | null = null;
  let [alvo] = await acharConta(tx, o.chave);
  if (!alvo) {
    if (plano.tipo !== "criar") throw new Error("a conta sumiu entre o plano e a gravação");
    senha = senhaProvisoriaForte();
    [alvo] = await tx
      .insert(usuario)
      .values({
        login: plano.login,
        nome: plano.nome,
        email: plano.email,
        senha_hash: await autenticacao.gerar_hash(senha),
        precisa_trocar_senha: true,
      })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo!.id,
      tipo_evento: "USUARIO_CRIADO",
      descricao: `Conta '${alvo!.login}' criada pela linha de comando (ferramentas/conceder-administrador.ts).`,
      usuario_nome: ATOR,
    });
  }
  const conta = alvo!;
  const atuais = await tx.select().from(atribuicao).where(eq(atribuicao.usuario_id, conta.id));
  const ja_tinha = atuais.some(
    (a) => a.perfil_id === adm.id && a.campus_id === null && a.vigencia_fim === null && vigente_em(a, hoje),
  );
  if (!ja_tinha) {
    const ato = `${ATO} (ferramentas/conceder-administrador.ts) em ${datas_br.numerica(hoje)}`;
    const [nova] = await tx
      .insert(atribuicao)
      .values({ usuario_id: conta.id, perfil_id: adm.id, campus_id: null, vigencia_inicio: hoje, vigencia_fim: null, ato_normativo: ato })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "atribuicao",
      entidade_id: nova!.id,
      tipo_evento: "PERFIL_CONCEDIDO",
      descricao:
        `Perfil ${PERFIL_ADMINISTRADOR_SISTEMA} concedido a '${conta.login}' (todos os campi; vigência ` +
        `${datas_br.numerica(hoje)} a sem termo) pela linha de comando — ato: ${ato}`,
      usuario_nome: ATOR,
    });
    await governanca.sincronizar_aviso_de_cobertura(tx, hoje);
  }
  return { login: conta.login, nome: conta.nome, criada: senha !== null, concedido: !ja_tinha, ativo: conta.ativo, senha };
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
    saida.erro(USO);
    return 1;
  }
  const { identidadeDoBanco } = await import("../src/servicos/instalacao.js");
  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const identidade = identidadeDoBanco(url);
  const banco = abrirBancoAvulso(url);
  try {
    const plano = await planejar(banco.db, opcoes);
    if (plano.tipo === "erro") {
      saida.erro(`ERRO: ${plano.mensagem} Nada foi alterado.`);
      return 2;
    }
    saida.log("=".repeat(66));
    saida.log(" ADMINISTRADOR DO SISTEMA — concessão pela linha de comando");
    saida.log("=".repeat(66));
    saida.log(`  Banco (identidade): ${identidade}`);
    if (plano.tipo === "conceder") {
      saida.log(`  Conta existente:    ${plano.login} (${plano.nome})${plano.ativo ? "" : " — INATIVA"}`);
      saida.log("  Vai: conceder o perfil Administrador do sistema (todos os campi, sem termo).");
      saida.log("       A senha da conta não muda.");
    } else {
      saida.log(`  Conta NOVA:         ${plano.login} (${plano.nome})`);
      saida.log("  Vai: criar a conta com senha provisória e conceder o perfil Administrador do sistema.");
    }
    saida.log("");
    const digitado =
      opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
    if (digitado.trim() !== identidade) {
      saida.erro("Confirmação não confere. Nada foi alterado.");
      return 3;
    }
    const feito = await banco.db.transaction((tx) => executar(tx, opcoes));
    saida.log("");
    if (feito.criada) saida.log(`Conta criada:      ${feito.login} (${feito.nome})`);
    saida.log(
      feito.concedido
        ? `Perfil Administrador do sistema concedido a ${feito.login}, sem termo. Corrija o ato em Gerir.`
        : `${feito.login} já tem o Administrador do sistema vigente e sem termo: nada concedido.`,
    );
    if (feito.senha) {
      saida.log(`Senha provisória:  ${feito.senha}`);
      saida.log("Aparece SÓ AGORA e não fica gravada em lugar nenhum. O sistema exige a troca no primeiro login.");
      saida.log("Não a envie por chat nem e-mail.");
    }
    if (!feito.ativo) {
      saida.log(
        `ATENÇÃO: a conta está INATIVA — reative com: npm run redefinir-senha -- --login ${feito.login} --reativar`,
      );
    }
    return 0;
  } finally {
    await banco.fechar();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
