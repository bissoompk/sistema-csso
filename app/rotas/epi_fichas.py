"""/epis/fichas e /epis/entregas — a ficha de EPI e o balcão que a alimenta.

Fatia 2 do desenho (`entrada/integrasst/desenho_epi.md`), e a peça central do
módulo: a ficha é a prova legal de que o equipamento foi entregue. Está separada
de `epis.py` pela mesma razão que `certificados.py` está separada de
`treinamentos.py` — um arquivo é o catálogo, o outro é o documento que sai dele.

Três coisas que estas telas existem para tornar visíveis:

1. **O CA que vale é o do lote.** A tela lista os lotes com etiqueta e, quando o
   CA venceu, o botão fica desabilitado **com o motivo escrito ao lado**. Botão
   que some sem explicação faz quem opera procurar defeito no sistema.
2. **Ficha sem comprovante é pendência, não entrega completa.** A janela entre a
   entrega e o anexo assinado (decisão 8) aparece contada no topo da ficha e
   etiquetada em cada linha. Lacuna silenciosa só aparece na fiscalização.
3. **Estorno não apaga.** A linha errada continua na ficha, marcada, com o
   estorno ao lado. É assim que documento de valor probatório se corrige.
4. **Devolução não é estorno**, e as duas ficam lado a lado na mesma linha, cada
   uma dizendo o que faz. Devolução repõe saldo no lote porque o equipamento
   voltou; estorno não repõe nada porque o que estava errado era o registro.
   Escolher a errada estraga o livro razão de um jeito que só a contagem física
   descobre.
"""

from __future__ import annotations

from datetime import date

from urllib.parse import quote, urlencode

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import (
    Anexo,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMotivoRecusa,
    Servidor,
)
from app.servicos import (
    anexo_acesso,
    anexos as servico_anexos,
    auditoria,
    comprovante_epi,
    epi_estoque,
    epi_ficha as servico,
    servidores as servico_servidores,
    textos,
)
from app.servicos.rbac import PermissaoNegada
from app.servicos.textos import TextoProibido
from app.web import fragmento, numero_da_pagina, pagina, recortar

rotas = APIRouter(tags=["epis"])

FICHAS = "/epis/fichas"
MINHA = "/epis/fichas/minha"
ENTREGA_NOVA = "/epis/entregas/nova"
REGISTROS = "/epis/fichas/registros"


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """Codificado: a mensagem cita nome de item, lote e motivo digitado, e um
    `&`, `#` ou `%` em qualquer um deles cortava o recado no `Location` — a
    mesma correção que `epi_requisicoes._aviso` e `turmas._aviso` receberam."""
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    separador = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(destino: str, mensagem: str) -> RedirectResponse:
    return _aviso(destino, "mensagem", mensagem)


def _erro(destino: str, mensagem: str) -> RedirectResponse:
    return _aviso(destino, "erro", mensagem)


def _itens_ativos(s) -> list[EpiItem]:
    return list(
        s.execute(
            select(EpiItem).where(EpiItem.ativo.is_(True)).order_by(EpiItem.nome)
        ).scalars()
    )


# A regra de quem lê a ficha mora em `servicos.epi_ficha`, e não aqui: quem a
# consome deixou de ser só esta tela quando o download do anexo passou a herdar
# a autorização do dono (`servicos.anexo_acesso`). O apelido local fica para as
# chamadas deste arquivo continuarem lendo como leem.
_exigir_leitura_da_ficha = servico.exigir_leitura_da_ficha


# =====================================================================
# A lista: quem tem ficha, e onde falta prova
# =====================================================================
@rotas.get(FICHAS)
def listar_fichas(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    q: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("epi.ficha")
    linhas = servico.servidores_com_ficha(s)
    if q:
        alvo = textos.chave_busca(q)
        linhas = [
            linha
            for linha in linhas
            if alvo in textos.chave_busca(linha[0].nome) or alvo in linha[0].siape
        ]
    # O aviso do alto conta as pendencias do FILTRO INTEIRO, e nao da pagina: ele
    # e o motivo pelo qual esta tela existe ("onde falta prova"), e um numero que
    # encolhesse ao virar de pagina diria que a lacuna diminuiu. Por isso a soma
    # vem antes do recorte.
    pendentes = sum(faltando for _, _, faltando in linhas)
    recorte = recortar(linhas, numero_da_pagina(request))
    return pagina(
        request,
        "paginas/epis_fichas.html",
        usuario=usuario,
        linhas=recorte.itens,
        recorte=recorte,
        q=q,
        pendentes=pendentes,
        mensagem=mensagem,
        erro=erro,
    )


# =====================================================================
# A porta do titular — antes de `/epis/fichas/{servidor_id}` pelo mesmo motivo
# de `REGISTROS`: `minha` não é inteiro, e declarada depois esta rota nunca seria
# alcançada (a URL responderia 422 em vez de abrir a ficha).
# =====================================================================
@rotas.get(MINHA)
def minha_ficha(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """`/epis/fichas/minha` → a ficha de quem está logado.

    A regra "`epi.ficha` **ou próprio**" já existia e já era testada; o que não
    existia era **caminho**. O item de menu "Fichas de EPI" aponta para o índice
    nominal e exige `epi.ficha`, então some — corretamente — para o servidor
    comum, e a única porta que restava saía de outro módulo (`/servidores`, com
    `processo.ver`). Tirar `processo.ver` do perfil, que seria defensável, apagava
    o acesso do titular ao que é dele sem que nada quebrasse.

    O atalho existe porque `modulos.Item` declara um caminho **fixo** e não sabe
    interpolar `usuario.servidor_id`. Exige exatamente `epi.ver` — a mesma
    permissão que a ficha própria exige em `epi_ficha.exigir_leitura_da_ficha` —,
    e é isso que mantém `test_link_no_menu_sempre_abre` valendo para o item novo.

    Conta sem cadastro de servidor não leva 403: 403 aqui faria o menu oferecer
    porta trancada a quem tem `epi.ver` e não está amarrado a um `Servidor` (a
    secretaria é o caso concreto). Ela recebe a tela que diz por quê e onde se
    conserta.

    A rota não lê nada, e mesmo assim declara `SessaoDep`: sem ela, o sino do
    cabeçalho abriria uma SEGUNDA sessão para contar as pendências — que é o
    deadlock consigo mesmo descrito em `web._sino`.
    """
    usuario.exigir("epi.ver")
    if usuario.servidor_id is None:
        return pagina(request, "paginas/epis_ficha_minha.html", usuario=usuario)
    return RedirectResponse(f"{FICHAS}/{usuario.servidor_id}", status_code=303)


# =====================================================================
# O balcão: registrar entrega
#
# Declarado ANTES de `/epis/fichas/{servidor_id}`: o roteador atende na ordem em
# que se declara, e `/epis/entregas/...` não colide, mas `REGISTROS` colidiria —
# ver o comentário lá embaixo.
# =====================================================================
@rotas.get(ENTREGA_NOVA)
def formulario_de_entrega(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    servidor_id: int | None = None,
    item_id: int | None = None,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("epi.entregar")
    return _tela_de_entrega(
        request,
        s,
        usuario,
        servidor_id=servidor_id,
        item_id=item_id,
        mensagem=mensagem,
        erro=erro,
    )


def _tela_de_entrega(
    request,
    s,
    usuario,
    *,
    servidor_id: int | None = None,
    item_id: int | None = None,
    mensagem: str | None = None,
    erro: str | None = None,
    digitado: dict | None = None,
    digitado_recusa: dict | None = None,
    foco_na_recusa: bool = False,
):
    """O balcão, em branco ou com o que foi digitado de volta.

    Uma função só para a abertura limpa e para as duas recusas desta tela, pelo
    mesmo motivo de `processos._tela_novo`. Os dois dicionários são separados
    porque a tela tem dois formulários independentes e ambos têm um campo
    chamado `item_id`: um só apagaria a escolha do outro. `digitado` não entra na
    assinatura da rota GET — dicionário em parâmetro de rota o FastAPI leria como
    corpo, e esta rota não tem corpo.
    """
    item = s.get(EpiItem, item_id) if item_id else None
    return pagina(
        request,
        "paginas/epis_entrega.html",
        usuario=usuario,
        # A lista inteira, ordenada — o `<select>` completo continua sendo o que
        # a tela devolve a quem nao tem JavaScript. Quem a recorta e a busca
        # HTMX de `/epis/entregas/servidores`, que serve o mesmo fragmento.
        servidores=servico_servidores.buscar(s, "", usuario),
        servidor_escolhido=s.get(Servidor, servidor_id) if servidor_id else None,
        itens=_itens_ativos(s),
        item=item,
        lotes=epi_estoque.lotes_de(s, item) if item is not None else [],
        motivos=list(
            s.execute(
                select(EpiMotivoRecusa)
                .where(EpiMotivoRecusa.ativo.is_(True))
                .order_by(EpiMotivoRecusa.rotulo)
            ).scalars()
        ),
        hoje=date.today(),
        digitado=digitado or {},
        digitado_recusa=digitado_recusa or {},
        foco_na_recusa=foco_na_recusa,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.get("/epis/entregas/servidores")
def buscar_servidor(request: Request, s: SessaoDep, usuario: UsuarioDep, q: str = ""):
    """Fragmento HTMX: a busca de servidor do balcao, sem recarregar a tela.

    Mesmo fragmento e mesmo servico de `/epis/requisicoes/nova` — o que muda e a
    permissao exigida (`epi.entregar`, e nao `epi.requisitar`) e o rotulo do
    campo. Uma rota por tela e o preco de a permissao ser a certa em cada uma:
    quem entrega no balcao nao e necessariamente quem abre pedido.

    O `usuario` vai no contexto porque `identificar()` le a RN-19 do contexto do
    template, e sem ele o fragmento cairia no lado seguro — identificador opaco
    para todo mundo, inclusive para quem pode ver o nome.
    """
    usuario.exigir("epi.entregar")
    return fragmento(
        request,
        "partes/epi_requisicao_servidores.html",
        usuario=usuario,
        servidores=servico_servidores.buscar(s, q, usuario),
        rotulo="Quem recebe",
        q=q,
    )


@rotas.get("/epis/entregas/opcoes")
def opcoes_do_item(request: Request, s: SessaoDep, usuario: UsuarioDep, item_id: str = ""):
    """Fragmento HTMX: escolhido o item, aparecem tamanho, lote e quantidade.

    Existe porque a escolha do lote **depende** da escolha do item, e recarregar
    a página inteira a cada troca perderia o servidor já selecionado. É a mesma
    técnica do filtro de posto por unidade prevista no §9 do desenho.
    """
    usuario.exigir("epi.entregar")
    item = s.get(EpiItem, int(item_id)) if item_id.isdigit() else None
    return fragmento(
        request,
        "partes/epi_opcoes_item.html",
        item=item,
        lotes=epi_estoque.lotes_de(s, item) if item is not None else [],
        hoje=date.today(),
    )


@rotas.post("/epis/entregas")
def registrar_entrega(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    # `Form("")` e não `Form(...)` nos obrigatórios: o FastAPI trata campo vazio
    # como AUSENTE e responde 422 em JSON — e era isso, e não a frase em
    # português da rota, que o balcão via ao enviar com o seletor em "—". Quem
    # cobra o obrigatório aqui embaixo é a própria rota, com a saída escrita. O
    # motivo está comentado igual em `epi_requisicoes.criar_rascunho`.
    servidor_id: str = Form(""),
    item_id: str = Form(""),
    quantidade: str = Form(""),
    entrada_id: str = Form(""),
    tamanho: str = Form(""),
    data_evento: str = Form(""),
    observacao: str = Form(""),
    justificativa_excecao: str = Form(""),
):
    usuario.exigir("epi.entregar")
    # Tudo o que foi digitado, guardado antes da primeira recusa — o padrão de
    # `processos.criar`. Este é o formulário de maior repetição do sistema: o
    # balcão, com alguém esperando de pé do outro lado. Uma data mal digitada
    # apagava quem recebe, o equipamento, o lote, a quantidade e a justificativa
    # da exceção, e a segunda tentativa saía pior do que a primeira.
    digitado = {
        "servidor_id": servidor_id,
        "item_id": item_id,
        "quantidade": quantidade,
        "entrada_id": entrada_id,
        "tamanho": tamanho,
        "data_evento": data_evento,
        "observacao": observacao,
        "justificativa_excecao": justificativa_excecao,
    }
    servidor = s.get(Servidor, int(servidor_id)) if servidor_id.isdigit() else None
    item = s.get(EpiItem, int(item_id)) if item_id.isdigit() else None

    def recusar(mensagem: str):
        # `servidor_id`/`item_id` vão pelo caminho normal da tela: são eles que
        # remontam o bloco de opções do item (tamanhos, lotes, quantidade), que
        # só existe depois da escolha do equipamento.
        return _tela_de_entrega(
            request,
            s,
            usuario,
            servidor_id=servidor.id if servidor else None,
            item_id=item.id if item else None,
            erro=mensagem,
            digitado=digitado,
        )

    if servidor is None:
        return recusar("Escolha o servidor que vai receber o EPI.")
    if item is None:
        return recusar("Escolha o item do catálogo.")
    if not quantidade.strip().isdigit() or int(quantidade) <= 0:
        return recusar("Quantidade inválida: informe um número maior que zero.")
    entrada = (
        s.get(EpiEntradaEstoque, int(entrada_id)) if entrada_id.strip().isdigit() else None
    )
    quando = None
    if data_evento.strip():
        try:
            quando = date.fromisoformat(data_evento.strip()[:10])
        except ValueError:
            return recusar("Data da entrega inválida.")
        if quando > date.today():
            # entrega com data futura seria prova de um fato que ainda não
            # aconteceu — e a ficha é append-only, então não haveria como desfazer
            return recusar("A entrega não pode ter data futura.")

    try:
        registro = servico.registrar_entrega(
            s,
            usuario,
            servidor=servidor,
            item=item,
            quantidade=int(quantidade),
            entrada=entrada,
            tamanho=tamanho,
            data_evento=quando,
            observacao=observacao,
            justificativa_excecao=justificativa_excecao,
        )
    except (servico.EntregaBloqueada, TextoProibido) as falha:
        s.rollback()
        motivos = getattr(falha, "motivos", None) or [str(falha)]
        return recusar(" · ".join(motivos))
    s.commit()
    return _volta(
        f"{FICHAS}/{servidor.id}",
        f"Entrega registrada (registro {registro.id}). "
        "Imprima o comprovante, colha a assinatura e anexe o digitalizado.",
    )


@rotas.post("/epis/entregas/recusa")
def registrar_recusa(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    # `Form("")` pelo motivo comentado em `registrar_entrega`: com `Form(...)` a
    # recusa enviada com o seletor em "—" respondia 422 em JSON, e a frase
    # "Escolha o motivo da recusa no catálogo." abaixo era inalcançável pela
    # tela. Quem cobra `a_quem` é o serviço, que já devolve o motivo por escrito.
    motivo_id: str = Form(""),
    a_quem: str = Form(""),
    item_id: str = Form(""),
    unidade: str = Form(""),
    complemento: str = Form(""),
):
    """RN-27 e as decisões 3 e 7: o "não" fundamentado, uniforme e contável.

    A UFVJM não fornece EPI a terceirizado, nem a estudante, nem a bolsista. O
    sistema não detecta isso sozinho — quem não é servidor não está no cadastro,
    e mantê-lo fora é a decisão. O que ele garante é que a negativa, uma vez
    tomada por gente, saia com o texto da norma e fique na trilha.
    """
    usuario.exigir("epi.entregar")
    # A recusa fundamentada é o mesmo atendimento terminando de outro jeito, e
    # perdia tudo pela mesma causa da entrega. Aqui doía duas vezes: o
    # complemento é o texto que o requerente vai receber, e redigitá-lo por
    # causa de um motivo não escolhido é o que faz a negativa sair mais curta e
    # menos fundamentada na segunda tentativa.
    digitado_recusa = {
        "motivo_id": motivo_id,
        "a_quem": a_quem,
        "item_id": item_id,
        "unidade": unidade,
        "complemento": complemento,
    }

    def recusar(mensagem: str):
        return _tela_de_entrega(
            request,
            s,
            usuario,
            erro=mensagem,
            digitado_recusa=digitado_recusa,
            foco_na_recusa=True,
        )

    motivo = s.get(EpiMotivoRecusa, int(motivo_id)) if motivo_id.isdigit() else None
    if motivo is None:
        return recusar("Escolha o motivo da recusa no catálogo.")
    item = s.get(EpiItem, int(item_id)) if item_id.strip().isdigit() else None
    try:
        servico.recusar(
            s,
            usuario,
            motivo=motivo,
            a_quem=a_quem,
            item=item,
            unidade=unidade,
            complemento=complemento,
        )
    except (servico.EntregaBloqueada, TextoProibido) as falha:
        s.rollback()
        motivos = getattr(falha, "motivos", None) or [str(falha)]
        return recusar(" · ".join(motivos))
    s.commit()
    return _volta(
        ENTREGA_NOVA,
        f"Recusa registrada com o motivo {motivo.codigo}. "
        "O texto que saiu para o requerente ficou congelado na trilha.",
    )


# =====================================================================
# Uma linha da ficha: comprovante, anexo e estorno
#
# `/epis/fichas/registros/...` vem ANTES de `/epis/fichas/{servidor_id}`: o
# roteador atende na ordem em que se declara, e "registros" não converte para
# `int` — a rota da ficha responderia 422 em vez de a rota certa atender.
# =====================================================================
def _registro_e_permissao(s, usuario, registro_id: int):
    registro = s.get(EpiFichaRegistro, registro_id)
    if registro is None:
        return None
    usuario.exigir("epi.entregar")
    return registro


@rotas.get(REGISTROS + "/{registro_id}")
def ir_para_a_ficha(s: SessaoDep, usuario: UsuarioDep, registro_id: int):
    """A linha aponta para a ficha de quem recebeu.

    Existe para a âncora da pendência ter para onde levar: `Pendencia` guarda
    `entidade` e `entidade_id`, não `servidor_id`, e sem esta rota a tela de
    pendências mostraria `epi_ficha_registro #4` e pararia aí.
    """
    registro = s.get(EpiFichaRegistro, registro_id)
    if registro is None:
        return RedirectResponse(FICHAS, status_code=303)
    _exigir_leitura_da_ficha(usuario, registro.servidor_id)
    return RedirectResponse(f"{FICHAS}/{registro.servidor_id}", status_code=303)


@rotas.get(REGISTROS + "/{registro_id}/comprovante")
def imprimir_comprovante(s: SessaoDep, usuario: UsuarioDep, registro_id: int):
    """O .docx impresso a partir dos snapshots — nunca do catálogo de hoje."""
    registro = _registro_e_permissao(s, usuario, registro_id)
    if registro is None:
        return RedirectResponse(FICHAS, status_code=303)
    caminho, _aviso = servico.imprimir(s, usuario, registro)
    s.commit()
    return FileResponse(
        caminho,
        filename=comprovante_epi.nome_para_download(servico.montar_contexto(registro)),
        media_type=comprovante_epi.TIPO_DOCX,
    )


@rotas.post(REGISTROS + "/{registro_id}/comprovante")
async def anexar_comprovante(
    s: SessaoDep,
    usuario: UsuarioDep,
    registro_id: int,
    arquivo: UploadFile = File(...),
):
    registro = _registro_e_permissao(s, usuario, registro_id)
    if registro is None:
        return RedirectResponse(FICHAS, status_code=303)
    destino = f"{FICHAS}/{registro.servidor_id}"
    conteudo = await arquivo.read()
    try:
        anexo = servico.anexar_comprovante(
            s,
            usuario,
            registro,
            conteudo=conteudo,
            nome_original=arquivo.filename or "comprovante.pdf",
            mime_type=arquivo.content_type or "application/pdf",
        )
    except servico.EntregaBloqueada as falha:
        s.rollback()
        return _erro(destino, " · ".join(falha.motivos))
    s.commit()
    return _volta(
        destino,
        f"Comprovante anexado · SHA-256 {anexo.sha256[:12]}. A entrega está completa.",
    )


@rotas.get(REGISTROS + "/{registro_id}/anexo")
def baixar_comprovante(s: SessaoDep, usuario: UsuarioDep, registro_id: int):
    registro = s.get(EpiFichaRegistro, registro_id)
    if registro is None or registro.comprovante_anexo_id is None:
        return RedirectResponse(FICHAS, status_code=303)
    anexo = s.get(Anexo, registro.comprovante_anexo_id)
    # A porta da frente do comprovante e a rota genérica `/anexos/{id}` passam
    # pela MESMA função: ela confere a leitura da ficha (RN-23) e escreve o
    # registro de acesso com o titular e a finalidade. Duas portas para o
    # arquivo com a assinatura manuscrita são inevitáveis — duas regras não são,
    # e era a segunda regra que gravava `servidor_id=None`.
    anexo_acesso.liberar(s, usuario, anexo)
    s.commit()
    return FileResponse(
        servico_anexos.caminho_absoluto(anexo),
        media_type=anexo.mime_type,
        filename=anexo.nome_original,
    )


@rotas.post(REGISTROS + "/{registro_id}/devolucao")
def registrar_devolucao(
    s: SessaoDep,
    usuario: UsuarioDep,
    registro_id: int,
    # `Form("")` nos obrigatórios: campo de texto vazio o FastAPI trata como
    # ausente e responde 422 em JSON. Quem valida — com o motivo escrito — é o
    # serviço.
    quantidade: str = Form(""),
    motivo: str = Form(""),
    data_evento: str = Form(""),
):
    """O EPI voltou. **Não é estorno** — e as duas ações não se confundem aqui.

    Estorno diz que o registro estava errado e não devolve saldo nenhum;
    devolução diz que o registro estava certo e que o equipamento voltou, e o
    saldo do lote sobe. As duas ficam lado a lado na tela, com o texto de cada
    uma dizendo o que ela faz, porque escolher a errada estraga o razão de um
    jeito que só a contagem física descobre.
    """
    registro = _registro_e_permissao(s, usuario, registro_id)
    if registro is None:
        return RedirectResponse(FICHAS, status_code=303)
    destino = f"{FICHAS}/{registro.servidor_id}"
    quantas = quantidade.strip()
    if not quantas.isdigit() or int(quantas) <= 0:
        return _erro(destino, "Quantidade devolvida inválida.")
    quando = None
    if data_evento.strip():
        try:
            quando = date.fromisoformat(data_evento.strip()[:10])
        except ValueError:
            return _erro(destino, "Data da devolução inválida.")
    try:
        devolucao = servico.registrar_devolucao(
            s,
            usuario,
            registro,
            quantidade=int(quantas),
            motivo=motivo,
            data_evento=quando,
        )
    except (servico.EntregaBloqueada, TextoProibido) as falha:
        s.rollback()
        motivos = getattr(falha, "motivos", None) or [str(falha)]
        return _erro(destino, " · ".join(motivos))
    s.commit()
    volta = "e o saldo voltou ao lote" if registro.entrada_id else "sem lote a repor"
    return _volta(
        destino,
        f"Devolução registrada (registro {devolucao.id}) {volta}. "
        "A entrega continua na ficha: devolver não desfaz o que aconteceu.",
    )


@rotas.post(REGISTROS + "/{registro_id}/estorno")
def estornar_registro(
    s: SessaoDep, usuario: UsuarioDep, registro_id: int, motivo: str = Form(...)
):
    registro = _registro_e_permissao(s, usuario, registro_id)
    if registro is None:
        return RedirectResponse(FICHAS, status_code=303)
    destino = f"{FICHAS}/{registro.servidor_id}"
    try:
        estorno = servico.estornar(s, usuario, registro, motivo)
    except (servico.EntregaBloqueada, TextoProibido) as falha:
        s.rollback()
        motivos = getattr(falha, "motivos", None) or [str(falha)]
        return _erro(destino, " · ".join(motivos))
    s.commit()
    return _volta(
        destino,
        f"Registro {registro.id} estornado pelo registro {estorno.id}. "
        "A linha original continua na ficha, marcada.",
    )


# =====================================================================
# A ficha do servidor — por último, pelo motivo do comentário acima
# =====================================================================
@rotas.get(FICHAS + "/{servidor_id}")
def ficha_do_servidor(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    servidor_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    servidor = s.get(Servidor, servidor_id)
    if servidor is None:
        # 403 e não 404, de propósito: quem não pode ler ficha de outro recebe a
        # mesma resposta para id que existe e para id que não existe. Distinguir
        # os dois transformaria a URL num enumerador do cadastro — que é
        # exatamente o que a RN-19 evita na tela.
        raise PermissaoNegada(
            "epi.ficha", "Não há ficha de EPI para consultar neste endereço."
        )
    # A permissão continua sendo decidida aqui — `exigir_leitura_da_ficha`
    # levanta para quem não pode. Quem decide o REGISTRO passou a ser
    # `registrar_leitura_nominal`: o `if de_outro` que morava nesta linha era
    # uma segunda escrita da mesma pergunta, e duas escritas da mesma pergunta
    # divergem na primeira correção — foi assim que o download do comprovante
    # ficou com rigor diferente do da tela que o exibe (1.35.0).
    _exigir_leitura_da_ficha(usuario, servidor_id)
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="epi_ficha",
        servidor_id=servidor.id,
        finalidade="consulta da ficha de EPI do servidor",
    ):
        s.commit()

    linhas = servico.linha_do_tempo(s, servidor_id)
    hoje = date.today()
    return pagina(
        request,
        "paginas/epis_ficha.html",
        usuario=usuario,
        servidor=servidor,
        linhas=linhas,
        hoje=hoje,
        pendentes=[linha for linha in linhas if linha.sem_comprovante],
        vencidos=[linha for linha in linhas if linha.ca_vencido_em(hoje)],
        trocas=[linha for linha in linhas if linha.troca_vencida_em(hoje)],
        divergencias=servico.conferir(s, servidor_id),
        pode_entregar=usuario.pode("epi.entregar"),
        mensagem=mensagem,
        erro=erro,
    )
