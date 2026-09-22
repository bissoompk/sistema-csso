"""Maquinas de estado (SS4 do prompt).

A) PROCESSO       - 18 estados de fluxo + NAO_INICIADO (so cartoes migrados).
B) DIREITO        - adicional concedido.
C) EPI_REQUISICAO - o envelope do pedido de EPI (EPI, fatia 4).
D) EPI_ITEM       - a linha do pedido, onde a decisao acontece (EPI, fatia 4).
E) TURMA          - turma de treinamento (Certificados, fatia 2).
F) INSCRICAO      - a pessoa dentro da turma (Certificados, fatias 2 e 3).
H) DEMANDA        - o pedido que chegou por e-mail ou no balcao (base).

G continua reservada para ocorrencia de acidente, e por isso a demanda pegou o
H mesmo entrando antes: a numeracao vem do plano consolidado (SS1.9) e existe
para que dois modulos nao chamem de "maquina C" duas coisas diferentes. Reusar
a letra vaga pouparia uma linha aqui e custaria a leitura de todo documento de
desenho que ja escreveu "maquina G" pensando em acidente.

A coluna do kanban e visao; o estado e verdade.

Toda maquina e um `dict[str, frozenset[str]]` de origem -> destinos admitidos,
mais um mapa de rotulos, e e conferida por `pode`/`exigir`, logo abaixo. O que
NAO esta declarado e proibido: e por isso que a tabela precisa listar ate os
estados terminais, com conjunto vazio, em vez de omiti-los.
"""

from __future__ import annotations

# ---------------------------------------------------------------------
# A) Maquina do PROCESSO
# ---------------------------------------------------------------------
ESTADOS_PROCESSO: tuple[str, ...] = (
    "NAO_INICIADO",
    "RECEBIDO",
    "EM_TRIAGEM",
    "PENDENTE_DOCUMENTO",
    "AGUARDANDO_INSPECAO",
    "INSPECIONADO",
    "AGUARDANDO_QUANTIFICACAO",
    "LAUDO_EM_ELABORACAO",
    "LAUDO_EMITIDO",
    "PARECER_EM_ELABORACAO",
    "PARECER_PRONTO_P_ASSINATURA",
    "PARECER_ASSINADO",
    "INSERIDO_NO_SEI",
    "DEVOLVIDO_A_PROGEP",
    "CONCLUIDO",
    "INDEFERIDO_TECNICAMENTE",
    "ARQUIVADO",
    "SOBRESTADO",
    "EM_RECURSO",
)

# Transicoes nao listadas sao proibidas. SOBRESTADO e tratado a parte.
TRANSICOES: dict[str, frozenset[str]] = {
    "NAO_INICIADO": frozenset({"RECEBIDO", "EM_TRIAGEM", "ARQUIVADO"}),
    "RECEBIDO": frozenset({"EM_TRIAGEM"}),
    "EM_TRIAGEM": frozenset(
        {
            "PENDENTE_DOCUMENTO",
            "AGUARDANDO_INSPECAO",
            "PARECER_EM_ELABORACAO",  # atalho por reuso de laudo (art. 10 SS3)
            "INDEFERIDO_TECNICAMENTE",
            "ARQUIVADO",
        }
    ),
    "PENDENTE_DOCUMENTO": frozenset({"EM_TRIAGEM", "SOBRESTADO", "ARQUIVADO"}),
    "AGUARDANDO_INSPECAO": frozenset({"INSPECIONADO"}),
    "INSPECIONADO": frozenset(
        {"AGUARDANDO_QUANTIFICACAO", "LAUDO_EM_ELABORACAO", "INDEFERIDO_TECNICAMENTE"}
    ),
    "AGUARDANDO_QUANTIFICACAO": frozenset({"LAUDO_EM_ELABORACAO"}),
    "LAUDO_EM_ELABORACAO": frozenset({"LAUDO_EMITIDO"}),
    "LAUDO_EMITIDO": frozenset({"PARECER_EM_ELABORACAO"}),
    "PARECER_EM_ELABORACAO": frozenset({"PARECER_PRONTO_P_ASSINATURA"}),
    "PARECER_PRONTO_P_ASSINATURA": frozenset({"PARECER_ASSINADO"}),
    "PARECER_ASSINADO": frozenset({"INSERIDO_NO_SEI"}),
    "INSERIDO_NO_SEI": frozenset({"DEVOLVIDO_A_PROGEP"}),
    "DEVOLVIDO_A_PROGEP": frozenset({"CONCLUIDO"}),
    "CONCLUIDO": frozenset({"EM_RECURSO"}),
    "INDEFERIDO_TECNICAMENTE": frozenset({"EM_RECURSO"}),
    "EM_RECURSO": frozenset({"EM_TRIAGEM"}),
    "ARQUIVADO": frozenset(),
    "SOBRESTADO": frozenset(),  # volta ao estado_anterior
}

# Atalho legitimo: EM_TRIAGEM -> PARECER_EM_ELABORACAO exige laudo vigente
ATALHO_REUSO_LAUDO = ("EM_TRIAGEM", "PARECER_EM_ELABORACAO")

ESTADO_PARA_COLUNA: dict[str, str] = {
    "NAO_INICIADO": "NAO_INICIADO",
    "RECEBIDO": "A_FAZER",
    "EM_TRIAGEM": "A_FAZER",
    "PENDENTE_DOCUMENTO": "AGUARDANDO",
    "SOBRESTADO": "AGUARDANDO",
    "AGUARDANDO_QUANTIFICACAO": "AGUARDANDO",
    "PARECER_PRONTO_P_ASSINATURA": "AGUARDANDO",
    "DEVOLVIDO_A_PROGEP": "AGUARDANDO",
    "AGUARDANDO_INSPECAO": "EM_ANDAMENTO",
    "INSPECIONADO": "EM_ANDAMENTO",
    "LAUDO_EM_ELABORACAO": "EM_ANDAMENTO",
    "LAUDO_EMITIDO": "EM_ANDAMENTO",
    "PARECER_EM_ELABORACAO": "EM_ANDAMENTO",
    "PARECER_ASSINADO": "EM_ANDAMENTO",
    "INSERIDO_NO_SEI": "EM_ANDAMENTO",
    "EM_RECURSO": "EM_ANDAMENTO",
    "CONCLUIDO": "CONCLUIDO",
    "INDEFERIDO_TECNICAMENTE": "CONCLUIDO",
    "ARQUIVADO": "CONCLUIDO",
}

ROTULO_ESTADO: dict[str, str] = {
    "NAO_INICIADO": "Nao iniciado",
    "RECEBIDO": "Recebido",
    "EM_TRIAGEM": "Em triagem",
    "PENDENTE_DOCUMENTO": "Pendente de documento",
    "AGUARDANDO_INSPECAO": "Aguardando inspecao",
    "INSPECIONADO": "Inspecionado",
    "AGUARDANDO_QUANTIFICACAO": "Aguardando quantificacao",
    "LAUDO_EM_ELABORACAO": "Laudo em elaboracao",
    "LAUDO_EMITIDO": "Laudo emitido",
    "PARECER_EM_ELABORACAO": "Parecer em elaboracao",
    "PARECER_PRONTO_P_ASSINATURA": "Parecer pronto para assinatura",
    "PARECER_ASSINADO": "Parecer assinado",
    "INSERIDO_NO_SEI": "Inserido no SEI",
    "DEVOLVIDO_A_PROGEP": "Devolvido a PROGEP",
    "CONCLUIDO": "Concluido",
    "INDEFERIDO_TECNICAMENTE": "Indeferido tecnicamente",
    "ARQUIVADO": "Arquivado",
    "SOBRESTADO": "Sobrestado",
    "EM_RECURSO": "Em recurso",
}

# O mesmo mapa com acento, e SO para a tela.
#
# Dois mapas, e nao um, pelo mesmo motivo que `macros.html` ja registrou ao
# criar o `ROTULO_TURMA_TELA`: o de cima e lido tambem por mensagem de servico e
# por descricao de trilha de auditoria, que e texto gravado e conferido por
# digest — reescrever aquelas cadeias trocaria o texto de eventos ja assinados
# pelo encadeamento de hash. A chave NUNCA muda: e ela que esta no banco, no
# `CHECK` da tabela e na tabela de transicoes. O que muda e so o que a pessoa le.
#
# Enquanto os dois existirem eles precisam ter as mesmas chaves — `test_estados`
# confere. Estado novo entra nos dois, ou a tela cai no recuo e volta a escrever
# o codigo cru.
ROTULO_ESTADO_TELA: dict[str, str] = {
    "NAO_INICIADO": "Não iniciado",
    "RECEBIDO": "Recebido",
    "EM_TRIAGEM": "Em triagem",
    "PENDENTE_DOCUMENTO": "Pendente de documento",
    "AGUARDANDO_INSPECAO": "Aguardando inspeção",
    "INSPECIONADO": "Inspecionado",
    "AGUARDANDO_QUANTIFICACAO": "Aguardando quantificação",
    "LAUDO_EM_ELABORACAO": "Laudo em elaboração",
    "LAUDO_EMITIDO": "Laudo emitido",
    "PARECER_EM_ELABORACAO": "Parecer em elaboração",
    "PARECER_PRONTO_P_ASSINATURA": "Parecer pronto para assinatura",
    "PARECER_ASSINADO": "Parecer assinado",
    "INSERIDO_NO_SEI": "Inserido no SEI",
    "DEVOLVIDO_A_PROGEP": "Devolvido à PROGEP",
    "CONCLUIDO": "Concluído",
    "INDEFERIDO_TECNICAMENTE": "Indeferido tecnicamente",
    "ARQUIVADO": "Arquivado",
    "SOBRESTADO": "Sobrestado",
    "EM_RECURSO": "Em recurso",
}

# Incisos do art. 11 da IN 15/2022 - obrigatorio ao indeferir tecnicamente
INCISOS_ART11: dict[str, str] = {
    "I": "exposicao eventual, sem a excecao do art. 9o, paragrafo unico",
    "II": "atividade-meio, sem exposicao ao agente nocivo",
    "III": "local inadequado por gestao deficiente, sanavel por medida administrativa",
    "IV": "chefia sem comprovacao individual de exposicao",
}

# ---------------------------------------------------------------------
# B) Maquina do DIREITO
# ---------------------------------------------------------------------
ESTADOS_DIREITO: tuple[str, ...] = (
    "PROPOSTO",
    "VIGENTE",
    "SUSPENSO",
    "EM_REAVALIACAO",
    "ALTERADO",
    "CESSADO",
)

TRANSICOES_DIREITO: dict[str, frozenset[str]] = {
    "PROPOSTO": frozenset({"VIGENTE", "CESSADO"}),
    "VIGENTE": frozenset({"SUSPENSO", "EM_REAVALIACAO", "ALTERADO", "CESSADO"}),
    "SUSPENSO": frozenset({"VIGENTE", "CESSADO", "EM_REAVALIACAO"}),
    "EM_REAVALIACAO": frozenset({"VIGENTE", "ALTERADO", "CESSADO", "SUSPENSO"}),
    "ALTERADO": frozenset({"VIGENTE", "CESSADO", "EM_REAVALIACAO"}),
    "CESSADO": frozenset(),
}

ROTULO_DIREITO: dict[str, str] = {
    "PROPOSTO": "Proposto",
    "VIGENTE": "Vigente",
    "SUSPENSO": "Suspenso",
    "EM_REAVALIACAO": "Em reavaliacao",
    "ALTERADO": "Alterado",
    "CESSADO": "Cessado",
}

# ---------------------------------------------------------------------
# C) Maquina da REQUISICAO DE EPI — o envelope
# ---------------------------------------------------------------------
# Duas maquinas, e nao uma, porque o legado misturava as duas coisas numa fila
# so ("requisitada -> aprovada -> recusada -> aguardando estoque -> reservada ->
# liberada -> entregue"). Aprovar e recusar sao decisoes DO ITEM: aprova-se a
# luva e recusa-se o respirador do mesmo pedido, e a tela do legado ja fazia
# isso — a maquina dele e que nao acompanhou. Aqui o envelope so diz em que
# ponto do tramite o pedido esta; quem carrega a decisao e a maquina D.
ESTADOS_EPI_REQUISICAO: tuple[str, ...] = (
    "RASCUNHO",
    "ENVIADA",
    "EM_ANALISE",
    "ANALISADA",
    "EM_ATENDIMENTO",
    "ATENDIDA",
    "INDEFERIDA",
    "CANCELADA",
)

TRANSICOES_EPI_REQUISICAO: dict[str, frozenset[str]] = {
    # RASCUNHO e o unico estado que tambem admite exclusao fisica (RN-31): o
    # pedido em digitacao ainda nao e documento de ninguem. Cancelar tambem vale
    # — quem desistiu depois de ja ter escrito prefere deixar o motivo escrito.
    "RASCUNHO": frozenset({"ENVIADA", "CANCELADA"}),
    "ENVIADA": frozenset({"EM_ANALISE", "CANCELADA"}),
    # a volta para ENVIADA e devolver a fila: o analista abriu, viu que o caso
    # nao e dele (ou que falta informacao) e solta o pedido. Sem essa aresta, a
    # unica saida de EM_ANALISE seria decidir — e decidir sem base e pior do que
    # devolver.
    "EM_ANALISE": frozenset({"ENVIADA", "ANALISADA", "INDEFERIDA", "CANCELADA"}),
    "ANALISADA": frozenset({"EM_ATENDIMENTO", "CANCELADA"}),
    "EM_ATENDIMENTO": frozenset({"ATENDIDA", "CANCELADA"}),
    # reconsideracao: o unico caminho de volta de um terminal, e e de propria
    # coordenacao. Existe porque o legado nao tinha nenhum — indeferimento
    # errado so se consertava abrindo pedido novo, que apaga a historia de que
    # houve um erro.
    "INDEFERIDA": frozenset({"EM_ANALISE"}),
    "ATENDIDA": frozenset(),
    "CANCELADA": frozenset(),
}

ROTULO_EPI_REQUISICAO: dict[str, str] = {
    "RASCUNHO": "Rascunho",
    "ENVIADA": "Enviada",
    "EM_ANALISE": "Em análise",
    "ANALISADA": "Analisada",
    "EM_ATENDIMENTO": "Em atendimento",
    "ATENDIDA": "Atendida",
    "INDEFERIDA": "Indeferida",
    "CANCELADA": "Cancelada",
}

# Onde ainda cabe cancelar sem apagar nada: o envelope que ainda nao entregou
# equipamento nenhum. ATENDIDA e INDEFERIDA ficam de fora porque ja sao
# resposta dada, e CANCELADA porque ja e o proprio destino.
EPI_REQUISICAO_CANCELAVEL: frozenset[str] = frozenset(
    {"RASCUNHO", "ENVIADA", "EM_ANALISE", "ANALISADA", "EM_ATENDIMENTO"}
)

# Os terminais. Fila e indicador leem daqui em vez de repetir a lista.
EPI_REQUISICAO_ENCERRADA: frozenset[str] = frozenset(
    {"ATENDIDA", "INDEFERIDA", "CANCELADA"}
)

# ---------------------------------------------------------------------
# D) Maquina do ITEM DE REQUISICAO DE EPI — onde o trabalho acontece
# ---------------------------------------------------------------------
ESTADOS_EPI_ITEM: tuple[str, ...] = (
    "SOLICITADO",
    "APROVADO",
    "RESERVADO",
    "SEM_ESTOQUE",
    "ENTREGUE",
    "RECUSADO",
    "CANCELADO",
)

TRANSICOES_EPI_ITEM: dict[str, frozenset[str]] = {
    # SOLICITADO -> CANCELADO nao esta na tabela do SS4.3 do desenho, e entra
    # aqui de propósito: cancelar o envelope em ENVIADA (que a maquina C admite)
    # deixaria os itens parados em SOLICITADO, dentro de um pedido terminal.
    # Estado que nao descreve fato nenhum e o defeito que a propria SS4.1 aponta
    # em "liberada" — e a fila de analise passaria a exibir item de requisicao
    # que ninguem vai decidir.
    "SOLICITADO": frozenset({"APROVADO", "RECUSADO", "CANCELADO"}),
    # APROVADO -> ENTREGUE e a fatia 4 sem reserva (SS10: "Aprovar e entregar
    # direto"). RESERVADO e SEM_ESTOQUE existem na maquina porque a reserva e o
    # que impede dois pedidos de prometerem o mesmo par de botas — mas ninguem
    # os alcanca ainda, e declara-los agora e o que permite a reserva entrar
    # depois sem reescrever a maquina inteira.
    "APROVADO": frozenset({"RESERVADO", "SEM_ESTOQUE", "ENTREGUE", "CANCELADO"}),
    "RESERVADO": frozenset({"ENTREGUE", "SEM_ESTOQUE", "CANCELADO"}),
    "SEM_ESTOQUE": frozenset({"RESERVADO", "CANCELADO"}),
    # Os tres terminais. Devolucao, substituicao e descarte NAO mudam o estado
    # do item: sao fatos posteriores e viram linha nova na ficha. Um item
    # entregue continua entregue; o que muda e a ficha da pessoa, que e onde
    # essa historia pertence.
    "ENTREGUE": frozenset(),
    "RECUSADO": frozenset(),
    "CANCELADO": frozenset(),
}

ROTULO_EPI_ITEM: dict[str, str] = {
    "SOLICITADO": "Solicitado",
    "APROVADO": "Aprovado",
    "RESERVADO": "Reservado",
    "SEM_ESTOQUE": "Sem estoque",
    "ENTREGUE": "Entregue",
    "RECUSADO": "Recusado",
    "CANCELADO": "Cancelado",
}

# Item ja decidido pelo analista. `ANALISADA` e `INDEFERIDA` exigem que TODO
# item esteja aqui — analise pela metade nao e analise.
EPI_ITEM_DECIDIDO: frozenset[str] = frozenset(
    {"APROVADO", "RESERVADO", "SEM_ESTOQUE", "ENTREGUE", "RECUSADO", "CANCELADO"}
)

# Item aprovado que ainda deve alguma coisa ao requerente. Enquanto houver um
# destes, o envelope nao esta ATENDIDO.
EPI_ITEM_PENDENTE_DE_ATENDIMENTO: frozenset[str] = frozenset(
    {"APROVADO", "RESERVADO", "SEM_ESTOQUE"}
)

# ---------------------------------------------------------------------
# E) Maquina da TURMA
# ---------------------------------------------------------------------
ESTADOS_TURMA: tuple[str, ...] = (
    "PLANEJADA",
    "INSCRICOES_ABERTAS",
    "EM_ANDAMENTO",
    "CONCLUIDA",
    "CANCELADA",
)

TRANSICOES_TURMA: dict[str, frozenset[str]] = {
    # comeca sem inscricao aberta: a turma existe na agenda antes de ter vaga
    "PLANEJADA": frozenset({"INSCRICOES_ABERTAS", "EM_ANDAMENTO", "CANCELADA"}),
    # voltar para PLANEJADA e fechar a inscricao sem cancelar a turma: acontece
    # quando as vagas esgotam ou a data e adiada. Sem essa volta, o unico jeito
    # de parar de receber inscrito antes do inicio seria cancelar a turma.
    "INSCRICOES_ABERTAS": frozenset({"PLANEJADA", "EM_ANDAMENTO", "CANCELADA"}),
    "EM_ANDAMENTO": frozenset({"CONCLUIDA", "CANCELADA"}),
    # concluida e terminal: reabrir turma fechada e o que faria um certificado
    # emitido descrever uma turma que mudou depois. Erro se corrige por
    # anulacao e reemissao (SS11, item 12 do desenho), nao por volta de estado.
    "CONCLUIDA": frozenset(),
    "CANCELADA": frozenset(),
}

ROTULO_TURMA: dict[str, str] = {
    "PLANEJADA": "Planejada",
    "INSCRICOES_ABERTAS": "Inscricoes abertas",
    "EM_ANDAMENTO": "Em andamento",
    "CONCLUIDA": "Concluida",
    "CANCELADA": "Cancelada",
}

# Situacoes em que a turma ainda aceita inscricao. EM_ANDAMENTO entra porque
# treinamento de NR recebe retardatario no primeiro dia; CONCLUIDA e CANCELADA
# nao, porque inscrever em turma fechada e reescrever historia.
TURMA_ACEITA_INSCRICAO: frozenset[str] = frozenset(
    {"PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"}
)

# ---------------------------------------------------------------------
# F) Maquina da INSCRICAO
# ---------------------------------------------------------------------
ESTADOS_INSCRICAO: tuple[str, ...] = (
    "AGUARDANDO_EMAIL",
    "INSCRITA",
    "CONFIRMADA",
    "PRESENTE",
    "AUSENTE",
    "APROVADO",
    "REPROVADO",
    "CANCELADA",
)

TRANSICOES_INSCRICAO: dict[str, frozenset[str]] = {
    # so a inscricao publica nasce aqui (fatia 6); a interna ja nasce INSCRITA
    "AGUARDANDO_EMAIL": frozenset({"INSCRITA", "CANCELADA"}),
    # AUSENTE entrou na fatia 3: no fecho da turma, quem nunca foi confirmado e
    # nunca compareceu termina AUSENTE (SS7 do desenho). Sem esta aresta a turma
    # fecharia deixando gente "inscrita" numa turma que ja acabou — estado que
    # nao descreve nada e que o monitor de reciclagem nao sabe ler. PRESENTE
    # continua fora de proposito: quem compareceu passa por CONFIRMADA, e e o
    # proprio lancamento de presenca que faz e audita essa confirmacao.
    "INSCRITA": frozenset({"CONFIRMADA", "AUSENTE", "CANCELADA"}),
    "CONFIRMADA": frozenset({"PRESENTE", "AUSENTE", "CANCELADA"}),
    # PRESENTE <-> AUSENTE porque lancamento de presenca se corrige (fatia 3);
    # o resultado so vem depois de um dos dois, e e isso que impede APROVADO de
    # aparecer antes de a pessoa ter comparecido.
    "PRESENTE": frozenset({"AUSENTE", "APROVADO", "REPROVADO"}),
    "AUSENTE": frozenset({"PRESENTE", "REPROVADO"}),
    # Fatia 3: APROVADO e REPROVADO deixam de ser terminais, e SO um vira o
    # outro. O caso concreto: a turma fechou na sexta e na segunda aparece a
    # folha de um dia que ninguem lancou — Maria consta REPROVADA com 50% tendo
    # feito o curso inteiro. Sem esta aresta a unica saida seria SQL a mao.
    #
    # A volta para PRESENTE/AUSENTE continua proibida de proposito: inscricao de
    # turma concluida SEMPRE tem resultado, e apagar o resultado sem pôr outro no
    # lugar produz um estado que ninguem consegue explicar depois.
    #
    # E a aresta nao e passagem livre: `presenca.py` so a percorre dentro da
    # retificacao, que exige `turma.concluir`, exige motivo por escrito, recalcula
    # a frequencia a partir dos lancamentos (para numero e resultado nao
    # divergirem) e audita RESULTADO_RETIFICADO. Erro se corrige por ato
    # registrado, nao por volta de estado silenciosa.
    "APROVADO": frozenset({"REPROVADO"}),
    "REPROVADO": frozenset({"APROVADO"}),
    "CANCELADA": frozenset(),
}

ROTULO_INSCRICAO: dict[str, str] = {
    "AGUARDANDO_EMAIL": "Aguardando confirmacao de e-mail",
    "INSCRITA": "Inscrita",
    "CONFIRMADA": "Confirmada",
    "PRESENTE": "Presente",
    "AUSENTE": "Ausente",
    "APROVADO": "Aprovado",
    "REPROVADO": "Reprovado",
    "CANCELADA": "Cancelada",
}

# Quem conta para a vaga. Inscricao cancelada devolve a vaga; a que aguarda
# confirmacao de e-mail ainda nao a ocupa (SS7, trava 2 do desenho).
INSCRICAO_OCUPA_VAGA: frozenset[str] = frozenset(
    {"INSCRITA", "CONFIRMADA", "PRESENTE", "AUSENTE", "APROVADO", "REPROVADO"}
)

# O resultado da turma. So estes dois habilitam (ou barram) a emissao do
# certificado na fatia 4, e so eles admitem retificacao.
INSCRICAO_COM_RESULTADO: frozenset[str] = frozenset({"APROVADO", "REPROVADO"})

# Quem o fecho da turma NAO apura. A cancelada saiu por ato proprio, com motivo
# registrado; a que aguarda confirmacao de e-mail nunca chegou a ser inscricao
# (SS7, trava 2) e transforma-la em ausente inventaria uma falta de quem talvez
# nem tenha pedido vaga.
INSCRICAO_FORA_DA_APURACAO: frozenset[str] = frozenset(
    {"CANCELADA", "AGUARDANDO_EMAIL"}
)

# ---------------------------------------------------------------------
# H) Maquina da DEMANDA — o pedido que chegou e ainda nao virou nada
# ---------------------------------------------------------------------
# Tres estados, e a brevidade e o ponto. A demanda existe porque o pedido que
# chega por e-mail ou no balcao nao cabe em `processo` — que e, por definicao,
# um processo SEI com NUP unico e dezenove estados de instrucao do adicional —
# nem em `pendencia`, que nasce de regra e e tarefa, nao registro. Dar a ela uma
# maquina larga repetiria o erro que a SS4.1 aponta no legado de EPI: estado que
# nao descreve fato nenhum, so intencao de quem desenhou.
#
# `EM_ANDAMENTO` nao e enfeite entre ABERTA e ENCERRADA: e a diferenca entre
# "chegou e ninguem pegou" e "alguem esta cuidando", que e exatamente a pergunta
# de quem abre a lista na segunda-feira. E ABERTA -> ENCERRADA existe direto
# porque muita demanda se resolve no mesmo ato em que se registra ("ja respondi
# por e-mail"): obrigar a passar por EM_ANDAMENTO cobraria um clique para
# descrever um estado que durou zero segundo.
ESTADOS_DEMANDA: tuple[str, ...] = ("ABERTA", "EM_ANDAMENTO", "ENCERRADA")

TRANSICOES_DEMANDA: dict[str, frozenset[str]] = {
    "ABERTA": frozenset({"EM_ANDAMENTO", "ENCERRADA"}),
    "EM_ANDAMENTO": frozenset({"ENCERRADA"}),
    # Terminal, e sem volta. Reabrir apagaria o desfecho, que e a unica coisa
    # que esta tabela existe para guardar — e o desfecho e obrigatorio no fecho
    # justamente para a demanda nao terminar como "sumiu da lista". Demanda que
    # volta a acontecer e demanda NOVA, com data de chegada nova, e o
    # encaminhamento da antiga continua legivel ao lado (RN-31).
    "ENCERRADA": frozenset(),
}

ROTULO_DEMANDA: dict[str, str] = {
    "ABERTA": "Aberta",
    "EM_ANDAMENTO": "Em andamento",
    "ENCERRADA": "Encerrada",
}

# Por onde a demanda chegou. E vocabulario fechado porque a pergunta que ele
# responde e contavel — "quanto do nosso trabalho entra por fora do SEI?" —, e
# texto livre aqui devolveria "email", "e-mail", "E-mail" e "correio
# eletronico" na mesma coluna. A ordem e a do formulario, e o mais comum vem
# primeiro: a entrada tem de caber em trinta segundos.
CANAIS_DEMANDA: tuple[str, ...] = (
    "EMAIL",
    "PRESENCIAL",
    "TELEFONE",
    "OFICIO",
    "OUTRO",
)

ROTULO_CANAL_DEMANDA: dict[str, str] = {
    "EMAIL": "E-mail",
    "PRESENCIAL": "Presencial",
    "TELEFONE": "Telefone",
    "OFICIO": "Ofício",
    "OUTRO": "Outro",
}

# Como a demanda terminou. **O desfecho e obrigatorio no encerramento**, e e
# aqui que esta o valor da funcionalidade inteira: sem ele o fecho seria um
# botao "arquivar", e a lista voltaria a ser o que a caixa de e-mail ja e — um
# lugar onde as coisas somem sem ninguem conseguir dizer o que houve delas.
#
# Cada um cobra a sua prova, e as quatro sao diferentes de proposito:
#   RESOLVIDA       — o que foi feito, por escrito;
#   VIROU_PROCESSO  — o `processo.id` REAL, e nao um NUP digitado: e a
#                     rastreabilidade "esta demanda gerou aquele processo", e
#                     ela so vale se der para clicar;
#   ENCAMINHADA     — para qual setor, e em que data;
#   SEM_PROVIDENCIA — o motivo escrito. E o desfecho mais importante de todos:
#                     "nao vamos fazer nada" e uma decisao legitima, e o que
#                     nao pode e ela ser tomada por esquecimento.
DESFECHOS_DEMANDA: tuple[str, ...] = (
    "RESOLVIDA",
    "VIROU_PROCESSO",
    "ENCAMINHADA",
    "SEM_PROVIDENCIA",
)

ROTULO_DESFECHO_DEMANDA: dict[str, str] = {
    "RESOLVIDA": "Resolvida",
    "VIROU_PROCESSO": "Virou processo SEI",
    "ENCAMINHADA": "Encaminhada a outro setor",
    "SEM_PROVIDENCIA": "Sem providência",
}

# Onde a demanda ainda cobra alguma coisa de alguem. E daqui que saem a lista
# padrao da tela e a decisao de encerrar (ou nao) a pendencia do prazo.
DEMANDA_EM_ABERTO: frozenset[str] = frozenset({"ABERTA", "EM_ANDAMENTO"})


# O rotulo daqui so existe para o cabecalho da coluna do quadro — nenhuma
# mensagem de servico e nenhuma trilha o le (o repositorio usa so o codigo), e
# por isso ele nao precisa do par ASCII/tela: acentua-se em casa. Tudo em caixa
# de frase: "Nao Iniciado" era o unico dos cinco com a segunda palavra em
# maiuscula, e tres estilos de capitalizacao em cinco rotulos e o tipo de
# desalinho que a pessoa ve sem saber nomear.
COLUNAS_KANBAN: tuple[tuple[str, str], ...] = (
    ("NAO_INICIADO", "Não iniciado"),
    ("A_FAZER", "A fazer"),
    ("EM_ANDAMENTO", "Em andamento"),
    ("AGUARDANDO", "Aguardando"),
    ("CONCLUIDO", "Concluído"),
)


class TransicaoInvalida(ValueError):
    """Transicao de estado que a maquina nao admite."""


# ---------------------------------------------------------------------
# O conferidor, um so para todas as maquinas
# ---------------------------------------------------------------------
def pode(transicoes: dict[str, frozenset[str]], origem: str, destino: str) -> bool:
    """Origem desconhecida nao vira porta aberta: `get` cai no conjunto vazio."""
    return destino in transicoes.get(origem, frozenset())


def exigir(
    transicoes: dict[str, frozenset[str]],
    origem: str,
    destino: str,
    rotulos: dict[str, str] | None = None,
) -> None:
    """Recusa a transicao que a maquina nao admite, com a mensagem da tela.

    Existe para que a regra fique no servico, e nao no template: esconder o
    botao nao e guarda nenhuma — o POST continua chegando.
    """
    if pode(transicoes, origem, destino):
        return
    raise TransicaoInvalida(
        _recusa(origem, destino, transicoes.get(origem, frozenset()), rotulos or {})
    )


def _recusa(origem: str, destino: str, saidas, rotulos: dict[str, str]) -> str:
    """A frase da recusa: o que foi pedido, e para onde DÁ para ir.

    Era "Transicao proibida: X -> Y." — sem acento, com seta ASCII, e mudo
    sobre a saída. É o erro mais frequente do kanban (arrastar Recebido direto
    para Aguardando inspeção pula a triagem), e quem o recebia ficava com o
    cartão de volta e nenhuma pista de qual coluna aceitava. As saídas vêm da
    mesma tabela que recusou, então a lista nunca diverge da máquina.

    A mensagem não entra em trilha nenhuma (é exceção, e a rota a devolve à
    tela); por isso ela pode ter acento, ao contrário dos rótulos ASCII que a
    auditoria digere.
    """
    nome = lambda estado: rotulos.get(estado, estado)  # noqa: E731
    frase = f"Transição proibida: {nome(origem)} → {nome(destino)}."
    if saidas:
        lista = ", ".join(sorted(nome(s) for s in saidas))
        frase += f" De “{nome(origem)}” dá para ir a: {lista}."
    else:
        frase += f" “{nome(origem)}” é situação final: não sai para lugar nenhum."
    return frase


def pode_transitar(origem: str, destino: str) -> bool:
    """Maquina A. SOBRESTADO fica a parte: entra de quase todo lugar e volta
    para o estado anterior, que nao cabe numa tabela de origem -> destinos."""
    if destino == "SOBRESTADO":
        return origem not in ("SOBRESTADO", "ARQUIVADO")
    if origem == "SOBRESTADO":
        return destino in ESTADOS_PROCESSO
    return pode(TRANSICOES, origem, destino)


def exigir_transicao(origem: str, destino: str) -> None:
    if not pode_transitar(origem, destino):
        # `ROTULO_ESTADO_TELA`, e não o ASCII: esta frase vai para a tela e para
        # mais nada. SOBRESTADO entra na lista de saídas porque `pode_transitar`
        # o admite de quase todo lugar — a lista tem de dizer o que a máquina
        # de fato aceita, não só o que está na tabela.
        saidas = set(TRANSICOES.get(origem, frozenset()))
        if origem == "SOBRESTADO":
            saidas = set(ESTADOS_PROCESSO)
        elif origem != "ARQUIVADO":
            saidas.add("SOBRESTADO")
        raise TransicaoInvalida(
            _recusa(origem, destino, saidas - {origem}, ROTULO_ESTADO_TELA)
        )


def exigir_transicao_direito(origem: str, destino: str) -> None:
    exigir(TRANSICOES_DIREITO, origem, destino, ROTULO_DIREITO)


def exigir_transicao_epi_requisicao(origem: str, destino: str) -> None:
    exigir(TRANSICOES_EPI_REQUISICAO, origem, destino, ROTULO_EPI_REQUISICAO)


def exigir_transicao_epi_item(origem: str, destino: str) -> None:
    exigir(TRANSICOES_EPI_ITEM, origem, destino, ROTULO_EPI_ITEM)


def exigir_transicao_turma(origem: str, destino: str) -> None:
    exigir(TRANSICOES_TURMA, origem, destino, ROTULO_TURMA)


def exigir_transicao_inscricao(origem: str, destino: str) -> None:
    exigir(TRANSICOES_INSCRICAO, origem, destino, ROTULO_INSCRICAO)


def exigir_transicao_demanda(origem: str, destino: str) -> None:
    exigir(TRANSICOES_DEMANDA, origem, destino, ROTULO_DEMANDA)


def destinos_de_turma(origem: str) -> list[str]:
    """O que a tela pode oferecer a partir da situacao atual — na ordem da
    maquina, nao na do `frozenset`, que nao tem ordem."""
    admitidos = TRANSICOES_TURMA.get(origem, frozenset())
    return [estado for estado in ESTADOS_TURMA if estado in admitidos]


def coluna_de(estado: str) -> str:
    return ESTADO_PARA_COLUNA.get(estado, "A_FAZER")
