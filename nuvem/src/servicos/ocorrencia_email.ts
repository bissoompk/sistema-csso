/**
 * O e-mail do módulo de ocorrências de urgência e emergência (28/10/2026), no
 * padrão de `acidente_email.ts`.
 *
 * - **Desligado por padrão.** Só enfileira com `CSSO_OCORRENCIA_EMAIL=sim`
 *   (`obterConfig().ocorrenciaEmailLigado`); a mensagem entra na caixa de saída
 *   na MESMA transação do registro e só sai com o SMTP configurado.
 * - **O mínimo no corpo.** Protocolo e o link. Nunca o nome de ninguém, o relato
 *   nem nada de saúde: o conteúdo se lê no sistema, onde a leitura passa pelo
 *   escopo.
 * - **Sem falha silenciosa.** Cada chamada ligada grava UM evento
 *   `OCORRENCIA_EMAIL_ENFILEIRADO` dizendo para quem foi («equipe», «quem
 *   registrou») e para quem não foi, e por quê — sem o endereço.
 *
 * Quem recebe: a EQUIPE (`CSSO_OCORRENCIA_EMAIL_SETOR`) avisada da ocorrência
 * nova e quem registrou (confirmação, com o protocolo).
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { ocorrencia as tabela, usuario as tabela_usuario } from "../db/esquema/index.js";
import { obterConfig } from "../config.js";
import * as auditoria from "./auditoria.js";
import * as email from "./email.js";
import type { UsuarioAtual } from "./rbac.js";

type Ocorrencia = typeof tabela.$inferSelect;

/** `email_saida.tipo` (até 30 caracteres). */
export const TIPO_NOVA_EQUIPE = "OCORRENCIA_NOVA_EQUIPE";
export const TIPO_CONFIRMACAO = "OCORRENCIA_CONFIRMACAO";

export function ligado(): boolean {
  return obterConfig().ocorrenciaEmailLigado;
}

function _raiz(): string {
  return (process.env.CSSO_URL_PUBLICA || process.env.URL || "").trim().replace(/\/+$/, "");
}

export function link_da_ocorrencia(o: Pick<Ocorrencia, "id">): string {
  return `${_raiz()}/ocorrencias/${o.id}`;
}

const ASSINATURA =
  "\n\n--\nSistema SISA · UFVJM\nMensagem automática: não responda. " +
  "Por segurança, este e-mail não traz o conteúdo da ocorrência — ele está no sistema.";

type Destino = { para: string } | { falta: string };

function _destino_da_equipe(): Destino {
  const equipe = obterConfig().ocorrenciaEmailSetor;
  if (!equipe) return { falta: "o endereço da equipe não está configurado (CSSO_OCORRENCIA_EMAIL_SETOR)" };
  if (!email.email_valido(equipe)) return { falta: "o endereço da equipe configurado é inválido (CSSO_OCORRENCIA_EMAIL_SETOR)" };
  return { para: equipe };
}

async function _destino_da_conta(tx: Executor, usuario_id: number): Promise<Destino> {
  const [conta] = await tx
    .select({ email: tabela_usuario.email, ativo: tabela_usuario.ativo })
    .from(tabela_usuario)
    .where(eq(tabela_usuario.id, usuario_id));
  if (!conta || !conta.ativo) return { falta: "a conta de quem registrou não está ativa" };
  if (!conta.email || !email.email_valido(conta.email)) return { falta: "a conta de quem registrou não tem e-mail válido" };
  return { para: conta.email.trim() };
}

/** Ocorrência nova: a equipe e a confirmação a quem registrou. */
export async function avisar_nova_ocorrencia(tx: Executor, o: Ocorrencia, usuario: UsuarioAtual): Promise<number> {
  if (!ligado()) return 0;
  const link = link_da_ocorrencia(o);
  const mensagens: { quem: string; destino: Destino; tipo: string; assunto: string; corpo: string }[] = [
    {
      quem: "equipe",
      destino: _destino_da_equipe(),
      tipo: TIPO_NOVA_EQUIPE,
      assunto: `Nova ocorrência de urgência/emergência — ${o.protocolo}`,
      corpo: `Foi registrada a ocorrência ${o.protocolo}.\n\nEntre no Sistema SISA para assumir e acompanhar:\n${link}${ASSINATURA}`,
    },
    {
      quem: "quem registrou",
      destino: await _destino_da_conta(tx, o.registrado_por),
      tipo: TIPO_CONFIRMACAO,
      assunto: `Ocorrência registrada — ${o.protocolo}`,
      corpo: `A ocorrência ${o.protocolo} foi recebida pela equipe. O andamento fica no sistema:\n${link}${ASSINATURA}`,
    },
  ];
  const partes: string[] = [];
  let enfileiradas = 0;
  for (const m of mensagens) {
    if ("para" in m.destino) {
      await email.enfileirar(tx, {
        tipo: m.tipo,
        destinatario: m.destino.para,
        assunto: m.assunto,
        corpo: m.corpo,
        criado_por: usuario.id,
      });
      enfileiradas += 1;
      partes.push(`${m.quem}: enfileirado`);
    } else {
      partes.push(`${m.quem}: NÃO enfileirado — ${m.destino.falta}`);
    }
  }
  await auditoria.registrar(tx, {
    entidade: "ocorrencia",
    entidade_id: o.id,
    tipo_evento: "OCORRENCIA_EMAIL_ENFILEIRADO",
    // sem endereço e sem nome
    descricao: `${o.protocolo}: ${partes.join("; ")}`,
    campo: "email",
    valor_novo: `${enfileiradas}/${mensagens.length}`,
    usuario,
  });
  return enfileiradas;
}
