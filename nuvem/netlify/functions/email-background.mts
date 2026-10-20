/**
 * O envio de e-mail: função de FUNDO do Netlify (limite de 15 min), acordada
 * por `email.acordar_envio` logo depois de um pedido de envio.
 *
 * Quem a acorda ainda está dentro da transação do pedido: a linha da caixa
 * pode não estar gravada quando ela chega. Por isso, fila vazia não é fim —
 * ela olha de novo por um minuto antes de desistir (a agendada
 * `email-agendado` pega o que sobrar).
 *
 * A URL é pública, como a do backup: sem o segredo da rotina, sai sem tocar
 * no banco.
 */
import type { Config } from "@netlify/functions";
import { fecharBanco, obterBanco } from "../../src/db/cliente.js";
import * as email from "../../src/servicos/email.js";
// registra o anexo do certificado na caixa
import "../../src/servicos/envio_certificado.js";
import { segredoConfere } from "./backup-background.mjs";

const ESPERA_MS = 5_000;
const OLHAR_POR_MS = 60_000;

export default async (req: Request) => {
  if (req.method !== "POST" || !segredoConfere(req.headers.get("x-csso-rotina"), process.env.CSSO_ROTINA_SEGREDO)) {
    console.warn("[email-background] chamada recusada: sem o segredo da rotina");
    return;
  }
  const db = obterBanco();
  const inicio = Date.now();
  let enviados = 0;
  let falhas = 0;
  try {
    while (Date.now() - inicio < 10 * 60_000) {
      const r = await email.processar_fila(db, { prazo_ms: 60_000, limite: 200 });
      if (r.desligado) {
        console.warn("[email-background] envio desligado (CSSO_SMTP_URL/CSSO_EMAIL_REMETENTE)");
        break;
      }
      enviados += r.enviados;
      falhas += r.falhas;
      if (r.enviados + r.falhas === 0) {
        if (Date.now() - inicio > OLHAR_POR_MS) break;
        await new Promise((ok) => setTimeout(ok, ESPERA_MS));
      }
    }
    console.log(`[email-background] ${enviados} enviado(s), ${falhas} falha(s)`);
  } finally {
    await fecharBanco();
  }
};

export const config: Config = {
  background: true,
};
