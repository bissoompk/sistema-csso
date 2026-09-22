"""Catalogos versionados: tipos, percentuais, fundamentacoes, agentes, textos."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import Base, DataPura


class TipoAdicional(Base):
    __tablename__ = "tipo_adicional"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(24), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(80), nullable=False)
    # como entra na frase da recomendacao: 'adicional de insalubridade'
    nome_recomendacao: Mapped[str] = mapped_column(String(80), nullable=False)
    base_legal: Mapped[str | None] = mapped_column(Text)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    percentuais: Mapped[list["PercentualAplicavel"]] = relationship(
        back_populates="tipo_adicional"
    )


class TipoMovimento(Base):
    __tablename__ = "tipo_movimento"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(40), nullable=False)
    gera_direito: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class TipoRisco(Base):
    __tablename__ = "tipo_risco"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(60), nullable=False)


class PercentualAplicavel(Base):
    __tablename__ = "percentual_aplicavel"

    id: Mapped[int] = mapped_column(primary_key=True)
    tipo_adicional_id: Mapped[int] = mapped_column(
        ForeignKey("tipo_adicional.id"), nullable=False
    )
    grau: Mapped[str] = mapped_column(String(10), nullable=False)
    rotulo: Mapped[str] = mapped_column(String(40), nullable=False)
    valor: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    base_calculo: Mapped[str] = mapped_column(
        String(60), nullable=False, default="vencimento do cargo efetivo"
    )

    tipo_adicional: Mapped[TipoAdicional] = relationship(
        back_populates="percentuais", lazy="selectin"
    )

    __table_args__ = (
        UniqueConstraint("tipo_adicional_id", "grau", name="uq_percentual"),
        CheckConstraint(
            "grau IN ('MINIMO','MEDIO','MAXIMO','UNICO')", name="ck_grau"
        ),
    )


class FundamentacaoLegal(Base):
    __tablename__ = "fundamentacao_legal"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    norma: Mapped[str] = mapped_column(String(40), nullable=False)
    anexo: Mapped[str | None] = mapped_column(String(20))
    tipo_risco_id: Mapped[int | None] = mapped_column(ForeignKey("tipo_risco.id"))
    texto: Mapped[str] = mapped_column(Text, nullable=False)
    dispositivo_conferido_em: Mapped[date | None] = mapped_column(DataPura)
    vigente: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    tipo_risco: Mapped[TipoRisco | None] = relationship(lazy="selectin")


class AgenteNocivo(Base):
    __tablename__ = "agente_nocivo"

    id: Mapped[int] = mapped_column(primary_key=True)
    descricao: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    tipo_risco_id: Mapped[int] = mapped_column(ForeignKey("tipo_risco.id"), nullable=False)
    fundamentacao_id: Mapped[int | None] = mapped_column(
        ForeignKey("fundamentacao_legal.id")
    )
    percentual_sugerido_id: Mapped[int | None] = mapped_column(
        ForeignKey("percentual_aplicavel.id")
    )
    exige_reavaliacao_quantitativa: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # sinonimo -> canonico (de-para que altera semantica: exige aprovacao)
    agente_canonico_id: Mapped[int | None] = mapped_column(ForeignKey("agente_nocivo.id"))
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    tipo_risco: Mapped[TipoRisco] = relationship(lazy="selectin")
    fundamentacao: Mapped[FundamentacaoLegal | None] = relationship(lazy="selectin")


class TextoPadrao(Base):
    __tablename__ = "texto_padrao"

    id: Mapped[int] = mapped_column(primary_key=True)
    categoria: Mapped[str] = mapped_column(String(30), nullable=False)
    codigo: Mapped[str] = mapped_column(String(40), nullable=False)
    template: Mapped[str] = mapped_column(Text, nullable=False)
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    vigente: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # false = paragrafo estatico do .docx; existe so como referencia de catalogo
    renderizado_pelo_modelo: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    dispositivo_conferido_em: Mapped[date | None] = mapped_column(DataPura)

    __table_args__ = (
        UniqueConstraint("categoria", "codigo", "versao", name="uq_texto"),
        CheckConstraint(
            "categoria IN ('ALTERACAO','RECOMENDACAO','REAVALIACAO',"
            "'RODAPE_RESPONSABILIDADE','ASSUNTO','PREAMBULO','ENCERRAMENTO')",
            name="ck_cat",
        ),
    )


class TipoMarcoInicial(Base):
    __tablename__ = "tipo_marco_inicial"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    rotulo: Mapped[str] = mapped_column(String(80), nullable=False)
    base_legal: Mapped[str | None] = mapped_column(Text)


class TipoProcesso(Base):
    __tablename__ = "tipo_processo"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(80), nullable=False)
    cor_hex: Mapped[str | None] = mapped_column(String(7))
    modulo: Mapped[str] = mapped_column(String(32), nullable=False, default="ADICIONAL")


class Parametro(Base):
    """Parametros operacionais editaveis em /config (SLA, por exemplo).

    Fica no banco, nao no .env: o .env e infraestrutura (porta, caminho, chave);
    isto e regra de trabalho do setor, que o coordenador muda sozinho.
    """

    __tablename__ = "parametro"

    chave: Mapped[str] = mapped_column(String(60), primary_key=True)
    valor: Mapped[str] = mapped_column(Text, nullable=False)
    descricao: Mapped[str | None] = mapped_column(Text)


class ChecklistModelo(Base):
    """Modelo de checklist aplicavel a um processo (catalogo /checklists-modelo)."""

    __tablename__ = "checklist_modelo"

    id: Mapped[int] = mapped_column(primary_key=True)
    nome: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    tipo_processo_id: Mapped[int | None] = mapped_column(ForeignKey("tipo_processo.id"))
    estado_alvo: Mapped[str | None] = mapped_column(String(32))
    # um item por linha, na ordem
    itens: Mapped[str] = mapped_column(Text, nullable=False)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    tipo_processo: Mapped["TipoProcesso | None"] = relationship(lazy="selectin")

    @property
    def lista_de_itens(self) -> list[str]:
        return [linha.strip() for linha in (self.itens or "").splitlines() if linha.strip()]


class FluxoEtapa(Base):
    __tablename__ = "fluxo_etapa"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(60), nullable=False)
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, unique=True)
    tipo: Mapped[str] = mapped_column(String(12), nullable=False, default="FLUXO")
    terminal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        CheckConstraint("tipo IN ('FLUXO','REPOSITORIO')", name="ck_etapa_tipo"),
    )


__all__ = [
    "AgenteNocivo",
    "ChecklistModelo",
    "FluxoEtapa",
    "Parametro",
    "FundamentacaoLegal",
    "PercentualAplicavel",
    "TextoPadrao",
    "TipoAdicional",
    "TipoMarcoInicial",
    "TipoMovimento",
    "TipoProcesso",
    "TipoRisco",
]
