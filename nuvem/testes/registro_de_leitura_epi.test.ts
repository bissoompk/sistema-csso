/**
 * A metade restante do G-3: as rotas de EPI deixam rastro em
 * `acesso_dado_sensivel` — e deixam só o que devem.
 * Porte de `testes/integracao/test_registro_de_leitura_epi.py`.
 *
 * 1. a ficha da requisição e a guia gravam, com `campo` e `finalidade`;
 * 2. a fila não grava, e as duas buscas por HTMX também não;
 * 3. o titular lendo o próprio pedido não grava (LGPD art. 18, II).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { bancoPorTeste } from "./ajuda_epi_ficha";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

const FILA = "/epis/requisicoes";
// as nove do ambiente de teste: a linha de base do relatório
const QUANTAS = 9;

let db: Banco;
let novoCliente: () => Cliente;
let nove: { servidores: number[]; requisicoes: number[] };

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
  const [cargo] = await db.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  nove = { servidores: [], requisicoes: [] };
  for (let ordem = 0; ordem < QUANTAS; ordem++) {
    const [sv] = await db
      .insert(e.servidor)
      .values({
        siape: `30100${String(ordem).padStart(2, "0")}`,
        nome: `Servidora Nominal ${ordem}`,
        cargo_id: cargo!.id,
        unidade_uorg_id: unidade!.id,
      })
      .returning();
    const [req] = await db
      .insert(e.epi_requisicao)
      .values({
        servidor_id: sv!.id,
        solicitado_por_id: coord!.id,
        finalidade: "ROTINA",
        descricao_atividade: `Rotina de trabalho declarada pela ${ordem}.`,
        riscos_declarados: "Agente químico e agente biológico no posto.",
        urgencia: "NORMAL",
        estado: "RASCUNHO",
      })
      .returning();
    nove.servidores.push(sv!.id);
    nove.requisicoes.push(req!.id);
  }
  // o primeiro dos nove é a pessoa por trás da conta de escopo próprio
  await db.update(e.usuario).set({ servidor_id: nove.servidores[0]! }).where(eq(e.usuario.login, "servidor_consulta"));
});

async function acessos(campo?: string) {
  const linhas = await db.select().from(e.acesso_dado_sensivel);
  return campo === undefined ? linhas : linhas.filter((a) => a.campo === campo);
}

const como = (perfil: string) => entrar(novoCliente(), perfil);

describe("a medição", () => {
  it("nove leituras nominais deixam nove linhas", async () => {
    const cli = await como("almoxarife_sesmt");
    expect(await acessos()).toEqual([]);
    for (const id of nove.requisicoes) expect((await cli.get(`${FILA}/${id}`)).status).toBe(200);
    const linhas = await acessos("epi_requisicao.nominal");
    expect(linhas).toHaveLength(QUANTAS);
    expect(new Set(linhas.map((a) => a.servidor_id))).toEqual(new Set(nove.servidores));
  });

  it("a linha diz o que foi lido e por quê", async () => {
    const cli = await como("almoxarife_sesmt");
    await cli.get(`${FILA}/${nove.requisicoes[1]}`);
    const [linha] = await acessos("epi_requisicao.nominal");
    expect(linha!.servidor_id).toBe(nove.servidores[1]);
    expect(linha!.finalidade ?? "").toContain("riscos declarados");
    expect(linha!.usuario_id).not.toBeNull();
  });

  it("a guia grava por conta própria", async () => {
    const cli = await como("almoxarife_sesmt");
    expect((await cli.get(`${FILA}/${nove.requisicoes[2]}/guia`)).status).toBe(200);
    const linhas = await acessos("epi_requisicao.guia");
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.servidor_id).toBe(nove.servidores[2]);
    expect(linhas[0]!.finalidade ?? "").toContain("balcão");
  });
});

describe("o que deliberadamente não grava", () => {
  it("a fila inteira não grava uma linha", async () => {
    const cli = await como("almoxarife_sesmt");
    const r = await cli.get(FILA);
    expect(r.status).toBe(200);
    for (const id of nove.requisicoes) expect(r.text).toContain(`${FILA}/${id}`);
    expect(await acessos()).toEqual([]);
  });

  it.each([["/epis/requisicoes/servidores"], ["/epis/entregas/servidores"]])(
    "a busca de servidor por HTMX não grava (%s)",
    async (rota) => {
      const cli = await como("coordenador_csso");
      expect((await cli.get(`${rota}?q=`)).status).toBe(200);
      expect((await cli.get(`${rota}?q=Nominal`)).status).toBe(200);
      expect(await acessos()).toEqual([]);
    },
  );

  it("o titular lendo o próprio pedido não grava", async () => {
    const cli = await como("servidor_consulta");
    const propria = nove.requisicoes[0];
    expect((await cli.get(`${FILA}/${propria}`)).status).toBe(200);
    expect((await cli.get(`${FILA}/${propria}/guia`)).status).toBe(200);
    expect(await acessos()).toEqual([]);
  });

  it("o pedido de terceiro continua fechado para o titular", async () => {
    const cli = await como("servidor_consulta");
    const alheia = nove.requisicoes[3];
    expect((await cli.get(`${FILA}/${alheia}`, { seguir: false })).status).toBe(303);
    expect((await cli.get(`${FILA}/${alheia}/guia`, { seguir: false })).status).toBe(303);
    expect(await acessos()).toEqual([]);
  });

  it("o extrato do lote não grava", async () => {
    const [categoria] = await db.select().from(e.epi_categoria).orderBy(asc(e.epi_categoria.id)).limit(1);
    const [item] = await db
      .insert(e.epi_item)
      .values({ nome: "Bota de segurança", categoria_id: categoria!.id, exige_ca: false, unidade_medida: "PAR" })
      .returning();
    const [entrada] = await db
      .insert(e.epi_entrada_estoque)
      .values({
        epi_item_id: item!.id,
        data_entrada: datas_br.somar_dias(datas_br.hoje(), -10),
        quantidade_recebida: 5,
        lote: "L-EXTRATO",
      })
      .returning();
    await db.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: 5 });
    const cli = await como("almoxarife_sesmt");
    expect((await cli.get(`/epis/estoque/${entrada!.id}/movimentos`)).status).toBe(200);
    expect(await acessos()).toEqual([]);
  });
});
