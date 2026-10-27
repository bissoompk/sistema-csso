/**
 * F9 do módulo de acidentes: a migração da planilha do CAT/SP antigo. Planilha
 * FICTÍCIA. O que importa: o protocolo original e a sequência que continua
 * depois dele, os catálogos casados pelo texto do legado, o descarte do que a
 * ROPA §4.3 proíbe (nenhum CPF chega ao banco), a idempotência e a recusa da
 * linha com defeito sem derrubar as outras.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as importacao from "../src/servicos/acidente_importacao.js";
import { proximo_numero_cat_sp } from "../src/servicos/numeracao.js";
import { bancoLimpo, contas } from "./ajuda.js";
import { servidorFicticio } from "./acidente_ajuda.js";

let db: Banco;
let ator_id: number;

beforeEach(async () => {
  db = (await bancoLimpo()).db;
  await contas(db);
  const [u] = await db.select({ id: e.usuario.id }).from(e.usuario).where(eq(e.usuario.login, "tecnico_seguranca"));
  ator_id = u!.id;
});

const CPF = "123.456.789-09";
const RG = "MG-12.345.678";
const RUA = "Rua das Flores Inventadas";
const FONE = "(38) 99999-1234";

/** A comunicação da planilha antiga, com tudo o que ela coletava (inclusive o que não pode entrar). */
function linha(extra: importacao.Linha = {}): importacao.Linha {
  return {
    Protocolo: "CAT-2025-0003",
    CriadoEm: "2025-03-14T12:00:00.000Z",
    AtualizadoEm: "2025-04-02T12:00:00.000Z",
    Status: "Recebida",
    TipoCAT: "Inicial",
    NomeServidor: "Fulano Fictício",
    Sexo: "Feminino",
    DataNascimento: "1980-05-10",
    CPF,
    RG,
    EmailServidor: "fulano.pessoal@exemplo.invalid",
    TelefoneCelular: FONE,
    Logradouro: RUA,
    Bairro: "Bairro Inventado",
    CEP: "39100-000",
    Cidade: "Diamantina",
    MatriculaSIAPE: "7001234",
    DataAcidente: "2025-03-12",
    HoraAcidente: "09:30",
    AposQuantasHorasTrabalho: "2 horas",
    TipoAcidente: "Típico",
    HouveAfastamento: "SIM",
    HouveMorte: "NÃO",
    HouveInternacao: "NÃO",
    ParteCorpoAtingida: "3. OLHO (inclusive nervo ótico e visão), 10. BRAÇO (entre o punho a o ombro)",
    DescricaoAcidente: `Respingo na bancada; o CPF ${CPF} foi anotado por engano.`,
    LocalTipo: "Laboratório",
    EspecificacaoLocal: "Laboratório de química",
    UFLocal: "mg",
    MunicipioLocal: "Diamantina",
    AtividadeNoMomento: "Preparo de solução",
    UnidadeAtendimento: "UPA Inventada",
    EmitenteNome: "Emitente Fictício",
    EmitenteEmail: "emitente@exemplo.invalid",
    Testemunha1Nome: "Testemunha Um",
    Testemunha1Telefone: "(38) 98888-0000",
    Testemunha1Endereco: "Avenida das Testemunhas, 10",
    ObservacoesSST: "anotação interna da SST",
    PastaDriveUrl: "https://drive.example.invalid/pasta",
    ServidoresEnvolvidosJSON: JSON.stringify([
      {
        NomeServidor: "Fulano Fictício",
        CPF,
        RG,
        DataNascimento: "1980-05-10",
        Logradouro: RUA,
        MatriculaSIAPE: "7001234",
        CondicaoNoAcidente: "Servidor acidentado",
        HouveLesao: "SIM",
        HouveAfastamentoIndividual: "SIM",
      },
    ]),
    ...extra,
  };
}

const vazio = (): importacao.Planilhas => ({ comunicacoes: [], analises: [], plano: [] });
const rodar = (p: importacao.Planilhas) => db.transaction((tx) => importacao.importar(tx, p, { ator_id }));
const ocorrencia = async (protocolo: string) =>
  (await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.protocolo, protocolo)))[0]!;

describe("ler_csv", () => {
  it("lê aspas, vírgula e quebra de linha dentro do campo, e o BOM", () => {
    const l = importacao.ler_csv('﻿Protocolo,Descricao\r\nCAT-2025-0001,"a, b ""c""\nlinha 2"\r\nCAT-2025-0002,x\r\n');
    expect(l).toEqual([
      { Protocolo: "CAT-2025-0001", Descricao: 'a, b "c"\nlinha 2' },
      { Protocolo: "CAT-2025-0002", Descricao: "x" },
    ]);
  });

  it("ignora linhas em branco e aceita a planilha vazia", () => {
    expect(importacao.ler_csv("")).toEqual([]);
    expect(importacao.ler_csv("A,B\n,\n1,2\n")).toEqual([{ A: "1", B: "2" }]);
  });
});

describe("a comunicação", () => {
  it("preserva o protocolo e traz os fatos, os catálogos, o envolvido e a testemunha", async () => {
    const s = await servidorFicticio(db, "7001234", "Fulano Fictício");
    const [agente] = await db.select().from(e.acidente_agente_causador).limit(1);
    const [situacao] = await db.select().from(e.acidente_situacao_geradora).limit(1);
    const r = await rodar({
      ...vazio(),
      comunicacoes: [linha({ AgenteCausadorAcidente: agente!.rotulo_legado!, SituacaoGeradora: situacao!.rotulo_legado! })],
    });
    expect(r.importadas).toEqual(["CAT-2025-0003"]);
    expect(r.recusadas).toEqual([]);

    const oc = await ocorrencia("CAT-2025-0003");
    expect(oc).toMatchObject({
      ano: 2025,
      numero: 3,
      origem: "MIGRACAO",
      tipo_cat: "INICIAL",
      estado: "RECEBIDA",
      especie: "TIPICO",
      data_evento: "2025-03-12",
      local_tipo: "LABORATORIO",
      local_uf: "MG",
      minutos_apos_inicio_jornada: 120,
      cat_sp_versao: 1,
      servidor_id: s.id,
      agente_causador_id: agente!.id,
      situacao_geradora_id: situacao!.id,
      restrita_sst: false,
      criado_por: null,
    });
    expect(String(oc.hora_evento).slice(0, 5)).toBe("09:30");
    expect(oc.prazo_comunicacao).toBe("2025-03-22");
    expect(oc.criado_em.toISOString()).toBe("2025-03-14T12:00:00.000Z");

    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    expect(env).toMatchObject({ servidor_id: s.id, nome_externo: null, condicao: "ACIDENTADO", houve_lesao: "SIM", siape: "7001234" });
    const testemunhas = await db.select().from(e.acidente_testemunha).where(eq(e.acidente_testemunha.ocorrencia_id, oc.id));
    expect(testemunhas).toMatchObject([{ nome: "Testemunha Um", contato: null }]);
    const [com] = await db.select().from(e.acidente_comunicante).where(eq(e.acidente_comunicante.ocorrencia_id, oc.id));
    expect(com).toMatchObject({ usuario_id: null, nome: "Emitente Fictício", email: "emitente@exemplo.invalid", vinculo: "OUTRO" });
  });

  it("congela a CAT/SP versão 1 com a origem MIGRACAO e o hash do contexto", async () => {
    await rodar({ ...vazio(), comunicacoes: [linha()] });
    const oc = await ocorrencia("CAT-2025-0003");
    const [cat] = await db.select().from(e.acidente_cat_sp).where(eq(e.acidente_cat_sp.ocorrencia_id, oc.id));
    expect(cat).toMatchObject({ versao: 1, origem: "MIGRACAO", registrada_por: ator_id });
    const { hash_do_contexto } = await import("../src/servicos/acidente_comunicacao.js");
    expect(cat!.hash_conteudo).toBe(hash_do_contexto(cat!.contexto_congelado));
  });

  it("nenhum CPF, RG, nascimento, endereço nem telefone chega ao banco", async () => {
    await servidorFicticio(db, "7001234", "Fulano Fictício");
    await rodar({ ...vazio(), comunicacoes: [linha()] });
    const tabelas = [
      "acidente_ocorrencia",
      "acidentado",
      "acidente_testemunha",
      "acidente_comunicante",
      "acidente_cat_sp",
      "acidente_saude",
      "historico_evento",
    ];
    for (const t of tabelas) {
      const linhas = await db.execute<{ j: string }>(sql.raw(`SELECT row_to_json(x)::text AS j FROM ${t} x`));
      const tudo = linhas.map((l) => l.j).join("\n");
      for (const proibido of [CPF, "12345678909", RG, RUA, FONE, "1980-05-10", "Bairro Inventado", "39100-000", "pessoal@exemplo", "drive.example", "Avenida das Testemunhas", "98888-0000", "anotação interna"]) {
        expect(tudo, `${t} vazou «${proibido}»`).not.toContain(proibido);
      }
    }
    const oc = await ocorrencia("CAT-2025-0003");
    expect(oc.local_especificacao).toBe("Laboratório de química");
    const [cat] = await db.select().from(e.acidente_cat_sp).where(eq(e.acidente_cat_sp.ocorrencia_id, oc.id));
    expect(JSON.stringify(cat!.contexto_congelado)).toContain("[CPF removido]");
  });

  it("conta os CPF tirados do texto e diz só o protocolo e o código nos avisos", async () => {
    const r = await rodar({ ...vazio(), comunicacoes: [linha()] });
    expect(r.cpf_removidos).toBe(1);
    expect(JSON.stringify(r.avisos)).not.toMatch(/Fictício|Rua|123\.456/);
  });

  it("casa as partes do corpo mesmo com vírgula no rótulo, e declara a saúde sem abrir pendência", async () => {
    const com_virgula = (await db.select().from(e.acidente_parte_corpo)).find((p) => p.rotulo_legado?.includes(","))!;
    await servidorFicticio(db, "7001234");
    await rodar({ ...vazio(), comunicacoes: [linha({ ParteCorpoAtingida: `${com_virgula.rotulo_legado}, 3. OLHO (inclusive nervo ótico e visão)` })] });
    const oc = await ocorrencia("CAT-2025-0003");
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    const [saude] = await db.select().from(e.acidente_saude).where(eq(e.acidente_saude.acidentado_id, env!.id));
    expect(saude).toMatchObject({
      origem: "DECLARADO_COMUNICANTE",
      houve_afastamento: "SIM",
      houve_obito: "NAO",
      houve_atendimento: "SIM",
      dias_afastamento: null,
      registrado_por: null,
    });
    const partes = await db.select().from(e.acidente_saude_parte).where(eq(e.acidente_saude_parte.saude_id, saude!.id));
    expect(partes).toHaveLength(2);
    expect(await db.select().from(e.pendencia)).toHaveLength(0);
  });

  it("acidentado menor de idade na data do acidente deixa a ocorrência restrita à SST", async () => {
    await rodar({ ...vazio(), comunicacoes: [linha({ ServidoresEnvolvidosJSON: JSON.stringify([{ NomeServidor: "Jovem Fictício", DataNascimento: "2010-06-01", CondicaoNoAcidente: "Servidor acidentado" }]) })] });
    const oc = await ocorrencia("CAT-2025-0003");
    expect(oc.restrita_sst).toBe(true);
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    expect(env!.menor_de_idade).toBe(true);
  });

  it("SIAPE fora do cadastro entra pelo nome, com o SIAPE guardado e um aviso", async () => {
    const r = await rodar({ ...vazio(), comunicacoes: [linha()] });
    const oc = await ocorrencia("CAT-2025-0003");
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    expect(env).toMatchObject({ servidor_id: null, nome_externo: "Fulano Fictício", siape: "7001234" });
    expect(oc.servidor_id).toBeNull();
    expect(r.avisos).toContainEqual({ protocolo: "CAT-2025-0003", aviso: "siape_nao_casou_com_o_cadastro" });
  });

  it("traz o estado da planilha: concluída, cancelada e «em análise SST»", async () => {
    await rodar({
      ...vazio(),
      comunicacoes: [
        linha({ Protocolo: "CAT-2025-0001", Status: "Concluída" }),
        linha({ Protocolo: "CAT-2025-0002", Status: "Cancelada", MatriculaSIAPE: "", ServidoresEnvolvidosJSON: "" }),
        linha({ Protocolo: "CAT-2025-0004", Status: "Em análise SST", ServidoresEnvolvidosJSON: "" }),
      ],
    });
    expect(await ocorrencia("CAT-2025-0001")).toMatchObject({ estado: "CONCLUIDA", conclusao_motivo: expect.any(String) });
    expect((await ocorrencia("CAT-2025-0001")).concluida_em).not.toBeNull();
    expect(await ocorrencia("CAT-2025-0002")).toMatchObject({ estado: "CANCELADA", cancelamento_motivo: "OUTRO" });
    expect((await ocorrencia("CAT-2025-0004")).estado).toBe("EM_INVESTIGACAO");
  });

  it("registra um evento por ocorrência na trilha, sem nome nem texto", async () => {
    await rodar({ ...vazio(), comunicacoes: [linha()] });
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_IMPORTADO"));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.descricao).toContain("CAT-2025-0003");
    expect(eventos[0]!.descricao).not.toMatch(/Fulano|Laboratório/);
  });
});

describe("a sequência e a idempotência", () => {
  it("a numeração continua depois do maior número migrado do ano", async () => {
    await rodar({
      ...vazio(),
      comunicacoes: [linha({ Protocolo: "CAT-2026-0002" }), linha({ Protocolo: "CAT-2026-0007", ServidoresEnvolvidosJSON: "" })],
    });
    const [seq] = await db.select().from(e.acidente_cat_sp_sequencia).where(eq(e.acidente_cat_sp_sequencia.ano, 2026));
    expect(seq!.ultimo_numero).toBe(7);
    expect(await db.transaction((tx) => proximo_numero_cat_sp(tx, 2026))).toBe(8);
  });

  it("rodar de novo pula o que já entrou e não duplica nada", async () => {
    const p = { ...vazio(), comunicacoes: [linha()], analises: [{ Protocolo: "CAT-2025-0003", SinteseExplicativa: "Tampa não reposta." }], plano: [{ Protocolo: "CAT-2025-0003", Acao: "Repor a tampa", Status: "Pendente" }] };
    const a = await rodar(p);
    const b = await rodar(p);
    expect(a.importadas).toHaveLength(1);
    expect(b.importadas).toEqual([]);
    expect(b.ja_existiam).toEqual(["CAT-2025-0003"]);
    expect(b.investigacoes + b.acoes).toBe(0);
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(1);
    expect(await db.select().from(e.acidente_acao)).toHaveLength(1);
    expect(await db.select().from(e.acidente_investigacao)).toHaveLength(1);
  });
});

describe("linhas com defeito", () => {
  it("recusa a linha sem data e o protocolo fora do padrão, e importa as outras", async () => {
    const r = await rodar({
      ...vazio(),
      comunicacoes: [linha({ Protocolo: "CAT-2025-0010", DataAcidente: "" }), linha({ Protocolo: "XYZ-1" }), linha({ Protocolo: "CAT-2025-0011" })],
    });
    expect(r.importadas).toEqual(["CAT-2025-0011"]);
    expect(r.recusadas.map((x) => x.protocolo).sort()).toEqual(["CAT-2025-0010", "XYZ-1"]);
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(1);
  });

  it("uma linha que o banco recusa desfaz só ela (ponto de salvamento)", async () => {
    // espécie desconhecida vira OUTRO, mas a data fora de qualquer calendário não passa
    const r = await rodar({
      ...vazio(),
      comunicacoes: [linha({ Protocolo: "CAT-2025-0020", DataAcidente: "31/02/2025" }), linha({ Protocolo: "CAT-2025-0021" })],
    });
    expect(r.importadas).toEqual(["CAT-2025-0021"]);
    expect(r.recusadas).toHaveLength(1);
    expect((await db.select().from(e.acidentado)).length).toBe(1);
  });
});

describe("a análise (MAPA) e o plano de ação", () => {
  it("traz a síntese, as barreiras rotuladas e a linha do tempo; o plano sai numerado, com o estado", async () => {
    const r = await rodar({
      ...vazio(),
      comunicacoes: [linha()],
      analises: [
        {
          Protocolo: "CAT-2025-0003",
          SinteseExplicativa: "Tampa de segurança não reposta.",
          Evidencias: "Fotos da bancada",
          BarreirasFisicas: "Capela sem exaustão",
          BarreirasAusentes: "Sem procedimento escrito",
          LinhaDoTempo: "09:25 abriu o frasco; 09:30 respingou",
          CaracterizadoAcidenteServicoSST: "Sim",
          RequerAberturaCATSIASS: "SIM",
          NexoCausalPerito: "texto do perito",
          GravacoesURLs: "https://drive.example.invalid/audio",
        },
        { Protocolo: "CAT-2099-9999", SinteseExplicativa: "órfã" },
      ],
      plano: [
        { Protocolo: "CAT-2025-0003", Achado: "Tampa solta", Acao: "Repor a tampa", TipoAcao: "Manutenção", Responsavel: "Laboratório de química", Prazo: "2025-05-01", Prioridade: "Alta", Status: "Concluída", Observacao: "Feito em abril" },
        { Protocolo: "CAT-2025-0003", Acao: "Treinar a equipe", TipoAcao: "Treinamento / orientação", Status: "Pendente" },
        { Protocolo: "CAT-2025-0003", Acao: "Ação cancelada", Status: "Cancelada" },
      ],
    });
    const oc = await ocorrencia("CAT-2025-0003");
    const [inv] = await db.select().from(e.acidente_investigacao).where(eq(e.acidente_investigacao.ocorrencia_id, oc.id));
    expect(inv).toMatchObject({ sintese: "Tampa de segurança não reposta.", caracterizacao: "SIM", requer_cat_siass: "SIM" });
    expect(inv!.evidencias_texto).toContain("Fotos da bancada");
    expect(inv!.evidencias_texto).toContain("Barreiras físicas: Capela sem exaustão");
    expect(inv!.evidencias_texto).toContain("Barreiras ausentes: Sem procedimento escrito");
    const linhas = await db.select().from(e.acidente_evento_linha).where(eq(e.acidente_evento_linha.ocorrencia_id, oc.id));
    expect(linhas).toHaveLength(1);
    expect(r.orfas).toBe(1);
    expect(r.avisos).toContainEqual({ protocolo: "CAT-2025-0003", aviso: "nexo_causal_do_perito_nao_importado" });

    const acoes = await db.select().from(e.acidente_acao).where(eq(e.acidente_acao.ocorrencia_id, oc.id)).orderBy(e.acidente_acao.numero);
    expect(acoes.map((a) => [a.numero, a.estado, a.tipo_acao, a.prioridade])).toEqual([
      [1, "CONCLUIDA", "MANUTENCAO", "ALTA"],
      [2, "PENDENTE", "TREINAMENTO", "MEDIA"],
      [3, "CANCELADA", "OUTRA", "MEDIA"],
    ]);
    expect(acoes[0]).toMatchObject({ responsavel_texto: "Laboratório de química", prazo: "2025-05-01", criada_por: ator_id });
    expect(acoes[0]!.concluida_em).not.toBeNull();
    expect(acoes[2]!.cancelamento_motivo).toBeTruthy();
    // nenhuma pendência de prazo: o caso é histórico
    expect(await db.select().from(e.pendencia)).toHaveLength(0);
  });
});

describe("a ferramenta de linha de comando", () => {
  it("recusa a pasta dentro do repositório e exige --pasta e --por", async () => {
    const { lerOpcoes } = await import("../ferramentas/importar-catsp.js");
    expect(lerOpcoes(["--por", "x"])).toMatch(/--pasta/);
    expect(lerOpcoes(["--pasta", "/tmp/qualquer"])).toMatch(/--por/);
    expect(lerOpcoes(["--pasta", process.cwd(), "--por", "x"])).toMatch(/dentro do repositório/);
    expect(lerOpcoes(["--pasta", "/tmp/fora-do-repositorio", "--por", "x", "--simular"])).toMatchObject({ simular: true, por: "x" });
  });
});
