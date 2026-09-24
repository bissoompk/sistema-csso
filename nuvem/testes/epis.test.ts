/**
 * Fatia 1 de Gestão de EPI: o catálogo, as categorias da NR-6 e as recusas.
 * Porte de `testes/integracao/test_epis.py`.
 *
 * Duas metades, como no Python: as telas do catálogo, e o esquema das tabelas
 * do módulo — que é onde um defeito passaria despercebido por dois meses.
 *
 * Cada teste ganha um banco limpo (`beforeEach`), como o fixture `banco` do
 * pytest: vários testes contam linhas do zero.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, desc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as modulos from "../src/modulos.js";
import { PERMISSOES } from "../src/servicos/rbac.js";
import { cadeia_integra } from "../src/servicos/auditoria.js";
import { EpiItem } from "../src/dominio/epi.js";
import { hoje, somar_dias } from "../src/servicos/datas_br.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";

const CATALOGO = "/epis/catalogo";
const CATEGORIAS = "/epis/catalogo/categorias";
const MOTIVOS = "/epis/catalogo/motivos-recusa";

// O caso do levantamento: luva nitrílica, com CA, máxima por janela e justificativa.
const LUVA: Record<string, string> = {
  nome: "Luva de proteção química nitrílica",
  descricao: "Luva para manipulação de ácidos e álcalis.",
  codigo_catmat: "150011",
  codigo_ecampus: "EC-9001",
  fabricante: "Fabricante Exemplo Ltda",
  marca: "Nitri",
  modelo: "NX-200",
  normas: "ABNT NBR 13697\nABNT NBR 13698",
  exige_ca: "1",
  numero_ca: "41234",
  validade_ca: "2028-05-31",
  unidade_medida: "PAR",
  tamanhos: "P\nM\nG",
  vida_util_meses: "6",
  quantidade_padrao: "2",
  quantidade_maxima: "6",
  periodo_maximo_meses: "12",
  exige_justificativa: "1",
  exige_treinamento: "",
};

let amb: AmbienteDeTeste = await bancoLimpo();
let db: Banco = amb.db;
let cliente: Cliente = amb.cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  await contas(db);
});

async function _id_da_categoria(codigo = "PROT_MEMBROS_SUPERIORES"): Promise<number> {
  const [c] = await db.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, codigo));
  return c!.id;
}

async function _dados(troca: Record<string, string> = {}): Promise<Record<string, string>> {
  return { ...LUVA, categoria_id: String(await _id_da_categoria()), ...troca };
}

async function _cadastrar(c: Cliente, troca: Record<string, string> = {}): Promise<Resposta> {
  return c.post(CATALOGO, await _dados(troca), { seguir: false });
}

async function _itens() {
  return db.select().from(e.epi_item).orderBy(asc(e.epi_item.id));
}

/** A recusa do cadastro vem na própria tela (200); a da edição, por `?erro=` no Location. */
function _recado(r: Resposta): string {
  if (r.status === 303) return decodeURIComponent(r.location!);
  return r.text;
}

/** Os `id` dos diálogos que voltaram com `open` escrito pelo servidor. */
function _popups_abertos(r: Resposta): string[] {
  return [...r.text.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]!);
}

// =====================================================================
// Catálogo de EPI
// =====================================================================
describe("catálogo de EPI", () => {
  it("o cadastro grava as colunas que governam a requisição", async () => {
    await entrar(cliente, "coordenador_csso");
    expect((await _cadastrar(cliente)).status).toBe(303);
    const item = (await _itens())[0]!;
    expect(item.quantidade_padrao).toBe(2);
    expect(item.quantidade_maxima).toBe(6);
    expect(item.periodo_maximo_meses).toBe(12);
    expect(item.exige_justificativa).toBe(true);
    expect(item.validade_ca).toBe("2028-05-31");
    expect(item.numero_ca).toBe("41234");
    expect(item.vida_util_meses).toBe(6);
    expect(EpiItem.lista_de_tamanhos(item)).toEqual(["P", "M", "G"]);
    expect(EpiItem.lista_de_normas(item)).toEqual(["ABNT NBR 13697", "ABNT NBR 13698"]);
  });

  it("a tela mostra a validade do CA", async () => {
    await entrar(cliente, "coordenador_csso");
    await _cadastrar(cliente, { validade_ca: somar_dias(hoje(), -1) });
    const corpo = (await cliente.get(CATALOGO)).text;
    expect(corpo).toContain("CA vencido");
    expect(corpo).toContain("41234");
  });

  it("máxima sem janela é recusada, e o digitado volta com o popup aberto", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await _cadastrar(cliente, { periodo_maximo_meses: "" });
    expect(r.status).toBe(200);
    expect(_recado(r)).toContain("andam juntos");
    expect(_popups_abertos(r)).toEqual(["novo-epi"]);
    expect(r.text).toContain('value="41234"');
    expect(r.text).toContain("ABNT NBR 13697");
    expect(await _itens()).toEqual([]);
  });

  it("máxima menor que a padrão é recusada", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await _cadastrar(cliente, { quantidade_padrao: "4", quantidade_maxima: "2" });
    expect(_recado(r)).toContain("não pode ser menor");
    expect(await _itens()).toEqual([]);
  });

  it("item que exige CA sem número de CA é recusado", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await _cadastrar(cliente, { numero_ca: "" });
    expect(_recado(r)).toContain("número do CA");
    expect(await _itens()).toEqual([]);
  });

  it("o mesmo nome com outro modelo é outro item (e NULL não escapa do homônimo)", async () => {
    await entrar(cliente, "coordenador_csso");
    expect((await _cadastrar(cliente, { modelo: "" })).status).toBe(303);
    const repetido = await _cadastrar(cliente, { modelo: "" });
    expect(_recado(repetido)).toContain("Já existe");
    expect((await _itens()).length).toBe(1);
    expect((await _cadastrar(cliente, { modelo: "NX-300" })).status).toBe(303);
    expect((await _itens()).length).toBe(2);
  });

  it("a edição registra o diff na auditoria", async () => {
    await entrar(cliente, "coordenador_csso");
    await _cadastrar(cliente);
    const item = (await _itens())[0]!;
    const r = await cliente.post(`${CATALOGO}/${item.id}`, await _dados({ nome: "Luva nitrílica (corrigido)", ativo: "1" }), {
      seguir: false,
    });
    expect(r.status).toBe(303);
    expect((await _itens())[0]!.nome).toBe("Luva nitrílica (corrigido)");
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "epi_item"));
    expect(new Set(eventos.map((ev) => ev.campo))).toContain("nome");
    expect(eventos.some((ev) => ev.tipo_evento === "EPI_ITEM_CRIADO")).toBe(true);
  });

  it("a quantidade vai para a trilha como número", async () => {
    await entrar(cliente, "coordenador_csso");
    await _cadastrar(cliente);
    const item = (await _itens())[0]!;
    await cliente.post(`${CATALOGO}/${item.id}`, await _dados({ quantidade_maxima: "8", ativo: "1" }), { seguir: false });
    const [evento] = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.campo, "quantidade_maxima"))
      .orderBy(desc(e.historico_evento.id))
      .limit(1);
    expect(evento).toBeDefined();
    expect(evento!.valor_novo).toBe(8);
    expect(await cadeia_integra(db)).toEqual([true, null]);
  });
});

// =====================================================================
// Categorias da NR-6
// =====================================================================
describe("categorias da NR-6", () => {
  it("as nove categorias da NR-6 estão semeadas", async () => {
    const categorias = await db.select().from(e.epi_categoria).orderBy(asc(e.epi_categoria.ordem));
    expect(categorias.map((c) => c.codigo)).toEqual([
      "PROT_CABECA",
      "PROT_OLHOS_FACE",
      "PROT_AUDITIVA",
      "PROT_RESPIRATORIA",
      "PROT_TRONCO",
      "PROT_MEMBROS_SUPERIORES",
      "PROT_MEMBROS_INFERIORES",
      "PROT_CORPO_INTEIRO",
      "PROT_QUEDAS_DESNIVEL",
    ]);
    expect(categorias.map((c) => c.referencia_nr6)).toEqual([..."ABCDEFGHI"]);
  });

  it("categoria não se cadastra pela tela", async () => {
    await entrar(cliente, "coordenador_csso");
    const tela = await cliente.get(CATEGORIAS);
    expect(tela.text).not.toContain(`action="${CATEGORIAS}"`);
    await cliente.post(CATEGORIAS, { nome: "Inventada", ordem: "10" });
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(e.epi_categoria);
    expect(n!.n).toBe(9);
  });

  it("categoria edita rótulo e ordem", async () => {
    await entrar(cliente, "coordenador_csso");
    const alvo = await _id_da_categoria("PROT_AUDITIVA");
    const r = await cliente.post(
      `${CATEGORIAS}/${alvo}`,
      { nome: "Proteção dos ouvidos", referencia_nr6: "C", ordem: "3", ativo: "1" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [c] = await db.select().from(e.epi_categoria).where(eq(e.epi_categoria.id, alvo));
    expect(c!.nome).toBe("Proteção dos ouvidos");
  });

  it("a tela conta os itens de cada categoria", async () => {
    await entrar(cliente, "coordenador_csso");
    await _cadastrar(cliente);
    const corpo = (await cliente.get(CATEGORIAS)).text;
    expect(corpo).toContain("Proteção dos membros superiores");
    expect(corpo).toContain("Anexo I da NR-6");
  });
});

// =====================================================================
// Motivos de recusa
// =====================================================================
describe("motivos de recusa", () => {
  it("o motivo de vínculo encaminha além de negar", async () => {
    const [motivo] = await db
      .select()
      .from(e.epi_motivo_recusa)
      .where(eq(e.epi_motivo_recusa.codigo, "VINCULO_NAO_ATENDIDO"));
    expect(motivo!.base_normativa).toBe("NR-6");
    expect(motivo!.texto).toContain("obrigação do empregador");
    expect(motivo!.texto).toContain("empresa contratante");
    expect(motivo!.texto).toContain("fiscalização do contrato");
  });

  it("os oito motivos estão semeados e só um exige complemento", async () => {
    const motivos = await db.select().from(e.epi_motivo_recusa);
    expect(new Set(motivos.map((m) => m.codigo))).toEqual(
      new Set([
        "VINCULO_NAO_ATENDIDO",
        "SEM_EXPOSICAO",
        "EPI_INADEQUADO",
        "SEM_TREINAMENTO",
        "DENTRO_DA_VIDA_UTIL",
        "ACIMA_DO_MAXIMO",
        "COMPETENCIA_DE_ENSINO",
        "OUTRO",
      ]),
    );
    expect(motivos.filter((m) => m.exige_complemento).map((m) => m.codigo)).toEqual(["OUTRO"]);
    expect(motivos.every((m) => m.texto.trim())).toBe(true);
  });

  it("motivo novo e editado sem versionar", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(
      MOTIVOS,
      {
        codigo: "sem estoque previsto",
        rotulo: "Sem previsão de estoque",
        texto: "O item não tem previsão de compra no exercício.",
        base_normativa: "",
        exige_complemento: "1",
      },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [novo] = await db
      .select()
      .from(e.epi_motivo_recusa)
      .where(eq(e.epi_motivo_recusa.codigo, "SEM_ESTOQUE_PREVISTO"));
    const antes = novo!.texto;
    await cliente.post(
      `${MOTIVOS}/${novo!.id}`,
      {
        rotulo: "Sem previsão de estoque",
        texto: "O item não tem previsão de compra neste exercício.",
        base_normativa: "Lei 14.133/2021",
        exige_complemento: "1",
        ativo: "1",
      },
      { seguir: false },
    );
    const linhas = await db
      .select()
      .from(e.epi_motivo_recusa)
      .where(eq(e.epi_motivo_recusa.codigo, "SEM_ESTOQUE_PREVISTO"));
    expect(linhas.length).toBe(1);
    expect(linhas[0]!.texto).not.toBe(antes);
    expect(linhas[0]!.dispositivo_conferido_em).toBe(hoje());
  });

  it("motivo com código repetido é recusado, com o texto de volta", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(MOTIVOS, { codigo: "OUTRO", rotulo: "Outro", texto: "x" }, { seguir: false });
    expect(_recado(r)).toContain("Já existe");
    expect(_popups_abertos(r)).toEqual(["novo-motivo"]);
    expect(r.text).toContain(">x</textarea>");
  });
});

// =====================================================================
// Permissões
// =====================================================================
describe("permissões", () => {
  it("quem só consulta vê o catálogo mas não edita", async () => {
    await entrar(cliente, "coordenador_csso");
    await _cadastrar(cliente);
    await cliente.get("/sair");
    await entrar(cliente, "consulta_progep");
    const tela = await cliente.get(CATALOGO);
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("somente leitura");
    expect(tela.text).not.toContain(`action="${CATALOGO}/`);
    expect((await _cadastrar(cliente)).status).toBe(403);
  });

  const casos: [string, number][] = [
    ["coordenador_csso", 200],
    ["engenheiro_seguranca", 200],
    ["medico_trabalho", 200],
    ["tecnico_seguranca", 200],
    ["secretaria_csso", 200],
    ["auditor_interno", 200],
    ["servidor_consulta", 200],
    ["admin_ti", 403],
  ];
  for (const caminho of [CATALOGO, CATEGORIAS, MOTIVOS]) {
    it.each(casos)(`${caminho}: %s -> %i`, async (perfil, esperado) => {
      await entrar(cliente, perfil);
      expect((await cliente.get(caminho)).status).toBe(esperado);
    });
  }

  it("quem mantém o catálogo e quem só o consulta", async () => {
    await entrar(cliente, "tecnico_seguranca");
    expect((await _cadastrar(cliente)).status).toBe(303);
    await entrar(cliente, "medico_trabalho");
    expect((await cliente.get(CATALOGO)).status).toBe(200);
    expect((await _cadastrar(cliente, { nome: "Outra luva" })).status).toBe(403);
  });

  it("as permissões novas nascem no módulo EPI", async () => {
    for (const codigo of ["epi.ver", "epi.catalogo"]) {
      const [p] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, codigo));
      expect(p!.modulo).toBe("EPI");
    }
  });

  it("as sete permissões do módulo são as do §8, e só elas", () => {
    const do_modulo = new Set(Object.keys(PERMISSOES).filter((c) => c.startsWith("epi.")));
    expect(do_modulo).toEqual(
      new Set(["epi.ver", "epi.catalogo", "epi.entregar", "epi.ficha", "epi.estoque", "epi.requisitar", "epi.analisar"]),
    );
  });
});

// =====================================================================
// O módulo no menu e no mapa
// =====================================================================
describe("o módulo no menu", () => {
  it("o módulo declara as telas que existem", () => {
    const modulo = modulos.por_codigo("epis")!;
    expect(modulo.disponivel).toBe(true);
    expect(modulo.itens.map((i) => [i.caminho, i.permissao])).toEqual([
      ["/epis", "epi.ver"],
      ["/epis/requisicoes", "epi.ver"],
      ["/epis/requisicoes/nova", "epi.requisitar"],
      ["/epis/fichas/minha", "epi.ver"],
      ["/epis/fichas", "epi.ficha"],
      ["/epis/entregas/nova", "epi.entregar"],
      ["/epis/estoque", "epi.ver"],
      [CATALOGO, "epi.ver"],
      ["/epis/relatorios", "indicador.ver"],
    ]);
    expect(modulo.itens_previstos).toEqual([]);
  });

  it.each([CATALOGO, CATEGORIAS, MOTIVOS])("%s marca o módulo", (caminho) => {
    expect(modulos.modulo_ativo(caminho)!.codigo).toBe("epis");
    expect(modulos.item_ativo(caminho)!.caminho).toBe(CATALOGO);
  });

  it("o menu e o mapa mostram o módulo", async () => {
    await entrar(cliente, "coordenador_csso");
    const mapa = (await cliente.get("/modulos")).text;
    expect(mapa).toContain("Gestão de EPI");
    expect(mapa).toContain(`href="${CATALOGO}"`);
  });
});

// =====================================================================
// O esquema
// =====================================================================
const TABELAS_DO_MODULO = [
  "epi_categoria",
  "epi_motivo_recusa",
  "epi_item",
  "epi_entrada_estoque",
  "epi_ficha_registro",
  "epi_movimento_estoque",
];

async function _colunas(tabela: string): Promise<string[]> {
  const linhas = await db.execute<{ column_name: string }>(
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tabela}`,
  );
  return [...linhas].map((l) => l.column_name);
}

/** Espera a recusa do banco com um texto na mensagem (o `pytest.raises(match=)`). */
async function recusa(p: Promise<unknown>, texto: string): Promise<void> {
  let erro: unknown = null;
  try {
    await p;
  } catch (x) {
    erro = x;
  }
  expect(erro, `esperava recusa contendo '${texto}'`).not.toBeNull();
  const e2 = erro as { message?: string; cause?: { message?: string; constraint_name?: string } };
  const mensagem = [e2.message, e2.cause?.message, e2.cause?.constraint_name].join(" ");
  expect(mensagem).toContain(texto);
}

describe("o esquema", () => {
  it("as seis tabelas nascem juntas", async () => {
    const linhas = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const existentes = new Set([...linhas].map((l) => l.table_name));
    for (const t of TABELAS_DO_MODULO) expect(existentes).toContain(t);
  });

  it.each(TABELAS_DO_MODULO)("não há coluna de CPF em %s", async (tabela) => {
    for (const coluna of await _colunas(tabela)) expect(coluna.toLowerCase().split("_")).not.toContain("cpf");
  });

  it.each(["epi_ficha_registro", "epi_movimento_estoque"])("requisicao_item_id já é FK em %s", async (tabela) => {
    expect(await _colunas(tabela)).toContain("requisicao_item_id");
    const linhas = await db.execute<{ alvo: string }>(sql`
      SELECT ccu.table_name AS alvo
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${tabela}
         AND kcu.column_name = 'requisicao_item_id'`);
    expect(new Set([...linhas].map((l) => l.alvo))).toEqual(new Set(["epi_requisicao_item"]));
  });

  it("a janela da quantidade máxima é cobrada pelo banco", async () => {
    const [categoria] = await db.select().from(e.epi_categoria).limit(1);
    await recusa(
      db.insert(e.epi_item).values({
        nome: "Bota sem janela",
        categoria_id: categoria!.id,
        exige_ca: false,
        quantidade_padrao: 1,
        quantidade_maxima: 3,
        periodo_maximo_meses: null,
      }),
      "ck_epi_janela",
    );
  });

  async function _ficha_de_teste(): Promise<number> {
    const [categoria] = await db.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_CABECA"));
    const [item] = await db
      .insert(e.epi_item)
      .values({ nome: "Capacete de segurança", categoria_id: categoria!.id, exige_ca: true, numero_ca: "31000", quantidade_padrao: 1 })
      .returning();
    const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
    const [cargo] = await db.select().from(e.cargo).limit(1);
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "1234567", nome: "Servidor de Teste do EPI", cargo_id: cargo!.id, unidade_uorg_id: unidade!.id })
      .returning();
    const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const [registro] = await db
      .insert(e.epi_ficha_registro)
      .values({
        servidor_id: servidor!.id,
        epi_item_id: item!.id,
        tipo: "ENTREGA",
        quantidade: 1,
        data_evento: hoje(),
        nome_epi_snapshot: item!.nome,
        categoria_snapshot: categoria!.nome,
        numero_ca_snapshot: item!.numero_ca,
        nome_servidor_snapshot: servidor!.nome,
        siape_snapshot: servidor!.siape,
        entregue_por: coord!.id,
      })
      .returning();
    return registro!.id;
  }

  it("a ficha de EPI é append-only", async () => {
    const id = await _ficha_de_teste();
    await recusa(db.execute(sql`UPDATE epi_ficha_registro SET quantidade = 9 WHERE id = ${id}`), "append-only");
    await recusa(db.execute(sql`DELETE FROM epi_ficha_registro WHERE id = ${id}`), "append-only");
  });

  it("o razão do estoque é append-only", async () => {
    const registro_id = await _ficha_de_teste();
    const [item] = await db.select().from(e.epi_item).limit(1);
    const [entrada] = await db
      .insert(e.epi_entrada_estoque)
      .values({ epi_item_id: item!.id, data_entrada: hoje(), quantidade_recebida: 10, empenho: "2026NE000123" })
      .returning();
    const [movimento] = await db
      .insert(e.epi_movimento_estoque)
      .values({ entrada_id: entrada!.id, tipo: "SAIDA", quantidade: -1, ficha_registro_id: registro_id })
      .returning();
    await recusa(db.execute(sql`UPDATE epi_movimento_estoque SET quantidade = -5 WHERE id = ${movimento!.id}`), "append-only");
  });

  it("o sinal do movimento segue o tipo", async () => {
    const [categoria] = await db.select().from(e.epi_categoria).limit(1);
    const [item] = await db
      .insert(e.epi_item)
      .values({ nome: "Protetor auricular", categoria_id: categoria!.id, exige_ca: false, quantidade_padrao: 1 })
      .returning();
    const [entrada] = await db
      .insert(e.epi_entrada_estoque)
      .values({ epi_item_id: item!.id, data_entrada: hoje(), quantidade_recebida: 5 })
      .returning();
    await recusa(
      db.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "SAIDA", quantidade: 3 }),
      "ck_mov_sinal",
    );
  });
});

