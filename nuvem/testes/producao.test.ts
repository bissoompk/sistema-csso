/**
 * Prontidão de produção (PRODUCAO.md): a marca que trava as ferramentas que
 * apagam, a implantação pela linha de comando, o backup diário com anexos
 * separados e a restauração ponta a ponta, as rotinas noturnas e o gatilho
 * protegido da função de fundo.
 */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-producao-"));

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { count, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { abrirBancoAvulso, fecharBanco } from "../src/db/cliente.js";
import { migrarBanco } from "../src/db/migrar.js";
import { redefinirConfig } from "../src/config.js";
import { obterApp } from "../src/app.js";
import { definirArmazenamento, obterArmazenamento } from "../src/servicos/armazenamento.js";
import * as anexos from "../src/servicos/anexos.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as backup from "../src/servicos/backup.js";
import * as rotinas from "../src/servicos/rotinas.js";
import { ambienteDeProducao, BancoDeProducao, gravarMarca, identidadeDoBanco } from "../src/servicos/instalacao.js";
import { url_publica_declarada, validar, PARAMETRO_URL_PUBLICA } from "../src/servicos/emissao_certificado.js";
import { apagarEMigrar } from "../ferramentas/apagar-banco.js";
import * as producaoIniciar from "../ferramentas/producao-iniciar.js";
import * as ambienteTeste from "../ferramentas/ambiente-teste.js";
import * as restaurarBackup from "../ferramentas/restaurar-backup.js";
import { segredoConfere } from "../netlify/functions/backup-background.mjs";
import handlerDeFundo from "../netlify/functions/backup-background.mjs";
import { bancoLimpo, Cliente, contas, entrar, usuarioAtual, type AmbienteDeTeste } from "./ajuda";
import { _cenario, _usuario } from "./ajuda_certificado";
import { urlServidor } from "./modelo.js";

definirArmazenamento(null);

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
});

const extras: string[] = [];
afterAll(async () => {
  const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
  for (const n of extras) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/** Um banco novo e vazio (nem migrado), fora dos clones do modelo. */
async function bancoVazio(prefixo: string): Promise<string> {
  const nome = `csso_t_${prefixo}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  extras.push(nome);
  const admin = postgres(urlServidor(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${nome}`);
  await admin.end();
  return urlServidor(nome);
}

/** Troca variáveis de ambiente só durante `f`. */
async function comAmbiente<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const antes: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function saidaMuda(respostas: string[] = []) {
  const linhas: string[] = [];
  const erros: string[] = [];
  return {
    linhas,
    erros,
    saida: {
      log: (l: string) => linhas.push(l),
      erro: (l: string) => erros.push(l),
      perguntar: async () => respostas.shift() ?? "",
    },
  };
}

// sem `--login`: o login é o e-mail (23/10/2026)
const ARGS = [
  "--nome", "Fabrício de Produção",
  "--email", "fabricio@ufvjm.edu.br",
  "--url-publica", "https://csso.exemplo.ufvjm.edu.br/",
];

describe("identidade do banco e CSSO_AMBIENTE", () => {
  it("a identidade é a referência do Supabase, ou host/banco", () => {
    expect(identidadeDoBanco("postgresql://postgres.abcdefghijklmnopqrst:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"))
      .toBe("abcdefghijklmnopqrst");
    expect(identidadeDoBanco("postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres")).toBe("abcdefghijklmnopqrst");
    expect(identidadeDoBanco("postgres://postgres:csso@localhost:55432/csso_prod_teste")).toBe("localhost/csso_prod_teste");
  });

  it("produção com e sem acento; o resto não", () => {
    expect(ambienteDeProducao("producao")).toBe(true);
    expect(ambienteDeProducao(" Produção ")).toBe(true);
    expect(ambienteDeProducao("homologacao")).toBe(false);
    expect(ambienteDeProducao("teste")).toBe(false);
    expect(ambienteDeProducao("")).toBe(false);
  });
});

describe("a marca de produção", () => {
  it("não se altera nem se apaga pela aplicação", async () => {
    await gravarMarca(amb.db, "teste/marca", "vitest");
    const recusa = async (p: Promise<unknown>) => {
      const erro = await p.then(
        () => null,
        (x: Error & { cause?: Error }) => x,
      );
      expect(String(erro?.cause?.message ?? erro?.message)).toMatch(/marca de producao/);
    };
    await recusa(amb.db.update(e.instalacao).set({ marcada_por: "outro" }));
    await recusa(amb.db.delete(e.instalacao));
    await recusa(amb.db.execute(sql`TRUNCATE instalacao`));
    // e só existe uma
    await expect(gravarMarca(amb.db, "outra", "vitest")).rejects.toThrow();
  });

  it("apagarEMigrar recusa o banco marcado e não apaga nada", async () => {
    await gravarMarca(amb.db, "teste/marca", "vitest");
    const [antes] = await amb.db.select({ n: count() }).from(e.perfil);
    await expect(apagarEMigrar(amb.url)).rejects.toBeInstanceOf(BancoDeProducao);
    const [depois] = await amb.db.select({ n: count() }).from(e.perfil);
    expect(depois!.n).toBe(antes!.n);
    expect(antes!.n).toBeGreaterThan(0);
  });

  it("o ambiente de teste recusa banco marcado, mesmo com --permitir-remoto", async () => {
    await gravarMarca(amb.db, "teste/marca", "vitest");
    const codigo = await comAmbiente({ DATABASE_URL: amb.url }, () => ambienteTeste.principal(["--permitir-remoto"]));
    expect(codigo).toBe(3);
    const [n] = await amb.db.select({ n: count() }).from(e.perfil);
    expect(n!.n).toBeGreaterThan(0);
  });

  it("o ambiente de teste recusa rodar com CSSO_AMBIENTE=producao, mesmo sem marca", async () => {
    await expect(comAmbiente({ CSSO_AMBIENTE: "producao" }, () => ambienteTeste.recriar(amb.url))).rejects.toBeInstanceOf(
      BancoDeProducao,
    );
    const [n] = await amb.db.select({ n: count() }).from(e.perfil);
    expect(n!.n).toBeGreaterThan(0);
  });
});

describe("producao-iniciar", () => {
  it("valida as opções: URL pública https, sem localhost", () => {
    expect(producaoIniciar.lerOpcoes([])).toMatch(/faltam/);
    expect(producaoIniciar.lerOpcoes([...ARGS.slice(0, -1), "http://csso.exemplo.br"])).toMatch(/https/);
    expect(producaoIniciar.lerOpcoes([...ARGS.slice(0, -1), "https://localhost"])).toMatch(/localhost/);
    expect(producaoIniciar.lerOpcoes([...ARGS.slice(0, -1), "https://x.br/?a=1"])).toMatch(/query/);
    const ok = producaoIniciar.lerOpcoes(ARGS);
    expect(typeof ok).toBe("object");
    expect((ok as producaoIniciar.Opcoes).urlPublica).toBe("https://csso.exemplo.ufvjm.edu.br");
  });

  it("a senha provisória é forte e passa na política", () => {
    for (let i = 0; i < 50; i++) {
      const s = producaoIniciar.senhaProvisoriaForte();
      expect(s).toHaveLength(20);
      expect(autenticacao.politica_de_senha(s)).toEqual([]);
    }
  });

  it("sem a identidade digitada certa, nada é apagado", async () => {
    const url = await bancoVazio("prod_nao");
    await migrarBanco(url);
    const { saida, erros } = saidaMuda(["outro-banco"]);
    const codigo = await comAmbiente({ DATABASE_URL: url }, () => producaoIniciar.principal(ARGS, saida));
    expect(codigo).toBe(2);
    expect(erros.join("\n")).toMatch(/Nada foi apagado/);
    const avulso = abrirBancoAvulso(url);
    try {
      expect(await avulso.db.select().from(e.instalacao)).toEqual([]);
      expect(await avulso.db.select().from(e.usuario)).toEqual([]);
    } finally {
      await avulso.fechar();
    }
  });

  it("implanta: tabelas recriadas, semeado, URL pública, marca, superintendente com troca obrigatória", async () => {
    const url = await bancoVazio("prod_sim");
    // um banco "de teste" com lixo dentro, que a implantação tem de apagar
    await migrarBanco(url);
    const antes = abrirBancoAvulso(url);
    await antes.db.insert(e.servidor).values({ siape: "9999999", nome: "Dado de Teste Antigo" });
    await antes.fechar();

    const identidade = identidadeDoBanco(url);
    const { saida, linhas } = saidaMuda([identidade]);
    const codigo = await comAmbiente({ DATABASE_URL: url }, () => producaoIniciar.principal(ARGS, saida));
    expect(codigo).toBe(0);
    const senha = linhas.find((l) => l.includes("Senha provisória:"))!.split(":").pop()!.trim();
    expect(senha).toHaveLength(20);

    const avulso = abrirBancoAvulso(url);
    try {
      const db = avulso.db;
      expect(await db.select().from(e.servidor)).toEqual([]);
      const [marca] = await db.select().from(e.instalacao);
      expect(marca!.ambiente).toBe("PRODUCAO");
      expect(marca!.identidade).toBe(identidade);
      const [parametro] = await db.select().from(e.parametro).where(eq(e.parametro.chave, PARAMETRO_URL_PUBLICA));
      expect(parametro!.valor).toBe("https://csso.exemplo.ufvjm.edu.br");
      const usuarios = await db.select().from(e.usuario);
      expect(usuarios).toHaveLength(1);
      expect(usuarios[0]!.login).toBe("fabricio@ufvjm.edu.br");
      expect(usuarios[0]!.precisa_trocar_senha).toBe(true);
      expect(await autenticacao.conferir_senha(usuarios[0]!.senha_hash, senha)).toBe(true);
      const [perfis] = await db.select({ n: count() }).from(e.perfil);
      expect(perfis!.n).toBeGreaterThan(5);
      const eventos = await db.select().from(e.historico_evento);
      expect(eventos.map((x) => x.tipo_evento).sort()).toEqual(["BOOTSTRAP_SUPERINTENDENTE", "IMPLANTACAO_PRODUCAO"]);
      expect((await auditoria.cadeia_integra(db))[0]).toBe(true);
    } finally {
      await avulso.fechar();
    }

    // o primeiro login cai na troca obrigatória
    await fecharBanco();
    await comAmbiente({ DATABASE_URL: url }, async () => {
      redefinirConfig();
      try {
        const cliente = new Cliente(obterApp());
        const r = await cliente.post("/login", { login: "fabricio@ufvjm.edu.br", senha }, { seguir: false });
        expect(r.status).toBe(303);
        expect(r.location).toBe("/trocar-senha");
      } finally {
        await fecharBanco();
      }
    });
    redefinirConfig();

    // rodar de novo é recusado, e o ambiente de teste também
    const outra = saidaMuda([identidade]);
    expect(await comAmbiente({ DATABASE_URL: url }, () => producaoIniciar.principal(ARGS, outra.saida))).toBe(3);
    expect(outra.erros.join("\n")).toMatch(/já está marcado como PRODUÇÃO/);
    expect(await comAmbiente({ DATABASE_URL: url }, () => ambienteTeste.principal(["--permitir-remoto"]))).toBe(3);
    const depois = abrirBancoAvulso(url);
    try {
      expect(await depois.db.select({ login: e.usuario.login }).from(e.usuario)).toEqual([{ login: "fabricio@ufvjm.edu.br" }]);
    } finally {
      await depois.fechar();
    }
  });
});

describe("certificado em produção exige a URL pública declarada", () => {
  it("bloqueia a emissão sem certificado.url_publica, e libera com ela", async () => {
    await contas(amb.db);
    const operador = await _usuario(amb.db);
    const c = await _cenario(amb.db, operador);
    const producao = {
      CSSO_AMBIENTE: "producao",
      CSSO_URL_PUBLICA: undefined,
      URL: undefined,
      CSSO_CHAVE_SECRETA: "x".repeat(48),
      CSSO_BACKUP_SENHA: "y".repeat(24),
    };
    expect((await validar(amb.db, c.inscricao)).ok).toBe(true);
    await comAmbiente(producao, async () => {
      expect(await url_publica_declarada(amb.db)).toBe(false);
      const v = await validar(amb.db, c.inscricao);
      expect(v.ok).toBe(false);
      expect(v.bloqueios.join(" ")).toMatch(/certificado\.url_publica/);
      // a URL que o Netlify define para o site também vale
      await comAmbiente({ URL: "https://csso.netlify.app" }, async () => {
        expect(await url_publica_declarada(amb.db)).toBe(true);
      });
      await amb.db.insert(e.parametro).values({ chave: PARAMETRO_URL_PUBLICA, valor: "https://csso.exemplo.br" });
      expect((await validar(amb.db, c.inscricao)).ok).toBe(true);
    });
  });
});

describe("retenção dos backups (POLITICA_RETENCAO §4)", () => {
  const nome = (d: Date) =>
    `csso-${d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.enc`;
  const agora = new Date(Date.UTC(2031, 5, 15, 5, 0, 0));
  const dias = (n: number, hora = 4) => new Date(Date.UTC(2031, 5, 15 - n, hora, 30, 0));

  it("guarda 90 dias, o primeiro de cada mês por 5 anos, e nunca menos de 7", () => {
    // um backup por dia durante 7 anos
    const todos: string[] = [];
    for (let n = 0; n < 365 * 7; n++) todos.push(nome(dias(n)));
    todos.push("LEIA-ME.txt", "csso-lixo.enc");
    const apagar = new Set(rotinas.backups_a_apagar(todos, agora));
    const ficam = todos.filter((n) => !apagar.has(n));
    expect(apagar.has("LEIA-ME.txt")).toBe(false);
    expect(apagar.has("csso-lixo.enc")).toBe(false);
    for (let n = 0; n <= 89; n++) expect(ficam).toContain(nome(dias(n)));
    // fora da rotação: só o primeiro de cada mês, e só dentro de 5 anos
    const mensais = ficam.filter((f) => rotinas.momento_do_backup(f) && rotinas.momento_do_backup(f)! < dias(90));
    expect(mensais.every((f) => rotinas.momento_do_backup(f)!.getUTCDate() === 1)).toBe(true);
    expect(mensais.every((f) => rotinas.momento_do_backup(f)! >= new Date(Date.UTC(2026, 5, 15)))).toBe(true);
    expect(mensais.length).toBeGreaterThanOrEqual(56);
    expect(mensais.length).toBeLessThanOrEqual(58);
  });

  it("se o backup parou há meses, os 7 últimos ficam", () => {
    const velhos = Array.from({ length: 10 }, (_, i) => nome(dias(400 + i)));
    const apagar = rotinas.backups_a_apagar(velhos, agora);
    expect(velhos.length - apagar.length).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < 7; i++) expect(apagar).not.toContain(nome(dias(400 + i)));
  });

  it("reter_backups apaga do armazenamento só o que a política manda", async () => {
    const arm = obterArmazenamento();
    const pasta = `backups-retencao-${Date.now()}`;
    const velho = nome(dias(200, 3));
    const velhoMesmoMes = nome(dias(199, 3));
    for (const n of [velho, velhoMesmoMes, ...Array.from({ length: 8 }, (_, i) => nome(dias(i)))]) {
      await arm.gravar(`${pasta}/${n}`, new Uint8Array([1]));
    }
    const r = await rotinas.reter_backups(arm, agora, pasta);
    // o de 199 dias atrás não é o primeiro do mês dele (o de 200 é); os 8 recentes ficam
    const primeiroDoMes = rotinas.momento_do_backup(velho)!.getUTCMonth() === rotinas.momento_do_backup(velhoMesmoMes)!.getUTCMonth();
    expect(r.apagados).toEqual(primeiroDoMes ? [`${pasta}/${velhoMesmoMes}`] : []);
    expect((await arm.listar(pasta)).length).toBe(10 - r.apagados.length);
  });
});

describe("backup diário e restauração ponta a ponta", () => {
  it("backup → banco vazio → restaurar: contagens, cadeia e anexos íntegros", async () => {
    await contas(amb.db);
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    const [sv] = await amb.db.insert(e.servidor).values({ siape: "7654321", nome: "Servidor do Backup" }).returning();
    await auditoria.registrar(amb.db, {
      entidade: "servidor",
      entidade_id: sv!.id,
      tipo_evento: "SERVIDOR_CRIADO",
      descricao: "criado para o backup",
      usuario: coord,
    });
    const conteudo = new TextEncoder().encode("%PDF-1.4\nLAUDO ASSINADO\n".repeat(50));
    const guardado = await anexos.guardar(amb.db, {
      entidade: "servidor",
      entidade_id: sv!.id,
      nome_original: "laudo.pdf",
      conteudo,
      mime_type: "application/pdf",
      categoria: "LAUDO",
      usuario: coord,
    });

    const senha = "senha-do-backup-diario-2026";
    const r1 = await comAmbiente({ CSSO_BACKUP_SENHA: senha }, () => rotinas.backup_diario(amb.db));
    expect(r1.ok).toBe(true);
    expect(r1.backup!.anexos_novos).toBe(1);
    const r2 = await comAmbiente({ CSSO_BACKUP_SENHA: senha }, () => rotinas.backup_diario(amb.db));
    expect(r2.backup!.anexos_novos).toBe(0);
    expect(r2.backup!.anexos_ja_guardados).toBe(1);
    const execucoes = await amb.db.select().from(e.rotina_execucao);
    expect(execucoes.filter((x) => x.rotina === rotinas.ROTINA_BACKUP && x.ok)).toHaveLength(2);
    expect(execucoes.filter((x) => x.rotina === rotinas.ROTINA_RETENCAO && x.ok)).toHaveLength(2);

    // o pacote NÃO leva o anexo; leva o índice
    const arm = obterArmazenamento();
    const aberto = backup.restaurar(await arm.ler(r2.backup!.chave), senha);
    expect([...aberto.arquivos.keys()]).toEqual([]);
    expect(aberto.anexos_separados).toEqual([
      { storage_key: guardado.anexo.storage_key, copia: backup.chave_do_anexo_no_backup(guardado.anexo.storage_key) },
    ]);

    // a pasta de anexos do backup, "baixada do bucket", e um armazenamento novo
    const baixados = mkdtempSync(path.join(tmpdir(), "csso-anexos-baixados-"));
    const copia = backup.chave_do_anexo_no_backup(guardado.anexo.storage_key);
    writeFileSync(path.join(baixados, path.basename(copia)), await arm.ler(copia));
    const pacote = path.join(baixados, "..", `pacote-${Date.now()}.enc`);
    writeFileSync(pacote, await arm.ler(r2.backup!.chave));

    const destino = await bancoVazio("restaura");
    await migrarBanco(destino);
    const outroArmazenamento = mkdtempSync(path.join(tmpdir(), "csso-restaurado-"));
    await fecharBanco();
    const codigo = await comAmbiente(
      { DATABASE_URL: destino, CSSO_BACKUP_SENHA: senha, CSSO_DIR_ARQUIVOS: outroArmazenamento },
      async () => {
        definirArmazenamento(null);
        redefinirConfig();
        try {
          return await restaurarBackup.principal([pacote, "--anexos", baixados]);
        } finally {
          definirArmazenamento(null);
        }
      },
    );
    redefinirConfig();
    expect(codigo).toBe(0);

    const origem = abrirBancoAvulso(amb.url);
    const novo = abrirBancoAvulso(destino);
    try {
      const tabelas = (await novo.db.execute(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )) as unknown as { tablename: string }[];
      for (const { tablename } of tabelas) {
        if (tablename === "rotina_execucao") continue; // o registro do 2º backup nasceu depois do retrato dele
        const [a] = (await origem.db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${tablename}"`))) as unknown as { n: number }[];
        const [b] = (await novo.db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${tablename}"`))) as unknown as { n: number }[];
        expect(b!.n, tablename).toBe(a!.n);
      }
      expect((await auditoria.cadeia_integra(novo.db))[0]).toBe(true);
      const [ev] = await novo.db.select({ n: count() }).from(e.historico_evento);
      expect(ev!.n).toBeGreaterThan(0);
    } finally {
      await origem.fechar();
      await novo.fechar();
    }
    const restaurado = readdirSync(path.join(outroArmazenamento, "anexos", guardado.anexo.storage_key.slice(0, 2)));
    expect(restaurado).toEqual([guardado.anexo.storage_key.split("/")[1]]);
  });

  it("anexo que não coube no prazo fica pendente e vai na passada seguinte", async () => {
    await contas(amb.db);
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    const [sv] = await amb.db.insert(e.servidor).values({ siape: "7654329", nome: "Servidor Pendente" }).returning();
    const guardado = await anexos.guardar(amb.db, {
      entidade: "servidor",
      entidade_id: sv!.id,
      nome_original: "portaria.pdf",
      conteudo: new TextEncoder().encode(`%PDF-1.4 pendente ${Date.now()}`),
      mime_type: "application/pdf",
      categoria: "PORTARIA",
      usuario: coord,
    });
    const parcial = await backup.fazer_backup_diario(amb.db, { prazo_anexos_ms: -1 });
    expect(parcial.pendentes).toEqual([guardado.anexo.storage_key]);
    expect(parcial.anexos_novos).toBe(0);
    // o índice cita o pendente: restaurar este pacote avisa que falta
    const aberto = backup.restaurar(await obterArmazenamento().ler(parcial.chave));
    expect(aberto.anexos_separados!.map((a) => a.storage_key)).toContain(guardado.anexo.storage_key);
    const completo = await backup.fazer_backup_diario(amb.db);
    expect(completo.pendentes).toEqual([]);
    expect(completo.anexos_novos).toBe(1);
  });

  it("em produção, backup sem senha própria falha e fica registrado", async () => {
    const r = await comAmbiente({ CSSO_AMBIENTE: "producao", CSSO_BACKUP_SENHA: undefined }, () =>
      rotinas.backup_diario(amb.db),
    );
    expect(r.ok).toBe(false);
    expect(r.detalhe).toMatch(/CSSO_BACKUP_SENHA/);
    const [x] = await amb.db.select().from(e.rotina_execucao);
    expect(x!.rotina).toBe(rotinas.ROTINA_BACKUP);
    expect(x!.ok).toBe(false);
  });
});

describe("rotinas noturnas", () => {
  it("registram cada passada; cadeia íntegra é ok", async () => {
    const r = await rotinas.rotinas_noturnas(amb.db);
    expect(r.ok).toBe(true);
    expect(r.passos.map((p) => p.rotina)).toEqual(
      expect.arrayContaining([
        rotinas.ROTINA_SESSOES,
        rotinas.ROTINA_LIMITES_IP,
        rotinas.ROTINA_PRIVACIDADE,
        rotinas.ROTINA_PENDENCIAS,
        rotinas.ROTINA_CADEIA,
      ]),
    );
    const [conf] = await amb.db.select().from(e.conferencia_cadeia);
    expect(conf!.origem).toBe("ROTINA");
    expect(await amb.db.select().from(e.rotina_execucao)).toHaveLength(r.passos.length);
  });

  it("cadeia adulterada sai como falha (incidente)", async () => {
    await contas(amb.db);
    const coord = await usuarioAtual(amb.db, "coordenador_csso");
    const ev = await auditoria.registrar(amb.db, {
      entidade: "servidor",
      entidade_id: 1,
      tipo_evento: "SERVIDOR_CRIADO",
      descricao: "original",
      usuario: coord,
    });
    await amb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE historico_evento SET descricao = 'adulterada' WHERE id = ${ev.id}`);
    });
    const r = await rotinas.rotinas_noturnas(amb.db);
    expect(r.ok).toBe(false);
    const cadeia = r.passos.find((p) => p.rotina === rotinas.ROTINA_CADEIA)!;
    expect(cadeia.detalhe).toMatch(/CADEIA ROMPIDA/);
  });

  it("expurga sessão vencida há mais de 90 dias", async () => {
    await contas(amb.db);
    const [u] = await amb.db.select().from(e.usuario).limit(1);
    await amb.db.insert(e.sessao).values({
      usuario_id: u!.id,
      token_hash: "h".repeat(64),
      expira_em: new Date(Date.now() - 100 * 86_400_000),
    } as typeof e.sessao.$inferInsert);
    const r = await rotinas.rotinas_noturnas(amb.db);
    expect(r.passos.find((p) => p.rotina === rotinas.ROTINA_SESSOES)!.detalhe).toMatch(/^1 sessão/);
  });
});

describe("a função de fundo do backup", () => {
  it("o segredo confere em tempo constante e exige 32+ caracteres", () => {
    const s = "s".repeat(40);
    expect(segredoConfere(s, s)).toBe(true);
    expect(segredoConfere("errado", s)).toBe(false);
    expect(segredoConfere(null, s)).toBe(false);
    expect(segredoConfere("curto", "curto")).toBe(false);
    expect(segredoConfere(s, undefined)).toBe(false);
  });

  it("sem o segredo, não toca no banco", async () => {
    await comAmbiente({ CSSO_ROTINA_SEGREDO: "k".repeat(40) }, async () => {
      await handlerDeFundo(new Request("http://x/.netlify/functions/backup-background", { method: "POST" }));
      await handlerDeFundo(
        new Request("http://x/.netlify/functions/backup-background", { method: "POST", headers: { "x-csso-rotina": "errado" } }),
      );
    });
    expect(await amb.db.select().from(e.rotina_execucao)).toEqual([]);
  });
});

describe("/saude/db mostra as rotinas", () => {
  it("sem backup, alerta; depois do backup, a passada aparece", async () => {
    await contas(amb.db);
    const cliente = await entrar(amb.novoCliente(), "admin_ti");
    let j = (await cliente.get("/saude/db")).json();
    expect(j.alertas).toContain("nenhum backup registrado");
    await rotinas.backup_diario(amb.db);
    j = (await cliente.get("/saude/db")).json();
    expect(j.rotinas.map((r: { rotina: string }) => r.rotina)).toContain("BACKUP");
    expect(j.alertas).toEqual([]);
    expect(j.producao).toBe(false);
  });
});
