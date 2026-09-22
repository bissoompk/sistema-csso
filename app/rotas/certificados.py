"""/certificados — os emitidos, a ficha, a segunda via e a anulação.

Fatia 4 do módulo Certificados e Treinamentos. A emissão em si mora na aba 4 de
`/turmas/{id}`, que é onde o trabalho acontece; aqui ficam a consulta, a segunda
via a partir do congelado e a anulação.

Nenhuma regra mora neste arquivo: as rotas leem o formulário, chamam
`app/servicos/emissao_certificado.py` e traduzem a recusa em mensagem. A guarda
que importa é a do serviço — a revisão da fatia 1 mostrou o que acontece quando
ela vive só no template.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import Certificado, Treinamento
from app.modelos.treinamento import ROTULO_CERTIFICADO, SITUACOES_CERTIFICADO
from app.servicos import auditoria, emissao_certificado as servico
from app.servicos.rbac import UsuarioAtual, aplicar_escopo
from app.web import numero_da_pagina, pagina, recortar_consulta

rotas = APIRouter(tags=["certificados"])

CERTIFICADOS = "/certificados"
MEUS = CERTIFICADOS + "/meus"


def _aviso(destino: str, campo: str, mensagem: str) -> RedirectResponse:
    """Aviso na query string, codificado — ver `turmas._aviso`.

    O motivo da anulação é digitado, e "art. 10, §2º & seguintes" cortava o
    recado no `&`.
    """
    separador = "&" if "?" in destino else "?"
    parametros = urlencode({campo: mensagem}, quote_via=quote)
    return RedirectResponse(f"{destino}{separador}{parametros}", status_code=303)


def _volta(destino: str, mensagem: str) -> RedirectResponse:
    """Deu certo. Banner verde."""
    return _aviso(destino, "mensagem", mensagem)


def _erro(destino: str, mensagem: str) -> RedirectResponse:
    """Não deu. Banner vermelho — `mensagem=` sai em `.aviso-ok` no `base.html`,
    e uma anulação recusada pintada de verde se lê como anulação feita."""
    return _aviso(destino, "erro", mensagem)


def _recusar(s, destino: str, mensagem: str) -> RedirectResponse:
    """Desfaz o que a ação já tinha escrito e volta com o motivo.

    A sessão da requisição dá **commit** quando a rota retorna, e recusa é
    retorno normal (`dependencias.obter_sessao`). Aqui o caso concreto é a
    anulação sem motivo: `certificado.situacao` já teria sido tocado se o
    serviço tivesse chegado a escrever antes de recusar.
    """
    s.rollback()
    return _erro(destino, mensagem)


def _id_opcional(valor: str) -> int | None:
    return int(valor) if (valor or "").strip().isdigit() else None


# A leitura filtrada pelo escopo mora no serviço (`emissao_certificado.no_escopo`):
# o anexo do certificado tem de alcançar exatamente a mesma linha que esta tela
# alcança, e duas consultas iguais em arquivos diferentes divergem na primeira
# correção. O apelido local fica para as chamadas deste arquivo não mudarem.
_no_escopo = servico.no_escopo


# =====================================================================
# Lista
# =====================================================================
@rotas.get(CERTIFICADOS)
def listar(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    situacao: str = "",
    treinamento_id: str = "",
    busca: str = "",
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("certificado.ver")
    consulta = aplicar_escopo(select(Certificado), usuario, Certificado)
    if situacao in SITUACOES_CERTIFICADO:
        consulta = consulta.where(Certificado.situacao == situacao)
    alvo = _id_opcional(treinamento_id)
    if alvo is not None:
        consulta = consulta.where(Certificado.treinamento_id == alvo)
    limpa = (busca or "").strip()
    if limpa:
        # busca pela CHAVE, e não por nome: a lista autenticada já mostra o nome,
        # e a consulta por chave é o que o suporte faz quando alguém liga com o
        # papel na mão
        from app.servicos.certificado import normalizar_chave

        consulta = consulta.where(
            Certificado.chave_validacao == normalizar_chave(limpa)
        )
    # `recortar_consulta` e nao `recortar`: aqui os TRES filtros da tela —
    # situacao, treinamento e chave de validacao — ja sao `where` desta consulta,
    # entao quem sabe recortar melhor e o banco. Nas listas cujo filtro roda em
    # Python (a RN-19 de /servidores, a busca por relacionamento de /laudos) e o
    # contrario, e o docstring dos dois diz por que.
    recorte = recortar_consulta(
        s,
        consulta.order_by(Certificado.ano.desc(), Certificado.numero.desc()),
        numero_da_pagina(request),
    )
    itens = recorte.itens
    hoje = date.today()
    return pagina(
        request,
        "paginas/certificados.html",
        usuario=usuario,
        itens=itens,
        recorte=recorte,
        hoje=hoje,
        situacao_publica={c.id: c.situacao_publica(hoje) for c in itens},
        rotulo_certificado=ROTULO_CERTIFICADO,
        situacoes=[(codigo, ROTULO_CERTIFICADO[codigo]) for codigo in SITUACOES_CERTIFICADO],
        treinamentos=list(
            s.execute(select(Treinamento).order_by(Treinamento.nome)).scalars()
        ),
        filtro_situacao=situacao,
        filtro_treinamento=treinamento_id,
        busca=busca,
        mensagem=mensagem,
        erro=erro,
    )


# =====================================================================
# Meus certificados — a tela do titular
#
# Declarada ANTES de `/certificados/{certificado_id}`: o roteador atende na ordem
# em que se declara, e `meus` nao e inteiro — declarada depois, esta rota nunca
# seria alcancada e a URL responderia 422.
# =====================================================================
@rotas.get(MEUS)
def meus(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """O certificado do proprio servidor, e a porta que ele acha.

    Tela separada de `/certificados`, e nao a mesma com o filtro aberto, por tres
    razoes que valem cada uma sozinha:

    1. **A permissao do item de menu e a mesma da rota.** `/certificados` exige
       `certificado.ver`; esta exige `treinamento.ver`. Se as duas fossem a mesma
       tela, o item teria de declarar as duas e `test_link_no_menu_sempre_abre`
       passaria a medir uma condicao que o menu nao sabe exprimir — a de ter
       `servidor_id`.
    2. **O filtro e fixo.** `consulta_do_titular` prende `servidor_id` ao da
       conta; nao herda o escopo do perfil, entao nao alarga se o perfil alargar.
    3. `/certificados` continua sendo a lista do setor, com os filtros e a busca
       por chave que o suporte usa. Uma tela que servisse aos dois publicos
       decidiria escopo por ramo, que e como o defeito da fila de EPI nasceu.
    """
    usuario.exigir("treinamento.ver")
    consulta = servico.consulta_do_titular(usuario).order_by(
        Certificado.ano.desc(), Certificado.numero.desc()
    )
    recorte = recortar_consulta(s, consulta, numero_da_pagina(request))
    itens = recorte.itens
    hoje = date.today()
    return pagina(
        request,
        "paginas/certificados_meus.html",
        usuario=usuario,
        itens=itens,
        recorte=recorte,
        hoje=hoje,
        situacao_publica={c.id: c.situacao_publica(hoje) for c in itens},
        # a conta sem cadastro de servidor nao e erro: e a tela dizendo por que
        # esta vazia, em vez de deixar a pessoa concluir que nunca fez curso
        sem_servidor=usuario.servidor_id is None,
    )


def _volta_da_ficha(usuario: UsuarioAtual) -> str:
    """Para onde volta quem pediu um certificado que nao alcanca.

    O titular nao abre `/certificados` — mandar ele para la trocaria um
    redirecionamento por um 403, que e a porta trancada que o resto do sistema
    evita.
    """
    return CERTIFICADOS if usuario.pode("certificado.ver") else MEUS


def _abrir(s, usuario: UsuarioAtual, certificado_id: int):
    """A linha e a relacao com ela: `(certificado | None, de_outro)`.

    Uma porta so para a ficha e para a segunda via, e a ordem dos tres passos e
    a que evita transformar a URL num enumerador:

    1. quem nao tem `certificado.ver` **nem** cadastro de servidor leva o mesmo
       403 de sempre, antes de o banco ser tocado — sem isto, a diferenca entre
       303 e 403 contaria a um estranho se o id existe;
    2. `no_escopo` decide QUAL linha a pessoa alcanca (para o escopo proprio, so
       a dela) — id inexistente e certificado de outro respondem igual;
    3. `exigir_leitura_do_certificado` decide o RIGOR: titular entra com
       `treinamento.ver` e nao gera registro; terceiro exige `certificado.ver` e
       e registrado por quem chama.
    """
    if not usuario.pode("certificado.ver") and usuario.servidor_id is None:
        usuario.exigir("certificado.ver")
    certificado = _no_escopo(s, usuario, certificado_id)
    if certificado is None:
        return None, False
    return certificado, servico.exigir_leitura_do_certificado(
        usuario, certificado.servidor_id
    )


# =====================================================================
# Ficha
# =====================================================================
@rotas.get(CERTIFICADOS + "/{certificado_id}")
def ficha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    certificado_id: int,
    mensagem: str | None = None,
    erro: str | None = None,
):
    """O congelado, o hash, a trilha e o link público.

    O congelado é exibido campo a campo de propósito: é ele que responde
    "por que o certificado diz isto?" quando o catálogo já mudou, e sem a tela
    a única forma de consultá-lo seria abrir o banco.
    """
    # O segundo valor de `_abrir` é a relação titular/terceiro, e ela é lida
    # aqui só para o efeito colateral que a acompanha: `_abrir` levanta para
    # quem não pode. Quem decide o registro é a linha abaixo.
    certificado, _de_outro = _abrir(s, usuario, certificado_id)
    if certificado is None:
        return RedirectResponse(_volta_da_ficha(usuario), status_code=303)
    # Ler o certificado nominal de OUTRA pessoa entra em `acesso_dado_sensivel`,
    # como o §5 do desenho promete e como a ficha de EPI já faz. Ler o próprio
    # não: é o art. 18, II, e a linha diria "o titular leu o dele", que não
    # responde pergunta nenhuma de investigação.
    #
    # Quem responde "é de outro?" é `registrar_leitura_nominal`, e não mais o
    # `if de_outro and ... is not None` que morava aqui: a condição estava certa
    # e era a terceira cópia dela no sistema. `de_outro` continua vindo de
    # `_abrir` porque é ele que decide o RIGOR da permissão — as duas perguntas
    # são vizinhas e não são a mesma.
    if auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="certificado",
        servidor_id=certificado.servidor_id,
        finalidade="consulta da ficha do certificado de treinamento",
    ):
        s.commit()
    contexto = servico.montar_contexto(s, certificado)
    from app.servicos.certificado import CAMPOS_CERTIFICADO

    substituto = (
        s.get(Certificado, certificado.substituido_por_id)
        if certificado.substituido_por_id
        else None
    )
    return pagina(
        request,
        "paginas/certificado_ficha.html",
        usuario=usuario,
        certificado=certificado,
        contexto=contexto,
        campos=CAMPOS_CERTIFICADO,
        substituto=substituto,
        hoje=date.today(),
        situacao_publica=certificado.situacao_publica(date.today()),
        rotulo_certificado=ROTULO_CERTIFICADO,
        eventos=_trilha(s, certificado.id),
        mensagem=mensagem,
        erro=erro,
    )


def _trilha(s, certificado_id: int):
    from app.modelos import HistoricoEvento

    return list(
        s.execute(
            select(HistoricoEvento)
            .where(
                HistoricoEvento.entidade == "certificado",
                HistoricoEvento.entidade_id == certificado_id,
            )
            .order_by(HistoricoEvento.id.desc())
        ).scalars()
    )


# =====================================================================
# Segunda via
# =====================================================================
@rotas.get(CERTIFICADOS + "/{certificado_id}/documento")
def segunda_via(s: SessaoDep, usuario: UsuarioDep, certificado_id: int):
    """A segunda via, reimpressa **do congelado** — nunca do catálogo de hoje.

    Sai também para certificado anulado: quem precisa juntar ao processo o papel
    que foi anulado precisa do papel. O que a anulação muda é a resposta da
    página pública, não a existência do documento.
    """
    # A permissão e o registro moram no serviço (`segunda_via` chama a mesma
    # `exigir_leitura_do_certificado`): a via do titular é a razão de esta rota
    # abrir para ele, e uma segunda checagem aqui divergiria da de lá.
    certificado, _ = _abrir(s, usuario, certificado_id)
    if certificado is None:
        return RedirectResponse(_volta_da_ficha(usuario), status_code=303)
    resultado = servico.segunda_via(s, usuario, certificado)
    s.commit()
    return FileResponse(
        resultado.docx, filename=resultado.docx.name, media_type=servico.TIPO_DOCX
    )


# =====================================================================
# Anulação
# =====================================================================
@rotas.post(CERTIFICADOS + "/{certificado_id}/anular")
def anular(
    s: SessaoDep,
    usuario: UsuarioDep,
    certificado_id: int,
    motivo: str = Form(""),
):
    """Anular libera a reemissão sem apagar o histórico (RN-14).

    O `Form("")` é default vazio de propósito, e não `Form(...)`: o serviço é
    quem recusa a anulação sem motivo, com a mensagem que explica por quê. Com
    `Form(...)` o FastAPI devolveria um JSON 422 e a pessoa veria um despejo de
    validação em vez de uma frase.
    """
    usuario.exigir("certificado.anular")
    certificado = _no_escopo(s, usuario, certificado_id)
    if certificado is None:
        return RedirectResponse(CERTIFICADOS, status_code=303)
    destino = f"{CERTIFICADOS}/{certificado_id}"
    try:
        servico.anular(s, usuario, certificado, motivo)
    except ValueError as erro:
        return _recusar(s, destino, str(erro))
    s.commit()
    return _volta(
        destino,
        f"Certificado {certificado.rotulo} anulado. Para reemitir, volte à turma "
        "e emita de novo.",
    )
