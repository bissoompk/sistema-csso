"""epi: catalogo, estoque e ficha

Modulo Gestao de EPI. Cria de uma vez `epi_categoria`, `epi_motivo_recusa`,
`epi_item`, `epi_entrada_estoque`, `epi_ficha_registro` e
`epi_movimento_estoque`, mais as travas append-only da ficha e do razao.

**Por que seis tabelas numa migracao so, se as telas saem em tres entregas.**
O desenho fatia o modulo em catalogo -> ficha -> estoque, com um argumento que
se subscreve ("a prova vale mais que o saldo"). O grafo de FK vai na direcao
contraria: `epi_ficha_registro` aponta para `epi_entrada_estoque` (fatia 3) e
para `epi_requisicao_item` (fatia 4). Criada sozinha na fatia 2, ela
referenciaria tabela inexistente — e o SQLite **aceita** o `CREATE TABLE`, e o
`PRAGMA foreign_key_check` do `env.py` **nao pega**, porque a tabela esta vazia.
O erro so apareceria no primeiro registro de entrega, que e justamente a linha
que o modulo existe para provar. Ver §3.4 do `04_PLANO_CONSOLIDADO.md`: migracao
nao e fatia. Tabela vazia nao custa nada; FK orfa custa um dia.

`requisicao_item_id` — nas duas tabelas onde aparece — nasce `Integer` **sem**
FK, pelo mesmo motivo: `epi_requisicao_item` so existe na fatia 4, e a FK real
entra la, por `batch_alter_table`.

Cinco coisas foram corrigidas a mao no que o `--autogenerate` produziu, todas
reincidentes:

1. **Faltava `import app.modelos.base`.** O arquivo gerado usa
   `app.modelos.base.DataPura()`, `.MomentoUTC()` e `.JSONTexto()` e nunca
   importa o modulo — `NameError` no primeiro `upgrade`. E a quarta migracao
   seguida em que o gerador comete o mesmo esquecimento.
2. **Os treze indices em `batch_alter_table`.** Trocados por `op.create_index`
   direto: `batch` existe para o `ALTER` que o SQLite nao tem, e criar indice em
   tabela recem-criada nao precisa de copia de tabela nenhuma.
3. **A ordem do `downgrade`.** O gerado ja veio na ordem topologica inversa
   (movimento -> ficha -> entrada -> item -> motivo -> categoria); conferida e
   mantida, porque derrubar `epi_entrada_estoque` antes de `epi_ficha_registro`
   deixaria referencia orfa e o `_fk_suspensas` do `env.py` abortaria.
4. **As travas append-only**, que o autogenerate nao ve: `epi_ficha_registro` e
   `epi_movimento_estoque` recusam `UPDATE` e `DELETE` por trigger, no mesmo
   molde de `historico_evento` (CA-16, RN-31). Elas nascem com o esquema, e nao
   com a tela que escreve nessas tabelas — uma tabela append-only que passa um
   mes aceitando `UPDATE` e uma tabela cujo historico ninguem consegue mais
   afirmar que esta intacto.
5. **Os comentarios `### commands auto generated ###`**, trocados pelo texto que
   explica por que cada CHECK esta escrita daquele jeito.

Nao ha ciclo de FK entre as tabelas novas — `registro_estornado_id` e
autorreferente, e o SQLite embute a FK no proprio `CREATE TABLE`. Conferido:
`create_all`/`drop_all` seguem sem aviso de ordenacao, `alembic check` fica
limpo, e o DDL desta migracao sai igual ao do `create_all`.

Revision ID: 0ce5a3128c79
Revises: 442dd16889a5
Create Date: 2026-08-18 00:23:57.600914+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura/MomentoUTC/JSONTexto)
from app.banco import TRIGGERS_EPI

revision: str = '0ce5a3128c79'
down_revision: str | None = '442dd16889a5'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'epi_categoria',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('codigo', sa.String(length=24), nullable=False),
        sa.Column('nome', sa.String(length=80), nullable=False),
        sa.Column('referencia_nr6', sa.String(length=12), nullable=True),
        sa.Column('ordem', sa.SmallInteger(), nullable=False),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('id', name='pk_epi_categoria'),
        sa.UniqueConstraint('codigo', name='uq_epi_categoria'),
    )

    op.create_table(
        'epi_motivo_recusa',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('codigo', sa.String(length=32), nullable=False),
        sa.Column('rotulo', sa.String(length=80), nullable=False),
        sa.Column('texto', sa.Text(), nullable=False),
        sa.Column('base_normativa', sa.String(length=120), nullable=True),
        sa.Column('exige_complemento', sa.Boolean(), nullable=False),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.Column(
            'dispositivo_conferido_em', app.modelos.base.DataPura(), nullable=True
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_motivo_recusa'),
        sa.UniqueConstraint('codigo', name='uq_epi_motivo_recusa'),
    )

    op.create_table(
        'epi_item',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('nome', sa.String(length=180), nullable=False),
        sa.Column('descricao', sa.Text(), nullable=True),
        sa.Column('categoria_id', sa.Integer(), nullable=False),
        sa.Column('codigo_ecampus', sa.String(length=20), nullable=True),
        sa.Column('codigo_catmat', sa.String(length=20), nullable=True),
        sa.Column('fabricante', sa.String(length=120), nullable=True),
        sa.Column('marca', sa.String(length=80), nullable=True),
        sa.Column('modelo', sa.String(length=80), nullable=True),
        sa.Column('normas', sa.Text(), nullable=True),
        sa.Column('exige_ca', sa.Boolean(), nullable=False),
        sa.Column('numero_ca', sa.String(length=10), nullable=True),
        sa.Column('validade_ca', app.modelos.base.DataPura(), nullable=True),
        sa.Column('unidade_medida', sa.String(length=20), nullable=False),
        sa.Column('tamanhos', sa.Text(), nullable=True),
        sa.Column('vida_util_meses', sa.SmallInteger(), nullable=True),
        sa.Column('quantidade_padrao', sa.SmallInteger(), nullable=False),
        sa.Column('quantidade_maxima', sa.SmallInteger(), nullable=True),
        sa.Column('periodo_maximo_meses', sa.SmallInteger(), nullable=True),
        sa.Column('exige_justificativa', sa.Boolean(), nullable=False),
        sa.Column('exige_treinamento', sa.Boolean(), nullable=False),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('atualizado_em', app.modelos.base.MomentoUTC(), nullable=False),
        # RN-26: maxima sem janela e regra que ninguem sabe aplicar. "2 por ano"
        # e regra; "2" sozinho nao quer dizer nada.
        sa.CheckConstraint(
            '(quantidade_maxima IS NULL) = (periodo_maximo_meses IS NULL)',
            name='ck_epi_janela',
        ),
        # RN-25 comeca aqui: item que exige CA sem numero de CA e item que a
        # entrega nao sabe conferir. `NOT exige_ca`, e nao `exige_ca = 0`,
        # porque no PostgreSQL booleano nao se compara com inteiro.
        sa.CheckConstraint(
            'NOT exige_ca OR numero_ca IS NOT NULL', name='ck_epi_ca_obrigatorio'
        ),
        sa.CheckConstraint(
            'quantidade_maxima IS NULL OR quantidade_maxima >= quantidade_padrao',
            name='ck_epi_qtd_maxima',
        ),
        sa.CheckConstraint('quantidade_padrao > 0', name='ck_epi_qtd_padrao'),
        # vida util de zero mes faria a RN-32 calcular troca devida no dia da
        # entrega — e o que se quer dizer com isso e "nao tem vida util", que e
        # o NULL
        sa.CheckConstraint(
            'vida_util_meses IS NULL OR vida_util_meses > 0', name='ck_epi_vida_util'
        ),
        sa.ForeignKeyConstraint(
            ['categoria_id'], ['epi_categoria.id'], name='fk_epi_item_categoria'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_item'),
        sa.UniqueConstraint('nome', 'modelo', name='uq_epi_item'),
    )
    op.create_index('ix_epi_item_ativo', 'epi_item', ['ativo'])
    op.create_index('ix_epi_item_categoria', 'epi_item', ['categoria_id'])

    op.create_table(
        'epi_entrada_estoque',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('epi_item_id', sa.Integer(), nullable=False),
        sa.Column('tamanho', sa.String(length=20), nullable=True),
        sa.Column('pregao', sa.String(length=30), nullable=True),
        sa.Column('item_pregao', sa.String(length=10), nullable=True),
        sa.Column('empenho', sa.String(length=30), nullable=True),
        sa.Column('nota_fiscal', sa.String(length=30), nullable=True),
        sa.Column('fornecedor_nome', sa.String(length=160), nullable=True),
        sa.Column('fornecedor_cnpj', sa.String(length=14), nullable=True),
        sa.Column('data_entrada', app.modelos.base.DataPura(), nullable=False),
        sa.Column('quantidade_empenhada', sa.Integer(), nullable=True),
        sa.Column('quantidade_recebida', sa.Integer(), nullable=False),
        sa.Column('valor_unitario', sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column('lote', sa.String(length=40), nullable=True),
        sa.Column('numero_ca', sa.String(length=10), nullable=True),
        sa.Column('validade_ca', app.modelos.base.DataPura(), nullable=True),
        sa.Column('data_fabricacao', app.modelos.base.DataPura(), nullable=True),
        sa.Column('observacao', sa.Text(), nullable=True),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.Column('motivo_inativacao', sa.Text(), nullable=True),
        sa.Column('registrado_por', sa.Integer(), nullable=True),
        sa.Column('registrado_em', app.modelos.base.MomentoUTC(), nullable=False),
        # RN-31: lote nao se exclui, inativa com motivo. Lote que some sem
        # explicacao e saldo que ninguem consegue reconciliar depois.
        sa.CheckConstraint(
            'ativo OR motivo_inativacao IS NOT NULL', name='ck_entrada_inativa'
        ),
        sa.CheckConstraint(
            'quantidade_empenhada IS NULL OR '
            'quantidade_empenhada >= quantidade_recebida',
            name='ck_entrada_empenho',
        ),
        sa.CheckConstraint('quantidade_recebida > 0', name='ck_entrada_qtd'),
        sa.ForeignKeyConstraint(
            ['epi_item_id'], ['epi_item.id'], name='fk_epi_entrada_item'
        ),
        sa.ForeignKeyConstraint(
            ['registrado_por'], ['usuario.id'], name='fk_epi_entrada_registrado_por'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_entrada_estoque'),
    )
    op.create_index('ix_entrada_empenho', 'epi_entrada_estoque', ['empenho'])
    op.create_index('ix_entrada_item', 'epi_entrada_estoque', ['epi_item_id', 'tamanho'])
    op.create_index('ix_entrada_validade_ca', 'epi_entrada_estoque', ['validade_ca'])

    op.create_table(
        'epi_ficha_registro',
        sa.Column(
            'id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False
        ),
        sa.Column('servidor_id', sa.Integer(), nullable=False),
        sa.Column('epi_item_id', sa.Integer(), nullable=False),
        # sem FK ate a fatia 4 — ver o cabecalho
        sa.Column('requisicao_item_id', sa.Integer(), nullable=True),
        sa.Column('entrada_id', sa.Integer(), nullable=True),
        sa.Column('tipo', sa.String(length=14), nullable=False),
        sa.Column('quantidade', sa.SmallInteger(), nullable=False),
        sa.Column('data_evento', app.modelos.base.DataPura(), nullable=False),
        sa.Column('nome_epi_snapshot', sa.String(length=180), nullable=False),
        sa.Column('categoria_snapshot', sa.String(length=80), nullable=False),
        sa.Column('numero_ca_snapshot', sa.String(length=10), nullable=True),
        sa.Column('validade_ca_snapshot', app.modelos.base.DataPura(), nullable=True),
        sa.Column('fabricante_snapshot', sa.String(length=120), nullable=True),
        sa.Column('lote_snapshot', sa.String(length=40), nullable=True),
        sa.Column('tamanho_snapshot', sa.String(length=20), nullable=True),
        sa.Column('nome_servidor_snapshot', sa.String(length=160), nullable=False),
        # NOT NULL de proposito: e o identificador congelado da pessoa no dia da
        # entrega, e ele existe porque a decisao 3 garante que todo requisitante
        # de EPI tem SIAPE. Se estudante e bolsista entrarem um dia, esta e uma
        # das colunas que precisa afrouxar — e vale como medida do custo.
        sa.Column('siape_snapshot', sa.String(length=7), nullable=False),
        sa.Column('cargo_snapshot', sa.String(length=120), nullable=True),
        sa.Column('unidade_snapshot', sa.String(length=160), nullable=True),
        sa.Column('posto_snapshot', sa.String(length=200), nullable=True),
        sa.Column('contexto_congelado', app.modelos.base.JSONTexto(), nullable=True),
        sa.Column('previsao_troca', app.modelos.base.DataPura(), nullable=True),
        sa.Column('entregue_por', sa.Integer(), nullable=False),
        sa.Column('comprovante_anexo_id', sa.Integer(), nullable=True),
        sa.Column(
            'recebimento_confirmado_em', app.modelos.base.MomentoUTC(), nullable=True
        ),
        sa.Column('motivo', sa.Text(), nullable=True),
        sa.Column(
            'registro_estornado_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            nullable=True,
        ),
        sa.Column(
            'evento_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            nullable=True,
        ),
        sa.Column('registrado_em', app.modelos.base.MomentoUTC(), nullable=False),
        # correcao NUNCA e rasura: e linha nova apontando para a errada, com
        # motivo. Estorno sem uma das duas coisas e a rasura de volta.
        sa.CheckConstraint(
            "tipo <> 'ESTORNO' OR "
            '(registro_estornado_id IS NOT NULL AND motivo IS NOT NULL)',
            name='ck_ficha_estorno',
        ),
        sa.CheckConstraint(
            "tipo IN ('ENTREGA','DEVOLUCAO','SUBSTITUICAO','DESCARTE','ESTORNO')",
            name='ck_ficha_tipo',
        ),
        sa.CheckConstraint('quantidade > 0', name='ck_ficha_quantidade'),
        sa.ForeignKeyConstraint(
            ['comprovante_anexo_id'], ['anexo.id'], name='fk_epi_ficha_comprovante'
        ),
        sa.ForeignKeyConstraint(
            ['entrada_id'], ['epi_entrada_estoque.id'], name='fk_epi_ficha_entrada'
        ),
        sa.ForeignKeyConstraint(
            ['entregue_por'], ['usuario.id'], name='fk_epi_ficha_entregue_por'
        ),
        sa.ForeignKeyConstraint(
            ['epi_item_id'], ['epi_item.id'], name='fk_epi_ficha_item'
        ),
        # a prova fica a um JOIN de distancia do evento que a registrou, e nao a
        # uma busca por texto na trilha
        sa.ForeignKeyConstraint(
            ['evento_id'], ['historico_evento.id'], name='fk_epi_ficha_evento'
        ),
        sa.ForeignKeyConstraint(
            ['registro_estornado_id'],
            ['epi_ficha_registro.id'],
            name='fk_epi_ficha_estornado',
        ),
        sa.ForeignKeyConstraint(
            ['servidor_id'], ['servidor.id'], name='fk_epi_ficha_servidor'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_ficha_registro'),
    )
    op.create_index('ix_ficha_item', 'epi_ficha_registro', ['epi_item_id'])
    op.create_index(
        'ix_ficha_servidor', 'epi_ficha_registro', ['servidor_id', 'data_evento']
    )
    op.create_index('ix_ficha_troca', 'epi_ficha_registro', ['previsao_troca'])

    op.create_table(
        'epi_movimento_estoque',
        sa.Column(
            'id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False
        ),
        sa.Column('entrada_id', sa.Integer(), nullable=False),
        sa.Column('tipo', sa.String(length=12), nullable=False),
        # positiva para o que entra, negativa para o que sai: o saldo e
        # SUM(quantidade), nunca uma celula que se sobrescreve
        sa.Column('quantidade', sa.Integer(), nullable=False),
        # sem FK ate a fatia 4 — ver o cabecalho
        sa.Column('requisicao_item_id', sa.Integer(), nullable=True),
        sa.Column(
            'ficha_registro_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            nullable=True,
        ),
        sa.Column('motivo', sa.Text(), nullable=True),
        sa.Column('ocorrido_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('registrado_por', sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "(tipo IN ('ENTRADA','DEVOLUCAO') AND quantidade > 0) OR "
            "(tipo IN ('SAIDA','DESCARTE') AND quantidade < 0) OR tipo = 'AJUSTE'",
            name='ck_mov_sinal',
        ),
        sa.CheckConstraint(
            "tipo IN ('ENTRADA','SAIDA','DEVOLUCAO','DESCARTE','AJUSTE')",
            name='ck_mov_tipo',
        ),
        # ajuste e descarte sem motivo sao saldo que sumiu sem explicacao
        sa.CheckConstraint(
            "tipo NOT IN ('AJUSTE','DESCARTE') OR motivo IS NOT NULL",
            name='ck_mov_motivo',
        ),
        sa.CheckConstraint('quantidade <> 0', name='ck_mov_quantidade'),
        sa.ForeignKeyConstraint(
            ['entrada_id'],
            ['epi_entrada_estoque.id'],
            name='fk_epi_movimento_entrada',
        ),
        sa.ForeignKeyConstraint(
            ['ficha_registro_id'],
            ['epi_ficha_registro.id'],
            name='fk_epi_movimento_ficha',
        ),
        sa.ForeignKeyConstraint(
            ['registrado_por'], ['usuario.id'], name='fk_epi_movimento_registrado_por'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_movimento_estoque'),
    )
    op.create_index('ix_mov_entrada', 'epi_movimento_estoque', ['entrada_id'])
    op.create_index(
        'ix_mov_requisicao_item', 'epi_movimento_estoque', ['requisicao_item_id']
    )

    # RN-31 — nada se apaga. As duas tabelas de prova recusam UPDATE e DELETE,
    # como `historico_evento` ja faz.
    for nome, ddl in TRIGGERS_EPI:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")
        op.execute(ddl)


def downgrade() -> None:
    # Inverso exato do upgrade: primeiro as travas (que impediriam qualquer
    # escrita), depois os indices, e as tabelas na ordem topologica inversa —
    # `epi_movimento_estoque` referencia `epi_ficha_registro`, que referencia
    # `epi_entrada_estoque`, que referencia `epi_item`.
    for nome, _ in TRIGGERS_EPI:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")

    op.drop_index('ix_mov_requisicao_item', table_name='epi_movimento_estoque')
    op.drop_index('ix_mov_entrada', table_name='epi_movimento_estoque')
    op.drop_table('epi_movimento_estoque')

    op.drop_index('ix_ficha_troca', table_name='epi_ficha_registro')
    op.drop_index('ix_ficha_servidor', table_name='epi_ficha_registro')
    op.drop_index('ix_ficha_item', table_name='epi_ficha_registro')
    op.drop_table('epi_ficha_registro')

    op.drop_index('ix_entrada_validade_ca', table_name='epi_entrada_estoque')
    op.drop_index('ix_entrada_item', table_name='epi_entrada_estoque')
    op.drop_index('ix_entrada_empenho', table_name='epi_entrada_estoque')
    op.drop_table('epi_entrada_estoque')

    op.drop_index('ix_epi_item_categoria', table_name='epi_item')
    op.drop_index('ix_epi_item_ativo', table_name='epi_item')
    op.drop_table('epi_item')

    op.drop_table('epi_motivo_recusa')
    op.drop_table('epi_categoria')
