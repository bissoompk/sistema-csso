"""RN-12 - anexos com dedup por SHA-256 e blob compartilhado."""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import obter_config
from app.modelos import Anexo
from app.servicos import auditoria
from app.servicos.rbac import UsuarioAtual
from app.servicos.textos import slug_ascii

# O que se anexa a um processo do adicional ocupacional. E o que a tela do
# processo oferece: colocar ali a ficha de EPI ou a CAT/SP seria oferecer a
# categoria errada no lugar errado.
CATEGORIAS_PROCESSO = (
    "PARECER_ASSINADO",
    "LAUDO",
    "PORTARIA",
    "DESPACHO",
    "FORMULARIO",
    "RELATORIO_CAMPO",
    "FOTO",
    "OUTRO",
)

# Categorias dos modulos que ainda estao sendo construidos. Entraram todas de
# uma vez, antes das telas que as usam, porque estender `ck_anexo_cat` no SQLite
# reconstroi a tabela `anexo` — que ja tem dados e e referenciada por FK. Uma
# reconstrucao em vez de tres.
#
# Categoria nao e rotulo: e ela que decide QUANDO o arquivo pode ser eliminado.
# `docs/POLITICA_RETENCAO.md` §2.1 da 5 anos a RELATORIO_CAMPO/FOTO/OUTRO e
# guarda permanente a PARECER_ASSINADO/LAUDO/PORTARIA/FORMULARIO. Gravar a
# rubrica do instrutor como 'FOTO' seria marcar para eliminacao em 5 anos a
# assinatura de um certificado de guarda permanente — daí RUBRICA_INSTRUTOR ter
# nome proprio. Nenhuma das oito novas esta nomeada naquelas duas linhas ainda:
# hoje isso nao apaga nada (nao existe rotina de eliminacao no sistema), mas a
# fatia que criar a rotina precisa das linhas antes.
CATEGORIAS_EPI = ("MANUAL_EPI", "FICHA_EPI")
CATEGORIAS_CERTIFICADOS = ("RUBRICA_INSTRUTOR", "LISTA_PRESENCA", "CERTIFICADO")
CATEGORIAS_ACIDENTES = ("CAT_SP", "RELATORIO_INVESTIGACAO", "EVIDENCIA_ACIDENTE")

# O conjunto que `guardar` aceita e que `ck_anexo_cat` admite — as duas listas
# tem de casar, e um teste compara.
CATEGORIAS = (
    CATEGORIAS_PROCESSO + CATEGORIAS_EPI + CATEGORIAS_CERTIFICADOS + CATEGORIAS_ACIDENTES
)

# Categoria que nasce restrita. O criterio e o mesmo desde a RN-21: o documento
# nomeia pessoa e diz algo sobre a condicao dela no trabalho.
#   FORMULARIO      - o do art. 17 traz declaracao de exposicao
#   FICHA_EPI       - prova de entrega, nominal (IN 15/2022 e NR-6)
#   LISTA_PRESENCA  - assinatura de quem esteve na turma
#   CERTIFICADO     - o PDF nominal; a validacao publica e por chave, nao pelo arquivo
#   CAT_SP e os dois de acidente - evento com a pessoa identificada
# MANUAL_EPI e RUBRICA_INSTRUTOR ficam publicos: manual de fabricante nao tem
# titular, e a rubrica ja sai impressa em todo certificado.
NIVEL_POR_CATEGORIA = {
    "FORMULARIO": "RESTRITO",
    "FICHA_EPI": "RESTRITO",
    "LISTA_PRESENCA": "RESTRITO",
    "CERTIFICADO": "RESTRITO",
    "CAT_SP": "RESTRITO",
    "RELATORIO_INVESTIGACAO": "RESTRITO",
    "EVIDENCIA_ACIDENTE": "RESTRITO",
}


@dataclass
class ResultadoAnexo:
    anexo: Anexo
    duplicado: bool
    tambem_em: int


def digerir(conteudo: bytes) -> str:
    return hashlib.sha256(conteudo).hexdigest()


def caminho_do_blob(sha256: str) -> Path:
    cfg = obter_config()
    base = cfg.caminho(cfg.dir_anexos) / sha256[:2]
    base.mkdir(parents=True, exist_ok=True)
    return base / sha256


def guardar(
    s: Session,
    *,
    entidade: str,
    entidade_id: int,
    nome_original: str,
    conteudo: bytes,
    mime_type: str,
    categoria: str,
    usuario: UsuarioAtual,
    processo_id: int | None = None,
    numero_documento_sei: str | None = None,
    assinado: bool = False,
    origem_migracao: str | None = None,
    origem_ref: str | None = None,
) -> ResultadoAnexo:
    if categoria not in CATEGORIAS:
        raise ValueError(f"categoria inválida: {categoria}")

    sha256 = digerir(conteudo)

    existente = s.execute(
        select(Anexo).where(
            Anexo.entidade == entidade,
            Anexo.entidade_id == entidade_id,
            Anexo.sha256 == sha256,
        )
    ).scalar_one_or_none()
    if existente is not None:
        auditoria.registrar(
            s,
            entidade="anexo",
            entidade_id=existente.id,
            processo_id=processo_id,
            tipo_evento=auditoria.ANEXO_DUPLICADO,
            descricao=(
                f"Arquivo '{nome_original}' ignorado: já anexado como "
                f"'{existente.nome_original}' (mesmo SHA-256)."
            ),
            usuario=usuario,
        )
        return ResultadoAnexo(existente, True, _quantos_processos(s, sha256))

    if categoria == "PARECER_ASSINADO":
        anterior = s.execute(
            select(Anexo).where(
                Anexo.entidade == entidade,
                Anexo.entidade_id == entidade_id,
                Anexo.categoria == "PARECER_ASSINADO",
                Anexo.ativo.is_(True),
            )
        ).scalar_one_or_none()
        if anterior is not None:
            anterior.ativo = False
            s.flush()

    destino = caminho_do_blob(sha256)
    if not destino.exists():
        destino.write_bytes(conteudo)

    anexo = Anexo(
        entidade=entidade,
        entidade_id=entidade_id,
        nome_arquivo=slug_ascii(Path(nome_original).stem)[:200]
        + Path(nome_original).suffix.lower(),
        nome_original=nome_original,
        mime_type=mime_type or "application/octet-stream",
        tamanho_bytes=len(conteudo),
        sha256=sha256,
        storage_key=str(destino.relative_to(obter_config().caminho(obter_config().dir_anexos))),
        categoria=categoria,
        nivel_acesso=NIVEL_POR_CATEGORIA.get(categoria, "PUBLICO"),
        numero_documento_sei=numero_documento_sei,
        assinado=assinado,
        origem_migracao=origem_migracao,
        origem_ref=origem_ref,
        enviado_por=usuario.id,
    )
    s.add(anexo)
    s.flush()

    auditoria.registrar(
        s,
        entidade="anexo",
        entidade_id=anexo.id,
        processo_id=processo_id,
        tipo_evento="ANEXO_ENVIADO",
        descricao=f"'{nome_original}' ({categoria}, {len(conteudo)} bytes).",
        usuario=usuario,
    )
    return ResultadoAnexo(anexo, False, _quantos_processos(s, sha256))


def guardar_arquivo(
    s: Session, caminho: Path, **kwargs
) -> ResultadoAnexo:
    return guardar(s, conteudo=caminho.read_bytes(), nome_original=caminho.name, **kwargs)


def _quantos_processos(s: Session, sha256: str) -> int:
    linhas = s.execute(
        select(Anexo.entidade, Anexo.entidade_id).where(Anexo.sha256 == sha256)
    ).all()
    return len({(e, i) for e, i in linhas})


def listar(s: Session, entidade: str, entidade_id: int) -> list[Anexo]:
    return list(
        s.execute(
            select(Anexo)
            .where(
                Anexo.entidade == entidade,
                Anexo.entidade_id == entidade_id,
                Anexo.ativo.is_(True),
            )
            .order_by(Anexo.enviado_em.desc())
        ).scalars()
    )


def caminho_absoluto(anexo: Anexo) -> Path:
    cfg = obter_config()
    return cfg.caminho(cfg.dir_anexos) / anexo.storage_key


def copiar_para(anexo: Anexo, destino: Path) -> Path:
    destino.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(caminho_absoluto(anexo), destino)
    return destino
