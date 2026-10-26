/**
 * Cargo e lotação pedidos no uso (26/10/2026): o cadastro não pergunta; o pedido
 * de EPI e a comunicação de acidente exigem, e o catálogo cresce com o que se
 * digita (marcado «a conferir», sem duplicar a mesma grafia).
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as df from "../src/servicos/dados_funcionais.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";
import { cenario, recado, type Cenario } from "./ajuda_epi_ficha";

const FILA = "/epis/requisicoes";
await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
const como = (amb: Amb, login: string): Promise<Cliente> => entrar(amb.novoCliente(), login);
const entrada = (o: Partial<df.EntradaFuncional> = {}): df.EntradaFuncional => ({
  cargo_id: "",
  cargo_novo: "",
  unidade_uorg_id: "",
  lotacao_nova: "",
  lotacao_campus_id: "",
  ...o,
});

function pedir(cliente: Cliente, servidor_id: number, cen: Cenario, extra: Record<string, string> = {}) {
  return cliente.post(
    FILA,
    {
      servidor_id: String(servidor_id),
      chefia_servidor_id: "",
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes",
      riscos_declarados: "Respingo de ácido",
      urgencia: "NORMAL",
      justificativa_urgencia: "",
      item_id: String(cen.item),
      quantidade: "1",
      tamanho: "M",
      justificativa: "",
      motivo: "DESGASTE",
      termo_aceito: "1",
      acao: "",
      ...extra,
    },
    { seguir: false },
  );
}

/** O servidor do cenário como ele chega do Cadastre-se: sem cargo e sem lotação. */
async function sem_funcionais(amb: Amb, cen: Cenario, login = "servidor_consulta") {
  await amb.db.update(e.servidor).set({ cargo_id: null, unidade_uorg_id: null }).where(eq(e.servidor.id, cen.servidor));
  await amb.db.update(e.usuario).set({ servidor_id: cen.servidor }).where(eq(e.usuario.login, login));
}
const um_campus = async (amb: Amb) => String((await amb.db.select().from(e.campus).orderBy(asc(e.campus.id)))[0]!.id);

describe("o catálogo cresce com o que se digita", () => {
  it("cargo novo entra «a conferir»; a mesma grafia (caixa, acento, espaço) devolve o que já existe", async () => {
    const amb = await novo();
    const a = await df.resolver(amb.db, entrada({ cargo_novo: "  Técnico   de Laboratório X " }), null);
    const b = await df.resolver(amb.db, entrada({ cargo_novo: "TECNICO DE LABORATORIO x" }), null);
    expect(b.cargo_id).toBe(a.cargo_id);
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.id, a.cargo_id!));
    expect(cargo).toMatchObject({ nome: "Técnico de Laboratório X", a_conferir: true });
  });

  it("lotação digitada pede o campus, entra «a conferir», e a mesma grafia não duplica", async () => {
    const amb = await novo();
    await expect(df.resolver(amb.db, entrada({ lotacao_nova: "Lab de Química Nova" }), null)).rejects.toThrow(/campus/);
    const campus_id = await um_campus(amb);
    const a = await df.resolver(amb.db, entrada({ lotacao_nova: "Lab de Química Nova", lotacao_campus_id: campus_id }), null);
    const b = await df.resolver(amb.db, entrada({ lotacao_nova: "LAB DE QUIMICA NOVA", lotacao_campus_id: campus_id }), null);
    expect(b.unidade_uorg_id).toBe(a.unidade_uorg_id);
    const [u] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.id, a.unidade_uorg_id!));
    expect(u).toMatchObject({ nome_extenso: "Lab de Química Nova", a_conferir: true, tipo: "OUTRO" });
  });

  it("lotação que já existe (por nome ou sigla) não pede campus nem cria outra", async () => {
    const amb = await novo();
    const [u] = await amb.db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const antes = (await amb.db.select().from(e.unidade_uorg)).length;
    const r = await df.resolver(amb.db, entrada({ lotacao_nova: u!.nome_extenso.toUpperCase() }), null);
    expect(r.unidade_uorg_id).toBe(u!.id);
    expect(await amb.db.select().from(e.unidade_uorg)).toHaveLength(antes);
  });

  it("conferir: abrir o cargo no catálogo e salvar tira a marca", async () => {
    const amb = await novo();
    const { cargo_id } = await df.resolver(amb.db, entrada({ cargo_novo: "Cargo Digitado" }), null);
    const adm = await como(amb, "superintendente");
    const r = await adm.post("/catalogos/cargos", { cargo_id: String(cargo_id), nome: "Cargo Digitado", codigo_siape: "" }, { seguir: false });
    expect(r.status, recado(r)).toBe(303);
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.id, cargo_id!));
    expect(cargo!.a_conferir).toBe(false);
  });
});

describe("pedido de EPI", () => {
  it("sem cargo e lotação no cadastro, o pedido é recusado e nada fica no catálogo", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const cargos_antes = (await amb.db.select().from(e.cargo)).length;
    const cli = await como(amb, "servidor_consulta");
    const tela = await cli.get(`${FILA}/nova`);
    expect(tela.text).toContain("Seu cargo e sua lotação");
    // só o cargo digitado: falta a lotação → recusa, e o cargo digitado NÃO fica (savepoint)
    const r = await pedir(cli, cen.servidor, cen, { cargo_novo: "Cargo Só Digitado" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Para pedir EPI informe a lotação");
    expect(r.text).toContain("Cargo Só Digitado");
    expect((await amb.db.select().from(e.epi_requisicao)).length).toBe(0);
    expect(await amb.db.select().from(e.cargo)).toHaveLength(cargos_antes);
  });

  it("digitando cargo e lotação, o pedido sai e o cadastro e o catálogo são completados", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const cli = await como(amb, "servidor_consulta");
    const r = await pedir(cli, cen.servidor, cen, {
      cargo_novo: "Cargo Que Não Existia",
      lotacao_nova: "Setor Que Não Existia",
      lotacao_campus_id: await um_campus(amb),
    });
    expect(r.status, recado(r)).toBe(303);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor));
    expect(sv!.cargo_id).not.toBeNull();
    expect(sv!.unidade_uorg_id).not.toBeNull();
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.id, sv!.cargo_id!));
    expect(cargo).toMatchObject({ nome: "Cargo Que Não Existia", a_conferir: true });
    // com os dados no cadastro, a tela só os mostra
    const tela = await cli.get(`${FILA}/nova`);
    expect(tela.text).toContain("Cargo Que Não Existia");
    expect(tela.text).not.toContain('id="cargo-e-lotacao"');
  });

  it("escolher da lista também completa; o que já está no cadastro não é sobrescrito", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const [cg] = await amb.db.insert(e.cargo).values({ nome: "Cargo Da Lista" }).returning();
    const [u] = await amb.db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    await amb.db.update(e.servidor).set({ cargo_id: cg!.id }).where(eq(e.servidor.id, cen.servidor));
    const cli = await como(amb, "servidor_consulta");
    const r = await pedir(cli, cen.servidor, cen, { cargo_novo: "Outro Cargo Qualquer", unidade_uorg_id: String(u!.id) });
    expect(r.status, recado(r)).toBe(303);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor));
    expect(sv).toMatchObject({ cargo_id: cg!.id, unidade_uorg_id: u!.id });
  });

  it("a equipe pedindo por um servidor sem cargo ou lotação: recusa dizendo de quem", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const r = await pedir(await como(amb, "coordenador_csso"), cen.servidor, cen);
    expect(r.status).toBe(200);
    expect(r.text).toContain("está sem o cargo e a lotação");
  });
});

describe("Meu perfil", () => {
  it("o servidor corrige digitando um cargo e uma lotação novos", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const cli = await como(amb, "servidor_consulta");
    const r = await cli.post(
      "/minha-conta/funcionais",
      { cargo_novo: "Cargo Do Perfil", lotacao_nova: "Lotação Do Perfil", lotacao_campus_id: await um_campus(amb), funcao: "" },
      { seguir: false },
    );
    expect(r.status, recado(r)).toBe(303);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor));
    const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.id, sv!.cargo_id!));
    expect(cargo!.nome).toBe("Cargo Do Perfil");
  });

  it("lotação digitada sem campus: recusa na tela e nada fica no catálogo", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const cli = await como(amb, "servidor_consulta");
    const antes = (await amb.db.select().from(e.cargo)).length;
    const r = await cli.post("/minha-conta/funcionais", { cargo_novo: "Cargo Que Volta", lotacao_nova: "Sem Campus", funcao: "" }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Escolha o campus");
    expect(await amb.db.select().from(e.cargo)).toHaveLength(antes);
  });
});

describe("comunicação de acidente", () => {
  const form = (extra: Record<string, string> = {}) => ({
    env_indice: "1",
    env_1_sou_eu: "1",
    env_1_vinculo: "SERVIDOR",
    env_1_condicao: "ACIDENTADO",
    env_1_houve_lesao: "SIM",
    especie: "TIPICO",
    data_evento: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
    hora_evento: "10:15",
    jornada: "01:30",
    local_tipo: "LABORATORIO",
    local_especificacao: "Laboratório fictício",
    local_uf: "MG",
    descricao: "A bandeja escorregou da prateleira durante a arrumação.",
    test_1_nome: "Testemunha Fictícia",
    test_1_contato: "ramal 999",
    declaracao: "1",
    ...extra,
  });

  it("o próprio envolvido, sem cargo e lotação no cadastro, precisa informá-los", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await sem_funcionais(amb, cen);
    const cli = await como(amb, "servidor_consulta");
    const tela = await cli.get("/acidentes/comunicar");
    expect(tela.text).toContain("obrigatórios, faltam no seu cadastro");
    const r = await cli.post("/acidentes/comunicar", form(), { seguir: false });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Informe o cargo e a lotação");
    const ok = await cli.post(
      "/acidentes/comunicar",
      form({ env_1_cargo_novo: "Cargo Do Acidente", env_1_lotacao_nova: "Lotação Do Acidente", env_1_lotacao_campus_id: await um_campus(amb) }),
      { seguir: false },
    );
    expect(ok.status, recado(ok)).toBe(303);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, cen.servidor));
    expect(sv!.cargo_id).not.toBeNull();
    expect(sv!.unidade_uorg_id).not.toBeNull();
  });
});
