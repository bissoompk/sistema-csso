"""Recusa não grava: nenhuma operação recusada deixa rastro no banco.

A sessão que as rotas recebem (`dependencias.obter_sessao` sobre o
`banco.sessao`) dá **commit** sempre que a rota termina sem levantar exceção —
inclusive quando o que a rota devolveu foi um aviso de recusa. Só o `raise`
desfaz sozinho, porque aí o FastAPI joga a exceção na dependência e o
`except` do context manager faz rollback.

Foi assim que, nas rotas de turma, cadastrar um participante externo e esbarrar
na turma lotada gravava a pessoa — nome e e-mail — sem inscrição nenhuma. Estes
testes conferem a mesma propriedade nas telas que já foram varridas: a recusa
aparece na tela **e** o banco continua como estava.

`/catalogos` e `/treinamentos` sempre passaram, porque conferem tudo antes de
escrever; estão aqui para que a ordem não se inverta na próxima edição, quando
ninguém mais lembrar do porquê. Os de `/servidores` e `/pareceres` nasceram
vermelhos: a lotação recusada deixava um período fantasma, o número repetido
deixava o parecer com ano novo e número velho, e a emissão bloqueada carimbava
a data de emissão num rascunho que nunca foi emitido.

Não confundir com a recusa cuja escrita É o ponto: `POST /login` grava o
contador de tentativas falhas e `pareceres.emitir` grava o evento
`ASSINATURA_NEGADA`. Esses ficam — e há teste aqui para garantir que fiquem.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import func, select

from app.modelos import (
    AssinaturaInstrutor,
    Campus,
    Cargo,
    CertificadoModelo,
    CertificadoModeloTag,
    HistoricoEvento,
    ParecerTecnico,
    PortariaLocalizacao,
    PostoTrabalho,
    ProfissionalHabilitado,
    Servidor,
    ServidorLotacao,
    Treinamento,
    UnidadeUorg,
)
from testes.integracao.conftest import entrar


def _quantos(modelo, *condicoes) -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        consulta = select(func.count()).select_from(modelo)
        for condicao in condicoes:
            consulta = consulta.where(condicao)
        return s.execute(consulta).scalar_one()


def _id(modelo, **filtros) -> int:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.execute(select(modelo).filter_by(**filtros)).scalar_one().id


def _eventos() -> int:
    return _quantos(HistoricoEvento)


# =====================================================================
# /catalogos
# =====================================================================
def test_portaria_sem_data_nao_deixa_portaria_no_banco(app_cliente, contas, banco):
    """Colar um texto de onde não sai data pede a data — e não guarda o texto."""
    entrar(app_cliente, contas, "coordenador_csso")
    famed = _id(UnidadeUorg, codigo_uorg="250")
    antes = _eventos()

    resposta = app_cliente.post(
        "/catalogos/portarias",
        data={
            "texto_original": "Documento sem número nem data reconhecível",
            "unidade_emissora_id": str(famed),
            "data_publicacao": "",
            "numero": "",
        },
        follow_redirects=True,
    )
    assert "Informe a data de publicação" in resposta.text
    assert _quantos(PortariaLocalizacao) == 0
    assert _eventos() == antes


def test_portaria_repetida_nao_reescreve_a_que_ja_existe(app_cliente, contas, banco):
    """001, 01 e 1 são a mesma portaria: a segunda tentativa é recusada inteira,
    e o texto que veio nela não pode substituir o texto já guardado."""
    entrar(app_cliente, contas, "coordenador_csso")
    famed = _id(UnidadeUorg, codigo_uorg="250")
    original = "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024"
    app_cliente.post(
        "/catalogos/portarias",
        data={"texto_original": original, "unidade_emissora_id": str(famed)},
        follow_redirects=False,
    )
    assert _quantos(PortariaLocalizacao) == 1
    antes = _eventos()

    resposta = app_cliente.post(
        "/catalogos/portarias",
        data={
            "texto_original": "TEXTO TROCADO QUE NÃO PODE ENTRAR",
            "unidade_emissora_id": str(famed),
            "numero": "035",
            "data_publicacao": "2024-09-17",
        },
        follow_redirects=True,
    )
    assert "já cadastrada" in resposta.text
    assert _quantos(PortariaLocalizacao) == 1
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        assert s.execute(select(PortariaLocalizacao)).scalar_one().texto_original == original
    assert _eventos() == antes


def test_unidade_com_codigo_de_outra_nao_entra_no_banco(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    campus = _id(Campus, sigla="DIA")
    antes = _eventos()

    resposta = app_cliente.post(
        "/catalogos/unidades-uorg",
        data={
            "nome_oficial": "UNIDADE FANTASMA",
            "nome_extenso": "Unidade Fantasma",
            "tipo": "INSTITUTO",
            "campus_id": str(campus),
            "codigo_uorg": "250",  # já é da FAMED
        },
        follow_redirects=True,
    )
    assert "Já existe unidade com o código" in resposta.text
    assert _quantos(UnidadeUorg, UnidadeUorg.nome_oficial == "UNIDADE FANTASMA") == 0
    assert _eventos() == antes


def test_posto_repetido_nao_entra_no_banco(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    famed = _id(UnidadeUorg, codigo_uorg="250")
    leac = "Laboratório Escola de análises Clínicas (LEAC)"
    antes_postos = _quantos(PostoTrabalho, PostoTrabalho.nome == leac)
    antes = _eventos()

    resposta = app_cliente.post(
        "/catalogos/postos-trabalho",
        data={"unidade_uorg_id": str(famed), "nome": leac, "sigla": "LEAC2"},
        follow_redirects=True,
    )
    assert "já existe nesta unidade" in resposta.text
    assert _quantos(PostoTrabalho, PostoTrabalho.nome == leac) == antes_postos
    assert _eventos() == antes


def test_cargo_homonimo_nao_cria_segundo_cargo(app_cliente, contas, banco):
    """Recadastrar um cargo com outro código SIAPE é recusa: nem duplica o
    cargo, nem troca o código do que já está lá."""
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "ENFERMEIRO", "codigo_siape": "701407"},
        follow_redirects=False,
    )
    assert _quantos(Cargo, Cargo.nome == "ENFERMEIRO") == 1
    antes = _eventos()

    resposta = app_cliente.post(
        "/catalogos/cargos",
        data={"nome": "ENFERMEIRO", "codigo_siape": "999999"},
        follow_redirects=True,
    )
    assert "já está cadastrado" in resposta.text
    assert _quantos(Cargo, Cargo.nome == "ENFERMEIRO") == 1
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        cargo = s.execute(select(Cargo).where(Cargo.nome == "ENFERMEIRO")).scalar_one()
        assert cargo.codigo_siape == "701407"
    assert _eventos() == antes


# =====================================================================
# /treinamentos
# =====================================================================
NR35 = {
    "codigo": "NR-35",
    "nome": "Trabalho em Altura — NR-35",
    "carga_horaria_horas": "8",
    "validade_meses": "24",
}


def test_treinamento_com_codigo_invalido_nao_entra_no_banco(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/catalogo",
        data={**NR35, "codigo": "nr 35!"},
        follow_redirects=True,
    )
    assert "Código inválido" in resposta.text
    assert _quantos(Treinamento) == 0


def test_treinamento_repetido_nao_reescreve_o_que_ja_existe(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post("/treinamentos/catalogo", data=NR35, follow_redirects=False)
    assert _quantos(Treinamento) == 1
    antes = _eventos()

    resposta = app_cliente.post(
        "/treinamentos/catalogo",
        data={**NR35, "nome": "Outro nome", "carga_horaria_horas": "40"},
        follow_redirects=True,
    )
    assert "Já existe treinamento" in resposta.text
    assert _quantos(Treinamento) == 1
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        treinamento = s.execute(select(Treinamento)).scalar_one()
        assert treinamento.nome == NR35["nome"]
        assert treinamento.carga_horaria_horas == 8
    assert _eventos() == antes


def test_instrutor_sem_servidor_nao_deixa_o_nome_da_pessoa_no_banco(
    app_cliente, contas, banco
):
    """O caso que motivou a auditoria, na tela de assinaturas.

    Quem preenche nome, título e registro de conselho e esbarra na recusa
    ("instrutor da UFVJM precisa de servidor") não pode ter esses dados
    guardados: é dado pessoal de quem não chegou a ser cadastrado.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    antes = _eventos()

    resposta = app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "nome": "Joana Ribeiro Nunes",
            "titulo": "Bombeira militar",
            "conselho": "crea",
            "registro_conselho": "MG-987654",
            "organizacao": "Corpo de Bombeiros",
            "vigencia_inicio": "2026-01-01",
        },
        follow_redirects=True,
    )
    assert "precisa estar vinculado a um servidor" in resposta.text
    assert _quantos(AssinaturaInstrutor) == 0
    assert _eventos() == antes


def test_vigencia_invertida_nao_deixa_a_assinatura_no_banco(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/assinaturas",
        data={
            "nome": "Joana Ribeiro Nunes",
            "externo": "1",
            "vigencia_inicio": "2026-12-31",
            "vigencia_fim": "2026-01-01",
        },
        follow_redirects=True,
    )
    assert "não pode ser anterior ao início" in resposta.text
    assert _quantos(AssinaturaInstrutor) == 0


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


def test_modelo_com_nome_repetido_nao_cria_segundo_modelo(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    assert _quantos(CertificadoModelo) == 1
    antes = _eventos()

    resposta = app_cliente.post(
        "/treinamentos/modelos",
        data={
            "nome": "Certificado padrão CSSO",
            "arquivo": "outro_arquivo.docx",
            "orientacao": "RETRATO",
        },
        follow_redirects=True,
    )
    assert "já existe" in resposta.text
    assert _quantos(CertificadoModelo) == 1
    assert _eventos() == antes


def test_tag_com_campo_desconhecido_nao_entra_no_mapa(app_cliente, contas, banco):
    """Campo fora do vocabulário sairia em branco no papel — recusa, e o
    marcador não pode ficar no mapa esperando alguém consertar."""
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    modelo_id = _id(CertificadoModelo, nome="Certificado padrão CSSO")
    antes = _eventos()

    resposta = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "nome_do_aluno", "campo": "campo_que_nao_existe", "ordem": "1"},
        follow_redirects=True,
    )
    assert "Campo desconhecido" in resposta.text
    assert _quantos(CertificadoModeloTag) == 0
    assert _eventos() == antes


def test_marcador_repetido_nao_entra_duas_vezes_no_mapa(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    modelo_id = _id(CertificadoModelo, nome="Certificado padrão CSSO")
    app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "nome_do_aluno", "campo": "participante_nome", "ordem": "1"},
        follow_redirects=False,
    )
    assert _quantos(CertificadoModeloTag) == 1
    antes = _eventos()

    resposta = app_cliente.post(
        f"/treinamentos/modelos/{modelo_id}/tags",
        data={"marcador": "nome_do_aluno", "campo": "treinamento_nome", "ordem": "2"},
        follow_redirects=True,
    )
    assert "já está mapeado" in resposta.text
    assert _quantos(CertificadoModeloTag) == 1
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        assert s.execute(select(CertificadoModeloTag)).scalar_one().campo == "participante_nome"
    assert _eventos() == antes


def test_versao_superada_nao_publica_nem_aposenta_a_vigente(app_cliente, contas, banco):
    """Clonar a v1 depois da v2 reviveria o mapa antigo e aposentaria o que
    vale. A recusa tem de deixar a v2 vigente e nenhuma v3 no banco."""
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    v1 = _id(CertificadoModelo, nome="Certificado padrão CSSO")
    app_cliente.post(f"/treinamentos/modelos/{v1}/versao", follow_redirects=False)
    assert _quantos(CertificadoModelo) == 2
    antes = _eventos()

    resposta = app_cliente.post(
        f"/treinamentos/modelos/{v1}/versao", follow_redirects=True
    )
    assert "Versão superada não se edita" in resposta.text
    assert _quantos(CertificadoModelo) == 2
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        vigentes = list(
            s.execute(
                select(CertificadoModelo).where(CertificadoModelo.vigente.is_(True))
            ).scalars()
        )
        assert [m.versao for m in vigentes] == [2]
    assert _eventos() == antes


def test_versao_superada_nao_aceita_edicao(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    _criar_modelo(app_cliente)
    v1 = _id(CertificadoModelo, nome="Certificado padrão CSSO")
    app_cliente.post(f"/treinamentos/modelos/{v1}/versao", follow_redirects=False)
    antes = _eventos()

    resposta = app_cliente.post(
        f"/treinamentos/modelos/{v1}",
        data={
            "nome": "Nome trocado na versão velha",
            "arquivo": "outro.docx",
            "orientacao": "RETRATO",
        },
        follow_redirects=True,
    )
    assert "Versão superada não se edita" in resposta.text
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        antiga = s.get(CertificadoModelo, v1)
        assert antiga.nome == "Certificado padrão CSSO"
        assert antiga.arquivo == "certificado_padrao.docx"
    assert _eventos() == antes


def test_vinculo_recusado_nao_salva_o_resto_da_linha(app_cliente, contas, banco):
    """A linha do catálogo salva inteira ou não salva: apontar um modelo de
    outro treinamento não pode gravar a carga horária nova e descartar só o
    vínculo — a pessoa veria o aviso e acreditaria que nada foi salvo."""
    entrar(app_cliente, contas, "coordenador_csso")
    app_cliente.post("/treinamentos/catalogo", data=NR35, follow_redirects=False)
    alvo = _id(Treinamento, codigo="NR-35")
    app_cliente.post(
        "/treinamentos/catalogo",
        data={**NR35, "codigo": "BRIGADA", "nome": "Brigada de incêndio"},
        follow_redirects=False,
    )
    outro = _id(Treinamento, codigo="BRIGADA")
    _criar_modelo(app_cliente, nome="Certificado da brigada", treinamento_id=str(outro))
    modelo_alheio = _id(CertificadoModelo, nome="Certificado da brigada")
    antes = _eventos()

    resposta = app_cliente.post(
        f"/treinamentos/catalogo/{alvo}",
        data={
            "nome": "Trabalho em Altura — NR-35",
            "carga_horaria_horas": "40",
            "validade_meses": "12",
            "modelo_vigente_id": str(modelo_alheio),
            "ativo": "1",
        },
        follow_redirects=True,
    )
    assert "é de outro treinamento" in resposta.text
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        treinamento = s.get(Treinamento, alvo)
        assert treinamento.carga_horaria_horas == 8
        assert treinamento.validade_meses == 24
        assert treinamento.modelo_vigente_id is None
    assert _eventos() == antes


def test_data_de_hoje_nao_e_inventada_para_treinamento_recusado(app_cliente, contas, banco):
    """Validade em branco é recusa, não zero — e a recusa não grava nada."""
    entrar(app_cliente, contas, "coordenador_csso")
    resposta = app_cliente.post(
        "/treinamentos/catalogo",
        data={**NR35, "validade_meses": ""},
        follow_redirects=True,
    )
    assert "Validade inválida" in resposta.text
    assert _quantos(Treinamento) == 0


# =====================================================================
# /servidores — mudança de lotação
# =====================================================================
def _servidor_migrado(siape="1473142", nome="Gabriela Silva Ramos") -> int:
    """Servidor que veio da planilha antiga: cadastro sem linha do tempo."""
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        servidor = Servidor(siape=siape, nome=nome)
        s.add(servidor)
        s.flush()
        return servidor.id


def _periodos(servidor_id: int) -> list[ServidorLotacao]:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        itens = list(
            s.execute(
                select(ServidorLotacao).where(ServidorLotacao.servidor_id == servidor_id)
            ).scalars()
        )
        return sorted(itens, key=lambda l: l.vigencia_inicio)


def test_recusar_a_mudanca_de_lotacao_nao_deixa_periodo_fantasma(
    app_cliente, contas, banco
):
    """Quem vê "nada mudou" não pode ficar com um período de lotação novo.

    Para o servidor migrado, sem linha do tempo, a tela abre o período de origem
    antes de comparar. Se a comparação recusa, esse período não pode sobrar:
    ninguém pediu por ele e a tela disse que nada foi feito.
    """
    entrar(app_cliente, contas, "coordenador_csso")
    servidor_id = _servidor_migrado()

    resposta = app_cliente.post(
        f"/servidores/{servidor_id}/lotacao",
        data={
            "a_partir_de": date.today().isoformat(),
            "unidade_uorg_id": "",
            "uorg_id": "",
            "cargo_id": "",
            "funcao": "",
        },
        follow_redirects=True,
    )
    assert "nada mudou" in resposta.text
    assert _quantos(ServidorLotacao) == 0


def test_posto_de_outra_unidade_nao_deixa_periodo_fantasma(app_cliente, contas, banco):
    entrar(app_cliente, contas, "coordenador_csso")
    famed = _id(UnidadeUorg, codigo_uorg="250")
    ica = _id(UnidadeUorg, codigo_uorg="261")
    quimica = _id(PostoTrabalho, unidade_uorg_id=ica, nome="Laboratório de Química")
    servidor_id = _servidor_migrado()

    resposta = app_cliente.post(
        f"/servidores/{servidor_id}/lotacao",
        data={
            "a_partir_de": date.today().isoformat(),
            "unidade_uorg_id": str(famed),
            "posto_id": [str(quimica)],
        },
        follow_redirects=True,
    )
    assert "pertence a outra unidade" in resposta.text
    assert _quantos(ServidorLotacao) == 0


def test_lotacao_recusada_nao_estraga_a_tentativa_seguinte(app_cliente, contas, banco):
    """O período fantasma virava o "período atual" e passava a barrar datas
    anteriores a ele: a segunda tentativa, correta, era recusada por causa da
    primeira, que a tela tinha dito que não valeu."""
    entrar(app_cliente, contas, "coordenador_csso")
    famed = _id(UnidadeUorg, codigo_uorg="250")
    ica = _id(UnidadeUorg, codigo_uorg="261")
    quimica = _id(PostoTrabalho, unidade_uorg_id=ica, nome="Laboratório de Química")
    servidor_id = _servidor_migrado()

    recusada = app_cliente.post(
        f"/servidores/{servidor_id}/lotacao",
        data={
            "a_partir_de": "2024-05-10",
            "unidade_uorg_id": str(famed),
            "posto_id": [str(quimica)],
        },
        follow_redirects=True,
    )
    assert "pertence a outra unidade" in recusada.text

    aceita = app_cliente.post(
        f"/servidores/{servidor_id}/lotacao",
        data={"a_partir_de": "2020-03-02", "unidade_uorg_id": str(ica)},
        follow_redirects=False,
    )
    assert aceita.status_code == 303, aceita.text
    assert [p.vigencia_inicio for p in _periodos(servidor_id)] == [
        date(2020, 3, 1),
        date(2020, 3, 2),
    ]


# =====================================================================
# /pareceres
# =====================================================================
def _abrir_rascunho(app_cliente, contas) -> tuple[str, int]:
    entrar(app_cliente, contas, "coordenador_csso")
    criado = app_cliente.post(
        "/processos/novo",
        data={"nup": "23086.021284/2024-56", "tipo_processo_id": "1"},
        follow_redirects=False,
    )
    rascunho = app_cliente.get(
        f"{criado.headers['location']}/parecer", follow_redirects=False
    )
    caminho = rascunho.headers["location"]
    return caminho, int(caminho.rsplit("/", 1)[-1])


def _parecer(parecer_id: int) -> ParecerTecnico:
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        return s.get(ParecerTecnico, parecer_id)


def test_numero_repetido_nao_deixa_o_parecer_com_ano_novo_e_numero_velho(
    app_cliente, contas, banco
):
    """Mudar o ano e cair em número já usado é recusa do formulário inteiro.

    Se o ano entra e o número não, o parecer fica exatamente na combinação que
    a checagem existe para impedir — e os outros campos do formulário, que a
    pessoa acabou de preencher, foram embora sem aviso.
    """
    from app import banco as mod_banco

    with mod_banco.sessao() as s:
        s.add(ParecerTecnico(numero=9, ano=2027, situacao="RESERVADO"))

    caminho, parecer_id = _abrir_rascunho(app_cliente, contas)
    ano_antes = _parecer(parecer_id).ano
    assert ano_antes != 2027

    resposta = app_cliente.post(caminho, data={"numero": "9", "ano": "2027"})
    assert "já pertence a outro parecer" in resposta.text

    depois = _parecer(parecer_id)
    assert depois.ano == ano_antes
    assert depois.numero == 0


def test_emissao_bloqueada_nao_carimba_a_data_de_emissao(app_cliente, contas, banco):
    """Rascunho incompleto continua sem data de emissão.

    A data carimbada num parecer que não foi emitido passa a alimentar a
    validação, a montagem do documento e a checagem de vigência do signatário
    (RN-01) — a recusa de hoje contamina as decisões de amanhã.
    """
    from app import banco as mod_banco

    caminho, parecer_id = _abrir_rascunho(app_cliente, contas)
    habilitado = _id(ProfissionalHabilitado, nome="Fabrício Raimundi Andrade")
    with mod_banco.sessao() as s:
        # signatário em ordem: o bloqueio vem dos campos que faltam, não da RN-01
        s.get(ParecerTecnico, parecer_id).signatario_id = habilitado

    resposta = app_cliente.post(f"{caminho}/emitir", follow_redirects=True)
    assert "laudo técnico" in resposta.text

    depois = _parecer(parecer_id)
    assert depois.data_emissao is None
    assert depois.situacao == "RASCUNHO"


def test_signatario_sem_habilitacao_guarda_o_evento_mas_nao_a_data(
    app_cliente, contas, banco
):
    """A recusa da RN-01 é o contraexemplo: o registro da recusa TEM de ficar.

    O evento `ASSINATURA_NEGADA` é a prova de que alguém tentou emitir sem
    habilitação (IN 15/2022, art. 10, §2º, I) e é gravado de propósito. O que
    não pode ficar é a data de emissão do parecer que não foi emitido.
    """
    caminho, parecer_id = _abrir_rascunho(app_cliente, contas)  # nasce sem signatário
    antes = _quantos(
        HistoricoEvento, HistoricoEvento.tipo_evento == "ASSINATURA_NEGADA"
    )

    resposta = app_cliente.post(f"{caminho}/emitir")
    assert resposta.status_code == 403

    assert (
        _quantos(HistoricoEvento, HistoricoEvento.tipo_evento == "ASSINATURA_NEGADA")
        == antes + 1
    )
    assert _parecer(parecer_id).data_emissao is None
