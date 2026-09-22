"""Participante: a pessoa que faz treinamento, com ou sem SIAPE.

Por que existe um servico proprio, e nao um bloco dentro de `certificado.py`:
`participante` nao e do modulo de Certificados. O modulo de Acidentes vai
apontar para ela (`acidentado.participante_id`, SS2.1 do plano consolidado), e
fazer Acidentes importar `servicos/certificado.py` para criar uma pessoa seria
amarrar dois modulos pelo lugar errado.

As tres regras que governam tudo aqui:

1. **Servidor e ponteiro, nao copia.** O participante de quem tem SIAPE guarda
   `servidor_id` e mais nada de identificacao; nome, cargo e lotacao continuam
   morando em `servidor`. Copiar o nome faria os dois divergirem no dia em que
   alguem corrigisse um deles — e o certificado sairia com o errado.
2. **Externo existe so aqui**, com nome proprio e identificador publico opaco.
3. **E-mail e tabela filha, nunca coluna.** E o que reconcilia a mesma pessoa
   que hoje usa o e-mail pessoal e amanha o institucional. Sem isso o controle
   de reciclagem ve duas pessoas onde ha uma e diz "nunca fez" de quem fez.

NAO HA COLUNA DE CPF em lugar nenhum, e nao deve haver (decisao 1 do
coordenador). O identificador do externo e o e-mail confirmado, que e mutavel.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import Participante, ParticipanteEmail, Servidor
from app.modelos.treinamento import (
    ORIGENS_EMAIL,
    VINCULOS_PARTICIPANTE,
    gerar_identificador_publico,
    normalizar_email,
)
from app.servicos import auditoria, identificacao, textos
from app.servicos.rbac import UsuarioAtual

TENTATIVAS_IDENTIFICADOR = 20


class DadosDoParticipante(ValueError):
    """O que a tela precisa corrigir antes de gravar."""


def _identificador_livre(s: Session) -> str:
    """Sorteia ate achar um identificador que ainda nao existe.

    Sao 30^8 combinacoes; a colisao e improvavel, mas "improvavel" nao e
    "impossivel", e o unique do banco transformaria a colisao em pagina de erro
    para quem so queria cadastrar alguem.
    """
    for _ in range(TENTATIVAS_IDENTIFICADOR):
        candidato = gerar_identificador_publico()
        ja = s.execute(
            select(Participante.id).where(
                Participante.identificador_publico == candidato
            )
        ).first()
        if ja is None:
            return candidato
    raise RuntimeError(  # pragma: no cover - exige 20 colisoes seguidas
        "nao foi possivel sortear identificador publico de participante"
    )


def por_email(s: Session, email: str) -> Participante | None:
    """Acha a pessoa pelo endereco, confirmado ou nao.

    E a porta de entrada da reconciliacao: e-mail ja conhecido significa
    participante ja conhecido, e nao um cadastro novo.
    """
    normalizado = normalizar_email(email)
    if not normalizado:
        return None
    linha = s.execute(
        select(ParticipanteEmail)
        .where(ParticipanteEmail.email_normalizado == normalizado)
        # confirmado primeiro: e o unico que garante posse da caixa
        .order_by(ParticipanteEmail.confirmado_em.is_(None), ParticipanteEmail.id)
    ).scalars().first()
    return linha.participante if linha is not None else None


def registrar_email(
    s: Session,
    participante: Participante,
    email: str,
    *,
    origem: str = "CADASTRO",
    confirmado_em=None,
    principal: bool = False,
) -> ParticipanteEmail | None:
    """Acrescenta um endereco ao participante, sem duplicar o que ja esta la.

    Devolve `None` para e-mail vazio: endereco e opcional para quem entra pela
    tela interna — o servidor ja e identificado pelo SIAPE, e exigir e-mail so
    para inscrever produziria endereco inventado.
    """
    limpo = (email or "").strip()
    if not limpo:
        return None
    if origem not in ORIGENS_EMAIL:
        raise DadosDoParticipante(f"Origem de e-mail desconhecida: {origem}.")
    normalizado = normalizar_email(limpo)
    if "@" not in normalizado or normalizado.startswith("@") or normalizado.endswith("@"):
        raise DadosDoParticipante(f"E-mail invalido: '{limpo}'.")

    ja = next(
        (e for e in participante.emails if e.email_normalizado == normalizado), None
    )
    if ja is None:
        ja = ParticipanteEmail(
            participante_id=participante.id,
            email=limpo,
            origem=origem,
            confirmado_em=confirmado_em,
        )
        participante.emails.append(ja)
        s.flush()
    elif confirmado_em is not None and ja.confirmado_em is None:
        ja.confirmado_em = confirmado_em
    if principal or participante.email_principal_id is None:
        participante.email_principal_id = ja.id
    s.flush()
    return ja


def de_servidor(
    s: Session, servidor: Servidor, usuario: UsuarioAtual | None = None
) -> Participante:
    """O participante daquele servidor, criando o ponteiro na primeira vez.

    Idempotente de proposito: chamar duas vezes para o mesmo SIAPE devolve a
    mesma linha. Se criasse duas, o historico de reciclagem da pessoa se
    partiria em dois e o monitor diria "nunca fez" para metade dele.
    """
    existente = s.execute(
        select(Participante).where(Participante.servidor_id == servidor.id)
    ).scalar_one_or_none()
    if existente is not None:
        return existente

    participante = Participante(
        servidor_id=servidor.id,
        # nome fica NULL: quem le, le de `servidor.nome`
        nome=None,
        identificador_publico=_identificador_livre(s),
        vinculo="SERVIDOR",
        organizacao="UFVJM",
    )
    s.add(participante)
    s.flush()
    if servidor.email:
        # o endereco institucional do cadastro entra como conhecido, mas NAO
        # como confirmado: o que confirma e a posse da caixa, e ninguem clicou
        # em link nenhum. Marcar como confirmado aqui ocuparia o indice unico
        # de e-mail confirmado com um endereco que talvez nem seja mais dela.
        registrar_email(s, participante, servidor.email, origem="SERVIDOR")
    auditoria.registrar(
        s,
        entidade="participante",
        entidade_id=participante.id,
        tipo_evento="PARTICIPANTE_CRIADO",
        # RN-19 na ESCRITA: o participante entra na trilha pela identidade
        # publica que esta tabela existe para dar — nao pelo nome nem pelo SIAPE.
        # O `servidor #{id}` fica ao lado porque e o que amarra o ponteiro ao
        # cadastro para quem pode abri-lo; o par nao nomeia ninguem sozinho.
        descricao=f"{participante.identificador_publico} · servidor #{servidor.id}",
        usuario=usuario,
    )
    return participante


def criar_externo(
    s: Session,
    *,
    nome: str,
    vinculo: str,
    usuario: UsuarioAtual | None = None,
    email: str = "",
    organizacao: str | None = None,
    matricula_externa: str | None = None,
) -> Participante:
    """Terceirizado, discente ou visitante. E o unico lugar onde o nome mora.

    Recusa `vinculo='SERVIDOR'`: quem tem SIAPE entra por `de_servidor`, senao
    passariamos a ter duas linhas de "servidor" para a mesma pessoa — uma com
    ponteiro e outra com nome copiado, que e exatamente o que o desenho evita.
    """
    limpo = (nome or "").strip()
    if not limpo:
        raise DadosDoParticipante("Informe o nome do participante externo.")
    if vinculo not in VINCULOS_PARTICIPANTE:
        raise DadosDoParticipante(f"Vinculo desconhecido: {vinculo}.")
    if vinculo == "SERVIDOR":
        raise DadosDoParticipante(
            "Servidor da UFVJM entra pelo cadastro de servidor, pelo SIAPE — "
            "nao como participante externo."
        )

    participante = Participante(
        servidor_id=None,
        nome=limpo,
        identificador_publico=_identificador_livre(s),
        vinculo=vinculo,
        organizacao=(organizacao or "").strip() or None,
        matricula_externa=(matricula_externa or "").strip() or None,
    )
    s.add(participante)
    s.flush()
    registrar_email(s, participante, email, origem="CADASTRO")
    auditoria.registrar(
        s,
        entidade="participante",
        entidade_id=participante.id,
        tipo_evento="PARTICIPANTE_CRIADO",
        # O externo nao tem `servidor_id` a que recorrer — o nome mora AQUI, e e
        # por isso que ele sai da frase sem substituto: o vinculo e a organizacao
        # dizem que participante e esse, e a identidade e o `PTC-`. Quem pode
        # ler o nome o le na ficha, sob a permissao que governa o participante.
        descricao=(
            f"{participante.identificador_publico} · {vinculo.lower()}"
            + (f" · {participante.organizacao}" if participante.organizacao else "")
        ),
        usuario=usuario,
    )
    return participante


# =====================================================================
# RN-19 do lado do FILTRO — a busca que inscreve
# =====================================================================
# A supressao da exibicao nao vale nada sozinha: a lista pode esconder o nome, e
# um filtro que continuasse casando por nome devolveria UMA linha e amarraria o
# nome ao registro — a ligacao exata que a supressao existe para impedir. A casa
# ja tinha essa decisao tomada e testada em `/servidores`
# (`identificacao.casa_a_busca`); estas duas funcoes eram a 5a e a 6a escrita da
# mesma pergunta, e as duas unicas que ficaram de fora da consolidacao.
#
# Enquanto so a CSSO tinha conta, "a busca acha por nome" descrevia uma
# ferramenta de trabalho. Com a inscricao aberta ao servidor comum ela passa a
# descrever um oraculo sobre o cadastro inteiro, inclusive sobre quem nunca fez
# treinamento nenhum.


def pode_identificar(
    usuario: UsuarioAtual | None, participante: Participante
) -> bool:
    """Quem pode ler o NOME de quem esta numa turma.

    `certificado.ver` — cuja descricao em `rbac.PERMISSOES` e literalmente
    "certificado nominal e dados do participante" — ou a RN-19 comum de
    `identificacao.pode_ver_nominal`, que ja sabe que `exposicao.ver` ve todos e
    que o titular ve o proprio (LGPD art. 18, II).

    Por que `certificado.ver` e nao `treinamento.ver`: a lista de chamada nao
    diz "fulano existe", diz **fulano fez NR-35** — em que atividade de risco
    ele trabalha. `treinamento.ver` e a permissao de abrir a tela, e sera de
    milhares de contas; `certificado.ver` a 1.35.0 manteve FORA de
    `servidor_consulta` de proposito (`rbac.py:402-411`), e todo perfil da CSSO
    que opera turma a tem. E ela, portanto, que separa — e e ela que
    `paginas/turma_ficha.html` usa para decidir se imprime o nome.

    **E a mesma pergunta que a tela faz**, e nao por acaso: o filtro so pode
    casar por nome onde a exibicao mostra o nome. Onde a tela suprime, casar
    devolveria uma linha e diria de quem e o codigo; onde a tela ja escreve o
    nome, fechar o filtro nao protege nada e so faz procurar duas vezes.
    """
    if usuario is None:
        return False
    return usuario.pode("certificado.ver") or identificacao.pode_ver_nominal(
        usuario, participante.servidor_id
    )


def casa_a_busca_de_participante(
    alvo: str, participante: Participante, usuario: UsuarioAtual | None
) -> bool:
    """A forma de `identificacao.casa_a_busca`, aplicada a quem tem duas origens.

    **Chave opaca acha para todo mundo.** `PTC-…` e o SIAPE sao o que quem
    procura JA traz de outro lugar — o cartaz da turma, o cracha, o processo no
    SEI —, e fecha-los faria a busca deixar de servir justamente para quem tem o
    dado e nao tem o nome. Nome e e-mail sao a outra classe: `nome.sobrenome@`
    e o nome escrito de outro jeito, e por isso caem os dois juntos.

    O SIAPE nao se reescreve aqui: quem responde por ele e
    `identificacao.casa_a_busca`, a regra unica de `/servidores`, da fila de EPI
    e da busca global. O que este servico acrescenta e so o que aquela funcao
    nao tem como saber — o `PTC-…`, o e-mail da tabela filha e o nome do
    externo, que existe so aqui.

    `alvo` vem normalizado por `textos.chave_busca`, como nas irmas.
    """
    if alvo in textos.chave_busca(participante.identificador_publico):
        return True
    if participante.servidor is not None and identificacao.casa_a_busca(
        alvo, participante.servidor, usuario
    ):
        return True
    if not pode_identificar(usuario, participante):
        return False
    nominais = [
        participante.nome_exibicao,
        *(e.email for e in participante.emails),
    ]
    return any(alvo in textos.chave_busca(campo) for campo in nominais if campo)


def buscar(
    s: Session,
    termo: str,
    usuario: UsuarioAtual | None = None,
    limite: int = 20,
) -> list[Participante]:
    """Busca por nome do externo, nome do servidor, SIAPE, e-mail ou PTC-....

    Uma busca so, porque quem inscreve nao sabe de antemao se a pessoa esta na
    base como servidor ou como externo — e obrigar a escolher a aba certa antes
    de procurar e o que faz alguem cadastrar em duplicidade.

    O SQL continua casando as cinco pernas e passou a ser so o RECORTE: quem
    decide linha a linha e `casa_a_busca_de_participante`, porque a RN-19 nao e
    clausula SQL — depende de quem pergunta E de quem e a pessoa daquela linha.
    Por isso o `limite` sai depois do filtro: cortar antes devolveria menos do
    que a pessoa pode ver.

    `usuario=None` e o lado seguro do erro, e nao um descuido: chamador que nao
    diz quem esta perguntando e tratado como quem nao ve nome. Abrir por
    omissao seria a forma silenciosa de desfazer isto — e busca fechada demais
    se conserta com uma linha, oraculo aberto nao se desfaz.
    """
    alvo = (termo or "").strip()
    if not alvo:
        return []
    curinga = f"%{alvo}%"
    consulta = (
        select(Participante)
        .outerjoin(Servidor, Participante.servidor_id == Servidor.id)
        .outerjoin(
            ParticipanteEmail,
            ParticipanteEmail.participante_id == Participante.id,
        )
        .where(
            Participante.ativo.is_(True),
            # participante absorvido por mesclagem sai das listas: continua no
            # banco para as chaves antigas resolverem, mas nao se inscreve mais
            Participante.mesclado_em_id.is_(None),
            Participante.nome.ilike(curinga)
            | Servidor.nome.ilike(curinga)
            | Servidor.siape.ilike(curinga)
            | ParticipanteEmail.email_normalizado.ilike(normalizar_email(curinga))
            | Participante.identificador_publico.ilike(curinga.upper()),
        )
        .distinct()
        .order_by(Participante.id)
    )
    chave = textos.chave_busca(alvo)
    achados = [
        pessoa
        for pessoa in s.execute(consulta).scalars()
        if casa_a_busca_de_participante(chave, pessoa, usuario)
    ]
    return achados[:limite]


def buscar_servidores(
    s: Session,
    termo: str,
    usuario: UsuarioAtual | None = None,
    limite: int = 20,
) -> list[Servidor]:
    """Servidores da base que ainda NAO tem participante, por nome ou SIAPE.

    Sao os que a busca de participante nao acha, porque nunca fizeram
    treinamento nenhum. Sem esta segunda lista, quem inscreve o servidor pela
    primeira vez nao o encontra e acaba cadastrando-o como externo — e ai a
    mesma pessoa passa a existir duas vezes, uma com SIAPE e outra sem.

    E por ser o cadastro inteiro — gente que nunca teve nada com treinamento —
    que aqui nao ha porta alguma alem de `identificacao.casa_a_busca`: esta e a
    mesma lista de `/servidores`, com a mesma pergunta e a mesma resposta. O
    filtro em Python, e nao no SQL, e o desenho de `servicos/servidores.buscar`,
    e pelo mesmo motivo: o criterio do nome e por LINHA, e o `limite` so pode
    cair depois dele.
    """
    alvo = textos.chave_busca(termo or "")
    if not alvo:
        return []
    ja_participantes = select(Participante.servidor_id).where(
        Participante.servidor_id.isnot(None)
    )
    candidatos = s.execute(
        select(Servidor)
        .where(Servidor.id.notin_(ja_participantes))
        .order_by(Servidor.nome)
    ).scalars()
    achados = [
        servidor
        for servidor in candidatos
        if identificacao.casa_a_busca(alvo, servidor, usuario)
    ]
    return achados[:limite]


__all__ = [
    "DadosDoParticipante",
    "buscar",
    "buscar_servidores",
    "casa_a_busca_de_participante",
    "criar_externo",
    "de_servidor",
    "pode_identificar",
    "por_email",
    "registrar_email",
]
