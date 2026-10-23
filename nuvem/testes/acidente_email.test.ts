/**
 * F1 do módulo de acidentes: o e-mail (D6). Desligado, nada entra na caixa;
 * ligado, o setor e o comunicante logado recebem só protocolo, o que aconteceu
 * e o link — sem nome, sem descrição, sem saúde. A trilha diz para quem foi.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { redefinirConfig } from "../src/config.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import * as triagem from "../src/servicos/acidente_triagem.js";
import { bancoLimpo, contas, usuarioAtual } from "./ajuda.js";
import { dados, titular } from "./acidente_ajuda.js";

let db: Banco;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  await contas(db);
});

afterEach(() => {
  delete process.env.CSSO_ACIDENTE_EMAIL;
  delete process.env.CSSO_ACIDENTE_EMAIL_SETOR;
  redefinirConfig();
});

function ligar(setor = "sst@ufvjm.edu.br") {
  process.env.CSSO_ACIDENTE_EMAIL = "sim";
  process.env.CSSO_ACIDENTE_EMAIL_SETOR = setor;
  redefinirConfig();
}

describe("e-mail do módulo de acidentes", () => {
  it("desligado (o padrão), nada entra na caixa de saída", async () => {
    const { usuario } = await titular(db);
    await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    expect(await db.select().from(e.email_saida)).toHaveLength(0);
  });

  it("ligado: o setor e a confirmação ao comunicante, sem nome nem descrição", async () => {
    ligar();
    const { usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const caixa = await db.select().from(e.email_saida).orderBy(e.email_saida.id);
    expect(caixa.map((m) => m.tipo)).toEqual(["ACIDENTE_NOVA_SETOR", "ACIDENTE_CONFIRMACAO"]);
    expect(caixa[0]!.destinatario).toBe("sst@ufvjm.edu.br");
    for (const m of caixa) {
      expect(m.corpo).toContain(oc.protocolo);
      expect(m.corpo).toContain(`/acidentes/${oc.id}`);
      expect(m.corpo).not.toContain("Titular Fictício");
      expect(m.corpo).not.toContain("respingou");
      expect(m.assunto).not.toContain("Titular");
    }
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_EMAIL_ENFILEIRADO"));
    expect(ev!.descricao).toContain("setor: enfileirado");
    expect(ev!.descricao).not.toContain("@");
  });

  it("setor sem endereço não derruba a comunicação, e a trilha diz por quê", async () => {
    ligar("");
    const { usuario } = await titular(db);
    await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const caixa = await db.select().from(e.email_saida);
    expect(caixa.map((m) => m.tipo)).toEqual(["ACIDENTE_CONFIRMACAO"]);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_EMAIL_ENFILEIRADO"));
    expect(ev!.descricao).toContain("setor: NÃO enfileirado");
  });

  it("pedido de complementação avisa o comunicante, sem o texto do pedido", async () => {
    ligar();
    const { usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const equipe = await usuarioAtual(db, "tecnico_seguranca");
    await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
    const [a] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id));
    await db.transaction((tx) => triagem.pedir_complementacao(tx, equipe, a!, "Informe o modelo do frasco.", a!.versao));
    const [m] = await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, "ACIDENTE_COMPLEMENTACAO"));
    expect(m!.corpo).toContain("/complementar");
    expect(m!.corpo).not.toContain("modelo do frasco");
  });
});
