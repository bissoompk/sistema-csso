/**
 * RBAC — perfis, permissões e escopo (§6 do prompt). Porte de `app/servicos/rbac.py`.
 *
 * Checagem em três camadas: middleware de rota, service layer antes de qualquer
 * escrita, e filtro de escopo no repositório. Negado por padrão. Nunca confie em
 * esconder botão.
 */
import { eq, inArray, sql, getTableName, type SQL } from "drizzle-orm";
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
  // `participante.mesclar` (fatia 6) e `vencimento.ver` (fatia 7) continuam
  // fora pela mesma razao de sempre: semear cedo e conceder acesso que so sai
  // por SQL manual.
  "certificado.emitir": "Emitir certificado (consome numero)",
  "certificado.anular": "Anular certificado emitido",
  "certificado.ver": "Ver certificado nominal e dados do participante",
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
};

export const MATRIZ_PERFIS: Record<string, DadosPerfil> = {
  admin_ti: {
    nome: "Administrador de TI",
    base_normativa: "Sem acesso ao conteudo tecnico. So conta, senha, auditoria e backup.",
    permissoes: [
      "usuario.criar_conta",
      "usuario.resetar_senha",
      "auditoria.ver",
      "backup.executar",
      "indicador.ver",
    ],
  },
  superintendente: {
    nome: "Superintendente da Sisa",
    base_normativa: "Resolucao Consu UFVJM 11/2026, art. 11, IX",
    permissoes: [
      "processo.ver",
      "parecer.ver",
      "laudo.ver",
      "processo.atribuir",
      "perfil.conceder",
      "habilitacao.atestar",
      "exposicao.ver",
      "exportar",
      "auditoria.ver",
      "indicador.ver",
      "treinamento.ver",
      "certificado.ver",
      "epi.ver",
      "epi.ficha",
      // le a fila do setor e nao escreve nela: e a mesma forma do resto do
      // perfil, que ve tudo e opera nada
      "demanda.ver",
    ],
  },
  coordenador_csso: {
    nome: "Coordenador da CSSO",
    base_normativa: "Resolucao Consu UFVJM 11/2026, art. 20, VII",
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
      "epi.ver",
      "epi.catalogo",
      "epi.entregar",
      "epi.ficha",
      "epi.estoque",
      "epi.requisitar",
      "epi.analisar",
      "demanda.ver",
      "demanda.registrar",
    ],
  },
  engenheiro_seguranca: {
    nome: "Engenheiro de Seguranca do Trabalho",
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
    ],
  },
  medico_trabalho: {
    nome: "Medico do Trabalho",
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
    ],
  },
  tecnico_seguranca: {
    nome: "Tecnico de Seguranca do Trabalho",
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
    ],
  },
  almoxarife_sesmt: {
    nome: "Almoxarife do SESMT",
    base_normativa:
      "Opera o estoque e a entrega do EPI. Nao decide o direito ao item, " +
      "nao le parecer, nao ve exposicao.",
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
    permissoes: ["epi.ver", "epi.estoque", "epi.entregar", "epi.ficha", "demanda.ver", "demanda.registrar"],
  },
  secretaria_csso: {
    nome: "Secretaria da CSSO",
    base_normativa: "Sem acesso a exposicao (dado mascarado - RN-19).",
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
    ],
  },
  consulta_progep: {
    nome: "Consulta PROGEP",
    base_normativa: "Le apenas parecer assinado.",
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
      // a ficha de EPI e um dos documentos que a PROGEP e a procuradoria
      // pedem primeiro (SS12.8 do desenho); ler a de outro fica em
      // `acesso_dado_sensivel`
      "epi.ver",
      "epi.ficha",
    ],
  },
  servidor_consulta: {
    nome: "Servidor (consulta do proprio processo)",
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
    permissoes: [
      "processo.ver",
      "parecer.ver",
      "treinamento.ver",
      "turma.inscrever_se",
      "epi.ver",
      "epi.requisitar",
    ],
  },
  auditor_interno: {
    nome: "Auditor interno",
    base_normativa: "Leitura ampla, escrita nenhuma.",
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
      "epi.ver",
      "epi.ficha",
      // leitura ampla, escrita nenhuma: e a fila que mostra o trabalho que
      // o setor faz FORA do SEI, e e justamente esse o trabalho que uma
      // auditoria por processo nao enxerga
      "demanda.ver",
    ],
  },
};

// `permissao.modulo` existe desde o esquema inicial com default 'ADICIONAL', mas
// ninguém a preenchia. NADA lê esta coluna hoje — /perfis renderiza a partir de
// MATRIZ_PERFIS, que é código. O mapa serve para a coluna ter valor correto desde
// já, para quando existir a tela de permissões por módulo.
export const MODULO_PADRAO = "ADICIONAL";
export const MODULO_POR_PERMISSAO: Record<string, string> = {
  "treinamento.ver": "TREINAMENTOS",
  "treinamento.gerenciar": "TREINAMENTOS",
  "assinatura.gerenciar": "TREINAMENTOS",
  "turma.criar": "TREINAMENTOS",
  "turma.inscrever": "TREINAMENTOS",
  "turma.inscrever_se": "TREINAMENTOS",
  "turma.concluir": "TREINAMENTOS",
  "turma.avaliar": "TREINAMENTOS",
  "certificado.emitir": "TREINAMENTOS",
  "certificado.anular": "TREINAMENTOS",
  "certificado.ver": "TREINAMENTOS",
  "epi.ver": "EPI",
  "epi.catalogo": "EPI",
  "epi.entregar": "EPI",
  "epi.ficha": "EPI",
  "epi.estoque": "EPI",
  "epi.requisitar": "EPI",
  "epi.analisar": "EPI",
  // "BASE": demanda não pertence a módulo nenhum — mora na base compartilhada
  // de `modulos.ts`. Carimbá-la de 'ADICIONAL' (o default) seria mentir na coluna.
  "demanda.ver": "BASE",
  "demanda.registrar": "BASE",
};

export function modulo_da_permissao(codigo: string): string {
  return MODULO_POR_PERMISSAO[codigo] ?? MODULO_PADRAO;
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
  readonly campi: readonly number[];
  readonly servidor_id: number | null;
  readonly precisa_trocar_senha: boolean;
  readonly habilitacoes: readonly number[];

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
  }

  pode(codigo: string): boolean {
    return this.permissoes.has(codigo);
  }

  exigir(codigo: string): void {
    if (!this.pode(codigo)) throw new PermissaoNegada(codigo);
  }

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
   * RN-19: quem pode ler a pessoa pelo nome, e não pelo código opaco.
   *
   * `epi.ficha` entra na conta porque a permissão é, na própria definição,
   * "ver a ficha de EPI NOMINAL": mascarar o nome em seguida tornaria inútil a
   * tela que ela autoriza (o almoxarife entregaria a bota para o código errado).
   */
  get ve_dado_nominal(): boolean {
    return this.pode("exposicao.ver") || this.pode("epi.ficha");
  }
}

/**
 * Carrega a identidade da conta: perfis VIGENTES hoje (e ativos), suas
 * permissões, campi das atribuições e habilitações técnicas vigentes.
 *
 * `hoje` é 'AAAA-MM-DD' — o dia de negócio em America/Sao_Paulo, e não o dia
 * UTC do processo da função (ver `dominio/datas.ts`).
 */
export async function carregar_usuario_atual(
  tx: Executor,
  usuario_id: number,
  hoje: string | null = null,
): Promise<UsuarioAtual> {
  const dia = hoje ?? hoje_iso();
  const usuario = await tx.query.usuario.findFirst({ where: eq(tabela_usuario.id, usuario_id) });
  if (!usuario || !usuario.ativo) {
    throw new PermissaoNegada("sessao", "usuario inativo ou inexistente");
  }

  const atribuicoes = (
    await tx.query.atribuicao.findMany({
      where: eq(atribuicao.usuario_id, usuario_id),
      with: { perfil: { with: { perfil_permissoes: { with: { permissao: true } } } } },
    })
  ).filter((a) => vigente_em(a, dia));

  const permissoes = new Set<string>();
  const perfis: string[] = [];
  const campi = new Set<number>();
  for (const a of atribuicoes) {
    const perfil = a.perfil;
    if (!perfil || !perfil.ativo) continue;
    perfis.push(perfil.codigo);
    for (const pp of perfil.perfil_permissoes) permissoes.add(pp.permissao.codigo);
    if (a.campus_id) campi.add(a.campus_id);
  }

  const habilitacoes = (
    await tx.query.profissional_habilitado.findMany({
      where: eq(profissional_habilitado.usuario_id, usuario_id),
    })
  )
    .filter((h) => vigente_em(h, dia))
    .map((h) => h.id);

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
 *     const escopo = aplicar_escopo(usuario, processo);
 *     await tx.select().from(processo).where(and(escopo, eq(processo.x, y)));
 *     // ou: tx.query.processo.findMany({ where: and(escopo, ...) })
 *
 * - `undefined` = sem restrição (o `and()` do Drizzle ignora `undefined`);
 * - `sql\`false\`` = nada (o `where(False)` do Python);
 * - senão, `coluna = servidor_id` (próprio) ou `campus_id IN (...)` (unidade).
 *
 * `tabela` é a tabela do Drizzle cujas colunas o filtro usa (padrão: `processo`,
 * como no Python).
 */
export function aplicar_escopo(usuario: UsuarioAtual, tabela: PgTable = processo): SQL | undefined {
  const escopo = usuario.escopo;
  const colunas = tabela as unknown as Record<string, PgColumn | undefined>;
  const nome = getTableName(tabela);
  if (escopo === ESCOPO_TOTAL || escopo === ESCOPO_AGREGADO) return undefined;
  if (escopo === ESCOPO_PROPRIO) {
    let coluna = colunas["servidor_id"];
    if (!coluna && nome === "servidor") {
      // `servidor` é a única tabela em que "o servidor desta linha" não se
      // chama `servidor_id`: é a chave primária.
      coluna = colunas["id"];
    }
    if (!coluna) {
      // negar é o certo, calar não: sem `servidor_id` não há como dizer o que
      // é "próprio". `usuario.id`, e não o login (nome de pessoa não entra em
      // log — ROPA §6).
      console.warn(
        `escopo proprio sobre ${nome}, que nao tem servidor_id: lista vazia para a conta ${usuario.id} ` +
          `(perfis: ${usuario.perfis.join(", ") || "nenhum"})`,
      );
      return sql`false`;
    }
    return eq(coluna, usuario.servidor_id ?? -1);
  }
  // ESCOPO_UNIDADE: sem campus atribuído = coordenadoria inteira
  if (!usuario.campi.length) return undefined;
  const coluna_campus = colunas["campus_id"];
  if (coluna_campus) return inArray(coluna_campus, [...usuario.campi]);
  return undefined;
}
