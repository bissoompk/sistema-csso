/**
 * A ficha de EPI: entrega, congelamento, comprovante e estorno.
 * Porte de `app/servicos/epi_ficha.py`.
 *
 * Aqui ficam as **regras**; o contexto e a impressão do comprovante moram em
 * `comprovante_epi.ts`, e o saldo do lote em `epi_estoque.ts`.
 *
 * Três coisas decidem se a ficha vale como prova:
 *
 * 1. **O que se congela é o que valia no ato** (RN-15): `montar_contexto` lê
 *    `contexto_congelado`, nunca o catálogo de hoje.
 * 2. **CA vencido não se entrega (RN-25)** — e o CA que vale é o do LOTE.
 * 3. **A ficha é append-only, por trigger (RN-31)**: correção é `ESTORNO`.
 *
 * E uma quarta, da decisão 8: entre a entrega e o comprovante assinado há uma
 * janela em que a ficha tem o registro e não tem a prova — e ela abre pendência
 * (`COMPROVANTE_EPI_PENDENTE`), aparece etiquetada e é contada na tela.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  adicional_vigencia,
  agora_utc,
  anexo as tabela_anexo,
  cargo as tabela_cargo,
  epi_categoria,
  epi_ficha_registro,
  epi_entrada_estoque,
  historico_evento,
  pendencia as tabela_pendencia,
  servidor as tabela_servidor,
  unidade_uorg,
} from "../db/esquema/index.js";
import { lotacao_em } from "./servidores.js";
import * as datas_br from "./datas_br.js";
import * as anexos from "./anexos.js";
import type { Anexo } from "./anexos.js";
import * as auditoria from "./auditoria.js";
import * as comprovante_epi from "./comprovante_epi.js";
import { ContextoComprovante } from "./comprovante_epi.js";
import * as epi_estoque from "./epi_estoque.js";
import * as pendencias from "./pendencias.js";
import * as textos from "./textos.js";
import { setor_emissor_vigente } from "./parecer.js";
import { declarar_porta } from "./anexo_acesso.js";
import type { UsuarioAtual } from "./rbac.js";
import { RegraViolada } from "../nucleo/erros.js";
import type { epi_item, epi_motivo_recusa } from "../db/esquema/index.js";

export type EpiFichaRegistro = typeof epi_ficha_registro.$inferSelect;
export type Servidor = typeof tabela_servidor.$inferSelect;
export type EpiItem = typeof epi_item.$inferSelect;
export type EpiEntradaEstoque = typeof epi_entrada_estoque.$inferSelect;
export type EpiMotivoRecusa = typeof epi_motivo_recusa.$inferSelect;

export const EPI_ENTREGUE = "EPI_ENTREGUE";
export const EPI_ESTORNADO = "EPI_ESTORNADO";
export const EPI_DEVOLVIDO = "EPI_DEVOLVIDO";
export const EPI_COMPROVANTE_ANEXADO = "EPI_COMPROVANTE_ANEXADO";
export const EPI_COMPROVANTE_IMPRESSO = "EPI_COMPROVANTE_IMPRESSO";
export const EPI_COMPROVANTE_DIVERGENTE = "EPI_COMPROVANTE_DIVERGENTE";
export const EPI_MAXIMO_EXCEDIDO = "EPI_MAXIMO_EXCEDIDO";
export const EPI_ENTREGA_RECUSADA = "EPI_ENTREGA_RECUSADA";

export const ENTIDADE = "epi_ficha_registro";
export const CATEGORIA_ANEXO = "FICHA_EPI";
export const TIPO_PENDENCIA_COMPROVANTE = "COMPROVANTE_EPI_PENDENTE";
export const TIPO_PENDENCIA_REAVALIACAO = "REAVALIAR_ADICIONAL_POR_EPI";
export const TIPO_PENDENCIA_TROCA = "TROCA_EPI_DEVIDA";

/**
 * O que impede esta entrega, tudo de uma vez. Lista em vez de primeiro-erro:
 * quem está no balcão com a pessoa esperando precisa saber tudo o que falta
 * numa passada.
 */
export class EntregaBloqueada extends RegraViolada {
  constructor(public motivos: string[]) {
    super("Entrega bloqueada: " + motivos.join("; "));
  }
}

export class Validacao {
  bloqueios: string[] = [];
  avisos: string[] = [];
  get ok(): boolean {
    return this.bloqueios.length === 0;
  }
}

// =====================================================================
// Leitura da ficha
// =====================================================================
/**
 * Devolve `true` quando a leitura é da ficha de OUTRA pessoa.
 *
 * Ler a própria não exige `epi.ficha` (LGPD art. 18, II); ler a de outro exige
 * a permissão e entra em `acesso_dado_sensivel` (RN-23). Mora no serviço porque
 * o download do comprovante (`GET /anexos/{id}`) faz a mesma pergunta.
 */
export function exigir_leitura_da_ficha(usuario: UsuarioAtual, servidor_id: number | null | undefined): boolean {
  const propria = usuario.servidor_id !== null && usuario.servidor_id === servidor_id;
  if (propria) {
    usuario.exigir("epi.ver");
    return false;
  }
  usuario.exigir("epi.ficha");
  return true;
}

// a regra do dono do anexo `epi_ficha_registro` (ver `anexo_acesso.ts`)
declarar_porta("exigir_leitura_da_ficha", (usuario, servidor_id) => {
  exigir_leitura_da_ficha(usuario, servidor_id);
});

/**
 * Uma linha da ficha com o que a tela precisa saber, calculado agora.
 * Vencimento e troca devida nunca são gravados: são estado.
 */
export class LinhaDaFicha {
  constructor(
    public registro: EpiFichaRegistro,
    public comprovante: Anexo | null,
    public estornado_por: EpiFichaRegistro | null,
    public estorna: EpiFichaRegistro | null,
  ) {}

  get estornado(): boolean {
    return this.estornado_por !== null;
  }

  /** O nome de quem entregou, como estava no dia — vem do congelado. */
  get entregue_por_nome(): string {
    const congelado = (this.registro.contexto_congelado ?? {}) as Record<string, unknown>;
    return String(congelado["entregue_por"] || `usuário ${this.registro.entregue_por}`);
  }

  /** A janela da decisão 8. Estorno não pede comprovante. */
  get sem_comprovante(): boolean {
    return this.registro.tipo === "ENTREGA" && !this.estornado && this.comprovante === null;
  }

  ca_vencido_em(quando: string): boolean {
    const validade = this.registro.validade_ca_snapshot;
    return validade !== null && validade < quando;
  }

  troca_vencida_em(quando: string): boolean {
    const troca = this.registro.previsao_troca;
    return troca !== null && troca < quando && this.registro.tipo === "ENTREGA" && !this.estornado;
  }
}

export async function registros_de(tx: Executor, servidor_id: number): Promise<EpiFichaRegistro[]> {
  return tx
    .select()
    .from(epi_ficha_registro)
    .where(eq(epi_ficha_registro.servidor_id, servidor_id))
    .orderBy(desc(epi_ficha_registro.data_evento), desc(epi_ficha_registro.id));
}

/**
 * Tudo o que o servidor recebeu, do mais recente para o mais antigo. O estorno
 * e a linha estornada aparecem os DOIS.
 */
export async function linha_do_tempo(tx: Executor, servidor_id: number): Promise<LinhaDaFicha[]> {
  const registros = await registros_de(tx, servidor_id);
  const por_id = new Map(registros.map((r) => [r.id, r]));
  const estorno_de = new Map<number, EpiFichaRegistro>();
  for (const r of registros) {
    if (r.tipo === "ESTORNO" && r.registro_estornado_id !== null) estorno_de.set(r.registro_estornado_id, r);
  }
  const anexos_por_id = await _comprovantes_de(
    tx,
    registros.map((r) => r.id),
  );
  return registros.map(
    (r) =>
      new LinhaDaFicha(
        r,
        (r.comprovante_anexo_id !== null ? anexos_por_id.get(r.comprovante_anexo_id) : undefined) ?? null,
        estorno_de.get(r.id) ?? null,
        por_id.get(r.registro_estornado_id ?? -1) ?? null,
      ),
  );
}

/** Uma consulta para a ficha inteira, e não uma por linha. */
async function _comprovantes_de(tx: Executor, registro_ids: number[]): Promise<Map<number, Anexo>> {
  if (!registro_ids.length) return new Map();
  const linhas = await tx
    .select()
    .from(tabela_anexo)
    .where(
      and(
        eq(tabela_anexo.entidade, ENTIDADE),
        inArray(tabela_anexo.entidade_id, registro_ids),
        eq(tabela_anexo.ativo, true),
      ),
    );
  return new Map(linhas.map((a) => [a.id, a]));
}

/** `[servidor, quantas linhas, quantas sem comprovante]` — a lista de `/epis/fichas`. */
export async function servidores_com_ficha(tx: Executor): Promise<[Servidor, number, number][]> {
  const registros = await tx.select().from(epi_ficha_registro).orderBy(asc(epi_ficha_registro.servidor_id));
  const estornados = new Set(registros.filter((r) => r.tipo === "ESTORNO").map((r) => r.registro_estornado_id));
  const resumo = new Map<number, [number, number]>();
  for (const r of registros) {
    let atual = resumo.get(r.servidor_id);
    if (!atual) {
      atual = [0, 0];
      resumo.set(r.servidor_id, atual);
    }
    atual[0] += 1;
    if (r.tipo === "ENTREGA" && !estornados.has(r.id) && r.comprovante_anexo_id === null) atual[1] += 1;
  }
  if (!resumo.size) return [];
  const servidores = await tx
    .select()
    .from(tabela_servidor)
    .where(inArray(tabela_servidor.id, [...resumo.keys()]));
  const por_id = new Map(servidores.map((s) => [s.id, s]));
  const saida: [Servidor, number, number][] = [];
  for (const [servidor_id, [total, pendentes]] of resumo) {
    const servidor = por_id.get(servidor_id);
    if (servidor) saida.push([servidor, total, pendentes]);
  }
  // `sorted(key=nome)` do Python: ordem por ponto de código, estável
  return saida.sort((a, b) => (a[0].nome < b[0].nome ? -1 : a[0].nome > b[0].nome ? 1 : 0));
}

// =====================================================================
// §7 — o que o EPI publica para o parecer, e só isso
// =====================================================================
/**
 * Uma entrega lida NA DATA DA AVALIAÇÃO, e nunca na de hoje. Nada aqui é
 * gravado: é estado, calculado dos snapshots congelados da linha.
 */
export class RegistroFicha {
  constructor(
    public readonly registro: EpiFichaRegistro,
    public readonly quando: string,
    public readonly devolvida_em: string | null = null,
  ) {
    Object.freeze(this);
  }

  get epi(): string {
    return this.registro.nome_epi_snapshot || "";
  }
  get numero_ca(): string {
    return this.registro.numero_ca_snapshot || "";
  }
  get validade_ca(): string | null {
    return this.registro.validade_ca_snapshot;
  }
  get previsao_troca(): string | null {
    return this.registro.previsao_troca;
  }
  get entregue_em(): string {
    return this.registro.data_evento;
  }
  get quantidade(): number {
    return this.registro.quantidade;
  }
  /** NR-6: sem CA vigente o objeto não é EPI, é só um objeto. */
  get ca_vencido(): boolean {
    return this.validade_ca !== null && this.validade_ca < this.quando;
  }
  /** "Não sei" não é "está válido" — a mesma leitura da RN-25. */
  get sem_ca(): boolean {
    return !this.numero_ca || this.validade_ca === null;
  }
  /** RN-32: passada a vida útil, ninguém sabe o que a pessoa está usando. */
  get troca_vencida(): boolean {
    return this.previsao_troca !== null && this.previsao_troca < this.quando;
  }
  get devolvido(): boolean {
    return this.devolvida_em !== null;
  }
  /** Por que esta linha NÃO sustenta alegação de neutralização. */
  get ressalvas(): string[] {
    const motivos: string[] = [];
    if (this.ca_vencido) {
      motivos.push(
        `o CA ${this.numero_ca || "—"} venceu em ${datas_br.numerica(this.validade_ca!)}, antes de ` +
          `${datas_br.numerica(this.quando)}`,
      );
    } else if (this.sem_ca) {
      motivos.push(
        "a entrega não registrou CA com validade — sem Certificado de " +
          "Aprovação vigente o equipamento não é EPI pela NR-6",
      );
    }
    if (this.troca_vencida) {
      motivos.push(
        `a troca prevista era ${datas_br.numerica(this.previsao_troca!)} e já estava vencida ` +
          "(RN-32): a vida útil acabou antes da avaliação",
      );
    }
    if (this.devolvido) {
      motivos.push(
        `o equipamento foi devolvido em ${datas_br.numerica(this.devolvida_em!)} — na data da avaliação ` +
          "ele não estava com a pessoa",
      );
    }
    return motivos;
  }
  /** Sustenta = não há ressalva. Nunca "sustenta = foi entregue". */
  get sustenta_neutralizacao(): boolean {
    return this.ressalvas.length === 0;
  }
  /** A forma que entra no `contexto_congelado` do parecer (§7.2). */
  congelar(): Record<string, unknown> {
    return {
      registro: this.registro.id,
      epi: this.epi,
      quantidade: this.quantidade,
      entregue_em: this.entregue_em,
      ca: this.numero_ca || null,
      validade_ca: this.validade_ca,
      previsao_troca: this.previsao_troca,
      devolvida_em: this.devolvida_em,
      referencia: this.quando,
      ca_vencido: this.ca_vencido,
      troca_vencida: this.troca_vencida,
      sustenta_neutralizacao: this.sustenta_neutralizacao,
    };
  }
}

/**
 * O que o servidor tinha recebido até aquela data, com CA e troca prevista.
 * Consulta de leitura; quem decide é o subscritor do laudo.
 */
export async function entregas_ate(
  tx: Executor,
  servidor_id: number,
  quando: string,
  posto_id: number | null = null,
): Promise<RegistroFicha[]> {
  // Estorno declara que aquela entrega NÃO VALE, sem data de início: a
  // estornada sai mesmo quando o estorno é posterior a `quando`.
  const todas = await tx.select().from(epi_ficha_registro).where(eq(epi_ficha_registro.servidor_id, servidor_id));
  const registros = todas.filter((r) => r.data_evento <= quando);
  const estornadas = new Set(todas.filter((r) => r.tipo === "ESTORNO").map((r) => r.registro_estornado_id));

  const saida: RegistroFicha[] = [];
  for (const registro of registros) {
    if (registro.tipo !== "ENTREGA" || estornadas.has(registro.id)) continue;
    if (posto_id !== null && !(await _estava_no_posto(tx, servidor_id, registro.data_evento, posto_id))) continue;
    saida.push(new RegistroFicha(registro, quando, await _devolvida_ate(tx, registro, quando)));
  }
  // sorted(key=(entregue_em, id), reverse=True)
  return saida.sort((a, b) =>
    a.entregue_em !== b.entregue_em ? (a.entregue_em < b.entregue_em ? 1 : -1) : b.registro.id - a.registro.id,
  );
}

/** O filtro por posto vai pela LOTAÇÃO da data, não pelo texto do snapshot. */
async function _estava_no_posto(tx: Executor, servidor_id: number, quando: string, posto_id: number): Promise<boolean> {
  const lotacao = await lotacao_em(tx, servidor_id, quando);
  return !!lotacao && lotacao.postos.some((p) => p.id === posto_id);
}

/**
 * A data em que a devolução completou a entrega — se foi até `quando`.
 * Devolução parcial não conta.
 */
async function _devolvida_ate(tx: Executor, registro: EpiFichaRegistro, quando: string): Promise<string | null> {
  const devolucoes = (await devolucoes_de(tx, registro)).filter((d) => d.data_evento <= quando);
  if (devolucoes.reduce((s, d) => s + d.quantidade, 0) < registro.quantidade) return null;
  return devolucoes.map((d) => d.data_evento).reduce((a, b) => (b > a ? b : a));
}

export async function _ja_estornado(tx: Executor, registro: EpiFichaRegistro): Promise<EpiFichaRegistro | null> {
  const [achado] = await tx
    .select()
    .from(epi_ficha_registro)
    .where(eq(epi_ficha_registro.registro_estornado_id, registro.id));
  return achado ?? null;
}

/**
 * As devoluções que apontam para esta entrega. O vínculo mora em
 * `contexto_congelado.registro_devolvido`; a busca é em código sobre as linhas
 * do mesmo servidor e item.
 */
export async function devolucoes_de(tx: Executor, registro: EpiFichaRegistro): Promise<EpiFichaRegistro[]> {
  const linhas = await tx
    .select()
    .from(epi_ficha_registro)
    .where(
      and(
        eq(epi_ficha_registro.servidor_id, registro.servidor_id),
        eq(epi_ficha_registro.epi_item_id, registro.epi_item_id),
        eq(epi_ficha_registro.tipo, "DEVOLUCAO"),
      ),
    )
    .orderBy(asc(epi_ficha_registro.id));
  return linhas.filter(
    (r) => ((r.contexto_congelado ?? {}) as Record<string, unknown>)["registro_devolvido"] === registro.id,
  );
}

// =====================================================================
// RN-26 — a quantidade máxima conta o que a FICHA registra
// =====================================================================
/** Quanto deste item o servidor já recebeu dentro da janela do catálogo. */
export async function entregue_na_janela(
  tx: Executor,
  servidor_id: number,
  item: { id: number; quantidade_maxima: number | null; periodo_maximo_meses: number | null },
  ate: string,
): Promise<number> {
  if (item.quantidade_maxima === null || item.periodo_maximo_meses === null) return 0;
  const desde = datas_br.somar_meses(ate, -item.periodo_maximo_meses);
  const registros = await tx
    .select()
    .from(epi_ficha_registro)
    .where(
      and(
        eq(epi_ficha_registro.servidor_id, servidor_id),
        eq(epi_ficha_registro.epi_item_id, item.id),
        gte(epi_ficha_registro.data_evento, desde),
        lte(epi_ficha_registro.data_evento, ate),
      ),
    );
  const estornados = new Set(registros.filter((r) => r.tipo === "ESTORNO").map((r) => r.registro_estornado_id));
  return registros
    .filter((r) => r.tipo === "ENTREGA" && !estornados.has(r.id))
    .reduce((s, r) => s + r.quantidade, 0);
}

/** Quanto deste item o servidor recebeu e ainda não devolveu. */
export async function em_poder_de(tx: Executor, servidor_id: number, epi_item_id: number): Promise<number> {
  const registros = await tx
    .select()
    .from(epi_ficha_registro)
    .where(and(eq(epi_ficha_registro.servidor_id, servidor_id), eq(epi_ficha_registro.epi_item_id, epi_item_id)));
  const estornados = new Set(registros.filter((r) => r.tipo === "ESTORNO").map((r) => r.registro_estornado_id));
  const entregue = registros
    .filter((r) => r.tipo === "ENTREGA" && !estornados.has(r.id))
    .reduce((s, r) => s + r.quantidade, 0);
  const devolvido = registros.filter((r) => r.tipo === "DEVOLUCAO").reduce((s, r) => s + r.quantidade, 0);
  return entregue - devolvido;
}

// =====================================================================
// A forma canônica: o que amarra a linha à cadeia de hash (§6.2)
// =====================================================================
/** O conteúdo da linha, na forma que vai para `historico_evento.valor_novo`. */
export function forma_canonica(registro: EpiFichaRegistro): Record<string, unknown> {
  return {
    registro: registro.id,
    tipo: registro.tipo,
    servidor_id: registro.servidor_id,
    siape: registro.siape_snapshot,
    servidor: registro.nome_servidor_snapshot,
    epi_item_id: registro.epi_item_id,
    epi: registro.nome_epi_snapshot,
    categoria: registro.categoria_snapshot,
    quantidade: registro.quantidade,
    tamanho: registro.tamanho_snapshot,
    ca: registro.numero_ca_snapshot,
    validade_ca: registro.validade_ca_snapshot,
    lote: registro.lote_snapshot,
    entrada_id: registro.entrada_id,
    data_evento: registro.data_evento,
    previsao_troca: registro.previsao_troca,
    entregue_por: registro.entregue_por,
    estorna: registro.registro_estornado_id,
    motivo: registro.motivo,
  };
}

// =====================================================================
// Validação da entrega
// =====================================================================
export interface DadosValidacao {
  servidor: Servidor;
  item: EpiItem;
  entrada: EpiEntradaEstoque | null;
  quantidade: number;
  quando: string;
  justificativa_excecao?: string;
}

/**
 * Tudo o que precisa ser verdade para a entrega sair. Roda também fora da
 * entrega: a tela usa esta função para dizer o que trava ANTES do clique.
 */
export async function validar(tx: Executor, d: DadosValidacao): Promise<Validacao> {
  const { servidor, item, entrada, quantidade, quando } = d;
  const justificativa_excecao = d.justificativa_excecao ?? "";
  const v = new Validacao();

  // Decisão 7: EPI é só para servidor com SIAPE.
  if (!/^\d+$/.test((servidor.siape || "").trim()) || (servidor.siape ?? "").length !== 7) {
    v.bloqueios.push(
      `${servidor.nome} não tem matrícula SIAPE válida — a ficha de EPI ` +
        "identifica a pessoa pelo SIAPE congelado, e sem ele não há o que " +
        "congelar",
    );
  }
  if (servidor.situacao !== "ATIVO") {
    v.avisos.push(
      `${servidor.nome} está com situação ${servidor.situacao.toLowerCase()} no ` +
        "cadastro: confira se a entrega se justifica",
    );
  }
  if (!item.ativo) {
    v.avisos.push(
      `'${item.nome}' está inativo no catálogo — o lote na prateleira ` +
        "continua válido, mas o item não deveria estar sendo requisitado",
    );
  }
  if (quantidade <= 0) v.bloqueios.push("a quantidade tem de ser maior que zero");

  // RN-25, nos dois caminhos: com lote, manda o CA do lote; sem lote, o do
  // catálogo — e "não sei" continua não sendo "está válido".
  if (entrada) {
    const impedimento = epi_estoque.impedimento_do_lote(entrada, item, quando);
    if (impedimento) v.bloqueios.push(`EPI com CA vencido não se entrega — ${impedimento}`);
    // RN-24: saldo nunca fica negativo
    const saldo = await epi_estoque.disponivel(tx, entrada.id);
    if (quantidade > saldo) v.bloqueios.push(`o lote tem ${saldo} disponível(is) e a entrega pede ${quantidade}`);
    if (entrada.epi_item_id !== item.id) v.bloqueios.push("o lote escolhido é de outro item do catálogo");
  } else if (item.exige_ca) {
    if (!item.numero_ca) {
      v.bloqueios.push(`'${item.nome}' exige CA e não tem número de CA no catálogo`);
    } else if (item.validade_ca === null) {
      v.bloqueios.push(
        `'${item.nome}' exige CA e não tem validade registrada — ` + "“não sei” não é “está válido”",
      );
    } else if (item.validade_ca < quando) {
      v.bloqueios.push(
        `EPI com CA vencido não se entrega — o CA ${item.numero_ca} do ` +
          `catálogo venceu em ${datas_br.numerica(item.validade_ca)}`,
      );
    }
    v.avisos.push(
      "entrega sem lote: o CA conferido foi o do catálogo, e não o da " +
        "etiqueta do equipamento. Confira a etiqueta antes de entregar",
    );
  }

  // RN-26: máxima com janela, contada na ficha. Bloqueia até que alguém
  // escreva a justificativa e assine com o próprio usuário.
  if (item.quantidade_maxima !== null) {
    const ja = await entregue_na_janela(tx, servidor.id, item, quando);
    if (ja + quantidade > item.quantidade_maxima) {
      const recado =
        `${servidor.nome} já recebeu ${ja} de '${item.nome}' nos últimos ` +
        `${item.periodo_maximo_meses} meses, e o máximo é ${item.quantidade_maxima}`;
      if (justificativa_excecao.trim()) {
        v.avisos.push(`${recado} — exceção autorizada e registrada`);
      } else {
        v.bloqueios.push(
          `${recado}. Para entregar assim mesmo, escreva a justificativa ` +
            "da exceção: ela fica registrada com o seu nome",
        );
      }
    }
  }
  return v;
}

// =====================================================================
// Contexto congelado
// =====================================================================
/** Onde a pessoa estava NA DATA DA ENTREGA — não onde ela está hoje. */
export async function _posto_e_unidade(tx: Executor, servidor: Servidor, quando: string): Promise<[string, string]> {
  const lotacao = await lotacao_em(tx, servidor.id, quando);
  let unidade: { nome_extenso: string } | null = lotacao?.unidade ?? null;
  if (!unidade && servidor.unidade_uorg_id !== null) {
    const [u] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.id, servidor.unidade_uorg_id));
    unidade = u ?? null;
  }
  const postos = lotacao ? lotacao.postos : [];
  return [postos.map((p) => p.nome).join(" / "), unidade ? unidade.nome_extenso : ""];
}

export interface DadosContextoEntrega {
  servidor: Servidor;
  item: EpiItem;
  entrada: EpiEntradaEstoque | null;
  quantidade: number;
  tamanho: string;
  quando: string;
  tipo: string;
  entregue_por: string;
  motivo: string;
}

/**
 * O contexto do catálogo de HOJE — montado uma única vez, na entrega. O CA que
 * entra é o do lote quando há lote: é ele que a RN-25 conferiu.
 */
export async function montar_contexto_para_entregar(tx: Executor, d: DadosContextoEntrega): Promise<ContextoComprovante> {
  const { servidor, item, entrada, quantidade, tamanho, quando, tipo, entregue_por, motivo } = d;
  const [posto, unidade] = await _posto_e_unidade(tx, servidor, quando);
  const setor = await setor_emissor_vigente(tx, quando);
  const [categoria] = await tx.select().from(epi_categoria).where(eq(epi_categoria.id, item.categoria_id));
  const cargo =
    servidor.cargo_id !== null
      ? ((await tx.select().from(tabela_cargo).where(eq(tabela_cargo.id, servidor.cargo_id)))[0] ?? null)
      : null;
  const do_lote = entrada !== null;
  return new ContextoComprovante({
    // a linha ainda não existe; `montar_contexto` põe o id de volta ao ler
    registro_id: 0,
    tipo,
    data_evento: quando,
    quantidade,
    unidade_medida: item.unidade_medida,
    servidor_nome: servidor.nome,
    siape: servidor.siape,
    cargo: cargo ? cargo.nome : "",
    funcao: servidor.funcao || "",
    unidade,
    posto,
    epi_nome: item.nome,
    categoria: categoria!.nome,
    fabricante: item.fabricante || "",
    modelo: [item.marca, item.modelo].filter((p) => p).join(" "),
    normas: item.normas || "",
    numero_ca: (do_lote ? entrada!.numero_ca : item.numero_ca) || "",
    validade_ca: do_lote ? entrada!.validade_ca : item.validade_ca,
    lote: do_lote ? entrada!.lote || "" : "",
    tamanho: tamanho || (do_lote ? entrada!.tamanho || "" : ""),
    previsao_troca: item.vida_util_meses ? datas_br.somar_meses(quando, item.vida_util_meses) : null,
    pregao: do_lote ? entrada!.pregao || "" : "",
    item_pregao: do_lote ? entrada!.item_pregao || "" : "",
    empenho: do_lote ? entrada!.empenho || "" : "",
    nota_fiscal: do_lote ? entrada!.nota_fiscal || "" : "",
    fornecedor: do_lote ? entrada!.fornecedor_nome || "" : "",
    entregue_por,
    motivo,
    setor_sigla: setor ? setor.sigla_composta : "",
    setor_nome: setor ? setor.nome_extenso : "",
    setor_endereco: setor ? setor.endereco || "" : "",
    cidade: setor ? setor.cidade : "Diamantina",
  });
}

/** RN-15: registro gravado reimprime do congelado, não do catálogo de hoje. */
export function montar_contexto(registro: EpiFichaRegistro): ContextoComprovante {
  if (!registro.contexto_congelado) {
    throw new RegraViolada(
      `o registro ${registro.id} não tem contexto congelado: o comprovante ` +
        "não pode ser remontado do catálogo de hoje sem deixar de ser prova",
    );
  }
  return ContextoComprovante.descongelar(registro.contexto_congelado, { registro_id: registro.id });
}

export interface Divergencia {
  registro_id: number;
  detalhe: string;
}

/**
 * Refaz a forma canônica de cada linha e compara com o evento que a registrou.
 * Complementa `auditoria.cadeia_integra()`: uma coisa é a trilha estar
 * íntegra, outra é a ficha continuar dizendo o que a trilha registrou.
 */
export async function conferir(tx: Executor, servidor_id: number): Promise<Divergencia[]> {
  const achados: Divergencia[] = [];
  for (const registro of await registros_de(tx, servidor_id)) {
    if (registro.evento_id === null) {
      achados.push({
        registro_id: registro.id,
        detalhe:
          "a linha não aponta para nenhum evento da trilha — não há " + "com o que conferir o conteúdo dela",
      });
      continue;
    }
    const [evento] = await tx.select().from(historico_evento).where(eq(historico_evento.id, registro.evento_id));
    if (!evento) {
      achados.push({ registro_id: registro.id, detalhe: "o evento apontado não existe" });
      continue;
    }
    // compara pela serialização canônica da trilha (chaves ordenadas), e não
    // pelo texto do jsonb
    if (auditoria.corpo(evento.valor_novo) !== auditoria.corpo(forma_canonica(registro))) {
      achados.push({
        registro_id: registro.id,
        detalhe: "o conteúdo da linha não confere com o que o evento " + `#${evento.id} registrou`,
      });
    }
  }
  return achados;
}

// =====================================================================
// Registrar a entrega
// =====================================================================
export interface DadosEntrega {
  servidor: Servidor;
  item: EpiItem;
  quantidade: number;
  entrada?: EpiEntradaEstoque | null;
  tamanho?: string;
  data_evento?: string | null;
  observacao?: string;
  justificativa_excecao?: string;
  tipo?: string;
  requisicao_item_id?: number | null;
}

/** As colunas de snapshot, copiadas do MESMO contexto que vai ao congelado. */
function _snapshots(contexto: ContextoComprovante) {
  return {
    nome_epi_snapshot: contexto.epi_nome,
    categoria_snapshot: contexto.categoria,
    numero_ca_snapshot: contexto.numero_ca || null,
    validade_ca_snapshot: contexto.validade_ca,
    fabricante_snapshot: contexto.fabricante || null,
    lote_snapshot: contexto.lote || null,
    tamanho_snapshot: contexto.tamanho || null,
    nome_servidor_snapshot: contexto.servidor_nome,
    siape_snapshot: contexto.siape,
    cargo_snapshot: contexto.cargo || null,
    unidade_snapshot: contexto.unidade || null,
    posto_snapshot: contexto.posto || null,
    previsao_troca: contexto.previsao_troca,
  };
}

/** Grava o `evento_id` (uma das três colunas que a trava deixa preencher uma vez). */
async function _amarrar_evento(tx: Executor, registro: EpiFichaRegistro, evento_id: number): Promise<void> {
  await tx.update(epi_ficha_registro).set({ evento_id }).where(eq(epi_ficha_registro.id, registro.id));
  registro.evento_id = evento_id;
}

/**
 * A entrega inteira, numa transação: ficha, baixa de estoque e trilha. A ordem:
 * permissão; validar tudo; gravar a linha com os snapshots (num INSERT só — a
 * trava recusa UPDATE de conteúdo); baixar o lote amarrado ao id; auditar com
 * a forma canônica; abrir as pendências.
 */
export async function registrar_entrega(tx: Executor, usuario: UsuarioAtual, d: DadosEntrega): Promise<EpiFichaRegistro> {
  usuario.exigir("epi.entregar");
  const { servidor, item, quantidade } = d;
  const entrada = d.entrada ?? null;
  const quando = d.data_evento || datas_br.hoje();
  const observacao = d.observacao ?? "";
  const justificativa_excecao = d.justificativa_excecao ?? "";
  const tipo = d.tipo ?? "ENTREGA";
  const requisicao_item_id = d.requisicao_item_id ?? null;

  // RN-30: texto livre passa pelo filtro da RN-21 antes de qualquer gravação
  textos.exigir_texto_limpo(observacao, "observação da entrega");
  textos.exigir_texto_limpo(justificativa_excecao, "justificativa da exceção");

  const validacao = await validar(tx, { servidor, item, entrada, quantidade, quando, justificativa_excecao });
  if (!validacao.ok) throw new EntregaBloqueada(validacao.bloqueios);

  const motivo = [observacao.trim(), justificativa_excecao.trim()].filter((t) => t).join(" ");
  // snapshots e congelado saem do MESMO contexto
  const contexto = await montar_contexto_para_entregar(tx, {
    servidor,
    item,
    entrada,
    quantidade,
    tamanho: d.tamanho ?? "",
    quando,
    tipo,
    entregue_por: usuario.nome,
    motivo,
  });
  const [registro] = await tx
    .insert(epi_ficha_registro)
    .values({
      servidor_id: servidor.id,
      epi_item_id: item.id,
      entrada_id: entrada ? entrada.id : null,
      requisicao_item_id,
      tipo,
      quantidade,
      data_evento: quando,
      entregue_por: usuario.id,
      motivo: motivo || null,
      contexto_congelado: contexto.congelar(),
      ..._snapshots(contexto),
    })
    .returning();
  contexto.registro_id = registro!.id;

  if (entrada) {
    await epi_estoque.baixar(tx, {
      entrada,
      quantidade,
      ficha_registro_id: registro!.id,
      usuario,
      // `servidor #{id}` e não o SIAPE: o extrato do lote abre com `epi.ver`,
      // e o razão é append-only (RN-19 pela prosa)
      motivo: `entrega ao servidor #${servidor.id}`,
      requisicao_item_id,
    });
  }

  const evento = await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: registro!.id,
    tipo_evento: EPI_ENTREGUE,
    // RN-19 na ESCRITA: o servidor sai pelo id; quem OPEROU continua nominal
    descricao:
      `${quantidade} × ${registro!.nome_epi_snapshot} para o ` +
      `servidor #${registro!.servidor_id} · ` +
      `CA ${registro!.numero_ca_snapshot || "—"} · ` +
      `lote ${registro!.lote_snapshot || "—"}`,
    campo: "ficha",
    valor_novo: forma_canonica(registro!),
    usuario,
  });
  await _amarrar_evento(tx, registro!, evento.id);

  if (justificativa_excecao.trim()) {
    await auditoria.registrar(tx, {
      entidade: ENTIDADE,
      entidade_id: registro!.id,
      tipo_evento: EPI_MAXIMO_EXCEDIDO,
      descricao: `Máximo de '${item.nome}' excedido e autorizado por ${usuario.nome}: ${justificativa_excecao.trim()}`,
      comentario: justificativa_excecao.trim(),
      usuario,
    });
  }

  if (tipo === "ENTREGA") {
    await abrir_pendencia_de_comprovante(tx, registro!, usuario);
    // §7.2, sentido inverso: a entrega NÃO toca `adicional_vigencia`
    await abrir_pendencia_de_reavaliacao(tx, registro!, usuario);
    // RN-32: esta entrega pode ser a substituição que encerra uma troca antiga
    await sincronizar_trocas_do_servidor(tx, servidor.id, usuario);
  }
  return registro!;
}

// =====================================================================
// Estorno — a única forma de corrigir
// =====================================================================
function _herdados(registro: EpiFichaRegistro) {
  return {
    nome_epi_snapshot: registro.nome_epi_snapshot,
    categoria_snapshot: registro.categoria_snapshot,
    numero_ca_snapshot: registro.numero_ca_snapshot,
    validade_ca_snapshot: registro.validade_ca_snapshot,
    fabricante_snapshot: registro.fabricante_snapshot,
    lote_snapshot: registro.lote_snapshot,
    tamanho_snapshot: registro.tamanho_snapshot,
    nome_servidor_snapshot: registro.nome_servidor_snapshot,
    siape_snapshot: registro.siape_snapshot,
    cargo_snapshot: registro.cargo_snapshot,
    unidade_snapshot: registro.unidade_snapshot,
    posto_snapshot: registro.posto_snapshot,
  };
}

/**
 * Linha nova apontando para a errada, com motivo. A errada continua lá. Não
 * devolve saldo: estornar diz que o REGISTRO está errado, não que o
 * equipamento voltou (isso é `registrar_devolucao`).
 */
export async function estornar(
  tx: Executor,
  usuario: UsuarioAtual,
  registro: EpiFichaRegistro,
  motivo: string,
): Promise<EpiFichaRegistro> {
  usuario.exigir("epi.entregar");
  const limpo = textos.exigir_texto_limpo((motivo || "").trim(), "motivo do estorno") as string;
  if (!limpo) {
    throw new EntregaBloqueada([
      "estornar exige o motivo: é o único registro que sobra para quem " +
        "ler a ficha depois e perguntar por que aquela linha não vale",
    ]);
  }
  if (registro.tipo === "ESTORNO") throw new EntregaBloqueada(["um estorno não se estorna: registre a entrega de novo"]);
  if ((await _ja_estornado(tx, registro)) !== null) {
    throw new EntregaBloqueada([`o registro ${registro.id} já foi estornado`]);
  }
  const devolvido = (await devolucoes_de(tx, registro)).reduce((s, d) => s + d.quantidade, 0);
  if (devolvido) {
    // estorno depois de devolução inflaria o razão: a devolução já devolveu
    // saldo de uma entrega que o estorno declara que não valia
    throw new EntregaBloqueada([
      `o registro ${registro.id} já teve ${devolvido} devolvido(s): ` +
        "devolução é fato do mundo e devolveu saldo ao lote. Corrigir a " +
        "quantidade agora é ajuste de inventário, com contagem e motivo",
    ]);
  }

  // o comprovante de um estorno é o do registro estornado, com outro título e
  // o motivo à mostra — montado ANTES do INSERT
  const congelado: Record<string, unknown> = { ...((registro.contexto_congelado ?? {}) as Record<string, unknown>) };
  if (Object.keys(congelado).length) {
    congelado["tipo"] = "ESTORNO";
    congelado["motivo"] = limpo;
  }
  const [estorno] = await tx
    .insert(epi_ficha_registro)
    .values({
      servidor_id: registro.servidor_id,
      epi_item_id: registro.epi_item_id,
      entrada_id: registro.entrada_id,
      tipo: "ESTORNO",
      quantidade: registro.quantidade,
      data_evento: datas_br.hoje(),
      entregue_por: usuario.id,
      motivo: limpo,
      registro_estornado_id: registro.id,
      // herda os snapshots: o estorno fala DAQUELA entrega
      ..._herdados(registro),
      contexto_congelado: Object.keys(congelado).length ? congelado : null,
    })
    .returning();

  const evento = await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: estorno!.id,
    tipo_evento: EPI_ESTORNADO,
    descricao:
      `Registro ${registro.id} estornado: ${limpo} ` +
      `(${registro.quantidade} × ${registro.nome_epi_snapshot} para o ` +
      `servidor #${registro.servidor_id})`,
    campo: "ficha",
    valor_novo: forma_canonica(estorno!),
    comentario: limpo,
    usuario,
  });
  await _amarrar_evento(tx, estorno!, evento.id);

  // a entrega estornada deixa de dever comprovante e troca (RN-32)
  await fechar_pendencia_de_comprovante(tx, registro, usuario);
  await sincronizar_trocas_do_servidor(tx, registro.servidor_id, usuario);
  return estorno!;
}

// =====================================================================
// Devolução — o outro fato, que NÃO é estorno
// =====================================================================
/**
 * O equipamento voltou: linha nova na ficha e saldo de volta no razão.
 * Devolução diz que o registro estava certo e que o EPI voltou; estorno diz
 * que o registro estava errado. Um clique que fizesse as duas coisas faria o
 * físico deixar de bater com a prateleira.
 */
export async function registrar_devolucao(
  tx: Executor,
  usuario: UsuarioAtual,
  registro: EpiFichaRegistro,
  d: { quantidade: number; motivo: string; data_evento?: string | null },
): Promise<EpiFichaRegistro> {
  usuario.exigir("epi.entregar");
  const quantidade = d.quantidade;
  const limpo = textos.exigir_texto_limpo((d.motivo || "").trim(), "motivo da devolução") as string;
  const hoje = datas_br.hoje();
  const quando = d.data_evento || hoje;
  const bloqueios: string[] = [];
  if (!limpo) {
    bloqueios.push(
      "diga por que o equipamento voltou: desgaste, dano, troca de posto " +
        "ou desligamento mudam o que o setor faz com ele depois",
    );
  }
  if (registro.tipo !== "ENTREGA") {
    bloqueios.push(`só se devolve o que foi entregue, e o registro ${registro.id} é ${registro.tipo.toLowerCase()}`);
  } else if ((await _ja_estornado(tx, registro)) !== null) {
    bloqueios.push(
      `o registro ${registro.id} foi estornado: ele declara que aquela ` + "entrega não vale, e não há o que devolver dela",
    );
  }
  if (quantidade <= 0) bloqueios.push("a quantidade devolvida tem de ser maior que zero");
  if (quando > hoje) {
    bloqueios.push("a devolução não pode ter data futura");
  } else if (quando < registro.data_evento) {
    bloqueios.push(
      "a devolução é anterior à entrega: confira a data, porque a ficha é " +
        "append-only e a linha não se corrige depois",
    );
  }
  if (registro.tipo === "ENTREGA") {
    const em_poder = await em_poder_de(tx, registro.servidor_id, registro.epi_item_id);
    if (quantidade > em_poder) {
      bloqueios.push(
        `${registro.nome_servidor_snapshot} está com ${em_poder} de ` +
          `'${registro.nome_epi_snapshot}' e a devolução registra ${quantidade}`,
      );
    }
  }
  if (bloqueios.length) throw new EntregaBloqueada(bloqueios);

  const congelado: Record<string, unknown> = { ...((registro.contexto_congelado ?? {}) as Record<string, unknown>) };
  if (Object.keys(congelado).length) {
    congelado["tipo"] = "DEVOLUCAO";
    congelado["quantidade"] = quantidade;
    congelado["data_evento"] = quando;
    congelado["motivo"] = limpo;
    // a devolução aponta para a entrega de onde veio — no congelado, e não em
    // `registro_estornado_id`, que quer dizer "esta linha anula aquela"
    congelado["registro_devolvido"] = registro.id;
  }
  const [devolucao] = await tx
    .insert(epi_ficha_registro)
    .values({
      servidor_id: registro.servidor_id,
      epi_item_id: registro.epi_item_id,
      entrada_id: registro.entrada_id,
      tipo: "DEVOLUCAO",
      quantidade,
      data_evento: quando,
      entregue_por: usuario.id,
      motivo: limpo,
      ..._herdados(registro),
      contexto_congelado: Object.keys(congelado).length ? congelado : null,
    })
    .returning();

  // o saldo só volta quando havia lote: entrega de balcão não baixou nada
  if (registro.entrada_id !== null) {
    const [entrada] = await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, registro.entrada_id));
    if (entrada) {
      await epi_estoque.devolver(tx, {
        entrada,
        quantidade,
        usuario,
        ficha_registro_id: devolucao!.id,
        // `servidor #{id}`, e não o SIAPE, pela mesma razão da baixa da entrega
        motivo: `devolução do servidor #${registro.servidor_id}: ${limpo}`,
      });
    }
  }

  const evento = await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: devolucao!.id,
    tipo_evento: EPI_DEVOLVIDO,
    descricao:
      `${quantidade} × ${registro.nome_epi_snapshot} devolvido(s) pelo ` +
      `servidor #${registro.servidor_id} ` +
      `· entrega ${registro.id} · ${limpo}`,
    campo: "ficha",
    valor_novo: forma_canonica(devolucao!),
    comentario: limpo,
    usuario,
  });
  await _amarrar_evento(tx, devolucao!, evento.id);
  // RN-32: devolução integral tira a entrega da cobrança de troca
  await sincronizar_trocas_do_servidor(tx, registro.servidor_id, usuario);
  return devolucao!;
}

// =====================================================================
// O comprovante: imprimir, e depois anexar o assinado
// =====================================================================
export interface Impressao {
  /** a chave do .docx no armazenamento (o `Path` do Python) */
  destino: string;
  aviso: string;
  bytes: Uint8Array;
  nome: string;
}

/**
 * Gera o .docx a partir do congelado. Reimprimir tem de dar texto idêntico: se
 * divergir da primeira impressão, a via sai assim mesmo, com aviso, e a
 * divergência entra na trilha.
 *
 * Desvio: devolve `{destino, aviso, bytes, nome}` no lugar de `(Path, aviso)` —
 * na nuvem o arquivo mora no armazenamento, e a rota já sai com os bytes.
 */
export async function imprimir(tx: Executor, usuario: UsuarioAtual, registro: EpiFichaRegistro): Promise<Impressao> {
  usuario.exigir("epi.entregar");
  const contexto = montar_contexto(registro);
  const destino = comprovante_epi.caminho_saida(registro.id, Number(registro.data_evento.slice(0, 4)));
  const info = await comprovante_epi.renderizar(contexto, destino);

  const anterior = await _hash_da_primeira_impressao(tx, registro);
  let aviso = "";
  if (anterior !== null && anterior !== info.hash_conteudo) {
    aviso =
      `O texto reimpresso do comprovante ${registro.id} não confere com o ` +
      "da primeira impressão — o arquivo do modelo provavelmente foi " +
      "trocado fora do sistema. A via saiu assim mesmo e a divergência foi " +
      "registrada na trilha.";
    await auditoria.registrar(tx, {
      entidade: ENTIDADE,
      entidade_id: registro.id,
      tipo_evento: EPI_COMPROVANTE_DIVERGENTE,
      descricao: aviso,
      campo: "hash_conteudo",
      valor_anterior: anterior,
      valor_novo: info.hash_conteudo,
      usuario,
    });
  }

  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: registro.id,
    tipo_evento: EPI_COMPROVANTE_IMPRESSO,
    // RN-19 na escrita; a leitura nominal vai para `acesso_dado_sensivel` abaixo
    descricao:
      `Comprovante do registro ${registro.id} ` +
      `(servidor #${registro.servidor_id} · ${contexto.epi_nome}) impresso · ` +
      `${info.hash_conteudo.slice(0, 12)}`,
    campo: "hash_conteudo",
    valor_novo: info.hash_conteudo,
    usuario,
  });
  // só a leitura de TERCEIRO entra em `acesso_dado_sensivel`
  await auditoria.registrar_leitura_nominal(tx, usuario, "epi_ficha", {
    servidor_id: registro.servidor_id,
    finalidade: "impressão do comprovante de entrega de EPI para assinatura",
  });
  return { destino, aviso, bytes: info.bytes, nome: comprovante_epi.nome_para_download(contexto) };
}

/** O hash que a trilha guardou na primeira vez (a ficha é append-only). */
async function _hash_da_primeira_impressao(tx: Executor, registro: EpiFichaRegistro): Promise<string | null> {
  const [linha] = await tx
    .select({ valor_novo: historico_evento.valor_novo })
    .from(historico_evento)
    .where(
      and(
        eq(historico_evento.entidade, ENTIDADE),
        eq(historico_evento.entidade_id, registro.id),
        eq(historico_evento.tipo_evento, EPI_COMPROVANTE_IMPRESSO),
      ),
    )
    .orderBy(asc(historico_evento.id))
    .limit(1);
  return linha ? (linha.valor_novo as string | null) : null;
}

/**
 * O papel assinado, digitalizado, com SHA-256 — e a janela se fecha.
 * `FICHA_EPI` é guarda permanente e nasce `RESTRITO`. A coluna se preenche
 * uma vez: a trava aceita nulo → valor e recusa a troca.
 */
export async function anexar_comprovante(
  tx: Executor,
  usuario: UsuarioAtual,
  registro: EpiFichaRegistro,
  d: { conteudo: Uint8Array; nome_original: string; mime_type: string },
): Promise<Anexo> {
  usuario.exigir("epi.entregar");
  if (registro.comprovante_anexo_id !== null) {
    throw new EntregaBloqueada([
      `o registro ${registro.id} já tem comprovante anexado. Trocar a ` +
        "prova de uma entrega registrada é estorno, não substituição de " +
        "arquivo",
    ]);
  }
  if (registro.tipo === "ESTORNO") {
    throw new EntregaBloqueada(["estorno não tem comprovante: o papel assinado é o da entrega"]);
  }
  if (!d.conteudo || !d.conteudo.byteLength) throw new EntregaBloqueada(["o arquivo do comprovante veio vazio"]);

  const resultado = await anexos.guardar(tx, {
    entidade: ENTIDADE,
    entidade_id: registro.id,
    nome_original: d.nome_original,
    conteudo: d.conteudo,
    mime_type: d.mime_type,
    categoria: CATEGORIA_ANEXO,
    usuario,
    assinado: true,
  });
  const mudanca = { comprovante_anexo_id: resultado.anexo.id, recebimento_confirmado_em: agora_utc() };
  await tx.update(epi_ficha_registro).set(mudanca).where(eq(epi_ficha_registro.id, registro.id));
  Object.assign(registro, mudanca);

  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: registro.id,
    tipo_evento: EPI_COMPROVANTE_ANEXADO,
    descricao:
      `Comprovante assinado do registro ${registro.id} ` +
      `(servidor #${registro.servidor_id} · ${registro.nome_epi_snapshot}) ` +
      `· SHA-256 ${resultado.anexo.sha256.slice(0, 12)}`,
    campo: "comprovante_anexo_id",
    valor_novo: resultado.anexo.sha256,
    usuario,
  });
  await fechar_pendencia_de_comprovante(tx, registro, usuario);
  return resultado.anexo;
}

// =====================================================================
// A pendência que torna a janela visível (decisão 8)
// =====================================================================
export function chave_da_pendencia(registro_id: number): string {
  return `comprovante:ficha:${registro_id}`;
}

/** Ficha sem comprovante é pendência, não entrega completa. O dono é quem entregou. */
export function abrir_pendencia_de_comprovante(tx: Executor, registro: EpiFichaRegistro, usuario: UsuarioAtual) {
  return pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_COMPROVANTE,
    chave: chave_da_pendencia(registro.id),
    // RN-19 na escrita: `#{id}` chega legível e sem identificar ninguém
    descricao:
      `Anexar o comprovante assinado de ${registro.quantidade} × ` +
      `${registro.nome_epi_snapshot} entregue ao ` +
      `servidor #${registro.servidor_id} em ` +
      `${datas_br.numerica(registro.data_evento)}`,
    entidade: ENTIDADE,
    entidade_id: registro.id,
    responsavel_id: usuario.id,
    usuario,
  });
}

// =====================================================================
// §7.2 — o sentido inverso: pendência, e nunca efeito colateral
// =====================================================================
export function chave_da_reavaliacao(vigencia_id: number, registro_id: number): string {
  return `reavaliar_epi:vigencia:${vigencia_id}:ficha:${registro_id}`;
}

/**
 * Entrega para quem tem adicional VIGENTE abre tarefa na CSSO. Só isso: quem
 * decide é quem subscreve laudo e assina parecer, e a decisão mora em
 * `exposicao.epi_neutraliza` — não nesta tabela e não neste módulo. O dono é
 * quem emitiu (ou criou) o parecer que concedeu o adicional.
 */
export async function abrir_pendencia_de_reavaliacao(
  tx: Executor,
  registro: EpiFichaRegistro,
  usuario: UsuarioAtual,
): Promise<pendencias.Pendencia[]> {
  const abertas: pendencias.Pendencia[] = [];
  const vigencias = await tx.query.adicional_vigencia.findMany({
    where: and(eq(adicional_vigencia.servidor_id, registro.servidor_id), eq(adicional_vigencia.estado, "VIGENTE")),
    with: { parecer: true },
    orderBy: [asc(adicional_vigencia.id)],
  });
  for (const vigencia of vigencias) {
    const parecer = vigencia.parecer ?? null;
    abertas.push(
      await pendencias.abrir(tx, {
        tipo: TIPO_PENDENCIA_REAVALIACAO,
        chave: chave_da_reavaliacao(vigencia.id, registro.id),
        descricao:
          `Entrega de '${registro.nome_epi_snapshot}' em ` +
          `${datas_br.numerica(registro.data_evento)} ao servidor ` +
          `#${registro.servidor_id}, que tem adicional vigente. ` +
          "Avaliar, em parecer, se o EPI neutraliza o agente — " +
          "lembrando que EPI não cessa periculosidade. A entrega, " +
          "sozinha, não altera o direito.",
        entidade: ENTIDADE,
        entidade_id: registro.id,
        parecer_id: vigencia.parecer_id,
        processo_id: parecer ? parecer.processo_id : null,
        responsavel_id: parecer ? parecer.emitido_por || parecer.criado_por : null,
        usuario,
      }),
    );
  }
  return abertas;
}

async function _pendencia_por_chave(tx: Executor, chave: string): Promise<pendencias.Pendencia | null> {
  const [p] = await tx.select().from(tabela_pendencia).where(eq(tabela_pendencia.chave, chave));
  return p ?? null;
}

export async function fechar_pendencia_de_comprovante(
  tx: Executor,
  registro: EpiFichaRegistro,
  usuario: UsuarioAtual,
): Promise<void> {
  const pendencia = await _pendencia_por_chave(tx, chave_da_pendencia(registro.id));
  if (pendencia && !pendencia.concluida) await pendencias.concluir(tx, pendencia, usuario);
}

// =====================================================================
// RN-32 — vida útil e troca devida
// =====================================================================
function _antes(a: EpiFichaRegistro, b: EpiFichaRegistro): boolean {
  return a.data_evento !== b.data_evento ? a.data_evento < b.data_evento : a.id < b.id;
}

/**
 * A entrega POSTERIOR do mesmo item à mesma pessoa — a troca já feita. Empate
 * de data desempata por id.
 */
async function _substituida_ate(tx: Executor, registro: EpiFichaRegistro, quando: string): Promise<EpiFichaRegistro | null> {
  const candidatas = await tx
    .select()
    .from(epi_ficha_registro)
    .where(
      and(
        eq(epi_ficha_registro.servidor_id, registro.servidor_id),
        eq(epi_ficha_registro.epi_item_id, registro.epi_item_id),
        eq(epi_ficha_registro.tipo, "ENTREGA"),
        lte(epi_ficha_registro.data_evento, quando),
        ne(epi_ficha_registro.id, registro.id),
      ),
    );
  let melhor: EpiFichaRegistro | null = null;
  for (const c of candidatas) {
    if (!_antes(registro, c)) continue;
    if ((await _ja_estornado(tx, c)) !== null) continue;
    if (melhor === null || _antes(c, melhor)) melhor = c;
  }
  return melhor;
}

/**
 * RN-32: a vida útil acabou e ninguém sabe o que a pessoa está usando.
 * Estorno, devolução integral e substituição tiram a linha da cobrança.
 */
export async function troca_devida_em(tx: Executor, registro: EpiFichaRegistro, quando: string | null = null): Promise<boolean> {
  const dia = quando || datas_br.hoje();
  if (registro.tipo !== "ENTREGA") return false;
  if (registro.previsao_troca === null || registro.previsao_troca >= dia) return false;
  if ((await _ja_estornado(tx, registro)) !== null) return false;
  if ((await _devolvida_ate(tx, registro, dia)) !== null) return false;
  return (await _substituida_ate(tx, registro, dia)) === null;
}

/** As entregas com troca vencida — a medida de `/epis` e a fila da RN-32. */
export async function trocas_devidas(tx: Executor, d: { quando?: string | null } = {}): Promise<EpiFichaRegistro[]> {
  const quando = d.quando || datas_br.hoje();
  const linhas = await tx
    .select()
    .from(epi_ficha_registro)
    .where(
      and(
        eq(epi_ficha_registro.tipo, "ENTREGA"),
        isNotNull(epi_ficha_registro.previsao_troca),
        lt(epi_ficha_registro.previsao_troca, quando),
      ),
    )
    .orderBy(asc(epi_ficha_registro.previsao_troca), asc(epi_ficha_registro.id));
  const saida: EpiFichaRegistro[] = [];
  for (const r of linhas) if (await troca_devida_em(tx, r, quando)) saida.push(r);
  return saida;
}

export function chave_da_pendencia_de_troca(registro_id: number): string {
  return `troca:ficha:${registro_id}`;
}

/**
 * Abre a pendência da troca devida, ou a fecha quando ela perdeu o objeto.
 * Disparada por escrita, e não por relógio (não há agendador): um servidor que
 * não recebe nada de novo atravessa a data da troca sem abrir pendência — a
 * ficha e o painel calculam o estado na hora.
 */
export async function sincronizar_pendencia_de_troca(
  tx: Executor,
  registro: EpiFichaRegistro,
  usuario: UsuarioAtual | null = null,
  quando: string | null = null,
): Promise<pendencias.Pendencia | null> {
  const dia = quando || datas_br.hoje();
  const chave = chave_da_pendencia_de_troca(registro.id);
  if (!(await troca_devida_em(tx, registro, dia))) {
    await _fechar_pendencia_de_troca(tx, chave, usuario);
    return null;
  }
  return pendencias.abrir(tx, {
    tipo: TIPO_PENDENCIA_TROCA,
    chave,
    descricao:
      `A troca de '${registro.nome_epi_snapshot}' entregue ao servidor ` +
      `#${registro.servidor_id} em ` +
      `${datas_br.numerica(registro.data_evento)} estava prevista para ` +
      `${datas_br.numerica(registro.previsao_troca!)} e venceu. Entregue o ` +
      "substituto ou registre a devolução: EPI com troca vencida não " +
      "sustenta a alegação de que o agente nocivo está neutralizado " +
      "(RN-32).",
    entidade: ENTIDADE,
    entidade_id: registro.id,
    // o prazo é a própria previsão: a tarefa está atrasada por definição
    prazo: registro.previsao_troca,
    usuario,
  });
}

/**
 * Revê a ficha inteira da pessoa: a escrita nova é justamente o que DESFAZ a
 * cobrança de uma linha antiga (a entrega de hoje substitui a bota de 2024).
 */
export async function sincronizar_trocas_do_servidor(
  tx: Executor,
  servidor_id: number,
  usuario: UsuarioAtual | null = null,
  quando: string | null = null,
): Promise<void> {
  const dia = quando || datas_br.hoje();
  const registros = await tx
    .select()
    .from(epi_ficha_registro)
    .where(
      and(
        eq(epi_ficha_registro.servidor_id, servidor_id),
        eq(epi_ficha_registro.tipo, "ENTREGA"),
        isNotNull(epi_ficha_registro.previsao_troca),
      ),
    )
    .orderBy(asc(epi_ficha_registro.id));
  for (const registro of registros) await sincronizar_pendencia_de_troca(tx, registro, usuario, dia);
}

async function _fechar_pendencia_de_troca(tx: Executor, chave: string, usuario: UsuarioAtual | null): Promise<void> {
  const pendencia = await _pendencia_por_chave(tx, chave);
  if (!pendencia || pendencia.concluida) return;
  if (usuario === null) {
    // sem usuário é a varredura: fecha em nome da rotina, não de uma pessoa
    await pendencias.concluir_pela_rotina(
      tx,
      pendencia,
      "a troca deixou de ser devida (devolvido, estornado ou substituído)",
    );
    return;
  }
  await pendencias.concluir(tx, pendencia, usuario);
}

// =====================================================================
// RN-27 — a recusa fundamentada
// =====================================================================
/**
 * A negativa fundamentada, catalogada e CONGELADA na trilha. O texto vigente é
 * copiado para o evento no ato — editar o catálogo depois não reescreve a
 * negativa que o requerente já recebeu.
 */
export async function recusar(
  tx: Executor,
  usuario: UsuarioAtual,
  d: { motivo: EpiMotivoRecusa; a_quem: string; item?: EpiItem | null; unidade?: string; complemento?: string },
): Promise<Record<string, unknown>> {
  usuario.exigir("epi.entregar");
  const { motivo } = d;
  const item = d.item ?? null;
  const limpo = textos.exigir_texto_limpo((d.complemento || "").trim(), "complemento da recusa") as string;
  const quem = textos.exigir_texto_limpo((d.a_quem || "").trim(), "a quem a recusa se dirige") as string;
  if (!quem) {
    throw new EntregaBloqueada([
      "diga a quem a recusa se dirige: sem isso o registro não serve " +
        "para mostrar o padrão dos pedidos que o setor precisa recusar",
    ]);
  }
  if (!motivo.ativo) throw new EntregaBloqueada([`o motivo ${motivo.codigo} está inativo no catálogo`]);
  if (motivo.exige_complemento && !limpo) {
    throw new EntregaBloqueada([`o motivo ${motivo.codigo} exige o complemento por escrito`]);
  }

  const congelado = {
    motivo: motivo.codigo,
    rotulo: motivo.rotulo,
    // o texto vai INTEIRO: é ele que sai literal para quem pediu
    texto: motivo.texto,
    base_normativa: motivo.base_normativa,
    complemento: limpo || null,
    a_quem: quem,
    unidade: (d.unidade || "").trim() || null,
    item: item ? item.nome : null,
    data: datas_br.hoje(),
  };
  await auditoria.registrar(tx, {
    entidade: "epi_motivo_recusa",
    entidade_id: motivo.id,
    tipo_evento: EPI_ENTREGA_RECUSADA,
    descricao: `Fornecimento recusado a ${quem}` + (item ? ` (${item.nome})` : "") + `: ${motivo.rotulo}`,
    campo: "motivo_recusa",
    // o código em `valor_novo` é o que faz a contagem por motivo sair da trilha
    valor_novo: congelado,
    comentario: limpo || null,
    usuario,
  });
  return congelado;
}
