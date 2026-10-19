/**
 * RN-19 por varredura: quem não tem `exposicao.ver` nem `epi.ficha` não recebe
 * nome nem SIAPE de servidor em saída NENHUMA — tela, fragmento HTMX, `/api/v1`,
 * `/buscar`, exportação (CSV/XLSX/ZIP), documento gerado, trilha exibida,
 * mensagem de erro, título, atributo.
 *
 * Os testes de privacidade de cada módulo conferem a tela que o módulo conhece.
 * Este confere o que ninguém lembrou de conferir: povoa o ambiente de teste
 * inteiro, deixa o coordenador (que vê tudo) andar pelo sistema seguindo todo
 * link e todo `hx-get`, e depois repete CADA endereço achado — mais cada rota
 * GET registrada no app, com os ids do banco — com as contas sem permissão
 * nominal, procurando nos bytes da resposta os nomes e as matrículas do
 * ambiente. Arquivo compactado (xlsx, docx, zip) é aberto e lido por dentro.
 *
 * As contas sem permissão nominal:
 *  - `secretaria` (secretaria_csso) e `admin` (admin_ti), do ambiente de teste;
 *  - `servidor` (servidor_consulta), que é a Adelaide — o nome e o SIAPE DELA
 *    podem aparecer (LGPD art. 18, II); os dos outros, não;
 *  - `sem_nominal`: um perfil sintético com TODA permissão do sistema menos as
 *    duas nominais — o pior caso que a matriz permitiria montar.
 */
import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import PizZip from "pizzip";
import * as e from "../src/db/esquema/index.js";
import { PERMISSOES } from "../src/servicos/rbac.js";
import { CONTAS, SENHA, SERVIDORES, povoar } from "../ferramentas/ambiente-teste.js";
import { bancoLimpo, naTransacao, type AmbienteDeTeste, type Cliente } from "./ajuda";

const NOMINAIS = new Set(["exposicao.ver", "epi.ficha"]);
const TITULAR_DA_CONTA_SERVIDOR = "3010011"; // Adelaide Nunes Prata

let amb: AmbienteDeTeste;

// ---------------------------------------------------------------------
// Leitura dos bytes da resposta (texto, ou o que há dentro do zip)
// ---------------------------------------------------------------------
function textoDeZip(bytes: Uint8Array): string {
  const zip = new PizZip(bytes);
  const partes: string[] = [];
  for (const nome of Object.keys(zip.files)) {
    const f = zip.files[nome]!;
    if (f.dir) continue;
    const bruto = f.asUint8Array();
    if (bruto[0] === 0x50 && bruto[1] === 0x4b) {
      partes.push(textoDeZip(bruto)); // xlsx dentro do zip de exportação
      continue;
    }
    const t = new TextDecoder().decode(bruto);
    // O Word parte uma palavra em vários <w:t>: sem as marcas, o texto se junta.
    partes.push(nome, t.replace(/<[^>]+>/g, ""));
  }
  return partes.join("\n");
}

interface Lido {
  status: number;
  tipo: string;
  texto: string;
  location: string | null;
}

async function ler(cliente: Cliente, caminho: string, metodo = "GET", corpo?: string): Promise<Lido> {
  const cab = new Headers();
  const cookie = [...cliente.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  if (cookie) cab.set("cookie", cookie);
  if (corpo !== undefined) {
    cab.set("content-type", "application/x-www-form-urlencoded");
    cab.set("origin", cliente.origem);
  }
  const res = await amb.app.fetch(
    new Request(new URL(caminho, cliente.origem), { method: metodo, headers: cab, body: corpo ?? null }),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tipo = res.headers.get("content-type") ?? "";
  let texto: string;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) texto = textoDeZip(bytes);
  else texto = new TextDecoder().decode(bytes);
  // Cabeçalho também é saída: `content-disposition` leva nome de arquivo.
  const cabecalhos = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  return { status: res.status, tipo, texto: `${cabecalhos}\n${texto}`, location: res.headers.get("location") };
}

// ---------------------------------------------------------------------
// Descoberta dos endereços
// ---------------------------------------------------------------------
const NUNCA = [/^\/sair\b/, /^\/login\b/, /^\/estaticos\//, /^\/primeiro-acesso/, /^\/trocar-senha/];

function enderecosNoHtml(html: string): string[] {
  const achados: string[] = [];
  for (const m of html.matchAll(/(?:href|hx-get|action)="([^"#]+)"/g)) {
    let alvo = m[1]!.replaceAll("&amp;", "&");
    if (!alvo.startsWith("/") || alvo.startsWith("//")) continue;
    if (NUNCA.some((re) => re.test(alvo))) continue;
    // `action` é de formulário: só vale o de busca (GET), que não tem método
    if (m[0].startsWith("action") && !/method="get"/i.test(html)) continue;
    achados.push(alvo);
  }
  return achados;
}

async function andarComo(cliente: Cliente, sementes: string[], teto = 900): Promise<Set<string>> {
  const vistos = new Set<string>();
  const fila = [...sementes];
  while (fila.length && vistos.size < teto) {
    const alvo = fila.shift()!;
    if (vistos.has(alvo)) continue;
    vistos.add(alvo);
    const r = await ler(cliente, alvo);
    if (!r.tipo.includes("text/html")) continue;
    for (const proximo of enderecosNoHtml(r.texto)) if (!vistos.has(proximo)) fila.push(proximo);
  }
  return vistos;
}

/** Cada rota GET do app, com os parâmetros trocados pelos ids que existem. */
async function rotasComIds(): Promise<string[]> {
  const db = amb.db;
  const ids = async (t: any, col = "id") =>
    (await db.select().from(t)).map((l: any) => String(l[col])).slice(0, 25);
  const por: Record<string, string[]> = {
    processo_id: await ids(e.processo),
    anexo_id: await ids(e.anexo),
    parecer_id: await ids(e.parecer_tecnico),
    laudo_id: await ids(e.laudo_tecnico),
    modelo_id: await ids(e.certificado_modelo),
    turma_id: await ids(e.turma),
    certificado_id: await ids(e.certificado),
    registro_id: await ids(e.epi_ficha_registro),
    servidor_id: await ids(e.servidor),
    entrada_id: await ids(e.epi_entrada_estoque),
    requisicao_id: await ids(e.epi_requisicao),
    item_id: await ids(e.epi_item),
    chave: await ids(e.certificado, "chave_validacao"),
    nome: ["cargo", "posto_trabalho", "unidade_uorg", "agente_nocivo", "texto_padrao", "setor_emissor"],
  };
  const saida: string[] = [];
  for (const r of amb.app.routes) {
    if (r.method !== "GET" || r.path.includes("*")) continue;
    if (NUNCA.some((re) => re.test(r.path))) continue;
    const params = [...r.path.matchAll(/:([a-z_]+)(\{[^}]*\})?/g)];
    if (!params.length) {
      saida.push(r.path);
      continue;
    }
    const p = params[0]!;
    let lista = por[p[1]!];
    if (p[1] === "id") lista = r.path.startsWith("/demandas") ? await ids(e.demanda) : por.servidor_id;
    for (const v of lista ?? []) saida.push(r.path.replace(p[0], v));
  }
  return saida;
}

// ---------------------------------------------------------------------
// O que não pode aparecer
// ---------------------------------------------------------------------
function proibidos(exceto_siape: string | null): { rotulo: string; re: RegExp }[] {
  const lista: { rotulo: string; re: RegExp }[] = [];
  for (const [siape, nome] of SERVIDORES) {
    if (siape === exceto_siape) continue;
    lista.push({ rotulo: `SIAPE ${siape}`, re: new RegExp(`(?<![0-9])${siape}(?![0-9])`) });
    lista.push({ rotulo: nome, re: new RegExp(nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
    // nome de arquivo leva o nome sem acento e com `_` (slug_ascii)
    const slug = nome.normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^A-Za-z0-9]+/g, "_");
    lista.push({ rotulo: `${nome} (slug)`, re: new RegExp(slug, "i") });
  }
  return lista;
}

/**
 * As saídas nominais DELIBERADAS, cada uma com o porquê. Tudo o que não está
 * aqui é vazamento. Acrescentar linha aqui é decisão de privacidade, não
 * conserto de teste: diga o motivo, e prefira a regra estreita (conta + rota +
 * contexto) à larga.
 */
const INSTRUTOR = "Hamilton Peçanha Cordeiro"; // servidor do ambiente que é instrutor das turmas
const DELIBERADAS: { motivo: string; contas?: string[]; rota: RegExp; rotulo?: RegExp; contexto?: RegExp }[] = [
  {
    motivo:
      "instrutor é quem assina o certificado: o nome sai no cartaz da turma, no " +
      "papel e na validação pública (ROPA §0.5) — é o ator, não o titular",
    rota: /^\/(turmas|validar|certificados|treinamentos\/(catalogo|assinaturas))\b/,
    rotulo: new RegExp(`^${INSTRUTOR}`),
  },
  {
    motivo:
      "abas nominais da turma (inscritos, presença, emissão, lista de presença, " +
      "grade da API): exigem certificado.ver, turma.inscrever ou turma.avaliar — " +
      "PERMISSOES_DAS_ABAS_NOMINAIS do Python; quem lança presença precisa do nome",
    contas: ["secretaria", "sem_nominal"],
    rota: /^\/(turmas\/\d+(\?aba=(inscricoes|presencas|emissao)|\/lista-presenca)|api\/v1\/turmas\/\d+\/presencas)/,
  },
  {
    motivo:
      "certificado.ver é, por definição (rbac.PERMISSOES), 'ver certificado nominal' " +
      "— e o PDF (um ou o lote da turma) é o mesmo documento que o .docx",
    contas: ["secretaria", "sem_nominal"],
    rota: /^\/(certificados(\/\d+(\/(documento|pdf))?)?|turmas\/\d+\/certificados\.pdf)(\?|$)/,
  },
  {
    motivo:
      "o .docx/.pdf do parecer é o documento oficial nominal que vai ao SEI; o " +
      "Python o entrega a parecer.ver e grava acesso_dado_sensivel " +
      "(campo parecer_tecnico.documento) a cada via",
    contas: ["secretaria", "sem_nominal"],
    rota: /^\/pareceres\/\d+\/(docx|pdf)$/,
  },
  {
    motivo:
      "nome de CONTA (quem opera o sistema), não de titular: a gestão de contas, " +
      "o filtro por usuário da trilha e o filtro por responsável. A conta " +
      "`servidor` é da Adelaide; ver DESVIOS 'Produção — privacidade' (recomendação)",
    rota: /^\/(usuarios|auditoria|processos|kanban)\b/,
    rotulo: /^Adelaide Nunes Prata$/,
    contexto: /<option value="\d+"\s*>Adelaide Nunes Prata<\/option>/,
  },
  {
    motivo: "a gestão de contas (usuario.criar_conta) mostra o nome de cada conta",
    contas: ["admin", "sem_nominal"],
    rota: /^\/usuarios\b/,
    rotulo: /^Adelaide Nunes Prata$/,
  },
  {
    motivo:
      "a coluna 'Usuário' da trilha é quem agiu (LGPD art. 37: registro das " +
      "operações, que é para o que auditoria.ver existe); a descrição e o " +
      "'antes → depois' nominais continuam suprimidos",
    contas: ["admin", "sem_nominal"],
    rota: /^\/auditoria\b/,
    rotulo: /^Adelaide Nunes Prata$/,
    contexto: /<td>Adelaide Nunes Prata<\/td>/,
  },
];

function deliberada(conta: string, url: string, rotulo: string, entorno: string): boolean {
  return DELIBERADAS.some(
    (d) =>
      (!d.contas || d.contas.includes(conta)) &&
      d.rota.test(url) &&
      (!d.rotulo || d.rotulo.test(rotulo)) &&
      (!d.contexto || d.contexto.test(entorno)),
  );
}

/** O termo que a própria conta digitou volta no campo de busca: eco não é vazamento. */
function semEco(url: string, texto: string): string {
  const q = new URL(url, "http://x").searchParams.get("q");
  if (!q) return texto;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return texto.replace(new RegExp(`(value="|q=|“)${esc}`, "g"), "$1«eco»");
}

function vazamentos(conta: string, url: string, r: Lido, regras: { rotulo: string; re: RegExp }[]): string[] {
  const achados: string[] = [];
  const texto = semEco(url, r.texto);
  for (const { rotulo, re } of regras) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of texto.matchAll(global)) {
      const i = m.index!;
      const entorno = texto.slice(Math.max(0, i - 200), i + 200);
      if (deliberada(conta, url, rotulo, entorno)) continue;
      const trecho = texto.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, " ");
      achados.push(`${conta} GET ${url} [${r.status}] → ${rotulo} …${trecho}…`);
      break;
    }
  }
  return achados;
}

async function entrarComo(login: string, senha = SENHA): Promise<Cliente> {
  const c = amb.novoCliente();
  const r = await c.post("/login", { login, senha }, { seguir: false });
  if (r.status !== 303) throw new Error(`login de ${login}: ${r.status}`);
  return c;
}

let enderecos: string[] = [];

beforeAll(async () => {
  amb = await bancoLimpo();
  await naTransacao((tx) => povoar(tx));

  // O perfil sintético: tudo menos o que dá o nome.
  const db = amb.db;
  const [pf] = await db
    .insert(e.perfil)
    .values({ codigo: "sem_nominal", nome: "Tudo menos nominal (teste)", base_normativa: "teste" })
    .returning();
  const todas = await db.select().from(e.permissao);
  for (const p of todas) {
    if (NOMINAIS.has(p.codigo)) continue;
    await db.insert(e.perfil_permissao).values({ perfil_id: pf!.id, permissao_id: p.id });
  }
  const [modelo] = await db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria"));
  const [conta] = await db
    .insert(e.usuario)
    .values({
      login: "sem_nominal",
      nome: "Conta Sem Nominal",
      email: "sem_nominal@csso.teste",
      senha_hash: modelo!.senha_hash,
      precisa_trocar_senha: false,
    })
    .returning();
  await db.insert(e.atribuicao).values({
    usuario_id: conta!.id,
    perfil_id: pf!.id,
    vigencia_inicio: "2020-01-01",
    ato_normativo: "teste",
  });
  expect(Object.keys(PERMISSOES).length).toBeGreaterThan(10);

  // O coordenador anda pelo sistema inteiro; as rotas registradas completam.
  const coord = await entrarComo("coordenador");
  const andados = await andarComo(coord, ["/inicio", "/modulos", "/processos", "/epis", "/turmas", "/demandas"]);
  const buscas = [
    "/buscar?q=Bruno",
    "/buscar?q=3010022",
    "/buscar?q=Sacramento",
    "/servidores?q=Bruno",
    "/servidores?q=3010022",
    "/epis/entregas/servidores?q=Bruno",
    "/epis/entregas/servidores?q=3010022",
    "/epis/requisicoes/servidores?q=Bruno",
    "/epis/requisicoes/servidores?q=3010022",
    "/epis/requisicoes?q=Bruno",
    "/epis/requisicoes?q=3010022",
    "/api/v1/epis/servidores?q=Bruno",
    "/api/v1/epis/servidores?q=3010022",
    "/processos?q=Bruno",
    "/processos?q=3010022",
    "/demandas?q=Bruno",
    "/auditoria?q=Bruno",
  ];
  enderecos = [...new Set([...andados, ...(await rotasComIds()), ...buscas])].sort();
}, 600_000);

describe("RN-19 em todas as saídas", () => {
  it("o coordenador achou o sistema (a varredura não é vazia) e a régua acha nome", async () => {
    expect(enderecos.length).toBeGreaterThan(150);
    // controle positivo: a mesma leitura, com quem PODE ver, acha o nome — sem
    // isto um erro de decodificação passaria o teste inteiro em branco
    const coord = await entrarComo("coordenador");
    const r = await ler(coord, "/servidores");
    expect(vazamentos("coordenador", "/servidores", r, proibidos(null)).length).toBeGreaterThan(5);
    const docx = await ler(coord, "/pareceres/1/docx");
    expect(vazamentos("coordenador", "/pareceres/1/docx", docx, proibidos(null)).length).toBeGreaterThan(0);
  });

  for (const [conta, exceto] of [
    ["secretaria", null],
    ["admin", null],
    ["servidor", TITULAR_DA_CONTA_SERVIDOR],
    ["sem_nominal", null],
  ] as const) {
    it(`${conta}: nenhum nome nem SIAPE de terceiro em GET`, async () => {
      expect(CONTAS.some(([l]) => l === conta) || conta === "sem_nominal").toBe(true);
      const cliente = await entrarComo(conta);
      const regras = proibidos(exceto);
      const achados: string[] = [];
      for (const url of enderecos) {
        const r = await ler(cliente, url);
        achados.push(...vazamentos(conta, url, r, regras));
      }
      if (process.env.VARREDURA_SAIDA) appendFileSync(process.env.VARREDURA_SAIDA, achados.join("\n") + "\n");
      expect(achados, achados.slice(0, 40).join("\n")).toEqual([]);
    }, 600_000);
  }

  it("o ambiente inteiro povoado não guarda CPF em coluna nenhuma (ferramentas/procurar-cpf.ts)", async () => {
    const postgres = (await import("postgres")).default;
    const { procurar_cpf } = await import("../ferramentas/procurar-cpf.js");
    const sql = postgres(amb.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await procurar_cpf(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("exportações por POST também não levam nome para quem não vê nome", async () => {
    const cliente = await entrarComo("sem_nominal");
    const regras = proibidos(null);
    const achados: string[] = [];
    for (const url of ["/config/exportar-tudo"]) {
      const r = await ler(cliente, url, "POST", "");
      expect(r.status, url).toBe(403);
      expect(r.texto, url).toContain("exposicao.ver");
      achados.push(...vazamentos("sem_nominal", `POST ${url}`, r, regras));
    }
    expect(achados, achados.slice(0, 20).join("\n")).toEqual([]);
  }, 120_000);
});
