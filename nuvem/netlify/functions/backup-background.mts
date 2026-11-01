/**
 * O backup diário: função de FUNDO do Netlify (sufixo `-background`, limite
 * de 15 min). Faz o backup cifrado (`servicos/backup.ts`) e aplica a
 * retenção da POLITICA_RETENCAO §4 (`servicos/rotinas.ts`).
 *
 * Depois do backup roda as rotinas leves (sessões, pendências, cadeia da trilha,
 * expurgos de privacidade): na função agendada o teto é de 30 s, e a cadeia e os
 * expurgos crescem com a base; aqui o teto é de 15 min. Uma falha do backup não
 * impede as rotinas, nem o contrário: cada passo fica em `rotina_execucao`.
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
import { backup_diario, rotinas_noturnas } from "../../src/servicos/rotinas.js";

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
    try {
      const r = await backup_diario(obterBanco());
      (r.ok ? console.log : console.error)(`[backup-background] ${r.ok ? "ok" : "FALHA"} em ${r.ms} ms: ${r.detalhe}`);
    } catch (erro) {
      console.error(`[backup-background] FALHA no backup: ${(erro as Error).message}`);
    }
    const resumo = await rotinas_noturnas(obterBanco());
    const linhas = resumo.passos.map((p) => `${p.ok ? "ok" : "FALHA"} ${p.rotina}: ${p.detalhe}`);
    (resumo.ok ? console.log : console.error)(`[backup-background] rotinas: ${linhas.join(" | ")}`);
  } finally {
    await fecharBanco();
  }
};

export const config: Config = {
  background: true,
};
