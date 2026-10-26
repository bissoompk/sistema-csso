/**
 * Desfazer uma junção de cadastros (26/10/2026, `mesclagem.desfazer`): devolve
 * ao absorvido o que a junção moveu e o reativa; o que nasceu depois com o
 * mantido não é tocado. Dados fictícios.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import * as mesclagem from "../src/servicos/mesclagem.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, usuarioAtual, type Cliente } from "./ajuda";
import { _cenario, _usuario } from "./ajuda_certificado";

let db: Banco;
let cliente: Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  definirArmazenamento(null);
  await contas(db);
});

const externo = (nome: string, opcoes: { email?: string; organizacao?: string } = {}) =>
  naTransacao((tx) => servico_participante.criar_externo(tx, { nome, vinculo: "TERCEIRIZADO", ...opcoes }));

const linha = async (id: number) => (await db.select().from(e.participante).where(eq(e.participante.id, id)))[0]!;
const enderecos = async (id: number) =>
  (await db.select().from(e.participante_email).where(eq(e.participante_email.participante_id, id)))
    .map((m) => m.email_normalizado)
    .sort();

describe("desfazer: devolve o que a junção moveu", () => {
  it("inscrição, certificado, e-mails, CPF e conta voltam; o que o mantido ganhou depois fica", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const servidor = cen.inscricao.participante;
    const emitido = (await emissao.emitir(db, usuario, cen.inscricao, { gerar_pdf: false })).certificado;

    const x = await externo("Marco A. Schetino", { email: "x@ext.com", organizacao: "Empresa X" });
    // o e-mail repetido nos dois: a junção apaga o do absorvido
    await naTransacao(async (tx) => {
      await servico_participante.registrar_email(tx, (await servico_participante.carregar(tx, x.id))!, "dup@ext.com");
      await servico_participante.registrar_email(tx, (await servico_participante.carregar(tx, servidor.id))!, "dup@ext.com");
    });
    await db.update(e.participante).set({ cpf: "12345678909" }).where(eq(e.participante.id, x.id));
    // uma segunda turma, com a inscrição do externo; e o certificado dele (o do cenário, emitido a ele)
    const [turma2] = await db.select().from(e.turma);
    const outra = await servico_turma.criar_turma(db, usuario, {
      treinamento: (await db.select().from(e.treinamento))[0]!,
      data_inicio: "2027-03-01",
      data_fim: "2027-03-01",
      local: "Sala 2",
    });
    void turma2;
    const insc_x = await servico_turma.inscrever(db, usuario, outra, (await servico_participante.carregar(db, x.id))!);
    await db.update(e.certificado).set({ participante_id: x.id, servidor_id: null }).where(eq(e.certificado.id, emitido.id));

    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, servidor.id, x.id, "mesma pessoa"));
    expect((await linha(x.id)).mesclado_em_id).toBe(servidor.id);
    expect((await linha(servidor.id)).cpf).toBe("12345678909");
    // o mantido ganha um e-mail novo depois da junção
    await naTransacao(async (tx) => {
      await servico_participante.registrar_email(tx, (await servico_participante.carregar(tx, servidor.id))!, "novo@ext.com");
    });

    const [reg] = await db.select().from(e.participante_mesclagem);
    const r = await naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "juntei errado", true));
    expect(r).toMatchObject({ inscricoes: 1, certificados: 1, ficou_para_tras: 0, distintos: true });

    // o absorvido volta inteiro
    const volta = await linha(x.id);
    expect(volta.mesclado_em_id).toBeNull();
    expect(volta.ativo).toBe(true);
    expect(volta.cpf).toBe("12345678909");
    expect(volta.organizacao).toBe("Empresa X");
    expect(volta.email_principal_id).not.toBeNull();
    expect(await enderecos(x.id)).toEqual(["dup@ext.com", "x@ext.com"]);
    const [i] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, insc_x.id));
    expect(i!.participante_id).toBe(x.id);
    const [c] = await db.select().from(e.certificado).where(eq(e.certificado.id, emitido.id));
    expect(c!.participante_id).toBe(x.id);
    expect(c!.servidor_id).toBeNull();

    // o mantido perde o que era do absorvido e guarda o que é dele
    const fica = await linha(servidor.id);
    expect(fica.cpf).toBeNull();
    expect(await enderecos(servidor.id)).toEqual(["dup@ext.com", "novo@ext.com"]);
    const [propria] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, cen.inscricao.id));
    expect(propria!.participante_id).toBe(servidor.id);

    // a linha fica, com quem, quando e por quê; o par fica como "diferentes"
    const [depois] = await db.select().from(e.participante_mesclagem);
    expect(depois!.desfeita_motivo).toBe("juntei errado");
    expect(depois!.desfeita_por).toBe(usuario.id);
    expect(await db.select().from(e.participante_par_distinto)).toHaveLength(1);
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "PARTICIPANTE_MESCLAGEM_DESFEITA"));
    expect(eventos).toHaveLength(2);
    for (const ev of eventos) expect(ev.descricao).not.toMatch(/@|12345678909/);
  });

  it("a conta externa, a organização e o CPF herdados voltam ao absorvido", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const conta = await criarUsuario(db, { login: "terc.x@exemplo.org", email: "terc.x@exemplo.org", perfis: ["terceirizado"] });
    const a = await externo("Bruno Fictício Dias");
    const b = await externo("Bruno F. Dias", { organizacao: "Empresa Y" });
    await db.update(e.participante).set({ cpf: "98765432100", usuario_id: conta.id }).where(eq(e.participante.id, b.id));
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa"));
    const junto = await linha(a.id);
    expect(junto.usuario_id).toBe(conta.id);
    expect(junto.organizacao).toBe("Empresa Y");
    expect(junto.cpf).toBe("98765432100");
    const [reg] = await db.select().from(e.participante_mesclagem);
    await naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "voltar", false));
    const volta = await linha(b.id);
    expect(volta.usuario_id).toBe(conta.id);
    expect(volta.organizacao).toBe("Empresa Y");
    expect(volta.cpf).toBe("98765432100");
    const fica = await linha(a.id);
    expect(fica.usuario_id).toBeNull();
    expect(fica.organizacao).toBeNull();
    expect(fica.cpf).toBeNull();
  });

  it("sem marcar 'não são a mesma pessoa', o par não é gravado", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const a = await externo("Ana Fictícia Rocha");
    const b = await externo("Ana F. Rocha");
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa"));
    const [reg] = await db.select().from(e.participante_mesclagem);
    await naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "voltar", false));
    expect(await db.select().from(e.participante_par_distinto)).toHaveLength(0);
    expect((await linha(b.id)).ativo).toBe(true);
  });

  it("o que a junção moveu e já não está com o mantido fica onde está, e a contagem diz", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const servidor = cen.inscricao.participante;
    const emitido = (await emissao.emitir(db, usuario, cen.inscricao, { gerar_pdf: false })).certificado;
    const x = await externo("Marco A. Schetino");
    const z = await externo("Outra Pessoa Fictícia");
    await db.update(e.certificado).set({ participante_id: x.id, servidor_id: null }).where(eq(e.certificado.id, emitido.id));
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, servidor.id, x.id, "mesma pessoa"));
    // depois da junção o certificado muda de mãos
    await db.update(e.certificado).set({ participante_id: z.id }).where(eq(e.certificado.id, emitido.id));
    const [reg] = await db.select().from(e.participante_mesclagem);
    const r = await naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "voltar", false));
    expect(r.certificados).toBe(0);
    expect(r.ficou_para_tras).toBe(1);
    const [c] = await db.select().from(e.certificado).where(eq(e.certificado.id, emitido.id));
    expect(c!.participante_id).toBe(z.id);
  });
});

describe("desfazer: o que recusa", () => {
  it("exige o motivo, recusa a junção já desfeita e quem não pode juntar", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const a = await externo("Ana Fictícia Rocha");
    const b = await externo("Ana F. Rocha");
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa"));
    const [reg] = await db.select().from(e.participante_mesclagem);
    await expect(naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "  ", false))).rejects.toThrow(/motivo/);
    const semPermissao = await usuarioAtual(db, "servidor_consulta");
    await expect(naTransacao((tx) => mesclagem.desfazer(tx, semPermissao, reg!.id, "x", false))).rejects.toThrow();
    await naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "voltar", false));
    await expect(naTransacao((tx) => mesclagem.desfazer(tx, usuario, reg!.id, "de novo", false))).rejects.toThrow(/já foi desfeita/);
  });

  it("o cadastro que ficou foi juntado a outro depois: desfaz primeiro a mais nova, depois a antiga", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const c = await externo("Carla Fictícia Souza");
    const a = await externo("Carla F. Souza");
    const b = await externo("Carla Souza");
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa")); // b -> a
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, c.id, a.id, "mesma pessoa")); // a -> c
    const [b_em_a, a_em_c] = await db.select().from(e.participante_mesclagem).orderBy(e.participante_mesclagem.id);
    await expect(naTransacao((tx) => mesclagem.desfazer(tx, usuario, b_em_a!.id, "voltar", false))).rejects.toThrow(
      /desfaça primeiro a junção mais nova/,
    );
    const lista = await naTransacao((tx) => mesclagem.juncoes_feitas(tx));
    expect(lista.find((j) => j.id === b_em_a!.id)!.impedimento).toMatch(/mais nova/);
    expect(lista.find((j) => j.id === a_em_c!.id)!.impedimento).toBe("");
    await naTransacao((tx) => mesclagem.desfazer(tx, usuario, a_em_c!.id, "voltar", false));
    await naTransacao((tx) => mesclagem.desfazer(tx, usuario, b_em_a!.id, "voltar", false));
    for (const p of [a, b, c]) expect((await linha(p.id)).mesclado_em_id).toBeNull();
  });
});

describe("a tela", () => {
  it("lista as junções, desfaz pelo formulário e mostra a desfeita", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const a = await externo("Ana Fictícia Rocha");
    const b = await externo("Ana F. Rocha");
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa"));
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/treinamentos/participantes?feitas=1")).text;
    expect(tela).toContain("Desfazer esta junção");
    expect(tela).toContain(b.identificador_publico);
    const [reg] = await db.select().from(e.participante_mesclagem);
    const r = await cliente.post(
      "/treinamentos/participantes/desfazer",
      { mesclagem_id: String(reg!.id), motivo: "juntei errado", distintos: "sim", volta: "/treinamentos/participantes?feitas=1" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const depois = (await cliente.get(r.location!)).text;
    expect(depois).toContain("Junção desfeita");
    expect((await linha(b.id)).ativo).toBe(true);
    expect((await cliente.get("/treinamentos/participantes?feitas=1")).text).toContain("desfeita em");
  });

  it("sem o motivo nada é desfeito, e a recusa aparece", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const a = await externo("Ana Fictícia Rocha");
    const b = await externo("Ana F. Rocha");
    await naTransacao((tx) => mesclagem.mesclar(tx, usuario, a.id, b.id, "mesma pessoa"));
    await entrar(cliente, "coordenador_csso");
    const [reg] = await db.select().from(e.participante_mesclagem);
    const r = await cliente.post("/treinamentos/participantes/desfazer", { mesclagem_id: String(reg!.id), motivo: "" }, { seguir: false });
    expect((await cliente.get(r.location ?? "/")).text + r.text).toContain("Nada foi desfeito");
    expect((await linha(b.id)).ativo).toBe(false);
  });
});
