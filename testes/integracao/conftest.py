from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture()
def app_cliente(banco):
    """App FastAPI apontando para o banco de teja do fixture `banco`."""
    from app.principal import criar_app

    with TestClient(criar_app(), raise_server_exceptions=False) as cliente:
        yield cliente


@pytest.fixture()
def contas(banco):
    """Cria contas com perfis reais e devolve {codigo_perfil: (login, senha)}."""
    from app import banco as mod_banco
    from app.modelos import Atribuicao, Perfil, ProfissionalHabilitado, Usuario
    from app.servicos import autenticacao

    senha = "SenhaDeTeste2026"
    criadas: dict[str, tuple[str, str]] = {}
    with mod_banco.sessao() as s:
        for codigo, nome in (
            ("coordenador_csso", "Coordenador de Teste"),
            ("tecnico_seguranca", "Técnica de Teste"),
            ("secretaria_csso", "Secretaria de Teste"),
            ("auditor_interno", "Auditor de Teste"),
            ("superintendente", "Superintendente de Teste"),
            ("admin_ti", "Admin TI de Teste"),
            ("consulta_progep", "PROGEP de Teste"),
            ("servidor_consulta", "Servidor de Teste"),
            ("engenheiro_seguranca", "Engenheiro de Teste"),
            ("medico_trabalho", "Médico de Teste"),
            # nasceu na fatia 3 do EPI. Precisa de conta aqui porque é a única
            # forma de os testes de permissão exercitarem o perfil de verdade —
            # e ele é o primeiro que opera um módulo sem ter `processo.ver`,
            # que é justamente o caso em que uma permissão esquecida some da
            # tela sem erro nenhum.
            ("almoxarife_sesmt", "Almoxarife de Teste"),
        ):
            usuario = Usuario(
                login=codigo,
                nome=nome,
                email=f"{codigo}@teste.ufvjm.edu.br",
                senha_hash=autenticacao.gerar_hash(senha),
                precisa_trocar_senha=False,
            )
            s.add(usuario)
            s.flush()
            perfil = s.execute(select(Perfil).where(Perfil.codigo == codigo)).scalar_one()
            s.add(
                Atribuicao(
                    usuario_id=usuario.id,
                    perfil_id=perfil.id,
                    vigencia_inicio=date(2020, 1, 1),
                    ato_normativo="Ato de teste",
                )
            )
            criadas[codigo] = (codigo, senha)

        # o coordenador e o unico com habilitacao tecnica vigente
        habilitado = s.execute(
            select(ProfissionalHabilitado).where(
                ProfissionalHabilitado.nome == "Fabrício Raimundi Andrade"
            )
        ).scalar_one()
        coordenador = s.execute(
            select(Usuario).where(Usuario.login == "coordenador_csso")
        ).scalar_one()
        habilitado.usuario_id = coordenador.id
        s.commit()
    return criadas


@pytest.fixture()
def atores(sessao):
    """Cria as contas reais (as FKs de auditoria e emitido_por apontam para elas)."""
    from app.modelos import Usuario
    from app.servicos import autenticacao
    from testes.integracao import papeis

    criadas = {}
    for login, nome in (("coord", "Coordenador"), ("fatima", "Fátima")):
        usuario = Usuario(
            login=login,
            nome=nome,
            email=f"{login}@teste.ufvjm.edu.br",
            senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
            precisa_trocar_senha=False,
        )
        sessao.add(usuario)
        sessao.flush()
        criadas[login] = usuario

    papeis.definir(criadas["coord"].id, criadas["fatima"].id)
    return criadas


@pytest.fixture()
def cenario(sessao, atores):
    """O caso do Parecer 1/2025 (Marco Antônio) montado direto no banco."""
    from datetime import date

    from app.modelos import (
        AgenteNocivo,
        AutoridadeDestinataria,
        Cargo,
        Exposicao,
        FluxoEtapa,
        LaudoTecnico,
        ParecerPosto,
        ParecerTecnico,
        PercentualAplicavel,
        PortariaLocalizacao,
        PostoTrabalho,
        Processo,
        ProfissionalHabilitado,
        Servidor,
        TipoAdicional,
        TipoMarcoInicial,
        TipoMovimento,
        TipoProcesso,
        UnidadeUorg,
    )
    from app.servicos.documento import MODELO_V1

    def pegar(modelo, **filtros):
        return sessao.execute(select(modelo).filter_by(**filtros)).scalar_one()

    famed = pegar(UnidadeUorg, codigo_uorg="250")
    cargo = pegar(Cargo, nome="TECNICO DE LABORATORIO AREA")
    insalubridade = pegar(TipoAdicional, codigo="INSALUBRIDADE")
    concessao = pegar(TipoMovimento, codigo="CONCESSAO")
    marco = pegar(TipoMarcoInicial, codigo="PORTARIA_LOCALIZACAO")
    destinatario = sessao.execute(select(AutoridadeDestinataria)).scalars().first()
    signatario = pegar(ProfissionalHabilitado, nome="Fabrício Raimundi Andrade")
    agente = pegar(
        AgenteNocivo, descricao="Contato permanente com material infecto-contagiante"
    )
    medio = pegar(
        PercentualAplicavel, tipo_adicional_id=insalubridade.id, grau="MEDIO"
    )
    leac = pegar(
        PostoTrabalho,
        unidade_uorg_id=famed.id,
        nome="Laboratório Escola de análises Clínicas (LEAC)",
    )
    ldip = pegar(
        PostoTrabalho,
        unidade_uorg_id=famed.id,
        nome="Laboratório de Doenças Infecciosas e Parasitárias",
    )

    servidor = Servidor(
        siape="1110654",
        nome="Marco Antônio Alves Schetino",
        cargo_id=cargo.id,
        unidade_uorg_id=famed.id,
    )
    sessao.add(servidor)
    portaria = PortariaLocalizacao(
        unidade_emissora_id=famed.id,
        numero="35",
        ano=2024,
        data_publicacao=date(2024, 9, 17),
        texto_original="PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
    )
    sessao.add(portaria)
    laudo = LaudoTecnico(
        numero_siape="26255-000.125/2019",
        ano=2019,
        tipo_adicional_id=insalubridade.id,
        unidade_uorg_id=famed.id,
        data_emissao=date(2019, 6, 1),
        subscritor_id=signatario.id,
    )
    sessao.add(laudo)

    etapa = pegar(FluxoEtapa, codigo="EM_ANDAMENTO")
    tipo = pegar(TipoProcesso, codigo="ADICIONAL_OCUPACIONAL")
    sessao.flush()

    processo = Processo(
        nup="23086.021284/2024-56",
        tipo_processo_id=tipo.id,
        etapa_id=etapa.id,
        estado_tecnico="PARECER_EM_ELABORACAO",
        servidor_id=servidor.id,
        unidade_uorg_id=famed.id,
        data_autuacao=date(2024, 10, 1),
    )
    sessao.add(processo)
    sessao.flush()

    parecer = ParecerTecnico(
        numero=0,
        ano=2025,
        situacao="RASCUNHO",
        processo_id=processo.id,
        servidor_id=servidor.id,
        laudo_id=laudo.id,
        tipo_adicional_id=insalubridade.id,
        tipo_movimento_id=concessao.id,
        unidade_uorg_id=famed.id,
        portaria_id=portaria.id,
        destinatario_id=destinatario.id,
        signatario_id=signatario.id,
        tipo_marco_id=marco.id,
        data_marco_inicial=date(2024, 9, 17),
        data_emissao=date(2025, 2, 11),
        texto_recomendacao=(
            "Reconhecer o direito ao adicional de insalubridade caracterizado pela "
            "exposição ao Agente Biológico, a partir da data da Portaria de "
            "Localização: 17 de setembro de 2024"
        ),
        texto_alteracao=(
            "Qualquer alteração na execução das atividades técnicas do servidor, bem "
            "como mudanças em sua carga horária, deverá ser comunicada ao Serviço "
            "Especializado em Segurança do Trabalho – SEST."
        ),
        modelo_arquivo=MODELO_V1,
    )
    sessao.add(parecer)
    sessao.flush()
    sessao.add_all(
        [
            ParecerPosto(parecer_id=parecer.id, posto_trabalho_id=leac.id, ordem=1),
            ParecerPosto(parecer_id=parecer.id, posto_trabalho_id=ldip.id, ordem=2),
            Exposicao(
                parecer_id=parecer.id,
                agente_nocivo_id=agente.id,
                percentual_id=medio.id,
                fundamentacao_id=agente.fundamentacao_id,
                principal=True,
                horas_exposicao_mensais=160,
                jornada_mensal_horas=160,
                classificacao_exposicao="PERMANENTE",
                percentual_jornada=100,
            ),
        ]
    )
    sessao.flush()
    return {"parecer": parecer, "processo": processo, "laudo": laudo, "servidor": servidor}


def entrar(cliente: TestClient, contas: dict, perfil: str) -> TestClient:
    login, senha = contas[perfil]
    resposta = cliente.post(
        "/login", data={"login": login, "senha": senha}, follow_redirects=False
    )
    assert resposta.status_code == 303, resposta.text
    return cliente
