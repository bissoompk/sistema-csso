/**
 * Fatia F da paridade com o IntegraSST (22/10/2026, Decisão 1): o e-mail do
 * pedido de EPI — desligado por padrão, texto puro, sem o texto da recusa e
 * sem falha silenciosa.
 */
import { afterEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import { redefinirConfig } from "../src/config.js";
import * as epi_email from "../src/servicos/epi_email.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { bancoLimpo } from "./ajuda";
import {
  REQUERENTE,
  cenario,
  desfeito,
  eventos,
  itens,
  motivo,
  pedido_pronto,
  reler,
  usuario,
} from "./ajuda_epi_requisicao";

await bancoLimpo();

const SETOR = "sesmt.epi@ufvjm.edu.br";
const DO_SERVIDOR = "joana.almeida@ufvjm.edu.br";

function ligar(setor: string = SETOR): void {
  process.env.CSSO_EPI_EMAIL = "sim";
  process.env.CSSO_EPI_EMAIL_SETOR = setor;
  redefinirConfig();
}

afterEach(() => {
  delete process.env.CSSO_EPI_EMAIL;
  delete process.env.CSSO_EPI_EMAIL_SETOR;
  redefinirConfig();
});

const caixa = (tx: Executor) => tx.select().from(e.email_saida).orderBy(asc(e.email_saida.id));

async function montar(tx: Executor, o: { email_servidor?: string | null } = {}) {
  const cen = await cenario(tx);
  await tx
    .update(e.servidor)
    .set({ email: o.email_servidor === undefined ? DO_SERVIDOR : o.email_servidor })
    .where(eq(e.servidor.id, cen.servidor.id));
  const requerente = await usuario(tx, { permissoes: REQUERENTE, login: "joana", servidor_id: cen.servidor.id });
  const analista = await usuario(tx, { login: "analista" });
  const requisicao = await pedido_pronto(tx, cen, requerente);
  return { cen, requerente, analista, requisicao };
}

/** Nada de marcação: o corpo é texto puro, e nenhum dado da pessoa vai nele. */
function conferir_corpo(corpo: string | null, cen: Awaited<ReturnType<typeof montar>>["cen"]): void {
  expect(corpo).toBeTruthy();
  expect(corpo!).not.toMatch(/<\s*[a-z!/]/i);
  expect(corpo!).not.toContain(cen.servidor.nome);
  expect(corpo!).not.toContain(cen.servidor.siape);
}

describe("e-mail do pedido de EPI", () => {
  it("desligado por padrão: o envio não enfileira nada nem grava evento de e-mail", () =>
    desfeito(async (tx) => {
      delete process.env.CSSO_EPI_EMAIL;
      redefinirConfig();
      expect(epi_email.ligado()).toBe(false);
      const { requerente, requisicao } = await montar(tx);
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      expect(await caixa(tx)).toHaveLength(0);
      const evs = await eventos(tx, servico.ENTIDADE, requisicao.id);
      expect(evs.some((ev) => ev.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO)).toBe(false);
    }));

  it("ligado: a abertura avisa o setor e o requerente, em texto puro e com o link", () =>
    desfeito(async (tx) => {
      ligar();
      const { cen, requerente, requisicao } = await montar(tx);
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      const linhas = await caixa(tx);
      expect(linhas.map((l) => [l.tipo, l.destinatario, l.situacao])).toEqual([
        [epi_email.TIPO_ABERTURA_SETOR, SETOR, "PENDENTE"],
        [epi_email.TIPO_ABERTURA_REQUERENTE, DO_SERVIDOR, "PENDENTE"],
      ]);
      const protocolo = (await reler(tx, requisicao))!.protocolo!;
      for (const l of linhas) {
        expect(l.assunto).toContain(protocolo);
        expect(l.corpo).toContain(`/epis/requisicoes/${requisicao.id}`);
        conferir_corpo(l.corpo, cen);
        // nada do conteúdo do pedido: rotina e riscos ficam no sistema
        expect(l.corpo!).not.toContain("reagentes");
      }
      const ev = (await eventos(tx, servico.ENTIDADE, requisicao.id)).find(
        (x) => x.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO,
      );
      expect(ev!.descricao).toContain("setor: enfileirado");
      expect(ev!.descricao).toContain("requerente: enfileirado");
      expect(ev!.valor_novo).toBe("2/2");
      // a trilha não guarda o endereço
      expect(ev!.descricao).not.toContain(DO_SERVIDOR);
    }));

  it("ligado: a decisão avisa só o requerente", () =>
    desfeito(async (tx) => {
      ligar();
      const { cen, requerente, analista, requisicao } = await montar(tx);
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      const antes = (await caixa(tx)).length;
      await servico.iniciar_analise(tx, analista, requisicao);
      // pegar para análise não é decisão
      expect((await caixa(tx)).length).toBe(antes);
      await servico.aprovar_item(tx, analista, (await itens(tx, requisicao))[0]!);
      await servico.concluir_analise(tx, analista, requisicao);
      const novas = (await caixa(tx)).slice(antes);
      expect(novas.map((l) => [l.tipo, l.destinatario])).toEqual([[epi_email.TIPO_DECISAO, DO_SERVIDOR]]);
      expect(novas[0]!.corpo).toContain("Entre no Sistema SISA para ler");
      conferir_corpo(novas[0]!.corpo, cen);

      // reservado o lote, o aviso de retirada também vai por e-mail
      const almoxarife = await usuario(tx, { login: "almox", permissoes: ["epi.ver", "epi.estoque"] });
      await servico.reservar_item(tx, almoxarife, (await itens(tx, requisicao))[0]!, { entrada: cen.entrada });
      const retirada = (await caixa(tx)).slice(antes + 1);
      expect(retirada.map((l) => l.tipo)).toEqual([epi_email.TIPO_RETIRADA]);
      conferir_corpo(retirada[0]!.corpo, cen);
    }));

  it("retirada: um e-mail por pedido e por ato de reserva, listando os itens já separados", () =>
    desfeito(async (tx) => {
      ligar();
      const { cen, requerente, analista, requisicao } = await montar(tx);
      // segunda linha do mesmo pedido, tamanho G, com lote próprio
      await servico.adicionar_item(tx, requerente, requisicao, {
        motivo: "USO_INICIAL",
        item: cen.item,
        quantidade: 1,
        tamanho: "G",
      });
      const { id: _id, registrado_em: _r, ...base } = cen.entrada;
      const [lote_g] = await tx
        .insert(e.epi_entrada_estoque)
        .values({ ...base, tamanho: "G", lote: "LOTE-G" })
        .returning();
      await tx.insert(e.epi_movimento_estoque).values({ entrada_id: lote_g!.id, tipo: "ENTRADA", quantidade: 10 });
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      await servico.iniciar_analise(tx, analista, requisicao);
      await servico.aprovar_tudo(tx, analista, (await reler(tx, requisicao))!);
      const almoxarife = await usuario(tx, { login: "almox", permissoes: ["epi.ver", "epi.estoque"] });
      const [m, g] = await itens(tx, requisicao);
      const lote_de = (l: { tamanho: string | null }) => (l.tamanho === "G" ? lote_g! : cen.entrada);
      const retiradas = async () => (await caixa(tx)).filter((l) => l.tipo === epi_email.TIPO_RETIRADA);

      // o MESMO ato reserva as duas linhas: um e-mail só, com os dois itens
      await tx.transaction(async (ato) => {
        await servico.reservar_item(ato, almoxarife, m!, { entrada: lote_de(m!) });
        await servico.reservar_item(ato, almoxarife, g!, { entrada: lote_de(g!) });
      });
      let r = await retiradas();
      expect(r).toHaveLength(1);
      expect(r[0]!.corpo).toContain("Há 2 itens");
      expect(r[0]!.corpo).toContain("tamanho M");
      expect(r[0]!.corpo).toContain("tamanho G");
      conferir_corpo(r[0]!.corpo, cen);
      const evs = (await eventos(tx, servico.ENTIDADE, requisicao.id)).filter(
        (x) => x.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO && x.descricao.includes("retirada"),
      );
      expect(evs).toHaveLength(1);

      // outro ato (a reserva solta e refeita): e-mail novo, de novo um só
      await tx.transaction(async (ato) => {
        await servico.soltar_reserva(ato, almoxarife, (await itens(ato, requisicao))[1]!, "lote conferido de novo");
      });
      await tx.transaction(async (ato) => {
        const linha = (await itens(ato, requisicao))[1]!;
        await servico.reservar_item(ato, almoxarife, linha, { entrada: lote_g! });
      });
      r = await retiradas();
      expect(r).toHaveLength(2);
      expect(r[1]!.corpo).toContain("Há 2 itens");
    }));

  it("o indeferimento NÃO leva o texto da recusa, nem o complemento", () =>
    desfeito(async (tx) => {
      ligar();
      const { cen, requerente, analista, requisicao } = await montar(tx);
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      await servico.iniciar_analise(tx, analista, requisicao);
      const m = await motivo(tx);
      const complemento = "Posto sem exposição conforme visita técnica de setembro";
      await servico.indeferir(tx, analista, requisicao, { motivo: m, complemento });
      const decisao = (await caixa(tx)).filter((l) => l.tipo === epi_email.TIPO_DECISAO);
      expect(decisao).toHaveLength(1);
      const tudo = `${decisao[0]!.assunto}\n${decisao[0]!.corpo}`;
      expect(tudo).not.toContain(m.rotulo);
      if (m.texto) expect(tudo).not.toContain(m.texto.slice(0, 40));
      expect(tudo).not.toContain(complemento);
      expect(tudo).not.toContain("indeferid");
      conferir_corpo(decisao[0]!.corpo, cen);
    }));

  it("endereço inválido ou ausente não derruba o envio, e fica registrado na trilha", () =>
    desfeito(async (tx) => {
      ligar("nao-e-um-email");
      const { requerente, requisicao } = await montar(tx, { email_servidor: "joana-sem-arroba" });
      // a conta ligada ao servidor também sem endereço válido
      await tx.update(e.usuario).set({ email: "conta-invalida" }).where(eq(e.usuario.id, requerente.id));
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      expect((await reler(tx, requisicao))!.estado).toBe("ENVIADA");
      expect(await caixa(tx)).toHaveLength(0);
      const ev = (await eventos(tx, servico.ENTIDADE, requisicao.id)).find(
        (x) => x.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO,
      );
      expect(ev!.descricao).toContain("setor: NÃO enfileirado");
      expect(ev!.descricao).toContain("CSSO_EPI_EMAIL_SETOR");
      expect(ev!.descricao).toContain("requerente: NÃO enfileirado");
      expect(ev!.valor_novo).toBe("0/2");
    }));

  it("setor sem endereço configurado: só o requerente recebe, e a falta fica escrita", () =>
    desfeito(async (tx) => {
      ligar("");
      const { requerente, requisicao } = await montar(tx);
      await servico.enviar(tx, requerente, requisicao, { termo_aceito: true });
      expect((await caixa(tx)).map((l) => l.tipo)).toEqual([epi_email.TIPO_ABERTURA_REQUERENTE]);
      const ev = (await eventos(tx, servico.ENTIDADE, requisicao.id)).find(
        (x) => x.tipo_evento === epi_email.EPI_EMAIL_ENFILEIRADO,
      );
      expect(ev!.descricao).toContain("não está configurado");
      expect(ev!.valor_novo).toBe("1/2");
    }));
});
