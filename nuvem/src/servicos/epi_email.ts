/**
 * Fatia F da paridade com o IntegraSST (22/10/2026, Decisão 1): o e-mail do
 * pedido de EPI.
 *
 * O legado mandava e-mail na abertura (ao SESMT e ao requerente,
 * `L:EPI_Backend.js:319-356`) e na decisão (`:724-798`), em HTML montado com
 * texto do usuário sem escape e com `try/catch` que engolia a falha. Aqui:
 *
 * - **Desligado por padrão.** Só enfileira com `CSSO_EPI_EMAIL=sim`
 *   (`obterConfig().epiEmailLigado`). Ligado, a mensagem vai para a caixa de
 *   saída (`email.enfileirar`, na MESMA transação do pedido: desfeito o pedido,
 *   o e-mail some junto) e só SAI quando o SMTP estiver configurado
 *   (`CSSO_SMTP_URL` + `CSSO_EMAIL_REMETENTE`); até lá fica PENDENTE na caixa.
 * - **Texto puro.** O `email.ts` só manda `text`; nada de HTML aqui.
 * - **O mínimo no corpo (RN-19/RN-21).** Protocolo, o que aconteceu e o link —
 *   sem nome de ninguém, sem CPF, sem rotina de trabalho, riscos ou
 *   justificativa (que podem tocar em saúde), e **sem o texto da recusa**: a
 *   negativa se lê no sistema, onde ela fica congelada (RN-27).
 * - **Sem falha silenciosa.** Endereço ausente ou inválido NÃO derruba o
 *   pedido — mas cada chamada ligada grava UM evento `EPI_EMAIL_ENFILEIRADO` na
 *   trilha do pedido dizendo para quem foi enfileirado e para quem não foi, e
 *   por quê. A equipe lê isso no histórico da ficha do pedido. O endereço em si
 *   NÃO vai para a trilha (que é permanente): vai "setor" e "requerente".
 *
 * Quem recebe:
 * - abertura: o SETOR (`CSSO_EPI_EMAIL_SETOR`) e o requerente;
 * - decisão (pedido analisado ou indeferido, também depois de reconsiderar) e
 *   retirada disponível (item reservado): o requerente — é a repetição dos dois
 *   avisos do sino (`EPI_DECISAO_A_LER`, `EPI_RETIRADA_DISPONIVEL`);
 * - entrega concluída: ninguém (recusado de propósito, CHANGELOG 1.36.0).
 *
 * O requerente é quem vai USAR o equipamento, como no sino
 * (`_conta_do_requerente`): o e-mail do cadastro do servidor; sem ele, o da
 * conta ativa ligada ao servidor; sem ela, o da conta de quem abriu o pedido.
 * `participante_email` (Certificados) não entra: é o endereço do participante
 * de treinamento, confirmado para outro fim.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  email_saida,
  epi_item,
  epi_requisicao,
  epi_requisicao_item,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import * as auditoria from "./auditoria.js";
import * as email from "./email.js";
import type { UsuarioAtual } from "./rbac.js";

type Requisicao = typeof epi_requisicao.$inferSelect;

export const EPI_EMAIL_ENFILEIRADO = "EPI_EMAIL_ENFILEIRADO";
const ENTIDADE = "epi_requisicao";

/** `email_saida.tipo` (até 30 caracteres). */
export const TIPO_ABERTURA_SETOR = "EPI_ABERTURA_SETOR";
export const TIPO_ABERTURA_REQUERENTE = "EPI_ABERTURA_REQUERENTE";
export const TIPO_DECISAO = "EPI_DECISAO";
export const TIPO_RETIRADA = "EPI_RETIRADA";

export function ligado(): boolean {
  return obterConfig().epiEmailLigado;
}

/** A raiz do endereço do sistema, para o link. Vazia: o e-mail diz o caminho. */
function _raiz(): string {
  return (process.env.CSSO_URL_PUBLICA || process.env.URL || "").trim().replace(/\/+$/, "");
}

export function link_do_pedido(requisicao: Pick<Requisicao, "id">): string {
  return `${_raiz()}/epis/requisicoes/${requisicao.id}`;
}

function _protocolo(requisicao: Pick<Requisicao, "protocolo" | "id">): string {
  return requisicao.protocolo || `rascunho #${requisicao.id}`;
}

const ASSINATURA =
  "\n\n--\nSistema SISA · UFVJM\nMensagem automática: não responda. " +
  "Por segurança, este e-mail não traz o conteúdo do pedido — ele está no sistema.";

/** O destinatário escolhido, ou o motivo de não haver um. */
type Destino = { para: string } | { falta: string };

/** O e-mail do requerente, na ordem do cabeçalho deste arquivo. */
export async function destino_do_requerente(
  tx: Executor,
  requisicao: Pick<Requisicao, "servidor_id" | "solicitado_por_id">,
): Promise<Destino> {
  const [sv] = await tx
    .select({ email: tabela_servidor.email })
    .from(tabela_servidor)
    .where(eq(tabela_servidor.id, requisicao.servidor_id));
  const candidatos: string[] = [];
  if (sv?.email) candidatos.push(sv.email);
  const [conta] = await tx
    .select({ email: tabela_usuario.email })
    .from(tabela_usuario)
    .where(and(eq(tabela_usuario.servidor_id, requisicao.servidor_id), eq(tabela_usuario.ativo, true)))
    .orderBy(asc(tabela_usuario.id))
    .limit(1);
  if (conta?.email) candidatos.push(conta.email);
  if (!conta) {
    const [quem_abriu] = await tx
      .select({ email: tabela_usuario.email })
      .from(tabela_usuario)
      .where(eq(tabela_usuario.id, requisicao.solicitado_por_id));
    if (quem_abriu?.email) candidatos.push(quem_abriu.email);
  }
  const valido = candidatos.find((c) => email.email_valido(c));
  if (valido) return { para: valido.trim() };
  return { falta: candidatos.length ? "o e-mail do cadastro é inválido" : "não há e-mail no cadastro nem na conta" };
}

function _destino_do_setor(): Destino {
  const setor = obterConfig().epiEmailSetor;
  if (!setor) return { falta: "o endereço do setor não está configurado (CSSO_EPI_EMAIL_SETOR)" };
  if (!email.email_valido(setor)) return { falta: "o endereço do setor configurado é inválido (CSSO_EPI_EMAIL_SETOR)" };
  return { para: setor };
}

interface Mensagem {
  quem: "setor" | "requerente";
  destino: Destino;
  tipo: string;
  assunto: string;
  corpo: string;
}

/**
 * Enfileira o que tem destino e grava UM evento com o resultado de cada
 * destinatário. Devolve quantas mensagens entraram na caixa.
 */
async function _enviar(
  tx: Executor,
  requisicao: Requisicao,
  usuario: UsuarioAtual | null,
  momento: string,
  mensagens: Mensagem[],
  ids: number[] = [],
): Promise<number> {
  const partes: string[] = [];
  let enfileiradas = 0;
  for (const m of mensagens) {
    if ("para" in m.destino) {
      const linha = await email.enfileirar(tx, {
        tipo: m.tipo,
        destinatario: m.destino.para,
        assunto: m.assunto,
        corpo: m.corpo,
        criado_por: usuario ? usuario.id : null,
      });
      ids.push(linha.id);
      enfileiradas += 1;
      partes.push(`${m.quem}: enfileirado`);
    } else {
      partes.push(`${m.quem}: NÃO enfileirado — ${m.destino.falta}`);
    }
  }
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: requisicao.id,
    tipo_evento: EPI_EMAIL_ENFILEIRADO,
    // RN-19 na ESCRITA: sem endereço e sem nome — "setor" e "requerente"
    descricao: `${_protocolo(requisicao)} (${momento}): ${partes.join("; ")}`,
    campo: "email",
    valor_novo: `${enfileiradas}/${mensagens.length}`,
    usuario,
  });
  return enfileiradas;
}

/** Abertura (envio do pedido): o setor e o requerente. */
export async function avisar_abertura(
  tx: Executor,
  requisicao: Requisicao,
  usuario: UsuarioAtual | null,
): Promise<number> {
  if (!ligado()) return 0;
  const protocolo = _protocolo(requisicao);
  const link = link_do_pedido(requisicao);
  const urgente = requisicao.urgencia === "URGENTE";
  return _enviar(tx, requisicao, usuario, "abertura", [
    {
      quem: "setor",
      destino: _destino_do_setor(),
      tipo: TIPO_ABERTURA_SETOR,
      assunto: `${urgente ? "[URGENTE] " : ""}Novo pedido de EPI — ${protocolo}`,
      corpo:
        `Chegou o pedido de EPI ${protocolo}` +
        (urgente ? ", marcado como URGENTE" : "") +
        ".\n\nEntre no Sistema SISA para analisar:\n" +
        link +
        ASSINATURA,
    },
    {
      quem: "requerente",
      destino: await destino_do_requerente(tx, requisicao),
      tipo: TIPO_ABERTURA_REQUERENTE,
      assunto: `Pedido de EPI recebido — ${protocolo}`,
      corpo:
        `O pedido de EPI ${protocolo} foi recebido e está na fila do SESMT.\n\n` +
        "Acompanhe a análise no Sistema SISA:\n" +
        link +
        ASSINATURA,
    },
  ]);
}

/**
 * Decisão (analisado ou indeferido): o requerente. **Não leva o texto da
 * recusa**, nem quais itens: só que há decisão a ler.
 */
export async function avisar_decisao(
  tx: Executor,
  requisicao: Requisicao,
  usuario: UsuarioAtual | null,
): Promise<number> {
  if (!ligado()) return 0;
  const protocolo = _protocolo(requisicao);
  return _enviar(tx, requisicao, usuario, "decisão", [
    {
      quem: "requerente",
      destino: await destino_do_requerente(tx, requisicao),
      tipo: TIPO_DECISAO,
      assunto: `Há decisão no seu pedido de EPI — ${protocolo}`,
      corpo:
        `Há uma decisão no pedido de EPI ${protocolo}.\n\n` +
        "Entre no Sistema SISA para ler:\n" +
        link_do_pedido(requisicao) +
        ASSINATURA,
    },
  ]);
}

/**
 * O e-mail de retirada já enfileirado NESTE ato, por pedido. A chave é o
 * executor da transação (cada ato da tela roda no seu ponto de salvamento):
 * itens reservados no mesmo ato saem num e-mail só, e o segundo item apenas
 * reescreve o corpo da mensagem ainda na fila. Ato seguinte, e-mail novo.
 */
const _retirada_do_ato = new WeakMap<object, Map<number, number>>();

/** Os itens do pedido que já podem ser retirados AGORA (reservados). */
async function _itens_para_retirar(tx: Executor, requisicao_id: number): Promise<string[]> {
  const linhas = await tx
    .select({
      nome: epi_item.nome,
      tamanho: epi_requisicao_item.tamanho,
      quantidade: epi_requisicao_item.quantidade_reservada,
    })
    .from(epi_requisicao_item)
    .innerJoin(epi_item, eq(epi_item.id, epi_requisicao_item.epi_item_id))
    .where(and(eq(epi_requisicao_item.requisicao_id, requisicao_id), eq(epi_requisicao_item.estado, "RESERVADO")))
    .orderBy(asc(epi_requisicao_item.id));
  return linhas.map((l) => `- ${l.quantidade} × ${l.nome}` + (l.tamanho ? ` (tamanho ${l.tamanho})` : ""));
}

function _corpo_da_retirada(protocolo: string, itens: string[], link: string): string {
  return (
    `${itens.length === 1 ? "Há 1 item" : `Há ${itens.length} itens`} do pedido de EPI ${protocolo} ` +
    "separado(s) e esperando você retirar:\n\n" +
    itens.join("\n") +
    "\n\nVeja no Sistema SISA onde e quando retirar:\n" +
    link +
    ASSINATURA
  );
}

/**
 * Item reservado à espera de retirada: o requerente. **Um e-mail por pedido e
 * por ato de reserva** (decisão do usuário, 22/10/2026), listando todos os
 * itens do pedido que já podem ser retirados naquele momento — e não um e-mail
 * por item. Reservas em momentos diferentes geram um e-mail cada uma.
 */
export async function avisar_retirada(
  tx: Executor,
  requisicao: Requisicao,
  usuario: UsuarioAtual | null,
): Promise<number> {
  if (!ligado()) return 0;
  const protocolo = _protocolo(requisicao);
  const link = link_do_pedido(requisicao);
  const itens = await _itens_para_retirar(tx, requisicao.id);
  if (!itens.length) return 0;
  const do_ato = _retirada_do_ato.get(tx as object) ?? new Map<number, number>();
  const ja = do_ato.get(requisicao.id);
  if (ja !== undefined) {
    // o mesmo ato reservou outro item do pedido: reescreve a mensagem na fila
    await tx
      .update(email_saida)
      .set({ corpo: _corpo_da_retirada(protocolo, itens, link) })
      .where(and(eq(email_saida.id, ja), eq(email_saida.situacao, "PENDENTE")));
    return 0;
  }
  const ids: number[] = [];
  const n = await _enviar(
    tx,
    requisicao,
    usuario,
    `retirada · ${itens.length} item(ns)`,
    [
      {
        quem: "requerente",
        destino: await destino_do_requerente(tx, requisicao),
        tipo: TIPO_RETIRADA,
        assunto: `EPI separado para retirada — ${protocolo}`,
        corpo: _corpo_da_retirada(protocolo, itens, link),
      },
    ],
    ids,
  );
  if (ids.length) {
    do_ato.set(requisicao.id, ids[0]!);
    _retirada_do_ato.set(tx as object, do_ato);
  }
  return n;
}
