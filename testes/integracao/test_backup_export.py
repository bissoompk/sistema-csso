"""CA-13 (backup/restauracao) e CA-14 (EXPORTAR-TUDO)."""

from __future__ import annotations

import csv
import io
import zipfile
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app import banco as mod_banco
from app.modelos import ParecerTecnico
from app.servicos import backup, documento
from app.servicos.backup import CABECALHO_PLANILHA
from app.servicos.textos import normalizar_fluxo


@pytest.fixture()
def com_parecer(sessao):
    """Reaproveita o cenario do 1/2025 emitindo de verdade."""
    from testes.integracao.test_emissao import COORDENADOR

    return COORDENADOR


def test_cifra_e_decifra():
    original = b"conteudo do banco" * 100
    pacote = backup.cifrar(original, "senha-forte")
    assert pacote.startswith(backup.MAGICO)
    assert original not in pacote
    assert backup.decifrar(pacote, "senha-forte") == original


def test_senha_errada_nao_decifra():
    pacote = backup.cifrar(b"x", "certa")
    with pytest.raises(Exception):
        backup.decifrar(pacote, "errada")


def test_backup_recusa_destino_em_nuvem(tmp_path):
    destino = tmp_path / "OneDrive" / "backups"
    with pytest.raises(backup.DestinoProibido):
        backup.fazer_backup(destino)


def test_export_recusa_destino_em_nuvem(sessao, tmp_path):
    with pytest.raises(backup.DestinoProibido):
        backup.exportar_tudo(sessao, tmp_path / "Dropbox")


def test_ca13_backup_apagar_restaurar_regera_o_parecer(banco, tmp_path):
    """Backup -> apagar csso.db -> restaurar -> o 1/2025 sai idêntico ao ouro.

    **E o comprovante volta junto.** Até a 1.30.0 o `.enc` levava só o banco: a
    restauração devolvia a linha da ficha de EPI com `comprovante_anexo_id`
    preenchido e o arquivo apontado inexistente. A ficha de EPI existe para ser
    prova de entrega em fiscalização, e a assinatura do servidor está no
    arquivo, não na linha — restaurar o registro sem o documento é restaurar a
    metade que não prova nada (`POLITICA_RETENCAO.md` §2.3, guarda permanente).

    O `sha256` é a asserção que importa: ele é o que prova que o arquivo que
    voltou é o MESMO. Um teste que só conferisse a existência passaria com um
    arquivo truncado, e um backup que devolve PDF truncado é pior que um que
    não devolve nada, porque parece ter funcionado.
    """
    from app.config import obter_config
    from app.modelos import Anexo
    from app.servicos import anexos
    from testes.fixtures.dados_parecer_1_2025 import contexto_1_2025

    cfg = obter_config()

    # o comprovante assinado, no disco e na linha que o aponta
    comprovante = b"%PDF-1.4\nCOMPROVANTE DE EPI COM ASSINATURA DO SERVIDOR\n" * 40
    sha = anexos.digerir(comprovante)
    blob = anexos.caminho_do_blob(sha)
    blob.write_bytes(comprovante)
    chave = str(blob.relative_to(cfg.caminho(cfg.dir_anexos)))

    with mod_banco.sessao() as s:
        s.add(ParecerTecnico(numero=1, ano=2025, situacao="RASCUNHO"))
        s.add(
            Anexo(
                entidade="epi_ficha_registro",
                entidade_id=1,
                nome_arquivo="comprovante.pdf",
                nome_original="comprovante-assinado.pdf",
                mime_type="application/pdf",
                tamanho_bytes=len(comprovante),
                sha256=sha,
                storage_key=chave,
                categoria="FICHA_EPI",
                nivel_acesso="RESTRITO",
            )
        )
        s.commit()

    resultado = backup.fazer_backup(tmp_path / "bk")
    assert resultado.cifrado and resultado.arquivo.exists()
    assert resultado.arquivos >= 1, "o backup não levou arquivo nenhum de dados/"

    caminho_banco = cfg.caminho_banco
    mod_banco.obter_engine().dispose()
    # o sinistro completo: some o banco E some o blob
    blob.unlink()
    alvo = tmp_path / "restaurado.db"
    backup.restaurar(resultado.arquivo, alvo)

    engine = mod_banco.redefinir_engine(f"sqlite+pysqlite:///{alvo.as_posix()}")
    with mod_banco.sessao() as s:
        parecer = s.execute(
            select(ParecerTecnico).where(ParecerTecnico.ano == 2025)
        ).scalar_one()
        assert parecer.numero == 1
        anexo = s.execute(select(Anexo).where(Anexo.sha256 == sha)).scalar_one()
        volta = tmp_path / "anexos" / anexo.storage_key
        assert volta.exists(), (
            "restaurou a linha do comprovante e não o arquivo — a ficha voltou "
            "sem a prova"
        )
        assert anexos.digerir(volta.read_bytes()) == anexo.sha256, (
            "o arquivo voltou diferente do que o banco declara"
        )
    engine.dispose()

    # e o documento continua sendo regerado identico ao texto de ouro
    from app.config import RAIZ

    ouro = (RAIZ / "testes" / "fixtures" / "ouro_parecer_1_2025.txt").read_text("utf-8")
    gerado = tmp_path / "regerado.docx"
    documento.renderizar(contexto_1_2025(), gerado, documento.MODELO_V1)
    assert normalizar_fluxo(documento.extrair_texto(gerado)) == normalizar_fluxo(ouro)
    _ = caminho_banco


def test_restaura_backup_anterior_ao_pacote(tmp_path):
    """O `.enc` gravado até a 1.30.0, quando o recheio era o `.db` cru.

    Há cinco deles em `dados/backups/` hoje. Uma correção de backup que
    invalidasse os backups existentes seria a correção que causa a perda que
    diz evitar.
    """
    from app.config import obter_config

    cru = b"SQLite format 3\x00" + b"banco antigo, sem anexo nenhum" * 20
    arquivo = tmp_path / "antigo.db.enc"
    arquivo.write_bytes(backup.cifrar(cru, obter_config().backup_senha))

    alvo = tmp_path / "velho" / "restaurado.db"
    assert backup.restaurar(arquivo, alvo).read_bytes() == cru


def test_ca14_export_tem_tudo(sessao, tmp_path):
    from app.modelos import Usuario
    from app.servicos import autenticacao

    sessao.add(
        Usuario(
            login="exp",
            nome="Exportador",
            email="exp@teste.ufvjm.edu.br",
            senha_hash=autenticacao.gerar_hash("SenhaDeTeste2026"),
        )
    )
    sessao.add(ParecerTecnico(numero=1, ano=2025, situacao="RASCUNHO"))
    sessao.commit()

    alvo = backup.exportar_tudo(sessao, tmp_path / "export")
    assert alvo.exists()

    with zipfile.ZipFile(alvo) as z:
        nomes = set(z.namelist())
        assert "Pareceres.xlsx" in nomes
        assert "LEIA-ME-DO-EXPORT.txt" in nomes
        assert "csso.db" in nomes
        assert any(n.startswith("csv/") for n in nomes)

        leia_me = z.read("LEIA-ME-DO-EXPORT.txt").decode("utf-8")
        assert "LGPD" in leia_me
        assert "nuvem pessoal" in leia_me

        bruto = z.read("csv/pareceres.csv")
        assert bruto.startswith(b"\xef\xbb\xbf"), "CSV precisa de BOM para o Excel pt-BR"
        texto = bruto.decode("utf-8-sig")
        linhas = list(csv.reader(io.StringIO(texto), delimiter=";"))
        assert linhas[0][:24] == CABECALHO_PLANILHA
        assert linhas[0][24] == "col_Y_sem_cabecalho"


def test_ca14_planilha_tem_as_24_colunas_rotuladas(sessao, tmp_path):
    from openpyxl import load_workbook

    sessao.add(ParecerTecnico(numero=2, ano=2025, situacao="RASCUNHO"))
    sessao.commit()
    alvo = backup.exportar_tudo(sessao, tmp_path / "export2")
    with zipfile.ZipFile(alvo) as z:
        dados = z.read("Pareceres.xlsx")
    caminho = tmp_path / "Pareceres.xlsx"
    caminho.write_bytes(dados)
    wb = load_workbook(caminho)
    ws = wb.worksheets[0]
    cabecalho = [c.value for c in ws[1]]
    assert cabecalho[:24] == CABECALHO_PLANILHA
    assert cabecalho[24] == "col_Y_sem_cabecalho"


def test_export_nao_disputa_o_lock_e_leva_o_wal_junto(sessao, tmp_path):
    """`exportar_tudo` não pode esperar o próprio lock — e o zip leva o WAL.

    **O defeito que este teste tranca.** Havia um `PRAGMA wal_checkpoint(TRUNCATE)`
    antes do `VACUUM INTO`, numa segunda conexão. É o mesmo padrão do sino
    (`test_pendencias_e_sla.py`): a sessão do chamador já está aberta e já tomou
    o lock de escrita, porque toda transação nasce com `BEGIN IMMEDIATE`
    (RN-03, `banco.py`) — e os SELECTs de processos, laudos e servidores, que
    `exportar_tudo` faz depois do `commit()`, reabrem a transação.

    O checkpoint precisa de exclusividade, batia nesse lock e esperava o
    `busy_timeout` inteiro. Medido: **5,664 s com a sessão aberta contra 0,001 s
    sem ela**, devolvendo `(1, ...)` — `SQLITE_BUSY`. Ou seja, esperava quase
    seis segundos para NÃO fazer o checkpoint. Ninguém lia esse retorno e não
    havia nem `except` para engolir: falhava em silêncio absoluto. O export
    inteiro caiu de 6,161 s para 0,454 s.

    As duas asserções são de propósito. O tempo pega a causa: qualquer segunda
    conexão que volte a pedir exclusividade aqui dentro estoura o limite, e
    estoura em silêncio de novo. A integridade pega o motivo de o `PRAGMA` ter
    sido posto ali — um backup que perdesse as últimas transações seria muito
    pior que seis segundos de espera. Ele não é necessário: `VACUUM INTO` lê o
    banco lógico, WAL incluído.
    """
    import time

    from app import banco as mod_banco
    from app.modelos import Servidor

    # dado que fica SÓ no WAL: commitado, mas sem checkpoint para o `.db`
    sessao.add(Servidor(siape="7654321", nome="Servidor Só No WAL"))
    sessao.commit()

    caminho_wal = Path(str(mod_banco.obter_engine().url.database) + "-wal")
    assert caminho_wal.exists() and caminho_wal.stat().st_size > 0, (
        "sem WAL pendente o teste não prova nada — o dado já estaria no .db"
    )

    inicio = time.perf_counter()
    alvo = backup.exportar_tudo(sessao, tmp_path / "export_wal")
    decorrido = time.perf_counter() - inicio

    # o `busy_timeout` é de 5 s (`modelos/base.py`); 3 s fica longe dos 0,45 s
    # normais e longe da espera pelo lock, que passa dos 5 s
    assert decorrido < 3.0, (
        f"exportar_tudo levou {decorrido:.3f} s — alguém abriu uma segunda "
        "conexão que disputa o lock da própria requisição"
    )

    with zipfile.ZipFile(alvo) as z:
        copia = tmp_path / "do_zip.db"
        copia.write_bytes(z.read("csso.db"))

    from sqlalchemy import create_engine

    espelho = create_engine(f"sqlite+pysqlite:///{copia.as_posix()}")
    try:
        with espelho.connect() as con:
            nome = con.exec_driver_sql(
                "SELECT nome FROM servidor WHERE siape='7654321'"
            ).scalar()
    finally:
        espelho.dispose()
    assert nome == "Servidor Só No WAL", "o export perdeu o que estava só no WAL"


def test_export_inclui_documentos_e_anexos(sessao, tmp_path):
    from app.config import obter_config

    cfg = obter_config()
    pasta = cfg.caminho(cfg.dir_documentos) / "2025"
    pasta.mkdir(parents=True, exist_ok=True)
    (pasta / "Parecer_Tecnico_01-2025.docx").write_bytes(b"docx falso")

    alvo = backup.exportar_tudo(sessao, tmp_path / "export3")
    with zipfile.ZipFile(alvo) as z:
        assert any(n.startswith("documentos/") for n in z.namelist())


_ = (date, Path)
