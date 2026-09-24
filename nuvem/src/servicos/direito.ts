/**
 * Máquina B — o direito concedido (`adicional_vigencia`).
 * Porte de `app/servicos/direito.py`.
 *
 * PROPOSTO (parecer favorável) -> VIGENTE (portaria de concessão + SIAPE)
 *         -> {SUSPENSO, EM_REAVALIACAO, ALTERADO, CESSADO}
 *
 * RN-09: no máximo um adicional VIGENTE por servidor (IN 15/2022, art. 4º —
 * insalubridade, periculosidade, irradiação ionizante e raios X não se
 * acumulam). Concessão sobre adicional vigente exige registro de opção anexado
 * antes de cessar o anterior, e as datas ficam encadeadas sem lacuna nem
 * sobreposição.
 *
 * RN-21: `motivo_suspensao` é enumerado e JAMAIS registra gestação/lactação — o
 * caso do art. 69, parágrafo único, da Lei 8.112/90 entra como
 * AFASTAMENTO_LEGAL com a base legal citada.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { adicional_vigencia, anexo } from "../db/esquema/index.js";
import { exigir_transicao_direito } from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";

export type AdicionalVigencia = typeof adicional_vigencia.$inferSelect;

export const MOTIVOS_SUSPENSAO: Readonly<Record<string, string>> = Object.freeze({
  CESSACAO_RISCO: "eliminação das condições que geraram o direito (Lei 8.112/90, art. 68, §2º)",
  AFASTAMENTO_DO_LOCAL: "afastamento do local de exposição",
  AFASTAMENTO_LEGAL: "afastamento legal do servidor",
  DECISAO_ADMINISTRATIVA: "decisão administrativa",
});

// RN-21: a hipótese do art. 69, p.ú. entra assim — nunca como gestação.
export const BASE_ART69 = "Lei 8.112/90, art. 69, p.ú.";

/** Violação das regras da máquina B. */
export class RegraDoDireito extends RegraViolada {}

// A conferência da máquina B mora em `estados.ts`, junto das outras.
// `TransicaoInvalida` continua sendo a exceção que sobe.
const _exigir_transicao = exigir_transicao_direito;

/** Grava os campos e atualiza o objeto em memória (o `flush` do ORM). */
async function _gravar(tx: Executor, vigencia: AdicionalVigencia, novos: Partial<AdicionalVigencia>): Promise<void> {
  await tx.update(adicional_vigencia).set(novos).where(eq(adicional_vigencia.id, vigencia.id));
  Object.assign(vigencia, novos);
}

export async function vigente_do_servidor(tx: Executor, servidor_id: number): Promise<AdicionalVigencia | null> {
  const [v] = await tx
    .select()
    .from(adicional_vigencia)
    .where(and(eq(adicional_vigencia.servidor_id, servidor_id), eq(adicional_vigencia.estado, "VIGENTE")));
  return v ?? null;
}

/**
 * Lei 8.112/90, art. 68, §1º — entre insalubridade e periculosidade a opção é
 * do servidor, e ela precisa estar documentada.
 */
export async function tem_registro_de_opcao(tx: Executor, vigencia: AdicionalVigencia): Promise<boolean> {
  if (vigencia.registro_opcao_anexo_id) {
    const [a] = await tx.select({ id: anexo.id }).from(anexo).where(eq(anexo.id, vigencia.registro_opcao_anexo_id));
    return a !== undefined;
  }
  return false;
}

/** O que `propor` lê do parecer: a situação, o movimento e a exposição principal. */
export interface ParecerQuePropoe {
  id: number;
  numero: number;
  ano: number;
  situacao: string;
  servidor_id: number | null;
  processo_id: number | null;
  tipo_adicional_id: number | null;
  tipo_adicional: { nome: string } | null;
  tipo_movimento: { nome: string; gera_direito: boolean } | null;
  exposicoes: { principal: boolean; percentual_id: number; percentual: { rotulo: string } }[];
}

// ---------------------------------------------------------------------
/** Cria a proposta a partir de um parecer emitido/assinado favorável. */
export async function propor(tx: Executor, parecer: ParecerQuePropoe, usuario: UsuarioAtual): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  if (parecer.situacao !== "EMITIDO" && parecer.situacao !== "ASSINADO") {
    throw new RegraDoDireito(`só um parecer emitido ou assinado propõe direito — este está ${parecer.situacao}`);
  }
  if (parecer.tipo_movimento && !parecer.tipo_movimento.gera_direito) {
    throw new RegraDoDireito(`o movimento '${parecer.tipo_movimento.nome}' não gera direito`);
  }

  const [ja] = await tx.select().from(adicional_vigencia).where(eq(adicional_vigencia.parecer_id, parecer.id));
  if (ja) return ja;

  const principal = parecer.exposicoes.find((e) => e.principal) ?? null;
  if (principal === null || parecer.servidor_id === null) {
    throw new RegraDoDireito("a proposta exige servidor e exposição principal no parecer");
  }

  const [vigencia] = await tx
    .insert(adicional_vigencia)
    .values({
      servidor_id: parecer.servidor_id,
      parecer_id: parecer.id,
      tipo_adicional_id: parecer.tipo_adicional_id!,
      percentual_id: principal.percentual_id,
      estado: "PROPOSTO",
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia!.id,
    processo_id: parecer.processo_id,
    tipo_evento: "DIREITO_PROPOSTO",
    descricao:
      `Proposta a partir do parecer ${parecer.numero}/${parecer.ano}: ` +
      `${parecer.tipo_adicional ? parecer.tipo_adicional.nome : ""} ` +
      `${principal.percentual.rotulo}.`,
    usuario,
  });
  return vigencia!;
}

/** PROPOSTO -> VIGENTE. Faz valer a RN-09 antes de gravar. */
export async function conceder(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  d: { portaria_concessao: string; data_portaria: string; data_inicio: string },
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "VIGENTE");
  if (!d.portaria_concessao.trim()) {
    throw new RegraDoDireito("a concessão exige a portaria de concessão (IN 15/2022, art. 13)");
  }

  const anterior = await vigente_do_servidor(tx, vigencia.servidor_id);
  if (anterior !== null && anterior.id !== vigencia.id) {
    // RN-09: não acumulam (IN 15/2022, art. 4º). A opção é do servidor
    // (Lei 8.112/90, art. 68, §1º) e precisa estar anexada.
    if (!(await tem_registro_de_opcao(tx, vigencia))) {
      throw new RegraDoDireito(
        "o servidor já tem adicional vigente e os adicionais não se " +
          "acumulam (IN 15/2022, art. 4º). Anexe o registro de opção do " +
          "servidor antes de conceder o novo (Lei 8.112/90, art. 68, §1º).",
      );
    }
    // `date.min` do Python: sem início, qualquer data é posterior
    if (d.data_inicio <= (anterior.data_inicio ?? "0001-01-01")) {
      throw new RegraDoDireito("a data de início do novo adicional precisa ser posterior ao início do anterior");
    }
    // datas encadeadas: sem lacuna e sem sobreposição
    await cessar(tx, anterior, usuario, {
      data_fim: datas_br.somar_dias(d.data_inicio, -1),
      motivo: "DECISAO_ADMINISTRATIVA",
      base_legal: "Lei 8.112/90, art. 68, §1º — opção do servidor",
    });
  }

  await _gravar(tx, vigencia, {
    estado: "VIGENTE",
    portaria_concessao: d.portaria_concessao.trim(),
    data_portaria_concessao: d.data_portaria,
    data_inicio: d.data_inicio,
    data_fim: null,
    motivo_suspensao: null,
    base_legal_suspensao: null,
  });

  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_VIGENTE",
    descricao: `Concedido por ${vigencia.portaria_concessao}, com efeito a partir de ${d.data_inicio}.`,
    usuario,
  });
  return vigencia;
}

export async function suspender(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  d: { motivo: string; base_legal?: string | null; data_fim?: string | null },
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "SUSPENSO");
  if (!Object.hasOwn(MOTIVOS_SUSPENSAO, d.motivo)) {
    throw new RegraDoDireito(
      "motivo de suspensão inválido — use um dos enumerados: " + Object.keys(MOTIVOS_SUSPENSAO).join(", "),
    );
  }
  const base_legal = d.base_legal ?? null;
  await _gravar(tx, vigencia, {
    estado: "SUSPENSO",
    motivo_suspensao: d.motivo,
    base_legal_suspensao: base_legal,
    data_fim: d.data_fim ?? null,
  });
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_SUSPENSO",
    descricao: `${MOTIVOS_SUSPENSAO[d.motivo]}` + (base_legal ? ` — ${base_legal}` : ""),
    usuario,
  });
  return vigencia;
}

/** RN-21 — o caso do art. 69, p.ú. entra assim, sem citar a causa pessoal. */
export function suspender_por_afastamento_legal(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
): Promise<AdicionalVigencia> {
  return suspender(tx, vigencia, usuario, { motivo: "AFASTAMENTO_LEGAL", base_legal: BASE_ART69 });
}

export async function reavaliar(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  motivo: string,
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "EM_REAVALIACAO");
  await _gravar(tx, vigencia, { estado: "EM_REAVALIACAO" });
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_EM_REAVALIACAO",
    descricao: motivo,
    usuario,
  });
  await pendencias.abrir(tx, {
    tipo: "REAVALIACAO_LAUDO",
    chave: `reavaliacao:vigencia:${vigencia.id}`,
    descricao: `Reavaliar o adicional do servidor #${vigencia.servidor_id}: ${motivo}`,
    usuario,
    parecer_id: vigencia.parecer_id,
  });
  return vigencia;
}

export async function alterar(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  d: { percentual_id: number; motivo: string },
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "ALTERADO");
  const anterior = vigencia.percentual_id;
  await _gravar(tx, vigencia, { estado: "ALTERADO", percentual_id: d.percentual_id });
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_ALTERADO",
    descricao: d.motivo,
    campo: "percentual_id",
    valor_anterior: anterior,
    valor_novo: d.percentual_id,
    usuario,
  });
  return vigencia;
}

export async function cessar(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  d: { data_fim: string; motivo?: string; base_legal?: string | null },
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "CESSADO");
  const motivo = d.motivo ?? "CESSACAO_RISCO";
  if (vigencia.data_inicio && d.data_fim < vigencia.data_inicio) {
    throw new RegraDoDireito("a data de término não pode ser anterior ao início");
  }
  await _gravar(tx, vigencia, {
    estado: "CESSADO",
    data_fim: d.data_fim,
    motivo_suspensao: Object.hasOwn(MOTIVOS_SUSPENSAO, motivo) ? motivo : null,
    base_legal_suspensao: d.base_legal || (motivo === "CESSACAO_RISCO" ? "Lei 8.112/90, art. 68, §2º" : null),
  });
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_CESSADO",
    descricao: `Cessado em ${d.data_fim} — ${Object.hasOwn(MOTIVOS_SUSPENSAO, motivo) ? MOTIVOS_SUSPENSAO[motivo] : motivo}`,
    usuario,
  });
  return vigencia;
}

/** SUSPENSO/ALTERADO/EM_REAVALIACAO -> VIGENTE, respeitando a RN-09. */
export async function retomar(
  tx: Executor,
  vigencia: AdicionalVigencia,
  usuario: UsuarioAtual,
  data_inicio: string,
): Promise<AdicionalVigencia> {
  usuario.exigir("parecer.emitir");
  _exigir_transicao(vigencia.estado, "VIGENTE");
  const outro = await vigente_do_servidor(tx, vigencia.servidor_id);
  if (outro !== null && outro.id !== vigencia.id) {
    throw new RegraDoDireito(
      "o servidor já tem outro adicional vigente — os adicionais não se acumulam (IN 15/2022, art. 4º)",
    );
  }
  await _gravar(tx, vigencia, { estado: "VIGENTE", data_inicio, data_fim: null, motivo_suspensao: null });
  await auditoria.registrar(tx, {
    entidade: "adicional_vigencia",
    entidade_id: vigencia.id,
    tipo_evento: "DIREITO_VIGENTE",
    descricao: `Retomado a partir de ${data_inicio}.`,
    usuario,
  });
  return vigencia;
}

export async function linha_do_tempo(tx: Executor, servidor_id: number): Promise<AdicionalVigencia[]> {
  const itens = await tx
    .select()
    .from(adicional_vigencia)
    .where(eq(adicional_vigencia.servidor_id, servidor_id))
    .orderBy(asc(adicional_vigencia.id));
  // sorted(key=(data_inicio or date.min, id))
  return itens.sort((a, b) => {
    const da = a.data_inicio ?? "0001-01-01";
    const db = b.data_inicio ?? "0001-01-01";
    return da !== db ? (da < db ? -1 : 1) : a.id - b.id;
  });
}

function _dias(inicio: string, fim: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(fim) - d(inicio)) / 86_400_000);
}

/** Datas encadeadas sem lacuna nem sobreposição (RN-09). */
export async function lacunas_na_linha_do_tempo(tx: Executor, servidor_id: number): Promise<string[]> {
  const problemas: string[] = [];
  const historico = (await linha_do_tempo(tx, servidor_id)).filter((v) => v.data_inicio);
  for (let i = 0; i + 1 < historico.length; i++) {
    const anterior = historico[i]!;
    const seguinte = historico[i + 1]!;
    if (anterior.data_fim === null) {
      problemas.push(`o adicional #${anterior.id} não foi encerrado antes de começar o #${seguinte.id}`);
      continue;
    }
    if (seguinte.data_inicio! <= anterior.data_fim) {
      problemas.push(`sobreposição entre #${anterior.id} e #${seguinte.id}`);
    } else if (_dias(anterior.data_fim, seguinte.data_inicio!) > 1) {
      problemas.push(
        `lacuna de ${_dias(anterior.data_fim, seguinte.data_inicio!) - 1} dia(s) ` +
          `entre #${anterior.id} e #${seguinte.id}`,
      );
    }
  }
  return problemas;
}
