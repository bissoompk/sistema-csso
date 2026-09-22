"""pendencia ancorada em qualquer entidade

`Pendencia` so sabia apontar para processo, parecer e laudo — os tres objetos do
Processos SEI. Os modulos que vem a seguir abrem pendencia sobre outra coisa: CA
a vencer aponta para um lote de entrada de estoque, reciclagem aponta para o
servidor e o treinamento, prazo do art. 214 aponta para a ocorrencia. Sem
ancora, a tela mostra descricao e prazo e nao leva a lugar nenhum.

O par `entidade`/`entidade_id` e o mesmo que `historico_evento` e `anexo` ja
usam. Ambos anulaveis, com indice, e uma CHECK que recusa meia ancora: metade
preenchida produz um link quebrado, que e pior que link nenhum.

Nasce agora, e nao junto do primeiro modulo que precisar, porque depois exigiria
backfill em pendencia ja aberta — e pendencia aberta e trabalho de alguem, nao
linha de catalogo que se reescreve.

O `--autogenerate` acertou esta (colunas, indice e CHECK nova sao detectados).
Ficou a revisao a mao so na ordem do downgrade e nos comentarios.

Revision ID: 53bb59ebfbd2
Revises: d30b553943d1
Create Date: 2026-08-13 09:46:25.768278+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '53bb59ebfbd2'
down_revision: str | None = 'd30b553943d1'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ANCORA_INTEIRA = (
    "(entidade IS NULL AND entidade_id IS NULL) "
    "OR (entidade IS NOT NULL AND entidade_id IS NOT NULL)"
)


def upgrade() -> None:
    # a CHECK obriga o SQLite a reconstruir `pendencia`; as duas colunas e o
    # indice vao no mesmo batch para nao reconstruir a tabela duas vezes
    with op.batch_alter_table('pendencia', schema=None) as batch_op:
        batch_op.add_column(sa.Column('entidade', sa.String(length=30), nullable=True))
        batch_op.add_column(sa.Column('entidade_id', sa.Integer(), nullable=True))
        batch_op.create_index(
            'ix_pendencia_entidade', ['entidade', 'entidade_id'], unique=False
        )
        batch_op.create_check_constraint('ck_pendencia_entidade', ANCORA_INTEIRA)


def downgrade() -> None:
    # Inverso exato do upgrade: a CHECK sai antes das colunas que ela cita.
    # Descer aqui perde a ancora das pendencias que ja a tiverem — as tres FKs
    # do Processos SEI continuam intactas, o resto vira descricao sem destino.

    with op.batch_alter_table('pendencia', schema=None) as batch_op:
        batch_op.drop_constraint('ck_pendencia_entidade', type_='check')
        batch_op.drop_index('ix_pendencia_entidade')
        batch_op.drop_column('entidade_id')
        batch_op.drop_column('entidade')
