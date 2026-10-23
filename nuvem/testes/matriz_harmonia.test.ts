/**
 * Matriz de perfis e Acesso por módulo, em harmonia (23/10/2026).
 *
 * - o TETO de cada perfil (`NUNCA_POR_NIVEL`): nenhum nível passa do que a
 *   matriz tirou do perfil de propósito;
 * - as duas telas (`/perfis` e `/perfis/niveis`) saem do mesmo cálculo e listam
 *   o mesmo conjunto de permissões por perfil e por bloco;
 * - o texto gravado do perfil é o do código depois do semeio (D8);
 * - PROGEP e auditor interno vão no máximo até Consulta (D2);
 * - o Administrador do sistema e o admin_ti não se ajustam;
 * - a exceção por pessoa só aparece para conta com perfil de equipe (D9).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import {
  MATRIZ_PERFIS,
  PERMISSOES,
  PERMISSOES_DO_TITULAR,
  aceita_nivel_modulo,
  carregar_usuario_atual,
  modulo_da_permissao,
} from "../src/servicos/rbac.js";
import {
  CONSULTA,
  MODULOS_NIVELADOS,
  NIVEIS,
  NUNCA_POR_NIVEL,
  OPERACAO,
  SEM_ACESSO,
  nivel_lido,
  nivel_maximo,
  permissoes_com_niveis,
  rotulo_do_nivel,
  teto_do_perfil,
  type Nivel,
} from "../src/servicos/niveis_modulo.js";
import { perfis_com_niveis } from "../src/servicos/liberacao_modulo.js";
import { semear_rbac } from "../src/servicos/sementes.js";
import { bancoLimpo, criarUsuario, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
});

const PERFIS_QUE_ACEITAM = Object.keys(MATRIZ_PERFIS).filter(aceita_nivel_modulo);
const ESCRITA = MODULOS_NIVELADOS.flatMap((m) => m.escrita);

async function perfil_id(codigo: string): Promise<number> {
  const [p] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, codigo));
  return p!.id;
}

async function conta_id(login: string): Promise<number> {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!.id;
}

describe("o teto de cada perfil", () => {
  it("todo perfil que aceita nível declara o teto, e o teto não cobre o que o perfil tem", () => {
    expect(PERFIS_QUE_ACEITAM.length).toBeGreaterThan(5);
    for (const perfil of PERFIS_QUE_ACEITAM) {
      expect(Object.hasOwn(NUNCA_POR_NIVEL, perfil), perfil).toBe(true);
      for (const p of NUNCA_POR_NIVEL[perfil]!) {
        expect(MATRIZ_PERFIS[perfil]!.permissoes, `${perfil}/${p}`).not.toContain(p);
      }
    }
  });

  it("nenhum nível, em nenhum módulo, passa do teto do perfil (todas as combinações)", () => {
    for (const perfil of PERFIS_QUE_ACEITAM) {
      const teto = teto_do_perfil(perfil);
      const cruas = MATRIZ_PERFIS[perfil]!.permissoes;
      for (const m of MODULOS_NIVELADOS) {
        for (const nivel of [undefined, ...NIVEIS] as (Nivel | undefined)[]) {
          const do_perfil = nivel === undefined ? {} : { [m.codigo]: nivel };
          // o nível gravado no perfil e, separadamente, a exceção da pessoa
          for (const [a, b] of [[do_perfil, {}], [{}, do_perfil]] as const) {
            const dado = permissoes_com_niveis(cruas, a, b, perfil);
            for (const p of teto) {
              // o teto nunca é devolvido por nível (o padrão não o tem, e `cruas` não cobre o teto)
              expect(dado, `${perfil}/${m.codigo}/${nivel}/${p}`).not.toContain(p);
            }
          }
        }
      }
    }
  });

  it("PROGEP e auditor interno nunca chegam a escrita, em nenhum nível", () => {
    for (const perfil of ["consulta_progep", "auditor_interno"]) {
      const todos = Object.fromEntries(MODULOS_NIVELADOS.map((m) => [m.codigo, OPERACAO as Nivel]));
      const dado = permissoes_com_niveis(MATRIZ_PERFIS[perfil]!.permissoes, todos, todos, perfil);
      for (const p of ESCRITA) expect(dado, `${perfil}/${p}`).not.toContain(p);
      for (const m of MODULOS_NIVELADOS) expect(nivel_maximo(m, teto_do_perfil(perfil)), `${perfil}/${m.codigo}`).toBe(CONSULTA);
    }
  });

  it("técnico nunca anula certificado, almoxarife nunca lê parecer, secretaria nunca analisa EPI", () => {
    const tudo = Object.fromEntries(MODULOS_NIVELADOS.map((m) => [m.codigo, OPERACAO as Nivel]));
    const tec = permissoes_com_niveis(MATRIZ_PERFIS.tecnico_seguranca!.permissoes, tudo, tudo, "tecnico_seguranca");
    expect(tec).not.toContain("certificado.anular");
    expect(tec).not.toContain("participante.mesclar");
    expect(tec).not.toContain("parecer.anular");
    const alm = permissoes_com_niveis(MATRIZ_PERFIS.almoxarife_sesmt!.permissoes, tudo, tudo, "almoxarife_sesmt");
    expect(alm.filter((p) => p.startsWith("parecer."))).toEqual([]);
    expect(alm).not.toContain("epi.analisar");
    const sec = permissoes_com_niveis(MATRIZ_PERFIS.secretaria_csso!.permissoes, tudo, tudo, "secretaria_csso");
    expect(sec).not.toContain("epi.analisar");
    expect(sec).not.toContain("epi.ficha");
    expect(sec).not.toContain("parecer.emitir");
    // e o que o nível dá continua dando: o teto só tira
    expect(permissoes_com_niveis([], tudo, {}, "coordenador_csso")).toContain("certificado.anular");
  });

  it("o padrão de cada perfil se lê como um nível: não sobra Parcial entre os perfis de equipe", () => {
    for (const perfil of PERFIS_QUE_ACEITAM) {
      for (const m of MODULOS_NIVELADOS) {
        expect(nivel_lido(MATRIZ_PERFIS[perfil]!.permissoes, m, teto_do_perfil(perfil)), `${perfil}/${m.codigo}`).not.toBe("PARCIAL");
      }
    }
  });

  it("o rótulo diz o que o teto tira: Operação (sem anular certificado, juntar cadastros)", () => {
    const cert = MODULOS_NIVELADOS.find((m) => m.codigo === "certificados")!;
    expect(rotulo_do_nivel(OPERACAO, cert, "tecnico_seguranca")).toBe("Operação (sem anular certificado, juntar cadastros)");
    expect(rotulo_do_nivel(OPERACAO, cert, "coordenador_csso")).toBe("Operação");
    expect(rotulo_do_nivel(CONSULTA, cert, "tecnico_seguranca")).toBe("Consulta");
    const epi = MODULOS_NIVELADOS.find((m) => m.codigo === "epis")!;
    expect(rotulo_do_nivel(CONSULTA, epi, "secretaria_csso")).toBe("Consulta (sem ficha nominal)");
    expect(rotulo_do_nivel(SEM_ACESSO, epi, "secretaria_csso")).toBe("Sem acesso");
  });
});

// ---------------------------------------------------------------------
// As duas telas
// ---------------------------------------------------------------------
/** Os blocos do cartão do perfil: `{modulo|sempre|titular: [permissões]}`. */
function blocos_de(html: string, codigo: string): Record<string, string[]> {
  const ini = html.indexOf(`id="perfil-${codigo}"`);
  expect(ini, `cartão de ${codigo}`).toBeGreaterThan(-1);
  const fins = [html.indexOf("</details>", ini), html.indexOf("</section>", ini)].filter((i) => i > -1);
  const trecho = html.slice(ini, Math.min(...fins));
  const saida: Record<string, string[]> = {};
  for (const m of trecho.matchAll(/<div class="fileira" data-bloco="([^"]+)">([\s\S]*?)<\/div>/g)) {
    saida[m[1]!] = [...m[2]!.matchAll(/data-perm="([^"]+)"/g)].map((x) => x[1]!);
  }
  return saida;
}

describe("as duas telas saem do mesmo cálculo", () => {
  beforeEach(async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await entrar(amb.cliente, "sup");
    // níveis gravados, para as telas não coincidirem só porque nada foi ajustado
    for (const [perfil, niveis] of [
      ["tecnico_seguranca", { nivel_epis: "CONSULTA", nivel_certificados: "SEM_ACESSO" }],
      ["secretaria_csso", { "nivel_processos-sei": "CONSULTA" }],
      ["coordenador_csso", { nivel_demandas: "CONSULTA" }],
      ["consulta_progep", { nivel_certificados: "SEM_ACESSO" }],
    ] as const) {
      const r = await amb.cliente.post(`/perfis/${await perfil_id(perfil)}/niveis`, niveis);
      expect(r.status, perfil).toBeLessThan(400);
      expect(r.text, perfil).not.toContain("Nada foi gravado");
    }
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(5);
  });

  it("listam o mesmo conjunto de permissões por perfil e por bloco, e é o do cálculo", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const u = await carregar_usuario_atual(amb.db, await conta_id("sup"));
    const calculo = await perfis_com_niveis(amb.db, u);
    expect(calculo.length).toBe(Object.keys(MATRIZ_PERFIS).length);
    for (const p of calculo) {
      const niveis = (await amb.cliente.get(`/perfis/niveis?perfil=${p.codigo}`)).text;
      const a = blocos_de(matriz, p.codigo);
      const b = blocos_de(niveis, p.codigo);
      expect(b, p.codigo).toEqual(a);
      const esperado: Record<string, string[]> = {
        sempre: p.sempre_do_perfil,
        titular: [...PERMISSOES_DO_TITULAR].sort(),
      };
      for (const l of p.linhas) esperado[l.modulo.codigo] = l.permissoes;
      expect(a, p.codigo).toEqual(esperado);
    }
  });

  it("os quatro módulos, 'Sempre do perfil' e 'Do titular' aparecem nas duas, com o mesmo nome", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const niveis = (await amb.cliente.get("/perfis/niveis?perfil=tecnico_seguranca")).text;
    for (const t of [matriz, niveis]) {
      for (const m of MODULOS_NIVELADOS) expect(t).toContain(m.nome);
      expect(t).toContain("Sempre do perfil");
      expect(t).toContain("Do titular");
    }
  });

  it("o nível em vigor sai igual nas duas telas (D10)", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const niveis = (await amb.cliente.get("/perfis/niveis?perfil=tecnico_seguranca")).text;
    // o técnico: Gestão de EPI em Consulta e Certificados em Sem acesso (gravados acima)
    for (const t of [matriz, niveis]) {
      expect(t).toContain("Operação (sem atribuir, anular parecer)");
      expect(t).toContain("Sem acesso");
    }
    expect(niveis).toContain("Padrão do perfil");
  });

  it("as duas listam os mesmos perfis", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const niveis = (await amb.cliente.get("/perfis/niveis")).text;
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      expect(matriz, codigo).toContain(`id="perfil-${codigo}"`);
      expect(niveis, codigo).toContain(`perfil=${codigo}"`);
      expect(niveis, codigo).toContain(dados.nome);
    }
  });

  it("a permissão derivada @base nunca aparece como permissão", async () => {
    for (const caminho of ["/perfis", "/perfis/niveis?perfil=tecnico_seguranca"]) {
      const t = (await amb.cliente.get(caminho)).text;
      expect(t, caminho).not.toContain("@base");
    }
  });
});

// ---------------------------------------------------------------------
// D8 — o texto do perfil
// ---------------------------------------------------------------------
describe("o texto do perfil é o do código", () => {
  it("depois de semear, nome e base normativa gravados são os de MATRIZ_PERFIS", async () => {
    await amb.db.update(e.perfil).set({ base_normativa: "texto antigo", nome: "Nome antigo" });
    await naTransacao((tx) => semear_rbac(tx));
    const linhas = await amb.db.select().from(e.perfil);
    expect(linhas.length).toBe(Object.keys(MATRIZ_PERFIS).length);
    for (const l of linhas) {
      expect(l.base_normativa, l.codigo).toBe(MATRIZ_PERFIS[l.codigo]!.base_normativa ?? null);
      expect(l.nome, l.codigo).toBe(MATRIZ_PERFIS[l.codigo]!.nome);
    }
  });

  it("os textos desatualizados foram corrigidos, e nenhum cita código de RN", async () => {
    const t = (c: string) => MATRIZ_PERFIS[c]!.base_normativa ?? "";
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      expect(dados.base_normativa ?? "", codigo).not.toMatch(/\bRN-\d+/);
    }
    expect(t("consulta_progep")).not.toContain("Le apenas parecer assinado");
    expect(t("admin_ti")).not.toMatch(/contagens|agregad/i);
    expect(t("secretaria_csso")).not.toContain("RN-19");
    expect(t("administrador_sistema")).toContain("sempre em Operação");
  });

  it("a coluna permissao.modulo é derivada dos módulos (D7) e fica gravada", async () => {
    await amb.db.update(e.permissao).set({ modulo: "ADICIONAL" });
    await naTransacao((tx) => semear_rbac(tx));
    const linhas = await amb.db.select().from(e.permissao);
    expect(linhas.length).toBe(Object.keys(PERMISSOES).length);
    for (const l of linhas) expect(l.modulo, l.codigo).toBe(modulo_da_permissao(l.codigo));
    expect(modulo_da_permissao("turma.inscrever_se")).toBe("PERFIL");
  });
});

// ---------------------------------------------------------------------
// D2 — PROGEP e auditor
// ---------------------------------------------------------------------
describe("PROGEP e auditor interno: no máximo Consulta", () => {
  beforeEach(async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "prog", perfis: ["consulta_progep"] });
    await entrar(amb.cliente, "sup");
  });

  for (const perfil of ["consulta_progep", "auditor_interno"]) {
    it(`${perfil}: a tela não oferece Operação e o servidor recusa o POST`, async () => {
      const t = (await amb.cliente.get(`/perfis/niveis?perfil=${perfil}`)).text;
      expect(t).not.toContain('value="OPERACAO"');
      expect(t).toContain('value="CONSULTA"');
      const r = await amb.cliente.post(`/perfis/${await perfil_id(perfil)}/niveis`, { nivel_epis: "OPERACAO" });
      expect(r.text).toContain("Nada foi gravado");
      expect(r.text).toContain("no máximo, até Consulta");
      expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
      // Consulta e Sem acesso continuam possíveis
      const ok = await amb.cliente.post(`/perfis/${await perfil_id(perfil)}/niveis`, { nivel_epis: "SEM_ACESSO" });
      expect(ok.text).not.toContain("Nada foi gravado");
      expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(1);
    });
  }

  it("a exceção da pessoa também recusa Operação quando os perfis dela só vão até Consulta", async () => {
    const r = await amb.cliente.post(`/usuarios/${await conta_id("prog")}/niveis`, { nivel_epis: "OPERACAO" });
    expect(r.text).toContain("no máximo, até Consulta");
    expect((await amb.db.select().from(e.usuario_nivel_modulo)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// admin_ti e administrador_sistema
// ---------------------------------------------------------------------
describe("admin_ti e Administrador do sistema", () => {
  beforeEach(async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await entrar(amb.cliente, "sup");
  });

  it("o Administrador do sistema aparece fixo em Operação nas duas telas e não se ajusta", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const niveis = (await amb.cliente.get("/perfis/niveis?perfil=administrador_sistema")).text;
    expect(matriz).toContain("sempre em Operação");
    expect(niveis).toContain("sempre em Operação");
    expect(niveis).not.toContain('type="radio"');
    expect(niveis).toContain("Operação · fixa");
    const a = blocos_de(matriz, "administrador_sistema");
    for (const m of MODULOS_NIVELADOS) {
      expect(new Set(a[m.codigo]), m.codigo).toEqual(new Set([...m.consulta, ...m.escrita]));
    }
    const r = await amb.cliente.post(`/perfis/${await perfil_id("administrador_sistema")}/niveis`, { nivel_epis: "CONSULTA" });
    expect(r.text).toContain("sempre no nível mais alto");
    expect((await amb.db.select().from(e.perfil_nivel_modulo)).length).toBe(0);
  });

  it("o admin_ti aparece sem módulo nenhum, só com a administração técnica, e não se ajusta", async () => {
    const matriz = (await amb.cliente.get("/perfis")).text;
    const niveis = (await amb.cliente.get("/perfis/niveis?perfil=admin_ti")).text;
    const a = blocos_de(matriz, "admin_ti");
    for (const m of MODULOS_NIVELADOS) expect(a[m.codigo], m.codigo).toEqual([]);
    expect(new Set(a.sempre)).toEqual(new Set(MATRIZ_PERFIS.admin_ti!.permissoes));
    expect(blocos_de(niveis, "admin_ti")).toEqual(a);
    expect(niveis).toContain("não se ajusta por módulo");
    expect(niveis).not.toContain('type="radio"');
    expect(niveis).not.toMatch(/contagens|agregad/i);
    const r = await amb.cliente.post(`/perfis/${await perfil_id("admin_ti")}/niveis`, { nivel_epis: "CONSULTA" });
    expect(r.text).toContain("não se ajusta por módulo");
  });

  it("'Do titular' mostra o que toda conta ligada a servidor recebe", async () => {
    const t = (await amb.cliente.get("/perfis")).text;
    const a = blocos_de(t, "almoxarife_sesmt");
    expect(new Set(a.titular)).toEqual(new Set(PERMISSOES_DO_TITULAR));
    expect(t).toContain("O nível de um módulo não retira o que é do titular");
  });
});

// ---------------------------------------------------------------------
// D9 — a exceção por pessoa
// ---------------------------------------------------------------------
describe("a exceção por pessoa só aparece para quem tem perfil de equipe", () => {
  it("conta de equipe tem o formulário; a só de titular não, e a tela explica", async () => {
    await criarUsuario(amb.db, { login: "sup", perfis: ["superintendente"] });
    await criarUsuario(amb.db, { login: "tec", perfis: ["tecnico_seguranca"] });
    await criarUsuario(amb.db, { login: "serv", perfis: ["servidor_consulta"] });
    await criarUsuario(amb.db, { login: "semperfil", perfis: [] });
    await entrar(amb.cliente, "sup");
    const t = (await amb.cliente.get("/usuarios")).text;
    expect(t).toContain(`action="/usuarios/${await conta_id("tec")}/niveis"`);
    expect(t).not.toContain(`action="/usuarios/${await conta_id("serv")}/niveis"`);
    expect(t).not.toContain(`action="/usuarios/${await conta_id("semperfil")}/niveis"`);
    expect(t).toContain("não tem perfil de equipe");
    expect(t).not.toContain("Seguir o perfil");
  });
});
