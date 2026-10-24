/**
 * O tipo do contexto do Hono neste sistema: o que toda rota encontra pronto.
 *
 * - `tx`: a transação da requisição (o `SessaoDep` do FastAPI). Abre antes da
 *   rota e dá COMMIT quando ela retorna normalmente; ROLLBACK quando ela lança.
 *   Recusa é retorno normal — a rota que escreveu e depois recusa precisa
 *   desfazer o que escreveu (ver `desfazer` abaixo), exatamente como no Python.
 * - `nonce`: a marca do `<script>` embutido desta resposta (CSP).
 */
import type { Context } from "hono";
import type { Tx } from "../db/cliente.js";
import type { UsuarioAtual } from "../servicos/rbac.js";

export type Variaveis = {
  tx: Tx;
  nonce: string;
  conta_id?: number;
  /** cache por requisição do usuário resolvido do cookie (`undefined` = ainda não resolvido) */
  usuario_resolvido?: UsuarioAtual | null;
  /** as pendências abertas lidas junto com a sessão, para o sino (`pendencias.ts`) */
  sino_antecipado?: { responsavel_id: number | null; prazo: string | null; concluida: boolean; tipo?: string }[];
  /** marcado por `desfazer()`: a rota pede ROLLBACK mesmo retornando normalmente */
  desfazer?: boolean;
  /**
   * O que só pode rodar DEPOIS do COMMIT da requisição (`depoisDoCommit`): o
   * arquivo que a limpeza deixou órfão sai do armazenamento só quando o banco
   * já não aponta para ele. Não roda no ROLLBACK.
   */
  depois_do_commit?: (() => Promise<void>)[];
};

export type Ambiente = { Variables: Variaveis };
export type Ctx = Context<Ambiente>;

/** Agenda `f` para depois do COMMIT da requisição (falha ali vai ao log, não à resposta). */
export function depoisDoCommit(c: Ctx, f: () => Promise<void>): void {
  c.set("depois_do_commit", [...(c.get("depois_do_commit") ?? []), f]);
}

/** O `s.rollback()` da recusa que já escreveu. */
export function desfazer(c: Ctx): void {
  c.set("desfazer", true);
}
