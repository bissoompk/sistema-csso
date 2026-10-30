/**
 * F2 do módulo de acidentes: a comunicação por link, sem conta (D1b). Token
 * errado e link desligado dão a mesma resposta; o limite por IP vem antes do
 * token; o campo-isca não grava; o teto de espera segura a enxurrada;
 * POST-redirecionamento-GET com o protocolo num cookie; consentimento e
 * declaração obrigatórios; o SIAPE digitado não é consultado; o IP sai em 90
 * dias; e a equipe gera, troca e desliga o link. Dados fictícios.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import * as publico from "../src/servicos/acidente_publico.js";
import { expurgar_ip_de_acidente } from "../src/servicos/privacidade.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Campos, type Cliente } from "./ajuda.js";

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;
let n_ip = 0;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  await contas(db);
});
afterEach(() => {
  publico.ajuste.teto_em_espera = 30;
});

function ip_novo(): { cabecalhos: Record<string, string> } {
  n_ip += 1;
  return { cabecalhos: { "x-nf-client-connection-ip": `203.0.113.${(n_ip % 250) + 1}` } };
}

async function gerar(campus_id: number | null = null): Promise<string> {
  const equipe = await usuarioAtual(db, "tecnico_seguranca");
  return db.transaction((tx) => publico.gerar_link(tx, equipe, campus_id));
}

function formulario(extra: Campos = {}): Campos {
  return {
    com_nome: "Comunicante Fictícia",
    com_email: "comunicante@exemplo.org",
    com_vinculo: "TERCEIRIZADO",
    env_indice: ["1", "2", "3"],
    env_1_nome_externo: "Acidentado Fictício",
    env_1_vinculo: "SERVIDOR",
    env_1_siape: "7000012",
    env_1_condicao: "ACIDENTADO",
    env_1_houve_lesao: "SIM",
    especie: "TIPICO",
    data_evento: somar_dias(hoje_iso(), -1),
    local_tipo: "ESTABELECIMENTO_UFVJM",
    local_especificacao: "Corredor do prédio fictício",
    descricao: "Escorregou no piso recém-lavado do corredor.",
    consentimento: "1",
    declaracao: "1",
    ...extra,
  };
}

const ocorrencias = () => db.select().from(e.acidente_ocorrencia);

describe("o link", () => {
  it("abre o formulário, sem casca, com cabeçalhos sem rastro", async () => {
    const token = await gerar();
    const r = await cliente.get(`/acidente/${token}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Comunicar acidente");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("token errado e link desligado dão a mesma resposta", async () => {
    const token = await gerar();
    const errado = await cliente.get("/acidente/naoexiste123");
    const equipe = await usuarioAtual(db, "tecnico_seguranca");
    const [link] = await db.select().from(e.acidente_link_publico);
    await db.transaction((tx) => publico.desligar_link(tx, equipe, link!.id));
    const desligado = await cliente.get(`/acidente/${token}`);
    expect(errado.status).toBe(404);
    expect(desligado.status).toBe(404);
    const corpo = (t: string) => t.replace(/nonce="[^"]*"/g, "");
    expect(corpo(desligado.text)).toBe(corpo(errado.text));
  });

  it("o banco guarda só o hash do token; gerar de novo desliga o anterior", async () => {
    const t1 = await gerar();
    const t2 = await gerar();
    const links = await db.select().from(e.acidente_link_publico).orderBy(e.acidente_link_publico.id);
    expect(links.map((l) => l.ativo)).toEqual([false, true]);
    expect(JSON.stringify(links)).not.toContain(t1);
    expect((await cliente.get(`/acidente/${t1}`)).status).toBe(404);
    expect((await cliente.get(`/acidente/${t2}`)).status).toBe(200);
  });
});

describe("comunicar pelo link", () => {
  it("grava com origem PUBLICO, o comunicante identificado, e responde 303 com o protocolo no cookie", async () => {
    const token = await gerar();
    const r = await cliente.post(`/acidente/${token}`, formulario(), { ...ip_novo(), seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/acidente/${token}`);
    const [oc] = await ocorrencias();
    expect(oc!.origem).toBe("PUBLICO");
    expect(oc!.criado_por).toBeNull();
    const [com] = await db.select().from(e.acidente_comunicante);
    expect(com!.nome).toBe("Comunicante Fictícia");
    expect(com!.ip).toMatch(/^203\.0\.113\./);
    const [acid] = await db.select().from(e.acidentado);
    expect(acid!.siape).toBe("7000012");
    // PRG: o GET mostra o protocolo e recarregar não reenvia
    const tela = await cliente.get(r.location!);
    expect(tela.text).toContain(oc!.protocolo);
    expect(await ocorrencias()).toHaveLength(1);
  });

  it("o SIAPE digitado não é consultado: inexistente passa, e fica guardado como informado", async () => {
    const token = await gerar();
    const r = await cliente.post(`/acidente/${token}`, formulario({ env_1_vinculo: "SERVIDOR", env_1_siape: "9999999" }), {
      ...ip_novo(),
      seguir: false,
    });
    expect(r.status).toBe(303);
    const [acid] = await db.select().from(e.acidentado);
    expect(acid!.siape).toBe("9999999");
    expect(acid!.servidor_id).toBeNull();
  });

  it("consentimento e declaração são obrigatórios, e nada é gravado sem eles", async () => {
    const token = await gerar();
    const sem_consent = await cliente.post(`/acidente/${token}`, formulario({ consentimento: "" }), ip_novo());
    expect(sem_consent.status).toBe(422);
    expect(sem_consent.text).toContain("aviso de privacidade");
    const sem_decl = await cliente.post(`/acidente/${token}`, formulario({ declaracao: "" }), ip_novo());
    expect(sem_decl.status).toBe(422);
    expect(sem_decl.text).toContain("Corredor do prédio fictício");
    expect(await ocorrencias()).toHaveLength(0);
  });

  it("o campo-isca não grava e recebe a mesma resposta (303)", async () => {
    const token = await gerar();
    const r = await cliente.post(`/acidente/${token}`, formulario({ site: "http://spam" }), { ...ip_novo(), seguir: false });
    expect(r.status).toBe(303);
    expect(await ocorrencias()).toHaveLength(0);
    const evs = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_PUBLICO_HONEYPOT"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.descricao).not.toContain("Acidentado");
  });

  it("o limite por IP vem antes do token: estourado, até token errado recebe 429", async () => {
    const token = await gerar();
    const mesmo = ip_novo();
    for (let i = 0; i < publico.LIMITE_POR_JANELA; i++) {
      await cliente.post(`/acidente/${token}`, formulario({ declaracao: "" }), mesmo);
    }
    expect((await cliente.post(`/acidente/${token}`, formulario(), mesmo)).status).toBe(429);
    expect((await cliente.post("/acidente/errado", formulario(), mesmo)).status).toBe(429);
  });

  it("o teto de espera: com a fila cheia, o link para de receber e diz a saída", async () => {
    publico.ajuste.teto_em_espera = 1;
    const token = await gerar();
    expect((await cliente.post(`/acidente/${token}`, formulario(), { ...ip_novo(), seguir: false })).status).toBe(303);
    const r = await cliente.post(`/acidente/${token}`, formulario(), ip_novo());
    expect(r.status).toBe(503);
    expect(r.text).toContain("parou de aceitar");
    expect(await ocorrencias()).toHaveLength(1);
  });

  it("o link de campus manda a comunicação com o campus dele", async () => {
    const [mucuri] = await db.select().from(e.campus).where(eq(e.campus.sigla, "MUC"));
    const token = await gerar(mucuri!.id);
    await cliente.post(`/acidente/${token}`, formulario(), ip_novo());
    const [oc] = await ocorrencias();
    expect(oc!.campus_id).toBe(mucuri!.id);
  });

  it("nenhum e-mail sai ao comunicante público (D6)", async () => {
    process.env.CSSO_ACIDENTE_EMAIL = "sim";
    process.env.CSSO_ACIDENTE_EMAIL_SETOR = "sst@ufvjm.edu.br";
    const { redefinirConfig } = await import("../src/config.js");
    redefinirConfig();
    try {
      const token = await gerar();
      await cliente.post(`/acidente/${token}`, formulario(), ip_novo());
      const caixa = await db.select().from(e.email_saida);
      expect(caixa.map((m) => m.destinatario)).toEqual(["sst@ufvjm.edu.br"]);
    } finally {
      delete process.env.CSSO_ACIDENTE_EMAIL;
      delete process.env.CSSO_ACIDENTE_EMAIL_SETOR;
      redefinirConfig();
    }
  });
});

describe("privacidade e equipe", () => {
  it("o IP de quem comunicou sai em 90 dias pela rotina", async () => {
    const token = await gerar();
    await cliente.post(`/acidente/${token}`, formulario(), ip_novo());
    expect(await expurgar_ip_de_acidente(db)).toBe(0);
    const daqui_a_91 = new Date(Date.now() + 91 * 86_400_000);
    expect(await expurgar_ip_de_acidente(db, daqui_a_91)).toBe(1);
    const [com] = await db.select().from(e.acidente_comunicante);
    expect(com!.ip).toBeNull();
    expect(com!.nome).toBe("Comunicante Fictícia");
  });

  it("a equipe gera o link pela tela e o vê uma vez; quem não tria recebe 403", async () => {
    const equipe = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await equipe.post("/acidentes/link", { campus_id: "" });
    expect(r.status).toBe(200);
    const m = r.text.match(/\/acidente\/([A-Za-z0-9_-]{20,})/);
    expect(m).not.toBeNull();
    expect((await cliente.get(`/acidente/${m![1]}`)).status).toBe(200);
    expect((await equipe.get("/acidentes/link")).text).not.toContain(m![1]);
    const tit = await entrar(novoCliente(), "servidor_consulta");
    expect((await tit.get("/acidentes/link", { seguir: false })).status).toBe(403);
  });

  it("a ficha mostra a quem conduz quem comunicou pelo link", async () => {
    const token = await gerar();
    await cliente.post(`/acidente/${token}`, formulario(), ip_novo());
    const [oc] = await ocorrencias();
    const equipe = await entrar(novoCliente(), "tecnico_seguranca");
    const ficha = await equipe.get(`/acidentes/${oc!.id}`);
    expect(ficha.text).toContain("comunicante@exemplo.org");
    // e não oferece pedir complementação a quem não tem conta, nem depois de assumir
    const r = await equipe.post(`/acidentes/${oc!.id}/assumir`, { versao: String(oc!.versao) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Em triagem");
    expect(r.text).not.toContain(`href="#pedir-complementacao"`);
  });

  it("com o módulo seguro (produção sem liberar), o link é 404", async () => {
    const token = await gerar();
    process.env.CSSO_MODULO_ACIDENTES = "nao";
    try {
      expect((await cliente.get(`/acidente/${token}`)).status).toBe(404);
      expect((await cliente.post(`/acidente/${token}`, formulario(), ip_novo())).status).toBe(404);
    } finally {
      delete process.env.CSSO_MODULO_ACIDENTES;
    }
  });
});
