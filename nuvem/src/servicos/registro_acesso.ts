/**
 * Registro de acesso HTTP: quem bateu na porta, de onde, quando e com o que
 * saiu de lá. Porte de `app/registro_acesso.py` — lá um arquivo com rotação
 * diária, aqui a tabela `registro_acesso` (`db/esquema/privacidade.ts`).
 *
 * Não substitui a trilha de auditoria, e não é substituído por ela: a trilha
 * responde "quem fez o quê", `acesso_dado_sensivel` responde "quem leu o dado
 * de quem", e isto responde "quem bateu na porta" — a varredura de
 * `/anexos/1`, `/anexos/2`... não é ato de negócio e não deixava rastro.
 *
 * NUNCA entram (a regra é do ROPA §0.3, não preferência de quem escreveu):
 * nome, SIAPE, login, e-mail, conteúdo de formulário, corpo, query string, nem
 * o caminho concreto. A rota vai na FORMA (`/servidores/{id}`): o par (IP, 12)
 * é o cruzamento que o `SRV-xxxx` existe para impedir. Caminho que não casou
 * rota nenhuma sai como `-` — é texto escrito por quem chamou.
 *
 * Entram: identificador de correlação, endereço de origem, id numérico da
 * conta, método, forma da rota, status e duração.
 *
 * **Por que tabela e não `console.log`.** O log de função do Netlify é
 * guardado pela plataforma, nos EUA, com prazo que o setor não controla e sem
 * o RBAC do sistema. A tabela fica no mesmo banco (São Paulo), sob RLS, entra
 * no backup cifrado e tem o expurgo abaixo.
 *
 * **Retenção: `CSSO_LOG_RETENCAO_DIAS` (padrão 90), o MESMO prazo de
 * `sessao`**, pelo motivo do Python: as duas guardam o mesmo IP, e dois prazos
 * para o mesmo dado seria política que se contradiz. O Marco Civil (art. 15,
 * seis meses) obriga o provedor de aplicação "com fins econômicos", e a
 * POLITICA_RETENCAO §2.5, item 2, já registra a dúvida de que alcance uma
 * autarquia federal — é pergunta do encarregado com a procuradoria, e a
 * resposta, se vier "seis meses", é `CSSO_LOG_RETENCAO_DIAS=180` (vale para as
 * duas tabelas de uma vez). O prazo é cumprido pelo mecanismo
 * (`expurgar_registro_acesso`, na rotina noturna), não só declarado.
 */
import { randomBytes } from "node:crypto";
import { lt } from "drizzle-orm";
import type { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import { obterBanco } from "../db/cliente.js";
import { registro_acesso } from "../db/esquema/index.js";
import { log_retencao_dias } from "./autenticacao.js";

/** Desligável (`CSSO_LOG_ACESSO=nao`), como o `cfg.log_acesso` do Python. */
export function registro_ligado(): boolean {
  return !["nao", "não", "0", "false"].includes((process.env.CSSO_LOG_ACESSO ?? "").trim().toLowerCase());
}

/**
 * A rota com o nome do parâmetro no lugar do valor, ou `-`.
 * `/processos/:processo_id{[0-9]+}` → `/processos/{processo_id}`.
 */
export function forma_da_rota(c: Ctx): string {
  let rotas: { method: string; path: string }[];
  try {
    rotas = matchedRoutes(c);
  } catch {
    return "-";
  }
  // os middlewares são `*`; o que sobra no fim é a rota que respondeu
  const alvo = [...rotas].reverse().find((r) => r.path !== "*" && r.path !== "/*");
  if (!alvo) return "-";
  return alvo.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\{[^}]*\})?/g, "{$1}").slice(0, 200);
}

/** O endereço de origem. Só o cabeçalho que o Netlify põe — o resto é forjável. */
export function ip_de(c: Ctx): string {
  return (c.req.header("x-nf-client-connection-ip") ?? "-").trim().slice(0, 64) || "-";
}

async function gravar(linha: typeof registro_acesso.$inferInsert): Promise<void> {
  try {
    await obterBanco().insert(registro_acesso).values(linha);
  } catch (erro) {
    // a linha nunca vai para o log da plataforma: só o tipo da falha
    const codigo = (erro as { code?: string; cause?: { code?: string } }).cause?.code ?? (erro as { code?: string }).code;
    console.error(`registro de acesso nao gravado (${(erro as Error).name}${codigo ? ` ${codigo}` : ""})`);
  }
}

/**
 * O middleware. Registrado PRIMEIRO em `criarApp` (o mais externo): a duração
 * é a da requisição inteira e o status é o que de fato saiu — inclusive o 403
 * e o 404 que o `onError`/`notFound` montam.
 *
 * Grava FORA da transação da requisição (que já terminou quando isto roda):
 * requisição que falhou e foi desfeita é justamente a que mais interessa, e
 * sairia do registro junto com o ROLLBACK. Na função do Netlify a gravação vai
 * para `waitUntil` e não atrasa a resposta; sem ele (testes, servidor local),
 * espera.
 */
export function instalarRegistroDeAcesso(app: Hono<Ambiente>): void {
  app.use("*", async (c, next) => {
    if (!registro_ligado() || new URL(c.req.url).pathname.startsWith("/estaticos/")) return next();
    const req = randomBytes(4).toString("hex");
    const inicio = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res?.status ?? 500;
    } finally {
      const linha = {
        req,
        ip: ip_de(c),
        conta_id: c.get("conta_id") ?? null,
        metodo: c.req.method.slice(0, 8),
        rota: forma_da_rota(c),
        status,
        duracao_ms: Math.round(performance.now() - inicio),
      };
      const gravando = gravar(linha);
      let adiado = false;
      try {
        c.executionCtx.waitUntil(gravando);
        adiado = true;
      } catch {
        // sem contexto de execução: espera
      }
      if (!adiado) await gravando;
    }
  });
}

/** Apaga o que passou do prazo. Devolve quantas linhas. */
export async function expurgar_registro_acesso(tx: Executor, dias: number = log_retencao_dias()): Promise<number> {
  const limite = new Date(Date.now() - Math.max(1, dias) * 86_400_000);
  const apagadas = await tx.delete(registro_acesso).where(lt(registro_acesso.momento, limite)).returning({ id: registro_acesso.id });
  return apagadas.length;
}
