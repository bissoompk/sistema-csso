"""Q-2 — abrir `/auditoria` não pode custar a trilha inteira, nem segurar o lock.

Quarta ocorrência do mesmo defeito no repositório, e as três anteriores estão no
`CHANGELOG.md` e no arquivo irmão `test_concorrencia_emissao.py`: o sino da
1.22.1, o `PRAGMA wal_checkpoint(TRUNCATE)` do EXPORTAR-TUDO na 1.22.2 e a
conversão de PDF da 1.32.0. Aqui a operação lenta não é uma segunda conexão, nem
um PRAGMA, nem o LibreOffice — é o próprio sistema recalculando um SHA-256 por
evento da tabela `historico_evento`, do primeiro ao último, a cada abertura da
tela, com o lock de escrita do SQLite na mão desde o SELECT do cookie (RN-03).

**O que torna este defeito diferente dos três anteriores.** Ele não tem um
tamanho: ele tem uma inclinação. Medido no levantamento, ~55 µs por evento —
43 ms com 1.292 eventos, 1.147 ms com 25.292, 2.743 ms com 50.292. Hoje, com o
banco do setor, abrir `/auditoria` é instantâneo e nada disso aparece; aos
~90 mil eventos a conferência passa dos 5 s de `busy_timeout` e uma única
abertura da tela derruba a de todos os outros. A importação do Trello e da
planilha gravou 7.634 eventos de uma vez.

**Por isso a asserção principal deste arquivo é sobre a CONTAGEM de digests, e
não sobre o relógio.** Um teste de tempo mediria esta máquina neste dia; o que
se quer fixar é a forma da conta: o custo de abrir a tela é o da janela exibida,
e não o da tabela. Dobrar a trilha não pode dobrar nada. É a mesma diferença
entre "está rápido" e "não cresce".

A sonda de lock — a conexão `sqlite3` crua que é a outra pessoa — é a mesma de
`test_concorrencia_emissao.py`, pelo mesmo motivo: o que se quer medir é se o
lock de escrita está disponível para quem não é esta requisição.
"""

from __future__ import annotations

import ast
import concurrent.futures
import sqlite3
import threading
import time
from pathlib import Path

import pytest
from sqlalchemy import func, select, text

from app import banco as mod_banco
from app.config import RAIZ
from app.modelos import ConferenciaCadeia, HistoricoEvento
from app.rotas.auditoria import POR_PAGINA
from app.servicos import auditoria
from testes.integracao.conftest import entrar

# O passe simulado, e a paciência de quem espera por ele — a mesma relação de
# `test_concorrencia_emissao.py`: quem espera desiste antes de o passe acabar.
PASSE_S = 1.2
PACIENCIA_S = 0.3


def _caminho_do_banco() -> str:
    """O arquivo que o engine está usando AGORA (ver `test_concorrencia_emissao`)."""
    return str(mod_banco.obter_engine().url.database)


def _outra_pessoa_consegue_escrever(paciencia: float = PACIENCIA_S) -> bool:
    """Uma segunda pessoa tenta abrir transação de escrita, e desiste rápido."""
    con = sqlite3.connect(_caminho_do_banco(), timeout=0, isolation_level=None)
    try:
        con.execute(f"PRAGMA busy_timeout={int(paciencia * 1000)}")
        try:
            con.execute("BEGIN IMMEDIATE")
            con.execute("COMMIT")
            return True
        except sqlite3.OperationalError as erro:
            assert "locked" in str(erro) or "busy" in str(erro), erro
            return False
    finally:
        con.close()


# ---------------------------------------------------------------------
# Instrumentos
# ---------------------------------------------------------------------
class DigestContado:
    """`_digerir` de verdade, com um contador em volta.

    É o instrumento da asserção que interessa: quantos SHA-256 a abertura da tela
    manda calcular. Envolve o original em vez de substituí-lo porque a conta tem
    de continuar sendo a conta — um digest de mentira responderia "a cadeia
    fecha" sobre qualquer coisa e o teste passaria por não medir nada.
    """

    def __init__(self, original):
        self.original = original
        self.chamadas = 0

    def __call__(self, evento, anterior):
        self.chamadas += 1
        return self.original(evento, anterior)


class DigestLento(DigestContado):
    """O mesmo, com uma demora na primeira chamada.

    `entrou` é o que dá ao teste um ponto de observação DENTRO do passe — sem ele
    a medição do lock cairia antes ou depois, que é quando ele está livre dos
    dois lados e a medição não diria nada.
    """

    def __init__(self, original, segundos: float = PASSE_S):
        super().__init__(original)
        self.segundos = segundos
        self.entrou = threading.Event()

    def __call__(self, evento, anterior):
        primeira = self.chamadas == 0
        resultado = super().__call__(evento, anterior)
        if primeira:
            self.entrou.set()
            time.sleep(self.segundos)
        return resultado


def _contar_digests(monkeypatch) -> DigestContado:
    contador = DigestContado(auditoria._digerir)
    monkeypatch.setattr(auditoria, "_digerir", contador)
    return contador


def _encher_a_trilha(s, quantos: int) -> None:
    """Eventos de verdade, pela porta de `registrar` — a cadeia tem de fechar."""
    for numero in range(quantos):
        auditoria.registrar(
            s,
            entidade="servidor",
            entidade_id=1,
            tipo_evento="CAMPO_ALTERADO",
            descricao=f"evento de carga {numero}",
            campo="siape",
            valor_anterior=f"{numero}",
            valor_novo=f"{numero + 1}",
        )
    s.commit()


def _adulterar(evento_id: int, descricao: str) -> None:
    """Reescreve um evento por fora do sistema, como quem tem o arquivo na mão.

    A trilha recusa `UPDATE` por trigger de banco (CA-16), e é isso que a torna
    prova. Mas a trigger protege quem passa PELO sistema; quem tem o `.db` no
    disco derruba a trigger em uma linha — e é exatamente essa pessoa que o
    encadeamento de hashes existe para pegar. Derrubar e recriar a trava aqui não
    é burlar o teste: é encenar a única forma de adulteração que sobra.

    Quem chama tem de estar com toda sessão da aplicação FECHADA. Não é
    fragilidade do instrumento: é o defeito Q-2 visto do outro lado — uma sessão
    aberta segura o lock de escrita desde o primeiro SELECT (`BEGIN IMMEDIATE`,
    RN-03), e é ela que faz este `DROP TRIGGER` esperar o `busy_timeout` inteiro
    e terminar em "database is locked".
    """
    con = sqlite3.connect(_caminho_do_banco(), isolation_level=None)
    try:
        con.execute("DROP TRIGGER IF EXISTS trg_historico_sem_update")
        con.execute(
            "UPDATE historico_evento SET descricao=? WHERE id=?", (descricao, evento_id)
        )
    finally:
        con.close()
    mod_banco.aplicar_triggers()


# ---------------------------------------------------------------------
# O custo de abrir a tela não cresce com a trilha
# ---------------------------------------------------------------------
@pytest.mark.parametrize("eventos", [POR_PAGINA * 2, POR_PAGINA * 5])
def test_abrir_a_trilha_confere_a_janela_e_nao_a_tabela(
    app_cliente, contas, banco, monkeypatch, eventos
):
    """A asserção central do arquivo: o custo é o da página, não o da tabela.

    Antes da correção, `cadeia_integra` era chamada na linha 39 da rota e
    percorria `historico_evento` inteira — com 500 eventos seriam 500 digests
    para exibir 100. Os dois tamanhos do parametrize existem para que a asserção
    não possa ser satisfeita por acaso: se o custo voltar a acompanhar a tabela,
    o segundo caso pede 2,5× o primeiro e o teto de `POR_PAGINA` derruba os dois.
    """
    with mod_banco.sessao() as s:
        _encher_a_trilha(s, eventos)
        total = s.execute(select(func.count(HistoricoEvento.id))).scalar_one()
    assert total >= eventos

    entrar(app_cliente, contas, "auditor_interno")
    contador = _contar_digests(monkeypatch)
    resposta = app_cliente.get("/auditoria")

    assert resposta.status_code == 200, resposta.text
    assert contador.chamadas <= POR_PAGINA, (
        f"abrir /auditoria recalculou {contador.chamadas} digests para exibir "
        f"{POR_PAGINA} eventos, com {total} na trilha — a conferência voltou a "
        "percorrer a tabela inteira dentro da requisição (Q-2)"
    )
    assert "desta página conferem" in resposta.text


def test_a_janela_confere_tambem_com_filtro(app_cliente, contas, banco, monkeypatch):
    """Com filtro, os eventos exibidos não são vizinhos na cadeia.

    É o caso em que uma conferência ingênua da janela — comparar cada evento com
    o anterior DA LISTA — acusaria adulteração em toda tela filtrada. Cada evento
    é ancorado no seu antecessor real na tabela, e por isso a tela filtrada
    continua respondendo "confere".
    """
    with mod_banco.sessao() as s:
        for numero in range(30):
            auditoria.registrar(
                s,
                entidade="servidor" if numero % 2 else "processo",
                entidade_id=1,
                tipo_evento="CAMPO_ALTERADO",
                descricao=f"alternado {numero}",
            )
        s.commit()

    entrar(app_cliente, contas, "auditor_interno")
    contador = _contar_digests(monkeypatch)
    resposta = app_cliente.get("/auditoria?entidade=processo")

    assert resposta.status_code == 200, resposta.text
    assert "desta página conferem" in resposta.text
    assert "cadeia rompida" not in resposta.text
    assert 0 < contador.chamadas <= POR_PAGINA


def test_a_janela_acusa_o_evento_adulterado_que_ela_exibe(app_cliente, contas, banco):
    """Barato não pode significar cego: o que a tela mostra, ela confere."""
    with mod_banco.sessao() as s:
        _encher_a_trilha(s, 10)
        alvo = s.execute(
            select(func.max(HistoricoEvento.id))
        ).scalar_one()

    _adulterar(alvo, "reescrito por fora do sistema")

    entrar(app_cliente, contas, "auditor_interno")
    resposta = app_cliente.get("/auditoria")

    assert resposta.status_code == 200, resposta.text
    assert f"cadeia rompida no evento {alvo}" in resposta.text


def test_a_janela_acusa_o_elo_trocado_e_nao_so_o_corpo(banco):
    """A segunda pergunta da janela, a que a âncora existe para fazer.

    Aqui o evento adulterado NÃO aparece na janela: o que a tela exibe é só o
    evento seguinte. Reescrever uma linha e refazer o digest dela junto a deixa
    coerente consigo mesma, e uma conferência que apenas refizesse o digest de
    cada linha exibida não veria nada. O que denuncia é o elo — o `hash_anterior`
    do seguinte deixa de bater com o `hash_atual` de quem está mesmo atrás dele,
    e é isso que a âncora vai buscar na tabela.
    """
    with mod_banco.sessao() as s:
        _encher_a_trilha(s, 6)
        ids = list(
            s.execute(select(HistoricoEvento.id).order_by(HistoricoEvento.id)).scalars()
        )
    alvo, seguinte = ids[2], ids[3]

    # o corpo muda e o digest é refeito junto: a linha fecha consigo mesma
    con = sqlite3.connect(_caminho_do_banco(), isolation_level=None)
    try:
        con.execute("DROP TRIGGER IF EXISTS trg_historico_sem_update")
        con.execute(
            "UPDATE historico_evento SET descricao=?, hash_atual=? WHERE id=?",
            ("reescrito com digest novo", "0" * 64, alvo),
        )
    finally:
        con.close()
    mod_banco.aplicar_triggers()

    with mod_banco.sessao() as s:
        so_o_seguinte = list(
            s.execute(
                select(HistoricoEvento).where(HistoricoEvento.id == seguinte)
            ).scalars()
        )
        integra, defeito = auditoria.janela_integra(s, so_o_seguinte)

    assert not integra, (
        "a janela conferiu um evento cujo elo aponta para um antecessor "
        "reescrito e não viu nada — a âncora deixou de ser consultada"
    )
    assert defeito == seguinte


# ---------------------------------------------------------------------
# O passe completo, e a prova de que ele solta o lock
# ---------------------------------------------------------------------
def test_conferir_a_cadeia_inteira_nao_segura_o_lock(banco, sessao, monkeypatch):
    """Enquanto a cadeia inteira é percorrida, o resto do setor continua trabalhando.

    Antes da correção este passe rodava dentro da requisição, com o lock tomado
    desde o SELECT do cookie: a outra pessoa levava `database is locked` — que na
    tela vira 500, sem dizer por quê.

    A thread que confere abre a sessão da aplicação e **lê antes de conferir**,
    de propósito: é o SELECT que uma requisição de verdade faz para resolver o
    cookie, e é ele que toma o lock. Sem essa leitura o teste provaria apenas que
    uma transação que nunca começou não segura nada.
    """
    _encher_a_trilha(sessao, 40)
    sessao.commit()
    lento = DigestLento(auditoria._digerir)
    monkeypatch.setattr(auditoria, "_digerir", lento)

    def conferir():
        with mod_banco.sessao() as s:
            s.execute(text("SELECT count(*) FROM sessao")).scalar_one()  # o cookie
            return auditoria.conferir_fora_da_transacao(s, origem=auditoria.ORIGEM_ROTINA)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        tarefa = executor.submit(conferir)
        assert lento.entrou.wait(timeout=30), "o passe nunca começou"
        durante = _outra_pessoa_consegue_escrever()
        resultado = tarefa.result(timeout=60)

    assert durante, (
        "outra pessoa levou 'database is locked' enquanto a cadeia era "
        "conferida — a transação de quem conferia não soltou o lock"
    )
    assert resultado.integra
    assert resultado.eventos >= 40


def test_o_passe_completo_conferiu_a_trilha_inteira(banco, sessao):
    """Soltar o lock não pode ter virado conferir menos."""
    _encher_a_trilha(sessao, 25)
    with mod_banco.sessao() as s:
        total = s.execute(select(func.count(HistoricoEvento.id))).scalar_one()
        resultado = auditoria.conferir_fora_da_transacao(s, origem=auditoria.ORIGEM_ROTINA)

    assert resultado.eventos == total
    assert resultado.ultimo_evento_id == max(
        list(sessao.execute(select(HistoricoEvento.id)).scalars())
    )
    assert resultado.integra and resultado.primeiro_defeito_id is None


def test_o_passe_completo_aponta_o_defeito_e_conta_ate_ali(banco):
    with mod_banco.sessao() as s:
        _encher_a_trilha(s, 12)
        ids = list(
            s.execute(select(HistoricoEvento.id).order_by(HistoricoEvento.id)).scalars()
        )
    alvo = ids[4]
    _adulterar(alvo, "reescrito por fora do sistema")

    with mod_banco.sessao() as s:
        resultado = auditoria.conferir_fora_da_transacao(s, origem=auditoria.ORIGEM_ROTINA)

    assert not resultado.integra
    assert resultado.primeiro_defeito_id == alvo
    # "os N eventos até ali conferem" é uma afirmação, e o número tem de ser dela
    assert resultado.eventos == ids.index(alvo) + 1


def test_uma_conferencia_por_vez(banco, sessao, monkeypatch):
    """O segundo clique é recusado com mensagem, e não enfileirado.

    Seis pessoas clicando no botão fariam seis passes idênticos sobre a mesma
    trilha, gravando seis linhas com a mesma resposta. Recusar é melhor do que
    esperar: quem chegou depois quer o resultado, e o resultado já está a caminho.
    """
    _encher_a_trilha(sessao, 20)
    sessao.commit()
    lento = DigestLento(auditoria._digerir)
    monkeypatch.setattr(auditoria, "_digerir", lento)

    def conferir():
        with mod_banco.sessao() as s:
            return auditoria.conferir_fora_da_transacao(s)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        tarefa = executor.submit(conferir)
        assert lento.entrou.wait(timeout=30)
        with pytest.raises(auditoria.ConferenciaEmCurso):
            conferir()
        assert tarefa.result(timeout=60).integra

    # e a trava não ficou presa: depois que o primeiro acabou, confere de novo
    with mod_banco.sessao() as s:
        assert auditoria.conferir_fora_da_transacao(s).integra


# ---------------------------------------------------------------------
# Pela porta da frente: o botão e a data na tela
# ---------------------------------------------------------------------
def test_o_botao_confere_grava_e_a_tela_passa_a_datar(app_cliente, contas, banco):
    """O que a tela pode afirmar sobre a trilha inteira é quando ela foi conferida."""
    with mod_banco.sessao() as s:
        _encher_a_trilha(s, 15)

    entrar(app_cliente, contas, "auditor_interno")
    antes = app_cliente.get("/auditoria")
    assert "ainda não foi conferida" in antes.text

    resposta = app_cliente.post("/auditoria/conferir")
    assert resposta.status_code == 200, resposta.text
    assert "encadeamento íntegro" in resposta.text

    with mod_banco.sessao() as s:
        registros = list(s.execute(select(ConferenciaCadeia)).scalars())
    assert len(registros) == 1
    registro = registros[0]
    assert registro.integra and registro.origem == "BOTAO"
    assert registro.usuario_id is not None, "o botão tem dono; a rotina não tem"
    assert registro.eventos >= 15

    depois = app_cliente.get("/auditoria")
    assert "Cadeia conferida em" in depois.text
    assert "ainda não foi conferida" not in depois.text


def test_conferir_exige_a_permissao_da_trilha(app_cliente, contas, banco):
    entrar(app_cliente, contas, "almoxarife_sesmt")
    resposta = app_cliente.post("/auditoria/conferir")
    assert resposta.status_code == 403, resposta.text
    with mod_banco.sessao() as s:
        assert not list(s.execute(select(ConferenciaCadeia)).scalars())


def test_conferir_sem_sessao_vai_para_o_login(app_cliente, banco):
    resposta = app_cliente.post("/auditoria/conferir", follow_redirects=False)
    assert resposta.status_code == 303
    assert resposta.headers["location"].startswith("/login")


def test_a_rotina_de_linha_de_comando_grava_sem_dono(banco, sessao, capsys):
    """`python -m ferramentas.conferir_cadeia` — a rotina noturna.

    Ela não tem sessão nem cookie: roda pelo agendador do Windows. `usuario_id`
    nulo e `origem='ROTINA'` são o que distingue a madrugada do clique.
    """
    from ferramentas import conferir_cadeia

    _encher_a_trilha(sessao, 8)

    assert conferir_cadeia.principal([]) == 0
    assert "Cadeia íntegra" in capsys.readouterr().out

    with mod_banco.sessao() as s:
        registro = auditoria.ultima_conferencia(s)
    assert registro is not None
    assert registro.origem == "ROTINA"
    assert registro.usuario_id is None


def test_a_rotina_devolve_codigo_de_erro_com_a_cadeia_rompida(banco, capsys):
    from ferramentas import conferir_cadeia

    with mod_banco.sessao() as s:
        _encher_a_trilha(s, 8)
        ids = list(
            s.execute(select(HistoricoEvento.id).order_by(HistoricoEvento.id)).scalars()
        )
    _adulterar(ids[3], "reescrito por fora do sistema")

    assert conferir_cadeia.principal([]) == 1
    saida = capsys.readouterr()
    assert f"CADEIA ROMPIDA no evento {ids[3]}" in saida.err


# ---------------------------------------------------------------------
# A trava que impede a quinta ocorrência
# ---------------------------------------------------------------------
def _chamadas_de_cadeia_integra(caminho: Path) -> list[int]:
    """Linhas em que o arquivo chama `auditoria.cadeia_integra` (ou a importa e chama)."""
    arvore = ast.parse(caminho.read_text(encoding="utf-8"), str(caminho))
    apelidos = {"auditoria"}
    importados: set[str] = set()
    for no in ast.walk(arvore):
        if isinstance(no, ast.Import):
            for alias in no.names:
                if alias.name == "app.servicos.auditoria" and alias.asname:
                    apelidos.add(alias.asname)
        elif isinstance(no, ast.ImportFrom):
            for alias in no.names:
                if alias.name == "auditoria":
                    apelidos.add(alias.asname or "auditoria")
                elif no.module and no.module.endswith("servicos.auditoria"):
                    if alias.name == "cadeia_integra":
                        importados.add(alias.asname or "cadeia_integra")

    linhas = []
    for no in ast.walk(arvore):
        if not isinstance(no, ast.Call):
            continue
        alvo = no.func
        if isinstance(alvo, ast.Attribute) and alvo.attr == "cadeia_integra":
            if isinstance(alvo.value, ast.Name) and alvo.value.id in apelidos:
                linhas.append(no.lineno)
        elif isinstance(alvo, ast.Name) and alvo.id in importados:
            linhas.append(no.lineno)
    return linhas


def test_nada_em_app_chama_cadeia_integra_dentro_da_requisicao():
    """A regra vira trava, e não convenção — irmã de `test_nada_em_app_chama_pdf_converter`.

    A conferência completa dentro da requisição não deixa rastro nenhum: nada
    quebra, nada é registrado, e na base de hoje a tela até abre depressa. Só
    aparece daqui a dois anos, na tela dos outros, como "o sistema travou". Não
    há teste funcional que a pegue no tamanho de hoje — o teste de contagem
    acima pega a rota que existe, esta trava pega a próxima que alguém escrever.

    A dispensa é uma só, e é o próprio `servicos/auditoria.py`: é lá que
    `cadeia_integra` mora e é lá que o passe completo a usa, com a transação já
    fechada.
    """
    dispensados = {(RAIZ / "app" / "servicos" / "auditoria.py").resolve()}
    infratores = []
    for caminho in sorted((RAIZ / "app").rglob("*.py")):
        if caminho.resolve() in dispensados:
            continue
        for linha in _chamadas_de_cadeia_integra(caminho):
            infratores.append(f"{caminho.relative_to(RAIZ)}:{linha}")

    assert not infratores, (
        "chamada de auditoria.cadeia_integra() dentro de app/ — ela percorre a "
        "trilha inteira e recalcula um SHA-256 por evento, e dentro de uma "
        "requisição isso segura o único lock de escrita do SQLite por segundos. "
        "Use janela_integra(s, eventos) na tela, ou "
        "conferir_fora_da_transacao(s) para o passe completo: "
        + ", ".join(infratores)
    )


@pytest.mark.parametrize(
    "fonte, esperado",
    [
        # guarda que não morde é decoração: as três formas de escrever a chamada
        # proibida têm de ser vistas, cada uma pela sua porta de import
        (
            "from app.servicos import auditoria as aud\naud.cadeia_integra(s)\n",
            [2],
        ),
        ("from app.servicos.auditoria import cadeia_integra\ncadeia_integra(s)\n", [2]),
        ("import app.servicos.auditoria as a\na.cadeia_integra(s)\n", [2]),
        # e as formas certas não podem ser confundidas com a errada
        ("from app.servicos import auditoria\nauditoria.janela_integra(s, e)\n", []),
        (
            "from app.servicos import auditoria\n"
            "auditoria.conferir_fora_da_transacao(s)\n",
            [],
        ),
        # nem um `cadeia_integra` de outra origem, que não é este
        ("from outra.coisa import cadeia_integra\ncadeia_integra(s)\n", []),
    ],
)
def test_a_trava_morde_as_tres_formas(tmp_path, fonte, esperado):
    alvo = tmp_path / "amostra.py"
    alvo.write_text(fonte, encoding="utf-8")
    assert _chamadas_de_cadeia_integra(alvo) == esperado
