"""/usuarios e /perfis - governanca de acesso e habilitacao tecnica."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    Atribuicao,
    Campus,
    Perfil,
    ProfissionalHabilitado,
    Servidor,
    Usuario,
    agora_utc,
)
from app.servicos import auditoria, autenticacao
from app.servicos.rbac import MATRIZ_PERFIS
from app.web import pagina

rotas = APIRouter(tags=["usuarios"])


def _tela_lista(
    request: Request,
    s,
    usuario,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A tela, com os tres popups de cadastro em branco ou com o digitado.

    `digitado` traz uma FORMA (`{"forma": "habilitacao", ...}`) porque a tela
    oferece tres cadastros — conta, concessao de perfil e habilitacao — e a
    recusa precisa dizer qual deles reabrir. E o mesmo discriminador de
    `epi_requisicoes`, e pelo mesmo motivo. Nao entra na URL: o nome e o SIAPE
    de um profissional habilitado nao viajam no `Location`.
    """
    usuarios = list(s.execute(select(Usuario).order_by(Usuario.nome)).scalars())
    return pagina(
        request,
        "paginas/usuarios.html",
        usuario=usuario,
        usuarios=usuarios,
        perfis=list(s.execute(select(Perfil).order_by(Perfil.codigo)).scalars()),
        campi=list(s.execute(select(Campus).order_by(Campus.sigla)).scalars()),
        atribuicoes={
            u.id: list(
                s.execute(select(Atribuicao).where(Atribuicao.usuario_id == u.id)).scalars()
            )
            for u in usuarios
        },
        habilitados=list(s.execute(select(ProfissionalHabilitado)).scalars()),
        servidores=list(s.execute(select(Servidor).order_by(Servidor.nome)).scalars()),
        hoje=date.today(),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get("/usuarios")
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    if not (usuario.pode("usuario.criar_conta") or usuario.pode("perfil.conceder")):
        usuario.exigir("usuario.criar_conta")
    return _tela_lista(request, s, usuario, mensagem=mensagem, erro=erro)


@rotas.post("/usuarios")
def criar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    login: str = Form(...),
    nome: str = Form(...),
    email: str = Form(...),
):
    usuario.exigir("usuario.criar_conta")
    # Login e e-mail sao UNIQUE no banco: sem esta conferencia a duplicata subia
    # como IntegrityError, virava a pagina de erro do sistema e levava junto o
    # nome e o e-mail ja digitados. Recusar aqui devolve o popup com os tres
    # campos como estavam.
    limpos = {"login": login.strip(), "nome": nome.strip(), "email": email.strip()}
    digitado = {"forma": "conta", **limpos}
    ja = s.execute(
        select(Usuario).where(
            (Usuario.login == limpos["login"]) | (Usuario.email == limpos["email"])
        )
    ).scalars().first()
    if ja is not None:
        qual = "login" if ja.login == limpos["login"] else "e-mail"
        return _tela_lista(
            request,
            s,
            usuario,
            erro=f"Já existe conta com este {qual}: {ja.nome}.",
            digitado=digitado,
        )
    provisoria = autenticacao.senha_provisoria()
    novo = Usuario(
        login=login.strip(),
        nome=nome.strip(),
        email=email.strip(),
        senha_hash=autenticacao.gerar_hash(provisoria),
        precisa_trocar_senha=True,
    )
    s.add(novo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="usuario",
        entidade_id=novo.id,
        tipo_evento="USUARIO_CRIADO",
        descricao=f"Conta '{login}' criada.",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        f"/usuarios?mensagem=Conta criada. Senha provisória: {provisoria}", status_code=303
    )


@rotas.post("/usuarios/{usuario_id}/senha")
def resetar_senha(s: SessaoDep, usuario: UsuarioDep, usuario_id: int):
    usuario.exigir("usuario.resetar_senha")
    alvo = s.get(Usuario, usuario_id)
    if alvo is None:
        return RedirectResponse("/usuarios", status_code=303)
    provisoria = autenticacao.senha_provisoria()
    alvo.senha_hash = autenticacao.gerar_hash(provisoria)
    alvo.precisa_trocar_senha = True
    alvo.tentativas_falhas = 0
    alvo.bloqueado_ate = None
    autenticacao.revogar_do_usuario(s, alvo.id)
    auditoria.registrar(
        s,
        entidade="usuario",
        entidade_id=alvo.id,
        tipo_evento="SENHA_RESETADA",
        descricao=f"Senha de '{alvo.login}' redefinida e sessões revogadas.",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        f"/usuarios?mensagem=Nova senha provisória de {alvo.login}: {provisoria}",
        status_code=303,
    )


@rotas.post("/usuarios/{usuario_id}/inativar")
def inativar(s: SessaoDep, usuario: UsuarioDep, usuario_id: int):
    usuario.exigir("usuario.criar_conta")
    alvo = s.get(Usuario, usuario_id)
    if alvo is not None:
        alvo.ativo = not alvo.ativo
        if not alvo.ativo:
            autenticacao.revogar_do_usuario(s, alvo.id)
        auditoria.registrar(
            s,
            entidade="usuario",
            entidade_id=alvo.id,
            tipo_evento="USUARIO_ATIVADO" if alvo.ativo else "USUARIO_INATIVADO",
            descricao=f"Conta '{alvo.login}' {'ativada' if alvo.ativo else 'inativada'}.",
            usuario=usuario,
        )
        s.commit()
    return RedirectResponse("/usuarios", status_code=303)


@rotas.post("/usuarios/{usuario_id}/atribuicoes")
def conceder_perfil(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    usuario_id: int,
    perfil_id: int = Form(...),
    ato_normativo: str = Form(...),
    campus_id: str = Form(""),
    vigencia_inicio: str = Form(""),
    vigencia_fim: str = Form(""),
    usuario_alvo: str = Form(""),
):
    usuario.exigir("perfil.conceder")
    # O formulario da tela posta em `/usuarios/0/atribuicoes` e diz o alvo no
    # campo `usuario_alvo`. Ate aqui quem reescrevia o `action` era um `onsubmit`
    # em JavaScript: sem script a concessao ia para o id 0, que nao existe, e a
    # gravacao morria numa violacao de chave estrangeira. Dentro de um popup que
    # se propoe a funcionar sem script isso deixou de ser tolerado — e resolver
    # no servidor e o unico lugar em que a correcao vale para os dois casos.
    if usuario_id == 0 and usuario_alvo.isdigit():
        usuario_id = int(usuario_alvo)
    digitado = {
        "forma": "perfil",
        "usuario_alvo": usuario_id,
        "perfil_id": perfil_id,
        "campus_id": campus_id,
        "vigencia_inicio": vigencia_inicio,
        "vigencia_fim": vigencia_fim,
        "ato_normativo": ato_normativo,
    }
    # `required` no campo so barra o campo VAZIO; um espaco passa, e a concessao
    # entrava na auditoria com autorizacao em branco — que e exatamente o que a
    # Resolucao Consu 11/2026, art. 11, IX, existe para nao deixar acontecer.
    if not ato_normativo.strip():
        return _tela_lista(
            request,
            s,
            usuario,
            erro="Sem o ato normativo não há concessão: é ele que autoriza o perfil.",
            digitado=digitado,
        )
    if s.get(Usuario, usuario_id) is None:
        return _tela_lista(
            request,
            s,
            usuario,
            erro="Escolha a conta que vai receber o perfil.",
            digitado=digitado,
        )
    atribuicao = Atribuicao(
        usuario_id=usuario_id,
        perfil_id=perfil_id,
        campus_id=int(campus_id) if campus_id else None,
        vigencia_inicio=date.fromisoformat(vigencia_inicio) if vigencia_inicio else date.today(),
        vigencia_fim=date.fromisoformat(vigencia_fim) if vigencia_fim else None,
        ato_normativo=ato_normativo.strip(),
        concedido_por=usuario.id,
    )
    s.add(atribuicao)
    s.flush()
    perfil = s.get(Perfil, perfil_id)
    auditoria.registrar(
        s,
        entidade="atribuicao",
        entidade_id=atribuicao.id,
        tipo_evento="PERFIL_CONCEDIDO",
        descricao=f"Perfil {perfil.codigo} concedido — ato: {ato_normativo.strip()}",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse("/usuarios?mensagem=Perfil concedido.", status_code=303)


@rotas.post("/habilitacoes")
def atestar_habilitacao(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(...),
    habilitacao: str = Form(...),
    titulo_assinatura: str = Form(...),
    siape: str = Form(""),
    usuario_alvo_id: str = Form(""),
    vigencia_inicio: str = Form(""),
    externo: str = Form(""),
    justificativa_art10_par5: str = Form(""),
    conselho: str = Form(""),
    registro_conselho: str = Form(""),
):
    """A habilitacao confere, nao o cargo (IN 15/2022, art. 10, §2º, I)."""
    usuario.exigir("habilitacao.atestar")
    e_externo = externo == "1"
    if e_externo and not justificativa_art10_par5.strip():
        # `erro=`, e não `mensagem=`: a habilitação NÃO foi registrada, e a lista
        # de habilitados ao lado continua igual — verde aqui era o sistema
        # dizendo que atestou quem não atestou.
        #
        # E a recusa deixou de redirecionar: onze campos ficavam para trás por
        # causa de uma justificativa em branco, e o "voltar" do navegador não
        # devolve formulário enviado por POST.
        return _tela_lista(
            request,
            s,
            usuario,
            erro="Habilitação externa exige justificativa do art. 10, §5º.",
            digitado={
                "forma": "habilitacao",
                "nome": nome,
                "siape": siape,
                "habilitacao": habilitacao,
                "titulo_assinatura": titulo_assinatura,
                "usuario_alvo_id": usuario_alvo_id,
                "conselho": conselho,
                "registro_conselho": registro_conselho,
                "vigencia_inicio": vigencia_inicio,
                "externo": externo,
                "justificativa_art10_par5": justificativa_art10_par5,
            },
        )
    habilitado = ProfissionalHabilitado(
        nome=nome.strip(),
        siape=siape.strip() or None,
        habilitacao=habilitacao,
        titulo_assinatura=titulo_assinatura.strip(),
        conselho=conselho or None,
        registro_conselho=registro_conselho or None,
        externo=e_externo,
        justificativa_art10_par5=justificativa_art10_par5.strip() or None,
        usuario_id=int(usuario_alvo_id) if usuario_alvo_id else None,
        vigencia_inicio=date.fromisoformat(vigencia_inicio) if vigencia_inicio else date.today(),
        atestado_por=usuario.id,
        atestado_em=agora_utc(),
    )
    s.add(habilitado)
    s.flush()
    auditoria.registrar(
        s,
        entidade="profissional_habilitado",
        entidade_id=habilitado.id,
        tipo_evento=auditoria.HABILITACAO_EXTERNA_ATESTADA
        if e_externo
        else "HABILITACAO_ATESTADA",
        descricao=f"{nome.strip()} — {habilitacao} ({titulo_assinatura.strip()}).",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse("/usuarios?mensagem=Habilitação registrada.", status_code=303)


@rotas.get("/perfis")
def perfis(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("processo.ver")
    return pagina(
        request,
        "paginas/perfis.html",
        usuario=usuario,
        perfis=list(s.execute(select(Perfil).order_by(Perfil.codigo)).scalars()),
        matriz=MATRIZ_PERFIS,
    )
