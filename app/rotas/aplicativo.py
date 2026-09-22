"""`/app` — o front compilado (fase 3), servido pelo próprio FastAPI.

**O que é.** O `index.html` que o Vite gera em `app/estaticos/app/` a partir
de `frontend/`. Os assets (JS, CSS) já saem dentro da pasta de estáticos e o
`StaticFiles` de sempre os serve em `/estaticos/app/assets/…`; o que esta rota
faz é servir SÓ a página de entrada — e exigir sessão para isso. O bundle em si
é público, como todo estático; é a página que abre a porta, e ela não abre sem
o cookie do `/login`.

**Por que uma rota, e não outro servidor.** A fase 3 testa se um front
compilado rende como produto. Rende mais se a instalação continuar sendo UM
processo Python: nenhuma porta nova, nenhum nginx, nenhuma cadeia de build na
máquina do setor — quem instala recebe a pasta `app/estaticos/app/` já
construída, e `npm` só existe na máquina de quem desenvolve.

**Sem o bundle construído** a rota não finge: responde a tela de erro dizendo
que o front não foi montado e como montá-lo. É o mesmo princípio do
`EnvFileAusente` — arquivo apontado que não existe é erro, não silêncio.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.config import RAIZ
from app.dependencias import SessaoDep, UsuarioDep

rotas = APIRouter(tags=["aplicativo"])

PASTA = RAIZ / "app" / "estaticos" / "app"
ENTRADA = PASTA / "index.html"


def bundle_construido() -> bool:
    return ENTRADA.is_file()


@rotas.get("/app")
@rotas.get("/app/{resto:path}")
def aplicativo(request: Request, s: SessaoDep, usuario: UsuarioDep, resto: str = ""):
    """A página do app. `resto` existe para `/app/qualquer-coisa` cair aqui
    também — o roteador do front é por âncora, mas um endereço colado sem a
    âncora não pode virar 404. `SessaoDep` pelo motivo de sempre: sem ela o
    sino abriria uma segunda sessão."""
    if not bundle_construido():
        return HTMLResponse(
            "<!doctype html><html lang='pt-BR'><meta charset='utf-8'>"
            "<title>App não montado</title>"
            "<body style='font-family:system-ui;max-width:40em;margin:3em auto'>"
            "<h1>O front compilado ainda não foi montado nesta máquina.</h1>"
            "<p>Ele nasce de <code>frontend/</code>: <code>cd frontend &amp;&amp; "
            "npm install &amp;&amp; npm run build</code> escreve "
            "<code>app/estaticos/app/</code>, e esta página passa a existir. "
            "O sistema completo continua em <a href='/inicio'>/inicio</a> e a tela "
            "de bolso em <a href='/celular'>/celular</a>.</p></body></html>",
            status_code=503,
        )
    return HTMLResponse(
        ENTRADA.read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-cache"},
    )
