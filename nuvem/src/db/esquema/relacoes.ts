/**
 * As `relationship()` do SQLAlchemy, como `relations()` do Drizzle.
 *
 * Os nomes sao os MESMOS do Python (`processo.servidor`, `parecer.exposicoes`,
 * `turma.instrutores`...), para que `db.query.x.findMany({ with: {...} })`
 * devolva objetos com a forma que os templates ja leem.
 *
 * Tres diferencas que quem porta servico precisa saber:
 *
 * 1. **Nada vem sozinho.** No Python quase toda relacao era `lazy="selectin"`:
 *    carregava junto, sempre. Aqui so vem o que o `with` pedir, e o que nao foi
 *    pedido simplesmente nao existe no objeto (nao ha lazy load).
 * 2. **Ordem nao e da relacao.** O `order_by` do `relationship()` nao tem
 *    equivalente no `relations()`; quem carrega tem de pedir a ordem no `with`.
 *    As ordens do Python estao anotadas em cada relacao abaixo — sem elas,
 *    `mapa_de_tags`, `email_exibicao` e a lista de postos mudam de resultado.
 * 3. **Muitos-para-muitos passa pela tabela de ligacao.** `Perfil.permissoes` e
 *    `Permissao.perfis` usavam `secondary=`; o Drizzle nao atravessa a ligacao
 *    sozinho, entao aqui a relacao e `perfil_permissoes` (linhas de
 *    `perfil_permissao`, cada uma com `.permissao` / `.perfil`). O nome mudou de
 *    proposito: com o nome antigo e a forma nova, `p.codigo` de um template
 *    portado as cegas devolveria `undefined` em silencio.
 *
 * Uma relacao existe aqui sem par no Python (`lotacao_posto.lotacao`): o
 * Drizzle exige o lado `one` para montar o lado `many`. Esta marcada
 * "(so Drizzle)".
 */

import { relations } from 'drizzle-orm';

import { checklist, checklist_item, pendencia } from './auditoria';
import { demanda, demanda_encaminhamento } from './demanda';
import {
  agente_nocivo,
  checklist_modelo,
  fluxo_etapa,
  fundamentacao_legal,
  percentual_aplicavel,
  tipo_adicional,
  tipo_marco_inicial,
  tipo_movimento,
  tipo_processo,
  tipo_risco,
} from './dominios';
import {
  epi_categoria,
  epi_entrada_estoque,
  epi_ficha_registro,
  epi_item,
  epi_motivo_recusa,
  epi_requisicao,
  epi_requisicao_item,
} from './epi';
import {
  campus,
  cargo,
  lotacao_posto,
  portaria_localizacao,
  posto_trabalho,
  servidor,
  servidor_lotacao,
  unidade_uorg,
} from './organizacao';
import {
  adicional_vigencia,
  exposicao,
  laudo_posto,
  laudo_tecnico,
  parecer_posto,
  parecer_tecnico,
  processo,
} from './processo';
import {
  atribuicao,
  autoridade_destinataria,
  perfil,
  perfil_permissao,
  permissao,
  profissional_habilitado,
  sessao,
  setor_emissor,
  usuario,
} from './seguranca';
import {
  assinatura_instrutor,
  certificado,
  certificado_modelo,
  certificado_modelo_tag,
  inscricao,
  participante,
  participante_email,
  treinamento,
  turma,
  turma_instrutor,
  turma_presenca,
} from './treinamento';

// ---------------------------------------------------------------------
// dominios.py
// ---------------------------------------------------------------------
export const tipo_adicional_relacoes = relations(tipo_adicional, ({ many }) => ({
  percentuais: many(percentual_aplicavel),
}));

export const percentual_aplicavel_relacoes = relations(percentual_aplicavel, ({ one }) => ({
  tipo_adicional: one(tipo_adicional, {
    fields: [percentual_aplicavel.tipo_adicional_id],
    references: [tipo_adicional.id],
  }),
}));

export const fundamentacao_legal_relacoes = relations(fundamentacao_legal, ({ one }) => ({
  tipo_risco: one(tipo_risco, {
    fields: [fundamentacao_legal.tipo_risco_id],
    references: [tipo_risco.id],
  }),
}));

export const agente_nocivo_relacoes = relations(agente_nocivo, ({ one }) => ({
  tipo_risco: one(tipo_risco, {
    fields: [agente_nocivo.tipo_risco_id],
    references: [tipo_risco.id],
  }),
  fundamentacao: one(fundamentacao_legal, {
    fields: [agente_nocivo.fundamentacao_id],
    references: [fundamentacao_legal.id],
  }),
}));

export const checklist_modelo_relacoes = relations(checklist_modelo, ({ one }) => ({
  tipo_processo: one(tipo_processo, {
    fields: [checklist_modelo.tipo_processo_id],
    references: [tipo_processo.id],
  }),
}));

// ---------------------------------------------------------------------
// organizacao.py
// ---------------------------------------------------------------------
export const unidade_uorg_relacoes = relations(unidade_uorg, ({ one, many }) => ({
  campus: one(campus, { fields: [unidade_uorg.campus_id], references: [campus.id] }),
  postos: many(posto_trabalho, { relationName: 'unidade_postos' }),
}));

export const posto_trabalho_relacoes = relations(posto_trabalho, ({ one }) => ({
  unidade: one(unidade_uorg, {
    fields: [posto_trabalho.unidade_uorg_id],
    references: [unidade_uorg.id],
    relationName: 'unidade_postos',
  }),
}));

export const servidor_relacoes = relations(servidor, ({ one, many }) => ({
  cargo: one(cargo, { fields: [servidor.cargo_id], references: [cargo.id] }),
  unidade: one(unidade_uorg, { fields: [servidor.unidade_uorg_id], references: [unidade_uorg.id] }),
  uorg: one(unidade_uorg, { fields: [servidor.uorg_id], references: [unidade_uorg.id] }),
  // ordem do Python: servidor_lotacao.vigencia_inicio
  lotacoes: many(servidor_lotacao, { relationName: 'servidor_lotacoes' }),
}));

export const lotacao_posto_relacoes = relations(lotacao_posto, ({ one }) => ({
  posto: one(posto_trabalho, {
    fields: [lotacao_posto.posto_trabalho_id],
    references: [posto_trabalho.id],
  }),
  // (so Drizzle) o par de `servidor_lotacao.vinculos_posto`
  lotacao: one(servidor_lotacao, {
    fields: [lotacao_posto.lotacao_id],
    references: [servidor_lotacao.id],
    relationName: 'lotacao_vinculos_posto',
  }),
}));

export const servidor_lotacao_relacoes = relations(servidor_lotacao, ({ one, many }) => ({
  servidor: one(servidor, {
    fields: [servidor_lotacao.servidor_id],
    references: [servidor.id],
    relationName: 'servidor_lotacoes',
  }),
  unidade: one(unidade_uorg, {
    fields: [servidor_lotacao.unidade_uorg_id],
    references: [unidade_uorg.id],
  }),
  uorg: one(unidade_uorg, { fields: [servidor_lotacao.uorg_id], references: [unidade_uorg.id] }),
  cargo: one(cargo, { fields: [servidor_lotacao.cargo_id], references: [cargo.id] }),
  // ordem do Python: lotacao_posto.ordem. A `@property postos` do Python e
  // `ServidorLotacao.postos()` em src/dominio/organizacao.ts.
  vinculos_posto: many(lotacao_posto, { relationName: 'lotacao_vinculos_posto' }),
}));

export const portaria_localizacao_relacoes = relations(portaria_localizacao, ({ one }) => ({
  unidade_emissora: one(unidade_uorg, {
    fields: [portaria_localizacao.unidade_emissora_id],
    references: [unidade_uorg.id],
  }),
}));

// ---------------------------------------------------------------------
// seguranca.py
// ---------------------------------------------------------------------
export const usuario_relacoes = relations(usuario, ({ many }) => ({
  atribuicoes: many(atribuicao, { relationName: 'usuario_atribuicoes' }),
}));

export const perfil_relacoes = relations(perfil, ({ many }) => ({
  // era `permissoes` (secondary=perfil_permissao) — ver o cabecalho
  perfil_permissoes: many(perfil_permissao),
}));

export const permissao_relacoes = relations(permissao, ({ many }) => ({
  // era `perfis` (secondary=perfil_permissao) — ver o cabecalho
  perfil_permissoes: many(perfil_permissao),
}));

export const perfil_permissao_relacoes = relations(perfil_permissao, ({ one }) => ({
  perfil: one(perfil, { fields: [perfil_permissao.perfil_id], references: [perfil.id] }),
  permissao: one(permissao, {
    fields: [perfil_permissao.permissao_id],
    references: [permissao.id],
  }),
}));

export const atribuicao_relacoes = relations(atribuicao, ({ one }) => ({
  usuario: one(usuario, {
    fields: [atribuicao.usuario_id],
    references: [usuario.id],
    relationName: 'usuario_atribuicoes',
  }),
  perfil: one(perfil, { fields: [atribuicao.perfil_id], references: [perfil.id] }),
}));

export const sessao_relacoes = relations(sessao, ({ one }) => ({
  usuario: one(usuario, { fields: [sessao.usuario_id], references: [usuario.id] }),
}));

// ---------------------------------------------------------------------
// processo.py
// ---------------------------------------------------------------------
export const processo_relacoes = relations(processo, ({ one, many }) => ({
  tipo_processo: one(tipo_processo, {
    fields: [processo.tipo_processo_id],
    references: [tipo_processo.id],
  }),
  etapa: one(fluxo_etapa, { fields: [processo.etapa_id], references: [fluxo_etapa.id] }),
  servidor: one(servidor, { fields: [processo.servidor_id], references: [servidor.id] }),
  unidade: one(unidade_uorg, { fields: [processo.unidade_uorg_id], references: [unidade_uorg.id] }),
  responsavel: one(usuario, { fields: [processo.responsavel_id], references: [usuario.id] }),
  pareceres: many(parecer_tecnico, { relationName: 'processo_pareceres' }),
}));

export const laudo_tecnico_relacoes = relations(laudo_tecnico, ({ one, many }) => ({
  tipo_adicional: one(tipo_adicional, {
    fields: [laudo_tecnico.tipo_adicional_id],
    references: [tipo_adicional.id],
  }),
  unidade: one(unidade_uorg, {
    fields: [laudo_tecnico.unidade_uorg_id],
    references: [unidade_uorg.id],
  }),
  subscritor: one(profissional_habilitado, {
    fields: [laudo_tecnico.subscritor_id],
    references: [profissional_habilitado.id],
  }),
  postos: many(laudo_posto, { relationName: 'laudo_postos' }),
}));

export const laudo_posto_relacoes = relations(laudo_posto, ({ one }) => ({
  laudo: one(laudo_tecnico, {
    fields: [laudo_posto.laudo_id],
    references: [laudo_tecnico.id],
    relationName: 'laudo_postos',
  }),
  posto: one(posto_trabalho, {
    fields: [laudo_posto.posto_trabalho_id],
    references: [posto_trabalho.id],
  }),
}));

export const parecer_tecnico_relacoes = relations(parecer_tecnico, ({ one, many }) => ({
  processo: one(processo, {
    fields: [parecer_tecnico.processo_id],
    references: [processo.id],
    relationName: 'processo_pareceres',
  }),
  servidor: one(servidor, { fields: [parecer_tecnico.servidor_id], references: [servidor.id] }),
  laudo: one(laudo_tecnico, { fields: [parecer_tecnico.laudo_id], references: [laudo_tecnico.id] }),
  tipo_adicional: one(tipo_adicional, {
    fields: [parecer_tecnico.tipo_adicional_id],
    references: [tipo_adicional.id],
  }),
  tipo_movimento: one(tipo_movimento, {
    fields: [parecer_tecnico.tipo_movimento_id],
    references: [tipo_movimento.id],
  }),
  unidade: one(unidade_uorg, {
    fields: [parecer_tecnico.unidade_uorg_id],
    references: [unidade_uorg.id],
  }),
  uorg: one(unidade_uorg, { fields: [parecer_tecnico.uorg_id], references: [unidade_uorg.id] }),
  portaria: one(portaria_localizacao, {
    fields: [parecer_tecnico.portaria_id],
    references: [portaria_localizacao.id],
  }),
  destinatario: one(autoridade_destinataria, {
    fields: [parecer_tecnico.destinatario_id],
    references: [autoridade_destinataria.id],
  }),
  signatario: one(profissional_habilitado, {
    fields: [parecer_tecnico.signatario_id],
    references: [profissional_habilitado.id],
  }),
  setor_emissor: one(setor_emissor, {
    fields: [parecer_tecnico.setor_emissor_id],
    references: [setor_emissor.id],
  }),
  tipo_marco: one(tipo_marco_inicial, {
    fields: [parecer_tecnico.tipo_marco_id],
    references: [tipo_marco_inicial.id],
  }),
  // sem order_by no Python (a ordem de exibicao vem de parecer_posto.ordem,
  // que o servico aplica)
  postos: many(parecer_posto, { relationName: 'parecer_postos' }),
  exposicoes: many(exposicao, { relationName: 'parecer_exposicoes' }),
}));

export const parecer_posto_relacoes = relations(parecer_posto, ({ one }) => ({
  parecer: one(parecer_tecnico, {
    fields: [parecer_posto.parecer_id],
    references: [parecer_tecnico.id],
    relationName: 'parecer_postos',
  }),
  posto: one(posto_trabalho, {
    fields: [parecer_posto.posto_trabalho_id],
    references: [posto_trabalho.id],
  }),
}));

export const exposicao_relacoes = relations(exposicao, ({ one }) => ({
  parecer: one(parecer_tecnico, {
    fields: [exposicao.parecer_id],
    references: [parecer_tecnico.id],
    relationName: 'parecer_exposicoes',
  }),
  agente_nocivo: one(agente_nocivo, {
    fields: [exposicao.agente_nocivo_id],
    references: [agente_nocivo.id],
  }),
  percentual: one(percentual_aplicavel, {
    fields: [exposicao.percentual_id],
    references: [percentual_aplicavel.id],
  }),
  fundamentacao: one(fundamentacao_legal, {
    fields: [exposicao.fundamentacao_id],
    references: [fundamentacao_legal.id],
  }),
}));

export const adicional_vigencia_relacoes = relations(adicional_vigencia, ({ one }) => ({
  servidor: one(servidor, { fields: [adicional_vigencia.servidor_id], references: [servidor.id] }),
  parecer: one(parecer_tecnico, {
    fields: [adicional_vigencia.parecer_id],
    references: [parecer_tecnico.id],
  }),
  tipo_adicional: one(tipo_adicional, {
    fields: [adicional_vigencia.tipo_adicional_id],
    references: [tipo_adicional.id],
  }),
  percentual: one(percentual_aplicavel, {
    fields: [adicional_vigencia.percentual_id],
    references: [percentual_aplicavel.id],
  }),
}));

// ---------------------------------------------------------------------
// auditoria.py
// ---------------------------------------------------------------------
export const checklist_relacoes = relations(checklist, ({ many }) => ({
  itens: many(checklist_item),
}));

export const checklist_item_relacoes = relations(checklist_item, ({ one }) => ({
  checklist: one(checklist, { fields: [checklist_item.checklist_id], references: [checklist.id] }),
}));

export const pendencia_relacoes = relations(pendencia, ({ one }) => ({
  responsavel: one(usuario, { fields: [pendencia.responsavel_id], references: [usuario.id] }),
}));

// ---------------------------------------------------------------------
// demanda.py
// ---------------------------------------------------------------------
export const demanda_relacoes = relations(demanda, ({ one, many }) => ({
  responsavel: one(usuario, { fields: [demanda.responsavel_id], references: [usuario.id] }),
  servidor: one(servidor, { fields: [demanda.solicitante_servidor_id], references: [servidor.id] }),
  unidade: one(unidade_uorg, {
    fields: [demanda.solicitante_unidade_uorg_id],
    references: [unidade_uorg.id],
  }),
  processo: one(processo, { fields: [demanda.desfecho_processo_id], references: [processo.id] }),
  // ordem do Python: demanda_encaminhamento.id
  encaminhamentos: many(demanda_encaminhamento, { relationName: 'demanda_encaminhamentos' }),
}));

export const demanda_encaminhamento_relacoes = relations(demanda_encaminhamento, ({ one }) => ({
  demanda: one(demanda, {
    fields: [demanda_encaminhamento.demanda_id],
    references: [demanda.id],
    relationName: 'demanda_encaminhamentos',
  }),
  autor: one(usuario, {
    fields: [demanda_encaminhamento.registrado_por],
    references: [usuario.id],
  }),
}));

// ---------------------------------------------------------------------
// epi.py
// ---------------------------------------------------------------------
export const epi_item_relacoes = relations(epi_item, ({ one }) => ({
  categoria: one(epi_categoria, {
    fields: [epi_item.categoria_id],
    references: [epi_categoria.id],
  }),
}));

export const epi_entrada_estoque_relacoes = relations(epi_entrada_estoque, ({ one }) => ({
  item: one(epi_item, { fields: [epi_entrada_estoque.epi_item_id], references: [epi_item.id] }),
}));

export const epi_ficha_registro_relacoes = relations(epi_ficha_registro, ({ one }) => ({
  servidor: one(servidor, { fields: [epi_ficha_registro.servidor_id], references: [servidor.id] }),
  item: one(epi_item, { fields: [epi_ficha_registro.epi_item_id], references: [epi_item.id] }),
}));

export const epi_requisicao_relacoes = relations(epi_requisicao, ({ one, many }) => ({
  servidor: one(servidor, { fields: [epi_requisicao.servidor_id], references: [servidor.id] }),
  chefia: one(servidor, {
    fields: [epi_requisicao.chefia_servidor_id],
    references: [servidor.id],
  }),
  unidade: one(unidade_uorg, {
    fields: [epi_requisicao.unidade_uorg_id],
    references: [unidade_uorg.id],
  }),
  motivo_recusa: one(epi_motivo_recusa, {
    fields: [epi_requisicao.motivo_recusa_id],
    references: [epi_motivo_recusa.id],
  }),
  itens: many(epi_requisicao_item, { relationName: 'requisicao_itens' }),
}));

export const epi_requisicao_item_relacoes = relations(epi_requisicao_item, ({ one }) => ({
  requisicao: one(epi_requisicao, {
    fields: [epi_requisicao_item.requisicao_id],
    references: [epi_requisicao.id],
    relationName: 'requisicao_itens',
  }),
  item: one(epi_item, { fields: [epi_requisicao_item.epi_item_id], references: [epi_item.id] }),
  motivo_recusa: one(epi_motivo_recusa, {
    fields: [epi_requisicao_item.motivo_recusa_id],
    references: [epi_motivo_recusa.id],
  }),
}));

// ---------------------------------------------------------------------
// treinamento.py
// ---------------------------------------------------------------------
export const treinamento_relacoes = relations(treinamento, ({ one }) => ({
  modelo_vigente: one(certificado_modelo, {
    fields: [treinamento.modelo_vigente_id],
    references: [certificado_modelo.id],
  }),
  instrutor_padrao: one(assinatura_instrutor, {
    fields: [treinamento.instrutor_padrao_id],
    references: [assinatura_instrutor.id],
  }),
}));

export const certificado_modelo_relacoes = relations(certificado_modelo, ({ one, many }) => ({
  treinamento: one(treinamento, {
    fields: [certificado_modelo.treinamento_id],
    references: [treinamento.id],
  }),
  // ordem do Python: certificado_modelo_tag.ordem, depois .id
  tags: many(certificado_modelo_tag, { relationName: 'modelo_tags' }),
}));

export const certificado_modelo_tag_relacoes = relations(certificado_modelo_tag, ({ one }) => ({
  modelo: one(certificado_modelo, {
    fields: [certificado_modelo_tag.modelo_id],
    references: [certificado_modelo.id],
    relationName: 'modelo_tags',
  }),
}));

export const assinatura_instrutor_relacoes = relations(assinatura_instrutor, ({ one }) => ({
  servidor: one(servidor, { fields: [assinatura_instrutor.servidor_id], references: [servidor.id] }),
}));

export const participante_relacoes = relations(participante, ({ one, many }) => ({
  servidor: one(servidor, { fields: [participante.servidor_id], references: [servidor.id] }),
  // ordem do Python: participante_email.id
  emails: many(participante_email, { relationName: 'participante_emails' }),
  email_principal: one(participante_email, {
    fields: [participante.email_principal_id],
    references: [participante_email.id],
  }),
}));

export const participante_email_relacoes = relations(participante_email, ({ one }) => ({
  participante: one(participante, {
    fields: [participante_email.participante_id],
    references: [participante.id],
    relationName: 'participante_emails',
  }),
}));

export const turma_relacoes = relations(turma, ({ one, many }) => ({
  treinamento: one(treinamento, { fields: [turma.treinamento_id], references: [treinamento.id] }),
  campus: one(campus, { fields: [turma.campus_id], references: [campus.id] }),
  unidade_promotora: one(unidade_uorg, {
    fields: [turma.unidade_promotora_id],
    references: [unidade_uorg.id],
  }),
  // ordem do Python: turma_instrutor.ordem
  instrutores: many(turma_instrutor, { relationName: 'turma_instrutores' }),
  inscricoes: many(inscricao, { relationName: 'turma_inscricoes' }),
}));

export const turma_instrutor_relacoes = relations(turma_instrutor, ({ one }) => ({
  turma: one(turma, {
    fields: [turma_instrutor.turma_id],
    references: [turma.id],
    relationName: 'turma_instrutores',
  }),
  instrutor: one(assinatura_instrutor, {
    fields: [turma_instrutor.assinatura_instrutor_id],
    references: [assinatura_instrutor.id],
  }),
}));

export const inscricao_relacoes = relations(inscricao, ({ one, many }) => ({
  turma: one(turma, {
    fields: [inscricao.turma_id],
    references: [turma.id],
    relationName: 'turma_inscricoes',
  }),
  participante: one(participante, {
    fields: [inscricao.participante_id],
    references: [participante.id],
  }),
  // ordem do Python: turma_presenca.data
  presencas: many(turma_presenca, { relationName: 'inscricao_presencas' }),
}));

export const turma_presenca_relacoes = relations(turma_presenca, ({ one }) => ({
  inscricao: one(inscricao, {
    fields: [turma_presenca.inscricao_id],
    references: [inscricao.id],
    relationName: 'inscricao_presencas',
  }),
}));

export const certificado_relacoes = relations(certificado, ({ one }) => ({
  inscricao: one(inscricao, { fields: [certificado.inscricao_id], references: [inscricao.id] }),
  participante: one(participante, {
    fields: [certificado.participante_id],
    references: [participante.id],
  }),
  treinamento: one(treinamento, {
    fields: [certificado.treinamento_id],
    references: [treinamento.id],
  }),
  modelo: one(certificado_modelo, {
    fields: [certificado.modelo_id],
    references: [certificado_modelo.id],
  }),
}));
