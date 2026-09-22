"""/auditoria - trilha append-only com diff campo a campo."""

from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import desc, select

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import AcessoDadoSensivel, HistoricoEvento, Usuario
from app.servicos.auditoria import (
    ConferenciaEmCurso,
    conferir_fora_da_transacao,
    janela_integra,
    ultima_conferencia,
)
from app.web import pagina

rotas = APIRouter(tags=["auditoria"])

POR_PAGINA = 100


@rotas.get("/auditoria")
def trilha(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    usuario_id: int | None = None,
    entidade: str | None = None,
    tipo_evento: str | None = None,
    pagina_num: int = 1,
    mensagem: str | None = None,
    erro: str | None = None,
):
    usuario.exigir("auditoria.ver")
    consulta = select(HistoricoEvento).order_by(desc(HistoricoEvento.id))
    if usuario_id:
        consulta = consulta.where(HistoricoEvento.usuario_id == usuario_id)
    if entidade:
        consulta = consulta.where(HistoricoEvento.entidade == entidade)
    if tipo_evento:
        consulta = consulta.where(HistoricoEvento.tipo_evento == tipo_evento)

    eventos = list(
        s.execute(
            consulta.limit(POR_PAGINA).offset((max(pagina_num, 1) - 1) * POR_PAGINA)
        ).scalars()
    )
    # A JANELA, e nao a cadeia inteira (Q-2). O passe completo percorria a tabela
    # toda a cada abertura desta tela, com o lock de escrita do SQLite na mao — a
    # ~55 us por evento, aos ~90 mil eventos uma abertura de /auditoria passava
    # dos 5 s de `busy_timeout` e derrubava a tela de todo mundo. O que a pessoa
    # tem diante dos olhos sao 100 eventos; conferir os 100 custa ~6 ms e nao
    # cresce com a idade do sistema. A cadeia inteira tem o botao abaixo.
    ok, defeito = janela_integra(s, eventos)
    tipos = sorted(
        {t for (t,) in s.execute(select(HistoricoEvento.tipo_evento).distinct()).all()}
    )
    entidades = sorted(
        {e for (e,) in s.execute(select(HistoricoEvento.entidade).distinct()).all()}
    )
    return pagina(
        request,
        "paginas/auditoria.html",
        usuario=usuario,
        eventos=eventos,
        janela_ok=ok,
        janela_defeito=defeito,
        conferencia=ultima_conferencia(s),
        tipos=tipos,
        entidades=entidades,
        filtro_usuario=usuario_id,
        filtro_entidade=entidade,
        filtro_tipo=tipo_evento,
        pagina_num=pagina_num,
        mensagem=mensagem,
        erro=erro,
        usuarios=list(s.execute(select(Usuario).order_by(Usuario.nome)).scalars()),
        acessos=list(
            s.execute(
                select(AcessoDadoSensivel).order_by(desc(AcessoDadoSensivel.id)).limit(50)
            ).scalars()
        ),
    )


# POST, e nao GET, pelo mesmo motivo do EXPORTAR-TUDO: o que sai daqui e um
# efeito colateral (uma linha nova em `conferencia_cadeia`) e uma varredura da
# trilha inteira. Com `SameSite=lax` o cookie viaja em navegacao de topo, entao
# um GET poderia ser disparado por um link de fora.
@rotas.post("/auditoria/conferir")
def conferir(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """O passe completo, sob demanda. Solta a transacao antes de percorrer.

    Quem abre a trilha pode conferi-la: a pergunta "isto ainda faz prova?" e da
    mesma natureza que ler a trilha, e negar a resposta a quem ve os eventos
    seria oferecer a prova sem deixar confirma-la. O que tornava perigoso
    responde-la era o lock, e o lock saiu do caminho — `conferir_fora_da_transacao`
    comita antes de ler, e le por uma conexao que nao disputa escrita.
    """
    usuario.exigir("auditoria.ver")
    try:
        resultado = conferir_fora_da_transacao(s, usuario=usuario)
    except ConferenciaEmCurso as falha:
        return trilha(request, s, usuario, erro=str(falha))
    if resultado.integra:
        aviso = (
            f"Cadeia conferida: {resultado.eventos} evento(s), encadeamento "
            f"íntegro ({resultado.duracao_ms} ms)."
        )
        return trilha(request, s, usuario, mensagem=aviso)
    return trilha(
        request,
        s,
        usuario,
        erro=(
            f"O encadeamento não fecha a partir do evento "
            f"{resultado.primeiro_defeito_id}. Preserve o arquivo do banco como "
            "está e trate como incidente."
        ),
    )
