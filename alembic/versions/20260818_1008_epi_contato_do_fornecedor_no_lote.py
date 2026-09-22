"""epi: contato do fornecedor no lote

Fatia 3 do modulo Gestao de EPI. Uma coluna, anulavel:
`epi_entrada_estoque.fornecedor_contato`.

**Por que ela existe.** A entrada de lote e rastreabilidade de compra publica —
pregao, item do pregao, empenho, nota fiscal, fornecedor, valor. O legado
guardava `Fornecedor_*` (nome, CNPJ e contato); o §3.4 do desenho transcreveu os
dois primeiros e perdeu o terceiro. Sem ele a trilha para na nota fiscal: quando
o CA do lote vence, quando o produto sai defeituoso ou quando falta parte do
empenhado, quem opera o almoxarifado precisa acionar a empresa e nao tem por
onde.

O campo e o canal INSTITUCIONAL da empresa — telefone ou e-mail de vendas —, e
nao o nome de um vendedor. Fornecedor e pessoa juridica: guardar o canal da
empresa e o que a rastreabilidade pede, e nao ha necessidade (LGPD art. 6º, III)
de guardar a identificacao de uma pessoa la dentro. A dica do formulario diz
isso a quem preenche.

**O que o autogenerate produziu e o que foi corrigido a mao.** Ele gerou
`batch_alter_table` nas duas direcoes. No SQLite `batch` nao e um `ALTER`: e
copiar a tabela inteira para uma nova, derrubar a antiga e renomear — e
`epi_entrada_estoque` e referenciada por `epi_movimento_estoque` e por
`epi_ficha_registro`, que sao as duas tabelas append-only do modulo. Reconstruir
a tabela apontada por elas para acrescentar uma coluna anulavel e risco sem
contrapartida: `ADD COLUMN` anulavel e suportado nativamente pelo SQLite e pelo
PostgreSQL, e nao toca em indice, em chave estrangeira nem em dado.

O `downgrade` usa `batch` porque ai nao ha escolha — `DROP COLUMN` so existe no
SQLite a partir da 3.35 e o alembic o resolve por reconstrucao. Ele derruba
apenas o contato: nenhuma outra coluna, nenhum movimento, nenhuma linha de
ficha.

Nao ha trigger nem CHECK nesta revisao. As quatro travas append-only do modulo
(`0ce5a3128c79`) e a trava revista da ficha (`8f31b2c4d7a6`) continuam como
estao — o autogenerate nao enxerga nenhuma das duas coisas, e por isso a
conferencia foi feita lendo `app/banco.py`, nao confiando no gerador.

Revision ID: 4b7c1e93af58
Revises: 8f31b2c4d7a6
Create Date: 2026-08-18 10:08:57.355244+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '4b7c1e93af58'
down_revision: str | None = '8f31b2c4d7a6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "epi_entrada_estoque",
        sa.Column("fornecedor_contato", sa.String(length=120), nullable=True),
    )


def downgrade() -> None:
    with op.batch_alter_table("epi_entrada_estoque", schema=None) as batch_op:
        batch_op.drop_column("fornecedor_contato")
