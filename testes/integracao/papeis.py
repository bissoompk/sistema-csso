"""Atores dos testes de integracao, preenchidos pela fixture `atores`.

Ficam num modulo proprio para que varios arquivos de teste usem os mesmos
usuarios sem duplicar a montagem - e sem passar o ator por parametro em cada
uma das dezenas de asserções.
"""

from __future__ import annotations

from app.servicos.rbac import UsuarioAtual

TODAS = frozenset(
    {
        "processo.ver", "processo.criar", "processo.editar", "processo.status",
        "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
        "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
        "laudo.criar", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
        "catalogo.gerenciar",
    }
)

# Fatima: emite e move o kanban, mas NAO assina nem subscreve laudo.
SEM_ASSINATURA = TODAS - {"parecer.assinar", "laudo.criar", "parecer.anular"}

COORDENADOR: UsuarioAtual
TECNICA: UsuarioAtual


def definir(coordenador_id: int, tecnica_id: int) -> None:
    global COORDENADOR, TECNICA
    COORDENADOR = UsuarioAtual(
        id=coordenador_id,
        login="coord",
        nome="Coordenador",
        permissoes=TODAS,
        perfis=("coordenador_csso",),
    )
    TECNICA = UsuarioAtual(
        id=tecnica_id,
        login="fatima",
        nome="Fátima",
        permissoes=SEM_ASSINATURA,
        perfis=("tecnico_seguranca",),
    )
