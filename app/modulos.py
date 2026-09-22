"""Os módulos do sistema e o que é base compartilhada entre eles.

Por que existe: o CSSO não faz só adicional ocupacional. EPI, treinamento,
CISSP e PGR são trabalhos diferentes que vão morar aqui — e todos precisam dos
**mesmos** servidores, das mesmas unidades, dos mesmos cargos e da mesma
auditoria. Se cada módulo trouxer o seu cadastro de servidor, o SIAPE 1110654
vai existir em quatro lugares e divergir em três.

Por isso a divisão não é por tela, é por natureza:

- **Módulo**: o fluxo de trabalho de uma competência. Tem começo, meio e fim,
  e some inteiro se a competência sair do setor.
- **Base**: o que qualquer módulo pressupõe. Servidor, unidade, cargo, posto,
  usuário e trilha de auditoria não pertencem ao adicional ocupacional — o
  adicional só os usa.

Este arquivo é a única fonte do menu e da página `/modulos`. Módulo novo se
declara aqui e aparece nos dois lugares.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.servicos.rbac import UsuarioAtual

PROCESSOS_SEI = "processos-sei"

# Qual módulo a pessoa estava usando quando saiu para a base. Não é preferência
# nem estado de negócio: é a resposta a "de onde eu vim", que só o navegador
# sabe. Vai em cookie porque a alternativa — `?de=epis` em cada link — obrigaria
# toda tela da base a propagar o parâmetro, e o menu lateral (que aponta para a
# base sem vir de link nenhum) não teria o que propagar.
COOKIE_MODULO = "csso_modulo"


@dataclass(frozen=True)
class Item:
    """Uma tela.

    `permissao` repete exatamente o que a rota exige — é o que impede o menu de
    virar um catálogo de portas trancadas. Uma tupla significa "qualquer uma
    destas", porque `/usuarios` abre para quem cria conta **ou** concede perfil.
    `None` significa que basta estar autenticado.
    """

    rotulo: str
    caminho: str
    permissao: str | tuple[str, ...] | None = None
    descricao: str = ""

    def visivel_para(self, usuario: UsuarioAtual | None) -> bool:
        if usuario is None:
            return False
        if self.permissao is None:
            return True
        exigidas = (
            (self.permissao,) if isinstance(self.permissao, str) else self.permissao
        )
        return any(usuario.pode(p) for p in exigidas)


@dataclass(frozen=True)
class Modulo:
    codigo: str
    nome: str
    resumo: str
    itens: tuple[Item, ...] = ()
    # telas do modulo que nao viram item de menu: o editor do parecer se chega
    # pelo processo, mas continua sendo Processos SEI enquanto voce esta nele
    prefixos_extras: tuple[str, ...] = field(default_factory=tuple)
    # Modulo previsto entra na lista desde ja, marcado, em vez de virar surpresa:
    # quem usa o sistema precisa saber o que ainda nao esta aqui.
    disponivel: bool = True
    itens_previstos: tuple[str, ...] = field(default_factory=tuple)

    def itens_de(self, usuario: UsuarioAtual | None) -> list[Item]:
        return [item for item in self.itens if item.visivel_para(usuario)]


MODULOS: tuple[Modulo, ...] = (
    Modulo(
        codigo=PROCESSOS_SEI,
        nome="Processos SEI",
        resumo=(
            "Do requerimento ao parecer técnico assinado: instrução do processo "
            "de adicional ocupacional, laudo que o sustenta e o direito que "
            "nasce dele."
        ),
        itens=(
            Item("Painel", "/", "processo.ver", "Indicadores e o que precisa de você hoje."),
            Item("Kanban", "/kanban", "processo.ver", "Os processos por estado."),
            Item(
                "Processos",
                "/processos",
                "processo.ver",
                "A lista completa, com o parecer técnico de cada um.",
            ),
            Item(
                "Laudos",
                "/laudos",
                "laudo.ver",
                "Laudo técnico das condições ambientais — um laudo sustenta N pareceres.",
            ),
            Item(
                "Adicionais",
                "/adicionais",
                "processo.ver",
                "O direito concedido: vigência, percentual e suspensão.",
            ),
            Item("Relatórios", "/relatorios", "indicador.ver", "Extrações e conferências."),
            Item(
                "Importar",
                "/importar",
                "catalogo.gerenciar",
                "Carga da planilha e do Trello, com reconciliação.",
            ),
        ),
        # `/pendencias` esteve aqui e saiu: a pendência deixou de ser só do
        # processo — reciclagem de treinamento já cai no mesmo sino, e EPI e
        # acidentes vão cair. Enquanto ela era prefixo extra deste módulo, a
        # trilha de /pendencias afirmava "Processos SEI", que é falso para a
        # tarefa de treinamento. Agora ela é item da base, logo abaixo.
        prefixos_extras=("/pareceres",),
    ),
    Modulo(
        codigo="epis",
        nome="Gestão de EPI",
        resumo=(
            "Do catálogo à ficha assinada: CA e validade, entrada por pregão e "
            "empenho, requisição analisada item a item, entrega registrada. A "
            "ficha é prova legal de que o equipamento foi entregue."
        ),
        itens=(
            Item(
                "Painel",
                "/epis",
                # `epi.ver`, como a rota — e não `indicador.ver`, que é a de
                # `/epis/relatorios`. As duas telas medem coisas diferentes: esta
                # conta o trabalho parado do setor (pedido, falta, CA, entrega,
                # troca) e é a tela de quem opera; a outra recorta a população
                # por unidade e por categoria, que é onde a RN-19 morde.
                "epi.ver",
                "Requisições, falta de estoque, CA a vencer, entregas e trocas devidas.",
            ),
            Item(
                "Requisições",
                "/epis/requisicoes",
                # leitura para quem tem `epi.ver`, como o estoque: a fila mostra
                # protocolo, estado e prazo. Pedir e decidir é que pedem as suas.
                #
                # Este comentário afirmava que "a identificação de quem pediu já
                # sai pela RN-19", e isso era verdade sobre o NOME e falso sobre
                # o pedido: a fila listava os nove pedidos de nove pessoas, com
                # rotina de trabalho e riscos declarados, para qualquer conta com
                # `epi.ver`. Quem separa agora é o escopo — `servico.fila` recebe
                # o usuário e filtra por `servidor_id` —, e a RN-19 volta a ser o
                # que sempre foi: a regra de como o nome aparece, não de quantas
                # linhas saem.
                "epi.ver",
                "A fila dos pedidos: protocolo, prazo e decisão item a item.",
            ),
            Item(
                "Nova requisição",
                "/epis/requisicoes/nova",
                # `epi.requisitar` e não `epi.ver`: é a permissão que a rota
                # exige, e é assim que `test_link_no_menu_sempre_abre` impede o
                # menu de oferecer porta trancada ao almoxarife e ao auditor,
                # que veem a fila e não abrem pedido.
                "epi.requisitar",
                "Abre o pedido formal, com contexto congelado no envio.",
            ),
            Item(
                # A porta do titular para o que é dele. `epi.ver`, exatamente
                # como a rota `/epis/fichas/minha` exige — e NÃO `epi.ficha`,
                # que é a permissão de ler a ficha dos outros e some para o
                # servidor comum, como deve.
                #
                # Ela existe porque a regra "`epi.ficha` ou próprio" estava
                # construída e testada desde a fatia 2 e **não tinha caminho**:
                # o único href para a ficha própria saía de `/servidores`, com
                # `processo.ver` — permissão de outro módulo. Quem entrou no
                # sistema para pedir EPI tinha de deduzir que o histórico dele
                # mora dentro do cadastro da base compartilhada.
                "Minha ficha de EPI",
                "/epis/fichas/minha",
                "epi.ver",
                "O que você recebeu: CA e lote congelados, com o comprovante.",
            ),
            Item(
                "Fichas de EPI",
                "/epis/fichas",
                "epi.ficha",
                "A prova de entrega, congelada no ato e com o comprovante assinado.",
            ),
            Item(
                "Entregar EPI",
                "/epis/entregas/nova",
                "epi.entregar",
                "Registra a entrega no balcão e imprime o comprovante para assinar.",
            ),
            Item(
                "Estoque",
                "/epis/estoque",
                # leitura para quem tem `epi.ver`, como o catálogo: saldo de bota
                # não nomeia ninguém. Escrever no razão é que pede `epi.estoque`.
                "epi.ver",
                "Lotes por pregão e empenho, saldo somado do livro razão.",
            ),
            Item(
                "Catálogo",
                "/epis/catalogo",
                "epi.ver",
                "Itens, categorias da NR-6 e motivos de recusa.",
            ),
            Item(
                "Relatórios",
                "/epis/relatorios",
                # `indicador.ver`, como o §9 manda e como `/relatorios` já faz —
                # e NÃO `epi.ver`. Declarar aqui a permissão da outra tela do
                # módulo é exatamente o defeito que `test_link_no_menu_sempre_abre`
                # pegou na 1.6.0: o almoxarife veria o link e levaria 403.
                "indicador.ver",
                "Entregue por categoria da NR-6, custo por empenho e recusas por motivo.",
            ),
        ),
        # `itens_previstos` fica vazio com a fatia 7: as três telas que faltavam
        # existem. Reserva de lote entrou na fatia 5 (é ação dentro da ficha do
        # pedido, não tela própria), a consulta do parecer entrou na 6 (mora no
        # editor do parecer, onde ela é usada) e os indicadores são `/epis` e
        # `/epis/relatorios`. Módulo entregue por fatias declara o que falta; não
        # declarar o que já chegou é a outra metade da mesma honestidade.
    ),
    Modulo(
        codigo="certificados",
        nome="Certificados e Treinamentos",
        resumo=(
            "Treinamento obrigatório de SST do modelo à segunda via: turma, "
            "inscrição, presença e nota, emissão do certificado e o controle de "
            "reciclagem — quem venceu, quem vence, quem nunca fez."
        ),
        itens=(
            Item(
                "Turmas",
                "/turmas",
                "treinamento.ver",
                "Da abertura das inscrições ao fecho da turma.",
            ),
            Item(
                # `treinamento.ver`, exatamente como a rota `/turmas/minhas`
                # exige — e NÃO `turma.inscrever_se`: a tela responde "o que é
                # meu" antes de responder "o que posso pedir", e quem não tem a
                # permissão de pedir continua tendo o que ver nela. Declarar
                # aqui a permissão do BOTÃO faria o menu esconder uma tela que
                # abre, que é a mentira na outra direção.
                #
                # A porta do servidor para o treinamento. `/turmas` é a lista do
                # setor; até esta fatia ela abria 200 e vinha SEMPRE VAZIA para
                # quem tem escopo próprio, afirmando "nenhuma turma aberta
                # ainda" com uma turma de vinte vagas na frente — e o único item
                # de treinamento que ele via era esse.
                "Meus treinamentos",
                "/turmas/minhas",
                "treinamento.ver",
                "As turmas com inscrição aberta, e as suas inscrições.",
            ),
            Item(
                # `treinamento.ver`, como a rota `/certificados/meus` — e não
                # `certificado.ver`, que é a permissão de ler o certificado DE
                # OUTRO e que o servidor comum não tem por desenho. O item existe
                # porque `Certificado.servidor_id` foi denormalizado exatamente
                # para o escopo próprio e nunca teve porta: a fechadura estava
                # instalada e a chave nunca foi entregue.
                "Meus certificados",
                "/certificados/meus",
                "treinamento.ver",
                "O que foi emitido em seu nome, com a segunda via do congelado.",
            ),
            Item(
                "Certificados",
                "/certificados",
                "certificado.ver",
                "Emitidos, com segunda via a partir do congelado.",
            ),
            Item(
                "Catálogo",
                "/treinamentos/catalogo",
                "treinamento.ver",
                "Treinamentos, carga horária e a validade da reciclagem.",
            ),
            Item(
                "Modelos",
                "/treinamentos/modelos",
                "treinamento.gerenciar",
                "O .docx do certificado e o dicionário de tags.",
            ),
            Item(
                "Assinaturas",
                "/treinamentos/assinaturas",
                "assinatura.gerenciar",
                "Instrutores, títulos e rubricas.",
            ),
        ),
        # o módulo já está em uso, mas entregue por fatias: o que falta continua
        # declarado, pelo mesmo motivo que módulo previsto aparece na lista —
        # quem usa o sistema precisa saber o que ainda não está aqui
        # A validação pública por chave saiu desta lista porque **existe**:
        # `/validar/{chave}` responde, sem sessão e sem expor o nome de quem se
        # formou. Declarar o que ainda falta é metade da honestidade; a outra
        # metade é não continuar declarando o que já chegou — e esta linha, em
        # particular, era a mais cara de manter: o endereço já saía impresso em
        # todo certificado emitido, e a lista dizia que ele não existia.
        itens_previstos=(
            "Inscrição pública por link, com e-mail confirmado",
            "Monitor de vencimento por servidor e por unidade",
        ),
    ),
    Modulo(
        codigo="acidentes",
        nome="Análise de Acidentes",
        resumo=(
            "Acidente em serviço pela Lei 8.112, arts. 212-214: comunicação em "
            "10 dias, investigação técnica que instrui a perícia do SIASS, e a "
            "memória que hoje não existe — série histórica, taxa de frequência "
            "e de gravidade."
        ),
        disponivel=False,
        itens_previstos=(
            "Registro da ocorrência com espécie: típico, trajeto ou doença do trabalho",
            "Investigação técnica com medições e evidências",
            "Revisão adversarial antes do laudo: a conclusão tem de sobreviver à objeção",
            "CAT/SP instruída — o nexo causal quem estabelece é a perícia oficial",
            "Indicadores por unidade, posto e fator; cruzamento com a ficha de EPI",
        ),
    ),
    Modulo(
        codigo="cissp",
        nome="CISSP",
        resumo=(
            "Comissão Interna de Saúde e Segurança do Servidor Público: "
            "composição, mandato, reuniões e o que ficou deliberado."
        ),
        disponivel=False,
        itens_previstos=(
            "Composição e mandato dos membros",
            "Pauta, ata e deliberação de cada reunião",
            "Acompanhamento das recomendações até o fecho",
        ),
    ),
    Modulo(
        codigo="pgr",
        nome="PGR",
        resumo=(
            "Programa de Gerenciamento de Riscos: inventário de riscos por "
            "posto e plano de ação com prazo e responsável."
        ),
        disponivel=False,
        itens_previstos=(
            "Inventário de riscos por posto de trabalho",
            "Avaliação de severidade e probabilidade",
            "Plano de ação com prazo, responsável e evidência",
            "Reaproveitamento do que o laudo técnico já mediu",
        ),
    ),
)

# Não é módulo: é o chão que todo módulo pisa. Servidor, unidade, cargo e posto
# são os mesmos para o adicional, para o EPI e para o treinamento — e a fila de
# pendências também: a tarefa nasce da regra de um módulo, mas o sino é um só.
BASE: tuple[Item, ...] = (
    Item(
        "Pendências",
        "/pendencias",
        # Espelha `pendencias.PERMISSOES_VER`. Uma tupla porque a lista de
        # leitura é explícita e cresce com cada módulo: quem opera treinamento
        # recebe tarefa de reciclagem e precisa vê-la sem ter `processo.ver`.
        # Módulo novo acrescenta a sua permissão nos dois lugares, e
        # `test_link_no_menu_sempre_abre` cobra que os dois digam o mesmo.
        ("processo.ver", "treinamento.ver", "epi.ver"),
        "Tarefas abertas por regra, com dono e prazo — de todos os módulos.",
    ),
    Item(
        "Demandas",
        "/demandas",
        # `demanda.ver`, idêntica ao que a rota exige. Uma permissão só, e não
        # tupla: a fila é do setor inteiro — "demanda que só uma pessoa vê some
        # quando ela entra de férias" —, e quem registra também vê.
        "demanda.ver",
        "O que chegou por e-mail ou no balcão e ainda não é processo SEI.",
    ),
    Item(
        "Servidores",
        "/servidores",
        "processo.ver",
        "Cadastro e histórico datado de lotação, posto e cargo.",
    ),
    Item(
        "Catálogos",
        "/catalogos",
        # a rota abre para quem so consulta; editar e que pede catalogo.gerenciar
        "processo.ver",
        "Campi, unidades, postos, cargos, agentes nocivos e textos padrão.",
    ),
    Item(
        "Auditoria",
        "/auditoria",
        "auditoria.ver",
        "Trilha append-only encadeada por hash.",
    ),
    Item(
        "Usuários",
        "/usuarios",
        ("usuario.criar_conta", "perfil.conceder"),
        "Contas, perfis e permissões.",
    ),
)


def por_codigo(codigo: str) -> Modulo | None:
    return next((m for m in MODULOS if m.codigo == codigo), None)


def modulo_ativo(caminho: str) -> Modulo | None:
    """Qual módulo a URL atual pertence — é o que fica destacado no menu.

    Casa pelo prefixo mais longo para que `/processos/12/parecer` continue
    dentro de Processos SEI, e não caia fora do módulo no meio do trabalho.
    """
    melhor: tuple[int, Modulo] | None = None
    for modulo in MODULOS:
        caminhos = [item.caminho for item in modulo.itens] + list(modulo.prefixos_extras)
        for alvo in caminhos:
            if alvo == "/":
                if caminho == "/" and melhor is None:
                    melhor = (1, modulo)
                continue
            if caminho == alvo or caminho.startswith(alvo + "/"):
                if melhor is None or len(alvo) > melhor[0]:
                    melhor = (len(alvo), modulo)
    return melhor[1] if melhor else None


def base_de(usuario: UsuarioAtual | None) -> list[Item]:
    return [item for item in BASE if item.visivel_para(usuario)]


def item_ativo(caminho: str) -> Item | None:
    """Qual item de menu a URL atual pertence.

    É o que fica destacado na lateral e o **segundo nível** da trilha de
    navegação. Usa o mesmo critério de prefixo mais longo de `modulo_ativo`,
    pelo mesmo motivo: `/processos/12/parecer` continua sendo "Processos", e
    não some do menu no meio do trabalho.

    Procura na base também — `/servidores` não pertence a módulo nenhum, mas
    tem item de menu e precisa aparecer destacado como qualquer outro.
    """
    melhor: tuple[int, Item] | None = None
    for item in [i for m in MODULOS for i in m.itens] + list(BASE):
        alvo = item.caminho
        if alvo == "/":
            # "/" casa com tudo por prefixo: só vale na igualdade exata, e como
            # é o caminho mais curto possível nunca ganha de outro
            if caminho == "/" and melhor is None:
                melhor = (1, item)
            continue
        if caminho == alvo or caminho.startswith(alvo + "/"):
            if melhor is None or len(alvo) > melhor[0]:
                melhor = (len(alvo), item)
    return melhor[1] if melhor else None


def porta_de_entrada(modulo: Modulo, usuario: UsuarioAtual | None) -> str:
    """Por onde se entra num módulo — a primeira tela que abre para esta pessoa.

    O seletor da lateral apontava para `/modulos#codigo`, o mapa. Um controle
    que se chama "Trocar de módulo" e leva ao índice não troca de módulo:
    cobrava três cliques por alternância e, no meio do caminho, mostrava o nome
    do módulo antigo. Aqui ele passa a levar ao trabalho.

    Sem nenhuma tela visível o destino continua sendo o mapa, que explica que a
    ausência é de permissão — e não uma porta trancada a mais.
    """
    itens = modulo.itens_de(usuario)
    return itens[0].caminho if itens else f"/modulos#{modulo.codigo}"


def primeira_tela(usuario: UsuarioAtual | None) -> str:
    """A primeira tela que abre para esta pessoa, em todo o sistema.

    É o destino de `/inicio` e a razão de ele existir: `/` é o painel de
    Processos SEI e exige `processo.ver`, que o almoxarife não tem — mandá-lo
    para lá depois do login lhe dava um 403 como primeira tela. A ordem é a da
    lateral (módulos, depois base), então quem tem `processo.ver` continua
    caindo no painel de sempre.

    Sobra `/modulos`, que não exige permissão nenhuma: é o mesmo recuo que a
    tela de erro já usa.
    """
    for modulo in MODULOS:
        if not modulo.disponivel:
            continue
        itens = modulo.itens_de(usuario)
        if itens:
            return itens[0].caminho
    base = base_de(usuario)
    return base[0].caminho if base else "/modulos"


def _modulo_de_recuo(usuario: UsuarioAtual | None) -> Modulo | None:
    """Fora dos módulos, qual menu a lateral mostra quando não há de onde vir.

    Era `PROCESSOS_SEI` fixo. Para quem tem `processo.ver` isso funcionava por
    acidente; para o almoxarife a lateral exibia "Processos SEI" sobre um menu
    **vazio** — o seletor nomeando um módulo do qual ele não abre uma única
    tela. O recuo passa a ser o primeiro módulo que de fato abre para a pessoa,
    que é a mesma regra que a tela de erro aplica para escolher a saída.
    """
    for modulo in MODULOS:
        if modulo.disponivel and modulo.itens_de(usuario):
            return modulo
    return None


def navegacao(
    caminho: str, usuario: UsuarioAtual | None, origem: str | None = None
) -> dict:
    """O que o cabeçalho precisa saber: módulo atual, seus itens e a base.

    O caminho manda: em tela de módulo, o módulo é o do caminho, e ponto.

    Fora dele a pergunta muda de natureza. `/servidores` não pertence a módulo
    nenhum — a base é o chão que todos pisam —, então "qual módulo destacar" não
    é fato da URL, é fato da pessoa: **o módulo de onde ela veio**. Fingir que a
    base é de Processos SEI era o defeito; apagar o módulo da lateral enquanto
    ela consulta um cadastro seria trocá-lo por outro, porque quem estava em
    `/epis/fichas/12` e abre o cadastro do servidor perderia as oito telas de
    EPI e voltaria a elas em três cliques.

    Por isso a lateral mantém o menu do módulo de origem enquanto a pessoa
    passeia pela base, e quem diz que ela está na base é a trilha ("Base
    compartilhada") e o destaque, que cai no bloco de baixo. As duas afirmações
    convivem sem se contradizer: o bloco de cima responde "qual é o seu
    trabalho", o de baixo responde "onde você está agora".
    """
    do_caminho = modulo_ativo(caminho)
    ativo = do_caminho if do_caminho is not None and do_caminho.disponivel else None
    if ativo is None:
        lembrado = por_codigo(origem) if origem else None
        if lembrado is not None and lembrado.disponivel and lembrado.itens_de(usuario):
            ativo = lembrado
        else:
            ativo = _modulo_de_recuo(usuario)
    item = item_ativo(caminho)
    return {
        "modulos": MODULOS,
        "modulo_ativo": ativo,
        "itens_modulo": ativo.itens_de(usuario) if ativo else [],
        "itens_base": base_de(usuario),
        # a trilha não pode oferecer porta trancada, pela mesma razão do menu
        "item_ativo": item if item is not None and item.visivel_para(usuario) else None,
        # a tela é de módulo? é o que decide se o seletor está afirmando um
        # lugar (e então tem de ser o certo) ou lembrando uma origem
        "no_modulo": do_caminho is not None and do_caminho.disponivel,
        # o que a resposta deve gravar no cookie de origem: só caminho de módulo
        # lembra; a base não pode reescrever de onde a pessoa veio.
        "modulo_a_lembrar": (
            do_caminho.codigo
            if do_caminho is not None and do_caminho.disponivel
            else None
        ),
    }
