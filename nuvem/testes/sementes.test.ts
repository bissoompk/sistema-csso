/**
 * As sementes: idempotentes, completas e fiéis à matriz de perfis.
 * O Python não tinha um arquivo só para isto (o `banco` fixture semeava em todo
 * teste); aqui o `globalSetup` semeia o modelo uma vez, e este arquivo cobra o
 * que o modelo tem de ter.
 */
import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { MATRIZ_PERFIS, PERMISSOES, modulo_da_permissao } from "../src/servicos/rbac.js";
import { semear, semear_rbac, TEXTO_NR15_AX14 } from "../src/servicos/sementes.js";
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
});
