"""HTTPS na rede do setor: uma autoridade certificadora do proprio setor, restrita.

**Por que uma AC propria, e nao um certificado autoassinado.** O autoassinado
poe o aviso vermelho do navegador em toda estacao, todo dia, e ensina a equipe a
clicar em "continuar mesmo assim" — exatamente o gesto que um ataque na rede
precisa que ela faca. Uma AC instalada uma vez em cada estacao some com o aviso
e faz o aviso voltar a significar alguma coisa.

**Por que ela e restrita (Name Constraints).** Instalar uma raiz numa estacao e
dizer ao navegador "confie em tudo que esta chave assinar". Sem restricao, quem
copiasse `ca.key` da maquina do setor poderia forjar `gov.br` ou o banco de
qualquer colega. Com `NameConstraints` critica, a raiz so vale para os nomes e
enderecos do proprio sistema: a chave vazada nao assina nada fora disso que um
navegador aceite. O preco e que mudar o endereco do sistema pede AC nova (e
reinstalar a raiz) — que e o preco certo, porque mudar de endereco ja e evento.

**Validade.** A folha dura 397 dias, o teto que os navegadores aplicam a
certificado de servidor; renovar reaproveita a AC, entao a estacao nao precisa
de nada. A AC dura 10 anos.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

DIAS_FOLHA = 397
DIAS_AC = 3650
# a partir de quanto tempo antes do vencimento o sistema passa a avisar
AVISAR_DIAS_ANTES = 30

ARQ_AC = "ca.crt"
ARQ_AC_CHAVE = "ca.key"
ARQ_CERT = "servidor.crt"
ARQ_CHAVE = "servidor.key"


class NomeInvalido(ValueError):
    """Nome que nao e IP nem nome de maquina."""


def _agora() -> datetime:
    return datetime.now(timezone.utc)


def _nomes_alternativos(nomes: list[str]) -> list[x509.GeneralName]:
    saida: list[x509.GeneralName] = []
    for bruto in nomes:
        nome = bruto.strip()
        if not nome:
            continue
        try:
            saida.append(x509.IPAddress(ipaddress.ip_address(nome)))
            continue
        except ValueError:
            pass
        if any(c in nome for c in " /:\\") or nome.startswith("."):
            raise NomeInvalido(f"'{nome}' nao e endereco IP nem nome de maquina")
        saida.append(x509.DNSName(nome.lower()))
    if not saida:
        raise NomeInvalido("informe ao menos um IP ou nome pelo qual o sistema e aberto")
    return saida


# Nomes que nada na rede usa, para fechar um tipo de nome que nao foi pedido.
# `.invalid` e reservado pela RFC 2606 e nunca resolve; 0.0.0.0 e :: nao sao
# endereco de maquina nenhuma.
_DNS_NENHUM = x509.DNSName("invalid")
_IP_NENHUM = (
    x509.IPAddress(ipaddress.ip_network("0.0.0.0/32")),
    x509.IPAddress(ipaddress.ip_network("::/128")),
)


def _restricao(nomes: list[x509.GeneralName]) -> x509.NameConstraints:
    """So os nomes do sistema: IP vira sub-rede /32 (ou /128), nome vira ele mesmo.

    **A restricao vale POR TIPO de nome** (RFC 5280 SS4.2.1.10): uma AC que so
    permite `10.0.73.198` nao diz nada sobre nome DNS, e portanto assina
    qualquer site. Foi o teste do certificado forjado que mostrou. Por isso, o
    tipo que nao foi pedido e fechado com um nome que nao existe — permitir so
    `invalid` equivale a nao permitir DNS nenhum.
    """
    permitidos: list[x509.GeneralName] = []
    for nome in nomes:
        if isinstance(nome, x509.IPAddress):
            rede = ipaddress.ip_network(nome.value)  # /32 ou /128
            permitidos.append(x509.IPAddress(rede))
        else:
            permitidos.append(nome)
    if not any(isinstance(n, x509.DNSName) for n in permitidos):
        permitidos.append(_DNS_NENHUM)
    if not any(isinstance(n, x509.IPAddress) for n in permitidos):
        permitidos.extend(_IP_NENHUM)
    return x509.NameConstraints(permitted_subtrees=permitidos, excluded_subtrees=None)


def _gravar_chave(caminho: Path, chave: ec.EllipticCurvePrivateKey) -> None:
    caminho.write_bytes(
        chave.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    try:
        caminho.chmod(0o600)
    except OSError:  # pragma: no cover - Windows ignora o modo
        pass


def _ler_chave(caminho: Path) -> ec.EllipticCurvePrivateKey:
    chave = serialization.load_pem_private_key(caminho.read_bytes(), password=None)
    assert isinstance(chave, ec.EllipticCurvePrivateKey)
    return chave


def _gerar_ac(pasta: Path, nomes: list[x509.GeneralName]) -> tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    chave = ec.generate_private_key(ec.SECP256R1())
    sujeito = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "CSSO/Sisa UFVJM"),
            x509.NameAttribute(NameOID.COMMON_NAME, "AC do Sistema CSSO (uso interno)"),
        ]
    )
    agora = _agora()
    publica = chave.public_key()
    cert = (
        x509.CertificateBuilder()
        .subject_name(sujeito)
        .issuer_name(sujeito)
        .public_key(publica)
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - timedelta(minutes=5))
        .not_valid_after(agora + timedelta(days=DIAS_AC))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(_restricao(nomes), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(publica), critical=False)
        .sign(chave, hashes.SHA256())
    )
    (pasta / ARQ_AC).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _gravar_chave(pasta / ARQ_AC_CHAVE, chave)
    return cert, chave


def ac_cobre(ac: x509.Certificate, nomes: list[x509.GeneralName]) -> bool:
    """A AC existente autoriza todos estes nomes? Se nao, e preciso AC nova."""
    try:
        restricao = ac.extensions.get_extension_for_class(x509.NameConstraints).value
    except x509.ExtensionNotFound:
        return False
    permitidos = restricao.permitted_subtrees or []
    for nome in nomes:
        if isinstance(nome, x509.IPAddress):
            if not any(
                isinstance(p, x509.IPAddress) and nome.value in p.value for p in permitidos
            ):
                return False
        elif nome not in permitidos:
            return False
    return True


@dataclass
class Emissao:
    pasta: Path
    ac_nova: bool
    nomes: list[str]
    vence_em: datetime


def emitir(pasta: Path, nomes_brutos: list[str], *, nova_ac: bool = False) -> Emissao:
    """Emite (ou renova) o certificado do servidor, criando a AC se preciso.

    Reaproveita a AC que ja existe quando ela cobre os nomes pedidos: renovar
    nao pode obrigar a reinstalar a raiz em cada estacao. Se os nomes mudaram
    para fora do que a AC permite, recusa — a nao ser que `nova_ac` seja
    pedido explicitamente, porque AC nova significa ir de maquina em maquina.
    """
    nomes = _nomes_alternativos(nomes_brutos)
    pasta.mkdir(parents=True, exist_ok=True)

    ac_nova = False
    if nova_ac or not (pasta / ARQ_AC).is_file() or not (pasta / ARQ_AC_CHAVE).is_file():
        ac, chave_ac = _gerar_ac(pasta, nomes)
        ac_nova = True
    else:
        ac = x509.load_pem_x509_certificate((pasta / ARQ_AC).read_bytes())
        chave_ac = _ler_chave(pasta / ARQ_AC_CHAVE)
        if not ac_cobre(ac, nomes):
            raise NomeInvalido(
                "a AC existente nao cobre estes nomes (ela so vale para os nomes "
                "com que foi criada). Rode de novo com --nova-ac e reinstale a raiz "
                "nas estacoes."
            )

    chave = ec.generate_private_key(ec.SECP256R1())
    agora = _agora()
    vence = agora + timedelta(days=DIAS_FOLHA)
    # Sem CN, de proposito. Quando a folha nao tem nome DNS (o caso tipico
    # aqui: so o IP), o OpenSSL confere o CN como se fosse nome DNS contra a
    # restricao da AC — e `10.0.73.198` no CN cai fora do DNS permitido, que e
    # so `invalid`. Os navegadores ignoram o CN ha anos; o nome vale pelo SAN.
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Sistema CSSO")]))
        .issuer_name(ac.subject)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - timedelta(minutes=5))
        .not_valid_after(vence)
        .add_extension(x509.SubjectAlternativeName(nomes), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ac.public_key()),
            critical=False,
        )
        .sign(chave_ac, hashes.SHA256())
    )
    # a folha seguida da AC: o navegador que ja confia na raiz monta a cadeia
    # sozinho, mas o `curl` e o Python pedem a cadeia servida inteira
    (pasta / ARQ_CERT).write_bytes(
        cert.public_bytes(serialization.Encoding.PEM)
        + ac.public_bytes(serialization.Encoding.PEM)
    )
    _gravar_chave(pasta / ARQ_CHAVE, chave)
    return Emissao(
        pasta=pasta,
        ac_nova=ac_nova,
        nomes=[str(n.value) for n in nomes],
        vence_em=vence,
    )


def vencimento(caminho_cert: Path) -> datetime | None:
    """Quando o certificado servido vence; None se o arquivo nao se le."""
    try:
        cert = x509.load_pem_x509_certificate(caminho_cert.read_bytes())
    except (OSError, ValueError):
        return None
    return cert.not_valid_after_utc


def primeiro_nome(caminho_cert: Path) -> str | None:
    """O primeiro nome do certificado — o endereco que a janela do servidor anuncia."""
    try:
        cert = x509.load_pem_x509_certificate(caminho_cert.read_bytes())
        nomes = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except (OSError, ValueError, x509.ExtensionNotFound):
        return None
    for nome in nomes:
        return str(nome.value)
    return None


def avisos(caminho_cert: Path, caminho_chave: Path, agora: datetime | None = None) -> list[str]:
    """O que a config diz no boot, no /saude e na casca de toda tela."""
    saida: list[str] = []
    if not caminho_cert.is_file():
        saida.append(f"CSSO_TLS_CERTIFICADO aponta para {caminho_cert}, que nao existe.")
        return saida
    if not caminho_chave.is_file():
        saida.append(f"CSSO_TLS_CHAVE aponta para {caminho_chave}, que nao existe.")
        return saida
    vence = vencimento(caminho_cert)
    if vence is None:
        saida.append(f"{caminho_cert} nao e um certificado PEM legivel.")
        return saida
    agora = agora or _agora()
    if vence <= agora:
        saida.append(
            "O certificado HTTPS venceu em "
            f"{vence:%d/%m/%Y}: os navegadores recusam a conexao. Renove com "
            "`python -m ferramentas.certificado_tls` e reinicie o sistema."
        )
    elif vence - agora <= timedelta(days=AVISAR_DIAS_ANTES):
        saida.append(
            f"O certificado HTTPS vence em {vence:%d/%m/%Y}. Renove com "
            "`python -m ferramentas.certificado_tls` e reinicie o sistema — as "
            "estacoes nao precisam de nada."
        )
    return saida
