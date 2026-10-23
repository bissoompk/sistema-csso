/**
 * /minha-conta — a conta cuidada pela própria pessoa (22/10/2026).
 * Ver DESVIOS.md, "Minha conta (22/10/2026)".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as auditoria from "../src/servicos/auditoria.js";
import * as modulos from "../src/modulos.js";
import { recusa_ramal, recusa_telefone } from "../src/rotas/minha_conta.js";
import { bancoLimpo, contas, entrar, PERFIS_DE_TESTE, SENHA_TESTE, usuarioAtual, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

const conta = async (login: string) =>
  (await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login)))[0]!;
const eventos = async (tipo: string, conta_id: number) =>
  amb.db
    .select()
    .from(e.historico_evento)
    .where(and(eq(e.historico_evento.tipo_evento, tipo), eq(e.historico_evento.entidade_id, conta_id)));

/** O servidor comum de verdade: `servidor_consulta` ligado a um cadastro de servidor. */
async function ligar_servidor(login = "servidor_consulta") {
  const [s] = await amb.db.insert(e.servidor).values({ siape: "7654321", nome: "Servidor de Teste" }).returning();
  await amb.db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, login));
  return s!;
}

describe("acesso", () => {
  it.each(PERFIS_DE_TESTE.map(([codigo]) => codigo))("abre para %s, com o link no nome", async (login) => {
    await entrar(amb.cliente, login);
    const r = await amb.cliente.get("/minha-conta");
    expect(r.status, login).toBe(200);
    expect(r.text).not.toContain("Template render error");
    // desde o Portal do servidor (22/10/2026) a tela é o "Meu perfil", em seções
    expect(r.text).toContain('<h1 class="oculto">Meu perfil</h1>');
    expect(r.text).toContain('class="conta-propria" href="/minha-conta"');
    expect(r.text).toContain("Para corrigir, fale com a coordenação.");
  });

  it("o servidor comum ligado a servidor abre, vê o vínculo e tem o item no Meu espaço", async () => {
    await ligar_servidor();
    await entrar(amb.cliente, "servidor_consulta");
    const r = await amb.cliente.get("/minha-conta");
    expect(r.status).toBe(200);
    expect(r.text).toContain("7654321");
    expect(r.text).toContain("Dados funcionais, só leitura.");
    // o item no bloco, com a trilha do Meu espaço
    expect(r.text).toMatch(/id="lateral-meu"[\s\S]*href="\/minha-conta"/);
    const titular = await usuarioAtual(amb.db, "servidor_consulta");
    expect(modulos.meu_espaco_de(titular).at(-1)!.caminho).toBe("/minha-conta");
  });

  it("o link no nome está em toda tela com casca", async () => {
    await entrar(amb.cliente, "coordenador_csso");
    const r = await amb.cliente.get("/modulos");
    expect(r.text).toContain('href="/minha-conta"');
    expect(r.text).toContain('aria-label="Minha conta (Coordenador de Teste)"');
  });

  it("sem sessão vai para o login", async () => {
    const r = await amb.novoCliente().get("/minha-conta", { seguir: false });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/login");
  });

  it("mostra os perfis vigentes, só leitura", async () => {
    await entrar(amb.cliente, "engenheiro_seguranca");
    const r = await amb.cliente.get("/minha-conta");
    const [perfil] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, "engenheiro_seguranca"));
    expect(r.text).toContain(perfil!.nome);
    expect(r.text).toContain("todos os campi");
    // nenhum formulário que mexa em perfil
    expect(r.text).not.toMatch(/action="\/usuarios/);
  });
});

describe("dados pessoais", () => {
  it("edita nome, telefone e ramal, e a trilha diz só QUAIS campos mudaram", async () => {
    await entrar(amb.cliente, "tecnico_seguranca");
    const r = await amb.cliente.post("/minha-conta/dados", {
      nome: "Técnica  Renomeada",
      telefone: "(38) 99876-5432",
      ramal: "1234",
    });
    expect(r.status).toBe(200);
    expect(r.url).toContain("/minha-conta?mensagem=");
    expect(r.text).toContain("Dados atualizados.");
    const depois = await conta("tecnico_seguranca");
    expect(depois.nome).toBe("Técnica Renomeada");
    expect(depois.telefone).toBe("(38) 99876-5432");
    expect(depois.ramal).toBe("1234");
    const [ev, ...resto] = await eventos(auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR, depois.id);
    expect(resto).toEqual([]);
    expect(ev!.campo).toBe("nome,telefone,ramal");
    expect(ev!.usuario_id).toBe(depois.id);
    // o número não vai para a trilha, em campo nenhum
    const tudo = JSON.stringify(ev);
    expect(tudo).not.toContain("99876");
    expect(tudo).not.toContain("1234");
    expect(auditoria.ROTULO_EVENTO[auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR]).toBeTruthy();
  });

  it("apagar telefone e ramal (em branco) grava nulo", async () => {
    await amb.db.update(e.usuario).set({ telefone: "38 3532-1200", ramal: "12" }).where(eq(e.usuario.login, "secretaria_csso"));
    await entrar(amb.cliente, "secretaria_csso");
    await amb.cliente.post("/minha-conta/dados", { nome: "Secretaria de Teste", telefone: "", ramal: "" });
    const depois = await conta("secretaria_csso");
    expect(depois.telefone).toBeNull();
    expect(depois.ramal).toBeNull();
    const [ev] = await eventos(auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR, depois.id);
    expect(ev!.campo).toBe("telefone,ramal");
  });

  it("nada mudou: sem evento", async () => {
    await entrar(amb.cliente, "medico_trabalho");
    const r = await amb.cliente.post("/minha-conta/dados", { nome: "Médico de Teste", telefone: "", ramal: "" });
    expect(r.text).toContain("Nada mudou.");
    expect(await eventos(auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR, (await conta("medico_trabalho")).id)).toEqual([]);
  });

  it.each([
    ["telefone com letra", { telefone: "38 9999-abcd" }, "só números"],
    ["telefone curto", { telefone: "1234" }, "de 8 a 15 dígitos"],
    ["telefone longo demais", { telefone: "1".repeat(31) }, "mais de 30"],
    ["ramal com letra", { ramal: "12a" }, "ramal aceita só"],
    ["ramal com dígitos demais", { ramal: "123456789" }, "de 1 a 8 dígitos"],
    ["nome em branco", { nome: "   " }, "o nome não fica em branco"],
  ])("recusa %s, com o digitado de volta", async (_caso, campos, trecho) => {
    await entrar(amb.cliente, "almoxarife_sesmt");
    const antes = await conta("almoxarife_sesmt");
    const r = await amb.cliente.post("/minha-conta/dados", { nome: "Almoxarife de Teste", telefone: "", ramal: "", ...campos });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Os dados não foram alterados");
    expect(r.text).toContain(trecho);
    const depois = await conta("almoxarife_sesmt");
    expect([depois.nome, depois.telefone, depois.ramal]).toEqual([antes.nome, antes.telefone, antes.ramal]);
  });

  it("não há campo que mexa em outra conta: o id do formulário é ignorado", async () => {
    await entrar(amb.cliente, "servidor_consulta");
    const alvo = await conta("coordenador_csso");
    await amb.cliente.post("/minha-conta/dados", { id: alvo.id, usuario_id: alvo.id, nome: "Invasor", telefone: "", ramal: "" });
    expect((await conta("coordenador_csso")).nome).toBe("Coordenador de Teste");
    expect((await conta("servidor_consulta")).nome).toBe("Invasor");
  });

  it("validação pura", () => {
    expect(recusa_telefone("")).toBeNull();
    expect(recusa_telefone("+55 (38) 3532-1200")).toBeNull();
    expect(recusa_telefone("3532-1200")).toBeNull();
    expect(recusa_telefone("<script>")).not.toBeNull();
    expect(recusa_ramal("1200")).toBeNull();
    expect(recusa_ramal("")).toBeNull();
  });
});

describe("e-mail", () => {
  it("sem a senha atual é recusado", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "novo.admin@teste.ufvjm.edu.br", senha_atual: "" });
    expect(r.text).toContain("O e-mail não foi alterado");
    expect(r.text).toContain("senha atual");
    expect((await conta("admin_ti")).email).toBe("admin_ti@teste.ufvjm.edu.br");
  });

  it("com a senha errada é recusado e conta como tentativa", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "novo.admin@teste.ufvjm.edu.br", senha_atual: "errada-123" });
    expect(r.text).toContain("Senha atual incorreta");
    const depois = await conta("admin_ti");
    expect(depois.email).toBe("admin_ti@teste.ufvjm.edu.br");
    expect(depois.tentativas_falhas).toBe(1);
  });

  it("com a senha certa, o e-mail só muda quando o link enviado a ele é aberto pela conta", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "Novo.Admin@teste.ufvjm.edu.br", senha_atual: SENHA_TESTE });
    expect(r.text).toContain("Enviamos um link para Novo.Admin@teste.ufvjm.edu.br");
    // ainda não mudou
    expect((await conta("admin_ti")).email).toBe("admin_ti@teste.ufvjm.edu.br");
    const [m] = await amb.db.select().from(e.email_saida).where(eq(e.email_saida.tipo, "TROCA_EMAIL"));
    expect(m!.destinatario).toBe("Novo.Admin@teste.ufvjm.edu.br");
    const caminho = m!.corpo!.match(/\/minha-conta\/email\/[A-Za-z0-9_-]+/)![0];
    // de outra conta, o link não vale (e não se gasta)
    const outro = await entrar(amb.novoCliente(), "auditor_interno");
    expect((await outro.get(caminho)).text).toContain("venceu, já foi usado ou é de outra conta");
    // nem serve para definir senha
    expect((await amb.novoCliente().get(caminho.replace("/minha-conta/email/", "/ativar-acesso/"))).status).toBe(404);
    expect((await amb.cliente.get(caminho)).text).toContain("E-mail confirmado.");
    expect((await amb.cliente.get(caminho)).text).toContain("já foi usado");
    // o login acompanha o e-mail (23/10/2026)
    const depois = await conta("novo.admin@teste.ufvjm.edu.br");
    expect(depois.email).toBe("Novo.Admin@teste.ufvjm.edu.br");
    const [ev] = await eventos(auditoria.EMAIL_ALTERADO_PELO_TITULAR, depois.id);
    expect(ev!.valor_anterior).toBe("admin_ti@teste.ufvjm.edu.br");
    expect(ev!.valor_novo).toBe("Novo.Admin@teste.ufvjm.edu.br");
    await entrar(amb.novoCliente(), "novo.admin@teste.ufvjm.edu.br");
  });

  it("duplicado é recusado ignorando a caixa, sem dizer de quem é", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "COORDENADOR_CSSO@Teste.UFVJM.edu.br", senha_atual: SENHA_TESTE });
    expect(r.text).toContain("já é usado por outra conta");
    expect(r.text).not.toContain("Coordenador de Teste</");
    expect((await conta("admin_ti")).email).toBe("admin_ti@teste.ufvjm.edu.br");
    expect(await eventos(auditoria.EMAIL_ALTERADO_PELO_TITULAR, (await conta("admin_ti")).id)).toEqual([]);
  });

  it("igual ao login de outra conta também é recusado (cruzado, D12)", async () => {
    await amb.db.update(e.usuario).set({ login: "fulano@teste.ufvjm.edu.br" }).where(eq(e.usuario.login, "auditor_interno"));
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "Fulano@teste.ufvjm.edu.br", senha_atual: SENHA_TESTE });
    expect(r.text).toContain("já é usado por outra conta");
  });

  it("formato inválido é recusado antes da senha", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.post("/minha-conta/email", { email: "sem-arroba", senha_atual: "qualquer" });
    expect(r.text).toContain("não parece um e-mail");
    expect((await conta("admin_ti")).tentativas_falhas).toBe(0);
  });
});
