/**
 * A vitrine no início do servidor ("Inscrições abertas para você") e no aviso
 * de reciclagem: a reciclagem vai na frente, depois o mesmo campus, depois a
 * data; a turma em que já pediu vaga sai por último com o rótulo no lugar do
 * botão; cheia, não divulgada e abandonada não entram; sem `turma.inscrever_se`
 * não há botão; o botão grava a inscrição pela conta; o e-mail de reciclagem
 * leva o link da próxima turma divulgada. Dados fictícios.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as aviso_reciclagem from "../src/servicos/aviso_reciclagem.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_certificado from "../src/servicos/certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";
import * as vitrine_para_voce from "../src/servicos/vitrine_para_voce.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual } from "./ajuda";

const { db, cliente } = await bancoLimpo();
await contas(db);
const HOJE = datas_br.hoje();
const ANO = Number(HOJE.slice(0, 4));

const [campus_a] = await db.insert(e.campus).values({ sigla: "VPA", nome: "Campus Vitrine A", cidade: "Diamantina" }).returning();
const [campus_b] = await db.insert(e.campus).values({ sigla: "VPB", nome: "Campus Vitrine B", cidade: "Teófilo Otoni" }).returning();
const [unidade] = await db
  .insert(e.unidade_uorg)
  .values({ sigla: "IVPA", nome_oficial: "INSTITUTO VITRINE", nome_extenso: "Instituto da Vitrine", tipo: "INSTITUTO", campus_id: campus_a!.id })
  .returning();
const [servidor] = await db.insert(e.servidor).values({ siape: "7800001", nome: "Clarice Fictícia Lopes", unidade_uorg_id: unidade!.id }).returning();
await criarUsuario(db, { login: "titular_clarice", nome: "Clarice Fictícia Lopes", perfis: ["servidor_consulta"], servidor_id: servidor!.id });

let seq = 0;
async function treinamento(codigo: string) {
  const [t] = await db.insert(e.treinamento).values({ codigo, nome: `Curso ${codigo}`, carga_horaria_horas: "8", validade_meses: 24 }).returning();
  return t!;
}
/** Uma turma divulgada (ou não), com inscrição aberta e começo em `dias` dias. */
async function turma(t: { id: number }, dias: number, extra: Partial<typeof e.turma.$inferInsert> = {}) {
  seq += 1;
  const [r] = await db
    .insert(e.turma)
    .values({
      treinamento_id: t.id,
      numero: 800 + seq,
      ano: ANO,
      codigo: `VPV-${ANO}-${String(seq).padStart(4, "0")}`,
      data_inicio: somar_dias(HOJE, dias),
      data_fim: somar_dias(HOJE, dias),
      situacao: "INSCRICOES_ABERTAS",
      inscricao_aberta_ate: somar_dias(HOJE, dias - 1),
      divulgar_na_vitrine: true,
      divulgada_em: new Date(),
      descricao: "Curso de formação com conteúdo prático, voltado a servidores da universidade.",
      publico_alvo: ["SERVIDOR"],
      vagas: 10,
      ...extra,
    })
    .returning();
  return r!;
}
async function certificado_vencendo(t: { id: number; validade_meses: number | null }, vence_em_dias: number) {
  const emissao = datas_br.somar_meses(somar_dias(HOJE, vence_em_dias), -24);
  const pessoa = await servico_participante.de_servidor(db, servidor!);
  await db.insert(e.participante_email).values({ participante_id: pessoa.id, email: "clarice@exemplo.test", email_normalizado: "clarice@exemplo.test" });
  const [antiga] = await db
    .insert(e.turma)
    .values({ treinamento_id: t.id, numero: 700 + (seq += 1), ano: Number(emissao.slice(0, 4)), codigo: `VPV-${emissao.slice(0, 4)}-${String(seq).padStart(4, "0")}`, data_inicio: emissao, data_fim: emissao, situacao: "CONCLUIDA" })
    .returning();
  const [insc] = await db.insert(e.inscricao).values({ turma_id: antiga!.id, participante_id: pessoa.id, situacao: "APROVADO" }).returning();
  const [cert] = await db
    .insert(e.certificado)
    .values({
      inscricao_id: insc!.id,
      numero: 7800 + seq,
      ano: Number(emissao.slice(0, 4)),
      chave_validacao: servico_certificado.gerar_chave(Number(emissao.slice(0, 4))),
      situacao: "EMITIDO",
      data_emissao: emissao,
      data_base_vencimento: emissao,
      data_vencimento: somar_dias(HOJE, vence_em_dias),
      validade_meses_congelada: 24,
      contexto_congelado: { turma_codigo: antiga!.codigo, treinamento_nome: `Curso ${seq}`, treinamento_norma: "NR", turma_data_inicio: emissao, turma_data_fim: emissao, carga_horaria: "8" },
      modelo_arquivo: "certificado_padrao_v1.docx",
      servidor_id: servidor!.id,
      treinamento_id: t.id,
      participante_id: pessoa.id,
    })
    .returning();
  return cert!;
}

const t_reciclar = await treinamento("VP-REC");
const t_outro = await treinamento("VP-OUT");
const t_longe = await treinamento("VP-LON");
const cert = await certificado_vencendo(t_reciclar, 30);

const turma_data_perto = await turma(t_outro, 5, { campus_id: campus_b!.id });
const turma_mesmo_campus = await turma(t_outro, 25, { campus_id: campus_a!.id });
const turma_reciclagem = await turma(t_reciclar, 40, { campus_id: campus_b!.id });
const turma_cheia = await turma(t_longe, 6, { vagas: 1 });
const turma_nao_divulgada = await turma(t_longe, 7, { divulgar_na_vitrine: false });
const turma_ja_pedida = await turma(t_longe, 3);
{
  const pessoa = await servico_participante.de_servidor(db, servidor!);
  await db.insert(e.inscricao).values({ turma_id: turma_ja_pedida.id, participante_id: pessoa.id, situacao: "CONFIRMADA" });
  // a cheia está cheia de outra pessoa
  const [outra] = await db.insert(e.servidor).values({ siape: "7800002", nome: "Outra Pessoa Fictícia", unidade_uorg_id: unidade!.id }).returning();
  const p2 = await servico_participante.de_servidor(db, outra!);
  await db.insert(e.inscricao).values({ turma_id: turma_cheia.id, participante_id: p2.id, situacao: "CONFIRMADA" });
}

const CONTA = { certificados: [{ treinamento_id: t_reciclar.id, data_vencimento: cert.data_vencimento }], campus: "Campus Vitrine A" };

describe("as sugestões do servidor", () => {
  it("a reciclagem vai na frente, depois o campus, depois a data; a turma já pedida vai por último", async () => {
    const usuario = await usuarioAtual(db, "titular_clarice");
    const r = await vitrine_para_voce.sugerir(db, usuario, CONTA, HOJE);
    expect(r.pode_pedir).toBe(true);
    // 5 candidatas (a cheia e a não divulgada ficam de fora); só as 3 primeiras aparecem
    expect(r.itens.map((i) => i.turma_id)).toEqual([turma_reciclagem.id, turma_mesmo_campus.id, turma_data_perto.id]);
    expect(r.itens[0]!.motivo).toMatch(/^Seu certificado vence em \d{2}\/\d{4}$/);
    expect(r.itens[1]!.motivo).toBeNull();
    expect(r.itens.some((i) => i.ja_pediu)).toBe(false);
  });

  it("a turma já pedida aparece com o rótulo quando sobra espaço; cheia e não divulgada nunca entram", async () => {
    const usuario = await usuarioAtual(db, "titular_clarice");
    await db.update(e.turma).set({ divulgar_na_vitrine: false }).where(eq(e.turma.id, turma_data_perto.id));
    await db.update(e.turma).set({ divulgar_na_vitrine: false }).where(eq(e.turma.id, turma_mesmo_campus.id));
    const r = await vitrine_para_voce.sugerir(db, usuario, CONTA, HOJE);
    expect(r.itens.map((i) => [i.turma_id, i.ja_pediu])).toEqual([[turma_reciclagem.id, false], [turma_ja_pedida.id, true]]);
    const ids = r.itens.map((i) => i.turma_id);
    expect(ids).not.toContain(turma_cheia.id);
    expect(ids).not.toContain(turma_nao_divulgada.id);
    await db.update(e.turma).set({ divulgar_na_vitrine: true }).where(eq(e.turma.id, turma_data_perto.id));
    await db.update(e.turma).set({ divulgar_na_vitrine: true }).where(eq(e.turma.id, turma_mesmo_campus.id));
  });

  it("sem turma.inscrever_se não há sugestão, só o link da vitrine", async () => {
    const sem = { pode: () => false } as unknown as UsuarioAtual;
    expect(await vitrine_para_voce.sugerir(db, sem, CONTA, HOJE)).toEqual({ pode_pedir: false, itens: [] });
  });
});

describe("o início do servidor", () => {
  it("mostra o bloco com o botão, e o botão inscreve pela conta", async () => {
    await entrar(cliente, "titular_clarice");
    const inicio = await cliente.get("/inicio");
    expect(inicio.status).toBe(200);
    expect(inicio.text).toContain("Inscrições abertas para você");
    expect(inicio.text).toContain("Seu certificado vence em");
    expect(inicio.text).toContain(`/turmas/${turma_reciclagem.id}/inscrever-me`);
    expect(inicio.text).not.toContain("Você já pediu vaga");
    expect(inicio.text).toContain('href="/cursos"');
    expect(inicio.text).not.toContain(`/turmas/${turma_cheia.id}/inscrever-me`);

    const r = await cliente.post(`/turmas/${turma_reciclagem.id}/inscrever-me`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const depois = (await cliente.get("/inicio")).text;
    expect(depois).not.toContain(`/turmas/${turma_reciclagem.id}/inscrever-me`);
    // a turma que acabou de pedir continua na lista, agora com o rótulo no lugar do botão
    expect(depois).toContain("Você já pediu vaga");
  });
});

describe("o aviso de reciclagem", () => {
  it("leva o link da próxima turma divulgada do mesmo treinamento", async () => {
    const proxima = await vitrine_para_voce.proxima_do_treinamento(db, t_reciclar.id, HOJE);
    expect(proxima?.codigo).toBe(turma_reciclagem.codigo);
    expect(await vitrine_para_voce.proxima_do_treinamento(db, 99999, HOJE)).toBeNull();

    const coord = await usuarioAtual(db, "coordenador_csso");
    const r = await aviso_reciclagem.avisar_marcados(db, coord, [cert.id]);
    expect(r.enfileirados).toBe(1);
    const [msg] = (await db.select().from(e.email_saida)).filter((x) => x.tipo === aviso_reciclagem.TIPO);
    expect(msg!.corpo).toContain(`/cursos/${turma_reciclagem.codigo}`);
    expect(msg!.corpo).toContain("Já há turma com inscrição aberta");
  });

  it("sem turma divulgada, a mensagem segue como era", async () => {
    await db.update(e.turma).set({ divulgar_na_vitrine: false }).where(eq(e.turma.id, turma_reciclagem.id));
    expect(await vitrine_para_voce.proxima_do_treinamento(db, t_reciclar.id, HOJE)).toBeNull();
  });
});
