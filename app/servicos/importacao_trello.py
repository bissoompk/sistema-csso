"""Fase 3 - importacao do quadro do Trello a partir do JSON completo.

Usa o JSON do quadro (`/b/<id>.json`), nao o CSV: so ele traz o feed `actions`.
Lista nao mapeada vira `migracao_rejeitada` - nunca chute.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta  # noqa: F401
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    Checklist,
    ChecklistItem,
    FluxoEtapa,
    HistoricoEvento,
    MigracaoRejeitada,
    Processo,
    Servidor,
    StgTrelloAcao,
    StgTrelloCartao,
    TipoProcesso,
)
from app.servicos import auditoria, nup as servico_nup, textos
from app.servicos.rbac import UsuarioAtual

ORIGEM = "TRELLO"
MOTIVO_NAO_PROCESSO = "CARTAO_NAO_PROCESSO"

# De-para de listas, explicito e semeado. Lista fora daqui = rejeitada, nunca
# chutada. Conferido contra o quadro real "SEI" (23 listas, 727 cartoes) em
# 11/08/2026 - a especificacao original citava 8 listas e 475 cartoes.
DEPARA_LISTAS: dict[str, dict] = {
    "não iniciado": {"etapa": "NAO_INICIADO", "estado": "NAO_INICIADO"},
    "a fazer": {"etapa": "A_FAZER", "estado": "EM_TRIAGEM"},
    "em andamento": {"etapa": "EM_ANDAMENTO", "estado": "AGUARDANDO_INSPECAO"},
    "aguardando": {"etapa": "AGUARDANDO", "estado": "PENDENTE_DOCUMENTO"},
    # filas de entrada do quadro (todos os tipos, nao so adicional)
    "entrada": {"etapa": "A_FAZER", "estado": "RECEBIDO"},
    "processos": {"etapa": "A_FAZER", "estado": "RECEBIDO"},
    "delegar": {"etapa": "A_FAZER", "estado": "RECEBIDO"},
    "adicional ocupacional": {
        "etapa": "BACKLOG_ADICIONAL",
        "estado": "RECEBIDO",
        "tipo": "ADICIONAL_OCUPACIONAL",
        "repositorio": True,
        "separar_backlog": True,
    },
    "adicional ocupacional - campus avançados": {
        "etapa": "BACKLOG_CAMPI_AVANCADOS",
        "estado": "RECEBIDO",
        "tipo": "ADICIONAL_OCUPACIONAL",
        "repositorio": True,
        "campi": ("JAN", "UNA"),
    },
    "adicional ocupacional - digitalizados": {
        "etapa": "BACKLOG_ADICIONAL",
        "estado": "RECEBIDO",
        "tipo": "ADICIONAL_OCUPACIONAL",
        "repositorio": True,
        "separar_backlog": True,
    },
    "aposentadoria especial = concluídos": {
        "etapa": "ARQUIVO_APOSENTADORIA",
        "estado": "CONCLUIDO",
        "tipo": "APOSENTADORIA_ESPECIAL",
        "repositorio": True,
        "situacao": "CONCLUIDO",
    },
    "comissões": {
        "etapa": "A_FAZER",
        "estado": "RECEBIDO",
        "tipo": "CONSULTA_NORMATIVA",
    },
    # Paineis e listas de anotacao NAO sao etapa e NAO viram processo.
    "painel geral": {"ignorar": True},
    "painel de controle": {"ignorar": True},
    "processos geral - informação": {"ignorar": True},
}

MOTIVO_LISTA_IGNORADA = "LISTA_DE_ANOTACAO"

# Aceita "Concluído 2025", "Concluído - 2021" e "Processos Concluidos - 2022".
RE_CONCLUIDO_ANO = re.compile(
    r"(?i)^(?:processos\s+)?conclu[íi]d[oa]s?\s*[-–]?\s*(?P<ano>\d{4})$"
)
# Cuidado com a ancora: `^(1-)?modelo|MODELO|...` com .match() ancora TODAS as
# alternativas no inicio, e ai 'ADICIONAL DE INSALUBRIDADE ANTIGO' passa como se
# fosse processo. Os exemplos reais trazem a palavra no meio do titulo, entao a
# busca e por palavra inteira em qualquer posicao.
RE_NAO_PROCESSO = re.compile(
    r"(?i)(?:^\s*(?:1-)?modelo\b)|\bmodelos?\b|\bantigos?\b|\bdesativad[oa]s?\b"
)
RE_PARECER_TITULO = re.compile(r"(?P<numero>\d{1,3})\s*[-/]\s*(?P<ano>\d{4})$")
# Duas grafias reais no quadro: 'Parecer (1234567).pdf' e 'SEI_1486577_Oficio.pdf'
RE_DOC_SEI_ANEXO = re.compile(
    r"(?i)\((?P<doc_sei>\d{7})\)|\bSEI[_ -](?P<doc_sei2>\d{7})(?!\d)"
)
RE_PARECER_ANEXO = re.compile(r"(?i)Parecer[ _]T[eé]cnico[ _](\d{2})[-/](\d{4})")
RE_LAUDO_ANEXO = re.compile(r"(26255)-?(000)\.?(\d{3})\.?/?(\d{4})")


@dataclass
class RelatorioTrello:
    cartoes: int = 0
    processos: int = 0
    eventos: int = 0
    anexos: int = 0
    anexos_duplicados: int = 0
    anexos_perdidos: list[tuple[str, str]] = field(default_factory=list)
    rejeitados: list[tuple[str, str]] = field(default_factory=list)
    listas_desconhecidas: set[str] = field(default_factory=set)
    conflitos_numeracao: list[dict] = field(default_factory=list)
    orfaos_processo: list[str] = field(default_factory=list)
    laudos_candidatos: list[dict] = field(default_factory=list)
    backlog_historico: int = 0
    backlog_pendente: int = 0
    motivos_pendente: list[dict] = field(default_factory=list)


def baixar_url(url: str, tempo_limite: int = 60) -> bytes:
    """Busca o anexo no Trello. As URLs expiram - baixe tudo antes do corte.

    Anexo do Trello exige autenticacao: sem `CSSO_TRELLO_KEY`/`CSSO_TRELLO_TOKEN`
    no .env isto devolve 401 e o anexo entra no relatorio de perdidos.
    """
    import os
    import urllib.request

    chave = os.environ.get("CSSO_TRELLO_KEY", "")
    token = os.environ.get("CSSO_TRELLO_TOKEN", "")
    cabecalhos = {"User-Agent": "CSSO/1.0"}
    if chave and token:
        cabecalhos["Authorization"] = f'OAuth oauth_consumer_key="{chave}", oauth_token="{token}"'
    requisicao = urllib.request.Request(url, headers=cabecalhos)
    with urllib.request.urlopen(requisicao, timeout=tempo_limite) as resposta:
        return resposta.read()


ARQUIVO_INDICE_ANEXOS = "_indice.json"


def buscar_em_pasta(pasta: Path):
    """Fabrica um `buscar_anexo` que le os bytes de uma pasta local.

    Usa o indice url -> arquivo escrito por `ferramentas/baixar_trello.py`;
    nomes de anexo se repetem entre cartoes, entao casar so pelo nome perderia
    arquivo. Sem indice, cai para a busca por nome.
    """
    import json

    por_url: dict[str, Path] = {}
    indice_arquivo = pasta / ARQUIVO_INDICE_ANEXOS
    if indice_arquivo.exists():
        for url, nome in json.loads(indice_arquivo.read_text(encoding="utf-8")).items():
            por_url[url] = pasta / nome

    por_nome: dict[str, Path] = {}
    if pasta.exists():
        for arquivo in pasta.rglob("*"):
            if arquivo.is_file() and arquivo.name != ARQUIVO_INDICE_ANEXOS:
                por_nome.setdefault(arquivo.name, arquivo)
                por_nome.setdefault(textos.chave_busca(arquivo.name), arquivo)

    def buscar(url: str) -> bytes:
        alvo = por_url.get(url)
        if alvo is None:
            nome = urllib_parse_nome(url)
            alvo = por_nome.get(nome) or por_nome.get(textos.chave_busca(nome))
        if alvo is None or not alvo.exists():
            raise FileNotFoundError(f"anexo não encontrado em {pasta}: {url}")
        return alvo.read_bytes()

    return buscar


def urllib_parse_nome(url: str) -> str:
    from urllib.parse import unquote, urlparse

    return unquote(urlparse(url).path.rsplit("/", 1)[-1])


def _mime_por_extensao(nome: str) -> str:
    import mimetypes

    return mimetypes.guess_type(nome)[0] or "application/octet-stream"


CATEGORIA_POR_PALAVRA: tuple[tuple[str, str], ...] = (
    ("parecer", "PARECER_ASSINADO"),
    ("laudo", "LAUDO"),
    ("portaria", "PORTARIA"),
    ("despacho", "DESPACHO"),
    ("formulario", "FORMULARIO"),
    ("formulário", "FORMULARIO"),
    ("relatorio", "RELATORIO_CAMPO"),
    ("relatório", "RELATORIO_CAMPO"),
    ("foto", "FOTO"),
)


def categoria_do_anexo(nome: str | None) -> str:
    alvo = textos.chave_busca(nome)
    for palavra, categoria in CATEGORIA_POR_PALAVRA:
        if textos.chave_busca(palavra) in alvo:
            return categoria
    return "OUTRO"


def parecer_candidato(nome: str | None) -> str | None:
    """'MARCÍLIO COELHO FERREIRA 01-2025' -> '1/2025'. Nunca vincula sozinho."""
    if not nome:
        return None
    m = RE_PARECER_TITULO.search(nome.strip())
    if not m:
        return None
    return f"{int(m.group('numero'))}/{m.group('ano')}"


def laudo_candidato(texto: str | None) -> str | None:
    """'Laudo 26255-000.1102022' -> '26255-000.110/2022' (marcado para conferência)."""
    if not texto:
        return None
    m = RE_LAUDO_ANEXO.search(texto)
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2)}.{m.group(3)}/{m.group(4)}"


def documento_sei_de_anexo(nome: str | None) -> str | None:
    if not nome:
        return None
    m = RE_DOC_SEI_ANEXO.search(nome)
    if not m:
        return None
    return m.group("doc_sei") or m.group("doc_sei2")


# ---------------------------------------------------------------------
# Separacao do backlog: cadastro historico x trabalho pendente
# ---------------------------------------------------------------------
# O backlog "Adicional Ocupacional" tem 381 cartoes com idade mediana de 3 anos.
# 92% deles nao tem anexo, checklist, comentario nem descricao alem do NUP: sao
# o cadastro historico de quem ja teve adicional, nao fila de trabalho. Tratar
# tudo como fila faz o setor carregar 381 pendencias que ninguem vai executar -
# e um painel que sempre mente e um painel que se aprende a ignorar.
#
# Um cartao so conta como TRABALHO PENDENTE se deixou algum rastro de trabalho.
DIAS_PARA_HISTORICO = 365
TAMANHO_DESCRICAO_UTIL = 40


@dataclass
class Classificacao:
    historico: bool
    motivo: str


def classificar_backlog(cartao: dict, hoje: date | None = None) -> Classificacao:
    """Devolve se o cartao e cadastro historico ou trabalho pendente.

    Qualquer sinal de trabalho — anexo, checklist, comentario, prazo, descricao
    com conteudo ou atividade recente — mantem o cartao na fila. So vira
    historico o cartao que e apenas um nome e um numero de processo parado.
    """
    hoje = hoje or date.today()
    marcas = cartao.get("badges") or {}
    sinais: list[str] = []

    if (marcas.get("attachments") or 0) or (cartao.get("attachments") or []):
        sinais.append("tem anexo")
    if (marcas.get("checkItems") or 0) or (cartao.get("checklists") or []):
        sinais.append("tem checklist")
    if marcas.get("comments") or 0:
        sinais.append("tem comentário")
    if cartao.get("due") and not cartao.get("dueComplete"):
        sinais.append("tem prazo em aberto")

    descricao = (cartao.get("desc") or "").strip()
    # a descricao tipica do cadastro e so "SEI 23086.000171/1993-41"
    sem_nup = re.sub(r"(?i)\bsei\b|23086\.\d{6}/\d{4}-\d{2}", "", descricao).strip()
    if len(sem_nup) >= TAMANHO_DESCRICAO_UTIL:
        sinais.append("tem descrição com conteúdo")

    quando = _momento(cartao.get("dateLastActivity"))
    dias = (hoje - quando.date()).days if quando else None
    if dias is not None and dias <= DIAS_PARA_HISTORICO:
        sinais.append(f"movimentado há {dias} dias")

    if sinais:
        return Classificacao(False, "; ".join(sinais))
    return Classificacao(
        True,
        "somente nome e número de processo, sem movimento há mais de "
        f"{DIAS_PARA_HISTORICO} dias",
    )


def _mapear_lista(nome: str | None) -> dict | None:
    if not nome:
        return None
    chave = textos.chave_busca(nome)
    for original, regra in DEPARA_LISTAS.items():
        if textos.chave_busca(original) == chave:
            return dict(regra)
    m = RE_CONCLUIDO_ANO.match(nome.strip())
    if m:
        return {
            "etapa": "CONCLUIDO",
            "estado": "CONCLUIDO",
            "situacao": "CONCLUIDO",
            "ano_referencia": int(m.group("ano")),
        }
    return None


def _e_cartao_de_processo(cartao: dict, nup: str | None, servidor) -> bool:
    nome = (cartao.get("name") or "").strip()
    if RE_NAO_PROCESSO.search(nome):
        return False
    return bool(nup or servidor)


def _casar_servidor(s: Session, nome: str | None) -> Servidor | None:
    if not nome:
        return None
    limpo = re.sub(r"\s*\d{1,3}\s*[-/]\s*\d{4}$", "", nome).strip()
    alvo = textos.chave_busca(limpo)
    if not alvo:
        return None
    for servidor in s.execute(select(Servidor)).scalars():
        if textos.chave_busca(servidor.nome) == alvo:
            return servidor
    return None


def carregar_staging(s: Session, dados: dict) -> tuple[list[dict], list[dict]]:
    listas = {l["id"]: l.get("name") for l in dados.get("lists", [])}
    cartoes = dados.get("cards", [])
    for cartao in cartoes:
        card_id = cartao.get("id")
        if not card_id:
            continue
        registro = s.execute(
            select(StgTrelloCartao).where(StgTrelloCartao.card_id == card_id)
        ).scalar_one_or_none()
        if registro is None:
            registro = StgTrelloCartao(card_id=card_id)
            s.add(registro)
        registro.nome = cartao.get("name")
        registro.descricao = cartao.get("desc")
        registro.lista = listas.get(cartao.get("idList"))
        registro.payload = cartao
        registro.parecer_candidato = parecer_candidato(cartao.get("name"))
        registro.laudo_candidato = laudo_candidato(
            " ".join(a.get("name", "") for a in cartao.get("attachments", []) or [])
        )
    acoes = dados.get("actions", [])
    for acao in acoes:
        action_id = acao.get("id")
        if not action_id:
            continue
        registro = s.execute(
            select(StgTrelloAcao).where(StgTrelloAcao.action_id == action_id)
        ).scalar_one_or_none()
        if registro is None:
            registro = StgTrelloAcao(action_id=action_id)
            s.add(registro)
        registro.card_id = (acao.get("data", {}).get("card") or {}).get("id")
        registro.tipo = acao.get("type")
        registro.data = acao.get("date")
        registro.autor = (acao.get("memberCreator") or {}).get("fullName")
        registro.payload = acao
    s.flush()
    return cartoes, acoes


def importar(
    s: Session,
    caminho: Path,
    usuario: UsuarioAtual,
    aplicar: bool = True,
    buscar_anexo=baixar_url,
) -> RelatorioTrello:
    dados = json.loads(Path(caminho).read_text(encoding="utf-8"))
    cartoes, acoes = carregar_staging(s, dados)
    relatorio = RelatorioTrello(cartoes=len(cartoes))

    listas = {l["id"]: l.get("name") for l in dados.get("lists", [])}
    tipos = {t.codigo: t for t in s.execute(select(TipoProcesso)).scalars()}
    etapas = {e.codigo: e for e in s.execute(select(FluxoEtapa)).scalars()}
    por_card: dict[str, Processo] = {}

    for cartao in cartoes:
        nome_lista = listas.get(cartao.get("idList"))
        regra = _mapear_lista(nome_lista)
        ref = cartao.get("id") or "?"
        if regra is None:
            relatorio.listas_desconhecidas.add(nome_lista or "(sem lista)")
            _rejeitar(s, relatorio, ref, f"lista não mapeada: {nome_lista!r}", cartao)
            continue
        if regra.get("ignorar"):
            # painel/anotacao: fica registrado, mas nao vira processo
            _rejeitar(
                s,
                relatorio,
                ref,
                f"{MOTIVO_LISTA_IGNORADA}: a lista {nome_lista!r} é painel de "
                "anotação, não etapa do fluxo",
                cartao,
            )
            continue

        nups = servico_nup.extrair(cartao.get("desc"))
        nup = nups[0] if nups else None
        servidor = _casar_servidor(s, cartao.get("name"))

        # relatorio de orfaos: todo cartao sem NUP entra, tenha ou nao virado
        # processo - inclusive os recusados por CARTAO_NAO_PROCESSO.
        if nup is None:
            relatorio.orfaos_processo.append(cartao.get("name") or ref)

        if not _e_cartao_de_processo(cartao, nup, servidor):
            _rejeitar(s, relatorio, ref, MOTIVO_NAO_PROCESSO, cartao)
            continue

        if not aplicar:
            # Simulacao: nao grava, mas calcula tudo o que a carga faria. Um
            # ensaio que responde "0 processos" nao serve para revisar nada.
            relatorio.processos += 1
            if regra.get("separar_backlog"):
                classe = classificar_backlog(cartao)
                if classe.historico:
                    relatorio.backlog_historico += 1
                else:
                    relatorio.backlog_pendente += 1
                    relatorio.motivos_pendente.append(
                        {"cartao": cartao.get("name"), "motivo": classe.motivo}
                    )
            for anexo in cartao.get("attachments", []) or []:
                candidato = laudo_candidato(anexo.get("name"))
                if candidato:
                    relatorio.laudos_candidatos.append(
                        {
                            "cartao": cartao.get("name"),
                            "anexo": anexo.get("name"),
                            "laudo_candidato": candidato,
                        }
                    )
                # o ensaio TENTA buscar de verdade: contar sem verificar daria
                # um numero otimista que a carga real desmentiria
                if buscar_anexo is None:
                    relatorio.anexos_perdidos.append(
                        (anexo.get("name") or "?", anexo.get("url") or "sem URL")
                    )
                    continue
                try:
                    buscar_anexo(anexo.get("url") or "")
                    relatorio.anexos += 1
                except Exception as erro:
                    relatorio.anexos_perdidos.append(
                        (anexo.get("name") or "?", f"{type(erro).__name__}: {erro}")
                    )
            candidato_parecer = parecer_candidato(cartao.get("name"))
            if candidato_parecer:
                relatorio.conflitos_numeracao.append(
                    {
                        "cartao": cartao.get("name"),
                        "parecer_candidato": candidato_parecer,
                        "nup": nup,
                        "observacao": "vínculo NÃO automático — conferir com a planilha",
                    }
                )
            continue

        processo = _obter_processo(s, cartao, nup, ref)
        tipo = tipos.get(regra.get("tipo", "ADICIONAL_OCUPACIONAL")) or tipos[
            "ADICIONAL_OCUPACIONAL"
        ]
        etapa = etapas[regra["etapa"]]
        processo.tipo_processo_id = tipo.id
        processo.etapa_id = etapa.id
        processo.estado_tecnico = (
            "ARQUIVADO" if cartao.get("closed") else regra["estado"]
        )
        processo.origem_repositorio = bool(regra.get("repositorio"))

        # Backlog: separa cadastro historico de trabalho pendente. O pendente
        # sobe para a fila; o historico fica no repositorio, fora do kanban e
        # fora dos indicadores.
        if regra.get("separar_backlog"):
            classe = classificar_backlog(cartao)
            if classe.historico:
                relatorio.backlog_historico += 1
            else:
                relatorio.backlog_pendente += 1
                relatorio.motivos_pendente.append(
                    {"cartao": cartao.get("name"), "motivo": classe.motivo}
                )
                processo.origem_repositorio = False
                processo.etapa_id = etapas["A_FAZER"].id
                processo.estado_tecnico = "EM_TRIAGEM"
        processo.servidor_id = servidor.id if servidor else processo.servidor_id
        if not servidor and not nup:
            processo.observacoes = cartao.get("name")
        if regra.get("ano_referencia"):
            processo.ano_referencia = regra["ano_referencia"]
        if regra.get("situacao") == "CONCLUIDO":
            processo.situacao = "CONCLUIDO"
            processo.data_conclusao = _data(cartao.get("due")) or date.today()

        if cartao.get("due"):
            processo.prazo = _data(cartao["due"])
        if cartao.get("dueComplete") and cartao.get("due"):
            processo.data_conclusao = _data(cartao["due"])
            processo.situacao = "CONCLUIDO"
            processo.estado_tecnico = "CONCLUIDO"
            processo.etapa_id = etapas["CONCLUIDO"].id

        for campo in cartao.get("customFieldItems", []) or []:
            valor = (campo.get("value") or {}).get("text") or ""
            if textos.chave_busca(valor) == "done":
                processo.pronto_para_emissao = True

        _importar_checklists(s, processo, cartao)
        _importar_anexos(s, processo, cartao, usuario, relatorio, buscar_anexo)
        por_card[cartao["id"]] = processo
        relatorio.processos += 1

        candidato = parecer_candidato(cartao.get("name"))
        if candidato:
            relatorio.conflitos_numeracao.append(
                {
                    "cartao": cartao.get("name"),
                    "parecer_candidato": candidato,
                    "nup": nup,
                    "observacao": "vínculo NÃO automático — conferir com a planilha",
                }
            )

    if aplicar:
        relatorio.eventos = _importar_acoes(s, acoes, por_card, usuario)
    else:
        # quantas acoes teriam virado historico, se a carga fosse pra valer
        conhecidos = {
            c.get("id")
            for c in cartoes
            if _mapear_lista(listas.get(c.get("idList"))) is not None
        }
        relatorio.eventos = sum(
            1
            for a in acoes
            if ((a.get("data") or {}).get("card") or {}).get("id") in conhecidos
        )
    s.flush()
    return relatorio


def _obter_processo(s: Session, cartao: dict, nup: str | None, ref: str) -> Processo:
    processo = s.execute(
        select(Processo).where(
            Processo.origem_migracao == ORIGEM, Processo.origem_ref == ref
        )
    ).scalar_one_or_none()
    if processo is None and nup:
        processo = s.execute(select(Processo).where(Processo.nup == nup)).scalar_one_or_none()
    if processo is None:
        processo = Processo(
            nup=nup or _nup_sintetico(s, ref),
            tipo_processo_id=1,
            etapa_id=1,
            estado_tecnico="RECEBIDO",
            origem_migracao=ORIGEM,
            origem_ref=ref,
        )
        s.add(processo)
    processo.origem_migracao = ORIGEM
    processo.origem_ref = ref
    s.flush()
    return processo


def _nup_sintetico(s: Session, ref: str) -> str:
    """Cartao de repositorio sem NUP ainda precisa de chave unica.

    Gera um NUP com sequencial derivado do id do cartao e DV calculado, marcado
    no relatorio de orfaos para o Fabricio preencher o numero real.
    """
    from app.servicos.nup import nup_dv

    semente = int(re.sub(r"\D", "", ref) or "0") % 1_000_000
    for tentativa in range(1000):
        sequencial = (semente + tentativa) % 1_000_000
        base = f"23086{sequencial:06d}1900"
        candidato = f"23086.{sequencial:06d}/1900-{nup_dv(base)}"
        if s.execute(select(Processo).where(Processo.nup == candidato)).first() is None:
            return candidato
    raise RuntimeError("não foi possível gerar NUP sintético")


def _importar_anexos(
    s: Session,
    processo: Processo,
    cartao: dict,
    usuario: UsuarioAtual,
    relatorio: RelatorioTrello,
    buscar,
) -> None:
    """Baixa, deduplica por SHA-256 e guarda. O que nao vier fica no relatorio.

    `buscar` e injetavel para os testes e para o modo sem rede: recebendo None,
    nada e baixado e cada anexo entra na lista de perdidos com a URL, para
    conferencia manual antes que ela expire.
    """
    from app.servicos import anexos as servico_anexos

    for anexo in cartao.get("attachments", []) or []:
        url = anexo.get("url")
        nome = anexo.get("name") or (url or "anexo").rsplit("/", 1)[-1]
        ref = f"{cartao.get('id')}:{anexo.get('id') or nome}"

        candidato = laudo_candidato(nome)
        if candidato:
            relatorio.laudos_candidatos.append(
                {"cartao": cartao.get("name"), "anexo": nome, "laudo_candidato": candidato}
            )

        if buscar is None or not url:
            relatorio.anexos_perdidos.append((nome, url or "sem URL"))
            _rejeitar(
                s,
                relatorio,
                ref,
                "anexo não baixado (a URL do Trello expira) — baixar manualmente",
                {"nome": nome, "url": url, "cartao": cartao.get("id")},
            )
            continue

        try:
            conteudo = buscar(url)
        except Exception as erro:  # rede fora, URL expirada, 404...
            relatorio.anexos_perdidos.append((nome, f"{type(erro).__name__}: {erro}"))
            _rejeitar(
                s,
                relatorio,
                ref,
                f"falha ao baixar o anexo: {type(erro).__name__}",
                {"nome": nome, "url": url, "cartao": cartao.get("id")},
            )
            continue

        resultado = servico_anexos.guardar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            nome_original=nome,
            conteudo=conteudo,
            mime_type=_mime_por_extensao(nome),
            categoria=categoria_do_anexo(nome),
            usuario=usuario,
            processo_id=processo.id,
            numero_documento_sei=documento_sei_de_anexo(nome),
            assinado="assinado" in textos.chave_busca(nome),
            origem_migracao=ORIGEM,
            origem_ref=ref,
        )
        if resultado.duplicado:
            relatorio.anexos_duplicados += 1
        else:
            relatorio.anexos += 1


def _importar_checklists(s: Session, processo: Processo, cartao: dict) -> None:
    for ordem, bloco in enumerate(cartao.get("checklists", []) or [], start=1):
        nome = bloco.get("name") or f"Checklist {ordem}"
        existente = s.execute(
            select(Checklist).where(
                Checklist.processo_id == processo.id, Checklist.nome == nome
            )
        ).scalar_one_or_none()
        if existente is not None:
            continue
        checklist = Checklist(processo_id=processo.id, nome=nome, ordem=ordem)
        s.add(checklist)
        s.flush()
        for i, item in enumerate(bloco.get("checkItems", []) or [], start=1):
            s.add(
                ChecklistItem(
                    checklist_id=checklist.id,
                    descricao=item.get("name") or "",
                    concluido=item.get("state") == "complete",
                    ordem=i,
                )
            )


def _importar_acoes(
    s: Session, acoes: list[dict], por_card: dict[str, Processo], usuario: UsuarioAtual
) -> int:
    total = 0
    for acao in acoes:
        card_id = (acao.get("data", {}).get("card") or {}).get("id")
        processo = por_card.get(card_id)
        if processo is None:
            continue
        ref = acao.get("id")
        ja = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.origem == "MIGRACAO_TRELLO",
                HistoricoEvento.origem_ref == ref,
            )
        ).scalar_one_or_none()
        if ja is not None:
            continue
        quando = _momento(acao.get("date"))
        auditoria.registrar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            processo_id=processo.id,
            tipo_evento=acao.get("type") or "TRELLO",
            descricao=_descrever(acao),
            usuario=None,
            usuario_nome=(acao.get("memberCreator") or {}).get("fullName") or "Trello",
            ocorrido_em=quando,
            origem="MIGRACAO_TRELLO",
            origem_ref=ref,
        )
        total += 1
    _ = usuario
    return total


def _descrever(acao: dict) -> str:
    dados = acao.get("data", {})
    if acao.get("type") == "updateCard" and "listBefore" in dados:
        return (
            f"movido de {dados.get('listBefore', {}).get('name')} para "
            f"{dados.get('listAfter', {}).get('name')}"
        )
    if acao.get("type") == "commentCard":
        return dados.get("text", "")
    return json.dumps(dados, ensure_ascii=False)[:400]


def _data(valor: str | None) -> date | None:
    momento = _momento(valor)
    return momento.date() if momento else None


def _momento(valor: str | None) -> datetime | None:
    if not valor:
        return None
    try:
        return datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None


def _rejeitar(
    s: Session, relatorio: RelatorioTrello, ref: str, motivo: str, payload: dict
) -> None:
    ja = s.execute(
        select(MigracaoRejeitada).where(
            MigracaoRejeitada.origem == ORIGEM, MigracaoRejeitada.ref == ref
        )
    ).scalar_one_or_none()
    if ja is None:
        s.add(
            MigracaoRejeitada(
                origem=ORIGEM,
                ref=ref,
                motivo=motivo,
                payload=payload,
                expurgar_apos=date.today() + timedelta(days=90),
            )
        )
        s.flush()
    relatorio.rejeitados.append((ref, motivo))
