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
import * as epi_contagens from "../servicos/epi_contagens.js";
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
function _exercicio(bruto: string | undefined): number | null {
  if (bruto === undefined || bruto === "") return null;
  if (!/^[+-]?\d+$/.test(bruto.trim())) throw new ErroHttp(422, "exercicio: valor inteiro inválido");
  return Number(bruto.trim());
}

/**
 * O recorte de tempo do relatório (fatia D). `exercicio` continua sendo o
 * atalho — o ano inteiro, de 01/01 a 31/12 —, e `inicio`/`fim` são o período
 * livre. Quem ganha quando os dois chegam é o exercício NUMÉRICO: os campos de
 * data continuam no formulário quando o seletor volta para um ano, e o ano é a
 * escolha que a pessoa acabou de fazer. `exercicio=livre` (a opção "Período
 * livre" do seletor) é o mesmo que não mandar exercício.
 */
export interface Periodo {
  inicio: string;
  fim: string;
  /** o ano, quando o recorte é um exercício inteiro; `null` no período livre */
  exercicio: number | null;
}

const RE_DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'AAAA-MM-DD' que existe no calendário; o resto é 422 com o nome do campo. */
function _data_da_consulta(bruto: string | undefined, rotulo: string): string | null {
  if (bruto === undefined || bruto.trim() === "") return null;
  const texto = bruto.trim();
  const m = RE_DATA_ISO.exec(texto);
  if (m) {
    const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    if (ano >= 1900 && d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia) return texto;
  }
  throw new ErroHttp(422, `${rotulo}: data inválida — use o formato AAAA-MM-DD.`);
}

/** O recorte pedido na consulta, já validado (422 em português quando não fecha). */
export function periodo_da_consulta(consulta: {
  exercicio?: string | undefined;
  inicio?: string | undefined;
  fim?: string | undefined;
}): Periodo {
  const bruto_exercicio = (consulta.exercicio ?? "").trim();
  if (bruto_exercicio !== "" && bruto_exercicio !== "livre") return _periodo_do_exercicio(_exercicio(bruto_exercicio));
  const inicio_lido = _data_da_consulta(consulta.inicio, "Início do período");
  const fim_lido = _data_da_consulta(consulta.fim, "Fim do período");
  if (inicio_lido === null && fim_lido === null) return _periodo_do_exercicio(null);
  // só um dos dois: o fim padrão é hoje; o início padrão, 01/01 do ano do fim
  const fim = fim_lido ?? hoje();
  const inicio = inicio_lido ?? `${fim.slice(0, 4)}-01-01`;
  if (inicio > fim) {
    throw new ErroHttp(422, "O início do período não pode ser depois do fim.");
  }
  if (fim > servico.ultimo_dia_do_periodo(inicio)) {
    throw new ErroHttp(
      422,
      `O período pode ter no máximo ${servico.ANOS_MAXIMOS_DO_PERIODO} anos: escolha um fim até ` +
        `${servico.ultimo_dia_do_periodo(inicio).split("-").reverse().join("/")}.`,
    );
  }
  return { inicio, fim, exercicio: null };
}

function _periodo_do_exercicio(exercicio: number | null): Periodo {
  const ano = exercicio || Number(hoje().slice(0, 4));
  const texto = String(ano).padStart(4, "0");
  return { inicio: `${texto}-01-01`, fim: `${texto}-12-31`, exercicio: ano };
}

function _periodo(c: Ctx): Periodo {
  return periodo_da_consulta({
    exercicio: c.req.query("exercicio"),
    inicio: c.req.query("inicio"),
    fim: c.req.query("fim"),
  });
}

/**
 * A célula ao lado da quantidade: as linhas de um ranking com os números já
 * passados pela supressão. A ORDEM é decrescente pelas peças (o legado,
 * `L:EPI_Backend.js:1110-1194`), mas só entre as visíveis: a linha suprimida
 * vai para o fim, em ordem alfabética — a posição dela no ranking diria, por
 * comparação com as vizinhas, quanto ela escondia.
 */
export interface LinhaRanking {
  rotulo: string;
  servidores: string;
  quantidade: string;
  readonly suprimido: boolean;
}

function _ranking(celulas: servico.Celulas, nominal: boolean): LinhaRanking[] {
  const servidores = suprimir(celulas.servidores, nominal);
  const quantidade = _atrelar(celulas, servidores);
  const linhas = Object.keys(celulas.servidores).map((rotulo) => ({
    rotulo,
    servidores: servidores[rotulo]!,
    quantidade: quantidade[rotulo]!,
    get suprimido() {
      return this.servidores === MARCA_SUPRIMIDO;
    },
  }));
  const visiveis = linhas
    .filter((l) => !l.suprimido)
    .sort(
      (a, b) =>
        (celulas.quantidade[b.rotulo] ?? 0) - (celulas.quantidade[a.rotulo] ?? 0) ||
        (celulas.servidores[b.rotulo] ?? 0) - (celulas.servidores[a.rotulo] ?? 0) ||
        a.rotulo.localeCompare(b.rotulo, "pt-BR"),
    );
  const escondidas = linhas.filter((l) => l.suprimido).sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));
  return [...visiveis, ...escondidas];
}

/**
 * O ranking na forma de `ui.distribuicao`: a barra é a quantidade de PEÇAS (o
 * que o legado ordenava) e a nota cinza, os servidores. A macro reordena pelo
 * valor, de forma estável, e manda o traço para o fim — a mesma ordem de
 * `_ranking`.
 */
function _barras_do_ranking(linhas: LinhaRanking[]): { valores: Record<string, string>; notas: Record<string, string> } {
  const valores: Record<string, string> = {};
  const notas: Record<string, string> = {};
  for (const l of linhas) {
    valores[l.rotulo] = l.quantidade;
    if (!l.suprimido) notas[l.rotulo] = `${l.servidores} ${l.servidores === "1" ? "servidor" : "servidores"}`;
  }
  return { valores, notas };
}

/** "12 peças" — o rótulo cinza ao lado da barra. */
function _pecas(quantidades: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(quantidades).map(([rotulo, q]) => [
      rotulo,
      q === MARCA_SUPRIMIDO ? q : `${q} ${q === "1" ? "peça" : "peças"}`,
    ]),
  );
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
  // pelo escopo de `epi.ver`, e não da conta (D1): quem só alcança o próprio
  // EPI (a concessão do titular) tem o painel pessoal
  if (usuario.escopo_de("epi.ver") === ESCOPO_PROPRIO) return _painel_pessoal(c, usuario);
  const tx = c.get("tx");
  const ve_ficha = usuario.pode("epi.ficha");
  const opera = usuario.pode("epi.catalogo") || usuario.pode("epi.entregar");
  // no escopo de quem lê: o número de pedidos e a fila de falta batem com a
  // fila de `/epis/requisicoes` dessa pessoa
  const medindo = servico.painel(tx, null, usuario);
  const [medidas, [item], [alguem], a_tratar] = await Promise.all([
    medindo,
    opera ? tx.select({ id: tabela_epi_item.id }).from(tabela_epi_item).limit(1) : Promise.resolve([]),
    opera ? tx.select({ id: tabela_servidor.id }).from(tabela_servidor).limit(1) : Promise.resolve([]),
    // fatia G: pedidos a analisar (do mesmo resumo por estado, sem consulta a
    // mais) e comunicações do titular a tratar, cada um só para quem faz o ato
    epi_contagens.contagens(tx, usuario, { resumo: medindo.then((m) => m.requisicoes_por_estado) }),
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
    a_tratar,
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
    abre_pedido: usuario.escopo_de("epi.ver") !== ESCOPO_AGREGADO,
  });
});

// =====================================================================
// Os indicadores
// =====================================================================
/**
 * `recorte`: o ano do exercício (ou `null`, o corrente) — a assinatura de
 * antes — ou o `Periodo` já validado de `periodo_da_consulta`.
 */
export async function _contexto(tx: Executor, usuario: UsuarioAtual, recorte: number | null | Periodo) {
  const periodo = typeof recorte === "object" && recorte !== null ? recorte : _periodo_do_exercicio(recorte);
  const { inicio, fim } = periodo;
  const dados = await servico.relatorio(tx, { inicio, fim });
  // o relatório conta a instituição inteira (sem recorte de linha): sem
  // supressão só para quem lê o nome em todo campus — `epi.ficha` vale aqui,
  // que é tela de EPI. Era `ve_dado_nominal`: a permissão em qualquer campus
  // bastava para ler as contagens pequenas dos outros (D9)
  const nominal = usuario.ve_dado_nominal_sem_recorte(["exposicao.ver", "epi.ficha"]);
  const por_categoria = suprimir(dados.por_categoria.servidores, nominal);
  const quantidade_categoria = _atrelar(dados.por_categoria, por_categoria);
  const por_campus = suprimir_aninhado(dados.por_campus, nominal);
  const recusas_motivo = suprimir(dados.recusas_por_motivo, nominal);
  const recusas_unidade = suprimir(dados.recusas_por_unidade, nominal);
  // Fatia D. O total do período é a margem de todas as distribuições: com
  // menos de cinco servidores atendidos ele mesmo é a célula pequena.
  const total_visivel = nominal || dados.total_servidores >= LIMIAR_SUPRESSAO;
  const total_entregue = total_visivel ? String(dados.total_entregue) : MARCA_SUPRIMIDO;
  const total_servidores = total_visivel ? String(dados.total_servidores) : MARCA_SUPRIMIDO;
  const ranking_epi = _ranking(dados.por_epi, nominal);
  // por cargo: a supressão de sempre (primária abaixo de cinco servidores
  // distintos, mais a secundária) — cargo raro numa unidade é gente nomeada
  const por_cargo = suprimir(dados.por_cargo.servidores, nominal);
  const quantidade_cargo = _atrelar(dados.por_cargo, por_cargo);
  const ranking_cargo = _ranking(dados.por_cargo, nominal);
  const movimentos = _ranking(dados.movimentos, nominal);
  // Tudo escondido: com poucos atendimentos, quem não vê nome lê só traços — e
  // a tela precisa dizer por quê no topo, senão parece defeito.
  const valores = [
    ...Object.values(por_categoria),
    ...Object.values(recusas_motivo),
    ...Object.values(recusas_unidade),
    ...por_campus.map((l) => l.valor),
    ...ranking_epi.map((l) => l.servidores),
    ...Object.values(por_cargo),
  ];
  const tudo_mascarado = !nominal && valores.length > 0 && valores.every((v) => v === MARCA_SUPRIMIDO);
  return {
    exercicio: periodo.exercicio,
    periodo,
    // o recorte nas frases da tela: "em 2026" ou "de 01/03/2026 a 30/06/2026"
    recorte_texto:
      periodo.exercicio !== null
        ? `em ${periodo.exercicio}`
        : `de ${inicio.split("-").reverse().join("/")} a ${fim.split("-").reverse().join("/")}`,
    // a mesma consulta, para o link do CSV levar o mesmo recorte da tela
    consulta:
      periodo.exercicio !== null
        ? `exercicio=${periodo.exercicio}`
        : `inicio=${encodeURIComponent(inicio)}&fim=${encodeURIComponent(fim)}`,
    total_entregue,
    total_servidores,
    ranking_epi,
    barras_epi: _barras_do_ranking(ranking_epi),
    barras_movimentos: _barras_do_ranking(movimentos),
    por_cargo,
    quantidade_cargo,
    pecas_cargo: _pecas(quantidade_cargo),
    ranking_cargo,
    movimentos,
    dados,
    por_categoria,
    quantidade_categoria,
    // o rótulo cinza da barra, para a TELA: "12 peças" e não um número solto
    // ao lado de outro número solto. O CSV continua com a quantidade crua.
    pecas_categoria: _pecas(quantidade_categoria),
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
  // o relatório é do módulo de EPI: "sem acesso" a ele fecha também esta tela
  // (liberação por módulo, 22/10/2026; o item de menu declara as duas)
  usuario.exigir_na_equipe("epi.ver");
  const periodo = _periodo(c);
  const tx = c.get("tx");
  const ctx = await _contexto(tx, usuario, periodo);
  const exercicios = await _exercicios(tx);
  if (ctx.exercicio !== null && !exercicios.includes(ctx.exercicio)) exercicios.push(ctx.exercicio);
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
  recorte: number | null | Periodo,
): Promise<{ nome: string; corpo: Uint8Array }> {
  usuario.exigir("indicador.ver");
  usuario.exigir("exportar");
  const ctx = await _contexto(tx, usuario, recorte);
  const dados = ctx.dados;

  let texto = linha_csv(["Indicador", "Recorte", "Detalhe", "Servidores", "Quantidade"]);
  // Fatia D: o período e o total vêm primeiro — é o que diz de que janela
  // são todas as linhas abaixo
  texto += linha_csv(["Período", ctx.periodo.inicio, ctx.periodo.fim, "", ""]);
  texto += linha_csv(["Total entregue no período", "", "", ctx.total_servidores, ctx.total_entregue]);
  for (const linha of ctx.ranking_epi) {
    texto += linha_csv(["Entregue por EPI", linha.rotulo, "", linha.servidores, linha.quantidade]);
  }
  for (const linha of ctx.ranking_cargo) {
    texto += linha_csv(["Entregue por cargo", linha.rotulo, "", linha.servidores, linha.quantidade]);
  }
  for (const linha of ctx.movimentos) {
    texto += linha_csv(["Devoluções e extravios", linha.rotulo, "", linha.servidores, linha.quantidade]);
  }
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
  const sufixo = ctx.exercicio !== null ? String(ctx.exercicio) : `${ctx.periodo.inicio}_a_${ctx.periodo.fim}`;
  return { nome: `epi-indicadores-${sufixo}.csv`, corpo };
}

/**
 * O mesmo relatório em CSV. Duas exigências: `indicador.ver` porque é o mesmo
 * conteúdo da tela, e `exportar` porque planilha sai da máquina. Ponto e
 * vírgula, UTF-8 com BOM — o formato de `/relatorios/exportar-processos`.
 */
rotas.get(EXPORTAR, async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão antes da consulta: quem não exporta recebe 403, e não o 422
  // de uma data torta
  usuario.exigir("indicador.ver");
  usuario.exigir("exportar");
  const periodo = _periodo(c);
  const { nome, corpo } = await exportar(c.get("tx"), usuario, periodo);
  marcarDownload(c);
  return c.body(corpo as unknown as ArrayBuffer, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${nome}"`,
  });
});
