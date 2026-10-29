/**
 * O prazo de guarda das ocorrências de urgência e emergência (28/10/2026,
 * decisão do dono do sistema: 5 anos, depois anonimiza; o prazo final é do
 * encarregado e se muda em `ANOS_DE_GUARDA`).
 *
 * Roda na rotina noturna de privacidade (`rotinas.ts`). Entra a ocorrência
 * ENCERRADA (concluída ou cancelada) há mais de `ANOS_DE_GUARDA` anos; a que
 * ainda está aberta nunca é apagada, por mais velha que seja.
 *
 * O QUE SAI: o nome da pessoa atendida, o relato, as observações, a conclusão, o
 * curso, a empresa, a função, o setor, o contato de quem registrou e o que a
 * equipe escreveu no acompanhamento. O QUE FICA, para a série estatística: o
 * protocolo, a data e o campus, o local, os tipos, o vínculo, o socorro prestado
 * (encaminhamento e meio) e a situação. O dado apagado não é copiado para lugar
 * nenhum. A linha ganha `expurgada_em` e não entra de novo (idempotente).
 *
 * A trilha recebe UM evento por rodada com a quantidade — nunca um valor.
 */
import { and, inArray, isNull, lte } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { ocorrencia as tabela, ocorrencia_acompanhamento as tabela_acomp } from "../db/esquema/index.js";
import { SITUACOES_ENCERRADAS } from "../dominio/ocorrencia.js";
import * as auditoria from "./auditoria.js";

export const ANOS_DE_GUARDA = 5;
/** O que a linha mostra no lugar do que foi apagado (as colunas obrigatórias não ficam vazias). */
export const TEXTO_APAGADO = "(apagado pelo prazo de guarda)";

function _anos_atras(agora: Date, anos: number): Date {
  const d = new Date(agora);
  d.setUTCFullYear(d.getUTCFullYear() - anos);
  return d;
}

/** Quantas ocorrências tiveram os dados pessoais apagados nesta rodada. */
export async function expurgar(tx: Executor, agora: Date = new Date(), anos: number = ANOS_DE_GUARDA): Promise<number> {
  const corte = _anos_atras(agora, anos);
  const encerradas = [...SITUACOES_ENCERRADAS];
  const alvos = await tx
    .select({ id: tabela.id })
    .from(tabela)
    // `concluida_em` é gravada na conclusão e no cancelamento
    .where(and(isNull(tabela.expurgada_em), inArray(tabela.situacao, encerradas), lte(tabela.concluida_em, corte)));
  if (!alvos.length) return 0;
  const ids = alvos.map((a) => a.id);
  await tx.delete(tabela_acomp).where(inArray(tabela_acomp.ocorrencia_id, ids));
  await tx
    .update(tabela)
    .set({
      pessoa_nome: null,
      descricao: TEXTO_APAGADO,
      observacoes: null,
      conclusao: null,
      pessoa_vinculo_outro: null,
      curso: null,
      setor_lotacao: null,
      empresa: null,
      funcao: null,
      notificante_nome: TEXTO_APAGADO,
      notificante_telefone: null,
      notificante_email: null,
      tipo_outro: null,
      meio_deslocamento_outro: null,
      expurgada_em: agora,
    })
    .where(inArray(tabela.id, ids));
  await auditoria.registrar(tx, {
    entidade: "ocorrencia",
    entidade_id: 0,
    tipo_evento: "OCORRENCIA_EXPURGADA",
    descricao: `${ids.length} ocorrência(s) de urgência/emergência com os dados pessoais apagados (guarda de ${anos} anos)`,
    campo: "expurgo",
    valor_novo: String(ids.length),
    usuario: null,
  });
  return ids.length;
}
