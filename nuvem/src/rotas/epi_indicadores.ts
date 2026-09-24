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
import { inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import { servidor as tabela_servidor } from "../db/esquema/index.js";
import { ROTULO_EPI_ITEM, ROTULO_EPI_REQUISICAO } from "../dominio/estados.js";
import { ErroHttp } from "../nucleo/erros.js";
import { usuarioLogado } from "../dependencias.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import * as servico from "../servicos/epi_indicadores.js";
import { hoje } from "../servicos/datas_br.js";
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
rotas.get(PAINEL, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  const tx = c.get("tx");
  const medidas = await servico.painel(tx);
  const ve_ficha = usuario.pode("epi.ficha");
  return pagina(c, "paginas/epis_painel.html", usuario, {
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
  return {
    exercicio: ano,
    dados,
    por_categoria,
    quantidade_categoria: _atrelar(dados.por_categoria, por_categoria),
    por_campus: suprimir_aninhado(dados.por_campus, nominal),
    recusas_motivo: suprimir(dados.recusas_por_motivo, nominal),
    recusas_unidade: suprimir(dados.recusas_por_unidade, nominal),
    limiar: LIMIAR_SUPRESSAO,
    suprime: !nominal,
  };
}

rotas.get(RELATORIOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("indicador.ver");
  const exercicio = _exercicio(c);
  return pagina(c, "paginas/epis_relatorios.html", usuario, {
    pode_exportar: usuario.pode("exportar"),
    ...(await _contexto(c.get("tx"), usuario, exercicio)),
  });
});

/** Uma linha de CSV do `csv.writer(delimiter=";")` (QUOTE_MINIMAL, `\r\n`). */
function _linha_csv(campos: (string | number | null | undefined)[]): string {
  return (
    campos
      .map((v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      })
      .join(";") + "\r\n"
  );
}

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

  let texto = _linha_csv(["Indicador", "Recorte", "Detalhe", "Servidores", "Quantidade"]);
  for (const [rotulo, valor] of Object.entries(ctx.por_categoria)) {
    texto += _linha_csv(["Entregue por categoria (NR-6)", rotulo, "", valor, ctx.quantidade_categoria[rotulo] ?? ""]);
  }
  for (const linha of ctx.por_campus) {
    texto += _linha_csv(["Entregue por campus", linha.rotulo, "", linha.valor, ""]);
    for (const [unidade, valor] of linha.folhas) {
      texto += _linha_csv(["Entregue por unidade", linha.rotulo, unidade, valor, ""]);
    }
  }
  for (const linha of dados.empenhos) {
    texto += _linha_csv([
      "Custo por empenho",
      linha.empenho,
      linha.incompleto ? "piso (há lote sem valor)" : "",
      "",
      linha.custo_texto ?? "",
    ]);
  }
  for (const [rotulo, valor] of Object.entries(ctx.recusas_motivo)) {
    texto += _linha_csv(["Recusas por motivo (RN-27)", rotulo, "", valor, ""]);
  }
  for (const [rotulo, valor] of Object.entries(ctx.recusas_unidade)) {
    texto += _linha_csv(["Recusas por unidade (RN-27)", rotulo, "", valor, ""]);
  }
  // o cabeçalho da supressão vai DENTRO do arquivo: o CSV se descola da tela no
  // primeiro anexo de e-mail
  if (ctx.suprime) {
    texto += _linha_csv([]);
    texto += _linha_csv([
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
