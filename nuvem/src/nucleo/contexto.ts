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
  /** marcado por `desfazer()`: a rota pede ROLLBACK mesmo retornando normalmente */
  desfazer?: boolean;
};

export type Ambiente = { Variables: Variaveis };
export type Ctx = Context<Ambiente>;

/** O `s.rollback()` da recusa que já escreveu. */
export function desfazer(c: Ctx): void {
  c.set("desfazer", true);
}
