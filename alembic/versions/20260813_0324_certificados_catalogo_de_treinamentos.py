"""certificados: catalogo de treinamentos

Fatia 1 do modulo Certificados e Treinamentos: o que se ensina
(`treinamento`), o layout do papel que sai no fim (`certificado_modelo` e
`certificado_modelo_tag`) e quem assina (`assinatura_instrutor`). Turma,
inscricao, presenca e certificado vem nas fatias seguintes.

Duas coisas foram ajustadas a mao no que o autogenerate produziu:

1. **A ordem de criacao.** `treinamento` e `certificado_modelo` se referenciam
   mutuamente — o treinamento aponta para o modelo vigente e o modelo aponta
   para o treinamento a que serve. O SQLite resolve FK preguicosamente e
   aceitaria qualquer ordem, mas o DDL de referencia deste projeto e
   PostgreSQL, onde referenciar tabela inexistente falha. Por isso
   `treinamento` nasce sem a FK do modelo vigente e ela e acrescentada no fim,
   depois que `certificado_modelo` existe.
2. **Os nomes das constraints.** FK e UNIQUE sem nome viram nome gerado pelo
   banco, e nome gerado nao se derruba numa migracao futura.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura/MomentoUTC)

revision: str = 'ec4cbec9f658'
down_revision: str | None = 'a652091b8419'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'assinatura_instrutor',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('servidor_id', sa.Integer(), nullable=True),
        sa.Column('nome', sa.String(length=160), nullable=False),
        sa.Column('titulo', sa.String(length=120), nullable=True),
        sa.Column('conselho', sa.String(length=8), nullable=True),
        sa.Column('registro_conselho', sa.String(length=30), nullable=True),
        sa.Column('organizacao', sa.String(length=160), nullable=True),
        sa.Column('externo', sa.Boolean(), nullable=False),
        sa.Column('imagem_anexo_id', sa.Integer(), nullable=True),
        sa.Column('vigencia_inicio', app.modelos.base.DataPura(), nullable=False),
        sa.Column('vigencia_fim', app.modelos.base.DataPura(), nullable=True),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            'externo = 1 OR servidor_id IS NOT NULL', name='ck_assinatura_vinculo'
        ),
        sa.CheckConstraint(
            'vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio',
            name='ck_assinatura_periodo',
        ),
        sa.ForeignKeyConstraint(
            ['imagem_anexo_id'], ['anexo.id'], name='fk_assinatura_imagem'
        ),
        sa.ForeignKeyConstraint(
            ['servidor_id'], ['servidor.id'], name='fk_assinatura_servidor'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_assinatura_instrutor'),
    )
    op.create_index('ix_assinatura_ativo', 'assinatura_instrutor', ['ativo'])

    # sem a FK do modelo vigente: `certificado_modelo` ainda nao existe
    op.create_table(
        'treinamento',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('codigo', sa.String(length=30), nullable=False),
        sa.Column('nome', sa.String(length=160), nullable=False),
        sa.Column(
            'carga_horaria_horas', sa.Numeric(precision=5, scale=1), nullable=False
        ),
        sa.Column('conteudo_programatico', sa.Text(), nullable=True),
        sa.Column('validade_meses', sa.Integer(), nullable=False),
        sa.Column('norma_referencia', sa.String(length=120), nullable=True),
        sa.Column('obrigatorio', sa.Boolean(), nullable=False),
        sa.Column('modelo_vigente_id', sa.Integer(), nullable=True),
        sa.Column('instrutor_padrao_id', sa.Integer(), nullable=True),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.CheckConstraint('carga_horaria_horas > 0', name='ck_treinamento_carga'),
        sa.CheckConstraint('validade_meses >= 0', name='ck_treinamento_validade'),
        sa.ForeignKeyConstraint(
            ['instrutor_padrao_id'],
            ['assinatura_instrutor.id'],
            name='fk_treinamento_instrutor_padrao',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_treinamento'),
        sa.UniqueConstraint('codigo', name='uq_treinamento_codigo'),
        sa.UniqueConstraint('nome', name='uq_treinamento_nome'),
    )
    op.create_index('ix_treinamento_ativo', 'treinamento', ['ativo'])

    op.create_table(
        'certificado_modelo',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('treinamento_id', sa.Integer(), nullable=True),
        sa.Column('nome', sa.String(length=120), nullable=False),
        sa.Column('arquivo', sa.String(length=120), nullable=False),
        sa.Column('arquivo_sha256', sa.String(length=64), nullable=True),
        sa.Column('orientacao', sa.String(length=10), nullable=False),
        sa.Column('versao', sa.Integer(), nullable=False),
        sa.Column('vigente', sa.Boolean(), nullable=False),
        sa.Column('observacao', sa.Text(), nullable=True),
        sa.Column('criado_por', sa.Integer(), nullable=True),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.CheckConstraint(
            "orientacao IN ('PAISAGEM','RETRATO')", name='ck_modelo_orientacao'
        ),
        sa.CheckConstraint('versao >= 1', name='ck_modelo_versao'),
        sa.ForeignKeyConstraint(
            ['criado_por'], ['usuario.id'], name='fk_certificado_modelo_criado_por'
        ),
        sa.ForeignKeyConstraint(
            ['treinamento_id'],
            ['treinamento.id'],
            name='fk_certificado_modelo_treinamento',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_certificado_modelo'),
        sa.UniqueConstraint(
            'treinamento_id', 'nome', 'versao', name='uq_certificado_modelo'
        ),
    )

    op.create_table(
        'certificado_modelo_tag',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('modelo_id', sa.Integer(), nullable=False),
        sa.Column('marcador', sa.String(length=60), nullable=False),
        sa.Column('campo', sa.String(length=60), nullable=False),
        sa.Column('ordem', sa.SmallInteger(), nullable=False),
        sa.Column('obrigatorio', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ['modelo_id'],
            ['certificado_modelo.id'],
            name='fk_modelo_tag_modelo',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_certificado_modelo_tag'),
        sa.UniqueConstraint('modelo_id', 'marcador', name='uq_modelo_tag'),
    )
    op.create_index('ix_modelo_tag_campo', 'certificado_modelo_tag', ['campo'])

    # fecha o ciclo agora que as duas tabelas existem. No SQLite o batch
    # recria `treinamento` (o env.py suspende as FKs para isso e confere
    # `PRAGMA foreign_key_check` no fim); no PostgreSQL sai um ALTER simples.
    with op.batch_alter_table('treinamento', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_treinamento_modelo_vigente',
            'certificado_modelo',
            ['modelo_vigente_id'],
            ['id'],
        )


def downgrade() -> None:
    with op.batch_alter_table('treinamento', schema=None) as batch_op:
        batch_op.drop_constraint('fk_treinamento_modelo_vigente', type_='foreignkey')

    op.drop_index('ix_modelo_tag_campo', table_name='certificado_modelo_tag')
    op.drop_table('certificado_modelo_tag')
    op.drop_table('certificado_modelo')
    op.drop_index('ix_treinamento_ativo', table_name='treinamento')
    op.drop_table('treinamento')
    op.drop_index('ix_assinatura_ativo', table_name='assinatura_instrutor')
    op.drop_table('assinatura_instrutor')
