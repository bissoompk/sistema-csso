/**
 * Liberação de módulo por módulo (22/10/2026): nível por perfil, exceção por
 * pessoa, ninguém eleva o próprio acesso, a implantação não muda nada e o
 * semeio de cada deploy não desfaz o ajuste da coordenação.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import {
  CONCESSAO_DO_TITULAR,
  MATRIZ_PERFIS,
  PERMISSOES,
  aceita_nivel_modulo,
  carregar_usuario_atual,
} from "../src/servicos/rbac.js";
import {
  CONSULTA,
  MODULOS_NIVELADOS,
  OPERACAO,
  PARCIAL,
  PERMISSOES_SO_DO_PERFIL,
  SEM_ACESSO,
  modulo_nivelado,
  nivel_lido,
  permissoes_com_niveis,
  permissoes_do_modulo,
} from "../src/servicos/niveis_modulo.js";
import { semear_rbac } from "../src/servicos/sementes.js";
import { navegacao } from "../src/modulos.js";
import { bancoLimpo, criarUsuario, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
});

async function perfil_id(codigo: string): Promise<number> {
  const [p] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, codigo));
  return p!.id;
}

async function conta_id(login: string): Promise<number> {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

async function eventos(tipo: string) {
  return amb.db
    .select()
    .from(e.historico_evento)
    .where(eq(e.historico_evento.tipo_evento, tipo))
    .orderBy(desc(e.historico_evento.id));
}

/** As permissões que vêm dos perfis (sem a concessão do titular). */
async function do_perfil(login: string): Promise<string[]> {
  const u = await carregar_usuario_atual(amb.db, await conta_id(login));
  return [
    ...new Set(u.concessoes!.filter((c) => c.perfil !== CONCESSAO_DO_TITULAR).flatMap((c) => [...c.permissoes])),
  ]
    // a base derivada (`@base`, 23/10/2026) não é permissão do banco
    .filter((p) => !p.startsWith("@"))
    .sort();
}

describe("o mapa", () => {
  it("toda permissão está num módulo ou entre as só do perfil, nunca nos dois", () => {
    const niveladas = MODULOS_NIVELADOS.flatMap((m) => permissoes_do_modulo(m));
    expect(new Set(niveladas).size).toBe(niveladas.length);
    for (const p of Object.keys(PERMISSOES)) {
      const no_modulo = niveladas.includes(p);
      const so_perfil = Object.hasOwn(PERMISSOES_SO_DO_PERFIL, p);
      expect(no_modulo !== so_perfil, p).toBe(true);
    }
  });

  it("assinatura, habilitação e administração de acesso nunca se liberam por módulo", () => {
    for (const p of ["parecer.assinar", "laudo.criar", "assinatura.gerenciar", "perfil.conceder", "habilitacao.atestar"]) {
      expect(Object.hasOwn(PERMISSOES_SO_DO_PERFIL, p), p).toBe(true);
    }
    const tudo = permissoes_com_niveis([], {}, { "processos-sei": OPERACAO, epis: OPERACAO, certificados: OPERACAO, demandas: OPERACAO });
    for (const p of Object.keys(PERMISSOES_SO_DO_PERFIL)) expect(tudo).not.toContain(p);
  });

  it("o padrão (sem nível gravado) reproduz exatamente as permissões de cada perfil da matriz", () => {
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      expect(permissoes_com_niveis(dados.permissoes).sort(), codigo).toEqual([...new Set(dados.permissoes)].sort());
    }
  });

  it("o nível lido do padrão: consulta, operação, parcial e sem acesso", () => {
    const cert = modulo_nivelado("certificados")!;
    expect(nivel_lido(MATRIZ_PERFIS.consulta_progep!.permissoes, cert)).toBe(CONSULTA);
    expect(nivel_lido(MATRIZ_PERFIS.coordenador_csso!.permissoes, cert)).toBe(OPERACAO);
    expect(nivel_lido(MATRIZ_PERFIS.tecnico_seguranca!.permissoes, cert)).toBe(PARCIAL);
    expect(nivel_lido(MATRIZ_PERFIS.almoxarife_sesmt!.permissoes, cert)).toBe(SEM_ACESSO);
  });

  it("a exceção da pessoa passa por cima do nível do perfil", () => {
    const cruas = MATRIZ_PERFIS.tecnico_seguranca!.permissoes;
    const com = permissoes_com_niveis(cruas, { epis: CONSULTA }, { epis: SEM_ACESSO });
    expect(com).not.toContain("epi.ver");
    expect(com).toContain("processo.ver");
    const dada = permissoes_com_niveis(MATRIZ_PERFIS.almoxarife_sesmt!.permissoes, {}, { "processos-sei": CONSULTA });
    expect(dada).toEqual(expect.arrayContaining(["processo.ver", "parecer.ver", "laudo.ver", "epi.estoque"]));
    expect(dada).not.toContain("processo.criar");
  });
});

describe("a implantação não muda o acesso de ninguém", () => {
  it("cada perfil semeado carrega exatamente as permissões gravadas em perfil_permissao", async () => {
    for (const codigo of Object.keys(MATRIZ_PERFIS)) {
      await criarUsuario(amb.db, { login: `p-${codigo}`, perfis: [codigo] });
      const gravadas = (
        await amb.db
          .select({ codigo: e.permissao.codigo })
          .from(e.perfil_permissao)
          .innerJoin(e.permissao, eq(e.permissao.id, e.perfil_permissao.permissao_id))
          .innerJoin(e.perfil, eq(e.perfil.id, e.perfil_permissao.perfil_id))
          .where(eq(e.perfil.codigo, codigo))
      )
        .map((l) => l.codigo)
        .sort();
      expect(await do_perfil(`p-${codigo}`), codigo).toEqual(gravadas);
    }
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
  });
});

describe("nível por perfil", () => {
  beforeEach(async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "sec", perfis: ["secretaria_csso"] });
  });

  it("consulta esconde as ações de escrita e o POST dá 403; a trilha registra módulo, anterior e novo", async () => {
    await entrar(amb.cliente, "sec");
    expect((await amb.cliente.get("/demandas")).text).toContain('href="#nova-demanda"');

    const sup = amb.novoCliente();
    await entrar(sup, "sup");
    const r = await sup.post(`/perfis/${await perfil_id("secretaria_csso")}/niveis`, { nivel_demandas: CONSULTA });
    expect(r.status).toBe(200);
    expect(r.url).toContain("/perfis/niveis?perfil=secretaria_csso");

    const tela = await amb.cliente.get("/demandas");
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain('href="#nova-demanda"');
    const post = await amb.cliente.post("/demandas", { assunto: "x", canal: "EMAIL", solicitante_nome: "Fulano" });
    expect(post.status).toBe(403);

    const [ev] = await eventos("NIVEL_MODULO_PERFIL_ALTERADO");
    expect(ev!.entidade).toBe("perfil");
    expect(ev!.entidade_id).toBe(await perfil_id("secretaria_csso"));
    expect(ev!.campo).toBe("modulo:demandas");
    expect(ev!.valor_anterior).toBe("PADRAO");
    expect(ev!.valor_novo).toBe(CONSULTA);
    expect(ev!.descricao).toContain("Demandas");
  });

  it("sem acesso tira o módulo do menu e fecha as rotas, inclusive o relatório do módulo", async () => {
    await criarUsuario(amb.db, { login: "coord", perfis: ["coordenador_csso"] });
    const sup = amb.novoCliente();
    await entrar(sup, "sup");
    await sup.post(`/perfis/${await perfil_id("coordenador_csso")}/niveis`, { "nivel_processos-sei": SEM_ACESSO });
    await entrar(amb.cliente, "coord");
    expect((await amb.cliente.get("/processos")).status).toBe(403);
    expect((await amb.cliente.get("/relatorios")).status).toBe(403);
    const u = await carregar_usuario_atual(amb.db, await conta_id("coord"));
    expect(u.pode("indicador.ver")).toBe(true); // transversal, do perfil
    expect(u.pode("processo.ver")).toBe(false);
    const nav = navegacao("/epis", u);
    const caminhos = nav.modulos.flatMap((m) => m.itens_de(u).map((i) => i.caminho));
    expect(caminhos).not.toContain("/processos");
    expect(caminhos).not.toContain("/relatorios");
    expect(caminhos).toContain("/epis/relatorios");
    // o perfil volta ao padrão
    await sup.post(`/perfis/${await perfil_id("coordenador_csso")}/niveis`, { "nivel_processos-sei": "PADRAO" });
    expect((await amb.cliente.get("/processos")).status).toBe(200);
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
  });

  it("só quem administra acesso grava; a tela abre para quem lê a matriz", async () => {
    await criarUsuario(amb.db, { login: "coord", perfis: ["coordenador_csso"] });
    await entrar(amb.cliente, "coord");
    const tela = await amb.cliente.get("/perfis/niveis?perfil=tecnico_seguranca");
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain('type="radio"');
    // a lateral da casca continua com os módulos (o contexto não sobrepõe `modulos`)
    expect(tela.text).toContain('class="modulo ');
    const r = await amb.cliente.post(`/perfis/${await perfil_id("tecnico_seguranca")}/niveis`, { nivel_epis: OPERACAO });
    expect(r.status).toBe(403);
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
  });

  it("ninguém sobe o nível do próprio perfil; baixar pode", async () => {
    await criarUsuario(amb.db, { login: "sup2", perfis: ["superintendente"] });
    const sup2 = amb.novoCliente();
    await entrar(sup2, "sup2");
    const id = await perfil_id("superintendente");
    // outra pessoa baixa; o próprio dono não sobe de volta
    expect((await sup2.post(`/perfis/${id}/niveis`, { nivel_demandas: CONSULTA })).status).toBe(200);
    await entrar(amb.cliente, "sup");
    const tela = await amb.cliente.get("/perfis/niveis?perfil=superintendente");
    expect(tela.text).toContain("Você tem este perfil");
    const r = await amb.cliente.post(`/perfis/${id}/niveis`, { nivel_demandas: OPERACAO });
    expect(r.status).toBe(200);
    expect(r.text).toContain("elevaria o seu próprio acesso");
    const [linha] = await amb.db.select().from(e.perfil_nivel_modulo).where(eq(e.perfil_nivel_modulo.perfil_id, id));
    expect(linha!.nivel).toBe(CONSULTA);
    // baixar o próprio continua possível
    expect((await amb.cliente.post(`/perfis/${id}/niveis`, { nivel_demandas: SEM_ACESSO })).status).toBe(200);
    const [depois] = await amb.db.select().from(e.perfil_nivel_modulo).where(eq(e.perfil_nivel_modulo.perfil_id, id));
    expect(depois!.nivel).toBe(SEM_ACESSO);
  });

  it("a recusa de um módulo desfaz os outros do mesmo envio", async () => {
    await criarUsuario(amb.db, { login: "sup2", perfis: ["superintendente"] });
    const sup2 = amb.novoCliente();
    await entrar(sup2, "sup2");
    const id = await perfil_id("superintendente");
    await sup2.post(`/perfis/${id}/niveis`, { nivel_demandas: CONSULTA });
    await entrar(amb.cliente, "sup");
    // epis desce (permitido), demandas sobe (recusado): nada grava
    const r = await amb.cliente.post(`/perfis/${id}/niveis`, { nivel_epis: CONSULTA, nivel_demandas: OPERACAO });
    expect(r.text).toContain("Nada foi gravado");
    const linhas = await amb.db.select().from(e.perfil_nivel_modulo).where(eq(e.perfil_nivel_modulo.perfil_id, id));
    expect(linhas.map((l) => [l.modulo, l.nivel])).toEqual([["demandas", CONSULTA]]);
  });

  it("perfil de escopo próprio ou agregado não se ajusta por módulo", async () => {
    expect(aceita_nivel_modulo("servidor_consulta")).toBe(false);
    expect(aceita_nivel_modulo("admin_ti")).toBe(false);
    expect(aceita_nivel_modulo("tecnico_seguranca")).toBe(true);
    await entrar(amb.cliente, "sup");
    const r = await amb.cliente.post(`/perfis/${await perfil_id("servidor_consulta")}/niveis`, { nivel_epis: OPERACAO });
    expect(r.text).toContain("não se ajusta por módulo");
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
  });
});

describe("exceção da pessoa", () => {
  beforeEach(async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "alm", perfis: ["almoxarife_sesmt"] });
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    await entrar(amb.cliente, "sup");
  });

  it("dá: consulta em Processos SEI para o almoxarife, sem escrita", async () => {
    const alm = amb.novoCliente();
    await entrar(alm, "alm");
    expect((await alm.get("/processos")).status).toBe(403);
    const r = await amb.cliente.post(`/usuarios/${await conta_id("alm")}/niveis`, { "nivel_processos-sei": CONSULTA });
    expect(r.status).toBe(200);
    expect((await alm.get("/processos")).status).toBe(200);
    expect((await alm.get("/processos/novo")).status).toBe(403);
    const u = await carregar_usuario_atual(amb.db, await conta_id("alm"));
    expect(u.pode_na_equipe("processo.ver")).toBe(true);
    expect(u.pode("processo.criar")).toBe(false);
    expect(u.pode("exposicao.ver")).toBe(false); // dado nominal segue o cargo
    const [ev] = await eventos("NIVEL_MODULO_PESSOA_ALTERADO");
    expect(ev!.entidade).toBe("usuario");
    expect(ev!.entidade_id).toBe(await conta_id("alm"));
    expect(ev!.campo).toBe("modulo:processos-sei");
    expect(ev!.valor_anterior).toBe("PADRAO");
    expect(ev!.valor_novo).toBe(CONSULTA);
  });

  it("retira: sem acesso a EPI para o técnico, que o perfil dá; seguir o perfil devolve", async () => {
    const tec = amb.novoCliente();
    await entrar(tec, "tec");
    expect((await tec.get("/epis/estoque")).status).toBe(200);
    await amb.cliente.post(`/usuarios/${await conta_id("tec")}/niveis`, { nivel_epis: SEM_ACESSO });
    expect((await tec.get("/epis/estoque")).status).toBe(403);
    const u = await carregar_usuario_atual(amb.db, await conta_id("tec"));
    expect([...u.permissoes].filter((p) => p.startsWith("epi."))).toEqual([]);
    expect(u.pode("processo.criar")).toBe(true); // os outros módulos seguem o perfil
    await amb.cliente.post(`/usuarios/${await conta_id("tec")}/niveis`, { nivel_epis: "PADRAO" });
    expect((await tec.get("/epis/estoque")).status).toBe(200);
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
    const evs = await eventos("NIVEL_MODULO_PESSOA_ALTERADO");
    expect(evs.map((x) => x.valor_novo)).toEqual(["PADRAO", SEM_ACESSO]);
  });

  it("a exceção da pessoa vence o nível do perfil", async () => {
    await amb.cliente.post(`/perfis/${await perfil_id("tecnico_seguranca")}/niveis`, { nivel_epis: SEM_ACESSO });
    expect((await carregar_usuario_atual(amb.db, await conta_id("tec"))).pode("epi.ver")).toBe(false);
    await amb.cliente.post(`/usuarios/${await conta_id("tec")}/niveis`, { nivel_epis: CONSULTA });
    const u = await carregar_usuario_atual(amb.db, await conta_id("tec"));
    expect(u.pode("epi.ver")).toBe(true);
    expect(u.pode("epi.entregar")).toBe(false);
  });

  it("ninguém altera a exceção da própria conta", async () => {
    const r = await amb.cliente.post(`/usuarios/${await conta_id("sup")}/niveis`, { nivel_epis: SEM_ACESSO });
    expect(r.status).toBe(200);
    expect(r.text).toContain("própria conta");
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
  });

  it("quem não administra acesso não grava exceção", async () => {
    await criarUsuario(amb.db, { login: "coord", perfis: ["coordenador_csso"] });
    const coord = amb.novoCliente();
    await entrar(coord, "coord");
    const r = await coord.post(`/usuarios/${await conta_id("alm")}/niveis`, { "nivel_processos-sei": OPERACAO });
    expect(r.status).toBe(403);
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
  });

  it("conta sem perfil de equipe não recebe módulo (o escopo vem do perfil)", async () => {
    await criarUsuario(amb.db, { login: "so-titular", perfis: ["servidor_consulta"] });
    const r = await amb.cliente.post(`/usuarios/${await conta_id("so-titular")}/niveis`, { nivel_epis: OPERACAO });
    expect(r.text).toContain("não tem perfil de equipe");
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
  });

  it("a gaveta Gerir mostra o acesso por módulo e os setores", async () => {
    const tela = await amb.cliente.get("/usuarios");
    expect(tela.text).toContain(`action="/usuarios/${await conta_id("alm")}/niveis"`);
    expect(tela.text).toContain(`action="/usuarios/${await conta_id("alm")}/setores"`);
    expect(tela.text).not.toContain(`action="/usuarios/${await conta_id("sup")}/niveis"`);
  });
});

describe("setores promotores da conta", () => {
  it("vincula e desvincula com trilha; a própria conta não se edita", async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    await entrar(amb.cliente, "sup");
    const [cpel] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CPEL"));
    const tec = await conta_id("tec");
    const antes = await carregar_usuario_atual(amb.db, tec);
    expect(antes.setor_csso).toBe(true);
    // fica só a CPEL: sai a CSSO, entra a CPEL
    await amb.cliente.post(`/usuarios/${tec}/setores`, { setor: [cpel!.id] });
    const depois = await carregar_usuario_atual(amb.db, tec);
    expect(depois.setores_promotores).toEqual([cpel!.id]);
    expect(depois.setor_csso).toBe(false);
    expect((await eventos("SETOR_PROMOTOR_VINCULADO")).map((x) => x.valor_novo)).toEqual(["CPEL"]);
    expect((await eventos("SETOR_PROMOTOR_DESVINCULADO")).map((x) => x.valor_anterior)).toEqual(["CSSO"]);
    const r = await amb.cliente.post(`/usuarios/${await conta_id("sup")}/setores`, { setor: [cpel!.id] });
    expect(r.text).toContain("própria conta");
    expect(
      await amb.db
        .select()
        .from(e.equipe_setor_promotor)
        .where(and(eq(e.equipe_setor_promotor.usuario_id, await conta_id("sup")))),
    ).toEqual([]);
  });
});

describe("o semeio de cada deploy não desfaz o ajuste", () => {
  it("semear_rbac mantém o nível gravado e as permissões efetivas", async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    await entrar(amb.cliente, "sup");
    await amb.cliente.post(`/perfis/${await perfil_id("tecnico_seguranca")}/niveis`, {
      nivel_certificados: CONSULTA,
      nivel_epis: SEM_ACESSO,
    });
    await amb.cliente.post(`/usuarios/${await conta_id("tec")}/niveis`, { nivel_demandas: SEM_ACESSO });
    const antes = await do_perfil("tec");
    await naTransacao((tx) => semear_rbac(tx));
    await naTransacao((tx) => semear_rbac(tx));
    const niveis = await amb.db.select().from(e.perfil_nivel_modulo);
    expect(niveis.map((l) => [l.modulo, l.nivel]).sort()).toEqual([
      ["certificados", CONSULTA],
      ["epis", SEM_ACESSO],
    ]);
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(1);
    expect(await do_perfil("tec")).toEqual(antes);
    expect(antes).not.toContain("turma.criar");
    expect(antes).not.toContain("epi.ver");
    expect(antes).not.toContain("demanda.ver");
  });
});
