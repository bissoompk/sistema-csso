"""/config - parametros operacionais, backup e exportacao."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.config import VERSAO, obter_config
from app.dependencias import SessaoDep, UsuarioDep
from app.modelos import AutoridadeDestinataria, SetorEmissor
from app.servicos.rbac import PermissaoNegada
from app.servicos import auditoria, backup as servico_backup, sei
from app.servicos.processo import SLA_PADRAO, gravar_sla, sla_vigente
from app.web import pagina

rotas = APIRouter(tags=["config"])

# Quem abre `/config`, e por quê são duas permissões e não uma.
#
# A tela guarda coisas de duas naturezas. Uma é **parâmetro do processo**: o SLA
# que pinta o vermelho de toda lista, o setor emissor e a autoridade
# destinatária, que são congelados no parecer na emissão (RN-15). A outra é
# **operação da máquina**: onde o banco e os anexos moram, o backup cifrado e a
# exportação total — a continuidade do negócio.
#
# Exigir só `processo.ver` deixava a segunda trancada para o único perfil que
# existe para ela: `admin_ti` tem `backup.executar` e não tem `processo.ver`, e
# a base normativa dele diz por quê ("sem acesso ao conteúdo técnico: só conta,
# senha, auditoria e backup"). Quem faz backup não alcançava a tela do backup, e
# a decisão estava fixada em teste desde a 1.0.
#
# A saída NÃO é abrir a tela inteira. Abrir demais é defeito do mesmo tamanho:
# entregar o SLA e os nomes e cargos da autoridade signatária ao administrador de
# TI contraria a promessa que torna seguro dar a ele o banco. Então a ROTA aceita
# qualquer uma das duas — quem tem uma das duas tem o que fazer aqui — e a TELA
# reparte: os cartões de processo pedem `processo.ver`, os de máquina abrem para
# quem entrou. É a mesma repartição que a tela já fazia dentro do cartão de
# backup, onde o botão sempre pediu `backup.executar`.
PERMISSOES_CONFIG: tuple[str, ...] = ("processo.ver", "backup.executar")


def _exigir_config(usuario) -> None:
    """Qualquer uma de `PERMISSOES_CONFIG` — nunca as duas.

    `dependencias.exigir` é E, não OU: ela existe para somar exigências. O padrão
    de "qualquer uma destas" já vive em `modulos.Item.permissao`, e é o mesmo que
    `/usuarios` e `/pendencias` usam. A porta da tela (a engrenagem do bloco do
    usuário, em `base.html`) repete esta tupla — se um dia ela divergir, o menu
    volta a oferecer porta trancada.
    """
    if not any(usuario.pode(codigo) for codigo in PERMISSOES_CONFIG):
        raise PermissaoNegada(
            PERMISSOES_CONFIG[0],
            "A configuração do sistema abre para quem instrui processo "
            "(`processo.ver`) ou para quem opera a máquina (`backup.executar`).",
        )


@rotas.get("/config")
def tela(
    request: Request,
    s: SessaoDep,
    usuario: UsuarioDep,
    mensagem: str | None = None,
    erro: str | None = None,
):
    _exigir_config(usuario)
    cfg = obter_config()
    # o que é do processo só é CONSULTADO por quem pode vê-lo: consultar para
    # depois esconder no template é o convite a alguém remover o `{% if %}` e não
    # perceber que o dado já estava na mão
    do_processo = usuario.pode("processo.ver")
    return pagina(
        request,
        "paginas/config.html",
        usuario=usuario,
        cfg=cfg,
        versao=VERSAO,
        do_processo=do_processo,
        sla=sla_vigente(s) if do_processo else {},
        sla_padrao=SLA_PADRAO,
        setores=list(s.execute(select(SetorEmissor)).scalars()) if do_processo else [],
        destinatarios=(
            list(s.execute(select(AutoridadeDestinataria)).scalars())
            if do_processo
            else []
        ),
        passos_sei=sei.PASSOS_INCLUSAO if do_processo else (),
        versao_sei=sei.VERSAO_SEI_ALVO,
        mensagem=mensagem,
        erro=erro,
    )


@rotas.post("/config/sla")
async def salvar_sla(request: Request, s: SessaoDep, usuario: UsuarioDep):
    """RN-16 — o prazo de cada coluna é decisão do setor, não constante de código."""
    dados = await request.form()
    valores = {
        coluna: int(dados[f"sla_{coluna}"])
        for coluna in SLA_PADRAO
        if str(dados.get(f"sla_{coluna}", "")).strip().isdigit()
    }
    try:
        gravar_sla(s, valores, usuario)
    except PermissaoNegada as falha:
        return tela(request, s, usuario, erro=str(falha))
    s.commit()
    return tela(request, s, usuario, mensagem="SLA atualizado.")


@rotas.post("/config/backup")
def executar_backup(request: Request, s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("backup.executar")
    try:
        resultado = servico_backup.fazer_backup()
    except servico_backup.DestinoProibido as falha:
        return tela(request, s, usuario, erro=str(falha))
    auditoria.registrar(
        s,
        entidade="sistema",
        entidade_id=0,
        tipo_evento="BACKUP_EXECUTADO",
        descricao=(
            f"{resultado.arquivo.name} ({resultado.tamanho} bytes, cifrado, "
            f"banco + {resultado.arquivos} arquivo(s) de anexos/documentos)."
        ),
        usuario=usuario,
    )
    s.commit()
    return tela(
        request,
        s,
        usuario,
        mensagem=(
            f"Backup cifrado gerado: {resultado.arquivo.name} — banco e "
            f"{resultado.arquivos} arquivo(s) de anexos e documentos."
        ),
    )


# POST, e nao GET. O que sai daqui e um zip EM CLARO com o banco inteiro, os
# CSVs nominais (nome, SIAPE, cargo, unidade, agente nocivo, fundamentacao) e
# todos os anexos, inclusive os comprovantes de EPI com a assinatura manuscrita
# do titular — e ate a 1.31.0 bastava um GET para produzi-lo.
#
# `SameSite=lax` NAO cobre isto. Ele existe para nao mandar o cookie em POST de
# outra origem, e manda em navegacao de topo — que e exatamente o que um
# `<img src>` nao faz mas um link, um `<meta refresh>` ou um `window.open` de
# uma pagina qualquer fazem. Bastava alguem com a permissao `exportar` abrir
# essa pagina, logado, para o pacote ser gerado e gravado em
# `CSSO_BACKUP_DESTINO` — que a POLITICA_RETENCAO ja preve que seja uma pasta de
# rede. Numa maquina so isso era teorico; com a equipe na rede, nao e.
#
# Virar POST devolve o `SameSite=lax` ao seu trabalho: o cookie deixa de ser
# enviado, e a rota volta a exigir que quem clicou estivesse nesta tela.
@rotas.post("/config/exportar-tudo")
def exportar(s: SessaoDep, usuario: UsuarioDep):
    usuario.exigir("exportar")
    alvo = servico_backup.exportar_tudo(s)
    auditoria.registrar(
        s,
        entidade="sistema",
        entidade_id=0,
        tipo_evento="EXPORTACAO_COMPLETA",
        descricao=alvo.name,
        usuario=usuario,
    )
    s.commit()
    return FileResponse(alvo, filename=alvo.name, media_type="application/zip")
