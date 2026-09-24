/**
 * `/app` (o front compilado) e `/api/v1/pendencias` — a fase 3 pelo lado de fora.
 * Porte de `testes/integracao/test_aplicativo.py`.
 *
 * O bundle é gerado pelo Vite a partir de `frontend/` e fica em
 * `public/estaticos/app/`. O que se prova é o contrato do servidor com ele: a
 * página exige sessão, os assets que ela cita existem (na nuvem saem do CDN,
 * então confere-se o arquivo publicado), nada nela é script embutido (a CSP não
 * tem `unsafe-inline`), e sem o bundle a rota diz que ele não foi montado.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as aplicativo from "../src/rotas/aplicativo.js";
import * as pendencias from "../src/servicos/pendencias.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, usuarioAtual, type AmbienteDeTeste, type Cliente } from "./ajuda";

// o primeiro `bancoLimpo()` na coleta registra a limpeza do arquivo
await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
async function como(amb: Amb, perfil: string): Promise<Cliente> {
  return entrar(amb.novoCliente(), amb.contas[perfil]![0]);
}

const BUNDLE = path.join(aplicativo.pastaDeEstaticos(), "app", "index.html");

afterEach(() => aplicativo._definir_entrada(null));

describe("/app", () => {
  it("exige sessão", async () => {
    const amb = await novo();
    const resposta = await amb.novoCliente().get("/app", { seguir: false });
    expect(resposta.status).toBe(303);
    expect(resposta.location).toContain("/login?proximo=%2Fapp");
  });

  it.skipIf(!existsSync(BUNDLE))("serve a página e os assets que ela cita existem", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const pagina = await c.get("/app");
    expect(pagina.status).toBe(200);
    expect(pagina.cabecalho("cache-control")).toBe("no-cache");
    expect(pagina.text).toContain('<div id="raiz"></div>');
    // o endereço colado sem a âncora também abre a página
    expect((await c.get("/app/balcao")).status).toBe(200);

    const scripts = [...pagina.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
    const folhas = [...pagina.text.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s.startsWith("/estaticos/app/assets/")).toBe(true);
    const publico = path.dirname(aplicativo.pastaDeEstaticos());
    for (const caminho of [...scripts, ...folhas]) expect(existsSync(path.join(publico, caminho)), caminho).toBe(true);
  });

  it.skipIf(!existsSync(BUNDLE))("a página do app não tem script embutido", async () => {
    const amb = await novo();
    const pagina = (await (await como(amb, "coordenador_csso")).get("/app")).text;
    for (const achado of pagina.matchAll(/<script(?<attrs>[^>]*)>(?<corpo>[\s\S]*?)<\/script>/g)) {
      expect(achado.groups!.attrs, "script embutido no index do Vite").toContain("src=");
      expect(achado.groups!.corpo!.trim()).toBe("");
    }
  });

  it("sem o bundle a rota diz como montá-lo", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    aplicativo._definir_entrada(path.join(aplicativo.pastaDeEstaticos(), "nao-existe", "index.html"));
    const resposta = await c.get("/app");
    expect(resposta.status).toBe(503);
    expect(resposta.text).toContain("npm run build");
    expect(resposta.text).toContain("/celular");
    expect(resposta.text).toContain("/inicio");
  });
});

// =====================================================================
// A fila de pendências em JSON
// =====================================================================
describe("/api/v1/pendencias", () => {
  /**
   * A porta é a de `/pendencias` (`pendencias.pode_ver`). No Python a recusa se
   * provava trocando a função; aqui, com uma conta sem perfil nenhum — que não
   * tem nenhuma das permissões de leitura de módulo.
   */
  it("exige operar algum módulo", async () => {
    const amb = await novo();
    expect((await (await como(amb, "servidor_consulta")).get("/api/v1/pendencias")).status).toBe(200);
    await criarUsuario(amb.db, { login: "sem_perfil", perfis: [] });
    const resposta = await (await entrar(amb.novoCliente(), "sem_perfil")).get("/api/v1/pendencias");
    expect(resposta.status).toBe(403);
    expect(resposta.json().motivos[0]).toContain("permissão exigida");
  });

  it("lista com rótulo, prazo e âncora", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    const criado = await c.post("/processos/novo", { nup: "23086.021284/2024-56", tipo_processo_id: "1" }, { seguir: false });
    expect(criado.status, criado.text.slice(0, 500)).toBe(303);
    const processo_id = Number(criado.location!.split("/").pop()!.split("?")[0]);
    const [coord] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const atual = await usuarioAtual(amb.db, coord!.login);
    await naTransacao((tx) =>
      pendencias.abrir(tx, {
        tipo: "INCLUIR_NO_SEI",
        chave: "app:1",
        descricao: "incluir no SEI",
        usuario: atual,
        processo_id,
      }),
    );

    const fila = (await c.get("/api/v1/pendencias")).json();
    expect(fila.abertas).toBe(1);
    expect(fila.atrasadas).toBe(0);
    const item = fila.itens[0];
    expect(item.rotulo_tipo).toBe("Incluir o parecer assinado no SEI");
    expect(item.descricao).toBe("incluir no SEI");
    expect(item.prazo).not.toBeNull();
    expect(item.onde).toBe(`/processos/${processo_id}`);
  });
});
