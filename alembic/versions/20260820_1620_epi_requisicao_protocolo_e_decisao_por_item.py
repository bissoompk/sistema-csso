"""epi: requisicao, protocolo e decisao por item

Fatia 4 do modulo Gestao de EPI. Tres tabelas novas —
`epi_requisicao_sequencia`, `epi_requisicao` e `epi_requisicao_item` — e as
DUAS chaves estrangeiras que o modulo devia desde a fatia 2.

**As FKs prometidas.** `epi_ficha_registro.requisicao_item_id` e
`epi_movimento_estoque.requisicao_item_id` nasceram `Integer` sem FK em
`0ce5a3128c79`, porque `epi_requisicao_item` nao existia e declarar a FK seria
escrever no esquema uma promessa que o banco nao consegue cobrar. Agora ela
existe, e a promessa se cumpre — mas o preco no SQLite e alto e esta dito aqui:
`batch_alter_table` nao e um `ALTER`, e sim copiar a tabela para uma nova,
derrubar a antiga e renomear. **As duas tabelas reconstruidas sao justamente as
duas append-only do modulo**, e as travas delas sao objetos de esquema presos a
tabela: o `DROP TABLE` leva as triggers junto, em silencio, e o autogenerate nao
enxerga nenhuma das duas coisas.

Por isso as travas sao recriadas no fim do `upgrade`, a partir de `app/banco.py`
— as tres de `TRIGGERS_EPI` que sobreviveram (as duas do razao e o
`sem_delete` da ficha) mais a revista de `TRIGGERS_EPI_FICHA_COMPLETAVEL`, que e
o estado corrente da trava desde `8f31b2c4d7a6`. Uma tabela de prova que passa
uma migracao aceitando `UPDATE` e uma tabela cujo historico ninguem consegue
mais afirmar que esta intacto.

**O que foi corrigido a mao no que o `--autogenerate` produziu**, tudo
reincidente:

1. **Faltava `import app.modelos.base`.** O arquivo gerado usa
   `app.modelos.base.MomentoUTC()` em seis colunas e nunca importa o modulo —
   `NameError` no primeiro `upgrade`. E a quinta migracao seguida.
2. **Os seis indices em `batch_alter_table`.** Trocados por `op.create_index`
   direto: `batch` existe para o `ALTER` que o SQLite nao tem, e criar indice em
   tabela recem-criada nao precisa de copia de tabela nenhuma — muito menos de
   uma copia a mais de duas tabelas append-only.
3. **`sa.UniqueConstraint('protocolo')` sem nome**, que no SQLite viraria um
   `sqlite_autoindex` anonimo: sem nome, o `downgrade` de uma revisao futura nao
   tem como derruba-lo. Nomeado `uq_req_protocolo` no modelo.
4. **As travas append-only**, acima.
5. **Os comentarios `### commands auto generated ###`**, trocados pelo texto que
   explica por que cada CHECK esta escrita daquele jeito.

O `downgrade` e o inverso exato: derruba as travas, solta as duas FKs (em batch,
porque no SQLite nao ha `DROP CONSTRAINT`), recria as travas sobre as tabelas
reconstruidas, derruba os indices e as tabelas na ordem topologica inversa —
`epi_requisicao_item` referencia `epi_requisicao`, que nao referencia nenhuma
das duas. **Nenhum `drop_constraint(None)`**: as seis restricoes nomeadas tem
nome literal.

Revision ID: c1d9e47a2b30
Revises: 4b7c1e93af58
Create Date: 2026-08-20 16:20:11.402913+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipos MomentoUTC/DataPura/JSONTexto)
from app.banco import TRIGGERS_EPI, TRIGGERS_EPI_FICHA_COMPLETAVEL

revision: str = 'c1d9e47a2b30'
down_revision: str | None = '4b7c1e93af58'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# As travas que valem para as duas tabelas append-only NESTE ponto da historia:
# as de `TRIGGERS_EPI` que nao foram substituidas, mais a revista da ficha
# (`8f31b2c4d7a6`). Montada aqui, e nao lida de `TRIGGERS`, porque `TRIGGERS`
# cresce com os modulos futuros — e migracao le o passado.
_SUBSTITUIDAS = {nome for nome, _ in TRIGGERS_EPI_FICHA_COMPLETAVEL}
TRAVAS_VIGENTES: tuple[tuple[str, str], ...] = (
    tuple(t for t in TRIGGERS_EPI if t[0] not in _SUBSTITUIDAS)
    + TRIGGERS_EPI_FICHA_COMPLETAVEL
)


def _recriar_travas() -> None:
    """`batch_alter_table` derruba a tabela, e a trigger vai junto — sem aviso.

    Chamada nas duas direcoes: o `downgrade` reconstroi as mesmas duas tabelas
    para tirar as FKs, e sair dele com a ficha aceitando `UPDATE` seria pior do
    que a migracao que se quis desfazer.
    """
    for nome, ddl in TRAVAS_VIGENTES:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")
        op.execute(ddl)


def upgrade() -> None:
    op.create_table(
        'epi_requisicao_sequencia',
        # `autoincrement=False`: o ano NAO e um contador, e a chave. Sem isso o
        # SQLite trata `INTEGER PRIMARY KEY` como rowid e 2026 viraria um id
        # sorteado pelo banco.
        sa.Column('ano', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('ultimo_numero', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('ano', name='pk_epi_requisicao_sequencia'),
    )

    op.create_table(
        'epi_requisicao',
        sa.Column('id', sa.Integer(), nullable=False),
        # `EPI-2026-0001` para ler; `numero`+`ano` para a RN-03 conferir. A
        # sequencia pula numero ja ocupado comparando INTEIRO com inteiro, e nao
        # ha como fazer isso contra um texto formatado.
        sa.Column('protocolo', sa.String(length=16), nullable=True),
        sa.Column('numero', sa.Integer(), nullable=True),
        sa.Column('ano', sa.Integer(), nullable=True),
        sa.Column('servidor_id', sa.Integer(), nullable=False),
        sa.Column('solicitado_por_id', sa.Integer(), nullable=False),
        sa.Column('chefia_servidor_id', sa.Integer(), nullable=True),
        # --- congelado no ENVIO: a pessoa muda de setor, o pedido nao (RN-15) ---
        sa.Column('unidade_uorg_id', sa.Integer(), nullable=True),
        sa.Column('campus_id', sa.Integer(), nullable=True),
        sa.Column('posto_trabalho_id', sa.Integer(), nullable=True),
        sa.Column('cargo_snapshot', sa.String(length=120), nullable=True),
        sa.Column('funcao_snapshot', sa.String(length=120), nullable=True),
        sa.Column('finalidade', sa.String(length=20), nullable=False),
        sa.Column('descricao_atividade', sa.Text(), nullable=True),
        sa.Column('riscos_declarados', sa.Text(), nullable=True),
        sa.Column('urgencia', sa.String(length=10), nullable=False),
        sa.Column('justificativa_urgencia', sa.Text(), nullable=True),
        sa.Column('estado', sa.String(length=16), nullable=False),
        sa.Column('estado_anterior', sa.String(length=16), nullable=True),
        sa.Column('entrou_no_estado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('analisado_por', sa.Integer(), nullable=True),
        sa.Column('analisado_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('parecer_analise', sa.Text(), nullable=True),
        sa.Column('motivo_recusa_id', sa.Integer(), nullable=True),
        sa.Column('complemento_recusa', sa.Text(), nullable=True),
        sa.Column('motivo_cancelamento', sa.Text(), nullable=True),
        sa.Column('enviada_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.Column('criado_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('versao', sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "estado IN ('RASCUNHO','ENVIADA','EM_ANALISE','ANALISADA',"
            "'EM_ATENDIMENTO','ATENDIDA','INDEFERIDA','CANCELADA')",
            name='ck_req_estado',
        ),
        sa.CheckConstraint("urgencia IN ('NORMAL','URGENTE')", name='ck_req_urgencia'),
        # "urgente" sem justificativa vira o padrao de todo mundo e deixa de
        # ordenar a fila — que e a unica coisa para que a coluna serve
        sa.CheckConstraint(
            "urgencia <> 'URGENTE' OR justificativa_urgencia IS NOT NULL",
            name='ck_req_urgencia_justificada',
        ),
        sa.CheckConstraint(
            "finalidade IN ('PRIMEIRA_ENTREGA','ROTINA','SUBSTITUICAO','DANO','PERDA')",
            name='ck_req_finalidade',
        ),
        # rascunho e a unica coisa sem protocolo; tudo o mais ja foi protocolado
        sa.CheckConstraint(
            "(estado = 'RASCUNHO') = (protocolo IS NULL)", name='ck_req_protocolo'
        ),
        # as tres colunas do protocolo andam juntas ou nao andam: `numero` sem
        # `protocolo` seria numero consumido que nao aparece em documento nenhum
        sa.CheckConstraint(
            '(protocolo IS NULL) = (numero IS NULL) AND '
            '(protocolo IS NULL) = (ano IS NULL)',
            name='ck_req_numero',
        ),
        # RN-27: indeferir e recusa fundamentada, e recusa sem motivo do catalogo
        # e a recusa em texto livre do legado de volta
        sa.CheckConstraint(
            "estado <> 'INDEFERIDA' OR motivo_recusa_id IS NOT NULL",
            name='ck_req_indeferida',
        ),
        # RN-31: requisicao enviada nao se exclui, cancela com motivo — e o banco
        # cobra o motivo, porque cancelamento sem explicacao e pedido que sumiu
        sa.CheckConstraint(
            "estado <> 'CANCELADA' OR motivo_cancelamento IS NOT NULL",
            name='ck_req_cancelada',
        ),
        sa.ForeignKeyConstraint(
            ['analisado_por'], ['usuario.id'], name='fk_epi_req_analisado_por'
        ),
        sa.ForeignKeyConstraint(['campus_id'], ['campus.id'], name='fk_epi_req_campus'),
        sa.ForeignKeyConstraint(
            ['chefia_servidor_id'], ['servidor.id'], name='fk_epi_req_chefia'
        ),
        sa.ForeignKeyConstraint(
            ['motivo_recusa_id'], ['epi_motivo_recusa.id'], name='fk_epi_req_motivo'
        ),
        sa.ForeignKeyConstraint(
            ['posto_trabalho_id'], ['posto_trabalho.id'], name='fk_epi_req_posto'
        ),
        sa.ForeignKeyConstraint(
            ['servidor_id'], ['servidor.id'], name='fk_epi_req_servidor'
        ),
        sa.ForeignKeyConstraint(
            ['solicitado_por_id'], ['usuario.id'], name='fk_epi_req_solicitado_por'
        ),
        sa.ForeignKeyConstraint(
            ['unidade_uorg_id'], ['unidade_uorg.id'], name='fk_epi_req_unidade'
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_requisicao'),
        sa.UniqueConstraint('protocolo', name='uq_req_protocolo'),
        sa.UniqueConstraint('ano', 'numero', name='uq_req_numero'),
    )
    op.create_index('ix_req_estado', 'epi_requisicao', ['estado'])
    op.create_index('ix_req_servidor', 'epi_requisicao', ['servidor_id'])
    op.create_index('ix_req_unidade', 'epi_requisicao', ['unidade_uorg_id'])

    op.create_table(
        'epi_requisicao_item',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('requisicao_id', sa.Integer(), nullable=False),
        sa.Column('epi_item_id', sa.Integer(), nullable=False),
        sa.Column('tamanho', sa.String(length=20), nullable=True),
        # quatro quantidades e um estado, no lugar das doze colunas do legado
        sa.Column('quantidade_solicitada', sa.SmallInteger(), nullable=False),
        sa.Column('quantidade_aprovada', sa.SmallInteger(), nullable=True),
        sa.Column('quantidade_reservada', sa.SmallInteger(), nullable=False),
        sa.Column('quantidade_entregue', sa.SmallInteger(), nullable=False),
        sa.Column('entrada_id', sa.Integer(), nullable=True),
        sa.Column('justificativa', sa.Text(), nullable=True),
        sa.Column('excedeu_maximo', sa.Boolean(), nullable=False),
        sa.Column('autorizado_por', sa.Integer(), nullable=True),
        sa.Column('estado', sa.String(length=14), nullable=False),
        sa.Column('motivo_recusa_id', sa.Integer(), nullable=True),
        sa.Column('complemento_recusa', sa.Text(), nullable=True),
        sa.Column('texto_recusa_snapshot', sa.Text(), nullable=True),
        sa.Column('decidido_por', sa.Integer(), nullable=True),
        sa.Column('decidido_em', app.modelos.base.MomentoUTC(), nullable=True),
        sa.CheckConstraint(
            "estado IN ('SOLICITADO','APROVADO','RESERVADO','SEM_ESTOQUE',"
            "'ENTREGUE','RECUSADO','CANCELADO')",
            name='ck_req_item_estado',
        ),
        sa.CheckConstraint('quantidade_solicitada > 0', name='ck_item_solicitada'),
        # aprovar so reduz: aprovar MAIS do que se pediu seria o setor decidindo
        # sozinho o que a pessoa vai receber, sem que ela tenha pedido
        sa.CheckConstraint(
            'quantidade_aprovada IS NULL OR '
            '(quantidade_aprovada >= 0 AND quantidade_aprovada <= quantidade_solicitada)',
            name='ck_item_aprovada',
        ),
        sa.CheckConstraint(
            'quantidade_entregue <= COALESCE(quantidade_aprovada, quantidade_solicitada)',
            name='ck_item_entregue',
        ),
        sa.CheckConstraint(
            'quantidade_reservada <= COALESCE(quantidade_aprovada, quantidade_solicitada)',
            name='ck_item_reservada',
        ),
        # RN-27: a negativa que a pessoa recebeu e a que fica. Sem o texto
        # congelado, editar o catalogo amanha reescreveria a recusa de ontem.
        sa.CheckConstraint(
            "estado <> 'RECUSADO' OR "
            '(motivo_recusa_id IS NOT NULL AND texto_recusa_snapshot IS NOT NULL)',
            name='ck_item_recusado',
        ),
        # RN-26: estourar o maximo exige nome e justificativa. `NOT
        # excedeu_maximo`, e nao `excedeu_maximo = 0`, porque no PostgreSQL —
        # dialeto de referencia do projeto — booleano nao se compara com inteiro.
        sa.CheckConstraint(
            'NOT excedeu_maximo OR '
            '(autorizado_por IS NOT NULL AND justificativa IS NOT NULL)',
            name='ck_item_excecao',
        ),
        # reserva sem lote nao reserva nada: e o lote que tem saldo e CA
        sa.CheckConstraint(
            "estado <> 'RESERVADO' OR entrada_id IS NOT NULL", name='ck_item_lote'
        ),
        sa.ForeignKeyConstraint(
            ['autorizado_por'], ['usuario.id'], name='fk_epi_req_item_autorizado_por'
        ),
        sa.ForeignKeyConstraint(
            ['decidido_por'], ['usuario.id'], name='fk_epi_req_item_decidido_por'
        ),
        sa.ForeignKeyConstraint(
            ['entrada_id'],
            ['epi_entrada_estoque.id'],
            name='fk_epi_req_item_entrada',
        ),
        sa.ForeignKeyConstraint(
            ['epi_item_id'], ['epi_item.id'], name='fk_epi_req_item_epi'
        ),
        sa.ForeignKeyConstraint(
            ['motivo_recusa_id'],
            ['epi_motivo_recusa.id'],
            name='fk_epi_req_item_motivo',
        ),
        # CASCADE porque rascunho e o unico estado que some de verdade (RN-31), e
        # apagar o envelope tem de levar as linhas dele: linha orfa de um pedido
        # que nao existe e exatamente o que o `foreign_key_check` do `env.py`
        # existe para nao deixar passar.
        sa.ForeignKeyConstraint(
            ['requisicao_id'],
            ['epi_requisicao.id'],
            name='fk_epi_req_item_req',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_epi_requisicao_item'),
        sa.UniqueConstraint(
            'requisicao_id', 'epi_item_id', 'tamanho', name='uq_req_item'
        ),
    )
    op.create_index('ix_req_item_estado', 'epi_requisicao_item', ['estado'])
    op.create_index('ix_req_item_motivo', 'epi_requisicao_item', ['motivo_recusa_id'])
    op.create_index(
        'ix_req_item_reserva', 'epi_requisicao_item', ['entrada_id', 'estado']
    )

    # As duas FKs prometidas em `0ce5a3128c79`. Reconstroem a tabela — ver o
    # cabecalho — e por isso as travas voltam logo abaixo.
    with op.batch_alter_table('epi_ficha_registro', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_epi_ficha_requisicao_item',
            'epi_requisicao_item',
            ['requisicao_item_id'],
            ['id'],
        )
    with op.batch_alter_table('epi_movimento_estoque', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_epi_movimento_requisicao_item',
            'epi_requisicao_item',
            ['requisicao_item_id'],
            ['id'],
        )
    _recriar_travas()


def downgrade() -> None:
    # Inverso exato: as FKs saem primeiro (elas apontam para a tabela que vai
    # cair), as travas voltam sobre as tabelas reconstruidas, e so entao os
    # indices e as tabelas, na ordem topologica inversa.
    with op.batch_alter_table('epi_movimento_estoque', schema=None) as batch_op:
        batch_op.drop_constraint('fk_epi_movimento_requisicao_item', type_='foreignkey')
    with op.batch_alter_table('epi_ficha_registro', schema=None) as batch_op:
        batch_op.drop_constraint('fk_epi_ficha_requisicao_item', type_='foreignkey')
    _recriar_travas()

    op.drop_index('ix_req_item_reserva', table_name='epi_requisicao_item')
    op.drop_index('ix_req_item_motivo', table_name='epi_requisicao_item')
    op.drop_index('ix_req_item_estado', table_name='epi_requisicao_item')
    op.drop_table('epi_requisicao_item')

    op.drop_index('ix_req_unidade', table_name='epi_requisicao')
    op.drop_index('ix_req_servidor', table_name='epi_requisicao')
    op.drop_index('ix_req_estado', table_name='epi_requisicao')
    op.drop_table('epi_requisicao')

    op.drop_table('epi_requisicao_sequencia')
