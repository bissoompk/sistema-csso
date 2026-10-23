/**
 * Fatia B da paridade com o IntegraSST (22/10/2026): o motivo de cada item do
 * pedido e o termo NR-06 declarado no envio — mais o pedido de troca já
 * preenchido (`/epis/requisicoes/nova?item=…&comunicacao=…`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import {
  FINALIDADES_REQUISICAO,
  MOTIVO_ITEM_POR_FINALIDADE,
  TERMO_NR06_VIGENTE,
  texto_termo_nr06,
} from "../src/dominio/epi.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda";
import {
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  pedido_pronto,
  recusa,
  reler,
  usuario,
} from "./ajuda_epi_requisicao";
import { cenario as cenario_web, entregar, recado, registros } from "./ajuda_epi_ficha";

const FILA = "/epis/requisicoes";
const NOVA = "/epis/requisicoes/nova";

// o banco deste arquivo (clone do modelo) — antes de qualquer `desfeito`
await bancoLimpo();

// =====================================================================
// 1. O termo NR-06 no envio (serviço)
// =====================================================================
describe("termo NR-06 no envio", () => {
  it("envio sem o termo é recusado, e nada é consumido", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, u);
      const erro = await recusa(servico.enviar(tx, u, requisicao), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("termo NR-06");
      const erro2 = await recusa(servico.enviar(tx, u, requisicao, { termo_aceito: false }), servico.RequisicaoBloqueada);
      expect(erro2.message).toContain("termo NR-06");
      const relida = (await reler(tx, requisicao))!;
      expect(relida.estado).toBe("RASCUNHO");
      expect(relida.protocolo).toBeNull();
      expect(relida.termo_aceito_em).toBeNull();
    }));

  it("grava a conta de QUEM ENVIA (a chefia, pelo servidor), o instante e a versão, com evento próprio", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      // a chefia pede pela equipe: não é o titular
      const chefia = await usuario(tx, { permissoes: REQUERENTE, login: "chefia" });
      const requisicao = await pedido_pronto(tx, cen, chefia);
      await servico.enviar(tx, chefia, requisicao, { termo_aceito: true });
      const relida = (await reler(tx, requisicao))!;
      expect(relida.estado).toBe("ENVIADA");
      expect(relida.termo_aceito_por).toBe(chefia.id);
      expect(relida.termo_versao).toBe(TERMO_NR06_VIGENTE);
      expect(relida.termo_aceito_em).toBeTruthy();
      expect(relida.termo_exigido).toBe(true);
      const termo = (await eventos(tx, servico.ENTIDADE, requisicao.id)).find(
        (ev) => ev.tipo_evento === servico.EPI_REQUISICAO_TERMO_ACEITO,
      );
      expect(termo).toBeTruthy();
      expect(termo!.valor_novo).toBe(TERMO_NR06_VIGENTE);
      expect(termo!.usuario_id).toBe(chefia.id);
      // RN-19 na escrita: o titular sai pelo id
      expect(termo!.descricao).toContain(`#${cen.servidor.id}`);
      expect(termo!.descricao).not.toContain(cen.servidor.nome);
    }));

  it("o banco recusa pedido novo fora do rascunho sem o termo (ck_req_termo)", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await pedido_pronto(tx, cen, u);
      let mensagem = "(o banco aceitou)";
      try {
        await tx.transaction(async (sp) => {
          await sp
            .update(e.epi_requisicao)
            .set({ estado: "ENVIADA", ano: 2099, numero: 1, protocolo: "EPI-2099-0001", enviada_em: new Date() as never })
            .where(eq(e.epi_requisicao.id, requisicao.id));
        });
      } catch (erro) {
        const x = erro as Error & { cause?: Error };
        mensagem = `${x.message} ${x.cause?.message ?? ""}`;
      }
      expect(mensagem).toContain("ck_req_termo");
    }));

  it("o texto vigente existe e é o que a tela mostra", () => {
    expect(texto_termo_nr06()).toContain("NR-06");
    expect(() => texto_termo_nr06("NAO-EXISTE")).toThrow();
  });
});

// =====================================================================
// 2. O motivo de cada item (serviço)
// =====================================================================
describe("motivo por item", () => {
  it("item sem motivo é recusado na inclusão; motivo fora da lista também", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await servico.criar_rascunho(tx, u, { servidor: cen.servidor });
      const sem = await recusa(
        servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "M" }),
        servico.RequisicaoBloqueada,
      );
      expect(sem.message).toContain("motivo do item");
      const fora = await recusa(
        servico.adicionar_item(tx, u, requisicao, { item: cen.item, quantidade: 1, tamanho: "M", motivo: "QUALQUER" }),
        servico.RequisicaoBloqueada,
      );
      expect(fora.message).toContain("motivo de item desconhecido");
      expect(await itens(tx, requisicao)).toHaveLength(0);

      const linha = await servico.adicionar_item(tx, u, requisicao, {
        item: cen.item,
        quantidade: 1,
        tamanho: "M",
        motivo: "DANO",
      });
      expect(linha.motivo).toBe("DANO");
      // editar sem dizer o motivo mantém o da linha; dizendo, troca
      await servico.editar_item(tx, u, linha, { quantidade: 2, tamanho: "M" });
      expect(linha.motivo).toBe("DANO");
      await servico.editar_item(tx, u, linha, { quantidade: 2, tamanho: "M", motivo: "PERDA" });
      expect((await itens(tx, requisicao))[0]!.motivo).toBe("PERDA");
      await recusa(
        servico.editar_item(tx, u, linha, { quantidade: 2, tamanho: "M", motivo: "" }),
        servico.RequisicaoBloqueada,
      );
    }));

  it("linha gravada por fora sem motivo não passa no envio", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      const requisicao = await servico.criar_rascunho(tx, u, { servidor: cen.servidor });
      await tx
        .insert(e.epi_requisicao_item)
        .values({ requisicao_id: requisicao.id, epi_item_id: cen.item.id, tamanho: "M", quantidade_solicitada: 1 });
      const erro = await recusa(servico.enviar(tx, u, requisicao, { termo_aceito: true }), servico.RequisicaoBloqueada);
      expect(erro.message).toContain("sem o motivo do item");
    }));

  it("a migração 0015 preenche os itens antigos pela finalidade, como MOTIVO_ITEM_POR_FINALIDADE", () =>
    desfeito(async (tx) => {
      const cen = await cenario(tx);
      const u = await usuario(tx, { permissoes: REQUERENTE, login: "joana" });
      // o MESMO UPDATE da migração, lido do arquivo
      const migracao = readFileSync(new URL("../src/db/migracoes/0015_epi_paridade.sql", import.meta.url), "utf8");
      const update = migracao
        .split("--> statement-breakpoint")
        .map((t) => t.replace(/^\s*--.*$/gm, "").trim())
        .find((t) => t.startsWith('UPDATE "epi_requisicao_item"'));
      expect(update, "o UPDATE dos itens antigos na 0015").toBeTruthy();

      const linhas: Record<string, number> = {};
      for (const finalidade of FINALIDADES_REQUISICAO) {
        const requisicao = await servico.criar_rascunho(tx, u, { servidor: cen.servidor, finalidade });
        const [linha] = await tx
          .insert(e.epi_requisicao_item)
          .values({ requisicao_id: requisicao.id, epi_item_id: cen.item.id, tamanho: "M", quantidade_solicitada: 1 })
          .returning();
        expect(linha!.motivo).toBeNull();
        linhas[finalidade] = linha!.id;
      }
      await tx.execute(sql.raw(update!));
      for (const finalidade of FINALIDADES_REQUISICAO) {
        const [linha] = await tx.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.id, linhas[finalidade]!));
        expect(linha!.motivo, finalidade).toBe(MOTIVO_ITEM_POR_FINALIDADE[finalidade]);
      }
    }));
});

// =====================================================================
// 3. As telas: prefill, vínculo com a comunicação, termo e motivo à vista
// =====================================================================
async function novo(): Promise<AmbienteDeTeste> {
  const amb = await bancoLimpo();
  await contas(amb.db);
  return amb;
}
const como = (amb: AmbienteDeTeste, login: string): Promise<Cliente> => entrar(amb.novoCliente(), login);

/** O `<option>` marcado de um `<select>` pelo id. */
function escolhido(html: string, id: string): string | null {
  const inicio = html.indexOf(`id="${id}"`);
  if (inicio < 0) return null;
  const fim = html.indexOf("</select>", inicio);
  const m = /<option value="([^"]*)"\s*selected/.exec(html.slice(inicio, fim));
  return m ? m[1]! : null;
}

async function comunicacao(amb: AmbienteDeTeste, registro_id: number, servidor_id: number, tipo = "DESGASTE") {
  const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  const [linha] = await amb.db
    .insert(e.epi_comunicacao_titular)
    .values({ registro_id, servidor_id, tipo, criado_por: conta!.id })
    .returning();
  return linha!;
}

describe("telas do pedido", () => {
  it("o pedido de troca chega preenchido; valor fora da lista é ignorado", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const cliente = await como(amb, "coordenador_csso");
    const cheio = (await cliente.get(`${NOVA}?item=${cen.item}&tamanho=G&motivo=DANO&finalidade=DANO`)).text;
    expect(escolhido(cheio, "item_id")).toBe(String(cen.item));
    expect(escolhido(cheio, "tamanho")).toBe("G");
    expect(escolhido(cheio, "motivo")).toBe("DANO");
    expect(escolhido(cheio, "finalidade")).toBe("DANO");

    const torto = (await cliente.get(`${NOVA}?item=${cen.item}&tamanho=XXL&motivo=QUALQUER&finalidade=FESTA`)).text;
    expect(escolhido(torto, "item_id")).toBe(String(cen.item));
    expect(escolhido(torto, "tamanho")).toBeNull();
    // finalidade inválida volta ao padrão (rotina), e o motivo é a sugestão dela
    expect(escolhido(torto, "finalidade")).toBe("ROTINA");
    expect(escolhido(torto, "motivo")).toBe(MOTIVO_ITEM_POR_FINALIDADE.ROTINA);
    expect(torto).not.toContain("QUALQUER");

    const sem_item = (await cliente.get(`${NOVA}?item=999999`)).text;
    expect(escolhido(sem_item, "item_id")).toBeNull();
  });

  it("o termo vem DESMARCADO; sem ele a tela recusa e nada é protocolado", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const cliente = await como(amb, "coordenador_csso");
    const tela = (await cliente.get(NOVA)).text;
    expect(tela).toContain(texto_termo_nr06());
    expect(tela).toMatch(/<input id="termo-aceito" type="checkbox" name="termo_aceito" value="1">/);
    const dados = {
      servidor_id: String(cen.servidor),
      chefia_servidor_id: "",
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes",
      riscos_declarados: "Respingo de ácido",
      urgencia: "NORMAL",
      justificativa_urgencia: "",
      item_id: String(cen.item),
      quantidade: "1",
      tamanho: "M",
      justificativa: "",
      motivo: "USO_INICIAL",
      acao: "enviar",
    };
    const sem = await cliente.post(FILA, dados, { seguir: false });
    expect(sem.status).toBe(200);
    expect(sem.text).toContain("termo NR-06");
    expect(await amb.db.select().from(e.epi_requisicao)).toHaveLength(0);

    const com = await cliente.post(FILA, { ...dados, termo_aceito: "1" }, { seguir: false });
    expect(com.status, recado(com)).toBe(303);
    const [req] = await amb.db.select().from(e.epi_requisicao);
    expect(req!.estado).toBe("ENVIADA");
    expect(req!.termo_versao).toBe(TERMO_NR06_VIGENTE);

    // a ficha diz quem declarou, quando e a versão; o motivo do item aparece
    const ficha = (await cliente.get(`${FILA}/${req!.id}`)).text;
    expect(ficha).toContain("Termo NR-06");
    expect(ficha).toContain(`versão ${TERMO_NR06_VIGENTE}`);
    expect(ficha).toContain("Motivo: Nova função / uso inicial");
    // e a guia também
    const [linha] = await amb.db.select().from(e.epi_requisicao_item);
    await amb.db.update(e.epi_requisicao_item).set({ estado: "APROVADO", quantidade_aprovada: 1 }).where(eq(e.epi_requisicao_item.id, linha!.id));
    const guia = (await cliente.get(`${FILA}/${req!.id}/guia`)).text;
    expect(guia).toContain("Motivo: Nova função / uso inicial");
  });

  it("o envio pela ficha do rascunho exige a marca do termo", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const cliente = await como(amb, "coordenador_csso");
    await cliente.post(
      FILA,
      {
        servidor_id: String(cen.servidor),
        finalidade: "PERDA",
        urgencia: "NORMAL",
        item_id: String(cen.item),
        quantidade: "1",
        tamanho: "M",
        motivo: "PERDA",
        acao: "rascunho",
      },
      { seguir: false },
    );
    const [req] = await amb.db.select().from(e.epi_requisicao);
    const ficha = (await cliente.get(`${FILA}/${req!.id}`)).text;
    expect(ficha).toMatch(/<input id="termo-aceito" type="checkbox" name="termo_aceito" value="1">/);
    // o item novo do rascunho já vem com o motivo sugerido pela finalidade
    const opcoes = (await cliente.get(`${FILA}/item-opcoes?item_id=${cen.item}&finalidade=PERDA`)).text;
    expect(escolhido(opcoes, "motivo")).toBe("PERDA");

    const sem = await cliente.post(`${FILA}/${req!.id}/enviar`, {}, { seguir: false });
    expect(recado(sem)).toContain("termo NR-06");
    expect((await amb.db.select().from(e.epi_requisicao))[0]!.estado).toBe("RASCUNHO");
    const com = await cliente.post(`${FILA}/${req!.id}/enviar`, { termo_aceito: "1" }, { seguir: false });
    expect(recado(com)).toContain("EPI-");
    expect((await amb.db.select().from(e.epi_requisicao))[0]!.estado).toBe("ENVIADA");
  });

  it("pedido anterior ao termo diz isso na ficha", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const [req] = await amb.db
      .insert(e.epi_requisicao)
      .values({
        servidor_id: cen.servidor,
        solicitado_por_id: conta!.id,
        estado: "ENVIADA",
        ano: 2025,
        numero: 77,
        protocolo: "EPI-2025-0077",
        termo_exigido: false,
      })
      .returning();
    const ficha = (await (await como(amb, "coordenador_csso")).get(`${FILA}/${req!.id}`)).text;
    expect(ficha).toContain("pedido anterior ao termo");
  });

  it("o link com a comunicação preenche o pedido e o liga a ela", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const cliente = await como(amb, "coordenador_csso");
    expect((await entregar(cliente, cen, { quantidade: 1, tamanho: "M" })).status).toBe(303);
    const [registro] = await registros(amb.db);
    const com = await comunicacao(amb, registro!.id, cen.servidor, "EXTRAVIADO");

    const tela = (await cliente.get(`${NOVA}?comunicacao=${com.id}`)).text;
    expect(tela).toContain("Pedido de troca da comunicação");
    expect(escolhido(tela, "servidor_id")).toBe(String(cen.servidor));
    expect(escolhido(tela, "item_id")).toBe(String(cen.item));
    expect(escolhido(tela, "tamanho")).toBe("M");
    expect(escolhido(tela, "motivo")).toBe("PERDA");
    expect(escolhido(tela, "finalidade")).toBe("PERDA");
    expect(tela).toContain(`name="comunicacao_id" value="${com.id}"`);

    const r = await cliente.post(
      FILA,
      {
        servidor_id: String(cen.servidor),
        finalidade: "PERDA",
        urgencia: "NORMAL",
        item_id: String(cen.item),
        quantidade: "1",
        tamanho: "M",
        motivo: "PERDA",
        comunicacao_id: String(com.id),
        termo_aceito: "1",
        acao: "enviar",
      },
      { seguir: false },
    );
    expect(r.status, recado(r)).toBe(303);
    expect(recado(r)).not.toContain("não pôde ser ligada");
    const [req] = await amb.db.select().from(e.epi_requisicao);
    const [ligada] = await amb.db.select().from(e.epi_comunicacao_titular).where(eq(e.epi_comunicacao_titular.id, com.id));
    expect(ligada!.requisicao_id).toBe(req!.id);
  });

  it("comunicação que não vale: a tela avisa e o pedido segue sem o vínculo", async () => {
    const amb = await novo();
    const cen = await cenario_web(amb.db);
    const cliente = await como(amb, "coordenador_csso");
    await entregar(cliente, cen, { quantidade: 1, tamanho: "M" });
    const [registro] = await registros(amb.db);
    const com = await comunicacao(amb, registro!.id, cen.servidor);
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await amb.db
      .update(e.epi_comunicacao_titular)
      .set({ tratada_em: new Date() as never, tratada_por: conta!.id, tratamento: "trocado no balcão" })
      .where(eq(e.epi_comunicacao_titular.id, com.id));

    const tela = (await cliente.get(`${NOVA}?comunicacao=${com.id}`)).text;
    expect(tela).toContain("não pode originar este pedido");

    const r = await cliente.post(
      FILA,
      {
        servidor_id: String(cen.servidor),
        finalidade: "SUBSTITUICAO",
        urgencia: "NORMAL",
        item_id: String(cen.item),
        quantidade: "1",
        tamanho: "M",
        motivo: "DESGASTE",
        comunicacao_id: String(com.id),
        acao: "rascunho",
      },
      { seguir: false },
    );
    expect(r.status, recado(r)).toBe(303);
    expect(recado(r)).toContain("não pôde ser ligada");
    const pedidos = await amb.db.select().from(e.epi_requisicao).orderBy(asc(e.epi_requisicao.id));
    expect(pedidos).toHaveLength(1);
    const [relida] = await amb.db.select().from(e.epi_comunicacao_titular).where(eq(e.epi_comunicacao_titular.id, com.id));
    expect(relida!.requisicao_id).toBeNull();
  });
});
