/**
 * Toda tela do Processos SEI abre (200) e sem erro de template, para cada
 * perfil que a alcança — a varredura que o Python fazia em
 * `test_rotas_permissoes.py` e `test_web_fluxo.py`, para este módulo.
 */
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, naTransacao } from "./ajuda";
import { atores, cenario, parecerDe } from "./ajuda_processos";
import * as servico from "../src/servicos/parecer.js";
import * as direito from "../src/servicos/direito.js";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const ids = await naTransacao(async (tx) => {
  const a = await atores(tx);
  const c = await cenario(tx);
  const p = await parecerDe(tx, c.parecer_id);
  await servico.emitir(tx, p, a.COORDENADOR);
  const v = await direito.propor(tx, p, a.COORDENADOR);
  return { ...c, vigencia_id: v.id };
});

const TELAS = [
  "/",
  "/kanban",
  "/kanban?atrasados=1&q=Marco",
  "/processos",
  "/processos?agrupar=estado",
  "/processos?precisam=1",
  "/processos?sem_percentual=1",
  "/processos/novo",
  `/processos/${ids.processo_id}`,
  `/processos/${ids.processo_id}?aba=parecer`,
  `/processos/${ids.processo_id}?aba=anexos`,
  `/processos/${ids.processo_id}?aba=checklist`,
  `/processos/${ids.processo_id}?aba=historico`,
  `/pareceres/${ids.parecer_id}`,
  `/pareceres/${ids.parecer_id}/previa`,
  "/laudos",
  "/laudos?situacao=VIGENTE&q=famed",
  `/laudos/${ids.laudo_id}`,
  "/adicionais",
  "/adicionais?estado=PROPOSTO",
  "/pendencias",
  "/relatorios",
  "/importar",
  "/importar/reconciliacao",
];

describe("telas do coordenador", () => {
  it.each(TELAS)("%s abre", async (caminho) => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get(caminho, { cabecalhos: { accept: "text/html" } });
    expect(r.status, r.text.slice(0, 3000)).toBe(200);
    expect(r.text).not.toContain("Template render error");
  });
});

describe("outros perfis", () => {
  it.each(["tecnico_seguranca", "secretaria_csso", "auditor_interno", "consulta_progep", "engenheiro_seguranca"])(
    "%s abre as telas que alcança",
    async (perfil) => {
      const cliente = await entrar(novoCliente(), perfil);
      for (const caminho of TELAS) {
        const r = await cliente.get(caminho, { cabecalhos: { accept: "text/html" } });
        expect([200, 403], `${perfil} ${caminho}: ${r.status}\n${r.text.slice(0, 2000)}`).toContain(r.status);
      }
    },
  );
});

describe("downloads", () => {
  it("docx, pdf (sai o docx) e CSV", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const docx = await cliente.get(`/pareceres/${ids.parecer_id}/docx`);
    expect(docx.status).toBe(200);
    expect(docx.cabecalho("content-type")).toContain("wordprocessingml");
    const pdf = await cliente.get(`/pareceres/${ids.parecer_id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.cabecalho("content-type")).toContain("wordprocessingml");
    const csv = await cliente.get("/relatorios/exportar-processos");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("NUP;Estado");
    const rec = await cliente.get("/importar/reconciliacao.csv");
    expect(rec.status).toBe(200);
  });
});

describe("o que cada tela mostra", () => {
  it.each([
    ["/kanban", ["23086.021284/2024-56", "Marco Antônio"]],
    ["/processos", ["23086.021284/2024-56", "Marco Antônio", "Faculdade de Medicina"]],
    ["/processos?agrupar=unidade", ["Faculdade de Medicina de Diamantina", "23086.021284/2024-56"]],
    ["/", ["Precisam de você hoje", "Últimos eventos", "Parecer emitido"]],
    [`/processos/${ids.processo_id}?aba=parecer`, ["1/2025", "26255-000.125/2019"]],
    [`/processos/${ids.processo_id}?aba=historico`, ["Parecer 1/2025 emitido"]],
    [`/pareceres/${ids.parecer_id}`, ["Parecer técnico 1/2025", "Contato permanente com material infecto-contagiante", "Marco Antônio Alves Schetino"]],
    ["/laudos", ["26255-000.125/2019"]],
    [`/laudos/${ids.laudo_id}`, ["26255-000.125/2019", "1/2025"]],
    ["/adicionais", ["proposto", "Marco Antônio"]],
    ["/pendencias", ["Incluir o parecer 1/2025 no SEI"]],
    ["/relatorios", ["Lacunas de numeração", "Biológico"]],
  ] as const)("%s", async (caminho, esperados) => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get(caminho, { cabecalhos: { accept: "text/html" } });
    expect(r.status).toBe(200);
    for (const e of esperados) expect(r.text, e).toContain(e);
  });
});

describe("casca", () => {
  it("toda tela do módulo tem o rodapé institucional", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    for (const caminho of ["/", "/kanban", "/processos", "/laudos", "/adicionais", "/relatorios"]) {
      const r = await cliente.get(caminho);
      expect(r.text, caminho).toContain("Sistema de apoio da CSSO");
    }
    expect((await cliente.get("/processos")).text).toContain("O processo oficial e o SEI.");
  });
});
