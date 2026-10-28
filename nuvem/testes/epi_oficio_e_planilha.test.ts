/**
 * Duas lacunas do sistema PROACE antigo, fechadas (28/10/2026): o nº do ofício
 * da compra no lote do estoque e a planilha nominal de pedidos de EPI.
 * Dados fictícios.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { exportar_requisicoes } from "../src/rotas/epi_requisicoes.js";
import { bancoLimpo, contas, entrar } from "./ajuda";
import { ANALISTA, cenario, desfeito, pedido_pronto, usuario } from "./ajuda_epi_requisicao";

const { novoCliente } = await bancoLimpo();
const SEMENTE = "semente-de-teste";

describe("nº do ofício no lote do estoque", () => {
  it("entra com o lote, aparece na tela de movimentos e se corrige no documento do lote", async () => {
    await desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { login: "estoquista", permissoes: [...ANALISTA, "epi.estoque"] });
      const entrada = await epi_estoque.registrar_entrada(tx, u, {
        item: cen.item,
        quantidade_recebida: 4,
        tamanho: "M",
        empenho: "2026NE000999",
        oficio: "123/2026-PROACE",
        lote: "L-OF-1",
        numero_ca: "41234",
        validade_ca: cen.item.validade_ca,
      });
      expect(entrada.oficio).toBe("123/2026-PROACE");
      await epi_estoque.atualizar_lote(tx, u, {
        entrada,
        nota_fiscal: "NF-77",
        oficio: "124/2026-PROACE",
        fornecedor_contato: "",
        observacao: "",
        ativo: true,
        motivo_inativacao: "",
      });
      const [lido] = await tx.select().from(e.epi_entrada_estoque).where(eq(e.epi_entrada_estoque.id, entrada.id));
      expect(lido!.oficio).toBe("124/2026-PROACE");
    });
  });
});

describe("planilha nominal de pedidos de EPI", () => {
  it("uma linha por item, com o nome só para quem lê nominal, e o filtro de situação", async () => {
    await desfeito(async (tx) => {
      const cen = await cenario(tx, { nome: "Maria Fictícia Souza", siape: "1234567" });
      const u = await usuario(tx, { login: "exportador", permissoes: [...ANALISTA, "exportar"] });
      const req = await pedido_pronto(tx, cen, u, { quantidade: 2 });
      await servico.enviar(tx, u, req, { termo_aceito: true });

      const { nome, corpo } = await exportar_requisicoes(tx, u, SEMENTE);
      const texto = new TextDecoder().decode(corpo);
      expect(nome).toMatch(/^epi-pedidos-\d{4}-\d{2}-\d{2}\.csv$/);
      expect([...corpo.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM do Excel
      expect(texto.startsWith("Protocolo;")).toBe(true);
      const linhas = texto.trim().split("\r\n");
      expect(linhas).toHaveLength(2);
      expect(linhas[1]).toContain("Luva");
      expect(linhas[1]).toContain(";2;");

      // estado que não casa: só o cabeçalho
      const vazio = await exportar_requisicoes(tx, u, SEMENTE, { estado: "ATENDIDA" });
      expect(new TextDecoder().decode(vazio.corpo).trim().split("\r\n")).toHaveLength(1);

      // quem não tem `exportar` recebe a recusa
      const sem = await usuario(tx, { login: "sem_exportar", permissoes: ANALISTA });
      await expect(exportar_requisicoes(tx, sem, SEMENTE)).rejects.toBeInstanceOf(PermissaoNegada);
    });
  });

  it("pela tela: a coordenação baixa o CSV e o servidor comum recebe 403", async () => {
    const { db } = await bancoLimpo();
    await contas(db);
    const coord = await entrar(novoCliente(), "coordenador_csso");
    const r = await coord.get("/epis/requisicoes/exportar", { seguir: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    const srv = await entrar(novoCliente(), "servidor_consulta");
    expect((await srv.get("/epis/requisicoes/exportar", { seguir: false })).status).toBe(403);
  });
});
