"""A busca que atravessa o sistema — um bloco por entidade, cada um guardado.

Por que existe: a caixa do cabeçalho despejava em `/processos` e só sabia achar
processo. Quem procurava uma pessoa **sem** processo recebia lista vazia e
concluía que ela não estava cadastrada; o almoxarife, que não tem `processo.ver`,
não tinha `Ctrl+K` nenhum. Na 1.27.0 o rótulo passou a dizer a verdade e a caixa
passou a aparecer só para quem podia usá-la — honesto, e ainda assim metade da
função. Isto aqui é a outra metade.

**A regra que organiza o arquivo é uma só: cada bloco é guardado pela permissão
que a ROTA DE DESTINO exige, e nunca devolve linha que a tela de destino não
mostraria a esta pessoa.** É o invariante do menu (`test_link_no_menu_sempre_abre`)
aplicado a um campo de texto: resultado que leva a 403 é porta trancada, e
resultado que a tela de destino esconderia é vazamento pela porta dos fundos.
Daí cada bloco reusar a consulta da sua tela — `repositorios.processos.buscar`,
`aplicar_escopo` no certificado e na turma, `servico.fila` na requisição — em vez
de escrever um SELECT novo que decidiria escopo de novo, e diferente.

Três coisas que a busca **não** faz, e o porquê:

- **Não busca por CPF.** O sistema não armazena CPF em campo nenhum (RN-21;
  decisão 1 do desenho de EPI), e uma caixa que aceita onze dígitos e responde
  "nada encontrado" sugere que armazena e que a pessoa não está lá. A detecção é
  `textos.parece_cpf`, a mesma da fila de EPI.
- **Não casa por nome para quem não pode ler aquele nome** (`identificacao.casa_a_busca`).
  Um filtro que casasse amarraria o nome ao `SRV-xxxx` da sessão, que é a ligação
  exata que a RN-19 existe para impedir.
- **Não grava `acesso_dado_sensivel`.** O argumento está em `/buscar`
  (`rotas/busca.py`), junto da decisão.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.modelos import Certificado, EpiRequisicao, LaudoTecnico, Servidor, Turma
from app.repositorios import processos as repo_processos
from app.servicos import epi_requisicao as servico_requisicao, identificacao, textos
from app.servicos.certificado import normalizar_chave
from app.servicos.rbac import UsuarioAtual, aplicar_escopo

# Oito linhas por bloco. A busca global é um índice, não uma lista: com seis
# blocos abertos, vinte linhas em cada uma empurrariam os cinco últimos para
# fora da dobra e a tela deixaria de responder "onde está isto". Quem precisa da
# lista inteira segue o "ver todos" do bloco, que leva à tela que pagina.
LIMITE_POR_BLOCO = 8

RECADO_CPF = (
    "A busca não aceita CPF: o sistema não armazena CPF em campo nenhum "
    "(RN-21) — servidor se identifica por SIAPE. Procure pelo nome, pelo SIAPE, "
    "pelo NUP, pelo número do laudo, pelo protocolo do pedido de EPI, pelo "
    "código da turma ou pela chave do certificado."
)

# `{bloco: permissões que abrem a tela de destino}`. "Qualquer uma destas", como
# `modulos.Item.permissao` — e pela mesma razão de lá: o servidor tem DUAS telas
# de destino (`/servidores` e `/epis/fichas`), e quem só opera EPI chega numa
# delas. Bloco novo entra aqui e em `_BLOCOS`, e em lugar nenhum mais.
PERMISSOES_POR_BLOCO: dict[str, tuple[str, ...]] = {
    "servidor": ("processo.ver", "epi.ficha"),
    "processo": ("processo.ver",),
    "laudo": ("laudo.ver",),
    "requisicao": ("epi.ver",),
    "turma": ("treinamento.ver",),
    "certificado": ("certificado.ver",),
}


def pode_buscar(usuario: UsuarioAtual | None) -> bool:
    """A caixa do cabeçalho aparece? Só se algum bloco abrir para a pessoa.

    O desenho da auditoria pedia a caixa para todo mundo, e quase: quem não tem
    nenhuma das seis permissões (o `admin_ti`, que é conta, senha, auditoria e
    backup) receberia um campo que aceita o que ele digitar e nunca acha nada.
    Isso é a porta trancada do menu em forma de campo de texto — o mesmo defeito
    que a 1.27.0 consertou escondendo a caixa, só que mais lento de descobrir,
    porque a caixa responde "nada encontrado" em vez de 403.

    A rota continua abrindo para qualquer sessão: quem digitar `/buscar` na URL
    recebe a explicação, e não um terceiro 403. É o mesmo recuo de `/modulos`.
    """
    if usuario is None:
        return False
    return any(
        usuario.pode(codigo)
        for codigos in PERMISSOES_POR_BLOCO.values()
        for codigo in codigos
    )


def _visivel(usuario: UsuarioAtual, bloco: str) -> bool:
    return any(usuario.pode(codigo) for codigo in PERMISSOES_POR_BLOCO[bloco])


@dataclass(frozen=True)
class Bloco:
    """Um recorte da busca, já decidido: o que achou e para onde leva.

    `itens` são os OBJETOS do modelo, e não texto pronto. É deliberado: quem
    imprime servidor tem de passar por `identificar(...)` no template, e é o
    template que `test_rn19_nenhum_template_le_nome_de_servidor_direto` varre.
    Um serviço que já devolvesse "Marco Antônio · SIAPE 1110654" passaria por
    baixo da varredura inteira.
    """

    codigo: str
    rotulo: str
    # o que este bloco casa, em português. Aparece no vazio: dizer "nada
    # encontrado" sem dizer ONDE se procurou faz a pessoa repetir a mesma busca.
    chaves: str
    itens: list[Any]
    # a tela cheia deste bloco, com o termo propagado — ou vazio, quando não há
    # tela que aceite busca por este termo
    ver_todos: str = ""
    # veio uma linha a mais do que cabe: a consulta pede `limite + 1` justamente
    # para poder dizer isto sem uma segunda consulta só para contar
    ha_mais: bool = False


def _cortar(linhas: list[Any], limite: int) -> tuple[list[Any], bool]:
    return linhas[:limite], len(linhas) > limite


def _bloco_servidor(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """Nome e SIAPE — o bloco que faltava e que dava nome à queixa da auditoria.

    Espelha `/servidores`: o cadastro inteiro é lido e filtrado em Python, porque
    o critério do nome não é uma cláusula SQL — é `pode_ver_nominal` por LINHA
    (RN-19). Sem escopo, como a tela: `/servidores` lista todo o cadastro para
    quem tem `processo.ver`, com a identificação suprimida linha a linha, e a
    busca não pode achar menos do que a tela mostra nem mais.

    O destino depende de quem pergunta, e é por isso que ele é decidido aqui:
    quem tem `processo.ver` vai para o cadastro; o almoxarife, que não a tem, vai
    para a ficha de EPI. Oferecer a primeira a ele seria o 403 que
    `test_a_ficha_de_epi_nao_manda_o_almoxarife_para_o_403` fechou na trilha.
    """
    alvo = textos.chave_busca(q)
    achados: list[Servidor] = []
    for servidor in s.execute(select(Servidor).order_by(Servidor.nome)).scalars():
        if identificacao.casa_a_busca(alvo, servidor, usuario):
            achados.append(servidor)
            if len(achados) > limite:
                break
    itens, ha_mais = _cortar(achados, limite)
    if usuario.pode("processo.ver"):
        destino = f"/servidores?q={quote(q)}"
    else:
        destino = f"/epis/fichas?q={quote(q)}"
    return Bloco(
        codigo="servidor",
        rotulo="Servidores",
        chaves="nome e SIAPE",
        itens=itens,
        ver_todos=destino,
        ha_mais=ha_mais,
    )


def _bloco_processo(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """NUP, observação, URL do SEI, número do laudo e o servidor do processo.

    A consulta é a do repositório, com o escopo do perfil aplicado por `_base`.
    Reescrevê-la aqui seria manter dois critérios de "achar processo" — e o que
    ficasse para trás acharia menos do que a própria tela de processos.
    """
    linhas = repo_processos.buscar(s, usuario, q, limite)
    itens, ha_mais = _cortar(linhas, limite)
    return Bloco(
        codigo="processo",
        rotulo="Processos",
        chaves="NUP, observação, link do SEI, número do laudo e servidor",
        itens=itens,
        ver_todos=f"/processos?q={quote(q)}",
        ha_mais=ha_mais,
    )


def _bloco_laudo(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """Número SIAPE do laudo.

    Sem `aplicar_escopo`, e não por esquecimento: `laudo_tecnico` não tem
    `campus_id` nem `servidor_id`, então o escopo próprio devolveria
    `where(False)` — lista vazia sem erro nenhum, que é o modo de falha que
    `_conferir_escopos` existe para evitar. `/laudos` também não escopa, e o
    invariante desta busca é não achar mais nem menos do que a tela de destino.
    """
    alvo = f"%{q.strip()}%"
    consulta = (
        select(LaudoTecnico)
        .where(LaudoTecnico.numero_siape.like(alvo))
        .order_by(LaudoTecnico.numero_siape.desc())
        .limit(limite + 1)
    )
    itens, ha_mais = _cortar(list(s.execute(consulta).scalars()), limite)
    return Bloco(
        codigo="laudo",
        rotulo="Laudos técnicos",
        chaves="número do laudo",
        itens=itens,
        ver_todos=f"/laudos?q={quote(q)}",
        ha_mais=ha_mais,
    )


def _bloco_requisicao(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """Protocolo do pedido e a identificação de quem vai usar o equipamento.

    Reusa a fila de `/epis/requisicoes` e o filtro dela — inclusive o rascunho
    sem protocolo, que a fila mostra. O critério do nome é o da RN-19, e o
    protocolo vale para todo mundo: `EPI-2026-0007` não nomeia ninguém.
    """
    alvo = textos.chave_busca(q)
    achados: list[EpiRequisicao] = []
    for requisicao in reversed(servico_requisicao.fila(s, usuario)):
        if _casa_requisicao(requisicao, alvo, usuario):
            achados.append(requisicao)
            if len(achados) > limite:
                break
    itens, ha_mais = _cortar(achados, limite)
    return Bloco(
        codigo="requisicao",
        rotulo="Requisições de EPI",
        chaves="protocolo e identificação do servidor",
        itens=itens,
        ver_todos=f"/epis/requisicoes?q={quote(q)}",
        ha_mais=ha_mais,
    )


def _casa_requisicao(requisicao: EpiRequisicao, alvo: str, usuario: UsuarioAtual) -> bool:
    """O mesmo critério de `rotas/epi_requisicoes._casa_a_busca`.

    Não é importado de lá porque rota não é biblioteca de serviço — o que as duas
    compartilham de verdade é `identificacao.casa_a_busca`, que é onde mora a
    decisão que pode vazar. O que sobra aqui é o protocolo, que não nomeia
    ninguém e por isso vale para quem abre a fila.
    """
    if alvo in textos.chave_busca(requisicao.protocolo or ""):
        return True
    return identificacao.casa_a_busca(alvo, requisicao.servidor, usuario)


def _bloco_turma(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """Código da turma (`TUR-2026-0007`), com o escopo de `/turmas`."""
    alvo = f"%{q.strip()}%"
    consulta = aplicar_escopo(select(Turma), usuario, Turma).where(Turma.codigo.like(alvo))
    consulta = consulta.order_by(Turma.ano.desc(), Turma.numero.desc()).limit(limite + 1)
    itens, ha_mais = _cortar(list(s.execute(consulta).scalars()), limite)
    return Bloco(
        codigo="turma",
        rotulo="Turmas",
        chaves="código da turma",
        itens=itens,
        # `/turmas` filtra por situação e treinamento, não por texto: mandar o
        # termo para lá abriria a lista inteira fingindo ter buscado
        ver_todos="/turmas",
        ha_mais=ha_mais,
    )


_RE_NUMERO_ANO = re.compile(r"^\s*(\d{1,6})\s*(?:/\s*(\d{4}))?\s*$")


def _bloco_certificado(s: Session, usuario: UsuarioAtual, q: str, limite: int) -> Bloco:
    """Número (`12/2026`) e chave de validação, com o escopo de `/certificados`.

    A chave é comparada por IGUALDADE, e não por `like`: ela é o segredo que a
    validação pública consome, e busca parcial sobre segredo é enumeração. O
    número é o que se lê no papel, e por isso aceita `12` e `12/2026`.
    """
    condicoes = [Certificado.chave_validacao == normalizar_chave(q)]
    casa = _RE_NUMERO_ANO.match(q)
    if casa:
        numero, ano = int(casa.group(1)), casa.group(2)
        condicao = Certificado.numero == numero
        if ano:
            condicao = condicao & (Certificado.ano == int(ano))
        condicoes.append(condicao)
    consulta = aplicar_escopo(select(Certificado), usuario, Certificado).where(
        or_(*condicoes)
    )
    consulta = consulta.order_by(
        Certificado.ano.desc(), Certificado.numero.desc()
    ).limit(limite + 1)
    itens, ha_mais = _cortar(list(s.execute(consulta).scalars()), limite)
    return Bloco(
        codigo="certificado",
        rotulo="Certificados",
        chaves="número e chave de validação",
        itens=itens,
        ver_todos=f"/certificados?busca={quote(q)}",
        ha_mais=ha_mais,
    )


# A ordem é a da tela, e é a ordem da pergunta: quem digita um nome procura uma
# pessoa; quem digita um número procura o documento dela.
_BLOCOS = (
    ("servidor", _bloco_servidor),
    ("processo", _bloco_processo),
    ("laudo", _bloco_laudo),
    ("requisicao", _bloco_requisicao),
    ("turma", _bloco_turma),
    ("certificado", _bloco_certificado),
)


# O nome de cada bloco em português corrido, para a frase "procurei em …". Fica
# ao lado da tabela de permissões porque as duas respondem à mesma pergunta —
# quais blocos existem — e uma lista que só tivesse metade nomearia um bloco sem
# guarda ou guardaria um bloco sem nome.
ROTULO_POR_BLOCO: dict[str, str] = {
    "servidor": "servidores",
    "processo": "processos",
    "laudo": "laudos",
    "requisicao": "requisições de EPI",
    "turma": "turmas",
    "certificado": "certificados",
}


def cobertura(usuario: UsuarioAtual) -> list[str]:
    """O que a busca cobre PARA ESTA PESSOA, em português.

    A tela precisa disto com a busca vazia (para dizer o que ela faz) e no
    resultado vazio (para dizer onde procurou — "nada encontrado" sem dizer onde
    faz a pessoa repetir a mesma busca). O que ela NUNCA diz é o que ficou de
    fora: nomear o bloco escondido já afirma que existe alguma coisa que ela não
    pode ver, e "não achei" e "você não pode ver" têm de ser indistinguíveis de
    fora — senão a tela vira o oráculo por outro caminho.
    """
    return [
        ROTULO_POR_BLOCO[codigo]
        for codigo, _ in _BLOCOS
        if _visivel(usuario, codigo)
    ]


def buscar(
    s: Session, usuario: UsuarioAtual, q: str, limite: int = LIMITE_POR_BLOCO
) -> list[Bloco]:
    """Uma consulta por bloco, e só nos blocos que esta pessoa pode ver.

    Consultar o que não vai ser mostrado custa o mesmo e não serve para nada —
    e, num sistema em que a diferença entre "não achou" e "não pode ver" é a
    coisa a proteger, é o caminho mais curto para alguém instrumentar o tempo de
    resposta.
    """
    limpo = (q or "").strip()
    if not limpo or textos.parece_cpf(limpo):
        return []
    return [
        montar(s, usuario, limpo, limite)
        for codigo, montar in _BLOCOS
        if _visivel(usuario, codigo)
    ]
