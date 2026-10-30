/**
 * O "← Voltar" de toda tela com casca (`destino_do_voltar` e o bloco do
 * `base.html`): da ficha para a lista do item da lateral, da lista para o
 * início do módulo, e nenhum no início do módulo.
 */
import { describe, expect, it } from "vitest";
import * as modulos from "../src/modulos.js";
import { bancoLimpo, contas, entrar, naTransacao } from "./ajuda";

const { novoCliente, db } = await bancoLimpo();
await naTransacao((tx) => contas(tx));

function _voltar(html: string): { href: string; texto: string } | null {
  const m = /<a class="voltar" href="([^"]+)"[^>]*>(?:.*?)<span>([^<]+)<\/span><\/a>/s.exec(html);
  return m ? { href: m[1]!, texto: m[2]! } : null;
}

describe("destino_do_voltar", () => {

  it("tela mais funda que o item volta à lista do item", () => {
    const item = modulos.item_ativo("/epis/requisicoes")!;
    expect(modulos.destino_do_voltar("/epis/requisicoes/7", item, true, [item])).toEqual({
      href: "/epis/requisicoes",
      rotulo: "Voltar a Requisições",
    });
  });

  it("a lista do item volta ao início do módulo; o início não volta a nada", () => {
    const inicio = modulos.item_ativo("/epis")!;
    const lista = modulos.item_ativo("/epis/estoque")!;
    expect(modulos.destino_do_voltar("/epis/estoque", lista, true, [inicio, lista])).toEqual({
      href: "/epis",
      rotulo: `Voltar ao ${inicio.rotulo}`,
    });
    expect(modulos.destino_do_voltar("/epis", inicio, true, [inicio, lista])).toBeNull();
    expect(modulos.destino_do_voltar("/servidores", modulos.item_ativo("/servidores"), false, [inicio])).toBeNull();
    expect(modulos.destino_do_voltar("/x", null, true, [inicio])).toBeNull();
  });
});

describe("o botão na tela", () => {
  it("aparece na lista do módulo e some no início dele", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const inicio = await cliente.get("/epis", { seguir: false });
    expect(inicio.status).toBe(200);
    expect(_voltar(inicio.text)).toBeNull();
    const estoque = await cliente.get("/epis/estoque", { seguir: false });
    expect(estoque.status).toBe(200);
    expect(_voltar(estoque.text)).toMatchObject({ href: "/epis" });
  });

  it("a ficha volta à lista, e o parecer ao processo", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const novo = await cliente.get("/processos/novo", { seguir: false });
    expect(novo.status).toBe(200);
    expect(_voltar(novo.text)).toMatchObject({ href: "/processos", texto: "Voltar a Processos" });
  });

  it("a origem pedida em `?de=` vale mais que o padrão, e chave desconhecida é ignorada", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const do_kanban = await cliente.get("/processos/novo?de=kanban", { seguir: false });
    expect(_voltar(do_kanban.text)).toEqual({ href: "/kanban", texto: "Voltar ao Kanban" });
    const solta = await cliente.get("/processos/novo?de=https://evil.example", { seguir: false });
    expect(_voltar(solta.text)).toMatchObject({ href: "/processos" });
  });
});
