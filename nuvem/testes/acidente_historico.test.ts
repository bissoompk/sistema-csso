/**
 * A aba Histórico da ficha do acidente (segundo passe, 28/10/2026): mostra a
 * trilha do caso — o que aconteceu, quando e quem —, do mais novo ao mais
 * antigo, só para quem conduz; a secretaria vê o aviso de acesso restrito.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

describe("aba Histórico", () => {
  it("quem investiga lê os eventos do caso, do mais novo ao mais antigo, e não cai no aviso de etapa futura", async () => {
    const c = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const tela = (await cli.get(`/acidentes/${c.oc.id}?aba=historico`)).text;
    expect(tela).toContain("Histórico do caso");
    expect(tela).not.toContain("chega numa etapa seguinte");
    expect(tela).toContain("Situação da ocorrência de acidente alterada");
    expect(tela.indexOf("Situação da ocorrência de acidente alterada")).toBeLessThan(tela.indexOf("Acidente comunicado"));
  });

  it("a secretaria recebe o aviso de acesso restrito, sem eventos", async () => {
    const c = await em_investigacao(db);
    const sec = await entrar(novoCliente(), "secretaria_csso");
    const r = await sec.get(`/acidentes/${c.oc.id}?aba=historico`);
    if (r.status === 200) {
      expect(r.text).toContain("Restrito à equipe que investiga");
      expect(r.text).not.toContain("Situação da ocorrência de acidente alterada");
    } else {
      expect(r.status).toBe(403);
    }
  });
});
