/**
 * Carga de servidores por planilha em `/servidores`: prévia que não grava,
 * confirmação que grava, idempotência pelo SIAPE, recusas por linha e um
 * evento de trilha por importação.
 */
import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { ler_csv } from "../src/servicos/importacao_servidores.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

function csv(texto: string, nome = "servidores.csv"): File {
  return new File([texto], nome, { type: "text/csv" });
}

/** O JSON que a prévia devolveu no campo escondido, para confirmar. */
function linhas_da_previa(r: Resposta): string {
  const m = /name="linhas" value="([^"]*)"/.exec(r.text);
  if (!m) throw new Error("a prévia não trouxe o formulário de confirmação");
  return m[1]!.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

async function servidor(siape: string) {
  const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, siape));
  return sv ?? null;
}

async function importar(cliente: Cliente, arquivo: File): Promise<Resposta> {
  const previa = await cliente.post("/servidores/importar", { arquivo });
  expect(previa.status).toBe(200);
  return cliente.post("/servidores/importar/confirmar", { linhas: linhas_da_previa(previa) });
}

const ARQUIVO =
  "SIAPE;Nome;Cargo;UORG;E-mail;Campus\r\n" +
  "1234567;Ana Paula Souza;TECNICO DE LABORATORIO AREA;250 - FACULDADE DE MEDICINA DE DIAMANTINA;ana@ufvjm.edu.br;\r\n" +
  "2345678;Bruno Lima;CARGO QUE NAO EXISTE;;;\r\n" +
  "12AB;Sem Siape;;;;\r\n" +
  "1234567;Ana Repetida;;;;\r\n" +
  "3456789;;;;;\r\n";

describe("importação de servidores", () => {
  it("a prévia mostra cada linha e não grava nada", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post("/servidores/importar", { arquivo: csv(ARQUIVO) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("simulação — nada foi gravado");
    expect(r.text).toContain("Confirmar importação");
    expect(r.text).toContain("SIAPE inválido");
    expect(r.text).toContain("SIAPE repetido no arquivo (linha 2)");
    expect(r.text).toContain("sem nome");
    expect(await servidor("1234567")).toBeNull();
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "CARGO QUE NAO EXISTE"));
    expect(cargo).toBeUndefined();
  });

  it("confirmar cria, cria o cargo que falta, abre a lotação e registra um evento só", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await importar(cliente, csv(ARQUIVO));
    expect(r.status).toBe(200);
    expect(r.text).toContain("aplicada");

    const ana = (await servidor("1234567"))!;
    expect(ana.nome).toBe("Ana Paula Souza");
    expect(ana.email).toBe("ana@ufvjm.edu.br");
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    expect(ana.unidade_uorg_id).toBe(famed!.id);
    const lotacoes = await amb.db.select().from(e.servidor_lotacao).where(eq(e.servidor_lotacao.servidor_id, ana.id));
    expect(lotacoes).toHaveLength(1);

    const bruno = (await servidor("2345678"))!;
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "CARGO QUE NAO EXISTE"));
    expect(bruno.cargo_id).toBe(cargo!.id);
    expect(await servidor("3456789")).toBeNull();

    const eventos = await amb.db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "SERVIDORES_IMPORTADOS"));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain("2 criado(s)");
    expect(eventos[0]!.descricao).toContain("3 recusada(s)");
  });

  it("reimportar é idempotente pelo SIAPE e atualiza nome e lotação pelo histórico", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    await importar(cliente, csv("SIAPE;Nome\r\n1234567;Ana Paula Souza\r\n"));
    const de_novo = await cliente.post("/servidores/importar", { arquivo: csv("SIAPE;Nome\r\n1234567;Ana Paula Souza\r\n") });
    expect(de_novo.text).toContain("sem mudança");

    await importar(
      cliente,
      csv("SIAPE;Nome;UORG\r\n1234567;Ana Paula Souza Reis;250 - FACULDADE DE MEDICINA DE DIAMANTINA\r\n"),
    );
    const todos = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "1234567"));
    expect(todos).toHaveLength(1);
    expect(todos[0]!.nome).toBe("Ana Paula Souza Reis");
    const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    expect(todos[0]!.unidade_uorg_id).toBe(famed!.id);
    const alteracoes = await amb.db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "servidor"), eq(e.historico_evento.tipo_evento, "LOTACAO_ALTERADA")));
    expect(alteracoes).toHaveLength(1);
  });

  it("UORG desconhecida sem campus resolvido entra em branco, com aviso", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await importar(cliente, csv("SIAPE;Nome;UORG\r\n1234567;Ana;999999 - UNIDADE INVENTADA\r\n"));
    expect(r.text).toContain("não cadastrada");
    expect((await servidor("1234567"))!.unidade_uorg_id).toBeNull();
  });

  it("UORG desconhecida no formato do SIAPE e com campus é criada", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const [campus] = await amb.db.select().from(e.campus).limit(1);
    await importar(cliente, csv(`SIAPE;Nome;UORG;Campus\r\n1234567;Ana;999999 - UNIDADE NOVA;${campus!.sigla}\r\n`));
    const [nova] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "999999"));
    expect(nova!.nome_oficial).toBe("UNIDADE NOVA");
    expect((await servidor("1234567"))!.unidade_uorg_id).toBe(nova!.id);
  });

  it("lê .xlsx e devolve o zero da frente que o Excel tirou do SIAPE", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Servidores");
    ws.addRow(["SIAPE", "Nome"]);
    ws.addRow([123456, "Carla Mendes"]);
    const bytes = await wb.xlsx.writeBuffer();
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    await importar(cliente, new File([bytes], "servidores.xlsx"));
    expect((await servidor("0123456"))!.nome).toBe("Carla Mendes");
  });

  it("arquivo sem as colunas obrigatórias volta para a lista com o motivo", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post("/servidores/importar", { arquivo: csv("Matrícula errada;Outra\r\nx;y\r\n") });
    expect(r.status).toBe(200);
    expect(r.text).toContain("precisa ter as colunas SIAPE e Nome");
  });

  it("o modelo para baixar e a permissão de cadastrar", async () => {
    const coord = await entrar(amb.novoCliente(), "coordenador_csso");
    const modelo = await coord.get("/servidores/modelo.csv");
    expect(modelo.status).toBe(200);
    expect(modelo.text).toContain("SIAPE;Nome;Cargo;UORG;E-mail;Campus");

    const servidor_comum = await entrar(amb.novoCliente(), "servidor_consulta");
    const r = await servidor_comum.post("/servidores/importar", { arquivo: csv(ARQUIVO) });
    expect(r.status).toBe(403);
    expect(await servidor("1234567")).toBeNull();
  });

  it("o CSV aceita aspas, vírgula e quebra de linha dentro do campo", () => {
    expect(ler_csv('SIAPE,Nome\n1234567,"Silva, Ana ""Aninha""\nSegunda"\n')).toEqual([
      ["SIAPE", "Nome"],
      ["1234567", 'Silva, Ana "Aninha"\nSegunda'],
    ]);
  });
});
