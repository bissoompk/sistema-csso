"""demandas: o que chega por fora do SEI e precisa de encaminhamento

Duas tabelas novas, e nenhuma coluna tocada no que ja existe.

**Por que tabela nova, e nao campo em `processo` ou em `pendencia`.** As duas
portas estao fechadas, e nenhum dos fechos e acidente: `processo.nup` e
`nullable=False`, `unique=True` e tem CHECK de formato — um `processo` E um
processo SEI, com os dezenove estados da instrucao do adicional; e `pendencia`
nasce de REGRA, ancorada em algo que ja existe, e e tarefa, nao registro. A
demanda que chegou por e-mail nao tem NUP nem ancora, e precisa guardar quem
pediu, por onde, o que foi pedido e como terminou.

**As duas nascem juntas** porque `demanda_encaminhamento` referencia `demanda`:
criar so a primeira deixaria a segunda para uma revisao seguinte e, no meio,
uma tela que encaminha sem ter onde gravar. A ordem do `create_table` e a
topologica — `demanda` antes —, e o `downgrade` e o inverso exato.

**As FKs apontam para tabelas que ja existem** (`servidor`, `unidade_uorg`,
`usuario`, `processo`), entao nao ha promessa adiada como a de
`requisicao_item_id` no modulo de EPI: `desfecho_processo_id` e chave
estrangeira de verdade desde a primeira linha, e e ela que sustenta a
rastreabilidade "esta demanda gerou aquele processo".

**As duas travas append-only** vem de `app.banco.TRIGGERS_DEMANDA`, e valem so
para `demanda_encaminhamento` (RN-31). A `demanda` em si NAO e append-only, e a
diferenca e real: ela e o registro vivo — muda de estado, de dono, de prazo, e
encerra —, enquanto o encaminhamento e o fato datado que se cobra depois.
Trigger nao entra em autogenerate; esta escrita a mao, como todas as outras.

Revision ID: a7c4e91d0f52
Revises: f3a6b21d9c85
Create Date: 2026-09-03 10:10:14.882301+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura e MomentoUTC)
from app.banco import TRIGGERS_DEMANDA

revision: str = 'a7c4e91d0f52'
down_revision: str | None = 'f3a6b21d9c85'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'demanda',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('data_chegada', app.modelos.base.DataPura(), nullable=False),
        sa.Column('canal', sa.String(length=12), nullable=False),
        # o texto livre e o vinculo, e os dois de proposito: quem demanda muitas
        # vezes NAO esta no cadastro (chefia, outro setor, alguem de fora), e
        # exigir cadastro para poder anotar o pedido e o atrito que faz a
        # demanda voltar para o post-it
        sa.Column('solicitante_nome', sa.String(length=160), nullable=False),
        sa.Column('solicitante_servidor_id', sa.Integer(), nullable=True),
        sa.Column('solicitante_unidade_uorg_id', sa.Integer(), nullable=True),
        sa.Column('assunto', sa.String(length=160), nullable=False),
        sa.Column('descricao', sa.Text(), nullable=True),
        sa.Column('responsavel_id', sa.Integer(), nullable=True),
        sa.Column('prazo', app.modelos.base.DataPura(), nullable=True),
        sa.Column('estado', sa.String(length=14), nullable=False),
        sa.Column('desfecho', sa.String(length=16), nullable=True),
        sa.Column('desfecho_relato', sa.Text(), nullable=True),
        sa.Column('desfecho_processo_id', sa.Integer(), nullable=True),
        sa.Column('desfecho_setor', sa.String(length=160), nullable=True),
        sa.Column('desfecho_data', app.modelos.base.DataPura(), nullable=True),
        sa.Column('encerrada_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('encerrada_por', sa.Integer(), nullable=True),
        sa.Column('criada_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('criada_por', sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "canal IN ('EMAIL','PRESENCIAL','TELEFONE','OFICIO','OUTRO')",
            name='ck_demanda_canal',
        ),
        sa.CheckConstraint(
            "estado IN ('ABERTA','EM_ANDAMENTO','ENCERRADA')",
            name='ck_demanda_estado',
        ),
        sa.CheckConstraint(
            "desfecho IS NULL OR desfecho IN "
            "('RESOLVIDA','VIROU_PROCESSO','ENCAMINHADA','SEM_PROVIDENCIA')",
            name='ck_demanda_desfecho',
        ),
        # encerrar exige dizer COMO, nos dois sentidos: demanda aberta com
        # desfecho gravado e um fecho que ninguem completou
        sa.CheckConstraint(
            "(estado <> 'ENCERRADA' AND desfecho IS NULL) "
            "OR (estado = 'ENCERRADA' AND desfecho IS NOT NULL)",
            name='ck_demanda_encerrada_tem_desfecho',
        ),
        # cada desfecho cobra o seu campo e PROIBE os dos outros: sem a segunda
        # metade, uma demanda resolvida poderia carregar um setor de destino
        # sobrando de um encaminhamento que nao aconteceu
        sa.CheckConstraint(
            "(desfecho IS NULL"
            " AND desfecho_relato IS NULL AND desfecho_processo_id IS NULL"
            " AND desfecho_setor IS NULL AND desfecho_data IS NULL)"
            " OR ("
            "     (desfecho <> 'VIROU_PROCESSO' OR desfecho_processo_id IS NOT NULL)"
            " AND (desfecho =  'VIROU_PROCESSO' OR desfecho_processo_id IS NULL)"
            " AND (desfecho <> 'ENCAMINHADA'"
            "      OR (desfecho_setor IS NOT NULL AND desfecho_data IS NOT NULL))"
            " AND (desfecho =  'ENCAMINHADA' OR desfecho_setor IS NULL)"
            " AND (desfecho NOT IN ('RESOLVIDA','SEM_PROVIDENCIA')"
            "      OR desfecho_relato IS NOT NULL))",
            name='ck_demanda_desfecho_campos',
        ),
        sa.ForeignKeyConstraint(
            ['solicitante_servidor_id'], ['servidor.id'],
            name='fk_demanda_servidor',
        ),
        sa.ForeignKeyConstraint(
            ['solicitante_unidade_uorg_id'], ['unidade_uorg.id'],
            name='fk_demanda_unidade',
        ),
        sa.ForeignKeyConstraint(
            ['responsavel_id'], ['usuario.id'], name='fk_demanda_responsavel'
        ),
        sa.ForeignKeyConstraint(
            ['desfecho_processo_id'], ['processo.id'], name='fk_demanda_processo'
        ),
        sa.ForeignKeyConstraint(
            ['encerrada_por'], ['usuario.id'], name='fk_demanda_encerrada_por'
        ),
        sa.ForeignKeyConstraint(
            ['criada_por'], ['usuario.id'], name='fk_demanda_criada_por'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_demanda'),
    )
    op.create_index('ix_demanda_estado', 'demanda', ['estado', 'prazo'])
    op.create_index('ix_demanda_responsavel', 'demanda', ['responsavel_id'])
    op.create_index(
        'ix_demanda_servidor', 'demanda', ['solicitante_servidor_id']
    )

    op.create_table(
        'demanda_encaminhamento',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('demanda_id', sa.Integer(), nullable=False),
        sa.Column(
            'data_encaminhamento', app.modelos.base.DataPura(), nullable=False
        ),
        sa.Column('para_quem', sa.String(length=160), nullable=False),
        sa.Column('pedido', sa.Text(), nullable=False),
        sa.Column('registrado_por', sa.Integer(), nullable=True),
        sa.Column('registrado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.ForeignKeyConstraint(
            ['demanda_id'], ['demanda.id'],
            name='fk_encaminhamento_demanda', ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['registrado_por'], ['usuario.id'], name='fk_encaminhamento_autor'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_demanda_encaminhamento'),
    )
    op.create_index(
        'ix_demanda_encaminhamento', 'demanda_encaminhamento', ['demanda_id']
    )

    # RN-31 — o encaminhamento nao se edita nem se apaga. A trava nasce COM a
    # tabela, e nao com a tela que escreve nela: uma tabela append-only que
    # passa um mes aceitando UPDATE e uma tabela cujo historico ninguem
    # consegue mais afirmar que esta intacto.
    for nome, ddl in TRIGGERS_DEMANDA:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")
        op.execute(ddl)


def downgrade() -> None:
    # Inverso exato do upgrade: primeiro as travas (que impediriam qualquer
    # escrita), depois os indices, e as tabelas na ordem topologica inversa —
    # `demanda_encaminhamento` referencia `demanda`.
    for nome, _ in TRIGGERS_DEMANDA:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")

    op.drop_index('ix_demanda_encaminhamento', table_name='demanda_encaminhamento')
    op.drop_table('demanda_encaminhamento')

    op.drop_index('ix_demanda_servidor', table_name='demanda')
    op.drop_index('ix_demanda_responsavel', table_name='demanda')
    op.drop_index('ix_demanda_estado', table_name='demanda')
    op.drop_table('demanda')
