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
 * de fora. Quem confere é a equipe, olhando a aba Inscrições.
 *
 * **Sem CPF.** O formulário não tem o campo, e recusa o número digitado em
 * qualquer outro (o CPF só entra pela tela interna, e só para o certificado).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  inscricao as tabela_inscricao,
  servidor as tabela_servidor,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { somar_dias } from "../dominio/datas.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
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
  "Pedido recebido. A equipe responsável pela turma confere cada pedido antes de confirmar a vaga; " +
  "se precisar de algo, ela procura você pelos dados informados.";

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

/**
 * Quem é a pessoa do pedido. Casa com cadastro existente SÓ quando o nome
 * digitado confere com o do cadastro (pelo SIAPE, ou pelo e-mail): digitar o
 * SIAPE de outra pessoa não pendura o pedido nela. O e-mail é procurado em
 * TODOS os participantes que o usam (dois podem dividir o endereço, e o
 * primeiro nem sempre é o do nome digitado). Sem casamento, o pedido em espera
 * da mesma pessoa na turma é reaproveitado; só então nasce um participante
 * externo — a duplicata, se for, aparece para a equipe mesclar.
 */
async function _participante(tx: Executor, turma: TurmaCarregada, p: Pedido): Promise<[ParticipanteCarregado, string]> {
  if (p.siape) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, p.siape));
    if (servidor && mesmo_nome(servidor.nome, p.nome)) {
      return [await servico_participante.de_servidor(tx, servidor, null), ""];
    }
  }
  if (p.email) {
    const do_endereco = await servico_participante.por_email_todos(tx, p.email);
    const ja = do_endereco.find((x) => x.ativo && x.mesclado_em_id === null && mesmo_nome(nome_exibicao(x), p.nome));
    if (ja) return [ja, ""];
  }
  const em_espera = await _pedido_em_espera(tx, turma, p);
  if (em_espera) return [em_espera, ""];
  const nota = p.siape ? `Pedido pelo link: o SIAPE ${p.siape} informado não confere com o cadastro de servidor.` : "";
  const novo = await servico_participante.criar_externo(tx, {
    nome: p.nome,
    // o servidor que não casou entra como "outro": o vínculo SERVIDOR só vem do cadastro
    vinculo: p.vinculo === "SERVIDOR" ? "OUTRO" : p.vinculo,
    organizacao: p.organizacao || (p.vinculo === "SERVIDOR" ? "UFVJM" : null),
  });
  // a origem diz de onde o endereço veio; confirmado ele não está
  if (p.email) await servico_participante.registrar_email(tx, novo, p.email, { origem: "INSCRICAO_PUBLICA" });
  return [novo, nota];
}

/**
 * Registra o pedido. Devolve sempre do mesmo jeito (a rota responde a mesma
 * frase): pessoa já na turma não ganha segundo registro, e de fora ninguém
 * sabe disso.
 */
export async function pedir(
  tx: Executor,
  turma: TurmaCarregada,
  dados: Pedido,
  ip: string | null,
  hoje: string | null = null,
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
  try {
    [pessoa, nota] = await _participante(tx, turma, p);
  } catch (erro) {
    if (erro instanceof DadosDoParticipante) throw new PedidoInvalido(erro.message);
    throw erro;
  }
  const [ja] = await tx
    .select({ id: tabela_inscricao.id })
    .from(tabela_inscricao)
    .where(and(eq(tabela_inscricao.turma_id, turma.id), eq(tabela_inscricao.participante_id, pessoa.id)));
  if (ja) return;

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
}

// ---------------------------------------------------------------------
// Limite por IP — o mesmo desenho do de /validar (memória da instância)
// ---------------------------------------------------------------------
export const JANELA_S = 600;
export const LIMITE_POR_JANELA = 8;
const _tentativas = new Map<string, number[]>();

export const relogio = { agora: (): number => performance.now() / 1000 };

export function limpar_limites(): void {
  _tentativas.clear();
}

/** Conta o envio e diz se ele cabe. Só o POST conta: abrir o cartaz é de graça. */
export function dentro_do_limite(ip: string | null | undefined): boolean {
  const chave = ip || "desconhecido";
  const agora = relogio.agora();
  const fila = (_tentativas.get(chave) ?? []).filter((t) => agora - t <= JANELA_S);
  fila.push(agora);
  _tentativas.set(chave, fila);
  return fila.length <= LIMITE_POR_JANELA;
}
