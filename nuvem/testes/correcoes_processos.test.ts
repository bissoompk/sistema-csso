/**
 * Correções do lote "processos, fluxo e painel": um teste por defeito de regra,
 * permissão ou validação, com o número do item ao lado do nome.
 *
 * Um banco para o arquivo; cada teste cria o PRÓPRIO processo, com NUP
 * próprio (DV certo), e lê só o dele.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { destinos_do_processo, rotulo_tela_do_ascii } from "../src/dominio/estados.js";
import * as servico_anexos from "../src/servicos/anexos.js";
import * as datas_br from "../src/servicos/datas_br.js";
import { nup_dv } from "../src/servicos/nup.js";
import {
  ProcessoRecusado,
  RequisitoDeSaidaNaoAtendido,
  criar,
  estados_sem_documento,
  mover,
  requisitos_de_saida,
  responsaveis_possiveis,
} from "../src/servicos/processo.js";
import { bancoLimpo, contas, criarUsuario, entrar, usuarioAtual, type Cliente } from "./ajuda";
import { cenario } from "./ajuda_processos.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const coordenador = await usuarioAtual(db, "coordenador_csso");

const FORMULARIO = { accept: "text/html,application/xhtml+xml" };
let seq = 0;

function nup_novo(): string {
  const sequencial = String(610000 + ++seq).padStart(6, "0");
  return `23086.${sequencial}/2025-${nup_dv(`23086${sequencial}2025`)}`;
}

async function tipo(codigo: string) {
  const [t] = await db.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, codigo));
  return t!;
}

/** Um processo do adicional direto no banco, no estado pedido, numa unidade sem laudo. */
async function processo_em(estado: string, campos: Partial<typeof e.processo.$inferInsert> = {}) {
  const [etapa] = await db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "EM_ANDAMENTO"));
  const [p] = await db
    .insert(e.processo)
    .values({
      nup: nup_novo(),
      tipo_processo_id: (await tipo("ADICIONAL_OCUPACIONAL")).id,
      etapa_id: etapa!.id,
      estado_tecnico: estado,
      ...campos,
    })
    .returning();
  return p!;
}

async function anexar(processo_id: number, categoria: string, conteudo = "x" + categoria + processo_id) {
  return servico_anexos.guardar(db, {
    entidade: "processo",
    entidade_id: processo_id,
    nome_original: `${categoria.toLowerCase()}.pdf`,
    conteudo: new TextEncoder().encode(conteudo),
    mime_type: "application/pdf",
    categoria,
    usuario: coordenador,
    processo_id,
  });
}

let documentos = 0;
/** Um parecer (do cenário do Parecer 1/2025) amarrado ao processo, na situação pedida. */
async function parecer_do(processo_id: number, situacao: "EMITIDO" | "ASSINADO") {
  documentos += 1;
  const c = await cenario(db, {
    nup: `23086.${String(720000 + documentos)}/2024-11`,
    siape: String(3400000 + documentos),
    laudo: `26255-000.${String(700 + documentos).padStart(3, "0")}/2019`,
    numero_portaria: String(950 + documentos),
  });
  await db
    .update(e.parecer_tecnico)
    .set({ processo_id, situacao, numero: 900 + documentos })
    .where(eq(e.parecer_tecnico.id, c.parecer_id));
  return c;
}

async function estado_de(id: number) {
  const [p] = await db.select().from(e.processo).where(eq(e.processo.id, id));
  return p!.estado_tecnico;
}

async function como(perfil: string): Promise<Cliente> {
  return entrar(novoCliente(), perfil);
}

// =====================================================================
// D0 — o salto não leva a "Parecer assinado" nem a "Concluído" sem documento
// =====================================================================
describe("D0: estados do parecer só com o parecer", () => {
  it("salto de Recebido a Concluído com portaria e formulário é recusado", async () => {
    const p = await processo_em("RECEBIDO");
    await anexar(p.id, "PORTARIA");
    await anexar(p.id, "FORMULARIO");
    const erro = await mover(db, p, "CONCLUIDO", coordenador).catch((x) => x);
    expect(erro).toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    expect(erro.motivos.join(" ")).toMatch(/Laudo emitido|parecer/);
    expect(await estado_de(p.id)).toBe("RECEBIDO");
  });

  it("à mão, “Parecer pronto para assinatura” e “Parecer assinado” exigem o parecer", async () => {
    const p = await processo_em("PARECER_EM_ELABORACAO");
    const sem = await mover(db, p, "PARECER_PRONTO_P_ASSINATURA", coordenador).catch((x) => x);
    expect(sem).toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    expect(sem.motivos[0]).toContain("emita o parecer");

    const q = await processo_em("PARECER_PRONTO_P_ASSINATURA");
    await parecer_do(q.id, "EMITIDO");
    const so_emitido = await mover(db, q, "PARECER_ASSINADO", coordenador).catch((x) => x);
    expect(so_emitido).toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    expect(so_emitido.motivos[0]).toContain("assinado");
    expect(await estado_de(q.id)).toBe("PARECER_PRONTO_P_ASSINATURA");
  });

  it("com o parecer emitido o passo manual passa (o processo que ficou para trás)", async () => {
    const p = await processo_em("PARECER_EM_ELABORACAO");
    await parecer_do(p.id, "EMITIDO");
    await mover(db, p, "PARECER_PRONTO_P_ASSINATURA", coordenador);
    expect(await estado_de(p.id)).toBe("PARECER_PRONTO_P_ASSINATURA");
  });

  it("“Laudo emitido” exige laudo do processo ou da unidade", async () => {
    // sem unidade, não há laudo vigente "do posto" que valha
    const p = await processo_em("LAUDO_EM_ELABORACAO");
    expect((await requisitos_de_saida(db, p, "LAUDO_EMITIDO")).join(" ")).toContain("Laudo emitido");
    await expect(mover(db, p, "LAUDO_EMITIDO", coordenador)).rejects.toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
  });

  it("“Inserido no SEI” e “Concluído” exigem o parecer assinado", async () => {
    const p = await processo_em("PARECER_ASSINADO");
    await expect(mover(db, p, "INSERIDO_NO_SEI", coordenador)).rejects.toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    const q = await processo_em("DEVOLVIDO_A_PROGEP");
    await expect(mover(db, q, "CONCLUIDO", coordenador)).rejects.toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    await parecer_do(q.id, "ASSINADO");
    await mover(db, q, "CONCLUIDO", coordenador);
    expect(await estado_de(q.id)).toBe("CONCLUIDO");
  });

  it("a tela e o quadro não oferecem os estados do parecer sem o documento", async () => {
    const p = await processo_em("LAUDO_EMITIDO");
    const fora = await estados_sem_documento(db, p);
    expect([...fora].sort()).toEqual(["PARECER_ASSINADO", "PARECER_PRONTO_P_ASSINATURA"]);
    const oferecidos = destinos_do_processo("LAUDO_EMITIDO", false, fora);
    expect(oferecidos).not.toContain("PARECER_PRONTO_P_ASSINATURA");
    expect(oferecidos).not.toContain("PARECER_ASSINADO");
    // e nada que só se alcance atravessando-os
    expect(oferecidos).not.toContain("CONCLUIDO");
    expect(oferecidos).toContain("PARECER_EM_ELABORACAO");
  });

  it("a ficha cobra a confirmação do salto no servidor", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("EM_TRIAGEM");
    await anexar(p.id, "PORTARIA");
    await anexar(p.id, "FORMULARIO");
    const sem = await cliente.post(`/processos/${p.id}/estado`, { destino_salto: "INSPECIONADO" }, { cabecalhos: FORMULARIO });
    expect(sem.status).toBe(200);
    expect(sem.text).toContain("Confirmo pular etapas");
    expect(sem.text).toContain("Para avançar vários passos de uma vez");
    expect(await estado_de(p.id)).toBe("EM_TRIAGEM");
    const com = await cliente.post(
      `/processos/${p.id}/estado`,
      { destino_salto: "INSPECIONADO", confirmo_salto: "1", aba: "dados" },
      { seguir: false },
    );
    expect(com.status).toBe(303);
    expect(decodeURIComponent(com.location!)).toContain("Processo movido para “Inspecionado”.");
    expect(com.location).toContain("aba=dados");
    expect(await estado_de(p.id)).toBe("INSPECIONADO");
  });

  it("sem passo manual, “Mover” não sobresta o processo por engano (revisão)", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("PARECER_EM_ELABORACAO");
    const ficha = (await cliente.get(`/processos/${p.id}`, { cabecalhos: FORMULARIO })).text;
    const select = ficha.slice(ficha.indexOf('id="mover-destino"'), ficha.indexOf("</select>", ficha.indexOf('id="mover-destino"')));
    // a primeira opção é a vazia, e não "Sobrestar"
    expect(select.indexOf('<option value="">')).toBeGreaterThan(-1);
    expect(select.indexOf('<option value="">')).toBeLessThan(select.indexOf('value="SOBRESTADO"'));
    const r = await cliente.post(`/processos/${p.id}/estado`, { destino: "" }, { cabecalhos: FORMULARIO });
    expect(r.text).toContain("Escolha para onde o processo vai.");
    expect(await estado_de(p.id)).toBe("PARECER_EM_ELABORACAO");
  });

  it("soltar no quadro não leva a “Pronto para assinatura” sem parecer", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("PARECER_EM_ELABORACAO");
    const r = await cliente.post(`/kanban/mover/${p.id}`, { coluna: "AGUARDANDO" }, { cabecalhos: { "x-requested-with": "fetch" } });
    expect(r.status).toBe(422);
    expect(await estado_de(p.id)).toBe("PARECER_EM_ELABORACAO");
  });

  it("quem não move processo nem chega a mandar o formulário do quadro", async () => {
    const p = await processo_em("EM_TRIAGEM");
    const r = await (await como("servidor_consulta")).post(`/kanban/mover/${p.id}`, { coluna: "CONCLUIDO" });
    expect(r.status).toBe(403);
  });
});

// =====================================================================
// D7 — a justificativa qualitativa é do ato, não da observação da criação
// =====================================================================
describe("D7: justificativa da avaliação qualitativa", () => {
  it("observação da criação não vale; comentário curto também não", async () => {
    const p = await processo_em("AGUARDANDO_QUANTIFICACAO", { observacoes: "TESTE-processos fluxo completo" });
    await expect(mover(db, p, "LAUDO_EM_ELABORACAO", coordenador)).rejects.toBeInstanceOf(RequisitoDeSaidaNaoAtendido);
    await expect(mover(db, p, "LAUDO_EM_ELABORACAO", coordenador, { comentario: "qualitativa" })).rejects.toBeInstanceOf(
      RequisitoDeSaidaNaoAtendido,
    );
  });

  it("a justificativa no comentário passa e fica no evento", async () => {
    const p = await processo_em("AGUARDANDO_QUANTIFICACAO");
    const justificativa = "Agente sem limite de tolerância (NR-15, Anexo 13): avaliação qualitativa.";
    await mover(db, p, "LAUDO_EM_ELABORACAO", coordenador, { comentario: justificativa });
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.processo_id, p.id), eq(e.historico_evento.tipo_evento, "ESTADO_ALTERADO")));
    expect(ev!.comentario).toBe(justificativa);
  });

  it("o relatório de campo dispensa a justificativa", async () => {
    const p = await processo_em("AGUARDANDO_QUANTIFICACAO");
    await anexar(p.id, "RELATORIO_CAMPO");
    await mover(db, p, "LAUDO_EM_ELABORACAO", coordenador);
    expect(await estado_de(p.id)).toBe("LAUDO_EM_ELABORACAO");
  });
});

// =====================================================================
// D2 / D9 — datas e escolhas do processo novo e do lote
// =====================================================================
describe("D2/D9: datas e escolhas validadas", () => {
  it("o serviço recusa autuação no futuro", async () => {
    const amanha = datas_br.somar_dias(datas_br.hoje(), 1);
    const erro = await criar(db, coordenador, {
      nup: nup_novo(),
      tipo_processo_id: (await tipo("ADICIONAL_OCUPACIONAL")).id,
      data_autuacao: amanha,
    }).catch((x) => x);
    expect(erro).toBeInstanceOf(ProcessoRecusado);
    expect(erro.message).toContain("Data de autuação");
  });

  it("o formulário recusa data inválida, futura e servidor que não existe — na própria tela", async () => {
    const cliente = await como("coordenador_csso");
    const base = { nup: nup_novo(), tipo_processo_id: String((await tipo("ADICIONAL_OCUPACIONAL")).id) };
    const invalida = await cliente.post("/processos/novo", { ...base, data_autuacao: "2026-13-45" });
    expect(invalida.status).toBe(200);
    expect(invalida.text).toContain("Data de autuação: data inválida");
    const futura = await cliente.post("/processos/novo", { ...base, data_autuacao: "2030-01-01" });
    expect(futura.status).toBe(200);
    expect(futura.text).toContain("Data de autuação");
    expect(futura.text).toContain('value="2030-01-01"');
    const servidor = await cliente.post("/processos/novo", { ...base, servidor_id: "abc" });
    expect(servidor.status).toBe(200);
    expect(servidor.text).toContain("Servidor inválido");
    const inexistente = await cliente.post("/processos/novo", { ...base, servidor_id: "999999" });
    expect(inexistente.text).toContain("Servidor inválido");
  });

  it("o lote recusa prazo que não é data, sem 500 nem JSON", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("EM_TRIAGEM");
    for (const prazo of ["2026-13-45", "31/02/2026"]) {
      const r = await cliente.post("/processos/lote", { acao: "prazo", prazo, processo_id: String(p.id) }, { seguir: false });
      expect(r.status).toBe(303);
      expect(decodeURIComponent(r.location!)).toContain("Prazo: data inválida");
    }
    const [gravado] = await db.select().from(e.processo).where(eq(e.processo.id, p.id));
    expect(gravado!.prazo).toBeNull();
  });

  it("o painel descarta autuação depois da emissão (nunca média negativa)", async () => {
    const ano = Number(datas_br.hoje().slice(0, 4));
    const p = await processo_em("PARECER_PRONTO_P_ASSINATURA", { data_autuacao: `${ano + 4}-01-01` });
    const c = await parecer_do(p.id, "EMITIDO");
    await db.update(e.parecer_tecnico).set({ ano, data_emissao: `${ano}-02-11` }).where(eq(e.parecer_tecnico.id, c.parecer_id));
    const corpo = (await (await como("coordenador_csso")).get("/")).text;
    const kpi = /Dias médios até a emissão<\/div>\s*<div class="medida">\s*<span class="valor">([^<]*)<\/span>/.exec(corpo);
    expect(kpi, corpo.slice(0, 300)).not.toBeNull();
    expect(kpi![1]).not.toContain("-");
  });
});

// =====================================================================
// D80 — responsável é quem trabalha o processo
// =====================================================================
describe("D80: responsáveis possíveis", () => {
  it("só contas ativas com processo.editar ou processo.status", async () => {
    await criarUsuario(db, { login: "inativo_tecnico", perfis: ["tecnico_seguranca"], ativo: false });
    const logins = (await responsaveis_possiveis(db)).map((r) => r.login);
    expect(logins).toContain("coordenador_csso");
    expect(logins).toContain("secretaria_csso");
    expect(logins).not.toContain("servidor_consulta");
    expect(logins).not.toContain("admin_ti");
    expect(logins).not.toContain("auditor_interno");
    expect(logins).not.toContain("inativo_tecnico");
  });

  it("o lote recusa atribuir a quem só lê", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("EM_TRIAGEM");
    const [servidor] = await db.select().from(e.usuario).where(eq(e.usuario.login, "servidor_consulta"));
    const r = await cliente.post(
      "/processos/lote",
      { acao: "responsavel", responsavel_id: String(servidor!.id), processo_id: String(p.id) },
      { seguir: false },
    );
    expect(decodeURIComponent(r.location!)).toContain("Responsável inválido");
    const [gravado] = await db.select().from(e.processo).where(eq(e.processo.id, p.id));
    expect(gravado!.responsavel_id).toBeNull();
    const lista = (await cliente.get("/processos")).text;
    expect(lista).not.toContain(`<option value="${servidor!.id}">`);
  });
});

// =====================================================================
// D8 / M17 — o link do SEI
// =====================================================================
describe("D8/M17: link do SEI", () => {
  it("o botão e a camada só saem com processo.editar", async () => {
    const p = await processo_em("EM_TRIAGEM");
    const ficha = (await (await como("consulta_progep")).get(`/processos/${p.id}`)).text;
    expect(ficha).not.toContain('href="#salvar-link-sei"');
    expect(ficha).not.toContain('id="salvar-link-sei"');
    const coord = (await (await como("coordenador_csso")).get(`/processos/${p.id}`)).text;
    expect(coord).toContain('href="#salvar-link-sei"');
  });

  it("link que não é do SEI volta na camada; o certo confirma", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("EM_TRIAGEM");
    const ruim = await cliente.post(`/processos/${p.id}/sei`, { url_permanente: "javascript:alert(1)" });
    expect(ruim.status).toBe(200);
    expect(ruim.text).toContain("Link do SEI inválido");
    let [gravado] = await db.select().from(e.processo).where(eq(e.processo.id, p.id));
    expect(gravado!.url_permanente).toBeNull();
    const bom = await cliente.post(
      `/processos/${p.id}/sei`,
      { url_permanente: "https://sei.ufvjm.edu.br/sei/controlador.php?acao=procedimento_trabalhar&id=1" },
      { seguir: false },
    );
    expect(decodeURIComponent(bom.location!)).toContain("Link do SEI salvo.");
    [gravado] = await db.select().from(e.processo).where(eq(e.processo.id, p.id));
    expect(gravado!.url_permanente).toContain("https://sei.ufvjm.edu.br/");
  });
});

// =====================================================================
// D13 — a trilha de estado com acento na tela (e o gravado intacto)
// =====================================================================
describe("D13: histórico acentuado só na exibição", () => {
  it("converte o rótulo ASCII e a seta", () => {
    expect(rotulo_tela_do_ascii("Aguardando inspecao -> Inspecionado")).toBe("Aguardando inspeção → Inspecionado");
    expect(rotulo_tela_do_ascii("salto Em triagem -> Laudo em elaboracao")).toBe("salto Em triagem → Laudo em elaboração");
  });

  it("a ficha mostra acentuado e o banco guarda o texto de sempre", async () => {
    const cliente = await como("coordenador_csso");
    const criado = await cliente.post(
      "/processos/novo",
      { nup: nup_novo(), tipo_processo_id: String((await tipo("PGR")).id) },
      { seguir: false },
    );
    const id = Number(criado.location!.split("/").pop());
    await cliente.post(`/processos/${id}/estado`, { destino: "CONCLUIDO" }, { seguir: false });
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.processo_id, id), eq(e.historico_evento.tipo_evento, "ESTADO_ALTERADO")));
    expect(ev!.descricao).toBe("Recebido -> Concluido");
    const ficha = (await cliente.get(`/processos/${id}?aba=historico`)).text;
    expect(ficha).toContain("Recebido → Concluído");
    // os "Últimos eventos" do painel também (revisão)
    const painel = (await cliente.get("/", { cabecalhos: FORMULARIO })).text;
    expect(painel).toContain("Recebido → Concluído");
    expect(painel).not.toContain("Recebido -&gt; Concluido");
  });
});

// =====================================================================
// M4 / M78 / M0 — a lista e a ficha para quem não lê nome, e para o servidor
// =====================================================================
describe("M4/M78/M0: lista e ficha", () => {
  it("a busca da lista acha pelo SIAPE, também para quem não lê nome", async () => {
    const [sv] = await db.insert(e.servidor).values({ siape: "7654321", nome: "Fulana Buscável" }).returning();
    const p = await processo_em("EM_TRIAGEM", { servidor_id: sv!.id });
    const corpo = (await (await como("secretaria_csso")).get("/processos?q=7654321")).text;
    expect(corpo).toContain(p.nup);
    expect(corpo).not.toContain("Fulana Buscável");
    // e o nome não acha para quem não pode ler o nome (RN-19)
    const pelo_nome = (await (await como("secretaria_csso")).get("/processos?q=Buscável")).text;
    expect(pelo_nome).not.toContain(p.nup);
  });

  it("a lista acha o NUP colado sem pontuação, como a busca global (M66)", async () => {
    const p = await processo_em("EM_TRIAGEM");
    const corpo = (await (await como("coordenador_csso")).get(`/processos?q=${p.nup.replace(/\D/g, "")}`)).text;
    expect(corpo).toContain(p.nup);
    expect(corpo).not.toContain("Nenhum processo casa");
  });

  it("o título da ficha é o NUP quando o nome está suprimido", async () => {
    const [sv] = await db.insert(e.servidor).values({ siape: "7654322", nome: "Beltrano Suprimido" }).returning();
    const p = await processo_em("EM_TRIAGEM", { servidor_id: sv!.id });
    const ficha = (await (await como("secretaria_csso")).get(`/processos/${p.id}`)).text;
    expect(ficha).toContain(`<h1 class="mono">${p.nup}</h1>`);
    expect(ficha).toMatch(/SRV-[0-9a-f]{4}/);
  });

  it("o servidor não ganha caixas de lote nem as visões do setor", async () => {
    const corpo = (await (await como("servidor_consulta")).get("/processos")).text;
    expect(corpo).not.toContain('id="form-lote"');
    expect(corpo).not.toContain('class="marcar"');
    expect(corpo).not.toContain("Precisam de você hoje");
    const coord = (await (await como("coordenador_csso")).get("/processos")).text;
    expect(coord).toContain('id="form-lote"');
    expect(coord).toContain("Precisam de você hoje");
  });

  it("o lote recusa quem não tem ação de lote antes de ler o formulário", async () => {
    const r = await (await como("servidor_consulta")).post("/processos/lote", { acao: "estado", destino: "ARQUIVADO" });
    expect(r.status).toBe(403);
  });
});

// =====================================================================
// M3 — processo novo
// =====================================================================
describe("M3: processo novo", () => {
  it("abre com o adicional ocupacional escolhido e a dispensa do DV marcada para o script", async () => {
    const corpo = (await (await como("coordenador_csso")).get("/processos/novo")).text;
    const adicional = await tipo("ADICIONAL_OCUPACIONAL");
    expect(corpo).toContain(`<option value="${adicional.id}" selected>`);
    expect(corpo).toContain("data-nup-dispensa");
    expect(corpo).not.toContain('data-nup-dispensa="aberta"');
  });

  it("recusado pelo DV, a dispensa nasce aberta", async () => {
    const cliente = await como("coordenador_csso");
    const r = await cliente.post("/processos/novo", {
      nup: "23086.000001/2026-00",
      tipo_processo_id: String((await tipo("ADICIONAL_OCUPACIONAL")).id),
    });
    expect(r.text).toContain('data-nup-dispensa="aberta"');
  });

  it("a busca de servidor acha pelo SIAPE e mostra o código opaco para quem não lê nome", async () => {
    await db.insert(e.servidor).values({ siape: "7654323", nome: "Ciclana Opaca" });
    const r = await (await como("secretaria_csso")).get("/processos/novo/servidores?q=7654323");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/SRV-[0-9a-f]{4}/);
    expect(r.text).not.toContain("Ciclana Opaca");
    const pelo_nome = await (await como("secretaria_csso")).get("/processos/novo/servidores?q=Ciclana");
    expect(pelo_nome.text).toContain("Nada encontrado");
  });
});

// =====================================================================
// M18 — a categoria do anexo
// =====================================================================
describe("M18: categoria do anexo", () => {
  it("o reenvio idêntico em outra categoria oferece reclassificar, e a troca fica na trilha", async () => {
    const cliente = await como("coordenador_csso");
    const p = await processo_em("EM_TRIAGEM");
    const arquivo = new File([new TextEncoder().encode(`portaria-${p.id}`)], "portaria.pdf", { type: "application/pdf" });
    await cliente.post(`/processos/${p.id}/anexos`, { categoria: "OUTRO", arquivo });
    const de_novo = await cliente.post(`/processos/${p.id}/anexos`, { categoria: "PORTARIA", arquivo });
    expect(de_novo.text).toContain("já está anexado como “Outro”");
    expect(de_novo.text).toContain("Reclassificar como “Portaria de localização”");
    const [anexo] = await db
      .select()
      .from(e.anexo)
      .where(and(eq(e.anexo.entidade, "processo"), eq(e.anexo.entidade_id, p.id)));
    const r = await cliente.post(`/processos/${p.id}/anexos/${anexo!.id}/categoria`, { categoria: "PORTARIA" });
    expect(r.text).toContain("Anexo reclassificado como “Portaria de localização”.");
    const [depois] = await db.select().from(e.anexo).where(eq(e.anexo.id, anexo!.id));
    expect(depois!.categoria).toBe("PORTARIA");
    const trilha = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "anexo"), eq(e.historico_evento.entidade_id, anexo!.id)));
    expect(trilha.some((ev) => ev.campo === "categoria" && ev.valor_novo === "PORTARIA")).toBe(true);
    // e a portaria reclassificada conta para a triagem
    expect((await requisitos_de_saida(db, p, "AGUARDANDO_INSPECAO")).join(" ")).not.toContain("portaria");
  });

  it("reclassificar não abre documento restrito e recusa categoria de fora", async () => {
    const p = await processo_em("EM_TRIAGEM");
    const { anexo } = await anexar(p.id, "FORMULARIO", `formulario-restrito-${p.id}`);
    expect(anexo.nivel_acesso).toBe("RESTRITO");
    const depois = await servico_anexos.reclassificar(db, anexo, "OUTRO", coordenador, p.id);
    expect(depois.nivel_acesso).toBe("RESTRITO");
    await expect(servico_anexos.reclassificar(db, anexo, "CERTIFICADO", coordenador, p.id)).rejects.toThrow("Categoria inválida");
  });

  it("a aba mostra o rótulo, e não o código", async () => {
    const p = await processo_em("EM_TRIAGEM");
    await anexar(p.id, "FORMULARIO", `rotulo-${p.id}`);
    const aba = (await (await como("coordenador_csso")).get(`/processos/${p.id}?aba=anexos`)).text;
    expect(aba).toContain("<td>Formulário</td>");
  });
});

// =====================================================================
// D60 / M5 / M57 — o painel do servidor
// =====================================================================
describe("D60/M57: início do servidor", () => {
  it("o servidor vê o início dele, sem os blocos do setor", async () => {
    const corpo = (await (await como("servidor_consulta")).get("/")).text;
    expect(corpo).toContain("Meu adicional");
    expect(corpo).toContain("Meus processos");
    expect(corpo).toContain("Próximo treinamento");
    expect(corpo).toContain("Certificados a vencer");
    expect(corpo).toContain("EPI com troca vencida");
    expect(corpo).not.toContain("Distribuição por tipo de risco");
    expect(corpo).not.toContain("Últimos eventos");
    expect(corpo).not.toContain("Dias médios até a emissão");
  });

  it("o servidor vinculado vê o próprio adicional", async () => {
    const c = await parecer_do((await processo_em("EM_TRIAGEM")).id, "ASSINADO");
    const [percentual] = await db.select().from(e.percentual_aplicavel).limit(1);
    const [tipo_adicional] = await db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.id, percentual!.tipo_adicional_id));
    await db.insert(e.adicional_vigencia).values({
      servidor_id: c.servidor_id,
      parecer_id: c.parecer_id,
      tipo_adicional_id: tipo_adicional!.id,
      percentual_id: percentual!.id,
      estado: "VIGENTE",
      data_inicio: "2025-03-01",
    });
    await criarUsuario(db, { login: "titular_adicional", perfis: ["servidor_consulta"], servidor_id: c.servidor_id });
    const corpo = (await (await como("titular_adicional")).get("/")).text;
    expect(corpo).toContain(percentual!.rotulo);
    expect(corpo).toContain("vigente");
  });
});

// =====================================================================
// M14 / M82 — importação
// =====================================================================
describe("M14/M82: importação", () => {
  it("JSON sem a forma do Trello volta à tela com a frase", async () => {
    const cliente = await como("coordenador_csso");
    const arquivo = new File([new TextEncoder().encode('{"nome": "planilha qualquer"}')], "x.json", { type: "application/json" });
    const r = await cliente.post("/importar/trello", { arquivo });
    expect(r.status).toBe(422);
    expect(r.text).toContain("não parece um export do Trello");
    expect(r.text).toContain('action="/importar/trello"');
  });

  it("JSON quebrado também volta à tela, sem página de erro", async () => {
    const cliente = await como("coordenador_csso");
    const arquivo = new File([new TextEncoder().encode("{quebrado")], "x.json", { type: "application/json" });
    const r = await cliente.post("/importar/trello", { arquivo });
    expect(r.text).toContain("não é um JSON válido");
    expect(r.text).toContain('action="/importar/planilha"');
  });

  it("o CSV da reconciliação exige a permissão da tela", async () => {
    const r = await (await como("engenheiro_seguranca")).get("/importar/reconciliacao.csv");
    expect(r.status).toBe(403);
    expect((await (await como("engenheiro_seguranca")).get("/importar/reconciliacao")).status).toBe(403);
  });
});
