/**
 * Expurgos que a nuvem acrescentou à política de retenção (revisão de
 * privacidade para produção, 25/09/2026). Chamados pela rotina noturna
 * (`servicos/rotinas.ts`); cada um devolve o que apagou, e nada daqui escreve
 * nome de pessoa em lugar nenhum.
 */
import { inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { usuario as tabela_usuario } from "../db/esquema/index.js";
import { pode_ver_nominal } from "./identificacao.js";
import type { UsuarioAtual } from "./rbac.js";
import { identificador_opaco } from "./textos.js";
import { obterArmazenamento, type Armazenamento } from "./armazenamento.js";
import { PREFIXO_EXPORTACAO } from "./backup.js";
import { expurgar_registro_acesso } from "./registro_acesso.js";

export { expurgar_registro_acesso };

/** Por quanto tempo a cópia da exportação completa fica no armazenamento. */
export const HORAS_DA_EXPORTACAO = 24;

const NOME_EXPORTACAO = /^csso-export-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/;

/** O instante do nome `csso-export-AAAAMMDD-HHMMSS.zip` (UTC), ou null. */
export function momento_da_exportacao(nome: string): Date | null {
  const m = nome.match(NOME_EXPORTACAO);
  if (!m) return null;
  const [, a, me, d, h, mi, s] = m.map(Number) as number[];
  const t = Date.UTC(a!, me! - 1, d!, h!, mi!, s!);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * DESVIO do Python (DESVIOS.md, "Produção — privacidade"): lá "uma cópia fica
 * e não é apagada sozinha", no disco da máquina do setor. Aqui a cópia é um zip
 * EM CLARO com o banco inteiro (nome, SIAPE, exposição, anexos) num bucket de
 * terceiro — e ela só existe para servir a URL assinada de 60 s. Passado o
 * prazo, sai. Quem precisa guardar a exportação guarda o arquivo que baixou;
 * o backup cifrado é o que fica.
 *
 * Arquivo com nome fora do padrão não é tocado (não fui eu que o pus lá).
 */
export async function expurgar_exportacoes(
  arm: Armazenamento = obterArmazenamento(),
  agora: Date = new Date(),
  horas: number = HORAS_DA_EXPORTACAO,
): Promise<string[]> {
  const limite = agora.getTime() - horas * 3_600_000;
  const apagadas: string[] = [];
  for (const item of await arm.listar(PREFIXO_EXPORTACAO)) {
    const quando = momento_da_exportacao(item.nome);
    if (quando === null || quando.getTime() >= limite) continue;
    await arm.remover(item.chave);
    apagadas.push(item.chave);
  }
  return apagadas;
}

/** Os dois expurgos, para a rotina noturna. */
export async function expurgos_de_privacidade(
  tx: Executor,
  arm: Armazenamento = obterArmazenamento(),
): Promise<{ acessos: number; exportacoes: number }> {
  const acessos = await expurgar_registro_acesso(tx);
  const exportacoes = (await expurgar_exportacoes(arm)).length;
  return { acessos, exportacoes };
}

/**
 * A mensagem de uma falha, pronta para o log da plataforma e para
 * `rotina_execucao.detalhe`: sem os `params:` que o Drizzle anexa à consulta
 * que falhou (ali vão os valores — nome, SIAPE, texto de formulário).
 */
export function mensagem_sem_dados(erro: unknown): string {
  if (!(erro instanceof Error)) return `erro nao-Error: ${typeof erro}`;
  return `${erro.name}: ${erro.message.split(/\nparams:/)[0]!.slice(0, 500)}`;
}

/**
 * O `usuario_nome` de eventos da trilha, pronto para uma tela que NÃO é a
 * auditoria. Conta vinculada a servidor (a do titular que pediu EPI, se
 * inscreveu, consultou) sai como o identificador opaco dele para quem não pode
 * ver aquele nome — o ator ali é o próprio titular, e o nome dele ao lado do
 * tipo de evento é o que a RN-19 esconde. Conta de equipe sem vínculo sai pelo
 * nome. A linha gravada não muda.
 */
export async function atores_para_tela<T extends { usuario_id: number | null; usuario_nome: string | null }>(
  tx: Executor,
  eventos: T[],
  usuario: UsuarioAtual,
  semente: string,
): Promise<T[]> {
  const ids = [...new Set(eventos.map((e) => e.usuario_id).filter((i): i is number => i !== null))];
  if (!ids.length || usuario.ve_dado_nominal) return eventos;
  const vinculo = new Map(
    (
      await tx
        .select({ id: tabela_usuario.id, servidor_id: tabela_usuario.servidor_id })
        .from(tabela_usuario)
        .where(inArray(tabela_usuario.id, ids))
    ).map((u) => [u.id, u.servidor_id]),
  );
  return eventos.map((e) => {
    const servidor_id = e.usuario_id === null ? null : (vinculo.get(e.usuario_id) ?? null);
    if (servidor_id === null || pode_ver_nominal(usuario, servidor_id)) return e;
    return { ...e, usuario_nome: identificador_opaco(servidor_id, semente) };
  });
}
