/**
 * O expurgo parcial do módulo de Acidentes (POLITICA_RETENCAO §2.4, ROPA §0.6 e
 * §9 item 10): apaga o dado pessoal e clínico que o Anexo III pede e que, depois
 * da perícia, o sistema não tem mais finalidade para guardar. É ato MANUAL do
 * setor — nunca roda sozinho nem por clique —, vem em simulação por padrão e
 * chega à ata (`ata`), que a trilha registra.
 *
 * O QUE VAI A NULL, e só isto:
 *
 * - `acidente_identificacao`: sexo, CPF, RG, nascimento, endereço, telefone e
 *   e-mail do acidentado (ficam o nome e o vínculo, que moram em `acidentado`);
 * - `acidente_testemunha_contato`: endereço e telefone da testemunha;
 * - `acidente_saude`, nível 2 (`COLUNAS_SAUDE_NIVEL_2`): o detalhe restante e
 *   os campos clínicos do Anexo III.
 *
 * O núcleo da saúde (parte do corpo, natureza da lesão, afastamento, óbito,
 * sequela, dias debitados) FICA: é o que prova o direito e alimenta a série.
 * Cada tabela ganha o carimbo do expurgo (`expurgado_em`,
 * `detalhe_expurgado_em`), e as triggers de `travas.sql` impedem que o dado
 * volte depois dele.
 *
 * QUEM ENTRA: ocorrência `CONCLUIDA` há mais de `anos` (padrão 5, proposta de
 * desenho que o encarregado ainda não confirmou) **e com decisão pericial
 * registrada** — enquanto a perícia não decidiu, o detalhe ainda pode ser
 * necessário ao titular. Linha já expurgada não entra de novo (idempotente).
 *
 * A TRILHA recebe UM evento por ocorrência (`ACIDENTE_EXPURGO_PARCIAL`) com as
 * contagens, os grupos e a ata: nunca um valor. O dado apagado não é copiado
 * para lugar nenhum — copiar desfaria o expurgo; a salvaguarda é a simulação e a
 * confirmação da identidade do banco, na ferramenta.
 */
import { and, eq, exists, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidentado,
  acidente_decisao_pericial,
  acidente_identificacao,
  acidente_ocorrencia,
  acidente_saude,
  acidente_testemunha,
  acidente_testemunha_contato,
} from "../db/esquema/index.js";
import { COLUNAS_SAUDE_NIVEL_2 } from "../dominio/acidente.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";

export const ATOR = "linha de comando (expurgo de acidentes)";
/** A proposta de desenho (POLITICA §2.4): 5 anos após a conclusão. */
export const ANOS_PADRAO = 5;

export class ExpurgoRecusado extends RegraViolada {}

export interface OpcoesExpurgo {
  /** anos desde a conclusão; padrão `ANOS_PADRAO` */
  anos?: number;
  /** a referência da ata em que o setor registra o ato (obrigatória) */
  ata: string;
  /** o relógio, para o teste */
  agora?: Date;
}

export interface ExpurgoDaOcorrencia {
  ocorrencia_id: number;
  protocolo: string;
  identificacoes: number;
  contatos_testemunha: number;
  saude: number;
}

export interface ResumoExpurgo {
  anos: number;
  ata: string;
  corte: Date;
  ocorrencias: ExpurgoDaOcorrencia[];
  identificacoes: number;
  contatos_testemunha: number;
  saude: number;
}

const _ATA = /^[\p{L}\p{N}./ _-]{3,60}$/u;

/** A referência da ata: curta, sem dado pessoal (vai à trilha). */
export function conferir_ata(bruta: string | null | undefined): string {
  const ata = (bruta ?? "").trim();
  if (!_ATA.test(ata)) {
    throw new ExpurgoRecusado("Informe a referência da ata (3 a 60 letras, números, espaço, ponto, barra, hífen) em que o setor registra o expurgo.");
  }
  return ata;
}

export function conferir_anos(bruto: number | undefined): number {
  const anos = bruto ?? ANOS_PADRAO;
  if (!Number.isInteger(anos) || anos < 1) throw new ExpurgoRecusado("O prazo do expurgo é um número inteiro de anos, de 1 em diante.");
  return anos;
}

/** A data de corte: concluídas até aqui entram. */
export function corte_do_prazo(agora: Date, anos: number): Date {
  const corte = new Date(agora.getTime());
  corte.setUTCFullYear(corte.getUTCFullYear() - anos);
  return corte;
}

/**
 * Faz o expurgo (ou, na simulação da ferramenta, o faz dentro de uma transação
 * que é desfeita). Devolve o que foi apagado, por ocorrência.
 */
export async function expurgar(tx: Executor, opcoes: OpcoesExpurgo): Promise<ResumoExpurgo> {
  const ata = conferir_ata(opcoes.ata);
  const anos = conferir_anos(opcoes.anos);
  const agora = opcoes.agora ?? new Date();
  const corte = corte_do_prazo(agora, anos);

  const candidatas = await tx
    .select({ id: acidente_ocorrencia.id, protocolo: acidente_ocorrencia.protocolo })
    .from(acidente_ocorrencia)
    .where(
      and(
        eq(acidente_ocorrencia.estado, "CONCLUIDA"),
        lte(acidente_ocorrencia.concluida_em, corte),
        exists(
          tx.select({ um: sql`1` }).from(acidente_decisao_pericial).where(eq(acidente_decisao_pericial.ocorrencia_id, acidente_ocorrencia.id)),
        ),
      ),
    )
    .orderBy(acidente_ocorrencia.id);

  const zerar_saude = Object.fromEntries(COLUNAS_SAUDE_NIVEL_2.map((c) => [c, null]));
  const feitas: ExpurgoDaOcorrencia[] = [];

  for (const oc of candidatas) {
    const envolvidos = (await tx.select({ id: acidentado.id }).from(acidentado).where(eq(acidentado.ocorrencia_id, oc.id))).map((l) => l.id);
    const testemunhas = (await tx.select({ id: acidente_testemunha.id }).from(acidente_testemunha).where(eq(acidente_testemunha.ocorrencia_id, oc.id))).map((l) => l.id);

    const identificacoes = envolvidos.length
      ? await tx
          .update(acidente_identificacao)
          .set({
            sexo: null, cpf: null, rg: null, data_nascimento: null,
            cep: null, logradouro: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null,
            telefone: null, email: null,
            expurgado_em: agora,
          })
          .where(and(inArray(acidente_identificacao.acidentado_id, envolvidos), isNull(acidente_identificacao.expurgado_em)))
          .returning({ id: acidente_identificacao.acidentado_id })
      : [];
    const contatos = testemunhas.length
      ? await tx
          .update(acidente_testemunha_contato)
          .set({ cep: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, uf: null, telefone: null, expurgado_em: agora })
          .where(and(inArray(acidente_testemunha_contato.testemunha_id, testemunhas), isNull(acidente_testemunha_contato.expurgado_em)))
          .returning({ id: acidente_testemunha_contato.testemunha_id })
      : [];
    const saude = envolvidos.length
      ? await tx
          .update(acidente_saude)
          .set({ ...zerar_saude, detalhe_expurgado_em: agora, versao: sql`${acidente_saude.versao} + 1` })
          .where(and(inArray(acidente_saude.acidentado_id, envolvidos), isNull(acidente_saude.detalhe_expurgado_em)))
          .returning({ id: acidente_saude.acidentado_id })
      : [];

    if (!identificacoes.length && !contatos.length && !saude.length) continue;
    const feito = { ocorrencia_id: oc.id, protocolo: oc.protocolo, identificacoes: identificacoes.length, contatos_testemunha: contatos.length, saude: saude.length };
    feitas.push(feito);
    const grupos = [
      ...(identificacoes.length ? ["identificação do acidentado"] : []),
      ...(contatos.length ? ["contato de testemunha"] : []),
      ...(saude.length ? ["detalhe de saúde (nível 2)"] : []),
    ];
    await auditoria.registrar(tx, {
      entidade: "acidente_ocorrencia",
      entidade_id: oc.id,
      tipo_evento: auditoria.ACIDENTE_EXPURGO_PARCIAL,
      // contagens e grupos de campo, nunca o valor (RN-19)
      descricao:
        `${oc.protocolo}: expurgo parcial — ${grupos.join(", ")} (ata ${ata}; ` +
        `${feito.identificacoes} identificação(ões), ${feito.contatos_testemunha} contato(s), ${feito.saude} saúde(s)).`,
      usuario_nome: ATOR,
      valor_novo: { ata, anos, identificacoes: feito.identificacoes, contatos_testemunha: feito.contatos_testemunha, saude: feito.saude },
    });
  }

  const soma = (k: "identificacoes" | "contatos_testemunha" | "saude") => feitas.reduce((n, f) => n + f[k], 0);
  return {
    anos,
    ata,
    corte,
    ocorrencias: feitas,
    identificacoes: soma("identificacoes"),
    contatos_testemunha: soma("contatos_testemunha"),
    saude: soma("saude"),
  };
}
