"""A ficha de EPI: entrega, congelamento, comprovante e estorno.

Fatia 2 do módulo Gestão de EPI, e a peça central dele — a ficha é a prova legal
de que o equipamento foi entregue. Aqui ficam as **regras**; o contexto e a
impressão do comprovante moram em `comprovante_epi.py`, e o saldo do lote em
`epi_estoque.py`. É a mesma divisão de `parecer.py` / `documento.py` e de
`emissao_certificado.py` / `certificado.py`.

Três coisas decidem se essa ficha vale como prova, e cada uma tem um mecanismo
próprio neste arquivo:

1. **O que se congela é o que valia no ato.** Nome do EPI, CA, validade do CA,
   norma, fabricante, lote, e a identificação da pessoa. `montar_contexto` tem
   uma porta só para registro gravado, e ela lê `contexto_congelado` — nunca o
   catálogo de hoje. Renomear o item amanhã não reescreve a entrega de ontem. É
   a RN-15, a mesma do parecer e do certificado.
2. **CA vencido não se entrega (RN-25).** E o CA que vale é o **do lote**, não o
   do catálogo: um lote de 2023 pode estar vencido enquanto o catálogo já aponta
   para o CA renovado. Pela NR-6 o Certificado de Aprovação é o que constitui o
   equipamento como EPI — entregar um vencido significa que a instituição não
   entregou proteção nenhuma.
3. **A ficha é append-only, por trigger (RN-31).** Correção é `ESTORNO`: linha
   nova, com motivo, apontando para a errada — que continua lá, visível e
   marcada. É assim que documento de valor probatório se corrige.

E uma quarta, que vem da decisão 8 (18/08/2026): **entre a entrega e o
comprovante assinado existe uma janela em que a ficha tem o registro e não tem a
prova.** O sistema imprime a partir do congelado, o servidor assina no papel, e
o PDF digitalizado volta como anexo. Enquanto ele não vem, a entrega **não está
completa** — e isso não pode ser silencioso: abre pendência
(`COMPROVANTE_EPI_PENDENTE`), aparece etiquetado na ficha e é contado no topo da
tela. Lacuna que só aparece na fiscalização é lacuna que ninguém consertou.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    AdicionalVigencia,
    Anexo,
    EpiEntradaEstoque,
    EpiFichaRegistro,
    EpiItem,
    EpiMotivoRecusa,
    Servidor,
    agora_utc,
)
from app.servicos import (
    anexos as servico_anexos,
    auditoria,
    comprovante_epi,
    datas_br,
    epi_estoque,
    pendencias,
    servidores as servico_servidores,
    textos,
)
from app.servicos.comprovante_epi import ContextoComprovante
from app.servicos.parecer import setor_emissor_vigente
from app.servicos.rbac import UsuarioAtual

EPI_ENTREGUE = "EPI_ENTREGUE"
EPI_ESTORNADO = "EPI_ESTORNADO"
EPI_DEVOLVIDO = "EPI_DEVOLVIDO"
EPI_COMPROVANTE_ANEXADO = "EPI_COMPROVANTE_ANEXADO"
EPI_COMPROVANTE_IMPRESSO = "EPI_COMPROVANTE_IMPRESSO"
EPI_COMPROVANTE_DIVERGENTE = "EPI_COMPROVANTE_DIVERGENTE"
EPI_MAXIMO_EXCEDIDO = "EPI_MAXIMO_EXCEDIDO"
EPI_ENTREGA_RECUSADA = "EPI_ENTREGA_RECUSADA"

CATEGORIA_ANEXO = "FICHA_EPI"
TIPO_PENDENCIA_COMPROVANTE = "COMPROVANTE_EPI_PENDENTE"
TIPO_PENDENCIA_REAVALIACAO = "REAVALIAR_ADICIONAL_POR_EPI"
TIPO_PENDENCIA_TROCA = "TROCA_EPI_DEVIDA"


class EntregaBloqueada(ValueError):
    """O que impede esta entrega, tudo de uma vez.

    Lista em vez de primeiro-erro pela mesma razão do `DadosIncompletos` do
    parecer: quem está no balcão com a pessoa esperando precisa saber tudo o que
    falta numa passada, e não descobrir um problema por tentativa.
    """

    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Entrega bloqueada: " + "; ".join(motivos))


@dataclass
class Validacao:
    bloqueios: list[str] = field(default_factory=list)
    avisos: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.bloqueios


# =====================================================================
# Leitura da ficha
# =====================================================================
def exigir_leitura_da_ficha(usuario: UsuarioAtual, servidor_id: int | None) -> bool:
    """Devolve `True` quando a leitura é da ficha de OUTRA pessoa.

    Ler a própria ficha não exige `epi.ficha`: `ESCOPO_PROPRIO` já resolve, e a
    LGPD art. 18, II garante ao titular o acesso ao que é dele. Ler a de outro
    exige a permissão **e** entra em `acesso_dado_sensivel` — a ficha é histórico
    nominal sobre a segurança de uma pessoa, na mesma classe da exposição
    (RN-23).

    Mora no serviço, e não na rota, porque não é mais uma tela que a consome: o
    download do comprovante assinado por `GET /anexos/{id}` faz a mesma pergunta,
    e era por ele ter tido uma resposta PRÓPRIA — `exposicao.ver`, que não é
    `epi.ficha` — que o mesmo arquivo saía por duas portas com rigor diferente.
    """
    propria = usuario.servidor_id is not None and usuario.servidor_id == servidor_id
    if propria:
        usuario.exigir("epi.ver")
        return False
    usuario.exigir("epi.ficha")
    return True


@dataclass
class LinhaDaFicha:
    """Uma linha da ficha com o que a tela precisa saber, calculado agora.

    Vencimento e troca devida **nunca** são gravados: são estado, e estado
    gravado é estado que envelhece em silêncio — a mesma escolha que
    `EpiItem.ca_vencido_em` já fez no catálogo.
    """

    registro: EpiFichaRegistro
    comprovante: Anexo | None
    estornado_por: EpiFichaRegistro | None
    estorna: EpiFichaRegistro | None

    @property
    def estornado(self) -> bool:
        return self.estornado_por is not None

    @property
    def entregue_por_nome(self) -> str:
        """O nome de quem entregou, como estava no dia — vem do congelado.

        `entregue_por` é o `usuario.id`, e resolvê-lo hoje faria a ficha mudar
        quando a pessoa trocasse de nome ou a conta fosse desativada. O nome está
        no `contexto_congelado` porque é ele que sai impresso no comprovante que
        a pessoa assinou ao lado.
        """
        congelado = self.registro.contexto_congelado or {}
        return str(congelado.get("entregue_por") or f"usuário {self.registro.entregue_por}")

    @property
    def sem_comprovante(self) -> bool:
        """A janela da decisão 8, dita na tela.

        Estorno não pede comprovante: o papel que a pessoa assinou é o da
        entrega, e o estorno é ato interno de correção.
        """
        return (
            self.registro.tipo == "ENTREGA"
            and not self.estornado
            and self.comprovante is None
        )

    def ca_vencido_em(self, quando: date) -> bool:
        validade = self.registro.validade_ca_snapshot
        return validade is not None and validade < quando

    def troca_vencida_em(self, quando: date) -> bool:
        troca = self.registro.previsao_troca
        return (
            troca is not None
            and troca < quando
            and self.registro.tipo == "ENTREGA"
            and not self.estornado
        )


def registros_de(s: Session, servidor_id: int) -> list[EpiFichaRegistro]:
    return list(
        s.execute(
            select(EpiFichaRegistro)
            .where(EpiFichaRegistro.servidor_id == servidor_id)
            .order_by(
                EpiFichaRegistro.data_evento.desc(), EpiFichaRegistro.id.desc()
            )
        ).scalars()
    )


def linha_do_tempo(s: Session, servidor_id: int) -> list[LinhaDaFicha]:
    """Tudo o que o servidor recebeu, do mais recente para o mais antigo.

    O estorno e a linha estornada aparecem os **dois**: a linha errada continua
    visível e marcada, porque é assim que documento de valor probatório se
    corrige. Esconder a original faria a ficha parecer certa e a auditoria
    discordar dela.
    """
    registros = registros_de(s, servidor_id)
    por_id = {r.id: r for r in registros}
    estorno_de = {
        r.registro_estornado_id: r
        for r in registros
        if r.tipo == "ESTORNO" and r.registro_estornado_id is not None
    }
    anexos_por_id = _comprovantes_de(s, [r.id for r in registros])
    return [
        LinhaDaFicha(
            registro=r,
            comprovante=anexos_por_id.get(r.comprovante_anexo_id),
            estornado_por=estorno_de.get(r.id),
            estorna=por_id.get(r.registro_estornado_id or -1),
        )
        for r in registros
    ]


def _comprovantes_de(s: Session, registro_ids: list[int]) -> dict[int, Anexo]:
    """Uma consulta para a ficha inteira, e não uma por linha."""
    if not registro_ids:
        return {}
    linhas = s.execute(
        select(Anexo).where(
            Anexo.entidade == EpiFichaRegistro.__tablename__,
            Anexo.entidade_id.in_(registro_ids),
            Anexo.ativo.is_(True),
        )
    ).scalars()
    return {anexo.id: anexo for anexo in linhas}


def servidores_com_ficha(s: Session) -> list[tuple[Servidor, int, int]]:
    """`(servidor, quantas linhas, quantas sem comprovante)` — a lista de `/epis/fichas`.

    A contagem de pendentes vem junto porque é ela que a lista existe para
    mostrar: uma tela que só diz "fulano tem ficha" não diz onde falta prova.
    """
    registros = list(
        s.execute(
            select(EpiFichaRegistro).order_by(EpiFichaRegistro.servidor_id)
        ).scalars()
    )
    estornados = {
        r.registro_estornado_id for r in registros if r.tipo == "ESTORNO"
    }
    resumo: dict[int, list[int]] = {}
    for r in registros:
        atual = resumo.setdefault(r.servidor_id, [0, 0])
        atual[0] += 1
        if (
            r.tipo == "ENTREGA"
            and r.id not in estornados
            and r.comprovante_anexo_id is None
        ):
            atual[1] += 1
    saida = []
    for servidor_id, (total, pendentes) in resumo.items():
        servidor = s.get(Servidor, servidor_id)
        if servidor is not None:
            saida.append((servidor, total, pendentes))
    return sorted(saida, key=lambda linha: linha[0].nome)


# =====================================================================
# §7 — o que o EPI publica para o parecer, e só isso
# =====================================================================
@dataclass(frozen=True)
class RegistroFicha:
    """Uma entrega lida **na data da avaliação**, e nunca na de hoje.

    A diferença não é preciosismo. O parecer que se está escrevendo afirma uma
    coisa sobre um dia — o dia em que o engenheiro foi ao posto e conferiu o
    equipamento. Um CA que valia naquele dia e venceu meses depois não desmente
    o parecer; um CA que já estava vencido naquele dia desmente. Ler a validade
    contra `date.today()` inverteria as duas coisas com o passar do calendário,
    e o mesmo parecer mudaria de fundamento sem ninguém ter tocado nele.

    Nada aqui é gravado: é estado, calculado no momento da leitura a partir dos
    snapshots congelados da linha — a mesma escolha de `LinhaDaFicha`.
    """

    registro: EpiFichaRegistro
    quando: date
    # Somada em `entregas_ate` porque a conta precisa da sessão, e este objeto
    # é frozen justamente para não voltar ao banco por conta própria.
    devolvida_em: date | None = None

    @property
    def epi(self) -> str:
        return self.registro.nome_epi_snapshot or ""

    @property
    def numero_ca(self) -> str:
        return self.registro.numero_ca_snapshot or ""

    @property
    def validade_ca(self) -> date | None:
        return self.registro.validade_ca_snapshot

    @property
    def previsao_troca(self) -> date | None:
        return self.registro.previsao_troca

    @property
    def entregue_em(self) -> date:
        return self.registro.data_evento

    @property
    def quantidade(self) -> int:
        return self.registro.quantidade

    @property
    def ca_vencido(self) -> bool:
        """NR-6: sem CA vigente o objeto não é EPI, é só um objeto."""
        return self.validade_ca is not None and self.validade_ca < self.quando

    @property
    def sem_ca(self) -> bool:
        """"Não sei" não é "está válido" — é a mesma leitura da RN-25."""
        return not self.numero_ca or self.validade_ca is None

    @property
    def troca_vencida(self) -> bool:
        """RN-32: passada a vida útil, ninguém sabe o que a pessoa está usando."""
        return self.previsao_troca is not None and self.previsao_troca < self.quando

    @property
    def devolvido(self) -> bool:
        return self.devolvida_em is not None

    @property
    def ressalvas(self) -> list[str]:
        """Por que esta linha **não** sustenta alegação de neutralização.

        Sai em texto e não em booleano porque é isto que vai para a tela: o
        engenheiro não deveria ter de comparar duas datas de cabeça para
        descobrir que o equipamento que ele está prestes a citar já não valia no
        dia em que ele foi ao posto.
        """
        motivos: list[str] = []
        if self.ca_vencido:
            motivos.append(
                f"o CA {self.numero_ca or '—'} venceu em "
                f"{datas_br.numerica(self.validade_ca)}, antes de "
                f"{datas_br.numerica(self.quando)}"
            )
        elif self.sem_ca:
            motivos.append(
                "a entrega não registrou CA com validade — sem Certificado de "
                "Aprovação vigente o equipamento não é EPI pela NR-6"
            )
        if self.troca_vencida:
            motivos.append(
                "a troca prevista era "
                f"{datas_br.numerica(self.previsao_troca)} e já estava vencida "
                "(RN-32): a vida útil acabou antes da avaliação"
            )
        if self.devolvido:
            motivos.append(
                f"o equipamento foi devolvido em "
                f"{datas_br.numerica(self.devolvida_em)} — na data da avaliação "
                "ele não estava com a pessoa"
            )
        return motivos

    @property
    def sustenta_neutralizacao(self) -> bool:
        """Sustenta = não há ressalva. Nunca "sustenta = foi entregue"."""
        return not self.ressalvas

    def congelar(self) -> dict:
        """A forma que entra no `contexto_congelado` do parecer (§7.2).

        Datas em ISO e nada além de texto, inteiro e `None`, pelo mesmo motivo
        de `forma_canonica`: valor que não volta igual do banco faz a prova
        divergir de si mesma.
        """

        def iso(valor: date | None) -> str | None:
            return valor.isoformat() if valor is not None else None

        return {
            "registro": self.registro.id,
            "epi": self.epi,
            "quantidade": self.quantidade,
            "entregue_em": iso(self.entregue_em),
            "ca": self.numero_ca or None,
            "validade_ca": iso(self.validade_ca),
            "previsao_troca": iso(self.previsao_troca),
            "devolvida_em": iso(self.devolvida_em),
            "referencia": iso(self.quando),
            "ca_vencido": self.ca_vencido,
            "troca_vencida": self.troca_vencida,
            "sustenta_neutralizacao": self.sustenta_neutralizacao,
        }


def entregas_ate(
    s: Session, servidor_id: int, quando: date, posto_id: int | None = None
) -> list[RegistroFicha]:
    """O que o servidor tinha recebido ate aquela data, com CA e troca prevista.

    Consulta de leitura. Nao decide nada: quem decide e o subscritor do laudo.
    """
    registros = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == servidor_id,
                EpiFichaRegistro.data_evento <= quando,
            )
        ).scalars()
    )
    # Estorno declara que aquela entrega NÃO VALE, e essa declaração não tem
    # data de início: a linha nunca foi verdadeira. Por isso a estornada sai da
    # lista mesmo quando o estorno é posterior a `quando` — o contrário faria a
    # consulta oferecer como prova algo que o próprio setor já desmentiu.
    todas = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == servidor_id
            )
        ).scalars()
    )
    estornadas = {
        r.registro_estornado_id for r in todas if r.tipo == "ESTORNO"
    }

    saida: list[RegistroFicha] = []
    for registro in registros:
        if registro.tipo != "ENTREGA" or registro.id in estornadas:
            continue
        if posto_id is not None and not _estava_no_posto(
            s, servidor_id, registro.data_evento, posto_id
        ):
            continue
        saida.append(
            RegistroFicha(
                registro=registro,
                quando=quando,
                devolvida_em=_devolvida_ate(s, registro, quando),
            )
        )
    return sorted(saida, key=lambda r: (r.entregue_em, r.registro.id), reverse=True)


def _estava_no_posto(
    s: Session, servidor_id: int, quando: date, posto_id: int
) -> bool:
    """O filtro por posto vai pela LOTAÇÃO da data, não pelo texto do snapshot.

    `posto_snapshot` é " / ".join de nomes, feito para sair impresso no
    comprovante; casar posto por texto seria a busca frágil que o §6.2 recusa
    para a trilha. A lotação da data responde a mesma pergunta com o vínculo
    que o banco cobra.
    """
    lotacao = servico_servidores.lotacao_em(s, servidor_id, quando)
    return bool(lotacao) and any(p.id == posto_id for p in lotacao.postos)


def _devolvida_ate(
    s: Session, registro: EpiFichaRegistro, quando: date
) -> date | None:
    """A data em que a devolução completou a entrega — se foi até `quando`.

    Devolução parcial não conta: quem devolveu uma das duas luvas continuava
    protegido pela outra. O que derruba a alegação é a pessoa não estar mais
    com o equipamento.
    """
    devolucoes = [
        d for d in devolucoes_de(s, registro) if d.data_evento <= quando
    ]
    if sum(d.quantidade for d in devolucoes) < registro.quantidade:
        return None
    return max(d.data_evento for d in devolucoes)


# =====================================================================
# RN-26 — a quantidade máxima conta o que a FICHA registra
# =====================================================================
def entregue_na_janela(
    s: Session, servidor_id: int, item: EpiItem, ate: date
) -> int:
    """Quanto deste item o servidor já recebeu dentro da janela do catálogo.

    A conta soma **a ficha**, não requisições aprovadas: aprovação é promessa,
    entrega é fato, e a ficha é a verdade. Linha estornada não entra — estorno
    existe justamente para dizer que aquela entrega não vale.
    """
    if item.quantidade_maxima is None or item.periodo_maximo_meses is None:
        return 0
    desde = datas_br.somar_meses(ate, -item.periodo_maximo_meses)
    registros = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == servidor_id,
                EpiFichaRegistro.epi_item_id == item.id,
                EpiFichaRegistro.data_evento >= desde,
                EpiFichaRegistro.data_evento <= ate,
            )
        ).scalars()
    )
    estornados = {r.registro_estornado_id for r in registros if r.tipo == "ESTORNO"}
    return sum(
        r.quantidade
        for r in registros
        if r.tipo == "ENTREGA" and r.id not in estornados
    )


# =====================================================================
# Validação da entrega
# =====================================================================
def validar(
    s: Session,
    *,
    servidor: Servidor,
    item: EpiItem,
    entrada: EpiEntradaEstoque | None,
    quantidade: int,
    quando: date,
    justificativa_excecao: str = "",
) -> Validacao:
    """Tudo o que precisa ser verdade para a entrega sair.

    Roda também fora da entrega: a tela usa esta função para dizer o que trava
    **antes** de alguém clicar. Uma segunda conta para a tela seria a forma mais
    barata de a tela dizer "pode" e o serviço recusar.
    """
    v = Validacao()

    # Decisão 7: EPI é só para servidor com SIAPE. O esquema já fecha a porta
    # (`servidor.siape` é NOT NULL, único e validado em sete dígitos), e é por
    # isso que aqui basta conferir a forma: o caminho pelo qual um pedido de
    # terceirizado, estudante ou bolsista chega é humano, e a recusa dele é
    # `recusar()`, com motivo do catálogo.
    if not (servidor.siape or "").strip().isdigit() or len(servidor.siape) != 7:
        v.bloqueios.append(
            f"{servidor.nome} não tem matrícula SIAPE válida — a ficha de EPI "
            "identifica a pessoa pelo SIAPE congelado, e sem ele não há o que "
            "congelar"
        )
    if servidor.situacao != "ATIVO":
        v.avisos.append(
            f"{servidor.nome} está com situação {servidor.situacao.lower()} no "
            "cadastro: confira se a entrega se justifica"
        )
    if not item.ativo:
        v.avisos.append(
            f"'{item.nome}' está inativo no catálogo — o lote na prateleira "
            "continua válido, mas o item não deveria estar sendo requisitado"
        )
    if quantidade <= 0:
        v.bloqueios.append("a quantidade tem de ser maior que zero")

    # RN-25, nos dois caminhos. Com lote, quem manda é o CA do lote; sem lote
    # (entrega de balcão, antes de o estoque existir no sistema), o único CA
    # conhecido é o do catálogo — e "não sei" continua não sendo "está válido".
    if entrada is not None:
        impedimento = epi_estoque.impedimento_do_lote(entrada, item, quando)
        if impedimento:
            v.bloqueios.append(f"EPI com CA vencido não se entrega — {impedimento}")
        # RN-24: saldo nunca fica negativo
        saldo = epi_estoque.disponivel(s, entrada.id)
        if quantidade > saldo:
            v.bloqueios.append(
                f"o lote tem {saldo} disponível(is) e a entrega pede {quantidade}"
            )
        if entrada.epi_item_id != item.id:
            v.bloqueios.append("o lote escolhido é de outro item do catálogo")
    elif item.exige_ca:
        if not item.numero_ca:
            v.bloqueios.append(
                f"'{item.nome}' exige CA e não tem número de CA no catálogo"
            )
        elif item.validade_ca is None:
            v.bloqueios.append(
                f"'{item.nome}' exige CA e não tem validade registrada — "
                "“não sei” não é “está válido”"
            )
        elif item.validade_ca < quando:
            v.bloqueios.append(
                f"EPI com CA vencido não se entrega — o CA {item.numero_ca} do "
                f"catálogo venceu em {datas_br.numerica(item.validade_ca)}"
            )
        v.avisos.append(
            "entrega sem lote: o CA conferido foi o do catálogo, e não o da "
            "etiqueta do equipamento. Confira a etiqueta antes de entregar"
        )

    # RN-26: máxima com janela, contada na ficha. Não é bloqueio duro — é
    # bloqueio até que alguém escreva a justificativa e assine com o próprio
    # usuário, como `excecao_art9_par_unico` já faz na exposição.
    if item.quantidade_maxima is not None:
        ja = entregue_na_janela(s, servidor.id, item, quando)
        if ja + quantidade > item.quantidade_maxima:
            recado = (
                f"{servidor.nome} já recebeu {ja} de '{item.nome}' nos últimos "
                f"{item.periodo_maximo_meses} meses, e o máximo é "
                f"{item.quantidade_maxima}"
            )
            if justificativa_excecao.strip():
                v.avisos.append(f"{recado} — exceção autorizada e registrada")
            else:
                v.bloqueios.append(
                    f"{recado}. Para entregar assim mesmo, escreva a justificativa "
                    "da exceção: ela fica registrada com o seu nome"
                )
    return v


# =====================================================================
# Contexto congelado
# =====================================================================
def _posto_e_unidade(s: Session, servidor: Servidor, quando: date) -> tuple[str, str]:
    """Onde a pessoa estava NA DATA DA ENTREGA — não onde ela está hoje.

    Quem mudou de setor depois não recebeu o EPI na unidade nova, e a ficha
    descreve o que aconteceu. Mesmo critério do `_lotacao_na_data` do
    certificado.
    """
    lotacao = servico_servidores.lotacao_em(s, servidor.id, quando)
    unidade = (lotacao.unidade if lotacao else None) or servidor.unidade
    postos = lotacao.postos if lotacao else []
    return (
        " / ".join(p.nome for p in postos),
        unidade.nome_extenso if unidade else "",
    )


def montar_contexto_para_entregar(
    s: Session,
    *,
    servidor: Servidor,
    item: EpiItem,
    entrada: EpiEntradaEstoque | None,
    quantidade: int,
    tamanho: str,
    quando: date,
    tipo: str,
    entregue_por: str,
    motivo: str,
) -> ContextoComprovante:
    """O contexto do catálogo de HOJE — montado uma única vez, na entrega.

    Depois de congelado, `montar_contexto` nunca mais passa por aqui.

    O CA que entra no congelado é o **do lote** quando há lote: é ele que a
    RN-25 conferiu, e congelar o do catálogo faria o comprovante afirmar uma
    coisa e a regra ter verificado outra.
    """
    posto, unidade = _posto_e_unidade(s, servidor, quando)
    setor = setor_emissor_vigente(s, quando)
    do_lote = entrada is not None
    return ContextoComprovante(
        # a linha ainda não existe; `montar_contexto` põe o id de volta ao ler
        registro_id=0,
        tipo=tipo,
        data_evento=quando,
        quantidade=quantidade,
        unidade_medida=item.unidade_medida,
        servidor_nome=servidor.nome,
        siape=servidor.siape,
        cargo=servidor.cargo.nome if servidor.cargo else "",
        funcao=servidor.funcao or "",
        unidade=unidade,
        posto=posto,
        epi_nome=item.nome,
        categoria=item.categoria.nome,
        fabricante=item.fabricante or "",
        modelo=" ".join(p for p in (item.marca, item.modelo) if p),
        normas=item.normas or "",
        numero_ca=(entrada.numero_ca if do_lote else item.numero_ca) or "",
        validade_ca=entrada.validade_ca if do_lote else item.validade_ca,
        lote=(entrada.lote or "") if do_lote else "",
        tamanho=tamanho or (entrada.tamanho or "" if do_lote else ""),
        previsao_troca=(
            datas_br.somar_meses(quando, item.vida_util_meses)
            if item.vida_util_meses
            else None
        ),
        pregao=(entrada.pregao or "") if do_lote else "",
        item_pregao=(entrada.item_pregao or "") if do_lote else "",
        empenho=(entrada.empenho or "") if do_lote else "",
        nota_fiscal=(entrada.nota_fiscal or "") if do_lote else "",
        fornecedor=(entrada.fornecedor_nome or "") if do_lote else "",
        entregue_por=entregue_por,
        motivo=motivo,
        setor_sigla=setor.sigla_composta if setor else "",
        setor_nome=setor.nome_extenso if setor else "",
        setor_endereco=(setor.endereco or "") if setor else "",
        cidade=setor.cidade if setor else "Diamantina",
    )


def montar_contexto(registro: EpiFichaRegistro) -> ContextoComprovante:
    """RN-15: registro gravado reimprime do congelado, não do catálogo de hoje.

    É a única porta de leitura de contexto de uma linha da ficha. Não há ramo
    alternativo que volte ao banco, e é essa ausência que faz a regra valer —
    exatamente como em `emissao_certificado.montar_contexto`.
    """
    if not registro.contexto_congelado:  # pragma: no cover - linha sem congelado
        raise ValueError(
            f"o registro {registro.id} não tem contexto congelado: o comprovante "
            "não pode ser remontado do catálogo de hoje sem deixar de ser prova"
        )
    return ContextoComprovante.descongelar(
        registro.contexto_congelado, registro_id=registro.id
    )


# =====================================================================
# A forma canônica: o que amarra a linha à cadeia de hash (§6.2)
# =====================================================================
def forma_canonica(registro: EpiFichaRegistro) -> dict:
    """O conteúdo da linha, na forma que vai para `historico_evento.valor_novo`.

    Montada a partir das **colunas**, e não do `contexto_congelado`: é a linha
    que se quer provar intacta, e comparar o congelado consigo mesmo não provaria
    nada. Amarrada ao `hash_atual` do evento, e daí à cadeia inteira, ela dá o
    que o §6.2 do desenho pede — `conferir()` refaz esta forma e compara.

    Só texto, inteiro e `None`: valor que não volta igual do banco faria o digest
    ser calculado sobre uma coisa e conferido sobre outra, e a cadeia acusaria
    adulteração onde ninguém tocou em nada. Por isso data sai em ISO.
    """

    def iso(valor: date | None) -> str | None:
        return valor.isoformat() if valor is not None else None

    return {
        "registro": registro.id,
        "tipo": registro.tipo,
        "servidor_id": registro.servidor_id,
        "siape": registro.siape_snapshot,
        "servidor": registro.nome_servidor_snapshot,
        "epi_item_id": registro.epi_item_id,
        "epi": registro.nome_epi_snapshot,
        "categoria": registro.categoria_snapshot,
        "quantidade": registro.quantidade,
        "tamanho": registro.tamanho_snapshot,
        "ca": registro.numero_ca_snapshot,
        "validade_ca": iso(registro.validade_ca_snapshot),
        "lote": registro.lote_snapshot,
        "entrada_id": registro.entrada_id,
        "data_evento": iso(registro.data_evento),
        "previsao_troca": iso(registro.previsao_troca),
        "entregue_por": registro.entregue_por,
        "estorna": registro.registro_estornado_id,
        "motivo": registro.motivo,
    }


@dataclass(frozen=True)
class Divergencia:
    registro_id: int
    detalhe: str


def conferir(s: Session, servidor_id: int) -> list[Divergencia]:
    """Refaz a forma canônica de cada linha e compara com o evento que a registrou.

    Divergência = a linha foi alterada por fora do sistema, e o relatório diz
    qual. Complementa `auditoria.cadeia_integra()`, que prova que os eventos não
    foram tocados: uma coisa é a trilha estar íntegra, outra é a ficha continuar
    dizendo o que a trilha registrou.
    """
    from app.modelos import HistoricoEvento

    achados: list[Divergencia] = []
    for registro in registros_de(s, servidor_id):
        if registro.evento_id is None:
            achados.append(
                Divergencia(
                    registro.id,
                    "a linha não aponta para nenhum evento da trilha — não há "
                    "com o que conferir o conteúdo dela",
                )
            )
            continue
        evento = s.get(HistoricoEvento, registro.evento_id)
        if evento is None:  # pragma: no cover - FK impede
            achados.append(Divergencia(registro.id, "o evento apontado não existe"))
            continue
        if evento.valor_novo != forma_canonica(registro):
            achados.append(
                Divergencia(
                    registro.id,
                    "o conteúdo da linha não confere com o que o evento "
                    f"#{evento.id} registrou",
                )
            )
    return achados


# =====================================================================
# Registrar a entrega
# =====================================================================
def registrar_entrega(
    s: Session,
    usuario: UsuarioAtual,
    *,
    servidor: Servidor,
    item: EpiItem,
    quantidade: int,
    entrada: EpiEntradaEstoque | None = None,
    tamanho: str = "",
    data_evento: date | None = None,
    observacao: str = "",
    justificativa_excecao: str = "",
    tipo: str = "ENTREGA",
    requisicao_item_id: int | None = None,
) -> EpiFichaRegistro:
    """A entrega inteira, numa transação: ficha, baixa de estoque e trilha.

    A ordem importa, e é esta:

    1. permissão, antes de qualquer leitura;
    2. **validar tudo** — RN-24, RN-25, RN-26 e a decisão 7;
    3. gravar a linha da ficha com os snapshots;
    4. baixar o lote no razão, amarrado ao `id` da linha;
    5. auditar com a forma canônica e guardar o `evento_id` na linha;
    6. abrir a pendência do comprovante;
    7. abrir, se houver adicional vigente, a pendência de reavaliação (§7.2) —
       que é tarefa para a CSSO, e não efeito sobre o direito.

    O passo 4 depois do 3 não é detalhe: o movimento aponta para
    `ficha_registro_id`, e baixar estoque antes de a prova existir deixaria saldo
    consumido por uma entrega que pode não ter acontecido.

    `requisicao_item_id` é nulo na entrega de **balcão** — que é a porta desta
    fatia e continua legítima — e vem preenchido quando quem chama é
    `epi_requisicao.entregar_item` (fatia 4). Ele entra no `INSERT`, e não num
    `UPDATE` depois: a coluna está entre as 26 congeladas pela trava do banco,
    porque de qual pedido a entrega veio é conteúdo da prova, não anotação.
    """
    usuario.exigir("epi.entregar")
    quando = data_evento or date.today()

    # RN-30: texto livre passa pelo filtro da RN-21 antes de qualquer gravação
    textos.exigir_texto_limpo(observacao, campo="observação da entrega")
    textos.exigir_texto_limpo(justificativa_excecao, campo="justificativa da exceção")

    validacao = validar(
        s,
        servidor=servidor,
        item=item,
        entrada=entrada,
        quantidade=quantidade,
        quando=quando,
        justificativa_excecao=justificativa_excecao,
    )
    if not validacao.ok:
        raise EntregaBloqueada(validacao.bloqueios)

    motivo = " ".join(t for t in (observacao.strip(), justificativa_excecao.strip()) if t)
    # Os snapshots e o congelado saem do MESMO contexto: duas montagens seriam
    # duas versões do que valia no ato, e elas divergiriam no primeiro campo que
    # alguém acrescentasse a uma só.
    #
    # E a linha nasce COMPLETA, num INSERT só. Não é estilo: a trava do banco
    # recusa alterar qualquer coluna de conteúdo, então gravar o congelado num
    # `UPDATE` depois do flush seria rasura — a mesma que ela existe para
    # impedir. Por isso o `registro_id` ficou fora do congelado (ver
    # `ContextoComprovante`).
    contexto = montar_contexto_para_entregar(
        s,
        servidor=servidor,
        item=item,
        entrada=entrada,
        quantidade=quantidade,
        tamanho=tamanho,
        quando=quando,
        tipo=tipo,
        entregue_por=usuario.nome,
        motivo=motivo,
    )
    registro = EpiFichaRegistro(
        servidor_id=servidor.id,
        epi_item_id=item.id,
        entrada_id=entrada.id if entrada is not None else None,
        requisicao_item_id=requisicao_item_id,
        tipo=tipo,
        quantidade=quantidade,
        data_evento=quando,
        entregue_por=usuario.id,
        motivo=motivo or None,
        contexto_congelado=contexto.congelar(),
    )
    _aplicar_snapshots(registro, contexto)
    s.add(registro)
    s.flush()
    contexto.registro_id = registro.id

    if entrada is not None:
        epi_estoque.baixar(
            s,
            entrada=entrada,
            quantidade=quantidade,
            ficha_registro_id=registro.id,
            usuario=usuario,
            # `servidor #{id}` e nao o SIAPE: o extrato do lote abre com
            # `epi.ver` — permissao que o servidor comum tem — e o motivo sai
            # como texto no razao, que e append-only. Escrever a matricula aqui
            # publicava a de todo mundo que recebeu daquele lote para qualquer
            # conta do sistema, por fora da RN-19: identificacao que escapa pela
            # PROSA, como a descricao da pendencia e a da trilha escapavam antes
            # da 1.35.0. O id nao identifica sozinho e a ficha resolve quem e
            # para quem pode ler. Mesmo padrao de `direito.py`.
            motivo=f"entrega ao servidor #{servidor.id}",
            requisicao_item_id=requisicao_item_id,
        )

    evento = auditoria.registrar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        tipo_evento=EPI_ENTREGUE,
        # RN-19 na ESCRITA, e a frase de referência do módulo: o `servidor #{id}`
        # é o mesmo gesto do motivo do razão logo acima e do que `direito.py:243`
        # e `epi_requisicao.py` já praticam. Quem pode ler resolve quem é pela
        # ficha, que é onde a leitura nominal fica registrada (RN-23) — e a
        # trilha não registra, de propósito, então nomear aqui era entregar
        # identificação por uma tela que deliberadamente não conta que a
        # entregou. Quem OPEROU continua nominal: a trilha imprime `usuario_nome`
        # numa COLUNA ao lado, por desenho.
        #
        # O congelado da RN-15 não muda: `nome_servidor_snapshot` e
        # `siape_snapshot` continuam nas COLUNAS da ficha, e é isso que faz o
        # comprovante reimprimir igual daqui a cinco anos. O que saiu foi o nome
        # dentro do texto livre, que é outra coisa.
        descricao=(
            f"{quantidade} × {registro.nome_epi_snapshot} para o "
            f"servidor #{registro.servidor_id} · "
            f"CA {registro.numero_ca_snapshot or '—'} · "
            f"lote {registro.lote_snapshot or '—'}"
        ),
        campo="ficha",
        valor_novo=forma_canonica(registro),
        usuario=usuario,
    )
    registro.evento_id = evento.id
    s.flush()

    if justificativa_excecao.strip():
        auditoria.registrar(
            s,
            entidade=EpiFichaRegistro.__tablename__,
            entidade_id=registro.id,
            tipo_evento=EPI_MAXIMO_EXCEDIDO,
            descricao=(
                f"Máximo de '{item.nome}' excedido e autorizado por "
                f"{usuario.nome}: {justificativa_excecao.strip()}"
            ),
            comentario=justificativa_excecao.strip(),
            usuario=usuario,
        )

    if tipo == "ENTREGA":
        abrir_pendencia_de_comprovante(s, registro, usuario)
        # §7.2, sentido inverso: a entrega NÃO toca `adicional_vigencia` — ela
        # abre tarefa para a CSSO olhar. Ver `abrir_pendencia_de_reavaliacao`.
        abrir_pendencia_de_reavaliacao(s, registro, usuario)
        # RN-32: esta entrega pode ser a SUBSTITUIÇÃO que encerra a cobrança de
        # uma troca antiga. Por isso a varredura é da ficha inteira da pessoa, e
        # não da linha recém-escrita — ver `sincronizar_trocas_do_servidor`. A
        # varredura corre contra HOJE, e não contra `quando`: entrega lançada
        # com data retroativa não faz o calendário andar para trás.
        sincronizar_trocas_do_servidor(s, servidor.id, usuario)
    s.flush()
    return registro


def _aplicar_snapshots(
    registro: EpiFichaRegistro, contexto: ContextoComprovante
) -> None:
    """As colunas de snapshot, copiadas do contexto que também vai ao congelado.

    Elas existem além do `contexto_congelado` porque são o que se consulta: a
    ficha filtra por CA vencido e por troca devida com `WHERE`, e JSON não se
    indexa em SQLite. O congelado guarda o resto (empenho, pregão, fornecedor,
    termo) — o que se imprime e não se consulta.
    """
    registro.nome_epi_snapshot = contexto.epi_nome
    registro.categoria_snapshot = contexto.categoria
    registro.numero_ca_snapshot = contexto.numero_ca or None
    registro.validade_ca_snapshot = contexto.validade_ca
    registro.fabricante_snapshot = contexto.fabricante or None
    registro.lote_snapshot = contexto.lote or None
    registro.tamanho_snapshot = contexto.tamanho or None
    registro.nome_servidor_snapshot = contexto.servidor_nome
    registro.siape_snapshot = contexto.siape
    registro.cargo_snapshot = contexto.cargo or None
    registro.unidade_snapshot = contexto.unidade or None
    registro.posto_snapshot = contexto.posto or None
    registro.previsao_troca = contexto.previsao_troca


# =====================================================================
# Estorno — a única forma de corrigir
# =====================================================================
def estornar(
    s: Session, usuario: UsuarioAtual, registro: EpiFichaRegistro, motivo: str
) -> EpiFichaRegistro:
    """Linha nova apontando para a errada, com motivo. A errada continua lá.

    Não devolve o saldo ao estoque de propósito: estornar diz que o **registro**
    está errado, não que o equipamento voltou para a prateleira. O que devolve
    saldo é `registrar_devolucao`, logo abaixo, que é fato do mundo. Fazer as
    duas coisas com um clique só criaria a divergência que o razão existe para
    impedir — o físico deixaria de bater com a contagem manual.
    """
    usuario.exigir("epi.entregar")
    limpo = textos.exigir_texto_limpo(
        (motivo or "").strip(), campo="motivo do estorno"
    )
    if not limpo:
        raise EntregaBloqueada(
            [
                "estornar exige o motivo: é o único registro que sobra para quem "
                "ler a ficha depois e perguntar por que aquela linha não vale"
            ]
        )
    if registro.tipo == "ESTORNO":
        raise EntregaBloqueada(["um estorno não se estorna: registre a entrega de novo"])
    if _ja_estornado(s, registro) is not None:
        raise EntregaBloqueada([f"o registro {registro.id} já foi estornado"])
    devolvido = sum(d.quantidade for d in devolucoes_de(s, registro))
    if devolvido:
        # Estornar depois de uma devolução deixaria o razão inflado: a devolução
        # já devolveu saldo ao lote, e o estorno declara que a entrega que gerou
        # aquele saldo não valia. Os dois juntos criam unidades que nunca
        # existiram — e o físico deixaria de bater com a prateleira, que é o que
        # o razão existe para impedir.
        raise EntregaBloqueada(
            [
                f"o registro {registro.id} já teve {devolvido} devolvido(s): "
                "devolução é fato do mundo e devolveu saldo ao lote. Corrigir a "
                "quantidade agora é ajuste de inventário, com contagem e motivo"
            ]
        )

    # o comprovante de um estorno é o do registro estornado, com outro título e
    # o motivo à mostra. Montado ANTES do INSERT: a linha nasce completa, porque
    # a trava recusa alterar conteúdo depois (é o mesmo motivo da entrega).
    congelado = dict(registro.contexto_congelado or {})
    if congelado:
        congelado["tipo"] = "ESTORNO"
        congelado["motivo"] = limpo
    estorno = EpiFichaRegistro(
        servidor_id=registro.servidor_id,
        epi_item_id=registro.epi_item_id,
        entrada_id=registro.entrada_id,
        tipo="ESTORNO",
        quantidade=registro.quantidade,
        data_evento=date.today(),
        entregue_por=usuario.id,
        motivo=limpo,
        registro_estornado_id=registro.id,
        # o estorno herda os snapshots da linha estornada: ele fala DAQUELA
        # entrega, e remontá-los do catálogo de hoje faria a correção descrever
        # um equipamento diferente do que foi entregue
        nome_epi_snapshot=registro.nome_epi_snapshot,
        categoria_snapshot=registro.categoria_snapshot,
        numero_ca_snapshot=registro.numero_ca_snapshot,
        validade_ca_snapshot=registro.validade_ca_snapshot,
        fabricante_snapshot=registro.fabricante_snapshot,
        lote_snapshot=registro.lote_snapshot,
        tamanho_snapshot=registro.tamanho_snapshot,
        nome_servidor_snapshot=registro.nome_servidor_snapshot,
        siape_snapshot=registro.siape_snapshot,
        cargo_snapshot=registro.cargo_snapshot,
        unidade_snapshot=registro.unidade_snapshot,
        posto_snapshot=registro.posto_snapshot,
        contexto_congelado=congelado or None,
    )
    s.add(estorno)
    s.flush()

    evento = auditoria.registrar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=estorno.id,
        tipo_evento=EPI_ESTORNADO,
        # RN-19 na escrita, como em `registrar_entrega`. O registro estornado já
        # está nomeado pelo id, e é por ele que se chega à ficha.
        descricao=(
            f"Registro {registro.id} estornado: {limpo} "
            f"({registro.quantidade} × {registro.nome_epi_snapshot} para o "
            f"servidor #{registro.servidor_id})"
        ),
        campo="ficha",
        valor_novo=forma_canonica(estorno),
        comentario=limpo,
        usuario=usuario,
    )
    estorno.evento_id = evento.id
    s.flush()

    # a entrega estornada deixa de dever comprovante: não há papel a colher de
    # uma entrega que o próprio setor declarou inválida. Pela mesma razão ela
    # deixa de dever troca (RN-32): não se cobra a substituição de uma entrega
    # que o setor declarou que não aconteceu.
    fechar_pendencia_de_comprovante(s, registro, usuario)
    sincronizar_trocas_do_servidor(s, registro.servidor_id, usuario)
    s.flush()
    return estorno


# =====================================================================
# Devolução — o outro fato, que NÃO é estorno
# =====================================================================
def em_poder_de(s: Session, servidor_id: int, epi_item_id: int) -> int:
    """Quanto deste item o servidor recebeu e ainda não devolveu.

    É o teto da devolução: ninguém devolve o que não está com ele. A conta sai
    da ficha, que é a verdade — entrega menos devolução, sem contar linha
    estornada, porque estorno declara que aquela entrega não vale.
    """
    registros = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == servidor_id,
                EpiFichaRegistro.epi_item_id == epi_item_id,
            )
        ).scalars()
    )
    estornados = {r.registro_estornado_id for r in registros if r.tipo == "ESTORNO"}
    entregue = sum(
        r.quantidade
        for r in registros
        if r.tipo == "ENTREGA" and r.id not in estornados
    )
    devolvido = sum(r.quantidade for r in registros if r.tipo == "DEVOLUCAO")
    return entregue - devolvido


def registrar_devolucao(
    s: Session,
    usuario: UsuarioAtual,
    registro: EpiFichaRegistro,
    *,
    quantidade: int,
    motivo: str,
    data_evento: date | None = None,
) -> EpiFichaRegistro:
    """O equipamento voltou: linha nova na ficha e saldo de volta no razão.

    **Devolução não é estorno, e confundir as duas estraga as duas coisas.**

    - `estornar` diz que o **registro** estava errado: a entrega não devia ter
      sido lançada daquele jeito. A linha errada continua visível, marcada, e o
      saldo **não** volta — porque o equipamento não voltou de lugar nenhum.
    - `registrar_devolucao` diz que o registro estava certo e que o **EPI
      voltou**: fato do mundo, posterior à entrega, que não desfaz nada. A
      entrega continua tendo acontecido, o comprovante assinado continua valendo,
      e o saldo do lote sobe.

    Se um clique fizesse as duas coisas, o físico do sistema deixaria de bater
    com a contagem da prateleira — e é justamente essa conferência que o livro
    razão existe para permitir.

    A linha nasce completa, num `INSERT` só, pelo mesmo motivo da entrega e do
    estorno: a trava do banco recusa alterar conteúdo depois.
    """
    usuario.exigir("epi.entregar")
    limpo = textos.exigir_texto_limpo(
        (motivo or "").strip(), campo="motivo da devolução"
    )
    quando = data_evento or date.today()
    bloqueios: list[str] = []
    if not limpo:
        bloqueios.append(
            "diga por que o equipamento voltou: desgaste, dano, troca de posto "
            "ou desligamento mudam o que o setor faz com ele depois"
        )
    if registro.tipo != "ENTREGA":
        bloqueios.append(
            f"só se devolve o que foi entregue, e o registro {registro.id} é "
            f"{registro.tipo.lower()}"
        )
    elif _ja_estornado(s, registro) is not None:
        bloqueios.append(
            f"o registro {registro.id} foi estornado: ele declara que aquela "
            "entrega não vale, e não há o que devolver dela"
        )
    if quantidade <= 0:
        bloqueios.append("a quantidade devolvida tem de ser maior que zero")
    if quando > date.today():
        bloqueios.append("a devolução não pode ter data futura")
    elif quando < registro.data_evento:
        bloqueios.append(
            "a devolução é anterior à entrega: confira a data, porque a ficha é "
            "append-only e a linha não se corrige depois"
        )
    if registro.tipo == "ENTREGA":
        em_poder = em_poder_de(s, registro.servidor_id, registro.epi_item_id)
        if quantidade > em_poder:
            bloqueios.append(
                f"{registro.nome_servidor_snapshot} está com {em_poder} de "
                f"'{registro.nome_epi_snapshot}' e a devolução registra "
                f"{quantidade}"
            )
    if bloqueios:
        raise EntregaBloqueada(bloqueios)

    congelado = dict(registro.contexto_congelado or {})
    if congelado:
        congelado["tipo"] = "DEVOLUCAO"
        congelado["quantidade"] = quantidade
        congelado["data_evento"] = quando.isoformat()
        congelado["motivo"] = limpo
        # a linha da devolução aponta para a entrega de onde ela veio. Vai no
        # congelado, e não numa coluna: `registro_estornado_id` quer dizer "esta
        # linha anula aquela", que é exatamente o que uma devolução NÃO faz.
        congelado["registro_devolvido"] = registro.id
    devolucao = EpiFichaRegistro(
        servidor_id=registro.servidor_id,
        epi_item_id=registro.epi_item_id,
        entrada_id=registro.entrada_id,
        tipo="DEVOLUCAO",
        quantidade=quantidade,
        data_evento=quando,
        entregue_por=usuario.id,
        motivo=limpo,
        # herda os snapshots: a devolução fala DAQUELE equipamento, com aquele
        # CA e aquele lote — remontá-los do catálogo de hoje faria a linha
        # descrever coisa diferente da que voltou
        nome_epi_snapshot=registro.nome_epi_snapshot,
        categoria_snapshot=registro.categoria_snapshot,
        numero_ca_snapshot=registro.numero_ca_snapshot,
        validade_ca_snapshot=registro.validade_ca_snapshot,
        fabricante_snapshot=registro.fabricante_snapshot,
        lote_snapshot=registro.lote_snapshot,
        tamanho_snapshot=registro.tamanho_snapshot,
        nome_servidor_snapshot=registro.nome_servidor_snapshot,
        siape_snapshot=registro.siape_snapshot,
        cargo_snapshot=registro.cargo_snapshot,
        unidade_snapshot=registro.unidade_snapshot,
        posto_snapshot=registro.posto_snapshot,
        contexto_congelado=congelado or None,
    )
    s.add(devolucao)
    s.flush()

    # o saldo só volta quando havia lote: entrega de balcão não baixou nada do
    # razão, e devolver ao razão o que dele não saiu inventaria estoque
    if registro.entrada_id is not None:
        entrada = s.get(EpiEntradaEstoque, registro.entrada_id)
        if entrada is not None:
            epi_estoque.devolver(
                s,
                entrada=entrada,
                quantidade=quantidade,
                usuario=usuario,
                ficha_registro_id=devolucao.id,
                # `servidor #{id}`, e não o SIAPE, pela mesma razão da baixa da
                # entrega (ver `registrar_entrega`): o motivo vira texto no
                # razão, que é append-only e sai em
                # `/epis/estoque/{id}/movimentos` sob `epi.ver` — permissão que
                # `servidor_consulta` tem só para abrir o catálogo. A entrega
                # parou de gravar matrícula e esta linha continuava gravando; e
                # como toda devolução tem uma entrega antes, as duas linhas do
                # mesmo lote reabriam junto o que a outra metade tinha acabado
                # de fechar — quem quisesse a matrícula devolvia um par de luvas.
                #
                # O SIAPE aqui era redundante além de vazado: `ficha_registro_id`
                # já aponta para a linha da ficha, que diz de quem é a devolução
                # de forma não nominal e resolve o nome para quem pode lê-lo.
                motivo=f"devolução do servidor #{registro.servidor_id}: {limpo}",
            )

    evento = auditoria.registrar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=devolucao.id,
        tipo_evento=EPI_DEVOLVIDO,
        # RN-19 na escrita, como em `registrar_entrega`. A entrega de onde a
        # devolução veio está citada pelo id logo ao lado, e é ela que amarra a
        # linha a uma pessoa para quem pode ler.
        descricao=(
            f"{quantidade} × {registro.nome_epi_snapshot} devolvido(s) pelo "
            f"servidor #{registro.servidor_id} "
            f"· entrega {registro.id} · {limpo}"
        ),
        campo="ficha",
        valor_novo=forma_canonica(devolucao),
        comentario=limpo,
        usuario=usuario,
    )
    devolucao.evento_id = evento.id
    s.flush()
    # RN-32: devolução integral tira a entrega da cobrança de troca — o
    # equipamento voltou, e não há o que substituir. Parcial não tira, e é
    # `_devolvida_ate` quem sabe a diferença. A varredura corre contra HOJE, e
    # não contra `quando`: a devolução pode ser lançada com data retroativa, e
    # perguntar "estava devida naquele dia?" responderia outra pergunta.
    sincronizar_trocas_do_servidor(s, registro.servidor_id, usuario)
    return devolucao


def _ja_estornado(s: Session, registro: EpiFichaRegistro) -> EpiFichaRegistro | None:
    return s.execute(
        select(EpiFichaRegistro).where(
            EpiFichaRegistro.registro_estornado_id == registro.id
        )
    ).scalar_one_or_none()


def devolucoes_de(s: Session, registro: EpiFichaRegistro) -> list[EpiFichaRegistro]:
    """As devoluções que apontam para esta entrega.

    O vínculo mora em `contexto_congelado['registro_devolvido']`, e a busca é em
    Python sobre as linhas do mesmo servidor e do mesmo item — não em SQL sobre
    JSON. São poucas linhas por pessoa e por item, e a alternativa seria uma
    consulta que só o SQLite entende, num sistema cujo dialeto de referência é o
    PostgreSQL.
    """
    return [
        r
        for r in s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == registro.servidor_id,
                EpiFichaRegistro.epi_item_id == registro.epi_item_id,
                EpiFichaRegistro.tipo == "DEVOLUCAO",
            )
        ).scalars()
        if (r.contexto_congelado or {}).get("registro_devolvido") == registro.id
    ]


# =====================================================================
# O comprovante: imprimir, e depois anexar o assinado
# =====================================================================
def imprimir(
    s: Session, usuario: UsuarioAtual, registro: EpiFichaRegistro
) -> tuple[Path, str]:
    """Gera o .docx a partir do congelado e devolve `(caminho, aviso)`.

    Reimprimir tem de dar texto idêntico — mesma disciplina do texto de ouro do
    parecer. A conferência é barata e vale muito: se o texto divergir do da
    primeira impressão, alguma coisa fora do congelado entrou no documento (na
    prática, o `.docx` do modelo trocado por fora). A segunda via sai assim
    mesmo, com aviso, e a divergência entra na trilha — recusar deixaria o setor
    sem o documento **e** sem a informação.
    """
    usuario.exigir("epi.entregar")
    contexto = montar_contexto(registro)
    destino = comprovante_epi.caminho_saida(registro.id, registro.data_evento.year)
    info = comprovante_epi.renderizar(contexto, destino)

    anterior = _hash_da_primeira_impressao(s, registro)
    aviso = ""
    if anterior is not None and anterior != info["hash_conteudo"]:
        aviso = (
            f"O texto reimpresso do comprovante {registro.id} não confere com o "
            "da primeira impressão — o arquivo do modelo provavelmente foi "
            "trocado fora do sistema. A via saiu assim mesmo e a divergência foi "
            "registrada na trilha."
        )
        auditoria.registrar(
            s,
            entidade=EpiFichaRegistro.__tablename__,
            entidade_id=registro.id,
            tipo_evento=EPI_COMPROVANTE_DIVERGENTE,
            descricao=aviso,
            campo="hash_conteudo",
            valor_anterior=anterior,
            valor_novo=info["hash_conteudo"],
            usuario=usuario,
        )

    # imprimir um documento nominal é leitura de dado de pessoa identificada:
    # quem tirou e quando entra na trilha, como na segunda via do certificado
    auditoria.registrar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        tipo_evento=EPI_COMPROVANTE_IMPRESSO,
        # RN-19 na escrita, como em `registrar_entrega` — e aqui com uma ironia
        # que vale registrar: a frase que anunciava a impressão de um documento
        # nominal nomeava a pessoa na trilha, que é a tela que NÃO grava leitura
        # nominal. Quem tem direito ao nome o lê no papel, e a leitura fica em
        # `acesso_dado_sensivel` logo abaixo, que é onde ela pertence.
        descricao=(
            f"Comprovante do registro {registro.id} "
            f"(servidor #{registro.servidor_id} · {contexto.epi_nome}) impresso · "
            f"{info['hash_conteudo'][:12]}"
        ),
        campo="hash_conteudo",
        valor_novo=info["hash_conteudo"],
        usuario=usuario,
    )
    # Aqui havia a divergencia de verdade: esta era a unica das cinco gravacoes
    # de `acesso_dado_sensivel` sem a pergunta "e de outro?" — quem tirasse a
    # via do proprio comprovante entrava na tabela como suspeito do art. 37, que
    # e exatamente o que a 1.35.0 argumentou contra. Ela nasceu antes da decisao
    # e ninguem voltou aqui; e assim que duas regras para a mesma pergunta
    # comecam. A trilha logo acima (`EPI_COMPROVANTE_IMPRESSO`) continua gravando
    # TODA impressao, inclusive a do titular: quantas vias sairam e com que hash
    # e outra pergunta, e essa vale sempre.
    auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="epi_ficha",
        servidor_id=registro.servidor_id,
        finalidade="impressão do comprovante de entrega de EPI para assinatura",
    )
    s.flush()
    return destino, aviso


def _hash_da_primeira_impressao(
    s: Session, registro: EpiFichaRegistro
) -> str | None:
    """O hash que a trilha guardou na primeira vez.

    Fica na trilha, e não numa coluna da ficha, porque a ficha é append-only: uma
    coluna de hash precisaria ser preenchida depois do INSERT, e a trava só abre
    para as três colunas que completam a prova. A trilha já é append-only,
    encadeada e verificada — guardar ali é usar o mecanismo que existe em vez de
    inventar o quarto.
    """
    from app.modelos import HistoricoEvento

    return s.execute(
        select(HistoricoEvento.valor_novo)
        .where(
            HistoricoEvento.entidade == EpiFichaRegistro.__tablename__,
            HistoricoEvento.entidade_id == registro.id,
            HistoricoEvento.tipo_evento == EPI_COMPROVANTE_IMPRESSO,
        )
        .order_by(HistoricoEvento.id)
        .limit(1)
    ).scalar_one_or_none()


def anexar_comprovante(
    s: Session,
    usuario: UsuarioAtual,
    registro: EpiFichaRegistro,
    *,
    conteudo: bytes,
    nome_original: str,
    mime_type: str,
) -> Anexo:
    """O papel assinado, digitalizado, com SHA-256 — e a janela se fecha.

    `assinado=True` e `categoria='FICHA_EPI'` não são rótulo: a categoria é o que
    decide quando o arquivo pode ser eliminado, e `FICHA_EPI` é guarda permanente
    e nasce `RESTRITO` (`docs/POLITICA_RETENCAO.md` §2.3). Anexar como `OUTRO`
    marcaria para eliminação em cinco anos a prova de uma entrega que a
    aposentadoria especial pode pedir décadas depois.

    A linha da ficha aponta para o anexo, e a coluna se preenche **uma vez**: a
    trava do banco aceita nulo → valor e recusa a troca. Comprovante errado se
    corrige por `ESTORNO` e nova entrega, como todo o resto.
    """
    usuario.exigir("epi.entregar")
    if registro.comprovante_anexo_id is not None:
        raise EntregaBloqueada(
            [
                f"o registro {registro.id} já tem comprovante anexado. Trocar a "
                "prova de uma entrega registrada é estorno, não substituição de "
                "arquivo"
            ]
        )
    if registro.tipo == "ESTORNO":
        raise EntregaBloqueada(
            ["estorno não tem comprovante: o papel assinado é o da entrega"]
        )
    if not conteudo:
        raise EntregaBloqueada(["o arquivo do comprovante veio vazio"])

    resultado = servico_anexos.guardar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        nome_original=nome_original,
        conteudo=conteudo,
        mime_type=mime_type,
        categoria=CATEGORIA_ANEXO,
        usuario=usuario,
        assinado=True,
    )
    registro.comprovante_anexo_id = resultado.anexo.id
    registro.recebimento_confirmado_em = agora_utc()
    s.flush()

    auditoria.registrar(
        s,
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        tipo_evento=EPI_COMPROVANTE_ANEXADO,
        # RN-19 na escrita, como em `registrar_entrega`.
        descricao=(
            f"Comprovante assinado do registro {registro.id} "
            f"(servidor #{registro.servidor_id} · {registro.nome_epi_snapshot}) "
            f"· SHA-256 {resultado.anexo.sha256[:12]}"
        ),
        campo="comprovante_anexo_id",
        valor_novo=resultado.anexo.sha256,
        usuario=usuario,
    )
    fechar_pendencia_de_comprovante(s, registro, usuario)
    s.flush()
    return resultado.anexo


# =====================================================================
# A pendência que torna a janela visível (decisão 8)
# =====================================================================
def chave_da_pendencia(registro_id: int) -> str:
    return f"comprovante:ficha:{registro_id}"


def abrir_pendencia_de_comprovante(
    s: Session, registro: EpiFichaRegistro, usuario: UsuarioAtual
):
    """Ficha sem comprovante é pendência, não entrega completa.

    O responsável é quem entregou: é ele que está com o papel na mão e é ele que
    tem de digitalizá-lo. Pendência sem dono é pendência que ninguém fecha.
    """
    return pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_COMPROVANTE,
        chave=chave_da_pendencia(registro.id),
        # RN-19 na escrita, como em `registrar_entrega`, e aqui o caso é o mesmo
        # que `test_privacidade` já reproduz para a pendência do processo: a fila
        # de `/pendencias` é lida por quem tem `pendencia.ver`, sem `sobre` quem,
        # e a frase nominal nascia condenada a chegar lá como "conteúdo
        # suprimido". Com o `#{id}` ela chega legível e sem identificar ninguém.
        descricao=(
            f"Anexar o comprovante assinado de {registro.quantidade} × "
            f"{registro.nome_epi_snapshot} entregue ao "
            f"servidor #{registro.servidor_id} em "
            f"{datas_br.numerica(registro.data_evento)}"
        ),
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        responsavel_id=usuario.id,
        usuario=usuario,
    )


# =====================================================================
# §7.2 — o sentido inverso: pendência, e nunca efeito colateral
# =====================================================================
def chave_da_reavaliacao(vigencia_id: int, registro_id: int) -> str:
    return f"reavaliar_epi:vigencia:{vigencia_id}:ficha:{registro_id}"


def abrir_pendencia_de_reavaliacao(
    s: Session, registro: EpiFichaRegistro, usuario: UsuarioAtual
) -> list:
    """Entrega para quem tem adicional VIGENTE abre tarefa na CSSO. Só isso.

    **Esta função é o lugar onde a negativa do §7.2 fica visível.** O caminho
    que uma integração ingênua tomaria daqui é curto e desastroso: a entrega
    sabe o servidor, o servidor tem `adicional_vigencia` em `VIGENTE`, e o EPI
    "neutraliza" — logo, `suspender(motivo='CESSACAO_RISCO')`. Seria o clique de
    quem opera o almoxarifado cortando o pagamento de alguém, sem laudo, sem
    parecer e sem ninguém habilitado ter olhado o posto.

    O que sai daqui é uma pendência: item de trabalho com dono e prazo. Quem
    decide é quem subscreve laudo e assina parecer (`rbac.pode_subscrever`), e
    a decisão dele mora em `exposicao.epi_neutraliza`, no parecer novo — não
    nesta tabela e não neste módulo.

    O dono é quem emitiu (ou, na falta, quem criou) o parecer que concedeu o
    adicional: é a pessoa da CSSO que já respondeu por aquele direito uma vez, e
    é a ela que cabe olhar de novo. O almoxarife só herda a tarefa no caso em
    que o parecer não registra autor nenhum — parecer migrado da planilha —, e
    aí ele a herda porque `pendencias.abrir` recusa deixar tarefa sem dono, o
    que é o lado certo do erro: pendência sem dono é pendência que ninguém
    fecha.

    Idempotente pela chave — `pendencias.abrir` devolve a existente —, e a chave
    tem os DOIS ids porque a pergunta é por par: cada entrega nova para uma
    vigência viva é um fato novo a reavaliar, e duas entregas na mesma vigência
    não são a mesma tarefa.
    """
    abertas = []
    vigencias = s.execute(
        select(AdicionalVigencia).where(
            AdicionalVigencia.servidor_id == registro.servidor_id,
            AdicionalVigencia.estado == "VIGENTE",
        )
    ).scalars()
    for vigencia in vigencias:
        parecer = vigencia.parecer
        abertas.append(
            pendencias.abrir(
                s,
                tipo=TIPO_PENDENCIA_REAVALIACAO,
                chave=chave_da_reavaliacao(vigencia.id, registro.id),
                # RN-19: o servidor sai pelo id, como em `direito.suspender`. A
                # ficha está a um clique daqui pela âncora `entidade`, e quem
                # tem permissão de ver o nome o vê lá — a fila de tarefas não é
                # tela de dado nominal.
                descricao=(
                    f"Entrega de '{registro.nome_epi_snapshot}' em "
                    f"{datas_br.numerica(registro.data_evento)} ao servidor "
                    f"#{registro.servidor_id}, que tem adicional vigente. "
                    "Avaliar, em parecer, se o EPI neutraliza o agente — "
                    "lembrando que EPI não cessa periculosidade. A entrega, "
                    "sozinha, não altera o direito."
                ),
                entidade=EpiFichaRegistro.__tablename__,
                entidade_id=registro.id,
                parecer_id=vigencia.parecer_id,
                processo_id=parecer.processo_id if parecer is not None else None,
                responsavel_id=(
                    (parecer.emitido_por or parecer.criado_por)
                    if parecer is not None
                    else None
                ),
                usuario=usuario,
            )
        )
    return abertas


def fechar_pendencia_de_comprovante(
    s: Session, registro: EpiFichaRegistro, usuario: UsuarioAtual
) -> None:
    from app.modelos import Pendencia

    pendencia = s.execute(
        select(Pendencia).where(Pendencia.chave == chave_da_pendencia(registro.id))
    ).scalar_one_or_none()
    if pendencia is not None and not pendencia.concluida:
        pendencias.concluir(s, pendencia, usuario)


# =====================================================================
# RN-32 — vida útil e troca devida
# =====================================================================
def _substituida_ate(
    s: Session, registro: EpiFichaRegistro, quando: date
) -> EpiFichaRegistro | None:
    """A entrega POSTERIOR do mesmo item à mesma pessoa — a troca já feita.

    É a terceira das três coisas que desmontam a cobrança, e a mais fácil de
    esquecer: devolução e estorno deixam linha própria apontando para a entrega,
    mas a **substituição** não aponta para nada. Ela é só uma entrega nova, do
    mesmo item, para a mesma pessoa, depois — e é exatamente o que a RN-32 pede
    que aconteça. Cobrar a troca de quem já trocou é o modo mais rápido de a fila
    de pendências virar ruído que ninguém lê.

    Empate de data desempata por `id`, que é a ordem em que as linhas nasceram:
    duas entregas no mesmo dia acontecem (a segunda corrige um tamanho errado),
    e sem o desempate cada uma "substituiria" a outra.
    """
    candidatas = list(
        s.execute(
            select(EpiFichaRegistro).where(
                EpiFichaRegistro.servidor_id == registro.servidor_id,
                EpiFichaRegistro.epi_item_id == registro.epi_item_id,
                EpiFichaRegistro.tipo == "ENTREGA",
                EpiFichaRegistro.data_evento <= quando,
                EpiFichaRegistro.id != registro.id,
            )
        ).scalars()
    )
    posteriores = [
        c
        for c in candidatas
        if (c.data_evento, c.id) > (registro.data_evento, registro.id)
        and _ja_estornado(s, c) is None
    ]
    return min(posteriores, key=lambda r: (r.data_evento, r.id), default=None)


def troca_devida_em(
    s: Session, registro: EpiFichaRegistro, quando: date | None = None
) -> bool:
    """RN-32: a vida útil acabou e ninguém sabe o que a pessoa está usando.

    Três fatos posteriores tiram a linha da cobrança, e cada um por um motivo
    diferente:

    - **estorno**: o setor declarou que aquela entrega não vale. Cobrar troca de
      uma entrega que não aconteceu é inventar dívida;
    - **devolução integral**: o equipamento voltou. Não há o que trocar, e a
      pessoa não está usando nada vencido;
    - **substituição**: já veio um exemplar novo do mesmo item. A troca *foi
      feita* — a linha antiga é o histórico dela, não a cobrança dela.

    Nada disso é gravado: é estado, e estado gravado é estado que envelhece em
    silêncio — a mesma escolha de `LinhaDaFicha` e de `EpiItem.ca_vencido_em`.

    **Não é a mesma pergunta de `LinhaDaFicha.troca_vencida_em`**, e as duas
    convivem de propósito. Aquela é histórica e por linha ("a troca desta entrega
    estava prevista para X e a data passou"), e é o que a ficha etiqueta; esta é
    do presente ("alguém deve uma troca agora?"), e é o que abre tarefa e entra
    no painel. Uma linha substituída continua tendo tido a data vencida, e já não
    deve nada.
    """
    quando = quando or date.today()
    if registro.tipo != "ENTREGA":
        return False
    if registro.previsao_troca is None or registro.previsao_troca >= quando:
        return False
    if _ja_estornado(s, registro) is not None:
        return False
    if _devolvida_ate(s, registro, quando) is not None:
        return False
    return _substituida_ate(s, registro, quando) is None


def trocas_devidas(
    s: Session, *, quando: date | None = None
) -> list[EpiFichaRegistro]:
    """As entregas com troca vencida — a medida de `/epis` e a fila da RN-32.

    O `WHERE` filtra pelo que a coluna sabe responder (`previsao_troca` é coluna
    justamente por isso: JSON não se indexa em SQLite); as três exceções, que
    dependem de outras linhas, ficam em Python, onde se leem.
    """
    quando = quando or date.today()
    linhas = s.execute(
        select(EpiFichaRegistro)
        .where(
            EpiFichaRegistro.tipo == "ENTREGA",
            EpiFichaRegistro.previsao_troca.is_not(None),
            EpiFichaRegistro.previsao_troca < quando,
        )
        .order_by(EpiFichaRegistro.previsao_troca, EpiFichaRegistro.id)
    ).scalars()
    return [r for r in linhas if troca_devida_em(s, r, quando)]


def chave_da_pendencia_de_troca(registro_id: int) -> str:
    return f"troca:ficha:{registro_id}"


def sincronizar_pendencia_de_troca(
    s: Session,
    registro: EpiFichaRegistro,
    usuario: UsuarioAtual | None = None,
    quando: date | None = None,
):
    """Abre a pendência da troca devida, ou a fecha quando ela perdeu o objeto.

    **Disparada por escrita, e não por relógio**, pelo mesmo motivo de
    `epi_estoque.sincronizar_pendencia_de_ca`: o sistema não tem agendador, e
    toda pendência dele nasce de uma gravação. As escritas que mexem nesta
    resposta são as três da ficha — entrega, devolução e estorno —, e é delas
    que a varredura sai.

    O buraco que isso deixa, dito com todas as letras: **um servidor que não
    recebe nada de novo atravessa a data da troca sem abrir pendência.** A troca
    vencida aparece etiquetada na ficha dele desde o primeiro dia (a tela calcula
    o estado na hora) e é contada em `/epis`, que também calcula na hora; o que
    atrasa é a tarefa com dono e prazo. Fechar o buraco pede um agendador, que é
    peça nova e não é desta fatia — e um laço que abrisse pendência a cada GET
    poria como responsável o nome de quem apenas olhou o painel.

    Fecha sozinha quando o fato posterior chega: devolvido, estornado ou
    substituído deixam de dever troca, e a tarefa some da fila sem ninguém
    precisar riscá-la.
    """
    quando = quando or date.today()
    chave = chave_da_pendencia_de_troca(registro.id)
    if not troca_devida_em(s, registro, quando):
        _fechar_pendencia_de_troca(s, chave, usuario)
        return None
    return pendencias.abrir(
        s,
        tipo=TIPO_PENDENCIA_TROCA,
        chave=chave,
        # RN-19: o servidor sai pelo id, como em `abrir_pendencia_de_reavaliacao`
        # e em `direito.suspender`. A ficha está a um clique daqui pela âncora,
        # e quem pode ver o nome o vê lá — a fila de tarefas não é tela nominal.
        descricao=(
            f"A troca de '{registro.nome_epi_snapshot}' entregue ao servidor "
            f"#{registro.servidor_id} em "
            f"{datas_br.numerica(registro.data_evento)} estava prevista para "
            f"{datas_br.numerica(registro.previsao_troca)} e venceu. Entregue o "
            "substituto ou registre a devolução: EPI com troca vencida não "
            "sustenta a alegação de que o agente nocivo está neutralizado "
            "(RN-32)."
        ),
        entidade=EpiFichaRegistro.__tablename__,
        entidade_id=registro.id,
        # o prazo é a própria previsão, e não 30 dias contados de hoje: a data
        # já passou, e a tarefa está atrasada por definição. Mesmo critério da
        # pendência do CA a vencer.
        prazo=registro.previsao_troca,
        usuario=usuario,
    )


def sincronizar_trocas_do_servidor(
    s: Session,
    servidor_id: int,
    usuario: UsuarioAtual | None = None,
    quando: date | None = None,
) -> None:
    """Revê a ficha inteira da pessoa, e não só a linha que acabou de ser escrita.

    É a diferença entre a pendência do CA e esta. Lá a escrita e a resposta são
    do mesmo objeto (o movimento é do lote cuja validade se pergunta); aqui a
    escrita nova é justamente o que **desfaz** a cobrança de uma linha antiga: a
    entrega de hoje é a substituição da bota de 2024, e é a linha de 2024 que
    precisa deixar de cobrar. Sincronizar só a recém-escrita deixaria a tarefa
    velha aberta para sempre.
    """
    quando = quando or date.today()
    registros = s.execute(
        select(EpiFichaRegistro).where(
            EpiFichaRegistro.servidor_id == servidor_id,
            EpiFichaRegistro.tipo == "ENTREGA",
            EpiFichaRegistro.previsao_troca.is_not(None),
        )
    ).scalars()
    for registro in list(registros):
        sincronizar_pendencia_de_troca(s, registro, usuario, quando)
    s.flush()


def _fechar_pendencia_de_troca(
    s: Session, chave: str, usuario: UsuarioAtual | None
) -> None:
    from app.modelos import Pendencia

    pendencia = s.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one_or_none()
    if pendencia is None or pendencia.concluida:
        return
    if usuario is None:
        # sem usuario e a varredura noturna: a tarefa perdeu o objeto e fecha
        # em nome da rotina, nao de uma pessoa (ver `pendencias.concluir_pela_rotina`)
        pendencias.concluir_pela_rotina(s, pendencia, "a troca deixou de ser devida (devolvido, estornado ou substituído)")
        return
    pendencias.concluir(s, pendencia, usuario)


# =====================================================================
# RN-27 — a recusa fundamentada
# =====================================================================
def recusar(
    s: Session,
    usuario: UsuarioAtual,
    *,
    motivo: EpiMotivoRecusa,
    a_quem: str,
    item: EpiItem | None = None,
    unidade: str = "",
    complemento: str = "",
) -> dict:
    """A negativa fundamentada, catalogada e **congelada** na trilha.

    É por aqui que as decisões 3 e 7 viram comportamento de sistema em vez de
    ausência de cadastro: pedido de EPI para terceirizado, estudante ou bolsista
    é recusado com o texto do catálogo, que cita a norma e encaminha. O sistema
    não consegue *detectar* sozinho que o destinatário não é servidor — quem não
    é servidor não está no cadastro, e mantê-lo fora é a decisão. O que ele
    garante é que, uma vez pego na conferência humana, a negativa saia
    fundamentada, uniforme e **contável**.

    O texto vigente é copiado para o evento no ato — editar o catálogo depois não
    reescreve a negativa que o requerente já recebeu (RN-27, mesmo princípio da
    RN-15). Nesta fatia o congelado mora na trilha, e não em
    `epi_requisicao_item.texto_recusa_snapshot`, porque a requisição só nasce na
    fatia 4; a contagem por motivo sai da própria trilha, que é o que a RN-27
    pede.
    """
    usuario.exigir("epi.entregar")
    limpo = textos.exigir_texto_limpo(
        (complemento or "").strip(), campo="complemento da recusa"
    )
    quem = textos.exigir_texto_limpo(
        (a_quem or "").strip(), campo="a quem a recusa se dirige"
    )
    if not quem:
        raise EntregaBloqueada(
            [
                "diga a quem a recusa se dirige: sem isso o registro não serve "
                "para mostrar o padrão dos pedidos que o setor precisa recusar"
            ]
        )
    if not motivo.ativo:
        raise EntregaBloqueada([f"o motivo {motivo.codigo} está inativo no catálogo"])
    if motivo.exige_complemento and not limpo:
        raise EntregaBloqueada(
            [f"o motivo {motivo.codigo} exige o complemento por escrito"]
        )

    congelado = {
        "motivo": motivo.codigo,
        "rotulo": motivo.rotulo,
        # o texto vai INTEIRO: é ele que sai literal para quem pediu, e um
        # ponteiro para o catálogo mudaria de conteúdo junto com o catálogo
        "texto": motivo.texto,
        "base_normativa": motivo.base_normativa,
        "complemento": limpo or None,
        "a_quem": quem,
        "unidade": (unidade or "").strip() or None,
        "item": item.nome if item is not None else None,
        "data": date.today().isoformat(),
    }
    auditoria.registrar(
        s,
        entidade=EpiMotivoRecusa.__tablename__,
        entidade_id=motivo.id,
        tipo_evento=EPI_ENTREGA_RECUSADA,
        descricao=(
            f"Fornecimento recusado a {quem}"
            + (f" ({item.nome})" if item is not None else "")
            + f": {motivo.rotulo}"
        ),
        campo="motivo_recusa",
        # o código em `valor_novo` é o que faz a contagem por motivo sair da
        # trilha sem depender de casar texto
        valor_novo=congelado,
        comentario=limpo or None,
        usuario=usuario,
    )
    s.flush()
    return congelado


__all__ = [
    "CATEGORIA_ANEXO",
    "EPI_COMPROVANTE_ANEXADO",
    "EPI_COMPROVANTE_DIVERGENTE",
    "EPI_COMPROVANTE_IMPRESSO",
    "EPI_DEVOLVIDO",
    "EPI_ENTREGA_RECUSADA",
    "EPI_ENTREGUE",
    "EPI_ESTORNADO",
    "EPI_MAXIMO_EXCEDIDO",
    "TIPO_PENDENCIA_COMPROVANTE",
    "TIPO_PENDENCIA_REAVALIACAO",
    "TIPO_PENDENCIA_TROCA",
    "Divergencia",
    "EntregaBloqueada",
    "LinhaDaFicha",
    "RegistroFicha",
    "Validacao",
    "abrir_pendencia_de_comprovante",
    "abrir_pendencia_de_reavaliacao",
    "anexar_comprovante",
    "chave_da_pendencia",
    "chave_da_pendencia_de_troca",
    "chave_da_reavaliacao",
    "conferir",
    "devolucoes_de",
    "em_poder_de",
    "entregas_ate",
    "entregue_na_janela",
    "estornar",
    "fechar_pendencia_de_comprovante",
    "forma_canonica",
    "imprimir",
    "linha_do_tempo",
    "montar_contexto",
    "montar_contexto_para_entregar",
    "recusar",
    "registrar_devolucao",
    "registrar_entrega",
    "registros_de",
    "servidores_com_ficha",
    "sincronizar_pendencia_de_troca",
    "sincronizar_trocas_do_servidor",
    "troca_devida_em",
    "trocas_devidas",
    "validar",
]
