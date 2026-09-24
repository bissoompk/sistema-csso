/**
 * Demandas — o que chega por e-mail ou no balcão e ainda não é processo SEI.
 * Porte de `testes/integracao/test_demandas.py`.
 *
 * O que estes testes guardam, na ordem em que a funcionalidade perde o valor se
 * falhar: (1) o desfecho é obrigatório para encerrar; (2) `VIROU_PROCESSO`
 * aponta para um `processo.id` real; (3) o prazo cobra (sino); (4) RN-21 em
 * todo texto livre, e a recusa preserva o que foi digitado; (5) RN-31 no
 * encaminhamento — a trava é de banco.
 *
 * Diferença de montagem: o Python criava o processo pela rota `/processos/novo`
 * (outro módulo do porte); aqui ele é inserido direto, com a mesma forma.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { count, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { Demanda as DemandaDominio } from "../src/dominio/demanda.js";
import { ROTULO_EVENTO, cadeia_integra } from "../src/servicos/auditoria.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";

const HOJE = hoje_iso();
const NOME_SERVIDOR = "Marco Antônio Alves Schetino";
const SIAPE = "1110654";

// o primeiro `bancoLimpo` registra o afterAll que apaga todos os clones
let amb: AmbienteDeTeste = await bancoLimpo();
let cliente: Cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  cliente = amb.cliente;
});

// ---------------------------------------------------------------------
// Ajudantes
// ---------------------------------------------------------------------
function _registrar(campos: Record<string, string> = {}): Promise<Resposta> {
  return cliente.post(
    "/demandas",
    {
      assunto: "Chefia da FAMED pergunta sobre laudo do laboratório",
      canal: "EMAIL",
      solicitante_nome: "Chefia da FAMED",
      data_chegada: HOJE,
      descricao: "Pediu orientação sobre o laudo do laboratório de análises.",
      ...campos,
    },
    { seguir: false },
  );
}

function _id_da_criada(r: Resposta): number {
  expect(r.status, r.text.slice(0, 400)).toBe(303);
  return Number(r.location!.split("/demandas/")[1]!.split("?")[0]);
}

async function _demanda_criada(): Promise<number> {
  await entrar(cliente, "coordenador_csso");
  return _id_da_criada(await _registrar());
}

async function _gravada(id: number) {
  return amb.db.query.demanda.findFirst({
    where: eq(e.demanda.id, id),
    with: { encaminhamentos: { orderBy: (x, { asc }) => [asc(x.id)] } },
  });
}

/** Um processo SEI de verdade (o Python o criava pela rota `/processos/novo`). */
async function _processo_no_sistema(nup = "23086.021284/2024-56"): Promise<string> {
  const [tipo] = await amb.db.select().from(e.tipo_processo).limit(1);
  const [etapa] = await amb.db.select().from(e.fluxo_etapa).limit(1);
  await amb.db.insert(e.processo).values({ nup, tipo_processo_id: tipo!.id, etapa_id: etapa!.id });
  await entrar(cliente, "coordenador_csso");
  return nup;
}

/** A recusa do banco, com a razão do driver (o Drizzle embrulha o erro em `cause`). */
async function falha(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (erro: any) {
    return [erro?.message, erro?.cause?.message, erro?.cause?.constraint_name].filter(Boolean).join(" | ");
  }
  throw new Error("o banco aceitou o que devia recusar");
}

async function _pendencia(chave: string) {
  const [p] = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.chave, chave));
  return p ?? null;
}

// =====================================================================
// 1. Registro — e os três padrões que fazem caber em trinta segundos
// =====================================================================
describe("registro", () => {
  it("registrar preenche hoje e o próprio usuário", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ data_chegada: "", responsavel_id: "" }));
    const gravada = (await _gravada(id))!;
    const [quem] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    expect(gravada.data_chegada).toBe(HOJE);
    expect(gravada.responsavel_id).toBe(quem!.id);
    expect(gravada.estado).toBe("ABERTA");
    expect(gravada.desfecho).toBeNull();
  });

  it("o canal é vocabulário fechado", async () => {
    await entrar(cliente, "coordenador_csso");
    const recusa = await _registrar({ canal: "POMBO_CORREIO" });
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("Canal desconhecido");
  });

  it("assunto em branco não vira linha na fila", async () => {
    await entrar(cliente, "coordenador_csso");
    const recusa = await _registrar({ assunto: "   " });
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("O assunto é obrigatório");
  });
});

// =====================================================================
// 2. RN-21 — o campo mais perigoso do sistema, e a recusa que não apaga
// =====================================================================
describe("RN-21", () => {
  it.each([
    ["descricao", "A servidora está grávida e pediu remoção do laboratório."],
    ["assunto", "Atestado médico da servidora do LEAC"],
    ["solicitante_nome", "Servidora com doença ocupacional"],
  ])("recusa dado de saúde em %s", async (campo, valor) => {
    await entrar(cliente, "coordenador_csso");
    const recusa = await _registrar({ [campo]: valor });
    expect(recusa.status).toBe(200);
    expect(recusa.text).toContain("termo proibido");
  });

  it("recusada devolve o popup aberto com o que foi digitado", async () => {
    await entrar(cliente, "coordenador_csso");
    const prazo = somar_dias(HOJE, 7);
    const corpo = (
      await _registrar({
        assunto: "Pedido de avaliação do laboratório",
        solicitante_nome: "Chefia do LEAC",
        descricao: "A servidora está grávida e pediu remoção.",
        prazo,
      })
    ).text;
    const abertos = [...corpo.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]);
    expect(abertos).toEqual(["nova-demanda"]);
    expect(corpo).toContain('value="Pedido de avaliação do laboratório"');
    expect(corpo).toContain('value="Chefia do LEAC"');
    expect(corpo).toContain("A servidora está grávida e pediu remoção.");
    expect(corpo).toContain(`value="${prazo}"`);
  });

  it("nada é gravado na recusa", async () => {
    await entrar(cliente, "coordenador_csso");
    await _registrar({ descricao: "Tem diagnóstico de LER no laudo." });
    const [{ n }] = (await amb.db.select({ n: count() }).from(e.demanda)) as [{ n: number }];
    expect(n).toBe(0);
  });
});

// =====================================================================
// 3. Encaminhamento — append-only (RN-31)
// =====================================================================
describe("encaminhamento", () => {
  it("encaminhar põe a demanda em andamento", async () => {
    const demanda = await _demanda_criada();
    const r = await cliente.post(
      `/demandas/${demanda}/encaminhar`,
      { para_quem: "Engenharia de Segurança", pedido: "Avaliar o posto e dizer se cabe laudo novo.", data_encaminhamento: HOJE },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const gravada = (await _gravada(demanda))!;
    expect(gravada.estado).toBe("EM_ANDAMENTO");
    expect(gravada.encaminhamentos).toHaveLength(1);
    expect(gravada.encaminhamentos[0]!.para_quem).toBe("Engenharia de Segurança");
  });

  it("encaminhamento sem o que foi pedido é recusado", async () => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encaminhar`, { para_quem: "PROGEP", pedido: "  " })).text;
    expect(corpo).toContain("Escreva o que foi pedido");
  });

  it("RN-31: o encaminhamento não se edita nem se apaga", async () => {
    const [demanda] = await amb.db
      .insert(e.demanda)
      .values({ data_chegada: HOJE, canal: "PRESENCIAL", solicitante_nome: "Balcão", assunto: "teste da trava", estado: "ABERTA" })
      .returning();
    await amb.db
      .insert(e.demanda_encaminhamento)
      .values({ demanda_id: demanda!.id, data_encaminhamento: HOJE, para_quem: "PROGEP", pedido: "conferir a lotação" });
    expect(await falha(amb.db.execute(sql`UPDATE demanda_encaminhamento SET para_quem = 'outro'`))).toMatch(/append-only/);
    expect(await falha(amb.db.execute(sql`DELETE FROM demanda_encaminhamento`))).toMatch(/append-only/);
  });
});

// =====================================================================
// 4. Encerramento com desfecho obrigatório — onde está o valor
// =====================================================================
describe("encerramento", () => {
  it("encerrar sem desfecho é recusado", async () => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "" })).text;
    expect(corpo).toContain("Escolha um desfecho");
  });

  it.each(["RESOLVIDA", "SEM_PROVIDENCIA"])("%s exige o texto", async (desfecho) => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho, relato: " " })).text;
    expect(corpo).toContain("Falta o desfecho por escrito");
  });

  it("encerrar RESOLVIDA grava o que foi feito", async () => {
    const demanda = await _demanda_criada();
    const r = await cliente.post(
      `/demandas/${demanda}/encerrar`,
      { desfecho: "RESOLVIDA", relato: "Respondi por e-mail com o laudo vigente do posto." },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const gravada = (await _gravada(demanda))!;
    expect(gravada.estado).toBe("ENCERRADA");
    expect(gravada.desfecho).toBe("RESOLVIDA");
    expect(gravada.desfecho_relato).toContain("laudo vigente");
    expect(gravada.encerrada_por).not.toBeNull();
  });

  it("ENCAMINHADA exige o setor", async () => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "ENCAMINHADA", setor: "" })).text;
    expect(corpo).toContain("Diga para qual setor");
  });

  it("ENCAMINHADA grava setor e data", async () => {
    const demanda = await _demanda_criada();
    await cliente.post(
      `/demandas/${demanda}/encerrar`,
      { desfecho: "ENCAMINHADA", setor: "PROGEP", data_desfecho: HOJE },
      { seguir: false },
    );
    const gravada = (await _gravada(demanda))!;
    expect([gravada.desfecho_setor, gravada.desfecho_data]).toEqual(["PROGEP", HOJE]);
  });

  it("encerrada não recebe mais encaminhamento", async () => {
    const demanda = await _demanda_criada();
    await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "RESOLVIDA", relato: "respondido por e-mail" }, { seguir: false });
    const corpo = (await cliente.post(`/demandas/${demanda}/encaminhar`, { para_quem: "PROGEP", pedido: "cobrar de novo" })).text;
    expect(corpo).toContain("não recebe encaminhamento");
  });

  it("encerrada é terminal", async () => {
    const demanda = await _demanda_criada();
    await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "RESOLVIDA", relato: "respondido por e-mail" }, { seguir: false });
    const segunda = await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "SEM_PROVIDENCIA", relato: "mudei de ideia" });
    expect(segunda.text).toContain("Transição proibida");
  });
});

// =====================================================================
// 5. VIROU_PROCESSO — a rastreabilidade que só vale se der para clicar
// =====================================================================
describe("VIROU_PROCESSO", () => {
  it("liga a demanda ao processo real", async () => {
    const nup = await _processo_no_sistema();
    const id = _id_da_criada(await _registrar());
    const r = await cliente.post(`/demandas/${id}/encerrar`, { desfecho: "VIROU_PROCESSO", nup }, { seguir: false });
    expect(r.status).toBe(303);
    const gravada = (await _gravada(id))!;
    const [proc] = await amb.db.select().from(e.processo).where(eq(e.processo.nup, nup));
    expect(gravada.desfecho).toBe("VIROU_PROCESSO");
    expect(gravada.desfecho_processo_id).toBe(proc!.id);
    // e a ficha oferece o link, que é a razão de a FK existir
    const corpo = (await cliente.get(`/demandas/${id}`)).text;
    expect(corpo).toContain(`href="/processos/${proc!.id}"`);
  });

  it("NUP de processo inexistente recusa dizendo onde cadastrar", async () => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "VIROU_PROCESSO", nup: "23086.000608/2026-84" })).text;
    expect(corpo).toContain("Não há processo 23086.000608/2026-84 cadastrado");
    expect(corpo).toContain("Novo processo");
  });

  it("NUP mal formado recusa com o formato", async () => {
    const demanda = await _demanda_criada();
    const corpo = (await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "VIROU_PROCESSO", nup: "123" })).text;
    expect(corpo).toContain("não é um NUP");
  });

  it("NUP colado sujo é aceito", async () => {
    await _processo_no_sistema();
    const id = _id_da_criada(await _registrar());
    const r = await cliente.post(`/demandas/${id}/encerrar`, { desfecho: "VIROU_PROCESSO", nup: " 23086 021284 2024 56 " }, { seguir: false });
    expect(r.status).toBe(303);
  });

  it("o banco recusa desfecho sem a prova que ele exige", async () => {
    const recusa = await falha(
      amb.db.insert(e.demanda).values({
        data_chegada: HOJE,
        canal: "EMAIL",
        solicitante_nome: "X",
        assunto: "virou processo sem processo",
        estado: "ENCERRADA",
        desfecho: "VIROU_PROCESSO",
      }),
    );
    expect(recusa).toContain("ck_demanda_desfecho_campos");
  });

  it("o banco recusa encerrar sem desfecho", async () => {
    const recusa = await falha(
      amb.db
        .insert(e.demanda)
        .values({ data_chegada: HOJE, canal: "EMAIL", solicitante_nome: "X", assunto: "encerrada sem dizer como", estado: "ENCERRADA" }),
    );
    expect(recusa).toContain("ck_demanda_encerrada_tem_desfecho");
  });
});

// =====================================================================
// 6. O prazo cobra — a demanda no mesmo sino das pendências
// =====================================================================
describe("prazo e sino", () => {
  it("demanda com prazo abre pendência ancorada", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ prazo: somar_dias(HOJE, 5) }));
    const tarefa = (await _pendencia(`demanda:${id}`))!;
    expect(tarefa.tipo).toBe("DEMANDA_COM_PRAZO");
    expect([tarefa.entidade, tarefa.entidade_id]).toEqual(["demanda", id]);
    expect(tarefa.prazo).toBe(somar_dias(HOJE, 5));
    expect(tarefa.concluida).toBe(false);
  });

  it("demanda sem prazo não enche o sino", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ prazo: "" }));
    expect(await _pendencia(`demanda:${id}`)).toBeNull();
  });

  it("encerrar tira a demanda do sino", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ prazo: somar_dias(HOJE, 5) }));
    await cliente.post(`/demandas/${id}/encerrar`, { desfecho: "SEM_PROVIDENCIA", relato: "o posto foi desativado" }, { seguir: false });
    expect((await _pendencia(`demanda:${id}`))!.concluida).toBe(true);
  });

  it("a demanda atrasada aparece no sino e leva até ela", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ prazo: somar_dias(HOJE, -3) }));
    expect(DemandaDominio.atrasada((await _gravada(id))!, HOJE)).toBe(true);

    // a tela /pendencias é do porte de Processos; o sino do cabeçalho é daqui
    const lista = await cliente.get("/demandas");
    expect(lista.text).toContain('class="sino');
    const corpo = await cliente.get("/pendencias");
    if (corpo.status === 404) return; // TODO(porte): /pendencias ainda não portada
    expect(corpo.text).toContain("Demanda com prazo a cumprir");
    // a âncora da fila carrega o caminho de volta (`?de=pendencias`)
    expect(corpo.text).toContain(`href="/demandas/${id}?de=pendencias"`);
    expect(corpo.text).toContain('class="sino');
  });

  it("trocar o responsável leva a tarefa junto", async () => {
    await entrar(cliente, "coordenador_csso");
    const id = _id_da_criada(await _registrar({ prazo: somar_dias(HOJE, 5) }));
    const [outro] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "tecnico_seguranca"));
    await cliente.post(`/demandas/${id}/atribuir`, { responsavel_id: String(outro!.id) }, { seguir: false });
    expect((await _gravada(id))!.responsavel_id).toBe(outro!.id);
    expect((await _pendencia(`demanda:${id}`))!.responsavel_id).toBe(outro!.id);
  });
});

// =====================================================================
// 7. RN-19 — onde há servidor, o nome sai por `identificar(...)`
// =====================================================================
describe("RN-19", () => {
  async function servidor_id(): Promise<number> {
    await entrar(cliente, "coordenador_csso");
    const criado = await cliente.post("/servidores", { siape: SIAPE, nome: NOME_SERVIDOR }, { seguir: false });
    return Number(criado.location!.split("/").pop()!.split("?")[0]);
  }

  it("a lista suprime o servidor vinculado", async () => {
    const sv = await servidor_id();
    await _registrar({ solicitante_nome: "pedido do laboratório", solicitante_servidor_id: String(sv) });
    await entrar(cliente, "secretaria_csso");
    const corpo = (await cliente.get("/demandas")).text;
    expect(corpo).not.toContain(NOME_SERVIDOR);
    expect(corpo).not.toContain(SIAPE);
    expect(corpo).toMatch(/SRV-[0-9a-f]{4}\b/);
  });

  it("quem vê nominal continua lendo o nome", async () => {
    const sv = await servidor_id();
    const id = _id_da_criada(await _registrar({ solicitante_nome: "pedido do laboratório", solicitante_servidor_id: String(sv) }));
    for (const caminho of ["/demandas", `/demandas/${id}`]) {
      expect((await cliente.get(caminho)).text, caminho).toContain(NOME_SERVIDOR);
    }
  });

  it("a busca não é oráculo de nome", async () => {
    const sv = await servidor_id();
    await _registrar({
      assunto: "Avaliação do laboratório de análises",
      solicitante_nome: NOME_SERVIDOR,
      solicitante_servidor_id: String(sv),
    });
    await entrar(cliente, "secretaria_csso");
    const por_nome = (await cliente.get("/demandas?q=Marco")).text;
    expect(por_nome).not.toContain("Avaliação do laboratório de análises");
    expect(por_nome).toContain("Nenhuma demanda nesta seleção.");
    expect(por_nome).not.toContain(NOME_SERVIDOR);
    const por_assunto = (await cliente.get(`/demandas?q=${encodeURIComponent("laboratório")}`)).text;
    expect(por_assunto).toContain("Avaliação do laboratório de análises");
  });
});

// =====================================================================
// 8. Permissão — a equipe toda enxerga, e nem toda ela escreve
// =====================================================================
describe("permissão", () => {
  it("admin_ti não vê a fila", async () => {
    await entrar(cliente, "admin_ti");
    expect((await cliente.get("/demandas")).status).toBe(403);
    expect((await cliente.get("/modulos")).text).not.toContain('href="/demandas"');
  });

  it("o auditor lê e não escreve", async () => {
    const demanda = await _demanda_criada();
    await entrar(cliente, "auditor_interno");
    expect((await cliente.get("/demandas")).status).toBe(200);
    const ficha = (await cliente.get(`/demandas/${demanda}`)).text;
    expect(ficha).toContain("somente leitura");
    const r = await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "RESOLVIDA", relato: "x" }, { seguir: false });
    expect(r.status).toBe(403);
  });

  it("o seletor de responsável só oferece quem abre a tela", async () => {
    await entrar(cliente, "coordenador_csso");
    const corpo = (await cliente.get("/demandas")).text;
    const dentro = corpo.slice(corpo.indexOf('id="responsavel_id"'));
    const seletor = dentro.slice(0, dentro.indexOf("</select>"));
    expect(seletor).toContain("Coordenador de Teste");
    expect(seletor).toContain("Almoxarife de Teste");
    expect(seletor).not.toContain("Admin TI de Teste");
    expect(seletor).not.toContain("Servidor de Teste");
  });

  it("o almoxarife registra o que chega no balcão", async () => {
    await entrar(cliente, "almoxarife_sesmt");
    expect((await cliente.get("/demandas")).status).toBe(200);
    expect((await _registrar({ canal: "PRESENCIAL" })).status).toBe(303);
  });
});

// =====================================================================
// 9. A trilha de auditoria
// =====================================================================
describe("trilha", () => {
  it("toda transição deixa rastro na cadeia", async () => {
    const demanda = await _demanda_criada();
    await cliente.post(`/demandas/${demanda}/iniciar`, {}, { seguir: false });
    await cliente.post(`/demandas/${demanda}/encaminhar`, { para_quem: "PROGEP", pedido: "conferir a lotação" }, { seguir: false });
    await cliente.post(`/demandas/${demanda}/encerrar`, { desfecho: "RESOLVIDA", relato: "a PROGEP respondeu" }, { seguir: false });
    const tipos = (await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "demanda"))).map(
      (x) => x.tipo_evento,
    );
    expect((await cadeia_integra(amb.db))[0]).toBe(true);
    for (const esperado of ["DEMANDA_REGISTRADA", "DEMANDA_EM_ANDAMENTO", "DEMANDA_ENCAMINHADA", "DEMANDA_ENCERRADA"]) {
      expect(tipos, esperado).toContain(esperado);
      expect(ROTULO_EVENTO, esperado).toHaveProperty(esperado);
    }
  });
});

// =====================================================================
// 10. O povoamento do ambiente de teste (ferramentas/povoar/demandas.ts)
// =====================================================================
describe("povoar_demandas", () => {
  it("cobre os três estados e os quatro desfechos, com a atrasada no sino", async () => {
    const { povoar } = await import("../ferramentas/ambiente-teste.js");
    const { povoar_demandas, nup_de } = await import("../ferramentas/povoar/demandas.js");
    const { carregar_usuario_atual } = await import("../src/servicos/rbac.js");
    const novo = await bancoLimpo();
    await novo.db.transaction(async (tx) => {
      await povoar(tx);
      // o processo que a demanda 5 aponta (o povoamento de Processos o cria)
      const [tipo] = await tx.select().from(e.tipo_processo).limit(1);
      const [etapa] = await tx.select().from(e.fluxo_etapa).limit(1);
      await tx.insert(e.processo).values({ nup: nup_de(100002, Number(HOJE.slice(0, 4))), tipo_processo_id: tipo!.id, etapa_id: etapa!.id });
      const resumo: Record<string, number> = {};
      await povoar_demandas(tx, {
        resumo,
        atual: async (login) => {
          const [conta] = await tx.select().from(e.usuario).where(eq(e.usuario.login, login));
          return carregar_usuario_atual(tx, conta!.id);
        },
      });
      expect(resumo.demandas).toBe(7);
    });
    const todas = await novo.db.select().from(e.demanda);
    expect(new Set(todas.map((d) => d.estado))).toEqual(new Set(["ABERTA", "EM_ANDAMENTO", "ENCERRADA"]));
    expect(new Set(todas.map((d) => d.desfecho).filter(Boolean))).toEqual(
      new Set(["RESOLVIDA", "VIROU_PROCESSO", "ENCAMINHADA", "SEM_PROVIDENCIA"]),
    );
    expect(todas.filter((d) => DemandaDominio.atrasada(d, HOJE))).toHaveLength(1);
    expect(await novo.db.select().from(e.demanda_encaminhamento)).toHaveLength(2);
    expect((await cadeia_integra(novo.db))[0]).toBe(true);
  });
});
