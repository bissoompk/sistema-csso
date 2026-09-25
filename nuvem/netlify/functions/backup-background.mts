/**
 * O backup diário: função de FUNDO do Netlify (sufixo `-background`, limite
 * de 15 min). Faz o backup cifrado (`servicos/backup.ts`) e aplica a
 * retenção da POLITICA_RETENCAO §4 (`servicos/rotinas.ts`).
 *
 * Quem chama é a função agendada `rotina-noturna`. A URL desta função é
 * pública (`/.netlify/functions/backup-background`) e o Netlify responde 202
 * a qualquer um antes de o código rodar — então o código confere o segredo
 * `CSSO_ROTINA_SEGREDO` (cabeçalho `x-csso-rotina`, comparação em tempo
 * constante) e, sem ele, sai sem tocar no banco. Sem isso, qualquer pessoa na
 * internet faria o sistema gerar backups (e custo) em laço.
 */
import { timingSafeEqual } from "node:crypto";
import type { Config } from "@netlify/functions";
import { fecharBanco, obterBanco } from "../../src/db/cliente.js";
import { backup_diario } from "../../src/servicos/rotinas.js";

export function segredoConfere(recebido: string | null, esperado: string | undefined): boolean {
  if (!esperado || esperado.length < 32 || !recebido) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req: Request) => {
  if (req.method !== "POST" || !segredoConfere(req.headers.get("x-csso-rotina"), process.env.CSSO_ROTINA_SEGREDO)) {
    console.warn("[backup-background] chamada recusada: sem o segredo da rotina");
    return;
  }
  try {
    const r = await backup_diario(obterBanco());
    (r.ok ? console.log : console.error)(`[backup-background] ${r.ok ? "ok" : "FALHA"} em ${r.ms} ms: ${r.detalhe}`);
  } finally {
    await fecharBanco();
  }
};

export const config: Config = {
  background: true,
};
