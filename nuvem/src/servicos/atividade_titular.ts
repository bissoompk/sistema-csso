/**
 * NUVEM (Portal do servidor, 22/10/2026): "Minha atividade" — o que aconteceu
 * com os treinamentos, certificados, EPIs, processos e a conta do PRÓPRIO
 * titular, lido da trilha (`historico_evento`).
 *
 * **Lista branca.** Só entra o par (entidade, tipo) que está em
 * `EVENTOS_DO_TITULAR`. Fora dela, de propósito:
 * - eventos de `turma` (lote de certificados, lista de presença, presença em
 *   lote): são da turma inteira, não da pessoa;
 * - os internos da equipe: CERTIFICADO_DIVERGENTE, PDF_NAO_GERADO, AVISO,
 *   comprovante impresso/divergente, máximo excedido, e-mail enfileirado,
 *   responsável alterado, comentário;
 * - entrada, bloqueio e desbloqueio de conta (logins e acessos);
 * - QUALQUER consulta a dado sensível (`acesso_dado_sensivel`, leituras
 *   registradas, anexo baixado): decisão do usuário — o servidor não vê quem
 *   consultou os dados dele. Esta função nem lê aquela tabela.
 *
 * **Presa ao titular.** Cada entidade entra por um JOIN que exige o
 * `servidor_id` da conta (ou o id da própria conta, para `usuario`): o
 * certificado (`certificado.servidor_id`), a inscrição (pelo participante), o
 * pedido de EPI e seus itens (pela requisição), o registro da ficha de EPI, a
 * comunicação do titular sobre EPI e o processo (`processo.servidor_id`).
 *
 * **O que sai na tela.** A frase é desta lista, nunca a `descricao` livre do
 * evento (que pode citar terceiros e é texto encadeado por hash). O objeto vem
 * de dado seguro: código da turma, nome congelado do treinamento, rótulo do
 * certificado, protocolo do pedido, nome do EPI congelado na ficha, NUP. O
 * agente é "Você" ou "Equipe {sigla}" — o nome de quem operou NUNCA sai daqui
 * (RN-19): a consulta nem seleciona `usuario_nome`.
 *
 * **Uma consulta.** `UNION ALL` de um ramo por entidade, ordenado e cortado no
 * banco (30 + 1 para saber se há mais), com a sigla do setor responsável por
 * EPI e processos (a CSSO) numa subconsulta escalar. Sem N+1.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { Certificado as C } from "../dominio/treinamento.js";
import { somar_dias } from "../dominio/datas.js";
import { ROTULO_ESTADO_TELA } from "../dominio/estados.js";
import * as datas_br from "./datas_br.js";
import { NOME_OFICIAL_CSSO, type UsuarioAtual } from "./rbac.js";

// ---------------------------------------------------------------------
// Grupos (as pílulas de filtro)
// ---------------------------------------------------------------------
export type GrupoAtividade = "treinamentos" | "certificados" | "epi" | "processos" | "conta";

export interface DefinicaoGrupo {
  codigo: GrupoAtividade;
  rotulo: string;
  /** símbolo do sprite `icones.svg` */
  icone: string;
}

export const GRUPOS_ATIVIDADE: readonly DefinicaoGrupo[] = [
  { codigo: "treinamentos", rotulo: "Treinamentos", icone: "mortarboard" },
  { codigo: "certificados", rotulo: "Certificados", icone: "award" },
  { codigo: "epi", rotulo: "EPI", icone: "shield-plus" },
  { codigo: "processos", rotulo: "Processos", icone: "folder2-open" },
  { codigo: "conta", rotulo: "Conta", icone: "person-gear" },
];

export function grupo_valido(valor: string | null | undefined): GrupoAtividade | null {
  return GRUPOS_ATIVIDADE.some((g) => g.codigo === valor) ? (valor as GrupoAtividade) : null;
}

// ---------------------------------------------------------------------
// A lista branca
// ---------------------------------------------------------------------
type EntidadeDoTitular =
  | "certificado"
  | "inscricao"
  | "epi_requisicao"
  | "epi_requisicao_item"
  | "epi_ficha_registro"
  | "epi_comunicacao_titular"
  | "processo"
  | "usuario";

export interface EventoDoTitular {
  entidade: EntidadeDoTitular;
  tipo: string;
  grupo: GrupoAtividade;
  /** a frase para o titular; ou, por `valor_novo` (código de situação), uma frase por valor */
  frase: string | Readonly<Record<string, string>>;
  /** quando o evento não tem conta (o link público), quem aparece como agente */
  agente_sem_conta?: string;
}

/** As frases do ESTADO_ALTERADO da inscrição, pela situação de chegada. */
const FRASE_SITUACAO_INSCRICAO: Readonly<Record<string, string>> = {
  INSCRITA: "Inscrição aceita",
  CONFIRMADA: "Inscrição confirmada",
  PRESENTE: "Participação registrada",
  AUSENTE: "Falta registrada",
  APROVADO: "Treinamento concluído",
  REPROVADO: "Treinamento não concluído",
  CANCELADA: "Inscrição cancelada",
};

const T = (
  entidade: EntidadeDoTitular,
  grupo: GrupoAtividade,
  pares: Readonly<Record<string, string | Readonly<Record<string, string>>>>,
  extra: Partial<EventoDoTitular> = {},
): EventoDoTitular[] => Object.entries(pares).map(([tipo, frase]) => ({ entidade, tipo, grupo, frase, ...extra }));

export const EVENTOS_DO_TITULAR: readonly EventoDoTitular[] = [
  // --- treinamentos (a inscrição) ---
  ...T("inscricao", "treinamentos", {
    INSCRICAO_PEDIDA_PELO_TITULAR: "Você pediu inscrição",
    INSCRICAO_CRIADA: "Inscrição feita",
    INSCRICAO_DESISTIDA: "Você desistiu da inscrição",
    ESTADO_ALTERADO: FRASE_SITUACAO_INSCRICAO,
    PRESENCA_LANCADA: "Presença lançada",
    NOTA_LANCADA: "Nota lançada",
    RESULTADO_RETIFICADO: "Resultado do treinamento corrigido",
  }),
  ...T(
    "inscricao",
    "treinamentos",
    { INSCRICAO_PEDIDA_PELO_LINK: "Inscrição pedida pelo link público" },
    { agente_sem_conta: "Pelo link público" },
  ),
  // --- certificados ---
  ...T("certificado", "certificados", {
    CERTIFICADO_EMITIDO: "Certificado emitido",
    CERTIFICADO_SEGUNDA_VIA: "Segunda via do certificado",
    CERTIFICADO_RETIFICADO: "Certificado corrigido (novo documento)",
    CERTIFICADO_ANULADO: "Certificado anulado",
    CERTIFICADO_ENVIO_PEDIDO: "Certificado enviado por e-mail",
    RECICLAGEM_AVISO_PEDIDO: "Aviso de reciclagem enviado",
  }),
  // --- EPI: o pedido ---
  ...T("epi_requisicao", "epi", {
    EPI_REQUISICAO_CRIADA: "Pedido de EPI iniciado",
    EPI_REQUISICAO_ENVIADA: "Pedido de EPI enviado",
    EPI_REQUISICAO_TERMO_ACEITO: "Termo NR-06 declarado no pedido",
    EPI_REQUISICAO_EM_ANALISE: "Pedido de EPI em análise",
    EPI_REQUISICAO_DEVOLVIDA: "Pedido de EPI voltou para a fila",
    EPI_REQUISICAO_ANALISADA: "Pedido de EPI analisado",
    EPI_REQUISICAO_INDEFERIDA: "Pedido de EPI indeferido",
    EPI_REQUISICAO_RECONSIDERADA: "Pedido de EPI reconsiderado",
    EPI_REQUISICAO_EM_ATENDIMENTO: "Pedido de EPI em atendimento",
    EPI_REQUISICAO_ATENDIDA: "Pedido de EPI atendido",
    EPI_REQUISICAO_CANCELADA: "Pedido de EPI cancelado",
    EPI_REQUISICAO_EXCLUIDA: "Rascunho de pedido de EPI excluído",
  }),
  // --- EPI: cada item do pedido ---
  ...T("epi_requisicao_item", "epi", {
    EPI_ITEM_APROVADO: "Item do pedido aprovado",
    EPI_ITEM_RECUSADO: "Item do pedido recusado",
    EPI_ITEM_CANCELADO: "Item do pedido cancelado",
    EPI_ITEM_RESERVADO: "Item separado para você",
    EPI_ITEM_RESERVA_SOLTA: "Item do pedido aguardando estoque",
    EPI_ITEM_SEM_ESTOQUE: "Item do pedido sem estoque",
    EPI_ITEM_ENTREGUE: "Item do pedido entregue",
  }),
  // --- EPI: a ficha ---
  ...T("epi_ficha_registro", "epi", {
    EPI_ENTREGUE: "EPI entregue",
    EPI_DEVOLVIDO: "EPI devolvido",
    EPI_ESTORNADO: "Registro de EPI estornado",
    EPI_COMPROVANTE_ANEXADO: "Comprovante de EPI assinado anexado",
  }),
  // --- EPI: o que o titular comunicou ---
  ...T("epi_comunicacao_titular", "epi", {
    EPI_COMUNICACAO_REGISTRADA: "Você comunicou a situação de um EPI",
    EPI_COMUNICACAO_RETIRADA: "Comunicação sobre EPI retirada",
    EPI_COMUNICACAO_TRATADA: "Sua comunicação sobre EPI foi tratada",
  }),
  // --- processos ---
  ...T("processo", "processos", {
    PROCESSO_CRIADO: "Processo aberto",
    ESTADO_ALTERADO: "Processo mudou de etapa",
  }),
  // --- a conta ---
  ...T("usuario", "conta", {
    USUARIO_CRIADO: "Conta criada",
    SERVIDOR_VINCULADO: "Conta ligada ao seu cadastro de servidor",
    SENHA_TROCADA: "Senha alterada",
    SENHA_RESETADA: "Senha redefinida",
    CONTA_DADOS_ALTERADOS_PELO_TITULAR: "Dados de contato alterados",
    EMAIL_ALTERADO_PELO_TITULAR: "E-mail de entrada alterado",
    USUARIO_ALTERADO: "Dados da conta alterados",
    USUARIO_ATIVADO: "Conta ativada",
    USUARIO_INATIVADO: "Conta inativada",
  }),
];

const _POR_CHAVE = new Map(EVENTOS_DO_TITULAR.map((e) => [`${e.entidade}:${e.tipo}`, e]));

/** A definição do par (entidade, tipo) na lista branca, ou null. */
export function evento_do_titular(entidade: string, tipo: string): EventoDoTitular | null {
  return _POR_CHAVE.get(`${entidade}:${tipo}`) ?? null;
}

// ---------------------------------------------------------------------
// A consulta
// ---------------------------------------------------------------------
export const POR_PAGINA = 30;

export interface FiltroAtividade {
  grupo?: GrupoAtividade | null;
}

export interface PaginaAtividade {
  /** id do último evento já mostrado (cursor); a página traz os anteriores a ele */
  antes?: number | null;
  /** para o teste; padrão `POR_PAGINA` */
  tamanho?: number;
  /** para o teste e o "há 3 h" estável */
  agora?: Date;
}

export interface ItemAtividade {
  id: number;
  grupo: GrupoAtividade;
  icone: string;
  titulo: string;
  objeto: string;
  /** "Você" ou "Equipe {sigla}" — nunca o nome de quem operou (RN-19) */
  agente: string;
  proprio: boolean;
  /** ISO, para `<time datetime>` */
  quando_iso: string;
  /** "22/10/2026 14:03", para o `title` */
  quando_completo: string;
  /** "há 3 h", "ontem", "15/09/2026" */
  quando_relativo: string;
  /** "14:03" */
  hora: string;
  /** AAAA-MM-DD no fuso de exibição, para agrupar por dia */
  dia: string;
}

export interface DiaAtividade {
  dia: string;
  /** "Hoje", "Ontem" ou dd/mm/aaaa */
  rotulo: string;
  itens: ItemAtividade[];
}

export interface AtividadeDoTitular {
  dias: DiaAtividade[];
  total_na_pagina: number;
  /** o cursor da próxima página (`?antes=`), ou null quando acabou */
  proximo_antes: number | null;
}

interface LinhaBruta {
  id: number | string;
  entidade: string;
  tipo_evento: string;
  ocorrido_em: Date | string;
  usuario_id: number | null;
  valor: string | null;
  turma_codigo: string | null;
  treinamento: string | null;
  cert_numero: number | null;
  cert_ano: number | null;
  cert_impresso: string | null;
  pedido: string | null;
  item: string | null;
  sigla: string | null;
  sigla_csso: string | null;
}

function _tipos(entidade: EntidadeDoTitular, grupo: GrupoAtividade | null): string[] {
  return EVENTOS_DO_TITULAR.filter((e) => e.entidade === entidade && (grupo === null || e.grupo === grupo)).map(
    (e) => e.tipo,
  );
}

function _em(tipos: string[]): SQL {
  return sql.join(
    tipos.map((t) => sql`${t}`),
    sql`, `,
  );
}

/**
 * As linhas do titular, já cortadas e ordenadas no banco. `servidor_id` nulo
 * deixa só o ramo da conta.
 */
async function _linhas(
  tx: Executor,
  usuario_id: number,
  servidor_id: number | null,
  grupo: GrupoAtividade | null,
  antes: number | null,
  limite: number,
): Promise<LinhaBruta[]> {
  const cursor = antes
    ? sql`AND (h.ocorrido_em, h.id) < (SELECT a.ocorrido_em, a.id FROM historico_evento a WHERE a.id = ${antes})`
    : sql``;
  // as colunas de todo ramo, na mesma ordem (o UNION ALL casa por posição)
  const col = (o: {
    turma?: SQL;
    treinamento?: SQL;
    cert?: [SQL, SQL, SQL];
    pedido?: SQL;
    item?: SQL;
    sigla?: SQL;
  }) => sql`h.id, h.entidade, h.tipo_evento, h.ocorrido_em, h.usuario_id,
      (h.valor_novo #>> '{}') AS valor,
      ${o.turma ?? sql`NULL::text`} AS turma_codigo,
      ${o.treinamento ?? sql`NULL::text`} AS treinamento,
      ${o.cert?.[0] ?? sql`NULL::integer`} AS cert_numero,
      ${o.cert?.[1] ?? sql`NULL::integer`} AS cert_ano,
      ${o.cert?.[2] ?? sql`NULL::text`} AS cert_impresso,
      ${o.pedido ?? sql`NULL::text`} AS pedido,
      ${o.item ?? sql`NULL::text`} AS item,
      ${o.sigla ?? sql`NULL::text`} AS sigla`;
  const ramos: SQL[] = [];
  const ramo = (entidade: EntidadeDoTitular, montar: (tipos: SQL) => SQL) => {
    const tipos = _tipos(entidade, grupo);
    if (tipos.length) ramos.push(montar(_em(tipos)));
  };

  if (servidor_id !== null) {
    ramo(
      "certificado",
      (tipos) => sql`SELECT ${col({
        turma: sql`COALESCE(c.contexto_congelado ->> 'turma_codigo', t.codigo)::text`,
        treinamento: sql`COALESCE(c.contexto_congelado ->> 'treinamento_nome', tr.nome)::text`,
        cert: [sql`c.numero`, sql`c.ano`, sql`c.numero_impresso::text`],
        sigla: sql`u.sigla::text`,
      })}
      FROM historico_evento h
      JOIN certificado c ON c.id = h.entidade_id AND c.servidor_id = ${servidor_id}
      LEFT JOIN treinamento tr ON tr.id = c.treinamento_id
      LEFT JOIN inscricao i ON i.id = c.inscricao_id
      LEFT JOIN turma t ON t.id = i.turma_id
      LEFT JOIN unidade_uorg u ON u.id = t.unidade_promotora_id
      WHERE h.entidade = 'certificado' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
    // ESTADO_ALTERADO da inscrição: só as situações que têm frase
    const situacoes = _em(Object.keys(FRASE_SITUACAO_INSCRICAO));
    ramo(
      "inscricao",
      (tipos) => sql`SELECT ${col({
        turma: sql`t.codigo::text`,
        treinamento: sql`tr.nome::text`,
        sigla: sql`u.sigla::text`,
      })}
      FROM historico_evento h
      JOIN inscricao i ON i.id = h.entidade_id
      JOIN participante p ON p.id = i.participante_id AND p.servidor_id = ${servidor_id}
      JOIN turma t ON t.id = i.turma_id
      JOIN treinamento tr ON tr.id = t.treinamento_id
      LEFT JOIN unidade_uorg u ON u.id = t.unidade_promotora_id
      WHERE h.entidade = 'inscricao' AND h.tipo_evento IN (${tipos})
        AND (h.tipo_evento <> 'ESTADO_ALTERADO' OR (h.valor_novo #>> '{}') IN (${situacoes})) ${cursor}`,
    );
    ramo(
      "epi_requisicao",
      (tipos) => sql`SELECT ${col({ pedido: sql`r.protocolo::text` })}
      FROM historico_evento h
      JOIN epi_requisicao r ON r.id = h.entidade_id AND r.servidor_id = ${servidor_id}
      WHERE h.entidade = 'epi_requisicao' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
    ramo(
      "epi_requisicao_item",
      (tipos) => sql`SELECT ${col({ pedido: sql`r.protocolo::text`, item: sql`e.nome::text` })}
      FROM historico_evento h
      JOIN epi_requisicao_item ri ON ri.id = h.entidade_id
      JOIN epi_requisicao r ON r.id = ri.requisicao_id AND r.servidor_id = ${servidor_id}
      LEFT JOIN epi_item e ON e.id = ri.epi_item_id
      WHERE h.entidade = 'epi_requisicao_item' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
    ramo(
      "epi_ficha_registro",
      (tipos) => sql`SELECT ${col({
        item: sql`(f.nome_epi_snapshot || COALESCE(' (CA ' || f.numero_ca_snapshot || ')', ''))::text`,
      })}
      FROM historico_evento h
      JOIN epi_ficha_registro f ON f.id = h.entidade_id AND f.servidor_id = ${servidor_id}
      WHERE h.entidade = 'epi_ficha_registro' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
    ramo(
      "epi_comunicacao_titular",
      (tipos) => sql`SELECT ${col({ item: sql`f.nome_epi_snapshot::text` })}
      FROM historico_evento h
      JOIN epi_comunicacao_titular ct ON ct.id = h.entidade_id AND ct.servidor_id = ${servidor_id}
      LEFT JOIN epi_ficha_registro f ON f.id = ct.registro_id
      WHERE h.entidade = 'epi_comunicacao_titular' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
    ramo(
      "processo",
      (tipos) => sql`SELECT ${col({ pedido: sql`p.nup::text` })}
      FROM historico_evento h
      JOIN processo p ON p.id = h.entidade_id AND p.servidor_id = ${servidor_id}
      WHERE h.entidade = 'processo' AND h.tipo_evento IN (${tipos}) ${cursor}`,
    );
  }
  ramo(
    "usuario",
    (tipos) => sql`SELECT ${col({})}
    FROM historico_evento h
    WHERE h.entidade = 'usuario' AND h.entidade_id = ${usuario_id} AND h.tipo_evento IN (${tipos}) ${cursor}`,
  );
  if (!ramos.length) return [];

  const uniao = sql.join(
    ramos.map((r) => sql`(${r})`),
    sql` UNION ALL `,
  );
  const linhas = (await tx.execute(sql`
    SELECT x.*,
      (SELECT uo.sigla FROM unidade_uorg uo WHERE uo.nome_oficial = ${NOME_OFICIAL_CSSO}
        ORDER BY uo.ativo DESC, uo.id LIMIT 1)::text AS sigla_csso
    FROM (${uniao}) x
    ORDER BY x.ocorrido_em DESC, x.id DESC
    LIMIT ${limite}`)) as unknown as LinhaBruta[];
  return [...linhas];
}

function _objeto(l: LinhaBruta): string {
  const partes: string[] = [];
  switch (l.entidade) {
    case "inscricao":
      if (l.treinamento) partes.push(l.treinamento);
      if (l.turma_codigo) partes.push(`turma ${l.turma_codigo}`);
      break;
    case "certificado":
      if (l.treinamento) partes.push(l.treinamento);
      if (l.cert_numero !== null && l.cert_ano !== null) {
        partes.push(`Nº ${C.rotulo({ numero: Number(l.cert_numero), ano: Number(l.cert_ano), numero_impresso: l.cert_impresso })}`);
      }
      break;
    case "epi_requisicao":
      partes.push(l.pedido ? `Pedido ${l.pedido}` : "Pedido em rascunho");
      break;
    case "epi_requisicao_item":
      if (l.item) partes.push(l.item);
      partes.push(l.pedido ? `pedido ${l.pedido}` : "pedido em rascunho");
      break;
    case "epi_ficha_registro":
    case "epi_comunicacao_titular":
      if (l.item) partes.push(l.item);
      break;
    case "processo":
      if (l.pedido) partes.push(`Processo ${l.pedido}`);
      if (l.tipo_evento === "ESTADO_ALTERADO" && l.valor) {
        partes.push(Object.hasOwn(ROTULO_ESTADO_TELA, l.valor) ? ROTULO_ESTADO_TELA[l.valor]! : l.valor);
      }
      break;
    default:
      break;
  }
  return partes.join(" · ");
}

function _agente(l: LinhaBruta, definicao: EventoDoTitular, usuario_id: number): [string, boolean] {
  if (l.usuario_id !== null && Number(l.usuario_id) === usuario_id) return ["Você", true];
  if (l.usuario_id === null && definicao.agente_sem_conta) return [definicao.agente_sem_conta, false];
  let sigla: string | null = null;
  if (l.entidade === "inscricao" || l.entidade === "certificado") sigla = l.sigla;
  else if (l.entidade !== "usuario") sigla = l.sigla_csso;
  return [`Equipe ${(sigla ?? "").trim() || "SISA"}`, false];
}

function _rotulo_dia(dia: string, hoje: string): string {
  if (dia === hoje) return "Hoje";
  if (dia === somar_dias(hoje, -1)) return "Ontem";
  return datas_br.numerica(dia);
}

/**
 * A atividade do titular: uma página da linha do tempo, agrupada por dia.
 * Conta sem servidor só tem o ramo da própria conta (a tela explica o resto).
 */
export async function atividade_do_titular(
  tx: Executor,
  usuario: Pick<UsuarioAtual, "id" | "servidor_id">,
  filtro: FiltroAtividade = {},
  pagina: PaginaAtividade = {},
): Promise<AtividadeDoTitular> {
  const tamanho = pagina.tamanho ?? POR_PAGINA;
  const agora = pagina.agora ?? new Date();
  const linhas = await _linhas(
    tx,
    usuario.id,
    usuario.servidor_id ?? null,
    filtro.grupo ?? null,
    pagina.antes ?? null,
    tamanho + 1,
  );
  const ha_mais = linhas.length > tamanho;
  const visiveis = linhas.slice(0, tamanho);

  const hoje = datas_br.data_local(agora)!;
  const dias: DiaAtividade[] = [];
  for (const l of visiveis) {
    const definicao = evento_do_titular(l.entidade, l.tipo_evento);
    if (!definicao) continue; // a consulta já filtrou; isto é cinto e suspensório
    const titulo =
      typeof definicao.frase === "string" ? definicao.frase : (definicao.frase[l.valor ?? ""] ?? null);
    if (!titulo) continue;
    const quando = l.ocorrido_em instanceof Date ? l.ocorrido_em : new Date(l.ocorrido_em);
    const [agente, proprio] = _agente(l, definicao, usuario.id);
    const local = datas_br.local(quando)!;
    const dia = datas_br.data_local(quando)!;
    const item: ItemAtividade = {
      id: Number(l.id),
      grupo: definicao.grupo,
      icone: GRUPOS_ATIVIDADE.find((g) => g.codigo === definicao.grupo)!.icone,
      titulo,
      objeto: _objeto(l),
      agente,
      proprio,
      quando_iso: quando.toISOString(),
      quando_completo: datas_br.local_formatado(quando),
      quando_relativo: datas_br.tempo_relativo(quando, agora),
      hora: `${String(local.hora).padStart(2, "0")}:${String(local.minuto).padStart(2, "0")}`,
      dia,
    };
    const ultimo = dias.at(-1);
    if (ultimo && ultimo.dia === dia) ultimo.itens.push(item);
    else dias.push({ dia, rotulo: _rotulo_dia(dia, hoje), itens: [item] });
  }
  const ultimo = visiveis.at(-1);
  return {
    dias,
    total_na_pagina: visiveis.length,
    proximo_antes: ha_mais && ultimo ? Number(ultimo.id) : null,
  };
}
