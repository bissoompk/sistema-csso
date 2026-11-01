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
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import { desc, isNotNull } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { formulario, usuarioCom } from "../dependencias.js";
import { marcarDownload, pagina } from "../web.js";
import { migracao_rejeitada, stg_trello_cartao } from "../db/esquema/index.js";
import { obterArmazenamento } from "../servicos/armazenamento.js";
import { chave_de_entrada } from "../servicos/privacidade.js";
import { ArquivoZipRecusado } from "../servicos/arquivo_zip.js";
import * as importacao_planilha from "../servicos/importacao_planilha.js";
import * as importacao_trello from "../servicos/importacao_trello.js";
import * as servico_reconciliacao from "../servicos/reconciliacao.js";
import { recontar_sequencia } from "../servicos/numeracao.js";
import { linha_csv } from "../servicos/csv.js";
import * as textos from "../servicos/textos.js";
import type { UsuarioAtual } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

/**
 * A tela de envio, em branco ou com a recusa do arquivo. Arquivo que não serve
 * (zip estranho, JSON quebrado, JSON que não é do Trello) volta AQUI, com a
 * frase ao lado do formulário de onde veio — e não numa página de erro 422 com
 * "Ir para o Painel", que obrigava a navegar de volta e escolher de novo.
 */
async function _tela_importar(
  c: Ctx,
  usuario: UsuarioAtual,
  recusa: { origem: "planilha" | "trello"; mensagem: string } | null = null,
  status = 200,
) {
  const tx = c.get("tx");
  return pagina(
    c,
    "paginas/importar.html",
    usuario,
    {
      entrada: [],
      rejeitadas: await tx.select().from(migracao_rejeitada).orderBy(desc(migracao_rejeitada.id)).limit(100),
      candidatos: await tx.select().from(stg_trello_cartao).where(isNotNull(stg_trello_cartao.parecer_candidato)),
      erro_planilha: recusa?.origem === "planilha" ? recusa.mensagem : null,
      erro_trello: recusa?.origem === "trello" ? recusa.mensagem : null,
    },
    status,
  );
}

/**
 * A importação grava PROCESSOS (planilha e Trello): `catalogo.gerenciar` é
 * transversal e não basta — quem está "Sem acesso" a Processos SEI não a abre
 * (23/10/2026), como o item "Importar" some do menu.
 */
async function _quem_importa(c: Ctx) {
  const usuario = await usuarioCom(c, "catalogo.gerenciar");
  exigir_acesso_ao_modulo(usuario, "processos-sei");
  return usuario;
}

rotas.get("/importar", async (c) => {
  const usuario = await _quem_importa(c);
  return _tela_importar(c, usuario);
});

/** Os cinco relatórios da Fase 4 — expõem, nunca resolvem sozinhos. */
rotas.get("/importar/reconciliacao", async (c) => {
  const usuario = await _quem_importa(c);
  const tx = c.get("tx");
  return pagina(c, "paginas/reconciliacao.html", usuario, {
    reconciliacao: await servico_reconciliacao.reconciliar(tx),
    rejeitadas: await servico_reconciliacao.rejeitadas(tx),
  });
});

// O CSV é a MESMA reconciliação da tela, em outra forma: exige a mesma
// permissão. Com `exportar` ele abria para quem recebia 403 na tela de onde o
// link sai (engenheiro, técnico, médico).
rotas.get("/importar/reconciliacao.csv", async (c) => {
  await _quem_importa(c);
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

/**
 * O arquivo do formulário, com a cópia guardada em `entrada/` do armazenamento.
 * `null` quando não veio arquivo (ou veio vazio): quem chama devolve a tela.
 */
async function _receber(c: Ctx, padrao: string) {
  const f = await formulario(c);
  const arquivo = f.arquivo("arquivo");
  if (arquivo === null) return null;
  const nome = (arquivo.name || padrao).replace(/[/\\\x00-\x1f]/g, "_") || padrao;
  const conteudo = new Uint8Array(await arquivo.arrayBuffer());
  await obterArmazenamento().gravar(chave_de_entrada(nome), conteudo, arquivo.type || "application/octet-stream");
  return { f, nome, conteudo };
}

const SEM_ARQUIVO = "Escolha o arquivo antes de importar — nenhum arquivo chegou.";

rotas.post("/importar/planilha", async (c) => {
  const usuario = await _quem_importa(c);
  const tx = c.get("tx");
  const recebido = await _receber(c, "planilha.xlsx");
  if (recebido === null) return _tela_importar(c, usuario, { origem: "planilha", mensagem: SEM_ARQUIVO }, 422);
  const { f, nome, conteudo } = recebido;
  const aplicar = f.texto("aplicar") === "1";
  let relatorio;
  try {
    relatorio = await importacao_planilha.importar(tx, { nome, conteudo }, usuario, aplicar);
  } catch (erro) {
    if (erro instanceof ArquivoZipRecusado) {
      desfazer(c);
      return _tela_importar(
        c,
        usuario,
        { origem: "planilha", mensagem: `O arquivo não foi aceito como planilha .xlsx: ${erro.message}` },
        422,
      );
    }
    throw erro;
  }
  if (aplicar) await recontar_sequencia(tx);
  else desfazer(c);
  return pagina(c, "paginas/importar_relatorio.html", usuario, { relatorio, aplicado: aplicar, origem: "planilha" });
});

rotas.post("/importar/trello", async (c) => {
  const usuario = await _quem_importa(c);
  const tx = c.get("tx");
  const recebido = await _receber(c, "trello.json");
  if (recebido === null) return _tela_importar(c, usuario, { origem: "trello", mensagem: SEM_ARQUIVO }, 422);
  const { f, conteudo } = recebido;
  const aplicar = f.texto("aplicar") === "1";
  let dados: Record<string, unknown>;
  try {
    // CPF escrito em cartão/comentário não chega ao staging, ao processo nem
    // ao `migracao_rejeitada.payload` (revisão de privacidade, 25/09/2026)
    dados = textos.mascarar_cpf_em(JSON.parse(new TextDecoder().decode(conteudo)));
  } catch {
    return _tela_importar(
      c,
      usuario,
      { origem: "trello", mensagem: "O arquivo não é um JSON válido: exporte o quadro de novo pelo Trello (Menu → Imprimir e exportar → Exportar como JSON)." },
      422,
    );
  }
  if (!importacao_trello.parece_export_do_trello(dados)) {
    return _tela_importar(
      c,
      usuario,
      {
        origem: "trello",
        mensagem:
          "O arquivo é um JSON, mas não parece um export do Trello: faltam as listas de cartões " +
          "(cards e lists). Exporte pelo menu do quadro → Imprimir e exportar → Exportar como JSON.",
      },
      422,
    );
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
