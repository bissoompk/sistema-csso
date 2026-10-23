/**
 * NUVEM (Início com os cartões dos módulos, 23/10/2026): a Visão geral em
 * `/inicio` — a `#home-view` do IntegraSST. Cada conta vê o cartão dos módulos
 * que abre (o mesmo filtro da lateral), os previstos aparecem bloqueados e sem
 * link, o selo conta o que espera no módulo, e o titular puro continua indo
 * para o Início do portal dele.
 */
import { describe, expect, it } from "vitest";
import { asc, eq, isNotNull } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as modulos from "../src/modulos.js";
import { observarConsultas } from "../src/db/cliente.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, PERFIS_DE_TESTE, SENHA_TESTE, usuarioAtual } from "./ajuda";

const { novoCliente, db } = await bancoLimpo();
await naTransacao((tx) => contas(tx));

/** A Visão geral de uma conta (exige o 200). */
async function _visao(login: string): Promise<string> {
  const cliente = await entrar(novoCliente(), login);
  const r = await cliente.get("/inicio", { seguir: false });
  expect(r.status, login).toBe(200);
  return r.text;
}

/** Só o conteúdo da tela, sem a lateral (que também tem links de módulo). */
function _conteudo(html: string): string {
  const i = html.indexOf('<div class="tela visao-geral">');
  expect(i, "a tela da Visão geral").toBeGreaterThan(-1);
  return html.slice(i, html.indexOf("</main>", i));
}

/** Os códigos dos cartões grandes, na ordem da tela. */
function _cartoes(html: string): string[] {
  return [..._conteudo(html).matchAll(/<section class="cartao-mod mod-([a-z-]+)"/g)].map((m) => m[1]!);
}

/** O HTML de um cartão pelo código. */
function _cartao(html: string, codigo: string): string {
  const corpo = _conteudo(html);
  const i = corpo.indexOf(`<section class="cartao-mod mod-${codigo}"`);
  expect(i, `cartão ${codigo}`).toBeGreaterThan(-1);
  return corpo.slice(i, corpo.indexOf("</section>", i));
}

/** Os previstos (a lista de baixo). */
function _previstos(html: string): string {
  const corpo = _conteudo(html);
  const i = corpo.indexOf('<ul class="grade-modulos previstos"');
  expect(i, "a seção dos previstos").toBeGreaterThan(-1);
  return corpo.slice(i, corpo.indexOf("</ul>", i));
}

describe("Visão geral: quem vê qual cartão", () => {
  it.each([
    ["coordenador_csso", ["processos-sei", "epis", "certificados", "demandas"]],
    ["superintendente", ["processos-sei", "epis", "certificados", "demandas", "administracao"]],
    ["almoxarife_sesmt", ["epis", "demandas"]],
    ["consulta_progep", ["processos-sei", "epis", "certificados"]],
    ["admin_ti", ["administracao"]],
  ])("%s vê os cartões %j", async (login, esperados) => {
    expect(_cartoes(await _visao(login))).toEqual(esperados);
  });

  it("cada conta de equipe vê exatamente os módulos que a lateral oferece, e cada botão abre", async () => {
    for (const [login] of PERFIS_DE_TESTE) {
      if (login === "servidor_consulta") continue;
      const usuario = await usuarioAtual(db, login);
      const html = await _visao(login);
      const vistos = new Set(_cartoes(html));
      for (const m of modulos.MODULOS.filter((x) => x.disponivel)) {
        expect(vistos.has(m.codigo), `${login}: ${m.codigo}`).toBe(m.itens_de(usuario).length > 0);
        if (vistos.has(m.codigo)) {
          expect(_cartao(html, m.codigo), `${login}: ${m.codigo}`).toContain(
            `class="cartao-mod-botao" href="${modulos.porta_de_entrada(m, usuario)}"`,
          );
        }
      }
      const cliente = await entrar(novoCliente(), login);
      for (const [, destino] of _conteudo(html).matchAll(/class="cartao-mod-botao" href="([^"]+)"/g)) {
        const r = await cliente.get(destino!, { cabecalhos: { accept: "text/html" } });
        expect(r.status, `${login} → ${destino}`).toBe(200);
      }
    }
  });

  it("'Sem acesso' a EPI na exceção da pessoa tira o cartão de EPI", async () => {
    const conta = await naTransacao((tx) => criarUsuario(tx, { login: "coord_sem_epi", perfis: ["coordenador_csso"] }));
    expect(_cartoes(await _visao("coord_sem_epi"))).toContain("epis");
    await db.insert(e.usuario_nivel_modulo).values({ usuario_id: conta.id, modulo: "epis", nivel: "SEM_ACESSO" });
    const html = await _visao("coord_sem_epi");
    expect(_cartoes(html)).toEqual(["processos-sei", "certificados", "demandas"]);
    expect(_conteudo(html)).not.toContain('href="/epis');
  });

  it("'Sem acesso' a EPI no perfil tira o cartão de EPI de quem tem o perfil", async () => {
    await naTransacao((tx) => criarUsuario(tx, { login: "almox_sem_epi", perfis: ["almoxarife_sesmt"] }));
    const [perfil] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "almoxarife_sesmt"));
    await db.insert(e.perfil_nivel_modulo).values({ perfil_id: perfil!.id, modulo: "epis", nivel: "SEM_ACESSO" });
    try {
      expect(_cartoes(await _visao("almox_sem_epi"))).toEqual(["demandas"]);
    } finally {
      await db.delete(e.perfil_nivel_modulo).where(eq(e.perfil_nivel_modulo.perfil_id, perfil!.id));
    }
  });

  it("'Sem acesso' a Processos SEI tira o cartão mesmo com tela transversal no menu (Importar, catalogo.gerenciar)", async () => {
    const conta = await naTransacao((tx) => criarUsuario(tx, { login: "coord_sem_sei", perfis: ["coordenador_csso"] }));
    await db.insert(e.usuario_nivel_modulo).values({ usuario_id: conta.id, modulo: "processos-sei", nivel: "SEM_ACESSO" });
    const usuario = await usuarioAtual(db, "coord_sem_sei");
    expect(usuario.pode("processo.ver")).toBe(false);
    const html = await _visao("coord_sem_sei");
    expect(_cartoes(html)).not.toContain("processos-sei");
    expect(_cartoes(html)).toEqual(["epis", "certificados", "demandas"]);
  });

  it("a saudação usa o primeiro nome, e a tela leva ao mapa das telas", async () => {
    const html = await _visao("coordenador_csso");
    expect(html).toContain("Bem-vindo(a) ao Sistema SISA, Coordenador</h1>");
    expect(_conteudo(html)).toContain('href="/modulos"');
    expect(_conteudo(html)).toContain("Ver todas as telas");
    expect(_conteudo(html)).toContain("Acessar módulo");
    // o /modulos continua abrindo
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    expect((await cliente.get("/modulos")).status).toBe(200);
  });

  it("a lateral tem a Visão geral, marcada como a tela atual", async () => {
    const html = await _visao("almoxarife_sesmt");
    const lateral = html.slice(html.indexOf('<aside class="lateral">'), html.indexOf("</aside>"));
    expect(lateral).toMatch(/<a href="\/inicio" class="modulo atual" aria-current="page" data-rotulo="Visão geral">/);
    // a trilha não diz "Gestão de EPI"
    expect(html).toMatch(/<nav class="trilha"[^>]*>\s*<a href="\/inicio">Visão geral<\/a>/);
    // e em outra tela a Visão geral continua no menu, sem o destaque
    const cliente = await entrar(novoCliente(), "almoxarife_sesmt");
    const epis = (await cliente.get("/epis")).text;
    expect(epis).toMatch(/<a href="\/inicio" class="modulo "\s+data-rotulo="Visão geral">/);
  });

  it("sem style= e sem script na tela (CSP)", async () => {
    const corpo = _conteudo(await _visao("superintendente"));
    expect(corpo).not.toMatch(/\sstyle=/);
    expect(corpo).not.toContain("<script");
    expect(corpo).not.toContain("onclick");
  });
});

describe("Visão geral: os módulos previstos", () => {
  it("aparecem bloqueados, cinza, com cadeado e sem link", async () => {
    const html = await _visao("coordenador_csso");
    const previstos = _previstos(html);
    expect(_conteudo(html)).toContain("Outros módulos (em desenvolvimento)");
    for (const m of modulos.MODULOS.filter((x) => !x.disponivel)) {
      expect(previstos, m.codigo).toContain(`<h3>${m.nome}</h3>`);
    }
    expect(previstos).toContain("Análise de Acidentes");
    expect(previstos).toContain("CISSP");
    expect(previstos).toContain("PGR");
    expect(previstos).not.toContain("<a ");
    expect(previstos.replace(/<use href="[^"]*">/g, "")).not.toContain("href=");
    expect(previstos).toContain('class="cartao-mod previsto"');
    expect(previstos).toContain("icones.svg#lock");
    // "em desenvolvimento" escrito, para quem não vê a cor nem o cadeado
    const n = modulos.MODULOS.filter((x) => !x.disponivel).length;
    expect(previstos.split("Em desenvolvimento — ainda não disponível").length - 1).toBe(n);
    // e nenhum cartão grande de módulo previsto
    for (const m of modulos.MODULOS.filter((x) => !x.disponivel)) {
      expect(_cartoes(html)).not.toContain(m.codigo);
    }
  });
});

describe("Visão geral: os selos de pendência", () => {
  it("o cartão de EPI mostra os pedidos a analisar, e só quando há", async () => {
    const antes = _cartao(await _visao("coordenador_csso"), "epis");
    expect(antes).not.toContain('class="selo-mod"');
    expect(antes).not.toContain("a analisar");

    await naTransacao(async (tx) => {
      const [unidade] = await tx
        .select({ id: e.unidade_uorg.id, campus_id: e.unidade_uorg.campus_id })
        .from(e.unidade_uorg)
        .where(isNotNull(e.unidade_uorg.campus_id))
        .orderBy(asc(e.unidade_uorg.id))
        .limit(1);
      const [servidor] = await tx
        .insert(e.servidor)
        .values({ siape: "7712001", nome: "Servidora do Pedido", unidade_uorg_id: unidade!.id })
        .returning();
      const [coord] = await tx.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
      for (const [numero, estado] of [[9101, "ENVIADA"], [9102, "ENVIADA"], [9103, "EM_ANALISE"], [9104, "ANALISADA"]] as const) {
        await tx.insert(e.epi_requisicao).values({
          servidor_id: servidor!.id,
          solicitado_por_id: coord!.id,
          campus_id: unidade!.campus_id,
          estado,
          protocolo: `EPI-2026-${numero}`,
          numero,
          ano: 2026,
          enviada_em: new Date(),
          termo_exigido: false,
        });
      }
    });

    const depois = _cartao(await _visao("coordenador_csso"), "epis");
    expect(depois).toContain('<span class="selo-mod" aria-hidden="true">3</span>');
    expect(depois).toContain("3 pedidos a analisar");
    // o almoxarife não analisa pedido: o selo dele não conta pedido
    const almox = _cartao(await _visao("almoxarife_sesmt"), "epis");
    expect(almox).not.toContain("a analisar");
  });

  it("o cartão de Processos SEI conta as pendências da pessoa", async () => {
    const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await db.insert(e.pendencia).values({
      tipo: "INCLUIR_NO_SEI",
      descricao: "Incluir o parecer assinado no SEI",
      responsavel_id: coord!.id,
      chave: "teste-home-incluir-no-sei",
    });
    const html = await _visao("coordenador_csso");
    const cartao = _cartao(html, "processos-sei");
    expect(cartao).toContain('<span class="selo-mod" aria-hidden="true">1</span>');
    expect(cartao).toContain("1 pendência sua");
    // a pendência de processo não vai para o selo de EPI
    expect(_cartao(html, "epis")).not.toContain("pendência sua");
    // nem para o de outra pessoa
    expect(_cartao(await _visao("superintendente"), "processos-sei")).not.toContain('class="selo-mod"');
  });

  it("a Visão geral fica em poucas idas ao banco", async () => {
    const cliente = await entrar(novoCliente(), "superintendente");
    const vistas: string[] = [];
    observarConsultas((q) => vistas.push(q));
    try {
      expect((await cliente.get("/inicio", { seguir: false })).status).toBe(200);
    } finally {
      observarConsultas(null);
    }
    expect(vistas.length).toBeLessThanOrEqual(12);
  });
});

describe("Visão geral: a porta de entrada", () => {
  it("o login leva à Visão geral", async () => {
    for (const login of ["coordenador_csso", "almoxarife_sesmt", "superintendente"]) {
      const cliente = novoCliente();
      const r = await cliente.post("/login", { login, senha: SENHA_TESTE }, { seguir: false });
      expect(r.status, login).toBe(303);
      expect(r.location, login).toBe("/inicio");
      expect((await cliente.get("/inicio", { seguir: false })).status, login).toBe(200);
    }
  });

  it("o titular puro continua no Início do portal dele", async () => {
    const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "7712002", nome: "Titular da Visão Geral", unidade_uorg_id: unidade!.id })
      .returning();
    await db.update(e.usuario).set({ servidor_id: servidor!.id }).where(eq(e.usuario.login, "servidor_consulta"));
    try {
      const cliente = await entrar(novoCliente(), "servidor_consulta");
      const r = await cliente.get("/inicio", { seguir: false });
      expect(r.status).toBe(303);
      expect(r.location).toBe("/");
      const inicio = await cliente.get("/");
      expect(inicio.status).toBe(200);
      expect(inicio.text).not.toContain('class="tela visao-geral"');
      // a lateral dele é o Meu espaço, sem a Visão geral da equipe
      const lateral = inicio.text.slice(inicio.text.indexOf('<aside class="lateral">'), inicio.text.indexOf("</aside>"));
      expect(lateral).not.toContain("Visão geral");
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.login, "servidor_consulta"));
    }
  });

  it("a conta de equipe ligada a servidor ganha o cartão Meu espaço", async () => {
    const [unidade] = await db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "7712003", nome: "Almoxarife da Visão Geral", unidade_uorg_id: unidade!.id })
      .returning();
    await db.update(e.usuario).set({ servidor_id: servidor!.id }).where(eq(e.usuario.login, "almoxarife_sesmt"));
    try {
      const html = await _visao("almoxarife_sesmt");
      expect(_cartoes(html)).toEqual(["epis", "demandas", "meu-espaco"]);
      const usuario = await usuarioAtual(db, "almoxarife_sesmt");
      expect(_cartao(html, "meu-espaco")).toContain(`href="${modulos.meu_espaco_de(usuario)[0]!.caminho}"`);
    } finally {
      await db.update(e.usuario).set({ servidor_id: null }).where(eq(e.usuario.login, "almoxarife_sesmt"));
    }
  });

  it("/inicio sem sessão vai ao login", async () => {
    const r = await novoCliente().get("/inicio", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });
});
