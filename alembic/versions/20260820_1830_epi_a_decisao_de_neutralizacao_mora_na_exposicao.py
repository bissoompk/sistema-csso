"""epi: a decisao de neutralizacao mora na exposicao

Fatia 6 do modulo Gestao de EPI — a ligacao com o adicional ocupacional (§7 do
desenho). Tres colunas em `exposicao` e duas CHECK. **Nenhuma tabela nova e
nenhuma FK para tabela de EPI**, e a ausencia da FK e a decisao, nao a economia:
o modulo de EPI publica uma consulta de leitura e o parecer a consome. Amarrar
`exposicao` a `epi_ficha_registro` faria o esquema do documento assinado
depender do esquema do almoxarifado — e a prova de qual ficha sustentou a
conclusao ja tem lugar melhor, o `contexto_congelado` do proprio parecer, que e
imutavel por definicao (RN-15).

**As colunas.**

1. `epi_neutraliza` — `NAO_AVALIADO` por padrao, e por isso `server_default`: a
   coluna e NOT NULL e a tabela ja tem linhas em producao. Parecer antigo nao
   avaliou EPI nenhum, e dizer "nao avaliado" e a unica coisa verdadeira que se
   pode escrever retroativamente na exposicao de outra pessoa.
2. `justificativa_epi` — anulavel, cobrada pela segunda CHECK quando a alegacao
   e de neutralizacao.
3. `epi_avaliado_em` — a data em que a alegacao foi conferida. Existe porque a
   validade do CA e a troca devida se leem NAQUELA data, e nao hoje: um CA que
   valia na avaliacao e venceu depois nao invalida o parecer que ja foi emitido.

**As CHECK.** `ck_exposicao_epi` fecha o dominio; `ck_exposicao_epi_justificada`
cobra o porque por escrito de quem alega neutralizacao — mesmo molde do
`ck_excecao`, que ja cobra a justificativa do art. 9º, parágrafo único.

A trava que **nao** esta aqui, e nao poderia estar: a regra de que so
insalubridade admite neutralizacao. Ela depende de `tipo_adicional.codigo`, que
mora a dois JOINs de distancia (`exposicao` → `percentual_aplicavel` →
`tipo_adicional`), e CHECK de SQLite nao faz subconsulta. Fica onde o §7.1 manda
que fique — regra de servico, em `parecer.registrar_avaliacao_de_epi`, com
teste que tenta neutralizar periculosidade e exige a recusa.

**O que foi corrigido a mao no que o `--autogenerate` produziria**, tudo
reincidente neste repositorio:

1. **`import app.modelos.base`**, que o gerador usa em `DataPura()` e nunca
   importa. E a sexta migracao seguida.
2. **`server_default` na coluna NOT NULL**, que o gerador nao poe — e sem o qual
   o `batch` falha na primeira linha existente de `exposicao`.
3. **Nenhum `drop_constraint(None)`**: as duas CHECK tem nome literal, escrito
   igual no modelo e aqui.

`batch_alter_table` no SQLite nao e um `ALTER`: e copiar a tabela, derrubar a
antiga e renomear. Foi conferido no banco descartavel que os dois indices de
`exposicao` voltam intactos — inclusive o `uq_exposicao_principal`, que e
PARCIAL (`WHERE principal IS 1`) e viraria uma unica dura sobre `parecer_id` se
a clausula se perdesse, impedindo o segundo agente de qualquer parecer. Nenhuma
FK aponta para `exposicao` e nenhuma trigger esta presa a ela, entao o
`_fk_suspensas` do `env.py` nao tem trabalho aqui — mas ele continua sendo a
rede, e o `PRAGMA foreign_key_check` do fim confirma.

O `downgrade` e o inverso exato e na ordem inversa: as duas CHECK saem antes das
colunas que elas mencionam, e as tres colunas saem na ordem contraria a da
criacao.

Revision ID: e2f5a10c8b74
Revises: c1d9e47a2b30
Create Date: 2026-08-20 18:30:44.719283+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipo DataPura)

revision: str = 'e2f5a10c8b74'
down_revision: str | None = 'c1d9e47a2b30'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('exposicao', schema=None) as batch_op:
        # server_default: a coluna e NOT NULL e a tabela pode ja ter linhas —
        # mesmo caminho de `classificacao_origem` em `ad69609daba3`
        batch_op.add_column(
            sa.Column(
                'epi_neutraliza',
                sa.String(length=20),
                nullable=False,
                server_default='NAO_AVALIADO',
            )
        )
        batch_op.add_column(sa.Column('justificativa_epi', sa.Text(), nullable=True))
        batch_op.add_column(
            sa.Column('epi_avaliado_em', app.modelos.base.DataPura(), nullable=True)
        )
        batch_op.create_check_constraint(
            'ck_exposicao_epi',
            "epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA',"
            "'NEUTRALIZA_PARCIAL','NEUTRALIZA')",
        )
        batch_op.create_check_constraint(
            'ck_exposicao_epi_justificada',
            "epi_neutraliza IN ('NAO_AVALIADO','NAO_NEUTRALIZA') "
            "OR justificativa_epi IS NOT NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table('exposicao', schema=None) as batch_op:
        batch_op.drop_constraint('ck_exposicao_epi_justificada', type_='check')
        batch_op.drop_constraint('ck_exposicao_epi', type_='check')
        batch_op.drop_column('epi_avaliado_em')
        batch_op.drop_column('justificativa_epi')
        batch_op.drop_column('epi_neutraliza')
