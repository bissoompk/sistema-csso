/**
 * A investigação do acidente pelo método MAPA (fatia F4): os campos do modelo
 * de análise, a linha do tempo estruturada e as barreiras.
 *
 * - **Quando se edita.** Na triagem e na investigação; depois do relatório
 *   emitido (e no caso encerrado) a investigação trava — mudar o que o relatório
 *   disse é retificar o relatório (F6), não editar a análise por baixo dele.
 * - **Controle otimista.** O "Salvar" leva a `versao` que a tela leu; se outra
 *   pessoa salvou no meio, nada é gravado e a tela mostra o que está gravado ao
 *   lado do que foi digitado (`InvestigacaoAlterada`, 409). No legado o
 *   autosave sobrescrevia o colega a cada 2,5 s, e cada autosave virava uma
 *   linha de auditoria.
 * - **Diff na trilha.** Cada campo que mudou vira um evento com antes e depois
 *   (`registrar_diferencas`), num salvamento só.
 * - **Texto.** Os campos narrativos passam pelo filtro de saúde no contexto de
 *   nexo ocupacional e recusam CPF: a análise fala do trabalho, não do corpo.
 * - Linha do tempo e barreiras se DESATIVAM, nunca se apagam.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_barreira, acidente_evento_linha, acidente_investigacao, acidente_ocorrencia } from "../db/esquema/index.js";
import { CARACTERIZACAO, SIM_NAO_NAO_SEI, SITUACOES_BARREIRA, TIPOS_BARREIRA } from "../dominio/acidente.js";
import { RegraViolada } from "../nucleo/erros.js";
import { ComunicacaoRecusada, type Ocorrencia } from "./acidente_comunicacao.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export type Investigacao = typeof acidente_investigacao.$inferSelect;

/** Outra pessoa salvou a investigação depois que a tela foi aberta. */
export class InvestigacaoAlterada extends RegraViolada {
  constructor(
    mensagem: string,
    public gravada: Investigacao,
  ) {
    super(mensagem);
  }
}

/** Em que estados a análise se edita: antes do relatório. */
export const ESTADOS_EDITAVEIS: readonly string[] = ["EM_TRIAGEM", "EM_INVESTIGACAO"];

/** Os campos de texto do MAPA, na ordem da tela, com o rótulo e a ajuda (`ui.info`). */
export const CAMPOS_TEXTO: readonly (readonly [string, string, string])[] = [
  ["objetivo", "Objetivo da análise", "O que esta análise quer entender e para quem ela serve (a perícia, a unidade, a prevenção)."],
  ["equipe", "Equipe da análise", "Quem conduz e quem participa: segurança do trabalho, chefia, trabalhadores do setor."],
  ["trabalho_habitual", "Trabalho habitual", "Como a tarefa costuma ser feita no dia a dia, quando dá certo: quem faz, com o quê, em que ritmo."],
  ["prescrito_real", "Prescrito e real", "A diferença entre o que está escrito (procedimento, ordem de serviço) e o que se faz de fato, e por quê."],
  ["mudanca_individuo", "Mudanças no indivíduo", "O que estava diferente na pessoa naquele dia em relação ao habitual: experiência na tarefa, cansaço, troca de função. Sem diagnóstico."],
  ["mudanca_tarefa", "Mudanças na tarefa", "O que mudou no jeito de fazer: urgência, improviso, etapa a mais ou a menos."],
  ["mudanca_material", "Mudanças no material", "Ferramenta, equipamento, máquina ou produto diferente do habitual, com defeito ou sem manutenção."],
  ["mudanca_meio", "Mudanças no meio", "O ambiente: piso, iluminação, ruído, clima, arranjo físico, presença de outras equipes."],
  ["relatos_campo", "Relatos de campo", "O que se viu e ouviu na visita ao local. O relato de cada entrevista fica na aba Entrevistas."],
  ["evidencias_texto", "Evidências", "Documentos, medições e registros que sustentam a análise (os arquivos ficam na aba Entrevistas e evidências)."],
  ["sintese", "Síntese explicativa", "A explicação do acidente que junta os achados: como as mudanças e as barreiras levaram ao evento."],
  ["ampliacao_conceitual", "Ampliação conceitual", "Os fatores da organização do trabalho por trás do evento: gestão, planejamento, recursos, cultura."],
  ["recomendacoes", "Recomendações e observações", "O que se recomenda para não repetir. As ações com responsável e prazo vão para o plano de ação."],
] as const;

/** Os três SIM/NÃO da conclusão técnica. */
export const CAMPOS_ESCOLHA: readonly (readonly [string, string, readonly string[]])[] = [
  ["ambiente_fator", "O ambiente de trabalho foi fator do acidente?", SIM_NAO_NAO_SEI],
  ["caracterizacao", "Caracterizado como acidente em serviço (parecer da SST)?", CARACTERIZACAO],
  ["requer_cat_siass", "Requer abertura da CAT/SP no SIASS?", SIM_NAO_NAO_SEI],
] as const;

const TAMANHO_CAMPO = 8000;
const TAMANHO_CURTO = 1000;

export type DadosInvestigacao = Partial<Record<string, string | null>>;

function _exigir_editavel(usuario: UsuarioAtual, ocorrencia: Ocorrencia): void {
  usuario.exigir("acidente.investigar");
  if (!ESTADOS_EDITAVEIS.includes(ocorrencia.estado)) {
    throw new RegraViolada(
      `A investigação de ${ocorrencia.protocolo} está travada: ` +
        (["RELATORIO_EMITIDO", "ENCAMINHADA_SIASS", "CONCLUIDA"].includes(ocorrencia.estado)
          ? "o relatório já foi emitido. Mudar o que ele diz é retificar o relatório."
          : "a ocorrência não está em triagem nem em investigação."),
    );
  }
}

function _texto(valor: string | null | undefined, rotulo: string, maximo = TAMANHO_CAMPO): string | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  if (v.length > maximo) throw new ComunicacaoRecusada(`O campo ${rotulo} passa de ${maximo} caracteres.`, rotulo);
  if (/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(v)) {
    throw new ComunicacaoRecusada(`O campo ${rotulo} tem um número com formato de CPF. CPF não entra na investigação.`, rotulo);
  }
  try {
    textos.exigir_texto_limpo(v, rotulo, textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new ComunicacaoRecusada(
      `O campo ${rotulo} tem termo de saúde ou dado sensível (${textos.termos_proibidos_em(v, textos.CONTEXTO_NEXO_OCUPACIONAL).join(", ")}). ` +
        "A análise descreve o trabalho, o material e o meio; a saúde é do médico do trabalho, em campo próprio.",
      rotulo,
    );
  }
  return v;
}

/** A investigação da ocorrência; nasce na primeira leitura, com quem conduz o caso. */
export async function obter(tx: Executor, ocorrencia: Ocorrencia): Promise<Investigacao> {
  const [atual] = await tx.select().from(acidente_investigacao).where(eq(acidente_investigacao.ocorrencia_id, ocorrencia.id));
  if (atual) return atual;
  const [nova] = await tx
    .insert(acidente_investigacao)
    .values({ ocorrencia_id: ocorrencia.id, responsavel_id: ocorrencia.responsavel_id })
    .onConflictDoNothing()
    .returning();
  if (nova) return nova;
  const [corrida] = await tx.select().from(acidente_investigacao).where(eq(acidente_investigacao.ocorrencia_id, ocorrencia.id));
  return corrida!;
}

/** Salva os campos do MAPA com a versão lida; devolve a linha nova. */
export async function salvar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  dados: DadosInvestigacao,
  versao_lida: number,
): Promise<Investigacao> {
  _exigir_editavel(usuario, ocorrencia);
  const atual = await obter(tx, ocorrencia);
  const depois: Record<string, string | null> = {};
  for (const [campo, rotulo] of CAMPOS_TEXTO) depois[campo] = _texto(dados[campo], rotulo.toLowerCase());
  for (const [campo, rotulo, lista] of CAMPOS_ESCOLHA) {
    const v = (dados[campo] ?? "").trim();
    if (v && !lista.includes(v)) throw new ComunicacaoRecusada(`Escolha na lista: ${rotulo}`, rotulo);
    depois[campo] = v || null;
  }
  const antes: Record<string, string | null> = {};
  for (const campo of Object.keys(depois)) antes[campo] = (atual as Record<string, unknown>)[campo] as string | null;
  const [gravada] = await tx
    .update(acidente_investigacao)
    .set({ ...depois, versao: versao_lida + 1, atualizado_por: usuario.id, atualizado_em: new Date() })
    .where(and(eq(acidente_investigacao.ocorrencia_id, ocorrencia.id), eq(acidente_investigacao.versao, versao_lida)))
    .returning();
  if (!gravada) {
    throw new InvestigacaoAlterada(
      `A investigação de ${ocorrencia.protocolo} foi salva por outra pessoa depois que você abriu a tela. ` +
        "Nada do que você digitou foi gravado: compare com o que está salvo, ajuste e salve de novo.",
      atual,
    );
  }
  await auditoria.registrar_diferencas(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    antes,
    depois,
    usuario,
    tipo_evento: auditoria.ACIDENTE_INVESTIGACAO_SALVA,
    so_o_campo: true,
  });
  return gravada;
}

// ---------------------------------------------------------------------
// Linha do tempo e barreiras
// ---------------------------------------------------------------------
export async function linha_do_tempo(tx: Executor, ocorrencia_id: number) {
  return tx
    .select()
    .from(acidente_evento_linha)
    .where(and(eq(acidente_evento_linha.ocorrencia_id, ocorrencia_id), eq(acidente_evento_linha.ativo, true)))
    .orderBy(asc(acidente_evento_linha.ordem), asc(acidente_evento_linha.id));
}

export async function barreiras(tx: Executor, ocorrencia_id: number) {
  return tx
    .select()
    .from(acidente_barreira)
    .where(and(eq(acidente_barreira.ocorrencia_id, ocorrencia_id), eq(acidente_barreira.ativo, true)))
    .orderBy(asc(acidente_barreira.tipo), asc(acidente_barreira.id));
}

export async function acrescentar_evento(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  d: { momento: string; descricao: string },
): Promise<void> {
  _exigir_editavel(usuario, ocorrencia);
  const momento = (d.momento ?? "").trim();
  if (!momento || momento.length > 40) {
    throw new ComunicacaoRecusada("Diga quando: a hora (09:40) ou o momento relativo (T-10min, véspera).", "o momento");
  }
  const descricao = _texto(d.descricao, "o que aconteceu neste momento", TAMANHO_CURTO);
  if (!descricao) throw new ComunicacaoRecusada("Descreva o que aconteceu neste momento.", "o que aconteceu");
  const atuais = await linha_do_tempo(tx, ocorrencia.id);
  await tx.insert(acidente_evento_linha).values({ ocorrencia_id: ocorrencia.id, momento, descricao, ordem: atuais.length + 1 });
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_INVESTIGACAO_SALVA,
    descricao: `${ocorrencia.protocolo}: momento acrescentado à linha do tempo (${momento}).`,
    usuario,
  });
}

export async function acrescentar_barreira(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  d: { tipo: string; situacao: string; descricao: string },
): Promise<void> {
  _exigir_editavel(usuario, ocorrencia);
  if (!(TIPOS_BARREIRA as readonly string[]).includes(d.tipo)) {
    throw new ComunicacaoRecusada("Escolha o tipo da barreira na lista.", "o tipo da barreira");
  }
  if (!(SITUACOES_BARREIRA as readonly string[]).includes(d.situacao)) {
    throw new ComunicacaoRecusada("Diga se a barreira existia e funcionou, existia e falhou, ou estava ausente.", "a situação");
  }
  const descricao = _texto(d.descricao, "a barreira", TAMANHO_CURTO);
  if (!descricao) throw new ComunicacaoRecusada("Descreva a barreira.", "a barreira");
  await tx.insert(acidente_barreira).values({ ocorrencia_id: ocorrencia.id, tipo: d.tipo, situacao: d.situacao, descricao });
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_INVESTIGACAO_SALVA,
    descricao: `${ocorrencia.protocolo}: barreira ${d.tipo} (${d.situacao}) acrescentada.`,
    usuario,
  });
}

/** Desativa um momento da linha do tempo ou uma barreira — nunca apaga. */
export async function desativar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  qual: "linha" | "barreira",
  id: number,
): Promise<void> {
  _exigir_editavel(usuario, ocorrencia);
  const tabela = qual === "linha" ? acidente_evento_linha : acidente_barreira;
  const r = await tx
    .update(tabela)
    .set({ ativo: false })
    .where(and(eq(tabela.id, id), eq(tabela.ocorrencia_id, ocorrencia.id), eq(tabela.ativo, true)))
    .returning({ id: tabela.id });
  if (!r.length) return;
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_INVESTIGACAO_SALVA,
    descricao: `${ocorrencia.protocolo}: ${qual === "linha" ? "momento da linha do tempo" : "barreira"} desativado (registro mantido).`,
    usuario,
  });
}

/** A ocorrência travada para edição? (a tela mostra só leitura) */
export function editavel(ocorrencia: Pick<typeof acidente_ocorrencia.$inferSelect, "estado">): boolean {
  return ESTADOS_EDITAVEIS.includes(ocorrencia.estado);
}
