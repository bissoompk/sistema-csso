/**
 * RN-19 num lugar só: como o servidor aparece na tela.
 * Porte de `app/servicos/identificacao.py`.
 *
 * Tela nenhuma decide: ela chama `identificar(...)` e recebe pronto o que pode
 * escrever. O segundo caminho do nome — o TEXTO LIVRE que o sistema gravou na
 * trilha e na pendência — é tratado por `texto_livre()`, que suprime a frase
 * inteira em vez de raspar o nome de dentro dela (ver o Python para o
 * argumento completo).
 */
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

/**
 * O nome do cookie de sessão — o `autenticacao.COOKIE_SESSAO`.
 *
 * Escrito aqui, e não importado, porque `web.ts` importa este módulo (para os
 * globais `identificar`/`texto_livre`) e `autenticacao.ts` importa `web.ts`
 * (para o global `POLITICA_SENHA`): o import fecharia o ciclo
 * web -> identificacao -> autenticacao -> web, e o `global(...)` de
 * autenticacao rodaria antes de o ambiente Nunjucks existir. Um teste
 * (`identificacao.test.ts`) confere que os dois valores são o mesmo.
 */
export const COOKIE_SESSAO = "csso_sessao";

// Não há servidor vinculado — nada a suprimir, nada a revelar.
export const SEM_SERVIDOR = "—";

// O que fica no lugar da frase suprimida. "—" se leria como "não houve
// descrição"; isto diz que há texto e que ele foi escondido.
export const TEXTO_SUPRIMIDO = "conteúdo suprimido (RN-19)";

/**
 * O que a tela pode escrever sobre a pessoa, já decidido. `nome` NUNCA é o
 * nome real quando `nominal` é falso: é o identificador opaco — o template que
 * só imprime `{{ identificar(x) }}` não consegue vazar nem esquecendo de olhar
 * `nominal` (o `toString` devolve `nome`).
 */
export class Identificacao {
  constructor(
    readonly nominal: boolean,
    readonly nome: string,
    readonly siape: string,
    readonly servidor_id: number | null = null,
  ) {
    Object.freeze(this);
  }

  toString(): string {
    return this.nome;
  }

  /** 'Fulano · SIAPE 1110654' — a forma do cadastro de servidores. */
  get com_siape(): string {
    if (this.nominal && this.siape) return `${this.nome} · SIAPE ${this.siape}`;
    return this.nome;
  }

  /** Há alguém ali e o nome foi escondido — diferente de não haver ninguém. */
  get suprimida(): boolean {
    return !this.nominal && this.servidor_id !== null;
  }
}

/** O que `semente_de` precisa do pedido: o cookie de sessão. */
export type PedidoComCookies =
  | { cookies: { get(nome: string): string | null | undefined } }
  | null
  | undefined;

/**
 * A semente do identificador opaco é o prefixo do cookie de sessão: dentro
 * da mesma sessão o mesmo servidor recebe sempre o mesmo `SRV-xxxx`, e entre
 * sessões (e entre usuários) o código muda — ninguém monta dossiê estável.
 *
 * No Python vinha do `Request` do Starlette; aqui aceita o `request` que os
 * templates recebem (`requestParaTemplate`, que tem `cookies.get`) — a rota
 * que só tem o `Ctx` do Hono usa `sementeDoContexto` de `web.ts`.
 */
export function semente_de(request: PedidoComCookies): string {
  if (!request) return "";
  return (request.cookies.get(COOKIE_SESSAO) || "").slice(0, 16);
}

/**
 * `exposicao.ver` (ou `epi.ficha`) — ou ser o próprio titular. O titular
 * vendo o próprio nome não é vazamento: é a consulta do art. 18, II da LGPD.
 */
export function pode_ver_nominal(usuario: UsuarioAtual | null | undefined, servidor_id: number | null | undefined): boolean {
  if (!usuario) return false;
  if (usuario.ve_dado_nominal) return true;
  return servidor_id !== null && servidor_id !== undefined && usuario.servidor_id === servidor_id;
}

export interface ServidorBuscavel {
  id?: number | null;
  nome: string;
  siape?: string | null;
  email?: string | null;
}

/**
 * RN-19 do lado do FILTRO: o nome só casa para quem pode ver AQUELE nome. O
 * SIAPE vale para todo mundo; o e-mail entra na classe do nome. `alvo` vem
 * normalizado por `textos.chave_busca`.
 */
export function casa_a_busca(
  alvo: string,
  servidor: ServidorBuscavel | null | undefined,
  usuario: UsuarioAtual | null | undefined,
): boolean {
  if (!servidor) return false;
  if ((servidor.siape || "").includes(alvo)) return true;
  if (!pode_ver_nominal(usuario, servidor.id ?? null)) return false;
  return textos.chave_busca(servidor.nome).includes(alvo) || textos.chave_busca(servidor.email || "").includes(alvo);
}

/** O servidor, quem aponta para ele (processo, parecer, vigência) ou só o id. */
export type AlvoIdentificavel =
  | number
  | { servidor_id?: number | null; servidor?: ServidorBuscavel | null }
  | ServidorBuscavel
  | null
  | undefined;

/**
 * Aceita o `Servidor`, quem aponta para ele ou só o id — a tela às vezes tem
 * o objeto e às vezes só a chave.
 */
function resolver(alvo: AlvoIdentificavel): [ServidorBuscavel | null, number | null] {
  if (alvo === null || alvo === undefined) return [null, null];
  if (typeof alvo === "number") return [null, alvo];
  if (typeof alvo === "object" && ("servidor_id" in alvo || "servidor" in alvo)) {
    const a = alvo as { servidor_id?: number | null; servidor?: ServidorBuscavel | null };
    return [a.servidor ?? null, a.servidor_id ?? null];
  }
  const s = alvo as ServidorBuscavel;
  return [s, s.id ?? null];
}

/**
 * RN-19 na PROSA: a `descricao` da trilha e a da pendência. Suprime a frase
 * inteira, e não o nome dentro dela; não reescreve nada (a descrição entra no
 * digest da cadeia). `sobre` é de quem é o texto, quando a tela sabe.
 */
export function texto_livre(
  texto: string | null | undefined,
  usuario: UsuarioAtual | null | undefined,
  opcoes: { sobre?: AlvoIdentificavel; vazio?: string } = {},
): string {
  if (!texto) return opcoes.vazio ?? SEM_SERVIDOR;
  const [, servidor_id] = resolver(opcoes.sobre);
  if (pode_ver_nominal(usuario, servidor_id)) return texto;
  return TEXTO_SUPRIMIDO;
}

export function identificar(
  alvo: AlvoIdentificavel,
  usuario: UsuarioAtual | null | undefined,
  semente: string,
  opcoes: { vazio?: string } = {},
): Identificacao {
  let [servidor, servidor_id] = resolver(alvo);
  if (servidor !== null && servidor_id === null) servidor_id = servidor.id ?? null;
  if (servidor === null && servidor_id === null) {
    return new Identificacao(false, opcoes.vazio ?? SEM_SERVIDOR, "");
  }
  if (servidor !== null && pode_ver_nominal(usuario, servidor_id)) {
    return new Identificacao(true, servidor.nome, servidor.siape || "", servidor_id);
  }
  // Sem o objeto carregado sobra o id, e com o id só dá para o código opaco —
  // que é o lado seguro do erro.
  return new Identificacao(false, textos.identificador_opaco(servidor_id, semente), "", servidor_id);
}
