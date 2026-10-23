/**
 * Acesso automático do servidor (`ativar_acesso.garantir_acesso`): cadastrar
 * servidor ativo com e-mail institucional cria a conta de titular, sem senha
 * utilizável e sem e-mail enviado; o titular a ativa pelo link e a conta que
 * já existe não é tocada.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as servico from "../src/servicos/ativar_acesso.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
  servico.ajuste.piso_ms = 0;
});

const EMAIL = "ana.lima@ufvjm.edu.br";
const ORIGEM = { usuario_nome: "teste" };

async function servidor(v: { siape?: string; email?: string | null; situacao?: string } = {}) {
  const [s] = await db
    .insert(e.servidor)
    .values({
      siape: v.siape ?? "2345678",
      nome: "Ana Lima",
      email: v.email === undefined ? EMAIL : v.email,
      situacao: v.situacao ?? "ATIVO",
    })
    .returning();
  return s!;
}

const contas_de = (email: string) => db.select().from(e.usuario).where(eq(e.usuario.email, email));

describe("garantir_acesso", () => {
  it("cria a conta de titular sem senha utilizável, ligada ao servidor, sem enviar e-mail", async () => {
    const s = await servidor();
    expect(await servico.garantir_acesso(db, s, ORIGEM)).toBe("criada");
    const [conta] = await contas_de(EMAIL);
    expect(conta!.login).toBe(EMAIL);
    expect(conta!.servidor_id).toBe(s.id);
    expect(conta!.senha_hash).toBe(servico.SEM_SENHA);
    const atrib = await db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, conta!.id), with: { perfil: true } });
    expect(atrib.map((a) => a.perfil.codigo)).toEqual(["servidor_consulta"]);
    expect(await db.select().from(e.email_saida)).toHaveLength(0);
    expect(await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.ACESSO_CRIADO_NO_CADASTRO))).toHaveLength(1);
  });

  it("nenhuma senha digitada entra na conta sem senha", async () => {
    const s = await servidor();
    await servico.garantir_acesso(db, s, ORIGEM);
    for (const senha of [servico.SEM_SENHA, "", "senha-qualquer-2026"]) {
      const r = await novoCliente().post("/login", { login: EMAIL, senha }, { seguir: false });
      expect(r.status).not.toBe(303);
    }
  });

  it("é idempotente", async () => {
    const s = await servidor();
    await servico.garantir_acesso(db, s, ORIGEM);
    expect(await servico.garantir_acesso(db, s, ORIGEM)).toBe("ja_tem_conta");
    expect(await contas_de(EMAIL)).toHaveLength(1);
  });

  it("não cria sem e-mail nem para quem não está ativo", async () => {
    expect(await servico.garantir_acesso(db, await servidor({ email: null }), ORIGEM)).toBe("sem_email");
    expect(await servico.garantir_acesso(db, await servidor({ siape: "3456789", email: "b@ufvjm.edu.br", situacao: "APOSENTADO" }), ORIGEM)).toBe("fora_do_quadro");
    expect(await db.select().from(e.usuario).where(eq(e.usuario.email, "b@ufvjm.edu.br"))).toHaveLength(0);
  });

  it("não toca na conta de equipe que já usa o mesmo e-mail", async () => {
    const [equipe] = await db.select().from(e.usuario).orderBy(asc(e.usuario.id)).limit(1);
    await db.update(e.usuario).set({ email: EMAIL }).where(eq(e.usuario.id, equipe!.id));
    const s = await servidor();
    expect(await servico.garantir_acesso(db, s, ORIGEM)).toBe("ja_tem_conta");
    const [depois] = await contas_de(EMAIL);
    expect(depois!.id).toBe(equipe!.id);
    expect(depois!.servidor_id).toBeNull();
  });
});

describe("ativação pelo titular", () => {
  it("o link define a primeira senha na conta que já existe, sem criar outra", async () => {
    const s = await servidor();
    await servico.garantir_acesso(db, s, ORIGEM);
    await cliente.post("/ativar-acesso", { siape: s.siape, email: EMAIL }, { cabecalhos: { "x-nf-client-connection-ip": "198.51.100.7" } });
    const [linha] = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, servico.TIPO_LINK));
    const token = linha!.corpo!.match(/\/ativar-acesso\/([A-Za-z0-9_-]+)/)![1]!;
    const r = await cliente.post(`/ativar-acesso/${token}`, { nova: "frase-longa-2026", confirmacao: "frase-longa-2026" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(await contas_de(EMAIL)).toHaveLength(1);
    await entrar(novoCliente(), EMAIL, "frase-longa-2026");
    expect(await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, servico.ACESSO_ATIVADO))).toHaveLength(1);
  });
});

describe("situacao_do_acesso", () => {
  it("diz ativo, aguardando ativação ou sem acesso com o motivo", async () => {
    const s = await servidor({ email: null });
    expect(await servico.situacao_do_acesso(db, s)).toEqual({ situacao: "SEM_ACESSO", motivo: "falta o e-mail institucional no cadastro" });
    const [com] = await db.update(e.servidor).set({ email: EMAIL }).where(eq(e.servidor.id, s.id)).returning();
    expect((await servico.situacao_do_acesso(db, com!)).motivo).toBe("sem conta");
    await servico.garantir_acesso(db, com!, ORIGEM);
    expect((await servico.situacao_do_acesso(db, com!)).situacao).toBe("AGUARDANDO_ATIVACAO");
    await db.update(e.usuario).set({ senha_hash: await (await import("../src/servicos/autenticacao.js")).gerar_hash("frase-longa-2026") }).where(eq(e.usuario.email, EMAIL));
    expect((await servico.situacao_do_acesso(db, com!)).situacao).toBe("ATIVO");
  });
});
