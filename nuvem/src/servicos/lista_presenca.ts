/**
 * A lista de presença da turma em .docx — a folha que vai ao campo para
 * assinar. Porte de `app/servicos/lista_presenca.py`.
 *
 * Reaproveita o mecanismo de documento que já existe
 * (`documento.renderizar_modelo`): um segundo mecanismo seria um segundo lugar
 * para o hash de integridade divergir.
 *
 * **A folha é regerada a cada pedido, de propósito.** Ela não congela nada:
 * quem entra na turma na véspera precisa estar na lista. O congelamento (RN-15)
 * é do certificado, que é o documento que circula.
 */
import type { Executor } from "../db/cliente.js";
import { Inscricao as I, ROTULO_VINCULO, Turma as T } from "../dominio/treinamento.js";
import { AssinaturaInstrutor } from "../dominio/treinamento.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import { setor_emissor_vigente } from "./parecer.js";
import { nome_exibicao } from "./participante.js";
import { numero } from "./presenca.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import { inscricoes_da_turma, type TurmaCarregada } from "./turma.js";

// v2: o v1 com a marca da Sisa no cabeçalho do Word, que repete em toda folha.
// A folha não congela nada (ver acima): não há lista antiga a reimprimir no
// v1. Ele continua em `app/templates/` porque é o do sistema da rede
export const MODELO = "lista_presenca_v2.docx";
// v3: A4 em retrato, com horário, uma coluna de assinatura por dia (até 5),
// linhas em branco, observações e rodapé com a página. Há um arquivo por
// quantidade de colunas (`lista_presenca_v3_d1` … `_d5`), gerado por
// `ferramentas/gerar-lista-presenca-v3.mjs`; a turma de mais dias usa o d5 com
// o cabeçalho das datas em branco, para preencher à mão.
export const MAX_DIAS = 5;
export const LINHAS_EM_BRANCO = 5;

export function modelo_da_turma(dias: number): string {
  return `lista_presenca_v3_d${Math.min(Math.max(dias, 1), MAX_DIAS)}.docx`;
}

/** Os dias da turma, de `data_inicio` a `data_fim`, como dd/mm. */
export function dias_da_turma(turma: { data_inicio: string; data_fim: string }): string[] {
  const dias: string[] = [];
  const fim = new Date(`${turma.data_fim}T12:00:00Z`);
  for (let d = new Date(`${turma.data_inicio}T12:00:00Z`); d <= fim && dias.length <= 400; d = new Date(d.getTime() + 86400000)) {
    dias.push(datas_br.numerica(d.toISOString().slice(0, 10)).slice(0, 5));
  }
  return dias;
}

function _horario(turma: TurmaCarregada): string {
  const corta = (h: string | null | undefined) => (h ? h.slice(0, 5) : null);
  const ini = corta(turma.hora_inicio);
  const fim = corta(turma.hora_fim);
  return ini && fim ? `${ini} às ${fim}` : "—";
}
export const SUBPASTA = "listas_presenca";
export const LISTA_GERADA = "LISTA_PRESENCA_GERADA";
export const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * `documentos/listas_presenca/{ano}/Lista_Presenca_TUR-2026-0001.docx` — a chave
 * no armazenamento. O código entra inteiro, com os hífens: é por ele que alguém
 * procura a folha.
 */
export function caminho_saida(turma: { ano: number; codigo: string }): string {
  const seguro = textos.slug_ascii(turma.codigo.replaceAll("-", "_")).replaceAll("_", "-");
  return `documentos/${SUBPASTA}/${turma.ano}/Lista_Presenca_${seguro}.docx`;
}

function _periodo(turma: TurmaCarregada): string {
  if (turma.data_inicio === turma.data_fim) return datas_br.numerica(turma.data_inicio);
  return `${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}`;
}

/**
 * O dicionário que o modelo consome. Só entra quem ocupa vaga: cancelada não
 * assina folha nenhuma.
 */
export async function montar_contexto(tx: Executor, turma: TurmaCarregada): Promise<Record<string, unknown>> {
  const setor = await setor_emissor_vigente(tx, turma.data_inicio);
  const participantes = (await inscricoes_da_turma(tx, turma))
    .filter((i) => I.ocupa_vaga(i))
    .map((inscricao, n) => ({
      ordem: n + 1,
      nome: nome_exibicao(inscricao.participante),
      identificador: inscricao.participante.identificador_publico,
      vinculo: ROTULO_VINCULO[inscricao.participante.vinculo] ?? inscricao.participante.vinculo,
    }));
  const instrutores = turma.instrutores.map(
    (v) => AssinaturaInstrutor.nome_exibicao(v.instrutor) + (v.instrutor.titulo ? ` — ${v.instrutor.titulo}` : ""),
  );
  const dias = dias_da_turma(turma);
  const cabecalhos = Object.fromEntries(
    Array.from({ length: MAX_DIAS }, (_, i) => [`d${i + 1}`, dias.length <= MAX_DIAS ? (dias[i] ?? "") : "Data: ____"]),
  );
  const extras = Array.from({ length: LINHAS_EM_BRANCO }, (_, n) => ({
    ordem: participantes.length + n + 1,
    nome: "",
    identificador: "",
    vinculo: "",
  }));
  return {
    ...cabecalhos,
    horario: _horario(turma),
    extras,
    dias_total: dias.length,
    setor_sigla: setor ? setor.sigla_composta : "",
    setor_nome: setor ? setor.nome_extenso : "",
    cidade: setor ? setor.cidade : "",
    turma_codigo: turma.codigo,
    treinamento: turma.treinamento.nome,
    periodo: _periodo(turma),
    carga_horaria: `${numero(T.carga_efetiva(turma))} horas`,
    local: turma.local || "—",
    campus: turma.campus ? turma.campus.nome : "—",
    unidade_promotora: turma.unidade_promotora ? turma.unidade_promotora.nome_extenso : "—",
    // instrutor de turma são vários e cada um vai numa linha da mesma célula
    instrutores: documento.rich_multilinha(instrutores.join("\n")) ?? "—",
    frequencia_minima: `${numero(turma.frequencia_minima_percentual)}%`,
    nota_minima: turma.nota_minima_aprovacao !== null ? numero(turma.nota_minima_aprovacao) : "não avalia por nota",
    participantes,
    total: participantes.length,
    gerada_em: datas_br.numerica(datas_br.hoje()),
  };
}

/**
 * Grava a folha e registra a geração na trilha: a folha sai do sistema com nome
 * de gente dentro.
 */
export async function gerar(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada) {
  usuario.exigir("turma.avaliar");
  const contexto = await montar_contexto(tx, turma);
  const resultado = await documento.renderizar_modelo(modelo_da_turma(dias_da_turma(turma).length), contexto, { destino: caminho_saida(turma) });
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: LISTA_GERADA,
    descricao:
      `${turma.codigo}: lista de presença com ${contexto.total} ` +
      `participante(s) · ${resultado.hash_conteudo.slice(0, 12)}`,
    usuario,
  });
  return resultado;
}
