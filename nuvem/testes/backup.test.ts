/**
 * CA-13 (backup/restauração) e CA-14 (EXPORTAR-TUDO), e a tela /config.
 * Porte de `testes/integracao/test_backup_export.py` e das partes de /config
 * de `test_pendencias_e_sla.py` (SLA pela tela) e `test_rotas_permissoes.py`.
 *
 * O que muda na nuvem (DESVIOS.md): não há `csso.db` nem WAL. O banco vai como
 * dump lógico (`banco/<tabela>.json`) e o CA-13 é "backup -> banco NOVO,
 * migrado e vazio -> restaurar -> a cadeia de auditoria confere e o
 * comprovante volta com o mesmo SHA-256". Os dois testes de WAL/lock do Python
 * não têm objeto aqui.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-backup-"));

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import PizZip from "pizzip";
import { drizzle } from "drizzle-orm/postgres-js";
import { count, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { migrarBanco } from "../src/db/migrar.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as anexos from "../src/servicos/anexos.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as backup from "../src/servicos/backup.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type AmbienteDeTeste } from "./ajuda";
import { urlServidor } from "./modelo.js";

definirArmazenamento(null);

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

const extras: string[] = [];
afterAll(async () => {
  const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
  for (const n of extras) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

describe("envelope cifrado", () => {
  it("cifra e decifra", () => {
    const original = new TextEncoder().encode("conteudo do banco".repeat(100));
    const pacote = backup.cifrar(original, "senha-forte");
    expect(Buffer.from(pacote.subarray(0, 8)).equals(backup.MAGICO)).toBe(true);
    expect(Buffer.from(pacote).includes(Buffer.from("conteudo do banco"))).toBe(false);
    expect(Buffer.from(backup.decifrar(pacote, "senha-forte")).equals(Buffer.from(original))).toBe(true);
  });

  it("senha errada não decifra", () => {
    const pacote = backup.cifrar(new Uint8Array([1]), "certa");
    expect(() => backup.decifrar(pacote, "errada")).toThrow();
  });

  it("backup recusa destino em nuvem", async () => {
    await expect(backup.fazer_backup(amb.db, { destino: "OneDrive/backups" })).rejects.toBeInstanceOf(backup.DestinoProibido);
  });

  it("export recusa destino em nuvem", async () => {
    await expect(backup.exportar_tudo(amb.db, { destino: "Dropbox" })).rejects.toBeInstanceOf(backup.DestinoProibido);
  });

  it("restaura o backup antigo do Python (recheio = .db cru)", () => {
    const cru = Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.from("banco antigo, sem anexo nenhum".repeat(20))]);
    const pacote = backup.cifrar(cru, backup.senha_padrao());
    const r = backup.restaurar(pacote);
    expect(Buffer.from(r.sqlite!).equals(cru)).toBe(true);
    expect(r.banco).toBeNull();
  });
});

describe("CA-13: backup, banco novo, restaurar", () => {
  it("devolve o banco, a cadeia confere e o comprovante volta com o mesmo SHA-256", async () => {
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    const [sv] = await amb.db.insert(e.servidor).values({ siape: "7654321", nome: "Servidor do Backup" }).returning();
    await auditoria.registrar(amb.db, {
      entidade: "servidor",
      entidade_id: sv!.id,
      tipo_evento: "SERVIDOR_CRIADO",
      descricao: "valor '50.00' na trilha",
      valor_novo: "50.00",
      usuario: coord,
    });
    const comprovante = new TextEncoder().encode("%PDF-1.4\nCOMPROVANTE DE EPI COM ASSINATURA DO SERVIDOR\n".repeat(40));
    const guardado = await anexos.guardar(amb.db, {
      entidade: "servidor",
      entidade_id: sv!.id,
      nome_original: "comprovante.pdf",
      conteudo: comprovante,
      mime_type: "application/pdf",
      categoria: "FICHA_EPI",
      usuario: coord,
    });
    const sha = anexos.digerir(comprovante);

    const resultado = await backup.fazer_backup(amb.db, { senha: "senha-do-teste" });
    expect(resultado.arquivos).toBe(1);
    expect(resultado.chave.startsWith("backups/")).toBe(true);

    const { obterArmazenamento } = await import("../src/servicos/armazenamento.js");
    const pacote = await obterArmazenamento().ler(resultado.chave);
    const aberto = backup.restaurar(pacote, "senha-do-teste");
    expect(aberto.banco!.has("historico_evento")).toBe(true);
    const devolvido = aberto.arquivos.get(`anexos/${guardado.anexo.storage_key}`)!;
    expect(anexos.digerir(devolvido)).toBe(sha);

    // um banco NOVO, só migrado
    const nome = `csso_t_restaura_${Date.now()}`;
    extras.push(nome);
    const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${nome}`);
    await admin.end();
    await migrarBanco(urlServidor(nome));
    const conexao = postgres(urlServidor(nome), {
      max: 1,
      prepare: false,
      onnotice: () => {},
      types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
    });
    try {
      const novo = drizzle(conexao, { schema: e });
      await novo.transaction((tx) => backup.restaurar_no_banco(tx, aberto.banco!));
      const [a] = await amb.db.select({ n: count() }).from(e.historico_evento);
      const [b] = await novo.select({ n: count() }).from(e.historico_evento);
      expect(b!.n).toBe(a!.n);
      expect((await auditoria.cadeia_integra(novo))[0]).toBe(true);
      const [sv2] = await novo.select().from(e.servidor).where(eq(e.servidor.siape, "7654321"));
      expect(sv2!.nome).toBe("Servidor do Backup");
      // a sequência foi posta depois do máximo: a próxima inserção não colide
      const [outro] = await novo.insert(e.servidor).values({ siape: "7654322", nome: "Depois da restauração" }).returning();
      expect(outro!.id).toBeGreaterThan(sv2!.id);
    } finally {
      await conexao.end();
    }
  });
});

describe("CA-14: exportar tudo", () => {
  it("o zip tem tudo, com CSV com BOM e as 24 colunas", async () => {
    await amb.db.insert(e.parecer_tecnico).values({ numero: 1, ano: 2025, situacao: "RASCUNHO" });
    const alvo = await backup.exportar_tudo(amb.db);
    const zip = new PizZip(alvo.bytes);
    const nomes = new Set(Object.keys(zip.files));
    expect(nomes.has("Pareceres.xlsx")).toBe(true);
    expect(nomes.has("LEIA-ME-DO-EXPORT.txt")).toBe(true);
    expect(nomes.has("banco/servidor.json")).toBe(true);
    expect([...nomes].some((n) => n.startsWith("csv/"))).toBe(true);
    const leia_me = zip.file("LEIA-ME-DO-EXPORT.txt")!.asText();
    expect(leia_me).toContain("LGPD");
    expect(leia_me).toContain("nuvem pessoal");
    const bruto = Buffer.from(zip.file("csv/pareceres.csv")!.asUint8Array());
    expect([...bruto.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const cabecalho = bruto.subarray(3).toString("utf8").split("\r\n")[0]!.split(";");
    expect(cabecalho.slice(0, 24)).toEqual(backup.CABECALHO_PLANILHA);
    expect(cabecalho[24]).toBe("col_Y_sem_cabecalho");
    // a planilha também
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(zip.file("Pareceres.xlsx")!.asUint8Array()) as any);
    const linha = wb.worksheets[0]!.getRow(1).values as unknown[];
    expect(linha.slice(1, 25)).toEqual(backup.CABECALHO_PLANILHA);
    expect(linha[25]).toBe("col_Y_sem_cabecalho");
  });

  it("o export inclui os anexos", async () => {
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    await anexos.guardar(amb.db, {
      entidade: "servidor",
      entidade_id: 1,
      nome_original: "x.pdf",
      conteudo: new TextEncoder().encode("%PDF falso"),
      mime_type: "application/pdf",
      categoria: "OUTRO",
      usuario: coord,
    });
    const alvo = await backup.exportar_tudo(amb.db);
    expect(Object.keys(new PizZip(alvo.bytes).files).some((n) => n.startsWith("anexos/"))).toBe(true);
  });
});

describe("tela /config", () => {
  it("o SLA pela tela", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.post("/config/sla", { sla_A_FAZER: "7", sla_EM_ANDAMENTO: "21", sla_AGUARDANDO: "abc" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("SLA atualizado");
    expect((await amb.cliente.get("/config")).text).toContain('name="sla_A_FAZER" value="7"');
  });

  it("admin_ti abre a parte da máquina e não a do processo", async () => {
    await entrar(amb.cliente, "admin_ti");
    const corpo = (await amb.cliente.get("/config")).text;
    expect(corpo).toContain("Onde o dado mora");
    expect(corpo).toContain("Fazer backup cifrado agora");
    expect(corpo).not.toContain("SLA por coluna");
    expect(corpo).not.toContain("Setor emissor</h2>");
  });

  it("quem não tem nenhuma das duas não entra", async () => {
    await entrar(amb.cliente, "almoxarife_sesmt");
    expect((await amb.cliente.get("/config")).status).toBe(403);
  });

  it("o backup pela tela deixa rastro na trilha", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/config/backup");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Backup cifrado gerado");
    const eventos = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "BACKUP_EXECUTADO"));
    expect(eventos).toHaveLength(1);
  });

  it("exportar é POST e pede a permissão", async () => {
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.post("/config/exportar-tudo", {}, { seguir: false })).status).toBe(403);
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.post("/config/exportar-tudo", {}, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.cabecalho("content-type")).toContain("application/zip");
    expect((await amb.cliente.get("/config/exportar-tudo")).status).not.toBe(200);
  });
});
