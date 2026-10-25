/**
 * Liberação de módulo por módulo e vínculo a setor promotor (22/10/2026) — os
 * ATOS: gravar o nível de um módulo num perfil ou numa conta, e vincular a
 * conta a setores promotores. O mapa nível → permissões é de
 * `niveis_modulo.ts`; o cálculo efetivo, de `rbac.perfis_vigentes`.
 *
 * Três travas, nas três escritas:
 *
 * 1. só quem administra acesso (`perfil.conceder`);
 * 2. ninguém eleva o próprio acesso: a exceção e os setores da própria conta
 *    não se editam, e o nível de um perfil que a pessoa tem só desce;
 * 3. ninguém dá mais do que tem (D2): cada permissão que o ato acrescenta tem
 *    de estar no alcance de equipe de quem age, cobrindo o alcance que ela
 *    ganharia.
 *
 * Cada mudança vira um evento na trilha com o módulo, o nível anterior e o novo.
 */
import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  atribuicao,
  equipe_setor_promotor,
  perfil as tabela_perfil,
  perfil_nivel_modulo,
  unidade_uorg,
  usuario as tabela_usuario,
  usuario_nivel_modulo,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import * as auditoria from "./auditoria.js";
import {
  CONSULTA,
  MODULOS_NIVELADOS,
  OPERACAO,
  PARCIAL,
  ROTULO_NIVEL,
  PERFIS_NO_NIVEL_MAIS_ALTO,
  do_modulo,
  modulo_de_permissao,
  modulo_nivelado,
  niveis_de,
  nivel_lido,
  nivel_maximo,
  permissoes_com_niveis,
  rotulo_do_nivel,
  teto_do_perfil,
  type ModuloNivelado,
  type Nivel,
  type NiveisPorModulo,
} from "./niveis_modulo.js";
import {
  ESCOPO_POR_PERFIL,
  MODULO_LIBERAVEL_AO_TITULAR,
  PERFIS_EXTERNOS,
  PERMISSOES_DO_TITULAR_LIBERAVEIS,
  aceita_nivel_modulo,
  alcance_da_concessao,
  cobre_inteiro,
  type UsuarioAtual,
} from "./rbac.js";

/** O valor que a trilha grava para "linha ausente". */
export const PADRAO = "PADRAO";

function _rotulo(nivel: string | null, padrao_lido?: string): string {
  if (nivel === null) return padrao_lido ? `Padrão do perfil (${ROTULO_NIVEL[padrao_lido]})` : "Padrão";
  return ROTULO_NIVEL[nivel] ?? nivel;
}

/** As concessões que valem hoje ou vão valer (D18): é o que as travas de governo perguntam. */
function _valem_ou_vao_valer() {
  const hoje = hoje_iso();
  return or(isNull(atribuicao.vigencia_fim), gte(atribuicao.vigencia_fim, hoje));
}

/** Uma permissão que o ato daria e que quem age não tem com esse alcance (D2). */
function _alem_do_que_tem(usuario: UsuarioAtual, permissoes: Iterable<string>, perfil: string, campus_id: number | null): string[] {
  const alvo = alcance_da_concessao(perfil, campus_id);
  const alem: string[] = [];
  for (const p of permissoes) {
    if (usuario.pode(p) && cobre_inteiro(usuario.alcance_da_equipe(p), alvo)) continue;
    alem.push(p);
  }
  return alem;
}

// ---------------------------------------------------------------------
// Leitura para as telas
// ---------------------------------------------------------------------
export interface LinhaNivelPerfil {
  modulo: ModuloNivelado;
  /** o nível gravado, ou `null` = padrão */
  nivel: Nivel | null;
  /** como o padrão do perfil se lê (para o rótulo da opção "Padrão"), já descontado o teto */
  padrao: Nivel | typeof PARCIAL;
  /** o que vale hoje, lido */
  efetivo: Nivel | typeof PARCIAL;
  /** o rótulo único das duas telas (D10): "Operação (sem anular certificado)", "Consulta"… */
  rotulo_padrao: string;
  rotulo_efetivo: string;
  /** o que cada nível dá a ESTE perfil, com o teto dito: as opções da tela de edição */
  rotulo_consulta: string;
  rotulo_operacao: string;
  /** o nível mais alto que o perfil alcança no módulo (Consulta para PROGEP e auditor) */
  maximo: Nivel;
  /** as permissões do módulo que valem hoje */
  permissoes: string[];
}

export interface PerfilComNiveis {
  id: number;
  codigo: string;
  nome: string;
  ativo: boolean;
  base_normativa: string | null;
  /** a letra do escopo (`ESCOPO_POR_PERFIL`), ou `null` se não declarado */
  escopo: string | null;
  aceita: boolean;
  /** sempre em Operação, sem ajuste (o Administrador do sistema) */
  fixo: boolean;
  /** há nível gravado no perfil */
  ajustado: boolean;
  /** a conta que olha tem este perfil (vigente ou futuro): não o eleva */
  e_meu: boolean;
  linhas: LinhaNivelPerfil[];
  /** as permissões que valem e não são de módulo: vêm só do perfil */
  sempre_do_perfil: string[];
  /** o que nenhum nível devolve a este perfil (`NUNCA_POR_NIVEL`) */
  teto: readonly string[];
  /** TODAS as permissões que valem (módulos + sempre do perfil), em ordem de código */
  efetivas: string[];
}

/**
 * Todos os perfis, com o nível de cada módulo — o cálculo ÚNICO das duas telas
 * de perfil (23/10/2026, D5/D6): a Matriz (`/perfis`) só lê, o Acesso por
 * módulo (`/perfis/niveis`) edita, e as duas saem daqui. Ordem: por nome.
 */
export async function perfis_com_niveis(tx: Executor, usuario: UsuarioAtual): Promise<PerfilComNiveis[]> {
  const perfis = await tx.query.perfil.findMany({
    orderBy: [asc(tabela_perfil.nome)],
    with: { perfil_permissoes: { with: { permissao: true } }, niveis_modulo: true },
  });
  const meus = new Set(
    (
      await tx
        .select({ perfil_id: atribuicao.perfil_id })
        .from(atribuicao)
        .where(and(eq(atribuicao.usuario_id, usuario.id), _valem_ou_vao_valer()))
    ).map((a) => a.perfil_id),
  );
  return perfis.map((pf) => {
    const cruas = pf.perfil_permissoes.map((pp) => pp.permissao.codigo);
    const niveis = niveis_de(pf.niveis_modulo);
    const aceita = aceita_nivel_modulo(pf.codigo);
    const efetivas = aceita ? permissoes_com_niveis(cruas, niveis, {}, pf.codigo) : cruas;
    const teto = teto_do_perfil(pf.codigo);
    const fixo = Object.hasOwn(PERFIS_NO_NIVEL_MAIS_ALTO, pf.codigo);
    return {
      id: pf.id,
      codigo: pf.codigo,
      nome: pf.nome,
      ativo: pf.ativo,
      base_normativa: pf.base_normativa ?? null,
      escopo: Object.hasOwn(ESCOPO_POR_PERFIL, pf.codigo) ? ESCOPO_POR_PERFIL[pf.codigo]! : null,
      aceita,
      fixo,
      ajustado: Object.keys(niveis).length > 0,
      e_meu: meus.has(pf.id),
      teto,
      linhas: MODULOS_NIVELADOS.map((m) => {
        const padrao = nivel_lido(cruas, m, teto);
        const efetivo = nivel_lido(efetivas, m, teto);
        return {
          modulo: m,
          nivel: niveis[m.codigo] ?? null,
          padrao,
          efetivo,
          rotulo_padrao: rotulo_do_nivel(padrao, m, pf.codigo),
          rotulo_efetivo: rotulo_do_nivel(efetivo, m, pf.codigo),
          rotulo_consulta: rotulo_do_nivel(CONSULTA, m, pf.codigo),
          rotulo_operacao: rotulo_do_nivel(OPERACAO, m, pf.codigo),
          maximo: nivel_maximo(m, teto),
          permissoes: do_modulo(efetivas, m),
        };
      }),
      sempre_do_perfil: efetivas.filter((p) => modulo_de_permissao(p) === null).sort(),
      efetivas: [...efetivas].sort(),
    };
  });
}

/** A exceção de cada conta: `{usuario_id: {modulo: nivel}}`. */
export async function excecoes_por_conta(tx: Executor): Promise<Map<number, NiveisPorModulo>> {
  const linhas = await tx.select().from(usuario_nivel_modulo);
  const saida = new Map<number, Record<string, Nivel>>();
  for (const l of linhas) {
    const dela = saida.get(l.usuario_id) ?? {};
    Object.assign(dela, niveis_de([l]));
    saida.set(l.usuario_id, dela);
  }
  return saida;
}

/** Os setores de cada conta: `{usuario_id: [unidade_uorg_id]}`. */
export async function setores_por_conta(tx: Executor): Promise<Map<number, number[]>> {
  const linhas = await tx.select().from(equipe_setor_promotor);
  const saida = new Map<number, number[]>();
  for (const l of linhas) saida.set(l.usuario_id, [...(saida.get(l.usuario_id) ?? []), l.unidade_uorg_id]);
  return saida;
}

/** Os setores que podem receber equipe: os promotores ativos de hoje. */
export async function setores_promotores(tx: Executor) {
  return tx
    .select({ id: unidade_uorg.id, sigla: unidade_uorg.sigla, nome_extenso: unidade_uorg.nome_extenso })
    .from(unidade_uorg)
    .where(eq(unidade_uorg.promove_treinamento, true))
    .orderBy(asc(unidade_uorg.sigla));
}

// ---------------------------------------------------------------------
// Nível de um módulo num PERFIL
// ---------------------------------------------------------------------
/**
 * Grava (ou volta ao padrão, `nivel = null`) o nível de um módulo num perfil.
 * Devolve o motivo da recusa, ou `null` quando gravou (ou não havia o que mudar).
 */
export async function alterar_nivel_perfil(
  tx: Executor,
  usuario: UsuarioAtual,
  perfil_id: number,
  codigo_modulo: string,
  nivel: Nivel | null,
): Promise<string | null> {
  usuario.exigir("perfil.conceder");
  const m = modulo_nivelado(codigo_modulo);
  if (!m) return "Módulo desconhecido.";
  const pf = await tx.query.perfil.findFirst({
    where: eq(tabela_perfil.id, perfil_id),
    with: { perfil_permissoes: { with: { permissao: true } }, niveis_modulo: true },
  });
  if (!pf) return "Perfil inexistente.";
  if (Object.hasOwn(PERFIS_NO_NIVEL_MAIS_ALTO, pf.codigo)) {
    return `O perfil ${pf.nome} está sempre no nível mais alto (Operação) em todos os módulos e não se ajusta.`;
  }
  if (!aceita_nivel_modulo(pf.codigo)) {
    return `O perfil ${pf.nome} não se ajusta por módulo: o alcance dele é o do titular ou sem dado de módulo.`;
  }
  const cruas = pf.perfil_permissoes.map((pp) => pp.permissao.codigo);
  const niveis = niveis_de(pf.niveis_modulo);
  const anterior = niveis[m.codigo] ?? null;
  if (anterior === nivel) return null;
  // o teto do perfil (D1/D2): PROGEP e auditor vão no máximo até Consulta
  if (nivel === OPERACAO && nivel_maximo(m, teto_do_perfil(pf.codigo)) === CONSULTA) {
    return `O perfil ${pf.nome} vai, no máximo, até Consulta em ${m.nome}: não escreve em módulo nenhum, nem por liberação.`;
  }
  const antes = new Set(do_modulo(permissoes_com_niveis(cruas, niveis, {}, pf.codigo), m));
  const novos: Record<string, Nivel> = { ...niveis };
  if (nivel === null) delete novos[m.codigo];
  else novos[m.codigo] = nivel;
  const depois = do_modulo(permissoes_com_niveis(cruas, novos, {}, pf.codigo), m);
  const acrescenta = depois.filter((p) => !antes.has(p));

  if (acrescenta.length) {
    // ninguém eleva o próprio acesso: o perfil que a pessoa tem só desce
    const [meu] = await tx
      .select({ id: atribuicao.id })
      .from(atribuicao)
      .where(and(eq(atribuicao.usuario_id, usuario.id), eq(atribuicao.perfil_id, pf.id), _valem_ou_vao_valer()))
      .limit(1);
    if (meu) {
      return (
        `Você tem o perfil ${pf.nome}: subir o nível dele em ${m.nome} elevaria o seu próprio acesso. ` +
        "Outra pessoa que administra acesso pode fazer isso; baixar continua possível."
      );
    }
    const alem = _alem_do_que_tem(usuario, acrescenta, pf.codigo, null);
    if (alem.length) return `Você não tem, com esse alcance, o que este nível daria: ${alem.join(", ")}.`;
  }

  if (nivel === null) {
    await tx
      .delete(perfil_nivel_modulo)
      .where(and(eq(perfil_nivel_modulo.perfil_id, pf.id), eq(perfil_nivel_modulo.modulo, m.codigo)));
  } else {
    await tx
      .insert(perfil_nivel_modulo)
      .values({ perfil_id: pf.id, modulo: m.codigo, nivel, alterado_por: usuario.id, alterado_em: agora_utc() })
      .onConflictDoUpdate({
        target: [perfil_nivel_modulo.perfil_id, perfil_nivel_modulo.modulo],
        set: { nivel, alterado_por: usuario.id, alterado_em: agora_utc() },
      });
  }
  const padrao = nivel_lido(cruas, m, teto_do_perfil(pf.codigo));
  await auditoria.registrar(tx, {
    entidade: "perfil",
    entidade_id: pf.id,
    tipo_evento: auditoria.NIVEL_MODULO_PERFIL_ALTERADO,
    descricao:
      `Nível do módulo '${m.nome}' no perfil '${pf.codigo}': ` +
      `${_rotulo(anterior, padrao)} → ${_rotulo(nivel, padrao)}.`,
    campo: `modulo:${m.codigo}`,
    valor_anterior: anterior ?? PADRAO,
    valor_novo: nivel ?? PADRAO,
    usuario,
  });
  return null;
}

// ---------------------------------------------------------------------
// Exceção de uma PESSOA num módulo
// ---------------------------------------------------------------------
/**
 * Grava a exceção da conta num módulo (`nivel = null` = seguir o perfil).
 * Devolve o motivo da recusa, ou `null`.
 */
export async function alterar_nivel_pessoa(
  tx: Executor,
  usuario: UsuarioAtual,
  alvo_id: number,
  codigo_modulo: string,
  nivel: Nivel | null,
): Promise<string | null> {
  usuario.exigir("perfil.conceder");
  const m = modulo_nivelado(codigo_modulo);
  if (!m) return "Módulo desconhecido.";
  if (alvo_id === usuario.id) {
    return "Ninguém altera o acesso da própria conta: peça a outra pessoa que administra acesso.";
  }
  const alvo = await tx.query.usuario.findFirst({
    where: eq(tabela_usuario.id, alvo_id),
    with: { niveis_modulo: true },
  });
  if (!alvo) return "Conta inexistente.";
  const da_pessoa = niveis_de(alvo.niveis_modulo);
  const anterior = da_pessoa[m.codigo] ?? null;
  if (anterior === nivel) return null;

  // as concessões de equipe da conta, cruas e com o nível de cada perfil
  const concessoes = (
    await tx.query.atribuicao.findMany({
      where: and(eq(atribuicao.usuario_id, alvo.id), _valem_ou_vao_valer()),
      with: { perfil: { with: { perfil_permissoes: { with: { permissao: true } }, niveis_modulo: true } } },
    })
  ).filter((a) => a.perfil && a.perfil.ativo && aceita_nivel_modulo(a.perfil.codigo));
  // Sem perfil de equipe, só o titular em Processos SEI (25/10/2026): por padrão
  // o servidor não vê os próprios processos nem o adicional, e «Consulta» aqui
  // os devolve — sempre os DELE (`rbac.permissoes_do_titular`).
  if (nivel !== null && nivel !== "SEM_ACESSO" && !concessoes.length && m.codigo === MODULO_LIBERAVEL_AO_TITULAR) {
    const externa = (
      await tx.query.atribuicao.findMany({ where: eq(atribuicao.usuario_id, alvo.id), with: { perfil: true } })
    ).some((a) => a.perfil && PERFIS_EXTERNOS.includes(a.perfil.codigo));
    if (alvo.servidor_id === null || externa) {
      return "Só a conta ligada a um servidor vê os próprios processos e o adicional: ligue a conta ao servidor antes.";
    }
    if (nivel === OPERACAO) return "Sem perfil de equipe, a conta só consulta os próprios processos: escolha Consulta.";
    const falta = PERMISSOES_DO_TITULAR_LIBERAVEIS.filter((p) => !usuario.pode(p));
    if (falta.length) return `Você não tem o que este nível daria: ${falta.join(", ")}.`;
  } else if (nivel !== null && nivel !== "SEM_ACESSO" && !concessoes.length) {
    return (
      "A conta não tem perfil de equipe vigente: o nível de um módulo vale sobre o alcance de um perfil " +
      "(campus, equipe), e sem ele não daria nada. Conceda um perfil antes."
    );
  }
  // o teto de cada perfil vale também sobre a exceção da pessoa: Operação só
  // tem efeito se algum perfil da conta alcança Operação neste módulo
  if (nivel === OPERACAO && concessoes.every((a) => nivel_maximo(m, teto_do_perfil(a.perfil.codigo)) === CONSULTA)) {
    return `Os perfis desta conta vão, no máximo, até Consulta em ${m.nome}: Operação não teria efeito.`;
  }
  const novos: Record<string, Nivel> = { ...da_pessoa };
  if (nivel === null) delete novos[m.codigo];
  else novos[m.codigo] = nivel;
  const alem = new Set<string>();
  for (const a of concessoes) {
    const cruas = a.perfil.perfil_permissoes.map((pp) => pp.permissao.codigo);
    const do_perfil = niveis_de(a.perfil.niveis_modulo);
    const antes = new Set(do_modulo(permissoes_com_niveis(cruas, do_perfil, da_pessoa, a.perfil.codigo), m));
    const depois = do_modulo(permissoes_com_niveis(cruas, do_perfil, novos, a.perfil.codigo), m);
    for (const p of _alem_do_que_tem(usuario, depois.filter((p) => !antes.has(p)), a.perfil.codigo, a.campus_id ?? null)) {
      alem.add(p);
    }
  }
  if (alem.size) return `Você não tem, com esse alcance, o que este nível daria: ${[...alem].sort().join(", ")}.`;

  if (nivel === null) {
    await tx
      .delete(usuario_nivel_modulo)
      .where(and(eq(usuario_nivel_modulo.usuario_id, alvo.id), eq(usuario_nivel_modulo.modulo, m.codigo)));
  } else {
    await tx
      .insert(usuario_nivel_modulo)
      .values({ usuario_id: alvo.id, modulo: m.codigo, nivel, alterado_por: usuario.id, alterado_em: agora_utc() })
      .onConflictDoUpdate({
        target: [usuario_nivel_modulo.usuario_id, usuario_nivel_modulo.modulo],
        set: { nivel, alterado_por: usuario.id, alterado_em: agora_utc() },
      });
  }
  const seguir = (n: string | null) => (n === null ? "Padrão do perfil" : (ROTULO_NIVEL[n] ?? n));
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: auditoria.NIVEL_MODULO_PESSOA_ALTERADO,
    descricao: `Nível do módulo '${m.nome}' para a conta '${alvo.login}': ${seguir(anterior)} → ${seguir(nivel)}.`,
    campo: `modulo:${m.codigo}`,
    valor_anterior: anterior ?? PADRAO,
    valor_novo: nivel ?? PADRAO,
    usuario,
  });
  return null;
}

// ---------------------------------------------------------------------
// Setores promotores de uma conta
// ---------------------------------------------------------------------
/**
 * Troca os setores promotores da conta pelos escolhidos. Cada setor que entra
 * ou sai é um evento. Devolve o motivo da recusa, ou `null`.
 */
export async function definir_setores(
  tx: Executor,
  usuario: UsuarioAtual,
  alvo_id: number,
  escolhidos: readonly number[],
): Promise<string | null> {
  usuario.exigir("perfil.conceder");
  if (alvo_id === usuario.id) {
    return "Ninguém altera os setores da própria conta: peça a outra pessoa que administra acesso.";
  }
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, alvo_id));
  if (!alvo) return "Conta inexistente.";
  const validos = new Map((await setores_promotores(tx)).map((s) => [s.id, s]));
  const pedidos = [...new Set(escolhidos)];
  const estranhos = pedidos.filter((id) => !validos.has(id));
  if (estranhos.length) return "Escolha só entre os setores promotores da lista.";
  const atuais = (
    await tx.select().from(equipe_setor_promotor).where(eq(equipe_setor_promotor.usuario_id, alvo.id))
  ).map((l) => l.unidade_uorg_id);
  const entram = pedidos.filter((id) => !atuais.includes(id));
  const saem = atuais.filter((id) => !pedidos.includes(id));
  if (saem.length) {
    await tx
      .delete(equipe_setor_promotor)
      .where(and(eq(equipe_setor_promotor.usuario_id, alvo.id), inArray(equipe_setor_promotor.unidade_uorg_id, saem)));
  }
  if (entram.length) {
    await tx
      .insert(equipe_setor_promotor)
      .values(entram.map((id) => ({ usuario_id: alvo.id, unidade_uorg_id: id, vinculado_por: usuario.id })));
  }
  // a sigla de quem saiu e já não promove: lê do banco, não da lista de hoje
  const siglas = new Map(
    (
      await tx
        .select({ id: unidade_uorg.id, sigla: unidade_uorg.sigla })
        .from(unidade_uorg)
        .where(inArray(unidade_uorg.id, [...entram, ...saem, -1]))
    ).map((u) => [u.id, u.sigla]),
  );
  for (const id of entram) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: auditoria.SETOR_PROMOTOR_VINCULADO,
      descricao: `Conta '${alvo.login}' vinculada ao setor promotor ${siglas.get(id) ?? id}.`,
      campo: "setor_promotor",
      valor_novo: siglas.get(id) ?? String(id),
      usuario,
    });
  }
  for (const id of saem) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: auditoria.SETOR_PROMOTOR_DESVINCULADO,
      descricao: `Conta '${alvo.login}' desvinculada do setor promotor ${siglas.get(id) ?? id}.`,
      campo: "setor_promotor",
      valor_anterior: siglas.get(id) ?? String(id),
      usuario,
    });
  }
  return null;
}
