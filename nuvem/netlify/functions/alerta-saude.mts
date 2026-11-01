/**
 * O aviso diário de saúde: função AGENDADA (limite de 30 s), 07h em Brasília.
 *
 * Separada da `rotina-noturna` de propósito: se a rotina noturna parar, quem
 * dá pela falta é esta. Confere os alertas de `/saude/db` (backup, rotinas,
 * cadeia da trilha, caixa de e-mail) e, havendo algum, manda UM e-mail para
 * `CSSO_ALERTA_EMAIL`; em seguida empurra a fila para ele sair já.
 * Sem alerta ou sem endereço configurado, não faz nada.
 */
import type { Config } from "@netlify/functions";
import { obterBanco } from "../../src/db/cliente.js";
import { avisar_administracao } from "../../src/servicos/alertas_saude.js";
import * as email from "../../src/servicos/email.js";

export default async () => {
  const banco = obterBanco();
  const r = await banco.transaction((tx) => avisar_administracao(tx));
  if (!r.enviado) return new Response(`nada enviado: ${r.motivo}`);
  const fila = await email.processar_fila(banco, { prazo_ms: 15_000, limite: 5 });
  console.error(`[alerta-saude] ${r.alertas} alerta(s); e-mail: ${fila.enviados} enviado(s), ${fila.falhas} falha(s)`);
  return new Response(`${r.alertas} alerta(s) avisado(s)`);
};

export const config: Config = {
  schedule: "0 10 * * *",
};
