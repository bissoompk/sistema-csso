"""Configuracao do sistema. Tudo vem do .env - nada fica no codigo."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

RAIZ = Path(__file__).resolve().parent.parent

VERSAO = "1.43.0"
RODAPE_INSTITUCIONAL = "Sistema de apoio da CSSO. O processo oficial e o SEI."

# Enderecos de ligacao que so a propria maquina alcanca. Nao decidem mais o
# `Secure` do cookie — isso e da requisicao, e o argumento esta em
# `app/seguranca.cookie_seguro`. Decidem outra coisa, que o endereco de ligacao
# DE FATO sabe: se existe alguem alem desta maquina capaz de chegar na porta.
SO_LOOPBACK = ("127.0.0.1", "localhost", "::1")


def caminho_env_file() -> Path:
    """O .env que vale AGORA.

    `CSSO_ENV_FILE` existe para a suite de testes apontar para um .env
    descartavel. Fora de teste a variavel nao existe e cai no .env da raiz -
    que e o que a aplicacao e as ferramentas de linha de comando leem.
    """
    return Path(os.environ.get("CSSO_ENV_FILE", str(RAIZ / ".env")))


class EnvFileAusente(RuntimeError):
    """`CSSO_ENV_FILE` foi apontado e o arquivo nao esta la.

    Nao e um aviso: e recusa de subir. O pydantic-settings trata env_file
    inexistente como "sem arquivo" e segue com os padroes da classe - e os
    padroes sao `dados/csso.db`, `dados/documentos`, `dados/anexos`: a pasta
    de producao. Aconteceu em 05/09/2026: um lancador montou a variavel com
    `%CD%` que nao expandiu, e o "ambiente de teste" subiu na porta 8766
    lendo o banco real, sem uma linha de erro. Quem aponta o arquivo
    explicitamente esta dizendo "NAO leia o da raiz"; se o apontado sumiu,
    o unico comportamento honesto e parar.
    """


class Config(BaseSettings):
    # `env_file` NAO entra aqui de proposito. O corpo da classe e avaliado no
    # import de `app.config`, e o pytest importa este modulo durante a coleta -
    # antes de qualquer conftest conseguir exportar CSSO_ENV_FILE. Congelado no
    # model_config, o valor lido era sempre o .env de producao, e por isso a
    # suite nascia apontando para `dados/` real e escrevia documento de teste
    # por cima da pasta do setor. A resolucao vai para `__init__`.
    model_config = SettingsConfigDict(
        env_prefix="CSSO_",
        extra="ignore",
        env_file_encoding="utf-8",
    )

    host: str = "127.0.0.1"
    porta: int = 8765
    abrir_navegador: bool = True

    # O `Secure` do cookie de sessao. `auto` pergunta a REQUISICAO (o esquema
    # efetivo, que o ProxyHeadersMiddleware do uvicorn ja corrige a partir do
    # X-Forwarded-Proto); `sim` e a declaracao de quem instalou, para o caso em
    # que ha TLS num proxy que o uvicorn nao confia e o esquema chega `http`
    # mesmo assim; `nao` desliga. O argumento inteiro esta em
    # `app/seguranca.cookie_seguro` — inclusive por que o padrao falha para o
    # lado que deixa entrar. Ate a 1.31.0 esta decisao saia de `host`, que nao
    # sabe nada sobre a conexao, e `CSSO_HOST=0.0.0.0` trancava todo mundo do
    # lado de fora.
    cookie_seguro: str = "auto"

    # HTTPS servido pelo proprio sistema. Os dois vazios = http, como sempre foi.
    # Preenchidos, o uvicorn fala TLS nesta porta (e so TLS: `http://` nela deixa
    # de responder). Os arquivos saem de `python -m ferramentas.certificado_tls`,
    # que cria a AC restrita do setor — o porque de ser AC, e restrita, esta em
    # `app/servicos/tls.py`. Com TLS aqui, `cookie_seguro=auto` ja acerta sozinho:
    # o esquema da requisicao passa a ser `https`.
    tls_certificado: str = ""
    tls_chave: str = ""

    banco_url: str = "sqlite+pysqlite:///dados/csso.db"

    # Chaveia o HMAC-SHA256 do token de sessao (`autenticacao._hash_token`). Nao
    # e enfeite: trocar este valor invalida toda sessao aberta de todo mundo, no
    # ato, sem tocar no banco — que e o que faz existir algo a rotacionar depois
    # de um incidente. Ate a 1.30.0 o campo nao era lido por nada e o aviso do
    # /saude prometia uma protecao que nao havia.
    chave_secreta: str = "desenvolvimento-inseguro-troque"
    sessao_horas: int = 12
    max_tentativas: int = 5
    bloqueio_minutos: int = 15

    dir_documentos: str = "dados/documentos"
    dir_anexos: str = "dados/anexos"
    dir_entrada: str = "entrada"
    perfil_lo: str = "dados/perfil_lo"
    dir_logs: str = "dados/logs"

    # 90 dias e o prazo que `docs/POLITICA_RETENCAO.md` da a `sessao`, e pelo
    # mesmo motivo: o IP. O registro de acesso guarda o mesmo dado pessoal, e
    # dois prazos para o mesmo dado na mesma instalacao seria politica que se
    # contradiz. Aqui o prazo e cumprido pelo mecanismo (rotacao diaria com
    # `backupCount`), nao so declarado.
    log_acesso: bool = True
    log_retencao_dias: int = 90

    backup_destino: str = "dados/backups"
    backup_senha: str = "backup-inseguro-troque"

    soffice: str = ""

    # --- Onde retirar o EPI reservado ---------------------------------
    # O sistema NAO sabia responder isto, e a auditoria da jornada mediu a
    # lacuna: no estado RESERVADO a ficha do pedido dizia o lote e o CA, e as
    # palavras "retirada", "balcao" e "almoxarifado" nao apareciam em tela
    # nenhuma. A pessoa sabia que o equipamento estava separado com o nome dela e
    # nao sabia a que porta bater — era o ponto exato em que a jornada voltava
    # para o telefone.
    #
    # Nao ha de onde deduzir: `epi_entrada_estoque` guarda pregao, empenho e
    # fornecedor, e nenhuma coluna de localizacao; `unidade_uorg` e `campus` sao
    # a lotacao de QUEM PEDE, que nao e onde o almoxarifado funciona; e o
    # endereco do `setor_emissor` e o do setor que assina parecer, que pode nao
    # ser o balcao. Inventar qualquer um dos tres seria mandar gente ao lugar
    # errado com a aparencia de informacao do sistema — pior do que nao ter.
    #
    # Entao e parametro de quem instala, preenchido uma vez: predio, sala e
    # horario, em texto livre, porque a forma disso muda de campus para campus.
    # Vazio, a tela diz que o local ainda nao esta registrado, e nao finge.
    epi_local_retirada: str = ""

    ambiente: str = "local"
    fuso_exibicao: str = "America/Sao_Paulo"

    def __init__(self, **dados: Any) -> None:
        # Resolvido na instanciacao: vale o que o ambiente diz no momento em que
        # a config e construida, nunca o que ele dizia no momento do import.
        # E o que faz o isolamento da suite parar de depender de ordem de import.
        if "_env_file" not in dados:
            env = caminho_env_file()
            if "CSSO_ENV_FILE" in os.environ and not env.is_file():
                raise EnvFileAusente(
                    f"CSSO_ENV_FILE aponta para {env}, que nao existe. Sem ele a "
                    "configuracao cairia em silencio nos caminhos padrao - a pasta "
                    "dados/ de producao. Corrija a variavel (ou rode "
                    "RECRIAR-TESTE.bat, se for o ambiente de teste)."
                )
            dados["_env_file"] = env
        super().__init__(**dados)

    # ---- caminhos absolutos derivados -------------------------------
    def caminho(self, relativo: str) -> Path:
        p = Path(relativo)
        return p if p.is_absolute() else (RAIZ / p)

    @property
    def caminho_banco(self) -> Path:
        prefixo = "sqlite+pysqlite:///"
        if not self.banco_url.startswith(prefixo):
            raise ValueError("banco_url deve ser sqlite+pysqlite:///...")
        return self.caminho(self.banco_url[len(prefixo) :])

    @property
    def url_sqlalchemy(self) -> str:
        return "sqlite+pysqlite:///" + self.caminho_banco.as_posix()

    @property
    def diretorios_de_dados(self) -> dict[str, Path]:
        """Todo diretorio em que o sistema escreve, indexado pelo nome do campo.

        Fonte unica de verdade: `preparar_diretorios` cria estes, e a trava de
        isolamento da suite (`testes/test_isolamento.py`) confere estes. Campo
        de diretorio novo entra AQUI - senao ele nao e criado no boot e, pior,
        escapa da trava e volta a poder ser escrito por teste.
        """
        return {
            "dir_documentos": self.caminho(self.dir_documentos),
            "dir_anexos": self.caminho(self.dir_anexos),
            "dir_entrada": self.caminho(self.dir_entrada),
            "perfil_lo": self.caminho(self.perfil_lo),
            "backup_destino": self.caminho(self.backup_destino),
            "dir_logs": self.caminho(self.dir_logs),
        }

    def preparar_diretorios(self) -> None:
        for caminho in self.diretorios_de_dados.values():
            caminho.mkdir(parents=True, exist_ok=True)
        self.caminho_banco.parent.mkdir(parents=True, exist_ok=True)

    @property
    def tls_ativo(self) -> bool:
        return bool(self.tls_certificado.strip() and self.tls_chave.strip())

    @property
    def inseguro(self) -> list[str]:
        """Avisos de configuracao exibidos no /saude e no boot."""
        avisos: list[str] = []
        if "troque" in self.chave_secreta:
            avisos.append("CSSO_CHAVE_SECRETA ainda e o valor de exemplo.")
        if "troque" in self.backup_senha:
            avisos.append("CSSO_BACKUP_SENHA ainda e o valor de exemplo.")

        # Os tres avisos de rede. Saem daqui, e nao de um `print` do
        # INICIAR.bat, porque `inseguro` e lido em tres lugares — o boot, o
        # /saude e a casca de TODA tela — e a escolha errada de `Secure` e
        # justamente a que ninguem descobre olhando: ela se manifesta como um
        # login que volta para o login, sem mensagem nenhuma.
        modo = (self.cookie_seguro or "").strip().lower()
        if modo not in ("auto", "sim", "nao"):
            avisos.append(
                f"CSSO_COOKIE_SEGURO='{self.cookie_seguro}' nao e um valor valido "
                "(auto, sim ou nao). Valendo: auto."
            )
        elif modo == "sim":
            avisos.append(
                "CSSO_COOKIE_SEGURO=sim: o cookie de sessao so vai por HTTPS. "
                "Se nao houver TLS de verdade a frente, o login volta para a "
                "tela de login e ninguem entra."
            )
        elif modo == "nao":
            avisos.append(
                "CSSO_COOKIE_SEGURO=nao: o cookie de sessao vai sem o atributo "
                "Secure mesmo havendo HTTPS."
            )
        if bool(self.tls_certificado.strip()) != bool(self.tls_chave.strip()):
            avisos.append(
                "So um de CSSO_TLS_CERTIFICADO e CSSO_TLS_CHAVE esta preenchido: o "
                "sistema continua em http. Preencha os dois, ou nenhum."
            )
        if self.tls_ativo:
            from app.servicos import tls

            avisos.extend(
                tls.avisos(self.caminho(self.tls_certificado), self.caminho(self.tls_chave))
            )
        elif self.host not in SO_LOOPBACK:
            avisos.append(
                f"O sistema esta ligado em {self.host} - a porta e alcancavel por "
                "outras maquinas. Sem TLS, senha e sessao viajam em claro na rede. "
                "Ligue o HTTPS: veja docs/HTTPS_NA_REDE.md."
            )
        alvo = str(self.caminho_banco).lower()
        for nuvem in ("onedrive", "dropbox", "google drive", "\\meu drive"):
            if nuvem in alvo:
                avisos.append(
                    f"O banco esta em pasta sincronizada ({nuvem}) - SQLite corrompe. Mova para disco local."
                )
        return avisos


@lru_cache(maxsize=1)
def obter_config() -> Config:
    cfg = Config()
    cfg.preparar_diretorios()
    return cfg
