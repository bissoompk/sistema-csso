/**
 * O perfil Administrador do sistema (23/10/2026): acima de todos, com toda
 * permissão menos o ato técnico (IN 15/2022), escopo total, nível mais alto em
 * todo módulo, concedido só por quem já o tem — e a ferramenta de linha de
 * comando que faz a primeira concessão (`ferramentas/conceder-administrador.ts`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import {
  ESCOPO_POR_PERFIL,
  ESCOPO_TOTAL,
  MATRIZ_PERFIS,
  PERFIL_ADMINISTRADOR_SISTEMA,
  PERMISSOES,
  SO_DO_TECNICO_HABILITADO,
  TOPO_DA_HIERARQUIA,
  aceita_nivel_modulo,
  carregar_usuario_atual,
  permissoes_do_administrador_sistema,
  pode_subscrever,
} from "../src/servicos/rbac.js";
import { MODULOS_NIVELADOS, OPERACAO, PERFIS_NO_NIVEL_MAIS_ALTO } from "../src/servicos/niveis_modulo.js";
import { identidadeDoBanco } from "../src/servicos/instalacao.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as ferramenta from "../ferramentas/conceder-administrador.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";

const ADMIN = PERFIL_ADMINISTRADOR_SISTEMA;
const TECNICAS = [...SO_DO_TECNICO_HABILITADO];

let amb: AmbienteDeTeste = await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
});

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
async function perfisDe(login: string) {
  const u = await conta(login);
  const linhas = await amb.db.query.atribuicao.findMany({ where: eq(e.atribuicao.usuario_id, u.id), with: { perfil: true } });
  return linhas;
}

// =====================================================================
describe("a matriz", () => {
  it("tem toda permissão do sistema, menos as do ato técnico", () => {
    const dele = new Set(MATRIZ_PERFIS[ADMIN]!.permissoes);
    for (const p of Object.keys(PERMISSOES)) expect(dele.has(p), p).toBe(!SO_DO_TECNICO_HABILITADO.has(p));
    for (const p of TECNICAS) expect(dele.has(p), p).toBe(false);
    for (const p of [
      "perfil.conceder",
      "habilitacao.atestar",
      "usuario.criar_conta",
      "usuario.resetar_senha",
      "auditoria.ver",
      "backup.executar",
      "turma.todos_os_setores",
      "catalogo.gerenciar",
      "exposicao.ver",
      "epi.ficha",
      "certificado.ver",
      "indicador.ver",
      "exportar",
    ]) {
      expect(dele.has(p), p).toBe(true);
    }
  });

  it("cobre a união de todos os outros perfis da matriz (menos o ato técnico)", () => {
    const dele = new Set(MATRIZ_PERFIS[ADMIN]!.permissoes);
    for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
      for (const p of dados.permissoes) {
        if (!SO_DO_TECNICO_HABILITADO.has(p)) expect(dele.has(p), `${codigo}: ${p}`).toBe(true);
      }
    }
  });

  it("a lista é derivada: permissão nova entra sozinha", () => {
    PERMISSOES["modulo_futuro.operar"] = "Permissão de um módulo que ainda não existe";
    try {
      expect(permissoes_do_administrador_sistema()).toContain("modulo_futuro.operar");
      expect(permissoes_do_administrador_sistema()).not.toContain("parecer.assinar");
    } finally {
      delete PERMISSOES["modulo_futuro.operar"];
    }
  });

  it("escopo total, nível mais alto em todo módulo e topo da hierarquia", () => {
    expect(ESCOPO_POR_PERFIL[ADMIN]).toBe(ESCOPO_TOTAL);
    expect(aceita_nivel_modulo(ADMIN)).toBe(false);
    expect(Object.keys(PERFIS_NO_NIVEL_MAIS_ALTO)).toContain(ADMIN);
    for (const m of MODULOS_NIVELADOS) expect(PERFIS_NO_NIVEL_MAIS_ALTO[ADMIN]![m.codigo], m.codigo).toBe(OPERACAO);
    expect(TOPO_DA_HIERARQUIA[0]).toBe(ADMIN);
    expect(TOPO_DA_HIERARQUIA.indexOf(ADMIN)).toBeLessThan(TOPO_DA_HIERARQUIA.indexOf("superintendente"));
  });
});

// =====================================================================
describe("no banco", () => {
  it("a semeadura grava o perfil com as permissões da matriz", async () => {
    const pf = await amb.db.query.perfil.findFirst({
      where: eq(e.perfil.codigo, ADMIN),
      with: { perfil_permissoes: { with: { permissao: true } } },
    });
    expect(pf!.nome).toBe("Administrador do sistema");
    expect(pf!.perfil_permissoes.map((pp) => pp.permissao.codigo).sort()).toEqual(
      [...MATRIZ_PERFIS[ADMIN]!.permissoes].sort(),
    );
  });

  it("a conta pode tudo em escopo total, mas não assina nem com habilitação (IN 15/2022)", async () => {
    const u = await conta(ADMIN);
    await amb.db.insert(e.profissional_habilitado).values({
      usuario_id: u.id,
      nome: "Admin habilitado de teste",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "Eng. Seg. do Trabalho",
      vigencia_inicio: "2020-01-01",
    });
    const atual = await carregar_usuario_atual(amb.db, u.id);
    for (const p of Object.keys(PERMISSOES)) expect(atual.pode(p), p).toBe(!SO_DO_TECNICO_HABILITADO.has(p));
    expect(atual.escopo).toBe(ESCOPO_TOTAL);
    expect(atual.alcance("exposicao.ver").total).toBe(true);
    expect(atual.ve_dado_nominal_sem_recorte()).toBe(true);
    expect(await pode_subscrever(amb.db, atual)).toBe(false);
  });

  it("nível por módulo gravado no perfil ou na pessoa não o rebaixa", async () => {
    const u = await conta(ADMIN);
    const pf = await perfil(ADMIN);
    await amb.db.insert(e.perfil_nivel_modulo).values({ perfil_id: pf.id, modulo: "epis", nivel: "SEM_ACESSO" });
    await amb.db.insert(e.usuario_nivel_modulo).values({ usuario_id: u.id, modulo: "certificados", nivel: "SEM_ACESSO" });
    const atual = await carregar_usuario_atual(amb.db, u.id);
    expect(atual.pode("epi.analisar")).toBe(true);
    expect(atual.pode("certificado.anular")).toBe(true);
  });

  it("a tela de níveis recusa ajustar o perfil", async () => {
    await entrar(amb.cliente, ADMIN);
    const pf = await perfil(ADMIN);
    const r = await amb.cliente.post(`/perfis/${pf.id}/niveis`, { nivel_epis: "CONSULTA" });
    expect(r.text).toContain("sempre no nível mais alto");
    expect(await amb.db.select().from(e.perfil_nivel_modulo)).toHaveLength(0);
  });
});

// =====================================================================
describe("quem concede", () => {
  it("o superintendente não concede o Administrador do sistema a outra conta; a recusa fica na trilha", async () => {
    await entrar(amb.cliente, "superintendente");
    const alvo = await conta("coordenador_csso");
    const adm = await perfil(ADMIN);
    const r = await amb.cliente.post("/usuarios/0/atribuicoes", { usuario_alvo: String(alvo.id), perfil_id: String(adm.id) }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toContain("nem o superintendente");
    expect((await perfisDe("coordenador_csso")).map((a) => a.perfil.codigo)).toEqual(["coordenador_csso"]);
    const recusas = await eventos("PERFIL_CONCESSAO_RECUSADA");
    expect(recusas.some((ev) => ev.entidade_id === alvo.id && ev.descricao.includes(ADMIN))).toBe(true);
  });

  it("nem a si mesmo, nem criando conta nova com ele; e a opção nem aparece para ele", async () => {
    await entrar(amb.cliente, "superintendente");
    const eu = await conta("superintendente");
    const adm = await perfil(ADMIN);
    await amb.cliente.post("/usuarios/0/atribuicoes", { usuario_alvo: String(eu.id), perfil_id: String(adm.id) });
    expect((await perfisDe("superintendente")).map((a) => a.perfil.codigo)).toEqual(["superintendente"]);
    const r = await amb.cliente.post("/usuarios", {
      login: "novo.adm",
      nome: "Novo Adm",
      email: "novo.adm@teste.ufvjm.edu.br",
      perfil_id: String(adm.id),
    });
    expect(r.text).toContain("Conta não criada");
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "novo.adm"))).toHaveLength(0);
    const tela = (await amb.cliente.get("/usuarios")).text;
    expect(tela).not.toMatch(/<option value="\d+"[^>]*>Administrador do sistema — /);
  });

  it("o Administrador do sistema concede o próprio perfil a outra conta", async () => {
    await entrar(amb.cliente, ADMIN);
    const adm = await perfil(ADMIN);
    expect((await amb.cliente.get("/usuarios")).text).toMatch(/<option value="\d+"[^>]*>Administrador do sistema — /);
    const alvo = await conta("coordenador_csso");
    const r = await amb.cliente.post("/usuarios/0/atribuicoes", { usuario_alvo: String(alvo.id), perfil_id: String(adm.id) }, { seguir: false });
    expect(r.status).toBe(303);
    expect((await perfisDe("coordenador_csso")).map((a) => a.perfil.codigo).sort()).toEqual([ADMIN, "coordenador_csso"].sort());
    const concedidos = await eventos("PERFIL_CONCEDIDO");
    expect(concedidos.some((ev) => ev.descricao.includes(`Perfil ${ADMIN} concedido a 'coordenador_csso'`))).toBe(true);
  });

  it("o superintendente não mexe na conta do Administrador do sistema; outro Administrador, sim", async () => {
    const alvo = await conta(ADMIN);
    const sup = amb.novoCliente();
    await entrar(sup, "superintendente");
    let r = await sup.post(`/usuarios/${alvo.id}/senha`, {});
    expect(r.text).toContain("só outro Administrador do sistema");
    r = await sup.post(`/usuarios/${alvo.id}/inativar`, {});
    expect(r.text).toContain("só outro Administrador do sistema");
    expect((await conta(ADMIN)).ativo).toBe(true);
    r = await sup.post(`/usuarios/${alvo.id}/dados`, { nome: "Outro nome", login: alvo.login, email: alvo.email });
    expect(r.text).toContain("só outro Administrador do sistema");
    const [concessao] = await amb.db
      .select()
      .from(e.atribuicao)
      .where(and(eq(e.atribuicao.usuario_id, alvo.id), eq(e.atribuicao.perfil_id, (await perfil(ADMIN)).id)));
    r = await sup.post(`/usuarios/atribuicoes/${concessao!.id}/encerrar`, {});
    expect(r.text).toContain("nem o superintendente");
    const [igual] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.id, concessao!.id));
    expect(igual!.vigencia_fim).toBeNull();

    // um segundo Administrador do sistema encerra o perfil do primeiro
    await criarUsuario(amb.db, { login: "adm2", perfis: [ADMIN] });
    const adm2 = amb.novoCliente();
    await entrar(adm2, "adm2");
    r = await adm2.post(`/usuarios/atribuicoes/${concessao!.id}/encerrar`, {}, { seguir: false });
    expect(r.status).toBe(303);
    const [encerrada] = await amb.db.select().from(e.atribuicao).where(eq(e.atribuicao.id, concessao!.id));
    expect(encerrada!.vigencia_fim).not.toBeNull();
  });
});

// =====================================================================
describe("ferramentas/conceder-administrador.ts", () => {
  function saida(respostas: string[] = []) {
    const linhas: string[] = [];
    const erros: string[] = [];
    let perguntas = 0;
    return {
      linhas,
      erros,
      get perguntas() {
        return perguntas;
      },
      s: {
        log: (l: string) => linhas.push(l),
        erro: (l: string) => erros.push(l),
        perguntar: async () => {
          perguntas += 1;
          return respostas.shift() ?? "";
        },
      },
    };
  }
  const identidade = () => identidadeDoBanco(amb.url);

  it("conta existente: mostra a identidade, pede confirmação e concede com o ato e o ator da linha de comando", async () => {
    const alvo = await conta("superintendente");
    const o = saida([identidade()]);
    expect(await ferramenta.principal(["--email", alvo.email.toUpperCase()], o.s)).toBe(0);
    expect(o.perguntas).toBe(1);
    expect(o.linhas.join("\n")).toContain(identidade());
    expect(o.linhas.join("\n")).not.toContain(amb.url);
    expect(o.linhas.join("\n")).not.toMatch(/Senha provisória/);
    const [concessao] = (await perfisDe("superintendente")).filter((a) => a.perfil.codigo === ADMIN);
    expect(concessao!.campus_id).toBeNull();
    expect(concessao!.vigencia_fim).toBeNull();
    expect(concessao!.ato_normativo).toContain(ferramenta.ATO);
    const [ev] = (await eventos("PERFIL_CONCEDIDO")).filter((ev) => ev.entidade_id === concessao!.id);
    expect(ev!.usuario_nome).toBe(ferramenta.ATOR);
    expect(ev!.descricao).toContain("todos os campi");
    // a senha da conta não mudou
    expect(await autenticacao.conferir_senha((await conta("superintendente")).senha_hash, "SenhaDeTeste2026")).toBe(true);

    // de novo: nada concedido
    const o2 = saida();
    expect(await ferramenta.principal(["--email", alvo.email, "--confirmar", identidade()], o2.s)).toBe(0);
    expect(o2.linhas.join("\n")).toContain("nada concedido");
    expect((await perfisDe("superintendente")).filter((a) => a.perfil.codigo === ADMIN)).toHaveLength(1);
  });

  it("sem a confirmação certa, nada é gravado", async () => {
    const o = saida(["outro-banco"]);
    expect(await ferramenta.principal(["--email", (await conta("coordenador_csso")).email], o.s)).toBe(3);
    expect(o.erros.join("\n")).toContain("Nada foi alterado");
    expect((await perfisDe("coordenador_csso")).map((a) => a.perfil.codigo)).toEqual(["coordenador_csso"]);
    expect(await ferramenta.principal(["--email", "ninguem@x.br", "--nome", "Fulano", "--confirmar", "errada"], saida().s)).toBe(3);
    expect(await amb.db.select().from(e.usuario).where(eq(e.usuario.email, "ninguem@x.br"))).toHaveLength(0);
  });

  it("conta nova: login = e-mail normalizado, senha forte mostrada uma vez e troca obrigatória", async () => {
    const o = saida();
    const codigo = await ferramenta.principal(
      ["--email", "  Fabricio.Adm@UFVJM.edu.br ", "--nome", "Fabrício Administrador", "--confirmar", identidade()],
      o.s,
    );
    expect(codigo).toBe(0);
    const [nova] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "fabricio.adm@ufvjm.edu.br"));
    expect(nova!.email).toBe("fabricio.adm@ufvjm.edu.br");
    expect(nova!.precisa_trocar_senha).toBe(true);
    const linha = o.linhas.find((l) => l.startsWith("Senha provisória:"))!;
    const senha = linha.replace("Senha provisória:", "").trim();
    expect(senha).toHaveLength(20);
    expect(autenticacao.politica_de_senha(senha)).toEqual([]);
    expect(await autenticacao.conferir_senha(nova!.senha_hash, senha)).toBe(true);
    expect(o.linhas.filter((l) => l.includes(senha))).toHaveLength(1);
    // a senha não vai para a trilha
    const trilha = await amb.db.select().from(e.historico_evento);
    expect(trilha.some((ev) => JSON.stringify(ev).includes(senha))).toBe(false);
    const [criada] = (await eventos("USUARIO_CRIADO")).filter((ev) => ev.entidade_id === nova!.id);
    expect(criada!.usuario_nome).toBe(ferramenta.ATOR);
    const atual = await carregar_usuario_atual(amb.db, nova!.id);
    expect(atual.perfis).toEqual([ADMIN]);
    expect(atual.pode("perfil.conceder")).toBe(true);
  });

  it("conta inexistente sem --nome não cria nada; --login vale como sinônimo para conta antiga", async () => {
    const o = saida();
    expect(await ferramenta.principal(["--email", "nao.existe@ufvjm.edu.br", "--confirmar", identidade()], o.s)).toBe(2);
    expect(o.erros.join("\n")).toContain("--nome");
    expect(await ferramenta.principal([], saida().s)).toBe(1);

    expect(await ferramenta.principal(["--login", "tecnico_seguranca", "--confirmar", identidade()], saida().s)).toBe(0);
    expect((await perfisDe("tecnico_seguranca")).map((a) => a.perfil.codigo)).toContain(ADMIN);
  });

  it("executar na transação de quem chama, idempotente", async () => {
    const o = ferramenta.lerOpcoes(["--email", (await conta("secretaria_csso")).email]);
    if (typeof o === "string") throw new Error(o);
    const feito = await naTransacao((tx) => ferramenta.executar(tx, o));
    expect(feito).toMatchObject({ login: "secretaria_csso", criada: false, concedido: true, senha: null });
    const de_novo = await naTransacao((tx) => ferramenta.executar(tx, o));
    expect(de_novo.concedido).toBe(false);
  });
});
