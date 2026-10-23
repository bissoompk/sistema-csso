/**
 * Juntar dois cadastros da mesma pessoa (fatia 6 do desenho, `participante.mesclar`).
 *
 * Acontece com o externo: entrou pela lista em lote como "Joana Silva", depois
 * pelo link público como "Joana da Silva", e a reciclagem dela aparece duas
 * vezes. Ou o servidor que fez um curso antes de ter SIAPE na base.
 *
 * **Nada se apaga.** O absorvido aponta para o mantido (`mesclado_em_id`) e sai
 * das listas; inscrições, certificados e e-mails passam para o mantido. O
 * papel de cada certificado não muda — o congelado continua dizendo o nome com
 * que ele saiu, e a chave continua respondendo.
 *
 * Recusa o que não pode ser a mesma pessoa: dois servidores (dois SIAPEs), CPFs
 * de certificado diferentes, ou os dois na mesma turma (a junção deixaria a
 * pessoa inscrita duas vezes).
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  participante_email as tabela_email,
  participante_mesclagem as tabela_mesclagem,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as duplicados from "./duplicados.js";
import * as servico_participante from "./participante.js";
import { nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";

export const PARTICIPANTE_MESCLADO = "PARTICIPANTE_MESCLADO";

export class MesclagemRecusada extends RegraViolada {}

/** O que a junção moveu, como fica em `participante_mesclagem.movido`. */
export type Movido = (typeof tabela_mesclagem.$inferInsert)["movido"];

export interface ResultadoMesclagem {
  inscricoes: number;
  certificados: number;
  emails: number;
}

export async function mesclar(
  tx: Executor,
  usuario: UsuarioAtual,
  mantido_id: number,
  absorvido_id: number,
  motivo: string | null | undefined,
): Promise<ResultadoMesclagem> {
  usuario.exigir("participante.mesclar");
  return _mesclar(tx, usuario, mantido_id, absorvido_id, motivo);
}

/**
 * A junção sem a pergunta da permissão — para quem já a fez com outra régua:
 * a conferência do pedido pelo link (`pedidos_link.usar_cadastro`), em que o
 * absorvido é o cadastro que o próprio pedido acabou de criar e não tem mais
 * nada. Todas as outras recusas valem igual.
 */
export async function _mesclar(
  tx: Executor,
  usuario: UsuarioAtual,
  mantido_id: number,
  absorvido_id: number,
  motivo: string | null | undefined,
): Promise<ResultadoMesclagem> {
  const limpo = (motivo ?? "").trim();
  if (!limpo) throw new MesclagemRecusada("Juntar cadastros exige o motivo: é o que explica a junção na trilha.");
  if (mantido_id === absorvido_id) throw new MesclagemRecusada("Escolha dois cadastros diferentes.");
  const mantido = await servico_participante.carregar(tx, mantido_id);
  const absorvido = await servico_participante.carregar(tx, absorvido_id);
  if (!mantido || !absorvido) throw new MesclagemRecusada("Cadastro não encontrado.");
  for (const p of [mantido, absorvido]) {
    if (p.mesclado_em_id !== null || p.expurgado_em !== null) {
      throw new MesclagemRecusada(`${p.identificador_publico} já foi juntado a outro cadastro ou expurgado.`);
    }
  }
  if (mantido.servidor_id !== null && absorvido.servidor_id !== null) {
    throw new MesclagemRecusada(
      "Os dois cadastros são de servidores (SIAPEs diferentes): não são a mesma pessoa. " +
        "Se o SIAPE está duplicado, corrija no cadastro de servidores.",
    );
  }
  if (absorvido.servidor_id !== null) {
    throw new MesclagemRecusada(
      `Mantenha o cadastro de servidor (${absorvido.identificador_publico}): o nome dele vem do SIAPE, ` +
        "e é o externo que se junta a ele.",
    );
  }
  if (mantido.cpf && absorvido.cpf && mantido.cpf !== absorvido.cpf) {
    throw new MesclagemRecusada(
      "Os dois têm CPFs diferentes gravados para o certificado: não parecem a mesma pessoa. " +
        "Se um deles está errado, apague-o (botão CPF na inscrição) antes de juntar.",
    );
  }
  const em_comum = await tx
    .select({ codigo: tabela_turma.codigo, turma_id: tabela_inscricao.turma_id, participante_id: tabela_inscricao.participante_id })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(inArray(tabela_inscricao.participante_id, [mantido.id, absorvido.id]));
  const por_turma = new Map<number, Set<number>>();
  for (const l of em_comum) por_turma.set(l.turma_id, (por_turma.get(l.turma_id) ?? new Set()).add(l.participante_id));
  const repetidas = [...new Set(em_comum.filter((l) => por_turma.get(l.turma_id)!.size > 1).map((l) => l.codigo))];
  if (repetidas.length) {
    throw new MesclagemRecusada(
      `Os dois estão inscritos em ${repetidas.join(", ")}: juntá-los deixaria a pessoa duas vezes na turma. ` +
        "Esse caso pede que a equipe decida qual inscrição vale, à mão.",
    );
  }

  const inscricoes = await tx
    .update(tabela_inscricao)
    .set({ participante_id: mantido.id })
    .where(eq(tabela_inscricao.participante_id, absorvido.id))
    .returning({ id: tabela_inscricao.id });
  // o certificado é do mantido daqui em diante; `servidor_id` é o escopo "meus"
  // (o de antes fica no registro da junção, para poder desfazer)
  const certificados_antes = await tx
    .select({ id: tabela_certificado.id, servidor_id: tabela_certificado.servidor_id })
    .from(tabela_certificado)
    .where(eq(tabela_certificado.participante_id, absorvido.id));
  const certificados = await tx
    .update(tabela_certificado)
    .set({ participante_id: mantido.id, servidor_id: mantido.servidor_id })
    .where(eq(tabela_certificado.participante_id, absorvido.id))
    .returning({ id: tabela_certificado.id });

  // e-mails: os que o mantido ainda não tem passam para ele; o repetido some
  const ja_tem = new Set(mantido.emails.map((m) => m.email_normalizado));
  await tx.update(tabela_participante).set({ email_principal_id: null }).where(eq(tabela_participante.id, absorvido.id));
  let emails = 0;
  let principal_herdado: number | null = null;
  const emails_movidos: number[] = [];
  const emails_repetidos: Movido["emails_repetidos"] = [];
  for (const m of absorvido.emails) {
    if (ja_tem.has(m.email_normalizado)) {
      // o endereço não vai para o registro (é o mesmo do mantido): só de onde veio
      emails_repetidos.push({
        id: m.id,
        origem: m.origem,
        confirmado_em: m.confirmado_em ? m.confirmado_em.toISOString() : null,
        igual_a: mantido.emails.find((x) => x.email_normalizado === m.email_normalizado)?.id ?? null,
      });
      await tx.delete(tabela_email).where(eq(tabela_email.id, m.id));
      continue;
    }
    await tx.update(tabela_email).set({ participante_id: mantido.id }).where(eq(tabela_email.id, m.id));
    emails_movidos.push(m.id);
    emails += 1;
    if (m.id === absorvido.email_principal_id) principal_herdado = m.id;
  }

  const completar: Partial<typeof tabela_participante.$inferSelect> = {};
  if (mantido.email_principal_id === null && principal_herdado !== null) completar.email_principal_id = principal_herdado;
  if (!mantido.cpf && absorvido.cpf) completar.cpf = absorvido.cpf;
  if (mantido.servidor_id === null && !mantido.organizacao && absorvido.organizacao) {
    completar.organizacao = absorvido.organizacao;
  }
  if (!mantido.matricula_externa && absorvido.matricula_externa) completar.matricula_externa = absorvido.matricula_externa;
  if (Object.keys(completar).length) {
    await tx.update(tabela_participante).set(completar).where(eq(tabela_participante.id, mantido.id));
  }
  // o absorvido fica (a trilha e os relatórios antigos resolvem por ele), sem CPF
  await tx
    .update(tabela_participante)
    .set({ mesclado_em_id: mantido.id, ativo: false, cpf: null, suspeita_duplicado_em: null })
    .where(eq(tabela_participante.id, absorvido.id));
  // a dúvida do mantido, se havia, foi resolvida por quem juntou
  if (mantido.suspeita_duplicado_em !== null) {
    await tx.update(tabela_participante).set({ suspeita_duplicado_em: null }).where(eq(tabela_participante.id, mantido.id));
  }
  // o que mudou de dono, para a junção poder ser desfeita um dia (23/10/2026)
  const movido: Movido = {
    inscricoes: inscricoes.map((l) => l.id),
    certificados: certificados_antes.map((l) => ({ id: l.id, servidor_id_antes: l.servidor_id })),
    emails_movidos,
    emails_repetidos,
    principal_herdado: completar.email_principal_id ?? null,
    campos_herdados: Object.keys(completar).filter((k) => k !== "email_principal_id"),
    absorvido_tinha_cpf: Boolean(absorvido.cpf),
  };
  await tx.insert(tabela_mesclagem).values({
    mantido_id: mantido.id,
    absorvido_id: absorvido.id,
    movido,
    feito_por: usuario.id,
  });

  const resumo = `${inscricoes.length} inscrição(ões), ${certificados.length} certificado(s), ${emails} e-mail(s)`;
  for (const [p, frase] of [
    [absorvido, `${absorvido.identificador_publico} juntado a ${mantido.identificador_publico} (${resumo})`],
    [mantido, `${mantido.identificador_publico} recebeu ${absorvido.identificador_publico} (${resumo})`],
  ] as const) {
    await auditoria.registrar(tx, {
      entidade: "participante",
      entidade_id: p.id,
      tipo_evento: PARTICIPANTE_MESCLADO,
      descricao: `${frase}: ${limpo}`,
      comentario: limpo,
      usuario,
    });
  }
  return { inscricoes: inscricoes.length, certificados: certificados.length, emails };
}

// ---------------------------------------------------------------------
// Para a tela
// ---------------------------------------------------------------------
export interface Ficha {
  id: number;
  identificador: string;
  nome: string;
  servidor: boolean;
  siape: string | null;
  vinculo: string;
  organizacao: string | null;
  emails: string[];
  inscricoes: number;
  certificados: number;
  /** criado por quem não lê nomes, quando já havia cadastro parecido */
  suspeito: boolean;
}

async function _contar(tx: Executor, ids: number[]) {
  const ins = ids.length
    ? await tx
        .select({ id: tabela_inscricao.participante_id, n: count() })
        .from(tabela_inscricao)
        .where(inArray(tabela_inscricao.participante_id, ids))
        .groupBy(tabela_inscricao.participante_id)
    : [];
  const cer = ids.length
    ? await tx
        .select({ id: tabela_certificado.participante_id, n: count() })
        .from(tabela_certificado)
        .where(and(inArray(tabela_certificado.participante_id, ids), eq(tabela_certificado.situacao, "EMITIDO")))
        .groupBy(tabela_certificado.participante_id)
    : [];
  return {
    inscricoes: new Map(ins.map((l) => [l.id, Number(l.n)])),
    certificados: new Map(cer.map((l) => [l.id, Number(l.n)])),
  };
}

export async function fichas(tx: Executor, pessoas: ParticipanteCarregado[]): Promise<Ficha[]> {
  const n = await _contar(
    tx,
    pessoas.map((p) => p.id),
  );
  return pessoas.map((p) => ({
    id: p.id,
    identificador: p.identificador_publico,
    nome: nome_exibicao(p),
    servidor: p.servidor_id !== null,
    siape: p.servidor?.siape ?? null,
    vinculo: p.vinculo,
    organizacao: p.organizacao,
    emails: p.emails.map((m) => m.email),
    inscricoes: n.inscricoes.get(p.id) ?? 0,
    certificados: n.certificados.get(p.id) ?? 0,
    suspeito: p.suspeita_duplicado_em !== null,
  }));
}

/**
 * Grupos de cadastros ativos que parecem a mesma pessoa, pelo critério único
 * de `duplicados.grupos` (nome parecido ou o mesmo e-mail). Dois servidores
 * nunca entram juntos, e o par marcado "não é a mesma pessoa" também não.
 */
export async function possiveis_duplicados(tx: Executor, limite = 50): Promise<Ficha[][]> {
  const r: Ficha[][] = [];
  for (const g of await duplicados.grupos(tx, limite)) r.push(await fichas(tx, g));
  return r;
}

/** O mantido sugerido: o de servidor; senão o que tem mais certificados. */
export function sugerido(grupo: Ficha[]): number {
  const servidor = grupo.find((f) => f.servidor);
  if (servidor) return servidor.id;
  return [...grupo].sort((a, b) => b.certificados - a.certificados || b.inscricoes - a.inscricoes || a.id - b.id)[0]!.id;
}
