"""A trava: a suite nao escreve dentro do repositorio.

Isto ja aconteceu de verdade. A configuracao de teste nascia lendo o `.env` de
producao, e a suite gravou documento de teste em `dados/documentos/` e backup
do banco de teste em `dados/backups/` - na mesma rotacao de onde o setor
restauraria em caso de perda.

Nao basta consertar: a proxima refatoracao de config reabre o buraco e ninguem
percebe ate ver documento de producao sobrescrito. Por isso os testes daqui
conferem os DOIS niveis:

* o mecanismo (o env_file e resolvido na instanciacao, nao no import);
* o efeito (os caminhos que os servicos calculam de fato caem fora do repo).

Conferir so o mecanismo deixaria passar um campo de diretorio novo. Conferir so
os caminhos deixaria passar a causa-raiz voltando disfarcada.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import RAIZ, Config, EnvFileAusente, caminho_env_file, obter_config

PROIBIDOS = (RAIZ / "dados", RAIZ / "entrada")


def _dentro_do_repositorio(caminho: Path) -> bool:
    resolvido = caminho.resolve()
    return resolvido == RAIZ or RAIZ in resolvido.parents


# ---------------------------------------------------------------------
# O efeito
# ---------------------------------------------------------------------
def test_nenhum_diretorio_da_config_cai_dentro_do_repositorio():
    """Cobre TODO campo de diretorio, inclusive os que ainda nao existem.

    A lista vem de `Config.diretorios_de_dados`, a mesma que o boot usa para
    criar as pastas: campo novo entra la e e conferido aqui de graca.
    """
    cfg = obter_config()
    alvos = dict(cfg.diretorios_de_dados)
    alvos["banco"] = cfg.caminho_banco

    dentro = {nome: c for nome, c in alvos.items() if _dentro_do_repositorio(c)}
    assert not dentro, (
        "A suite escreveria dentro do repositorio (dados/ do coordenador): "
        f"{dentro}"
    )


def test_os_servicos_resolvem_para_fora_do_repositorio():
    """Os quatro escritores que vazaram, conferidos pelo caminho que calculam.

    A config podia estar certa e um servico continuar montando o caminho por
    fora dela - foi assim que os certificados e a lista de presenca escaparam.
    """
    from app.modelos import Certificado, Turma
    from app.servicos import anexos, documento, emissao_certificado, lista_presenca

    turma = Turma(numero=1, ano=2026, codigo="TUR-2026-0001")
    certificado = Certificado(
        numero=1,
        ano=2026,
        contexto_congelado={
            "turma_codigo": "TUR-2026-0001",
            "participante_nome": "Ana Lima",
        },
    )

    calculados = {
        "parecer": documento.caminho_saida(1, 2025, "SEST", "Teste"),
        "lista_presenca": lista_presenca.caminho_saida(turma),
        "certificado": emissao_certificado.caminho_saida(certificado),
        "anexo": anexos.caminho_do_blob("0" * 64),
    }

    dentro = {nome: c for nome, c in calculados.items() if _dentro_do_repositorio(c)}
    assert not dentro, f"Servico escrevendo dentro do repositorio: {dentro}"


def test_backup_sem_destino_nao_cai_na_rotacao_de_producao(banco):
    """O caso que envenenou `dados/backups/`.

    `POST /config/backup` chama `fazer_backup()` sem destino, e o destino padrao
    e o do .env. Com a config de producao, cada rodada da suite deixava um dump
    cifrado do banco DE TESTE na pasta de backup do setor - indistinguivel dos
    backups reais pelo nome, e mais recente que eles.
    """
    from app.servicos import backup

    resultado = backup.fazer_backup()
    try:
        assert not _dentro_do_repositorio(resultado.arquivo), (
            f"Backup de teste gravado em {resultado.arquivo}"
        )
    finally:
        resultado.arquivo.unlink(missing_ok=True)


@pytest.mark.parametrize("proibido", PROIBIDOS, ids=lambda p: p.name)
def test_pastas_reais_estao_fora_do_alcance(proibido):
    """Nenhum caminho da config aponta para `dados/` nem para `entrada/`."""
    cfg = obter_config()
    alvos = [*cfg.diretorios_de_dados.values(), cfg.caminho_banco]
    for caminho in alvos:
        resolvido = caminho.resolve()
        assert proibido != resolvido and proibido not in resolvido.parents, (
            f"{resolvido} esta dentro de {proibido}"
        )


# ---------------------------------------------------------------------
# O mecanismo
# ---------------------------------------------------------------------
def test_env_file_e_resolvido_na_instanciacao(tmp_path, monkeypatch):
    """A causa-raiz. Falha se alguem devolver `env_file` ao model_config.

    No corpo da classe o valor congela no import de `app.config` - que o pytest
    faz na coleta, antes de qualquer conftest. Resolvido na instanciacao, vale o
    ambiente do momento.
    """
    outro = tmp_path / "outro.env"
    outro.write_text("CSSO_AMBIENTE=vindo-do-env-file\n", encoding="utf-8")
    monkeypatch.setenv("CSSO_ENV_FILE", str(outro))
    # a variavel de ambiente tem precedencia sobre o .env e mascararia o teste
    monkeypatch.delenv("CSSO_AMBIENTE", raising=False)

    assert caminho_env_file() == outro
    assert Config().ambiente == "vindo-do-env-file"


def test_variavel_de_ambiente_vence_o_env_file(tmp_path, monkeypatch):
    """A segunda trava do conftest da raiz, conferida.

    E ela que segura o isolamento mesmo que o env_file volte a congelar.
    """
    outro = tmp_path / "outro.env"
    outro.write_text("CSSO_AMBIENTE=do-arquivo\n", encoding="utf-8")
    monkeypatch.setenv("CSSO_ENV_FILE", str(outro))
    monkeypatch.setenv("CSSO_AMBIENTE", "do-ambiente")

    assert Config().ambiente == "do-ambiente"


def test_env_file_apontado_e_inexistente_recusa_subir(tmp_path, monkeypatch):
    """A terceira trava: apontar para um arquivo que nao existe nao pode
    virar "leia o da raiz".

    Aconteceu em 05/09/2026. Um lancador montou `CSSO_ENV_FILE` com `%CD%` que
    nao expandiu; o pydantic-settings tratou o arquivo ausente como "sem
    arquivo" e subiu o "ambiente de teste" na porta 8766 lendo `dados/csso.db`
    real. Nenhuma linha de erro - so o log de acesso de producao crescendo.
    """
    monkeypatch.setenv("CSSO_ENV_FILE", str(tmp_path / "nao-existe.env"))
    with pytest.raises(EnvFileAusente, match="nao existe"):
        Config()


def test_sem_variavel_o_env_da_raiz_ausente_nao_e_erro(tmp_path, monkeypatch):
    """A trava so vale para o arquivo APONTADO. Sem `CSSO_ENV_FILE`, a raiz
    sem `.env` continua sendo o caso do INICIAR.bat na primeira execucao,
    que cria o arquivo - nao pode virar excecao aqui.
    """
    monkeypatch.delenv("CSSO_ENV_FILE", raising=False)
    monkeypatch.setattr("app.config.RAIZ", tmp_path)
    assert caminho_env_file() == tmp_path / ".env"
    Config()  # nao levanta


def test_config_de_producao_continua_lendo_o_env_da_raiz(monkeypatch):
    """A correcao nao pode mudar o comportamento fora de teste."""
    monkeypatch.delenv("CSSO_ENV_FILE", raising=False)
    assert caminho_env_file() == RAIZ / ".env"
