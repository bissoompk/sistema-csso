"""Seeds obrigatorios (SS5 do prompt) - valores reais, conferidos nos documentos.

Regra transversal: nomes de posto, unidade, cargo e portaria sao gravados byte a
byte como aparecem no documento de origem. O sistema nunca normaliza caixa
nesses campos.

Idempotente: rodar duas vezes nao duplica nada.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    AgenteNocivo,
    AutoridadeDestinataria,
    Campus,
    Cargo,
    EpiCategoria,
    EpiMotivoRecusa,
    FluxoEtapa,
    FundamentacaoLegal,
    Perfil,
    Permissao,
    PercentualAplicavel,
    PostoTrabalho,
    ProfissionalHabilitado,
    SetorEmissor,
    TextoPadrao,
    TipoAdicional,
    TipoMarcoInicial,
    TipoMovimento,
    TipoProcesso,
    TipoRisco,
    UnidadeUorg,
)
from app.servicos.rbac import MATRIZ_PERFIS, PERMISSOES, modulo_da_permissao

# =====================================================================
# Textos literais (aspas curvas em ambos - SS5)
# =====================================================================
TEXTO_NR15_AX14 = (
    "“Trabalhos e operações em contato permanente com material infecto-contagiante, "
    "em: laboratórios de análise clínica e histopatologia”\n"
    "Anexo 14 da NR 15 e Instrução Normativa 15/2022."
)
TEXTO_NR15_AX13 = (
    "“Fabricação e manipulação de ácido oxálico, nítrico sulfúrico, clorídrico, "
    "fosfórico, pícrico.”\n"
    "“Manipulação de álcalis cáusticos.”\n"
    "Anexo 13 da NR 15 e Instrução Normativa 15/2022."
)

# A negativa que faz a decisao 3 do coordenador virar comportamento de sistema.
# O ultimo periodo e o que separa um "nao" de um encaminhamento: quem recebe
# fica sabendo o que fazer, e a fiscalizacao do contrato fica sabendo que ha um
# caso. Sai literal na guia impressa e na notificacao ao requerente.
TEXTO_RECUSA_VINCULO = (
    "O equipamento de proteção individual do empregado de empresa contratada é "
    "obrigação do empregador, nos termos da NR-6. A UFVJM não fornece EPI a "
    "pessoal terceirizado; o pedido deve ser dirigido à empresa contratante, e a "
    "fiscalização do contrato pode ser acionada se o fornecimento não estiver "
    "ocorrendo."
)

ENDERECO_UFVJM = "Rodovia MGT 367 - Km 583, nº 5000 - Alto da Jacuba - CEP 39100-000"
TELEFONE_UFVJM = "Fone: (38) 3532-1200 e (38) 3532-6000"


def _obter_ou_criar(s: Session, modelo, chaves: dict, valores: dict | None = None):
    obj = s.execute(select(modelo).filter_by(**chaves)).scalar_one_or_none()
    if obj is None:
        obj = modelo(**chaves, **(valores or {}))
        s.add(obj)
        s.flush()
    return obj


# =====================================================================
def semear_rbac(s: Session) -> None:
    for codigo, descricao in PERMISSOES.items():
        permissao = _obter_ou_criar(
            s,
            Permissao,
            {"codigo": codigo},
            {"descricao": descricao, "modulo": modulo_da_permissao(codigo)},
        )
        # descricao e modulo tambem sao reconferidos em quem ja existe: o banco
        # do coordenador ja tem as permissoes antigas gravadas como 'ADICIONAL'.
        # Nenhuma tela le `modulo` hoje (ver rbac.py) — reconferir aqui e o que
        # deixa a coluna pronta para quando existir a tela de permissoes por
        # modulo. Em compensacao, descricao e modulo passam a ser propriedade do
        # codigo: o seed os reescreve a cada boot, entao editar no banco nao
        # adianta. Perfil e atribuicao continuam intocados.
        permissao.descricao = descricao
        permissao.modulo = modulo_da_permissao(codigo)
    s.flush()
    permissoes = {p.codigo: p for p in s.execute(select(Permissao)).scalars()}

    for codigo, dados in MATRIZ_PERFIS.items():
        perfil = _obter_ou_criar(
            s,
            Perfil,
            {"codigo": codigo},
            {"nome": dados["nome"], "base_normativa": dados.get("base_normativa")},
        )
        atuais = {p.codigo for p in perfil.permissoes}
        for cod in dados["permissoes"]:
            if cod not in atuais:
                perfil.permissoes.append(permissoes[cod])
    s.flush()


def semear_organizacao(s: Session) -> dict:
    campi = {
        "DIA": ("Campus JK / Diamantina", "Diamantina", False),
        "MUC": ("Campus do Mucuri", "Teófilo Otoni", False),
        # avancados: default assumido, confirmar com o Fabricio (PENDENCIAS.md)
        "JAN": ("Campus Avançado de Janaúba", "Janaúba", True),
        "UNA": ("Campus Avançado de Unaí", "Unaí", True),
    }
    objetos_campus = {}
    for sigla, (nome, cidade, avancado) in campi.items():
        objetos_campus[sigla] = _obter_ou_criar(
            s,
            Campus,
            {"sigla": sigla},
            {"nome": nome, "cidade": cidade, "uf": "MG", "avancado": avancado},
        )
    s.flush()

    # (codigo, sigla, nome_oficial, nome_extenso, tipo, campus, emite_portaria, pai)
    unidades = [
        ("250", "FAMED", "FACULDADE DE MEDICINA DE DIAMANTINA",
         "Faculdade de Medicina de Diamantina", "FACULDADE", "DIA", True, None),
        ("259", "FAMMUC", "FACULDADE DE MEDICINA DO MUCURI",
         "Faculdade de Medicina do Mucuri", "FACULDADE", "MUC", True, None),
        ("260", "IECT", "INSTITUTO DE ENG., CIENCIA E TECNOLOGIA",
         "Instituto de Engenharia, Ciência e Tecnologia (IECT)", "INSTITUTO", "MUC", True, None),
        ("261", "ICA", "INSTITUTO DE CIENCIAS AGRARIAS",
         "Instituto de Ciências Agrárias", "INSTITUTO", "UNA", True, None),
        # codigos UORG de FCBS e FCA pendentes de confirmacao (PENDENCIAS.md)
        (None, "FCBS", "FACULDADE DE CIENCIAS BIOLOGICAS E DA SAUDE",
         "Faculdade de Ciências Biológicas e da Saúde", "FACULDADE", "DIA", True, None),
        (None, "FCA", "FACULDADE DE CIENCIAS AGRARIAS",
         "Faculdade de Ciências Agrárias", "FACULDADE", "DIA", True, None),
        ("234", "DZO", "DEPARTAMENTO DE ZOOTECNIA",
         "Departamento de Zootecnia", "DEPARTAMENTO", "DIA", False, "FCA"),
        ("243", "DODO", "DEPARTAMENTO DE ODONTOLOGIA",
         "Departamento de Odontologia", "DEPARTAMENTO", "DIA", False, "FCBS"),
        (None, "PROGEP", "PRO-REITORIA DE GESTAO DE PESSOAS",
         "Pró-Reitoria de Gestão de Pessoas", "PRO_REITORIA", "DIA", False, None),
        (None, "Sisa", "SUPERINTENDENCIA INTEGRADA DE SAUDE",
         "Superintendência Integrada de Saúde", "SUPERINTENDENCIA", "DIA", False, None),
        (None, "CSSO", "COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL",
         "Coordenadoria de Segurança e Saúde Ocupacional", "COORDENADORIA", "DIA", False, "Sisa"),
        (None, "SecSisa", "SECRETARIA DA SISA", "Secretaria da Sisa",
         "SECRETARIA", "DIA", False, "Sisa"),
        (None, "CSQV", "COORDENADORIA DE SAUDE E QUALIDADE DE VIDA",
         "Coordenadoria de Saúde e Qualidade de Vida", "COORDENADORIA", "DIA", False, "Sisa"),
        (None, "CPOS", "COORDENADORIA DE PERICIA OFICIAL EM SAUDE",
         "Coordenadoria de Perícia Oficial em Saúde", "COORDENADORIA", "DIA", False, "Sisa"),
        (None, "CPEL", "COORDENADORIA DE PROMOCAO E EDUCACAO EM SAUDE",
         "Coordenadoria de Promoção e Educação em Saúde", "COORDENADORIA", "DIA", False, "Sisa"),
    ]
    objetos_uorg: dict[str, UnidadeUorg] = {}
    for codigo, sigla, oficial, extenso, tipo, campus, emite, _pai in unidades:
        chave = {"codigo_uorg": codigo} if codigo else {"nome_oficial": oficial}
        objetos_uorg[sigla] = _obter_ou_criar(
            s,
            UnidadeUorg,
            chave,
            {
                k: v
                for k, v in {
                    "sigla": sigla,
                    "nome_oficial": oficial,
                    "nome_extenso": extenso,
                    "tipo": tipo,
                    "campus_id": objetos_campus[campus].id,
                    "emite_portaria": emite,
                }.items()
                if k not in chave
            },
        )
    s.flush()
    for codigo, sigla, _o, _e, _t, _c, _em, pai in unidades:
        if pai:
            objetos_uorg[sigla].unidade_pai_id = objetos_uorg[pai].id
    s.flush()

    # postos - caixa exatamente como no documento de origem
    postos = [
        ("DODO", "Central de Esterilização de Materiais (CME)", "CME"),
        ("FAMMUC", "Laboratório de Agentes Patológicos (LAP)", "LAP"),
        ("IECT", "Laboratório de Química", None),
        ("ICA", "Laboratório de Química", None),
        ("DZO", "Laboratório de Aquicultura, Ecologia Aquática e Limnologia", None),
        ("FAMED", "Laboratório Escola de análises Clínicas (LEAC)", "LEAC"),
        ("FAMED", "Laboratório de Doenças Infecciosas e Parasitárias", None),
    ]
    for sigla, nome, sigla_posto in postos:
        _obter_ou_criar(
            s,
            PostoTrabalho,
            {"unidade_uorg_id": objetos_uorg[sigla].id, "nome": nome},
            {"sigla": sigla_posto},
        )

    for nome in ("TECNICO DE LABORATORIO AREA", "Técnica de Laboratório / Zootecnia"):
        _obter_ou_criar(s, Cargo, {"nome": nome})
    s.flush()
    return {"campus": objetos_campus, "uorg": objetos_uorg}


def semear_dominios(s: Session) -> dict:
    riscos = {
        "BIOLOGICO": "Agente Biológico",
        "QUIMICO": "Agente Químico",
        "FISICO": "Agente Físico",
        "ASSOCIACAO": "Associação de Agentes",
    }
    objetos_risco = {
        c: _obter_ou_criar(s, TipoRisco, {"codigo": c}, {"nome": n})
        for c, n in riscos.items()
    }

    base_nao_acumula = "IN 15/2022, art. 4º — não acumulam entre si; caráter transitório."
    adicionais = [
        ("INSALUBRIDADE", "Adicional de Insalubridade", "adicional de insalubridade",
         f"Lei 8.270/91, art. 12, I e §3º. {base_nao_acumula}", True),
        ("PERICULOSIDADE", "Adicional de Periculosidade", "adicional de periculosidade",
         f"Lei 8.270/91, art. 12, II. {base_nao_acumula}", False),
        ("IRRADIACAO_IONIZANTE", "Adicional de Irradiação Ionizante",
         "adicional de irradiação ionizante",
         f"Lei 8.270/91, art. 12, §1º. {base_nao_acumula}", False),
        ("RAIOS_X", "Gratificação por Trabalhos com Raios X",
         "gratificação por trabalhos com raios X",
         f"Lei 8.270/91, art. 12, §2º. {base_nao_acumula}", False),
    ]
    objetos_adicional = {
        c: _obter_ou_criar(
            s, TipoAdicional, {"codigo": c},
            {"nome": n, "nome_recomendacao": nr, "base_legal": bl, "ativo": ativo},
        )
        for c, n, nr, bl, ativo in adicionais
    }
    s.flush()

    percentuais = [
        ("INSALUBRIDADE", "MINIMO", "Mínimo (5%)", "5.00"),
        ("INSALUBRIDADE", "MEDIO", "Médio (10%)", "10.00"),
        ("INSALUBRIDADE", "MAXIMO", "Máximo (20%)", "20.00"),
        ("IRRADIACAO_IONIZANTE", "MINIMO", "Mínimo (5%)", "5.00"),
        ("IRRADIACAO_IONIZANTE", "MEDIO", "Médio (10%)", "10.00"),
        ("IRRADIACAO_IONIZANTE", "MAXIMO", "Máximo (20%)", "20.00"),
        ("PERICULOSIDADE", "UNICO", "10%", "10.00"),
        ("RAIOS_X", "UNICO", "10%", "10.00"),
    ]
    for cod_adicional, grau, rotulo, valor in percentuais:
        _obter_ou_criar(
            s,
            PercentualAplicavel,
            {"tipo_adicional_id": objetos_adicional[cod_adicional].id, "grau": grau},
            {
                "rotulo": rotulo,
                "valor": Decimal(valor),
                "base_calculo": "vencimento do cargo efetivo",
            },
        )

    movimentos = [
        ("CONCESSAO", "concessão", True),
        ("REVISAO", "revisão", True),
        ("REDUCAO", "redução", True),
        ("CANCELAMENTO", "cancelamento", False),
        ("REAVALIACAO", "reavaliação", True),
    ]
    for codigo, nome, gera in movimentos:
        _obter_ou_criar(s, TipoMovimento, {"codigo": codigo}, {"nome": nome, "gera_direito": gera})

    fundamentos = {
        "NR15_AX14_INFECTO": _obter_ou_criar(
            s, FundamentacaoLegal, {"codigo": "NR15_AX14_INFECTO"},
            {"norma": "NR-15", "anexo": "Anexo 14",
             "tipo_risco_id": objetos_risco["BIOLOGICO"].id, "texto": TEXTO_NR15_AX14},
        ),
        "NR15_AX13_ACIDOS_ALCALIS": _obter_ou_criar(
            s, FundamentacaoLegal, {"codigo": "NR15_AX13_ACIDOS_ALCALIS"},
            {"norma": "NR-15", "anexo": "Anexo 13",
             "tipo_risco_id": objetos_risco["QUIMICO"].id, "texto": TEXTO_NR15_AX13},
        ),
    }
    s.flush()

    medio_insalubridade = s.execute(
        select(PercentualAplicavel).filter_by(
            tipo_adicional_id=objetos_adicional["INSALUBRIDADE"].id, grau="MEDIO"
        )
    ).scalar_one()

    canonico_bio = _obter_ou_criar(
        s, AgenteNocivo,
        {"descricao": "Contato permanente com material infecto-contagiante"},
        {"tipo_risco_id": objetos_risco["BIOLOGICO"].id,
         "fundamentacao_id": fundamentos["NR15_AX14_INFECTO"].id,
         "percentual_sugerido_id": medio_insalubridade.id,
         "exige_reavaliacao_quantitativa": False},
    )
    canonico_quim = _obter_ou_criar(
        s, AgenteNocivo, {"descricao": "Manipulação de produtos químicos"},
        {"tipo_risco_id": objetos_risco["QUIMICO"].id,
         "fundamentacao_id": fundamentos["NR15_AX13_ACIDOS_ALCALIS"].id,
         "percentual_sugerido_id": medio_insalubridade.id,
         "exige_reavaliacao_quantitativa": True},
    )
    s.flush()
    # sinonimo -> canonico (de-para que ALTERA SEMANTICA: exige aprovacao do Fabricio)
    _obter_ou_criar(
        s, AgenteNocivo, {"descricao": "Manuseio de substâncias químicas"},
        {"tipo_risco_id": objetos_risco["QUIMICO"].id,
         "fundamentacao_id": fundamentos["NR15_AX13_ACIDOS_ALCALIS"].id,
         "percentual_sugerido_id": medio_insalubridade.id,
         "exige_reavaliacao_quantitativa": True,
         "agente_canonico_id": canonico_quim.id},
    )
    _ = canonico_bio

    marcos = [
        ("PORTARIA_LOCALIZACAO", "data da Portaria de Localização",
         "IN 15/2022, art. 13 e parágrafo único"),
        ("PORTARIA_CONCESSAO", "data da Portaria de Concessão", "IN 15/2022, art. 13"),
        ("SOLICITACAO_SEST", "data da solicitação", None),
        ("INICIO_EXERCICIO", "data de início do exercício no posto", None),
    ]
    for codigo, rotulo, base in marcos:
        _obter_ou_criar(s, TipoMarcoInicial, {"codigo": codigo},
                        {"rotulo": rotulo, "base_legal": base})

    tipos_processo = [
        ("ADICIONAL_OCUPACIONAL", "Adicional Ocupacional", "#F2D600"),
        ("APOSENTADORIA_ESPECIAL", "Aposentadoria Especial", "#0079BF"),
        ("PARECER_TECNICO", "Parecer Técnico", "#EB5A46"),
        ("PGR", "PGR", "#61BD4F"),
        ("RITS", "RITS", "#C377E0"),
        ("ACIDENTE", "Acidente em Serviço", "#FF9F1A"),
        ("PGD", "PGD", "#00C2E0"),
        ("REVEZAMENTO", "Revezamento", "#51E898"),
        ("CONSULTA_NORMATIVA", "Consulta Normativa", "#B3BAC5"),
    ]
    for codigo, nome, cor in tipos_processo:
        _obter_ou_criar(s, TipoProcesso, {"codigo": codigo}, {"nome": nome, "cor_hex": cor})

    etapas = [
        (1, "NAO_INICIADO", "Não Iniciado", "FLUXO", False),
        (2, "A_FAZER", "A fazer", "FLUXO", False),
        (3, "EM_ANDAMENTO", "Em andamento", "FLUXO", False),
        (4, "AGUARDANDO", "Aguardando", "FLUXO", False),
        (5, "CONCLUIDO", "Concluído", "FLUXO", True),
        (6, "BACKLOG_ADICIONAL", "Repositório Adicional Ocupacional", "REPOSITORIO", False),
        (7, "BACKLOG_CAMPI_AVANCADOS", "Repositório Campi Avançados", "REPOSITORIO", False),
        (8, "ARQUIVO_APOSENTADORIA", "Arquivo Aposentadoria Especial", "REPOSITORIO", True),
    ]
    for ordem, codigo, nome, tipo, terminal in etapas:
        _obter_ou_criar(s, FluxoEtapa, {"codigo": codigo},
                        {"nome": nome, "ordem": ordem, "tipo": tipo, "terminal": terminal})
    s.flush()
    return {"risco": objetos_risco, "adicional": objetos_adicional, "fundamentacao": fundamentos}


def semear_textos(s: Session) -> None:
    textos = [
        ("ALTERACAO", "COMUNICAR_SEST", True,
         "Qualquer alteração na execução das atividades técnicas do servidor, bem como "
         "mudanças em sua carga horária, deverá ser comunicada ao "
         "{{sigla_unidade_emissora}}."),
        ("REAVALIACAO", "QUIMICO_QUANTITATIVA", True,
         "Os agentes químicos devem ser avaliados quantitativamente para fins de "
         "prevenção e controle do risco. Após a realização da avaliação quantitativa "
         "dos agentes químicos um novo laudo deverá ser elaborado."),
        ("RECOMENDACAO", "RECONHECER_DIREITO_PORTARIA_V1", True,
         "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela "
         "exposição ao {{tipo_risco}}, a partir da data da Portaria de Localização: "
         "{{data_marco_extenso_capitalizado}}"),
        ("RECOMENDACAO", "RECONHECER_DIREITO_PORTARIA_V2", True,
         "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela "
         "exposição ao {{tipo_risco}}, a partir da portaria de localização "
         "{{data_marco_extenso}}"),
        ("RECOMENDACAO", "RECONHECER_DIREITO_SOLICITACAO", True,
         "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela "
         "exposição ao {{tipo_risco}}, a partir da data da solicitação "
         "{{data_marco_numerica}}"),
        # ATENCAO: o rodape cita o art. 17 para o "Formulario", mas o art. 17 da IN
        # 15/2022 trata da responsabilizacao de peritos e dirigentes. Nao corrigir
        # sozinho - texto guardado literal e sinalizado em PENDENCIAS.md.
        ("RODAPE_RESPONSABILIDADE", "FORMULARIO_ART17", True,
         "*É de responsabilidade do servidor e suas chefias (conforme Art. 17 da IN "
         "15/2022) as informações documentadas no “Formulário” que registra o tipo de "
         "trabalho e o tempo de exposição ao risco."),
        # Somente leitura: paragrafos estaticos do .docx, nunca alimentam o render.
        ("PREAMBULO", "ENCAMINHAMENTO", False,
         "Encaminhamos, para ciência e devidas providências, o parecer técnico "
         "referente à solicitação de {{laudo_de}} do adicional ocupacional."),
        ("ASSUNTO", "PADRAO", False, "Processo de adicional ocupacional"),
        ("ENCERRAMENTO", "TENDO_EM_VISTA", False,
         "Tendo em vista os documentos constantes no presente processo, emitimos o "
         "seguinte parecer:"),
    ]
    for categoria, codigo, renderizado, template in textos:
        _obter_ou_criar(
            s, TextoPadrao, {"categoria": categoria, "codigo": codigo, "versao": 1},
            {"template": template, "renderizado_pelo_modelo": renderizado},
        )
    s.flush()


def semear_emissores(s: Session) -> None:
    _obter_ou_criar(
        s, AutoridadeDestinataria, {"nome": "MARINA FERREIRA DA COSTA"},
        {"cargo": "Pró-reitora de Gestão de Pessoas",
         "tratamento": "A sua senhoria, a senhora:",
         "vigencia_inicio": date(2025, 1, 1)},
    )
    # Tres vigencias, extraidas dos pareceres assinados (ver PENDENCIAS.md):
    #  * ate 2025: cabecalho "Serviço Especializado em Segurança do Trabalho"
    #    (parecer 1/2025);
    #  * em 2026, mesma sigla, cabecalho "Seção de Segurança do Trabalho"
    #    (pareceres 1/2026, 2/2026 e 8/2026);
    #  * a partir de 19/06/2026, CSSO/Sisa (Resolução Consu 11/2026).
    # A data de corte SEST -> CSSO e default assumido: o 8/2026, de 18/06/2026,
    # ainda saiu com a sigla antiga.
    comum = {
        "unidade_sei": "csso.sisa",
        "email": "csso.sisa@ufvjm.edu.br",
        "endereco": ENDERECO_UFVJM,
        "telefone": TELEFONE_UFVJM,
        "cidade": "Diamantina",
    }
    _obter_ou_criar(
        s, SetorEmissor,
        {"sigla_composta": "SEST/DASA/PROGEP", "vigencia_inicio": date(2019, 1, 1)},
        {**comum,
         "nome_extenso": "Serviço Especializado em Segurança do Trabalho",
         "vigencia_fim": date(2025, 12, 31)},
    )
    _obter_ou_criar(
        s, SetorEmissor,
        {"sigla_composta": "SEST/DASA/PROGEP", "vigencia_inicio": date(2026, 1, 1)},
        {**comum,
         "nome_extenso": "Seção de Segurança do Trabalho",
         "vigencia_fim": date(2026, 6, 18)},
    )
    _obter_ou_criar(
        s, SetorEmissor,
        {"sigla_composta": "CSSO/Sisa", "vigencia_inicio": date(2026, 6, 19)},
        {**comum,
         "nome_extenso": "Coordenadoria de Segurança e Saúde Ocupacional",
         "base_normativa": "Resolução Consu UFVJM nº 11/2026"},
    )
    # IN 15/2022, art. 10, SS2, I. Fatima (tecnica de seguranca do trabalho) NAO
    # entra nesta tabela: a habilitacao exigida e medico do trabalho, engenheiro
    # ou arquiteto de seguranca do trabalho. Isso nao e opiniao - e a lei.
    _obter_ou_criar(
        s, ProfissionalHabilitado, {"nome": "Fabrício Raimundi Andrade"},
        {"siape": "2165804", "habilitacao": "ENG_SEG_TRABALHO",
         "titulo_assinatura": "Eng. Seg. do Trabalho",
         "vigencia_inicio": date(2019, 1, 1)},
    )
    s.flush()


def semear_epi(s: Session) -> None:
    """Catalogos semeados do modulo de EPI: a taxonomia da NR-6 e as recusas.

    A categoria e semeada, e nao digitada, porque no legado ela era texto livre —
    e o resultado aparecia na tela em quatro grafias ("proteção do tronco", "da
    cabeça", "dos membros superiores") de uma lista que a norma fecha em nove.

    O motivo de recusa e semeado pela razao oposta: no legado a recusa nao
    existia como dado, era texto digitado a cada vez. Texto livre sai diferente
    todas as vezes, nao cita norma e nao se conta — e e justamente a contagem por
    motivo que permite ao setor mostrar o padrao dos pedidos que precisa recusar.
    """
    # (codigo, nome, letra do Anexo I da NR-6)
    categorias = [
        ("PROT_CABECA", "Proteção da cabeça", "A"),
        ("PROT_OLHOS_FACE", "Proteção dos olhos e face", "B"),
        ("PROT_AUDITIVA", "Proteção auditiva", "C"),
        ("PROT_RESPIRATORIA", "Proteção respiratória", "D"),
        ("PROT_TRONCO", "Proteção do tronco", "E"),
        ("PROT_MEMBROS_SUPERIORES", "Proteção dos membros superiores", "F"),
        ("PROT_MEMBROS_INFERIORES", "Proteção dos membros inferiores", "G"),
        ("PROT_CORPO_INTEIRO", "Proteção do corpo inteiro", "H"),
        (
            "PROT_QUEDAS_DESNIVEL",
            "Proteção contra quedas com diferença de nível",
            "I",
        ),
    ]
    for ordem, (codigo, nome, letra) in enumerate(categorias, start=1):
        _obter_ou_criar(
            s,
            EpiCategoria,
            {"codigo": codigo},
            {"nome": nome, "referencia_nr6": letra, "ordem": ordem},
        )

    # (codigo, rotulo, base normativa, exige complemento, texto)
    motivos = [
        (
            "VINCULO_NAO_ATENDIDO",
            "Vínculo não atendido",
            "NR-6",
            False,
            TEXTO_RECUSA_VINCULO,
        ),
        (
            "SEM_EXPOSICAO",
            "Sem exposição ao risco",
            None,
            False,
            "A atividade descrita não expõe ao risco contra o qual o equipamento "
            "protege. O fornecimento pressupõe exposição identificada no posto de "
            "trabalho; havendo alteração na atividade, o pedido pode ser "
            "reapresentado com a descrição atualizada.",
        ),
        (
            "EPI_INADEQUADO",
            "EPI inadequado ao risco",
            "NR-6",
            False,
            "O equipamento solicitado não protege contra o risco declarado. Nos "
            "termos da NR-6, o EPI fornecido deve ser adequado ao risco a que a "
            "pessoa está exposta; o equipamento adequado é indicado na análise.",
        ),
        (
            "SEM_TREINAMENTO",
            "Treinamento não comprovado",
            "NR-6, NR-35",
            False,
            "O uso do equipamento solicitado depende de treinamento cuja "
            "realização não foi comprovada. O fornecimento fica condicionado à "
            "capacitação; comprovado o treinamento, o pedido pode ser "
            "reapresentado.",
        ),
        (
            "DENTRO_DA_VIDA_UTIL",
            "Dentro da vida útil",
            None,
            False,
            "O equipamento já foi entregue e ainda está dentro da vida útil "
            "registrada na ficha de EPI, sem devolução do anterior nem "
            "justificativa de dano, perda ou desgaste prematuro.",
        ),
        (
            "ACIMA_DO_MAXIMO",
            "Acima da quantidade máxima",
            None,
            False,
            "A quantidade solicitada excede o máximo previsto para o item no "
            "período, e a exceção não foi autorizada. A exceção é possível, exige "
            "justificativa e fica registrada em nome de quem a autoriza.",
        ),
        (
            "COMPETENCIA_DE_ENSINO",
            "Competência do curso ou departamento",
            None,
            False,
            "O equipamento destina-se a atividade de ensino. Nesse caso o "
            "fornecimento é do curso ou do departamento responsável pela "
            "atividade.",
        ),
        # o unico que exige complemento: sem ele a negativa nao diz nada
        (
            "OUTRO",
            "Outro motivo",
            None,
            True,
            "Pedido indeferido pelo motivo descrito a seguir.",
        ),
    ]
    for codigo, rotulo, base, complemento, texto in motivos:
        _obter_ou_criar(
            s,
            EpiMotivoRecusa,
            {"codigo": codigo},
            {
                "rotulo": rotulo,
                "texto": texto,
                "base_normativa": base,
                "exige_complemento": complemento,
            },
        )
    s.flush()


def semear(s: Session) -> None:
    semear_rbac(s)
    semear_organizacao(s)
    semear_dominios(s)
    semear_textos(s)
    semear_emissores(s)
    semear_epi(s)
    s.commit()
