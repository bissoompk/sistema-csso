/**
 * Revisão de privacidade para produção (25/09/2026): CPF em campo livre, o
 * registro de acesso (porte de `app/registro_acesso.py`) e os expurgos novos.
 * A varredura de RN-19 em todas as saídas está em `privacidade_varredura.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as textos from "../src/servicos/textos.js";
import { ArmazenamentoLocal } from "../src/servicos/armazenamento.js";
import { expurgar_exportacoes, momento_da_exportacao } from "../src/servicos/privacidade.js";
import { expurgar_registro_acesso } from "../src/servicos/registro_acesso.js";
import { SENHA_TESTE, bancoLimpo, contas, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

describe("CPF digitado em campo livre", () => {
  it("mascara o CPF inteiro, sem deixar dígito", () => {
    expect(textos.mascarar_cpf("CPF do servidor 123.456.789-09, ligar")).toBe(
      "CPF do servidor ***.***.***-**, ligar",
    );
    // pontuação inteira: mascara mesmo com dígito verificador errado
    expect(textos.mascarar_cpf("111.222.333-44")).toBe(textos.CPF_MASCARADO);
    // sem pontuação: só com dígito verificador certo (529.982.247-25 é válido)
    expect(textos.mascarar_cpf("doc 52998224725 anexo")).toBe("doc ***.***.***-** anexo");
    expect(textos.mascarar_cpf("529982247-25")).toBe(textos.CPF_MASCARADO);
    expect(textos.cpf_valido("52998224725")).toBe(true);
    expect(textos.cpf_valido("11111111111")).toBe(false);
  });

  it("não toca no que só parece número: NUP, CNPJ, SIAPE, telefone, protocolo", () => {
    for (const intacto of [
      "23086.012345/2026-11",
      "12.345.678/0001-90",
      "SIAPE 3010011",
      "(38) 99999-8888",
      "38999998888", // onze dígitos, dígito verificador não confere
      "EPI-2026-0001",
      "chave 35260912345678000190550010000001231000001230",
      "Parecer_Tecnico_08-2026",
      // hash em hexadecimal com onze dígitos que "conferem" no meio
      "a52998224725b0c1",
      "sha256 e3b052998224725f",
    ]) {
      expect(textos.mascarar_cpf(intacto), intacto).toBe(intacto);
    }
  });

  it("mascara dentro de estrutura (corpo da API, quadro do Trello)", () => {
    expect(
      textos.mascarar_cpf_em({ a: ["x 123.456.789-09"], b: { c: "52998224725" }, n: 5, v: null }),
    ).toEqual({ a: ["x ***.***.***-**"], b: { c: textos.CPF_MASCARADO }, n: 5, v: null });
  });

  it("o formulário grava o CPF mascarado — em campo que a RN-21 nunca filtrou", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.post(
      "/demandas",
      {
        assunto: "Retorno por telefone 123.456.789-09",
        canal: "EMAIL",
        solicitante_nome: "Fulano, 52998224725",
        data_chegada: "2026-09-01",
        descricao: "Pediu orientação sobre o laudo.",
      },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const [d] = await amb.db.select().from(e.demanda).orderBy(desc(e.demanda.id)).limit(1);
    expect(d!.assunto).toBe("Retorno por telefone ***.***.***-**");
    expect(d!.solicitante_nome).toBe("Fulano, ***.***.***-**");
    const trilha = await amb.db.select().from(e.historico_evento);
    expect(JSON.stringify(trilha)).not.toMatch(/123\.456\.789-09|52998224725/);
  });

  it("a senha não é mexida (campo intocável)", async () => {
    // senha com onze dígitos válidos de CPF: se fosse mascarada, o login falharia
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const autenticacao = await import("../src/servicos/autenticacao.js");
    await amb.db
      .update(e.usuario)
      .set({ senha_hash: await autenticacao.gerar_hash("52998224725") })
      .where(eq(e.usuario.id, conta!.id));
    const r = await amb.cliente.post("/login", { login: "coordenador_csso", senha: "52998224725" }, { seguir: false });
    expect(r.status).toBe(303);
  });

  it("a troca de senha (`nova`/`confirmacao`) também não é mexida", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const nova = "Csso!52998224725";
    const r = await amb.cliente.post(
      "/trocar-senha",
      { senha_atual: SENHA_TESTE, nova, confirmacao: nova },
      { seguir: false },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    const outro = amb.novoCliente();
    expect((await outro.post("/login", { login: "coordenador_csso", senha: nova }, { seguir: false })).status).toBe(303);
  });
});

describe("registro de acesso (porte de app/registro_acesso.py)", () => {
  async function ultimas(n = 5) {
    return amb.db.select().from(e.registro_acesso).orderBy(desc(e.registro_acesso.id)).limit(n);
  }

  it("grava a FORMA da rota, a conta pelo id, o status e a duração — nunca o id concreto nem a query", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const [sv] = await amb.db
      .insert(e.servidor)
      .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino" })
      .returning();
    const r = await amb.cliente.get(`/servidores/${sv!.id}?q=Marco%20Antonio`, {
      cabecalhos: { "x-nf-client-connection-ip": "203.0.113.7" },
    });
    expect(r.status).toBe(200);
    const [linha] = await ultimas(1);
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    expect(linha).toMatchObject({
      metodo: "GET",
      rota: "/servidores/{id}",
      status: 200,
      conta_id: conta!.id,
      ip: "203.0.113.7",
    });
    expect(linha!.req).toMatch(/^[0-9a-f]{8}$/);
    const tudo = JSON.stringify(await amb.db.select().from(e.registro_acesso));
    for (const proibido of ["Marco", "1110654", "coordenador_csso", `/servidores/${sv!.id}`, "q="]) {
      expect(tudo, proibido).not.toContain(proibido);
    }
  });

  it("caminho que não casou rota sai como '-', e o 404 fica registrado", async () => {
    await amb.cliente.get("/fulano-de-tal-tem-insalubridade");
    const [linha] = await ultimas(1);
    expect(linha).toMatchObject({ rota: "-", status: 404, conta_id: null });
  });

  it("o login não deixa o login nem a senha — e a recusa fica registrada", async () => {
    await amb.cliente.post("/login", { login: "coordenador_csso", senha: "errada-de-proposito" }, { seguir: false });
    const [linha] = await ultimas(1);
    expect(linha).toMatchObject({ metodo: "POST", rota: "/login" });
    expect(JSON.stringify(linha)).not.toMatch(/coordenador|errada/);
  });

  it("expurgo no prazo da política (CSSO_LOG_RETENCAO_DIAS, padrão 90)", async () => {
    const velho = new Date(Date.now() - 91 * 86_400_000);
    const novo = new Date(Date.now() - 89 * 86_400_000);
    await amb.db.insert(e.registro_acesso).values([
      { momento: velho, req: "aaaaaaaa", ip: "-", metodo: "GET", rota: "/x", status: 200, duracao_ms: 1 },
      { momento: novo, req: "bbbbbbbb", ip: "-", metodo: "GET", rota: "/y", status: 200, duracao_ms: 1 },
    ]);
    const apagadas = await naTransacao((tx) => expurgar_registro_acesso(tx));
    expect(apagadas).toBeGreaterThanOrEqual(1);
    const restantes = (await amb.db.select().from(e.registro_acesso)).map((l) => l.req);
    expect(restantes).not.toContain("aaaaaaaa");
    expect(restantes).toContain("bbbbbbbb");
  });
});

describe("a cópia da exportação completa (zip em claro) não fica no armazenamento", () => {
  it("apaga a cópia com mais de 24 h e não toca no que não é exportação", async () => {
    const raiz = await mkdtemp(path.join(tmpdir(), "csso-exp-"));
    try {
      const arm = new ArmazenamentoLocal(raiz);
      const bytes = new Uint8Array([1, 2, 3]);
      await arm.gravar("exportacoes/csso-export-20260920-100000.zip", bytes);
      await arm.gravar("exportacoes/csso-export-20260924-230000.zip", bytes);
      await arm.gravar("exportacoes/outra-coisa.zip", bytes);
      const agora = new Date(Date.UTC(2026, 8, 25, 12, 0, 0));
      expect(momento_da_exportacao("csso-export-20260920-100000.zip")?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
      const apagadas = await expurgar_exportacoes(arm, agora);
      expect(apagadas).toEqual(["exportacoes/csso-export-20260920-100000.zip"]);
      const ficaram = (await arm.listar("exportacoes")).map((i) => i.nome);
      expect(ficaram).toEqual(["csso-export-20260924-230000.zip", "outra-coisa.zip"]);
    } finally {
      await rm(raiz, { recursive: true, force: true });
    }
  });
});

describe("ferramentas/procurar-cpf.ts", () => {
  it("acha o CPF que entrou por fora da máscara (INSERT à mão) e não imprime o valor", async () => {
    const postgres = (await import("postgres")).default;
    const { procurar_cpf } = await import("../ferramentas/procurar-cpf.js");
    const sql = postgres(amb.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await procurar_cpf(sql)).toEqual([]);
      await amb.db.insert(e.servidor).values({ siape: "1110654", nome: "Teste" });
      await sql`UPDATE servidor SET email = 'x 529.982.247-25 y' WHERE siape = '1110654'`;
      await sql`INSERT INTO registro_acesso (momento, req, ip, metodo, rota, status, duracao_ms)
                VALUES (now(), 'cccccccc', '38999998888', 'GET', '/x', 200, 1)`;
      expect(await procurar_cpf(sql)).toEqual([{ tabela: "servidor", coluna: "email", linhas: 1 }]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe("painel: 'Últimos eventos' e a fila de laudos", () => {
  it("o titular vê só o que ele fez; a secretaria vê o código opaco de quem é servidor", async () => {
    const { criarUsuario, usuarioAtual } = await import("./ajuda");
    const auditoria = await import("../src/servicos/auditoria.js");
    const [a] = await amb.db.insert(e.servidor).values({ siape: "3010011", nome: "Adelaide Nunes Prata" }).returning();
    const [b] = await amb.db.insert(e.servidor).values({ siape: "3010022", nome: "Bruno Sacramento Vilela" }).returning();
    await criarUsuario(amb.db, { login: "adelaide", nome: "Adelaide Nunes Prata", perfis: ["servidor_consulta"], servidor_id: a!.id });
    await criarUsuario(amb.db, { login: "bruno", nome: "Bruno Sacramento Vilela", perfis: ["servidor_consulta"], servidor_id: b!.id });
    const quem = await usuarioAtual(amb.db, "bruno");
    await naTransacao((tx) =>
      auditoria.registrar(tx, {
        entidade: "epi_requisicao",
        entidade_id: 1,
        tipo_evento: "EPI_REQUISICAO_ENVIADA",
        descricao: "Requisição enviada.",
        usuario: quem,
      }),
    );

    await entrar(amb.cliente, "adelaide");
    const painel_a = (await amb.cliente.get("/")).text;
    expect(painel_a).not.toContain("Bruno");
    expect(painel_a).not.toContain("EPI_REQUISICAO_ENVIADA");

    const sec = amb.novoCliente();
    await entrar(sec, "secretaria_csso");
    const painel_s = (await sec.get("/")).text;
    expect(painel_s).not.toContain("Bruno Sacramento Vilela");
    expect(painel_s).toMatch(/SRV-[0-9a-f]{4}/);

    const coord = amb.novoCliente();
    await entrar(coord, "coordenador_csso");
    expect((await coord.get("/")).text).toContain("Bruno Sacramento Vilela");
  });
});
