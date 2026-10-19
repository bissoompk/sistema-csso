/**
 * EPI com menos passos: aprovar tudo como pedido, cadastrar servidor de dentro
 * da busca do balcão/pedido, e a recusa por CA do catálogo apontando onde
 * corrigir o item.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";
import { cenario as cenario_ficha, entregar, recado } from "./ajuda_epi_ficha";
import {
  ANALISTA,
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  outro_item,
  pedido_pronto,
  recusa,
  usuario,
} from "./ajuda_epi_requisicao";

let amb: AmbienteDeTeste = await bancoLimpo();
async function novo(): Promise<AmbienteDeTeste> {
  amb = await bancoLimpo();
  await contas(amb.db);
  return amb;
}

describe("aprovar tudo como pedido", () => {
  it("de ENVIADA a ANALISADA numa chamada, com os eventos de cada passo", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const requerente = await usuario(tx, { login: "requerente", permissoes: REQUERENTE });
      const analista = await usuario(tx, { login: "analista", permissoes: ANALISTA });
      const requisicao = await pedido_pronto(tx, cen, requerente, { quantidade: 3 });
      await servico.adicionar_item(tx, requerente, requisicao, {
        item: await outro_item(tx, cen, "Óculos de proteção", "55555"),
        quantidade: 1,
      });
      await servico.enviar(tx, requerente, requisicao);

      await servico.aprovar_tudo(tx, analista, requisicao);

      expect(requisicao.estado).toBe("ANALISADA");
      expect(requisicao.analisado_por).toBe(analista.id);
      const linhas = await itens(tx, requisicao);
      expect(linhas.map((l) => [l.estado, l.quantidade_aprovada])).toEqual([
        ["APROVADO", 3],
        ["APROVADO", 1],
      ]);
      const tipos = (await eventos(tx, servico.ENTIDADE, requisicao.id)).map((ev) => ev.tipo_evento);
      expect(tipos).toContain(servico.EPI_REQUISICAO_EM_ANALISE);
      expect(tipos).toContain(servico.EPI_REQUISICAO_ANALISADA);
      for (const l of linhas) {
        const doItem = (await eventos(tx, servico.ENTIDADE_ITEM, l.id)).map((ev) => ev.tipo_evento);
        expect(doItem).toContain(servico.EPI_ITEM_APROVADO);
      }
    }));

  it("RN-28: quem vai usar o EPI não aprova o próprio pedido", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const requerente = await usuario(tx, { login: "requerente", permissoes: REQUERENTE });
      const proprio = await usuario(tx, { login: "proprio", permissoes: ANALISTA, servidor_id: cen.servidor.id });
      const requisicao = await pedido_pronto(tx, cen, requerente);
      await servico.enviar(tx, requerente, requisicao);
      await recusa(servico.aprovar_tudo(tx, proprio, requisicao), PermissaoNegada);
      expect(requisicao.estado).toBe("ENVIADA");
    }));

  it("pela tela: o botão aparece para o analista e o POST conclui", async () => {
    await novo();
    const cen = await amb.db.transaction(async (tx) => {
      const c = await cenario(tx);
      const requerente = await usuario(tx, { login: "requerente", permissoes: REQUERENTE });
      const r = await pedido_pronto(tx, c, requerente);
      await servico.enviar(tx, requerente, r);
      return r;
    });
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const ficha = await cliente.get(`/epis/requisicoes/${cen.id}`);
    expect(ficha.text).toContain("Aprovar tudo como pedido");
    const r = await cliente.post(`/epis/requisicoes/${cen.id}/aprovar-tudo`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("aprovado como pedido");
    const [relida] = await amb.db.select().from(e.epi_requisicao).where(eq(e.epi_requisicao.id, cen.id));
    expect(relida!.estado).toBe("ANALISADA");
  });
});

describe("cadastrar servidor de dentro da busca", () => {
  it("busca sem resultado oferece o cadastro, e o cadastro volta com a pessoa escolhida", async () => {
    await novo();
    const cliente = await entrar(amb.novoCliente(), "almoxarife_sesmt");
    const busca = await cliente.get("/epis/entregas/servidores?q=7777777");
    expect(busca.text).toContain("Cadastrar servidor agora");
    expect(busca.text).toContain('value="7777777"');

    const r = await cliente.post("/epis/entregas/servidores/novo", { novo_siape: "7777777", novo_nome: "Pedro Novo" });
    expect(r.status).toBe(200);
    const [sv] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "7777777"));
    expect(sv!.nome).toBe("Pedro Novo");
    expect(r.text).toMatch(new RegExp(`value="${sv!.id}"\\s*selected`));
    const lotacoes = await amb.db.select().from(e.servidor_lotacao).where(eq(e.servidor_lotacao.servidor_id, sv!.id));
    expect(lotacoes).toHaveLength(1);
    const criado = await amb.db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade_id, sv!.id), eq(e.historico_evento.tipo_evento, "SERVIDOR_CRIADO")));
    expect(criado).toHaveLength(1);

    // o mesmo SIAPE de novo não duplica
    const de_novo = await cliente.post("/epis/entregas/servidores/novo", { novo_siape: "7777777", novo_nome: "Outro" });
    expect(de_novo.text).toContain("já está cadastrado");
    expect(await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "7777777"))).toHaveLength(1);
  });

  it("no pedido, só quem pode cadastrar vê a oferta", async () => {
    await novo();
    const coord = await entrar(amb.novoCliente(), "coordenador_csso");
    expect((await coord.get("/epis/requisicoes/servidores?q=7777777")).text).toContain("Cadastrar servidor agora");
    const comum = await entrar(amb.novoCliente(), "servidor_consulta");
    const r = await comum.get("/epis/requisicoes/servidores?q=7777777");
    expect(r.text).not.toContain("Cadastrar servidor agora");
    const post = await comum.post("/epis/requisicoes/servidores/novo", { novo_siape: "7777777", novo_nome: "X" });
    expect(post.status).toBe(403);
  });
});

describe("item sem CA no catálogo", () => {
  it("a entrega recusada aponta o item no catálogo, e o catálogo abre só nele", async () => {
    await novo();
    // o banco já exige o número quando `exige_ca`; o que sobra é a validade
    const c = await cenario_ficha(amb.db, { validade_ca_catalogo: null });
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await entregar(cliente, c, { entrada_id: "" });
    expect(recado(r)).toContain("não tem validade registrada");
    expect(r.text).toContain(`/epis/catalogo?item_id=${c.item}`);

    const catalogo = await cliente.get(`/epis/catalogo?item_id=${c.item}`);
    expect(catalogo.status).toBe(200);
    expect(catalogo.text).toContain("Mostrando só o item a corrigir");
    expect(catalogo.text).toContain(`action="/epis/catalogo/${c.item}"`);
  });

  it("o formulário do catálogo destaca a caixa de CA com a dica de desmarcar", async () => {
    await novo();
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.get("/epis/catalogo");
    expect(r.text).toContain("Desmarque para itens que não têm CA");
  });
});
