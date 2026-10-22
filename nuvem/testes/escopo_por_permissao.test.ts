/**
 * Escopo por permissão (D1, D9, D16 e D18 da verificação de governança,
 * 22/10/2026).
 *
 * O escopo e os campi eram da CONTA: somar um perfil alargava os outros. Aqui
 * ficam as combinações que a verificação achou, para que nenhuma volte:
 *
 * - `admin_ti` + `servidor_consulta`: virava escopo A, "sem filtro";
 * - `almoxarife_sesmt` + `servidor_consulta`: virava E com leitura nominal;
 * - coordenador sem campus + técnico no campus JK: passava a ver só JK;
 * - secretaria no campus A + coordenador no campus B: anulava parecer em A.
 *
 * E as funções do titular (D16), que vêm com o vínculo a servidor, e as travas
 * de governo que olham a concessão futura (D18).
 */
import { asc, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import * as servico_requisicao from "../src/servicos/epi_requisicao.js";
import {
  CONCESSAO_DO_TITULAR,
  ESCOPO_AGREGADO,
  ESCOPO_PROPRIO,
  ESCOPO_UNIDADE,
  MATRIZ_PERFIS,
  PERMISSOES,
  PERMISSOES_DO_TITULAR,
  PermissaoNegada,
  UsuarioAtual,
  aplicar_escopo,
  carregar_usuario_atual,
  perfis_vigentes,
  type Concessao,
} from "../src/servicos/rbac.js";
import * as identificacao from "../src/servicos/identificacao.js";
import { bancoLimpo, contas, criarUsuario, entrar, type AmbienteDeTeste } from "./ajuda";
import { cenario } from "./ajuda_processos";

const dialeto = new PgDialect();
const emSql = (c: ReturnType<typeof aplicar_escopo>) => (c ? dialeto.sqlToQuery(c) : null);

/**
 * Uma conta montada como `carregar_usuario_atual` monta: uma concessão por
 * `[perfil, campus]`, com as permissões da matriz, e a do titular quando há
 * servidor ligado.
 */
function conta(atribuicoes: [string, number | null][], servidor_id: number | null = null): UsuarioAtual {
  const concessoes: Concessao[] = atribuicoes.map(([perfil, campus_id]) => ({
    perfil,
    campus_id,
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
    perfis: atribuicoes.map(([p]) => p),
    servidor_id,
    concessoes,
  });
}

describe("o alcance é da permissão, não da conta (sem banco)", () => {
  it("admin_ti + servidor_consulta: processo e parecer só do próprio, nunca 'sem filtro'", () => {
    const u = conta([["admin_ti", null], ["servidor_consulta", null]], 42);
    expect(u.escopo).toBe(ESCOPO_AGREGADO); // o da conta, que é do menu
    expect(u.escopo_de("processo.ver")).toBe(ESCOPO_PROPRIO);
    expect(u.escopo_de("parecer.ver")).toBe(ESCOPO_PROPRIO);
    for (const [tabela, permissao] of [
      [e.processo, "processo.ver"],
      [e.parecer_tecnico, "parecer.ver"],
    ] as const) {
      const q = emSql(aplicar_escopo(u, tabela, permissao));
      expect(q, permissao).not.toBeNull();
      expect(q!.sql).toContain('"servidor_id" = $1');
      expect(q!.params).toEqual([42]);
    }
    // e o padrão por tabela dá o mesmo
    expect(emSql(aplicar_escopo(u, e.parecer_tecnico))!.params).toEqual([42]);
  });

  it("agregado nunca é linha: admin_ti sozinho não lê processo nenhum", () => {
    const u = conta([["admin_ti", null]]);
    // `auditoria.ver`, e não mais `indicador.ver`, que saiu do perfil em 22/10/2026
    expect(u.pode("indicador.ver")).toBe(false);
    expect(u.escopo_de("auditoria.ver")).toBe(ESCOPO_AGREGADO);
    expect(emSql(aplicar_escopo(u, e.processo, "auditoria.ver"))!.sql).toBe("false");
    expect(emSql(aplicar_escopo(u, e.processo))!.sql).toBe("false");
  });

  it("almoxarife + servidor_consulta: o parecer é só o dele, e o nome dos outros não aparece", () => {
    const u = conta([["almoxarife_sesmt", null], ["servidor_consulta", null]], 7);
    expect(u.escopo).toBe(ESCOPO_UNIDADE);
    expect(u.escopo_de("parecer.ver")).toBe(ESCOPO_PROPRIO);
    expect(emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.ver"))!.params).toEqual([7]);
    // a família do parecer não lê nome pela `epi.ficha`
    expect(u.ve_dado_nominal_em("parecer.ver")).toBe(false);
    expect(u.ve_dado_nominal_em("processo.ver")).toBe(false);
    expect(u.ve_nome_na_linha({ servidor_id: 99 }, ["exposicao.ver"])).toBe(false);
    // o próprio sempre
    expect(u.ve_nome_na_linha({ servidor_id: 7 }, ["exposicao.ver"])).toBe(true);
    // nas telas de EPI o nome continua (a ficha nominal é do perfil dele)
    expect(u.ve_dado_nominal_em("epi.ver")).toBe(true);
    expect(aplicar_escopo(u, e.epi_ficha_registro, "epi.ficha")).toBeUndefined();
  });

  it("coordenador sem campus + técnico no campus JK: o coordenador continua vendo todos os campi", () => {
    const JK = 3;
    const u = conta([["coordenador_csso", null], ["tecnico_seguranca", JK]]);
    for (const p of ["parecer.ver", "parecer.emitir", "parecer.anular", "turma.criar", "certificado.ver"]) {
      expect(aplicar_escopo(u, e.parecer_tecnico, p), p).toBeUndefined();
    }
    expect(u.ve_dado_nominal_em("parecer.ver")).toBe(true);
    expect(u.ve_nome_na_linha({ servidor_id: 5, campus_id: 8 })).toBe(true);
  });

  it("técnico só no JK, sem o coordenador: só JK", () => {
    const u = conta([["tecnico_seguranca", 3]]);
    const q = emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.ver"));
    expect(q!.sql).toContain('"campus_id" in ($1)');
    expect(q!.params).toEqual([3]);
  });

  it("secretaria no campus A + coordenador no campus B: lê A e B, anula e lê o nome só em B", () => {
    const [A, B] = [1, 2];
    const u = conta([["secretaria_csso", A], ["coordenador_csso", B]]);
    expect(emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.ver"))!.params).toEqual([A, B]);
    expect(emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.anular"))!.params).toEqual([B]);
    expect(emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.emitir"))!.params).toEqual([B]);
    expect(u.ve_dado_nominal_em("parecer.ver")).toBe(false);
    expect(u.ve_nome_na_linha({ servidor_id: 9, campus_id: A })).toBe(false);
    expect(u.ve_nome_na_linha({ servidor_id: 9, campus_id: B })).toBe(true);
    // identificar(...) decide pela linha quando a linha traz o campus
    const linha_a = { servidor_id: 9, campus_id: A, servidor: { id: 9, nome: "Fulana de Tal", siape: "1234567" } };
    const linha_b = { ...linha_a, campus_id: B };
    expect(identificacao.identificar(linha_a, u, "s").nominal).toBe(false);
    expect(identificacao.identificar(linha_b, u, "s").nominal).toBe(true);
  });

  it("dois perfis com a mesma permissão somam o alcance dela (OR), sem alargar a outra", () => {
    const u = conta([["secretaria_csso", 1]], 5);
    // processo.ver da secretaria (campus 1, e `processo` não tem campus) e do titular
    expect(aplicar_escopo(u, e.processo, "processo.ver")).toBeUndefined();
    // parecer: o campus 1 OU o próprio
    const q = emSql(aplicar_escopo(u, e.parecer_tecnico, "parecer.ver"))!;
    expect(q.sql).toContain(" or ");
    expect(q.params).toEqual([1, 5]);
  });

  it("perfil sem escopo declarado nega na leitura da permissão dele", () => {
    const u = new UsuarioAtual({
      id: 1,
      login: "x",
      nome: "x",
      permissoes: ["processo.ver"],
      perfis: ["perfil_inventado"],
      concessoes: [{ perfil: "perfil_inventado", campus_id: null, permissoes: ["processo.ver"] }],
    });
    expect(() => aplicar_escopo(u, e.processo, "processo.ver")).toThrow(PermissaoNegada);
  });
});

describe("funções do titular (D16, sem banco)", () => {
  it("o conjunto do titular é o do servidor comum, e todo código existe no catálogo", () => {
    expect(new Set(MATRIZ_PERFIS["servidor_consulta"]!.permissoes)).toEqual(new Set(PERMISSOES_DO_TITULAR));
    for (const p of PERMISSOES_DO_TITULAR) expect(Object.hasOwn(PERMISSOES, p), p).toBe(true);
  });

  it("o almoxarife ligado a servidor pede EPI só para si e se inscreve, sem ampliar a equipe", () => {
    const u = conta([["almoxarife_sesmt", null]], 11);
    for (const p of PERMISSOES_DO_TITULAR) expect(u.pode(p), p).toBe(true);
    expect(u.escopo_de("epi.requisitar")).toBe(ESCOPO_PROPRIO);
    expect(u.escopo_de("turma.inscrever_se")).toBe(ESCOPO_PROPRIO);
    // a fila do setor continua a dele (epi.ver do perfil), e mexer em pedido é só no próprio
    expect(servico_requisicao._no_escopo(u, "epi.ver")).toBeUndefined();
    const q = emSql(servico_requisicao._no_escopo(u, "epi.requisitar"))!;
    expect(q.params).toEqual([11, 1]);
    // nada de processo ou parecer dos outros
    expect(emSql(aplicar_escopo(u, e.processo, "processo.ver"))!.params).toEqual([11]);
    expect(u.pode("turma.inscrever")).toBe(false);
    expect(u.pode("certificado.ver")).toBe(false);
  });

  it("a concessão do titular não estreita o perfil que já dá a mesma permissão", () => {
    const u = conta([["secretaria_csso", null]], 11);
    expect(u.escopo_de("epi.requisitar")).toBe(ESCOPO_UNIDADE);
    expect(servico_requisicao._no_escopo(u, "epi.requisitar")).toBeUndefined();
  });
});

describe("com banco e pelas rotas", () => {
  let amb: AmbienteDeTeste;
  beforeEach(async () => {
    amb = await bancoLimpo();
    await contas(amb.db);
  });

  async function campi(): Promise<[number, number]> {
    const todos = await amb.db.select().from(e.campus).orderBy(asc(e.campus.id));
    return [todos[0]!.id, todos[1]!.id];
  }

  async function servidor_novo(siape: string, nome: string) {
    const [s] = await amb.db.insert(e.servidor).values({ siape, nome }).returning();
    return s!;
  }

  it("carregar_usuario_atual: a concessão do titular vem com o vínculo, e só com ele", async () => {
    const s = await servidor_novo("7654321", "Almoxarife Vinculado");
    const ligado = await criarUsuario(amb.db, { login: "alm_ligado", perfis: ["almoxarife_sesmt"], servidor_id: s.id });
    const solto = await criarUsuario(amb.db, { login: "alm_solto", perfis: ["almoxarife_sesmt"] });
    const u = await carregar_usuario_atual(amb.db, ligado.id);
    expect(u.perfis).toEqual(["almoxarife_sesmt"]);
    expect(u.pode("turma.inscrever_se")).toBe(true);
    expect(u.escopo_de("processo.ver")).toBe(ESCOPO_PROPRIO);
    const v = await carregar_usuario_atual(amb.db, solto.id);
    expect(v.pode("turma.inscrever_se")).toBe(false);
    expect(v.pode("processo.ver")).toBe(false);
  });

  it("admin_ti + servidor_consulta não abre o parecer nem o processo de outra pessoa", async () => {
    const caso = await cenario(amb.db);
    const s = await servidor_novo("7654321", "Admin Servidor");
    await criarUsuario(amb.db, { login: "admin_srv", perfis: ["admin_ti", "servidor_consulta"], servidor_id: s.id });
    await entrar(amb.cliente, "admin_srv");
    const parecer = await amb.cliente.get(`/pareceres/${caso.parecer_id}`, { seguir: false });
    expect(parecer.status).toBe(303);
    expect(parecer.location).toBe("/processos");
    expect((await amb.cliente.get(`/processos/${caso.processo_id}`)).status).toBe(404);
    // a lista é "Meus processos", e o processo do outro não está nela
    const lista = await amb.cliente.get("/processos");
    expect(lista.status).toBe(200);
    expect(lista.text).not.toContain("23086.021284/2024-56");
  });

  it("almoxarife + servidor_consulta não lê o parecer de outra pessoa", async () => {
    const caso = await cenario(amb.db);
    const s = await servidor_novo("7654321", "Almoxarife Servidor");
    await criarUsuario(amb.db, { login: "alm_srv", perfis: ["almoxarife_sesmt", "servidor_consulta"], servidor_id: s.id });
    await entrar(amb.cliente, "alm_srv");
    const r = await amb.cliente.get(`/pareceres/${caso.parecer_id}`, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/processos");
  });

  it("coordenador sem campus + técnico num campus: o parecer de outro campus continua abrindo", async () => {
    const [A, B] = await campi();
    const caso = await cenario(amb.db);
    await amb.db.update(e.parecer_tecnico).set({ campus_id: B }).where(eq(e.parecer_tecnico.id, caso.parecer_id));
    const conta_ = await criarUsuario(amb.db, { login: "coord_jk", perfis: ["coordenador_csso"] });
    const [tecnico] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "tecnico_seguranca"));
    await amb.db.insert(e.atribuicao).values({
      usuario_id: conta_.id,
      perfil_id: tecnico!.id,
      campus_id: A,
      vigencia_inicio: "2020-01-01",
      ato_normativo: "Ato de teste",
    });
    await entrar(amb.cliente, "coord_jk");
    const r = await amb.cliente.get(`/pareceres/${caso.parecer_id}`, { seguir: false });
    expect(r.status).toBe(200);
  });

  it("secretaria no campus A + coordenador no campus B não anula o parecer de A", async () => {
    const [A, B] = await campi();
    const caso = await cenario(amb.db);
    await amb.db
      .update(e.parecer_tecnico)
      .set({ campus_id: A, situacao: "EMITIDO" })
      .where(eq(e.parecer_tecnico.id, caso.parecer_id));
    const conta_ = await criarUsuario(amb.db, { login: "sec_coord", perfis: ["secretaria_csso"], campus_id: A });
    const [coordenador] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "coordenador_csso"));
    await amb.db.insert(e.atribuicao).values({
      usuario_id: conta_.id,
      perfil_id: coordenador!.id,
      campus_id: B,
      vigencia_inicio: "2020-01-01",
      ato_normativo: "Ato de teste",
    });
    await entrar(amb.cliente, "sec_coord");
    // lê (a secretaria lê no campus A)…
    expect((await amb.cliente.get(`/pareceres/${caso.parecer_id}`, { seguir: false })).status).toBe(200);
    // …e não anula: para `parecer.anular` o parecer de A "não existe"
    const r = await amb.cliente.post(`/pareceres/${caso.parecer_id}/anular`, { motivo: "teste de alcance" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/processos");
    const [depois] = await amb.db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, caso.parecer_id));
    expect(depois!.situacao).toBe("EMITIDO");
  });

  it("D16: o almoxarife ligado a servidor abre as telas do titular sem somar servidor_consulta", async () => {
    const s = await servidor_novo("7654321", "Almoxarife Vinculado");
    await criarUsuario(amb.db, { login: "alm_ligado", perfis: ["almoxarife_sesmt"], servidor_id: s.id });
    await entrar(amb.cliente, "alm_ligado");
    for (const caminho of ["/turmas/minhas", "/certificados/meus", "/epis/requisicoes/nova", "/adicionais", "/"]) {
      const r = await amb.cliente.get(caminho);
      expect(r.status, caminho).toBe(200);
    }
    // o pedido é dele: o formulário vem travado no próprio nome, sem a busca de servidor
    const nova = await amb.cliente.get("/epis/requisicoes/nova");
    expect(nova.text).toContain("Almoxarife Vinculado");
    // e pedir para outro servidor é recusado
    const outro = await servidor_novo("1112223", "Outra Pessoa");
    const u = await carregar_usuario_atual(amb.db, (await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "alm_ligado")))[0]!.id);
    await expect(servico_requisicao.exigir_requerente_permitido(amb.db, u, outro)).rejects.toBeInstanceOf(PermissaoNegada);
    await expect(servico_requisicao.exigir_requerente_permitido(amb.db, u, s)).resolves.toBeUndefined();
  });

  it("D16: sem vínculo a servidor, o almoxarife continua sem as telas do titular", async () => {
    await entrar(amb.cliente, "almoxarife_sesmt");
    expect((await amb.cliente.get("/turmas/minhas")).status).toBe(403);
    expect((await amb.cliente.get("/certificados/meus")).status).toBe(403);
  });

  it("D18: concessão de governo com início futuro já trava a redefinição e a inativação pelo admin_ti", async () => {
    const futura = await criarUsuario(amb.db, {
      login: "futuro_super",
      perfis: ["superintendente"],
      vigencia_inicio: somar_dias(hoje_iso(), 7),
    });
    // hoje ela não concede nada…
    expect((await perfis_vigentes(amb.db, futura.id)).permissoes.has("perfil.conceder")).toBe(false);
    // …mas a trava pergunta pelo vigente OU futuro
    expect(
      (await perfis_vigentes(amb.db, futura.id, null, { incluir_futuras: true })).permissoes.has("perfil.conceder"),
    ).toBe(true);
    const [antes] = await amb.db.select().from(e.usuario).where(eq(e.usuario.id, futura.id));
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post(`/usuarios/${futura.id}/senha`);
    expect(r.text).toContain("é conta de administração");
    expect(r.text).not.toContain("Nova senha provisória de futuro_super");
    const [depois] = await amb.db.select().from(e.usuario).where(eq(e.usuario.id, futura.id));
    expect(depois!.senha_hash).toBe(antes!.senha_hash);
    const i = await amb.cliente.post(`/usuarios/${futura.id}/inativar`);
    expect(i.text).toContain("é conta de administração");
    const [ainda] = await amb.db.select().from(e.usuario).where(eq(e.usuario.id, futura.id));
    expect(ainda!.ativo).toBe(true);
  });
});
