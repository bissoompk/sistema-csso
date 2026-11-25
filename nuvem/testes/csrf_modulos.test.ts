/**
 * Parte 4 (24/11/2026): o token CSRF da sessão vale em todo módulo. Um POST de formulário sem o
 * token, ou com o token de OUTRA sessão, é recusado com 403 antes de tocar no banco — mesmo sem os
 * cabeçalhos de origem (o buraco que a conferência de origem deixava).
 */
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { token_da_sessao } from "../src/nucleo/csrf.js";
import { COOKIE_SESSAO } from "../src/servicos/autenticacao.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

// uma rota de escrita real por módulo, com um formulário plausível
const ROTAS: readonly [string, string, Record<string, string>][] = [
  ["Treinamentos (catálogo)", "/treinamentos/catalogo", { codigo: "NR-99", nome: "Teste CSRF", carga_horaria_horas: "8", validade_meses: "12" }],
  ["Treinamentos (turmas)", "/turmas", { treinamento_id: "1" }],
  ["EPI (catálogo)", "/epis/catalogo", { nome: "Luva CSRF", categoria_id: "1", quantidade_padrao: "1" }],
  ["EPI (requisições)", "/epis/requisicoes", { servidor_id: "1" }],
  ["Processos SEI", "/processos/novo", { nup: "23086.000001/2024-00", tipo_processo_id: "1" }],
  ["Kanban", "/kanban/mover/1", { coluna: "CONCLUIDO" }],
  ["Demandas", "/demandas", { assunto: "x", descricao: "y" }],
  ["Laudos", "/laudos", { titulo: "x" }],
  ["Acidentes", "/acidentes/comunicar", { descricao: "x" }],
  ["Ocorrências", "/ocorrencias/registrar", { descricao: "x" }],
  ["Usuários", "/usuarios", { login: "csrf@x.com", nome: "X" }],
  ["Sair", "/sair", {}],
];

describe("token CSRF em cada módulo", () => {
  for (const [modulo, rota, campos] of ROTAS) {
    it(`${modulo}: POST sem token é recusado com 403`, async () => {
      const cli = await entrar(novoCliente(), "coordenador_csso");
      const r = await cli.post(rota, campos, { seguir: false, sem_csrf: true });
      expect(r.status, r.text.slice(0, 200)).toBe(403);
      expect(r.text).toContain("CSRF");
    });
  }

  it("o 403 vem antes do banco: nada é gravado", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const antes = Number((await db.select({ n: count() }).from(e.treinamento))[0]!.n);
    await cli.post(ROTAS[0]![1], ROTAS[0]![2], { seguir: false, sem_csrf: true });
    expect(Number((await db.select({ n: count() }).from(e.treinamento))[0]!.n)).toBe(antes);
  });

  it("o token de OUTRA sessão é recusado, e o da própria sessão passa", async () => {
    const a = await entrar(novoCliente(), "coordenador_csso");
    const b = await entrar(novoCliente(), "coordenador_csso");
    const token_de_a = token_da_sessao(a.cookies.get(COOKIE_SESSAO)!);
    const token_de_b = token_da_sessao(b.cookies.get(COOKIE_SESSAO)!);
    expect(token_de_a).not.toBe(token_de_b);
    const alheio = await b.post("/processos/novo", { nup: "x", tipo_processo_id: "1", _csrf: token_de_a }, { seguir: false, sem_csrf: true });
    expect(alheio.status).toBe(403);
    const pelo_cabecalho = await b.post("/processos/novo", { nup: "x" }, { seguir: false, sem_csrf: true, cabecalhos: { "x-csrf-token": token_de_a } });
    expect(pelo_cabecalho.status).toBe(403);
    const proprio = await b.post("/processos/novo", { nup: "x", tipo_processo_id: "1", _csrf: token_de_b }, { seguir: false, sem_csrf: true });
    expect(proprio.status).not.toBe(403);
  });

  it("o token muda a cada login (a sessão nova invalida as telas abertas antes)", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const antigo = token_da_sessao(cli.cookies.get(COOKIE_SESSAO)!);
    await entrar(cli, "coordenador_csso");
    expect(token_da_sessao(cli.cookies.get(COOKIE_SESSAO)!)).not.toBe(antigo);
  });

  it("a API (/api/v1, JSON com a sessão) continua sem token: CORS já barra o JSON de outro site", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const r = await cli.postJson("/api/v1/epis/entregas", {}, { sem_csrf: true, cabecalhos: { "x-requested-with": "fetch" } });
    expect(r.status).not.toBe(403);
    expect(r.text).not.toContain("CSRF");
  });

  it("validação pública: sem sessão passa; logado, passa com o token da página", async () => {
    expect((await novoCliente().post("/validar", { chave: "CSSO-X" }, { seguir: false })).status).toBe(303);
    const cli = await entrar(novoCliente(), "servidor_consulta");
    const tela = (await cli.get("/validar")).text;
    const m = /<input type="hidden" name="_csrf" value="([^"]+)">/.exec(tela);
    expect(m).not.toBeNull();
    expect((await cli.post("/validar", { chave: "CSSO-X", _csrf: m![1]! }, { seguir: false, sem_csrf: true })).status).toBe(303);
  });
});

describe("API /api/v1 com o cookie da tela (24/11/2026)", () => {
  const ROTAS_API = ["/api/v1/epis/entregas", "/api/v1/turmas/1/presencas"];
  const METODOS = ["POST", "PUT", "PATCH", "DELETE"] as const;
  const FORMAS: readonly [string, string | null, string][] = [
    ["formulário", "application/x-www-form-urlencoded", "servidor_id=1&item_id=1"],
    ["multipart", "multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--x--\r\n"],
    ["text/plain com JSON dentro", "text/plain;charset=UTF-8", '{"servidor_id":1,"item_id":1}'],
    ["sem Content-Type", null, '{"servidor_id":1}'],
  ];

  for (const metodo of METODOS) {
    for (const [forma, tipo, corpo] of FORMAS) {
      it(`${metodo} em ${forma} é recusado com 415, mesmo com o token e o X-Requested-With certos`, async () => {
        const cli = await entrar(novoCliente(), "coordenador_csso");
        for (const rota of ROTAS_API) {
          const cabecalhos: Record<string, string> = { "x-requested-with": "fetch", accept: "application/json" };
          if (tipo) cabecalhos["content-type"] = tipo;
          const r = await cli.requisitar(metodo, rota, corpo, { cabecalhos, seguir: false });
          expect(r.status, `${metodo} ${rota}`).toBe(415);
          expect(r.json().erro).toContain("JSON");
        }
      });
    }
  }

  it("a conferência de origem vale na API: JSON vindo de outro site é recusado", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const de_fora: Record<string, string>[] = [{ origin: "https://site-malicioso.example" }, { referer: "https://site-malicioso.example/x" }, { "sec-fetch-site": "cross-site" }];
    for (const cab of de_fora) {
      const r = await cli.postJson("/api/v1/epis/entregas", { servidor_id: 1 }, {
        seguir: false,
        cabecalhos: { "x-requested-with": "fetch", accept: "application/json", ...cab },
      });
      expect(r.status, JSON.stringify(cab)).toBe(403);
      expect(r.text).toContain("outra origem");
    }
  });

  it("JSON da própria origem sem X-Requested-With: fetch é recusado", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const r = await cli.postJson("/api/v1/epis/entregas", { servidor_id: 1 }, { seguir: false, cabecalhos: { accept: "application/json" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain("X-Requested-With");
  });

  it("JSON da própria origem com X-Requested-With passa da porta (a recusa é do conteúdo, 422)", async () => {
    const cli = await entrar(novoCliente(), "coordenador_csso");
    const r = await cli.postJson("/api/v1/epis/entregas", {}, { seguir: false, cabecalhos: { "x-requested-with": "fetch", accept: "application/json" } });
    expect(r.status).toBe(422);
  });
});
