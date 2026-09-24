/**
 * A busca que atravessa o sistema — e o que ela recusa a atravessar.
 * Porte de `testes/integracao/test_busca_global.py` (e dos dois testes da busca
 * global em `test_modulos.py`).
 *
 * Estes testes cobram as duas metades do conserto: que ela agora ache, e que
 * achar não tenha virado uma janela nova para o lado de dentro.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as servico from "../src/servicos/busca.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";

const NOME = "Marco Antônio Alves Schetino";
const SIAPE = "1110654";
const NUP = "23086.000777/2026-11";
const LAUDO = "26255-000.125/2019";

// o primeiro `bancoLimpo()` na coleta registra a limpeza do arquivo
await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
async function como(amb: Amb, perfil: string): Promise<Cliente> {
  return entrar(amb.novoCliente(), amb.contas[perfil]![0]);
}

function _usuario(...permissoes: string[]): UsuarioAtual {
  return new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes, perfis: [] });
}

/** O caso que deu nome à queixa: cadastrado, e sem processo nenhum. */
async function servidor_sem_processo(amb: Amb): Promise<number> {
  const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
  const [registro] = await amb.db
    .insert(e.servidor)
    .values({ siape: SIAPE, nome: NOME, cargo_id: cargo!.id, unidade_uorg_id: famed!.id })
    .returning();
  return registro!.id;
}

async function processo_e_laudo(amb: Amb): Promise<number> {
  const servidor_id = await servidor_sem_processo(amb);
  const [etapa] = await amb.db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "A_FAZER"));
  const [tipo] = await amb.db.select().from(e.tipo_processo).orderBy(asc(e.tipo_processo.id)).limit(1);
  const [famed] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250"));
  const [insalubridade] = await amb.db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
  await amb.db.insert(e.processo).values({
    nup: NUP,
    tipo_processo_id: tipo!.id,
    etapa_id: etapa!.id,
    estado_tecnico: "EM_TRIAGEM",
    servidor_id,
    data_autuacao: "2026-01-05",
    ano_referencia: 2026,
  });
  await amb.db.insert(e.laudo_tecnico).values({
    numero_siape: LAUDO,
    ano: 2019,
    tipo_adicional_id: insalubridade!.id,
    unidade_uorg_id: famed!.id,
    data_emissao: "2019-06-01",
  });
  return servidor_id;
}

/** Só o `<main>`: a lateral e a trilha têm invariante próprio. */
function _corpo_principal(html: string): string {
  const achado = /<main class="conteudo[\s\S]*?<\/main>/.exec(html);
  return achado ? achado[0] : "";
}

// =====================================================================
// O conserto: achar o que a busca velha não achava
// =====================================================================
describe("achar", () => {
  it("acha servidor que não tem processo", async () => {
    const amb = await novo();
    const id = await servidor_sem_processo(amb);
    const c = await como(amb, "coordenador_csso");
    const corpo = _corpo_principal((await c.get("/buscar?q=Marco")).text);
    expect(corpo).toContain(NOME);
    expect(corpo).toContain(`href="/servidores/${id}"`);
  });

  it("acha por SIAPE, NUP e número de laudo", async () => {
    const amb = await novo();
    await processo_e_laudo(amb);
    const c = await como(amb, "coordenador_csso");
    expect(_corpo_principal((await c.get(`/buscar?q=${SIAPE}`)).text)).toContain(NOME);
    expect(_corpo_principal((await c.get(`/buscar?q=${encodeURIComponent(NUP)}`)).text)).toContain(NUP);
    expect(_corpo_principal((await c.get(`/buscar?q=${encodeURIComponent(LAUDO)}`)).text)).toContain(LAUDO);
  });

  it("o almoxarife acha a pessoa e cai na ficha dele", async () => {
    const amb = await novo();
    const id = await servidor_sem_processo(amb);
    const c = await como(amb, "almoxarife_sesmt");
    const corpo = _corpo_principal((await c.get("/buscar?q=Marco")).text);
    expect(corpo).toContain(NOME);
    expect(corpo).toContain(`href="/epis/fichas/${id}"`);
    expect(corpo).not.toContain(`href="/servidores/${id}"`);
  });
});

// =====================================================================
// RN-19 — a busca é o lugar clássico do vazamento
// =====================================================================
describe("RN-19", () => {
  it("nome não casa para quem não pode ler aquele nome", async () => {
    const amb = await novo();
    await servidor_sem_processo(amb);
    const c = await como(amb, "secretaria_csso");
    const corpo = _corpo_principal((await c.get("/buscar?q=Marco")).text);
    expect(corpo).not.toContain(NOME);
    expect(corpo.match(/SRV-[0-9a-f]{4}\b/g), "a busca global devolveu linha para quem não vê o nome").toBeNull();
    expect(corpo).toContain("Nada encontrado");
  });

  it("SIAPE continua achando com a identificação suprimida", async () => {
    const amb = await novo();
    await servidor_sem_processo(amb);
    const c = await como(amb, "secretaria_csso");
    const corpo = _corpo_principal((await c.get(`/buscar?q=${SIAPE}`)).text);
    expect(corpo.match(/SRV-[0-9a-f]{4}\b/g), "o SIAPE tem de achar a linha").not.toBeNull();
    expect(corpo).not.toContain(NOME);
  });

  it("o titular acha o próprio nome (LGPD art. 18, II)", async () => {
    const amb = await novo();
    const id = await servidor_sem_processo(amb);
    await amb.db.update(e.usuario).set({ servidor_id: id }).where(eq(e.usuario.login, "servidor_consulta"));
    const c = await como(amb, "servidor_consulta");
    expect(_corpo_principal((await c.get("/buscar?q=Marco")).text)).toContain(NOME);
  });

  it("a busca não aceita CPF", async () => {
    const amb = await novo();
    await servidor_sem_processo(amb);
    const c = await como(amb, "coordenador_csso");
    const corpo = (await c.get("/buscar?q=123.456.789-09")).text;
    expect(corpo).toContain("não aceita CPF");
    expect(corpo).not.toContain("Nada encontrado");
  });

  it("a busca não grava acesso a dado sensível — a porta grava", async () => {
    const amb = await novo();
    const id = await servidor_sem_processo(amb);
    const c = await como(amb, "coordenador_csso");
    expect((await c.get("/buscar?q=Marco")).status).toBe(200);
    const acessos = () => amb.db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.servidor_id, id));
    expect(await acessos()).toEqual([]);
    await c.get(`/servidores/${id}`);
    expect((await acessos()).length).toBeGreaterThan(0);
  });
});

// =====================================================================
// O vazio útil, e o que ele não pode contar
// =====================================================================
describe("o vazio", () => {
  it("diz onde procurou e não o que escondeu", async () => {
    const amb = await novo();
    const c = await como(amb, "almoxarife_sesmt");
    const corpo = _corpo_principal((await c.get("/buscar?q=zzzznadaaqui")).text);
    expect(corpo).toContain("Nada encontrado");
    expect(corpo).toContain("servidores");
    expect(corpo).toContain("requisições de EPI");
    for (const escondido of ["processos", "laudos", "turmas", "certificados"]) {
      expect(corpo, `o vazio revelou o bloco ${escondido}`).not.toContain(escondido);
    }
  });

  it("cobertura é a mesma lista que guarda os blocos", () => {
    expect(new Set(Object.keys(servico.PERMISSOES_POR_BLOCO))).toEqual(new Set(Object.keys(servico.ROTULO_POR_BLOCO)));
    expect(servico.cobertura(_usuario("epi.ver", "epi.ficha"))).toEqual(["servidores", "requisições de EPI"]);
    expect(servico.cobertura(_usuario("backup.executar", "auditoria.ver"))).toEqual([]);
    expect(servico.pode_buscar(_usuario("backup.executar"))).toBe(false);
    expect(servico.pode_buscar(_usuario("certificado.ver"))).toBe(true);
  });
});

// =====================================================================
// A caixa do cabeçalho (os dois de `test_modulos.py`)
// =====================================================================
describe("a caixa do cabeçalho", () => {
  it("a busca global atravessa o sistema — e o almoxarife tem Ctrl+K", async () => {
    const amb = await novo();
    let c = await como(amb, "coordenador_csso");
    let corpo = (await c.get("/processos")).text;
    expect(corpo).toContain('action="/buscar"');
    expect(corpo).toContain('id="busca-global"');

    c = await como(amb, "almoxarife_sesmt");
    corpo = (await c.get("/epis")).text;
    expect((await c.get("/processos")).status).toBe(403);
    expect(corpo, "o almoxarife voltou a ficar sem Ctrl+K").toContain('action="/buscar"');
    expect((await c.get("/buscar")).status).toBe(200);
  });

  it("a caixa some para quem não abre bloco nenhum; a rota abre e explica", async () => {
    const amb = await novo();
    const c = await como(amb, "admin_ti");
    expect((await c.get("/relatorios")).text).not.toContain('id="busca-global"');
    const resposta = await c.get("/buscar");
    expect(resposta.status).toBe(200);
    expect(resposta.text).toContain("Não há o que buscar");
  });

  it("a busca vazia diz o que cobre, e o termo fica na caixa", async () => {
    const amb = await novo();
    const c = await como(amb, "coordenador_csso");
    expect((await c.get("/buscar")).text).toContain("Digite o que você está procurando");
    expect((await c.get("/buscar?q=%20zzz%20")).text).toContain('value="zzz"');
  });

  it("sem sessão, o login", async () => {
    const amb = await novo();
    const r = await amb.novoCliente().get("/buscar?q=Marco", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });
});

// =====================================================================
// O invariante: link que a busca oferece é link que abre
// =====================================================================
describe("todo link da busca abre", () => {
  it.each(["coordenador_csso", "secretaria_csso", "almoxarife_sesmt", "auditor_interno", "consulta_progep"])(
    "%s",
    async (perfil) => {
      const amb = await novo();
      await processo_e_laudo(amb);
      const c = await como(amb, perfil);
      for (const termo of ["Marco", SIAPE, NUP, LAUDO]) {
        const resposta = await c.get(`/buscar?q=${encodeURIComponent(termo)}`);
        expect(resposta.status, termo).toBe(200);
        for (const [, destino] of _corpo_principal(resposta.text).matchAll(/href="(\/[^"]*)"/g)) {
          const alvo = destino!.replace(/&amp;/g, "&");
          expect(
            (await c.get(alvo)).status,
            `${perfil} buscou ${termo} e recebeu um link para ${alvo}, que devolve 403`,
          ).not.toBe(403);
        }
      }
    },
    60_000,
  );
});
