/**
 * Maquinas de estado (SS4 do prompt) — porte fiel de `app/modelos/estados.py`.
 *
 * A) PROCESSO       - 18 estados de fluxo + NAO_INICIADO (so cartoes migrados).
 * B) DIREITO        - adicional concedido.
 * C) EPI_REQUISICAO - o envelope do pedido de EPI (EPI, fatia 4).
 * D) EPI_ITEM       - a linha do pedido, onde a decisao acontece (EPI, fatia 4).
 * E) TURMA          - turma de treinamento (Certificados, fatia 2).
 * F) INSCRICAO      - a pessoa dentro da turma (Certificados, fatias 2 e 3).
 * H) DEMANDA        - o pedido que chegou por e-mail ou no balcao (base).
 *
 * G continua reservada para ocorrencia de acidente, e por isso a demanda pegou o
 * H mesmo entrando antes: a numeracao vem do plano consolidado (SS1.9) e existe
 * para que dois modulos nao chamem de "maquina C" duas coisas diferentes.
 *
 * A coluna do kanban e visao; o estado e verdade.
 *
 * Toda maquina e um mapa de origem -> destinos admitidos (`Record<string,
 * ReadonlySet<string>>`, o `dict[str, frozenset[str]]` do Python), mais um mapa
 * de rotulos, e e conferida por `pode`/`exigir`, logo abaixo. O que NAO esta
 * declarado e proibido: e por isso que a tabela precisa listar ate os estados
 * terminais, com conjunto vazio, em vez de omiti-los.
 *
 * Os nomes exportados sao os MESMOS do Python, em caixa alta e snake_case, de
 * proposito: servicos e templates estao sendo portados mecanicamente, e um nome
 * "melhorado" aqui seria uma traducao a mais para cada um deles errar.
 */

export type Transicoes = Readonly<Record<string, ReadonlySet<string>>>;
export type Rotulos = Readonly<Record<string, string>>;

const conjunto = (...valores: string[]): ReadonlySet<string> => new Set(valores);
const VAZIO: ReadonlySet<string> = new Set();

/**
 * `dict.get(origem, frozenset())`. `Object.hasOwn`, e nao `transicoes[origem]`
 * cru: um estado chamado "constructor" ou "toString" acharia o prototipo do
 * objeto e viraria porta aberta — justamente o que o `get` do Python impede.
 */
function saidas_de(transicoes: Transicoes, origem: string): ReadonlySet<string> {
  return Object.hasOwn(transicoes, origem) ? transicoes[origem]! : VAZIO;
}

function rotulo_de(rotulos: Rotulos, estado: string): string {
  return Object.hasOwn(rotulos, estado) ? rotulos[estado]! : estado;
}

// ---------------------------------------------------------------------
// A) Maquina do PROCESSO
// ---------------------------------------------------------------------
export const ESTADOS_PROCESSO = [
  'NAO_INICIADO',
  'RECEBIDO',
  'EM_TRIAGEM',
  'PENDENTE_DOCUMENTO',
  'AGUARDANDO_INSPECAO',
  'INSPECIONADO',
  'AGUARDANDO_QUANTIFICACAO',
  'LAUDO_EM_ELABORACAO',
  'LAUDO_EMITIDO',
  'PARECER_EM_ELABORACAO',
  'PARECER_PRONTO_P_ASSINATURA',
  'PARECER_ASSINADO',
  'INSERIDO_NO_SEI',
  'DEVOLVIDO_A_PROGEP',
  'CONCLUIDO',
  'INDEFERIDO_TECNICAMENTE',
  'ARQUIVADO',
  'SOBRESTADO',
  'EM_RECURSO',
] as const;
export type EstadoProcesso = (typeof ESTADOS_PROCESSO)[number];

// Transicoes nao listadas sao proibidas. SOBRESTADO e tratado a parte.
export const TRANSICOES: Transicoes = {
  NAO_INICIADO: conjunto('RECEBIDO', 'EM_TRIAGEM', 'ARQUIVADO'),
  RECEBIDO: conjunto('EM_TRIAGEM'),
  EM_TRIAGEM: conjunto(
    'PENDENTE_DOCUMENTO',
    'AGUARDANDO_INSPECAO',
    'PARECER_EM_ELABORACAO', // atalho por reuso de laudo (art. 10 SS3)
    'INDEFERIDO_TECNICAMENTE',
    'ARQUIVADO',
  ),
  PENDENTE_DOCUMENTO: conjunto('EM_TRIAGEM', 'SOBRESTADO', 'ARQUIVADO'),
  AGUARDANDO_INSPECAO: conjunto('INSPECIONADO'),
  INSPECIONADO: conjunto(
    'AGUARDANDO_QUANTIFICACAO',
    'LAUDO_EM_ELABORACAO',
    'INDEFERIDO_TECNICAMENTE',
  ),
  AGUARDANDO_QUANTIFICACAO: conjunto('LAUDO_EM_ELABORACAO'),
  LAUDO_EM_ELABORACAO: conjunto('LAUDO_EMITIDO'),
  LAUDO_EMITIDO: conjunto('PARECER_EM_ELABORACAO'),
  PARECER_EM_ELABORACAO: conjunto('PARECER_PRONTO_P_ASSINATURA'),
  PARECER_PRONTO_P_ASSINATURA: conjunto('PARECER_ASSINADO'),
  PARECER_ASSINADO: conjunto('INSERIDO_NO_SEI'),
  INSERIDO_NO_SEI: conjunto('DEVOLVIDO_A_PROGEP'),
  DEVOLVIDO_A_PROGEP: conjunto('CONCLUIDO'),
  CONCLUIDO: conjunto('EM_RECURSO'),
  INDEFERIDO_TECNICAMENTE: conjunto('EM_RECURSO'),
  EM_RECURSO: conjunto('EM_TRIAGEM'),
  ARQUIVADO: conjunto(),
  SOBRESTADO: conjunto(), // volta ao estado_anterior
};

// Atalho legitimo: EM_TRIAGEM -> PARECER_EM_ELABORACAO exige laudo vigente
export const ATALHO_REUSO_LAUDO = ['EM_TRIAGEM', 'PARECER_EM_ELABORACAO'] as const;

export const ESTADO_PARA_COLUNA: Rotulos = {
  NAO_INICIADO: 'NAO_INICIADO',
  RECEBIDO: 'A_FAZER',
  EM_TRIAGEM: 'A_FAZER',
  PENDENTE_DOCUMENTO: 'AGUARDANDO',
  SOBRESTADO: 'AGUARDANDO',
  AGUARDANDO_QUANTIFICACAO: 'AGUARDANDO',
  PARECER_PRONTO_P_ASSINATURA: 'AGUARDANDO',
  DEVOLVIDO_A_PROGEP: 'AGUARDANDO',
  AGUARDANDO_INSPECAO: 'EM_ANDAMENTO',
  INSPECIONADO: 'EM_ANDAMENTO',
  LAUDO_EM_ELABORACAO: 'EM_ANDAMENTO',
  LAUDO_EMITIDO: 'EM_ANDAMENTO',
  PARECER_EM_ELABORACAO: 'EM_ANDAMENTO',
  PARECER_ASSINADO: 'EM_ANDAMENTO',
  INSERIDO_NO_SEI: 'EM_ANDAMENTO',
  EM_RECURSO: 'EM_ANDAMENTO',
  CONCLUIDO: 'CONCLUIDO',
  INDEFERIDO_TECNICAMENTE: 'CONCLUIDO',
  ARQUIVADO: 'CONCLUIDO',
};

export const ROTULO_ESTADO: Rotulos = {
  NAO_INICIADO: 'Nao iniciado',
  RECEBIDO: 'Recebido',
  EM_TRIAGEM: 'Em triagem',
  PENDENTE_DOCUMENTO: 'Pendente de documento',
  AGUARDANDO_INSPECAO: 'Aguardando inspecao',
  INSPECIONADO: 'Inspecionado',
  AGUARDANDO_QUANTIFICACAO: 'Aguardando quantificacao',
  LAUDO_EM_ELABORACAO: 'Laudo em elaboracao',
  LAUDO_EMITIDO: 'Laudo emitido',
  PARECER_EM_ELABORACAO: 'Parecer em elaboracao',
  PARECER_PRONTO_P_ASSINATURA: 'Parecer pronto para assinatura',
  PARECER_ASSINADO: 'Parecer assinado',
  INSERIDO_NO_SEI: 'Inserido no SEI',
  DEVOLVIDO_A_PROGEP: 'Devolvido a PROGEP',
  CONCLUIDO: 'Concluido',
  INDEFERIDO_TECNICAMENTE: 'Indeferido tecnicamente',
  ARQUIVADO: 'Arquivado',
  SOBRESTADO: 'Sobrestado',
  EM_RECURSO: 'Em recurso',
};

// O mesmo mapa com acento, e SO para a tela.
//
// Dois mapas, e nao um: o de cima e lido tambem por mensagem de servico e por
// descricao de trilha de auditoria, que e texto gravado e conferido por digest
// — reescrever aquelas cadeias trocaria o texto de eventos ja assinados pelo
// encadeamento de hash. A chave NUNCA muda: e ela que esta no banco, no `CHECK`
// da tabela e na tabela de transicoes. O que muda e so o que a pessoa le.
//
// Enquanto os dois existirem eles precisam ter as mesmas chaves. Estado novo
// entra nos dois, ou a tela cai no recuo e volta a escrever o codigo cru.
export const ROTULO_ESTADO_TELA: Rotulos = {
  NAO_INICIADO: 'Não iniciado',
  RECEBIDO: 'Recebido',
  EM_TRIAGEM: 'Em triagem',
  PENDENTE_DOCUMENTO: 'Pendente de documento',
  AGUARDANDO_INSPECAO: 'Aguardando inspeção',
  INSPECIONADO: 'Inspecionado',
  AGUARDANDO_QUANTIFICACAO: 'Aguardando quantificação',
  LAUDO_EM_ELABORACAO: 'Laudo em elaboração',
  LAUDO_EMITIDO: 'Laudo emitido',
  PARECER_EM_ELABORACAO: 'Parecer em elaboração',
  PARECER_PRONTO_P_ASSINATURA: 'Parecer pronto para assinatura',
  PARECER_ASSINADO: 'Parecer assinado',
  INSERIDO_NO_SEI: 'Inserido no SEI',
  DEVOLVIDO_A_PROGEP: 'Devolvido à PROGEP',
  CONCLUIDO: 'Concluído',
  INDEFERIDO_TECNICAMENTE: 'Indeferido tecnicamente',
  ARQUIVADO: 'Arquivado',
  SOBRESTADO: 'Sobrestado',
  EM_RECURSO: 'Em recurso',
};

// Incisos do art. 11 da IN 15/2022 - obrigatorio ao indeferir tecnicamente
export const INCISOS_ART11: Rotulos = {
  I: 'exposicao eventual, sem a excecao do art. 9o, paragrafo unico',
  II: 'atividade-meio, sem exposicao ao agente nocivo',
  III: 'local inadequado por gestao deficiente, sanavel por medida administrativa',
  IV: 'chefia sem comprovacao individual de exposicao',
};

// ---------------------------------------------------------------------
// B) Maquina do DIREITO
// ---------------------------------------------------------------------
export const ESTADOS_DIREITO = [
  'PROPOSTO',
  'VIGENTE',
  'SUSPENSO',
  'EM_REAVALIACAO',
  'ALTERADO',
  'CESSADO',
] as const;

export const TRANSICOES_DIREITO: Transicoes = {
  PROPOSTO: conjunto('VIGENTE', 'CESSADO'),
  VIGENTE: conjunto('SUSPENSO', 'EM_REAVALIACAO', 'ALTERADO', 'CESSADO'),
  SUSPENSO: conjunto('VIGENTE', 'CESSADO', 'EM_REAVALIACAO'),
  EM_REAVALIACAO: conjunto('VIGENTE', 'ALTERADO', 'CESSADO', 'SUSPENSO'),
  ALTERADO: conjunto('VIGENTE', 'CESSADO', 'EM_REAVALIACAO'),
  CESSADO: conjunto(),
};

export const ROTULO_DIREITO: Rotulos = {
  PROPOSTO: 'Proposto',
  VIGENTE: 'Vigente',
  SUSPENSO: 'Suspenso',
  EM_REAVALIACAO: 'Em reavaliacao',
  ALTERADO: 'Alterado',
  CESSADO: 'Cessado',
};

// ---------------------------------------------------------------------
// C) Maquina da REQUISICAO DE EPI — o envelope
// ---------------------------------------------------------------------
// Duas maquinas, e nao uma, porque o legado misturava as duas coisas numa fila
// so. Aprovar e recusar sao decisoes DO ITEM: aprova-se a luva e recusa-se o
// respirador do mesmo pedido. Aqui o envelope so diz em que ponto do tramite o
// pedido esta; quem carrega a decisao e a maquina D.
export const ESTADOS_EPI_REQUISICAO = [
  'RASCUNHO',
  'ENVIADA',
  'EM_ANALISE',
  'ANALISADA',
  'EM_ATENDIMENTO',
  'ATENDIDA',
  'INDEFERIDA',
  'CANCELADA',
] as const;

export const TRANSICOES_EPI_REQUISICAO: Transicoes = {
  // RASCUNHO e o unico estado que tambem admite exclusao fisica (RN-31): o
  // pedido em digitacao ainda nao e documento de ninguem. Cancelar tambem vale
  // — quem desistiu depois de ja ter escrito prefere deixar o motivo escrito.
  RASCUNHO: conjunto('ENVIADA', 'CANCELADA'),
  ENVIADA: conjunto('EM_ANALISE', 'CANCELADA'),
  // a volta para ENVIADA e devolver a fila: o analista abriu, viu que o caso
  // nao e dele (ou que falta informacao) e solta o pedido. Sem essa aresta, a
  // unica saida de EM_ANALISE seria decidir — e decidir sem base e pior do que
  // devolver.
  EM_ANALISE: conjunto('ENVIADA', 'ANALISADA', 'INDEFERIDA', 'CANCELADA'),
  ANALISADA: conjunto('EM_ATENDIMENTO', 'CANCELADA'),
  EM_ATENDIMENTO: conjunto('ATENDIDA', 'CANCELADA'),
  // reconsideracao: o unico caminho de volta de um terminal, e e de propria
  // coordenacao. Indeferimento errado so se consertava, no legado, abrindo
  // pedido novo — que apaga a historia de que houve um erro.
  INDEFERIDA: conjunto('EM_ANALISE'),
  ATENDIDA: conjunto(),
  CANCELADA: conjunto(),
};

export const ROTULO_EPI_REQUISICAO: Rotulos = {
  RASCUNHO: 'Rascunho',
  ENVIADA: 'Enviada',
  EM_ANALISE: 'Em análise',
  ANALISADA: 'Analisada',
  EM_ATENDIMENTO: 'Em atendimento',
  ATENDIDA: 'Atendida',
  INDEFERIDA: 'Indeferida',
  CANCELADA: 'Cancelada',
};

// Onde ainda cabe cancelar sem apagar nada: o envelope que ainda nao entregou
// equipamento nenhum. ATENDIDA e INDEFERIDA ficam de fora porque ja sao
// resposta dada, e CANCELADA porque ja e o proprio destino.
export const EPI_REQUISICAO_CANCELAVEL: ReadonlySet<string> = conjunto(
  'RASCUNHO',
  'ENVIADA',
  'EM_ANALISE',
  'ANALISADA',
  'EM_ATENDIMENTO',
);

// Os terminais. Fila e indicador leem daqui em vez de repetir a lista.
export const EPI_REQUISICAO_ENCERRADA: ReadonlySet<string> = conjunto(
  'ATENDIDA',
  'INDEFERIDA',
  'CANCELADA',
);

// ---------------------------------------------------------------------
// D) Maquina do ITEM DE REQUISICAO DE EPI — onde o trabalho acontece
// ---------------------------------------------------------------------
export const ESTADOS_EPI_ITEM = [
  'SOLICITADO',
  'APROVADO',
  'RESERVADO',
  'SEM_ESTOQUE',
  'ENTREGUE',
  'RECUSADO',
  'CANCELADO',
] as const;

export const TRANSICOES_EPI_ITEM: Transicoes = {
  // SOLICITADO -> CANCELADO entra de proposito: cancelar o envelope em ENVIADA
  // (que a maquina C admite) deixaria os itens parados em SOLICITADO, dentro de
  // um pedido terminal — estado que nao descreve fato nenhum.
  SOLICITADO: conjunto('APROVADO', 'RECUSADO', 'CANCELADO'),
  // APROVADO -> ENTREGUE e a fatia 4 sem reserva. RESERVADO e SEM_ESTOQUE
  // existem na maquina porque a reserva e o que impede dois pedidos de
  // prometerem o mesmo par de botas — declara-los agora e o que permite a
  // reserva entrar depois sem reescrever a maquina inteira.
  APROVADO: conjunto('RESERVADO', 'SEM_ESTOQUE', 'ENTREGUE', 'CANCELADO'),
  RESERVADO: conjunto('ENTREGUE', 'SEM_ESTOQUE', 'CANCELADO'),
  SEM_ESTOQUE: conjunto('RESERVADO', 'CANCELADO'),
  // Os tres terminais. Devolucao, substituicao e descarte NAO mudam o estado
  // do item: sao fatos posteriores e viram linha nova na ficha.
  ENTREGUE: conjunto(),
  RECUSADO: conjunto(),
  CANCELADO: conjunto(),
};

export const ROTULO_EPI_ITEM: Rotulos = {
  SOLICITADO: 'Solicitado',
  APROVADO: 'Aprovado',
  RESERVADO: 'Reservado',
  SEM_ESTOQUE: 'Sem estoque',
  ENTREGUE: 'Entregue',
  RECUSADO: 'Recusado',
  CANCELADO: 'Cancelado',
};

// Item ja decidido pelo analista. `ANALISADA` e `INDEFERIDA` exigem que TODO
// item esteja aqui — analise pela metade nao e analise.
export const EPI_ITEM_DECIDIDO: ReadonlySet<string> = conjunto(
  'APROVADO',
  'RESERVADO',
  'SEM_ESTOQUE',
  'ENTREGUE',
  'RECUSADO',
  'CANCELADO',
);

// Item aprovado que ainda deve alguma coisa ao requerente. Enquanto houver um
// destes, o envelope nao esta ATENDIDO.
export const EPI_ITEM_PENDENTE_DE_ATENDIMENTO: ReadonlySet<string> = conjunto(
  'APROVADO',
  'RESERVADO',
  'SEM_ESTOQUE',
);

// ---------------------------------------------------------------------
// E) Maquina da TURMA
// ---------------------------------------------------------------------
export const ESTADOS_TURMA = [
  'PLANEJADA',
  'INSCRICOES_ABERTAS',
  'EM_ANDAMENTO',
  'CONCLUIDA',
  'CANCELADA',
] as const;

export const TRANSICOES_TURMA: Transicoes = {
  // comeca sem inscricao aberta: a turma existe na agenda antes de ter vaga
  PLANEJADA: conjunto('INSCRICOES_ABERTAS', 'EM_ANDAMENTO', 'CANCELADA'),
  // voltar para PLANEJADA e fechar a inscricao sem cancelar a turma: acontece
  // quando as vagas esgotam ou a data e adiada.
  INSCRICOES_ABERTAS: conjunto('PLANEJADA', 'EM_ANDAMENTO', 'CANCELADA'),
  EM_ANDAMENTO: conjunto('CONCLUIDA', 'CANCELADA'),
  // concluida e terminal: reabrir turma fechada e o que faria um certificado
  // emitido descrever uma turma que mudou depois. Erro se corrige por anulacao
  // e reemissao, nao por volta de estado.
  CONCLUIDA: conjunto(),
  CANCELADA: conjunto(),
};

export const ROTULO_TURMA: Rotulos = {
  PLANEJADA: 'Planejada',
  INSCRICOES_ABERTAS: 'Inscricoes abertas',
  EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluida',
  CANCELADA: 'Cancelada',
};

// Situacoes em que a turma ainda aceita inscricao. EM_ANDAMENTO entra porque
// treinamento de NR recebe retardatario no primeiro dia; CONCLUIDA e CANCELADA
// nao, porque inscrever em turma fechada e reescrever historia.
export const TURMA_ACEITA_INSCRICAO: ReadonlySet<string> = conjunto(
  'PLANEJADA',
  'INSCRICOES_ABERTAS',
  'EM_ANDAMENTO',
);

// ---------------------------------------------------------------------
// F) Maquina da INSCRICAO
// ---------------------------------------------------------------------
export const ESTADOS_INSCRICAO = [
  'AGUARDANDO_EMAIL',
  'INSCRITA',
  'CONFIRMADA',
  'PRESENTE',
  'AUSENTE',
  'APROVADO',
  'REPROVADO',
  'CANCELADA',
] as const;

export const TRANSICOES_INSCRICAO: Transicoes = {
  // so a inscricao publica nasce aqui (fatia 6); a interna ja nasce INSCRITA
  AGUARDANDO_EMAIL: conjunto('INSCRITA', 'CANCELADA'),
  // AUSENTE entrou na fatia 3: no fecho da turma, quem nunca foi confirmado e
  // nunca compareceu termina AUSENTE. PRESENTE continua fora de proposito: quem
  // compareceu passa por CONFIRMADA, e e o proprio lancamento de presenca que
  // faz e audita essa confirmacao.
  INSCRITA: conjunto('CONFIRMADA', 'AUSENTE', 'CANCELADA'),
  CONFIRMADA: conjunto('PRESENTE', 'AUSENTE', 'CANCELADA'),
  // PRESENTE <-> AUSENTE porque lancamento de presenca se corrige (fatia 3); o
  // resultado so vem depois de um dos dois, e e isso que impede APROVADO de
  // aparecer antes de a pessoa ter comparecido.
  PRESENTE: conjunto('AUSENTE', 'APROVADO', 'REPROVADO'),
  AUSENTE: conjunto('PRESENTE', 'REPROVADO'),
  // Fatia 3: APROVADO e REPROVADO deixam de ser terminais, e SO um vira o
  // outro — a folha de um dia que ninguem lancou aparece depois do fecho. A
  // volta para PRESENTE/AUSENTE continua proibida: inscricao de turma concluida
  // SEMPRE tem resultado. E a aresta so e percorrida dentro da retificacao, que
  // exige permissao, motivo por escrito e audita RESULTADO_RETIFICADO.
  APROVADO: conjunto('REPROVADO'),
  REPROVADO: conjunto('APROVADO'),
  CANCELADA: conjunto(),
};

export const ROTULO_INSCRICAO: Rotulos = {
  AGUARDANDO_EMAIL: 'Aguardando confirmacao de e-mail',
  INSCRITA: 'Inscrita',
  CONFIRMADA: 'Confirmada',
  PRESENTE: 'Presente',
  AUSENTE: 'Ausente',
  APROVADO: 'Aprovado',
  REPROVADO: 'Reprovado',
  CANCELADA: 'Cancelada',
};

// Quem conta para a vaga. Inscricao cancelada devolve a vaga; a que aguarda
// confirmacao de e-mail ainda nao a ocupa (SS7, trava 2 do desenho).
export const INSCRICAO_OCUPA_VAGA: ReadonlySet<string> = conjunto(
  'INSCRITA',
  'CONFIRMADA',
  'PRESENTE',
  'AUSENTE',
  'APROVADO',
  'REPROVADO',
);

// O resultado da turma. So estes dois habilitam (ou barram) a emissao do
// certificado na fatia 4, e so eles admitem retificacao.
export const INSCRICAO_COM_RESULTADO: ReadonlySet<string> = conjunto('APROVADO', 'REPROVADO');

// Quem o fecho da turma NAO apura. A cancelada saiu por ato proprio, com motivo
// registrado; a que aguarda confirmacao de e-mail nunca chegou a ser inscricao
// e transforma-la em ausente inventaria uma falta de quem talvez nem tenha
// pedido vaga.
export const INSCRICAO_FORA_DA_APURACAO: ReadonlySet<string> = conjunto(
  'CANCELADA',
  'AGUARDANDO_EMAIL',
);

// ---------------------------------------------------------------------
// H) Maquina da DEMANDA — o pedido que chegou e ainda nao virou nada
// ---------------------------------------------------------------------
// Tres estados, e a brevidade e o ponto. `EM_ANDAMENTO` e a diferenca entre
// "chegou e ninguem pegou" e "alguem esta cuidando". ABERTA -> ENCERRADA existe
// direto porque muita demanda se resolve no mesmo ato em que se registra.
export const ESTADOS_DEMANDA = ['ABERTA', 'EM_ANDAMENTO', 'ENCERRADA'] as const;

export const TRANSICOES_DEMANDA: Transicoes = {
  ABERTA: conjunto('EM_ANDAMENTO', 'ENCERRADA'),
  EM_ANDAMENTO: conjunto('ENCERRADA'),
  // Terminal, e sem volta. Reabrir apagaria o desfecho, que e a unica coisa
  // que esta tabela existe para guardar. Demanda que volta a acontecer e
  // demanda NOVA, e o encaminhamento da antiga continua legivel (RN-31).
  ENCERRADA: conjunto(),
};

export const ROTULO_DEMANDA: Rotulos = {
  ABERTA: 'Aberta',
  EM_ANDAMENTO: 'Em andamento',
  ENCERRADA: 'Encerrada',
};

// Por onde a demanda chegou. Vocabulario fechado porque a pergunta que ele
// responde e contavel — "quanto do nosso trabalho entra por fora do SEI?". A
// ordem e a do formulario, e o mais comum vem primeiro.
export const CANAIS_DEMANDA = ['EMAIL', 'PRESENCIAL', 'TELEFONE', 'OFICIO', 'OUTRO'] as const;

export const ROTULO_CANAL_DEMANDA: Rotulos = {
  EMAIL: 'E-mail',
  PRESENCIAL: 'Presencial',
  TELEFONE: 'Telefone',
  OFICIO: 'Ofício',
  OUTRO: 'Outro',
};

// Como a demanda terminou. **O desfecho e obrigatorio no encerramento**, e cada
// um cobra a sua prova (a CHECK `ck_demanda_desfecho_campos` cobra no banco):
//   RESOLVIDA       — o que foi feito, por escrito;
//   VIROU_PROCESSO  — o `processo.id` REAL, e nao um NUP digitado;
//   ENCAMINHADA     — para qual setor, e em que data;
//   SEM_PROVIDENCIA — o motivo escrito: "nao vamos fazer nada" e decisao
//                     legitima, e o que nao pode e ser tomada por esquecimento.
export const DESFECHOS_DEMANDA = [
  'RESOLVIDA',
  'VIROU_PROCESSO',
  'ENCAMINHADA',
  'SEM_PROVIDENCIA',
] as const;

export const ROTULO_DESFECHO_DEMANDA: Rotulos = {
  RESOLVIDA: 'Resolvida',
  VIROU_PROCESSO: 'Virou processo SEI',
  ENCAMINHADA: 'Encaminhada a outro setor',
  SEM_PROVIDENCIA: 'Sem providência',
};

// Onde a demanda ainda cobra alguma coisa de alguem.
export const DEMANDA_EM_ABERTO: ReadonlySet<string> = conjunto('ABERTA', 'EM_ANDAMENTO');

// O rotulo daqui so existe para o cabecalho da coluna do quadro — nenhuma
// mensagem de servico e nenhuma trilha o le, e por isso ele nao precisa do par
// ASCII/tela: acentua-se em casa. Tudo em caixa de frase.
export const COLUNAS_KANBAN: ReadonlyArray<readonly [string, string]> = [
  ['NAO_INICIADO', 'Não iniciado'],
  ['A_FAZER', 'A fazer'],
  ['EM_ANDAMENTO', 'Em andamento'],
  ['AGUARDANDO', 'Aguardando'],
  ['CONCLUIDO', 'Concluído'],
];

/** Transicao de estado que a maquina nao admite. (`ValueError` no Python.) */
export class TransicaoInvalida extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'TransicaoInvalida';
  }
}

// ---------------------------------------------------------------------
// O conferidor, um so para todas as maquinas
// ---------------------------------------------------------------------
/** Origem desconhecida nao vira porta aberta: cai no conjunto vazio. */
export function pode(transicoes: Transicoes, origem: string, destino: string): boolean {
  return saidas_de(transicoes, origem).has(destino);
}

/**
 * Recusa a transicao que a maquina nao admite, com a mensagem da tela.
 *
 * Existe para que a regra fique no servico, e nao no template: esconder o botao
 * nao e guarda nenhuma — o POST continua chegando.
 */
export function exigir(
  transicoes: Transicoes,
  origem: string,
  destino: string,
  rotulos: Rotulos = {},
): void {
  if (pode(transicoes, origem, destino)) return;
  throw new TransicaoInvalida(recusa(origem, destino, saidas_de(transicoes, origem), rotulos));
}

/**
 * A frase da recusa: o que foi pedido, e para onde DÁ para ir.
 *
 * As saídas vêm da mesma tabela que recusou, então a lista nunca diverge da
 * máquina. A mensagem não entra em trilha nenhuma (é exceção, e a rota a devolve
 * à tela); por isso ela pode ter acento, ao contrário dos rótulos ASCII que a
 * auditoria digere.
 *
 * A ordenação é `sort()` puro, por unidade de código, e não `localeCompare`:
 * é o que o `sorted()` do Python faz, e a frase tem de sair igual nos dois.
 */
function recusa(origem: string, destino: string, saidas: Iterable<string>, rotulos: Rotulos): string {
  const nome = (estado: string) => rotulo_de(rotulos, estado);
  let frase = `Transição proibida: ${nome(origem)} → ${nome(destino)}.`;
  const lista = [...saidas].map(nome).sort();
  if (lista.length > 0) {
    frase += ` De “${nome(origem)}” dá para ir a: ${lista.join(', ')}.`;
  } else {
    frase += ` “${nome(origem)}” é situação final: não sai para lugar nenhum.`;
  }
  return frase;
}

/**
 * Maquina A. SOBRESTADO fica a parte: entra de quase todo lugar e volta para o
 * estado anterior, que nao cabe numa tabela de origem -> destinos.
 */
export function pode_transitar(origem: string, destino: string): boolean {
  if (destino === 'SOBRESTADO') return origem !== 'SOBRESTADO' && origem !== 'ARQUIVADO';
  if (origem === 'SOBRESTADO') return (ESTADOS_PROCESSO as readonly string[]).includes(destino);
  return pode(TRANSICOES, origem, destino);
}

export function exigir_transicao(origem: string, destino: string): void {
  if (pode_transitar(origem, destino)) return;
  // `ROTULO_ESTADO_TELA`, e não o ASCII: esta frase vai para a tela e para mais
  // nada. SOBRESTADO entra na lista de saídas porque `pode_transitar` o admite
  // de quase todo lugar — a lista tem de dizer o que a máquina de fato aceita.
  let saidas = new Set(saidas_de(TRANSICOES, origem));
  if (origem === 'SOBRESTADO') saidas = new Set(ESTADOS_PROCESSO);
  else if (origem !== 'ARQUIVADO') saidas.add('SOBRESTADO');
  saidas.delete(origem);
  throw new TransicaoInvalida(recusa(origem, destino, saidas, ROTULO_ESTADO_TELA));
}

export function exigir_transicao_direito(origem: string, destino: string): void {
  exigir(TRANSICOES_DIREITO, origem, destino, ROTULO_DIREITO);
}

export function exigir_transicao_epi_requisicao(origem: string, destino: string): void {
  exigir(TRANSICOES_EPI_REQUISICAO, origem, destino, ROTULO_EPI_REQUISICAO);
}

export function exigir_transicao_epi_item(origem: string, destino: string): void {
  exigir(TRANSICOES_EPI_ITEM, origem, destino, ROTULO_EPI_ITEM);
}

export function exigir_transicao_turma(origem: string, destino: string): void {
  exigir(TRANSICOES_TURMA, origem, destino, ROTULO_TURMA);
}

export function exigir_transicao_inscricao(origem: string, destino: string): void {
  exigir(TRANSICOES_INSCRICAO, origem, destino, ROTULO_INSCRICAO);
}

export function exigir_transicao_demanda(origem: string, destino: string): void {
  exigir(TRANSICOES_DEMANDA, origem, destino, ROTULO_DEMANDA);
}

/**
 * O que a tela pode oferecer a partir da situacao atual — na ordem da maquina,
 * nao na do conjunto.
 */
export function destinos_de_turma(origem: string): string[] {
  const admitidos = saidas_de(TRANSICOES_TURMA, origem);
  return ESTADOS_TURMA.filter((estado) => admitidos.has(estado));
}

export function coluna_de(estado: string): string {
  return Object.hasOwn(ESTADO_PARA_COLUNA, estado) ? ESTADO_PARA_COLUNA[estado]! : 'A_FAZER';
}
