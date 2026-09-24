// temporário (agente EPI): monta o banco csso_epi para navegar; apagar depois
import { recriar, povoar } from "./ambiente-teste.js";
import { povoar_epi } from "./povoar/epi.js";
const url = process.env.DATABASE_URL!;
await recriar(url);
const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
const { semear } = await import("../src/servicos/sementes.js");
const { carregar_usuario_atual } = await import("../src/servicos/rbac.js");
const e = await import("../src/db/esquema/index.js");
const { eq } = await import("drizzle-orm");
const resumo: Record<string, number> = {};
await obterBanco(url).transaction(async (tx) => {
  await semear(tx);
  Object.assign(resumo, await povoar(tx));
  const atual = async (login: string) => {
    const [u] = await tx.select().from(e.usuario).where(eq(e.usuario.login, login));
    return carregar_usuario_atual(tx, u!.id);
  };
  await povoar_epi(tx, { atual, resumo });
});
await fecharBanco();
console.log(resumo);
