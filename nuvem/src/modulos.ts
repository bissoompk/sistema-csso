/**
 * Os módulos do sistema e o que é base compartilhada entre eles.
 * Porte de `app/modulos.py`.
 *
 * A divisão não é por tela, é por natureza:
 *
 * - **Módulo**: o fluxo de trabalho de uma competência. Tem começo, meio e fim,
 *   e some inteiro se a competência sair do setor.
 * - **Base**: o que qualquer módulo pressupõe. Servidor, unidade, cargo, posto,
 *   usuário e trilha de auditoria não pertencem ao adicional ocupacional.
 *
 * Este arquivo é a única fonte do menu e da página `/modulos`. Módulo novo se
 * declara aqui e aparece nos dois lugares.
 *
 * Carregá-lo liga os ganchos da casca em `web.ts` (`navegacao`, `cookieModulo`)
 * e registra o global `porta_de_entrada`.
 */
import { ESCOPO_PROPRIO, EscopoNaoDeclarado, type UsuarioAtual } from "./servicos/rbac.js";
import { PERMISSOES_VER as PERMISSOES_PENDENCIAS } from "./servicos/pendencias.js";
import { ganchos, global } from "./web.js";

export const PROCESSOS_SEI = "processos-sei";

// Qual módulo a pessoa estava usando quando saiu para a base. Vai em cookie
// porque a alternativa — `?de=epis` em cada link — obrigaria toda tela da base a
// propagar o parâmetro, e o menu lateral não teria o que propagar.
export const COOKIE_MODULO = "csso_modulo";

/**
 * Uma tela.
 *
 * `permissao` repete exatamente o que a rota exige — é o que impede o menu de
 * virar um catálogo de portas trancadas. Uma lista significa "qualquer uma
 * destas"; `null` significa que basta estar autenticado.
 */
export class Item {
  constructor(
    readonly rotulo: string,
    readonly caminho: string,
    readonly permissao: string | readonly string[] | null = null,
    readonly descricao: string = "",
    /**
     * Tela do titular ("minha ficha", "meus certificados"): só aparece para
     * conta vinculada a um servidor — sem vínculo ela abre sempre vazia, e a
     * conta de quem só administra ficava com três portas para o nada.
     */
    readonly do_titular: boolean = false,
  ) {
    Object.freeze(this);
  }

  visivel_para(usuario: UsuarioAtual | null | undefined): boolean {
    if (!usuario) return false;
    if (this.do_titular && usuario.servidor_id === null) return false;
    if (this.permissao === null) return true;
    const exigidas = typeof this.permissao === "string" ? [this.permissao] : this.permissao;
    return exigidas.some((p) => usuario.pode(p));
  }
}

export interface DadosModulo {
  codigo: string;
  nome: string;
  resumo: string;
  itens?: readonly Item[];
  /** telas do módulo que não viram item de menu (o editor do parecer) */
  prefixos_extras?: readonly string[];
  /** módulo previsto entra na lista desde já, marcado */
  disponivel?: boolean;
  itens_previstos?: readonly string[];
}

export class Modulo {
  readonly codigo: string;
  readonly nome: string;
  readonly resumo: string;
  readonly itens: readonly Item[];
  readonly prefixos_extras: readonly string[];
  readonly disponivel: boolean;
  readonly itens_previstos: readonly string[];

  constructor(d: DadosModulo) {
    this.codigo = d.codigo;
    this.nome = d.nome;
    this.resumo = d.resumo;
    this.itens = Object.freeze([...(d.itens ?? [])]);
    this.prefixos_extras = Object.freeze([...(d.prefixos_extras ?? [])]);
    this.disponivel = d.disponivel ?? true;
    this.itens_previstos = Object.freeze([...(d.itens_previstos ?? [])]);
    Object.freeze(this);
  }

  itens_de(usuario: UsuarioAtual | null | undefined): Item[] {
    return this.itens.filter((item) => item.visivel_para(usuario));
  }
}

export const MODULOS: readonly Modulo[] = [
  new Modulo({
    codigo: PROCESSOS_SEI,
    nome: "Processos SEI",
    resumo:
      "Do requerimento ao parecer técnico assinado: instrução do processo " +
      "de adicional ocupacional, laudo que o sustenta e o direito que " +
      "nasce dele.",
    itens: [
      new Item("Painel", "/", "processo.ver", "Indicadores e o que precisa de você hoje."),
      new Item("Kanban", "/kanban", "processo.ver", "Os processos por estado."),
      new Item(
        "Processos",
        "/processos",
        "processo.ver",
        "A lista completa, com o parecer técnico de cada um.",
      ),
      new Item(
        "Laudos",
        "/laudos",
        "laudo.ver",
        "Laudo técnico das condições ambientais — um laudo sustenta N pareceres.",
      ),
      new Item(
        "Adicionais",
        "/adicionais",
        "processo.ver",
        "O direito concedido: vigência, percentual e suspensão.",
      ),
      new Item("Relatórios", "/relatorios", "indicador.ver", "Extrações e conferências."),
      new Item(
        "Importar",
        "/importar",
        "catalogo.gerenciar",
        "Carga da planilha e do Trello, com reconciliação.",
      ),
    ],
    // `/pendencias` esteve aqui e saiu: a pendência deixou de ser só do
    // processo — reciclagem de treinamento já cai no mesmo sino, e EPI e
    // acidentes vão cair. Enquanto ela era prefixo extra deste módulo, a
    // trilha de /pendencias afirmava "Processos SEI", que é falso para a
    // tarefa de treinamento. Agora ela é item da base, logo abaixo.
    prefixos_extras: ["/pareceres"],
  }),
  new Modulo({
    codigo: "epis",
    nome: "Gestão de EPI",
    resumo:
      "Do catálogo à ficha assinada: CA e validade, entrada por pregão e " +
      "empenho, requisição analisada item a item, entrega registrada. A " +
      "ficha é prova legal de que o equipamento foi entregue.",
    itens: [
      new Item(
        "Painel",
        "/epis",
        // `epi.ver`, como a rota — e não `indicador.ver`, que é a de
        // `/epis/relatorios`. As duas telas medem coisas diferentes: esta
        // conta o trabalho parado do setor (pedido, falta, CA, entrega,
        // troca) e é a tela de quem opera; a outra recorta a população
        // por unidade e por categoria, que é onde a RN-19 morde.
        "epi.ver",
        "Requisições, falta de estoque, CA a vencer, entregas e trocas devidas.",
      ),
      // O caminho direto vem logo depois do painel: entregar no balcão não
      // exige pedido nem lote de estoque (sem lote, confere-se o CA do
      // catálogo). Requisição é para quando há o que analisar.
      new Item(
        "Entregar EPI",
        "/epis/entregas/nova",
        "epi.entregar",
        "O caminho direto: entrega no balcão, sem pedido e sem lote obrigatório; imprime o comprovante.",
      ),
      new Item(
        "Requisições",
        "/epis/requisicoes",
        // leitura para quem tem `epi.ver`, como o estoque: a fila mostra
        // protocolo, estado e prazo. Pedir e decidir é que pedem as suas.
        //
        // Este comentário afirmava que "a identificação de quem pediu já
        // sai pela RN-19", e isso era verdade sobre o NOME e falso sobre
        // o pedido: a fila listava os nove pedidos de nove pessoas, com
        // rotina de trabalho e riscos declarados, para qualquer conta com
        // `epi.ver`. Quem separa agora é o escopo — `servico.fila` recebe
        // o usuário e filtra por `servidor_id` —, e a RN-19 volta a ser o
        // que sempre foi: a regra de como o nome aparece, não de quantas
        // linhas saem.
        "epi.ver",
        "A fila dos pedidos: protocolo, prazo e decisão item a item.",
      ),
      new Item(
        "Nova requisição",
        "/epis/requisicoes/nova",
        // `epi.requisitar` e não `epi.ver`: é a permissão que a rota
        // exige, e é assim que `test_link_no_menu_sempre_abre` impede o
        // menu de oferecer porta trancada ao almoxarife e ao auditor,
        // que veem a fila e não abrem pedido.
        "epi.requisitar",
        "Pedido formal para análise do SESMT — opcional: a entrega direta não depende dele.",
      ),
      new Item(
        // A porta do titular para o que é dele. `epi.ver`, exatamente
        // como a rota `/epis/fichas/minha` exige — e NÃO `epi.ficha`,
        // que é a permissão de ler a ficha dos outros e some para o
        // servidor comum, como deve.
        //
        // Ela existe porque a regra "`epi.ficha` ou próprio" estava
        // construída e testada desde a fatia 2 e **não tinha caminho**:
        // o único href para a ficha própria saía de `/servidores`, com
        // `processo.ver` — permissão de outro módulo. Quem entrou no
        // sistema para pedir EPI tinha de deduzir que o histórico dele
        // mora dentro do cadastro da base compartilhada.
        "Minha ficha de EPI",
        "/epis/fichas/minha",
        "epi.ver",
        "O que você recebeu: CA e lote congelados, com o comprovante.",
        true,
      ),
      new Item(
        "Fichas de EPI",
        "/epis/fichas",
        "epi.ficha",
        "A prova de entrega, congelada no ato e com o comprovante assinado.",
      ),
      new Item(
        "Estoque",
        "/epis/estoque",
        // leitura para quem tem `epi.ver`, como o catálogo: saldo de bota
        // não nomeia ninguém. Escrever no razão é que pede `epi.estoque`.
        "epi.ver",
        "Lotes por pregão e empenho, saldo somado do livro razão.",
      ),
      new Item("Catálogo", "/epis/catalogo", "epi.ver", "Itens, categorias da NR-6 e motivos de recusa."),
      new Item(
        "Relatórios",
        "/epis/relatorios",
        // `indicador.ver`, como o §9 manda e como `/relatorios` já faz —
        // e NÃO `epi.ver`. Declarar aqui a permissão da outra tela do
        // módulo é exatamente o defeito que `test_link_no_menu_sempre_abre`
        // pegou na 1.6.0: o almoxarife veria o link e levaria 403.
        "indicador.ver",
        "Entregue por categoria da NR-6, custo por empenho e recusas por motivo.",
      ),
    ],
    // `itens_previstos` fica vazio com a fatia 7: as três telas que faltavam
    // existem. Reserva de lote entrou na fatia 5 (é ação dentro da ficha do
    // pedido, não tela própria), a consulta do parecer entrou na 6 (mora no
    // editor do parecer, onde ela é usada) e os indicadores são `/epis` e
    // `/epis/relatorios`. Módulo entregue por fatias declara o que falta; não
    // declarar o que já chegou é a outra metade da mesma honestidade.
  }),
  new Modulo({
    codigo: "certificados",
    nome: "Certificados e Treinamentos",
    resumo:
      "Treinamento obrigatório de SST do modelo à segunda via: turma, " +
      "inscrição, presença e nota, emissão do certificado e o controle de " +
      "reciclagem — quem venceu, quem vence, quem nunca fez.",
    itens: [
      // A porta de entrada de quem opera o módulo, como o hub do IntegraSST:
      // os passos do trabalho e o que está esperando em cada um. O servidor
      // comum não tem `certificado.ver` e continua entrando por `/turmas`.
      new Item("Início", "/treinamentos", "certificado.ver", "Os passos do trabalho e o que espera por você em cada um."),
      new Item("Turmas", "/turmas", "treinamento.ver", "Da abertura das inscrições ao fecho da turma."),
      new Item(
        "Pedidos pelo link",
        "/turmas/pedidos",
        "turma.inscrever",
        "Quem se inscreveu pelo link público e espera a conferência, de todas as turmas.",
      ),
      new Item(
        // `treinamento.ver`, exatamente como a rota `/turmas/minhas`
        // exige — e NÃO `turma.inscrever_se`: a tela responde "o que é
        // meu" antes de responder "o que posso pedir", e quem não tem a
        // permissão de pedir continua tendo o que ver nela. Declarar
        // aqui a permissão do BOTÃO faria o menu esconder uma tela que
        // abre, que é a mentira na outra direção.
        //
        // A porta do servidor para o treinamento. `/turmas` é a lista do
        // setor; até esta fatia ela abria 200 e vinha SEMPRE VAZIA para
        // quem tem escopo próprio, afirmando "nenhuma turma aberta
        // ainda" com uma turma de vinte vagas na frente — e o único item
        // de treinamento que ele via era esse.
        "Meus treinamentos",
        "/turmas/minhas",
        "treinamento.ver",
        "As turmas com inscrição aberta, e as suas inscrições.",
        true,
      ),
      new Item(
        // `treinamento.ver`, como a rota `/certificados/meus` — e não
        // `certificado.ver`, que é a permissão de ler o certificado DE
        // OUTRO e que o servidor comum não tem por desenho. O item existe
        // porque `Certificado.servidor_id` foi denormalizado exatamente
        // para o escopo próprio e nunca teve porta: a fechadura estava
        // instalada e a chave nunca foi entregue.
        "Meus certificados",
        "/certificados/meus",
        "treinamento.ver",
        "O que foi emitido em seu nome, com a segunda via do congelado.",
        true,
      ),
      new Item(
        "Certificados",
        "/certificados",
        "certificado.ver",
        "Emitidos, com segunda via a partir do congelado.",
      ),
      new Item(
        "Fila de emissão",
        "/certificados/fila",
        "certificado.ver",
        "Aprovados sem certificado, travados e emitidos, de todas as turmas.",
      ),
      new Item(
        "E-mails",
        "/certificados/emails",
        "certificado.emitir",
        "Certificados e avisos enviados por e-mail: na fila, enviados e com falha.",
      ),
      new Item(
        "Reciclagem",
        "/certificados/vencimentos",
        "certificado.ver",
        "Quem tem certificado vencido ou a vencer em 30 dias.",
      ),
      new Item(
        "Indicadores",
        "/treinamentos/indicadores",
        "indicador.ver",
        "Turmas, participantes e emissão por período e setor promotor.",
      ),
      new Item(
        "Catálogo",
        "/treinamentos/catalogo",
        "treinamento.ver",
        "Treinamentos, carga horária e a validade da reciclagem.",
      ),
      new Item(
        "Modelos",
        "/treinamentos/modelos",
        "treinamento.gerenciar",
        "O .docx do certificado e o dicionário de tags.",
      ),
      new Item(
        "Instrutores",
        "/treinamentos/assinaturas",
        "assinatura.gerenciar",
        "Quem assina o certificado: nome, título e rubrica.",
      ),
      new Item(
        "Participantes",
        "/treinamentos/participantes",
        "participante.mesclar",
        "Cadastros que parecem a mesma pessoa, para juntar.",
      ),
    ],
    // o módulo já está em uso, mas entregue por fatias: o que falta continua
    // declarado, pelo mesmo motivo que módulo previsto aparece na lista —
    // quem usa o sistema precisa saber o que ainda não está aqui
    // A validação pública por chave saiu desta lista porque **existe**:
    // `/validar/{chave}` responde, sem sessão e sem expor o nome de quem se
    // formou. Declarar o que ainda falta é metade da honestidade; a outra
    // metade é não continuar declarando o que já chegou — e esta linha, em
    // particular, era a mais cara de manter: o endereço já saía impresso em
    // todo certificado emitido, e a lista dizia que ele não existia.
    // A inscrição pública por link saiu também (a CSSO confere cada pedido,
    // `servicos/inscricao_publica.ts`), o envio por e-mail (`servicos/email.ts`)
    // e o acesso do participante sem conta (`servicos/acesso_participante.ts`):
    // o módulo não tem mais fatia declarada por fazer.
    itens_previstos: [],
  }),
  new Modulo({
    codigo: "acidentes",
    nome: "Análise de Acidentes",
    resumo:
      "Acidente em serviço pela Lei 8.112, arts. 212-214: comunicação em " +
      "10 dias, investigação técnica que instrui a perícia do SIASS, e a " +
      "memória que hoje não existe — série histórica, taxa de frequência " +
      "e de gravidade.",
    disponivel: false,
    itens_previstos: [
      "Registro da ocorrência com espécie: típico, trajeto ou doença do trabalho",
      "Investigação técnica com medições e evidências",
      "Revisão adversarial antes do laudo: a conclusão tem de sobreviver à objeção",
      "CAT/SP instruída — o nexo causal quem estabelece é a perícia oficial",
      "Indicadores por unidade, posto e fator; cruzamento com a ficha de EPI",
    ],
  }),
  new Modulo({
    codigo: "cissp",
    nome: "CISSP",
    resumo:
      "Comissão Interna de Saúde e Segurança do Servidor Público: " +
      "composição, mandato, reuniões e o que ficou deliberado.",
    disponivel: false,
    itens_previstos: [
      "Composição e mandato dos membros",
      "Pauta, ata e deliberação de cada reunião",
      "Acompanhamento das recomendações até o fecho",
    ],
  }),
  new Modulo({
    codigo: "pgr",
    nome: "PGR",
    resumo:
      "Programa de Gerenciamento de Riscos: inventário de riscos por " +
      "posto e plano de ação com prazo e responsável.",
    disponivel: false,
    itens_previstos: [
      "Inventário de riscos por posto de trabalho",
      "Avaliação de severidade e probabilidade",
      "Plano de ação com prazo, responsável e evidência",
      "Reaproveitamento do que o laudo técnico já mediu",
    ],
  }),
];

// Não é módulo: é o chão que todo módulo pisa. Servidor, unidade, cargo e posto
// são os mesmos para o adicional, para o EPI e para o treinamento — e a fila de
// pendências também: a tarefa nasce da regra de um módulo, mas o sino é um só.
export const BASE: readonly Item[] = [
  new Item(
    "Pendências",
    "/pendencias",
    // A MESMA tupla da rota, importada e não copiada. Era uma cópia
    // (`processo.ver`, `treinamento.ver`, `epi.ver`) e já tinha divergido:
    // a rota aceitava `demanda.ver` e o menu não — só não doía porque nenhum
    // perfil tem `demanda.ver` sozinha. Uma tupla porque a leitura é
    // explícita e cresce com cada módulo: quem opera treinamento recebe
    // tarefa de reciclagem e precisa vê-la sem ter `processo.ver`.
    PERMISSOES_PENDENCIAS,
    "Tarefas abertas por regra, com dono e prazo — de todos os módulos.",
  ),
  new Item(
    "Demandas",
    "/demandas",
    // `demanda.ver`, idêntica ao que a rota exige. Uma permissão só, e não
    // tupla: a fila é do setor inteiro — "demanda que só uma pessoa vê some
    // quando ela entra de férias" —, e quem registra também vê.
    "demanda.ver",
    "O que chegou por e-mail ou no balcão e ainda não é processo SEI.",
  ),
  new Item(
    "Servidores",
    "/servidores",
    "processo.ver",
    "Cadastro e histórico datado de lotação, posto e cargo.",
  ),
  new Item(
    "Catálogos",
    "/catalogos",
    // a rota abre para quem so consulta; editar e que pede catalogo.gerenciar
    "processo.ver",
    "Campi, unidades, postos, cargos, agentes nocivos e textos padrão.",
  ),
  new Item("Auditoria", "/auditoria", "auditoria.ver", "Trilha append-only encadeada por hash."),
  new Item(
    "Usuários",
    "/usuarios",
    ["usuario.criar_conta", "perfil.conceder"],
    "Contas, perfis e permissões.",
  ),
];

/**
 * O MENU DE QUEM SÓ TEM O PRÓPRIO: "Meu espaço".
 *
 * O servidor comum (`servidor_consulta`, escopo próprio) via a lateral da
 * equipe: quinze entradas — Kanban, a lista de Processos, Catálogos,
 * Servidores, Estoque, Módulos — que ou abriam vazias (o escopo filtra tudo o
 * que não é dele) ou mostravam o cadastro interno do setor, com uma lista que
 * só tinha ele. Nenhuma era porta trancada, e é por isso que o teste do menu
 * nunca reclamou: eram portas para salas vazias.
 *
 * Aqui ele ganha um bloco só, com o que é dele, no vocabulário dele. O RBAC
 * NÃO muda: cada item declara a mesma permissão que a rota exige (a mesma do
 * item da equipe que aponta para o mesmo caminho), e `visivel_para` continua
 * sendo o filtro. Quem digitar `/kanban` continua abrindo o que abria — o que
 * mudou foi só o que o menu oferece.
 *
 * A lista de `/processos` volta aqui como "Meus processos": o escopo já a
 * recorta para os dele, e o que a deixava incompreensível era o nome e a
 * vizinhança (Kanban, Laudos, Relatórios), não o conteúdo.
 *
 * Os itens da equipe que apontam para os mesmos caminhos ("Requisições",
 * "Nova requisição") não foram renomeados: os textos das telas de EPI e de
 * treinamento estão alinhados ao menu da equipe, e este bloco é a outra porta.
 */
export const MEU_ESPACO: readonly Item[] = [
  new Item("Início", "/", "processo.ver", "O que é seu no sistema, num relance."),
  new Item("Meus treinamentos", "/turmas/minhas", "treinamento.ver", "As turmas com inscrição aberta, e as suas inscrições.", true),
  new Item("Meus certificados", "/certificados/meus", "treinamento.ver", "O que foi emitido em seu nome.", true),
  new Item("Minha ficha de EPI", "/epis/fichas/minha", "epi.ver", "O que você recebeu, com o comprovante.", true),
  new Item("Meus pedidos de EPI", "/epis/requisicoes", "epi.ver", "Os seus pedidos e em que pé estão.", true),
  new Item("Pedir EPI", "/epis/requisicoes/nova", "epi.requisitar", "Pedido para análise do SESMT.", true),
  new Item("Meu adicional", "/adicionais", "processo.ver", "O adicional ocupacional concedido a você.", true),
  // O pedido de adicional em andamento. O "Início" dele já tem o cartão "Meus
  // processos" com o link para cá; sem o item, a ficha do processo abria com a
  // trilha "Meu espaço / Processos", o nome de um item que este menu não tem.
  new Item("Meus processos", "/processos", "processo.ver", "Os seus pedidos de adicional e em que pé estão.", true),
];

/**
 * Quem recebe o "Meu espaço" no lugar da lateral da equipe: quem só alcança o
 * que é seu — `escopo` próprio, que é o que sai quando TODOS os perfis da
 * conta são de escopo próprio (um perfil de equipe a mais e a conta volta ao
 * menu de sempre, porque passa a ver o do setor).
 */
export function so_o_proprio(usuario: UsuarioAtual | null | undefined): boolean {
  if (!usuario) return false;
  try {
    return usuario.escopo === ESCOPO_PROPRIO;
  } catch (erro) {
    // Perfil sem escopo declarado: o menu não é a barreira (cada rota confere a
    // permissão, e a consulta no escopo nega com a tela que nomeia o perfil).
    // Deixar a exceção subir derrubava a casca inteira, inclusive essa tela.
    if (erro instanceof EscopoNaoDeclarado) return false;
    throw erro;
  }
}

/**
 * Os itens do "Meu espaço" que abrem para esta pessoa, e o "Meus dados", que
 * não cabe na lista fixa porque o caminho é o do PRÓPRIO cadastro — a ficha
 * do servidor, que a rota de `/servidores/{id}` já recorta pelo escopo.
 */
export function meu_espaco_de(usuario: UsuarioAtual | null | undefined): Item[] {
  if (!so_o_proprio(usuario)) return [];
  const itens = MEU_ESPACO.filter((item) => item.visivel_para(usuario));
  if (usuario!.servidor_id !== null) {
    const meus_dados = new Item(
      "Meus dados",
      `/servidores/${usuario!.servidor_id}`,
      "processo.ver",
      "Seu cadastro: lotação, cargo e posto.",
      true,
    );
    if (meus_dados.visivel_para(usuario)) itens.push(meus_dados);
  }
  return itens;
}

/**
 * O item do "Meu espaço" a que o caminho pertence, pelo prefixo mais longo.
 *
 * `/epis/fichas/minha` redireciona para `/epis/fichas/{servidor_id}`: a ficha
 * que abre é a mesma "Minha ficha de EPI", e a trilha e o destaque dizem isso
 * — e não "Fichas", o item da equipe que este menu não tem.
 */
function _item_do_meu_espaco(caminho: string, itens: readonly Item[], usuario: UsuarioAtual): Item | null {
  if (usuario.servidor_id !== null && caminho === `/epis/fichas/${usuario.servidor_id}`) caminho = "/epis/fichas/minha";
  let melhor: Item | null = null;
  for (const item of itens) {
    const alvo = item.caminho;
    const casa = alvo === "/" ? caminho === "/" : caminho === alvo || caminho.startsWith(alvo + "/");
    if (casa && (melhor === null || alvo.length > melhor.caminho.length)) melhor = item;
  }
  return melhor;
}

export function por_codigo(codigo: string): Modulo | null {
  return MODULOS.find((m) => m.codigo === codigo) ?? null;
}

/**
 * Qual módulo a URL atual pertence — é o que fica destacado no menu.
 * Casa pelo prefixo mais longo para que `/processos/12/parecer` continue
 * dentro de Processos SEI.
 */
export function modulo_ativo(caminho: string): Modulo | null {
  let melhor: [number, Modulo] | null = null;
  for (const modulo of MODULOS) {
    const caminhos = [...modulo.itens.map((i) => i.caminho), ...modulo.prefixos_extras];
    for (const alvo of caminhos) {
      if (alvo === "/") {
        if (caminho === "/" && melhor === null) melhor = [1, modulo];
        continue;
      }
      if (caminho === alvo || caminho.startsWith(alvo + "/")) {
        if (melhor === null || alvo.length > melhor[0]) melhor = [alvo.length, modulo];
      }
    }
  }
  return melhor ? melhor[1] : null;
}

export function base_de(usuario: UsuarioAtual | null | undefined): Item[] {
  return BASE.filter((item) => item.visivel_para(usuario));
}

/**
 * Qual item de menu a URL atual pertence: o destaque da lateral e o segundo
 * nível da trilha. Procura na base também.
 */
export function item_ativo(caminho: string): Item | null {
  let melhor: [number, Item] | null = null;
  for (const item of [...MODULOS.flatMap((m) => m.itens), ...BASE]) {
    const alvo = item.caminho;
    if (alvo === "/") {
      // "/" casa com tudo por prefixo: só vale na igualdade exata
      if (caminho === "/" && melhor === null) melhor = [1, item];
      continue;
    }
    if (caminho === alvo || caminho.startsWith(alvo + "/")) {
      if (melhor === null || alvo.length > melhor[0]) melhor = [alvo.length, item];
    }
  }
  return melhor ? melhor[1] : null;
}

/**
 * Por onde se entra num módulo — a primeira tela que abre para esta pessoa.
 * Sem nenhuma tela visível o destino é o mapa, que explica que a ausência é de
 * permissão.
 */
export function porta_de_entrada(modulo: Modulo, usuario: UsuarioAtual | null | undefined): string {
  const itens = modulo.itens_de(usuario);
  return itens.length ? itens[0]!.caminho : `/modulos#${modulo.codigo}`;
}

/**
 * A primeira tela que abre para esta pessoa, em todo o sistema: o destino de
 * `/inicio`. A ordem é a da lateral (módulos, depois base); sobra `/modulos`,
 * que não exige permissão nenhuma.
 */
export function primeira_tela(usuario: UsuarioAtual | null | undefined): string {
  for (const modulo of MODULOS) {
    if (!modulo.disponivel) continue;
    const itens = modulo.itens_de(usuario);
    if (itens.length) return itens[0]!.caminho;
  }
  const base = base_de(usuario);
  return base.length ? base[0]!.caminho : "/modulos";
}

/** Fora dos módulos, qual menu a lateral mostra quando não há de onde vir. */
function _modulo_de_recuo(usuario: UsuarioAtual | null | undefined): Modulo | null {
  for (const modulo of MODULOS) {
    if (modulo.disponivel && modulo.itens_de(usuario).length) return modulo;
  }
  return null;
}

export interface Navegacao extends Record<string, unknown> {
  modulos: readonly Modulo[];
  modulo_ativo: Modulo | null;
  itens_modulo: Item[];
  itens_base: Item[];
  item_ativo: Item | null;
  no_modulo: boolean;
  modulo_a_lembrar: string | null;
  /** vazio para a equipe; para quem só tem o próprio, o menu inteiro */
  meu_espaco: Item[];
}

/**
 * O que o cabeçalho precisa saber: módulo atual, seus itens e a base.
 *
 * Em tela de módulo, o módulo é o do caminho. Fora dele (a base), a lateral
 * mantém o menu do módulo de ORIGEM (cookie), e quem diz que a pessoa está na
 * base é a trilha e o destaque do bloco de baixo.
 */
export function navegacao(
  caminho: string,
  usuario: UsuarioAtual | null | undefined,
  origem: string | null = null,
): Navegacao {
  const do_caminho = modulo_ativo(caminho);
  let ativo = do_caminho !== null && do_caminho.disponivel ? do_caminho : null;
  if (ativo === null) {
    const lembrado = origem ? por_codigo(origem) : null;
    if (lembrado !== null && lembrado.disponivel && lembrado.itens_de(usuario).length) {
      ativo = lembrado;
    } else {
      ativo = _modulo_de_recuo(usuario);
    }
  }
  const meu_espaco = meu_espaco_de(usuario);
  // No "Meu espaço" a trilha e o destaque falam a língua do menu que a pessoa
  // vê ("Meus pedidos de EPI", e não "Requisições"); fora dele, o de sempre.
  const item = (meu_espaco.length ? _item_do_meu_espaco(caminho, meu_espaco, usuario!) : null) ?? item_ativo(caminho);
  const no_modulo = do_caminho !== null && do_caminho.disponivel;
  return {
    modulos: MODULOS,
    modulo_ativo: ativo,
    itens_modulo: ativo ? ativo.itens_de(usuario) : [],
    itens_base: base_de(usuario),
    // a trilha não pode oferecer porta trancada, pela mesma razão do menu
    item_ativo: item !== null && item.visivel_para(usuario) ? item : null,
    no_modulo,
    // só caminho de módulo lembra; a base não reescreve de onde a pessoa veio
    modulo_a_lembrar: no_modulo ? do_caminho!.codigo : null,
    meu_espaco,
  };
}

/**
 * O ícone de cada tela e de cada módulo na lateral (Bootstrap Icons, os do
 * IntegraSST; a folha é `public/estaticos/img/icones.svg`). Fica fora de
 * `Item` porque é desenho, não regra: a tela sem ícone aqui só fica sem ícone.
 */
const ICONES: Readonly<Record<string, string>> = {
  [PROCESSOS_SEI]: "folder2-open",
  epis: "shield-plus",
  certificados: "award",
  acidentes: "heart-pulse",
  cissp: "people",
  pgr: "clipboard-data",
  "/": "grid-1x2",
  "/kanban": "kanban",
  "/processos": "file-earmark-text",
  "/laudos": "clipboard-data",
  "/adicionais": "cash-coin",
  "/relatorios": "bar-chart",
  "/importar": "cloud-upload",
  "/epis": "grid-1x2",
  "/epis/entregas/nova": "box-seam",
  "/epis/requisicoes": "inbox",
  "/epis/requisicoes/nova": "journal-plus",
  "/epis/fichas/minha": "person-vcard",
  "/epis/fichas": "person-vcard",
  "/epis/estoque": "boxes",
  "/epis/catalogo": "tags",
  "/epis/relatorios": "bar-chart",
  "/treinamentos": "grid-1x2",
  "/turmas": "collection",
  "/turmas/minhas": "mortarboard",
  "/turmas/pedidos": "person-check",
  "/certificados/meus": "patch-check",
  "/certificados": "file-earmark-check",
  "/certificados/fila": "printer",
  "/certificados/emails": "envelope",
  "/certificados/vencimentos": "shield-exclamation",
  "/treinamentos/indicadores": "bar-chart",
  "/treinamentos/catalogo": "journal-bookmark",
  "/treinamentos/modelos": "file-earmark-easel",
  "/treinamentos/assinaturas": "pen",
  "/treinamentos/participantes": "people",
  "/pendencias": "bell",
  "/demandas": "list-check",
  "/servidores": "person-badge",
  "/catalogos": "list-ul",
  "/auditoria": "clock-history",
  "/usuarios": "gear",
  // os do "Meu espaço" que não repetem o da equipe
  "Início": "house",
  "Meus pedidos de EPI": "inbox",
  "Meu adicional": "cash-coin",
  "Meus dados": "person",
  "Meus processos": "file-earmark-text",
};

export function icone_de(chave: string): string | null {
  return ICONES[chave] ?? null;
}

// ---------------------------------------------------------------------
// Ligação com a casca (`web.ts`): o que no Python era `web.py` importando
// `modulos` diretamente. Aqui o sentido é o inverso para não haver ciclo.
// ---------------------------------------------------------------------
ganchos.navegacao = (caminho, usuario, origem) => navegacao(caminho, usuario, origem);
ganchos.cookieModulo = COOKIE_MODULO;
// O seletor da lateral precisa saber por onde se entra em cada módulo; a
// decisão tem de ser a mesma que `/inicio` toma.
global("porta_de_entrada", porta_de_entrada);
global("icone_de", icone_de);
