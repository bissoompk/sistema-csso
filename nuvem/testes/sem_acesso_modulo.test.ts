/**
 * "Sem acesso" esconde o módulo (23/10/2026).
 *
 * O defeito relatado: gravar "Sem acesso" num módulo para um perfil (ou na
 * exceção da pessoa) tirava as permissões do módulo, mas o módulo continuava no
 * menu, no mapa e no seletor — "Instrutores" (`assinatura.gerenciar`) segurava
 * Certificados e Treinamentos, "Importar" (`catalogo.gerenciar`) segurava
 * Processos SEI — e as rotas desses itens, o CSV de EPI e a exportação de
 * processos abriam sem a leitura do módulo.
 *
 * A regra é uma só (`servicos/acesso_modulo.tem_acesso_ao_modulo`): alguma
 * concessão de equipe dá alguma permissão do módulo. Vale a união das
 * concessões; o que é do titular continua no "Meu espaço"; a base
 * compartilhada (Servidores, Catálogos) não depende de Processos SEI.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { CONSULTA, SEM_ACESSO } from "../src/servicos/niveis_modulo.js";
import { MODULOS, base_de, meu_espaco_de, navegacao, primeira_tela, tem_acesso_ao_modulo } from "../src/modulos.js";
import { bancoLimpo, criarUsuario, entrar, usuarioAtual, type AmbienteDeTeste, type Cliente } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
let sup: Cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
  sup = amb.novoCliente();
  await entrar(sup, "sup");
});

async function perfil_id(codigo: string): Promise<number> {
  const [p] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, codigo));
  return p!.id;
}

async function conta_id(login: string): Promise<number> {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

async function no_perfil(perfil: string, modulo: string, nivel: string): Promise<void> {
  const r = await sup.post(`/perfis/${await perfil_id(perfil)}/niveis`, { [`nivel_${modulo}`]: nivel });
  expect(r.status).toBe(200);
  expect(r.text).not.toContain("Nada foi gravado");
}

async function na_pessoa(login: string, modulo: string, nivel: string): Promise<void> {
  const r = await sup.post(`/usuarios/${await conta_id(login)}/niveis`, { [`nivel_${modulo}`]: nivel });
  expect(r.status).toBe(200);
}

async function servidor_novo(siape: string, nome: string): Promise<number> {
  const [s] = await amb.db.insert(e.servidor).values({ siape, nome }).returning();
  return s!.id;
}

const NOME: Record<string, string> = {
  epis: "Gestão de EPI",
  certificados: "Certificados e Treinamentos",
  "processos-sei": "Processos SEI",
};

/** As telas de equipe de cada módulo que a pessoa abriria pela URL. */
const ROTAS: Record<string, string[]> = {
  epis: ["/epis", "/epis/estoque", "/epis/catalogo", "/epis/relatorios", "/epis/relatorios/exportar"],
  certificados: ["/treinamentos", "/turmas", "/certificados", "/treinamentos/assinaturas", "/treinamentos/indicadores"],
  "processos-sei": ["/kanban", "/laudos", "/relatorios", "/relatorios/exportar-processos"],
};

/** O módulo some de toda a navegação desta conta: seletor, lateral, mapa e início. */
async function some_da_navegacao(login: string, cliente: Cliente, modulo: string): Promise<void> {
  const u = await usuarioAtual(amb.db, login);
  expect(tem_acesso_ao_modulo(u, modulo)).toBe(false);
  const m = MODULOS.find((x) => x.codigo === modulo)!;
  expect(m.itens_de(u)).toEqual([]);
  expect(m.grupos_de(u)).toEqual([]);
  for (const caminho of ["/modulos", "/epis/fichas/minha", ...ROTAS[modulo]!]) {
    const nav = navegacao(caminho, u);
    expect(nav.modulo_ativo?.codigo, caminho).not.toBe(modulo);
    if (nav.modulo_ativo) expect(nav.itens_modulo.every((i) => !m.itens.includes(i))).toBe(true);
  }
  const primeira = primeira_tela(u);
  expect(m.itens.some((i) => i.caminho === primeira && !i.do_titular), primeira).toBe(false);
  // o mapa e a lateral, como a pessoa os recebe
  const mapa = await cliente.get("/modulos");
  expect(mapa.status).toBe(200);
  expect(mapa.text).not.toContain(`id="${modulo}"`);
  expect(mapa.text).not.toContain(`data-rotulo="${NOME[modulo]}"`);
  expect(mapa.text).toContain("sem\n    acesso");
}

async function rotas_fechadas(cliente: Cliente, modulo: string, exceto: readonly string[] = []): Promise<void> {
  for (const caminho of ROTAS[modulo]!.filter((x) => !exceto.includes(x))) {
    const r = await cliente.get(caminho, { seguir: false });
    expect(r.status, caminho).toBe(403);
  }
}

describe("sem acesso no perfil", () => {
  for (const modulo of ["epis", "certificados", "processos-sei"]) {
    it(`${modulo}: o módulo some do menu, do mapa e do início, e as rotas dão 403 (técnico)`, async () => {
      await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
      const tec = amb.novoCliente();
      await entrar(tec, "tec");
      expect(tem_acesso_ao_modulo(await usuarioAtual(amb.db, "tec"), modulo)).toBe(true);
      expect((await tec.get("/modulos")).text).toContain(`id="${modulo}"`);

      await no_perfil("tecnico_seguranca", modulo, SEM_ACESSO);
      await some_da_navegacao("tec", tec, modulo);
      await rotas_fechadas(tec, modulo);
      // o /inicio leva a outro módulo, e não a uma porta trancada
      const inicio = await tec.get("/inicio");
      expect(inicio.status).toBe(200);
      // os outros módulos seguem o perfil
      for (const outro of ["epis", "certificados", "processos-sei"].filter((x) => x !== modulo)) {
        expect(tem_acesso_ao_modulo(await usuarioAtual(amb.db, "tec"), outro), outro).toBe(true);
      }
    });
  }

  it("certificados: o engenheiro perde também Instrutores, que vinha só de assinatura.gerenciar", async () => {
    await criarUsuario(amb.db, { login: "eng", perfis: ["engenheiro_seguranca"] });
    const eng = amb.novoCliente();
    await entrar(eng, "eng");
    expect((await eng.get("/treinamentos/assinaturas")).status).toBe(200);
    await no_perfil("engenheiro_seguranca", "certificados", SEM_ACESSO);
    const u = await usuarioAtual(amb.db, "eng");
    expect(u.pode("assinatura.gerenciar")).toBe(true); // do perfil, transversal
    await some_da_navegacao("eng", eng, "certificados");
    expect((await eng.get("/treinamentos/assinaturas")).status).toBe(403);
    expect((await eng.post("/treinamentos/assinaturas", { nome: "Fulano" })).status).toBe(403);
  });

  it("processos-sei: o coordenador perde também Importar, que vinha só de catalogo.gerenciar", async () => {
    await criarUsuario(amb.db, { login: "coord", perfis: ["coordenador_csso"] });
    const coord = amb.novoCliente();
    await entrar(coord, "coord");
    expect((await coord.get("/importar")).status).toBe(200);
    await no_perfil("coordenador_csso", "processos-sei", SEM_ACESSO);
    expect((await usuarioAtual(amb.db, "coord")).pode("catalogo.gerenciar")).toBe(true);
    await some_da_navegacao("coord", coord, "processos-sei");
    for (const caminho of ["/importar", "/importar/reconciliacao", "/importar/reconciliacao.csv", "/processos"]) {
      expect((await coord.get(caminho)).status, caminho).toBe(403);
    }
  });

  it("epis: o almoxarife, que só tem EPI, fica sem módulo nenhum e sem a base", async () => {
    await criarUsuario(amb.db, { login: "alm", perfis: ["almoxarife_sesmt"] });
    const alm = amb.novoCliente();
    await entrar(alm, "alm");
    await no_perfil("almoxarife_sesmt", "epis", SEM_ACESSO);
    await some_da_navegacao("alm", alm, "epis");
    await rotas_fechadas(alm, "epis");
    const u = await usuarioAtual(amb.db, "alm");
    expect(MODULOS.filter((m) => m.disponivel && m.itens_de(u).length)).toEqual([]);
    // o /inicio cai na base que sobra (as pendências, pela `demanda.ver`), não no EPI
    const inicio = await alm.get("/inicio");
    expect(inicio.url).not.toContain("/epis");
  });
});

describe("sem acesso na exceção da pessoa", () => {
  for (const modulo of ["epis", "certificados", "processos-sei"]) {
    it(`${modulo}: some só para aquela conta; a colega do mesmo perfil continua com ele`, async () => {
      await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
      await criarUsuario(amb.db, { login: "tec2", perfis: ["tecnico_seguranca"] });
      const tec = amb.novoCliente();
      await entrar(tec, "tec");
      await na_pessoa("tec", modulo, SEM_ACESSO);
      await some_da_navegacao("tec", tec, modulo);
      await rotas_fechadas(tec, modulo);
      const colega = await usuarioAtual(amb.db, "tec2");
      expect(tem_acesso_ao_modulo(colega, modulo)).toBe(true);
      expect(MODULOS.find((m) => m.codigo === modulo)!.itens_de(colega).length).toBeGreaterThan(0);
      // seguir o perfil devolve
      await na_pessoa("tec", modulo, "PADRAO");
      expect(tem_acesso_ao_modulo(await usuarioAtual(amb.db, "tec"), modulo)).toBe(true);
      expect((await tec.get(ROTAS[modulo]![0]!)).status).toBe(200);
    });
  }

  it("a exceção que dá (consulta) faz o módulo aparecer", async () => {
    await criarUsuario(amb.db, { login: "alm", perfis: ["almoxarife_sesmt"] });
    expect(tem_acesso_ao_modulo(await usuarioAtual(amb.db, "alm"), "processos-sei")).toBe(false);
    await na_pessoa("alm", "processos-sei", CONSULTA);
    const u = await usuarioAtual(amb.db, "alm");
    expect(tem_acesso_ao_modulo(u, "processos-sei")).toBe(true);
    expect(MODULOS.find((m) => m.codigo === "processos-sei")!.itens_de(u).map((i) => i.caminho)).toContain("/processos");
  });
});

describe("união das concessões", () => {
  it("dois perfis: sem acesso em um, o outro ainda dá o módulo", async () => {
    await criarUsuario(amb.db, { login: "dupla", perfis: ["tecnico_seguranca", "almoxarife_sesmt"] });
    const dupla = amb.novoCliente();
    await entrar(dupla, "dupla");
    await no_perfil("tecnico_seguranca", "epis", SEM_ACESSO);
    const u = await usuarioAtual(amb.db, "dupla");
    expect(tem_acesso_ao_modulo(u, "epis")).toBe(true);
    expect((await dupla.get("/epis/estoque")).status).toBe(200);
    expect((await dupla.get("/modulos")).text).toContain('id="epis"');
    // e quando os dois perfis estão sem acesso, some
    await no_perfil("almoxarife_sesmt", "epis", SEM_ACESSO);
    await some_da_navegacao("dupla", dupla, "epis");
  });

  it("a exceção da pessoa vale para todas as concessões dela", async () => {
    await criarUsuario(amb.db, { login: "dupla", perfis: ["tecnico_seguranca", "almoxarife_sesmt"] });
    const dupla = amb.novoCliente();
    await entrar(dupla, "dupla");
    await na_pessoa("dupla", "epis", SEM_ACESSO);
    await some_da_navegacao("dupla", dupla, "epis");
    await rotas_fechadas(dupla, "epis");
  });
});

describe("o que é do titular fica no Meu espaço", () => {
  it("epis: a própria ficha e os próprios pedidos continuam, o módulo não", async () => {
    const sid = await servidor_novo("7001001", "Técnica Titular");
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"], servidor_id: sid });
    const tec = amb.novoCliente();
    await entrar(tec, "tec");
    await no_perfil("tecnico_seguranca", "epis", SEM_ACESSO);
    await some_da_navegacao("tec", tec, "epis");
    // `/epis` abre o painel PESSOAL (o EPI dele, pela concessão do titular) e o
    // catálogo em leitura abre como para qualquer servidor (não nomeia
    // ninguém); as telas da equipe fecham. Nenhuma das duas está no menu.
    await rotas_fechadas(tec, "epis", ["/epis", "/epis/catalogo"]);
    const pessoal = await tec.get("/epis");
    expect(pessoal.status).toBe(200);
    const u = await usuarioAtual(amb.db, "tec");
    const meu = meu_espaco_de(u).map((i) => i.caminho);
    expect(meu).toEqual(expect.arrayContaining(["/epis/fichas/minha", "/epis/requisicoes", "/epis/requisicoes/nova"]));
    expect((await tec.get("/epis/fichas/minha")).status).toBe(200);
    expect((await tec.get("/epis/requisicoes")).status).toBe(200);
  });

  it("certificados: os próprios treinamentos e certificados continuam", async () => {
    const sid = await servidor_novo("7001002", "Engenheiro Titular");
    await criarUsuario(amb.db, { login: "eng", perfis: ["engenheiro_seguranca"], servidor_id: sid });
    const eng = amb.novoCliente();
    await entrar(eng, "eng");
    await na_pessoa("eng", "certificados", SEM_ACESSO);
    await some_da_navegacao("eng", eng, "certificados");
    const meu = meu_espaco_de(await usuarioAtual(amb.db, "eng")).map((i) => i.caminho);
    expect(meu).toEqual(expect.arrayContaining(["/turmas/minhas", "/certificados/meus"]));
    expect((await eng.get("/turmas/minhas")).status).toBe(200);
    expect((await eng.get("/certificados/meus")).status).toBe(200);
  });

  it("processos-sei: o Início e os próprios processos continuam; exportar, não", async () => {
    const sid = await servidor_novo("7001003", "Técnico Titular");
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"], servidor_id: sid });
    const tec = amb.novoCliente();
    await entrar(tec, "tec");
    await no_perfil("tecnico_seguranca", "processos-sei", SEM_ACESSO);
    await some_da_navegacao("tec", tec, "processos-sei");
    const meu = meu_espaco_de(await usuarioAtual(amb.db, "tec")).map((i) => i.caminho);
    expect(meu).toEqual(expect.arrayContaining(["/", "/processos", "/adicionais"]));
    expect((await tec.get("/")).status).toBe(200);
    const lista = await tec.get("/processos");
    expect(lista.status).toBe(200);
    expect(lista.text).not.toContain("/relatorios/exportar-processos");
    expect((await tec.get("/relatorios/exportar-processos")).status).toBe(403);
  });
});

describe("a base compartilhada não depende de Processos SEI", () => {
  it("sem Processos SEI, o técnico continua com Servidores e Catálogos, sem os processos da ficha", async () => {
    const outro = await servidor_novo("7001004", "Servidora Qualquer");
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    const tec = amb.novoCliente();
    await entrar(tec, "tec");
    const antes = await tec.get(`/servidores/${outro}`);
    expect(antes.text).toContain("<h2>Processos</h2>");
    await no_perfil("tecnico_seguranca", "processos-sei", SEM_ACESSO);
    const u = await usuarioAtual(amb.db, "tec");
    expect(u.pode("processo.ver")).toBe(false);
    expect(base_de(u).map((i) => i.caminho)).toEqual(expect.arrayContaining(["/servidores", "/catalogos"]));
    expect((await tec.get("/servidores")).status).toBe(200);
    expect((await tec.get("/catalogos")).status).toBe(200);
    expect((await tec.get("/catalogos/campi")).status).toBe(200);
    const ficha = await tec.get(`/servidores/${outro}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("Servidora Qualquer");
    expect(ficha.text).not.toContain("<h2>Processos</h2>");
    expect(ficha.text).not.toContain("<h2>Pareceres</h2>");
    // a API não ganha a permissão derivada
    expect([...u.permissoes].some((p) => p.startsWith("@"))).toBe(false);
  });

  it("quem não lia a base continua sem ela; sem módulo nenhum, a base fecha", async () => {
    await criarUsuario(amb.db, { login: "alm", perfis: ["almoxarife_sesmt"] });
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    const alm = amb.novoCliente();
    await entrar(alm, "alm");
    expect((await alm.get("/catalogos")).status).toBe(403);
    expect((await alm.get("/servidores")).status).toBe(403);
    for (const modulo of ["processos-sei", "epis", "certificados"]) await na_pessoa("tec", modulo, SEM_ACESSO);
    const tec = amb.novoCliente();
    await entrar(tec, "tec");
    expect(base_de(await usuarioAtual(amb.db, "tec")).map((i) => i.caminho)).not.toContain("/servidores");
    expect((await tec.get("/catalogos")).status).toBe(403);
    expect((await tec.get("/servidores")).status).toBe(403);
  });
});

describe("a tela de níveis diz o efeito", () => {
  it("perfil e pessoa explicam o que é Sem acesso e a soma dos perfis", async () => {
    const tela = await sup.get("/perfis/niveis?perfil=tecnico_seguranca");
    expect(tela.text).toContain("o módulo some do menu");
    expect(tela.text).toContain("vale a soma dos perfis");
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    const usuarios = await sup.get("/usuarios");
    expect(usuarios.text).toContain("aqui vale para todos os perfis");
  });
});
