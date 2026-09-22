"""certificados: turma, participante e inscricao

Fatia 2 do modulo Certificados e Treinamentos: quem participa (`participante`,
`participante_email`), quando (`turma`, `turma_sequencia`, `turma_instrutor`) e
quem esta na turma (`inscricao`).

`participante` nao e so de Certificados: `acidentado.participante_id` vai
apontar para ela quando Acidentes chegar (SS2.1 do plano consolidado). Nascer
aqui e o que permite aquela coluna nascer pronta la, em vez de reconciliar a
mao duas tabelas de "pessoa externa" sem CPF para ajudar.

Quatro coisas foram corrigidas a mao no que o `--autogenerate` produziu:

1. **Faltava `import app.modelos.base`.** O arquivo gerado usa
   `app.modelos.base.DataPura()` e nunca importa o modulo — `NameError` no
   primeiro `upgrade`. O gerador nao aprende com a migracao anterior, que ja
   tinha o import.
2. **O ciclo de chave estrangeira.** `participante.email_principal_id` aponta
   para `participante_email` e `participante_email.participante_id` aponta de
   volta. O autogenerate escreveu a FK dentro do `create_table` com
   `use_alter=True`, mas `use_alter` so e honrado pelo `create_all` do
   SQLAlchemy — num `op.create_table` isolado ele nao faz nada, e o
   PostgreSQL, que e o dialeto de referencia do projeto, recusa referenciar
   tabela inexistente. Aqui `participante` nasce sem essa FK e a recebe no
   fim, como a migracao da fatia 1 fez com `treinamento`.
3. **A ordem do `downgrade`.** O gerado derrubava `participante_email` antes de
   `participante`, que a referencia. A FK do ciclo sai primeiro, e so entao as
   tabelas, na ordem inversa da criacao.
4. **Indice em `batch_alter_table`.** Trocado por `op.create_index` direto:
   `batch` existe para ALTER que o SQLite nao tem, e criar indice em tabela
   recem-criada nao precisa de copia de tabela nenhuma.

`ck_participante_identificador` nao aparece aqui de proposito: e um
`check_regex`, marcado como exclusivo do PostgreSQL, e o `env.py` o remove do
DDL do SQLite. A validacao real do formato vive no gerador do identificador,
que e a unica coisa que o produz.

Revision ID: 2c7b58c6214f
Revises: 53bb59ebfbd2
Create Date: 2026-08-13 13:47:03.339308+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura/MomentoUTC/Inet)

revision: str = '2c7b58c6214f'
down_revision: str | None = '53bb59ebfbd2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# o indice unico parcial do e-mail confirmado; o texto tem de ser identico no
# upgrade e no downgrade, senao o SQLite nao reconhece o indice para derrubar
EMAIL_CONFIRMADO = sa.text('confirmado_em IS NOT NULL')


def upgrade() -> None:
    op.create_table(
        'turma_sequencia',
        sa.Column('ano', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('ultimo_numero', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('ano', name='pk_turma_sequencia'),
    )

    # sem a FK de `email_principal_id`: `participante_email` ainda nao existe
    op.create_table(
        'participante',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('servidor_id', sa.Integer(), nullable=True),
        sa.Column('nome', sa.String(length=160), nullable=True),
        sa.Column('identificador_publico', sa.String(length=14), nullable=False),
        sa.Column('vinculo', sa.String(length=16), nullable=False),
        sa.Column('organizacao', sa.String(length=160), nullable=True),
        sa.Column('matricula_externa', sa.String(length=30), nullable=True),
        sa.Column('email_principal_id', sa.Integer(), nullable=True),
        sa.Column('mesclado_em_id', sa.Integer(), nullable=True),
        sa.Column('expurgar_apos', app.modelos.base.DataPura(), nullable=True),
        sa.Column('expurgado_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('ativo', sa.Boolean(), nullable=False),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.CheckConstraint(
            "vinculo <> 'SERVIDOR' OR servidor_id IS NOT NULL",
            name='ck_participante_servidor',
        ),
        sa.CheckConstraint(
            "vinculo IN ('SERVIDOR','TERCEIRIZADO','DISCENTE','VISITANTE','OUTRO')",
            name='ck_participante_vinculo',
        ),
        sa.CheckConstraint(
            '(servidor_id IS NOT NULL AND nome IS NULL) OR '
            '(servidor_id IS NULL AND nome IS NOT NULL) OR expurgado_em IS NOT NULL',
            name='ck_participante_nome',
        ),
        sa.ForeignKeyConstraint(
            ['mesclado_em_id'], ['participante.id'], name='fk_participante_mesclado'
        ),
        sa.ForeignKeyConstraint(
            ['servidor_id'], ['servidor.id'], name='fk_participante_servidor'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_participante'),
        sa.UniqueConstraint('identificador_publico', name='uq_participante_identificador'),
        sa.UniqueConstraint('servidor_id', name='uq_participante_servidor'),
    )
    op.create_index('ix_participante_mesclado', 'participante', ['mesclado_em_id'])

    op.create_table(
        'participante_email',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('participante_id', sa.Integer(), nullable=False),
        sa.Column('email', sa.String(length=160), nullable=False),
        sa.Column('email_normalizado', sa.String(length=160), nullable=False),
        sa.Column('confirmado_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('origem', sa.String(length=20), nullable=False),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.CheckConstraint(
            "origem IN ('CADASTRO','INSCRICAO_PUBLICA','SERVIDOR','MESCLAGEM')",
            name='ck_participante_email_origem',
        ),
        sa.ForeignKeyConstraint(
            ['participante_id'],
            ['participante.id'],
            name='fk_participante_email_dono',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_participante_email'),
        sa.UniqueConstraint(
            'participante_id', 'email_normalizado', name='uq_participante_email'
        ),
    )
    op.create_index(
        'ix_participante_email_norm', 'participante_email', ['email_normalizado']
    )
    # parcial: um e-mail CONFIRMADO pertence a um participante so. O nao
    # confirmado pode repetir — e o sinal de que ha duplicata a mesclar.
    op.create_index(
        'uq_email_confirmado',
        'participante_email',
        ['email_normalizado'],
        unique=True,
        sqlite_where=EMAIL_CONFIRMADO,
        postgresql_where=EMAIL_CONFIRMADO,
    )

    # fecha o ciclo agora que as duas tabelas existem
    with op.batch_alter_table('participante', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_participante_email_principal',
            'participante_email',
            ['email_principal_id'],
            ['id'],
        )

    op.create_table(
        'turma',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('treinamento_id', sa.Integer(), nullable=False),
        sa.Column('numero', sa.Integer(), nullable=False),
        sa.Column('ano', sa.Integer(), nullable=False),
        sa.Column('codigo', sa.String(length=20), nullable=False),
        sa.Column('data_inicio', app.modelos.base.DataPura(), nullable=False),
        sa.Column('data_fim', app.modelos.base.DataPura(), nullable=False),
        sa.Column('data_base_vencimento', app.modelos.base.DataPura(), nullable=True),
        sa.Column(
            'carga_horaria_horas', sa.Numeric(precision=5, scale=1), nullable=True
        ),
        sa.Column('local', sa.String(length=160), nullable=True),
        sa.Column('campus_id', sa.Integer(), nullable=True),
        sa.Column('unidade_promotora_id', sa.Integer(), nullable=True),
        sa.Column('vagas', sa.Integer(), nullable=True),
        sa.Column('inscricao_aberta_ate', app.modelos.base.DataPura(), nullable=True),
        sa.Column('inscricao_publica', sa.Boolean(), nullable=False),
        sa.Column('inscricao_token_hash', sa.String(length=64), nullable=True),
        sa.Column(
            'inscricao_token_expira_em', app.modelos.base.MomentoUTC(), nullable=True
        ),
        sa.Column(
            'nota_minima_aprovacao', sa.Numeric(precision=5, scale=2), nullable=True
        ),
        sa.Column(
            'frequencia_minima_percentual',
            sa.Numeric(precision=5, scale=2),
            nullable=False,
        ),
        sa.Column('situacao', sa.String(length=20), nullable=False),
        sa.Column('motivo_cancelamento', sa.Text(), nullable=True),
        sa.Column('observacoes', sa.Text(), nullable=True),
        sa.Column('concluida_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('criado_por', sa.Integer(), nullable=True),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.CheckConstraint(
            "CAST(strftime('%Y', data_inicio) AS integer) = ano", name='ck_turma_ano'
        ),
        sa.CheckConstraint(
            "situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name='ck_turma_cancelada',
        ),
        sa.CheckConstraint(
            "situacao IN ('PLANEJADA','INSCRICOES_ABERTAS','EM_ANDAMENTO',"
            "'CONCLUIDA','CANCELADA')",
            name='ck_turma_situacao',
        ),
        sa.CheckConstraint(
            'carga_horaria_horas IS NULL OR carga_horaria_horas > 0',
            name='ck_turma_carga',
        ),
        sa.CheckConstraint('data_fim >= data_inicio', name='ck_turma_periodo'),
        sa.CheckConstraint(
            'frequencia_minima_percentual >= 0 AND frequencia_minima_percentual <= 100',
            name='ck_turma_frequencia_minima',
        ),
        sa.CheckConstraint(
            'inscricao_publica = 0 OR inscricao_aberta_ate IS NOT NULL',
            name='ck_turma_inscricao_publica',
        ),
        sa.CheckConstraint(
            'nota_minima_aprovacao IS NULL OR '
            '(nota_minima_aprovacao >= 0 AND nota_minima_aprovacao <= 10)',
            name='ck_turma_nota_minima',
        ),
        sa.CheckConstraint('vagas IS NULL OR vagas > 0', name='ck_turma_vagas'),
        sa.ForeignKeyConstraint(['campus_id'], ['campus.id'], name='fk_turma_campus'),
        sa.ForeignKeyConstraint(
            ['criado_por'], ['usuario.id'], name='fk_turma_criado_por'
        ),
        sa.ForeignKeyConstraint(
            ['treinamento_id'], ['treinamento.id'], name='fk_turma_treinamento'
        ),
        sa.ForeignKeyConstraint(
            ['unidade_promotora_id'], ['unidade_uorg.id'], name='fk_turma_unidade'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_turma'),
        sa.UniqueConstraint('codigo', name='uq_turma_codigo'),
        sa.UniqueConstraint('inscricao_token_hash', name='uq_turma_token'),
        sa.UniqueConstraint('numero', 'ano', name='uq_turma'),
    )
    op.create_index('ix_turma_data_fim', 'turma', ['data_fim'])
    op.create_index('ix_turma_situacao', 'turma', ['situacao'])
    op.create_index('ix_turma_treinamento', 'turma', ['treinamento_id'])

    op.create_table(
        'turma_instrutor',
        sa.Column('turma_id', sa.Integer(), nullable=False),
        sa.Column('assinatura_instrutor_id', sa.Integer(), nullable=False),
        sa.Column('ordem', sa.SmallInteger(), nullable=False),
        sa.Column('assina_certificado', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ['assinatura_instrutor_id'],
            ['assinatura_instrutor.id'],
            name='fk_turma_instrutor_assinatura',
        ),
        sa.ForeignKeyConstraint(
            ['turma_id'], ['turma.id'], name='fk_turma_instrutor_turma',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint(
            'turma_id', 'assinatura_instrutor_id', name='pk_turma_instrutor'
        ),
    )

    op.create_table(
        'inscricao',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('turma_id', sa.Integer(), nullable=False),
        sa.Column('participante_id', sa.Integer(), nullable=False),
        sa.Column('situacao', sa.String(length=24), nullable=False),
        sa.Column('origem', sa.String(length=12), nullable=False),
        sa.Column('confirmacao_token_hash', sa.String(length=64), nullable=True),
        sa.Column(
            'confirmacao_expira_em', app.modelos.base.MomentoUTC(), nullable=True
        ),
        sa.Column('email_confirmado_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('ip_inscricao', app.modelos.base.Inet(), nullable=True),
        sa.Column('inscrito_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('inscrito_por', sa.Integer(), nullable=True),
        sa.Column('confirmada_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('confirmada_por', sa.Integer(), nullable=True),
        sa.Column(
            'frequencia_percentual', sa.Numeric(precision=5, scale=2), nullable=True
        ),
        sa.Column('nota_final', sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column('observacao', sa.Text(), nullable=True),
        sa.Column('motivo_cancelamento', sa.Text(), nullable=True),
        sa.CheckConstraint(
            "origem = 'INTERNA' OR situacao = 'AGUARDANDO_EMAIL' "
            'OR email_confirmado_em IS NOT NULL',
            name='ck_inscricao_email_confirmado',
        ),
        sa.CheckConstraint("origem IN ('INTERNA','PUBLICA')", name='ck_inscricao_origem'),
        sa.CheckConstraint(
            "situacao <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name='ck_inscricao_cancelada',
        ),
        sa.CheckConstraint(
            "situacao IN ('AGUARDANDO_EMAIL','INSCRITA','CONFIRMADA','PRESENTE',"
            "'AUSENTE','APROVADO','REPROVADO','CANCELADA')",
            name='ck_inscricao_situacao',
        ),
        sa.CheckConstraint(
            'frequencia_percentual IS NULL OR '
            '(frequencia_percentual >= 0 AND frequencia_percentual <= 100)',
            name='ck_inscricao_frequencia',
        ),
        sa.CheckConstraint(
            'nota_final IS NULL OR (nota_final >= 0 AND nota_final <= 10)',
            name='ck_inscricao_nota',
        ),
        sa.ForeignKeyConstraint(
            ['confirmada_por'], ['usuario.id'], name='fk_inscricao_confirmada_por'
        ),
        sa.ForeignKeyConstraint(
            ['inscrito_por'], ['usuario.id'], name='fk_inscricao_inscrito_por'
        ),
        sa.ForeignKeyConstraint(
            ['participante_id'],
            ['participante.id'],
            name='fk_inscricao_participante',
        ),
        sa.ForeignKeyConstraint(
            ['turma_id'], ['turma.id'], name='fk_inscricao_turma', ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_inscricao'),
        sa.UniqueConstraint('confirmacao_token_hash', name='uq_inscricao_token'),
        sa.UniqueConstraint('turma_id', 'participante_id', name='uq_inscricao'),
    )
    op.create_index('ix_inscricao_participante', 'inscricao', ['participante_id'])
    op.create_index(
        'ix_inscricao_turma_situacao', 'inscricao', ['turma_id', 'situacao']
    )


def downgrade() -> None:
    # Inverso exato do upgrade. A FK do ciclo sai primeiro: sem isso,
    # `participante_email` seria derrubada com `participante` ainda apontando
    # para ela, o que o PostgreSQL recusa e o SQLite aceita para reclamar
    # depois, no primeiro INSERT.
    op.drop_index('ix_inscricao_turma_situacao', table_name='inscricao')
    op.drop_index('ix_inscricao_participante', table_name='inscricao')
    op.drop_table('inscricao')

    op.drop_table('turma_instrutor')

    op.drop_index('ix_turma_treinamento', table_name='turma')
    op.drop_index('ix_turma_situacao', table_name='turma')
    op.drop_index('ix_turma_data_fim', table_name='turma')
    op.drop_table('turma')

    with op.batch_alter_table('participante', schema=None) as batch_op:
        batch_op.drop_constraint('fk_participante_email_principal', type_='foreignkey')

    op.drop_index(
        'uq_email_confirmado',
        table_name='participante_email',
        sqlite_where=EMAIL_CONFIRMADO,
        postgresql_where=EMAIL_CONFIRMADO,
    )
    op.drop_index('ix_participante_email_norm', table_name='participante_email')
    op.drop_table('participante_email')

    op.drop_index('ix_participante_mesclado', table_name='participante')
    op.drop_table('participante')

    op.drop_table('turma_sequencia')
