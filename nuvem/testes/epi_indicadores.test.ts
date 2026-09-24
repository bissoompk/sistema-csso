/**
 * Fatia 7 de Gestão de EPI: painel, vida útil, indicadores e exportação.
 * Porte de `testes/integracao/test_epi_indicadores.py`.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 * 1. **A supressão não se desfaz pela margem.** O total do campus devolve a
 *    unidade escondida por uma subtração de cabeça.
 * 2. **RN-32 não cobra troca de quem não deve.** Devolvido, estornado e
 *    substituído encerram a cobrança, cada um por um motivo diferente.
 * 3. **O item parado em `SEM_ESTOQUE` não depende de memória.** A pendência
 *    entra quando ele para e sai quando ele anda, inclusive na volta.
 * 4. **As duas telas têm permissões diferentes**: `/epis` é `epi.ver`,
 *    `/epis/relatorios` é `indicador.ver`.
 *
 * O fixture `sessao` do Python (sessão desfeita no fim) vira `emSessao`: uma
 * transação que roda o teste e é desfeita de propósito — o banco do arquivo
 * volta ao que era, e as contagens de um teste não contaminam o próximo.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { obterBanco, type Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { EpiRequisicao as RequisicaoDominio } from "../src/dominio/epi.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as epi_indicadores from "../src/servicos/epi_indicadores.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import * as pendencias from "../src/servicos/pendencias.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import * as rota from "../src/rotas/epi_indicadores.js";
import { MARCA_SUPRIMIDO, suprimir_aninhado } from "../src/rotas/epi_indicadores.js";
import { bancoLimpo, contas, entrar, naTransacao, ORIGEM, SENHA_TESTE } from "./ajuda";

const HOJE = hoje();
const DAQUI_A_UM_ANO = somar_dias(HOJE, 365);
const TUDO = ["epi.ver", "epi.requisitar", "epi.analisar", "epi.estoque", "epi.entregar"];

const { app, novoCliente } = await bancoLimpo();
const HASH = await autenticacao.gerar_hash(SENHA_TESTE);

class Desfazer extends Error {}

/** O fixture `sessao`: roda `f` numa transação e a desfaz no fim. */
async function emSessao(f: (tx: Executor) => Promise<void>): Promise<void> {
  try {
    // `obterBanco()` e não o `db` do começo: os testes de tela trocam de banco
    await obterBanco().transaction(async (tx) => {
      await f(tx);
      throw new Desfazer();
    });
  } catch (erro) {
    if (!(erro instanceof Desfazer)) throw erro;
  }
}

// =====================================================================
// Montagem
// =====================================================================
let _n = 0;
async function _usuario(tx: Executor, login = "operador"): Promise<UsuarioAtual> {
  const unico = `${login}_${++_n}_${Date.now() % 100000}`;
  const [registro] = await tx
    .insert(e.usuario)
    .values({
      login: unico,
      nome: `Operador ${login}`,
      email: `${unico}@teste.ufvjm.edu.br`,
      senha_hash: HASH,
      precisa_trocar_senha: false,
    })
    .returning();
  return new UsuarioAtual({
    id: registro!.id,
    login: unico,
    nome: registro!.nome,
    permissoes: TUDO,
    perfis: ["coordenador_csso"],
    servidor_id: null,
  });
}

type Item = typeof e.epi_item.$inferSelect;
type Servidor = typeof e.servidor.$inferSelect;

async function _item(
  tx: Executor,
  { nome = "Luva de proteção química nitrílica", vida_util = 6 as number | null } = {},
): Promise<Item> {
  const [categoria] = await tx
    .select()
    .from(e.epi_categoria)
    .where(eq(e.epi_categoria.codigo, "PROT_MEMBROS_SUPERIORES"));
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
      vida_util_meses: vida_util,
      quantidade_padrao: 1,
    })
    .returning();
  return item!;
}

async function _servidor(tx: Executor, siape: string, nome: string, sigla_unidade = "FAMED"): Promise<Servidor> {
  const [unidade] = await tx.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla_unidade));
  const [cargo] = await tx.select().from(e.cargo).orderBy(asc(e.cargo.id)).limit(1);
  const [servidor] = await tx
    .insert(e.servidor)
    .values({ siape, nome, cargo_id: cargo!.id, unidade_uorg_id: unidade!.id })
    .returning();
  return servidor!;
}

/** Entrega de balcão, sem lote — o caminho mais curto até uma linha de ficha. */
function _entregar(
  tx: Executor,
  usuario: UsuarioAtual,
  servidor: Servidor,
  item: Item,
  { dias_atras = 0, quantidade = 1 } = {},
) {
  return epi_ficha.registrar_entrega(tx, usuario, {
    servidor,
    item,
    quantidade,
    data_evento: somar_dias(HOJE, -dias_atras),
  });
}

async function _pendencia(tx: Executor, chave: string) {
  const [p] = await tx.select().from(e.pendencia).where(eq(e.pendencia.chave, chave));
  return p ?? null;
}

async function _linha(tx: Executor, id: number) {
  const [l] = await tx.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.id, id));
  return l!;
}

async function _requisicao(tx: Executor, id: number) {
  const [r] = await tx.select().from(e.epi_requisicao).where(eq(e.epi_requisicao.id, id));
  return r!;
}

async function _itens_de(tx: Executor, requisicao_id: number) {
  return tx
    .select()
    .from(e.epi_requisicao_item)
    .where(eq(e.epi_requisicao_item.requisicao_id, requisicao_id))
    .orderBy(asc(e.epi_requisicao_item.id));
}

// =====================================================================
// 1. Supressão de célula pequena COM margem — o cuidado que vale mais
// =====================================================================
describe("supressão com margem", () => {
  it("a margem do campus não devolve a unidade suprimida", () => {
    const grupos = { DIA: { FAMED: 9, DODO: 3 }, MUC: { IECT: 40 } };
    const linhas = Object.fromEntries(suprimir_aninhado(grupos, false).map((l) => [l.rotulo, l]));
    const dia = linhas["DIA"]!;
    expect(dia.valor).toBe("12");
    expect(Object.fromEntries(dia.folhas)).toEqual({ FAMED: MARCA_SUPRIMIDO, DODO: MARCA_SUPRIMIDO });
    // o que sobra da subtração é a soma de DUAS células, e não uma
    const visiveis = dia.folhas.filter(([, v]) => /^\d+$/.test(v)).map(([, v]) => Number(v));
    expect(Number(dia.valor) - visiveis.reduce((a, b) => a + b, 0)).toBe(12);
    expect(linhas["MUC"]!.valor).toBe("40");
  });

  it("grupo de folha única esconde o total junto", () => {
    const grupos = { UNA: { ICA: 3 }, DIA: { FAMED: 40, FCBS: 30 } };
    const linhas = Object.fromEntries(suprimir_aninhado(grupos, false).map((l) => [l.rotulo, l]));
    expect(linhas["UNA"]!.valor).toBe(MARCA_SUPRIMIDO);
    expect(Object.fromEntries(linhas["UNA"]!.folhas)).toEqual({ ICA: MARCA_SUPRIMIDO });
    // regra 3: nunca UM total sozinho — e a vítima leva as folhas dela junto
    expect(linhas["DIA"]!.valor).toBe(MARCA_SUPRIMIDO);
    expect(new Set(linhas["DIA"]!.folhas.map(([, v]) => v))).toEqual(new Set([MARCA_SUPRIMIDO]));
  });

  it("total do campus suprimido não convive com unidade visível", () => {
    const grupos = { UNA: { ICA: 2, DZO: 2 }, DIA: { FAMED: 40, FCBS: 30 } };
    const linhas = Object.fromEntries(suprimir_aninhado(grupos, false).map((l) => [l.rotulo, l]));
    expect(linhas["UNA"]!.valor).toBe(MARCA_SUPRIMIDO);
    expect(new Set(linhas["UNA"]!.folhas.map(([, v]) => v))).toEqual(new Set([MARCA_SUPRIMIDO]));
  });

  it("quem vê exposição vê a célula pequena", () => {
    const linhas = suprimir_aninhado({ DIA: { FAMED: 9, DODO: 3 } }, true);
    expect(linhas[0]!.valor).toBe("12");
    expect(Object.fromEntries(linhas[0]!.folhas)).toEqual({ FAMED: "9", DODO: "3" });
  });
});

// =====================================================================
// 2. RN-32 — vida útil e troca devida
// =====================================================================
describe("RN-32 — troca devida", () => {
  it("troca vencida abre pendência idempotente", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      const registro = await _entregar(tx, usuario, servidor, item, { dias_atras: 400 });

      const chave = epi_ficha.chave_da_pendencia_de_troca(registro.id);
      expect(chave).toBe(`troca:ficha:${registro.id}`);
      const pendencia = await _pendencia(tx, chave);
      expect(pendencia).not.toBeNull();
      expect(pendencia!.tipo).toBe("TROCA_EPI_DEVIDA");
      expect(pendencia!.entidade).toBe("epi_ficha_registro");
      expect(pendencia!.entidade_id).toBe(registro.id);
      // o prazo é a própria previsão, que já passou: a tarefa nasce atrasada
      expect(pendencia!.prazo).toBe(registro.previsao_troca);
      expect(pendencias.atrasada(pendencia!)).toBe(true);
      // RN-19: a fila de tarefas não é tela nominal
      expect(pendencia!.descricao).not.toContain(servidor.nome);
      expect(pendencia!.descricao).toContain(`#${servidor.id}`);

      // idempotente: sincronizar de novo não abre uma segunda
      await epi_ficha.sincronizar_pendencia_de_troca(tx, registro, usuario);
      expect((await tx.select().from(e.pendencia).where(eq(e.pendencia.chave, chave))).length).toBe(1);
    }));

  it("troca ainda no prazo não abre nada", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      const registro = await _entregar(tx, usuario, servidor, item, { dias_atras: 30 });
      expect(await _pendencia(tx, epi_ficha.chave_da_pendencia_de_troca(registro.id))).toBeNull();
      expect(await epi_ficha.troca_devida_em(tx, registro)).toBe(false);
    }));

  it("item sem vida útil nunca deve troca", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: null });
      const registro = await _entregar(tx, usuario, servidor, item, { dias_atras: 400 });
      expect(registro.previsao_troca).toBeNull();
      expect(await epi_ficha.troca_devida_em(tx, registro)).toBe(false);
    }));

  it("devolução integral encerra a cobrança e a parcial não", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      const registro = await _entregar(tx, usuario, servidor, item, { dias_atras: 400, quantidade: 2 });
      const chave = epi_ficha.chave_da_pendencia_de_troca(registro.id);
      expect(await _pendencia(tx, chave)).not.toBeNull();

      await epi_ficha.registrar_devolucao(tx, usuario, registro, { quantidade: 1, motivo: "uma das duas rasgou" });
      expect(await epi_ficha.troca_devida_em(tx, registro)).toBe(true);
      expect((await _pendencia(tx, chave))!.concluida).toBe(false);

      await epi_ficha.registrar_devolucao(tx, usuario, registro, { quantidade: 1, motivo: "a outra também voltou" });
      expect(await epi_ficha.troca_devida_em(tx, registro)).toBe(false);
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);
    }));

  it("estorno encerra a cobrança de troca", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      const registro = await _entregar(tx, usuario, servidor, item, { dias_atras: 400 });
      const chave = epi_ficha.chave_da_pendencia_de_troca(registro.id);
      expect((await _pendencia(tx, chave))!.concluida).toBe(false);

      await epi_ficha.estornar(tx, usuario, registro, "lançado no servidor errado");
      expect(await epi_ficha.troca_devida_em(tx, registro)).toBe(false);
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);
    }));

  it("substituição encerra a cobrança da entrega antiga", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      const antiga = await _entregar(tx, usuario, servidor, item, { dias_atras: 400 });
      const chave = epi_ficha.chave_da_pendencia_de_troca(antiga.id);
      expect((await _pendencia(tx, chave))!.concluida).toBe(false);

      const nova = await _entregar(tx, usuario, servidor, item, { dias_atras: 0 });
      expect(await epi_ficha.troca_devida_em(tx, antiga)).toBe(false);
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);
      // a nova ainda está no prazo — trocar não gera dívida nova
      expect(await _pendencia(tx, epi_ficha.chave_da_pendencia_de_troca(nova.id))).toBeNull();
      expect(await epi_ficha.trocas_devidas(tx)).toEqual([]);
    }));

  it("substituição de OUTRO item não encerra nada", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const luva = await _item(tx, { vida_util: 6 });
      const bota = await _item(tx, { nome: "Bota de segurança com biqueira", vida_util: 24 });
      const antiga = await _entregar(tx, usuario, servidor, luva, { dias_atras: 400 });
      await _entregar(tx, usuario, servidor, bota, { dias_atras: 0 });

      expect(await epi_ficha.troca_devida_em(tx, antiga)).toBe(true);
      expect((await epi_ficha.trocas_devidas(tx)).map((r) => r.id)).toEqual([antiga.id]);
    }));
});

// =====================================================================
// 3. O item parado em SEM_ESTOQUE
// =====================================================================
async function _pedido_aprovado(tx: Executor, usuario: UsuarioAtual, servidor: Servidor, item: Item, quantidade = 2) {
  let requisicao = await servico.criar_rascunho(tx, usuario, {
    servidor,
    descricao_atividade: "Manipulação de reagentes no laboratório",
  });
  await servico.adicionar_item(tx, usuario, requisicao, { item, quantidade, tamanho: "M" });
  requisicao = await _requisicao(tx, requisicao.id);
  await servico.enviar(tx, usuario, requisicao);
  await servico.iniciar_analise(tx, usuario, await _requisicao(tx, requisicao.id));
  const [linha] = await _itens_de(tx, requisicao.id);
  await servico.aprovar_item(tx, usuario, linha!);
  await servico.concluir_analise(tx, usuario, await _requisicao(tx, requisicao.id));
  return _linha(tx, linha!.id);
}

async function _lote(tx: Executor, item: Item, recebido = 10) {
  const [entrada] = await tx
    .insert(e.epi_entrada_estoque)
    .values({
      epi_item_id: item.id,
      empenho: "2026NE000123",
      data_entrada: somar_dias(HOJE, -10),
      quantidade_recebida: recebido,
      valor_unitario: "12.50",
      lote: "L-2026-08",
      numero_ca: "41234",
      validade_ca: DAQUI_A_UM_ANO,
    })
    .returning();
  await tx.insert(e.epi_movimento_estoque).values({ entrada_id: entrada!.id, tipo: "ENTRADA", quantidade: recebido });
  return entrada!;
}

describe("item parado em SEM_ESTOQUE", () => {
  it("entra no sino e sai quando anda", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      const linha = await _pedido_aprovado(tx, usuario, servidor, item);

      await servico.marcar_sem_estoque(tx, usuario, linha, { complemento: "pregão em andamento" });
      const chave = servico.chave_da_pendencia_de_falta(linha.id);
      expect(chave).toBe(`sem_estoque:requisicao_item:${linha.id}`);
      const pendencia = await _pendencia(tx, chave);
      expect(pendencia).not.toBeNull();
      expect(pendencia!.tipo).toBe("EPI_SEM_ESTOQUE");
      expect(pendencia!.responsavel_id).toBe(usuario.id);
      // RN-19: o pedido é identificado pelo protocolo, que não nomeia ninguém
      expect(pendencia!.descricao).not.toContain(servidor.nome);
      const requisicao = await _requisicao(tx, linha.requisicao_id);
      expect(pendencia!.descricao).toContain(RequisicaoDominio.identificacao(requisicao));

      const entrada = await _lote(tx, item);
      await servico.reservar_item(tx, usuario, await _linha(tx, linha.id), { entrada });
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);
    }));

  it("reserva solta devolve o item ao sino", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      const linha = await _pedido_aprovado(tx, usuario, servidor, item);
      const entrada = await _lote(tx, item);

      await servico.reservar_item(tx, usuario, linha, { entrada });
      const chave = servico.chave_da_pendencia_de_falta(linha.id);
      expect(await _pendencia(tx, chave)).toBeNull();

      await servico.soltar_reserva(tx, usuario, await _linha(tx, linha.id), "o lote foi para um caso urgente");
      expect(await _pendencia(tx, chave)).not.toBeNull();
      expect((await _pendencia(tx, chave))!.concluida).toBe(false);

      await servico.reservar_item(tx, usuario, await _linha(tx, linha.id), { entrada });
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);

      await servico.soltar_reserva(tx, usuario, await _linha(tx, linha.id), "de novo, e pelo mesmo motivo");
      // a MESMA tarefa reabre — duas linhas fariam a fila contar duas vezes
      const abertas = await tx.select().from(e.pendencia).where(eq(e.pendencia.chave, chave));
      expect(abertas.length).toBe(1);
      expect(abertas[0]!.concluida).toBe(false);
    }));

  it("cancelar o pedido fecha a pendência de falta", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      const linha = await _pedido_aprovado(tx, usuario, servidor, item);
      await servico.marcar_sem_estoque(tx, usuario, linha, { complemento: "sem previsão" });
      const chave = servico.chave_da_pendencia_de_falta(linha.id);
      expect((await _pendencia(tx, chave))!.concluida).toBe(false);

      await servico.cancelar(tx, usuario, await _requisicao(tx, linha.requisicao_id), "o servidor foi transferido de posto");
      expect((await _pendencia(tx, chave))!.concluida).toBe(true);
    }));
});

// =====================================================================
// 4. O painel de /epis
// =====================================================================
describe("painel de /epis", () => {
  it("reúne as cinco medidas", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const joana = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const carlos = await _servidor(tx, "1112223", "Carlos Menezes", "IECT");
      const item = await _item(tx, { vida_util: 6 });

      const vencida = await _entregar(tx, usuario, joana, item, { dias_atras: 400 });
      const do_mes = await _entregar(tx, usuario, carlos, item, { dias_atras: 0 });
      const linha = await _pedido_aprovado(tx, usuario, joana, item);
      await servico.marcar_sem_estoque(tx, usuario, linha, { complemento: "pregão deserto" });
      // um lote com CA vencendo dentro da janela dos 60 dias
      const entrada = await _lote(tx, item);
      await tx
        .update(e.epi_entrada_estoque)
        .set({ validade_ca: somar_dias(HOJE, 10) })
        .where(eq(e.epi_entrada_estoque.id, entrada.id));

      const p = await epi_indicadores.painel(tx);
      expect(p.trocas_devidas.map((r) => r.id)).toEqual([vencida.id]);
      expect(p.entregas_do_mes.map((r) => r.id)).toEqual([do_mes.id]);
      expect(p.esperando_estoque.map((i) => i.id)).toEqual([linha.id]);
      expect(p.lotes_a_vencer.map((lote) => lote.entrada.id)).toEqual([entrada.id]);
      // o pedido segue ANALISADA: `EM_ATENDIMENTO` chega na primeira RESERVA
      expect(p.requisicoes_por_estado["ANALISADA"]).toBe(1);
      expect(p.requisicoes_abertas).toBe(1);
    }));

  it("não conta entrega estornada", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      const registro = await _entregar(tx, usuario, servidor, item);
      expect((await epi_indicadores.entregas_do_mes(tx)).length).toBe(1);

      await epi_ficha.estornar(tx, usuario, registro, "quantidade digitada errada");
      expect(await epi_indicadores.entregas_do_mes(tx)).toEqual([]);
    }));

  it("abre para epi.ver e nega quem não opera", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    const cliente = novoCliente();
    await entrar(cliente, "almoxarife_sesmt");
    expect((await cliente.get("/epis")).status).toBe(200);
    await entrar(cliente, "admin_ti");
    expect((await cliente.get("/epis")).status).toBe(403);
  });

  it("dá a medida a todos e a linha só a quem lê ficha", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    await naTransacao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654399", "Joana Ribeiro de Almeida");
      const item = await _item(tx, { vida_util: 6 });
      await _entregar(tx, usuario, servidor, item, { dias_atras: 400 });
    });
    const cliente = novoCliente();
    await entrar(cliente, "secretaria_csso");
    const corpo = (await cliente.get("/epis")).text;
    expect(corpo).toContain("Trocas devidas");
    expect(corpo).not.toContain("Joana Ribeiro de Almeida");
    expect(corpo).not.toContain("Luva de proteção química nitrílica");

    // o almoxarife tem `epi.ficha` e é quem entrega: ele vê a linha e o nome
    await entrar(cliente, "almoxarife_sesmt");
    const com_ficha = (await cliente.get("/epis")).text;
    expect(com_ficha).toContain("Luva de proteção química nitrílica");
    expect(com_ficha).toContain("Joana Ribeiro de Almeida");
  });

  it("relatórios é indicador.ver, e não epi.ver", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    const cliente = novoCliente();
    await entrar(cliente, "almoxarife_sesmt");
    expect((await cliente.get("/epis/relatorios")).status).toBe(403);
    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/epis/relatorios")).status).toBe(200);
  });
});

// =====================================================================
// 5. Os indicadores
// =====================================================================
let _lote_siape = 0;

async function _populacao(
  tx: Executor,
  usuario: UsuarioAtual,
  { quantos, sigla, inicio = 0 }: { quantos: number; sigla: string; inicio?: number },
) {
  const [existente] = await tx
    .select()
    .from(e.epi_item)
    .where(eq(e.epi_item.nome, "Luva de proteção química nitrílica"));
  const item = existente ?? (await _item(tx));
  // SIAPE único no arquivo: os testes de tela CONFIRMAM o que povoam, e o
  // banco que eles deixam é o mesmo em que os testes seguintes rodam
  const base = 2000000 + (_lote_siape += 1000);
  for (let n = 0; n < quantos; n++) {
    const servidor = await _servidor(tx, `${base + inicio + n}`, `Servidor ${inicio + n}`, sigla);
    await _entregar(tx, usuario, servidor, item, { quantidade: 2 });
  }
  return item;
}

function _leitor(...permissoes: string[]): UsuarioAtual {
  return new UsuarioAtual({ id: 1, login: "leitor", nome: "Leitor", permissoes, perfis: ["auditor_interno"] });
}

describe("indicadores", () => {
  it("entregue conta servidores e não peças", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      await _entregar(tx, usuario, servidor, item, { quantidade: 6 });
      await _entregar(tx, usuario, servidor, item, { quantidade: 6 });

      const dados = await epi_indicadores.relatorio(tx);
      const [categoria] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.id, item.categoria_id));
      expect(dados.por_categoria.servidores[categoria!.nome]).toBe(1);
      expect(dados.por_categoria.quantidade[categoria!.nome]).toBe(12);
    }));

  it("relatório agrupa campus e unidade da mesma leitura", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      await _populacao(tx, usuario, { quantos: 6, sigla: "FAMED" });
      await _populacao(tx, usuario, { quantos: 5, sigla: "IECT", inicio: 100 });

      const dados = await epi_indicadores.relatorio(tx);
      expect(dados.por_campus["DIA"]).toEqual({ "Faculdade de Medicina de Diamantina": 6 });
      expect(dados.por_campus["MUC"]).toEqual({ "Instituto de Engenharia, Ciência e Tecnologia (IECT)": 5 });
    }));

  it("custo por empenho não é suprimido e diz quando é piso", () =>
    emSessao(async (tx) => {
      const item = await _item(tx);
      await _lote(tx, item, 10);
      const sem_valor = await _lote(tx, item, 4);
      await tx
        .update(e.epi_entrada_estoque)
        .set({ valor_unitario: null })
        .where(eq(e.epi_entrada_estoque.id, sem_valor.id));

      const linhas = Object.fromEntries((await epi_indicadores.relatorio(tx)).empenhos.map((l) => [l.empenho, l]));
      const empenho = linhas["2026NE000123"]!;
      expect(empenho.lotes).toBe(2);
      expect(empenho.recebido).toBe(14);
      // Decimal exato: 12.5000 × 10 = 125.0000
      expect(empenho.custo).toBe("125.0000");
      expect(empenho.custo_texto).toBe("125.00");
      expect(empenho.incompleto).toBe(true);
    }));

  it("recusa por motivo sai da trilha nas duas origens", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      const servidor = await _servidor(tx, "7654321", "Joana Ribeiro de Almeida");
      const item = await _item(tx);
      const [motivo] = await tx
        .select()
        .from(e.epi_motivo_recusa)
        .where(eq(e.epi_motivo_recusa.codigo, "VINCULO_NAO_ATENDIDO"));

      await epi_ficha.recusar(tx, usuario, {
        motivo: motivo!,
        a_quem: "prestador da empresa de limpeza",
        item,
        unidade: "Faculdade de Medicina de Diamantina",
        complemento: "encaminhado à contratante",
      });

      await _pedido_aprovado(tx, usuario, servidor, item);
      const outro = await servico.criar_rascunho(tx, usuario, {
        servidor,
        descricao_atividade: "Atividade administrativa sem exposição",
      });
      await servico.adicionar_item(tx, usuario, await _requisicao(tx, outro.id), { item, quantidade: 1, tamanho: "M" });
      await servico.enviar(tx, usuario, await _requisicao(tx, outro.id));
      await servico.iniciar_analise(tx, usuario, await _requisicao(tx, outro.id));
      const [linha] = await _itens_de(tx, outro.id);
      await servico.recusar_item(tx, usuario, linha!, { motivo: motivo!, complemento: "idem" });

      const dados = await epi_indicadores.relatorio(tx);
      expect(dados.total_recusas).toBe(2);
      expect(Object.values(dados.recusas_por_motivo).reduce((a, b) => a + b, 0)).toBe(2);
      expect(dados.recusas_por_motivo[motivo!.rotulo]).toBe(2);
      expect(dados.recusas_por_unidade["Faculdade de Medicina de Diamantina"]).toBe(2);
    }));

  it("relatório suprime a célula pequena e a margem dela", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      await _populacao(tx, usuario, { quantos: 3, sigla: "DODO" });
      await _populacao(tx, usuario, { quantos: 5, sigla: "FAMED", inicio: 100 });

      const escondido = await rota._contexto(tx, _leitor("indicador.ver"), null);
      const dia = escondido.por_campus.find((l) => l.rotulo === "DIA")!;
      expect(Object.fromEntries(dia.folhas)).toEqual({
        "Departamento de Odontologia": MARCA_SUPRIMIDO,
        "Faculdade de Medicina de Diamantina": MARCA_SUPRIMIDO,
      });
      expect(dia.valor).toBe("8");
      // a categoria reúne os oito e sobrevive: aí a quantidade de peças sai
      expect(new Set(Object.values(escondido.quantidade_categoria))).toEqual(new Set(["16"]));

      const visto = await rota._contexto(tx, _leitor("indicador.ver", "exposicao.ver"), null);
      const dia_nominal = visto.por_campus.find((l) => l.rotulo === "DIA")!;
      expect(Object.fromEntries(dia_nominal.folhas)).toEqual({
        "Departamento de Odontologia": "3",
        "Faculdade de Medicina de Diamantina": "5",
      });
    }));

  it("quantidade de peças some junto com a célula", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      await _populacao(tx, usuario, { quantos: 3, sigla: "DODO" });

      const escondido = await rota._contexto(tx, _leitor("indicador.ver"), null);
      expect(new Set(Object.values(escondido.por_categoria))).toEqual(new Set([MARCA_SUPRIMIDO]));
      expect(new Set(Object.values(escondido.quantidade_categoria))).toEqual(new Set([MARCA_SUPRIMIDO]));

      const visto = await rota._contexto(tx, _leitor("indicador.ver", "exposicao.ver"), null);
      expect(new Set(Object.values(visto.por_categoria))).toEqual(new Set(["3"]));
      expect(new Set(Object.values(visto.quantidade_categoria))).toEqual(new Set(["6"]));
    }));

  it("a tela do relatório avisa por que há traço", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    await naTransacao(async (tx) => {
      const usuario = await _usuario(tx);
      await _populacao(tx, usuario, { quantos: 3, sigla: "DODO" });
    });
    const cliente = novoCliente();
    await entrar(cliente, "secretaria_csso");
    const corpo = (await cliente.get("/epis/relatorios")).text;
    expect(corpo).toContain("célula suprimida");
    expect(corpo).toContain("margem intacta");

    await entrar(cliente, "coordenador_csso");
    expect((await cliente.get("/epis/relatorios")).text).not.toContain("margem intacta");
  });
});

// =====================================================================
// 6. Exportação — mesmo formato do sistema, mesma supressão
// =====================================================================
describe("exportação", () => {
  it("segue o formato da casa", async () => {
    await bancoLimpo();
    await contas(obterBanco());
    await naTransacao(async (tx) => {
      const usuario = await _usuario(tx);
      const item = await _populacao(tx, usuario, { quantos: 6, sigla: "FAMED" });
      await _lote(tx, item);
    });
    const cliente = novoCliente();
    await entrar(cliente, "secretaria_csso");
    // `indicador.ver` sem `exportar`: a URL não é a porta dos fundos do relatório
    expect((await cliente.get("/epis/relatorios/exportar")).status).toBe(403);

    await entrar(cliente, "coordenador_csso");
    // os bytes crus: o `text()` do fetch engole o BOM, e é o BOM que se confere
    const cookie = [...cliente.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const r = await app.fetch(new Request(`${ORIGEM}/epis/relatorios/exportar`, { headers: { cookie } }));
    expect(r.status).toBe(200);
    const bytes = new Uint8Array(await r.arrayBuffer());
    // o mesmo formato de `/relatorios/exportar-processos`: BOM e ponto e vírgula
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const corpo = new TextDecoder().decode(bytes.slice(3));
    expect(corpo.split(/\r?\n/)[0]!.startsWith("Indicador;Recorte")).toBe(true);
    expect(corpo).toContain("Entregue por categoria (NR-6)");
    expect(corpo).toContain("Entregue por unidade;DIA;Faculdade de Medicina de Diamantina;6");
    expect(corpo).toContain("Custo por empenho;2026NE000123");
    // quem vê nominal não recebe traço nenhum, e a nota não sai
    expect(corpo).not.toContain("Nota;");
  });

  it("de quem não vê nominal leva supressão e a nota", () =>
    emSessao(async (tx) => {
      const usuario = await _usuario(tx);
      await _populacao(tx, usuario, { quantos: 3, sigla: "DODO" });

      const { corpo } = await rota.exportar(tx, _leitor("indicador.ver", "exportar"), null);
      expect([...corpo.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const texto = new TextDecoder().decode(corpo.slice(3));
      expect(texto).toContain(`Entregue por unidade;DIA;Departamento de Odontologia;${MARCA_SUPRIMIDO}`);
      expect(texto).toContain("Nota;");
      expect(texto).toContain("menos de 5 servidores");
    }));
});
