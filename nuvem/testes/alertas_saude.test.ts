/**
 * O aviso diário de saúde: o que vira alerta e quando o e-mail é enfileirado.
 * Sem endereço configurado ou sem alerta, nada sai. Dados fictícios.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { redefinirConfig } from "../src/config.js";
import { alertas_de_saude, avisar_administracao, TIPO_ALERTA } from "../src/servicos/alertas_saude.js";
import { ROTINA_BACKUP, ROTINA_CADEIA } from "../src/servicos/rotinas.js";
import { bancoLimpo } from "./ajuda.js";

let db: Banco;
const antes = process.env.CSSO_ALERTA_EMAIL;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  delete process.env.CSSO_ALERTA_EMAIL;
  redefinirConfig();
});
afterEach(() => {
  if (antes === undefined) delete process.env.CSSO_ALERTA_EMAIL;
  else process.env.CSSO_ALERTA_EMAIL = antes;
  redefinirConfig();
});

const execucao = (rotina: string, ok: boolean, horas_atras = 1) =>
  db.insert(e.rotina_execucao).values({
    rotina,
    concluida_em: new Date(Date.now() - horas_atras * 3_600_000),
    duracao_ms: 10,
    ok,
    detalhe: "teste",
  });

describe("alertas_de_saude", () => {
  it("sem backup registrado, é alerta", async () => {
    expect(await alertas_de_saude(db)).toContain("nenhum backup registrado");
  });

  it("backup falho, backup velho e cadeia rompida viram alertas; tudo em dia não alerta", async () => {
    await execucao(ROTINA_BACKUP, true, 2);
    await execucao(ROTINA_CADEIA, true, 2);
    expect(await alertas_de_saude(db)).toEqual([]);
    await execucao(ROTINA_BACKUP, false, 1);
    await execucao(ROTINA_CADEIA, false, 1);
    const a = await alertas_de_saude(db);
    expect(a).toContain("o último backup FALHOU");
    expect(a.some((x) => x.includes("cadeia da trilha"))).toBe(true);
  });

  it("rotina diária parada há mais de 36 h é alerta", async () => {
    await execucao(ROTINA_BACKUP, true, 2);
    await execucao(ROTINA_CADEIA, true, 50);
    expect((await alertas_de_saude(db)).some((x) => x.includes(`${ROTINA_CADEIA} não conclui`))).toBe(true);
  });

  it("e-mail com falha e e-mail parado na fila", async () => {
    await execucao(ROTINA_BACKUP, true, 2);
    await db.insert(e.email_saida).values({ tipo: "TESTE", destinatario: "a@ufvjm.edu.br", assunto: "x", corpo: "x", situacao: "FALHOU" });
    await db
      .insert(e.email_saida)
      .values({ tipo: "TESTE", destinatario: "b@ufvjm.edu.br", assunto: "y", corpo: "y", criado_em: new Date(Date.now() - 8 * 3_600_000) });
    const a = await alertas_de_saude(db);
    expect(a).toContain("1 e-mail(s) com envio falho na caixa de saída");
    expect(a.some((x) => x.includes("na fila há mais de 6 horas"))).toBe(true);
  });
});

describe("avisar_administracao", () => {
  it("sem CSSO_ALERTA_EMAIL não manda nada", async () => {
    const r = await avisar_administracao(db);
    expect(r).toEqual({ enviado: false, motivo: "CSSO_ALERTA_EMAIL não configurado" });
    expect(await db.select().from(e.email_saida)).toEqual([]);
  });

  it("com endereço e sem alerta, não manda; com alerta, enfileira um e-mail sem dado pessoal", async () => {
    process.env.CSSO_ALERTA_EMAIL = "administracao@ufvjm.edu.br";
    redefinirConfig();
    await execucao(ROTINA_BACKUP, true, 2);
    expect(await avisar_administracao(db)).toEqual({ enviado: false, motivo: "sem alertas" });
    await execucao(ROTINA_BACKUP, false, 1);
    const r = await avisar_administracao(db);
    expect(r).toEqual({ enviado: true, alertas: 1 });
    const [m] = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, TIPO_ALERTA));
    expect(m!.destinatario).toBe("administracao@ufvjm.edu.br");
    expect(m!.corpo).toContain("o último backup FALHOU");
    expect(m!.assunto).toContain("1 alerta(s)");
  });
});
