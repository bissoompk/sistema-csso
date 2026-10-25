/**
 * Correções da casca e das peças de tela compartilhadas (lote "visual-base").
 *
 * O que é regra aqui, e não só desenho:
 *
 * - o "Meu espaço" de quem só tem o próprio (M47/M81): o menu muda, a porta
 *   não — cada item tem de abrir, e nenhum item da equipe aparece;
 * - o item Pendências usa a MESMA tupla da rota (M83);
 * - a engrenagem de /config segue a mesma conta da rota (`ve_config`);
 * - o service worker não guarda a página com o nome de quem entrou (D59);
 * - a tela de bolso não cita código de permissão (M53);
 * - as ações da tela saíram do cabeçalho de 62px (D39/D12).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as modulos from "../src/modulos.js";
import { ATALHOS } from "../src/rotas/celular.js";
import { pastaDeEstaticos } from "../src/rotas/aplicativo.js";
import { PERMISSOES_VER } from "../src/servicos/pendencias.js";
import { MATRIZ_PERFIS, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar } from "./ajuda";

// Um banco só para o arquivo: `bancoLimpo` esvazia o banco do processo, e as
// funções de `describe` rodam todas antes do primeiro teste.
const { db, novoCliente } = await bancoLimpo();
await contas(db);
const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
const [servidor] = await db
  .insert(e.servidor)
  .values({ siape: "7654321", nome: "Titular do Meu Espaço", unidade_uorg_id: unidade!.id })
  .returning();
await criarUsuario(db, { login: "titular", nome: "Titular do Meu Espaço", perfis: ["servidor_consulta"], servidor_id: servidor!.id });

function lateral(corpo: string): string {
  return corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));
}

function hrefs(trecho: string): string[] {
  return [...trecho.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]!);
}

describe("o item Pendências do menu (M83)", () => {
  it("é a mesma tupla da rota, e não uma cópia", () => {
    const item = modulos.BASE.find((i) => i.caminho === "/pendencias")!;
    expect(item.permissao).toBe(PERMISSOES_VER);
  });

  it("quem só tem demanda.ver vê o item, como a rota deixa", () => {
    // por um perfil de equipe: o menu da equipe pede a permissão por perfil de equipe
    const so_demanda = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["demanda.ver"], perfis: ["secretaria_csso"] });
    expect(modulos.base_de(so_demanda).map((i) => i.caminho)).toContain("/pendencias");
  });
});

describe("o Meu espaço de quem só tem o próprio (M47/M81)", () => {

  it("o servidor vinculado recebe só o Meu espaço, com os seus itens", async () => {
    const cliente = await entrar(novoCliente(), "titular");
    const corpo = (await cliente.get("/turmas/minhas")).text;
    const menu = lateral(corpo);
    expect(menu).toContain('aria-label="Meu espaço"');
    expect(menu).not.toContain('class="modulos-lateral"');
    expect(menu).not.toContain('class="menu menu-base"');
    for (const proibido of ["/kanban", "/laudos", "/catalogos", "/servidores", "/epis/estoque", "/modulos", "/pendencias"]) {
      expect(hrefs(menu), proibido).not.toContain(proibido);
    }
    // o "Sair" fecha a lista (Portal do servidor, 22/10/2026); "Meus dados"
    // saiu do menu — a ficha continua acessível pelo Meu perfil
    expect(hrefs(menu).filter((h) => h !== "/inicio")).toEqual([
      "/",
      "/turmas/minhas",
      "/certificados/meus",
      "/certificados/meus/comprovante",
      "/epis/fichas/minha",
      "/epis/requisicoes",
      "/epis/requisicoes/nova",
      // Acidentes (CAT/SP, 23/10/2026): comunicar e o que ele comunicou
      "/acidentes/comunicar",
      "/acidentes/minhas",
      // "/adicionais" e "/processos" só com a exceção da pessoa (25/10/2026)
      "/minha-atividade",
      // o Meu perfil (a Minha conta) fecha o bloco (22/10/2026)
      "/minha-conta",
      "/sair",
    ]);
    // a engrenagem de /config não é dele
    expect(corpo).not.toContain('href="/config"');
    // a trilha fala a língua do menu que ele vê
    expect(corpo).toMatch(/<nav class="trilha"[^>]*>\s*<a href="\/inicio">Meu espaço<\/a>\s*<a href="\/turmas\/minhas">Meus treinamentos<\/a>/);
  });

  it("a trilha da ficha e do processo fala a língua do Meu espaço (revisão)", () => {
    const titular = new UsuarioAtual({
      id: 7, login: "t", nome: "t", permissoes: ["processo.ver", "epi.ver", "treinamento.ver"], perfis: ["servidor_consulta"], servidor_id: 42,
    });
    // `/epis/fichas/minha` redireciona para a ficha pelo id: é a mesma tela
    expect(modulos.navegacao("/epis/fichas/42", titular).item_ativo?.rotulo).toBe("Minha ficha de EPI");
    expect(modulos.navegacao("/processos/10", titular).item_ativo?.rotulo).toBe("Meus processos");
    // a ficha de OUTRO servidor não vira "minha"
    expect(modulos.navegacao("/epis/fichas/43", titular).item_ativo?.rotulo).not.toBe("Minha ficha de EPI");
  });

  it("todo item do Meu espaço abre (o menu não oferece porta trancada)", async () => {
    const cliente = await entrar(novoCliente(), "titular");
    const menu = lateral((await cliente.get("/")).text);
    for (const destino of hrefs(menu)) {
      // `/sair` é a tela que confirma a saída (POST com CSRF): abre, mas não é tela do titular
      if (destino === "/inicio" || destino === "/sair") continue;
      const r = await cliente.get(destino, { cabecalhos: { accept: "text/html" } });
      expect(r.status, destino).toBe(200);
    }
  });

  it("sem servidor vinculado, sobra só o que não é do titular", async () => {
    const cliente = await entrar(novoCliente(), "servidor_consulta");
    const menu = lateral((await cliente.get("/")).text);
    expect(menu).toContain('aria-label="Meu espaço"');
    expect(hrefs(menu).filter((h) => h !== "/inicio")).toEqual(["/", "/minha-conta", "/sair"]);
  });

  it("a equipe continua com a lateral de sempre", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const menu = lateral((await cliente.get("/")).text);
    expect(menu).not.toContain('aria-label="Meu espaço"');
    expect(menu).toContain('class="modulos-lateral"');
    expect(menu).toContain('href="/kanban"');
  });

  it("um perfil de equipe a mais devolve o menu da equipe, com o Meu espaço ao lado (D16)", () => {
    const misto = new UsuarioAtual({
      id: 9, login: "m", nome: "m", permissoes: ["processo.ver"], perfis: ["servidor_consulta", "secretaria_csso"], servidor_id: 1,
    });
    expect(modulos.so_o_proprio(misto)).toBe(false);
    expect(modulos.navegacao("/", misto).so_meu_espaco).toBe(false);
    // o que a lateral da equipe já oferece (Painel, Processos, Adicionais) não
    // se repete no bloco com nome de "meu": sobra o que é da pessoa (a Minha
    // atividade e o Meu perfil; "Meus dados" saiu do menu em 22/10/2026)
    expect(modulos.meu_espaco_de(misto).map((i) => i.caminho)).toEqual(["/minha-atividade", "/minha-conta"]);
  });

  it("perfil sem escopo declarado não derruba a casca: o menu é o da equipe, e a rota nega", () => {
    const torto = new UsuarioAtual({
      id: 10, login: "t", nome: "t", permissoes: ["processo.ver"], perfis: ["perfil_inexistente"], servidor_id: 1,
    });
    expect(() => torto.escopo).toThrow();
    expect(modulos.so_o_proprio(torto)).toBe(false);
    expect(modulos.meu_espaco_de(torto)).toEqual([]);
  });

  it("cada item do Meu espaço declara a permissão do item da equipe para o mesmo caminho", () => {
    const da_equipe = new Map(modulos.MODULOS.flatMap((m) => m.itens).map((i) => [i.caminho, i.permissao]));
    for (const item of modulos.MEU_ESPACO) {
      if (da_equipe.has(item.caminho)) expect(item.permissao, item.caminho).toEqual(da_equipe.get(item.caminho));
    }
  });
});

describe("a casca", () => {
  it("as ações da tela moram na faixa abaixo do cabeçalho (D39/D12)", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get("/processos")).text;
    const cabecalho = corpo.slice(corpo.indexOf('<header class="cabecalho">'), corpo.indexOf("</header>"));
    expect(cabecalho).not.toContain('href="/processos/novo"');
    const faixa = corpo.slice(corpo.indexOf('<div class="acoes-pagina">'), corpo.indexOf('<main class="conteudo'));
    expect(faixa).toContain('href="/processos/novo"');
  });

  it("o menu do celular é um interruptor sem JavaScript, e a lateral continua uma só", async () => {
    const cliente = await entrar(novoCliente(), "secretaria_csso");
    const corpo = (await cliente.get("/demandas")).text;
    expect(corpo).toContain('<details class="menu-celular">');
    expect(corpo.split('<aside class="lateral">').length).toBe(2);
  });

  it("o sino leva às pendências da própria pessoa", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get("/demandas")).text;
    expect(corpo).toMatch(/<a class="sino[^"]*" href="\/pendencias\?minhas=1"/);
    expect(corpo).toMatch(/\d+ pendência\(s\) aberta\(s\) sob sua responsabilidade/);
  });

  it("a engrenagem de /config aparece exatamente para quem a rota abre", async () => {
    for (const perfil of Object.keys(MATRIZ_PERFIS)) {
      const cliente = await entrar(novoCliente(), perfil);
      const corpo = (await cliente.get("/modulos")).text;
      const abre = (await cliente.get("/config")).status === 200;
      expect(corpo.includes('href="/config"'), perfil).toBe(abre);
    }
  });
});

describe("a tela de bolso (M53, D59)", () => {

  it("o servidor sem balcão nem chamada recebe atalhos, sem código de permissão", async () => {
    const cliente = await entrar(novoCliente(), "titular");
    const corpo = (await cliente.get("/celular")).text;
    // os próprios processos e o adicional só com a exceção da pessoa (25/10/2026)
    const do_processo = (c: string) => c === "/adicionais" || c === "/processos";
    for (const a of ATALHOS.filter((a) => !do_processo(a.caminho))) expect(corpo, a.caminho).toContain(`href="${a.caminho}"`);
    for (const a of ATALHOS.filter((a) => do_processo(a.caminho))) expect(corpo, a.caminho).not.toContain(`href="${a.caminho}"`);
    expect(corpo).not.toContain("epi.entregar");
    expect(corpo).not.toContain("turma.avaliar");
    expect(corpo).not.toContain("ainda não tem trabalho");
    // nem o cache HTTP do navegador guarda a página com o nome (revisão, D59)
    expect((await cliente.get("/celular")).cabecalho("cache-control")).toBe("no-store");
    // cada atalho abre
    for (const a of ATALHOS.filter((a) => !do_processo(a.caminho))) {
      expect((await cliente.get(a.caminho)).status, a.caminho).toBe(200);
    }
  });

  it("sem vínculo, a caixa vazia também não cita permissão", async () => {
    const cliente = await entrar(novoCliente(), "consulta_progep");
    const corpo = (await cliente.get("/celular")).text;
    expect(corpo).toContain("ainda não tem trabalho para você");
    expect(corpo).not.toContain("<em>epi.entregar</em>");
  });

  it("o service worker não guarda a página, que leva o nome de quem entrou", () => {
    const texto = readFileSync(path.join(pastaDeEstaticos(), "js", "sw.js"), "utf-8");
    const inicio = texto.indexOf("var CASCA = [");
    const casca = texto.slice(inicio, texto.indexOf("];", inicio));
    expect(casca).not.toContain("'/celular'");
    // a versão subiu: a ativação apaga o cache que ainda tinha a página
    expect(texto).toContain("var VERSAO = 'csso-celular-v4'");
    expect(texto).toContain("caches.delete(n)");
    // a página sem rede é fixa: nem nome nem script nem estilo embutido
    const pagina = texto.slice(texto.indexOf("var SEM_REDE"), texto.indexOf("';\n", texto.indexOf("var SEM_REDE")));
    expect(pagina).not.toMatch(/<script|<style|style=/);
    expect(pagina).toContain('href="/celular"');
  });
});
