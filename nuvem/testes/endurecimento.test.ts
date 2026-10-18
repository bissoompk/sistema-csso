/**
 * As recomendações da revisão de segurança de 25/09/2026 que tinham ficado de
 * fora ("Recomendações que NÃO foram aplicadas", DESVIOS.md) e entraram na
 * passada de endurecimento para a internet aberta:
 *
 * - política de senha de 10 caracteres, e a senha antiga vira troca obrigatória;
 * - conta de administração só tem a senha redefinida por quem concede perfil;
 * - sessão cai por inatividade;
 * - `/sair` e a criação de rascunho de parecer deixaram de ser GET;
 * - CSV sem fórmula; anexo servido só com tipo conhecido;
 * - planilha com teto de descompressão e de linhas;
 * - exportação completa sem credenciais.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { and, count, eq } from "drizzle-orm";
import PizZip from "pizzip";
import { describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-endurecimento-"));

import * as e from "../src/db/esquema/index.js";
import { redefinirConfig } from "../src/config.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import { ArquivoZipRecusado, conferir_zip } from "../src/servicos/arquivo_zip.js";
import { exportar_tudo, sem_credenciais } from "../src/servicos/backup.js";
import { campo_csv, linha_csv, neutralizar_formula } from "../src/servicos/csv.js";
import { tipo_para_servir } from "../src/servicos/anexos.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { bancoLimpo, contas, entrar, naTransacao, SENHA_TESTE } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
definirArmazenamento(null);
await contas(db);

async function contaDe(login: string) {
  const [u] = await db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

// =====================================================================
describe("senha antiga, curta, vira troca obrigatória no login", () => {
  it("entra, e cai em /trocar-senha; depois de trocar, segue normal", async () => {
    const conta = await contaDe("tecnico_seguranca");
    await db
      .update(e.usuario)
      .set({ senha_hash: await autenticacao.gerar_hash("csso26"), precisa_trocar_senha: false })
      .where(eq(e.usuario.id, conta.id));
    const cliente = novoCliente();
    const r = await cliente.post("/login", { login: "tecnico_seguranca", senha: "csso26" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/trocar-senha");
    // e não escapa digitando outro endereço
    expect((await cliente.get("/processos", { seguir: false })).location).toBe("/trocar-senha");
    expect((await contaDe("tecnico_seguranca")).precisa_trocar_senha).toBe(true);

    // a troca pede a política nova
    const fraca = await cliente.post("/trocar-senha", { senha_atual: "csso26", nova: "outra1", confirmacao: "outra1" });
    expect(fraca.text).toContain("mínimo de 10 caracteres");
    const ok = await cliente.post(
      "/trocar-senha",
      { senha_atual: "csso26", nova: SENHA_TESTE, confirmacao: SENHA_TESTE },
      { seguir: false },
    );
    expect(ok.status).toBe(303);
    expect((await contaDe("tecnico_seguranca")).precisa_trocar_senha).toBe(false);
  });

  it("senha que passa na política não força nada", async () => {
    const cliente = novoCliente();
    const r = await cliente.post("/login", { login: "secretaria_csso", senha: SENHA_TESTE }, { seguir: false });
    expect(r.location).not.toBe("/trocar-senha");
  });
});

// =====================================================================
describe("redefinir senha: conta de administração só por quem concede perfil", () => {
  it("admin_ti redefine a conta comum", async () => {
    const alvo = await contaDe("secretaria_csso");
    const admin = await entrar(novoCliente(), "admin_ti");
    const r = await admin.post(`/usuarios/${alvo.id}/senha`);
    expect(r.text).toMatch(/Nova senha provisória de secretaria_csso: [a-z]{4}-[a-z]{4}-\d{2}/);
    await db.update(e.usuario).set({ senha_hash: await autenticacao.gerar_hash(SENHA_TESTE), precisa_trocar_senha: false }).where(eq(e.usuario.id, alvo.id));
  });

  it("admin_ti não redefine o superintendente, e a recusa fica na trilha", async () => {
    const alvo = await contaDe("superintendente");
    const antes = alvo.senha_hash;
    const admin = await entrar(novoCliente(), "admin_ti");
    const r = await admin.post(`/usuarios/${alvo.id}/senha`);
    expect(r.text).toContain("é conta de administração");
    expect(r.text).not.toContain("Nova senha provisória");
    expect((await contaDe("superintendente")).senha_hash).toBe(antes);
    const [{ n }] = await db
      .select({ n: count() })
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.tipo_evento, "SENHA_RESET_RECUSADO"), eq(e.historico_evento.entidade_id, alvo.id)));
    expect(n).toBe(1);
    // a tela já avisa, em vez de oferecer o botão
    const tela = await admin.get("/usuarios");
    expect(tela.text).toContain("Conta de administração.");
  });

  it("admin_ti não redefine outro admin_ti nem a si mesmo", async () => {
    await db.insert(e.usuario).values({
      login: "admin_ti_2",
      nome: "Outro Admin",
      email: "admin2@teste.ufvjm.edu.br",
      senha_hash: (await contaDe("admin_ti")).senha_hash,
    });
    const outro = await contaDe("admin_ti_2");
    const [perfil] = await db.select().from(e.perfil).where(eq(e.perfil.codigo, "admin_ti"));
    await db.insert(e.atribuicao).values({ usuario_id: outro.id, perfil_id: perfil!.id, vigencia_inicio: "2020-01-01", ato_normativo: "teste" });
    const admin = await entrar(novoCliente(), "admin_ti");
    expect((await admin.post(`/usuarios/${outro.id}/senha`)).text).toContain("é conta de administração");
    const eu = await contaDe("admin_ti");
    expect((await admin.post(`/usuarios/${eu.id}/senha`)).text).toContain("a própria senha se troca em Trocar senha");
  });

  it("o superintendente redefine o admin_ti", async () => {
    const alvo = await contaDe("admin_ti");
    const sup = await entrar(novoCliente(), "superintendente");
    const r = await sup.post(`/usuarios/${alvo.id}/senha`);
    expect(r.text).toContain("Nova senha provisória de admin_ti");
    await db.update(e.usuario).set({ senha_hash: await autenticacao.gerar_hash(SENHA_TESTE), precisa_trocar_senha: false }).where(eq(e.usuario.id, alvo.id));
  });

  it("quem não tem nenhuma das duas permissões leva 403", async () => {
    const alvo = await contaDe("secretaria_csso");
    const tec = await entrar(novoCliente(), "tecnico_seguranca");
    expect((await tec.post(`/usuarios/${alvo.id}/senha`, {}, { seguir: false })).status).toBe(403);
  });
});

// =====================================================================
describe("sessão cai por inatividade", () => {
  it("parada há mais que o limite, volta ao login; em uso, segue", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const token = cliente.cookies.get(autenticacao.COOKIE_SESSAO)!;
    const hash = autenticacao._hash_token(token);
    // usada há 90 minutos: dentro das 2 h
    await db.update(e.sessao).set({ ultimo_uso_em: new Date(Date.now() - 90 * 60_000) }).where(eq(e.sessao.token_hash, hash));
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
    // e o uso renovou o relógio
    const [renovada] = await db.select().from(e.sessao).where(eq(e.sessao.token_hash, hash));
    expect(Date.now() - renovada!.ultimo_uso_em!.getTime()).toBeLessThan(60_000);
    // parada há 3 h: caiu, embora o teto absoluto (12 h) não tenha chegado
    await db.update(e.sessao).set({ ultimo_uso_em: new Date(Date.now() - 180 * 60_000) }).where(eq(e.sessao.token_hash, hash));
    const r = await cliente.get("/processos", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("CSSO_SESSAO_INATIVIDADE_MINUTOS=0 desliga", async () => {
    const antes = process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS;
    process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS = "0";
    redefinirConfig();
    try {
      const cliente = await entrar(novoCliente(), "coordenador_csso");
      const hash = autenticacao._hash_token(cliente.cookies.get(autenticacao.COOKIE_SESSAO)!);
      await db.update(e.sessao).set({ ultimo_uso_em: new Date(Date.now() - 600 * 60_000) }).where(eq(e.sessao.token_hash, hash));
      expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
    } finally {
      if (antes === undefined) delete process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS;
      else process.env.CSSO_SESSAO_INATIVIDADE_MINUTOS = antes;
      redefinirConfig();
    }
  });
});

// =====================================================================
describe("GET não escreve: /sair e o rascunho de parecer", () => {
  it("GET /sair só oferece o botão; a sessão continua", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const token = cliente.cookies.get(autenticacao.COOKIE_SESSAO)!;
    const r = await cliente.get("/sair");
    expect(r.status).toBe(200);
    expect(r.text).toContain('<form method="post" action="/sair">');
    expect(await autenticacao.sessao_valida(db, token)).not.toBeNull();
    // e o POST sai
    await cliente.post("/sair", {}, { seguir: false });
    expect(await autenticacao.sessao_valida(db, token)).toBeNull();
  });

  it("POST /sair vindo de outro site é recusado pelo CSRF", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const token = cliente.cookies.get(autenticacao.COOKIE_SESSAO)!;
    const r = await cliente.post("/sair", {}, { seguir: false, cabecalhos: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(await autenticacao.sessao_valida(db, token)).not.toBeNull();
  });

  it("o menu sai por formulário POST, não por link", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const r = await cliente.get("/processos");
    expect(r.text).not.toContain('href="/sair"');
    expect(r.text).toContain('action="/sair"');
  });

  it("GET /processos/{id}/parecer não cria rascunho: volta à ficha", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const criado = await cliente.post("/processos/novo", { nup: "23086.021284/2024-56", tipo_processo_id: "1" }, { seguir: false });
    const processo_id = Number(criado.location!.split("/").pop());
    const contar = async () =>
      (await db.select({ n: count() }).from(e.parecer_tecnico).where(eq(e.parecer_tecnico.processo_id, processo_id)))[0]!.n;
    const r = await cliente.get(`/processos/${processo_id}/parecer`, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/processos/${processo_id}`);
    expect(await contar()).toBe(0);
    // a ficha oferece o botão de POST
    const ficha = await cliente.get(`/processos/${processo_id}`);
    expect(ficha.text).toContain(`action="/processos/${processo_id}/parecer"`);
    const novo = await cliente.post(`/processos/${processo_id}/parecer`, {}, { seguir: false });
    expect(novo.location).toMatch(/^\/pareceres\/\d+$/);
    expect(await contar()).toBe(1);
  });
});

// =====================================================================
describe("CSV sem fórmula", () => {
  it.each([
    ["=HYPERLINK(\"http://x\")", "'=HYPERLINK(\"http://x\")"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["@SUM(1)", "'@SUM(1)"],
    ["-2+3", "'-2+3"],
    ["\tlixo", "'\tlixo"],
    ["-3", "-3"],
    ["+1,5", "+1,5"],
    ["Maria", "Maria"],
    ["", ""],
  ])("%j → %j", (entrada, saida) => {
    expect(neutralizar_formula(entrada)).toBe(saida);
  });

  it("neutraliza antes de pôr aspas; número de verdade passa", () => {
    expect(campo_csv('=1;2')).toBe(`"'=1;2"`);
    expect(campo_csv(-5)).toBe("-5");
    expect(campo_csv(null)).toBe("");
    expect(linha_csv(["=A1", "ok", 3])).toBe("'=A1;ok;3\r\n");
  });

  it("o relatório de processos sai neutralizado", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    await db.insert(e.servidor).values({ siape: "9988776", nome: "=HYPERLINK(\"http://evil\")" });
    const [sv] = await db.select().from(e.servidor).where(eq(e.servidor.siape, "9988776"));
    await cliente.post("/processos/novo", { nup: "23086.000001/2025-05", tipo_processo_id: "1", servidor_id: String(sv!.id) });
    const r = await cliente.get("/relatorios/exportar-processos");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/(^|;|")=HYPERLINK/m);
  });
});

// =====================================================================
describe("anexo sai só com tipo conhecido", () => {
  it.each([
    ["application/pdf", "application/pdf"],
    ["image/jpeg", "image/jpeg"],
    ["IMAGE/PNG; charset=binary", "image/png"],
    ["text/html", "application/octet-stream"],
    ["image/svg+xml", "application/octet-stream"],
    ["application/javascript", "application/octet-stream"],
    ["", "application/octet-stream"],
    [null, "application/octet-stream"],
  ])("%j → %j", (declarado, servido) => {
    expect(tipo_para_servir(declarado)).toBe(servido);
  });
});

// =====================================================================
describe("zip com teto de descompressão", () => {
  function zipCom(entradas: Record<string, Uint8Array | string>): Uint8Array {
    const z = new PizZip();
    for (const [nome, conteudo] of Object.entries(entradas)) z.file(nome, conteudo);
    return z.generate({ type: "uint8array", compression: "DEFLATE" }) as Uint8Array;
  }

  /** Um zip de uma entrada DEFLATE com o tamanho descompactado que se quiser declarar. */
  function zipCru(nome: string, comprimido: Uint8Array, declarado: number): Uint8Array {
    const n = Buffer.from(nome, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(n.length, 28);
    const inicio_central = local.length + n.length + comprimido.length;
    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0);
    fim.writeUInt16LE(1, 8);
    fim.writeUInt16LE(1, 10);
    fim.writeUInt32LE(central.length + n.length, 12);
    fim.writeUInt32LE(inicio_central, 16);
    return new Uint8Array(Buffer.concat([local, n, comprimido, central, n, fim]));
  }

  it("arquivo comum passa", () => {
    expect(() => conferir_zip(zipCom({ "a.xml": "<a/>".repeat(1000) }))).not.toThrow();
  });

  it("zip que explode além do teto é recusado sem descompactar tudo", () => {
    const bomba = zipCom({ "xl/worksheets/sheet1.xml": new Uint8Array(4 * 1024 * 1024) });
    expect(bomba.length).toBeLessThan(10_000);
    expect(() => conferir_zip(bomba, 1024 * 1024)).toThrow(ArquivoZipRecusado);
    expect(() => conferir_zip(bomba, 1024 * 1024)).toThrow(/passa de 1 MB/);
  });

  it("o teto vale pela SOMA das partes", () => {
    const partes: Record<string, Uint8Array> = {};
    for (let i = 0; i < 4; i++) partes[`p${i}.xml`] = new Uint8Array(400 * 1024);
    expect(() => conferir_zip(zipCom(partes), 1024 * 1024)).toThrow(ArquivoZipRecusado);
  });

  it("tamanho declarado mentiroso não engana: a conta é do que descompacta", () => {
    // zip montado à mão: 4 MB de zeros comprimidos numa entrada que DECLARA 10 bytes
    const bomba = zipCru("xl/worksheets/sheet1.xml", deflateRawSync(new Uint8Array(4 * 1024 * 1024)), 10);
    expect(() => conferir_zip(bomba, 1024 * 1024)).toThrow(/passa de 1 MB/);
  });

  it("muitas partes internas são recusadas", () => {
    const partes: Record<string, string> = {};
    for (let i = 0; i < 30; i++) partes[`p${i}.xml`] = "x";
    expect(() => conferir_zip(zipCom(partes), 1024 * 1024, 20)).toThrow(/30 partes internas/);
  });

  it("a importação de planilha recusa a bomba com 422 e não grava nada", async () => {
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const bomba = zipCom({ "xl/worksheets/sheet1.xml": new Uint8Array(70 * 1024 * 1024) });
    const r = await cliente.post("/importar/planilha", {
      arquivo: new File([bomba as Uint8Array<ArrayBuffer>], "bomba.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    });
    expect(r.status).toBe(422);
    expect(r.text).toContain("passa de 64 MB");
    const [{ n }] = await db.select({ n: count() }).from(e.stg_planilha_parecer);
    expect(n).toBe(0);
  });
});

// =====================================================================
describe("exportação completa sem credenciais", () => {
  it("tira sessão e limite de login, e esvazia o hash de senha", () => {
    const dump = new Map<string, string>([
      ["usuario", JSON.stringify([{ id: 1, login: "a", senha_hash: "$argon2id$x", precisa_trocar_senha: false }])],
      ["sessao", "[]"],
      ["limite_login_ip", "[]"],
      ["processo", JSON.stringify([{ id: 9 }])],
    ]);
    const limpo = sem_credenciais(dump);
    expect([...limpo.keys()].sort()).toEqual(["processo", "usuario"]);
    const [u] = JSON.parse(limpo.get("usuario")!);
    expect(u.senha_hash).toBe("");
    expect(u.precisa_trocar_senha).toBe(true);
    expect(limpo.get("processo")).toBe(dump.get("processo"));
  });

  it("o zip da exportação não tem hash Argon2 nem a tabela de sessão", async () => {
    // a sessão existe no banco: alguém entrou
    await entrar(novoCliente(), "superintendente");
    const { bytes } = await naTransacao((tx) => exportar_tudo(tx));
    const zip = new PizZip(bytes);
    const nomes = Object.keys(zip.files);
    expect(nomes.some((n) => n.endsWith("/usuario.json"))).toBe(true);
    expect(nomes.some((n) => n.endsWith("/sessao.json"))).toBe(false);
    for (const nome of nomes) {
      if (nome.endsWith(".json")) expect(zip.file(nome)!.asText(), nome).not.toContain("$argon2");
    }
  });
});
