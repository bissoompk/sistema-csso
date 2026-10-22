/**
 * NUVEM: as turmas por setor promotor (`servicos/setor_equipe.ts`).
 *
 * Cada setor vê e gere só as turmas que promove — e as inscrições, os pedidos,
 * a emissão e os certificados delas. A turma sem setor (de antes dos setores)
 * é da CSSO. Quem tem `turma.todos_os_setores` vê todas; a conta de equipe
 * sem setor não vê nenhuma (e a tela diz por quê); o titular continua vendo
 * as próprias inscrições e certificados, de qualquer setor.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as servico_emissao from "../src/servicos/emissao_certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import * as setor_equipe from "../src/servicos/setor_equipe.js";
import * as servico_turma from "../src/servicos/turma.js";
import { RegraDaTurma } from "../src/servicos/turma.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { INICIO, _modelo_com_tags } from "./ajuda_certificado";

let db: Banco;
let novoCliente: () => Cliente;

const AVISO = "Sua conta não está vinculada a nenhum setor promotor";

interface TurmaComCertificado {
  turma: servico_turma.TurmaCarregada;
  inscricao_id: number;
  certificado_id: number;
}

let csso_id: number;
let cpel_id: number;
let t_csso: TurmaComCertificado;
let t_cpel: TurmaComCertificado;
let t_sem: TurmaComCertificado;
let treinamento: typeof e.treinamento.$inferSelect;

async function _unidade(sigla: string): Promise<number> {
  const [u] = await db.select({ id: e.unidade_uorg.id }).from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla));
  return u!.id;
}

/** Turma concluída com um servidor aprovado e o certificado emitido. */
async function _turma_emitida(
  quem: UsuarioAtual,
  unidade_promotora_id: number | null,
  servidor: typeof e.servidor.$inferSelect,
): Promise<TurmaComCertificado> {
  const turma = await servico_turma.criar_turma(db, quem, {
    treinamento,
    data_inicio: INICIO,
    data_fim: INICIO,
    local: "Auditório",
    unidade_promotora_id,
  });
  const [instrutor] = await db.select().from(e.assinatura_instrutor).limit(1);
  await servico_turma.vincular_instrutor(db, quem, turma, { ...instrutor!, servidor: null });
  const pessoa = await servico_participante.de_servidor(db, servidor, quem);
  const inscricao = await servico_turma.inscrever(db, quem, turma, pessoa);
  await servico_turma.mudar_situacao(db, quem, turma, "EM_ANDAMENTO");
  await servico_presenca.lancar_presenca(db, quem, inscricao, { data: INICIO, presente: true, horas: "8" });
  await servico_turma.mudar_situacao(db, quem, turma, "CONCLUIDA");
  const fresca = (await servico_turma.carregar_turma(db, turma.id))!;
  const relida = (await servico_turma.carregar_inscricao(db, inscricao.id, fresca))!;
  const emitido = await servico_emissao.emitir(db, quem, relida, { gerar_pdf: false });
  return { turma: fresca, inscricao_id: inscricao.id, certificado_id: emitido.certificado.id };
}

async function _cliente(login: string): Promise<Cliente> {
  return entrar(novoCliente(), login);
}

beforeAll(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
  csso_id = (await db
    .select({ id: e.unidade_uorg.id })
    .from(e.unidade_uorg)
    .where(eq(e.unidade_uorg.sigla, "CSSO")))[0]!.id;
  cpel_id = await _unidade("CPEL");

  const [s_csso] = await db.insert(e.servidor).values({ siape: "2000001", nome: "Ana da CSSO" }).returning();
  const [s_cpel] = await db.insert(e.servidor).values({ siape: "2000002", nome: "Bruno da CPEL" }).returning();
  const [s_sem] = await db.insert(e.servidor).values({ siape: "2000003", nome: "Carla Antiga" }).returning();

  await criarUsuario(db, { login: "tec_csso", perfis: ["tecnico_seguranca"] });
  await criarUsuario(db, { login: "tec_cpel", perfis: ["tecnico_seguranca"], setores: ["CPEL"] });
  await criarUsuario(db, { login: "eng_cpel", perfis: ["engenheiro_seguranca"], setores: ["CPEL"] });
  await criarUsuario(db, { login: "tec_sem", perfis: ["tecnico_seguranca"], setores: [] });
  await criarUsuario(db, { login: "tec_dois", perfis: ["tecnico_seguranca"], setores: ["CSSO", "CPEL"] });
  // o titular puro, com certificado da CPEL
  await criarUsuario(db, { login: "titular_cpel", perfis: ["servidor_consulta"], servidor_id: s_cpel!.id });
  // da equipe da CPEL e participante de turma da CSSO
  await criarUsuario(db, { login: "cpel_aluna_csso", perfis: ["tecnico_seguranca"], setores: ["CPEL"], servidor_id: s_csso!.id });

  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo: "NR-10", nome: "Segurança em Eletricidade — NR-10", carga_horaria_horas: "8", validade_meses: 24 })
    .returning();
  const modelo = await _modelo_com_tags(db, t!);
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, t!.id));
  treinamento = (await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id)))[0]!;
  await db.insert(e.assinatura_instrutor).values({
    nome: "Instrutor de Teste",
    titulo: "Engenheiro de Segurança do Trabalho",
    conselho: "CREA",
    registro_conselho: "MG-1",
    externo: true,
    vigencia_inicio: "2020-01-01",
  });

  const coord = await usuarioAtual(db, "coordenador_csso");
  t_csso = await _turma_emitida(coord, csso_id, s_csso!);
  t_cpel = await _turma_emitida(coord, cpel_id, s_cpel!);
  t_sem = await _turma_emitida(coord, null, s_sem!);
});

describe("a lista de turmas", () => {
  it("a conta da CSSO vê a turma da CSSO e a sem setor, e não a da CPEL", async () => {
    const r = await (await _cliente("tec_csso")).get("/turmas");
    expect(r.status).toBe(200);
    expect(r.text).toContain(t_csso.turma.codigo);
    expect(r.text).toContain(t_sem.turma.codigo);
    expect(r.text).not.toContain(t_cpel.turma.codigo);
    expect(r.text).not.toContain(AVISO);
  });

  it("a conta da CPEL vê só a dela", async () => {
    const r = await (await _cliente("tec_cpel")).get("/turmas");
    expect(r.text).toContain(t_cpel.turma.codigo);
    expect(r.text).not.toContain(t_csso.turma.codigo);
    expect(r.text).not.toContain(t_sem.turma.codigo);
  });

  it("a coordenação e a superintendência veem todas", async () => {
    for (const login of ["coordenador_csso", "superintendente"]) {
      const r = await (await _cliente(login)).get("/turmas");
      for (const t of [t_csso, t_cpel, t_sem]) expect(r.text, login).toContain(t.turma.codigo);
    }
  });

  it("a conta de equipe sem setor vê lista vazia e o aviso", async () => {
    const c = await _cliente("tec_sem");
    const r = await c.get("/turmas");
    expect(r.status).toBe(200);
    for (const t of [t_csso, t_cpel, t_sem]) expect(r.text).not.toContain(t.turma.codigo);
    expect(r.text).toContain(AVISO);
    for (const tela of ["/turmas/pedidos", "/treinamentos", "/certificados", "/certificados/fila", "/certificados/emails", "/certificados/vencimentos", "/treinamentos/indicadores"]) {
      const t = await c.get(tela);
      expect(t.status, tela).toBe(200);
      expect(t.text, tela).toContain(AVISO);
    }
  });

  it("o aviso não aparece para quem tem setor nem para quem vê todos", async () => {
    for (const login of ["tec_cpel", "coordenador_csso", "auditor_interno"]) {
      const r = await (await _cliente(login)).get("/certificados");
      expect(r.text, login).not.toContain(AVISO);
    }
  });
});

describe("a ficha e os atos de turma de outro setor", () => {
  it("a ficha da turma da CPEL não abre para a CSSO (volta à lista)", async () => {
    const c = await _cliente("tec_csso");
    const r = await c.get(`/turmas/${t_cpel.turma.id}`, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/turmas");
    const propria = await c.get(`/turmas/${t_csso.turma.id}`, { seguir: false });
    expect(propria.status).toBe(200);
    const antiga = await c.get(`/turmas/${t_sem.turma.id}`, { seguir: false });
    expect(antiga.status).toBe(200);
  });

  it("editar, inscrever, mudar a situação e baixar a lista de presença de outro setor não fazem nada", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    const aberta = await servico_turma.criar_turma(db, coord, {
      treinamento,
      data_inicio: "2099-03-01",
      data_fim: "2099-03-01",
      local: "Sala da CPEL",
      unidade_promotora_id: cpel_id,
    });
    const c = await _cliente("tec_csso");
    const editar = await c.post(
      `/turmas/${aberta.id}`,
      { data_inicio: "2099-03-01", data_fim: "2099-03-01", local: "Invadida", unidade_promotora_id: String(csso_id) },
      { seguir: false },
    );
    expect(editar.status).toBe(303);
    expect(editar.headers.get("location")).toBe("/turmas");
    const situacao = await c.post(`/turmas/${aberta.id}/situacao`, { destino: "CANCELADA", motivo: "x" }, { seguir: false });
    expect(situacao.headers.get("location")).toBe("/turmas");
    const inscrever = await c.post(`/turmas/${aberta.id}/inscricoes`, { nome: "Fulano", vinculo: "EXTERNO" }, { seguir: false });
    expect(inscrever.headers.get("location")).toBe("/turmas");
    const lista = await c.get(`/turmas/${aberta.id}/lista-presenca`, { seguir: false });
    expect(lista.status).toBe(303);
    const emitir = await c.post(`/turmas/${t_cpel.turma.id}/certificados`, {}, { seguir: false });
    expect(emitir.headers.get("location")).toBe("/turmas");

    const [depois] = await db.select().from(e.turma).where(eq(e.turma.id, aberta.id));
    expect(depois!.local).toBe("Sala da CPEL");
    expect(depois!.unidade_promotora_id).toBe(cpel_id);
    expect(depois!.situacao).toBe("PLANEJADA");
    const inscritos = await db.select().from(e.inscricao).where(eq(e.inscricao.turma_id, aberta.id));
    expect(inscritos).toHaveLength(0);
  });

  it("a porta do serviço devolve null para a turma de outro setor", async () => {
    const tec = await usuarioAtual(db, "tec_csso");
    expect(await servico_turma.no_escopo(db, tec, t_cpel.turma.id, "turma.criar")).toBeNull();
    expect(await servico_turma.no_escopo(db, tec, t_csso.turma.id, "turma.criar")).not.toBeNull();
    expect(await servico_turma.no_escopo(db, tec, t_sem.turma.id, "turma.criar")).not.toBeNull();
    const sem = await usuarioAtual(db, "tec_sem");
    expect(await servico_turma.no_escopo(db, sem, t_csso.turma.id)).toBeNull();
    expect(setor_equipe.sem_setor(sem)).toBe(true);
    expect(setor_equipe.sem_setor(tec)).toBe(false);
  });

  it("o UsuarioAtual montado à mão não é recortado (compatibilidade)", async () => {
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "tec_sem"));
    const a_mao = new UsuarioAtual({
      id: conta!.id,
      login: "tec_sem",
      nome: "à mão",
      permissoes: ["treinamento.ver", "turma.criar"],
      perfis: ["tecnico_seguranca"],
    });
    expect(await servico_turma.no_escopo(db, a_mao, t_cpel.turma.id)).not.toBeNull();
  });
});

describe("certificados por setor", () => {
  it("o certificado da turma da CPEL some da lista e da fila da CSSO, e a ficha não abre", async () => {
    const c = await _cliente("tec_csso");
    const lista = await c.get("/certificados");
    expect(lista.text).toContain(`/certificados/${t_csso.certificado_id}"`);
    expect(lista.text).toContain(`/certificados/${t_sem.certificado_id}"`);
    expect(lista.text).not.toContain(`/certificados/${t_cpel.certificado_id}"`);
    const fila = await c.get("/certificados/fila?etapa=EMITIDO");
    expect(fila.text).toContain(t_csso.turma.codigo);
    expect(fila.text).not.toContain(t_cpel.turma.codigo);
    const venc = await c.get("/certificados/vencimentos");
    expect(venc.text).not.toContain(`/certificados/${t_cpel.certificado_id}"`);
    const ficha = await c.get(`/certificados/${t_cpel.certificado_id}`, { seguir: false });
    expect(ficha.status).toBe(303);
    expect(ficha.headers.get("location")).toBe("/certificados");
    const pdf = await c.get(`/certificados/${t_cpel.certificado_id}/pdf`, { seguir: false });
    expect(pdf.status).toBe(303);
  });

  it("anular e enviar por e-mail certificado de outro setor não fazem nada", async () => {
    const c = await _cliente("eng_cpel");
    const anular = await c.post(`/certificados/${t_csso.certificado_id}/anular`, { motivo: "teste de setor" }, { seguir: false });
    expect(anular.headers.get("location")).toBe("/certificados");
    const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, t_csso.certificado_id));
    expect(cert!.situacao).toBe("EMITIDO");
    await c.post(`/certificados/${t_csso.certificado_id}/email`, {}, { seguir: false });
    const emails = await db.select().from(e.email_saida).where(eq(e.email_saida.certificado_id, t_csso.certificado_id));
    expect(emails).toHaveLength(0);
  });

  it("a CPEL vê o certificado dela; a coordenação vê todos", async () => {
    const cpel = await (await _cliente("tec_cpel")).get("/certificados");
    expect(cpel.text).toContain(`/certificados/${t_cpel.certificado_id}"`);
    expect(cpel.text).not.toContain(`/certificados/${t_csso.certificado_id}"`);
    const coord = await (await _cliente("coordenador_csso")).get("/certificados");
    for (const t of [t_csso, t_cpel, t_sem]) expect(coord.text).toContain(`/certificados/${t.certificado_id}"`);
  });

  it("a caixa de envios mostra só os e-mails do setor, e não mexe nos de outro", async () => {
    const [da_cpel] = await db
      .insert(e.email_saida)
      .values({ tipo: "CERTIFICADO", destinatario: "b@ufvjm.edu.br", assunto: "Assunto-da-CPEL", certificado_id: t_cpel.certificado_id, situacao: "FALHOU" })
      .returning();
    await db
      .insert(e.email_saida)
      .values({ tipo: "CERTIFICADO", destinatario: "a@ufvjm.edu.br", assunto: "Assunto-da-CSSO", certificado_id: t_csso.certificado_id });
    const c = await _cliente("tec_csso");
    const caixa = await c.get("/certificados/emails");
    expect(caixa.text).toContain("Assunto-da-CSSO");
    expect(caixa.text).not.toContain("Assunto-da-CPEL");
    await c.post(`/certificados/emails/${da_cpel!.id}/cancelar`, {}, { seguir: false });
    const [igual] = await db.select().from(e.email_saida).where(eq(e.email_saida.id, da_cpel!.id));
    expect(igual!.situacao).toBe("FALHOU");
    const coord = await (await _cliente("coordenador_csso")).get("/certificados/emails");
    expect(coord.text).toContain("Assunto-da-CPEL");
  });
});

describe("o titular continua vendo o que é dele", () => {
  it("o titular puro vê o próprio certificado da CPEL e as próprias inscrições", async () => {
    const c = await _cliente("titular_cpel");
    const meus = await c.get("/certificados/meus");
    expect(meus.status).toBe(200);
    expect(meus.text).toContain(`/certificados/${t_cpel.certificado_id}"`);
    const ficha = await c.get(`/certificados/${t_cpel.certificado_id}`, { seguir: false });
    expect(ficha.status).toBe(200);
    const minhas = await c.get("/turmas/minhas");
    expect(minhas.text).toContain(t_cpel.turma.codigo);
  });

  it("a conta da CPEL lê o próprio certificado da CSSO, mas não a turma da CSSO", async () => {
    const c = await _cliente("cpel_aluna_csso");
    const ficha = await c.get(`/certificados/${t_csso.certificado_id}`, { seguir: false });
    expect(ficha.status).toBe(200);
    const meus = await c.get("/certificados/meus");
    expect(meus.text).toContain(`/certificados/${t_csso.certificado_id}"`);
    const turma = await c.get(`/turmas/${t_csso.turma.id}`, { seguir: false });
    expect(turma.status).toBe(303);
    const lista = await c.get("/certificados");
    expect(lista.text).not.toContain(`/certificados/${t_csso.certificado_id}"`);
  });

  it("o cartaz das turmas abertas é de todos os setores", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    const aberta = await servico_turma.criar_turma(db, coord, {
      treinamento,
      data_inicio: "2099-05-10",
      data_fim: "2099-05-10",
      unidade_promotora_id: csso_id,
    });
    await servico_turma.mudar_situacao(db, coord, aberta, "INSCRICOES_ABERTAS");
    const c = await _cliente("cpel_aluna_csso");
    const minhas = await c.get("/turmas/minhas");
    expect(minhas.text).toContain(aberta.codigo);
    const r = await c.post(`/turmas/${aberta.id}/inscrever-me`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).not.toBe("/turmas");
    const [s] = await db.select().from(e.servidor).where(eq(e.servidor.siape, "2000001"));
    const inscritos = await db
      .select({ id: e.inscricao.id })
      .from(e.inscricao)
      .innerJoin(e.participante, eq(e.participante.id, e.inscricao.participante_id))
      .where(and(eq(e.inscricao.turma_id, aberta.id), eq(e.participante.servidor_id, s!.id)));
    expect(inscritos).toHaveLength(1);
  });
});

describe("criar e editar turma pelo setor", () => {
  const base = { treinamento_id: "", data_inicio: "2099-08-01", data_fim: "2099-08-01", local: "Sala" };

  it("em branco, assume o único setor da conta", async () => {
    const c = await _cliente("tec_cpel");
    const r = await c.post("/turmas", { ...base, treinamento_id: String(treinamento.id), local: "Sala única" }, { seguir: false });
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const [t] = await db.select().from(e.turma).where(eq(e.turma.local, "Sala única"));
    expect(t!.unidade_promotora_id).toBe(cpel_id);
  });

  it("recusa o setor alheio", async () => {
    const c = await _cliente("tec_cpel");
    const r = await c.post("/turmas", {
      ...base,
      treinamento_id: String(treinamento.id),
      local: "Sala alheia",
      unidade_promotora_id: String(csso_id),
    });
    expect(r.text).toContain(servico_turma.RECUSA_SETOR_ALHEIO);
    const achadas = await db.select().from(e.turma).where(eq(e.turma.local, "Sala alheia"));
    expect(achadas).toHaveLength(0);
  });

  it("com dois setores e em branco, pede para escolher", async () => {
    const tec = await usuarioAtual(db, "tec_dois");
    expect(() => servico_turma.setor_da_turma_nova(tec, null)).toThrow(RegraDaTurma);
    expect(() => servico_turma.setor_da_turma_nova(tec, null)).toThrow(/Escolha o setor promotor/);
    expect(servico_turma.setor_da_turma_nova(tec, cpel_id)).toBe(cpel_id);
  });

  it("sem setor, não abre turma", async () => {
    const tec = await usuarioAtual(db, "tec_sem");
    expect(() => servico_turma.setor_da_turma_nova(tec, null)).toThrow(RegraDaTurma);
  });

  it("quem vê todos escolhe qualquer setor, ou nenhum", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    expect(servico_turma.setor_da_turma_nova(coord, null)).toBeNull();
    expect(servico_turma.setor_da_turma_nova(coord, cpel_id)).toBe(cpel_id);
  });

  it("o seletor de setor oferece só os setores da conta", async () => {
    const r = await (await _cliente("tec_cpel")).get("/turmas");
    const inicio = r.text.indexOf('id="nova-unidade"');
    const trecho = r.text.slice(inicio, r.text.indexOf("</select>", inicio));
    expect(trecho).toContain(`value="${cpel_id}"`);
    expect(trecho).not.toContain(`value="${csso_id}"`);
    // o único setor já vem escolhido
    expect(trecho).toMatch(new RegExp(`value="${cpel_id}"\\s*selected`));
  });

  it("na edição, a turma não sai dos setores de quem edita", async () => {
    const dois = await usuarioAtual(db, "tec_dois");
    const turma = await servico_turma.criar_turma(db, dois, {
      treinamento,
      data_inicio: "2099-09-01",
      data_fim: "2099-09-01",
      unidade_promotora_id: csso_id,
    });
    // entre os dois setores dela, pode
    await servico_turma.editar_turma(db, dois, turma, { unidade_promotora_id: cpel_id });
    expect(turma.unidade_promotora_id).toBe(cpel_id);
    const sisa = await _unidade("Sisa");
    await expect(servico_turma.editar_turma(db, dois, turma, { unidade_promotora_id: sisa })).rejects.toThrow(
      servico_turma.RECUSA_SETOR_ALHEIO,
    );
    await expect(servico_turma.editar_turma(db, dois, turma, { unidade_promotora_id: null })).rejects.toThrow(RegraDaTurma);
  });
});

describe("a busca global", () => {
  it("a equipe acha só a turma e o certificado do próprio setor", async () => {
    const busca = await import("../src/servicos/busca.js");
    const codigos = async (login: string, q: string, bloco: string) => {
      const blocos = await busca.buscar(db, await usuarioAtual(db, login), q);
      return (blocos.find((b) => b.codigo === bloco)?.itens ?? []).map((i: any) => i.id);
    };
    expect(await codigos("tec_csso", t_cpel.turma.codigo, "turma")).toEqual([]);
    expect(await codigos("tec_cpel", t_cpel.turma.codigo, "turma")).toEqual([t_cpel.turma.id]);
    expect(await codigos("coordenador_csso", t_cpel.turma.codigo, "turma")).toEqual([t_cpel.turma.id]);
    const [cert] = await db.select().from(e.certificado).where(eq(e.certificado.id, t_cpel.certificado_id));
    const q = `${cert!.numero}/${cert!.ano}`;
    expect(await codigos("tec_csso", q, "certificado")).toEqual([]);
    expect(await codigos("tec_cpel", q, "certificado")).toEqual([cert!.id]);
  });
});
