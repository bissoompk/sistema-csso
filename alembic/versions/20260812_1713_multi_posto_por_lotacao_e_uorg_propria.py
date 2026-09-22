"""multi posto por lotacao e uorg propria

O servidor pode atender mais de um posto ao mesmo tempo — foi o caso do parecer
1/2025 (LEAC e Laboratório de Doenças Infecciosas e Parasitárias). O posto sai
de coluna única em `servidor_lotacao` e vira a tabela `lotacao_posto`.

A UORG deixa de ser derivada da Unidade e ganha coluna própria: são campos
diferentes no parecer (a Unidade é o lugar, a UORG é o código de lotação no
SIAPE) e nem sempre apontam para o mesmo nível. `uorg_id` nulo significa
"usar a própria Unidade", que é exatamente o comportamento anterior — por isso
não há backfill.

Revision ID: a652091b8419
Revises: b4a719a434de
Create Date: 2026-08-12 17:13:22.138459+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a652091b8419'
down_revision: str | None = 'b4a719a434de'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'lotacao_posto',
        sa.Column('lotacao_id', sa.Integer(), nullable=False),
        sa.Column('posto_trabalho_id', sa.Integer(), nullable=False),
        sa.Column('ordem', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ['lotacao_id'], ['servidor_lotacao.id'],
            name='fk_lotacao_posto_lotacao', ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['posto_trabalho_id'], ['posto_trabalho.id'],
            name='fk_lotacao_posto_posto',
        ),
        sa.PrimaryKeyConstraint('lotacao_id', 'posto_trabalho_id'),
    )
    # o posto que cada período já tinha vira o primeiro da lista — nenhum
    # histórico de exposição pode se perder na troca de forma
    op.execute(
        """
        INSERT INTO lotacao_posto (lotacao_id, posto_trabalho_id, ordem)
        SELECT id, posto_trabalho_id, 1
          FROM servidor_lotacao
         WHERE posto_trabalho_id IS NOT NULL
        """
    )

    with op.batch_alter_table('parecer_tecnico', schema=None) as batch_op:
        batch_op.add_column(sa.Column('uorg_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_parecer_uorg', 'unidade_uorg', ['uorg_id'], ['id']
        )

    with op.batch_alter_table('servidor', schema=None) as batch_op:
        batch_op.add_column(sa.Column('uorg_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_servidor_uorg', 'unidade_uorg', ['uorg_id'], ['id']
        )
        # o batch recria a tabela: soltar a coluna já leva a FK junto
        batch_op.drop_column('posto_trabalho_id')

    with op.batch_alter_table('servidor_lotacao', schema=None) as batch_op:
        batch_op.add_column(sa.Column('uorg_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_lotacao_uorg', 'unidade_uorg', ['uorg_id'], ['id']
        )
        batch_op.drop_column('posto_trabalho_id')


def downgrade() -> None:
    with op.batch_alter_table('servidor_lotacao', schema=None) as batch_op:
        batch_op.add_column(sa.Column('posto_trabalho_id', sa.INTEGER(), nullable=True))
        batch_op.create_foreign_key(
            'fk_lotacao_posto_trabalho', 'posto_trabalho', ['posto_trabalho_id'], ['id']
        )
        batch_op.drop_column('uorg_id')

    # volta só o primeiro posto de cada período: a coluna única não comporta o resto
    op.execute(
        """
        UPDATE servidor_lotacao
           SET posto_trabalho_id = (
               SELECT posto_trabalho_id FROM lotacao_posto
                WHERE lotacao_posto.lotacao_id = servidor_lotacao.id
                ORDER BY ordem LIMIT 1)
        """
    )

    with op.batch_alter_table('servidor', schema=None) as batch_op:
        batch_op.add_column(sa.Column('posto_trabalho_id', sa.INTEGER(), nullable=True))
        batch_op.create_foreign_key(
            'fk_servidor_posto', 'posto_trabalho', ['posto_trabalho_id'], ['id']
        )
        batch_op.drop_column('uorg_id')

    with op.batch_alter_table('parecer_tecnico', schema=None) as batch_op:
        batch_op.drop_constraint('fk_parecer_uorg', type_='foreignkey')
        batch_op.drop_column('uorg_id')

    op.drop_table('lotacao_posto')
