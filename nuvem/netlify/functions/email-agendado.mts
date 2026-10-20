/**
 * A reserva do envio de e-mail: função AGENDADA (a cada 10 min, limite de
 * 30 s). Pega o que a de fundo não pegou — a nova tentativa depois de uma
 * falha, o pedido que chegou com ela já desistindo. Fila vazia custa uma
 * consulta.
 */
import type { Config } from "@netlify/functions";
import { obterBanco } from "../../src/db/cliente.js";
import * as email from "../../src/servicos/email.js";
import "../../src/servicos/envio_certificado.js";

export default async () => {
  const r = await email.processar_fila(obterBanco(), { prazo_ms: 20_000, limite: 30 });
  if (r.enviados || r.falhas) console.log(`[email-agendado] ${r.enviados} enviado(s), ${r.falhas} falha(s)`);
  return new Response(r.desligado ? "envio desligado" : `${r.enviados} enviado(s), ${r.falhas} falha(s)`);
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
