/**
 * Ocorrências de urgência e emergência: o e-mail (desligado por padrão, sem
 * relato no corpo) e o prazo de guarda de 5 anos (anonimiza o que é pessoal,
 * guarda a estatística, nunca toca na ocorrência aberta). Dados fictícios.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { redefinirConfig } from "../src/config.js";
import * as expurgo from "../src/servicos/ocorrencia_expurgo.js";
import { bancoLimpo, contas, entrar, type Campos } from "./ajuda";

let amb: Awaited<ReturnType<typeof bancoLimpo>>;
let campus_id: number;

beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  const [c] = await amb.db.insert(e.campus).values({ sigla: "OAG", nome: "Campus Aviso", cidade: "Diamantina" }).returning();
  campus_id = c!.id;
});

afterEach(() => {
  delete process.env.CSSO_OCORRENCIA_EMAIL;
  delete process.env.CSSO_OCORRENCIA_EMAIL_SETOR;
  redefinirConfig();
});

function ligar(equipe = "sst@ufvjm.edu.br") {
  process.env.CSSO_OCORRENCIA_EMAIL = "sim";
  process.env.CSSO_OCORRENCIA_EMAIL_SETOR = equipe;
  redefinirConfig();
}

function formulario(troca: Campos = {}): Campos {
  const hora = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 16);
  return {
    data_hora: hora,
    campus_id: String(campus_id),
    local_descricao: "Sala fictícia",
    tipo: "QUEDA",
    descricao: "Relato sigiloso fictício da queda.",
    pessoa_nome: "Pessoa Sigilosa Fictícia",
    pessoa_vinculo: "ESTUDANTE",
    encaminhada: "nao",
    ...troca,
  };
}

async function registrar(login = "discente") {
  const cli = await entrar(amb.novoCliente(), login);
  const r = await cli.post("/ocorrencias/registrar", formulario(), { seguir: false });
  expect(r.status).toBe(303);
  const [o] = await amb.db.select().from(e.ocorrencia).orderBy(e.ocorrencia.id);
  return o!;
}

describe("e-mail da ocorrência", () => {
  it("desligado (o padrão), nada entra na caixa de saída", async () => {
    await registrar();
    expect(await amb.db.select().from(e.email_saida)).toHaveLength(0);
  });

  it("ligado: a equipe e a confirmação a quem registrou, só com protocolo e link", async () => {
    ligar();
    // a conta do discente de teste precisa de e-mail para a confirmação
    await amb.db.update(e.usuario).set({ email: "discente.ficticio@exemplo.test" }).where(eq(e.usuario.login, "discente"));
    const o = await registrar();
    const caixa = await amb.db.select().from(e.email_saida).orderBy(e.email_saida.id);
    expect(caixa.map((m) => m.tipo)).toEqual(["OCORRENCIA_NOVA_EQUIPE", "OCORRENCIA_CONFIRMACAO"]);
    expect(caixa[0]!.destinatario).toBe("sst@ufvjm.edu.br");
    for (const m of caixa) {
      expect(m.corpo).toContain(o.protocolo);
      expect(`${m.assunto} ${m.corpo}`).not.toContain("Sigilos");
    }
    const [ev] = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "OCORRENCIA_EMAIL_ENFILEIRADO"));
    expect(ev!.valor_novo).toBe("2/2");
    expect(ev!.descricao).not.toContain("@");
  });

  it("sem endereço da equipe, avisa só quem registrou e diz por quê na trilha", async () => {
    ligar("");
    await amb.db.update(e.usuario).set({ email: "discente.ficticio@exemplo.test" }).where(eq(e.usuario.login, "discente"));
    await registrar();
    const caixa = await amb.db.select().from(e.email_saida);
    expect(caixa.map((m) => m.tipo)).toEqual(["OCORRENCIA_CONFIRMACAO"]);
    const [ev] = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "OCORRENCIA_EMAIL_ENFILEIRADO"));
    expect(ev!.valor_novo).toBe("1/2");
    expect(ev!.descricao).toContain("NÃO enfileirado");
  });
});

describe("prazo de guarda de 5 anos", () => {
  async function encerrar(id: number, situacao: string, ha_anos: number) {
    const quando = new Date(Date.now() - ha_anos * 365.25 * 86_400_000);
    await amb.db.update(e.ocorrencia).set({ situacao, concluida_em: quando, conclusao: "Conclusão fictícia" }).where(eq(e.ocorrencia.id, id));
  }

  it("anonimiza a encerrada há mais de 5 anos, guarda a estatística e apaga o acompanhamento", async () => {
    const o = await registrar();
    const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await amb.db.insert(e.ocorrencia_acompanhamento).values({ ocorrencia_id: o.id, texto: "Acompanhamento sigiloso", autor_id: u!.id });
    await encerrar(o.id, "CONCLUIDA", 6);

    expect(await expurgo.expurgar(amb.db)).toBe(1);
    const [depois] = await amb.db.select().from(e.ocorrencia).where(eq(e.ocorrencia.id, o.id));
    expect(depois!.pessoa_nome).toBeNull();
    expect(depois!.descricao).toBe(expurgo.TEXTO_APAGADO);
    expect(depois!.conclusao).toBeNull();
    expect(depois!.notificante_email).toBeNull();
    expect(depois!.expurgada_em).not.toBeNull();
    // a estatística fica
    expect(depois!.protocolo).toBe(o.protocolo);
    expect(depois!.tipos).toBe("QUEDA");
    expect(depois!.campus_id).toBe(campus_id);
    expect(depois!.pessoa_vinculo).toBe("ESTUDANTE");
    expect(await amb.db.select().from(e.ocorrencia_acompanhamento).where(eq(e.ocorrencia_acompanhamento.ocorrencia_id, o.id))).toHaveLength(0);

    // idempotente, e a trilha tem a quantidade e nenhum dado
    expect(await expurgo.expurgar(amb.db)).toBe(0);
    const evs = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "OCORRENCIA_EXPURGADA"));
    expect(evs).toHaveLength(1);
    expect(JSON.stringify(evs)).not.toContain("Sigilos");

    // a ficha avisa
    const equipe = await entrar(amb.novoCliente(), "coordenador_csso");
    expect((await equipe.get(`/ocorrencias/${o.id}`, { seguir: false })).text).toContain("foram apagados");
  });

  it("não toca na recente, nem na aberta, por mais velha que seja", async () => {
    const recente = await registrar();
    await encerrar(recente.id, "CONCLUIDA", 4);
    const aberta = await registrar("terceirizado");
    await amb.db.update(e.ocorrencia).set({ data_hora: new Date(Date.now() - 9 * 365 * 86_400_000) }).where(eq(e.ocorrencia.id, aberta.id));
    expect(await expurgo.expurgar(amb.db)).toBe(0);
    for (const id of [recente.id, aberta.id]) {
      const [o] = await amb.db.select().from(e.ocorrencia).where(eq(e.ocorrencia.id, id));
      expect(o!.expurgada_em).toBeNull();
    }
  });

  it("a cancelada entra no prazo como a concluída", async () => {
    const o = await registrar();
    await encerrar(o.id, "CANCELADA", 7);
    expect(await expurgo.expurgar(amb.db)).toBe(1);
  });
});
