"""Maquina B - o direito concedido (`adicional_vigencia`).

PROPOSTO (parecer favoravel) -> VIGENTE (portaria de concessao + SIAPE)
        -> {SUSPENSO, EM_REAVALIACAO, ALTERADO, CESSADO}

RN-09: no maximo um adicional VIGENTE por servidor (IN 15/2022, art. 4o -
insalubridade, periculosidade, irradiacao ionizante e raios X nao se acumulam).
Concessao sobre adicional vigente exige registro de opcao anexado antes de
cessar o anterior, e as datas ficam encadeadas sem lacuna nem sobreposicao.

RN-21: `motivo_suspensao` e enumerado e JAMAIS registra gestacao/lactacao - o
caso do art. 69, paragrafo unico, da Lei 8.112/90 entra como AFASTAMENTO_LEGAL
com a base legal citada.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import AdicionalVigencia, Anexo, ParecerTecnico
from app.modelos.estados import exigir_transicao_direito
from app.servicos import auditoria, pendencias
from app.servicos.rbac import UsuarioAtual

MOTIVOS_SUSPENSAO: dict[str, str] = {
    "CESSACAO_RISCO": "eliminação das condições que geraram o direito (Lei 8.112/90, art. 68, §2º)",
    "AFASTAMENTO_DO_LOCAL": "afastamento do local de exposição",
    "AFASTAMENTO_LEGAL": "afastamento legal do servidor",
    "DECISAO_ADMINISTRATIVA": "decisão administrativa",
}

# RN-21: a hipotese do art. 69, p.u. entra assim - nunca como gestacao.
BASE_ART69 = "Lei 8.112/90, art. 69, p.ú."


class RegraDoDireito(ValueError):
    """Violacao das regras da maquina B."""


# A conferencia da maquina B mora em `estados.py`, junto das outras: ate a
# fatia 2 de Certificados cada maquina reimplementava o mesmo `destino in
# tabela.get(origem)`, e a terceira copia seria a hora de descobrir que uma
# delas divergiu. `TransicaoInvalida` continua sendo a excecao que sobe.
_exigir_transicao = exigir_transicao_direito


def vigente_do_servidor(s: Session, servidor_id: int) -> AdicionalVigencia | None:
    return s.execute(
        select(AdicionalVigencia).where(
            AdicionalVigencia.servidor_id == servidor_id,
            AdicionalVigencia.estado == "VIGENTE",
        )
    ).scalar_one_or_none()


def tem_registro_de_opcao(s: Session, vigencia: AdicionalVigencia) -> bool:
    """Lei 8.112/90, art. 68, §1º - entre insalubridade e periculosidade a opção
    é do servidor, e ela precisa estar documentada."""
    if vigencia.registro_opcao_anexo_id:
        return s.get(Anexo, vigencia.registro_opcao_anexo_id) is not None
    return False


# ---------------------------------------------------------------------
def propor(
    s: Session, parecer: ParecerTecnico, usuario: UsuarioAtual
) -> AdicionalVigencia:
    """Cria a proposta a partir de um parecer emitido/assinado favorável."""
    usuario.exigir("parecer.emitir")
    if parecer.situacao not in ("EMITIDO", "ASSINADO"):
        raise RegraDoDireito(
            "só um parecer emitido ou assinado propõe direito — este está "
            f"{parecer.situacao}"
        )
    if parecer.tipo_movimento is not None and not parecer.tipo_movimento.gera_direito:
        raise RegraDoDireito(
            f"o movimento '{parecer.tipo_movimento.nome}' não gera direito"
        )

    ja = s.execute(
        select(AdicionalVigencia).where(AdicionalVigencia.parecer_id == parecer.id)
    ).scalar_one_or_none()
    if ja is not None:
        return ja

    principal = next((e for e in parecer.exposicoes if e.principal), None)
    if principal is None or parecer.servidor_id is None:
        raise RegraDoDireito(
            "a proposta exige servidor e exposição principal no parecer"
        )

    vigencia = AdicionalVigencia(
        servidor_id=parecer.servidor_id,
        parecer_id=parecer.id,
        tipo_adicional_id=parecer.tipo_adicional_id,
        percentual_id=principal.percentual_id,
        estado="PROPOSTO",
    )
    s.add(vigencia)
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        processo_id=parecer.processo_id,
        tipo_evento="DIREITO_PROPOSTO",
        descricao=(
            f"Proposta a partir do parecer {parecer.rotulo}: "
            f"{parecer.tipo_adicional.nome if parecer.tipo_adicional else ''} "
            f"{principal.percentual.rotulo}."
        ),
        usuario=usuario,
    )
    return vigencia


def conceder(
    s: Session,
    vigencia: AdicionalVigencia,
    usuario: UsuarioAtual,
    *,
    portaria_concessao: str,
    data_portaria: date,
    data_inicio: date,
) -> AdicionalVigencia:
    """PROPOSTO -> VIGENTE. Faz valer a RN-09 antes de gravar."""
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "VIGENTE")
    if not portaria_concessao.strip():
        raise RegraDoDireito("a concessão exige a portaria de concessão (IN 15/2022, art. 13)")

    anterior = vigente_do_servidor(s, vigencia.servidor_id)
    if anterior is not None and anterior.id != vigencia.id:
        # RN-09: nao acumulam (IN 15/2022, art. 4º). A opcao e do servidor
        # (Lei 8.112/90, art. 68, §1º) e precisa estar anexada.
        if not tem_registro_de_opcao(s, vigencia):
            raise RegraDoDireito(
                "o servidor já tem adicional vigente e os adicionais não se "
                "acumulam (IN 15/2022, art. 4º). Anexe o registro de opção do "
                "servidor antes de conceder o novo (Lei 8.112/90, art. 68, §1º)."
            )
        if data_inicio <= (anterior.data_inicio or date.min):
            raise RegraDoDireito(
                "a data de início do novo adicional precisa ser posterior ao início do anterior"
            )
        # datas encadeadas: sem lacuna e sem sobreposicao
        cessar(
            s,
            anterior,
            usuario,
            data_fim=data_inicio - timedelta(days=1),
            motivo="DECISAO_ADMINISTRATIVA",
            base_legal="Lei 8.112/90, art. 68, §1º — opção do servidor",
        )

    vigencia.estado = "VIGENTE"
    vigencia.portaria_concessao = portaria_concessao.strip()
    vigencia.data_portaria_concessao = data_portaria
    vigencia.data_inicio = data_inicio
    vigencia.data_fim = None
    vigencia.motivo_suspensao = None
    vigencia.base_legal_suspensao = None
    s.flush()

    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_VIGENTE",
        descricao=(
            f"Concedido por {vigencia.portaria_concessao}, com efeito a partir de "
            f"{data_inicio.isoformat()}."
        ),
        usuario=usuario,
    )
    return vigencia


def suspender(
    s: Session,
    vigencia: AdicionalVigencia,
    usuario: UsuarioAtual,
    *,
    motivo: str,
    base_legal: str | None = None,
    data_fim: date | None = None,
) -> AdicionalVigencia:
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "SUSPENSO")
    if motivo not in MOTIVOS_SUSPENSAO:
        raise RegraDoDireito(
            "motivo de suspensão inválido — use um dos enumerados: "
            + ", ".join(MOTIVOS_SUSPENSAO)
        )
    vigencia.estado = "SUSPENSO"
    vigencia.motivo_suspensao = motivo
    vigencia.base_legal_suspensao = base_legal
    vigencia.data_fim = data_fim
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_SUSPENSO",
        descricao=f"{MOTIVOS_SUSPENSAO[motivo]}"
        + (f" — {base_legal}" if base_legal else ""),
        usuario=usuario,
    )
    return vigencia


def suspender_por_afastamento_legal(
    s: Session, vigencia: AdicionalVigencia, usuario: UsuarioAtual
) -> AdicionalVigencia:
    """RN-21 - o caso do art. 69, p.ú. entra assim, sem citar a causa pessoal."""
    return suspender(
        s, vigencia, usuario, motivo="AFASTAMENTO_LEGAL", base_legal=BASE_ART69
    )


def reavaliar(
    s: Session, vigencia: AdicionalVigencia, usuario: UsuarioAtual, motivo: str
) -> AdicionalVigencia:
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "EM_REAVALIACAO")
    vigencia.estado = "EM_REAVALIACAO"
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_EM_REAVALIACAO",
        descricao=motivo,
        usuario=usuario,
    )
    pendencias.abrir(
        s,
        tipo="REAVALIACAO_LAUDO",
        chave=f"reavaliacao:vigencia:{vigencia.id}",
        descricao=f"Reavaliar o adicional do servidor #{vigencia.servidor_id}: {motivo}",
        usuario=usuario,
        parecer_id=vigencia.parecer_id,
    )
    return vigencia


def alterar(
    s: Session,
    vigencia: AdicionalVigencia,
    usuario: UsuarioAtual,
    *,
    percentual_id: int,
    motivo: str,
) -> AdicionalVigencia:
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "ALTERADO")
    anterior = vigencia.percentual_id
    vigencia.estado = "ALTERADO"
    vigencia.percentual_id = percentual_id
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_ALTERADO",
        descricao=motivo,
        campo="percentual_id",
        valor_anterior=anterior,
        valor_novo=percentual_id,
        usuario=usuario,
    )
    return vigencia


def cessar(
    s: Session,
    vigencia: AdicionalVigencia,
    usuario: UsuarioAtual,
    *,
    data_fim: date,
    motivo: str = "CESSACAO_RISCO",
    base_legal: str | None = None,
) -> AdicionalVigencia:
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "CESSADO")
    if vigencia.data_inicio and data_fim < vigencia.data_inicio:
        raise RegraDoDireito("a data de término não pode ser anterior ao início")
    vigencia.estado = "CESSADO"
    vigencia.data_fim = data_fim
    vigencia.motivo_suspensao = motivo if motivo in MOTIVOS_SUSPENSAO else None
    vigencia.base_legal_suspensao = base_legal or (
        "Lei 8.112/90, art. 68, §2º" if motivo == "CESSACAO_RISCO" else None
    )
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_CESSADO",
        descricao=(
            f"Cessado em {data_fim.isoformat()} — "
            f"{MOTIVOS_SUSPENSAO.get(motivo, motivo)}"
        ),
        usuario=usuario,
    )
    return vigencia


def retomar(
    s: Session, vigencia: AdicionalVigencia, usuario: UsuarioAtual, data_inicio: date
) -> AdicionalVigencia:
    """SUSPENSO/ALTERADO/EM_REAVALIACAO -> VIGENTE, respeitando a RN-09."""
    usuario.exigir("parecer.emitir")
    _exigir_transicao(vigencia.estado, "VIGENTE")
    outro = vigente_do_servidor(s, vigencia.servidor_id)
    if outro is not None and outro.id != vigencia.id:
        raise RegraDoDireito(
            "o servidor já tem outro adicional vigente — os adicionais não se "
            "acumulam (IN 15/2022, art. 4º)"
        )
    vigencia.estado = "VIGENTE"
    vigencia.data_inicio = data_inicio
    vigencia.data_fim = None
    vigencia.motivo_suspensao = None
    s.flush()
    auditoria.registrar(
        s,
        entidade="adicional_vigencia",
        entidade_id=vigencia.id,
        tipo_evento="DIREITO_VIGENTE",
        descricao=f"Retomado a partir de {data_inicio.isoformat()}.",
        usuario=usuario,
    )
    return vigencia


def linha_do_tempo(s: Session, servidor_id: int) -> list[AdicionalVigencia]:
    itens = list(
        s.execute(
            select(AdicionalVigencia).where(AdicionalVigencia.servidor_id == servidor_id)
        ).scalars()
    )
    return sorted(itens, key=lambda v: (v.data_inicio or date.min, v.id))


def lacunas_na_linha_do_tempo(s: Session, servidor_id: int) -> list[str]:
    """Datas encadeadas sem lacuna nem sobreposicao (RN-09)."""
    problemas: list[str] = []
    historico = [v for v in linha_do_tempo(s, servidor_id) if v.data_inicio]
    for anterior, seguinte in zip(historico, historico[1:], strict=False):
        if anterior.data_fim is None:
            problemas.append(
                f"o adicional #{anterior.id} não foi encerrado antes de começar o #{seguinte.id}"
            )
            continue
        if seguinte.data_inicio <= anterior.data_fim:
            problemas.append(
                f"sobreposição entre #{anterior.id} e #{seguinte.id}"
            )
        elif (seguinte.data_inicio - anterior.data_fim).days > 1:
            problemas.append(
                f"lacuna de {(seguinte.data_inicio - anterior.data_fim).days - 1} dia(s) "
                f"entre #{anterior.id} e #{seguinte.id}"
            )
    return problemas
