/** Ajudantes dos testes do módulo de acidentes (dados fictícios). */
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias, hoje_iso } from "../src/dominio/datas.js";
import type * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import { usuarioAtual } from "./ajuda.js";

export async function servidorFicticio(db: Banco, siape: string, nome = `Servidor ${siape}`) {
  const [s] = await db.insert(e.servidor).values({ siape, nome }).returning();
  return s!;
}

/** O servidor comum da suíte, ligado a um cadastro de servidor. */
export async function titular(db: Banco, siape = "7000001") {
  const s = await servidorFicticio(db, siape, "Titular Fictício");
  await db.update(e.usuario).set({ servidor_id: s.id }).where(eq(e.usuario.login, "servidor_consulta"));
  return { servidor: s, usuario: await usuarioAtual(db, "servidor_consulta") };
}

export function dados(extra: Partial<comunicacao.DadosComunicacao> = {}): comunicacao.DadosComunicacao {
  const ontem = somar_dias(hoje_iso(), -1);
  return {
    fatos: {
      especie: "TIPICO",
      data_evento: ontem,
      hora_evento: "09:30",
      minutos_apos_inicio_jornada: 90,
      ultimo_dia_trabalho: null,
      local_tipo: "LABORATORIO",
      local_especificacao: "Laboratório de química, bancada 3",
      campus_id: null,
      local_municipio: "Diamantina",
      local_uf: "MG",
      local_cnpj_contratada: null,
      transito_registro_policial: "SIM",
      transito_numero_bo: "123",
      transito_vitima_terceiros: null,
      agente_causador_id: null,
      agente_doenca_id: null,
      situacao_geradora_id: null,
    },
    relato: { descricao: "Ao abrir o frasco, o líquido respingou na bancada.", atividade_no_momento: "Preparo de solução" },
    envolvidos: [envolvido({ sou_eu: true })],
    testemunhas: [{ nome: "Testemunha Fictícia", vinculo: "ESTUDANTE", contato: "ramal 1234" }],
    sou_chefia: false,
    declarou_veracidade: true,
    ...extra,
  };
}

export function envolvido(extra: Partial<comunicacao.Envolvido> = {}): comunicacao.Envolvido {
  return {
    vinculo: "SERVIDOR",
    sou_eu: false,
    siape: null,
    nome_externo: null,
    identificacao_externa: null,
    empresa_contratada: null,
    condicao: "ACIDENTADO",
    houve_lesao: "SIM",
    contato_investigacao: null,
    menor_de_idade: false,
    saude: { partes_corpo_ids: [], houve_atendimento: "SIM", houve_afastamento: "NAO_SABE", houve_internacao: "NAO", houve_obito: "NAO" },
    ...extra,
  };
}


/** Uma ocorrência comunicada pelo titular e levada à investigação pela equipe. */
export async function em_investigacao(db: Banco, extra: Partial<comunicacao.DadosComunicacao> = {}) {
  const comunicar = await import("../src/servicos/acidente_comunicacao.js");
  const triagem = await import("../src/servicos/acidente_triagem.js");
  const { usuario } = await titular(db);
  const oc = await db.transaction((tx) => comunicar.comunicar(tx, usuario, dados(extra)));
  const equipe = await usuarioAtual(db, "tecnico_seguranca");
  await db.transaction((tx) => triagem.assumir(tx, equipe, oc, oc.versao));
  const ler = async () => (await db.select().from(e.acidente_ocorrencia).where(eq(e.acidente_ocorrencia.id, oc.id)))[0]!;
  const a = await ler();
  await db.transaction((tx) => triagem.mudar_estado(tx, equipe, a, "EM_INVESTIGACAO", a.versao));
  return { oc: await ler(), equipe, ler };
}
