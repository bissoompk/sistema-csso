/**
 * A inscrição pública por link: o cartaz da turma com um endereço (e um QR)
 * em que qualquer pessoa, sem conta, PEDE a vaga.
 *
 * DESVIO da fatia 6 do desenho: lá o pedido saía da espera quando a pessoa
 * clicava no link do e-mail de confirmação — a trava que impede inscrever
 * alguém no endereço alheio. Aqui a trava não é o e-mail (o endereço digitado
 * nem precisa existir, e mandar e-mail a endereço digitado por anônimo faria do
 * link um canhão de spam). A trava passa a
 * ser a equipe: todo pedido nasce em `AGUARDANDO_EMAIL` ("pedido pelo link, a
 * conferir"), NÃO ocupa vaga, abre a pendência do setor e só vira inscrição
 * quando alguém com `turma.inscrever` o aceita (`conferida_por`, ver a CHECK
 * `ck_inscricao_email_confirmado`). Recusar é cancelar, com motivo.
 *
 * O token do link é sorteado aqui e mostrado UMA vez; o banco guarda só o
 * SHA-256 (a mesma disciplina de `sessao.token_hash`). Gerar de novo troca o
 * link e mata o anterior — é como se desfaz um cartaz que vazou.
 *
 * **Sem oráculo.** A resposta ao público é sempre a mesma frase: quem já
 * estava inscrito, o SIAPE de outra pessoa e o pedido novo são indistinguíveis
 * de fora — no texto e no tempo (`esperar_o_piso`). Quem confere é a equipe,
 * na aba Inscrições e nos pedidos pelo link, onde cada pedido diz com quem
 * parece. Quem fica sabendo que já tem cadastro é só o dono do e-mail DO
 * CADASTRO, pelo aviso de `aviso_cadastro_existente.ts` (modelo "esqueci a
 * senha", 23/10/2026).
 *
 * **Sem CPF.** O formulário não tem o campo, e recusa o número digitado em
 * qualquer outro (o CPF só entra pela tela interna, e só para o certificado).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  email_saida,
  inscricao as tabela_inscricao,
  limite_login_ip,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { somar_dias } from "../dominio/datas.js";
import * as auditoria from "./auditoria.js";
import * as aviso_cadastro from "./aviso_cadastro_existente.js";
import * as datas_br from "./datas_br.js";
import * as email from "./email.js";
import * as pendencias from "./pendencias.js";
import { nomes_parecidos } from "./duplicados.js";
import * as servico_participante from "./participante.js";
import { DadosDoParticipante, mesmo_nome, nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import * as servico_turma from "./turma.js";
import { RegraDaTurma, type TurmaCarregada } from "./turma.js";

export const CAMINHO = "/inscricao";

/** Pedidos em espera por turma: o teto que segura a enxurrada de um link vazado. */
export const LIMITE_PEDIDOS_EM_ESPERA = 200;

const RE_SIAPE = /^\d{6,7}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RESPOSTA_PADRAO =
  "Pedido recebido. Se você informou e-mail, enviamos a ele um link para confirmar: confirmado, e havendo " +
  "vaga, a inscrição fica garantida na hora. Sem a confirmação, a equipe responsável confere o pedido.";

// ---------------------------------------------------------------------
// A confirmação pelo e-mail (25/10/2026): quem confirma o e-mail do pedido tem
// a inscrição confirmada sozinha, havendo vaga — sem a equipe decidir. O
// pedido sem e-mail, o que casou com um servidor por outro endereço e o que
// chegou sem vaga continuam para a equipe conferir.
// ---------------------------------------------------------------------
export const CAMINHO_CONFIRMAR = "/inscricao/confirmar";
export const TIPO_EMAIL_CONFIRMAR = "INSCRICAO_CONFIRMAR";
export const VALIDADE_CONFIRMACAO_MS = 48 * 3_600_000;
/** O teto por destinatário: o link não vira canhão de e-mail para o endereço de outra pessoa. */
export const CONFIRMACOES_POR_DIA = 3;
export const ATOR_CONFIRMACAO = "o próprio participante (e-mail confirmado)";

function _hash_token(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function corpo_da_confirmacao(turma: TurmaCarregada, link: string, expira_em: Date): string {
  return (
    "Olá.\n\n" +
    `Foi pedida, com este e-mail, uma vaga na turma ${turma.codigo} de ${turma.treinamento.nome} ` +
    `(${datas_br.numerica(turma.data_inicio)}). Para confirmar que o e-mail é seu e garantir a vaga, abra o link ` +
    `abaixo e clique em "Confirmar" até ${datas_br.numerica(datas_br.hoje(expira_em))}:\n\n` +
    `${link}\n\n` +
    "Se não foi você que pediu, ignore esta mensagem: sem a confirmação, a equipe confere o pedido.\n\n" +
    "Superintendência Integrada de Saúde (Sisa) — UFVJM\nMensagem enviada pelo Sistema SISA.\n"
  );
}

async function _no_teto(tx: Executor, para: string, agora: Date): Promise<boolean> {
  const [r] = await tx
    .select({ n: count() })
    .from(email_saida)
    .where(
      and(
        eq(email_saida.tipo, TIPO_EMAIL_CONFIRMAR),
        sql`lower(${email_saida.destinatario}) = ${para.trim().toLowerCase()}`,
        gt(email_saida.criado_em, new Date(agora.getTime() - 86_400_000)),
      ),
    );
  return Number(r?.n ?? 0) >= CONFIRMACOES_POR_DIA;
}

async function _enviar_confirmacao(
  tx: Executor,
  turma: TurmaCarregada,
  inscricao_id: number,
  para: string,
  base_url: string,
  agora: Date,
): Promise<boolean> {
  if (!email.email_valido(para) || (await _no_teto(tx, para, agora))) return false;
  const token = randomBytes(24).toString("base64url");
  // vencer não estraga nada: o pedido continua para a equipe, e a turma que
  // fechou antes do clique é conferida de novo na confirmação
  const expira_em = new Date(agora.getTime() + VALIDADE_CONFIRMACAO_MS);
  await tx
    .update(tabela_inscricao)
    .set({ confirmacao_token_hash: _hash_token(token), confirmacao_expira_em: expira_em })
    .where(eq(tabela_inscricao.id, inscricao_id));
  await email.enfileirar(tx, {
    tipo: TIPO_EMAIL_CONFIRMAR,
    destinatario: para,
    assunto: `Confirme a sua inscrição · ${turma.codigo}`,
    corpo: corpo_da_confirmacao(turma, `${base_url}${CAMINHO_CONFIRMAR}/${token}`, expira_em),
    inscricao_id,
    expira_em,
  });
  return true;
}

/** O pedido que o link de confirmação alcança (ainda a conferir, no prazo), ou `null`. */
export async function pedido_do_token(tx: Executor, token: string, agora: Date = new Date()) {
  if (!token || token.length > 64) return null;
  const [linha] = await tx
    .select({ id: tabela_inscricao.id, expira_em: tabela_inscricao.confirmacao_expira_em, situacao: tabela_inscricao.situacao })
    .from(tabela_inscricao)
    .where(eq(tabela_inscricao.confirmacao_token_hash, _hash_token(token)));
  if (!linha || linha.situacao !== "AGUARDANDO_EMAIL" || !linha.expira_em || linha.expira_em <= agora) return null;
  return servico_turma.carregar_inscricao(tx, linha.id);
}

export type ResultadoDaConfirmacao = "CONFIRMADA" | "SEM_VAGA" | "FECHADA";

/**
 * O clique em "Confirmar" do e-mail. O e-mail fica confirmado de qualquer jeito
 * (a CHECK `ck_inscricao_email_confirmado` o pede para a inscrição pública
 * sair da espera); havendo vaga e a turma ainda recebendo pedido, a inscrição
 * sai CONFIRMADA e a tarefa da equipe fecha. Sem vaga ou com a turma fechada, o
 * pedido fica para a equipe, já com o e-mail confirmado.
 */
export async function confirmar_pelo_email(
  tx: Executor,
  token: string,
  ip: string | null,
  agora: Date = new Date(),
): Promise<ResultadoDaConfirmacao | null> {
  const inscricao = await pedido_do_token(tx, token, agora);
  if (!inscricao) return null;
  const turma = inscricao.turma;
  // a última vaga disputada: a turma travada antes da conta (`_conferir_vaga`)
  await tx.select({ id: tabela_turma.id }).from(tabela_turma).where(eq(tabela_turma.id, turma.id)).for("update");
  const restantes = await servico_turma.vagas_restantes(tx, turma);
  const fechada = servico_turma.aberta_a_pedido_proprio(turma);
  const resultado: ResultadoDaConfirmacao = fechada ? "FECHADA" : restantes !== null && restantes <= 0 ? "SEM_VAGA" : "CONFIRMADA";
  const gasto = await tx
    .update(tabela_inscricao)
    .set({
      email_confirmado_em: agora,
      confirmacao_token_hash: null,
      confirmacao_expira_em: null,
      ...(resultado === "CONFIRMADA" ? { situacao: "CONFIRMADA", confirmada_em: agora } : {}),
    })
    .where(and(eq(tabela_inscricao.id, inscricao.id), eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL"), isNull(tabela_inscricao.email_confirmado_em)))
    .returning({ id: tabela_inscricao.id });
  if (!gasto.length) return null;
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: resultado === "CONFIRMADA" ? auditoria.ESTADO_ALTERADO : "INSCRICAO_EMAIL_CONFIRMADO",
    descricao:
      `${turma.codigo} · ${inscricao.participante.identificador_publico}: ` +
      (resultado === "CONFIRMADA"
        ? "pedido pelo link -> Confirmada (e-mail confirmado, havia vaga)"
        : `e-mail confirmado; ${resultado === "SEM_VAGA" ? "sem vaga" : "a turma não recebe mais pedido"}, o pedido fica para a equipe`),
    ...(resultado === "CONFIRMADA" ? { campo: "situacao", valor_anterior: "AGUARDANDO_EMAIL", valor_novo: "CONFIRMADA" } : {}),
    usuario_nome: ATOR_CONFIRMACAO,
    ip,
  });
  if (resultado === "CONFIRMADA") {
    const [tarefa] = await tx
      .select()
      .from(tabela_pendencia)
      .where(eq(tabela_pendencia.chave, servico_turma.chave_da_pendencia_de_confirmacao(inscricao)));
    if (tarefa) await pendencias.concluir_pela_rotina(tx, tarefa, "inscrição confirmada pelo e-mail do participante");
  }
  return resultado;
}

/**
 * A linha que vem junto, IGUAL para todos (23/10/2026): não diz "você já tem
 * cadastro" — diz que, SE tiver, pode chegar uma mensagem no e-mail de antes
 * (`aviso_cadastro_existente.ts`).
 */
export const LINHA_NEUTRA =
  "Se você já tem cadastro com a gente, pode chegar uma mensagem no e-mail que usou antes. " +
  "Não chegou nada? Tudo bem: a equipe confere o pedido do mesmo jeito.";

// ---------------------------------------------------------------------
// O público da turma (22/10/2026)
// ---------------------------------------------------------------------
/** Os vínculos de sempre: a comunidade da UFVJM. */
export const VINCULOS_DA_UFVJM = ["SERVIDOR", "TERCEIRIZADO", "DISCENTE"] as const;
/** "Comunidade externa": só na turma marcada com `aceita_comunidade_externa`. */
export const VINCULOS_COMUNIDADE_EXTERNA = ["VISITANTE", "OUTRO"] as const;
export const ROTULO_COMUNIDADE_EXTERNA = "Comunidade externa";

/** Os vínculos que a turma aceita no pedido pelo link. */
export function vinculos_aceitos(turma: { aceita_comunidade_externa: boolean }): string[] {
  return turma.aceita_comunidade_externa
    ? [...VINCULOS_DA_UFVJM, ...VINCULOS_COMUNIDADE_EXTERNA]
    : [...VINCULOS_DA_UFVJM];
}

/** A frase do público, para a ficha, a tela do link e o cartaz. */
export function publico_da_turma(turma: { aceita_comunidade_externa: boolean }): string {
  return turma.aceita_comunidade_externa
    ? "Servidores, terceirizados e discentes da UFVJM, e a comunidade externa"
    : "Servidores, terceirizados e discentes da UFVJM";
}

function _hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** O fim do último dia de inscrição, no fuso do negócio (UTC−3, sem horário de verão). */
function _expira_em(ate: string): Date {
  return new Date(`${somar_dias(ate, 1)}T03:00:00Z`);
}

// ---------------------------------------------------------------------
// O lado da equipe: ligar, trocar e desligar o link
// ---------------------------------------------------------------------
/**
 * Sorteia o link da turma e devolve o TOKEN (a única vez em que ele existe
 * fora do papel). Só turma com inscrições abertas e com data de fechamento:
 * link sem fim fica aberto para sempre (`ck_turma_inscricao_publica`).
 */
export async function gerar_link(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  hoje: string | null = null,
): Promise<string> {
  usuario.exigir("turma.criar");
  if (turma.inscricao_aberta_ate === null) {
    throw new RegraDaTurma(
      `Defina antes até quando ${turma.codigo} recebe inscrição (aba Turma, “inscrições até”): ` +
        "é a data em que o link deixa de funcionar.",
    );
  }
  const impedimento = servico_turma.aberta_a_pedido_proprio(turma, hoje);
  if (impedimento) throw new RegraDaTurma(impedimento.replace(servico_turma.FALE_COM_A_EQUIPE, ""));
  const token = randomBytes(24).toString("base64url");
  const ja_havia = turma.inscricao_publica;
  const campos = {
    inscricao_publica: true,
    inscricao_token_hash: _hash(token),
    inscricao_token_expira_em: _expira_em(turma.inscricao_aberta_ate),
  };
  await tx.update(tabela_turma).set(campos).where(eq(tabela_turma.id, turma.id));
  Object.assign(turma, campos);
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "INSCRICAO_LINK_GERADO",
    descricao:
      `${turma.codigo}: link público ${ja_havia ? "trocado (o anterior parou de funcionar)" : "ligado"}` +
      ` até ${datas_br.numerica(turma.inscricao_aberta_ate)}`,
    usuario,
  });
  return token;
}

export async function desligar_link(tx: Executor, usuario: UsuarioAtual, turma: TurmaCarregada): Promise<void> {
  usuario.exigir("turma.criar");
  if (!turma.inscricao_publica && turma.inscricao_token_hash === null) return;
  const campos = { inscricao_publica: false, inscricao_token_hash: null, inscricao_token_expira_em: null };
  await tx.update(tabela_turma).set(campos).where(eq(tabela_turma.id, turma.id));
  Object.assign(turma, campos);
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: "INSCRICAO_LINK_DESLIGADO",
    descricao: `${turma.codigo}: link público desligado`,
    usuario,
  });
}

/** O link ligado e ainda válido hoje — o que a ficha mostra como "no ar". */
export function link_no_ar(turma: TurmaCarregada, hoje: string | null = null, agora: Date = new Date()): boolean {
  return (
    turma.inscricao_publica &&
    turma.inscricao_token_hash !== null &&
    (turma.inscricao_token_expira_em === null || turma.inscricao_token_expira_em > agora) &&
    !servico_turma.aberta_a_pedido_proprio(turma, hoje)
  );
}

// ---------------------------------------------------------------------
// O lado do público
// ---------------------------------------------------------------------
export interface TurmaDoLink {
  turma: TurmaCarregada;
  /** "" quando recebe pedido; o motivo, quando o link existe mas fechou */
  fechada: string;
}

/** A turma de um token, ou `null` — token desconhecido e link desligado são o mesmo nada. */
export async function turma_do_token(
  tx: Executor,
  token: string,
  hoje: string | null = null,
  agora: Date = new Date(),
): Promise<TurmaDoLink | null> {
  if (!token || token.length > 64) return null;
  const [linha] = await tx
    .select({ id: tabela_turma.id })
    .from(tabela_turma)
    .where(and(eq(tabela_turma.inscricao_token_hash, _hash(token)), eq(tabela_turma.inscricao_publica, true)));
  if (!linha) return null;
  const turma = await servico_turma.carregar_turma(tx, linha.id);
  if (!turma) return null;
  let fechada = servico_turma.aberta_a_pedido_proprio(turma, hoje).replace(servico_turma.FALE_COM_A_EQUIPE, "");
  if (!fechada && turma.inscricao_token_expira_em !== null && turma.inscricao_token_expira_em <= agora) {
    fechada = `As inscrições de ${turma.codigo} pelo link encerraram.`;
  }
  // turma lotada não recebe pedido: no IntegraSST a lotação fechava a
  // inscrição; aqui a pessoa recebia "pedido recebido" e a recusa só aparecia
  // quando a equipe tentava aceitar. O pedido em espera não ocupa vaga, então
  // conta só quem já foi aceito.
  if (!fechada && (await servico_turma.vagas_restantes(tx, turma)) === 0) {
    fechada = `As vagas de ${turma.codigo} se esgotaram.`;
  }
  return { turma, fechada };
}

export interface Pedido {
  nome: string;
  vinculo: string;
  siape: string;
  email: string;
  organizacao: string;
  consentimento: boolean;
}

/** O que a tela devolve ao público: a recusa de digitação, nunca a de quem é quem. */
export class PedidoInvalido extends Error {}

function _ler(d: Pedido, turma: { aceita_comunidade_externa: boolean }): Pedido {
  const p = {
    nome: d.nome.trim().replace(/\s+/g, " "),
    vinculo: d.vinculo,
    siape: d.siape.replace(/\D/g, ""),
    email: d.email.trim(),
    organizacao: d.organizacao.trim().replace(/\s+/g, " "),
    consentimento: d.consentimento,
  };
  // `formulario` já mascarou o número válido; o que sobra parecendo CPF também volta
  const campos = [d.nome, d.siape, d.email, d.organizacao];
  if (campos.some((v) => v.includes(textos.CPF_MASCARADO) || textos.parece_cpf(v))) {
    throw new PedidoInvalido("Não informe CPF: o pedido não precisa dele.");
  }
  if (p.nome.length < 5 || !p.nome.includes(" ")) throw new PedidoInvalido("Informe o nome completo.");
  // o nome vai para o certificado e para o e-mail: marcação não é nome de ninguém
  if (/[<>{}]/.test(p.nome) || /[<>{}]/.test(p.organizacao)) {
    throw new PedidoInvalido("O nome e a organização não podem ter os caracteres < > { }.");
  }
  if (p.nome.length > 160 || p.organizacao.length > 160 || p.email.length > 160) {
    throw new PedidoInvalido("Algum campo passou de 160 caracteres.");
  }
  // a turma sem "comunidade externa" recusa Visitante e Outro como erro de
  // formulário: a frase fala do público da turma (que está no cartaz), e não
  // diz nada de ninguém — não é oráculo
  if (!vinculos_aceitos(turma).includes(p.vinculo)) {
    if ((VINCULOS_COMUNIDADE_EXTERNA as readonly string[]).includes(p.vinculo)) {
      throw new PedidoInvalido(
        "Esta turma é para a comunidade da UFVJM: escolha Servidor da UFVJM, Terceirizado ou Discente.",
      );
    }
    throw new PedidoInvalido("Escolha o vínculo.");
  }
  if (p.vinculo === "SERVIDOR" && !RE_SIAPE.test(p.siape)) {
    throw new PedidoInvalido("Servidor da UFVJM: informe o SIAPE (6 ou 7 dígitos).");
  }
  if (p.vinculo !== "SERVIDOR") p.siape = "";
  if (p.email && !RE_EMAIL.test(p.email)) throw new PedidoInvalido("O e-mail não parece completo.");
  if (!p.consentimento) {
    throw new PedidoInvalido("Para pedir a vaga é preciso concordar com o uso dos dados descrito acima.");
  }
  if (p.siape) p.siape = p.siape.padStart(7, "0");
  return p;
}

export { mesmo_nome };

/**
 * O pedido que esta mesma pessoa já deixou na turma e a equipe ainda não
 * conferiu: mesmo nome inteiro (sem acento, sem caixa, sem espaço sobrando),
 * externo, vindo do link. É o que segura o duplo clique, o "reenviar" do
 * celular e o pedido repetido de quem não deixou e-mail — cada um nascia como
 * participante novo, e a equipe recebia três "a conferir" da mesma pessoa.
 */
async function _pedido_em_espera(tx: Executor, turma: TurmaCarregada, p: Pedido): Promise<ParticipanteCarregado | null> {
  const alvo = textos.chave_busca(p.nome);
  const linhas = await tx
    .select({ participante_id: tabela_inscricao.participante_id })
    .from(tabela_inscricao)
    .where(
      and(
        eq(tabela_inscricao.turma_id, turma.id),
        eq(tabela_inscricao.origem, "PUBLICA"),
        eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL"),
      ),
    );
  for (const { participante_id } of linhas) {
    const pessoa = await servico_participante.carregar(tx, participante_id);
    if (!pessoa || pessoa.servidor_id !== null || textos.chave_busca(nome_exibicao(pessoa)) !== alvo) continue;
    // e-mails diferentes dos dois lados são duas pessoas de mesmo nome (o mesmo
    // e-mail já casou acima, por `por_email_todos`): juntar as duas sumiria
    // com o pedido da segunda, e a duplicata na mesclagem é o mal menor
    if (p.email && pessoa.emails.length) continue;
    return pessoa;
  }
  return null;
}

/** Por qual chave o pedido casou com um cadastro existente (`null`: não casou). */
export type Casamento = "SIAPE" | "EMAIL" | null;

/**
 * Quem é a pessoa do pedido. Casa com cadastro existente SÓ quando o nome
 * digitado parece o do cadastro (`duplicados.nomes_parecidos`, o critério
 * único), pelo SIAPE ou pelo e-mail: digitar o SIAPE de outra pessoa não
 * pendura o pedido nela. O e-mail é procurado em TODOS os participantes que o
 * usam (dois podem dividir o endereço, e o primeiro nem sempre é o do nome
 * digitado). Sem casamento, o pedido em espera da mesma pessoa na turma é
 * reaproveitado; só então nasce um participante externo — e a equipe vê, na
 * conferência, com quem ele parece.
 */
async function _participante(
  tx: Executor,
  turma: TurmaCarregada,
  p: Pedido,
): Promise<[ParticipanteCarregado, string, Casamento]> {
  if (p.siape) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, p.siape));
    if (servidor && nomes_parecidos(servidor.nome, p.nome)) {
      return [await servico_participante.de_servidor(tx, servidor, null), "", "SIAPE"];
    }
  }
  if (p.email) {
    const do_endereco = await servico_participante.por_email_todos(tx, p.email);
    const ja = do_endereco.find(
      (x) => x.ativo && x.mesclado_em_id === null && nomes_parecidos(nome_exibicao(x), p.nome),
    );
    if (ja) return [ja, "", "EMAIL"];
  }
  const em_espera = await _pedido_em_espera(tx, turma, p);
  if (em_espera) return [em_espera, "", null];
  const nota = p.siape ? `Pedido pelo link: o SIAPE ${p.siape} informado não confere com o cadastro de servidor.` : "";
  const novo = await servico_participante.criar_externo(tx, {
    nome: p.nome,
    // o servidor que não casou entra como "outro": o vínculo SERVIDOR só vem do cadastro
    vinculo: p.vinculo === "SERVIDOR" ? "OUTRO" : p.vinculo,
    organizacao: p.organizacao || (p.vinculo === "SERVIDOR" ? "UFVJM" : null),
  });
  // a origem diz de onde o endereço veio; confirmado ele não está
  if (p.email) await servico_participante.registrar_email(tx, novo, p.email, { origem: "INSCRICAO_PUBLICA" });
  return [novo, nota, null];
}

/**
 * A recusa de dado que chega ao visitante: genérica. A mensagem do cadastro
 * (`DadosDoParticipante`) pode repetir dado que não é dele — era por ela que
 * o e-mail institucional de um servidor saía na tela de quem só digitou o
 * SIAPE (`E-mail inválido: '…'`, 23/10/2026).
 */
export const RECUSA_GENERICA = "Não foi possível registrar o pedido com estes dados. Confira o que foi digitado.";

/**
 * Registra o pedido. Devolve sempre do mesmo jeito (a rota responde a mesma
 * frase): pessoa já na turma não ganha segundo registro, e de fora ninguém
 * sabe disso. Quando o pedido casou com um cadastro pelo e-mail ou pelo
 * SIAPE, o aviso vai ao e-mail DO CADASTRO (`aviso_cadastro_existente.ts`) —
 * nos dois ramos, o novo e o repetido, que assim fazem o mesmo trabalho.
 */
export async function pedir(
  tx: Executor,
  turma: TurmaCarregada,
  dados: Pedido,
  ip: string | null,
  hoje: string | null = null,
  agora: Date = new Date(),
  base_url: string | null = null,
): Promise<void> {
  const p = _ler(dados, turma);
  const impedimento = servico_turma.aberta_a_pedido_proprio(turma, hoje);
  if (impedimento) throw new RegraDaTurma(impedimento.replace(servico_turma.FALE_COM_A_EQUIPE, ""));
  if ((await servico_turma.vagas_restantes(tx, turma)) === 0) {
    throw new RegraDaTurma(`As vagas de ${turma.codigo} se esgotaram.`);
  }
  const [em_espera] = await tx
    .select({ n: count() })
    .from(tabela_inscricao)
    .where(
      and(
        eq(tabela_inscricao.turma_id, turma.id),
        eq(tabela_inscricao.origem, "PUBLICA"),
        eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL"),
      ),
    );
  if (Number(em_espera?.n ?? 0) >= LIMITE_PEDIDOS_EM_ESPERA) {
    throw new RegraDaTurma("Esta turma já recebeu pedidos demais pelo link." + servico_turma.FALE_COM_A_EQUIPE);
  }
  let pessoa: ParticipanteCarregado;
  let nota: string;
  let casou: Casamento;
  try {
    [pessoa, nota, casou] = await _participante(tx, turma, p);
  } catch (erro) {
    if (erro instanceof DadosDoParticipante) throw new PedidoInvalido(RECUSA_GENERICA);
    throw erro;
  }
  const [ja] = await tx
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .where(and(eq(tabela_inscricao.turma_id, turma.id), eq(tabela_inscricao.participante_id, pessoa.id)));
  if (ja) {
    if (casou) {
      await aviso_cadastro.avisar(
        tx,
        pessoa,
        { chave: casou, digitado: p.email, ja_na_turma: true, inscricao_id: ja.id, base_url },
        agora,
      );
    }
    return;
  }

  const [linha] = await tx
    .insert(tabela_inscricao)
    .values({
      turma_id: turma.id,
      participante_id: pessoa.id,
      situacao: "AGUARDANDO_EMAIL",
      origem: "PUBLICA",
      ip_inscricao: ip,
      observacao: nota || null,
    })
    .returning();
  const inscricao = { ...linha!, turma, participante: pessoa, presencas: [] };
  await auditoria.registrar(tx, {
    entidade: "inscricao",
    entidade_id: inscricao.id,
    tipo_evento: "INSCRICAO_PEDIDA_PELO_LINK",
    // RN-19 na ESCRITA: só o identificador
    descricao: `${turma.codigo}: ${pessoa.identificador_publico} pediu vaga pelo link público`,
    usuario: null,
  });
  await servico_turma.abrir_pendencia_de_confirmacao(tx, inscricao, null, true);
  // o link de confirmação vai ao e-mail digitado quando ele é o da pessoa do
  // pedido: a nova, ou a que casou PELO e-mail. A que casou pelo SIAPE com outro
  // endereço fica com a equipe (o e-mail digitado não prova ser o do servidor)
  const enviado =
    base_url !== null && p.email && casou !== "SIAPE"
      ? await _enviar_confirmacao(tx, turma, inscricao.id, p.email, base_url, agora)
      : false;
  // o aviso de cadastro existente iria ao mesmo endereço: a confirmação basta
  if (casou && !(enviado && casou === "EMAIL")) {
    await aviso_cadastro.avisar(
      tx,
      pessoa,
      { chave: casou, digitado: p.email, ja_na_turma: false, inscricao_id: inscricao.id, base_url },
      agora,
    );
  }
}

// ---------------------------------------------------------------------
// Tempo de resposta constante
// ---------------------------------------------------------------------
/**
 * O piso do tempo da resposta ao POST do link, em milissegundos, mais um
 * acréscimo sorteado: o pedido repetido (que não grava inscrição) respondia
 * mais cedo que o novo, e o tempo dizia o que a frase não diz. Trocável no
 * teste.
 */
export const tempo_de_resposta = { piso_ms: 450, variacao_ms: 150 };

export async function esperar_o_piso(inicio: number, agora: () => number = () => performance.now()): Promise<void> {
  const alvo = tempo_de_resposta.piso_ms + Math.floor(Math.random() * (tempo_de_resposta.variacao_ms + 1));
  const falta = alvo - (agora() - inicio);
  if (falta > 0) await new Promise((r) => setTimeout(r, falta));
}

// ---------------------------------------------------------------------
// Limite por IP — no banco (23/10/2026)
// ---------------------------------------------------------------------
/**
 * Era um mapa na memória da instância: zerava a cada arranque a frio e valia
 * por instância. Agora mora em `limite_login_ip`, com chave própria (o mesmo
 * truque do bloqueio encenado de `autenticacao.ts`), e a rotina noturna apaga
 * a linha um dia depois (`expurgar_limites_ip`) — o IP é dado pessoal.
 */
export const JANELA_S = 600;
export const LIMITE_POR_JANELA = 8;
export const PREFIXO_CHAVE_IP = "inscricao:";

/** Mantida para quem a chamava: o limite agora é do banco, que cada teste já recria. */
export function limpar_limites(): void {}

function _chave_ip(ip: string | null | undefined, prefixo: string): string {
  return (prefixo + (ip || "desconhecido")).slice(0, 64);
}

/**
 * Conta o envio e diz se ele cabe. Só o POST conta: abrir o cartaz é de graça.
 * `prefixo` separa os contadores de cada formulário público (o da comunicação
 * de acidente usa o seu, `acidente_publico.PREFIXO_CHAVE_IP`).
 */
export async function dentro_do_limite(
  tx: Executor,
  ip: string | null | undefined,
  agora: Date = new Date(),
  prefixo: string = PREFIXO_CHAVE_IP,
  limite: number = LIMITE_POR_JANELA,
): Promise<boolean> {
  const chave = _chave_ip(ip, prefixo);
  const inicio_valido = new Date(agora.getTime() - JANELA_S * 1000);
  // Date solto num `sql` vai como texto ISO (ver `autenticacao.registrar_falha_ip`)
  const vencida = sql`${limite_login_ip.janela_inicio} < ${inicio_valido.toISOString()}::timestamptz`;
  const [linha] = await tx
    .insert(limite_login_ip)
    .values({ ip: chave, falhas: 1, janela_inicio: agora, bloqueado_ate: null })
    .onConflictDoUpdate({
      target: limite_login_ip.ip,
      set: {
        falhas: sql`CASE WHEN ${vencida} THEN 1 ELSE ${limite_login_ip.falhas} + 1 END`,
        janela_inicio: sql`CASE WHEN ${vencida} THEN ${agora.toISOString()}::timestamptz ELSE ${limite_login_ip.janela_inicio} END`,
      },
    })
    .returning({ falhas: limite_login_ip.falhas });
  return Number(linha?.falhas ?? 1) <= limite;
}
