"""Geracao do parecer tecnico em .docx a partir do modelo docxtpl.

O parecer e um .docx de layout fixo com tabelas de celulas mescladas, cabecalho
MEC/UFVJM com brasao e rodape de duas colunas. So o conteudo varia - o
cabecalho NUNCA e recriado por codigo.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from docx import Document
from docx.shared import Mm
from docxtpl import DocxTemplate, InlineImage, RichText

from app.config import RAIZ, obter_config
from app.servicos import datas_br, textos

DIR_MODELOS = RAIZ / "app" / "templates"
MODELO_V1 = "modelo_parecer_v1.docx"
MODELO_V2 = "modelo_parecer_v2.docx"

CHAVES_RICHTEXT = (
    "posto_trabalho",
    "agente_nocivo",
    "fundamentacao_legal",
    "alteracao",
    "recomendacao_tecnica",
    "reavaliacao",
)


class DadosIncompletos(ValueError):
    """RN-04 - a emissao lista o que falta, nunca falha em silencio."""

    def __init__(self, faltantes: list[str]):
        self.faltantes = faltantes
        super().__init__("Faltam dados obrigatorios: " + "; ".join(faltantes))


class ExposicoesDivergentes(ValueError):
    pass


def sha256_arquivo(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(65536), b""):
            h.update(bloco)
    return h.hexdigest()


def sha256_texto(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def caminho_modelo(nome: str | None) -> Path:
    return DIR_MODELOS / (nome or MODELO_V1)


def _rich(valor: str | None) -> RichText | None:
    """Quebras de linha em celula: RichText com \\a e {{r chave }}."""
    if valor is None:
        return None
    texto = str(valor).replace("\r\n", "\n").rstrip()
    if texto == "":
        return None
    rt = RichText()
    for i, linha in enumerate(texto.split("\n")):
        if i:
            rt.add("\a")
        rt.add(linha)
    return rt


def rich_multilinha(valor: str | None) -> RichText | None:
    """`_rich` para os outros documentos do sistema.

    Existe porque a lista de presenca (fatia 3 de Certificados) precisa da mesma
    quebra de linha dentro de celula, e importar um `_privado` de outro modulo e
    combinar de nao mexer nele nunca mais.
    """
    return _rich(valor)


@dataclass(frozen=True)
class ImagemEmLinha:
    """Uma imagem a embutir no documento, declarada sem depender do docxtpl.

    O `InlineImage` do docxtpl exige o objeto `DocxTemplate`, que so existe
    dentro de `renderizar_modelo`. Se quem monta o contexto precisasse dele, a
    montagem deixaria de ser uma funcao pura sobre dados congelados — e a
    rubrica do instrutor, que e o unico caso hoje (fatia 4 de Certificados),
    passa exatamente por ali. Aqui o contexto declara *qual arquivo*, e a
    conversao acontece no unico lugar que abre o modelo.

    Arquivo ausente vira string vazia, e nao erro: rubrica que sumiu do disco
    nao pode impedir a segunda via de um certificado que ja circulou.
    """

    caminho: Path
    largura_mm: float | None = None


def _resolver_imagens(tpl: DocxTemplate, contexto: dict) -> dict:
    resolvido = {}
    for chave, valor in contexto.items():
        if isinstance(valor, ImagemEmLinha):
            if not valor.caminho.is_file():
                resolvido[chave] = ""
                continue
            largura = Mm(valor.largura_mm) if valor.largura_mm else None
            resolvido[chave] = InlineImage(tpl, str(valor.caminho), width=largura)
        else:
            resolvido[chave] = valor
    return resolvido


def primeira_maiuscula(texto: str | None) -> str:
    """Equivalente ao switch \\* FirstCap da mala direta."""
    if not texto:
        return ""
    return texto[0].upper() + texto[1:]


# ---------------------------------------------------------------------
# Contexto
# ---------------------------------------------------------------------
@dataclass
class ContextoParecer:
    """Tudo o que o modelo precisa. Montado a partir do banco ou dos testes."""

    numero_parecer: int
    ano: int
    data_emissao: date
    cidade: str
    sigla_unidade_emissora: str
    nome_extenso_emissor: str
    endereco_emissor: str
    telefone_emissor: str
    laudo_de: str
    unidade: str
    postos: list[str]
    uorg_bruto: str
    tipo_laudo: str
    numero_processo_sei: str
    nome_servidor: str
    matricula: str
    cargo: str
    funcao: str
    laudo_siape: str
    agentes_nocivos: list[str]
    tipo_risco: str
    percentual_aplicavel: str
    portaria_localizacao: str
    fundamentacao_legal: str
    alteracao: str | None
    recomendacao_tecnica: str
    reavaliacao: str | None
    pro_reitor: str
    pro_reitor_cargo: str
    tratamento_destinatario: str
    assinante_nome: str
    assinante_matricula: str
    assinante_titulo: str
    data_extenso_capitalizado: bool = False
    avisos: list[str] = field(default_factory=list)

    # ---- congelamento (RN-15) ---------------------------------------
    CAMPOS_CONGELADOS = (
        "numero_parecer", "ano", "data_emissao", "cidade", "sigla_unidade_emissora",
        "nome_extenso_emissor", "endereco_emissor", "telefone_emissor", "laudo_de",
        "unidade", "postos", "uorg_bruto", "tipo_laudo", "numero_processo_sei",
        "nome_servidor", "matricula", "cargo", "funcao", "laudo_siape",
        "agentes_nocivos", "tipo_risco", "percentual_aplicavel",
        "portaria_localizacao", "fundamentacao_legal", "alteracao",
        "recomendacao_tecnica", "reavaliacao", "pro_reitor", "pro_reitor_cargo",
        "tratamento_destinatario", "assinante_nome", "assinante_matricula",
        "assinante_titulo", "data_extenso_capitalizado",
    )

    def congelar(self) -> dict:
        """Tudo o que o documento renderiza, pronto para guardar no parecer."""
        dados = {campo: getattr(self, campo) for campo in self.CAMPOS_CONGELADOS}
        dados["data_emissao"] = self.data_emissao.isoformat()
        return dados

    @classmethod
    def descongelar(cls, dados: dict) -> "ContextoParecer":
        from datetime import date as _date

        valores = dict(dados)
        valores["data_emissao"] = _date.fromisoformat(valores["data_emissao"])
        return cls(**{k: valores[k] for k in cls.CAMPOS_CONGELADOS})

    def obrigatorios_faltantes(self) -> list[str]:
        exigidos = {
            "nome_servidor": "nome do servidor",
            "matricula": "matricula SIAPE",
            "unidade": "unidade / UORG",
            "numero_processo_sei": "numero do processo (NUP)",
            "laudo_siape": "laudo tecnico",
            "percentual_aplicavel": "percentual aplicavel",
            "portaria_localizacao": "portaria de localizacao",
            "recomendacao_tecnica": "recomendacao",
            "assinante_nome": "signatario",
            "pro_reitor": "autoridade destinataria",
            "tipo_risco": "tipo de risco",
            "fundamentacao_legal": "fundamentacao legal",
        }
        faltantes = [rotulo for campo, rotulo in exigidos.items() if not getattr(self, campo)]
        if not self.agentes_nocivos:
            faltantes.append("agente nocivo")
        if not self.postos:
            faltantes.append("posto de trabalho")
        return faltantes

    def como_dicionario(self) -> dict:
        data_txt = (
            datas_br.por_extenso_capitalizado(self.data_emissao)
            if self.data_extenso_capitalizado
            else datas_br.por_extenso(self.data_emissao)
        )
        return {
            "numero_parecer": str(self.numero_parecer),
            "ano": str(self.ano),
            "data_extenso": data_txt,
            "cidade": self.cidade,
            "sigla_unidade_emissora": self.sigla_unidade_emissora,
            "nome_extenso_emissor": self.nome_extenso_emissor,
            "endereco_emissor": self.endereco_emissor,
            "telefone_emissor": self.telefone_emissor,
            "laudo_de": self.laudo_de,
            "unidade": primeira_maiuscula(self.unidade),
            "posto_trabalho": _rich("\n".join(self.postos)),
            "uorg_formatado": textos.uorg_formatado(self.uorg_bruto),
            "tipo_laudo": self.tipo_laudo,
            "numero_processo_sei": self.numero_processo_sei,
            "nome_servidor": self.nome_servidor,
            "matricula": self.matricula,
            "cargo": self.cargo,
            "funcao": self.funcao or "",
            "laudo_siape": self.laudo_siape,
            "agente_nocivo": _rich("\n".join(self.agentes_nocivos)),
            "tipo_risco": self.tipo_risco,
            "percentual_aplicavel": self.percentual_aplicavel,
            "portaria_localizacao": self.portaria_localizacao,
            "fundamentacao_legal": _rich(self.fundamentacao_legal),
            "alteracao": _rich(self.alteracao),
            "recomendacao_tecnica": _rich(self.recomendacao_tecnica),
            "reavaliacao": _rich(self.reavaliacao),
            "pro_reitor": self.pro_reitor,
            "pro_reitor_cargo": self.pro_reitor_cargo,
            "tratamento_destinatario": self.tratamento_destinatario,
            "assinante_nome": self.assinante_nome,
            "assinante_matricula": self.assinante_matricula,
            "assinante_titulo": self.assinante_titulo,
            # artefato de mala direta que sobrou no rodape: sempre vazio
            "data_solicitacao_sest_rodape": "",
        }


# ---------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------
def renderizar_modelo(
    modelo: str | None,
    contexto: dict,
    destino: Path,
    *,
    dica: str = "",
    pasta: Path | None = None,
) -> dict:
    """Rende um .docx de `app/templates/` com docxtpl e devolve as impressoes digitais.

    E o unico lugar do sistema que abre um modelo e grava um documento. A lista
    de presenca (fatia 3 de Certificados) e o certificado (fatia 4) passam por
    aqui em vez de trazer cada um o seu render: dois mecanismos de documento
    seriam dois lugares para o hash de integridade divergir.

    `pasta` existe porque o modelo do certificado mora em
    `app/templates/certificados/`, e nao ao lado do modelo do parecer: o setor
    troca o layout do certificado com frequencia e a subpasta e o que impede a
    tela de modelos de enxergar (e oferecer) o `.docx` do parecer. So o NOME do
    arquivo e usado — `Path(...).name` na origem —, entao a pasta nunca vem de
    fora.
    """
    caminho = (pasta / Path(modelo).name) if pasta is not None else caminho_modelo(modelo)
    if not caminho.exists():
        raise FileNotFoundError(
            f"modelo {caminho.name} nao encontrado em {caminho.parent}."
            + (f" {dica}" if dica else "")
        )

    tpl = DocxTemplate(str(caminho))
    tpl.render(_resolver_imagens(tpl, contexto))
    destino.parent.mkdir(parents=True, exist_ok=True)
    tpl.save(str(destino))

    return {
        "arquivo": destino,
        "modelo_arquivo": caminho.name,
        "modelo_sha256": sha256_arquivo(caminho),
        "hash_conteudo": sha256_texto(extrair_texto(destino)),
    }


def renderizar(
    contexto: ContextoParecer,
    destino: Path,
    modelo: str | None = None,
    validar: bool = True,
) -> dict:
    if validar:
        faltantes = contexto.obrigatorios_faltantes()
        if faltantes:
            raise DadosIncompletos(faltantes)

    return renderizar_modelo(
        modelo,
        contexto.como_dicionario(),
        destino,
        dica="Rode ferramentas/converter_modelo_maladireta.py.",
    )


# ---------------------------------------------------------------------
# Extracao de texto (CA-01)
# ---------------------------------------------------------------------
def _texto_de_celula(celula) -> str:
    return "\n".join(p.text for p in celula.paragraphs)


def _texto_de_container(container) -> list[str]:
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    elemento = getattr(container, "element", None)
    if elemento is None:
        elemento = getattr(container, "_element", container)
    elemento = getattr(elemento, "body", elemento)
    linhas: list[str] = []
    for filho in elemento.iterchildren():
        if filho.tag == qn("w:p"):
            linhas.append(Paragraph(filho, container).text)
        elif filho.tag == qn("w:tbl"):
            tabela = Table(filho, container)
            for linha in tabela.rows:
                vistas: set[int] = set()
                for celula in linha.cells:
                    if id(celula._tc) in vistas:
                        continue
                    vistas.add(id(celula._tc))
                    linhas.append(_texto_de_celula(celula))
    return linhas


def extrair_texto(caminho: Path) -> str:
    """Corpo (paragrafos + celulas) + header + footer, nesta ordem."""
    doc = Document(str(caminho))
    linhas = _texto_de_container(doc)
    for secao in doc.sections:
        for parte in (secao.header, secao.footer):
            linhas.extend(_texto_de_container(parte))
    bruto = "\n".join(linhas)
    return unicodedata.normalize("NFC", bruto)


def texto_normalizado(caminho: Path) -> str:
    return textos.normalizar_para_ouro(extrair_texto(caminho))


# ---------------------------------------------------------------------
# Nomes de arquivo
# ---------------------------------------------------------------------
def caminho_saida(
    numero: int, ano: int, sigla: str, servidor: str | None, extensao: str = "docx"
) -> Path:
    cfg = obter_config()
    pasta = cfg.caminho(cfg.dir_documentos) / str(ano)
    nome = textos.nome_arquivo_parecer(numero, ano, sigla, servidor)
    return pasta / f"{nome}.{extensao}"
