/**
 * Envia UM e-mail de teste com a configuração de e-mail do ambiente e diz o
 * resultado — para conferir o SMTP antes de depender dele.
 *
 *     npm run testar-email -- --para voce@ufvjm.edu.br
 *
 * Lê `CSSO_SMTP_URL`, `CSSO_EMAIL_REMETENTE` e `CSSO_EMAIL_RESPONDER_PARA` do
 * ambiente (ou de `nuvem/.env`). Não toca no banco nem na fila. Imprime o
 * servidor, a porta e o protocolo, e o resultado; NUNCA a senha, o usuário nem
 * a URL inteira — o texto de qualquer erro do nodemailer passa por
 * `sem_segredos` antes de aparecer.
 *
 * Saída: 0 = enviado; 1 = uso errado; 2 = não configurado; 3 = o SMTP recusou.
 */
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";

export interface Saida {
  log: (linha: string) => void;
  erro: (linha: string) => void;
}

const SAIDA_PADRAO: Saida = { log: (l) => console.log(l), erro: (l) => console.error(l) };

function valor(argv: string[], nome: string): string | null {
  const i = argv.indexOf(nome);
  if (i >= 0) return argv[i + 1] ?? null;
  const junto = argv.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : null;
}

export async function principal(argv: string[], saida: Saida = SAIDA_PADRAO): Promise<number> {
  carregarEnvLocal();
  const email = await import("../src/servicos/email.js");
  const para = (valor(argv, "--para") ?? "").trim();
  if (!para || !email.email_valido(para)) {
    saida.erro("uso: npm run testar-email -- --para <e-mail que vai receber o teste>");
    return 1;
  }
  const faltam = email.variaveis_faltando();
  if (faltam.length) {
    saida.erro(`Envio NÃO configurado. Faltam as variáveis de ambiente: ${faltam.join(", ")}.`);
    saida.erro("Veja PRODUCAO.md, «Configurar o envio de e-mail».");
    return 2;
  }
  const smtp = email.descrever_smtp();
  if (!smtp || !smtp.valida) {
    saida.erro("CSSO_SMTP_URL não é uma URL smtp:// ou smtps:// válida (o «@» do usuário vira %40).");
    return 2;
  }
  saida.log(`Servidor:   ${smtp.servidor}`);
  saida.log(`Porta:      ${smtp.porta} (${smtp.protocolo === "smtps" ? "TLS desde a conexão" : "STARTTLS"})`);
  saida.log(`Login:      ${smtp.com_login ? "usuário e senha informados (não exibidos)" : "SEM usuário/senha na URL"}`);
  saida.log(`Remetente:  ${(process.env.CSSO_EMAIL_REMETENTE ?? "").trim()}`);
  saida.log(`Destino:    ${para}`);
  const falha_da_conexao = await email.verificar_smtp();
  if (falha_da_conexao) {
    saida.erro(`FALHOU ao conectar/entrar no SMTP: ${falha_da_conexao}`);
    return 3;
  }
  saida.log("Conexão e login no SMTP: ok.");
  try {
    await email.enviar_agora({
      para,
      assunto: "Teste de e-mail — Sistema SISA · UFVJM",
      texto:
        "Olá.\n\nEste é um e-mail de teste do Sistema SISA. Se você o recebeu, o envio de e-mail está " +
        "configurado corretamente.\n\nSuperintendência Integrada de Saúde (Sisa) — UFVJM\n",
      anexos: [],
    });
  } catch (erro) {
    saida.erro(`FALHOU ao enviar: ${email.sem_segredos(erro instanceof Error ? erro.message : String(erro))}`);
    return 3;
  }
  saida.log("ENVIADO. Confira a caixa de entrada (e o spam) de " + para + ".");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
