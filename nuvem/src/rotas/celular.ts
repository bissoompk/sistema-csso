/**
 * `/celular` — a tela de bolso do balcão e da chamada, em cima da `/api/v1`.
 * Porte de `app/rotas/celular.py`.
 *
 * **O que é.** Uma página só, sem lateral, com dois trabalhos: entregar EPI no
 * balcão e transcrever a folha de presença de um dia. A página é HTML mínimo, e
 * TUDO o que ela mostra vem da API em JSON (`public/estaticos/js/celular.js`).
 *
 * **PWA, no que cabe.** O manifesto faz o navegador oferecer "adicionar à tela
 * inicial", e o service worker (`/sw.js`) guarda a casca para ela abrir sem rede
 * e dizer "sem rede" com as próprias palavras. Os DADOS nunca são guardados
 * (ROPA §6). O `sw.js` é servido daqui, e não de `/estaticos/`, porque o escopo
 * de um service worker é o caminho de onde ele foi baixado.
 *
 * Na nuvem o `sw.js` é lido do bundle da função (`included_files` do
 * `netlify.toml`): `public/` vai para o CDN e não está no disco da função.
 */
import { Hono } from "hono";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioLogado } from "../dependencias.js";
import { ErroHttp } from "../nucleo/erros.js";
import { MEU_ESPACO, cartao_meu_espaco, meu_espaco_grupos_de, type Item } from "../modulos.js";
import { pagina } from "../web.js";
import { pastaDeEstaticos } from "./aplicativo.js";

export const rotas = new Hono<Ambiente>();

/**
 * Os atalhos de quem não tem balcão nem chamada: o servidor que instalou a
 * tela no celular. Desde o Portal do servidor (22/10/2026) são a MESMA lista
 * do "Meu espaço" (`modulos.MEU_ESPACO`, nos mesmos grupos), menos o "Início",
 * que é o sistema completo — a tela de bolso já tem o link para ele. Cada item
 * aparece só se abre para a conta (`modulos.meu_espaco_de`): sem servidor
 * vinculado as telas do titular abririam vazias, e então não aparecem. Nada
 * de código de permissão na tela.
 */
export const ATALHOS: readonly Item[] = Object.freeze(MEU_ESPACO.filter((item) => item.caminho !== "/"));

rotas.get("/celular", async (c) => {
  const usuario = await usuarioLogado(c);
  const grupos = meu_espaco_grupos_de(usuario)
    .map((g) => ({ titulo: g.titulo, itens: g.itens.filter((item) => ATALHOS.includes(item)) }))
    .filter((g) => g.itens.length > 0);
  const resposta = await pagina(c, "paginas/celular.html", usuario, {
    pode_entregar: usuario.pode("epi.entregar"),
    pode_chamada: usuario.pode("turma.avaliar"),
    tem_ficha: usuario.servidor_id !== null,
    atalhos: grupos.flatMap((g) => g.itens),
    grupos_atalhos: grupos,
    // o cartão compacto do alto: avatar e nome (sem a lotação, que não cabe)
    cartao_celular: grupos.length ? cartao_meu_espaco(usuario) : null,
  });
  // A página leva o nome de quem entrou ("Olá, Adelaide"). O service worker já
  // não a guarda (`sw.js`); `no-store` fecha a outra porta, o cache HTTP do
  // próprio navegador, que num celular de balcão também fica no disco depois
  // do "sair".
  resposta.headers.set("cache-control", "no-store");
  return resposta;
});

/**
 * O service worker, na raiz. `Cache-Control: no-cache` garante que uma versão
 * nova do worker seja vista na próxima abertura.
 *
 * **Abre sem sessão, de propósito** (declarado em `validacao_publica.test.ts`):
 * o navegador baixa o worker antes de haver cookie, e o arquivo é código, não
 * dado — a lista do que ele guarda não tem `/api/`.
 */
rotas.get("/sw.js", (c) => {
  const arquivo = path.join(pastaDeEstaticos(), "js", "sw.js");
  if (!existsSync(arquivo)) throw new ErroHttp(404, "Not Found");
  return c.body(readFileSync(arquivo, "utf-8"), 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});
