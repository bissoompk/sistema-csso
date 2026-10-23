/**
 * Fatia A da paridade com o IntegraSST (22/10/2026): o titular comunica o EPI
 * que está com ele — extravio, ou troca por um dos quatro motivos do legado
 * (`L:EPI_Frontend.html:976-1005`, `L:EPI_Backend.js:1077-1108`).
 *
 * O que a comunicação É, e o que ela NÃO é:
 *
 * 1. É um recado do titular ao almoxarifado, gravado e com pendência aberta
 *    para a equipe (`EPI_COMUNICACAO_A_TRATAR`, sem responsável: é do setor).
 * 2. NÃO altera a ficha e NÃO devolve saldo ao estoque. A devolução física
 *    continua sendo ato da equipe (`epi_ficha.registrar_devolucao`).
 * 3. "Extraviado" não cobra nada nem abre nada além da pendência (Decisão 5):
 *    os textos são neutros, porque extravio pode ter efeito disciplinar e o
 *    sistema não é o lugar dessa conclusão.
 * 4. Nada se apaga: retirar grava `retirada_em/retirada_por`; tratar grava
 *    `tratada_em/tratada_por/tratamento`. O banco recusa DELETE.
 *
 * A trava de 24 h do legado era só do navegador; aqui ela é conferida no
 * servidor: o titular retira a própria comunicação até
 * `JANELA_RETIRADA_COMUNICACAO_HORAS` depois de criada; depois disso, só a
 * equipe (`epi.entregar`) mexe nela.
 *
 * A assinatura de `vincular_requisicao` é contrato com a fatia B — o pedido de
 * troca já preenchido a chama — e não muda.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  epi_comunicacao_titular,
  epi_ficha_registro,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  unidade_uorg,
} from "../db/esquema/index.js";
import { agora_utc } from "../db/esquema/base.js";
import { PermissaoNegada, RegraViolada } from "../nucleo/erros.js";
import {
  FINALIDADE_POR_COMUNICACAO,
  JANELA_RETIRADA_COMUNICACAO_HORAS,
  MOTIVO_ITEM_POR_COMUNICACAO,
  ROTULO_COMUNICACAO_TITULAR,
  TIPOS_COMUNICACAO_TITULAR,
  type TipoComunicacaoTitular,
} from "../dominio/epi.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import * as epi_ficha from "./epi_ficha.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export type EpiComunicacaoTitular = typeof epi_comunicacao_titular.$inferSelect;
type EpiFichaRegistro = typeof epi_ficha_registro.$inferSelect;

export const ENTIDADE = "epi_comunicacao_titular";
export const TIPO_PENDENCIA = "EPI_COMUNICACAO_A_TRATAR";
export const EPI_COMUNICACAO_REGISTRADA = "EPI_COMUNICACAO_REGISTRADA";
export const EPI_COMUNICACAO_RETIRADA = "EPI_COMUNICACAO_RETIRADA";
export const EPI_COMUNICACAO_TRATADA = "EPI_COMUNICACAO_TRATADA";

/** Teto dos textos curtos (observação do titular, tratamento da equipe). */
export const TAMANHO_MAXIMO_TEXTO = 500;

/**
 * Como a situação se escreve na TRILHA e na pendência — neutra (Decisão 5):
 * "informou que não está mais com ele", e não "perdeu".
 */
const FRASE_NEUTRA: Readonly<Record<TipoComunicacaoTitular, string>> = {
  EXTRAVIADO: "informou que o equipamento não está mais com ele (extravio, sem cobrança automática)",
  DESGASTE: "pediu a troca por desgaste físico",
  TEMPO_DE_USO: "pediu a troca por tempo de uso",
  PERDA_DE_EFICACIA: "pediu a troca por perda de eficácia",
  ALTERACAO_NO_TRABALHO: "pediu a troca por alterações no trabalho",
};

export function eh_tipo(valor: string): valor is TipoComunicacaoTitular {
  return (TIPOS_COMUNICACAO_TITULAR as readonly string[]).includes(valor);
}

/** Nem retirada nem tratada. */
export function aberta(c: Pick<EpiComunicacaoTitular, "retirada_em" | "tratada_em">): boolean {
  return c.retirada_em === null && c.tratada_em === null;
}

/** O instante até o qual o titular ainda retira a comunicação. */
export function retirada_ate(c: Pick<EpiComunicacaoTitular, "criado_em">): Date {
  return new Date(c.criado_em.getTime() + JANELA_RETIRADA_COMUNICACAO_HORAS * 3600 * 1000);
}

export function na_janela_do_titular(c: Pick<EpiComunicacaoTitular, "criado_em">, agora: Date = new Date()): boolean {
  return agora.getTime() <= retirada_ate(c).getTime();
}

/** O link do pedido de troca já preenchido (a fatia B lê estes parâmetros). */
export function link_pedido_de_troca(
  c: Pick<EpiComunicacaoTitular, "id" | "tipo">,
  registro: Pick<EpiFichaRegistro, "epi_item_id" | "tamanho_snapshot">,
): string {
  const tipo = c.tipo as TipoComunicacaoTitular;
  const p = new URLSearchParams();
  p.set("item", String(registro.epi_item_id));
  if (registro.tamanho_snapshot) p.set("tamanho", registro.tamanho_snapshot);
  p.set("motivo", MOTIVO_ITEM_POR_COMUNICACAO[tipo]);
  p.set("finalidade", FINALIDADE_POR_COMUNICACAO[tipo]);
  p.set("comunicacao", String(c.id));
  return `/epis/requisicoes/nova?${p.toString()}`;
}

export function chave_da_pendencia(comunicacao_id: number): string {
  return `comunicacao:epi:${comunicacao_id}`;
}

function _texto_curto(bruto: string | null | undefined, campo: string): string {
  const limpo = (textos.exigir_texto_limpo((bruto ?? "").trim(), campo) as string) ?? "";
  if (limpo.length > TAMANHO_MAXIMO_TEXTO) {
    throw new RegraViolada(`O campo ${campo} passa de ${TAMANHO_MAXIMO_TEXTO} caracteres: resuma.`);
  }
  return limpo;
}

export async function por_id(tx: Executor, id: number | null): Promise<EpiComunicacaoTitular | null> {
  if (id === null) return null;
  const [c] = await tx.select().from(epi_comunicacao_titular).where(eq(epi_comunicacao_titular.id, id));
  return c ?? null;
}

async function _registro(tx: Executor, id: number): Promise<EpiFichaRegistro> {
  const [r] = await tx.select().from(epi_ficha_registro).where(eq(epi_ficha_registro.id, id));
  return r!;
}

/** A comunicação aberta de uma linha da ficha, se houver (no máximo uma). */
export async function aberta_do_registro(tx: Executor, registro_id: number): Promise<EpiComunicacaoTitular | null> {
  const [c] = await tx
    .select()
    .from(epi_comunicacao_titular)
    .where(
      and(
        eq(epi_comunicacao_titular.registro_id, registro_id),
        isNull(epi_comunicacao_titular.retirada_em),
        isNull(epi_comunicacao_titular.tratada_em),
      ),
    )
    .orderBy(desc(epi_comunicacao_titular.id))
    .limit(1);
  return c ?? null;
}

/** Todas as comunicações da ficha de um servidor, da mais recente à mais antiga. */
export async function do_servidor(tx: Executor, servidor_id: number): Promise<EpiComunicacaoTitular[]> {
  return tx
    .select()
    .from(epi_comunicacao_titular)
    .where(eq(epi_comunicacao_titular.servidor_id, servidor_id))
    .orderBy(desc(epi_comunicacao_titular.id));
}

// =====================================================================
// Comunicar — só o titular, só a entrega vigente
// =====================================================================
/**
 * Por que a linha não pode ser comunicada — ou `null`, quando pode. Usada pela
 * tela (para não oferecer o botão) e pelo serviço (que confere de novo).
 */
export async function impedimento(tx: Executor, registro: EpiFichaRegistro): Promise<string | null> {
  if (registro.tipo !== "ENTREGA") {
    return `só se comunica sobre uma entrega, e o registro ${registro.id} é ${registro.tipo.toLowerCase()}`;
  }
  if ((await epi_ficha._ja_estornado(tx, registro)) !== null) {
    return `o registro ${registro.id} foi corrigido (estornado): ele não vale como entrega`;
  }
  const devolvido = (await epi_ficha.devolucoes_de(tx, registro)).reduce((s, d) => s + d.quantidade, 0);
  if (devolvido >= registro.quantidade) {
    return `o equipamento do registro ${registro.id} já foi devolvido ao almoxarifado`;
  }
  if ((await aberta_do_registro(tx, registro.id)) !== null) {
    return "já há uma comunicação aberta sobre este equipamento: retire-a ou aguarde o almoxarifado tratá-la";
  }
  return null;
}

export async function comunicar(
  tx: Executor,
  usuario: UsuarioAtual,
  registro: EpiFichaRegistro,
  d: { tipo: string; observacao?: string | null },
): Promise<EpiComunicacaoTitular> {
  usuario.exigir("epi.ver");
  // a comunicação é do TITULAR: nem a equipe comunica em nome dele (ela tem a
  // devolução e o estorno, que são atos dela)
  if (usuario.servidor_id === null || usuario.servidor_id !== registro.servidor_id) {
    throw new PermissaoNegada("epi.ver", "Só o titular da ficha comunica sobre o EPI que está com ele.");
  }
  if (!eh_tipo(d.tipo)) throw new RegraViolada("Escolha a situação do equipamento.");
  const observacao = _texto_curto(d.observacao, "observação");
  const motivo = await impedimento(tx, registro);
  if (motivo) throw new RegraViolada(`Comunicação não registrada: ${motivo}.`);

  const [c] = await tx
    .insert(epi_comunicacao_titular)
    .values({
      registro_id: registro.id,
      servidor_id: registro.servidor_id,
      tipo: d.tipo,
      observacao: observacao || null,
      criado_por: usuario.id,
    })
    .returning();

  // RN-19 na escrita: o servidor por `#id`
  const frase =
    `Servidor #${registro.servidor_id} ${FRASE_NEUTRA[d.tipo]}: ` +
    `${registro.quantidade} × '${registro.nome_epi_snapshot}' da entrega nº ${registro.id} ` +
    `de ${datas_br.numerica(registro.data_evento)}`;
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: c!.id,
    tipo_evento: EPI_COMUNICACAO_REGISTRADA,
    descricao: `Comunicação nº ${c!.id}: ${frase}`,
    campo: "tipo",
    valor_novo: d.tipo,
    comentario: observacao || null,
    usuario,
  });

  const pendencia = await pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA,
    chave: chave_da_pendencia(c!.id),
    descricao:
      `${frase}. A comunicação não mexe na ficha nem no estoque: devolução, ` +
      "substituição ou orientação são atos do almoxarifado.",
    entidade: ENTIDADE,
    entidade_id: c!.id,
    usuario,
  });
  // `abrir` cai no `usuario.id` de quem chamou — aqui o PRÓPRIO titular. A
  // tarefa é do setor, e por isso nasce sem responsável
  await tx.update(tabela_pendencia).set({ responsavel_id: null }).where(eq(tabela_pendencia.id, pendencia.id));
  return c!;
}

// =====================================================================
// Retirar — o titular na janela de 24 h; a equipe a qualquer tempo
// =====================================================================
/** Esta conta pode retirar esta comunicação agora? (a tela pergunta o mesmo) */
export function pode_retirar(usuario: UsuarioAtual, c: EpiComunicacaoTitular, agora: Date = new Date()): boolean {
  if (!aberta(c)) return false;
  if (usuario.pode("epi.entregar")) return true;
  return usuario.servidor_id !== null && usuario.servidor_id === c.servidor_id && na_janela_do_titular(c, agora);
}

export async function retirar(
  tx: Executor,
  usuario: UsuarioAtual,
  c: EpiComunicacaoTitular,
  agora: Date = new Date(),
): Promise<EpiComunicacaoTitular> {
  usuario.exigir("epi.ver");
  const propria = usuario.servidor_id !== null && usuario.servidor_id === c.servidor_id;
  const equipe = usuario.pode("epi.entregar");
  if (!propria && !equipe) {
    throw new PermissaoNegada("epi.entregar", "Só o titular ou o almoxarifado retiram esta comunicação.");
  }
  if (equipe && !propria) await epi_ficha.exigir_leitura_da_ficha(tx, usuario, c.servidor_id);
  if (!aberta(c)) throw new RegraViolada(`A comunicação nº ${c.id} já foi retirada ou tratada.`);
  if (!equipe && !na_janela_do_titular(c, agora)) {
    throw new RegraViolada(
      `A comunicação nº ${c.id} passou das ${JANELA_RETIRADA_COMUNICACAO_HORAS} horas em que você ` +
        "podia retirá-la. Agora só o almoxarifado a altera: procure o setor.",
    );
  }
  const [linha] = await tx
    .update(epi_comunicacao_titular)
    .set({ retirada_em: agora_utc(), retirada_por: usuario.id })
    .where(
      and(
        eq(epi_comunicacao_titular.id, c.id),
        isNull(epi_comunicacao_titular.retirada_em),
        isNull(epi_comunicacao_titular.tratada_em),
      ),
    )
    .returning();
  if (!linha) throw new RegraViolada(`A comunicação nº ${c.id} já foi retirada ou tratada.`);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: c.id,
    tipo_evento: EPI_COMUNICACAO_RETIRADA,
    descricao:
      `Comunicação nº ${c.id} (entrega nº ${c.registro_id}, servidor #${c.servidor_id}) retirada ` +
      (propria ? "pelo titular" : "pelo almoxarifado"),
    usuario,
  });
  await _fechar_pendencia(tx, c.id, usuario);
  return linha;
}

// =====================================================================
// Tratar — a equipe diz o que fez
// =====================================================================
export async function tratar(
  tx: Executor,
  usuario: UsuarioAtual,
  c: EpiComunicacaoTitular,
  tratamento: string,
): Promise<EpiComunicacaoTitular> {
  usuario.exigir("epi.entregar");
  await epi_ficha.exigir_leitura_da_ficha(tx, usuario, c.servidor_id);
  const texto = _texto_curto(tratamento, "o que foi feito");
  if (!texto) throw new RegraViolada("Diga, em poucas palavras, o que foi feito com a comunicação.");
  if (!aberta(c)) throw new RegraViolada(`A comunicação nº ${c.id} já foi retirada ou tratada.`);
  const [linha] = await tx
    .update(epi_comunicacao_titular)
    .set({ tratada_em: agora_utc(), tratada_por: usuario.id, tratamento: texto })
    .where(
      and(
        eq(epi_comunicacao_titular.id, c.id),
        isNull(epi_comunicacao_titular.retirada_em),
        isNull(epi_comunicacao_titular.tratada_em),
      ),
    )
    .returning();
  if (!linha) throw new RegraViolada(`A comunicação nº ${c.id} já foi retirada ou tratada.`);
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: c.id,
    tipo_evento: EPI_COMUNICACAO_TRATADA,
    descricao: `Comunicação nº ${c.id} (entrega nº ${c.registro_id}, servidor #${c.servidor_id}) tratada: ${texto}`,
    comentario: texto,
    usuario,
  });
  await _fechar_pendencia(tx, c.id, usuario);
  return linha;
}

/**
 * A devolução registrada pela equipe TRATA a comunicação aberta da mesma
 * entrega (decisão do usuário, 22/10/2026): o equipamento voltou, e a tarefa
 * do almoxarifado está cumprida. Mesmo evento `EPI_COMUNICACAO_TRATADA` (o
 * rótulo gravado não muda); a origem vai em `campo`/`valor_novo`
 * (`origem` = `DEVOLUCAO`) e o tratamento cita o número da devolução. Quem
 * chama (`epi_ficha.registrar_devolucao`) já conferiu `epi.entregar` e o
 * alcance da ficha. Sem comunicação aberta: nada a fazer, devolve `null`.
 */
export async function tratar_pela_devolucao(
  tx: Executor,
  usuario: UsuarioAtual,
  registro_id: number,
  devolucao_id: number,
): Promise<EpiComunicacaoTitular | null> {
  const c = await aberta_do_registro(tx, registro_id);
  if (!c) return null;
  const texto = `Tratada pela devolução registrada na ficha (registro nº ${devolucao_id}).`;
  const [linha] = await tx
    .update(epi_comunicacao_titular)
    .set({ tratada_em: agora_utc(), tratada_por: usuario.id, tratamento: texto })
    .where(
      and(
        eq(epi_comunicacao_titular.id, c.id),
        isNull(epi_comunicacao_titular.retirada_em),
        isNull(epi_comunicacao_titular.tratada_em),
      ),
    )
    .returning();
  if (!linha) return null;
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: c.id,
    tipo_evento: EPI_COMUNICACAO_TRATADA,
    descricao:
      `Comunicação nº ${c.id} (entrega nº ${c.registro_id}, servidor #${c.servidor_id}) ` +
      `tratada pela devolução nº ${devolucao_id}`,
    campo: "origem",
    valor_novo: "DEVOLUCAO",
    comentario: texto,
    usuario,
  });
  await _fechar_pendencia(tx, c.id, usuario);
  return linha;
}

async function _fechar_pendencia(tx: Executor, comunicacao_id: number, usuario: UsuarioAtual): Promise<void> {
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(eq(tabela_pendencia.chave, chave_da_pendencia(comunicacao_id)));
  if (p && !p.concluida) await pendencias.concluir(tx, p, usuario);
}

// =====================================================================
// A fila da equipe
// =====================================================================
/**
 * Quantas comunicações estão abertas no alcance de `epi.entregar` desta conta
 * (para o painel — fatia G). Sem `epi.entregar` de equipe: zero. O recorte por
 * campus é o da lotação de hoje, como `epi_ficha.ficha_no_alcance`; sem lotação
 * conhecida, a permissão basta.
 */
export async function contar_abertas(tx: Executor, usuario: UsuarioAtual): Promise<number> {
  const alcance = usuario.alcance_da_equipe("epi.entregar");
  if (!alcance.total && !alcance.unidade && !alcance.campi.length) return 0;
  const linhas = await tx
    .select({ id: epi_comunicacao_titular.id, campus_id: unidade_uorg.campus_id })
    .from(epi_comunicacao_titular)
    .innerJoin(tabela_servidor, eq(tabela_servidor.id, epi_comunicacao_titular.servidor_id))
    .leftJoin(unidade_uorg, eq(unidade_uorg.id, tabela_servidor.unidade_uorg_id))
    .where(and(isNull(epi_comunicacao_titular.retirada_em), isNull(epi_comunicacao_titular.tratada_em)));
  if (alcance.total || alcance.unidade) return linhas.length;
  return linhas.filter((l) => l.campus_id === null || alcance.campi.includes(l.campus_id)).length;
}

// =====================================================================
// O que a ficha mostra
// =====================================================================
export interface ComunicacaoNaTela {
  c: EpiComunicacaoTitular;
  rotulo: string;
  aberta: boolean;
  retirada_ate: Date;
  pode_retirar: boolean;
  pode_tratar: boolean;
  /** o pedido de troca já preenchido, para quem pode pedir; `null` se não cabe */
  link_troca: string | null;
}

/**
 * `{registro_id: [comunicações]}` da ficha, já com o que esta conta pode fazer
 * com cada uma. Quem chama já conferiu a leitura da ficha.
 */
export async function para_a_ficha(
  tx: Executor,
  usuario: UsuarioAtual,
  servidor_id: number,
  agora: Date = new Date(),
): Promise<Record<number, ComunicacaoNaTela[]>> {
  const lista = await do_servidor(tx, servidor_id);
  if (!lista.length) return {};
  const ids = [...new Set(lista.map((c) => c.registro_id))];
  const registros = new Map(
    (await tx.select().from(epi_ficha_registro).where(inArray(epi_ficha_registro.id, ids))).map((r) => [r.id, r]),
  );
  const propria = usuario.servidor_id !== null && usuario.servidor_id === servidor_id;
  const resultado: Record<number, ComunicacaoNaTela[]> = {};
  for (const c of lista) {
    const registro = registros.get(c.registro_id) ?? (await _registro(tx, c.registro_id));
    const esta_aberta = aberta(c);
    (resultado[c.registro_id] ??= []).push({
      c,
      rotulo: ROTULO_COMUNICACAO_TITULAR[c.tipo as TipoComunicacaoTitular] ?? c.tipo,
      aberta: esta_aberta,
      retirada_ate: retirada_ate(c),
      pode_retirar: pode_retirar(usuario, c, agora),
      pode_tratar: esta_aberta && usuario.pode("epi.entregar"),
      link_troca:
        esta_aberta && propria && c.requisicao_id === null && usuario.pode("epi.requisitar")
          ? link_pedido_de_troca(c, registro)
          : null,
    });
  }
  return resultado;
}

/**
 * Liga a comunicação ao pedido de troca aberto a partir dela. Só liga se a
 * comunicação for do MESMO servidor do pedido, estiver aberta (nem retirada nem
 * tratada) e ainda sem pedido; caso contrário recusa com `RegraViolada` — o
 * pedido em si continua valendo, quem chama decide se ignora a recusa.
 */
export async function vincular_requisicao(
  tx: Executor,
  comunicacao_id: number,
  requisicao: { id: number; servidor_id: number },
): Promise<EpiComunicacaoTitular> {
  const [linha] = await tx
    .update(epi_comunicacao_titular)
    .set({ requisicao_id: requisicao.id })
    .where(
      and(
        eq(epi_comunicacao_titular.id, comunicacao_id),
        eq(epi_comunicacao_titular.servidor_id, requisicao.servidor_id),
        isNull(epi_comunicacao_titular.requisicao_id),
        isNull(epi_comunicacao_titular.retirada_em),
        isNull(epi_comunicacao_titular.tratada_em),
      ),
    )
    .returning();
  if (!linha) {
    throw new RegraViolada(
      "A comunicação não pôde ser ligada a este pedido: ela é de outro servidor, " +
        "já foi retirada ou tratada, ou já tem pedido de troca.",
    );
  }
  return linha;
}
