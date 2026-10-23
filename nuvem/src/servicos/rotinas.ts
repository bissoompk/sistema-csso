/**
 * As rotinas que o relógio dispara. No Python eram tarefas do sistema
 * operacional (systemd `csso-backup.timer`, Tarefa Agendada do Windows) e o
 * `lifespan` do FastAPI:
 *
 * | Python | Aqui |
 * |---|---|
 * | `backup_cli backup` (timer diário, 22h30) | `backup_diario` — função de fundo `backup-background` |
 * | retenção "90 dias + 1 mensal por 5 anos" (POLITICA_RETENCAO §4, cumprida à mão) | `reter_backups`, logo depois do backup |
 * | `expurgar_sessoes` no boot | `rotinas_noturnas` (a nuvem não tem boot) |
 * | rotação de 90 dias do `logs/acesso.log` | `rotinas_noturnas` → `expurgos_de_privacidade` |
 * | `conferir_cadeia` (03h30) | `rotinas_noturnas`, origem ROTINA |
 * | `varrer_pendencias` (03h45) | `rotinas_noturnas` |
 *
 * Quem dispara é `netlify/functions/rotina-noturna.mts` (agendada, 30 s) — que
 * roda as leves e acorda a de fundo (15 min) para o backup.
 *
 * Cada passada vira uma linha em `rotina_execucao`, com ou sem sucesso: a
 * função agendada do Netlify não avisa ninguém quando falha, e "o backup rodou
 * ontem?" tem de ter resposta no banco (`/saude/db`), não na memória de
 * alguém. Rotina não é usuário: nada daqui escreve com o nome de uma pessoa.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Banco, Executor } from "../db/cliente.js";
import { agora_utc } from "../db/esquema/base.js";
import { epi_entrada_estoque, epi_ficha_registro, pendencia, rotina_execucao } from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import * as autenticacao from "./autenticacao.js";
import * as backup from "./backup.js";
import * as epi_estoque from "./epi_estoque.js";
import * as epi_ficha from "./epi_ficha.js";
import * as reciclagem from "./reciclagem.js";
import * as governanca from "./governanca.js";
import { hoje_iso } from "../dominio/datas.js";
import { obterArmazenamento, type Armazenamento } from "./armazenamento.js";
import { ambienteDeProducao } from "./instalacao.js";
import { TAMANHO_MINIMO_SENHA_BACKUP } from "../config.js";
import { expurgos_de_privacidade, mensagem_sem_dados } from "./privacidade.js";
import { expurgar_corpos } from "./email.js";
import * as acesso_participante from "./acesso_participante.js";
import * as ativar_acesso from "./ativar_acesso.js";

export const ROTINA_BACKUP = "BACKUP";
export const ROTINA_RETENCAO = "RETENCAO_BACKUP";
export const ROTINA_SESSOES = "EXPURGO_SESSOES";
export const ROTINA_LIMITES_IP = "EXPURGO_LIMITES_IP";
export const ROTINA_CADEIA = "CONFERENCIA_CADEIA";
export const ROTINA_PENDENCIAS = "VARREDURA_PENDENCIAS";
export const ROTINA_PRIVACIDADE = "EXPURGO_PRIVACIDADE";

/** POLITICA_RETENCAO.md §4: 90 dias em rotação; um mensal arquivado por 5 anos. */
export const RETENCAO = Object.freeze({ dias: 90, anos: 5, minimo: 7 });

export class RotinaFalhou extends Error {}

// ---------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------
export async function registrar_execucao(
  tx: Executor,
  rotina: string,
  iniciada_em: Date,
  ok: boolean,
  detalhe: string,
): Promise<void> {
  const concluida_em = agora_utc();
  await tx.insert(rotina_execucao).values({
    rotina,
    iniciada_em,
    concluida_em,
    duracao_ms: concluida_em.getTime() - iniciada_em.getTime(),
    ok,
    detalhe: detalhe.slice(0, 2000),
  });
}

/**
 * Roda `passo` na sua própria transação e registra o resultado numa outra —
 * a falha de uma rotina desfaz o que ela escreveu, mas não o registro de que
 * ela falhou.
 */
async function rodar<T>(
  db: Banco,
  rotina: string,
  passo: (tx: Executor) => Promise<T>,
  resumir: (r: T) => [boolean, string],
): Promise<{ ok: boolean; detalhe: string; resultado?: T }> {
  const inicio = agora_utc();
  try {
    const resultado = await db.transaction((tx) => passo(tx));
    const [ok, detalhe] = resumir(resultado);
    await db.transaction((tx) => registrar_execucao(tx, rotina, inicio, ok, detalhe));
    return { ok, detalhe, resultado };
  } catch (erro) {
    const detalhe = `falhou: ${mensagem_sem_dados(erro)}`;
    await db.transaction((tx) => registrar_execucao(tx, rotina, inicio, false, detalhe)).catch(() => {});
    return { ok: false, detalhe };
  }
}

// ---------------------------------------------------------------------
// Varredura das pendências de EPI (porte de ferramentas/varrer_pendencias.py)
// ---------------------------------------------------------------------
export const TIPOS_VARRIDOS = [epi_estoque.TIPO_PENDENCIA_CA, epi_ficha.TIPO_PENDENCIA_TROCA, reciclagem.TIPO_PENDENCIA] as const;

export interface ResultadoVarredura {
  lotes: number;
  servidores: number;
  certificados: reciclagem.ResultadoVarredura;
  antes: Record<string, number>;
  depois: Record<string, number>;
}

async function _contar(tx: Executor): Promise<Record<string, number>> {
  const saida: Record<string, number> = {};
  for (const tipo of TIPOS_VARRIDOS) {
    const linhas = await tx
      .select({ id: pendencia.id })
      .from(pendencia)
      .where(and(eq(pendencia.tipo, tipo), eq(pendencia.concluida, false)));
    saida[tipo] = linhas.length;
  }
  return saida;
}

/**
 * O que o relógio muda e a escrita não alcança: o lote parado que atravessa a
 * janela dos 60 dias do CA, e a troca de EPI que vence sem ninguém escrever
 * nada. Chama as MESMAS funções que a escrita chama, sem usuário (a rotina
 * não é ninguém), e é idempotente por chave.
 */
export async function varrer_pendencias(tx: Executor, quando: string | null = null): Promise<ResultadoVarredura> {
  const resultado: ResultadoVarredura = {
    lotes: 0,
    servidores: 0,
    certificados: { abertas: 0, fechadas: 0, avisados: 0 },
    antes: await _contar(tx),
    depois: {},
  };
  const lotes = await tx.select().from(epi_entrada_estoque).where(isNotNull(epi_entrada_estoque.validade_ca));
  for (const entrada of lotes) {
    await epi_estoque.sincronizar_pendencia_de_ca(tx, entrada, null);
    resultado.lotes += 1;
  }
  const servidores = await tx
    .selectDistinct({ servidor_id: epi_ficha_registro.servidor_id })
    .from(epi_ficha_registro)
    .where(and(eq(epi_ficha_registro.tipo, "ENTREGA"), isNotNull(epi_ficha_registro.previsao_troca)));
  for (const { servidor_id } of servidores) {
    await epi_ficha.sincronizar_trocas_do_servidor(tx, servidor_id, null, quando);
    resultado.servidores += 1;
  }
  // o certificado que entra na janela de 30 dias da reciclagem
  resultado.certificados = await reciclagem.varrer(tx, quando ?? hoje_iso());
  // D17: a concessão de `perfil.conceder` que vence pela data sem ninguém escrever nada
  await governanca.sincronizar_aviso_de_cobertura(tx, quando ?? hoje_iso());
  resultado.depois = await _contar(tx);
  return resultado;
}

// ---------------------------------------------------------------------
// As leves: sessões, cadeia, pendências
// ---------------------------------------------------------------------
export interface ResumoRotinas {
  ok: boolean;
  passos: { rotina: string; ok: boolean; detalhe: string }[];
}

/**
 * As rotinas leves, uma transação cada. A conferência da cadeia é a
 * única que pode "dar errado sem falhar": cadeia rompida é resultado, e sai
 * como `ok = false` — é incidente (o Python dizia: "trate como incidente —
 * isto não se conserta pela tela").
 */
export async function rotinas_noturnas(db: Banco): Promise<ResumoRotinas> {
  const passos: ResumoRotinas["passos"] = [];
  const sessoes = await rodar(
    db,
    ROTINA_SESSOES,
    (tx) => autenticacao.expurgar_sessoes(tx),
    (n) => [true, `${n} sessão(ões) expirada(s) há mais de ${autenticacao.log_retencao_dias()} dias apagada(s)`],
  );
  passos.push({ rotina: ROTINA_SESSOES, ok: sessoes.ok, detalhe: sessoes.detalhe });

  // janelas de falha de login por endereço já vencidas (limite_login_ip, da
  // revisão de segurança): guardam IP, e não servem para nada depois de 24 h
  const limites = await rodar(
    db,
    ROTINA_LIMITES_IP,
    (tx) => autenticacao.expurgar_limites_ip(tx),
    (n) => [true, `${n} janela(s) de limite de login por endereço vencida(s) apagada(s)`],
  );
  passos.push({ rotina: ROTINA_LIMITES_IP, ok: limites.ok, detalhe: limites.detalhe });

  const pendencias = await rodar(
    db,
    ROTINA_PENDENCIAS,
    (tx) => varrer_pendencias(tx),
    (r) => [
      true,
      `${r.lotes} lote(s) com CA e ${r.servidores} servidor(es) com troca prevista revistos; ` +
        `reciclagem: ${r.certificados.abertas} aviso(s) aberto(s), ${r.certificados.fechadas} fechado(s), ` +
        `${r.certificados.avisados} e-mail(s) ao participante; ` +
        TIPOS_VARRIDOS.map((t) => `${t}: ${r.depois[t] ?? 0} aberta(s) (${(r.depois[t] ?? 0) - (r.antes[t] ?? 0)} nesta passada)`).join("; "),
    ],
  );
  passos.push({ rotina: ROTINA_PENDENCIAS, ok: pendencias.ok, detalhe: pendencias.detalhe });

  const cadeia = await rodar(
    db,
    ROTINA_CADEIA,
    (tx) => auditoria.conferir_fora_da_transacao(tx, { origem: auditoria.ORIGEM_ROTINA }),
    (r) =>
      r.integra
        ? [true, `cadeia íntegra: ${r.eventos} evento(s) em ${r.duracao_ms} ms`]
        : [false, `CADEIA ROMPIDA no evento ${r.primeiro_defeito_id} (${r.eventos} conferidos até ali) — incidente`],
  );
  passos.push({ rotina: ROTINA_CADEIA, ok: cadeia.ok, detalhe: cadeia.detalhe });

  // Registro de acesso no prazo de `sessao` e a cópia da exportação completa
  // (zip em claro) em 24 h — `servicos/privacidade.ts` (revisão LGPD, 25/09/2026).
  const expurgos = await rodar(
    db,
    ROTINA_PRIVACIDADE,
    async (tx) => ({
      ...(await expurgos_de_privacidade(tx)),
      corpos: await expurgar_corpos(tx),
      links: (await acesso_participante.expurgar(tx)) + (await ativar_acesso.expurgar(tx)),
    }),
    (r) => [
      true,
      `${r.acessos} linha(s) de registro de acesso e ${r.exportacoes} exportação(ões) apagada(s); ` +
        `IP de ${r.ips} pedido(s) pelo link limpo(s); texto de ${r.corpos} e-mail(s) e ${r.links} link(s) de acesso apagado(s)`,
    ],
  );
  passos.push({ rotina: ROTINA_PRIVACIDADE, ok: expurgos.ok, detalhe: expurgos.detalhe });

  return { ok: passos.every((p) => p.ok), passos };
}

// ---------------------------------------------------------------------
// Backup e retenção
// ---------------------------------------------------------------------
const NOME_BACKUP = /^csso-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.enc$/;

/** O instante do nome `csso-AAAAMMDD-HHMMSS.enc` (UTC), ou null se o nome não é de backup. */
export function momento_do_backup(nome: string): Date | null {
  const m = nome.match(NOME_BACKUP);
  if (!m) return null;
  const [, a, me, d, h, mi, s] = m.map(Number) as number[];
  const t = Date.UTC(a!, me! - 1, d!, h!, mi!, s!);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Quais backups a política manda apagar (POLITICA_RETENCAO.md §4):
 *
 * - fica todo backup dos últimos 90 dias;
 * - fica o PRIMEIRO backup de cada mês, por 5 anos (o "mensal arquivado");
 * - ficam sempre os 7 mais recentes, qualquer que seja a idade — se o backup
 *   parar por meses, a retenção não pode apagar o último que existe;
 * - arquivo com nome que não é de backup nunca é tocado.
 */
export function backups_a_apagar(
  nomes: readonly string[],
  agora: Date = new Date(),
  politica: { dias: number; anos: number; minimo: number } = RETENCAO,
): string[] {
  const datados = nomes
    .map((nome) => ({ nome, quando: momento_do_backup(nome) }))
    .filter((b): b is { nome: string; quando: Date } => b.quando !== null)
    .sort((a, b) => a.quando.getTime() - b.quando.getTime());
  const ficam = new Set<string>();
  for (const b of datados.slice(-politica.minimo)) ficam.add(b.nome);
  const limiteRotacao = agora.getTime() - politica.dias * 86_400_000;
  const limiteArquivo = Date.UTC(agora.getUTCFullYear() - politica.anos, agora.getUTCMonth(), agora.getUTCDate());
  const mesesVistos = new Set<string>();
  for (const b of datados) {
    const mes = b.quando.toISOString().slice(0, 7);
    const primeiroDoMes = !mesesVistos.has(mes);
    mesesVistos.add(mes);
    if (b.quando.getTime() >= limiteRotacao) ficam.add(b.nome);
    else if (primeiroDoMes && b.quando.getTime() >= limiteArquivo) ficam.add(b.nome);
  }
  return datados.filter((b) => !ficam.has(b.nome)).map((b) => b.nome);
}

/** Aplica a retenção no prefixo de backups. Devolve as chaves apagadas. */
export async function reter_backups(
  arm: Armazenamento = obterArmazenamento(),
  agora: Date = new Date(),
  prefixo: string = backup.PREFIXO_BACKUP,
): Promise<{ apagados: string[]; restantes: number }> {
  const itens = await arm.listar(prefixo);
  const apagar = new Set(backups_a_apagar(itens.map((i) => i.nome), agora));
  const apagados: string[] = [];
  for (const item of itens) {
    if (!apagar.has(item.nome)) continue;
    await arm.remover(item.chave);
    apagados.push(item.chave);
  }
  return { apagados, restantes: itens.length - apagados.length };
}

/**
 * Em produção, backup com a senha de exemplo não é backup cifrado — é dado
 * pessoal com um cadeado cuja chave está no código-fonte. Recusa.
 */
export function conferir_senha_do_backup(): void {
  const senha = process.env.CSSO_BACKUP_SENHA ?? "";
  if (!ambienteDeProducao()) return;
  if (!senha || senha.includes("troque") || senha.length < TAMANHO_MINIMO_SENHA_BACKUP) {
    throw new RotinaFalhou(
      "CSSO_BACKUP_SENHA ausente, de exemplo ou curta (mínimo 16 caracteres): em produção o backup não sai sem senha própria.",
    );
  }
}

export interface ResultadoBackupDiario {
  ok: boolean;
  backup?: backup.ResultadoBackupDiario;
  apagados: string[];
  detalhe: string;
  ms: number;
}

/**
 * O backup do dia (`fazer_backup_diario`: banco no pacote, anexos cifrados um
 * a um em `backups/anexos/`) e a retenção. O dump roda numa transação REPEATABLE READ e
 * só de leitura: é isso que faz das ~80 tabelas UM retrato (em READ COMMITTED
 * cada `json_agg` veria um instante diferente, e a trilha podia sair com um
 * evento cuja entidade não saiu).
 */
export async function backup_diario(db: Banco, agora: Date = new Date()): Promise<ResultadoBackupDiario> {
  const inicio = agora_utc();
  const relogio = performance.now();
  let resultado: backup.ResultadoBackupDiario;
  try {
    conferir_senha_do_backup();
    resultado = await db.transaction((tx) => backup.fazer_backup_diario(tx), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  } catch (erro) {
    const detalhe = `falhou: ${mensagem_sem_dados(erro)}`;
    await db.transaction((tx) => registrar_execucao(tx, ROTINA_BACKUP, inicio, false, detalhe)).catch(() => {});
    return { ok: false, apagados: [], detalhe, ms: Math.round(performance.now() - relogio) };
  }
  const detalheBackup =
    `${resultado.chave}: ${resultado.tamanho} bytes cifrados, ${resultado.tabelas} tabela(s), ` +
    `${resultado.arquivos} anexo(s) (${resultado.anexos_novos} novo(s) cifrado(s) nesta passada)` +
    (resultado.ausentes.length ? `; ${resultado.ausentes.length} anexo(s) SEM blob no armazenamento` : "") +
    (resultado.pendentes.length ? `; PARCIAL: ${resultado.pendentes.length} anexo(s) ficaram para a próxima passada` : "");
  // backup parcial é backup do banco, mas não é "ok": a tela de saúde tem de
  // chamar atenção até a passada que completar
  const completo = resultado.pendentes.length === 0;
  await db.transaction((tx) => registrar_execucao(tx, ROTINA_BACKUP, inicio, completo, detalheBackup));
  if (!completo) {
    return { ok: false, backup: resultado, apagados: [], detalhe: detalheBackup, ms: Math.round(performance.now() - relogio) };
  }

  // retenção só depois de um backup completo: se o de hoje falhou, nada se apaga
  const inicioRetencao = agora_utc();
  let apagados: string[] = [];
  let ok = true;
  let detalheRetencao: string;
  try {
    const r = await reter_backups(obterArmazenamento(), agora);
    apagados = r.apagados;
    detalheRetencao = `${apagados.length} backup(s) antigo(s) apagado(s); ${r.restantes} guardado(s)`;
  } catch (erro) {
    ok = false;
    detalheRetencao = `falhou: ${mensagem_sem_dados(erro)}`;
  }
  await db.transaction((tx) => registrar_execucao(tx, ROTINA_RETENCAO, inicioRetencao, ok, detalheRetencao));
  return {
    ok,
    backup: resultado,
    apagados,
    detalhe: `${detalheBackup}. Retenção: ${detalheRetencao}`,
    ms: Math.round(performance.now() - relogio),
  };
}

/** A última passada de cada rotina — o que `/saude/db` mostra. */
export async function ultimas_execucoes(tx: Executor): Promise<(typeof rotina_execucao.$inferSelect)[]> {
  const linhas = (await tx.execute(
    // sql cru: DISTINCT ON não tem forma no query builder
    sql`
      SELECT DISTINCT ON (rotina) id, rotina, iniciada_em, concluida_em, duracao_ms, ok, detalhe
        FROM rotina_execucao ORDER BY rotina, id DESC`,
  )) as unknown as (typeof rotina_execucao.$inferSelect)[];
  return linhas;
}
