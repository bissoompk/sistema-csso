"""ck_anexo_cat com as categorias dos tres modulos, de uma vez

`anexo.categoria` fechava em oito valores, todos do Processos SEI. EPI,
Certificados e Acidentes trazem mais oito, e `anexos.guardar` levanta
`ValueError` em categoria que a lista nao tem — a rubrica do instrutor da fatia
1 de Certificados ja bate nisso.

Por que as oito juntas, antes das telas que as usam: estender a CHECK no SQLite
nao e ALTER, e reconstrucao. O `batch_alter_table` copia os dados para uma
tabela nova, derruba a antiga e recria; `anexo` tem dados, e referenciada e
obriga o `env.py` a suspender as FKs a cada passagem. Uma reconstrucao em vez de
tres e a diferenca entre um risco e o mesmo risco tres vezes.

A CHECK e o unico item deste par de migracoes que o `--autogenerate` NAO
detecta: o comparador confere CHECK por nome, e o nome nao mudou — so o texto
dentro. Escrito a mao, portanto.

O batch preserva os tres indices de `anexo`, inclusive o parcial
`uq_parecer_assinado_ativo` com o `WHERE` (conferido antes de aplicar), e a FK
anonima para `usuario`. Nada a recriar aqui.

Revision ID: d30b553943d1
Revises: ec4cbec9f658
Create Date: 2026-08-13 09:44:15.249222+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'd30b553943d1'
down_revision: str | None = 'ec4cbec9f658'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# As oito de sempre, mais MANUAL_EPI/FICHA_EPI (EPI), RUBRICA_INSTRUTOR/
# LISTA_PRESENCA/CERTIFICADO (Certificados) e CAT_SP/RELATORIO_INVESTIGACAO/
# EVIDENCIA_ACIDENTE (Acidentes). A lista tem de casar com `anexos.CATEGORIAS`.
CATEGORIAS_NOVAS = (
    "categoria IN ('PARECER_ASSINADO','LAUDO','PORTARIA','DESPACHO','FORMULARIO',"
    "'RELATORIO_CAMPO','FOTO','OUTRO',"
    "'MANUAL_EPI','FICHA_EPI',"
    "'RUBRICA_INSTRUTOR','LISTA_PRESENCA','CERTIFICADO',"
    "'CAT_SP','RELATORIO_INVESTIGACAO','EVIDENCIA_ACIDENTE')"
)

CATEGORIAS_ANTIGAS = (
    "categoria IN ('PARECER_ASSINADO','LAUDO','PORTARIA','DESPACHO','FORMULARIO',"
    "'RELATORIO_CAMPO','FOTO','OUTRO')"
)


def upgrade() -> None:
    with op.batch_alter_table('anexo', schema=None) as batch_op:
        batch_op.drop_constraint('ck_anexo_cat', type_='check')
        batch_op.create_check_constraint('ck_anexo_cat', CATEGORIAS_NOVAS)


def downgrade() -> None:
    # Confere ANTES de comecar. O SQLite aqui nao tem DDL transacional (o proprio
    # Alembic avisa: "Will assume non-transactional DDL"): se a copia do batch
    # estourasse no meio, a tabela `_alembic_tmp_anexo` ficaria para tras e a
    # proxima tentativa falharia com "table already exists" — erro que nao diz
    # nada sobre a causa. Melhor recusar antes de tocar em qualquer DDL, com a
    # lista do que precisa ser reclassificado.
    presas = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT DISTINCT categoria FROM anexo WHERE NOT (" + CATEGORIAS_ANTIGAS + ")"
            )
        )
        .scalars()
        .all()
    )
    if presas:
        raise RuntimeError(
            "ha anexo gravado em categoria que a CHECK antiga nao admite: "
            + ", ".join(sorted(presas))
            + ". Reclassifique ou remova esses anexos antes de descer — descer por "
            "cima deles apagaria a prova ou mentiria sobre o que ela e."
        )

    with op.batch_alter_table('anexo', schema=None) as batch_op:
        batch_op.drop_constraint('ck_anexo_cat', type_='check')
        batch_op.create_check_constraint('ck_anexo_cat', CATEGORIAS_ANTIGAS)
