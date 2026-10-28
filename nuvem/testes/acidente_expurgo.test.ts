/**
 * O expurgo parcial de Acidentes (POLITICA §2.4, `ferramentas/expurgar-acidentes.ts`):
 * só entra ocorrência concluída há mais de N anos E com decisão pericial; leva a
 * NULL a identificação, o contato da testemunha e o nível 2 da saúde, com
 * carimbo, e deixa o núcleo; é idempotente; as triggers impedem o dado de
 * voltar; a trilha recebe um evento por ocorrência SEM valor; a simulação não
 * grava. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as anexo from "../src/servicos/acidente_anexo_iii.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import * as expurgo from "../src/servicos/acidente_expurgo.js";
import * as identificacao from "../src/servicos/acidente_identificacao.js";
import { identidadeDoBanco } from "../src/servicos/instalacao.js";
import * as ferramenta from "../ferramentas/expurgar-acidentes.js";
import { bancoLimpo, contas, usuarioAtual } from "./ajuda.js";
import { dados, envolvido, titular } from "./acidente_ajuda.js";

let db: Banco;
let url: string;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  url = amb.url;
  await contas(db);
});

const ANOS_ATRAS = (n: number) => new Date(Date.now() - n * 365.25 * 86_400_000);

let _siape = 7000000;

/** Uma ocorrência com identificação, testemunha com contato e saúde com detalhe. */
async function ocorrencia() {
  const { usuario } = await titular(db, String(++_siape));
  const oc = await db.transaction((tx) =>
    comunicacao.comunicar(
      tx,
      usuario,
      dados({
        envolvidos: [
          envolvido({
            sou_eu: true,
            identificacao: {
              sexo: "FEMININO", cpf: "529.982.247-25", rg: "MG-1", data_nascimento: "1985-04-20", cep: "39100-000",
              logradouro: "Rua dos Testes Inventados", numero: "1", complemento: null, bairro: "Centro", cidade: "Diamantina",
              uf: "MG", telefone: "38999991234", email: "fulana@exemplo.invalid",
            },
          }),
        ],
      }),
    ),
  );
  const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
  const [testemunha] = await db.insert(e.acidente_testemunha).values({ ocorrencia_id: oc.id, nome: "Testemunha Fictícia" }).returning();
  await db.insert(e.acidente_testemunha_contato).values({ testemunha_id: testemunha!.id, logradouro: "Rua B", municipio: "Diamantina", uf: "MG", telefone: "38988887777" });
  // a comunicação já criou a linha de saúde (declarada); o médico preencheu o detalhe
  await db
    .update(e.acidente_saude)
    .set({
      houve_afastamento: "SIM",
      dias_afastamento: 10,
      dias_internacao: 2,
      primeiro_socorro_unidade: "UPA Fictícia",
      descricao_lesao: "Corte superficial",
      cid: "S61.0",
      origem: "REGISTRADO_MEDICO",
    })
    .where(eq(e.acidente_saude.acidentado_id, env!.id));
  return { oc, env: env!, testemunha: testemunha! };
}

/** Conclui a ocorrência há `anos` anos; com decisão pericial, se pedido. */
async function concluir(id: number, anos: number, com_decisao = true) {
  await db.update(e.acidente_ocorrencia).set({ estado: "CONCLUIDA", concluida_em: ANOS_ATRAS(anos) }).where(eq(e.acidente_ocorrencia.id, id));
  if (com_decisao) {
    const [coord] = await db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await db.insert(e.acidente_decisao_pericial).values({
      ocorrencia_id: id,
      resultado: "ACIDENTE_EM_SERVICO_RECONHECIDO",
      decidida_em: "2020-01-10",
      registrada_por: coord!.id,
    });
  }
}

const rodar = (extra: Partial<expurgo.OpcoesExpurgo> = {}) => db.transaction((tx) => expurgo.expurgar(tx, { ata: "Ata 3/2031", ...extra }));

describe("o que entra e o que sai", () => {
  it("apaga identificação, contato de testemunha e nível 2 da saúde; deixa o núcleo, o nome e o vínculo", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    const r = await rodar();
    expect(r.ocorrencias).toHaveLength(1);
    expect(r).toMatchObject({ identificacoes: 1, contatos_testemunha: 1, saude: 1 });

    const [ident] = await db.select().from(e.acidente_identificacao).where(eq(e.acidente_identificacao.acidentado_id, c.env.id));
    expect(ident).toMatchObject({ cpf: null, rg: null, sexo: null, data_nascimento: null, cep: null, logradouro: null, telefone: null, email: null });
    expect(ident!.expurgado_em).not.toBeNull();
    const [contato] = await db.select().from(e.acidente_testemunha_contato).where(eq(e.acidente_testemunha_contato.testemunha_id, c.testemunha.id));
    expect(contato).toMatchObject({ logradouro: null, municipio: null, telefone: null });
    expect(contato!.expurgado_em).not.toBeNull();
    const [saude] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, c.env.id));
    expect(saude).toMatchObject({ dias_internacao: null, primeiro_socorro_unidade: null, descricao_lesao: null, cid: null });
    expect(saude!.detalhe_expurgado_em).not.toBeNull();
    // o núcleo e o vínculo ficam
    expect(saude).toMatchObject({ houve_afastamento: "SIM" });
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.id, c.env.id));
    expect(env!.vinculo).toBe(c.env.vinculo);
  });

  it("não toca ocorrência recente, sem decisão pericial ou não concluída", async () => {
    const recente = await ocorrencia();
    await concluir(recente.oc.id, 2);
    const r = await rodar();
    expect(r.ocorrencias).toHaveLength(0);

    const sem_decisao = await ocorrencia();
    await concluir(sem_decisao.oc.id, 9, false);
    expect((await rodar()).ocorrencias).toHaveLength(0);

    const aberta = await ocorrencia();
    expect((await rodar()).ocorrencias).toHaveLength(0);
    const [ident] = await db.select().from(e.acidente_identificacao).where(eq(e.acidente_identificacao.acidentado_id, aberta.env.id));
    expect(ident!.cpf).not.toBeNull();
    expect(ident!.expurgado_em).toBeNull();
  });

  it("o prazo é parâmetro: com 1 ano a de 2 anos entra", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 2);
    expect((await rodar({ anos: 1 })).ocorrencias).toHaveLength(1);
  });

  it("é idempotente: a segunda rodada não encontra nada e não repete evento", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    await rodar();
    expect((await rodar()).ocorrencias).toHaveLength(0);
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_EXPURGO_PARCIAL"));
    expect(eventos).toHaveLength(1);
  });
});

describe("a trilha e as travas", () => {
  it("grava um evento por ocorrência, com a ata e as contagens, sem nenhum valor", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    await rodar();
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_EXPURGO_PARCIAL"));
    expect(ev!.entidade_id).toBe(c.oc.id);
    expect(ev!.descricao).toContain("Ata 3/2031");
    // o conteúdo do evento, sem o hash encadeado: 128 hexadecimais ao acaso contêm "529" em ~3% das vezes
    const { hash_anterior: _a, hash_atual: _h, ...conteudo } = ev!;
    const tudo = JSON.stringify(conteudo);
    for (const proibido of ["529", "MG-1", "Rua dos Testes", "fulana", "S61", "UPA Fictícia", "Corte superficial", "38999991234"]) {
      expect(tudo).not.toContain(proibido);
    }
  });

  it("depois do expurgo o dado não volta (trigger) nem o carimbo se altera", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    await rodar();
    await expect(
      db.update(e.acidente_identificacao).set({ cpf: "52998224725" }).where(eq(e.acidente_identificacao.acidentado_id, c.env.id)),
    ).rejects.toThrow();
    await expect(
      db.update(e.acidente_identificacao).set({ expurgado_em: null }).where(eq(e.acidente_identificacao.acidentado_id, c.env.id)),
    ).rejects.toThrow();
    await expect(
      db.update(e.acidente_testemunha_contato).set({ telefone: "38999990000" }).where(eq(e.acidente_testemunha_contato.testemunha_id, c.testemunha.id)),
    ).rejects.toThrow();
    // o que não é dado (quem registrou) ainda pode mudar sem quebrar a trava
    await db.update(e.acidente_identificacao).set({ registrado_por: null }).where(eq(e.acidente_identificacao.acidentado_id, c.env.id));
  });

  it("recusa ata vazia ou com dado fora do padrão e prazo inválido", async () => {
    await expect(rodar({ ata: "  " })).rejects.toThrow(expurgo.ExpurgoRecusado);
    await expect(rodar({ ata: "<script>" })).rejects.toThrow(expurgo.ExpurgoRecusado);
    await expect(rodar({ anos: 0 })).rejects.toThrow(expurgo.ExpurgoRecusado);
    await expect(rodar({ anos: 2.5 })).rejects.toThrow(expurgo.ExpurgoRecusado);
  });
});

describe("o que a tela e o PDF mostram depois", () => {
  it("a leitura traz a data do expurgo e o PDF do Anexo III avisa que o campo foi apagado", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    await rodar();
    const [oc] = await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, c.oc.id));
    const medico = await usuarioAtual(db, "medico_trabalho");
    const lida = await db.transaction((tx) => identificacao.ler(tx, medico, oc as never, c.env.id, "INSTRUCAO_PERICIA"));
    expect(lida.expurgada_em).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lida.cpf_exibicao).toBeNull();
    const { blocos } = await db.transaction((tx) => anexo.blocos_do_acidentado(tx, medico, oc as never, c.env.id));
    const aviso = blocos.find((b) => b.t === "aviso" && b.texto.includes("Expurgo parcial"));
    expect(aviso).toBeTruthy();
  });
});

describe("a ferramenta de terminal", () => {
  function saida(respostas: string[] = []) {
    const linhas: string[] = [];
    const erros: string[] = [];
    return { linhas, erros, tudo: () => [...linhas, ...erros].join("\n"), s: { log: (l: string) => linhas.push(l), erro: (l: string) => erros.push(l), perguntar: async () => respostas.shift() ?? "" } };
  }
  const identidade = () => identidadeDoBanco(url);
  const conta = async () => {
    const [l] = (await db.execute(sql`SELECT count(*)::int AS n FROM acidente_identificacao WHERE expurgado_em IS NOT NULL`)) as unknown as { n: number }[];
    return l!.n;
  };

  beforeEach(() => {
    process.env.DATABASE_URL = url;
  });

  it("sem --executar é simulação: mostra o que apagaria e não grava nada", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    const o = saida();
    expect(await ferramenta.principal([], o.s)).toBe(0);
    expect(o.tudo()).toContain("SIMULAÇÃO");
    expect(o.tudo()).toContain(c.oc.protocolo);
    expect(o.tudo()).not.toContain("529");
    expect(await conta()).toBe(0);
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_EXPURGO_PARCIAL"));
    expect(eventos).toHaveLength(0);
  });

  it("--executar sem --ata, ata inválida e confirmação errada não gravam", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    expect(await ferramenta.principal(["--executar"], saida().s)).toBe(1);
    expect(await ferramenta.principal(["--executar", "--ata", "<x>"], saida().s)).toBe(2);
    expect(await ferramenta.principal(["--executar", "--ata", "Ata 1/2031", "--confirmar", "outra"], saida().s)).toBe(3);
    expect(await conta()).toBe(0);
  });

  it("--executar com a ata e a identidade do banco expurga", async () => {
    const c = await ocorrencia();
    await concluir(c.oc.id, 6);
    const o = saida();
    expect(await ferramenta.principal(["--executar", "--ata", "Ata 1/2031", "--confirmar", identidade()], o.s)).toBe(0);
    expect(await conta()).toBe(1);
    expect(o.tudo()).toContain("Expurgo feito");
    // rodar de novo não acha nada
    const de_novo = saida();
    expect(await ferramenta.principal(["--executar", "--ata", "Ata 1/2031", "--confirmar", identidade()], de_novo.s)).toBe(0);
    expect(de_novo.tudo()).toContain("Nada a expurgar");
  });

  it("recusa --anos inválido", async () => {
    expect(await ferramenta.principal(["--anos", "0"], saida().s)).toBe(1);
  });
});
