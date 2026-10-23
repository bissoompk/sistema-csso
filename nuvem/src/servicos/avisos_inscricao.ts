/**
 * O aviso por e-mail a quem pediu vaga pelo link público (`inscricao_publica.ts`):
 * aceito ou recusado. Só para o pedido do link — a inscrição interna a equipe
 * combina por outros meios —, e só quando a pessoa deixou e-mail.
 *
 * O motivo da recusa NÃO vai no e-mail: ele é escrito para a trilha, por quem
 * conferiu, e não para a pessoa.
 *
 * O aviso de inscrição ACEITA leva a agenda da turma (.ics, `ics.ts`) anexa,
 * montada na hora do envio (`registrar_anexador`): a hora ou o local mudados
 * entre o aceite e o envio já saem certos.
 */
import type { Executor } from "../db/cliente.js";
import { Participante } from "../dominio/treinamento.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as ics from "./ics.js";

export const TIPO_ACEITA = "INSCRICAO_ACEITA";
export const TIPO_RECUSADA = "INSCRICAO_RECUSADA";

interface InscricaoDoAviso {
  id: number;
  origem: string;
  turma: {
    codigo: string;
    data_inicio: string;
    data_fim: string;
    local: string | null;
    treinamento: { nome: string };
    unidade_promotora?: { sigla: string | null; nome_extenso: string } | null;
  };
  participante: {
    nome: string | null;
    servidor: { nome: string } | null;
    email_principal?: { email: string } | null;
    emails: ReadonlyArray<{ email: string }>;
  };
}

const SISA = "Superintendência Integrada de Saúde (Sisa)";

/** Assinatura: o setor que promoveu a turma, ou a Sisa sem esse dado. */
function _assinatura(promotor: string): string {
  return `${promotor || SISA} — UFVJM\n` + "Mensagem enviada pelo Sistema SISA.\n";
}

/** Enfileira o aviso; devolve se havia para quem mandar. */
export async function avisar(
  tx: Executor,
  inscricao: InscricaoDoAviso,
  aceita: boolean,
  criado_por: number | null,
): Promise<boolean> {
  if (inscricao.origem !== "PUBLICA") return false;
  const para = Participante.email_exibicao(inscricao.participante);
  if (!email.email_valido(para)) return false;
  const t = inscricao.turma;
  const promotor = t.unidade_promotora ?? null;
  const equipe = promotor?.sigla ? `A equipe da ${promotor.sigla}` : "A equipe responsável";
  const nome = inscricao.participante.servidor?.nome ?? inscricao.participante.nome ?? "";
  const periodo =
    t.data_inicio === t.data_fim
      ? `em ${datas_br.numerica(t.data_inicio)}`
      : `de ${datas_br.numerica(t.data_inicio)} a ${datas_br.numerica(t.data_fim)}`;
  const assunto = `${aceita ? "Inscrição confirmada" : "Pedido de inscrição"} — ${t.treinamento.nome}`;
  const corpo =
    `Olá, ${nome}.\n\n` +
    (aceita
      ? `${equipe} confirmou a sua inscrição no treinamento ${t.treinamento.nome} ` +
        `(turma ${t.codigo}, ${periodo}${t.local ? `, ${t.local}` : ""}). A vaga é sua.\n\n` +
        "Se não puder comparecer, avise a equipe responsável para que a vaga passe a outra pessoa.\n\n"
      : `O seu pedido de vaga no treinamento ${t.treinamento.nome} (turma ${t.codigo}, ${periodo}) ` +
        "não pôde ser aceito. Em caso de dúvida, fale com a equipe responsável.\n\n") +
    _assinatura(promotor?.nome_extenso ?? "");
  await email.enfileirar(tx, {
    tipo: aceita ? TIPO_ACEITA : TIPO_RECUSADA,
    destinatario: para,
    assunto,
    corpo,
    inscricao_id: inscricao.id,
    criado_por,
  });
  return true;
}

/**
 * A agenda da turma no e-mail de inscrição aceita. Sem a inscrição (apagada
 * com a turma, por exemplo) o e-mail sai sem anexo, e não falha: a agenda é
 * cortesia, o aviso é o que importa.
 */
email.registrar_anexador(TIPO_ACEITA, async (tx, mensagem) => {
  if (mensagem.inscricao_id === null) return [];
  // import tardio: `turma.ts` importa este arquivo
  const servico_turma = await import("./turma.js");
  const inscricao = await servico_turma.carregar_inscricao(tx, mensagem.inscricao_id);
  if (!inscricao || !inscricao.turma || inscricao.turma.situacao === "CANCELADA") return [];
  const agenda = await ics.da_turma(tx, inscricao.turma);
  return [{ nome: agenda.nome, tipo: ics.TIPO_ICS, bytes: agenda.bytes }];
});
