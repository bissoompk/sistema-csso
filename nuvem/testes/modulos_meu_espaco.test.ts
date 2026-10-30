/**
 * O mapa `/modulos` e a lateral falam igual: quem recebe o bloco "Meu espaço" ao
 * lado da lateral da equipe vê os mesmos caminhos num cartão do mapa.
 */
import { describe, expect, it } from "vitest";
import * as esquema from "../src/db/esquema/index.js";
import { bancoLimpo, contas, criarUsuario, entrar, naTransacao } from "./ajuda";

const { novoCliente, db } = await bancoLimpo();
await naTransacao((tx) => contas(tx));
const [servidor] = await db
  .insert(esquema.servidor)
  .values({ siape: "7710001", nome: "SERVIDORA DA EQUIPE" })
  .returning();
await criarUsuario(db, { login: "equipe_titular", nome: "Equipe Titular", perfis: ["coordenador_csso"], servidor_id: servidor!.id });

function _hrefs(html: string, trecho: RegExp): string[] {
  const bloco = trecho.exec(html)?.[0] ?? "";
  return [...bloco.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe("Meu espaço no mapa de módulos", () => {
  for (const conta of ["coordenador_csso", "equipe_titular"]) {
    it(`${conta}: o cartão repete os caminhos da lateral, ou nenhum dos dois existe`, async () => {
      const cliente = await entrar(novoCliente(), conta);
      const html = (await cliente.get("/modulos", { seguir: false })).text;
      const lateral = _hrefs(html, /<nav class="menu menu-meu[^"]*"[\s\S]*?<\/nav>/);
      const cartao = _hrefs(html, /<section class="cartao liso" id="meu-espaco">[\s\S]*?<\/section>/);
      if (conta === "equipe_titular") expect(lateral.length).toBeGreaterThan(0);
      expect(cartao).toEqual(lateral);
    });
  }
});
