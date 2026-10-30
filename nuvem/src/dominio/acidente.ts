/**
 * Vocabulários fechados e regras puras do módulo de acidentes (CAT/SP).
 *
 * Acidente em serviço pela Lei 8.112/1990, arts. 211 a 214: a comunicação sai em
 * 10 dias, a investigação técnica instrui a perícia do SIASS, e a CAT/SP é
 * guardada para sempre (POLITICA_RETENCAO §2.4).
 *
 * O CHECK do banco sai da MESMA tupla que a tela e o serviço usam
 * (`lista_sql(TUPLA)`): duas listas do mesmo conjunto divergem no dia em que
 * alguém acrescenta valor a uma só.
 *
 * Nada aqui tem dado pessoal. A máquina de estados da ocorrência (G) mora em
 * `estados.ts`, com as outras.
 */

import { somar_dias } from './datas';
import { ESTADOS_ACIDENTE } from './estados';

export { ESTADOS_ACIDENTE };

type Rotulos = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------
// A ocorrência
// ---------------------------------------------------------------------
export const ESPECIES = ['TIPICO', 'TRAJETO', 'DOENCA_TRABALHO', 'INCIDENTE', 'OUTRO'] as const;
export const ROTULO_ESPECIE: Rotulos = {
  TIPICO: 'Típico',
  TRAJETO: 'Trajeto',
  DOENCA_TRABALHO: 'Doença relacionada ao trabalho',
  INCIDENTE: 'Incidente / quase acidente',
  OUTRO: 'Outro',
};

export const TIPOS_CAT = ['INICIAL', 'REABERTURA'] as const;
export const ROTULO_TIPO_CAT: Rotulos = { INICIAL: 'Inicial', REABERTURA: 'Reabertura' };

// Quem registrou: o titular (a própria conta, incluindo a chefia que marca "sou
// a chefia imediata", D9), a CSSO, o formulário por link (F2) ou a migração.
// "SST" é a equipe do setor; no legado era "Segurança do Trabalho".
export const ORIGENS = ['TITULAR', 'CHEFIA', 'SST', 'PUBLICO', 'MIGRACAO'] as const;
export const ROTULO_ORIGEM: Rotulos = {
  TITULAR: 'Pelo próprio acidentado',
  CHEFIA: 'Pela chefia imediata',
  SST: 'Pela equipe de segurança do trabalho',
  PUBLICO: 'Pelo formulário por link',
  MIGRACAO: 'Migrada da planilha antiga',
};

export const LOCAIS_TIPO = [
  'ESTABELECIMENTO_UFVJM',
  'VIA_INTERNA',
  'ESTACIONAMENTO',
  'PORTARIA',
  'CARGA_DESCARGA',
  'LABORATORIO',
  'SERVICO_SAUDE',
  'VIA_PUBLICA',
  'AREA_RURAL',
  'OUTRO',
] as const;
export const ROTULO_LOCAL_TIPO: Rotulos = {
  ESTABELECIMENTO_UFVJM: 'Estabelecimento da UFVJM',
  VIA_INTERNA: 'Via interna da UFVJM',
  ESTACIONAMENTO: 'Estacionamento',
  PORTARIA: 'Portaria / acesso',
  CARGA_DESCARGA: 'Área de carga e descarga',
  LABORATORIO: 'Laboratório',
  SERVICO_SAUDE: 'Hospital / serviço de saúde',
  VIA_PUBLICA: 'Via pública',
  AREA_RURAL: 'Área rural',
  OUTRO: 'Outro',
};

// Os locais em que o bloco de trânsito (BO, vítima de terceiros) faz sentido.
// A espécie TRAJETO também o abre. No legado era heurística de ~20 palavras.
export const LOCAIS_DE_TRANSITO: ReadonlySet<string> = new Set(['VIA_INTERNA', 'ESTACIONAMENTO', 'VIA_PUBLICA']);

export const SIM_NAO_NAO_SEI = ['SIM', 'NAO', 'NAO_SABE'] as const;
export const ROTULO_SIM_NAO_NAO_SEI: Rotulos = { SIM: 'Sim', NAO: 'Não', NAO_SABE: 'Não sei' };

// Por que se cancela uma ocorrência: lista fechada mais texto (D13/§3.1)
/** Por que a coordenação reabre o caso: lista fechada, para a trilha não levar texto livre (RN-19). */
export const MOTIVOS_REABERTURA = ['CORRIGIR_RELATORIO', 'INFORMACAO_NOVA', 'ENCERRAMENTO_INDEVIDO', 'OUTRO'] as const;
export const ROTULO_MOTIVO_REABERTURA: Readonly<Record<string, string>> = {
  CORRIGIR_RELATORIO: 'Corrigir a investigação ou o relatório',
  INFORMACAO_NOVA: 'Informação nova sobre o caso',
  ENCERRAMENTO_INDEVIDO: 'Encerrado por engano',
  OUTRO: 'Outro motivo',
};

export const MOTIVOS_CANCELAMENTO = ['DUPLICADA', 'COMUNICACAO_INDEVIDA', 'NAO_E_ACIDENTE_EM_SERVICO', 'OUTRO'] as const;
export const ROTULO_MOTIVO_CANCELAMENTO: Rotulos = {
  DUPLICADA: 'Comunicação duplicada',
  COMUNICACAO_INDEVIDA: 'Comunicação indevida',
  NAO_E_ACIDENTE_EM_SERVICO: 'Não é acidente em serviço',
  OUTRO: 'Outro motivo',
};

// ---------------------------------------------------------------------
// Os envolvidos
// ---------------------------------------------------------------------
export const CONDICOES_ENVOLVIDO = [
  'ACIDENTADO',
  'ENVOLVIDO_SEM_LESAO',
  'CONDUTOR',
  'PASSAGEIRO',
  'PEDESTRE',
  'CICLISTA',
  'MOTOCICLISTA',
  'TESTEMUNHA_ENVOLVIDA',
  'OUTRO',
] as const;
export const ROTULO_CONDICAO_ENVOLVIDO: Rotulos = {
  ACIDENTADO: 'Servidor acidentado',
  ENVOLVIDO_SEM_LESAO: 'Servidor envolvido sem lesão',
  CONDUTOR: 'Condutor',
  PASSAGEIRO: 'Passageiro',
  PEDESTRE: 'Pedestre',
  CICLISTA: 'Ciclista',
  MOTOCICLISTA: 'Motociclista',
  TESTEMUNHA_ENVOLVIDA: 'Testemunha envolvida',
  OUTRO: 'Outro',
};

// Vínculo do acidentado com a instituição (ROPA §3). Quem não é servidor tem
// cadastro próprio: nome e vínculo, SEM CPF (D14c).
export const VINCULOS_ACIDENTADO = [
  'SERVIDOR',
  'TERCEIRIZADO',
  'ESTUDANTE',
  'BOLSISTA',
  'RESIDENTE',
  'VISITANTE',
  'OUTRO',
] as const;
export const ROTULO_VINCULO_ACIDENTADO: Rotulos = {
  SERVIDOR: 'Servidor',
  TERCEIRIZADO: 'Terceirizado',
  ESTUDANTE: 'Estudante',
  BOLSISTA: 'Bolsista',
  RESIDENTE: 'Residente',
  VISITANTE: 'Visitante',
  OUTRO: 'Outro',
};

// Identificação pessoal (Anexo III da CAT/SP): bloco restrito, ver
// `acidente_identificacao`. A lista é a do legado (SEXO), sem acento no código.
export const SEXOS = ['FEMININO', 'MASCULINO', 'OUTRO', 'NAO_INFORMADO'] as const;
export const ROTULO_SEXO: Rotulos = {
  FEMININO: 'Feminino',
  MASCULINO: 'Masculino',
  OUTRO: 'Outro',
  NAO_INFORMADO: 'Não informado',
};

// Por que se abre a identificação pessoal: escolhida ANTES, fica em
// `acesso_dado_sensivel` (lista fechada, como a da saúde).
export const FINALIDADES_IDENTIFICACAO = ['CONTATAR_ENVOLVIDO', 'INVESTIGACAO', 'EMITIR_CAT_SP', 'INSTRUCAO_PERICIA', 'AUDITORIA'] as const;
export const ROTULO_FINALIDADE_IDENTIFICACAO: Rotulos = {
  CONTATAR_ENVOLVIDO: 'Contatar o envolvido ou a testemunha',
  INVESTIGACAO: 'Investigar o acidente',
  EMITIR_CAT_SP: 'Emitir a CAT/SP no formato do Anexo III',
  INSTRUCAO_PERICIA: 'Instruir a perícia do SIASS',
  AUDITORIA: 'Auditoria',
};

// ---------------------------------------------------------------------
// A CAT/SP versionada
// ---------------------------------------------------------------------
export const ORIGENS_CAT_SP = ['COMUNICACAO', 'COMPLEMENTACAO', 'RETIFICACAO_SST', 'MIGRACAO'] as const;
export const ROTULO_ORIGEM_CAT_SP: Rotulos = {
  COMUNICACAO: 'Comunicação inicial',
  COMPLEMENTACAO: 'Resposta a pedido de complementação',
  RETIFICACAO_SST: 'Retificação pela equipe',
  MIGRACAO: 'Migrada da planilha antiga',
};

// ---------------------------------------------------------------------
// Saúde (dado sensível: ROPA §4.4, dois níveis, serviço único)
// ---------------------------------------------------------------------
// D4: o comunicante declara parte do corpo e os fatos SIM/NÃO/NÃO SEI; o médico
// do trabalho confirma ou registra o resto.
export const ORIGENS_SAUDE = ['DECLARADO_COMUNICANTE', 'REGISTRADO_MEDICO'] as const;
export const ROTULO_ORIGEM_SAUDE: Rotulos = {
  DECLARADO_COMUNICANTE: 'Declarado por quem comunicou (a confirmar)',
  REGISTRADO_MEDICO: 'Registrado pelo médico do trabalho',
};

export const LATERALIDADES = ['DIREITA', 'ESQUERDA', 'BILATERAL', 'NAO_SE_APLICA'] as const;
export const ROTULO_LATERALIDADE: Rotulos = {
  DIREITA: 'Direita',
  ESQUERDA: 'Esquerda',
  BILATERAL: 'Bilateral',
  NAO_SE_APLICA: 'Não se aplica',
};

// A finalidade se escolhe ANTES de ver o dado (lista fechada) e fica em
// `acesso_dado_sensivel`.
export const FINALIDADES_SAUDE = [
  'INVESTIGACAO',
  'CLASSIFICACAO_GRAVIDADE',
  'INSTRUCAO_PERICIA',
  'ATENDIMENTO_AO_TITULAR',
  'AUDITORIA',
] as const;
export const ROTULO_FINALIDADE_SAUDE: Rotulos = {
  INVESTIGACAO: 'Investigar o acidente',
  CLASSIFICACAO_GRAVIDADE: 'Classificar a gravidade',
  INSTRUCAO_PERICIA: 'Instruir a perícia do SIASS',
  ATENDIMENTO_AO_TITULAR: 'Atender o próprio acidentado',
  AUDITORIA: 'Auditoria',
};

// As colunas do NÍVEL 2 de `acidente_saude`: só o médico (`saude_detalhe_ver`)
// as lê, e o expurgo parcial as leva a NULL (trigger confere).
export const COLUNAS_SAUDE_NIVEL_2 = [
  'dias_afastamento',
  'afastamento_inicio',
  'afastamento_retorno',
  'dias_internacao',
  'data_obito',
  'dias_debitados',
  'primeiro_socorro_por',
  'primeiro_socorro_unidade',
  'atendimento_em',
  // campos clínicos do Anexo III (CAT/SP)
  'duracao_tratamento_dias',
  'deve_afastar',
  'descricao_lesao',
  'diagnostico_provavel',
  'cid',
  'observacoes_saude',
] as const;

// ---------------------------------------------------------------------
// Investigação (MAPA), plano de ação, relatório e SIASS
// ---------------------------------------------------------------------
export const TIPOS_BARREIRA = ['FISICA', 'FUNCIONAL', 'SIMBOLICA', 'ADMINISTRATIVA'] as const;
export const ROTULO_TIPO_BARREIRA: Rotulos = {
  FISICA: 'Física',
  FUNCIONAL: 'Funcional',
  SIMBOLICA: 'Simbólica',
  ADMINISTRATIVA: 'Administrativa',
};

// Substitui a coluna "Barreiras ausentes" do legado
export const SITUACOES_BARREIRA = ['EXISTIA_FUNCIONOU', 'EXISTIA_FALHOU', 'AUSENTE'] as const;
export const ROTULO_SITUACAO_BARREIRA: Rotulos = {
  EXISTIA_FUNCIONOU: 'Existia e funcionou',
  EXISTIA_FALHOU: 'Existia e falhou',
  AUSENTE: 'Ausente',
};

export const DIMENSOES_MUDANCA = ['INDIVIDUO', 'TAREFA', 'MATERIAL', 'MEIO'] as const;
export const ROTULO_DIMENSAO_MUDANCA: Rotulos = {
  INDIVIDUO: 'Indivíduo',
  TAREFA: 'Tarefa',
  MATERIAL: 'Material',
  MEIO: 'Meio de trabalho',
};

// Parecer técnico da CSSO sobre a caracterização. NÃO é nexo: o nexo causal
// quem estabelece é a perícia oficial (`acidente_decisao_pericial`).
export const CARACTERIZACAO = ['SIM', 'NAO', 'INCONCLUSIVO'] as const;
export const ROTULO_CARACTERIZACAO: Rotulos = { SIM: 'Sim', NAO: 'Não', INCONCLUSIVO: 'Inconclusivo' };

export const ORIGENS_CHECKLIST = ['BASE', 'ESPECIFICO', 'MANUAL'] as const;

export const TIPOS_ACAO = [
  'ENGENHARIA',
  'ORGANIZACAO_TRABALHO',
  'SINALIZACAO',
  'MANUTENCAO',
  'PROCEDIMENTO',
  'TREINAMENTO',
  'EPI',
  'GESTAO',
  'OUTRA',
] as const;
export const ROTULO_TIPO_ACAO: Rotulos = {
  ENGENHARIA: 'Engenharia / proteção coletiva',
  ORGANIZACAO_TRABALHO: 'Organização do trabalho',
  SINALIZACAO: 'Sinalização',
  MANUTENCAO: 'Manutenção',
  PROCEDIMENTO: 'Procedimento',
  TREINAMENTO: 'Treinamento / orientação',
  EPI: 'EPI',
  GESTAO: 'Gestão / planejamento',
  OUTRA: 'Outra',
};

export const PRIORIDADES = ['ALTA', 'MEDIA', 'BAIXA'] as const;
export const ROTULO_PRIORIDADE: Rotulos = { ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa' };

// P -> EA -> C; P/EA -> X com motivo (a máquina é só de ação, sem estado de ocorrência)
export const ESTADOS_ACAO = ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'] as const;
export const ROTULO_ESTADO_ACAO: Rotulos = {
  PENDENTE: 'Pendente',
  EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};
export const TRANSICOES_ACAO: Readonly<Record<string, ReadonlySet<string>>> = {
  PENDENTE: new Set(['EM_ANDAMENTO', 'CANCELADA']),
  EM_ANDAMENTO: new Set(['CONCLUIDA', 'CANCELADA']),
  CONCLUIDA: new Set(),
  CANCELADA: new Set(),
};

export const VARIANTES_RELATORIO = ['COMPLETA', 'SEM_SAUDE'] as const;
export const ROTULO_VARIANTE_RELATORIO: Rotulos = {
  COMPLETA: 'Completa (para a perícia do SIASS)',
  SEM_SAUDE: 'Sem dados de saúde (contratada e fiscal)',
};

export const MEIOS_ENCAMINHAMENTO = ['SEI', 'SIASS_SISTEMA', 'EMAIL_INSTITUCIONAL', 'PRESENCIAL'] as const;
export const ROTULO_MEIO_ENCAMINHAMENTO: Rotulos = {
  SEI: 'Processo no SEI',
  SIASS_SISTEMA: 'Sistema do SIASS',
  EMAIL_INSTITUCIONAL: 'E-mail institucional',
  PRESENCIAL: 'Presencial',
};

export const RESULTADOS_PERICIA = ['ACIDENTE_EM_SERVICO_RECONHECIDO', 'NAO_RECONHECIDO', 'OUTRO'] as const;
export const ROTULO_RESULTADO_PERICIA: Rotulos = {
  ACIDENTE_EM_SERVICO_RECONHECIDO: 'Acidente em serviço reconhecido',
  NAO_RECONHECIDO: 'Não reconhecido',
  OUTRO: 'Outro resultado',
};

// ---------------------------------------------------------------------
// Protocolo e prazos
// ---------------------------------------------------------------------
/** `CAT-2026-0001`: a sequência é anual (D7); o número do SIASS tem campo próprio. */
export const PADRAO_PROTOCOLO_CAT = String.raw`CAT-[0-9]{4}-[0-9]{4,}`;

export function montar_protocolo(ano: number, numero: number): string {
  return `CAT-${ano}-${String(numero).padStart(4, '0')}`;
}

/** O prazo legal de comunicação (art. 214 da Lei 8.112), contado da data do ACIDENTE (D13). */
export const PRAZO_COMUNICACAO_DIAS = 10;

/**
 * Os prazos das pendências do módulo, em dias (D13). A investigação (30) e a
 * perícia (60) são os prazos que o usuário decidiu em 23/10/2026.
 */
export const PRAZO_TRIAGEM_DIAS = 2;
export const PRAZO_COMPLEMENTACAO_DIAS = 5;
export const PRAZO_SAUDE_REGISTRAR_DIAS = 5;
export const PRAZO_INVESTIGACAO_DIAS = 30;
export const PRAZO_PERICIA_DIAS = 60;

/** 'AAAA-MM-DD' do acidente + 10 dias: o dia em que a comunicação vence. */
export function prazo_de_comunicacao(data_evento: string): string {
  return somar_dias(data_evento, PRAZO_COMUNICACAO_DIAS);
}

// O que a trilha e a tela chamam de "protegido": ocorrência com menor de idade
// fica restrita à equipe de SST (D14a).
export const MENSAGEM_MENOR_DE_IDADE =
  'Acidentado menor de idade: a ocorrência fica restrita à equipe de segurança do trabalho, ' +
  'e o responsável legal precisa ser avisado.';
