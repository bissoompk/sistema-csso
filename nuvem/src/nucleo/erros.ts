/**
 * As recusas que atravessam camadas. Cada uma vira resposta num único lugar,
 * o `onError` de `src/app.ts` — o equivalente dos `exception_handler` do
 * `principal.py`.
 */

/** Sem sessão (ou sessão expirada): volta para o login com o destino. */
export class RedirecionaParaLogin extends Error {
  constructor(public destino = "/login") {
    super("sessao ausente");
  }
}

/** Falta permissão de RBAC. Na API vira 403 em JSON; na tela, a tela de erro. */
export class PermissaoNegada extends Error {
  constructor(
    public codigo: string,
    mensagem?: string,
  ) {
    super(mensagem ?? `Permissão necessária: ${codigo}`);
  }
}

/** O `HTTPException` do FastAPI: status + detalhe. */
export class ErroHttp extends Error {
  constructor(
    public status: number,
    public detalhe: string = "",
  ) {
    super(detalhe || String(status));
  }
}

/** A recusa da `/api/v1`: `{erro, motivos}` com o status escolhido. */
export class RecusaDaApi extends Error {
  constructor(
    public status: number,
    public erro: string,
    public motivos: string[] = [],
  ) {
    super(erro);
  }
}

/** Recusa de regra de negócio levantada por serviço (o `ValueError` do Python). */
export class RegraViolada extends Error {}
