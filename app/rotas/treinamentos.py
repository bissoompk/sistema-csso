"""/treinamentos/* — catálogo, modelos de certificado e assinaturas.

Fatia 1 do módulo Certificados e Treinamentos. As três telas seguem o padrão
de `/catalogos`: lista com edição em linha, formulário de cadastro embaixo e
diff campo a campo na auditoria a cada alteração.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AssinaturaInstrutor,
    CertificadoModelo,
    CertificadoModeloTag,
    Servidor,
    Treinamento,
)
from app.modelos.base import confere_regex
from app.modelos.treinamento import (
    ORIENTACOES,
    PADRAO_CODIGO_TREINAMENTO,
    PADRAO_MARCADOR,
)
from app.servicos import auditoria, certificado
from app.web import pagina, salvar_com_diff

rotas = APIRouter(tags=["treinamentos"])

CATALOGO = "/treinamentos/catalogo"
MODELOS = "/treinamentos/modelos"
ASSINATURAS = "/treinamentos/assinaturas"

VINCULOS_INSTRUTOR = [("0", "Servidor da UFVJM"), ("1", "Externo")]


def _texto(valor: str | None) -> str | None:
    return (valor or "").strip() or None


def _marcado(valor: str) -> bool:
    return valor == "1"


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """O recado vai codificado: o nome do treinamento e o do marcador vêm daqui.

    "NR-10 & NR-35" ou "Modelo #2" cortavam o recado no símbolo — e o pedaço que
    sobrava era justamente o que não explicava nada. `quote_via=quote` para o
    espaço voltar espaço em quem só desfaz `%XX`.
    """
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(destino: str, mensagem: str) -> RedirectResponse:
    """Deu certo. Banner verde (`base.html`, `.aviso-ok`)."""
    return _aviso(destino, "mensagem", mensagem)


def _erro(destino: str, mensagem: str) -> RedirectResponse:
    """Não deu. Banner vermelho.

    O módulo teve um canal só, e ele era o verde: "Carga horária
    inválida", "Versão superada não se edita" e "Campo desconhecido" chegavam à
    tela com a cor de quem tinha acabado de salvar. Numa tela de catálogo, em que
    a linha de cima continua igual em qualquer dos dois casos, a cor da caixa é a
    única coisa que distingue gravou de não gravou.
    """
    return _aviso(destino, "erro", mensagem)


def _horas(valor: str) -> Decimal | None:
    """Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita."""
    try:
        horas = Decimal((valor or "").strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        return None
    return horas if horas > 0 else None


def _inteiro(valor: str, minimo: int = 0) -> int | None:
    texto = (valor or "").strip()
    if not texto.isdigit():
        return None
    numero = int(texto)
    return numero if numero >= minimo else None


def _id_opcional(valor: str) -> int | None:
    return int(valor) if (valor or "").strip().isdigit() else None


def _arquivo_de_modelo(valor: str) -> str | None:
    """O nome do .docx, sem pasta. Devolve None quando não serve.

    Guarda só o nome porque é só o nome que vai ser aberto: a emissão resolve
    o caminho com `Path(arquivo).name` dentro de
    `app/templates/certificados/`, e gravar a pasta junto faria o banco dizer
    uma coisa e o disco outra. Mora aqui, e não em cada rota, porque cadastro
    e edição precisam da mesma conferência — foi a edição sem ela que
    contornou a guarda do cadastro.
    """
    nome = Path((valor or "").strip()).name
    return nome if nome.lower().endswith(".docx") else None


def _confere_vinculos(
    s, treinamento: Treinamento, modelo_id: int | None, instrutor_id: int | None
) -> str:
    """Confere o que a linha do catálogo aponta. Devolve o erro, ou "" quando vai.

    O `certificado_modelo.treinamento_id` existe para dizer "este layout serve
    a este treinamento, e NULL serve a qualquer um"; deixar o catálogo
    contradizer isso faria o certificado de NR-35 sair no papel do curso de
    brigada. E id inexistente estourava na chave estrangeira, o que a pessoa
    via como página de erro do servidor — acontece com formulário reenviado
    depois de o modelo ser apagado.

    Versão superada e assinatura inativa continuam aceitas quando já são o
    valor gravado: quem só quer corrigir a carga horária da linha não pode ser
    obrigado a mexer no resto, nem ter o vínculo apagado em silêncio.
    """
    if modelo_id is not None:
        modelo = s.get(CertificadoModelo, modelo_id)
        if modelo is None:
            return "Modelo de certificado não encontrado."
        if modelo.treinamento_id not in (None, treinamento.id):
            return (
                f"O modelo {modelo.rotulo} é de outro treinamento — "
                "escolha um do próprio treinamento ou um genérico."
            )
        if not modelo.vigente and modelo_id != treinamento.modelo_vigente_id:
            return f"{modelo.rotulo} é versão superada — aponte a versão vigente."
    if instrutor_id is not None:
        instrutor = s.get(AssinaturaInstrutor, instrutor_id)
        if instrutor is None:
            return "Assinatura de instrutor não encontrada."
        if not instrutor.ativo and instrutor_id != treinamento.instrutor_padrao_id:
            return f"A assinatura de {instrutor.nome_exibicao} está inativa."
    return ""


# =====================================================================
# Catálogo de treinamentos
# =====================================================================
def _tela_catalogo(
    request: Request,
    s,
    usuario,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o popup de cadastro em branco ou com o que foi digitado.

    Mesma forma de `_tela_assinaturas`, logo abaixo: `digitado` é dicionário e
    não atravessa redirecionamento nenhum, então a recusa do CADASTRO renderiza
    aqui. A da edição EM LINHA continua com `_erro` — lá a linha volta do banco
    intacta e não há o que preservar.
    """
    itens = list(s.execute(select(Treinamento).order_by(Treinamento.nome)).scalars())
    # a lista vem inteira e o filtro é por linha (o modelo serve a um
    # treinamento só, ou a qualquer um), mais o que a linha já aponta: modelo
    # superado e assinatura inativa somem do seletor, e sem eles na lista o
    # navegador selecionaria "—" e salvar apagaria o vínculo sem ninguém pedir
    return pagina(
        request,
        "paginas/treinamentos_catalogo.html",
        usuario=usuario,
        itens=itens,
        modelos=list(
            s.execute(
                select(CertificadoModelo).order_by(
                    CertificadoModelo.nome, CertificadoModelo.versao.desc()
                )
            ).scalars()
        ),
        instrutores=list(
            s.execute(
                select(AssinaturaInstrutor).order_by(AssinaturaInstrutor.nome)
            ).scalars()
        ),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get(CATALOGO)
def catalogo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    """Abre em leitura para quem tem `treinamento.ver`; editar pede gerenciar,
    como acontece em `/catalogos`."""
    usuario.exigir("treinamento.ver")
    return _tela_catalogo(request, s, usuario, mensagem=mensagem, erro=erro)


@rotas.post(CATALOGO)
def criar_treinamento(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    codigo: str = Form(...),
    nome: str = Form(...),
    carga_horaria_horas: str = Form(...),
    # o default NÃO é "0": o FastAPI troca campo de formulário vazio pelo
    # default antes de a rota ver, e com "0" o campo apagado viraria "não
    # expira" em silêncio. Com "" o vazio chega à guarda abaixo e é recusado;
    # o 0 digitado continua valendo e continua significando "não expira".
    validade_meses: str = Form(""),
    norma_referencia: str = Form(""),
    conteudo_programatico: str = Form(""),
    obrigatorio: str = Form(""),
):
    usuario.exigir("treinamento.gerenciar")
    # Tudo o que foi digitado, guardado antes da primeira recusa. O conteúdo
    # programático é o campo caro: uma lista de tópicos escrita à mão, que uma
    # carga horária mal digitada apagava inteira.
    digitado = {
        "codigo": codigo,
        "nome": nome,
        "carga_horaria_horas": carga_horaria_horas,
        "validade_meses": validade_meses,
        "norma_referencia": norma_referencia,
        "conteudo_programatico": conteudo_programatico,
        "obrigatorio": obrigatorio,
    }

    def recusar(mensagem: str):
        """Renderiza a tela de novo, com o popup reaberto — nunca redireciona."""
        return _tela_catalogo(request, s, usuario, erro=mensagem, digitado=digitado)

    codigo_limpo = (codigo or "").strip().upper()
    nome_limpo = (nome or "").strip()
    if not confere_regex(codigo_limpo, PADRAO_CODIGO_TREINAMENTO):
        return recusar(
            "Código inválido: use letras maiúsculas, números, ponto, hífen ou "
            "sublinhado (NR-35, PRIM_SOCORROS)."
        )
    horas = _horas(carga_horaria_horas)
    if horas is None:
        return recusar("Carga horária inválida: informe um número maior que zero.")
    meses = _inteiro(validade_meses)
    if meses is None:
        return recusar(
            "Validade inválida: informe meses inteiros, ou 0 para não expira."
        )
    ja = s.execute(
        select(Treinamento).where(
            (Treinamento.codigo == codigo_limpo) | (Treinamento.nome == nome_limpo)
        )
    ).scalar_one_or_none()
    if ja is not None:
        return recusar(f"Já existe treinamento com esse código ou nome ({ja.codigo}).")

    treinamento = Treinamento(
        codigo=codigo_limpo,
        nome=nome_limpo,
        carga_horaria_horas=horas,
        validade_meses=meses,
        norma_referencia=_texto(norma_referencia),
        conteudo_programatico=_texto(conteudo_programatico),
        obrigatorio=_marcado(obrigatorio),
    )
    s.add(treinamento)
    s.flush()
    auditoria.registrar(
        s,
        entidade="treinamento",
        entidade_id=treinamento.id,
        tipo_evento="TREINAMENTO_CRIADO",
        descricao=(
            f"{treinamento.codigo} · {treinamento.nome} · "
            f"{treinamento.carga_horaria_horas}h · validade {treinamento.validade_rotulo}"
        ),
        usuario=usuario,
    )
    s.commit()
    return _volta(CATALOGO, f"Treinamento {codigo_limpo} cadastrado.")


@rotas.post(CATALOGO + "/{treinamento_id}")
def editar_treinamento(
    s: SessaoDep,
    usuario: UsuarioDep,
    treinamento_id: int,
    nome: str = Form(...),
    carga_horaria_horas: str = Form(...),
    # ver o comentário de `criar_treinamento`: campo vazio não é zero
    validade_meses: str = Form(""),
    norma_referencia: str = Form(""),
    conteudo_programatico: str = Form(""),
    modelo_vigente_id: str = Form(""),
    instrutor_padrao_id: str = Form(""),
    obrigatorio: str = Form(""),
    ativo: str = Form(""),
):
    """O código não se edita: ele é citado em ofício e em planilha do setor.

    Renomear o treinamento é seguro para o que já saiu — a emissão congela o
    nome no certificado (fatia 4), como o parecer já faz com o cargo.
    """
    usuario.exigir("treinamento.gerenciar")
    horas = _horas(carga_horaria_horas)
    if horas is None:
        return _erro(CATALOGO, "Carga horária inválida: informe um número maior que zero.")
    meses = _inteiro(validade_meses)
    if meses is None:
        return _erro(
            CATALOGO, "Validade inválida: informe meses inteiros, ou 0 para não expira."
        )
    nome_limpo = (nome or "").strip()
    homonimo = s.execute(
        select(Treinamento).where(
            Treinamento.nome == nome_limpo, Treinamento.id != treinamento_id
        )
    ).scalar_one_or_none()
    if homonimo is not None:
        return _erro(CATALOGO, f"Já existe outro treinamento chamado '{nome_limpo}'.")
    alvo = s.get(Treinamento, treinamento_id)
    if alvo is None:
        return RedirectResponse(CATALOGO, status_code=303)
    modelo_escolhido = _id_opcional(modelo_vigente_id)
    instrutor_escolhido = _id_opcional(instrutor_padrao_id)
    erro = _confere_vinculos(s, alvo, modelo_escolhido, instrutor_escolhido)
    if erro:
        return _erro(CATALOGO, erro)
    return salvar_com_diff(
        s,
        usuario,
        Treinamento,
        treinamento_id,
        {
            "nome": nome_limpo,
            "carga_horaria_horas": horas,
            "validade_meses": meses,
            "norma_referencia": _texto(norma_referencia),
            "conteudo_programatico": _texto(conteudo_programatico),
            "modelo_vigente_id": modelo_escolhido,
            "instrutor_padrao_id": instrutor_escolhido,
            "obrigatorio": _marcado(obrigatorio),
            "ativo": _marcado(ativo),
        },
        permissao="treinamento.gerenciar",
        rotulo="Treinamento",
        volta=CATALOGO,
    )


# =====================================================================
# Modelos de certificado e o dicionário de tags
# =====================================================================
def _tela_modelos(
    request: Request,
    s,
    usuario,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o popup de cadastro em branco ou com o que foi digitado."""
    itens = list(
        s.execute(
            select(CertificadoModelo).order_by(
                CertificadoModelo.nome, CertificadoModelo.versao.desc()
            )
        ).scalars()
    )
    return pagina(
        request,
        "paginas/certificado_modelos.html",
        usuario=usuario,
        itens=itens,
        treinamentos=list(
            s.execute(select(Treinamento).order_by(Treinamento.nome)).scalars()
        ),
        orientacoes=ORIENTACOES,
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get(MODELOS)
def listar_modelos(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("treinamento.gerenciar")
    return _tela_modelos(request, s, usuario, mensagem=mensagem, erro=erro)


@rotas.post(MODELOS)
def criar_modelo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(...),
    arquivo: str = Form(...),
    treinamento_id: str = Form(""),
    orientacao: str = Form("PAISAGEM"),
    observacao: str = Form(""),
):
    usuario.exigir("treinamento.gerenciar")
    digitado = {
        "nome": nome,
        "arquivo": arquivo,
        "treinamento_id": treinamento_id,
        "orientacao": orientacao,
        "observacao": observacao,
    }

    def recusar(mensagem: str):
        """Renderiza a tela de novo, com o popup reaberto — nunca redireciona."""
        return _tela_modelos(request, s, usuario, erro=mensagem, digitado=digitado)

    nome_limpo = (nome or "").strip()
    arquivo_limpo = _arquivo_de_modelo(arquivo)
    if arquivo_limpo is None:
        return recusar("O modelo é um .docx de app/templates/certificados/.")
    if orientacao not in ORIENTACOES:
        return recusar("Orientação inválida.")
    alvo = _id_opcional(treinamento_id)
    ja = s.execute(
        select(CertificadoModelo).where(
            CertificadoModelo.nome == nome_limpo,
            CertificadoModelo.treinamento_id.is_(None)
            if alvo is None
            else CertificadoModelo.treinamento_id == alvo,
        )
    ).scalars().first()
    if ja is not None:
        return recusar(
            f"'{nome_limpo}' já existe — publique uma nova versão na ficha do modelo."
        )
    modelo = CertificadoModelo(
        treinamento_id=alvo,
        nome=nome_limpo,
        arquivo=arquivo_limpo,
        orientacao=orientacao,
        observacao=_texto(observacao),
        criado_por=usuario.id,
    )
    s.add(modelo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="certificado_modelo",
        entidade_id=modelo.id,
        tipo_evento="CERTIFICADO_MODELO_CRIADO",
        descricao=f"{modelo.rotulo} · {modelo.arquivo}",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        f"{MODELOS}/{modelo.id}?mensagem=Modelo cadastrado. Monte o dicionário de tags.",
        status_code=303,
    )


@rotas.get(MODELOS + "/{modelo_id}")
def ver_modelo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    modelo_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("treinamento.gerenciar")
    modelo = s.get(CertificadoModelo, modelo_id)
    if modelo is None:
        return RedirectResponse(MODELOS, status_code=303)
    return pagina(
        request,
        "paginas/certificado_modelo.html",
        usuario=usuario,
        modelo=modelo,
        conferencia=certificado.conferir_modelo(modelo.arquivo, modelo.mapa_de_tags),
        campos_por_grupo=certificado.campos_por_grupo(),
        campos=certificado.CAMPOS_CERTIFICADO,
        treinamentos=list(
            s.execute(select(Treinamento).order_by(Treinamento.nome)).scalars()
        ),
        orientacoes=ORIENTACOES,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post(MODELOS + "/{modelo_id}")
def editar_modelo(
    s: SessaoDep,
    usuario: UsuarioDep,
    modelo_id: int,
    nome: str = Form(...),
    arquivo: str = Form(...),
    treinamento_id: str = Form(""),
    orientacao: str = Form("PAISAGEM"),
    observacao: str = Form(""),
):
    usuario.exigir("treinamento.gerenciar")
    volta = f"{MODELOS}/{modelo_id}"
    modelo = s.get(CertificadoModelo, modelo_id)
    if modelo is None:
        return RedirectResponse(MODELOS, status_code=303)
    if not modelo.vigente:
        return _erro(
            volta,
            "Versão superada não se edita — ela é o layout de certificados já emitidos.",
        )
    arquivo_limpo = _arquivo_de_modelo(arquivo)
    if arquivo_limpo is None:
        return _erro(volta, "O modelo é um .docx de app/templates/certificados/.")
    if orientacao not in ORIENTACOES:
        return _erro(volta, "Orientação inválida.")
    nome_limpo = (nome or "").strip()
    alvo = _id_opcional(treinamento_id)
    # a mesma conferência que `criar_modelo` faz, excluindo o próprio id. Sem
    # ela, renomear para um nome ocupado devolvia página de erro do servidor —
    # e no modelo genérico nem isso, porque a UniqueConstraint não pega: NULL
    # não colide com NULL, e os dois homônimos passavam a conviver. As versões
    # do próprio modelo dividem o nome, então só se confere quando ele muda.
    if (nome_limpo, alvo) != (modelo.nome, modelo.treinamento_id):
        ja = s.execute(
            select(CertificadoModelo).where(
                CertificadoModelo.nome == nome_limpo,
                CertificadoModelo.id != modelo_id,
                CertificadoModelo.treinamento_id.is_(None)
                if alvo is None
                else CertificadoModelo.treinamento_id == alvo,
            )
        ).scalars().first()
        if ja is not None:
            return _erro(
                volta,
                f"Já existe outro modelo chamado '{nome_limpo}' — "
                "publique uma nova versão dele em vez de renomear este.",
            )
    return salvar_com_diff(
        s,
        usuario,
        CertificadoModelo,
        modelo_id,
        {
            "nome": nome_limpo,
            "arquivo": arquivo_limpo,
            "treinamento_id": alvo,
            "orientacao": orientacao,
            "observacao": _texto(observacao),
        },
        permissao="treinamento.gerenciar",
        rotulo="Modelo",
        volta=f"{MODELOS}/{modelo_id}",
    )


@rotas.post(MODELOS + "/{modelo_id}/versao")
def publicar_versao(s: SessaoDep, usuario: UsuarioDep, modelo_id: int):
    """Clona modelo e dicionário para a versão seguinte e aposenta a anterior.

    O mapa vem junto porque é ele que diz *qual dado vai em qual lugar* do
    documento: começar a versão nova com o mapa vazio convidaria a redigitar
    trinta linhas — e é redigitando que se troca o nome do instrutor pelo do
    participante.

    Pela mesma razão só a versão vigente publica a seguinte: clonar uma versão
    superada ressuscitaria o mapa dela e aposentaria a que vale, revertendo em
    silêncio qual dado vai em qual marcador — a falha mais silenciosa que este
    módulo pode ter (§4 do desenho).
    """
    usuario.exigir("treinamento.gerenciar")
    atual = s.get(CertificadoModelo, modelo_id)
    if atual is None:
        return RedirectResponse(MODELOS, status_code=303)
    if not atual.vigente:
        return _erro(
            f"{MODELOS}/{modelo_id}",
            "Versão superada não se edita — publique a nova versão a partir "
            "da que está vigente, para não perder o mapa dela.",
        )
    irmas = list(
        s.execute(
            select(CertificadoModelo).where(
                CertificadoModelo.nome == atual.nome,
                CertificadoModelo.treinamento_id.is_(None)
                if atual.treinamento_id is None
                else CertificadoModelo.treinamento_id == atual.treinamento_id,
            )
        ).scalars()
    )
    nova = CertificadoModelo(
        treinamento_id=atual.treinamento_id,
        nome=atual.nome,
        arquivo=atual.arquivo,
        orientacao=atual.orientacao,
        observacao=atual.observacao,
        versao=max(m.versao for m in irmas) + 1,
        vigente=True,
        criado_por=usuario.id,
    )
    for tag in atual.tags:
        nova.tags.append(
            CertificadoModeloTag(
                marcador=tag.marcador,
                campo=tag.campo,
                ordem=tag.ordem,
                obrigatorio=tag.obrigatorio,
            )
        )
    for antiga in irmas:
        antiga.vigente = False
    s.add(nova)
    s.flush()
    auditoria.registrar(
        s,
        entidade="certificado_modelo",
        entidade_id=nova.id,
        tipo_evento="CERTIFICADO_MODELO_VERSIONADO",
        descricao=f"{nova.rotulo} a partir de v{atual.versao} ({len(nova.tags)} tags)",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        f"{MODELOS}/{nova.id}?mensagem=Versão v{nova.versao} publicada.", status_code=303
    )


@rotas.post(MODELOS + "/{modelo_id}/tags")
def criar_tag(
    s: SessaoDep,
    usuario: UsuarioDep,
    modelo_id: int,
    marcador: str = Form(...),
    campo: str = Form(...),
    # default vazio, não "1": o FastAPI troca campo vazio pelo default, e com
    # "1" a queda para o fim da lista, logo abaixo, nunca acontecia
    ordem: str = Form(""),
    obrigatorio: str = Form(""),
):
    usuario.exigir("treinamento.gerenciar")
    volta = f"{MODELOS}/{modelo_id}"
    modelo = s.get(CertificadoModelo, modelo_id)
    if modelo is None:
        return RedirectResponse(MODELOS, status_code=303)
    if not modelo.vigente:
        return _erro(volta, "Versão superada não se edita.")
    limpo = (marcador or "").strip()
    if not confere_regex(limpo, PADRAO_MARCADOR):
        return _erro(
            volta,
            f"Marcador inválido: '{limpo}'. Use letra ou sublinhado no começo, "
            "depois letras, números e sublinhado.",
        )
    if campo not in certificado.CAMPOS_CERTIFICADO:
        # nunca chutar a chave: campo desconhecido sairia em branco no papel
        return _erro(volta, f"Campo desconhecido: '{campo}'.")
    if limpo in modelo.mapa_de_tags:
        return _erro(volta, f"O marcador '{limpo}' já está mapeado neste modelo.")
    posicao = _inteiro(ordem, minimo=1) or (len(modelo.tags) + 1)
    tag = CertificadoModeloTag(
        modelo_id=modelo.id,
        marcador=limpo,
        campo=campo,
        ordem=posicao,
        obrigatorio=_marcado(obrigatorio),
    )
    s.add(tag)
    s.flush()
    auditoria.registrar(
        s,
        entidade="certificado_modelo_tag",
        entidade_id=tag.id,
        tipo_evento="MODELO_TAG_MAPEADA",
        descricao=f"{modelo.rotulo}: {{{{ {limpo} }}}} ← {campo}",
        usuario=usuario,
    )
    s.commit()
    return _volta(volta, f"Marcador '{limpo}' mapeado para {campo}.")


@rotas.post(MODELOS + "/{modelo_id}/tags/{tag_id}")
def editar_tag(
    s: SessaoDep,
    usuario: UsuarioDep,
    modelo_id: int,
    tag_id: int,
    campo: str = Form(""),
    # ver `criar_tag`: com o default "1", apagar o número da ordem mandava a
    # tag para o topo do documento em vez de manter a ordem de hoje
    ordem: str = Form(""),
    obrigatorio: str = Form(""),
    remover: str = Form(""),
):
    usuario.exigir("treinamento.gerenciar")
    volta = f"{MODELOS}/{modelo_id}"
    tag = s.get(CertificadoModeloTag, tag_id)
    if tag is None or tag.modelo_id != modelo_id:
        return RedirectResponse(volta, status_code=303)
    if not tag.modelo.vigente:
        return _erro(volta, "Versão superada não se edita.")
    if _marcado(remover):
        auditoria.registrar(
            s,
            entidade="certificado_modelo_tag",
            entidade_id=tag.id,
            tipo_evento="MODELO_TAG_REMOVIDA",
            descricao=f"{tag.modelo.rotulo}: {{{{ {tag.marcador} }}}} ← {tag.campo}",
            usuario=usuario,
        )
        s.delete(tag)
        s.commit()
        return _volta(volta, f"Marcador '{tag.marcador}' removido do mapa.")
    if campo not in certificado.CAMPOS_CERTIFICADO:
        return _erro(volta, f"Campo desconhecido: '{campo}'.")
    return salvar_com_diff(
        s,
        usuario,
        CertificadoModeloTag,
        tag_id,
        {
            "campo": campo,
            "ordem": _inteiro(ordem, minimo=1) or tag.ordem,
            "obrigatorio": _marcado(obrigatorio),
        },
        permissao="treinamento.gerenciar",
        rotulo="Mapa de tags",
        volta=volta,
    )


# =====================================================================
# Assinaturas de instrutor
# =====================================================================
def _tela_assinaturas(
    request: Request,
    s,
    usuario,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o popup de cadastro em branco ou com o que foi digitado.

    Espelha `processos._tela_novo`: `digitado` nao entra na URL, entao a recusa
    do CADASTRO renderiza aqui em vez de redirecionar. A recusa da edicao EM
    LINHA continua com `_erro` — la a linha volta do banco intacta e nao ha o
    que preservar.
    """
    itens = list(
        s.execute(
            select(AssinaturaInstrutor).order_by(AssinaturaInstrutor.nome)
        ).scalars()
    )
    return pagina(
        request,
        "paginas/assinaturas.html",
        usuario=usuario,
        itens=itens,
        servidores=list(s.execute(select(Servidor).order_by(Servidor.nome)).scalars()),
        vinculos=VINCULOS_INSTRUTOR,
        em_uso={
            assinatura.id: s.execute(
                select(func.count())
                .select_from(Treinamento)
                .where(Treinamento.instrutor_padrao_id == assinatura.id)
            ).scalar_one()
            for assinatura in itens
        },
        hoje=date.today(),
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get(ASSINATURAS)
def listar_assinaturas(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("assinatura.gerenciar")
    return _tela_assinaturas(request, s, usuario, mensagem=mensagem, erro=erro)


def _dados_da_assinatura(
    s,
    *,
    externo: bool,
    servidor_id: int | None,
    nome: str,
    vigencia_inicio: str,
    vigencia_fim: str,
) -> tuple[dict | None, str]:
    """Valida o vínculo e devolve (campos, erro). Vínculo é o que dá trabalho.

    Instrutor da UFVJM precisa de servidor: sem isso o nome do assinante
    divergiria do cadastro no dia em que alguém corrigisse um dos dois.
    """
    if not externo and servidor_id is None:
        return None, "Instrutor da UFVJM precisa estar vinculado a um servidor."
    servidor = s.get(Servidor, servidor_id) if servidor_id else None
    if servidor_id is not None and servidor is None:
        return None, "Servidor não encontrado."
    # `nome` é NOT NULL por desenho; para o interno ele nasce do cadastro e a
    # exibição continua lendo `servidor.nome`, então os dois não divergem
    nome_limpo = (nome or "").strip() or (servidor.nome if servidor else "")
    if not nome_limpo:
        return None, "Informe o nome do instrutor."
    try:
        inicio = date.fromisoformat(vigencia_inicio.strip())
    except ValueError:
        return None, "Informe o início da vigência (AAAA-MM-DD)."
    fim = None
    if (vigencia_fim or "").strip():
        try:
            fim = date.fromisoformat(vigencia_fim.strip())
        except ValueError:
            return None, "Fim de vigência inválido."
        if fim < inicio:
            return None, "O fim da vigência não pode ser anterior ao início."
    return {
        "servidor_id": servidor.id if servidor else None,
        "nome": nome_limpo,
        "externo": externo,
        "vigencia_inicio": inicio,
        "vigencia_fim": fim,
    }, ""


@rotas.post(ASSINATURAS)
def criar_assinatura(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(""),
    servidor_id: str = Form(""),
    titulo: str = Form(""),
    conselho: str = Form(""),
    registro_conselho: str = Form(""),
    organizacao: str = Form(""),
    externo: str = Form(""),
    vigencia_inicio: str = Form(...),
    vigencia_fim: str = Form(""),
):
    usuario.exigir("assinatura.gerenciar")
    e_externo = _marcado(externo)
    campos, erro = _dados_da_assinatura(
        s,
        externo=e_externo,
        servidor_id=None if e_externo else _id_opcional(servidor_id),
        nome=nome,
        vigencia_inicio=vigencia_inicio,
        vigencia_fim=vigencia_fim,
    )
    if campos is None:
        # Tudo o que foi digitado, guardado antes da primeira recusa: eram nove
        # campos perdidos porque quem cadastra instrutor da UFVJM esquece de
        # escolher o servidor, que e justamente o erro mais comum daqui.
        return _tela_assinaturas(
            request,
            s,
            usuario,
            erro=erro,
            digitado={
                "nome": nome,
                "servidor_id": servidor_id,
                "titulo": titulo,
                "conselho": conselho,
                "registro_conselho": registro_conselho,
                "organizacao": organizacao,
                "externo": externo,
                "vigencia_inicio": vigencia_inicio,
                "vigencia_fim": vigencia_fim,
            },
        )
    assinatura = AssinaturaInstrutor(
        **campos,
        titulo=_texto(titulo),
        conselho=(_texto(conselho) or "").upper() or None,
        registro_conselho=_texto(registro_conselho),
        organizacao=_texto(organizacao),
    )
    s.add(assinatura)
    s.flush()
    auditoria.registrar(
        s,
        entidade="assinatura_instrutor",
        entidade_id=assinatura.id,
        tipo_evento="ASSINATURA_INSTRUTOR_CRIADA",
        descricao=(
            f"{assinatura.nome}"
            + (f" · {assinatura.titulo}" if assinatura.titulo else "")
            + (" · externo" if assinatura.externo else " · servidor")
        ),
        usuario=usuario,
    )
    s.commit()
    return _volta(ASSINATURAS, f"Assinatura de {assinatura.nome} cadastrada.")


@rotas.post(ASSINATURAS + "/{assinatura_id}")
def editar_assinatura(
    s: SessaoDep,
    usuario: UsuarioDep,
    assinatura_id: int,
    nome: str = Form(""),
    servidor_id: str = Form(""),
    titulo: str = Form(""),
    conselho: str = Form(""),
    registro_conselho: str = Form(""),
    organizacao: str = Form(""),
    externo: str = Form(""),
    vigencia_inicio: str = Form(...),
    vigencia_fim: str = Form(""),
    ativo: str = Form(""),
):
    usuario.exigir("assinatura.gerenciar")
    e_externo = _marcado(externo)
    campos, erro = _dados_da_assinatura(
        s,
        externo=e_externo,
        servidor_id=None if e_externo else _id_opcional(servidor_id),
        nome=nome,
        vigencia_inicio=vigencia_inicio,
        vigencia_fim=vigencia_fim,
    )
    if campos is None:
        return _erro(ASSINATURAS, erro)
    return salvar_com_diff(
        s,
        usuario,
        AssinaturaInstrutor,
        assinatura_id,
        {
            **campos,
            "titulo": _texto(titulo),
            "conselho": (_texto(conselho) or "").upper() or None,
            "registro_conselho": _texto(registro_conselho),
            "organizacao": _texto(organizacao),
            "ativo": _marcado(ativo),
        },
        permissao="assinatura.gerenciar",
        rotulo="Assinatura",
        volta=ASSINATURAS,
    )
