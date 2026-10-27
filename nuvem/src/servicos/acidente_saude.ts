/**
 * A saúde do acidentado (fatia F3, ROPA §4.4): dado sensível, em dois níveis,
 * lido por UM serviço só (`ler`) e escrito por outro (`registrar`).
 *
 * - **Nível 1** (`acidente.saude_ver`): natureza da lesão (catálogo), partes do
 *   corpo, lateralidade e os fatos SIM/NÃO/NÃO SEI (atendimento, afastamento,
 *   internação, óbito, sequela);
 * - **Nível 2** (`acidente.saude_detalhe_ver`): dias, datas e primeiro socorro.
 *
 * **Quem declara.** O comunicante declara só parte do corpo e os quatro fatos
 * (D4); isso vira uma linha `DECLARADO_COMUNICANTE` na hora da comunicação
 * (`declarar`) e a pendência `ACIDENTE_SAUDE_REGISTRAR`, que o médico do
 * trabalho fecha ao confirmar (`registrar`, que passa a origem para
 * `REGISTRADO_MEDICO`).
 *
 * **Como se lê.** A finalidade se escolhe ANTES de ver (lista fechada,
 * `FINALIDADES_SAUDE`) e toda abertura grava `acesso_dado_sensivel`, com o
 * acidentado (`acidentado_id`, ROPA §9.6) e a ocorrência. Quem abre sem
 * conduzir o caso (não é o responsável) deixa também um evento na trilha. O
 * próprio acidentado servidor lê tudo da própria ocorrência, sem finalidade e
 * sem registro (LGPD art. 18, II).
 *
 * **Como se escreve.** Só `acidente.saude_registrar`, com controle otimista
 * (`versao`). A trilha diz QUAIS campos mudaram, nunca os valores. O nível 2 não
 * se apaga por aqui: a trigger só o deixa ir a NULL junto do carimbo de expurgo
 * (ato manual, POLITICA §2.4), e o serviço recusa antes, com a frase certa.
 *
 * A ocorrência restrita (acidentado menor de idade, D14a) só se abre a quem
 * instrui o caso (`pode_ver_restrita_sst`): para os outros, é como se não
 * existisse.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidentado as tabela_acidentado,
  acidente_natureza_lesao,
  acidente_parte_corpo,
  acidente_saude,
  acidente_saude_parte,
  pendencia as tabela_pendencia,
} from "../db/esquema/index.js";
import {
  COLUNAS_SAUDE_NIVEL_2,
  FINALIDADES_SAUDE,
  LATERALIDADES,
  ROTULO_FINALIDADE_SAUDE,
  ROTULO_LATERALIDADE,
  ROTULO_ORIGEM_SAUDE,
  SIM_NAO_NAO_SEI,
} from "../dominio/acidente.js";
import { RegraViolada } from "../nucleo/erros.js";
import { pode_ver_restrita_sst } from "./acidente_acesso.js";
import type { Ocorrencia, SaudeDeclarada } from "./acidente_comunicacao.js";
import * as auditoria from "./auditoria.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export class SaudeRecusada extends RegraViolada {}
/** O registro mudou desde que a tela foi aberta: nada se grava por cima. */
export class SaudeAlterada extends SaudeRecusada {}
/** O acidentado não existe nesta ocorrência, ou a ocorrência é restrita a quem pede. */
export class SaudeInexistente extends RegraViolada {}

export type Nivel = 1 | 2;

const ENTIDADE = "acidente_ocorrencia";
const FATOS = ["houve_atendimento", "houve_afastamento", "houve_internacao", "houve_obito", "houve_sequela"] as const;
type Fato = (typeof FATOS)[number];

export const ROTULO_CAMPO: Readonly<Record<string, string>> = {
  natureza_lesao_id: "natureza da lesão",
  partes_corpo: "partes do corpo",
  lateralidade: "lateralidade",
  houve_atendimento: "atendimento",
  houve_afastamento: "afastamento",
  houve_internacao: "internação",
  houve_obito: "óbito",
  houve_sequela: "sequela",
  dias_afastamento: "dias de afastamento",
  afastamento_inicio: "início do afastamento",
  afastamento_retorno: "retorno do afastamento",
  dias_internacao: "dias de internação",
  data_obito: "data do óbito",
  dias_debitados: "dias debitados",
  primeiro_socorro_por: "primeiro socorro (quem)",
  primeiro_socorro_unidade: "primeiro socorro (onde)",
  atendimento_em: "momento do atendimento",
  duracao_tratamento_dias: "duração provável do tratamento",
  deve_afastar: "deve afastar-se",
  descricao_lesao: "descrição da lesão",
  diagnostico_provavel: "diagnóstico provável",
  cid: "CID",
  observacoes_saude: "observações de saúde",
};

// ---------------------------------------------------------------------
// Quem pode o quê
// ---------------------------------------------------------------------
/** O acidentado é a própria conta (servidor com conta): lê tudo, sem finalidade. */
export function eh_titular(usuario: UsuarioAtual, acidentado: { servidor_id: number | null }): boolean {
  return usuario.servidor_id !== null && acidentado.servidor_id !== null && usuario.servidor_id === acidentado.servidor_id;
}

export function pode_nivel(usuario: UsuarioAtual, nivel: Nivel): boolean {
  return usuario.pode(nivel === 1 ? "acidente.saude_ver" : "acidente.saude_detalhe_ver");
}

/** A ocorrência restrita some para quem não instrui o caso — salvo para o próprio acidentado. */
function _alcanca(usuario: UsuarioAtual, ocorrencia: Ocorrencia, acidentado: { servidor_id: number | null }): boolean {
  return !ocorrencia.restrita_sst || pode_ver_restrita_sst(usuario) || eh_titular(usuario, acidentado);
}

async function _acidentado(tx: Executor, ocorrencia: Ocorrencia, acidentado_id: number) {
  const [a] = await tx
    .select()
    .from(tabela_acidentado)
    .where(and(eq(tabela_acidentado.id, acidentado_id), eq(tabela_acidentado.ocorrencia_id, ocorrencia.id)));
  return a ?? null;
}

// ---------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------
export async function catalogos(tx: Executor) {
  const partes = await tx
    .select({ id: acidente_parte_corpo.id, rotulo: acidente_parte_corpo.rotulo })
    .from(acidente_parte_corpo)
    .where(eq(acidente_parte_corpo.ativo, true))
    .orderBy(asc(acidente_parte_corpo.ordem));
  const naturezas = await tx
    .select({ id: acidente_natureza_lesao.id, rotulo: acidente_natureza_lesao.rotulo })
    .from(acidente_natureza_lesao)
    .where(eq(acidente_natureza_lesao.ativo, true))
    .orderBy(asc(acidente_natureza_lesao.ordem));
  return { partes, naturezas };
}

// ---------------------------------------------------------------------
// A declaração do comunicante (D4)
// ---------------------------------------------------------------------
function _declarou(s: SaudeDeclarada): boolean {
  return (
    s.partes_corpo_ids.length > 0 ||
    [s.houve_atendimento, s.houve_afastamento, s.houve_internacao, s.houve_obito].some((v) => v === "SIM" || v === "NAO")
  );
}

/**
 * Grava o que o comunicante declarou como linhas `DECLARADO_COMUNICANTE`, uma
 * por acidentado que declarou algo, e abre a pendência de confirmação para o
 * médico. Chamada na mesma transação em que a ocorrência nasce. Devolve quantas
 * linhas criou.
 */
export async function declarar(
  tx: Executor,
  ocorrencia: Ocorrencia,
  itens: { acidentado_id: number; saude: SaudeDeclarada }[],
): Promise<number> {
  let criadas = 0;
  for (const { acidentado_id, saude } of itens) {
    if (!_declarou(saude)) continue;
    const valido = (v: string | null) => (v && (SIM_NAO_NAO_SEI as readonly string[]).includes(v) ? v : null);
    const [linha] = await tx
      .insert(acidente_saude)
      .values({
        acidentado_id,
        houve_atendimento: valido(saude.houve_atendimento),
        houve_afastamento: valido(saude.houve_afastamento),
        houve_internacao: valido(saude.houve_internacao),
        houve_obito: valido(saude.houve_obito),
        origem: "DECLARADO_COMUNICANTE",
        registrado_por: null,
      })
      .returning({ id: acidente_saude.id });
    for (const parte_corpo_id of new Set(saude.partes_corpo_ids)) {
      await tx.insert(acidente_saude_parte).values({ saude_id: linha!.id, parte_corpo_id });
    }
    criadas += 1;
  }
  if (criadas) {
    await pendencias.abrir(tx, {
      tipo: "ACIDENTE_SAUDE_REGISTRAR",
      chave: `ACIDENTE_SAUDE_REGISTRAR:${ocorrencia.id}`,
      // só o protocolo: a pendência aparece no sino de quem não lê saúde
      descricao: `Confirmar a saúde declarada em ${ocorrencia.protocolo}`,
      entidade: ENTIDADE,
      entidade_id: ocorrencia.id,
    });
  }
  return criadas;
}

// ---------------------------------------------------------------------
// Leitura — o serviço único
// ---------------------------------------------------------------------
export interface Detalhe {
  dias_afastamento: number | null;
  afastamento_inicio: string | null;
  afastamento_retorno: string | null;
  dias_internacao: number | null;
  data_obito: string | null;
  dias_debitados: number | null;
  primeiro_socorro_por: string | null;
  primeiro_socorro_unidade: string | null;
  atendimento_em: Date | null;
  duracao_tratamento_dias: number | null;
  deve_afastar: string | null;
  descricao_lesao: string | null;
  diagnostico_provavel: string | null;
  cid: string | null;
  observacoes_saude: string | null;
}

export interface Leitura {
  acidentado_id: number;
  /** o acidentado lendo a própria ocorrência */
  titular: boolean;
  /** há linha de saúde para este acidentado */
  existe: boolean;
  origem: string | null;
  natureza_lesao_id: number | null;
  natureza: string | null;
  parte_corpo_ids: number[];
  partes: string[];
  lateralidade: string | null;
  fatos: Record<Fato, string | null>;
  versao: number;
  registrado_em: Date | null;
  /** só no nível 2, e só para quem pode */
  detalhe: Detalhe | null;
  detalhe_expurgado: boolean;
}

/**
 * Abre a saúde de UM acidentado no nível pedido. Exige a permissão do nível e a
 * finalidade (lista fechada), e grava o acesso. O titular lê sem finalidade e
 * sem registro. O nível 2 devolve também o nível 1: quem pode o detalhe pode o
 * resumo (a permissão do nível 1 também é exigida a quem não é titular).
 */
export async function ler(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acidentado_id: number,
  nivel: Nivel,
  finalidade: string | null,
): Promise<Leitura> {
  const acidentado = await _acidentado(tx, ocorrencia, acidentado_id);
  if (!acidentado || !_alcanca(usuario, ocorrencia, acidentado)) throw new SaudeInexistente("Acidentado não encontrado.");
  const titular = eh_titular(usuario, acidentado);
  if (!titular) {
    usuario.exigir("acidente.saude_ver");
    if (nivel === 2) usuario.exigir("acidente.saude_detalhe_ver");
    if (!finalidade || !(FINALIDADES_SAUDE as readonly string[]).includes(finalidade)) {
      throw new SaudeRecusada("Escolha a finalidade antes de abrir a saúde: ela fica registrada junto com a sua leitura.");
    }
    const rotulo = ROTULO_FINALIDADE_SAUDE[finalidade] ?? finalidade;
    await auditoria.registrar_acesso_sensivel(tx, usuario, nivel === 1 ? "acidente_saude_nivel_1" : "acidente_saude_nivel_2", {
      servidor_id: acidentado.servidor_id,
      acidente_id: ocorrencia.id,
      acidentado_id,
      finalidade: rotulo,
    });
    if (ocorrencia.responsavel_id !== usuario.id) {
      await auditoria.registrar(tx, {
        entidade: ENTIDADE,
        entidade_id: ocorrencia.id,
        tipo_evento: auditoria.ACIDENTE_SAUDE_FORA_RESPONSAVEL,
        // sem nome e sem dado: o protocolo, o acidentado pela ordem, o nível e a finalidade
        descricao: `${ocorrencia.protocolo}: saúde do acidentado nº ${acidentado.ordem} aberta (nível ${nivel}) por quem não conduz o caso; finalidade: ${rotulo}.`,
        usuario,
      });
    }
  }
  const [linha] = await tx.select().from(acidente_saude).where(eq(acidente_saude.acidentado_id, acidentado_id));
  const partes = linha
    ? await tx
        .select({ id: acidente_parte_corpo.id, rotulo: acidente_parte_corpo.rotulo })
        .from(acidente_saude_parte)
        .innerJoin(acidente_parte_corpo, eq(acidente_parte_corpo.id, acidente_saude_parte.parte_corpo_id))
        .where(eq(acidente_saude_parte.saude_id, linha.id))
        .orderBy(asc(acidente_parte_corpo.ordem))
    : [];
  const [natureza] =
    linha?.natureza_lesao_id != null
      ? await tx
          .select({ rotulo: acidente_natureza_lesao.rotulo })
          .from(acidente_natureza_lesao)
          .where(eq(acidente_natureza_lesao.id, linha.natureza_lesao_id))
      : [];
  return {
    acidentado_id,
    titular,
    existe: Boolean(linha),
    origem: linha?.origem ?? null,
    natureza_lesao_id: linha?.natureza_lesao_id ?? null,
    natureza: natureza?.rotulo ?? null,
    parte_corpo_ids: partes.map((p) => p.id),
    partes: partes.map((p) => p.rotulo),
    lateralidade: linha?.lateralidade ?? null,
    fatos: Object.fromEntries(FATOS.map((f) => [f, linha?.[f] ?? null])) as Record<Fato, string | null>,
    versao: linha?.versao ?? 0,
    registrado_em: linha?.registrado_em ?? null,
    detalhe:
      nivel === 2 && linha
        ? {
            dias_afastamento: linha.dias_afastamento,
            afastamento_inicio: linha.afastamento_inicio,
            afastamento_retorno: linha.afastamento_retorno,
            dias_internacao: linha.dias_internacao,
            data_obito: linha.data_obito,
            dias_debitados: linha.dias_debitados,
            primeiro_socorro_por: linha.primeiro_socorro_por,
            primeiro_socorro_unidade: linha.primeiro_socorro_unidade,
            atendimento_em: linha.atendimento_em,
            duracao_tratamento_dias: linha.duracao_tratamento_dias,
            deve_afastar: linha.deve_afastar,
            descricao_lesao: linha.descricao_lesao,
            diagnostico_provavel: linha.diagnostico_provavel,
            cid: linha.cid,
            observacoes_saude: linha.observacoes_saude,
          }
        : null,
    detalhe_expurgado: linha?.detalhe_expurgado_em != null,
  };
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------
export interface DadosSaude {
  natureza_lesao_id: number | null;
  parte_corpo_ids: number[];
  lateralidade: string | null;
  houve_atendimento: string | null;
  houve_afastamento: string | null;
  houve_internacao: string | null;
  houve_obito: string | null;
  houve_sequela: string | null;
  dias_afastamento: number | null;
  afastamento_inicio: string | null;
  afastamento_retorno: string | null;
  dias_internacao: number | null;
  data_obito: string | null;
  dias_debitados: number | null;
  primeiro_socorro_por: string | null;
  primeiro_socorro_unidade: string | null;
  /** "AAAA-MM-DDTHH:MM", hora de Brasília */
  atendimento_em: string | null;
  duracao_tratamento_dias: number | null;
  deve_afastar: string | null;
  descricao_lesao: string | null;
  diagnostico_provavel: string | null;
  cid: string | null;
  observacoes_saude: string | null;
}

const RE_CID = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MOMENTO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function _da_lista(valor: string | null, lista: readonly string[], rotulo: string): string | null {
  if (valor === null || valor === "") return null;
  if (!lista.includes(valor)) throw new SaudeRecusada(`Valor inválido em ${rotulo}.`);
  return valor;
}

function _inteiro(valor: number | null, rotulo: string): number | null {
  if (valor === null) return null;
  if (!Number.isInteger(valor) || valor < 0 || valor > 36500) throw new SaudeRecusada(`Informe ${rotulo} em dias inteiros, de 0 a 36500.`);
  return valor;
}

function _data(valor: string | null, rotulo: string): string | null {
  if (valor === null || valor === "") return null;
  if (!RE_DATA.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) throw new SaudeRecusada(`${rotulo}: data inválida.`);
  return valor;
}

function _texto(valor: string | null, max: number, rotulo: string): string | null {
  const limpo = (valor ?? "").trim().replace(/\s+/g, " ");
  if (!limpo) return null;
  if (limpo.length > max) throw new SaudeRecusada(`${rotulo}: no máximo ${max} caracteres.`);
  try {
    return textos.exigir_texto_limpo(limpo, rotulo, textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    throw new SaudeRecusada(erro instanceof Error ? erro.message : String(erro));
  }
}

/** CID-10 sem ponto de formato livre: aceita "s61.0" e "S610"; guarda "S61.0". */
function _cid(valor: string | null): string | null {
  const bruto = (valor ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!bruto) return null;
  const com_ponto = /^[A-Z][0-9]{3,}$/.test(bruto) ? `${bruto.slice(0, 3)}.${bruto.slice(3)}` : bruto;
  if (!RE_CID.test(com_ponto)) throw new SaudeRecusada("CID: use o formato da CID-10, por exemplo S61.0.");
  return com_ponto;
}

/** Valida e normaliza o que a tela mandou; nada daqui toca o banco. */
async function _normalizar(tx: Executor, d: DadosSaude): Promise<DadosSaude> {
  const cat = await catalogos(tx);
  const partes_validas = new Set(cat.partes.map((p) => p.id));
  const natureza = d.natureza_lesao_id;
  if (natureza !== null && !cat.naturezas.some((n) => n.id === natureza)) throw new SaudeRecusada("Natureza da lesão desconhecida.");
  const parte_corpo_ids = [...new Set(d.parte_corpo_ids)].filter((id) => partes_validas.has(id)).sort((a, b) => a - b);
  if (parte_corpo_ids.length !== new Set(d.parte_corpo_ids).size) throw new SaudeRecusada("Parte do corpo desconhecida.");
  const f = (campo: Fato) => _da_lista(d[campo], SIM_NAO_NAO_SEI, ROTULO_CAMPO[campo]!);
  const saida: DadosSaude = {
    natureza_lesao_id: natureza,
    parte_corpo_ids,
    lateralidade: _da_lista(d.lateralidade, LATERALIDADES, "lateralidade"),
    houve_atendimento: f("houve_atendimento"),
    houve_afastamento: f("houve_afastamento"),
    houve_internacao: f("houve_internacao"),
    houve_obito: f("houve_obito"),
    houve_sequela: f("houve_sequela"),
    dias_afastamento: _inteiro(d.dias_afastamento, "os dias de afastamento"),
    afastamento_inicio: _data(d.afastamento_inicio, "Início do afastamento"),
    afastamento_retorno: _data(d.afastamento_retorno, "Retorno do afastamento"),
    dias_internacao: _inteiro(d.dias_internacao, "os dias de internação"),
    data_obito: _data(d.data_obito, "Data do óbito"),
    dias_debitados: _inteiro(d.dias_debitados, "os dias debitados"),
    primeiro_socorro_por: _texto(d.primeiro_socorro_por, 120, "Primeiro socorro (quem)"),
    primeiro_socorro_unidade: _texto(d.primeiro_socorro_unidade, 160, "Primeiro socorro (onde)"),
    atendimento_em: d.atendimento_em && d.atendimento_em !== "" ? d.atendimento_em : null,
    duracao_tratamento_dias: _inteiro(d.duracao_tratamento_dias, "a duração provável do tratamento"),
    deve_afastar: _da_lista(d.deve_afastar, SIM_NAO_NAO_SEI, "deve afastar-se"),
    descricao_lesao: _texto(d.descricao_lesao, 1000, "Descrição da lesão"),
    diagnostico_provavel: _texto(d.diagnostico_provavel, 240, "Diagnóstico provável"),
    cid: _cid(d.cid),
    observacoes_saude: _texto(d.observacoes_saude, 1000, "Observações de saúde"),
  };
  if (saida.atendimento_em !== null && !RE_MOMENTO.test(saida.atendimento_em)) {
    throw new SaudeRecusada("Momento do atendimento: data e hora inválidas.");
  }
  if (saida.afastamento_inicio && saida.afastamento_retorno && saida.afastamento_retorno < saida.afastamento_inicio) {
    throw new SaudeRecusada("O retorno do afastamento não pode ser antes do início.");
  }
  if (saida.data_obito !== null && saida.houve_obito !== "SIM") {
    throw new SaudeRecusada("A data do óbito só vale quando o óbito está marcado como «Sim».");
  }
  return saida;
}

/** O momento do atendimento como instante: o campo é hora de Brasília (UTC−3, sem horário de verão desde 2019). */
function _instante(momento: string | null): Date | null {
  return momento === null ? null : new Date(`${momento}:00-03:00`);
}

function _momento_de(d: Date | null): string | null {
  if (d === null) return null;
  const br = new Date(d.getTime() - 3 * 3_600_000).toISOString();
  return br.slice(0, 16);
}

/**
 * Registra ou corrige a saúde de um acidentado. `versao` é a que a tela leu (0
 * quando ainda não havia linha); se o registro mudou, `SaudeAlterada` e nada é
 * gravado. Quem registra confirma o que o comunicante declarou: a origem passa
 * a `REGISTRADO_MEDICO` e, não restando declaração a confirmar na ocorrência,
 * a pendência fecha.
 */
export async function registrar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acidentado_id: number,
  bruto: DadosSaude,
  versao: number,
): Promise<{ criada: boolean; campos: string[] }> {
  usuario.exigir("acidente.saude_registrar");
  const acidentado = await _acidentado(tx, ocorrencia, acidentado_id);
  if (!acidentado || !_alcanca(usuario, ocorrencia, acidentado)) throw new SaudeInexistente("Acidentado não encontrado.");
  const d = await _normalizar(tx, bruto);
  const [atual] = await tx.select().from(acidente_saude).where(eq(acidente_saude.acidentado_id, acidentado_id));
  if ((atual?.versao ?? 0) !== versao) {
    throw new SaudeAlterada("Outra pessoa alterou esta saúde enquanto a tela estava aberta. Abra de novo e refaça a alteração.");
  }
  const partes_atuais = atual
    ? (await tx.select({ id: acidente_saude_parte.parte_corpo_id }).from(acidente_saude_parte).where(eq(acidente_saude_parte.saude_id, atual.id)))
        .map((p) => p.id)
        .sort((a, b) => a - b)
    : [];

  const nivel2 = {
    dias_afastamento: d.dias_afastamento,
    afastamento_inicio: d.afastamento_inicio,
    afastamento_retorno: d.afastamento_retorno,
    dias_internacao: d.dias_internacao,
    data_obito: d.data_obito,
    dias_debitados: d.dias_debitados,
    primeiro_socorro_por: d.primeiro_socorro_por,
    primeiro_socorro_unidade: d.primeiro_socorro_unidade,
    atendimento_em: _instante(d.atendimento_em),
    duracao_tratamento_dias: d.duracao_tratamento_dias,
    deve_afastar: d.deve_afastar,
    descricao_lesao: d.descricao_lesao,
    diagnostico_provavel: d.diagnostico_provavel,
    cid: d.cid,
    observacoes_saude: d.observacoes_saude,
  };
  if (atual?.detalhe_expurgado_em) {
    if (Object.values(nivel2).some((v) => v !== null)) {
      throw new SaudeRecusada("O detalhe (nível 2) desta saúde foi expurgado e não se preenche de novo.");
    }
  } else if (atual) {
    // a trigger só deixa o nível 2 ir a NULL junto do expurgo: recusa antes, com a frase certa
    const apagados = COLUNAS_SAUDE_NIVEL_2.filter((c) => (atual[c] ?? null) !== null && nivel2[c] === null);
    if (apagados.length) {
      throw new SaudeRecusada(
        `Já há valor em ${apagados.map((c) => ROTULO_CAMPO[c]).join(", ")}: corrija-o, não o apague. ` +
          "O nível 2 só se esvazia pelo expurgo parcial.",
      );
    }
  }

  const novos: Record<string, unknown> = {
    natureza_lesao_id: d.natureza_lesao_id,
    lateralidade: d.lateralidade,
    houve_atendimento: d.houve_atendimento,
    houve_afastamento: d.houve_afastamento,
    houve_internacao: d.houve_internacao,
    houve_obito: d.houve_obito,
    houve_sequela: d.houve_sequela,
    ...nivel2,
  };
  const mudou = (campo: string, antes: unknown, depois: unknown) => {
    const a = antes instanceof Date ? antes.getTime() : (antes ?? null);
    const b = depois instanceof Date ? depois.getTime() : (depois ?? null);
    return a !== b;
  };
  const campos: string[] = [];
  for (const [campo, valor] of Object.entries(novos)) {
    if (mudou(campo, (atual as Record<string, unknown> | undefined)?.[campo], valor)) campos.push(campo);
  }
  if (JSON.stringify(partes_atuais) !== JSON.stringify(d.parte_corpo_ids)) campos.push("partes_corpo");

  let saude_id: number;
  if (atual) {
    await tx
      .update(acidente_saude)
      .set({
        ...(novos as Partial<typeof acidente_saude.$inferInsert>),
        origem: "REGISTRADO_MEDICO",
        registrado_por: usuario.id,
        registrado_em: new Date(),
        versao: atual.versao + 1,
      })
      .where(eq(acidente_saude.id, atual.id));
    saude_id = atual.id;
  } else {
    const [nova] = await tx
      .insert(acidente_saude)
      .values({
        acidentado_id,
        ...(novos as Partial<typeof acidente_saude.$inferInsert>),
        origem: "REGISTRADO_MEDICO",
        registrado_por: usuario.id,
      })
      .returning({ id: acidente_saude.id });
    saude_id = nova!.id;
  }
  if (campos.includes("partes_corpo")) {
    await tx.delete(acidente_saude_parte).where(eq(acidente_saude_parte.saude_id, saude_id));
    for (const parte_corpo_id of d.parte_corpo_ids) await tx.insert(acidente_saude_parte).values({ saude_id, parte_corpo_id });
  }

  const confirmou = atual?.origem === "DECLARADO_COMUNICANTE";
  const nomes = campos.map((c) => ROTULO_CAMPO[c] ?? c);
  const niveis = [
    campos.some((c) => !(COLUNAS_SAUDE_NIVEL_2 as readonly string[]).includes(c)) ? "nível 1" : null,
    campos.some((c) => (COLUNAS_SAUDE_NIVEL_2 as readonly string[]).includes(c)) ? "nível 2" : null,
  ].filter(Boolean);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: atual ? auditoria.ACIDENTE_SAUDE_ALTERADA : auditoria.ACIDENTE_SAUDE_REGISTRADA,
    // os NOMES dos campos que mudaram, nunca os valores
    descricao:
      `${ocorrencia.protocolo}: saúde do acidentado nº ${acidentado.ordem} ${atual ? "alterada" : "registrada"}` +
      (campos.length ? ` (${niveis.join(" e ")}: ${nomes.join(", ")})` : " (nada mudou)") +
      (confirmou ? "; declaração do comunicante confirmada" : "") +
      ".",
    usuario,
  });

  if (confirmou || !atual) await _fechar_se_nada_a_confirmar(tx, ocorrencia, usuario);
  return { criada: !atual, campos };
}

async function _fechar_se_nada_a_confirmar(tx: Executor, ocorrencia: Ocorrencia, usuario: UsuarioAtual): Promise<void> {
  const restantes = await tx
    .select({ id: acidente_saude.id })
    .from(acidente_saude)
    .innerJoin(tabela_acidentado, eq(tabela_acidentado.id, acidente_saude.acidentado_id))
    .where(and(eq(tabela_acidentado.ocorrencia_id, ocorrencia.id), eq(acidente_saude.origem, "DECLARADO_COMUNICANTE")));
  if (restantes.length) return;
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.chave, `ACIDENTE_SAUDE_REGISTRAR:${ocorrencia.id}`), eq(tabela_pendencia.concluida, false)));
  if (p) await pendencias.concluir(tx, p, usuario);
}

/** Para a tela: o momento do atendimento no formato do campo `datetime-local`. */
export function momento_do_campo(d: Date | null): string {
  return _momento_de(d) ?? "";
}

/**
 * O que a aba Saúde mostra ANTES de abrir qualquer conteúdo: por acidentado, se
 * a pessoa é o titular e o que pode abrir. Não lê saúde nem grava acesso.
 */
export async function painel(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, acidentados: { id: number; servidor_id: number | null }[]) {
  const cat = usuario.pode("acidente.saude_registrar") ? await catalogos(tx) : { partes: [], naturezas: [] };
  return {
    saude_acidentados: acidentados
      .filter((a) => _alcanca(usuario, ocorrencia, a))
      .map((a) => {
        const titular = eh_titular(usuario, a);
        return { id: a.id, titular, nivel_1: titular || pode_nivel(usuario, 1), nivel_2: titular || (pode_nivel(usuario, 1) && pode_nivel(usuario, 2)) };
      }),
    saude_pode_registrar: usuario.pode("acidente.saude_registrar"),
    saude_catalogos: cat,
    FINALIDADES_SAUDE,
    ROTULO_FINALIDADE_SAUDE,
    SIM_NAO_NAO_SEI,
    LATERALIDADES,
    ROTULO_LATERALIDADE,
    ROTULO_ORIGEM_SAUDE,
    momento_campo: momento_do_campo,
  };
}
