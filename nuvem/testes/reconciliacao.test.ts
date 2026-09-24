/**
 * Fase 4 — os cinco relatórios de reconciliação da migração.
 * Porte de `integracao/test_reconciliacao.py` (a parte dos anexos do Trello
 * está em `importacao.test.ts`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import * as imp from "../src/servicos/importacao_trello.js";
import * as reconciliacao from "../src/servicos/reconciliacao.js";
import * as servico_nup from "../src/servicos/nup.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { obterApp } from "../src/app.js";
import { bancoLimpo, contas, criarUsuario, entrar } from "./ajuda";
import { cenario, desfeita } from "./ajuda_processos";

const { db, novoCliente } = await bancoLimpo();
await contas(db);

const QUADRO = JSON.parse(readFileSync(new URL("./fixtures/trello_quadro.json", import.meta.url), "utf8"));

const ARQUIVOS_FALSOS: Record<string, Uint8Array> = {
  "https://exemplo/a.pdf": new TextEncoder().encode("%PDF-1.4 parecer assinado do Genilton"),
  "https://exemplo/b.pdf": new TextEncoder().encode("%PDF-1.4 laudo do Marcilio"),
};
const buscar_falso: imp.BuscarAnexo = async (url) => {
  if (!(url in ARQUIVOS_FALSOS)) throw new Error(`URL expirada: ${url}`);
  return ARQUIVOS_FALSOS[url]!;
};

let _n = 0;
async function operador(tx: Executor): Promise<UsuarioAtual> {
  const u = await criarUsuario(tx, { login: `rec${++_n}`, nome: "Migrador" });
  return new UsuarioAtual({
    id: u.id,
    login: u.login,
    nome: "Migrador",
    permissoes: ["catalogo.gerenciar", "anexo.enviar"],
    perfis: ["coordenador_csso"],
  });
}

/** O fixture `migrado`: o quadro carregado com os anexos falsos. */
async function migrar(tx: Executor, buscar: imp.BuscarAnexo | null = buscar_falso) {
  await imp.importar(tx, structuredClone(QUADRO), await operador(tx), true, buscar);
}

const comMigrado = <T>(f: (tx: Executor) => Promise<T>) =>
  desfeita(db, async (tx) => {
    await migrar(tx);
    return f(tx);
  });

describe("os cinco relatórios", () => {
  it("tem as cinco seções", () =>
    comMigrado(async (tx) => {
      const r = await reconciliacao.reconciliar(tx);
      expect(r.como_secoes().map(([t]) => t)).toEqual([
        "Órfãos de processo",
        "Órfãos de parecer",
        "Conflito de numeração",
        "NUPs com dígito verificador inválido",
        "Divergência de marco inicial",
      ]);
    }));

  it("órfãos de processo pegam cartão sem NUP", () =>
    comMigrado(async (tx) => {
      const r = await reconciliacao.reconciliar(tx);
      expect(r.orfaos_processo.map((a) => a.detalhe).join(" ")).toContain("Sebastião Aparecido");
    }));

  it("NUP sintético aparece como órfão", () =>
    desfeita(db, async (tx) => {
      await tx.insert(e.servidor).values({ siape: "9999999", nome: "Sebastião Aparecido" });
      await migrar(tx, null);
      const sinteticos = await tx.select().from(e.processo).where(like(e.processo.nup, "23086.%/1900-%"));
      expect(sinteticos.length, "o cartão sem NUP precisa de chave única para existir").toBeGreaterThan(0);
      expect(servico_nup.validar(sinteticos[0]!.nup).dv_ok, "o NUP sintético tem DV válido").toBe(true);
      const r = await reconciliacao.reconciliar(tx);
      expect(r.orfaos_processo.some((a) => a.detalhe.includes("sintético"))).toBe(true);
    }));

  it("conflito de numeração expõe candidato sem parecer", () =>
    comMigrado(async (tx) => {
      const r = await reconciliacao.reconciliar(tx);
      expect(r.conflitos_numeracao.map((a) => a.detalhe).join(" ")).toContain("1/2025");
    }));

  it("NUP com DV inválido aparece, com a dispensa registrada", () =>
    comMigrado(async (tx) => {
      const [tipo] = await tx.select().from(e.tipo_processo).limit(1);
      const [etapa] = await tx.select().from(e.fluxo_etapa).limit(1);
      await tx.insert(e.processo).values({
        nup: "23086.021284/2024-99",
        tipo_processo_id: tipo!.id,
        etapa_id: etapa!.id,
        nup_dv_dispensado: true,
      });
      const r = await reconciliacao.reconciliar(tx);
      expect(r.nups_dv_invalido.map((a) => a.referencia)).toContain("23086.021284/2024-99");
      expect(r.nups_dv_invalido.some((a) => a.detalhe.includes("dispensa registrada"))).toBe(true);
    }));

  it("divergência de marco", () =>
    desfeita(db, async (tx) => {
      const c = await cenario(tx);
      await migrar(tx);
      // a portaria é de 17/09/2024
      await tx.update(e.parecer_tecnico).set({ data_marco_inicial: "2024-01-01" }).where(eq(e.parecer_tecnico.id, c.parecer_id));
      const r = await reconciliacao.reconciliar(tx);
      expect(r.divergencias_marco.some((a) => a.detalhe.includes("01/01/2024"))).toBe(true);
    }));

  it("órfão de parecer sem processo", () =>
    comMigrado(async (tx) => {
      await tx.insert(e.parecer_tecnico).values({ numero: 77, ano: 2026, situacao: "RASCUNHO" });
      const r = await reconciliacao.reconciliar(tx);
      expect(r.orfaos_parecer.some((a) => a.referencia === "77/2026")).toBe(true);
    }));

  it("reservado não conta como órfão, mas aparece no conflito de numeração", () =>
    comMigrado(async (tx) => {
      await tx.insert(e.parecer_tecnico).values({ numero: 78, ano: 2026, situacao: "RESERVADO" });
      const r = await reconciliacao.reconciliar(tx);
      expect(r.orfaos_parecer.some((a) => a.referencia === "78/2026")).toBe(false);
      expect(r.conflitos_numeracao.some((a) => a.referencia === "78/2026")).toBe(true);
    }));

  it("o total soma as cinco seções", () =>
    comMigrado(async (tx) => {
      const r = await reconciliacao.reconciliar(tx);
      expect(r.total).toBe(r.como_secoes().reduce((a, [, , achados]) => a + achados.length, 0));
      expect(r.total).toBeGreaterThan(0);
    }));
});

describe("as telas", () => {
  it("tela de reconciliação", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get("/importar/reconciliacao", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(200);
    for (const titulo of ["Órfãos de processo", "Conflito de numeração", "Divergência de marco"]) {
      expect(r.text).toContain(titulo);
    }
  });

  it("reconciliação em CSV, com BOM", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get("/importar/reconciliacao.csv");
    expect(r.status).toBe(200);
    // o `text()` do Fetch descarta o BOM ao decodificar; os bytes são lidos crus
    const cru = await obterApp().fetch(
      new Request("http://testserver/importar/reconciliacao.csv", {
        headers: { cookie: [...cliente.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
      }),
    );
    const bytes = new Uint8Array(await cru.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text).toContain("Relat");
    expect(r.cabecalho("content-type")).toContain("text/csv");
  });

  it("reconciliação exige permissão", async () => {
    const cliente = await entrar(novoCliente(), "secretaria_csso");
    const r = await cliente.get("/importar/reconciliacao", { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(403);
  });
});
