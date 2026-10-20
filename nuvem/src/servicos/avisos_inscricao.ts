/**
 * O aviso por e-mail a quem pediu vaga pelo link público (`inscricao_publica.ts`):
 * aceito ou recusado. Só para o pedido do link — a inscrição interna a CSSO
 * combina por outros meios —, e só quando a pessoa deixou e-mail.
 *
 * O motivo da recusa NÃO vai no e-mail: ele é escrito para a trilha, por quem
 * conferiu, e não para a pessoa.
 */
import type { Executor } from "../db/cliente.js";
import { Participante } from "../dominio/treinamento.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";

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
  };
  participante: {
    nome: string | null;
    servidor: { nome: string } | null;
    email_principal?: { email: string } | null;
    emails: ReadonlyArray<{ email: string }>;
  };
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
  const nome = inscricao.participante.servidor?.nome ?? inscricao.participante.nome ?? "";
  const periodo =
    t.data_inicio === t.data_fim
      ? `em ${datas_br.numerica(t.data_inicio)}`
      : `de ${datas_br.numerica(t.data_inicio)} a ${datas_br.numerica(t.data_fim)}`;
  const assunto = `${aceita ? "Inscrição confirmada" : "Pedido de inscrição"} — ${t.treinamento.nome}`;
  const corpo =
    `Olá, ${nome}.\n\n` +
    (aceita
      ? `A CSSO confirmou a sua inscrição no treinamento ${t.treinamento.nome} ` +
        `(turma ${t.codigo}, ${periodo}${t.local ? `, ${t.local}` : ""}). A vaga é sua.\n\n` +
        "Se não puder comparecer, avise a CSSO para que a vaga passe a outra pessoa.\n\n"
      : `O seu pedido de vaga no treinamento ${t.treinamento.nome} (turma ${t.codigo}, ${periodo}) ` +
        "não pôde ser aceito. Em caso de dúvida, fale com a CSSO.\n\n") +
    "Coordenação de Saúde e Segurança Ocupacional (CSSO) — UFVJM\n" +
    "Mensagem enviada pelo Sistema CSSO.\n";
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
