"""certificados: emissao congelada

Fatia 4 do modulo Certificados e Treinamentos: `certificado_sequencia` e
`certificado`, o documento que circula e por isso e o unico deste modulo que
congela o proprio conteudo (RN-15).

`contexto_congelado` guarda TUDO o que foi renderizado, **inclusive o mapa de
tags** (`{marcador: campo}`). E por isso que ele e `NOT NULL`: um certificado
sem contexto congelado seria um certificado cuja segunda via teria de ser
remontada a partir do catalogo de hoje, que e exatamente o que a regra proibe.
Nao ha valor de preenchimento possivel para uma linha assim — a coluna nasce
obrigatoria porque a alternativa e nascer mentindo.

Tres coisas foram corrigidas a mao no que o `--autogenerate` produziu:

1. **Faltava `import app.modelos.base`.** O arquivo gerado usa
   `app.modelos.base.DataPura()`, `.JSONTexto()` e `.MomentoUTC()` e nunca
   importa o modulo — `NameError` no primeiro `upgrade`. E a terceira migracao
   seguida em que o gerador comete o mesmo esquecimento.
2. **Os seis indices em `batch_alter_table`.** Trocados por `op.create_index`
   direto, como a fatia 2 ja tinha feito: `batch` existe para o `ALTER` que o
   SQLite nao tem, e criar indice em tabela recem-criada nao precisa de copia de
   tabela nenhuma. O `where` do indice PARCIAL foi preservado na conversao — sem
   ele a unicidade passaria a valer tambem para certificado anulado, e a
   reemissao (que e o remedio previsto para nome social e erro de digitacao)
   ficaria impossivel para sempre.
3. **Os comentarios `### commands auto generated ###`**, trocados pelo texto que
   explica por que cada CHECK esta escrito daquele jeito.

`ck_certificado_chave` nao aparece aqui de proposito: e um `check_regex`,
marcado como exclusivo do PostgreSQL, e o `env.py` o remove do DDL do SQLite. A
validacao real do formato vive em `certificado.gerar_chave`/`chave_valida`, que
sao o unico lugar que produz e confere chave.

`substituido_por_id -> certificado.id` e autorreferente, e nao ciclo entre
tabelas: o SQLite embute a FK no proprio `CREATE TABLE` e o `sorted_tables` do
SQLAlchemy nao reclama. Conferido: `create_all` e `drop_all` continuam sem
aviso, e o DDL desta migracao sai igual ao do `create_all` no que estrutura.

Revision ID: 442dd16889a5
Revises: 5cbcb1e7d34e
Create Date: 2026-08-13 19:33:51.272918+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos DataPura/MomentoUTC/JSONTexto)

revision: str = '442dd16889a5'
down_revision: str | None = '5cbcb1e7d34e'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Uma inscricao tem no maximo um certificado NAO anulado. O texto tem de ser
# identico no upgrade e no downgrade, senao o SQLite nao reconhece o indice para
# derrubar — foi a licao do `uq_email_confirmado` da fatia 2.
CERTIFICADO_ATIVO = sa.text("situacao != 'ANULADO'")


def upgrade() -> None:
    op.create_table(
        'certificado_sequencia',
        sa.Column('ano', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('ultimo_numero', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('ano', name='pk_certificado_sequencia'),
    )

    op.create_table(
        'certificado',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('inscricao_id', sa.Integer(), nullable=False),
        sa.Column('numero', sa.Integer(), nullable=False),
        sa.Column('ano', sa.Integer(), nullable=False),
        sa.Column('chave_validacao', sa.String(length=24), nullable=False),
        sa.Column('situacao', sa.String(length=12), nullable=False),
        sa.Column('data_emissao', app.modelos.base.DataPura(), nullable=False),
        sa.Column(
            'data_base_vencimento', app.modelos.base.DataPura(), nullable=False
        ),
        sa.Column('data_vencimento', app.modelos.base.DataPura(), nullable=True),
        sa.Column('validade_meses_congelada', sa.Integer(), nullable=False),
        sa.Column('contexto_congelado', app.modelos.base.JSONTexto(), nullable=False),
        sa.Column('modelo_id', sa.Integer(), nullable=True),
        sa.Column('modelo_arquivo', sa.String(length=120), nullable=False),
        sa.Column('modelo_sha256', sa.String(length=64), nullable=True),
        sa.Column('hash_conteudo', sa.String(length=64), nullable=True),
        sa.Column('arquivo_docx', sa.Text(), nullable=True),
        sa.Column('arquivo_pdf_anexo_id', sa.Integer(), nullable=True),
        sa.Column('servidor_id', sa.Integer(), nullable=True),
        sa.Column('campus_id', sa.Integer(), nullable=True),
        sa.Column('treinamento_id', sa.Integer(), nullable=False),
        sa.Column('participante_id', sa.Integer(), nullable=False),
        sa.Column('emitido_por', sa.Integer(), nullable=True),
        sa.Column('emitido_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('anulado_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('anulado_por', sa.Integer(), nullable=True),
        sa.Column('motivo_anulacao', sa.Text(), nullable=True),
        sa.Column('substituido_por_id', sa.Integer(), nullable=True),
        # o ano do documento e o do carimbo de emissao: sem esta CHECK, o
        # numero 27 de 2026 poderia carimbar 2027 e a sequencia do ano seguinte
        # continuaria oferecendo o 27
        sa.CheckConstraint(
            "CAST(strftime('%Y', data_emissao) AS integer) = ano",
            name='ck_certificado_ano',
        ),
        # anular sem motivo produz documento morto sem explicacao, e a
        # explicacao e o unico dado que sobra para quem perguntar depois
        sa.CheckConstraint(
            "situacao <> 'ANULADO' OR motivo_anulacao IS NOT NULL",
            name='ck_certificado_anulado',
        ),
        sa.CheckConstraint(
            "situacao IN ('EMITIDO','ANULADO')", name='ck_certificado_situacao'
        ),
        # 0 mes <=> sem vencimento. As duas colunas nao podem se contradizer:
        # `validade_meses_congelada = 24` com `data_vencimento` nula faria o
        # monitor de reciclagem (fatia 7) simplesmente perder o certificado
        sa.CheckConstraint(
            '(validade_meses_congelada = 0 AND data_vencimento IS NULL) OR '
            '(validade_meses_congelada > 0 AND data_vencimento IS NOT NULL)',
            name='ck_certificado_vencimento',
        ),
        # nao se substitui por si mesmo: o ciclo transformaria a cadeia de
        # reemissao num laco que nenhuma tela sabe percorrer
        sa.CheckConstraint(
            'substituido_por_id IS NULL OR substituido_por_id <> id',
            name='ck_certificado_substituto',
        ),
        sa.CheckConstraint(
            'validade_meses_congelada >= 0', name='ck_certificado_validade'
        ),
        sa.ForeignKeyConstraint(
            ['anulado_por'], ['usuario.id'], name='fk_certificado_anulado_por'
        ),
        sa.ForeignKeyConstraint(
            ['arquivo_pdf_anexo_id'], ['anexo.id'], name='fk_certificado_pdf'
        ),
        sa.ForeignKeyConstraint(
            ['campus_id'], ['campus.id'], name='fk_certificado_campus'
        ),
        sa.ForeignKeyConstraint(
            ['emitido_por'], ['usuario.id'], name='fk_certificado_emitido_por'
        ),
        # sem ondelete: o certificado nao cai junto com a inscricao. Apagar uma
        # inscricao que ja produziu papel passa a ser recusado pelo banco, que e
        # o que se quer — documento emitido se anula, nao se apaga.
        sa.ForeignKeyConstraint(
            ['inscricao_id'], ['inscricao.id'], name='fk_certificado_inscricao'
        ),
        sa.ForeignKeyConstraint(
            ['modelo_id'], ['certificado_modelo.id'], name='fk_certificado_modelo'
        ),
        sa.ForeignKeyConstraint(
            ['participante_id'],
            ['participante.id'],
            name='fk_certificado_participante',
        ),
        sa.ForeignKeyConstraint(
            ['servidor_id'], ['servidor.id'], name='fk_certificado_servidor'
        ),
        sa.ForeignKeyConstraint(
            ['substituido_por_id'],
            ['certificado.id'],
            name='fk_certificado_substituto',
        ),
        sa.ForeignKeyConstraint(
            ['treinamento_id'], ['treinamento.id'], name='fk_certificado_treinamento'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_certificado'),
        sa.UniqueConstraint('chave_validacao', name='uq_certificado_chave'),
        sa.UniqueConstraint('numero', 'ano', name='uq_certificado'),
    )
    op.create_index('ix_certificado_inscricao', 'certificado', ['inscricao_id'])
    op.create_index('ix_certificado_participante', 'certificado', ['participante_id'])
    op.create_index('ix_certificado_servidor', 'certificado', ['servidor_id'])
    op.create_index('ix_certificado_treinamento', 'certificado', ['treinamento_id'])
    op.create_index('ix_certificado_vencimento', 'certificado', ['data_vencimento'])
    # PARCIAL: uma inscricao tem no maximo um certificado nao anulado. Um unique
    # comum sobre `inscricao_id` impediria a segunda emissao para sempre, e a
    # reemissao e justamente o remedio previsto para nome social, alteracao
    # civil e erro de digitacao (SS11, item 12 do desenho).
    op.create_index(
        'uq_certificado_ativo',
        'certificado',
        ['inscricao_id'],
        unique=True,
        sqlite_where=CERTIFICADO_ATIVO,
        postgresql_where=CERTIFICADO_ATIVO,
    )


def downgrade() -> None:
    # Inverso exato do upgrade: indices, depois `certificado` (que referencia
    # tudo), e so entao a sequencia, que nao e referenciada por ninguem.
    op.drop_index(
        'uq_certificado_ativo',
        table_name='certificado',
        sqlite_where=CERTIFICADO_ATIVO,
        postgresql_where=CERTIFICADO_ATIVO,
    )
    op.drop_index('ix_certificado_vencimento', table_name='certificado')
    op.drop_index('ix_certificado_treinamento', table_name='certificado')
    op.drop_index('ix_certificado_servidor', table_name='certificado')
    op.drop_index('ix_certificado_participante', table_name='certificado')
    op.drop_index('ix_certificado_inscricao', table_name='certificado')
    op.drop_table('certificado')
    op.drop_table('certificado_sequencia')
