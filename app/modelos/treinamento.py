"""Modulo Certificados e Treinamentos.

Fatias 1 a 4 do desenho (`entrada/integrasst/desenho_certificados.md`):

- **fatia 1** — o que se ensina (`treinamento`), o modelo do papel que sai no
  fim (`certificado_modelo`, `certificado_modelo_tag`) e quem assina
  (`assinatura_instrutor`);
- **fatia 2** — quem participa (`participante`, `participante_email`), quando
  (`turma`, `turma_sequencia`, `turma_instrutor`) e quem esta na turma
  (`inscricao`);
- **fatia 3** — quem esteve em cada dia (`turma_presenca`), de onde sai a
  frequencia que decide se o certificado pode sair;
- **fatia 4** — o papel em si (`certificado`, `certificado_sequencia`), com o
  contexto congelado que faz a segunda via sair identica a primeira (RN-15).

A separacao entre `treinamento` e `certificado_modelo` e deliberada e desfaz o
erro do IntegraSST, que guardava os dois na mesma linha: o treinamento dura
anos, o layout do certificado muda quando muda a identidade visual da
universidade. Juntos, redesenhar o papel obrigaria a mexer no catalogo.

A separacao entre `inscricao`, presenca e certificado desfaz o outro erro da
mesma planilha, que punha os tres numa linha so: assim nao havia como ter o
historico de quem se inscreveu e nao veio, nem certificado anulado com o
registro de aprovacao intacto.
"""

from __future__ import annotations

import secrets
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.modelos.base import (
    Base,
    DataPura,
    Inet,
    JSONTexto,
    MomentoUTC,
    agora_utc,
    check_regex,
)

ORIENTACOES = ("PAISAGEM", "RETRATO")

# NR-35, PRIM-SOCORROS, BRIGADA_2026: caixa alta porque o codigo e citado em
# oficio e em planilha, e caixa mista vira duas grafias do mesmo treinamento.
PADRAO_CODIGO_TREINAMENTO = r"[A-Z0-9][A-Z0-9._-]*"
# o marcador vira variavel Jinja dentro do .docx ({{ nome_do_aluno }}); o que
# nao for identificador valido quebra o render la na fatia 4, e o lugar de
# recusar isso e aqui, quando alguem digita.
PADRAO_MARCADOR = r"[A-Za-z_][A-Za-z0-9_]*"


class Treinamento(Base):
    """O que se ensina. Dura anos; o layout do certificado, nao."""

    __tablename__ = "treinamento"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    # sai no certificado byte a byte, como o nome do posto sai no parecer
    nome: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    carga_horaria_horas: Mapped[Decimal] = mapped_column(Numeric(5, 1), nullable=False)
    # um topico por linha, como ChecklistModelo.itens
    conteudo_programatico: Mapped[str | None] = mapped_column(Text)
    # 0 = NAO EXPIRA. E o unico acerto do legado nesse ponto e fica literal:
    # data magica de vencimento (31/12/9999) mente para todo relatorio depois.
    validade_meses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    norma_referencia: Mapped[str | None] = mapped_column(String(120))
    # entra no monitor de "nunca fez" quando houver exigencia cadastrada (fatia 7)
    obrigatorio: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # `use_alter` porque esta FK fecha um ciclo com
    # `certificado_modelo.treinamento_id`: sem ele o SQLAlchemy nao consegue
    # ordenar as tabelas e desiste de ordenar o ESQUEMA INTEIRO, nao so as duas
    # — `drop_all` passa a falhar em `laudo_tecnico`, e `sorted_tables` (que o
    # autogenerate e o `alembic check` chamam) avisa a cada execucao. Nao muda
    # o esquema gravado: no SQLite a FK continua embutida no CREATE TABLE e no
    # PostgreSQL o ALTER TABLE final ja era o que a migracao escrevia a mao.
    modelo_vigente_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "certificado_modelo.id",
            name="fk_treinamento_modelo_vigente",
            use_alter=True,
        )
    )
    instrutor_padrao_id: Mapped[int | None] = mapped_column(
        ForeignKey("assinatura_instrutor.id", name="fk_treinamento_instrutor_padrao")
    )
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # `post_update` desfaz, do lado do ORM, o mesmo ciclo que `use_alter` desfaz
    # do lado do DDL: `treinamento.modelo_vigente_id` aponta para
    # `certificado_modelo`, que aponta de volta por `treinamento_id`. Com as duas
    # pontas sujas no mesmo flush — publicar uma versao nova E aponta-la como
    # vigente, que e o gesto normal da tela —, o SQLAlchemy nao consegue ordenar
    # os INSERTs e levanta `CircularDependencyError`. Com `post_update` ele grava
    # as duas linhas primeiro e o ponteiro num UPDATE no fim. E a mesma correcao
    # que `Participante.email_principal` ja carrega, pelo mesmo motivo.
    modelo_vigente: Mapped["CertificadoModelo | None"] = relationship(
        lazy="selectin", foreign_keys=[modelo_vigente_id], post_update=True
    )
    instrutor_padrao: Mapped["AssinaturaInstrutor | None"] = relationship(
        lazy="selectin"
    )

    __table_args__ = (
        CheckConstraint("validade_meses >= 0", name="ck_treinamento_validade"),
        CheckConstraint("carga_horaria_horas > 0", name="ck_treinamento_carga"),
        check_regex("ck_treinamento_codigo", "codigo", PADRAO_CODIGO_TREINAMENTO),
        Index("ix_treinamento_ativo", "ativo"),
    )

    @property
    def topicos(self) -> list[str]:
        return [
            linha.strip()
            for linha in (self.conteudo_programatico or "").splitlines()
            if linha.strip()
        ]

    @property
    def expira(self) -> bool:
        return self.validade_meses > 0

    @property
    def validade_rotulo(self) -> str:
        """Como a validade aparece na tela e, mais tarde, no certificado."""
        if not self.expira:
            return "não expira"
        if self.validade_meses % 12 == 0:
            anos = self.validade_meses // 12
            return f"{anos} ano" if anos == 1 else f"{anos} anos"
        return f"{self.validade_meses} meses"


class CertificadoModelo(Base):
    """O .docx com marcadores, versionado como TextoPadrao.

    Publicar uma versao nova desativa a anterior em vez de sobrescrever: quando
    a emissao existir (fatia 4), um certificado ja emitido precisa continuar
    apontando para o layout que valia no dia.
    """

    __tablename__ = "certificado_modelo"

    id: Mapped[int] = mapped_column(primary_key=True)
    # NULL = modelo generico, serve a qualquer treinamento
    treinamento_id: Mapped[int | None] = mapped_column(
        ForeignKey("treinamento.id", name="fk_certificado_modelo_treinamento")
    )
    nome: Mapped[str] = mapped_column(String(120), nullable=False)
    # nome do arquivo em app/templates/certificados/, mesmo padrao de
    # parecer_tecnico.modelo_arquivo
    arquivo: Mapped[str] = mapped_column(String(120), nullable=False)
    arquivo_sha256: Mapped[str | None] = mapped_column(String(64))
    orientacao: Mapped[str] = mapped_column(
        String(10), nullable=False, default="PAISAGEM"
    )
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    vigente: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    observacao: Mapped[str | None] = mapped_column(Text)
    criado_por: Mapped[int | None] = mapped_column(ForeignKey("usuario.id"))
    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    treinamento: Mapped["Treinamento | None"] = relationship(
        lazy="selectin", foreign_keys=[treinamento_id]
    )
    tags: Mapped[list["CertificadoModeloTag"]] = relationship(
        back_populates="modelo",
        cascade="all, delete-orphan",
        order_by="CertificadoModeloTag.ordem, CertificadoModeloTag.id",
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint(
            "treinamento_id", "nome", "versao", name="uq_certificado_modelo"
        ),
        CheckConstraint(
            "orientacao IN ('PAISAGEM','RETRATO')", name="ck_modelo_orientacao"
        ),
        CheckConstraint("versao >= 1", name="ck_modelo_versao"),
    )

    @property
    def rotulo(self) -> str:
        return f"{self.nome} v{self.versao}"

    @property
    def mapa_de_tags(self) -> dict[str, str]:
        """`{marcador: campo}` — a forma que a emissao vai congelar (fatia 4)."""
        return {tag.marcador: tag.campo for tag in self.tags}


class CertificadoModeloTag(Base):
    """O MAPEAMENTO_TAGS do legado, virado tabela.

    `marcador` e o que esta escrito no .docx; `campo` e o codigo do dado do
    sistema que o alimenta. A lista de campos possiveis e codigo
    (`app/servicos/certificado.py::CAMPOS_CERTIFICADO`), porque cada campo
    precisa de uma funcao que saiba onde buscar o dado; qual marcador recebe
    qual campo e dado, editavel na tela sem deploy.
    """

    __tablename__ = "certificado_modelo_tag"

    id: Mapped[int] = mapped_column(primary_key=True)
    modelo_id: Mapped[int] = mapped_column(
        ForeignKey("certificado_modelo.id", ondelete="CASCADE"), nullable=False
    )
    marcador: Mapped[str] = mapped_column(String(60), nullable=False)
    campo: Mapped[str] = mapped_column(String(60), nullable=False)
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    # vazio neste campo bloqueia a emissao, como DadosIncompletos no parecer
    obrigatorio: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    modelo: Mapped[CertificadoModelo] = relationship(back_populates="tags")

    __table_args__ = (
        UniqueConstraint("modelo_id", "marcador", name="uq_modelo_tag"),
        check_regex("ck_modelo_tag_marcador", "marcador", PADRAO_MARCADOR),
        Index("ix_modelo_tag_campo", "campo"),
    )


class AssinaturaInstrutor(Base):
    """Quem assina o certificado, interno ou externo.

    Substitui a aba CERT_ASSINATURAS do legado, onde a rubrica era um link do
    Google Drive. Aqui a imagem e anexo local, com dedup por SHA-256 — o
    certificado nao pode depender de um arquivo que alguem move na nuvem.
    """

    __tablename__ = "assinatura_instrutor"

    id: Mapped[int] = mapped_column(primary_key=True)
    # instrutor interno reaproveita o cadastro de servidor; externo fica so com nome
    servidor_id: Mapped[int | None] = mapped_column(ForeignKey("servidor.id"))
    nome: Mapped[str] = mapped_column(String(160), nullable=False)
    titulo: Mapped[str | None] = mapped_column(String(120))
    conselho: Mapped[str | None] = mapped_column(String(8))
    registro_conselho: Mapped[str | None] = mapped_column(String(30))
    organizacao: Mapped[str | None] = mapped_column(String(160))
    externo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    imagem_anexo_id: Mapped[int | None] = mapped_column(ForeignKey("anexo.id"))
    vigencia_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    vigencia_fim: Mapped[date | None] = mapped_column(DataPura)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    servidor = relationship("Servidor", lazy="selectin")

    __table_args__ = (
        CheckConstraint(
            "externo = 1 OR servidor_id IS NOT NULL", name="ck_assinatura_vinculo"
        ),
        CheckConstraint(
            "vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio",
            name="ck_assinatura_periodo",
        ),
        Index("ix_assinatura_ativo", "ativo"),
    )

    def vigente_em(self, quando: date) -> bool:
        return self.vigencia_inicio <= quando and (
            self.vigencia_fim is None or self.vigencia_fim >= quando
        )

    @property
    def nome_exibicao(self) -> str:
        """Interno le do cadastro de servidor; assim nome nao diverge em dois lugares."""
        return self.servidor.nome if self.servidor else self.nome

    @property
    def registro_completo(self) -> str:
        if self.conselho and self.registro_conselho:
            return f"{self.conselho} {self.registro_conselho}"
        return self.registro_conselho or ""


# =====================================================================
# Fatia 2 — participante, turma e inscricao
# =====================================================================

# O mesmo alfabeto de 30 simbolos que o SS5 do desenho fixa para a chave de
# validacao, e pelo mesmo motivo: o identificador e ditado ao telefone e
# copiado de um papel. Ficam de fora 0/O e 1/I/L, que se confundem manuscritos,
# e U, que o desenho tambem descarta. Mesmo criterio do alfabeto da senha
# provisoria em `autenticacao.py`.
ALFABETO_IDENTIFICADOR = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
PREFIXO_IDENTIFICADOR = "PTC-"
TAMANHO_IDENTIFICADOR = 8
PADRAO_IDENTIFICADOR_PARTICIPANTE = (
    rf"PTC-[{ALFABETO_IDENTIFICADOR}]{{{TAMANHO_IDENTIFICADOR}}}"
)

# Terceirizado e discente entram em treinamento (decisao 3 do coordenador: o
# que caiu foi o EPI, nao o certificado de brigada).
VINCULOS_PARTICIPANTE: tuple[str, ...] = (
    "SERVIDOR",
    "TERCEIRIZADO",
    "DISCENTE",
    "VISITANTE",
    "OUTRO",
)

ROTULO_VINCULO: dict[str, str] = {
    "SERVIDOR": "Servidor da UFVJM",
    "TERCEIRIZADO": "Terceirizado",
    "DISCENTE": "Discente",
    "VISITANTE": "Visitante",
    "OUTRO": "Outro",
}

ORIGENS_EMAIL: tuple[str, ...] = (
    "CADASTRO",
    "INSCRICAO_PUBLICA",
    "SERVIDOR",
    "MESCLAGEM",
)

ORIGENS_INSCRICAO: tuple[str, ...] = ("INTERNA", "PUBLICA")


def normalizar_email(valor: str | None) -> str:
    """`casefold` e `strip`, e nada alem disso.

    Nao removemos ponto do Gmail nem sufixo `+alguma-coisa`: normalizar demais
    junta pessoas diferentes, que e o erro pior dos dois. Duas linhas para a
    mesma pessoa se resolvem na fila de mesclagem; uma linha para duas pessoas
    nao se resolve mais.
    """
    return (valor or "").strip().casefold()


def gerar_identificador_publico() -> str:
    """`PTC-7F3K9Q2M` — opaco, estavel e sem relacao com nome nem com e-mail.

    E o que aparece na pagina publica de validacao no lugar do nome (SS5 do
    desenho) e o que se cita num e-mail de suporte. Nao muda nunca, nem quando
    o e-mail muda, nem quando o externo vira servidor.
    """
    sorteio = "".join(
        secrets.choice(ALFABETO_IDENTIFICADOR) for _ in range(TAMANHO_IDENTIFICADOR)
    )
    return f"{PREFIXO_IDENTIFICADOR}{sorteio}"


class Participante(Base):
    """Ponteiro, nao cadastro.

    Para servidor e so um vinculo com `servidor`: nome, cargo e lotacao
    continuam morando la, e por isso nao divergem. Para externo, e o unico
    lugar onde o nome existe.

    NAO HA COLUNA DE CPF, e nao deve haver (decisao 1 do coordenador). O
    identificador do externo e o e-mail confirmado, que e mutavel — por isso a
    chave e o `id` e a identidade publica e o `identificador_publico`.

    Nao aponta para `usuario`: inscrever-se nao e autenticar-se, e participante
    nao tem conta. Aponta para `servidor`, que e como o dominio identifica quem
    tem SIAPE.

    Esta tabela nao e so de Certificados: `acidentado.participante_id` vai
    apontar para ela quando o modulo de Acidentes chegar (SS2.1 do plano
    consolidado). Mexer aqui mexe em dois modulos.
    """

    __tablename__ = "participante"

    id: Mapped[int] = mapped_column(primary_key=True)
    # a unicidade vai nomeada em `__table_args__`, e nao como `unique=True` na
    # coluna: constraint sem nome nao se derruba numa migracao futura, e
    # declarar as duas formas cria DUAS constraints iguais no esquema
    servidor_id: Mapped[int | None] = mapped_column(
        ForeignKey("servidor.id", name="fk_participante_servidor")
    )
    # SO para externo. Servidor tem NULL aqui e le `servidor.nome`.
    nome: Mapped[str | None] = mapped_column(String(160))
    identificador_publico: Mapped[str] = mapped_column(String(14), nullable=False)
    vinculo: Mapped[str] = mapped_column(String(16), nullable=False)
    organizacao: Mapped[str | None] = mapped_column(String(160))
    # matricula de discente ou numero do contrato do terceirizado, quando
    # houver. NAO e CPF, NAO e RG, e e opcional.
    matricula_externa: Mapped[str | None] = mapped_column(String(30))
    # `use_alter` porque esta FK fecha um ciclo com
    # `participante_email.participante_id`. Sem ele o SQLAlchemy desiste de
    # ordenar o esquema INTEIRO e o `drop_all` passa a falhar em tabela que nao
    # tem nada a ver com treinamento — foi o achado 7 da revisao da fatia 1.
    email_principal_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "participante_email.id",
            name="fk_participante_email_principal",
            use_alter=True,
        )
    )
    # mesclagem (fatia 6): o absorvido aponta para o mantido e sai das listas,
    # sem ser apagado — chave de validacao e relatorio ja emitidos continuam
    # resolvendo
    mesclado_em_id: Mapped[int | None] = mapped_column(
        ForeignKey("participante.id", name="fk_participante_mesclado")
    )
    # expurgo do externo que nunca compareceu (fatia 6, LGPD art. 6o III). As
    # colunas nascem agora porque a CHECK do nome depende de `expurgado_em`:
    # acrescenta-las depois obrigaria a reconstruir a tabela so por isso.
    expurgar_apos: Mapped[date | None] = mapped_column(DataPura)
    expurgado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    servidor = relationship("Servidor", lazy="selectin")
    emails: Mapped[list["ParticipanteEmail"]] = relationship(
        back_populates="participante",
        cascade="all, delete-orphan",
        foreign_keys="ParticipanteEmail.participante_id",
        order_by="ParticipanteEmail.id",
        lazy="selectin",
    )
    # `post_update` desfaz o mesmo ciclo do lado do ORM: o participante e
    # gravado primeiro, o e-mail depois, e o ponteiro num UPDATE no fim
    email_principal: Mapped["ParticipanteEmail | None"] = relationship(
        lazy="selectin", foreign_keys=[email_principal_id], post_update=True
    )

    __table_args__ = (
        # exatamente uma fonte de nome: o cadastro de servidor OU o campo local
        CheckConstraint(
            "(servidor_id IS NOT NULL AND nome IS NULL) OR "
            "(servidor_id IS NULL AND nome IS NOT NULL) OR expurgado_em IS NOT NULL",
            name="ck_participante_nome",
        ),
        CheckConstraint(
            "vinculo IN ('SERVIDOR','TERCEIRIZADO','DISCENTE','VISITANTE','OUTRO')",
            name="ck_participante_vinculo",
        ),
        CheckConstraint(
            "vinculo <> 'SERVIDOR' OR servidor_id IS NOT NULL",
            name="ck_participante_servidor",
        ),
        check_regex(
            "ck_participante_identificador",
            "identificador_publico",
            PADRAO_IDENTIFICADOR_PARTICIPANTE,
        ),
        PrimaryKeyConstraint("id", name="pk_participante"),
        UniqueConstraint("servidor_id", name="uq_participante_servidor"),
        UniqueConstraint("identificador_publico", name="uq_participante_identificador"),
        Index("ix_participante_mesclado", "mesclado_em_id"),
    )

    @property
    def nome_exibicao(self) -> str:
        """Servidor le do cadastro; externo le do proprio campo.

        Nunca copiar o nome do servidor para ca: no dia em que alguem corrigir
        um dos dois, o certificado sai com o outro.
        """
        if self.servidor is not None:
            return self.servidor.nome
        return self.nome or "(expurgado)"

    @property
    def e_servidor(self) -> bool:
        return self.servidor_id is not None

    @property
    def email_exibicao(self) -> str:
        if self.email_principal is not None:
            return self.email_principal.email
        return self.emails[0].email if self.emails else ""


class ParticipanteEmail(Base):
    """Os e-mails conhecidos de um participante. Um participante, N enderecos.

    E isto que reconcilia o historico: quando a mesma pessoa se inscreve com o
    e-mail pessoal e depois com o institucional, os dois enderecos passam a
    apontar para o MESMO participante e a linha do tempo de reciclagem continua
    inteira. Com o e-mail como coluna unica seriam duas pessoas, e o monitor de
    reciclagem diria "nunca fez" de quem fez.
    """

    __tablename__ = "participante_email"

    id: Mapped[int] = mapped_column(primary_key=True)
    participante_id: Mapped[int] = mapped_column(
        ForeignKey(
            "participante.id", name="fk_participante_email_dono", ondelete="CASCADE"
        ),
        nullable=False,
    )
    email: Mapped[str] = mapped_column(String(160), nullable=False)
    email_normalizado: Mapped[str] = mapped_column(String(160), nullable=False)
    confirmado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    origem: Mapped[str] = mapped_column(String(20), nullable=False, default="CADASTRO")
    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    participante: Mapped[Participante] = relationship(
        back_populates="emails", foreign_keys=[participante_id]
    )

    __table_args__ = (
        UniqueConstraint(
            "participante_id", "email_normalizado", name="uq_participante_email"
        ),
        CheckConstraint(
            "origem IN ('CADASTRO','INSCRICAO_PUBLICA','SERVIDOR','MESCLAGEM')",
            name="ck_participante_email_origem",
        ),
        PrimaryKeyConstraint("id", name="pk_participante_email"),
        Index("ix_participante_email_norm", "email_normalizado"),
    )

    @validates("email")
    def _derivar_normalizado(self, _campo: str, valor: str | None) -> str:
        """A forma normalizada nasce da bruta, sempre, e nao se digita.

        Deixar as duas colunas independentes seria deixar a reconciliacao
        depender de quem lembrou de preencher a segunda — e um script de carga
        que gravasse so `email` faria a busca por e-mail parar de achar a
        pessoa, em silencio.
        """
        limpo = (valor or "").strip()
        self.email_normalizado = normalizar_email(limpo)
        return limpo

    @property
    def confirmado(self) -> bool:
        return self.confirmado_em is not None


# Um e-mail CONFIRMADO pertence a um participante so. E-mail ainda nao
# confirmado pode aparecer em mais de um registro — e justamente o sinal de que
# ha duplicata a mesclar, e e ele que alimenta a fila da fatia 6.
Index(
    "uq_email_confirmado",
    ParticipanteEmail.email_normalizado,
    unique=True,
    sqlite_where=ParticipanteEmail.confirmado_em.isnot(None),
    postgresql_where=ParticipanteEmail.confirmado_em.isnot(None),
)


class TurmaSequencia(Base):
    """Mesma disciplina da RN-03: nunca MAX(numero)+1.

    Consumida por `numeracao.proximo_numero_turma`, dentro da transacao de quem
    chama.
    """

    __tablename__ = "turma_sequencia"

    ano: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ultimo_numero: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (PrimaryKeyConstraint("ano", name="pk_turma_sequencia"),)


class Turma(Base):
    """Uma oferta do treinamento: quando, onde, com quem e para quantos."""

    __tablename__ = "turma"

    id: Mapped[int] = mapped_column(primary_key=True)
    treinamento_id: Mapped[int] = mapped_column(
        ForeignKey("treinamento.id", name="fk_turma_treinamento"), nullable=False
    )
    numero: Mapped[int] = mapped_column(Integer, nullable=False)
    ano: Mapped[int] = mapped_column(Integer, nullable=False)
    # TUR-2026-0007, derivado de numero/ano. Fica gravado, e nao so calculado,
    # porque e ele que vai no cartaz e no oficio.
    codigo: Mapped[str] = mapped_column(String(20), nullable=False)

    # o legado tinha so DATA_CURSO; turma de 40h dura dias
    data_inicio: Mapped[date] = mapped_column(DataPura, nullable=False)
    data_fim: Mapped[date] = mapped_column(DataPura, nullable=False)
    # DATA_BASE_VENCIMENTO do legado — nem sempre e o fim do curso (pode ser a
    # data da avaliacao pratica). Vazio = usa `data_fim`.
    data_base_vencimento: Mapped[date | None] = mapped_column(DataPura)
    # sobrepoe a carga do treinamento quando a turma teve carga diferente
    carga_horaria_horas: Mapped[Decimal | None] = mapped_column(Numeric(5, 1))

    local: Mapped[str | None] = mapped_column(String(160))
    # o campus e o que faz `rbac.aplicar_escopo` funcionar sobre a turma sem
    # caso especial: ESCOPO_UNIDADE filtra por `campus_id` e mais nada
    campus_id: Mapped[int | None] = mapped_column(
        ForeignKey("campus.id", name="fk_turma_campus")
    )
    unidade_promotora_id: Mapped[int | None] = mapped_column(
        ForeignKey("unidade_uorg.id", name="fk_turma_unidade")
    )

    vagas: Mapped[int | None] = mapped_column(Integer)
    inscricao_aberta_ate: Mapped[date | None] = mapped_column(DataPura)
    # --- inscricao publica (fatia 6) ---
    # As colunas nascem aqui, e nao la, porque a fatia 6 e "zero esquema" no
    # plano (SS3.3): sem elas, a inscricao publica traria uma migracao so para
    # duas colunas de token, atras de uma decisao institucional que pode
    # demorar. O token vive no cartaz e no e-mail; aqui fica so o SHA-256, pelo
    # mesmo motivo que `sessao` guarda `token_hash` — token em claro em backup
    # e em log e token vazado.
    inscricao_publica: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    inscricao_token_hash: Mapped[str | None] = mapped_column(String(64))
    inscricao_token_expira_em: Mapped[datetime | None] = mapped_column(MomentoUTC)

    nota_minima_aprovacao: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # 75% e a praxe; a NR nao fixa numero geral (SS11, item 5 do desenho)
    frequencia_minima_percentual: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=75
    )

    situacao: Mapped[str] = mapped_column(
        String(20), nullable=False, default="PLANEJADA"
    )
    motivo_cancelamento: Mapped[str | None] = mapped_column(Text)
    observacoes: Mapped[str | None] = mapped_column(Text)
    concluida_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    criado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_turma_criado_por")
    )
    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    treinamento: Mapped[Treinamento] = relationship(lazy="selectin")
    campus = relationship("Campus", lazy="selectin")
    unidade_promotora = relationship("UnidadeUorg", lazy="selectin")
    instrutores: Mapped[list["TurmaInstrutor"]] = relationship(
        back_populates="turma",
        cascade="all, delete-orphan",
        order_by="TurmaInstrutor.ordem",
        lazy="selectin",
    )
    inscricoes: Mapped[list["Inscricao"]] = relationship(
        back_populates="turma", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("numero", "ano", name="uq_turma"),
        CheckConstraint("data_fim >= data_inicio", name="ck_turma_periodo"),
        CheckConstraint(
            "situacao IN ('PLANEJADA','INSCRICOES_ABERTAS','EM_ANDAMENTO',"
            "'CONCLUIDA','CANCELADA')",
            name="ck_turma_situacao",
        ),
        # cancelar sem motivo produz turma morta sem explicacao, e a explicacao
        # e o unico dado que sobra para quem perguntar depois
        CheckConstraint(
            "situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name="ck_turma_cancelada",
        ),
        CheckConstraint("vagas IS NULL OR vagas > 0", name="ck_turma_vagas"),
        CheckConstraint(
            "carga_horaria_horas IS NULL OR carga_horaria_horas > 0",
            name="ck_turma_carga",
        ),
        # link publico sem data de fechamento fica aberto para sempre
        CheckConstraint(
            "inscricao_publica = 0 OR inscricao_aberta_ate IS NOT NULL",
            name="ck_turma_inscricao_publica",
        ),
        CheckConstraint(
            "nota_minima_aprovacao IS NULL OR "
            "(nota_minima_aprovacao >= 0 AND nota_minima_aprovacao <= 10)",
            name="ck_turma_nota_minima",
        ),
        CheckConstraint(
            "frequencia_minima_percentual >= 0 AND frequencia_minima_percentual <= 100",
            name="ck_turma_frequencia_minima",
        ),
        CheckConstraint(
            "CAST(strftime('%Y', data_inicio) AS integer) = ano", name="ck_turma_ano"
        ),
        PrimaryKeyConstraint("id", name="pk_turma"),
        UniqueConstraint("codigo", name="uq_turma_codigo"),
        UniqueConstraint("inscricao_token_hash", name="uq_turma_token"),
        Index("ix_turma_treinamento", "treinamento_id"),
        Index("ix_turma_situacao", "situacao"),
        Index("ix_turma_data_fim", "data_fim"),
    )

    @property
    def carga_efetiva(self) -> Decimal:
        return self.carga_horaria_horas or self.treinamento.carga_horaria_horas

    @property
    def data_base(self) -> date:
        """A data de que o vencimento e contado (fatia 4)."""
        return self.data_base_vencimento or self.data_fim

    @property
    def rotulo(self) -> str:
        return f"{self.codigo} · {self.treinamento.nome}"

    @property
    def aceita_inscricao(self) -> bool:
        from app.modelos.estados import TURMA_ACEITA_INSCRICAO

        return self.situacao in TURMA_ACEITA_INSCRICAO

    @property
    def encerrada(self) -> bool:
        return self.situacao in ("CONCLUIDA", "CANCELADA")


class TurmaInstrutor(Base):
    """N instrutores por turma. No legado era uma coluna de texto — e por isso
    nao havia como saber quem assina o certificado de qual turma."""

    __tablename__ = "turma_instrutor"

    turma_id: Mapped[int] = mapped_column(
        ForeignKey("turma.id", name="fk_turma_instrutor_turma", ondelete="CASCADE"),
        primary_key=True,
    )
    assinatura_instrutor_id: Mapped[int] = mapped_column(
        ForeignKey("assinatura_instrutor.id", name="fk_turma_instrutor_assinatura"),
        primary_key=True,
    )
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    assina_certificado: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )

    turma: Mapped[Turma] = relationship(back_populates="instrutores")
    instrutor: Mapped[AssinaturaInstrutor] = relationship(lazy="selectin")

    __table_args__ = (
        PrimaryKeyConstraint(
            "turma_id", "assinatura_instrutor_id", name="pk_turma_instrutor"
        ),
    )


class Inscricao(Base):
    """A pessoa dentro da turma.

    Guarda so a inscricao: presenca fica em `turma_presenca` e o certificado em
    outra tabela (fatia 4). Foi juntar os tres numa linha que impediu o legado
    de ter o historico de quem se inscreveu e nao veio.
    """

    __tablename__ = "inscricao"

    id: Mapped[int] = mapped_column(primary_key=True)
    turma_id: Mapped[int] = mapped_column(
        ForeignKey("turma.id", name="fk_inscricao_turma", ondelete="CASCADE"),
        nullable=False,
    )
    participante_id: Mapped[int] = mapped_column(
        ForeignKey("participante.id", name="fk_inscricao_participante"), nullable=False
    )

    situacao: Mapped[str] = mapped_column(String(24), nullable=False, default="INSCRITA")
    origem: Mapped[str] = mapped_column(String(12), nullable=False, default="INTERNA")

    # --- confirmacao de e-mail da inscricao publica (fatia 6) ---
    # Mesma razao das colunas de token da turma: nascem agora para que a fatia
    # 6 nao precise de migracao.
    confirmacao_token_hash: Mapped[str | None] = mapped_column(String(64))
    confirmacao_expira_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    email_confirmado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    ip_inscricao: Mapped[str | None] = mapped_column(Inet)

    inscrito_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    inscrito_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_inscricao_inscrito_por")
    )
    confirmada_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    confirmada_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_inscricao_confirmada_por")
    )

    # CALCULADA a partir de `turma_presenca` por `servicos/presenca.py`, nunca
    # digitada — mesmo espirito da RN-07
    frequencia_percentual: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    nota_final: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    observacao: Mapped[str | None] = mapped_column(Text)
    motivo_cancelamento: Mapped[str | None] = mapped_column(Text)

    turma: Mapped[Turma] = relationship(back_populates="inscricoes", lazy="selectin")
    participante: Mapped[Participante] = relationship(lazy="selectin")
    presencas: Mapped[list["TurmaPresenca"]] = relationship(
        back_populates="inscricao",
        cascade="all, delete-orphan",
        order_by="TurmaPresenca.data",
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint("turma_id", "participante_id", name="uq_inscricao"),
        CheckConstraint(
            "situacao IN ('AGUARDANDO_EMAIL','INSCRITA','CONFIRMADA','PRESENTE',"
            "'AUSENTE','APROVADO','REPROVADO','CANCELADA')",
            name="ck_inscricao_situacao",
        ),
        CheckConstraint("origem IN ('INTERNA','PUBLICA')", name="ck_inscricao_origem"),
        CheckConstraint(
            "nota_final IS NULL OR (nota_final >= 0 AND nota_final <= 10)",
            name="ck_inscricao_nota",
        ),
        CheckConstraint(
            "frequencia_percentual IS NULL OR "
            "(frequencia_percentual >= 0 AND frequencia_percentual <= 100)",
            name="ck_inscricao_frequencia",
        ),
        CheckConstraint(
            "situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name="ck_inscricao_cancelada",
        ),
        # inscricao publica so sai de AGUARDANDO_EMAIL depois de confirmada: e a
        # trava que impede inscrever alguem no e-mail alheio (SS7 do desenho)
        CheckConstraint(
            "origem = 'INTERNA' OR situacao = 'AGUARDANDO_EMAIL' "
            "OR email_confirmado_em IS NOT NULL",
            name="ck_inscricao_email_confirmado",
        ),
        PrimaryKeyConstraint("id", name="pk_inscricao"),
        UniqueConstraint("confirmacao_token_hash", name="uq_inscricao_token"),
        Index("ix_inscricao_participante", "participante_id"),
        Index("ix_inscricao_turma_situacao", "turma_id", "situacao"),
    )

    @property
    def ocupa_vaga(self) -> bool:
        from app.modelos.estados import INSCRICAO_OCUPA_VAGA

        return self.situacao in INSCRICAO_OCUPA_VAGA

    @property
    def horas_presentes(self) -> Decimal:
        """As horas que contam para a frequencia. Falta justificada tambem e falta.

        Justificar a ausencia explica o que aconteceu e nao substitui a carga:
        NR-35 exige o conteudo ministrado, nao a boa vontade de quem faltou.
        """
        return sum(
            (p.horas for p in self.presencas if p.presente), start=Decimal(0)
        )

    @property
    def compareceu(self) -> bool:
        """Ao menos um dia com presenca registrada.

        E o criterio do SS7 do desenho para o fecho da turma: "toda inscricao
        sem presenca registrada vira AUSENTE".
        """
        return any(p.presente for p in self.presencas)


class TurmaPresenca(Base):
    """Presenca de um inscrito num dia da turma.

    Chamada `turma_presenca`, e nao `presenca`, por decisao do plano
    consolidado (SS1.4): reuniao de comissao tambem tem presenca de membro, e a
    CISSP vai querer o nome generico. Renomear depois de a tabela existir
    custaria migracao; agora custa uma linha.

    Frequencia se conta por DIA, nao por "veio ou nao veio". Uma turma de 40h
    com um dia perdido da 80%, e e esse numero que decide se o certificado sai.
    Sem a linha por dia, a unica alternativa seria alguem digitar o percentual —
    e percentual digitado e percentual que ninguem consegue conferir depois.

    `inscricao.frequencia_percentual` e derivada daqui pelo servico
    (`app/servicos/presenca.py`) e recalculada a cada lancamento; nunca e
    digitada. Mesmo espirito da RN-07.
    """

    __tablename__ = "turma_presenca"

    id: Mapped[int] = mapped_column(primary_key=True)
    inscricao_id: Mapped[int] = mapped_column(
        ForeignKey(
            "inscricao.id", name="fk_turma_presenca_inscricao", ondelete="CASCADE"
        ),
        nullable=False,
    )
    data: Mapped[date] = mapped_column(DataPura, nullable=False)
    horas: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False, default=0)
    presente: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # por que faltou. Nao abate a falta — so explica o que aconteceu para quem
    # ler a lista depois.
    justificativa: Mapped[str | None] = mapped_column(Text)
    registrado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_turma_presenca_registrado_por")
    )
    registrado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    inscricao: Mapped[Inscricao] = relationship(back_populates="presencas")

    __table_args__ = (
        CheckConstraint("horas >= 0", name="ck_turma_presenca_horas"),
        # O desenho (SS2.8) escreveu `presente = 1 OR horas = 0`, que funciona no
        # SQLite — onde booleano e inteiro — e QUEBRA no PostgreSQL, que e o
        # dialeto de referencia do projeto: la `presente` e boolean e nao se
        # compara com 1. A forma portatil e usar o booleano como booleano; nos
        # dois dialetos ela diz a mesma coisa — quem faltou nao acumula hora.
        CheckConstraint("presente OR horas = 0", name="ck_turma_presenca_coerente"),
        PrimaryKeyConstraint("id", name="pk_turma_presenca"),
        # um dia, um lancamento por inscrito: sem isto, corrigir o lancamento
        # viraria uma segunda linha e a frequencia somaria as duas
        UniqueConstraint("inscricao_id", "data", name="uq_turma_presenca_dia"),
    )


# =====================================================================
# Fatia 4 — o certificado
# =====================================================================

# `CSSO-2026-K7QMX-3FTB9-H` (SS5 do desenho). O ano ajuda o suporte e nao revela
# nada; os dez sorteados valem ~49 bits; o ultimo caractere e o digito
# verificador, que descarta 29 de cada 30 digitacoes erradas ANTES de tocar no
# banco. O alfabeto e o mesmo do `identificador_publico`, e pelo mesmo motivo: a
# chave e ditada ao telefone e copiada de um papel.
PREFIXO_CHAVE = "CSSO"
TAMANHO_SORTEIO_CHAVE = 10
PADRAO_CHAVE_VALIDACAO = (
    rf"CSSO-\d{{4}}-[{ALFABETO_IDENTIFICADOR}]{{5}}-"
    rf"[{ALFABETO_IDENTIFICADOR}]{{5}}-[{ALFABETO_IDENTIFICADOR}]"
)

SITUACOES_CERTIFICADO: tuple[str, ...] = ("EMITIDO", "ANULADO")

ROTULO_CERTIFICADO: dict[str, str] = {
    "EMITIDO": "Emitido",
    "ANULADO": "Anulado",
}


class CertificadoSequencia(Base):
    """Mesma disciplina da RN-03: nunca MAX(numero)+1.

    Consumida por `numeracao.proximo_numero_certificado`, dentro da transacao de
    quem chama.
    """

    __tablename__ = "certificado_sequencia"

    ano: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ultimo_numero: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (PrimaryKeyConstraint("ano", name="pk_certificado_sequencia"),)


class Certificado(Base):
    """O documento que circula — e por isso o unico deste modulo que congela.

    RN-15 aplicada ao certificado: `contexto_congelado` guarda TUDO o que foi
    renderizado, **inclusive o mapa de tags**. Sem o mapa, reimprimir com o
    dicionario de hoje mudaria *qual dado vai em qual lugar do documento* e o
    certificado sairia com o nome do instrutor no campo do participante — a
    falha mais silenciosa que este modulo poderia ter (SS4 do desenho).

    O que NAO entra no congelado, de proposito: `situacao` e "esta vencido
    hoje?". Sao estado, calculados na hora. Congelar estado e o erro simetrico —
    o certificado apareceria como valido para sempre.

    As colunas `servidor_id` e `campus_id` sao denormalizadas da inscricao e da
    turma para que `rbac.aplicar_escopo()` continue funcionando sem caso
    especial (SS8): ESCOPO_UNIDADE filtra por `campus_id` e ESCOPO_PROPRIO por
    `servidor_id`, e o teste que exige `aplicar_escopo` em todo repositorio
    continua valendo sem excecao.
    """

    __tablename__ = "certificado"

    id: Mapped[int] = mapped_column(primary_key=True)
    # sem ondelete: o certificado nao cai junto com a inscricao. Apagar uma
    # inscricao que ja produziu papel passa a ser recusado pelo banco, que e o
    # que se quer — documento emitido se anula, nao se apaga.
    inscricao_id: Mapped[int] = mapped_column(
        ForeignKey("inscricao.id", name="fk_certificado_inscricao"), nullable=False
    )
    numero: Mapped[int] = mapped_column(Integer, nullable=False)
    ano: Mapped[int] = mapped_column(Integer, nullable=False)
    # em claro, com indice unico. Guardar so o hash nao protegeria de nada — quem
    # tem o banco tem tudo — e impediria reimprimir a segunda via com a MESMA
    # chave, que e justamente o que a validacao publica precisa (SS5).
    chave_validacao: Mapped[str] = mapped_column(String(24), nullable=False)

    situacao: Mapped[str] = mapped_column(String(12), nullable=False, default="EMITIDO")
    data_emissao: Mapped[date] = mapped_column(DataPura, nullable=False)
    data_base_vencimento: Mapped[date] = mapped_column(DataPura, nullable=False)
    # NULL = nao expira (validade_meses = 0). Sem data magica, sem 9999-12-31:
    # data magica mente para todo relatorio depois.
    data_vencimento: Mapped[date | None] = mapped_column(DataPura)
    validade_meses_congelada: Mapped[int] = mapped_column(Integer, nullable=False)

    # RN-15: TODO o conteudo renderizado, inclusive o mapa de tags — ver SS4
    contexto_congelado: Mapped[dict] = mapped_column(JSONTexto, nullable=False)

    modelo_id: Mapped[int | None] = mapped_column(
        ForeignKey("certificado_modelo.id", name="fk_certificado_modelo")
    )
    modelo_arquivo: Mapped[str] = mapped_column(String(120), nullable=False)
    modelo_sha256: Mapped[str | None] = mapped_column(String(64))
    # SHA-256 do TEXTO extraido do .docx gerado, nao dos bytes do arquivo: o zip
    # do .docx carrega data de criacao e muda a cada render. E o mesmo criterio
    # do `parecer_tecnico.hash_conteudo`.
    hash_conteudo: Mapped[str | None] = mapped_column(String(64))
    arquivo_docx: Mapped[str | None] = mapped_column(Text)
    arquivo_pdf_anexo_id: Mapped[int | None] = mapped_column(
        ForeignKey("anexo.id", name="fk_certificado_pdf")
    )

    servidor_id: Mapped[int | None] = mapped_column(
        ForeignKey("servidor.id", name="fk_certificado_servidor")
    )
    campus_id: Mapped[int | None] = mapped_column(
        ForeignKey("campus.id", name="fk_certificado_campus")
    )
    treinamento_id: Mapped[int] = mapped_column(
        ForeignKey("treinamento.id", name="fk_certificado_treinamento"), nullable=False
    )
    participante_id: Mapped[int] = mapped_column(
        ForeignKey("participante.id", name="fk_certificado_participante"), nullable=False
    )

    emitido_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_certificado_emitido_por")
    )
    emitido_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    anulado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    anulado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_certificado_anulado_por")
    )
    motivo_anulacao: Mapped[str | None] = mapped_column(Text)
    substituido_por_id: Mapped[int | None] = mapped_column(
        ForeignKey("certificado.id", name="fk_certificado_substituto")
    )

    inscricao: Mapped[Inscricao] = relationship(lazy="selectin")
    participante: Mapped[Participante] = relationship(lazy="selectin")
    treinamento: Mapped[Treinamento] = relationship(lazy="selectin")
    modelo: Mapped["CertificadoModelo | None"] = relationship(lazy="selectin")

    __table_args__ = (
        UniqueConstraint("numero", "ano", name="uq_certificado"),
        UniqueConstraint("chave_validacao", name="uq_certificado_chave"),
        CheckConstraint(
            "situacao IN ('EMITIDO','ANULADO')", name="ck_certificado_situacao"
        ),
        # anular sem motivo produz documento morto sem explicacao, e a explicacao
        # e o unico dado que sobra para quem perguntar depois
        CheckConstraint(
            "situacao <> 'ANULADO' OR motivo_anulacao IS NOT NULL",
            name="ck_certificado_anulado",
        ),
        # 0 mes <=> sem vencimento. As duas colunas nao podem se contradizer:
        # `validade_meses_congelada = 24` com `data_vencimento` nula faria o
        # monitor de reciclagem (fatia 7) simplesmente perder o certificado.
        CheckConstraint(
            "(validade_meses_congelada = 0 AND data_vencimento IS NULL) OR "
            "(validade_meses_congelada > 0 AND data_vencimento IS NOT NULL)",
            name="ck_certificado_vencimento",
        ),
        CheckConstraint(
            "validade_meses_congelada >= 0", name="ck_certificado_validade"
        ),
        CheckConstraint(
            "CAST(strftime('%Y', data_emissao) AS integer) = ano",
            name="ck_certificado_ano",
        ),
        # nao se substitui por si mesmo: o ciclo transformaria a cadeia de
        # reemissao num laco que nenhuma tela sabe percorrer
        CheckConstraint(
            "substituido_por_id IS NULL OR substituido_por_id <> id",
            name="ck_certificado_substituto",
        ),
        check_regex("ck_certificado_chave", "chave_validacao", PADRAO_CHAVE_VALIDACAO),
        PrimaryKeyConstraint("id", name="pk_certificado"),
        Index("ix_certificado_vencimento", "data_vencimento"),
        Index("ix_certificado_servidor", "servidor_id"),
        Index("ix_certificado_participante", "participante_id"),
        Index("ix_certificado_treinamento", "treinamento_id"),
        Index("ix_certificado_inscricao", "inscricao_id"),
    )

    @property
    def rotulo(self) -> str:
        return f"{self.numero}/{self.ano}"

    @property
    def anulado(self) -> bool:
        return self.situacao == "ANULADO"

    def vencido_em(self, quando: date) -> bool:
        """Estado, nunca congelado: quem nao expira nunca vence."""
        return self.data_vencimento is not None and self.data_vencimento < quando

    def situacao_publica(self, quando: date) -> str:
        """VALIDO / VENCIDO / ANULADO — o que a pagina publica (fatia 5) responde.

        A ordem importa: anulado prevalece sobre vencido, porque um certificado
        anulado nunca foi valido e dizer "vencido" sugeriria que um dia valeu.
        """
        if self.anulado:
            return "ANULADO"
        return "VENCIDO" if self.vencido_em(quando) else "VALIDO"


# Uma inscricao tem no maximo um certificado NAO anulado. Anular libera a
# reemissao sem apagar o historico — RN-14 aplicada ao certificado. O indice e
# PARCIAL de proposito: um unique comum sobre `inscricao_id` impediria a segunda
# emissao para sempre, e a reemissao e justamente o remedio previsto para nome
# social, alteracao civil e erro de digitacao (SS11, item 12 do desenho).
Index(
    "uq_certificado_ativo",
    Certificado.inscricao_id,
    unique=True,
    sqlite_where=Certificado.situacao != "ANULADO",
    postgresql_where=Certificado.situacao != "ANULADO",
)


__all__ = [
    "ALFABETO_IDENTIFICADOR",
    "ORIENTACOES",
    "ORIGENS_EMAIL",
    "ORIGENS_INSCRICAO",
    "PADRAO_CHAVE_VALIDACAO",
    "PADRAO_CODIGO_TREINAMENTO",
    "PADRAO_IDENTIFICADOR_PARTICIPANTE",
    "PADRAO_MARCADOR",
    "PREFIXO_CHAVE",
    "ROTULO_CERTIFICADO",
    "ROTULO_VINCULO",
    "SITUACOES_CERTIFICADO",
    "TAMANHO_SORTEIO_CHAVE",
    "VINCULOS_PARTICIPANTE",
    "AssinaturaInstrutor",
    "Certificado",
    "CertificadoModelo",
    "CertificadoModeloTag",
    "CertificadoSequencia",
    "Inscricao",
    "Participante",
    "ParticipanteEmail",
    "Treinamento",
    "Turma",
    "TurmaInstrutor",
    "TurmaPresenca",
    "TurmaSequencia",
    "gerar_identificador_publico",
    "normalizar_email",
]
