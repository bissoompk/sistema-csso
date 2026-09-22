"""Confere o encadeamento SHA-256 da trilha de auditoria, inteiro.

Uso:
    python -m ferramentas.conferir_cadeia

A saida:
    0 - cadeia integra
    1 - cadeia rompida (o evento e impresso)
    2 - ja ha uma conferencia em andamento nesta maquina

Esta e a "rotina noturna" da correcao do defeito Q-2: ate a 1.32.0 a tela de
`/auditoria` refazia a cadeia inteira a cada abertura, dentro da requisicao, com
o lock de escrita do SQLite na mao. A tela passou a conferir so os eventos que
exibe; o passe completo saiu de la e veio para ca (e para o botao da propria
tela), e o resultado fica guardado em `conferencia_cadeia` — a tela le a data
dali em vez de refazer a conta.

Roda com a transacao SOLTA e por uma conexao que nao disputa escrita
(`auditoria.conferir_fora_da_transacao`), entao pode rodar com o setor
trabalhando. Ainda assim, o lugar dela e a madrugada: ela le a trilha inteira e
custa segundos de CPU numa base grande.

**Tarefa agendada do Windows**, ao lado da do `backup_cli` — e nao a memoria de
alguem:

    schtasks /create /tn "CSSO - conferir cadeia" /sc daily /st 03:30 ^
      /tr "\"C:\\Projetos\\Sistema CSSO\\.venv\\Scripts\\python.exe\" -m ferramentas.conferir_cadeia"

O `/tr` precisa rodar com a pasta do repositorio como diretorio de trabalho, ou
`CSSO_ENV_FILE` apontado para o `.env` de producao — e o mesmo requisito do
`BACKUP-AGORA.bat`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.banco import sessao  # noqa: E402
from app.servicos import auditoria  # noqa: E402


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--origem",
        default=auditoria.ORIGEM_ROTINA,
        choices=(auditoria.ORIGEM_ROTINA, auditoria.ORIGEM_BOTAO),
        help="como a conferência fica registrada (padrão: ROTINA)",
    )
    args = parser.parse_args(argv)

    with sessao() as s:
        try:
            resultado = auditoria.conferir_fora_da_transacao(s, origem=args.origem)
        except auditoria.ConferenciaEmCurso as erro:
            print(f"ERRO: {erro}", file=sys.stderr)
            return 2

    quando = resultado.concluida_em.isoformat()
    if resultado.integra:
        print(
            f"Cadeia íntegra: {resultado.eventos} evento(s) conferidos em "
            f"{resultado.duracao_ms} ms ({quando})."
        )
        return 0

    # A ordem importa: o que quebrou vem primeiro, e o resto é contexto. Quem lê
    # isto está lendo o log de uma tarefa agendada às 3h30.
    print(
        f"CADEIA ROMPIDA no evento {resultado.primeiro_defeito_id}. "
        f"Os {resultado.eventos} eventos até ali conferem; daquele ponto em "
        "diante a trilha deixa de provar que nada foi alterado.\n"
        "Preserve o arquivo do banco como está e trate como incidente — isto "
        "não se conserta pela tela.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(principal())
