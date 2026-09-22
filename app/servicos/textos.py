"""Normalizacoes textuais do dominio.

Regra transversal: nomes de posto, unidade, cargo e portaria sao gravados byte
a byte como aparecem no documento de origem. O sistema NUNCA normaliza caixa
nesses campos. As funcoes abaixo sao de *apresentacao* e de *comparacao*, nunca
de gravacao.
"""

from __future__ import annotations

import re
import unicodedata

# ---------------------------------------------------------------------
# UORG
# ---------------------------------------------------------------------
_RE_UORG = re.compile(r"^\s*(?P<codigo>\d+)\s*-\s*(?P<nome>.+?)\s*$")


def uorg_formatado(bruto: str | None) -> str:
    """'250 - FACULDADE DE MEDICINA DE DIAMANTINA'
        -> '250 - Faculdade De Medicina De Diamantina'

    Title case ingenuo, com o 'De' capitalizado. O assinado imprime assim -
    reproduzir exatamente, nao "melhorar" (CA-03).
    """
    if not bruto:
        return ""
    return str(bruto).title()


def codigo_uorg(bruto: str | None) -> str | None:
    """Extrai o codigo do prefixo '^(\\d+)\\s*-'."""
    if not bruto:
        return None
    m = _RE_UORG.match(str(bruto))
    return m.group("codigo") if m else None


def nome_uorg(bruto: str | None) -> str | None:
    if not bruto:
        return None
    m = _RE_UORG.match(str(bruto))
    return m.group("nome") if m else str(bruto).strip()


# ---------------------------------------------------------------------
# Aspas tipograficas
# ---------------------------------------------------------------------
def aspas_curvas(texto: str | None) -> str:
    """Converte aspas retas em curvas, alternando abre/fecha.

    Aplicado uma vez, na entrada do catalogo - nunca a cada render.
    """
    if not texto:
        return ""
    saida: list[str] = []
    abrindo = True
    for ch in str(texto):
        if ch == '"':
            saida.append("“" if abrindo else "”")
            abrindo = not abrindo
        else:
            saida.append(ch)
    return "".join(saida)


# ---------------------------------------------------------------------
# Comparacao / busca
# ---------------------------------------------------------------------
def sem_acento(texto: str | None) -> str:
    if not texto:
        return ""
    return "".join(
        c
        for c in unicodedata.normalize("NFD", str(texto))
        if unicodedata.category(c) != "Mn"
    )


def chave_busca(texto: str | None) -> str:
    """Minuscula, sem acento, espacos colapsados - para casar nomes."""
    return re.sub(r"\s+", " ", sem_acento(texto).lower()).strip()


def parece_cpf(bruto: str | None) -> bool:
    """Onze digitos seguidos so podem ser uma coisa nesta casa — e ela nao existe.

    O SIAPE tem sete (`ck_siape`), o protocolo de EPI tem prefixo, o NUP tem
    pontuacao e o numero de laudo tambem. Sobra o CPF, que o sistema NAO
    armazena em campo nenhum (RN-21; decisao 1 do desenho de EPI).

    Isto e deteccao, nao recusa: quem chama escreve a saida com as chaves da
    SUA tela. Mas a deteccao e uma so, aqui, porque duas copias divergem na
    primeira correcao — e a metade que ficasse para tras responderia "nada
    encontrado" a quem digitou CPF, deixando a pessoa concluir que o registro
    nao existe quando o que nao existe e a busca.
    """
    digitos = "".join(c for c in (bruto or "") if c.isdigit())
    return len(digitos) == 11


def normalizar_fluxo(texto: str) -> str:
    """Forma canonica de comparacao do CA-01.

    O PDF assinado quebra as linhas onde o texto envolve na pagina; o .docx tem
    paragrafos logicos. Comparar linha a linha compararia diagramacao, nao
    conteudo - por isso TODO espaco em branco (inclusive a quebra) e colapsado
    num unico espaco. A estrutura (ex.: a celula de posto ter exatamente duas
    linhas) e verificada em asseracoes proprias, nao aqui.
    """
    return re.sub(r"\s+", " ", normalizar_para_ouro(texto)).strip()


def normalizar_para_ouro(texto: str) -> str:
    """Normalizacao do CA-01: NFC + colapso de espacos + strip por linha.

    Nao compara bytes do .docx - compara texto normalizado.
    """
    texto = unicodedata.normalize("NFC", texto)
    texto = texto.replace(" ", " ").replace("\a", "\n").replace("\r\n", "\n")
    linhas = [re.sub(r"[ \t]+", " ", linha).strip() for linha in texto.split("\n")]
    return "\n".join(linha for linha in linhas if linha)


# ---------------------------------------------------------------------
# Nome de arquivo
# ---------------------------------------------------------------------
def slug_ascii(texto: str | None) -> str:
    """'Marco Antonio' -> 'Marco_Antonio'; 'Antônio' -> 'Antonio'.

    So o NOME DO ARQUIVO e ASCII; o conteudo do documento mantem acento.
    """
    base = sem_acento(texto or "")
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_")
    return re.sub(r"_+", "_", base)


def nome_arquivo_parecer(numero: int, ano: int, sigla: str, servidor: str | None) -> str:
    """Parecer_Tecnico_08-2026_SEST_Talita - numero com padding de 2 no arquivo,
    sem padding no documento (n 8/2026)."""
    partes = ["Parecer_Tecnico", f"{numero:02d}-{ano}", slug_ascii(sigla.split("/")[0])]
    if servidor:
        partes.append(slug_ascii(servidor))
    return "_".join(p for p in partes if p)


# ---------------------------------------------------------------------
# RN-21 - dado de saude e proibido em campo de texto livre
#
# A lista abaixo e a regra. A unica flexao permitida esta em
# _DISPENSAS_POR_CONTEXTO, logo adiante, e vale por contexto declarado - nunca
# por frase.
# ---------------------------------------------------------------------
TERMOS_PROIBIDOS: tuple[str, ...] = (
    "cid-10",
    "cid 10",
    "diagnostico",
    "diagnóstico",
    "atestado medico",
    "atestado médico",
    "gestante",
    "gestacao",
    "gestação",
    "gravidez",
    "gravida",
    "grávida",
    "lactante",
    "lactacao",
    "lactação",
    "doenca",
    "doença",
    "enfermidade",
    "cpf",
)


# Contextos de aplicacao da RN-21.
#
# A regra nao e uniforme porque os campos nao sao. No parecer de adicional
# ocupacional nada de saude tem o que fazer: a insalubridade se prova pelo
# agente, pela concentracao e pelo ambiente - nunca pelo corpo do servidor. Ali
# a lista inteira vale, e continua valendo sem um milimetro de folga.
#
# Acidente em servico e outra coisa. A Lei 8.112/90, art. 212, e a decisao 4 do
# projeto definem tres especies, e uma delas se CHAMA "doenca relacionada ao
# trabalho". A palavra ali nao e diagnostico de ninguem: e o nome juridico da
# especie que se esta registrando, do mesmo naipe de "acidente de trajeto". Com
# a lista aplicada em bloco, o modulo de Acidentes nao conseguiria registrar a
# especie que a lei manda registrar.
#
# A dispensa e do CONTEXTO, nao de uma frase. Uma lista de frases liberadas
# ("doenca relacionada ao trabalho") quebra na primeira variacao de escrita e
# ainda deixa passar o texto clinico que venha grudado na frase liberada. O
# contexto e escolhido em cada ponto de chamada, aparece na revisao de codigo e
# se testa - e o default e sempre o mais restritivo, entao esquecer o parametro
# erra para o lado seguro.
CONTEXTO_PADRAO = "padrao"

# Vale so nos campos narrativos de `acidente_ocorrencia` e
# `acidente_investigacao`, onde a especie precisa ser nomeada. NAO vale em
# `acidente_decisao_pericial.observacao`: ali a tentacao e colar o laudo, que
# tem diagnostico, e o contexto continua sendo o CONTEXTO_PADRAO.
CONTEXTO_NEXO_OCUPACIONAL = "nexo_ocupacional"

# So a palavra que nomeia a especie legal. "enfermidade" segue barrada em toda
# parte: nao e nome de especie nenhuma, e quem precisa dela esta descrevendo
# quadro clinico. CID, diagnostico, atestado medico, gestacao e CPF seguem
# barrados em TODOS os contextos - nenhum deles nomeia nada na Lei 8.112.
#
# Risco residual assumido: com a palavra dispensada, "doenca de Chagas" passa no
# contexto do nexo. O filtro nunca foi o unico controle - o campo nasce
# restrito, com acesso auditado - e apertar mais so seria possivel voltando a
# casar frase, que e justamente o que nao funciona.
_DISPENSAS_POR_CONTEXTO: dict[str, frozenset[str]] = {
    CONTEXTO_PADRAO: frozenset(),
    CONTEXTO_NEXO_OCUPACIONAL: frozenset({"doenca", "doença"}),
}


class TextoProibido(ValueError):
    """Termo de saude/dado sensivel encontrado em campo de texto livre."""


def _dispensas_do_contexto(contexto: str) -> frozenset[str]:
    """Chaves de busca dispensadas no contexto. Contexto desconhecido e erro de
    programacao, e falha alto: um typo nao pode virar filtro silenciosamente
    diferente do que o autor quis."""
    if contexto not in _DISPENSAS_POR_CONTEXTO:
        conhecidos = ", ".join(sorted(_DISPENSAS_POR_CONTEXTO))
        raise ValueError(
            f"contexto de RN-21 desconhecido: {contexto!r}. Conhecidos: {conhecidos}."
        )
    return frozenset(chave_busca(t) for t in _DISPENSAS_POR_CONTEXTO[contexto])


def termos_proibidos_em(texto: str | None, contexto: str = CONTEXTO_PADRAO) -> list[str]:
    dispensadas = _dispensas_do_contexto(contexto)
    if not texto:
        return []
    alvo = chave_busca(texto)
    achados = []
    for termo in TERMOS_PROIBIDOS:
        chave = chave_busca(termo)
        if chave in dispensadas:
            continue
        if re.search(rf"\b{re.escape(chave)}\b", alvo):
            achados.append(termo)
    return sorted(set(achados))


def exigir_texto_limpo(
    texto: str | None, campo: str = "texto", contexto: str = CONTEXTO_PADRAO
) -> str | None:
    """Recusa o texto com dado de saude dentro. `campo` e o ROTULO DA TELA.

    Quem le esta frase e engenheiro de seguranca do trabalho, e a frase falava
    como banco de dados com ele: `'comentario'`, `'observacoes'`,
    `'justificativa_art9'` sao nomes de coluna, entre aspas, num sistema cujo
    resto do texto e portugues. O nome de coluna nao ajuda a achar o campo — a
    tela nao chama nenhum deles assim — e ainda expoe o esquema. Os pontos de
    chamada do modulo de EPI ja mandavam rotulo ("observacao da entrega",
    "parecer da analise"); os tres do Processos SEI eram os que faltavam.

    A recusa em si e deliberada e boa: comentario e observacao viram linha de
    auditoria, e auditoria nao guarda dado de saude sem base legal (RN-21; LGPD
    art. 11). O que faltava era a terceira parte da regra da casa — dizer a
    SAIDA. Ela existe, e e curta: descrever o agente e o ambiente resolve o
    trabalho tecnico inteiro sem nomear a condicao de ninguem.
    """
    achados = termos_proibidos_em(texto, contexto)
    if achados:
        raise TextoProibido(
            f"O campo {campo} contém termo proibido ({', '.join(achados)}). "
            "Estado de saúde, gestação, CID e diagnóstico não podem ser "
            "registrados (RN-21; LGPD art. 11). Descreva o agente nocivo e o "
            "ambiente de trabalho, não a pessoa — é isso que fundamenta o "
            "adicional, e o texto sem o termo vale igual."
        )
    return texto


# ---------------------------------------------------------------------
# Identificador opaco por sessao (RN-19)
# ---------------------------------------------------------------------
def identificador_opaco(servidor_id: int, semente: str) -> str:
    """SRV-7f3a - nunca mascara parcial da matricula."""
    import hashlib

    h = hashlib.sha256(f"{semente}:{servidor_id}".encode()).hexdigest()
    return f"SRV-{h[:4]}"
