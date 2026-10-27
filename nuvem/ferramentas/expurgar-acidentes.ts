/**
 * Expurgo parcial do módulo de Acidentes (POLITICA_RETENCAO §2.4): apaga a
 * identificação pessoal do acidentado, o contato das testemunhas e o detalhe de
 * saúde (nível 2) das ocorrências concluídas há mais de N anos e com decisão
 * pericial. A regra mora em `src/servicos/acidente_expurgo.ts`; aqui só a
 * moldura do terminal.
 *
 *     npm run expurgar-acidentes                          # SIMULAÇÃO (padrão): nada é gravado
 *     npm run expurgar-acidentes -- --anos 5              # simulação com outro prazo
 *     npm run expurgar-acidentes -- --executar --ata "Ata 3/2031" [--anos 5] [--confirmar <identidade>]
 *
 * A simulação faz o expurgo inteiro numa transação e dá ROLLBACK: mostra o que
 * seria apagado, por ocorrência, e confere as triggers. Executar exige a
 * referência da ata (`--ata`, vai à trilha) e que se DIGITE a identidade do
 * banco (`--confirmar` faz o mesmo sem teclado, para o teste), como as outras
 * ferramentas de apagar. IRREVERSÍVEL: o dado apagado não é copiado para lugar
 * nenhum — copiar desfaria o expurgo. Faça o backup do banco antes, se quiser
 * poder voltar atrás.
 *
 * Nada pessoal vai ao terminal: só protocolos e contagens.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";
import type { Executor } from "../src/db/cliente.js";
import * as expurgo from "../src/servicos/acidente_expurgo.js";

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
  executar: boolean;
  ata: string | null;
  anos: number | undefined;
  confirmar: string | null;
}

const USO =
  'uso: npm run expurgar-acidentes -- [--anos <N>] [--executar --ata "<referência da ata>" [--confirmar <identidade do banco>]]';

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const anosTexto = valor(argv, "--anos");
  const anos = anosTexto === null ? undefined : Number(anosTexto);
  if (anos !== undefined && (!Number.isInteger(anos) || anos < 1)) return `--anos inválido: ${anosTexto} (número inteiro, de 1 em diante)`;
  const executar = argv.includes("--executar");
  const ata = (valor(argv, "--ata") ?? "").trim() || null;
  if (executar && !ata) return "falta --ata (a referência da ata em que o setor registra o expurgo)";
  return { executar, ata, anos, confirmar: valor(argv, "--confirmar") };
}

/** Marca a simulação: leva o resumo para fora da transação, que é desfeita. */
class Simulacao extends Error {
  constructor(readonly resumo: expurgo.ResumoExpurgo) {
    super("simulação");
  }
}

/** O expurgo inteiro, desfeito no fim: o que seria apagado, sem gravar nada. */
export async function simular(db: { transaction: <T>(f: (tx: Executor) => Promise<T>) => Promise<T> }, o: Opcoes): Promise<expurgo.ResumoExpurgo> {
  try {
    await db.transaction(async (tx) => {
      throw new Simulacao(await expurgo.expurgar(tx, { anos: o.anos, ata: o.ata ?? "simulação" }));
    });
  } catch (erro) {
    if (erro instanceof Simulacao) return erro.resumo;
    throw erro;
  }
  throw new Error("a simulação terminou sem resumo");
}

function mostrar(saida: Saida, r: expurgo.ResumoExpurgo): void {
  saida.log(`  Concluídas até ${r.corte.toISOString().slice(0, 10)} (mais de ${r.anos} ano(s)), com decisão pericial.`);
  if (!r.ocorrencias.length) {
    saida.log("  Nada a expurgar.");
    return;
  }
  for (const o of r.ocorrencias) {
    saida.log(`  ${o.protocolo}: ${o.identificacoes} identificação(ões), ${o.contatos_testemunha} contato(s) de testemunha, ${o.saude} detalhe(s) de saúde`);
  }
  saida.log(`  Total: ${r.ocorrencias.length} ocorrência(s); ${r.identificacoes} identificação(ões), ${r.contatos_testemunha} contato(s), ${r.saude} detalhe(s) de saúde.`);
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
    if (opcoes.ata !== null) expurgo.conferir_ata(opcoes.ata);
    saida.log("=".repeat(66));
    saida.log(` EXPURGO PARCIAL DE ACIDENTES — ${opcoes.executar ? "EXECUÇÃO" : "SIMULAÇÃO (nada é gravado)"}`);
    saida.log("=".repeat(66));
    saida.log(`  Banco (identidade): ${identidade}`);
    const previa = await simular(banco.db, opcoes);
    mostrar(saida, previa);
    if (!opcoes.executar) {
      saida.log("");
      saida.log('Para executar: --executar --ata "<referência da ata>".');
      return 0;
    }
    if (!previa.ocorrencias.length) return 0;
    saida.log("");
    saida.log("IRREVERSÍVEL: o dado apagado não é copiado para lugar nenhum. Faça o backup do banco antes, se quiser poder voltar.");
    const digitado = opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
    if (digitado.trim() !== identidade) {
      saida.erro("Confirmação não confere. Nada foi alterado.");
      return 3;
    }
    const feito = await banco.db.transaction((tx) => expurgo.expurgar(tx, { anos: opcoes.anos, ata: opcoes.ata! }));
    saida.log("");
    saida.log(`Expurgo feito (ata ${feito.ata}):`);
    mostrar(saida, feito);
    saida.log("Um evento por ocorrência foi gravado na trilha, só com contagens. Registre o ato na ata.");
    return 0;
  } catch (erro) {
    if (erro instanceof expurgo.ExpurgoRecusado) {
      saida.erro(`ERRO: ${erro.message} Nada foi alterado.`);
      return 2;
    }
    throw erro;
  } finally {
    await banco.fechar();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
