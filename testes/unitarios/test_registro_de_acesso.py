"""Quarta camada: rota que abre o registro de UMA pessoa deixa linha do art. 37.

Irma de `test_repositorios.py`, e pelo mesmo motivo. La a pergunta e "quem
alcanca a linha"; aqui e "ficou escrito que alguem a leu". As duas nascem do
mesmo achado (`entrada/servidor/03_PRIVACIDADE.md`, G-3) e a ordem entre elas foi
argumentada na 1.35.0: o registro vem ANTES do escopo, porque fechar o escopo
primeiro apagaria a chance de saber o que ja foi lido.

**Este defeito nasce por omissao.** Nada quebra, nenhuma tela muda, nenhum teste
fica vermelho: a rota nova simplesmente nao grava, e a falta so aparece no dia em
que alguem pergunta quem leu a ficha de quantas pessoas — que e o dia em que nao
da mais para responder. Foi assim que as rotas de EPI ficaram tres fatias sem
registro nenhum enquanto tres modulos ao lado ja registravam. Silencio que se le
como "esta tudo certo" e o modo de falha que esta pasta existe para nao produzir.

**A distincao que governa, e que a varredura nao pode atropelar.**

*Lista nao registra.* `/servidores`, `/processos`, a fila de EPI e as buscas por
HTMX mostram identificacao ja suprimida pela RN-19, e uma linha por pessoa por
abertura de tela afogaria exatamente o sinal que a tabela existe para dar — e o
custo seria pago com o lock de escrita na mao, numa tela quente. A busca global
usou esse mesmo argumento e ele continua valendo.

*Ler o registro de UMA pessoa identificada grava.* E o que sustenta a
investigacao do art. 37: quem abriu a ficha de quantas pessoas.

A varredura separa as duas pela URL, que e o unico criterio mecanico honesto: a
rota cujo caminho tem `{...}` nomeia UMA linha; a que nao tem e lista. Nenhuma
rota de lista chega a ser examinada aqui, e essa exclusao E a decisao acima,
escrita de forma que o proximo leitor a encontre.

**Como ela sabe que a rota alcanca pessoa.** Dois sinais, e o segundo e o que
amarra as duas varreduras uma na outra: ou a rota le um modelo nominal direto
(`s.get(Modelo)` / `select(Modelo)`), ou ela passa por uma porta de escopo POR
LINHA — e passar por uma dessas portas significa, por definicao, que uma linha de
uma pessoa determinada foi resolvida. Quem fechar o escopo de uma rota nova cai
automaticamente sob esta varredura, que e o oposto de precisar lembrar das duas.

**Ate onde ela alcanca.** Como a irma, ela nao segue o grafo para dentro de
`app/servicos/`: uma gravacao encontrada em qualquer galho absolveria a rota
inteira, e absolvicao facil e pior que cobertura curta. O servico entra por outro
lado, mais duro — `test_porta_declarada_realmente_registra` abre o codigo de cada
porta declarada e exige que ela grave de verdade.
"""

from __future__ import annotations

import ast
import importlib
import inspect

import pytest

from app.config import RAIZ

DIR_ROTAS = RAIZ / "app" / "rotas"

# As mesmas tabelas de `test_repositorios.MODELOS_NOMINAIS`, e a copia e
# deliberada: as duas varreduras respondem perguntas diferentes sobre o mesmo
# conjunto, e importar a lista de la amarraria uma na coleta da outra.
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

# Portas de escopo que resolvem UMA linha. Sao o segundo sinal de que a rota
# chegou a uma pessoa determinada. As portas de LISTA de `test_repositorios`
# (`fila`, `abertas`, `consulta_no_escopo`, `consulta_do_titular`,
# `inscricoes_do_titular`) ficam de fora de proposito: elas devolvem conjunto, e
# conjunto e o caso que nao registra.
PORTAS_POR_LINHA = {
    "no_escopo",
    "por_id",
    "servidor_no_escopo",
    "exigir_leitura_da_ficha",
    "exigir_leitura_do_certificado",
}

# As portas de REGISTRO. Cada nome e uma funcao que grava (ou decide e grava) a
# leitura nominal, e cada uma e conferida no codigo dela mais abaixo — sem isso a
# varredura contaria um nome vazio, e esvaziar `anexo_acesso.liberar` devolveria
# a omissao com o teste passando.
PORTAS_DE_REGISTRO = {
    "registrar_leitura_nominal",
    "liberar",
    "imprimir",
    "segunda_via",
}

# Rota que abre o registro de uma pessoa e NAO grava, e por que. Cada linha e uma
# decisao, nao uma isencao: quem tirar a gravacao de uma rota tem de vir aqui
# escrever a frase que a defende. A frase e conferida por tamanho porque dispensa
# sem argumento e so um jeito de calar a varredura.
DISPENSAS: dict[str, str] = {
    "epi_fichas.py:ir_para_a_ficha": (
        "Redirecionamento 303 para `/epis/fichas/{servidor_id}`, que grava. A rota "
        "existe so para a ancora da pendencia ter destino e nao renderiza campo "
        "nominal nenhum; gravar aqui produziria DUAS linhas para uma leitura, e "
        "contagem dobrada e pior que contagem nenhuma numa investigacao."
    ),
    "pareceres.py:novo": (
        "GET que cria o rascunho sob `parecer.criar` e redireciona para "
        "`/pareceres/{id}`, que grava. O contexto nominal que ela carrega e o do "
        "processo, e `/processos/{id}` — a unica porta por onde se chega ao botao "
        "— ja gravou. O ato de criar fica na trilha (`PARECER_RASCUNHO_CRIADO`)."
    ),
    "laudos.py:ficha": (
        "O laudo e do POSTO, nao da pessoa. Os pareceres lidos aqui sao a "
        "contagem de reuso que justifica reavaliar o laudo, e a tela nao abre "
        "nenhum deles; `laudo.ver` fica fora de perfil de escopo proprio. Mesma "
        "razao pela qual esta rota ja e dispensa da varredura de escopo."
    ),
    "api.py:grade": (
        "A grade de presenca em JSON e a mesma lista de chamada da aba de "
        "presencas de `turmas.py:ficha`: nomeia a turma INTEIRA sob "
        "`turma.avaliar`, e nao ha 'sobre quem' unico para a coluna "
        "`servidor_id` — e lista, e lista nao registra (decisao da 1.37.0). O "
        "lancamento de cada dia fica na trilha por inscrito, pelo servico."
    ),
    "turmas.py:ficha": (
        "Uma turma nao e dado pessoal de ninguem — e cartaz: codigo, curso, "
        "periodo, vagas (decisao da 1.37.0). O que tem titular e a INSCRICAO, e "
        "as abas nominais so carregam sob `certificado.ver`, uma por participante: "
        "e lista, e lista nao registra."
    ),
    "turmas.py:baixar_lista_presenca": (
        "A folha que circula em campo para assinar e nominal por definicao e "
        "nomeia a turma INTEIRA — nao ha 'sobre quem' unico para a coluna "
        "`servidor_id`, e uma linha por participante por impressao afogaria o "
        "sinal. Quantas folhas sairam e de qual turma fica na trilha, em "
        "`LISTA_PRESENCA_GERADA`."
    ),
}


# =====================================================================
# A coleta
# =====================================================================
def _funcoes_do_modulo(arvore: ast.Module) -> dict[str, ast.FunctionDef]:
    return {
        no.name: no
        for no in arvore.body
        if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _caminhos_get(no: ast.FunctionDef) -> list[str]:
    """As URLs de `@rotas.get(...)`, como texto do proprio decorador.

    O texto, e nao o valor: o caminho quase sempre e `FILA + '/{id}'`, e resolver
    a constante exigiria importar o modulo. Para a unica pergunta que se faz dele
    — ha parametro de caminho? — o texto responde igual.
    """
    urls: list[str] = []
    for decorador in no.decorator_list:
        if not isinstance(decorador, ast.Call):
            continue
        alvo = decorador.func
        if isinstance(alvo, ast.Attribute) and alvo.attr == "get":
            urls.extend(ast.unparse(arg) for arg in decorador.args)
    return urls


def _nome_chamado(chamada: ast.Call) -> str:
    alvo = chamada.func
    if isinstance(alvo, ast.Attribute):
        return alvo.attr.lstrip("_")
    if isinstance(alvo, ast.Name):
        return alvo.id.lstrip("_")
    return ""


def _alcances_nominais(no: ast.FunctionDef) -> set[str]:
    """O que prova que esta funcao chegou a linha de uma pessoa."""
    achados: set[str] = set()
    for filho in ast.walk(no):
        if not isinstance(filho, ast.Call):
            continue
        nome = _nome_chamado(filho)
        if nome in PORTAS_POR_LINHA:
            achados.add(f"porta:{nome}")
        if not filho.args:
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
    nomes: set[str] = set()
    simples: set[str] = set()
    for filho in ast.walk(no):
        if not isinstance(filho, ast.Call):
            continue
        nomes.add(_nome_chamado(filho))
        if isinstance(filho.func, ast.Name):
            simples.add(filho.func.id)
    return nomes, simples


def analisar_rota(
    no: ast.FunctionDef,
    mapa: dict[str, ast.FunctionDef],
    vistos: set[str] | None = None,
) -> tuple[set[str], set[str]]:
    """(o que prova alcance a pessoa, as portas de registro), seguindo os helpers.

    Segue a chamada dentro do modulo pelo motivo que a varredura irma ja pagou: o
    `s.get` mora num `_requisicao` e a gravacao mora num `_exigir_parecer`. Olhar
    so o corpo da rota deixaria os dois lados invisiveis.
    """
    vistos = set() if vistos is None else vistos
    if no.name in vistos:
        return set(), set()
    vistos.add(no.name)
    alcances = _alcances_nominais(no)
    nomes, simples = _chamadas(no)
    portas = nomes & PORTAS_DE_REGISTRO
    for nome in simples:
        interno = mapa.get(nome)
        if interno is not None:
            mais_alcances, mais_portas = analisar_rota(interno, mapa, vistos)
            alcances |= mais_alcances
            portas |= mais_portas
    return alcances, portas


def _rotas_de_pessoa() -> list[tuple[str, str, set[str], set[str]]]:
    achados = []
    for caminho in sorted(DIR_ROTAS.glob("*.py")):
        if caminho.name == "__init__.py":
            continue
        arvore = ast.parse(caminho.read_text(encoding="utf-8"))
        mapa = _funcoes_do_modulo(arvore)
        for nome, no in mapa.items():
            urls = _caminhos_get(no)
            if not urls or not any("{" in url for url in urls):
                continue
            alcances, portas = analisar_rota(no, mapa)
            if not alcances:
                continue
            achados.append((caminho.name, nome, alcances, portas))
    return achados


ROTAS_DE_PESSOA = _rotas_de_pessoa()


def test_a_coleta_acha_rota_de_pessoa():
    """Sonda de coleta: varredura que nao acha nada nao mede nada."""
    assert len(ROTAS_DE_PESSOA) >= 15, (
        f"so {len(ROTAS_DE_PESSOA)} rotas por id alcancam pessoa — a coleta "
        "quebrou (nome de decorador, pasta, modelo ou porta de escopo mudou)"
    )


@pytest.mark.parametrize(
    "arquivo,funcao",
    [(a, f) for a, f, _, _ in ROTAS_DE_PESSOA],
    ids=[f"{a}:{f}" for a, f, _, _ in ROTAS_DE_PESSOA],
)
def test_rota_de_pessoa_registra_a_leitura(arquivo: str, funcao: str):
    """GET que abre o registro de uma pessoa grava — ou consta de DISPENSAS."""
    alcances, portas = next(
        (alcances, portas)
        for a, f, alcances, portas in ROTAS_DE_PESSOA
        if a == arquivo and f == funcao
    )
    chave = f"{arquivo}:{funcao}"
    if chave in DISPENSAS:
        # Passa, e nao pula, pela razao da varredura irma: `skip` some do resumo
        # e dispensa que ninguem ve e permissao esquecida.
        assert len(DISPENSAS[chave]) > 60, (
            f"{chave} esta dispensada sem argumento que se possa conferir depois"
        )
        return
    assert portas, (
        f"{chave} alcanca {sorted(alcances)} e nao grava leitura nominal nenhuma. "
        f"Chame `auditoria.registrar_leitura_nominal` (ou uma de "
        f"{sorted(PORTAS_DE_REGISTRO)}) dizendo o `campo` e a `finalidade`, ou "
        "declare a dispensa em DISPENSAS com o motivo por escrito."
    )


def test_nao_ha_dispensa_obsoleta():
    """Dispensa que sobreviveu ao conserto vira permissao esquecida."""
    vivas = {
        f"{a}:{f}" for a, f, alcances, portas in ROTAS_DE_PESSOA if alcances and not portas
    }
    sobrando = sorted(set(DISPENSAS) - vivas)
    assert not sobrando, (
        f"estas rotas ja gravam (ou sumiram) e a dispensa continua escrita: {sobrando}"
    )


# =====================================================================
# A sonda — a varredura precisa conseguir falhar
# =====================================================================
# A rota de EPI como ela estava ate esta versao, ao pe da letra: escopo fechado
# desde a 1.35.0, leitura nominal de uma pessoa determinada, e nenhuma linha em
# `acesso_dado_sensivel`. E o defeito que esta varredura existe para pegar, e
# escrever a versao antiga aqui e o que prova que ela o pega.
_SEM_REGISTRO = '''
from fastapi import APIRouter
rotas = APIRouter()

def _requisicao(s, usuario, requisicao_id):
    return servico.no_escopo(s, usuario, requisicao_id)

@rotas.get(FILA + "/{requisicao_id}")
def ficha(request, s, usuario, requisicao_id: int):
    usuario.exigir("epi.ver")
    requisicao = _requisicao(s, usuario, requisicao_id)
    return _tela_ficha(request, s, usuario, requisicao)
'''

_COM_REGISTRO = '''
from fastapi import APIRouter
rotas = APIRouter()

def _requisicao(s, usuario, requisicao_id):
    return servico.no_escopo(s, usuario, requisicao_id)

@rotas.get(FILA + "/{requisicao_id}")
def ficha(request, s, usuario, requisicao_id: int):
    usuario.exigir("epi.ver")
    requisicao = _requisicao(s, usuario, requisicao_id)
    if auditoria.registrar_leitura_nominal(
        s, usuario, campo="epi_requisicao.nominal", servidor_id=requisicao.servidor_id
    ):
        s.commit()
    return _tela_ficha(request, s, usuario, requisicao)
'''

# A fila: mesma leitura, sem parametro de caminho. A varredura NAO pode cobrar
# registro dela — e a metade da regra que uma varredura zelosa demais quebraria,
# enchendo `acesso_dado_sensivel` de uma linha por pessoa por abertura de tela.
_LISTA = '''
from fastapi import APIRouter
rotas = APIRouter()

@rotas.get(FILA)
def fila(request, s, usuario, q: str = ""):
    usuario.exigir("epi.ver")
    linhas = servico.fila(s, usuario)
    return pagina(request, "paginas/epis_requisicoes.html", linhas=linhas)
'''


def _analisar_fonte(fonte: str, funcao: str = "ficha") -> tuple[set[str], set[str]]:
    arvore = ast.parse(fonte)
    mapa = _funcoes_do_modulo(arvore)
    return analisar_rota(mapa[funcao], mapa)


def test_a_varredura_pega_a_rota_que_nao_registra():
    alcances, portas = _analisar_fonte(_SEM_REGISTRO)
    assert alcances == {"porta:no_escopo"}, (
        "a varredura nao viu que a rota resolve a linha de uma pessoa — "
        "ela deixou de medir"
    )
    assert not portas, "a varredura achou gravacao onde nao ha"


def test_a_varredura_absolve_a_rota_que_registra():
    """O outro lado: varredura que reprova tudo tambem nao mede nada."""
    _, portas = _analisar_fonte(_COM_REGISTRO)
    assert portas == {"registrar_leitura_nominal"}


def test_a_varredura_nao_cobra_registro_da_lista():
    """A fila le as mesmas linhas e nao entra na coleta: lista nao registra."""
    fonte = _LISTA
    arvore = ast.parse(fonte)
    mapa = _funcoes_do_modulo(arvore)
    urls = _caminhos_get(mapa["fila"])
    assert urls and not any("{" in url for url in urls)


# =====================================================================
# A porta tem de ser porta
# =====================================================================
# A varredura conta pelo NOME da funcao chamada. Sem isto, esvaziar uma delas —
# tirar `registrar_leitura_nominal` de dentro de `anexo_acesso.liberar`, por
# exemplo — devolveria a omissao com a varredura passando: o nome continuaria la.
PORTAS_NO_CODIGO = [
    ("app.servicos.auditoria", "registrar_leitura_nominal"),
    ("app.servicos.anexo_acesso", "liberar"),
    ("app.servicos.anexo_acesso", "registrar_leitura"),
    ("app.servicos.epi_ficha", "imprimir"),
    ("app.servicos.emissao_certificado", "segunda_via"),
]

# Quem nao chama a gravacao no proprio corpo delega para quem chama, e o nome de
# quem esta escrito aqui — de novo, uma frase conferivel e nao uma isencao.
GRAVA_POR_DELEGACAO = {
    "auditoria.registrar_leitura_nominal": (
        "E a propria decisao: chama `leitura_de_terceiro` e so entao "
        "`registrar_acesso_sensivel`, que e a unica escrita em "
        "`acesso_dado_sensivel` do sistema."
    ),
    "anexo_acesso.liberar": (
        "Autoriza por `autorizar` e grava por `registrar_leitura`, nesta ordem e "
        "numa chamada so — separa-las devolveria a chance de fazer a primeira e "
        "esquecer a segunda."
    ),
}


@pytest.mark.parametrize(
    "modulo,funcao",
    PORTAS_NO_CODIGO,
    ids=[f"{m.split('.')[-1]}.{f}" for m, f in PORTAS_NO_CODIGO],
)
def test_porta_declarada_realmente_registra(modulo: str, funcao: str):
    mod = importlib.import_module(modulo)
    fonte = inspect.getsource(getattr(mod, funcao))
    chave = f"{modulo.split('.')[-1]}.{funcao}"
    if "registrar_leitura_nominal" in fonte or "registrar_acesso_sensivel" in fonte:
        return
    delega = any(
        f"{porta}(" in fonte or f".{porta}(" in fonte
        for porta in PORTAS_DE_REGISTRO
        if porta != funcao.lstrip("_")
    ) or "registrar_leitura(" in fonte
    assert delega and chave in GRAVA_POR_DELEGACAO, (
        f"{chave} esta declarada como porta de registro e nao grava nem delega "
        "para quem grave — a varredura passaria a contar um nome vazio."
    )


def test_toda_gravacao_de_acesso_passa_pela_decisao():
    """`registrar_acesso_sensivel` cru, fora de `auditoria`, e uma segunda regra.

    Foi essa a divergencia desta versao: cinco pontos gravavam, quatro perguntavam
    "e de outro?" com tres redacoes diferentes e um nao perguntava nada — quem
    tirasse a via do proprio comprovante entrava na tabela como suspeito do art.
    37. Chamada nova direta a `registrar_acesso_sensivel` recria a divergencia,
    entao ela para aqui.
    """
    fora: list[str] = []
    for pasta in ("rotas", "servicos", "repositorios"):
        for caminho in sorted((RAIZ / "app" / pasta).glob("*.py")):
            if caminho.name == "auditoria.py":
                continue
            texto = caminho.read_text(encoding="utf-8")
            for numero, linha in enumerate(texto.splitlines(), start=1):
                if "registrar_acesso_sensivel(" in linha and not linha.lstrip().startswith("#"):
                    fora.append(f"{pasta}/{caminho.name}:{numero}")
    assert not fora, (
        "estes pontos gravam `acesso_dado_sensivel` sem passar por "
        f"`auditoria.registrar_leitura_nominal`: {fora}. A pergunta 'a leitura e "
        "de outra pessoa?' tem UMA resposta no sistema (LGPD art. 18, II versus "
        "art. 37), e ela mora em `auditoria.leitura_de_terceiro`."
    )
