/**
 * Lote 5 (25/11/2026), a parte de EPI: B1 (o 403 vem antes da validação dos campos, em todas as
 * rotas do rascunho do pedido), EPI 3 (aviso de saúde, sem bloqueio, no catálogo e no lote) e
 * EPI 9 (o comprovante de entrega em PDF pelo conversor, com o conversor simulado).
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";
import { cenario, entregar, HOJE, recado, registros, type Cenario } from "./ajuda_epi_ficha";

const FILA = "/epis/requisicoes";

await bancoLimpo();

async function novo(): Promise<AmbienteDeTeste> {
  const amb = await bancoLimpo();
  await contas(amb.db);
  return amb;
}
const como = (amb: AmbienteDeTeste, login: string): Promise<Cliente> => entrar(amb.novoCliente(), login);
const ligar = (amb: AmbienteDeTeste, login: string, servidor_id: number | null) =>
  amb.db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, login));

/** A tela depois do redirecionamento (o recado viaja no cookie, não no endereço). */
async function seguir(cliente: Cliente, r: Resposta): Promise<string> {
  expect(r.status, recado(r)).toBe(303);
  return (await cliente.get(r.location!)).text;
}

/** O rascunho da Joana, aberto por ela (a conta do coordenador ligada a ela), com um item. */
async function rascunho_da_joana(amb: AmbienteDeTeste, cen: Cenario): Promise<{ id: number; linha: number }> {
  await ligar(amb, "coordenador_csso", cen.servidor);
  const r = await (await como(amb, "coordenador_csso")).post(
    FILA,
    {
      servidor_id: String(cen.servidor),
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes",
      riscos_declarados: "Respingo de ácido",
      urgencia: "NORMAL",
      item_id: String(cen.item),
      quantidade: "1",
      tamanho: "M",
      motivo: "DESGASTE",
    },
    { seguir: false },
  );
  expect(r.status, recado(r)).toBe(303);
  const [pedido] = await amb.db.select().from(e.epi_requisicao).orderBy(asc(e.epi_requisicao.id));
  const [linha] = await amb.db.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.requisicao_id, pedido!.id));
  expect(pedido!.estado).toBe("RASCUNHO");
  return { id: pedido!.id, linha: linha!.id };
}

// =====================================================================
describe("B1 — pedido de EPI: quem pode editar, antes de validar os campos", () => {
  it("quem não é o titular recebe 403, e não 'Quantidade inválida', em todas as rotas do rascunho", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const { id, linha } = await rascunho_da_joana(amb, cen);
    // a mesma conta, agora ligada a outro servidor: não é mais a titular
    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1112223", nome: "Bruno Outro" }).returning();
    await ligar(amb, "coordenador_csso", outro!.id);
    const cli = await como(amb, "coordenador_csso");
    const tentativas: [string, Record<string, string>][] = [
      [`${FILA}/${id}/itens`, { item_id: String(cen.item), quantidade: "" }],
      [`${FILA}/${id}/itens/${linha}`, { quantidade: "" }],
      [`${FILA}/${id}/itens/${linha}/remover`, {}],
      [`${FILA}/${id}`, { finalidade: "XYZ", urgencia: "" }],
      [`${FILA}/${id}/enviar`, {}],
      [`${FILA}/${id}/excluir`, {}],
    ];
    for (const [caminho, campos] of tentativas) {
      const r = await cli.post(caminho, campos, { seguir: false });
      expect(r.status, caminho).toBe(403);
      expect(r.text, caminho).not.toContain("Quantidade inválida");
    }
    const [ainda] = await amb.db.select().from(e.epi_requisicao).where(eq(e.epi_requisicao.id, id));
    expect(ainda!.estado).toBe("RASCUNHO");
  });

  it("pedido novo para outra pessoa, com a quantidade em branco: 403 antes da validação", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1112224", nome: "Bruno Outro" }).returning();
    await ligar(amb, "coordenador_csso", outro!.id);
    const r = await (await como(amb, "coordenador_csso")).post(
      FILA,
      { servidor_id: String(cen.servidor), item_id: String(cen.item), quantidade: "" },
      { seguir: false },
    );
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("Quantidade inválida");
  });

  it("o titular com a quantidade em branco continua recebendo a mensagem do campo", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const { id } = await rascunho_da_joana(amb, cen);
    const r = await (await como(amb, "coordenador_csso")).post(
      `${FILA}/${id}/itens`,
      { item_id: String(cen.item), quantidade: "" },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("Quantidade inválida");
  });
});

// =====================================================================
describe("EPI 3 — termo de saúde no catálogo e no lote: aviso, sem bloqueio", () => {
  it("catálogo: a descrição com 'dermatite' grava, e a tela avisa em amarelo", async () => {
    const amb = await novo();
    const [categoria] = await amb.db.select().from(e.epi_categoria).limit(1);
    const cli = await como(amb, "tecnico_seguranca");
    const r = await cli.post(
      "/epis/catalogo",
      {
        nome: "Creme de proteção X",
        categoria_id: String(categoria!.id),
        quantidade_padrao: "1",
        descricao: "Creme de barreira contra dermatite de contato",
      },
      { seguir: false },
    );
    const tela = await seguir(cli, r);
    expect(tela).toContain("&#39;Creme de proteção X&#39; cadastrado.");
    expect(tela).toMatch(/<div class="aviso aviso-alerta" role="status">Aviso: a descrição cita “dermatite”/);
    const [item] = await amb.db.select().from(e.epi_item).where(eq(e.epi_item.nome, "Creme de proteção X"));
    expect(item!.descricao).toContain("dermatite");
  });

  it("catálogo: editar com 'alergia' nas normas grava a alteração e avisa", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const [item] = await amb.db.select().from(e.epi_item).where(eq(e.epi_item.id, cen.item));
    const cli = await como(amb, "tecnico_seguranca");
    const r = await cli.post(
      `/epis/catalogo/${cen.item}`,
      {
        nome: item!.nome,
        categoria_id: String(item!.categoria_id),
        quantidade_padrao: String(item!.quantidade_padrao),
        unidade_medida: item!.unidade_medida ?? "",
        tamanhos: item!.tamanhos ?? "",
        exige_ca: item!.exige_ca ? "1" : "",
        numero_ca: item!.numero_ca ?? "",
        normas: "EN 374 — sem látex, para quem tem alergia ao látex",
      },
      { seguir: false },
    );
    const tela = await seguir(cli, r);
    expect(tela).toMatch(/aviso-alerta" role="status">Aviso: as normas cita “alergia”/);
  });

  it("catálogo: texto sem termo de saúde não traz aviso", async () => {
    const amb = await novo();
    const [categoria] = await amb.db.select().from(e.epi_categoria).limit(1);
    const cli = await como(amb, "tecnico_seguranca");
    const r = await cli.post(
      "/epis/catalogo",
      { nome: "Óculos Y", categoria_id: String(categoria!.id), quantidade_padrao: "1", descricao: "Lente incolor antiembaçante" },
      { seguir: false },
    );
    expect(await seguir(cli, r)).not.toContain("aviso-alerta\" role=\"status\">Aviso:");
  });

  it("lote: a observação com 'lesão' grava a entrada e avisa", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const cli = await como(amb, "coordenador_csso");
    const r = await cli.post(
      "/epis/estoque",
      {
        item_id: String(cen.item),
        quantidade_recebida: "5",
        data_entrada: HOJE,
        tamanho: "M",
        lote: "L-SAUDE-01",
        numero_ca: "41234",
        observacao: "Reforço no punho contra lesão por corte",
      },
      { seguir: false },
    );
    const tela = await seguir(cli, r);
    expect(tela).toMatch(/aviso-alerta" role="status">Aviso: a observação do lote cita “lesão”/);
    const [entrada] = await amb.db.select().from(e.epi_entrada_estoque).where(eq(e.epi_entrada_estoque.lote, "L-SAUDE-01"));
    expect(entrada!.observacao).toContain("lesão");
  });

  it("a lista proibida de sempre continua bloqueando no lote (CID)", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const cli = await como(amb, "coordenador_csso");
    const r = await cli.post(
      "/epis/estoque",
      {
        item_id: String(cen.item),
        quantidade_recebida: "5",
        data_entrada: HOJE,
        tamanho: "M",
        lote: "L-CID-01",
        numero_ca: "41234",
        observacao: "CID-10 L23",
      },
      { seguir: false },
    );
    const tela = r.status === 303 ? (await cli.get(r.location!)).text : r.text;
    expect(tela).toContain("aviso-erro");
    expect(await amb.db.select().from(e.epi_entrada_estoque).where(eq(e.epi_entrada_estoque.lote, "L-CID-01"))).toHaveLength(0);
  });
});

// =====================================================================
describe("EPI 9 — o comprovante de entrega em PDF, pelo conversor", () => {
  it("sem conversor, a ficha não oferece o PDF e o endereço volta dizendo para usar o .docx", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    expect((await entregar(coord, cen)).status).toBe(303);
    const [registro] = await registros(amb.db);
    expect((await coord.get(`/epis/fichas/${cen.servidor}`)).text).not.toContain("/comprovante.pdf");
    const r = await coord.get(`/epis/fichas/registros/${registro!.id}/comprovante.pdf`, { seguir: false });
    expect(r.status).toBe(303);
    expect((await coord.get(r.location!)).text).toContain("O comprovante em PDF não saiu agora");
  });

  it("com o conversor (simulado), o PDF sai do mesmo .docx do comprovante, com usuário e senha", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    expect((await entregar(coord, cen)).status).toBe(303);
    const [registro] = await registros(amb.db);
    const original = globalThis.fetch;
    const pedidos: { url: string; autorizacao: string | null; nome: string }[] = [];
    vi.stubEnv("CSSO_CONVERSOR_PDF_URL", "http://conversor.exemplo.invalid");
    vi.stubEnv("CSSO_CONVERSOR_PDF_USUARIO", "csso");
    vi.stubEnv("CSSO_CONVERSOR_PDF_SENHA", "senha-do-teste");
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).startsWith("http://conversor.exemplo.invalid")) return original(url as string, init);
      const arquivo = (init!.body as FormData).get("files") as File;
      const cab = new Headers(init!.headers);
      pedidos.push({ url: String(url), autorizacao: cab.get("authorization"), nome: arquivo.name });
      // o que vai ao conversor é um .docx (zip)
      const inicio = new Uint8Array(await arquivo.arrayBuffer()).slice(0, 2);
      expect(String.fromCharCode(...inicio)).toBe("PK");
      return new Response("%PDF-1.7 comprovante", { status: 200 });
    });
    try {
      expect((await coord.get(`/epis/fichas/${cen.servidor}`)).text).toContain(`/epis/fichas/registros/${registro!.id}/comprovante.pdf`);
      const r = await coord.get(`/epis/fichas/registros/${registro!.id}/comprovante.pdf`, { seguir: false });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/pdf");
      expect(r.headers.get("content-disposition")).toMatch(/\.pdf/);
      expect(r.text.startsWith("%PDF-1.7 comprovante")).toBe(true);
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]!.url).toBe("http://conversor.exemplo.invalid/forms/libreoffice/convert");
      expect(pedidos[0]!.autorizacao).toBe(`Basic ${Buffer.from("csso:senha-do-teste").toString("base64")}`);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
