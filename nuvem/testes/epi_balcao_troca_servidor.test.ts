/**
 * Balcão de entrega (22/10/2026, ajuste pedido pelo usuário): trocar QUEM
 * RECEBE atualiza na hora a etiqueta "sem treinamento em vigor" do item já
 * escolhido. O fio é de navegador (`data-ao-trocar-dispara`, csso.js, sem
 * script inline): o contêiner do seletor de servidor dispara `change` no
 * seletor de item, que refaz o `hx-get` com o servidor novo. A conferência ao
 * gravar continua (testes/epi_treinamento.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";
import { bancoPorTeste, NOVA } from "./ajuda_epi_ficha";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const CSSO_JS = readFileSync(path.join(aqui, "../public/estaticos/js/csso.js"), "utf8");

let db: Banco;
let novoCliente: () => Cliente;

await bancoLimpo();

beforeEach(async () => {
  const amb = await bancoPorTeste();
  db = amb.db;
  novoCliente = () => amb.novoCliente();
  await contas(db);
});

describe("balcão: trocar o servidor recarrega o bloco do item", () => {
  it("o contêiner do seletor de servidor aponta para o seletor de item", async () => {
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.get(NOVA);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/id="lista-de-servidores"[^>]*data-ao-trocar-dispara="#item_id"/);
    // o seletor de item leva o servidor junto no hx-get
    expect(r.text).toMatch(/id="item_id"[\s\S]*?hx-include="this, #servidor_id"/);
    // o fio não usa atributo de evento nem estilo inline (CSP)
    expect(r.text).not.toMatch(/\son(change|input)=/i);
    expect(r.text).not.toMatch(/\sstyle="/i);
  });

  it("csso.js trata o contrato e só dispara quando o item já tem valor", () => {
    expect(CSSO_JS).toContain("[data-ao-trocar-dispara]");
    expect(CSSO_JS).toMatch(/if \(!alvo \|\| !alvo\.value \|\| alvo === e\.target\) return;/);
    expect(CSSO_JS).toContain("htmx.trigger(alvo, 'change')");
  });
});
