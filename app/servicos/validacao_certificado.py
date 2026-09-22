"""A validacao publica por chave — a regra, sem a tela.

Fatia 5 do desenho de Certificados. Ela existe hoje por um motivo que nao e de
funcionalidade: **`emissao_certificado.py` ja imprime `{url_base}/validar/{chave}`
no QR e no texto de todo certificado emitido**, e a rota nao existia. Cada papel
que saiu do setor circula com um endereco que responde 404 — e papel nao se
atualiza depois de entregue. O defeito nao para de crescer enquanto a rota nao
existe, e por isso ele veio antes das outras metades da fatia.

Duas decisoes moram neste arquivo, e as duas sao de privacidade.

**1. A pagina nao exibe o nome de quem se formou.** E o que o desenho manda
(§5), o que o `app/modulos.py` declarou por escrito quando anunciou o item, e o
que o `docs/ROPA.md` §5 registra como compartilhamento com o publico em geral:
"existencia e validade de um certificado". Quem tem a chave normalmente tem o
papel na mao, onde o nome ja esta; quem so tem a chave nao pode ganhar um nome de
presente. O risco que a ausencia fecha nao e o do portador legitimo — e o da
**enumeracao** (varrer chaves para colher nomes) e o do encaminhamento da chave
sem o papel.

Mascara parcial (`M**** A***** de S****`) esta fora por coerencia com a regra de
casa do `ROPA.md` §6: minimizacao por identificador opaco, **nunca** por mascara
parcial. O que sai no lugar do nome e o `identificador_publico` do participante
(`PTC-xxxxxxxx`), que e estavel de proposito — uma chave de validacao que muda a
cada consulta nao valida coisa nenhuma — e a **conferencia por digitacao**: quem
tem o papel escreve o nome e recebe confere / nao confere. Um bit, nao um nome.

**2. Sem autenticacao.** A pagina existe para quem NAO tem conta: o orgao, a
empresa ou a chefia de outra instituicao que recebeu o certificado e quer saber
se ele e autentico. Exigir login a esvaziaria — quem tem conta aqui ja abre
`/certificados` ou `/certificados/meus`, e e exatamente quem nao precisa dela. O
custo de exigir login seria a funcionalidade inteira.

O que isso NAO decide: **expor o sistema na rede**. Hoje ele so e alcancavel
pela rede do setor, e o `ROPA.md` §6 registra que publicar `/validar` e `/publico`
"muda o perfil de risco do sistema inteiro" e e decisao institucional a tomar com
o TI. A rota nao toma essa decisao nem a antecipa: ela e alcancavel exatamente de
onde todas as outras ja sao. O que ela faz e garantir que, no dia em que a
decisao for tomada, o endereco impresso em milhares de papeis responda — e que
ate la ele responda para quem esta na rede do setor, em vez de 404 para todo
mundo.

A higiene que a rota carrega e a mesma da §5 do desenho, e ela vale desde ja:
limite por IP, resposta identica para chave inexistente / malformada / com
digito errado, `noindex` e `no-store`, nenhuma listagem, nenhuma busca por nome,
nenhum link para baixar o documento.

**O que ficou de fora, e esta declarado:** a pendencia `CONSULTA_PUBLICA_ANOMALA`
para rajada acima do limite (o §5 a preve; ela mora em `servicos/pendencias.py`).
O limite continua valendo — o que falta e o aviso ao setor, e a rajada continua
visivel no registro de acesso, que grava toda requisicao com IP e caminho.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import Certificado
from app.servicos import textos
from app.servicos.certificado import (
    ContextoCertificado,
    chave_valida,
    normalizar_chave,
)
from app.servicos.presenca import numero as numero_br

# =====================================================================
# Antienumeracao: o limite por IP
# =====================================================================
# Em memoria do processo, e isso e uma escolha e nao uma limitacao aceita: o
# sistema e de processo unico (o `INICIAR.bat` sobe um uvicorn), e uma tabela de
# contagem faria toda consulta publica ESCREVER no banco — que e o unico lock de
# escrita do SQLite (RN-03), disputado com quem esta trabalhando. Reiniciar o
# servico zera os contadores; e o preco, e ele e menor do que o de transformar
# uma leitura publica em escrita.
JANELA_CURTA_S = 60
LIMITE_CURTO = 10
JANELA_LONGA_S = 3600
LIMITE_LONGO = 100

# {ip: deque de instantes}. O deque e podado a cada consulta pela janela longa,
# entao ele nunca guarda mais de `LIMITE_LONGO` instantes por IP.
_tentativas: dict[str, deque[float]] = {}


def _agora() -> float:
    return time.monotonic()


def limpar_limites() -> None:
    """Zera os contadores. Existe para o teste, e para o boot ser explicito."""
    _tentativas.clear()


def dentro_do_limite(ip: str | None) -> bool:
    """Registra a tentativa e diz se ela cabe no limite.

    Conta ANTES de olhar a chave, e de proposito: contar so o que falha
    convidaria a varrer com chaves validas conhecidas, e contar so o que acerta
    nao limitaria a varredura nenhuma.
    """
    chave = ip or "desconhecido"
    agora = _agora()
    fila = _tentativas.setdefault(chave, deque())
    while fila and agora - fila[0] > JANELA_LONGA_S:
        fila.popleft()
    fila.append(agora)
    if len(fila) > LIMITE_LONGO:
        return False
    recentes = sum(1 for t in fila if agora - t <= JANELA_CURTA_S)
    return recentes <= LIMITE_CURTO


# =====================================================================
# A resposta
# =====================================================================
@dataclass(frozen=True)
class Resposta:
    """O que a pagina publica pode dizer. Sem nome, e sem caminho para o papel.

    `encontrado=False` responde por tres casos que a tela **nao** distingue:
    chave malformada, digito verificador errado e chave que nao existe. Dizer
    "certificado nao encontrado" para uma e "chave invalida" para outra ja e meia
    informacao — e a metade que sobra e justamente a que orienta quem varre.
    """

    encontrado: bool
    chave: str = ""
    situacao: str = ""
    treinamento: str = ""
    norma: str = ""
    carga_horaria: str = ""
    # `turma_data_fim`, e nao `data_base_vencimento`: e o "Data de termino" que
    # o proprio .docx imprime (`CAMPOS_CERTIFICADO`), e esta pagina existe para
    # conferir o que esta no papel. A data base do vencimento pode ser outra
    # quando a turma a sobrescreve, e exibi-la sob o rotulo de conclusao faria a
    # tela discordar do documento nos casos em que discordar importa.
    termino: date | None = None
    vencimento: date | None = None
    validade_meses: int = 0
    instrutores: tuple[str, ...] = ()
    emissor: str = ""
    numero: str = ""
    identificador_participante: str = ""


def _nome_do_instrutor(dados: dict) -> str:
    """Nome e titulo do instrutor.

    Instrutor sai, participante nao, e a assimetria e a do §5: quem ministra
    assina o documento como profissional, e o titulo dele e o que da credito ao
    papel. Quem foi avaliado esta na outra ponta da relacao.
    """
    nome = (dados.get("nome") or "").strip()
    titulo = (dados.get("titulo") or "").strip()
    return f"{nome} — {titulo}" if nome and titulo else nome


def consultar(s: Session, bruta: str | None, hoje: date | None = None) -> Resposta:
    """A chave digitada vira resposta — ou a mesma negativa de sempre.

    O digito verificador e conferido ANTES de o banco ser tocado: 29 de cada 30
    digitacoes erradas morrem aqui, e e isso que impede o limite por IP de ser
    gasto por quem so errou uma letra copiando do papel.

    Isso torna a negativa por formato mais RAPIDA que a negativa por chave
    inexistente, e a §5 pedia latencia identica. A diferenca nao entrega nada:
    o formato e o digito sao calculaveis fora do sistema, com o algoritmo que
    qualquer certificado impresso ja revela pelo proprio exemplo. O que a
    latencia nao pode separar — e nao separa — e "existe" de "nao existe", que
    sao os dois casos que passam pelo banco.
    """
    chave = normalizar_chave(bruta)
    if not chave_valida(chave):
        return Resposta(encontrado=False)
    certificado = s.execute(
        select(Certificado).where(Certificado.chave_validacao == chave)
    ).scalar_one_or_none()
    if certificado is None:
        return Resposta(encontrado=False)

    # Descongela pela MESMA funcao que a segunda via usa, e nao lendo o dicionario
    # cru: as datas do congelado sao texto ISO, e um `date.fromisoformat` escrito
    # aqui seria a segunda regra de leitura do congelado — a que divergiria da
    # primeira no dia em que o formato mudasse.
    contexto = ContextoCertificado.descongelar(certificado.contexto_congelado or {})
    quando = hoje or date.today()
    instrutores = tuple(
        nome
        for nome in (_nome_do_instrutor(i) for i in contexto.instrutores)
        if nome
    )
    return Resposta(
        encontrado=True,
        chave=chave,
        # estado, calculado agora — nunca congelado: um certificado congelado
        # como "valido" continuaria valido depois de vencer e de ser anulado
        situacao=certificado.situacao_publica(quando),
        # `or ""` em todo campo de texto: `descongelar` devolve `None` para chave
        # ausente, e um congelado incompleto (linha inserida a mao, migracao
        # antiga) faria a pagina publica escrever a palavra "None" no lugar do
        # nome do treinamento. Campo vazio e honesto; "None" parece defeito de
        # um certificado que pode estar perfeito.
        treinamento=contexto.treinamento_nome or "",
        norma=contexto.treinamento_norma or "",
        carga_horaria=numero_br(contexto.carga_horaria),
        termino=contexto.turma_data_fim,
        vencimento=certificado.data_vencimento,
        validade_meses=certificado.validade_meses_congelada,
        instrutores=instrutores,
        emissor=contexto.setor_nome or contexto.setor_sigla or "",
        numero=certificado.rotulo,
        identificador_participante=contexto.participante_identificador or "",
    )


# =====================================================================
# A conferencia do nome — no lugar da exibicao
# =====================================================================
# Particulas fora da comparacao: "Marco Antonio Alves Schetino" e "Marco Antonio
# Alves de Schetino" sao a mesma pessoa para quem copia do papel, e recusar por
# um "de" transformaria a conferencia num quiz de digitacao.
_PARTICULAS = frozenset({"de", "da", "do", "das", "dos", "e", "del", "di", "van"})


def _forma_de_comparar(nome: str | None) -> str:
    partes = [
        parte
        for parte in textos.chave_busca(nome).split()
        if parte not in _PARTICULAS
    ]
    return " ".join(partes)


def confere_o_nome(s: Session, chave: str, digitado: str | None) -> bool | None:
    """`True` confere, `False` nao confere, `None` nao ha o que conferir.

    Um bit, e nunca o nome. Quem tem o papel confirma que ele e daquela pessoa —
    que e o unico uso legitimo; quem so tem a chave leva a resposta de um bit, e
    reconstruir um nome por tentativa e inviavel sob o mesmo limite por IP que
    guarda a consulta.

    Le o nome do CONGELADO, e nao do cadastro de hoje: o papel na mao da pessoa
    diz o que dizia no dia da emissao, e conferir contra um nome alterado depois
    responderia "nao confere" a um documento autentico.
    """
    limpo = (digitado or "").strip()
    if not limpo:
        return None
    certificado = s.execute(
        select(Certificado).where(Certificado.chave_validacao == normalizar_chave(chave))
    ).scalar_one_or_none()
    if certificado is None:
        return None
    contexto = ContextoCertificado.descongelar(certificado.contexto_congelado or {})
    esperado = _forma_de_comparar(contexto.participante_nome)
    return bool(esperado) and _forma_de_comparar(limpo) == esperado


__all__ = [
    "JANELA_CURTA_S",
    "JANELA_LONGA_S",
    "LIMITE_CURTO",
    "LIMITE_LONGO",
    "Resposta",
    "confere_o_nome",
    "consultar",
    "dentro_do_limite",
    "limpar_limites",
]
