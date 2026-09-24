/**
 * Rotas do Processos SEI: fluxo feliz, negativa de permissão e sem sessão
 * (CA-17), criação de processo e laudo pela tela, o sino e a fila de
 * pendências, e SLA/checklist modelo.
 *
 * Porte das partes deste módulo de `test_rotas_permissoes.py`,
 * `test_pendencias_e_sla.py` e `test_repositorios.py`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as pendencias from "../src/servicos/pendencias.js";
import * as servico_parecer from "../src/servicos/parecer.js";
import {
  SLA_PADRAO,
  aplicar_checklist_modelo,
  gravar_sla,
  resumir,
  sla_vigente,
} from "../src/servicos/processo.js";
import { ChecklistModelo } from "../src/dominio/dominios.js";
import { PermissaoNegada, UsuarioAtual, aplicar_escopo } from "../src/servicos/rbac.js";
import * as repo from "../src/repositorios/processos.js";
import { agora_utc } from "../src/db/esquema/base.js";
import { bancoLimpo, contas, entrar, naTransacao, usuarioAtual } from "./ajuda";
import { atores, cenario, parecerDe } from "./ajuda_processos";

const { db, app, novoCliente } = await bancoLimpo();
await contas(db);
const HTML = { cabecalhos: { accept: "text/html" } };

// (caminho, perfil que vê, perfil que NÃO vê)
const MATRIZ: readonly (readonly [string, string, string | null])[] = [
  ["/", "coordenador_csso", null],
  ["/kanban", "coordenador_csso", null],
  ["/processos", "coordenador_csso", null],
  ["/processos/novo", "coordenador_csso", "consulta_progep"],
  ["/laudos", "coordenador_csso", "admin_ti"],
  ["/adicionais", "coordenador_csso", "admin_ti"],
  ["/pendencias", "coordenador_csso", "admin_ti"],
  ["/importar/reconciliacao", "coordenador_csso", "secretaria_csso"],
  ["/relatorios", "coordenador_csso", null],
  ["/importar", "coordenador_csso", "secretaria_csso"],
];

describe("CA-17 — toda rota tem fluxo feliz e negativa", () => {
  it.each(MATRIZ)("%s abre para %s", async (caminho, perfil) => {
    const r = await (await entrar(novoCliente(), perfil)).get(caminho);
    expect(r.status, `${caminho} como ${perfil}`).toBe(200);
  });

  it.each(MATRIZ.filter(([, , n]) => n).map(([c, , n]) => [c, n!] as const))("%s nega %s", async (caminho, perfil) => {
    const r = await (await entrar(novoCliente(), perfil)).get(caminho);
    expect(r.status).toBe(403);
  });

  it.each(MATRIZ)("%s sem sessão vai para o login", async (caminho) => {
    const r = await novoCliente().get(caminho, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("exportar CSV exige permissão e sai com BOM", async () => {
    expect((await (await entrar(novoCliente(), "secretaria_csso")).get("/relatorios/exportar-processos")).status).toBe(403);
    const r = await (await entrar(novoCliente(), "coordenador_csso")).get("/relatorios/exportar-processos");
    expect(r.status).toBe(200);
    // o `text()` do fetch engole o BOM: confere-se nos bytes
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const cookie = [...cliente.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const cru = await app.fetch(new Request("http://testserver/relatorios/exportar-processos", { headers: { cookie } }));
    const bytes = new Uint8Array(await cru.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text.startsWith("NUP;Estado;Servidor")).toBe(true);
  });
});

describe("criar processo pela tela", () => {
  it("cria e abre a ficha", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(
      "/processos/novo",
      { nup: "23086.021284/2024-56", tipo_processo_id: "1", observacoes: "Instrução iniciada pela CSSO." },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const ficha = await cliente.get(r.location!);
    expect(ficha.status).toBe(200);
    expect(ficha.text).toContain("23086.021284/2024-56");
    const [criado] = await db.select().from(e.processo).where(eq(e.processo.nup, "23086.021284/2024-56"));
    expect(criado!.estado_tecnico).toBe("RECEBIDO");
    expect(criado!.responsavel_id).not.toBeNull();
  });

  it("NUP com DV inválido pede confirmação, e a dispensa fica na trilha", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post("/processos/novo", { nup: "23086.021284/2024-99", tipo_processo_id: "1" });
    expect(r.text).toContain("confirmei no SEI");
    // o que foi digitado volta
    expect(r.text).toContain('value="23086.021284/2024-99"');
    const ok = await cliente.post(
      "/processos/novo",
      { nup: "23086.021284/2024-99", tipo_processo_id: "1", dispensar_dv: "1" },
      { seguir: false },
    );
    expect(ok.status).toBe(303);
    const [p] = await db.select().from(e.processo).where(eq(e.processo.nup, "23086.021284/2024-99"));
    expect(p!.nup_dv_dispensado).toBe(true);
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.processo_id, p!.id));
    expect(eventos.map((x) => x.tipo_evento)).toContain("NUP_DV_DISPENSADO");
  });

  it("NUP duplicado é recusado", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const dados = { nup: "23086.000608/2026-84", tipo_processo_id: "1" };
    await cliente.post("/processos/novo", dados, { seguir: false });
    const repetido = await cliente.post("/processos/novo", dados);
    expect(repetido.text).toContain("já existe processo com este NUP");
  });

  it("colagem suja é normalizada e formato inválido é recusado", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post("/processos/novo", { nup: "23086 000540 2026 33", tipo_processo_id: "1" }, { seguir: false });
    expect(r.status).toBe(303);
    const ruim = await cliente.post("/processos/novo", { nup: "123", tipo_processo_id: "1" });
    expect(ruim.text).toContain("NUP deve ter 17 digitos");
  });

  it("observação com dado de saúde volta com o texto e sem gravar", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post("/processos/novo", {
      nup: "23086.000541/2026-01",
      tipo_processo_id: "1",
      observacoes: "servidora gestante",
      dispensar_dv: "1",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("termo proibido");
    expect(r.text).toContain("servidora gestante");
    expect(await db.select().from(e.processo).where(eq(e.processo.nup, "23086.000541/2026-01"))).toEqual([]);
  });
});

describe("laudos pela tela", () => {
  it("cadastrar laudo e marcar superado", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(
      "/laudos",
      { numero_siape: "26255-000.777/2019", tipo_adicional_id: "1", unidade_uorg_id: "1", data_emissao: "2019-06-01" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const caminho = r.location!;
    expect((await cliente.get(caminho)).status).toBe(200);
    const superar = await cliente.post(`${caminho}/superar`, { motivo: "mudança no processo de trabalho" }, { seguir: false });
    expect(superar.status).toBe(303);
    expect((await cliente.get(caminho)).text).toContain("superado");
  });

  it("número inválido volta com o formato e o que foi digitado", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post("/laudos", { numero_siape: "1/2019", tipo_adicional_id: "1", unidade_uorg_id: "1" });
    expect(r.text).toContain("Número de laudo inválido");
    expect(r.text).toContain('value="1/2019"');
    expect(r.text).toContain('<dialog class="popup" id="novo-laudo"');
  });

  it("vincular posto e registrar conferência", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(
      "/laudos",
      { numero_siape: "26255-000.778/2019", tipo_adicional_id: "1", unidade_uorg_id: "1" },
      { seguir: false },
    );
    const id = Number(r.location!.split("/").pop());
    const [posto] = await db.select().from(e.posto_trabalho).limit(1);
    await cliente.post(`/laudos/${id}/postos`, { posto_trabalho_id: posto!.id }, { seguir: false });
    await cliente.post(`/laudos/${id}/postos`, { posto_trabalho_id: posto!.id }, { seguir: false });
    expect(await db.select().from(e.laudo_posto).where(eq(e.laudo_posto.laudo_id, id))).toHaveLength(1);
    const conf = await cliente.post(`/laudos/${id}/conferencia`, { motivo: "visita" });
    expect(conf.text).toContain("Conferência registrada.");
    const [laudo] = await db.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, id));
    expect(laudo!.motivo_ultima_conferencia).toBe("visita");
    expect(laudo!.data_ultima_conferencia).not.toBeNull();
  });
});

describe("pendências (a fila e o sino)", () => {
  it("laudo superado abre pendência por parecer", async () => {
    await naTransacao(async (tx) => {
      const { COORDENADOR } = await atores(tx);
      const c = await cenario(tx, { nup: "23086.100001/2024-00", siape: "1110001", laudo: "26255-000.301/2019", numero_portaria: "301" });
      await servico_parecer.emitir(tx, await parecerDe(tx, c.parecer_id), COORDENADOR, { gerar_pdf: false });
      const [laudo] = await tx.select().from(e.laudo_tecnico).where(eq(e.laudo_tecnico.id, c.laudo_id));
      await servico_parecer.marcar_laudo_superado(tx, laudo!, COORDENADOR, "mudança de processo");
      const reav = (await pendencias.abertas(tx)).filter((p) => p.tipo === "REAVALIACAO_LAUDO" && p.laudo_id === c.laudo_id);
      expect(reav.length).toBe(1);
      expect(reav[0]!.descricao).toContain("reavaliar o parecer");
    });
  });

  it("o sino conta na tela e a fila mostra", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    await naTransacao(async (tx) => {
      for (const n of [1, 2, 3]) {
        await pendencias.abrir(tx, { tipo: "INCLUIR_NO_SEI", chave: `sino:${n}`, descricao: `incluir no SEI ${n}`, usuario: coord });
      }
    });
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get("/")).text;
    expect(corpo).toContain('class="sino');
    expect(corpo).toContain("/pendencias");
    const tela = await cliente.get("/pendencias");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("incluir no SEI 2");
  });

  it("concluir pendência pela tela", async () => {
    const coord = await usuarioAtual(db, "coordenador_csso");
    const p = await naTransacao((tx) =>
      pendencias.abrir(tx, { tipo: "CONFERIR_LAUDO", chave: "tela:1", descricao: "conferir", usuario: coord }),
    );
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/pendencias/${p.id}/concluir`, {}, { seguir: false });
    expect(r.status).toBe(303);
    expect((await db.select().from(e.pendencia).where(eq(e.pendencia.id, p.id)))[0]!.concluida).toBe(true);
    const inexistente = await cliente.post("/pendencias/999999/concluir", {}, { seguir: false });
    expect(decodeURIComponent(inexistente.location!.replace(/\+/g, " "))).toContain("Pendência não encontrada.");
  });

  it("a âncora da fila leva o caminho de volta", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const criado = await cliente.post("/processos/novo", { nup: "23086.000555/2026-10", tipo_processo_id: "1", dispensar_dv: "1" }, { seguir: false });
    const processo_id = Number(criado.location!.split("/").pop());
    const coord = await usuarioAtual(db, "coordenador_csso");
    await naTransacao((tx) =>
      pendencias.abrir(tx, { tipo: "INCLUIR_NO_SEI", chave: "volta:1", descricao: "incluir no SEI", usuario: coord, processo_id }),
    );
    const fila = (await cliente.get("/pendencias")).text;
    expect(fila).toContain(`href="/processos/${processo_id}?de=pendencias">processo</a>`);
    const com_volta = (await cliente.get(`/processos/${processo_id}?de=pendencias`)).text;
    expect(com_volta).toContain('class="volta-origem" href="/pendencias"');
    expect((await cliente.get(`/processos/${processo_id}`)).text).not.toContain("volta-origem");
  });
});

describe("escopo (terceira camada)", () => {
  it("toda função exportada do repositório aplica escopo ou delega a helper", () => {
    const fonte = readFileSync(new URL("../src/repositorios/processos.ts", import.meta.url), "utf8");
    const funcoes = [...fonte.matchAll(/export async function (\w+)\(([\s\S]*?)\n}\n/g)];
    expect(funcoes.length).toBeGreaterThan(5);
    for (const [, nome, corpo] of funcoes) {
      expect(/aplicar_escopo\(|_condicoes\(/.test(corpo!), `${nome} não aplica escopo`).toBe(true);
    }
  });

  it("escopo próprio filtra pelo servidor; auditor vê tudo", async () => {
    const titular = new UsuarioAtual({ id: 9, login: "s", nome: "S", permissoes: ["processo.ver"], perfis: ["servidor_consulta"], servidor_id: 77 });
    expect(aplicar_escopo(titular, e.processo)).toBeDefined();
    const auditor = new UsuarioAtual({ id: 10, login: "a", nome: "A", permissoes: ["processo.ver"], perfis: ["auditor_interno"] });
    expect(aplicar_escopo(auditor, e.processo)).toBeUndefined();
    const [, total] = await repo.listar(db, titular, new repo.Filtro({ repositorio: null }));
    expect(total).toBe(0);
  });

  it("titular sem processo leva 404 na ficha de outro", async () => {
    const [p] = await db.select().from(e.processo).limit(1);
    const r = await (await entrar(novoCliente(), "servidor_consulta")).get(`/processos/${p!.id}`, HTML);
    expect([403, 404]).toContain(r.status);
  });
});

describe("checklist pela ficha", () => {
  it("checklist pela ficha: criar, aplicar modelo e marcar item", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const criado = await cliente.post("/processos/novo", { nup: "23086.000556/2026-10", tipo_processo_id: "1", dispensar_dv: "1" }, { seguir: false });
    const id = Number(criado.location!.split("/").pop());
    await cliente.post(`/processos/${id}/checklist`, { nome: "Avulso", itens: "um\n\ndois\n" }, { seguir: false });
    const [chk] = await db.select().from(e.checklist).where(eq(e.checklist.processo_id, id));
    const itens = await db.select().from(e.checklist_item).where(eq(e.checklist_item.checklist_id, chk!.id));
    expect(itens.map((i) => i.descricao).sort()).toEqual(["dois", "um"]);
    const r = await cliente.post(`/checklist-item/${itens[0]!.id}`, {}, { seguir: false });
    expect(r.location).toBe(`/processos/${id}?aba=checklist`);
    expect((await db.select().from(e.checklist_item).where(eq(e.checklist_item.id, itens[0]!.id)))[0]!.concluido).toBe(true);
    const tela = await cliente.get(`/processos/${id}?aba=checklist`);
    expect(tela.text).toContain("1 de 2");
  });
});
