/**
 * Parte 4 (24/11/2026): o recado do redirecionamento vai em cookie assinado e de uso único, e não
 * na URL. Texto posto à mão em `?mensagem=`/`?erro=` não aparece na faixa oficial.
 */
import { describe, expect, it } from "vitest";
import { nup_dv } from "../src/servicos/nup.js";
import * as recado from "../src/nucleo/recado.js";
import * as csrf from "../src/nucleo/csrf.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const FORMULARIO = { accept: "text/html,application/xhtml+xml" };
const FALSO = "Sua senha expirou: ligue para 0800-000-0000";

async function coordenador(): Promise<Cliente> {
  return entrar(novoCliente(), "coordenador_csso");
}

async function redirecionar_com_erro(cliente: Cliente) {
  const sequencial = "612345";
  const nup = `23086.${sequencial}/2024-${nup_dv(`23086${sequencial}2024`)}`;
  const criado = await cliente.post("/processos/novo", { nup, tipo_processo_id: "1" }, { seguir: false });
  const id = Number(criado.location!.split("/").pop()!.split("?")[0]);
  return cliente.post(`/kanban/mover/${id}`, { coluna: "CONCLUIDO" }, { cabecalhos: FORMULARIO, seguir: false });
}

describe("recado em cookie assinado", () => {
  it("o Location sai sem o texto, e o cookie leva o recado à tela certa uma vez só", async () => {
    const cliente = await coordenador();
    const r = await redirecionar_com_erro(cliente);
    expect(r.status).toBe(303);
    expect(r.location_cru).toBe("/kanban");
    expect(r.headers.getSetCookie().some((l) => l.startsWith(`${recado.COOKIE_RECADO}=`) && l.includes("HttpOnly"))).toBe(true);
    const tela = await cliente.get("/kanban");
    expect(tela.text).toContain('class="aviso aviso-erro"');
    // usado, some: recarregar não repete o recado
    const de_novo = await cliente.get("/kanban");
    expect(de_novo.text).not.toContain('class="aviso aviso-erro"');
  });

  it("texto posto à mão no endereço não aparece", async () => {
    const cliente = await coordenador();
    for (const chave of ["mensagem", "erro"]) {
      const tela = await cliente.get(`/kanban?${chave}=${encodeURIComponent(FALSO)}`);
      expect(tela.status).toBe(200);
      expect(tela.text).not.toContain("0800-000-0000");
    }
  });

  it("cookie forjado ou de outra chave é ignorado", async () => {
    const cliente = await coordenador();
    const valido = recado.selar({ para: "/kanban", textos: { erro: FALSO } });
    const [corpo] = valido.split(".");
    const forjado = `${corpo}.${"A".repeat(43)}`;
    cliente.cookies.set(recado.COOKIE_RECADO, forjado);
    expect((await cliente.get("/kanban")).text).not.toContain("0800-000-0000");
    expect(recado.abrir(forjado)).toBeNull();
    expect(recado.abrir("lixo")).toBeNull();
    expect(recado.abrir(valido)?.textos.erro).toBe(FALSO);
  });

  it("o recado só vale na tela a que se destina", async () => {
    const cliente = await coordenador();
    cliente.cookies.set(recado.COOKIE_RECADO, recado.selar({ para: "/processos", textos: { mensagem: "Recado de outra tela" } }));
    expect((await cliente.get("/kanban")).text).not.toContain("Recado de outra tela");
  });

  it("o texto longo é cortado para caber no cookie", () => {
    const longo = "x".repeat(5000);
    const selado = recado.selar({ para: "/a", textos: { erro: longo } });
    expect(selado.length).toBeLessThan(3000);
    expect(recado.abrir(selado)!.textos.erro!.endsWith("…")).toBe(true);
  });
});

describe("token CSRF da sessão", () => {
  it("formulário sem o token é recusado com 403, mesmo sem cabeçalho de origem", async () => {
    const cliente = await coordenador();
    const r = await cliente.post("/processos/novo", { nup: "x", tipo_processo_id: "1" }, { seguir: false, sem_csrf: true });
    expect(r.status).toBe(403);
    expect(r.text).toContain("CSRF");
    const errado = await cliente.post(
      "/processos/novo",
      { nup: "x", tipo_processo_id: "1", _csrf: "token-de-outra-sessao" },
      { seguir: false, sem_csrf: true },
    );
    expect(errado.status).toBe(403);
  });

  it("a tela põe o token nos formulários POST, no htmx e na meta; o token do formulário vale", async () => {
    const cliente = await coordenador();
    const tela = (await cliente.get("/processos/novo")).text;
    const m = /<input type="hidden" name="_csrf" value="([^"]+)">/.exec(tela);
    expect(m).not.toBeNull();
    expect(tela).toContain(`hx-headers='{"x-csrf-token": "${m![1]}"}'`);
    expect(tela).toContain(`<meta name="csrf-token" content="${m![1]}">`);
    // o formulário com o campo oculto passa (sem o cabeçalho automático do cliente)
    const r = await cliente.post("/processos/novo", { nup: "nada", tipo_processo_id: "1", _csrf: m![1]! }, { sem_csrf: true });
    expect(r.status).not.toBe(403);
  });

  it("JSON e quem não tem sessão não pedem token", () => {
    expect(csrf.exige_token("POST", "application/json")).toBe(false);
    expect(csrf.exige_token("GET", "")).toBe(false);
    expect(csrf.exige_token("POST", "text/plain;charset=UTF-8")).toBe(true);
    expect(csrf.exige_token("POST", "")).toBe(true);
  });
});
