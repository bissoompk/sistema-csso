/**
 * As sementes: idempotentes, completas e fiéis à matriz de perfis.
 * O Python não tinha um arquivo só para isto (o `banco` fixture semeava em todo
 * teste); aqui o `globalSetup` semeia o modelo uma vez, e este arquivo cobra o
 * que o modelo tem de ter.
 */
import { describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { MATRIZ_PERFIS, PERMISSOES, PERMISSOES_RETIRADAS, _conferir_retiradas, modulo_da_permissao } from "../src/servicos/rbac.js";
import * as auditoria from "../src/servicos/auditoria.js";
import { semear, semear_rbac, TEXTO_NR15_AX14 } from "../src/servicos/sementes.js";
import { conferir_modelo } from "../src/servicos/certificado.js";
import { bancoLimpo, naTransacao } from "./ajuda";

const { db } = await bancoLimpo();

async function contagens() {
  const tabelas = {
    permissao: e.permissao,
    perfil: e.perfil,
    perfil_permissao: e.perfil_permissao,
    campus: e.campus,
    unidade_uorg: e.unidade_uorg,
    posto_trabalho: e.posto_trabalho,
    cargo: e.cargo,
    tipo_risco: e.tipo_risco,
    tipo_adicional: e.tipo_adicional,
    percentual_aplicavel: e.percentual_aplicavel,
    tipo_movimento: e.tipo_movimento,
    fundamentacao_legal: e.fundamentacao_legal,
    agente_nocivo: e.agente_nocivo,
    tipo_marco_inicial: e.tipo_marco_inicial,
    tipo_processo: e.tipo_processo,
    fluxo_etapa: e.fluxo_etapa,
    texto_padrao: e.texto_padrao,
    autoridade_destinataria: e.autoridade_destinataria,
    setor_emissor: e.setor_emissor,
    profissional_habilitado: e.profissional_habilitado,
    epi_categoria: e.epi_categoria,
    epi_motivo_recusa: e.epi_motivo_recusa,
    certificado_modelo: e.certificado_modelo,
    certificado_modelo_tag: e.certificado_modelo_tag,
  };
  const r: Record<string, number> = {};
  for (const [nome, t] of Object.entries(tabelas)) {
    const [l] = await db.select({ n: count() }).from(t);
    r[nome] = Number(l!.n);
  }
  return r;
}

describe("sementes", () => {
  it("o modelo nasce com os números do Python", async () => {
    expect(await contagens()).toEqual({
      permissao: Object.keys(PERMISSOES).length,
      perfil: Object.keys(MATRIZ_PERFIS).length,
      perfil_permissao: Object.values(MATRIZ_PERFIS).reduce((n, p) => n + p.permissoes.length, 0),
      campus: 4,
      unidade_uorg: 15,
      posto_trabalho: 7,
      cargo: 2,
      tipo_risco: 4,
      tipo_adicional: 4,
      percentual_aplicavel: 8,
      tipo_movimento: 5,
      fundamentacao_legal: 2,
      agente_nocivo: 3,
      tipo_marco_inicial: 4,
      tipo_processo: 9,
      fluxo_etapa: 8,
      texto_padrao: 9,
      autoridade_destinataria: 1,
      setor_emissor: 3,
      profissional_habilitado: 1,
      epi_categoria: 9,
      epi_motivo_recusa: 8,
      // NUVEM: o genérico "Padrão da casa" — a v1 (23 marcadores, superada,
      // para as segundas vias) e a v2 vigente (22, as frases inteiras)
      certificado_modelo: 2,
      certificado_modelo_tag: 45,
    });
  });

  it("rodar de novo não duplica nada", async () => {
    const antes = await contagens();
    await naTransacao((tx) => semear(tx));
    await naTransacao((tx) => semear(tx));
    expect(await contagens()).toEqual(antes);
  });

  it("cada perfil tem exatamente as permissões da matriz", async () => {
    const linhas = await db
      .select({ perfil: e.perfil.codigo, permissao: e.permissao.codigo })
      .from(e.perfil_permissao)
      .innerJoin(e.perfil, eq(e.perfil.id, e.perfil_permissao.perfil_id))
      .innerJoin(e.permissao, eq(e.permissao.id, e.perfil_permissao.permissao_id));
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      const doBanco = linhas.filter((l) => l.perfil === codigo).map((l) => l.permissao).sort();
      expect(doBanco, codigo).toEqual([...dados.permissoes].sort());
    }
  });

  it("descrição e módulo da permissão são do código: o seed os reescreve", async () => {
    await db.update(e.permissao).set({ descricao: "editada no banco", modulo: "ADICIONAL" }).where(eq(e.permissao.codigo, "epi.ver"));
    await naTransacao((tx) => semear_rbac(tx));
    const [p] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "epi.ver"));
    expect(p!.descricao).toBe(PERMISSOES["epi.ver"]);
    expect(p!.modulo).toBe(modulo_da_permissao("epi.ver"));
    expect(p!.modulo).toBe("EPI");
  });

  it("banco de produção com o superintendente antigo ganha as permissões novas no próximo seed", async () => {
    // o perfil como estava gravado antes de virar operacional: sem escrita
    const [sup] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "superintendente"));
    const novas = ["processo.criar", "catalogo.gerenciar", "usuario.criar_conta", "backup.executar"];
    const ids = (await db.select().from(e.permissao)).filter((p) => novas.includes(p.codigo)).map((p) => p.id);
    for (const id of ids) {
      await db.delete(e.perfil_permissao).where(and(eq(e.perfil_permissao.perfil_id, sup!.id), eq(e.perfil_permissao.permissao_id, id)));
    }
    await naTransacao((tx) => semear_rbac(tx));
    const agora = await db
      .select({ codigo: e.permissao.codigo })
      .from(e.perfil_permissao)
      .innerJoin(e.permissao, eq(e.permissao.id, e.perfil_permissao.permissao_id))
      .where(eq(e.perfil_permissao.perfil_id, sup!.id));
    const codigos = agora.map((l) => l.codigo);
    for (const p of novas) expect(codigos).toContain(p);
    expect(codigos).not.toContain("parecer.assinar");
    expect(codigos).not.toContain("laudo.criar");
  });

  it("semear_rbac nunca remove permissão de perfil (só acrescenta)", async () => {
    const [perfil] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "servidor_consulta"));
    const [extra] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "backup.executar"));
    await db.insert(e.perfil_permissao).values({ perfil_id: perfil!.id, permissao_id: extra!.id });
    await naTransacao((tx) => semear_rbac(tx));
    const ainda = await db
      .select()
      .from(e.perfil_permissao)
      .where(eq(e.perfil_permissao.perfil_id, perfil!.id));
    expect(ainda.some((l) => l.permissao_id === extra!.id)).toBe(true);
    await db.delete(e.perfil_permissao).where(eq(e.perfil_permissao.permissao_id, extra!.id));
    await naTransacao((tx) => semear_rbac(tx)); // recoloca no admin_ti
  });

  it("a retirada declarada sai do perfil já gravado, com evento na trilha, e só uma vez", async () => {
    // o banco como estava antes de 22/10/2026: o admin_ti com indicador.ver
    const [admin] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "admin_ti"));
    const [indicador] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "indicador.ver"));
    await db.insert(e.perfil_permissao).values({ perfil_id: admin!.id, permissao_id: indicador!.id });
    await naTransacao((tx) => semear_rbac(tx));
    await naTransacao((tx) => semear_rbac(tx));
    const ainda = await db
      .select()
      .from(e.perfil_permissao)
      .where(and(eq(e.perfil_permissao.perfil_id, admin!.id), eq(e.perfil_permissao.permissao_id, indicador!.id)));
    expect(ainda).toEqual([]);
    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(
        and(
          eq(e.historico_evento.tipo_evento, auditoria.PERMISSAO_RETIRADA_DO_PERFIL),
          eq(e.historico_evento.entidade, "perfil"),
          eq(e.historico_evento.entidade_id, admin!.id),
        ),
      );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.valor_anterior).toBe("indicador.ver");
    expect(eventos[0]!.descricao).toContain("'indicador.ver' retirada do perfil 'admin_ti'");
    expect(auditoria.ROTULO_EVENTO[auditoria.PERMISSAO_RETIRADA_DO_PERFIL]).toBe("Permissão retirada do perfil");
    // os outros perfis com indicador.ver continuam com ela
    const [coordenador] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "coordenador_csso"));
    const do_coordenador = await db
      .select()
      .from(e.perfil_permissao)
      .where(and(eq(e.perfil_permissao.perfil_id, coordenador!.id), eq(e.perfil_permissao.permissao_id, indicador!.id)));
    expect(do_coordenador).toHaveLength(1);
  });

  it("retirada e concessão da mesma permissão ao mesmo perfil não convivem", () => {
    expect(PERMISSOES_RETIRADAS).toContainEqual(expect.objectContaining({ perfil: "admin_ti", permissao: "indicador.ver" }));
    expect(MATRIZ_PERFIS.admin_ti!.permissoes).not.toContain("indicador.ver");
    expect(() => _conferir_retiradas()).not.toThrow();
  });

  it("textos literais com aspas curvas, byte a byte", async () => {
    const [f] = await db
      .select()
      .from(e.fundamentacao_legal)
      .where(eq(e.fundamentacao_legal.codigo, "NR15_AX14_INFECTO"));
    expect(f!.texto).toBe(TEXTO_NR15_AX14);
    expect(f!.texto.startsWith("“")).toBe(true);
  });

  it("hierarquia das unidades e decimal do percentual sem float", async () => {
    const [dzo] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "DZO"));
    const [fca] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "FCA"));
    expect(dzo!.unidade_pai_id).toBe(fca!.id);
    const valores = (await db.select().from(e.percentual_aplicavel)).map((p) => p.valor).sort();
    expect(valores).toContain("10.00");
    expect(valores).toContain("5.00");
  });

  it("a habilitação semeada é a do Fabrício, sem conta ligada", async () => {
    const [h] = await db.select().from(e.profissional_habilitado);
    expect(h!.nome).toBe("Fabrício Raimundi Andrade");
    expect(h!.habilitacao).toBe("ENG_SEG_TRABALHO");
    expect(h!.usuario_id).toBeNull();
  });

  it("o agente sinônimo aponta para o canônico", async () => {
    const [sinonimo] = await db
      .select()
      .from(e.agente_nocivo)
      .where(eq(e.agente_nocivo.descricao, "Manuseio de substâncias químicas"));
    const [canonico] = await db
      .select()
      .from(e.agente_nocivo)
      .where(eq(e.agente_nocivo.descricao, "Manipulação de produtos químicos"));
    expect(sinonimo!.agente_canonico_id).toBe(canonico!.id);
  });

  it("o modelo genérico semeado confere com o .docx e não volta depois de aposentado", async () => {
    const [modelo] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.vigente, true));
    expect(modelo!.treinamento_id).toBeNull();
    expect(modelo!.nome).toBe("Padrão da casa");
    expect(modelo!.versao).toBe(2);
    expect(modelo!.arquivo).toBe("certificado_padrao_v2.docx");
    const [v1] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.vigente, false));
    expect([v1!.versao, v1!.arquivo]).toEqual([1, "certificado_padrao_v1.docx"]);
    const tags = await db.select().from(e.certificado_modelo_tag).where(eq(e.certificado_modelo_tag.modelo_id, modelo!.id));
    const mapa = Object.fromEntries(tags.map((t) => [t.marcador, t.campo]));
    expect(conferir_modelo(modelo!.arquivo, mapa).ok).toBe(true);
    // genérico existente (mesmo superado) não é recriado
    await db.update(e.certificado_modelo).set({ vigente: false }).where(eq(e.certificado_modelo.id, modelo!.id));
    await naTransacao((tx) => semear(tx));
    expect(await db.select().from(e.certificado_modelo)).toHaveLength(2);
    await db.update(e.certificado_modelo).set({ vigente: true }).where(eq(e.certificado_modelo.id, modelo!.id));
  });
});
