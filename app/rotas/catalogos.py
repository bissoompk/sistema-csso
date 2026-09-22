"""/catalogos/* - catalogos versionados do dominio."""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AgenteNocivo,
    Campus,
    Cargo,
    ChecklistModelo,
    FundamentacaoLegal,
    PercentualAplicavel,
    PortariaLocalizacao,
    PostoTrabalho,
    Servidor,
    TextoPadrao,
    TipoProcesso,
    TipoRisco,
    UnidadeUorg,
)
from app.modelos.estados import ROTULO_ESTADO_TELA
from app.servicos import auditoria, datas_br, textos
from app.servicos.importacao_planilha import analisar_portaria
from app.web import pagina, salvar_com_diff

rotas = APIRouter(tags=["catalogos"])

CATALOGOS = [
    ("campi", "Campi"),
    ("unidades-uorg", "Unidades / UORG"),
    ("postos-trabalho", "Postos de trabalho"),
    ("cargos", "Cargos"),
    ("agentes-nocivos", "Agentes nocivos"),
    ("tipos-risco", "Tipos de risco"),
    ("fundamentacoes-legais", "Fundamentações legais"),
    ("percentuais", "Percentuais aplicáveis"),
    ("textos-padrao", "Textos padrão"),
    ("portarias", "Portarias de localização"),
    ("checklists-modelo", "Checklists modelo"),
]

TIPOS_UNIDADE = [
    ("FACULDADE", "Faculdade"),
    ("INSTITUTO", "Instituto"),
    ("DEPARTAMENTO", "Departamento"),
    ("PRO_REITORIA", "Pró-Reitoria"),
    ("DIRETORIA", "Diretoria"),
    ("COORDENADORIA", "Coordenadoria"),
    ("SUPERINTENDENCIA", "Superintendência"),
    ("SECRETARIA", "Secretaria"),
    ("OUTRO", "Outro"),
]


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """O recado vai codificado: quase toda mensagem daqui cita o que foi digitado.

    "O cargo 'TÉCNICO EM Q&A' já está cadastrado" perdia tudo a partir do `&` —
    e o que sobrava, "O cargo 'TÉCNICO EM Q", parecia defeito do sistema e não
    recusa de duplicata. `quote_via=quote` e não o `+` padrão para o espaço
    voltar espaço em quem só desfaz `%XX`.
    """
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(destino: str, mensagem: str) -> RedirectResponse:
    """Deu certo. Banner verde (`base.html`, `.aviso-ok`)."""
    return _aviso(destino, "mensagem", mensagem)


def _erro(destino: str, mensagem: str) -> RedirectResponse:
    """A recusa volta no banner vermelho, e não no verde de `?mensagem=`.

    Numa tela de edição em linha a caixa de aviso é a única coisa que muda entre
    "gravou" e "não gravou": a linha continua na tabela nos dois casos, com o
    valor de antes. "Já existe unidade com o código X" pintado de verde é o
    sistema afirmando que gravou o que recusou.
    """
    return _aviso(destino, "erro", mensagem)


@rotas.get("/catalogos")
def indice(request: Request, usuario: UsuarioDep):
    usuario.exigir("processo.ver")
    return pagina(request, "paginas/catalogos.html", usuario=usuario, catalogos=CATALOGOS)


def _tela(
    request: Request,
    s,
    usuario,
    nome: str,
    *,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
):
    """A tela do catálogo, com o popup de cadastro em branco ou com o digitado.

    Existe separada da rota GET pelo mesmo motivo de `processos._tela_novo`:
    `digitado` é um dicionário e não atravessa redirecionamento nenhum. As
    recusas de EDIÇÃO em linha continuam redirecionando com `?erro=` — ali a
    linha da tabela é o formulário e ela volta do banco intacta —, e as de
    CADASTRO renderizam aqui, para o popup reabrir com o que foi digitado.
    """
    # listas compartilhadas: os formulários de edição precisam delas em
    # praticamente toda tela, e buscá-las aqui evita meia dúzia de ramos iguais
    dados: dict = {
        "nome": nome,
        "catalogos": CATALOGOS,
        "mensagem": mensagem,
        "erro": erro,
        "digitado": digitado or {},
        "campi": list(s.execute(select(Campus).order_by(Campus.sigla)).scalars()),
        "tipos": TIPOS_UNIDADE,
        "riscos": list(s.execute(select(TipoRisco).order_by(TipoRisco.nome)).scalars()),
        "fundamentacoes": list(
            s.execute(select(FundamentacaoLegal).order_by(FundamentacaoLegal.codigo)).scalars()
        ),
        "unidades": list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()
        ),
        "tipos_processo": list(s.execute(select(TipoProcesso)).scalars()),
        # só os códigos, na ordem em que a tela os escreve: o `<option>` do
        # modelo de checklist escreve `{{ codigo|estado }}`, e o rótulo ASCII
        # que vinha no par ia junto sem ninguém ler.
        "estados": [
            codigo
            for codigo, _ in sorted(ROTULO_ESTADO_TELA.items(), key=lambda kv: kv[1])
        ],
    }
    if nome == "campi":
        dados["itens"] = list(s.execute(select(Campus).order_by(Campus.sigla)).scalars())
    elif nome == "unidades-uorg":
        dados["itens"] = list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_oficial)).scalars()
        )
    elif nome == "postos-trabalho":
        dados["itens"] = list(
            s.execute(select(PostoTrabalho).order_by(PostoTrabalho.nome)).scalars()
        )
    elif nome == "agentes-nocivos":
        dados["itens"] = list(
            s.execute(select(AgenteNocivo).order_by(AgenteNocivo.descricao)).scalars()
        )
    elif nome == "tipos-risco":
        dados["itens"] = list(s.execute(select(TipoRisco)).scalars())
    elif nome == "fundamentacoes-legais":
        dados["itens"] = list(s.execute(select(FundamentacaoLegal)).scalars())
    elif nome == "percentuais":
        dados["itens"] = list(s.execute(select(PercentualAplicavel)).scalars())
    elif nome == "textos-padrao":
        dados["itens"] = list(
            s.execute(select(TextoPadrao).order_by(TextoPadrao.categoria, TextoPadrao.codigo)).scalars()
        )
    elif nome == "portarias":
        dados["itens"] = list(
            s.execute(
                select(PortariaLocalizacao).order_by(PortariaLocalizacao.data_publicacao.desc())
            ).scalars()
        )
        dados["emissoras"] = list(
            s.execute(select(UnidadeUorg).where(UnidadeUorg.emite_portaria)).scalars()
        )
    elif nome == "checklists-modelo":
        dados["itens"] = list(
            s.execute(select(ChecklistModelo).order_by(ChecklistModelo.nome)).scalars()
        )
    elif nome == "cargos":
        itens = list(s.execute(select(Cargo).order_by(Cargo.nome)).scalars())
        dados["itens"] = itens
        # quantos servidores estao em cada cargo: renomear um cargo em uso
        # muda o que aparece nas telas, e quem edita precisa saber disso
        dados["em_uso"] = {
            cargo.id: s.execute(
                select(func.count()).select_from(Servidor).where(Servidor.cargo_id == cargo.id)
            ).scalar_one()
            for cargo in itens
        }
    else:
        dados["itens"] = []
    return pagina(request, "paginas/catalogo_lista.html", usuario=usuario, **dados)


@rotas.get("/catalogos/{nome}")
def ver(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("processo.ver")
    return _tela(request, s, usuario, nome, mensagem=mensagem, erro=erro)


def _recusa_no_cadastro(
    request: Request, s, usuario, nome: str, mensagem: str, digitado: dict
):
    """A gravação foi recusada: a tela volta com o popup aberto e preenchido.

    Nunca redirecionamento. `_erro` manda o recado pela URL e é o certo para a
    edição em linha, mas o cadastro perde tudo por esse caminho — quem digitou
    os quatro campos de uma unidade e errou o código UORG redigitava os quatro.
    """
    return _tela(request, s, usuario, nome, erro=mensagem, digitado=digitado)


@rotas.post("/catalogos/portarias")
def criar_portaria(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    texto_original: str = Form(...),
    unidade_emissora_id: int = Form(...),
    data_publicacao: str = Form(""),
    numero: str = Form(""),
):
    """RN-10: o numero e normalizado sem zeros a esquerda; o literal fica preservado."""
    usuario.exigir("catalogo.gerenciar")
    # Tudo o que foi digitado, guardado antes da primeira recusa.
    digitado = {
        "texto_original": texto_original,
        "unidade_emissora_id": unidade_emissora_id,
        "data_publicacao": data_publicacao,
        "numero": numero,
    }
    analise = analisar_portaria(texto_original)
    quando = (
        date.fromisoformat(data_publicacao)
        if data_publicacao
        else (analise.data if analise else None)
    )
    numero_norm = (numero or (analise.numero if analise else "")).lstrip("0") or "0"
    if quando is None:
        return _recusa_no_cadastro(
            request,
            s,
            usuario,
            "portarias",
            "Informe a data de publicação: ela não saiu do texto original.",
            digitado,
        )
    existente = s.execute(
        select(PortariaLocalizacao).where(
            PortariaLocalizacao.unidade_emissora_id == unidade_emissora_id,
            PortariaLocalizacao.numero == numero_norm,
            PortariaLocalizacao.ano == quando.year,
        )
    ).scalar_one_or_none()
    if existente is None:
        portaria = PortariaLocalizacao(
            unidade_emissora_id=unidade_emissora_id,
            numero=numero_norm,
            ano=quando.year,
            data_publicacao=quando,
            texto_original=texto_original.strip(),
        )
        s.add(portaria)
        s.flush()
        auditoria.registrar(
            s,
            entidade="portaria_localizacao",
            entidade_id=portaria.id,
            tipo_evento="PORTARIA_CRIADA",
            descricao=texto_original.strip(),
            usuario=usuario,
        )
        s.commit()
        return RedirectResponse("/catalogos/portarias?mensagem=Portaria cadastrada.", status_code=303)
    return _recusa_no_cadastro(
        request,
        s,
        usuario,
        "portarias",
        "Portaria já cadastrada (001, 01 e 1 são a mesma).",
        digitado,
    )


@rotas.post("/catalogos/textos-padrao")
def nova_versao_texto(
    s: SessaoDep,
    usuario: UsuarioDep,
    categoria: str = Form(...),
    codigo: str = Form(...),
    template: str = Form(...),
):
    """Catalogo versionado: nunca sobrescreve; cria a versao seguinte."""
    usuario.exigir("catalogo.gerenciar")
    atuais = list(
        s.execute(
            select(TextoPadrao).where(
                TextoPadrao.categoria == categoria, TextoPadrao.codigo == codigo
            )
        ).scalars()
    )
    proxima = max((t.versao for t in atuais), default=0) + 1
    for antigo in atuais:
        antigo.vigente = False
    novo = TextoPadrao(
        categoria=categoria,
        codigo=codigo,
        versao=proxima,
        template=textos.aspas_curvas(template),
        vigente=True,
        dispositivo_conferido_em=date.today(),
    )
    s.add(novo)
    s.flush()
    auditoria.registrar(
        s,
        entidade="texto_padrao",
        entidade_id=novo.id,
        tipo_evento="TEXTO_VERSIONADO",
        descricao=f"{categoria}/{codigo} v{proxima}",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        f"/catalogos/textos-padrao?mensagem=Nova versão v{proxima} criada.", status_code=303
    )


@rotas.post("/catalogos/campi")
def criar_campus(
    s: SessaoDep,
    usuario: UsuarioDep,
    sigla: str = Form(...),
    nome: str = Form(...),
    cidade: str = Form(...),
    uf: str = Form("MG"),
    avancado: str = Form(""),
):
    usuario.exigir("catalogo.gerenciar")
    sigla = sigla.strip().upper()
    existente = s.execute(select(Campus).where(Campus.sigla == sigla)).scalar_one_or_none()
    if existente is not None:
        existente.nome = nome.strip()
        existente.cidade = cidade.strip()
        existente.uf = uf.strip().upper()[:2]
        existente.avancado = avancado == "1"
        mensagem = f"Campus {sigla} atualizado."
    else:
        campus = Campus(
            sigla=sigla,
            nome=nome.strip(),
            cidade=cidade.strip(),
            uf=uf.strip().upper()[:2] or "MG",
            avancado=avancado == "1",
        )
        s.add(campus)
        s.flush()
        auditoria.registrar(
            s,
            entidade="campus",
            entidade_id=campus.id,
            tipo_evento="CAMPUS_CRIADO",
            descricao=f"{sigla} · {campus.nome} · {campus.cidade}",
            usuario=usuario,
        )
        mensagem = f"Campus {sigla} cadastrado."
    s.commit()
    return _volta("/catalogos/campi", mensagem)


@rotas.post("/catalogos/unidades-uorg")
def criar_unidade(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome_oficial: str = Form(...),
    nome_extenso: str = Form(...),
    tipo: str = Form(...),
    campus_id: int = Form(...),
    codigo_uorg: str = Form(""),
    sigla: str = Form(""),
    unidade_pai_id: str = Form(""),
    emite_portaria: str = Form(""),
):
    """A caixa do nome oficial é preservada byte a byte: é ela que sai no UORG
    do parecer (`250 - FACULDADE DE MEDICINA DE DIAMANTINA`)."""
    usuario.exigir("catalogo.gerenciar")
    codigo = codigo_uorg.strip() or None
    if codigo:
        ja = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == codigo)
        ).scalar_one_or_none()
        if ja is not None:
            return _recusa_no_cadastro(
                request,
                s,
                usuario,
                "unidades-uorg",
                f"Já existe unidade com o código {codigo}.",
                {
                    "nome_oficial": nome_oficial,
                    "nome_extenso": nome_extenso,
                    "tipo": tipo,
                    "campus_id": campus_id,
                    "codigo_uorg": codigo_uorg,
                    "sigla": sigla,
                    "unidade_pai_id": unidade_pai_id,
                    "emite_portaria": emite_portaria,
                },
            )
    unidade = UnidadeUorg(
        codigo_uorg=codigo,
        sigla=sigla.strip() or None,
        nome_oficial=nome_oficial.strip(),
        nome_extenso=nome_extenso.strip(),
        tipo=tipo,
        campus_id=campus_id,
        unidade_pai_id=int(unidade_pai_id) if unidade_pai_id else None,
        emite_portaria=emite_portaria == "1",
    )
    s.add(unidade)
    s.flush()
    auditoria.registrar(
        s,
        entidade="unidade_uorg",
        entidade_id=unidade.id,
        tipo_evento="UNIDADE_CRIADA",
        descricao=f"{unidade.uorg_bruto} ({unidade.tipo})",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        "/catalogos/unidades-uorg?mensagem=Unidade cadastrada.", status_code=303
    )


@rotas.post("/catalogos/postos-trabalho")
def criar_posto(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    unidade_uorg_id: int = Form(...),
    nome: str = Form(...),
    sigla: str = Form(""),
    descricao: str = Form(""),
):
    """O nome do posto sai no parecer exatamente como for digitado — inclusive
    a caixa (`Laboratório Escola de análises Clínicas (LEAC)`)."""
    usuario.exigir("catalogo.gerenciar")
    limpo = nome.strip()
    existente = s.execute(
        select(PostoTrabalho).where(
            PostoTrabalho.unidade_uorg_id == unidade_uorg_id, PostoTrabalho.nome == limpo
        )
    ).scalar_one_or_none()
    if existente is not None:
        return _recusa_no_cadastro(
            request,
            s,
            usuario,
            "postos-trabalho",
            "Esse posto já existe nesta unidade.",
            {
                "unidade_uorg_id": unidade_uorg_id,
                "nome": nome,
                "sigla": sigla,
                "descricao": descricao,
            },
        )
    posto = PostoTrabalho(
        unidade_uorg_id=unidade_uorg_id,
        nome=limpo,
        sigla=sigla.strip() or None,
        descricao=descricao.strip() or None,
    )
    s.add(posto)
    s.flush()
    auditoria.registrar(
        s,
        entidade="posto_trabalho",
        entidade_id=posto.id,
        tipo_evento="POSTO_CRIADO",
        descricao=f"{posto.nome} — {posto.unidade.nome_extenso if posto.unidade else ''}",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(
        "/catalogos/postos-trabalho?mensagem=Posto cadastrado.", status_code=303
    )


def _editar(
    s,
    usuario,
    modelo,
    registro_id: int,
    campos: dict,
    rotulo: str,
    volta: str,
):
    """Edição de catálogo, sempre com diff campo a campo na auditoria.

    Editar é seguro para o que já saiu: o parecer emitido guarda o conteúdo
    congelado (RN-15) e reimprime a partir dele, não do catálogo de hoje.
    """
    return salvar_com_diff(
        s,
        usuario,
        modelo,
        registro_id,
        campos,
        permissao="catalogo.gerenciar",
        rotulo=rotulo,
        volta=volta,
    )


def _texto(valor: str | None) -> str | None:
    return (valor or "").strip() or None


@rotas.post("/catalogos/campi/{campus_id}")
def editar_campus(
    s: SessaoDep,
    usuario: UsuarioDep,
    campus_id: int,
    nome: str = Form(...),
    cidade: str = Form(...),
    uf: str = Form("MG"),
    avancado: str = Form(""),
):
    return _editar(
        s, usuario, Campus, campus_id,
        {
            "nome": nome.strip(),
            "cidade": cidade.strip(),
            "uf": uf.strip().upper()[:2] or "MG",
            "avancado": avancado == "1",
        },
        "Campus", "/catalogos/campi",
    )


@rotas.post("/catalogos/unidades-uorg/{unidade_id}")
def editar_unidade(
    s: SessaoDep,
    usuario: UsuarioDep,
    unidade_id: int,
    nome_oficial: str = Form(...),
    nome_extenso: str = Form(...),
    tipo: str = Form(...),
    campus_id: int = Form(...),
    codigo_uorg: str = Form(""),
    sigla: str = Form(""),
    emite_portaria: str = Form(""),
    ativo: str = Form(""),
):
    codigo = _texto(codigo_uorg)
    if codigo:
        ja = s.execute(
            select(UnidadeUorg).where(
                UnidadeUorg.codigo_uorg == codigo, UnidadeUorg.id != unidade_id
            )
        ).scalar_one_or_none()
        if ja is not None:
            return _erro(
                "/catalogos/unidades-uorg",
                f"O código {codigo} já é de outra unidade.",
            )
    return _editar(
        s, usuario, UnidadeUorg, unidade_id,
        {
            "codigo_uorg": codigo,
            "sigla": _texto(sigla),
            "nome_oficial": nome_oficial.strip(),
            "nome_extenso": nome_extenso.strip(),
            "tipo": tipo,
            "campus_id": campus_id,
            "emite_portaria": emite_portaria == "1",
            "ativo": ativo == "1",
        },
        "Unidade", "/catalogos/unidades-uorg",
    )


@rotas.post("/catalogos/postos-trabalho/{posto_id}")
def editar_posto(
    s: SessaoDep,
    usuario: UsuarioDep,
    posto_id: int,
    nome: str = Form(...),
    unidade_uorg_id: int = Form(...),
    sigla: str = Form(""),
    descricao: str = Form(""),
    ativo: str = Form(""),
):
    limpo = nome.strip()
    ja = s.execute(
        select(PostoTrabalho).where(
            PostoTrabalho.unidade_uorg_id == unidade_uorg_id,
            PostoTrabalho.nome == limpo,
            PostoTrabalho.id != posto_id,
        )
    ).scalar_one_or_none()
    if ja is not None:
        return _erro(
            "/catalogos/postos-trabalho", "Já existe esse posto nesta unidade."
        )
    return _editar(
        s, usuario, PostoTrabalho, posto_id,
        {
            "nome": limpo,
            "unidade_uorg_id": unidade_uorg_id,
            "sigla": _texto(sigla),
            "descricao": _texto(descricao),
            "ativo": ativo == "1",
        },
        "Posto", "/catalogos/postos-trabalho",
    )


@rotas.post("/catalogos/tipos-risco/{tipo_id}")
def editar_tipo_risco(
    s: SessaoDep, usuario: UsuarioDep, tipo_id: int, nome: str = Form(...)
):
    return _editar(
        s, usuario, TipoRisco, tipo_id, {"nome": nome.strip()},
        "Tipo de risco", "/catalogos/tipos-risco",
    )


@rotas.post("/catalogos/fundamentacoes-legais/{fundamentacao_id}")
def editar_fundamentacao(
    s: SessaoDep,
    usuario: UsuarioDep,
    fundamentacao_id: int,
    norma: str = Form(...),
    anexo: str = Form(""),
    texto: str = Form(...),
    vigente: str = Form(""),
):
    from datetime import date as _date

    return _editar(
        s, usuario, FundamentacaoLegal, fundamentacao_id,
        {
            "norma": norma.strip(),
            "anexo": _texto(anexo),
            # aspas retas viram curvas uma vez, aqui — nunca a cada render
            "texto": textos.aspas_curvas(texto),
            "vigente": vigente == "1",
            "dispositivo_conferido_em": _date.today(),
        },
        "Fundamentação", "/catalogos/fundamentacoes-legais",
    )


@rotas.post("/catalogos/percentuais/{percentual_id}")
def editar_percentual(
    s: SessaoDep, usuario: UsuarioDep, percentual_id: int, rotulo: str = Form(...)
):
    """Só o rótulo. O VALOR é a lei (Lei 8.270/91, art. 12) — 5/10/20% para
    insalubridade e irradiação ionizante, 10% para periculosidade e raios X —
    e a base é sempre o vencimento do cargo efetivo (§3º)."""
    return _editar(
        s, usuario, PercentualAplicavel, percentual_id, {"rotulo": rotulo.strip()},
        "Rótulo do percentual", "/catalogos/percentuais",
    )


@rotas.post("/catalogos/agentes-nocivos/{agente_id}")
def editar_agente(
    s: SessaoDep,
    usuario: UsuarioDep,
    agente_id: int,
    descricao: str = Form(...),
    tipo_risco_id: int = Form(...),
    fundamentacao_id: str = Form(""),
    exige_quantitativa: str = Form(""),
    ativo: str = Form(""),
):
    return _editar(
        s, usuario, AgenteNocivo, agente_id,
        {
            "descricao": descricao.strip(),
            "tipo_risco_id": tipo_risco_id,
            "fundamentacao_id": int(fundamentacao_id) if fundamentacao_id else None,
            "exige_reavaliacao_quantitativa": exige_quantitativa == "1",
            "ativo": ativo == "1",
        },
        "Agente nocivo", "/catalogos/agentes-nocivos",
    )


@rotas.post("/catalogos/portarias/{portaria_id}")
def editar_portaria(
    s: SessaoDep,
    usuario: UsuarioDep,
    portaria_id: int,
    texto_original: str = Form(...),
    data_publicacao: str = Form(...),
    numero: str = Form(...),
):
    from datetime import date as _date

    quando = _date.fromisoformat(data_publicacao)
    return _editar(
        s, usuario, PortariaLocalizacao, portaria_id,
        {
            "texto_original": texto_original.strip(),
            "data_publicacao": quando,
            "ano": quando.year,
            "numero": numero.strip().lstrip("0") or "0",
        },
        "Portaria", "/catalogos/portarias",
    )


@rotas.post("/catalogos/checklists-modelo/{modelo_id}")
def editar_checklist_modelo(
    s: SessaoDep,
    usuario: UsuarioDep,
    modelo_id: int,
    nome: str = Form(...),
    itens: str = Form(...),
    ativo: str = Form(""),
):
    return _editar(
        s, usuario, ChecklistModelo, modelo_id,
        {"nome": nome.strip(), "itens": itens, "ativo": ativo == "1"},
        "Modelo", "/catalogos/checklists-modelo",
    )


@rotas.post("/catalogos/cargos")
def salvar_cargo(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(...),
    codigo_siape: str = Form(""),
    cargo_id: str = Form(""),
):
    """Cadastra ou renomeia um cargo.

    Renomear é seguro para o que já saiu: o parecer congela o nome do cargo em
    `cargo_snapshot` na emissão (RN-15), então reimprimir um parecer antigo
    continua trazendo o cargo que valia naquele dia.

    Uma rota, dois formulários: a linha da tabela manda `cargo_id` e o popup de
    cadastro não. É `cargo_id` que decide para onde a recusa volta — reabrir o
    popup depois de uma edição em linha recusada mostraria um cadastro em branco
    no lugar da linha que a pessoa estava corrigindo.
    """
    usuario.exigir("catalogo.gerenciar")
    limpo = nome.strip()
    editando = cargo_id.isdigit()

    def recusar(mensagem: str):
        if editando:
            return _erro("/catalogos/cargos", mensagem)
        return _recusa_no_cadastro(
            request,
            s,
            usuario,
            "cargos",
            mensagem,
            {"nome": nome, "codigo_siape": codigo_siape},
        )

    if not limpo:
        return recusar("O nome do cargo não pode ficar em branco.")
    codigo = codigo_siape.strip() or None

    homonimo = s.execute(select(Cargo).where(Cargo.nome == limpo)).scalar_one_or_none()

    if editando:
        cargo = s.get(Cargo, int(cargo_id))
        if cargo is None:
            return RedirectResponse("/catalogos/cargos", status_code=303)
        if homonimo is not None and homonimo.id != cargo.id:
            return recusar(f"Já existe outro cargo chamado '{limpo}'.")
        antes = {"nome": cargo.nome, "codigo_siape": cargo.codigo_siape}
        cargo.nome = limpo
        cargo.codigo_siape = codigo
        auditoria.registrar_diferencas(
            s,
            entidade="cargo",
            entidade_id=cargo.id,
            antes=antes,
            depois={"nome": cargo.nome, "codigo_siape": cargo.codigo_siape},
            usuario=usuario,
        )
        mensagem = f"Cargo '{limpo}' atualizado."
    else:
        if homonimo is not None:
            return recusar(f"O cargo '{limpo}' já está cadastrado.")
        cargo = Cargo(nome=limpo, codigo_siape=codigo)
        s.add(cargo)
        s.flush()
        auditoria.registrar(
            s,
            entidade="cargo",
            entidade_id=cargo.id,
            tipo_evento="CARGO_CRIADO",
            descricao=limpo + (f" (código SIAPE {codigo})" if codigo else ""),
            usuario=usuario,
        )
        mensagem = f"Cargo '{limpo}' cadastrado."
    s.commit()
    return _volta("/catalogos/cargos", mensagem)


@rotas.post("/catalogos/checklists-modelo")
def criar_checklist_modelo(
    s: SessaoDep,
    usuario: UsuarioDep,
    nome: str = Form(...),
    itens: str = Form(...),
    tipo_processo_id: str = Form(""),
    estado_alvo: str = Form(""),
):
    usuario.exigir("catalogo.gerenciar")
    existente = s.execute(
        select(ChecklistModelo).where(ChecklistModelo.nome == nome.strip())
    ).scalar_one_or_none()
    if existente is not None:
        existente.itens = itens
        existente.tipo_processo_id = int(tipo_processo_id) if tipo_processo_id else None
        existente.estado_alvo = estado_alvo or None
        mensagem = "Modelo atualizado."
    else:
        modelo = ChecklistModelo(
            nome=nome.strip(),
            itens=itens,
            tipo_processo_id=int(tipo_processo_id) if tipo_processo_id else None,
            estado_alvo=estado_alvo or None,
        )
        s.add(modelo)
        s.flush()
        auditoria.registrar(
            s,
            entidade="checklist_modelo",
            entidade_id=modelo.id,
            tipo_evento="CHECKLIST_MODELO_CRIADO",
            descricao=f"{modelo.nome} ({len(modelo.lista_de_itens)} itens)",
            usuario=usuario,
        )
        mensagem = "Modelo cadastrado."
    s.commit()
    return RedirectResponse(
        "/catalogos/checklists-modelo?" + urlencode({"mensagem": mensagem}, quote_via=quote),
        status_code=303,
    )


@rotas.post("/catalogos/agentes-nocivos")
def criar_agente(
    s: SessaoDep,
    usuario: UsuarioDep,
    descricao: str = Form(...),
    tipo_risco_id: int = Form(...),
    fundamentacao_id: str = Form(""),
    exige_quantitativa: str = Form(""),
    agente_canonico_id: str = Form(""),
):
    usuario.exigir("catalogo.gerenciar")
    agente = AgenteNocivo(
        descricao=descricao.strip(),
        tipo_risco_id=tipo_risco_id,
        fundamentacao_id=int(fundamentacao_id) if fundamentacao_id else None,
        exige_reavaliacao_quantitativa=exige_quantitativa == "1",
        agente_canonico_id=int(agente_canonico_id) if agente_canonico_id else None,
    )
    s.add(agente)
    s.flush()
    auditoria.registrar(
        s,
        entidade="agente_nocivo",
        entidade_id=agente.id,
        tipo_evento="AGENTE_CRIADO",
        descricao=descricao.strip(),
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse("/catalogos/agentes-nocivos?mensagem=Agente cadastrado.", status_code=303)


_ = datas_br
