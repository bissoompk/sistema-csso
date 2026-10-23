/**
 * Trilha de auditoria append-only com encadeamento anti-adulteração.
 * Porte de `app/servicos/auditoria.py`.
 *
 * **O digest é calculado sobre uma serialização canônica feita em código**
 * (`corpo`), e nunca sobre o texto que o jsonb devolve: o jsonb reordena
 * chaves e descarta espaço (ver `src/db/esquema/base.ts`). `corpo` reproduz o
 * `json.dumps(valor, ensure_ascii=False, sort_keys=True, default=str)` do
 * Python — os separadores `", "` e `": "`, as chaves ordenadas por ponto de
 * código, o `default=str` para o que JSON não tem.
 *
 * **Serialização da cadeia.** No SQLite toda transação abria com `BEGIN
 * IMMEDIATE` e o escritor era um só: ler o último `hash_atual` e gravar o
 * próximo era atômico por construção. No PostgreSQL duas requisições gravam
 * ao mesmo tempo, e as duas leriam o MESMO anterior — a cadeia bifurcaria e a
 * conferência acusaria adulteração onde ninguém tocou. Por isso `registrar`
 * toma `pg_advisory_xact_lock(TRAVA_CADEIA)` ANTES de ler o anterior: quem
 * chega depois espera o COMMIT de quem chegou antes (a trava é de transação e
 * só sai no fim dela), e o id do evento novo é sempre maior que o do anterior
 * lido. É o "um escritor só" do SQLite, reduzido à trilha.
 */
import { createHash } from "node:crypto";
import { asc, desc, gt, inArray, max, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acesso_dado_sensivel, agora_utc, conferencia_cadeia, historico_evento } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import type { UsuarioAtual } from "./rbac.js";
import { termos_de_saude_em } from "./textos.js";

export type HistoricoEvento = typeof historico_evento.$inferSelect;
export type ConferenciaCadeia = typeof conferencia_cadeia.$inferSelect;
export type AcessoDadoSensivel = typeof acesso_dado_sensivel.$inferSelect;

// Eventos com nome fixo — usados por relatórios e testes
export const REUSO_DE_LAUDO = "REUSO_DE_LAUDO";
export const ASSINATURA_NEGADA = "ASSINATURA_NEGADA";
// D22: a marcação de "assinado" feita por quem não é o signatário, com o motivo
export const ASSINATURA_REGISTRADA_POR_SUBSTITUTO = "ASSINATURA_REGISTRADA_POR_SUBSTITUTO";
export const EXCECAO_ART9_APLICADA = "EXCECAO_ART9_APLICADA";
export const HABILITACAO_EXTERNA_ATESTADA = "HABILITACAO_EXTERNA_ATESTADA";
export const ANO_INFERIDO = "ANO_INFERIDO";
export const PARECER_EMITIDO = "PARECER_EMITIDO";
export const PARECER_ANULADO = "PARECER_ANULADO";
export const LAUDO_SUPERADO = "LAUDO_SUPERADO";
export const ESTADO_ALTERADO = "ESTADO_ALTERADO";
export const NUP_DV_DISPENSADO = "NUP_DV_DISPENSADO";
export const PRESCRICAO_QUINQUENAL_ALERTADA = "PRESCRICAO_QUINQUENAL_ALERTADA";
export const ANEXO_DUPLICADO = "ANEXO_DUPLICADO";
export const BOOTSTRAP_SUPERINTENDENTE = "BOOTSTRAP_SUPERINTENDENTE";
// D21: a conta pelo lado de quem a usa — a troca de senha feita pelo próprio
// dono, o bloqueio por tentativas, e a permissão que o semeio acrescenta a um
// perfil já gravado (o alcance de quem tem o perfil muda sem ninguém conceder).
export const SENHA_TROCADA = "SENHA_TROCADA";
export const CONTA_BLOQUEADA = "CONTA_BLOQUEADA";
export const PERMISSAO_ACRESCENTADA_AO_PERFIL = "PERMISSAO_ACRESCENTADA_AO_PERFIL";
// A outra metade: a retirada declarada em `rbac.PERMISSOES_RETIRADAS` (o
// `indicador.ver` do admin_ti, 22/10/2026). O alcance encolhe sem ninguém
// encerrar concessão, e quem audita acesso precisa ler isso na trilha.
export const PERMISSAO_RETIRADA_DO_PERFIL = "PERMISSAO_RETIRADA_DO_PERFIL";
// Minha conta (22/10/2026): o que a própria conta muda em si mesma. Tipos
// próprios, e não USUARIO_ALTERADO: aquele é o ato de quem administra contas,
// e "quem mudou o meu e-mail?" tem resposta diferente quando foi o titular.
// Telefone e ramal entram só como NOME de campo — o número nunca vai à trilha.
export const CONTA_DADOS_ALTERADOS_PELO_TITULAR = "CONTA_DADOS_ALTERADOS_PELO_TITULAR";
export const EMAIL_ALTERADO_PELO_TITULAR = "EMAIL_ALTERADO_PELO_TITULAR";
export const TROCA_DE_EMAIL_PEDIDA = "TROCA_DE_EMAIL_PEDIDA";
// Login é o e-mail (23/10/2026): a conversão das contas antigas, na
// publicação, só no banco com a marca de produção (`login_email.ts`). Tipo
// novo: os textos já gravados na trilha não mudam (a cadeia é por hash).
export const LOGIN_CONVERTIDO_PARA_EMAIL = "LOGIN_CONVERTIDO_PARA_EMAIL";
// Liberação por módulo e turmas por setor (22/10/2026). Tipos novos: os textos
// já gravados na trilha não mudam (a cadeia é por hash). O nível guarda o
// anterior e o novo em `valor_anterior`/`valor_novo`, e o módulo em `campo`.
export const NIVEL_MODULO_PERFIL_ALTERADO = "NIVEL_MODULO_PERFIL_ALTERADO";
export const NIVEL_MODULO_PESSOA_ALTERADO = "NIVEL_MODULO_PESSOA_ALTERADO";
export const SETOR_PROMOTOR_VINCULADO = "SETOR_PROMOTOR_VINCULADO";
export const SETOR_PROMOTOR_DESVINCULADO = "SETOR_PROMOTOR_DESVINCULADO";
// O documento saiu, o PDF não. Na nuvem não há LibreOffice (`pdf.disponivel()`
// é falso) e a falha "indisponível" não suja a trilha; o evento continua
// declarado porque é chave de banco e os eventos importados o trazem.
export const PDF_NAO_GERADO = "PDF_NAO_GERADO";
// Limpeza do módulo Certificados e Treinamentos pela linha de comando
// (23/10/2026, `ferramentas/limpar-treinamentos.ts`): um evento só, com as
// contagens por tabela e sem dado pessoal.
export const DADOS_DE_TREINAMENTO_APAGADOS = "DADOS_DE_TREINAMENTO_APAGADOS";
// RN-21 em aviso: o termo de saúde ficou no texto porque quem escreveu confirmou
export const MENCAO_SAUDE_CONFIRMADA = "MENCAO_SAUDE_CONFIRMADA";

// ---------------------------------------------------------------------
// Módulo de acidentes (CAT/SP, 23/10/2026). Entidade `acidente_ocorrencia`, salvo
// indicação; a descrição nunca leva nome, descrição do fato nem dado de saúde, e
// a trilha de saúde guarda só os NOMES dos campos e o nível, nunca os valores.
// ---------------------------------------------------------------------
export const ACIDENTE_COMUNICADO = "ACIDENTE_COMUNICADO";
export const ACIDENTE_COMUNICACAO_PUBLICA = "ACIDENTE_COMUNICACAO_PUBLICA";
export const ACIDENTE_ACIDENTADO_VINCULADO = "ACIDENTE_ACIDENTADO_VINCULADO";
export const ACIDENTE_PUBLICO_HONEYPOT = "ACIDENTE_PUBLICO_HONEYPOT";
export const ACIDENTE_ASSUMIDO = "ACIDENTE_ASSUMIDO";
export const ACIDENTE_ESTADO_ALTERADO = "ACIDENTE_ESTADO_ALTERADO";
export const ACIDENTE_COMPLEMENTACAO_PEDIDA = "ACIDENTE_COMPLEMENTACAO_PEDIDA";
export const ACIDENTE_COMPLEMENTACAO_RESPONDIDA = "ACIDENTE_COMPLEMENTACAO_RESPONDIDA";
export const ACIDENTE_CANCELADO = "ACIDENTE_CANCELADO";
export const ACIDENTE_CAT_SP_RETIFICADA = "ACIDENTE_CAT_SP_RETIFICADA";
export const ACIDENTE_PRAZO_PRORROGADO = "ACIDENTE_PRAZO_PRORROGADO";
export const ACIDENTE_SAUDE_REGISTRADA = "ACIDENTE_SAUDE_REGISTRADA";
export const ACIDENTE_SAUDE_ALTERADA = "ACIDENTE_SAUDE_ALTERADA";
export const ACIDENTE_SAUDE_EXPURGO_PARCIAL = "ACIDENTE_SAUDE_EXPURGO_PARCIAL";
export const ACIDENTE_SAUDE_FORA_RESPONSAVEL = "ACIDENTE_SAUDE_FORA_RESPONSAVEL";
export const ACIDENTE_INVESTIGACAO_SALVA = "ACIDENTE_INVESTIGACAO_SALVA";
export const ACIDENTE_CHECKLIST_SALVO = "ACIDENTE_CHECKLIST_SALVO";
export const ACIDENTE_ENTREVISTA_REGISTRADA = "ACIDENTE_ENTREVISTA_REGISTRADA";
export const ACIDENTE_GRAVACAO_ANEXADA = "ACIDENTE_GRAVACAO_ANEXADA";
export const ACIDENTE_EVIDENCIA_ANEXADA = "ACIDENTE_EVIDENCIA_ANEXADA";
export const ACIDENTE_ACAO_CRIADA = "ACIDENTE_ACAO_CRIADA";
export const ACIDENTE_ACAO_ALTERADA = "ACIDENTE_ACAO_ALTERADA";
export const ACIDENTE_ACAO_CONCLUIDA = "ACIDENTE_ACAO_CONCLUIDA";
export const ACIDENTE_ACAO_CANCELADA = "ACIDENTE_ACAO_CANCELADA";
export const ACIDENTE_RELATORIO_EMITIDO = "ACIDENTE_RELATORIO_EMITIDO";
export const ACIDENTE_RELATORIO_RETIFICADO = "ACIDENTE_RELATORIO_RETIFICADO";
export const ACIDENTE_ENCAMINHADO_SIASS = "ACIDENTE_ENCAMINHADO_SIASS";
export const ACIDENTE_DECISAO_PERICIAL = "ACIDENTE_DECISAO_PERICIAL";
export const ACIDENTE_CONCLUIDO = "ACIDENTE_CONCLUIDO";
export const ACIDENTE_EMAIL_ENFILEIRADO = "ACIDENTE_EMAIL_ENFILEIRADO";
export const ACIDENTE_LINK_GERADO = "ACIDENTE_LINK_GERADO";
export const ACIDENTE_LINK_DESLIGADO = "ACIDENTE_LINK_DESLIGADO";
export const ACIDENTE_IMPORTADO = "ACIDENTE_IMPORTADO";

// ---------------------------------------------------------------------
// O nome do evento na tela
// ---------------------------------------------------------------------
// `tipo_evento` é chave: entra no digest da cadeia e o filtro de /auditoria
// consulta por ela. O mapa mora aqui, e não no template, porque a trilha
// aparece em quatro telas de três módulos.
export const ROTULO_EVENTO: Record<string, string> = {
  // --- fundação e conta ---
  BOOTSTRAP_SUPERINTENDENTE: "Primeiro acesso do superintendente",
  IMPLANTACAO_PRODUCAO: "Implantação em produção",
  HABILITACAO_VINCULADA: "Habilitação ligada a uma conta",
  HABILITACAO_DESVINCULADA: "Habilitação desligada da conta",
  USUARIO_CRIADO: "Conta criada",
  USUARIO_ATIVADO: "Conta ativada",
  USUARIO_INATIVADO: "Conta inativada",
  SENHA_RESETADA: "Senha redefinida",
  SENHA_RESET_RECUSADO: "Redefinição de senha recusada",
  SENHA_TROCADA: "Senha trocada pelo próprio dono",
  CONTA_DADOS_ALTERADOS_PELO_TITULAR: "Dados da conta alterados pelo próprio titular",
  EMAIL_ALTERADO_PELO_TITULAR: "E-mail da conta alterado pelo próprio titular",
  TROCA_DE_EMAIL_PEDIDA: "Troca do e-mail da conta pedida (aguarda o link no e-mail novo)",
  LOGIN_CONVERTIDO_PARA_EMAIL: "Login convertido para o e-mail",
  // Ativar meu acesso / Esqueci minha senha (23/10/2026, `ativar_acesso.ts`): o
  // ator é "o próprio titular" e a descrição nunca leva nome, SIAPE nem e-mail.
  ACESSO_ATIVADO: "Acesso ativado pelo próprio titular (Ativar meu acesso)",
  ACESSO_CRIADO_NO_CADASTRO: "Conta criada com o cadastro do servidor, sem senha (o titular a define)",
  ACESSO_EMAIL_ACOMPANHOU_CADASTRO: "E-mail da conta sem senha acompanhou o cadastro do servidor",
  ACESSO_ENCERRADO_NA_SAIDA: "Conta inativada: o servidor saiu do quadro",
  ACESSO_MANTIDO_NA_SAIDA: "Conta de administração mantida apesar da saída do servidor",
  SENHA_REDEFINIDA_POR_LINK: "Senha redefinida pelo próprio titular, por link no e-mail",
  PEDIDO_DE_ACESSO_RECUSADO: "Pedido de ativação de acesso não atendido por esta via",
  // Cadastre-se do terceirizado e do discente (`pedido_conta.ts`): a descrição
  // leva o número do pedido e o vínculo, nunca o nome nem o e-mail.
  PEDIDO_DE_CONTA_RECEBIDO: "Pedido de conta recebido pelo Cadastre-se",
  PEDIDO_DE_CONTA_APROVADO: "Pedido de conta aprovado: conta criada",
  PEDIDO_DE_CONTA_RECUSADO: "Pedido de conta recusado",
  CONTA_BLOQUEADA: "Conta bloqueada por tentativas",
  PERMISSAO_ACRESCENTADA_AO_PERFIL: "Permissão acrescentada ao perfil",
  PERMISSAO_RETIRADA_DO_PERFIL: "Permissão retirada do perfil",
  NIVEL_MODULO_PERFIL_ALTERADO: "Nível de acesso a módulo alterado no perfil",
  NIVEL_MODULO_PESSOA_ALTERADO: "Nível de acesso a módulo alterado para a pessoa",
  SETOR_PROMOTOR_VINCULADO: "Conta vinculada a setor promotor",
  SETOR_PROMOTOR_DESVINCULADO: "Conta desvinculada de setor promotor",
  PERFIL_CONCEDIDO: "Perfil concedido",
  PERFIL_ENCERRADO: "Perfil encerrado",
  PERFIL_CANCELADO: "Concessão futura cancelada",
  PERFIL_CONCESSAO_RECUSADA: "Concessão de perfil recusada",
  USUARIO_ALTERADO: "Dados da conta alterados",
  CONTA_DESBLOQUEADA: "Conta desbloqueada",
  HABILITACAO_ENCERRADA: "Habilitação encerrada",
  HABILITACAO_CORRIGIDA: "Habilitação corrigida",
  HABILITACAO_RECUSADA: "Atestação ou vínculo de habilitação recusado",
  ATO_NORMATIVO_ALTERADO: "Ato normativo da concessão alterado",
  SERVIDOR_VINCULADO: "Conta vinculada a servidor",
  SERVIDOR_DESVINCULADO: "Conta desvinculada de servidor",
  HABILITACAO_ATESTADA: "Habilitação atestada",
  HABILITACAO_EXTERNA_ATESTADA: "Habilitação externa atestada",
  BACKUP_EXECUTADO: "Backup executado",
  EXPORTACAO_COMPLETA: "Exportação completa",
  // --- genérico da trilha ---
  CAMPO_ALTERADO: "Campo alterado",
  PDF_NAO_GERADO: "PDF não gerado",
  ESTADO_ALTERADO: "Estado alterado",
  COMENTARIO: "Comentário",
  AVISO: "Aviso",
  // --- processo (módulo Adicional Ocupacional) ---
  PROCESSO_CRIADO: "Processo criado",
  RESPONSAVEL_ALTERADO: "Responsável alterado",
  SLA_ALTERADO: "Prazo de SLA alterado",
  NUP_DV_DISPENSADO: "Dígito verificador do NUP dispensado",
  CHECKLIST_APLICADO: "Checklist aplicado",
  ANEXO_ENVIADO: "Anexo enviado",
  ANEXO_DUPLICADO: "Anexo idêntico já existente",
  // nasce com `servicos/anexo_acesso`: é a linha que diz QUAL arquivo saiu.
  ANEXO_BAIXADO: "Anexo baixado",
  ANO_INFERIDO: "Ano inferido na carga",
  CONFLITO_NUMERACAO: "Conflito de numeração",
  LOTACAO_ALTERADA: "Lotação alterada",
  SERVIDOR_CRIADO: "Servidor cadastrado",
  SERVIDORES_IMPORTADOS: "Servidores importados por planilha",
  // --- laudo e parecer ---
  PARECER_RASCUNHO_CRIADO: "Rascunho de parecer criado",
  NUMERO_DEFINIDO_MANUALMENTE: "Número definido manualmente",
  EXPOSICAO_ADICIONADA: "Exposição adicionada",
  CLASSIFICACAO_DIVERGENTE: "Classificação divergente da apurada",
  EXCECAO_ART9_APLICADA: "Exceção do art. 9º aplicada",
  EPI_NEUTRALIZACAO_AVALIADA: "Neutralização por EPI avaliada",
  PARECER_EMITIDO: "Parecer emitido",
  PARECER_ASSINADO: "Parecer assinado",
  PARECER_ANULADO: "Parecer anulado",
  ASSINATURA_NEGADA: "Assinatura negada",
  ASSINATURA_REGISTRADA_POR_SUBSTITUTO: "Assinatura registrada por substituto",
  PRESCRICAO_QUINQUENAL_ALERTADA: "Prescrição quinquenal alertada",
  REUSO_DE_LAUDO: "Reuso de laudo",
  LAUDO_SUPERADO: "Laudo superado",
  LAUDO_POSTO_VINCULADO: "Posto vinculado ao laudo",
  LAUDO_POSTO_DESVINCULADO: "Posto desvinculado do laudo",
  MENCAO_SAUDE_CONFIRMADA: "Menção a saúde confirmada",
  // --- direito ao adicional ---
  DIREITO_PROPOSTO: "Adicional proposto",
  DIREITO_VIGENTE: "Adicional vigente",
  DIREITO_SUSPENSO: "Adicional suspenso",
  DIREITO_EM_REAVALIACAO: "Adicional em reavaliação",
  DIREITO_ALTERADO: "Adicional alterado",
  DIREITO_CESSADO: "Adicional cessado",
  // --- pendências ---
  PENDENCIA_ABERTA: "Pendência aberta",
  PENDENCIA_REABERTA: "Pendência reaberta",
  PENDENCIA_CONCLUIDA: "Pendência concluída",
  // --- demandas (base compartilhada) ---
  DEMANDA_REGISTRADA: "Demanda registrada",
  DEMANDA_EM_ANDAMENTO: "Demanda em andamento",
  DEMANDA_ENCAMINHADA: "Demanda encaminhada",
  DEMANDA_ENCERRADA: "Demanda encerrada",
  DEMANDA_RESPONSAVEL_ALTERADO: "Responsável da demanda alterado",
  // --- catálogos ---
  AGENTE_CRIADO: "Agente nocivo cadastrado",
  CAMPUS_CRIADO: "Campus cadastrado",
  UNIDADE_CRIADA: "Unidade cadastrada",
  POSTO_CRIADO: "Posto de trabalho cadastrado",
  CARGO_CRIADO: "Cargo cadastrado",
  PORTARIA_CRIADA: "Portaria cadastrada",
  TEXTO_VERSIONADO: "Texto padrão versionado",
  CHECKLIST_MODELO_CRIADO: "Modelo de checklist cadastrado",
  AUTORIDADE_CRIADA: "Autoridade destinatária cadastrada",
  SETOR_EMISSOR_CRIADO: "Setor emissor cadastrado",
  // --- certificados e treinamentos ---
  TREINAMENTO_CRIADO: "Treinamento cadastrado",
  TREINAMENTO_EXCLUIDO: "Treinamento excluído do catálogo",
  TURMA_CRIADA: "Turma criada",
  TURMA_EXCLUIDA: "Turma excluída",
  TURMA_RETIFICADA: "Turma concluída corrigida",
  TURMA_APURADA: "Turma apurada",
  TURMA_REALIZADA_REGISTRADA: "Turma já realizada registrada",
  TURMA_INSTRUTOR_VINCULADO: "Instrutor vinculado à turma",
  TURMA_INSTRUTOR_DESVINCULADO: "Instrutor desvinculado da turma",
  // NUVEM (Dono de treinamento e turma, 23/10/2026): `dono_turma.ts`
  TURMA_AJUDANTE_DESIGNADO: "Ajudante designado na turma",
  TURMA_AJUDANTE_RETIRADO: "Ajudante retirado da turma",
  INSCRICAO_CRIADA: "Inscrição criada",
  // Os dois atos do PRÓPRIO servidor: "quem pediu esta vaga?" e "quem
  // desistiu dela?" são fatos diferentes de "a secretaria inscreveu".
  INSCRICAO_PEDIDA_PELO_TITULAR: "Inscrição pedida pelo próprio servidor",
  INSCRICAO_DESISTIDA: "Desistência do próprio inscrito",
  // NUVEM: a inscrição pública por link (sem e-mail; a equipe confere o pedido)
  INSCRICAO_LINK_GERADO: "Link público de inscrição gerado",
  INSCRICAO_LINK_DESLIGADO: "Link público de inscrição desligado",
  INSCRICAO_PEDIDA_PELO_LINK: "Inscrição pedida pelo link público",
  INSCRICAO_PEDIDO_CONFERIDO: "Pedido do link público aceito pela equipe",
  PARTICIPANTE_CRIADO: "Participante externo cadastrado",
  PARTICIPANTE_CORRIGIDO: "Dados do participante corrigidos",
  PARTICIPANTE_MESCLADO: "Cadastros do participante juntados",
  // o fato, nunca o valor: a trilha diz que o CPF mudou, e não qual é
  PARTICIPANTE_CPF_ALTERADO: "CPF do participante (certificado) alterado",
  // Prevenção de cadastros duplicados (23/10/2026, `servicos/duplicados.ts`)
  PARTICIPANTES_DISTINTOS: "Cadastros conferidos: não são a mesma pessoa",
  PARTICIPANTE_SUSPEITO_DUPLICADO: "Participante cadastrado sem conferência de duplicidade",
  AVISO_CADASTRO_EXISTENTE: "Aviso de pedido pelo link enviado ao e-mail do cadastro",
  EMAIL_CONFIRMADO_PELO_LINK: "E-mail do participante confirmado pelo link de acesso",
  PRESENCA_LANCADA: "Presença lançada",
  PRESENCA_EM_LOTE: "Presença lançada em lote",
  NOTA_LANCADA: "Nota lançada",
  RESULTADO_RETIFICADO: "Resultado retificado",
  LISTA_PRESENCA_GERADA: "Lista de presença gerada",
  CERTIFICADO_EMITIDO: "Certificado emitido",
  CERTIFICADO_ENVIO_PEDIDO: "Envio do certificado por e-mail pedido",
  RECICLAGEM_AVISO_PEDIDO: "Aviso de reciclagem por e-mail pedido",
  RECICLAGEM_AVISO_AUTOMATICO: "Aviso de reciclagem automático ligado/desligado",
  CERTIFICADO_LOTE: "Certificados emitidos em lote",
  CERTIFICADO_SEGUNDA_VIA: "Segunda via de certificado",
  CERTIFICADO_ANULADO: "Certificado anulado",
  CERTIFICADO_RETIFICADO: "Certificado retificado (substituto emitido)",
  CERTIFICADO_DIVERGENTE: "Divergência no certificado",
  CERTIFICADO_MODELO_CRIADO: "Modelo de certificado cadastrado",
  CERTIFICADO_MODELO_VERSIONADO: "Modelo de certificado versionado",
  TREINAMENTO_MODELO_REPONTADO: "Treinamento passou à versão nova do modelo",
  ASSINATURA_INSTRUTOR_CRIADA: "Assinatura de instrutor cadastrada",
  ASSINATURA_INSTRUTOR_CPF_ALTERADO: "CPF do instrutor (certificado) alterado",
  ASSINATURA_INSTRUTOR_EXCLUIDA: "Instrutor excluído",
  RUBRICA_INSTRUTOR_DEFINIDA: "Rubrica do instrutor enviada",
  RUBRICA_INSTRUTOR_REMOVIDA: "Rubrica do instrutor retirada",
  MODELO_TAG_MAPEADA: "Marcador do modelo mapeado",
  MODELO_TAG_REMOVIDA: "Marcador do modelo removido",
  CERTIFICADO_CAMPO_TURMA_ALTERADO: "Campo do certificado preenchido na turma",
  CERTIFICADO_CAMPO_PARTICIPANTE_ALTERADO: "Campo do certificado preenchido para o participante",
  // --- EPI: catálogo e estoque ---
  EPI_ITEM_CRIADO: "Item cadastrado no catálogo de EPI",
  EPI_MOTIVO_RECUSA_CRIADO: "Motivo de recusa cadastrado",
  EPI_LOTE_REGISTRADO: "Lote de EPI registrado",
  EPI_LOTE_ALTERADO: "Lote de EPI alterado",
  EPI_ESTOQUE_AJUSTADO: "Estoque de EPI ajustado",
  EPI_ESTOQUE_DESCARTADO: "Lote de EPI descartado",
  // --- EPI: ficha do servidor ---
  EPI_ENTREGUE: "EPI entregue",
  EPI_DEVOLVIDO: "EPI devolvido",
  EPI_ESTORNADO: "Registro de EPI estornado",
  EPI_ENTREGA_RECUSADA: "Entrega de EPI recusada",
  EPI_MAXIMO_EXCEDIDO: "Máximo de EPI excedido",
  EPI_COMPROVANTE_IMPRESSO: "Comprovante de EPI impresso",
  EPI_COMPROVANTE_ANEXADO: "Comprovante de EPI anexado",
  EPI_COMPROVANTE_DIVERGENTE: "Comprovante de EPI divergente",
  // --- EPI: requisição (o envelope) ---
  EPI_REQUISICAO_CRIADA: "Requisição criada",
  EPI_REQUISICAO_ENVIADA: "Requisição enviada",
  EPI_REQUISICAO_EM_ANALISE: "Requisição em análise",
  EPI_REQUISICAO_DEVOLVIDA: "Requisição devolvida à fila",
  EPI_REQUISICAO_ANALISADA: "Requisição analisada",
  EPI_REQUISICAO_INDEFERIDA: "Requisição indeferida",
  EPI_REQUISICAO_RECONSIDERADA: "Requisição reconsiderada",
  EPI_REQUISICAO_EM_ATENDIMENTO: "Requisição em atendimento",
  EPI_REQUISICAO_ATENDIDA: "Requisição atendida",
  EPI_REQUISICAO_CANCELADA: "Requisição cancelada",
  EPI_REQUISICAO_EXCLUIDA: "Rascunho de requisição excluído",
  // --- EPI: item da requisição (onde a decisão acontece) ---
  EPI_ITEM_APROVADO: "Item do pedido aprovado",
  EPI_ITEM_RECUSADO: "Item do pedido recusado",
  EPI_ITEM_CANCELADO: "Item do pedido cancelado",
  EPI_ITEM_RESERVADO: "Item do pedido reservado",
  EPI_ITEM_RESERVA_SOLTA: "Reserva do item solta",
  EPI_ITEM_SEM_ESTOQUE: "Item do pedido sem estoque",
  EPI_ITEM_ENTREGUE: "Item do pedido entregue",
  // --- EPI: paridade com o IntegraSST (22/10/2026, migração 0015) ---
  // A: o titular comunica o EPI que está com ele (texto neutro — Decisão 5)
  EPI_COMUNICACAO_REGISTRADA: "Situação do EPI comunicada pelo titular",
  EPI_COMUNICACAO_RETIRADA: "Comunicação do titular retirada",
  EPI_COMUNICACAO_TRATADA: "Comunicação do titular tratada pela equipe",
  // B: o termo NR-06 declarado por quem envia o pedido
  EPI_REQUISICAO_TERMO_ACEITO: "Termo NR-06 declarado no envio do pedido",
  // C: foto e PDF de orientação do catálogo
  EPI_ITEM_IMAGEM_ENVIADA: "Foto do EPI enviada ao catálogo",
  EPI_ITEM_ORIENTACAO_ENVIADA: "Orientação (PDF) do EPI enviada ao catálogo",
  DADOS_DE_TREINAMENTO_APAGADOS: "Dados de treinamento apagados (limpeza pela linha de comando)",
  // E: treinamento exigido pelo EPI (avisa, não bloqueia — Decisão 2)
  EPI_ITEM_TREINAMENTO_VINCULADO: "Treinamento exigido vinculado ao EPI",
  EPI_ITEM_TREINAMENTO_DESVINCULADO: "Treinamento exigido desvinculado do EPI",
  EPI_SEM_TREINAMENTO_CONFIRMADO: "Entrega sem treinamento em vigor confirmada",
  // F: e-mail do pedido (enfileirado na caixa de saída)
  EPI_EMAIL_ENFILEIRADO: "E-mail do pedido de EPI posto na fila",
  // --- Acidentes (CAT/SP, 23/10/2026) ---
  ACIDENTE_COMUNICADO: "Acidente comunicado",
  ACIDENTE_COMUNICACAO_PUBLICA: "Acidente comunicado pelo formulário por link",
  ACIDENTE_ACIDENTADO_VINCULADO: "Acidentado vinculado ao cadastro de servidores",
  ACIDENTE_PUBLICO_HONEYPOT: "Envio do formulário por link barrado (campo isca)",
  ACIDENTE_ASSUMIDO: "Ocorrência de acidente assumida",
  ACIDENTE_ESTADO_ALTERADO: "Situação da ocorrência de acidente alterada",
  ACIDENTE_COMPLEMENTACAO_PEDIDA: "Complementação da comunicação pedida",
  ACIDENTE_COMPLEMENTACAO_RESPONDIDA: "Complementação da comunicação respondida",
  ACIDENTE_CANCELADO: "Ocorrência de acidente cancelada",
  ACIDENTE_CAT_SP_RETIFICADA: "CAT/SP retificada (versão nova)",
  ACIDENTE_PRAZO_PRORROGADO: "Prazo de comunicação do acidente prorrogado",
  ACIDENTE_SAUDE_REGISTRADA: "Saúde do acidentado registrada",
  ACIDENTE_SAUDE_ALTERADA: "Saúde do acidentado alterada",
  ACIDENTE_SAUDE_EXPURGO_PARCIAL: "Detalhe de saúde do acidentado expurgado",
  ACIDENTE_SAUDE_FORA_RESPONSAVEL: "Saúde do acidentado aberta por quem não conduz o caso",
  ACIDENTE_INVESTIGACAO_SALVA: "Investigação do acidente salva",
  ACIDENTE_CHECKLIST_SALVO: "Checklist de campo salvo",
  ACIDENTE_ENTREVISTA_REGISTRADA: "Entrevista de campo registrada",
  ACIDENTE_GRAVACAO_ANEXADA: "Gravação de entrevista anexada",
  ACIDENTE_EVIDENCIA_ANEXADA: "Evidência do acidente anexada",
  ACIDENTE_ACAO_CRIADA: "Ação do plano criada",
  ACIDENTE_ACAO_ALTERADA: "Ação do plano alterada",
  ACIDENTE_ACAO_CONCLUIDA: "Ação do plano concluída",
  ACIDENTE_ACAO_CANCELADA: "Ação do plano cancelada",
  ACIDENTE_RELATORIO_EMITIDO: "Relatório do acidente emitido",
  ACIDENTE_RELATORIO_RETIFICADO: "Relatório do acidente retificado",
  ACIDENTE_ENCAMINHADO_SIASS: "Ocorrência encaminhada ao SIASS",
  ACIDENTE_DECISAO_PERICIAL: "Decisão da perícia registrada",
  ACIDENTE_CONCLUIDO: "Ocorrência de acidente concluída",
  ACIDENTE_EMAIL_ENFILEIRADO: "E-mail do acidente posto na fila",
  ACIDENTE_LINK_GERADO: "Link do formulário de acidente gerado",
  ACIDENTE_LINK_DESLIGADO: "Link do formulário de acidente desligado",
  ACIDENTE_IMPORTADO: "Ocorrência migrada da planilha antiga",
};

/** `str.capitalize()` do Python: primeira maiúscula, o resto minúsculo. */
function capitalize(s: string): string {
  if (!s) return s;
  const [primeira, ...resto] = [...s];
  return primeira!.toUpperCase() + resto.join("").toLowerCase();
}

/**
 * O `tipo_evento` como a tela deve escrevê-lo. O recuo humaniza o código em
 * vez de devolvê-lo cru: a carga do Trello grava o tipo da ação ORIGINAL, que
 * não está neste mapa, e ali a pessoa precisa distinguir um do outro.
 */
export function rotulo_evento(codigo: string | null | undefined): string {
  if (!codigo) return "—";
  return (Object.hasOwn(ROTULO_EVENTO, codigo) ? ROTULO_EVENTO[codigo] : "") || capitalize(codigo.replaceAll("_", " "));
}

/** `valor_anterior`/`valor_novo` que não volta do banco como foi gravado. */
export class ValorNaoAuditavel extends RegraViolada {}

// =====================================================================
// A serialização canônica: o `json.dumps(..., ensure_ascii=False,
// sort_keys=True, default=str)` do Python
// =====================================================================
const dois = (n: number) => String(n).padStart(2, "0");

/** `datetime.isoformat()` de um instante UTC: `2026-02-11T12:00:00+00:00`. */
export function isoformat(momento: Date): string {
  const base =
    `${String(momento.getUTCFullYear()).padStart(4, "0")}-${dois(momento.getUTCMonth() + 1)}-` +
    `${dois(momento.getUTCDate())}T${dois(momento.getUTCHours())}:${dois(momento.getUTCMinutes())}:` +
    `${dois(momento.getUTCSeconds())}`;
  const ms = momento.getUTCMilliseconds();
  return `${base}${ms ? "." + String(ms * 1000).padStart(6, "0") : ""}+00:00`;
}

/** `str(datetime)` do Python — o que o `default=str` produz para um instante. */
function str_datetime(momento: Date): string {
  return isoformat(momento).replace("T", " ");
}

/**
 * `repr(float)` do Python para os não inteiros: o mesmo dígito mais curto do
 * JS, com a notação que o Python escolhe (científica abaixo de 1e-4 e a partir
 * de 1e16, expoente com pelo menos dois dígitos).
 */
function repr_numero(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  const [mantissa, exp] = n.toExponential().split("e") as [string, string];
  const e = Number(exp);
  if (e >= -4 && e < 16) {
    const s = String(n);
    return s.includes(".") ? s : s + ".0";
  }
  const sinal = e < 0 ? "-" : "+";
  return `${mantissa}e${sinal}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** Ordem das chaves do `sort_keys`: ponto de código, não unidade UTF-16. */
function comparar_chaves(a: string, b: string): number {
  const pa = [...a];
  const pb = [...b];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const d = pa[i]!.codePointAt(0)! - pb[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return pa.length - pb.length;
}

function e_objeto_simples(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** O `default=str`: o que o JSON não tem vira texto. */
function padrao_str(v: unknown): string {
  if (v instanceof Date) return str_datetime(v);
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/**
 * A forma serializada que entra no digest. Compara valor, não objeto. É a
 * mesma função que monta o texto gravado na coluna — uma regra só.
 */
export function corpo(valor: unknown): string {
  if (valor === null || valor === undefined) return "null";
  if (typeof valor === "string") return JSON.stringify(valor);
  if (typeof valor === "boolean") return valor ? "true" : "false";
  if (typeof valor === "number") return repr_numero(valor);
  if (Array.isArray(valor)) return "[" + valor.map(corpo).join(", ") + "]";
  if (typeof valor === "object" && e_objeto_simples(valor)) {
    const chaves = Object.keys(valor).sort(comparar_chaves);
    return (
      "{" +
      chaves.map((k) => `${JSON.stringify(k)}: ${corpo((valor as Record<string, unknown>)[k])}`).join(", ") +
      "}"
    );
  }
  return JSON.stringify(padrao_str(valor));
}

/** O jsonb recusa `\u0000` em texto: o que voltaria é o texto sem ele. */
function sem_nulo(v: unknown): unknown {
  if (typeof v === "string") return v.replaceAll("\u0000", "");
  if (Array.isArray(v)) return v.map(sem_nulo);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replaceAll("\u0000", ""), sem_nulo(x)]));
  }
  return v;
}

/**
 * O que a coluna faz com o valor, ida e volta — a simulação que a trava usa.
 * Exposto (e trocável nos testes) pelo mesmo motivo do Python: a trava tem de
 * medir o tipo da coluna, e não uma cópia da serialização.
 *
 * Ida: o texto canônico. Volta: o que o jsonb devolve ao driver — `JSON.parse`
 * (o jsonb recusa `\u0000` em texto; a trava diz isso antes do banco).
 */
export const _TIPO_DO_VALOR = {
  ida(valor: unknown): string {
    return corpo(valor);
  },
  volta(texto: string): unknown {
    let valor: unknown;
    try {
      // NaN/Infinity não são JSON (nem cabem no jsonb): o parse falha, a volta
      // é o texto cru, e a trava acusa a diferença
      valor = JSON.parse(texto);
    } catch {
      return texto;
    }
    return sem_nulo(valor);
  },
};

/**
 * A trava: o digest só vale se o valor sobreviver à ida e volta do banco.
 * Conferência por SIMULAÇÃO da coluna, e não por lista de tipos proibidos.
 */
function exigir_valor_estavel(nome: string, valor: unknown): unknown {
  if (valor === null || valor === undefined) return null;
  const bruto = _TIPO_DO_VALOR.ida(valor);
  const devolvido = _TIPO_DO_VALOR.volta(bruto);
  if (corpo(valor) !== corpo(devolvido)) {
    const tipo = valor === null ? "null" : typeof valor === "object" ? (valor as object).constructor?.name ?? "object" : typeof valor;
    throw new ValorNaoAuditavel(
      `${nome}=${corpo(valor)} (${tipo}) nao sobrevive a coluna: ` +
        `o banco devolveria ${corpo(devolvido)} e o ` +
        "digest da trilha deixaria de conferir. Grave o valor de verdade " +
        "(numero, texto de data) em vez de uma forma que o JSON releia " +
        "diferente.",
    );
  }
  // o que vai para o jsonb é o valor JÁ passado pelo `default=str` — o mesmo
  // que foi digerido
  return devolvido;
}

/** O que `_digerir` lê do evento — gravado ou relido. */
export interface EventoDigerivel {
  entidade: string;
  entidade_id: number;
  tipo_evento: string;
  descricao: string;
  campo: string | null;
  valor_anterior: unknown;
  valor_novo: unknown;
  usuario_nome: string;
  ocorrido_em: Date | string;
}

function _digerir(evento: EventoDigerivel, anterior: string | null): string {
  const texto = corpo({
    entidade: evento.entidade,
    entidade_id: evento.entidade_id,
    tipo: evento.tipo_evento,
    descricao: evento.descricao,
    campo: evento.campo,
    anterior: evento.valor_anterior,
    novo: evento.valor_novo,
    usuario: evento.usuario_nome,
    ocorrido_em: evento.ocorrido_em instanceof Date ? isoformat(evento.ocorrido_em) : String(evento.ocorrido_em),
    hash_anterior: anterior,
  });
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/**
 * Pontos de instrumentação dos testes (o `monkeypatch.setattr(auditoria,
 * "_digerir", ...)` do Python — export de ESM não se troca por fora).
 */
export const _instrumentos = { digerir: _digerir };
export { _digerir };

/** Chave da advisory lock que serializa a cadeia (`'hist'` em ASCII). */
export const TRAVA_CADEIA = 0x68697374;
/** Chave da advisory lock da conferência completa (`'conf'`). */
export const TRAVA_CONFERENCIA = 0x636f6e66;

export interface DadosRegistro {
  entidade: string;
  entidade_id: number;
  tipo_evento: string;
  descricao: string;
  usuario?: UsuarioAtual | null;
  usuario_nome?: string | null;
  processo_id?: number | null;
  campo?: string | null;
  valor_anterior?: unknown;
  valor_novo?: unknown;
  comentario?: string | null;
  ocorrido_em?: Date | null;
  origem?: string;
  origem_ref?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

export async function registrar(tx: Executor, d: DadosRegistro): Promise<HistoricoEvento> {
  // antes de qualquer coisa: por aqui passa TODA gravação da trilha, e evento
  // com digest que não fecha é pior do que evento nenhum
  const valor_anterior = exigir_valor_estavel("valor_anterior", d.valor_anterior);
  const valor_novo = exigir_valor_estavel("valor_novo", d.valor_novo);

  // um escritor da cadeia por vez (ver o cabeçalho): a trava sai no COMMIT
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TRAVA_CADEIA})`);
  const [ultimo] = await tx
    .select({ hash_atual: historico_evento.hash_atual })
    .from(historico_evento)
    .orderBy(desc(historico_evento.id))
    .limit(1);
  const anterior = ultimo ? ultimo.hash_atual : null;

  const evento = {
    entidade: d.entidade,
    entidade_id: d.entidade_id,
    processo_id: d.processo_id ?? null,
    tipo_evento: d.tipo_evento,
    descricao: d.descricao,
    comentario: d.comentario ?? null,
    campo: d.campo ?? null,
    valor_anterior,
    valor_novo,
    usuario_id: d.usuario ? d.usuario.id : null,
    usuario_nome: d.usuario_nome || (d.usuario ? d.usuario.nome : "sistema"),
    ocorrido_em: d.ocorrido_em ?? agora_utc(),
    registrado_em: agora_utc(),
    origem: d.origem ?? "SISTEMA",
    origem_ref: d.origem_ref ?? null,
    ip: d.ip ?? null,
    user_agent: d.user_agent ?? null,
    hash_anterior: anterior,
    hash_atual: null as string | null,
  };
  evento.hash_atual = _instrumentos.digerir(evento, anterior);
  const [gravado] = await tx.insert(historico_evento).values(evento).returning();
  return gravado!;
}

/** `repr()` do Python para a descrição de `registrar_diferencas`. */
function repr_python(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") {
    const aspas = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    if (aspas === "'") s = s.replaceAll("'", "\\'");
    return `${aspas}${s}${aspas}`;
  }
  if (typeof v === "number") return repr_numero(v);
  if (Array.isArray(v)) return "[" + v.map(repr_python).join(", ") + "]";
  if (v instanceof Date) return `'${str_datetime(v)}'`;
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => `${repr_python(k)}: ${repr_python(x)}`).join(", ") + "}";
  }
  return String(v);
}

function iguais(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  return corpo(a) === corpo(b) && typeof a === typeof b;
}

/**
 * RN-21 em aviso: quem escreveu confirmou que a menção a saúde é necessária. A
 * linha diz o campo e os termos — o texto em si fica no registro de origem.
 * Sem termo de saúde no texto, não grava nada (a caixa marcada à toa não é fato).
 */
export async function registrar_mencao_de_saude(
  tx: Executor,
  d: {
    entidade: string;
    entidade_id: number;
    campo: string;
    texto: string | null | undefined;
    usuario: UsuarioAtual;
    processo_id?: number | null;
  },
): Promise<void> {
  const termos = termos_de_saude_em(d.texto);
  if (!termos.length) return;
  await registrar(tx, {
    entidade: d.entidade,
    entidade_id: d.entidade_id,
    processo_id: d.processo_id ?? null,
    tipo_evento: MENCAO_SAUDE_CONFIRMADA,
    descricao: `Menção a dado de saúde confirmada como necessária no campo ${d.campo} (${termos.join(", ")}).`,
    campo: d.campo,
    usuario: d.usuario,
  });
}

/** RN-14: cada campo registrado individualmente. */
export async function registrar_diferencas(
  tx: Executor,
  d: {
    entidade: string;
    entidade_id: number;
    antes: Record<string, unknown>;
    depois: Record<string, unknown>;
    usuario: UsuarioAtual | null;
    processo_id?: number | null;
    tipo_evento?: string;
  },
): Promise<HistoricoEvento[]> {
  const eventos: HistoricoEvento[] = [];
  const campos = [...new Set([...Object.keys(d.antes), ...Object.keys(d.depois)])].sort(comparar_chaves);
  for (const campo of campos) {
    const a = d.antes[campo] ?? null;
    const dp = d.depois[campo] ?? null;
    if (iguais(a, dp)) continue;
    eventos.push(
      await registrar(tx, {
        entidade: d.entidade,
        entidade_id: d.entidade_id,
        tipo_evento: d.tipo_evento ?? "CAMPO_ALTERADO",
        descricao: `${campo}: ${repr_python(a)} -> ${repr_python(dp)}`,
        campo,
        valor_anterior: a,
        valor_novo: dp,
        usuario: d.usuario,
        processo_id: d.processo_id ?? null,
      }),
    );
  }
  return eventos;
}

// ---------------------------------------------------------------------
// Conferir o encadeamento: a janela na tela, a cadeia inteira por fora
// ---------------------------------------------------------------------
// Q-2: `/auditoria` não percorre a tabela inteira a cada abertura. Duas
// perguntas separadas:
//   1. "o que estou vendo confere?" — `janela_integra`, custo da página;
//   2. "a trilha inteira ainda fecha?" — `conferir_fora_da_transacao`, ato
//      deliberado (botão ou rotina), que guarda o resultado em
//      `conferencia_cadeia`.

// Quantas linhas por vez no passe completo (keyset por id): 90 mil eventos não
// são materializados de uma vez para conferir um de cada vez.
const LOTE_DA_CADEIA = 1000;

// As colunas que a conferência lê, e só elas.
const COLUNAS_DA_CADEIA = {
  id: historico_evento.id,
  entidade: historico_evento.entidade,
  entidade_id: historico_evento.entidade_id,
  tipo_evento: historico_evento.tipo_evento,
  descricao: historico_evento.descricao,
  campo: historico_evento.campo,
  valor_anterior: historico_evento.valor_anterior,
  valor_novo: historico_evento.valor_novo,
  usuario_nome: historico_evento.usuario_nome,
  ocorrido_em: historico_evento.ocorrido_em,
  hash_anterior: historico_evento.hash_anterior,
  hash_atual: historico_evento.hash_atual,
};
type LinhaDaCadeia = EventoDigerivel & { id: number; hash_anterior: string | null; hash_atual: string | null };

/** Já há uma conferência completa rodando. */
export class ConferenciaEmCurso extends RegraViolada {}

export const ORIGEM_BOTAO = "BOTAO";
export const ORIGEM_ROTINA = "ROTINA";

/** A trilha inteira, em ordem de id, em lotes. */
async function* percorrer(tx: Executor): AsyncGenerator<LinhaDaCadeia> {
  let depoisDe = 0;
  for (;;) {
    const lote = await tx
      .select(COLUNAS_DA_CADEIA)
      .from(historico_evento)
      .where(gt(historico_evento.id, depoisDe))
      .orderBy(asc(historico_evento.id))
      .limit(LOTE_DA_CADEIA);
    for (const linha of lote) yield linha;
    if (lote.length < LOTE_DA_CADEIA) return;
    depoisDe = lote[lote.length - 1]!.id;
  }
}

/**
 * Percorre eventos JÁ ORDENADOS por id e refaz o encadeamento. Devolve
 * [íntegra, id_do_primeiro_defeito, quantos_foram_conferidos]; o contador para
 * no defeito, e não no fim.
 */
async function conferir(eventos: AsyncIterable<LinhaDaCadeia>): Promise<[boolean, number | null, number]> {
  let anterior: string | null = null;
  let total = 0;
  for await (const evento of eventos) {
    total += 1;
    if (evento.hash_anterior !== anterior) return [false, evento.id, total];
    if (evento.hash_atual !== _instrumentos.digerir(evento, anterior)) return [false, evento.id, total];
    anterior = evento.hash_atual;
  }
  return [true, null, total];
}

/**
 * Reconfere a cadeia INTEIRA. Devolve [ok, id_do_primeiro_defeito].
 *
 * **Não chame isto de dentro de uma requisição** — use `janela_integra` na tela
 * e `conferir_fora_da_transacao` para o passe completo. Continua pública porque
 * é a definição de referência do que "cadeia íntegra" significa, e é por ela
 * que os testes conferem a trilha depois de um cenário.
 */
export async function cadeia_integra(tx: Executor): Promise<[boolean, number | null]> {
  const [integra, defeito] = await conferir(percorrer(tx));
  return [integra, defeito];
}

/**
 * Confere só os eventos exibidos — e a costura de cada um com o anterior REAL
 * na tabela (e não o anterior da lista, que vem filtrada):
 *   1. o corpo confere com o próprio digest?
 *   2. o elo aponta para quem está mesmo atrás?
 */
export async function janela_integra(
  tx: Executor,
  eventos: readonly (EventoDigerivel & { id: number; hash_anterior: string | null; hash_atual: string | null })[],
): Promise<[boolean, number | null]> {
  if (!eventos.length) return [true, null];
  const ids = eventos.map((e) => e.id);
  const linhas = await tx
    .select({
      id: historico_evento.id,
      // a referência à linha de fora vai qualificada à mão: o Drizzle escreve
      // só `"id"` num select de uma tabela, e dentro da subconsulta `"id"`
      // seria o `a.id` — a âncora viraria sempre nula
      hash_do_anterior: sql<string | null>`(
        SELECT a.hash_atual FROM historico_evento a
        WHERE a.id < ${sql.raw('"historico_evento"."id"')}
        ORDER BY a.id DESC LIMIT 1
      )`,
    })
    .from(historico_evento)
    .where(inArray(historico_evento.id, ids));
  const ancora = new Map(linhas.map((l) => [l.id, l.hash_do_anterior ?? null]));

  // em ordem de cadeia, para "o primeiro defeito" ser o primeiro de verdade
  for (const evento of [...eventos].sort((a, b) => a.id - b.id)) {
    if (evento.hash_anterior !== (ancora.get(evento.id) ?? null)) return [false, evento.id];
    if (evento.hash_atual !== _instrumentos.digerir(evento, evento.hash_anterior)) return [false, evento.id];
  }
  return [true, null];
}

/** A conferência completa mais recente — a que a tela data. */
export async function ultima_conferencia(tx: Executor): Promise<ConferenciaCadeia | null> {
  const [r] = await tx.select().from(conferencia_cadeia).orderBy(desc(conferencia_cadeia.id)).limit(1);
  return r ?? null;
}

/**
 * A ÚNICA forma de conferir a cadeia inteira de dentro da aplicação.
 *
 * **Desvio do Python (documentado em DESVIOS.md).** No SQLite esta função
 * comitava a transação da requisição e percorria a trilha numa conexão
 * AUTOCOMMIT, porque a transação segurava o único lock de escrita do banco e o
 * passe demora. No PostgreSQL leitura não bloqueia escrita (MVCC): percorrer a
 * trilha dentro da transação da requisição não trava ninguém, e o commit é do
 * middleware (PORTE.md §4) — então não há commit aqui. O passe lê o retrato da
 * trilha visto por esta transação; eventos gravados por outros durante o passe
 * ficam para a próxima conferência, como ficavam no Python.
 *
 * "Uma conferência por vez" era um `threading.Lock` do processo; na nuvem há
 * várias instâncias da função, então a trava virou `pg_try_advisory_xact_lock`
 * — vale entre instâncias e solta sozinha no fim da transação.
 *
 * O limite de 60 s da função do Netlify é o novo teto do passe (~55 µs por
 * evento no Python: cabe folgado até centenas de milhares de eventos). A
 * rotina agendada é o caminho para trilhas maiores.
 *
 * **Nada disto entra em `historico_evento`**: quem, quando e o que deu ficam em
 * `conferencia_cadeia`.
 */
export async function conferir_fora_da_transacao(
  tx: Executor,
  opcoes: { usuario?: UsuarioAtual | null; origem?: string } = {},
): Promise<ConferenciaCadeia> {
  const origem = opcoes.origem ?? ORIGEM_BOTAO;
  const [trava] = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${TRAVA_CONFERENCIA}) AS ok`);
  if (!trava?.ok) {
    throw new ConferenciaEmCurso(
      "Uma conferência da cadeia inteira já está em andamento. " +
        "Aguarde e recarregue a tela — o resultado aparece aqui.",
    );
  }
  const iniciada_em = agora_utc();
  const relogio = performance.now();
  const [integra, defeito, total] = await conferir(percorrer(tx));
  const [maior] = await tx.select({ ultimo: max(historico_evento.id) }).from(historico_evento);
  const duracao_ms = Math.trunc(performance.now() - relogio);

  const [registro] = await tx
    .insert(conferencia_cadeia)
    .values({
      iniciada_em,
      concluida_em: agora_utc(),
      duracao_ms,
      eventos: total,
      ultimo_evento_id: maior?.ultimo ?? null,
      integra,
      primeiro_defeito_id: defeito,
      origem,
      usuario_id: opcoes.usuario ? opcoes.usuario.id : null,
    })
    .returning();
  return registro!;
}

/** RN-23 — toda leitura de exposição, parecer nominal e anexo RESTRITO. */
export async function registrar_acesso_sensivel(
  tx: Executor,
  usuario: UsuarioAtual,
  campo: string,
  opcoes: {
    servidor_id?: number | null;
    processo_id?: number | null;
    /** a ocorrência de acidente a que a leitura pertence */
    acidente_id?: number | null;
    /** o "sobre quem" quando o acidentado não é servidor (ROPA §9.6) */
    acidentado_id?: number | null;
    finalidade?: string | null;
  } = {},
): Promise<AcessoDadoSensivel> {
  const [registro] = await tx
    .insert(acesso_dado_sensivel)
    .values({
      usuario_id: usuario.id,
      servidor_id: opcoes.servidor_id ?? null,
      processo_id: opcoes.processo_id ?? null,
      acidente_id: opcoes.acidente_id ?? null,
      acidentado_id: opcoes.acidentado_id ?? null,
      campo,
      finalidade: opcoes.finalidade || "consulta operacional do modulo Adicional Ocupacional",
    })
    .returning();
  return registro!;
}

/**
 * O dado lido é de OUTRA pessoa? `servidor_id` nulo devolve false (não há
 * "sobre quem"); conta sem `servidor_id` lê sempre como terceiro.
 */
export function leitura_de_terceiro(usuario: UsuarioAtual, servidor_id: number | null | undefined): boolean {
  if (servidor_id === null || servidor_id === undefined) return false;
  return usuario.servidor_id !== servidor_id;
}

/**
 * Registra a leitura NOMINAL de terceiro. Decide e grava numa chamada só. O
 * titular lendo o próprio dado não entra (LGPD art. 18, II). Devolve null
 * quando não gravou.
 */
export async function registrar_leitura_nominal(
  tx: Executor,
  usuario: UsuarioAtual,
  campo: string,
  opcoes: {
    servidor_id: number | null | undefined;
    processo_id?: number | null;
    acidente_id?: number | null;
    acidentado_id?: number | null;
    finalidade?: string | null;
  },
): Promise<AcessoDadoSensivel | null> {
  // O acidentado que não é servidor não tem `servidor_id`, e "não há sobre quem"
  // não vale para ele: o dado é de uma pessoa, identificada por `acidentado_id`
  // (ou, no mínimo, pela ocorrência). Ler sempre é leitura de terceiro.
  const sem_servidor_com_acidente =
    (opcoes.servidor_id === null || opcoes.servidor_id === undefined) &&
    ((opcoes.acidente_id ?? null) !== null || (opcoes.acidentado_id ?? null) !== null);
  if (!sem_servidor_com_acidente && !leitura_de_terceiro(usuario, opcoes.servidor_id)) return null;
  return registrar_acesso_sensivel(tx, usuario, campo, {
    servidor_id: opcoes.servidor_id ?? null,
    processo_id: opcoes.processo_id ?? null,
    acidente_id: opcoes.acidente_id ?? null,
    acidentado_id: opcoes.acidentado_id ?? null,
    finalidade: opcoes.finalidade ?? null,
  });
}
