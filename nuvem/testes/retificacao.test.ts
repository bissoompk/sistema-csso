/**
 * Corrigir o que já foi emitido (anular + substituto, num ato só) e excluir o
 * que foi cadastrado por engano: turma que não aconteceu, treinamento e
 * instrutor que nunca serviram a turma.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as retificacao from "../src/servicos/retificacao.js";
import * as exclusao from "../src/servicos/exclusao_cadastro.js";
import * as servico_turma from "../src/servicos/turma.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as validacao from "../src/servicos/validacao_certificado.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { TODAS, _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;

await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

/**
 * Turma concluída e o certificado emitido para um EXTERNO. O cenário comum
 * inscreve servidor; aqui a inscrição aprovada passa a apontar para um externo
 * antes da emissão, que é o caso em que o nome mora no participante.
 */
async function emitido_para_externo() {
  await contas(db);
  const u = await _usuario(db, TODAS, "montador");
  const d = await _cenario(db, u);
  const externo = await servico_participante.criar_externo(db, {
    nome: "Joana Silv",
    vinculo: "TERCEIRIZADO",
    organizacao: "Empresa X",
    usuario: u,
  });
  await db.update(e.inscricao).set({ participante_id: externo.id }).where(eq(e.inscricao.id, d.inscricao.id));
  const inscricao = (await servico_turma.carregar_inscricao(db, d.inscricao.id))!;
  const { certificado } = await servico.emitir(db, u, inscricao);
  return { u, d, externo, certificado };
}

async function _certificado(id: number) {
  const [c] = await db.select().from(e.certificado).where(eq(e.certificado.id, id));
  return c!;
}

async function _eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("corrigir o certificado emitido", () => {
  it("anula o antigo, emite o substituto com o nome corrigido e liga os dois", async () => {
    const { u, externo, certificado } = await emitido_para_externo();
    const r = await retificacao.retificar(db, u, certificado, "nome digitado errado", {
      nome: "  Joana   Silva ",
      organizacao: "Empresa X Ltda",
    });
    expect(r.corrigidos).toEqual(["nome", "organização"]);

    const antigo = await _certificado(certificado.id);
    expect(antigo.situacao).toBe("ANULADO");
    expect(antigo.motivo_anulacao).toBe("Retificação: nome digitado errado");
    expect(antigo.substituido_por_id).toBe(r.novo.id);
    // o papel antigo continua dizendo o que dizia
    expect(servico.montar_contexto(null, antigo).participante_nome).toBe("Joana Silv");

    const novo = await _certificado(r.novo.id);
    expect(novo.situacao).toBe("EMITIDO");
    expect(novo.numero).toBe(antigo.numero + 1);
    expect(novo.chave_validacao).not.toBe(antigo.chave_validacao);
    expect(servico.montar_contexto(null, novo).participante_nome).toBe("Joana Silva");
    expect(servico.montar_contexto(null, novo).participante_organizacao).toBe("Empresa X Ltda");

    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, externo.id));
    expect(p!.nome).toBe("Joana Silva");

    const [corrigido] = await _eventos("PARTICIPANTE_CORRIGIDO");
    // RN-19 na escrita: a trilha diz QUE o nome mudou, não qual era
    expect(corrigido!.descricao).toContain("nome corrigido");
    expect(corrigido!.descricao).not.toContain("Joana");
    const [retificado] = await _eventos("CERTIFICADO_RETIFICADO");
    expect(retificado!.descricao).toContain(`substitui ${antigo.numero}/${antigo.ano}`);

    // a chave antiga responde anulado e aponta o número do substituto
    const resposta = await validacao.consultar(db, antigo.chave_validacao);
    expect(resposta.situacao).toBe("ANULADO");
    expect(resposta.substituido_por).toBe(`${novo.numero}/${novo.ano}`);
  });

  it("sem mudança de cadastro, só reemite com o contexto de hoje", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const d = await _cenario(db, u);
    const { certificado } = await servico.emitir(db, u, d.inscricao);
    const r = await retificacao.retificar(db, u, certificado, "modelo corrigido");
    expect(r.corrigidos).toEqual([]);
    expect((await _certificado(certificado.id)).substituido_por_id).toBe(r.novo.id);
    const [retificado] = await _eventos("CERTIFICADO_RETIFICADO");
    expect(retificado!.descricao).toContain("reemitido sem mudança de cadastro");
  });

  it("se o substituto não pode sair, nada muda", async () => {
    const { u, d, externo, certificado } = await emitido_para_externo();
    // a assinatura deixou de vigorar: o substituto de hoje não teria quem assine
    await db
      .update(e.assinatura_instrutor)
      .set({ vigencia_fim: datas_br.somar_dias(datas_br.hoje(), -1) })
      .where(eq(e.assinatura_instrutor.id, d.instrutor.id));
    await expect(
      db.transaction((sp) => retificacao.retificar(sp as never, u, certificado, "nome errado", { nome: "Joana Silva" })),
    ).rejects.toBeInstanceOf(servico.EmissaoBloqueada);
    expect((await _certificado(certificado.id)).situacao).toBe("EMITIDO");
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, externo.id));
    expect(p!.nome).toBe("Joana Silv");
  });

  it("recusa sem motivo, certificado já anulado e nome de servidor", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const d = await _cenario(db, u);
    const { certificado } = await servico.emitir(db, u, d.inscricao);
    await expect(retificacao.retificar(db, u, certificado, "  ")).rejects.toThrow("exige o motivo");
    await expect(
      retificacao.retificar(db, u, certificado, "nome", { nome: "Outro Nome" }),
    ).rejects.toThrow("cadastro de servidores");
    await servico.anular(db, u, certificado, "teste");
    await expect(retificacao.retificar(db, u, certificado, "de novo")).rejects.toThrow("já está anulado");
  });

  it("pela tela: a ficha oferece a correção e a recusa não muda nada", async () => {
    const { certificado } = await emitido_para_externo();
    await entrar(cliente, "coordenador_csso");
    const ficha = await cliente.get(`/certificados/${certificado.id}`);
    expect(ficha.text).toContain("Corrigir certificado");
    expect(ficha.text).toContain('value="Joana Silv"');
    const recusa = await cliente.post(`/certificados/${certificado.id}/corrigir`, { nome: "Joana Silva", motivo: "" });
    expect(recusa.text).toContain("Nada foi alterado.");
    expect((await _certificado(certificado.id)).situacao).toBe("EMITIDO");
    const r = await cliente.post(`/certificados/${certificado.id}/corrigir`, {
      nome: "Joana Silva",
      vinculo: "TERCEIRIZADO",
      organizacao: "Empresa X",
      motivo: "nome digitado errado",
    });
    expect(r.text).toContain("anulado e substituído por");
    expect(r.text).toContain("(corrigido: nome)");
  });
});

describe("corrigir o participante pela inscrição", () => {
  it("grava a correção e avisa do certificado que continua com o dado antigo", async () => {
    const { d, externo } = await emitido_para_externo();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(`/turmas/${d.turma.id}/inscricoes/${d.inscricao.id}/participante`, {
      nome: "Joana Silva",
      vinculo: "DISCENTE",
      organizacao: "",
    });
    expect(r.text).toContain("nome, vínculo, organização corrigido(s)");
    expect(r.text).toContain("1 certificado(s) já emitido(s) continuam com o dado antigo");
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, externo.id));
    expect([p!.nome, p!.vinculo, p!.organizacao]).toEqual(["Joana Silva", "DISCENTE", null]);
  });
});

/** Turma planejada para a semana que vem, com uma inscrição lançada pela CSSO. */
async function turma_planejada(u: UsuarioAtual) {
  const d = await _cenario(db, u);
  const semana = datas_br.somar_dias(datas_br.hoje(), 7);
  const turma = await servico_turma.criar_turma(db, u, { treinamento: d.treinamento, data_inicio: semana, data_fim: semana });
  const pessoa = await servico_participante.criar_externo(db, { nome: "Pedro Souza", vinculo: "VISITANTE", usuario: u });
  await servico_turma.inscrever(db, u, turma, pessoa);
  return { d, turma: (await servico_turma.carregar_turma(db, turma.id))! };
}

describe("excluir a turma aberta por engano", () => {
  it("apaga a turma e a inscrição lançada pela CSSO, com o retrato na trilha", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const { turma } = await turma_planejada(u);
    expect(await servico_turma.impedimentos_da_exclusao(db, turma)).toEqual([]);
    await expect(servico_turma.excluir_turma(db, u, turma, "")).rejects.toThrow("exige o motivo");
    await servico_turma.excluir_turma(db, u, turma, "aberta com o treinamento errado");
    expect(await db.select().from(e.turma).where(eq(e.turma.id, turma.id))).toEqual([]);
    expect(await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma.id))).toEqual([]);
    const [evento] = await _eventos("TURMA_EXCLUIDA");
    expect(evento!.descricao).toContain(`${turma.codigo}`);
    expect(evento!.descricao).toContain("1 inscrição(ões) lançada(s) pela CSSO");
    expect(evento!.descricao).toContain("aberta com o treinamento errado");
  });

  it("recusa a turma que já tem história", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const { d, turma } = await turma_planejada(u);
    // concluída e com certificado
    await servico.emitir(db, u, d.inscricao);
    const motivos = await servico_turma.impedimentos_da_exclusao(db, d.turma);
    expect(motivos.join(" | ")).toContain("só se exclui a planejada");
    expect(motivos.join(" | ")).toContain("certificado emitido");
    await expect(servico_turma.excluir_turma(db, u, d.turma, "x")).rejects.toThrow("Cancele a turma");

    // o pedido do próprio participante: a pessoa precisa ler o cancelamento
    const [inscricao] = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma.id));
    const carregada = (await servico_turma.carregar_inscricao(db, inscricao!.id))!;
    await servico_turma.abrir_pendencia_de_confirmacao(db, carregada, u, true);
    expect((await servico_turma.impedimentos_da_exclusao(db, turma)).join(" | ")).toContain("pelo próprio participante");
  });

  it("pela tela: o botão aparece e a exclusão volta para a lista", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const { turma } = await turma_planejada(u);
    await entrar(cliente, "coordenador_csso");
    const ficha = await cliente.get(`/turmas/${turma.id}?aba=turma`);
    expect(ficha.text).toContain("Excluir turma");
    const r = await cliente.post(`/turmas/${turma.id}/excluir`, { motivo: "turma duplicada" });
    expect(r.text).toContain(`Turma ${turma.codigo} excluída.`);
  });
});

describe("excluir treinamento e instrutor nunca usados", () => {
  it("o que nunca teve turma sai; o que teve, não", async () => {
    await contas(db);
    const u = await _usuario(db, TODAS, "montador");
    const d = await _cenario(db, u);
    await expect(exclusao.excluir_treinamento(db, u, d.treinamento.id)).rejects.toThrow("Desmarque “ativo”");
    await expect(exclusao.excluir_instrutor(db, u, d.instrutor.id)).rejects.toThrow("está em 1 turma(s)");

    const [solto] = await db
      .insert(e.treinamento)
      .values({ codigo: "TESTE", nome: "Cadastrado por engano", carga_horaria_horas: "4", validade_meses: 0 })
      .returning();
    const [sem_turma] = await db
      .insert(e.assinatura_instrutor)
      .values({ nome: "Instrutor por engano", externo: true, vigencia_inicio: "2020-01-01" })
      .returning();
    await db.update(e.treinamento).set({ instrutor_padrao_id: sem_turma!.id }).where(eq(e.treinamento.id, solto!.id));

    expect(await exclusao.excluir_instrutor(db, u, sem_turma!.id)).toBe("Instrutor por engano");
    const [depois] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, solto!.id));
    expect(depois!.instrutor_padrao_id).toBeNull();
    expect(await exclusao.excluir_treinamento(db, u, solto!.id)).toBe("TESTE");
    expect(
      await db.select().from(e.treinamento).where(and(eq(e.treinamento.codigo, "TESTE"))),
    ).toEqual([]);
    const eventos = await db.select().from(e.historico_evento).orderBy(asc(e.historico_evento.id));
    expect(eventos.map((ev) => ev.tipo_evento)).toEqual(
      expect.arrayContaining(["TREINAMENTO_EXCLUIDO", "ASSINATURA_INSTRUTOR_EXCLUIDA"]),
    );
  });
});
