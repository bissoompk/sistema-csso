/**
 * A rotina da madrugada: função AGENDADA do Netlify (limite de 30 s), que só ACORDA a
 * função de fundo.
 *
 * O que o Python fazia com o `csso-backup.timer` (22h30) e as Tarefas
 * Agendadas do Windows (`conferir_cadeia` 03h30, `varrer_pendencias` 03h45),
 * mais o `expurgar_sessoes` que rodava no boot — a nuvem não tem boot.
 *
 * Acorda a função de FUNDO `backup-background` (15 min), que faz o backup cifrado,
 * aplica a retenção e roda as rotinas leves (sessões, pendências de EPI, cadeia da
 * trilha, expurgos de privacidade). Nada disso cabe nos 30 s daqui quando a base
 * crescer; a chamada leva o segredo `CSSO_ROTINA_SEGREDO` num cabeçalho, porque a
 * função de fundo tem URL pública.
 *
 * Horário em UTC: 04h30 UTC = 01h30 em Brasília, longe do expediente.
 * Tudo fica em `rotina_execucao` (ver `/saude/db`); falha também vai para o
 * log da função no painel do Netlify.
 */
import type { Config, Context } from "@netlify/functions";

export const CABECALHO_SEGREDO = "x-csso-rotina";

async function acordarBackup(context: Context): Promise<string> {
  const segredo = process.env.CSSO_ROTINA_SEGREDO ?? "";
  if (segredo.length < 32) return "backup NÃO disparado: CSSO_ROTINA_SEGREDO ausente ou curto (mínimo 32)";
  const base = (context.site?.url || process.env.URL || "").replace(/\/+$/, "");
  if (!base) return "backup NÃO disparado: URL do site desconhecida";
  const r = await fetch(`${base}/.netlify/functions/backup-background`, {
    method: "POST",
    headers: { [CABECALHO_SEGREDO]: segredo },
    signal: AbortSignal.timeout(10_000),
  });
  // função de fundo responde 202 assim que é aceita; o resultado vai para rotina_execucao
  return r.status === 202 ? "backup disparado (202)" : `backup NÃO disparado: HTTP ${r.status}`;
}

export default async (_req: Request, context: Context) => {
  let disparo: string;
  try {
    disparo = await acordarBackup(context);
  } catch (erro) {
    disparo = `backup NÃO disparado: ${(erro as Error).message}`;
  }
  const falhou = disparo.includes("NÃO");
  (falhou ? console.error : console.log)(`[rotina-noturna] ${disparo}`);
  return new Response(disparo, { status: falhou ? 500 : 200 });
};

export const config: Config = {
  schedule: "30 4 * * *",
};
