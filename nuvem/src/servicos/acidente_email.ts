/**
 * O e-mail do módulo de acidentes (D6, 23/10/2026), no padrão de `epi_email.ts`.
 *
 * - **Desligado por padrão.** Só enfileira com `CSSO_ACIDENTE_EMAIL=sim`
 *   (`obterConfig().acidenteEmailLigado`). Ligado, a mensagem entra na caixa de
 *   saída na MESMA transação da comunicação e só sai com o SMTP configurado.
 * - **O mínimo no corpo.** Protocolo, o que aconteceu e o link. Nunca o nome de
 *   ninguém, a descrição do acidente nem nada de saúde: o conteúdo se lê no
 *   sistema, onde a leitura passa pelo escopo.
 * - **Sem falha silenciosa.** Cada chamada ligada grava UM evento
 *   `ACIDENTE_EMAIL_ENFILEIRADO` na trilha da ocorrência dizendo para quem foi
 *   ("setor", "comunicante") e para quem não foi, e por quê — sem o endereço.
 *
 * Quem recebe, nesta fatia (F1):
 * - comunicação nova: o SETOR (`CSSO_ACIDENTE_EMAIL_SETOR`) e o comunicante
 *   logado (confirmação de recebimento);
 * - pedido de complementação: o comunicante logado.
 * O comunicante do formulário por link (F2) não recebe (D6). Prazo de ação é
 * de outra fatia.
 *
 * Relatório emitido e caso concluído (decisão de 29/10/2026): o ACIDENTADO que
 * é servidor e tem conta recebe o aviso — só «há novidade na sua ocorrência»,
 * o protocolo e o link; nada do relatório, da lesão ou da conclusão no corpo.
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_ocorrencia, acidentado as tabela_acidentado, usuario as tabela_usuario } from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import * as auditoria from "./auditoria.js";
import * as email from "./email.js";
import type { UsuarioAtual } from "./rbac.js";

type Ocorrencia = typeof acidente_ocorrencia.$inferSelect;

const ENTIDADE = "acidente_ocorrencia";

/** `email_saida.tipo` (até 30 caracteres). */
export const TIPO_NOVA_SETOR = "ACIDENTE_NOVA_SETOR";
export const TIPO_CONFIRMACAO = "ACIDENTE_CONFIRMACAO";
export const TIPO_COMPLEMENTACAO = "ACIDENTE_COMPLEMENTACAO";
export const TIPO_RELATORIO = "ACIDENTE_RELATORIO";
export const TIPO_CONCLUSAO = "ACIDENTE_CONCLUSAO";

export function ligado(): boolean {
  return obterConfig().acidenteEmailLigado;
}

function _raiz(): string {
  return (process.env.CSSO_URL_PUBLICA || process.env.URL || "").trim().replace(/\/+$/, "");
}

export function link_da_ocorrencia(ocorrencia: Pick<Ocorrencia, "id">, sufixo = ""): string {
  return `${_raiz()}/acidentes/${ocorrencia.id}${sufixo}`;
}

const ASSINATURA =
  "\n\n--\nSistema SISA · UFVJM\nMensagem automática: não responda. " +
  "Por segurança, este e-mail não traz o conteúdo da comunicação — ele está no sistema.";

type Destino = { para: string } | { falta: string };

function _destino_do_setor(): Destino {
  const setor = obterConfig().acidenteEmailSetor;
  if (!setor) return { falta: "o endereço do setor não está configurado (CSSO_ACIDENTE_EMAIL_SETOR)" };
  if (!email.email_valido(setor)) return { falta: "o endereço do setor configurado é inválido (CSSO_ACIDENTE_EMAIL_SETOR)" };
  return { para: setor };
}

/** O e-mail da conta do comunicante logado; sem conta, não há para onde mandar. */
export async function destino_da_conta(tx: Executor, usuario_id: number | null): Promise<Destino> {
  if (usuario_id === null) return { falta: "a comunicação não veio de uma conta" };
  const [conta] = await tx
    .select({ email: tabela_usuario.email, ativo: tabela_usuario.ativo })
    .from(tabela_usuario)
    .where(eq(tabela_usuario.id, usuario_id));
  if (!conta || !conta.ativo) return { falta: "a conta do comunicante não está ativa" };
  if (!conta.email || !email.email_valido(conta.email)) return { falta: "a conta do comunicante não tem e-mail válido" };
  return { para: conta.email.trim() };
}

interface Mensagem {
  quem: "setor" | "comunicante" | "acidentado";
  destino: Destino;
  tipo: string;
  assunto: string;
  corpo: string;
}

async function _enviar(
  tx: Executor,
  ocorrencia: Ocorrencia,
  usuario: UsuarioAtual | null,
  momento: string,
  mensagens: Mensagem[],
): Promise<number> {
  const partes: string[] = [];
  let enfileiradas = 0;
  for (const m of mensagens) {
    if ("para" in m.destino) {
      await email.enfileirar(tx, {
        tipo: m.tipo,
        destinatario: m.destino.para,
        assunto: m.assunto,
        corpo: m.corpo,
        criado_por: usuario ? usuario.id : null,
      });
      enfileiradas += 1;
      partes.push(`${m.quem}: enfileirado`);
    } else {
      partes.push(`${m.quem}: NÃO enfileirado — ${m.destino.falta}`);
    }
  }
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_EMAIL_ENFILEIRADO,
    // sem endereço e sem nome: "setor" e "comunicante"
    descricao: `${ocorrencia.protocolo} (${momento}): ${partes.join("; ")}`,
    campo: "email",
    valor_novo: `${enfileiradas}/${mensagens.length}`,
    usuario,
  });
  return enfileiradas;
}

/** Comunicação nova: o setor e a confirmação ao comunicante logado. */
export async function avisar_nova_comunicacao(
  tx: Executor,
  ocorrencia: Ocorrencia,
  usuario: UsuarioAtual | null,
): Promise<number> {
  if (!ligado()) return 0;
  const link = link_da_ocorrencia(ocorrencia);
  return _enviar(tx, ocorrencia, usuario, "comunicação", [
    {
      quem: "setor",
      destino: _destino_do_setor(),
      tipo: TIPO_NOVA_SETOR,
      assunto: `Nova comunicação de acidente — ${ocorrencia.protocolo}`,
      corpo:
        `Chegou a comunicação de acidente ${ocorrencia.protocolo}. O prazo legal de comunicação ` +
        "(Lei 8.112, art. 214) conta da data do acidente.\n\nEntre no Sistema SISA para triar:\n" +
        link +
        ASSINATURA,
    },
    {
      quem: "comunicante",
      destino: await destino_da_conta(tx, ocorrencia.criado_por),
      tipo: TIPO_CONFIRMACAO,
      assunto: `Comunicação de acidente recebida — ${ocorrencia.protocolo}`,
      corpo:
        `A comunicação de acidente ${ocorrencia.protocolo} foi recebida pela equipe de segurança do trabalho. ` +
        "O andamento fica no sistema:\n" +
        link +
        ASSINATURA,
    },
  ]);
}

/** Pedido de complementação: o comunicante logado. */
export async function avisar_complementacao(
  tx: Executor,
  ocorrencia: Ocorrencia,
  comunicante_id: number | null,
  usuario: UsuarioAtual,
): Promise<number> {
  if (!ligado()) return 0;
  return _enviar(tx, ocorrencia, usuario, "complementação pedida", [
    {
      quem: "comunicante",
      destino: await destino_da_conta(tx, comunicante_id),
      tipo: TIPO_COMPLEMENTACAO,
      assunto: `Complementação pedida — ${ocorrencia.protocolo}`,
      corpo:
        `A equipe de segurança do trabalho pediu uma complementação da comunicação ${ocorrencia.protocolo}. ` +
        "O que falta está escrito no sistema; responda por lá:\n" +
        link_da_ocorrencia(ocorrencia, "/complementar") +
        ASSINATURA,
    },
  ]);
}

/**
 * A conta de cada acidentado que é servidor (uma por pessoa, sem repetir). Sem
 * servidor vinculado, ou sem conta ativa com e-mail, a trilha diz que não foi.
 */
async function _destinos_dos_acidentados(tx: Executor, ocorrencia: Ocorrencia): Promise<Destino[]> {
  const envolvidos = await tx
    .select({ servidor_id: tabela_acidentado.servidor_id })
    .from(tabela_acidentado)
    .where(eq(tabela_acidentado.ocorrencia_id, ocorrencia.id));
  const servidores = [...new Set(envolvidos.map((e) => e.servidor_id).filter((id): id is number => id !== null))];
  const destinos: Destino[] = [];
  const vistos = new Set<string>();
  for (const servidor_id of servidores) {
    const [conta] = await tx
      .select({ id: tabela_usuario.id })
      .from(tabela_usuario)
      .where(eq(tabela_usuario.servidor_id, servidor_id));
    const d = await destino_da_conta(tx, conta?.id ?? null);
    if ("para" in d) {
      if (vistos.has(d.para.toLowerCase())) continue;
      vistos.add(d.para.toLowerCase());
    }
    destinos.push(d);
  }
  if (!envolvidos.some((e) => e.servidor_id !== null)) {
    destinos.push({ falta: "nenhum acidentado é servidor com conta" });
  }
  return destinos;
}

async function _avisar_acidentados(
  tx: Executor,
  ocorrencia: Ocorrencia,
  usuario: UsuarioAtual | null,
  momento: string,
  tipo: string,
  assunto: string,
  texto: string,
): Promise<number> {
  if (!ligado()) return 0;
  const destinos = await _destinos_dos_acidentados(tx, ocorrencia);
  return _enviar(
    tx,
    ocorrencia,
    usuario,
    momento,
    destinos.map((destino) => ({
      quem: "acidentado" as const,
      destino,
      tipo,
      assunto: `${assunto} — ${ocorrencia.protocolo}`,
      corpo: `${texto} Ocorrência ${ocorrencia.protocolo}. O que há de novo está no sistema:\n${link_da_ocorrencia(ocorrencia)}${ASSINATURA}`,
    })),
  );
}

/** Relatório emitido: avisa o acidentado servidor. */
export function avisar_relatorio_emitido(tx: Executor, ocorrencia: Ocorrencia, usuario: UsuarioAtual | null): Promise<number> {
  return _avisar_acidentados(
    tx,
    ocorrencia,
    usuario,
    "relatório emitido",
    TIPO_RELATORIO,
    "Há novidade na sua ocorrência",
    "A equipe de segurança do trabalho emitiu o relatório da ocorrência em que você é um dos envolvidos.",
  );
}

/** Caso concluído: avisa o acidentado servidor. */
export function avisar_conclusao(tx: Executor, ocorrencia: Ocorrencia, usuario: UsuarioAtual | null): Promise<number> {
  return _avisar_acidentados(
    tx,
    ocorrencia,
    usuario,
    "caso concluído",
    TIPO_CONCLUSAO,
    "Sua ocorrência foi concluída",
    "A equipe de segurança do trabalho concluiu a ocorrência em que você é um dos envolvidos.",
  );
}
