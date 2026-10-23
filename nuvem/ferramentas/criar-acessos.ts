/**
 * Cria o acesso de todos os servidores ATIVOS com e-mail institucional que
 * ainda não têm conta (22/10/2026: não há separação entre servidor e conta).
 *
 *     npm run criar-acessos -- --simular
 *     npm run criar-acessos
 *
 * A conta nasce com o perfil de titular e SEM senha utilizável: o servidor a
 * define por "Ativar meu acesso" ou "Esqueci minha senha". Nenhum e-mail é
 * enviado. Idempotente: quem já tem conta (ou cujo e-mail já é de outra) fica
 * como está. Em `--simular` tudo é feito e DESFEITO no fim, com o relatório.
 */
import { carregarEnvLocal } from "./env-local.js";

carregarEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente.");
  process.exit(1);
}
const simular = process.argv.includes("--simular");
const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
const { servidor } = await import("../src/db/esquema/index.js");
const { eq, asc } = await import("drizzle-orm");
const ativar_acesso = await import("../src/servicos/ativar_acesso.js");

class Desfazer extends Error {}
const contagem: Record<string, number> = {};
try {
  await obterBanco()
    .transaction(async (tx) => {
      const ativos = await tx.select().from(servidor).where(eq(servidor.situacao, "ATIVO")).orderBy(asc(servidor.id));
      for (const sv of ativos) {
        const r = await tx.transaction((sp) =>
          ativar_acesso.garantir_acesso(sp, sv, { usuario_nome: "ferramenta criar-acessos" }),
        );
        contagem[r] = (contagem[r] ?? 0) + 1;
      }
      if (simular) throw new Desfazer();
    })
    .catch((e) => {
      if (!(e instanceof Desfazer)) throw e;
    });
  const rotulo: Record<string, string> = {
    criada: "acessos criados",
    ja_tem_conta: "já tinham conta",
    sem_email: "sem e-mail institucional (nada criado)",
    recusada: "recusados (e-mail em conflito)",
    fora_do_quadro: "fora do quadro",
  };
  for (const [k, v] of Object.entries(contagem)) console.log(`[acessos] ${v} ${rotulo[k] ?? k}`);
  console.log(simular ? "[acessos] SIMULAÇÃO: nada foi gravado." : "[acessos] gravado.");
} finally {
  await fecharBanco();
}
