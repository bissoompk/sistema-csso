/**
 * Correções do lote "base-admin": um bloco por item, com o caso que o relatório
 * de defeitos reproduziu. Cada recusa nova de regra, permissão ou validação tem
 * o seu teste aqui.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import { GRUPOS_PERMISSAO_TELA, PERMISSOES } from "../src/servicos/rbac.js";
import { termo_de_nup } from "../src/servicos/busca.js";
import { bancoLimpo, contas, criarUsuario, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";

const HOJE = hoje_iso();

let amb: AmbienteDeTeste = await bancoLimpo();
let cliente: Cliente;

beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  cliente = amb.cliente;
});

async function conta(login: string) {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

// =====================================================================
// D47 / M80 / M72 — /config em duas seções
// =====================================================================
describe("D47/M80/M72: /config", () => {
  it("o servidor comum (processo.ver) não entra", async () => {
    await entrar(cliente, "servidor_consulta");
    const r = await cliente.get("/config");
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("PostgreSQL");
  });

  it("quem instrui processo vê a configuração do setor, sem onde o dado mora", async () => {
    await entrar(cliente, "engenheiro_seguranca");
    const r = await cliente.get("/config");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Configuração do setor");
    expect(r.text).toContain("SLA por coluna");
    expect(r.text).not.toContain("Onde o dado mora");
    expect(r.text).not.toContain("PostgreSQL");
    expect(r.text).not.toContain("Fazer backup cifrado agora");
  });

  it("o SLA sai com o rótulo da coluna, e não o código", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/config");
    expect(r.text).toContain("Não iniciado");
    expect(r.text).toContain("Em andamento");
    expect(r.text).not.toMatch(/<th scope="row">NAO_INICIADO<\/th>/);
    // o coordenador exporta tudo, mas não opera o backup: sem os caminhos
    expect(r.text).toContain("Exportar tudo (.zip)");
    expect(r.text).not.toContain("Onde o dado mora");
  });

  it("quem opera backup vê a seção Sistema com os caminhos, e não a do setor", async () => {
    await entrar(cliente, "admin_ti");
    const r = await cliente.get("/config");
    expect(r.text).toContain("Onde o dado mora");
    expect(r.text).not.toContain("Configuração do setor");
  });

  it("gravar SLA sem catalogo.gerenciar é 403 antes de ler o formulário", async () => {
    await entrar(cliente, "engenheiro_seguranca");
    expect((await cliente.post("/config/sla", {}, { seguir: false })).status).toBe(403);
  });
});

// =====================================================================
// D66 / M70 — inativar conta
// =====================================================================
describe("D66/M70: inativar conta", () => {
  it("a própria conta não se inativa", async () => {
    await entrar(cliente, "superintendente");
    const eu = await conta("superintendente");
    const r = await cliente.post(`/usuarios/${eu.id}/inativar`, {});
    expect(r.text).toContain("a própria conta não se inativa");
    expect((await conta("superintendente")).ativo).toBe(true);
  });

  it("admin_ti não inativa conta de administração (o superintendente)", async () => {
    await entrar(cliente, "admin_ti");
    const sup = await conta("superintendente");
    const r = await cliente.post(`/usuarios/${sup.id}/inativar`, {});
    expect(r.text).toContain("é conta de administração");
    expect((await conta("superintendente")).ativo).toBe(true);
  });

  it("admin_ti inativa conta comum, e o recado diz de quem", async () => {
    await entrar(cliente, "admin_ti");
    const alvo = await conta("tecnico_seguranca");
    const r = await cliente.post(`/usuarios/${alvo.id}/inativar`, {});
    expect(r.text).toContain("inativada");
    expect((await conta("tecnico_seguranca")).ativo).toBe(false);
  });

  it("o superintendente inativa outra conta que concede, quando ele próprio continua", async () => {
    await criarUsuario(amb.db, { login: "sup2", perfis: ["superintendente"] });
    await entrar(cliente, "superintendente");
    const alvo = await conta("sup2");
    await cliente.post(`/usuarios/${alvo.id}/inativar`, {});
    expect((await conta("sup2")).ativo).toBe(false);
  });

  it("a tela não oferece Inativar na própria linha e pede confirmação nas outras", async () => {
    await entrar(cliente, "admin_ti");
    const eu = await conta("admin_ti");
    const r = await cliente.get("/usuarios");
    expect(r.text).toContain("A sua própria conta não se inativa por aqui");
    expect(r.text).not.toContain(`href="#inativar-conta-${eu.id}"`);
    const outro = await conta("tecnico_seguranca");
    expect(r.text).toContain(`id="inativar-conta-${outro.id}"`);
    expect(r.text).toContain("Inativar a conta de Técnica de Teste?");
  });
});

// =====================================================================
// D67 / D69 / D77 — catálogos
// =====================================================================
describe("D67/D69/D77: catálogos", () => {
  it("sigla de campus repetida é recusada, sem sobrescrever", async () => {
    await entrar(cliente, "coordenador_csso");
    await cliente.post("/catalogos/campi", { sigla: "TSTBA", nome: "Campus Teste", cidade: "Diamantina" });
    const r = await cliente.post("/catalogos/campi", { sigla: "tstba", nome: "SOBRESCRITO", cidade: "Outra", uf: "SP" });
    expect(r.text).toContain("Já existe campus com a sigla TSTBA");
    const [c] = await amb.db.select().from(e.campus).where(eq(e.campus.sigla, "TSTBA"));
    expect([c!.nome, c!.cidade, c!.uf]).toEqual(["Campus Teste", "Diamantina", "MG"]);
  });

  it("sigla, nome e cidade em branco são recusados", async () => {
    await entrar(cliente, "coordenador_csso");
    const antes = (await amb.db.select().from(e.campus)).length;
    const r = await cliente.post("/catalogos/campi", { sigla: " ", nome: "  ", cidade: "" });
    expect(r.text).toContain("Preencha sigla, nome e cidade");
    expect((await amb.db.select().from(e.campus)).length).toBe(antes);
  });

  it("editar campus com nome em branco é recusado", async () => {
    await entrar(cliente, "coordenador_csso");
    const [c] = await amb.db.select().from(e.campus).limit(1);
    const r = await cliente.post(`/catalogos/campi/${c!.id}`, { nome: "  ", cidade: "X" });
    expect(r.text).toContain("Preencha nome");
    const [depois] = await amb.db.select().from(e.campus).where(eq(e.campus.id, c!.id));
    expect(depois!.nome).toBe(c!.nome);
  });

  it("secretaria editando catálogo recebe 403, e não 422", async () => {
    await entrar(cliente, "secretaria_csso");
    const r = await cliente.post("/catalogos/setores-emissores/1", { sigla_composta: "X" }, { seguir: false });
    expect(r.status).toBe(403);
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.post("/catalogos/campi/999999", {}, { seguir: false })).status).toBe(403);
  });
});

// =====================================================================
// D70 / D71 / D81 — servidores
// =====================================================================
describe("D70/D71/D81: servidores", () => {
  it("nome em branco, e-mail inválido e e-mail repetido são recusados no cadastro", async () => {
    await entrar(cliente, "coordenador_csso");
    let r = await cliente.post("/servidores", { siape: "9876501", nome: "   ", email: "a@ufvjm.edu.br" });
    expect(r.text).toContain("Informe o nome do servidor");
    r = await cliente.post("/servidores", { siape: "9876501", nome: "Fulano", email: "nao-e-email" });
    expect(r.text).toContain("não é um e-mail");
    await cliente.post("/servidores", { siape: "9876502", nome: "Beltrano", email: "beltrano@ufvjm.edu.br" });
    r = await cliente.post("/servidores", { siape: "9876503", nome: "Ciclano", email: "BELTRANO@ufvjm.edu.br" });
    expect(r.text).toContain("já está no cadastro do servidor SIAPE 9876502");
    const gravados = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "9876503"));
    expect(gravados).toHaveLength(0);
    expect(await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "9876501"))).toHaveLength(0);
  });

  it("situação fora do vocabulário é recusada na edição", async () => {
    await entrar(cliente, "coordenador_csso");
    const criado = await cliente.post("/servidores", { siape: "9876504", nome: "Dorotéia" }, { seguir: false });
    const id = Number(criado.location!.split("/").pop()!.split("?")[0]);
    const r = await cliente.post(`/servidores/${id}`, { nome: "Dorotéia", siape: "9876504", situacao: "XPTO" });
    expect(r.text).toContain("escolha a situação na lista");
    const [s] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, id));
    expect(s!.situacao).toBe("ATIVO");
  });

  it("na edição, o e-mail só é conferido quando muda: o repetido antigo não trava a correção do nome", async () => {
    await entrar(cliente, "coordenador_csso");
    const a = await cliente.post("/servidores", { siape: "9876505", nome: "Eulália", email: "eu@ufvjm.edu.br" }, { seguir: false });
    const b = await cliente.post("/servidores", { siape: "9876506", nome: "Fausto" }, { seguir: false });
    const id_a = Number(a.location!.split("/").pop()!.split("?")[0]);
    const id_b = Number(b.location!.split("/").pop()!.split("?")[0]);
    // o cadastro antigo, de antes da conferência, com o e-mail repetido
    await amb.db.update(e.servidor).set({ email: "EU@ufvjm.edu.br" }).where(eq(e.servidor.id, id_b));
    let r = await cliente.post(`/servidores/${id_b}`, {
      nome: "Fausto Corrigido",
      siape: "9876506",
      email: "EU@ufvjm.edu.br",
      situacao: "ATIVO",
    });
    let [s] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, id_b));
    expect(s!.nome).toBe("Fausto Corrigido");
    // trocar PARA um e-mail de outro servidor continua recusado
    r = await cliente.post(`/servidores/${id_a}`, {
      nome: "Eulália",
      siape: "9876505",
      email: "outro@ufvjm.edu.br",
      situacao: "ATIVO",
    });
    r = await cliente.post(`/servidores/${id_b}`, {
      nome: "Fausto Corrigido",
      siape: "9876506",
      email: "outro@ufvjm.edu.br",
      situacao: "ATIVO",
    });
    expect(r.text).toContain("já está no cadastro do servidor SIAPE 9876505");
    [s] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, id_b));
    expect(s!.email).toBe("EU@ufvjm.edu.br");
  });

  it("editar servidor sem processo.editar é 403 antes de qualquer consulta", async () => {
    await entrar(cliente, "servidor_consulta");
    expect((await cliente.post("/servidores/1", {}, { seguir: false })).status).toBe(403);
    expect((await cliente.post("/servidores/1/lotacao", {}, { seguir: false })).status).toBe(403);
  });

  it("o número do laudo é texto, e não link, para quem não tem laudo.ver", async () => {
    // o template decide pela permissão: o link só sai com laudo.ver
    const fonte = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../templates/paginas/servidor_ficha.html", import.meta.url), "utf8"),
    );
    expect(fonte).toMatch(/p\.laudo and usuario\.pode\('laudo\.ver'\) %\}<a class="mono" href="\/laudos\//);
  });
});

// =====================================================================
// D72 / D73 / D75 / M65 / M76 — demandas
// =====================================================================
describe("D72/D73/D75/M65/M76: demandas", () => {
  function registrar(campos: Record<string, string>) {
    return cliente.post(
      "/demandas",
      { assunto: "Pedido de teste", canal: "EMAIL", solicitante_nome: "Chefia", data_chegada: HOJE, ...campos },
      { seguir: false },
    );
  }
  async function criada(campos: Record<string, string> = {}): Promise<number> {
    const r = await registrar(campos);
    expect(r.status, r.text.slice(0, 300)).toBe(303);
    return Number(r.location!.split("/demandas/")[1]!.split("?")[0]);
  }

  it("responsável inexistente ou que não abre demandas é recusado (e não 500)", async () => {
    await entrar(cliente, "secretaria_csso");
    let r = await registrar({ responsavel_id: "99999" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Escolha o responsável na lista");
    const id = await criada();
    const admin = await conta("admin_ti");
    r = await cliente.post(`/demandas/${id}/atribuir`, { responsavel_id: String(admin.id) });
    expect(r.text).toContain("Escolha o responsável na lista");
    const [d] = await amb.db.select().from(e.demanda).where(eq(e.demanda.id, id));
    expect(d!.responsavel_id).not.toBe(admin.id);
  });

  it("chegada no futuro é recusada; prazo antes da chegada também", async () => {
    await entrar(cliente, "secretaria_csso");
    let r = await registrar({ data_chegada: somar_dias(HOJE, 1) });
    expect(r.text).toContain("A data de chegada não pode ser posterior a hoje.");
    r = await registrar({ data_chegada: HOJE, prazo: somar_dias(HOJE, -1) });
    expect(r.text).toContain("O prazo não pode ser anterior à data de chegada.");
  });

  it("data inválida sai em português, e dd/mm/aaaa é aceita", async () => {
    await entrar(cliente, "secretaria_csso");
    const r = await registrar({ data_chegada: "2026-13-45" });
    expect(r.text).toContain("Data de chegada: data inválida — use dd/mm/aaaa.");
    expect(r.text).not.toContain("Invalid isoformat");
    const [a, m, d] = somar_dias(HOJE, -2).split("-");
    const id = await criada({ data_chegada: `${d}/${m}/${a}` });
    const [dm] = await amb.db.select().from(e.demanda).where(eq(e.demanda.id, id));
    expect(dm!.data_chegada).toBe(somar_dias(HOJE, -2));
  });

  it("desfecho antes da chegada ou no futuro é recusado", async () => {
    await entrar(cliente, "secretaria_csso");
    const id = await criada({ data_chegada: somar_dias(HOJE, -5) });
    let r = await cliente.post(`/demandas/${id}/encerrar`, {
      desfecho: "ENCAMINHADA",
      setor: "SIASS",
      data_desfecho: somar_dias(HOJE, -6),
    });
    expect(r.text).toContain("A data do encaminhamento não pode ser anterior à data de chegada.");
    r = await cliente.post(`/demandas/${id}/encerrar`, {
      desfecho: "ENCAMINHADA",
      setor: "SIASS",
      data_desfecho: somar_dias(HOJE, 3),
    });
    expect(r.text).toContain("A data do encaminhamento não pode ser posterior a hoje.");
    const [d] = await amb.db.select().from(e.demanda).where(eq(e.demanda.id, id));
    expect(d!.estado).not.toBe("ENCERRADA");
  });

  it("encaminhamento antes da chegada é recusado", async () => {
    await entrar(cliente, "secretaria_csso");
    const id = await criada({ data_chegada: HOJE });
    const r = await cliente.post(`/demandas/${id}/encaminhar`, {
      para_quem: "SIASS",
      pedido: "avaliação",
      data_encaminhamento: somar_dias(HOJE, -1),
    });
    expect(r.text).toContain("não pode ser anterior à data de chegada");
  });

  it("escrever sem demanda.registrar é 403 antes do formulário", async () => {
    await entrar(cliente, "admin_ti");
    expect((await cliente.post("/demandas", {}, { seguir: false })).status).toBe(403);
    expect((await cliente.post("/demandas/1/atribuir", {}, { seguir: false })).status).toBe(403);
  });

  it("quem não vê nome escolhe o servidor pelo SIAPE, conferido", async () => {
    await entrar(cliente, "coordenador_csso");
    await cliente.post("/servidores", { siape: "1110654", nome: "Marco Antônio" });
    await entrar(cliente, "secretaria_csso");
    const tela = await cliente.get("/demandas");
    expect(tela.text).toContain('name="solicitante_siape"');
    expect(tela.text).not.toContain('name="solicitante_servidor_id"');
    let r = await registrar({ solicitante_siape: "9999999" });
    expect(r.text).toContain("Não há servidor com o SIAPE 9999999");
    const id = await criada({ solicitante_siape: "1110654", solicitante_nome: "" });
    const [d] = await amb.db.select().from(e.demanda).where(eq(e.demanda.id, id));
    const [s] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "1110654"));
    expect(d!.solicitante_servidor_id).toBe(s!.id);
    // quem vê nome continua com o seletor
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/demandas")).text).toContain('name="solicitante_servidor_id"');
    r = await cliente.get("/demandas");
    expect(r.status).toBe(200);
  });

  it("estado desconhecido no filtro cai em 'Em aberto'", async () => {
    await entrar(cliente, "secretaria_csso");
    await criada({ assunto: "Assunto visível" });
    const r = await cliente.get("/demandas?estado=XYZ");
    expect(r.text).toContain("Assunto visível");
    expect(r.text).toMatch(/ficha-filtro ativa"\s+href="\/demandas\?estado="/);
  });
});

// =====================================================================
// M66 — NUP sem pontuação na busca
// =====================================================================
describe("M66: NUP sem pontuação", () => {
  it("vira o NUP formatado só quando tem 17 dígitos e nada mais", () => {
    expect(termo_de_nup("23086100001202601")).toBe("23086.100001/2026-01");
    expect(termo_de_nup(" 23086 100001 2026 01 ")).toBe("23086.100001/2026-01");
    expect(termo_de_nup("2308610000")).toBe("2308610000");
    expect(termo_de_nup("Marco 23086100001202601")).toBe("Marco 23086100001202601");
  });

  it("a busca global acha o processo pelo NUP colado sem separadores", async () => {
    const [tipo] = await amb.db.select().from(e.tipo_processo).limit(1);
    const [etapa] = await amb.db.select().from(e.fluxo_etapa).limit(1);
    await amb.db.insert(e.processo).values({ nup: "23086.021284/2024-56", tipo_processo_id: tipo!.id, etapa_id: etapa!.id });
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/buscar?q=23086021284202456");
    expect(r.text).toContain("23086.021284/2024-56");
  });
});

// =====================================================================
// M67 / M68 — /auditoria
// =====================================================================
describe("M67/M68: auditoria", () => {
  it("admin_ti lê a descrição dos eventos de conta; a conta ligada a servidor continua suprimida", async () => {
    await entrar(cliente, "admin_ti");
    const alvo = await conta("tecnico_seguranca");
    await cliente.post(`/usuarios/${alvo.id}/inativar`, {});
    let r = await cliente.get("/auditoria");
    expect(r.text).toContain("Conta &#39;tecnico_seguranca&#39; inativada.");

    // conta ligada a servidor: o login pode ser o nome — RN-19 vale
    await entrar(cliente, "coordenador_csso");
    const criado = await cliente.post("/servidores", { siape: "1234567", nome: "Pessoa Avaliada" }, { seguir: false });
    const sv = Number(criado.location!.split("/").pop()!.split("?")[0]);
    const ligada = await criarUsuario(amb.db, { login: "pessoa.avaliada", servidor_id: sv, perfis: ["servidor_consulta"] });
    await entrar(cliente, "admin_ti");
    await cliente.post(`/usuarios/${ligada.id}/inativar`, {});
    r = await cliente.get("/auditoria");
    expect(r.text).not.toContain("Conta &#39;pessoa.avaliada&#39; inativada.");
    // e o coordenador, que lê nome, lê a frase
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/auditoria")).text).toContain("Conta &#39;pessoa.avaliada&#39; inativada.");
  });

  it("evento técnico continua suprimido para o admin_ti", async () => {
    await entrar(cliente, "coordenador_csso");
    await cliente.post("/servidores", { siape: "7654321", nome: "Nome Sensível" });
    await entrar(cliente, "admin_ti");
    const r = await cliente.get("/auditoria");
    expect(r.text).not.toContain("Servidor SIAPE 7654321 cadastrado.");
  });

  it("acessos a dado sensível com o nome de quem leu, paginados", async () => {
    const coord = await conta("coordenador_csso");
    await amb.db.insert(e.acesso_dado_sensivel).values(
      Array.from({ length: 51 }, () => ({ usuario_id: coord.id, campo: "servidor.ficha", finalidade: "teste" })),
    );
    await entrar(cliente, "auditor_interno");
    const r = await cliente.get("/auditoria");
    expect(r.text).toContain("Coordenador de Teste");
    expect(r.text).not.toContain(`#${coord.id}</td>`);
    expect(r.text).toContain("pagina_acessos=2");
    const r2 = await cliente.get("/auditoria?pagina_acessos=2");
    expect(r2.text).toContain("pagina_acessos=1");
  });

  it("a paginação da trilha leva os filtros junto", async () => {
    await entrar(cliente, "auditor_interno");
    const r = await cliente.get("/auditoria?entidade=usuario");
    expect(r.text).toContain("pagina_num=2&amp;entidade=usuario");
  });
});

// =====================================================================
// M74 / M77 — senha e login
// =====================================================================
describe("M74/M77: troca de senha e login", () => {
  it("a senha atual errada conta tentativa, e no teto a conta bloqueia e a sessão cai", async () => {
    await entrar(cliente, "tecnico_seguranca");
    const campos = { senha_atual: "errada", nova: "uma frase longa de teste 2026", confirmacao: "uma frase longa de teste 2026" };
    let r = await cliente.post("/trocar-senha", campos);
    expect(r.text).toContain("Restam 4 tentativas");
    for (let i = 0; i < 3; i++) r = await cliente.post("/trocar-senha", campos);
    expect(r.text).toContain("Resta 1 tentativa");
    r = await cliente.post("/trocar-senha", campos);
    expect(r.text).toContain("a conta ficou bloqueada");
    const u = await conta("tecnico_seguranca");
    expect(u.bloqueado_ate).not.toBeNull();
    const sessoes = await amb.db.select().from(e.sessao).where(eq(e.sessao.usuario_id, u.id));
    expect(sessoes.length).toBeGreaterThan(0);
    expect(sessoes.every((s) => s.revogada)).toBe(true);
  });

  it("acertar a senha atual zera o contador", async () => {
    await entrar(cliente, "tecnico_seguranca");
    await cliente.post("/trocar-senha", { senha_atual: "errada", nova: "x", confirmacao: "x" });
    expect((await conta("tecnico_seguranca")).tentativas_falhas).toBe(1);
    await cliente.post("/trocar-senha", { senha_atual: "SenhaDeTeste2026", nova: "a", confirmacao: "b" });
    expect((await conta("tecnico_seguranca")).tentativas_falhas).toBe(0);
  });

  // era "E-mail ou usuário" (M77); desde 23/10/2026 o login é o e-mail
  it("o texto não aponta mais para 'a barra acima'; o login diz 'E-mail'", async () => {
    await entrar(cliente, "tecnico_seguranca");
    expect((await cliente.get("/trocar-senha")).text).not.toContain("a barra acima");
    const tela = (await amb.novoCliente().get("/login")).text;
    expect(tela).toContain('<label for="login">E-mail</label>');
    expect(tela).not.toContain("E-mail ou usuário");
  });
});

// =====================================================================
// M75 — /perfis em português
// =====================================================================
describe("M75: matriz de perfis", () => {
  it("toda permissão do código tem texto de tela, uma vez só", () => {
    const vistas = GRUPOS_PERMISSAO_TELA.flatMap(([, textos]) => Object.keys(textos));
    expect(new Set(vistas).size).toBe(vistas.length);
    expect([...vistas].sort()).toEqual(Object.keys(PERMISSOES).sort());
  });

  it("a tela agrupa e escreve em português", async () => {
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.get("/perfis");
    expect(r.text).toContain("Gestão de EPI");
    expect(r.text).toContain("Abrir e enviar pedido de EPI");
    expect(r.text).toContain("epi.requisitar");
  });
});

// =====================================================================
// M85 — link aberto de fora recebe a tela, e não JSON
// =====================================================================
describe("M85: erro de navegação em HTML", () => {
  it("Accept */* num GET de link recebe a tela de 404 e de 403", async () => {
    await entrar(cliente, "servidor_consulta");
    let r = await cliente.get("/nao-existe-esta-tela", { cabecalhos: { accept: "*/*" } });
    expect(r.status).toBe(404);
    expect(r.text).toContain("<!doctype html>");
    r = await cliente.get("/config", { cabecalhos: { accept: "*/*" } });
    expect(r.status).toBe(403);
    expect(r.text).toContain("<!doctype html>");
  });

  it("HTMX, fetch e a API continuam recebendo o que pediram", async () => {
    let r = await cliente.get("/nao-existe", { cabecalhos: { accept: "*/*", "hx-request": "true" } });
    expect(r.json()).toEqual({ detail: "Not Found" });
    r = await cliente.get("/nao-existe", { cabecalhos: { accept: "*/*", "x-requested-with": "fetch" } });
    expect(r.json()).toEqual({ detail: "Not Found" });
    r = await cliente.get("/api/v1/nao-existe", { cabecalhos: { accept: "*/*" } });
    expect(r.text).not.toContain("<!doctype html>");
  });
});
