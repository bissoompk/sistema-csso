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
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import {
  CONCESSAO_DO_TITULAR,
  MATRIZ_PERFIS,
  PERMISSOES_DO_TITULAR,
  UsuarioAtual,
  type Concessao,
} from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, SENHA_TESTE } from "./ajuda";

/**
 * Uma conta de EQUIPE com só estas permissões. O perfil (de escopo E) está aí
 * porque o menu da equipe pede a permissão por perfil de equipe: sem perfil, a
 * conta é de quem só tem o próprio, e as telas do setor não aparecem para ela.
 */
function usuario(...permissoes: string[]): UsuarioAtual {
  return new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes, perfis: ["secretaria_csso"] });
}

/**
 * A conta como `carregar_usuario_atual` a monta: as concessões dos perfis e,
 * com servidor vinculado, a concessão do titular (escopo próprio).
 */
function montada(perfis: string[], servidor_id: number | null = null): UsuarioAtual {
  const concessoes: Concessao[] = perfis.map((perfil) => ({
    perfil,
    campus_id: null,
    permissoes: MATRIZ_PERFIS[perfil]!.permissoes,
  }));
  if (servidor_id !== null) {
    concessoes.push({ perfil: CONCESSAO_DO_TITULAR, campus_id: null, permissoes: PERMISSOES_DO_TITULAR });
  }
  return new UsuarioAtual({
    id: 1,
    login: "x",
    nome: "x",
    permissoes: concessoes.flatMap((c) => [...c.permissoes]),
    perfis,
    servidor_id,
    concessoes,
  });
}

/** A conta de um perfil da matriz, com ou sem servidor vinculado. */
function do_perfil(perfil: string, servidor_id: number | null = null): UsuarioAtual {
  return new UsuarioAtual({
    id: 1,
    login: perfil,
    nome: perfil,
    permissoes: MATRIZ_PERFIS[perfil]!.permissoes,
    perfis: [perfil],
    servidor_id,
  });
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
    expect(new Set(previstos.map((m) => m.nome))).toEqual(new Set(["CISSP", "PGR"]));
    for (const m of previstos) {
      expect(m.itens).toEqual([]);
      expect(m.itens_previstos.length, m.nome).toBeGreaterThan(0);
    }
  });

  it("módulo entregue por fatias deixa de declarar o que já chegou", () => {
    const c = modulos.por_codigo("certificados")!;
    expect(c.disponivel).toBe(true);
    expect(c.itens.length).toBeGreaterThan(0);
    expect(c.itens_previstos).toEqual([]);
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
    // os módulos ficam à vista na lateral; o "em breve" só no mapa, não nela
    expect(corpo).toContain('class="modulos-lateral"');
    const lateral = corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));
    expect(lateral).toContain("Certificados e Treinamentos");
    // Análise de Acidentes é módulo disponível desde a F0 (23/10/2026): está na lateral
    expect(lateral).toContain("Análise de Acidentes");
    // o link do módulo aponta para a porta de entrada, não para o mapa
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

  // Início com os cartões dos módulos (23/10/2026): para a equipe, `/inicio`
  // deixou de ser despachante e é a Visão geral — o cartão de cada módulo leva
  // à porta de entrada dele (`porta_de_entrada`, a mesma primeira tela de
  // antes). Ver `testes/home_modulos.test.ts`.
  it.each([
    ["coordenador_csso", "/"],
    ["almoxarife_sesmt", "/epis"],
    // sem `indicador.ver` (22/10/2026) o admin_ti não tem tela de módulo: o
    // cartão dele é o da Administração
    ["admin_ti", "/usuarios"],
  ])("/inicio abre a Visão geral de %s, com o caminho para %s", async (perfil, destino) => {
    const cliente = novoCliente();
    await entrar(cliente, perfil);
    const r = await cliente.get("/inicio", { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain(`class="cartao-mod-botao" href="${destino}"`);
  });

  it("o almoxarife ligado a servidor recebe a lateral do EPI e, ao lado, o Meu espaço", async () => {
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "almoxarife_sesmt"));
    const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "7650002", nome: "Almoxarife Vinculado", unidade_uorg_id: unidade!.id })
      .returning();
    await db.update(e.usuario).set({ servidor_id: servidor!.id }).where(eq(e.usuario.id, conta!.id));
    try {
      const cliente = novoCliente();
      await entrar(cliente, "almoxarife_sesmt");
      const na_epi = (await cliente.get("/epis")).text;
      const lateral = na_epi.slice(na_epi.indexOf('<aside class="lateral">'), na_epi.indexOf("</aside>"));
      const inicio_do_bloco = lateral.indexOf('class="menu menu-meu ao-lado"');
      expect(inicio_do_bloco).toBeGreaterThan(-1);
      // a parte da equipe: o trabalho dele, e nada das telas do setor que ele
      // só alcançaria pela concessão do titular
      const da_equipe = lateral.slice(0, inicio_do_bloco);
      expect(da_equipe).toContain('class="modulos-lateral"');
      expect(da_equipe).toContain('href="/epis/estoque"');
      for (const proibido of ['href="/kanban"', 'href="/processos"', 'href="/catalogos"', 'href="/turmas"', 'href="/turmas/minhas"']) {
        expect(da_equipe, proibido).not.toContain(proibido);
      }
      const bloco = lateral.slice(inicio_do_bloco);
      expect(bloco).toContain('href="/turmas/minhas"');
      expect(bloco).toContain('href="/epis/requisicoes/nova"');
      // "Meus dados" saiu do menu (22/10/2026); a Minha atividade entrou
      expect(bloco).not.toContain(`href="/servidores/${servidor!.id}"`);
      expect(bloco).toContain('href="/minha-atividade"');
      const corpo = (await cliente.get("/turmas/minhas")).text;
      // um "Meus treinamentos" só, e a trilha fala a língua do bloco
      expect(lateral.split('href="/turmas/minhas"').length - 1).toBe(1);
      expect(corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>")).split('href="/turmas/minhas"').length - 1).toBe(1);
      expect(corpo).toMatch(/<nav class="trilha"[^>]*>\s*<a href="\/inicio">Meu espaço<\/a>\s*<a href="\/turmas\/minhas">Meus treinamentos<\/a>/);
      // todo item do bloco abre
      for (const destino of [...bloco.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]!)) {
        const r = await cliente.get(destino, { cabecalhos: { accept: "text/html" } });
        expect(r.status, destino).toBe(200);
      }
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.id, conta!.id));
    }
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
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.get("/modulos")).text).not.toContain('href="/config"');
  });
});

describe("grupos do menu do módulo", () => {
  const certificados = modulos.por_codigo("certificados")!;
  const caminhos = (grupos: readonly modulos.GrupoMenu[]) => grupos.map((g) => g.itens.map((i) => i.caminho));

  it("Certificados e Treinamentos se divide nos grupos do trabalho", () => {
    expect(certificados.grupos.map((g) => g.titulo)).toEqual([
      null,
      "Turmas e inscrições",
      "Certificados",
      "Acompanhamento",
      "Cadastros",
      "Meu espaço",
    ]);
    expect(caminhos(certificados.grupos)).toEqual([
      ["/treinamentos"],
      ["/turmas", "/turmas/pedidos"],
      ["/certificados/fila", "/certificados", "/certificados/emails"],
      ["/certificados/vencimentos", "/treinamentos/indicadores"],
      [
        "/treinamentos/catalogo",
        "/treinamentos/modelos",
        "/treinamentos/assinaturas",
        "/treinamentos/setores-promotores",
      ],
      ["/turmas/minhas", "/certificados/meus"],
    ]);
  });

  it("a lista plana é a dos grupos, na mesma ordem, em todo módulo", () => {
    for (const m of modulos.MODULOS) expect(m.itens, m.codigo).toEqual(m.grupos.flatMap((g) => g.itens));
  });

  it("módulo declara grupos ou itens, não os dois", () => {
    const item = new modulos.Item("Um", "/um");
    expect(
      () => new modulos.Modulo({ codigo: "x", nome: "x", resumo: "", itens: [item], grupos: [{ titulo: "A", itens: [item] }] }),
    ).toThrow();
    const so_itens = new modulos.Modulo({ codigo: "x", nome: "x", resumo: "", itens: [item] });
    expect(so_itens.grupos).toHaveLength(1);
    expect(so_itens.grupos[0]!.titulo).toBeNull();
  });

  it.each([modulos.PROCESSOS_SEI, "epis"])("%s, que não se divide, sai num grupo só e sem título", (codigo) => {
    const m = modulos.por_codigo(codigo)!;
    const grupos = m.grupos_de(do_perfil("coordenador_csso"));
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.titulo).toBeNull();
    expect(grupos[0]!.itens).toEqual(m.itens_de(do_perfil("coordenador_csso")));
  });

  it("a secretaria vê cinco grupos, e em Cadastros só o que abre", () => {
    const grupos = certificados.grupos_de(do_perfil("secretaria_csso"));
    expect(grupos.map((g) => g.titulo)).toEqual([
      null,
      "Turmas e inscrições",
      "Certificados",
      "Acompanhamento",
      "Cadastros",
    ]);
    expect(caminhos(grupos)[4]).toEqual(["/treinamentos/catalogo", "/treinamentos/setores-promotores"]);
  });

  it("grupo único perde o subtítulo: quem só confere pedidos do link vê só eles", () => {
    const so_pedidos = usuario("turma.inscrever");
    const grupos = certificados.grupos_de(so_pedidos);
    expect(grupos).toEqual([{ titulo: null, itens: [expect.objectContaining({ caminho: "/turmas/pedidos" })] }]);
    expect(modulos.porta_de_entrada(certificados, so_pedidos)).toBe("/turmas/pedidos");
    // e a declaração congelada não foi tocada pelo recorte
    expect(certificados.grupos[1]!.titulo).toBe("Turmas e inscrições");
  });

  it("indicador.ver sozinho não abre os indicadores do módulo (liberação por módulo, 22/10/2026)", () => {
    // `indicador.ver` é transversal e vem do perfil; o relatório do módulo
    // pede também o acesso ao módulo (`Item.tambem`)
    expect(certificados.grupos_de(usuario("indicador.ver"))).toEqual([]);
    const com_modulo = certificados.itens_de(usuario("indicador.ver", "treinamento.ver")).map((i) => i.caminho);
    expect(com_modulo).toContain("/treinamentos/indicadores");
  });

  it("o admin de TI não vê Certificados: indicador.ver saiu do perfil (22/10/2026)", () => {
    const admin = do_perfil("admin_ti");
    expect(certificados.grupos_de(admin)).toEqual([]);
    expect(modulos.porta_de_entrada(certificados, admin)).toBe("/modulos#certificados");
  });

  it("a consulta da PROGEP vê a ordem do trabalho, sem o que não abre", () => {
    expect(certificados.itens_de(do_perfil("consulta_progep")).map((i) => i.caminho)).toEqual([
      "/treinamentos",
      "/turmas",
      "/certificados/fila",
      "/certificados",
      "/certificados/vencimentos",
      "/treinamentos/indicadores",
      "/treinamentos/catalogo",
      "/treinamentos/setores-promotores",
    ]);
  });

  it("com servidor vinculado, o Meu espaço sai do módulo para o bloco próprio e a porta de entrada não muda", () => {
    const ligado = montada(["coordenador_csso"], 7);
    // o grupo do módulo some: os dois itens estão no bloco "Meu espaço"
    expect(certificados.grupos_de(ligado).map((g) => g.titulo)).not.toContain("Meu espaço");
    expect(modulos.meu_espaco_de(ligado).map((i) => i.caminho)).toEqual(
      expect.arrayContaining(["/turmas/minhas", "/certificados/meus"]),
    );
    expect(certificados.grupos_de(do_perfil("coordenador_csso")).map((g) => g.titulo)).not.toContain("Meu espaço");
    const so_treinamento = new UsuarioAtual({
      id: 1,
      login: "x",
      nome: "x",
      permissoes: ["treinamento.ver"],
      perfis: ["secretaria_csso"],
      servidor_id: 7,
    });
    expect(modulos.primeira_tela(so_treinamento)).toBe("/turmas");
  });
});

describe("a conta de equipe ligada a servidor: a lateral da equipe e o Meu espaço (D16)", () => {
  const rotulos_da_equipe = (u: UsuarioAtual) => [
    ...modulos.MODULOS.flatMap((m) => m.itens_de(u)).map((i) => i.rotulo),
    ...modulos.base_de(u).map((i) => i.rotulo),
  ];
  const caminhos_da_equipe = (u: UsuarioAtual) => [
    ...modulos.MODULOS.flatMap((m) => m.itens_de(u)).map((i) => i.caminho),
    ...modulos.base_de(u).map((i) => i.caminho),
  ];

  it("o almoxarife ligado a servidor não vê Kanban, Processos nem Catálogos da equipe", () => {
    const almoxarife = montada(["almoxarife_sesmt"], 7);
    // ele TEM as permissões — pela concessão do titular, em escopo próprio
    for (const p of ["processo.ver", "treinamento.ver"]) expect(almoxarife.pode(p), p).toBe(true);
    const caminhos = caminhos_da_equipe(almoxarife);
    for (const proibido of ["/kanban", "/processos", "/catalogos", "/servidores", "/turmas", "/treinamentos/catalogo", "/laudos"]) {
      expect(caminhos, proibido).not.toContain(proibido);
    }
    // o trabalho dele continua na lateral
    expect(caminhos).toEqual(expect.arrayContaining(["/epis", "/epis/estoque", "/epis/fichas", "/demandas"]));
  });

  it("e vê o Meu espaço ao lado, com o que é dele", () => {
    const almoxarife = montada(["almoxarife_sesmt"], 7);
    expect(modulos.so_o_proprio(almoxarife)).toBe(false);
    const meu = modulos.meu_espaco_de(almoxarife);
    expect(meu.map((i) => i.rotulo)).toEqual([
      "Início",
      "Meus treinamentos",
      "Meus certificados",
      "Comprovante de treinamentos",
      "Minha ficha de EPI",
      "Pedir EPI",
      // pela concessão do titular: a lateral dele não tem o módulo de acidentes
      "Comunicar acidente",
      "Minhas comunicações",
      "Meu adicional",
      "Meus processos",
      "Minha atividade",
      "Meu perfil",
    ]);
    // "Meus pedidos de EPI" não: para ele `/epis/requisicoes` é a fila do setor,
    // que a lateral já oferece como "Requisições"
    expect(meu.map((i) => i.caminho)).not.toContain("/epis/requisicoes");
    const nav = modulos.navegacao("/turmas/minhas", almoxarife);
    expect(nav.so_meu_espaco).toBe(false);
    expect(nav.meu_espaco).toEqual(meu);
    expect(nav.item_ativo!.rotulo).toBe("Meus treinamentos");
    // e a lateral não repete o que está no bloco
    expect(rotulos_da_equipe(almoxarife)).not.toContain("Minha ficha de EPI");
    expect(rotulos_da_equipe(almoxarife)).not.toContain("Meus treinamentos");
    // a porta da frente continua sendo o trabalho dele
    expect(modulos.primeira_tela(almoxarife)).toBe("/epis");
  });

  it("sem servidor vinculado, o almoxarife não tem Meu espaço", () => {
    const almoxarife = montada(["almoxarife_sesmt"]);
    expect(modulos.meu_espaco_de(almoxarife)).toEqual([]);
    expect(caminhos_da_equipe(almoxarife)).not.toContain("/kanban");
  });

  it("o coordenador ligado a servidor vê os dois, sem item repetido", () => {
    const coordenador = montada(["coordenador_csso"], 7);
    const caminhos = caminhos_da_equipe(coordenador);
    expect(caminhos).toEqual(expect.arrayContaining(["/", "/kanban", "/processos", "/turmas", "/catalogos", "/epis/requisicoes"]));
    const meu = modulos.meu_espaco_de(coordenador);
    expect(meu.map((i) => i.rotulo)).toEqual([
      "Meus treinamentos",
      "Meus certificados",
      "Comprovante de treinamentos",
      "Minha ficha de EPI",
      "Minhas comunicações",
      "Minha atividade",
      "Meu perfil",
    ]);
    // nada do bloco aparece também na lateral
    for (const item of meu) expect(caminhos, item.caminho).not.toContain(item.caminho);
    expect(modulos.primeira_tela(coordenador)).toBe("/");
    // no Painel, a trilha é a da equipe; em Meus certificados, a do Meu espaço
    expect(modulos.navegacao("/", coordenador).item_ativo!.rotulo).toBe("Painel");
    expect(modulos.navegacao("/certificados/meus", coordenador).item_ativo!.rotulo).toBe("Meus certificados");
  });

  it("o servidor comum continua só com o Meu espaço, e entra pelo Início", () => {
    const titular = montada(["servidor_consulta"], 7);
    expect(modulos.so_o_proprio(titular)).toBe(true);
    expect(caminhos_da_equipe(titular)).not.toContain("/kanban");
    expect(modulos.meu_espaco_de(titular).map((i) => i.caminho)[0]).toBe("/");
    expect(modulos.navegacao("/", titular).so_meu_espaco).toBe(true);
    expect(modulos.primeira_tela(titular)).toBe("/");
  });
});
