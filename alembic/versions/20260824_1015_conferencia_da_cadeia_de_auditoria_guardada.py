"""conferencia da cadeia de auditoria guardada

Defeito Q-2 (`entrada/implantacao/00_PRONTIDAO.md` §3.2). `/auditoria` refazia o
encadeamento SHA-256 da tabela `historico_evento` INTEIRA a cada abertura,
dentro da requisicao, com o lock de escrita do SQLite na mao — toda transacao
deste sistema abre com `BEGIN IMMEDIATE` (RN-03, `app/banco.py`) e o toma ja no
SELECT do cookie.

Medido: ~55 us por evento — 43 ms com 1.292 eventos, 1.147 ms com 25.292,
2.743 ms com 50.292. Aos ~90 mil eventos uma unica abertura da tela passa dos
5 s de `busy_timeout` e derruba a tela de todos os outros com "database is
locked". A importacao do Trello e da planilha ja gravou 7.634 eventos de uma vez.

A tela passou a conferir so a janela exibida — os 100 eventos da pagina, custo
constante. O passe completo virou ato deliberado (o botao de `/auditoria` ou
`python -m ferramentas.conferir_cadeia`, para a tarefa agendada), roda com a
transacao SOLTA e guarda o resultado aqui, para a tela poder escrever "cadeia
conferida em <data>" em vez de refazer a conta.

**Uma tabela nova, e nenhuma coluna tocada em `historico_evento`.** A trilha nao
muda: ela e append-only por trigger, e acrescentar coluna a ela significaria
`batch_alter_table` — copiar, derrubar e renomear a tabela que existe
justamente para nao ser reescrita.

**Sem FK para `historico_evento`.** `ultimo_evento_id` e `primeiro_defeito_id`
apontam para a trilha por numero: a linha daqui e o LAUDO sobre aquela tabela, e
laudo que o banco recusa gravar porque o objeto do laudo mudou nao serve de
laudo. No dia em que um evento sumisse, e esta linha que precisa sobreviver para
dizer que sumiu.

`usuario_id` e anulavel porque a rotina agendada nao tem dono: ela roda pelo
agendador do Windows, sem sessao e sem cookie. `origem` e quem distingue os dois
casos, e a CHECK fecha o dominio.

A segunda CHECK amarra as duas colunas que so fazem sentido juntas: cadeia
rompida sem apontar onde e diagnostico sem endereco, e cadeia integra com
defeito apontado e contradicao gravada.

Revision ID: f3a6b21d9c85
Revises: e2f5a10c8b74
Create Date: 2026-08-24 10:15:02.481907+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.modelos.base  # noqa: F401  (tipo MomentoUTC)

revision: str = 'f3a6b21d9c85'
down_revision: str | None = 'e2f5a10c8b74'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'conferencia_cadeia',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('iniciada_em', app.modelos.base.MomentoUTC(), nullable=False),
        sa.Column('concluida_em', app.modelos.base.MomentoUTC(), nullable=False),
        # o numero que diz quando o passe completo deixa de caber num clique
        sa.Column('duracao_ms', sa.Integer(), nullable=False),
        sa.Column('eventos', sa.Integer(), nullable=False),
        sa.Column('ultimo_evento_id', sa.BigInteger(), nullable=True),
        sa.Column('integra', sa.Boolean(), nullable=False),
        sa.Column('primeiro_defeito_id', sa.BigInteger(), nullable=True),
        sa.Column('origem', sa.String(length=10), nullable=False),
        sa.Column('usuario_id', sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "origem IN ('BOTAO','ROTINA')", name='ck_conferencia_origem'
        ),
        sa.CheckConstraint(
            "(integra = 1 AND primeiro_defeito_id IS NULL) "
            "OR (integra = 0 AND primeiro_defeito_id IS NOT NULL)",
            name='ck_conferencia_defeito',
        ),
        sa.ForeignKeyConstraint(['usuario_id'], ['usuario.id']),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('conferencia_cadeia')
