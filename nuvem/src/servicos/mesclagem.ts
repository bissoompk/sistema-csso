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
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
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
  // a conta de terceirizado ou discente (`participante.usuario_id`) vai junto
  // com a pessoa; duas contas são duas pessoas, e conta externa não vira servidor
  if (mantido.usuario_id !== null && absorvido.usuario_id !== null) {
    throw new MesclagemRecusada(
      "Os dois cadastros estão ligados a contas diferentes do sistema: não são a mesma pessoa. " +
        "Se uma conta está duplicada, inative-a em Usuários antes de juntar.",
    );
  }
  if (mantido.servidor_id !== null && absorvido.usuario_id !== null) {
    throw new MesclagemRecusada(
      `${absorvido.identificador_publico} está ligado a uma conta de terceirizado ou discente, e o outro é de ` +
        "servidor. Se a pessoa é servidor, inative a conta externa em Usuários antes de juntar.",
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
  // o absorvido fica (a trilha e os relatórios antigos resolvem por ele), sem
  // CPF e sem a conta, que passa ao mantido (UNIQUE: primeiro sai, depois entra)
  await tx
    .update(tabela_participante)
    .set({ mesclado_em_id: mantido.id, ativo: false, cpf: null, suspeita_duplicado_em: null, usuario_id: null })
    .where(eq(tabela_participante.id, absorvido.id));
  const conta_movida = absorvido.usuario_id;
  if (conta_movida !== null) {
    await tx.update(tabela_participante).set({ usuario_id: conta_movida }).where(eq(tabela_participante.id, mantido.id));
  }
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
    conta_movida,
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
// Desfazer a junção (26/10/2026)
// ---------------------------------------------------------------------
export const PARTICIPANTE_MESCLAGEM_DESFEITA = "PARTICIPANTE_MESCLAGEM_DESFEITA";

export interface ResultadoDesfazer {
  mantido: string;
  absorvido: string;
  inscricoes: number;
  certificados: number;
  emails: number;
  /** o que a junção moveu e que já não está com o mantido: fica onde está */
  ficou_para_tras: number;
  distintos: boolean;
}

/**
 * Desfaz uma junção: devolve ao absorvido o que a junção moveu
 * (`participante_mesclagem.movido`) e o reativa. Só o que AINDA está com o
 * mantido volta; o que a junção moveu e depois mudou de mãos fica onde está,
 * e a contagem diz quanto. Nada do que nasceu depois da junção (inscrição,
 * certificado ou e-mail novos do mantido) é tocado.
 *
 * Recusa quando desfazer seria desfazer uma história que andou: o mantido foi
 * juntado a um terceiro (desfaça primeiro a junção mais nova), qualquer um dos
 * dois foi expurgado, ou a junção já foi desfeita.
 *
 * Limites do registro, que o `movido` não guarda de propósito (RN-19, nunca o
 * número nem o endereço): o CPF volta a partir do que está no mantido (ele o
 * herdou, ou já tinha o mesmo); o e-mail repetido que a junção apagou é
 * recriado a partir do endereço do mantido a que era igual; e o principal do
 * absorvido é o herdado, ou o primeiro que voltou.
 *
 * `marcar_distintos` grava o par como "não são a mesma pessoa" (é o caso de
 * quem juntou errado); sem ele, o par pode voltar a aparecer como parecido.
 */
export async function desfazer(
  tx: Executor,
  usuario: UsuarioAtual,
  mesclagem_id: number,
  motivo: string | null | undefined,
  marcar_distintos: boolean,
): Promise<ResultadoDesfazer> {
  usuario.exigir("participante.mesclar");
  const limpo = (motivo ?? "").trim();
  if (!limpo) throw new MesclagemRecusada("Desfazer uma junção exige o motivo: é o que explica na trilha.");
  const [linha] = await tx.select().from(tabela_mesclagem).where(eq(tabela_mesclagem.id, mesclagem_id));
  if (!linha) throw new MesclagemRecusada("Junção não encontrada.");
  if (linha.desfeita_em !== null) throw new MesclagemRecusada("Esta junção já foi desfeita.");
  const mantido = await servico_participante.carregar(tx, linha.mantido_id);
  const absorvido = await servico_participante.carregar(tx, linha.absorvido_id);
  if (!mantido || !absorvido) throw new MesclagemRecusada("Cadastro não encontrado.");
  if (mantido.expurgado_em !== null || absorvido.expurgado_em !== null) {
    throw new MesclagemRecusada("Um dos cadastros já foi expurgado: não há como devolver o que era dele.");
  }
  if (absorvido.mesclado_em_id !== mantido.id) {
    throw new MesclagemRecusada(`${absorvido.identificador_publico} não está mais juntado a ${mantido.identificador_publico}.`);
  }
  if (mantido.mesclado_em_id !== null) {
    throw new MesclagemRecusada(
      `${mantido.identificador_publico} foi juntado a outro cadastro depois desta junção: desfaça primeiro a junção mais nova.`,
    );
  }
  const m = linha.movido;

  // inscrições: só as que ainda estão com o mantido
  const insc = m.inscricoes.length
    ? await tx
        .update(tabela_inscricao)
        .set({ participante_id: absorvido.id })
        .where(and(inArray(tabela_inscricao.id, m.inscricoes), eq(tabela_inscricao.participante_id, mantido.id)))
        .returning({ id: tabela_inscricao.id })
    : [];
  // certificados: voltam com o `servidor_id` de antes (o escopo "meus")
  let certificados = 0;
  for (const c of m.certificados) {
    const r = await tx
      .update(tabela_certificado)
      .set({ participante_id: absorvido.id, servidor_id: c.servidor_id_antes })
      .where(and(eq(tabela_certificado.id, c.id), eq(tabela_certificado.participante_id, mantido.id)))
      .returning({ id: tabela_certificado.id });
    certificados += r.length;
  }

  // e-mails que a junção moveu, e que ainda são do mantido, voltam
  const voltaram = m.emails_movidos.length
    ? await tx
        .update(tabela_email)
        .set({ participante_id: absorvido.id })
        .where(and(inArray(tabela_email.id, m.emails_movidos), eq(tabela_email.participante_id, mantido.id)))
        .returning({ id: tabela_email.id })
    : [];
  const ids_voltaram = voltaram.map((x) => x.id);
  // os que a junção apagou por serem iguais aos do mantido: recriados com o
  // mesmo endereço do mantido. Confirmado só se o mantido não o confirma agora
  // (`uq_email_confirmado`: um endereço confirmado é de um cadastro só)
  const recriados: number[] = [];
  for (const rep of m.emails_repetidos) {
    if (rep.igual_a === null) continue;
    const [base] = await tx.select().from(tabela_email).where(eq(tabela_email.id, rep.igual_a));
    if (!base || base.participante_id !== mantido.id) continue;
    const [novo] = await tx
      .insert(tabela_email)
      .values({
        participante_id: absorvido.id,
        email: base.email,
        email_normalizado: base.email_normalizado,
        origem: rep.origem,
        confirmado_em: rep.confirmado_em && base.confirmado_em === null ? new Date(rep.confirmado_em) : null,
      })
      .returning({ id: tabela_email.id });
    recriados.push(novo!.id);
  }
  const ficou_para_tras =
    m.inscricoes.length - insc.length + (m.certificados.length - certificados) + (m.emails_movidos.length - ids_voltaram.length);

  // o principal do mantido: se era um dos que voltaram, passa para um que ficou
  const campos_mantido: Partial<typeof tabela_participante.$inferSelect> = {};
  if (mantido.email_principal_id !== null && ids_voltaram.includes(mantido.email_principal_id)) {
    const [resto] = await tx
      .select({ id: tabela_email.id })
      .from(tabela_email)
      .where(and(eq(tabela_email.participante_id, mantido.id), sql`${tabela_email.id} <> ALL(${ids_voltaram})`))
      .orderBy(tabela_email.id)
      .limit(1);
    campos_mantido.email_principal_id = resto?.id ?? null;
  }
  // campos herdados saem do mantido se ainda são o que o absorvido tem
  if (m.campos_herdados.includes("organizacao") && mantido.organizacao === absorvido.organizacao) {
    campos_mantido.organizacao = null;
  }
  if (m.campos_herdados.includes("matricula_externa") && mantido.matricula_externa === absorvido.matricula_externa) {
    campos_mantido.matricula_externa = null;
  }
  // o CPF e a conta: primeiro saem do mantido, depois entram no absorvido (UNIQUE)
  const cpf = m.absorvido_tinha_cpf ? mantido.cpf : null;
  if (m.campos_herdados.includes("cpf") && cpf) campos_mantido.cpf = null;
  const conta = m.conta_movida ?? null;
  const conta_volta = conta !== null && mantido.usuario_id === conta;
  if (conta_volta) campos_mantido.usuario_id = null;
  if (Object.keys(campos_mantido).length) {
    await tx.update(tabela_participante).set(campos_mantido).where(eq(tabela_participante.id, mantido.id));
  }
  const principal = m.principal_herdado !== null && ids_voltaram.includes(m.principal_herdado)
    ? m.principal_herdado
    : (ids_voltaram[0] ?? recriados[0] ?? null);
  await tx
    .update(tabela_participante)
    .set({
      mesclado_em_id: null,
      ativo: true,
      email_principal_id: principal,
      cpf,
      usuario_id: conta_volta ? conta : null,
    })
    .where(eq(tabela_participante.id, absorvido.id));
  await tx
    .update(tabela_mesclagem)
    .set({ desfeita_em: new Date(), desfeita_por: usuario.id, desfeita_motivo: limpo })
    .where(eq(tabela_mesclagem.id, linha.id));
  if (marcar_distintos) await duplicados.marcar_distintos(tx, usuario, mantido.id, absorvido.id, "JUNCAO");

  const resumo =
    `${insc.length} inscrição(ões), ${certificados} certificado(s), ${ids_voltaram.length + recriados.length} e-mail(s)` +
    (ficou_para_tras ? `; ${ficou_para_tras} item(ns) que a junção moveu já não estavam com ${mantido.identificador_publico} e ficaram onde estão` : "");
  for (const [p, frase] of [
    [absorvido, `junção de ${absorvido.identificador_publico} a ${mantido.identificador_publico} desfeita (${resumo})`],
    [mantido, `junção de ${absorvido.identificador_publico} desfeita: o que era dele voltou (${resumo})`],
  ] as const) {
    await auditoria.registrar(tx, {
      entidade: "participante",
      entidade_id: p.id,
      tipo_evento: PARTICIPANTE_MESCLAGEM_DESFEITA,
      descricao: `${frase}: ${limpo}`,
      comentario: limpo,
      usuario,
    });
  }
  return {
    mantido: mantido.identificador_publico,
    absorvido: absorvido.identificador_publico,
    inscricoes: insc.length,
    certificados,
    emails: ids_voltaram.length + recriados.length,
    ficou_para_tras,
    distintos: marcar_distintos,
  };
}

export interface JuncaoFeita {
  id: number;
  mantido: string;
  absorvido: string;
  nome_mantido: string;
  nome_absorvido: string;
  feita_em: Date;
  inscricoes: number;
  certificados: number;
  emails: number;
  desfeita_em: Date | null;
  desfeita_motivo: string | null;
  /** por que não dá para desfazer agora; vazio quando dá */
  impedimento: string;
}

/** As últimas junções, da mais nova à mais antiga, com o que impede desfazer cada uma. */
export async function juncoes_feitas(tx: Executor, limite = 50): Promise<JuncaoFeita[]> {
  const linhas = await tx.select().from(tabela_mesclagem).orderBy(desc(tabela_mesclagem.id)).limit(limite);
  const saida: JuncaoFeita[] = [];
  for (const l of linhas) {
    const mantido = await servico_participante.carregar(tx, l.mantido_id);
    const absorvido = await servico_participante.carregar(tx, l.absorvido_id);
    if (!mantido || !absorvido) continue;
    let impedimento = "";
    if (l.desfeita_em !== null) impedimento = "já desfeita";
    else if (mantido.expurgado_em !== null || absorvido.expurgado_em !== null) impedimento = "um dos cadastros foi expurgado";
    else if (absorvido.mesclado_em_id !== mantido.id) impedimento = "o juntado não está mais ligado a este cadastro";
    else if (mantido.mesclado_em_id !== null) impedimento = "o cadastro que ficou foi juntado a outro depois: desfaça primeiro a junção mais nova";
    saida.push({
      id: l.id,
      mantido: mantido.identificador_publico,
      absorvido: absorvido.identificador_publico,
      nome_mantido: nome_exibicao(mantido),
      nome_absorvido: nome_exibicao(absorvido),
      feita_em: l.feito_em,
      inscricoes: l.movido.inscricoes.length,
      certificados: l.movido.certificados.length,
      emails: l.movido.emails_movidos.length,
      desfeita_em: l.desfeita_em,
      desfeita_motivo: l.desfeita_motivo,
      impedimento,
    });
  }
  return saida;
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
