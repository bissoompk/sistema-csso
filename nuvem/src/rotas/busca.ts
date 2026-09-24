/**
 * /buscar — a caixa do cabeçalho, atravessando o sistema inteiro.
 * Porte de `app/rotas/busca.py`.
 *
 * A tela é um índice: seis blocos, cada um guardado pela permissão que a sua
 * rota de destino exige, e cada linha levando à tela que de fato abre para quem
 * perguntou. Quem monta os blocos é `servicos/busca.ts`; aqui fica a rota, o
 * recado do CPF e a decisão de auditoria.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { dicionario } from "../dicionario.js";
import { ROTULO_EPI_REQUISICAO } from "../dominio/estados.js";
import * as servico from "../servicos/busca.js";
import * as textos from "../servicos/textos.js";
import { pagina } from "../web.js";

export const rotas = new Hono<Ambiente>();

/**
 * A busca global. Abre para qualquer sessão; cada bloco se guarda sozinho.
 *
 * **Não exige permissão nenhuma**, de propósito: a permissão vive nos blocos, e
 * um 403 na tela inteira devolveria ao almoxarife um campo de texto que responde
 * "acesso negado". Sem bloco visível a tela abre e diz isso (o recuo de `/modulos`).
 *
 * **Não grava `acesso_dado_sensivel`, e a decisão é deliberada** (a RN-23
 * registra a LEITURA do dado sensível, e nenhuma lista grava): (1) o que se
 * registra é a porta, não o índice — o clique cai numa rota que já conta; (2)
 * uma linha por busca afogaria as leituras de verdade em ruído; (3) escrever
 * aqui poria escrita na tela mais acionada do sistema.
 */
rotas.get("/buscar", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const q = c.req.query("q") ?? "";
  const termo = q.trim();
  const blocos = await servico.buscar(tx, usuario, termo);
  return pagina(c, "paginas/busca.html", usuario, {
    q,
    termo,
    // a caixa do cabeçalho não pode esvaziar quando a pessoa cai no resultado
    busca: termo,
    blocos,
    // o `blocos|selectattr('itens')` do Jinja: o filtro portado usa a verdade
    // do JavaScript (lista vazia é verdadeira), então a conta sai daqui
    achou: blocos.filter((b) => b.itens.length > 0),
    // o que a busca cobre PARA ESTA PESSOA; o que ficou de fora não é nomeado
    cobertura: servico.cobertura(usuario),
    rotulos_requisicao: dicionario(ROTULO_EPI_REQUISICAO),
    recado_cpf: textos.parece_cpf(termo) ? servico.RECADO_CPF : "",
  });
});
