/**
 * NUVEM: marcadores do modelo que não são campo do sistema — texto fixo,
 * campo da turma e campo do participante (`servicos/campos_certificado.ts`).
 *
 * O cenário é o de `ajuda_certificado.ts` (modelo padrão, turma concluída);
 * cada teste troca o preenchimento de um marcador do .docx padrão (`carga`,
 * `local`, `frequencia`) para o tipo novo e confere o que sai no papel.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-campos-certificado-"));

import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as campos from "../src/servicos/campos_certificado.js";
import * as documento from "../src/servicos/documento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import { PermissaoNegada, type UsuarioAtual } from "../src/servicos/rbac.js";
import { normalizar_fluxo } from "../src/servicos/textos.js";
import * as servico_turma from "../src/servicos/turma.js";
import { RegraDaTurma } from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { TODAS, _cenario, _usuario, type Cenario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

const _texto = (bytes: Uint8Array) => normalizar_fluxo(documento.extrair_texto(bytes));

async function cenario(extras: [string, string, string][] = []): Promise<Cenario & { usuario: UsuarioAtual }> {
  const usuario = await _usuario(db);
  return { ...(await _cenario(db, usuario, { extras })), usuario };
}

/** Troca o preenchimento de um marcador do modelo do cenário. */
async function trocar(modelo_id: number, marcador: string, d: Partial<typeof e.certificado_modelo_tag.$inferInsert>) {
  await db
    .update(e.certificado_modelo_tag)
    .set({ campo: "", ...d })
    .where(and(eq(e.certificado_modelo_tag.modelo_id, modelo_id), eq(e.certificado_modelo_tag.marcador, marcador)));
}

async function turma_fresca(id: number) {
  return (await servico_turma.carregar_turma(db, id))!;
}

async function inscricao_fresca(id: number) {
  return (await servico_turma.carregar_inscricao(db, id))!;
}

async function modelo_de(turma: servico_turma.TurmaCarregada) {
  return (await servico.modelo_da_turma(db, turma))[0]!;
}

describe("texto fixo do modelo", () => {
  it("sai igual em todo certificado e fica congelado", async () => {
    const c = await cenario();
    await trocar(c.modelo.id, "carga", { tipo: "TEXTO_FIXO", texto_fixo: "10 (dez) tempos" });
    const resultado = await servico.emitir(db, c.usuario, await inscricao_fresca(c.inscricao.id));
    const texto = _texto(resultado.bytes);
    expect(texto).toContain("com carga horária de 10 (dez) tempos");
    expect(texto).not.toContain("8 horas");
    const congelado = resultado.certificado.contexto_congelado as Record<string, any>;
    expect(congelado.campos_livres.carga).toEqual({ tipo: "TEXTO_FIXO", rotulo: "texto fixo de carga", valor: "10 (dez) tempos" });
    // o modelo muda; o papel emitido, não
    await trocar(c.modelo.id, "carga", { tipo: "TEXTO_FIXO", texto_fixo: "20 tempos" });
    const via = await servico.segunda_via(db, c.usuario, resultado.certificado);
    expect(via.confere).toBe(true);
    expect(_texto(via.bytes)).toContain("10 (dez) tempos");
  });
});

describe("campo da turma", () => {
  it("vazio e obrigatório recusa a emissão", async () => {
    const c = await cenario();
    await trocar(c.modelo.id, "local", { tipo: "TURMA", rotulo: "Local de atuação do brigadista", obrigatorio: true });
    const inscricao = await inscricao_fresca(c.inscricao.id);
    const validacao = await servico.validar(db, inscricao);
    expect(validacao.bloqueios.join(" ")).toContain("falta preencher “Local de atuação do brigadista” da turma");
    await expect(servico.emitir(db, c.usuario, inscricao)).rejects.toBeInstanceOf(servico.EmissaoBloqueada);
    expect(await db.select().from(e.certificado)).toHaveLength(0);
  });

  it("preenchido sai no papel, fica congelado e deixa trilha", async () => {
    const c = await cenario();
    await trocar(c.modelo.id, "local", { tipo: "TURMA", rotulo: "Local de atuação do brigadista", obrigatorio: true });
    const turma = await turma_fresca(c.turma.id);
    const modelo = await modelo_de(turma);
    expect(await campos.gravar_valores_turma(db, c.usuario, turma, modelo, { local: "Prédio da Reitoria" })).toBe(1);
    const resultado = await servico.emitir(db, c.usuario, await inscricao_fresca(c.inscricao.id));
    expect(_texto(resultado.bytes)).toContain("em Prédio da Reitoria");

    // mudar o valor da turma depois não mexe no certificado emitido
    await campos.gravar_valores_turma(db, c.usuario, turma, modelo, { local: "Ginásio" });
    const via = await servico.segunda_via(db, c.usuario, resultado.certificado);
    expect(via.confere).toBe(true);
    expect(_texto(via.bytes)).toContain("em Prédio da Reitoria");

    const eventos = await campos.trilha_da_turma(db, turma.id);
    expect(eventos.map((ev) => [ev.valor_anterior, ev.valor_novo])).toEqual([
      ["Prédio da Reitoria", "Ginásio"],
      [null, "Prédio da Reitoria"],
    ]);
    // em branco apaga
    await campos.gravar_valores_turma(db, c.usuario, turma, modelo, { local: "  " });
    expect(await campos.valores_da_turma(db, turma.id)).toEqual({});
  });

  it("pede permissão de editar a turma ou de emitir", async () => {
    const c = await cenario();
    await trocar(c.modelo.id, "local", { tipo: "TURMA", rotulo: "Local" });
    const turma = await turma_fresca(c.turma.id);
    const leitor = await _usuario(db, ["treinamento.ver", "turma.avaliar"], "leitor");
    await expect(
      campos.gravar_valores_turma(db, leitor, turma, await modelo_de(turma), { local: "X" }),
    ).rejects.toBeInstanceOf(PermissaoNegada);
  });
});

describe("campo do participante", () => {
  it("cada inscrição tem o seu valor (nota por disciplina)", async () => {
    const c = await cenario([["2220001", "Beatriz Lemos Prado", "8"]]);
    const rotulo = "Nota – Prevenção e combate a incêndio";
    await trocar(c.modelo.id, "frequencia", { tipo: "PARTICIPANTE", rotulo, obrigatorio: true });
    const turma = await turma_fresca(c.turma.id);
    const modelo = await modelo_de(turma);
    const [a, b] = [await inscricao_fresca(c.inscricao.id), await inscricao_fresca(c.outras[0]!.id)];

    // a segunda sem nota: recusada; a primeira, com nota, sai
    await campos.gravar_valores_inscricao(db, c.usuario, a, modelo, { frequencia: "8,5" }, {});
    const recusa = await servico.validar(db, b);
    expect(recusa.bloqueios.join(" ")).toContain(`falta preencher “${rotulo}” deste participante`);
    const relatorio = await servico.emitir_lote(db, c.usuario, turma);
    expect(relatorio.emitidos).toHaveLength(1);
    expect(relatorio.travados[0]!.erro).toContain("falta preencher");

    await campos.gravar_valores_inscricao(db, c.usuario, b, modelo, { frequencia: "9,0" }, {});
    await servico.emitir_lote(db, c.usuario, turma);
    const certificados = await db.select().from(e.certificado).orderBy(asc(e.certificado.id));
    expect(certificados).toHaveLength(2);
    const valores = certificados.map((cert) => (cert.contexto_congelado as any).campos_livres.frequencia.valor);
    expect(valores).toEqual(["8,5", "9,0"]);
    const via = await servico.segunda_via(db, c.usuario, certificados[1]!);
    expect(_texto(via.bytes)).toContain("com frequência de 9,0");

    // certificado que saiu não se reescreve
    await expect(
      campos.gravar_valores_inscricao(db, c.usuario, a, modelo, { frequencia: "10" }, { frequencia: "8,5" }),
    ).rejects.toBeInstanceOf(RegraDaTurma);
    // a trilha leva o identificador público, não o nome
    const eventos = await campos.trilha_da_turma(db, turma.id);
    expect(eventos).toHaveLength(2);
    expect(eventos.every((ev) => !ev.descricao.includes("Schetino") && !ev.descricao.includes("Beatriz"))).toBe(true);
  });

  it("gravar pede a permissão de lançar nota", async () => {
    const c = await cenario();
    await trocar(c.modelo.id, "frequencia", { tipo: "PARTICIPANTE", rotulo: "Nota" });
    const turma = await turma_fresca(c.turma.id);
    const sem_nota = await _usuario(db, [...TODAS].filter((p) => p !== "turma.avaliar"), "sem_nota");
    await expect(
      campos.gravar_valores_inscricao(db, sem_nota, await inscricao_fresca(c.inscricao.id), await modelo_de(turma), { frequencia: "7" }, {}),
    ).rejects.toBeInstanceOf(PermissaoNegada);
  });
});

describe("campos de sistema novos", () => {
  it("campus e cidade do campus da turma", async () => {
    const c = await cenario();
    const [campus] = await db.insert(e.campus).values({ sigla: "TST", nome: "Campus de Teste", cidade: "Teófilo Otoni" }).returning();
    await db.update(e.turma).set({ campus_id: campus!.id }).where(eq(e.turma.id, c.turma.id));
    await trocar(c.modelo.id, "local", { tipo: "SISTEMA", campo: "turma_campus_cidade" });
    await trocar(c.modelo.id, "promotora", { tipo: "SISTEMA", campo: "turma_campus" });
    const resultado = await servico.emitir(db, c.usuario, await inscricao_fresca(c.inscricao.id));
    const texto = _texto(resultado.bytes);
    expect(texto).toContain("em Teófilo Otoni, promovido por Campus de Teste");
  });
});

describe("telas", () => {
  async function coordenador() {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
  }

  it("ficha do modelo: tipos de preenchimento e a nova versão leva tudo junto", async () => {
    await coordenador();
    const criado = await cliente.post(
      "/treinamentos/modelos",
      { nome: "Brigadista", arquivo: "certificado_padrao_v1.docx", orientacao: "PAISAGEM" },
      { seguir: false },
    );
    const v1 = Number(criado.location!.split("/")[3]!.split("?")[0]);
    const base = `/treinamentos/modelos/${v1}/tags`;
    await cliente.post(base, { marcador: "carga", tipo: "TEXTO_FIXO", texto_fixo: "10 (dez) tempos", obrigatorio: "1" });
    await cliente.post(base, { marcador: "local", tipo: "TURMA", rotulo: "Local de atuação do brigadista", obrigatorio: "1" });
    await cliente.post(base, { marcador: "nota_incendio", tipo: "PARTICIPANTE", rotulo: "Nota – Prevenção e combate a incêndio" });
    await cliente.post(base, { marcador: "curso", tipo: "SISTEMA", campo: "treinamento_nome" });
    // campo de turma sem nome é recusado
    const recusa = await cliente.post(base, { marcador: "setor", tipo: "TURMA", rotulo: "" });
    expect(recusa.text).toContain("Dê um nome ao campo da turma");

    const ficha = await cliente.get(`/treinamentos/modelos/${v1}`);
    expect(ficha.text).toContain("Local de atuação do brigadista");
    expect(ficha.text).toContain("10 (dez) tempos");
    expect(ficha.text).toContain("Campo do participante");

    // editar a linha pela tabela: a caixa `detalhe` vira o rótulo
    const [linha_local] = await db
      .select()
      .from(e.certificado_modelo_tag)
      .where(and(eq(e.certificado_modelo_tag.modelo_id, v1), eq(e.certificado_modelo_tag.marcador, "local")));
    await cliente.post(`${base}/${linha_local!.id}`, { tipo: "TURMA", campo: "", detalhe: "Edificação ou setor", ordem: "2", obrigatorio: "1" });

    const nova = await cliente.post(`/treinamentos/modelos/${v1}/versao`, {}, { seguir: false });
    const v2 = Number(nova.location!.split("/")[3]!.split("?")[0]);
    const tags = await db
      .select()
      .from(e.certificado_modelo_tag)
      .where(eq(e.certificado_modelo_tag.modelo_id, v2))
      .orderBy(asc(e.certificado_modelo_tag.marcador));
    expect(tags.map((t) => [t.marcador, t.tipo, t.campo, t.texto_fixo, t.rotulo, t.obrigatorio])).toEqual([
      ["carga", "TEXTO_FIXO", "", "10 (dez) tempos", null, true],
      ["curso", "SISTEMA", "treinamento_nome", null, null, false],
      ["local", "TURMA", "", null, "Edificação ou setor", true],
      ["nota_incendio", "PARTICIPANTE", "", null, "Nota – Prevenção e combate a incêndio", false],
    ]);
  });

  it("ficha da turma: formulários da turma e do participante, e a trilha", async () => {
    const c = await cenario([["2220001", "Beatriz Lemos Prado", "8"]]);
    await trocar(c.modelo.id, "local", { tipo: "TURMA", rotulo: "Local de atuação do brigadista", obrigatorio: true });
    await trocar(c.modelo.id, "frequencia", { tipo: "PARTICIPANTE", rotulo: "Nota – Primeiros socorros", obrigatorio: true });
    await coordenador();
    const ficha = `/turmas/${c.turma.id}?aba=emissao`;
    const antes = await cliente.get(ficha);
    expect(antes.text).toContain("Dados do certificado desta turma");
    expect(antes.text).toContain("Nota – Primeiros socorros");
    expect(antes.text).toContain("falta preencher");

    await cliente.post(`/turmas/${c.turma.id}/campos-certificado`, { v_local: "Prédio da Reitoria" });
    await cliente.post(`/turmas/${c.turma.id}/campos-participante`, {
      [`v_${c.inscricao.id}_frequencia`]: "7,5",
      [`v_${c.outras[0]!.id}_frequencia`]: "9",
    });
    expect(await campos.valores_da_turma(db, c.turma.id)).toEqual({ local: "Prédio da Reitoria" });
    expect(await campos.valores_dos_inscritos(db, c.turma.id)).toEqual({
      [c.inscricao.id]: { frequencia: "7,5" },
      [c.outras[0]!.id]: { frequencia: "9" },
    });

    const depois = await cliente.get(ficha);
    expect(depois.text).toContain("Alterações nestes dados");
    expect(depois.text).toContain("Prédio da Reitoria");
    expect(depois.text).not.toContain("falta preencher");

    await cliente.post(`/turmas/${c.turma.id}/certificados`, {});
    expect(await db.select().from(e.certificado)).toHaveLength(2);
  });
});
