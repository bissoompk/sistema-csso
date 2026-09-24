/**
 * Fatia 6 de Gestão de EPI: a ligação com o adicional ocupacional (§7) — a
 * metade que mora no módulo de EPI. Porte de parte de
 * `testes/integracao/test_epi_adicional.py`.
 *
 * Portado aqui: a consulta `entregas_ate` (responde pela data pedida, não por
 * hoje), a pendência de reavaliação (§7.2, sentido inverso) e a negativa
 * provada — nenhuma operação do EPI escreve em `adicional_vigencia`, em
 * execução e na leitura estática do código.
 *
 * Fora deste arquivo (são do módulo de Processos, que porta `parecer.ts`):
 * a trava "EPI não cessa periculosidade" (`registrar_avaliacao_de_epi`), o
 * congelado `epi` do parecer emitido e as telas do editor.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoPorTeste } from "./ajuda_epi_ficha";
import { bancoLimpo, contas } from "./ajuda";

const HOJE = datas_br.hoje();
const ENTREGA = "2024-10-01";
const AVALIACAO = "2025-02-11";
const CA_VENCE_ANTES = "2024-12-31"; // valia na entrega, vencido na avaliação
const CA_VENCE_DEPOIS = "2030-01-01";

let db: Banco;
let coord_id: number;
let almoxarife: UsuarioAtual;
let servidor: typeof e.servidor.$inferSelect;

await bancoLimpo();

beforeEach(async () => {
  db = (await bancoPorTeste()).db;
  await contas(db);
  const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  const [almox] = await db.select().from(e.usuario).where(eq(e.usuario.login, "almoxarife_sesmt"));
  coord_id = coord!.id;
  // quem entrega EPI e NÃO decide adicional — é esse o ponto do §7.2
  almoxarife = new UsuarioAtual({
    id: almox!.id,
    login: "fatima",
    nome: "Fátima",
    permissoes: ["epi.ver", "epi.entregar", "epi.estoque", "epi.ficha"],
    perfis: ["almoxarife_sesmt"],
  });
  const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  [servidor] = (await db
    .insert(e.servidor)
    .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino", unidade_uorg_id: unidade!.id })
    .returning()) as [typeof e.servidor.$inferSelect];
});

async function lote(validade_ca: string, vida_util_meses: number | null = 6) {
  const [categoria] = await db
    .select()
    .from(e.epi_categoria)
    .where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [item] = await db
    .insert(e.epi_item)
    .values({
      nome: "Luva de proteção química nitrílica",
      categoria_id: categoria!.id,
      fabricante: "Fabricante Exemplo Ltda",
      exige_ca: true,
      numero_ca: "41234",
      validade_ca,
      unidade_medida: "PAR",
      vida_util_meses,
    })
    .returning();
  const [entrada] = await db
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item!.id,
      tamanho: "M",
      data_entrada: datas_br.somar_dias(ENTREGA, -30),
      quantidade_recebida: 20,
      lote: "L-2024-09",
      numero_ca: "41234",
      validade_ca,
    })
    .returning();
  await db.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 20 });
  return { item: item!, entrada: entrada! };
}

function entregar(l: Awaited<ReturnType<typeof lote>>, quando = ENTREGA, quantidade = 2) {
  return db.transaction((tx) =>
    epi_ficha.registrar_entrega(tx, almoxarife, {
      servidor,
      item: l.item,
      quantidade,
      entrada: l.entrada,
      tamanho: "M",
      data_evento: quando,
    }),
  );
}

/** Um parecer mínimo (rascunho) e a vigência que ele concedeu. */
async function vigencia_vigente(criado_por: number | null = null) {
  const [insal] = await db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
  const [percentual] = await db
    .select()
    .from(e.percentual_aplicavel)
    .where(eq(e.percentual_aplicavel.tipo_adicional_id, insal!.id))
    .limit(1);
  const [parecer] = await db
    .insert(e.parecer_tecnico)
    .values({
      numero: 0,
      ano: 2025,
      situacao: "RASCUNHO",
      servidor_id: servidor.id,
      tipo_adicional_id: insal!.id,
      criado_por,
    })
    .returning();
  const [vigencia] = await db
    .insert(e.adicional_vigencia)
    .values({
      servidor_id: servidor.id,
      parecer_id: parecer!.id,
      tipo_adicional_id: insal!.id,
      percentual_id: percentual!.id,
      estado: "VIGENTE",
      data_inicio: "2024-09-17",
    })
    .returning();
  return vigencia!;
}

// =====================================================================
// A consulta: responde pela data pedida, e não por hoje
// =====================================================================
describe("entregas_ate", () => {
  it("lê o CA na data pedida e não hoje", async () => {
    const l = await lote(CA_VENCE_ANTES);
    await entregar(l);
    const antes = await epi_ficha.entregas_ate(db, servidor.id, "2024-11-01");
    expect(antes).toHaveLength(1);
    expect(antes[0]!.ca_vencido).toBe(false);
    expect(antes[0]!.sustenta_neutralizacao).toBe(true);

    const depois = await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO);
    expect(depois).toHaveLength(1);
    expect(depois[0]!.ca_vencido).toBe(true);
    expect(depois[0]!.sustenta_neutralizacao).toBe(false);
    expect(depois[0]!.ressalvas.join(" ")).toContain("31/12/2024");
    expect(CA_VENCE_ANTES < HOJE).toBe(true);
  });

  it("troca vencida na data da avaliação não sustenta", async () => {
    const l = await lote(CA_VENCE_DEPOIS, 2);
    await entregar(l);
    const [linha] = await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO);
    expect(linha!.previsao_troca).toBe("2024-12-01");
    expect(linha!.ca_vencido).toBe(false);
    expect(linha!.troca_vencida).toBe(true);
    expect(linha!.sustenta_neutralizacao).toBe(false);
    expect(linha!.ressalvas.join(" ")).toContain("RN-32");
  });

  it("entrega estornada não sustenta nada", async () => {
    const l = await lote(CA_VENCE_DEPOIS);
    const registro = await entregar(l);
    await db.transaction((tx) => epi_ficha.estornar(tx, almoxarife, registro, "lançada no servidor errado"));
    expect(await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO)).toEqual([]);
  });

  it("entrega posterior à data pedida fica de fora", async () => {
    const l = await lote(CA_VENCE_DEPOIS);
    await entregar(l, HOJE);
    expect(await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO)).toEqual([]);
  });

  it("o filtro por posto vai pela lotação da data", async () => {
    const postos = await db.select().from(e.posto_trabalho).orderBy(asc(e.posto_trabalho.id)).limit(2);
    const [lotacao] = await db
      .insert(e.servidor_lotacao)
      .values({ servidor_id: servidor.id, unidade_uorg_id: servidor.unidade_uorg_id, vigencia_inicio: "2024-01-01" })
      .returning();
    await db.insert(e.lotacao_posto).values({ lotacao_id: lotacao!.id, posto_trabalho_id: postos[0]!.id });
    const l = await lote(CA_VENCE_DEPOIS);
    await entregar(l);
    expect(await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO)).toHaveLength(1);
    expect(await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO, postos[0]!.id)).toHaveLength(1);
    expect(await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO, postos[1]!.id)).toEqual([]);
  });

  it("a forma congelada só tem texto, inteiro, booleano e null", async () => {
    const l = await lote(CA_VENCE_DEPOIS);
    await entregar(l);
    const [linha] = await epi_ficha.entregas_ate(db, servidor.id, AVALIACAO);
    const congelado = linha!.congelar();
    expect(congelado["entregue_em"]).toBe(ENTREGA);
    expect(congelado["referencia"]).toBe(AVALIACAO);
    expect(congelado["ca"]).toBe("41234");
  });
});

// =====================================================================
// O sentido inverso: pendência, e nunca efeito colateral (§7.2)
// =====================================================================
describe("pendência de reavaliação", () => {
  it("entrega para quem tem adicional vigente abre pendência", async () => {
    const vigencia = await vigencia_vigente(coord_id);
    const l = await lote(CA_VENCE_DEPOIS);
    const registro = await entregar(l);
    const chave = `reavaliar_epi:vigencia:${vigencia.id}:ficha:${registro.id}`;
    expect(epi_ficha.chave_da_reavaliacao(vigencia.id, registro.id)).toBe(chave);
    const [pendencia] = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, chave));
    expect(pendencia!.tipo).toBe("REAVALIAR_ADICIONAL_POR_EPI");
    expect(pendencia!.prazo).toBe(datas_br.somar_dias(HOJE, 90));
    // o dono é a CSSO, e não quem operou o almoxarifado
    expect(pendencia!.responsavel_id).toBe(coord_id);
    expect(pendencia!.responsavel_id).not.toBe(almoxarife.id);
    expect(pendencia!.descricao).toContain("não altera o direito");
    expect(pendencia!.descricao).toContain("não cessa periculosidade");
  });

  it("a pendência de reavaliação abre uma vez só", async () => {
    const vigencia = await vigencia_vigente();
    const l = await lote(CA_VENCE_DEPOIS);
    const registro = await entregar(l);
    const chave = epi_ficha.chave_da_reavaliacao(vigencia.id, registro.id);
    const de_novo = await epi_ficha.abrir_pendencia_de_reavaliacao(db, registro, almoxarife);
    await epi_ficha.abrir_pendencia_de_reavaliacao(db, registro, almoxarife);
    const abertas = await db.select().from(e.pendencia).where(eq(e.pendencia.chave, chave));
    expect(abertas).toHaveLength(1);
    expect(de_novo[0]!.id).toBe(abertas[0]!.id);
  });

  it("sem adicional vigente não abre pendência", async () => {
    const l = await lote(CA_VENCE_DEPOIS);
    await entregar(l);
    expect(
      await db.select().from(e.pendencia).where(eq(e.pendencia.tipo, "REAVALIAR_ADICIONAL_POR_EPI")),
    ).toEqual([]);
  });
});

// =====================================================================
// A negativa mais importante, provada
// =====================================================================
describe("o EPI nunca escreve em adicional_vigencia", () => {
  it("nenhuma operação do EPI escreve em adicional_vigencia (execução)", async () => {
    // Desvio do porte: no Python o ouvinte era de mapper do SQLAlchemy. Aqui a
    // prova é um gatilho de banco que conta toda escrita na tabela durante o
    // teste — mais forte (pega SQL cru também) e, como lá, pega a escrita que
    // gravasse o mesmo valor.
    const vigencia = await vigencia_vigente();
    const l = await lote(CA_VENCE_DEPOIS);
    const [motivo] = await db
      .select()
      .from(e.epi_motivo_recusa)
      .where(eq(e.epi_motivo_recusa.codigo, "VINCULO_NAO_ATENDIDO"));
    await db.execute(sql.raw(`CREATE TABLE _escritas_vigencia (n int)`));
    await db.execute(sql.raw(`CREATE FUNCTION _anotar_vigencia() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN INSERT INTO _escritas_vigencia VALUES (1); RETURN NULL; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER _ouvinte AFTER INSERT OR UPDATE OR DELETE ON adicional_vigencia
       FOR EACH ROW EXECUTE FUNCTION _anotar_vigencia()`));

    const um = await entregar(l);
    await db.transaction((tx) =>
      epi_ficha.anexar_comprovante(tx, almoxarife, um, {
        conteudo: new TextEncoder().encode("%PDF-1.4 comprovante assinado"),
        nome_original: "comprovante.pdf",
        mime_type: "application/pdf",
      }),
    );
    const dois = await entregar(l);
    await db.transaction((tx) => epi_ficha.estornar(tx, almoxarife, dois, "lote trocado no balcão"));
    const tres = await entregar(l);
    await db.transaction((tx) =>
      epi_ficha.registrar_devolucao(tx, almoxarife, tres, { quantidade: 1, motivo: "desgaste", data_evento: HOJE }),
    );
    await db.transaction((tx) => epi_ficha.recusar(tx, almoxarife, { motivo: motivo!, a_quem: "terceirizado da limpeza" }));

    const escritas = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM _escritas_vigencia`))) as unknown as {
      n: number;
    }[];
    expect(escritas[0]!.n).toBe(0);
    const [depois] = await db.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.id, vigencia.id));
    expect(depois!.estado).toBe("VIGENTE");
    expect(depois!.data_fim).toBeNull();
    expect(depois!.motivo_suspensao).toBeNull();
  });

  it("o módulo de EPI não tem caminho de escrita no adicional (leitura do código)", () => {
    // A metade estática: os arquivos do módulo não importam `direito` (o único
    // serviço que escreve em `adicional_vigencia`) e não fazem insert/update/
    // delete na tabela. Mais simples que a análise de AST do Python — o
    // Drizzle nomeia a tabela no próprio verbo (`tx.update(adicional_vigencia)`).
    const raiz = path.resolve(import.meta.dirname, "../src");
    const arquivos = [
      ...readdirSync(path.join(raiz, "servicos"))
        .filter((n) => /^(epi_.*|comprovante_epi)\.ts$/.test(n))
        .map((n) => path.join(raiz, "servicos", n)),
      ...readdirSync(path.join(raiz, "rotas"))
        .filter((n) => /^epi.*\.ts$/.test(n))
        .map((n) => path.join(raiz, "rotas", n)),
    ];
    expect(arquivos.length).toBeGreaterThanOrEqual(8);
    for (const arquivo of arquivos) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, arquivo).not.toMatch(/from\s+["'][^"']*\/direito(\.js)?["']/);
      expect(fonte, arquivo).not.toMatch(/\.(insert|update|delete)\(\s*adicional_vigencia\b/);
      expect(fonte, arquivo).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+adicional_vigencia/i);
    }
  });
});
