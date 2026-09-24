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
import type { UsuarioAtual } from "./servicos/rbac.js";
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
  ) {
    Object.freeze(this);
  }

  visivel_para(usuario: UsuarioAtual | null | undefined): boolean {
    if (!usuario) return false;
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
        "Abre o pedido formal, com contexto congelado no envio.",
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
      ),
      new Item(
        "Fichas de EPI",
        "/epis/fichas",
        "epi.ficha",
        "A prova de entrega, congelada no ato e com o comprovante assinado.",
      ),
      new Item(
        "Entregar EPI",
        "/epis/entregas/nova",
        "epi.entregar",
        "Registra a entrega no balcão e imprime o comprovante para assinar.",
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
      new Item("Turmas", "/turmas", "treinamento.ver", "Da abertura das inscrições ao fecho da turma."),
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
      ),
      new Item(
        "Certificados",
        "/certificados",
        "certificado.ver",
        "Emitidos, com segunda via a partir do congelado.",
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
        "Assinaturas",
        "/treinamentos/assinaturas",
        "assinatura.gerenciar",
        "Instrutores, títulos e rubricas.",
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
    itens_previstos: [
      "Inscrição pública por link, com e-mail confirmado",
      "Monitor de vencimento por servidor e por unidade",
    ],
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
    // Espelha `pendencias.PERMISSOES_VER`. Uma tupla porque a lista de
    // leitura é explícita e cresce com cada módulo: quem opera treinamento
    // recebe tarefa de reciclagem e precisa vê-la sem ter `processo.ver`.
    // Módulo novo acrescenta a sua permissão nos dois lugares, e
    // `test_link_no_menu_sempre_abre` cobra que os dois digam o mesmo.
    ["processo.ver", "treinamento.ver", "epi.ver"],
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
  const item = item_ativo(caminho);
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
  };
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
