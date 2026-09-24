/**
 * /validar — a página pública, e as três coisas que ela nunca pode fazer.
 * Porte de `testes/integracao/test_validacao_publica.py`.
 *
 * 1. **Não diz o nome de quem se formou** — nem inteiro, nem mascarado, nem por
 *    qualquer outro campo que o identifique (SIAPE, lotação, e-mail).
 * 2. **Não distingue** chave inexistente de malformada de dígito errado.
 * 3. **Não deixa varrer**: o limite por IP corta a rajada, e conta a tentativa
 *    mesmo quando a chave é boa.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-validacao-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import type { Hono } from "hono";
import type { Ambiente } from "../src/nucleo/contexto.js";
import { Certificado as C } from "../src/dominio/treinamento.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { montar_chave, normalizar_chave } from "../src/servicos/certificado.js";
import * as servico from "../src/servicos/validacao_certificado.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { _cenario, _usuario, TODAS } from "./ajuda_certificado.js";

definirArmazenamento(null);

// Uma chave com formato e DV corretos que não existe no banco, montada pela
// mesma função da emissão (e NÃO o exemplo do formulário).
const INEXISTENTE = montar_chave(2026, "3QRST4VWXY");
// mesmo sorteio, dígito verificador trocado: o terceiro caso da negativa única
const DIGITO_ERRADO = INEXISTENTE.slice(0, -1) + (INEXISTENTE.at(-1) !== "2" ? "2" : "3");
const MALFORMADA = "nao-e-uma-chave";

let db: Banco;
let cliente: Cliente;
let app: Hono<Ambiente>;
await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  app = amb.app;
  // o contador vive no processo: sem isto o teste do limite envenenaria os outros
  servico.limpar_limites();
});
afterEach(() => servico.limpar_limites());

async function emitido() {
  await contas(db);
  const montador = await _usuario(db, TODAS, "montador");
  const dados = await _cenario(db, montador);
  await entrar(cliente, "coordenador_csso");
  await cliente.post(`/turmas/${dados.turma.id}/certificados`, { inscricao_id: dados.inscricao.id }, { seguir: false });
  const [certificado, ...resto] = await db.select().from(e.certificado);
  expect(resto).toHaveLength(0);
  const congelado = (certificado!.contexto_congelado ?? {}) as Record<string, string>;
  await cliente.get("/sair");
  return {
    id: certificado!.id,
    chave: certificado!.chave_validacao,
    url: congelado.url_validacao ?? "",
    nome: congelado.participante_nome ?? "",
    rotulo: C.rotulo(certificado!),
  };
}

// =====================================================================
// O defeito que já circulou em papel
// =====================================================================
describe("o endereço impresso", () => {
  it("o endereço impresso no certificado responde", async () => {
    const papel = await emitido();
    const caminho = "/validar/" + papel.url.split("/validar/").pop();
    const resposta = await cliente.get(caminho);
    expect(resposta.status).toBe(200);
    expect(resposta.text).toContain("Certificado autêntico");
  });

  it("a página abre sem sessão", async () => {
    for (const caminho of ["/validar", `/validar/${INEXISTENTE}`]) {
      const resposta = await cliente.get(caminho, { seguir: false });
      expect(resposta.status, caminho).toBe(200);
      expect(resposta.location ?? "").not.toContain("/login");
    }
  });
});

// =====================================================================
// O que ela nunca mostra
// =====================================================================
describe("o que ela nunca mostra", () => {
  it("não expõe o nome nem o SIAPE", async () => {
    const papel = await emitido();
    const corpo = (await cliente.get(`/validar/${papel.chave}`)).text;
    expect(corpo).not.toContain(papel.nome);
    // nem em pedaço: máscara parcial está fora por coerência com o ROPA §6
    for (const pedaco of papel.nome.split(/\s+/)) expect(corpo, pedaco).not.toContain(pedaco);
    expect(corpo).not.toContain("1110654");
    expect(corpo).not.toContain("/documento");
    expect(corpo).not.toContain(".docx");
  });

  it("mostra o que dá crédito ao papel", async () => {
    const papel = await emitido();
    const corpo = (await cliente.get(`/validar/${papel.chave}`)).text;
    expect(corpo).toContain("Trabalho em Altura");
    expect(corpo).toContain("NR-35");
    expect(corpo).toContain("Fabrício Raimundi Andrade");
    expect(corpo).toContain("PTC-");
  });

  it("os cabeçalhos impedem indexação e cache", async () => {
    const papel = await emitido();
    const resposta = await cliente.get(`/validar/${papel.chave}`);
    expect(resposta.cabecalho("x-robots-tag")).toBe("noindex, nofollow");
    expect(resposta.cabecalho("cache-control")).toBe("no-store");
  });
});

// =====================================================================
// A negativa é uma só
// =====================================================================
describe("a negativa é uma só", () => {
  it("chave inexistente, malformada e com DV errado respondem igual", async () => {
    const resposta = async (chave: string) => {
      const corpo = (await cliente.get(`/validar/${chave}`)).text;
      // o eco do que foi digitado é a ÚNICA diferença admitida; a marca de CSP
      // é sorteada por resposta
      return corpo.replaceAll(normalizar_chave(chave), "«o que foi digitado»").replace(/nonce="[^"]*"/g, 'nonce="«marca»"');
    };
    const uma = await resposta(INEXISTENTE);
    const outra = await resposta(MALFORMADA);
    const digito_errado = await resposta(DIGITO_ERRADO);
    expect(uma).toBe(outra);
    expect(outra).toBe(digito_errado);
    expect(uma).toContain("Não foi possível confirmar");
  });

  it("o certificado anulado responde anulado", async () => {
    const papel = await emitido();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/certificados/${papel.id}/anular`, { motivo: "nome social" }, { seguir: false });
    await cliente.get("/sair");
    const corpo = (await cliente.get(`/validar/${papel.chave}`)).text;
    expect(corpo).toContain("foi anulado");
    // o motivo da anulação NÃO é público: ele conta sobre a pessoa
    expect(corpo).not.toContain("nome social");
  });
});

// =====================================================================
// A conferência do nome — um bit, no lugar do nome
// =====================================================================
describe("conferência do nome", () => {
  it("responde confere e não confere", async () => {
    const papel = await emitido();
    const certo = await cliente.post(`/validar/${papel.chave}/conferir`, { nome: "marco antonio alves de schetino" });
    expect(certo.status).toBe(200);
    expect(certo.text).toContain("<strong>Confere.</strong>");
    const errado = await cliente.post(`/validar/${papel.chave}/conferir`, { nome: "Fulano de Tal" });
    expect(errado.text).toContain("<strong>Não confere.</strong>");
    expect(errado.text).not.toContain(papel.nome);
  });
});

// =====================================================================
// Antienumeração
// =====================================================================
describe("antienumeração", () => {
  it("a rajada bate no limite por IP", async () => {
    for (let i = 0; i < servico.LIMITE_CURTO; i++) {
      expect((await cliente.get(`/validar/${INEXISTENTE}`)).status).toBe(200);
    }
    const excedeu = await cliente.get(`/validar/${INEXISTENTE}`);
    expect(excedeu.status).toBe(429);
    expect(excedeu.text).toContain("Consultas demais deste endereço");
  });

  it("a conferência de nome passa pelo mesmo limite", async () => {
    const papel = await emitido();
    for (let i = 0; i < servico.LIMITE_CURTO; i++) {
      await cliente.post(`/validar/${papel.chave}/conferir`, { nome: "tentativa" });
    }
    const ultima = await cliente.post(`/validar/${papel.chave}/conferir`, { nome: "tentativa" });
    expect(ultima.status).toBe(429);
  });

  it("a janela curta se esvazia com o tempo (relógio trocável)", () => {
    // não havia equivalente no Python (o `_agora` era trocável e não usado); fica
    // para provar que o relógio é o do serviço e que a janela curta de fato expira
    const original = servico.relogio.agora;
    let agora = 1_000;
    servico.relogio.agora = () => agora;
    try {
      for (let i = 0; i < servico.LIMITE_CURTO; i++) expect(servico.dentro_do_limite("1.2.3.4")).toBe(true);
      expect(servico.dentro_do_limite("1.2.3.4")).toBe(false);
      agora += servico.JANELA_CURTA_S + 1;
      expect(servico.dentro_do_limite("1.2.3.4")).toBe(true);
    } finally {
      servico.relogio.agora = original;
    }
  });

  it("não há listagem nem busca por nome", async () => {
    const papel = await emitido();
    const corpo = (await cliente.get("/validar")).text;
    expect(corpo.split("<form").length - 1).toBe(1);
    expect(corpo).toContain('name="chave"');
    expect(corpo).not.toContain('name="nome"');
    expect(corpo).not.toContain('name="q"');
    // a chave não casa por prefixo
    expect((await cliente.get(`/validar/${papel.chave.slice(0, 15)}`)).text).toContain("Não foi possível confirmar");
  });
});

// =====================================================================
// O invariante: negado por padrão continua valendo
// =====================================================================
const ABERTAS_SEM_SESSAO: Record<string, string> = {
  "/saude": "teste de vida do processo — não toca no banco e não diz a versão",
  "/login": "a tela anterior à sessão; o POST dela é que autentica",
  "/quem-sou-eu":
    "responde `{autenticado: false}` a quem não entrou, e é isso que ela existe para responder — não há dado de ninguém antes da sessão",
  "/validar": "o formulário da validação pública por chave",
  "/sw.js":
    "o service worker da tela de bolso: o navegador o baixa ANTES de haver sessão (é assim que a casca abre sem rede), e ele é código, não dado — a lista do que ele guarda não tem /api/ e há teste disso",
  "/validar/{chave}":
    "a resposta da validação: existe uma decisão escrita em `src/rotas/validacao.ts` para ela não pedir sessão — quem valida um certificado é justamente quem não tem conta neste sistema",
};

/** As rotas GET do app Hono, com `:param{regex}` escrito `{param}` (o formato do openapi). */
function _caminhos_get(): string[] {
  const caminhos = new Set<string>();
  for (const r of app.routes) {
    if (r.method !== "GET" || r.path.includes("*")) continue;
    caminhos.add(r.path.replace(/:([A-Za-z_]\w*)(\{[^}]*\})?/g, "{$1}"));
  }
  return [...caminhos].sort();
}

describe("negado por padrão", () => {
  it("só estas rotas abrem sem sessão", async () => {
    await contas(db);
    const abertas: string[] = [];
    for (const caminho of _caminhos_get()) {
      // `{param}` vira `1`: o que se mede é a porta, não o conteúdo
      const concreto = caminho.replace(/\{[^}]*\}/g, "1");
      const resposta = await cliente.get(concreto, { seguir: false });
      if (resposta.status === 200) abertas.push(caminho);
    }
    const esperadas = new Set(Object.keys(ABERTAS_SEM_SESSAO));
    const sobrando = abertas.filter((c) => !esperadas.has(c));
    const faltando = [...esperadas].filter((c) => !abertas.includes(c));
    // `/sw.js` (tela de bolso) é de outro trecho do porte: se ainda não existir,
    // não é esta suíte que o cobra — o que ela trava é rota aberta NÃO declarada
    const faltando_do_modulo = faltando.filter((c) => c !== "/sw.js");
    expect({ sobrando, faltando: faltando_do_modulo }).toEqual({ sobrando: [], faltando: [] });
  });

  it("cada rota aberta tem o motivo escrito", () => {
    for (const [caminho, motivo] of Object.entries(ABERTAS_SEM_SESSAO)) expect(motivo.length, caminho).toBeGreaterThan(40);
  });
});
