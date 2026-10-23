/**
 * Prevenção de cadastros duplicados (23/10/2026): o critério ÚNICO de
 * "parecido", usado por todas as portas por onde uma pessoa entra — o link
 * público, a ficha da turma, a inscrição em lote, a importação SIAPE — e pela
 * tela que junta os cadastros (o contador de "possíveis duplicados").
 *
 * Antes eram três regras diferentes (primeiro e último nome; nome inteiro;
 * nome sem as palavras curtas) e um `translate` com lista fixa de acentos.
 * Agora:
 *
 * - **nome parecido**: o mesmo primeiro nome e, depois dele, ou o mesmo
 *   último sobrenome ou todos os sobrenomes do nome mais curto dentro do mais
 *   longo — "Maria Souza" parece "Maria Aparecida Souza Lima"; "Joana Silva"
 *   parece "Joana da Silva". Sem acento, sem caixa, sem partícula (de, da,
 *   dos…). Nome de uma palavra só não parece ninguém.
 * - **SIAPE** é a chave forte: o SIAPE informado com nome parecido.
 * - **e-mail**: o mesmo endereço (só caixa e espaço normalizados, de
 *   propósito: tirar ponto do Gmail juntaria pessoas diferentes). Com nome
 *   parecido é sinal forte; sozinho, é o e-mail do setor ou da família, e só
 *   vale como aviso.
 * - **o par "não é a mesma pessoa"** (`participante_par_distinto`), marcado
 *   por quem conferiu, nunca volta como parecido.
 *
 * CPF não entra: ele é guardado só para o certificado (decisão de 19/10/2026,
 * reafirmada em 23/10/2026), e não é chave de ninguém.
 *
 * **RN-19.** `procurar` devolve TODO parecido, sem filtro de quem pergunta;
 * mostrar o nome é decisão de quem chama (`visiveis`), com a mesma pergunta de
 * sempre (`participante.pode_identificar`). Quem não lê nomes não recebe a
 * pergunta "é a mesma pessoa?" — o cadastro nasce marcado como suspeito
 * (`marcar_suspeito`) para quem lê nomes conferir.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  participante as tabela_participante,
  participante_par_distinto as tabela_par,
  servidor as tabela_servidor,
} from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import * as servico_participante from "./participante.js";
import type { ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export const PARTICIPANTES_DISTINTOS = "PARTICIPANTES_DISTINTOS";
export const PARTICIPANTE_SUSPEITO_DUPLICADO = "PARTICIPANTE_SUSPEITO_DUPLICADO";

/** Partículas que não distinguem ninguém: "Joana da Silva" é "Joana Silva". */
export const PARTICULAS: ReadonlySet<string> = new Set([
  "de", "da", "do", "das", "dos", "e", "d", "del", "della", "di", "du", "van", "von", "y",
]);

/** As palavras do nome que contam: sem acento, sem caixa, sem pontuação, sem partícula. */
export function partes_do_nome(nome: string | null | undefined): string[] {
  return textos
    .chave_busca(nome)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((p) => p && !PARTICULAS.has(p));
}

/**
 * O critério de nome parecido (ver o cabeçalho). Simétrico, e mais largo que
 * o antigo `mesmo_nome` (primeiro e último iguais), que continua contido nele.
 */
export function nomes_parecidos(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = partes_do_nome(a);
  const y = partes_do_nome(b);
  if (x.length < 2 || y.length < 2 || x[0] !== y[0]) return false;
  if (x.at(-1) === y.at(-1)) return true;
  const [curto, longo] = x.length <= y.length ? [x, y] : [y, x];
  const resto = new Set(longo.slice(1));
  return curto.slice(1).every((p) => resto.has(p));
}

/** Por que dois cadastros parecem a mesma pessoa, do sinal mais forte ao mais fraco. */
export type Motivo = "SIAPE" | "EMAIL_NOME" | "EMAIL" | "NOME";

export const ROTULO_MOTIVO: Readonly<Record<Motivo, string>> = {
  SIAPE: "SIAPE informado e nome parecido",
  EMAIL_NOME: "mesmo e-mail e nome parecido",
  EMAIL: "mesmo e-mail",
  NOME: "nome parecido",
};

const FORCA: Readonly<Record<Motivo, number>> = { SIAPE: 4, EMAIL_NOME: 3, EMAIL: 2, NOME: 1 };

export interface Parecido {
  pessoa: ParticipanteCarregado;
  motivo: Motivo;
}

// ---------------------------------------------------------------------
// O par "não é a mesma pessoa"
// ---------------------------------------------------------------------
export function par(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** Os cadastros que alguém já disse NÃO serem a mesma pessoa que `id`. */
export async function distintos_de(tx: Executor, id: number): Promise<Set<number>> {
  const linhas = await tx
    .select({ a: tabela_par.participante_a_id, b: tabela_par.participante_b_id })
    .from(tabela_par)
    .where(or(eq(tabela_par.participante_a_id, id), eq(tabela_par.participante_b_id, id)));
  return new Set(linhas.map((l) => (l.a === id ? l.b : l.a)));
}

/** Todos os pares marcados, como `"a:b"` com `a < b` — para a varredura da base. */
export async function todos_os_pares(tx: Executor): Promise<Set<string>> {
  const linhas = await tx
    .select({ a: tabela_par.participante_a_id, b: tabela_par.participante_b_id })
    .from(tabela_par);
  return new Set(linhas.map((l) => `${l.a}:${l.b}`));
}

export type OrigemDecisao = "CONFERENCIA" | "FICHA_TURMA" | "LOTE" | "JUNCAO";

/**
 * Grava que `a` e `b` são pessoas diferentes. Idempotente: o par já marcado
 * devolve `false` e não escreve de novo na trilha. A suspeita dos dois sai —
 * alguém que lê nomes acabou de conferir.
 *
 * A permissão é de quem chama (a conferência pede `turma.inscrever`; a tela de
 * junção, `participante.mesclar`).
 */
export async function marcar_distintos(
  tx: Executor,
  usuario: UsuarioAtual,
  a_id: number,
  b_id: number,
  origem: OrigemDecisao,
): Promise<boolean> {
  if (a_id === b_id) return false;
  const [a, b] = par(a_id, b_id);
  const pessoas = await tx
    .select({ id: tabela_participante.id, identificador: tabela_participante.identificador_publico })
    .from(tabela_participante)
    .where(inArray(tabela_participante.id, [a, b]));
  if (pessoas.length !== 2) return false;
  const gravado = await tx
    .insert(tabela_par)
    .values({ participante_a_id: a, participante_b_id: b, origem, decidido_por: usuario.id })
    .onConflictDoNothing()
    .returning({ a: tabela_par.participante_a_id });
  if (!gravado.length) return false;
  await tx
    .update(tabela_participante)
    .set({ suspeita_duplicado_em: null })
    .where(inArray(tabela_participante.id, [a, b]));
  const ident = new Map(pessoas.map((p) => [p.id, p.identificador]));
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: a,
    tipo_evento: PARTICIPANTES_DISTINTOS,
    // RN-19 na escrita: só os identificadores
    descricao: `${ident.get(a)} e ${ident.get(b)} marcados como pessoas diferentes (${ROTULO_ORIGEM[origem]})`,
    usuario,
  });
  return true;
}

const ROTULO_ORIGEM: Readonly<Record<OrigemDecisao, string>> = {
  CONFERENCIA: "na conferência dos pedidos pelo link",
  FICHA_TURMA: "na ficha da turma",
  LOTE: "na inscrição em lote",
  JUNCAO: "na tela de juntar cadastros",
};

// ---------------------------------------------------------------------
// Procurar parecidos
// ---------------------------------------------------------------------
export interface Alvo {
  nome?: string | null;
  /** os e-mails da pessoa (o digitado, ou todos os do cadastro) */
  emails?: ReadonlyArray<string | null | undefined>;
  siape?: string | null;
  /** o cadastro que já existe (fica de fora, e os pares dele valem) */
  participante_id?: number | null;
  /** a pessoa é servidor: outro servidor nunca é a mesma pessoa (SIAPEs diferentes) */
  e_servidor?: boolean;
}

function _literal(t: string): string {
  return t.replace(/[\\%_]/g, "\\$&");
}

/**
 * Os cadastros ativos que parecem a pessoa de `alvo`, do sinal mais forte ao
 * mais fraco. SEM filtro de RN-19 (ver o cabeçalho).
 *
 * O SQL é só o recorte (o primeiro nome em qualquer lugar do nome, sem acento
 * nem caixa — `csso_nome_chave`, da migração 0018); quem decide é
 * `nomes_parecidos`.
 */
export async function procurar(
  tx: Executor,
  alvo: Alvo,
  opcoes: { so_externos?: boolean; limite?: number } = {},
): Promise<Parecido[]> {
  const achados = new Map<number, Parecido>();
  const anotar = (pessoa: ParticipanteCarregado, motivo: Motivo) => {
    const ja = achados.get(pessoa.id);
    if (!ja || FORCA[motivo] > FORCA[ja.motivo]) achados.set(pessoa.id, { pessoa, motivo });
  };
  const nome = (alvo.nome ?? "").trim();

  if (alvo.siape && nome && !opcoes.so_externos) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, alvo.siape));
    if (servidor && nomes_parecidos(servidor.nome, nome)) {
      const [ja] = await tx
        .select({ id: tabela_participante.id })
        .from(tabela_participante)
        .where(eq(tabela_participante.servidor_id, servidor.id));
      const pessoa = ja ? await servico_participante.carregar(tx, ja.id) : null;
      if (pessoa) anotar(pessoa, "SIAPE");
    }
  }

  for (const email of new Set((alvo.emails ?? []).map((m) => (m ?? "").trim()).filter(Boolean))) {
    for (const pessoa of await servico_participante.por_email_todos(tx, email)) {
      anotar(pessoa, nome && nomes_parecidos(servico_participante.nome_exibicao(pessoa), nome) ? "EMAIL_NOME" : "EMAIL");
    }
  }

  const partes = partes_do_nome(nome);
  if (partes.length > 1) {
    const curinga = `%${_literal(partes[0]!)}%`;
    const ids = await tx
      .selectDistinct({ id: tabela_participante.id })
      .from(tabela_participante)
      .leftJoin(tabela_servidor, eq(tabela_participante.servidor_id, tabela_servidor.id))
      .where(
        and(
          eq(tabela_participante.ativo, true),
          isNull(tabela_participante.mesclado_em_id),
          isNull(tabela_participante.expurgado_em),
          sql`csso_nome_chave(coalesce(${tabela_participante.nome}, ${tabela_servidor.nome})) LIKE ${curinga}`,
        ),
      );
    for (const { id } of ids) {
      if (achados.has(id)) continue;
      const pessoa = await servico_participante.carregar(tx, id);
      if (pessoa && nomes_parecidos(servico_participante.nome_exibicao(pessoa), nome)) anotar(pessoa, "NOME");
    }
  }

  const fora = alvo.participante_id ? await distintos_de(tx, alvo.participante_id) : new Set<number>();
  return [...achados.values()]
    .filter(
      ({ pessoa }) =>
        pessoa.id !== alvo.participante_id &&
        !fora.has(pessoa.id) &&
        pessoa.ativo &&
        pessoa.mesclado_em_id === null &&
        pessoa.expurgado_em === null &&
        !(opcoes.so_externos && pessoa.servidor_id !== null) &&
        !(alvo.e_servidor && pessoa.servidor_id !== null),
    )
    .sort((x, y) => FORCA[y.motivo] - FORCA[x.motivo] || x.pessoa.id - y.pessoa.id)
    .slice(0, opcoes.limite ?? 5);
}

/** O alvo de um cadastro que já existe: o nome, todos os e-mails e o SIAPE dele. */
export function alvo_do_cadastro(pessoa: ParticipanteCarregado): Alvo {
  return {
    nome: servico_participante.nome_exibicao(pessoa),
    emails: pessoa.emails.map((m) => m.email),
    siape: pessoa.servidor?.siape ?? null,
    participante_id: pessoa.id,
    e_servidor: pessoa.servidor_id !== null,
  };
}

/** Os parecidos que `usuario` pode ver pelo nome (RN-19 do lado do filtro). */
export function visiveis(parecidos: Parecido[], usuario: UsuarioAtual | null | undefined): Parecido[] {
  return parecidos.filter(({ pessoa }) => servico_participante.pode_identificar(usuario, pessoa));
}

/**
 * O que a tela mostra de um parecido: o `PTC-…` sempre; o nome só para quem
 * pode ler o nome DESTA pessoa.
 */
export interface ParecidoNaTela {
  id: number;
  identificador: string;
  nome: string | null;
  servidor: boolean;
  motivo: Motivo;
  rotulo_motivo: string;
}

export function na_tela(parecidos: Parecido[], usuario: UsuarioAtual | null | undefined): ParecidoNaTela[] {
  return parecidos.map(({ pessoa, motivo }) => ({
    id: pessoa.id,
    identificador: pessoa.identificador_publico,
    nome: servico_participante.pode_identificar(usuario, pessoa) ? servico_participante.nome_exibicao(pessoa) : null,
    servidor: pessoa.servidor_id !== null,
    motivo,
    rotulo_motivo: ROTULO_MOTIVO[motivo],
  }));
}

/**
 * O externo criado sem a pergunta "é a mesma pessoa?" (quem cadastrou não lê
 * nomes) quando havia parecido: fica marcado para quem lê nomes conferir. A
 * trilha diz só o identificador.
 */
export async function marcar_suspeito(tx: Executor, pessoa: ParticipanteCarregado, usuario: UsuarioAtual | null): Promise<void> {
  const agora = agora_utc();
  await tx.update(tabela_participante).set({ suspeita_duplicado_em: agora }).where(eq(tabela_participante.id, pessoa.id));
  pessoa.suspeita_duplicado_em = agora;
  await auditoria.registrar(tx, {
    entidade: "participante",
    entidade_id: pessoa.id,
    tipo_evento: PARTICIPANTE_SUSPEITO_DUPLICADO,
    descricao: `${pessoa.identificador_publico}: cadastrado sem conferência de duplicidade — parece cadastro já existente`,
    usuario,
  });
}

// ---------------------------------------------------------------------
// A varredura da base: os grupos de possíveis duplicados
// ---------------------------------------------------------------------
/**
 * Os grupos de cadastros ativos que parecem a mesma pessoa, pelo MESMO
 * critério das portas: nome parecido ou o mesmo e-mail. Ficam de fora o par
 * de dois servidores (SIAPEs diferentes) e o par marcado "não é a mesma
 * pessoa". Cada grupo tem no máximo um servidor.
 */
export async function grupos(tx: Executor, limite = 50): Promise<ParticipanteCarregado[][]> {
  const pessoas = (await tx.query.participante.findMany({
    where: and(
      eq(tabela_participante.ativo, true),
      isNull(tabela_participante.mesclado_em_id),
      isNull(tabela_participante.expurgado_em),
    ),
    with: servico_participante.COM_PARTICIPANTE as never,
  })) as unknown as ParticipanteCarregado[];
  const distintos = await todos_os_pares(tx);
  const por_id = new Map(pessoas.map((p) => [p.id, p]));

  const pai = new Map<number, number>(pessoas.map((p) => [p.id, p.id]));
  // quantos servidores há em cada grupo (pela raiz)
  const servidores = new Map<number, number>(pessoas.map((p) => [p.id, p.servidor_id !== null ? 1 : 0]));
  const raiz = (x: number): number => {
    let r = x;
    while (pai.get(r) !== r) r = pai.get(r)!;
    return r;
  };
  const pode_unir = (a: ParticipanteCarregado, b: ParticipanteCarregado) => {
    if (a.servidor_id !== null && b.servidor_id !== null) return false;
    const [x, y] = par(a.id, b.id);
    return !distintos.has(`${x}:${y}`);
  };
  const unir = (a: ParticipanteCarregado, b: ParticipanteCarregado) => {
    if (!pode_unir(a, b)) return;
    const ra = raiz(a.id);
    const rb = raiz(b.id);
    if (ra === rb) return;
    // um grupo não junta dois servidores por transitividade
    const soma = (servidores.get(ra) ?? 0) + (servidores.get(rb) ?? 0);
    if (soma > 1) return;
    pai.set(ra, rb);
    servidores.set(rb, soma);
  };

  // o nome: só compara quem tem o mesmo primeiro nome
  const por_primeiro = new Map<string, ParticipanteCarregado[]>();
  // o e-mail: quem divide o endereço
  const por_email = new Map<string, ParticipanteCarregado[]>();
  for (const p of pessoas) {
    const partes = partes_do_nome(servico_participante.nome_exibicao(p));
    if (partes.length > 1) por_primeiro.set(partes[0]!, [...(por_primeiro.get(partes[0]!) ?? []), p]);
    for (const m of p.emails) por_email.set(m.email_normalizado, [...(por_email.get(m.email_normalizado) ?? []), p]);
  }
  for (const lista of por_email.values()) {
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) unir(lista[i]!, lista[j]!);
  }
  for (const lista of por_primeiro.values()) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i]!;
        const b = lista[j]!;
        if (nomes_parecidos(servico_participante.nome_exibicao(a), servico_participante.nome_exibicao(b))) unir(a, b);
      }
    }
  }

  const saida = new Map<number, ParticipanteCarregado[]>();
  for (const p of pessoas) {
    const r = raiz(p.id);
    saida.set(r, [...(saida.get(r) ?? []), por_id.get(p.id)!]);
  }
  return [...saida.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => a[0]!.id - b[0]!.id)
    .slice(0, limite);
}

/**
 * Os EXTERNOS que parecem cada uma de muitas pessoas de uma vez — a
 * importação SIAPE, que cria milhares de servidores numa carga e não pode ir
 * ao banco por linha. Uma consulta só (os externos ativos, com os e-mails), e
 * o mesmo critério de `procurar` em memória. Só sugere: ninguém é ligado.
 */
export async function externos_parecidos_em_lote(
  tx: Executor,
  alvos: ReadonlyArray<{ chave: string; nome: string; email: string | null }>,
  limite_por_alvo = 5,
): Promise<Map<string, Parecido[]>> {
  const saida = new Map<string, Parecido[]>();
  if (!alvos.length) return saida;
  const externos = (await tx.query.participante.findMany({
    where: and(
      eq(tabela_participante.ativo, true),
      isNull(tabela_participante.mesclado_em_id),
      isNull(tabela_participante.expurgado_em),
      isNull(tabela_participante.servidor_id),
    ),
    with: servico_participante.COM_PARTICIPANTE as never,
  })) as unknown as ParticipanteCarregado[];
  if (!externos.length) return saida;
  const por_primeiro = new Map<string, ParticipanteCarregado[]>();
  const por_email = new Map<string, ParticipanteCarregado[]>();
  for (const p of externos) {
    const partes = partes_do_nome(servico_participante.nome_exibicao(p));
    if (partes.length > 1) por_primeiro.set(partes[0]!, [...(por_primeiro.get(partes[0]!) ?? []), p]);
    for (const m of p.emails) por_email.set(m.email_normalizado, [...(por_email.get(m.email_normalizado) ?? []), p]);
  }
  for (const alvo of alvos) {
    const achados = new Map<number, Parecido>();
    const email = (alvo.email ?? "").trim().toLowerCase();
    for (const p of email ? por_email.get(email) ?? [] : []) {
      const motivo: Motivo = nomes_parecidos(servico_participante.nome_exibicao(p), alvo.nome) ? "EMAIL_NOME" : "EMAIL";
      achados.set(p.id, { pessoa: p, motivo });
    }
    const primeiro = partes_do_nome(alvo.nome)[0];
    for (const p of primeiro ? por_primeiro.get(primeiro) ?? [] : []) {
      if (!achados.has(p.id) && nomes_parecidos(servico_participante.nome_exibicao(p), alvo.nome)) {
        achados.set(p.id, { pessoa: p, motivo: "NOME" });
      }
    }
    if (achados.size) {
      saida.set(
        alvo.chave,
        [...achados.values()]
          .sort((x, y) => FORCA[y.motivo] - FORCA[x.motivo] || x.pessoa.id - y.pessoa.id)
          .slice(0, limite_por_alvo),
      );
    }
  }
  return saida;
}

/** O número do contador "possíveis duplicados": quantos grupos a tela de junção lista. */
export async function contar(tx: Executor): Promise<number> {
  return (await grupos(tx, Number.MAX_SAFE_INTEGER)).length;
}
