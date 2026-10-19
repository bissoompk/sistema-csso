/**
 * Carga de servidores por planilha (.csv ou .xlsx) em `/servidores`.
 *
 * Colunas: SIAPE; Nome; Cargo; UORG; E-mail; Campus — as duas últimas
 * opcionais. A chave é o SIAPE: reimportar o mesmo arquivo não duplica
 * ninguém, só atualiza nome, e-mail, cargo e lotação de quem já existe.
 *
 * Duas passadas com o MESMO código: a prévia roda tudo e a rota desfaz a
 * transação (o padrão de `/importar`); a confirmação roda de novo e grava. Assim
 * a prévia nunca promete o que a gravação não faz.
 *
 * Desconhecidos:
 *   - cargo que não existe é CRIADO (cargo é só um nome; recusar a linha por
 *     isso travaria a carga inteira num cadastro vazio);
 *   - UORG que não existe é criada só quando vem no formato do SIAPE
 *     ("250 - NOME") e o campus se resolve (coluna Campus, ou o único campus
 *     cadastrado); senão o servidor entra SEM lotação e a linha avisa. Unidade
 *     inventada a partir de texto solto sujaria o UORG que sai no parecer.
 *
 * Lotação de quem já existe muda pelo histórico (`alterar_lotacao`, a partir de
 * hoje) — nada é sobrescrito. A trilha leva um evento por importação, com as
 * contagens; a mudança de lotação de cada servidor continua com o seu.
 */
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  campus as tabela_campus,
  cargo as tabela_cargo,
  servidor as tabela_servidor,
  servidor_lotacao,
  unidade_uorg,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { ArquivoZipRecusado, conferir_zip } from "./arquivo_zip.js";
import * as auditoria from "./auditoria.js";
import { MAXIMO_LINHAS_PLANILHA, valor_da_celula } from "./importacao_planilha.js";
import * as servico_servidores from "./servidores.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export const SERVIDORES_IMPORTADOS = "SERVIDORES_IMPORTADOS";

/** O cabeçalho do modelo para baixar. */
export const CABECALHO = ["SIAPE", "Nome", "Cargo", "UORG", "E-mail", "Campus"] as const;

/** Uma linha do arquivo, já como texto. `linha` é o número no arquivo. */
export interface LinhaArquivo {
  linha: number;
  siape: string;
  nome: string;
  cargo: string;
  uorg: string;
  email: string;
  campus: string;
}

export type Acao = "CRIAR" | "ATUALIZAR" | "SEM_MUDANCA" | "RECUSAR";

export interface LinhaResultado {
  linha: number;
  siape: string;
  nome: string;
  acao: Acao;
  detalhes: string[];
}

export interface Resultado {
  linhas: LinhaResultado[];
  criados: number;
  atualizados: number;
  sem_mudanca: number;
  recusados: number;
  cargos_criados: number;
  unidades_criadas: number;
}

/** Arquivo que não se lê — a rota devolve a mensagem para a pessoa. */
export class ArquivoRecusado extends Error {}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
/** Campo do cabeçalho → coluna. Comparação sem acento e sem caixa. */
const SINONIMOS: Record<keyof Omit<LinhaArquivo, "linha">, string[]> = {
  siape: ["siape", "matricula", "matricula siape"],
  nome: ["nome", "nome do servidor", "servidor"],
  cargo: ["cargo"],
  uorg: ["uorg", "lotacao", "unidade", "uorg/lotacao", "uorg / lotacao"],
  email: ["e-mail", "email", "e-mail institucional"],
  campus: ["campus"],
};

/** Um CSV de verdade: aspas, `;` ou `,` ou tabulação, quebra dentro de aspas. */
export function ler_csv(texto: string): string[][] {
  const primeira = texto.split(/\r?\n/, 1)[0] ?? "";
  const sep = primeira.includes(";") ? ";" : primeira.includes("\t") ? "\t" : ",";
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!;
    if (aspas) {
      if (ch === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (ch === '"') aspas = false;
      else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) {
      linha.push(campo);
      campo = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else campo += ch;
  }
  if (campo || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

/** UTF-8 (com ou sem BOM); se não for, o Windows-1252 que o Excel grava. */
function decodificar(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

async function _celulas_xlsx(bytes: Uint8Array): Promise<string[][]> {
  // antes do ExcelJS, que descompacta tudo em memória (zip-bomb)
  conferir_zip(bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  if (ws.rowCount - 1 > MAXIMO_LINHAS_PLANILHA) throw _grande_demais(ws.rowCount - 1);
  const saida: string[][] = [];
  for (let i = 1; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const valores: string[] = [];
    for (let c = 1; c <= Math.max(r.cellCount, CABECALHO.length); c++) {
      const v = valor_da_celula(r.getCell(c).value);
      valores.push(v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
    }
    saida.push(valores);
  }
  return saida;
}

function _grande_demais(n: number): ArquivoRecusado {
  return new ArquivoRecusado(
    `O arquivo tem ${n} linhas; o máximo por importação é ${MAXIMO_LINHAS_PLANILHA}. Divida o arquivo.`,
  );
}

/**
 * O arquivo em linhas nomeadas. Com cabeçalho, as colunas são achadas pelo
 * nome; sem cabeçalho (a primeira célula já é um SIAPE), vale a ordem do modelo.
 */
export async function ler_arquivo(nome: string, bytes: Uint8Array): Promise<LinhaArquivo[]> {
  let celulas: string[][];
  if (/\.xlsx$/i.test(nome)) {
    try {
      celulas = await _celulas_xlsx(bytes);
    } catch (erro) {
      if (erro instanceof ArquivoRecusado) throw erro;
      if (erro instanceof ArquivoZipRecusado) throw new ArquivoRecusado(erro.message);
      throw new ArquivoRecusado("O arquivo não abriu como planilha .xlsx.");
    }
  } else if (/\.(csv|txt)$/i.test(nome)) {
    // CPF que o arquivo traga não chega nem à prévia (revisão de privacidade)
    celulas = ler_csv(decodificar(bytes)).map((l) => l.map((c) => textos.mascarar_cpf(c)));
  } else {
    throw new ArquivoRecusado("Envie um arquivo .csv ou .xlsx (o modelo para baixar está na tela).");
  }
  // linha em branco no fim (ou no meio) não é linha
  const com_numero = celulas
    .map((c, i) => ({ c: c.map((v) => v.trim()), n: i + 1 }))
    .filter((l) => l.c.some((v) => v));
  if (!com_numero.length) throw new ArquivoRecusado("O arquivo está vazio.");

  const primeira = com_numero[0]!.c;
  let indice: Record<keyof Omit<LinhaArquivo, "linha">, number>;
  let dados = com_numero;
  if (/^\d{1,7}$/.test(primeira[0]!.replace(/\D/g, "")) && /\d/.test(primeira[0]!)) {
    indice = { siape: 0, nome: 1, cargo: 2, uorg: 3, email: 4, campus: 5 };
  } else {
    const chaves = primeira.map((v) => textos.chave_busca(v));
    const achar = (sinonimos: string[]) => chaves.findIndex((k) => sinonimos.includes(k));
    indice = {
      siape: achar(SINONIMOS.siape),
      nome: achar(SINONIMOS.nome),
      cargo: achar(SINONIMOS.cargo),
      uorg: achar(SINONIMOS.uorg),
      email: achar(SINONIMOS.email),
      campus: achar(SINONIMOS.campus),
    };
    if (indice.siape < 0 || indice.nome < 0) {
      throw new ArquivoRecusado(
        "O cabeçalho precisa ter as colunas SIAPE e Nome (Cargo, UORG, E-mail e Campus são opcionais). " +
          "Use o modelo para baixar.",
      );
    }
    dados = com_numero.slice(1);
  }
  if (dados.length > MAXIMO_LINHAS_PLANILHA) throw _grande_demais(dados.length);
  const pegar = (c: string[], i: number) => (i >= 0 ? (c[i] ?? "") : "");
  return dados.map(({ c, n }) => ({
    linha: n,
    siape: pegar(c, indice.siape),
    nome: pegar(c, indice.nome),
    cargo: pegar(c, indice.cargo),
    uorg: pegar(c, indice.uorg),
    email: pegar(c, indice.email),
    campus: pegar(c, indice.campus),
  }));
}

/** As linhas que a prévia devolve no formulário de confirmação, conferidas. */
export function linhas_de_json(bruto: string): LinhaArquivo[] {
  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    throw new ArquivoRecusado("A prévia expirou ou veio corrompida: envie o arquivo de novo.");
  }
  if (!Array.isArray(dados) || !dados.length) throw new ArquivoRecusado("Nada para importar: envie o arquivo de novo.");
  if (dados.length > MAXIMO_LINHAS_PLANILHA) throw _grande_demais(dados.length);
  const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return dados.map((d: any) => ({
    linha: Number.isInteger(d?.linha) ? d.linha : 0,
    siape: texto(d?.siape),
    nome: texto(d?.nome),
    cargo: texto(d?.cargo),
    uorg: texto(d?.uorg),
    email: texto(d?.email),
    campus: texto(d?.campus),
  }));
}

// ---------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------
type Cargo = typeof tabela_cargo.$inferSelect;
type Unidade = typeof unidade_uorg.$inferSelect;
type Campus = typeof tabela_campus.$inferSelect;
type Servidor = typeof tabela_servidor.$inferSelect;

/** Linha recusada: a mensagem vai para a coluna "o que acontece". */
class LinhaRecusada extends Error {}

/** O SIAPE como o banco o guarda, ou `null`. Número do Excel perde o zero da frente. */
export function siape_normalizado(bruto: string): string | null {
  const digitos = bruto.replace(/\D/g, "");
  if (!digitos || digitos.length > 7 || /[^\d.\-\s]/.test(bruto)) return null;
  return digitos.padStart(7, "0");
}

/**
 * Roda o arquivo inteiro. Grava SEMPRE — a prévia é esta mesma função dentro de
 * uma transação que a rota desfaz.
 */
export async function importar(tx: Executor, usuario: UsuarioAtual, linhas: LinhaArquivo[]): Promise<Resultado> {
  usuario.exigir("processo.criar");
  const ve_nome = usuario.pode("exposicao.ver");
  const hoje = hoje_iso();

  // tudo o que se consulta por linha, carregado uma vez: 5.000 linhas com
  // quatro idas ao banco cada estourariam o tempo da função
  const servidores = new Map<string, Servidor>(
    (await tx.select().from(tabela_servidor)).map((s) => [s.siape, s] as const),
  );
  const cargos = new Map<string, Cargo>((await tx.select().from(tabela_cargo)).map((c) => [textos.chave_busca(c.nome), c]));
  const unidades = await tx.select().from(unidade_uorg);
  const campi = await tx.select().from(tabela_campus);

  const r: Resultado = {
    linhas: [],
    criados: 0,
    atualizados: 0,
    sem_mudanca: 0,
    recusados: 0,
    cargos_criados: 0,
    unidades_criadas: 0,
  };
  const vistos = new Map<string, number>();

  const achar_campus = (bruto: string): Campus | null => {
    if (!bruto) return campi.length === 1 ? campi[0]! : null;
    const alvo = textos.chave_busca(bruto);
    return campi.find((c) => textos.chave_busca(c.sigla) === alvo || textos.chave_busca(c.nome) === alvo) ?? null;
  };

  const achar_unidade = (bruto: string): Unidade | null => {
    const codigo = textos.codigo_uorg(bruto) ?? (/^\d{1,6}$/.test(bruto) ? bruto : null);
    if (codigo) {
      const u = unidades.find((x) => x.codigo_uorg === codigo);
      if (u) return u;
    }
    const alvo = textos.chave_busca(textos.nome_uorg(bruto));
    return (
      unidades.find(
        (x) =>
          textos.chave_busca(x.nome_oficial) === alvo ||
          textos.chave_busca(x.nome_extenso) === alvo ||
          (x.sigla !== null && textos.chave_busca(x.sigla) === alvo),
      ) ?? null
    );
  };

  for (const l of linhas) {
    const saida: LinhaResultado = { linha: l.linha, siape: l.siape, nome: l.nome, acao: "RECUSAR", detalhes: [] };
    r.linhas.push(saida);
    try {
      const siape = siape_normalizado(l.siape);
      if (!siape) throw new LinhaRecusada("SIAPE inválido: são até 7 dígitos, sem letras");
      saida.siape = siape;
      const repetida = vistos.get(siape);
      if (repetida !== undefined) throw new LinhaRecusada(`SIAPE repetido no arquivo (linha ${repetida})`);
      vistos.set(siape, l.linha);
      const nome = l.nome.replace(/\s+/g, " ").trim();
      if (nome.length > 160) throw new LinhaRecusada("nome com mais de 160 caracteres");
      if (l.cargo.length > 120) throw new LinhaRecusada("cargo com mais de 120 caracteres");

      let email: string | null = l.email.trim() || null;
      if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)) {
        saida.detalhes.push(`e-mail '${email}' ignorado: não parece um endereço`);
        email = null;
      }

      // cada linha num SAVEPOINT: erro de banco numa linha não derruba as outras
      await tx.transaction(async (sp) => {
        let cargo: Cargo | null = null;
        if (l.cargo) {
          const chave = textos.chave_busca(l.cargo);
          cargo = cargos.get(chave) ?? null;
          if (!cargo) {
            [cargo] = (await sp.insert(tabela_cargo).values({ nome: l.cargo.trim() }).returning()) as [Cargo];
            cargos.set(chave, cargo);
            r.cargos_criados++;
            saida.detalhes.push(`cargo '${cargo.nome}' criado`);
          }
        }

        let unidade: Unidade | null = null;
        if (l.uorg) {
          unidade = achar_unidade(l.uorg);
          const codigo = textos.codigo_uorg(l.uorg);
          if (!unidade && codigo && codigo.length <= 6) {
            const cp = achar_campus(l.campus);
            if (cp) {
              const nome_unidade = textos.nome_uorg(l.uorg)!.slice(0, 160);
              [unidade] = (await sp
                .insert(unidade_uorg)
                .values({
                  codigo_uorg: codigo,
                  nome_oficial: nome_unidade,
                  nome_extenso: nome_unidade,
                  tipo: "OUTRO",
                  campus_id: cp.id,
                })
                .returning()) as [Unidade];
              unidades.push(unidade);
              r.unidades_criadas++;
              saida.detalhes.push(`UORG '${l.uorg}' criada no campus ${cp.sigla}`);
            }
          }
          if (!unidade) {
            saida.detalhes.push(
              `UORG '${l.uorg}' não cadastrada: fica sem lotação. ` +
                (codigo ? "Informe o campus na coluna Campus" : "Use o formato do SIAPE ('250 - NOME') e o campus") +
                ", ou cadastre a unidade em Catálogos, e importe de novo",
            );
          }
        }

        const existente = servidores.get(siape);
        if (!existente) {
          if (!nome) throw new LinhaRecusada("sem nome: servidor novo precisa de SIAPE e nome");
          const [novo] = (await sp
            .insert(tabela_servidor)
            .values({
              siape,
              nome,
              cargo_id: cargo ? cargo.id : null,
              unidade_uorg_id: unidade ? unidade.id : null,
              email,
            })
            .returning()) as [Servidor];
          // o primeiro período da linha do tempo, como no cadastro um a um
          await sp.insert(servidor_lotacao).values({
            servidor_id: novo.id,
            unidade_uorg_id: novo.unidade_uorg_id,
            uorg_id: null,
            cargo_id: novo.cargo_id,
            funcao: null,
            vigencia_inicio: hoje,
            registrado_por: usuario.id,
          });
          servidores.set(siape, novo);
          saida.acao = "CRIAR";
          r.criados++;
          return;
        }

        // já existe: só o que veio preenchido e é diferente
        const mudou: string[] = [];
        const antes: Record<string, unknown> = {};
        const depois: Record<string, unknown> = {};
        if (nome && nome !== existente.nome) {
          if (ve_nome) {
            antes.nome = existente.nome;
            depois.nome = nome;
            mudou.push("nome");
          } else {
            // RN-19: quem não lê o nome também não o sobrescreve
            saida.detalhes.push("nome não conferido: a identificação está suprimida nesta sessão");
          }
        }
        if (email && email !== existente.email) {
          antes.email = existente.email;
          depois.email = email;
          mudou.push("e-mail");
        }
        if (mudou.length) {
          await sp.update(tabela_servidor).set(depois).where(eq(tabela_servidor.id, existente.id));
          Object.assign(existente, depois);
          await auditoria.registrar_diferencas(sp, {
            entidade: "servidor",
            entidade_id: existente.id,
            antes,
            depois,
            usuario,
          });
        }
        const troca_cargo = cargo !== null && cargo.id !== existente.cargo_id;
        const troca_unidade =
          unidade !== null && unidade.id !== existente.unidade_uorg_id && unidade.id !== existente.uorg_id;
        if (troca_cargo || troca_unidade) {
          const postos = troca_unidade ? [] : (await servico_servidores.postos_atuais(sp, existente.id)).map((p) => p.id);
          try {
            await sp.transaction((sp2) =>
              servico_servidores.alterar_lotacao(sp2, existente, usuario, {
                unidade_uorg_id: troca_unidade ? unidade!.id : existente.unidade_uorg_id,
                uorg_id: troca_unidade ? null : existente.uorg_id,
                cargo_id: troca_cargo ? cargo!.id : existente.cargo_id,
                funcao: existente.funcao,
                postos,
                a_partir_de: hoje,
                documento: "importação de servidores",
              }),
            );
            if (troca_cargo) mudou.push("cargo");
            if (troca_unidade) mudou.push("lotação");
          } catch (erro) {
            if (!(erro instanceof servico_servidores.LotacaoInvalida)) throw erro;
            saida.detalhes.push(`lotação/cargo não alterados: ${erro.message}`);
          }
        }
        if (mudou.length) {
          saida.acao = "ATUALIZAR";
          saida.detalhes.unshift(`muda ${mudou.join(", ")}`);
          r.atualizados++;
        } else {
          saida.acao = "SEM_MUDANCA";
          r.sem_mudanca++;
        }
      });
    } catch (erro) {
      if (!(erro instanceof LinhaRecusada)) throw erro;
      saida.acao = "RECUSAR";
      saida.detalhes = [erro.message];
      r.recusados++;
    }
  }

  await auditoria.registrar(tx, {
    entidade: "servidor",
    entidade_id: 0,
    tipo_evento: SERVIDORES_IMPORTADOS,
    descricao:
      `Importação de ${linhas.length} linha(s): ${r.criados} criado(s), ${r.atualizados} atualizado(s), ` +
      `${r.sem_mudanca} sem mudança, ${r.recusados} recusada(s); ` +
      `${r.cargos_criados} cargo(s) e ${r.unidades_criadas} UORG(s) criados.`,
    usuario,
  });
  return r;
}
