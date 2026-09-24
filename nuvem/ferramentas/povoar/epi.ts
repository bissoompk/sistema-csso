/**
 * O povoamento de Gestão de EPI do ambiente de teste.
 * Porte do trecho "Gestao de EPI" de `ferramentas/ambiente_teste_cli.py`.
 *
 * Ordem e conteúdo são os do Python: nove itens de catálogo, sete lotes (um
 * deles com o CA JÁ VENCIDO, e um descarte parcial dele), cinco linhas de
 * ficha (uma devolução parcial e um estorno entre elas) e nove requisições,
 * uma por estado interessante.
 *
 * **Por que passa pelos serviços.** Pelo mesmo motivo do resto da ferramenta:
 * o lote precisa do primeiro movimento no razão, a ficha precisa do contexto
 * congelado e da trilha, a requisição precisa da numeração e da máquina de
 * estados. Onde o Python insere direto (o item de catálogo, com o
 * `auditoria.registrar` que a rota faria), insere-se direto aqui.
 *
 * Quem chama (`ferramentas/ambiente-teste.ts`) passa a transação e o `ctx`:
 * `atual(login)` resolve a conta semeada no `UsuarioAtual`, e `resumo` recebe
 * as contagens impressas no fim. As contas usadas são as de `CONTAS`:
 * `tecnico`, `almoxarife`, `secretaria` e `servidor` (a Adelaide, SIAPE
 * 3010011), e os servidores são os de `SERVIDORES` — ambos já criados antes.
 */
import { eq, like } from "drizzle-orm";
import type { Executor } from "../../src/db/cliente.js";
import * as e from "../../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../../src/dominio/datas.js";
import type { UsuarioAtual } from "../../src/servicos/rbac.js";

export interface ContextoPovoar {
  /** a conta semeada `login`, resolvida como a sessão a resolveria */
  atual: (login: string) => Promise<UsuarioAtual>;
  /** o resumo impresso no fim (`resumo["epi_itens"] = 9` ...) */
  resumo: Record<string, number>;
}

// (nome, código da categoria, CA, validade em dias a partir de hoje, tamanhos,
//  vida útil em meses, quantidade padrão, máxima, janela em meses, treinamento)
export const CATALOGO_EPI: readonly (readonly [
  string,
  string,
  string,
  number,
  string,
  number,
  number,
  number | null,
  number | null,
  boolean,
])[] = [
  ["Luva de proteção química (nitrílica)", "PROT_MEMBROS_SUPERIORES", "41585", 900, "P\nM\nG", 6, 2, 6, 12, false],
  ["Óculos de proteção ampla visão", "PROT_OLHOS_FACE", "38121", 800, "", 24, 1, 2, 24, false],
  ["Protetor auricular tipo plugue", "PROT_AUDITIVA", "31543", 700, "", 6, 2, null, null, false],
  ["Respirador semifacial PFF2", "PROT_RESPIRATORIA", "38504", 30, "", 3, 5, null, null, true],
  ["Avental de PVC", "PROT_TRONCO", "40233", 650, "M\nG", 12, 1, null, null, false],
  ["Bota de segurança de PVC", "PROT_MEMBROS_INFERIORES", "42109", 950, "38\n40\n42\n44", 12, 1, 2, 12, false],
  ["Capacete de segurança classe B", "PROT_CABECA", "31469", 600, "", 60, 1, null, null, false],
  ["Macacão de proteção química", "PROT_CORPO_INTEIRO", "37890", 500, "M\nG", 12, 1, null, null, true],
  ["Cinturão de segurança tipo paraquedista", "PROT_QUEDAS_DESNIVEL", "35678", 400, "", 60, 1, null, null, true],
];

// (item, quantidade, tamanho, lote, CA, validade relativa em dias)
// A linha do meio é a que importa: um lote com o CA JÁ VENCIDO. A RN-25 é a
// regra mais séria do módulo, e ela só se vê funcionando se houver na
// prateleira algo que ela recuse — `registrar_entrada` aceita o lote (a nota
// fiscal existe, o material está na caixa), e quem recusa é a entrega.
export const LOTES: readonly (readonly [string, number, string, string, string, number])[] = [
  ["Luva", 40, "M", "L-2026-011", "41585", 540],
  ["Luva", 12, "G", "L-2024-902", "41585", -25],
  ["Óculos", 25, "", "L-2026-021", "38121", 700],
  ["Respirador", 30, "", "L-2026-031", "38504", 45],
  ["Bota", 15, "40", "L-2026-041", "42109", 800],
  ["Protetor", 120, "", "L-2026-051", "31543", 640],
  ["Avental", 10, "G", "L-2026-061", "40233", 600],
];

export async function povoar_epi(tx: Executor, ctx: ContextoPovoar): Promise<void> {
  // importados aqui, como em `ambiente-teste.ts`: a ferramenta carrega o
  // `.env` antes de qualquer módulo que leia configuração
  const auditoria = await import("../../src/servicos/auditoria.js");
  const epi_estoque = await import("../../src/servicos/epi_estoque.js");
  const epi_ficha = await import("../../src/servicos/epi_ficha.js");
  const epi_requisicao = await import("../../src/servicos/epi_requisicao.js");

  const hoje = hoje_iso();
  const ano = Number(hoje.slice(0, 4));
  const dias = (n: number) => somar_dias(hoje, n);

  const item_de = async (prefixo: string) => {
    // `.scalars().first()` do Python: a primeira por id
    const [item] = await tx
      .select()
      .from(e.epi_item)
      .where(like(e.epi_item.nome, `${prefixo}%`))
      .orderBy(e.epi_item.id)
      .limit(1);
    return item!;
  };
  const lote_de = async (codigo: string) => {
    const [entrada] = await tx.select().from(e.epi_entrada_estoque).where(eq(e.epi_entrada_estoque.lote, codigo));
    return entrada!;
  };
  const pessoa = async (siape: string) => {
    const [servidor] = await tx.select().from(e.servidor).where(eq(e.servidor.siape, siape));
    return servidor!;
  };

  // -----------------------------------------------------------------
  // Catálogo
  // -----------------------------------------------------------------
  const tecnico = await ctx.atual("tecnico");
  for (const [nome, categoria, ca, validade, tamanhos, vida, padrao, maxima, janela, treinamento] of CATALOGO_EPI) {
    const [categoria_obj] = await tx.select().from(e.epi_categoria).where(eq(e.epi_categoria.codigo, categoria));
    const [item] = await tx
      .insert(e.epi_item)
      .values({
        nome,
        categoria_id: categoria_obj!.id,
        descricao: "Item de catálogo do ambiente de teste.",
        fabricante: "Fabricante de Teste Ltda",
        normas: "NR-6",
        exige_ca: true,
        numero_ca: ca,
        validade_ca: dias(validade),
        unidade_medida: "UNIDADE",
        tamanhos: tamanhos || null,
        vida_util_meses: vida,
        quantidade_padrao: padrao,
        quantidade_maxima: maxima,
        periodo_maximo_meses: janela,
        exige_treinamento: treinamento,
      })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "epi_item",
      entidade_id: item!.id,
      tipo_evento: "EPI_ITEM_CRIADO",
      descricao: `${item!.nome} · ${categoria_obj!.nome} · CA ${item!.numero_ca}`,
      usuario: tecnico,
    });
  }
  ctx.resumo.epi_itens = CATALOGO_EPI.length;

  // -----------------------------------------------------------------
  // Estoque
  // -----------------------------------------------------------------
  const almoxarife = await ctx.atual("almoxarife");
  for (const [prefixo, quantidade, tamanho, lote, ca, validade] of LOTES) {
    await epi_estoque.registrar_entrada(tx, almoxarife, {
      item: await item_de(prefixo),
      quantidade_recebida: quantidade,
      data_entrada: dias(-60),
      tamanho,
      pregao: `PE ${ano}/0012`,
      empenho: `${ano}NE000${lote.length}`,
      nota_fiscal: `NF-${lote}`,
      fornecedor_nome: "Fornecedora de Teste S.A.",
      fornecedor_cnpj: "11222333000181",
      quantidade_empenhada: quantidade,
      valor_unitario: "12.50",
      lote,
      numero_ca: ca,
      validade_ca: dias(validade),
      observacao: "Lote do ambiente de teste.",
    });
  }
  // e um descarte, para o extrato do razão ter mais de um tipo de linha
  await epi_estoque.descartar(tx, almoxarife, {
    entrada: await lote_de("L-2024-902"),
    quantidade: 2,
    motivo: "Descarte parcial do lote com CA vencido (dado de teste).",
  });
  ctx.resumo.epi_lotes = LOTES.length;

  // -----------------------------------------------------------------
  // Fichas de entrega de balcão: a prova nominal de que a pessoa recebeu
  // -----------------------------------------------------------------
  // Entrega antiga de item com vida útil de 6 meses: a troca já venceu, e
  // `sincronizar_trocas_do_servidor` abre a pendência RN-32 com prazo no
  // passado — que é a verdade, e é o que faz o sino ter conteúdo vermelho.
  await epi_ficha.registrar_entrega(tx, almoxarife, {
    servidor: await pessoa("3010011"),
    item: await item_de("Luva"),
    quantidade: 2,
    entrada: await lote_de("L-2026-011"),
    tamanho: "M",
    data_evento: dias(-250),
    observacao: "Entrega de balcão registrada no ambiente de teste.",
  });
  const recente = await epi_ficha.registrar_entrega(tx, almoxarife, {
    servidor: await pessoa("3010022"),
    item: await item_de("Óculos"),
    quantidade: 1,
    entrada: await lote_de("L-2026-021"),
    data_evento: dias(-20),
    observacao: "Entrega de balcão registrada no ambiente de teste.",
  });
  // devolução parcial: linha nova na ficha, nunca rasura na anterior
  await epi_ficha.registrar_devolucao(tx, almoxarife, recente, {
    quantidade: 1,
    motivo: "Devolvido por troca de posto de trabalho.",
    data_evento: dias(-5),
  });
  const errada = await epi_ficha.registrar_entrega(tx, almoxarife, {
    servidor: await pessoa("3010033"),
    item: await item_de("Protetor"),
    quantidade: 2,
    entrada: await lote_de("L-2026-051"),
    data_evento: dias(-12),
  });
  // estorno: a correção que a RN-31 admite — linha nova, com a errada ao lado
  await epi_ficha.estornar(tx, almoxarife, errada, "Lançado no servidor errado (teste).");
  await epi_ficha.registrar_entrega(tx, almoxarife, {
    servidor: await pessoa("3010044"),
    item: await item_de("Bota"),
    quantidade: 1,
    entrada: await lote_de("L-2026-041"),
    tamanho: "40",
    data_evento: dias(-8),
  });
  ctx.resumo.epi_fichas = 5;

  // -----------------------------------------------------------------
  // Requisições, uma por estado interessante
  // -----------------------------------------------------------------
  const secretaria = await ctx.atual("secretaria");
  const titular = await ctx.atual("servidor");
  const analista = await ctx.atual("tecnico");

  const pedir = async (usuario: UsuarioAtual, siape: string, itens: [string, number, string][], atividade: string) => {
    const requisicao = await epi_requisicao.criar_rascunho(tx, usuario, {
      servidor: await pessoa(siape),
      descricao_atividade: atividade,
      riscos_declarados: "Agente químico e agente biológico no posto.",
    });
    for (const [prefixo, quantidade, tamanho] of itens) {
      await epi_requisicao.adicionar_item(tx, usuario, requisicao, {
        item: await item_de(prefixo),
        quantidade,
        tamanho,
      });
    }
    return requisicao;
  };
  const linhas = (requisicao: { id: number }) => epi_requisicao.itens_de(tx, requisicao.id);

  // RASCUNHO — ainda em digitação, e o único estado que admite exclusão
  await pedir(secretaria, "3010101", [["Óculos", 1, ""]], "Apoio administrativo com visita eventual ao laboratório.");

  // ENVIADA — na fila, ninguém pegou ainda
  const enviada = await pedir(
    titular,
    "3010011",
    [["Luva", 2, "M"]],
    "Análises clínicas no LEAC, com manipulação de reagentes.",
  );
  await epi_requisicao.enviar(tx, titular, enviada);

  // EM_ANALISE — o analista pegou e assumiu o nome no pedido
  const em_analise = await pedir(secretaria, "3010022", [["Avental", 1, "G"]], "Manipulação de ácidos no laboratório de química.");
  await epi_requisicao.enviar(tx, secretaria, em_analise);
  await epi_requisicao.iniciar_analise(tx, analista, em_analise);

  // ANALISADA — um item aprovado e outro recusado, com motivo do catálogo
  const mista = await pedir(
    secretaria,
    "3010055",
    [
      ["Luva", 2, "P"],
      ["Capacete", 1, ""],
    ],
    "Rotina de bancada no laboratório de química do ICA.",
  );
  await epi_requisicao.enviar(tx, secretaria, mista);
  await epi_requisicao.iniciar_analise(tx, analista, mista);
  const [luva_mista, capacete_mista] = await linhas(mista);
  await epi_requisicao.aprovar_item(tx, analista, luva_mista!);
  const [sem_exposicao] = await tx
    .select()
    .from(e.epi_motivo_recusa)
    .where(eq(e.epi_motivo_recusa.codigo, "SEM_EXPOSICAO"));
  await epi_requisicao.recusar_item(tx, analista, capacete_mista!, { motivo: sem_exposicao! });
  await epi_requisicao.concluir_analise(tx, analista, mista, {
    parecer: "Luva deferida; capacete indeferido por ausência de exposição.",
  });

  // EM_ATENDIMENTO — item aprovado e reservado num lote
  const reservada = await pedir(secretaria, "3010066", [["Bota", 1, "40"]], "Trabalho em tanques do laboratório de aquicultura.");
  await epi_requisicao.enviar(tx, secretaria, reservada);
  await epi_requisicao.iniciar_analise(tx, analista, reservada);
  await epi_requisicao.aprovar_item(tx, analista, (await linhas(reservada))[0]!);
  await epi_requisicao.concluir_analise(tx, analista, reservada);
  await epi_requisicao.reservar_item(tx, almoxarife, (await linhas(reservada))[0]!, {
    entrada: await lote_de("L-2026-041"),
  });

  // ATENDIDA — aprovado, reservado e entregue: a ficha nasce da entrega
  const atendida = await pedir(secretaria, "3010077", [["Protetor", 2, ""]], "Rotina no laboratório de doenças infecciosas.");
  await epi_requisicao.enviar(tx, secretaria, atendida);
  await epi_requisicao.iniciar_analise(tx, analista, atendida);
  await epi_requisicao.aprovar_item(tx, analista, (await linhas(atendida))[0]!);
  await epi_requisicao.concluir_analise(tx, analista, atendida);
  await epi_requisicao.reservar_item(tx, almoxarife, (await linhas(atendida))[0]!, {
    entrada: await lote_de("L-2026-051"),
  });
  await epi_requisicao.entregar_item(tx, almoxarife, (await linhas(atendida))[0]!);

  // SEM_ESTOQUE — o item aprovado que a prateleira não tem, com a pendência
  // da fatia 7 aberta em nome de quem tem de decidir
  const faltando = await pedir(secretaria, "3010112", [["Macacão", 1, "G"]], "Apoio à limpeza de área com produto químico.");
  await epi_requisicao.enviar(tx, secretaria, faltando);
  await epi_requisicao.iniciar_analise(tx, analista, faltando);
  await epi_requisicao.aprovar_item(tx, analista, (await linhas(faltando))[0]!);
  await epi_requisicao.concluir_analise(tx, analista, faltando);
  await epi_requisicao.marcar_sem_estoque(tx, almoxarife, (await linhas(faltando))[0]!, {
    complemento: "Sem lote de macacão em estoque nesta data.",
  });

  // INDEFERIDA e CANCELADA — os dois terminais que não entregam nada
  const indeferida = await pedir(secretaria, "3010099", [["Cinturão", 1, ""]], "Atividade administrativa em piso térreo.");
  await epi_requisicao.enviar(tx, secretaria, indeferida);
  await epi_requisicao.iniciar_analise(tx, analista, indeferida);
  // o envelope só se indefere depois de TODO item recusado: indeferir é a
  // resposta ao pedido inteiro, e não um atalho por cima da decisão de linha
  await epi_requisicao.recusar_item(tx, analista, (await linhas(indeferida))[0]!, { motivo: sem_exposicao! });
  await epi_requisicao.indeferir(tx, analista, indeferida, {
    motivo: sem_exposicao!,
    parecer: "Não há trabalho em altura descrito na atividade informada.",
  });

  const cancelada = await pedir(secretaria, "3010123", [["Luva", 2, "G"]], "Coleta de solo em campo experimental.");
  await epi_requisicao.enviar(tx, secretaria, cancelada);
  await epi_requisicao.cancelar(tx, secretaria, cancelada, "Pedido duplicado (teste).");

  ctx.resumo.epi_requisicoes = 9;
}
