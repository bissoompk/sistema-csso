/**
 * /saude, /saude/detalhe e /saude/db — o que a porta responde a quem não entrou.
 * Porte de `app/rotas/saude.py`.
 *
 * - **`/saude`** é a única sem autenticação, e diz uma coisa só: o processo está
 *   de pé. Sem versão, sem avisos de configuração — e sem tocar no banco.
 * - **`/saude/detalhe`** entrega versão, ambiente e avisos a quem entrou.
 * - **`/saude/db`** conta processos e pareceres e confere o banco, para quem
 *   opera a máquina ou responde pela trilha.
 */
import { Hono } from "hono";
import { count, sql } from "drizzle-orm";
import type { Ambiente } from "../nucleo/contexto.js";
import { obterConfig, VERSAO } from "../config.js";
import { usuarioLogado } from "../dependencias.js";
import { PermissaoNegada } from "../servicos/rbac.js";
import { parecer_tecnico, processo } from "../db/esquema/index.js";

export const rotas = new Hono<Ambiente>();

// Quem confere a saúde do banco: quem opera a máquina ou quem responde pela
// trilha — a mesma repartição de `/config`. Qualquer uma das duas basta.
export const PERMISSOES_SAUDE_DB: readonly string[] = ["backup.executar", "auditoria.ver"];

rotas.get("/saude", (c) => c.json({ status: "ok" }));

rotas.get("/saude/detalhe", async (c) => {
  await usuarioLogado(c);
  const cfg = obterConfig();
  return c.json({ status: "ok", versao: VERSAO, ambiente: cfg.ambiente, avisos: cfg.inseguro });
});

rotas.get("/saude/db", async (c) => {
  const usuario = await usuarioLogado(c);
  if (!PERMISSOES_SAUDE_DB.some((codigo) => usuario.pode(codigo))) {
    throw new PermissaoNegada(
      PERMISSOES_SAUDE_DB[0]!,
      "A conferência do banco abre para quem opera a máquina " +
        "(`backup.executar`) ou responde pela trilha (`auditoria.ver`).",
    );
  }
  const tx = c.get("tx");
  const [p] = await tx.select({ n: count() }).from(processo);
  const [q] = await tx.select({ n: count() }).from(parecer_tecnico);
  // DESVIO: o Python rodava `PRAGMA integrity_check` do SQLite. O Postgres do
  // Supabase não tem equivalente barato (a integridade física é do provedor);
  // o que se confere aqui é que o banco responde e que as travas de
  // append-only (`travas.sql`) estão instaladas — é o que este sistema, e não
  // o provedor, tem a garantir. Ver DESVIOS.md.
  const travas = await tx.execute(
    sql`select count(*)::int as n from pg_trigger where not tgisinternal`,
  );
  const n = Number((travas as unknown as { n: number }[])[0]?.n ?? 0);
  const ok = n > 0;
  return c.json({
    status: ok ? "ok" : "falha",
    integrity_check: ok ? "ok" : "nenhuma trava (trigger) instalada: rode `npm run db:migrar`",
    processos: Number(p?.n ?? 0),
    pareceres: Number(q?.n ?? 0),
    versao: VERSAO,
  });
});
