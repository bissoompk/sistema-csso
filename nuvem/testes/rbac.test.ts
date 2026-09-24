/**
 * RBAC: matriz de perfis, escopo e habilitação. Porte da parte de RBAC de
 * `testes/unitarios/test_servicos_diversos.py` e de `test_rede_do_setor.py`
 * (o aviso de escopo não escreve o login).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { cargo, laudo_tecnico, processo, servidor, epi_ficha_registro } from "../src/db/esquema/index.js";
import {
  ESCOPO_AGREGADO,
  ESCOPO_POR_PERFIL,
  ESCOPO_PROPRIO,
  ESCOPO_TOTAL,
  ESCOPO_UNIDADE,
  EscopoNaoDeclarado,
  MATRIZ_PERFIS,
  PERMISSOES,
  PermissaoNegada,
  UsuarioAtual,
  _conferir_escopos,
  aplicar_escopo,
  carregar_usuario_atual,
  exigir_subscricao,
  modulo_da_permissao,
  pode_subscrever,
} from "../src/servicos/rbac.js";
import { PermissaoNegada as PermissaoNegadaDoNucleo } from "../src/nucleo/erros.js";

function usuario(perfil: string, extra: Partial<ConstructorParameters<typeof UsuarioAtual>[0]> = {}) {
  return new UsuarioAtual({
    id: 1,
    login: perfil,
    nome: perfil,
    permissoes: MATRIZ_PERFIS[perfil]!.permissoes,
    perfis: [perfil],
    ...extra,
  });
}

const dialeto = new PgDialect();
const emSql = (c: ReturnType<typeof aplicar_escopo>) => (c ? dialeto.sqlToQuery(c) : null);

describe("matriz de perfis", () => {
  it("toda permissão da matriz existe", () => {
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      for (const p of dados.permissoes) expect(PERMISSOES, `${codigo}: ${p}`).toHaveProperty([p]);
    }
  });

  it("admin de TI não vê conteúdo técnico", () => {
    const admin = usuario("admin_ti");
    for (const negada of ["processo.ver", "parecer.ver", "parecer.assinar", "exposicao.ver"]) {
      expect(admin.pode(negada)).toBe(false);
    }
    expect(admin.pode("backup.executar")).toBe(true);
    expect(admin.pode("usuario.resetar_senha")).toBe(true);
  });

  it("técnica emite mas não assina", () => {
    const tecnica = usuario("tecnico_seguranca");
    expect(tecnica.pode("parecer.emitir")).toBe(true);
    expect(tecnica.pode("processo.status")).toBe(true);
    expect(tecnica.pode("parecer.assinar")).toBe(false);
    expect(tecnica.pode("laudo.criar")).toBe(false);
    expect(() => tecnica.exigir("parecer.assinar")).toThrow(PermissaoNegada);
  });

  it("secretaria não vê exposição", () => {
    const secretaria = usuario("secretaria_csso");
    expect(secretaria.pode("processo.criar")).toBe(true);
    expect(secretaria.ve_dado_nominal).toBe(false);
  });

  it("almoxarife vê o nome pela ficha de EPI, sem exposicao.ver", () => {
    const almoxarife = usuario("almoxarife_sesmt");
    expect(almoxarife.pode("exposicao.ver")).toBe(false);
    expect(almoxarife.ve_dado_nominal).toBe(true);
  });

  it("superintendente governa acesso mas não assina", () => {
    const chefe = usuario("superintendente");
    expect(chefe.pode("perfil.conceder")).toBe(true);
    expect(chefe.pode("habilitacao.atestar")).toBe(true);
    expect(chefe.pode("parecer.assinar")).toBe(false);
    expect(chefe.pode("processo.criar")).toBe(false);
  });

  it("coordenador não concede perfil", () => {
    const coordenador = usuario("coordenador_csso");
    expect(coordenador.pode("perfil.conceder")).toBe(false);
    expect(coordenador.pode("usuario.criar_conta")).toBe(false);
    expect(coordenador.pode("parecer.assinar")).toBe(true);
  });

  it("auditor só lê", () => {
    const auditor = usuario("auditor_interno");
    expect(auditor.pode("auditoria.ver")).toBe(true);
    for (const escrita of ["processo.criar", "processo.editar", "parecer.emitir", "parecer.anular"]) {
      expect(auditor.pode(escrita)).toBe(false);
    }
  });

  it("módulo da permissão: EPI, treinamento, base e o padrão", () => {
    expect(modulo_da_permissao("epi.ver")).toBe("EPI");
    expect(modulo_da_permissao("turma.criar")).toBe("TREINAMENTOS");
    expect(modulo_da_permissao("demanda.ver")).toBe("BASE");
    expect(modulo_da_permissao("processo.ver")).toBe("ADICIONAL");
  });

  it("a PermissaoNegada do RBAC é a do núcleo (a que o onError trata)", () => {
    expect(PermissaoNegada).toBe(PermissaoNegadaDoNucleo);
  });
});

describe("escopo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("escopos por perfil", () => {
    expect(usuario("auditor_interno").escopo).toBe(ESCOPO_TOTAL);
    expect(usuario("coordenador_csso").escopo).toBe(ESCOPO_UNIDADE);
    expect(usuario("servidor_consulta").escopo).toBe(ESCOPO_PROPRIO);
    expect(usuario("admin_ti").escopo).toBe(ESCOPO_AGREGADO);
  });

  it("sem perfil é o mais restrito", () => {
    const anonimo = new UsuarioAtual({ id: 0, login: "x", nome: "x", permissoes: [], perfis: [] });
    expect(anonimo.escopo).toBe(ESCOPO_PROPRIO);
  });

  it("o mais largo vence entre vários perfis", () => {
    const duplo = new UsuarioAtual({
      id: 0,
      login: "x",
      nome: "x",
      permissoes: [],
      perfis: ["servidor_consulta", "auditor_interno"],
    });
    expect(duplo.escopo).toBe(ESCOPO_TOTAL);
  });

  it("modelo sem servidor_id não vaza (vira `false`)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = emSql(aplicar_escopo(usuario("servidor_consulta", { servidor_id: 7 }), laudo_tecnico));
    expect(q!.sql).toBe("false");
  });

  it("modelo sem servidor_id deixa rastro no log — com a conta por id, nunca o login", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fulano = new UsuarioAtual({
      id: 99,
      login: "fulano.de.tal",
      nome: "Fulano de Tal",
      permissoes: [],
      perfis: ["servidor_consulta"],
    });
    aplicar_escopo(fulano, cargo);
    const texto = aviso.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(texto).toContain("cargo");
    expect(texto).toContain("conta 99");
    expect(texto).not.toContain("fulano.de.tal");
  });

  it("próprio filtra por servidor_id (e -1 quando a conta não tem servidor)", () => {
    const com = emSql(aplicar_escopo(usuario("servidor_consulta", { servidor_id: 42 }), epi_ficha_registro));
    expect(com!.sql).toContain('"servidor_id" = $1');
    expect(com!.params).toEqual([42]);
    const sem = emSql(aplicar_escopo(usuario("servidor_consulta"), processo));
    expect(sem!.params).toEqual([-1]);
  });

  it("em `servidor` o próprio é a chave primária", () => {
    const q = emSql(aplicar_escopo(usuario("servidor_consulta", { servidor_id: 5 }), servidor));
    expect(q!.sql).toContain('"servidor"."id" = $1');
    expect(q!.params).toEqual([5]);
  });

  it("total e agregado não filtram; unidade sem campus é a coordenadoria inteira", () => {
    expect(aplicar_escopo(usuario("auditor_interno"))).toBeUndefined();
    expect(aplicar_escopo(usuario("admin_ti"))).toBeUndefined();
    expect(aplicar_escopo(usuario("coordenador_csso"))).toBeUndefined();
  });

  it("unidade com campus filtra por campus_id quando a tabela tem a coluna", () => {
    const u = usuario("coordenador_csso", { campi: [2, 3] });
    const q = emSql(aplicar_escopo(u, processo));
    // `processo` não tem campus_id: sem coluna não há filtro (como no Python)
    expect(q).toBeNull();
  });
});

describe("escopo declarado para todo perfil", () => {
  it("todo perfil da matriz tem escopo", () => {
    expect(new Set(Object.keys(MATRIZ_PERFIS))).toEqual(new Set(Object.keys(ESCOPO_POR_PERFIL)));
  });

  it("perfil sem escopo derruba a conferência", () => {
    MATRIZ_PERFIS["almoxarife_de_teste"] = { nome: "x", permissoes: [] };
    try {
      expect(() => _conferir_escopos()).toThrow(/almoxarife_de_teste/);
    } finally {
      delete MATRIZ_PERFIS["almoxarife_de_teste"];
    }
    _conferir_escopos();
  });

  it("escopo para perfil inexistente também é recusado", () => {
    ESCOPO_POR_PERFIL["perfil_fantasma"] = ESCOPO_TOTAL;
    try {
      expect(() => _conferir_escopos()).toThrow(/perfil_fantasma/);
    } finally {
      delete ESCOPO_POR_PERFIL["perfil_fantasma"];
    }
  });

  it("nível de escopo desconhecido é recusado", () => {
    const original = ESCOPO_POR_PERFIL["auditor_interno"]!;
    ESCOPO_POR_PERFIL["auditor_interno"] = "X";
    try {
      expect(() => _conferir_escopos()).toThrow(/auditor_interno/);
    } finally {
      ESCOPO_POR_PERFIL["auditor_interno"] = original;
    }
  });

  it("perfil do banco sem escopo nega em vez de esvaziar a tela", () => {
    const intruso = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: [], perfis: ["perfil_inventado"] });
    let erro: unknown;
    try {
      void intruso.escopo;
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(EscopoNaoDeclarado);
    expect(erro).toBeInstanceOf(PermissaoNegada); // vira 403, não 500
    expect(String((erro as Error).message)).toContain("perfil_inventado");
  });
});

describe("carregar_usuario_atual e RN-01 (banco)", async () => {
  const { bancoLimpo, criarUsuario } = await import("./ajuda");
  const { db } = await bancoLimpo();
  const { eq } = await import("drizzle-orm");
  const e = await import("../src/db/esquema/index.js");

  it("junta os perfis vigentes e ignora o vencido e o inativo", async () => {
    const conta = await criarUsuario(db, { login: "misto", perfis: ["secretaria_csso"] });
    // atribuição vencida
    const [auditor] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "auditor_interno"));
    await db.insert(e.atribuicao).values({
      usuario_id: conta.id,
      perfil_id: auditor!.id,
      vigencia_inicio: "2020-01-01",
      vigencia_fim: "2021-01-01",
    });
    const atual = await carregar_usuario_atual(db, conta.id);
    expect(atual.perfis).toEqual(["secretaria_csso"]);
    expect(atual.pode("processo.criar")).toBe(true);
    expect(atual.pode("auditoria.ver")).toBe(false);
    expect(atual.precisa_trocar_senha).toBe(false);

    await db.update(e.usuario).set({ ativo: false }).where(eq(e.usuario.id, conta.id));
    await expect(carregar_usuario_atual(db, conta.id)).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("campi das atribuições entram no usuário", async () => {
    const [campus] = await db.select().from(e.campus).where(eq(e.campus.sigla, "MUC"));
    const conta = await criarUsuario(db, { login: "mucuri", perfis: ["tecnico_seguranca"], campus_id: campus!.id });
    const atual = await carregar_usuario_atual(db, conta.id);
    expect(atual.campi).toEqual([campus!.id]);
  });

  it("RN-01: subscreve quem tem parecer.assinar E habilitação vigente", async () => {
    const conta = await criarUsuario(db, { login: "eng", perfis: ["engenheiro_seguranca"] });
    let atual = await carregar_usuario_atual(db, conta.id);
    expect(await pode_subscrever(db, atual)).toBe(false);
    await expect(exigir_subscricao(db, atual)).rejects.toThrow(/IN SGP\/SEDGG\/ME nº 15\/2022/);

    await db.insert(e.profissional_habilitado).values({
      usuario_id: conta.id,
      nome: "Eng de Teste",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "Eng. Seg. do Trabalho",
      vigencia_inicio: "2020-01-01",
    });
    atual = await carregar_usuario_atual(db, conta.id);
    expect(atual.habilitacoes.length).toBe(1);
    expect(await pode_subscrever(db, atual)).toBe(true);
    expect(await pode_subscrever(db, atual, "2019-12-31")).toBe(false);

    // a técnica pode ter habilitação no papel: sem `parecer.assinar`, não assina
    const tecnica = await criarUsuario(db, { login: "tec", perfis: ["tecnico_seguranca"] });
    await db.insert(e.profissional_habilitado).values({
      usuario_id: tecnica.id,
      nome: "Tec",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "x",
      vigencia_inicio: "2020-01-01",
    });
    expect(await pode_subscrever(db, await carregar_usuario_atual(db, tecnica.id))).toBe(false);
  });
});
