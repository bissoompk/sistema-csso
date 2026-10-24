/**
 * Avaliação de reação — a pesquisa de satisfação do fim da turma (24/10/2026).
 *
 * **O questionário é fixo no código** (`ITENS`, versão `VERSAO`): cinco itens
 * de 1 a 5, o "recomendaria a um colega?" e um comentário opcional. Mudar um
 * item é mudar a versão — a resposta guarda a dela, e o resultado de uma
 * versão não se mistura com o de outra sem alguém decidir isso.
 *
 * **Quem responde.** O inscrito que FREQUENTOU (ao menos um dia presente, e a
 * inscrição não está cancelada nem em análise), depois que a turma terminou
 * (concluída, ou `data_fim` já passou; nunca a cancelada), até `PRAZO_DIAS`
 * depois do fim. Uma resposta por inscrição. Dois caminhos:
 *
 * - pela conta, em "Meus treinamentos" (o botão "Avaliar");
 * - sem conta, por um link de uso único por inscrição, que sai por e-mail
 *   quando a turma é concluída (`convidar_turma`, chamada de
 *   `turma.mudar_situacao`). Abrir o link (GET) não gasta nada — leitor de
 *   e-mail pré-visualiza links —; o envio da resposta é que o gasta. Link que
 *   não vale mais (desconhecido, já usado ou vencido) recebe a MESMA frase:
 *   de fora não se sabe se ele existiu.
 *
 * **Anonimato por construção.** A resposta (`avaliacao_reacao_resposta`) tem
 * só a turma, a versão, as notas, o comentário e o DIA (sem hora), com chave
 * sorteada. A inscrição ganha só `avaliacao_respondida` (sem hora: com ela,
 * bastaria casar o horário). A trilha diz que a turma recebeu uma resposta,
 * sem conta, sem IP e sem participante.
 *
 * **Piso.** Com menos de `PISO` respostas a equipe vê só a contagem — nem
 * média, nem distribuição, nem comentário: com uma ou duas respostas, quem deu
 * aula sabe quem escreveu. Os comentários saem embaralhados.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, avg, count, eq, inArray, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  assinatura_instrutor as tabela_assinatura,
  avaliacao_reacao_convite as tabela_convite,
  avaliacao_reacao_resposta as tabela_resposta,
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  turma_instrutor as tabela_turma_instrutor,
} from "../db/esquema/index.js";
import { somar_dias } from "../dominio/datas.js";
import { INSCRICAO_FORA_DA_APURACAO } from "../dominio/estados.js";
import { Inscricao as I, Participante } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import * as servico_turma from "./turma.js";
import type { InscricaoCarregada, TurmaCarregada } from "./turma.js";

export const VERSAO = "v1";
export const CAMINHO = "/avaliacao";
export const TIPO_EMAIL = "AVALIACAO_REACAO";
/** Dias depois do fim da turma em que a avaliação ainda se responde (conta e link). */
export const PRAZO_DIAS = 60;
/** Abaixo disto, só a contagem. */
export const PISO = 3;
export const TAMANHO_COMENTARIO = 1000;
export const ROTULO_COMENTARIO = "Comentário";

// eventos da trilha — nenhum diz quem respondeu
export const AVALIACAO_REACAO_RECEBIDA = "AVALIACAO_REACAO_RECEBIDA";
export const AVALIACAO_REACAO_CONVITES = "AVALIACAO_REACAO_CONVITES";

/**
 * Quem vê o resultado: quem opera turmas (as permissões de quem "gerencia" na
 * ficha da turma), no escopo e no setor dessas permissões.
 */
export const PERMISSOES_DO_RESULTADO: readonly string[] = ["turma.criar", "turma.inscrever", "turma.avaliar", "turma.concluir"];

export type CampoNota =
  | "nota_conteudo"
  | "nota_instrutor"
  | "nota_material"
  | "nota_local"
  | "nota_carga"
  | "nota_recomendaria";

export interface Item {
  campo: CampoNota;
  /** a pergunta, como sai na tela */
  rotulo: string;
  /** o rótulo curto, para a tabela do resultado */
  curto: string;
  /** o que quer dizer o 1 e o 5 */
  extremos: [string, string];
}

const SATISFACAO: [string, string] = ["muito ruim", "muito bom"];

/** O questionário `v1`. A ordem é a da tela e a do resultado. */
export const ITENS: readonly Item[] = Object.freeze([
  { campo: "nota_conteudo", rotulo: "O conteúdo e os objetivos do treinamento", curto: "Conteúdo e objetivos", extremos: SATISFACAO },
  { campo: "nota_instrutor", rotulo: "O(s) instrutor(es)", curto: "Instrutor(es)", extremos: SATISFACAO },
  { campo: "nota_material", rotulo: "O material e os recursos usados", curto: "Material e recursos", extremos: SATISFACAO },
  { campo: "nota_local", rotulo: "O local e a infraestrutura", curto: "Local e infraestrutura", extremos: SATISFACAO },
  {
    campo: "nota_carga",
    rotulo: "A carga horária foi adequada ao conteúdo?",
    curto: "Carga horária",
    extremos: ["nada adequada", "totalmente adequada"],
  },
  {
    campo: "nota_recomendaria",
    rotulo: "Você recomendaria este treinamento a um colega?",
    curto: "Recomendaria",
    extremos: ["de jeito nenhum", "com certeza"],
  },
] as Item[]);

export const NOTAS = [1, 2, 3, 4, 5] as const;

/** A recusa que a tela devolve com o formulário. */
export class AvaliacaoRecusada extends RegraViolada {}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------
// Quem pode responder
// ---------------------------------------------------------------------
/** O último dia em que a turma ainda se avalia. */
export function prazo_ate(turma: { data_fim: string }): string {
  return somar_dias(turma.data_fim, PRAZO_DIAS);
}

/** A turma terminou: concluída, ou o último dia já passou. A cancelada, nunca. */
export function turma_terminou(turma: { situacao: string; data_fim: string }, hoje: string): boolean {
  if (turma.situacao === "CANCELADA") return false;
  return turma.situacao === "CONCLUIDA" || turma.data_fim < hoje;
}

/** Frequentou: a inscrição está viva e há ao menos um dia presente. */
export function frequentou(inscricao: { situacao: string; presencas: ReadonlyArray<{ presente: boolean }> }): boolean {
  return !INSCRICAO_FORA_DA_APURACAO.has(inscricao.situacao) && I.compareceu(inscricao);
}

type InscricaoAvaliavel = {
  situacao: string;
  avaliacao_respondida: boolean;
  presencas: ReadonlyArray<{ presente: boolean }>;
  turma: { situacao: string; data_fim: string; codigo: string };
};

/** Por que esta inscrição não avalia agora; "" quando pode. */
export function impedimento(inscricao: InscricaoAvaliavel, hoje: string = datas_br.hoje()): string {
  const turma = inscricao.turma;
  if (inscricao.avaliacao_respondida) return `Você já avaliou ${turma.codigo}. Obrigado pela resposta!`;
  if (turma.situacao === "CANCELADA") return `${turma.codigo} foi cancelada: não há o que avaliar.`;
  if (!turma_terminou(turma, hoje)) return `A avaliação de ${turma.codigo} abre quando a turma terminar.`;
  if (hoje > prazo_ate(turma)) {
    return `O prazo para avaliar ${turma.codigo} terminou em ${datas_br.numerica(prazo_ate(turma))}.`;
  }
  if (!frequentou(inscricao)) return `Só avalia ${turma.codigo} quem frequentou a turma.`;
  return "";
}

export function pode_avaliar(inscricao: InscricaoAvaliavel, hoje: string = datas_br.hoje()): boolean {
  return impedimento(inscricao, hoje) === "";
}

// ---------------------------------------------------------------------
// O formulário
// ---------------------------------------------------------------------
export interface Respostas {
  notas: Record<CampoNota, number>;
  comentario: string | null;
}

/** O que foi marcado, para devolver o formulário como estava na recusa. */
export function marcado(ler: (nome: string) => string): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const item of ITENS) saida[item.campo] = ler(item.campo).trim();
  saida.comentario = ler("comentario");
  return saida;
}

/**
 * Lê e confere. Toda nota é obrigatória (de 1 a 5); o comentário é opcional,
 * até `TAMANHO_COMENTARIO` caracteres, sem CPF (o formulário já o mascara na
 * porta, e a máscara aqui é recusa) e sem termo de saúde (RN-21).
 */
export function ler_respostas(ler: (nome: string) => string): Respostas {
  const notas = {} as Record<CampoNota, number>;
  for (const item of ITENS) {
    const bruto = ler(item.campo).trim();
    if (!/^[1-5]$/.test(bruto)) throw new AvaliacaoRecusada(`Responda “${item.rotulo}” (de 1 a 5).`);
    notas[item.campo] = Number(bruto);
  }
  const comentario = ler("comentario").replace(/\r\n/g, "\n").trim() || null;
  if (comentario !== null) {
    if (comentario.length > TAMANHO_COMENTARIO) {
      throw new AvaliacaoRecusada(`O ${ROTULO_COMENTARIO.toLowerCase()} passa de ${TAMANHO_COMENTARIO} caracteres.`);
    }
    if (comentario.includes(textos.CPF_MASCARADO) || textos.mascarar_cpf(comentario) !== comentario) {
      throw new AvaliacaoRecusada(
        `O campo ${ROTULO_COMENTARIO} tem um número com formato de CPF. A avaliação é anônima: tire o número e envie de novo.`,
      );
    }
    try {
      textos.exigir_texto_limpo(comentario, ROTULO_COMENTARIO);
    } catch (erro) {
      if (!(erro instanceof textos.TextoProibido)) throw erro;
      throw new AvaliacaoRecusada(
        `O campo ${ROTULO_COMENTARIO} tem termo que o sistema não registra (${textos.termos_proibidos_em(comentario).join(", ")}). ` +
          "Fale do treinamento — conteúdo, aula, material, local —, sem dado de saúde nem documento de ninguém.",
      );
    }
  }
  return { notas, comentario };
}

// ---------------------------------------------------------------------
// A gravação — a mesma para a conta e para o link
// ---------------------------------------------------------------------
/**
 * Marca a inscrição (uma vez só: o UPDATE condicional é a trava contra o
 * duplo clique e contra a conta e o link ao mesmo tempo), grava a resposta
 * solta e registra na trilha só que a turma recebeu uma.
 */
async function _gravar(
  tx: Executor,
  inscricao_id: number,
  turma: { id: number; codigo: string },
  respostas: Respostas,
  hoje: string,
): Promise<void> {
  const marcadas = await tx
    .update(tabela_inscricao)
    .set({ avaliacao_respondida: true })
    .where(and(eq(tabela_inscricao.id, inscricao_id), eq(tabela_inscricao.avaliacao_respondida, false)))
    .returning({ id: tabela_inscricao.id });
  if (!marcadas.length) throw new AvaliacaoRecusada(`Esta avaliação de ${turma.codigo} já foi respondida. Obrigado!`);
  // o convite que sobrou (respondeu pela conta) não serve mais para nada
  await tx.delete(tabela_convite).where(eq(tabela_convite.inscricao_id, inscricao_id));
  await tx.insert(tabela_resposta).values({
    turma_id: turma.id,
    versao: VERSAO,
    ...respostas.notas,
    comentario: respostas.comentario,
    respondida_em: hoje,
  });
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: AVALIACAO_REACAO_RECEBIDA,
    // o fato, e só: nem quem, nem por onde (conta ou link)
    descricao: `${turma.codigo}: recebeu uma avaliação de reação`,
    usuario: null,
    usuario_nome: "avaliação anônima",
  });
}

/**
 * Pela conta. A rota não aceita "quem": a inscrição é a do titular da sessão
 * nesta turma, ou nenhuma.
 */
export async function inscricao_do_titular(
  tx: Executor,
  usuario: UsuarioAtual,
  turma_id: number,
): Promise<InscricaoCarregada | null> {
  return (await servico_turma.inscricoes_do_titular(tx, usuario)).find((i) => i.turma_id === turma_id) ?? null;
}

export async function responder_pela_conta(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  respostas: Respostas,
  hoje: string = datas_br.hoje(),
): Promise<void> {
  if (!servico_turma.e_do_titular(usuario, inscricao.participante)) throw new AvaliacaoRecusada("Esta inscrição não é sua.");
  const motivo = impedimento(inscricao, hoje);
  if (motivo) throw new AvaliacaoRecusada(motivo);
  await _gravar(tx, inscricao.id, inscricao.turma, respostas, hoje);
}

// ---------------------------------------------------------------------
// O link sem conta
// ---------------------------------------------------------------------
export interface LinkAberto {
  inscricao: InscricaoCarregada;
  /** "" quando pode responder */
  impedimento: string;
}

/**
 * O que o link abre, ou `null` para token desconhecido, já usado ou vencido —
 * os três são o mesmo "não". Não gasta o token.
 */
export async function abrir_link(tx: Executor, token: string, hoje: string = datas_br.hoje()): Promise<LinkAberto | null> {
  if (!token || token.length > 64) return null;
  const [convite] = await tx.select().from(tabela_convite).where(eq(tabela_convite.token_hash, _hash(token)));
  if (!convite || convite.expira_em < hoje) return null;
  const inscricao = await servico_turma.carregar_inscricao(tx, convite.inscricao_id);
  if (!inscricao) return null;
  return { inscricao, impedimento: impedimento(inscricao, hoje) };
}

/**
 * Responde pelo link e o gasta. `null` quando o link não vale (mesma frase do
 * GET). A conferência vem antes de apagar o convite: a recusa (nota faltando,
 * turma fora do prazo) deixa o link valendo.
 */
export async function responder_pelo_link(
  tx: Executor,
  token: string,
  respostas: Respostas,
  hoje: string = datas_br.hoje(),
): Promise<InscricaoCarregada | null> {
  const aberto = await abrir_link(tx, token, hoje);
  if (!aberto) return null;
  if (aberto.impedimento) throw new AvaliacaoRecusada(aberto.impedimento);
  // o DELETE condicional é o "uso único": de dois envios ao mesmo tempo, só um apaga
  const gasto = await tx
    .delete(tabela_convite)
    .where(eq(tabela_convite.token_hash, _hash(token)))
    .returning({ inscricao_id: tabela_convite.inscricao_id });
  if (!gasto.length) return null;
  await _gravar(tx, aberto.inscricao.id, aberto.inscricao.turma, respostas, hoje);
  return aberto.inscricao;
}

function _corpo(turma: TurmaCarregada, link: string, ate: string): string {
  const periodo =
    turma.data_inicio === turma.data_fim
      ? `em ${datas_br.numerica(turma.data_inicio)}`
      : `de ${datas_br.numerica(turma.data_inicio)} a ${datas_br.numerica(turma.data_fim)}`;
  return (
    "Olá.\n\n" +
    `Obrigado por participar do treinamento ${turma.treinamento.nome} (turma ${turma.codigo}, ${periodo}). ` +
    "Conte para a equipe o que achou: são seis perguntas rápidas e um comentário, se quiser.\n\n" +
    `${link}\n\n` +
    `A resposta é anônima: a equipe vê só o conjunto das respostas da turma, nunca quem respondeu. ` +
    `O link vale para uma resposta, até ${datas_br.numerica(ate)}. ` +
    "Se você tem conta no Sistema SISA, também pode responder em Meus treinamentos.\n\n" +
    `${turma.unidade_promotora?.nome_extenso || "Superintendência Integrada de Saúde (Sisa)"} — UFVJM\n` +
    "Mensagem enviada pelo Sistema SISA.\n"
  );
}

/**
 * O convite por e-mail a cada inscrito que pode avaliar a turma, chamado na
 * conclusão (`turma.mudar_situacao`). **Idempotente**: quem já tem convite ou
 * já respondeu não recebe outro, e concluir de novo não repete e-mail. Sem o
 * envio de e-mail ligado não gera link nenhum (ficaria um token sem dono na
 * fila); quem tem conta avalia em "Meus treinamentos" do mesmo jeito.
 * Devolve quantos convites saíram.
 */
export async function convidar_turma(
  tx: Executor,
  usuario: UsuarioAtual | null,
  turma: TurmaCarregada,
  hoje: string = datas_br.hoje(),
): Promise<number> {
  if (!email.configurado()) return 0;
  if (!turma_terminou(turma, hoje) || hoje > prazo_ate(turma)) return 0;
  const inscricoes = (await servico_turma.inscricoes_da_turma(tx, turma)).filter((i) => pode_avaliar(i, hoje));
  if (!inscricoes.length) return 0;
  const com_convite = new Set(
    (
      await tx
        .select({ id: tabela_convite.inscricao_id })
        .from(tabela_convite)
        .where(inArray(tabela_convite.inscricao_id, inscricoes.map((i) => i.id)))
    ).map((l) => l.id),
  );
  const { url_base_validacao } = await import("./emissao_certificado.js");
  const base = await url_base_validacao(tx);
  const ate = prazo_ate(turma);
  let enviados = 0;
  for (const inscricao of inscricoes) {
    if (com_convite.has(inscricao.id)) continue;
    const endereco = Participante.email_exibicao(inscricao.participante).trim();
    if (!email.email_valido(endereco)) continue;
    const token = randomBytes(24).toString("base64url");
    const [novo] = await tx
      .insert(tabela_convite)
      .values({ inscricao_id: inscricao.id, token_hash: _hash(token), expira_em: ate })
      .onConflictDoNothing()
      .returning({ id: tabela_convite.inscricao_id });
    if (!novo) continue;
    await email.enfileirar(tx, {
      tipo: TIPO_EMAIL,
      destinatario: endereco,
      assunto: `Como foi o treinamento? — ${turma.treinamento.nome}`,
      corpo: _corpo(turma, `${base}${CAMINHO}/${token}`, ate),
      inscricao_id: inscricao.id,
      criado_por: usuario?.id ?? null,
      // depois do prazo o link não abre: o e-mail atrasado não sai
      expira_em: new Date(`${somar_dias(ate, 1)}T03:00:00Z`),
    });
    enviados++;
  }
  if (enviados) {
    await auditoria.registrar(tx, {
      entidade: "turma",
      entidade_id: turma.id,
      tipo_evento: AVALIACAO_REACAO_CONVITES,
      descricao: `${turma.codigo}: ${enviados} convite(s) para a avaliação de reação enfileirado(s)`,
      usuario,
    });
  }
  return enviados;
}

/** Apaga os convites vencidos (o SHA-256 que não abre mais nada). */
export async function expurgar_convites(tx: Executor, hoje: string = datas_br.hoje()): Promise<number> {
  const r = await tx
    .delete(tabela_convite)
    .where(lt(tabela_convite.expira_em, hoje))
    .returning({ id: tabela_convite.inscricao_id });
  return r.length;
}

// ---------------------------------------------------------------------
// O resultado para a equipe
// ---------------------------------------------------------------------
/** Pode ler o resultado? (a permissão; a turma ainda passa pelo escopo) */
export function ve_resultado(usuario: UsuarioAtual): boolean {
  return PERMISSOES_DO_RESULTADO.some((p) => usuario.pode(p));
}

export function exigir_resultado(usuario: UsuarioAtual): void {
  if (!ve_resultado(usuario)) usuario.exigir(PERMISSOES_DO_RESULTADO[0]!);
}

/** "4,3" — uma casa, vírgula. */
export function media_br(valor: number | string | null | undefined): string | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(1).replace(".", ",");
}

export interface ResultadoItem {
  campo: CampoNota;
  rotulo: string;
  media: string | null;
  /** quantas respostas deram 1, 2, 3, 4 e 5 */
  distribuicao: number[];
  /** a fração de cada nota, de 0 a 100, para a barra */
  percentuais: number[];
}

export interface ResultadoTurma {
  respostas: number;
  elegiveis: number;
  /** menos de `PISO`: só a contagem sai */
  abaixo_do_piso: boolean;
  itens: ResultadoItem[];
  comentarios: string[];
  piso: number;
}

/** Fisher–Yates com o sorteio do sistema: a ordem não diz a ordem de chegada. */
export function embaralhar<T>(lista: readonly T[]): T[] {
  const saida = [...lista];
  for (let i = saida.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [saida[i], saida[j]] = [saida[j]!, saida[i]!];
  }
  return saida;
}

/** Quantos podem avaliar (frequentaram), respondidos ou não. */
export async function elegiveis_da_turma(tx: Executor, turma: TurmaCarregada): Promise<number> {
  return (await servico_turma.inscricoes_da_turma(tx, turma)).filter(frequentou).length;
}

export async function resultado_da_turma(tx: Executor, turma: TurmaCarregada): Promise<ResultadoTurma> {
  const linhas = await tx.select().from(tabela_resposta).where(eq(tabela_resposta.turma_id, turma.id));
  const elegiveis = await elegiveis_da_turma(tx, turma);
  const abaixo = linhas.length < PISO;
  const itens: ResultadoItem[] = abaixo
    ? []
    : ITENS.map((item) => {
        const distribuicao = NOTAS.map((n) => linhas.filter((l) => l[item.campo] === n).length);
        const soma = linhas.reduce((t, l) => t + l[item.campo], 0);
        return {
          campo: item.campo,
          rotulo: item.curto,
          media: media_br(soma / linhas.length),
          distribuicao,
          percentuais: distribuicao.map((q) => Math.round((q / linhas.length) * 100)),
        };
      });
  const comentarios = abaixo ? [] : embaralhar(linhas.map((l) => l.comentario).filter((c): c is string => Boolean(c)));
  return { respostas: linhas.length, elegiveis, abaixo_do_piso: abaixo, itens, comentarios, piso: PISO };
}

export interface LinhaConsolidada {
  id: number;
  nome: string;
  turmas: number;
  respostas: number;
  abaixo_do_piso: boolean;
  /** média de cada item, na ordem de `ITENS` (vazio abaixo do piso) */
  medias: (string | null)[];
}

export interface Consolidado {
  por_treinamento: LinhaConsolidada[];
  por_instrutor: LinhaConsolidada[];
  piso: number;
}

const _MEDIAS = Object.fromEntries(ITENS.map((item) => [item.campo, avg(tabela_resposta[item.campo])])) as Record<
  CampoNota,
  ReturnType<typeof avg>
>;

function _linha(l: { id: number; nome: string; turmas: number; respostas: number } & Record<string, unknown>): LinhaConsolidada {
  const respostas = Number(l.respostas);
  const abaixo = respostas < PISO;
  return {
    id: l.id,
    nome: l.nome,
    turmas: Number(l.turmas),
    respostas,
    abaixo_do_piso: abaixo,
    medias: abaixo ? [] : ITENS.map((item) => media_br(l[item.campo] as string | null)),
  };
}

/**
 * A média por treinamento e por instrutor ao longo das turmas, só das turmas
 * no escopo de quem lê (`PERMISSOES_DO_RESULTADO`, com o recorte por setor).
 * O piso vale por linha. O instrutor responde pelas turmas em que esteve —
 * a nota "instrutor(es)" de turma com dois instrutores conta para os dois.
 */
export async function consolidado(tx: Executor, usuario: UsuarioAtual): Promise<Consolidado> {
  const escopo = servico_turma.consulta_no_escopo(usuario, PERMISSOES_DO_RESULTADO);
  const por_treinamento = await tx
    .select({
      id: tabela_treinamento.id,
      nome: tabela_treinamento.nome,
      turmas: sql<number>`count(DISTINCT ${tabela_resposta.turma_id})`,
      respostas: count(),
      ..._MEDIAS,
    })
    .from(tabela_resposta)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_resposta.turma_id))
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(escopo)
    .groupBy(tabela_treinamento.id, tabela_treinamento.nome)
    .orderBy(tabela_treinamento.nome);
  const por_instrutor = await tx
    .select({
      id: tabela_assinatura.id,
      nome: tabela_assinatura.nome,
      turmas: sql<number>`count(DISTINCT ${tabela_resposta.turma_id})`,
      respostas: count(),
      ..._MEDIAS,
    })
    .from(tabela_resposta)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_resposta.turma_id))
    .innerJoin(tabela_turma_instrutor, eq(tabela_turma_instrutor.turma_id, tabela_turma.id))
    .innerJoin(tabela_assinatura, eq(tabela_assinatura.id, tabela_turma_instrutor.assinatura_instrutor_id))
    .where(escopo)
    .groupBy(tabela_assinatura.id, tabela_assinatura.nome)
    .orderBy(tabela_assinatura.nome);
  return {
    por_treinamento: por_treinamento.map((l) => _linha(l as never)),
    por_instrutor: por_instrutor.map((l) => _linha(l as never)),
    piso: PISO,
  };
}
