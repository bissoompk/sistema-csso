/**
 * O auxílio à análise do acidente (fatia 5): o que falta, o que não fecha e o
 * próximo passo, por REGRAS DETERMINÍSTICAS (D2: sem IA nem API externa, ROPA
 * §5.1). Aponta; não decide nada nem grava nada.
 *
 * Só lê o que a ficha sem saúde já mostra e a PRESENÇA (sim/não) de identificação
 * e saúde, por `presenca` de cada serviço — nunca o conteúdo, e por isso não
 * grava acesso sensível. Quem vê a análise é quem investiga (`acidente.investigar`).
 *
 * `avaliar` é pura (recebe os fatos já lidos) para os testes cobrirem cada regra.
 * Os itens com asterisco do Anexo III viram LACUNA; o que a perícia do SIASS
 * pede e ainda não há vira PRÓXIMO PASSO.
 */
import { and, count, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_agente_causador, acidente_barreira, acidente_checklist_item, acidente_entrevista, acidente_evidencia, acidente_investigacao } from "../db/esquema/index.js";
import { ROTULO_TIPO_ACAO } from "../dominio/acidente.js";
import { AVISO_SUGESTAO, familia_do_agente, sugestoes_faltantes } from "../dominio/acidente_sugestoes.js";
import { hoje_iso } from "../dominio/datas.js";
import { pode_ver_restrita_sst } from "./acidente_acesso.js";
import * as comunicacao from "./acidente_comunicacao.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import * as acao from "./acidente_acao.js";
import * as identificacao from "./acidente_identificacao.js";
import { CAMPOS_TEXTO } from "./acidente_investigacao.js";
import * as saude from "./acidente_saude.js";
import * as siass from "./acidente_siass.js";
import type { UsuarioAtual } from "./rbac.js";

export type NivelApontamento = "INCONSISTENCIA" | "LACUNA" | "ATENCAO" | "PROXIMO_PASSO";
export interface Apontamento {
  nivel: NivelApontamento;
  texto: string;
  /** a aba da ficha onde se resolve */
  aba: string;
}

export const ROTULO_NIVEL: Record<NivelApontamento, string> = {
  INCONSISTENCIA: "Não fecha",
  LACUNA: "Falta (Anexo III)",
  ATENCAO: "Atenção",
  PROXIMO_PASSO: "Próximo passo",
};
const ORDEM: NivelApontamento[] = ["INCONSISTENCIA", "LACUNA", "ATENCAO", "PROXIMO_PASSO"];

export interface FatosAnalise {
  hoje: string;
  /** o agente causador escolhido (número na Tabela II e rótulo), para as sugestões por família */
  agente?: { ordem: number; rotulo: string } | null;
  /** os tipos de ação que o plano já tem (sem as canceladas) */
  tipos_de_acao?: readonly string[];
  oc: Pick<
    Ocorrencia,
    | "especie" | "estado" | "data_evento" | "hora_evento" | "minutos_apos_inicio_jornada" | "ultimo_dia_trabalho" | "local_municipio" | "local_uf"
    | "local_cnpj_contratada" | "transito_registro_policial" | "agente_causador_id" | "agente_doenca_id" | "situacao_geradora_id"
    | "prazo_comunicacao" | "prazo_prorrogado_ate" | "criado_em"
  >;
  acidentados: {
    ordem: number;
    vinculo: string;
    empresa_contratada: string | null;
    houve_lesao: string | null;
    menor_de_idade: boolean;
    responsavel_legal_solicitado: boolean;
    tem_identificacao: boolean;
    saude: { confirmada: boolean; com_partes: boolean } | null;
  }[];
  testemunhas: { total: number; com_contato: number };
  investigacao: { campos_preenchidos: number; campos_total: number };
  contagens: { entrevistas: number; barreiras: number; evidencias: number; checklist_marcados: number; acoes: number; acoes_vencidas: number };
  relatorios: number;
  encaminhamentos: number;
  decisoes: number;
}

const DIA = 86_400_000;
const _dias = (de: string, ate: string) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA);

export function avaliar(f: FatosAnalise): Apontamento[] {
  const r: Apontamento[] = [];
  const add = (nivel: NivelApontamento, aba: string, texto: string) => r.push({ nivel, aba, texto });
  const { oc } = f;
  const aberto = !["CONCLUIDA", "CANCELADA"].includes(oc.estado);

  // --- o que o Anexo III pede com asterisco e a comunicação deixou em branco ---
  if (!oc.hora_evento) add("LACUNA", "comunicacao", "Hora do acidente não informada.");
  if (oc.especie === "TIPICO" && oc.minutos_apos_inicio_jornada === null) add("LACUNA", "comunicacao", "Após quantas horas de trabalho o acidente ocorreu: não informado.");
  if (!oc.local_municipio || !oc.local_uf) add("LACUNA", "comunicacao", "Município e UF do local do acidente: informar.");
  if (oc.situacao_geradora_id === null) add("LACUNA", "comunicacao", "Situação geradora (Tabela IV) não escolhida.");
  if ((oc.especie === "TIPICO" || oc.especie === "TRAJETO") && oc.agente_causador_id === null) add("LACUNA", "comunicacao", "Agente causador do acidente (Tabela II) não escolhido.");
  if (oc.especie === "DOENCA_TRABALHO" && oc.agente_doenca_id === null) add("LACUNA", "comunicacao", "Agente causador da doença (Tabela III) não escolhido.");
  if (oc.especie === "DOENCA_TRABALHO" && !oc.ultimo_dia_trabalho) add("LACUNA", "comunicacao", "Último dia trabalhado não informado (a doença pede).");
  if (oc.especie === "TRAJETO" && !oc.transito_registro_policial) add("LACUNA", "comunicacao", "Houve registro policial? Acidente de trajeto pede a resposta.");
  if (f.acidentados.some((a) => a.empresa_contratada) && !oc.local_cnpj_contratada) add("LACUNA", "comunicacao", "Há empresa contratada, mas o CNPJ dela não foi informado.");
  for (const a of f.acidentados) {
    const quem = `Envolvido nº ${a.ordem}`;
    if (!a.tem_identificacao) add("LACUNA", "identificacao", `${quem}: identificação pessoal do Anexo III (CPF, nascimento, endereço…) ainda não informada.`);
    if (a.houve_lesao === "SIM" && !a.saude) add("LACUNA", "saude", `${quem}: houve lesão, mas a saúde ainda não foi registrada.`);
    if (a.saude && !a.saude.confirmada) add("ATENCAO", "saude", `${quem}: a saúde é só a declaração do comunicante; falta o médico confirmar ou corrigir.`);
    if (a.saude && !a.saude.com_partes) add("LACUNA", "saude", `${quem}: nenhuma parte do corpo (Tabela I) escolhida.`);
    if (a.menor_de_idade && !a.responsavel_legal_solicitado) add("ATENCAO", "envolvidos", `${quem} é menor de idade: pedir o responsável legal.`);
    if (a.vinculo === "TERCEIRIZADO" && !a.empresa_contratada) add("ATENCAO", "envolvidos", `${quem} é terceirizado sem empresa contratada informada.`);
  }
  if (f.testemunhas.total > f.testemunhas.com_contato) add("LACUNA", "identificacao", `${f.testemunhas.total - f.testemunhas.com_contato} testemunha(s) sem endereço e telefone (Anexo III).`);

  // --- o que não fecha entre si ---
  if (oc.especie === "TIPICO" && oc.agente_doenca_id !== null) add("INCONSISTENCIA", "comunicacao", "Acidente típico com agente causador de DOENÇA (Tabela III): confira a espécie.");
  if (oc.especie === "DOENCA_TRABALHO" && oc.agente_causador_id !== null) add("INCONSISTENCIA", "comunicacao", "Doença relacionada ao trabalho com agente causador de ACIDENTE (Tabela II): confira a espécie.");
  if (oc.minutos_apos_inicio_jornada !== null && oc.minutos_apos_inicio_jornada > 1440) add("INCONSISTENCIA", "comunicacao", "Mais de 24 horas após o início da jornada: confira o campo.");
  if (oc.ultimo_dia_trabalho && oc.ultimo_dia_trabalho < oc.data_evento && oc.especie !== "DOENCA_TRABALHO") add("INCONSISTENCIA", "comunicacao", "O último dia trabalhado é anterior ao acidente.");

  // --- prazos ---
  const limite = oc.prazo_prorrogado_ate ?? oc.prazo_comunicacao;
  const criada = (oc.criado_em instanceof Date ? oc.criado_em.toISOString() : String(oc.criado_em)).slice(0, 10);
  if (criada > limite) add("ATENCAO", "comunicacao", `Comunicada ${_dias(limite, criada)} dia(s) depois do prazo do art. 214 (${limite.slice(8, 10)}/${limite.slice(5, 7)}/${limite.slice(0, 4)}): registre a justificativa.`);
  if (f.contagens.acoes_vencidas > 0) add("ATENCAO", "acoes", `${f.contagens.acoes_vencidas} ação(ões) do plano com o prazo vencido.`);

  // --- próximo passo, pelo estado ---
  if (oc.estado === "RECEBIDA" || oc.estado === "EM_TRIAGEM") add("PROXIMO_PASSO", "comunicacao", "Concluir a triagem: abrir a investigação ou pedir complementação à chefia.");
  if (oc.estado === "AGUARDANDO_COMPLEMENTACAO") add("PROXIMO_PASSO", "comunicacao", "Aguardando a resposta da chefia à complementação.");
  if (oc.estado === "EM_INVESTIGACAO") {
    const faltam = f.investigacao.campos_total - f.investigacao.campos_preenchidos;
    if (faltam > 0) add("PROXIMO_PASSO", "investigacao", `Preencher a análise (MAPA): faltam ${faltam} de ${f.investigacao.campos_total} campos.`);
    if (f.contagens.checklist_marcados === 0) add("PROXIMO_PASSO", "checklist", "Fazer a visita com o checklist: nenhum item marcado ainda.");
    if (f.contagens.entrevistas === 0) add("PROXIMO_PASSO", "entrevistas", "Registrar ao menos uma entrevista (com consentimento, se for gravar).");
    if (f.contagens.barreiras === 0) add("PROXIMO_PASSO", "investigacao", "Identificar as barreiras que existiam, falharam ou faltaram.");
    if (f.contagens.evidencias === 0) add("PROXIMO_PASSO", "entrevistas", "Juntar evidências (fotos do local, documentos, medições).");
    if (f.contagens.acoes === 0) add("PROXIMO_PASSO", "acoes", "Propor ações no plano, com responsável e prazo.");
    const familia = familia_do_agente(f.agente?.ordem);
    const faltantes = familia ? sugestoes_faltantes(familia, f.tipos_de_acao ?? []) : [];
    if (familia && faltantes.length) {
      const lista = faltantes.map((s) => `${ROTULO_TIPO_ACAO[s.tipo] ?? s.tipo} (${s.exemplo})`).join("; ");
      add("PROXIMO_PASSO", "acoes", `Agente «${f.agente!.rotulo}», família ${familia.rotulo.toLowerCase()}: o plano ainda não tem ação de ${lista}. ${AVISO_SUGESTAO}`);
    }
    if (faltam === 0 && f.contagens.acoes > 0) add("PROXIMO_PASSO", "relatorios", "A análise e o plano estão preenchidos: emitir o relatório.");
  }
  if (oc.estado === "RELATORIO_EMITIDO") add("PROXIMO_PASSO", "siass", "Encaminhar o relatório ao SIASS (CAT/SP no formato do Anexo III) ou concluir com o motivo.");
  if (oc.estado === "ENCAMINHADA_SIASS" && f.decisoes === 0) add("PROXIMO_PASSO", "siass", "Registrar a decisão pericial quando o SIASS responder (é ela que dá o nexo causal).");
  if (aberto && r.length === 0) add("PROXIMO_PASSO", "historico", "Nada a apontar agora.");

  return r.sort((a, b) => ORDEM.indexOf(a.nivel) - ORDEM.indexOf(b.nivel));
}

/** Lê os fatos do caso (sem conteúdo de saúde nem de identificação) e aplica as regras. */
export async function do_caso(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia): Promise<Apontamento[]> {
  if (!pode_ver_restrita_sst(usuario)) usuario.exigir("acidente.investigar");
  const { acidentados, testemunhas } = await comunicacao.envolvidos_de(tx, ocorrencia.id);
  const ids = acidentados.map((a) => a.id);
  const ident = await identificacao.presenca(tx, ocorrencia.id, ids);
  const sd = await saude.presenca(tx, ids);
  const [inv] = await tx.select().from(acidente_investigacao).where(eq(acidente_investigacao.ocorrencia_id, ocorrencia.id));
  const preenchidos = CAMPOS_TEXTO.filter(([campo]) => (((inv ?? {}) as Record<string, unknown>)[campo] as string | null | undefined)?.trim()).length;
  const n = async (tabela: typeof acidente_entrevista | typeof acidente_evidencia, onde = eq(tabela.ocorrencia_id, ocorrencia.id)) =>
    Number((await tx.select({ n: count() }).from(tabela).where(onde))[0]!.n);
  const [barreiras] = await tx.select({ n: count() }).from(acidente_barreira).where(and(eq(acidente_barreira.ocorrencia_id, ocorrencia.id), eq(acidente_barreira.ativo, true)));
  const [marcados] = await tx
    .select({ n: count() })
    .from(acidente_checklist_item)
    .where(and(eq(acidente_checklist_item.ocorrencia_id, ocorrencia.id), eq(acidente_checklist_item.ativo, true), eq(acidente_checklist_item.marcado, true)));
  const acoes = await acao.do_caso(tx, ocorrencia.id);
  const [agente] = ocorrencia.agente_causador_id
    ? await tx.select({ ordem: acidente_agente_causador.ordem, rotulo: acidente_agente_causador.rotulo }).from(acidente_agente_causador).where(eq(acidente_agente_causador.id, ocorrencia.agente_causador_id))
    : [];
  const situacao = await siass.situacao(tx, ocorrencia.id);
  return avaliar({
    hoje: hoje_iso(),
    agente: agente ?? null,
    tipos_de_acao: acoes.filter((a) => a.estado !== "CANCELADA").map((a) => a.tipo_acao),
    oc: ocorrencia,
    acidentados: acidentados.map((a) => ({
      ordem: a.ordem,
      vinculo: a.vinculo,
      empresa_contratada: a.empresa_contratada,
      houve_lesao: a.houve_lesao,
      menor_de_idade: a.menor_de_idade,
      responsavel_legal_solicitado: a.responsavel_legal_solicitado_em !== null,
      tem_identificacao: ident.com_identificacao.has(a.id),
      saude: sd.get(a.id) ?? null,
    })),
    testemunhas: { total: ident.testemunhas_total || testemunhas.length, com_contato: ident.testemunhas_com_contato },
    investigacao: { campos_preenchidos: preenchidos, campos_total: CAMPOS_TEXTO.length },
    contagens: {
      entrevistas: await n(acidente_entrevista),
      barreiras: Number(barreiras!.n),
      evidencias: await n(acidente_evidencia),
      checklist_marcados: Number(marcados!.n),
      acoes: acoes.length,
      acoes_vencidas: acoes.filter((a) => a.vencida).length,
    },
    relatorios: 0,
    encaminhamentos: situacao.encaminhamentos.length,
    decisoes: situacao.decisoes.length,
  });
}
