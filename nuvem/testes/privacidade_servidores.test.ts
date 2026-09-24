/**
 * RN-19 / CA-18 nas telas da base: /servidores, a ficha e a trilha.
 * Porte das partes de `test_privacidade.py` que tocam as telas deste trecho
 * (as de painel, kanban, processos e parecer são do porte de Processos).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as auditoria from "../src/servicos/auditoria.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type AmbienteDeTeste } from "./ajuda";

const NOME = "Marco Antônio Alves Schetino";
const SIAPE = "1110654";
const SRV = /SRV-[0-9a-f]{4}\b/g;

let amb: AmbienteDeTeste = await bancoLimpo();
let servidor: number;
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
  const [sv] = await amb.db
    .insert(e.servidor)
    .values({ siape: SIAPE, nome: NOME, cargo_id: cargo!.id, unidade_uorg_id: famed!.id })
    .returning();
  servidor = sv!.id;
});

async function titular() {
  await amb.db.update(e.usuario).set({ servidor_id: servidor }).where(eq(e.usuario.login, "servidor_consulta"));
}

describe("CA-18 e RN-19 em /servidores", () => {
  it("consulta com permissão gera registro de acesso sensível", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.get(`/servidores/${servidor}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(NOME);
    const acessos = await amb.db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.servidor_id, servidor));
    expect(acessos.length).toBeGreaterThan(0);
    expect(acessos[0]!.campo).toBe("servidor.ficha");
    expect(acessos[0]!.finalidade).toBeTruthy();
  });

  it("sem permissão a matrícula vira identificador opaco, e não máscara parcial", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const r = await amb.cliente.get("/servidores");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(NOME);
    expect(r.text).not.toContain(SIAPE);
    expect(r.text).toContain("SRV-");
    for (const parcial of ["111****", "***0654", "1110***"]) expect(r.text).not.toContain(parcial);
  });

  it("busca por nome não é oráculo do código opaco", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const corpo = (await amb.cliente.get("/servidores?q=Marco")).text;
    expect(corpo.match(SRV)).toBeNull();
    expect(corpo).toContain("Nenhum servidor");
  });

  it("busca por SIAPE continua valendo sem exposicao.ver", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const corpo = (await amb.cliente.get(`/servidores?q=${SIAPE}`)).text;
    expect(corpo.match(SRV)).not.toBeNull();
    expect(corpo).not.toContain(NOME);
  });

  it("quem vê nome continua buscando por nome", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    expect((await amb.cliente.get("/servidores?q=Marco")).text).toContain(NOME);
  });

  it("o titular acha o próprio nome na busca e lê a própria ficha", async () => {
    await titular();
    await entrar(amb.cliente, "servidor_consulta");
    expect((await amb.cliente.get("/servidores?q=Marco")).text).toContain(NOME);
    expect((await amb.cliente.get(`/servidores/${servidor}`)).text).toContain(NOME);
    // e ler o próprio não é leitura de terceiro (LGPD art. 18, II)
    const acessos = await amb.db.select().from(e.acesso_dado_sensivel);
    expect(acessos).toHaveLength(0);
  });

  it("o escopo próprio não vê a ficha de outra pessoa", async () => {
    await titular();
    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1473142", nome: "Gabriela Silva" }).returning();
    await entrar(amb.cliente, "servidor_consulta");
    const lista = (await amb.cliente.get("/servidores")).text;
    expect(lista).not.toContain(`/servidores/${outro!.id}"`);
    const ficha = await amb.cliente.get(`/servidores/${outro!.id}`, { seguir: false });
    expect(ficha.status).toBe(303);
    expect(ficha.location).toBe("/servidores");
  });

  it("a ficha não entrega nome nem SIAPE no formulário de quem não os lê", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const corpo = (await amb.cliente.get(`/servidores/${servidor}`)).text;
    expect(corpo).not.toContain(NOME);
    expect(corpo).not.toContain(SIAPE);
  });

  it("e o POST da identificação também é recusado a quem não lê", async () => {
    await entrar(amb.cliente, "secretaria_csso");
    const r = await amb.cliente.post(`/servidores/${servidor}`, { nome: "Outro", siape: SIAPE, situacao: "ATIVO" });
    expect(r.status).toBe(403);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, servidor));
    expect(sv!.nome).toBe(NOME);
  });

  it("o código opaco é o mesmo em /servidores e /demandas na mesma sessão", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    await amb.cliente.post(
      "/demandas",
      { assunto: "Pedido", canal: "EMAIL", solicitante_nome: "pedido", solicitante_servidor_id: String(servidor) },
      { seguir: false },
    );
    await entrar(amb.cliente, "secretaria_csso");
    const a = new Set((await amb.cliente.get("/servidores")).text.match(SRV));
    const b = new Set((await amb.cliente.get("/demandas")).text.match(SRV));
    expect(a.size).toBe(1);
    for (const codigo of b) expect(a.has(codigo)).toBe(true);
  });
});

describe("RN-19 na trilha", () => {
  it("auditoria não entrega nome a quem só audita; o titular e a CSSO leem", async () => {
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    await auditoria.registrar(amb.db, {
      entidade: "servidor",
      entidade_id: servidor,
      tipo_evento: "COMENTARIO",
      descricao: `Conversa com ${NOME} (SIAPE ${SIAPE}) sobre o laboratório`,
      usuario: coord,
    });
    await entrar(amb.cliente, "admin_ti");
    const corpo = (await amb.cliente.get("/auditoria")).text;
    expect(corpo).not.toContain(NOME);
    expect(corpo).not.toContain(SIAPE);
    await entrar(amb.cliente, "auditor_interno");
    expect((await amb.cliente.get("/auditoria")).text).toContain(NOME);
  });

  it("a trilha de LOTACAO_ALTERADA sai com o diff por campo", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const [ica] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "261"));
    await amb.cliente.post(
      `/servidores/${servidor}/lotacao`,
      { a_partir_de: "2024-05-10", unidade_uorg_id: String(ica!.id) },
      { seguir: false },
    );
    const eventos = await amb.db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "servidor_lotacao"), eq(e.historico_evento.campo, "unidade")));
    expect(eventos).toHaveLength(1);
    expect((await auditoria.cadeia_integra(amb.db))[0]).toBe(true);
  });
});
