"""Varre o que o relogio muda e a escrita nao alcanca: as pendencias de EPI.

Uso:
    python -m ferramentas.varrer_pendencias
    python -m ferramentas.varrer_pendencias --simular   (mostra e desfaz)

A saida:
    0 - varredura feita (ou simulada)
    1 - erro ao abrir o banco

**Por que existe.** Toda pendencia deste sistema nasce de uma ESCRITA — e
`epi_estoque.sincronizar_pendencia_de_ca` e `epi_ficha.sincronizar_pendencia_de_troca`
dizem, com todas as letras, o buraco que isso deixa: um lote parado atravessa
a janela dos 60 dias do CA sem abrir pendencia, e um servidor que nao recebe
nada de novo atravessa a data da troca sem que a tarefa com dono e prazo
apareca. As telas etiquetam desde o primeiro dia (calculam na hora); o que
atrasa e a fila. As duas funcoes tambem dizem a saida: "fechar esse buraco
pede um agendador". Este arquivo e o agendador — a rotina noturna, ao lado de
`conferir_cadeia` e do `backup_cli`.

**O que ela faz, e o que nao faz.** Chama as MESMAS duas funcoes que a
escrita chama, uma vez por lote com validade de CA e uma vez por servidor com
troca prevista. Nao ha regra nova aqui: a janela, o saldo, a inativacao, a
substituicao — tudo continua onde estava. Abrir e idempotente por chave, entao
rodar duas vezes nao duplica nada; e o que perdeu o objeto e FECHADO pela
mesma passada, que e o que a escrita ja fazia.

**Sem usuario, de proposito.** As pendencias abertas aqui nascem SEM dono
(`responsavel_id` nulo) e a linha da trilha sai sem `usuario`: as funcoes de
sincronizacao avisam que um laco disparado por GET "poria o nome de quem
apenas olhou o painel como responsavel", e o mesmo vale para a rotina — ela
nao e ninguem. Quem distribui as tarefas e a tela de pendencias.

**Tarefa agendada do Windows**, na maquina que vale (a de producao), ao lado
das outras duas e depois da conferencia da cadeia:

    schtasks /create /tn "CSSO - varrer pendencias" /sc daily /st 03:45 ^
      /tr "\\"C:\\Projetos\\Sistema CSSO\\.venv\\Scripts\\python.exe\\" -m ferramentas.varrer_pendencias"

O `/tr` precisa rodar com a pasta do repositorio como diretorio de trabalho,
ou `CSSO_ENV_FILE` apontado para o `.env` de producao — o mesmo requisito do
`BACKUP-AGORA.bat`.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.banco import sessao  # noqa: E402
from app.modelos import EpiEntradaEstoque, EpiFichaRegistro, Pendencia  # noqa: E402
from app.servicos import epi_estoque, epi_ficha  # noqa: E402

TIPOS_VARRIDOS = (epi_estoque.TIPO_PENDENCIA_CA, epi_ficha.TIPO_PENDENCIA_TROCA)


@dataclass
class Resultado:
    lotes: int = 0
    servidores: int = 0
    antes: dict[str, int] = field(default_factory=dict)
    depois: dict[str, int] = field(default_factory=dict)

    def abertas(self, tipo: str) -> int:
        return self.depois.get(tipo, 0) - self.antes.get(tipo, 0)


def _contar(s: Session) -> dict[str, int]:
    saida: dict[str, int] = {}
    for tipo in TIPOS_VARRIDOS:
        saida[tipo] = s.execute(
            select(Pendencia.id).where(Pendencia.tipo == tipo, Pendencia.concluida.is_(False))
        ).all().__len__()
    return saida


def varrer(s: Session, quando: date | None = None) -> Resultado:
    """A passada inteira, numa sessao — quem commita e quem chamou."""
    quando = quando or date.today()
    resultado = Resultado(antes=_contar(s))

    lotes = s.execute(
        select(EpiEntradaEstoque).where(EpiEntradaEstoque.validade_ca.is_not(None))
    ).scalars()
    for entrada in list(lotes):
        epi_estoque.sincronizar_pendencia_de_ca(s, entrada, None)
        resultado.lotes += 1

    servidores = s.execute(
        select(EpiFichaRegistro.servidor_id)
        .where(
            EpiFichaRegistro.tipo == "ENTREGA",
            EpiFichaRegistro.previsao_troca.is_not(None),
        )
        .distinct()
    ).scalars()
    for servidor_id in list(servidores):
        epi_ficha.sincronizar_trocas_do_servidor(s, servidor_id, None, quando)
        resultado.servidores += 1

    s.flush()
    resultado.depois = _contar(s)
    return resultado


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--simular", action="store_true", help="varre, mostra o que mudaria e desfaz"
    )
    args = parser.parse_args(argv)

    try:
        with sessao() as s:
            resultado = varrer(s)
            if args.simular:
                s.rollback()
            else:
                s.commit()
    except Exception as erro:  # noqa: BLE001 - e uma tarefa agendada: o log e a tela
        print(f"ERRO: {erro}", file=sys.stderr)
        return 1

    modo = "SIMULADA — nada gravado" if args.simular else "feita"
    print(
        f"Varredura {modo}: {resultado.lotes} lote(s) com CA e "
        f"{resultado.servidores} servidor(es) com troca prevista revistos."
    )
    for tipo in TIPOS_VARRIDOS:
        saldo = resultado.abertas(tipo)
        sinal = f"+{saldo}" if saldo > 0 else str(saldo)
        print(f"  {tipo}: {resultado.depois.get(tipo, 0)} aberta(s) ({sinal} nesta passada)")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
