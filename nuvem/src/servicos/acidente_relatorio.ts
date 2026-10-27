/**
 * O relatório técnico do acidente (fatia F6): emitido em PDF no próprio
 * sistema (D3), a partir de um contexto CONGELADO com hash.
 *
 * - **Duas variantes no mesmo ato**: COMPLETA (para a perícia do SIASS, com o
 *   resumo de saúde — nível 1) e SEM_SAUDE (contratada e fiscal). A segunda é
 *   construída SEM o campo `saude`, e não "limpa" depois: o que não está no
 *   contexto não pode sair no PDF.
 * - **Append-only.** Retificar gera a versão seguinte (das duas variantes) com
 *   motivo e `substitui_id`; a anterior continua legível, marcada como
 *   retificada. O primeiro relatório leva o caso a RELATORIO_EMITIDO (e fecha a
 *   pendência de investigar); a retificação mantém o estado.
 * - **Ler a saúde para a variante completa é uma leitura**: passa por
 *   `acidente_saude.ler` (finalidade INSTRUCAO_PERICIA, `acesso_dado_sensivel`
 *   por acidentado). Por isso emitir exige também `acidente.saude_ver`.
 * - **Download** só pela porta dos anexos (`anexo_acesso.liberar`), que confere
 *   o escopo da ocorrência, exige `acidente.saude_ver` para a COMPLETA e
 *   registra a leitura.
 * - A investigação continua travada depois do relatório: a retificação congela
 *   de novo o que está vigente (CAT/SP retificada, plano, saúde), não reabre o
 *   texto do MAPA.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_evidencia,
  acidente_ocorrencia,
  acidente_relatorio,
  anexo as tabela_anexo,
  campus as tabela_campus,
  pendencia as tabela_pendencia,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import {
  ROTULO_CARACTERIZACAO,
  ROTULO_CONDICAO_ENVOLVIDO,
  ROTULO_ESPECIE,
  ROTULO_ESTADO_ACAO,
  ROTULO_LATERALIDADE,
  ROTULO_LOCAL_TIPO,
  ROTULO_SIM_NAO_NAO_SEI,
  ROTULO_SITUACAO_BARREIRA,
  ROTULO_TIPO_ACAO,
  ROTULO_TIPO_BARREIRA,
  ROTULO_VINCULO_ACIDENTADO,
  VARIANTES_RELATORIO,
} from "../dominio/acidente.js";
import { exigir_transicao_acidente } from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as plano from "./acidente_acao.js";
import * as checklist from "./acidente_checklist.js";
import * as comunicacao from "./acidente_comunicacao.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import * as entrevista from "./acidente_entrevista.js";
import * as investigacao from "./acidente_investigacao.js";
import { gerar_pdf, texto_plano, type ContextoRelatorio } from "./acidente_relatorio_pdf.js";
import * as saude from "./acidente_saude.js";
import * as anexo_acesso from "./anexo_acesso.js";
import * as anexos from "./anexos.js";
import * as auditoria from "./auditoria.js";
import * as pendencias from "./pendencias.js";
import type { UsuarioAtual } from "./rbac.js";

export class RelatorioRecusado extends RegraViolada {}
export class RelatorioInexistente extends RegraViolada {}

export type Relatorio = typeof acidente_relatorio.$inferSelect;
type Variante = (typeof VARIANTES_RELATORIO)[number];

const ENTIDADE = "acidente_ocorrencia";
const FINALIDADE_DO_RELATORIO = "INSTRUCAO_PERICIA";
/** Estados em que se retifica: o relatório já saiu e o caso não se encerrou. */
const RETIFICAVEIS: readonly string[] = ["RELATORIO_EMITIDO", "ENCAMINHADA_SIASS"];

function _rotulo(mapa: Readonly<Record<string, string>>, v: string | null): string | null {
  return v ? (mapa[v] ?? v) : null;
}

/** JSON com as chaves em ordem: o mesmo contexto dá sempre o mesmo hash. */
export function json_estavel(valor: unknown): string {
  const ordenar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordenar);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, ordenar(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(ordenar(valor));
}

export const hash_do_contexto = (c: ContextoRelatorio): string => createHash("sha256").update(json_estavel(c)).digest("hex");

/** O contexto SEM saúde: a base de que a variante completa parte. */
async function _contexto_base(
  tx: Executor,
  ocorrencia: Ocorrencia,
  versao: number,
  emissor: UsuarioAtual,
  retificacao: ContextoRelatorio["retificacao"],
): Promise<Omit<ContextoRelatorio, "variante" | "saude">> {
  const vigente = await comunicacao.cat_sp_vigente(tx, ocorrencia);
  const cat = vigente?.contexto_congelado as comunicacao.ContextoCatSp | undefined;
  const inv = await investigacao.obter(tx, ocorrencia);
  const { acidentados } = await comunicacao.envolvidos_de(tx, ocorrencia.id);
  const [campus] = ocorrencia.campus_id ? await tx.select().from(tabela_campus).where(eq(tabela_campus.id, ocorrencia.campus_id)) : [];
  const [quem] = await tx.select({ nome: tabela_usuario.nome }).from(tabela_usuario).where(eq(tabela_usuario.id, emissor.id));
  const itens = (await checklist.itens(tx, ocorrencia)).filter((i) => i.marcado);
  const evidencias = await entrevista.evidencias(tx, ocorrencia.id);
  const entrevistas = await entrevista.entrevistas(tx, ocorrencia.id);
  const acoes = await plano.do_caso(tx, ocorrencia.id);
  const linha = await investigacao.linha_do_tempo(tx, ocorrencia.id);
  const barreiras = await investigacao.barreiras(tx, ocorrencia.id);
  const texto = (campo: string) => ((inv as Record<string, unknown>)[campo] as string | null)?.trim() || null;
  return {
    protocolo: ocorrencia.protocolo,
    versao,
    emitido_em: new Date().toISOString(),
    emitido_por: quem?.nome ?? "—",
    retificacao,
    identificacao: {
      especie: _rotulo(ROTULO_ESPECIE, ocorrencia.especie)!,
      data_evento: ocorrencia.data_evento,
      hora_evento: ocorrencia.hora_evento,
      local: `${_rotulo(ROTULO_LOCAL_TIPO, ocorrencia.local_tipo)}${ocorrencia.local_especificacao ? ` — ${ocorrencia.local_especificacao}` : ""}`,
      campus: campus?.sigla ?? null,
      municipio_uf: ocorrencia.local_municipio ? `${ocorrencia.local_municipio}${ocorrencia.local_uf ? `/${ocorrencia.local_uf}` : ""}` : null,
    },
    acidentados: acidentados.map((a) => ({
      ordem: a.ordem,
      nome: a.servidor?.nome ?? a.nome_externo ?? `Pessoa ${a.ordem}`,
      siape: a.servidor?.siape ?? null,
      vinculo: _rotulo(ROTULO_VINCULO_ACIDENTADO, a.vinculo)!,
      condicao: _rotulo(ROTULO_CONDICAO_ENVOLVIDO, a.condicao)!,
      empresa: a.empresa_contratada ?? null,
    })),
    relato: { descricao: cat?.relato.descricao ?? "", atividade: cat?.relato.atividade_no_momento ?? null },
    analise: investigacao.CAMPOS_TEXTO.map(([campo, rotulo]) => ({ rotulo, texto: texto(campo) })).filter(
      (x): x is { rotulo: string; texto: string } => x.texto !== null,
    ),
    conclusao: {
      ambiente_fator: _rotulo(ROTULO_SIM_NAO_NAO_SEI, inv.ambiente_fator),
      caracterizacao: _rotulo(ROTULO_CARACTERIZACAO, inv.caracterizacao),
      requer_cat_siass: _rotulo(ROTULO_SIM_NAO_NAO_SEI, inv.requer_cat_siass),
    },
    linha_do_tempo: linha.map((l) => ({ momento: l.momento, descricao: l.descricao })),
    barreiras: barreiras.map((b) => ({
      tipo: _rotulo(ROTULO_TIPO_BARREIRA, b.tipo)!,
      situacao: _rotulo(ROTULO_SITUACAO_BARREIRA, b.situacao)!,
      descricao: b.descricao,
    })),
    checklist: itens.map((i) => ({ secao: checklist.SECOES[i.secao] ?? String(i.secao), texto: i.texto, observacao: i.observacao?.trim() || null })),
    // o relato de cada entrevista fica no caso: o relatório só diz que houve e com que vínculo
    entrevistas: entrevistas.map((e) => ({ vinculo: _rotulo(ROTULO_VINCULO_ACIDENTADO, e.entrevistado_vinculo), quando: e.realizada_em ? e.realizada_em.toISOString().slice(0, 10) : null })),
    evidencias: evidencias.map((e) => ({ descricao: e.descricao ?? "" })),
    plano: acoes.map((a) => ({
      numero: a.numero,
      acao: a.acao,
      tipo: _rotulo(ROTULO_TIPO_ACAO, a.tipo_acao)!,
      responsavel: a.responsavel_nome ?? a.unidade_nome ?? a.responsavel_texto ?? "quem conduz o caso",
      prazo: a.prazo,
      estado: _rotulo(ROTULO_ESTADO_ACAO, a.estado)!,
    })),
  };
}

/** O resumo de saúde (nível 1) de cada acidentado, lido pela porta única — cada leitura fica registrada. */
async function _saude_do_caso(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia): Promise<NonNullable<ContextoRelatorio["saude"]>> {
  const { acidentados } = await comunicacao.envolvidos_de(tx, ocorrencia.id);
  const saida: NonNullable<ContextoRelatorio["saude"]> = [];
  for (const a of acidentados) {
    const l = await saude.ler(tx, usuario, ocorrencia, a.id, 1, FINALIDADE_DO_RELATORIO);
    if (!l.existe) continue;
    saida.push({
      ordem: a.ordem,
      natureza: l.natureza,
      partes: l.partes,
      lateralidade: _rotulo(ROTULO_LATERALIDADE, l.lateralidade),
      fatos: (
        [
          ["Atendimento", l.fatos.houve_atendimento],
          ["Afastamento", l.fatos.houve_afastamento],
          ["Internação", l.fatos.houve_internacao],
          ["Óbito", l.fatos.houve_obito],
          ["Sequela", l.fatos.houve_sequela],
        ] as [string, string | null][]
      )
        .filter(([, v]) => v !== null)
        .map(([r, v]) => [r, _rotulo(ROTULO_SIM_NAO_NAO_SEI, v)!]),
    });
  }
  return saida;
}

export async function versoes(tx: Executor, ocorrencia_id: number) {
  const linhas = await tx
    .select({
      id: acidente_relatorio.id,
      versao: acidente_relatorio.versao,
      variante: acidente_relatorio.variante,
      hash_conteudo: acidente_relatorio.hash_conteudo,
      anexo_id: acidente_relatorio.anexo_id,
      motivo_retificacao: acidente_relatorio.motivo_retificacao,
      substitui_id: acidente_relatorio.substitui_id,
      emitido_em: acidente_relatorio.emitido_em,
      emitido_por: tabela_usuario.nome,
    })
    .from(acidente_relatorio)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, acidente_relatorio.emitido_por))
    .where(eq(acidente_relatorio.ocorrencia_id, ocorrencia_id))
    .orderBy(desc(acidente_relatorio.versao), asc(acidente_relatorio.variante));
  const substituidos = new Set(linhas.map((l) => l.substitui_id).filter((v): v is number => v !== null));
  return linhas.map((l) => ({ ...l, retificada: substituidos.has(l.id) }));
}

async function _emitir(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  retificacao: { motivo: string; anteriores: Relatorio[] } | null,
): Promise<Relatorio[]> {
  const [ultima] = await tx
    .select({ versao: acidente_relatorio.versao })
    .from(acidente_relatorio)
    .where(eq(acidente_relatorio.ocorrencia_id, ocorrencia.id))
    .orderBy(desc(acidente_relatorio.versao))
    .limit(1);
  const maior = ultima?.versao ?? 0;
  const versao = maior + 1;
  const base = await _contexto_base(
    tx,
    ocorrencia,
    versao,
    usuario,
    retificacao ? { motivo: retificacao.motivo, substitui_versao: retificacao.anteriores[0]!.versao } : null,
  );
  const contextos: Record<Variante, ContextoRelatorio> = {
    SEM_SAUDE: { ...base, variante: "SEM_SAUDE" },
    COMPLETA: { ...base, variante: "COMPLETA", saude: await _saude_do_caso(tx, usuario, ocorrencia) },
  };
  const criados: Relatorio[] = [];
  for (const variante of VARIANTES_RELATORIO) {
    const contexto = contextos[variante];
    const hash = hash_do_contexto(contexto);
    const pdf = await gerar_pdf(contexto, hash);
    const r = await anexos.guardar(tx, {
      entidade: ENTIDADE,
      entidade_id: ocorrencia.id,
      nome_original: `relatorio-${ocorrencia.protocolo}-v${versao}-${variante === "COMPLETA" ? "completa" : "sem-saude"}.pdf`,
      conteudo: pdf,
      mime_type: "application/pdf",
      categoria: "RELATORIO_INVESTIGACAO",
      usuario,
    });
    const [linha] = await tx
      .insert(acidente_relatorio)
      .values({
        ocorrencia_id: ocorrencia.id,
        versao,
        variante,
        contexto_congelado: contexto,
        hash_conteudo: hash,
        anexo_id: r.anexo.id,
        motivo_retificacao: retificacao?.motivo ?? null,
        substitui_id: retificacao?.anteriores.find((a) => a.variante === variante)?.id ?? null,
        emitido_por: usuario.id,
      })
      .returning();
    criados.push(linha!);
  }
  // o que o relatório cita deixa de ser descartável (retenção)
  await tx.update(acidente_evidencia).set({ citada_no_relatorio: true }).where(eq(acidente_evidencia.ocorrencia_id, ocorrencia.id));
  return criados;
}

/** Emite a versão 1 (as duas variantes) e leva o caso de EM_INVESTIGACAO a RELATORIO_EMITIDO. */
export async function emitir(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, versao_ocorrencia: number): Promise<Relatorio[]> {
  usuario.exigir("acidente.relatorio_emitir");
  usuario.exigir("acidente.saude_ver");
  if (ocorrencia.estado !== "EM_INVESTIGACAO") {
    throw new RelatorioRecusado(
      ocorrencia.estado === "RELATORIO_EMITIDO" || ocorrencia.estado === "ENCAMINHADA_SIASS" || ocorrencia.estado === "CONCLUIDA"
        ? "O relatório deste caso já foi emitido: para mudar, retifique."
        : "O relatório só se emite com o caso em investigação.",
    );
  }
  const inv = await investigacao.obter(tx, ocorrencia);
  if (!inv.sintese?.trim()) throw new RelatorioRecusado("Preencha a síntese explicativa na Investigação antes de emitir o relatório.");
  if (!inv.caracterizacao) throw new RelatorioRecusado("Diga na Investigação se o evento se caracteriza como acidente em serviço antes de emitir o relatório.");
  const criados = await _emitir(tx, usuario, ocorrencia, null);

  exigir_transicao_acidente(ocorrencia.estado, "RELATORIO_EMITIDO");
  const [nova] = await tx
    .update(acidente_ocorrencia)
    .set({ estado: "RELATORIO_EMITIDO", versao: versao_ocorrencia + 1 })
    .where(and(eq(acidente_ocorrencia.id, ocorrencia.id), eq(acidente_ocorrencia.versao, versao_ocorrencia)))
    .returning();
  if (!nova) {
    throw new RelatorioRecusado(`${ocorrencia.protocolo} foi alterada por outra pessoa depois que você abriu a tela. Recarregue a ficha e refaça.`);
  }
  Object.assign(ocorrencia, nova);
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.chave, `ACIDENTE_INVESTIGAR:${ocorrencia.id}`), eq(tabela_pendencia.concluida, false)));
  if (p) await pendencias.concluir(tx, p, usuario);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ESTADO_ALTERADO,
    descricao: `${ocorrencia.protocolo}: situação EM_INVESTIGACAO → RELATORIO_EMITIDO.`,
    campo: "estado",
    valor_anterior: "EM_INVESTIGACAO",
    valor_novo: "RELATORIO_EMITIDO",
    usuario,
  });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_RELATORIO_EMITIDO,
    descricao: `${ocorrencia.protocolo}: relatório versão 1 emitido (completa e sem saúde).`,
    usuario,
  });
  return criados;
}

/** Emite a versão seguinte (as duas variantes), com motivo; o estado do caso não muda. */
export async function retificar(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, motivo: string | null): Promise<Relatorio[]> {
  usuario.exigir("acidente.relatorio_emitir");
  usuario.exigir("acidente.saude_ver");
  if (!RETIFICAVEIS.includes(ocorrencia.estado)) {
    throw new RelatorioRecusado(
      ocorrencia.estado === "CONCLUIDA" ? "O caso está concluído: o relatório não se retifica mais." : "Só se retifica um relatório já emitido.",
    );
  }
  const porque = (motivo ?? "").trim();
  if (porque.length < 10) throw new RelatorioRecusado("Diga o motivo da retificação (pelo menos uma frase).");
  if (porque.length > 2000) throw new RelatorioRecusado("O motivo da retificação passa de 2.000 caracteres.");
  const todas = await tx.select().from(acidente_relatorio).where(eq(acidente_relatorio.ocorrencia_id, ocorrencia.id));
  const ultima = Math.max(...todas.map((r) => r.versao));
  const anteriores = todas.filter((r) => r.versao === ultima);
  const criados = await _emitir(tx, usuario, ocorrencia, { motivo: porque, anteriores });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_RELATORIO_RETIFICADO,
    descricao: `${ocorrencia.protocolo}: relatório retificado (versão ${criados[0]!.versao} no lugar da ${ultima}). Motivo: ${porque}`,
    usuario,
  });
  return criados;
}

/** O PDF de uma versão e variante, pela porta dos anexos (escopo, saúde para a completa, leitura registrada). */
export async function baixar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  versao: number,
  variante: string,
): Promise<{ nome: string; bytes: Uint8Array }> {
  if (!(VARIANTES_RELATORIO as readonly string[]).includes(variante)) throw new RelatorioInexistente("Variante desconhecida.");
  const [r] = await tx
    .select()
    .from(acidente_relatorio)
    .where(and(eq(acidente_relatorio.ocorrencia_id, ocorrencia.id), eq(acidente_relatorio.versao, versao), eq(acidente_relatorio.variante, variante)));
  if (!r) throw new RelatorioInexistente("Relatório não encontrado neste caso.");
  const [anexo] = await tx.select().from(tabela_anexo).where(eq(tabela_anexo.id, r.anexo_id));
  await anexo_acesso.liberar(tx, usuario, anexo);
  return { nome: anexo!.nome_original, bytes: await anexos.ler_conteudo(anexo!) };
}

/** O texto do relatório de uma versão, para conferir sem abrir o PDF. */
export function texto_do_relatorio(r: Pick<Relatorio, "contexto_congelado">): string {
  return texto_plano(r.contexto_congelado as ContextoRelatorio);
}
