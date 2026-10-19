/**
 * NUVEM: quantas consultas cada tela faz. A função roda nos EUA e o banco em
 * São Paulo — cada ida pesa (~150 ms). O teto aqui é o que a revisão de
 * desempenho de 19/10/2026 deixou; consulta por linha da lista (N+1) estoura.
 */
import { describe, expect, it } from "vitest";
import { povoar, SENHA } from "../ferramentas/ambiente-teste.js";
import { observarConsultas, preparaConsultas } from "../src/db/cliente.js";
import { bancoLimpo, naTransacao } from "./ajuda";

const { novoCliente } = await bancoLimpo();
await naTransacao((tx) => povoar(tx));
const cliente = novoCliente();
await cliente.post("/login", { login: "coordenador", senha: SENHA }, { seguir: false });

async function consultas(caminho: string): Promise<string[]> {
  const vistas: string[] = [];
  observarConsultas((q) => vistas.push(q));
  try {
    const r = await cliente.get(caminho, { seguir: false });
    expect(r.status, caminho).toBe(200);
  } finally {
    observarConsultas(null);
  }
  return vistas;
}

describe("idas ao banco", () => {
  it("prepara consulta, salvo no pooler em modo transação", () => {
    expect(preparaConsultas("postgres://u:p@aws-1-sa-east-1.pooler.supabase.com:6543/postgres")).toBe(false);
    expect(preparaConsultas("postgres://u:p@aws-1-sa-east-1.pooler.supabase.com:5432/postgres")).toBe(true);
    expect(preparaConsultas("postgres://postgres:csso@localhost:55432/csso")).toBe(true);
  });

  it.each([
    ["/catalogos", 8],
    ["/", 30],
    ["/processos", 20],
    ["/kanban", 16],
    ["/turmas", 20],
    ["/processos/1", 20],
  ])("%s fica em até %i consultas", async (caminho, teto) => {
    expect((await consultas(caminho)).length).toBeLessThanOrEqual(teto);
  });

  it("o painel não consulta por processo", async () => {
    const vistas = await consultas("/");
    const repetidas = vistas.filter((q) => q.includes('from "anexo"'));
    expect(repetidas.length).toBeLessThanOrEqual(3);
  });
});
