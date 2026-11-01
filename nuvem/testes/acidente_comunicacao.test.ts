/**
 * F1 do módulo de acidentes: comunicar. O titular comunica; vários envolvidos;
 * o externo entra sem CPF; CPF digitado é recusado; o protocolo é sequencial;
 * a CAT/SP v1 fica congelada (append-only, com hash); as pendências de triagem
 * e do prazo de 10 dias nascem juntas. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import { bancoLimpo, contas } from "./ajuda.js";
import { dados, envolvido, servidorFicticio, titular } from "./acidente_ajuda.js";

let db: Banco;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  await contas(db);
});

describe("comunicar", () => {
  it("o titular comunica: protocolo CAT-AAAA-NNNN, origem TITULAR, escopo pelo próprio servidor", async () => {
    const { servidor, usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const ano = new Date().getFullYear();
    expect(oc.protocolo).toBe(`CAT-${ano}-0001`);
    expect(oc.estado).toBe("RECEBIDA");
    expect(oc.origem).toBe("TITULAR");
    expect(oc.servidor_id).toBe(servidor.id);
    expect(oc.criado_por).toBe(usuario.id);
    expect(oc.cat_sp_versao).toBe(1);
    expect(oc.prazo_comunicacao).toBe(somar_dias(oc.data_evento, 10));
    // fora do trânsito, o bloco de trânsito não é gravado
    expect(oc.transito_registro_policial).toBeNull();
  });

  it("o protocolo é sequencial e não se repete", async () => {
    const { usuario } = await titular(db);
    const a = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const b = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    expect(b.numero).toBe(a.numero + 1);
  });

  it("o mesmo envio do formulário (mesmo número de envio) não cria outra ocorrência nem outra CAT", async () => {
    const { usuario } = await titular(db);
    const envio = { ...dados(), token_envio: "envio-de-teste-0001-abcdef" };
    const a = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, envio));
    await expect(db.transaction((tx) => comunicacao.comunicar(tx, usuario, envio))).rejects.toThrow(
      new RegExp(`já foi recebida \\(protocolo ${a.protocolo}\\)`),
    );
    expect((await db.select().from(e.acidente_ocorrencia)).length).toBe(1);
    // outro envio (outro número) segue a sequência normal
    const b = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, { ...dados(), token_envio: "envio-de-teste-0002-abcdef" }));
    expect(b.numero).toBe(a.numero + 1);
  });

  it("vários envolvidos, todos servidores pelo SIAPE; a chefia marca a origem", async () => {
    const { usuario } = await titular(db);
    const colega = await servidorFicticio(db, "7000002");
    const outro = await servidorFicticio(db, "7000003");
    const oc = await db.transaction((tx) =>
      comunicacao.comunicar(
        tx,
        usuario,
        dados({
          sou_chefia: true,
          envolvidos: [
            envolvido({ siape: colega.siape }),
            envolvido({ siape: outro.siape, condicao: "ENVOLVIDO_SEM_LESAO", houve_lesao: "NAO" }),
          ],
        }),
      ),
    );
    expect(oc.origem).toBe("CHEFIA");
    expect(oc.servidor_id).toBe(colega.id);
    const acidentados = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id)).orderBy(e.acidentado.ordem);
    expect(acidentados).toHaveLength(2);
    expect(acidentados[0]!.siape).toBe(colega.siape);
    expect(acidentados[1]!.siape).toBe(outro.siape);
    expect(acidentados[1]!.servidor_id).toBe(outro.id);
  });

  it.each([
    ["no relato", (d: comunicacao.DadosComunicacao) => { d.relato.descricao = "O servidor de CPF 12345678909 caiu"; }],
    ["no nome da testemunha", (d: comunicacao.DadosComunicacao) => { d.testemunhas = [{ nome: "Beltrano 123.456.789-09", vinculo: null, contato: null }]; }],
  ])("CPF digitado %s é recusado, com a saída escrita", async (_onde, mexer) => {
    const { usuario } = await titular(db);
    const d = dados();
    mexer(d);
    await expect(db.transaction((tx) => comunicacao.comunicar(tx, usuario, d))).rejects.toThrow(/CPF não é registrado/);
  });

  it("recusa: sem declaração, data futura, SIAPE fora do cadastro, termo de saúde no relato", async () => {
    const { usuario } = await titular(db);
    const casos: [Partial<comunicacao.DadosComunicacao> | ((d: comunicacao.DadosComunicacao) => void), RegExp][] = [
      [{ declarou_veracidade: false }, /declaração/],
      [(d) => { d.fatos.data_evento = somar_dias(hoje_iso(), 1); }, /depois de hoje/],
      [{ envolvidos: [envolvido({ siape: "9999999" })] }, /não está no cadastro/],
      [(d) => { d.relato.descricao = "Teve uma fratura e foi para o hospital com diagnóstico de luxação"; }, /termo de saúde/],
      [{ envolvidos: [] }, /pelo menos um envolvido/],
    ];
    for (const [caso, erro] of casos) {
      const d = dados(typeof caso === "function" ? {} : caso);
      if (typeof caso === "function") caso(d);
      await expect(db.transaction((tx) => comunicacao.comunicar(tx, usuario, d))).rejects.toThrow(erro);
    }
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(0);
  });

  it("a CAT/SP v1 fica congelada: hash do contexto, saúde declarada em chave separada, append-only", async () => {
    const { usuario } = await titular(db);
    const [parte] = await db.select().from(e.acidente_parte_corpo).limit(1);
    const d = dados();
    d.envolvidos[0]!.saude.partes_corpo_ids = [parte!.id];
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, d));
    const [cat] = await db.select().from(e.acidente_cat_sp).where(eq(e.acidente_cat_sp.ocorrencia_id, oc.id));
    expect(cat!.versao).toBe(1);
    expect(cat!.origem).toBe("COMUNICACAO");
    expect(cat!.hash_conteudo).toBe(comunicacao.hash_do_contexto(cat!.contexto_congelado));
    const ctx = cat!.contexto_congelado as comunicacao.ContextoCatSp;
    expect(ctx.saude_declarada[0]!.partes_corpo_ids).toEqual([parte!.id]);
    expect(ctx.saude_declarada[0]!.origem).toBe("DECLARADO_COMUNICANTE");
    expect(JSON.stringify(ctx.envolvidos)).not.toContain("houve_atendimento");
    await expect(db.execute(sql`UPDATE acidente_cat_sp SET origem = 'MIGRACAO' WHERE id = ${cat!.id}`)).rejects.toThrow();
  });

  it("abre a triagem (2 dias, sem responsável) e o prazo legal (data do acidente + 10)", async () => {
    const { usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const ps = await db
      .select()
      .from(e.pendencia)
      .where(and(eq(e.pendencia.entidade, "acidente_ocorrencia"), eq(e.pendencia.entidade_id, oc.id)));
    const por_tipo = Object.fromEntries(ps.map((p) => [p.tipo, p]));
    expect(por_tipo.ACIDENTE_TRIAR!.responsavel_id).toBeNull();
    expect(por_tipo.ACIDENTE_TRIAR!.prazo).toBe(somar_dias(hoje_iso(), 2));
    expect(por_tipo.ACIDENTE_PRAZO_COMUNICACAO!.prazo).toBe(oc.prazo_comunicacao);
    expect(por_tipo.ACIDENTE_TRIAR!.descricao).not.toContain("Titular");
  });

  it.each(["TERCEIRIZADO", "ESTUDANTE", "VISITANTE"])(
    "envolvido %s é recusado: CAT/SP é só de servidor e o caminho é Ocorrências",
    async (vinculo) => {
      const { usuario } = await titular(db);
      await expect(
        db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados({ envolvidos: [envolvido({ vinculo, nome_externo: "Pessoa Fictícia" })] }))),
      ).rejects.toThrow(/só para servidor.*Ocorrências/s);
    },
  );

  it("a trilha registra o ato sem nome de ninguém", async () => {
    const { usuario } = await titular(db);
    const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    const [ev] = await db
      .select()
      .from(e.historico_evento)
      .where(and(eq(e.historico_evento.entidade, "acidente_ocorrencia"), eq(e.historico_evento.tipo_evento, "ACIDENTE_COMUNICADO")));
    expect(ev!.entidade_id).toBe(oc.id);
    expect(ev!.descricao).toContain(oc.protocolo);
    expect(ev!.descricao).not.toContain("Titular Fictício");
    expect(ev!.descricao).not.toContain("respingou");
  });
});
