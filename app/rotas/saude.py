"""/saude, /saude/detalhe e /saude/db — o que a porta responde a quem não entrou.

Três respostas, e a diferença entre elas é deliberada:

- **`/saude`** é a única sem autenticação, e diz uma coisa só: o processo está de
  pé. Ela respondia também a versão exata, o ambiente e a lista de avisos de
  configuração (`entrada/implantacao/00_PRONTIDAO.md` §S-2). Versão exata é o que
  se usa para escolher a vulnerabilidade certa de uma dependência, e o campo
  `avisos` é desenhado para publicar justamente as falhas de configuração — se a
  chave secreta voltar ao valor de exemplo, ele anuncia isso a quem perguntar. Um
  teste de vida não precisa de nada disso. **E ela não toca no banco**: toda
  sessão deste sistema abre com `BEGIN IMMEDIATE` e toma o lock de escrita
  (`app/banco.py:19-40`), então identificar quem está chamando custaria
  exatamente o que esta rota não pode custar.
- **`/saude/detalhe`** entrega versão, ambiente e avisos a quem entrou. Não é
  segredo — os avisos já saem na casca de toda tela (`app/web.py:151`) e a versão
  está em `/config`. É a mesma informação, atrás da porta.
- **`/saude/db`** confere a integridade do arquivo do banco e conta processos e
  pareceres. Era pública, e `PRAGMA integrity_check` lê o banco INTEIRO — 248 ms
  medidos num banco de 16,7 MB, e cresce com ele (§S-1). Sem login, isso é um laço
  de requisições a uma URL de nove caracteres travando o setor de graça, mais o
  número de processos e pareceres cadastrados entregue de brinde.
"""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import func, select

from app.banco import integridade_ok
from app.config import VERSAO, obter_config
from app.dependencias import SessaoDep, UsuarioDep
from app.servicos.rbac import PermissaoNegada

rotas = APIRouter(tags=["saude"])

# Quem confere a saúde do banco: quem opera a máquina ou quem responde pela
# trilha. É a mesma repartição de `/config` (`PERMISSOES_CONFIG`), e pelo mesmo
# motivo — `admin_ti` não tem `processo.ver` e é justamente ele quem cuida do
# arquivo. Qualquer uma das duas basta; exigir as duas trancaria a tela para os
# dois perfis que existem para ela.
PERMISSOES_SAUDE_DB: tuple[str, ...] = ("backup.executar", "auditoria.ver")


@rotas.get("/saude")
def saude() -> dict:
    return {"status": "ok"}


@rotas.get("/saude/detalhe")
def detalhe(usuario: UsuarioDep) -> dict:
    cfg = obter_config()
    return {
        "status": "ok",
        "versao": VERSAO,
        "ambiente": cfg.ambiente,
        "avisos": cfg.inseguro,
    }


@rotas.get("/saude/db")
def saude_db(s: SessaoDep, usuario: UsuarioDep) -> dict:
    """Contagens dentro da transação; `integrity_check` **fora** dela.

    O `s.commit()` no meio não é enfeite: até ele, esta requisição segura o lock
    de escrita como qualquer outra, e a verificação de integridade é a operação
    mais demorada que este sistema executa numa requisição. Soltar antes troca
    "todo mundo espera 250 ms" por "ninguém espera" — e é a mesma correção que
    §S-1 pede, feita onde dá para fazer sem fila de tarefas.
    """
    from app.modelos import ParecerTecnico, Processo

    if not any(usuario.pode(codigo) for codigo in PERMISSOES_SAUDE_DB):
        raise PermissaoNegada(
            PERMISSOES_SAUDE_DB[0],
            "A conferência do banco abre para quem opera a máquina "
            "(`backup.executar`) ou responde pela trilha (`auditoria.ver`).",
        )

    processos = s.execute(select(func.count()).select_from(Processo)).scalar_one()
    pareceres = s.execute(select(func.count()).select_from(ParecerTecnico)).scalar_one()
    s.commit()

    ok, detalhe_integridade = integridade_ok()
    return {
        "status": "ok" if ok else "falha",
        "integrity_check": detalhe_integridade,
        "processos": processos,
        "pareceres": pareceres,
        "versao": VERSAO,
    }
