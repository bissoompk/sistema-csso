"""Q-1 — a conversão de PDF não pode segurar o lock de escrita do SQLite.

Terceira ocorrência do mesmo defeito no repositório, e as duas anteriores estão
no `CHANGELOG.md`: o sino da 1.22.1, que abria uma segunda conexão dentro da
requisição e esperava o `busy_timeout` inteiro para exibir zero; e o
`PRAGMA wal_checkpoint(TRUNCATE)` do EXPORTAR-TUDO na 1.22.2, que esperava 5,7 s
para não fazer o checkpoint. Aqui a operação lenta não é uma segunda conexão nem
um PRAGMA — é o LibreOffice, que leva de 2 a 8 s a frio e rodava com o lock de
escrita do sistema inteiro na mão.

**Por que o instrumento é uma conexão `sqlite3` crua.** Ela é a outra pessoa: o
que se quer medir é se o lock de escrita está disponível para quem não é esta
requisição, e é exatamente isso que o `BEGIN IMMEDIATE` dela responde. A
paciência dela é curta de propósito — o `busy_timeout` de produção é 5 s
(`app/modelos/base.py`) e a conversão real leva mais que isso, mas um teste que
esperasse 6 s para provar o ponto seria pago em toda execução da suíte. Curta a
espera e curta a conversão na mesma proporção, o formato é o mesmo: a conversão
dura mais do que a outra pessoa aguenta esperar.

O único teste que usa os números de produção — conversão de 6 s contra o
`busy_timeout` real de 5 s — é o das seis pessoas, porque ali o que se afirma é
justamente a resposta em número de pessoas.
"""

from __future__ import annotations

import ast
import concurrent.futures
import sqlite3
import threading
import time
from pathlib import Path

import pytest
from sqlalchemy import select, text

from app import banco as mod_banco
from app.config import RAIZ
from app.modelos import Certificado, HistoricoEvento, Inscricao, ParecerTecnico
from app.servicos import auditoria
from app.servicos import emissao_certificado as servico_cert
from app.servicos import parecer as servico_parecer
from app.servicos import pdf as servico_pdf
from app.servicos.pdf import ResultadoPdf
from testes.integracao import papeis
from testes.integracao.test_certificados import _cenario as _cenario_certificado
from testes.integracao.test_certificados import _usuario as _usuario_certificado

# A conversão simulada, e a paciência de quem espera por ela. A relação entre as
# duas é o que reproduz o defeito: quem espera desiste antes de a conversão
# acabar, como as cinco outras pessoas do setor desistem antes dos 8 s do
# LibreOffice frio.
CONVERSAO_S = 1.2
PACIENCIA_S = 0.3


def _caminho_do_banco() -> str:
    """O arquivo que o engine está usando AGORA.

    Não é `cfg.caminho_banco`: a fixture `banco` reaponta o engine para um
    `tmp_path` por teste (`redefinir_engine`), e perguntar à configuração
    devolveria um caminho que ninguém está usando — uma sonda apontada para um
    arquivo vazio acha sempre que o lock está livre, e o teste passaria por
    ausência de medição.
    """
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


class ConversaoSimulada:
    """LibreOffice de mentira: avisa que começou, demora, e entrega o PDF.

    `entrou` é o que dá ao teste um ponto de observação DENTRO da conversão —
    sem ele o teste mediria o lock antes ou depois, que é quando ele está livre
    dos dois lados e a medição não diria nada.
    """

    def __init__(self, segundos: float = CONVERSAO_S, sucesso: bool = True):
        self.segundos = segundos
        self.sucesso = sucesso
        self.entrou = threading.Event()
        self.chamadas = 0

    def __call__(self, docx: Path, saida: Path | None = None) -> ResultadoPdf:
        self.chamadas += 1
        destino = saida or docx.with_suffix(".pdf")
        self.entrou.set()
        time.sleep(self.segundos)
        if not self.sucesso:
            # o caso difícil: o LibreOffice EXISTE nesta máquina e mesmo assim
            # não converteu (perfil corrompido, disco cheio, tempo esgotado).
            # `indisponivel=False` é o que separa isto de "não há LibreOffice".
            return ResultadoPdf(False, None, f"{servico_pdf.AVISO_SEM_PDF} (simulado)")
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"%PDF-1.4 simulado\n")
        return ResultadoPdf(True, destino, None)


def _com_libreoffice(monkeypatch, conversao: ConversaoSimulada) -> None:
    """Finge uma máquina com LibreOffice instalado.

    `disponivel` também é trocado, e não só `converter`: é ela que
    `converter_fora_da_transacao` consulta para decidir se há motivo para soltar
    a transação. Numa máquina sem LibreOffice não há nada a esperar, e o commit
    seria mexer no contrato de quem chama sem ganhar nada.
    """
    monkeypatch.setattr(servico_pdf, "disponivel", lambda: True)
    monkeypatch.setattr(servico_pdf, "converter", conversao)


# ---------------------------------------------------------------------
# O travamento, e a prova de que acabou
# ---------------------------------------------------------------------
def test_emitir_parecer_nao_segura_o_lock_durante_a_conversao(
    banco, sessao, cenario, monkeypatch
):
    """Enquanto o LibreOffice converte, o resto do setor continua trabalhando.

    Antes da correção este teste falha na asserção do meio: a emissão segurava o
    lock desde o `BEGIN IMMEDIATE` da primeira leitura até o commit da rota, e a
    outra pessoa levava `database is locked` — que na tela vira 500.
    """
    conversao = ConversaoSimulada()
    _com_libreoffice(monkeypatch, conversao)
    parecer_id = cenario["parecer"].id
    sessao.commit()  # o cenário precisa estar visível às outras conexões

    def emitir() -> None:
        with mod_banco.sessao() as s:
            servico_parecer.emitir(
                s, s.get(ParecerTecnico, parecer_id), papeis.COORDENADOR
            )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        tarefa = executor.submit(emitir)
        assert conversao.entrou.wait(timeout=30), "a conversão nunca começou"
        durante = _outra_pessoa_consegue_escrever()
        tarefa.result(timeout=60)

    assert durante, (
        "outra pessoa levou 'database is locked' enquanto o parecer era "
        "convertido em PDF — a transação da emissão não soltou o lock"
    )
    assert conversao.chamadas == 1

    with mod_banco.sessao() as s:
        emitido = s.get(ParecerTecnico, parecer_id)
        assert emitido.situacao == "EMITIDO"
        assert emitido.numero >= 1


def test_emitir_certificado_nao_segura_o_lock_durante_a_conversao(
    banco, sessao, monkeypatch
):
    """O mesmo, no outro produto do setor.

    Certificado é o caso mais exigente dos dois: além de converter, ele PRECISA
    gravar depois — o PDF vira anexo e o certificado passa a apontá-lo. É a
    prova de que soltar a transação no meio não impede a segunda escrita.
    """
    conversao = ConversaoSimulada()
    _com_libreoffice(monkeypatch, conversao)
    usuario = _usuario_certificado(sessao)
    inscricao_id = _cenario_certificado(sessao, usuario)["inscricao"].id
    sessao.commit()

    def emitir() -> int:
        with mod_banco.sessao() as s:
            resultado = servico_cert.emitir(s, usuario, s.get(Inscricao, inscricao_id))
            return resultado.certificado.id

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        tarefa = executor.submit(emitir)
        assert conversao.entrou.wait(timeout=30), "a conversão nunca começou"
        durante = _outra_pessoa_consegue_escrever()
        certificado_id = tarefa.result(timeout=60)

    assert durante, (
        "outra pessoa levou 'database is locked' enquanto o certificado era "
        "convertido em PDF"
    )
    with mod_banco.sessao() as s:
        certificado = s.get(Certificado, certificado_id)
        assert certificado.situacao == "EMITIDO"
        # a segunda transação, a de depois do commit, chegou ao banco
        assert certificado.arquivo_pdf_anexo_id is not None


def test_seis_pessoas_com_uma_emitindo_ninguem_leva_database_is_locked(
    banco, sessao, cenario, monkeypatch
):
    """A equipe inteira: engenheiro, técnico, médico, secretaria, coordenação, almoxarifado.

    Este é o único teste do arquivo com os números de produção — conversão de
    6 s contra o `busy_timeout` real de 5 s —, e é caro por isso. Ele existe
    porque a pergunta do dono não é "o lock ficou livre", é "quantas pessoas o
    sistema aguenta"; com a conversão dentro da transação a resposta medida era
    **uma**, e as outras cinco esperavam 5,5 s para receber erro 500.

    As outras cinco abrem a sessão da aplicação, com o `busy_timeout` de 5 s que
    o sistema usa de verdade — nenhuma paciência encurtada aqui.
    """
    pessoas = 6
    conversao = ConversaoSimulada(segundos=6.0)
    _com_libreoffice(monkeypatch, conversao)
    parecer_id = cenario["parecer"].id
    sessao.commit()

    largada = threading.Barrier(pessoas)

    def quem_emite() -> str:
        largada.wait()
        with mod_banco.sessao() as s:
            servico_parecer.emitir(
                s, s.get(ParecerTecnico, parecer_id), papeis.COORDENADOR
            )
        return "emitiu"

    def quem_navega() -> str:
        largada.wait()
        assert conversao.entrou.wait(timeout=30)
        try:
            with mod_banco.sessao() as s:
                s.execute(text("SELECT count(*) FROM parecer_tecnico")).scalar_one()
            return "ok"
        except Exception as erro:  # noqa: BLE001 - o que se conta é justamente o erro
            return f"ERRO {type(erro).__name__}: {str(erro)[:80]}"

    tarefas = [quem_emite] + [quem_navega] * (pessoas - 1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=pessoas) as executor:
        resultados = list(executor.map(lambda f: f(), tarefas))

    travados = [r for r in resultados if r.startswith("ERRO")]
    assert not travados, (
        f"{len(travados)} de {pessoas - 1} pessoas travaram enquanto uma emitia: "
        f"{travados[0]}"
    )


# ---------------------------------------------------------------------
# O caso difícil: a conversão falha DEPOIS do commit
# ---------------------------------------------------------------------
def test_conversao_que_falha_depois_do_commit_nao_desfaz_a_emissao(
    banco, sessao, cenario, monkeypatch
):
    """RN-03: o número não volta, então a emissão não pode ser desfeita.

    Soltar a transação antes de converter cria uma janela em que o parecer existe
    e o PDF não. A tentação é desfazer — e desfazer é o pior dos caminhos: o
    `rollback` apagaria eventos já encadeados e o número consumido viraria buraco
    na sequência, que é justamente o que a RN-03 existe para impedir.

    O que este teste fixa é que a emissão sobrevive inteira à falha do PDF: a
    situação, o número, o congelado (RN-15) e o `.docx` no disco — que é o
    documento, e é dele que sai o `hash_conteudo`.
    """
    conversao = ConversaoSimulada(segundos=0.05, sucesso=False)
    _com_libreoffice(monkeypatch, conversao)
    parecer_id = cenario["parecer"].id
    sessao.commit()

    with mod_banco.sessao() as s:
        resultado = servico_parecer.emitir(
            s, s.get(ParecerTecnico, parecer_id), papeis.COORDENADOR
        )
        docx = resultado.docx
        assert resultado.pdf is None
        assert resultado.aviso_pdf and "PDF indisponível" in resultado.aviso_pdf

    with mod_banco.sessao() as s:
        emitido = s.get(ParecerTecnico, parecer_id)
        assert emitido.situacao == "EMITIDO"
        assert emitido.numero >= 1
        assert emitido.contexto_congelado, "RN-15: o congelado é o que faz prova"
        assert emitido.hash_conteudo
        numero_gasto = emitido.numero
    assert docx.exists(), "o .docx é o documento; ele não pode faltar"

    # e o número gasto continua gasto: a sequência não recua nem se repete
    from app.servicos import numeracao

    with mod_banco.sessao() as s:
        assert numeracao.proximo_numero_parecer(s, emitido.ano) > numero_gasto


def test_pdf_que_falhou_depois_do_commit_entra_na_cadeia_intacta(
    banco, sessao, cenario, monkeypatch
):
    """Não desfazer não pode virar ignorar — foi o `except` mudo do sino.

    O registro vai para a cadeia de auditoria, que é append-only por trigger de
    banco, e a cadeia continua fechando: a falha é gravada numa transação NOVA,
    depois do commit da emissão, e o encadeamento por SHA-256 sobrevive a isso.
    """
    conversao = ConversaoSimulada(segundos=0.05, sucesso=False)
    _com_libreoffice(monkeypatch, conversao)
    parecer_id = cenario["parecer"].id
    sessao.commit()

    with mod_banco.sessao() as s:
        servico_parecer.emitir(
            s, s.get(ParecerTecnico, parecer_id), papeis.COORDENADOR
        )

    with mod_banco.sessao() as s:
        eventos = (
            s.execute(
                select(HistoricoEvento).where(
                    HistoricoEvento.tipo_evento == auditoria.PDF_NAO_GERADO
                )
            )
            .scalars()
            .all()
        )
        assert len(eventos) == 1, "a falha do PDF não pode passar em silêncio"
        assert "PDF não foi gerado" in eventos[0].descricao
        # o evento da emissão veio ANTES: a ordem na cadeia é a ordem dos fatos
        emitido = s.execute(
            select(HistoricoEvento.id).where(
                HistoricoEvento.tipo_evento == auditoria.PARECER_EMITIDO
            )
        ).scalar_one()
        assert emitido < eventos[0].id

        ok, defeito = auditoria.cadeia_integra(s)
        assert ok, f"cadeia rompida em {defeito}"


def test_sem_libreoffice_a_degradacao_continua_muda(banco, sessao, cenario, monkeypatch):
    """Máquina sem LibreOffice é configuração declarada, não incidente.

    Sem esta separação, todo parecer emitido numa máquina sem LibreOffice abriria
    linha de falha na trilha, e a falha de verdade — a máquina que TEM a
    ferramenta e mesmo assim não converteu — se perderia no meio do ruído.
    """
    monkeypatch.setattr(servico_pdf, "localizar_soffice", lambda: None)
    parecer_id = cenario["parecer"].id
    sessao.commit()

    with mod_banco.sessao() as s:
        resultado = servico_parecer.emitir(
            s, s.get(ParecerTecnico, parecer_id), papeis.COORDENADOR
        )
        assert resultado.pdf is None
        assert "PDF indisponível" in (resultado.aviso_pdf or "")

    with mod_banco.sessao() as s:
        assert s.get(ParecerTecnico, parecer_id).situacao == "EMITIDO"
        nao_gerados = s.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.tipo_evento == auditoria.PDF_NAO_GERADO
            )
        ).scalars().all()
        assert not nao_gerados


# ---------------------------------------------------------------------
# A trava que impede a quarta ocorrência
# ---------------------------------------------------------------------
def _chamadas_diretas_de_converter(caminho: Path) -> list[int]:
    """Linhas em que o arquivo chama `pdf.converter` (ou o importa e o chama)."""
    arvore = ast.parse(caminho.read_text(encoding="utf-8"), str(caminho))
    apelidos = {"pdf"}
    importados: set[str] = set()
    for no in ast.walk(arvore):
        if isinstance(no, ast.Import):
            for alias in no.names:
                if alias.name == "app.servicos.pdf" and alias.asname:
                    apelidos.add(alias.asname)
        elif isinstance(no, ast.ImportFrom):
            for alias in no.names:
                if alias.name == "pdf":
                    apelidos.add(alias.asname or "pdf")
                elif no.module and no.module.endswith("servicos.pdf"):
                    if alias.name == "converter":
                        importados.add(alias.asname or "converter")

    linhas = []
    for no in ast.walk(arvore):
        if not isinstance(no, ast.Call):
            continue
        alvo = no.func
        if isinstance(alvo, ast.Attribute) and alvo.attr == "converter":
            if isinstance(alvo.value, ast.Name) and alvo.value.id in apelidos:
                linhas.append(no.lineno)
        elif isinstance(alvo, ast.Name) and alvo.id in importados:
            linhas.append(no.lineno)
    return linhas


def test_nada_em_app_chama_pdf_converter_dentro_da_requisicao():
    """A regra vira trava, e não convenção — este defeito já voltou duas vezes.

    A conversão dentro da requisição não deixa rastro nenhum: nada quebra, nada
    é registrado, e a tela até fica mais rápida para quem emite. Só aparece na
    tela dos outros, como "o sistema travou". Não há teste funcional que a pegue,
    então a trava é sobre o código-fonte — no mesmo espírito de
    `test_funcao_publica_aplica_escopo` e de
    `test_rn19_nenhum_template_le_nome_de_servidor_direto`.

    A dispensa é uma só, e é o próprio `pdf.py`: é lá que `converter` mora e é
    lá que `converter_fora_da_transacao` a chama, com a transação já fechada.
    """
    dispensados = {(RAIZ / "app" / "servicos" / "pdf.py").resolve()}
    infratores = []
    for caminho in sorted((RAIZ / "app").rglob("*.py")):
        if caminho.resolve() in dispensados:
            continue
        for linha in _chamadas_diretas_de_converter(caminho):
            infratores.append(f"{caminho.relative_to(RAIZ)}:{linha}")

    assert not infratores, (
        "chamada direta de pdf.converter() dentro de app/ — dentro de uma "
        "requisição isso entrega o único lock de escrita do SQLite ao "
        "LibreOffice por segundos. Use pdf.converter_fora_da_transacao(s, ...): "
        + ", ".join(infratores)
    )


@pytest.mark.parametrize(
    "fonte, esperado",
    [
        # guarda que não morde é decoração: as três formas de escrever a chamada
        # proibida têm de ser vistas, cada uma pela sua porta de import
        ("from app.servicos import pdf as servico_pdf\nservico_pdf.converter(a, b)\n", [2]),
        ("from app.servicos.pdf import converter\nconverter(a)\n", [2]),
        ("import app.servicos.pdf as p\np.converter(a)\n", [2]),
        # e a forma certa não pode ser confundida com a errada
        ("from app.servicos import pdf\npdf.converter_fora_da_transacao(s, a)\n", []),
        # nem um `converter` de outra origem, que não é este
        ("from outra.coisa import converter\nconverter(a)\n", []),
    ],
)
def test_a_trava_morde_as_tres_formas(tmp_path, fonte, esperado):
    alvo = tmp_path / "amostra.py"
    alvo.write_text(fonte, encoding="utf-8")
    assert _chamadas_diretas_de_converter(alvo) == esperado
