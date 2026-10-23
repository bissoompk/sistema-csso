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
import { acidentesLiberado } from "./config.js";
import { EscopoNaoDeclarado, PERFIS_EXTERNOS, type UsuarioAtual } from "./servicos/rbac.js";
import { PERMISSOES_VER as PERMISSOES_PENDENCIAS } from "./servicos/pendencias.js";
import { tem_acesso_ao_modulo } from "./servicos/acesso_modulo.js";
import { PERMISSAO_DA_BASE } from "./servicos/niveis_modulo.js";
import { ganchos, global } from "./web.js";
import { eq } from "drizzle-orm";
import type { Executor } from "./db/cliente.js";
import {
  campus as tabela_campus,
  servidor as tabela_servidor,
  unidade_uorg as tabela_unidade,
} from "./db/esquema/index.js";

export const PROCESSOS_SEI = "processos-sei";

// A regra única de "tem acesso ao módulo" (`servicos/acesso_modulo.ts`), daqui
// também: o menu, o mapa, o `/inicio` e a home por módulos perguntam a ela.
export { tem_acesso_ao_modulo } from "./servicos/acesso_modulo.js";

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
     * conta que TEM titular (`tem_titular`) — a ligada a um servidor, ou a do
     * terceirizado e do discente, que são o próprio titular sem cadastro de
     * servidor. Sem titular ela abre sempre vazia, e a conta de quem só
     * administra ficava com três portas para o nada.
     */
    readonly do_titular: boolean = false,
    /**
     * Permissões exigidas ALÉM de uma das de `permissao` (todas estas). É o
     * relatório de um módulo: `indicador.ver` é transversal e vem do perfil,
     * e o relatório só abre para quem também tem acesso ao módulo — "sem
     * acesso" a Processos SEI fecha /relatorios (liberação por módulo,
     * 22/10/2026). A rota exige as mesmas.
     */
    readonly tambem: readonly string[] = [],
    /**
     * Condição "titular" (Portal do servidor, 22/10/2026): abre para toda conta
     * ligada a um servidor (`usuario.servidor_id !== null`), SEM permissão de
     * catálogo — o "Início", a "Minha atividade" e o "Meu perfil" são da pessoa,
     * e não de um módulo. Sem vínculo, vale a `permissao` declarada (quando
     * houver); sem vínculo e sem permissão, o item não aparece.
     */
    readonly titular: boolean = false,
    /**
     * A tela do titular que mora no cadastro de SERVIDOR (a ficha de EPI, o
     * adicional, o comprovante com lotação): o terceirizado e o discente não a
     * veem, ainda que tenham a permissão que ela declara.
     */
    readonly exige_servidor: boolean = false,
  ) {
    Object.freeze(this);
  }

  /**
   * A tela da equipe só aparece para quem tem a permissão por um PERFIL de
   * equipe (`pode_na_equipe`). Desde as funções do titular (D16), toda conta
   * ligada a servidor tem `processo.ver`, `treinamento.ver` e `epi.ver` em
   * escopo próprio, e "tem a permissão" deixou de querer dizer "trabalha no
   * módulo": o almoxarife e o `admin_ti` ligados a servidor viam Kanban,
   * Catálogos e Turmas, que abriam vazios ou davam 403 (`exigir_na_equipe`).
   * A tela do titular continua pedindo só a permissão — é a dele.
   */
  visivel_para(usuario: UsuarioAtual | null | undefined): boolean {
    if (!usuario) return false;
    if (this.titular) {
      if (usuario.servidor_id !== null) return true;
      if (this.permissao === null) return false;
    }
    if (this.do_titular && !tem_titular(usuario)) return false;
    if (this.exige_servidor && usuario.servidor_id === null) return false;
    if (this.permissao === null) return true;
    const abre = (p: string) => usuario.pode(p) && (this.do_titular || _na_equipe(usuario, p));
    return this.exigidas.some(abre) && this.tambem.every(abre);
  }

  /** A lista de "qualquer uma destas", também quando a declaração é uma só. */
  get exigidas(): readonly string[] {
    if (this.permissao === null) return [];
    return typeof this.permissao === "string" ? [this.permissao] : this.permissao;
  }
}

/**
 * A conta é de um TITULAR: ligada a um servidor, ou de um perfil externo
 * (`PERFIS_EXTERNOS`: terceirizado e discente). A conta externa nunca tem
 * `servidor_id`, mas é dela o que comunicou e aquilo em que se inscreveu — as
 * telas do titular abrem para ela (o que ela não tem, EPI e processo, some pela
 * permissão, e o que só existe no cadastro de servidor, por `exige_servidor`).
 */
export function tem_titular(usuario: UsuarioAtual | null | undefined): boolean {
  if (!usuario) return false;
  return usuario.servidor_id !== null || e_externo(usuario);
}

/** A conta tem um perfil externo (terceirizado ou discente). */
export function e_externo(usuario: UsuarioAtual | null | undefined): boolean {
  return !!usuario && usuario.perfis.some((p) => PERFIS_EXTERNOS.includes(p));
}

/**
 * `pode_na_equipe` sem derrubar a casca: perfil sem escopo declarado conta
 * como equipe, porque o menu não é a barreira — cada rota confere a permissão,
 * e a consulta no escopo nega com a tela que nomeia o perfil.
 */
function _na_equipe(usuario: UsuarioAtual, permissao: string): boolean {
  try {
    return usuario.pode_na_equipe(permissao);
  } catch (erro) {
    if (erro instanceof EscopoNaoDeclarado) return true;
    throw erro;
  }
}

/**
 * Um bloco do menu do módulo, com o subtítulo que dá o contexto dos rótulos.
 *
 * O grupo é declarado no módulo, e não em cada item, para que `Item` continue
 * com o construtor de sempre (BASE, MEU_ESPACO e o celular o usam). `titulo`
 * `null` é o bloco sem subtítulo: o "Início" do topo, ou o módulo inteiro
 * quando ele não se divide.
 */
export interface GrupoMenu {
  readonly titulo: string | null;
  readonly itens: readonly Item[];
}

export interface DadosModulo {
  codigo: string;
  nome: string;
  resumo: string;
  /** ou `itens` (um bloco só, sem subtítulo) ou `grupos` — os dois juntos é erro */
  itens?: readonly Item[];
  grupos?: readonly GrupoMenu[];
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
  readonly grupos: readonly GrupoMenu[];
  /**
   * A lista plana, derivada dos grupos e na mesma ordem. Continua existindo
   * porque é ela que decide a porta de entrada, o destaque e a trilha — o
   * grupo é só desenho da lateral, não muda por onde se entra.
   */
  readonly itens: readonly Item[];
  readonly prefixos_extras: readonly string[];
  readonly disponivel: boolean;
  readonly itens_previstos: readonly string[];

  constructor(d: DadosModulo) {
    // Os dois juntos dariam duas fontes para a mesma lista, e uma delas seria
    // ignorada em silêncio.
    if (d.grupos && d.itens) throw new Error(`módulo ${d.codigo}: declare grupos ou itens, não os dois`);
    this.codigo = d.codigo;
    this.nome = d.nome;
    this.resumo = d.resumo;
    this.grupos = Object.freeze(
      (d.grupos ?? [{ titulo: null, itens: d.itens ?? [] }]).map((g) =>
        Object.freeze({ titulo: g.titulo, itens: Object.freeze([...g.itens]) }),
      ),
    );
    this.itens = Object.freeze(this.grupos.flatMap((g) => g.itens));
    this.prefixos_extras = Object.freeze([...(d.prefixos_extras ?? [])]);
    this.disponivel = d.disponivel ?? true;
    this.itens_previstos = Object.freeze([...(d.itens_previstos ?? [])]);
    Object.freeze(this);
  }

  itens_de(usuario: UsuarioAtual | null | undefined): Item[] {
    const abre = this.#filtro(usuario);
    return this.itens.filter(abre);
  }

  /**
   * O filtro dos itens desta pessoa: a permissão do item (`visivel_para`) e,
   * para a tela da EQUIPE, o acesso ao módulo (`tem_acesso_ao_modulo`) — é o
   * que faz "Sem acesso" esconder o módulo inteiro, também quando sobra uma
   * permissão transversal que abria um item dele ("Instrutores" pela
   * `assinatura.gerenciar`, "Importar" pela `catalogo.gerenciar`; 23/10/2026).
   * A tela do titular não pede acesso ao módulo (é dele), e sai daqui quando o
   * "Meu espaço" está ao lado da lateral.
   */
  #filtro(usuario: UsuarioAtual | null | undefined): (item: Item) => boolean {
    const ao_lado = _meu_espaco_ao_lado(usuario);
    const acesso = tem_acesso_ao_modulo(usuario, this.codigo);
    return (item) => {
      if (!item.visivel_para(usuario)) return false;
      return item.do_titular ? !ao_lado : acesso;
    };
  }

  /** A tela da equipe deste módulo abre para esta pessoa (sem olhar o "Meu espaço"). */
  abre_na_equipe(item: Item, usuario: UsuarioAtual | null | undefined): boolean {
    return !item.do_titular && item.visivel_para(usuario) && tem_acesso_ao_modulo(usuario, this.codigo);
  }

  /**
   * Os grupos com o que abre para esta pessoa. Grupo que fica vazio some — o
   * subtítulo sem nada embaixo seria uma porta para o nada. Se sobra um grupo
   * só, ele perde o subtítulo: para quem só tem `indicador.ver` (o admin de
   * TI, até 22/10/2026), o "Acompanhamento" em cima de um item só não explica
   * nada.
   */
  grupos_de(usuario: UsuarioAtual | null | undefined): GrupoMenu[] {
    // A tela do titular sai daqui quando o bloco "Meu espaço" está ao lado da
    // lateral: o mesmo "Meus treinamentos" em dois lugares, um deles só quando
    // o módulo de certificados está aberto, não diz onde ele mora.
    const abre = this.#filtro(usuario);
    const grupos = this.grupos
      .map((g) => ({
        titulo: g.titulo,
        itens: g.itens.filter(abre),
      }))
      .filter((g) => g.itens.length > 0);
    if (grupos.length === 1) grupos[0] = { titulo: null, itens: grupos[0]!.itens };
    return grupos;
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
      new Item("Relatórios", "/relatorios", "indicador.ver", "Extrações e conferências.", false, ["processo.ver"]),
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
        [],
        false,
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
        false,
        ["epi.ver"],
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
    // Quinze telas numa coluna só eram uma lista que se lia de cima a baixo
    // procurando o rótulo. Em grupos, o subtítulo dá o contexto e o rótulo
    // fica curto: a lateral tem 252px e acima de uns 19 caracteres ele quebra.
    // O primeiro item visível de cada perfil é o mesmo da lista antiga
    // (Início, Turmas ou Indicadores), então a porta de entrada não mudou.
    grupos: [
      {
        titulo: null,
        itens: [
          // A porta de entrada de quem opera o módulo, como o hub do IntegraSST:
          // os passos do trabalho e o que está esperando em cada um. O servidor
          // comum não tem `certificado.ver` e continua entrando por `/turmas`.
          new Item("Início", "/treinamentos", "certificado.ver", "Os passos do trabalho e o que espera por você em cada um."),
        ],
      },
      {
        titulo: "Turmas e inscrições",
        itens: [
          new Item("Turmas", "/turmas", "treinamento.ver", "Da abertura das inscrições ao fecho da turma."),
          // "Pedidos pelo link" e não "Inscrições a conferir": é o termo do hub,
          // da ficha da turma e do <h1>, e o subtítulo já diz que é inscrição.
          new Item(
            "Pedidos pelo link",
            "/turmas/pedidos",
            "turma.inscrever",
            "Quem se inscreveu pelo link público e espera a conferência, de todas as turmas.",
          ),
        ],
      },
      {
        titulo: "Certificados",
        itens: [
          // "Fila de emissão" e não "Emitir certificados": a PROGEP e o auditor
          // veem a fila e não emitem, e o rótulo prometeria uma ação que não têm.
          new Item(
            "Fila de emissão",
            "/certificados/fila",
            "certificado.ver",
            "Aprovados sem certificado e travados, de todas as turmas: emitir e enviar.",
          ),
          // Era "Certificados": repetia o nome do módulo e ficava ao lado de
          // "Meus certificados". "Emitidos" faz par com a fila logo acima.
          new Item(
            "Emitidos",
            "/certificados",
            "certificado.ver",
            "Certificados já emitidos: busca, segunda via, correção e anulação.",
          ),
          // Era "E-mails", que parecia caixa de entrada; a tela mostra o que saiu.
          new Item(
            "Envios por e-mail",
            "/certificados/emails",
            "certificado.emitir",
            "O que saiu por e-mail: na fila, enviados e com falha.",
          ),
        ],
      },
      {
        titulo: "Acompanhamento",
        itens: [
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
            false,
            ["treinamento.ver"],
          ),
        ],
      },
      {
        titulo: "Cadastros",
        itens: [
          // Era "Catálogo", a poucas linhas de "Catálogos" (da base) e do
          // "Catálogo" da Gestão de EPI. Sob "Cadastros", "Treinamentos" diz
          // o que se cadastra.
          new Item(
            "Treinamentos",
            "/treinamentos/catalogo",
            "treinamento.ver",
            "Catálogo de treinamentos: carga horária e validade da reciclagem.",
          ),
          new Item(
            "Modelos",
            "/treinamentos/modelos",
            "treinamento.gerenciar",
            "Modelos de certificado: o .docx e o dicionário de tags.",
          ),
          new Item(
            "Instrutores",
            "/treinamentos/assinaturas",
            "assinatura.gerenciar",
            "Quem assina o certificado: nome, título e rubrica.",
          ),
          new Item(
            "Setores promotores",
            "/treinamentos/setores-promotores",
            "treinamento.ver",
            "Os setores que aparecem em “Unidade promotora” da turma.",
          ),
          // "Juntar duplicados" (/treinamentos/participantes) saiu do menu em
          // 23/10/2026: juntar é exceção, e a tela abre pelo contador
          // "possíveis duplicados" do Início de Treinamentos
          // (`hub_treinamentos.ts`) e pelo atalho "juntar com outro cadastro"
          // da ficha. A rota continua.
        ],
      },
      {
        // O mesmo nome do menu do servidor comum, para o sistema falar uma
        // língua só. Fica no fim para não passar à frente de Turmas na porta
        // de entrada de quem tem só `treinamento.ver` e vínculo.
        //
        // Desde 22/10/2026 a lateral não o mostra: toda conta ligada a
        // servidor recebe o bloco "Meu espaço" (`meu_espaco_de`), que já tem
        // os dois, e `grupos_de` os tira daqui. Continua declarado porque é o
        // que diz que `/turmas/minhas` e `/certificados/meus` são deste módulo
        // (o destaque, a trilha e o mapa de quem só tem o próprio).
        titulo: "Meu espaço",
        itens: [
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
        ],
      },
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
    // A inscrição pública por link saiu também (a equipe confere cada pedido,
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
    itens: [
      new Item(
        "Painel",
        "/acidentes",
        "acidente.ver",
        "Comunicações a triar, prazos de 10 dias, investigações e ações em aberto.",
      ),
      new Item(
        "Comunicar acidente",
        "/acidentes/comunicar",
        "acidente.comunicar",
        "Registrar a ocorrência: quem, quando, onde e o que aconteceu.",
      ),
      new Item("Fila de ocorrências", "/acidentes/fila", "acidente.ver", "Todas as ocorrências, com situação e prazo."),
      new Item("Plano de ação", "/acidentes/acoes", "acidente.ver", "As ações corretivas e preventivas e os seus prazos."),
      new Item(
        "Indicadores",
        "/acidentes/indicadores",
        "indicador.ver",
        "Série histórica, taxa de frequência e de gravidade.",
        false,
        ["acidente.ver"],
      ),
    ],
    // na produção, só com `CSSO_MODULO_ACIDENTES=sim` (`acidentesLiberado`):
    // até a F6 e a emenda da ROPA o módulo aparece "em desenvolvimento"
    disponivel: acidentesLiberado(),
    // entregue por fatias: a investigação, a saúde e o SIASS vêm depois da
    // fundação, e o que ainda falta continua declarado
    itens_previstos: [
      "Investigação técnica com medições e evidências",
      "Relatório e encaminhamento ao SIASS, com a decisão da perícia",
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
  // Servidores e Catálogos pela base derivada (`PERMISSAO_DA_BASE`), e não
  // mais por `processo.ver`: "Sem acesso" a Processos SEI não tira a base de
  // quem continua no EPI ou nos Certificados (23/10/2026). Quem lia a base
  // continua lendo, com o mesmo alcance; quem não lia (almoxarife) continua
  // sem ela.
  new Item(
    "Servidores",
    "/servidores",
    PERMISSAO_DA_BASE,
    "Cadastro e histórico datado de lotação, posto e cargo.",
  ),
  new Item(
    "Catálogos",
    "/catalogos",
    // a rota abre para quem so consulta; editar e que pede catalogo.gerenciar
    PERMISSAO_DA_BASE,
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

// Portal do servidor (22/10/2026): o "Início", a "Minha atividade" e o "Meu
// perfil" têm a condição "titular" (`Item.titular`): abrem para toda conta
// ligada a servidor, sem permissão de catálogo. O "Início" guarda também a
// permissão de antes, para a conta de escopo próprio ainda sem vínculo (ela
// abre o Início com o aviso de que falta o vínculo).
const INICIO = new Item("Início", "/", "processo.ver", "O que é seu no sistema, num relance.", false, [], true);

/**
 * A tela da própria conta. No cabeçalho ela continua sendo o nome da pessoa,
 * que leva a `/minha-conta`; no "Meu espaço" ela se chama "Meu perfil".
 */
export const MINHA_CONTA = new Item(
  "Minha conta",
  "/minha-conta",
  null,
  "Seus dados de contato, e-mail e senha.",
);

/** A mesma `/minha-conta`, com o nome que ela tem no "Meu espaço". */
export const MEU_PERFIL = new Item("Meu perfil", "/minha-conta", null, "Contato, senha e e-mail.");

/**
 * Os grupos do "Meu espaço", com o subtítulo pequeno. A ordem e as permissões
 * são as da especificação do Portal (seção 1). "Meus dados" saiu do menu: os
 * dados funcionais moram no "Meu perfil", que leva à ficha.
 */
export const MEU_ESPACO_GRUPOS: readonly GrupoMenu[] = Object.freeze([
  { titulo: null, itens: [INICIO] },
  {
    titulo: "Treinamentos",
    itens: [
      new Item("Meus treinamentos", "/turmas/minhas", "treinamento.ver", "As turmas com inscrição aberta, e as suas inscrições.", true),
      new Item("Meus certificados", "/certificados/meus", "treinamento.ver", "O que foi emitido em seu nome.", true),
      new Item(
        "Comprovante de treinamentos",
        "/certificados/meus/comprovante",
        "treinamento.ver",
        "Uma folha com os seus treinamentos em vigor.",
        true,
      ),
    ],
  },
  {
    titulo: "EPI",
    itens: [
      // o EPI mora no cadastro de servidor (`exige_servidor`); o externo nem
      // tem `epi.*`, e a marca é a segunda tranca, não a primeira
      new Item("Minha ficha de EPI", "/epis/fichas/minha", "epi.ver", "O que você recebeu, com o comprovante.", true, [], false, true),
      new Item("Meus pedidos de EPI", "/epis/requisicoes", "epi.ver", "Os seus pedidos e em que pé estão.", true, [], false, true),
      new Item("Pedir EPI", "/epis/requisicoes/nova", "epi.requisitar", "Pedido para análise do SESMT.", true, [], false, true),
    ],
  },
  // o grupo some junto com o módulo enquanto ele está seguro (`acidentesLiberado`)
  ...(acidentesLiberado()
    ? [
        {
          titulo: "Acidentes",
          itens: [
            // a mesma permissão da rota; para a equipe do módulo, a lateral já
            // oferece o item e ele sai daqui (`meu_espaco_de`)
            new Item(
              "Comunicar acidente",
              "/acidentes/comunicar",
              "acidente.comunicar",
              "Registrar um acidente com você ou que você presenciou.",
              true,
            ),
            new Item(
              "Minhas comunicações",
              "/acidentes/minhas",
              "acidente.ver",
              "Os acidentes que você comunicou ou em que foi o acidentado, e em que pé estão.",
              true,
            ),
          ],
        },
      ]
    : []),
  {
    titulo: "Adicional",
    itens: [
      new Item("Meu adicional", "/adicionais", "processo.ver", "O adicional ocupacional concedido a você.", true, [], false, true),
      // O pedido de adicional em andamento. Sem o item, a ficha do processo
      // abria com a trilha "Meu espaço / Processos", o nome de um item que este
      // menu não tem.
      new Item(
        "Meus processos",
        "/processos",
        "processo.ver",
        "Os seus pedidos de adicional e em que pé estão.",
        true,
        [],
        false,
        true,
      ),
    ],
  },
  {
    titulo: "Eu",
    itens: [
      new Item("Minha atividade", "/minha-atividade", null, "Tudo o que aconteceu com o que é seu.", false, [], true),
      MEU_PERFIL,
    ],
  },
].map((g) => Object.freeze({ titulo: g.titulo, itens: Object.freeze([...g.itens]) })));

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
 * A lista plana, na ordem dos grupos (`MEU_ESPACO_GRUPOS`): é ela que decide o
 * destaque, a trilha e a porta de entrada; o grupo é só desenho da lateral.
 */
export const MEU_ESPACO: readonly Item[] = Object.freeze(MEU_ESPACO_GRUPOS.flatMap((g) => g.itens));

/**
 * Quem recebe o "Meu espaço" no lugar da lateral da equipe: quem não tem
 * NENHUMA permissão por perfil de equipe (`pode_na_equipe`). Era "o `escopo`
 * da conta é o próprio", o que dava no mesmo enquanto a permissão do titular
 * só vinha do `servidor_consulta`; com a concessão do titular (D16), a conta
 * de equipe ligada a servidor tem as duas coisas, e recebe as duas: a lateral
 * da equipe e, ao lado dela, o "Meu espaço" (`meu_espaco_de`).
 */
export function so_o_proprio(usuario: UsuarioAtual | null | undefined): boolean {
  if (!usuario) return false;
  try {
    // o nível da conta primeiro: é ele que nomeia o perfil sem escopo
    void usuario.escopo;
    return ![...usuario.permissoes].some((p) => usuario.pode_na_equipe(p));
  } catch (erro) {
    // Perfil sem escopo declarado: o menu não é a barreira (cada rota confere a
    // permissão, e a consulta no escopo nega com a tela que nomeia o perfil).
    // Deixar a exceção subir derrubava a casca inteira, inclusive essa tela.
    if (erro instanceof EscopoNaoDeclarado) return false;
    throw erro;
  }
}

/**
 * Se o item do "Meu espaço" abre para esta pessoa. A tela do titular passa
 * pelo `visivel_para` (vínculo + permissão); a condição "titular" abre com o
 * vínculo; o resto (o "Início" sem vínculo) basta a permissão, de onde quer
 * que ela venha — o filtro de equipe não vale aqui, o bloco é da pessoa.
 */
function _abre_no_meu_espaco(item: Item, usuario: UsuarioAtual): boolean {
  if (item.titular && usuario.servidor_id !== null) return true;
  if (item.do_titular) return item.visivel_para(usuario);
  if (item.permissao === null) return !item.titular;
  return item.exigidas.some((p) => usuario.pode(p));
}

/**
 * Os itens do "Meu espaço" que abrem para esta pessoa, na ordem dos grupos.
 *
 * Para quem só tem o próprio, é o menu inteiro. Para a conta de equipe ligada
 * a servidor, é um bloco AO LADO da lateral, com o que é do titular: "Meus
 * treinamentos", "Minha ficha de EPI", "Pedir EPI". Sai do bloco o item cujo
 * caminho a lateral já oferece como tela da equipe — para o coordenador, `/`
 * é o Painel e `/epis/requisicoes` é a fila do setor, e chamá-los de "Início"
 * e "Meus pedidos de EPI" seria afirmar um recorte que a tela não faz.
 *
 * A conta de equipe SEM servidor não tem "Meu espaço": o que seria dela aqui é
 * o próprio nome no cabeçalho, que é a porta de todo mundo para `/minha-conta`.
 */
export function meu_espaco_de(usuario: UsuarioAtual | null | undefined): Item[] {
  if (!usuario) return [];
  const sozinho = so_o_proprio(usuario);
  if (!sozinho && (!tem_titular(usuario) || !_escopo_declarado(usuario))) return [];
  const da_equipe = sozinho
    ? new Set<string>()
    : new Set(
        [
          ...MODULOS.flatMap((m) => m.itens.filter((item) => m.abre_na_equipe(item, usuario))),
          ...BASE.filter((item) => item.visivel_para(usuario)),
        ].map((item) => item.caminho),
      );
  const itens = MEU_ESPACO.filter(
    (item) => item !== MEU_PERFIL && _abre_no_meu_espaco(item, usuario) && !da_equipe.has(item.caminho),
  );
  // O "Meu perfil" fecha o bloco de quem TEM o bloco: abre para toda conta
  // logada, sem permissão nenhuma, mas não cria o bloco sozinho — a equipe sem
  // vínculo continuaria sem "Meu espaço" e ganharia uma lateral de um item só.
  if (itens.length) itens.push(MEU_PERFIL);
  return itens;
}

/**
 * Os mesmos itens de `meu_espaco_de`, nos grupos com subtítulo, para a lateral
 * e para a tela de bolso. Grupo que fica vazio some.
 */
export function meu_espaco_grupos_de(usuario: UsuarioAtual | null | undefined, itens?: readonly Item[]): GrupoMenu[] {
  const abertos = new Set(itens ?? meu_espaco_de(usuario));
  return MEU_ESPACO_GRUPOS.map((g) => ({ titulo: g.titulo, itens: g.itens.filter((i) => abertos.has(i)) })).filter(
    (g) => g.itens.length > 0,
  );
}

/**
 * As iniciais do avatar do cartão de identificação: a primeira letra do
 * primeiro nome e a do último, sem as partículas ("da", "dos"). Sem nome, "?".
 */
export function iniciais_de(nome: string | null | undefined): string {
  const PARTICULAS = new Set(["da", "das", "de", "do", "dos", "e"]);
  const partes = (nome ?? "").trim().split(/\s+/).filter((p) => p && !PARTICULAS.has(p.toLowerCase()));
  if (!partes.length) return "?";
  const primeira = partes[0]!.charAt(0);
  const ultima = partes.length > 1 ? partes[partes.length - 1]!.charAt(0) : "";
  return (primeira + ultima).toLocaleUpperCase("pt-BR");
}

/** O cartão de identificação do topo da lateral do "Meu espaço". */
export interface CartaoMeuEspaco {
  nome: string;
  iniciais: string;
  /** "Sigla da unidade · Campus"; null quando a tela não leu a lotação */
  linha: string | null;
}

/** O cartão só com o que a sessão já sabe (o nome da conta). */
export function cartao_meu_espaco(usuario: UsuarioAtual | null | undefined): CartaoMeuEspaco | null {
  if (!usuario) return null;
  return { nome: usuario.nome, iniciais: iniciais_de(usuario.nome), linha: null };
}

/**
 * O cartão completo, com a lotação ("ICT · Campus JK"), lido do cadastro do
 * servidor da conta. Uma consulta; sem vínculo, o cartão da sessão. A casca
 * (`web.pagina`) o chama pelo gancho `cartaoMeuEspaco` em toda tela que tem o
 * cartão; a tela que já leu o servidor (o Início, a tela de bolso) o passa no
 * contexto com a chave `cartao_meu_espaco` e poupa a consulta.
 */
export async function cartao_meu_espaco_completo(tx: Executor, usuario: UsuarioAtual): Promise<CartaoMeuEspaco | null> {
  const base = cartao_meu_espaco(usuario);
  if (!base || usuario.servidor_id === null) return base;
  const [linha] = await tx
    .select({ nome: tabela_servidor.nome, sigla: tabela_unidade.sigla, unidade: tabela_unidade.nome_extenso, campus: tabela_campus.nome })
    .from(tabela_servidor)
    .leftJoin(tabela_unidade, eq(tabela_unidade.id, tabela_servidor.unidade_uorg_id))
    .leftJoin(tabela_campus, eq(tabela_campus.id, tabela_unidade.campus_id))
    .where(eq(tabela_servidor.id, usuario.servidor_id));
  if (!linha) return base;
  const partes = [linha.sigla || linha.unidade, linha.campus].filter((p): p is string => !!p);
  return { ...base, linha: partes.length ? partes.join(" · ") : null };
}

function _escopo_declarado(usuario: UsuarioAtual): boolean {
  try {
    void usuario.escopo;
    return true;
  } catch (erro) {
    if (erro instanceof EscopoNaoDeclarado) return false;
    throw erro;
  }
}

/** A conta de equipe que recebe o bloco "Meu espaço" além da lateral. */
function _meu_espaco_ao_lado(usuario: UsuarioAtual | null | undefined): boolean {
  return !!usuario && !so_o_proprio(usuario) && meu_espaco_de(usuario).length > 0;
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
  // Quem só tem o próprio entra pelo "Início" dele: os módulos não lhe
  // oferecem tela da equipe, e a primeira do titular que sobrasse neles
  // (a ficha de EPI) não é a porta da frente.
  const meu = meu_espaco_de(usuario);
  if (so_o_proprio(usuario) && meu.length) return meu[0]!.caminho;
  for (const modulo of MODULOS) {
    if (!modulo.disponivel) continue;
    const itens = modulo.itens_de(usuario);
    if (itens.length) return itens[0]!.caminho;
  }
  const base = base_de(usuario);
  if (base.length) return base[0]!.caminho;
  return meu.length ? meu[0]!.caminho : "/modulos";
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
  /** os mesmos `itens_modulo`, em blocos com subtítulo, para a lateral */
  grupos_modulo: GrupoMenu[];
  itens_base: Item[];
  item_ativo: Item | null;
  no_modulo: boolean;
  modulo_a_lembrar: string | null;
  /**
   * Para quem só tem o próprio, o menu inteiro; para a conta de equipe ligada
   * a servidor, o bloco ao lado da lateral; vazio para a equipe sem vínculo.
   */
  meu_espaco: Item[];
  /** os mesmos `meu_espaco`, nos grupos com subtítulo (Treinamentos, EPI...) */
  grupos_meu_espaco: GrupoMenu[];
  /**
   * O cartão de identificação do topo da lateral (iniciais e nome). A tela que
   * leu a lotação passa o completo no contexto, com a mesma chave.
   */
  cartao_meu_espaco: CartaoMeuEspaco | null;
  /** o "Meu espaço" é o menu inteiro: a lateral da equipe não aparece */
  so_meu_espaco: boolean;
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
  // O módulo do caminho só vira o "atual" se abre alguma tela para a pessoa:
  // com "Sem acesso" (a tela do titular que mora nele, ou o 403 de uma tela
  // dele), a lateral não pode afirmar um módulo que o seletor esconde.
  const do_caminho_abre = do_caminho !== null && do_caminho.disponivel && do_caminho.itens_de(usuario).length > 0;
  let ativo = do_caminho_abre ? do_caminho : null;
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
  const do_meu = meu_espaco.length ? _item_do_meu_espaco(caminho, meu_espaco, usuario!) : null;
  const item = do_meu ?? item_ativo(caminho);
  const no_modulo = do_caminho_abre;
  return {
    modulos: MODULOS,
    modulo_ativo: ativo,
    itens_modulo: ativo ? ativo.itens_de(usuario) : [],
    grupos_modulo: ativo ? ativo.grupos_de(usuario) : [],
    itens_base: base_de(usuario),
    // a trilha não pode oferecer porta trancada, pela mesma razão do menu; o
    // item do "Meu espaço" já passou pelo filtro dele (o "Início" do titular
    // não é tela da equipe e não passaria pelo `visivel_para`)
    item_ativo: do_meu ?? (item !== null && item.visivel_para(usuario) ? item : null),
    no_modulo,
    // só caminho de módulo lembra; a base não reescreve de onde a pessoa veio
    modulo_a_lembrar: no_modulo ? do_caminho!.codigo : null,
    meu_espaco,
    grupos_meu_espaco: meu_espaco.length ? meu_espaco_grupos_de(usuario, meu_espaco) : [],
    cartao_meu_espaco: meu_espaco.length ? cartao_meu_espaco(usuario) : null,
    so_meu_espaco: so_o_proprio(usuario) && meu_espaco.length > 0,
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
  "/acidentes": "grid-1x2",
  "/acidentes/comunicar": "journal-plus",
  "/acidentes/fila": "inbox",
  "/acidentes/acoes": "list-check",
  "/acidentes/indicadores": "bar-chart",
  "/acidentes/minhas": "exclamation-triangle",
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
  "/treinamentos/setores-promotores": "building",
  "/treinamentos/modelos": "file-earmark-easel",
  "/treinamentos/assinaturas": "pen",
  "/pendencias": "bell",
  "/demandas": "list-check",
  "/servidores": "person-badge",
  "/catalogos": "list-ul",
  "/auditoria": "clock-history",
  "/usuarios": "gear",
  // os do "Meu espaço" que não repetem o da equipe
  "Início": "house",
  "Comprovante de treinamentos": "journal-album",
  "Meus pedidos de EPI": "inbox",
  "Meu adicional": "cash-coin",
  "Meus processos": "file-earmark-text",
  "Minha atividade": "clock",
  "Meu perfil": "person",
  "Sair": "door-open",
  "/minha-atividade": "clock",
  "/minha-conta": "person-gear",
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
ganchos.cartaoMeuEspaco = (c, usuario) => cartao_meu_espaco_completo(c.get("tx"), usuario);
// O seletor da lateral precisa saber por onde se entra em cada módulo; a
// decisão tem de ser a mesma que `/inicio` toma.
global("porta_de_entrada", porta_de_entrada);
// a regra única de acesso ao módulo, para os templates (botões e atalhos)
global("tem_acesso_ao_modulo", tem_acesso_ao_modulo);
global("icone_de", icone_de);
global("iniciais_de", iniciais_de);
