/**
 * Lote 4 (25/11/2026): a brigada pela porta da frente — disciplinas e validade no catálogo, centro
 * de formação, profissão e credenciamento em Assinaturas, notas por disciplina na grade, local de
 * atuação e responsável pela formação na turma, e o CPF do próprio servidor em Minha conta.
 */
import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, type Cliente, type Resposta } from "./ajuda";
import type { Banco } from "../src/db/cliente";
import * as e from "../src/db/esquema/index";
import { somar_dias } from "../src/dominio/datas";
import { hoje } from "../src/servicos/datas_br";
import * as centro_formacao from "../src/servicos/centro_formacao";

const INICIO = somar_dias(hoje(), -3);

let { db, novoCliente } = await bancoLimpo();
let cliente: Cliente;

beforeEach(async () => {
  ({ db, novoCliente } = await bancoLimpo());
  await contas(db);
  cliente = novoCliente();
  await entrar(cliente, "coordenador_csso");
});

async function mensagem(r: Resposta): Promise<string> {
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  return (await cliente.get(r.location!)).text;
}

async function treinamento_em_tempos(): Promise<typeof e.treinamento.$inferSelect> {
  const r = await cliente.post(
    "/treinamentos/catalogo",
    { codigo: "BRIG", nome: "Brigadista Orgânico", carga_horaria_horas: "10", carga_unidade: "TEMPOS", validade_meses: "24" },
    { seguir: false },
  );
  expect(r.status, r.text.slice(0, 500)).toBe(303);
  const [t] = await db.select().from(e.treinamento).orderBy(desc(e.treinamento.id)).limit(1);
  return t!;
}

function editar(t: typeof e.treinamento.$inferSelect, extra: Record<string, string>) {
  return cliente.post(
    `/treinamentos/catalogo/${t.id}`,
    {
      nome: t.nome,
      codigo_curto: t.codigo_curto,
      carga_horaria_horas: "10",
      carga_unidade: "TEMPOS",
      validade_meses: "24",
      ativo: "1",
      ...extra,
    },
    { seguir: false },
  );
}

const DISCIPLINAS = {
  disc_presente: "1",
  disc_nome_1: "Prevenção e Combate a Incêndio",
  disc_teorica_1: "3",
  disc_pratica_1: "3",
  disc_nome_2: "Primeiros Socorros",
  disc_teorica_2: "2",
  disc_pratica_2: "2",
};

describe("catálogo: disciplinas e a origem da validade", () => {
  it("grava as disciplinas do treinamento em tempos e a validade com origem e citação", async () => {
    const t = await treinamento_em_tempos();
    const tela = await mensagem(
      await editar(t, { ...DISCIPLINAS, validade_origem: "NORMA", validade_citacao: "Portaria CBMMG nº 54/2020, art. 43" }),
    );
    expect(tela).toContain("2 disciplina(s)");
    expect(tela).toContain("norma: Portaria CBMMG nº 54/2020, art. 43");
    const linhas = await db.select().from(e.treinamento_disciplina).where(eq(e.treinamento_disciplina.treinamento_id, t.id));
    expect(linhas.map((d) => d.nome).sort()).toEqual(["Prevenção e Combate a Incêndio", "Primeiros Socorros"]);
  });

  it("recusa a soma diferente da carga, e a recusa volta com o digitado", async () => {
    const t = await treinamento_em_tempos();
    const r = await editar(t, { ...DISCIPLINAS, disc_pratica_2: "3" });
    expect(r.status).toBe(200);
    // lote 5: a mensagem mostra a conta
    expect(r.text).toContain("3 + 3 + 2 + 3 = 11 tempos, mas a carga do treinamento é 10 tempos");
    expect(r.text).toContain('value="Primeiros Socorros"');
    expect(await db.select().from(e.treinamento_disciplina)).toHaveLength(0);
  });

  it("política interna aparece com esse nome, e a origem sem citação é recusada", async () => {
    const t = await treinamento_em_tempos();
    const sem = await editar(t, { validade_origem: "INSTITUCIONAL" });
    expect(sem.text).toContain("Diga o documento da política interna");
    const tela = await mensagem(await editar(t, { validade_origem: "INSTITUCIONAL", validade_citacao: "Resolução CSSO nº 1/2026" }));
    expect(tela).toContain("política interna: Resolução CSSO nº 1/2026");
  });
});

describe("centro de formação da brigada", () => {
  it("CNPJ com dígito errado é recusado; o certo grava e aparece formatado", async () => {
    const ruim = await cliente.post("/treinamentos/catalogo/centro-formacao", { nome: "Centro UFVJM", cnpj: "11.222.333/0001-80" }, { seguir: false });
    expect(await mensagem(ruim)).toContain("dígito verificador não confere");
    const tela = await mensagem(
      await cliente.post("/treinamentos/catalogo/centro-formacao", { nome: "Centro UFVJM", cnpj: "11222333000181" }, { seguir: false }),
    );
    expect(tela).toContain("11.222.333/0001-81");
    expect(await centro_formacao.ler(db)).toEqual({ nome: "Centro UFVJM", cnpj: "11222333000181" });
  });
});

describe("assinaturas: profissão e credenciamento", () => {
  it("grava a profissão e o credenciamento; profissão fora da lista é recusada", async () => {
    const ok = await cliente.post(
      "/treinamentos/assinaturas",
      { nome: "Joana Técnica", externo: "1", profissao: "TECNICO_SEG", credenciamento_cbmmg: "CBM-4321" },
      { seguir: false },
    );
    expect(ok.status, ok.text.slice(0, 400)).toBe(303);
    const [a] = await db.select().from(e.assinatura_instrutor).where(eq(e.assinatura_instrutor.nome, "Joana Técnica"));
    expect([a!.profissao, a!.credenciamento_cbmmg]).toEqual(["TECNICO_SEG", "CBM-4321"]);
    const ruim = await cliente.post("/treinamentos/assinaturas", { nome: "Outro", externo: "1", profissao: "BOMBEIRO" }, { seguir: false });
    expect(ruim.text).toContain("Escolha a profissão na lista");
  });
});

describe("turma de brigada pela tela", () => {
  async function turma_com_inscrito() {
    const t = await treinamento_em_tempos();
    await mensagem(await editar(t, DISCIPLINAS));
    const r = await cliente.post(
      "/turmas",
      { treinamento_id: String(t.id), data_inicio: INICIO, data_fim: INICIO, local: "Pátio", frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 600)).toBe(303);
    const [turma] = await db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
    for (const destino of ["INSCRICOES_ABERTAS", "EM_ANDAMENTO"]) {
      expect((await cliente.post(`/turmas/${turma!.id}/situacao`, { destino }, { seguir: false })).status).toBe(303);
    }
    const [s] = await db.insert(e.servidor).values({ siape: "3334445", nome: "Bruna Brigadista" }).returning();
    expect((await cliente.post(`/turmas/${turma!.id}/inscricoes`, { servidor_id: String(s!.id) }, { seguir: false })).status).toBe(303);
    const [i] = await db.select().from(e.inscricao).orderBy(desc(e.inscricao.id)).limit(1);
    const ds = await db.select().from(e.treinamento_disciplina).where(eq(e.treinamento_disciplina.treinamento_id, t.id));
    return { t, turma: turma!, inscricao: i!, disciplinas: ds.sort((a, b) => a.ordem - b.ordem) };
  }

  it("a grade tem uma nota por disciplina e a final é a média, em percentual", async () => {
    const { turma, inscricao, disciplinas } = await turma_com_inscrito();
    const grade = (await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text;
    expect(grade).toContain("Nota · Prevenção e Combate a Incêndio");
    expect(grade).toContain("Nota · Primeiros Socorros");
    const r = await cliente.post(
      `/turmas/${turma.id}/presencas/folha`,
      { [`nd_${inscricao.id}_${disciplinas[0]!.id}`]: "85", [`nd_${inscricao.id}_${disciplinas[1]!.id}`]: "70" },
      { seguir: false },
    );
    expect(await mensagem(r)).toContain("2 nota(s)");
    const [relida] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, inscricao.id));
    expect([relida!.nota_final, relida!.nota_escala]).toEqual(["77.50", 100]);
    expect((await cliente.get(`/turmas/${turma.id}?aba=presencas`)).text).toContain("77,5%");
  });

  it("nota fora de 0 a 100 é recusada na folha, sem gravar nada", async () => {
    const { turma, inscricao, disciplinas } = await turma_com_inscrito();
    const r = await cliente.post(`/turmas/${turma.id}/presencas/folha`, { [`nd_${inscricao.id}_${disciplinas[0]!.id}`]: "101" }, { seguir: false });
    expect(await mensagem(r)).toContain("de 0 a 100");
    expect(await db.select().from(e.inscricao_nota_disciplina)).toHaveLength(0);
  });

  it("local de atuação: o padrão da turma vai para a inscrição nova, e cada uma se ajusta", async () => {
    const { turma, inscricao } = await turma_com_inscrito();
    await mensagem(
      await cliente.post(
        `/turmas/${turma.id}/inscricoes/${inscricao.id}/local-atuacao`,
        { local_atuacao: "  Campus  JK — Diamantina " },
        { seguir: false },
      ),
    );
    const [relida] = await db.select().from(e.inscricao).where(eq(e.inscricao.id, inscricao.id));
    expect(relida!.local_atuacao).toBe("Campus JK — Diamantina");
  });

  it("o responsável pela formação tem de ser instrutor da turma", async () => {
    const { turma } = await turma_com_inscrito();
    const [fora] = await db.insert(e.assinatura_instrutor).values({ nome: "De Fora", externo: true, vigencia_inicio: "2020-01-01" }).returning();
    const r = await cliente.post(
      `/turmas/${turma.id}`,
      {
        data_inicio: INICIO,
        data_fim: INICIO,
        local: "Pátio",
        frequencia_minima_percentual: "75",
        local_atuacao_padrao: "Campus JK",
        responsavel_formacao_id: String(fora!.id),
      },
      { seguir: false },
    );
    expect(await mensagem(r)).toContain("tem de ser um dos instrutores da turma");
  });
});

describe("Minha conta: o CPF do próprio servidor", () => {
  it("o servidor informa o CPF; a tela mostra só a máscara, nunca o número", async () => {
    const [s] = await db.insert(e.servidor).values({ siape: "4445556", nome: "Coordenação Teste" }).returning();
    await db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "coordenador_csso"));
    const tela = await mensagem(await cliente.post("/minha-conta/cpf", { cpf_certificado: "529.982.247-25" }, { seguir: false }));
    expect(tela).toContain("CPF gravado para o certificado");
    expect(tela).not.toContain("529.982.247-25");
    expect(tela).not.toContain("52998224725");
    const [p] = await db.select().from(e.participante).where(eq(e.participante.servidor_id, s!.id));
    expect(p!.cpf).toBe("52998224725");
  });

  it("CPF inválido é recusado e não volta à tela", async () => {
    const [s] = await db.insert(e.servidor).values({ siape: "5556667", nome: "Outra Pessoa" }).returning();
    await db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "coordenador_csso"));
    const r = await cliente.post("/minha-conta/cpf", { cpf_certificado: "111.111.111-12" }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("111.111.111-12");
  });
});
