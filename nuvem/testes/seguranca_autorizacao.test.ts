/**
 * Revisão de segurança para a produção — autorização e login:
 * escopo e RN-14 nas escritas do parecer, troca obrigatória de senha em toda
 * rota, senha provisória fora da URL, exportação completa restrita, teto de
 * falhas por endereço, bloqueio por conta sem corrida e o download do Trello
 * preso aos hosts do Trello. Ver DESVIOS.md, "Produção — segurança".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { obterConfig } from "../src/config.js";
import * as servico from "../src/servicos/parecer.js";
import * as trello from "../src/servicos/importacao_trello.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, SENHA_TESTE, type AmbienteDeTeste } from "./ajuda";
import { atores, cenario, parecerDe } from "./ajuda_processos";

let amb: AmbienteDeTeste;
let db: Banco;

await bancoLimpo();

beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  await contas(db);
});

async function parecer_emitido(): Promise<number> {
  return naTransacao(async (tx) => {
    const a = await atores(tx);
    const c = await cenario(tx);
    const p = await parecerDe(tx, c.parecer_id);
    await servico.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
    return p.id;
  });
}

describe("escritas do parecer: RN-14 e escopo", () => {
  it("excluir exposição de parecer emitido não apaga nada", async () => {
    const id = await parecer_emitido();
    const antes = await db.select().from(e.exposicao).where(eq(e.exposicao.parecer_id, id));
    expect(antes.length).toBeGreaterThan(0);
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/pareceres/${id}/exposicoes/${antes[0]!.id}/excluir`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const depois = await db.select().from(e.exposicao).where(eq(e.exposicao.parecer_id, id));
    expect(depois).toHaveLength(antes.length);
  });

  it("trocar a portaria de parecer emitido é recusado", async () => {
    const id = await parecer_emitido();
    const [antes] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    const [unidade] = await db.select().from(e.unidade_uorg).limit(1);
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post(`/pareceres/${id}/portaria`, {
      texto_original: "PORTARIA/FAMED Nº 99, DE 17 DE SETEMBRO DE 2024",
      unidade_emissora_id: String(unidade!.id),
      data_publicacao: "2024-09-17",
      numero: "99",
    });
    expect(r.text).toContain("imutável (RN-14)");
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(depois!.portaria_id).toBe(antes!.portaria_id);
    expect(depois!.data_marco_inicial).toBe(antes!.data_marco_inicial);
  });

  it("quem não LÊ o parecer (fora do escopo) também não o anula", async () => {
    const id = await parecer_emitido();
    const [campus] = await db.select().from(e.campus).limit(1);
    await criarUsuario(db, { login: "coord_de_campus", perfis: ["coordenador_csso"], campus_id: campus!.id });
    const cliente = await entrar(amb.novoCliente(), "coord_de_campus");
    // a leitura já não abre...
    expect((await cliente.get(`/pareceres/${id}/previa`, { seguir: false })).status).toBe(404);
    // ...e a escrita também não passa
    const r = await cliente.post(`/pareceres/${id}/anular`, { motivo: "fora do escopo" }, { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/processos");
    const [depois] = await db.select().from(e.parecer_tecnico).where(eq(e.parecer_tecnico.id, id));
    expect(depois!.situacao).toBe("EMITIDO");
  });
});

describe("senha provisória", () => {
  it("a troca obrigatória vale em toda rota, não só logo depois do login", async () => {
    await criarUsuario(db, { login: "provisoria", perfis: ["coordenador_csso"], precisa_trocar_senha: true });
    const cliente = await entrar(amb.novoCliente(), "provisoria");
    const r = await cliente.get("/processos", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toBe("/trocar-senha");
    expect((await cliente.get("/trocar-senha")).status).toBe(200);
    const api = await cliente.get("/api/v1/eu", { seguir: false });
    expect(api.status).toBe(403);
    // trocada a senha, a conta anda
    const troca = await cliente.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova: "NovaSenha2026", confirmacao: "NovaSenha2026" },
      { seguir: false },
    );
    expect(troca.status).toBe(303);
    expect((await cliente.get("/processos", { seguir: false })).status).toBe(200);
  });

  it("redefinir senha devolve a provisória no corpo, sem cache, e nunca na URL", async () => {
    const [alvo] = await db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria_csso"));
    const cliente = await entrar(amb.novoCliente(), "admin_ti");
    const r = await cliente.post(`/usuarios/${alvo!.id}/senha`, {}, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.location).toBeNull();
    expect(r.cabecalho("cache-control")).toBe("no-store");
    expect(r.text).toContain("Nova senha provisória de secretaria_csso");
  });

  it("criar conta idem", async () => {
    const cliente = await entrar(amb.novoCliente(), "admin_ti");
    const r = await cliente.post(
      "/usuarios",
      { login: "nova", nome: "Conta Nova", email: "nova@teste.ufvjm.edu.br" },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    expect(r.location).toBeNull();
    expect(r.text).toContain("Senha provisória:");
  });
});

describe("exportação completa", () => {
  it.each(["tecnico_seguranca", "consulta_progep", "auditor_interno", "engenheiro_seguranca"])(
    "%s tem `exportar` mas não leva o banco inteiro",
    async (perfil) => {
      const cliente = await entrar(amb.novoCliente(), perfil);
      const r = await cliente.post("/config/exportar-tudo", {}, { seguir: false });
      expect(r.status).toBe(403);
    },
  );

  it("superintendente leva", async () => {
    const cliente = await entrar(amb.novoCliente(), "superintendente");
    const r = await cliente.post("/config/exportar-tudo", {}, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.cabecalho("content-type")).toContain("application/zip");
  });
});

describe("login: teto por endereço e bloqueio sem corrida", () => {
  afterEach(() => {
    delete process.env.CSSO_MAX_FALHAS_IP;
  });

  const de = (ip: string) => ({ seguir: false, cabecalhos: { "x-nf-client-connection-ip": ip } });

  it("o mesmo endereço errando em contas diferentes é bloqueado; outro endereço entra", async () => {
    process.env.CSSO_MAX_FALHAS_IP = "3";
    const atacante = amb.novoCliente();
    for (const login of ["a@x.example", "b@x.example", "coordenador_csso"]) {
      const r = await atacante.post("/login", { login, senha: "Errada123" }, de("203.0.113.9"));
      expect(r.text).toContain("Usuário ou senha inválidos.");
    }
    // nem a senha certa passa por esse endereço agora
    const r = await atacante.post("/login", { login: "tecnico_seguranca", senha: SENHA_TESTE }, de("203.0.113.9"));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Muitas tentativas de entrada a partir deste endereço");
    // outro endereço segue livre
    const ok = await amb.novoCliente().post("/login", { login: "tecnico_seguranca", senha: SENHA_TESTE }, de("198.51.100.7"));
    expect(ok.status).toBe(303);
    const [linha] = await db.select().from(e.limite_login_ip).where(eq(e.limite_login_ip.ip, "203.0.113.9"));
    expect(linha!.falhas).toBe(3);
    expect(linha!.bloqueado_ate).not.toBeNull();
  });

  it("sem endereço (teste, script local) não há teto", async () => {
    process.env.CSSO_MAX_FALHAS_IP = "1";
    const cliente = amb.novoCliente();
    await cliente.post("/login", { login: "ninguem", senha: "Errada123" }, { seguir: false });
    await entrar(cliente, "coordenador_csso");
    expect(await db.select().from(e.limite_login_ip)).toHaveLength(0);
  });

  it("tentativas em paralelo não furam o bloqueio da conta", async () => {
    const max = obterConfig().maxTentativas;
    await Promise.all(
      Array.from({ length: max * 3 }, () =>
        amb.novoCliente().post("/login", { login: "secretaria_csso", senha: "Errada123" }, { seguir: false }),
      ),
    );
    const [conta] = await db.select().from(e.usuario).where(eq(e.usuario.login, "secretaria_csso"));
    expect(conta!.tentativas_falhas).toBe(max);
    expect(conta!.bloqueado_ate).not.toBeNull();
  });
});

describe("download de anexo do Trello", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CSSO_TRELLO_KEY;
    delete process.env.CSSO_TRELLO_TOKEN;
  });

  it.each([
    "http://trello.com/1/cards/x/attachments/y/download/a.pdf",
    "https://169.254.169.254/latest/meta-data/",
    "https://atacante.example/coleta",
    "https://trello.com.atacante.example/a.pdf",
    "https://trello.com:8443/a.pdf",
    "file:///etc/passwd",
  ])("recusa %s sem abrir conexão", async (url) => {
    const espiao = vi.spyOn(globalThis, "fetch");
    await expect(trello.baixar_url(url)).rejects.toBeInstanceOf(trello.AnexoForaDoTrello);
    expect(espiao).not.toHaveBeenCalled();
  });

  it("a credencial vai só ao trello.com; redirecionamento para fora é recusado", async () => {
    process.env.CSSO_TRELLO_KEY = "k";
    process.env.CSSO_TRELLO_TOKEN = "t";
    const chamadas: [string, Record<string, string>][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      chamadas.push([u, (init?.headers ?? {}) as Record<string, string>]);
      if (u.startsWith("https://trello.com/")) {
        return new Response(null, { status: 302, headers: { location: "https://trello-attachments.s3.amazonaws.com/x.pdf" } });
      }
      if (u.startsWith("https://trello-attachments.s3.amazonaws.com/")) {
        return new Response(null, { status: 302, headers: { location: "https://atacante.example/x" } });
      }
      return new Response("nunca", { status: 200 });
    });
    await expect(trello.baixar_url("https://trello.com/1/cards/c/attachments/a/download/x.pdf")).rejects.toBeInstanceOf(
      trello.AnexoForaDoTrello,
    );
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]![1].Authorization).toContain("oauth_token");
    expect(chamadas[1]![1].Authorization).toBeUndefined();
  });

  it("corpo acima do teto do anexo é cortado", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(5 * 1024 * 1024), { status: 200 }));
    await expect(trello.baixar_url("https://trello.com/1/cards/c/attachments/a/download/x.pdf")).rejects.toThrow(/limite/);
  });
});

describe("link do SEI digitado", () => {
  it.each([
    ["javascript:alert(1)", false],
    ["https://sei.ufvjm.edu.br/sei/controlador.php?x=1", true],
  ])("%s vira link? %s", async (url, vira) => {
    const processo_id = await naTransacao(async (tx) => (await cenario(tx)).processo_id);
    await db.update(e.processo).set({ url_permanente: url }).where(eq(e.processo.id, processo_id));
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const corpo = (await cliente.get(`/processos/${processo_id}`)).text;
    expect(corpo.includes("Abrir no SEI")).toBe(vira);
    expect(corpo).not.toContain('href="javascript:');
  });
});
