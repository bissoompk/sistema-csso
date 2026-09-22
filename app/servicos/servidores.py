"""Cadastro do servidor e o histórico datado de lotação e cargo.

O servidor muda de unidade, de posto e de cargo. O adicional depende de ONDE e
EM QUE FUNÇÃO ele estava em cada período — sobrescrever o cadastro apagaria a
prova da exposição passada, que é justamente o que a aposentadoria especial
precisa depois. Por isso toda alteração fecha o período anterior e abre um novo.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    Cargo,
    LotacaoPosto,
    PostoTrabalho,
    Servidor,
    ServidorLotacao,
    UnidadeUorg,
)
from app.servicos import auditoria, identificacao, textos
from app.servicos.rbac import UsuarioAtual


def buscar(s: Session, q: str, usuario: UsuarioAtual | None) -> list[Servidor]:
    """Quem pode aparecer num seletor de servidor, filtrado pela RN-19.

    **Existe para o `<select>` de 975 opcoes parar de existir.** Quatro telas
    montavam um seletor com o cadastro inteiro; a busca no servidor existia,
    testada e correta, e servia UMA delas. Duas copias do mesmo filtro ja tinham
    nascido — `/servidores` e a fila de EPI —, e a diferenca entre elas era
    silenciosa: uma casava e-mail institucional, a outra nao.

    O criterio nao se reescreve aqui: e `identificacao.casa_a_busca`, que e onde
    a RN-19 do lado do FILTRO mora e explica por que o SIAPE acha para todo mundo
    e o nome so acha para quem ja podia le-lo. Uma copia que esquecesse
    `pode_ver_nominal` seria justamente o oraculo que a supressao existe para
    fechar.

    **Sem busca a lista vem inteira, e isso e deliberado**: o seletor vazio
    obrigaria a digitar antes de saber o que existe, e no balcao, com fila de pe,
    isso e pior. Quem recorta a lista longa e a busca; quem a mantem utilizavel
    quando o cadastro for pequeno e este retorno.
    """
    itens = list(s.execute(select(Servidor).order_by(Servidor.nome)).scalars())
    alvo = textos.chave_busca(q or "")
    if not alvo:
        return itens
    return [sv for sv in itens if identificacao.casa_a_busca(alvo, sv, usuario)]


class LotacaoInvalida(ValueError):
    """Mudança de lotação que quebraria a linha do tempo."""


@dataclass(frozen=True)
class Alteracao:
    campo: str
    de: str
    para: str


def historico(s: Session, servidor_id: int) -> list[ServidorLotacao]:
    itens = list(
        s.execute(
            select(ServidorLotacao).where(ServidorLotacao.servidor_id == servidor_id)
        ).scalars()
    )
    return sorted(itens, key=lambda l: (l.vigencia_inicio, l.id))


def lotacao_vigente(s: Session, servidor_id: int, quando: date | None = None):
    quando = quando or date.today()
    for lotacao in reversed(historico(s, servidor_id)):
        if lotacao.vigente_em(quando):
            return lotacao
    return None


def lotacao_em(s: Session, servidor_id: int, quando: date):
    """Onde o servidor estava naquela data — é o que o parecer antigo precisa."""
    return lotacao_vigente(s, servidor_id, quando)


def _rotulo(objeto, atributo: str = "nome") -> str:
    if objeto is None:
        return "—"
    return getattr(objeto, atributo, None) or "—"


def postos_atuais(s: Session, servidor_id: int) -> list[PostoTrabalho]:
    """Os postos do período aberto — é a fonte única do 'onde ele trabalha hoje'."""
    lotacao = lotacao_vigente(s, servidor_id)
    return lotacao.postos if lotacao else []


def _nomes_de_postos(s: Session, ids: list[int]) -> str:
    if not ids:
        return "—"
    nomes = [_rotulo(s.get(PostoTrabalho, ident)) for ident in ids]
    return " / ".join(nomes)


def _diferencas(
    s: Session, atual: ServidorLotacao | None, novo: dict, postos: list[int]
) -> list[Alteracao]:
    def nome_de(modelo, ident, atributo="nome"):
        if ident is None:
            return "—"
        return _rotulo(s.get(modelo, ident), atributo)

    antes = {
        "unidade": nome_de(UnidadeUorg, atual.unidade_uorg_id, "nome_extenso") if atual else "—",
        "UORG": nome_de(UnidadeUorg, atual.uorg_id, "uorg_bruto") if atual else "—",
        "posto": " / ".join(p.nome for p in atual.postos) if atual and atual.postos else "—",
        "cargo": nome_de(Cargo, atual.cargo_id) if atual else "—",
        "função": (atual.funcao if atual else None) or "—",
    }
    depois = {
        "unidade": nome_de(UnidadeUorg, novo.get("unidade_uorg_id"), "nome_extenso"),
        "UORG": nome_de(UnidadeUorg, novo.get("uorg_id"), "uorg_bruto"),
        "posto": _nomes_de_postos(s, postos),
        "cargo": nome_de(Cargo, novo.get("cargo_id")),
        "função": novo.get("funcao") or "—",
    }
    return [
        Alteracao(campo, antes[campo], depois[campo])
        for campo in antes
        if antes[campo] != depois[campo]
    ]


def atualizar_cadastro(
    s: Session,
    servidor: Servidor,
    usuario: UsuarioAtual,
    *,
    nome: str,
    siape: str,
    email: str | None,
    situacao: str,
) -> Servidor:
    """Corrige os dados de identificação. Lotação e cargo mudam pelo histórico."""
    usuario.exigir("processo.editar")
    # RN-19: quem não pode LER nome e SIAPE também não os corrige. A tela já
    # esconde o formulário, mas esconder botão não é guarda: o POST continua
    # chegando, e sem esta linha a secretaria sobrescreveria às cegas o nome que
    # a lista ao lado se recusa a lhe mostrar.
    usuario.exigir("exposicao.ver")
    limpo = re.sub(r"\D", "", siape or "")
    if not re.fullmatch(r"\d{7}", limpo):
        raise LotacaoInvalida("a matrícula SIAPE tem exatamente 7 dígitos")
    if not (nome or "").strip():
        raise LotacaoInvalida("o nome não pode ficar em branco")

    if limpo != servidor.siape:
        ja = s.execute(
            select(Servidor).where(Servidor.siape == limpo, Servidor.id != servidor.id)
        ).scalar_one_or_none()
        if ja is not None:
            raise LotacaoInvalida(f"o SIAPE {limpo} já é de '{ja.nome}'")

    antes = {
        "nome": servidor.nome,
        "siape": servidor.siape,
        "email": servidor.email,
        "situacao": servidor.situacao,
    }
    servidor.nome = nome.strip()
    servidor.siape = limpo
    servidor.email = (email or "").strip() or None
    servidor.situacao = situacao or "ATIVO"
    auditoria.registrar_diferencas(
        s,
        entidade="servidor",
        entidade_id=servidor.id,
        antes=antes,
        depois={
            "nome": servidor.nome,
            "siape": servidor.siape,
            "email": servidor.email,
            "situacao": servidor.situacao,
        },
        usuario=usuario,
    )
    s.flush()
    return servidor


def _gravar_postos(s: Session, lotacao: ServidorLotacao, postos: list[int]) -> None:
    # o flush no meio apaga o vinculo antigo antes de reinserir o mesmo par:
    # a chave primaria e (lotacao, posto) e nao aceita os dois ao mesmo tempo
    lotacao.vinculos_posto.clear()
    s.flush()
    for ordem, posto_id in enumerate(dict.fromkeys(postos), start=1):
        lotacao.vinculos_posto.append(
            LotacaoPosto(posto_trabalho_id=posto_id, ordem=ordem)
        )
    s.flush()


def _montar_lotacao_inicial(
    servidor: Servidor,
    usuario: UsuarioAtual | None,
    inicio: date | None = None,
    documento: str | None = None,
) -> ServidorLotacao:
    """O período de origem com o que já está no cadastro, ainda FORA da sessão.

    Separado de `registrar_lotacao_inicial` porque `alterar_lotacao` precisa
    comparar com esse período antes de decidir se aceita a mudança — e não pode
    gravá-lo enquanto a decisão não sair.
    """
    return ServidorLotacao(
        servidor_id=servidor.id,
        unidade_uorg_id=servidor.unidade_uorg_id,
        uorg_id=servidor.uorg_id,
        cargo_id=servidor.cargo_id,
        funcao=servidor.funcao,
        vigencia_inicio=inicio or date.today(),
        documento=documento,
        registrado_por=usuario.id if usuario else None,
    )


def registrar_lotacao_inicial(
    s: Session,
    servidor: Servidor,
    usuario: UsuarioAtual | None,
    inicio: date | None = None,
    documento: str | None = None,
    postos: list[int] | None = None,
) -> ServidorLotacao:
    """Abre o primeiro período com o que já está no cadastro."""
    if historico(s, servidor.id):
        return historico(s, servidor.id)[-1]
    lotacao = _montar_lotacao_inicial(servidor, usuario, inicio=inicio, documento=documento)
    s.add(lotacao)
    s.flush()
    if postos:
        _gravar_postos(s, lotacao, postos)
    return lotacao


def alterar_lotacao(
    s: Session,
    servidor: Servidor,
    usuario: UsuarioAtual,
    *,
    unidade_uorg_id: int | None,
    cargo_id: int | None,
    funcao: str | None,
    a_partir_de: date,
    uorg_id: int | None = None,
    postos: list[int] | None = None,
    documento: str | None = None,
    observacao: str | None = None,
) -> ServidorLotacao:
    """Fecha o período corrente na véspera e abre o novo. Nada é sobrescrito."""
    usuario.exigir("processo.editar")

    linha = historico(s, servidor.id)
    origem_pendente: ServidorLotacao | None = None
    if not linha:
        # Cadastro antigo, sem histórico: o período de origem é MONTADO agora,
        # porque as checagens abaixo comparam com ele, mas só entra na sessão
        # depois que todas passarem. Gravá-lo antes deixava um período fantasma
        # sempre que a mudança era recusada: a rota devolve a ficha com o aviso,
        # e retorno normal (mesmo de recusa) faz a sessão da requisição commitar
        # tudo o que já estava escrito. Pior, na tentativa seguinte o fantasma
        # virava o "período atual" e passava a barrar datas anteriores a ele.
        origem_pendente = _montar_lotacao_inicial(
            servidor, usuario, inicio=min(a_partir_de - timedelta(days=1), date.today())
        )
        ultima = origem_pendente
    else:
        ultima = linha[-1]
    # Corrigir no mesmo dia em que o período começou não cria período novo: ele
    # teria duração zero e não há nada a preservar. É o caso comum de cadastrar
    # o servidor e ajustar a lotação em seguida.
    mesmo_dia = a_partir_de == ultima.vigencia_inicio and ultima.aberta
    if a_partir_de < ultima.vigencia_inicio:
        raise LotacaoInvalida(
            "a nova lotação precisa começar em ou depois do início da atual "
            f"({ultima.vigencia_inicio.isoformat()})"
        )

    escolhidos = [p for p in (postos or []) if p]
    novo = {
        "unidade_uorg_id": unidade_uorg_id,
        "uorg_id": uorg_id,
        "cargo_id": cargo_id,
        "funcao": (funcao or "").strip() or None,
    }
    mudancas = _diferencas(s, ultima, novo, escolhidos)
    if not mudancas:
        raise LotacaoInvalida(
            "nada mudou: unidade, UORG, posto, cargo e função são os mesmos"
        )

    for posto_id in escolhidos:
        posto = s.get(PostoTrabalho, posto_id)
        if posto is None:
            continue
        if unidade_uorg_id is not None and posto.unidade_uorg_id != unidade_uorg_id:
            raise LotacaoInvalida(
                f"o posto '{posto.nome}' pertence a outra unidade — escolha postos "
                "da unidade selecionada"
            )

    # daqui para baixo não há mais recusa: agora pode escrever
    if origem_pendente is not None:
        s.add(origem_pendente)
        s.flush()

    if mesmo_dia:
        lotacao = ultima
        for campo, valor in novo.items():
            setattr(lotacao, campo, valor)
        if documento:
            lotacao.documento = documento.strip()
        if observacao:
            lotacao.observacao = observacao.strip()
    else:
        # fecha o periodo anterior na vespera: sem lacuna e sem sobreposicao
        ultima.vigencia_fim = a_partir_de - timedelta(days=1)
        lotacao = ServidorLotacao(
            servidor_id=servidor.id,
            vigencia_inicio=a_partir_de,
            documento=(documento or "").strip() or None,
            observacao=(observacao or "").strip() or None,
            registrado_por=usuario.id,
            **novo,
        )
        s.add(lotacao)
    s.flush()
    _gravar_postos(s, lotacao, escolhidos)

    # o cadastro passa a refletir o periodo mais recente
    if a_partir_de <= date.today():
        servidor.unidade_uorg_id = unidade_uorg_id
        servidor.uorg_id = uorg_id
        servidor.cargo_id = cargo_id
        servidor.funcao = novo["funcao"]

    auditoria.registrar(
        s,
        entidade="servidor",
        entidade_id=servidor.id,
        tipo_evento="LOTACAO_ALTERADA",
        descricao=(
            f"A partir de {a_partir_de.isoformat()}: "
            + "; ".join(f"{m.campo} {m.de} → {m.para}" for m in mudancas)
            + (f" (documento: {documento})" if documento else "")
        ),
        usuario=usuario,
    )
    for mudanca in mudancas:
        auditoria.registrar(
            s,
            entidade="servidor_lotacao",
            entidade_id=lotacao.id,
            tipo_evento="CAMPO_ALTERADO",
            descricao=f"{mudanca.campo}: {mudanca.de} → {mudanca.para}",
            campo=mudanca.campo,
            valor_anterior=mudanca.de,
            valor_novo=mudanca.para,
            usuario=usuario,
        )
    s.flush()
    return lotacao


def corrigir_lotacao(
    s: Session,
    lotacao: ServidorLotacao,
    usuario: UsuarioAtual,
    *,
    documento: str | None,
    observacao: str | None,
) -> ServidorLotacao:
    """Corrige só o documento e a observação. Data e destino não se corrigem:
    para isso existe um novo período — senão a linha do tempo vira ficção."""
    usuario.exigir("processo.editar")
    antes = {"documento": lotacao.documento, "observacao": lotacao.observacao}
    lotacao.documento = (documento or "").strip() or None
    lotacao.observacao = (observacao or "").strip() or None
    auditoria.registrar_diferencas(
        s,
        entidade="servidor_lotacao",
        entidade_id=lotacao.id,
        antes=antes,
        depois={"documento": lotacao.documento, "observacao": lotacao.observacao},
        usuario=usuario,
    )
    s.flush()
    return lotacao


def inconsistencias(s: Session, servidor_id: int) -> list[str]:
    """Lacuna ou sobreposição na linha do tempo."""
    problemas: list[str] = []
    linha = historico(s, servidor_id)
    for anterior, seguinte in zip(linha, linha[1:], strict=False):
        if anterior.vigencia_fim is None:
            problemas.append(
                f"o período iniciado em {anterior.vigencia_inicio.isoformat()} não foi "
                "encerrado, mas já existe um posterior"
            )
        elif seguinte.vigencia_inicio <= anterior.vigencia_fim:
            problemas.append(
                f"sobreposição entre {anterior.vigencia_inicio.isoformat()} e "
                f"{seguinte.vigencia_inicio.isoformat()}"
            )
        elif (seguinte.vigencia_inicio - anterior.vigencia_fim).days > 1:
            dias = (seguinte.vigencia_inicio - anterior.vigencia_fim).days - 1
            problemas.append(
                f"lacuna de {dias} dia(s) antes de {seguinte.vigencia_inicio.isoformat()}"
            )
    return problemas
