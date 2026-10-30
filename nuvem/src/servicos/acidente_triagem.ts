/**
 * A triagem da ocorrência de acidente (fatia F1): assumir, mudar a situação,
 * pedir e responder complementação, cancelar, retificar a CAT/SP e prorrogar o
 * prazo de comunicação.
 *
 * Regras que valem em todo ato:
 *
 * - **A máquina G manda** (`exigir_transicao_acidente`); daqui só se vai a
 *   EM_TRIAGEM e a EM_INVESTIGACAO por "mudar a situação". Complementação e
 *   cancelamento têm o próprio ato, com o que cada um exige (texto do pedido;
 *   motivo da lista). Relatório, SIASS e conclusão são das fatias seguintes.
 * - **Controle otimista.** Todo ato da equipe leva a `versao` que a tela leu; se
 *   outra pessoa mudou a ocorrência no meio, o ato é recusado
 *   (`OcorrenciaAlterada`, 409) em vez de sobrescrever.
 * - **A CAT/SP é append-only.** A resposta à complementação e a retificação
 *   gravam a versão N+1 (com motivo e `substitui_id`) e atualizam as colunas
 *   espelho da ocorrência na MESMA instrução — a trava do banco só deixa os
 *   fatos mudarem junto com uma versão nova. A retificação NÃO mexe no estado.
 * - **Trilha sem nome.** As descrições levam protocolo, estados e campos, nunca
 *   o nome de quem se acidentou nem o texto do relato.
 */
import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_comunicante,
  acidente_complementacao,
  acidente_ocorrencia,
  pendencia as tabela_pendencia,
} from "../db/esquema/index.js";
import { MOTIVOS_CANCELAMENTO, MOTIVOS_REABERTURA, PRAZO_COMPLEMENTACAO_DIAS, PRAZO_INVESTIGACAO_DIAS, prazo_de_comunicacao } from "../dominio/acidente.js";
import { somar_dias, hoje_iso } from "../dominio/datas.js";
import { ACIDENTE_CANCELAVEL, ACIDENTE_ENCERRADO, ACIDENTE_REABRIVEL, exigir_transicao_acidente } from "../dominio/estados.js";
import { RegraViolada } from "../nucleo/erros.js";
import {
  ComunicacaoRecusada,
  cat_sp_vigente,
  conferir_fatos,
  conferir_relato,
  gravar_cat_sp,
  type ContextoCatSp,
  type Fatos,
  type Ocorrencia,
  type Relato,
} from "./acidente_comunicacao.js";
import * as acidente_email from "./acidente_email.js";
import * as auditoria from "./auditoria.js";
import * as pendencias from "./pendencias.js";
import { da_coordenacao, type UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

/** Outra pessoa mudou a ocorrência depois que a tela foi aberta. */
export class OcorrenciaAlterada extends RegraViolada {}

export const ENTIDADE = "acidente_ocorrencia";

/** Os destinos de "mudar a situação": o resto tem ato próprio. */
export const DESTINOS_DA_TRIAGEM: readonly string[] = ["EM_TRIAGEM", "EM_INVESTIGACAO"];

const TAMANHO_PEDIDO = 2000;
const TAMANHO_MOTIVO = 1000;

function _exigir_aberta(ocorrencia: Ocorrencia): void {
  if (ACIDENTE_ENCERRADO.has(ocorrencia.estado)) {
    throw new RegraViolada(
      `A ocorrência ${ocorrencia.protocolo} está encerrada. Se o caso voltou, comunique de novo: a reabertura é uma ocorrência nova.`,
    );
  }
}

function _texto_obrigatorio(valor: string | null | undefined, campo: string, maximo: number): string {
  const v = (valor ?? "").trim();
  if (!v) throw new ComunicacaoRecusada(`Escreva ${campo}.`, campo);
  if (v.length > maximo) throw new ComunicacaoRecusada(`O campo ${campo} passa de ${maximo} caracteres.`, campo);
  try {
    textos.exigir_texto_limpo(v, campo, textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new ComunicacaoRecusada(
      `O campo ${campo} tem termo de saúde ou dado sensível. Escreva o que falta sobre o EVENTO; ` +
        "saúde é registrada pelo médico do trabalho, em campo próprio.",
      campo,
    );
  }
  return v;
}

/**
 * Grava o trâmite com o controle otimista: só se a `versao` ainda é a lida.
 * Devolve a linha nova; sem linha, alguém passou na frente.
 */
async function _gravar(
  tx: Executor,
  ocorrencia: Ocorrencia,
  versao_lida: number,
  mudanca: Partial<typeof acidente_ocorrencia.$inferInsert>,
): Promise<Ocorrencia> {
  const [nova] = await tx
    .update(acidente_ocorrencia)
    .set({ ...mudanca, versao: versao_lida + 1 })
    .where(and(eq(acidente_ocorrencia.id, ocorrencia.id), eq(acidente_ocorrencia.versao, versao_lida)))
    .returning();
  if (!nova) {
    throw new OcorrenciaAlterada(
      `A ocorrência ${ocorrencia.protocolo} foi alterada por outra pessoa depois que você abriu a tela. ` +
        "Recarregue a ficha, confira o que mudou e refaça o que pretendia.",
    );
  }
  Object.assign(ocorrencia, nova);
  return nova;
}

async function _pendencia_aberta(tx: Executor, chave: string) {
  const [p] = await tx
    .select()
    .from(tabela_pendencia)
    .where(and(eq(tabela_pendencia.chave, chave), eq(tabela_pendencia.concluida, false)));
  return p ?? null;
}

async function _fechar(tx: Executor, chave: string, usuario: UsuarioAtual): Promise<void> {
  const p = await _pendencia_aberta(tx, chave);
  if (p) await pendencias.concluir(tx, p, usuario);
}

async function _estado_alterado(tx: Executor, ocorrencia: Ocorrencia, de: string, para: string, usuario: UsuarioAtual) {
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ESTADO_ALTERADO,
    descricao: `${ocorrencia.protocolo}: situação ${de} → ${para}.`,
    campo: "estado",
    valor_anterior: de,
    valor_novo: para,
    usuario,
  });
}

/** Saindo de RECEBIDA, a tarefa de triar acabou. */
async function _saiu_de_recebida(tx: Executor, ocorrencia: Ocorrencia, de: string, usuario: UsuarioAtual) {
  if (de === "RECEBIDA") await _fechar(tx, `ACIDENTE_TRIAR:${ocorrencia.id}`, usuario);
}

// ---------------------------------------------------------------------
// Assumir
// ---------------------------------------------------------------------
/** Quem assume conduz o caso; a ocorrência RECEBIDA passa à triagem. */
export async function assumir(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, versao: number): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  const de = ocorrencia.estado;
  const para = de === "RECEBIDA" ? "EM_TRIAGEM" : de;
  if (para !== de) exigir_transicao_acidente(de, para);
  const anterior = ocorrencia.responsavel_id;
  await _gravar(tx, ocorrencia, versao, { responsavel_id: usuario.id, estado: para });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ASSUMIDO,
    descricao: `${ocorrencia.protocolo} assumida${anterior && anterior !== usuario.id ? " (passou de outra pessoa da equipe)" : ""}.`,
    campo: "responsavel_id",
    valor_anterior: anterior === null ? null : String(anterior),
    valor_novo: String(usuario.id),
    usuario,
  });
  if (para !== de) await _estado_alterado(tx, ocorrencia, de, para, usuario);
  await _saiu_de_recebida(tx, ocorrencia, de, usuario);
  // o prazo legal passa a ser de quem conduz
  const prazo = await _pendencia_aberta(tx, `ACIDENTE_PRAZO_COMUNICACAO:${ocorrencia.id}`);
  if (prazo) await tx.update(tabela_pendencia).set({ responsavel_id: usuario.id }).where(eq(tabela_pendencia.id, prazo.id));
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Mudar a situação
// ---------------------------------------------------------------------
export async function mudar_estado(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  destino: string,
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  if (!DESTINOS_DA_TRIAGEM.includes(destino)) {
    throw new RegraViolada(
      "Por aqui a ocorrência vai para a triagem ou para a investigação. Pedir complementação e cancelar têm botão próprio; " +
        "relatório e SIASS, as abas deles.",
    );
  }
  const de = ocorrencia.estado;
  exigir_transicao_acidente(de, destino);
  await _gravar(tx, ocorrencia, versao, {
    estado: destino,
    // quem leva o caso adiante sem tê-lo assumido passa a conduzi-lo
    responsavel_id: ocorrencia.responsavel_id ?? usuario.id,
  });
  await _estado_alterado(tx, ocorrencia, de, destino, usuario);
  await _saiu_de_recebida(tx, ocorrencia, de, usuario);
  if (de === "AGUARDANDO_COMPLEMENTACAO") {
    // a equipe retomou sem a resposta: a tarefa do comunicante perde o objeto
    const aberta = await _complementacao_aberta(tx, ocorrencia.id);
    if (aberta) await _fechar(tx, `ACIDENTE_COMPLEMENTACAO:${aberta.id}`, usuario);
  }
  if (destino === "EM_INVESTIGACAO") {
    await pendencias.abrir(tx, {
      tipo: "ACIDENTE_INVESTIGAR",
      chave: `ACIDENTE_INVESTIGAR:${ocorrencia.id}`,
      descricao: `Investigar ${ocorrencia.protocolo} e emitir o relatório`,
      entidade: ENTIDADE,
      entidade_id: ocorrencia.id,
      responsavel_id: ocorrencia.responsavel_id,
      prazo: somar_dias(hoje_iso(), PRAZO_INVESTIGACAO_DIAS),
      usuario,
    });
  }
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Complementação
// ---------------------------------------------------------------------
async function _complementacao_aberta(tx: Executor, ocorrencia_id: number) {
  const linhas = await tx
    .select()
    .from(acidente_complementacao)
    .where(eq(acidente_complementacao.ocorrencia_id, ocorrencia_id))
    .orderBy(acidente_complementacao.id);
  return linhas.find((l) => l.respondida_em === null) ?? null;
}

export { _complementacao_aberta as complementacao_aberta };

async function _comunicante(tx: Executor, ocorrencia_id: number) {
  const [c] = await tx.select().from(acidente_comunicante).where(eq(acidente_comunicante.ocorrencia_id, ocorrencia_id));
  return c ?? null;
}

/** Quem pode responder: quem comunicou com a própria conta, ou o próprio acidentado servidor. */
export async function pode_responder(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia): Promise<boolean> {
  if (!usuario.pode("acidente.comunicar")) return false;
  const comunicante = await _comunicante(tx, ocorrencia.id);
  if (comunicante?.usuario_id === usuario.id) return true;
  return usuario.servidor_id !== null && ocorrencia.servidor_id === usuario.servidor_id;
}

export async function pedir_complementacao(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  texto: string,
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  const pedido = _texto_obrigatorio(texto, "o que falta na comunicação", TAMANHO_PEDIDO);
  const de = ocorrencia.estado;
  exigir_transicao_acidente(de, "AGUARDANDO_COMPLEMENTACAO");
  const comunicante = await _comunicante(tx, ocorrencia.id);
  // quem responde: a conta que comunicou; sem ela, a do acidentado servidor
  const responde = comunicante?.usuario_id ?? null;
  if (responde === null) {
    throw new RegraViolada(
      "Esta comunicação não veio de uma conta do sistema, então ninguém poderia responder por aqui. " +
        "Peça o que falta pelo canal por onde ela chegou e retifique a CAT/SP com a resposta.",
    );
  }
  await _gravar(tx, ocorrencia, versao, { estado: "AGUARDANDO_COMPLEMENTACAO", responsavel_id: ocorrencia.responsavel_id ?? usuario.id });
  const [linha] = await tx
    .insert(acidente_complementacao)
    .values({ ocorrencia_id: ocorrencia.id, pedido_texto: pedido, pedido_por: usuario.id })
    .returning();
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_COMPLEMENTACAO_PEDIDA,
    descricao: `${ocorrencia.protocolo}: complementação pedida a quem comunicou (prazo de ${PRAZO_COMPLEMENTACAO_DIAS} dias).`,
    usuario,
  });
  await _estado_alterado(tx, ocorrencia, de, "AGUARDANDO_COMPLEMENTACAO", usuario);
  await pendencias.abrir(tx, {
    tipo: "ACIDENTE_COMPLEMENTACAO",
    chave: `ACIDENTE_COMPLEMENTACAO:${linha!.id}`,
    descricao: `Complementar a comunicação ${ocorrencia.protocolo}`,
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    responsavel_id: responde,
    prazo: somar_dias(hoje_iso(), PRAZO_COMPLEMENTACAO_DIAS),
    usuario,
  });
  await acidente_email.avisar_complementacao(tx, ocorrencia, responde, usuario);
  return ocorrencia;
}

/**
 * A resposta vira a versão N+1 da CAT/SP (origem COMPLEMENTACAO) e devolve a
 * ocorrência à triagem. Responde quem comunicou ou o próprio acidentado.
 */
export async function responder_complementacao(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  resposta: string,
): Promise<Ocorrencia> {
  if (!(await pode_responder(tx, usuario, ocorrencia))) {
    throw new RegraViolada("Só quem comunicou o acidente, ou o próprio acidentado, responde a complementação.");
  }
  if (ocorrencia.estado !== "AGUARDANDO_COMPLEMENTACAO") {
    throw new RegraViolada(`A ocorrência ${ocorrencia.protocolo} não está aguardando complementação.`);
  }
  const pedido = await _complementacao_aberta(tx, ocorrencia.id);
  if (!pedido) throw new RegraViolada(`Não há pedido de complementação aberto em ${ocorrencia.protocolo}.`);
  const texto = _texto_obrigatorio(resposta, "a sua resposta", TAMANHO_PEDIDO);
  const atual = await cat_sp_vigente(tx, ocorrencia);
  if (!atual) throw new Error(`ocorrência ${ocorrencia.id} sem CAT/SP vigente`);
  const contexto = structuredClone(atual.contexto_congelado) as ContextoCatSp;
  const versao_cat = atual.versao + 1;
  contexto.versao = versao_cat;
  contexto.complementacoes = [
    ...(contexto.complementacoes ?? []),
    { pedido: pedido.pedido_texto, resposta: texto, respondida_em: new Date().toISOString() },
  ];
  const nova = await gravar_cat_sp(tx, {
    ocorrencia_id: ocorrencia.id,
    versao: versao_cat,
    contexto,
    origem: "COMPLEMENTACAO",
    registrada_por: usuario.id,
    substitui_id: atual.id,
    motivo_retificacao: "Resposta ao pedido de complementação",
  });
  await tx
    .update(acidente_complementacao)
    .set({ resposta_cat_sp_id: nova.id, respondida_por: usuario.id, respondida_em: new Date() })
    .where(eq(acidente_complementacao.id, pedido.id));
  // quem responde não é da equipe: sem controle otimista da tela, mas com a
  // versão atual (a mudança de trâmite e a da CAT/SP vão juntas)
  const de = ocorrencia.estado;
  exigir_transicao_acidente(de, "EM_TRIAGEM");
  await _gravar(tx, ocorrencia, ocorrencia.versao, { estado: "EM_TRIAGEM", cat_sp_versao: versao_cat });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_COMPLEMENTACAO_RESPONDIDA,
    descricao: `${ocorrencia.protocolo}: complementação respondida; CAT/SP versão ${versao_cat}.`,
    usuario,
  });
  await _estado_alterado(tx, ocorrencia, de, "EM_TRIAGEM", usuario);
  const p = await _pendencia_aberta(tx, `ACIDENTE_COMPLEMENTACAO:${pedido.id}`);
  if (p) await pendencias.concluir(tx, p, usuario);
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------
export async function cancelar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  motivo: string,
  texto: string | null,
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  if (!ACIDENTE_CANCELAVEL.has(ocorrencia.estado)) {
    throw new RegraViolada(
      `A ocorrência ${ocorrencia.protocolo} já está em investigação: cancelar só cabe antes disso. ` +
        "Se não era acidente em serviço, isso vai no relatório.",
    );
  }
  if (!(MOTIVOS_CANCELAMENTO as readonly string[]).includes(motivo)) {
    throw new ComunicacaoRecusada("Escolha o motivo do cancelamento na lista.", "o motivo");
  }
  const explicacao = (texto ?? "").trim() || null;
  if (motivo === "OUTRO" && !explicacao) {
    throw new ComunicacaoRecusada("Com o motivo “outro”, explique por que a ocorrência é cancelada.", "a explicação");
  }
  if (explicacao) _texto_obrigatorio(explicacao, "a explicação", TAMANHO_MOTIVO);
  const de = ocorrencia.estado;
  exigir_transicao_acidente(de, "CANCELADA");
  await _gravar(tx, ocorrencia, versao, { estado: "CANCELADA", cancelamento_motivo: motivo, cancelamento_texto: explicacao });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_CANCELADO,
    descricao: `${ocorrencia.protocolo} cancelada: ${motivo}.`,
    campo: "estado",
    valor_anterior: de,
    valor_novo: "CANCELADA",
    usuario,
  });
  // as tarefas da ocorrência perdem o objeto
  const abertas = await tx
    .select()
    .from(tabela_pendencia)
    .where(
      and(
        eq(tabela_pendencia.entidade, ENTIDADE),
        eq(tabela_pendencia.entidade_id, ocorrencia.id),
        eq(tabela_pendencia.concluida, false),
      ),
    );
  for (const p of abertas) await pendencias.concluir(tx, p, usuario);
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Reabrir (coordenação)
// ---------------------------------------------------------------------
/**
 * Devolve à investigação o caso com relatório emitido, encaminhado ao SIASS ou
 * concluído. A investigação destrava; o relatório novo sai pela retificação. O
 * motivo é da lista (a trilha não leva texto livre).
 */
export async function reabrir(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  motivo: string,
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  if (!da_coordenacao(usuario)) throw new RegraViolada("Reabrir a investigação é com a coordenação.");
  const de = ocorrencia.estado;
  if (!ACIDENTE_REABRIVEL.has(de)) {
    throw new RegraViolada(`A ocorrência ${ocorrencia.protocolo} não está num ponto em que se reabra a investigação.`);
  }
  if (!(MOTIVOS_REABERTURA as readonly string[]).includes(motivo)) {
    throw new ComunicacaoRecusada("Escolha o motivo da reabertura na lista.", "o motivo");
  }
  await _gravar(tx, ocorrencia, versao, {
    estado: "EM_INVESTIGACAO",
    concluida_em: null,
    responsavel_id: ocorrencia.responsavel_id ?? usuario.id,
  });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_REABERTO,
    descricao: `${ocorrencia.protocolo} reaberta: ${motivo}.`,
    campo: "estado",
    valor_anterior: de,
    valor_novo: "EM_INVESTIGACAO",
    usuario,
  });
  await pendencias.abrir(tx, {
    tipo: "ACIDENTE_INVESTIGAR",
    chave: `ACIDENTE_INVESTIGAR:${ocorrencia.id}`,
    descricao: `Investigar ${ocorrencia.protocolo} e emitir o relatório`,
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    responsavel_id: ocorrencia.responsavel_id,
    prazo: somar_dias(hoje_iso(), PRAZO_INVESTIGACAO_DIAS),
    usuario,
  });
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Retificar a CAT/SP
// ---------------------------------------------------------------------
export async function retificar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  d: { fatos: Fatos; relato: Relato; motivo: string },
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  const motivo = _texto_obrigatorio(d.motivo, "o motivo da retificação", TAMANHO_MOTIVO);
  const fatos = await conferir_fatos(tx, d.fatos);
  const relato = conferir_relato(d.relato);
  const atual = await cat_sp_vigente(tx, ocorrencia);
  if (!atual) throw new Error(`ocorrência ${ocorrencia.id} sem CAT/SP vigente`);
  const contexto = structuredClone(atual.contexto_congelado) as ContextoCatSp;
  // o campus é do local; vazio na retificação, fica o que estava
  const campus_id = fatos.campus_id ?? ocorrencia.campus_id;
  const antes = { ...contexto.fatos, ...contexto.relato } as Record<string, unknown>;
  const depois = { ...fatos, campus_id, ...relato } as Record<string, unknown>;
  const mudaram = Object.keys(depois).filter((k) => JSON.stringify(antes[k] ?? null) !== JSON.stringify(depois[k] ?? null));
  if (!mudaram.length) throw new ComunicacaoRecusada("Nada mudou em relação à versão vigente da CAT/SP.", null);
  const versao_cat = atual.versao + 1;
  contexto.versao = versao_cat;
  contexto.fatos = { ...fatos, campus_id };
  contexto.relato = relato;
  await gravar_cat_sp(tx, {
    ocorrencia_id: ocorrencia.id,
    versao: versao_cat,
    contexto,
    origem: "RETIFICACAO_SST",
    registrada_por: usuario.id,
    substitui_id: atual.id,
    motivo_retificacao: motivo,
  });
  // os fatos mudam junto com a versão nova (a trava confere); o estado, não
  await _gravar(tx, ocorrencia, versao, {
    especie: fatos.especie,
    data_evento: fatos.data_evento,
    hora_evento: fatos.hora_evento,
    minutos_apos_inicio_jornada: fatos.minutos_apos_inicio_jornada,
    ultimo_dia_trabalho: fatos.ultimo_dia_trabalho,
    local_tipo: fatos.local_tipo,
    local_especificacao: fatos.local_especificacao,
    campus_id,
    local_municipio: fatos.local_municipio,
    local_uf: fatos.local_uf,
    local_cnpj_contratada: fatos.local_cnpj_contratada,
    transito_registro_policial: fatos.transito_registro_policial,
    transito_numero_bo: fatos.transito_numero_bo,
    transito_vitima_terceiros: fatos.transito_vitima_terceiros,
    agente_causador_id: fatos.agente_causador_id,
    agente_doenca_id: fatos.agente_doenca_id,
    situacao_geradora_id: fatos.situacao_geradora_id,
    prazo_comunicacao: prazo_de_comunicacao(fatos.data_evento),
    cat_sp_versao: versao_cat,
  });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_CAT_SP_RETIFICADA,
    // os nomes dos campos, não os valores (o relato fica na CAT/SP)
    descricao: `${ocorrencia.protocolo}: CAT/SP retificada para a versão ${versao_cat} (${mudaram.join(", ")}). Motivo: ${motivo}`,
    usuario,
  });
  if (mudaram.includes("data_evento")) {
    const prazo = await _pendencia_aberta(tx, `ACIDENTE_PRAZO_COMUNICACAO:${ocorrencia.id}`);
    if (prazo) {
      await tx
        .update(tabela_pendencia)
        .set({ prazo: ocorrencia.prazo_comunicacao })
        .where(eq(tabela_pendencia.id, prazo.id));
    }
  }
  return ocorrencia;
}

// ---------------------------------------------------------------------
// Prorrogar o prazo de comunicação
// ---------------------------------------------------------------------
/** D13: a prorrogação fica ao lado do prazo legal, com motivo; o prazo legal não muda. */
export async function prorrogar_prazo(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  ate: string,
  motivo: string,
  versao: number,
): Promise<Ocorrencia> {
  usuario.exigir("acidente.triar");
  _exigir_aberta(ocorrencia);
  const data = (ate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data <= ocorrencia.prazo_comunicacao) {
    throw new ComunicacaoRecusada(
      `A nova data tem de ser depois do prazo legal (${ocorrencia.prazo_comunicacao.split("-").reverse().join("/")}).`,
      "a nova data",
    );
  }
  const texto = _texto_obrigatorio(motivo, "o motivo da prorrogação", TAMANHO_MOTIVO);
  const anterior = ocorrencia.prazo_prorrogado_ate;
  await _gravar(tx, ocorrencia, versao, {
    prazo_prorrogado_ate: data,
    prorrogacao_motivo: texto,
    prorrogado_por: usuario.id,
    prorrogado_em: new Date(),
  });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_PRAZO_PRORROGADO,
    descricao: `${ocorrencia.protocolo}: prazo de comunicação prorrogado. Motivo: ${texto}`,
    campo: "prazo_prorrogado_ate",
    valor_anterior: anterior,
    valor_novo: data,
    usuario,
  });
  const prazo = await _pendencia_aberta(tx, `ACIDENTE_PRAZO_COMUNICACAO:${ocorrencia.id}`);
  if (prazo) await tx.update(tabela_pendencia).set({ prazo: data }).where(eq(tabela_pendencia.id, prazo.id));
  return ocorrencia;
}
