"""A trava do gerador do ambiente de teste: ele NAO escreve em `dados/`.

Este arquivo existe pelo mesmo motivo que o `conftest.py` da raiz e a
`test_isolamento.py`: o modo de falha e silencioso. Um caminho esquecido em
`variaveis_de_ambiente` cai no padrao de `Config` — que e dentro de `dados/` —
e o gerador passa a povoar de mentira o banco do setor sem erro nenhum no
caminho. Ninguem descobre olhando a tela: descobre olhando o export.

Nada aqui roda o gerador. Sao funcoes puras — o mapa de variaveis e a recusa de
destino — de proposito: um teste que executasse o povoamento para conferir
depois onde ele escreveu ja teria escrito.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ferramentas import ambiente_teste_cli as gerador

RAIZ = Path(__file__).resolve().parent.parent.parent


def test_toda_variavel_de_caminho_aponta_para_dentro_do_destino(tmp_path):
    base = tmp_path / "dados-teste"
    valores = gerador.variaveis_de_ambiente(base)

    fora = []
    for chave, valor in valores.items():
        if chave == "CSSO_BANCO_URL":
            valor = valor.split("///", 1)[1]
        elif not ("/" in valor or "\\" in valor):
            continue  # porta, host, ambiente: nao sao caminho
        if base.resolve() not in Path(valor).resolve().parents:
            fora.append(f"{chave} -> {valor}")

    assert not fora, "variavel de caminho fora do destino: " + "; ".join(fora)


def test_cobre_todo_diretorio_em_que_o_sistema_escreve():
    """O mapa do gerador acompanha `Config.diretorios_de_dados`, campo a campo.

    E a mesma trava de `testes/test_isolamento.py`, aplicada ao gerador: campo
    de diretorio novo entra em `diretorios_de_dados`, e se nao entrar aqui
    tambem, ele nasce apontando para `dados/` — que e onde a config o poe por
    padrao. O teste falha na hora, e nao no dia do backup.
    """
    from app.config import obter_config

    esperadas = {
        f"CSSO_{campo.upper()}" for campo in obter_config().diretorios_de_dados
    }
    faltando = esperadas - set(gerador.variaveis_de_ambiente(Path("qualquer")))
    assert not faltando, (
        "diretorio de dados sem variavel no gerador do ambiente de teste: "
        + ", ".join(sorted(faltando))
    )


@pytest.mark.parametrize(
    "destino",
    [
        "dados",
        "dados/teste",
        ".",
    ],
)
def test_destino_que_se_cruza_com_dados_e_recusado(destino):
    """Nos dois sentidos: povoar dentro de `dados/` e apagar `dados/` no rmtree."""
    with pytest.raises(gerador.DestinoProibido):
        gerador.conferir_destino(RAIZ / destino)


def test_destino_ao_lado_de_dados_e_aceito():
    gerador.conferir_destino(RAIZ / "dados-teste")


def test_a_porta_padrao_nao_e_a_do_sistema_de_verdade():
    """8765 e a instalacao do setor, e ela nao pode cair por causa de um teste."""
    from app.config import Config

    assert gerador.PORTA_PADRAO != Config.model_fields["porta"].default
    assert gerador.variaveis_de_ambiente(Path("x"))["CSSO_PORTA"] == str(
        gerador.PORTA_PADRAO
    )


# =====================================================================
# O endereco de ligacao sobrevive a recriacao
# =====================================================================
def test_ambiente_novo_atende_so_a_propria_maquina(tmp_path):
    """Sem `.env` anterior e sem `--host`, o padrao e o loopback: um ambiente
    de teste recem-nascido nao atende a rede por acidente."""
    base = tmp_path / "dados-teste"
    gerador.preparar(base, gerador.PORTA_PADRAO)
    assert "CSSO_HOST=127.0.0.1" in (base / ".env").read_text(encoding="utf-8")


def test_recriar_mantem_o_endereco_que_o_env_anterior_pedia(tmp_path):
    """O defeito que isto fecha: quem abriu o ambiente para a rede do setor
    (firewall aberto, endereco divulgado aos colegas) e depois rodou o
    `RECRIAR-TESTE.bat` para limpar os dados perdia o acesso de todo mundo —
    e nada na tela dizia por que. A pasta e descartavel; a DECISAO de atender
    a rede nao e, e ela nao mora nos dados."""
    base = tmp_path / "dados-teste"
    gerador.preparar(base, gerador.PORTA_PADRAO, "0.0.0.0")
    (base / "marca-que-some.txt").write_text("x", encoding="utf-8")

    gerador.preparar(base, gerador.PORTA_PADRAO)  # a recriacao, sem --host

    assert "CSSO_HOST=0.0.0.0" in (base / ".env").read_text(encoding="utf-8")
    assert not (base / "marca-que-some.txt").exists(), "os DADOS continuam descartaveis"


def test_o_host_pedido_na_linha_de_comando_vence_o_anterior(tmp_path):
    base = tmp_path / "dados-teste"
    gerador.preparar(base, gerador.PORTA_PADRAO, "0.0.0.0")
    gerador.preparar(base, gerador.PORTA_PADRAO, "127.0.0.1")
    assert "CSSO_HOST=127.0.0.1" in (base / ".env").read_text(encoding="utf-8")


def test_host_anterior_le_o_arquivo_e_nao_a_configuracao(tmp_path):
    base = tmp_path / "dados-teste"
    assert gerador.host_anterior(base) is None, "pasta que nao existe nao tem host"
    base.mkdir()
    assert gerador.host_anterior(base) is None, "pasta sem .env nao tem host"
    (base / ".env").write_text("CSSO_PORTA=8766\nCSSO_HOST=10.0.0.9\n", encoding="utf-8")
    assert gerador.host_anterior(base) == "10.0.0.9"
    (base / ".env").write_text("CSSO_HOST=\n", encoding="utf-8")
    assert gerador.host_anterior(base) is None, "vazio nao e endereco"
