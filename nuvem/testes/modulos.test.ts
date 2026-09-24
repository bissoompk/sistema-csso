/**
 * Os módulos: agrupamento, base compartilhada, navegação e a porta da frente.
 * Porte de `testes/integracao/test_modulos.py`.
 *
 * Ficam de fora (dependem das telas dos módulos, portadas por outro trecho):
 * `test_link_no_menu_sempre_abre`, `test_a_trilha_nunca_oferece_porta_trancada`,
 * `test_a_ficha_de_epi_nao_manda_o_almoxarife_para_o_403`, os de `/config` e os
 * da busca global. `test_inicio_despacha...` confere o destino do 303, mas não
 * abre a tela de destino.
 */
import { describe, expect, it } from "vitest";
import * as modulos from "../src/modulos.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, SENHA_TESTE } from "./ajuda";

function usuario(...permissoes: string[]): UsuarioAtual {
  return new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes, perfis: [] });
}

describe("declaração dos módulos", () => {
  it("Processos SEI reúne o fluxo do processo", () => {
    const m = modulos.por_codigo(modulos.PROCESSOS_SEI)!;
    expect(m.itens.map((i) => i.caminho)).toEqual([
      "/",
      "/kanban",
      "/processos",
      "/laudos",
      "/adicionais",
      "/relatorios",
      "/importar",
    ]);
    expect(m.disponivel).toBe(true);
  });

  it("a base fica fora dos módulos", () => {
    const base = modulos.BASE.map((i) => i.caminho);
    expect(base).toEqual(["/pendencias", "/demandas", "/servidores", "/catalogos", "/auditoria", "/usuarios"]);
    const de_modulos = new Set(modulos.MODULOS.flatMap((m) => m.itens.map((i) => i.caminho)));
    for (const c of base) expect(de_modulos.has(c)).toBe(false);
  });

  it("módulos previstos estão declarados e marcados", () => {
    const previstos = modulos.MODULOS.filter((m) => !m.disponivel);
    expect(new Set(previstos.map((m) => m.nome))).toEqual(new Set(["Análise de Acidentes", "CISSP", "PGR"]));
    for (const m of previstos) {
      expect(m.itens).toEqual([]);
      expect(m.itens_previstos.length, m.nome).toBeGreaterThan(0);
    }
  });

  it("módulo entregue por fatias declara o que falta", () => {
    const c = modulos.por_codigo("certificados")!;
    expect(c.disponivel).toBe(true);
    expect(c.itens.length).toBeGreaterThan(0);
    expect(c.itens_previstos.length).toBeGreaterThan(0);
  });

  it.each(["/", "/kanban", "/processos", "/processos/12", "/pareceres/3", "/laudos"])(
    "a tela do fluxo %s fica dentro do módulo",
    (caminho) => {
      expect(modulos.modulo_ativo(caminho)!.codigo).toBe(modulos.PROCESSOS_SEI);
    },
  );

  it.each(["/servidores", "/catalogos", "/usuarios", "/pendencias", "/demandas"])(
    "a base %s não pertence a módulo nenhum",
    (caminho) => {
      expect(modulos.modulo_ativo(caminho)).toBeNull();
    },
  );

  it("a pendência é da base, e não de Processos SEI", () => {
    expect(modulos.modulo_ativo("/pendencias")).toBeNull();
    expect(modulos.item_ativo("/pendencias")!.rotulo).toBe("Pendências");
    expect(modulos.BASE).toContain(modulos.item_ativo("/pendencias"));
    expect(modulos.modulo_ativo("/pareceres/3")!.codigo).toBe(modulos.PROCESSOS_SEI);
  });
});

describe("menu e navegação", () => {
  it("quem só opera treinamento vê a pendência no menu", () => {
    expect(modulos.base_de(usuario("treinamento.ver")).map((i) => i.rotulo)).toEqual(["Pendências"]);
    expect(modulos.base_de(usuario("indicador.ver", "backup.executar"))).toEqual([]);
  });

  it("o menu esconde o que o usuário não pode ver", () => {
    const so_processo = usuario("processo.ver");
    const rotulos = modulos.por_codigo(modulos.PROCESSOS_SEI)!.itens_de(so_processo).map((i) => i.rotulo);
    expect(rotulos).not.toContain("Laudos");
    expect(rotulos).not.toContain("Importar");
    expect(rotulos).toContain("Kanban");
    expect(modulos.base_de(so_processo).map((i) => i.rotulo)).toEqual(["Pendências", "Servidores", "Catálogos"]);
  });

  it("sem usuário, nada é visível", () => {
    expect(modulos.base_de(null)).toEqual([]);
    expect(modulos.primeira_tela(null)).toBe("/modulos");
  });

  it("navegação na base não esvazia a barra", () => {
    const nav = modulos.navegacao("/catalogos", usuario("processo.ver", "catalogo.gerenciar"));
    expect(nav.modulo_ativo!.codigo).toBe(modulos.PROCESSOS_SEI);
    expect(nav.itens_modulo.length).toBeGreaterThan(0);
    expect(nav.no_modulo).toBe(false);
  });

  it("a base preserva o módulo de onde a pessoa veio", () => {
    const u = usuario("processo.ver", "epi.ver", "epi.ficha");
    const nav = modulos.navegacao("/servidores/12", u, "epis");
    expect(nav.modulo_ativo!.codigo).toBe("epis");
    expect(nav.itens_modulo.map((i) => i.caminho)).toContain("/epis/fichas");
    expect(nav.item_ativo!.caminho).toBe("/servidores");
    expect(nav.no_modulo).toBe(false);
  });

  it("o caminho manda sobre a origem", () => {
    const u = usuario("processo.ver", "epi.ver");
    const nav = modulos.navegacao("/processos", u, "epis");
    expect(nav.modulo_ativo!.codigo).toBe(modulos.PROCESSOS_SEI);
    expect(nav.no_modulo).toBe(true);
    expect(nav.modulo_a_lembrar).toBe(modulos.PROCESSOS_SEI);
    expect(modulos.navegacao("/servidores", u).modulo_a_lembrar).toBeNull();
  });

  it("o almoxarife na base não recebe menu em branco", () => {
    const almoxarife = usuario("epi.ver", "epi.estoque", "epi.entregar", "epi.ficha");
    const nav = modulos.navegacao("/pendencias", almoxarife);
    expect(nav.modulo_ativo!.codigo).toBe("epis");
    expect(nav.itens_modulo.length).toBeGreaterThan(0);
  });

  it("a origem só vale se o módulo abrir para a pessoa", () => {
    const almoxarife = usuario("epi.ver", "epi.entregar", "epi.ficha");
    const nav = modulos.navegacao("/pendencias", almoxarife, modulos.PROCESSOS_SEI);
    expect(nav.modulo_ativo!.codigo).toBe("epis");
    expect(nav.itens_modulo.length).toBeGreaterThan(0);
    expect(modulos.navegacao("/pendencias", almoxarife, "inexistente").itens_modulo.length).toBeGreaterThan(0);
  });

  it("a trilha não oferece item que a pessoa não abre", () => {
    expect(modulos.navegacao("/auditoria", usuario("processo.ver")).item_ativo).toBeNull();
  });

  it("o seletor leva à primeira tela do módulo", () => {
    const coordenador = usuario("processo.ver", "epi.ver", "treinamento.ver");
    const epis = modulos.por_codigo("epis")!;
    expect(modulos.porta_de_entrada(epis, coordenador)).toBe("/epis");
    const almoxarife = usuario("epi.ver", "epi.ficha");
    expect(modulos.porta_de_entrada(epis, almoxarife)).toBe("/epis");
    const certificados = modulos.por_codigo("certificados")!;
    expect(modulos.porta_de_entrada(certificados, almoxarife)).toBe("/modulos#certificados");
  });

  it("a primeira tela é a do módulo que abre para a pessoa", () => {
    expect(modulos.primeira_tela(usuario("processo.ver"))).toBe("/");
    expect(modulos.primeira_tela(usuario("epi.ver", "epi.estoque", "epi.entregar", "epi.ficha"))).toBe("/epis");
    expect(modulos.primeira_tela(usuario("treinamento.ver"))).toBe("/turmas");
    expect(modulos.primeira_tela(usuario("backup.executar"))).toBe("/modulos");
  });
});

describe("telas", async () => {
  const { db, novoCliente } = await bancoLimpo();
  await contas(db);

  it("o mapa dos módulos", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/modulos");
    expect(r.status).toBe(200);
    for (const nome of [
      "Processos SEI",
      "Base compartilhada",
      "Gestão de EPI",
      "Certificados e Treinamentos",
      "Análise de Acidentes",
      "CISSP",
      "PGR",
    ]) {
      expect(r.text, nome).toContain(nome);
    }
    expect(r.text).toContain("ainda não desenvolvido");
  });

  it("a barra mostra o módulo e separa a base", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    const corpo = (await cliente.get("/modulos")).text;
    expect(corpo).toContain('<aside class="lateral">');
    expect(corpo).toContain("Processos SEI");
    expect(corpo).toContain('class="menu menu-base"');
    expect(corpo).toContain("Gestão de EPI");
    expect(corpo).toContain('class="em-breve"');
    // o seletor aponta para a porta de entrada, não para o mapa
    expect(corpo).toContain('href="/epis"');
    // a trilha da tela acima dos módulos diz "Módulos"
    expect(corpo).toMatch(/<nav class="trilha"[^>]*>\s*<a href="\/modulos">Módulos<\/a>/);
    // e o avatar sai das iniciais do nome
    expect(corpo).toContain('<span class="avatar" aria-hidden="true">CT</span>');
  });

  it.each([
    ["secretaria_csso", "/auditoria"],
    ["admin_ti", "/catalogos"],
    ["admin_ti", "/processos"],
  ])("o mapa não oferece a %s a tela %s, que ela não abre", async (perfil, negado) => {
    const cliente = novoCliente();
    await entrar(cliente, perfil);
    expect((await cliente.get("/modulos")).text).not.toContain(`href="${negado}"`);
  });

  it.each([
    ["coordenador_csso", "/"],
    ["almoxarife_sesmt", "/epis"],
    ["admin_ti", "/relatorios"],
  ])("/inicio despacha %s para %s", async (perfil, destino) => {
    const cliente = novoCliente();
    await entrar(cliente, perfil);
    const r = await cliente.get("/inicio", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe(destino);
  });

  it("/inicio sem sessão vai ao login", async () => {
    const r = await novoCliente().get("/inicio", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("a marca da lateral aponta para o despachante", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "almoxarife_sesmt");
    const corpo = (await cliente.get("/modulos")).text;
    expect(corpo).toContain('class="marca" href="/inicio"');
    // o almoxarife não tem Processos SEI: o menu dele é o de EPI
    expect(corpo).toContain('href="/epis/estoque"');
    expect(corpo).not.toContain('href="/kanban"');
  });

  it("login leva ao despachante e não ao painel", async () => {
    const r = await novoCliente().post("/login", { login: "almoxarife_sesmt", senha: SENHA_TESTE }, { seguir: false });
    expect(r.location).toBe("/inicio");
  });

  it("a engrenagem de /config segue a permissão da rota", async () => {
    const cliente = novoCliente();
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/modulos")).text).toContain('href="/config"');
    await entrar(cliente, "admin_ti");
    expect((await cliente.get("/modulos")).text).toContain('href="/config"');
    await entrar(cliente, "almoxarife_sesmt");
    expect((await cliente.get("/modulos")).text).not.toContain('href="/config"');
  });
});
