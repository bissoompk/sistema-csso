/**
 * O código curto do treinamento (22/10/2026): entra no número do certificado
 * (`CSSO-NR35-2026-0001`).
 *
 * - a sugestão em TypeScript (`sugerir_codigo_curto`) e a do banco
 *   (`csso_sugerir_codigo_curto`, usada pela migração e pela trava) dão o
 *   MESMO resultado;
 * - a trava preenche o código vazio e acrescenta algarismo no repetido;
 * - o catálogo exige, valida, passa para caixa alta, recusa o duplicado com
 *   mensagem clara, sugere quando vem vazio, mostra na lista e grava a troca
 *   na trilha (CAMPO_ALTERADO).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { sugerir_codigo_curto } from "../src/dominio/treinamento.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

// [nome, código do catálogo]
const NOMES: [string, string | null][] = [
  ["Trabalho em Altura — NR-35", "NR-35"],
  ["Trabalho em Altura — NR-35", null],
  ["Uso correto de EPI (NR 6)", null],
  ["Uso correto de EPI NR-06", null],
  ["Segurança em Instalações Elétricas – NR10 Básico", null],
  ["Curso NR-100 avançado", null],
  ["SNR-35 não é norma", null],
  ["Primeiros Socorros", null],
  ["Primeiros Socorros", "PRIM_SOCORROS"],
  ["Brigada de Incêndio", null],
  ["Combate a incêndio para brigadistas", null],
  ["Direção Defensiva de Veículos Oficiais e Ambulâncias e Motocicletas da Universidade", null],
  ["Ação de Saúde do Servidor", null],
  ["Ergonomia", null],
  ["Ergonomia", "X"],
  ["IA", null],
  ["A", null],
  ["", null],
  ["Prevenção às LER/DORT", "LER.DORT-2026"],
  ["Ética no serviço público", "ÉTICA"],
  ["Curso de NR 33 — espaço confinado", null],
  ["Treinamento dos Brigadistas das Unidades", null],
  ["Coleta e descarte de resíduos de saúde", "RSS"],
];

const NR35 = {
  codigo: "NR-35",
  nome: "Trabalho em Altura — NR-35",
  carga_horaria_horas: "8",
  validade_meses: "24",
  norma_referencia: "NR-35",
  conteudo_programatico: "Análise de risco",
};

async function _por_codigo(codigo: string) {
  return (await db.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo)))[0];
}

describe("a sugestão: TypeScript e banco concordam", () => {
  it("a mesma resposta para cada nome da lista", async () => {
    for (const [nome, codigo] of NOMES) {
      const [linha] = await db.execute<{ s: string }>(sql`SELECT csso_sugerir_codigo_curto(${nome}, ${codigo}) AS s`);
      expect(sugerir_codigo_curto(nome, codigo), `${nome} / ${codigo}`).toBe(linha!.s);
    }
  });

  it("o navegador (csso.js) sugere o mesmo que o servidor", () => {
    const fonte = readFileSync(new URL("../public/estaticos/js/csso.js", import.meta.url), "utf8");
    const inicio = fonte.indexOf("var PARTICULAS_CODIGO");
    const fim = fonte.indexOf("function preencherCodigoCurto");
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    const sugerir_js = new Function(`${fonte.slice(inicio, fim)}; return sugerirCodigoCurto;`)() as (
      nome: string,
      codigo: string | null,
    ) => string;
    for (const [nome, codigo] of NOMES) expect(sugerir_js(nome, codigo), `${nome} / ${codigo}`).toBe(sugerir_codigo_curto(nome, codigo));
  });

  it("os casos que a regra promete", () => {
    expect(sugerir_codigo_curto("Trabalho em Altura — NR-35")).toBe("NR35");
    expect(sugerir_codigo_curto("Uso de EPI NR-06")).toBe("NR6");
    expect(sugerir_codigo_curto("Primeiros Socorros", "PRIM_SOCORROS")).toBe("PRIMSOCORR");
    expect(sugerir_codigo_curto("Brigada de Incêndio")).toBe("BI");
    expect(sugerir_codigo_curto("Ergonomia")).toBe("ERGO");
    expect(sugerir_codigo_curto("")).toBe("TR");
  });
});

describe("a trava do banco", () => {
  it("preenche o código vazio e acrescenta algarismo no repetido", async () => {
    const [a] = await db
      .insert(e.treinamento)
      .values({ codigo: "TESTE-ALTURA-1", nome: "Teste de Altura — NR-35 (um)", carga_horaria_horas: "8" })
      .returning();
    const [b] = await db
      .insert(e.treinamento)
      .values({ codigo: "TESTE-ALTURA-2", nome: "Teste de Altura — NR-35 (dois)", carga_horaria_horas: "8", codigo_curto: "" })
      .returning();
    const base = sugerir_codigo_curto(a!.nome, a!.codigo);
    expect(base).toBe("NR35");
    // o banco semeado pode já ter um NR35: o primeiro livre vem da mesma função
    const ocupados = new Set(
      (await db.select({ c: e.treinamento.codigo_curto }).from(e.treinamento)).map((x) => x.c),
    );
    expect(ocupados.has(a!.codigo_curto)).toBe(true);
    expect(a!.codigo_curto.startsWith("NR35")).toBe(true);
    expect(b!.codigo_curto.startsWith("NR35")).toBe(true);
    expect(b!.codigo_curto).not.toBe(a!.codigo_curto);
    expect(b!.codigo_curto).toMatch(/^NR35\d+$/);
  });

  it("o código curto repetido digitado à mão é recusado pelo banco", async () => {
    await db.insert(e.treinamento).values({ codigo: "TESTE-X", nome: "Teste X", carga_horaria_horas: "8", codigo_curto: "TESTX" });
    await expect(
      db.insert(e.treinamento).values({ codigo: "TESTE-Y", nome: "Teste Y", carga_horaria_horas: "8", codigo_curto: "TESTX" }),
    ).rejects.toThrow();
  });
});

describe("o catálogo", () => {
  beforeEach(async () => {
    await contas(db);
    await entrar(cliente, "coordenador_csso");
  });

  it("a tela mostra o código curto, o campo obrigatório e a explicação", async () => {
    await db.insert(e.treinamento).values({ codigo: "TESTE-LISTA", nome: "Curso da Lista", carga_horaria_horas: "4", codigo_curto: "LISTA" });
    const tela = (await cliente.get("/treinamentos/catalogo")).text;
    expect(tela).toContain("Código curto");
    expect(tela).toContain('<span class="mono codigo-curto">LISTA</span>');
    expect(tela).toMatch(/name="codigo_curto"[^>]*required/);
    expect(tela).toContain('data-sugerir-codigo-curto="novo-nome"');
    expect(tela).toContain('maxlength="10" pattern="[A-Za-z0-9]{2,10}"');
    // na edição, o código de hoje já vem no campo (e o navegador não o troca)
    expect(tela).toContain('value="LISTA"');
    expect(tela).toContain("entra no número do certificado");
    expect(tela).toContain("não altera os certificados já emitidos");
  });

  it("com código do catálogo digitado, a sugestão parte dele", async () => {
    await cliente.post("/treinamentos/catalogo", { ...NR35, codigo: "RSS-01", nome: "Resíduos de Saúde", codigo_curto: "" }, { seguir: false });
    expect((await _por_codigo("RSS-01"))!.codigo_curto).toBe("RSS01");
  });

  it("o código que sai do nome corta na palavra, e a mensagem diz o nome", async () => {
    const r = await cliente.post(
      "/treinamentos/catalogo",
      { ...NR35, codigo: "", nome: "Segurança no Trabalho em Máquinas e Equipamentos (NR-12)", codigo_curto: "NR12" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.location!)).toContain("Treinamento “Segurança no Trabalho em Máquinas e Equipamentos (NR-12)” cadastrado");
    expect(await _por_codigo("SEGURANCA_NO_TRABALHO_EM")).toBeTruthy();
  });

  it("cadastro: digitado em minúscula vira caixa alta", async () => {
    const r = await cliente.post("/treinamentos/catalogo", { ...NR35, codigo: "TESTE-A", nome: "Teste A", codigo_curto: " tsta " }, { seguir: false });
    expect(r.status).toBe(303);
    expect((await _por_codigo("TESTE-A"))!.codigo_curto).toBe("TSTA");
  });

  it("cadastro em branco recebe a sugestão do nome (já livre)", async () => {
    const r = await cliente.post(
      "/treinamentos/catalogo",
      { ...NR35, codigo: "", nome: "Treinamento Ômega de Qualidade", codigo_curto: "" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    // o código do catálogo saiu do nome (TREINAMENTO_OMEGA…), mas a sugestão
    // usa as iniciais — a mesma que o navegador mostra enquanto o nome é digitado
    const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.nome, "Treinamento Ômega de Qualidade"));
    expect(t!.codigo_curto).toBe("TOQ");
    // a trilha do cadastro diz qual código saiu
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "treinamento"), eq(e.historico_evento.tipo_evento, "TREINAMENTO_CRIADO")));
    expect(evento!.descricao).toContain("código curto TOQ");
  });

  it("cadastro: formato inválido e duplicado são recusados com mensagem clara", async () => {
    const invalido = await cliente.post("/treinamentos/catalogo", { ...NR35, codigo: "TESTE-C", nome: "Teste C", codigo_curto: "NR-35" });
    expect(invalido.status).toBe(200);
    expect(invalido.text).toContain("Código curto inválido");
    expect(await _por_codigo("TESTE-C")).toBeUndefined();

    await db.insert(e.treinamento).values({ codigo: "TESTE-D", nome: "Curso Dono", carga_horaria_horas: "4", codigo_curto: "DONO" });
    const repetido = await cliente.post("/treinamentos/catalogo", { ...NR35, codigo: "TESTE-E", nome: "Teste E", codigo_curto: "dono" });
    expect(repetido.status).toBe(200);
    expect(repetido.text).toContain("O código curto DONO já é do treinamento “Curso Dono”");
    expect(repetido.text).toContain("por exemplo, DONO2");
    expect(await _por_codigo("TESTE-E")).toBeUndefined();
  });

  it("edição: troca o código, grava CAMPO_ALTERADO; sem o campo, mantém; duplicado recusa", async () => {
    const [t] = await db
      .insert(e.treinamento)
      .values({ codigo: "TESTE-F", nome: "Curso Efe", carga_horaria_horas: "8", validade_meses: 24, codigo_curto: "EFE" })
      .returning();
    await db.insert(e.treinamento).values({ codigo: "TESTE-G", nome: "Curso Gê", carga_horaria_horas: "8", codigo_curto: "GE" });
    const campos = { nome: "Curso Efe", carga_horaria_horas: "8", validade_meses: "24", ativo: "1" };

    const trocou = await cliente.post(`/treinamentos/catalogo/${t!.id}`, { ...campos, codigo_curto: "efe2" }, { seguir: false });
    expect(trocou.status).toBe(303);
    const [depois] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id));
    expect(depois!.codigo_curto).toBe("EFE2");
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(
        and(
          eq(e.historico_evento.entidade, "treinamento"),
          eq(e.historico_evento.entidade_id, t!.id),
          eq(e.historico_evento.campo, "codigo_curto"),
        ),
      );
    expect(evento!.tipo_evento).toBe("CAMPO_ALTERADO");
    expect(evento!.valor_anterior).toBe("EFE");
    expect(evento!.valor_novo).toBe("EFE2");

    // o formulário antigo (sem o campo) não apaga o código
    expect((await cliente.post(`/treinamentos/catalogo/${t!.id}`, campos, { seguir: false })).status).toBe(303);
    expect((await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id)))[0]!.codigo_curto).toBe("EFE2");

    const dup = await cliente.post(`/treinamentos/catalogo/${t!.id}`, { ...campos, codigo_curto: "GE" });
    expect(dup.status).toBe(200);
    expect(dup.text).toContain("O código curto GE já é do treinamento “Curso Gê”");
    const inv = await cliente.post(`/treinamentos/catalogo/${t!.id}`, { ...campos, codigo_curto: "E" });
    expect(inv.text).toContain("Código curto inválido");
    expect((await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id)))[0]!.codigo_curto).toBe("EFE2");
  });
});
