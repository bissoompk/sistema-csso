"""Modulo Gestao de EPI — catalogo, estoque e ficha.

Portado do IntegraSST v9 a partir de `entrada/integrasst/desenho_epi.md`. O
prefixo `epi_` esta em todas as tabelas: o modulo tem catalogo proprio, e
`categoria` sem prefixo colidiria com a taxonomia de qualquer outro.

**Por que as seis tabelas nascem juntas, e nao uma por fatia.** As telas saem em
tres entregas, na ordem do desenho (catalogo -> ficha -> estoque), mas o grafo
de chaves estrangeiras vai na direcao contraria:

    epi_item -> epi_entrada_estoque -> epi_requisicao_item
             -> epi_ficha_registro  -> epi_movimento_estoque

`epi_ficha_registro` aponta para `epi_entrada_estoque` (fatia 3) e para
`epi_requisicao_item` (fatia 4). Criada sozinha na fatia 2, ela referenciaria
tabela inexistente: o SQLite ACEITA o `CREATE TABLE`, e o `PRAGMA
foreign_key_check` do `alembic/env.py` nao pega, porque a tabela esta vazia. O
erro so apareceria no primeiro registro de entrega — que e exatamente a linha
que o modulo existe para provar. Por isso o §3.4 do plano consolidado separa
migracao de fatia: uma migracao cria catalogo + estoque + ficha na ordem
topologica, e as telas continuam saindo em tres entregas reversiveis.

`requisicao_item_id` (nas duas tabelas onde aparece) nasceu `Integer` **sem**
chave estrangeira, pelo mesmo motivo: `epi_requisicao_item` so existe na fatia
4, e declarar a FK antes seria escrever no esquema uma promessa que o banco nao
consegue cobrar. A fatia 4 cumpriu a promessa e a FK real entrou por
`batch_alter_table`, na revisao `c1d9e47a2b30` — que recria as travas
append-only logo em seguida, porque reconstruir a tabela leva as triggers dela
junto.

**O que este modulo NAO recria:** `Servidor`, `UnidadeUorg`, `PostoTrabalho`,
`Cargo`, `Campus`, `Usuario`, `Anexo` e `HistoricoEvento`. Ele le e referencia.
E **nao ha coluna de CPF em lugar nenhum** (decisao 1): quem pede EPI e servidor,
e servidor se identifica por SIAPE.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.modelos.base import Base, DataPura, JSONTexto, MomentoUTC, agora_utc
from app.modelos.estados import ESTADOS_EPI_ITEM, ESTADOS_EPI_REQUISICAO

# ---------------------------------------------------------------------
# Vocabularios fechados
# ---------------------------------------------------------------------
# O `CHECK` e montado a partir da tupla, e nao escrito a mao ao lado dela: duas
# listas do mesmo conjunto divergem no dia em que alguem acrescenta valor a uma
# so, e o formulario passaria a oferecer o que o banco recusa.
TIPOS_MOVIMENTO: tuple[str, ...] = (
    "ENTRADA",
    "SAIDA",
    "DEVOLUCAO",
    "DESCARTE",
    "AJUSTE",
)

TIPOS_FICHA: tuple[str, ...] = (
    "ENTREGA",
    "DEVOLUCAO",
    "SUBSTITUICAO",
    "DESCARTE",
    "ESTORNO",
)

# Sugestao do formulario, e nao restricao de banco: o desenho nao fecha esta
# lista, e fecha-la travaria a compra que vier em rolo ou em galao. Vai como
# `<datalist>` na tela — sugere sem impedir.
UNIDADES_MEDIDA: tuple[str, ...] = (
    "UNIDADE",
    "PAR",
    "CAIXA",
    "CONJUNTO",
    "METRO",
    "ROLO",
    "LITRO",
)


def _lista(valores: tuple[str, ...]) -> str:
    return ",".join(f"'{valor}'" for valor in valores)


_LISTA_TIPOS_MOVIMENTO = _lista(TIPOS_MOVIMENTO)
_LISTA_TIPOS_FICHA = _lista(TIPOS_FICHA)
# Os dois `CHECK` de estado saem das MESMAS tuplas que as maquinas C e D usam
# para decidir transicao. Duas listas divergem no dia em que alguem acrescenta
# estado a uma so — e o resultado seria o servico admitir a transicao e o banco
# recusar a gravacao, na cara de quem opera.
_LISTA_ESTADOS_REQUISICAO = _lista(ESTADOS_EPI_REQUISICAO)
_LISTA_ESTADOS_ITEM = _lista(ESTADOS_EPI_ITEM)

FINALIDADES_REQUISICAO: tuple[str, ...] = (
    "PRIMEIRA_ENTREGA",
    "ROTINA",
    "SUBSTITUICAO",
    "DANO",
    "PERDA",
)

URGENCIAS_REQUISICAO: tuple[str, ...] = ("NORMAL", "URGENTE")

_LISTA_FINALIDADES = _lista(FINALIDADES_REQUISICAO)
_LISTA_URGENCIAS = _lista(URGENCIAS_REQUISICAO)


class EpiCategoria(Base):
    """A taxonomia do Anexo I da NR-6, semeada.

    No legado `Categoria` e texto livre no cadastro do item, e o resultado
    aparece na tela: "proteção do tronco", "da cabeça", "dos membros
    superiores" — quatro grafias de uma lista que a norma fecha em nove. Vira
    catalogo semeado, como `tipo_risco` e `fundamentacao_legal`.
    """

    __tablename__ = "epi_categoria"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(24), nullable=False)
    nome: Mapped[str] = mapped_column(String(80), nullable=False)
    # item do Anexo I da NR-6: 'A.1', 'B.2', 'G.1'...
    referencia_nr6: Mapped[str | None] = mapped_column(String(12))
    ordem: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_epi_categoria"),
        UniqueConstraint("codigo", name="uq_epi_categoria"),
    )

    @property
    def rotulo(self) -> str:
        """`A.1 · Proteção da cabeça` — o item da norma junto do nome.

        Sem a referencia ao lado, quem confere o cadastro contra o Anexo I
        precisa saber de cor qual letra e qual; com ela, a conferencia e visual.
        """
        return f"{self.referencia_nr6} · {self.nome}" if self.referencia_nr6 else self.nome


class EpiMotivoRecusa(Base):
    """Catalogo das negativas, com a fundamentacao junto.

    Nao existe no legado, onde recusa e texto livre digitado a cada vez. Recusa
    em texto livre sai diferente a cada vez, nao cita norma e nao se conta. Aqui
    a negativa e uniforme, fundamentada e contavel — e a contagem por motivo e o
    que permite ao setor mostrar o padrao dos pedidos que precisa recusar.

    E a peca que faz a decisao 3 (a UFVJM nao fornece EPI a terceirizado) virar
    comportamento de sistema em vez de ausencia de cadastro: `VINCULO_NAO_ATENDIDO`
    traz a fundamentacao da NR-6 e o encaminhamento a empresa contratante.

    **Nao ha versionamento por linha, e e deliberado.** `codigo` e unico
    (§3.2 do desenho), entao "nova versao desativa a anterior" nao caberia sem
    mudar o esquema — e nao precisa caber: o que protege a negativa ja emitida e
    `epi_requisicao_item.texto_recusa_snapshot` (RN-27), que congela o texto no
    ato da decisao. Versionar o catalogo seria um segundo mecanismo para a mesma
    garantia, e dois mecanismos para uma garantia e como ela deixa de valer.
    """

    __tablename__ = "epi_motivo_recusa"

    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(32), nullable=False)
    rotulo: Mapped[str] = mapped_column(String(80), nullable=False)
    # sai literal na guia impressa e na notificacao ao requerente
    texto: Mapped[str] = mapped_column(Text, nullable=False)
    base_normativa: Mapped[str | None] = mapped_column(String(120))
    exige_complemento: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dispositivo_conferido_em: Mapped[date | None] = mapped_column(DataPura)

    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_epi_motivo_recusa"),
        UniqueConstraint("codigo", name="uq_epi_motivo_recusa"),
    )


class EpiItem(Base):
    """O catalogo de EPI. Substitui `EPI_Cadastro`.

    O nome muda de proposito: "cadastro" nao diz de que.

    Nove das 22 colunas do legado nunca apareceram no formulario — e as quatro
    que governam a requisicao (`Qtd_Padrao`, `Qtd_Maxima`, `Exige_Justificativa`
    e a validade do CA) estao entre elas. Regra que ninguem consegue ver nao e
    regra, e armadilha: ou alguem editava a planilha a mao, ou a regra nunca
    rodou. Aqui todas tem campo na tela de `/epis/catalogo`.
    """

    __tablename__ = "epi_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    nome: Mapped[str] = mapped_column(String(180), nullable=False)
    descricao: Mapped[str | None] = mapped_column(Text)
    categoria_id: Mapped[int] = mapped_column(
        ForeignKey("epi_categoria.id", name="fk_epi_item_categoria"), nullable=False
    )

    codigo_ecampus: Mapped[str | None] = mapped_column(String(20))
    codigo_catmat: Mapped[str | None] = mapped_column(String(20))
    fabricante: Mapped[str | None] = mapped_column(String(120))
    marca: Mapped[str | None] = mapped_column(String(80))
    modelo: Mapped[str | None] = mapped_column(String(80))
    # ABNT NBR de referencia, uma por linha
    normas: Mapped[str | None] = mapped_column(Text)

    # CA de referencia do catalogo (o que o pregao especificou). O CA que vale
    # para bloquear a entrega e o do LOTE — ver `EpiEntradaEstoque`: um lote de
    # 2023 pode ter CA vencido enquanto o catalogo ja aponta para o CA renovado.
    exige_ca: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    numero_ca: Mapped[str | None] = mapped_column(String(10))
    validade_ca: Mapped[date | None] = mapped_column(DataPura)

    unidade_medida: Mapped[str] = mapped_column(
        String(20), nullable=False, default="UNIDADE"
    )
    # um tamanho por linha, na ordem — mesmo padrao de `ChecklistModelo.itens`
    tamanhos: Mapped[str | None] = mapped_column(Text)
    vida_util_meses: Mapped[int | None] = mapped_column(SmallInteger)

    quantidade_padrao: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=1
    )
    # "maxima" sem janela nao quer dizer nada: maxima por ano? por vida?
    quantidade_maxima: Mapped[int | None] = mapped_column(SmallInteger)
    periodo_maximo_meses: Mapped[int | None] = mapped_column(SmallInteger)

    exige_justificativa: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    exige_treinamento: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    atualizado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc, onupdate=agora_utc
    )

    categoria: Mapped[EpiCategoria] = relationship(lazy="selectin")

    __table_args__ = (
        CheckConstraint("quantidade_padrao > 0", name="ck_epi_qtd_padrao"),
        CheckConstraint(
            "quantidade_maxima IS NULL OR quantidade_maxima >= quantidade_padrao",
            name="ck_epi_qtd_maxima",
        ),
        # maxima sem janela e regra que ninguem sabe aplicar: "2 por ano" e
        # regra, "2" nao e nada (RN-26)
        CheckConstraint(
            "(quantidade_maxima IS NULL) = (periodo_maximo_meses IS NULL)",
            name="ck_epi_janela",
        ),
        # `NOT exige_ca`, e nao `exige_ca = 0`: no PostgreSQL — que e o dialeto
        # de referencia do projeto — booleano nao se compara com inteiro. Mesma
        # correcao que `ck_turma_presenca_coerente` ja carrega.
        CheckConstraint(
            "NOT exige_ca OR numero_ca IS NOT NULL", name="ck_epi_ca_obrigatorio"
        ),
        CheckConstraint("vida_util_meses IS NULL OR vida_util_meses > 0", name="ck_epi_vida_util"),
        PrimaryKeyConstraint("id", name="pk_epi_item"),
        UniqueConstraint("nome", "modelo", name="uq_epi_item"),
        Index("ix_epi_item_categoria", "categoria_id"),
        Index("ix_epi_item_ativo", "ativo"),
    )

    @property
    def lista_de_tamanhos(self) -> list[str]:
        return [t.strip() for t in (self.tamanhos or "").splitlines() if t.strip()]

    @property
    def lista_de_normas(self) -> list[str]:
        return [n.strip() for n in (self.normas or "").splitlines() if n.strip()]

    def ca_vencido_em(self, quando: date) -> bool:
        """Estado, calculado agora — nunca gravado.

        Vale para o CA de referencia do catalogo. Quem decide a entrega e o CA
        do LOTE (RN-25); este aqui serve para a tela dizer que o cadastro esta
        desatualizado antes de alguem descobrir na hora de entregar.
        """
        return self.validade_ca is not None and self.validade_ca < quando

    def ca_a_vencer_em(self, quando: date, dias: int = 60) -> bool:
        from datetime import timedelta

        if self.validade_ca is None or self.ca_vencido_em(quando):
            return False
        return self.validade_ca <= quando + timedelta(days=dias)

    @property
    def regra_de_quantidade(self) -> str:
        """Como a RN-26 se le na tela: "2 por 12 meses", ou "sem maximo"."""
        if self.quantidade_maxima is None:
            return "sem máximo"
        return f"{self.quantidade_maxima} por {self.periodo_maximo_meses} meses"


class EpiEntradaEstoque(Base):
    """O lote. Substitui `Estoque_Entradas`.

    O que o legado acertou e vem inteiro: pregao, item do pregao, empenho,
    fornecedor e valor. E rastreabilidade de compra publica, e e o que permite
    responder "esse capacete veio de qual empenho".

    O que muda: o legado tem `Qtd_Empenhada` e `Qtd_Estoque` como colunas
    mutaveis na linha da entrada — um saldo corrente que se sobrescreve. Duas
    entregas simultaneas perdem uma, e nao ha como reconciliar depois porque nao
    sobrou rastro do que baixou. Aqui a entrada e imutavel no que diz respeito a
    quantidade, e o saldo e a soma de `epi_movimento_estoque`.
    """

    __tablename__ = "epi_entrada_estoque"

    id: Mapped[int] = mapped_column(primary_key=True)
    epi_item_id: Mapped[int] = mapped_column(
        ForeignKey("epi_item.id", name="fk_epi_entrada_item"), nullable=False
    )
    tamanho: Mapped[str | None] = mapped_column(String(20))

    pregao: Mapped[str | None] = mapped_column(String(30))
    item_pregao: Mapped[str | None] = mapped_column(String(10))
    empenho: Mapped[str | None] = mapped_column(String(30))
    nota_fiscal: Mapped[str | None] = mapped_column(String(30))
    fornecedor_nome: Mapped[str | None] = mapped_column(String(160))
    # CNPJ e dado de pessoa JURIDICA: nao e dado pessoal, e nao colide com a
    # decisao 1 — o que nao entra em campo nenhum e CPF.
    fornecedor_cnpj: Mapped[str | None] = mapped_column(String(14))
    # Canal INSTITUCIONAL do fornecedor (telefone ou e-mail de vendas), e nao o
    # nome de um vendedor: quando o CA do lote vence ou o produto sai defeituoso,
    # e por aqui que se aciona quem entregou — e guardar o contato da empresa
    # basta para isso. O `Fornecedor_*` do legado trazia o campo; o §3.4 do
    # desenho o perdeu na transcricao, e sem ele a rastreabilidade de compra
    # publica para na nota fiscal.
    fornecedor_contato: Mapped[str | None] = mapped_column(String(120))

    data_entrada: Mapped[date] = mapped_column(DataPura, nullable=False)
    quantidade_empenhada: Mapped[int | None] = mapped_column(Integer)
    quantidade_recebida: Mapped[int] = mapped_column(Integer, nullable=False)
    valor_unitario: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))

    lote: Mapped[str | None] = mapped_column(String(40))
    # O CA que governa a entrega e ESTE, nao o do catalogo (RN-25).
    numero_ca: Mapped[str | None] = mapped_column(String(10))
    validade_ca: Mapped[date | None] = mapped_column(DataPura)
    data_fabricacao: Mapped[date | None] = mapped_column(DataPura)

    observacao: Mapped[str | None] = mapped_column(Text)
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    motivo_inativacao: Mapped[str | None] = mapped_column(Text)
    registrado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_entrada_registrado_por")
    )
    registrado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    item: Mapped[EpiItem] = relationship(lazy="selectin")

    __table_args__ = (
        CheckConstraint("quantidade_recebida > 0", name="ck_entrada_qtd"),
        CheckConstraint(
            "quantidade_empenhada IS NULL OR quantidade_empenhada >= quantidade_recebida",
            name="ck_entrada_empenho",
        ),
        # lote nao se exclui: inativa com motivo (RN-31). Booleano usado como
        # booleano, pelo mesmo motivo de `ck_epi_ca_obrigatorio`.
        CheckConstraint(
            "ativo OR motivo_inativacao IS NOT NULL", name="ck_entrada_inativa"
        ),
        PrimaryKeyConstraint("id", name="pk_epi_entrada_estoque"),
        Index("ix_entrada_item", "epi_item_id", "tamanho"),
        Index("ix_entrada_validade_ca", "validade_ca"),
        Index("ix_entrada_empenho", "empenho"),
    )


class EpiFichaRegistro(Base):
    """A ficha de EPI: o coracao juridico do modulo.

    Append-only — o banco recusa `UPDATE` e `DELETE` por trigger, no mesmo molde
    de `historico_evento` (CA-16). Correcao NUNCA e rasura: e linha nova de tipo
    `ESTORNO` apontando para a errada, com motivo. A linha errada continua la,
    visivel e marcada. E assim que documento de valor probatorio se corrige.

    Os `*_snapshot` sao a RN-15 aplicada ao EPI: se o catalogo mudar de "Luva
    nitrílica" para "Luva de procedimento" em 2027, uma entrega de 2024 nao pode
    passar a dizer outra coisa.

    `siape_snapshot` e `NOT NULL` de proposito: e o identificador congelado da
    pessoa no dia da entrega, e ele existe porque a decisao 3 garante que todo
    requisitante de EPI tem um. Se um dia estudante e bolsista entrarem, esta e
    uma das colunas que precisa afrouxar — e vale como medida do custo daquela
    decisao.
    """

    __tablename__ = "epi_ficha_registro"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True
    )
    servidor_id: Mapped[int] = mapped_column(
        ForeignKey("servidor.id", name="fk_epi_ficha_servidor"), nullable=False
    )
    epi_item_id: Mapped[int] = mapped_column(
        ForeignKey("epi_item.id", name="fk_epi_ficha_item"), nullable=False
    )
    # A FK entrou na fatia 4, quando `epi_requisicao_item` passou a existir
    # (revisao `c1d9e47a2b30`). Ate la a coluna era `Integer` puro: declarar a FK
    # antes seria escrever no esquema uma promessa que o banco nao consegue
    # cobrar. Continua anulavel — entrega de balcao nao tem requisicao formal.
    requisicao_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_requisicao_item.id", name="fk_epi_ficha_requisicao_item")
    )
    entrada_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_entrada_estoque.id", name="fk_epi_ficha_entrada")
    )

    tipo: Mapped[str] = mapped_column(String(14), nullable=False)
    quantidade: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    data_evento: Mapped[date] = mapped_column(DataPura, nullable=False)

    # --- congelado no evento: o catalogo de amanha nao reescreve isto ---
    nome_epi_snapshot: Mapped[str] = mapped_column(String(180), nullable=False)
    categoria_snapshot: Mapped[str] = mapped_column(String(80), nullable=False)
    numero_ca_snapshot: Mapped[str | None] = mapped_column(String(10))
    validade_ca_snapshot: Mapped[date | None] = mapped_column(DataPura)
    fabricante_snapshot: Mapped[str | None] = mapped_column(String(120))
    lote_snapshot: Mapped[str | None] = mapped_column(String(40))
    tamanho_snapshot: Mapped[str | None] = mapped_column(String(20))
    nome_servidor_snapshot: Mapped[str] = mapped_column(String(160), nullable=False)
    siape_snapshot: Mapped[str] = mapped_column(String(7), nullable=False)
    cargo_snapshot: Mapped[str | None] = mapped_column(String(120))
    unidade_snapshot: Mapped[str | None] = mapped_column(String(160))
    posto_snapshot: Mapped[str | None] = mapped_column(String(200))
    # o resto do contexto (empenho, pregao, valor, chefia, protocolo)
    contexto_congelado: Mapped[dict | None] = mapped_column(JSONTexto)

    previsao_troca: Mapped[date | None] = mapped_column(DataPura)
    entregue_por: Mapped[int] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_ficha_entregue_por"), nullable=False
    )
    # FK de verdade, e nao `Integer` solto como o desenho escreveu: `anexo` ja
    # existe, e as outras duas colunas de anexo do sistema
    # (`assinatura_instrutor.imagem_anexo_id`, `certificado.arquivo_pdf_anexo_id`)
    # usam FK. Coluna de anexo sem FK e ponteiro que o banco nao conserva.
    comprovante_anexo_id: Mapped[int | None] = mapped_column(
        ForeignKey("anexo.id", name="fk_epi_ficha_comprovante")
    )
    recebimento_confirmado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    motivo: Mapped[str | None] = mapped_column(Text)

    registro_estornado_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_ficha_registro.id", name="fk_epi_ficha_estornado")
    )
    # o evento da cadeia de hash que registrou esta linha: a prova fica a um
    # JOIN de distancia, e nao a uma busca por texto
    evento_id: Mapped[int | None] = mapped_column(
        ForeignKey("historico_evento.id", name="fk_epi_ficha_evento")
    )
    registrado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )

    servidor = relationship("Servidor", lazy="selectin")
    item: Mapped[EpiItem] = relationship(lazy="selectin")

    __table_args__ = (
        CheckConstraint(f"tipo IN ({_LISTA_TIPOS_FICHA})", name="ck_ficha_tipo"),
        CheckConstraint("quantidade > 0", name="ck_ficha_quantidade"),
        CheckConstraint(
            "tipo <> 'ESTORNO' OR (registro_estornado_id IS NOT NULL AND motivo IS NOT NULL)",
            name="ck_ficha_estorno",
        ),
        PrimaryKeyConstraint("id", name="pk_epi_ficha_registro"),
        Index("ix_ficha_servidor", "servidor_id", "data_evento"),
        Index("ix_ficha_item", "epi_item_id"),
        Index("ix_ficha_troca", "previsao_troca"),
    )


class EpiMovimentoEstoque(Base):
    """O livro razao do estoque. Append-only, como `historico_evento`.

    Saldo e SOMA de movimentos, nunca celula que se sobrescreve. Correcao e
    linha nova de tipo `AJUSTE` com motivo — nunca rasura.

    **Reserva nao e movimento.** Reservar nao tira nada da prateleira; tira da
    disponibilidade. Se a reserva entrasse no razao, o saldo fisico deixaria de
    bater com a contagem manual — que e justamente a conferencia que o razao
    existe para permitir. Entao:

    - `saldo_fisico(entrada)`  = SUM(epi_movimento_estoque.quantidade)
    - `reservado(entrada)`     = SUM(epi_requisicao_item.quantidade_reservada)
    - `disponivel(entrada)`    = fisico - reservado
    """

    __tablename__ = "epi_movimento_estoque"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True
    )
    entrada_id: Mapped[int] = mapped_column(
        ForeignKey("epi_entrada_estoque.id", name="fk_epi_movimento_entrada"),
        nullable=False,
    )
    tipo: Mapped[str] = mapped_column(String(12), nullable=False)
    # positiva para o que entra, negativa para o que sai. saldo = SUM(quantidade)
    quantidade: Mapped[int] = mapped_column(Integer, nullable=False)
    # FK desde a fatia 4 — ver o cabecalho do modulo
    requisicao_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_requisicao_item.id", name="fk_epi_movimento_requisicao_item")
    )
    ficha_registro_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_ficha_registro.id", name="fk_epi_movimento_ficha")
    )
    motivo: Mapped[str | None] = mapped_column(Text)
    ocorrido_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    registrado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_movimento_registrado_por")
    )

    __table_args__ = (
        CheckConstraint(f"tipo IN ({_LISTA_TIPOS_MOVIMENTO})", name="ck_mov_tipo"),
        CheckConstraint("quantidade <> 0", name="ck_mov_quantidade"),
        CheckConstraint(
            "(tipo IN ('ENTRADA','DEVOLUCAO') AND quantidade > 0) OR "
            "(tipo IN ('SAIDA','DESCARTE') AND quantidade < 0) OR tipo = 'AJUSTE'",
            name="ck_mov_sinal",
        ),
        # ajuste e descarte sem motivo sao saldo que sumiu sem explicacao
        CheckConstraint(
            "tipo NOT IN ('AJUSTE','DESCARTE') OR motivo IS NOT NULL",
            name="ck_mov_motivo",
        ),
        PrimaryKeyConstraint("id", name="pk_epi_movimento_estoque"),
        Index("ix_mov_entrada", "entrada_id"),
        Index("ix_mov_requisicao_item", "requisicao_item_id"),
    )


class EpiRequisicaoSequencia(Base):
    """A sequencia do protocolo `EPI-AAAA-NNNN`. Mesma disciplina da RN-03.

    Nunca `MAX(numero)+1`: duas requisicoes enviadas ao mesmo tempo leriam o
    mesmo maximo e receberiam o mesmo protocolo. O numero e consumido dentro da
    transacao imediata de quem chama (`app/servicos/numeracao.py`), e cancelar
    NAO devolve o numero — protocolo gasto e protocolo gasto, como no parecer e
    no certificado.
    """

    __tablename__ = "epi_requisicao_sequencia"

    ano: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ultimo_numero: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        PrimaryKeyConstraint("ano", name="pk_epi_requisicao_sequencia"),
    )


class EpiRequisicao(Base):
    """O envelope do pedido de EPI. Substitui `EPI_REQUISICOES`.

    **O protocolo nasce no ENVIO, nao na criacao.** Rascunho e o pedido em
    digitacao: nao e documento de ninguem, e e o unico estado que pode sumir de
    verdade (RN-31). Consumir numero na abertura da tela produziria buraco na
    sequencia a cada formulario abandonado — e buraco em numeracao de documento
    e a pergunta que a auditoria faz primeiro.

    **O snapshot de lotacao e congelado no envio**, pelo mesmo principio da
    RN-15 e do `cargo_snapshot` do parecer: a pessoa muda de setor, e o pedido
    nao. Um pedido decidido em novembro por causa do risco do laboratorio nao
    pode, em marco, passar a dizer que veio da secretaria — a fundamentacao da
    decisao ficaria descrevendo outro lugar.

    **Nao ha coluna de CPF, CID, diagnostico nem atestado** (decisao 1, RN-21).
    `descricao_atividade` e `riscos_declarados` sao texto livre e passam por
    `textos.exigir_texto_limpo` antes de qualquer gravacao (RN-30): o campo
    "rotina de trabalho e exposicao alegada" do legado e exatamente onde alguem
    escreve "tenho problema de coluna", e o sistema passaria a tratar dado de
    saude sem base legal.
    """

    __tablename__ = "epi_requisicao"

    id: Mapped[int] = mapped_column(primary_key=True)
    # `EPI-2026-0001`, para ler e citar. `numero` e `ano` sao o que a sequencia
    # controla: a RN-03 pula numero ja ocupado comparando INTEIRO com inteiro, e
    # nao ha como fazer isso contra um texto formatado.
    protocolo: Mapped[str | None] = mapped_column(String(16))
    numero: Mapped[int | None] = mapped_column(Integer)
    ano: Mapped[int | None] = mapped_column(Integer)

    servidor_id: Mapped[int] = mapped_column(
        ForeignKey("servidor.id", name="fk_epi_req_servidor"), nullable=False
    )
    # quem digitou. Pode ser a chefia ou a secretaria pedindo pelo servidor — e
    # e por isso que a RN-28 olha `servidor_id`, e nao esta coluna: o conflito
    # de interesse e de quem VAI USAR o equipamento.
    solicitado_por_id: Mapped[int] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_req_solicitado_por"), nullable=False
    )
    chefia_servidor_id: Mapped[int | None] = mapped_column(
        ForeignKey("servidor.id", name="fk_epi_req_chefia")
    )

    # --- congelado no ENVIO: a pessoa muda de setor, o pedido nao ---
    unidade_uorg_id: Mapped[int | None] = mapped_column(
        ForeignKey("unidade_uorg.id", name="fk_epi_req_unidade")
    )
    campus_id: Mapped[int | None] = mapped_column(
        ForeignKey("campus.id", name="fk_epi_req_campus")
    )
    posto_trabalho_id: Mapped[int | None] = mapped_column(
        ForeignKey("posto_trabalho.id", name="fk_epi_req_posto")
    )
    cargo_snapshot: Mapped[str | None] = mapped_column(String(120))
    funcao_snapshot: Mapped[str | None] = mapped_column(String(120))

    finalidade: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ROTINA"
    )
    descricao_atividade: Mapped[str | None] = mapped_column(Text)
    riscos_declarados: Mapped[str | None] = mapped_column(Text)
    urgencia: Mapped[str] = mapped_column(String(10), nullable=False, default="NORMAL")
    justificativa_urgencia: Mapped[str | None] = mapped_column(Text)

    estado: Mapped[str] = mapped_column(String(16), nullable=False, default="RASCUNHO")
    estado_anterior: Mapped[str | None] = mapped_column(String(16))
    entrou_no_estado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    analisado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_req_analisado_por")
    )
    analisado_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    parecer_analise: Mapped[str | None] = mapped_column(Text)
    motivo_recusa_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_motivo_recusa.id", name="fk_epi_req_motivo")
    )
    complemento_recusa: Mapped[str | None] = mapped_column(Text)
    motivo_cancelamento: Mapped[str | None] = mapped_column(Text)

    enviada_em: Mapped[datetime | None] = mapped_column(MomentoUTC)
    criado_em: Mapped[datetime] = mapped_column(
        MomentoUTC, nullable=False, default=agora_utc
    )
    versao: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    servidor = relationship("Servidor", foreign_keys=[servidor_id], lazy="selectin")
    chefia = relationship("Servidor", foreign_keys=[chefia_servidor_id], lazy="selectin")
    unidade = relationship("UnidadeUorg", lazy="selectin")
    motivo_recusa = relationship("EpiMotivoRecusa", lazy="selectin")
    itens: Mapped[list["EpiRequisicaoItem"]] = relationship(
        back_populates="requisicao", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        CheckConstraint(
            f"estado IN ({_LISTA_ESTADOS_REQUISICAO})", name="ck_req_estado"
        ),
        CheckConstraint(f"urgencia IN ({_LISTA_URGENCIAS})", name="ck_req_urgencia"),
        CheckConstraint(
            "urgencia <> 'URGENTE' OR justificativa_urgencia IS NOT NULL",
            name="ck_req_urgencia_justificada",
        ),
        CheckConstraint(
            f"finalidade IN ({_LISTA_FINALIDADES})", name="ck_req_finalidade"
        ),
        # rascunho e a unica coisa sem protocolo; tudo o mais ja foi protocolado
        CheckConstraint(
            "(estado = 'RASCUNHO') = (protocolo IS NULL)", name="ck_req_protocolo"
        ),
        # as tres colunas do protocolo andam juntas ou nao andam: `numero` sem
        # `protocolo` seria numero consumido que nao aparece em documento nenhum,
        # e o inverso seria protocolo que a sequencia nao consegue conferir
        CheckConstraint(
            "(protocolo IS NULL) = (numero IS NULL) AND "
            "(protocolo IS NULL) = (ano IS NULL)",
            name="ck_req_numero",
        ),
        CheckConstraint(
            "estado <> 'INDEFERIDA' OR motivo_recusa_id IS NOT NULL",
            name="ck_req_indeferida",
        ),
        CheckConstraint(
            "estado <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name="ck_req_cancelada",
        ),
        PrimaryKeyConstraint("id", name="pk_epi_requisicao"),
        UniqueConstraint("protocolo", name="uq_req_protocolo"),
        UniqueConstraint("ano", "numero", name="uq_req_numero"),
        Index("ix_req_estado", "estado"),
        Index("ix_req_servidor", "servidor_id"),
        Index("ix_req_unidade", "unidade_uorg_id"),
    )

    @property
    def encerrada(self) -> bool:
        from app.modelos.estados import EPI_REQUISICAO_ENCERRADA

        return self.estado in EPI_REQUISICAO_ENCERRADA

    @property
    def identificacao(self) -> str:
        """`EPI-2026-0001`, ou `Rascunho #12` enquanto nao houver protocolo."""
        return self.protocolo or f"Rascunho #{self.id}"


class EpiRequisicaoItem(Base):
    """A linha do pedido — e onde a decisao acontece.

    **Quatro quantidades e um estado, no lugar de doze colunas.** O legado tem
    quantidade requisitada, aprovada, recusada, reservada, liberada e entregue,
    cada uma com sua data e seu responsavel: doze colunas para representar seis
    transicoes, das quais duas sao derivaveis (recusada = solicitada - aprovada;
    liberada e a reserva vista do outro lado) e todas podem se contradizer entre
    si sem que nada reclame. Aqui quem, quando e por que saem da trilha de
    auditoria, que e append-only e encadeada — e que a planilha nao tinha.
    """

    __tablename__ = "epi_requisicao_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    requisicao_id: Mapped[int] = mapped_column(
        ForeignKey("epi_requisicao.id", name="fk_epi_req_item_req", ondelete="CASCADE"),
        nullable=False,
    )
    epi_item_id: Mapped[int] = mapped_column(
        ForeignKey("epi_item.id", name="fk_epi_req_item_epi"), nullable=False
    )
    tamanho: Mapped[str | None] = mapped_column(String(20))

    quantidade_solicitada: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    quantidade_aprovada: Mapped[int | None] = mapped_column(SmallInteger)
    quantidade_reservada: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0
    )
    quantidade_entregue: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0
    )
    entrada_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_entrada_estoque.id", name="fk_epi_req_item_entrada")
    )

    justificativa: Mapped[str | None] = mapped_column(Text)
    # excedeu quantidade_maxima e alguem autorizou assumindo o nome (RN-26).
    # Precedente no sistema: `excecao_art9_par_unico` + `justificativa_art9` em
    # `exposicao`, com o evento `EXCECAO_ART9_APLICADA`.
    excedeu_maximo: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    autorizado_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_req_item_autorizado_por")
    )

    estado: Mapped[str] = mapped_column(String(14), nullable=False, default="SOLICITADO")
    motivo_recusa_id: Mapped[int | None] = mapped_column(
        ForeignKey("epi_motivo_recusa.id", name="fk_epi_req_item_motivo")
    )
    complemento_recusa: Mapped[str | None] = mapped_column(Text)
    # texto do motivo congelado na decisao: editar o catalogo depois nao
    # reescreve a negativa que o requerente ja recebeu (RN-27, RN-15)
    texto_recusa_snapshot: Mapped[str | None] = mapped_column(Text)
    decidido_por: Mapped[int | None] = mapped_column(
        ForeignKey("usuario.id", name="fk_epi_req_item_decidido_por")
    )
    decidido_em: Mapped[datetime | None] = mapped_column(MomentoUTC)

    requisicao: Mapped[EpiRequisicao] = relationship(back_populates="itens")
    item: Mapped[EpiItem] = relationship(lazy="selectin")
    motivo_recusa = relationship("EpiMotivoRecusa", lazy="selectin")

    __table_args__ = (
        UniqueConstraint("requisicao_id", "epi_item_id", "tamanho", name="uq_req_item"),
        CheckConstraint(f"estado IN ({_LISTA_ESTADOS_ITEM})", name="ck_req_item_estado"),
        CheckConstraint("quantidade_solicitada > 0", name="ck_item_solicitada"),
        # aprovar so reduz: aprovar MAIS do que se pediu seria o setor decidindo
        # sozinho o que a pessoa vai receber, sem que ela tenha pedido
        CheckConstraint(
            "quantidade_aprovada IS NULL OR "
            "(quantidade_aprovada >= 0 AND quantidade_aprovada <= quantidade_solicitada)",
            name="ck_item_aprovada",
        ),
        CheckConstraint(
            "quantidade_entregue <= COALESCE(quantidade_aprovada, quantidade_solicitada)",
            name="ck_item_entregue",
        ),
        CheckConstraint(
            "quantidade_reservada <= COALESCE(quantidade_aprovada, quantidade_solicitada)",
            name="ck_item_reservada",
        ),
        CheckConstraint(
            "estado <> 'RECUSADO' OR "
            "(motivo_recusa_id IS NOT NULL AND texto_recusa_snapshot IS NOT NULL)",
            name="ck_item_recusado",
        ),
        # `NOT excedeu_maximo`, e nao `excedeu_maximo = 0`: no PostgreSQL — que e
        # o dialeto de referencia do projeto — booleano nao se compara com
        # inteiro. Mesma correcao que `ck_epi_ca_obrigatorio` e
        # `ck_entrada_inativa` ja carregam.
        CheckConstraint(
            "NOT excedeu_maximo OR "
            "(autorizado_por IS NOT NULL AND justificativa IS NOT NULL)",
            name="ck_item_excecao",
        ),
        CheckConstraint(
            "estado <> 'RESERVADO' OR entrada_id IS NOT NULL", name="ck_item_lote"
        ),
        PrimaryKeyConstraint("id", name="pk_epi_requisicao_item"),
        Index("ix_req_item_estado", "estado"),
        Index("ix_req_item_reserva", "entrada_id", "estado"),
        Index("ix_req_item_motivo", "motivo_recusa_id"),
    )

    @property
    def quantidade_devida(self) -> int:
        """Quanto ainda falta entregar deste item. Zero quando nada foi aprovado."""
        return max(0, (self.quantidade_aprovada or 0) - self.quantidade_entregue)

    @property
    def decidido(self) -> bool:
        from app.modelos.estados import EPI_ITEM_DECIDIDO

        return self.estado in EPI_ITEM_DECIDIDO


__all__ = [
    "FINALIDADES_REQUISICAO",
    "TIPOS_FICHA",
    "TIPOS_MOVIMENTO",
    "UNIDADES_MEDIDA",
    "URGENCIAS_REQUISICAO",
    "EpiCategoria",
    "EpiEntradaEstoque",
    "EpiFichaRegistro",
    "EpiItem",
    "EpiMotivoRecusa",
    "EpiMovimentoEstoque",
    "EpiRequisicao",
    "EpiRequisicaoItem",
    "EpiRequisicaoSequencia",
]
