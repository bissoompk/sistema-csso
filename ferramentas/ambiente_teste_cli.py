"""Monta um ambiente de teste isolado, com dados de mentira, para clicar a vontade.

Uso:
    python -m ferramentas.ambiente_teste_cli
    python -m ferramentas.ambiente_teste_cli --porta 8766
    python -m ferramentas.ambiente_teste_cli --destino dados-teste

**Por que esta ferramenta existe.** O banco vivo tem um usuario, um servidor e
zero de todo o resto: quem abre o sistema para conhece-lo ve tela em branco e
conclui que nada funciona. Povoar o banco vivo resolveria a tela e destruiria a
outra coisa - a decisao pendente sobre restaurar o backup de 12/08 so e possivel
enquanto der para olhar `dados/csso.db` e saber que tudo ali e real.

Entao o ambiente de teste e OUTRO: banco proprio, pastas proprias, porta propria.
Tres travas, e nao uma, porque o modo de falha aqui e silencioso - um `.env`
herdado por engano escreveria documento de teste dentro de `dados/documentos/` e
ninguem veria ate a hora de exportar.

**Por que passa pelos servicos.** `app/servicos/*` e onde moram a numeracao
sequencial (RN-03), o contexto congelado (RN-15), as maquinas de estado e a
cadeia de auditoria encadeada por SHA-256. Dado inserido por `INSERT` cru sai
coerente com o esquema e incoerente com o que as telas leem: o parecer teria
numero sem consumir sequencia, a ficha de EPI teria snapshot que ninguem
congelou, e a tela de auditoria acusaria a cadeia quebrada. O que se ganha
gerando pelos servicos e que o ambiente de teste exercita as MESMAS regras que o
de producao - inclusive as que recusam.

Onde nao ha servico, esta ferramenta imita a rota que cria a entidade (processo,
laudo, servidor, item de EPI, catalogo de treinamento) - inclusive o
`auditoria.registrar` que a rota emite. Nao ha atalho por fora da cadeia.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

# A pasta descartavel. Fica ao lado de `dados/`, e nunca dentro: `conferir_destino`
# recusa qualquer alvo que se cruze com o banco de producao.
DESTINO_PADRAO = "dados-teste"
PORTA_PADRAO = 8766
HOST_PADRAO = "127.0.0.1"

# Senha unica de todas as contas, e impressa na tela de proposito. Isto e banco
# descartavel com dado inventado: esconder a senha aqui nao protegeria nada e
# custaria ao dono um `senha_cli` por conta so para comecar a clicar.
SENHA = "teste2026"

DOMINIO = "csso.teste"


class DestinoProibido(RuntimeError):
    """O destino escolhido se cruza com `dados/` - o banco que nao se toca."""


# =====================================================================
# Isolamento - as tres travas
# =====================================================================
def variaveis_de_ambiente(
    base: Path, porta: int = PORTA_PADRAO, host: str = HOST_PADRAO
) -> dict[str, str]:
    """Toda variavel `CSSO_*` que aponta para disco, apontada para dentro de `base`.

    A lista espelha `Config.diretorios_de_dados` de proposito: campo de diretorio
    novo entra la e tem de entrar aqui, senao ele cai no padrao - que e dentro de
    `dados/` - e o ambiente de teste passa a escrever na pasta do setor sem
    nenhum erro no caminho. E o mesmo raciocinio do `conftest.py` da raiz, e o
    teste que confere e o mesmo tipo de teste.
    """
    return {
        "CSSO_BANCO_URL": f"sqlite+pysqlite:///{(base / 'csso.db').as_posix()}",
        "CSSO_DIR_DOCUMENTOS": (base / "documentos").as_posix(),
        "CSSO_DIR_ANEXOS": (base / "anexos").as_posix(),
        "CSSO_DIR_ENTRADA": (base / "entrada").as_posix(),
        "CSSO_PERFIL_LO": (base / "perfil_lo").as_posix(),
        "CSSO_BACKUP_DESTINO": (base / "backups").as_posix(),
        "CSSO_DIR_LOGS": (base / "logs").as_posix(),
        "CSSO_PORTA": str(porta),
        "CSSO_HOST": host,
        "CSSO_AMBIENTE": "teste",
        # Sem a palavra "troque": o aviso de `Config.inseguro` existe para o
        # coordenador ver na tela de producao, e reproduzi-lo aqui treinaria
        # justamente o habito de ignora-lo.
        "CSSO_CHAVE_SECRETA": "ambiente-de-teste-descartavel-0123456789abcdef",
        "CSSO_BACKUP_SENHA": "backup-do-ambiente-de-teste",
        "CSSO_ABRIR_NAVEGADOR": "true",
    }


def conferir_destino(base: Path) -> None:
    """Recusa qualquer destino que se cruze com `dados/` ou com a raiz.

    A conferencia e nos dois sentidos porque as duas formas de errar existem:
    apontar o ambiente de teste PARA dentro de `dados/` (e povoar o banco vivo),
    e apontar para uma pasta que CONTEM `dados/` (e apagar tudo no `rmtree` da
    re-execucao). A segunda e a pior das duas, e e a que um `--destino .`
    distraido produz.
    """
    alvo = base.resolve()
    producao = (RAIZ / "dados").resolve()
    if alvo == RAIZ.resolve():
        raise DestinoProibido(
            f"'{base}' e a raiz do repositorio. Escolha uma pasta propria "
            f"(o padrao e {DESTINO_PADRAO})."
        )
    if alvo == producao or producao in alvo.parents or alvo in producao.parents:
        raise DestinoProibido(
            f"'{base}' se cruza com {producao}, que guarda o banco de producao. "
            "O ambiente de teste tem pasta propria, fora de dados/."
        )


def host_anterior(base: Path) -> str | None:
    """O `CSSO_HOST` do `.env` que existe hoje nesta pasta, se houver.

    Existe por um defeito real: quem abriu o ambiente de teste para a rede do
    setor (`CSSO_HOST=0.0.0.0`, com regra de firewall e um endereco divulgado
    aos colegas) e depois rodou o `RECRIAR-TESTE.bat` para limpar os dados
    perdia o acesso de todo mundo — e nada na tela dizia por que. A pasta e
    descartavel; a DECISAO de atender a rede nao e, e ela nao mora nos dados.

    Le o arquivo cru, e nao `Config`: aqui ainda nao se pode importar `app.*`
    (ver `preparar`), e o que se quer e uma linha de texto, nao a configuracao
    resolvida — que neste ponto ainda seria a de producao.
    """
    env = base / ".env"
    if not env.is_file():
        return None
    for linha in env.read_text(encoding="utf-8").splitlines():
        if linha.startswith("CSSO_HOST="):
            return linha.split("=", 1)[1].strip() or None
    return None


def preparar(base: Path, porta: int, host: str | None = None) -> Path:
    """Derruba o ambiente anterior, recria a pasta e exporta a configuracao.

    Cinto e suspensorio, como no `conftest.py` da raiz: o `.env` descartavel E as
    variaveis exportadas direto no ambiente. No pydantic-settings a variavel de
    ambiente vence o arquivo, sempre - entao se um dia alguem quebrar a
    resolucao do `env_file`, a segunda trava segura o isolamento sozinha.

    Roda ANTES de qualquer `import app.*`: `obter_config` e memoizada e nasce no
    primeiro import que a tocar. Exportar depois seria exportar tarde.
    """
    conferir_destino(base)
    # LIDO ANTES do `rmtree`: a pasta inteira vai embora daqui a duas linhas.
    host = host or host_anterior(base) or HOST_PADRAO
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)

    valores = variaveis_de_ambiente(base, porta, host)
    env = base / ".env"
    env.write_text(
        "# Gerado por ferramentas/ambiente_teste_cli.py. Descartavel.\n"
        + "\n".join(f"{chave}={valor}" for chave, valor in valores.items())
        + "\n",
        encoding="utf-8",
    )
    os.environ["CSSO_ENV_FILE"] = str(env)
    os.environ.update(valores)
    return env


# =====================================================================
# Povoamento
# =====================================================================
# As contas: uma por perfil, para o dono trocar de login e ver a mesma tela
# mudar. O `servidor_consulta` fica ligado a um servidor porque sem isso o
# caminho do titular da LGPD (art. 18, II) nao existe - `ESCOPO_PROPRIO` filtra
# por `servidor_id`, e sem ele a pessoa entra e nao ve nada.
CONTAS: tuple[tuple[str, str, str], ...] = (
    ("coordenador", "coordenador_csso", "Nádia Quintanilha Serra"),
    ("engenheiro", "engenheiro_seguranca", "Otávio Bengala Freire"),
    ("tecnico", "tecnico_seguranca", "Perpétua Andrade Lousã"),
    ("medico", "medico_trabalho", "Quirino Baptista Mesquita"),
    ("secretaria", "secretaria_csso", "Rosalina Teixeira Bopp"),
    ("almoxarife", "almoxarife_sesmt", "Salustiano Vidigal Prado"),
    ("admin", "admin_ti", "Tarcísio Werneck Aguiar"),
    ("servidor", "servidor_consulta", "Adelaide Nunes Prata"),
)

# (siape, nome, cargo, sigla da unidade, nome do posto ou None)
# Nomes, matriculas e lotacoes sao inventados. Nenhum CPF, nenhuma condicao de
# saude, nenhum dado que a RN-21 recusaria - e o filtro recusaria de todo modo.
SERVIDORES: tuple[tuple[str, str, str, str, str | None], ...] = (
    ("3010011", "Adelaide Nunes Prata", "TECNICO DE LABORATORIO AREA", "FAMED",
     "Laboratório Escola de análises Clínicas (LEAC)"),
    ("3010022", "Bruno Sacramento Vilela", "TECNICO DE LABORATORIO AREA", "IECT",
     "Laboratório de Química"),
    ("3010033", "Cíntia Rebouças Amorim", "TECNICO EM ENFERMAGEM", "DODO",
     "Central de Esterilização de Materiais (CME)"),
    ("3010044", "Dagoberto Salles Fontoura", "TECNICO DE LABORATORIO AREA", "FAMMUC",
     "Laboratório de Agentes Patológicos (LAP)"),
    ("3010055", "Elisandra Toffoli Braga", "TECNICO DE LABORATORIO AREA", "ICA",
     "Laboratório de Química"),
    ("3010066", "Feliciano Duarte Amâncio", "Técnica de Laboratório / Zootecnia", "DZO",
     "Laboratório de Aquicultura, Ecologia Aquática e Limnologia"),
    ("3010077", "Gorete Vasconcelos Pimenta", "TECNICO DE LABORATORIO AREA", "FAMED",
     "Laboratório de Doenças Infecciosas e Parasitárias"),
    ("3010088", "Hamilton Peçanha Cordeiro", "ENGENHEIRO/AREA", "CSSO", None),
    ("3010099", "Iolanda Sampaio Rezende", "ASSISTENTE EM ADMINISTRACAO", "PROGEP", None),
    ("3010101", "Juvenal Ataíde Brandão", "AUXILIAR EM ADMINISTRACAO", "FCBS", None),
    ("3010112", "Kátia Lousada Ferrão", "ASSISTENTE EM ADMINISTRACAO", "FCA", None),
    ("3010123", "Lourival Bittencourt Sá", "TECNICO DE LABORATORIO AREA", "TESJAN",
     "Laboratório de Solos (teste)"),
)

CARGOS_EXTRA = (
    "ENGENHEIRO/AREA",
    "MEDICO/AREA",
    "TECNICO EM ENFERMAGEM",
    "ASSISTENTE EM ADMINISTRACAO",
    "AUXILIAR EM ADMINISTRACAO",
)

# Um PDF minusculo, valido o bastante para o navegador abrir. Serve de portaria,
# de formulario e de comprovante: o que se testa nas telas e o anexo existir,
# ter categoria e ter SHA-256 - nao o conteudo.
PDF_FALSO = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)


def povoar(base: Path) -> dict:
    """Cria o banco, migra ate o head, semeia e povoa. Devolve o resumo impresso."""
    from datetime import date, timedelta
    from decimal import Decimal

    from sqlalchemy import select

    from app import banco as mod_banco
    from app.modelos import (
        AgenteNocivo,
        AssinaturaInstrutor,
        Atribuicao,
        AutoridadeDestinataria,
        Campus,
        Cargo,
        CertificadoModelo,
        CertificadoModeloTag,
        EpiCategoria,
        EpiEntradaEstoque,
        EpiItem,
        EpiMotivoRecusa,
        Exposicao,
        FluxoEtapa,
        Inscricao,
        LaudoTecnico,
        ParecerPosto,
        ParecerTecnico,
        Pendencia,
        PercentualAplicavel,
        Perfil,
        PortariaLocalizacao,
        PostoTrabalho,
        Processo,
        ProfissionalHabilitado,
        Servidor,
        TextoPadrao,
        TipoAdicional,
        TipoMarcoInicial,
        TipoMovimento,
        TipoProcesso,
        Treinamento,
        Turma,
        UnidadeUorg,
        Usuario,
        agora_utc,
    )
    from app.servicos import anexos as servico_anexos
    from app.servicos import auditoria, autenticacao, demandas as servico_demandas
    from app.servicos import direito
    from app.servicos import documento
    from app.servicos import emissao_certificado, epi_estoque, epi_ficha, epi_requisicao
    from app.servicos import nup as servico_nup
    from app.servicos import parecer as servico_parecer
    from app.servicos import participante as servico_participante
    from app.servicos import pendencias, presenca, processo as servico_processo
    from app.servicos import rbac, sementes
    from app.servicos import servidores as servico_servidores
    from app.servicos import turma as servico_turma
    from ferramentas.gerar_modelo_certificado import MAPA_SUGERIDO, OBRIGATORIOS

    hoje = date.today()
    ano = hoje.year

    mod_banco.migrar()

    resumo: dict[str, int] = {}

    with mod_banco.sessao() as s:
        sementes.semear(s)

    # -----------------------------------------------------------------
    # Contas, uma por perfil
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        for login, codigo_perfil, nome in CONTAS:
            usuario = Usuario(
                login=login,
                nome=nome,
                email=f"{login}@{DOMINIO}",
                senha_hash=autenticacao.gerar_hash(SENHA),
                precisa_trocar_senha=False,
            )
            s.add(usuario)
            s.flush()
            perfil = s.execute(
                select(Perfil).where(Perfil.codigo == codigo_perfil)
            ).scalar_one()
            s.add(
                Atribuicao(
                    usuario_id=usuario.id,
                    perfil_id=perfil.id,
                    vigencia_inicio=date(2020, 1, 1),
                    ato_normativo="Ato de teste — ambiente descartável",
                )
            )
        s.commit()

    def atual(s, login: str):
        conta = s.execute(select(Usuario).where(Usuario.login == login)).scalar_one()
        return rbac.carregar_usuario_atual(s, conta.id)

    # -----------------------------------------------------------------
    # Organizacao: o campus de Janauba nao tem unidade nos seeds, e sem uma
    # unidade la nao ha como espalhar servidor pelos quatro campi. A que nasce
    # aqui e declaradamente de teste no proprio nome - quem abrir a tela ve que
    # ela e de mentira sem precisar perguntar.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        for nome in CARGOS_EXTRA:
            if s.execute(select(Cargo).where(Cargo.nome == nome)).scalar_one_or_none() is None:
                s.add(Cargo(nome=nome))
        janauba = s.execute(select(Campus).where(Campus.sigla == "JAN")).scalar_one()
        unidade_jan = UnidadeUorg(
            sigla="TESJAN",
            nome_oficial="UNIDADE DE TESTE DE JANAUBA",
            nome_extenso="Unidade de Teste de Janaúba",
            tipo="INSTITUTO",
            campus_id=janauba.id,
            emite_portaria=True,
        )
        s.add(unidade_jan)
        s.flush()
        s.add(
            PostoTrabalho(
                unidade_uorg_id=unidade_jan.id,
                nome="Laboratório de Solos (teste)",
                sigla="LSOL",
            )
        )
        s.commit()

    # -----------------------------------------------------------------
    # Servidores. Nao ha servico de criacao: a rota POST /servidores monta o
    # `Servidor`, audita SERVIDOR_CRIADO e chama `registrar_lotacao_inicial`.
    # E o que se repete aqui, na mesma ordem - o historico de lotacao e o que
    # o parecer, a ficha de EPI e a requisicao leem para congelar contexto.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        usuario = atual(s, "secretaria")
        for siape, nome, cargo_nome, sigla_uorg, posto_nome in SERVIDORES:
            cargo = s.execute(select(Cargo).where(Cargo.nome == cargo_nome)).scalar_one()
            unidade = s.execute(
                select(UnidadeUorg).where(UnidadeUorg.sigla == sigla_uorg)
            ).scalar_one()
            servidor = Servidor(
                siape=siape,
                nome=nome,
                cargo_id=cargo.id,
                unidade_uorg_id=unidade.id,
                email=None,
            )
            s.add(servidor)
            s.flush()
            auditoria.registrar(
                s,
                entidade="servidor",
                entidade_id=servidor.id,
                tipo_evento="SERVIDOR_CRIADO",
                descricao=f"Servidor SIAPE {siape} cadastrado.",
                usuario=usuario,
            )
            postos: list[int] = []
            if posto_nome:
                posto = s.execute(
                    select(PostoTrabalho).where(
                        PostoTrabalho.unidade_uorg_id == unidade.id,
                        PostoTrabalho.nome == posto_nome,
                    )
                ).scalar_one()
                postos.append(posto.id)
            servico_servidores.registrar_lotacao_inicial(
                s,
                servidor,
                usuario,
                inicio=hoje - timedelta(days=900),
                documento="Portaria de teste",
                postos=postos,
            )
        resumo["servidores"] = len(SERVIDORES)
        s.commit()

    # a conta `servidor` e a Adelaide: sem o vinculo o escopo proprio nao acha nada
    with mod_banco.sessao() as s:
        conta = s.execute(select(Usuario).where(Usuario.login == "servidor")).scalar_one()
        conta.servidor_id = s.execute(
            select(Servidor).where(Servidor.siape == "3010011")
        ).scalar_one().id
        s.commit()

    # -----------------------------------------------------------------
    # Habilitacao tecnica (IN 15/2022, art. 10, §2º, I). Sem uma habilitada
    # vigente ligada a uma CONTA, nenhum parecer se assina: a RN-01 e conferida
    # no servico, no banco (trigger) e no RBAC, e as tres perguntam o mesmo.
    # A semeada (Fabrício) fica intocada - as duas daqui sao inventadas.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        for login, titulo, habilitacao in (
            ("coordenador", "Eng. Seg. do Trabalho", "ENG_SEG_TRABALHO"),
            ("engenheiro", "Eng. Seg. do Trabalho", "ENG_SEG_TRABALHO"),
            ("medico", "Médico do Trabalho", "MED_TRABALHO"),
        ):
            conta = s.execute(select(Usuario).where(Usuario.login == login)).scalar_one()
            s.add(
                ProfissionalHabilitado(
                    usuario_id=conta.id,
                    nome=conta.nome,
                    habilitacao=habilitacao,
                    titulo_assinatura=titulo,
                    conselho="CREA" if habilitacao == "ENG_SEG_TRABALHO" else "CRM",
                    registro_conselho="MG-000000",
                    vigencia_inicio=date(2020, 1, 1),
                )
            )
        s.commit()

    # -----------------------------------------------------------------
    # Portarias e laudos. Laudo tambem nao tem servico de criacao (a rota POST
    # /laudos monta o modelo); superar um laudo, sim - e e por `marcar_laudo_superado`
    # que a cascata da RN-11 abre as pendencias de reavaliacao.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        usuario = atual(s, "coordenador")
        famed = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "FAMED")).scalar_one()
        iect = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "IECT")).scalar_one()
        insalubridade = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
        ).scalar_one()
        signataria = s.execute(
            select(ProfissionalHabilitado).where(
                ProfissionalHabilitado.nome == "Nádia Quintanilha Serra"
            )
        ).scalar_one()

        for sigla, unidade, numero, dia in (
            ("FAMED", famed, "12", hoje - timedelta(days=760)),
            ("IECT", iect, "07", hoje - timedelta(days=540)),
        ):
            s.add(
                PortariaLocalizacao(
                    unidade_emissora_id=unidade.id,
                    numero=numero,
                    ano=dia.year,
                    data_publicacao=dia,
                    texto_original=(
                        f"PORTARIA/{sigla} Nº {numero}, DE {dia.day} "
                        f"DE {dia.month:02d} DE {dia.year} (dado de teste)"
                    ),
                )
            )

        laudos = {
            "L1": LaudoTecnico(
                numero_siape=f"26255-000.301/{hoje.year - 2}",
                ano=hoje.year - 2,
                tipo_adicional_id=insalubridade.id,
                unidade_uorg_id=famed.id,
                data_emissao=hoje - timedelta(days=800),
                subscritor_id=signataria.id,
                status="VIGENTE",
            ),
            "L2": LaudoTecnico(
                numero_siape=f"26255-000.302/{hoje.year - 2}",
                ano=hoje.year - 2,
                tipo_adicional_id=insalubridade.id,
                unidade_uorg_id=iect.id,
                data_emissao=hoje - timedelta(days=790),
                subscritor_id=signataria.id,
                status="VIGENTE",
            ),
            "L3": LaudoTecnico(
                numero_siape=f"26255-000.303/{hoje.year}",
                ano=hoje.year,
                tipo_adicional_id=insalubridade.id,
                unidade_uorg_id=iect.id,
                data_emissao=hoje - timedelta(days=60),
                subscritor_id=signataria.id,
                status="VIGENTE",
            ),
        }
        s.add_all(laudos.values())
        s.commit()
        resumo["laudos"] = len(laudos)

    # -----------------------------------------------------------------
    # Processos: um em cada coluna do kanban, tres fora do SLA.
    # -----------------------------------------------------------------
    def nup_de(sequencial: int, ano_nup: int) -> str:
        base15 = f"23086{sequencial:06d}{ano_nup}"
        return f"23086.{sequencial:06d}/{ano_nup}-{servico_nup.nup_dv(base15)}"

    def anexar(s, usuario, processo, categoria: str, nome: str) -> None:
        servico_anexos.guardar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            nome_original=nome,
            conteudo=PDF_FALSO + f"%{categoria}:{processo.id}".encode(),
            mime_type="application/pdf",
            categoria=categoria,
            usuario=usuario,
            processo_id=processo.id,
        )

    def criar_processo(
        s, usuario, *, sequencial, codigo_tipo, servidor, unidade, observacoes,
        estado_inicial="RECEBIDO", repositorio=False, dias_atras=30,
    ) -> Processo:
        """Imita `POST /processos` — nao ha servico de criacao de processo."""
        tipo = s.execute(
            select(TipoProcesso).where(TipoProcesso.codigo == codigo_tipo)
        ).scalar_one()
        coluna = "NAO_INICIADO" if estado_inicial == "NAO_INICIADO" else "A_FAZER"
        etapa = s.execute(select(FluxoEtapa).where(FluxoEtapa.codigo == coluna)).scalar_one()
        processo = Processo(
            nup=nup_de(sequencial, ano),
            tipo_processo_id=tipo.id,
            etapa_id=etapa.id,
            estado_tecnico=estado_inicial,
            servidor_id=servidor.id if servidor is not None else None,
            unidade_uorg_id=unidade.id if unidade is not None else None,
            data_autuacao=hoje - timedelta(days=dias_atras),
            ano_referencia=ano,
            observacoes=observacoes,
            origem_repositorio=repositorio,
            responsavel_id=usuario.id,
        )
        s.add(processo)
        s.flush()
        auditoria.registrar(
            s,
            entidade="processo",
            entidade_id=processo.id,
            processo_id=processo.id,
            tipo_evento="PROCESSO_CRIADO",
            descricao=f"Processo {processo.nup} criado.",
            usuario=usuario,
        )
        return processo

    def envelhecer(processo, dias: int) -> None:
        """Empurra a entrada na etapa para tras, para o SLA estourar.

        E a unica coisa que esta ferramenta escreve direto numa coluna de estado,
        e o motivo e que nao existe outro: `mover` carimba `entrou_na_etapa_em`
        com o agora, e o unico jeito honesto de ter cartao vermelho na tela seria
        esperar quarenta dias. Isto simula a passagem do tempo - nao contorna
        regra nenhuma, e nao mexe em numero, hash nem trilha.
        """
        processo.entrou_na_etapa_em = agora_utc() - timedelta(days=dias)

    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        tecnico = atual(s, "tecnico")
        famed = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "FAMED")).scalar_one()
        iect = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "IECT")).scalar_one()
        dodo = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "DODO")).scalar_one()
        fammuc = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "FAMMUC")).scalar_one()
        ica = s.execute(select(UnidadeUorg).where(UnidadeUorg.sigla == "ICA")).scalar_one()

        def pessoa(siape: str) -> Servidor:
            return s.execute(select(Servidor).where(Servidor.siape == siape)).scalar_one()

        # 1) Nao iniciado, no quadro. Sao DOIS cartoes, e nao um, porque
        # `origem_repositorio` separa as telas: o cartao marcado como repositorio
        # sai do quadro e vai para a aba Backlog (e a regra de
        # `repositorios/processos.py`). Com so um deles, uma das duas telas
        # nasceria vazia — e vazia sem erro nenhum, que e o pior jeito de nascer.
        p1 = criar_processo(
            s, coord, sequencial=100001, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010101"), unidade=None,
            observacoes="Migrado do Trello, ainda sem triagem. Dado de teste.",
            estado_inicial="NAO_INICIADO", repositorio=False, dias_atras=400,
        )
        p11 = criar_processo(
            s, coord, sequencial=100011, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010101"), unidade=None,
            observacoes="Cartão do repositório Adicional Ocupacional. Dado de teste.",
            estado_inicial="NAO_INICIADO", repositorio=True, dias_atras=430,
        )

        # 2) Recem-chegado, dentro do prazo (coluna A fazer)
        p2 = criar_processo(
            s, coord, sequencial=100002, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010112"), unidade=famed,
            observacoes="Solicitação recebida da PROGEP. Dado de teste.",
            dias_atras=3,
        )

        # 3) Parado em triagem ha 41 dias — SLA da coluna A fazer e 15
        p3 = criar_processo(
            s, coord, sequencial=100003, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010099"), unidade=dodo,
            observacoes="Aguardando conferência dos documentos. Dado de teste.",
            dias_atras=60,
        )
        servico_processo.mover(s, p3, "EM_TRIAGEM", coord)
        envelhecer(p3, 41)

        # 4) Pendente de documento ha 35 dias — SLA da coluna Aguardando e 20
        p5 = criar_processo(
            s, coord, sequencial=100005, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010044"), unidade=fammuc,
            observacoes="Aguardando o formulário do art. 17 corrigido. Dado de teste.",
            dias_atras=70,
        )
        anexar(s, coord, p5, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p5, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p5, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p5, "PENDENTE_DOCUMENTO", coord)
        envelhecer(p5, 35)

        # 5) Sobrestado (coluna Aguardando), com o estado anterior guardado
        p6 = criar_processo(
            s, coord, sequencial=100006, codigo_tipo="APOSENTADORIA_ESPECIAL",
            servidor=pessoa("3010123"), unidade=None,
            observacoes="Sobrestado à espera de decisão administrativa. Dado de teste.",
            dias_atras=120,
        )
        anexar(s, coord, p6, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p6, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p6, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p6, "PENDENTE_DOCUMENTO", coord)
        servico_processo.mover(
            s, p6, "SOBRESTADO", coord, comentario="Sobrestado a pedido da unidade."
        )

        # 6) Aguardando quantificacao ha 95 dias — o agente quimico da RN-06
        p7 = criar_processo(
            s, coord, sequencial=100007, codigo_tipo="PARECER_TECNICO",
            servidor=pessoa("3010055"), unidade=ica,
            observacoes="Agente químico: falta o relatório de ensaio. Dado de teste.",
            dias_atras=140,
        )
        anexar(s, coord, p7, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p7, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p7, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p7, "AGUARDANDO_INSPECAO", coord)
        servico_processo.mover(s, p7, "INSPECIONADO", tecnico)
        servico_processo.mover(s, p7, "AGUARDANDO_QUANTIFICACAO", tecnico)
        envelhecer(p7, 95)

        # 7) Indeferido tecnicamente (coluna Concluido), com o inciso do art. 11
        p10 = criar_processo(
            s, coord, sequencial=100010, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010088"), unidade=None,
            observacoes="Atividade-meio, sem exposição ao agente. Dado de teste.",
            dias_atras=90,
        )
        anexar(s, coord, p10, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p10, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p10, "EM_TRIAGEM", coord)
        servico_processo.mover(
            s, p10, "INDEFERIDO_TECNICAMENTE", coord,
            inciso_art11="II",
            comentario="Atividade administrativa, sem exposição habitual.",
        )

        # 8) e 9) os dois que levam parecer: um em elaboracao, um ate o SEI
        p4 = criar_processo(
            s, coord, sequencial=100004, codigo_tipo="PARECER_TECNICO",
            servidor=pessoa("3010022"), unidade=iect,
            observacoes="Parecer em elaboração — laboratório de química. Dado de teste.",
            dias_atras=45,
        )
        anexar(s, coord, p4, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p4, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p4, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p4, "AGUARDANDO_INSPECAO", coord)
        servico_processo.mover(s, p4, "INSPECIONADO", tecnico)
        servico_processo.mover(s, p4, "LAUDO_EM_ELABORACAO", tecnico)
        servico_processo.mover(s, p4, "LAUDO_EMITIDO", tecnico)
        servico_processo.mover(s, p4, "PARECER_EM_ELABORACAO", tecnico)

        p8 = criar_processo(
            s, coord, sequencial=100008, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010011"), unidade=famed,
            observacoes="Parecer emitido e assinado, a incluir no SEI. Dado de teste.",
            dias_atras=150,
        )
        anexar(s, coord, p8, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p8, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p8, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p8, "AGUARDANDO_INSPECAO", coord)
        servico_processo.mover(s, p8, "INSPECIONADO", tecnico)
        servico_processo.mover(s, p8, "LAUDO_EM_ELABORACAO", tecnico)
        servico_processo.mover(s, p8, "LAUDO_EMITIDO", tecnico)
        servico_processo.mover(s, p8, "PARECER_EM_ELABORACAO", tecnico)

        p9 = criar_processo(
            s, coord, sequencial=100009, codigo_tipo="ADICIONAL_OCUPACIONAL",
            servidor=pessoa("3010077"), unidade=famed,
            observacoes="Processo encerrado com direito reconhecido. Dado de teste.",
            dias_atras=300,
        )
        anexar(s, coord, p9, "PORTARIA", "portaria_localizacao.pdf")
        anexar(s, coord, p9, "FORMULARIO", "formulario_art17.pdf")
        servico_processo.mover(s, p9, "EM_TRIAGEM", coord)
        servico_processo.mover(s, p9, "AGUARDANDO_INSPECAO", coord)
        servico_processo.mover(s, p9, "INSPECIONADO", tecnico)
        servico_processo.mover(s, p9, "LAUDO_EM_ELABORACAO", tecnico)
        servico_processo.mover(s, p9, "LAUDO_EMITIDO", tecnico)
        servico_processo.mover(s, p9, "PARECER_EM_ELABORACAO", tecnico)

        resumo["processos"] = 11
        _ = (p1, p2, p11)
        s.commit()

    # -----------------------------------------------------------------
    # Pareceres. O rascunho imita `GET /processos/{id}/parecer` (nao ha servico
    # de criacao); a emissao passa por `parecer.emitir`, que e onde estao o
    # numero da RN-03, o congelado da RN-15 e o documento.
    # -----------------------------------------------------------------
    def montar_rascunho(
        s, usuario, processo, *, laudo, portaria, agente_descricao, texto_reavaliacao=None,
    ) -> ParecerTecnico:
        insalubridade = s.execute(
            select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
        ).scalar_one()
        concessao = s.execute(
            select(TipoMovimento).where(TipoMovimento.codigo == "CONCESSAO")
        ).scalar_one()
        marco = s.execute(
            select(TipoMarcoInicial).where(TipoMarcoInicial.codigo == "PORTARIA_LOCALIZACAO")
        ).scalar_one()
        destinatario = s.execute(select(AutoridadeDestinataria)).scalars().first()
        signataria = s.execute(
            select(ProfissionalHabilitado).where(
                ProfissionalHabilitado.nome == "Nádia Quintanilha Serra"
            )
        ).scalar_one()
        agente = s.execute(
            select(AgenteNocivo).where(AgenteNocivo.descricao == agente_descricao)
        ).scalar_one()
        percentual = s.get(PercentualAplicavel, agente.percentual_sugerido_id)
        lotacao = servico_servidores.lotacao_vigente(s, processo.servidor_id)
        alteracao = s.execute(
            select(TextoPadrao).where(TextoPadrao.codigo == "COMUNICAR_SEST")
        ).scalar_one()

        rascunho = ParecerTecnico(
            numero=0,
            ano=ano,
            situacao="RASCUNHO",
            processo_id=processo.id,
            servidor_id=processo.servidor_id,
            laudo_id=laudo.id,
            tipo_adicional_id=insalubridade.id,
            tipo_movimento_id=concessao.id,
            unidade_uorg_id=(lotacao.unidade_uorg_id if lotacao else processo.unidade_uorg_id),
            portaria_id=portaria.id,
            destinatario_id=destinatario.id,
            signatario_id=signataria.id,
            tipo_marco_id=marco.id,
            data_marco_inicial=portaria.data_publicacao,
            texto_recomendacao=(
                "Reconhecer o direito ao adicional de insalubridade caracterizado "
                f"pela exposição ao {agente.tipo_risco.nome}, a partir da data da "
                "Portaria de Localização."
            ),
            texto_alteracao=alteracao.template.replace(
                "{{sigla_unidade_emissora}}", "CSSO/Sisa"
            ),
            texto_reavaliacao=texto_reavaliacao,
            criado_por=usuario.id,
            modelo_arquivo=documento.MODELO_V1,
        )
        s.add(rascunho)
        s.flush()
        if lotacao and lotacao.postos:
            for ordem, posto in enumerate(lotacao.postos, start=1):
                s.add(
                    ParecerPosto(
                        parecer_id=rascunho.id, posto_trabalho_id=posto.id, ordem=ordem
                    )
                )
        else:  # sem posto o parecer nao valida: pega o primeiro da unidade
            posto = s.execute(
                select(PostoTrabalho).where(
                    PostoTrabalho.unidade_uorg_id == rascunho.unidade_uorg_id
                )
            ).scalars().first()
            if posto is not None:
                s.add(ParecerPosto(parecer_id=rascunho.id, posto_trabalho_id=posto.id, ordem=1))
        s.add(
            Exposicao(
                parecer_id=rascunho.id,
                agente_nocivo_id=agente.id,
                percentual_id=percentual.id,
                fundamentacao_id=agente.fundamentacao_id,
                principal=True,
                horas_exposicao_mensais=Decimal(160),
                jornada_mensal_horas=Decimal(160),
                classificacao_exposicao="PERMANENTE",
                percentual_jornada=Decimal(100),
                tempo_exposicao="Habitual e permanente",
            )
        )
        s.flush()
        return rascunho

    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        reavaliacao = s.execute(
            select(TextoPadrao).where(TextoPadrao.codigo == "QUIMICO_QUANTITATIVA")
        ).scalar_one()

        def portaria_de(sigla: str) -> PortariaLocalizacao:
            unidade = s.execute(
                select(UnidadeUorg).where(UnidadeUorg.sigla == sigla)
            ).scalar_one()
            return s.execute(
                select(PortariaLocalizacao).where(
                    PortariaLocalizacao.unidade_emissora_id == unidade.id
                )
            ).scalars().first()

        def laudo_de(numero_final: str) -> LaudoTecnico:
            return s.execute(
                select(LaudoTecnico).where(
                    LaudoTecnico.numero_siape.like(f"%{numero_final}%")
                )
            ).scalars().first()

        def processo_de(sequencial: int) -> Processo:
            return s.execute(
                select(Processo).where(Processo.nup == nup_de(sequencial, ano))
            ).scalar_one()

        # A ORDEM importa, e nao e estilo: `uq_parecer` e UNIQUE(numero, ano), e
        # todo rascunho nasce com numero 0. Dois rascunhos abertos no mesmo ano
        # colidem — no banco de teste como no de producao. Entao os dois que vao
        # ser emitidos vem primeiro (a emissao consome numero de verdade, pela
        # RN-03) e o rascunho que FICA rascunho e o ultimo.

        # EMITIDO + ASSINADO: agente biologico, sem exigencia quantitativa
        pronto = montar_rascunho(
            s, coord, processo_de(100008),
            laudo=laudo_de("000.301"),
            portaria=portaria_de("FAMED"),
            agente_descricao="Contato permanente com material infecto-contagiante",
        )
        servico_parecer.emitir(s, pronto, coord, gerar_pdf=False)
        servico_parecer.assinar(s, pronto, coord)
        servico_processo.mover(s, processo_de(100008), "PARECER_PRONTO_P_ASSINATURA", coord)
        servico_processo.mover(s, processo_de(100008), "PARECER_ASSINADO", coord)
        servico_processo.mover(s, processo_de(100008), "INSERIDO_NO_SEI", coord)

        encerrado = montar_rascunho(
            s, coord, processo_de(100009),
            laudo=laudo_de("000.301"),
            portaria=portaria_de("FAMED"),
            agente_descricao="Contato permanente com material infecto-contagiante",
        )
        servico_parecer.emitir(s, encerrado, coord, gerar_pdf=False)
        servico_parecer.assinar(s, encerrado, coord)
        for destino in (
            "PARECER_PRONTO_P_ASSINATURA", "PARECER_ASSINADO", "INSERIDO_NO_SEI",
            "DEVOLVIDO_A_PROGEP", "CONCLUIDO",
        ):
            servico_processo.mover(s, processo_de(100009), destino, coord)

        # Direito: proposto pelo parecer emitido e concedido por portaria
        for parecer_emitido, dias in ((pronto, 120), (encerrado, 260)):
            vigencia = direito.propor(s, parecer_emitido, coord)
            direito.conceder(
                s, vigencia, coord,
                portaria_concessao=f"PORTARIA/PROGEP Nº {dias}/{ano} (teste)",
                data_portaria=hoje - timedelta(days=dias),
                data_inicio=hoje - timedelta(days=dias),
            )

        # RASCUNHO: agente quimico, com o texto de reavaliacao da RN-06 ja escrito.
        # E o ultimo, e por isso e o unico que sobra com numero 0 no ano.
        montar_rascunho(
            s, coord, processo_de(100004),
            laudo=laudo_de("000.302"),
            portaria=portaria_de("IECT"),
            agente_descricao="Manipulação de produtos químicos",
            texto_reavaliacao=reavaliacao.template,
        )

        resumo["pareceres"] = 3
        resumo["adicionais_vigentes"] = 2
        s.commit()

    # L2 superado: a cascata da RN-11 poe o parecer derivado em reavaliacao e
    # abre a pendencia. So depois de o rascunho existir - antes nao haveria o que
    # reavaliar, e a pendencia nasceria vazia.
    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        l2 = s.execute(
            select(LaudoTecnico).where(LaudoTecnico.numero_siape.like("%000.302%"))
        ).scalar_one()
        l3 = s.execute(
            select(LaudoTecnico).where(LaudoTecnico.numero_siape.like("%000.303%"))
        ).scalar_one()
        servico_parecer.marcar_laudo_superado(
            s, l2, coord,
            "Nova avaliação quantitativa do laboratório de química.",
            substituto=l3,
        )
        s.commit()

    # -----------------------------------------------------------------
    # Certificados e Treinamentos
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        catalogo = [
            Treinamento(
                codigo="NR-35",
                nome="Trabalho em Altura — NR-35",
                carga_horaria_horas=Decimal(8),
                conteudo_programatico=(
                    "Análise de risco\nSistemas de ancoragem\n"
                    "Equipamentos de proteção contra quedas\nResgate e emergência"
                ),
                validade_meses=24,
                norma_referencia="NR-35",
                obrigatorio=True,
            ),
            Treinamento(
                codigo="NR-32",
                nome="Segurança em Serviços de Saúde — NR-32",
                carga_horaria_horas=Decimal(16),
                conteudo_programatico=(
                    "Riscos biológicos\nPerfurocortantes\nQuímicos em serviços de saúde"
                ),
                validade_meses=12,
                norma_referencia="NR-32",
            ),
            Treinamento(
                codigo="NR-06",
                nome="Uso e conservação de EPI — NR-6",
                carga_horaria_horas=Decimal(4),
                conteudo_programatico="Guarda e conservação\nHigienização\nDescarte",
                validade_meses=0,
                norma_referencia="NR-6",
            ),
        ]
        s.add_all(catalogo)
        s.flush()

        # O modelo especifico (apontado por `modelo_vigente_id`) e o generico
        # (treinamento_id nulo) existem os dois de proposito: `modelo_da_turma`
        # tem dois ramos, e so com os dois preenchidos as duas telas mostram o
        # que dizem. Generico e UM so - dois empatariam e a emissao bloquearia.
        def modelo(nome: str, treinamento_id: int | None) -> CertificadoModelo:
            alvo = CertificadoModelo(
                treinamento_id=treinamento_id,
                nome=nome,
                arquivo="certificado_padrao_v1.docx",
                versao=1,
                vigente=True,
                criado_por=coord.id,
            )
            s.add(alvo)
            s.flush()
            for ordem, (marcador, campo) in enumerate(MAPA_SUGERIDO.items(), start=1):
                s.add(
                    CertificadoModeloTag(
                        modelo_id=alvo.id,
                        marcador=marcador,
                        campo=campo,
                        ordem=ordem,
                        obrigatorio=marcador in OBRIGATORIOS,
                    )
                )
            s.flush()
            return alvo

        especifico = modelo("Padrão NR-35", catalogo[0].id)
        catalogo[0].modelo_vigente_id = especifico.id
        modelo("Padrão da casa", None)

        # instrutor interno tem de apontar para um servidor (`ck_assinatura_vinculo`):
        # a rubrica que sai no certificado responde por alguem do quadro, ou e
        # declaradamente externa
        interno = s.execute(
            select(Servidor).where(Servidor.siape == "3010088")
        ).scalar_one()
        instrutores = [
            AssinaturaInstrutor(
                servidor_id=interno.id,
                nome=interno.nome,
                titulo="Engenheiro de Segurança do Trabalho",
                conselho="CREA",
                registro_conselho="MG-111111",
                externo=False,
                vigencia_inicio=date(2021, 1, 1),
            ),
            AssinaturaInstrutor(
                nome="Vitalina Escobar Rangel",
                titulo="Técnica de Segurança do Trabalho",
                organizacao="Instituto de Teste",
                externo=True,
                vigencia_inicio=date(2022, 1, 1),
            ),
        ]
        s.add_all(instrutores)
        s.flush()
        s.commit()

    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        secretaria = atual(s, "secretaria")
        dia = s.execute(select(Campus).where(Campus.sigla == "DIA")).scalar_one()
        nr35 = s.execute(select(Treinamento).where(Treinamento.codigo == "NR-35")).scalar_one()
        nr32 = s.execute(select(Treinamento).where(Treinamento.codigo == "NR-32")).scalar_one()
        nr06 = s.execute(select(Treinamento).where(Treinamento.codigo == "NR-06")).scalar_one()
        instrutor = s.execute(select(AssinaturaInstrutor)).scalars().first()

        def inscritos(turma, siapes, externos=()):
            criadas = []
            for siape in siapes:
                servidor = s.execute(
                    select(Servidor).where(Servidor.siape == siape)
                ).scalar_one()
                pessoa = servico_participante.de_servidor(s, servidor, secretaria)
                criadas.append(servico_turma.inscrever(s, secretaria, turma, pessoa))
            for nome, vinculo, organizacao in externos:
                pessoa = servico_participante.criar_externo(
                    s, nome=nome, vinculo=vinculo, organizacao=organizacao,
                    usuario=secretaria,
                )
                criadas.append(servico_turma.inscrever(s, secretaria, turma, pessoa))
            return criadas

        # 1) PLANEJADA — existe na agenda e ainda nao recebe inscrito
        planejada = servico_turma.criar_turma(
            s, coord, treinamento=nr35,
            data_inicio=hoje + timedelta(days=30),
            data_fim=hoje + timedelta(days=30),
            local="Auditório do Campus JK",
            campus_id=dia.id,
            vagas=20,
        )
        servico_turma.vincular_instrutor(s, coord, planejada, instrutor)

        # 2) INSCRICOES_ABERTAS — com gente inscrita e vaga sobrando
        abertas = servico_turma.criar_turma(
            s, coord, treinamento=nr06,
            data_inicio=hoje + timedelta(days=12),
            data_fim=hoje + timedelta(days=12),
            local="Sala de treinamento da CSSO",
            campus_id=dia.id,
            vagas=8,
            inscricao_aberta_ate=hoje + timedelta(days=10),
        )
        servico_turma.vincular_instrutor(s, coord, abertas, instrutor)
        servico_turma.mudar_situacao(s, coord, abertas, "INSCRICOES_ABERTAS")
        inscritos(abertas, ("3010011", "3010022", "3010033"),
                  externos=(("Wagner Estrela Lopes", "TERCEIRIZADO", "Empresa de Teste"),))

        # 3) EM_ANDAMENTO com presenca lancada em parte da turma
        andamento = servico_turma.criar_turma(
            s, coord, treinamento=nr32,
            data_inicio=hoje - timedelta(days=1),
            data_fim=hoje - timedelta(days=1),
            local="Anfiteatro da FAMED",
            campus_id=dia.id,
            vagas=15,
        )
        servico_turma.vincular_instrutor(s, coord, andamento, instrutor)
        lista = inscritos(andamento, ("3010044", "3010055", "3010066"))
        servico_turma.mudar_situacao(s, coord, andamento, "EM_ANDAMENTO")
        for inscricao in lista[:2]:
            presenca.lancar_presenca(
                s, coord, inscricao,
                data=andamento.data_inicio, presente=True,
                horas=Decimal(16),
            )

        # 4) CONCLUIDA com certificados emitidos — o caminho inteiro
        concluida = servico_turma.criar_turma(
            s, coord, treinamento=nr35,
            data_inicio=hoje - timedelta(days=9),
            data_fim=hoje - timedelta(days=9),
            local="Campo de treinamento — Campus JK",
            campus_id=dia.id,
            vagas=10,
            nota_minima_aprovacao=Decimal(7),
        )
        servico_turma.vincular_instrutor(s, coord, concluida, instrutor)
        # o terceiro nao e o instrutor: quem ministra a turma nao se inscreve nela,
        # e ve-los na mesma lista confundiria quem esta aprendendo a tela
        turma_lista = inscritos(concluida, ("3010011", "3010077", "3010099"))
        servico_turma.mudar_situacao(s, coord, concluida, "EM_ANDAMENTO")
        for inscricao, nota in zip(turma_lista[:2], (Decimal("9.5"), Decimal("8.0"))):
            presenca.lancar_presenca(
                s, coord, inscricao,
                data=concluida.data_inicio, presente=True, horas=Decimal(8),
            )
            presenca.lancar_nota(s, coord, inscricao, nota)
        # o terceiro nunca compareceu: a apuracao o fecha como ausente/reprovado,
        # e e o caso que faz a tela de emissao mostrar por que alguem NAO recebe
        servico_turma.mudar_situacao(s, coord, concluida, "CONCLUIDA")
        s.flush()
        s.expire_all()

        # 5) CANCELADA — turma que nao aconteceu, com motivo registrado
        cancelada = servico_turma.criar_turma(
            s, coord, treinamento=nr06,
            data_inicio=hoje + timedelta(days=20),
            data_fim=hoje + timedelta(days=20),
            local="Sala de treinamento da CSSO",
            campus_id=dia.id,
        )
        servico_turma.mudar_situacao(
            s, coord, cancelada, "CANCELADA", motivo="Instrutor indisponível na data."
        )

        resumo["turmas"] = 5
        s.commit()

    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        turma = s.execute(
            select(Turma).where(Turma.situacao == "CONCLUIDA")
        ).scalars().first()
        emitidos = 0
        for inscricao in s.execute(
            select(Inscricao).where(Inscricao.turma_id == turma.id)
        ).scalars():
            if emissao_certificado.validar(s, inscricao).ok:
                emissao_certificado.emitir(s, coord, inscricao, gerar_pdf=False)
                emitidos += 1
        resumo["certificados"] = emitidos
        s.commit()

    # -----------------------------------------------------------------
    # Gestao de EPI
    # -----------------------------------------------------------------
    # (nome, codigo da categoria, CA, validade em dias a partir de hoje, tamanhos,
    #  vida util em meses, quantidade padrao, maxima, janela em meses, treinamento)
    CATALOGO_EPI = (
        ("Luva de proteção química (nitrílica)", "PROT_MEMBROS_SUPERIORES", "41585",
         900, "P\nM\nG", 6, 2, 6, 12, False),
        ("Óculos de proteção ampla visão", "PROT_OLHOS_FACE", "38121",
         800, "", 24, 1, 2, 24, False),
        ("Protetor auricular tipo plugue", "PROT_AUDITIVA", "31543",
         700, "", 6, 2, None, None, False),
        ("Respirador semifacial PFF2", "PROT_RESPIRATORIA", "38504",
         30, "", 3, 5, None, None, True),
        ("Avental de PVC", "PROT_TRONCO", "40233", 650, "M\nG", 12, 1, None, None, False),
        ("Bota de segurança de PVC", "PROT_MEMBROS_INFERIORES", "42109",
         950, "38\n40\n42\n44", 12, 1, 2, 12, False),
        ("Capacete de segurança classe B", "PROT_CABECA", "31469",
         600, "", 60, 1, None, None, False),
        ("Macacão de proteção química", "PROT_CORPO_INTEIRO", "37890",
         500, "M\nG", 12, 1, None, None, True),
        ("Cinturão de segurança tipo paraquedista", "PROT_QUEDAS_DESNIVEL", "35678",
         400, "", 60, 1, None, None, True),
    )

    with mod_banco.sessao() as s:
        tecnico = atual(s, "tecnico")
        for (nome, categoria, ca, dias, tamanhos, vida, padrao,
             maxima, janela, treinamento) in CATALOGO_EPI:
            categoria_obj = s.execute(
                select(EpiCategoria).where(EpiCategoria.codigo == categoria)
            ).scalar_one()
            item = EpiItem(
                nome=nome,
                categoria_id=categoria_obj.id,
                descricao="Item de catálogo do ambiente de teste.",
                fabricante="Fabricante de Teste Ltda",
                normas="NR-6",
                exige_ca=True,
                numero_ca=ca,
                validade_ca=hoje + timedelta(days=dias),
                unidade_medida="UNIDADE",
                tamanhos=tamanhos or None,
                vida_util_meses=vida,
                quantidade_padrao=padrao,
                quantidade_maxima=maxima,
                periodo_maximo_meses=janela,
                exige_treinamento=treinamento,
            )
            s.add(item)
            s.flush()
            auditoria.registrar(
                s,
                entidade="epi_item",
                entidade_id=item.id,
                tipo_evento="EPI_ITEM_CRIADO",
                descricao=f"{item.nome} · {item.categoria.nome} · CA {item.numero_ca}",
                usuario=tecnico,
            )
        resumo["epi_itens"] = len(CATALOGO_EPI)
        s.commit()

    with mod_banco.sessao() as s:
        almoxarife = atual(s, "almoxarife")

        def item_de(prefixo: str) -> EpiItem:
            return s.execute(
                select(EpiItem).where(EpiItem.nome.like(f"{prefixo}%"))
            ).scalars().first()

        # (item, quantidade, tamanho, lote, CA, validade relativa em dias)
        # A linha do meio e a que importa: um lote com o CA JA VENCIDO. A RN-25 e a
        # regra mais seria do modulo, e ela so se ve funcionando se houver na
        # prateleira algo que ela recuse - `registrar_entrada` aceita o lote (a
        # nota fiscal existe, o material esta na caixa), e quem recusa e a entrega.
        lotes = (
            ("Luva", 40, "M", "L-2026-011", "41585", 540),
            ("Luva", 12, "G", "L-2024-902", "41585", -25),
            ("Óculos", 25, "", "L-2026-021", "38121", 700),
            ("Respirador", 30, "", "L-2026-031", "38504", 45),
            ("Bota", 15, "40", "L-2026-041", "42109", 800),
            ("Protetor", 120, "", "L-2026-051", "31543", 640),
            ("Avental", 10, "G", "L-2026-061", "40233", 600),
        )
        for prefixo, quantidade, tamanho, lote, ca, dias in lotes:
            epi_estoque.registrar_entrada(
                s, almoxarife,
                item=item_de(prefixo),
                quantidade_recebida=quantidade,
                data_entrada=hoje - timedelta(days=60),
                tamanho=tamanho,
                pregao=f"PE {ano}/0012",
                empenho=f"{ano}NE000{len(lote)}",
                nota_fiscal=f"NF-{lote}",
                fornecedor_nome="Fornecedora de Teste S.A.",
                fornecedor_cnpj="11222333000181",
                quantidade_empenhada=quantidade,
                valor_unitario=Decimal("12.50"),
                lote=lote,
                numero_ca=ca,
                validade_ca=hoje + timedelta(days=dias),
                observacao="Lote do ambiente de teste.",
            )
        # e um descarte, para o extrato do razao ter mais de um tipo de linha
        vencido = s.execute(
            select(EpiEntradaEstoque).where(EpiEntradaEstoque.lote == "L-2024-902")
        ).scalar_one()
        epi_estoque.descartar(
            s, almoxarife, entrada=vencido, quantidade=2,
            motivo="Descarte parcial do lote com CA vencido (dado de teste).",
        )
        resumo["epi_lotes"] = len(lotes)
        s.commit()

    # Fichas de entrega de balcao: a prova nominal de que a pessoa recebeu.
    with mod_banco.sessao() as s:
        almoxarife = atual(s, "almoxarife")

        def item_de(prefixo: str) -> EpiItem:
            return s.execute(
                select(EpiItem).where(EpiItem.nome.like(f"{prefixo}%"))
            ).scalars().first()

        def lote_de(codigo: str):
            return s.execute(
                select(EpiEntradaEstoque).where(EpiEntradaEstoque.lote == codigo)
            ).scalar_one()

        def pessoa(siape: str) -> Servidor:
            return s.execute(select(Servidor).where(Servidor.siape == siape)).scalar_one()

        # Entrega antiga de item com vida util de 6 meses: a troca ja venceu, e
        # `sincronizar_trocas_do_servidor` abre a pendencia RN-32 com prazo no
        # passado - que e a verdade, e e o que faz o sino ter conteudo vermelho.
        epi_ficha.registrar_entrega(
            s, almoxarife,
            servidor=pessoa("3010011"),
            item=item_de("Luva"),
            quantidade=2,
            entrada=lote_de("L-2026-011"),
            tamanho="M",
            data_evento=hoje - timedelta(days=250),
            observacao="Entrega de balcão registrada no ambiente de teste.",
        )
        recente = epi_ficha.registrar_entrega(
            s, almoxarife,
            servidor=pessoa("3010022"),
            item=item_de("Óculos"),
            quantidade=1,
            entrada=lote_de("L-2026-021"),
            data_evento=hoje - timedelta(days=20),
            observacao="Entrega de balcão registrada no ambiente de teste.",
        )
        # devolucao parcial: linha nova na ficha, nunca rasura na anterior
        epi_ficha.registrar_devolucao(
            s, almoxarife, recente,
            quantidade=1,
            motivo="Devolvido por troca de posto de trabalho.",
            data_evento=hoje - timedelta(days=5),
        )
        errada = epi_ficha.registrar_entrega(
            s, almoxarife,
            servidor=pessoa("3010033"),
            item=item_de("Protetor"),
            quantidade=2,
            entrada=lote_de("L-2026-051"),
            data_evento=hoje - timedelta(days=12),
        )
        # estorno: a correcao que a RN-31 admite — linha nova, com a errada ao lado
        epi_ficha.estornar(s, almoxarife, errada, "Lançado no servidor errado (teste).")
        epi_ficha.registrar_entrega(
            s, almoxarife,
            servidor=pessoa("3010044"),
            item=item_de("Bota"),
            quantidade=1,
            entrada=lote_de("L-2026-041"),
            tamanho="40",
            data_evento=hoje - timedelta(days=8),
        )
        resumo["epi_fichas"] = 5
        s.commit()

    # Requisicoes, uma por estado interessante.
    with mod_banco.sessao() as s:
        secretaria = atual(s, "secretaria")
        titular = atual(s, "servidor")
        analista = atual(s, "tecnico")
        almoxarife = atual(s, "almoxarife")

        def item_de(prefixo: str) -> EpiItem:
            return s.execute(
                select(EpiItem).where(EpiItem.nome.like(f"{prefixo}%"))
            ).scalars().first()

        def lote_de(codigo: str):
            return s.execute(
                select(EpiEntradaEstoque).where(EpiEntradaEstoque.lote == codigo)
            ).scalar_one()

        def pessoa(siape: str) -> Servidor:
            return s.execute(select(Servidor).where(Servidor.siape == siape)).scalar_one()

        def pedir(usuario, siape, itens, atividade):
            requisicao = epi_requisicao.criar_rascunho(
                s, usuario,
                servidor=pessoa(siape),
                descricao_atividade=atividade,
                riscos_declarados="Agente químico e agente biológico no posto.",
            )
            for prefixo, quantidade, tamanho in itens:
                epi_requisicao.adicionar_item(
                    s, usuario, requisicao,
                    item=item_de(prefixo), quantidade=quantidade, tamanho=tamanho,
                )
            return requisicao

        # RASCUNHO — ainda em digitacao, e o unico estado que admite exclusao
        pedir(secretaria, "3010101", (("Óculos", 1, ""),),
              "Apoio administrativo com visita eventual ao laboratório.")

        # ENVIADA — na fila, ninguem pegou ainda
        enviada = pedir(titular, "3010011", (("Luva", 2, "M"),),
                        "Análises clínicas no LEAC, com manipulação de reagentes.")
        epi_requisicao.enviar(s, titular, enviada)

        # EM_ANALISE — o analista pegou e assumiu o nome no pedido
        em_analise = pedir(secretaria, "3010022", (("Avental", 1, "G"),),
                           "Manipulação de ácidos no laboratório de química.")
        epi_requisicao.enviar(s, secretaria, em_analise)
        epi_requisicao.iniciar_analise(s, analista, em_analise)

        # ANALISADA — um item aprovado e outro recusado, com motivo do catalogo
        mista = pedir(secretaria, "3010055",
                      (("Luva", 2, "P"), ("Capacete", 1, "")),
                      "Rotina de bancada no laboratório de química do ICA.")
        epi_requisicao.enviar(s, secretaria, mista)
        epi_requisicao.iniciar_analise(s, analista, mista)
        epi_requisicao.aprovar_item(s, analista, mista.itens[0])
        sem_exposicao = s.execute(
            select(EpiMotivoRecusa).where(EpiMotivoRecusa.codigo == "SEM_EXPOSICAO")
        ).scalar_one()
        epi_requisicao.recusar_item(s, analista, mista.itens[1], motivo=sem_exposicao)
        epi_requisicao.concluir_analise(
            s, analista, mista,
            parecer="Luva deferida; capacete indeferido por ausência de exposição.",
        )

        # EM_ATENDIMENTO — item aprovado e reservado num lote
        reservada = pedir(secretaria, "3010066", (("Bota", 1, "40"),),
                          "Trabalho em tanques do laboratório de aquicultura.")
        epi_requisicao.enviar(s, secretaria, reservada)
        epi_requisicao.iniciar_analise(s, analista, reservada)
        epi_requisicao.aprovar_item(s, analista, reservada.itens[0])
        epi_requisicao.concluir_analise(s, analista, reservada)
        epi_requisicao.reservar_item(
            s, almoxarife, reservada.itens[0], entrada=lote_de("L-2026-041")
        )

        # ATENDIDA — aprovado, reservado e entregue: a ficha nasce da entrega
        atendida = pedir(secretaria, "3010077", (("Protetor", 2, ""),),
                         "Rotina no laboratório de doenças infecciosas.")
        epi_requisicao.enviar(s, secretaria, atendida)
        epi_requisicao.iniciar_analise(s, analista, atendida)
        epi_requisicao.aprovar_item(s, analista, atendida.itens[0])
        epi_requisicao.concluir_analise(s, analista, atendida)
        epi_requisicao.reservar_item(
            s, almoxarife, atendida.itens[0], entrada=lote_de("L-2026-051")
        )
        epi_requisicao.entregar_item(s, almoxarife, atendida.itens[0])

        # SEM_ESTOQUE — o item aprovado que a prateleira nao tem, com a pendencia
        # da fatia 7 aberta em nome de quem tem de decidir
        faltando = pedir(secretaria, "3010112", (("Macacão", 1, "G"),),
                         "Apoio à limpeza de área com produto químico.")
        epi_requisicao.enviar(s, secretaria, faltando)
        epi_requisicao.iniciar_analise(s, analista, faltando)
        epi_requisicao.aprovar_item(s, analista, faltando.itens[0])
        epi_requisicao.concluir_analise(s, analista, faltando)
        epi_requisicao.marcar_sem_estoque(
            s, almoxarife, faltando.itens[0],
            complemento="Sem lote de macacão em estoque nesta data.",
        )

        # INDEFERIDA e CANCELADA — os dois terminais que nao entregam nada
        indeferida = pedir(secretaria, "3010099", (("Cinturão", 1, ""),),
                           "Atividade administrativa em piso térreo.")
        epi_requisicao.enviar(s, secretaria, indeferida)
        epi_requisicao.iniciar_analise(s, analista, indeferida)
        # o envelope so se indefere depois de TODO item recusado: indeferir e a
        # resposta ao pedido inteiro, e nao um atalho por cima da decisao de linha
        epi_requisicao.recusar_item(
            s, analista, indeferida.itens[0], motivo=sem_exposicao
        )
        epi_requisicao.indeferir(
            s, analista, indeferida,
            motivo=sem_exposicao,
            parecer="Não há trabalho em altura descrito na atividade informada.",
        )

        cancelada_req = pedir(secretaria, "3010123", (("Luva", 2, "G"),),
                              "Coleta de solo em campo experimental.")
        epi_requisicao.enviar(s, secretaria, cancelada_req)
        epi_requisicao.cancelar(s, secretaria, cancelada_req, "Pedido duplicado (teste).")

        resumo["epi_requisicoes"] = 9
        s.commit()

    # -----------------------------------------------------------------
    # Demandas: o que chegou por fora do SEI.
    #
    # Sete, e a lista nao e arbitraria — ela cobre os tres estados e os QUATRO
    # desfechos, mais os dois casos que so se veem com o tempo passado: a
    # atrasada (que produz o vermelho na lista e a linha no sino) e a que virou
    # processo, ligada a um processo que EXISTE neste mesmo ambiente. Sem a
    # ultima, o desfecho mais importante da funcionalidade seria clicavel na
    # tela e nao levaria a lugar nenhum.
    #
    # Vem ANTES do bloco de pendencias de propósito: e la que duas tarefas sao
    # envelhecidas, e a demanda com prazo tem de estar na conta. O prazo da
    # em-andamento e longo (25 dias) para ela nao ser uma das duas escolhidas —
    # aquele laco pega as duas de prazo mais curto, que sao as de dez dias do
    # parecer e do comprovante de EPI.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        coord = atual(s, "coordenador")
        secretaria = atual(s, "secretaria")
        engenheiro = atual(s, "engenheiro")

        def pessoa(siape: str) -> Servidor:
            return s.execute(select(Servidor).where(Servidor.siape == siape)).scalar_one()

        famed = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.sigla == "FAMED")
        ).scalar_one()
        progep = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.sigla == "PROGEP")
        ).scalar_one()

        # 1) ABERTA, sem prazo — o caso mais comum: chegou, esta na fila, e
        # ninguem prometeu data. Nao abre pendencia, e e isso que a mantem fora
        # do sino sem some da tela.
        servico_demandas.registrar(
            s, coord,
            assunto="Chefia da FAMED pergunta se o laboratório precisa de laudo novo",
            canal="EMAIL",
            solicitante_nome="Chefia da Faculdade de Medicina de Diamantina",
            solicitante_unidade_uorg_id=famed.id,
            data_chegada=hoje - timedelta(days=6),
            descricao=(
                "Perguntou por e-mail se a mudança de bancada no laboratório de "
                "análises clínicas exige laudo novo. Dado de teste."
            ),
        )

        # 2) ABERTA e ATRASADA — o vermelho da lista e a linha no sino. O prazo
        # ja passou quando ela nasce, que e a verdade do caso: o oficio chegou
        # ha vinte dias pedindo resposta em dez.
        servico_demandas.registrar(
            s, coord,
            assunto="Ofício da PROGEP pede posição sobre revezamento no CME",
            canal="OFICIO",
            solicitante_nome="Pró-Reitoria de Gestão de Pessoas",
            solicitante_unidade_uorg_id=progep.id,
            data_chegada=hoje - timedelta(days=20),
            prazo=hoje - timedelta(days=4),
            descricao=(
                "Pediu manifestação da CSSO sobre a escala de revezamento na "
                "central de esterilização. Dado de teste."
            ),
        )

        # 3) EM_ANDAMENTO, com prazo e com dois encaminhamentos — o historico
        # append-only que a ficha mostra, e que e o que sustenta a proxima
        # cobranca sem comecar do zero.
        em_curso = servico_demandas.registrar(
            s, secretaria,
            assunto="Servidor do LEAC pede avaliação do posto para adicional",
            canal="PRESENCIAL",
            solicitante_nome="Adelaide Nunes Prata",
            solicitante_servidor_id=pessoa("3010011").id,
            solicitante_unidade_uorg_id=famed.id,
            data_chegada=hoje - timedelta(days=12),
            prazo=hoje + timedelta(days=25),
            responsavel_id=engenheiro.id,
            descricao=(
                "Veio ao balcão perguntar como pedir a avaliação do posto de "
                "trabalho. Dado de teste."
            ),
        )
        servico_demandas.encaminhar(
            s, secretaria, em_curso,
            para_quem="Engenharia de Segurança do Trabalho",
            pedido="Agendar a inspeção do posto e dizer se cabe laudo próprio.",
            data_encaminhamento=hoje - timedelta(days=10),
        )
        servico_demandas.encaminhar(
            s, engenheiro, em_curso,
            para_quem="Chefia da FAMED",
            pedido="Confirmar por escrito a rotina de trabalho no posto.",
            data_encaminhamento=hoje - timedelta(days=3),
        )

        # 4) ENCERRADA / RESOLVIDA — acabou aqui dentro, e o que foi feito esta
        # escrito.
        resolvida = servico_demandas.registrar(
            s, coord,
            assunto="Dúvida sobre validade do CA da luva nitrílica",
            canal="TELEFONE",
            solicitante_nome="Almoxarifado do Campus JK",
            data_chegada=hoje - timedelta(days=15),
        )
        servico_demandas.encerrar(
            s, coord, resolvida,
            desfecho="RESOLVIDA",
            relato=(
                "Respondi por telefone: o CA do lote vence em outubro e o "
                "sistema já avisa 60 dias antes. Dado de teste."
            ),
        )

        # 5) ENCERRADA / VIROU_PROCESSO — a rastreabilidade, ligada a um
        # processo que EXISTE neste ambiente.
        virou = servico_demandas.registrar(
            s, coord,
            assunto="Pedido de adicional de insalubridade chegou por e-mail",
            canal="EMAIL",
            solicitante_nome="Kátia Lousada Ferrão",
            solicitante_servidor_id=pessoa("3010112").id,
            data_chegada=hoje - timedelta(days=30),
        )
        processo_gerado = s.execute(
            select(Processo).where(Processo.nup == nup_de(100002, ano))
        ).scalar_one()
        servico_demandas.encerrar(
            s, coord, virou,
            desfecho="VIROU_PROCESSO",
            processo_id=processo_gerado.id,
            relato="Autuado no SEI e instruído pela CSSO. Dado de teste.",
        )

        # 6) ENCERRADA / ENCAMINHADA — a bola esta com outro setor, com data.
        encaminhada = servico_demandas.registrar(
            s, secretaria,
            assunto="Pedido de mudança de lotação por incompatibilidade de horário",
            canal="EMAIL",
            solicitante_nome="Juvenal Ataíde Brandão",
            solicitante_servidor_id=pessoa("3010101").id,
            data_chegada=hoje - timedelta(days=25),
        )
        servico_demandas.encerrar(
            s, secretaria, encaminhada,
            desfecho="ENCAMINHADA",
            setor="PROGEP — Diretoria de Administração de Pessoal",
            data_desfecho=hoje - timedelta(days=22),
        )

        # 7) ENCERRADA / SEM_PROVIDENCIA — a decisao de nao fazer nada, com o
        # motivo escrito. E o desfecho que hoje acontece calado, e e por ele que
        # a funcionalidade existe.
        sem_providencia = servico_demandas.registrar(
            s, coord,
            assunto="Solicitação de EPI para empresa de limpeza terceirizada",
            canal="PRESENCIAL",
            solicitante_nome="Encarregado da empresa contratada",
            data_chegada=hoje - timedelta(days=9),
        )
        servico_demandas.encerrar(
            s, coord, sem_providencia,
            desfecho="SEM_PROVIDENCIA",
            relato=(
                "O EPI de empregado de empresa contratada é obrigação do "
                "empregador (NR-6). Orientei a dirigir o pedido à contratante e "
                "avisei a fiscalização do contrato. Dado de teste."
            ),
        )

        resumo["demandas"] = 7
        s.commit()

    # -----------------------------------------------------------------
    # Pendencias: quase todas ja nasceram sozinhas (emissao de parecer, laudo
    # superado, CA a vencer, comprovante de EPI, troca devida, item sem estoque).
    # Falta so envelhecer duas, pelo mesmo motivo de `envelhecer`: sem tempo
    # passado nao ha tarefa atrasada, e o sino e a tela de pendencias nascem
    # todos verdes - que e o unico estado que nao precisa ser testado.
    # -----------------------------------------------------------------
    with mod_banco.sessao() as s:
        abertas_agora = pendencias.abertas(s)
        for pendencia, dias in zip(
            [p for p in abertas_agora if not p.atrasada()], (18, 5)
        ):
            pendencia.prazo = hoje - timedelta(days=dias)
        resumo["pendencias"] = len(abertas_agora)
        resumo["pendencias_atrasadas"] = sum(
            1 for p in s.execute(select(Pendencia).where(Pendencia.concluida.is_(False)))
            .scalars() if p.atrasada()
        )
        s.commit()

    return resumo


# =====================================================================
# CLI
# =====================================================================
def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--destino",
        default=DESTINO_PADRAO,
        help=f"pasta do ambiente de teste (padrao: {DESTINO_PADRAO})",
    )
    parser.add_argument("--porta", type=int, default=PORTA_PADRAO)
    parser.add_argument(
        "--host",
        default=None,
        help=(
            "endereco de ligacao. Sem isto, o ambiente RECRIADO mantem o que ja "
            f"estava no .env da pasta, e um ambiente novo nasce em {HOST_PADRAO}"
        ),
    )
    args = parser.parse_args(argv)

    base = Path(args.destino)
    if not base.is_absolute():
        base = RAIZ / base

    try:
        env = preparar(base, args.porta, args.host)
    except DestinoProibido as erro:
        print(f"ERRO: {erro}", file=sys.stderr)
        return 2

    print("Montando o ambiente de teste (banco novo, dados de mentira)...")
    resumo = povoar(base)

    print()
    print("=" * 66)
    print(" AMBIENTE DE TESTE PRONTO")
    print("=" * 66)
    # `app.*` so pode ser importado depois de `preparar` exportar as variaveis —
    # e a esta altura `povoar` ja o fez. O criterio de "so a propria maquina
    # alcanca" e o do sistema, e nao um segundo escrito aqui.
    from app.config import SO_LOOPBACK

    host = os.environ["CSSO_HOST"]
    na_rede = host not in SO_LOOPBACK
    print(f"  Endereco:  http://{'127.0.0.1' if na_rede else host}:{args.porta}/")
    print(f"  Banco:     {base / 'csso.db'}")
    print(f"  Config:    {env}")
    print()
    print("  O que foi criado:")
    for chave in sorted(resumo):
        print(f"    {chave.replace('_', ' '):<24} {resumo[chave]}")
    print()
    print(f"  Senha de TODAS as contas: {SENHA}")
    print("  Contas (entre por qualquer uma e veja a tela mudar):")
    for login, perfil, nome in CONTAS:
        print(f"    {login:<14} {perfil:<22} {nome}")
    print()
    if na_rede:
        # Os dois casos sao diferentes e a frase nao pode confundi-los: um foi
        # pedido agora, o outro e uma decisao ANTIGA que sobreviveu ao `rmtree`
        # — e e justamente essa que precisa ser dita, porque ninguem a tomou
        # nesta execucao e ha colegas com o endereco na mao.
        print(f"  ATENDE A REDE: ligado em {host}:{args.porta}.")
        if args.host:
            print("    Foi o que voce pediu em --host.")
        else:
            print("    Ninguem pediu isso agora: o .env anterior desta pasta ja")
            print("    atendia a rede, e a recriacao manteve a decisao.")
        print("    Outras maquinas alcancam, e sem TLS a senha viaja em claro.")
        print(f"    Para atender so este computador, recrie com  --host {HOST_PADRAO}")
        print()
    print("  Suba com INICIAR-TESTE.bat, derrube com PARAR-TESTE.bat.")
    print("  Roteiro do passeio: entrada/implantacao/02_AMBIENTE_DE_TESTE.md")
    print("  Este ambiente nao toca em dados/csso.db.")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
