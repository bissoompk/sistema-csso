"""/login, /sair, /primeiro-acesso e /trocar-senha."""

from __future__ import annotations

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse

from app.config import obter_config
from app.dependencias import SessaoDep, UsuarioDep, UsuarioOpcional
from app.seguranca import cookie_seguro
from app.servicos import autenticacao
from app.web import pagina

rotas = APIRouter(tags=["autenticacao"])


def _local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost", "testclient")


# O destino padrao depois de entrar e `/inicio`, e nao `/`: `/` e o painel de
# Processos SEI e exige `processo.ver`, entao quem opera so o almoxarifado
# trocava a senha provisoria e recebia um 403 como primeira tela do sistema.
# `/inicio` leva cada um a primeira tela que abre para ele — para quem tem
# `processo.ver` isso continua sendo o painel de sempre.
INICIO = "/inicio"

# Os dois motivos que a tela de login sabe explicar. Vêm de
# `dependencias.destino_de_login`; qualquer outro valor é ignorado — o
# parâmetro chega pela URL, e URL é entrada.
MOTIVOS = {
    "sessao": (
        "Sua sessão expirou. Entre de novo para continuar de onde estava — o "
        "endereço em que você estava é reaberto depois."
    ),
    "envio": (
        "Sua sessão expirou antes de o envio ser gravado: o que você tinha "
        "preenchido não foi salvo. Entre de novo e refaça — a tela de origem é "
        "reaberta depois."
    ),
}


def destino_seguro(proximo: str | None) -> str:
    """Só caminho DESTE sistema volta do login.

    `proximo` chega pela query e pelo formulário, e ia direto para o
    `Location`: `?proximo=https://outro.site` mandava quem acabou de digitar a
    senha para fora — redirecionamento aberto, o disfarce clássico de
    phishing ("entre no CSSO" e a página seguinte é de outro dono). Vale só o
    que começa com uma barra e não com duas (`//host` é URL absoluta sem
    esquema) nem com barra invertida (o navegador a normaliza para `/`).
    """
    proximo = (proximo or "").strip()
    if not proximo.startswith("/") or proximo.startswith(("//", "/\\")):
        return INICIO
    return proximo


@rotas.get("/login")
def tela_login(
    request: Request, s: SessaoDep, proximo: str = INICIO, motivo: str | None = None
):
    if not autenticacao.existe_algum_usuario(s):
        return RedirectResponse("/primeiro-acesso", status_code=303)
    return pagina(
        request,
        "paginas/login.html",
        proximo=destino_seguro(proximo),
        aviso_sessao=MOTIVOS.get(motivo or ""),
    )


@rotas.post("/login")
def entrar(
    request: Request,
    s: SessaoDep,
    login: str = Form(...),
    senha: str = Form(...),
    proximo: str = Form(INICIO),
):
    cfg = obter_config()
    try:
        usuario, token = autenticacao.autenticar(
            s,
            login.strip(),
            senha,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    except autenticacao.FalhaDeAutenticacao as erro:
        # O identificador volta; a senha, nunca. É a mesma divisão do primeiro
        # acesso, e pelo mesmo motivo: a senha em `value=` iria em claro para o
        # HTML, para o cache do navegador e para o histórico da tela. O e-mail
        # institucional é longo o bastante para que redigitá-lo a cada erro de
        # senha faça a pessoa desistir de conferir a senha com calma — e esta é
        # a tela mais vista do sistema.
        return pagina(
            request,
            "paginas/login.html",
            erro=str(erro),
            proximo=destino_seguro(proximo),
            login=login,
        )

    # O login bem-sucedido e a linha que uma investigacao procura primeiro, e
    # ele e a unica rota do sistema que estabelece identidade sem passar por
    # `usuario_opcional` — sem esta linha ele sairia no registro de acesso como
    # `conta=-`, e a entrada da pessoa ficaria de fora justamente do arquivo que
    # existe para responder "quem chegou". Id numerico, nunca o `login`.
    request.state.conta_id = usuario.id

    destino = "/trocar-senha" if usuario.precisa_trocar_senha else destino_seguro(proximo)
    resposta = RedirectResponse(destino, status_code=303)
    resposta.set_cookie(
        autenticacao.COOKIE_SESSAO,
        token,
        httponly=True,
        samesite="lax",
        max_age=cfg.sessao_horas * 3600,
        # A REQUISICAO decide, nunca `cfg.host`: o endereco de ligacao nao sabe
        # se a conexao e segura, e quando ele decidia o cookie saia `Secure` sem
        # TLS — o navegador nao o devolvia e esta rota devolvia a pessoa para a
        # tela de login, sem mensagem. O argumento inteiro em `app/seguranca.py`.
        secure=cookie_seguro(request),
    )
    return resposta


@rotas.get("/sair")
def sair(request: Request, s: SessaoDep):
    token = request.cookies.get(autenticacao.COOKIE_SESSAO)
    if token:
        autenticacao.revogar(s, token)
    resposta = RedirectResponse("/login", status_code=303)
    resposta.delete_cookie(autenticacao.COOKIE_SESSAO)
    return resposta


@rotas.get("/primeiro-acesso")
def tela_primeiro_acesso(request: Request, s: SessaoDep):
    if autenticacao.existe_algum_usuario(s):
        return RedirectResponse("/login", status_code=303)
    if not _local(request):
        return pagina(
            request,
            "paginas/erro.html",
            titulo="Indisponível",
            detalhe="O primeiro acesso só pode ser feito na própria máquina (127.0.0.1).",
            codigo=None,
        )
    return pagina(request, "paginas/primeiro_acesso.html")


@rotas.post("/primeiro-acesso")
def criar_primeiro_acesso(
    request: Request,
    s: SessaoDep,
    nome: str = Form(...),
    email: str = Form(...),
    senha: str = Form(...),
    login: str = Form(""),
):
    if autenticacao.existe_algum_usuario(s) or not _local(request):
        return RedirectResponse("/login", status_code=303)
    # a tela não pede mais nome de usuário: a entrada é pelo e-mail. A coluna
    # continua existindo e obrigatória, então sai do próprio e-mail.
    escolhido = login.strip() or autenticacao.usuario_a_partir_do_email(email)
    try:
        autenticacao.criar_primeiro_superintendente(
            s, escolhido, nome.strip(), email.strip(), senha
        )
    except (ValueError, PermissionError) as erro:
        # Devolve o que NÃO é segredo. Refazer o nome completo e o e-mail por
        # causa de uma senha fraca é o atrito que faz a pessoa escolher senha
        # pior na segunda tentativa — ela encurta a senha para não ter de
        # redigitar o resto se errar de novo.
        #
        # A senha jamais volta: iria em claro para o HTML, e daí para o cache do
        # navegador e para o histórico da tela. Formulário de senha é o único em
        # que perder o digitado é a resposta certa.
        return pagina(
            request,
            "paginas/primeiro_acesso.html",
            erro=str(erro),
            nome=nome,
            email=email,
            login=login,
        )
    return RedirectResponse("/login", status_code=303)


@rotas.get("/trocar-senha")
def tela_trocar_senha(request: Request, usuario: UsuarioDep):
    return pagina(request, "paginas/trocar_senha.html", usuario=usuario)


@rotas.post("/trocar-senha")
def trocar_senha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    senha_atual: str = Form(...),
    nova: str = Form(...),
    confirmacao: str = Form(...),
):
    from app.modelos import Usuario

    registro = s.get(Usuario, usuario.id)
    if registro is None or not autenticacao.conferir_senha(registro.senha_hash, senha_atual):
        return pagina(
            request, "paginas/trocar_senha.html", usuario=usuario, erro="Senha atual incorreta."
        )
    if nova != confirmacao:
        return pagina(
            request, "paginas/trocar_senha.html", usuario=usuario, erro="A confirmação não confere."
        )
    try:
        # O cookie da requisição é o que diz "esta sessão é a de quem está
        # trocando": ela sobrevive, todas as outras caem. Sem passá-lo, a troca
        # expulsaria a própria pessoa no ato.
        autenticacao.trocar_senha(
            s, registro, nova, token_atual=request.cookies.get(autenticacao.COOKIE_SESSAO)
        )
    except ValueError as erro:
        return pagina(request, "paginas/trocar_senha.html", usuario=usuario, erro=str(erro))
    return RedirectResponse(INICIO, status_code=303)


@rotas.get("/quem-sou-eu")
def quem_sou_eu(atual: UsuarioOpcional) -> dict:
    if atual is None:
        return {"autenticado": False}
    return {
        "autenticado": True,
        "login": atual.login,
        "nome": atual.nome,
        "perfis": list(atual.perfis),
        "permissoes": sorted(atual.permissoes),
    }
