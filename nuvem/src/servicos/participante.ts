/**
 * Participante: a pessoa que faz treinamento, com ou sem SIAPE.
 * Porte de `app/servicos/participante.py`.
 *
 * Por que existe um serviço próprio, e não um bloco dentro de `certificado.ts`:
 * `participante` não é do módulo de Certificados. O módulo de Acidentes vai
 * apontar para ela (`acidentado.participante_id`), e fazer Acidentes importar
 * `servicos/certificado.ts` para criar uma pessoa seria amarrar dois módulos
 * pelo lugar errado.
 *
 * As três regras que governam tudo aqui:
 *
 * 1. **Servidor é ponteiro, não cópia.** O participante de quem tem SIAPE guarda
 *    `servidor_id` e mais nada de identificação; nome, cargo e lotação continuam
 *    morando em `servidor`.
 * 2. **Externo existe só aqui**, com nome próprio e identificador público opaco.
 * 3. **E-mail é tabela filha, nunca coluna.** É o que reconcilia a mesma pessoa
 *    que hoje usa o e-mail pessoal e amanhã o institucional.
 *
 * NÃO HÁ COLUNA DE CPF em lugar nenhum, e não deve haver (decisão 1 do
 * coordenador). O identificador do externo é o e-mail confirmado, que é mutável.
 *
 * **Diferença de forma do porte.** No Python o `Participante` era um objeto do
 * ORM que carregava `servidor` e `emails` sob demanda. Aqui quem lê recebe o
 * participante já com essas relações (`COM_PARTICIPANTE`), e quem escreve
 * atualiza o objeto em memória junto com o banco — o `s.flush()` que mantinha
 * os dois iguais.
 */
import { and, asc, eq, ilike, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  participante as tabela_participante,
  participante_email as tabela_email,
  servidor as tabela_servidor,
} from "../db/esquema/index.js";
import {
  ORIGENS_EMAIL,
  Participante as P,
  VINCULOS_PARTICIPANTE,
  gerar_identificador_publico,
  normalizar_email,
} from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as identificacao from "./identificacao.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export const TENTATIVAS_IDENTIFICADOR = 20;

export type ParticipanteRegistro = typeof tabela_participante.$inferSelect;
export type ParticipanteEmailRegistro = typeof tabela_email.$inferSelect;
export type ServidorRegistro = typeof tabela_servidor.$inferSelect;

/** O participante com o que `nome_exibicao` e `email_exibicao` leem. */
export type ParticipanteCarregado = ParticipanteRegistro & {
  servidor: ServidorRegistro | null;
  emails: ParticipanteEmailRegistro[];
  email_principal: ParticipanteEmailRegistro | null;
};

/**
 * O `with` do Drizzle que devolve o participante como o Python o via: com o
 * servidor e os e-mails (na ordem do `relationship`, por id).
 */
export const COM_PARTICIPANTE = {
  servidor: true,
  emails: { orderBy: (e: typeof tabela_email, { asc: a }: { asc: typeof asc }) => [a(e.id)] },
  email_principal: true,
} as const;

/** O que a tela precisa corrigir antes de gravar. */
export class DadosDoParticipante extends RegraViolada {}

/** `participante.nome_exibicao` do Python. */
export function nome_exibicao(participante: ParticipanteCarregado): string {
  return P.nome_exibicao(participante);
}

export async function carregar(tx: Executor, id: number): Promise<ParticipanteCarregado | null> {
  const achado = await tx.query.participante.findFirst({
    where: eq(tabela_participante.id, id),
    with: COM_PARTICIPANTE as never,
  });
  return (achado as ParticipanteCarregado | undefined) ?? null;
}

/**
 * Sorteia até achar um identificador que ainda não existe. São 30^8
 * combinações; "improvável" não é "impossível", e o unique do banco
 * transformaria a colisão em página de erro.
 */
async function _identificador_livre(tx: Executor): Promise<string> {
  for (let i = 0; i < TENTATIVAS_IDENTIFICADOR; i++) {
    const candidato = gerar_identificador_publico();
    const [ja] = await tx
      .select({ id: tabela_participante.id })
      .from(tabela_participante)
      .where(eq(tabela_participante.identificador_publico, candidato))
      .limit(1);
    if (!ja) return candidato;
  }
  throw new Error("nao foi possivel sortear identificador publico de participante");
}

/**
 * Acha a pessoa pelo endereço, confirmado ou não. É a porta de entrada da
 * reconciliação: e-mail já conhecido significa participante já conhecido.
 */
export async function por_email(tx: Executor, email: string): Promise<ParticipanteCarregado | null> {
  const normalizado = normalizar_email(email);
  if (!normalizado) return null;
  const [linha] = await tx
    .select({ participante_id: tabela_email.participante_id })
    .from(tabela_email)
    .where(eq(tabela_email.email_normalizado, normalizado))
    // confirmado primeiro: é o único que garante posse da caixa
    .orderBy(sql`${tabela_email.confirmado_em} IS NULL`, asc(tabela_email.id))
    .limit(1);
  return linha ? carregar(tx, linha.participante_id) : null;
}

/**
 * Acrescenta um endereço ao participante, sem duplicar o que já está lá.
 *
 * Devolve `null` para e-mail vazio: endereço é opcional para quem entra pela
 * tela interna — exigir e-mail só para inscrever produziria endereço inventado.
 */
export async function registrar_email(
  tx: Executor,
  participante: ParticipanteCarregado,
  email: string | null | undefined,
  opcoes: { origem?: string; confirmado_em?: Date | null; principal?: boolean } = {},
): Promise<ParticipanteEmailRegistro | null> {
  const origem = opcoes.origem ?? "CADASTRO";
  const limpo = (email ?? "").trim();
  if (!limpo) return null;
  if (!(ORIGENS_EMAIL as readonly string[]).includes(origem)) {
    throw new DadosDoParticipante(`Origem de e-mail desconhecida: ${origem}.`);
  }
  const normalizado = normalizar_email(limpo);
  if (!normalizado.includes("@") || normalizado.startsWith("@") || normalizado.endsWith("@")) {
    throw new DadosDoParticipante(`E-mail invalido: '${limpo}'.`);
  }

  let ja = participante.emails.find((e) => e.email_normalizado === normalizado) ?? null;
  if (ja === null) {
    const [novo] = await tx
      .insert(tabela_email)
      .values({
        participante_id: participante.id,
        email: limpo,
        // no Python um `@validates` fazia isto sozinho; aqui as duas colunas
        // andam juntas por disciplina (ver o esquema)
        email_normalizado: normalizado,
        origem,
        confirmado_em: opcoes.confirmado_em ?? null,
      })
      .returning();
    ja = novo!;
    participante.emails.push(ja);
  } else if (opcoes.confirmado_em && ja.confirmado_em === null) {
    await tx.update(tabela_email).set({ confirmado_em: opcoes.confirmado_em }).where(eq(tabela_email.id, ja.id));
    ja.confirmado_em = opcoes.confirmado_em;
  }
  if (opcoes.principal || participante.email_principal_id === null) {
    await tx
      .update(tabela_participante)
      .set({ email_principal_id: ja.id })
      .where(eq(tabela_participante.id, participante.id));
    participante.email_principal_id = ja.id;
    participante.email_principal = ja;
  }
  return ja;
}

/**
 * O participante daquele servidor, criando o ponteiro na primeira vez.
 * Idempotente de propósito: chamar duas vezes para o mesmo SIAPE devolve a
 * mesma linha.
 */
export async function de_servidor(
  tx: Executor,
  servidor: ServidorRegistro,
  usuario: UsuarioAtual | null = null,
): Promise<ParticipanteCarregado> {
  const [existente] = await tx
    .select({ id: tabela_participante.id })
    .from(tabela_participante)
    .where(eq(tabela_participante.servidor_id, servidor.id));
  if (existente) return (await carregar(tx, existente.id))!;

  const [linha] = await tx
    .insert(tabela_participante)
    .values({
      servidor_id: servidor.id,
      // nome fica NULL: quem lê, lê de `servidor.nome`
      nome: null,
      identificador_publico: await _identificador_livre(tx),
      vinculo: "SERVIDOR",
      organizacao: "UFVJM",
    })
    .returning();
  const participante: ParticipanteCarregado = { ...linha!, servidor, emails: [], email_principal: null };
  if (servidor.email) {
    // o institucional entra como conhecido, mas NÃO como confirmado: o que
    // confirma é a posse da caixa, e ninguém clicou em link nenhum
    await registrar_email(tx, participante, servidor.email, { origem: "SERVIDOR" });
  }
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: participante.id,
    tipo_evento: "PARTICIPANTE_CRIADO",
    // RN-19 na ESCRITA: a identidade pública, não o nome nem o SIAPE
    descricao: `${participante.identificador_publico} · servidor #${servidor.id}`,
    usuario,
  });
  return participante;
}

/**
 * Terceirizado, discente ou visitante. É o único lugar onde o nome mora.
 * Recusa `vinculo='SERVIDOR'`: quem tem SIAPE entra por `de_servidor`.
 */
export async function criar_externo(
  tx: Executor,
  d: {
    nome: string;
    vinculo: string;
    usuario?: UsuarioAtual | null;
    email?: string;
    organizacao?: string | null;
    matricula_externa?: string | null;
  },
): Promise<ParticipanteCarregado> {
  const limpo = (d.nome ?? "").trim();
  if (!limpo) throw new DadosDoParticipante("Informe o nome do participante externo.");
  if (!(VINCULOS_PARTICIPANTE as readonly string[]).includes(d.vinculo)) {
    throw new DadosDoParticipante(`Vinculo desconhecido: ${d.vinculo}.`);
  }
  if (d.vinculo === "SERVIDOR") {
    throw new DadosDoParticipante(
      "Servidor da UFVJM entra pelo cadastro de servidor, pelo SIAPE — " +
        "nao como participante externo.",
    );
  }
  const [linha] = await tx
    .insert(tabela_participante)
    .values({
      servidor_id: null,
      nome: limpo,
      identificador_publico: await _identificador_livre(tx),
      vinculo: d.vinculo,
      organizacao: (d.organizacao ?? "").trim() || null,
      matricula_externa: (d.matricula_externa ?? "").trim() || null,
    })
    .returning();
  const participante: ParticipanteCarregado = { ...linha!, servidor: null, emails: [], email_principal: null };
  await registrar_email(tx, participante, d.email ?? "", { origem: "CADASTRO" });
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: participante.id,
    tipo_evento: "PARTICIPANTE_CRIADO",
    // o nome sai da frase sem substituto: o vínculo e a organização dizem que
    // participante é esse, e a identidade é o `PTC-`
    descricao:
      `${participante.identificador_publico} · ${d.vinculo.toLowerCase()}` +
      (participante.organizacao ? ` · ${participante.organizacao}` : ""),
    usuario: d.usuario ?? null,
  });
  return participante;
}

// =====================================================================
// RN-19 do lado do FILTRO — a busca que inscreve
// =====================================================================
/**
 * Quem pode ler o NOME de quem está numa turma: `certificado.ver`, ou a RN-19
 * comum de `identificacao.pode_ver_nominal`. É a mesma pergunta que a tela faz.
 */
export function pode_identificar(
  usuario: UsuarioAtual | null | undefined,
  participante: { servidor_id: number | null },
): boolean {
  if (!usuario) return false;
  return usuario.pode("certificado.ver") || identificacao.pode_ver_nominal(usuario, participante.servidor_id);
}

/**
 * A forma de `identificacao.casa_a_busca`, aplicada a quem tem duas origens.
 * Chave opaca (`PTC-…`, SIAPE) acha para todo mundo; nome e e-mail só para quem
 * pode ler o nome. `alvo` vem normalizado por `textos.chave_busca`.
 */
export function casa_a_busca_de_participante(
  alvo: string,
  participante: ParticipanteCarregado,
  usuario: UsuarioAtual | null | undefined,
): boolean {
  if (textos.chave_busca(participante.identificador_publico).includes(alvo)) return true;
  if (participante.servidor && identificacao.casa_a_busca(alvo, participante.servidor, usuario)) return true;
  if (!pode_identificar(usuario, participante)) return false;
  const nominais = [nome_exibicao(participante), ...participante.emails.map((e) => e.email)];
  return nominais.some((campo) => campo && textos.chave_busca(campo).includes(alvo));
}

/**
 * Busca por nome do externo, nome do servidor, SIAPE, e-mail ou PTC-....
 *
 * O SQL é só o RECORTE; quem decide linha a linha é
 * `casa_a_busca_de_participante`, porque a RN-19 depende de quem pergunta E de
 * quem é a pessoa. O `limite` sai depois do filtro. `usuario=null` é o lado
 * seguro: tratado como quem não vê nome.
 */
export async function buscar(
  tx: Executor,
  termo: string,
  usuario: UsuarioAtual | null = null,
  limite = 20,
): Promise<ParticipanteCarregado[]> {
  const alvo = (termo ?? "").trim();
  if (!alvo) return [];
  const curinga = `%${alvo}%`;
  const ids = await tx
    .selectDistinct({ id: tabela_participante.id })
    .from(tabela_participante)
    .leftJoin(tabela_servidor, eq(tabela_participante.servidor_id, tabela_servidor.id))
    .leftJoin(tabela_email, eq(tabela_email.participante_id, tabela_participante.id))
    .where(
      and(
        eq(tabela_participante.ativo, true),
        // absorvido por mesclagem sai das listas
        isNull(tabela_participante.mesclado_em_id),
        or(
          ilike(tabela_participante.nome, curinga),
          ilike(tabela_servidor.nome, curinga),
          ilike(tabela_servidor.siape, curinga),
          ilike(tabela_email.email_normalizado, normalizar_email(curinga)),
          ilike(tabela_participante.identificador_publico, curinga.toUpperCase()),
        ),
      ),
    )
    .orderBy(asc(tabela_participante.id));
  const chave = textos.chave_busca(alvo);
  const achados: ParticipanteCarregado[] = [];
  for (const { id } of ids) {
    const pessoa = (await carregar(tx, id))!;
    if (casa_a_busca_de_participante(chave, pessoa, usuario)) achados.push(pessoa);
  }
  return achados.slice(0, limite);
}

/**
 * Servidores da base que ainda NÃO têm participante, por nome ou SIAPE — os que
 * a busca de participante não acha porque nunca fizeram treinamento nenhum.
 * A pergunta é a de `/servidores` (`identificacao.casa_a_busca`).
 */
export async function buscar_servidores(
  tx: Executor,
  termo: string,
  usuario: UsuarioAtual | null = null,
  limite = 20,
): Promise<ServidorRegistro[]> {
  const alvo = textos.chave_busca(termo ?? "");
  if (!alvo) return [];
  const ja_participantes = tx
    .select({ servidor_id: tabela_participante.servidor_id })
    .from(tabela_participante)
    .where(isNotNull(tabela_participante.servidor_id));
  const candidatos = await tx
    .select()
    .from(tabela_servidor)
    .where(notInArray(tabela_servidor.id, ja_participantes as never))
    .orderBy(asc(tabela_servidor.nome));
  return candidatos.filter((s) => identificacao.casa_a_busca(alvo, s, usuario)).slice(0, limite);
}
