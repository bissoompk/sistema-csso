"""Terceira camada de acesso: todo repositorio invoca `aplicar_escopo`.

A varredura nasceu olhando so `app/repositorios/`, que tem UM arquivo — e os
quatro vazamentos graves medidos em `entrada/servidor/03_PRIVACIDADE.md` estavam
todos fora dele: parecer, requisicao de EPI, cadastro de servidor e pendencia
liam o ORM direto na rota. O teste passava enquanto o sistema entregava o parecer
nominal de qualquer pessoa a uma conta de fora do setor. Silencio que se le como
"esta tudo certo" e o modo de falha exato que `_conferir_escopos` e
`EscopoNaoDeclarado` foram escritos para nao deixar acontecer.

Por isso a segunda metade deste arquivo varre `app/rotas/`, e nao so a pasta do
repositorio. Ela olha a ROTA DE LEITURA — o que uma conta logada alcanca pela
URL — e segue as chamadas dela dentro do proprio modulo, porque um `s.get` que
mora num `_tela_ficha` vaza igual ao que mora na rota.

**Ate onde ela alcanca, e ate onde nao.** A expansao de chamada para dentro de
`app/servicos/` foi medida e descartada: seguir o grafo inteiro faz uma porta
encontrada em qualquer galho absolver a rota inteira, e o painel de EPI passou a
"ter escopo" por causa de uma chamada a `pendencias.abertas` tres niveis abaixo.
Absolvicao facil e pior que cobertura curta, porque parece cobertura. O servico
entra por outro lado, mais duro: `test_porta_declarada_realmente_escopa` abre o
codigo de cada porta declarada e exige que ela escope de verdade — sem isso a
varredura contaria nomes vazios, e esvaziar `epi_requisicao.fila` devolveria o
vazamento com o teste passando. O que fica de fora e a consulta que nasce e
morre dentro de um servico sem passar por rota de leitura nenhuma.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from app.config import RAIZ
from app.repositorios import processos as repo

DIR_REPOSITORIOS = RAIZ / "app" / "repositorios"


def _funcoes_publicas(caminho: Path) -> list[ast.FunctionDef]:
    arvore = ast.parse(caminho.read_text(encoding="utf-8"))
    return [
        no
        for no in arvore.body
        if isinstance(no, ast.FunctionDef) and not no.name.startswith("_")
    ]


def _chama(no: ast.FunctionDef, alvo: str) -> bool:
    return any(
        isinstance(filho, ast.Name) and filho.id == alvo
        for filho in ast.walk(no)
    )


ARQUIVOS = sorted(p for p in DIR_REPOSITORIOS.glob("*.py") if p.name != "__init__.py")
CASOS = [
    (arquivo.name, funcao.name)
    for arquivo in ARQUIVOS
    for funcao in _funcoes_publicas(arquivo)
]


def test_existe_ao_menos_um_repositorio():
    assert CASOS, "nenhuma funcao publica de repositorio encontrada"


@pytest.mark.parametrize("arquivo,funcao", CASOS)
def test_funcao_publica_aplica_escopo(arquivo: str, funcao: str):
    """Se alguem escrever uma consulta sem escopo, este teste quebra."""
    caminho = DIR_REPOSITORIOS / arquivo
    no = next(f for f in _funcoes_publicas(caminho) if f.name == funcao)
    usa_direto = _chama(no, "aplicar_escopo")
    # ou delega para um helper interno que aplica o escopo
    delega = any(
        isinstance(filho, ast.Call)
        and isinstance(filho.func, ast.Name)
        and filho.func.id.startswith("_")
        for filho in ast.walk(no)
    )
    assert usa_direto or delega, (
        f"{arquivo}:{funcao} nao aplica escopo nem delega para helper que aplique"
    )


def test_helper_base_aplica_escopo():
    fonte = inspect.getsource(repo._base)
    assert "aplicar_escopo" in fonte


def test_escopo_proprio_filtra_pelo_servidor(sessao):
    from sqlalchemy import select

    from app.modelos import Processo
    from app.servicos.rbac import aplicar_escopo, UsuarioAtual

    servidor_consulta = UsuarioAtual(
        id=9,
        login="serv",
        nome="Servidor",
        permissoes=frozenset({"processo.ver"}),
        perfis=("servidor_consulta",),
        servidor_id=77,
    )
    consulta = aplicar_escopo(select(Processo), servidor_consulta, Processo)
    assert "servidor_id" in str(consulta)


def test_escopo_total_do_auditor():
    from sqlalchemy import select

    from app.modelos import Processo
    from app.servicos.rbac import aplicar_escopo, UsuarioAtual

    auditor = UsuarioAtual(
        id=10,
        login="aud",
        nome="Auditor",
        permissoes=frozenset({"processo.ver"}),
        perfis=("auditor_interno",),
    )
    consulta = aplicar_escopo(select(Processo), auditor, Processo)
    assert "WHERE" not in str(consulta).upper()


def test_escopo_proprio_sobre_servidor_filtra_pela_chave(sessao):
    """`Servidor` e a unica tabela cujo "servidor desta linha" e a chave primaria."""
    from sqlalchemy import select

    from app.modelos import Servidor
    from app.servicos.rbac import UsuarioAtual, aplicar_escopo

    titular = UsuarioAtual(
        id=9,
        login="serv",
        nome="Servidor",
        permissoes=frozenset({"processo.ver"}),
        perfis=("servidor_consulta",),
        servidor_id=77,
    )
    consulta = str(aplicar_escopo(select(Servidor), titular, Servidor))
    assert "servidor.id" in consulta
    # e nao o ramo de "modelo sem servidor_id", que devolveria lista vazia
    assert "WHERE 0" not in consulta.upper()
    assert "FALSE" not in consulta.upper()


# =====================================================================
# A varredura das rotas de leitura
# =====================================================================
DIR_ROTAS = RAIZ / "app" / "rotas"

# Tabelas cuja LINHA e sobre uma pessoa identificada. Ler uma delas por id ou em
# lista e ler sobre alguem; e por isso que a terceira camada existe. Catalogo
# (`EpiItem`, `Cargo`, `UnidadeUorg`) fica de fora: ele nao nomeia ninguem.
MODELOS_NOMINAIS = {
    "AdicionalVigencia",
    "Certificado",
    "EpiFichaRegistro",
    "EpiRequisicao",
    "ParecerTecnico",
    "Pendencia",
    "Processo",
    "Servidor",
}

# As portas ja decididas: cada nome aqui e uma funcao que resolve o alcance e foi
# amarrada por teste no modulo dela. Chamar uma delas CONTA como aplicar escopo —
# o objetivo da varredura e que exista uma porta, nao que toda rota repita a
# consulta. O `lstrip('_')` da leitura faz `_no_escopo` e `no_escopo` valerem o
# mesmo: o alias privado do import e o mesmo codigo.
PORTAS_DE_ESCOPO = {
    "aplicar_escopo",
    "no_escopo",
    "consulta_no_escopo",
    "inscricoes_do_titular",
    "por_id",
    "fila",
    "abertas",
    "contar_abertas",
    "exigir_leitura_da_ficha",
    "exigir_leitura_do_certificado",
    "consulta_do_titular",
    "servidor_no_escopo",
    "liberar",
    "autorizar",
}

# Rota de leitura que alcanca modelo nominal SEM porta de escopo, e por que.
# Cada linha e uma decisao, nao uma isencao: quem apagar a porta de uma rota tem
# de vir aqui escrever a frase que a defende. Lista vazia seria mais bonita e
# menos honesta.
DISPENSAS: dict[str, str] = {
    "painel.py:painel": (
        "Agregado com supressao estatistica da RN-19 (celula < 5 suprimida, com "
        "supressao secundaria). Nenhum registro individual sai da tela; o que "
        "protege aqui e `relatorios.suprimir`, nao o escopo de linha."
    ),
    "epi_indicadores.py:painel": (
        "Mesma natureza do painel de processos: as cinco medidas do §9 sao "
        "contagens do setor, e `_servidores_de` so resolve a unidade de cada "
        "registro para a celula. Passa por `suprimir`/`suprimir_aninhado`."
    ),
    "relatorios.py:indice": (
        "Agregado sob `indicador.ver`, que nenhum perfil de escopo proprio tem. "
        "Sai por celula suprimida, nunca por linha."
    ),
    "laudos.py:listar": (
        "O laudo e do POSTO, nao da pessoa: `laudo.ver` existe para quem le "
        "ambiente de trabalho. Os pareceres lidos aqui sao contagem de reuso do "
        "laudo, e a permissao fica fora de `servidor_consulta`."
    ),
    "laudos.py:ficha": (
        "Idem `laudos.py:listar` — a lista de pareceres que reusaram o laudo e a "
        "conta que justifica a reavaliacao dele."
    ),
    "processos.py:tela_novo": (
        "Formulario de abertura sob `processo.criar`: o seletor de servidor e a "
        "escolha de sobre QUEM abrir o processo, e escopa-lo ao proprio "
        "impediria a CSSO de abrir processo para alguem."
    ),
    "demandas.py:listar": (
        "Fila de demanda sob `demanda.ver`, permissao de quem opera o trabalho "
        "do setor fora do SEI. O seletor de servidor e o filtro da fila."
    ),
    "usuarios.py:listar": (
        "Administracao de contas sob `usuario.criar_conta`/`perfil.conceder`: o "
        "seletor de servidor e o vinculo conta-pessoa, que so quem administra ve."
    ),
    "treinamentos.py:listar_assinaturas": (
        "Cadastro de assinatura de instrutor sob `assinatura.gerenciar`."
    ),
    "epi_fichas.py:formulario_de_entrega": (
        "Balcao de entrega sob `epi.entregar`: escolher a quem entregar exige ver "
        "a quem entregar, e a RN-19 ja decidiu que quem entrega le o nome "
        "(`rbac.ve_dado_nominal`)."
    ),
    "epi_fichas.py:imprimir_comprovante": (
        "Comprovante sob `epi.entregar` por `_registro_e_permissao`. A ficha e a "
        "porta da frente ja decidem pela relacao titular/terceiro "
        "(`epi_ficha.exigir_leitura_da_ficha`); esta e a via do balcao, e a "
        "permissao dela nao esta em perfil de escopo proprio."
    ),
}


def _funcoes_do_modulo(arvore: ast.Module) -> dict[str, ast.FunctionDef]:
    return {
        no.name: no
        for no in arvore.body
        if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _e_rota_de_leitura(no: ast.FunctionDef) -> bool:
    """`@rotas.get(...)`. POST/DELETE ficam de fora: escrita tem permissao propria."""
    for decorador in no.decorator_list:
        alvo = decorador.func if isinstance(decorador, ast.Call) else decorador
        if isinstance(alvo, ast.Attribute) and alvo.attr == "get":
            return True
    return False


def _leituras_nominais(no: ast.FunctionDef) -> set[str]:
    """`s.get(Modelo, ...)` e `select(Modelo)` sobre tabela nominal."""
    achados: set[str] = set()
    for filho in ast.walk(no):
        if not isinstance(filho, ast.Call) or not filho.args:
            continue
        primeiro = filho.args[0]
        modelo = primeiro.id if isinstance(primeiro, ast.Name) else None
        if modelo not in MODELOS_NOMINAIS:
            continue
        if isinstance(filho.func, ast.Attribute) and filho.func.attr == "get":
            achados.add(f"s.get({modelo})")
        elif isinstance(filho.func, ast.Name) and filho.func.id == "select":
            achados.add(f"select({modelo})")
    return achados


def _chamadas(no: ast.FunctionDef) -> tuple[set[str], set[str]]:
    """(nomes chamados, sem underscore inicial) e (nomes simples, para expandir)."""
    nomes: set[str] = set()
    simples: set[str] = set()
    for filho in ast.walk(no):
        if not isinstance(filho, ast.Call):
            continue
        alvo = filho.func
        if isinstance(alvo, ast.Name):
            simples.add(alvo.id)
            nomes.add(alvo.id.lstrip("_"))
        elif isinstance(alvo, ast.Attribute):
            nomes.add(alvo.attr.lstrip("_"))
    return nomes, simples


def analisar_rota(
    no: ast.FunctionDef,
    mapa: dict[str, ast.FunctionDef],
    vistos: set[str] | None = None,
) -> tuple[set[str], set[str]]:
    """O que a rota le e por que porta passa — seguindo os helpers do modulo.

    Segue a chamada porque foi assim que o defeito se escondeu: `fila()` nao
    lia nada, `servico.fila(s, ...)` e que lia; a ficha nao lia nada, `_requisicao`
    e que lia. Olhar so o corpo da rota deixaria as duas passarem limpas.
    """
    vistos = set() if vistos is None else vistos
    if no.name in vistos:
        return set(), set()
    vistos.add(no.name)
    lidos = _leituras_nominais(no)
    nomes, simples = _chamadas(no)
    portas = nomes & PORTAS_DE_ESCOPO
    for nome in simples:
        interno = mapa.get(nome)
        if interno is not None:
            mais_lidos, mais_portas = analisar_rota(interno, mapa, vistos)
            lidos |= mais_lidos
            portas |= mais_portas
    return lidos, portas


def _rotas_de_leitura() -> list[tuple[str, str, set[str], set[str]]]:
    achados = []
    for caminho in sorted(DIR_ROTAS.glob("*.py")):
        if caminho.name == "__init__.py":
            continue
        arvore = ast.parse(caminho.read_text(encoding="utf-8"))
        mapa = _funcoes_do_modulo(arvore)
        for nome, no in mapa.items():
            if not _e_rota_de_leitura(no):
                continue
            lidos, portas = analisar_rota(no, mapa)
            achados.append((caminho.name, nome, lidos, portas))
    return achados


ROTAS_DE_LEITURA = _rotas_de_leitura()


def test_existe_rota_de_leitura_que_alcanca_modelo_nominal():
    """Sonda de coleta: varredura que nao acha nada nao mede nada."""
    com_leitura = [r for r in ROTAS_DE_LEITURA if r[2]]
    assert len(com_leitura) >= 20, (
        f"so {len(com_leitura)} rotas de leitura alcancam modelo nominal — "
        "a coleta quebrou (nome de decorador, pasta ou modelo mudou)"
    )


@pytest.mark.parametrize(
    "arquivo,funcao",
    [(a, f) for a, f, lidos, _ in ROTAS_DE_LEITURA if lidos],
    ids=[f"{a}:{f}" for a, f, lidos, _ in ROTAS_DE_LEITURA if lidos],
)
def test_rota_de_leitura_passa_por_porta_de_escopo(arquivo: str, funcao: str):
    """Rota GET que alcanca linha nominal aplica escopo — ou esta em DISPENSAS."""
    lidos, portas = next(
        (lidos, portas)
        for a, f, lidos, portas in ROTAS_DE_LEITURA
        if a == arquivo and f == funcao
    )
    chave = f"{arquivo}:{funcao}"
    if chave in DISPENSAS:
        # Passa, e nao pula: `skip` some do resumo da suite e dispensa que ninguem
        # ve e permissao esquecida. O que sustenta a dispensa e a frase — sem ela
        # a entrada e so um jeito de calar a varredura.
        assert len(DISPENSAS[chave]) > 60, (
            f"{chave} esta dispensada sem argumento que se possa conferir depois"
        )
        return
    assert portas, (
        f"{chave} le {sorted(lidos)} e nao passa por porta de escopo nenhuma. "
        f"Aplique `aplicar_escopo` (ou uma de {sorted(PORTAS_DE_ESCOPO)}), ou "
        "declare a dispensa em DISPENSAS com o motivo por escrito."
    )


def test_nao_ha_dispensa_obsoleta():
    """Dispensa que sobreviveu ao conserto vira permissao esquecida."""
    vivas = {
        f"{a}:{f}" for a, f, lidos, portas in ROTAS_DE_LEITURA if lidos and not portas
    }
    sobrando = sorted(set(DISPENSAS) - vivas)
    assert not sobrando, (
        "estas rotas ja aplicam escopo (ou sumiram) e a dispensa continua "
        f"escrita: {sobrando}"
    )


# =====================================================================
# A sonda — a varredura precisa conseguir falhar
# =====================================================================
_PORTA_ABERTA = '''
from fastapi import APIRouter
rotas = APIRouter()

def _requisicao(s, requisicao_id):
    return s.get(EpiRequisicao, requisicao_id)

@rotas.get("/epis/requisicoes/{requisicao_id}")
def ficha(s, usuario, requisicao_id: int):
    usuario.exigir("epi.ver")
    return _requisicao(s, requisicao_id)
'''

_PORTA_FECHADA = '''
from fastapi import APIRouter
rotas = APIRouter()

def _requisicao(s, usuario, requisicao_id):
    return servico.no_escopo(s, usuario, requisicao_id)

@rotas.get("/epis/requisicoes/{requisicao_id}")
def ficha(s, usuario, requisicao_id: int):
    usuario.exigir("epi.ver")
    return _requisicao(s, usuario, requisicao_id)
'''


def _analisar_fonte(fonte: str) -> tuple[set[str], set[str]]:
    arvore = ast.parse(fonte)
    mapa = _funcoes_do_modulo(arvore)
    return analisar_rota(mapa["ficha"], mapa)


def test_a_varredura_pega_a_rota_sem_escopo():
    """A porta falsa e a rota de antes, ao pe da letra — inclusive o helper.

    Sem isto, um erro na montagem (decorador com outro nome, modelo renomeado,
    expansao de chamada quebrada) faria a varredura passar por vazio, que e
    exatamente o silencio que este arquivo existe para nao produzir.
    """
    lidos, portas = _analisar_fonte(_PORTA_ABERTA)
    assert lidos == {"s.get(EpiRequisicao)"}, (
        "a varredura nao enxergou a leitura escondida no helper — ela deixou de medir"
    )
    assert not portas, "a varredura achou porta onde nao ha"


def test_a_varredura_absolve_a_rota_com_escopo():
    """O outro lado: varredura que reprova tudo tambem nao mede nada."""
    _, portas = _analisar_fonte(_PORTA_FECHADA)
    assert portas == {"no_escopo"}


# =====================================================================
# A porta tem de ser porta
# =====================================================================
# A varredura conta pelo NOME da funcao chamada. Sem isto, esvaziar uma das
# portas — tirar `aplicar_escopo` de dentro de `epi_requisicao.fila`, por
# exemplo — devolveria o vazamento com a varredura passando: o nome continuaria
# ali. Cada porta declarada acima e conferida no codigo dela, e as tres que NAO
# usam `aplicar_escopo` estao nomeadas com o motivo.
PORTAS_SEM_APLICAR_ESCOPO = {
    "turma.inscricoes_do_titular": (
        "Prende `participante.servidor_id` ao da conta, que e MAIS estreito que "
        "qualquer escopo de perfil — gemea de "
        "`emissao_certificado.consulta_do_titular`, e pelo mesmo motivo: a tela e "
        "'o que e meu' e nao pode alargar quando o perfil alargar."
    ),
    "pendencias.no_escopo": (
        "`Pendencia` nao tem `servidor_id`: `aplicar_escopo` devolveria "
        "`where(False)` com o aviso de modelo mal escolhido. A ancora de dono da "
        "pendencia e `responsavel_id`."
    ),
    "epi_ficha.exigir_leitura_da_ficha": (
        "Decide pela relacao titular/terceiro e levanta em vez de filtrar — e o "
        "modelo que `auditoria.registrar_leitura_nominal` copiou."
    ),
    "emissao_certificado.exigir_leitura_do_certificado": (
        "Gemea de `epi_ficha.exigir_leitura_da_ficha`: decide pela relacao "
        "titular/terceiro e levanta em vez de filtrar. Quem filtra a linha "
        "continua sendo `no_escopo`, que a rota chama antes dela."
    ),
    "emissao_certificado.consulta_do_titular": (
        "Prende `servidor_id` ao da conta, que e MAIS estreito que qualquer "
        "escopo de perfil — `aplicar_escopo` sobre o mesmo modelo devolveria o "
        "campus inteiro para um perfil de unidade. A tela e 'o que e meu', e "
        "ela nao pode alargar quando o perfil alargar."
    ),
    "anexo_acesso.autorizar": (
        "Resolve o dono do anexo e delega a regra dele; quem aplica escopo e o "
        "resolvedor (`_dono_parecer` chama `parecer.no_escopo`)."
    ),
    "anexo_acesso.liberar": "Autoriza por `autorizar` e registra a leitura.",
}

PORTAS_NO_CODIGO = [
    ("app.servicos.rbac", "aplicar_escopo"),
    ("app.repositorios.processos", "por_id"),
    ("app.servicos.parecer", "no_escopo"),
    ("app.servicos.epi_requisicao", "no_escopo"),
    ("app.servicos.epi_requisicao", "fila"),
    ("app.servicos.turma", "no_escopo"),
    ("app.servicos.turma", "consulta_no_escopo"),
    ("app.servicos.turma", "inscricoes_do_titular"),
    ("app.servicos.emissao_certificado", "no_escopo"),
    ("app.servicos.emissao_certificado", "exigir_leitura_do_certificado"),
    ("app.servicos.emissao_certificado", "consulta_do_titular"),
    ("app.servicos.pendencias", "no_escopo"),
    ("app.servicos.pendencias", "abertas"),
    ("app.servicos.pendencias", "contar_abertas"),
    ("app.servicos.epi_ficha", "exigir_leitura_da_ficha"),
    ("app.servicos.anexo_acesso", "autorizar"),
    ("app.servicos.anexo_acesso", "liberar"),
    ("app.rotas.servidores", "_servidor_no_escopo"),
]


@pytest.mark.parametrize(
    "modulo,funcao", PORTAS_NO_CODIGO, ids=[f"{m.split('.')[-1]}.{f}" for m, f in PORTAS_NO_CODIGO]
)
def test_porta_declarada_realmente_escopa(modulo: str, funcao: str):
    import importlib

    mod = importlib.import_module(modulo)
    fonte = inspect.getsource(getattr(mod, funcao))
    chave = f"{modulo.split('.')[-1]}.{funcao}"
    if "aplicar_escopo" in fonte:
        return
    delega = any(
        f"{porta}(" in fonte or f".{porta}(" in fonte
        for porta in PORTAS_DE_ESCOPO
        if porta != funcao.lstrip("_")
    ) or "_no_escopo(" in fonte
    assert delega or chave in PORTAS_SEM_APLICAR_ESCOPO, (
        f"{chave} esta declarada como porta de escopo e nao aplica escopo nem "
        "delega para quem aplique — a varredura passaria a contar um nome vazio."
    )
