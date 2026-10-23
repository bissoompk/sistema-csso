/**
 * NUVEM (Portal do servidor, 22/10/2026): "Minha atividade" (`/minha-atividade`).
 *
 * O cenário é o de `ajuda_certificado.ts` (turma concluída, certificado
 * emitido por um OPERADOR com nome), mais um pedido de EPI em rascunho e
 * eventos da própria conta. O que se confere:
 * - aparece o que é do titular, e não o de outro servidor da mesma turma;
 * - o nome do operador nunca aparece: sai "Equipe {sigla}" (RN-19);
 * - eventos de `turma`, internos (divergência, PDF não gerado) e de acesso
 *   (bloqueio de conta) ficam fora, e a consulta a dado sensível também;
 * - a `descricao` livre do evento nunca aparece;
 * - o filtro por tipo, a paginação por cursor e o número de consultas.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-minha-atividade-"));

import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { observarConsultas } from "../src/db/cliente.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as atividade from "../src/servicos/atividade_titular.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual } from "./ajuda";
import { TODAS, _cenario } from "./ajuda_certificado.js";

definirArmazenamento(null);

const amb = await bancoLimpo();
const { db } = amb;
await contas(db);

// --- o operador, com nome (é este nome que NÃO pode aparecer) ---
const NOME_OPERADOR = "Fulana Operadora Nomeada";
const [linha_op] = await db
  .insert(e.usuario)
  .values({ login: "operadora", nome: NOME_OPERADOR, email: "operadora@teste.ufvjm.edu.br", senha_hash: "x" })
  .returning();
const operador = new UsuarioAtual({
  id: linha_op!.id,
  login: "operadora",
  nome: NOME_OPERADOR,
  permissoes: [...TODAS],
  perfis: ["coordenador_csso"],
});

// --- turma concluída do titular, com um colega (outro servidor) na mesma turma ---
const cen = await _cenario(db, operador, { extras: [["2220001", "Colega Da Mesma Turma", "8"]] });
const [csqv] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "CSQV"));
await db.update(e.turma).set({ unidade_promotora_id: csqv!.id }).where(eq(e.turma.id, cen.turma.id));
const turma = (await servico_turma.carregar_turma(db, cen.turma.id))!;
const inscricao = (await servico_turma.carregar_inscricao(db, cen.inscricao.id, turma))!;
const emitido = await emissao.emitir(db, operador, inscricao, { gerar_pdf: false });
const certificado = emitido.certificado;
// o colega também tem certificado: os eventos dele não podem aparecer
const inscricao_colega = (await servico_turma.carregar_inscricao(db, cen.outras[0]!.id, turma))!;
const emitido_colega = await emissao.emitir(db, operador, inscricao_colega, { gerar_pdf: false });

// --- a conta do titular ---
const conta_titular = await criarUsuario(db, {
  login: "titular_atividade",
  nome: "Titular Da Atividade",
  perfis: ["servidor_consulta"],
  servidor_id: cen.servidor.id,
});
const titular = await usuarioAtual(db, "titular_atividade");

const SEGREDO = "DESCRICAO-LIVRE-QUE-NAO-APARECE";
// internos do certificado: fora da lista
await auditoria.registrar(db, {
  entidade: "certificado",
  entidade_id: certificado.id,
  tipo_evento: auditoria.PDF_NAO_GERADO,
  descricao: `${SEGREDO} pdf`,
  usuario: operador,
});
await auditoria.registrar(db, {
  entidade: "certificado",
  entidade_id: certificado.id,
  tipo_evento: emissao.CERTIFICADO_DIVERGENTE,
  descricao: `${SEGREDO} divergente`,
  usuario: operador,
});
// acesso: bloqueio de conta não é "atividade"
await auditoria.registrar(db, {
  entidade: "usuario",
  entidade_id: conta_titular.id,
  tipo_evento: auditoria.CONTA_BLOQUEADA,
  descricao: `${SEGREDO} bloqueio`,
  usuario: null,
});
// consulta a dado sensível do titular, feita pelo operador: nunca aparece
await auditoria.registrar_acesso_sensivel(db, operador, "exposicao", {
  servidor_id: cen.servidor.id,
  finalidade: "FINALIDADE-DA-CONSULTA-SENSIVEL",
});
// a própria conta: senha trocada por ele mesmo, com o operador nomeado no texto
await auditoria.registrar(db, {
  entidade: "usuario",
  entidade_id: conta_titular.id,
  tipo_evento: auditoria.SENHA_TROCADA,
  descricao: `${SEGREDO} senha (citando ${NOME_OPERADOR})`,
  usuario: titular,
});
// EPI: pedido em rascunho do titular, posto em análise pelo operador
const [pedido] = await db
  .insert(e.epi_requisicao)
  .values({ servidor_id: cen.servidor.id, solicitado_por_id: conta_titular.id })
  .returning();
await auditoria.registrar(db, {
  entidade: "epi_requisicao",
  entidade_id: pedido!.id,
  tipo_evento: "EPI_REQUISICAO_CRIADA",
  descricao: `${SEGREDO} criado`,
  usuario: titular,
});
await auditoria.registrar(db, {
  entidade: "epi_requisicao",
  entidade_id: pedido!.id,
  tipo_evento: "EPI_REQUISICAO_EM_ANALISE",
  descricao: `${SEGREDO} em análise por ${NOME_OPERADOR}`,
  usuario: operador,
  usuario_nome: NOME_OPERADOR,
});
// o e-mail enfileirado do pedido é interno: fora
await auditoria.registrar(db, {
  entidade: "epi_requisicao",
  entidade_id: pedido!.id,
  tipo_evento: "EPI_EMAIL_ENFILEIRADO",
  descricao: `${SEGREDO} e-mail`,
  usuario: operador,
});

const cliente = await entrar(amb.novoCliente(), "titular_atividade");

async function eventos_de(entidade: string, entidade_id: number) {
  return db
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.entidade, entidade), eq(e.historico_evento.entidade_id, entidade_id)));
}

async function todos_os_itens(grupo: atividade.GrupoAtividade | null = null, tamanho = 30) {
  const itens: atividade.ItemAtividade[] = [];
  let antes: number | null = null;
  for (let volta = 0; volta < 50; volta++) {
    const p = await atividade.atividade_do_titular(db, titular, { grupo }, { antes, tamanho });
    itens.push(...p.dias.flatMap((d) => d.itens));
    if (p.proximo_antes === null) break;
    antes = p.proximo_antes;
  }
  return itens;
}

describe("Minha atividade: o que aparece", () => {
  it("abre para o titular, agrupada por dia, com hora em <time>", async () => {
    const r = await cliente.get("/minha-atividade");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Template render error");
    expect(r.text).toContain("<h1>Minha atividade</h1>");
    expect(r.text).toMatch(/<h3 id="dia-[0-9-]+">Hoje<\/h3>/);
    expect(r.text).toMatch(/<time class="evento-quando" datetime="[^"]+T[^"]+" title="\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}">/);
    expect(r.text).toContain("Seus acessos ficam protegidos e não aparecem aqui.");
  });

  it("mostra os eventos do titular com frase própria e objeto seguro", async () => {
    const r = await cliente.get("/minha-atividade");
    expect(r.text).toContain("Certificado emitido");
    expect(r.text).toContain(`Nº ${emitido.certificado.numero_impresso}`);
    expect(r.text).toContain("Trabalho em Altura — NR-35");
    expect(r.text).toContain(`turma ${turma.codigo}`);
    expect(r.text).toContain("Inscrição feita");
    expect(r.text).toContain("Presença lançada");
    expect(r.text).toContain("Senha alterada");
    expect(r.text).toContain("Pedido de EPI iniciado");
    expect(r.text).toContain("Pedido de EPI em análise");
    expect(r.text).toContain("Pedido em rascunho");
  });

  it("não mostra os eventos de outro servidor da mesma turma", async () => {
    const itens = await todos_os_itens();
    const ids = new Set(itens.map((i) => i.id));
    const alheios = [
      ...(await eventos_de("inscricao", inscricao_colega.id)),
      ...(await eventos_de("certificado", emitido_colega.certificado.id)),
    ];
    expect(alheios.length).toBeGreaterThan(0);
    for (const ev of alheios) expect(ids.has(ev.id), ev.tipo_evento).toBe(false);
    const r = await cliente.get("/minha-atividade");
    expect(r.text).not.toContain(emitido_colega.certificado.numero_impresso!);
  });

  it("agente: 'Você' no que ele fez, 'Equipe {sigla}' no da equipe, e nunca o nome do operador (RN-19)", async () => {
    const itens = await todos_os_itens();
    const emitido_item = itens.find((i) => i.titulo === "Certificado emitido")!;
    expect(emitido_item.agente).toBe("Equipe CSQV");
    expect(itens.find((i) => i.titulo === "Pedido de EPI em análise")!.agente).toBe("Equipe CSSO");
    expect(itens.find((i) => i.titulo === "Senha alterada")!.agente).toBe("Você");
    expect(itens.find((i) => i.titulo === "Pedido de EPI iniciado")!.agente).toBe("Você");
    const r = await cliente.get("/minha-atividade");
    expect(r.text).toContain("Equipe CSQV");
    expect(r.text).not.toContain(NOME_OPERADOR);
    expect(r.text).not.toContain("Operadora");
  });

  it("fora: eventos de turma, internos, de acesso e a descrição livre", async () => {
    const turma_eventos = await eventos_de("turma", turma.id);
    expect(turma_eventos.length).toBeGreaterThan(0);
    const ids = new Set((await todos_os_itens()).map((i) => i.id));
    for (const ev of turma_eventos) expect(ids.has(ev.id), ev.tipo_evento).toBe(false);
    const r = await cliente.get("/minha-atividade");
    for (const proibido of [
      SEGREDO,
      "Divergência",
      "PDF não gerado",
      "Conta bloqueada",
      "bloqueada",
      "Turma apurada",
      "em lote",
      "E-mail do pedido",
    ]) {
      expect(r.text, proibido).not.toContain(proibido);
    }
  });

  it("consulta a dado sensível nunca aparece", async () => {
    const r = await cliente.get("/minha-atividade");
    expect(r.text).not.toContain("FINALIDADE-DA-CONSULTA-SENSIVEL");
    expect(r.text).not.toMatch(/consult(a|ou) (a|os) (seus )?dados? sens/i);
    const linhas = await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.servidor_id, cen.servidor.id));
    expect(linhas.length).toBe(1);
  });

  it("toda linha da lista branca tem frase, grupo e ícone; o grupo existe nas pílulas", () => {
    const grupos = new Set(atividade.GRUPOS_ATIVIDADE.map((g) => g.codigo));
    for (const ev of atividade.EVENTOS_DO_TITULAR) {
      expect(grupos.has(ev.grupo), ev.tipo).toBe(true);
      expect(ev.frase, ev.tipo).toBeTruthy();
    }
    for (const fora of ["CERTIFICADO_DIVERGENTE", "PDF_NAO_GERADO", "CONTA_BLOQUEADA", "ANEXO_BAIXADO", "CERTIFICADO_LOTE"]) {
      expect(atividade.EVENTOS_DO_TITULAR.some((ev) => ev.tipo === fora), fora).toBe(false);
    }
    expect(atividade.EVENTOS_DO_TITULAR.some((ev) => (ev.entidade as string) === "turma")).toBe(false);
  });
});

describe("Minha atividade: filtro, paginação e consultas", () => {
  it("o filtro por tipo mostra só o grupo, com a pílula marcada", async () => {
    const r = await cliente.get("/minha-atividade?tipo=conta");
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/minha-atividade?tipo=conta" aria-current="true"');
    expect(r.text).toContain("Senha alterada");
    expect(r.text).not.toContain("Certificado emitido");
    expect(r.text).not.toContain("Pedido de EPI");

    const so_epi = await todos_os_itens("epi");
    expect(so_epi.length).toBe(2);
    expect(so_epi.every((i) => i.grupo === "epi")).toBe(true);

    // tipo desconhecido vale como "Tudo"
    const t = await cliente.get("/minha-atividade?tipo=qualquer");
    expect(t.status).toBe(200);
    expect(t.text).toContain('href="/minha-atividade" aria-current="true"');
  });

  it("a paginação por cursor percorre tudo, sem repetir nem pular", async () => {
    const inteira = (await atividade.atividade_do_titular(db, titular, {}, { tamanho: 500 })).dias.flatMap((d) => d.itens);
    const aos_dois = await todos_os_itens(null, 2);
    expect(aos_dois.map((i) => i.id)).toEqual(inteira.map((i) => i.id));
    expect(new Set(aos_dois.map((i) => i.id)).size).toBe(aos_dois.length);
    // do mais novo para o mais antigo
    const ordem = inteira.map((i) => i.quando_iso);
    expect([...ordem].sort().reverse()).toEqual(ordem);
  });

  it("30 por página, com 'Carregar mais' por ?antes=", async () => {
    for (let i = 0; i < 31; i++) {
      await auditoria.registrar(db, {
        entidade: "usuario",
        entidade_id: conta_titular.id,
        tipo_evento: auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR,
        descricao: `${SEGREDO} ${i}`,
        usuario: titular,
      });
    }
    const r = await cliente.get("/minha-atividade");
    expect((r.text.match(/class="evento-titular /g) ?? []).length).toBe(30);
    const m = r.text.match(/href="\/minha-atividade\?antes=(\d+)">Carregar mais/);
    expect(m).not.toBeNull();
    const r2 = await cliente.get(`/minha-atividade?antes=${m![1]}`);
    expect(r2.status).toBe(200);
    expect(r2.text).toContain("Certificado emitido");
    expect(r2.text).not.toContain(SEGREDO);
    // o filtro segue junto no cursor
    const c = await cliente.get("/minha-atividade?tipo=conta");
    expect(c.text).toMatch(/href="\/minha-atividade\?tipo=conta&amp;antes=\d+">Carregar mais/);
  });

  it("a tela faz poucas consultas, e uma só na trilha (sem N+1)", async () => {
    const vistas: string[] = [];
    observarConsultas((q) => vistas.push(q));
    try {
      const r = await cliente.get("/minha-atividade");
      expect(r.status).toBe(200);
    } finally {
      observarConsultas(null);
    }
    expect(vistas.length).toBeLessThanOrEqual(12);
    expect(vistas.filter((q) => q.includes("historico_evento")).length).toBe(1);
  });
});

describe("Minha atividade: conta sem servidor", () => {
  it("explica, e não lista nada", async () => {
    const equipe = await entrar(amb.novoCliente(), "engenheiro_seguranca");
    const r = await equipe.get("/minha-atividade");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Esta conta não está ligada a um cadastro de servidor.");
    expect(r.text).not.toContain('class="evento-titular');
  });

  it("sem sessão vai para o login", async () => {
    const r = await amb.novoCliente().get("/minha-atividade", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });
});
