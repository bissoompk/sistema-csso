/**
 * Limpeza do módulo Certificados e Treinamentos — para recomeçar o cadastro com
 * dados corretos (pedido de 23/10/2026).
 *
 *     npm run limpar-treinamentos -- --copia <pasta fora do repositório> --simular
 *     npm run limpar-treinamentos -- --copia <pasta fora do repositório> [--confirmar <identidade>]
 *
 * Desde 24/10/2026 o trabalho é do motor da limpeza de dados de teste
 * (`src/servicos/limpeza.ts`, o mesmo da tela `/config/limpar-dados`), com o
 * plano do módulo de treinamentos — MENOS os locais de treinamento, que esta
 * ferramenta sempre manteve (são cadastro, como os modelos). O que muda aqui
 * é a moldura: a cópia local em vez do backup, e a identidade digitada no
 * terminal.
 *
 * APAGA (tudo do módulo): treinamento, turma, inscrição (com a situação, a
 * nota/frequência e os pedidos pelo link), presença, certificados emitidos
 * (e os valores por turma/inscrição), participantes e e-mails, mesclagens e
 * pares de duplicados, instrutores/assinaturas e as qualificações deles,
 * turma_instrutor/ajudante, `acesso_participante`, o vínculo EPI x treinamento
 * (`epi_item_treinamento`), a avaliação de reação (convites e respostas), os
 * avisos na fila de e-mail e as pendências ligados a isso e os anexos do
 * módulo (rubricas, comprovantes de qualificação, PDFs).
 * Os arquivos do armazenamento que ficariam órfãos (PDF/DOCX de certificado,
 * lista de presença, blobs de anexo) são apagados DEPOIS do commit do banco.
 *
 * MANTÉM: modelos de certificado (`certificado_modelo` e `_tag`; o vínculo do
 * modelo com um treinamento é desfeito — passa a modelo genérico), a numeração
 * (`certificado_sequencia*`, `turma_sequencia`: número usado não se reaproveita),
 * os locais de treinamento, servidores, usuários, perfis, setores promotores,
 * catálogos, EPI, processos e a TRILHA de auditoria (append-only,
 * hash-encadeada) — que ganha UM evento, `DADOS_DE_TREINAMENTO_APAGADOS`, com
 * as contagens e sem dado pessoal.
 *
 * Como funciona, nesta ordem:
 *
 * 1. Lê do catálogo do Postgres as chaves estrangeiras e confere que NENHUMA
 *    linha que fica referencia linha que sai, e que nenhum gatilho de DELETE
 *    existe nas tabelas apagadas. Se houver, aborta listando — nada é gravado.
 * 2. Mostra a identidade do banco (`identidadeDoBanco`, nunca URL nem senha) e
 *    as contagens por tabela; pede que se DIGITE a identidade (ou
 *    `--confirmar <identidade>`).
 * 3. UMA transação: trava as tabelas, grava a CÓPIA LOCAL (JSON, permissão 600,
 *    em `--copia`, fora do repositório) com todas as linhas que serão apagadas,
 *    apaga por DELETE na ordem topológica (nunca TRUNCATE ... CASCADE; nenhuma
 *    trava de trilha é desligada), registra o evento pela via oficial
 *    (`auditoria.registrar`), confere que tudo zerou e que o que ficava ficou.
 *    Qualquer divergência desfaz tudo.
 * 4. Depois do commit apaga os arquivos órfãos do armazenamento (falha ali não
 *    desfaz o banco: é relatada) e confere de novo.
 *
 * `--simular` faz o passo 3 numa transação e dá ROLLBACK (não grava a cópia, não
 * mexe no armazenamento, não pede confirmação) e imprime o que seria feito.
 *
 * Idempotente: com tudo vazio não faz nada e diz isso.
 *
 * A cópia contém DADOS PESSOAIS (nome, CPF, e-mail): guarde-a em lugar seguro e
 * apague-a quando não for mais necessária. Nada pessoal vai ao terminal: só contagens.
 */
import { createInterface } from "node:readline/promises";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { carregarEnvLocal } from "./env-local.js";
import type { Executor } from "../src/db/cliente.js";
import * as limpeza from "../src/servicos/limpeza.js";

export const ATOR = "linha de comando (limpeza de treinamentos)";
export const TIPO_EVENTO = "DADOS_DE_TREINAMENTO_APAGADOS";

/** Os locais ficam (são cadastro): a única diferença para o módulo da tela. */
// os locais e a numeração ficam: esta ferramenta recomeça o cadastro, e o número
// usado aqui não se reaproveita (a tela de limpeza dos testes, sim, zera)
export const MANTER: readonly string[] = ["local_treinamento", ...limpeza.NUMERACAO.treinamentos];

/** O plano desta ferramenta: o módulo de treinamentos, sem os locais. */
export function plano(): limpeza.Plano {
  return limpeza.plano_dos_modulos(["treinamentos"], { manter: MANTER });
}

/** Tabelas esvaziadas por inteiro. A ordem de DELETE sai do catálogo (topológica). */
export const TABELAS_APAGAR: readonly string[] = plano().apagar;

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
  copia: string;
  simular: boolean;
  confirmar: string | null;
}

const USO =
  "uso: npm run limpar-treinamentos -- --copia <pasta fora do repositório> [--simular] [--confirmar <identidade do banco>]";

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

/** A raiz do repositório git que contém `inicio` (ou null). */
function raizDoRepositorio(inicio: string): string | null {
  let dir = path.resolve(inicio);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

function dentroDe(filho: string, pai: string): boolean {
  const rel = path.relative(pai, filho);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function lerOpcoes(argv: string[]): Opcoes | string {
  const copia = (valor(argv, "--copia") ?? "").trim();
  if (!copia) return "falta --copia <pasta> (a cópia local dos dados antes de apagar é obrigatória)";
  const destino = path.resolve(copia);
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  for (const raiz of [raizDoRepositorio(aqui), raizDoRepositorio(process.cwd())]) {
    if (raiz && dentroDe(destino, raiz)) {
      return `--copia não pode ficar dentro do repositório (${raiz}): a cópia tem dados pessoais`;
    }
  }
  return { copia: destino, simular: argv.includes("--simular"), confirmar: valor(argv, "--confirmar") };
}

/**
 * O grafo (só leitura): os problemas e a ordem de DELETE das tabelas
 * esvaziadas por inteiro (as parciais — anexo, pendência, e-mail — saem pelos
 * ids fixados antes).
 */
export async function conferirGrafo(tx: Executor): Promise<{ problemas: string[]; ordem: string[] }> {
  const p = plano();
  const a = await limpeza.analisar(tx, p);
  return { problemas: a.problemas, ordem: a.ordem.filter((t) => p.apagar.includes(t)) };
}

async function gravarCopia(
  tx: Executor,
  p: limpeza.Plano,
  a: limpeza.Analise,
  dir: string,
  identidade: string,
): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tabelas: Record<string, unknown> = {};
  const dump = async (t: string, onde: string) => {
    const [l] = (await tx.execute(
      sql.raw(`SELECT coalesce(json_agg(x), '[]'::json) AS dados FROM public."${t}" x WHERE ${onde}`),
    )) as unknown as { dados: unknown }[];
    const bruto = l!.dados;
    tabelas[t] = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
  };
  for (const t of [...p.apagar, ...Object.keys(p.parciais)]) await dump(t, limpeza.filtro_da_tabela(p, a, t));
  for (const [chave, aponta] of a.desvinculos) {
    const [t] = chave.split(".");
    if (!tabelas[t!]) await dump(t!, aponta);
  }
  const agora = new Date();
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const arquivo = path.join(dir, `copia-treinamentos-${identidade.replace(/[^A-Za-z0-9._-]/g, "_")}-${carimbo}.json`);
  const conteudo = {
    aviso: "CONTÉM DADOS PESSOAIS (nomes, CPF, e-mails). Guarde em lugar seguro e apague quando não for mais necessária.",
    gerada_em: agora.toISOString(),
    banco: identidade,
    nota: "'certificado_modelo' lista só os modelos que estavam vinculados a um treinamento (a coluna treinamento_id foi zerada). Os arquivos (PDF/DOCX/blobs) não estão aqui.",
    tabelas,
  };
  writeFileSync(arquivo, JSON.stringify(conteudo), { mode: 0o600, flag: "wx" });
  chmodSync(arquivo, 0o600);
  return arquivo;
}

export function descricaoDoEvento(antes: limpeza.Contagens): string {
  return (
    `Dados do módulo Certificados e Treinamentos apagados pela linha de comando ` +
    `(ferramentas/limpar-treinamentos.ts), com cópia local feita antes: ${limpeza.resumo_contagens(antes)}. ` +
    `Mantidos: modelos de certificado, numeração, locais, servidores, usuários, perfis, setores promotores, catálogos, EPI, processos e esta trilha.`
  );
}

function mostrar(saida: Saida, titulo: string, linhas: Record<string, number>) {
  saida.log(titulo);
  for (const [t, n] of Object.entries(linhas)) saida.log(`    ${t.padEnd(40)} ${String(n).padStart(8)}`);
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
  const p = plano();
  try {
    // 1. grafo + contagens, sem gravar nada
    const a = await limpeza.analisar(banco.db, p);
    if (a.problemas.length) {
      saida.erro("ERRO: o grafo de chaves estrangeiras não confere com a lista. Nada foi alterado:");
      for (const x of a.problemas) saida.erro(`  - ${x}`);
      return 2;
    }
    const antes = await limpeza.contagens(banco.db, p, a);

    saida.log("=".repeat(66));
    saida.log(` LIMPEZA DE TREINAMENTOS${opcoes.simular ? " — SIMULAÇÃO (rollback)" : ""}`);
    saida.log("=".repeat(66));
    saida.log(`  Banco (identidade): ${identidade}`);
    saida.log("");
    mostrar(saida, "  A APAGAR (linhas):", antes.apagar);
    mostrar(saida, "  A DESVINCULAR (a linha fica, perde o vínculo):", antes.desvincular);
    saida.log("");
    saida.log(`  A MANTER: ${Object.keys(antes.mantidas).length} tabela(s), conferidas antes e depois.`);
    saida.log("");

    if (limpeza.total_a_apagar(antes) === 0) {
      saida.log("Nada a apagar: o módulo já está vazio. Nada foi alterado.");
      return 0;
    }

    if (!opcoes.simular) {
      saida.log("ATENÇÃO: a cópia local conterá DADOS PESSOAIS (nome, CPF, e-mail). Guarde-a em lugar seguro.");
      saida.log(`  Pasta da cópia: ${opcoes.copia}`);
      const digitado =
        opcoes.confirmar ?? (await saida.perguntar(`Para confirmar, digite a identidade do banco (${identidade}): `));
      if (digitado.trim() !== identidade) {
        saida.erro("Confirmação não confere. Nada foi alterado.");
        return 3;
      }
    }

    // 2. a transação
    let resultado: limpeza.Resultado;
    let arquivoCopia: string | null = null;
    try {
      resultado = await banco.db.transaction((tx) =>
        limpeza.executar(tx, p, {
          simular: opcoes.simular,
          tipo_evento: TIPO_EVENTO,
          entidade: "instalacao",
          usuario_nome: ATOR,
          descricao: descricaoDoEvento,
          antes_de_apagar: async (tx2, _antes, analise) => {
            arquivoCopia = await gravarCopia(tx2, p, analise, opcoes.copia, identidade);
          },
        }),
      );
    } catch (erro) {
      if (erro instanceof limpeza.Simulado) {
        resultado = erro.resultado;
      } else {
        const msg = erro instanceof Error ? erro.message : String(erro);
        saida.erro(`ERRO: ${msg.split("\n\n")[0]}`);
        saida.erro("Nada foi gravado (a transação foi desfeita).");
        return erro instanceof limpeza.GrafoNaoConfere ? 2 : 4;
      }
    }

    // 3. armazenamento
    let arm: limpeza.RelatorioArmazenamento | null = null;
    try {
      arm = await limpeza.apagar_orfaos(resultado.arquivos, !opcoes.simular);
    } catch {
      arm = null;
    }

    saida.log("");
    saida.log(`  Ordem dos DELETEs: ${resultado.ordem.join(" > ")}.`);
    if (opcoes.simular) {
      saida.log("SIMULAÇÃO: tudo feito numa transação e DESFEITO (rollback). Nada foi gravado, nenhuma cópia nem arquivo mexido.");
      if (arm) saida.log(`  Arquivos órfãos no armazenamento que seriam apagados: ${arm.encontrados}`);
      saida.log("  Conferência dentro da transação: tudo zerou e o que fica ficou.");
      return arm && arm.falhas === 0 ? 0 : 5;
    }
    saida.log(`Cópia local gravada (permissão 600): ${arquivoCopia}`);
    saida.log("  Contém DADOS PESSOAIS: guarde em lugar seguro.");
    saida.log(`Banco: apagado e conferido (1 evento ${TIPO_EVENTO} na trilha).`);
    let codigo = 0;
    if (!arm) {
      saida.erro("ATENÇÃO: não foi possível limpar o armazenamento (o banco JÁ foi apagado). Arquivos órfãos ficaram.");
      codigo = 5;
    } else {
      saida.log(`Armazenamento: ${arm.apagados} arquivo(s) órfão(s) apagado(s) de ${arm.encontrados} encontrado(s).`);
      if (arm.falhas) {
        saida.erro(`ATENÇÃO: ${arm.falhas} falha(s) ao limpar o armazenamento (o banco JÁ foi apagado). Rode de novo não adianta: apague os arquivos à mão.`);
        codigo = 5;
      }
    }

    // 4. conferência final, fora da transação
    const depois = await limpeza.contagens(banco.db, p, await limpeza.analisar(banco.db, p));
    const sobra = Object.entries(depois.apagar).filter(([, n]) => n !== 0);
    if (sobra.length) {
      saida.erro(`ERRO: depois do commit ainda há linhas: ${sobra.map(([t, n]) => `${t}=${n}`).join(", ")}`);
      return 6;
    }
    saida.log("Conferido: tudo do módulo zerou e o que devia ficar ficou.");
    return codigo;
  } finally {
    await banco.fechar();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
