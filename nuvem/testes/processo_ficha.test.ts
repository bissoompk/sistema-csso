/**
 * A ficha do processo e o processo novo: recusa que devolve o digitado, o
 * comentário da RN-21, a mudança de estado pela ficha, anexos (envio e a
 * porta de download) e o 404 honesto.
 *
 * Porte das partes deste módulo de `test_formulario_recusado.py`,
 * `test_rotas_nao_encontrado.py` e `test_anexos_acesso.py`.
 */
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { bancoLimpo, contas, entrar } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const HTML = { cabecalhos: { accept: "text/html" } };
const INEXISTENTE = 999999;

/** O `value=` do input, como o navegador o mostraria. */
function valor_do_campo(corpo: string, nome: string): string | null {
  const achado = new RegExp(`<input[^>]*\\bname="${nome}"[^>]*>`, "i").exec(corpo);
  if (!achado) return null;
  const valor = /\bvalue="([^"]*)"/.exec(achado[0]);
  return valor ? valor[1]! : null;
}

const desescapar = (s: string | null) => (s ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

let seq = 0;
async function processo(campos: Partial<typeof e.processo.$inferInsert> = {}) {
  const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
  const [tipo] = await db.select().from(e.tipo_processo).orderBy(asc(e.tipo_processo.id)).limit(1);
  const [p] = await db
    .insert(e.processo)
    .values({
      nup: `23086.0${String(10000 + ++seq)}/2026-84`,
      tipo_processo_id: tipo!.id,
      etapa_id: etapa!.id,
      estado_tecnico: "RECEBIDO",
      data_autuacao: "2026-01-05",
      ano_referencia: 2026,
      ...campos,
    })
    .returning();
  return p!;
}

// ---------------------------------------------------------------------
// Processo novo: a recusa devolve o que foi digitado
// ---------------------------------------------------------------------
const OBSERVACAO = "Conferir a portaria de localização com a FAMED antes de instruir.";

async function postar_processo(extra: Record<string, string> = {}) {
  const cliente = await entrar(novoCliente(), "coordenador_csso");
  return cliente.post(
    "/processos/novo",
    {
      nup: "23086.000608/2026-84",
      tipo_processo_id: "1",
      servidor_id: "",
      unidade_uorg_id: "",
      data_autuacao: "",
      observacoes: OBSERVACAO,
      dispensar_dv: "",
      ...extra,
    },
    { seguir: false },
  );
}

describe("processo novo recusado", () => {
  it("NUP com formato inválido devolve o que foi digitado", async () => {
    const r = await postar_processo({ nup: "não é NUP" });
    expect(r.status).toBe(200);
    expect(r.text).toContain(OBSERVACAO);
    expect(valor_do_campo(r.text, "nup")).toBe("não é NUP");
  });

  it("DV recusado preserva a observação", async () => {
    const r = await postar_processo({ nup: "23086.000608/2026-00" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("confirmei no SEI");
    expect(r.text).toContain(OBSERVACAO);
    // o fato e a explicação: a explicação é o resto depois do primeiro travessão
    expect(r.text).toContain('<strong class="fato">dígito verificador não confere</strong>');
    expect(r.text).toContain("confirme no SEI. Marque &#39;confirmei no SEI&#39; para prosseguir.");
  });

  it("marca de dispensa volta marcada", async () => {
    const r = await postar_processo({
      nup: "23086.000608/2026-00",
      dispensar_dv: "1",
      observacoes: "Servidora gestante afastada do laboratório.",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("termo proibido");
    const marca = /<input[^>]*\bname="dispensar_dv"[^>]*>/.exec(r.text);
    expect(marca![0]).toContain("checked");
    // e o erro vai para o campo de onde veio
    expect(r.text).toContain('<span class="erro-campo">O campo observações contém termo proibido');
  });

  it("recusa preserva tipo, servidor, unidade e data", async () => {
    const [famed] = await db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
    const [cargo] = await db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
    const [servidor] = await db
      .insert(e.servidor)
      .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino", cargo_id: cargo!.id, unidade_uorg_id: famed!.id })
      .returning();
    const tipos = await db.select().from(e.tipo_processo).orderBy(asc(e.tipo_processo.id));
    const tipo = tipos[tipos.length - 1]!;
    const r = await postar_processo({
      nup: "não é NUP",
      tipo_processo_id: String(tipo.id),
      servidor_id: String(servidor!.id),
      unidade_uorg_id: String(famed!.id),
      data_autuacao: "2026-03-01",
    });
    expect(r.status).toBe(200);
    for (const valor of [tipo.id, servidor!.id, famed!.id]) {
      expect(new RegExp(`<option value="${valor}"[^>]*\\bselected\\b`).test(r.text), String(valor)).toBe(true);
    }
    expect(valor_do_campo(r.text, "data_autuacao")).toBe("2026-03-01");
  });
});

// ---------------------------------------------------------------------
// Comentário (RN-21)
// ---------------------------------------------------------------------
const COMENTARIO_PROIBIDO = "Servidor apresentou atestado médico da chefia.";

describe("comentário no histórico", () => {
  it("termo proibido não derruba a tela, volta dentro do campo e não entra na trilha", async () => {
    const p = await processo();
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/processos/${p.id}/comentario`, { comentario: COMENTARIO_PROIBIDO }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("termo proibido");
    expect(r.text).toContain('class="aviso aviso-erro"');
    expect(r.text).toContain("/pendencias");
    expect(desescapar(valor_do_campo(r.text, "comentario"))).toBe(COMENTARIO_PROIBIDO);
    // a camada reabre com o texto
    expect(r.text).toContain('<dialog class="popup" id="novo-comentario" aria-labelledby="novo-comentario-titulo" open>');
    const comentarios = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "COMENTARIO"), eq(e.historico_evento.processo_id, p.id)));
    expect(comentarios).toEqual([]);
  });

  it("comentário limpo continua gravando", async () => {
    const p = await processo();
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/processos/${p.id}/comentario`, { comentario: "Conferir a portaria com a FAMED." }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/processos/${p.id}?aba=historico`);
    const tela = await cliente.get(r.location!);
    expect(tela.text).toContain("Conferir a portaria com a FAMED.");
  });
});

// ---------------------------------------------------------------------
// Mudança de estado pela ficha
// ---------------------------------------------------------------------
describe("mudar estado pela ficha", () => {
  it("move, e a recusa volta à ficha com o motivo sem gravar", async () => {
    const p = await processo();
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const ok = await cliente.post(`/processos/${p.id}/estado`, { destino: "EM_TRIAGEM" }, { seguir: false });
    expect(ok.location).toBe(`/processos/${p.id}?aba=historico`);
    const recusa = await cliente.post(`/processos/${p.id}/estado`, { destino: "AGUARDANDO_INSPECAO" });
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("anexe a portaria de localização");
    const [atual] = await db.select().from(e.processo).where(eq(e.processo.id, p.id));
    expect(atual!.estado_tecnico).toBe("EM_TRIAGEM");
    // sobrestar e voltar pelo __voltar__
    await cliente.post(`/processos/${p.id}/estado`, { destino: "SOBRESTADO" }, { seguir: false });
    const ficha = await cliente.get(`/processos/${p.id}`);
    expect(ficha.text).toContain("Voltar ao estado anterior");
    await cliente.post(`/processos/${p.id}/estado`, { destino: "__voltar__" }, { seguir: false });
    expect((await db.select().from(e.processo).where(eq(e.processo.id, p.id)))[0]!.estado_tecnico).toBe("EM_TRIAGEM");
  });

  it("link do SEI entra na trilha campo a campo", async () => {
    const p = await processo();
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await cliente.post(`/processos/${p.id}/sei`, { url_permanente: "https://sei.ufvjm.edu.br/x" }, { seguir: false });
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.processo_id, p.id), eq(e.historico_evento.campo, "url_permanente")));
    expect(ev!.tipo_evento).toBe("CAMPO_ALTERADO");
    expect(ev!.valor_novo).toBe("https://sei.ufvjm.edu.br/x");
  });
});

// ---------------------------------------------------------------------
// Anexos
// ---------------------------------------------------------------------
describe("anexos do processo", () => {
  it("envia, deduplica, baixa e registra a leitura", async () => {
    const [cargo] = await db.select().from(e.cargo).limit(1);
    const [titular] = await db.insert(e.servidor).values({ siape: "2220001", nome: "Titular do Anexo", cargo_id: cargo!.id }).returning();
    const p = await processo({ servidor_id: titular!.id });
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const arquivo = new File([new TextEncoder().encode("%PDF-1.4 parecer")], "parecer assinado.pdf", { type: "application/pdf" });
    const r = await cliente.post(`/processos/${p.id}/anexos`, { categoria: "PARECER_ASSINADO", arquivo });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Anexo enviado.");
    const de_novo = await cliente.post(`/processos/${p.id}/anexos`, { categoria: "PARECER_ASSINADO", arquivo });
    expect(de_novo.text).toContain("Arquivo idêntico já anexado neste processo — ignorado.");
    const [anexo] = await db.select().from(e.anexo).where(and(eq(e.anexo.entidade, "processo"), eq(e.anexo.entidade_id, p.id)));

    const baixado = await cliente.get(`/anexos/${anexo!.id}`);
    expect(baixado.status).toBe(200);
    expect(baixado.text).toBe("%PDF-1.4 parecer");
    expect(baixado.cabecalho("content-disposition")).toContain("attachment");
    const acessos = await db
      .select()
      .from(e.acesso_dado_sensivel)
      .where(eq(e.acesso_dado_sensivel.campo, "anexo.PARECER_ASSINADO"));
    expect(acessos.at(-1)!.servidor_id).toBe(titular!.id);
    expect(acessos.at(-1)!.processo_id).toBe(p.id);
    const [baixa] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "ANEXO_BAIXADO"), eq(e.historico_evento.entidade_id, anexo!.id)));
    expect(baixa).toBeDefined();

    // id inexistente e id proibido respondem igual
    const titular_logado = await entrar(novoCliente(), "servidor_consulta");
    const proibido = await titular_logado.get(`/anexos/${anexo!.id}`);
    const inexistente = await titular_logado.get(`/anexos/${INEXISTENTE}`);
    expect(proibido.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(proibido.text).toBe(inexistente.text);

    // anexo desativado responde como inexistente
    await db.update(e.anexo).set({ ativo: false }).where(eq(e.anexo.id, anexo!.id));
    expect((await cliente.get(`/anexos/${anexo!.id}`)).status).toBe(404);
  });

  it("anexo acima do teto da nuvem volta como recusa na aba", async () => {
    const p = await processo();
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const grande = new File([new Uint8Array(4 * 1024 * 1024 + 10)], "grande.pdf", { type: "application/pdf" });
    const r = await cliente.post(`/processos/${p.id}/anexos`, { categoria: "OUTRO", arquivo: grande });
    expect(r.status).toBe(200);
    expect(r.text).toContain("o limite é");
    expect(await db.select().from(e.anexo).where(and(eq(e.anexo.entidade, "processo"), eq(e.anexo.entidade_id, p.id)))).toEqual([]);
  });

  it("a saída da triagem destrava com portaria e formulário anexados pela tela", async () => {
    const p = await processo({ estado_tecnico: "EM_TRIAGEM" });
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    let ficha = await cliente.get(`/processos/${p.id}`);
    expect(ficha.text).toContain("Pendências para sair deste estado");
    for (const categoria of ["PORTARIA", "FORMULARIO"]) {
      const arquivo = new File([new TextEncoder().encode(categoria)], `${categoria}.pdf`, { type: "application/pdf" });
      await cliente.post(`/processos/${p.id}/anexos`, { categoria, arquivo });
    }
    ficha = await cliente.get(`/processos/${p.id}`);
    expect(ficha.text).not.toContain("Pendências para sair deste estado");
    await cliente.post(`/processos/${p.id}/estado`, { destino: "AGUARDANDO_INSPECAO" }, { seguir: false });
    expect((await db.select().from(e.processo).where(eq(e.processo.id, p.id)))[0]!.estado_tecnico).toBe("AGUARDANDO_INSPECAO");
  });
});

// ---------------------------------------------------------------------
// 404 honesto
// ---------------------------------------------------------------------
describe("ficha inexistente não responde 200", () => {
  it.each(["/processos", "/pareceres", "/laudos"])("%s/999999", async (prefixo) => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get(`${prefixo}/${INEXISTENTE}`, { ...HTML, seguir: false });
    expect([303, 404]).toContain(r.status);
  });

  it.each(["docx", "pdf", "previa"])("/pareceres/999999/%s é 404", async (sufixo) => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get(`/pareceres/${INEXISTENTE}/${sufixo}`, { ...HTML, seguir: false });
    expect(r.status).toBe(404);
  });

  it("processo inexistente: 404 com a tela de erro, ou JSON para quem não pede HTML", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get(`/processos/${INEXISTENTE}`, HTML);
    expect(r.status).toBe(404);
    expect(r.text).toContain('<aside class="lateral">');
    expect(r.text).toContain("não existe ou está fora do seu escopo");
    const j = await cliente.get(`/processos/${INEXISTENTE}`, { cabecalhos: { accept: "*/*" } });
    expect(j.status).toBe(404);
    expect(j.json().detail).toBeTruthy();
  });

  it("processo existente continua abrindo", async () => {
    const p = await processo({ estado_tecnico: "EM_TRIAGEM" });
    expect((await (await entrar(novoCliente(), "coordenador_csso")).get(`/processos/${p.id}`)).status).toBe(200);
  });
});
