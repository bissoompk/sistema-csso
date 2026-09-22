"""Login proprio: Argon2id, sessao server-side, bloqueio por tentativas."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import date, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import obter_config
from app.modelos import Atribuicao, Perfil, Sessao, Usuario, agora_utc
from app.servicos import auditoria

COOKIE_SESSAO = "csso_sessao"
ERRO_GENERICO = "Usuário ou senha inválidos."

# O custo do Argon2id em PRODUCAO. Sai como constante nomeada, e nao como
# literal na chamada, para que exista um lugar unico a que um teste possa se
# amarrar: a suite troca `_hasher` por um de custo baixo (senao 83 ms por hash
# vezes milhares de contas de teste viram meia hora de espera), e a unica coisa
# que impede essa troca de vazar para producao e alguem afirmar, em teste, que
# estes numeros continuam sendo estes. Ver `testes/unitarios/test_politica_senha.py`.
#
# 64 MiB / 3 passagens / 2 threads e o perfil recomendado pelo RFC 9106 para
# servidor. Baixar aqui e baixar a resistencia a forca bruta offline do banco.
PARAMETROS_ARGON2_PRODUCAO = {"time_cost": 3, "memory_cost": 65536, "parallelism": 2}

_hasher = PasswordHasher(**PARAMETROS_ARGON2_PRODUCAO)


class FalhaDeAutenticacao(Exception):
    def __init__(self, mensagem: str = ERRO_GENERICO):
        super().__init__(mensagem)


def gerar_hash(senha: str) -> str:
    return _hasher.hash(senha)


def conferir_senha(hash_armazenado: str, senha: str) -> bool:
    try:
        return _hasher.verify(hash_armazenado, senha)
    except (VerifyMismatchError, InvalidHashError, ValueError):
        return False


def _hash_token(token: str) -> str:
    """HMAC-SHA256 do token com `CSSO_CHAVE_SECRETA`.

    Era SHA-256 puro, e a chave nao era lida em lugar nenhum do sistema: o
    `/saude` avisava que ela "ainda e o valor de exemplo" enquanto nada assinava
    nada com ela. Quem a trocasse achava que estava fortalecendo a sessao e nao
    estava — e aviso de saude que mente e pior que aviso nenhum, porque produz a
    confianca que ninguem paga.

    O ganho NAO e sigilo do token: 48 bytes de `secrets.token_urlsafe` ja sao
    aleatorios demais para que o SHA-256 deles fosse invertido. O ganho e ter o
    que ROTACIONAR. Depois de um incidente, a primeira coisa que um plano de
    resposta pede e trocar o segredo — e ate aqui este sistema nao tinha
    segredo nenhum a trocar. Agora trocar a chave invalida, no mesmo gesto e
    sem tocar no banco, toda sessao aberta de todo mundo.

    O preco esta declarado: a chave passa a ser carga. Trocar por engano derruba
    a sessao de todos (12 h, no maximo), o que e recuperavel; perde-la nao perde
    dado nenhum, porque o token do lado do usuario nunca foi decifravel a partir
    da coluna.
    """
    chave = obter_config().chave_secreta.encode("utf-8")
    return hmac.new(chave, token.encode("utf-8"), hashlib.sha256).hexdigest()


TAMANHO_MINIMO_SENHA = 6

# Senhas triviais recusadas mesmo respeitando o tamanho minimo.
SENHAS_TRIVIAIS = frozenset(
    {
        "admin",
        "admin1",
        "senha1",
        "123456",
        "1234567",
        "12345678",
        "abc123",
        "csso01",
        "ufvjm1",
        "mudar1",
        "teste1",
        "senha123",
        "123456789012",
        "senha123456",
    }
)



# Alfabeto sem 0/O/1/l/I: a senha provisoria e ditada e digitada a mao.
_ALFABETO_CLARO = "abcdefghijkmnpqrstuvwxyz"
_DIGITOS_CLAROS = "23456789"


def senha_provisoria() -> str:
    """Curta e legivel, para o coordenador ditar. Troca obrigatoria no 1º acesso."""
    letras = "".join(secrets.choice(_ALFABETO_CLARO) for _ in range(4))
    numeros = "".join(secrets.choice(_DIGITOS_CLAROS) for _ in range(2))
    return letras + numeros


def politica_de_senha(senha: str) -> list[str]:
    """Politica curta, a pedido do coordenador: 6 caracteres, letras e numeros.

    O tamanho minimo e baixo para um sistema com dado pessoal; o que segura o
    risco aqui e o bloqueio por tentativas (5) somado ao hash Argon2id e as
    sessoes revogaveis. Registrado em PENDENCIAS.md.
    """
    problemas = []
    if len(senha) < TAMANHO_MINIMO_SENHA:
        problemas.append(f"mínimo de {TAMANHO_MINIMO_SENHA} caracteres")
    if senha.isalpha() or senha.isdigit():
        problemas.append("misture letras e números")
    if senha.lower() in SENHAS_TRIVIAIS:
        problemas.append("senha trivial")
    return problemas


def usuario_a_partir_do_email(email: str) -> str:
    """Deriva o nome de usuário do e-mail.

    A coluna `login` é obrigatória e única, mas deixou de ser digitada por
    alguém: a entrada é pelo e-mail. Em vez de pedir um segundo identificador
    que ninguém memoriza, tira-se a parte local do endereço.
    """
    local = (email or "").strip().split("@")[0]
    limpo = re.sub(r"[^a-z0-9._-]", "", local.casefold())[:64]
    return limpo or "usuario"


def buscar_por_login(s: Session, login: str) -> Usuario | None:
    """Acha a conta pelo e-mail ou pelo usuário, sem depender de maiúsculas.

    O e-mail é a credencial de entrada: é o que a pessoa sabe de cor e o que
    permite entrar quem não tem SIAPE — terceirizado, estudante, bolsista. O
    nome de usuário continua aceito para não trancar quem já entra por ele.

    'Bisso' e 'bisso' são a mesma pessoa: exigir a caixa exata só produz um
    'usuário ou senha inválidos' que ninguém consegue depurar. A SENHA continua
    sensível a maiúsculas — isso sim é segurança.
    """
    procurado = (login or "").strip()
    if not procurado:
        return None
    achado = s.execute(
        select(Usuario).where(
            or_(Usuario.email == procurado, Usuario.login == procurado)
        )
    ).scalar_one_or_none()
    if achado is not None:
        return achado
    alvo = procurado.casefold()
    for candidato in s.execute(select(Usuario)).scalars():
        if (candidato.email or "").casefold() == alvo:
            return candidato
        if candidato.login.casefold() == alvo:
            return candidato
    return None


def autenticar(
    s: Session, login: str, senha: str, ip: str | None = None, user_agent: str | None = None
) -> tuple[Usuario, str]:
    cfg = obter_config()
    usuario = buscar_por_login(s, login)
    agora = agora_utc()

    if usuario is None or not usuario.ativo:
        raise FalhaDeAutenticacao()

    if usuario.bloqueado_ate and usuario.bloqueado_ate > agora:
        # A frase dizia "temporariamente" e não dizia até quando. O valor existe
        # (`bloqueio_minutos`) e o horário está no próprio registro; quem está
        # sob prazo administrativo lia a recusa e ligava para alguém — ou
        # desistia. Dizer a hora e a saída é o que transforma a recusa em
        # instrução.
        from app.servicos.datas_br import local_formatado

        raise FalhaDeAutenticacao(
            f"Conta bloqueada até {local_formatado(usuario.bloqueado_ate)} por "
            f"{cfg.max_tentativas} tentativas malsucedidas seguidas. Espere e tente "
            "de novo; se a senha se perdeu, quem administra o sistema redefine — "
            "não há redefinição por e-mail."
        )

    if not conferir_senha(usuario.senha_hash, senha):
        usuario.tentativas_falhas += 1
        if usuario.tentativas_falhas >= cfg.max_tentativas:
            usuario.bloqueado_ate = agora + timedelta(minutes=cfg.bloqueio_minutos)
        s.flush()
        raise FalhaDeAutenticacao()

    usuario.tentativas_falhas = 0
    usuario.bloqueado_ate = None
    usuario.ultimo_login_em = agora

    token = secrets.token_urlsafe(48)
    s.add(
        Sessao(
            token_hash=_hash_token(token),
            usuario_id=usuario.id,
            criada_em=agora,
            expira_em=agora + timedelta(hours=cfg.sessao_horas),
            ip=ip,
            user_agent=user_agent,
        )
    )
    s.flush()
    return usuario, token


def sessao_valida(s: Session, token: str | None) -> Sessao | None:
    if not token:
        return None
    registro = s.execute(
        select(Sessao).where(Sessao.token_hash == _hash_token(token))
    ).scalar_one_or_none()
    if registro is None or registro.revogada or registro.expira_em <= agora_utc():
        return None
    return registro


def revogar(s: Session, token: str) -> None:
    registro = s.execute(
        select(Sessao).where(Sessao.token_hash == _hash_token(token))
    ).scalar_one_or_none()
    if registro is not None:
        registro.revogada = True
        s.flush()


def revogar_do_usuario(
    s: Session, usuario_id: int, exceto_token: str | None = None
) -> int:
    """Derruba as sessoes do usuario. `exceto_token` poupa a sessao corrente."""
    preservado = _hash_token(exceto_token) if exceto_token else None
    sessoes = s.execute(
        select(Sessao).where(Sessao.usuario_id == usuario_id, Sessao.revogada.is_(False))
    ).scalars()
    contador = 0
    for registro in sessoes:
        if preservado is not None and registro.token_hash == preservado:
            continue
        registro.revogada = True
        contador += 1
    s.flush()
    return contador


def trocar_senha(
    s: Session, usuario: Usuario, nova: str, token_atual: str | None = None
) -> int:
    """Grava a senha nova e derruba as OUTRAS sessoes. Devolve quantas caíram.

    Trocar a propria senha e o gesto que se faz justamente ao desconfiar de que
    alguem viu a senha. Ate a 1.30.0 esse gesto nao expulsava ninguem: o reset
    feito por administrador revogava (`rotas/usuarios.py`) e a inativacao de
    conta tambem, e so a autotroca deixava a sessao do intruso valida por ate
    12 h — com a ficha de EPI e o parecer dentro, conforme o perfil.

    `token_atual` poupa quem esta trocando. Sem ele a correcao ficava pela
    metade na direcao oposta: a pessoa trocaria a senha e cairia na tela de
    login sem entender por que, o que ensina a nao trocar senha.
    """
    problemas = politica_de_senha(nova)
    if problemas:
        raise ValueError("Senha fraca: " + "; ".join(problemas))
    usuario.senha_hash = gerar_hash(nova)
    usuario.precisa_trocar_senha = False
    s.flush()
    return revogar_do_usuario(s, usuario.id, exceto_token=token_atual)


# ---------------------------------------------------------------------
# Bootstrap: /primeiro-acesso
# ---------------------------------------------------------------------
def existe_algum_usuario(s: Session) -> bool:
    return s.execute(select(Usuario.id).limit(1)).first() is not None


def criar_primeiro_superintendente(
    s: Session, login: str, nome: str, email: str, senha: str
) -> Usuario:
    """Unica concessao de perfil feita sem `perfil.conceder`. Auditada."""
    if existe_algum_usuario(s):
        raise PermissionError("já existe usuário cadastrado — use /usuarios")
    problemas = politica_de_senha(senha)
    if problemas:
        raise ValueError("Senha fraca: " + "; ".join(problemas))

    usuario = Usuario(
        login=login,
        nome=nome,
        email=email,
        senha_hash=gerar_hash(senha),
        precisa_trocar_senha=True,
    )
    s.add(usuario)
    s.flush()

    perfil = s.execute(
        select(Perfil).where(Perfil.codigo == "superintendente")
    ).scalar_one()
    s.add(
        Atribuicao(
            usuario_id=usuario.id,
            perfil_id=perfil.id,
            coordenadoria="Sisa",
            vigencia_inicio=date.today(),
            ato_normativo="BOOTSTRAP — substituir pelo ato real",
        )
    )
    s.flush()
    auditoria.registrar(
        s,
        entidade="usuario",
        entidade_id=usuario.id,
        tipo_evento=auditoria.BOOTSTRAP_SUPERINTENDENTE,
        descricao=(
            f"Primeiro acesso: conta '{login}' criada com perfil superintendente "
            "(ato normativo pendente de substituição)."
        ),
        usuario_nome=nome,
    )
    return usuario
