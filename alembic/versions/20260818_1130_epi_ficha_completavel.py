"""epi: a ficha se completa uma vez, e nunca se reescreve

Fatia 2 do modulo Gestao de EPI. Nao ha tabela nova nem coluna nova: o esquema
inteiro do modulo nasceu em `0ce5a3128c79`. O que muda e **uma trava**.

`trg_epi_ficha_sem_update` recusava todo `UPDATE` em `epi_ficha_registro`. A
regra por tras dela continua inteira — a ficha e prova, e prova que se edita nao
e prova —, mas ela alcancava demais: tres colunas da linha so podem ser
preenchidas DEPOIS de a linha existir.

1. **`evento_id`.** O evento da cadeia de hash que registra a entrega precisa do
   `id` da ficha em `entidade_id`, e o `id` so nasce no `INSERT`. Com a trava
   antiga, ou a coluna ficava eternamente nula — e o §6.2 do desenho, que promete
   a prova "a um JOIN de distancia" em vez de uma busca por texto na trilha,
   virava letra morta — ou o `id` teria de ser sorteado antes com `MAX(id)+1`,
   que e exatamente o que a RN-03 proibe.
2. **`comprovante_anexo_id`.** A decisao 8 (18/08/2026) fixou que o comprovante e
   papel assinado no ato e digitalizado depois. Entre a entrega e o anexo existe
   uma janela real, e a decisao manda torna-la VISIVEL, nao esconde-la. Com a
   trava antiga, dizer onde esta a prova exigiria uma segunda tabela so para
   isso.
3. **`recebimento_confirmado_em`.** O momento em que a instituicao passou a ter a
   prova em maos. Anda junto com o anexo, pelo mesmo motivo.

A trava nova recusa:

- qualquer mudanca nas 26 colunas de conteudo — inclusive `id`, `quantidade`, os
  `*_snapshot`, `contexto_congelado`, `motivo` e `registro_estornado_id`;
- **reescrita** de qualquer uma das tres acima: elas vao de nulo para valor, uma
  vez, e nunca mais.

Completar um registro nao e reescreve-lo. Corrigir continua sendo `ESTORNO`:
linha nova, com motivo, com a errada visivel ao lado (RN-31, CA-16).

`DELETE` continua proibido sem ressalva — `trg_epi_ficha_sem_delete` nao e
tocada —, e as duas travas de `epi_movimento_estoque` tambem nao: o razao nasce
completo, nao tem nada a preencher depois.

Conferido a mao no que o `--autogenerate` produziria: nada. O gerador **nao
enxerga trigger** — e por isso que esta revisao existe escrita a mao, e por isso
que `alembic check` fica limpo antes e depois dela. O `downgrade` recria a
trava antiga literalmente a partir de `TRIGGERS_EPI`, que e a tupla historica e
nao foi editada.

Revision ID: 8f31b2c4d7a6
Revises: 0ce5a3128c79
Create Date: 2026-08-18 11:30:12.184402+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from app.banco import TRIGGERS_EPI, TRIGGERS_EPI_FICHA_COMPLETAVEL

revision: str = '8f31b2c4d7a6'
down_revision: str | None = '0ce5a3128c79'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for nome, ddl in TRIGGERS_EPI_FICHA_COMPLETAVEL:
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")
        op.execute(ddl)


def downgrade() -> None:
    # Volta a trava dura, exatamente como `0ce5a3128c79` a criou. So a que foi
    # substituida: recriar as quatro seria recriar tres identicas a si mesmas.
    substituidas = {nome for nome, _ in TRIGGERS_EPI_FICHA_COMPLETAVEL}
    for nome, ddl in TRIGGERS_EPI:
        if nome not in substituidas:
            continue
        op.execute(f"DROP TRIGGER IF EXISTS {nome}")
        op.execute(ddl)
