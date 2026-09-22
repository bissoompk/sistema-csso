"""certificados: presenca por dia da turma

Fatia 3 do modulo Certificados e Treinamentos: `turma_presenca`, a linha por
inscrito e por dia de onde sai a frequencia que decide se o certificado pode ser
emitido.

O nome NAO e `presenca`, como o desenho (SS2.8) escreveu, e sim
**`turma_presenca`**: o plano consolidado (SS1.4) reservou o nome generico para a
CISSP, que tambem tem presenca de membro em reuniao. Renomear depois de a tabela
existir custaria migracao com copia de dados; agora custou um prefixo.

Duas coisas foram corrigidas a mao no que o `--autogenerate` produziu:

1. **Faltava `import app.modelos.base`.** O arquivo gerado usa
   `app.modelos.base.DataPura()` e `MomentoUTC()` e nunca importa o modulo —
   `NameError` no primeiro `upgrade`. E o mesmo defeito que a fatia 2 corrigiu;
   o gerador nao aprende com a migracao anterior.
2. **Os comentarios `### commands auto generated ###`**, trocados pelo texto que
   explica por que cada CHECK esta escrito daquele jeito. O motivo do
   `ck_turma_presenca_coerente` em particular NAO e obvio e se perderia.

`ck_turma_presenca_coerente` merece o paragrafo: o desenho escreveu
`presente = 1 OR horas = 0`, que funciona no SQLite — onde booleano e inteiro — e
**quebra no PostgreSQL**, que e o dialeto de referencia do projeto: la `presente`
e `boolean` e nao se compara com o inteiro 1. A forma usada aqui trata o booleano
como booleano e sai valida nos dois dialetos, conferido com `create_mock_engine`.

Nao ha ciclo de chave estrangeira, nao ha `batch_alter_table` e nao ha indice
proprio: `uq_turma_presenca_dia` ja cobre a busca por inscricao, que e a unica
que o servico faz.

Revision ID: 5cbcb1e7d34e
Revises: 2c7b58c6214f
Create Date: 2026-08-13 15:50:01.382603+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura/MomentoUTC)

revision: str = '5cbcb1e7d34e'
down_revision: str | None = '2c7b58c6214f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'turma_presenca',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('inscricao_id', sa.Integer(), nullable=False),
        sa.Column('data', app.modelos.base.DataPura(), nullable=False),
        sa.Column('horas', sa.Numeric(precision=4, scale=1), nullable=False),
        sa.Column('presente', sa.Boolean(), nullable=False),
        sa.Column('justificativa', sa.Text(), nullable=True),
        sa.Column('registrado_por', sa.Integer(), nullable=True),
        sa.Column('registrado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.CheckConstraint('horas >= 0', name='ck_turma_presenca_horas'),
        # portatil de proposito: `presente = 1` quebraria no PostgreSQL
        sa.CheckConstraint(
            'presente OR horas = 0', name='ck_turma_presenca_coerente'
        ),
        # CASCADE porque a presenca nao existe sem a inscricao: apagar a
        # inscricao e deixar a linha do dia orfa produziria frequencia de
        # ninguem
        sa.ForeignKeyConstraint(
            ['inscricao_id'],
            ['inscricao.id'],
            name='fk_turma_presenca_inscricao',
            ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['registrado_por'],
            ['usuario.id'],
            name='fk_turma_presenca_registrado_por',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_turma_presenca'),
        # um dia, um lancamento por inscrito: com duas linhas para o mesmo dia a
        # frequencia somaria as duas e passaria de 100% sem que ninguem tivesse
        # ficado a mais na sala
        sa.UniqueConstraint('inscricao_id', 'data', name='uq_turma_presenca_dia'),
    )


def downgrade() -> None:
    op.drop_table('turma_presenca')
