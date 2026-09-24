/**
 * /importar — carga da planilha e do JSON do Trello, com pré-visualização.
 * Porte de `app/rotas/importacao.py`.
 *
 * **Desvio da nuvem.** No Python o arquivo enviado era gravado em `entrada/`
 * (disco) e lido de lá; a tela listava o que havia na pasta. A função do
 * Netlify não tem disco: o arquivo é processado da memória e uma cópia vai para
 * o armazenamento (`entrada/<nome>`, a mesma guarda que a pasta fazia). A lista
 * "arquivos em entrada/" deixa de existir na tela — o armazenamento não é
 * pasta que se liste a cada abertura. Ver DESVIOS.md.
 */
import { Hono } from "hono";
import { desc, isNotNull } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioCom } from "../dependencias.js";
import { marcarDownload, pagina } from "../web.js";
import { migracao_rejeitada, stg_trello_cartao } from "../db/esquema/index.js";
import { obterArmazenamento } from "../servicos/armazenamento.js";
import * as importacao_planilha from "../servicos/importacao_planilha.js";
import * as importacao_trello from "../servicos/importacao_trello.js";
import * as servico_reconciliacao from "../servicos/reconciliacao.js";
import { recontar_sequencia } from "../servicos/numeracao.js";
import { linha_csv } from "./relatorios.js";

export const rotas = new Hono<Ambiente>();

rotas.get("/importar", async (c) => {
  const usuario = await usuarioCom(c, "catalogo.gerenciar");
  const tx = c.get("tx");
  return pagina(c, "paginas/importar.html", usuario, {
    entrada: [],
    rejeitadas: await tx.select().from(migracao_rejeitada).orderBy(desc(migracao_rejeitada.id)).limit(100),
    candidatos: await tx.select().from(stg_trello_cartao).where(isNotNull(stg_trello_cartao.parecer_candidato)),
  });
});

/** Os cinco relatórios da Fase 4 — expõem, nunca resolvem sozinhos. */
rotas.get("/importar/reconciliacao", async (c) => {
  const usuario = await usuarioCom(c, "catalogo.gerenciar");
  const tx = c.get("tx");
  return pagina(c, "paginas/reconciliacao.html", usuario, {
    reconciliacao: await servico_reconciliacao.reconciliar(tx),
    rejeitadas: await servico_reconciliacao.rejeitadas(tx),
  });
});

rotas.get("/importar/reconciliacao.csv", async (c) => {
  await usuarioCom(c, "exportar");
  const resultado = await servico_reconciliacao.reconciliar(c.get("tx"));
  let texto = linha_csv(["Relatório", "Referência", "Detalhe"]);
  for (const [titulo, , achados] of resultado.como_secoes()) {
    for (const achado of achados) texto += linha_csv([titulo, achado.referencia, achado.detalhe]);
  }
  marcarDownload(c);
  return c.body("﻿" + texto, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="reconciliacao.csv"',
  });
});

/** O arquivo do formulário, com a cópia guardada em `entrada/` do armazenamento. */
async function _receber(c: Ctx, padrao: string) {
  const f = await formulario(c);
  const arquivo = f.dados.get("arquivo");
  if (!(arquivo instanceof File)) throw new ErroHttp(422, "Campo obrigatório ausente: arquivo");
  const nome = (arquivo.name || padrao).replace(/[/\\\x00-\x1f]/g, "_") || padrao;
  const conteudo = new Uint8Array(await arquivo.arrayBuffer());
  await obterArmazenamento().gravar(`entrada/${nome}`, conteudo, arquivo.type || "application/octet-stream");
  return { f, nome, conteudo };
}

rotas.post("/importar/planilha", async (c) => {
  const usuario = await usuarioCom(c, "catalogo.gerenciar");
  const tx = c.get("tx");
  const { f, nome, conteudo } = await _receber(c, "planilha.xlsx");
  const aplicar = f.texto("aplicar") === "1";
  const relatorio = await importacao_planilha.importar(tx, { nome, conteudo }, usuario, aplicar);
  if (aplicar) await recontar_sequencia(tx);
  else desfazer(c);
  return pagina(c, "paginas/importar_relatorio.html", usuario, { relatorio, aplicado: aplicar, origem: "planilha" });
});

rotas.post("/importar/trello", async (c) => {
  const usuario = await usuarioCom(c, "catalogo.gerenciar");
  const tx = c.get("tx");
  const { f, conteudo } = await _receber(c, "trello.json");
  const aplicar = f.texto("aplicar") === "1";
  let dados: Record<string, unknown>;
  try {
    dados = JSON.parse(new TextDecoder().decode(conteudo));
  } catch {
    throw new ErroHttp(422, "O arquivo não é um JSON válido do quadro do Trello.");
  }
  const relatorio = await importacao_trello.importar(
    tx,
    dados,
    usuario,
    aplicar,
    // sem marcar, nada é baixado: os anexos entram no relatório de perdidos
    f.texto("baixar_anexos") === "1" ? importacao_trello.baixar_url : null,
  );
  if (!aplicar) desfazer(c);
  return pagina(c, "paginas/importar_relatorio_trello.html", usuario, {
    // o conjunto vira lista ordenada: o Nunjucks não percorre `Set`
    relatorio: Object.assign(relatorio, { listas_desconhecidas: [...relatorio.listas_desconhecidas].sort() }),
    aplicado: aplicar,
  });
});
