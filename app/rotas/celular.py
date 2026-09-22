"""`/celular` — a tela de bolso do balcão e da chamada, em cima da `/api/v1`.

**O que é.** Uma página só, sem lateral, com dois trabalhos: entregar EPI no
balcão e transcrever a folha de presença de um dia. É o pedaço pequeno em que
a fase 2 do plano de adesão (`PENDENCIAS.md`) testa o desenho de front separado
— a página é HTML mínimo, e TUDO o que ela mostra vem da API em JSON. Se o
desenho render, a fase 3 nasce dele; se não render, o que se joga fora é uma
página.

**O que ela não é.** Não é uma segunda implementação de nada: a API que ela
consome chama os mesmos serviços das telas, e a sessão é o mesmo cookie do
`/login`. Quem não tem `epi.entregar` nem `turma.avaliar` abre a página e lê
por quê ela está vazia para si.

**PWA, no que cabe.** O manifesto faz o navegador oferecer "adicionar à tela
inicial", e o service worker (`/sw.js`) guarda a casca — a própria página, a
folha e o script — para ela abrir mesmo sem rede e dizer "sem rede" com as
próprias palavras, em vez do dinossauro do Chrome. Os DADOS nunca são
guardados: a ficha de EPI e a lista de chamada são dado pessoal, e cache em
disco de celular compartilhado é exatamente onde eles não podem ficar
(ROPA §6). O `sw.js` é servido daqui, e não de `/estaticos/`, porque o escopo
de um service worker é o caminho de onde ele foi baixado: em `/estaticos/js/`
ele só alcançaria `/estaticos/js/`.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from app.config import RAIZ
from app.dependencias import SessaoDep, UsuarioDep
from app.web import pagina

rotas = APIRouter(tags=["celular"])

ESTATICOS = RAIZ / "app" / "estaticos"


@rotas.get("/celular")
def celular(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """A página. `SessaoDep` pelo mesmo motivo de `/epis/fichas/minha`: sem ela
    o sino do cabeçalho abriria uma segunda sessão para contar pendências."""
    return pagina(
        request,
        "paginas/celular.html",
        usuario=usuario,
        pode_entregar=usuario.pode("epi.entregar"),
        pode_chamada=usuario.pode("turma.avaliar"),
        tem_ficha=usuario.servidor_id is not None,
    )


@rotas.get("/sw.js")
def service_worker():
    """O service worker, na raiz — ver o cabeçalho do módulo sobre o escopo.

    `Service-Worker-Allowed` não é necessário porque o arquivo já está na raiz;
    o `Cache-Control: no-cache` é o que garante que uma versão nova do worker
    seja vista na próxima abertura, e não daqui a um dia.

    **Abre sem sessão, de propósito**, e está declarado em
    `test_so_estas_rotas_abrem_sem_sessao`: o navegador baixa o worker antes de
    haver cookie (é assim que a casca fica guardada para abrir sem rede), e o
    arquivo é código, não dado — a lista do que ele guarda não tem `/api/`.
    """
    return FileResponse(
        ESTATICOS / "js" / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )
