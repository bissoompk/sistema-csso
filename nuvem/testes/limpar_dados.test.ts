/**
 * Limpar dados de teste (24/10/2026, `/config/limpar-dados`, motor em
 * `servicos/limpeza.ts`): só o Administrador do sistema abre e executa; a
 * simulação não grava nada; sem a frase, a senha ou a identidade não apaga;
 * cada módulo apaga o seu e mantém os outros; o grafo recusa a tabela fora da
 * lista; "servidores e contas" preserva o executor e o governo; o backup sai
 * antes e a falha dele impede a limpeza; a trilha ganha um evento sem dado
 * pessoal; e rodar de novo com tudo vazio não quebra.
 *
 * NUNCA toca banco de produção: roda no clone de teste do `bancoLimpo()`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-limpar-dados-arq-"));

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { definirArmazenamento, obterArmazenamento, type Armazenamento } from "../src/servicos/armazenamento.js";
import * as anexos from "../src/servicos/anexos.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as backup from "../src/servicos/backup.js";
import * as emissao from "../src/servicos/emissao_certificado.js";
import * as governanca from "../src/servicos/governanca.js";
import * as limpeza from "../src/servicos/limpeza.js";
import * as epi_requisicao from "../src/servicos/epi_requisicao.js";
import { identidadeDoBanco } from "../src/servicos/instalacao.js";
import { FRASE } from "../src/rotas/limpar_dados.js";
import {
  SENHA_TESTE,
  bancoLimpo,
  contas,
  criarUsuario,
  entrar,
  naTransacao,
  usuarioAtual,
  type AmbienteDeTeste,
  type Cliente,
} from "./ajuda.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";
import { em_investigacao } from "./acidente_ajuda.js";
import * as req from "./ajuda_epi_requisicao.js";
import { entregar } from "./ajuda_epi_ficha.js";
import { cenario as cenario_processo } from "./ajuda_processos.js";

const CAMINHO = "/config/limpar-dados";
let amb: AmbienteDeTeste;
let db: Banco;

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  definirArmazenamento(null);
  delete process.env.NETLIFY;
  await contas(db);
});

afterAll(() => {
  rmSync(process.env.CSSO_DIR_ARQUIVOS!, { recursive: true, force: true });
});

const identidade = () => identidadeDoBanco(amb.url);

/** A contagem de TODA tabela de `public`. */
async function tudo(): Promise<Record<string, number>> {
  const nomes = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)) as unknown as {
    tablename: string;
  }[];
  const r: Record<string, number> = {};
  for (const { tablename } of nomes) {
    const [l] = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM public."${tablename}"`))) as unknown as { n: number }[];
    r[tablename] = l!.n;
  }
  return r;
}

/** `tudo()` sem as tabelas que o próprio pedido mexe (sessão, registro de acesso). */
async function estavel(): Promise<Record<string, number>> {
  const r = await tudo();
  for (const t of ["sessao", "registro_acesso", "limite_login_ip"]) delete r[t];
  return r;
}

interface Montado {
  /** um blob de anexo de cada módulo, que sai junto com ele */
  blobs: Record<limpeza.CodigoModulo, string>;
  /** um blob de anexo que não é de módulo nenhum (fica sempre) */
  blob_fica: string;
}

async function guardar(entidade: string, entidade_id: number, bytes: number[], categoria = "OUTRO") {
  const usuario = await usuarioAtual(db, "coordenador_csso");
  const r = await naTransacao((tx) =>
    anexos.guardar(tx, {
      entidade,
      entidade_id,
      nome_original: `${entidade}.pdf`,
      conteudo: new Uint8Array([37, 80, 68, 70, ...bytes]),
      mime_type: "application/pdf",
      categoria,
      usuario,
    }),
  );
  return anexos.chave_no_armazenamento(r.anexo.storage_key);
}

/** Dados nos quatro módulos, com anexo, pendência e e-mail de cada um. */
async function montar(): Promise<Montado> {
  // treinamentos: turma concluída, certificado emitido, local
  const operador = await _usuario(db);
  const cen = await _cenario(db, operador);
  const emitido = await emissao.emitir(db, operador, cen.inscricao, { gerar_pdf: false });
  await db.insert(e.local_treinamento).values({ nome: "Sala de teste", criado_por: operador.id });
  await db.insert(e.email_saida).values({
    tipo: "CERTIFICADO",
    destinatario: "marco.teste@ufvjm.edu.br",
    assunto: "Seu certificado",
    certificado_id: emitido.certificado.id,
  });
  await db.insert(e.pendencia).values({
    tipo: "CERTIFICADO_A_VENCER",
    descricao: "reciclagem",
    entidade: "certificado",
    entidade_id: emitido.certificado.id,
    chave: `teste-cert-${emitido.certificado.id}`,
  });
  const blob_treinamento = await guardar("turma", cen.turma.id, [1]);

  // acidentes: comunicada, assumida e em investigação; um link público e uma leitura de dado sensível
  const { oc } = await em_investigacao(db);
  const coord = await usuarioAtual(db, "coordenador_csso");
  await db.insert(e.acidente_link_publico).values({ token_sha256: "c".repeat(64), gerado_por: coord.id });
  await db.insert(e.acesso_dado_sensivel).values({ usuario_id: coord.id, acidente_id: oc.id, campo: "acidente.saude" });
  const blob_acidente = await guardar("acidente_ocorrencia", oc.id, [2]);

  // EPI: pedido enviado e uma entrega pela tela (ficha, movimento de saída)
  const analista = await req.usuario(db, { login: "analista_limpeza" });
  const cen_epi = await req.cenario(db, { siape: "7111111", nome: "Joana Limpeza" });
  const pedido = await req.pedido_pronto(db, cen_epi, analista);
  await naTransacao((tx) => epi_requisicao.enviar(tx, analista, pedido, { termo_aceito: true }));
  const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
  const r = await entregar(cliente, { servidor: cen_epi.servidor.id, item: cen_epi.item.id, entrada: cen_epi.entrada.id });
  expect(r.status, r.text.slice(0, 300)).toBeLessThan(400);
  const [ficha] = await db.select().from(e.epi_ficha_registro).limit(1);
  expect(ficha, "a entrega gravou a ficha").toBeDefined();
  const blob_epi = await guardar("epi_ficha_registro", ficha!.id, [3]);

  // processos: o caso do Parecer 1/2025, uma demanda com encaminhamento
  const proc = await cenario_processo(db, { siape: "1110999", nup: "23086.099999/2024-11" });
  const [demanda] = await db
    .insert(e.demanda)
    .values({ data_chegada: "2026-10-01", canal: "EMAIL", solicitante_nome: "Fulano de Teste", assunto: "Pedido de vistoria" })
    .returning();
  await db.insert(e.demanda_encaminhamento).values({
    demanda_id: demanda!.id,
    data_encaminhamento: "2026-10-02",
    para_quem: "Engenharia",
    pedido: "vistoriar",
  });
  await db.insert(e.pendencia).values({
    tipo: "INCLUIR_NO_SEI",
    descricao: "incluir",
    processo_id: proc.processo_id,
    chave: `teste-proc-${proc.processo_id}`,
  });
  await db.insert(e.acesso_dado_sensivel).values({ usuario_id: coord.id, processo_id: proc.processo_id, campo: "exposicao" });
  const blob_processo = await guardar("processo", proc.processo_id, [4]);

  // um anexo que não é de nenhum dos quatro (o cadastro do servidor fica)
  const blob_fica = await guardar("servidor", proc.servidor_id, [5]);
  return {
    blobs: { treinamentos: blob_treinamento, acidentes: blob_acidente, epi: blob_epi, processos: blob_processo },
    blob_fica,
  };
}

function campos(modulos: readonly string[], extra: Record<string, string> = {}, contas_tambem = false) {
  return { modulo: [...modulos], ...(contas_tambem ? { contas: "1" } : {}), ...extra };
}

function confirmacao(extra: Record<string, string> = {}) {
  return { frase: FRASE, identidade: identidade(), senha_atual: SENHA_TESTE, ...extra };
}

async function admin(): Promise<Cliente> {
  return entrar(amb.novoCliente(), "administrador_sistema");
}

const TODOS = limpeza.CODIGOS_MODULO;

async function eventos(tipo: string) {
  return db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("quem abre e executa", () => {
  it.each(["coordenador_csso", "superintendente", "admin_ti", "auditor_interno"])("%s: 403 na tela e nos POST", async (perfil) => {
    const c = await entrar(amb.novoCliente(), perfil);
    expect((await c.get(CAMINHO)).status).toBe(403);
    expect((await c.post(`${CAMINHO}/simular`, campos(TODOS), { seguir: false })).status).toBe(403);
    expect((await c.post(`${CAMINHO}/executar`, campos(TODOS, confirmacao()), { seguir: false })).status).toBe(403);
    const cfg = await c.get("/config");
    expect(cfg.text).not.toContain(`href="${CAMINHO}"`);
  });

  it("o Administrador do sistema abre, e vê o link em /config", async () => {
    const c = await admin();
    const r = await c.get(CAMINHO);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Template render error");
    expect(r.text).toContain(identidade());
    expect((await c.get("/config")).text).toContain(`href="${CAMINHO}"`);
  });

  it("dupla tranca: a permissão posta à mão noutro perfil não basta", async () => {
    const [perfil] = await db.insert(e.perfil).values({ codigo: "falso_admin", nome: "Falso" }).returning();
    const [perm] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "dados.limpar"));
    await db.insert(e.perfil_permissao).values({ perfil_id: perfil!.id, permissao_id: perm!.id });
    await criarUsuario(db, { login: "quase", perfis: ["falso_admin"] });
    const c = await entrar(amb.novoCliente(), "quase");
    const r = await c.get(CAMINHO);
    expect(r.status).toBe(403);
    expect(r.text).toContain("Administrador do sistema");
  });

  it("a permissão é só do Administrador do sistema na semente", async () => {
    const linhas = await db
      .select({ perfil: e.perfil.codigo })
      .from(e.perfil_permissao)
      .innerJoin(e.perfil, eq(e.perfil.id, e.perfil_permissao.perfil_id))
      .innerJoin(e.permissao, eq(e.permissao.id, e.perfil_permissao.permissao_id))
      .where(eq(e.permissao.codigo, "dados.limpar"));
    expect(linhas.map((l) => l.perfil)).toEqual(["administrador_sistema"]);
  });
});

describe("simular e confirmar", () => {
  it("a simulação mostra as contagens e não grava nada", async () => {
    await montar();
    const antes = await estavel();
    const c = await admin();
    const r = await c.post(`${CAMINHO}/simular`, campos(TODOS, {}, true));
    expect(r.status, r.text.slice(0, 500)).toBe(200);
    expect(r.text).not.toContain("Template render error");
    expect(r.text).toContain("acidente_ocorrencia");
    expect(r.text).toContain("epi_ficha_registro");
    expect(r.text).toContain("parecer_tecnico");
    expect(r.text).toContain("certificado");
    expect(r.text).toContain('action="/config/limpar-dados/executar"');
    expect(await estavel()).toEqual(antes);
    expect(await eventos(auditoria.DADOS_DE_TESTE_APAGADOS)).toHaveLength(0);
  });

  it("contas sem os quatro módulos é recusado (na simulação e no POST)", async () => {
    const c = await admin();
    const r = await c.post(`${CAMINHO}/simular`, campos(["epi"], {}, true));
    expect(r.status).toBe(422);
    expect(r.text).toContain("quatro módulos");
    const x = await c.post(`${CAMINHO}/executar`, campos(["epi"], confirmacao(), true));
    expect(x.status).toBe(422);
  });

  it("sem a frase, com a senha errada ou com a identidade errada não apaga", async () => {
    await montar();
    const antes = await estavel();
    delete antes.usuario; // a senha errada grava o contador de tentativas (a contagem não muda)
    const c = await admin();
    const casos: [Record<string, string>, string][] = [
      [confirmacao({ frase: "apagar dados de teste" }), "frase"],
      [confirmacao({ frase: "" }), "frase"],
      [confirmacao({ identidade: "outro/banco" }), "identidade"],
      [confirmacao({ senha_atual: "errada-123456" }), "Senha atual incorreta"],
      [confirmacao({ senha_atual: "" }), "senha atual"],
    ];
    for (const [extra, texto] of casos) {
      const r = await c.post(`${CAMINHO}/executar`, campos(TODOS, extra));
      expect(r.status, texto).toBe(422);
      expect(r.text).toContain(texto);
      expect(r.text).toContain("Nada foi apagado");
    }
    const depois = await estavel();
    delete depois.usuario;
    expect(depois).toEqual(antes);
    // a senha errada contou como tentativa (o contador do login foi gravado)
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "administrador_sistema"));
    expect(conta!.tentativas_falhas).toBe(1);
    expect(await eventos(auditoria.DADOS_DE_TESTE_APAGADOS)).toHaveLength(0);
  });
});

/** As tabelas de cada módulo que o cenário preenche (ao menos uma linha antes). */
const PROVAS: Record<limpeza.CodigoModulo, string[]> = {
  treinamentos: ["treinamento", "turma", "inscricao", "certificado", "participante", "local_treinamento"],
  acidentes: ["acidente_ocorrencia", "acidentado", "acidente_cat_sp", "acidente_link_publico", "acidente_comunicante"],
  epi: ["epi_requisicao", "epi_requisicao_item", "epi_ficha_registro", "epi_entrada_estoque", "epi_movimento_estoque"],
  processos: ["processo", "parecer_tecnico", "laudo_tecnico", "exposicao", "demanda", "demanda_encaminhamento"],
};

describe("cada módulo apaga o seu e mantém os outros", () => {
  it.each(TODOS)("%s", async (modulo) => {
    const m = await montar();
    const antes = await estavel();
    for (const outro of TODOS) for (const t of PROVAS[outro]) expect(antes[t], `${t} antes`).toBeGreaterThan(0);
    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos([modulo], confirmacao()));
    expect(r.status, r.text.replace(/\s+/g, " ").slice(0, 1500)).toBe(200);
    expect(r.text).toContain("Limpeza feita");
    const depois = await estavel();
    // o módulo zerou
    for (const t of limpeza.MODULOS[modulo].apagar) expect(depois[t], t).toBe(0);
    // os outros módulos ficaram inteiros
    for (const outro of TODOS) {
      if (outro === modulo) continue;
      for (const t of limpeza.MODULOS[outro].apagar) {
        if (modulo === "treinamentos" && t === "epi_item_treinamento") continue;
        expect(depois[t], `${t} (de ${outro})`).toBe(antes[t]);
      }
    }
    // cadastros de base ficam sempre
    for (const t of ["servidor", "usuario", "perfil", "campus", "unidade_uorg", "epi_item", "epi_categoria", "certificado_modelo", "portaria_localizacao", "profissional_habilitado"]) {
      expect(depois[t], t).toBe(antes[t]);
    }
    // a trilha ganhou o backup e a limpeza
    expect(depois.historico_evento).toBe(antes.historico_evento! + 2);
    // o arquivo do módulo saiu do armazenamento depois do commit; o dos outros ficou
    const arm = obterArmazenamento();
    for (const outro of TODOS) expect(await arm.existe(m.blobs[outro]), `blob de ${outro}`).toBe(outro !== modulo);
    expect(await arm.existe(m.blob_fica)).toBe(true);
  });

  it("os quatro de uma vez: tudo zera, a leitura de dado sensível fica sem o vínculo", async () => {
    await montar();
    const antes = await estavel();
    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos(TODOS, confirmacao()));
    expect(r.status, r.text.replace(/\s+/g, " ").slice(0, 1500)).toBe(200);
    const depois = await estavel();
    for (const modulo of TODOS) for (const t of limpeza.MODULOS[modulo].apagar) expect(depois[t], t).toBe(0);
    // e-mail e pendência dos módulos saíram
    expect(await db.select().from(e.email_saida).where(eq(e.email_saida.tipo, "CERTIFICADO"))).toHaveLength(0);
    expect(depois.pendencia).toBeLessThan(antes.pendencia!);
    // a leitura de dado sensível fica (quem leu, quando), sem apontar para o que saiu
    const leituras = await db.select().from(e.acesso_dado_sensivel);
    expect(leituras.length).toBe(antes.acesso_dado_sensivel);
    expect(leituras.every((l) => l.acidente_id === null && l.processo_id === null && l.acidentado_id === null)).toBe(true);
    // o modelo de certificado ficou, genérico
    expect((await db.select().from(e.certificado_modelo)).every((x) => x.treinamento_id === null)).toBe(true);
    // a numeração não volta
    expect(depois.certificado_sequencia).toBe(antes.certificado_sequencia);
    // as travas do módulo voltaram ligadas: apagar a ficha de EPI à mão continua proibido
    const ligadas = (await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'`,
    )) as unknown as { n: number }[];
    expect(ligadas[0]!.n).toBe(0);
  });
});

describe("o grafo de chaves", () => {
  it("recusa, sem gravar, se uma tabela fora da lista referencia o que sai", async () => {
    await montar();
    const intruso = postgres(amb.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await intruso.unsafe(`CREATE TABLE intruso (id int PRIMARY KEY, ocorrencia_id int REFERENCES acidente_ocorrencia(id))`);
      const [o] = await intruso`SELECT id FROM acidente_ocorrencia LIMIT 1`;
      await intruso`INSERT INTO intruso VALUES (1, ${o!.id})`;
      const antes = await estavel();
      const c = await admin();
      const s = await c.post(`${CAMINHO}/simular`, campos(["acidentes"]));
      expect(s.text).toContain("intruso.ocorrencia_id");
      expect(s.text).not.toContain('action="/config/limpar-dados/executar"');
      const r = await c.post(`${CAMINHO}/executar`, campos(["acidentes"], confirmacao()));
      expect(r.status).toBe(409);
      expect(r.text).toContain("intruso.ocorrencia_id");
      const depois = await estavel();
      delete antes.usuario;
      delete depois.usuario;
      expect(depois).toEqual(antes);
    } finally {
      await intruso.unsafe(`DROP TABLE IF EXISTS intruso`);
      await intruso.end({ timeout: 5 });
    }
  });

  it("recusa gatilho de DELETE fora das travas do módulo", async () => {
    const adm = postgres(amb.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await adm.unsafe(`
        CREATE FUNCTION trava_limpeza() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trava'; END $$;
        CREATE TRIGGER trg_trava_limpeza BEFORE DELETE ON demanda FOR EACH ROW EXECUTE FUNCTION trava_limpeza();`);
      const a = await naTransacao((tx) => limpeza.analisar(tx, limpeza.plano_dos_modulos(["processos"])));
      expect(a.problemas.join("\n")).toContain("trg_trava_limpeza");
    } finally {
      await adm.unsafe(`DROP TRIGGER IF EXISTS trg_trava_limpeza ON demanda; DROP FUNCTION IF EXISTS trava_limpeza()`);
      await adm.end({ timeout: 5 });
    }
  });

  it("a trava da trilha e a da marca de produção nunca entram no plano", async () => {
    const plano = { ...limpeza.plano_dos_modulos(["epi"]), travas: ["trg_historico_sem_delete"] };
    const a = await naTransacao((tx) => limpeza.analisar(tx, plano));
    expect(a.problemas.join("\n")).toContain("trg_historico_sem_delete");
  });

  it("os quatro planos fecham com o banco de hoje (sem problema no grafo)", async () => {
    await montar();
    for (const m of TODOS) {
      const a = await naTransacao((tx) => limpeza.analisar(tx, limpeza.plano_dos_modulos([m])));
      expect(a.problemas, m).toEqual([]);
    }
  });
});

describe("apagar também servidores e contas", () => {
  it("preserva o executor, as contas de governo e a que concede perfil; o resto sai", async () => {
    await montar();
    // o executor ligado a um servidor (o servidor dele fica)
    const [meu] = await db.insert(e.servidor).values({ siape: "9990001", nome: "Servidor do Administrador" }).returning();
    await db.update(e.usuario).set({ servidor_id: meu!.id }).where(eq(e.usuario.login, "administrador_sistema"));
    // um perfil próprio que concede perfil, numa conta comum
    const [perfil] = await db.insert(e.perfil).values({ codigo: "concede_teste", nome: "Concede" }).returning();
    const [perm] = await db.select().from(e.permissao).where(eq(e.permissao.codigo, "perfil.conceder"));
    await db.insert(e.perfil_permissao).values({ perfil_id: perfil!.id, permissao_id: perm!.id });
    await criarUsuario(db, { login: "governo_extra", perfis: ["concede_teste"] });

    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos(TODOS, confirmacao(), true));
    expect(r.status, r.text.replace(/\s+/g, " ").slice(0, 1500)).toBe(200);

    const logins = (await db.select().from(e.usuario)).map((u) => u.login).sort();
    expect(logins).toEqual(["administrador_sistema", "governo_extra", "superintendente"]);
    const servidores = await db.select().from(e.servidor);
    expect(servidores.map((s) => s.id)).toEqual([meu!.id]);
    expect(await db.select().from(e.pedido_conta)).toHaveLength(0);
    // o governo continua: há quem conceda perfil, e o executor segue logado
    expect((await naTransacao((tx) => governanca.contas_que_concedem(tx))).length).toBeGreaterThan(0);
    expect((await c.get(CAMINHO)).status).toBe(200);
    // as atribuições que ficam são só das contas que ficam
    const ids = (await db.select().from(e.usuario)).map((u) => u.id);
    const atrib = await db.select().from(e.atribuicao);
    expect(atrib.every((a) => ids.includes(a.usuario_id))).toBe(true);
    // a trilha guarda os eventos antigos das contas que saíram, e continua íntegra
    expect(await naTransacao((tx) => auditoria.cadeia_integra(tx))).toEqual([true, null]);
  });
});

describe("o backup antes", () => {
  it("é feito antes e leva o que saiu", async () => {
    await montar();
    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos(["acidentes"], confirmacao()));
    expect(r.status).toBe(200);
    const chave = /<code class="mono">(backups\/[^<]+\.enc)<\/code>/.exec(r.text)?.[1];
    expect(chave, "a tela diz onde o backup ficou").toBeTruthy();
    const pacote = backup.restaurar(await obterArmazenamento().ler(chave!));
    const ocorrencias = JSON.parse(pacote.banco!.get("acidente_ocorrencia")!) as unknown[];
    expect(ocorrencias.length).toBeGreaterThan(0);
    expect(await eventos("BACKUP_EXECUTADO")).toHaveLength(1);
  });

  it("falha do backup impede a limpeza", async () => {
    await montar();
    const antes = await estavel();
    delete antes.usuario;
    const real = obterArmazenamento();
    const quebrado: Armazenamento = {
      ...real,
      gravar: async (chave, bytes, tipo) => {
        if (chave.startsWith("backups/")) throw new Error("Storage fora do ar");
        return real.gravar(chave, bytes, tipo);
      },
      ler: real.ler.bind(real),
      existe: real.existe.bind(real),
      remover: real.remover.bind(real),
      listar: real.listar.bind(real),
    };
    definirArmazenamento(quebrado);
    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos(["acidentes"], confirmacao()));
    expect(r.status).toBe(409);
    expect(r.text).toContain("O backup não terminou bem");
    const depois = await estavel();
    delete depois.usuario;
    expect(depois).toEqual(antes);
    expect(await eventos(auditoria.DADOS_DE_TESTE_APAGADOS)).toHaveLength(0);
  });

  it("sem armazenamento persistente, recusa com a mensagem clara", async () => {
    await montar();
    const antes = await estavel();
    delete antes.usuario;
    process.env.NETLIFY = "true";
    try {
      const c = await admin();
      expect((await c.get(CAMINHO)).text).toContain("Backup indisponível neste ambiente");
      const r = await c.post(`${CAMINHO}/executar`, campos(["epi"], confirmacao()));
      expect(r.status).toBe(409);
      expect(r.text).toContain("Backup indisponível");
    } finally {
      delete process.env.NETLIFY;
    }
    const depois = await estavel();
    delete depois.usuario;
    expect(depois).toEqual(antes);
  });
});

describe("a trilha e a idempotência", () => {
  it("um evento por limpeza, com contagens, quem fez e sem dado pessoal; de novo, nada a apagar", async () => {
    await montar();
    const c = await admin();
    const r = await c.post(`${CAMINHO}/executar`, campos(TODOS, confirmacao()));
    expect(r.status).toBe(200);
    const evs = await eventos(auditoria.DADOS_DE_TESTE_APAGADOS);
    expect(evs).toHaveLength(1);
    const [admin_conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "administrador_sistema"));
    expect(evs[0]!.usuario_id).toBe(admin_conta!.id);
    expect(evs[0]!.descricao).toMatch(/acidente_ocorrencia=1/);
    expect(evs[0]!.descricao).toContain("backups/");
    expect(evs[0]!.descricao).not.toMatch(/Marco|Joana|Fulano|Titular|Testemunha|@|\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(auditoria.rotulo_evento(auditoria.DADOS_DE_TESTE_APAGADOS)).toContain("apagados");
    expect(await naTransacao((tx) => auditoria.cadeia_integra(tx))).toEqual([true, null]);

    // idempotente: tudo vazio não quebra, não faz backup nem grava evento
    const trilha = (await tudo()).historico_evento;
    const s = await c.post(`${CAMINHO}/simular`, campos(TODOS));
    expect(s.status).toBe(200);
    expect(s.text).toContain("Nada a apagar");
    expect(s.text).not.toContain('action="/config/limpar-dados/executar"');
    const x = await c.post(`${CAMINHO}/executar`, campos(TODOS, confirmacao()));
    expect(x.status).toBe(200);
    expect(x.text).toContain("Nada a apagar");
    expect((await tudo()).historico_evento).toBe(trilha);
    expect(await eventos("BACKUP_EXECUTADO")).toHaveLength(1);
  });
});
