"""HTTPS na rede do setor: a AC restrita, a renovacao e o aviso de vencimento.

O teste que importa e o do handshake: um servidor TLS de verdade, um cliente
que confia so na raiz gerada, e o OpenSSL decidindo. E ali tambem que se prova
que a restricao de nomes funciona — a mesma chave assinando outro endereco e
recusada pelo cliente, que e o que protege as estacoes se `ca.key` vazar.
"""

from __future__ import annotations

import socket
import ssl
import threading
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.servicos import tls


def _servir_uma_vez(certfile, keyfile) -> tuple[int, threading.Thread]:
    contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexto.load_cert_chain(certfile, keyfile)
    ouvinte = socket.socket()
    ouvinte.bind(("127.0.0.1", 0))
    ouvinte.listen(1)
    porta = ouvinte.getsockname()[1]

    def atender():
        conexao, _ = ouvinte.accept()
        try:
            with contexto.wrap_socket(conexao, server_side=True) as seguro:
                seguro.recv(1)
        except (ssl.SSLError, OSError):
            pass
        finally:
            ouvinte.close()

    fio = threading.Thread(target=atender, daemon=True)
    fio.start()
    return porta, fio


def _conectar(porta: int, ca: str, nome: str) -> None:
    contexto = ssl.create_default_context(cafile=ca)
    with socket.create_connection(("127.0.0.1", porta), timeout=5) as bruto:
        with contexto.wrap_socket(bruto, server_hostname=nome) as seguro:
            seguro.send(b"x")


def test_gera_ac_e_certificado_que_o_cliente_aceita(tmp_path):
    emissao = tls.emitir(tmp_path, ["127.0.0.1", "csso.teste"])
    assert emissao.ac_nova
    for arquivo in (tls.ARQ_AC, tls.ARQ_AC_CHAVE, tls.ARQ_CERT, tls.ARQ_CHAVE):
        assert (tmp_path / arquivo).is_file()

    porta, fio = _servir_uma_vez(tmp_path / tls.ARQ_CERT, tmp_path / tls.ARQ_CHAVE)
    _conectar(porta, str(tmp_path / tls.ARQ_AC), "127.0.0.1")
    fio.join(5)


@pytest.mark.parametrize("nomes", [["127.0.0.1"], ["localhost"]])
def test_so_ip_ou_so_nome_tambem_e_aceito(tmp_path, nomes):
    """O caso real da maquina do setor e so o IP. Com CN na folha, o OpenSSL o
    conferia como nome DNS contra a restricao e recusava — o teste acima, com IP
    e nome juntos, nao via."""
    tls.emitir(tmp_path, nomes)
    porta, fio = _servir_uma_vez(tmp_path / tls.ARQ_CERT, tmp_path / tls.ARQ_CHAVE)
    _conectar(porta, str(tmp_path / tls.ARQ_AC), nomes[0])
    fio.join(5)


def test_endereco_fora_do_certificado_e_recusado(tmp_path):
    tls.emitir(tmp_path, ["127.0.0.1"])
    porta, fio = _servir_uma_vez(tmp_path / tls.ARQ_CERT, tmp_path / tls.ARQ_CHAVE)
    with pytest.raises(ssl.SSLCertVerificationError):
        _conectar(porta, str(tmp_path / tls.ARQ_AC), "outro.nome")
    fio.join(5)


@pytest.mark.parametrize(
    "nomes_da_ac, alvo",
    [
        # a AC so com IP forjando nome DNS: o buraco da restricao POR TIPO
        (["10.0.73.198"], "banco.exemplo"),
        # a AC com nome forjando outro nome
        (["csso.teste"], "banco.exemplo"),
        # a AC so com nome forjando IP: o mesmo buraco, do outro lado
        (["csso.teste"], "127.0.0.1"),
        # a AC com IP forjando outro IP
        (["10.0.73.198"], "127.0.0.1"),
    ],
)
def test_a_chave_da_ac_nao_assina_outro_endereco(tmp_path, nomes_da_ac, alvo):
    """Se `ca.key` vazar, ela nao forja HTTPS para outro site nas estacoes."""
    import ipaddress

    tls.emitir(tmp_path, nomes_da_ac)
    ac = x509.load_pem_x509_certificate((tmp_path / tls.ARQ_AC).read_bytes())
    chave_ac = serialization.load_pem_private_key(
        (tmp_path / tls.ARQ_AC_CHAVE).read_bytes(), password=None
    )

    # o que um atacante com a chave faria: folha para um nome que a AC nao cobre
    try:
        san = x509.IPAddress(ipaddress.ip_address(alvo))
    except ValueError:
        san = x509.DNSName(alvo)
    chave = ec.generate_private_key(ec.SECP256R1())
    agora = datetime.now(timezone.utc)
    forjado = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, alvo)]))
        .issuer_name(ac.subject)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - timedelta(minutes=1))
        .not_valid_after(agora + timedelta(days=30))
        .add_extension(x509.SubjectAlternativeName([san]), critical=False)
        .sign(chave_ac, hashes.SHA256())
    )
    cert = tmp_path / "forjado.crt"
    cert.write_bytes(forjado.public_bytes(serialization.Encoding.PEM))
    chave_arq = tmp_path / "forjado.key"
    chave_arq.write_bytes(
        chave.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )

    porta, fio = _servir_uma_vez(cert, chave_arq)
    with pytest.raises(ssl.SSLCertVerificationError):
        _conectar(porta, str(tmp_path / tls.ARQ_AC), alvo)
    fio.join(5)


def test_restricao_de_nomes_e_critica(tmp_path):
    tls.emitir(tmp_path, ["10.0.73.198"])
    ac = x509.load_pem_x509_certificate((tmp_path / tls.ARQ_AC).read_bytes())
    extensao = ac.extensions.get_extension_for_class(x509.NameConstraints)
    # nao critica, um cliente que nao a entende poderia ignora-la
    assert extensao.critical


def test_renovar_reaproveita_a_ac(tmp_path):
    """Renovar nao pode obrigar a reinstalar a raiz em cada estacao."""
    tls.emitir(tmp_path, ["10.0.73.198"])
    raiz = (tmp_path / tls.ARQ_AC).read_bytes()
    folha = (tmp_path / tls.ARQ_CERT).read_bytes()

    renovada = tls.emitir(tmp_path, ["10.0.73.198"])
    assert not renovada.ac_nova
    assert (tmp_path / tls.ARQ_AC).read_bytes() == raiz
    assert (tmp_path / tls.ARQ_CERT).read_bytes() != folha


def test_nome_novo_fora_da_ac_e_recusado_sem_nova_ac(tmp_path):
    tls.emitir(tmp_path, ["10.0.73.198"])
    with pytest.raises(tls.NomeInvalido, match="--nova-ac"):
        tls.emitir(tmp_path, ["10.0.73.199"])
    # pedida explicitamente, sai AC nova
    assert tls.emitir(tmp_path, ["10.0.73.199"], nova_ac=True).ac_nova


@pytest.mark.parametrize("ruim", ["http://10.0.73.198", "maquina com espaco", "", ".x"])
def test_nome_invalido(tmp_path, ruim):
    with pytest.raises(tls.NomeInvalido):
        tls.emitir(tmp_path, [ruim])


def test_folha_nao_passa_do_teto_dos_navegadores(tmp_path):
    emissao = tls.emitir(tmp_path, ["10.0.73.198"])
    folha = x509.load_pem_x509_certificate((tmp_path / tls.ARQ_CERT).read_bytes())
    duracao = folha.not_valid_after_utc - folha.not_valid_before_utc
    assert duracao <= timedelta(days=398)
    assert emissao.vence_em == folha.not_valid_after_utc or abs(
        emissao.vence_em - folha.not_valid_after_utc
    ) < timedelta(seconds=1)


def test_avisos_de_vencimento(tmp_path):
    tls.emitir(tmp_path, ["10.0.73.198"])
    cert, chave = tmp_path / tls.ARQ_CERT, tmp_path / tls.ARQ_CHAVE
    vence = tls.vencimento(cert)

    assert tls.avisos(cert, chave) == []
    perto = tls.avisos(cert, chave, agora=vence - timedelta(days=10))
    assert perto and "vence em" in perto[0]
    vencido = tls.avisos(cert, chave, agora=vence + timedelta(days=1))
    assert vencido and "venceu" in vencido[0]


def test_avisos_de_arquivo_ausente(tmp_path):
    assert "nao existe" in tls.avisos(tmp_path / "x.crt", tmp_path / "x.key")[0]


def test_config_avisa_tls_pela_metade_e_para_de_avisar_texto_em_claro(tmp_path):
    from app.config import Config

    tls.emitir(tmp_path, ["10.0.73.198"])
    base = {"_env_file": None, "host": "0.0.0.0"}

    sem = Config(**base)
    assert any("viajam em claro" in a for a in sem.inseguro)

    metade = Config(**base, tls_certificado=str(tmp_path / tls.ARQ_CERT))
    assert not metade.tls_ativo
    assert any("So um de CSSO_TLS_CERTIFICADO" in a for a in metade.inseguro)

    com = Config(
        **base,
        tls_certificado=str(tmp_path / tls.ARQ_CERT),
        tls_chave=str(tmp_path / tls.ARQ_CHAVE),
    )
    assert com.tls_ativo
    assert not any("viajam em claro" in a for a in com.inseguro)


def test_primeiro_nome_e_o_endereco_anunciado(tmp_path):
    tls.emitir(tmp_path, ["10.0.73.198", "csso.teste"])
    assert tls.primeiro_nome(tmp_path / tls.ARQ_CERT) == "10.0.73.198"
