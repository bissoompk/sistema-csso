/**
 * Fatia D da paridade de EPI: `/epis/relatorios` por período livre, com o
 * total entregue, o ranking por EPI e a distribuição por cargo.
 *
 * Origem no legado: `L:EPI_Backend.js:1110-1194` e `L:EPI_Frontend.html:1313-1339`
 * (período padrão, soma das quantidades, rankings decrescentes) — sem a data de
 * reserva que lia a coluna errada e sem deixar passar item sem data.
 *
 * As entregas nascem pela entrega de balcão (`epi_ficha.registrar_entrega`),
 * e não por requisição.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { obterBanco, type Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as epi_indicadores from "../src/servicos/epi_indicadores.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import * as rota from "../src/rotas/epi_indicadores.js";
import { MARCA_SUPRIMIDO } from "../src/rotas/epi_indicadores.js";
import { ErroHttp } from "../src/nucleo/erros.js";
import { bancoLimpo, contas, entrar, naTransacao, SENHA_TESTE } from "./ajuda";

const HOJE = hoje();
const DAQUI_A_UM_ANO = somar_dias(HOJE, 365);
const { novoCliente } = await bancoLimpo();
const HASH = await autenticacao.gerar_hash(SENHA_TESTE);

class Desfazer extends Error {}

/** Roda `f` numa transação e a desfaz no fim. */
async function emSessao(f: (tx: Executor) => Promise<void>): Promise<void> {
  try {
    await obterBanco().transaction(async (tx) => {
      await f(tx);
      throw new Desfazer();
    });
  } catch (erro) {
    if (!(erro instanceof Desfazer)) throw erro;
  }
}

type Item = typeof e.epi_item.$inferSelect;
type Servidor = typeof e.servidor.$inferSelect;

let _n = 0;
async function _operador(tx: Executor): Promise<UsuarioAtual> {
  const unico = `operador_d_${++_n}_${Date.now() % 100000}`;
  const [registro] = await tx
    .insert(e.usuario)
    .values({ login: unico, nome: "Operador", email: `${unico}@teste.ufvjm.edu.br`, senha_hash: HASH, precisa_trocar_senha: false })
    .returning();
  return new UsuarioAtual({
    id: registro!.id,
    login: unico,
    nome: registro!.nome,
    permissoes: ["epi.ver", "epi.entregar", "epi.estoque"],
    perfis: ["coordenador_csso"],
    servidor_id: null,
  });
}

function _leitor(...permissoes: string[]): UsuarioAtual {
  return new UsuarioAtual({ id: 1, login: "leitor", nome: "Leitor", permissoes, perfis: ["auditor_interno"] });
}
const NOMINAL = () => _leitor("indicador.ver", "exposicao.ver", "exportar");
const SEM_NOMINAL = () => _leitor("indicador.ver", "exportar");

async function _item(tx: Executor, nome: string): Promise<Item> {
  const [categoria] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
  const [item] = await tx
    .insert(e.epi_item)
    .values({
      nome,
      categoria_id: categoria!.id,
      exige_ca: true,
      numero_ca: "41234",
      validade_ca: DAQUI_A_UM_ANO,
      unidade_medida: "PAR",
      tamanhos: "P\nM\nG",
      vida_util_meses: null,
      quantidade_padrao: 1,
    })
    .returning();
  return item!;
}

async function _cargo(tx: Executor, nome: string): Promise<number> {
  const [c] = await tx.insert(e.cargo).values({ nome }).returning();
  return c!.id;
}

let _siape = 3_100_000;
async function _servidores(tx: Executor, quantos: number, cargo_id?: number): Promise<Servidor[]> {
  const [unidade] = await tx.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, "FAMED"));
  const cargo = cargo_id ?? (await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1))[0]!.id;
  const saida: Servidor[] = [];
  for (let i = 0; i < quantos; i++) {
    const siape = String(++_siape);
    const [s] = await tx
      .insert(e.servidor)
      .values({ siape, nome: `Servidor ${siape}`, cargo_id: cargo, unidade_uorg_id: unidade!.id })
      .returning();
    saida.push(s!);
  }
  return saida;
}

function _entregar(tx: Executor, usuario: UsuarioAtual, servidor: Servidor, item: Item, quantidade = 1, dias_atras = 0) {
  return epi_ficha.registrar_entrega(tx, usuario, {
    servidor,
    item,
    quantidade,
    data_evento: somar_dias(HOJE, -dias_atras),
  });
}

function _status(f: () => unknown): number | null {
  try {
    f();
    return null;
  } catch (erro) {
    return erro instanceof ErroHttp ? erro.status : -1;
  }
}

describe("período livre", () => {
  it("recorta pela data da entrega e soma as quantidades", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const item = await _item(tx, "Luva D período");
      const [antiga, recente] = await _servidores(tx, 2);
      await _entregar(tx, usuario, antiga!, item, 3, 60);
      await _entregar(tx, usuario, recente!, item, 2, 5);

      const so_recente = rota.periodo_da_consulta({ inicio: somar_dias(HOJE, -10), fim: HOJE });
      expect(so_recente.exercicio).toBeNull();
      const ctx = await rota._contexto(tx, NOMINAL(), so_recente);
      expect(ctx.dados.total_entregue).toBe(2);
      expect(ctx.total_entregue).toBe("2");
      expect(ctx.total_servidores).toBe("1");

      const as_duas = await rota._contexto(tx, NOMINAL(), rota.periodo_da_consulta({ inicio: somar_dias(HOJE, -90), fim: HOJE }));
      expect(as_duas.dados.total_entregue).toBe(5);
      expect(as_duas.dados.total_servidores).toBe(2);
    }));

  it("o exercício continua sendo o atalho de 01/01 a 31/12 e vence as datas", () => {
    const p = rota.periodo_da_consulta({ exercicio: "2025", inicio: "2024-03-01", fim: "2024-04-01" });
    expect(p).toEqual({ inicio: "2025-01-01", fim: "2025-12-31", exercicio: 2025 });
    const livre = rota.periodo_da_consulta({ exercicio: "livre", inicio: "2024-03-01", fim: "2024-04-01" });
    expect(livre).toEqual({ inicio: "2024-03-01", fim: "2024-04-01", exercicio: null });
    // nada pedido: o exercício corrente
    expect(rota.periodo_da_consulta({}).exercicio).toBe(Number(HOJE.slice(0, 4)));
  });

  it("início depois do fim, mais de cinco anos e data inválida são 422", () => {
    expect(_status(() => rota.periodo_da_consulta({ inicio: "2026-05-02", fim: "2026-05-01" }))).toBe(422);
    expect(_status(() => rota.periodo_da_consulta({ inicio: "2020-01-01", fim: "2025-01-01" }))).toBe(422);
    expect(_status(() => rota.periodo_da_consulta({ inicio: "2020-01-01", fim: "2024-12-31" }))).toBeNull();
    expect(_status(() => rota.periodo_da_consulta({ inicio: "2026-02-31", fim: "2026-03-01" }))).toBe(422);
    expect(_status(() => rota.periodo_da_consulta({ inicio: "01/02/2026", fim: "2026-03-01" }))).toBe(422);
    expect(_status(() => rota.periodo_da_consulta({ exercicio: "dois mil" }))).toBe(422);
  });

  it("a tela responde 422 com a mensagem, e o período livre na tela", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    const cliente = await entrar(novoCliente(), "coordenador_csso");
    const invertido = await cliente.get("/epis/relatorios?exercicio=livre&inicio=2026-05-02&fim=2026-05-01");
    expect(invertido.status).toBe(422);
    expect(invertido.text).toContain("O início do período não pode ser depois do fim.");
    const longo = await cliente.get("/epis/relatorios?inicio=2015-01-01&fim=2026-01-01");
    expect(longo.status).toBe(422);
    expect(longo.text).toContain("no máximo 5 anos");
    expect((await cliente.get("/epis/relatorios?inicio=2026-13-01&fim=2026-12-31")).status).toBe(422);

    const tela = await cliente.get("/epis/relatorios?exercicio=livre&inicio=2026-03-01&fim=2026-06-30");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("Período livre");
    expect(tela.text).toContain('value="2026-03-01"');
    expect(tela.text).toContain("/epis/relatorios/exportar?inicio=2026-03-01&amp;fim=2026-06-30");
    expect(tela.text).toContain("Entregue por EPI");
    expect(tela.text).toContain("Entregue por cargo");
  });
});

describe("rankings e supressão", () => {
  it("o ranking por EPI é decrescente pelas peças, com a linha suprimida no fim", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const pouco = await _item(tx, "Avental D pouco");
      const muito = await _item(tx, "Bota D muito");
      const raro = await _item(tx, "Capacete D raro");
      const pessoas = await _servidores(tx, 6);
      for (const p of pessoas) {
        await _entregar(tx, usuario, p, pouco, 1);
        await _entregar(tx, usuario, p, muito, 3);
      }
      // dois servidores e muitas peças: no topo para quem vê nominal; no fim,
      // com traço, para quem não vê
      await _entregar(tx, usuario, pessoas[0]!, raro, 20);
      await _entregar(tx, usuario, pessoas[1]!, raro, 20);

      const nominal = await rota._contexto(tx, NOMINAL(), null);
      expect(nominal.ranking_epi.map((l) => [l.rotulo, l.quantidade, l.servidores])).toEqual([
        ["Capacete D raro", "40", "2"],
        ["Bota D muito", "18", "6"],
        ["Avental D pouco", "6", "6"],
      ]);
      expect(nominal.dados.total_entregue).toBe(64);

      const escondido = await rota._contexto(tx, SEM_NOMINAL(), null);
      expect(escondido.ranking_epi.map((l) => [l.rotulo, l.quantidade, l.servidores])).toEqual([
        ["Bota D muito", "18", "6"],
        // a secundária: só uma célula seria suprimida, e a menor sobrevivente vai junto
        ["Avental D pouco", MARCA_SUPRIMIDO, MARCA_SUPRIMIDO],
        ["Capacete D raro", MARCA_SUPRIMIDO, MARCA_SUPRIMIDO],
      ]);
      // seis servidores no total: o total aparece
      expect(escondido.total_entregue).toBe("64");
    }));

  it("cargo com menos de cinco servidores é suprimido, com a quantidade junto", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const item = await _item(tx, "Luva D cargo");
      const enfermeiro = await _cargo(tx, "Enfermeiro D");
      const tecnico = await _cargo(tx, "Técnico de Laboratório D");
      const raro = await _cargo(tx, "Físico Médico D");
      for (const p of await _servidores(tx, 7, enfermeiro)) await _entregar(tx, usuario, p, item, 2);
      for (const p of await _servidores(tx, 5, tecnico)) await _entregar(tx, usuario, p, item, 2);
      for (const p of await _servidores(tx, 2, raro)) await _entregar(tx, usuario, p, item, 2);

      const dados = await epi_indicadores.relatorio(tx);
      expect(dados.por_cargo.servidores).toEqual({
        "Enfermeiro D": 7,
        "Físico Médico D": 2,
        "Técnico de Laboratório D": 5,
      });

      const escondido = await rota._contexto(tx, SEM_NOMINAL(), null);
      expect(escondido.por_cargo["Físico Médico D"]).toBe(MARCA_SUPRIMIDO);
      expect(escondido.quantidade_cargo["Físico Médico D"]).toBe(MARCA_SUPRIMIDO);
      // a secundária leva o menor sobrevivente: senão o total devolveria o 2
      expect(escondido.por_cargo["Técnico de Laboratório D"]).toBe(MARCA_SUPRIMIDO);
      expect(escondido.por_cargo["Enfermeiro D"]).toBe("7");
      expect(escondido.quantidade_cargo["Enfermeiro D"]).toBe("14");

      const visto = await rota._contexto(tx, NOMINAL(), null);
      expect(visto.por_cargo["Físico Médico D"]).toBe("2");
      expect(visto.ranking_cargo.map((l) => l.rotulo)).toEqual([
        "Enfermeiro D",
        "Técnico de Laboratório D",
        "Físico Médico D",
      ]);
    }));

  it("com menos de cinco servidores no período o próprio total é suprimido", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const item = await _item(tx, "Luva D total");
      for (const p of await _servidores(tx, 3)) await _entregar(tx, usuario, p, item, 4);
      const escondido = await rota._contexto(tx, SEM_NOMINAL(), null);
      expect(escondido.total_entregue).toBe(MARCA_SUPRIMIDO);
      expect(escondido.total_servidores).toBe(MARCA_SUPRIMIDO);
      expect(escondido.tudo_mascarado).toBe(true);
      const visto = await rota._contexto(tx, NOMINAL(), null);
      expect(visto.total_entregue).toBe("12");
    }));

  it("estornos ficam fora de todas as contagens", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const item = await _item(tx, "Luva D estorno");
      const cargo = await _cargo(tx, "Auxiliar D");
      const pessoas = await _servidores(tx, 6, cargo);
      const registros = [];
      for (const p of pessoas) registros.push(await _entregar(tx, usuario, p, item, 2));
      await epi_ficha.estornar(tx, usuario, registros[0]!, "lançada no servidor errado");

      const dados = await epi_indicadores.relatorio(tx);
      expect(dados.total_entregue).toBe(10);
      expect(dados.total_servidores).toBe(5);
      expect(dados.por_epi.quantidade["Luva D estorno"]).toBe(10);
      expect(dados.por_epi.servidores["Luva D estorno"]).toBe(5);
      expect(dados.por_cargo.servidores["Auxiliar D"]).toBe(5);
      expect(dados.por_cargo.quantidade["Auxiliar D"]).toBe(10);
      expect(dados.movimentos.servidores).toEqual({});
    }));
});

describe("exportação e permissão", () => {
  it("o CSV leva os blocos novos com a mesma supressão", () =>
    emSessao(async (tx) => {
      const usuario = await _operador(tx);
      const item = await _item(tx, "Luva D csv");
      const comum = await _cargo(tx, "Assistente D");
      const raro = await _cargo(tx, "Oceanógrafo D");
      for (const p of await _servidores(tx, 6, comum)) await _entregar(tx, usuario, p, item, 1);
      for (const p of await _servidores(tx, 1, raro)) await _entregar(tx, usuario, p, item, 1);

      const periodo = rota.periodo_da_consulta({ inicio: somar_dias(HOJE, -30), fim: HOJE });
      const { nome, corpo } = await rota.exportar(tx, SEM_NOMINAL(), periodo);
      expect(nome).toBe(`epi-indicadores-${periodo.inicio}_a_${periodo.fim}.csv`);
      const texto = new TextDecoder().decode(corpo.slice(3));
      expect(texto).toContain(`Período;${periodo.inicio};${periodo.fim};;`);
      expect(texto).toContain("Total entregue no período;;;7;7");
      expect(texto).toContain("Entregue por EPI;Luva D csv;;7;7");
      expect(texto).toContain(`Entregue por cargo;Oceanógrafo D;;${MARCA_SUPRIMIDO};${MARCA_SUPRIMIDO}`);
      expect(texto).toContain(`Entregue por cargo;Assistente D;;${MARCA_SUPRIMIDO};${MARCA_SUPRIMIDO}`);
      expect(texto).toContain("Nota;");

      const nominal = new TextDecoder().decode((await rota.exportar(tx, NOMINAL(), periodo)).corpo.slice(3));
      expect(nominal).toContain("Entregue por cargo;Oceanógrafo D;;1;1");
      expect(nominal).toContain("Entregue por cargo;Assistente D;;6;6");
    }));

  it("sem indicador.ver: 403 na tela e no CSV", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    await naTransacao(async (tx) => {
      await expect(rota.exportar(tx, _leitor("exportar"), null)).rejects.toThrow();
    });
    const cliente = await entrar(novoCliente(), "almoxarife_sesmt");
    expect((await cliente.get("/epis/relatorios?inicio=2026-01-01&fim=2026-02-01")).status).toBe(403);
    expect((await cliente.get("/epis/relatorios/exportar?inicio=2026-01-01&fim=2026-02-01")).status).toBe(403);
    // nem a data torta passa à frente da permissão
    expect((await cliente.get("/epis/relatorios/exportar?inicio=2026-02-31")).status).toBe(403);
  });
});
