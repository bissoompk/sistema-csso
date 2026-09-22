"""A lista de presenca da turma em .docx — a folha que vai ao campo para assinar.

Reaproveita o mecanismo de documento que ja existe
(`documento.renderizar_modelo`): modelo .docx com marcadores em
`app/templates/`, render por docxtpl, SHA-256 do modelo e do texto gerado. Um
segundo mecanismo de documento seria um segundo lugar para o hash de
integridade divergir, e o parecer ja provou que um so basta.

O modelo (`lista_presenca_v1.docx`) e produzido por
`ferramentas/gerar_modelo_lista_presenca.py` e pode ser substituido por um
desenhado no Word, desde que use os mesmos marcadores — a mesma liberdade que o
modelo do parecer tem.

**A folha e regerada a cada pedido, de proposito.** Ela nao congela nada: quem
entra na turma na vespera precisa estar na lista, e uma folha guardada seria
uma folha desatualizada. O congelamento (RN-15) e do certificado, que e o
documento que circula — nao da folha de rascunho que volta assinada e vira
anexo.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import obter_config
from app.modelos import Turma
from app.modelos.treinamento import ROTULO_VINCULO
from app.servicos import auditoria, datas_br, documento, textos
from app.servicos.parecer import setor_emissor_vigente
from app.servicos.presenca import numero
from app.servicos.rbac import UsuarioAtual
from app.servicos.turma import inscricoes_da_turma

MODELO = "lista_presenca_v1.docx"
SUBPASTA = "listas_presenca"
LISTA_GERADA = "LISTA_PRESENCA_GERADA"
TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def caminho_saida(turma: Turma) -> Path:
    """`dados/documentos/listas_presenca/{ano}/Lista_Presenca_TUR-2026-0001.docx`.

    Por ano, como o parecer, porque e assim que o setor arquiva e e assim que o
    backup separa.
    """
    cfg = obter_config()
    pasta = cfg.caminho(cfg.dir_documentos) / SUBPASTA / str(turma.ano)
    # o codigo entra inteiro, com os hifens: ele e gerado por `turma.codigo_de`
    # e sempre casa `TUR-AAAA-NNNN`, entao ja e nome de arquivo seguro — e e por
    # ele que alguem vai procurar a folha na pasta. `slug_ascii` trocaria os
    # hifens por sublinhados e a busca por "TUR-2026-0001" nao acharia nada.
    seguro = textos.slug_ascii(turma.codigo.replace("-", "_")).replace("_", "-")
    return pasta / f"Lista_Presenca_{seguro}.docx"


def _periodo(turma: Turma) -> str:
    if turma.data_inicio == turma.data_fim:
        return datas_br.numerica(turma.data_inicio)
    return (
        f"{datas_br.numerica(turma.data_inicio)} a "
        f"{datas_br.numerica(turma.data_fim)}"
    )


def montar_contexto(s: Session, turma: Turma) -> dict:
    """O dicionario que o modelo consome.

    So entra quem ocupa vaga: cancelada nao assina folha nenhuma, e deixa-la na
    lista faria alguem procurar por um nome que desistiu — ou, pior, assinar no
    lugar dele.
    """
    setor = setor_emissor_vigente(s, turma.data_inicio)
    participantes = [
        {
            "ordem": ordem,
            "nome": inscricao.participante.nome_exibicao,
            "identificador": inscricao.participante.identificador_publico,
            "vinculo": ROTULO_VINCULO.get(
                inscricao.participante.vinculo, inscricao.participante.vinculo
            ),
        }
        for ordem, inscricao in enumerate(
            (i for i in inscricoes_da_turma(s, turma) if i.ocupa_vaga), start=1
        )
    ]
    instrutores = [
        vinculo.instrutor.nome_exibicao
        + (f" — {vinculo.instrutor.titulo}" if vinculo.instrutor.titulo else "")
        for vinculo in turma.instrutores
    ]
    return {
        "setor_sigla": setor.sigla_composta if setor else "",
        "setor_nome": setor.nome_extenso if setor else "",
        "cidade": setor.cidade if setor else "",
        "turma_codigo": turma.codigo,
        "treinamento": turma.treinamento.nome,
        "periodo": _periodo(turma),
        "carga_horaria": f"{numero(turma.carga_efetiva)} horas",
        "local": turma.local or "—",
        "campus": turma.campus.nome if turma.campus else "—",
        "unidade_promotora": (
            turma.unidade_promotora.nome_extenso if turma.unidade_promotora else "—"
        ),
        # RichText porque instrutor de turma sao varios e cada um vai numa linha
        # dentro da mesma celula — o mesmo `_rich` que o parecer usa nos postos
        "instrutores": documento.rich_multilinha("\n".join(instrutores)) or "—",
        "frequencia_minima": f"{numero(turma.frequencia_minima_percentual)}%",
        "nota_minima": (
            numero(turma.nota_minima_aprovacao)
            if turma.nota_minima_aprovacao is not None
            else "não avalia por nota"
        ),
        "participantes": participantes,
        "total": len(participantes),
        "gerada_em": datas_br.numerica(date.today()),
    }


def gerar(s: Session, usuario: UsuarioAtual, turma: Turma) -> dict:
    """Grava a folha e registra a geracao na trilha.

    A geracao entra na auditoria porque a folha e um documento que sai do
    sistema com nome de gente dentro: saber quem a tirou e quando e o mesmo
    criterio que o sistema aplica a qualquer leitura nominal.
    """
    usuario.exigir("turma.avaliar")
    contexto = montar_contexto(s, turma)
    resultado = documento.renderizar_modelo(MODELO, contexto, caminho_saida(turma))
    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=LISTA_GERADA,
        descricao=(
            f"{turma.codigo}: lista de presença com {contexto['total']} "
            f"participante(s) · {resultado['hash_conteudo'][:12]}"
        ),
        usuario=usuario,
    )
    s.flush()
    return resultado


__all__ = [
    "LISTA_GERADA",
    "MODELO",
    "TIPO_DOCX",
    "caminho_saida",
    "gerar",
    "montar_contexto",
]
