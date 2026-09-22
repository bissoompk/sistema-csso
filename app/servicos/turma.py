"""Turma e inscricao interna — as maquinas E e F.

Fatia 2 do modulo Certificados e Treinamentos. Aqui mora tudo o que decide se
uma mudanca pode acontecer; a rota so traduz formulario em chamada e erro em
mensagem.

Isso nao e preferencia de arquitetura: a revisao da fatia 1 achou uma guarda
que existia so no template ("publicar nova versao" ficou de fora do
`{% if vigente %}`) e o POST continuou passando. Esconder botao nunca foi
guarda. Toda recusa desta fatia esta abaixo, e todo teste de recusa bate aqui.

O que NAO esta aqui, de proposito: o lancamento de presenca e de nota e a
apuracao do resultado, que vivem em `app/servicos/presenca.py` (fatia 3), e o
certificado e a inscricao publica, que vem nas fatias 4 e 6.

`mudar_situacao` conhece uma dessas: concluir a turma passou a ser um ato so —
muda o estado E apura cada inscrito, chamando `presenca.apurar_turma` na mesma
transacao.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modelos import (
    AssinaturaInstrutor,
    Inscricao,
    Participante,
    Pendencia,
    Servidor,
    Treinamento,
    Turma,
    TurmaInstrutor,
    agora_utc,
)
from app.modelos.estados import (
    INSCRICAO_OCUPA_VAGA,
    ROTULO_INSCRICAO,
    ROTULO_TURMA,
    exigir_transicao_inscricao,
    exigir_transicao_turma,
)
from app.servicos import auditoria, numeracao, pendencias
from app.servicos.rbac import ESCOPO_PROPRIO, UsuarioAtual, aplicar_escopo

# Abrir inscricao e comecar a turma sao edicao; concluir e cancelar sao decisao
# de quem responde pela turma. Mesma simetria do parecer, em que o tecnico
# emite e nao anula (SS8 do desenho).
PERMISSAO_POR_SITUACAO_TURMA: dict[str, str] = {
    "PLANEJADA": "turma.criar",
    "INSCRICOES_ABERTAS": "turma.criar",
    "EM_ANDAMENTO": "turma.criar",
    "CONCLUIDA": "turma.concluir",
    "CANCELADA": "turma.concluir",
}

# O que se escolhe para uma inscricao. PRESENTE, AUSENTE, APROVADO e REPROVADO
# NAO estao aqui de proposito, e continuam fora depois da fatia 3: sao estados
# DERIVADOS. Presenca sai do lancamento por dia e o resultado sai do fecho da
# turma; oferecer um botao "marcar aprovado" faria a aprovacao existir sem a
# frequencia que a sustenta, que e exatamente o que o desenho evita ao calcular
# `frequencia_percentual` em vez de deixar alguem digita-la.
PERMISSAO_POR_SITUACAO_INSCRICAO: dict[str, str] = {
    "INSCRITA": "turma.inscrever",
    "CONFIRMADA": "turma.inscrever",
    "CANCELADA": "turma.inscrever",
}

SITUACAO_DERIVADA = (
    "Presença, ausência e resultado não se digitam: saem do lançamento de "
    "presença e do fecho da turma, na aba Presença e notas."
)


class RegraDaTurma(ValueError):
    """Regra de negocio da turma ou da inscricao que a acao violaria."""


# ---------------------------------------------------------------------
# Leitura
# ---------------------------------------------------------------------
def codigo_de(numero: int, ano: int) -> str:
    """TUR-2026-0007. Quatro digitos porque o setor nao chega a 10 mil turmas
    por ano e porque zero a esquerda mantem a ordenacao alfabetica correta."""
    return f"TUR-{ano}-{numero:04d}"


def consulta_no_escopo(usuario: UsuarioAtual):
    """A consulta de turmas recortada pelo escopo — e o que "proprio" quer dizer aqui.

    **Uma turma nao e dado pessoal de ninguem.** Codigo, treinamento, periodo,
    local, campus, vagas e situacao sao CARTAZ: descrevem um curso que vai
    acontecer, nao uma pessoa. O que e "de alguem" numa turma e a INSCRICAO — e a
    inscricao tem titular, tem `participante_id`, e e por ela que o recorte do
    titular passa (`inscricoes_do_titular`, logo abaixo).

    Por isso o ramo de escopo proprio NAO filtra: ele devolve o cartaz inteiro.
    Nao e afrouxamento, e a pergunta certa — a errada era a de antes.
    `aplicar_escopo` procurava `servidor_id` em `Turma`, nao achava, e devolvia
    `where(False)`: a lista abria 200 e vinha vazia, dizendo "nenhuma turma
    aberta ainda" com uma turma de vinte vagas com inscricoes abertas na frente.
    A tela nao negava — ela AFIRMAVA um fato falso, que e pior, porque nao ha o
    que pedir a ninguem.

    `ESCOPO_UNIDADE` continua passando por `aplicar_escopo`, e e para ele que
    `turma.campus_id` existe. O docstring de `rotas/turmas._turma_no_escopo`
    dizia que `campus_id` prevenia o `where(False)` do escopo proprio; nao
    prevenia — `campus_id` so socorre o escopo de unidade —, e comentario que
    promete protecao inexistente e pior do que comentario nenhum.

    O que este ramo NAO abre e a lista de INSCRITOS: a ficha da turma tem tres
    abas nominais, e `rotas/turmas.ficha` as guarda por permissao. Ver que o
    curso existe e ver quem esta nele sao duas perguntas, e so a primeira e
    cartaz.
    """
    consulta = select(Turma)
    if usuario.escopo == ESCOPO_PROPRIO:
        return consulta
    return aplicar_escopo(consulta, usuario, Turma)


def no_escopo(s: Session, usuario: UsuarioAtual, turma_id: int) -> Turma | None:
    """Uma leitura so, ja recortada — a porta unica das rotas de turma."""
    return s.execute(
        consulta_no_escopo(usuario).where(Turma.id == turma_id)
    ).scalar_one_or_none()


def inscricoes_que_ocupam_vaga(s: Session, turma: Turma) -> int:
    return s.execute(
        select(func.count())
        .select_from(Inscricao)
        .where(
            Inscricao.turma_id == turma.id,
            Inscricao.situacao.in_(tuple(INSCRICAO_OCUPA_VAGA)),
        )
    ).scalar_one()


def vagas_restantes(s: Session, turma: Turma) -> int | None:
    """`None` quando a turma nao tem limite declarado — que nao e o mesmo que
    zero, e a tela precisa da diferenca."""
    if turma.vagas is None:
        return None
    return max(0, turma.vagas - inscricoes_que_ocupam_vaga(s, turma))


# ---------------------------------------------------------------------
# Turma
# ---------------------------------------------------------------------
def _conferir_periodo(data_inicio: date, data_fim: date) -> None:
    if data_fim < data_inicio:
        raise RegraDaTurma("O fim da turma não pode ser anterior ao início.")


def _conferir_numeros(
    *,
    carga_horaria_horas: Decimal | None,
    vagas: int | None,
    nota_minima_aprovacao: Decimal | None,
    frequencia_minima_percentual: Decimal,
) -> None:
    if carga_horaria_horas is not None and carga_horaria_horas <= 0:
        raise RegraDaTurma("Carga horária da turma: informe um número maior que zero.")
    if vagas is not None and vagas <= 0:
        raise RegraDaTurma("Vagas: informe um número maior que zero, ou deixe em branco.")
    if nota_minima_aprovacao is not None and not (
        Decimal(0) <= nota_minima_aprovacao <= Decimal(10)
    ):
        raise RegraDaTurma("Nota mínima: use um valor entre 0 e 10.")
    if not (Decimal(0) <= frequencia_minima_percentual <= Decimal(100)):
        raise RegraDaTurma("Frequência mínima: use um percentual entre 0 e 100.")


def criar_turma(
    s: Session,
    usuario: UsuarioAtual,
    *,
    treinamento: Treinamento,
    data_inicio: date,
    data_fim: date,
    local: str | None = None,
    campus_id: int | None = None,
    unidade_promotora_id: int | None = None,
    carga_horaria_horas: Decimal | None = None,
    data_base_vencimento: date | None = None,
    vagas: int | None = None,
    inscricao_aberta_ate: date | None = None,
    nota_minima_aprovacao: Decimal | None = None,
    frequencia_minima_percentual: Decimal = Decimal(75),
    observacoes: str | None = None,
) -> Turma:
    """Abre a turma e consome o numero do ano, na mesma transacao.

    O ano da turma e o do INICIO, nao o da criacao: quem le "Turma 7/2026"
    entende uma turma realizada em 2026, e e assim que ela vai ser citada em
    oficio. Planejar em dezembro uma turma de janeiro consome, corretamente, o
    numero 1 do ano seguinte.
    """
    usuario.exigir("turma.criar")
    if not treinamento.ativo:
        raise RegraDaTurma(
            f"'{treinamento.nome}' está inativo no catálogo — reative-o antes de "
            "abrir turma."
        )
    _conferir_periodo(data_inicio, data_fim)
    _conferir_numeros(
        carga_horaria_horas=carga_horaria_horas,
        vagas=vagas,
        nota_minima_aprovacao=nota_minima_aprovacao,
        frequencia_minima_percentual=frequencia_minima_percentual,
    )
    if data_base_vencimento is not None and data_base_vencimento < data_inicio:
        raise RegraDaTurma(
            "A data base do vencimento não pode ser anterior ao início da turma."
        )

    ano = data_inicio.year
    numero = numeracao.proximo_numero_turma(s, ano)
    turma = Turma(
        treinamento_id=treinamento.id,
        numero=numero,
        ano=ano,
        codigo=codigo_de(numero, ano),
        data_inicio=data_inicio,
        data_fim=data_fim,
        data_base_vencimento=data_base_vencimento,
        carga_horaria_horas=carga_horaria_horas,
        local=local,
        campus_id=campus_id,
        unidade_promotora_id=unidade_promotora_id,
        vagas=vagas,
        inscricao_aberta_ate=inscricao_aberta_ate,
        nota_minima_aprovacao=nota_minima_aprovacao,
        frequencia_minima_percentual=frequencia_minima_percentual,
        observacoes=observacoes,
        situacao="PLANEJADA",
        criado_por=usuario.id,
    )
    s.add(turma)
    s.flush()
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento="TURMA_CRIADA",
        descricao=(
            f"{turma.codigo} · {treinamento.nome} · "
            f"{data_inicio.isoformat()} a {data_fim.isoformat()}"
        ),
        usuario=usuario,
    )
    return turma


def editar_turma(s: Session, usuario: UsuarioAtual, turma: Turma, campos: dict) -> Turma:
    """Grava a ficha da turma e audita campo a campo.

    Vive no servico, e nao no `salvar_com_diff` da camada de apresentacao,
    porque as regras abaixo precisam correr ANTES da gravacao e nenhuma delas e
    generica: mudar o ano de inicio desmentiria o codigo que ja circulou, e
    turma encerrada nao se reescreve.
    """
    usuario.exigir("turma.criar")
    if turma.encerrada:
        raise RegraDaTurma(
            f"Turma {ROTULO_TURMA[turma.situacao].lower()} não se edita — "
            "o que ela diz já foi comunicado a quem participou."
        )

    novo_inicio = campos.get("data_inicio", turma.data_inicio)
    novo_fim = campos.get("data_fim", turma.data_fim)
    _conferir_periodo(novo_inicio, novo_fim)
    if novo_inicio.year != turma.ano:
        # o numero foi tirado da sequencia de `turma.ano` e o codigo esta no
        # cartaz. Deixar a turma escorregar para outro ano faria TUR-2026-0007
        # nomear uma turma de 2027 — e o numero 7 de 2027 continuaria livre
        # para outra.
        raise RegraDaTurma(
            f"Adiar a turma para {novo_inicio.year} mudaria o ano de {turma.codigo}, "
            "que já foi divulgado. Cancele esta turma e abra outra."
        )
    base = campos.get("data_base_vencimento", turma.data_base_vencimento)
    if base is not None and base < novo_inicio:
        raise RegraDaTurma(
            "A data base do vencimento não pode ser anterior ao início da turma."
        )
    _conferir_numeros(
        carga_horaria_horas=campos.get(
            "carga_horaria_horas", turma.carga_horaria_horas
        ),
        vagas=campos.get("vagas", turma.vagas),
        nota_minima_aprovacao=campos.get(
            "nota_minima_aprovacao", turma.nota_minima_aprovacao
        ),
        frequencia_minima_percentual=campos.get(
            "frequencia_minima_percentual", turma.frequencia_minima_percentual
        ),
    )
    vagas_novas = campos.get("vagas", turma.vagas)
    if vagas_novas is not None:
        ocupadas = inscricoes_que_ocupam_vaga(s, turma)
        if vagas_novas < ocupadas:
            raise RegraDaTurma(
                f"A turma já tem {ocupadas} inscrito(s): reduzir para "
                f"{vagas_novas} vaga(s) deixaria gente inscrita fora da conta."
            )

    antes = {campo: getattr(turma, campo) for campo in campos}
    for campo, valor in campos.items():
        setattr(turma, campo, valor)
    auditoria.registrar_diferencas(
        s,
        entidade="turma",
        entidade_id=turma.id,
        antes=antes,
        depois={campo: getattr(turma, campo) for campo in campos},
        usuario=usuario,
    )
    s.flush()
    return turma


def mudar_situacao(
    s: Session,
    usuario: UsuarioAtual,
    turma: Turma,
    destino: str,
    *,
    motivo: str | None = None,
) -> Turma:
    """Maquina E. Transicao nao declarada e recusada aqui, nao no template."""
    permissao = PERMISSAO_POR_SITUACAO_TURMA.get(destino)
    if permissao is None:
        raise RegraDaTurma(f"Situação de turma desconhecida: {destino}.")
    usuario.exigir(permissao)

    origem = turma.situacao
    if origem == destino:
        return turma
    exigir_transicao_turma(origem, destino)

    limpo = (motivo or "").strip() or None
    if destino == "CANCELADA" and not limpo:
        # a CHECK do banco tambem recusa; a mensagem util e esta
        raise RegraDaTurma(
            "Cancelar exige o motivo: é o único registro que sobra para quem "
            "perguntar depois por que a turma não aconteceu."
        )
    if destino == "INSCRICOES_ABERTAS" and turma.data_fim < date.today():
        raise RegraDaTurma(
            f"A turma terminou em {turma.data_fim.strftime('%d/%m/%Y')} — "
            "não há como abrir inscrição para ela."
        )

    turma.situacao = destino
    turma.motivo_cancelamento = limpo if destino == "CANCELADA" else None
    turma.concluida_em = agora_utc() if destino == "CONCLUIDA" else None

    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=auditoria.ESTADO_ALTERADO,
        descricao=(
            f"{turma.codigo}: {ROTULO_TURMA.get(origem, origem)} -> "
            f"{ROTULO_TURMA.get(destino, destino)}"
            + (f" — {limpo}" if limpo else "")
        ),
        campo="situacao",
        valor_anterior=origem,
        valor_novo=destino,
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    if destino == "CONCLUIDA":
        # Fatia 3: concluir passou a ser UM ato. Antes ele so carimbava
        # `concluida_em`; agora calcula a frequencia de cada inscrito e atribui
        # APROVADO/REPROVADO na mesma transacao. Apurar num segundo botao
        # deixaria a turma "concluida" com gente sem resultado — estado que
        # ninguem sabe ler e que a emissao do certificado (fatia 4) teria de
        # tratar como caso especial.
        #
        # O import e local porque `presenca` importa `RegraDaTurma` e
        # `inscricoes_da_turma` daqui: a dependencia so pode existir num sentido
        # no topo do arquivo.
        from app.servicos import presenca

        presenca.apurar_turma(s, usuario, turma)
    return turma


# ---------------------------------------------------------------------
# Instrutores da turma
# ---------------------------------------------------------------------
def vincular_instrutor(
    s: Session,
    usuario: UsuarioAtual,
    turma: Turma,
    instrutor: AssinaturaInstrutor,
    *,
    assina_certificado: bool = True,
) -> TurmaInstrutor:
    usuario.exigir("turma.criar")
    if turma.encerrada:
        raise RegraDaTurma("Turma encerrada não muda de instrutor.")
    if not instrutor.ativo:
        raise RegraDaTurma(
            f"A assinatura de {instrutor.nome_exibicao} está inativa — reative-a "
            "antes de vinculá-la à turma."
        )
    if not instrutor.vigente_em(turma.data_inicio):
        # a assinatura tem vigencia justamente para nao autorizar quem ja saiu;
        # deixar passar aqui so adiaria a recusa para a emissao (fatia 4), com
        # a turma inteira ja realizada
        raise RegraDaTurma(
            f"A assinatura de {instrutor.nome_exibicao} não vigora em "
            f"{turma.data_inicio.strftime('%d/%m/%Y')}, quando a turma começa."
        )
    ja = s.get(TurmaInstrutor, (turma.id, instrutor.id))
    if ja is not None:
        raise RegraDaTurma(f"{instrutor.nome_exibicao} já é instrutor desta turma.")

    vinculo = TurmaInstrutor(
        turma_id=turma.id,
        assinatura_instrutor_id=instrutor.id,
        ordem=len(turma.instrutores) + 1,
        assina_certificado=assina_certificado,
    )
    s.add(vinculo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento="TURMA_INSTRUTOR_VINCULADO",
        descricao=(
            f"{turma.codigo}: {instrutor.nome_exibicao}"
            + ("" if assina_certificado else " (não assina o certificado)")
        ),
        usuario=usuario,
    )
    return vinculo


def desvincular_instrutor(
    s: Session, usuario: UsuarioAtual, turma: Turma, instrutor_id: int
) -> None:
    usuario.exigir("turma.criar")
    if turma.encerrada:
        raise RegraDaTurma("Turma encerrada não muda de instrutor.")
    vinculo = s.get(TurmaInstrutor, (turma.id, instrutor_id))
    if vinculo is None:
        return
    nome = vinculo.instrutor.nome_exibicao
    s.delete(vinculo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento="TURMA_INSTRUTOR_DESVINCULADO",
        descricao=f"{turma.codigo}: {nome}",
        usuario=usuario,
    )


# ---------------------------------------------------------------------
# Inscricao
# ---------------------------------------------------------------------
def _conferir_inscricao_unica(s: Session, turma: Turma, participante: Participante) -> None:
    """A mesma pessoa nao entra duas vezes na mesma turma.

    A unicidade tambem esta no banco (`uq_inscricao`), e e ela que fecha a
    corrida; esta e a mensagem util, que diz em QUE situacao a pessoa ja consta.
    """
    ja = s.execute(
        select(Inscricao).where(
            Inscricao.turma_id == turma.id,
            Inscricao.participante_id == participante.id,
        )
    ).scalar_one_or_none()
    if ja is not None:
        raise RegraDaTurma(
            f"{participante.nome_exibicao} já consta em {turma.codigo} como "
            f"{ROTULO_INSCRICAO.get(ja.situacao, ja.situacao).lower()}."
        )


def _conferir_vaga(s: Session, turma: Turma) -> None:
    """A ultima vaga disputada por duas pessoas ao mesmo tempo.

    A conta e feita aqui, e nao na tela, e o que a torna confiavel e o
    `BEGIN IMMEDIATE` de `app/banco.py`: o lock de escrita e tomado na PRIMEIRA
    instrucao da transacao, entao a leitura de `vagas_restantes` e a gravacao da
    inscricao cabem numa janela que nenhum outro escritor atravessa. E a mesma
    garantia que a reserva de lote de EPI usa, e pelo mesmo motivo — sem ela, as
    duas transacoes leriam "resta 1" e gravariam duas inscricoes para uma vaga.
    """
    restantes = vagas_restantes(s, turma)
    if restantes is not None and restantes <= 0:
        raise RegraDaTurma(
            f"{turma.codigo} não tem vaga: {turma.vagas} de {turma.vagas} ocupadas."
        )


def inscrever(
    s: Session,
    usuario: UsuarioAtual,
    turma: Turma,
    participante: Participante,
    *,
    origem: str = "INTERNA",
    observacao: str | None = None,
) -> Inscricao:
    """Poe a pessoa na turma. Inscricao interna nasce INSCRITA e ja ocupa vaga.

    A inscricao publica (fatia 6) nasce AGUARDANDO_EMAIL e so ocupa vaga depois
    de a pessoa clicar no link — sem isso, qualquer um esgotaria as vagas
    inscrevendo enderecos alheios.
    """
    usuario.exigir("turma.inscrever")
    if origem != "INTERNA":
        raise RegraDaTurma("Nesta versão só existe inscrição interna.")
    if not turma.aceita_inscricao:
        raise RegraDaTurma(
            f"{turma.codigo} está {ROTULO_TURMA[turma.situacao].lower()} e não "
            "recebe inscrição."
        )
    if not participante.ativo or participante.mesclado_em_id is not None:
        raise RegraDaTurma(
            f"{participante.nome_exibicao} é um registro desativado — use o "
            "participante que o substituiu."
        )
    _conferir_inscricao_unica(s, turma, participante)
    _conferir_vaga(s, turma)

    inscricao = Inscricao(
        turma_id=turma.id,
        participante_id=participante.id,
        situacao="INSCRITA",
        origem="INTERNA",
        observacao=(observacao or "").strip() or None,
        inscrito_por=usuario.id,
    )
    s.add(inscricao)
    s.flush()
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento="INSCRICAO_CRIADA",
        # RN-19 na ESCRITA: sobrava o nome ao lado do `PTC-`, e e o par que
        # resolve o codigo opaco para sempre — o mesmo defeito que a 1.37.0
        # tirou da folha de chamada. Fica so o identificador.
        descricao=f"{turma.codigo}: {participante.identificador_publico}",
        usuario=usuario,
    )
    return inscricao


def mudar_situacao_inscricao(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    destino: str,
    *,
    motivo: str | None = None,
    quando: datetime | None = None,
) -> Inscricao:
    """Maquina F. Mesma disciplina da turma: a recusa e aqui.

    A ordem das tres primeiras guardas importa e nao e arbitraria: estado
    inexistente, depois estado derivado, depois permissao. Inverter as duas
    ultimas faria o sistema responder "permissao negada" a quem tentasse marcar
    presenca por aqui — mensagem errada, que manda a pessoa pedir acesso em vez
    de usar a aba que faz a coisa certa.
    """
    from app.modelos.estados import ESTADOS_INSCRICAO

    if destino not in ESTADOS_INSCRICAO:
        raise RegraDaTurma(f"Situação de inscrição desconhecida: {destino}.")
    permissao = PERMISSAO_POR_SITUACAO_INSCRICAO.get(destino)
    if permissao is None:
        raise RegraDaTurma(SITUACAO_DERIVADA)
    usuario.exigir(permissao)

    origem = inscricao.situacao
    if origem == destino:
        return inscricao
    exigir_transicao_inscricao(origem, destino)

    limpo = (motivo or "").strip() or None
    if destino == "CANCELADA" and not limpo:
        raise RegraDaTurma(
            "Cancelar a inscrição exige o motivo: é o que distingue desistência "
            "de erro de digitação quando alguém consultar depois."
        )
    if destino == "CONFIRMADA" and inscricao.turma.encerrada:
        raise RegraDaTurma(
            f"{inscricao.turma.codigo} está "
            f"{ROTULO_TURMA[inscricao.turma.situacao].lower()}: não há o que confirmar."
        )

    inscricao.situacao = destino
    inscricao.motivo_cancelamento = limpo if destino == "CANCELADA" else None
    if destino == "CONFIRMADA":
        inscricao.confirmada_em = quando or agora_utc()
        inscricao.confirmada_por = usuario.id

    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento=auditoria.ESTADO_ALTERADO,
        descricao=(
            f"{inscricao.turma.codigo} · "
            f"{inscricao.participante.identificador_publico}: "
            f"{ROTULO_INSCRICAO.get(origem, origem)} -> "
            f"{ROTULO_INSCRICAO.get(destino, destino)}"
            + (f" — {limpo}" if limpo else "")
        ),
        campo="situacao",
        valor_anterior=origem,
        valor_novo=destino,
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    # Sair de INSCRITA e o que a CSSO tinha para fazer: confirmar (ou cancelar).
    fechar_pendencia_de_confirmacao(s, inscricao, usuario)
    return inscricao


def inscricoes_da_turma(s: Session, turma: Turma) -> list[Inscricao]:
    """Na ordem em que a lista de presenca vai sair: nome, nao id."""
    itens = list(
        s.execute(select(Inscricao).where(Inscricao.turma_id == turma.id)).scalars()
    )
    return sorted(itens, key=lambda i: i.participante.nome_exibicao.casefold())


# ---------------------------------------------------------------------
# A inscricao do PROPRIO servidor
# ---------------------------------------------------------------------
# `turma.inscrever_se` e `turma.inscrever` sao permissoes diferentes porque
# descrevem atos diferentes: pedir a propria vaga e ato de quem vai fazer o
# curso; por alguem numa turma e confirmar a inscricao dos outros e ato do setor.
# A simetria e a de `epi.requisitar` / `epi.analisar`, e ela ja provou valer.
#
# **A propriedade de seguranca que sustenta tudo isto e a ausencia de um
# parametro.** As funcoes abaixo nao recebem participante, servidor nem
# inscricao de terceiro: o titular sai de `usuario.servidor_id`, que vem da
# sessao. Nao ha "quem" para forjar — nem no formulario, nem na URL, nem aqui.
TIPO_PENDENCIA_CONFIRMAR = "TURMA_INSCRICAO_A_CONFIRMAR"


def chave_da_pendencia_de_confirmacao(inscricao: Inscricao) -> str:
    return f"inscricao-{inscricao.id}-a-confirmar"


def abrir_pendencia_de_confirmacao(
    s: Session, inscricao: Inscricao, usuario: UsuarioAtual | None = None
) -> None:
    """Abre a tarefa que diz a CSSO que ha um pedido esperando confirmacao.

    **Por que uma pendencia, e nao uma fila nova.** O sistema tem UM canal de
    aviso — o sino de `/pendencias`, que atravessa todos os modulos — e nao tem
    SMTP. Uma segunda lista de "pedidos de inscricao" seria um segundo lugar
    para olhar, e o pedido morreria nela exatamente como morre no e-mail que
    este modulo veio substituir.

    **Sem responsavel, de proposito.** `pendencias.no_escopo` so recorta por
    `responsavel_id` para o escopo PROPRIO: tarefa sem dono e do SETOR, aparece
    para toda a CSSO e nao aparece para o servidor que a gerou — que e
    exatamente o desenho, porque o trabalho que falta e de la, nao dele. Deixar
    `abrir` cair no `usuario.id` do chamador faria o contrario dos dois lados: a
    tarefa nasceria com dono errado e invisivel para quem tem de cumpri-la.

    **A descricao nao nomeia ninguem.** `identificador_publico` e nao o nome: a
    secretaria opera a inscricao e NAO tem `exposicao.ver`, entao a RN-19
    suprimiria a frase inteira na tela dela e a tarefa chegaria ilegivel a quem
    precisa cumpri-la. A ancora leva a aba onde o nome esta, sob a permissao que
    o autoriza.

    **O prazo e o da turma, nao um contado de hoje**: confirmar depois de a
    turma comecar nao confirma nada. Mesma logica de `CA_A_VENCER`.
    """
    turma = inscricao.turma
    pendencia = pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_CONFIRMAR,
        chave=chave_da_pendencia_de_confirmacao(inscricao),
        descricao=(
            f"{turma.codigo} · {turma.treinamento.nome} · pedida pelo próprio "
            f"participante {inscricao.participante.identificador_publico}"
        ),
        usuario=usuario,
        entidade="turma",
        entidade_id=turma.id,
        prazo=turma.inscricao_aberta_ate or turma.data_inicio,
    )
    # `abrir` cai no `usuario.id` do chamador quando `responsavel_id` nao vem — e
    # aqui o chamador e o PROPRIO servidor. Sem esta linha a tarefa nasceria com
    # ele como responsavel: apareceria no sino de quem pediu (pedindo que ele
    # confirmasse a si mesmo) e a coluna "Responsavel" da fila da CSSO apontaria
    # para fora do setor. `usuario=` continua indo para a trilha saber quem
    # disparou a regra; o DONO da tarefa e o setor, e por isso e nulo.
    pendencia.responsavel_id = None
    s.flush()


def fechar_pendencia_de_confirmacao(
    s: Session, inscricao: Inscricao, usuario: UsuarioAtual
) -> None:
    """Sair de INSCRITA e o que a tarefa pedia — entao a tarefa acabou.

    Fecha aqui, e nao num botao proprio, pelo mesmo motivo das pendencias do
    requerente de EPI: tarefa que se risca da lista sem o trabalho ter sido
    feito e lista que ninguem volta a levar a serio.

    So FECHA, nunca abre: quem abre e `inscrever_se`, e so ele. Sincronizar nos
    dois sentidos aqui faria a secretaria mover uma inscricao publica de
    `AGUARDANDO_EMAIL` para `INSCRITA` e o sino anunciar um "pedido do proprio"
    que ninguem pediu.
    """
    if inscricao.situacao == "INSCRITA":
        return
    existente = s.execute(
        select(Pendencia).where(
            Pendencia.chave == chave_da_pendencia_de_confirmacao(inscricao)
        )
    ).scalar_one_or_none()
    if existente is not None:
        pendencias.concluir(s, existente, usuario)


def _titular_da_conta(s: Session, usuario: UsuarioAtual) -> Servidor:
    if usuario.servidor_id is None:
        raise RegraDaTurma(
            "Sua conta não está ligada a um cadastro de servidor, e sem essa "
            "ligação o sistema não tem em nome de quem inscrever. A ligação é "
            "feita em Usuários, por quem tem `usuario.criar_conta` — peça "
            "informando o seu SIAPE."
        )
    servidor = s.get(Servidor, usuario.servidor_id)
    if servidor is None:
        raise RegraDaTurma(
            "O cadastro de servidor ligado a esta conta não existe mais. "
            "Avise a CSSO antes de tentar de novo."
        )
    return servidor


def aberta_a_pedido_proprio(turma: Turma, hoje: date | None = None) -> str:
    """`""` quando a turma recebe pedido do proprio; o motivo, quando nao recebe.

    Mais estreita que `turma.aceita_inscricao` de propósito. A CSSO inscreve
    retardatario em turma `EM_ANDAMENTO` e inscreve por antecipacao em turma
    `PLANEJADA` — sao atos de quem responde pela turma, com o contexto na mao. O
    pedido do proprio so cabe onde o cartaz esta no ar: `INSCRICOES_ABERTAS`, e
    dentro do prazo que a turma anunciou. Aceitar fora disso faria o sistema
    prometer vaga em turma que ninguem abriu para inscricao.
    """
    hoje = hoje or date.today()
    if turma.situacao != "INSCRICOES_ABERTAS":
        return (
            f"{turma.codigo} está {ROTULO_TURMA[turma.situacao].lower()}: só se "
            "pede vaga em turma com inscrições abertas. Fale com a CSSO."
        )
    if turma.inscricao_aberta_ate is not None and turma.inscricao_aberta_ate < hoje:
        return (
            f"As inscrições de {turma.codigo} fecharam em "
            f"{turma.inscricao_aberta_ate.strftime('%d/%m/%Y')}."
        )
    return ""


def turmas_abertas(s: Session, hoje: date | None = None) -> list[Turma]:
    """O cartaz: as turmas que recebem pedido do proprio, hoje.

    Sem escopo, e pelo motivo de `consulta_no_escopo`: a oferta nao e de
    ninguem. O que a lista NAO traz e um unico nome.
    """
    hoje = hoje or date.today()
    itens = list(
        s.execute(
            select(Turma).where(Turma.situacao == "INSCRICOES_ABERTAS")
        ).scalars()
    )
    return sorted(
        (t for t in itens if not aberta_a_pedido_proprio(t, hoje)),
        key=lambda t: (t.data_inicio, t.codigo),
    )


def inscricoes_do_titular(s: Session, usuario: UsuarioAtual) -> list[Inscricao]:
    """"As minhas" — e AQUI o escopo proprio quer dizer alguma coisa.

    Prende ao `servidor_id` da conta, e nao a `aplicar_escopo`, pela mesma razao
    de `emissao_certificado.consulta_do_titular`: esta pergunta e "o que e meu",
    e a resposta nao pode alargar quando o escopo do perfil alargar. Para um
    perfil de unidade `aplicar_escopo` devolveria o campus inteiro.

    `-1` no lugar de `None` para nao virar `IS NULL`, que casaria com todo
    participante externo.
    """
    return list(
        s.execute(
            select(Inscricao)
            .join(Participante, Participante.id == Inscricao.participante_id)
            .join(Turma, Turma.id == Inscricao.turma_id)
            .where(Participante.servidor_id == (usuario.servidor_id or -1))
            .order_by(Turma.data_inicio.desc(), Turma.codigo.desc())
        ).scalars()
    )


def inscrever_se(
    s: Session, usuario: UsuarioAtual, turma: Turma, *, hoje: date | None = None
) -> Inscricao:
    """O servidor pede a propria vaga. Nasce INSCRITA; a CSSO confirma.

    **Por que INSCRITA, e nao um estado novo.** A maquina F ja tem exatamente o
    par que este fluxo precisa: `INSCRITA -> CONFIRMADA`, e `CONFIRMADA` ja
    grava `confirmada_por` e `confirmada_em`. "Inscrita, ainda nao confirmada" e
    a verdade sobre este pedido, e ela ja tem nome no sistema. Um estado novo
    custaria migracao revisada a mao, uma linha em cinco mapas de rotulo e uma
    aresta em cada tabela de transicao — para dizer o que `INSCRITA` ja diz.

    `AGUARDANDO_EMAIL` seria o estado errado, e nao por pouco: ele existe para a
    inscricao publica, cuja duvida e "esta pessoa possui esta caixa de e-mail?".
    Aqui essa duvida nao existe — a identidade foi provada no login, que e
    justamente o que a inscricao publica gasta 72h para conseguir. E o pedido
    ocuparia vaga nenhuma, o que reabriria a corrida que este servico fecha.

    **A vaga e ocupada desde ja** (`INSCRITA` esta em `INSCRICAO_OCUPA_VAGA`).
    Segurar a vaga so na confirmacao faria o sistema aceitar trinta pedidos para
    vinte lugares e transformar a confirmacao numa fila de decepcao.
    """
    usuario.exigir("turma.inscrever_se")
    hoje = hoje or date.today()
    servidor = _titular_da_conta(s, usuario)

    impedimento = aberta_a_pedido_proprio(turma, hoje)
    if impedimento:
        raise RegraDaTurma(impedimento)

    from app.servicos import participante as servico_participante

    pessoa = servico_participante.de_servidor(s, servidor, usuario)
    _conferir_inscricao_unica(s, turma, pessoa)
    _conferir_vaga(s, turma)

    inscricao = Inscricao(
        turma_id=turma.id,
        participante_id=pessoa.id,
        situacao="INSCRITA",
        origem="INTERNA",
        # quem pediu foi ele, e e isto que distingue este pedido do que a
        # secretaria digita: `inscrito_por` e a conta do proprio titular, e a
        # trilha grava o ato com nome e hora
        inscrito_por=usuario.id,
    )
    s.add(inscricao)
    s.flush()
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento="INSCRICAO_PEDIDA_PELO_TITULAR",
        descricao=(
            f"{turma.codigo}: {pessoa.identificador_publico} pediu a própria vaga"
        ),
        usuario=usuario,
    )
    abrir_pendencia_de_confirmacao(s, inscricao, usuario)
    return inscricao


def pode_desistir(inscricao: Inscricao, hoje: date | None = None) -> bool:
    """Desistir cabe ate a vespera do inicio, e so de inscricao ainda viva."""
    hoje = hoje or date.today()
    return (
        inscricao.situacao in ("INSCRITA", "CONFIRMADA")
        and not inscricao.turma.encerrada
        and hoje < inscricao.turma.data_inicio
    )


def desistir(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    *,
    motivo: str | None = None,
    hoje: date | None = None,
) -> Inscricao:
    """A propria desistencia — e ela NAO apaga nada (RN-31).

    **Por que ele pode.** A vaga presa por quem nao vai e o pior desfecho
    possivel para uma turma com lista de espera, e hoje soltar essa vaga custa um
    telefonema que ninguem da. Quem pede tambem desiste: e o mesmo par que a
    requisicao de EPI ja resolveu ("desistência, não decisão de mérito").

    **Ate a vespera do inicio, e nao depois.** Depois que a turma comeca, nao ir
    deixa de ser decisao e passa a ser FATO — e o fato tem nome no sistema
    (`AUSENTE`), sai do lancamento de presenca e entra na apuracao. Deixar
    cancelar depois do inicio permitiria apagar a falta em vez de registra-la.

    **Nao apaga**: a linha continua, `CANCELADA`, com o motivo escrito e o evento
    na trilha. E o cancelamento e definitivo NESTA turma — a unicidade
    `(turma, participante)` e o que impede a mesma pessoa de entrar duas vezes,
    entao voltar atras pede a CSSO. A tela diz isso antes do clique.
    """
    usuario.exigir("turma.inscrever_se")
    hoje = hoje or date.today()
    servidor_id = inscricao.participante.servidor_id
    if usuario.servidor_id is None or servidor_id != usuario.servidor_id:
        # nao e "permissao negada": a permissao ele tem. O que ele nao tem e
        # relacao com esta inscricao — e dizer isso e o que impede a mensagem de
        # mandar pedir uma permissao que nao resolveria nada.
        raise RegraDaTurma("Esta inscrição não é sua.")
    if not pode_desistir(inscricao, hoje):
        if inscricao.situacao not in ("INSCRITA", "CONFIRMADA"):
            raise RegraDaTurma(
                f"Sua inscrição em {inscricao.turma.codigo} está "
                f"{ROTULO_INSCRICAO.get(inscricao.situacao, inscricao.situacao).lower()} "
                "e não há o que desistir."
            )
        raise RegraDaTurma(
            f"{inscricao.turma.codigo} começou em "
            f"{inscricao.turma.data_inicio.strftime('%d/%m/%Y')}: a partir do "
            "início a falta é registrada como ausência, não desfeita como "
            "desistência. Fale com a CSSO."
        )

    limpo = (motivo or "").strip() or "Desistência do próprio inscrito."
    origem = inscricao.situacao
    exigir_transicao_inscricao(origem, "CANCELADA")
    inscricao.situacao = "CANCELADA"
    inscricao.motivo_cancelamento = limpo
    auditoria.registrar(
        s,
        entidade="inscricao",
        entidade_id=inscricao.id,
        tipo_evento="INSCRICAO_DESISTIDA",
        descricao=(
            f"{inscricao.turma.codigo}: "
            f"{inscricao.participante.identificador_publico} desistiu — {limpo}"
        ),
        campo="situacao",
        valor_anterior=origem,
        valor_novo="CANCELADA",
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    fechar_pendencia_de_confirmacao(s, inscricao, usuario)
    return inscricao


__all__ = [
    "PERMISSAO_POR_SITUACAO_INSCRICAO",
    "PERMISSAO_POR_SITUACAO_TURMA",
    "SITUACAO_DERIVADA",
    "TIPO_PENDENCIA_CONFIRMAR",
    "RegraDaTurma",
    "aberta_a_pedido_proprio",
    "abrir_pendencia_de_confirmacao",
    "chave_da_pendencia_de_confirmacao",
    "codigo_de",
    "consulta_no_escopo",
    "criar_turma",
    "desistir",
    "desvincular_instrutor",
    "editar_turma",
    "fechar_pendencia_de_confirmacao",
    "inscrever",
    "inscrever_se",
    "inscricoes_da_turma",
    "inscricoes_do_titular",
    "inscricoes_que_ocupam_vaga",
    "mudar_situacao",
    "mudar_situacao_inscricao",
    "no_escopo",
    "pode_desistir",
    "turmas_abertas",
    "vagas_restantes",
    "vincular_instrutor",
]
