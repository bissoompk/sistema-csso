"""Editor do parecer tecnico: formulario + pre-visualizacao + emissao."""

from __future__ import annotations

from datetime import date

from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    AgenteNocivo,
    AutoridadeDestinataria,
    Exposicao,
    LaudoTecnico,
    ParecerPosto,
    ParecerTecnico,
    PercentualAplicavel,
    PortariaLocalizacao,
    PostoTrabalho,
    ProfissionalHabilitado,
    SetorEmissor,
    TextoPadrao,
    TipoAdicional,
    TipoMarcoInicial,
    TipoMovimento,
    UnidadeUorg,
)
from app.repositorios import processos as repo
from app.servicos.importacao_planilha import analisar_portaria
from app.servicos import auditoria, datas_br, documento, numeracao, parecer as servico
from app.servicos import servidores as servico_servidores
from app.servicos import pdf as servico_pdf
from app.servicos.pdf import AVISO_SEM_PDF
from app.servicos.rbac import PermissaoNegada, pode_subscrever
from app.web import marcar_download, pagina

rotas = APIRouter(tags=["pareceres"])


def _catalogos(s: SessaoDep) -> dict:
    return {
        "tipos_adicional": list(
            s.execute(select(TipoAdicional).where(TipoAdicional.ativo)).scalars()
        ),
        "movimentos": list(
            s.execute(select(TipoMovimento).where(TipoMovimento.ativo)).scalars()
        ),
        "marcos": list(s.execute(select(TipoMarcoInicial)).scalars()),
        "destinatarios": list(s.execute(select(AutoridadeDestinataria)).scalars()),
        "signatarios": list(s.execute(select(ProfissionalHabilitado)).scalars()),
        "setores": list(s.execute(select(SetorEmissor)).scalars()),
        "laudos": list(
            s.execute(select(LaudoTecnico).order_by(LaudoTecnico.numero_siape)).scalars()
        ),
        "portarias": list(
            s.execute(
                select(PortariaLocalizacao).order_by(PortariaLocalizacao.data_publicacao.desc())
            ).scalars()
        ),
        "unidades_emissoras": list(
            s.execute(
                select(UnidadeUorg)
                .where(UnidadeUorg.emite_portaria)
                .order_by(UnidadeUorg.nome_extenso)
            ).scalars()
        ),
        "unidades": list(
            s.execute(select(UnidadeUorg).order_by(UnidadeUorg.nome_extenso)).scalars()
        ),
        "postos": list(s.execute(select(PostoTrabalho).order_by(PostoTrabalho.nome)).scalars()),
        "agentes": list(
            s.execute(select(AgenteNocivo).where(AgenteNocivo.ativo)).scalars()
        ),
        "percentuais": list(s.execute(select(PercentualAplicavel)).scalars()),
        "recomendacoes": list(
            s.execute(
                select(TextoPadrao).where(
                    TextoPadrao.categoria == "RECOMENDACAO", TextoPadrao.vigente
                )
            ).scalars()
        ),
        "alteracoes": list(
            s.execute(
                select(TextoPadrao).where(
                    TextoPadrao.categoria == "ALTERACAO", TextoPadrao.vigente
                )
            ).scalars()
        ),
        "reavaliacoes": list(
            s.execute(
                select(TextoPadrao).where(
                    TextoPadrao.categoria == "REAVALIACAO", TextoPadrao.vigente
                )
            ).scalars()
        ),
    }


def _painel_de_epi(s: SessaoDep, parecer: ParecerTecnico) -> dict:
    """O que a tela mostra ao lado de cada exposição — e o que ela **diz**.

    O painel existe para uma coisa: não deixar o engenheiro concluir que o EPI
    neutraliza o agente a partir de uma data que ele teria de conferir sozinho.
    A ficha traz a validade do CA e a troca prevista; comparar as duas com a
    data da avaliação é conta de cabeça, e conta de cabeça em cima de dado de
    outra tela é exatamente onde a alegação errada entra num parecer.

    A data de referência é a **da avaliação**, e nesta ordem: `epi_avaliado_em`
    (quando já houve avaliação), `data_avaliacao` da exposição (a visita ao
    posto), a emissão, e só então hoje. Ler contra `date.today()` faria o painel
    de um parecer de 2024 mostrar vencimentos de 2026 e desmentir um documento
    que estava certo quando foi escrito.

    É leitura pura: `entregas_ate` não decide nada, e esta função também não.
    """
    from app.servicos import epi_ficha

    hoje = date.today()
    painel: dict[int, dict] = {}
    for exposicao in parecer.exposicoes:
        referencia = (
            exposicao.epi_avaliado_em
            or exposicao.data_avaliacao
            or parecer.data_emissao
            or hoje
        )
        painel[exposicao.id] = {
            "referencia": referencia,
            "entregas": (
                epi_ficha.entregas_ate(s, parecer.servidor_id, referencia)
                if parecer.servidor_id
                else []
            ),
            "pode_neutralizar": servico.epi_pode_neutralizar(parecer, exposicao),
        }
    return painel


@rotas.get("/processos/{processo_id}/parecer")
def novo(request: Request, s: SessaoDep, usuario: UsuarioDep, processo_id: int):
    usuario.exigir("parecer.criar")
    processo = repo.por_id(s, usuario, processo_id)
    if processo is None:
        return RedirectResponse("/processos", status_code=303)

    ano = date.today().year
    rascunho = ParecerTecnico(
        numero=0,
        ano=ano,
        situacao="RASCUNHO",
        processo_id=processo.id,
        servidor_id=processo.servidor_id,
        unidade_uorg_id=processo.unidade_uorg_id,
        criado_por=usuario.id,
        modelo_arquivo=documento.MODELO_V1,
    )
    # a lotacao vigente ja diz unidade, UORG e postos: o rascunho nasce preenchido
    lotacao = (
        servico_servidores.lotacao_vigente(s, processo.servidor_id)
        if processo.servidor_id
        else None
    )
    if lotacao is not None:
        rascunho.unidade_uorg_id = lotacao.unidade_uorg_id or rascunho.unidade_uorg_id
        rascunho.uorg_id = lotacao.uorg_id
    destinatario = s.execute(select(AutoridadeDestinataria)).scalars().first()
    if destinatario:
        rascunho.destinatario_id = destinatario.id
    setor = servico.setor_emissor_vigente(s, date.today())
    if setor:
        rascunho.setor_emissor_id = setor.id
    s.add(rascunho)
    s.flush()
    if lotacao is not None:
        for ordem, posto in enumerate(lotacao.postos, start=1):
            s.add(
                ParecerPosto(
                    parecer_id=rascunho.id, posto_trabalho_id=posto.id, ordem=ordem
                )
            )
    auditoria.registrar(
        s,
        entidade="parecer_tecnico",
        entidade_id=rascunho.id,
        processo_id=processo.id,
        tipo_evento="PARECER_RASCUNHO_CRIADO",
        descricao=f"Rascunho de parecer criado para o processo {processo.nup}.",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(f"/pareceres/{rascunho.id}", status_code=303)


@rotas.get("/pareceres/{parecer_id}")
def editor(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("parecer.ver")
    # A MESMA resposta para "não existe" e "fora do seu escopo", pela disciplina
    # que `/anexos/{id}` fixou na 1.31.0 e `/processos/{id}` repete: distinguir
    # os dois casos não entrega o parecer, mas responde "este id existe" — o
    # mesmo oráculo com um passo a mais. Quem tem direito ao parecer chega nele
    # pela ficha do processo, e lá a mensagem é específica.
    parecer = servico.no_escopo(s, usuario, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)

    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="parecer_tecnico.nominal",
        servidor_id=parecer.servidor_id,
        processo_id=parecer.processo_id,
    ):
        s.commit()

    validacao = servico.validar(s, parecer)
    contexto = servico.montar_contexto(s, parecer)
    numeros_usados = {
        n
        for (n,) in s.execute(
            select(ParecerTecnico.numero).where(
                ParecerTecnico.ano == parecer.ano, ParecerTecnico.id != parecer.id
            )
        ).all()
    }

    return pagina(
        request,
        "paginas/parecer_editor.html",
        usuario=usuario,
        parecer=parecer,
        contexto=contexto,
        c=contexto,
        data_extenso=datas_br.por_extenso(contexto.data_emissao),
        validacao=validacao,
        numeros_usados=sorted(numeros_usados),
        pode_assinar=pode_subscrever(s, usuario),
        epi=_painel_de_epi(s, parecer),
        epi_valores=servico.EPI_NEUTRALIZA_VALORES,
        epi_alega=servico.EPI_ALEGA_NEUTRALIZACAO,
        mensagem=mensagem,
        erro=erro,
        # o botão "Gerar PDF" diz antes do clique se o PDF sai nesta máquina
        pdf_disponivel=servico_pdf.disponivel(),
        AVISO_SEM_PDF=AVISO_SEM_PDF,
        **_catalogos(s),
    )


def _int_ou_none(valor: str | None) -> int | None:
    return int(valor) if valor and valor.strip().isdigit() else None


def _data_ou_none(valor: str | None) -> date | None:
    return date.fromisoformat(valor) if valor else None


@rotas.post("/pareceres/{parecer_id}")
async def salvar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
):
    usuario.exigir("parecer.editar")
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)
    if parecer.situacao in ("EMITIDO", "ASSINADO"):
        return editor(
            request,
            s,
            usuario,
            parecer_id,
            erro="Parecer emitido é imutável (RN-14). Crie uma nova versão.",
        )

    dados = await request.form()
    antes = {
        campo: getattr(parecer, campo)
        for campo in (
            "ano",
            "data_emissao",
            "laudo_id",
            "tipo_adicional_id",
            "tipo_movimento_id",
            "portaria_id",
            "tipo_marco_id",
            "data_marco_inicial",
            "texto_recomendacao",
            "texto_alteracao",
            "texto_reavaliacao",
            "signatario_id",
            "destinatario_id",
            "setor_emissor_id",
            "unidade_uorg_id",
            "uorg_id",
        )
    }

    # Numero editavel enquanto rascunho: o setor ja emitiu pareceres fora do
    # sistema e precisa continuar a numeracao de onde parou. A sequencia so e
    # consumida na emissao quando o numero ficou em branco (RN-03).
    #
    # O ano é conferido contra o número ANTES de ser gravado. Atribuí-lo antes
    # deixava o parecer com ano novo e número velho quando a checagem recusava —
    # exatamente o par que ela existe para impedir —, porque devolver o editor
    # com o aviso é retorno normal e a sessão da requisição commita o que já
    # estiver escrito. O formulário salva inteiro ou não salva.
    ano_pedido = int(dados.get("ano") or parecer.ano)
    numero_pedido = str(dados.get("numero") or "").strip()
    pretendido: int | None = None
    if numero_pedido.isdigit() and int(numero_pedido) != parecer.numero:
        pretendido = int(numero_pedido)
        ocupado = s.execute(
            select(ParecerTecnico).where(
                ParecerTecnico.numero == pretendido,
                ParecerTecnico.ano == ano_pedido,
                ParecerTecnico.id != parecer.id,
            )
        ).scalar_one_or_none()
        if ocupado is not None:
            return editor(
                request,
                s,
                usuario,
                parecer_id,
                erro=(
                    f"o número {pretendido}/{ano_pedido} já pertence a outro parecer "
                    f"({ocupado.situacao.lower()}) — escolha outro"
                ),
            )

    parecer.ano = ano_pedido
    if pretendido is not None:
        anterior = parecer.numero
        parecer.numero = pretendido
        auditoria.registrar(
            s,
            entidade="parecer_tecnico",
            entidade_id=parecer.id,
            processo_id=parecer.processo_id,
            tipo_evento="NUMERO_DEFINIDO_MANUALMENTE",
            descricao=f"Número definido à mão: {anterior or '(vazio)'} → {pretendido}",
            campo="numero",
            valor_anterior=anterior,
            valor_novo=pretendido,
            usuario=usuario,
        )
        # mantem a sequencia a frente do maior numero ja usado
        numeracao.recontar_sequencia(s)
    parecer.data_emissao = _data_ou_none(dados.get("data_emissao"))
    parecer.laudo_id = _int_ou_none(dados.get("laudo_id"))
    parecer.tipo_adicional_id = _int_ou_none(dados.get("tipo_adicional_id"))
    parecer.tipo_movimento_id = _int_ou_none(dados.get("tipo_movimento_id"))
    parecer.portaria_id = _int_ou_none(dados.get("portaria_id"))
    parecer.tipo_marco_id = _int_ou_none(dados.get("tipo_marco_id"))
    parecer.data_marco_inicial = _data_ou_none(dados.get("data_marco_inicial"))
    parecer.justificativa_marco = dados.get("justificativa_marco") or None
    parecer.texto_alteracao = dados.get("texto_alteracao") or None
    parecer.texto_reavaliacao = dados.get("texto_reavaliacao") or None
    parecer.signatario_id = _int_ou_none(dados.get("signatario_id"))
    parecer.destinatario_id = _int_ou_none(dados.get("destinatario_id"))
    parecer.setor_emissor_id = _int_ou_none(dados.get("setor_emissor_id"))
    parecer.parecer_anterior_id = _int_ou_none(dados.get("parecer_anterior_id"))
    # Unidade e UORG sao campos distintos no documento; UORG em branco = usar a Unidade
    parecer.unidade_uorg_id = _int_ou_none(dados.get("unidade_uorg_id"))
    parecer.uorg_id = _int_ou_none(dados.get("uorg_id"))
    parecer.modelo_arquivo = dados.get("modelo_arquivo") or documento.MODELO_V1
    parecer.horas_semanais_fonte = (
        float(dados["horas_semanais_fonte"]) if dados.get("horas_semanais_fonte") else None
    )
    parecer.area_radiologica = dados.get("area_radiologica") or None

    # RN-05: o marco derivado da portaria e preenchido automaticamente
    if parecer.tipo_marco is not None and parecer.tipo_marco.codigo == "PORTARIA_LOCALIZACAO":
        if parecer.portaria is not None:
            parecer.data_marco_inicial = parecer.portaria.data_publicacao

    # recomendacao: literal (migrada) ou montada do catalogo
    texto_livre = dados.get("texto_recomendacao")
    codigo_modelo = dados.get("recomendacao_modelo")
    if codigo_modelo and parecer.data_marco_inicial and not parecer.texto_recomendacao_literal:
        modelo = s.execute(
            select(TextoPadrao).where(
                TextoPadrao.categoria == "RECOMENDACAO", TextoPadrao.codigo == codigo_modelo
            )
        ).scalar_one_or_none()
        principal = servico.exposicao_principal(parecer)
        if modelo is not None and parecer.tipo_adicional is not None and principal is not None:
            parecer.texto_recomendacao = servico.montar_recomendacao(
                codigo_modelo,
                parecer.tipo_adicional.nome_recomendacao,
                principal.agente_nocivo.tipo_risco.nome,
                parecer.data_marco_inicial,
                modelo.template,
            )
        elif texto_livre:
            parecer.texto_recomendacao = texto_livre
    elif texto_livre is not None:
        parecer.texto_recomendacao = texto_livre or None

    # postos do parecer
    escolhidos = [int(v) for v in dados.getlist("posto_id") if str(v).isdigit()]
    if escolhidos:
        parecer.postos.clear()
        s.flush()
        for ordem, posto_id in enumerate(escolhidos, start=1):
            s.add(
                ParecerPosto(
                    parecer_id=parecer.id, posto_trabalho_id=posto_id, ordem=ordem
                )
            )

    parecer.versao += 1
    s.flush()
    depois = {campo: getattr(parecer, campo) for campo in antes}
    auditoria.registrar_diferencas(
        s,
        entidade="parecer_tecnico",
        entidade_id=parecer.id,
        antes=antes,
        depois=depois,
        usuario=usuario,
        processo_id=parecer.processo_id,
    )
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer.id}", status_code=303)


@rotas.post("/pareceres/{parecer_id}/portaria")
def cadastrar_portaria_no_editor(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
    texto_original: str = Form(...),
    unidade_emissora_id: int = Form(...),
    data_publicacao: str = Form(""),
    numero: str = Form(""),
):
    """Cadastra a portaria sem sair do editor — e já vincula ao parecer.

    Antes era preciso ir ao catálogo, cadastrar e voltar; se o catálogo estivesse
    vazio, a lista do editor aparecia vazia sem dizer o que fazer.
    """
    usuario.exigir("parecer.editar")
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)

    analise = analisar_portaria(texto_original)
    quando = (
        date.fromisoformat(data_publicacao)
        if data_publicacao
        else (analise.data if analise else None)
    )
    if quando is None:
        return editor(
            request,
            s,
            usuario,
            parecer_id,
            erro=(
                "não consegui ler a data no texto da portaria — informe a data de "
                "publicação no campo ao lado"
            ),
        )
    numero_norm = (numero or (analise.numero if analise else "")).strip().lstrip("0") or "0"

    portaria = s.execute(
        select(PortariaLocalizacao).where(
            PortariaLocalizacao.unidade_emissora_id == unidade_emissora_id,
            PortariaLocalizacao.numero == numero_norm,
            PortariaLocalizacao.ano == quando.year,
        )
    ).scalar_one_or_none()
    if portaria is None:
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
            processo_id=parecer.processo_id,
            tipo_evento="PORTARIA_CRIADA",
            descricao=texto_original.strip(),
            usuario=usuario,
        )

    parecer.portaria_id = portaria.id
    # RN-05: com marco na portaria, a data do marco é a da publicação
    if parecer.tipo_marco is not None and parecer.tipo_marco.codigo == "PORTARIA_LOCALIZACAO":
        parecer.data_marco_inicial = portaria.data_publicacao
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)


@rotas.post("/pareceres/{parecer_id}/exposicoes")
def adicionar_exposicao(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
    agente_nocivo_id: int = Form(...),
    percentual_id: int = Form(...),
    principal: str = Form(""),
    horas_exposicao_mensais: str = Form(""),
    jornada_mensal_horas: str = Form(""),
    classificacao: str = Form(""),
    excecao_art9: str = Form(""),
    justificativa_art9: str = Form(""),
):
    usuario.exigir("parecer.editar")
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None or parecer.situacao in ("EMITIDO", "ASSINADO"):
        return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)

    agente = s.get(AgenteNocivo, agente_nocivo_id)
    if agente is None or agente.fundamentacao_id is None:
        return editor(
            request, s, usuario, parecer_id, erro="Agente sem fundamentação legal no catálogo."
        )

    ja_existe = any(e.agente_nocivo_id == agente_nocivo_id for e in parecer.exposicoes)
    if ja_existe:
        return editor(request, s, usuario, parecer_id, erro="Esse agente já está no parecer.")

    virar_principal = principal == "1" or not parecer.exposicoes
    if virar_principal:
        for existente in parecer.exposicoes:
            existente.principal = False
        s.flush()

    exposicao = Exposicao(
        parecer_id=parecer.id,
        agente_nocivo_id=agente_nocivo_id,
        percentual_id=percentual_id,
        fundamentacao_id=agente.fundamentacao_id,
        principal=virar_principal,
        horas_exposicao_mensais=float(horas_exposicao_mensais) if horas_exposicao_mensais else None,
        jornada_mensal_horas=float(jornada_mensal_horas) if jornada_mensal_horas else None,
        excecao_art9_par_unico=excecao_art9 == "1",
        justificativa_art9=justificativa_art9 or None,
    )
    servico.aplicar_classificacao(exposicao, informada=classificacao or None)
    aviso = servico.divergencia_de_classificacao(exposicao, classificacao or None)
    s.add(exposicao)
    s.flush()
    if aviso:
        auditoria.registrar(
            s,
            entidade="exposicao",
            entidade_id=exposicao.id,
            processo_id=parecer.processo_id,
            tipo_evento="CLASSIFICACAO_DIVERGENTE",
            descricao=aviso,
            usuario=usuario,
        )

    # RN-06 - agente que exige quantitativa puxa o texto de reavaliacao
    if agente.exige_reavaliacao_quantitativa and not parecer.texto_reavaliacao:
        modelo = s.execute(
            select(TextoPadrao).where(
                TextoPadrao.categoria == "REAVALIACAO",
                TextoPadrao.codigo == "QUIMICO_QUANTITATIVA",
            )
        ).scalar_one_or_none()
        if modelo:
            parecer.texto_reavaliacao = modelo.template

    auditoria.registrar(
        s,
        entidade="exposicao",
        entidade_id=exposicao.id,
        processo_id=parecer.processo_id,
        tipo_evento="EXPOSICAO_ADICIONADA",
        descricao=f"{agente.descricao} · {exposicao.percentual.rotulo}",
        usuario=usuario,
    )
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)


@rotas.post("/pareceres/{parecer_id}/exposicoes/{exposicao_id}/epi")
def avaliar_epi(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
    exposicao_id: int,
    epi_neutraliza: str = Form(...),
    justificativa_epi: str = Form(""),
):
    """A decisão do §7.1. A regra mora no serviço; aqui só se devolve a recusa.

    Não há segunda cópia da trava nesta rota de propósito: uma checagem de tela
    que dissesse "pode" e um serviço que dissesse "não" seria a forma mais
    barata de a regra parar de valer no dia em que alguém mexesse num lado só.
    """
    usuario.exigir("parecer.editar")
    parecer = s.get(ParecerTecnico, parecer_id)
    exposicao = s.get(Exposicao, exposicao_id)
    if parecer is None or exposicao is None or exposicao.parecer_id != parecer_id:
        return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)

    try:
        servico.registrar_avaliacao_de_epi(
            s,
            parecer,
            exposicao,
            usuario,
            valor=epi_neutraliza,
            justificativa=justificativa_epi,
        )
    except (servico.AvaliacaoDeEpiRecusada, ValueError) as erro:
        # Recusa é retorno normal e a sessão comitaria o que estivesse pendente.
        # Aqui não há nada legítimo a guardar — o serviço recusa antes de gravar
        # —, então o rollback é o que impede lixo de virar registro.
        s.rollback()
        motivos = getattr(erro, "motivos", None) or [str(erro)]
        return editor(request, s, usuario, parecer_id, erro=" · ".join(motivos))
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)


@rotas.post("/pareceres/{parecer_id}/exposicoes/{exposicao_id}/excluir")
def remover_exposicao(
    s: SessaoDep, usuario: UsuarioDep, parecer_id: int, exposicao_id: int
):
    usuario.exigir("parecer.editar")
    exposicao = s.get(Exposicao, exposicao_id)
    if exposicao is not None and exposicao.parecer_id == parecer_id:
        s.delete(exposicao)
        s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}", status_code=303)


@rotas.post("/pareceres/{parecer_id}/emitir")
def emitir(request: Request, s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)
    try:
        resultado = servico.emitir(s, parecer, usuario)
    except servico.EmissaoBloqueada as erro:
        s.commit()
        return editor(request, s, usuario, parecer_id, erro=" · ".join(erro.motivos))
    except PermissaoNegada as erro:
        s.commit()
        raise erro
    s.commit()
    mensagem = f"Parecer {parecer.rotulo} emitido."
    if resultado.aviso_pdf:
        mensagem += " " + AVISO_SEM_PDF
    return RedirectResponse(
        f"/pareceres/{parecer_id}?" + urlencode({"mensagem": mensagem}, quote_via=quote),
        status_code=303,
    )


@rotas.post("/pareceres/{parecer_id}/assinar")
def assinar(request: Request, s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)
    try:
        servico.assinar(s, parecer, usuario)
    except PermissaoNegada as erro:
        s.commit()
        raise erro
    except servico.EmissaoBloqueada as erro:
        s.commit()
        return editor(request, s, usuario, parecer_id, erro=" · ".join(erro.motivos))
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}?mensagem=Parecer assinado.", status_code=303)


@rotas.post("/pareceres/{parecer_id}/anular")
def anular(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    parecer_id: int,
    motivo: str = Form(...),
):
    parecer = s.get(ParecerTecnico, parecer_id)
    if parecer is None:
        return RedirectResponse("/processos", status_code=303)
    servico.anular(s, parecer, usuario, motivo)
    s.commit()
    return RedirectResponse(f"/pareceres/{parecer_id}?mensagem=Parecer anulado.", status_code=303)


def _exigir_parecer(s, usuario, parecer_id: int) -> ParecerTecnico:
    """Entrega do parecer (arquivo ou prévia) para id inexistente é 404, não 303.

    A ficha `/pareceres/{id}` volta para a lista porque quem errou o id está
    navegando e tem para onde voltar. Estas rotas não: devolver o HTML de
    `/processos` a quem pediu um `.docx` entrega a página no lugar do arquivo, e
    a prévia é buscada por HTMX, que não segue redirecionamento para trocar o
    fragmento. Sem esta conferência o `None` chegava em `montar_contexto` e a
    resposta era 500 — "o sistema quebrou" para quem só digitou um id que não
    existe. O tratador em `principal.py` desenha a tela com a casca para quem
    pede HTML e devolve o JSON de 404 para o resto.

    A frase é uma só para os dois casos — id que não existe e parecer fora do
    escopo —, e é a mesma de `/processos/{id}`. O `.docx` é o documento oficial e
    leva o nome do servidor no `filename`: distinguir aqui devolveria, a quem não
    alcança o parecer, a informação de que ele existe.
    """
    parecer = servico.no_escopo(s, usuario, parecer_id)
    if parecer is None:
        raise HTTPException(
            status_code=404,
            detail="O parecer não existe ou está fora do seu escopo.",
        )

    # O registro mora AQUI, e não em cada uma das três rotas, pelo motivo que
    # `anexo_acesso.liberar` já escreveu: separar "quem pode" de "ficou
    # registrado" devolve a quem escrever a quarta rota de saída a chance de
    # fazer a primeira e esquecer a segunda. E é a saída que mais precisa da
    # linha — o `.docx` é o documento oficial e leva o nome do servidor no
    # próprio `filename` (§G-1 do relatório), enquanto a tela que o gera já
    # registrava desde a 1.35.0. Grava e solta na mesma linha: `baixar_pdf`
    # entrega a transação ao LibreOffice logo adiante, e linha pendente aqui
    # seria o `BEGIN IMMEDIATE` segurado pelos segundos da conversão.
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="parecer_tecnico.documento",
        servidor_id=parecer.servidor_id,
        processo_id=parecer.processo_id,
        finalidade="emissão de via do parecer técnico nominal",
    ):
        s.commit()
    return parecer


def _arquivo(s, parecer: ParecerTecnico, extensao: str):
    contexto = servico.montar_contexto(s, parecer)
    return documento.caminho_saida(
        parecer.numero,
        parecer.ano,
        contexto.sigla_unidade_emissora or "CSSO",
        contexto.nome_servidor,
        extensao,
    )


@rotas.get("/pareceres/{parecer_id}/docx")
def baixar_docx(request: Request, s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    usuario.exigir("parecer.ver")
    parecer = _exigir_parecer(s, usuario, parecer_id)
    caminho = _arquivo(s, parecer, "docx")
    if not caminho.exists():
        # reimpressao fiel: usa o modelo congelado na emissao (RN-15)
        documento.renderizar(
            servico.montar_contexto(s, parecer), caminho, parecer.modelo_arquivo
        )
    return marcar_download(FileResponse(caminho, filename=caminho.name), request)


@rotas.get("/pareceres/{parecer_id}/pdf")
def baixar_pdf(request: Request, s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    """A reimpressao — e a segunda chance do PDF que a emissao nao conseguiu.

    Ela reconverte do `.docx` reproduzido a partir do congelado (RN-15), sem
    tocar em numero nenhum, e por isso pode ser repetida a vontade. E o que faz a
    falha de conversao depois do commit ser reversivel em vez de perda.
    """
    usuario.exigir("parecer.ver")
    parecer = _exigir_parecer(s, usuario, parecer_id)
    docx = _arquivo(s, parecer, "docx")
    if not docx.exists():
        documento.renderizar(
            servico.montar_contexto(s, parecer), docx, parecer.modelo_arquivo
        )
    # esta rota nao escreve nada, e mesmo assim segurava o lock de escrita
    # durante os segundos do LibreOffice: `BEGIN IMMEDIATE` o toma no SELECT do
    # cookie. Baixar um PDF travava o setor igual a emitir um parecer.
    resultado = servico_pdf.converter_fora_da_transacao(
        s, docx, docx.with_suffix(".pdf")
    )
    if not resultado.gerado:
        return marcar_download(FileResponse(docx, filename=docx.name), request)
    return marcar_download(
        FileResponse(resultado.caminho, filename=resultado.caminho.name), request
    )


@rotas.get("/pareceres/{parecer_id}/previa")
def previa(request: Request, s: SessaoDep, usuario: UsuarioDep, parecer_id: int):
    """Fragmento HTMX com a pre-visualizacao em papel timbrado."""
    usuario.exigir("parecer.ver")
    parecer = _exigir_parecer(s, usuario, parecer_id)
    contexto = servico.montar_contexto(s, parecer)
    return pagina(
        request,
        "partes/previa_parecer.html",
        usuario=usuario,
        parecer=parecer,
        c=contexto,
        data_extenso=datas_br.por_extenso(contexto.data_emissao),
    )
