/**
 * Importação ÚNICA da planilha do CAT/SP antigo (F9, D5): roda na máquina de
 * quem conduz a migração, nunca no servidor.
 *
 *     npm run importar-catsp -- --pasta <pasta fora do repositório> --por <login> [--simular] [--confirmar <identidade>]
 *
 * A pasta tem as abas da planilha exportadas como CSV, com estes nomes:
 * `COMUNICACOES.csv` (obrigatória), `ANALISES_MAPA.csv` e `PLANO_ACAO.csv`.
 *
 * Importa só o que a ROPA §4.3 permite (ver `src/servicos/acidente_importacao.ts`):
 * CPF, RG, nascimento, sexo, endereço e telefones não chegam ao banco. A pasta
 * contém DADOS PESSOAIS: fica fora do repositório (a ferramenta recusa uma
 * pasta dentro dele) e se apaga depois, com o registro em ata (risco 11 da
 * especificação). O terminal mostra só protocolos e códigos, nunca nome nem texto.
 *
 * `--simular` faz tudo numa transação e a desfaz. Sem ele, pede que se digite a
 * identidade do banco. Pode rodar de novo: protocolo já importado é pulado.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { carregarEnvLocal } from "./env-local.js";

export interface Saida {
  log: (linha: string) => void;
  erro: (linha: string) => void;
  perguntar: (pergunta: string) => Promise<string>;
}

const SAIDA_PADRAO: Saida = {
  log: (l) => console.log(l),
  erro: (l) => console.error(l),
  perguntar: async (pergunta) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(pergunta);
    } finally {
      rl.close();
    }
  },
};

const USO =
  "uso: npm run importar-catsp -- --pasta <pasta fora do repositório> --por <login> [--simular] [--confirmar <identidade do banco>]";

export interface Opcoes {
  pasta: string;
  por: string;
  simular: boolean;
  confirmar: string | null;
}

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

function raizDoRepositorio(inicio: string): string | null {
  let dir = path.resolve(inicio);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const pasta = (valor(argv, "--pasta") ?? "").trim();
  if (!pasta) return "falta --pasta <pasta com os CSV da planilha>";
  const por = (valor(argv, "--por") ?? "").trim();
  if (!por) return "falta --por <login da conta que conduz a migração>";
  const destino = path.resolve(pasta);
  const raiz = raizDoRepositorio(destino);
  if (raiz) {
    return `a pasta ${destino} está dentro do repositório (${raiz}): os dados são pessoais e ficam fora dele`;
  }
  return { pasta: destino, por, simular: argv.includes("--simular"), confirmar: valor(argv, "--confirmar") };
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
  const arquivo = (nome: string, obrigatorio: boolean): string | null => {
    const caminho = path.join(opcoes.pasta, nome);
    if (!existsSync(caminho)) {
      if (obrigatorio) throw new Error(`falta ${nome} na pasta`);
      return null;
    }
    return readFileSync(caminho, "utf8");
  };
  const importacao = await import("../src/servicos/acidente_importacao.js");
  let planilhas;
  try {
    planilhas = {
      comunicacoes: importacao.ler_csv(arquivo("COMUNICACOES.csv", true)!),
      analises: importacao.ler_csv(arquivo("ANALISES_MAPA.csv", false) ?? ""),
      plano: importacao.ler_csv(arquivo("PLANO_ACAO.csv", false) ?? ""),
    };
  } catch (erro) {
    saida.erro(`ERRO: ${erro instanceof Error ? erro.message : String(erro)}`);
    return 1;
  }

  const { identidadeDoBanco } = await import("../src/servicos/instalacao.js");
  const { abrirBancoAvulso } = await import("../src/db/cliente.js");
  const { usuario } = await import("../src/db/esquema/index.js");
  const identidade = identidadeDoBanco(url);
  const banco = abrirBancoAvulso(url);
  try {
    const [ator] = await banco.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.login, opcoes.por));
    if (!ator) {
      saida.erro(`ERRO: não há conta com o login informado em --por.`);
      return 1;
    }
    saida.log("=".repeat(66));
    saida.log(` IMPORTAÇÃO DO CAT/SP ANTIGO${opcoes.simular ? " — SIMULAÇÃO (rollback)" : ""}`);
    saida.log("=".repeat(66));
    saida.log(`  Banco (identidade): ${identidade}`);
    saida.log(
      `  Planilhas: ${planilhas.comunicacoes.length} comunicação(ões), ${planilhas.analises.length} análise(s), ${planilhas.plano.length} ação(ões).`,
    );
    saida.log("  Não vão para o banco: CPF, RG, nascimento, sexo, endereço, telefones, URLs do Drive.");
    if (!opcoes.simular) {
      const digitado = opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
      if (digitado.trim() !== identidade) {
        saida.erro("Confirmação não confere. Nada foi alterado.");
        return 3;
      }
    }
    class Simulado extends Error {
      constructor(public relatorio: import("../src/servicos/acidente_importacao.js").Relatorio) {
        super("simulado");
      }
    }
    let relatorio;
    try {
      relatorio = await banco.db.transaction(async (tx) => {
        const r = await importacao.importar(tx, planilhas, { ator_id: ator.id });
        if (opcoes.simular) throw new Simulado(r);
        return r;
      });
    } catch (erro) {
      if (erro instanceof Simulado) relatorio = erro.relatorio;
      else {
        saida.erro(`ERRO: ${erro instanceof Error ? erro.message.split("\n")[0] : String(erro)}. Nada foi gravado.`);
        return 4;
      }
    }
    saida.log("");
    saida.log(`  Importadas:       ${relatorio.importadas.length}`);
    saida.log(`  Já existiam:      ${relatorio.ja_existiam.length}`);
    saida.log(`  Análises (MAPA):  ${relatorio.investigacoes}`);
    saida.log(`  Ações do plano:   ${relatorio.acoes}`);
    saida.log(`  CPF removidos de textos: ${relatorio.cpf_removidos}`);
    if (relatorio.orfas) saida.log(`  Análises/ações sem a comunicação correspondente: ${relatorio.orfas}`);
    const anos = Object.entries(relatorio.maior_numero_por_ano).map(([a, n]) => `${a}: até ${n}`);
    if (anos.length) saida.log(`  A sequência segue depois de: ${anos.join("; ")}.`);
    for (const r of relatorio.recusadas) saida.erro(`  RECUSADA ${r.protocolo}: ${r.motivo}`);
    for (const a of relatorio.avisos) saida.log(`  aviso ${a.protocolo}: ${a.aviso}`);
    saida.log(
      opcoes.simular
        ? "SIMULAÇÃO: tudo feito numa transação e DESFEITO. Nada foi gravado."
        : "Gravado. Apague a pasta com os CSV (dados pessoais) e registre em ata.",
    );
    return relatorio.recusadas.length ? 5 : 0;
  } finally {
    await banco.fechar();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await principal(process.argv.slice(2)));
}
