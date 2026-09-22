"""Dados do Parecer Tecnico 1/2025 (Marco Antonio) - o caso de ouro do CA-01.

Transcritos do PDF assinado em entrada/Parecer_Tecnico_01-2025_assinado.pdf.
"""

from __future__ import annotations

from datetime import date

from app.servicos.documento import ContextoParecer

FUNDAMENTACAO_NR15_AX14 = (
    "“Trabalhos e operações em contato permanente com material infecto-contagiante, "
    "em: laboratórios de análise clínica e histopatologia”\n"
    "Anexo 14 da NR 15 e Instrução Normativa 15/2022."
)

ALTERACAO_SEST = (
    "Qualquer alteração na execução das atividades técnicas do servidor, bem como "
    "mudanças em sua carga horária, deverá ser comunicada ao Serviço Especializado "
    "em Segurança do Trabalho – SEST."
)


def contexto_1_2025() -> ContextoParecer:
    return ContextoParecer(
        numero_parecer=1,
        ano=2025,
        data_emissao=date(2025, 2, 11),
        cidade="Diamantina",
        sigla_unidade_emissora="SEST/DASA/PROGEP",
        nome_extenso_emissor="Serviço Especializado em Segurança do Trabalho",
        endereco_emissor=(
            "Rodovia MGT 367 - Km 583, nº 5000 - Alto da Jacuba - CEP 39100-000"
        ),
        telefone_emissor="Fone: (38) 3532-1200 e (38) 3532-6000",
        laudo_de="concessão",
        unidade="Faculdade de Medicina de Diamantina",
        postos=[
            "Laboratório Escola de análises Clínicas (LEAC)",
            "Laboratório de Doenças Infecciosas e Parasitárias",
        ],
        uorg_bruto="250 - FACULDADE DE MEDICINA DE DIAMANTINA",
        tipo_laudo="Adicional de Insalubridade",
        numero_processo_sei="23086.021284/2024-56",
        nome_servidor="Marco Antônio Alves Schetino",
        matricula="1110654",
        cargo="TECNICO DE LABORATORIO AREA",
        funcao="",
        laudo_siape="26255-000.125/2019",
        agentes_nocivos=["Contato permanente com material infecto-contagiante"],
        tipo_risco="Agente Biológico",
        percentual_aplicavel="Médio (10%)",
        portaria_localizacao="PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
        fundamentacao_legal=FUNDAMENTACAO_NR15_AX14,
        alteracao=ALTERACAO_SEST,
        recomendacao_tecnica=(
            "Reconhecer o direito ao adicional de insalubridade caracterizado pela "
            "exposição ao Agente Biológico, a partir da data da Portaria de "
            "Localização: 17 de setembro de 2024"
        ),
        reavaliacao=None,
        pro_reitor="MARINA FERREIRA DA COSTA",
        pro_reitor_cargo="Pró-reitora de Gestão de Pessoas",
        tratamento_destinatario="A sua senhoria, a senhora:",
        assinante_nome="Fabrício Raimundi Andrade",
        assinante_matricula="2165804",
        assinante_titulo="Eng. Seg. do Trabalho",
    )
