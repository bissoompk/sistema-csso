"""Fatia 6 de Gestão de EPI: a ligação com o adicional ocupacional (§7).

Esta é a fatia que toca a competência central do sistema, e ela carrega uma
regra que, errada, produz decisão ilegal em série. O que estes testes protegem,
em ordem de gravidade:

1. **EPI neutraliza insalubridade; EPI não cessa periculosidade.** A
   insalubridade é exposição gradual a agente que o equipamento pode barrar
   abaixo do limite de tolerância; a periculosidade é risco de acidente, e ali o
   EPI reduz a consequência, não a existência do risco. Testado nos dois
   sentidos: a periculosidade tem de ser recusada, e a insalubridade tem de
   passar — uma trava que recusa tudo protegeria igual e serviria para nada.
2. **A negativa do §7.2: o módulo de EPI nunca escreve em `adicional_vigencia`.**
   Provada, e não comentada. Se uma entrega pudesse cessar um adicional, o
   clique de quem opera o almoxarifado cortaria o pagamento de alguém.
3. **A consulta responde pela data pedida, não por hoje.** Um CA que valia no
   dia da avaliação e venceu depois não desmente o parecer; o contrário, sim.
4. **A prova congelada.** Entrega feita depois da emissão não reescreve o
   fundamento de um parecer assinado.
"""

from __future__ import annotations

import ast
from datetime import date, timedelta
from pathlib import Path

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError

from app.config import RAIZ
from app.modelos import (
    AdicionalVigencia,
    AgenteNocivo,
    Cargo,
    EpiCategoria,
    EpiEntradaEstoque,
    EpiItem,
    EpiMotivoRecusa,
    EpiMovimentoEstoque,
    Exposicao,
    ParecerTecnico,
    PercentualAplicavel,
    Pendencia,
    Servidor,
    TipoAdicional,
    UnidadeUorg,
)
from app.servicos import epi_ficha, parecer as servico
from app.servicos.rbac import UsuarioAtual
from testes.integracao import papeis

HOJE = date.today()
ENTREGA = date(2024, 10, 1)
AVALIACAO = date(2025, 2, 11)
CA_VENCE_ANTES = date(2024, 12, 31)  # valia na entrega, vencido na avaliação
CA_VENCE_DEPOIS = date(2030, 1, 1)


# =====================================================================
# Cenário
# =====================================================================
def _almoxarife(atores) -> UsuarioAtual:
    """Quem entrega EPI e NÃO decide adicional — é esse o ponto do §7.2."""
    return UsuarioAtual(
        id=atores["fatima"].id,
        login="fatima",
        nome="Fátima",
        permissoes=frozenset(
            {"epi.ver", "epi.entregar", "epi.estoque", "epi.ficha"}
        ),
        perfis=("almoxarife_sesmt",),
    )


def _habilitar_coordenador(sessao, atores) -> None:
    """RN-01: alegar neutralização exige habilitação técnica vigente."""
    from app.modelos import ProfissionalHabilitado

    habilitado = sessao.execute(
        select(ProfissionalHabilitado).where(
            ProfissionalHabilitado.nome == "Fabrício Raimundi Andrade"
        )
    ).scalar_one()
    habilitado.usuario_id = atores["coord"].id
    sessao.flush()


def _lote(sessao, *, validade_ca: date, vida_util_meses: int | None = 6):
    categoria = sessao.execute(
        select(EpiCategoria).where(EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES")
    ).scalar_one()
    item = EpiItem(
        nome="Luva de proteção química nitrílica",
        categoria_id=categoria.id,
        fabricante="Fabricante Exemplo Ltda",
        exige_ca=True,
        numero_ca="41234",
        validade_ca=validade_ca,
        unidade_medida="PAR",
        vida_util_meses=vida_util_meses,
    )
    sessao.add(item)
    sessao.flush()
    entrada = EpiEntradaEstoque(
        epi_item_id=item.id,
        tamanho="M",
        data_entrada=ENTREGA - timedelta(days=30),
        quantidade_recebida=20,
        lote="L-2024-09",
        numero_ca="41234",
        validade_ca=validade_ca,
    )
    sessao.add(entrada)
    sessao.flush()
    sessao.add(
        EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=20)
    )
    sessao.flush()
    return item, entrada


def _entregar(sessao, atores, cenario, *, item, entrada, quando=ENTREGA, quantidade=2):
    return epi_ficha.registrar_entrega(
        sessao,
        _almoxarife(atores),
        servidor=cenario["servidor"],
        item=item,
        quantidade=quantidade,
        entrada=entrada,
        tamanho="M",
        data_evento=quando,
    )


def _parecer_de_periculosidade(sessao, cenario) -> tuple[ParecerTecnico, Exposicao]:
    """O mesmo servidor, outro parecer — e outro adicional.

    Precisa existir para o teste da trava: sem um parecer de periculosidade não
    há como provar que a recusa acontece, e um teste que só exercita o caminho
    permitido não protege nada.
    """
    periculosidade = sessao.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "PERICULOSIDADE")
    ).scalar_one()
    unico = sessao.execute(
        select(PercentualAplicavel).where(
            PercentualAplicavel.tipo_adicional_id == periculosidade.id
        )
    ).scalars().first()
    agente = sessao.execute(select(AgenteNocivo)).scalars().first()
    base = cenario["parecer"]
    parecer = ParecerTecnico(
        # `uq_parecer` é (numero, ano) e o parecer do fixture já ocupa o 0/2025
        numero=99,
        ano=2025,
        situacao="RASCUNHO",
        processo_id=base.processo_id,
        servidor_id=base.servidor_id,
        laudo_id=base.laudo_id,
        tipo_adicional_id=periculosidade.id,
        unidade_uorg_id=base.unidade_uorg_id,
        criado_por=None,
    )
    sessao.add(parecer)
    sessao.flush()
    exposicao = Exposicao(
        parecer_id=parecer.id,
        agente_nocivo_id=agente.id,
        percentual_id=unico.id,
        fundamentacao_id=agente.fundamentacao_id,
        principal=True,
    )
    sessao.add(exposicao)
    sessao.flush()
    return parecer, exposicao


def _vigencia_vigente(sessao, cenario) -> AdicionalVigencia:
    parecer = cenario["parecer"]
    exposicao = parecer.exposicoes[0]
    vigencia = AdicionalVigencia(
        servidor_id=cenario["servidor"].id,
        parecer_id=parecer.id,
        tipo_adicional_id=parecer.tipo_adicional_id,
        percentual_id=exposicao.percentual_id,
        estado="VIGENTE",
        data_inicio=date(2024, 9, 17),
    )
    sessao.add(vigencia)
    sessao.flush()
    return vigencia


# =====================================================================
# 1. A regra que não pode sair errada (§7.1)
# =====================================================================
def test_epi_nao_cessa_periculosidade(sessao, cenario, atores):
    """A trava do §7.1 no sentido que produz decisão ilegal se falhar.

    O EPI reduz a consequência do acidente — a luva isolante evita a queimadura
    —, não a existência do risco: o circuito continua energizado. Aceitar
    `NEUTRALIZA` aqui cessaria o adicional de quem continua exposto ao risco.
    """
    _habilitar_coordenador(sessao, atores)
    _parecer, exposicao = _parecer_de_periculosidade(sessao, cenario)

    with pytest.raises(servico.AvaliacaoDeEpiRecusada) as erro:
        servico.registrar_avaliacao_de_epi(
            sessao,
            _parecer,
            exposicao,
            papeis.COORDENADOR,
            valor="NEUTRALIZA",
            justificativa="luva isolante classe 2 com CA vigente",
        )
    assert "não cessa periculosidade" in str(erro.value)
    sessao.refresh(exposicao)
    assert exposicao.epi_neutraliza == "NAO_AVALIADO"
    assert exposicao.justificativa_epi is None
    assert exposicao.epi_avaliado_em is None


def test_periculosidade_ainda_aceita_dizer_que_nao_neutraliza(sessao, cenario, atores):
    """A trava fecha só o que tira direito.

    `NAO_NEUTRALIZA` é o registro de que a CSSO olhou e não encontrou
    neutralização — travá-lo deixaria o setor sem como documentar a conferência
    que a fiscalização vai pedir.
    """
    _habilitar_coordenador(sessao, atores)
    parecer, exposicao = _parecer_de_periculosidade(sessao, cenario)

    servico.registrar_avaliacao_de_epi(
        sessao, parecer, exposicao, papeis.COORDENADOR, valor="NAO_NEUTRALIZA"
    )
    assert exposicao.epi_neutraliza == "NAO_NEUTRALIZA"
    assert exposicao.epi_avaliado_em == date.today()


def test_epi_neutraliza_insalubridade(sessao, cenario, atores):
    """O outro sentido: uma trava que recusasse tudo não protegeria nada."""
    _habilitar_coordenador(sessao, atores)
    parecer = cenario["parecer"]
    exposicao = parecer.exposicoes[0]
    assert parecer.tipo_adicional.codigo == "INSALUBRIDADE"

    servico.registrar_avaliacao_de_epi(
        sessao,
        parecer,
        exposicao,
        papeis.COORDENADOR,
        valor="NEUTRALIZA_PARCIAL",
        justificativa=(
            "respirador semifacial com filtro P3, CA vigente na data da avaliação"
        ),
        quando=AVALIACAO,
    )
    assert exposicao.epi_neutraliza == "NEUTRALIZA_PARCIAL"
    assert exposicao.epi_avaliado_em == AVALIACAO
    assert "filtro P3" in exposicao.justificativa_epi


def test_os_radiologicos_nao_sao_neutralizaveis(sessao, cenario, atores):
    """Radiação ionizante é risco de acidente, e o §7.1 a nomeia como tal.

    Blindagem e avental plumbífero diminuem a dose; não fazem a fonte deixar de
    existir. A lista branca de `CODIGOS_NEUTRALIZAVEIS_POR_EPI` existe para que
    um código novo no catálogo não nasça neutralizável por omissão.
    """
    assert servico.CODIGOS_NEUTRALIZAVEIS_POR_EPI == frozenset({"INSALUBRIDADE"})
    for codigo in ("PERICULOSIDADE", "IRRADIACAO_IONIZANTE", "RAIOS_X"):
        assert codigo not in servico.CODIGOS_NEUTRALIZAVEIS_POR_EPI


def test_alegar_neutralizacao_exige_habilitacao_vigente(sessao, cenario, atores):
    """RN-01 e §7.2: quem decide é quem subscreve laudo e assina parecer."""
    parecer = cenario["parecer"]
    exposicao = parecer.exposicoes[0]
    # sem `_habilitar_coordenador`: ninguém tem habilitação amarrada ao usuário
    with pytest.raises(servico.AvaliacaoDeEpiRecusada):
        servico.registrar_avaliacao_de_epi(
            sessao,
            parecer,
            exposicao,
            papeis.COORDENADOR,
            valor="NEUTRALIZA",
            justificativa="máscara PFF2",
        )
    assert exposicao.epi_neutraliza == "NAO_AVALIADO"


def test_neutralizar_sem_justificativa_e_recusado(sessao, cenario, atores):
    _habilitar_coordenador(sessao, atores)
    parecer = cenario["parecer"]
    with pytest.raises(servico.AvaliacaoDeEpiRecusada) as erro:
        servico.registrar_avaliacao_de_epi(
            sessao, parecer, parecer.exposicoes[0], papeis.COORDENADOR,
            valor="NEUTRALIZA", justificativa="   ",
        )
    assert "justificativa" in str(erro.value)


def test_ck_exposicao_epi_justificada_cobra_o_porque_no_banco(sessao, cenario):
    """A CHECK do §7.2, exercitada por fora do serviço.

    A regra de serviço protege a porta da frente; a CHECK protege o banco de
    quem entra por qualquer outra — importação, correção manual, script.
    """
    exposicao = cenario["parecer"].exposicoes[0]
    exposicao.epi_neutraliza = "NEUTRALIZA"
    exposicao.justificativa_epi = None
    with pytest.raises(IntegrityError) as erro:
        sessao.flush()
    assert "ck_exposicao_epi_justificada" in str(erro.value)
    sessao.rollback()


def test_ck_exposicao_epi_fecha_o_dominio(sessao, cenario):
    exposicao = cenario["parecer"].exposicoes[0]
    exposicao.epi_neutraliza = "TALVEZ"
    with pytest.raises(IntegrityError) as erro:
        sessao.flush()
    assert "ck_exposicao_epi" in str(erro.value)
    sessao.rollback()


# =====================================================================
# 2. A consulta: responde pela data pedida, e não por hoje
# =====================================================================
def test_entregas_ate_le_o_ca_na_data_pedida_e_nao_hoje(sessao, cenario, atores):
    """O CA valia na entrega e venceu antes da avaliação — e a consulta sabe.

    As duas leituras saem da MESMA linha da ficha. O que muda é só a data
    perguntada, e é isso que faz o parecer de 2025 continuar dizendo em 2026 o
    que dizia quando foi escrito.
    """
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_ANTES)
    _entregar(sessao, atores, cenario, item=item, entrada=entrada)
    servidor_id = cenario["servidor"].id

    antes = epi_ficha.entregas_ate(sessao, servidor_id, date(2024, 11, 1))
    assert len(antes) == 1
    assert antes[0].ca_vencido is False
    assert antes[0].sustenta_neutralizacao is True

    depois = epi_ficha.entregas_ate(sessao, servidor_id, AVALIACAO)
    assert len(depois) == 1
    assert depois[0].ca_vencido is True
    assert depois[0].sustenta_neutralizacao is False
    assert "31/12/2024" in " ".join(depois[0].ressalvas)

    # e a prova de que não está lendo `date.today()`: hoje o CA está vencido nos
    # dois casos, e a primeira leitura disse que não estava
    assert CA_VENCE_ANTES < HOJE


def test_troca_vencida_na_data_da_avaliacao_nao_sustenta(sessao, cenario, atores):
    """RN-32: passada a vida útil, ninguém afirma o que a pessoa está usando."""
    item, entrada = _lote(
        sessao, validade_ca=CA_VENCE_DEPOIS, vida_util_meses=2
    )
    _entregar(sessao, atores, cenario, item=item, entrada=entrada)

    linhas = epi_ficha.entregas_ate(sessao, cenario["servidor"].id, AVALIACAO)
    assert linhas[0].previsao_troca == date(2024, 12, 1)
    assert linhas[0].ca_vencido is False
    assert linhas[0].troca_vencida is True
    assert linhas[0].sustenta_neutralizacao is False
    assert "RN-32" in " ".join(linhas[0].ressalvas)


def test_entrega_estornada_nao_sustenta_nada(sessao, cenario, atores):
    """Estorno declara que a entrega não vale — e isso não tem data de início."""
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    registro = _entregar(sessao, atores, cenario, item=item, entrada=entrada)
    epi_ficha.estornar(
        sessao, _almoxarife(atores), registro, "lançada no servidor errado"
    )
    assert epi_ficha.entregas_ate(sessao, cenario["servidor"].id, AVALIACAO) == []


def test_entrega_posterior_a_data_pedida_fica_de_fora(sessao, cenario, atores):
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    _entregar(sessao, atores, cenario, item=item, entrada=entrada, quando=HOJE)
    assert epi_ficha.entregas_ate(sessao, cenario["servidor"].id, AVALIACAO) == []


def test_o_filtro_por_posto_vai_pela_lotacao_da_data(sessao, cenario, atores):
    """`posto_id` responde "recebeu enquanto estava NAQUELE posto".

    Vai pelo vínculo da lotação, e não por casar o texto de `posto_snapshot` —
    que existe para sair impresso no comprovante, não para servir de chave.
    """
    from app.modelos import LotacaoPosto, PostoTrabalho, ServidorLotacao

    postos = list(sessao.execute(select(PostoTrabalho)).scalars())
    lotacao = ServidorLotacao(
        servidor_id=cenario["servidor"].id,
        unidade_uorg_id=cenario["servidor"].unidade_uorg_id,
        vigencia_inicio=date(2024, 1, 1),
    )
    sessao.add(lotacao)
    sessao.flush()
    sessao.add(LotacaoPosto(lotacao_id=lotacao.id, posto_trabalho_id=postos[0].id))
    sessao.flush()

    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    _entregar(sessao, atores, cenario, item=item, entrada=entrada)
    servidor_id = cenario["servidor"].id

    assert len(epi_ficha.entregas_ate(sessao, servidor_id, AVALIACAO)) == 1
    assert (
        len(
            epi_ficha.entregas_ate(
                sessao, servidor_id, AVALIACAO, posto_id=postos[0].id
            )
        )
        == 1
    )
    assert (
        epi_ficha.entregas_ate(
            sessao, servidor_id, AVALIACAO, posto_id=postos[1].id
        )
        == []
    )


# =====================================================================
# 3. A prova congelada (§7.2)
# =====================================================================
def test_entrega_depois_da_emissao_nao_reescreve_o_congelado(sessao, cenario, atores):
    """Imutabilidade: o parecer assinado carrega a evidência do dia em que saiu.

    Sem isto, uma entrega registrada meses depois apareceria como fundamento de
    um documento que ninguém reabriu — e o parecer passaria a alegar coisa
    diferente da que o signatário leu.
    """
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    _entregar(sessao, atores, cenario, item=item, entrada=entrada)

    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    congelado = parecer.contexto_congelado["epi"]
    assert congelado["referencia"] == AVALIACAO.isoformat()
    assert len(congelado["fichas"]) == 1
    assert congelado["fichas"][0]["ca"] == "41234"
    assert congelado["fichas"][0]["entregue_em"] == ENTREGA.isoformat()
    assert congelado["exposicoes"][0]["epi_neutraliza"] == "NAO_AVALIADO"

    # a entrega nova é fato do mundo, posterior — e não toca o documento
    _entregar(sessao, atores, cenario, item=item, entrada=entrada, quando=HOJE)
    sessao.refresh(parecer)
    assert parecer.contexto_congelado["epi"] == congelado

    # e a leitura de hoje enxerga as duas: o congelado não é a ficha, é a prova
    assert len(epi_ficha.entregas_ate(sessao, cenario["servidor"].id, HOJE)) == 2


def test_a_chave_epi_nao_muda_o_texto_do_documento(sessao, cenario, atores):
    """A prova entra AO LADO do que o modelo renderiza, não dentro.

    `ContextoParecer.descongelar` lê só `CAMPOS_CONGELADOS`; a chave nova é
    evidência anexa. Se ela entrasse no contexto do .docx, acrescentar prova
    mudaria o texto do parecer — e o texto de ouro existe para isso não passar.
    """
    parecer = cenario["parecer"]
    servico.emitir(sessao, parecer, papeis.COORDENADOR, gerar_pdf=False)
    assert "epi" in parecer.contexto_congelado
    contexto = servico.montar_contexto(sessao, parecer)
    assert not hasattr(contexto, "epi")
    assert "epi" not in contexto.como_dicionario()


# =====================================================================
# 4. O sentido inverso: pendência, e nunca efeito colateral (§7.2)
# =====================================================================
def test_entrega_para_quem_tem_adicional_vigente_abre_pendencia(
    sessao, cenario, atores
):
    parecer = cenario["parecer"]
    parecer.criado_por = atores["coord"].id
    vigencia = _vigencia_vigente(sessao, cenario)
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    registro = _entregar(sessao, atores, cenario, item=item, entrada=entrada)

    chave = f"reavaliar_epi:vigencia:{vigencia.id}:ficha:{registro.id}"
    assert epi_ficha.chave_da_reavaliacao(vigencia.id, registro.id) == chave
    pendencia = sessao.execute(
        select(Pendencia).where(Pendencia.chave == chave)
    ).scalar_one()
    assert pendencia.tipo == "REAVALIAR_ADICIONAL_POR_EPI"
    assert pendencia.prazo == date.today() + timedelta(days=90)
    # o dono é a CSSO, e não quem operou o almoxarifado
    assert pendencia.responsavel_id == atores["coord"].id
    assert pendencia.responsavel_id != _almoxarife(atores).id
    # e o texto diz o que a pessoa tem de fazer, sem decidir por ela
    assert "não altera o direito" in pendencia.descricao
    assert "não cessa periculosidade" in pendencia.descricao


def test_a_pendencia_de_reavaliacao_abre_uma_vez_so(sessao, cenario, atores):
    """Idempotência pelo mecanismo que `pendencias.abrir` já tem."""
    vigencia = _vigencia_vigente(sessao, cenario)
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    registro = _entregar(sessao, atores, cenario, item=item, entrada=entrada)

    chave = epi_ficha.chave_da_reavaliacao(vigencia.id, registro.id)
    de_novo = epi_ficha.abrir_pendencia_de_reavaliacao(
        sessao, registro, _almoxarife(atores)
    )
    epi_ficha.abrir_pendencia_de_reavaliacao(sessao, registro, _almoxarife(atores))
    sessao.flush()

    abertas = list(
        sessao.execute(select(Pendencia).where(Pendencia.chave == chave)).scalars()
    )
    assert len(abertas) == 1
    assert de_novo[0].id == abertas[0].id


def test_sem_adicional_vigente_nao_abre_pendencia(sessao, cenario, atores):
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    _entregar(sessao, atores, cenario, item=item, entrada=entrada)
    assert (
        sessao.execute(
            select(Pendencia).where(
                Pendencia.tipo == "REAVALIAR_ADICIONAL_POR_EPI"
            )
        ).scalars().all()
        == []
    )


# =====================================================================
# 5. A negativa mais importante, provada
# =====================================================================
def test_nenhuma_operacao_do_epi_escreve_em_adicional_vigencia(
    sessao, cenario, atores
):
    """Prova de execução: os caminhos de escrita do módulo, todos, e nada muda.

    Entrega, estorno, devolução, anexação do comprovante e recusa fundamentada —
    com um adicional VIGENTE do lado, que é exatamente a situação em que uma
    integração ingênua chamaria `direito.suspender(motivo='CESSACAO_RISCO')`.

    O ouvinte é de mapper, e não uma comparação de campos no fim: comparar
    valores no fim deixaria passar uma escrita que gravasse o mesmo valor, e o
    que se quer provar não é que o estado ficou igual — é que **ninguém
    escreveu**.
    """
    vigencia = _vigencia_vigente(sessao, cenario)
    item, entrada = _lote(sessao, validade_ca=CA_VENCE_DEPOIS)
    almoxarife = _almoxarife(atores)
    motivo = sessao.execute(
        select(EpiMotivoRecusa).where(
            EpiMotivoRecusa.codigo == "VINCULO_NAO_ATENDIDO"
        )
    ).scalar_one()

    escritas: list[str] = []

    def _anotar(_mapper, _conexao, _alvo):
        escritas.append("escreveu")

    for nome in ("after_insert", "after_update", "after_delete"):
        event.listen(AdicionalVigencia, nome, _anotar)
    try:
        um = _entregar(sessao, atores, cenario, item=item, entrada=entrada)
        epi_ficha.anexar_comprovante(
            sessao,
            almoxarife,
            um,
            conteudo=b"%PDF-1.4 comprovante assinado",
            nome_original="comprovante.pdf",
            mime_type="application/pdf",
        )
        dois = _entregar(sessao, atores, cenario, item=item, entrada=entrada)
        epi_ficha.estornar(sessao, almoxarife, dois, "lote trocado no balcão")
        tres = _entregar(sessao, atores, cenario, item=item, entrada=entrada)
        epi_ficha.registrar_devolucao(
            sessao, almoxarife, tres, quantidade=1, motivo="desgaste", data_evento=HOJE
        )
        epi_ficha.recusar(
            sessao, almoxarife, motivo=motivo, a_quem="terceirizado da limpeza"
        )
        sessao.flush()
    finally:
        for nome in ("after_insert", "after_update", "after_delete"):
            event.remove(AdicionalVigencia, nome, _anotar)

    assert escritas == []
    sessao.refresh(vigencia)
    assert vigencia.estado == "VIGENTE"
    assert vigencia.data_fim is None
    assert vigencia.motivo_suspensao is None


# ---------------------------------------------------------------------
# ... e a metade estática, que alcança os caminhos que o teste acima não roda
# ---------------------------------------------------------------------
ARQUIVOS_DO_EPI = sorted(
    {
        *Path(RAIZ).glob("app/servicos/epi_*.py"),
        *Path(RAIZ).glob("app/servicos/comprovante_epi.py"),
        *Path(RAIZ).glob("app/rotas/epi*.py"),
    }
)


def _nomes_ligados_a_vigencia(arvore: ast.AST) -> set[str]:
    """Os nomes locais que carregam um `AdicionalVigencia`, por ponto fixo.

    A propagação é deliberadamente curta — origem que MENCIONA a classe, ou que
    é exatamente um nome já rastreado (o `for vigencia in vigencias`). Seguir
    atributos (`parecer = vigencia.parecer`) espalharia o rastreamento pelo
    módulo inteiro e transformaria a trava numa fonte de falso positivo. O que
    escapa desta metade é pego pela outra, que ouve o mapper em execução.
    """
    nomes: set[str] = set()
    while True:
        antes = len(nomes)
        for no in ast.walk(arvore):
            origem = None
            alvos: list[ast.AST] = []
            if isinstance(no, ast.Assign):
                origem, alvos = no.value, list(no.targets)
            elif isinstance(no, ast.AnnAssign) and no.value is not None:
                origem, alvos = no.value, [no.target]
            elif isinstance(no, (ast.For, ast.AsyncFor)):
                origem, alvos = no.iter, [no.target]
            elif isinstance(no, ast.comprehension):
                origem, alvos = no.iter, [no.target]
            if origem is None:
                continue
            texto = ast.unparse(origem)
            ligada = "AdicionalVigencia" in texto or (
                isinstance(origem, ast.Name) and origem.id in nomes
            )
            if not ligada:
                continue
            for alvo in alvos:
                for parte in ast.walk(alvo):
                    if isinstance(parte, ast.Name):
                        nomes.add(parte.id)
        if len(nomes) == antes:
            return nomes


def test_o_modulo_de_epi_nao_tem_caminho_de_escrita_no_adicional():
    """Prova estática da negativa do §7.2, arquivo por arquivo.

    Quatro coisas ficam proibidas nos módulos de EPI, e cada uma é uma forma
    diferente de a mesma escrita entrar:

    1. importar `app.servicos.direito`, que é o único serviço que escreve em
       `adicional_vigencia` — suspender, cessar e alterar moram lá;
    2. construir `AdicionalVigencia(...)`;
    3. atribuir a atributo de um objeto que veio de uma consulta àquela tabela;
    4. mandar SQL cru de `UPDATE`/`INSERT`/`DELETE` para a tabela.

    Ler é permitido, e é o que a pendência de reavaliação faz: ela precisa saber
    que existe adicional vigente para abrir a tarefa. Ler e escrever é que são
    coisas diferentes — e é a segunda que cortaria o pagamento de alguém.
    """
    assert len(ARQUIVOS_DO_EPI) >= 8, (
        "a lista de arquivos do módulo de EPI esvaziou — renomeação silenciosa "
        "desligaria esta trava sem nenhum teste ficar vermelho"
    )
    proibicoes: list[str] = []
    for arquivo in ARQUIVOS_DO_EPI:
        arvore = ast.parse(arquivo.read_text(encoding="utf-8"))
        nomes = _nomes_ligados_a_vigencia(arvore)
        onde = arquivo.name
        for no in ast.walk(arvore):
            if isinstance(no, ast.ImportFrom) and no.module:
                if no.module.endswith("servicos") and any(
                    a.name == "direito" for a in no.names
                ):
                    proibicoes.append(f"{onde}: importa o serviço `direito`")
                if no.module.endswith("servicos.direito"):
                    proibicoes.append(f"{onde}: importa o serviço `direito`")
            if isinstance(no, ast.Import) and any(
                a.name.endswith("servicos.direito") for a in no.names
            ):
                proibicoes.append(f"{onde}: importa o serviço `direito`")
            if (
                isinstance(no, ast.Call)
                and isinstance(no.func, ast.Name)
                and no.func.id == "AdicionalVigencia"
            ):
                proibicoes.append(f"{onde}: constrói AdicionalVigencia")
            if isinstance(no, (ast.Assign, ast.AugAssign)):
                alvos = no.targets if isinstance(no, ast.Assign) else [no.target]
                for alvo in alvos:
                    if (
                        isinstance(alvo, ast.Attribute)
                        and isinstance(alvo.value, ast.Name)
                        and alvo.value.id in nomes
                    ):
                        proibicoes.append(
                            f"{onde}: escreve em {alvo.value.id}.{alvo.attr}"
                        )
            if (
                isinstance(no, ast.Call)
                and isinstance(no.func, ast.Attribute)
                and no.func.attr in ("add", "add_all", "delete", "merge")
            ):
                for argumento in no.args:
                    if isinstance(argumento, ast.Name) and argumento.id in nomes:
                        proibicoes.append(
                            f"{onde}: {no.func.attr}({argumento.id}) na sessão"
                        )
            if isinstance(no, ast.Constant) and isinstance(no.value, str):
                bruto = no.value.lower()
                if "adicional_vigencia" in bruto and any(
                    verbo in bruto for verbo in ("update ", "insert ", "delete ")
                ):
                    proibicoes.append(f"{onde}: SQL de escrita em adicional_vigencia")
    assert proibicoes == []


# =====================================================================
# 6. O painel do editor — a tela DIZ, em vez de deixar concluir
# =====================================================================
def _montar_para_a_tela(*, codigo_adicional: str, validade_ca: date) -> dict:
    """Um parecer, uma exposição e uma entrega — em sessão que fecha.

    Montado assim, e não pelo fixture `cenario`, porque `app_cliente` abre as
    próprias sessões por requisição: duas sessões vivas ao mesmo tempo disputam
    o lock de escrita do SQLite, que é o aviso do `banco.py`.
    """
    from app import banco as mod_banco
    from app.modelos import LaudoTecnico, Processo, TipoProcesso, FluxoEtapa

    with mod_banco.sessao() as s:
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        adicional = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == codigo_adicional)
        ).scalar_one()
        percentual = s.execute(
            select(PercentualAplicavel).where(
                PercentualAplicavel.tipo_adicional_id == adicional.id
            )
        ).scalars().first()
        agente = s.execute(select(AgenteNocivo)).scalars().first()
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "EM_ANDAMENTO")
        ).scalar_one()
        tipo = s.execute(
            select(TipoProcesso).where(
                TipoProcesso.codigo == "ADICIONAL_OCUPACIONAL"
            )
        ).scalar_one()

        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(servidor)
        s.flush()
        processo = Processo(
            nup="23086.021284/2024-56",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="PARECER_EM_ELABORACAO",
            servidor_id=servidor.id,
            unidade_uorg_id=unidade.id,
            data_autuacao=date(2024, 10, 1),
        )
        laudo = LaudoTecnico(
            numero_siape="26255-000.125/2019",
            ano=2019,
            tipo_adicional_id=adicional.id,
            unidade_uorg_id=unidade.id,
            data_emissao=date(2019, 6, 1),
        )
        s.add_all([processo, laudo])
        s.flush()
        parecer = ParecerTecnico(
            numero=0,
            ano=2025,
            situacao="RASCUNHO",
            processo_id=processo.id,
            servidor_id=servidor.id,
            laudo_id=laudo.id,
            tipo_adicional_id=adicional.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(parecer)
        s.flush()
        exposicao = Exposicao(
            parecer_id=parecer.id,
            agente_nocivo_id=agente.id,
            percentual_id=percentual.id,
            fundamentacao_id=agente.fundamentacao_id,
            principal=True,
            data_avaliacao=AVALIACAO,
        )
        s.add(exposicao)

        categoria = s.execute(
            select(EpiCategoria).where(
                EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES"
            )
        ).scalar_one()
        item = EpiItem(
            nome="Luva de proteção química nitrílica",
            categoria_id=categoria.id,
            exige_ca=True,
            numero_ca="41234",
            validade_ca=validade_ca,
            unidade_medida="PAR",
            vida_util_meses=6,
        )
        s.add(item)
        s.flush()
        entrada = EpiEntradaEstoque(
            epi_item_id=item.id,
            data_entrada=ENTREGA - timedelta(days=30),
            quantidade_recebida=20,
            lote="L-2024-09",
            numero_ca="41234",
            validade_ca=validade_ca,
        )
        s.add(entrada)
        s.flush()
        s.add(
            EpiMovimentoEstoque(entrada_id=entrada.id, tipo="ENTRADA", quantidade=20)
        )
        s.flush()
        epi_ficha.registrar_entrega(
            s,
            UsuarioAtual(
                id=1,
                login="semente",
                nome="Almoxarifado",
                permissoes=frozenset({"epi.entregar"}),
                perfis=(),
            ),
            servidor=servidor,
            item=item,
            quantidade=2,
            entrada=entrada,
            tamanho="M",
            data_evento=ENTREGA,
        )
        s.commit()
        return {"parecer": parecer.id, "exposicao": exposicao.id}


def test_a_tela_diz_que_ca_vencido_nao_sustenta_neutralizacao(
    app_cliente, contas, banco
):
    """O painel existe para isto: não deixar o engenheiro concluir sozinho.

    A alternativa — mostrar a validade do CA e a data da avaliação lado a lado —
    entrega ao leitor uma comparação de datas que ele faz de cabeça, no meio de
    outra tarefa, e é exatamente aí que a alegação errada entra num parecer.
    """
    from testes.integracao.conftest import entrar

    ids = _montar_para_a_tela(
        codigo_adicional="INSALUBRIDADE", validade_ca=CA_VENCE_ANTES
    )
    entrar(app_cliente, contas, "coordenador_csso")
    pagina = app_cliente.get(f"/pareceres/{ids['parecer']}")
    assert pagina.status_code == 200

    assert "EPI recebido até 11/02/2025" in pagina.text
    assert "Luva de proteção química nitrílica" in pagina.text
    assert "31/12/2024" in pagina.text
    assert "Não sustenta neutralização porque" in pagina.text
    assert "não sustenta</strong> alegação de neutralização" in pagina.text
    assert "RN-32" in pagina.text
    # e o formulário está lá, com as quatro opções: é o que faz o teste irmão
    # (o de periculosidade, que exige a AUSÊNCIA de duas delas) valer alguma
    # coisa em vez de passar porque a tela não desenhou nada
    assert 'value="NEUTRALIZA"' in pagina.text
    assert 'value="NEUTRALIZA_PARCIAL"' in pagina.text
    assert "EPI não cessa periculosidade" not in pagina.text


def test_a_tela_nao_oferece_neutralizacao_para_periculosidade(
    app_cliente, contas, banco
):
    """A trava do §7.1 aparece antes de o clique existir.

    A regra continua sendo do serviço — a tela não é a trava, é o aviso. Mas
    oferecer a opção e recusá-la depois ensina que o sistema é caprichoso, em
    vez de ensinar a distinção que a norma faz.
    """
    from testes.integracao.conftest import entrar

    ids = _montar_para_a_tela(
        codigo_adicional="PERICULOSIDADE", validade_ca=CA_VENCE_DEPOIS
    )
    entrar(app_cliente, contas, "coordenador_csso")
    pagina = app_cliente.get(f"/pareceres/{ids['parecer']}")
    assert pagina.status_code == 200
    assert "EPI não cessa periculosidade" in pagina.text
    assert 'value="NEUTRALIZA"' not in pagina.text
    assert 'value="NEUTRALIZA_PARCIAL"' not in pagina.text
    assert 'value="NAO_NEUTRALIZA"' in pagina.text


def test_a_rota_recusa_neutralizar_periculosidade_e_nao_grava(
    app_cliente, contas, banco
):
    """A porta de trás da tela: quem monta o POST à mão recebe a mesma recusa."""
    from app import banco as mod_banco
    from testes.integracao.conftest import entrar

    ids = _montar_para_a_tela(
        codigo_adicional="PERICULOSIDADE", validade_ca=CA_VENCE_DEPOIS
    )
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/pareceres/{ids['parecer']}/exposicoes/{ids['exposicao']}/epi",
        data={
            "epi_neutraliza": "NEUTRALIZA",
            "justificativa_epi": "luva isolante classe 2",
        },
    )
    assert resposta.status_code == 200
    assert "não cessa periculosidade" in resposta.text

    with mod_banco.sessao() as s:
        exposicao = s.get(Exposicao, ids["exposicao"])
        assert exposicao.epi_neutraliza == "NAO_AVALIADO"
        assert exposicao.justificativa_epi is None
