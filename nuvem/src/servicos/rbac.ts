/**
 * RBAC — perfis, permissões e escopo (§6 do prompt). Porte de `app/servicos/rbac.py`.
 *
 * Checagem em três camadas: middleware de rota, service layer antes de qualquer
 * escrita, e filtro de escopo no repositório. Negado por padrão. Nunca confie em
 * esconder botão.
 */
import { eq, inArray, or, sql, getTableName, type SQL } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import type { Executor } from "../db/cliente.js";
import {
  atribuicao,
  processo,
  profissional_habilitado,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { vigente_em } from "../dominio/organizacao.js";
import { hoje_iso } from "../dominio/datas.js";
import { PermissaoNegada } from "../nucleo/erros.js";
import {
  MODULOS_NIVELADOS,
  NUNCA_POR_NIVEL,
  PERFIS_NO_NIVEL_MAIS_ALTO,
  PERMISSAO_DA_BASE,
  PERMISSOES_SO_DO_PERFIL,
  concessao_da_a_base,
  modulo_de_permissao,
  niveis_de,
  permissoes_com_niveis,
  permissoes_do_modulo,
} from "./niveis_modulo.js";

export { PERMISSAO_DA_BASE } from "./niveis_modulo.js";

// A mesma classe que `src/app.ts` trata no `onError`: uma só, reexportada daqui
// para que `import { PermissaoNegada } from "servicos/rbac"` continue valendo
// como no Python.
export { PermissaoNegada };

export interface DadosPerfil {
  nome: string;
  base_normativa?: string;
  permissoes: string[];
}

export const PERMISSOES: Record<string, string> = {
  "processo.ver": "Ver processos",
  "processo.criar": "Criar processo",
  "processo.editar": "Editar processo",
  "processo.status": "Mudar estado / mover no kanban",
  "processo.atribuir": "Atribuir responsavel",
  "parecer.ver": "Ver pareceres",
  "parecer.criar": "Criar parecer",
  "parecer.editar": "Editar parecer",
  "parecer.emitir": "Emitir parecer (consome numero)",
  "parecer.assinar": "Assinar parecer",
  "parecer.anular": "Anular parecer",
  "laudo.ver": "Ver laudos",
  "laudo.criar": "Criar laudo tecnico",
  "catalogo.gerenciar": "Gerenciar catalogos",
  "usuario.criar_conta": "Criar conta de usuario",
  "usuario.resetar_senha": "Resetar senha de usuario",
  "perfil.conceder": "Conceder perfil / atribuicao",
  "habilitacao.atestar": "Atestar habilitacao tecnica",
  "exposicao.ver": "Ver dados de exposicao e identificacao nominal",
  "anexo.enviar": "Enviar anexo",
  exportar: "Exportar dados",
  "auditoria.ver": "Ver trilha de auditoria",
  "indicador.ver": "Ver indicadores",
  "backup.executar": "Executar backup",
  // --- Certificados e Treinamentos (fatia 1) ---
  "treinamento.ver": "Ver treinamentos, turmas e certificados",
  "treinamento.gerenciar": "Gerenciar catalogo de treinamento e modelo de certificado",
  "assinatura.gerenciar": "Cadastrar assinatura de instrutor",
  // --- Certificados e Treinamentos (fatia 2) ---
  // So as tres que a fatia usa. As demais do SS8 do desenho (`turma.avaliar`,
  // `certificado.*`, `participante.mesclar`, `vencimento.ver`) entram com a
  // fatia que as exige: `semear_rbac` NUNCA remove permissao de perfil, entao
  // semear cedo e conceder acesso que so sai por SQL manual.
  "turma.criar": "Criar e editar turma",
  "turma.inscrever": "Inscrever e confirmar participante",
  "turma.concluir": "Concluir ou cancelar turma",
  // --- Certificados e Treinamentos (fatia do servidor comum) ---
  // `turma.inscrever_se` e separada de `turma.inscrever` pela MESMA razao que
  // `epi.requisitar` e separada de `epi.analisar`: pedir nao e deferir. E a
  // diferenca nao e de grau, e de objeto — `turma.inscrever` inscreve QUALQUER
  // PESSOA em qualquer turma (e confirma a inscricao dos outros), e conceder
  // isso a um servidor para que ele se inscreva a si mesmo lhe entregaria a
  // lista inteira de participantes e o poder de por gente em turma. A tela de
  // 403 mandava exatamente esse pedido a quem nao pode recebe-lo.
  //
  // A permissao NAO carrega nenhum "quem": a rota que ela guarda nao aceita
  // participante, servidor nem inscricao como parametro, e o titular sai de
  // `usuario.servidor_id`. E essa a propriedade de seguranca que sustenta a
  // fatia, e ela mora na assinatura da rota — nao numa comparacao dentro do
  // servico que a proxima refatoracao pode perder.
  "turma.inscrever_se": "Inscrever-se em turma aberta (so a si mesmo)",
  // --- Certificados e Treinamentos (fatia 3) ---
  // Retificar presenca ou nota de turma JA CONCLUIDA nao entra aqui: pede
  // `turma.concluir`, pela mesma simetria do parecer (o tecnico emite e nao
  // anula). Desfazer um resultado que ja foi comunicado e decisao de quem
  // responde pela turma.
  "turma.avaliar": "Lancar presenca e nota",
  // --- Certificados e Treinamentos (fatia 4) ---
  // `vencimento.ver` (fatia 7) continua fora pela mesma razao de sempre:
  // semear cedo e conceder acesso que so sai por SQL manual.
  // `participante.mesclar` entrou em 20/10/2026, com a tela (abaixo).
  "certificado.emitir": "Emitir certificado (consome numero)",
  "certificado.anular": "Anular certificado emitido",
  "certificado.ver": "Ver certificado nominal e dados do participante",
  // NUVEM (20/10/2026): a fatia da mesclagem chegou. Juntar dois cadastros
  // move inscrições e certificados de uma pessoa para outra: é decisão de
  // quem responde pelo certificado, e por isso mora com `certificado.anular`.
  "participante.mesclar": "Juntar cadastros duplicados do mesmo participante",
  // --- Gestao de EPI (fatia 1) ---
  // So as que protegem tela em cada fatia. As duas que faltavam do SS8 do
  // desenho (`epi.requisitar` e `epi.analisar`) entraram na fatia 4, que e a
  // que as exige — pela mesma razao de sempre: `semear_rbac` NUNCA remove
  // permissao de perfil, entao semear cedo e conceder acesso que so sai por
  // SQL manual.
  //
  // `epi.catalogo` e separada de `catalogo.gerenciar` de proposito: quem mantem
  // o catalogo de EPI e o tecnico de seguranca ou o almoxarife, e
  // `catalogo.gerenciar` da acesso a fundamentacao legal, percentual e texto
  // padrao do parecer. Reaproveitar a permissao entregaria o parecer a quem so
  // precisa cadastrar bota.
  "epi.ver": "Ver catalogo, estoque e requisicoes de EPI",
  "epi.catalogo": "Gerenciar o catalogo de EPI: item, CA, quantidade e motivo de recusa",
  // --- Gestao de EPI (fatia 2) ---
  // `epi.ficha` e separada de `epi.ver` porque as duas telas dizem coisas de
  // natureza diferente. O catalogo e a lista do que o setor fornece — nao
  // nomeia ninguem. A ficha e historico nominal sobre a seguranca de uma
  // pessoa determinada, na mesma classe de `exposicao.ver`: ler a de outro
  // registra em `acesso_dado_sensivel`, e ler a propria nao precisa dela
  // porque `ESCOPO_PROPRIO` ja resolve.
  "epi.entregar": "Registrar entrega e emitir a ficha de EPI",
  "epi.ficha": "Ver a ficha de EPI nominal de qualquer servidor",
  // --- Gestao de EPI (fatia 3) ---
  // Escrever no estoque e ato de quem CONTA a prateleira: dar entrada no lote,
  // ajustar o saldo contra a contagem fisica e descartar o que nao pode mais
  // sair. Separada de `epi.entregar` porque as duas respondem por coisas
  // diferentes — a entrega responde perante o servidor que assinou o
  // comprovante, o estoque responde perante o empenho. Ler o estoque continua
  // em `epi.ver`: saldo de bota nao nomeia ninguem.
  "epi.estoque": "Registrar entrada, ajuste e descarte de estoque de EPI",
  // --- Gestao de EPI (fatia 4) ---
  // As duas sao separadas porque a RN-28 exige que sejam DUAS PESSOAS: quem
  // analisa nao e quem requisita. Uma permissao unica de "operar requisicao"
  // tornaria a regra indefensavel na tela — todo mundo que pede poderia
  // decidir, e o bloqueio viraria uma checagem de igualdade solitaria dentro
  // de um servico, sem nada no RBAC que a sustentasse.
  //
  // `epi.requisitar` e larga de propósito: pedir EPI e ato do proprio servidor,
  // da chefia dele ou da secretaria, e negar isso empurraria o pedido para o
  // e-mail — que e onde ele esta hoje e onde nao ha protocolo, prazo nem
  // trilha. `epi.analisar` e estreita pelo motivo oposto: decidir e ato tecnico
  // de quem responde pelo risco do posto.
  "epi.requisitar": "Abrir e enviar requisicao de EPI",
  "epi.analisar": "Analisar requisicao de EPI: aprovar, recusar e indeferir",
  // --- Demandas (base compartilhada) ---
  // Duas, e a divisao segue a mesma logica de todo o resto: uma para LER a
  // fila do setor e outra para ESCREVER nela.
  //
  // `demanda.ver` e larga de propósito, e a decisao e do dono do sistema:
  // "demanda que so uma pessoa ve some quando ela entra de ferias". A fila e
  // do SETOR, e todo mundo que opera algum modulo aqui dentro a enxerga. O que
  // a permissao NAO faz e afrouxar a RN-19: o nome de quem demanda continua
  // saindo por `identificar(...)`, e quem nao tem `exposicao.ver` le o codigo
  // opaco, como em toda outra tela.
  //
  // `demanda.registrar` cobre os tres atos de escrita — registrar, encaminhar
  // e encerrar. Nao ha razao para separa-los: quem anota o pedido no balcao e
  // a mesma pessoa que o encaminha e que escreve como ele terminou, e uma
  // permissao a mais so criaria a chance de alguem receber metade dela e
  // descobrir isso no meio do atendimento.
  "demanda.ver": "Ver as demandas do setor",
  "demanda.registrar": "Registrar demanda, encaminhamento e encerramento",
  // --- Turmas por setor promotor (22/10/2026) ---
  // A equipe de cada setor ve e gere so as turmas do proprio setor promotor
  // (`equipe_setor_promotor`); quem tem esta ve todas — a coordenacao da Sisa
  // e quem le o modulo inteiro por ofício (auditoria, PROGEP). Nao se libera
  // por modulo (`niveis_modulo.PERMISSOES_SO_DO_PERFIL`).
  "turma.todos_os_setores": "Alcançar as turmas de todos os setores promotores (gerir exige as permissões de turma)",
  // --- Acidentes (CAT/SP, 23/10/2026) ---
  // Nove permissões, e a divisão segue quem faz o quê: `ver` e `comunicar` são
  // largas (todo servidor com conta comunica e vê a própria ocorrência); triar,
  // investigar e encaminhar ao SIASS são da equipe; emitir o relatório é ato
  // técnico assinado (segue o cargo, como a assinatura); e a saúde tem três
  // permissões próprias — ver o nível 1, ver o nível 2 e registrar — porque
  // dado de saúde é sensível (LGPD art. 5º, II; ROPA §4.4): quem investiga o
  // acidente NÃO lê, por isso, o detalhe clínico. `acidente.ver` nunca mostra
  // saúde. O auditor interno e a PROGEP não leem o módulo (decisão D10).
  "acidente.ver": "Ver ocorrencias de acidente (a saude nunca vem junto)",
  "acidente.comunicar": "Comunicar acidente de trabalho (CAT/SP) e responder pedido de complementacao",
  "acidente.triar": "Triar ocorrencia: assumir, mudar estado, pedir complementacao, cancelar e retificar a CAT/SP",
  "acidente.investigar": "Investigar acidente: MAPA, checklist, entrevistas, evidencias e plano de acao",
  "acidente.siass": "Encaminhar ao SIASS, registrar a decisao pericial e concluir a ocorrencia",
  "acidente.relatorio_emitir": "Emitir e retificar o relatorio tecnico do acidente",
  "acidente.saude_ver": "Ver a saude do acidentado, nivel 1 (lesao em categoria fechada e fatos administrativos)",
  "acidente.saude_detalhe_ver": "Ver a saude do acidentado, nivel 2 (dias, datas e atendimento)",
  "acidente.saude_registrar": "Registrar e corrigir os dados de saude do acidentado",
};

/**
 * O que cada permissão permite, em português de tela, agrupado como quem
 * concede perfil pensa (M75): a matriz de /perfis é lida por gestor, e
 * "epi.requisitar" não diz nada a quem não escreveu o código.
 *
 * Separado de `PERMISSOES` de propósito: aquele texto é o `descricao` gravado
 * em `permissao` pela semeadura, em ASCII como no Python, e mudá-lo mexeria no
 * banco de todas as instalações. Este é só a tela. Toda chave de `PERMISSOES`
 * está aqui exatamente uma vez — `rbac.test.ts` confere.
 */
export const GRUPOS_PERMISSAO_TELA: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  [
    "Processos e adicional ocupacional",
    {
      "processo.ver": "Ver processos",
      "processo.criar": "Cadastrar processo",
      "processo.editar": "Editar processo e cadastro de servidor",
      "processo.status": "Mudar a etapa do processo (mover no quadro)",
      "processo.atribuir": "Definir o responsável pelo processo",
      "anexo.enviar": "Enviar anexo",
      "exposicao.ver": "Ver nome, SIAPE e dados de exposição dos servidores",
    },
  ],
  [
    "Pareceres e laudos",
    {
      "parecer.ver": "Ver pareceres",
      "parecer.criar": "Criar parecer",
      "parecer.editar": "Editar parecer",
      "parecer.emitir": "Emitir parecer (consome número)",
      "parecer.assinar": "Assinar parecer (exige habilitação técnica)",
      "parecer.anular": "Anular parecer",
      "laudo.ver": "Ver laudos",
      "laudo.criar": "Registrar laudo técnico (exige habilitação técnica)",
    },
  ],
  [
    "Treinamentos e certificados",
    {
      "treinamento.ver": "Ver treinamentos, turmas e certificados",
      "treinamento.gerenciar": "Gerenciar o catálogo de treinamentos e o modelo de certificado",
      "assinatura.gerenciar": "Cadastrar a assinatura de instrutor",
      "turma.criar": "Criar e editar turma",
      "turma.inscrever": "Inscrever e confirmar participantes",
      "turma.inscrever_se": "Inscrever-se em turma aberta (só a si mesmo)",
      "turma.concluir": "Concluir ou cancelar turma",
      "turma.avaliar": "Lançar presença e nota",
      "certificado.emitir": "Emitir certificado (consome número)",
      "certificado.anular": "Anular certificado emitido",
      "certificado.ver": "Ver certificado nominal e dados do participante",
      "participante.mesclar": "Juntar cadastros duplicados do mesmo participante",
      "turma.todos_os_setores": "Alcançar as turmas de todos os setores (gerir exige as permissões de turma)",
    },
  ],
  [
    "Gestão de EPI",
    {
      "epi.ver": "Ver catálogo, estoque e pedidos de EPI",
      "epi.catalogo": "Gerenciar o catálogo de EPI: item, CA, quantidade e motivo de recusa",
      "epi.entregar": "Registrar entrega e emitir a ficha de EPI",
      "epi.ficha": "Ver a ficha de EPI de qualquer servidor",
      "epi.estoque": "Registrar entrada, ajuste e descarte de estoque",
      "epi.requisitar": "Abrir e enviar pedido de EPI",
      "epi.analisar": "Analisar pedido de EPI: aprovar, recusar e indeferir",
    },
  ],
  [
    "Demandas",
    {
      "demanda.ver": "Ver as demandas do setor",
      "demanda.registrar": "Registrar, encaminhar e encerrar demanda",
    },
  ],
  [
    "Acidentes",
    {
      "acidente.ver": "Ver as ocorrências de acidente (sem os dados de saúde)",
      "acidente.comunicar": "Comunicar acidente de trabalho e responder pedido de complementação",
      "acidente.triar": "Triar a ocorrência: assumir, mudar a situação, pedir complementação, cancelar e retificar",
      "acidente.investigar": "Investigar o acidente: análise MAPA, checklist, entrevistas, evidências e plano de ação",
      "acidente.siass": "Encaminhar ao SIASS, registrar a decisão pericial e concluir",
      "acidente.relatorio_emitir": "Emitir e retificar o relatório técnico (exige o cargo técnico)",
      "acidente.saude_ver": "Ver a saúde do acidentado, nível 1 (lesão em categoria e fatos administrativos)",
      "acidente.saude_detalhe_ver": "Ver a saúde do acidentado, nível 2 (dias, datas e atendimento)",
      "acidente.saude_registrar": "Registrar e corrigir os dados de saúde do acidentado",
    },
  ],
  [
    "Catálogos, indicadores e exportação",
    {
      "catalogo.gerenciar": "Gerenciar os catálogos e a configuração do setor",
      "indicador.ver": "Ver indicadores",
      exportar: "Exportar dados",
    },
  ],
  [
    "Contas, auditoria e sistema",
    {
      "usuario.criar_conta": "Criar e inativar conta",
      "usuario.resetar_senha": "Redefinir a senha de conta comum",
      "perfil.conceder": "Conceder e encerrar perfil, vincular conta a servidor",
      "habilitacao.atestar": "Atestar habilitação técnica",
      "auditoria.ver": "Ver a trilha de auditoria",
      "backup.executar": "Fazer backup do sistema",
    },
  ],
];

/**
 * O texto de tela de cada permissão (um dicionário só, achatado de
 * `GRUPOS_PERMISSAO_TELA`): as duas telas de perfil (`/perfis` e
 * `/perfis/niveis`) e o "você não tem" dos templates leem daqui. O AGRUPAMENTO
 * das telas é o dos módulos (`MODULOS_NIVELADOS`), e não o dos grupos acima.
 */
export const TEXTO_PERMISSAO: Readonly<Record<string, string>> = Object.freeze(
  Object.assign({}, ...GRUPOS_PERMISSAO_TELA.map(([, textos]) => textos)) as Record<string, string>,
);

/** A lista do coordenador — o superintendente parte dela (ver abaixo). */
const PERMISSOES_COORDENADOR: string[] = [
  "processo.ver",
  "processo.criar",
  "processo.editar",
  "processo.status",
  "processo.atribuir",
  "parecer.ver",
  "parecer.criar",
  "parecer.editar",
  "parecer.emitir",
  "parecer.assinar",
  "parecer.anular",
  "laudo.ver",
  "laudo.criar",
  "catalogo.gerenciar",
  "anexo.enviar",
  "exposicao.ver",
  "exportar",
  "auditoria.ver",
  "indicador.ver",
  "treinamento.ver",
  "treinamento.gerenciar",
  "assinatura.gerenciar",
  "turma.criar",
  "turma.inscrever",
  "turma.concluir",
  "turma.avaliar",
  "certificado.emitir",
  "certificado.anular",
  "certificado.ver",
  "participante.mesclar",
  "epi.ver",
  "epi.catalogo",
  "epi.entregar",
  "epi.ficha",
  "epi.estoque",
  "epi.requisitar",
  "epi.analisar",
  "demanda.ver",
  "demanda.registrar",
  // a coordenacao ve as turmas de todos os setores promotores (22/10/2026)
  "turma.todos_os_setores",
  // acidentes (23/10/2026): a coordenacao tem as nove, saude inclusive; o
  // superintendente parte desta lista e o Administrador do sistema as deriva
  "acidente.ver",
  "acidente.comunicar",
  "acidente.triar",
  "acidente.investigar",
  "acidente.siass",
  "acidente.relatorio_emitir",
  "acidente.saude_ver",
  "acidente.saude_detalhe_ver",
  "acidente.saude_registrar",
];

/**
 * Ato tecnico da IN 15/2022, art. 10, §2º, I: so com perfil tecnico E
 * habilitacao vigente (`pode_subscrever`). Nao entra em perfil de gestao.
 */
export const SO_DO_TECNICO_HABILITADO: ReadonlySet<string> = new Set(["parecer.assinar", "laudo.criar"]);

/**
 * O perfil acima de todos (23/10/2026, pedido do dono do sistema): o
 * Administrador do sistema tem TODA permissão de todo módulo e de todo setor,
 * em escopo total, menos o ato técnico que a IN 15/2022 reserva a quem tem
 * habilitação (`SO_DO_TECNICO_HABILITADO`: assinar parecer, registrar laudo).
 * Para isso ele precisa, como qualquer um, de perfil técnico E habilitação.
 *
 * Só quem tem este perfil o concede (nem o superintendente, nem a si mesmo), e
 * a conta que o tem só é alterada, redefinida, inativada ou tem o perfil
 * encerrado por outro Administrador do sistema (`rotas/usuarios.ts`). A
 * primeira concessão é pela linha de comando (`ferramentas/conceder-administrador.ts`).
 *
 * Na hierarquia de dono (de turmas e treinamentos), é o TOPO, acima do
 * superintendente: `TOPO_DA_HIERARQUIA`, abaixo.
 */
export const PERFIL_ADMINISTRADOR_SISTEMA = "administrador_sistema";

/**
 * O topo da hierarquia de perfis — "Administrador do sistema > Superintendente
 * > Coordenador > demais". A regra de dono de turma/treinamento (branch
 * feat/sisa-dono-treinamento) deve pôr este código ACIMA do superintendente
 * ao juntar (ver DESVIOS.md).
 */
export const TOPO_DA_HIERARQUIA: readonly string[] = Object.freeze([PERFIL_ADMINISTRADOR_SISTEMA, "superintendente"]);

/**
 * As permissões do Administrador do sistema: DERIVADAS, nunca copiadas à mão —
 * toda chave de `PERMISSOES` (o que inclui a união de todos os perfis da
 * matriz) menos as do ato técnico. Permissão nova que entra em `PERMISSOES`
 * entra aqui sozinha, e `semear_rbac` a acrescenta ao perfil já gravado no
 * próximo deploy. `perfil_admin_sistema.test.ts` confere.
 */
export function permissoes_do_administrador_sistema(): string[] {
  return Object.keys(PERMISSOES).filter((p) => !SO_DO_TECNICO_HABILITADO.has(p));
}

export const MATRIZ_PERFIS: Record<string, DadosPerfil> = {
  admin_ti: {
    nome: "Administrador de TI",
    base_normativa:
      "Governa a conta e não lê o trabalho do setor: cria conta, redefine senha, vê a trilha de auditoria e faz backup. " +
      "Nenhum dado de processo, certificado, EPI ou indicador.",
    permissoes: [
      "usuario.criar_conta",
      "usuario.resetar_senha",
      "auditoria.ver",
      "backup.executar",
      // `indicador.ver` saiu em 22/10/2026, por decisão do usuário: o número
      // de turmas, entregas e recusas é conteúdo do trabalho do setor, e não
      // da governança da conta. Como `semear_rbac` nunca tira permissão de
      // perfil por omissão, a retirada do banco já gravado está declarada em
      // `PERMISSOES_RETIRADAS`, logo abaixo.
    ],
  },
  superintendente: {
    nome: "Superintendente da Sisa",
    base_normativa:
      "Resolução Consu UFVJM 11/2026, art. 11, IX. Opera como a coordenação e, com o Administrador do sistema, " +
      "é quem concede perfil e ajusta o acesso por módulo.",
    // Operacional (19/10/2026). Era "ve tudo e opera nada": no banco recem
    // implantado a unica conta e a do superintendente, e ela nao criava conta,
    // servidor, catalogo, turma, demanda nem processo — o sistema nascia
    // travado ate alguem conceder a si mesmo outro perfil. Agora e a do
    // coordenador mais a governanca da conta (criar, redefinir senha, backup).
    // O que fica DE FORA e o ato tecnico que a IN 15/2022 reserva a quem tem
    // habilitacao: assinar parecer e registrar laudo (`SO_DO_TECNICO_HABILITADO`).
    // `semear_rbac` acrescenta o que falta ao perfil ja gravado no proximo deploy.
    permissoes: [
      ...PERMISSOES_COORDENADOR.filter((p) => !SO_DO_TECNICO_HABILITADO.has(p)),
      "perfil.conceder",
      "habilitacao.atestar",
      "usuario.criar_conta",
      "usuario.resetar_senha",
      "backup.executar",
    ],
  },
  coordenador_csso: {
    nome: "Coordenador da CSSO",
    base_normativa: "Resolução Consu UFVJM 11/2026, art. 20, VII",
    permissoes: PERMISSOES_COORDENADOR,
  },
  engenheiro_seguranca: {
    nome: "Engenheiro de Segurança do Trabalho",
    base_normativa: "IN SGP/SEDGG/ME 15/2022, art. 10, §2º, I",
    permissoes: [
      "processo.ver",
      "processo.criar",
      "processo.editar",
      "processo.status",
      "processo.atribuir",
      "parecer.ver",
      "parecer.criar",
      "parecer.editar",
      "parecer.emitir",
      "parecer.assinar",
      "parecer.anular",
      "laudo.ver",
      "laudo.criar",
      "anexo.enviar",
      "exposicao.ver",
      "exportar",
      "indicador.ver",
      "treinamento.ver",
      "treinamento.gerenciar",
      "assinatura.gerenciar",
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
      "turma.avaliar",
      "certificado.emitir",
      "certificado.anular",
      "participante.mesclar",
      "certificado.ver",
      // le a ficha (o EPI recebido sustenta ou derruba a alegacao de
      // neutralizacao no parecer) e nao entrega: quem opera o balcao do
      // almoxarifado e outra pessoa (SS8 do desenho)
      "epi.ver",
      "epi.catalogo",
      "epi.ficha",
      // decide o pedido (e o risco do posto que fundamenta a decisao e o
      // que ele apura no laudo), e nao opera o balcao
      "epi.requisitar",
      "epi.analisar",
      // e ele quem recebe a maior parte das demandas — a funcionalidade
      // nasceu de uma frase dele: "chegam por e-mail ou presencialmente,
      // e eu preciso nao perder" +
      "demanda.ver",
      "demanda.registrar",
      // acidentes (D10, 23/10/2026): conduz a triagem, investiga, encaminha ao
      // SIASS, emite o relatorio tecnico (ato dele, e nao so do engenheiro) e le
      // a saude no nivel 1. O detalhe clinico (nivel 2) e do medico.
      "acidente.ver",
      "acidente.comunicar",
      "acidente.triar",
      "acidente.investigar",
      "acidente.siass",
      "acidente.relatorio_emitir",
      "acidente.saude_ver",
    ],
  },
  medico_trabalho: {
    nome: "Médico do Trabalho",
    base_normativa: "IN SGP/SEDGG/ME 15/2022, art. 10, §2º, I",
    permissoes: [
      "processo.ver",
      "processo.criar",
      "processo.editar",
      "processo.status",
      "processo.atribuir",
      "parecer.ver",
      "parecer.criar",
      "parecer.editar",
      "parecer.emitir",
      "parecer.assinar",
      "parecer.anular",
      "laudo.ver",
      "laudo.criar",
      "anexo.enviar",
      "exposicao.ver",
      "exportar",
      "indicador.ver",
      // ministra NR-32 e primeiros socorros (SS8 do desenho)
      "treinamento.ver",
      "treinamento.gerenciar",
      "assinatura.gerenciar",
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
      "turma.avaliar",
      "certificado.emitir",
      "certificado.anular",
      "participante.mesclar",
      "certificado.ver",
      // ve o catalogo de EPI (indica EPI no exame ocupacional) e nao o
      // edita: cadastrar CA e quantidade e ato do tecnico de seguranca e
      // de quem opera o almoxarifado (SS8 do desenho)
      "epi.ver",
      "epi.ficha",
      // indica EPI no exame ocupacional, e decidir o pedido que decorre
      // dessa indicacao e o mesmo ato
      "epi.requisitar",
      "epi.analisar",
      "demanda.ver",
      "demanda.registrar",
      // acidentes (D10, 23/10/2026): confirma e registra a saude (os dois niveis),
      // encaminha ao SIASS e instrui a pericia; nao tria nem investiga o
      // acidente, que e trabalho da engenharia e da seguranca
      "acidente.ver",
      "acidente.comunicar",
      "acidente.siass",
      "acidente.saude_ver",
      "acidente.saude_detalhe_ver",
      "acidente.saude_registrar",
    ],
  },
  tecnico_seguranca: {
    nome: "Técnico de Segurança do Trabalho",
    base_normativa:
      "Avalia ambiente, mede, instrui e monta rascunho. NAO subscreve laudo " +
      "nem assina parecer (IN 15/2022, art. 10, §2º, I).",
    permissoes: [
      "processo.ver",
      "processo.criar",
      "processo.editar",
      "processo.status",
      "parecer.ver",
      "parecer.criar",
      "parecer.editar",
      "parecer.emitir",
      "laudo.ver",
      "anexo.enviar",
      "exposicao.ver",
      "exportar",
      "indicador.ver",
      // ministra treinamento: cadastra o catalogo e a propria rubrica.
      // Anular certificado e mesclar participante ficam fora (§8) — mesma
      // simetria do parecer, em que ele emite e nao assina: consumir
      // numero e operacao tecnica, desfazer documento que circulou e
      // decisao de coordenacao.
      "treinamento.ver",
      "treinamento.gerenciar",
      "assinatura.gerenciar",
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
      "turma.avaliar",
      "certificado.emitir",
      "certificado.ver",
      // e ele quem mantem o catalogo de EPI na pratica, e e ele quem
      // entrega e conta a prateleira quando nao ha almoxarife dedicado
      // (SS8 do desenho)
      "epi.ver",
      "epi.catalogo",
      "epi.entregar",
      "epi.ficha",
      "epi.estoque",
      "epi.requisitar",
      "epi.analisar",
      "demanda.ver",
      "demanda.registrar",
      // acidentes (D10, 23/10/2026): conduz a triagem, investiga, encaminha ao
      // SIASS, emite o relatorio tecnico (ato dele, e nao so do engenheiro) e le
      // a saude no nivel 1. O detalhe clinico (nivel 2) e do medico.
      "acidente.ver",
      "acidente.comunicar",
      "acidente.triar",
      "acidente.investigar",
      "acidente.siass",
      "acidente.relatorio_emitir",
      "acidente.saude_ver",
    ],
  },
  almoxarife_sesmt: {
    nome: "Almoxarife do SESMT",
    base_normativa:
      "Opera o estoque e a entrega do EPI. Não decide o direito ao item, não lê parecer e não vê exposição, " +
      "nem por liberação de módulo.",
    // O perfil nasce na fatia 3, e nao antes, porque o nucleo dele e
    // `epi.estoque` — que so passou a existir agora. `semear_rbac` nunca
    // REMOVE permissao de perfil: um perfil semeado pela metade concede
    // acesso que so sai por SQL manual, e a metade que faltava seria
    // justamente a razao de ele existir.
    //
    // `epi.ficha` esta aqui e o §8 do desenho a marcava com "—". A matriz
    // de la nao fecha com o fluxo que ela mesma descreve: quem entrega e
    // quem GRAVA a linha da ficha, e a decisao 8 poe na conta dele o passo
    // seguinte — imprimir o comprovante, colher a assinatura e anexar o
    // digitalizado, que sao acoes da tela da ficha. Sem `epi.ficha` o
    // sistema abriria para ele a pendencia `COMPROVANTE_EPI_PENDENTE`,
    // com o nome dele em `responsavel_id`, e devolveria 403 no link dela.
    // Tarefa com dono que o dono nao consegue abrir e o modo de falha que
    // `PERMISSOES_VER` e `test_link_no_menu_sempre_abre` existem para
    // impedir. Ler a ficha de outro continua caindo em
    // `acesso_dado_sensivel`, como para todo mundo (RN-23).
    //
    // O que ele continua NAO tendo e o que a base normativa do perfil diz:
    // nada de parecer, laudo, exposicao, processo nem catalogo de EPI.
    //
    // `demanda.*` entra apesar da base normativa estreita, e o argumento e o
    // canal PRESENCIAL: quem esta no balcao do almoxarifado e quem recebe o
    // pedido que chega andando, e mandar essa pessoa "avisar alguem da CSSO"
    // e exatamente o caminho por onde a demanda se perde hoje. Ele registra
    // e ve a fila; o que ele continua nao tendo e todo o resto.
    //
    // Acidentes (D10, 23/10/2026): quem presencia um acidente no almoxarifado
    // comunica, como qualquer servidor — e isso ja vem das funcoes do titular
    // (`PERMISSOES_DO_TITULAR`), sem estar na matriz do perfil. Na matriz,
    // `acidente.comunicar` sozinho (sem `acidente.ver`) faria o modulo do perfil
    // ler como "Parcial" (a harmonia da matriz, `matriz_harmonia.test`) e daria
    // ao almoxarife o modulo de acidentes na lateral, que ele nao opera.
    permissoes: ["epi.ver", "epi.estoque", "epi.entregar", "epi.ficha", "demanda.ver", "demanda.registrar"],
  },
  secretaria_csso: {
    nome: "Secretaria da CSSO",
    base_normativa:
      "Sem acesso à exposição (dado mascarado). Decidir é ato técnico: não analisa pedido de EPI, não cria nem emite " +
      "parecer e não anula certificado, nem por liberação de módulo.",
    permissoes: [
      "processo.ver",
      "processo.criar",
      "processo.editar",
      "processo.status",
      "parecer.ver",
      "laudo.ver",
      "anexo.enviar",
      "indicador.ver",
      // ve o catalogo porque opera a inscricao e a emissao (fatias 2 e 4);
      // nao edita o catalogo nem cadastra rubrica de instrutor
      "treinamento.ver",
      // e a secretaria que monta a turma e recebe o inscrito: negar aqui
      // obrigaria o engenheiro a digitar lista de presenca (SS8)
      "turma.criar",
      "turma.inscrever",
      "turma.concluir",
      "turma.avaliar",
      // `certificado.ver` apesar de ela NAO ter `exposicao.ver`: exposicao
      // a agente nocivo e dado de saude (RN-19), presenca em curso de
      // NR-35 nao e. Negar aqui seria imitar a restricao sem entender de
      // onde ela veio — e quem opera a emissao precisa ver para quem esta
      // emitindo. Anular continua fora.
      "certificado.emitir",
      "certificado.ver",
      // abre e envia requisicao pelo servidor (§8): quem pede EPI muitas
      // vezes nao opera o sistema, e negar aqui empurraria o pedido para o
      // e-mail — que e onde ele esta hoje, sem protocolo, prazo nem trilha.
      // `epi.analisar` fica de fora: decidir e ato tecnico.
      "epi.ver",
      "epi.requisitar",
      // e a secretaria que atende o telefone e abre a caixa de entrada do
      // setor: negar aqui deixaria a demanda no e-mail, que e onde ela
      // esta hoje
      "demanda.ver",
      "demanda.registrar",
      // acidentes (D10, 23/10/2026): a secretaria recebe e TRIA a comunicacao,
      // sem ver saude; investigar e encaminhar ao SIASS nao sao dela
      "acidente.ver",
      "acidente.comunicar",
      "acidente.triar",
    ],
  },
  consulta_progep: {
    nome: "Consulta PROGEP",
    base_normativa:
      "Consulta de processo, parecer, laudo, exposição, certificado e ficha de EPI; vê indicadores e exporta. " +
      "Não escreve em módulo nenhum: no máximo Consulta, nem por liberação de módulo.",
    permissoes: [
      "processo.ver",
      "parecer.ver",
      "laudo.ver",
      "exposicao.ver",
      "exportar",
      "indicador.ver",
      // e a PROGEP que age sobre a lotacao de quem esta irregular
      "treinamento.ver",
      "certificado.ver",
      // le o certificado de qualquer setor: e a PROGEP que age sobre a lotacao
      "turma.todos_os_setores",
      // a ficha de EPI e um dos documentos que a PROGEP e a procuradoria
      // pedem primeiro (SS12.8 do desenho); ler a de outro fica em
      // `acesso_dado_sensivel`
      "epi.ver",
      "epi.ficha",
    ],
  },
  servidor_consulta: {
    nome: "Servidor (os próprios dados)",
    base_normativa: "LGPD art. 18, II - acesso do titular.",
    // `epi.ver` abre o catalogo, que nao e nominal: e a lista do que o setor
    // fornece. `epi.ficha` fica DE FORA de proposito: ela e a permissao de
    // ler a ficha DOS OUTROS. A propria ficha o servidor le sem ela, porque
    // `ESCOPO_PROPRIO` filtra por `servidor_id` — e `epi_ficha_registro` tem
    // essa coluna, que e exatamente a que `aplicar_escopo` procura.
    // `epi.requisitar` entra na fatia 4: pedir o proprio EPI e o caso de uso
    // central do modulo, e `ESCOPO_PROPRIO` limita o que ele ve — a
    // requisicao tem `servidor_id`, que e a coluna que `aplicar_escopo`
    // procura. Analisar continua fora, e a RN-28 fecha a porta de todo modo.
    //
    // "Limita" e verbo no presente desde a 1.34.0, e nao era: ate ali este
    // comentario descrevia uma protecao que nao existia — `aplicar_escopo`
    // nao era chamado uma unica vez em `app/rotas/epi_*.py`, e a fila
    // entregava os pedidos de todo mundo. A porta e `epi_requisicao.fila` /
    // `epi_requisicao.no_escopo`, e `testes/unitarios/test_repositorios.py`
    // varre as rotas de leitura para que a frase nao volte a envelhecer
    // sozinha.
    //
    // `certificado.ver` fica DE FORA pelo mesmo motivo de `epi.ficha`, e
    // agora com a mesma compensacao construida. A descricao da permissao em
    // `PERMISSOES` diz o que ela e: "certificado nominal e dados do
    // participante" — ou seja, a permissao de ler o de OUTRO. Concede-la aqui
    // seria uma linha e resolveria a tela; o preco seria mudar o que a
    // permissao significa para sempre, porque `semear_rbac` nunca remove
    // permissao de perfil e toda rota futura guardada por `certificado.ver`
    // passaria a abrir para milhares de contas, dependendo de ela lembrar do
    // escopo. E essa dependencia — "abre porque a rota lembrou de filtrar" —
    // e exatamente a folga que a 1.35.0 fechou.
    //
    // O titular alcanca o que e dele por `treinamento.ver`, que ele ja tem:
    // `emissao_certificado.exigir_leitura_do_certificado` decide pela relacao
    // titular/terceiro, como `epi_ficha.exigir_leitura_da_ficha` faz desde a
    // fatia 2, e `/certificados/meus` prende a lista ao `servidor_id` da
    // conta. Ler o proprio nao gera `acesso_dado_sensivel`; ler o de outro
    // continua exigindo a permissao e continua sendo registrado.
    //
    // `turma.inscrever_se` entra pelo mesmo raciocinio de `epi.requisitar`, e
    // e a outra metade do motivo de este perfil existir: ele entra no sistema
    // para pedir EPI e para se inscrever em treinamento, e ate aqui a segunda
    // coisa nao tinha caminho nenhum. `turma.inscrever` continua DE FORA, e
    // nao por cautela — ela e a permissao de inscrever QUALQUER PESSOA e de
    // confirmar a inscricao dos outros. A tela de 403 mandava pedi-la, que e
    // o unico conselho que ninguem podia seguir.
    //
    // Desde 22/10/2026 (D16) estas mesmas permissoes vem tambem com o vinculo
    // a servidor, em escopo proprio, para qualquer conta
    // (`PERMISSOES_DO_TITULAR`): ninguem precisa mais somar este perfil a um
    // de equipe para se inscrever ou pedir EPI. Ele continua existindo para a
    // conta que so tem isso.
    permissoes: [
      "processo.ver",
      "parecer.ver",
      "treinamento.ver",
      "turma.inscrever_se",
      "epi.ver",
      "epi.requisitar",
      // acidentes (D10): comunica e ve as proprias ocorrencias (escopo proprio)
      "acidente.comunicar",
      "acidente.ver",
    ],
  },
  auditor_interno: {
    nome: "Auditor interno",
    base_normativa:
      "Leitura ampla, escrita nenhuma: no máximo Consulta em cada módulo, nem por liberação de módulo.",
    permissoes: [
      "processo.ver",
      "parecer.ver",
      "laudo.ver",
      "exposicao.ver",
      "exportar",
      "auditoria.ver",
      "indicador.ver",
      "treinamento.ver",
      "certificado.ver",
      "turma.todos_os_setores",
      "epi.ver",
      "epi.ficha",
      // leitura ampla, escrita nenhuma: e a fila que mostra o trabalho que
      // o setor faz FORA do SEI, e e justamente esse o trabalho que uma
      // auditoria por processo nao enxerga
      "demanda.ver",
    ],
  },
  // por último de propósito: perfil novo entra no fim da semeadura, e os ids
  // dos perfis já gravados (e os testes que pegam "o primeiro perfil") não mudam
  [PERFIL_ADMINISTRADOR_SISTEMA]: {
    nome: "Administrador do sistema",
    base_normativa:
      "Todas as permissões de todos os módulos e setores, em escopo total, menos assinar parecer e " +
      "registrar laudo (IN SGP/SEDGG/ME 15/2022, art. 10, §2º, I). Só outro Administrador do sistema o concede. " +
      "Não se ajusta por módulo: está sempre em Operação.",
    permissoes: permissoes_do_administrador_sistema(),
  },
};

/**
 * A permissão que SAIU de um perfil e tem de sair também do banco já gravado.
 *
 * `semear_rbac` continua sem tirar nada por omissão: uma linha apagada da
 * matriz por engano não pode encolher em silêncio o acesso de quem trabalha, e
 * uma linha a mais no banco (posta à mão) não é dele desfazer. A retirada é
 * uma decisão, e por isso é declarada aqui, com a data e o motivo, e cada uma
 * vira um `PERMISSAO_RETIRADA_DO_PERFIL` na trilha. Fica na lista para sempre:
 * o banco restaurado de um backup antigo volta a ter a permissão, e o próximo
 * semeio a tira de novo. O perfil e a permissão retirada não podem estar na
 * matriz ao mesmo tempo (`_conferir_retiradas`).
 */
export interface PermissaoRetirada {
  perfil: string;
  permissao: string;
  desde: string;
  motivo: string;
}

export const PERMISSOES_RETIRADAS: readonly PermissaoRetirada[] = [
  {
    perfil: "admin_ti",
    permissao: "indicador.ver",
    desde: "22/10/2026",
    motivo:
      "o administrador de TI governa a conta e não lê o trabalho do setor; os indicadores " +
      "de processos, certificados e EPI deixam de ser dele",
  },
];

export function _conferir_retiradas(): void {
  const problemas = PERMISSOES_RETIRADAS.filter(
    (r) => !MATRIZ_PERFIS[r.perfil] || MATRIZ_PERFIS[r.perfil]!.permissoes.includes(r.permissao) || !PERMISSOES[r.permissao],
  ).map((r) => `${r.perfil}/${r.permissao}`);
  if (problemas.length) {
    throw new Error("RBAC mal declarado — retirada de perfil inexistente ou que a matriz ainda concede: " + problemas.join(", "));
  }
}

_conferir_retiradas();

// `permissao.modulo` (D7, 23/10/2026): DERIVADA dos módulos de `niveis_modulo.ts`,
// o mapa permissão → módulo que existe — o código do módulo nivelado
// ("processos-sei", "epis", "certificados", "demandas"), ou "PERFIL" para a
// permissão que não é de módulo nenhum (só do perfil). `semear_rbac` regrava a
// coluna a cada deploy; nada mais a lê hoje.
export const MODULO_SO_DO_PERFIL = "PERFIL";

export function modulo_da_permissao(codigo: string): string {
  return modulo_de_permissao(codigo)?.codigo ?? MODULO_SO_DO_PERFIL;
}

// Escopos: S=sim, E=escopo (coordenadoria+campus), P=próprios, A=agregado
export const ESCOPO_TOTAL = "S";
export const ESCOPO_UNIDADE = "E";
export const ESCOPO_PROPRIO = "P";
export const ESCOPO_AGREGADO = "A";

// Escopo aplicado ao filtro de repositório. TEM de ter uma entrada para cada
// perfil de MATRIZ_PERFIS — `_conferir_escopos()`, logo abaixo, recusa o
// contrário e derruba a importação do módulo.
export const ESCOPO_POR_PERFIL: Record<string, string> = {
  // o mais amplo que existe: todos os registros, de todos os campi
  [PERFIL_ADMINISTRADOR_SISTEMA]: ESCOPO_TOTAL,
  admin_ti: ESCOPO_AGREGADO,
  superintendente: ESCOPO_UNIDADE,
  coordenador_csso: ESCOPO_UNIDADE,
  engenheiro_seguranca: ESCOPO_UNIDADE,
  medico_trabalho: ESCOPO_UNIDADE,
  tecnico_seguranca: ESCOPO_UNIDADE,
  // `E` como o §8 do desenho pede, e não `P`: o estoque é do setor, não de
  // ninguém. Em escopo próprio `aplicar_escopo` procuraria `servidor_id` em
  // `epi_entrada_estoque`, não acharia, e devolveria `false` — o almoxarife
  // abriria a tela do estoque e veria zero lotes, sem erro nenhum.
  almoxarife_sesmt: ESCOPO_UNIDADE,
  secretaria_csso: ESCOPO_UNIDADE,
  consulta_progep: ESCOPO_UNIDADE,
  servidor_consulta: ESCOPO_PROPRIO,
  auditor_interno: ESCOPO_TOTAL,
};

export const ESCOPOS_VALIDOS = [ESCOPO_TOTAL, ESCOPO_UNIDADE, ESCOPO_PROPRIO, ESCOPO_AGREGADO] as const;

/**
 * Perfil sem escopo declarado quebra o sistema em silêncio — aqui, não.
 *
 * Perfil novo entra em MATRIZ_PERFIS, ninguém lembra de ESCOPO_POR_PERFIL, e
 * `UsuarioAtual.escopo` cai em escopo próprio: a tela vem vazia sem erro. Por
 * isso as duas listas são conferidas na importação do módulo.
 */
export function _conferir_escopos(): void {
  const perfis = Object.keys(MATRIZ_PERFIS);
  const escopos = Object.keys(ESCOPO_POR_PERFIL);
  const sem_escopo = perfis.filter((p) => !escopos.includes(p)).sort();
  const sem_perfil = escopos.filter((p) => !perfis.includes(p)).sort();
  const invalidos = Object.entries(ESCOPO_POR_PERFIL)
    .filter(([, nivel]) => !(ESCOPOS_VALIDOS as readonly string[]).includes(nivel))
    .map(([codigo, nivel]) => `${codigo}='${nivel}'`)
    .sort();
  const problemas: string[] = [];
  if (sem_escopo.length) {
    problemas.push("perfil em MATRIZ_PERFIS sem entrada em ESCOPO_POR_PERFIL: " + sem_escopo.join(", "));
  }
  if (sem_perfil.length) {
    problemas.push("escopo declarado para perfil que nao existe em MATRIZ_PERFIS: " + sem_perfil.join(", "));
  }
  if (invalidos.length) problemas.push("nivel de escopo desconhecido: " + invalidos.join(", "));
  if (problemas.length) throw new Error("RBAC mal declarado — " + problemas.join("; "));
}

_conferir_escopos();

// ---------------------------------------------------------------------
// Hierarquia (Dono de treinamento e turma, 23/10/2026) — NUM LUGAR SÓ.
// ---------------------------------------------------------------------
// Quem está ACIMA de quem para alterar o que outra conta criou
// (`dono_turma.ts`). Não dá permissão nenhuma: a regra de dono é uma camada a
// mais sobre o RBAC (precisa ter a permissão E ser dono, superior ou ajudante).
//
// - administrador do sistema (4) — `administrador_sistema`, acima de todos
//   (o perfil vem da branch do perfil de administração; enquanto não existir
//   aqui, a entrada é inofensiva — `PERFIS_PREVISTOS_NA_HIERARQUIA`); altera tudo;
// - superintendente (3) — altera tudo;
// - coordenação (2) — `coordenador_csso` e os equivalentes de outros setores
//   (perfil de coordenação novo entra AQUI com 2): altera o que foi criado por
//   perfil abaixo dele, no PRÓPRIO setor promotor; entre coordenadores, só o dono;
// - demais (1) — todo perfil fora desta lista (engenheiro, médico, técnico,
//   secretaria, almoxarife, consulta…): altera só o que criou, ou o que o dono
//   lhe designou como ajudante.
//
// A ORDEM, do topo para baixo, é `ORDEM_HIERARQUICA`; o número de cada um sai dela.
export const ORDEM_HIERARQUICA: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["administrador_sistema"]),
  Object.freeze(["superintendente"]),
  Object.freeze(["coordenador_csso"]),
]);
export const NIVEL_ADMINISTRACAO_SISTEMA = 4;
export const NIVEL_SUPERINTENDENCIA = 3;
export const NIVEL_COORDENACAO = 2;
export const NIVEL_DEMAIS = 1;
export const NIVEL_HIERARQUICO_POR_PERFIL: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    ORDEM_HIERARQUICA.flatMap((grupo, i) => grupo.map((perfil) => [perfil, ORDEM_HIERARQUICA.length + 1 - i] as const)),
  ),
);

/** Perfis citados na hierarquia antes de existirem na matriz (vêm de outra branch). */
export const PERFIS_PREVISTOS_NA_HIERARQUIA: ReadonlySet<string> = new Set(["administrador_sistema"]);

/** O nível da conta: o mais alto entre os perfis vigentes (sem perfil listado, "demais"). */
export function nivel_hierarquico(perfis: Iterable<string>): number {
  let nivel = NIVEL_DEMAIS;
  for (const p of perfis) {
    const dele = Object.hasOwn(NIVEL_HIERARQUICO_POR_PERFIL, p) ? NIVEL_HIERARQUICO_POR_PERFIL[p]! : NIVEL_DEMAIS;
    if (dele > nivel) nivel = dele;
  }
  return nivel;
}

/** Perfil da hierarquia que não existe é erro de digitação: derruba a importação. */
export function _conferir_hierarquia(): void {
  const sobra = Object.keys(NIVEL_HIERARQUICO_POR_PERFIL).filter(
    (p) => !Object.hasOwn(MATRIZ_PERFIS, p) && !PERFIS_PREVISTOS_NA_HIERARQUIA.has(p),
  );
  if (sobra.length) throw new Error("Hierarquia mal declarada — perfil inexistente: " + sobra.join(", "));
  const esperado: Record<string, number> = {
    administrador_sistema: NIVEL_ADMINISTRACAO_SISTEMA,
    superintendente: NIVEL_SUPERINTENDENCIA,
    coordenador_csso: NIVEL_COORDENACAO,
  };
  for (const [p, n] of Object.entries(esperado)) {
    if (NIVEL_HIERARQUICO_POR_PERFIL[p] !== n) throw new Error(`Hierarquia mal declarada — ${p} deveria ser ${n}`);
  }
}

_conferir_hierarquia();

/**
 * O mapa da liberação por módulo (`niveis_modulo.ts`) fecha com `PERMISSOES`:
 * toda permissão está num módulo OU entre as só do perfil, nunca nos dois, e
 * nenhuma está em dois módulos. Permissão nova sem decisão derruba a importação.
 */
export function _conferir_niveis(): void {
  const vistas = new Map<string, string>();
  const problemas: string[] = [];
  for (const m of MODULOS_NIVELADOS) {
    for (const p of permissoes_do_modulo(m)) {
      if (vistas.has(p)) problemas.push(`${p} em ${vistas.get(p)} e em ${m.codigo}`);
      vistas.set(p, m.codigo);
      if (!PERMISSOES[p]) problemas.push(`${p} (módulo ${m.codigo}) não existe`);
      if (Object.hasOwn(PERMISSOES_SO_DO_PERFIL, p)) problemas.push(`${p} está em ${m.codigo} e entre as só do perfil`);
    }
  }
  for (const p of Object.keys(PERMISSOES_SO_DO_PERFIL)) if (!PERMISSOES[p]) problemas.push(`${p} (só do perfil) não existe`);
  for (const p of Object.keys(PERMISSOES)) {
    if (!vistas.has(p) && !Object.hasOwn(PERMISSOES_SO_DO_PERFIL, p)) problemas.push(`${p} sem módulo nem decisão`);
  }
  // o TETO de cada perfil (D1): todo perfil que aceita nível declara o dele; o teto só tem permissão
  // de módulo, não cobre o que o perfil já tem (seria contradição) e PROGEP e auditor têm TODA a escrita
  for (const perfil of Object.keys(NUNCA_POR_NIVEL)) {
    if (!Object.hasOwn(MATRIZ_PERFIS, perfil)) problemas.push(`teto de perfil inexistente: ${perfil}`);
    else if (!aceita_nivel_modulo(perfil)) problemas.push(`teto de ${perfil}, que não aceita nível`);
  }
  for (const perfil of Object.keys(MATRIZ_PERFIS)) {
    if (!aceita_nivel_modulo(perfil)) continue;
    if (!Object.hasOwn(NUNCA_POR_NIVEL, perfil)) {
      problemas.push(`${perfil} aceita nível e não declara o teto (NUNCA_POR_NIVEL)`);
      continue;
    }
    for (const p of NUNCA_POR_NIVEL[perfil]!) {
      if (!vistas.has(p)) problemas.push(`teto de ${perfil}: ${p} não é de módulo`);
      if (MATRIZ_PERFIS[perfil]!.permissoes.includes(p)) problemas.push(`teto de ${perfil}: ${p} é permissão que o perfil tem`);
    }
  }
  for (const perfil of ["consulta_progep", "auditor_interno"]) {
    const teto = NUNCA_POR_NIVEL[perfil] ?? [];
    const solta = MODULOS_NIVELADOS.flatMap((m) => m.escrita).filter((p) => !teto.includes(p));
    if (solta.length) problemas.push(`${perfil} só vai até Consulta e o teto deixa a escrita: ${solta.join(", ")}`);
  }
  if (problemas.length) throw new Error("Liberação por módulo mal declarada — " + problemas.join("; "));
}

/**
 * O perfil recebe nível por módulo? Só os de equipe (escopo total ou de
 * unidade). O de escopo próprio é o do titular — a operação de um módulo em
 * escopo próprio daria, por exemplo, entregar EPI a si mesmo — e o agregado
 * não lê linha nenhuma (o `admin_ti` governa a conta, não o trabalho do setor).
 */
export function aceita_nivel_modulo(perfil: string): boolean {
  // o Administrador do sistema está sempre no nível mais alto de cada módulo
  // (`niveis_modulo.PERFIS_NO_NIVEL_MAIS_ALTO`): nem o perfil nem a exceção da
  // pessoa o rebaixam
  if (Object.hasOwn(PERFIS_NO_NIVEL_MAIS_ALTO, perfil)) return false;
  const nivel = Object.hasOwn(ESCOPO_POR_PERFIL, perfil) ? ESCOPO_POR_PERFIL[perfil] : undefined;
  return nivel === ESCOPO_TOTAL || nivel === ESCOPO_UNIDADE;
}

_conferir_niveis();

/** A unidade CSSO, pelo nome oficial (a sigla se repete ao longo do tempo). */
export const NOME_OFICIAL_CSSO = "COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL";

/**
 * Os perfis da equipe da CSSO: a conta que tem um deles entrou no setor CSSO
 * na migração 0014 (a mesma lista está lá, em SQL) e nas contas de teste.
 */
export const PERFIS_DA_EQUIPE_CSSO: readonly string[] = [
  "coordenador_csso",
  "engenheiro_seguranca",
  "medico_trabalho",
  "tecnico_seguranca",
  "secretaria_csso",
  "almoxarife_sesmt",
];

export const MENSAGEM_RN01 =
  "Bloqueado: a IN SGP/SEDGG/ME nº 15/2022, art. 10, §2º, I admite subscrição do " +
  "laudo apenas por servidor público federal, estadual, distrital ou municipal, ou " +
  "militar, ocupante de cargo/posto de médico com especialização em medicina do " +
  "trabalho, ou de engenheiro ou arquiteto com especialização em segurança do " +
  "trabalho.";

/**
 * Perfil gravado no banco que não consta de ESCOPO_POR_PERFIL (inserido à mão
 * por SQL). Nega em vez de cair em escopo próprio: uma tela de erro dizendo
 * qual perfil está mal declarado se conserta em minutos; uma lista vazia sem
 * erro não se conserta porque ninguém sabe que ela está errada.
 */
export class EscopoNaoDeclarado extends PermissaoNegada {
  constructor(public perfil: string) {
    super(
      "escopo",
      `O perfil '${perfil}' não tem escopo declarado em ESCOPO_POR_PERFIL. ` +
        "Nenhum dado será listado enquanto isso não for corrigido no código — " +
        "avise o administrador do sistema.",
    );
  }
}

// ---------------------------------------------------------------------
// O alcance de cada permissão (D1/D9 da verificação de governança, 22/10/2026)
// ---------------------------------------------------------------------
/**
 * Até onde UMA permissão chega, somadas as concessões que a trouxeram.
 *
 * Até 22/10/2026 o escopo e os campi eram da CONTA: o mais largo entre os
 * perfis (S>E>A>P) e a soma dos campi de todas as atribuições. Somar um perfil
 * alargava os outros. O `admin_ti` que ganhava `servidor_consulta` para se
 * inscrever em turma virava escopo A — "sem filtro" — e lia processo e parecer
 * de todos os campi; o almoxarife virava E com leitura nominal e lia parecer
 * com nome, contra a base normativa do próprio perfil; o coordenador sem campus
 * que recebia técnico no campus JK passava a ver só JK. Agora cada permissão
 * carrega o escopo e o campus do(s) perfil(is) que a concederam, e só deles:
 * dois perfis que dão a mesma permissão somam os alcances DAQUELA permissão.
 *
 * - `total` (S): a instituição inteira;
 * - `unidade` (E sem campus na concessão): todos os campi daquele perfil;
 * - `campi` (E com campus): só estes;
 * - `proprio` (P): as linhas do servidor ligado à conta;
 * - `agregado` (A): número agregado, NUNCA linha — `aplicar_escopo` o trata
 *   como "nada", e não como "sem filtro".
 */
export interface Alcance {
  readonly total: boolean;
  readonly unidade: boolean;
  readonly campi: readonly number[];
  readonly proprio: boolean;
  readonly agregado: boolean;
}

const SEM_ALCANCE: Alcance = Object.freeze({
  total: false,
  unidade: false,
  campi: Object.freeze([]) as readonly number[],
  proprio: false,
  agregado: false,
});

/** Alcança alguma linha ou número? `false` = a permissão não foi concedida. */
export function alcanca_algo(a: Alcance): boolean {
  return a.total || a.unidade || a.campi.length > 0 || a.proprio || a.agregado;
}

/** Uma concessão vigente: o perfil, o campus dela (`null` = todos) e o que ela traz. */
export interface Concessao {
  readonly perfil: string;
  readonly campus_id: number | null;
  readonly permissoes: Iterable<string>;
}

/**
 * As funções do titular (D16): o que toda conta ligada a um servidor
 * (`usuario.servidor_id`) faz sobre SI MESMA, tenha o perfil que tiver —
 * inscrever-se em turma e desistir, ver os próprios treinamentos e
 * certificados, pedir e acompanhar o próprio EPI, ver o próprio adicional e os
 * próprios processos e pareceres.
 *
 * Antes só o `servidor_consulta` as tinha, e o almoxarife ou o `admin_ti` que
 * quisesse se inscrever num curso precisava somar aquele perfil — o que, com o
 * escopo da conta, alargava tudo o mais (D1). Agora elas vêm com o vínculo,
 * SEMPRE em escopo próprio, numa concessão à parte (`CONCESSAO_DO_TITULAR`):
 * como o alcance é por permissão, a concessão do titular não alarga nada do
 * perfil de equipe — e o perfil de equipe que já dá a mesma permissão continua
 * dando o alcance dele.
 *
 * A lista é a do `servidor_consulta`, de propósito: é o mesmo titular do art.
 * 18, II da LGPD, e as rotas dele já estão escritas para o escopo próprio.
 */
export const PERMISSOES_DO_TITULAR: ReadonlySet<string> = new Set([
  "processo.ver",
  "parecer.ver",
  "treinamento.ver",
  "turma.inscrever_se",
  "epi.ver",
  "epi.requisitar",
  // acidentes (D10, 23/10/2026): toda conta ligada a servidor comunica acidente
  // e ve as PROPRIAS ocorrencias (o servidor_id da ocorrencia e o do acidentado
  // principal); a saude do proprio caso o servico le pela relacao de titular
  "acidente.comunicar",
  "acidente.ver",
]);

/**
 * O "perfil" da concessão do titular. Não é perfil do banco (não se concede
 * nem se encerra: acompanha o vínculo com o servidor) e por isso não está em
 * MATRIZ_PERFIS; o `@` garante que nenhum código de perfil gravado colide.
 */
export const CONCESSAO_DO_TITULAR = "@titular";

/**
 * A permissão que cada tabela lê por padrão, quando quem chama `aplicar_escopo`
 * não diz qual. É a permissão que guarda a tela daquela tabela; chamador novo
 * deve passar a permissão explicitamente.
 */
export const PERMISSAO_DE_LEITURA_POR_TABELA: Readonly<Record<string, readonly string[]>> = {
  processo: ["processo.ver"],
  adicional_vigencia: ["processo.ver"],
  servidor: ["processo.ver"],
  parecer_tecnico: ["parecer.ver"],
  laudo_tecnico: ["laudo.ver"],
  // o próprio pela `treinamento.ver`, o de outro pela `certificado.ver`
  // (`emissao_certificado.exigir_leitura_do_certificado` decide o rigor)
  certificado: ["certificado.ver", "treinamento.ver"],
  turma: ["treinamento.ver"],
  epi_requisicao: ["epi.ver"],
  epi_ficha_registro: ["epi.ficha", "epi.ver"],
  // acidentes: a ocorrencia recorta por campus (do local) e, no escopo proprio,
  // por `servidor_id` (o acidentado principal)
  acidente_ocorrencia: ["acidente.ver"],
  acidentado: ["acidente.ver"],
};

/** As permissões que mostram a pessoa pelo nome (RN-19), por família de tela. */
function _permissoes_nominais(permissao_de_leitura: string): string[] {
  // `epi.ficha` é nominal na própria definição, mas só nas telas de EPI: fora
  // delas o almoxarife lia o nome de quem demanda adicional (D15)
  return permissao_de_leitura.startsWith("epi.") ? ["exposicao.ver", "epi.ficha"] : ["exposicao.ver"];
}

/**
 * O alcance que UMA concessão daria: o escopo do perfil e o campus escolhido.
 * É o que se compara com o de quem concede (D2) ou redefine (D4).
 */
export function alcance_da_concessao(perfil: string, campus_id: number | null): Alcance {
  const nivel = perfil === CONCESSAO_DO_TITULAR ? ESCOPO_PROPRIO : ESCOPO_POR_PERFIL[perfil];
  if (nivel === undefined) throw new EscopoNaoDeclarado(perfil);
  return Object.freeze({
    total: nivel === ESCOPO_TOTAL,
    unidade: nivel === ESCOPO_UNIDADE && campus_id === null,
    campi: Object.freeze(nivel === ESCOPO_UNIDADE && campus_id !== null ? [campus_id] : []),
    proprio: nivel === ESCOPO_PROPRIO,
    agregado: nivel === ESCOPO_AGREGADO,
  });
}

/**
 * `a` alcança pelo menos o que `b` alcança — inclusive o agregado e o
 * próprio? O total cobre tudo; a unidade sem campus cobre campus e agregado
 * (as contagens da instituição); campus cobre só os mesmos campi; o agregado
 * cobre só o agregado; o próprio é coberto por qualquer alcance (é o dado de
 * uma pessoa, e quem lê alguma linha da permissão não ganha nada em lê-lo).
 */
export function cobre_inteiro(a: Alcance, b: Alcance): boolean {
  if (!alcanca_algo(b)) return true;
  if (a.total) return true;
  if (b.total) return false;
  if (b.unidade && !a.unidade) return false;
  if (!b.campi.every((c) => a.unidade || a.campi.includes(c))) return false;
  if (b.agregado && !(a.unidade || a.agregado)) return false;
  if (b.proprio && !alcanca_algo(a)) return false;
  return true;
}

/**
 * `a` alcança tudo o que `b` alcança? O próprio do titular não pede nada a
 * mais. O agregado de `b` é a contagem da instituição inteira: só o total ou a
 * unidade sem campus o cobrem — senão o coordenador do campus A que também
 * tinha o `indicador.ver` agregado lia sem supressão a conta de todos os campi.
 */
function _cobre(a: Alcance, b: Alcance): boolean {
  if (a.total) return true;
  if (b.total) return false;
  if (a.unidade) return true;
  if (b.unidade || b.agregado) return false;
  return b.campi.every((c) => a.campi.includes(c));
}

export interface DadosUsuarioAtual {
  id: number;
  login: string;
  nome: string;
  permissoes: Iterable<string>;
  perfis: readonly string[];
  campi?: readonly number[];
  servidor_id?: number | null;
  precisa_trocar_senha?: boolean;
  habilitacoes?: readonly number[];
  /**
   * As concessões vigentes, cada uma com o campus e as permissões dela. É o
   * que `carregar_usuario_atual` passa, e com ela o alcance é calculado por
   * permissão. Sem ela (o `UsuarioAtual` montado à mão nos testes), vale o
   * modo de compatibilidade: todo perfil listado alcança toda permissão da
   * conta, com os `campi` da conta.
   */
  concessoes?: readonly Concessao[];
  /**
   * Os setores promotores (`unidade_uorg.id`) a que a conta está vinculada
   * (`equipe_setor_promotor`, 22/10/2026): as turmas que a equipe vê e gere.
   */
  setores_promotores?: readonly number[];
  /** Vinculada à CSSO — a dona das turmas sem setor promotor (as de antes de 0011). */
  setor_csso?: boolean;
}

/**
 * Identidade resolvida da sessão — o que rotas e serviços recebem.
 *
 * Classe, e não objeto solto, para que o template chame `usuario.pode('x')` e
 * leia `usuario.ve_dado_nominal` como no Jinja. `permissoes` é um `Set`
 * congelado (o `frozenset` do Python).
 */
export class UsuarioAtual {
  readonly id: number;
  readonly login: string;
  readonly nome: string;
  readonly permissoes: ReadonlySet<string>;
  readonly perfis: readonly string[];
  /**
   * A soma dos campi das concessões. Só para MOSTRAR: filtrar por ela é o
   * defeito D9 (o campus de uma concessão restringia ou estendia todos os
   * perfis da conta). Filtro é `alcance(permissao)` / `aplicar_escopo`.
   */
  readonly campi: readonly number[];
  readonly servidor_id: number | null;
  readonly precisa_trocar_senha: boolean;
  readonly habilitacoes: readonly number[];
  readonly concessoes: readonly Concessao[] | null;
  readonly setores_promotores: readonly number[];
  readonly setor_csso: boolean;
  readonly #cache = new Map<string, Alcance>();

  constructor(d: DadosUsuarioAtual) {
    this.id = d.id;
    this.login = d.login;
    this.nome = d.nome;
    this.permissoes = new Set(d.permissoes);
    this.perfis = Object.freeze([...d.perfis]);
    this.campi = Object.freeze([...(d.campi ?? [])]);
    this.servidor_id = d.servidor_id ?? null;
    this.precisa_trocar_senha = d.precisa_trocar_senha ?? false;
    this.habilitacoes = Object.freeze([...(d.habilitacoes ?? [])]);
    this.concessoes = d.concessoes
      ? Object.freeze(
          d.concessoes.map((c) => {
            const permissoes = new Set(c.permissoes);
            // a base derivada também na concessão montada à mão, que já vem
            // com as efetivas (`perfis_vigentes` a marca antes, quando o nível
            // tirou o `processo.ver` que a sustentava)
            if (c.perfil !== CONCESSAO_DO_TITULAR && concessao_da_a_base(permissoes, permissoes)) {
              permissoes.add(PERMISSAO_DA_BASE);
            }
            return Object.freeze({ perfil: c.perfil, campus_id: c.campus_id, permissoes: Object.freeze(permissoes) });
          }),
        )
      : null;
    this.setores_promotores = Object.freeze([...(d.setores_promotores ?? [])]);
    this.setor_csso = d.setor_csso ?? false;
  }

  pode(codigo: string): boolean {
    // a base compartilhada é derivada e mora só nas concessões
    // (`niveis_modulo.PERMISSAO_DA_BASE`); montado à mão, ela segue o
    // `processo.ver`, como sempre seguiu
    if (codigo === PERMISSAO_DA_BASE) {
      if (this.concessoes === null) return this.permissoes.has("processo.ver");
      return this.concessoes.some((c) => (c.permissoes as ReadonlySet<string>).has(PERMISSAO_DA_BASE));
    }
    return this.permissoes.has(codigo);
  }

  exigir(codigo: string): void {
    if (!this.pode(codigo)) throw new PermissaoNegada(codigo);
  }

  /**
   * O nível da CONTA: o mais largo entre os perfis (a concessão do titular não
   * entra). Serve para o que é da conta e não de uma leitura — o menu ("Meu
   * espaço" ou a lateral da equipe), a fila de pendências. Para filtrar ou
   * decidir uma leitura use `escopo_de(permissao)` / `aplicar_escopo`: é aqui
   * que somar perfis alargava tudo (D1).
   */
  get escopo(): string {
    const niveis: string[] = [];
    for (const perfil of this.perfis) {
      const nivel = ESCOPO_POR_PERFIL[perfil];
      if (nivel === undefined) throw new EscopoNaoDeclarado(perfil);
      niveis.push(nivel);
    }
    for (const nivel of [ESCOPO_TOTAL, ESCOPO_UNIDADE, ESCOPO_AGREGADO, ESCOPO_PROPRIO]) {
      if (niveis.includes(nivel)) return nivel;
    }
    // usuário sem perfil vigente: vê o que é dele e mais nada
    return ESCOPO_PROPRIO;
  }

  /**
   * Até onde a permissão (ou qualquer uma da lista) chega para esta conta.
   * Sem a permissão, `SEM_ALCANCE`. Concessão de perfil sem escopo declarado
   * nega com a tela que nomeia o perfil (`EscopoNaoDeclarado`).
   */
  alcance(permissao: string | readonly string[]): Alcance {
    return this.#alcance(permissao, false);
  }

  /**
   * O alcance que vem dos PERFIS da conta, sem a concessão do titular. É o que
   * pergunta quem decide uma tela ou um ato DE EQUIPE: com as funções do
   * titular (D16), toda conta ligada a servidor tem `processo.ver`,
   * `treinamento.ver` e `epi.ver` em escopo próprio, e "tem a permissão" deixou
   * de querer dizer "trabalha no módulo". A regra "ninguém concede mais do que
   * tem" (D2) e a fila do setor perguntam por aqui.
   */
  alcance_da_equipe(permissao: string | readonly string[]): Alcance {
    return this.#alcance(permissao, true);
  }

  /**
   * Tem a permissão por um perfil de equipe — alcance além do próprio dado:
   * total, unidade ou campus (o agregado conta, porque é de equipe também).
   * O `servidor_consulta` e a concessão do titular não chegam aqui.
   */
  pode_na_equipe(codigo: string | readonly string[]): boolean {
    const a = this.alcance_da_equipe(codigo);
    return a.total || a.unidade || a.campi.length > 0 || a.agregado;
  }

  /**
   * A porta das telas DE EQUIPE (o catálogo, o estoque, o kanban, a matriz de
   * perfis): a permissão por um perfil de equipe, e não só pela concessão do
   * titular ou pelo `servidor_consulta` (D16). Sem isto, toda conta ligada a
   * servidor — o almoxarife, o `admin_ti` — abria as telas internas guardadas
   * por `processo.ver`, `treinamento.ver` ou `epi.ver`.
   */
  exigir_na_equipe(codigo: string): void {
    this.exigir(codigo);
    if (!this.pode_na_equipe(codigo)) {
      throw new PermissaoNegada(
        codigo,
        "Esta tela é do trabalho do setor. A sua conta tem esta permissão só sobre o que é seu " +
          "(as funções do titular), e por isso as suas telas ficam em Meu espaço.",
      );
    }
  }

  #alcance(permissao: string | readonly string[], sem_titular: boolean): Alcance {
    const lista = typeof permissao === "string" ? [permissao] : [...permissao];
    const chave = `${sem_titular ? "equipe:" : ""}${lista.join("|")}`;
    const guardado = this.#cache.get(chave);
    if (guardado) return guardado;
    const a = { total: false, unidade: false, campi: new Set<number>(), proprio: false, agregado: false };
    const somar = (nivel: string, campus_id: number | null) => {
      if (nivel === ESCOPO_TOTAL) a.total = true;
      else if (nivel === ESCOPO_AGREGADO) a.agregado = true;
      else if (nivel === ESCOPO_PROPRIO) a.proprio = true;
      else if (campus_id === null) a.unidade = true;
      else a.campi.add(campus_id);
    };
    if (this.concessoes === null) {
      // compatibilidade (UsuarioAtual montado à mão): o alcance é o da conta,
      // como era — com a diferença de que A deixou de ser "sem filtro"
      if (!this.perfis.length) a.proprio = true;
      for (const perfil of this.perfis) {
        const nivel = ESCOPO_POR_PERFIL[perfil];
        if (nivel === undefined) throw new EscopoNaoDeclarado(perfil);
        if (nivel === ESCOPO_UNIDADE && this.campi.length) for (const c of this.campi) somar(nivel, c);
        else somar(nivel, null);
      }
    } else {
      for (const c of this.concessoes) {
        if (sem_titular && c.perfil === CONCESSAO_DO_TITULAR) continue;
        if (!lista.some((p) => (c.permissoes as ReadonlySet<string>).has(p))) continue;
        const nivel = c.perfil === CONCESSAO_DO_TITULAR ? ESCOPO_PROPRIO : ESCOPO_POR_PERFIL[c.perfil];
        if (nivel === undefined) throw new EscopoNaoDeclarado(c.perfil);
        somar(nivel, c.campus_id);
      }
    }
    const pronto: Alcance = alcanca_algo({ ...a, campi: [...a.campi] })
      ? Object.freeze({ ...a, campi: Object.freeze([...a.campi].sort((x, y) => x - y)) })
      : SEM_ALCANCE;
    this.#cache.set(chave, pronto);
    return pronto;
  }

  /**
   * O nível de UMA permissão, o mais largo entre as concessões que a deram
   * (S>E>A>P), ou `null` sem ela. É a pergunta "esta tela é a do titular?":
   * `escopo_de("processo.ver") === ESCOPO_PROPRIO` quer dizer que a conta só
   * alcança os PRÓPRIOS processos, ainda que tenha um perfil de equipe que
   * não lê processo (o almoxarife, o `admin_ti`).
   */
  escopo_de(permissao: string | readonly string[]): string | null {
    const a = this.alcance(permissao);
    if (a.total) return ESCOPO_TOTAL;
    if (a.unidade || a.campi.length) return ESCOPO_UNIDADE;
    if (a.agregado) return ESCOPO_AGREGADO;
    if (a.proprio) return ESCOPO_PROPRIO;
    return null;
  }

  /**
   * RN-19, forma antiga: há ALGUMA concessão nominal na conta. Não diz sobre
   * qual leitura — prefira `ve_dado_nominal_em(permissao)` (a leitura) ou
   * `ve_nome_na_linha(linha)` (a linha).
   *
   * `epi.ficha` entra na conta porque a permissão é, na própria definição,
   * "ver a ficha de EPI NOMINAL": mascarar o nome em seguida tornaria inútil a
   * tela que ela autoriza (o almoxarife entregaria a bota para o código errado).
   */
  get ve_dado_nominal(): boolean {
    return this.pode("exposicao.ver") || this.pode("epi.ficha");
  }

  /**
   * RN-19 por leitura: quem lê X pela `permissao_de_leitura` lê o NOME em
   * todas as linhas que ela alcança? Só quando a permissão nominal da família
   * (`exposicao.ver`; nas telas de EPI também `epi.ficha`) alcança pelo menos
   * o mesmo que a leitura. A secretaria do campus A que é coordenadora no
   * campus B lê parecer de A e de B, e o nome só nos de B: aqui sai `false`, e
   * a linha a linha fica com `ve_nome_na_linha`.
   */
  ve_dado_nominal_em(permissao_de_leitura: string): boolean {
    const nominais = _permissoes_nominais(permissao_de_leitura);
    if (!nominais.some((p) => this.pode(p))) return false;
    return _cobre(this.alcance(nominais), this.alcance(permissao_de_leitura));
  }

  /**
   * RN-19 numa tela SEM recorte de linha (a contagem da instituição inteira,
   * como /relatorios e /epis/relatorios): só quem lê o nome em todo campus —
   * a permissão nominal total ou de unidade sem campus. Comparar com o alcance
   * de `indicador.ver` (`ve_dado_nominal_em`) não basta quando a consulta não
   * se recorta por ele: o coordenador com `exposicao.ver` e `indicador.ver` só
   * no campus A saía "nominal" e lia sem supressão as contagens pequenas dos
   * outros campi (D9/D15). `nominais` é a família da tela.
   */
  ve_dado_nominal_sem_recorte(nominais: readonly string[] = ["exposicao.ver"]): boolean {
    if (!nominais.some((p) => this.pode(p))) return false;
    const alcance = this.alcance(nominais);
    return alcance.total || alcance.unidade;
  }

  /**
   * RN-19 na linha: o nome desta linha aparece? O próprio titular sempre (art.
   * 18, II da LGPD). Os outros, se a permissão nominal alcança a linha — pelo
   * campus dela quando a linha o tem; sem campus conhecido, basta a permissão
   * nominal (não há como recortar, como em `aplicar_escopo`). `nominais` é a
   * família da tela; o padrão é a do `ve_dado_nominal`, para quem não sabe.
   */
  ve_nome_na_linha(
    linha: { servidor_id?: number | null; campus_id?: number | null },
    nominais: readonly string[] = ["exposicao.ver", "epi.ficha"],
  ): boolean {
    if (this.servidor_id !== null && linha.servidor_id === this.servidor_id) return true;
    if (!nominais.some((p) => this.pode(p))) return false;
    // montado à mão (testes): a permissão basta, como sempre bastou
    if (this.concessoes === null) return true;
    const alcance = this.alcance(nominais);
    if (alcance.total || alcance.unidade) return true;
    if (!alcance.campi.length) return false;
    if (linha.campus_id === null || linha.campus_id === undefined) return true;
    return alcance.campi.includes(linha.campus_id);
  }
}

/**
 * Permissões que governam o próprio sistema — quem as tem cria conta, concede
 * perfil, atesta habilitação ou leva o banco. A conta que tem uma delas é
 * "conta de administração", e a senha dela só se redefine por quem concede
 * perfil (`/usuarios/{id}/senha`; revisão de segurança, 25/09/2026).
 */
export const PERMISSOES_DE_GOVERNO: ReadonlySet<string> = new Set([
  "perfil.conceder",
  "habilitacao.atestar",
  "usuario.criar_conta",
  "usuario.resetar_senha",
  "backup.executar",
]);

/** A conta tem (nas concessões dadas) o perfil Administrador do sistema? */
export function tem_administrador_sistema(perfis: Iterable<string>): boolean {
  for (const p of perfis) if (p === PERFIL_ADMINISTRADOR_SISTEMA) return true;
  return false;
}

/**
 * A trava do perfil do topo: conceder o Administrador do sistema, ou mexer na
 * conta que o tem (vigente ou futuro), é ato só de quem também o tem. Devolve o
 * motivo da recusa, ou `null`. `perfis_do_alvo` são os perfis da conta-alvo.
 */
export function recusa_do_administrador_sistema(
  usuario: Pick<UsuarioAtual, "perfis">,
  perfis_do_alvo: Iterable<string>,
): string | null {
  if (!tem_administrador_sistema(perfis_do_alvo) || tem_administrador_sistema(usuario.perfis)) return null;
  return "é conta de Administrador do sistema; só outro Administrador do sistema concede esse perfil ou altera essa conta.";
}

export function eh_conta_de_governo(permissoes: Iterable<string>): boolean {
  for (const p of permissoes) if (PERMISSOES_DE_GOVERNO.has(p)) return true;
  return false;
}

/**
 * Perfis vigentes da conta, suas permissões, os campi das atribuições e as
 * concessões (perfil + campus + permissões de cada uma) — sem olhar se a conta
 * está ativa. Separado de `carregar_usuario_atual` para quem precisa saber o
 * que uma conta ALCANÇARIA (a redefinição de senha compara privilégios
 * inclusive de conta inativa, que pode ser reativada).
 *
 * `incluir_futuras` (D18): conta também a concessão que ainda vai começar. É o
 * que as travas de governo perguntam — a conta que recebe superintendente com
 * início na semana que vem já é conta de administração hoje: quem redefinisse
 * a senha dela hoje teria, no dia do início, uma conta com `perfil.conceder`.
 */
export async function perfis_vigentes(
  tx: Executor,
  usuario_id: number | SQL,
  hoje: string | null = null,
  opcoes: { incluir_futuras?: boolean } = {},
): Promise<{ permissoes: Set<string>; perfis: string[]; campi: Set<number>; concessoes: Concessao[] }> {
  const dia = hoje ?? hoje_iso();
  // O nível por módulo do perfil e a exceção da pessoa vêm na MESMA consulta
  // (liberação por módulo, 22/10/2026): esta leitura roda em todo pedido.
  const atribuicoes = (
    await tx.query.atribuicao.findMany({
      where: eq(atribuicao.usuario_id, usuario_id),
      with: {
        perfil: { with: { perfil_permissoes: { with: { permissao: true } }, niveis_modulo: true } },
        usuario: { columns: { id: true }, with: { niveis_modulo: true } },
      },
    })
  ).filter((a) => vigente_em(a, dia) || (opcoes.incluir_futuras === true && a.vigencia_inicio > dia));

  const permissoes = new Set<string>();
  const perfis: string[] = [];
  const campi = new Set<number>();
  const concessoes: Concessao[] = [];
  for (const a of atribuicoes) {
    const perfil = a.perfil;
    if (!perfil || !perfil.ativo) continue;
    if (!perfis.includes(perfil.codigo)) perfis.push(perfil.codigo);
    const cruas = perfil.perfil_permissoes.map((pp) => pp.permissao.codigo);
    // perfil → nível do módulo → exceção da pessoa (`niveis_modulo.ts`); só
    // nos perfis de equipe — o do titular e o agregado ficam como estão
    const dela = aceita_nivel_modulo(perfil.codigo)
      ? permissoes_com_niveis(cruas, niveis_de(perfil.niveis_modulo), niveis_de(a.usuario?.niveis_modulo ?? []), perfil.codigo)
      : cruas;
    for (const p of dela) permissoes.add(p);
    if (a.campus_id) campi.add(a.campus_id);
    // a base compartilhada sobrevive a "Sem acesso" em Processos SEI enquanto a
    // concessão der outro módulo (23/10/2026); fica só na concessão, com o
    // alcance dela, e não entra em `permissoes`
    const da_concessao = concessao_da_a_base(cruas, dela) ? [...dela, PERMISSAO_DA_BASE] : dela;
    concessoes.push({ perfil: perfil.codigo, campus_id: a.campus_id ?? null, permissoes: da_concessao });
  }
  return { permissoes, perfis, campi, concessoes };
}

/**
 * Carrega a identidade da conta: perfis VIGENTES hoje (e ativos), suas
 * permissões com o alcance de cada uma (as concessões), campi das atribuições
 * e habilitações técnicas vigentes. Conta ligada a servidor ganha também a
 * concessão do titular (`PERMISSOES_DO_TITULAR`, sempre em escopo próprio).
 *
 * `hoje` é 'AAAA-MM-DD' — o dia de negócio em America/Sao_Paulo, e não o dia
 * UTC do processo da função (ver `dominio/datas.ts`).
 *
 * `usuario_id` pode ser a SUBCONSULTA que acha a conta pela sessão
 * (`autenticacao.conta_da_sessao`): aí a identidade sai junto com a sessão, sem
 * esperar por ela. As três leituras vão juntas — uma ida ao banco.
 */
export async function carregar_usuario_atual(
  tx: Executor,
  usuario_id: number | SQL,
  hoje: string | null = null,
): Promise<UsuarioAtual> {
  const dia = hoje ?? hoje_iso();
  const [usuario, { permissoes, perfis, campi, concessoes }, vinculos] = await Promise.all([
    tx.query.usuario.findFirst({
      where: eq(tabela_usuario.id, usuario_id),
      // os setores promotores vêm junto com a conta: nenhuma ida a mais
      with: { setores_promotores: { with: { unidade: { columns: { id: true, nome_oficial: true } } } } },
    }),
    perfis_vigentes(tx, usuario_id, dia),
    tx.query.profissional_habilitado.findMany({ where: eq(profissional_habilitado.usuario_id, usuario_id) }),
  ]);
  if (!usuario || !usuario.ativo) {
    throw new PermissaoNegada("sessao", "usuario inativo ou inexistente");
  }
  const habilitacoes = vinculos.filter((h) => vigente_em(h, dia)).map((h) => h.id);
  if (usuario.servidor_id !== null) {
    concessoes.push({ perfil: CONCESSAO_DO_TITULAR, campus_id: null, permissoes: PERMISSOES_DO_TITULAR });
    for (const p of PERMISSOES_DO_TITULAR) permissoes.add(p);
  }

  return new UsuarioAtual({
    id: usuario.id,
    login: usuario.login,
    nome: usuario.nome,
    permissoes,
    perfis,
    campi: [...campi].sort((x, y) => x - y),
    servidor_id: usuario.servidor_id,
    precisa_trocar_senha: usuario.precisa_trocar_senha,
    habilitacoes,
    concessoes,
    setores_promotores: usuario.setores_promotores.map((s) => s.unidade_uorg_id).sort((x, y) => x - y),
    setor_csso: usuario.setores_promotores.some((s) => s.unidade?.nome_oficial === NOME_OFICIAL_CSSO),
  });
}

// ---------------------------------------------------------------------
// RN-01 - a habilitação confere, não o cargo
// ---------------------------------------------------------------------
export async function pode_subscrever(
  tx: Executor,
  usuario: UsuarioAtual,
  quando: string | null = null,
): Promise<boolean> {
  const dia = quando ?? hoje_iso();
  if (!usuario.pode("parecer.assinar")) return false;
  const habilitacoes = await tx
    .select()
    .from(profissional_habilitado)
    .where(eq(profissional_habilitado.usuario_id, usuario.id));
  return habilitacoes.some((h) => vigente_em(h, dia));
}

export async function exigir_subscricao(
  tx: Executor,
  usuario: UsuarioAtual,
  quando: string | null = null,
): Promise<void> {
  if (!(await pode_subscrever(tx, usuario, quando))) {
    throw new PermissaoNegada("parecer.assinar", MENSAGEM_RN01);
  }
}

// ---------------------------------------------------------------------
// Filtro de escopo no repositório
// ---------------------------------------------------------------------
/**
 * Todo repositório DEVE chamar esta função.
 *
 * **Adaptação ao Drizzle.** No Python ela recebia a `select(...)` e devolvia a
 * consulta com o `.where(...)` a mais. O Drizzle não tem consulta que se
 * estenda assim depois de montada, então aqui ela devolve a CONDIÇÃO, e quem
 * consulta a combina com os próprios filtros:
 *
 *     const escopo = aplicar_escopo(usuario, processo, "processo.ver");
 *     await tx.select().from(processo).where(and(escopo, eq(processo.x, y)));
 *     // ou: tx.query.processo.findMany({ where: and(escopo, ...) })
 *
 * - `undefined` = sem restrição (o `and()` do Drizzle ignora `undefined`);
 * - `sql\`false\`` = nada (o `where(False)` do Python);
 * - senão, `coluna = servidor_id` (próprio), `campus_id IN (...)` (unidade com
 *   campus), ou o `OR` dos dois quando a permissão veio de concessões dos dois.
 *
 * `permissao` é a permissão da leitura (ou da escrita) que a tela faz — o
 * alcance é o DELA, e não o da conta (D1/D9). Lista = qualquer uma delas.
 * Omitida, vale `PERMISSAO_DE_LEITURA_POR_TABELA`; tabela fora do mapa sem
 * permissão nega. Agregado (A) nunca é linha: dá `false`.
 *
 * `tabela` é a tabela do Drizzle cujas colunas o filtro usa (padrão: `processo`,
 * como no Python).
 */
export function aplicar_escopo(
  usuario: UsuarioAtual,
  tabela: PgTable = processo,
  permissao?: string | readonly string[],
): SQL | undefined {
  const colunas = tabela as unknown as Record<string, PgColumn | undefined>;
  const nome = getTableName(tabela);
  let lida = permissao;
  if (lida === undefined) {
    lida = PERMISSAO_DE_LEITURA_POR_TABELA[nome];
    if (lida === undefined && usuario.concessoes !== null) {
      console.warn(`aplicar_escopo sobre ${nome} sem permissao declarada: lista vazia para a conta ${usuario.id}`);
      return sql`false`;
    }
  }
  const alcance = usuario.alcance(lida ?? []);
  if (alcance.total || alcance.unidade) return undefined;
  const partes: SQL[] = [];
  if (alcance.campi.length) {
    const coluna_campus = colunas["campus_id"];
    // sem a coluna não há como recortar por campus: a unidade vê a tabela
    // inteira, como no Python (`processo` não tem `campus_id`)
    if (!coluna_campus) return undefined;
    partes.push(inArray(coluna_campus, [...alcance.campi]));
  }
  if (alcance.proprio) {
    let coluna = colunas["servidor_id"];
    if (!coluna && nome === "servidor") {
      // `servidor` é a única tabela em que "o servidor desta linha" não se
      // chama `servidor_id`: é a chave primária.
      coluna = colunas["id"];
    }
    if (coluna) {
      partes.push(eq(coluna, usuario.servidor_id ?? -1));
    } else if (!partes.length) {
      // negar é o certo, calar não: sem `servidor_id` não há como dizer o que
      // é "próprio". `usuario.id`, e não o login (nome de pessoa não entra em
      // log — ROPA §6).
      console.warn(
        `escopo proprio sobre ${nome}, que nao tem servidor_id: lista vazia para a conta ${usuario.id} ` +
          `(perfis: ${usuario.perfis.join(", ") || "nenhum"})`,
      );
    }
  }
  // nada concedido, ou só o agregado: nenhuma linha
  if (!partes.length) return sql`false`;
  return partes.length === 1 ? partes[0] : or(...partes);
}
