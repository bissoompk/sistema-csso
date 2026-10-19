/**
 * NUVEM: o caminho mais curto do curso JÁ DADO até o certificado, pela tela,
 * a partir do banco recém-semeado (só sementes + contas): treinamento com os
 * defaults, assinatura externa sem data, turma com datas passadas, dois
 * externos, "Registrar turma já realizada" e a emissão no modelo genérico que
 * a semente cria ("Padrão da casa").
 */
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_turma from "../src/servicos/turma.js";
import { modelo_da_turma } from "../src/servicos/emissao_certificado.js";
import { VIGENCIA_DESDE_SEMPRE } from "../src/rotas/treinamentos.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Resposta } from "./ajuda";

const { db, cliente } = await bancoLimpo();
await contas(db);

const ONTEM = somar_dias(datas_br.hoje(), -1);
const ANTEONTEM = somar_dias(datas_br.hoje(), -2);

function redireciona(r: Resposta) {
  expect(r.status, r.text.slice(0, 800)).toBe(303);
  return r.headers.get("location") ?? "";
}

async function eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("treinamento simplificado: o curso já dado até o certificado", () => {
  it("do zero ao .docx, pela tela, no modelo genérico semeado", async () => {
    await entrar(cliente, "coordenador_csso");

    // treinamento com os defaults: validade vazia = não expira
    redireciona(
      await cliente.post(
        "/treinamentos/catalogo",
        { codigo: "BRIGADA", nome: "Brigada de incêndio", carga_horaria_horas: "16", validade_meses: "" },
        { seguir: false },
      ),
    );
    const [treinamento] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIGADA"));
    expect(treinamento!.validade_meses).toBe(0);

    // assinatura externa sem início de vigência: desde sempre
    redireciona(
      await cliente.post(
        "/treinamentos/assinaturas",
        { nome: "Vitalina Escobar Rangel", externo: "1", titulo: "Bombeira civil" },
        { seguir: false },
      ),
    );
    const [assinatura] = await db.select().from(e.assinatura_instrutor);
    expect(assinatura!.vigencia_inicio).toBe(VIGENCIA_DESDE_SEMPRE);

    // turma de dois dias, já passada
    const ficha = redireciona(
      await cliente.post(
        "/turmas",
        { treinamento_id: String(treinamento!.id), data_inicio: ANTEONTEM, data_fim: ONTEM, local: "Pátio do Campus JK" },
        { seguir: false },
      ),
    );
    const [turma] = await db.select().from(e.turma);
    expect(ficha).toContain(`/turmas/${turma!.id}`);
    expect(turma!.situacao).toBe("PLANEJADA");
    redireciona(
      await cliente.post(
        `/turmas/${turma!.id}/instrutores`,
        { assinatura_instrutor_id: String(assinatura!.id), assina_certificado: "1" },
        { seguir: false },
      ),
    );
    for (const nome of ["Wagner Estrela Lopes", "Maria Aparecida de Souza"]) {
      redireciona(
        await cliente.post(
          `/turmas/${turma!.id}/inscricoes`,
          { nome, vinculo: "TERCEIRIZADO", organizacao: "Empresa de Teste" },
          { seguir: false },
        ),
      );
    }

    // a ficha oferece o atalho; um clique registra presença e conclui
    expect((await cliente.get(`/turmas/${turma!.id}`)).text).toContain("Registrar turma já realizada");
    const destino = redireciona(await cliente.post(`/turmas/${turma!.id}/realizada`, {}, { seguir: false }));
    expect(destino).toContain("aba=emissao");
    const [concluida] = await db.select().from(e.turma).where(eq(e.turma.id, turma!.id));
    expect(concluida!.situacao).toBe("CONCLUIDA");
    const inscricoes = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma!.id));
    expect(inscricoes.map((i) => i.situacao)).toEqual(["APROVADO", "APROVADO"]);
    // 16h em dois dias: 8h + 8h para cada um, lançadas e auditadas como de costume
    const presencas = await db.select().from(e.turma_presenca).orderBy(asc(e.turma_presenca.data));
    expect(presencas).toHaveLength(4);
    expect(presencas.every((p) => p.presente && Number(p.horas) === 8)).toBe(true);
    expect(await eventos("PRESENCA_LANCADA")).toHaveLength(4);
    expect(await eventos("TURMA_REALIZADA_REGISTRADA")).toHaveLength(1);
    expect(await eventos("TURMA_APURADA")).toHaveLength(1);

    // emissão em lote, no genérico semeado
    redireciona(await cliente.post(`/turmas/${turma!.id}/certificados`, {}, { seguir: false }));
    const certificados = await db.select().from(e.certificado);
    expect(certificados).toHaveLength(2);
    const [generico] = await db.select().from(e.certificado_modelo);
    expect(generico!.nome).toBe("Padrão da casa");
    expect(certificados.every((c) => c.modelo_id === generico!.id)).toBe(true);
    const docx = await cliente.get(`/certificados/${certificados[0]!.id}/documento`);
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-type")).toContain("wordprocessingml");

    // o PDF com QR: de um certificado e da turma inteira
    const pdf = await cliente.get(`/certificados/${certificados[0]!.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toMatch(/Certificado_.*\.pdf/);
    expect(pdf.text.startsWith("%PDF-")).toBe(true);
    const lote = await cliente.get(`/turmas/${turma!.id}/certificados.pdf`);
    expect(lote.status).toBe(200);
    expect(lote.headers.get("content-disposition")).toContain("Certificados_");
    expect((await cliente.get(`/turmas/${turma!.id}?aba=emissao`)).text).toContain("Baixar todos em PDF");
  });

  it("com nota mínima, o atalho só lança presença e não inventa nota", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const [treinamento] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIGADA"));
    const turma = await servico_turma.criar_turma(db, usuario, {
      treinamento: treinamento!,
      data_inicio: ONTEM,
      data_fim: ONTEM,
      nota_minima_aprovacao: "7",
    });
    const [participante] = await db.select().from(e.participante).limit(1);
    redireciona(
      await cliente.post(
        `/turmas/${turma.id}/inscricoes`,
        { participante_id: String(participante!.id) },
        { seguir: false },
      ),
    );
    const destino = redireciona(await cliente.post(`/turmas/${turma.id}/realizada`, {}, { seguir: false }));
    expect(destino).toContain("aba=presencas");
    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, turma.id));
    expect(depois!.situacao).toBe("EM_ANDAMENTO");
    const [inscricao] = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, turma.id));
    expect(inscricao!.nota_final).toBeNull();
    expect(inscricao!.situacao).toBe("PRESENTE");
  });

  it("o instrutor padrão do catálogo entra sozinho na turma", async () => {
    const usuario = await usuarioAtual(db, "coordenador_csso");
    const [assinatura] = await db.select().from(e.assinatura_instrutor);
    await db.update(e.treinamento).set({ instrutor_padrao_id: assinatura!.id }).where(eq(e.treinamento.codigo, "BRIGADA"));
    const [treinamento] = await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, "BRIGADA"));
    const turma = await servico_turma.criar_turma(db, usuario, { treinamento: treinamento!, data_inicio: ONTEM, data_fim: ONTEM });
    expect(turma.instrutores.map((v) => v.assinatura_instrutor_id)).toEqual([assinatura!.id]);
    const vinculos = await db
      .select()
      .from(e.turma_instrutor)
      .where(and(eq(e.turma_instrutor.turma_id, turma.id), eq(e.turma_instrutor.assina_certificado, true)));
    expect(vinculos).toHaveLength(1);
  });

  it("mapear sugeridos completa o dicionário de um modelo novo num POST", async () => {
    redireciona(
      await cliente.post(
        "/treinamentos/modelos",
        { nome: "Outro layout", arquivo: "certificado_padrao_v1.docx", orientacao: "PAISAGEM" },
        { seguir: false },
      ),
    );
    const [modelo] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.nome, "Outro layout"));
    // o arquivo vem da lista do manifesto, não de texto livre
    const tela = (await cliente.get("/treinamentos/modelos")).text;
    expect(tela).toContain('<option value="certificado_padrao_v1.docx"');
    await cliente.post(`/treinamentos/modelos/${modelo!.id}/tags`, { marcador: "curso", campo: "treinamento_conteudo" });
    expect((await cliente.get(`/treinamentos/modelos/${modelo!.id}`)).text).toContain("Mapear sugeridos (22)");
    redireciona(await cliente.post(`/treinamentos/modelos/${modelo!.id}/tags/sugeridas`, {}, { seguir: false }));
    const tags = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.modelo_id, modelo!.id));
    expect(tags).toHaveLength(23);
    // o que já estava mapeado não muda
    expect(tags.find((t) => t.marcador === "curso")!.campo).toBe("treinamento_conteudo");
    expect((await cliente.get(`/treinamentos/modelos/${modelo!.id}`)).text).toContain("o mapa cobre o arquivo");

    // dois genéricos vigentes já não bloqueiam: sai o mais recente
    const [qualquer] = await db.select().from(e.turma).limit(1);
    const turma = (await servico_turma.carregar_turma(db, qualquer!.id))!;
    const [escolhido] = await modelo_da_turma(db, turma);
    expect(escolhido!.id).toBe(modelo!.id);
  });
});
