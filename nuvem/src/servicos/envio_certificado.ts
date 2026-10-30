/**
 * O certificado por e-mail: o pedido (quem emite pede) e o anexo (montado na
 * hora do envio, pela caixa de `email.ts`).
 *
 * O destinatário é o e-mail do participante (o principal, ou o primeiro
 * conhecido) — o mesmo que a aba Inscrições mostra. Quem não tem e-mail fica
 * de fora e a tela diz quantos.
 *
 * O anexo é o MESMO papel que a ficha baixa: o PDF da casa, o PDF fiel do
 * modelo enviado (com o conversor ligado) ou, sem conversor, o Word. Sai como
 * segunda via de quem pediu o envio — a trilha do certificado diz quem o
 * mandou, como diria quem o baixou.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { certificado as tabela_certificado, email_saida as tabela_email } from "../db/esquema/index.js";
import { Certificado as C, Participante } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import { TIPO_PDF } from "./certificado_pdf.js";
import * as conversor_pdf from "./conversor_pdf.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as servico from "./emissao_certificado.js";
import * as dono_turma from "./dono_turma.js";
import * as servico_participante from "./participante.js";
import { carregar_usuario_atual, type UsuarioAtual } from "./rbac.js";
import * as setor_equipe from "./setor_equipe.js";

export const TIPO = "CERTIFICADO";

type CertificadoRegistro = typeof tabela_certificado.$inferSelect;

export interface ResultadoPedido {
  enfileirados: number;
  sem_email: number;
  ja_enviados: number;
  fora: number;
  /** NUVEM: de turma que a conta só consulta (`dono_turma.ts`) */
  de_outro_dono?: number;
  aviso_dono?: string;
}

function _corpo(certificado: CertificadoRegistro): { assunto: string; corpo: string } {
  const c = servico.montar_contexto(null, certificado);
  const periodo =
    c.turma_data_inicio === c.turma_data_fim
      ? `em ${datas_br.numerica(c.turma_data_inicio)}`
      : `de ${datas_br.numerica(c.turma_data_inicio)} a ${datas_br.numerica(c.turma_data_fim)}`;
  return {
    assunto: `Certificado — ${c.treinamento_nome}`.slice(0, 200),
    corpo:
      `Olá, ${c.participante_nome}.\n\n` +
      `Segue em anexo o seu certificado do treinamento ${c.treinamento_nome} ` +
      `(turma ${c.turma_codigo}, ${periodo}).\n\n` +
      `Certificado nº ${C.rotulo(certificado)}. A autenticidade pode ser conferida em:\n` +
      `${c.url_validacao}\n\n` +
      "Guarde este arquivo: ele é o documento do treinamento. Para baixá-lo de novo, " +
      `peça o link em ${c.url_validacao.replace(/\/validar\/.*$/, "")}/certificados/acesso\n\n` +
      `${c.turma_unidade_promotora || "Superintendência Integrada de Saúde (Sisa)"} — UFVJM\n` +
      "Mensagem enviada pelo Sistema SISA.\n",
  };
}

/** O endereço do participante do certificado, ou "" sem e-mail conhecido. */
export async function destinatario(tx: Executor, certificado: { participante_id: number }): Promise<string> {
  const pessoa = await servico_participante.carregar(tx, certificado.participante_id);
  const endereco = pessoa ? Participante.email_exibicao(pessoa) : "";
  return email.email_valido(endereco) ? endereco.trim() : "";
}

/**
 * Põe na caixa o e-mail de cada certificado EMITIDO escolhido, no escopo de
 * quem pede. Sem `reenviar`, pula o que já foi (ou está na fila): o "enviar os
 * da turma" pode ser clicado duas vezes sem mandar dois e-mails.
 */
export async function pedir_envio(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_ids: number[],
  opcoes: { reenviar?: boolean } = {},
): Promise<ResultadoPedido> {
  usuario.exigir("certificado.emitir");
  const r: ResultadoPedido = { enfileirados: 0, sem_email: 0, ja_enviados: 0, fora: 0 };
  if (!certificado_ids.length) return r;
  const anteriores = new Set(
    (
      await tx
        .select({ certificado_id: tabela_email.certificado_id })
        .from(tabela_email)
        .where(
          and(
            inArray(tabela_email.certificado_id, certificado_ids),
            // o aviso de reciclagem também aponta para o certificado, mas não é o envio dele
            eq(tabela_email.tipo, TIPO),
            inArray(tabela_email.situacao, ["PENDENTE", "ENVIADO"]),
          ),
        )
    ).map((l) => l.certificado_id),
  );
  // NUVEM: a regra de dono — enviar é ato da emissão, na turma do certificado
  const turmas = await dono_turma.turmas_dos_certificados(tx, certificado_ids);
  const direitos = await dono_turma.direitos_nas_turmas(tx, usuario, [...turmas.values()].map((t) => t.id));
  for (const id of certificado_ids) {
    const certificado = await servico.no_escopo(tx, usuario, id);
    if (!certificado || certificado.situacao !== "EMITIDO") {
      r.fora += 1;
      continue;
    }
    const direito = direitos.get(turmas.get(id)?.id ?? -1);
    if (direito && !direito.pode(dono_turma.EMISSAO)) {
      r.de_outro_dono = (r.de_outro_dono ?? 0) + 1;
      r.aviso_dono = dono_turma.recusa_de(direito, dono_turma.EMISSAO);
      continue;
    }
    if (anteriores.has(id) && !opcoes.reenviar) {
      r.ja_enviados += 1;
      continue;
    }
    const para = await destinatario(tx, certificado);
    if (!para) {
      r.sem_email += 1;
      continue;
    }
    const { assunto, corpo } = _corpo(certificado);
    await email.enfileirar(tx, { tipo: TIPO, destinatario: para, assunto, corpo, certificado_id: id, criado_por: usuario.id });
    await auditoria.registrar(tx, {
      entidade: "certificado",
      entidade_id: id,
      tipo_evento: "CERTIFICADO_ENVIO_PEDIDO",
      // o fato, nunca o endereço
      descricao: `Envio por e-mail do certificado ${C.rotulo(certificado)} pedido`,
      usuario,
    });
    r.enfileirados += 1;
  }
  return r;
}

/** Os envios de um certificado, o mais novo primeiro (a ficha). */
export async function envios_do_certificado(tx: Executor, certificado_id: number) {
  const linhas = await tx
    .select()
    .from(tabela_email)
    .where(and(eq(tabela_email.certificado_id, certificado_id), eq(tabela_email.tipo, TIPO)));
  return linhas.sort((a, b) => b.id - a.id);
}

/** Por certificado da turma: a situação do último envio (a aba Emissão). */
export async function ultimo_envio_por_certificado(tx: Executor, certificado_ids: number[]) {
  const saida: Record<number, string> = {};
  if (!certificado_ids.length) return saida;
  const linhas = await tx
    .select({ id: tabela_email.id, certificado_id: tabela_email.certificado_id, situacao: tabela_email.situacao })
    .from(tabela_email)
    .where(and(inArray(tabela_email.certificado_id, certificado_ids), eq(tabela_email.tipo, TIPO)));
  for (const l of linhas.sort((a, b) => a.id - b.id)) saida[l.certificado_id!] = l.situacao;
  return saida;
}

email.registrar_anexador(TIPO, async (tx, mensagem) => {
  const [certificado] = await tx
    .select()
    .from(tabela_certificado)
    .where(eq(tabela_certificado.id, mensagem.certificado_id ?? -1));
  if (!certificado) throw new Error("certificado do e-mail não existe");
  // anulado depois do pedido: não sai o papel que já não vale
  if (certificado.situacao !== "EMITIDO") throw new Error("certificado anulado depois do pedido de envio");
  if (mensagem.criado_por === null) throw new Error("envio sem autor");
  const usuario = await carregar_usuario_atual(tx, mensagem.criado_por);
  if (servico.do_modelo_enviado(certificado)) {
    if (conversor_pdf.configurado()) {
      const fiel = await servico.pdf_do_modelo_enviado(tx, usuario, certificado);
      return [{ nome: fiel.nome, tipo: TIPO_PDF, bytes: fiel.bytes }];
    }
    const via = await servico.segunda_via(tx, usuario, certificado);
    return [{ nome: via.docx.split("/").pop()!, tipo: servico.TIPO_DOCX, bytes: via.bytes }];
  }
  const pdf = await servico.pdf_do_certificado(tx, usuario, certificado);
  return [{ nome: pdf.nome, tipo: TIPO_PDF, bytes: pdf.bytes }];
});

// ---------------------------------------------------------------------
// NUVEM: a caixa de envios pelo setor promotor (`setor_equipe.ts`)
// ---------------------------------------------------------------------
/**
 * A caixa de saída (`email.caixa`) recortada pelo setor de quem a lê: o e-mail
 * de certificado ou de inscrição das turmas do setor; o que não aponta para
 * turma nenhuma fica com a CSSO. Quem vê todos os setores vê a caixa inteira.
 */
export async function caixa_do_setor(
  tx: Executor,
  usuario: UsuarioAtual,
  opcoes: { situacao?: string; limite?: number } = {},
) {
  const setor = setor_equipe.condicao_setor_email(usuario);
  if (setor === undefined) return email.caixa(tx, opcoes);
  return tx
    .select()
    .from(tabela_email)
    .where(and(opcoes.situacao ? eq(tabela_email.situacao, opcoes.situacao) : undefined, setor))
    .orderBy(desc(tabela_email.id))
    .limit(opcoes.limite ?? 200);
}

/** A contagem por situação da caixa, com o mesmo recorte (`email.contagem`). */
export async function contagem_do_setor(tx: Executor, usuario: UsuarioAtual): Promise<Record<string, number>> {
  const setor = setor_equipe.condicao_setor_email(usuario);
  if (setor === undefined) return email.contagem(tx);
  const linhas = await tx
    .select({ situacao: tabela_email.situacao, n: count() })
    .from(tabela_email)
    .where(setor)
    .groupBy(tabela_email.situacao);
  const saida: Record<string, number> = { PENDENTE: 0, ENVIADO: 0, FALHOU: 0, CANCELADO: 0 };
  for (const l of linhas) saida[l.situacao] = Number(l.n);
  return saida;
}

/** O e-mail da caixa está no setor de quem age sobre ele (tentar de novo, cancelar)? */
export async function email_no_setor(tx: Executor, usuario: UsuarioAtual, email_id: number): Promise<boolean> {
  const [achado] = await tx
    .select({ id: tabela_email.id })
    .from(tabela_email)
    .where(and(eq(tabela_email.id, email_id), setor_equipe.condicao_setor_email(usuario)));
  return Boolean(achado);
}

/** A frase que a tela devolve depois do pedido. */
export function resumo(r: ResultadoPedido): string {
  const partes = [`${r.enfileirados} certificado(s) na fila de envio`];
  if (r.ja_enviados) partes.push(`${r.ja_enviados} já enviado(s) antes (reenvie pela ficha do certificado)`);
  if (r.sem_email) partes.push(`${r.sem_email} sem e-mail cadastrado`);
  if (r.fora) partes.push(`${r.fora} anulado(s) ou fora do seu escopo`);
  if (r.de_outro_dono) partes.push(`${r.de_outro_dono} de turma que você só consulta (${(r.aviso_dono ?? "").replace(/\.$/, "")})`);
  let frase = partes.join("; ") + ".";
  if (r.enfileirados && !email.configurado()) {
    frase += " O envio de e-mail ainda não está ligado: eles saem quando for configurado.";
  }
  return frase;
}
