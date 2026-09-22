"""Certificado: o de-para entre o marcador do .docx e o dado do sistema, e o
contexto congelado de que a segunda via e reimpressa.

A divisao entre dado e codigo e o ponto central do desenho (SS3) e vale ser
explicita:

- **Codigo** e `CAMPOS_CERTIFICADO`, aqui. Cada campo precisa de alguem que
  saiba onde buscar o dado, e isso e funcao, nao linha de tabela. Mesma
  natureza do `MAPA_CAMPOS` de `ferramentas/converter_modelo_maladireta.py`,
  que tambem recusa marcador desconhecido em vez de chutar.
- **Dado** e a tabela `certificado_modelo_tag`. Qual marcador do .docx recebe
  qual campo e editavel na tela, sem deploy — e por isso o setor pode
  redesenhar o certificado no Word sem pedir alteracao de programa.

**A funcao `obter` le do `ContextoCertificado`, e de mais nada.** Nao recebe
sessao, nao consulta o banco e nao conhece `Turma` nem `Participante`. E o que
faz a RN-15 valer: reimprimir chama exatamente o mesmo codigo sobre o contexto
descongelado, entao nao existe caminho por onde o catalogo de hoje possa entrar
num documento de ontem. Uma funcao que recebesse a sessao teria esse caminho, e
ele seria descoberto por um certificado errado, nao por um teste.

`ContextoCertificado` espelha `documento.ContextoParecer`: mesmos `congelar`,
`descongelar` e `como_dicionario`. Nao ha um segundo mecanismo de congelamento
no sistema — ha um so, aplicado a dois documentos.

O que este modulo NAO faz: emitir, anular e validar. Isso e regra de negocio e
mora em `app/servicos/emissao_certificado.py`, na mesma divisao que
`documento.py` (contexto e render) e `parecer.py` (regras) ja tem.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.config import RAIZ
from app.modelos.treinamento import (
    ALFABETO_IDENTIFICADOR,
    PADRAO_CHAVE_VALIDACAO,
    PREFIXO_CHAVE,
    TAMANHO_SORTEIO_CHAVE,
)
from app.servicos import datas_br, documento
from app.servicos.presenca import numero as numero_br

DIR_MODELOS_CERTIFICADO = RAIZ / "app" / "templates" / "certificados"

# a rubrica sai impressa; 35 mm e a largura tipica de uma assinatura digitalizada
# num certificado em paisagem. Fixa aqui, e nao no .docx, porque `InlineImage`
# precisa da medida na hora de embutir.
LARGURA_RUBRICA_MM = 35.0

SEM_VENCIMENTO = "não expira"

_ALFABETO_CHAVE = ALFABETO_IDENTIFICADOR
_RE_CHAVE = re.compile(PADRAO_CHAVE_VALIDACAO)


class CampoDesconhecido(ValueError):
    """Nunca chutar a chave: campo fora do vocabulario e erro, nao aviso."""

    def __init__(self, codigo: str):
        self.codigo = codigo
        super().__init__(f"Campo de certificado desconhecido: {codigo}")


# =====================================================================
# Chave de validacao (SS5 do desenho)
# =====================================================================
def digito_verificador(significativos: str) -> str:
    """Um caractere do alfabeto, mod 30 sobre os 14 caracteres significativos.

    Os significativos sao o ano (4 digitos) mais os 10 sorteados. O peso pela
    posicao nao e enfeite: sem ele, `K7QMX-3FTB9` e `7KQMX-3FTB9` teriam o mesmo
    digito, e transposicao de dois caracteres e justamente o erro que quem copia
    do papel comete. `ord` entra no lugar do indice no alfabeto porque o ano tem
    `0` e `1`, que o alfabeto descarta — misturar as duas escalas produziria
    colisao entre o digito `2` do ano e a primeira letra do alfabeto.
    """
    soma = sum((posicao + 1) * ord(c) for posicao, c in enumerate(significativos))
    return _ALFABETO_CHAVE[soma % len(_ALFABETO_CHAVE)]


def montar_chave(ano: int, sorteio: str) -> str:
    """`CSSO-2026-K7QMX-3FTB9-H` a partir do ano e dos 10 caracteres sorteados."""
    if len(sorteio) != TAMANHO_SORTEIO_CHAVE:
        raise ValueError(
            f"o sorteio da chave tem {TAMANHO_SORTEIO_CHAVE} caracteres, "
            f"nao {len(sorteio)}"
        )
    significativos = f"{ano:04d}{sorteio}"
    return (
        f"{PREFIXO_CHAVE}-{ano:04d}-{sorteio[:5]}-{sorteio[5:]}-"
        f"{digito_verificador(significativos)}"
    )


def gerar_chave(ano: int) -> str:
    """Dez caracteres de `secrets` — ~49 bits, cerca de 5,9 x 10^14 combinacoes."""
    sorteio = "".join(
        secrets.choice(_ALFABETO_CHAVE) for _ in range(TAMANHO_SORTEIO_CHAVE)
    )
    return montar_chave(ano, sorteio)


def normalizar_chave(bruta: str | None) -> str:
    """Caixa alta e sem espaco. Nao 'conserta' caractere ambiguo.

    Trocar `O` por `0` na entrada pareceria gentileza e seria erro: o alfabeto
    ja exclui os dois pares confusos, entao um `O` digitado nao e ambiguidade a
    resolver — e digitacao errada, e o proprio digito verificador vai dize-lo.
    """
    return re.sub(r"\s+", "", (bruta or "")).upper()


def chave_valida(chave: str | None) -> bool:
    """Formato E digito verificador, sem tocar no banco.

    E o que protege o limite de tentativas da pagina publica (fatia 5) de ser
    gasto com erro de digitacao: 29 de cada 30 chaves erradas morrem aqui.
    """
    limpa = normalizar_chave(chave)
    if _RE_CHAVE.fullmatch(limpa) is None:
        return False
    _prefixo, ano, bloco1, bloco2, digito = limpa.split("-")
    return digito_verificador(f"{ano}{bloco1}{bloco2}") == digito


# =====================================================================
# O contexto congelado (RN-15 — SS4 do desenho)
# =====================================================================
def _periodo_extenso(inicio: date, fim: date) -> str:
    """'de 03 a 05 de março de 2026' — e so a data quando a turma dura um dia."""
    if inicio == fim:
        return datas_br.por_extenso(inicio)
    if (inicio.year, inicio.month) == (fim.year, fim.month):
        mes = datas_br.MESES_ACENTUADOS[inicio.month - 1]
        return f"de {inicio.day:02d} a {fim.day:02d} de {mes} de {inicio.year}"
    return f"de {datas_br.por_extenso(inicio)} a {datas_br.por_extenso(fim)}"


def _linha_do_instrutor(instrutor: dict) -> str:
    partes = [instrutor.get("nome") or ""]
    if instrutor.get("titulo"):
        partes.append(instrutor["titulo"])
    registro = instrutor.get("registro") or ""
    if registro:
        partes.append(registro)
    return " — ".join(p for p in partes if p)


@dataclass
class ContextoCertificado:
    """Tudo o que o certificado renderiza, e nada mais.

    Cada campo aqui e congelado na emissao. O que ficou **fora** ficou de
    proposito: `situacao` (EMITIDO/ANULADO) e "esta vencido hoje?" sao estado,
    calculados na hora a partir da linha. Congelar estado e o erro simetrico do
    de nao congelar conteudo — o certificado apareceria como valido para sempre.
    """

    # --- participante ---
    participante_nome: str
    participante_identificador: str
    participante_vinculo: str
    participante_organizacao: str
    participante_siape: str
    participante_lotacao: str
    # --- treinamento ---
    treinamento_nome: str
    treinamento_norma: str
    treinamento_conteudo: str
    validade_meses: int
    # --- turma ---
    turma_codigo: str
    turma_data_inicio: date
    turma_data_fim: date
    carga_horaria: Decimal
    turma_local: str
    turma_unidade_promotora: str
    turma_campus: str
    data_base_vencimento: date
    # --- resultado ---
    nota_final: Decimal | None
    frequencia_percentual: Decimal | None
    nota_minima: Decimal | None
    frequencia_minima: Decimal | None
    # --- instrutores que assinam ---
    # cada um: {nome, titulo, conselho, registro, rubrica_sha256}. O SHA-256 da
    # rubrica entra no lugar do `anexo_id` de proposito (SS4): trocar o arquivo
    # da rubrica por fora passa a ser DETECTAVEL, e um id continuaria apontando
    # para o registro certo com o conteudo errado.
    instrutores: list[dict]
    # --- documento ---
    numero: int
    ano: int
    data_emissao: date
    chave_validacao: str
    data_vencimento: date | None
    url_validacao: str
    # --- emissor ---
    setor_sigla: str
    setor_nome: str
    setor_endereco: str
    cidade: str
    # --- renderizacao ---
    modelo_id: int | None
    modelo_arquivo: str
    modelo_sha256: str | None
    modelo_versao: int
    # {marcador: campo} — o mapa INTEIRO. Sem ele, reimprimir com o dicionario
    # de hoje mudaria qual dado vai em qual lugar do papel.
    mapa_tags: dict[str, str]
    # os marcadores que a versao do modelo declarava obrigatorios
    tags_obrigatorias: tuple[str, ...] = ()
    # nao congelados: sao avisos da emissao, uteis na tela e no relatorio do lote
    avisos: list[str] = field(default_factory=list)

    CAMPOS_CONGELADOS = (
        "participante_nome", "participante_identificador", "participante_vinculo",
        "participante_organizacao", "participante_siape", "participante_lotacao",
        "treinamento_nome", "treinamento_norma", "treinamento_conteudo",
        "validade_meses", "turma_codigo", "turma_data_inicio", "turma_data_fim",
        "carga_horaria", "turma_local", "turma_unidade_promotora", "turma_campus",
        "data_base_vencimento", "nota_final", "frequencia_percentual",
        "nota_minima", "frequencia_minima", "instrutores", "numero", "ano",
        "data_emissao", "chave_validacao", "data_vencimento", "url_validacao",
        "setor_sigla", "setor_nome", "setor_endereco", "cidade", "modelo_id",
        "modelo_arquivo", "modelo_sha256", "modelo_versao", "mapa_tags",
        "tags_obrigatorias",
    )

    _DATAS = (
        "turma_data_inicio", "turma_data_fim", "data_base_vencimento",
        "data_emissao", "data_vencimento",
    )
    _DECIMAIS = (
        "carga_horaria", "nota_final", "frequencia_percentual", "nota_minima",
        "frequencia_minima",
    )

    # ---- congelamento (RN-15) ---------------------------------------
    def congelar(self) -> dict:
        """Tudo o que o documento renderiza, pronto para guardar no certificado.

        Data vira ISO e Decimal vira texto de proposito, em vez de contar com o
        `default=str` do `JSONTexto`: o que sai de `descongelar` precisa ter o
        MESMO tipo do que entrou, senao `numero_br(Decimal('8.0'))` e
        `numero_br('8.0')` divergem e a segunda via sai com outra carga horaria.
        """
        dados = {campo: getattr(self, campo) for campo in self.CAMPOS_CONGELADOS}
        for campo in self._DATAS:
            valor = dados[campo]
            dados[campo] = valor.isoformat() if valor is not None else None
        for campo in self._DECIMAIS:
            valor = dados[campo]
            dados[campo] = str(valor) if valor is not None else None
        dados["tags_obrigatorias"] = list(self.tags_obrigatorias)
        return dados

    @classmethod
    def descongelar(cls, dados: dict) -> "ContextoCertificado":
        valores = {campo: dados.get(campo) for campo in cls.CAMPOS_CONGELADOS}
        for campo in cls._DATAS:
            valor = valores[campo]
            valores[campo] = date.fromisoformat(valor) if valor else None
        for campo in cls._DECIMAIS:
            valor = valores[campo]
            valores[campo] = Decimal(str(valor)) if valor is not None else None
        valores["tags_obrigatorias"] = tuple(valores["tags_obrigatorias"] or ())
        valores["mapa_tags"] = dict(valores["mapa_tags"] or {})
        valores["instrutores"] = list(valores["instrutores"] or [])
        return cls(**valores)

    # ---- leitura ----------------------------------------------------
    @property
    def rotulo(self) -> str:
        return f"{self.numero}/{self.ano}"

    @property
    def assinante(self) -> dict:
        """O primeiro instrutor que assina.

        `assinante_*` e singular no vocabulario porque o layout classico tem uma
        linha de assinatura; quando a turma tem varios, `turma_instrutores` traz
        todos, um por linha. Um layout de duas assinaturas se resolve no mapa de
        tags, nao no codigo (SS11, item 3).
        """
        return self.instrutores[0] if self.instrutores else {}

    def como_dicionario(self) -> dict:
        """`{marcador: valor}` — a montagem do contexto do docxtpl.

        O mapa vem do CONGELADO (`self.mapa_tags`), nunca do modelo de hoje. Nao
        ha parametro para passar outro mapa: um parametro assim seria a unica
        porta por onde a reimpressao poderia trocar qual dado vai em qual lugar
        do documento, e uma porta dessas so e descoberta depois de aberta.
        """
        return {
            marcador: CAMPOS_CERTIFICADO[exigir_campo(campo)].obter(self)
            for marcador, campo in self.mapa_tags.items()
        }

    def obrigatorios_faltantes(self) -> list[str]:
        """Os marcadores `obrigatorio` que sairiam vazios no papel.

        Bloqueiam a emissao pela mesma razao do `DadosIncompletos` do parecer:
        certificado com o campo do participante em branco e um papel que nao
        prova nada, e ninguem confere trinta deles depois de impressos.
        """
        faltam: list[str] = []
        for marcador in self.tags_obrigatorias:
            campo = self.mapa_tags.get(marcador)
            if campo is None or campo not in CAMPOS_CERTIFICADO:
                faltam.append(f"{marcador} (campo desconhecido)")
                continue
            if not _tem_valor(CAMPOS_CERTIFICADO[campo].obter(self)):
                faltam.append(f"{marcador} ({CAMPOS_CERTIFICADO[campo].rotulo})")
        return faltam


def _tem_valor(valor: object) -> bool:
    if isinstance(valor, documento.ImagemEmLinha):
        # imagem que nao existe no disco renderiza vazio: para o papel, e o
        # mesmo que nao ter valor nenhum
        return valor.caminho.is_file()
    if valor is None:
        return False
    if isinstance(valor, str):
        return bool(valor.strip())
    return True


# =====================================================================
# O vocabulario fechado
# =====================================================================
@dataclass(frozen=True)
class CampoCertificado:
    rotulo: str
    exemplo: str
    grupo: str
    obter: Callable[[ContextoCertificado], object]


def _c(
    grupo: str,
    rotulo: str,
    exemplo: str,
    obter: Callable[[ContextoCertificado], object],
) -> CampoCertificado:
    return CampoCertificado(rotulo=rotulo, exemplo=exemplo, grupo=grupo, obter=obter)


def _rich(texto: str) -> object:
    """Quebra de linha dentro de celula do .docx. Vazio vira "" e nao None."""
    return documento.rich_multilinha(texto) or ""


def _data(valor: date | None) -> str:
    return datas_br.numerica(valor) if valor else ""


def _caminho_rubrica(sha256: str | None) -> object:
    if not sha256:
        return ""
    from app.servicos.anexos import caminho_do_blob

    return documento.ImagemEmLinha(
        caminho=caminho_do_blob(sha256), largura_mm=LARGURA_RUBRICA_MM
    )


# A ordem e a de leitura do documento, e e ela que a tela do modelo usa nos
# grupos do seletor.
CAMPOS_CERTIFICADO: dict[str, CampoCertificado] = {
    "participante_nome": _c(
        "Participante", "Nome do participante", "Maria Aparecida de Souza",
        lambda c: c.participante_nome,
    ),
    "participante_identificador": _c(
        "Participante", "Identificador público", "PTC-7F3K9Q2M",
        lambda c: c.participante_identificador,
    ),
    "participante_vinculo": _c(
        "Participante", "Vínculo", "Servidor", lambda c: c.participante_vinculo
    ),
    "participante_organizacao": _c(
        "Participante", "Organização de origem", "UFVJM",
        lambda c: c.participante_organizacao,
    ),
    "participante_siape": _c(
        "Participante", "SIAPE (só servidor)", "1110654",
        lambda c: c.participante_siape,
    ),
    "participante_lotacao": _c(
        "Participante", "Lotação na data da turma",
        "Faculdade de Medicina de Diamantina", lambda c: c.participante_lotacao,
    ),
    "treinamento_nome": _c(
        "Treinamento", "Nome do treinamento", "Trabalho em Altura (NR-35)",
        lambda c: c.treinamento_nome,
    ),
    "treinamento_carga_horaria": _c(
        "Treinamento", "Carga horária", "8 horas",
        # a carga da TURMA, nao a do catalogo: a turma pode ter rodado com carga
        # diferente da prevista, e o certificado precisa dizer o que aconteceu
        lambda c: f"{numero_br(c.carga_horaria)} horas",
    ),
    "treinamento_conteudo": _c(
        "Treinamento", "Conteúdo programático", "um tópico por linha",
        lambda c: _rich(c.treinamento_conteudo),
    ),
    "treinamento_norma": _c(
        "Treinamento", "Norma de referência", "NR-35", lambda c: c.treinamento_norma
    ),
    "turma_data_inicio": _c(
        "Turma", "Data de início", "03/03/2026", lambda c: _data(c.turma_data_inicio)
    ),
    "turma_data_fim": _c(
        "Turma", "Data de término", "05/03/2026", lambda c: _data(c.turma_data_fim)
    ),
    "turma_periodo_extenso": _c(
        "Turma", "Período por extenso", "de 03 a 05 de março de 2026",
        lambda c: _periodo_extenso(c.turma_data_inicio, c.turma_data_fim),
    ),
    "turma_local": _c("Turma", "Local", "Auditório do Campus JK", lambda c: c.turma_local),
    "turma_unidade_promotora": _c(
        "Turma", "Unidade promotora", "Coordenadoria de Segurança e Saúde Ocupacional",
        lambda c: c.turma_unidade_promotora,
    ),
    "turma_instrutores": _c(
        "Turma", "Instrutores", "um por linha",
        lambda c: _rich("\n".join(_linha_do_instrutor(i) for i in c.instrutores)),
    ),
    "certificado_numero": _c(
        "Documento", "Número", "27", lambda c: str(c.numero)
    ),
    "certificado_ano": _c("Documento", "Ano", "2026", lambda c: str(c.ano)),
    "certificado_rotulo": _c(
        "Documento", "Número/ano", "27/2026", lambda c: c.rotulo
    ),
    "certificado_data_emissao": _c(
        "Documento", "Data de emissão", "12/03/2026", lambda c: _data(c.data_emissao)
    ),
    "certificado_data_extenso": _c(
        "Documento", "Data por extenso", "12 de março de 2026",
        lambda c: datas_br.por_extenso(c.data_emissao),
    ),
    "certificado_chave": _c(
        "Documento", "Chave de validação", "CSSO-2026-K7QMX-3FTB9-H",
        lambda c: c.chave_validacao,
    ),
    "certificado_qrcode": _c(
        "Documento", "QR Code da validação", "imagem — chega na fatia 5",
        # A chave e a URL ja nascem aqui; a IMAGEM depende de `qrcode` + `pillow`,
        # que o desenho poe na fatia 5 junto com a pagina publica (SS10). Ate la o
        # marcador rende vazio em vez de imprimir a URL crua: um endereco longo no
        # lugar de um quadrado de 3 cm estoura o layout de quem ja desenhou o
        # modelo. Nao marque esta tag como obrigatoria antes da fatia 5.
        lambda _c: "",
    ),
    "certificado_url_validacao": _c(
        "Documento", "Endereço da validação", "https://.../validar/CSSO-2026-…",
        lambda c: c.url_validacao,
    ),
    "certificado_data_vencimento": _c(
        "Documento", "Vencimento", "12/03/2028 ou “não expira”",
        lambda c: _data(c.data_vencimento) or SEM_VENCIMENTO,
    ),
    "nota_final": _c(
        "Resultado", "Nota final", "9,5",
        lambda c: numero_br(c.nota_final) if c.nota_final is not None else "",
    ),
    "frequencia_percentual": _c(
        "Resultado", "Frequência", "100%",
        lambda c: f"{numero_br(c.frequencia_percentual)}%"
        if c.frequencia_percentual is not None
        else "",
    ),
    "assinante_nome": _c(
        "Assinatura", "Nome do assinante", "Fabrício Raimundi Andrade",
        lambda c: c.assinante.get("nome", ""),
    ),
    "assinante_titulo": _c(
        "Assinatura", "Título do assinante", "Eng. Seg. do Trabalho",
        lambda c: " — ".join(
            p for p in (c.assinante.get("titulo"), c.assinante.get("registro")) if p
        ),
    ),
    "assinante_rubrica": _c(
        "Assinatura", "Imagem da rubrica", "imagem do anexo",
        lambda c: _caminho_rubrica(c.assinante.get("rubrica_sha256")),
    ),
    "setor_emissor_nome": _c(
        "Emissor", "Nome extenso do setor",
        "Coordenadoria de Segurança e Saúde Ocupacional", lambda c: c.setor_nome,
    ),
    "setor_emissor_sigla": _c(
        "Emissor", "Sigla composta", "CSSO/Sisa", lambda c: c.setor_sigla
    ),
    "cidade": _c("Emissor", "Cidade", "Diamantina", lambda c: c.cidade),
}


def campos_por_grupo() -> dict[str, list[tuple[str, CampoCertificado]]]:
    """Agrupa o vocabulario para o seletor da tela do modelo."""
    grupos: dict[str, list[tuple[str, CampoCertificado]]] = {}
    for codigo, campo in CAMPOS_CERTIFICADO.items():
        grupos.setdefault(campo.grupo, []).append((codigo, campo))
    return grupos


def exigir_campo(codigo: str) -> str:
    if codigo not in CAMPOS_CERTIFICADO:
        raise CampoDesconhecido(codigo)
    return codigo


# =====================================================================
# O arquivo do modelo
# =====================================================================
def caminho_modelo(arquivo: str) -> Path:
    """Resolve o nome do arquivo dentro de app/templates/certificados/.

    So o nome, nunca um caminho: aceitar `../` aqui deixaria a tela de modelos
    ler qualquer arquivo do disco.
    """
    return DIR_MODELOS_CERTIFICADO / Path(arquivo).name


def sha256_do_modelo(arquivo: str) -> str | None:
    caminho = caminho_modelo(arquivo)
    if not caminho.is_file():
        return None
    digestor = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(65536), b""):
            digestor.update(bloco)
    return digestor.hexdigest()


def marcadores_do_arquivo(arquivo: str) -> set[str] | None:
    """Os `{{ marcadores }}` que o .docx realmente tem.

    Devolve `None` quando o arquivo ainda nao existe ou nao abre — o modelo
    pode ser cadastrado antes de o .docx ser colocado na pasta, e nesse caso a
    tela mostra "arquivo ausente" em vez de inventar uma lista vazia, que
    pareceria "nenhum marcador sobrando".
    """
    caminho = caminho_modelo(arquivo)
    if not caminho.is_file():
        return None
    try:
        from docxtpl import DocxTemplate

        return set(DocxTemplate(str(caminho)).get_undeclared_template_variables())
    except Exception:  # pragma: no cover - arquivo corrompido ou nao-docx
        return None


@dataclass(frozen=True)
class ConferenciaDoModelo:
    """O resultado do confronto entre o .docx e o dicionario de tags.

    `sem_mapa` bloqueia a emissao: marcador sem linha no mapa sai impresso como
    `{{ nome }}` no papel. `sem_marcador` e so aviso — a linha pode ter sido
    deixada de proposito para o proximo layout.
    """

    arquivo_encontrado: bool
    marcadores: tuple[str, ...] = ()
    sem_mapa: tuple[str, ...] = ()
    sem_marcador: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.arquivo_encontrado and not self.sem_mapa


def conferir_modelo(arquivo: str, mapa: dict[str, str]) -> ConferenciaDoModelo:
    marcadores = marcadores_do_arquivo(arquivo)
    if marcadores is None:
        return ConferenciaDoModelo(arquivo_encontrado=False)
    return ConferenciaDoModelo(
        arquivo_encontrado=True,
        marcadores=tuple(sorted(marcadores)),
        sem_mapa=tuple(sorted(marcadores - set(mapa))),
        sem_marcador=tuple(sorted(set(mapa) - marcadores)),
    )


# =====================================================================
# Render
# =====================================================================
def renderizar(contexto: ContextoCertificado, destino: Path) -> dict:
    """Rende o .docx do certificado a partir do contexto (congelado ou nao).

    Passa por `documento.renderizar_modelo`, que e o unico lugar do sistema que
    abre um modelo e grava um documento: dois mecanismos de documento seriam
    dois lugares para o hash de integridade divergir.
    """
    return documento.renderizar_modelo(
        contexto.modelo_arquivo,
        contexto.como_dicionario(),
        destino,
        pasta=DIR_MODELOS_CERTIFICADO,
        dica="Cadastre o .docx em app/templates/certificados/ e confira o "
        "dicionário de tags em /treinamentos/modelos.",
    )


__all__ = [
    "CAMPOS_CERTIFICADO",
    "DIR_MODELOS_CERTIFICADO",
    "SEM_VENCIMENTO",
    "CampoCertificado",
    "CampoDesconhecido",
    "ConferenciaDoModelo",
    "ContextoCertificado",
    "campos_por_grupo",
    "caminho_modelo",
    "chave_valida",
    "conferir_modelo",
    "digito_verificador",
    "exigir_campo",
    "gerar_chave",
    "marcadores_do_arquivo",
    "montar_chave",
    "normalizar_chave",
    "renderizar",
    "sha256_do_modelo",
]
