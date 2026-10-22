/**
 * /epis e /epis/relatorios — o painel do módulo e os indicadores da §9.
 * Porte de `app/rotas/epi_indicadores.py`.
 *
 * São duas telas com **permissões diferentes**, e a diferença não é acabamento:
 *
 * - `/epis` é `epi.ver`. É a tela de trabalho de quem opera o módulo: quantos
 *   pedidos estão parados, o que falta comprar, qual CA vence, quantas entregas
 *   saíram, quais trocas venceram. Cada número leva à fila dele.
 * - `/epis/relatorios` é **`indicador.ver`**, como a §9 manda e como
 *   `/relatorios` já faz: o painel conta o trabalho do setor, o relatório recorta
 *   a população por unidade e por categoria da NR-6 — que é onde a
 *   reidentificação acontece por acidente.
 *
 * **A supressão é a que o sistema já tem** (`suprimir`, de
 * `app/rotas/relatorios.py`), mais `suprimir_aninhado`, que nasceu por
 * necessidade: a §9 pede o entregue por unidade E por campus, e o total do
 * campus é a margem das unidades dele.
 */
import { Hono } from "hono";
import { asc, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import {
  epi_entrada_estoque as tabela_entrada,
  epi_ficha_registro as tabela_ficha,
  epi_item as tabela_epi_item,
  servidor as tabela_servidor,
} from "../db/esquema/index.js";
import { EPI_REQUISICAO_ENCERRADA, ROTULO_EPI_ITEM, ROTULO_EPI_REQUISICAO } from "../dominio/estados.js";
import { ErroHttp } from "../nucleo/erros.js";
import { usuarioLogado } from "../dependencias.js";
import { ESCOPO_AGREGADO, ESCOPO_PROPRIO, type UsuarioAtual } from "../servicos/rbac.js";
import * as epi_ficha from "../servicos/epi_ficha.js";
import * as epi_requisicao from "../servicos/epi_requisicao.js";
import * as servico from "../servicos/epi_indicadores.js";
import { hoje } from "../servicos/datas_br.js";
import { linha_csv } from "../servicos/csv.js";
import { marcarDownload, pagina } from "../web.js";
import { LIMIAR_SUPRESSAO, MARCA_SUPRIMIDO, suprimir, suprimir_aninhado } from "./relatorios.js";

export const rotas = new Hono<Ambiente>();

export const PAINEL = "/epis";
export const RELATORIOS = "/epis/relatorios";
export const EXPORTAR = "/epis/relatorios/exportar";

// =====================================================================
// Supressão da RN-19
// =====================================================================
// Mora em `src/rotas/relatorios.ts` (o `app/rotas/relatorios.py`): duas cópias
// da regra de privacidade divergiriam na primeira correção. Reexportada porque
// os testes do módulo a leem daqui, como no Python.
export { LIMIAR_SUPRESSAO, MARCA_SUPRIMIDO, suprimir, suprimir_aninhado };
export type { LinhaAninhada } from "./relatorios.js";

// =====================================================================
// Apoio
// =====================================================================
/** `{id: Servidor}` numa consulta, para o painel inteiro. */
async function _servidores_de(tx: Executor, registros: { servidor_id: number }[]) {
  const ids = [...new Set(registros.map((r) => r.servidor_id))];
  if (!ids.length) return {};
  const linhas = await tx.select().from(tabela_servidor).where(inArray(tabela_servidor.id, ids));
  return Object.fromEntries(linhas.map((sv) => [sv.id, sv]));
}

/**
 * A quantidade entregue, escondida onde a célula de servidores foi escondida.
 * Publicar "— servidores · 12 pares" seria suprimir o número de pessoas e
 * entregar, ao lado, um número que varia com elas.
 */
function _atrelar(celulas: servico.Celulas, visiveis: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(celulas.servidores).map((rotulo) => [
      rotulo,
      visiveis[rotulo] !== MARCA_SUPRIMIDO ? String(celulas.quantidade[rotulo] ?? 0) : MARCA_SUPRIMIDO,
    ]),
  );
}

/** O `exercicio: int | None` da query do FastAPI: ausente é None; torto é 422. */
function _exercicio(c: Ctx): number | null {
  const bruto = c.req.query("exercicio");
  if (bruto === undefined || bruto === "") return null;
  if (!/^[+-]?\d+$/.test(bruto.trim())) throw new ErroHttp(422, "exercicio: valor inteiro inválido");
  return Number(bruto.trim());
}

// =====================================================================
// O painel do módulo
// =====================================================================
/**
 * As cinco medidas do §9, cada uma com o caminho para a fila dela. A fileira
 * de filtros por estado continua na fila de `/epis/requisicoes`: lá cada número
 * É o filtro. São duas leituras da mesma função, e não dois números.
 */
/**
 * O painel de quem só pede EPI (escopo próprio): os pedidos DELE, o que ele
 * ainda precisa assinar e o que passou do prazo de troca. Os números do setor
 * (fila, falta de estoque, CA a vencer, entregas do mês) não são dele — e os
 * estados vazios desses números traziam códigos de permissão ("pede
 * `epi.ficha`") a quem não sabe o que é permissão.
 */
async function _painel_pessoal(c: Ctx, usuario: UsuarioAtual): Promise<Response> {
  const tx = c.get("tx");
  const dia = hoje();
  const pedidos = (await epi_requisicao.fila(tx, usuario)).reverse();
  const abertos = pedidos.filter((r) => r.estado !== "RASCUNHO" && !EPI_REQUISICAO_ENCERRADA.has(r.estado));
  const linhas = usuario.servidor_id !== null ? await epi_ficha.linha_do_tempo(tx, usuario.servidor_id) : [];
  return pagina(c, "paginas/epis_painel.html", usuario, {
    pessoal: true,
    hoje: dia,
    tem_servidor: usuario.servidor_id !== null,
    pedidos: pedidos.slice(0, 5).map((r) => ({ ...r, identificacao: epi_requisicao.identificacao(r) })),
    total_pedidos: pedidos.length,
    abertos: abertos.length,
    rascunhos: pedidos.filter((r) => r.estado === "RASCUNHO").length,
    trocas: linhas.filter((l) => l.troca_vencida_em(dia)),
    falta_assinar: linhas.filter((l) => l.sem_comprovante).length,
    rotulos: ROTULO_EPI_REQUISICAO,
    pode_pedir: usuario.pode("epi.requisitar"),
  });
}

rotas.get(PAINEL, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  if (usuario.escopo === ESCOPO_PROPRIO) return _painel_pessoal(c, usuario);
  const tx = c.get("tx");
  const ve_ficha = usuario.pode("epi.ficha");
  const opera = usuario.pode("epi.catalogo") || usuario.pode("epi.entregar");
  const [medidas, [item], [alguem]] = await Promise.all([
    // no escopo de quem lê: o número de pedidos e a fila de falta batem com a
    // fila de `/epis/requisicoes` dessa pessoa
    servico.painel(tx, null, usuario),
    opera ? tx.select({ id: tabela_epi_item.id }).from(tabela_epi_item).limit(1) : Promise.resolve([]),
    opera ? tx.select({ id: tabela_servidor.id }).from(tabela_servidor).limit(1) : Promise.resolve([]),
  ]);
  // Catálogo vazio: a tela diz por onde começar (a entrega pede item e servidor).
  let primeiros_passos: { rotulo: string; feito: boolean; href: string | null; dica: string }[] | null = null;
  if (opera) {
    if (!item) {
      primeiros_passos = [
        {
          rotulo: "Cadastrar os itens no catálogo",
          feito: false,
          href: "/epis/catalogo",
          dica: "Luva, bota, protetor… com o CA quando houver.",
        },
        {
          rotulo: "Cadastrar os servidores",
          feito: Boolean(alguem),
          href: "/servidores",
          dica: "Um a um ou por planilha (Importar), com SIAPE e nome.",
        },
        {
          rotulo: "Registrar a primeira entrega",
          feito: false,
          href: null,
          dica: "No botão “Registrar entrega”: sai a ficha e o comprovante. Estoque e requisição são opcionais.",
        },
      ];
    }
  }
  return pagina(c, "paginas/epis_painel.html", usuario, {
    primeiros_passos,
    p: medidas,
    hoje: medidas.quando,
    rotulos: ROTULO_EPI_REQUISICAO,
    rotulos_item: ROTULO_EPI_ITEM,
    // As cinco MEDIDAS são `epi.ver`; as LINHAS de ficha embaixo de duas delas
    // são `epi.ficha` desde a fatia 2 — histórico sobre a segurança de uma
    // pessoa determinada. O painel não é lugar de afrouxar permissão.
    ve_ficha,
    // `identificar(...)` precisa do OBJETO: com o id sozinho ela cai no lado
    // seguro e devolve o código opaco a todo mundo — inclusive ao almoxarife.
    servidores: ve_ficha ? await _servidores_de(tx, [...medidas.trocas_devidas, ...medidas.entregas_do_mes]) : {},
    pode_indicador: usuario.pode("indicador.ver"),
    // o link do protocolo só para quem abre o pedido: o painel já recorta pelo
    // escopo, e o agregado (admin) lê o número sem abrir pedido de ninguém
    abre_pedido: usuario.escopo !== ESCOPO_AGREGADO,
  });
});

// =====================================================================
// Os indicadores
// =====================================================================
export async function _contexto(tx: Executor, usuario: UsuarioAtual, exercicio: number | null) {
  const ano = exercicio || Number(hoje().slice(0, 4));
  const inicio = `${String(ano).padStart(4, "0")}-01-01`;
  const fim = `${String(ano).padStart(4, "0")}-12-31`;
  const dados = await servico.relatorio(tx, { inicio, fim });
  const nominal = usuario.ve_dado_nominal;
  const por_categoria = suprimir(dados.por_categoria.servidores, nominal);
  const quantidade_categoria = _atrelar(dados.por_categoria, por_categoria);
  const por_campus = suprimir_aninhado(dados.por_campus, nominal);
  const recusas_motivo = suprimir(dados.recusas_por_motivo, nominal);
  const recusas_unidade = suprimir(dados.recusas_por_unidade, nominal);
  // Tudo escondido: com poucos atendimentos, quem não vê nome lê só traços — e
  // a tela precisa dizer por quê no topo, senão parece defeito.
  const valores = [
    ...Object.values(por_categoria),
    ...Object.values(recusas_motivo),
    ...Object.values(recusas_unidade),
    ...por_campus.map((l) => l.valor),
  ];
  const tudo_mascarado = !nominal && valores.length > 0 && valores.every((v) => v === MARCA_SUPRIMIDO);
  return {
    exercicio: ano,
    dados,
    por_categoria,
    quantidade_categoria,
    // o rótulo cinza da barra, para a TELA: "12 peças" e não um número solto
    // ao lado de outro número solto. O CSV continua com a quantidade crua.
    pecas_categoria: Object.fromEntries(
      Object.entries(quantidade_categoria).map(([rotulo, q]) => [
        rotulo,
        q === MARCA_SUPRIMIDO ? q : `${q} ${q === "1" ? "peça" : "peças"}`,
      ]),
    ),
    por_campus,
    recusas_motivo,
    recusas_unidade,
    limiar: LIMIAR_SUPRESSAO,
    suprime: !nominal,
    tudo_mascarado,
  };
}

/**
 * Os exercícios do seletor: do ano corrente para trás, até o primeiro ano com
 * entrega ou lote registrado (no mínimo o corrente e o anterior). Era só pela
 * URL (`?exercicio=`), e ninguém adivinhava o parâmetro.
 */
async function _exercicios(tx: Executor): Promise<number[]> {
  const ano = Number(hoje().slice(0, 4));
  const [primeira] = await tx
    .select({ dia: tabela_ficha.data_evento })
    .from(tabela_ficha)
    .orderBy(asc(tabela_ficha.data_evento))
    .limit(1);
  const [primeiro_lote] = await tx
    .select({ dia: tabela_entrada.data_entrada })
    .from(tabela_entrada)
    .orderBy(asc(tabela_entrada.data_entrada))
    .limit(1);
  const anos = [primeira?.dia, primeiro_lote?.dia].filter((d): d is string => Boolean(d)).map((d) => Number(d.slice(0, 4)));
  const inicio = Math.min(ano - 1, ...anos);
  const saida: number[] = [];
  for (let a = ano; a >= inicio; a--) saida.push(a);
  return saida;
}

rotas.get(RELATORIOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("indicador.ver");
  const exercicio = _exercicio(c);
  const tx = c.get("tx");
  const ctx = await _contexto(tx, usuario, exercicio);
  const exercicios = await _exercicios(tx);
  if (!exercicios.includes(ctx.exercicio)) exercicios.push(ctx.exercicio);
  return pagina(c, "paginas/epis_relatorios.html", usuario, {
    pode_exportar: usuario.pode("exportar"),
    exercicios: exercicios.sort((x, y) => y - x),
    ...ctx,
  });
});

/**
 * O CSV do relatório, com a MESMA supressão. Separado da rota para que o teste
 * exercite o caminho de quem tem `exportar` sem ver nominal — combinação que
 * nenhum perfil semeado tem, mas que uma concessão avulsa cria.
 */
export async function exportar(
  tx: Executor,
  usuario: UsuarioAtual,
  exercicio: number | null,
): Promise<{ nome: string; corpo: Uint8Array }> {
  usuario.exigir("indicador.ver");
  usuario.exigir("exportar");
  const ctx = await _contexto(tx, usuario, exercicio);
  const dados = ctx.dados;

  let texto = linha_csv(["Indicador", "Recorte", "Detalhe", "Servidores", "Quantidade"]);
  for (const [rotulo, valor] of Object.entries(ctx.por_categoria)) {
    texto += linha_csv(["Entregue por categoria (NR-6)", rotulo, "", valor, ctx.quantidade_categoria[rotulo] ?? ""]);
  }
  for (const linha of ctx.por_campus) {
    texto += linha_csv(["Entregue por campus", linha.rotulo, "", linha.valor, ""]);
    for (const [unidade, valor] of linha.folhas) {
      texto += linha_csv(["Entregue por unidade", linha.rotulo, unidade, valor, ""]);
    }
  }
  for (const linha of dados.empenhos) {
    texto += linha_csv([
      "Custo por empenho",
      linha.empenho,
      linha.incompleto ? "piso (há lote sem valor)" : "",
      "",
      linha.custo_texto ?? "",
    ]);
  }
  for (const [rotulo, valor] of Object.entries(ctx.recusas_motivo)) {
    texto += linha_csv(["Recusas por motivo", rotulo, "", valor, ""]);
  }
  for (const [rotulo, valor] of Object.entries(ctx.recusas_unidade)) {
    texto += linha_csv(["Recusas por unidade", rotulo, "", valor, ""]);
  }
  // o cabeçalho da supressão vai DENTRO do arquivo: o CSV se descola da tela no
  // primeiro anexo de e-mail
  if (ctx.suprime) {
    texto += linha_csv([]);
    texto += linha_csv([
      "Nota",
      `Célula com menos de ${LIMIAR_SUPRESSAO} servidores sai como ` +
        `'${MARCA_SUPRIMIDO}' (RN-19). Quando só uma seria suprimida, a ` +
        "menor sobrevivente vai junto, e o total do campus some com as " +
        "unidades dele — senão a subtração devolveria o número escondido.",
      "",
      "",
      "",
    ]);
  }
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const conteudo = new TextEncoder().encode(texto);
  const corpo = new Uint8Array(bom.length + conteudo.length);
  corpo.set(bom);
  corpo.set(conteudo, bom.length);
  return { nome: `epi-indicadores-${ctx.exercicio}.csv`, corpo };
}

/**
 * O mesmo relatório em CSV. Duas exigências: `indicador.ver` porque é o mesmo
 * conteúdo da tela, e `exportar` porque planilha sai da máquina. Ponto e
 * vírgula, UTF-8 com BOM — o formato de `/relatorios/exportar-processos`.
 */
rotas.get(EXPORTAR, async (c) => {
  const usuario = await usuarioLogado(c);
  const exercicio = _exercicio(c);
  const { nome, corpo } = await exportar(c.get("tx"), usuario, exercicio);
  marcarDownload(c);
  return c.body(corpo as unknown as ArrayBuffer, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${nome}"`,
  });
});
