"""Fatia 1 de Certificados e Treinamentos: catálogo, modelos e assinaturas."""

from __future__ import annotations

import re
from datetime import date

import pytest
from sqlalchemy import select

from app import modulos
from app.modelos import (
    AssinaturaInstrutor,
    CertificadoModelo,
    CertificadoModeloTag,
    HistoricoEvento,
    Permissao,
    Servidor,
    Treinamento,
)
from testes.integracao.conftest import entrar

NR35 = {
    "codigo": "NR-35",
    "nome": "Trabalho em Altura — NR-35",
    "carga_horaria_horas": "8",
    "validade_meses": "24",
    "norma_referencia": "NR-35",
    "conteudo_programatico": "Análise de risco\nEquipamentos\nResgate",
}


def _criar(cliente, dados: dict | None = None):
    return cliente.post(
        "/treinamentos/catalogo", data={**NR35, **(dados or {})}, follow_redirects=False
    )


def _id_do_treinamento(codigo: str = "NR-35") -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.execute(
            select(Treinamento).where(Treinamento.codigo == codigo)
        ).scalar_one().id


def _editar_treinamento(cliente, alvo: int, dados: dict | None = None):
    """Salva a linha do catálogo como a tela salva: todos os campos de uma vez."""
    campos = {
        "nome": "Trabalho em Altura — NR-35",
        "carga_horaria_horas": "8",
        "validade_meses": "24",
        "ativo": "1",
    }
    return cliente.post(
        f"/treinamentos/catalogo/{alvo}",
        data={**campos, **(dados or {})},
        follow_redirects=False,
    )


# =====================================================================
# Catálogo
# =====================================================================
def test_cadastrar_treinamento(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    assert _criar(app_cliente).status_code == 303

    with mod_banco.sessao() as s:
        t = s.execute(
            select(Treinamento).where(Treinamento.codigo == "NR-35")
        ).scalar_one()
        assert t.nome == "Trabalho em Altura — NR-35"
        assert t.validade_meses == 24
        assert t.topicos == ["Análise de risco", "Equipamentos", "Resgate"]
        # o cadastro entra na trilha, como qualquer catálogo
        evento = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "treinamento",
                HistoricoEvento.tipo_evento == "TREINAMENTO_CRIADO",
            )
        ).scalar_one()
        assert "NR-35" in evento.descricao


def test_editar_treinamento_registra_diff_campo_a_campo(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()

    resposta = app_cliente.post(
        f"/treinamentos/catalogo/{alvo}",
        data={
            "nome": "Trabalho em Altura (NR-35)",
            "carga_horaria_horas": "16",
            "validade_meses": "24",
            "norma_referencia": "NR-35",
            "conteudo_programatico": NR35["conteudo_programatico"],
            "ativo": "1",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        t = s.get(Treinamento, alvo)
        assert t.nome == "Trabalho em Altura (NR-35)"
        assert t.carga_horaria_horas == 16
        diffs = {
            e.campo: (e.valor_anterior, e.valor_novo)
            for e in s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.entidade == "treinamento",
                    HistoricoEvento.tipo_evento == "CAMPO_ALTERADO",
                )
            ).scalars()
        }
        assert diffs["nome"] == (
            "Trabalho em Altura — NR-35",
            "Trabalho em Altura (NR-35)",
        )
        assert "carga_horaria_horas" in diffs
        # campo que não mudou não vira evento
        assert "norma_referencia" not in diffs


def test_codigo_nao_e_editavel(app_cliente, contas, banco):
    """O código é citado em ofício e em planilha — mudá-lo cria duas grafias."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()
    app_cliente.post(
        f"/treinamentos/catalogo/{alvo}",
        data={
            "codigo": "OUTRO",
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(Treinamento, alvo).codigo == "NR-35"


def test_treinamento_repetido_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    repetido = app_cliente.post(
        "/treinamentos/catalogo", data=NR35, follow_redirects=True
    )
    assert "Já existe treinamento" in repetido.text


def test_codigo_invalido_e_recusado(app_cliente, contas):
    """A recusa do cadastro não redireciona mais: ela devolve a tela.

    O cadastro virou popup (`ui.popup_cadastro`), e um redirecionamento não tem
    como carregar o dicionário do digitado — o conteúdo programático voltava em
    branco por causa de um código mal escrito. A rota renderiza a lista de novo,
    com o diálogo reaberto e a mensagem dentro dele.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _criar(app_cliente, {"codigo": "nr 35!"})
    assert resposta.status_code == 200
    assert "Código inválido" in resposta.text


# ---------------------------------------------------------------------
# A validade da reciclagem
# ---------------------------------------------------------------------
def test_validade_zero_significa_nao_expira(app_cliente, contas, banco):
    """Acerto do legado, mantido literalmente: 0 mês = sem vencimento.

    A alternativa seria uma data mágica (31/12/9999), que mente em todo
    relatório de reciclagem depois.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente, {"codigo": "INTEGRACAO", "nome": "Integração de novos servidores",
                         "validade_meses": "0", "norma_referencia": ""})

    with mod_banco.sessao() as s:
        t = s.execute(
            select(Treinamento).where(Treinamento.codigo == "INTEGRACAO")
        ).scalar_one()
        assert t.validade_meses == 0
        assert t.expira is False
        assert t.validade_rotulo == "não expira"

    corpo = app_cliente.get("/treinamentos/catalogo").text
    assert "0 = não expira" in corpo or "não expira" in corpo


@pytest.mark.parametrize(
    "meses,esperado", [(0, "não expira"), (12, "1 ano"), (24, "2 anos"), (18, "18 meses")]
)
def test_rotulo_da_validade(meses, esperado):
    assert Treinamento(validade_meses=meses).validade_rotulo == esperado


@pytest.mark.parametrize("valor", ["-1", "doze", "2,5"])
def test_validade_invalida_e_recusada(app_cliente, contas, valor):
    """Mês negativo ou quebrado não existe: reciclagem se conta em meses inteiros."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _criar(
        app_cliente,
        {"codigo": "CURSO", "nome": f"Curso {valor}", "validade_meses": valor},
    )
    assert "Validade inválida" in resposta.text


def test_validade_em_branco_e_recusada_no_cadastro(app_cliente, contas, banco):
    """Campo vazio não é "não expira": é campo vazio, e o sistema pergunta.

    O formulário de cadastro já nasce com 0 no campo, então quem quer "sem
    reciclagem" não precisa apagar nada — apagar é gesto de quem hesitou. A
    mensagem lembra que o 0 explícito continua valendo.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _criar(
        app_cliente,
        {"codigo": "SEMPRAZO", "nome": "Curso sem prazo", "validade_meses": ""},
    )
    assert "Validade inválida" in resposta.text
    # e o que foi digitado voltou: a recusa renderiza, não redireciona
    assert 'value="SEMPRAZO"' in resposta.text
    with mod_banco.sessao() as s:
        assert s.execute(
            select(Treinamento).where(Treinamento.codigo == "SEMPRAZO")
        ).scalar_one_or_none() is None


def test_validade_apagada_na_edicao_nao_vira_nao_expira(app_cliente, contas, banco):
    """Um NR-35 de 24 meses não pode deixar de vencer por descuido de digitação.

    Cenário: o treinamento existe com 24 meses, alguém abre a linha do
    catálogo para corrigir a carga horária, apaga o campo de validade para
    redigitá-lo e salva sem preencher. Se o vazio virasse 0, o treinamento
    passaria a "não expira" com mensagem de sucesso — e some do monitor de
    reciclagem, porque não está vencido nem vencendo.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()

    resposta = _editar_treinamento(
        app_cliente, alvo, {"carga_horaria_horas": "16", "validade_meses": ""}
    )
    assert resposta.status_code == 303
    assert "Validade inválida" in app_cliente.get(resposta.headers["location"]).text
    with mod_banco.sessao() as s:
        t = s.get(Treinamento, alvo)
        assert t.validade_meses == 24
        # recusa é recusa: nada da edição entrou
        assert t.carga_horaria_horas == 8


def test_validade_zero_explicito_continua_valendo_na_edicao(app_cliente, contas, banco):
    """0 digitado é afirmação — "este treinamento não vence" — e é aceito."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()
    assert _editar_treinamento(app_cliente, alvo, {"validade_meses": "0"}).status_code == 303
    with mod_banco.sessao() as s:
        t = s.get(Treinamento, alvo)
        assert t.validade_meses == 0 and not t.expira


def test_carga_horaria_aceita_virgula_e_recusa_zero(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente, {"codigo": "CIPA", "nome": "CIPA", "carga_horaria_horas": "4,5"})
    with mod_banco.sessao() as s:
        assert float(
            s.execute(select(Treinamento).where(Treinamento.codigo == "CIPA"))
            .scalar_one()
            .carga_horaria_horas
        ) == 4.5

    zerada = _criar(
        app_cliente, {"codigo": "ZERO", "nome": "Curso sem carga", "carga_horaria_horas": "0"}
    )
    assert "Carga horária inválida" in zerada.text


# =====================================================================
# Modelo de certificado e o dicionário de tags
# =====================================================================
def _criar_modelo(cliente, nome="Certificado padrão CSSO", **extra):
    return cliente.post(
        "/treinamentos/modelos",
        data={
            "nome": nome,
            "arquivo": "certificado_padrao.docx",
            "orientacao": "PAISAGEM",
            **extra,
        },
        follow_redirects=False,
    )


def _id_do_modelo(resposta) -> int:
    return int(resposta.headers["location"].split("/")[3].split("?")[0])


def test_dicionario_de_tags_pertence_ao_modelo(app_cliente, contas, banco):
    """O de-para marcador→campo é dado, não código: sem deploy para mudar layout."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    destino = _criar_modelo(app_cliente).headers["location"]
    modelo_id = int(destino.split("/")[3].split("?")[0])

    for marcador, campo in (
        ("nome_do_aluno", "participante_nome"),
        ("curso", "treinamento_nome"),
    ):
        resposta = app_cliente.post(
            f"/treinamentos/modelos/{modelo_id}/tags",
            data={"marcador": marcador, "campo": campo, "ordem": "1", "obrigatorio": "1"},
            follow_redirects=False,
        )
        assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        modelo = s.get(CertificadoModelo, modelo_id)
        assert modelo.mapa_de_tags == {
            "nome_do_aluno": "participante_nome",
            "curso": "treinamento_nome",
        }
        assert all(t.modelo_id == modelo_id for t in modelo.tags)
        assert s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == "MODELO_TAG_MAPEADA"
            )
        ).scalars().first() is not None

    ficha = app_cliente.get(f"/treinamentos/modelos/{modelo_id}").text
    assert "nome_do_aluno" in ficha
    # o arquivo .docx não existe: a tela diz isso em vez de fingir que conferiu
    assert "arquivo ausente" in ficha


def test_campo_desconhecido_e_recusado(app_cliente, contas, banco):
    """Nunca chutar a chave: campo fora do vocabulário sairia em branco no papel."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = int(_criar_modelo(app_cliente).headers["location"].split("/")[3].split("?")[0])
    resposta = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "qualquer", "campo": "cpf_do_aluno"},
        follow_redirects=True,
    )
    assert "Campo desconhecido" in resposta.text
    with mod_banco.sessao() as s:
        assert s.execute(select(CertificadoModeloTag)).scalars().all() == []


def test_marcador_invalido_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = int(_criar_modelo(app_cliente).headers["location"].split("/")[3].split("?")[0])
    resposta = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "nome do aluno", "campo": "participante_nome"},
        follow_redirects=True,
    )
    assert "Marcador inválido" in resposta.text


def test_marcador_repetido_no_mesmo_modelo_e_recusado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = int(_criar_modelo(app_cliente).headers["location"].split("/")[3].split("?")[0])
    dados = {"marcador": "curso", "campo": "treinamento_nome"}
    app_cliente.post(f"/treinamentos/modelos/{modelo_id}/tags", data=dados)
    repetido = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags", data=dados, follow_redirects=True
    )
    assert "já está mapeado" in repetido.text


def test_nova_versao_leva_o_mapa_junto_e_aposenta_a_anterior(app_cliente, contas, banco):
    """Começar a versão nova com o mapa vazio convidaria a redigitar trinta
    linhas — e é redigitando que se troca o nome do instrutor pelo do aluno."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = int(_criar_modelo(app_cliente).headers["location"].split("/")[3].split("?")[0])
    app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "curso", "campo": "treinamento_nome", "obrigatorio": "1"},
    )
    resposta = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/versao", follow_redirects=False
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        antiga = s.get(CertificadoModelo, modelo_id)
        assert antiga.vigente is False
        nova = s.execute(
            select(CertificadoModelo).where(CertificadoModelo.versao == 2)
        ).scalar_one()
        assert nova.mapa_de_tags == {"curso": "treinamento_nome"}
        assert nova.id != antiga.id

    # versão superada é o layout de certificados já emitidos: não se edita
    recusa = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "outro", "campo": "cidade"},
        follow_redirects=True,
    )
    assert "não se edita" in recusa.text


def test_modelo_repetido_manda_versionar(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    repetido = app_cliente.post(
        "/treinamentos/modelos",
        data={"nome": "Certificado padrão CSSO", "arquivo": "outro.docx"},
        follow_redirects=True,
    )
    assert "publique uma nova versão" in repetido.text


def test_versao_superada_nao_publica_outra_versao(app_cliente, contas, banco):
    """Clonar uma versão antiga ressuscitaria o mapa de tags dela.

    Cenário: o setor publicou a v2 e acrescentou nela o marcador do instrutor.
    Semanas depois alguém abre a v1 pelo histórico — a página até avisa que
    versão superada não se edita — e clica em "Publicar nova versão". Se isso
    valesse, nasceria uma v3 vigente com o mapa da v1, a v2 seria aposentada e
    o marcador do instrutor sumiria do layout que vale, com mensagem de
    sucesso. Na emissão, o nome do instrutor sairia no lugar do participante.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    v1 = _id_do_modelo(_criar_modelo(app_cliente))
    app_cliente.post(
        f"/treinamentos/modelos/{v1}/tags",
        data={"marcador": "aluno", "campo": "participante_nome"},
    )
    v2 = _id_do_modelo(
        app_cliente.post(f"/treinamentos/modelos/{v1}/versao", follow_redirects=False)
    )
    app_cliente.post(
        f"/treinamentos/modelos/{v2}/tags",
        data={"marcador": "instrutor", "campo": "assinante_nome"},
    )

    recusa = app_cliente.post(
        f"/treinamentos/modelos/{v1}/versao", follow_redirects=True
    )
    assert "não se edita" in recusa.text

    with mod_banco.sessao() as s:
        versoes = list(
            s.execute(
                select(CertificadoModelo).order_by(CertificadoModelo.versao)
            ).scalars()
        )
        assert [m.versao for m in versoes] == [1, 2]
        vigentes = [m for m in versoes if m.vigente]
        assert len(vigentes) == 1
        assert vigentes[0].id == v2
        assert vigentes[0].mapa_de_tags == {
            "aluno": "participante_nome",
            "instrutor": "assinante_nome",
        }


def test_renomear_modelo_para_nome_ja_usado_e_recusado(app_cliente, contas, banco):
    """Trocar "Beta" por "Alfa" no mesmo treinamento devolvia página de erro.

    O cadastro já recusa nome repetido com mensagem; a edição ia direto ao
    banco e o usuário via um 500 sem explicação nenhuma.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    curso = _id_do_treinamento()
    _criar_modelo(app_cliente, "Alfa", treinamento_id=str(curso))
    beta = _id_do_modelo(_criar_modelo(app_cliente, "Beta", treinamento_id=str(curso)))

    recusa = app_cliente.post(
        f"/treinamentos/modelos/{beta}",
        data={
            "nome": "Alfa",
            "arquivo": "certificado_padrao.docx",
            "treinamento_id": str(curso),
            "orientacao": "PAISAGEM",
        },
        follow_redirects=True,
    )
    assert recusa.status_code == 200
    assert "já existe" in recusa.text.lower()
    with mod_banco.sessao() as s:
        assert s.get(CertificadoModelo, beta).nome == "Beta"


def test_renomear_modelo_generico_para_nome_ja_usado_e_recusado(
    app_cliente, contas, banco
):
    """No genérico a UniqueConstraint não pega: NULL não colide com NULL.

    Sem a conferência no serviço, dois modelos genéricos homônimos passam a
    conviver — e o cadastro depois recusa um terceiro dizendo que "já existe",
    num estado que a tela não deixa desfazer.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente, "Alfa")
    beta = _id_do_modelo(_criar_modelo(app_cliente, "Beta"))

    recusa = app_cliente.post(
        f"/treinamentos/modelos/{beta}",
        data={"nome": "Alfa", "arquivo": "certificado_padrao.docx", "orientacao": "PAISAGEM"},
        follow_redirects=True,
    )
    assert "já existe" in recusa.text.lower()
    with mod_banco.sessao() as s:
        nomes = sorted(
            m.nome for m in s.execute(select(CertificadoModelo)).scalars()
        )
        assert nomes == ["Alfa", "Beta"]


def test_editar_modelo_tambem_exige_docx(app_cliente, contas, banco):
    """A guarda do cadastro não pode ser contornável pela edição.

    Quem salva a ficha do modelo com `dados/csso.db` no campo do arquivo grava
    um valor que a tela depois reporta como "arquivo ausente" sem dizer por
    quê — e a conferência de marcadores fica cega até alguém descobrir.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = _id_do_modelo(_criar_modelo(app_cliente))
    recusa = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}",
        data={
            "nome": "Certificado padrão CSSO",
            "arquivo": "../../../dados/csso.db",
            "orientacao": "PAISAGEM",
        },
        follow_redirects=True,
    )
    assert ".docx" in recusa.text
    with mod_banco.sessao() as s:
        assert s.get(CertificadoModelo, modelo_id).arquivo == "certificado_padrao.docx"


def test_modelo_guarda_so_o_nome_do_arquivo(app_cliente, contas, banco):
    """O que está no banco tem de ser o que vai ser aberto.

    A emissão resolve o caminho com `Path(arquivo).name`; guardar a pasta
    junto faria o banco dizer uma coisa e o disco outra.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = _id_do_modelo(
        _criar_modelo(app_cliente, "Com caminho", arquivo="modelos/antigo/padrao.docx")
    )
    with mod_banco.sessao() as s:
        assert s.get(CertificadoModelo, modelo_id).arquivo == "padrao.docx"


def test_ordem_apagada_na_linha_da_tag_mantem_a_ordem_de_hoje(app_cliente, contas, banco):
    """Apagar o número da ordem é hesitação, não pedido para ir ao topo.

    A linha da tag salva marcador, campo, ordem e obrigatório de uma vez; quem
    limpa o campo de ordem e clica em salvar não está pedindo para a tag virar
    a primeira do documento.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    modelo_id = _id_do_modelo(_criar_modelo(app_cliente))
    for marcador, campo, ordem in (
        ("aluno", "participante_nome", "1"),
        ("curso", "treinamento_nome", "2"),
    ):
        app_cliente.post(
            f"/treinamentos/modelos/{modelo_id}/tags",
            data={"marcador": marcador, "campo": campo, "ordem": ordem},
        )
    with mod_banco.sessao() as s:
        segunda = s.execute(
            select(CertificadoModeloTag).where(CertificadoModeloTag.marcador == "curso")
        ).scalar_one().id

    app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags/{segunda}",
        data={"campo": "treinamento_nome", "ordem": "", "obrigatorio": "1"},
    )
    with mod_banco.sessao() as s:
        assert s.get(CertificadoModeloTag, segunda).ordem == 2


# =====================================================================
# O modelo vigente e o instrutor padrão da linha do catálogo
# =====================================================================
def _opcoes(html: str, form_id: str, campo: str) -> list[str]:
    bloco = re.search(
        rf'<select form="{form_id}" name="{campo}">(.*?)</select>', html, re.S
    )
    assert bloco is not None, f"a tela não tem o seletor {campo} de {form_id}"
    return re.findall(r'value="([^"]*)"', bloco.group(1))


def _dois_treinamentos(cliente) -> tuple[int, int]:
    _criar(cliente)
    _criar(cliente, {"codigo": "BRIGADA", "nome": "Brigada de Incêndio"})
    return _id_do_treinamento(), _id_do_treinamento("BRIGADA")


def test_o_seletor_so_oferece_modelo_do_proprio_treinamento(app_cliente, contas, banco):
    """`certificado_modelo.treinamento_id` diz a que treinamento o layout serve.

    Oferecer na linha do NR-35 um modelo cadastrado para a brigada é convidar
    o erro; o modelo genérico, que serve a qualquer um, continua na lista.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    nr35, brigada = _dois_treinamentos(app_cliente)
    generico = _id_do_modelo(_criar_modelo(app_cliente, "Genérico CSSO"))
    so_brigada = _id_do_modelo(
        _criar_modelo(app_cliente, "Só da Brigada", treinamento_id=str(brigada))
    )

    tela = app_cliente.get("/treinamentos/catalogo").text
    do_nr35 = _opcoes(tela, f"f-trein-{nr35}", "modelo_vigente_id")
    assert str(so_brigada) not in do_nr35
    assert str(generico) in do_nr35
    assert str(so_brigada) in _opcoes(tela, f"f-trein-{brigada}", "modelo_vigente_id")


def test_catalogo_recusa_modelo_de_outro_treinamento(app_cliente, contas, banco):
    """Guarda que só existe na tela não é guarda.

    Se o catálogo pode contradizer o `treinamento_id` do modelo, o certificado
    de NR-35 sai no papel do curso de brigada.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    nr35, brigada = _dois_treinamentos(app_cliente)
    so_brigada = _id_do_modelo(
        _criar_modelo(app_cliente, "Só da Brigada", treinamento_id=str(brigada))
    )

    resposta = _editar_treinamento(
        app_cliente, nr35, {"modelo_vigente_id": str(so_brigada)}
    )
    assert resposta.status_code == 303
    assert "outro treinamento" in app_cliente.get(resposta.headers["location"]).text
    with mod_banco.sessao() as s:
        assert s.get(Treinamento, nr35).modelo_vigente_id is None


@pytest.mark.parametrize(
    "campo,valor", [("modelo_vigente_id", "99999"), ("instrutor_padrao_id", "77777")]
)
def test_id_que_nao_existe_vira_recusa_e_nao_pagina_de_erro(
    app_cliente, contas, banco, campo, valor
):
    """Formulário reenviado depois de o modelo ser apagado devolvia 500.

    A tela não oferece esses ids, mas o botão "voltar" do navegador e o
    formulário guardado numa aba antiga oferecem.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()
    resposta = _editar_treinamento(app_cliente, alvo, {campo: valor})
    assert resposta.status_code == 303
    assert "não encontrad" in app_cliente.get(resposta.headers["location"]).text


def test_modelo_superado_continua_na_linha_de_quem_o_usa(app_cliente, contas, banco):
    """Publicar a v2 não pode apagar em silêncio o modelo do treinamento.

    O catálogo aponta para a v1; publicada a v2, a v1 deixa de ser vigente. Se
    ela sumisse do seletor, salvar a carga horária da linha gravaria "sem
    modelo" sem ninguém pedir.
    """
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()
    v1 = _id_do_modelo(_criar_modelo(app_cliente, "Padrão", treinamento_id=str(alvo)))
    _editar_treinamento(app_cliente, alvo, {"modelo_vigente_id": str(v1)})
    app_cliente.post(f"/treinamentos/modelos/{v1}/versao", follow_redirects=False)

    tela = app_cliente.get("/treinamentos/catalogo").text
    assert str(v1) in _opcoes(tela, f"f-trein-{alvo}", "modelo_vigente_id")

    _editar_treinamento(
        app_cliente,
        alvo,
        {"carga_horaria_horas": "16", "modelo_vigente_id": str(v1)},
    )
    with mod_banco.sessao() as s:
        assert s.get(Treinamento, alvo).modelo_vigente_id == v1


def test_instrutor_inativo_nao_vira_padrao_de_treinamento(app_cliente, contas, banco):
    """Assinatura inativa não assina: apontá-la como padrão só adia o erro."""
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)
    alvo = _id_do_treinamento()
    app_cliente.post(
        "/treinamentos/assinaturas",
        data={"nome": "Joana Ribeiro", "externo": "1", "vigencia_inicio": "2026-01-01"},
    )
    with mod_banco.sessao() as s:
        assinatura = s.execute(select(AssinaturaInstrutor)).scalar_one()
        assinatura.ativo = False
        s.commit()
        inativa = assinatura.id

    resposta = _editar_treinamento(app_cliente, alvo, {"instrutor_padrao_id": str(inativa)})
    assert "inativa" in app_cliente.get(resposta.headers["location"]).text
    with mod_banco.sessao() as s:
        assert s.get(Treinamento, alvo).instrutor_padrao_id is None


# =====================================================================
# Assinatura de instrutor
# =====================================================================
def _servidor(banco) -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        servidor = Servidor(siape="2165804", nome="Fabrício Raimundi Andrade")
        s.add(servidor)
        s.commit()
        return servidor.id


def test_assinatura_de_instrutor_servidor_le_o_nome_do_cadastro(app_cliente, contas, banco):
    from app import banco as mod_banco

    servidor_id = _servidor(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "servidor_id": str(servidor_id),
            "titulo": "Eng. Seg. do Trabalho",
            "conselho": "crea",
            "registro_conselho": "MG-123456",
            "vigencia_inicio": "2019-01-01",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 303

    with mod_banco.sessao() as s:
        assinatura = s.execute(select(AssinaturaInstrutor)).scalar_one()
        assert assinatura.servidor_id == servidor_id
        assert assinatura.externo is False
        assert assinatura.nome_exibicao == "Fabrício Raimundi Andrade"
        assert assinatura.conselho == "CREA"  # normalizado na entrada
        assert assinatura.registro_completo == "CREA MG-123456"
        assert assinatura.vigente_em(date(2026, 8, 13))

    lista = app_cliente.get("/treinamentos/assinaturas").text
    assert "Fabrício Raimundi Andrade" in lista
    assert "MG-123456" in lista


def test_assinatura_externa_dispensa_servidor(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "nome": "Joana Ribeiro",
            "externo": "1",
            "organizacao": "Corpo de Bombeiros",
            "vigencia_inicio": "2026-01-01",
            "vigencia_fim": "2026-12-31",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assinatura = s.execute(select(AssinaturaInstrutor)).scalar_one()
        assert assinatura.externo is True
        assert assinatura.servidor_id is None
        assert assinatura.nome_exibicao == "Joana Ribeiro"
        assert not assinatura.vigente_em(date(2027, 1, 1))


def test_instrutor_interno_sem_servidor_e_recusado(app_cliente, contas):
    """Sem o vínculo, o nome do assinante divergiria do cadastro no dia em que
    alguém corrigisse um dos dois."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/assinaturas",
        data={"nome": "Alguém", "vigencia_inicio": "2026-01-01"},
        follow_redirects=True,
    )
    assert "precisa estar vinculado a um servidor" in resposta.text


def test_editar_assinatura_registra_diff(app_cliente, contas, banco):
    from app import banco as mod_banco

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/treinamentos/assinaturas",
        data={"nome": "Joana Ribeiro", "externo": "1", "vigencia_inicio": "2026-01-01"},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        alvo = s.execute(select(AssinaturaInstrutor)).scalar_one().id

    app_cliente.post(
        f"/treinamentos/assinaturas/{alvo}",
        data={
            "nome": "Joana Ribeiro Nunes",
            "externo": "1",
            "titulo": "Bombeira militar",
            "vigencia_inicio": "2026-01-01",
            "ativo": "1",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.get(AssinaturaInstrutor, alvo).nome == "Joana Ribeiro Nunes"
        campos = {
            e.campo
            for e in s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.entidade == "assinatura_instrutor",
                    HistoricoEvento.tipo_evento == "CAMPO_ALTERADO",
                )
            ).scalars()
        }
        assert {"nome", "titulo"} <= campos


def test_vigencia_invertida_e_recusada(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "nome": "Joana",
            "externo": "1",
            "vigencia_inicio": "2026-06-01",
            "vigencia_fim": "2026-01-01",
        },
        follow_redirects=True,
    )
    assert "não pode ser anterior ao início" in resposta.text


# =====================================================================
# Permissões
# =====================================================================
def test_quem_so_consulta_ve_o_catalogo_mas_nao_edita(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar(app_cliente)

    entrar(app_cliente, contas, "secretaria_csso")
    lista = app_cliente.get("/treinamentos/catalogo")
    assert lista.status_code == 200
    assert "Trabalho em Altura" in lista.text
    # a tela abre em leitura: sem formulário de edição e sem botão de salvar
    assert "Novo treinamento" not in lista.text
    assert 'action="/treinamentos/catalogo/' not in lista.text
    assert app_cliente.post("/treinamentos/catalogo", data=NR35).status_code == 403


@pytest.mark.parametrize(
    "perfil,caminho,esperado",
    [
        ("secretaria_csso", "/treinamentos/modelos", 403),
        ("secretaria_csso", "/treinamentos/assinaturas", 403),
        ("admin_ti", "/treinamentos/catalogo", 403),
        ("admin_ti", "/treinamentos/modelos", 403),
        ("auditor_interno", "/treinamentos/catalogo", 200),
        ("auditor_interno", "/treinamentos/assinaturas", 403),
        ("coordenador_csso", "/treinamentos/modelos", 200),
        ("coordenador_csso", "/treinamentos/assinaturas", 200),
    ],
)
def test_permissao_das_telas(app_cliente, contas, perfil, caminho, esperado):
    entrar(app_cliente, contas, perfil)
    assert app_cliente.get(caminho).status_code == esperado


def test_permissoes_novas_nascem_no_modulo_treinamentos(banco):
    """A coluna `modulo` passa a ter valor correto desde já.

    Nada em `app/` a lê hoje — `/perfis` renderiza a partir de `MATRIZ_PERFIS`,
    que é código. Ela é preparação para quando a tela de permissões por módulo
    existir, e o seed é quem garante que o valor não nasce errado.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        modulos_por_codigo = {
            p.codigo: p.modulo for p in s.execute(select(Permissao)).scalars()
        }
    for codigo in (
        "treinamento.ver",
        "treinamento.gerenciar",
        "assinatura.gerenciar",
        "turma.criar",
        "turma.inscrever",
        "turma.concluir",
    ):
        assert modulos_por_codigo[codigo] == "TREINAMENTOS", codigo
    assert modulos_por_codigo["parecer.emitir"] == "ADICIONAL"


# =====================================================================
# O módulo no menu e no mapa
# =====================================================================
def test_modulo_declara_as_telas_que_existem():
    modulo = modulos.por_codigo("certificados")
    assert modulo.disponivel
    assert [(i.caminho, i.permissao) for i in modulo.itens] == [
        ("/turmas", "treinamento.ver"),
        # a porta do servidor comum, com `treinamento.ver` — e não
        # `turma.inscrever_se`, que é a permissão do BOTÃO. A tela responde "o
        # que é meu" antes de responder "o que posso pedir", e declarar aqui a
        # permissão do botão faria o menu esconder uma tela que abre.
        ("/turmas/minhas", "treinamento.ver"),
        # a tela do titular, com `treinamento.ver` — e não `certificado.ver`,
        # que é a permissão de ler o certificado de OUTRO e continua guardando
        # a lista nominal do setor, logo abaixo
        ("/certificados/meus", "treinamento.ver"),
        ("/certificados", "certificado.ver"),
        ("/treinamentos/catalogo", "treinamento.ver"),
        ("/treinamentos/modelos", "treinamento.gerenciar"),
        ("/treinamentos/assinaturas", "assinatura.gerenciar"),
    ]
    # o que falta continua declarado: entregue por fatias, não escondido
    assert modulo.itens_previstos


@pytest.mark.parametrize(
    "caminho", ["/treinamentos/catalogo", "/treinamentos/modelos", "/treinamentos/modelos/7"]
)
def test_a_tela_do_modulo_marca_o_modulo(caminho):
    assert modulos.modulo_ativo(caminho).codigo == "certificados"


def test_menu_e_mapa_mostram_o_modulo(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    barra = app_cliente.get("/treinamentos/catalogo").text
    assert "Certificados e Treinamentos" in barra
    assert 'href="/treinamentos/assinaturas"' in barra

    mapa = app_cliente.get("/modulos").text
    for caminho in (
        "/treinamentos/catalogo",
        "/treinamentos/modelos",
        "/treinamentos/assinaturas",
    ):
        assert f'href="{caminho}"' in mapa
    assert "O que ainda vem" in mapa


def test_o_mapa_nao_oferece_a_tela_a_quem_nao_pode(app_cliente, contas):
    entrar(app_cliente, contas, "secretaria_csso")
    mapa = app_cliente.get("/modulos").text
    assert 'href="/treinamentos/catalogo"' in mapa
    assert 'href="/treinamentos/modelos"' not in mapa
    assert 'href="/treinamentos/assinaturas"' not in mapa


# =====================================================================
# O esquema
# =====================================================================
def test_o_esquema_inteiro_continua_ordenavel_para_criar_e_apagar():
    """O ciclo treinamento ↔ certificado_modelo não pode desordenar o esquema.

    Diante de um ciclo de chave estrangeira o SQLAlchemy desiste de ordenar
    *todas* as tabelas, não só as duas do ciclo: `drop_all` passa a falhar em
    `laudo_tecnico`, que não tem nada com certificados. Quem paga é o primeiro
    utilitário de recriar banco de teste — e o `alembic check`, que ordena o
    esquema a cada execução e é do que este projeto mais precisa.
    """
    import warnings

    from sqlalchemy import create_engine

    from app.modelos import Base

    engine = create_engine("sqlite+pysqlite:///:memory:")
    with warnings.catch_warnings(record=True) as avisos:
        warnings.simplefilter("always")
        assert Base.metadata.sorted_tables
        Base.metadata.create_all(engine)
        Base.metadata.drop_all(engine)
    engine.dispose()
    assert [str(a.message) for a in avisos if "sort" in str(a.message)] == []
