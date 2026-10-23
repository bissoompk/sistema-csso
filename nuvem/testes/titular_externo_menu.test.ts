/**
 * O terceirizado e o discente (perfis externos, conta sem `servidor_id`) entram
 * no sistema e acham o que é deles: o "Meu espaço" com Meus treinamentos, Meus
 * certificados, Comunicar acidente e Minhas comunicações — e nada de EPI,
 * processo ou adicional. O "Sou eu" do comunicar entra pelo nome da conta, com o
 * vínculo do perfil. O servidor comum continua como era. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import { meu_espaco_de, navegacao, primeira_tela, tem_titular } from "../src/modulos.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Campos, type Cliente } from "./ajuda.js";
import { dados, envolvido, titular } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const como = (login: string) => entrar(novoCliente(), login);

const EXTERNOS = [
  ["terceirizado", "TERCEIRIZADO", "Terceirizado de Teste"],
  ["discente", "ESTUDANTE", "Discente de Teste"],
] as const;

const DELE = ["Meus treinamentos", "Meus certificados", "Comunicar acidente", "Minhas comunicações", "Meu perfil"];
const NAO_DELE = ["Pedir EPI", "Minha ficha de EPI", "Meus pedidos de EPI", "Meus processos", "Meu adicional", "Comprovante de treinamentos"];

function formulario(extra: Campos = {}): Campos {
  return {
    env_indice: "1",
    env_1_sou_eu: "1",
    // o vínculo do formulário não manda: o do perfil é que vale
    env_1_vinculo: "VISITANTE",
    // e o nome digitado também não: vale o da conta
    env_1_nome_externo: "Outro Nome Qualquer",
    env_1_condicao: "ACIDENTADO",
    env_1_houve_lesao: "SIM",
    especie: "TIPICO",
    data_evento: somar_dias(hoje_iso(), -2),
    hora_evento: "10:15",
    jornada: "01:30",
    local_tipo: "LABORATORIO",
    local_especificacao: "Laboratório fictício, bancada 2",
    local_uf: "MG",
    descricao: "A bandeja escorregou da prateleira durante a arrumação.",
    test_1_nome: "Testemunha Fictícia",
    test_1_contato: "ramal 999",
    declaracao: "1",
    ...extra,
  };
}

describe.each(EXTERNOS)("conta %s", (login, vinculo, nome) => {
  it("é titular sem servidor, e o Meu espaço tem o que é dela e nada de EPI, processo ou adicional", async () => {
    const u = await usuarioAtual(db, login);
    expect(u.servidor_id).toBeNull();
    expect(tem_titular(u)).toBe(true);
    // ela não tem as permissões de EPI e processo: a primeira tranca
    for (const p of ["epi.ver", "epi.requisitar", "processo.ver"]) expect(u.pode(p)).toBe(false);
    const rotulos = meu_espaco_de(u).map((i) => i.rotulo);
    for (const r of DELE) expect(rotulos).toContain(r);
    for (const r of NAO_DELE) expect(rotulos).not.toContain(r);
    // o Início do servidor e a Minha atividade moram no cadastro de servidor
    expect(rotulos).not.toContain("Início");
    expect(rotulos).not.toContain("Minha atividade");
    expect(navegacao("/minha-conta", u).so_meu_espaco).toBe(true);
    expect(primeira_tela(u)).toBe("/turmas/minhas");
  });

  it("entra sem 403: o destino do login e o / levam ao Meu espaço", async () => {
    const cli = await como(login);
    const inicio = await cli.get("/inicio", { seguir: false });
    expect(inicio.status).toBe(303);
    expect(inicio.location).toBe("/turmas/minhas");
    const raiz = await cli.get("/", { seguir: false });
    expect(raiz.status).toBe(303);
    expect(raiz.location).toBe("/turmas/minhas");
    const seguido = await cli.get("/");
    expect(seguido.status).not.toBe(403);
    expect(seguido.url).toBe("/turmas/minhas");
  });

  it("o menu da tela mostra Comunicar acidente e Minhas comunicações, e esconde EPI e processo", async () => {
    const cli = await como(login);
    const r = await cli.get("/minha-conta");
    expect(r.status).toBe(200);
    for (const rotulo of DELE) expect(r.text).toContain(rotulo);
    for (const rotulo of ["Pedir EPI", "Minha ficha de EPI", "Meus processos"]) expect(r.text).not.toContain(rotulo);
    expect(r.text).toContain('href="/acidentes/comunicar"');
    // o aviso não manda pedir à coordenação um vínculo de servidor
    expect(r.text).not.toContain("Esta conta não está ligada a um cadastro de servidor");
  });

  it("a Minha atividade explica sem mandar pedir o vínculo", async () => {
    const cli = await como(login);
    const r = await cli.get("/minha-atividade");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("peça à coordenação que ligue a sua conta");
    expect(r.text).toContain("Meus treinamentos");
  });

  it("a tela de comunicar oferece o Sou eu com o vínculo do perfil pré-marcado", async () => {
    const cli = await como(login);
    const r = await cli.get("/acidentes/comunicar");
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="env_1_sou_eu"');
    expect(r.text).toMatch(new RegExp(`<option value="${vinculo}"\\s+selected`));
  });

  it("comunica marcando Sou eu: o acidentado entra pelo nome da conta e o vínculo do perfil", async () => {
    const cli = await como(login);
    const r = await cli.post("/acidentes/comunicar", formulario(), { seguir: false });
    expect(r.status).toBe(303);
    const id = Number(/^\/acidentes\/(\d+)\?/.exec(r.location ?? "")?.[1]);
    expect(id).toBeGreaterThan(0);
    const [oc] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, id));
    expect(oc!.origem).toBe("TITULAR");
    expect(oc!.servidor_id).toBeNull();
    const acidentados = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, id));
    expect(acidentados).toHaveLength(1);
    expect(acidentados[0]!.nome_externo).toBe(nome);
    expect(acidentados[0]!.vinculo).toBe(vinculo);
    expect(acidentados[0]!.servidor_id).toBeNull();
    // a ficha abre para quem comunicou, e a ocorrência está nas comunicações dela
    expect((await cli.get(r.location!)).status).toBe(200);
    const minhas = await cli.get("/acidentes/minhas");
    expect(minhas.status).toBe(200);
    expect(minhas.text).toContain(oc!.protocolo);
  });

  it("não pede EPI: /epis/requisicoes/nova dá 403", async () => {
    const cli = await como(login);
    expect((await cli.get("/epis/requisicoes/nova")).status).toBe(403);
  });
});

describe("o servidor comum continua como era", () => {
  it("o Meu espaço tem o EPI, o adicional e agora o Comunicar acidente", async () => {
    const { usuario } = await titular(db);
    expect(tem_titular(usuario)).toBe(true);
    const rotulos = meu_espaco_de(usuario).map((i) => i.rotulo);
    for (const r of ["Início", "Meus treinamentos", "Meus certificados", "Comprovante de treinamentos", "Minha ficha de EPI",
      "Meus pedidos de EPI", "Pedir EPI", "Comunicar acidente", "Minhas comunicações", "Meu adicional", "Meus processos",
      "Minha atividade", "Meu perfil"]) {
      expect(rotulos).toContain(r);
    }
    expect(primeira_tela(usuario)).toBe("/");
  });

  it("o Sou eu continua entrando pelo cadastro de servidor", async () => {
    const { usuario, servidor } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const [a] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    expect(a!.servidor_id).toBe(servidor.id);
    expect(a!.vinculo).toBe("SERVIDOR");
    expect(a!.nome_externo).toBeNull();
  });

  it("a conta sem servidor e sem perfil externo continua recusada no Sou eu", async () => {
    // o servidor_consulta sem vínculo: nem servidor, nem externo
    const u = await usuarioAtual(db, "servidor_consulta");
    expect(u.servidor_id).toBeNull();
    expect(tem_titular(u)).toBe(false);
    await expect(
      db.transaction((tx) => comunicacao.comunicar(tx, u, dados({ envolvidos: [envolvido({ sou_eu: true })] }))),
    ).rejects.toThrow(/não está ligada a um cadastro de servidor/);
  });
});
