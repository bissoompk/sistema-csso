"""Formulário recusado devolve o que a pessoa digitou — menos o que é segredo.

Refazer o nome completo porque a senha era fraca é o tipo de atrito que faz a
pessoa escolher senha pior na segunda tentativa: ela troca a senha boa e longa
por uma curta, para não ter de redigitar o resto se errar de novo. O mesmo vale
para o processo novo, em que a observação é o campo mais caro de redigitar e é
justamente o que se perdia.

O limite é firme: **senha digitada nunca volta ao template**. Ela iria para o
HTML em claro, ficaria no cache do navegador e no histórico da tela — o
formulário de senha é o único em que perder o digitado é a resposta certa.
"""

from __future__ import annotations

import re
from datetime import date

from testes.integracao.conftest import entrar

NOME = "Fabrício Raimundi Andrade"
EMAIL = "fabricio.andrade@ufvjm.edu.br"
# fraca por não misturar letras e números, e distinta o bastante para o teste
# poder afirmar que ela NÃO aparece em lugar nenhum do HTML devolvido
SENHA_FRACA = "abacaxidiamantina"
SENHA_BOA = "PrimeiroAcesso2026"


def _valor_do_campo(corpo: str, nome_do_campo: str) -> str | None:
    """O `value=` do input, como o navegador o mostraria."""
    achado = re.search(
        rf'<input[^>]*\bname="{nome_do_campo}"[^>]*>', corpo, re.IGNORECASE
    )
    if achado is None:
        return None
    valor = re.search(r'\bvalue="([^"]*)"', achado.group(0))
    return valor.group(1) if valor else None


# ---------------------------------------------------------------------
# Primeiro acesso
# ---------------------------------------------------------------------
def test_primeiro_acesso_recusado_devolve_nome_e_email(app_cliente, banco):
    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={"nome": NOME, "email": EMAIL, "senha": SENHA_FRACA, "login": ""},
    )
    assert resposta.status_code == 200
    assert "Senha fraca" in resposta.text
    assert _valor_do_campo(resposta.text, "nome") == NOME
    assert _valor_do_campo(resposta.text, "email") == EMAIL


def test_primeiro_acesso_recusado_nunca_devolve_a_senha(app_cliente, banco):
    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={"nome": NOME, "email": EMAIL, "senha": SENHA_FRACA, "login": ""},
    )
    assert SENHA_FRACA not in resposta.text
    assert _valor_do_campo(resposta.text, "senha") in (None, "")


def test_primeiro_acesso_corrigido_na_segunda_tentativa(app_cliente, banco):
    """O que o conserto serve para: a segunda tentativa só troca a senha."""
    app_cliente.post(
        "/primeiro-acesso",
        data={"nome": NOME, "email": EMAIL, "senha": SENHA_FRACA, "login": ""},
    )
    resposta = app_cliente.post(
        "/primeiro-acesso",
        data={"nome": NOME, "email": EMAIL, "senha": SENHA_BOA, "login": ""},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


# ---------------------------------------------------------------------
# Troca de senha — três campos, os três segredo
# ---------------------------------------------------------------------
def test_trocar_senha_recusada_nao_devolve_nenhuma_das_senhas(app_cliente, contas):
    """Aqui não há o que preservar, e isso é a resposta certa, não uma falta.

    Os três campos da tela são senha. Devolver qualquer um deles poria segredo
    em claro no HTML; o teste fixa o limite para que uma futura "melhoria de
    usabilidade" não o atravesse.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/trocar-senha",
        data={
            "senha_atual": "SenhaDeTeste2026",
            "nova": "123",
            "confirmacao": "123",
        },
    )
    assert resposta.status_code == 200
    assert "Senha fraca" in resposta.text
    assert "SenhaDeTeste2026" not in resposta.text
    for campo in ("senha_atual", "nova", "confirmacao"):
        assert _valor_do_campo(resposta.text, campo) in (None, "")


# ---------------------------------------------------------------------
# Processo novo
# ---------------------------------------------------------------------
OBSERVACAO = "Conferir a portaria de localização com a FAMED antes de instruir."


def _postar_processo(cliente, **extra):
    dados = {
        "nup": "23086.000608/2026-84",
        "tipo_processo_id": "1",
        "servidor_id": "",
        "unidade_uorg_id": "",
        "data_autuacao": "",
        "observacoes": OBSERVACAO,
        "dispensar_dv": "",
    }
    dados.update(extra)
    return cliente.post("/processos/novo", data=dados, follow_redirects=False)


def test_nup_com_formato_invalido_devolve_o_que_foi_digitado(app_cliente, contas):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _postar_processo(app_cliente, nup="não é NUP")
    assert resposta.status_code == 200
    assert OBSERVACAO in resposta.text
    assert _valor_do_campo(resposta.text, "nup") == "não é NUP"


def test_dv_recusado_preserva_a_observacao_e_a_marca_de_dispensa(app_cliente, contas):
    """O caso relatado: o DV diverge, e o aviso pede para marcar a dispensa.

    Perdendo a marca junto com a observação, quem marca e reenvia descobre que
    perdeu o texto — e a segunda tentativa é digitada de novo por inteiro.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _postar_processo(app_cliente, nup="23086.000608/2026-00")
    assert resposta.status_code == 200
    assert "confirmei no SEI" in resposta.text
    assert OBSERVACAO in resposta.text, "a observação sumia e era redigitada por inteiro"


def test_marca_de_dispensa_volta_marcada(app_cliente, contas):
    """Recusa por outro motivo, com a dispensa já marcada: a marca fica."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _postar_processo(
        app_cliente,
        nup="23086.000608/2026-00",
        dispensar_dv="1",
        observacoes="Servidora gestante afastada do laboratório.",
    )
    assert resposta.status_code == 200
    assert "termo proibido" in resposta.text
    marca = re.search(r'<input[^>]*\bname="dispensar_dv"[^>]*>', resposta.text)
    assert marca is not None
    assert "checked" in marca.group(0)


def test_recusa_preserva_tipo_servidor_unidade_e_data(app_cliente, contas, banco):
    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import Cargo, Servidor, TipoProcesso, UnidadeUorg

    with mod_banco.sessao() as s:
        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == "250")
        ).scalar_one()
        cargo = s.execute(
            select(Cargo).where(Cargo.nome == "TECNICO DE LABORATORIO AREA")
        ).scalar_one()
        servidor = Servidor(
            siape="1110654",
            nome="Marco Antônio Alves Schetino",
            cargo_id=cargo.id,
            unidade_uorg_id=famed.id,
        )
        s.add(servidor)
        # o último tipo, para não confundir com o default do <select>
        tipo = list(s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars())[-1]
        s.commit()
        ids = (servidor.id, famed.id, tipo.id)

    servidor_id, unidade_id, tipo_id = ids
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = _postar_processo(
        app_cliente,
        nup="não é NUP",
        tipo_processo_id=str(tipo_id),
        servidor_id=str(servidor_id),
        unidade_uorg_id=str(unidade_id),
        data_autuacao="2026-03-01",
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    for valor in (tipo_id, servidor_id, unidade_id):
        assert re.search(rf'<option value="{valor}"[^>]*\bselected\b', corpo), valor
    assert _valor_do_campo(corpo, "data_autuacao") == "2026-03-01"


# ---------------------------------------------------------------------
# Comentário no histórico do processo (RN-21)
# ---------------------------------------------------------------------
# A recusa aqui é **deliberada e tem motivo bom**: comentário vira linha de
# auditoria, e auditoria não guarda dado de saúde. O que estava errado era a
# forma de recusar — `TextoProibido` é `ValueError`, `principal.py` não trata
# `ValueError`, e escrever "atestado médico" devolvia a página branca do
# Starlette: sem casca, sem saída e sem o que a pessoa tinha escrito.
COMENTARIO_PROIBIDO = "Servidor apresentou atestado médico da chefia."


def _processo(banco) -> int:
    from datetime import date

    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import FluxoEtapa, Processo, TipoProcesso

    with mod_banco.sessao() as s:
        etapa = s.execute(
            select(FluxoEtapa).where(FluxoEtapa.codigo == "A_FAZER")
        ).scalar_one()
        tipo = s.execute(select(TipoProcesso).order_by(TipoProcesso.id)).scalars().first()
        processo = Processo(
            nup="23086.000608/2026-84",
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico="RECEBIDO",
            data_autuacao=date(2026, 1, 5),
            ano_referencia=2026,
        )
        s.add(processo)
        s.commit()
        return processo.id


def test_comentario_com_termo_proibido_nao_derruba_a_tela(app_cliente, contas, banco):
    processo_id = _processo(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/processos/{processo_id}/comentario",
        data={"comentario": COMENTARIO_PROIBIDO},
        follow_redirects=False,
    )
    assert resposta.status_code == 200, "voltou a ser 500 branco do Starlette"
    assert "termo proibido" in resposta.text
    assert 'class="aviso aviso-erro"' in resposta.text
    # a casca continua na tela: há por onde sair
    assert "/pendencias" in resposta.text


def test_comentario_recusado_volta_dentro_do_campo(app_cliente, contas, banco):
    processo_id = _processo(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/processos/{processo_id}/comentario",
        data={"comentario": COMENTARIO_PROIBIDO},
        follow_redirects=False,
    )
    assert _valor_do_campo(resposta.text, "comentario") == COMENTARIO_PROIBIDO


def test_comentario_recusado_nao_entra_na_auditoria(app_cliente, contas, banco):
    """Devolver o texto à tela não é gravá-lo: a RN-21 continua valendo."""
    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import HistoricoEvento

    processo_id = _processo(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        f"/processos/{processo_id}/comentario",
        data={"comentario": COMENTARIO_PROIBIDO},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        comentarios = list(
            s.execute(
                select(HistoricoEvento).where(HistoricoEvento.tipo_evento == "COMENTARIO")
            ).scalars()
        )
    assert comentarios == []


def test_comentario_limpo_continua_gravando(app_cliente, contas, banco):
    processo_id = _processo(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        f"/processos/{processo_id}/comentario",
        data={"comentario": "Conferir a portaria com a FAMED."},
        follow_redirects=False,
    )
    assert resposta.status_code == 303


# =====================================================================
# Os formulários grandes de fora de Processos SEI
#
# Todos redirecionavam para a tela em branco levando só a mensagem na
# querystring: o navegador fazia um GET novo e o formulário nascia vazio. Quem
# digitou treze campos e perdeu tudo por causa de uma data mal formatada não
# repete o trabalho com paciência — contorna o sistema.
# =====================================================================
def _texto_da_area(corpo: str, nome_do_campo: str) -> str | None:
    """O conteúdo do `<textarea>`, como o navegador o mostraria."""
    achado = re.search(
        rf'<textarea[^>]*\bname="{nome_do_campo}"[^>]*>(.*?)</textarea>',
        corpo,
        re.IGNORECASE | re.DOTALL,
    )
    return achado.group(1) if achado else None


def _selecionado(corpo: str, valor) -> bool:
    return bool(re.search(rf'<option value="{valor}"[^>]*\bselected\b', corpo))


# ---------------------------------------------------------------------
# Login — a tela mais vista do sistema
# ---------------------------------------------------------------------
def test_login_recusado_devolve_o_email_digitado(app_cliente, contas):
    resposta = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "senha errada", "proximo": "/inicio"},
    )
    assert resposta.status_code == 200
    assert "inválidos" in resposta.text
    assert _valor_do_campo(resposta.text, "login") == "coordenador_csso"


def test_login_recusado_nunca_devolve_a_senha(app_cliente, contas):
    """O limite é o mesmo do primeiro acesso: identificador volta, segredo não."""
    resposta = app_cliente.post(
        "/login",
        data={"login": "coordenador_csso", "senha": "MinhaSenhaSecreta9", "proximo": "/inicio"},
    )
    assert "MinhaSenhaSecreta9" not in resposta.text
    assert _valor_do_campo(resposta.text, "senha") in (None, "")


# ---------------------------------------------------------------------
# Nova requisição de EPI — dois textos longos
# ---------------------------------------------------------------------
ROTINA = "Manipulação de reagentes no laboratório de análises clínicas da FAMED."
RISCOS = "Contato com ácidos e solventes; respingo em mucosa; material perfurocortante."


def _servidor(banco) -> int:
    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import Cargo, Servidor, UnidadeUorg

    with mod_banco.sessao() as s:
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(servidor)
        s.commit()
        return servidor.id


def test_requisicao_recusada_devolve_os_dois_textos_longos(app_cliente, contas, banco):
    """O caso que o comentário do próprio template já reconhecia como caro.

    Urgente sem justificativa é recusa do serviço; sem o `digitado`, ela apagava
    a rotina de trabalho e os riscos — que são exatamente o que a pessoa que vai
    DECIDIR precisa ler para fundamentar a decisão.
    """
    servidor_id = _servidor(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/requisicoes",
        data={
            "servidor_id": str(servidor_id),
            "chefia_servidor_id": "",
            "finalidade": "SUBSTITUICAO",
            "descricao_atividade": ROTINA,
            "riscos_declarados": RISCOS,
            "urgencia": "URGENTE",
            "justificativa_urgencia": "",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    assert _texto_da_area(corpo, "descricao_atividade") == ROTINA
    assert _texto_da_area(corpo, "riscos_declarados") == RISCOS
    assert _selecionado(corpo, servidor_id), "o servidor escolhido voltou em branco"
    assert _selecionado(corpo, "SUBSTITUICAO")
    assert _selecionado(corpo, "URGENTE")


def test_requisicao_sem_servidor_tambem_devolve_o_digitado(app_cliente, contas, banco):
    """A recusa mais precoce da rota é a que mais apagava: acontece antes de
    qualquer serviço ver o formulário."""
    _servidor(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/requisicoes",
        data={
            "servidor_id": "",
            "finalidade": "ROTINA",
            "descricao_atividade": ROTINA,
            "riscos_declarados": RISCOS,
            "urgencia": "NORMAL",
            "justificativa_urgencia": "",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    assert "Escolha o servidor" in resposta.text
    assert _texto_da_area(resposta.text, "descricao_atividade") == ROTINA


# ---------------------------------------------------------------------
# Entrega de EPI — o balcão, o formulário de maior repetição do sistema
# ---------------------------------------------------------------------
OBSERVACAO_ENTREGA = "Substituição do par furado no incidente de 12/03."


def _balcao(banco) -> dict:
    from datetime import timedelta

    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import Cargo, EpiCategoria, EpiItem, Servidor, UnidadeUorg

    with mod_banco.sessao() as s:
        categoria = s.execute(
            select(EpiCategoria).where(
                EpiCategoria.codigo == "PROT_MEMBROS_SUPERIORES"
            )
        ).scalar_one()
        unidade = s.execute(select(UnidadeUorg)).scalars().first()
        cargo = s.execute(select(Cargo)).scalars().first()
        servidor = Servidor(
            siape="7654321",
            nome="Joana Ribeiro de Almeida",
            cargo_id=cargo.id,
            unidade_uorg_id=unidade.id,
        )
        item = EpiItem(
            nome="Luva de proteção química nitrílica",
            categoria_id=categoria.id,
            fabricante="Fabricante Exemplo Ltda",
            exige_ca=True,
            numero_ca="41234",
            validade_ca=date.today() + timedelta(days=365),
            unidade_medida="PAR",
            tamanhos="P\nM\nG",
            quantidade_padrao=1,
        )
        s.add_all([servidor, item])
        s.commit()
        return {"servidor": servidor.id, "item": item.id}


def test_entrega_recusada_devolve_o_balcao_preenchido(app_cliente, contas, banco):
    """Data futura é recusa da rota, antes de o serviço ver o formulário."""
    from datetime import timedelta

    cenario = _balcao(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/entregas",
        data={
            "servidor_id": str(cenario["servidor"]),
            "item_id": str(cenario["item"]),
            "quantidade": "3",
            "entrada_id": "",
            "tamanho": "G",
            "data_evento": (date.today() + timedelta(days=2)).isoformat(),
            "observacao": OBSERVACAO_ENTREGA,
            "justificativa_excecao": "",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    assert "data futura" in corpo
    assert _texto_da_area(corpo, "observacao") == OBSERVACAO_ENTREGA
    assert _valor_do_campo(corpo, "quantidade") == "3"
    assert _selecionado(corpo, cenario["servidor"]), "quem recebe voltou em branco"
    assert _selecionado(corpo, cenario["item"]), "o equipamento voltou em branco"
    # o bloco de opções do item só existe depois de o item ser escolhido: sem
    # ele de volta, tamanho, lote e quantidade nem aparecem na tela
    assert _selecionado(corpo, "G")


def test_recusa_fundamentada_recusada_devolve_o_complemento(app_cliente, contas, banco):
    """O complemento é o texto que o requerente vai receber. Redigitá-lo é o que
    faz a segunda negativa sair mais curta e menos fundamentada."""
    complemento = "Equipe da empresa contratada X, contrato 15/2025, portão da FAMED."
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/entregas/recusa",
        data={
            "motivo_id": "",
            "a_quem": "chefia da FAMED, em nome da equipe terceirizada",
            "item_id": "",
            "unidade": "FAMED",
            "complemento": complemento,
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    assert "Escolha o motivo" in corpo
    assert _texto_da_area(corpo, "complemento") == complemento
    assert (
        _valor_do_campo(corpo, "a_quem")
        == "chefia da FAMED, em nome da equipe terceirizada"
    )
    assert _valor_do_campo(corpo, "unidade") == "FAMED"


# ---------------------------------------------------------------------
# Entrada de lote — dezenove campos copiados de papel
# ---------------------------------------------------------------------
def test_entrada_de_lote_recusada_devolve_a_transcricao(app_cliente, contas, banco):
    cenario = _balcao(banco)
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/epis/estoque",
        data={
            "item_id": str(cenario["item"]),
            "quantidade_recebida": "10",
            "data_entrada": date.today().isoformat(),
            "tamanho": "M",
            "pregao": "90012/2025",
            "item_pregao": "7",
            "empenho": "2026NE000123",
            "nota_fiscal": "4471",
            "quantidade_empenhada": "12",
            "valor_unitario": "12,50",
            "fornecedor_nome": "Distribuidora de EPI Ltda",
            "fornecedor_cnpj": "12345678000199",
            "fornecedor_contato": "vendas@distribuidora.com.br",
            "lote": "L-2026-08",
            "numero_ca": "41234",
            "validade_ca": "31/12/2027",  # o formato errado que a rota recusa
            "data_fabricacao": "",
            "observacao": "",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    assert "Validade do CA inválida" in corpo
    for campo, valor in (
        ("quantidade_recebida", "10"),
        ("pregao", "90012/2025"),
        ("empenho", "2026NE000123"),
        ("nota_fiscal", "4471"),
        ("quantidade_empenhada", "12"),
        ("valor_unitario", "12,50"),
        ("fornecedor_nome", "Distribuidora de EPI Ltda"),
        ("fornecedor_cnpj", "12345678000199"),
        ("lote", "L-2026-08"),
        ("numero_ca", "41234"),
    ):
        assert _valor_do_campo(corpo, campo) == valor, campo
    assert _selecionado(corpo, cenario["item"])


# ---------------------------------------------------------------------
# Nova turma — treze campos
# ---------------------------------------------------------------------
def test_turma_recusada_devolve_os_treze_campos(app_cliente, contas, banco):
    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import Treinamento

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/treinamentos/catalogo",
        data={
            "codigo": "NR-35",
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "8",
            "validade_meses": "24",
        },
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        treinamento_id = s.execute(
            select(Treinamento).where(Treinamento.codigo == "NR-35")
        ).scalar_one().id

    resposta = app_cliente.post(
        "/turmas",
        data={
            "treinamento_id": str(treinamento_id),
            "data_inicio": "",  # a recusa mais frequente desta tela
            "data_fim": "2026-03-13",
            "local": "Auditório do Campus JK",
            "campus_id": "",
            "unidade_promotora_id": "",
            "carga_horaria_horas": "8",
            "data_base_vencimento": "",
            "vagas": "24",
            "inscricao_aberta_ate": "2026-03-01",
            "nota_minima_aprovacao": "7",
            "frequencia_minima_percentual": "80",
            "observacoes": "Trazer bota e capacete próprios.",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 200
    corpo = resposta.text
    assert "Informe a data de início" in corpo
    for campo, valor in (
        ("data_fim", "2026-03-13"),
        ("local", "Auditório do Campus JK"),
        ("carga_horaria_horas", "8"),
        ("vagas", "24"),
        ("inscricao_aberta_ate", "2026-03-01"),
        ("nota_minima_aprovacao", "7"),
        ("frequencia_minima_percentual", "80"),
    ):
        assert _valor_do_campo(corpo, campo) == valor, campo
    assert _texto_da_area(corpo, "observacoes") == "Trazer bota e capacete próprios."
    assert _selecionado(corpo, treinamento_id)


def test_turma_recusada_nao_grava_nada(app_cliente, contas, banco):
    """Devolver o digitado à tela não é gravá-lo: o `rollback` de `_recusar`
    continua valendo — foi ele que impediu participante externo de ficar no
    banco sem inscrição."""
    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import Turma

    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/turmas",
        data={"treinamento_id": "999", "data_inicio": "", "data_fim": ""},
        follow_redirects=False,
    )
    with mod_banco.sessao() as s:
        assert s.execute(select(Turma)).first() is None
