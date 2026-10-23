/**
 * Governança de acesso — o lote de /usuarios do relatório de governança:
 * segregação de funções (D2 conceder a si mesmo, D3 atestar a si mesmo, D4
 * admin_ti tomando conta técnica), ciclo de vida (D7 desbloquear, D10
 * habilitação que se encerra e se corrige, D11 dados da conta, D12 caixa,
 * D17 cobertura e trava de concorrência), clareza da tela (D13, D19, D20,
 * D23, D24, D25) e a trilha (D27).
 */
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as governanca from "../src/servicos/governanca.js";
import { carregar_usuario_atual, pode_subscrever } from "../src/servicos/rbac.js";
import * as redefinirSenha from "../ferramentas/redefinir-senha.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

const abertos = (corpo: string) => [...corpo.matchAll(/<dialog[^>]*id="([^"]+)"[^>]*\sopen>/g)].map((m) => m[1]);

async function conta(login: string) {
  const [u] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, login));
  return u!;
}

async function perfil(codigo: string) {
  const [p] = await amb.db.select().from(e.perfil).where(eq(e.perfil.codigo, codigo));
  return p!;
}

async function eventos(tipo: string) {
  return amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

async function atribuicoesDe(login: string) {
  const u = await conta(login);
  return amb.db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, u.id), with: { perfil: true } });
}

async function conceder(cliente = amb.cliente, campos: Record<string, string>) {
  return cliente.post("/usuarios/0/atribuicoes", campos, { seguir: false });
}

// =====================================================================
describe("D2: quem concede perfil não concede a si mesmo nem mais do que tem", () => {
  it("o superintendente não concede coordenador à própria conta; a recusa fica na trilha", async () => {
    await entrar(amb.cliente, "superintendente");
    const eu = await conta("superintendente");
    const coord = await perfil("coordenador_csso");
    const r = await conceder(amb.cliente, { usuario_alvo: String(eu.id), perfil_id: String(coord.id) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("ninguém concede perfil à própria conta");
    expect(abertos(r.text)).toEqual(["conceder-perfil"]);
    expect((await atribuicoesDe("superintendente")).map((a) => a.perfil.codigo)).toEqual(["superintendente"]);
    const [ev] = await eventos("PERFIL_CONCESSAO_RECUSADA");
    expect(ev!.entidade_id).toBe(eu.id);
  });

  it("a própria conta nem aparece na lista de quem recebe", async () => {
    await entrar(amb.cliente, "superintendente");
    const eu = await conta("superintendente");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    const select = corpo.match(/<select id="perf-usuario"[\s\S]*?<\/select>/)![0];
    expect(select).not.toContain(`value="${eu.id}"`);
  });

  it("perfil técnico se concede a outra conta: parecer.assinar depende da habilitação (D3)", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("secretaria_csso");
    const r = await conceder(amb.cliente, { usuario_alvo: String(alvo.id), perfil_id: String((await perfil("engenheiro_seguranca")).id) });
    expect(r.status).toBe(303);
    expect((await atribuicoesDe("secretaria_csso")).map((a) => a.perfil.codigo)).toContain("engenheiro_seguranca");
  });

  it("perfil com permissão que quem concede não tem é recusado", async () => {
    // tira do superintendente uma permissão (não técnica) que a secretaria tem
    const sup = await perfil("superintendente");
    const sec = await perfil("secretaria_csso");
    const da_sec = await amb.db.select().from(e.perfil_permissao).where(eq(e.perfil_permissao.perfil_id, sec.id));
    const [demanda] = await amb.db.select().from(e.permissao).where(eq(e.permissao.codigo, "demanda.registrar"));
    expect(da_sec.some((pp) => pp.permissao_id === demanda!.id)).toBe(true);
    await amb.db
      .delete(e.perfil_permissao)
      .where(and(eq(e.perfil_permissao.perfil_id, sup.id), eq(e.perfil_permissao.permissao_id, demanda!.id)));
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("tecnico_seguranca");
    const r = await conceder(amb.cliente, { usuario_alvo: String(alvo.id), perfil_id: String(sec.id) });
    expect(r.text).toContain("dá permissões que você não tem, ou com alcance maior que o seu (demanda.registrar)");
    expect((await atribuicoesDe("tecnico_seguranca")).map((a) => a.perfil.codigo)).toEqual(["tecnico_seguranca"]);
  });
});

// =====================================================================
describe("D3/D25: habilitação — quem atesta não atesta a si mesmo, e a conta é conferida", () => {
  async function atestar(campos: Record<string, string>) {
    return amb.cliente.post(
      "/habilitacoes",
      { nome: "Fulano", habilitacao: "ENG_SEG_TRABALHO", titulo_assinatura: "Eng. Seg. do Trabalho", ...campos },
      { seguir: false },
    );
  }

  it("não liga a habilitação nova à própria conta", async () => {
    await entrar(amb.cliente, "superintendente");
    const eu = await conta("superintendente");
    const r = await atestar({ usuario_alvo_id: String(eu.id) });
    expect(r.status).toBe(200);
    expect(abertos(r.text)).toEqual(["atestar-habilitacao"]);
    expect(r.text).toContain("Quem atesta habilitação não a liga à própria conta");
    expect(await eventos("HABILITACAO_RECUSADA")).toHaveLength(1);
    expect(await eventos("HABILITACAO_ATESTADA")).toHaveLength(0);
  });

  it("não atesta o próprio SIAPE", async () => {
    const [s] = await amb.db.insert(e.servidor).values({ siape: "1234567", nome: "Superintendente Real" }).returning();
    await amb.db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "superintendente"));
    await entrar(amb.cliente, "superintendente");
    const r = await atestar({ siape: "1234567" });
    expect(r.text).toContain("não atesta a própria");
    expect(await eventos("HABILITACAO_ATESTADA")).toHaveLength(0);
  });

  it("não liga uma habilitação existente à própria conta", async () => {
    await entrar(amb.cliente, "superintendente");
    const eu = await conta("superintendente");
    const [h] = await amb.db.select().from(e.profissional_habilitado).orderBy(asc(e.profissional_habilitado.id)).limit(1);
    const r = await amb.cliente.post(`/habilitacoes/${h!.id}/conta`, { usuario_id: String(eu.id) });
    expect(abertos(r.text)).toEqual([`editar-conta-hab-${h!.id}`]);
    expect(r.text).toContain("não a liga à própria conta");
    const [depois] = await amb.db.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.id, h!.id));
    expect(depois!.usuario_id).toBe(h!.usuario_id);
  });

  it("SIAPE da habilitação diferente do servidor da conta é recusado", async () => {
    const [s] = await amb.db.insert(e.servidor).values({ siape: "2222222", nome: "Eng Real" }).returning();
    await amb.db.update(e.usuario).set({ servidor_id: s!.id }).where(eq(e.usuario.login, "engenheiro_seguranca"));
    await entrar(amb.cliente, "superintendente");
    const eng = await conta("engenheiro_seguranca");
    const r = await atestar({ siape: "3333333", usuario_alvo_id: String(eng.id) });
    expect(r.text).toContain("não é o do servidor vinculado à conta");
    const ok = await atestar({ siape: "2222222", usuario_alvo_id: String(eng.id) });
    expect(ok.status).toBe(303);
  });

  it("conta inexistente, inativa ou já habilitada volta no popup, sem erro do banco (D25)", async () => {
    await entrar(amb.cliente, "superintendente");
    const inexistente = await atestar({ usuario_alvo_id: "999999" });
    expect(inexistente.status).toBe(200);
    expect(inexistente.text).toContain("Conta não encontrada.");
    expect(inexistente.text).not.toContain("recusada pelo banco");
    const sec = await conta("secretaria_csso");
    await amb.db.update(e.usuario).set({ ativo: false }).where(eq(e.usuario.id, sec.id));
    expect((await atestar({ usuario_alvo_id: String(sec.id) })).text).toContain("está inativa");
    // o coordenador já é o Fabrício (semente)
    const coord = await conta("coordenador_csso");
    expect((await atestar({ usuario_alvo_id: String(coord.id) })).text).toContain("já está ligada à habilitação de");
    expect(await eventos("HABILITACAO_ATESTADA")).toHaveLength(0);
  });
});

// =====================================================================
describe("D10: habilitação se encerra e se corrige", () => {
  async function fabricio() {
    const [h] = await amb.db
      .select()
      .from(e.profissional_habilitado)
      .where(eq(e.profissional_habilitado.nome, "Fabrício Raimundi Andrade"));
    return h!;
  }

  it("encerrar tira a assinatura da conta ligada, com antes e depois na trilha", async () => {
    const h = await fabricio();
    const coord = await carregar_usuario_atual(amb.db, (await conta("coordenador_csso")).id);
    expect(await pode_subscrever(amb.db, coord)).toBe(true);
    await entrar(amb.cliente, "superintendente");
    const tela = (await amb.cliente.get("/usuarios")).text;
    expect(tela).toContain(`action="/habilitacoes/${h.id}/encerrar"`);
    const r = await amb.cliente.post(`/habilitacoes/${h.id}/encerrar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const depois = await fabricio();
    expect(depois.vigencia_fim).toBe(somar_dias(hoje_iso(), -1));
    expect(await pode_subscrever(amb.db, coord)).toBe(false);
    const [ev] = await eventos("HABILITACAO_ENCERRADA");
    expect(ev!.campo).toBe("vigencia_fim");
    expect(JSON.stringify(ev!.valor_novo)).toContain(somar_dias(hoje_iso(), -1));
    // encerrada some do "Corrigir"/"Encerrar"
    expect((await amb.cliente.get("/usuarios")).text).not.toContain(`action="/habilitacoes/${h.id}/encerrar"`);
  });

  it("fim antes do início volta no popup daquela linha", async () => {
    const h = await fabricio();
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(`/habilitacoes/${h.id}/encerrar`, { vigencia_fim: "1990-01-01" });
    expect(abertos(r.text)).toEqual([`encerrar-hab-${h.id}`]);
    expect((await fabricio()).vigencia_fim).toBeNull();
  });

  it("corrigir grava um evento por campo, com antes e depois", async () => {
    const h = await fabricio();
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(
      `/habilitacoes/${h.id}/corrigir`,
      { titulo_assinatura: "Eng. de Segurança do Trabalho", conselho: "CREA", registro_conselho: "MG-999" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const depois = await fabricio();
    expect(depois.titulo_assinatura).toBe("Eng. de Segurança do Trabalho");
    const evs = await eventos("HABILITACAO_CORRIGIDA");
    expect(evs.map((ev) => ev.campo).sort()).toEqual(
      ["titulo_assinatura", "conselho", "registro_conselho"].filter((k) => (h as Record<string, unknown>)[k] !== (depois as Record<string, unknown>)[k]).sort(),
    );
    const titulo = evs.find((ev) => ev.campo === "titulo_assinatura")!;
    expect(JSON.stringify(titulo.valor_anterior)).toContain(h.titulo_assinatura);
  });

  it("título em branco reabre o popup com o digitado; sem permissão, 403", async () => {
    const h = await fabricio();
    await entrar(amb.cliente, "superintendente");
    const r = await amb.cliente.post(`/habilitacoes/${h.id}/corrigir`, { titulo_assinatura: " ", registro_conselho: "XYZ-1" });
    expect(abertos(r.text)).toEqual([`corrigir-hab-${h.id}`]);
    expect(r.text).toContain('value="XYZ-1"');
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.post(`/habilitacoes/${h.id}/corrigir`, { titulo_assinatura: "x" })).status).toBe(403);
    expect((await amb.cliente.post(`/habilitacoes/${h.id}/encerrar`)).status).toBe(403);
  });
});

// =====================================================================
describe("D11/D12: dados da conta e unicidade sem caixa", () => {
  it("o admin_ti corrige nome e e-mail da conta comum, um evento por campo", async () => {
    const alvo = await conta("servidor_consulta");
    await entrar(amb.cliente, "admin_ti");
    const tela = (await amb.cliente.get("/usuarios")).text;
    expect(tela).toContain(`action="/usuarios/${alvo.id}/dados"`);
    const r = await amb.cliente.post(
      `/usuarios/${alvo.id}/dados`,
      { nome: "Servidora Corrigida", login: alvo.login, email: "corrigido@teste.ufvjm.edu.br" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const depois = await conta("servidor_consulta");
    expect(depois.nome).toBe("Servidora Corrigida");
    expect(depois.email).toBe("corrigido@teste.ufvjm.edu.br");
    const evs = await eventos("USUARIO_ALTERADO");
    expect(evs.map((ev) => ev.campo).sort()).toEqual(["email", "nome"]);
  });

  it("conta de administração só por quem concede; credencial de conta técnica também", async () => {
    await entrar(amb.cliente, "admin_ti");
    const sup = await conta("superintendente");
    const r = await amb.cliente.post(`/usuarios/${sup.id}/dados`, { nome: "X", login: sup.login, email: sup.email });
    expect(r.text).toContain("é conta de administração");
    expect(abertos(r.text)).toEqual([`editar-conta-${sup.id}`]);
    const med = await conta("medico_trabalho");
    const login = await amb.cliente.post(`/usuarios/${med.id}/dados`, { nome: med.nome, login: "medico2", email: med.email });
    expect(login.text).toContain("login e e-mail são credenciais");
    expect((await conta("medico_trabalho")).login).toBe("medico_trabalho");
    // o nome, que não é credencial, se corrige
    const nome = await amb.cliente.post(`/usuarios/${med.id}/dados`, { nome: "Médica Corrigida", login: med.login, email: med.email }, { seguir: false });
    expect(nome.status).toBe(303);
  });

  it("login e e-mail repetidos em outra caixa são recusados, na criação e na edição", async () => {
    await entrar(amb.cliente, "superintendente");
    const criar = await amb.cliente.post("/usuarios", { login: "ADMIN_TI", nome: "Outra", email: "outra@teste.ufvjm.edu.br" });
    expect(criar.text).toContain("Já existe conta com este login");
    const email = await amb.cliente.post("/usuarios", { login: "outra", nome: "Outra", email: "ADMIN_TI@teste.ufvjm.edu.br" });
    expect(email.text).toContain("Já existe conta com este e-mail");
    const alvo = await conta("secretaria_csso");
    const editar = await amb.cliente.post(`/usuarios/${alvo.id}/dados`, { nome: alvo.nome, login: "Tecnico_Seguranca", email: alvo.email });
    expect(editar.text).toContain("já existe conta com este login");
    expect(abertos(editar.text)).toEqual([`editar-conta-${alvo.id}`]);
  });

  it("o banco recusa a duplicata sem caixa (índice da migração 0012)", async () => {
    await expect(
      amb.db.insert(e.usuario).values({ login: "Secretaria_CSSO", nome: "x", email: "x@teste.ufvjm.edu.br", senha_hash: "x" }),
    ).rejects.toThrow();
  });

  it("USUARIO_CRIADO grava o login aparado (D27)", async () => {
    await entrar(amb.cliente, "admin_ti");
    await amb.cliente.post("/usuarios", { login: "  aparado  ", nome: "Aparado", email: "aparado@teste.ufvjm.edu.br" });
    const [ev] = await eventos("USUARIO_CRIADO");
    expect(ev!.descricao).toBe("Conta 'aparado' criada.");
  });
});

// =====================================================================
describe("D7: bloqueio que vale, e a ação Desbloquear", () => {
  it("só o bloqueio vigente aparece, com a hora; desbloquear zera e audita", async () => {
    // a conta comum: o `admin_ti` desbloqueia o que ele poderia redefinir
    const alvo = await conta("servidor_consulta");
    await amb.db
      .update(e.usuario)
      .set({ bloqueado_ate: new Date(Date.now() - 60_000), tentativas_falhas: 5 })
      .where(eq(e.usuario.id, alvo.id));
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.get("/usuarios")).text).not.toMatch(/pilula erro">bloqueado/);
    await amb.db.update(e.usuario).set({ bloqueado_ate: new Date(Date.now() + 15 * 60_000) }).where(eq(e.usuario.id, alvo.id));
    const tela = (await amb.cliente.get("/usuarios")).text;
    expect(tela).toMatch(/pilula erro">bloqueado até \d{2}:\d{2}</);
    expect(tela).toContain(`action="/usuarios/${alvo.id}/desbloquear"`);
    const r = await amb.cliente.post(`/usuarios/${alvo.id}/desbloquear`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const depois = await conta("servidor_consulta");
    expect(depois.bloqueado_ate).toBeNull();
    expect(depois.tentativas_falhas).toBe(0);
    expect(depois.senha_hash).toBe(alvo.senha_hash);
    expect(await eventos("CONTA_DESBLOQUEADA")).toHaveLength(1);
  });

  it("desbloquear pede usuario.resetar_senha", async () => {
    const alvo = await conta("secretaria_csso");
    await entrar(amb.cliente, "coordenador_csso");
    expect((await amb.cliente.post(`/usuarios/${alvo.id}/desbloquear`)).status).toBe(403);
  });
});

// =====================================================================
describe("D13/D19/D20: a tela de concessão e de senha", () => {
  it("conceder perfil começa sem conta escolhida e sem conta inativa", async () => {
    const sec = await conta("secretaria_csso");
    await amb.db.update(e.usuario).set({ ativo: false }).where(eq(e.usuario.id, sec.id));
    await entrar(amb.cliente, "superintendente");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    const select = corpo.match(/<select id="perf-usuario"[\s\S]*?<\/select>/)![0];
    expect(select).toMatch(/<option value="" disabled selected>/);
    expect(select).not.toContain(`value="${sec.id}"`);
    expect(select).not.toMatch(/value="\d+" selected/);
  });

  it("Gerir leva ao popup de concessão já com a conta escolhida", async () => {
    const alvo = await conta("tecnico_seguranca");
    await entrar(amb.cliente, "superintendente");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    expect(corpo).toContain(`href="/usuarios?conceder=${alvo.id}#conceder-perfil"`);
    const aberto = (await amb.cliente.get(`/usuarios?conceder=${alvo.id}`)).text;
    expect(abertos(aberto)).toEqual(["conceder-perfil"]);
    const select = aberto.match(/<select id="perf-usuario"[\s\S]*?<\/select>/)![0];
    expect(select).toContain(`<option value="${alvo.id}" selected>`);
  });

  it("resetar senha pede confirmação num popup (D19)", async () => {
    const alvo = await conta("servidor_consulta");
    await entrar(amb.cliente, "admin_ti");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    expect(corpo).toMatch(new RegExp(`href="#resetar-senha-${alvo.id}"[^>]*>Resetar senha…<`));
    const popup = corpo.match(new RegExp(`<dialog class="popup" id="resetar-senha-${alvo.id}"[\\s\\S]*?</dialog>`))![0];
    expect(popup).toContain(`action="/usuarios/${alvo.id}/senha"`);
    expect(abertos(corpo)).toEqual([]);
  });

  it("a pílula e o Gerir dizem o campus da concessão (D20)", async () => {
    const [cp] = await amb.db.select().from(e.campus).orderBy(asc(e.campus.id)).limit(1);
    await criarUsuario(amb.db, { login: "tec_campus", perfis: ["tecnico_seguranca"], campus_id: cp!.id });
    await entrar(amb.cliente, "superintendente");
    const corpo = (await amb.cliente.get("/usuarios")).text;
    expect(corpo).toMatch(new RegExp(`>Técnico de Segurança do Trabalho<span class="discreto"> · ${cp!.sigla}</span>|· ${cp!.sigla}<`));
    expect(corpo).toContain(" · todos os campi");
  });
});

// =====================================================================
describe("D23/D27: concessão validada e trilha completa", () => {
  it("fim antes do início, fim já passado, duplicada e perfil inativo voltam no popup", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("secretaria_csso");
    const tec = await perfil("tecnico_seguranca");
    const base = { usuario_alvo: String(alvo.id), perfil_id: String(tec.id) };
    const invertida = await conceder(amb.cliente, { ...base, vigencia_inicio: "2030-02-01", vigencia_fim: "2030-01-01" });
    expect(invertida.text).toContain("a vigência termina antes de começar");
    expect(abertos(invertida.text)).toEqual(["conceder-perfil"]);
    expect(invertida.text).toContain('value="2030-02-01"');
    const passada = await conceder(amb.cliente, { ...base, vigencia_inicio: "2020-01-01", vigencia_fim: "2020-12-31" });
    expect(passada.text).toContain("a vigência já terminou");
    expect((await conceder(amb.cliente, base)).status).toBe(303);
    const repetida = await conceder(amb.cliente, base);
    expect(repetida.text).toContain("já tem o perfil");
    await amb.db.update(e.perfil).set({ ativo: false }).where(eq(e.perfil.codigo, "consulta_progep"));
    const inativo = await conceder(amb.cliente, { usuario_alvo: String(alvo.id), perfil_id: String((await perfil("consulta_progep")).id) });
    expect(inativo.text).toContain("está inativo");
    // o select nem oferece o perfil inativo
    const select = inativo.text.match(/<select id="perf-perfil"[\s\S]*?<\/select>/)![0];
    expect(select).not.toContain(`value="${(await perfil("consulta_progep")).id}"`);
    expect((await atribuicoesDe("secretaria_csso")).filter((a) => a.perfil.codigo === "tecnico_seguranca")).toHaveLength(1);
  });

  it("PERFIL_CONCEDIDO diz a conta, o campus e a vigência (D27)", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("secretaria_csso");
    await conceder(amb.cliente, { usuario_alvo: String(alvo.id), perfil_id: String((await perfil("tecnico_seguranca")).id), ato_normativo: "Portaria 9/2026" });
    const [ev] = (await eventos("PERFIL_CONCEDIDO")).slice(-1);
    expect(ev!.descricao).toMatch(/^Perfil tecnico_seguranca concedido a 'secretaria_csso' \(todos os campi; vigência \d{2}\/\d{2}\/\d{4} a sem termo\) — ato: Portaria 9\/2026$/);
  });

  it("a concessão futura se cancela, sem fim antes do início", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("secretaria_csso");
    const inicio = somar_dias(hoje_iso(), 10);
    await conceder(amb.cliente, { usuario_alvo: String(alvo.id), perfil_id: String((await perfil("tecnico_seguranca")).id), vigencia_inicio: inicio });
    const futura = (await atribuicoesDe("secretaria_csso")).find((a) => a.perfil.codigo === "tecnico_seguranca")!;
    const corpo = (await amb.cliente.get("/usuarios")).text;
    expect(corpo).toContain("Cancelar concessão…");
    expect(corpo).toContain("ainda não começou");
    const r = await amb.cliente.post(`/usuarios/atribuicoes/${futura.id}/encerrar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const [linha] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.id, futura.id));
    expect(linha!.vigencia_fim).toBe(somar_dias(inicio, -1));
    expect(await eventos("PERFIL_CANCELADO")).toHaveLength(1);
    expect(await eventos("PERFIL_ENCERRADO")).toHaveLength(0);
  });
});

// =====================================================================
describe("D24: a matriz de perfis", () => {
  it("abre para o admin_ti e mostra o alcance de cada perfil", async () => {
    await entrar(amb.cliente, "admin_ti");
    const r = await amb.cliente.get("/perfis");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Alcance:");
    expect(r.text).toContain("agregado — só contagens; nenhuma linha");
    expect((await amb.cliente.get("/usuarios")).text).toContain('href="/perfis"');
  });
});

// =====================================================================
describe("D17: cobertura de quem concede perfil", () => {
  // a conta de teste do Administrador do sistema também concede perfil, sem
  // termo: com ela a cobertura nunca acabaria, e estes testes medem a do
  // superintendente
  beforeEach(async () => {
    await amb.db.delete(e.atribuicao).where(eq(e.atribuicao.perfil_id, (await perfil("administrador_sistema")).id));
  });

  async function concessaoDoSuperintendente() {
    return (await atribuicoesDe("superintendente")).find((a) => a.perfil.codigo === "superintendente")!;
  }

  it("concessão que vence em breve vira aviso no sino de quem concede, e some quando outra emenda", async () => {
    const a = await concessaoDoSuperintendente();
    const fim = somar_dias(hoje_iso(), 10);
    await amb.db.update(e.atribuicao).set({ vigencia_fim: fim }).where(eq(e.atribuicao.id, a.id));
    expect(await governanca.fim_da_cobertura(amb.db)).toBe(somar_dias(fim, 1));
    const r = await naTransacao((tx) => governanca.sincronizar_aviso_de_cobertura(tx));
    expect(r.abertas).toBe(1);
    const sup = await conta("superintendente");
    const [p] = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.tipo, governanca.TIPO_PENDENCIA));
    expect(p!.responsavel_id).toBe(sup.id);
    expect(p!.prazo).toBe(fim);
    await entrar(amb.cliente, "superintendente");
    expect((await amb.cliente.get("/usuarios")).text).toContain("ninguém concede perfil");
    // outra conta recebe superintendente sem termo: o aviso fecha sozinho
    const coord = await conta("coordenador_csso");
    expect((await conceder(amb.cliente, { usuario_alvo: String(coord.id), perfil_id: String((await perfil("superintendente")).id) })).status).toBe(303);
    expect(await governanca.fim_da_cobertura(amb.db)).toBeNull();
    const [fechada] = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.id, p!.id));
    expect(fechada!.concluida).toBe(true);
  });

  it("concessões futuras que emendam contam na cobertura", async () => {
    const a = await concessaoDoSuperintendente();
    const fim = somar_dias(hoje_iso(), 5);
    await amb.db.update(e.atribuicao).set({ vigencia_fim: fim }).where(eq(e.atribuicao.id, a.id));
    const sup = await perfil("superintendente");
    const coord = await conta("coordenador_csso");
    await amb.db.insert(e.atribuicao).values({
      usuario_id: coord.id,
      perfil_id: sup.id,
      vigencia_inicio: somar_dias(fim, 1),
      vigencia_fim: somar_dias(fim, 40),
      ato_normativo: "teste",
    });
    expect(await governanca.fim_da_cobertura(amb.db)).toBe(somar_dias(fim, 41));
  });

  it("conceder, encerrar e inativar esperam a trava de governança", async () => {
    // segura a trava numa transação à parte e confere que cada ato espera por ela
    const sec = await conta("secretaria_csso");
    const tec = await perfil("tecnico_seguranca");
    const a_sec = (await atribuicoesDe("secretaria_csso"))[0]!;
    await entrar(amb.cliente, "superintendente");
    const atos = [
      () => conceder(amb.cliente, { usuario_alvo: String(sec.id), perfil_id: String(tec.id) }),
      () => amb.cliente.post(`/usuarios/atribuicoes/${a_sec.id}/encerrar`, {}, { seguir: false }),
      () => amb.cliente.post(`/usuarios/${sec.id}/inativar`, {}, { seguir: false }),
    ];
    for (const ato of atos) {
      let soltar!: () => void;
      const segurando = new Promise<void>((r) => (soltar = r));
      let travada!: () => void;
      const pronta = new Promise<void>((r) => (travada = r));
      // conexão PRÓPRIA: o pool do app tem uma só (CSSO_POOL_MAX), e segurar
      // a trava nela travaria o pedido pela conexão, e não pela trava
      const fora = postgres(amb.url, { max: 1, onnotice: () => {} });
      const dona = fora
        .begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(${governanca.TRAVA_GOVERNANCA})`;
          travada();
          await segurando;
        })
        .finally(() => fora.end());
      await pronta;
      let terminou = false;
      const pedido = ato().then((r) => {
        terminou = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(terminou).toBe(false);
      soltar();
      await dona;
      expect((await pedido).status).toBe(303);
    }
  });

  it("a linha de comando concede superintendente quando ninguém mais concede", async () => {
    await criarUsuario(amb.db, { login: "resgate" });
    const r = await naTransacao((tx) => redefinirSenha.conceder_superintendente(tx, "resgate"));
    expect(r).toBe("concedido");
    expect((await carregar_usuario_atual(amb.db, (await conta("resgate")).id)).pode("perfil.conceder")).toBe(true);
    const [ev] = (await eventos("PERFIL_CONCEDIDO")).slice(-1);
    expect(ev!.usuario_nome).toBe(redefinirSenha.ATOR);
    expect(ev!.descricao).toContain("'resgate'");
    expect(await naTransacao((tx) => redefinirSenha.conceder_superintendente(tx, "resgate"))).toBe("ja_tinha");
    expect(await naTransacao((tx) => redefinirSenha.conceder_superintendente(tx, "ninguem"))).toBeNull();
  });
});
