"""RBAC - perfis, permissoes e escopo (SS6 do prompt).

Checagem em tres camadas: middleware de rota, service layer antes de qualquer
escrita, e filtro de escopo no repositorio. Negado por padrao. Nunca confie em
esconder botao.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

log = logging.getLogger("csso.rbac")

PERMISSOES: dict[str, str] = {
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
    "exportar": "Exportar dados",
    "auditoria.ver": "Ver trilha de auditoria",
    "indicador.ver": "Ver indicadores",
    "backup.executar": "Executar backup",
    # --- Certificados e Treinamentos (fatia 1) ---
    "treinamento.ver": "Ver treinamentos, turmas e certificados",
    "treinamento.gerenciar": "Gerenciar catalogo de treinamento e modelo de certificado",
    "assinatura.gerenciar": "Cadastrar assinatura de instrutor",
    # --- Certificados e Treinamentos (fatia 2) ---
    # So as tres que a fatia usa. As demais do SS8 do desenho (`turma.avaliar`,
    # `certificado.*`, `participante.mesclar`, `vencimento.ver`) entram com a
    # fatia que as exige: `semear_rbac` NUNCA remove permissao de perfil, entao
    # semear cedo e conceder acesso que so sai por SQL manual.
    "turma.criar": "Criar e editar turma",
    "turma.inscrever": "Inscrever e confirmar participante",
    "turma.concluir": "Concluir ou cancelar turma",
    # --- Certificados e Treinamentos (fatia do servidor comum) ---
    # `turma.inscrever_se` e separada de `turma.inscrever` pela MESMA razao que
    # `epi.requisitar` e separada de `epi.analisar`: pedir nao e deferir. E a
    # diferenca nao e de grau, e de objeto — `turma.inscrever` inscreve QUALQUER
    # PESSOA em qualquer turma (e confirma a inscricao dos outros), e conceder
    # isso a um servidor para que ele se inscreva a si mesmo lhe entregaria a
    # lista inteira de participantes e o poder de por gente em turma. A tela de
    # 403 mandava exatamente esse pedido a quem nao pode recebe-lo.
    #
    # A permissao NAO carrega nenhum "quem": a rota que ela guarda nao aceita
    # participante, servidor nem inscricao como parametro, e o titular sai de
    # `usuario.servidor_id`. E essa a propriedade de seguranca que sustenta a
    # fatia, e ela mora na assinatura da rota — nao numa comparacao dentro do
    # servico que a proxima refatoracao pode perder.
    "turma.inscrever_se": "Inscrever-se em turma aberta (so a si mesmo)",
    # --- Certificados e Treinamentos (fatia 3) ---
    # Retificar presenca ou nota de turma JA CONCLUIDA nao entra aqui: pede
    # `turma.concluir`, pela mesma simetria do parecer (o tecnico emite e nao
    # anula). Desfazer um resultado que ja foi comunicado e decisao de quem
    # responde pela turma.
    "turma.avaliar": "Lancar presenca e nota",
    # --- Certificados e Treinamentos (fatia 4) ---
    # `participante.mesclar` (fatia 6) e `vencimento.ver` (fatia 7) continuam
    # fora pela mesma razao de sempre: semear cedo e conceder acesso que so sai
    # por SQL manual.
    "certificado.emitir": "Emitir certificado (consome numero)",
    "certificado.anular": "Anular certificado emitido",
    "certificado.ver": "Ver certificado nominal e dados do participante",
    # --- Gestao de EPI (fatia 1) ---
    # So as que protegem tela em cada fatia. As duas que faltavam do SS8 do
    # desenho (`epi.requisitar` e `epi.analisar`) entraram na fatia 4, que e a
    # que as exige — pela mesma razao de sempre: `semear_rbac` NUNCA remove
    # permissao de perfil, entao semear cedo e conceder acesso que so sai por
    # SQL manual.
    #
    # `epi.catalogo` e separada de `catalogo.gerenciar` de proposito: quem mantem
    # o catalogo de EPI e o tecnico de seguranca ou o almoxarife, e
    # `catalogo.gerenciar` da acesso a fundamentacao legal, percentual e texto
    # padrao do parecer. Reaproveitar a permissao entregaria o parecer a quem so
    # precisa cadastrar bota.
    "epi.ver": "Ver catalogo, estoque e requisicoes de EPI",
    "epi.catalogo": (
        "Gerenciar o catalogo de EPI: item, CA, quantidade e motivo de recusa"
    ),
    # --- Gestao de EPI (fatia 2) ---
    # `epi.ficha` e separada de `epi.ver` porque as duas telas dizem coisas de
    # natureza diferente. O catalogo e a lista do que o setor fornece — nao
    # nomeia ninguem. A ficha e historico nominal sobre a seguranca de uma
    # pessoa determinada, na mesma classe de `exposicao.ver`: ler a de outro
    # registra em `acesso_dado_sensivel`, e ler a propria nao precisa dela
    # porque `ESCOPO_PROPRIO` ja resolve.
    "epi.entregar": "Registrar entrega e emitir a ficha de EPI",
    "epi.ficha": "Ver a ficha de EPI nominal de qualquer servidor",
    # --- Gestao de EPI (fatia 3) ---
    # Escrever no estoque e ato de quem CONTA a prateleira: dar entrada no lote,
    # ajustar o saldo contra a contagem fisica e descartar o que nao pode mais
    # sair. Separada de `epi.entregar` porque as duas respondem por coisas
    # diferentes — a entrega responde perante o servidor que assinou o
    # comprovante, o estoque responde perante o empenho. Ler o estoque continua
    # em `epi.ver`: saldo de bota nao nomeia ninguem.
    "epi.estoque": "Registrar entrada, ajuste e descarte de estoque de EPI",
    # --- Gestao de EPI (fatia 4) ---
    # As duas sao separadas porque a RN-28 exige que sejam DUAS PESSOAS: quem
    # analisa nao e quem requisita. Uma permissao unica de "operar requisicao"
    # tornaria a regra indefensavel na tela — todo mundo que pede poderia
    # decidir, e o bloqueio viraria uma checagem de igualdade solitaria dentro
    # de um servico, sem nada no RBAC que a sustentasse.
    #
    # `epi.requisitar` e larga de propósito: pedir EPI e ato do proprio servidor,
    # da chefia dele ou da secretaria, e negar isso empurraria o pedido para o
    # e-mail — que e onde ele esta hoje e onde nao ha protocolo, prazo nem
    # trilha. `epi.analisar` e estreita pelo motivo oposto: decidir e ato tecnico
    # de quem responde pelo risco do posto.
    "epi.requisitar": "Abrir e enviar requisicao de EPI",
    "epi.analisar": "Analisar requisicao de EPI: aprovar, recusar e indeferir",
    # --- Demandas (base compartilhada) ---
    # Duas, e a divisao segue a mesma logica de todo o resto: uma para LER a
    # fila do setor e outra para ESCREVER nela.
    #
    # `demanda.ver` e larga de propósito, e a decisao e do dono do sistema:
    # "demanda que so uma pessoa ve some quando ela entra de ferias". A fila e
    # do SETOR, e todo mundo que opera algum modulo aqui dentro a enxerga. O que
    # a permissao NAO faz e afrouxar a RN-19: o nome de quem demanda continua
    # saindo por `identificar(...)`, e quem nao tem `exposicao.ver` le o codigo
    # opaco, como em toda outra tela.
    #
    # `demanda.registrar` cobre os tres atos de escrita — registrar, encaminhar
    # e encerrar. Nao ha razao para separa-los: quem anota o pedido no balcao e
    # a mesma pessoa que o encaminha e que escreve como ele terminou, e uma
    # permissao a mais so criaria a chance de alguem receber metade dela e
    # descobrir isso no meio do atendimento.
    "demanda.ver": "Ver as demandas do setor",
    "demanda.registrar": "Registrar demanda, encaminhamento e encerramento",
}

# `permissao.modulo` existe desde o esquema inicial com default 'ADICIONAL', mas
# ninguem a preenchia. NADA em app/ le esta coluna hoje — /perfis renderiza a
# partir de MATRIZ_PERFIS, que e codigo. O mapa serve para a coluna ter valor
# correto desde ja, para quando existir a tela de permissoes por modulo; enquanto
# essa tela nao existe, mudar o valor aqui nao muda nada na aplicacao. Fica um
# mapa ao lado para nao mudar a forma de PERMISSOES, que a matriz de perfis e o
# seed ja consomem como codigo->descricao.
MODULO_PADRAO = "ADICIONAL"
MODULO_POR_PERMISSAO: dict[str, str] = {
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
    # "BASE" e valor novo nesta coluna, e e o certo: demanda nao pertence a
    # modulo nenhum — ela pode ser sobre adicional, EPI, treinamento ou sobre
    # nada disso, e por isso mora na base compartilhada de `app/modulos.py`.
    # Carimba-la de 'ADICIONAL' (o default) seria repetir na coluna a mesma
    # mentira que a trilha de /pendencias contava antes de a pendencia virar
    # item da base. A coluna nao e lida por tela nenhuma hoje; o valor certo
    # agora e o que evita o backfill depois.
    "demanda.ver": "BASE",
    "demanda.registrar": "BASE",
}


def modulo_da_permissao(codigo: str) -> str:
    return MODULO_POR_PERMISSAO.get(codigo, MODULO_PADRAO)


# Escopos: S=sim, E=escopo (coordenadoria+campus), P=proprios, A=agregado
ESCOPO_TOTAL = "S"
ESCOPO_UNIDADE = "E"
ESCOPO_PROPRIO = "P"
ESCOPO_AGREGADO = "A"


def _p(*codigos: str) -> list[str]:
    return list(codigos)


MATRIZ_PERFIS: dict[str, dict] = {
    "admin_ti": {
        "nome": "Administrador de TI",
        "base_normativa": "Sem acesso ao conteudo tecnico. So conta, senha, auditoria e backup.",
        "permissoes": _p(
            "usuario.criar_conta", "usuario.resetar_senha", "auditoria.ver",
            "backup.executar", "indicador.ver",
        ),
    },
    "superintendente": {
        "nome": "Superintendente da Sisa",
        "base_normativa": "Resolucao Consu UFVJM 11/2026, art. 11, IX",
        "permissoes": _p(
            "processo.ver", "parecer.ver", "laudo.ver", "processo.atribuir",
            "perfil.conceder", "habilitacao.atestar", "exposicao.ver", "exportar",
            "auditoria.ver", "indicador.ver",
            "treinamento.ver", "certificado.ver",
            "epi.ver", "epi.ficha",
            # le a fila do setor e nao escreve nela: e a mesma forma do resto do
            # perfil, que ve tudo e opera nada
            "demanda.ver",
        ),
    },
    "coordenador_csso": {
        "nome": "Coordenador da CSSO",
        "base_normativa": "Resolucao Consu UFVJM 11/2026, art. 20, VII",
        "permissoes": _p(
            "processo.ver", "processo.criar", "processo.editar", "processo.status",
            "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
            "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
            "laudo.criar", "catalogo.gerenciar", "anexo.enviar", "exposicao.ver",
            "exportar", "auditoria.ver", "indicador.ver",
            "treinamento.ver", "treinamento.gerenciar", "assinatura.gerenciar",
            "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
            "certificado.emitir", "certificado.anular", "certificado.ver",
            "epi.ver", "epi.catalogo", "epi.entregar", "epi.ficha",
            "epi.estoque", "epi.requisitar", "epi.analisar",
            "demanda.ver", "demanda.registrar",
        ),
    },
    "engenheiro_seguranca": {
        "nome": "Engenheiro de Seguranca do Trabalho",
        "base_normativa": "IN SGP/SEDGG/ME 15/2022, art. 10, §2º, I",
        "permissoes": _p(
            "processo.ver", "processo.criar", "processo.editar", "processo.status",
            "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
            "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
            "laudo.criar", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
            "treinamento.ver", "treinamento.gerenciar", "assinatura.gerenciar",
            "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
            "certificado.emitir", "certificado.anular", "certificado.ver",
            # le a ficha (o EPI recebido sustenta ou derruba a alegacao de
            # neutralizacao no parecer) e nao entrega: quem opera o balcao do
            # almoxarifado e outra pessoa (SS8 do desenho)
            "epi.ver", "epi.catalogo", "epi.ficha",
            # decide o pedido (e o risco do posto que fundamenta a decisao e o
            # que ele apura no laudo), e nao opera o balcao
            "epi.requisitar", "epi.analisar",
            # e ele quem recebe a maior parte das demandas — a funcionalidade
            # nasceu de uma frase dele: "chegam por e-mail ou presencialmente,
            # e eu preciso nao perder"
            "demanda.ver", "demanda.registrar",
        ),
    },
    "medico_trabalho": {
        "nome": "Medico do Trabalho",
        "base_normativa": "IN SGP/SEDGG/ME 15/2022, art. 10, §2º, I",
        "permissoes": _p(
            "processo.ver", "processo.criar", "processo.editar", "processo.status",
            "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
            "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
            "laudo.criar", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
            # ministra NR-32 e primeiros socorros (SS8 do desenho)
            "treinamento.ver", "treinamento.gerenciar", "assinatura.gerenciar",
            "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
            "certificado.emitir", "certificado.anular", "certificado.ver",
            # ve o catalogo de EPI (indica EPI no exame ocupacional) e nao o
            # edita: cadastrar CA e quantidade e ato do tecnico de seguranca e
            # de quem opera o almoxarifado (SS8 do desenho)
            "epi.ver", "epi.ficha",
            # indica EPI no exame ocupacional, e decidir o pedido que decorre
            # dessa indicacao e o mesmo ato
            "epi.requisitar", "epi.analisar",
            "demanda.ver", "demanda.registrar",
        ),
    },
    "tecnico_seguranca": {
        "nome": "Tecnico de Seguranca do Trabalho",
        "base_normativa": (
            "Avalia ambiente, mede, instrui e monta rascunho. NAO subscreve laudo "
            "nem assina parecer (IN 15/2022, art. 10, §2º, I)."
        ),
        "permissoes": _p(
            "processo.ver", "processo.criar", "processo.editar", "processo.status",
            "parecer.ver", "parecer.criar", "parecer.editar", "parecer.emitir",
            "laudo.ver", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
            # ministra treinamento: cadastra o catalogo e a propria rubrica.
            # Anular certificado e mesclar participante ficam fora (§8) — mesma
            # simetria do parecer, em que ele emite e nao assina: consumir
            # numero e operacao tecnica, desfazer documento que circulou e
            # decisao de coordenacao.
            "treinamento.ver", "treinamento.gerenciar", "assinatura.gerenciar",
            "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
            "certificado.emitir", "certificado.ver",
            # e ele quem mantem o catalogo de EPI na pratica, e e ele quem
            # entrega e conta a prateleira quando nao ha almoxarife dedicado
            # (SS8 do desenho)
            "epi.ver", "epi.catalogo", "epi.entregar", "epi.ficha",
            "epi.estoque", "epi.requisitar", "epi.analisar",
            "demanda.ver", "demanda.registrar",
        ),
    },
    "almoxarife_sesmt": {
        "nome": "Almoxarife do SESMT",
        "base_normativa": (
            "Opera o estoque e a entrega do EPI. Nao decide o direito ao item, "
            "nao le parecer, nao ve exposicao."
        ),
        # O perfil nasce na fatia 3, e nao antes, porque o nucleo dele e
        # `epi.estoque` — que so passou a existir agora. `semear_rbac` nunca
        # REMOVE permissao de perfil: um perfil semeado pela metade concede
        # acesso que so sai por SQL manual, e a metade que faltava seria
        # justamente a razao de ele existir.
        #
        # `epi.ficha` esta aqui e o §8 do desenho a marcava com "—". A matriz
        # de la nao fecha com o fluxo que ela mesma descreve: quem entrega e
        # quem GRAVA a linha da ficha, e a decisao 8 poe na conta dele o passo
        # seguinte — imprimir o comprovante, colher a assinatura e anexar o
        # digitalizado, que sao acoes da tela da ficha. Sem `epi.ficha` o
        # sistema abriria para ele a pendencia `COMPROVANTE_EPI_PENDENTE`,
        # com o nome dele em `responsavel_id`, e devolveria 403 no link dela.
        # Tarefa com dono que o dono nao consegue abrir e o modo de falha que
        # `PERMISSOES_VER` e `test_link_no_menu_sempre_abre` existem para
        # impedir. Ler a ficha de outro continua caindo em
        # `acesso_dado_sensivel`, como para todo mundo (RN-23).
        #
        # O que ele continua NAO tendo e o que a base normativa do perfil diz:
        # nada de parecer, laudo, exposicao, processo nem catalogo de EPI.
        #
        # `demanda.*` entra apesar da base normativa estreita, e o argumento e o
        # canal PRESENCIAL: quem esta no balcao do almoxarifado e quem recebe o
        # pedido que chega andando, e mandar essa pessoa "avisar alguem da CSSO"
        # e exatamente o caminho por onde a demanda se perde hoje. Ele registra
        # e ve a fila; o que ele continua nao tendo e todo o resto.
        "permissoes": _p(
            "epi.ver", "epi.estoque", "epi.entregar", "epi.ficha",
            "demanda.ver", "demanda.registrar",
        ),
    },
    "secretaria_csso": {
        "nome": "Secretaria da CSSO",
        "base_normativa": "Sem acesso a exposicao (dado mascarado - RN-19).",
        "permissoes": _p(
            "processo.ver", "processo.criar", "processo.editar", "processo.status",
            "parecer.ver", "laudo.ver", "anexo.enviar", "indicador.ver",
            # ve o catalogo porque opera a inscricao e a emissao (fatias 2 e 4);
            # nao edita o catalogo nem cadastra rubrica de instrutor
            "treinamento.ver",
            # e a secretaria que monta a turma e recebe o inscrito: negar aqui
            # obrigaria o engenheiro a digitar lista de presenca (SS8)
            "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
            # `certificado.ver` apesar de ela NAO ter `exposicao.ver`: exposicao
            # a agente nocivo e dado de saude (RN-19), presenca em curso de
            # NR-35 nao e. Negar aqui seria imitar a restricao sem entender de
            # onde ela veio — e quem opera a emissao precisa ver para quem esta
            # emitindo. Anular continua fora.
            "certificado.emitir", "certificado.ver",
            # abre e envia requisicao pelo servidor (§8): quem pede EPI muitas
            # vezes nao opera o sistema, e negar aqui empurraria o pedido para o
            # e-mail — que e onde ele esta hoje, sem protocolo, prazo nem trilha.
            # `epi.analisar` fica de fora: decidir e ato tecnico.
            "epi.ver", "epi.requisitar",
            # e a secretaria que atende o telefone e abre a caixa de entrada do
            # setor: negar aqui deixaria a demanda no e-mail, que e onde ela
            # esta hoje
            "demanda.ver", "demanda.registrar",
        ),
    },
    "consulta_progep": {
        "nome": "Consulta PROGEP",
        "base_normativa": "Le apenas parecer assinado.",
        "permissoes": _p(
            "processo.ver", "parecer.ver", "laudo.ver", "exposicao.ver", "exportar",
            "indicador.ver",
            # e a PROGEP que age sobre a lotacao de quem esta irregular
            "treinamento.ver", "certificado.ver",
            # a ficha de EPI e um dos documentos que a PROGEP e a procuradoria
            # pedem primeiro (SS12.8 do desenho); ler a de outro fica em
            # `acesso_dado_sensivel`
            "epi.ver", "epi.ficha",
        ),
    },
    "servidor_consulta": {
        "nome": "Servidor (consulta do proprio processo)",
        "base_normativa": "LGPD art. 18, II - acesso do titular.",
        # `epi.ver` abre o catalogo, que nao e nominal: e a lista do que o setor
        # fornece. `epi.ficha` fica DE FORA de proposito: ela e a permissao de
        # ler a ficha DOS OUTROS. A propria ficha o servidor le sem ela, porque
        # `ESCOPO_PROPRIO` filtra por `servidor_id` — e `epi_ficha_registro` tem
        # essa coluna, que e exatamente a que `aplicar_escopo` procura.
        # `epi.requisitar` entra na fatia 4: pedir o proprio EPI e o caso de uso
        # central do modulo, e `ESCOPO_PROPRIO` limita o que ele ve — a
        # requisicao tem `servidor_id`, que e a coluna que `aplicar_escopo`
        # procura. Analisar continua fora, e a RN-28 fecha a porta de todo modo.
        #
        # "Limita" e verbo no presente desde a 1.34.0, e nao era: ate ali este
        # comentario descrevia uma protecao que nao existia — `aplicar_escopo`
        # nao era chamado uma unica vez em `app/rotas/epi_*.py`, e a fila
        # entregava os pedidos de todo mundo. A porta e `epi_requisicao.fila` /
        # `epi_requisicao.no_escopo`, e `testes/unitarios/test_repositorios.py`
        # varre as rotas de leitura para que a frase nao volte a envelhecer
        # sozinha.
        #
        # `certificado.ver` fica DE FORA pelo mesmo motivo de `epi.ficha`, e
        # agora com a mesma compensacao construida. A descricao da permissao em
        # `PERMISSOES` diz o que ela e: "certificado nominal e dados do
        # participante" — ou seja, a permissao de ler o de OUTRO. Concede-la aqui
        # seria uma linha e resolveria a tela; o preco seria mudar o que a
        # permissao significa para sempre, porque `semear_rbac` nunca remove
        # permissao de perfil e toda rota futura guardada por `certificado.ver`
        # passaria a abrir para milhares de contas, dependendo de ela lembrar do
        # escopo. E essa dependencia — "abre porque a rota lembrou de filtrar" —
        # e exatamente a folga que a 1.35.0 fechou.
        #
        # O titular alcanca o que e dele por `treinamento.ver`, que ele ja tem:
        # `emissao_certificado.exigir_leitura_do_certificado` decide pela relacao
        # titular/terceiro, como `epi_ficha.exigir_leitura_da_ficha` faz desde a
        # fatia 2, e `/certificados/meus` prende a lista ao `servidor_id` da
        # conta. Ler o proprio nao gera `acesso_dado_sensivel`; ler o de outro
        # continua exigindo a permissao e continua sendo registrado.
        #
        # `turma.inscrever_se` entra pelo mesmo raciocinio de `epi.requisitar`, e
        # e a outra metade do motivo de este perfil existir: ele entra no sistema
        # para pedir EPI e para se inscrever em treinamento, e ate aqui a segunda
        # coisa nao tinha caminho nenhum. `turma.inscrever` continua DE FORA, e
        # nao por cautela — ela e a permissao de inscrever QUALQUER PESSOA e de
        # confirmar a inscricao dos outros. A tela de 403 mandava pedi-la, que e
        # o unico conselho que ninguem podia seguir.
        "permissoes": _p(
            "processo.ver", "parecer.ver", "treinamento.ver", "turma.inscrever_se",
            "epi.ver", "epi.requisitar",
        ),
    },
    "auditor_interno": {
        "nome": "Auditor interno",
        "base_normativa": "Leitura ampla, escrita nenhuma.",
        "permissoes": _p(
            "processo.ver", "parecer.ver", "laudo.ver", "exposicao.ver", "exportar",
            "auditoria.ver", "indicador.ver",
            "treinamento.ver", "certificado.ver",
            "epi.ver", "epi.ficha",
            # leitura ampla, escrita nenhuma: e a fila que mostra o trabalho que
            # o setor faz FORA do SEI, e e justamente esse o trabalho que uma
            # auditoria por processo nao enxerga
            "demanda.ver",
        ),
    },
}

# Escopo aplicado ao filtro de repositorio. TEM de ter uma entrada para cada
# perfil de MATRIZ_PERFIS — `_conferir_escopos()`, logo abaixo, recusa o
# contrario e derruba a importacao do modulo.
ESCOPO_POR_PERFIL: dict[str, str] = {
    "admin_ti": ESCOPO_AGREGADO,
    "superintendente": ESCOPO_UNIDADE,
    "coordenador_csso": ESCOPO_UNIDADE,
    "engenheiro_seguranca": ESCOPO_UNIDADE,
    "medico_trabalho": ESCOPO_UNIDADE,
    "tecnico_seguranca": ESCOPO_UNIDADE,
    # `E` como o §8 do desenho pede, e nao `P`: o estoque e do setor, nao de
    # ninguem. Em escopo proprio `aplicar_escopo` procuraria `servidor_id` em
    # `epi_entrada_estoque`, nao acharia, e devolveria `where(False)` — o
    # almoxarife abriria a tela do estoque e veria zero lotes, sem erro nenhum.
    "almoxarife_sesmt": ESCOPO_UNIDADE,
    "secretaria_csso": ESCOPO_UNIDADE,
    "consulta_progep": ESCOPO_UNIDADE,
    "servidor_consulta": ESCOPO_PROPRIO,
    "auditor_interno": ESCOPO_TOTAL,
}

ESCOPOS_VALIDOS = (ESCOPO_TOTAL, ESCOPO_UNIDADE, ESCOPO_PROPRIO, ESCOPO_AGREGADO)


def _conferir_escopos() -> None:
    """Perfil sem escopo declarado quebra o sistema em silencio — aqui, nao.

    O modo de falha: perfil novo entra em MATRIZ_PERFIS, ninguem lembra de
    ESCOPO_POR_PERFIL, e `UsuarioAtual.escopo` cai em escopo proprio. Sobre
    tabela sem `servidor_id`, `aplicar_escopo` devolve `where(False)` — a pessoa
    abre a tela, ve zero linhas e conclui que nao ha nada, quando o que nao ha e
    permissao. Nenhum erro em lugar nenhum.

    Por isso as duas listas sao conferidas na importacao do modulo: quem declarar
    perfil sem escopo nao sobe o sistema, e descobre no primeiro `import` em vez
    de descobrir por uma reclamacao de tela vazia meses depois.
    """
    sem_escopo = sorted(set(MATRIZ_PERFIS) - set(ESCOPO_POR_PERFIL))
    sem_perfil = sorted(set(ESCOPO_POR_PERFIL) - set(MATRIZ_PERFIS))
    invalidos = sorted(
        f"{codigo}={nivel!r}"
        for codigo, nivel in ESCOPO_POR_PERFIL.items()
        if nivel not in ESCOPOS_VALIDOS
    )
    problemas = []
    if sem_escopo:
        problemas.append(
            "perfil em MATRIZ_PERFIS sem entrada em ESCOPO_POR_PERFIL: "
            + ", ".join(sem_escopo)
        )
    if sem_perfil:
        problemas.append(
            "escopo declarado para perfil que nao existe em MATRIZ_PERFIS: "
            + ", ".join(sem_perfil)
        )
    if invalidos:
        problemas.append("nivel de escopo desconhecido: " + ", ".join(invalidos))
    if problemas:
        raise RuntimeError("RBAC mal declarado — " + "; ".join(problemas))


_conferir_escopos()


MENSAGEM_RN01 = (
    "Bloqueado: a IN SGP/SEDGG/ME nº 15/2022, art. 10, §2º, I admite subscrição do "
    "laudo apenas por servidor público federal, estadual, distrital ou municipal, ou "
    "militar, ocupante de cargo/posto de médico com especialização em medicina do "
    "trabalho, ou de engenheiro ou arquiteto com especialização em segurança do "
    "trabalho."
)


class PermissaoNegada(PermissionError):
    def __init__(self, codigo: str, detalhe: str | None = None):
        self.codigo = codigo
        super().__init__(detalhe or f"Permissao negada: {codigo}")


class EscopoNaoDeclarado(PermissaoNegada):
    """Perfil gravado no banco que nao consta de ESCOPO_POR_PERFIL.

    `_conferir_escopos()` ja garante isso para os perfis do codigo; sobra o
    perfil inserido a mao por SQL. Nega em vez de cair em escopo proprio: uma
    tela de erro dizendo qual perfil esta mal declarado se conserta em minutos,
    uma lista vazia sem erro nao se conserta porque ninguem sabe que ela esta
    errada.
    """

    def __init__(self, perfil: str):
        self.perfil = perfil
        super().__init__(
            "escopo",
            f"O perfil '{perfil}' não tem escopo declarado em ESCOPO_POR_PERFIL. "
            "Nenhum dado será listado enquanto isso não for corrigido no código — "
            "avise o administrador do sistema.",
        )


@dataclass
class UsuarioAtual:
    """Identidade resolvida da sessao - o que rotas e servicos recebem."""

    id: int
    login: str
    nome: str
    permissoes: frozenset[str]
    perfis: tuple[str, ...]
    campi: tuple[int, ...] = ()
    servidor_id: int | None = None
    precisa_trocar_senha: bool = False
    habilitacoes: tuple[int, ...] = field(default_factory=tuple)

    def pode(self, codigo: str) -> bool:
        return codigo in self.permissoes

    def exigir(self, codigo: str) -> None:
        if not self.pode(codigo):
            raise PermissaoNegada(codigo)

    @property
    def escopo(self) -> str:
        niveis = []
        for perfil in self.perfis:
            nivel = ESCOPO_POR_PERFIL.get(perfil)
            if nivel is None:
                raise EscopoNaoDeclarado(perfil)
            niveis.append(nivel)
        for nivel in (ESCOPO_TOTAL, ESCOPO_UNIDADE, ESCOPO_AGREGADO, ESCOPO_PROPRIO):
            if nivel in niveis:
                return nivel
        # usuario sem perfil vigente: ve o que e dele e mais nada
        return ESCOPO_PROPRIO

    @property
    def ve_dado_nominal(self) -> bool:
        """RN-19: quem pode ler a pessoa pelo nome, e nao pelo codigo opaco.

        `epi.ficha` entrou na conta com a fatia 3, e nao afrouxa a RN-19 — ela
        so a torna coerente com o que ja concedia. A permissao e, na propria
        definicao, "ver a ficha de EPI NOMINAL de qualquer servidor": mascarar o
        nome em seguida tornaria inutil exatamente a tela que ela autoriza, e
        pior — quem entrega EPI precisa saber a quem esta entregando, senao a
        assinatura do comprovante nao prova nada.

        Ate a fatia 2 isso nunca aparecia porque todo perfil com `epi.ficha`
        tambem tinha `exposicao.ver`. O `almoxarife_sesmt` e o primeiro que nao
        tem — e nem deve ter: exposicao a agente nocivo e dado de saude, e a base
        normativa do perfil diz que ele nao a ve. Ele escolheria o servidor num
        seletor de `SRV-3f7a` e entregaria a bota para o codigo errado.

        A conta continua fechada nos dois sentidos: quem nao tem nenhuma das duas
        (secretaria, admin de TI) segue lendo o identificador opaco, e o titular
        segue vendo o proprio nome por `pode_ver_nominal`.
        """
        return self.pode("exposicao.ver") or self.pode("epi.ficha")


def carregar_usuario_atual(s: Session, usuario_id: int, hoje: date | None = None) -> UsuarioAtual:
    from app.modelos import Atribuicao, ProfissionalHabilitado, Usuario

    hoje = hoje or date.today()
    usuario = s.get(Usuario, usuario_id)
    if usuario is None or not usuario.ativo:
        raise PermissaoNegada("sessao", "usuario inativo ou inexistente")

    atribuicoes = [
        a
        for a in s.execute(
            select(Atribuicao).where(Atribuicao.usuario_id == usuario_id)
        ).scalars()
        if a.vigente_em(hoje)
    ]
    permissoes: set[str] = set()
    perfis: list[str] = []
    campi: set[int] = set()
    for atribuicao in atribuicoes:
        perfil = atribuicao.perfil
        if perfil is None or not perfil.ativo:
            continue
        perfis.append(perfil.codigo)
        permissoes.update(p.codigo for p in perfil.permissoes)
        if atribuicao.campus_id:
            campi.add(atribuicao.campus_id)

    habilitacoes = tuple(
        h.id
        for h in s.execute(
            select(ProfissionalHabilitado).where(
                ProfissionalHabilitado.usuario_id == usuario_id
            )
        ).scalars()
        if h.vigente_em(hoje)
    )

    return UsuarioAtual(
        id=usuario.id,
        login=usuario.login,
        nome=usuario.nome,
        permissoes=frozenset(permissoes),
        perfis=tuple(perfis),
        campi=tuple(sorted(campi)),
        servidor_id=usuario.servidor_id,
        precisa_trocar_senha=usuario.precisa_trocar_senha,
        habilitacoes=habilitacoes,
    )


# ---------------------------------------------------------------------
# RN-01 - a habilitacao confere, nao o cargo
# ---------------------------------------------------------------------
def pode_subscrever(
    s: Session, usuario: UsuarioAtual, quando: date | None = None
) -> bool:
    from app.modelos import ProfissionalHabilitado

    quando = quando or date.today()
    if not usuario.pode("parecer.assinar"):
        return False
    habilitacoes = s.execute(
        select(ProfissionalHabilitado).where(
            ProfissionalHabilitado.usuario_id == usuario.id
        )
    ).scalars()
    return any(h.vigente_em(quando) for h in habilitacoes)


def exigir_subscricao(s: Session, usuario: UsuarioAtual, quando: date | None = None) -> None:
    if not pode_subscrever(s, usuario, quando):
        raise PermissaoNegada("parecer.assinar", MENSAGEM_RN01)


# ---------------------------------------------------------------------
# Filtro de escopo no repositorio
# ---------------------------------------------------------------------
def aplicar_escopo(query, usuario: UsuarioAtual, modelo=None):
    """Todo repositorio DEVE chamar esta funcao. Teste automatizado falha se
    algum repositorio nao a invocar."""
    from app.modelos import Processo

    alvo = modelo or Processo
    escopo = usuario.escopo
    if escopo in (ESCOPO_TOTAL, ESCOPO_AGREGADO):
        return query
    if escopo == ESCOPO_PROPRIO:
        coluna = getattr(alvo, "servidor_id", None)
        if coluna is None and getattr(alvo, "__tablename__", None) == "servidor":
            # `Servidor` e a unica tabela em que "o servidor desta linha" nao se
            # chama `servidor_id`: e a chave primaria. Sem esta linha, o cadastro
            # cairia no ramo de baixo e responderia `where(False)` com o aviso de
            # modelo mal escolhido — quando o modelo esta certo e a coluna
            # existe, so com outro nome. Escrever a excecao aqui, e nao na tela,
            # e o que impede a proxima consulta a `Servidor` de inventar a
            # terceira leitura do que "proprio" quer dizer.
            coluna = alvo.id
        if coluna is None:
            # negar e o certo, calar nao: sem `servidor_id` nao ha como dizer o
            # que e "proprio", entao a tela fica vazia e parece que nao ha dado.
            # O log e o unico rastro de que a lista veio vazia por escopo.
            # `usuario.id`, e nao `usuario.login`. O `login` sai da parte local
            # do e-mail institucional (`autenticacao.usuario_a_partir_do_email`),
            # ou seja, tipicamente `nome.sobrenome`: e nome de pessoa, e nome de
            # pessoa nao entra em arquivo de log (ROPA §6). Enquanto o log era
            # efemero — stderr de uma janela que fechava — isso era tolerado; a
            # partir do momento em que ha arquivo com retencao, nao e mais.
            log.warning(
                "escopo proprio sobre %s, que nao tem servidor_id: lista vazia "
                "para a conta %s (perfis: %s)",
                getattr(alvo, "__tablename__", alvo),
                usuario.id,
                ", ".join(usuario.perfis) or "nenhum",
            )
            return query.where(False)
        return query.where(coluna == (usuario.servidor_id or -1))
    # ESCOPO_UNIDADE: sem campus atribuido = coordenadoria inteira
    if not usuario.campi:
        return query
    coluna_campus = getattr(alvo, "campus_id", None)
    if coluna_campus is not None:
        return query.where(coluna_campus.in_(usuario.campi))
    return query
