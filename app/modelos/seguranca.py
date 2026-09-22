"""Usuarios, perfis, permissoes, atribuicoes, sessoes e habilitacao tecnica."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import Base, DataPura, Inet, MomentoUTC, agora_utc


class Usuario(Base):
    __tablename__ = "usuario"

    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(160), nullable=False)
    email: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    senha_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    provedor: Mapped[str] = mapped_column(String(16), nullable=False, default="LOCAL")
    identificador_externo: Mapped[str | None] = mapped_column(String(120))
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    precisa_trocar_senha: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    tentativas_falhas: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    bloqueado_ate: Mapped[datetime | None] = mapped_column(MomentoUTC)
    ultimo_login_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    criado_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)

    atribuicoes: Mapped[list["Atribuicao"]] = relationship(
        back_populates="usuario", foreign_keys="Atribuicao.usuario_id"
    )

    __table_args__ = (
        CheckConstraint(
            "provedor IN ('LOCAL','LDAP','SSO_UFVJM')", name="ck_usuario_provedor"
        ),
    )


class Perfil(Base):
    __tablename__ = "perfil"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    nome: Mapped[str] = mapped_column(String(80), nullable=False)
    base_normativa: Mapped[str | None] = mapped_column(Text)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    permissoes: Mapped[list["Permissao"]] = relationship(
        secondary="perfil_permissao", back_populates="perfis", lazy="selectin"
    )


class Permissao(Base):
    __tablename__ = "permissao"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    modulo: Mapped[str] = mapped_column(String(32), nullable=False, default="ADICIONAL")
    descricao: Mapped[str] = mapped_column(Text, nullable=False)

    perfis: Mapped[list[Perfil]] = relationship(
        secondary="perfil_permissao", back_populates="permissoes"
    )


class PerfilPermissao(Base):
    __tablename__ = "perfil_permissao"

    perfil_id: Mapped[int] = mapped_column(ForeignKey("perfil.id"), primary_key=True)
    permissao_id: Mapped[int] = mapped_column(ForeignKey("permissao.id"), primary_key=True)


class Atribuicao(Base):
    __tablename__ = "atribuicao"

    id: Mapped[int] = mapped_column(primary_key=True)
    usuario_id: Mapped[int] = mapped_column(ForeignKey("usuario.id"), nullable=False)
    perfil_id: Mapped[int] = mapped_column(ForeignKey("perfil.id"), nullable=False)
    coordenadoria: Mapped[str] = mapped_column(String(16), nullable=False, default="CSSO")
    campus_id: Mapped[int | None] = mapped_column(ForeignKey("campus.id"))
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)
    ato_normativo: Mapped[str | None] = mapped_column(Text)
    concedido_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))

    usuario: Mapped[Usuario] = relationship(
        back_populates="atribuicoes", foreign_keys=[usuario_id]
    )
    perfil: Mapped[Perfil] = relationship(lazy="selectin")

    def vigente_em(self, quando: date) -> bool:
        return self.vigencia_inicio <= quando and (
            self.vigencia_fim is None or self.vigencia_fim >= quando
        )


class Sessao(Base):
    __tablename__ = "sessao"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    usuario_id: Mapped[int] = mapped_column(ForeignKey("usuario.id"), nullable=False)
    criada_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False, default=agora_utc)
    expira_em: Mapped[datetime] = mapped_column(MomentoUTC, nullable=False)
    ip: Mapped[str | None] = mapped_column(Inet)
    user_agent: Mapped[str | None] = mapped_column(Text)
    revogada: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    usuario: Mapped[Usuario] = relationship(lazy="selectin")


class ProfissionalHabilitado(Base):
    """IN SGP/SEDGG/ME 15/2022, art. 10, SS2, I - quem NAO esta aqui nao assina."""

    __tablename__ = "profissional_habilitado"

    id: Mapped[int] = mapped_column(primary_key=True)
    usuario_id: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    nome: Mapped[str] = mapped_column(String(160), nullable=False)
    siape: Mapped[str | None] = mapped_column(String(7))
    habilitacao: Mapped[str] = mapped_column(String(30), nullable=False)
    titulo_assinatura: Mapped[str] = mapped_column(String(60), nullable=False)
    conselho: Mapped[str | None] = mapped_column(String(8))
    registro_conselho: Mapped[str | None] = mapped_column(String(30))
    documento_especializacao: Mapped[str | None] = mapped_column(String(120))
    externo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    justificativa_art10_par5: Mapped[str | None] = mapped_column(Text)
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)
    atestado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    atestado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)

    __table_args__ = (
        CheckConstraint(
            "habilitacao IN ('MED_TRABALHO','ENG_SEG_TRABALHO','ARQ_SEG_TRABALHO')",
            name="ck_habilitacao",
        ),
        CheckConstraint(
            "externo = 0 OR justificativa_art10_par5 IS NOT NULL", name="ck_externo"
        ),
    )

    def vigente_em(self, quando: date) -> bool:
        return self.vigencia_inicio <= quando and (
            self.vigencia_fim is None or self.vigencia_fim >= quando
        )


class AutoridadeDestinataria(Base):
    __tablename__ = "autoridade_destinataria"

    id: Mapped[int] = mapped_column(primary_key=True)
    nome: Mapped[str] = mapped_column(String(160), nullable=False)
    cargo: Mapped[str] = mapped_column(String(120), nullable=False)
    tratamento: Mapped[str] = mapped_column(String(80), nullable=False)
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)


class SetorEmissor(Base):
    __tablename__ = "setor_emissor"

    id: Mapped[int] = mapped_column(primary_key=True)
    sigla_composta: Mapped[str] = mapped_column(String(60), nullable=False)
    nome_extenso: Mapped[str] = mapped_column(String(200), nullable=False)
    unidade_sei: Mapped[str | None] = mapped_column(String(40))
    email: Mapped[str | None] = mapped_column(String(160))
    endereco: Mapped[str | None] = mapped_column(Text)
    # cidade do LOCAL DE EMISSAO, nao do campus avaliado: o parecer 2/2026 e da
    # FAMMUC (Teofilo Otoni) e mesmo assim foi datado em Diamantina, onde o
    # setor emissor funciona.
    cidade: Mapped[str] = mapped_column(String(80), nullable=False, default="Diamantina")
    telefone: Mapped[str | None] = mapped_column(String(60))
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)
    base_normativa: Mapped[str | None] = mapped_column(Text)

    # a sigla se repete ao longo do tempo: o mesmo SEST/DASA/PROGEP mudou de
    # nome extenso entre 2025 e 2026. A chave e (sigla, inicio de vigencia).
    __table_args__ = (
        UniqueConstraint("sigla_composta", "vigencia_inicio", name="uq_setor_vigencia"),
    )


class AcessoDadoSensivel(Base):
    """RN-23 - toda leitura de exposicao/parecer nominal/anexo restrito."""

    __tablename__ = "acesso_dado_sensivel"

    id: Mapped[int] = mapped_column(primary_key=True)
    usuario_id: Mapped[int] = mapped_column(ForeignKey("usuario.id"), nullable=False)
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    processo_id: Mapped[int | None] = mapped_column(ForeignKey("processo.id"))
    campo: Mapped[str] = mapped_column(String(60), nullable=False)
    finalidade: Mapped[str | None] = mapped_column(Text)
    ocorrido_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )


__all__ = [
    "AcessoDadoSensivel",
    "Atribuicao",
    "AutoridadeDestinataria",
    "Perfil",
    "PerfilPermissao",
    "Permissao",
    "ProfissionalHabilitado",
    "Sessao",
    "SetorEmissor",
    "Usuario",
    "Integer",
]
