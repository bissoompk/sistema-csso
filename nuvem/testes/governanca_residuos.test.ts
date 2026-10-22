/**
 * Resíduos da correção de governança de acesso (verificação de 22/10/2026),
 * depois dos quatro lotes:
 *
 * - D1/D16: a fila de pendências decidia pelo escopo da CONTA — o `admin_ti`
 *   ligado a servidor lia a fila inteira do setor; as telas de equipe abriam
 *   para qualquer conta ligada a servidor;
 * - D15: o almoxarife lia por inteiro a descrição de pendência de demanda;
 * - D9: atos de escrita achavam a linha pelo alcance da LEITURA (EPI,
 *   certificado), a ficha de EPI ignorava o campus, e o próprio certificado se
 *   anulava fora do campus;
 * - D1 (regressão): o indicador de treinamentos do `admin_ti` dependia do vínculo;
 * - D2: a segregação comparava só o conjunto de permissões, não o alcance;
 * - D3: a conta-fantoche contornava a segregação da habilitação;
 * - D7: o desbloqueio não tinha a trava de quem redefine;
 * - D12: login de uma conta igual ao e-mail de outra;
 * - D14: a ficha do processo listava o rascunho para a PROGEP;
 * - D21: eventos de governança suprimidos para quem audita, e o link "Histórico";
 * - D23: campus forjado alargava a concessão;
 * - D9/D15: supressão de tela sem recorte (/relatorios).
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import * as pendencias from "../src/servicos/pendencias.js";
import * as indicadores from "../src/servicos/treinamento_indicadores.js";
import {
  CONCESSAO_DO_TITULAR,
  MATRIZ_PERFIS,
  PERMISSOES_DO_TITULAR,
  UsuarioAtual,
  aplicar_escopo,
  carregar_usuario_atual,
  type Concessao,
} from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, usuarioAtual, type AmbienteDeTeste } from "./ajuda";
import { cenario as cenario_processo } from "./ajuda_processos";
import { TODAS, _cenario as cenario_certificado, _usuario } from "./ajuda_certificado.js";

const dialeto = new PgDialect();
const emSql = (c: ReturnType<typeof aplicar_escopo>) => (c ? dialeto.sqlToQuery(c) : null);

/** Uma conta montada como `carregar_usuario_atual` monta (ver escopo_por_permissao.test.ts). */
function montada(atribuicoes: [string, number | null][], servidor_id: number | null = null): UsuarioAtual {
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

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

async function conta(login: string) {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

async function perfil(codigo: string) {
  const [p] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, codigo));
  return p!;
}

async function servidor_novo(siape: string, nome: string, unidade_uorg_id: number | null = null) {
  const [s] = await amb.db.insert(e.servidor).values({ siape, nome, unidade_uorg_id }).returning();
  return s!;
}

/** Duas unidades de campi diferentes, e os dois campi. */
async function dois_campi() {
  const [u1] = await amb.db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [u2] = await amb.db.select().from(e.unidade_uorg).where(ne(e.unidade_uorg.campus_id, u1!.campus_id!)).limit(1);
  return { A: u1!.campus_id!, B: u2!.campus_id!, unidade_A: u1!.id, unidade_B: u2!.id };
}

async function conceder_direto(usuario_id: number, codigo: string, campus_id: number | null) {
  const p = await perfil(codigo);
  await amb.db
    .insert(e.atribuicao)
    .values({ usuario_id, perfil_id: p.id, campus_id, vigencia_inicio: "2020-01-01", ato_normativo: "Ato de teste" });
}

async function pendencia(d: { descricao: string; tipo?: string; responsavel_id?: number | null; entidade?: string; entidade_id?: number }) {
  const [p] = await amb.db
    .insert(e.pendencia)
    .values({
      tipo: d.tipo ?? "INCLUIR_NO_SEI",
      descricao: d.descricao,
      responsavel_id: d.responsavel_id ?? null,
      entidade: d.entidade ?? null,
      entidade_id: d.entidade_id ?? null,
      chave: `teste:${d.descricao}`,
    })
    .returning();
  return p!;
}

// =====================================================================
describe("D1/D16: a fila de pendências é de quem lê além do próprio dado", () => {
  it("admin_ti ligado a servidor vê só o que é dele, na tela e na API", async () => {
    const s = await servidor_novo("7654321", "Admin Servidor");
    const admin = await criarUsuario(amb.db, { login: "admin_srv", perfis: ["admin_ti"], servidor_id: s.id });
    await pendencia({ descricao: "Incluir no SEI o processo de Fulano Setor" });
    await pendencia({ descricao: "Ler a decisão do seu pedido de EPI", responsavel_id: admin.id });
    await entrar(amb.cliente, "admin_srv");
    const tela = await amb.cliente.get("/pendencias");
    expect(tela.status).toBe(200);
    expect(tela.text).not.toContain("Fulano Setor");
    const api = (await amb.cliente.get("/api/v1/pendencias")).json<{ abertas: number }>();
    expect(api.abertas).toBe(1);
  });

  it("almoxarife ligado a servidor continua vendo a fila do setor (epi.ver de unidade)", async () => {
    const s = await servidor_novo("7654322", "Almoxarife Servidor");
    await criarUsuario(amb.db, { login: "alm_srv", perfis: ["almoxarife_sesmt"], servidor_id: s.id });
    await pendencia({ descricao: "Repor luvas do lote 12" });
    await entrar(amb.cliente, "alm_srv");
    const api = (await amb.cliente.get("/api/v1/pendencias")).json<{ abertas: number }>();
    expect(api.abertas).toBe(1);
  });

  it("ve_a_fila_do_setor pergunta por permissão, não pela conta", () => {
    expect(pendencias.ve_a_fila_do_setor(montada([["admin_ti", null]], 9))).toBe(false);
    expect(pendencias.ve_a_fila_do_setor(montada([["servidor_consulta", null]], 9))).toBe(false);
    expect(pendencias.ve_a_fila_do_setor(montada([["almoxarife_sesmt", null]], 9))).toBe(true);
    expect(pendencias.ve_a_fila_do_setor(montada([["secretaria_csso", 3]]))).toBe(true);
  });
});

// =====================================================================
describe("D15: epi.ficha não lê o nome na pendência que não é de EPI", () => {
  it("almoxarife e secretaria leem a mesma frase neutra na pendência de demanda", async () => {
    const p = await pendencia({
      tipo: "DEMANDA_COM_PRAZO",
      descricao: "Avaliar laboratório — demanda de Fulano Secreto",
      entidade: "demanda",
      entidade_id: 999_999,
    });
    const alm = await usuarioAtual(amb.db, "almoxarife_sesmt");
    const sec = await usuarioAtual(amb.db, "secretaria_csso");
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    const texto = async (u: UsuarioAtual) => (await pendencias.leitura(amb.db, u, [p])).get(p.id)!.texto;
    expect(await texto(alm)).not.toContain("Fulano Secreto");
    expect(await texto(alm)).toBe(await texto(sec));
    expect(await texto(coord)).toContain("Fulano Secreto");
    await entrar(amb.cliente, "almoxarife_sesmt");
    expect((await amb.cliente.get("/pendencias")).text).not.toContain("Fulano Secreto");
  });

  it("na pendência de EPI o almoxarife continua lendo o nome", async () => {
    const p = await pendencia({
      tipo: "COMPROVANTE_EPI_PENDENTE",
      descricao: "Anexar o comprovante assinado por Beltrana Lotada",
      entidade: "epi_ficha_registro",
      entidade_id: 999_999,
    });
    const alm = await usuarioAtual(amb.db, "almoxarife_sesmt");
    expect((await pendencias.leitura(amb.db, alm, [p])).get(p.id)!.texto).toContain("Beltrana Lotada");
  });
});

// =====================================================================
describe("D16: as telas de equipe não abrem pela permissão do titular", () => {
  it("almoxarife ligado a servidor: matriz, catálogos, kanban e catálogo de cursos fecham; o estoque abre", async () => {
    const s = await servidor_novo("7654323", "Almoxarife Ligado");
    await criarUsuario(amb.db, { login: "alm_lig", perfis: ["almoxarife_sesmt"], servidor_id: s.id });
    await entrar(amb.cliente, "alm_lig");
    for (const caminho of ["/perfis", "/catalogos", "/kanban", "/treinamentos/catalogo"]) {
      expect((await amb.cliente.get(caminho)).status, caminho).toBe(403);
    }
    expect((await amb.cliente.get("/epis/estoque")).status).toBe(200);
  });

  it("admin_ti ligado a servidor não abre estoque nem kanban; o coordenador abre", async () => {
    const s = await servidor_novo("7654324", "Admin Ligado");
    await criarUsuario(amb.db, { login: "admin_lig", perfis: ["admin_ti"], servidor_id: s.id });
    await entrar(amb.cliente, "admin_lig");
    expect((await amb.cliente.get("/epis/estoque")).status).toBe(403);
    expect((await amb.cliente.get("/kanban")).status).toBe(403);
    await entrar(amb.cliente, "coordenador_csso");
    expect((await amb.cliente.get("/kanban")).status).toBe(200);
    expect((await amb.cliente.get("/catalogos")).status).toBe(200);
  });

  it("o servidor comum (escopo próprio) também não abre os catálogos", async () => {
    await entrar(amb.cliente, "servidor_consulta");
    expect((await amb.cliente.get("/catalogos")).status).toBe(403);
  });
});

// =====================================================================
describe("D9: o ato acha a linha pelo alcance DELE", () => {
  it("técnico no campus A + consulta PROGEP sem campus não analisa o pedido de EPI do campus B", async () => {
    const { A, B, unidade_B } = await dois_campi();
    const dono = await conta("servidor_consulta");
    const la = await servidor_novo("3030302", "Lotado Lá", unidade_B);
    const [pedido] = await amb.db
      .insert(e.epi_requisicao)
      .values({
        servidor_id: la.id,
        solicitado_por_id: dono.id,
        campus_id: B,
        estado: "ENVIADA",
        protocolo: "EPI-2026-9001",
        numero: 9001,
        ano: 2026,
        // pedido montado à mão, fora do envio: não passa pelo termo NR-06 (0015)
        termo_exigido: false,
      })
      .returning();
    const tec = await criarUsuario(amb.db, { login: "tec_a", perfis: ["tecnico_seguranca"], campus_id: A });
    await conceder_direto(tec.id, "consulta_progep", null);
    const u = await carregar_usuario_atual(amb.db, tec.id);
    const servico = await import("../src/servicos/epi_requisicao.js");
    // lê (a PROGEP lê todos os campi)…
    expect(await servico.no_escopo(amb.db, u, pedido!.id)).not.toBeNull();
    // …e não analisa: para `epi.analisar` o pedido de B "não existe"
    expect(await servico.no_escopo(amb.db, u, pedido!.id, "epi.analisar")).toBeNull();
    await entrar(amb.cliente, "tec_a");
    const r = await amb.cliente.post(`/epis/requisicoes/${pedido!.id}/analise`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/epis/requisicoes");
    const [depois] = await amb.db.select().from(e.epi_requisicao).where(eq(e.epi_requisicao.id, pedido!.id));
    expect(depois!.estado).toBe("ENVIADA");
  });

  it("anular certificado usa o alcance de certificado.anular, e não o da leitura", () => {
    const u = montada([["engenheiro_seguranca", 7], ["consulta_progep", null]]);
    expect(aplicar_escopo(u, e.certificado, ["certificado.ver", "treinamento.ver"])).toBeUndefined();
    const ato = emSql(aplicar_escopo(u, e.certificado, "certificado.anular"))!;
    expect(ato.sql).toContain('"campus_id" in');
    expect(ato.params).toEqual([7]);
  });

  it("ninguém anula nem corrige o próprio certificado", async () => {
    const montador = await _usuario(amb.db, TODAS, "montador");
    const dados = await cenario_certificado(amb.db, montador);
    await entrar(amb.cliente, "coordenador_csso");
    await amb.cliente.post(`/turmas/${dados.turma.id}/certificados`, { inscricao_id: dados.inscricao.id }, { seguir: false });
    const [cert] = await amb.db.select().from(e.certificado).orderBy(asc(e.certificado.id));
    expect(cert!.situacao).toBe("EMITIDO");
    // o coordenador passa a ser o titular do certificado
    const coord = await conta("coordenador_csso");
    await amb.db.update(e.usuario).set({ servidor_id: dados.servidor.id }).where(eq(e.usuario.id, coord.id));
    const r = await amb.cliente.post(`/certificados/${cert!.id}/anular`, { motivo: "quero outro" });
    expect(r.text).toContain("anular ou corrigir o próprio certificado é ato de outra pessoa");
    const c2 = await amb.cliente.post(`/certificados/${cert!.id}/corrigir`, { motivo: "nome", nome: "Outro Nome" });
    expect(c2.text).toContain("anular ou corrigir o próprio certificado");
    const [depois] = await amb.db.select().from(e.certificado).where(eq(e.certificado.id, cert!.id));
    expect(depois!.situacao).toBe("EMITIDO");
    expect(emissao.recusa_de_ato_sobre_o_proprio(await usuarioAtual(amb.db, "engenheiro_seguranca"), cert!)).toBeNull();
  });

  it("epi.ficha no campus A não abre a ficha de quem é lotado no campus B", async () => {
    const { A, unidade_A, unidade_B } = await dois_campi();
    const aqui = await servidor_novo("3030311", "Lotada Aqui", unidade_A);
    const la = await servidor_novo("3030312", "Lotada Lá", unidade_B);
    await criarUsuario(amb.db, { login: "alm_a", perfis: ["almoxarife_sesmt"], campus_id: A });
    await entrar(amb.cliente, "alm_a");
    expect((await amb.cliente.get(`/epis/fichas/${la.id}`)).status).toBe(403);
    expect((await amb.cliente.get(`/api/v1/epis/fichas/${la.id}`)).status).toBe(403);
    expect((await amb.cliente.get(`/epis/fichas/${aqui.id}`)).status).toBe(200);
  });
});

// =====================================================================
describe("D1 (regressão): o indicador do admin_ti não depende do vínculo", () => {
  // Desde 22/10/2026 o admin_ti não tem `indicador.ver` (decisão do usuário).
  // O que a regressão guardava continua valendo: ligado a servidor, ele não
  // passa a contar a instituição inteira pelo "cartaz" do titular.
  it("com e sem servidor, o admin_ti conta as mesmas turmas (nenhuma) e não abre a tela", async () => {
    const montador = await _usuario(amb.db, TODAS, "montador");
    await cenario_certificado(amb.db, montador);
    const sem = await carregar_usuario_atual(amb.db, (await conta("admin_ti")).id);
    expect(sem.pode("indicador.ver")).toBe(false);
    const filtro = { de: null, ate: null, unidade_promotora_id: null };
    const r_sem = await indicadores.calcular(amb.db, sem, filtro);
    expect(r_sem.turmas).toBe(0);
    const s = await servidor_novo("7654325", "Admin Indicador");
    const ligado = await criarUsuario(amb.db, { login: "admin_ind", perfis: ["admin_ti"], servidor_id: s.id });
    const r_com = await indicadores.calcular(amb.db, await carregar_usuario_atual(amb.db, ligado.id), filtro);
    expect(r_com.turmas).toBe(r_sem.turmas);
    await entrar(amb.cliente, "admin_ind");
    expect((await amb.cliente.get("/treinamentos/indicadores")).status).toBe(403);
  });

  it("o agregado só é coberto pela leitura nominal total ou sem campus", () => {
    // Nenhum perfil da matriz dá mais `indicador.ver` em agregado (o admin_ti
    // o perdeu em 22/10/2026); a concessão é montada à mão, como era, porque a
    // regra de cobertura continua valendo para o perfil agregado que vier.
    const coordenador_a = { perfil: "coordenador_csso", campus_id: 4, permissoes: MATRIZ_PERFIS.coordenador_csso!.permissoes };
    const agregado = { perfil: "admin_ti", campus_id: null, permissoes: [...MATRIZ_PERFIS.admin_ti!.permissoes, "indicador.ver"] };
    const u = new UsuarioAtual({
      id: 1,
      login: "x",
      nome: "x",
      permissoes: [...coordenador_a.permissoes, ...agregado.permissoes],
      perfis: ["coordenador_csso", "admin_ti"],
      concessoes: [coordenador_a, agregado],
    });
    expect(u.alcance("indicador.ver").agregado).toBe(true);
    expect(u.ve_dado_nominal_em("indicador.ver")).toBe(false);
    expect(montada([["coordenador_csso", null]]).ve_dado_nominal_em("indicador.ver")).toBe(true);
  });
});

// =====================================================================
describe("D9/D15: tela sem recorte pede leitura nominal em todo campus", () => {
  it("ve_dado_nominal_sem_recorte", () => {
    expect(montada([["coordenador_csso", 4]]).ve_dado_nominal_sem_recorte()).toBe(false);
    expect(montada([["coordenador_csso", null]]).ve_dado_nominal_sem_recorte()).toBe(true);
    expect(montada([["auditor_interno", null]]).ve_dado_nominal_sem_recorte()).toBe(true);
    expect(montada([["almoxarife_sesmt", null]]).ve_dado_nominal_sem_recorte()).toBe(false);
    expect(montada([["almoxarife_sesmt", null]]).ve_dado_nominal_sem_recorte(["exposicao.ver", "epi.ficha"])).toBe(true);
    expect(montada([["almoxarife_sesmt", 4]]).ve_dado_nominal_sem_recorte(["exposicao.ver", "epi.ficha"])).toBe(false);
  });

  it("/relatorios do coordenador recortado num campus sai com supressão", async () => {
    const { A } = await dois_campi();
    await criarUsuario(amb.db, { login: "coord_a", perfis: ["coordenador_csso"], campus_id: A });
    await entrar(amb.cliente, "coord_a");
    const r = await amb.cliente.get("/relatorios");
    expect(r.status).toBe(200);
    expect(r.text).toContain("aparece como <span class=\"mono\">—</span>");
    await entrar(amb.cliente, "coordenador_csso");
    const todos = await amb.cliente.get("/relatorios");
    expect(todos.status).toBe(200);
    expect(todos.text).not.toContain("aparece como <span class=\"mono\">—</span>");
  });
});

// =====================================================================
describe("D2: a segregação compara o alcance, não só o conjunto", () => {
  it("superintendente recortado num campus não concede auditor_interno nem perfil sem campus", async () => {
    const { A } = await dois_campi();
    await criarUsuario(amb.db, { login: "sup_a", perfis: ["superintendente"], campus_id: A });
    await entrar(amb.cliente, "sup_a");
    const alvo = await conta("tecnico_seguranca");
    const conceder = (perfil_id: number, campus_id: string) =>
      amb.cliente.post(
        "/usuarios/0/atribuicoes",
        { usuario_alvo: String(alvo.id), perfil_id: String(perfil_id), campus_id },
        { seguir: false },
      );
    const auditor = await conceder((await perfil("auditor_interno")).id, "");
    expect(auditor.text).toContain("ou com alcance maior que o seu");
    const sem_campus = await conceder((await perfil("secretaria_csso")).id, "");
    expect(sem_campus.text).toContain("ou com alcance maior que o seu");
    const no_campus = await conceder((await perfil("secretaria_csso")).id, String(A));
    expect(no_campus.status).toBe(303);
    const dele = await amb.db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, alvo.id), with: { perfil: true } });
    expect(dele.map((a) => [a.perfil.codigo, a.campus_id]).sort()).toEqual([
      ["secretaria_csso", A],
      ["tecnico_seguranca", null],
    ]);
  });
});

// =====================================================================
describe("D23: campus forjado não alarga a concessão", () => {
  it("campus_id que não é número é recusado e reabre o popup", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("tecnico_seguranca");
    const r = await amb.cliente.post(
      "/usuarios/0/atribuicoes",
      { usuario_alvo: String(alvo.id), perfil_id: String((await perfil("secretaria_csso")).id), campus_id: "1 OR 1=1" },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("campus inválido.");
    expect(r.text).toMatch(/<dialog[^>]*id="conceder-perfil"[^>]*\sopen>/);
    const dele = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.usuario_id, alvo.id));
    expect(dele).toHaveLength(1);
  });
});

// =====================================================================
describe("D12: login de uma conta igual ao e-mail de outra", () => {
  it("a criação recusa o login que já é e-mail de outra conta, e o e-mail que já é login", async () => {
    await entrar(amb.cliente, "admin_ti");
    const outra = await conta("coordenador_csso");
    const r = await amb.cliente.post("/usuarios", { login: outra.email.toUpperCase(), nome: "Cruzada", email: "cruzada@teste.ufvjm.edu.br" });
    expect(r.text).toContain("Já existe conta com este login");
    const r2 = await amb.cliente.post("/usuarios", { login: "cruzada", nome: "Cruzada", email: "Coordenador_CSSO" });
    expect(r2.text).toContain("Já existe conta com este e-mail");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.nome, "Cruzada"))).toHaveLength(0);
  });
});

// =====================================================================
describe("D3: a conta-fantoche não recebe a habilitação de quem a criou", () => {
  async function atestar(campos: Record<string, string>) {
    return amb.cliente.post("/habilitacoes", {
      nome: "Profissional Teste",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "Eng. Seg. do Trabalho",
      ...campos,
    });
  }

  it("o superintendente cria a conta com perfil técnico e não a liga à habilitação que ele atesta", async () => {
    await entrar(amb.cliente, "superintendente");
    const coord = await perfil("coordenador_csso");
    const criada = await amb.cliente.post("/usuarios", {
      login: "fantoche",
      nome: "Fantoche",
      email: "fantoche@teste.ufvjm.edu.br",
      perfil_id: String(coord.id),
    });
    expect(criada.text).toContain("Senha provisória");
    const fantoche = await conta("fantoche");
    // ele mesmo faria a troca obrigatória: a marca de provisória não segura nada
    await amb.db.update(e.usuario).set({ precisa_trocar_senha: false }).where(eq(e.usuario.id, fantoche.id));
    const r = await atestar({ usuario_alvo_id: String(fantoche.id), externo: "1", justificativa_art10_par5: "sem quadro" });
    expect(r.text).toContain("não a liga a conta que ele criou ou cuja senha redefiniu");
    expect(await amb.db.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.usuario_id, fantoche.id))).toHaveLength(0);
    const recusas = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "HABILITACAO_RECUSADA"));
    expect(recusas).toHaveLength(1);
  });

  it("nem a conta cuja senha ele redefiniu", async () => {
    const s = await servidor_novo("1234567", "Engenheira Real");
    const alvo = await criarUsuario(amb.db, { login: "eng_real", perfis: ["engenheiro_seguranca"], servidor_id: s.id });
    await entrar(amb.cliente, "superintendente");
    await amb.cliente.post(`/usuarios/${alvo.id}/senha`, {});
    await amb.db.update(e.usuario).set({ precisa_trocar_senha: false }).where(eq(e.usuario.id, alvo.id));
    const r = await atestar({ siape: "1234567", usuario_alvo_id: String(alvo.id) });
    expect(r.text).toContain("cuja senha redefiniu");
  });

  it("habilitação interna pede SIAPE, conta vinculada ao mesmo servidor e senha já assumida", async () => {
    const s = await servidor_novo("1234568", "Engenheiro Assumido");
    const sem_servidor = await criarUsuario(amb.db, { login: "eng_solto", perfis: ["engenheiro_seguranca"] });
    const provisoria = await criarUsuario(amb.db, {
      login: "eng_novo",
      perfis: ["engenheiro_seguranca"],
      servidor_id: (await servidor_novo("1234569", "Engenheiro Novo")).id,
      precisa_trocar_senha: true,
    });
    const certa = await criarUsuario(amb.db, { login: "eng_ok", perfis: ["engenheiro_seguranca"], servidor_id: s.id });
    await entrar(amb.cliente, "superintendente");
    expect((await atestar({ usuario_alvo_id: String(certa.id) })).text).toContain("informe o SIAPE");
    expect((await atestar({ siape: "1234568", usuario_alvo_id: String(sem_servidor.id) })).text).toContain(
      "não está vinculada a servidor",
    );
    expect((await atestar({ siape: "1234569", usuario_alvo_id: String(provisoria.id) })).text).toContain(
      "ainda está com a senha provisória",
    );
    const ok = await atestar({ siape: "1234568", usuario_alvo_id: String(certa.id) });
    expect(ok.text).toContain("Habilitação registrada");
    // e a habilitação externa, com a justificativa, se liga à conta sem servidor
    const externa = await atestar({
      nome: "Externo",
      usuario_alvo_id: String(sem_servidor.id),
      externo: "1",
      justificativa_art10_par5: "sem profissional no quadro",
    });
    expect(externa.text).toContain("Habilitação registrada");
  });
});

// =====================================================================
describe("D7: desbloquear segue a trava de quem redefine", () => {
  it("o admin_ti não desbloqueia o superintendente nem o médico", async () => {
    const ate = new Date(Date.now() + 15 * 60_000);
    for (const login of ["superintendente", "medico_trabalho"]) {
      await amb.db.update(e.usuario).set({ bloqueado_ate: ate, tentativas_falhas: 5 }).where(eq(e.usuario.login, login));
    }
    await entrar(amb.cliente, "admin_ti");
    const tela = (await amb.cliente.get("/usuarios")).text;
    for (const login of ["superintendente", "medico_trabalho"]) {
      const alvo = await conta(login);
      expect(tela).not.toContain(`action="/usuarios/${alvo.id}/desbloquear"`);
      const r = await amb.cliente.post(`/usuarios/${alvo.id}/desbloquear`, {}, { seguir: false });
      expect(r.status).toBe(200);
      expect(r.text).toContain("não foi desbloqueada");
      expect((await conta(login)).bloqueado_ate).not.toBeNull();
    }
    expect(await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "CONTA_DESBLOQUEADA"))).toHaveLength(0);
  });
});

// =====================================================================
describe("D14: a ficha do processo não mostra o rascunho à Consulta PROGEP", () => {
  it("a PROGEP não vê a linha do parecer em rascunho; o coordenador vê", async () => {
    const caso = await cenario_processo(amb.db);
    const [p] = await amb.db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, caso.parecer_id));
    expect(p!.situacao).toBe("RASCUNHO");
    await entrar(amb.cliente, "consulta_progep");
    const progep = await amb.cliente.get(`/processos/${caso.processo_id}?aba=parecer`);
    expect(progep.status).toBe(200);
    expect(progep.text).not.toContain(`href="/pareceres/${caso.parecer_id}"`);
    expect(progep.text).toContain("Nenhum parecer.");
    await entrar(amb.cliente, "coordenador_csso");
    expect((await amb.cliente.get(`/processos/${caso.processo_id}?aba=parecer`)).text).toContain(
      `href="/pareceres/${caso.parecer_id}"`,
    );
  });
});

// =====================================================================
describe("D21/D22: a trilha de governança para quem audita acesso", () => {
  it("o admin_ti lê USUARIO_ALTERADO e PERFIL_CANCELADO, e o Gerir leva ao histórico da conta", async () => {
    const alvo = await conta("tecnico_seguranca");
    const sup = await usuarioAtual(amb.db, "superintendente");
    const [a] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.usuario_id, alvo.id));
    await naTransacao(async (tx) => {
      await auditoria.registrar(tx, {
        entidade: "usuario",
        entidade_id: alvo.id,
        tipo_evento: "USUARIO_ALTERADO",
        descricao: "Conta 'tecnico_seguranca': nome alterado.",
        usuario: sup,
      });
      await auditoria.registrar(tx, {
        entidade: "atribuicao",
        entidade_id: a!.id,
        tipo_evento: "PERFIL_CANCELADO",
        descricao: "Concessão futura do perfil x a 'tecnico_seguranca' cancelada antes do início.",
        usuario: sup,
      });
    });
    await entrar(amb.cliente, "admin_ti");
    const trilha = (await amb.cliente.get(`/auditoria?conta_id=${alvo.id}`)).text;
    expect(trilha).toContain("nome alterado.");
    expect(trilha).toContain("cancelada antes do início.");
    expect((await amb.cliente.get("/usuarios")).text).toContain(`href="/auditoria?conta_id=${alvo.id}"`);
  });

  it("o evento de substituição na assinatura tem rótulo", () => {
    expect(auditoria.ROTULO_EVENTO[auditoria.ASSINATURA_REGISTRADA_POR_SUBSTITUTO]).toBe("Assinatura registrada por substituto");
  });
});
