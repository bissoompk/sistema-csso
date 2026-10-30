/**
 * Ocorrências de urgência e emergência (28/10/2026): o registro geral, de
 * qualquer pessoa na universidade, sem CAT/SP. Refaz o «Informar ocorrência de
 * urgência/emergência» do sistema PROACE antigo (`dominio/ocorrencia.ts`).
 *
 * Quem lê o quê: `ocorrencia.registrar` registra e vê só as PRÓPRIAS (as que a
 * conta registrou); `ocorrencia.ver` é da equipe e lê todas; `ocorrencia.tratar`
 * assume, acompanha e conclui. O nome da pessoa atendida e o relato são dado
 * sensível: a trilha guarda identificadores e nunca o conteúdo (RN-19), e a
 * planilha sai sem eles.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_ocorrencia,
  campus as tabela_campus,
  ocorrencia as tabela,
  ocorrencia_acompanhamento as tabela_acomp,
  usuario as tabela_usuario,
  type Ocorrencia,
} from "../db/esquema/index.js";
import {
  MEIOS_DESLOCAMENTO,
  NIVEIS_ENSINO,
  ROTULO_TIPO,
  SIM_NAO_NAO_SEI,
  SITUACOES,
  SITUACOES_ENCERRADAS,
  TIPOS,
  VINCULOS,
  protocolo_de,
  tipos_da_lista,
} from "../dominio/ocorrencia.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as ocorrencia_email from "./ocorrencia_email.js";
import { proximo_numero_ocorrencia } from "./numeracao.js";
import { da_coordenacao, type UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export type { Ocorrencia };

/** A recusa tem a mensagem que a tela mostra. */
export class OcorrenciaInvalida extends RegraViolada {}

export interface DadosOcorrencia {
  /** `AAAA-MM-DDTHH:MM`, hora de Brasília (o `datetime-local` do formulário) */
  data_hora: string;
  campus_id: number;
  local_descricao: string;
  tipos: string[];
  tipo_outro?: string;
  descricao: string;
  observacoes?: string;
  durante_atividade?: string;
  /** o notificante é a própria pessoa atendida */
  eh_a_pessoa: boolean;
  pessoa_nome?: string;
  pessoa_vinculo: string;
  pessoa_vinculo_outro?: string;
  nivel_ensino?: string;
  curso?: string;
  setor_lotacao?: string;
  acidente_em_servico?: string;
  empresa?: string;
  funcao?: string;
  notificante_telefone?: string;
  encaminhada_pronto_atendimento: boolean;
  meio_deslocamento?: string;
  meio_deslocamento_outro?: string;
}

const _ou_nulo = (v: string | undefined | null): string | null => {
  const t = (v ?? "").trim().replace(/\s+/g, " ");
  return t ? t : null;
};

/** Texto livre: CPF e CID nunca (o relato da saúde da pessoa é o que o módulo existe para receber). */
function _limpo(valor: string | undefined | null, campo: string, obrigatorio = false, maximo = 4000): string | null {
  const texto = (valor ?? "").trim();
  if (!texto) {
    if (obrigatorio) throw new OcorrenciaInvalida(`Informe ${campo}.`);
    return null;
  }
  if (texto.length > maximo) throw new OcorrenciaInvalida(`${campo[0]!.toUpperCase()}${campo.slice(1)} passa de ${maximo} caracteres.`);
  const duros = textos.termos_proibidos_em(texto).filter((t) => textos.TERMOS_SEMPRE_PROIBIDOS.includes(t));
  if (duros.length || textos.parece_cpf(texto)) {
    throw new OcorrenciaInvalida(`O campo ${campo} não pode ter CPF nem código de doença (CID): descreva o que aconteceu, sem identificar por número.`);
  }
  return texto;
}

function _em_lista<T extends string>(valor: string | undefined, lista: readonly T[], campo: string, obrigatorio = false): T | null {
  const v = (valor ?? "").trim();
  if (!v) {
    if (obrigatorio) throw new OcorrenciaInvalida(`Escolha ${campo}.`);
    return null;
  }
  if (!(lista as readonly string[]).includes(v)) throw new OcorrenciaInvalida(`Valor inválido em ${campo}.`);
  return v as T;
}

/** `AAAA-MM-DDTHH:MM` de Brasília como instante; recusa o que ainda não aconteceu. */
export function instante_de(texto: string, agora: Date = new Date()): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec((texto ?? "").trim());
  if (!m) throw new OcorrenciaInvalida("Informe a data e a hora em que aconteceu.");
  // Brasília é UTC-3 o ano todo (sem horário de verão desde 2019)
  const quando = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) + 3, Number(m[5])));
  if (Number.isNaN(quando.getTime())) throw new OcorrenciaInvalida("Data ou hora inválida.");
  if (quando.getTime() > agora.getTime() + 5 * 60_000) throw new OcorrenciaInvalida("A data e a hora não podem ser futuras.");
  if (quando.getTime() < agora.getTime() - 366 * 86_400_000) throw new OcorrenciaInvalida("A ocorrência é de mais de um ano atrás: procure a CSSO.");
  return quando;
}

// =====================================================================
// Registrar
// =====================================================================
export async function registrar(tx: Executor, usuario: UsuarioAtual, d: DadosOcorrencia, agora: Date = new Date()): Promise<Ocorrencia> {
  usuario.exigir("ocorrencia.registrar");
  const quando = instante_de(d.data_hora, agora);
  const [campus] = await tx.select({ id: tabela_campus.id }).from(tabela_campus).where(eq(tabela_campus.id, d.campus_id));
  if (!campus) throw new OcorrenciaInvalida("Escolha o campus onde aconteceu.");

  const tipos = [...new Set(d.tipos)].filter((t) => (TIPOS as readonly string[]).includes(t));
  if (!tipos.length) throw new OcorrenciaInvalida("Marque ao menos um tipo de ocorrência.");
  const tipo_outro = _limpo(d.tipo_outro, "«outra ocorrência»", false, 120);
  if (tipos.includes("OUTRA") && !tipo_outro) throw new OcorrenciaInvalida("Descreva a «outra ocorrência» marcada.");

  const vinculo = _em_lista(d.pessoa_vinculo, VINCULOS, "o vínculo da pessoa atendida", true)!;
  const [u] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario.id));
  const notificante_nome = (u?.nome ?? usuario.nome).trim();
  const nome_pessoa = d.eh_a_pessoa ? notificante_nome : _limpo(d.pessoa_nome, "o nome da pessoa atendida", true, 160);

  // só ficam os dados do vínculo escolhido: o resto do formulário, se veio, é descartado
  const e_estudante = vinculo === "ESTUDANTE";
  const e_servidor = vinculo === "SERVIDOR";
  const e_terceirizado = vinculo === "TERCEIRIZADO";
  const encaminhada = Boolean(d.encaminhada_pronto_atendimento);
  const meio = encaminhada ? _em_lista(d.meio_deslocamento, MEIOS_DESLOCAMENTO, "o meio de deslocamento", true) : null;
  const meio_outro = meio === "OUTRO" ? _limpo(d.meio_deslocamento_outro, "o meio de deslocamento «outro»", true, 80) : null;

  const ano = Number(datas_br.hoje(agora).slice(0, 4));
  const numero = await proximo_numero_ocorrencia(tx, ano);
  const [nova] = await tx
    .insert(tabela)
    .values({
      protocolo: protocolo_de(ano, numero),
      ano,
      numero,
      data_hora: quando,
      campus_id: campus.id,
      local_descricao: _limpo(d.local_descricao, "o local exato", true, 200)!,
      tipos: tipos.join(","),
      tipo_outro: tipos.includes("OUTRA") ? tipo_outro : null,
      descricao: _limpo(d.descricao, "a descrição do que aconteceu", true)!,
      observacoes: _limpo(d.observacoes, "as observações"),
      durante_atividade: _em_lista(d.durante_atividade, SIM_NAO_NAO_SEI, "se foi durante o trabalho ou o estudo"),
      pessoa_nome: nome_pessoa,
      pessoa_vinculo: vinculo,
      pessoa_vinculo_outro: vinculo === "OUTRO" ? _limpo(d.pessoa_vinculo_outro, "quem é a pessoa («outro»)", false, 80) : null,
      nivel_ensino: e_estudante ? _em_lista(d.nivel_ensino, NIVEIS_ENSINO, "o nível de ensino") : null,
      curso: e_estudante ? _limpo(d.curso, "o curso", false, 120) : null,
      setor_lotacao: e_servidor ? _limpo(d.setor_lotacao, "o setor", false, 120) : null,
      acidente_em_servico: e_servidor ? _em_lista(d.acidente_em_servico, SIM_NAO_NAO_SEI, "se é acidente em serviço") : null,
      empresa: e_terceirizado ? _limpo(d.empresa, "a empresa", false, 120) : null,
      funcao: e_terceirizado ? _limpo(d.funcao, "a função", false, 120) : null,
      registrado_por: usuario.id,
      notificante_eh_a_pessoa: Boolean(d.eh_a_pessoa),
      notificante_nome,
      notificante_telefone: _ou_nulo(d.notificante_telefone ?? u?.telefone),
      notificante_email: u?.email ?? null,
      encaminhada_pronto_atendimento: encaminhada,
      meio_deslocamento: meio,
      meio_deslocamento_outro: meio_outro,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "ocorrencia",
    entidade_id: nova!.id,
    tipo_evento: "OCORRENCIA_REGISTRADA",
    descricao: `Ocorrência ${nova!.protocolo} registrada`,
    usuario,
  });
  // desligado por padrão; o corpo leva só o protocolo e o link
  await ocorrencia_email.avisar_nova_ocorrencia(tx, nova!, usuario);
  return nova!;
}

// =====================================================================
// Ler
// =====================================================================
export interface Filtro {
  situacao?: string;
  campus_id?: number | null;
  tipo?: string;
  vinculo?: string;
  de?: string | null;
  ate?: string | null;
}

function _equipe(usuario: UsuarioAtual): boolean {
  return usuario.pode("ocorrencia.ver");
}

/** O recorte de quem lê: a equipe, tudo; os demais, só o que registraram. */
function _no_escopo(usuario: UsuarioAtual): SQL | undefined {
  return _equipe(usuario) ? undefined : eq(tabela.registrado_por, usuario.id);
}

function _onde(usuario: UsuarioAtual, f: Filtro): SQL | undefined {
  const partes: (SQL | undefined)[] = [_no_escopo(usuario)];
  if (f.situacao && (SITUACOES as readonly string[]).includes(f.situacao)) partes.push(eq(tabela.situacao, f.situacao));
  if (f.campus_id) partes.push(eq(tabela.campus_id, f.campus_id));
  if (f.vinculo && (VINCULOS as readonly string[]).includes(f.vinculo)) partes.push(eq(tabela.pessoa_vinculo, f.vinculo));
  if (f.tipo && (TIPOS as readonly string[]).includes(f.tipo)) partes.push(sql`(',' || ${tabela.tipos} || ',') LIKE ${"%," + f.tipo + ",%"}`);
  // o dia inteiro em Brasília (UTC-3)
  if (f.de) partes.push(gte(tabela.data_hora, new Date(`${f.de}T03:00:00Z`)));
  if (f.ate) partes.push(lte(tabela.data_hora, new Date(new Date(`${f.ate}T03:00:00Z`).getTime() + 86_399_999)));
  return and(...partes.filter((p): p is SQL => p !== undefined));
}

export async function listar(tx: Executor, usuario: UsuarioAtual, f: Filtro = {}, limite = 500): Promise<Ocorrencia[]> {
  if (!usuario.pode("ocorrencia.registrar") && !_equipe(usuario)) usuario.exigir("ocorrencia.ver");
  return tx.select().from(tabela).where(_onde(usuario, f)).orderBy(desc(tabela.data_hora), desc(tabela.id)).limit(limite);
}

/** 404 para a que não existe ou não é de quem pede (não diz qual). */
export async function carregar(tx: Executor, usuario: UsuarioAtual, id: number): Promise<Ocorrencia> {
  const [o] = await tx.select().from(tabela).where(and(eq(tabela.id, id), _no_escopo(usuario)));
  if (!o) throw new ErroHttp(404, "A ocorrência não existe ou não é sua.");
  return o;
}

export async function acompanhamentos(tx: Executor, ocorrencia_id: number) {
  return tx
    .select({ id: tabela_acomp.id, texto: tabela_acomp.texto, criado_em: tabela_acomp.criado_em, autor: tabela_usuario.nome })
    .from(tabela_acomp)
    .innerJoin(tabela_usuario, eq(tabela_usuario.id, tabela_acomp.autor_id))
    .where(eq(tabela_acomp.ocorrencia_id, ocorrencia_id))
    .orderBy(asc(tabela_acomp.id));
}

export async function contagem_por_situacao(tx: Executor, usuario: UsuarioAtual): Promise<Record<string, number>> {
  const linhas = await tx
    .select({ situacao: tabela.situacao, n: sql<number>`count(*)::int` })
    .from(tabela)
    .where(_no_escopo(usuario))
    .groupBy(tabela.situacao);
  return Object.fromEntries(linhas.map((l) => [l.situacao, Number(l.n)]));
}

// =====================================================================
// Tratar (equipe)
// =====================================================================
function _tratavel(o: Ocorrencia): void {
  if (SITUACOES_ENCERRADAS.has(o.situacao)) throw new OcorrenciaInvalida(`${o.protocolo} já está encerrada e não muda mais.`);
}

async function _evento(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, tipo_evento: string, descricao: string) {
  await auditoria.registrar(tx, { entidade: "ocorrencia", entidade_id: o.id, tipo_evento, descricao, usuario });
}

export async function assumir(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  _tratavel(o);
  if (o.situacao !== "REGISTRADA") throw new OcorrenciaInvalida(`${o.protocolo} já foi assumida.`);
  await tx.update(tabela).set({ situacao: "EM_ACOMPANHAMENTO", assumida_por: usuario.id, assumida_em: agora, atualizado_em: agora }).where(eq(tabela.id, o.id));
  await _evento(tx, usuario, o, "OCORRENCIA_ASSUMIDA", `Ocorrência ${o.protocolo} assumida`);
}

export async function acompanhar(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, texto: string, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  _tratavel(o);
  const t = _limpo(texto, "o acompanhamento", true)!;
  await tx.insert(tabela_acomp).values({ ocorrencia_id: o.id, texto: t, autor_id: usuario.id });
  // acompanhar sem ter assumido assume: quem escreve está tratando
  await tx
    .update(tabela)
    .set({ atualizado_em: agora, ...(o.situacao === "REGISTRADA" ? { situacao: "EM_ACOMPANHAMENTO", assumida_por: usuario.id, assumida_em: agora } : {}) })
    .where(eq(tabela.id, o.id));
  await _evento(tx, usuario, o, "OCORRENCIA_ACOMPANHADA", `Acompanhamento acrescentado à ${o.protocolo}`);
}

export async function concluir(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, conclusao: string, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  _tratavel(o);
  const c = _limpo(conclusao, "a conclusão", true)!;
  await tx
    .update(tabela)
    .set({ situacao: "CONCLUIDA", conclusao: c, concluida_em: agora, atualizado_em: agora, assumida_por: o.assumida_por ?? usuario.id, assumida_em: o.assumida_em ?? agora })
    .where(eq(tabela.id, o.id));
  await _evento(tx, usuario, o, "OCORRENCIA_CONCLUIDA", `Ocorrência ${o.protocolo} concluída`);
}

/**
 * A coordenação reabre ocorrência concluída ou cancelada (conclusão precoce,
 * cancelamento por engano). Volta a EM_ACOMPANHAMENTO; o motivo entra como
 * acompanhamento e na trilha, e o texto da conclusão antiga fica no histórico.
 */
export async function reabrir(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, motivo: string, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  if (!da_coordenacao(usuario)) throw new OcorrenciaInvalida("Reabrir ocorrência encerrada é com a coordenação.");
  if (!SITUACOES_ENCERRADAS.has(o.situacao)) throw new OcorrenciaInvalida(`${o.protocolo} não está encerrada.`);
  const m = _limpo(motivo, "o motivo da reabertura", true)!;
  await tx
    .update(tabela)
    .set({ situacao: "EM_ACOMPANHAMENTO", conclusao: null, concluida_em: null, atualizado_em: agora })
    .where(eq(tabela.id, o.id));
  await tx.insert(tabela_acomp).values({ ocorrencia_id: o.id, texto: `Reaberta: ${m}`, autor_id: usuario.id });
  // a trilha leva só a situação de antes; o motivo mora no acompanhamento
  await _evento(tx, usuario, o, "OCORRENCIA_REABERTA", `Ocorrência ${o.protocolo} reaberta (era ${o.situacao})`);
}

/** Cancelar é para o registro feito por engano; o número não volta. */
export async function cancelar(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, motivo: string, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  _tratavel(o);
  const m = _limpo(motivo, "o motivo do cancelamento", true)!;
  await tx.update(tabela).set({ situacao: "CANCELADA", conclusao: m, concluida_em: agora, atualizado_em: agora }).where(eq(tabela.id, o.id));
  await _evento(tx, usuario, o, "OCORRENCIA_CANCELADA", `Ocorrência ${o.protocolo} cancelada`);
}

/** Liga a ocorrência à CAT/SP aberta para o caso (o protocolo `CAT-AAAA-NNNN`). */
export async function vincular_acidente(tx: Executor, usuario: UsuarioAtual, o: Ocorrencia, protocolo_cat: string, agora: Date = new Date()): Promise<void> {
  usuario.exigir("ocorrencia.tratar");
  usuario.exigir("acidente.ver");
  const [cat] = await tx
    .select({ id: acidente_ocorrencia.id, protocolo: acidente_ocorrencia.protocolo })
    .from(acidente_ocorrencia)
    .where(eq(acidente_ocorrencia.protocolo, (protocolo_cat ?? "").trim().toUpperCase()));
  if (!cat) throw new OcorrenciaInvalida("Não há comunicação de acidente com esse protocolo.");
  await tx.update(tabela).set({ acidente_id: cat.id, atualizado_em: agora }).where(eq(tabela.id, o.id));
  await _evento(tx, usuario, o, "OCORRENCIA_VINCULADA_ACIDENTE", `Ocorrência ${o.protocolo} vinculada à ${cat.protocolo}`);
}

export async function protocolo_do_acidente(tx: Executor, acidente_id: number | null): Promise<string | null> {
  if (acidente_id === null) return null;
  const [cat] = await tx.select({ protocolo: acidente_ocorrencia.protocolo }).from(acidente_ocorrencia).where(eq(acidente_ocorrencia.id, acidente_id));
  return cat?.protocolo ?? null;
}

// =====================================================================
// Indicadores (equipe)
// =====================================================================
export interface Indicadores {
  total: number;
  por_tipo: { tipo: string; rotulo: string; n: number }[];
  por_campus: { campus: string; n: number }[];
  por_vinculo: { vinculo: string; n: number }[];
  por_mes: { mes: string; n: number }[];
  encaminhadas: number;
}

export async function indicadores(tx: Executor, usuario: UsuarioAtual, f: Filtro = {}): Promise<Indicadores> {
  usuario.exigir("ocorrencia.ver");
  const linhas = await tx.select().from(tabela).where(_onde(usuario, { ...f, situacao: f.situacao }));
  const validas = linhas.filter((o) => o.situacao !== "CANCELADA");
  const campi = new Map((await tx.select({ id: tabela_campus.id, nome: tabela_campus.nome }).from(tabela_campus)).map((c) => [c.id, c.nome]));
  const conta = <K>(chave: (o: Ocorrencia) => K[]) => {
    const m = new Map<K, number>();
    for (const o of validas) for (const k of chave(o)) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const ordenar = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total: validas.length,
    por_tipo: ordenar(conta((o) => tipos_da_lista(o.tipos))).map(([tipo, n]) => ({ tipo, rotulo: ROTULO_TIPO[tipo] ?? tipo, n })),
    por_campus: ordenar(conta((o) => [o.campus_id])).map(([id, n]) => ({ campus: campi.get(id) ?? `#${id}`, n })),
    por_vinculo: ordenar(conta((o) => [o.pessoa_vinculo])).map(([vinculo, n]) => ({ vinculo, n })),
    por_mes: [...conta((o) => [datas_br.data_local(o.data_hora)?.slice(0, 7) ?? ""]).entries()]
      .filter(([m]) => m)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([mes, n]) => ({ mes, n })),
    encaminhadas: validas.filter((o) => o.encaminhada_pronto_atendimento).length,
  };
}

/** Os campi para o formulário e o filtro. */
export async function campi(tx: Executor) {
  return tx.select({ id: tabela_campus.id, nome: tabela_campus.nome }).from(tabela_campus).orderBy(asc(tabela_campus.nome));
}
