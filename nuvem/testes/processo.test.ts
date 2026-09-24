/**
 * Serviço de processo: requisitos de saída, SLA, sobrestamento e kanban.
 * Porte de `testes/integracao/test_processo_fluxo.py`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { agora_utc } from "../src/db/esquema/base.js";
import { TransicaoInvalida } from "../src/dominio/estados.js";
import * as repo from "../src/repositorios/processos.js";
import * as servico_anexos from "../src/servicos/anexos.js";
import * as datas_br from "../src/servicos/datas_br.js";
import {
  SLA_PADRAO,
  RequisitoDeSaidaNaoAtendido,
  mover,
  requisitos_de_saida,
  resumir,
  voltar_do_sobrestamento,
} from "../src/servicos/processo.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, criarUsuario } from "./ajuda";

const PERMISSOES = ["processo.ver", "processo.criar", "processo.editar", "processo.status", "anexo.enviar"];

// Um banco para o arquivo (clonar um por teste deixava o `afterAll` apagando
// dezenas de bancos); cada teste ganha o PRÓPRIO processo, com NUP próprio, e
// as consultas do repositório filtram por ele.
const db: Banco = (await bancoLimpo()).db;
const u = await criarUsuario(db, { login: "op", nome: "Operador" });
const ator = new UsuarioAtual({ id: u.id, login: "op", nome: "Operador", permissoes: PERMISSOES, perfis: ["coordenador_csso"] });
let processo: typeof e.processo.$inferSelect;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  const [tipo] = await db.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL"));
  const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
  const [famed] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  [processo] = (await db
    .insert(e.processo)
    .values({
      nup: `23086.${String(21284 + seq).padStart(6, "0")}/2024-56`,
      tipo_processo_id: tipo!.id,
      etapa_id: etapa!.id,
      estado_tecnico: "EM_TRIAGEM",
      unidade_uorg_id: famed!.id,
    })
    .returning()) as [typeof e.processo.$inferSelect];
});

async function anexar(categoria: string) {
  return servico_anexos.guardar(db, {
    entidade: "processo",
    entidade_id: processo.id,
    nome_original: `${categoria.toLowerCase()}.pdf`,
    conteudo: new TextEncoder().encode("x" + categoria),
    mime_type: "application/pdf",
    categoria,
    usuario: ator,
    processo_id: processo.id,
  });
}

async function mudar(campos: Partial<typeof e.processo.$inferSelect>) {
  await db.update(e.processo).set(campos).where(eq(e.processo.id, processo.id));
  Object.assign(processo, campos);
}

describe("requisitos de saída", () => {
  it("saída da triagem exige portaria e formulário", async () => {
    const faltas = await requisitos_de_saida(db, processo, "AGUARDANDO_INSPECAO");
    expect(faltas).toContain("anexe a portaria de localização");
    expect(faltas.some((f) => f.includes("formulário assinado"))).toBe(true);
    await expect(mover(db, processo, "AGUARDANDO_INSPECAO", ator)).rejects.toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    await anexar("PORTARIA");
    await anexar("FORMULARIO");
    await mover(db, processo, "AGUARDANDO_INSPECAO", ator);
    expect(processo.estado_tecnico).toBe("AGUARDANDO_INSPECAO");
  });

  it("arquivar da triagem não exige documento", async () => {
    await mover(db, processo, "ARQUIVADO", ator);
    expect(processo.estado_tecnico).toBe("ARQUIVADO");
  });

  it("saída da quantificação exige ensaio ou justificativa", async () => {
    await mudar({ estado_tecnico: "AGUARDANDO_QUANTIFICACAO" });
    const faltas = await requisitos_de_saida(db, processo, "LAUDO_EM_ELABORACAO");
    expect(faltas.some((f) => f.includes("relatório de ensaio"))).toBe(true);
    await mudar({ observacoes: "Avaliação qualitativa justificada conforme Anexo 13 da NR-15." });
    expect(await requisitos_de_saida(db, processo, "LAUDO_EM_ELABORACAO")).toEqual([]);
    await mover(db, processo, "LAUDO_EM_ELABORACAO", ator);
  });

  it("atalho de reúso exige laudo vigente", async () => {
    await anexar("PORTARIA");
    await anexar("FORMULARIO");
    const erro = await mover(db, processo, "PARECER_EM_ELABORACAO", ator).catch((x) => x);
    expect(erro).toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    expect(erro.motivos.some((m: string) => m.includes("laudo VIGENTE"))).toBe(true);

    const [insal] = await db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
    const [laudo] = await db
      .insert(e.laudo_tecnico)
      .values({ numero_siape: "26255-000.125/2019", ano: 2019, tipo_adicional_id: insal!.id, unidade_uorg_id: processo.unidade_uorg_id! })
      .returning();
    await mover(db, processo, "PARECER_EM_ELABORACAO", ator, { laudo_reusado: laudo! });
    expect(processo.estado_tecnico).toBe("PARECER_EM_ELABORACAO");
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "REUSO_DE_LAUDO"));
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos[0]!.descricao).toContain("26255-000.125/2019");
  });

  it("indeferimento exige inciso do art. 11", async () => {
    const erro = await mover(db, processo, "INDEFERIDO_TECNICAMENTE", ator, { forcar: true }).catch((x) => x);
    expect(erro).toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    expect(erro.motivos[0]).toContain("art. 11");
    await mover(db, processo, "INDEFERIDO_TECNICAMENTE", ator, { inciso_art11: "II", forcar: true });
    expect(processo.estado_tecnico).toBe("INDEFERIDO_TECNICAMENTE");
  });
});

describe("transições", () => {
  it("sobrestar e voltar", async () => {
    await mover(db, processo, "SOBRESTADO", ator, { forcar: true });
    expect(processo.estado_tecnico).toBe("SOBRESTADO");
    expect(processo.estado_anterior).toBe("EM_TRIAGEM");
    await voltar_do_sobrestamento(db, processo, ator);
    expect(processo.estado_tecnico).toBe("EM_TRIAGEM");
    expect(processo.estado_anterior).toBeNull();
  });

  it("voltar sem estar sobrestado", async () => {
    await expect(voltar_do_sobrestamento(db, processo, ator)).rejects.toBeInstanceOf(TransicaoInvalida);
  });

  it("transição proibida", async () => {
    await expect(mover(db, processo, "CONCLUIDO", ator)).rejects.toBeInstanceOf(TransicaoInvalida);
  });

  it("mover para o mesmo estado não faz nada", async () => {
    const versao = processo.versao;
    await mover(db, processo, "EM_TRIAGEM", ator);
    expect(processo.versao).toBe(versao);
  });

  it("status exige permissão", async () => {
    const sem = new UsuarioAtual({ id: 99, login: "x", nome: "Sem", permissoes: ["processo.ver"], perfis: ["consulta_progep"] });
    await expect(mover(db, processo, "ARQUIVADO", sem)).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("conclusão preenche a data", async () => {
    await mudar({ estado_tecnico: "DEVOLVIDO_A_PROGEP" });
    await mover(db, processo, "CONCLUIDO", ator);
    expect(processo.situacao).toBe("CONCLUIDO");
    expect(processo.data_conclusao).toBe(datas_br.hoje());
    const [gravado] = await db.select().from(e.processo).where(eq(e.processo.id, processo.id));
    expect(gravado!.data_conclusao).toBe(datas_br.hoje());
    expect(gravado!.versao).toBe(2);
  });

  it("a trilha registra a mudança de estado com os rótulos", async () => {
    await mover(db, processo, "ARQUIVADO", ator, { comentario: "sem objeto" });
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "ESTADO_ALTERADO"), eq(e.historico_evento.processo_id, processo.id)));
    expect(ev!.descricao).toBe("Em triagem -> Arquivado — sem objeto");
    expect(ev!.valor_anterior).toBe("EM_TRIAGEM");
    expect(ev!.valor_novo).toBe("ARQUIVADO");
  });
});

describe("SLA e resumo", () => {
  it("SLA e contador de dias", async () => {
    await mudar({ entrou_na_etapa_em: new Date(agora_utc().getTime() - (SLA_PADRAO.A_FAZER! + 3) * 86_400_000) });
    const resumo = await resumir(db, processo);
    expect(resumo.coluna).toBe("A_FAZER");
    expect(resumo.dias_no_estado).toBeGreaterThanOrEqual(SLA_PADRAO.A_FAZER!);
    expect(resumo.atrasado).toBe(true);
    await anexar("PORTARIA");
    await anexar("FORMULARIO");
    await mover(db, processo, "AGUARDANDO_INSPECAO", ator);
    // o contador reinicia a cada mudança de coluna
    expect((await resumir(db, processo)).dias_no_estado).toBe(0);
  });

  it("resumo conta anexos e checklist", async () => {
    await anexar("PORTARIA");
    const [chk] = await db.insert(e.checklist).values({ processo_id: processo.id, nome: "Instrução" }).returning();
    await db.insert(e.checklist_item).values([
      { checklist_id: chk!.id, descricao: "a", concluido: true },
      { checklist_id: chk!.id, descricao: "b", concluido: false },
    ]);
    const resumo = await resumir(db, processo);
    expect(resumo.anexos).toBe(1);
    expect([resumo.checklist_feitos, resumo.checklist_total]).toEqual([1, 2]);
  });
});

describe("repositório", () => {
  it("kanban agrupa por coluna", async () => {
    const colunas = await repo.kanban(db, ator, new repo.Filtro());
    expect(colunas.A_FAZER!.map((p) => p.id)).toContain(processo.id);
    const contagem = await repo.contar_por_coluna(db, ator, new repo.Filtro({ q: processo.nup }));
    expect(contagem.A_FAZER).toBe(1);
    expect(contagem.CONCLUIDO).toBe(0);
  });

  it("busca por NUP e laudo", async () => {
    const [itens, total] = await repo.listar(db, ator, new repo.Filtro({ q: processo.nup.slice(6, 12) }));
    expect(total).toBe(1);
    expect(itens[0]!.id).toBe(processo.id);
    const [, vazio] = await repo.listar(db, ator, new repo.Filtro({ q: "nada disso" }));
    expect(vazio).toBe(0);
  });

  it("indicadores", async () => {
    // o banco é do arquivo: mede-se o que ESTE processo acrescenta
    await mudar({ estado_tecnico: "ARQUIVADO" });
    const antes = await repo.indicadores(db, ator);
    await mudar({ estado_tecnico: "EM_TRIAGEM" });
    const kpis = await repo.indicadores(db, ator);
    expect(kpis.total).toBe(antes.total);
    expect(kpis.a_fazer - antes.a_fazer).toBe(1);
    await mudar({ origem_repositorio: true });
    expect((await repo.indicadores(db, ator)).total).toBe(antes.total - 1);
  });

  it("unidades com processo", async () => {
    const unidades = await repo.unidades_com_processo(db, ator);
    expect(unidades.some((u) => u.codigo_uorg === "250")).toBe(true);
  });

  it("por NUP e por id", async () => {
    expect((await repo.por_id(db, ator, processo.id))!.id).toBe(processo.id);
    expect((await repo.por_nup(db, ator, processo.nup))!.id).toBe(processo.id);
    expect(await repo.por_id(db, ator, 999999)).toBeNull();
  });

  it("query string do filtro", () => {
    const qs = new repo.Filtro({ q: "marco", estado: "EM_TRIAGEM", atrasados: true }).como_query_string();
    expect(qs).toContain("q=marco");
    expect(qs).toContain("estado=EM_TRIAGEM");
    expect(qs).toContain("atrasados=1");
    expect(qs).not.toContain("tipo=");
  });
});
