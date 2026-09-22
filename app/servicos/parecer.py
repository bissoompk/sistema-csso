"""Regras do parecer tecnico: validacao, emissao, assinatura e anulacao.

Implementa RN-01 a RN-08, RN-13 a RN-15 e RN-22.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    AdicionalVigencia,
    Exposicao,
    LaudoTecnico,
    ParecerTecnico,
    SetorEmissor,
    agora_utc,
)
from app.servicos import (
    auditoria,
    datas_br,
    documento,
    numeracao,
    pdf as servico_pdf,
    pendencias,
    textos,
)
from app.servicos.documento import ContextoParecer
from app.servicos.rbac import (
    MENSAGEM_RN01,
    PermissaoNegada,
    UsuarioAtual,
    aplicar_escopo,
    pode_subscrever,
)

ANOS_PRESCRICAO = 5

AVISO_PRESCRICAO = (
    "possível prescrição quinquenal (Decreto 20.910/32; Súmula 85/STJ) — "
    "decisão é da PROGEP"
)


class EmissaoBloqueada(ValueError):
    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Emissão bloqueada: " + "; ".join(motivos))


@dataclass
class Validacao:
    faltantes: list[str] = field(default_factory=list)
    bloqueios: list[str] = field(default_factory=list)
    avisos: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.faltantes and not self.bloqueios

    @property
    def motivos(self) -> list[str]:
        return [*self.faltantes, *self.bloqueios]


# ---------------------------------------------------------------------
# A porta de leitura do parecer
# ---------------------------------------------------------------------
def no_escopo(
    s: Session, usuario: UsuarioAtual, parecer_id: int
) -> ParecerTecnico | None:
    """A UNICA leitura de parecer por id que as telas usam. Devolve `None` ou a linha.

    Ate a 1.34.0 as quatro rotas de leitura faziam `s.get(ParecerTecnico, id)`, e
    `anexo_acesso._dono_parecer` chamava aquilo de "folga dele, nao regra a
    copiar". A descricao valia enquanto toda conta era da CSSO: quem podia ler o
    parecer ja podia ler todos. Com `parecer.ver` num perfil que vai para
    milhares de servidores, a mesma linha passa a entregar nome, agente nocivo,
    percentual e fundamentacao de qualquer pessoa — e o `.docx` oficial com o
    nome do terceiro no proprio nome do arquivo.

    `ESCOPO_PROPRIO` filtra por `servidor_id`, e `parecer_tecnico` tem a coluna:
    e exatamente o titular do art. 18, II que o filtro separa dos outros. Para
    quem tem escopo de unidade ou total nada muda — `aplicar_escopo` devolve a
    consulta como veio.

    Mora no servico, e nao na rota, pelo motivo de sempre nesta casa: o download
    do anexo do parecer faz a mesma pergunta, e uma segunda resposta em outro
    arquivo e o que produz a divergencia em que a tela aperta e o arquivo
    continua frouxo.
    """
    return s.execute(
        aplicar_escopo(
            select(ParecerTecnico).where(ParecerTecnico.id == parecer_id),
            usuario,
            ParecerTecnico,
        )
    ).scalar_one_or_none()


# ---------------------------------------------------------------------
# Exposicoes
# ---------------------------------------------------------------------
def classificar_exposicao(
    horas_exposicao: float | None, jornada: float | None
) -> tuple[float | None, str | None]:
    """RN-07 - CALCULADO, nunca digitado (art. 9o da IN 15/2022)."""
    if not horas_exposicao or not jornada:
        return None, None
    percentual = round(float(horas_exposicao) / float(jornada) * 100, 2)
    if percentual >= 100:
        return percentual, "PERMANENTE"
    if percentual >= 50:
        return percentual, "HABITUAL"
    return percentual, "EVENTUAL"


def aplicar_classificacao(
    exposicao: Exposicao, informada: str | None = None
) -> Exposicao:
    """Calcula a classificação a partir das horas; se não houver medição de
    jornada, aceita a classificação informada pelo técnico.

    A IN 15/2022, art. 9º, define a habitualidade por tempo de exposição, então
    a medição manda quando existe. Mas nem todo posto tem jornada medida, e sem
    esta saída o parecer empaca. A origem fica registrada em
    `classificacao_origem` para que a auditoria saiba o que foi medido e o que
    foi julgado — e, se as duas existirem e divergirem, quem vale é a medição.
    """
    percentual, calculada = classificar_exposicao(
        float(exposicao.horas_exposicao_mensais)
        if exposicao.horas_exposicao_mensais is not None
        else None,
        float(exposicao.jornada_mensal_horas)
        if exposicao.jornada_mensal_horas is not None
        else None,
    )
    exposicao.percentual_jornada = percentual

    if calculada is not None:
        exposicao.classificacao_exposicao = calculada
        exposicao.classificacao_origem = "CALCULADA"
    elif informada in ("EVENTUAL", "HABITUAL", "PERMANENTE"):
        exposicao.classificacao_exposicao = informada
        exposicao.classificacao_origem = "INFORMADA"
    else:
        exposicao.classificacao_exposicao = None
        exposicao.classificacao_origem = "CALCULADA"
    return exposicao


def divergencia_de_classificacao(exposicao: Exposicao, informada: str | None) -> str | None:
    """Aviso quando o técnico informa uma classe diferente da medição."""
    if not informada or exposicao.classificacao_origem != "CALCULADA":
        return None
    if exposicao.classificacao_exposicao and informada != exposicao.classificacao_exposicao:
        return (
            f"a jornada medida indica {exposicao.classificacao_exposicao} "
            f"({exposicao.percentual_jornada}%), não {informada} — "
            "prevaleceu a medição (art. 9º)"
        )
    return None


def exposicao_principal(parecer: ParecerTecnico) -> Exposicao | None:
    for exp in parecer.exposicoes:
        if exp.principal:
            return exp
    return parecer.exposicoes[0] if parecer.exposicoes else None


# ---------------------------------------------------------------------
# §7 do desenho de EPI - EPI neutraliza insalubridade; nao cessa periculosidade
# ---------------------------------------------------------------------
EPI_NEUTRALIZA_VALORES = (
    "NAO_AVALIADO",
    "NAO_NEUTRALIZA",
    "NEUTRALIZA_PARCIAL",
    "NEUTRALIZA",
)

# Os dois valores que ALEGAM neutralizacao — os unicos que reduzem ou cessam
# direito, e por isso os unicos que a regra abaixo tranca.
EPI_ALEGA_NEUTRALIZACAO = ("NEUTRALIZA_PARCIAL", "NEUTRALIZA")

# Lista branca, e nao lista negra, porque o catalogo de `tipo_adicional` e
# editavel: com lista negra, um codigo novo cadastrado amanha nasceria
# neutralizavel por omissao, e a omissao aqui produz decisao ilegal em serie.
#
# Os dois radiologicos ficam de fora DE PROPOSITO, e nao por esquecimento:
# irradiacao ionizante e raios X sao risco de acidente — o §7.1 os nomeia junto
# com inflamavel, explosivo e energia eletrica —, e ali o EPI reduz a
# consequencia, nao a existencia do risco. Blindagem e avental plumbifero
# diminuem a dose; nao fazem a fonte deixar de existir.
CODIGOS_NEUTRALIZAVEIS_POR_EPI = frozenset({"INSALUBRIDADE"})

EPI_NEUTRALIZACAO_AVALIADA = "EPI_NEUTRALIZACAO_AVALIADA"


class AvaliacaoDeEpiRecusada(ValueError):
    """A recusa do §7.1, com o motivo por escrito para a tela mostrar."""

    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Avaliação de EPI recusada: " + "; ".join(motivos))


def _codigos_de_adicional(parecer: ParecerTecnico, exposicao: Exposicao) -> set[str]:
    """Todos os tipos de adicional que esta exposição alimenta.

    São dois caminhos e os dois contam: o percentual da exposição aponta para um
    `tipo_adicional`, e o parecer aponta para outro (a RN-08 exige que sejam o
    mesmo, mas ela é conferida na emissão, e esta função roda antes disso, no
    rascunho). Basta um deles não ser de insalubridade para a alegação cair —
    recusar por engano custa um clique, permitir por engano custa o adicional de
    alguém.
    """
    codigos: set[str] = set()
    percentual = exposicao.percentual
    if percentual is not None and percentual.tipo_adicional is not None:
        codigos.add(percentual.tipo_adicional.codigo)
    if parecer.tipo_adicional is not None:
        codigos.add(parecer.tipo_adicional.codigo)
    return codigos


def epi_pode_neutralizar(parecer: ParecerTecnico, exposicao: Exposicao) -> bool:
    """A regra do §7.1, isolada para a tela poder perguntar antes de oferecer.

    Sem codigo nenhum resolvido (rascunho recém-criado, sem percentual) a
    resposta é **não**: "não sei qual é o adicional" não é "pode neutralizar".
    """
    codigos = _codigos_de_adicional(parecer, exposicao)
    return bool(codigos) and codigos <= CODIGOS_NEUTRALIZAVEIS_POR_EPI


def registrar_avaliacao_de_epi(
    s: Session,
    parecer: ParecerTecnico,
    exposicao: Exposicao,
    usuario: UsuarioAtual,
    *,
    valor: str,
    justificativa: str = "",
    quando: date | None = None,
) -> Exposicao:
    """Grava se o EPI neutraliza o agente **desta** exposição — e recusa o resto.

    A distinção que esta função existe para impor, e que uma integração ingênua
    erra: **o EPI neutraliza insalubridade; o EPI não cessa periculosidade.**

    A insalubridade é exposição gradual a um agente que o equipamento pode
    barrar abaixo do limite de tolerância — a máscara com filtro certo faz a
    concentração inalada cair, e sem exposição efetiva não há o que indenizar.
    A periculosidade é risco de acidente: inflamável, explosivo, energia
    elétrica, radiação ionizante. Ali o EPI reduz a **consequência** do sinistro
    — a luva isolante evita a queimadura —, não a **existência** do risco: o
    circuito continua energizado e o tanque continua cheio. Um sistema que
    deixasse o EPI cessar periculosidade produziria decisão ilegal em série, uma
    por parecer, todas com aparência de fundamentadas.

    Por isso a recusa é dura e vem antes de qualquer gravação. E por isso ela
    mora aqui, e não numa CHECK: o código do adicional está a dois JOINs da
    `exposicao`, e CHECK de SQLite não faz subconsulta.

    Alegar neutralização também exige `pode_subscrever` (RN-01): é o ato técnico
    que reduz ou cessa o direito, e o §7.2 diz quem o pratica — quem subscreve
    laudo e assina parecer. `NAO_AVALIADO` e `NAO_NEUTRALIZA` não exigem: eles
    não tiram nada de ninguém, e travá-los faria a CSSO ficar sem como registrar
    que olhou e não encontrou neutralização.
    """
    usuario.exigir("parecer.editar")
    quando = quando or date.today()
    motivos: list[str] = []

    if valor not in EPI_NEUTRALIZA_VALORES:
        raise AvaliacaoDeEpiRecusada(
            [f"'{valor}' não é um resultado de avaliação de EPI"]
        )
    if exposicao.parecer_id != parecer.id:
        raise AvaliacaoDeEpiRecusada(["a exposição não é deste parecer"])
    # RN-14/RN-15: parecer emitido é documento, não rascunho. Mudar o fundamento
    # depois da emissão é reescrever o que alguém já assinou — corrige-se com
    # versão nova, como todo o resto.
    if parecer.situacao in ("EMITIDO", "ASSINADO", "ANULADO"):
        raise AvaliacaoDeEpiRecusada(
            [
                f"o parecer {parecer.rotulo} está {parecer.situacao.lower()}: "
                "a avaliação de EPI de um parecer emitido só muda em versão nova"
            ]
        )

    # RN-30/RN-21: texto livre passa pelo filtro antes de qualquer gravação
    limpa = textos.exigir_texto_limpo(
        (justificativa or "").strip(), campo="justificativa da avaliação de EPI"
    )

    alega = valor in EPI_ALEGA_NEUTRALIZACAO
    if alega:
        if not epi_pode_neutralizar(parecer, exposicao):
            codigos = ", ".join(sorted(_codigos_de_adicional(parecer, exposicao))) or "—"
            motivos.append(
                f"EPI não cessa periculosidade. Este parecer trata de {codigos}, "
                "e o equipamento reduz a consequência do acidente, não a "
                "existência do risco — o adicional continua devido. A "
                "neutralização por EPI só se aplica a insalubridade "
                "(IN SGP/SEDGG/ME 15/2022; Lei 8.112/90, art. 68, §2º)"
            )
        if not limpa:
            motivos.append(
                "alegar neutralização exige a justificativa técnica por escrito: "
                "qual EPI, com que CA vigente na data da avaliação, e por que ele "
                "leva o agente abaixo do limite de tolerância"
            )
        if not pode_subscrever(s, usuario):
            motivos.append(MENSAGEM_RN01)
    if motivos:
        raise AvaliacaoDeEpiRecusada(motivos)

    anterior = exposicao.epi_neutraliza
    exposicao.epi_neutraliza = valor
    exposicao.justificativa_epi = limpa or None
    # `NAO_AVALIADO` não tem data: ele diz exatamente que ninguém avaliou, e
    # carimbar uma data nele faria a ausência de avaliação parecer uma.
    exposicao.epi_avaliado_em = None if valor == "NAO_AVALIADO" else quando
    s.flush()

    auditoria.registrar(
        s,
        entidade="exposicao",
        entidade_id=exposicao.id,
        processo_id=parecer.processo_id,
        tipo_evento=EPI_NEUTRALIZACAO_AVALIADA,
        descricao=(
            f"{exposicao.agente_nocivo.descricao}: EPI {valor.replace('_', ' ').lower()}"
            + (f" — {limpa}" if limpa else "")
        ),
        campo="epi_neutraliza",
        valor_anterior=anterior,
        valor_novo=valor,
        comentario=limpa or None,
        usuario=usuario,
    )
    s.flush()
    return exposicao


def congelar_epi(s: Session, parecer: ParecerTecnico) -> dict:
    """A prova do §7.2: quais fichas o engenheiro olhou, com que CA e que data.

    Vai para `contexto_congelado['epi']` na emissão, e isso dá três coisas de
    graça: zero acoplamento de esquema entre os módulos (nenhuma FK atravessa),
    valor probatório completo (o parecer carrega a evidência que sustentou a
    conclusão) e **imutabilidade** — uma entrega feita depois da emissão não
    reescreve retroativamente o fundamento de um parecer assinado.

    A data de referência das fichas é a da emissão, que é o dia em que o
    documento passou a afirmar o que afirma. Cada exposição leva junto o próprio
    `epi_avaliado_em`, que pode ser anterior: a visita ao posto costuma vir
    semanas antes da assinatura, e a ficha guarda as duas datas em vez de
    escolher uma e apagar a outra.

    O bloco não repete nome nem SIAPE do servidor: eles já estão no congelado do
    documento, e duplicar dado nominal é aumentar a superfície sem acrescentar
    prova (RN-19).
    """
    from app.servicos import epi_ficha

    quando = parecer.data_emissao or date.today()
    fichas = (
        epi_ficha.entregas_ate(s, parecer.servidor_id, quando)
        if parecer.servidor_id
        else []
    )
    return {
        "referencia": quando.isoformat(),
        "fichas": [f.congelar() for f in fichas],
        "exposicoes": [
            {
                "exposicao": e.id,
                "agente": e.agente_nocivo.descricao,
                "epi_neutraliza": e.epi_neutraliza,
                "justificativa": e.justificativa_epi,
                "avaliado_em": (
                    e.epi_avaliado_em.isoformat() if e.epi_avaliado_em else None
                ),
            }
            for e in parecer.exposicoes
        ],
    }


# ---------------------------------------------------------------------
# Validacao (RN-04 ... RN-08, RN-22)
# ---------------------------------------------------------------------
def validar(s: Session, parecer: ParecerTecnico, hoje: date | None = None) -> Validacao:
    hoje = hoje or date.today()
    v = Validacao()

    obrigatorios = {
        "servidor_id": "servidor",
        "unidade_uorg_id": "unidade / UORG",
        "processo_id": "processo (NUP)",
        "laudo_id": "laudo técnico",
        "portaria_id": "portaria de localização",
        "tipo_marco_id": "marco inicial",
        "data_marco_inicial": "data do marco inicial",
        "texto_recomendacao": "recomendação",
        "signatario_id": "signatário",
        "destinatario_id": "autoridade destinatária",
        "tipo_adicional_id": "tipo de adicional",
        "tipo_movimento_id": "tipo de movimento",
    }
    for campo, rotulo in obrigatorios.items():
        if getattr(parecer, campo) is None:
            v.faltantes.append(rotulo)

    if parecer.servidor is not None and not parecer.servidor.siape:
        v.faltantes.append("matrícula SIAPE")
    if not parecer.postos:
        v.faltantes.append("posto de trabalho")

    principal = exposicao_principal(parecer)
    if principal is None:
        v.faltantes.append("exposição (agente nocivo, percentual, fundamentação)")
    elif not any(e.principal for e in parecer.exposicoes):
        v.bloqueios.append("marque qual exposição é a principal")

    # SS9 - percentuais divergentes
    percentuais = {e.percentual_id for e in parecer.exposicoes}
    if len(percentuais) > 1:
        v.bloqueios.append(
            "exposições com percentuais divergentes: escolha a principal"
        )

    # RN-08 - percentual compativel com o tipo de adicional do parecer
    if principal is not None and parecer.tipo_adicional_id is not None:
        if principal.percentual.tipo_adicional_id != parecer.tipo_adicional_id:
            v.bloqueios.append(
                "o percentual escolhido pertence a outro tipo de adicional"
            )

    # RN-06 - agente que exige avaliacao quantitativa
    for exp in parecer.exposicoes:
        if exp.agente_nocivo.exige_reavaliacao_quantitativa and not parecer.texto_reavaliacao:
            v.bloqueios.append(
                f"o agente '{exp.agente_nocivo.descricao}' exige avaliação quantitativa: "
                "preencha o texto de reavaliação e abra a pendência"
            )
            break

    # RN-07 - exposicao eventual
    for exp in parecer.exposicoes:
        if exp.classificacao_exposicao == "EVENTUAL" and not exp.excecao_art9_par_unico:
            v.bloqueios.append(
                "exposição EVENTUAL sem a exceção do art. 9º, parágrafo único: "
                "enquadre um inciso do art. 11 e mova para INDEFERIDO_TECNICAMENTE"
            )
            break

    v.avisos.extend(_validar_marco(parecer, hoje))
    v.bloqueios.extend(_bloqueios_marco(parecer))
    v.bloqueios.extend(_validar_radiologico(parecer))

    # RN-13
    if (
        parecer.tipo_movimento is not None
        and parecer.tipo_movimento.codigo == "REVISAO"
        and parecer.parecer_anterior_id is None
    ):
        v.bloqueios.append("movimento 'revisão' exige o parecer anterior vinculado")

    return v


def _bloqueios_marco(parecer: ParecerTecnico) -> list[str]:
    problemas: list[str] = []
    if parecer.data_marco_inicial is None or parecer.tipo_marco is None:
        return problemas

    # RN-05 - marco derivado da portaria
    if parecer.tipo_marco.codigo == "PORTARIA_LOCALIZACAO":
        if parecer.portaria is None:
            problemas.append("marco 'portaria de localização' sem portaria vinculada")
        elif parecer.data_marco_inicial != parecer.portaria.data_publicacao:
            problemas.append(
                "a data do marco inicial diverge da data de publicação da portaria "
                f"({datas_br.numerica(parecer.portaria.data_publicacao)})"
            )
    elif not parecer.justificativa_marco:
        problemas.append(
            "marco diferente da portaria de localização exige justificativa"
        )

    # o marco nunca pode ser anterior a emissao do laudo
    if parecer.laudo is not None and parecer.laudo.data_emissao is not None:
        if parecer.data_marco_inicial < parecer.laudo.data_emissao:
            problemas.append(
                "não há laudo que caracterize a exposição nesta data "
                f"(laudo emitido em {datas_br.numerica(parecer.laudo.data_emissao)})"
            )
    return problemas


def _validar_marco(parecer: ParecerTecnico, hoje: date) -> list[str]:
    """Alerta NAO bloqueante de prescricao quinquenal."""
    if parecer.data_marco_inicial is None:
        return []
    referencia = parecer.data_emissao or hoje
    if datas_br.meses_entre(parecer.data_marco_inicial, referencia) > ANOS_PRESCRICAO * 12:
        return [AVISO_PRESCRICAO]
    return []


def _validar_radiologico(parecer: ParecerTecnico) -> list[str]:
    """RN-22 - IN 15/2022, arts. 7o e 8o."""
    if parecer.tipo_adicional is None:
        return []
    codigo = parecer.tipo_adicional.codigo
    faltas: list[str] = []
    if codigo == "RAIOS_X":
        if not parecer.horas_semanais_fonte or float(parecer.horas_semanais_fonte) < 12:
            faltas.append(
                "raios X exige jornada de no mínimo 12 horas semanais junto à fonte "
                "(IN 15/2022, art. 8º, I)"
            )
        if parecer.portaria_designacao_dirigente_id is None:
            faltas.append(
                "raios X exige portaria de designação do dirigente (art. 8º, II)"
            )
        if parecer.area_radiologica != "CONTROLADA":
            faltas.append("raios X exige área radiológica CONTROLADA (art. 8º, III)")
    elif codigo == "IRRADIACAO_IONIZANTE":
        if parecer.area_radiologica not in ("CONTROLADA", "SUPERVISIONADA"):
            faltas.append(
                "irradiação ionizante exige área CONTROLADA ou SUPERVISIONADA e "
                "registro do credenciamento CNEN (art. 7º)"
            )
    return faltas


# ---------------------------------------------------------------------
# Contexto do documento
# ---------------------------------------------------------------------
def setor_emissor_vigente(s: Session, quando: date) -> SetorEmissor | None:
    candidatos = s.execute(select(SetorEmissor)).scalars().all()
    vigentes = [
        se
        for se in candidatos
        if se.vigencia_inicio <= quando and (se.vigencia_fim is None or se.vigencia_fim >= quando)
    ]
    if not vigentes:
        return None
    return max(vigentes, key=lambda se: se.vigencia_inicio)


def montar_contexto(
    s: Session, parecer: ParecerTecnico, quando: date | None = None
) -> ContextoParecer:
    # RN-15: parecer emitido reimprime do congelado, não do catálogo de hoje.
    # Sem isto, renomear um agente nocivo mudaria um documento já assinado.
    if parecer.contexto_congelado:
        return ContextoParecer.descongelar(parecer.contexto_congelado)

    quando = parecer.data_emissao or quando or date.today()

    setor = parecer.setor_emissor or setor_emissor_vigente(s, quando)
    if parecer.sigla_emissora_snapshot:
        # RN-15 - reimpressao usa o congelado
        sigla = parecer.sigla_emissora_snapshot
        nome_emissor = parecer.nome_emissor_snapshot or ""
        endereco = parecer.endereco_emissor_snapshot or ""
        telefone = parecer.telefone_emissor_snapshot or ""
    else:
        sigla = setor.sigla_composta if setor else ""
        nome_emissor = setor.nome_extenso if setor else ""
        endereco = setor.endereco if setor else ""
        telefone = setor.telefone if setor else ""

    principal = exposicao_principal(parecer)
    agentes: list[str] = []
    if principal is not None:
        agentes.append(principal.agente_nocivo.descricao)
    agentes.extend(
        e.agente_nocivo.descricao for e in parecer.exposicoes if e is not principal
    )

    postos = [
        pp.posto.nome for pp in sorted(parecer.postos, key=lambda p: (p.ordem, p.posto_trabalho_id))
    ]

    servidor = parecer.servidor
    # A cidade e a do SETOR EMISSOR, nao a do campus avaliado: o parecer 2/2026,
    # da FAMMUC (Teofilo Otoni), foi datado em Diamantina, onde a CSSO funciona.
    cidade = setor.cidade if setor else "Diamantina"

    return ContextoParecer(
        numero_parecer=parecer.numero,
        ano=parecer.ano,
        data_emissao=quando,
        cidade=cidade,
        sigla_unidade_emissora=sigla,
        nome_extenso_emissor=nome_emissor,
        endereco_emissor=endereco,
        telefone_emissor=telefone,
        laudo_de=parecer.tipo_movimento.nome if parecer.tipo_movimento else "",
        unidade=parecer.unidade.nome_extenso if parecer.unidade else "",
        postos=postos,
        # UORG é campo próprio; só cai na Unidade quando não houver UORG distinta
        uorg_bruto=(parecer.uorg or parecer.unidade).uorg_bruto
        if (parecer.uorg or parecer.unidade)
        else "",
        tipo_laudo=parecer.tipo_adicional.nome if parecer.tipo_adicional else "",
        numero_processo_sei=parecer.processo.nup if parecer.processo else "",
        nome_servidor=servidor.nome if servidor else "",
        matricula=servidor.siape if servidor else "",
        cargo=parecer.cargo_snapshot
        or (servidor.cargo.nome if servidor and servidor.cargo else ""),
        funcao=parecer.funcao_snapshot or (servidor.funcao if servidor else "") or "",
        laudo_siape=parecer.laudo.numero_siape if parecer.laudo else "",
        agentes_nocivos=agentes,
        tipo_risco=principal.agente_nocivo.tipo_risco.nome if principal else "",
        percentual_aplicavel=principal.percentual.rotulo if principal else "",
        portaria_localizacao=parecer.portaria.texto_original if parecer.portaria else "",
        fundamentacao_legal=principal.fundamentacao.texto if principal else "",
        alteracao=parecer.texto_alteracao,
        recomendacao_tecnica=parecer.texto_recomendacao or "",
        reavaliacao=parecer.texto_reavaliacao,
        pro_reitor=parecer.destinatario.nome if parecer.destinatario else "",
        pro_reitor_cargo=parecer.destinatario.cargo if parecer.destinatario else "",
        tratamento_destinatario=parecer.destinatario.tratamento if parecer.destinatario else "",
        assinante_nome=parecer.signatario.nome if parecer.signatario else "",
        assinante_matricula=parecer.signatario.siape if parecer.signatario else "",
        assinante_titulo=parecer.signatario.titulo_assinatura if parecer.signatario else "",
    )


# ---------------------------------------------------------------------
# Recomendacao a partir do catalogo
# ---------------------------------------------------------------------
def montar_recomendacao(
    codigo_texto: str,
    tipo_adicional_recomendacao: str,
    tipo_risco: str,
    data_marco: date,
    template: str,
) -> str:
    valores = {
        "tipo_adicional_recomendacao": tipo_adicional_recomendacao,
        "tipo_risco": tipo_risco,
        "data_marco_extenso": datas_br.por_extenso(data_marco),
        "data_marco_extenso_capitalizado": datas_br.por_extenso_capitalizado(data_marco),
        "data_marco_numerica": datas_br.numerica(data_marco),
    }
    texto = template
    for chave, valor in valores.items():
        texto = texto.replace("{{" + chave + "}}", valor)
    _ = codigo_texto
    return texto


# ---------------------------------------------------------------------
# Emissao
# ---------------------------------------------------------------------
@dataclass
class ResultadoEmissao:
    parecer: ParecerTecnico
    docx: object
    pdf: object | None
    aviso_pdf: str | None
    avisos: list[str]


def emitir(
    s: Session,
    parecer: ParecerTecnico,
    usuario: UsuarioAtual,
    *,
    data_emissao: date | None = None,
    gerar_pdf: bool = True,
) -> ResultadoEmissao:
    usuario.exigir("parecer.emitir")

    if parecer.situacao in ("EMITIDO", "ASSINADO"):
        raise EmissaoBloqueada(["parecer já emitido — RN-14: crie uma nova versão"])

    hoje = data_emissao or date.today()
    # A data da emissao vale para as checagens abaixo, mas so e GRAVADA depois
    # que todas passam. Carimba-la antes contaminava o rascunho recusado: a rota
    # devolve o editor com o erro (retorno normal, que commita) e a data ficava
    # no banco alimentando validar(), montar_contexto() e a propria checagem de
    # vigencia do signatario nas tentativas seguintes. O evento
    # ASSINATURA_NEGADA, esse sim, e o registro da recusa e continua sendo
    # gravado de proposito - a rota commita antes de relancar a excecao.
    data_efetiva = parecer.data_emissao or hoje

    # RN-01 - o signatario precisa de habilitacao vigente na data
    if parecer.signatario is None or not parecer.signatario.vigente_em(data_efetiva):
        auditoria.registrar(
            s,
            entidade="parecer_tecnico",
            entidade_id=parecer.id or 0,
            tipo_evento=auditoria.ASSINATURA_NEGADA,
            descricao=MENSAGEM_RN01,
            usuario=usuario,
            processo_id=parecer.processo_id,
        )
        raise PermissaoNegada("parecer.assinar", MENSAGEM_RN01)

    validacao = validar(s, parecer, data_efetiva)
    if not validacao.ok:
        raise EmissaoBloqueada(validacao.motivos)

    parecer.data_emissao = data_efetiva

    # numero so e consumido agora (RN-03)
    if parecer.situacao == "RASCUNHO" and not parecer.numero:
        parecer.numero = numeracao.proximo_numero_parecer(s, parecer.ano)

    # RN-15 - congelar
    setor = parecer.setor_emissor or setor_emissor_vigente(s, parecer.data_emissao)
    if setor is not None:
        parecer.setor_emissor_id = setor.id
        parecer.sigla_emissora_snapshot = setor.sigla_composta
        parecer.nome_emissor_snapshot = setor.nome_extenso
        parecer.endereco_emissor_snapshot = setor.endereco
        parecer.telefone_emissor_snapshot = setor.telefone
    if parecer.servidor is not None:
        parecer.cargo_snapshot = parecer.cargo_snapshot or (
            parecer.servidor.cargo.nome if parecer.servidor.cargo else None
        )
        parecer.funcao_snapshot = parecer.funcao_snapshot or parecer.servidor.funcao

    contexto = montar_contexto(s, parecer)
    # congela ANTES de renderizar: o que sai no papel é o que fica guardado
    congelado = contexto.congelar()
    # §7.2: a prova de EPI entra sob a chave "epi", ao lado — e não dentro — do
    # que o documento renderiza. `ContextoParecer.descongelar` lê só os campos
    # de `CAMPOS_CONGELADOS`, então a chave nova não muda o texto de nenhum
    # parecer já emitido nem entra no modelo .docx. Ela é evidência anexa: o
    # documento afirma, e o congelado guarda em cima de quê.
    congelado["epi"] = congelar_epi(s, parecer)
    parecer.contexto_congelado = congelado
    destino = documento.caminho_saida(
        parecer.numero,
        parecer.ano,
        contexto.sigla_unidade_emissora or "CSSO",
        contexto.nome_servidor,
    )
    modelo = parecer.modelo_arquivo or documento.MODELO_V1
    info = documento.renderizar(contexto, destino, modelo)

    parecer.modelo_arquivo = info["modelo_arquivo"]
    parecer.modelo_sha256 = info["modelo_sha256"]
    parecer.hash_conteudo = info["hash_conteudo"]
    parecer.situacao = "EMITIDO"
    parecer.emitido_por = usuario.id
    parecer.emitido_em = parecer.emitido_em or agora_utc()

    auditoria.registrar(
        s,
        entidade="parecer_tecnico",
        entidade_id=parecer.id,
        tipo_evento=auditoria.PARECER_EMITIDO,
        descricao=f"Parecer {parecer.rotulo} emitido ({info['modelo_arquivo']}).",
        usuario=usuario,
        processo_id=parecer.processo_id,
        valor_novo={
            "numero": parecer.numero,
            "ano": parecer.ano,
            "hash_conteudo": parecer.hash_conteudo,
        },
    )
    for aviso in validacao.avisos:
        auditoria.registrar(
            s,
            entidade="parecer_tecnico",
            entidade_id=parecer.id,
            tipo_evento=auditoria.PRESCRICAO_QUINQUENAL_ALERTADA
            if aviso == AVISO_PRESCRICAO
            else "AVISO",
            descricao=aviso,
            usuario=usuario,
            processo_id=parecer.processo_id,
        )
    for exp in parecer.exposicoes:
        if exp.excecao_art9_par_unico:
            auditoria.registrar(
                s,
                entidade="exposicao",
                entidade_id=exp.id,
                tipo_evento=auditoria.EXCECAO_ART9_APLICADA,
                descricao=exp.justificativa_art9 or "",
                usuario=usuario,
                processo_id=parecer.processo_id,
            )
        # RN-06: o texto de reavaliacao nao basta - a avaliacao quantitativa
        # vira tarefa com dono e prazo.
        if exp.agente_nocivo.exige_reavaliacao_quantitativa:
            pendencias.abrir(
                s,
                tipo="AVALIACAO_QUANTITATIVA",
                chave=f"quantitativa:exposicao:{exp.id}",
                descricao=(
                    f"Avaliar quantitativamente '{exp.agente_nocivo.descricao}' e "
                    f"elaborar novo laudo (parecer {parecer.rotulo})."
                ),
                usuario=usuario,
                processo_id=parecer.processo_id,
                parecer_id=parecer.id,
            )

    pendencias.abrir(
        s,
        tipo="INCLUIR_NO_SEI",
        chave=f"sei:parecer:{parecer.id}",
        descricao=(
            f"Incluir o parecer {parecer.rotulo} no SEI e registrar o nº do "
            "documento e o link permanente."
        ),
        usuario=usuario,
        processo_id=parecer.processo_id,
        parecer_id=parecer.id,
    )

    s.flush()

    # A conversao e a ULTIMA coisa, e depois do commit. Ate esta linha tudo o que
    # e prova ja esta escrito: o numero (RN-03), o contexto congelado (RN-15), o
    # .docx no disco com o `hash_conteudo` dele, e a cadeia de auditoria. O PDF e
    # renderizacao derivada desse conjunto — nao entra em hash nenhum e se refaz
    # a qualquer momento em `GET /pareceres/{id}/pdf`, a partir do MESMO
    # congelado. Por isso ele pode, e deve, esperar do lado de fora da transacao.
    resultado_pdf = None
    aviso_pdf = None
    if gerar_pdf:
        resultado_pdf, aviso_pdf = _pdf_depois_da_emissao(s, parecer, usuario, destino)

    return ResultadoEmissao(parecer, destino, resultado_pdf, aviso_pdf, validacao.avisos)


def _pdf_depois_da_emissao(
    s: Session, parecer: ParecerTecnico, usuario: UsuarioAtual, destino: Path
) -> tuple[Path | None, str | None]:
    """Converte com o lock solto e trata o caso em que a conversao falha DEPOIS.

    **O caso dificil, e a resposta.** Comitar antes de converter cria uma janela
    em que o parecer existe e o PDF nao. Desfazer nao e resposta: a numeracao e
    sequencial e nao volta (RN-03), o `rollback` abriria buraco na sequencia e
    apagaria eventos ja encadeados. Ignorar tambem nao e — foi o `except` mudo
    que escondeu o sino por 21 versoes.

    A resposta e que **essa janela ja era o estado normal do sistema**: numa
    maquina sem LibreOffice, toda emissao sempre terminou assim — documento
    emitido, PDF nenhum, `.docx` entregue com `AVISO_SEM_PDF`. O que a conversao
    adiada muda nao e o estado possivel, e sim QUANDO ele aparece. E a saida dele
    ja existe e continua existindo: `GET /pareceres/{id}/pdf` reconverte a partir
    do congelado, quantas vezes for preciso, sem consumir numero nenhum.

    O que se acrescenta e a recusa ao silencio: quando a maquina TEM LibreOffice
    e mesmo assim nao converteu, isso e incidente, e vai para a cadeia — na
    transacao nova, curta, que quem chamou comita junto com o resto.
    """
    conversao = servico_pdf.converter_fora_da_transacao(
        s, destino, destino.with_suffix(".pdf")
    )
    if not conversao.gerado and not conversao.indisponivel:
        auditoria.registrar(
            s,
            entidade="parecer_tecnico",
            entidade_id=parecer.id,
            tipo_evento=auditoria.PDF_NAO_GERADO,
            descricao=(
                f"Parecer {parecer.rotulo} emitido, mas o PDF não foi gerado. "
                f"O .docx está em {destino.name} e vale como o documento; "
                f"reimprima o PDF pela ficha do parecer. Detalhe: {conversao.aviso}"
            ),
            usuario=usuario,
            processo_id=parecer.processo_id,
        )
    return conversao.caminho, conversao.aviso


def assinar(s: Session, parecer: ParecerTecnico, usuario: UsuarioAtual) -> ParecerTecnico:
    """RN-01: permissao E habilitacao vigente. Sem os dois, 403 duro."""
    if not usuario.pode("parecer.assinar") or not pode_subscrever(s, usuario, date.today()):
        auditoria.registrar(
            s,
            entidade="parecer_tecnico",
            entidade_id=parecer.id,
            tipo_evento=auditoria.ASSINATURA_NEGADA,
            descricao=MENSAGEM_RN01,
            usuario=usuario,
            processo_id=parecer.processo_id,
        )
        raise PermissaoNegada("parecer.assinar", MENSAGEM_RN01)

    if parecer.situacao != "EMITIDO":
        raise EmissaoBloqueada(["só um parecer EMITIDO pode ser marcado como assinado"])

    parecer.situacao = "ASSINADO"
    parecer.assinado_em = agora_utc()
    auditoria.registrar(
        s,
        entidade="parecer_tecnico",
        entidade_id=parecer.id,
        tipo_evento="PARECER_ASSINADO",
        descricao=f"Parecer {parecer.rotulo} marcado como assinado.",
        usuario=usuario,
        processo_id=parecer.processo_id,
    )
    s.flush()
    return parecer


def anular(
    s: Session, parecer: ParecerTecnico, usuario: UsuarioAtual, motivo: str
) -> ParecerTecnico:
    usuario.exigir("parecer.anular")
    if not motivo or not motivo.strip():
        raise ValueError("anulação exige motivo")
    parecer.situacao = "ANULADO"
    parecer.motivo_anulacao = motivo.strip()
    auditoria.registrar(
        s,
        entidade="parecer_tecnico",
        entidade_id=parecer.id,
        tipo_evento=auditoria.PARECER_ANULADO,
        descricao=f"Parecer {parecer.rotulo} anulado: {motivo.strip()}",
        usuario=usuario,
        processo_id=parecer.processo_id,
    )
    s.flush()
    return parecer


# ---------------------------------------------------------------------
# RN-11 - cascata de reavaliacao
# ---------------------------------------------------------------------
def marcar_laudo_superado(
    s: Session,
    laudo: LaudoTecnico,
    usuario: UsuarioAtual,
    motivo: str,
    substituto: LaudoTecnico | None = None,
) -> list[ParecerTecnico]:
    usuario.exigir("laudo.criar")
    laudo.status = "SUPERADO"
    laudo.motivo_ultima_conferencia = motivo
    laudo.data_ultima_conferencia = date.today()
    if substituto is not None:
        laudo.substituido_por_id = substituto.id

    derivados = list(
        s.execute(select(ParecerTecnico).where(ParecerTecnico.laudo_id == laudo.id))
        .scalars()
        .all()
    )
    for parecer in derivados:
        vigencias = s.execute(
            select(AdicionalVigencia).where(AdicionalVigencia.parecer_id == parecer.id)
        ).scalars()
        for vigencia in vigencias:
            if vigencia.estado in ("VIGENTE", "ALTERADO", "SUSPENSO"):
                vigencia.estado = "EM_REAVALIACAO"
        pendencias.abrir(
            s,
            tipo="REAVALIACAO_LAUDO",
            chave=f"reavaliacao:parecer:{parecer.id}:laudo:{laudo.id}",
            descricao=(
                f"Laudo {laudo.numero_siape} superado ({motivo}) — reavaliar o "
                f"parecer {parecer.rotulo}."
            ),
            usuario=usuario,
            processo_id=parecer.processo_id,
            parecer_id=parecer.id,
            laudo_id=laudo.id,
        )

    auditoria.registrar(
        s,
        entidade="laudo_tecnico",
        entidade_id=laudo.id,
        tipo_evento=auditoria.LAUDO_SUPERADO,
        descricao=(
            f"Laudo {laudo.numero_siape} marcado como superado ({motivo}). "
            f"{len(derivados)} parecer(es) derivado(s) em reavaliação."
        ),
        usuario=usuario,
    )
    s.flush()
    return derivados
