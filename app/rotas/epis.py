"""/epis/* — o catálogo do módulo Gestão de EPI.

Fatia 1 do desenho (`entrada/integrasst/desenho_epi.md`): o item de EPI, a
taxonomia da NR-6 e os motivos de recusa. As três telas seguem o padrão de
`/catalogos` e de `/treinamentos/catalogo` — lista com edição em linha,
formulário de cadastro embaixo e diff campo a campo na auditoria.

Duas coisas que esta tela existe para desfazer, e que valem mais que o cadastro
em si:

1. **`validade_ca` aparece.** É a única coluna do módulo com consequência
   jurídica direta: pela NR-6, EPI com CA vencido não é EPI — o CA é o que o
   constitui como equipamento de proteção. No legado a coluna existia no modelo
   e **não estava no formulário**; ou alguém preenchia direto na planilha, ou a
   regra nunca rodou.
2. **As colunas que governam a requisição aparecem.** `Qtd_Padrao`, `Qtd_Maxima`
   e `Exige_Justificativa` estavam entre as nove das 22 colunas do legado que o
   formulário nunca expôs — e não é coincidência de acabamento que as que
   governam a regra sejam justamente as escondidas. Regra que uma pessoa não
   consegue ver não é regra, é armadilha.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import EpiCategoria, EpiItem, EpiMotivoRecusa
from app.modelos.epi import UNIDADES_MEDIDA
from app.servicos import auditoria, textos
from app.web import numero_da_pagina, pagina, recortar, salvar_com_diff

rotas = APIRouter(tags=["epis"])

CATALOGO = "/epis/catalogo"
CATEGORIAS = "/epis/catalogo/categorias"
MOTIVOS = "/epis/catalogo/motivos-recusa"

# Rótulo e caminho das três abas. Fica aqui, e não no template, porque é a mesma
# lista em três telas: duplicada, uma aba nova apareceria em duas e sumiria na
# terceira.
ABAS: tuple[tuple[str, str], ...] = (
    (CATALOGO, "Itens de EPI"),
    (CATEGORIAS, "Categorias (NR-6)"),
    (MOTIVOS, "Motivos de recusa"),
)


def _texto(valor: str | None) -> str | None:
    return (valor or "").strip() or None


def _marcado(valor: str) -> bool:
    return valor == "1"


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """O recado vai codificado: o texto do catálogo é digitado.

    Rótulo de motivo, nome de item e modelo saem daqui dentro da mensagem, e um
    `&` ou `#` no meio deles encerrava a query string ali — o recado chegava
    cortado na palavra que a pessoa acabara de escrever. `quote_via=quote` para
    o espaço voltar espaço em quem só desfaz `%XX`.
    """
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(destino: str, mensagem: str) -> RedirectResponse:
    """Deu certo. Banner verde (`base.html`, `.aviso-ok`)."""
    return _aviso(destino, "mensagem", mensagem)


def _erro(destino: str, mensagem: str) -> RedirectResponse:
    """Não deu. Banner vermelho.

    As telas irmãs do módulo — `/epis/estoque`, `/epis/requisicoes`,
    `/epis/fichas` — já separavam os dois canais desde a fatia 2; só o catálogo
    ficou com um só, e era o verde. "Já existe o motivo VINCULO_NAO_ATENDIDO"
    saía com a mesma cor de "Motivo cadastrado", numa tela de edição em linha em
    que nada mais muda para dizer o contrário.
    """
    return _aviso(destino, "erro", mensagem)


def _inteiro(valor: str) -> int | None:
    """Inteiro positivo, ou None quando o campo vem vazio.

    Devolve `None` tanto para vazio quanto para lixo de propósito: quem chama
    distingue os dois casos olhando o texto bruto antes, porque só ele sabe se o
    campo é obrigatório.
    """
    limpo = (valor or "").strip()
    if not limpo.isdigit():
        return None
    numero = int(limpo)
    return numero if numero > 0 else None


def _data(valor: str) -> date | None:
    limpo = (valor or "").strip()
    if not limpo:
        return None
    try:
        return date.fromisoformat(limpo[:10])
    except ValueError:
        return None


def _campos_do_item(
    *,
    nome: str,
    categoria_id: str,
    descricao: str,
    codigo_ecampus: str,
    codigo_catmat: str,
    fabricante: str,
    marca: str,
    modelo: str,
    normas: str,
    exige_ca: str,
    numero_ca: str,
    validade_ca: str,
    unidade_medida: str,
    tamanhos: str,
    vida_util_meses: str,
    quantidade_padrao: str,
    quantidade_maxima: str,
    periodo_maximo_meses: str,
    exige_justificativa: str,
    exige_treinamento: str,
) -> tuple[dict | None, str]:
    """Lê o formulário e devolve `(campos, erro)`. Um dos dois é sempre vazio.

    A conferência mora aqui, e não em cada rota, porque cadastro e edição
    precisam da mesma: foi a edição sem a guarda do cadastro que contornou a
    regra em `/treinamentos/modelos`. E ela roda **antes** do banco para que a
    pessoa leia "a máxima não pode ser menor que a padrão" em vez de uma
    `IntegrityError` com o nome de uma constraint.
    """
    nome_limpo = (nome or "").strip()
    if not nome_limpo:
        return None, "O nome do EPI não pode ficar em branco."
    if not (categoria_id or "").strip().isdigit():
        return None, "Escolha a categoria da NR-6."

    padrao = _inteiro(quantidade_padrao)
    if padrao is None:
        return None, "Quantidade padrão inválida: informe um número maior que zero."

    # O par (máxima, janela) anda junto: "2 por ano" é regra, "2" não é nada.
    # É o `ck_epi_janela` do modelo, e é a RN-26.
    maxima = _inteiro(quantidade_maxima)
    janela = _inteiro(periodo_maximo_meses)
    tem_maxima = bool((quantidade_maxima or "").strip())
    tem_janela = bool((periodo_maximo_meses or "").strip())
    if tem_maxima != tem_janela:
        return None, (
            "Quantidade máxima e período andam juntos: "
            "'2 por 12 meses' é regra, '2' sozinho não quer dizer nada."
        )
    if tem_maxima and (maxima is None or janela is None):
        return None, "Quantidade máxima e período: informe números maiores que zero."
    if maxima is not None and maxima < padrao:
        return None, "A quantidade máxima não pode ser menor que a padrão."

    vida_util = _inteiro(vida_util_meses)
    if (vida_util_meses or "").strip() and vida_util is None:
        return None, "Vida útil inválida: informe meses inteiros maiores que zero."

    # RN-25 nasce aqui: item que exige CA sem número de CA é item que a entrega
    # não sabe conferir. "Não sei" não é "está válido".
    exige = _marcado(exige_ca)
    ca = _texto(numero_ca)
    if exige and not ca:
        return None, (
            "Item que exige CA precisa do número do CA: "
            "sem ele não há o que conferir na hora de entregar."
        )

    validade = _data(validade_ca)
    if (validade_ca or "").strip() and validade is None:
        return None, "Data de validade do CA inválida."

    return {
        "nome": nome_limpo,
        "categoria_id": int(categoria_id),
        "descricao": _texto(descricao),
        "codigo_ecampus": _texto(codigo_ecampus),
        "codigo_catmat": _texto(codigo_catmat),
        "fabricante": _texto(fabricante),
        "marca": _texto(marca),
        "modelo": _texto(modelo),
        "normas": _texto(normas),
        "exige_ca": exige,
        "numero_ca": ca,
        "validade_ca": validade,
        "unidade_medida": (_texto(unidade_medida) or "UNIDADE").upper()[:20],
        "tamanhos": _texto(tamanhos),
        "vida_util_meses": vida_util,
        "quantidade_padrao": padrao,
        "quantidade_maxima": maxima,
        "periodo_maximo_meses": janela,
        "exige_justificativa": _marcado(exige_justificativa),
        "exige_treinamento": _marcado(exige_treinamento),
    }, ""


def _homonimo(s, nome: str, modelo: str | None, excluir: int | None = None):
    """O par (nome, modelo) é a chave de negócio — `uq_epi_item`.

    A conferência é feita aqui além do índice porque no SQLite (e no
    PostgreSQL) `NULL` não colide com `NULL`: dois itens de mesmo nome e sem
    modelo passariam pelo unique e virariam duas linhas para a mesma bota.
    """
    consulta = select(EpiItem).where(EpiItem.nome == nome)
    consulta = (
        consulta.where(EpiItem.modelo.is_(None))
        if modelo is None
        else consulta.where(EpiItem.modelo == modelo)
    )
    if excluir is not None:
        consulta = consulta.where(EpiItem.id != excluir)
    return s.execute(consulta).scalar_one_or_none()


def _categorias(s) -> list[EpiCategoria]:
    return list(
        s.execute(
            select(EpiCategoria).order_by(EpiCategoria.ordem, EpiCategoria.nome)
        ).scalars()
    )


# =====================================================================
# Itens de EPI
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

    Existe separada da rota GET pelo mesmo motivo de `catalogos._tela`:
    `digitado` é dicionário e não atravessa redirecionamento nenhum — e o
    FastAPI leria um parâmetro de rota GET com esse nome como query. A recusa da
    EDIÇÃO em linha continua com `_erro`: ali a linha volta do banco intacta e
    não há o que preservar.
    """
    itens = list(
        s.execute(select(EpiItem).order_by(EpiItem.nome, EpiItem.modelo)).scalars()
    )
    # O aviso vermelho do alto conta o CATALOGO INTEIRO, e nao a pagina. Ele
    # dizia `{% for i in itens %}` no template, e com a lista paginada isso
    # passaria a contar so o que esta na tela: "2 itens com CA vencido" numa
    # pagina, "0" na seguinte, sem nada explicando a diferenca. Pela NR-6 o CA e
    # o que constitui o equipamento como EPI — um alerta que encolhe ao virar de
    # pagina e pior do que alerta nenhum. Por isso a conta subiu para ca, onde a
    # lista inteira ainda existe.
    hoje = date.today()
    com_ca_vencido = [
        i
        for i in itens
        if i.exige_ca and i.ativo and (i.validade_ca is None or i.validade_ca < hoje)
    ]
    recorte = recortar(itens, numero_da_pagina(request))
    return pagina(
        request,
        "paginas/epis_catalogo.html",
        usuario=usuario,
        abas=ABAS,
        aba=CATALOGO,
        itens=recorte.itens,
        recorte=recorte,
        com_ca_vencido=com_ca_vencido,
        categorias=_categorias(s),
        unidades=UNIDADES_MEDIDA,
        hoje=hoje,
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
    """Abre em leitura para quem tem `epi.ver`; editar pede `epi.catalogo`."""
    usuario.exigir("epi.ver")
    return _tela_catalogo(request, s, usuario, mensagem=mensagem, erro=erro)


@rotas.post(CATALOGO)
def criar_item(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(...),
    categoria_id: str = Form(...),
    descricao: str = Form(""),
    codigo_ecampus: str = Form(""),
    codigo_catmat: str = Form(""),
    fabricante: str = Form(""),
    marca: str = Form(""),
    modelo: str = Form(""),
    normas: str = Form(""),
    exige_ca: str = Form(""),
    numero_ca: str = Form(""),
    validade_ca: str = Form(""),
    unidade_medida: str = Form("UNIDADE"),
    tamanhos: str = Form(""),
    vida_util_meses: str = Form(""),
    # o default NÃO é "1": o FastAPI troca campo vazio pelo default antes de a
    # rota ver, e com "1" o campo apagado viraria "uma unidade" em silêncio
    quantidade_padrao: str = Form(""),
    quantidade_maxima: str = Form(""),
    periodo_maximo_meses: str = Form(""),
    exige_justificativa: str = Form(""),
    exige_treinamento: str = Form(""),
):
    usuario.exigir("epi.catalogo")
    # Tudo o que foi digitado, guardado antes da primeira recusa. São vinte
    # campos, e as guardas de `_campos_do_item` recusam justamente as combinações
    # que se descobrem no fim (máxima sem janela, item que exige CA sem número):
    # redigitar tamanhos, normas e descrição por causa delas era o custo real.
    digitado = {
        "nome": nome,
        "categoria_id": categoria_id,
        "descricao": descricao,
        "codigo_ecampus": codigo_ecampus,
        "codigo_catmat": codigo_catmat,
        "fabricante": fabricante,
        "marca": marca,
        "modelo": modelo,
        "normas": normas,
        "exige_ca": exige_ca,
        "numero_ca": numero_ca,
        "validade_ca": validade_ca,
        "unidade_medida": unidade_medida,
        "tamanhos": tamanhos,
        "vida_util_meses": vida_util_meses,
        "quantidade_padrao": quantidade_padrao,
        "quantidade_maxima": quantidade_maxima,
        "periodo_maximo_meses": periodo_maximo_meses,
        "exige_justificativa": exige_justificativa,
        "exige_treinamento": exige_treinamento,
    }

    def recusar(mensagem: str):
        """Renderiza a tela de novo, com o popup reaberto — nunca redireciona."""
        return _tela_catalogo(request, s, usuario, erro=mensagem, digitado=digitado)

    campos, erro = _campos_do_item(
        nome=nome,
        categoria_id=categoria_id,
        descricao=descricao,
        codigo_ecampus=codigo_ecampus,
        codigo_catmat=codigo_catmat,
        fabricante=fabricante,
        marca=marca,
        modelo=modelo,
        normas=normas,
        exige_ca=exige_ca,
        numero_ca=numero_ca,
        validade_ca=validade_ca,
        unidade_medida=unidade_medida,
        tamanhos=tamanhos,
        vida_util_meses=vida_util_meses,
        quantidade_padrao=quantidade_padrao,
        quantidade_maxima=quantidade_maxima,
        periodo_maximo_meses=periodo_maximo_meses,
        exige_justificativa=exige_justificativa,
        exige_treinamento=exige_treinamento,
    )
    if campos is None:
        return recusar(erro)
    if s.get(EpiCategoria, campos["categoria_id"]) is None:
        return recusar("Categoria não encontrada.")
    if _homonimo(s, campos["nome"], campos["modelo"]) is not None:
        return recusar(
            f"Já existe '{campos['nome']}' com esse modelo. "
            "Para cadastrar outro, informe o modelo que os distingue."
        )

    item = EpiItem(**campos)
    s.add(item)
    s.flush()
    auditoria.registrar(
        s,
        entidade="epi_item",
        entidade_id=item.id,
        tipo_evento="EPI_ITEM_CRIADO",
        descricao=(
            f"{item.nome} · {item.categoria.nome} · "
            f"CA {item.numero_ca or '—'} · {item.regra_de_quantidade}"
        ),
        usuario=usuario,
    )
    s.commit()
    return _volta(CATALOGO, f"'{item.nome}' cadastrado.")


# =====================================================================
# Categorias da NR-6
# =====================================================================
@rotas.get(CATEGORIAS)
def categorias(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("epi.ver")
    itens = _categorias(s)
    # quantos itens estão em cada categoria: desativar uma categoria em uso
    # esconde o item do formulário, e quem edita precisa saber disso antes
    em_uso = {
        categoria.id: s.execute(
            select(func.count())
            .select_from(EpiItem)
            .where(EpiItem.categoria_id == categoria.id)
        ).scalar_one()
        for categoria in itens
    }
    return pagina(
        request,
        "paginas/epis_categorias.html",
        usuario=usuario,
        abas=ABAS,
        aba=CATEGORIAS,
        itens=itens,
        em_uso=em_uso,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post(CATEGORIAS + "/{categoria_id}")
def editar_categoria(
    s: SessaoDep,
    usuario: UsuarioDep,
    categoria_id: int,
    nome: str = Form(...),
    referencia_nr6: str = Form(""),
    ordem: str = Form("1"),
    ativo: str = Form(""),
):
    """Só o rótulo, a referência e a ordem. Não há cadastro de categoria nova.

    A lista é o Anexo I da NR-6, e a norma a fecha em nove. Criar a décima pela
    tela seria inventar norma — o mesmo motivo pelo qual `/catalogos/percentuais`
    e `/catalogos/tipos-risco` também só editam o que os seeds trouxeram.
    """
    numero = _inteiro(ordem)
    return salvar_com_diff(
        s,
        usuario,
        EpiCategoria,
        categoria_id,
        {
            "nome": nome.strip(),
            "referencia_nr6": _texto(referencia_nr6),
            "ordem": numero if numero is not None else 1,
            "ativo": _marcado(ativo),
        },
        permissao="epi.catalogo",
        rotulo="Categoria",
        volta=CATEGORIAS,
    )


# =====================================================================
# Motivos de recusa
# =====================================================================
def _tela_motivos(
    request: Request,
    s,
    usuario,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A lista, com o popup de cadastro em branco ou com o que foi digitado.

    Mesma forma de `_tela_catalogo`, e pelo mesmo motivo: o texto da negativa é
    o campo caro desta tela — quatro linhas escritas com cuidado, que uma recusa
    de código duplicado apagava inteiras.
    """
    itens = list(
        s.execute(select(EpiMotivoRecusa).order_by(EpiMotivoRecusa.codigo)).scalars()
    )
    return pagina(
        request,
        "paginas/epis_motivos.html",
        usuario=usuario,
        abas=ABAS,
        aba=MOTIVOS,
        itens=itens,
        mensagem=mensagem,
        erro=erro,
        digitado=digitado or {},
    )


@rotas.get(MOTIVOS)
def motivos_recusa(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("epi.ver")
    return _tela_motivos(request, s, usuario, mensagem=mensagem, erro=erro)


@rotas.post(MOTIVOS)
def criar_motivo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    codigo: str = Form(...),
    rotulo: str = Form(...),
    texto: str = Form(...),
    base_normativa: str = Form(""),
    exige_complemento: str = Form(""),
):
    """Motivo novo. O código é caixa alta e não se edita depois.

    Ele é citado no relatório de recusas por motivo e no despacho que sai para o
    requerente; caixa mista viraria duas grafias do mesmo motivo, e a contagem —
    que é a razão de o catálogo existir — passaria a somar errado.
    """
    usuario.exigir("epi.catalogo")
    digitado = {
        "codigo": codigo,
        "rotulo": rotulo,
        "texto": texto,
        "base_normativa": base_normativa,
        "exige_complemento": exige_complemento,
    }

    def recusar(mensagem: str):
        """Renderiza a tela de novo, com o popup reaberto — nunca redireciona."""
        return _tela_motivos(request, s, usuario, erro=mensagem, digitado=digitado)

    codigo_limpo = (codigo or "").strip().upper().replace(" ", "_")
    if not codigo_limpo or not codigo_limpo.replace("_", "").isalnum():
        return recusar(
            "Código inválido: use letras maiúsculas, números e sublinhado "
            "(VINCULO_NAO_ATENDIDO)."
        )
    corpo = (texto or "").strip()
    if not corpo:
        return recusar("O texto da recusa não pode ficar em branco.")
    ja = s.execute(
        select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == codigo_limpo)
    ).scalar_one_or_none()
    if ja is not None:
        return recusar(f"Já existe o motivo {codigo_limpo}.")

    motivo = EpiMotivoRecusa(
        codigo=codigo_limpo,
        rotulo=(rotulo or "").strip() or codigo_limpo,
        # aspas retas viram curvas uma vez, aqui — nunca a cada render
        texto=textos.aspas_curvas(corpo),
        base_normativa=_texto(base_normativa),
        exige_complemento=_marcado(exige_complemento),
        dispositivo_conferido_em=date.today(),
    )
    s.add(motivo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="epi_motivo_recusa",
        entidade_id=motivo.id,
        tipo_evento="EPI_MOTIVO_RECUSA_CRIADO",
        descricao=f"{motivo.codigo} · {motivo.rotulo}",
        usuario=usuario,
    )
    s.commit()
    return _volta(MOTIVOS, f"Motivo {codigo_limpo} cadastrado.")


@rotas.post(MOTIVOS + "/{motivo_id}")
def editar_motivo(
    s: SessaoDep,
    usuario: UsuarioDep,
    motivo_id: int,
    rotulo: str = Form(...),
    texto: str = Form(...),
    base_normativa: str = Form(""),
    exige_complemento: str = Form(""),
    ativo: str = Form(""),
):
    """Editar o motivo NÃO reescreve a negativa que já saiu.

    O que protege a recusa emitida é `epi_requisicao_item.texto_recusa_snapshot`
    (RN-27), que congela o texto no ato da decisão — mesmo princípio do
    `cargo_snapshot` do parecer. Por isso aqui a edição é direta, com diff na
    auditoria, e não versionada como `/catalogos/textos-padrao`: `codigo` é
    único, e duas garantias para o mesmo fato é como uma delas deixa de valer.
    """
    corpo = (texto or "").strip()
    if not corpo:
        return _erro(MOTIVOS, "O texto da recusa não pode ficar em branco.")
    return salvar_com_diff(
        s,
        usuario,
        EpiMotivoRecusa,
        motivo_id,
        {
            "rotulo": rotulo.strip(),
            "texto": textos.aspas_curvas(corpo),
            "base_normativa": _texto(base_normativa),
            "exige_complemento": _marcado(exige_complemento),
            "ativo": _marcado(ativo),
            "dispositivo_conferido_em": date.today(),
        },
        permissao="epi.catalogo",
        rotulo="Motivo de recusa",
        volta=MOTIVOS,
    )


# =====================================================================
# Edição do item — por último, porque `/{item_id}` casaria com as rotas
# fixas acima se viesse antes: o roteador atende na ordem em que se declara.
# =====================================================================
@rotas.post(CATALOGO + "/{item_id}")
def editar_item(
    s: SessaoDep,
    usuario: UsuarioDep,
    item_id: int,
    nome: str = Form(...),
    categoria_id: str = Form(...),
    descricao: str = Form(""),
    codigo_ecampus: str = Form(""),
    codigo_catmat: str = Form(""),
    fabricante: str = Form(""),
    marca: str = Form(""),
    modelo: str = Form(""),
    normas: str = Form(""),
    exige_ca: str = Form(""),
    numero_ca: str = Form(""),
    validade_ca: str = Form(""),
    unidade_medida: str = Form("UNIDADE"),
    tamanhos: str = Form(""),
    vida_util_meses: str = Form(""),
    quantidade_padrao: str = Form(""),
    quantidade_maxima: str = Form(""),
    periodo_maximo_meses: str = Form(""),
    exige_justificativa: str = Form(""),
    exige_treinamento: str = Form(""),
    ativo: str = Form(""),
):
    """Renomear é seguro para o que já saiu: a entrega congela o nome do EPI, o
    CA e o lote na linha da ficha (RN-15 aplicada ao EPI)."""
    usuario.exigir("epi.catalogo")
    campos, erro = _campos_do_item(
        nome=nome,
        categoria_id=categoria_id,
        descricao=descricao,
        codigo_ecampus=codigo_ecampus,
        codigo_catmat=codigo_catmat,
        fabricante=fabricante,
        marca=marca,
        modelo=modelo,
        normas=normas,
        exige_ca=exige_ca,
        numero_ca=numero_ca,
        validade_ca=validade_ca,
        unidade_medida=unidade_medida,
        tamanhos=tamanhos,
        vida_util_meses=vida_util_meses,
        quantidade_padrao=quantidade_padrao,
        quantidade_maxima=quantidade_maxima,
        periodo_maximo_meses=periodo_maximo_meses,
        exige_justificativa=exige_justificativa,
        exige_treinamento=exige_treinamento,
    )
    if campos is None:
        return _erro(CATALOGO, erro)
    if s.get(EpiCategoria, campos["categoria_id"]) is None:
        return _erro(CATALOGO, "Categoria não encontrada.")
    if _homonimo(s, campos["nome"], campos["modelo"], excluir=item_id) is not None:
        return _erro(CATALOGO, f"Já existe outro item '{campos['nome']}' com esse modelo.")
    campos["ativo"] = _marcado(ativo)
    return salvar_com_diff(
        s,
        usuario,
        EpiItem,
        item_id,
        campos,
        permissao="epi.catalogo",
        rotulo="Item de EPI",
        volta=CATALOGO,
    )
