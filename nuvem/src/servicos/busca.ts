/**
 * A busca que atravessa o sistema — um bloco por entidade, cada um guardado.
 * Porte de `app/servicos/busca.py`.
 *
 * Por que existe: a caixa do cabeçalho despejava em `/processos` e só sabia achar
 * processo. Quem procurava uma pessoa **sem** processo recebia lista vazia e
 * concluía que ela não estava cadastrada; o almoxarife, que não tem `processo.ver`,
 * não tinha `Ctrl+K` nenhum.
 *
 * **A regra que organiza o arquivo é uma só: cada bloco é guardado pela permissão
 * que a ROTA DE DESTINO exige, e nunca devolve linha que a tela de destino não
 * mostraria a esta pessoa.** Daí cada bloco reusar a consulta da sua tela —
 * `repositorios/processos.buscar`, `aplicar_escopo` no certificado e na turma,
 * `epi_requisicao.fila` na requisição — em vez de escrever um SELECT novo que
 * decidiria escopo de novo, e diferente.
 *
 * Três coisas que a busca **não** faz:
 * - **Não busca por CPF** (RN-21): `textos.parece_cpf`, a mesma da fila de EPI.
 * - **Não casa por nome para quem não pode ler aquele nome**
 *   (`identificacao.casa_a_busca`, RN-19).
 * - **Não grava `acesso_dado_sensivel`** — o argumento está em `rotas/busca.ts`.
 *
 * Os `itens` de cada bloco são as LINHAS do banco (com as relações que o
 * template lê), e não texto pronto: quem imprime servidor passa por
 * `identificar(...)` no template.
 */
import { and, asc, desc, eq, ilike, inArray, like, or, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  epi_requisicao as tabela_requisicao,
  laudo_tecnico as tabela_laudo,
  servidor as tabela_servidor,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import { Certificado } from "../dominio/treinamento.js";
import * as repo_processos from "../repositorios/processos.js";
import * as servico_requisicao from "./epi_requisicao.js";
import * as identificacao from "./identificacao.js";
import * as textos from "./textos.js";
import { normalizar_chave } from "./certificado.js";
import { aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import { ganchos } from "../web.js";

// Oito linhas por bloco. A busca global é um índice, não uma lista: quem precisa
// da lista inteira segue o "ver todos" do bloco, que leva à tela que pagina.
export const LIMITE_POR_BLOCO = 8;

export const RECADO_CPF =
  "A busca não aceita CPF: o sistema não armazena CPF em campo nenhum " +
  "(RN-21) — servidor se identifica por SIAPE. Procure pelo nome, pelo SIAPE, " +
  "pelo NUP, pelo número do laudo, pelo protocolo do pedido de EPI, pelo " +
  "código da turma ou pela chave do certificado.";

// `{bloco: permissões que abrem a tela de destino}`. "Qualquer uma destas": o
// servidor tem DUAS telas de destino (`/servidores` e `/epis/fichas`), e quem só
// opera EPI chega numa delas. Bloco novo entra aqui e em `_BLOCOS`.
export const PERMISSOES_POR_BLOCO: Readonly<Record<string, readonly string[]>> = {
  servidor: ["processo.ver", "epi.ficha"],
  processo: ["processo.ver"],
  laudo: ["laudo.ver"],
  requisicao: ["epi.ver"],
  turma: ["treinamento.ver"],
  certificado: ["certificado.ver"],
};

/**
 * A caixa do cabeçalho aparece? Só se algum bloco abrir para a pessoa. Quem
 * não tem nenhuma das permissões (o `admin_ti`) receberia um campo que nunca
 * acha nada. A rota continua abrindo para qualquer sessão, e explica.
 */
export function pode_buscar(usuario: UsuarioAtual | null | undefined): boolean {
  if (!usuario) return false;
  return Object.values(PERMISSOES_POR_BLOCO).some((codigos) => codigos.some((c) => usuario.pode(c)));
}

function _visivel(usuario: UsuarioAtual, bloco: string): boolean {
  return PERMISSOES_POR_BLOCO[bloco]!.some((c) => usuario.pode(c));
}

/** Um recorte da busca, já decidido: o que achou e para onde leva. */
export interface Bloco {
  codigo: string;
  rotulo: string;
  /** o que este bloco casa, em português (aparece no vazio) */
  chaves: string;
  itens: any[];
  /** a tela cheia deste bloco, com o termo propagado — ou vazio */
  ver_todos: string;
  /** veio uma linha a mais do que cabe (a consulta pede `limite + 1`) */
  ha_mais: boolean;
}

function _cortar<T>(linhas: T[], limite: number): [T[], boolean] {
  return [linhas.slice(0, limite), linhas.length > limite];
}

/** O `quote()` do Python (sem `safe='/'` a mais): `encodeURIComponent` deixa `/` escapado também. */
function quote(q: string): string {
  return encodeURIComponent(q).replace(/%2F/g, "/");
}

/**
 * Nome e SIAPE. Espelha `/servidores`: o cadastro inteiro é lido e filtrado em
 * código, porque o critério do nome é `pode_ver_nominal` por LINHA (RN-19). O
 * destino depende de quem pergunta: `processo.ver` vai para o cadastro; o
 * almoxarife, para a ficha de EPI.
 */
async function _bloco_servidor(tx: Executor, usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const alvo = textos.chave_busca(q);
  const achados: (typeof tabela_servidor.$inferSelect)[] = [];
  for (const servidor of await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome))) {
    if (identificacao.casa_a_busca(alvo, servidor, usuario)) {
      achados.push(servidor);
      if (achados.length > limite) break;
    }
  }
  const [cortados, ha_mais] = _cortar(achados, limite);
  // a unidade que o template lê (`sv.unidade.nome_extenso`), carregada de uma vez
  const itens = cortados.length
    ? await tx.query.servidor.findMany({
        where: inArray(tabela_servidor.id, cortados.map((s) => s.id)),
        with: { unidade: true },
      })
    : [];
  const ordem = new Map(cortados.map((s, i) => [s.id, i]));
  itens.sort((a, b) => ordem.get(a.id)! - ordem.get(b.id)!);
  const destino = usuario.pode("processo.ver") ? `/servidores?q=${quote(q)}` : `/epis/fichas?q=${quote(q)}`;
  return { codigo: "servidor", rotulo: "Servidores", chaves: "nome e SIAPE", itens, ver_todos: destino, ha_mais };
}

/** NUP, observação, URL do SEI, número do laudo e o servidor — a consulta do repositório. */
async function _bloco_processo(tx: Executor, usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const [itens, ha_mais] = _cortar(await repo_processos.buscar(tx, usuario, q, limite), limite);
  return {
    codigo: "processo",
    rotulo: "Processos",
    chaves: "NUP, observação, link do SEI, número do laudo e servidor",
    itens,
    ver_todos: `/processos?q=${quote(q)}`,
    ha_mais,
  };
}

/**
 * Número SIAPE do laudo. Sem `aplicar_escopo`, e não por esquecimento:
 * `laudo_tecnico` não tem `campus_id` nem `servidor_id`, e `/laudos` também não
 * escopa.
 */
async function _bloco_laudo(tx: Executor, _usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const alvo = `%${q.trim()}%`;
  const linhas = await tx.query.laudo_tecnico.findMany({
    where: like(tabela_laudo.numero_siape, alvo),
    with: { unidade: true },
    orderBy: [desc(tabela_laudo.numero_siape)],
    limit: limite + 1,
  });
  const [itens, ha_mais] = _cortar(linhas, limite);
  return { codigo: "laudo", rotulo: "Laudos técnicos", chaves: "número do laudo", itens, ver_todos: `/laudos?q=${quote(q)}`, ha_mais };
}

/** O mesmo critério de `rotas/epi_requisicoes._casa_a_busca`: protocolo para todos, nome pela RN-19. */
function _casa_requisicao(
  requisicao: { protocolo: string | null; servidor: identificacao.ServidorBuscavel | null },
  alvo: string,
  usuario: UsuarioAtual,
): boolean {
  if (textos.chave_busca(requisicao.protocolo || "").includes(alvo)) return true;
  return identificacao.casa_a_busca(alvo, requisicao.servidor, usuario);
}

/** Protocolo e identificação de quem vai usar — a fila de `/epis/requisicoes`, do mais novo. */
async function _bloco_requisicao(tx: Executor, usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const alvo = textos.chave_busca(q);
  const ids = (await servico_requisicao.fila(tx, usuario)).map((r) => r.id);
  const carregadas = ids.length
    ? await tx.query.epi_requisicao.findMany({
        where: inArray(tabela_requisicao.id, ids),
        with: { servidor: true },
        orderBy: [desc(tabela_requisicao.id)],
      })
    : [];
  const achados: typeof carregadas = [];
  for (const requisicao of carregadas) {
    if (_casa_requisicao(requisicao, alvo, usuario)) {
      achados.push(requisicao);
      if (achados.length > limite) break;
    }
  }
  const [itens, ha_mais] = _cortar(achados, limite);
  return {
    codigo: "requisicao",
    rotulo: "Requisições de EPI",
    chaves: "protocolo e identificação do servidor",
    itens,
    ver_todos: `/epis/requisicoes?q=${quote(q)}`,
    ha_mais,
  };
}

/**
 * Código da turma (`TUR-2026-0007`), com o escopo de `/turmas`. `ILIKE`: o
 * `LIKE` do SQLite ignorava a caixa, o do Postgres não (DESVIOS.md).
 */
async function _bloco_turma(tx: Executor, usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const alvo = `%${q.trim()}%`;
  const linhas = await tx.query.turma.findMany({
    where: and(aplicar_escopo(usuario, tabela_turma), ilike(tabela_turma.codigo, alvo)),
    with: { treinamento: true },
    orderBy: [desc(tabela_turma.ano), desc(tabela_turma.numero)],
    limit: limite + 1,
  });
  const [itens, ha_mais] = _cortar(linhas, limite);
  // `/turmas` filtra por situação e treinamento, não por texto: mandar o termo
  // para lá abriria a lista inteira fingindo ter buscado
  return { codigo: "turma", rotulo: "Turmas", chaves: "código da turma", itens, ver_todos: "/turmas", ha_mais };
}

const RE_NUMERO_ANO = /^\s*(\d{1,6})\s*(?:\/\s*(\d{4}))?\s*$/;

/**
 * Número (`12/2026`) e chave de validação, com o escopo de `/certificados`. A
 * chave é comparada por IGUALDADE: busca parcial sobre segredo é enumeração.
 */
async function _bloco_certificado(tx: Executor, usuario: UsuarioAtual, q: string, limite: number): Promise<Bloco> {
  const condicoes: SQL[] = [eq(tabela_certificado.chave_validacao, normalizar_chave(q))];
  const casa = RE_NUMERO_ANO.exec(q);
  if (casa) {
    const numero = eq(tabela_certificado.numero, Number(casa[1]));
    condicoes.push(casa[2] ? and(numero, eq(tabela_certificado.ano, Number(casa[2])))! : numero);
  }
  const linhas = await tx.query.certificado.findMany({
    where: and(aplicar_escopo(usuario, tabela_certificado), or(...condicoes)),
    with: { treinamento: true },
    orderBy: [desc(tabela_certificado.ano), desc(tabela_certificado.numero)],
    limit: limite + 1,
  });
  const [cortados, ha_mais] = _cortar(linhas, limite);
  const itens = cortados.map((c) => ({ ...c, rotulo: Certificado.rotulo(c) }));
  return {
    codigo: "certificado",
    rotulo: "Certificados",
    chaves: "número e chave de validação",
    itens,
    ver_todos: `/certificados?busca=${quote(q)}`,
    ha_mais,
  };
}

type Montador = (tx: Executor, usuario: UsuarioAtual, q: string, limite: number) => Promise<Bloco>;

// A ordem é a da tela, e é a ordem da pergunta: quem digita um nome procura uma
// pessoa; quem digita um número procura o documento dela.
const _BLOCOS: readonly (readonly [string, Montador])[] = [
  ["servidor", _bloco_servidor],
  ["processo", _bloco_processo],
  ["laudo", _bloco_laudo],
  ["requisicao", _bloco_requisicao],
  ["turma", _bloco_turma],
  ["certificado", _bloco_certificado],
];

// O nome de cada bloco em português corrido, para a frase "procurei em …".
export const ROTULO_POR_BLOCO: Readonly<Record<string, string>> = {
  servidor: "servidores",
  processo: "processos",
  laudo: "laudos",
  requisicao: "requisições de EPI",
  turma: "turmas",
  certificado: "certificados",
};

/**
 * O que a busca cobre PARA ESTA PESSOA, em português. Nunca diz o que ficou de
 * fora: "não achei" e "você não pode ver" têm de ser indistinguíveis de fora.
 */
export function cobertura(usuario: UsuarioAtual): string[] {
  return _BLOCOS.filter(([codigo]) => _visivel(usuario, codigo)).map(([codigo]) => ROTULO_POR_BLOCO[codigo]!);
}

/**
 * Uma consulta por bloco, e só nos blocos que esta pessoa pode ver — consultar o
 * que não vai ser mostrado é o caminho mais curto para instrumentar o tempo de
 * resposta.
 */
export async function buscar(
  tx: Executor,
  usuario: UsuarioAtual,
  q: string | null | undefined,
  limite = LIMITE_POR_BLOCO,
): Promise<Bloco[]> {
  const limpo = (q ?? "").trim();
  if (!limpo || textos.parece_cpf(limpo)) return [];
  const blocos: Bloco[] = [];
  // em sequência, e não `Promise.all`: a transação da requisição é UMA conexão
  for (const [codigo, montar] of _BLOCOS) {
    if (_visivel(usuario, codigo)) blocos.push(await montar(tx, usuario, limpo, limite));
  }
  return blocos;
}

// a caixa do cabeçalho (`busca_visivel` do `base.html`)
ganchos.podeBuscar = (usuario) => pode_buscar(usuario);
