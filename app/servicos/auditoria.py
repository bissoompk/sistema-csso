"""Trilha de auditoria append-only com encadeamento anti-adulteracao."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session, aliased

from app.modelos import (
    AcessoDadoSensivel,
    ConferenciaCadeia,
    HistoricoEvento,
    agora_utc,
)
from app.servicos.rbac import UsuarioAtual

# Eventos com nome fixo - usados por relatorios e testes
REUSO_DE_LAUDO = "REUSO_DE_LAUDO"
ASSINATURA_NEGADA = "ASSINATURA_NEGADA"
EXCECAO_ART9_APLICADA = "EXCECAO_ART9_APLICADA"
HABILITACAO_EXTERNA_ATESTADA = "HABILITACAO_EXTERNA_ATESTADA"
ANO_INFERIDO = "ANO_INFERIDO"
PARECER_EMITIDO = "PARECER_EMITIDO"
PARECER_ANULADO = "PARECER_ANULADO"
LAUDO_SUPERADO = "LAUDO_SUPERADO"
ESTADO_ALTERADO = "ESTADO_ALTERADO"
NUP_DV_DISPENSADO = "NUP_DV_DISPENSADO"
PRESCRICAO_QUINQUENAL_ALERTADA = "PRESCRICAO_QUINQUENAL_ALERTADA"
ANEXO_DUPLICADO = "ANEXO_DUPLICADO"
BOOTSTRAP_SUPERINTENDENTE = "BOOTSTRAP_SUPERINTENDENTE"
# O documento saiu, o PDF nao. A conversao acontece DEPOIS do commit (o
# LibreOffice nao pode segurar o lock de escrita), entao a falha dele encontra o
# documento ja emitido e o numero ja consumido — e desfazer nao e opcao: a
# numeracao e sequencial e nao volta (RN-03). O que resta e nao deixar a falha
# passar em silencio, e o lugar de uma falha que nao se apaga e a cadeia.
PDF_NAO_GERADO = "PDF_NAO_GERADO"


# ---------------------------------------------------------------------
# O nome do evento na tela
# ---------------------------------------------------------------------
# `tipo_evento` e chave: entra no digest da cadeia (`_digerir`), e o filtro de
# /auditoria consulta por ela. Ela nao muda. O que faltava era o rotulo — o
# painel, a ficha do processo, a trilha da requisicao e a do certificado
# imprimiam `NUMERO_DEFINIDO_MANUALMENTE` em negrito, na posicao de destaque,
# ao lado de uma descricao que ja estava em portugues e ja dizia tudo.
#
# O mapa mora aqui, e nao no template, porque a trilha aparece em quatro telas
# de tres modulos: no template ele seria copiado quatro vezes e divergiria na
# primeira delas que alguem mexesse — que e exatamente como nasceram os dois
# idiomas de filtro do sistema.
ROTULO_EVENTO: dict[str, str] = {
    # --- fundacao e conta ---
    "BOOTSTRAP_SUPERINTENDENTE": "Primeiro acesso do superintendente",
    "USUARIO_CRIADO": "Conta criada",
    "USUARIO_ATIVADO": "Conta ativada",
    "USUARIO_INATIVADO": "Conta inativada",
    "SENHA_RESETADA": "Senha redefinida",
    "PERFIL_CONCEDIDO": "Perfil concedido",
    "HABILITACAO_ATESTADA": "Habilitação atestada",
    "HABILITACAO_EXTERNA_ATESTADA": "Habilitação externa atestada",
    "BACKUP_EXECUTADO": "Backup executado",
    "EXPORTACAO_COMPLETA": "Exportação completa",
    # --- generico da trilha ---
    "CAMPO_ALTERADO": "Campo alterado",
    "PDF_NAO_GERADO": "PDF não gerado",
    "ESTADO_ALTERADO": "Estado alterado",
    "COMENTARIO": "Comentário",
    "AVISO": "Aviso",
    # --- processo (modulo Adicional Ocupacional) ---
    "PROCESSO_CRIADO": "Processo criado",
    "RESPONSAVEL_ALTERADO": "Responsável alterado",
    "SLA_ALTERADO": "Prazo de SLA alterado",
    "NUP_DV_DISPENSADO": "Dígito verificador do NUP dispensado",
    "CHECKLIST_APLICADO": "Checklist aplicado",
    "ANEXO_ENVIADO": "Anexo enviado",
    "ANEXO_DUPLICADO": "Anexo idêntico já existente",
    # nasce com `servicos/anexo_acesso.py`: e a linha que diz QUAL arquivo saiu.
    # `acesso_dado_sensivel` diz de quem e o dado; a trilha diz qual documento
    # dessa pessoa foi lido, e diz de um jeito que nao se apaga.
    "ANEXO_BAIXADO": "Anexo baixado",
    "ANO_INFERIDO": "Ano inferido na carga",
    "CONFLITO_NUMERACAO": "Conflito de numeração",
    "LOTACAO_ALTERADA": "Lotação alterada",
    "SERVIDOR_CRIADO": "Servidor cadastrado",
    # --- laudo e parecer ---
    "PARECER_RASCUNHO_CRIADO": "Rascunho de parecer criado",
    "NUMERO_DEFINIDO_MANUALMENTE": "Número definido manualmente",
    "EXPOSICAO_ADICIONADA": "Exposição adicionada",
    "CLASSIFICACAO_DIVERGENTE": "Classificação divergente da apurada",
    "EXCECAO_ART9_APLICADA": "Exceção do art. 9º aplicada",
    "EPI_NEUTRALIZACAO_AVALIADA": "Neutralização por EPI avaliada",
    "PARECER_EMITIDO": "Parecer emitido",
    "PARECER_ASSINADO": "Parecer assinado",
    "PARECER_ANULADO": "Parecer anulado",
    "ASSINATURA_NEGADA": "Assinatura negada",
    "PRESCRICAO_QUINQUENAL_ALERTADA": "Prescrição quinquenal alertada",
    "REUSO_DE_LAUDO": "Reuso de laudo",
    "LAUDO_SUPERADO": "Laudo superado",
    # --- direito ao adicional ---
    "DIREITO_PROPOSTO": "Adicional proposto",
    "DIREITO_VIGENTE": "Adicional vigente",
    "DIREITO_SUSPENSO": "Adicional suspenso",
    "DIREITO_EM_REAVALIACAO": "Adicional em reavaliação",
    "DIREITO_ALTERADO": "Adicional alterado",
    "DIREITO_CESSADO": "Adicional cessado",
    # --- pendencias ---
    "PENDENCIA_ABERTA": "Pendência aberta",
    "PENDENCIA_REABERTA": "Pendência reaberta",
    "PENDENCIA_CONCLUIDA": "Pendência concluída",
    # --- demandas (base compartilhada) ---
    "DEMANDA_REGISTRADA": "Demanda registrada",
    "DEMANDA_EM_ANDAMENTO": "Demanda em andamento",
    "DEMANDA_ENCAMINHADA": "Demanda encaminhada",
    "DEMANDA_ENCERRADA": "Demanda encerrada",
    "DEMANDA_RESPONSAVEL_ALTERADO": "Responsável da demanda alterado",
    # --- catalogos ---
    "AGENTE_CRIADO": "Agente nocivo cadastrado",
    "CAMPUS_CRIADO": "Campus cadastrado",
    "UNIDADE_CRIADA": "Unidade cadastrada",
    "POSTO_CRIADO": "Posto de trabalho cadastrado",
    "CARGO_CRIADO": "Cargo cadastrado",
    "PORTARIA_CRIADA": "Portaria cadastrada",
    "TEXTO_VERSIONADO": "Texto padrão versionado",
    "CHECKLIST_MODELO_CRIADO": "Modelo de checklist cadastrado",
    # --- certificados e treinamentos ---
    "TREINAMENTO_CRIADO": "Treinamento cadastrado",
    "TURMA_CRIADA": "Turma criada",
    "TURMA_APURADA": "Turma apurada",
    "TURMA_INSTRUTOR_VINCULADO": "Instrutor vinculado à turma",
    "TURMA_INSTRUTOR_DESVINCULADO": "Instrutor desvinculado da turma",
    "INSCRICAO_CRIADA": "Inscrição criada",
    # Os dois atos do PRÓPRIO servidor. São eventos separados de
    # `INSCRICAO_CRIADA` e de `ESTADO_ALTERADO` porque respondem a outra
    # pergunta na trilha: "quem pediu esta vaga?" e "quem desistiu dela?". A
    # resposta "a secretaria inscreveu" e "o servidor pediu" descrevem fatos
    # diferentes, e quem lê a trilha meses depois precisa dessa diferença.
    "INSCRICAO_PEDIDA_PELO_TITULAR": "Inscrição pedida pelo próprio servidor",
    "INSCRICAO_DESISTIDA": "Desistência do próprio inscrito",
    "PARTICIPANTE_CRIADO": "Participante externo cadastrado",
    "PRESENCA_LANCADA": "Presença lançada",
    "PRESENCA_EM_LOTE": "Presença lançada em lote",
    "NOTA_LANCADA": "Nota lançada",
    "RESULTADO_RETIFICADO": "Resultado retificado",
    "LISTA_PRESENCA_GERADA": "Lista de presença gerada",
    "CERTIFICADO_EMITIDO": "Certificado emitido",
    "CERTIFICADO_LOTE": "Certificados emitidos em lote",
    "CERTIFICADO_SEGUNDA_VIA": "Segunda via de certificado",
    "CERTIFICADO_ANULADO": "Certificado anulado",
    "CERTIFICADO_DIVERGENTE": "Divergência no certificado",
    "CERTIFICADO_MODELO_CRIADO": "Modelo de certificado cadastrado",
    "CERTIFICADO_MODELO_VERSIONADO": "Modelo de certificado versionado",
    "ASSINATURA_INSTRUTOR_CRIADA": "Assinatura de instrutor cadastrada",
    "MODELO_TAG_MAPEADA": "Marcador do modelo mapeado",
    "MODELO_TAG_REMOVIDA": "Marcador do modelo removido",
    # --- EPI: catalogo e estoque ---
    "EPI_ITEM_CRIADO": "Item cadastrado no catálogo de EPI",
    "EPI_MOTIVO_RECUSA_CRIADO": "Motivo de recusa cadastrado",
    "EPI_LOTE_REGISTRADO": "Lote de EPI registrado",
    "EPI_LOTE_ALTERADO": "Lote de EPI alterado",
    "EPI_ESTOQUE_AJUSTADO": "Estoque de EPI ajustado",
    "EPI_ESTOQUE_DESCARTADO": "Lote de EPI descartado",
    # --- EPI: ficha do servidor ---
    "EPI_ENTREGUE": "EPI entregue",
    "EPI_DEVOLVIDO": "EPI devolvido",
    "EPI_ESTORNADO": "Registro de EPI estornado",
    "EPI_ENTREGA_RECUSADA": "Entrega de EPI recusada",
    "EPI_MAXIMO_EXCEDIDO": "Máximo de EPI excedido",
    "EPI_COMPROVANTE_IMPRESSO": "Comprovante de EPI impresso",
    "EPI_COMPROVANTE_ANEXADO": "Comprovante de EPI anexado",
    "EPI_COMPROVANTE_DIVERGENTE": "Comprovante de EPI divergente",
    # --- EPI: requisicao (o envelope) ---
    "EPI_REQUISICAO_CRIADA": "Requisição criada",
    "EPI_REQUISICAO_ENVIADA": "Requisição enviada",
    "EPI_REQUISICAO_EM_ANALISE": "Requisição em análise",
    "EPI_REQUISICAO_DEVOLVIDA": "Requisição devolvida à fila",
    "EPI_REQUISICAO_ANALISADA": "Requisição analisada",
    "EPI_REQUISICAO_INDEFERIDA": "Requisição indeferida",
    "EPI_REQUISICAO_RECONSIDERADA": "Requisição reconsiderada",
    "EPI_REQUISICAO_EM_ATENDIMENTO": "Requisição em atendimento",
    "EPI_REQUISICAO_ATENDIDA": "Requisição atendida",
    "EPI_REQUISICAO_CANCELADA": "Requisição cancelada",
    "EPI_REQUISICAO_EXCLUIDA": "Rascunho de requisição excluído",
    # --- EPI: item da requisicao (onde a decisao acontece) ---
    "EPI_ITEM_APROVADO": "Item do pedido aprovado",
    "EPI_ITEM_RECUSADO": "Item do pedido recusado",
    "EPI_ITEM_CANCELADO": "Item do pedido cancelado",
    "EPI_ITEM_RESERVADO": "Item do pedido reservado",
    "EPI_ITEM_RESERVA_SOLTA": "Reserva do item solta",
    "EPI_ITEM_SEM_ESTOQUE": "Item do pedido sem estoque",
    "EPI_ITEM_ENTREGUE": "Item do pedido entregue",
}


def rotulo_evento(codigo: str | None) -> str:
    """O `tipo_evento` como a tela deve escreve-lo.

    O recuo humaniza o codigo em vez de devolve-lo cru ou de trocar todos por um
    "Evento" generico, e as duas recusas tem motivo. Cru era o defeito: caixa
    alta com sublinhado na posicao de destaque da primeira tela do dia. Generico
    seria pior do que parece — a carga do Trello grava o tipo da acao ORIGINAL
    (`importacao_trello.py`, `acao.get("type")`), que nao esta e nunca estara
    neste mapa, e ali o que a pessoa precisa e justamente distinguir um evento
    importado do outro. Humanizar preserva a distincao sem inventar significado:
    o rotulo continua sendo o codigo, so que legivel, e a descricao ao lado — que
    ja esta em portugues — continua sendo quem explica.
    """
    if not codigo:
        return "—"
    return ROTULO_EVENTO.get(codigo) or codigo.replace("_", " ").capitalize()


class ValorNaoAuditavel(ValueError):
    """`valor_anterior`/`valor_novo` que nao volta do banco como foi gravado."""


# O tipo da PROPRIA coluna, e nao uma copia da serializacao. A trava precisa
# medir o que o banco faz de verdade: reescrever o `json.dumps` aqui criaria uma
# segunda regra, que passaria a divergir no dia em que alguem mexesse so num lado
# — que e como o defeito nasceu.
_TIPO_DO_VALOR = HistoricoEvento.__table__.c.valor_novo.type


def _corpo(valor: Any) -> str:
    """A forma serializada que entra no digest. Compara valor, nao objeto."""
    return json.dumps(valor, ensure_ascii=False, sort_keys=True, default=str)


def _exigir_valor_estavel(nome: str, valor: Any) -> None:
    """A trava: o digest so vale se o valor sobreviver a ida e volta do banco.

    `hash_atual` e calculado sobre o valor em memoria e reconferido sobre o
    valor lido do banco. Se a coluna nao devolver o mesmo valor,
    `cadeia_integra` acusa adulteracao onde nao houve — o pior defeito possivel
    numa trilha de auditoria, porque destroi a confianca na verificacao inteira
    em vez de so falhar.

    A conferencia e por SIMULACAO da coluna, e nao por lista de tipos proibidos:
    lista de tipos envelhece e nao alcanca o caso que ninguem previu. Por isso
    ela nao recusa nada do que o sistema grava hoje — `Decimal`, `date`, `bool`,
    `dict`, SIAPE como texto, tudo passa. O que ela recusa e gravacao que o
    banco devolveria diferente, na hora, com o motivo, em vez de deixar o alarme
    falso aparecer meses depois na tela de auditoria.
    """
    if valor is None:
        return
    bruto = _TIPO_DO_VALOR.process_bind_param(valor, None)
    devolvido = _TIPO_DO_VALOR.process_result_value(bruto, None)
    if _corpo(valor) != _corpo(devolvido):
        raise ValorNaoAuditavel(
            f"{nome}={valor!r} ({type(valor).__name__}) nao sobrevive a coluna: "
            f"o banco devolveria {devolvido!r} ({type(devolvido).__name__}) e o "
            "digest da trilha deixaria de conferir. Grave o valor de verdade "
            "(Decimal, int, date) em vez de str(...), ou converta para uma forma "
            "que o JSON releia igual."
        )


# `evento` e um `HistoricoEvento` na gravacao e uma `Row` de colunas na
# conferencia — as duas respondem pelos mesmos nove atributos, e e disso que o
# digest depende. Anotar `HistoricoEvento` aqui seria mentira de tipo no caminho
# que mais importa: o que confere.
def _digerir(evento: Any, anterior: str | None) -> str:
    corpo = json.dumps(
        {
            "entidade": evento.entidade,
            "entidade_id": evento.entidade_id,
            "tipo": evento.tipo_evento,
            "descricao": evento.descricao,
            "campo": evento.campo,
            "anterior": evento.valor_anterior,
            "novo": evento.valor_novo,
            "usuario": evento.usuario_nome,
            "ocorrido_em": evento.ocorrido_em.isoformat()
            if isinstance(evento.ocorrido_em, datetime)
            else str(evento.ocorrido_em),
            "hash_anterior": anterior,
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(corpo.encode("utf-8")).hexdigest()


def registrar(
    s: Session,
    *,
    entidade: str,
    entidade_id: int,
    tipo_evento: str,
    descricao: str,
    usuario: UsuarioAtual | None = None,
    usuario_nome: str | None = None,
    processo_id: int | None = None,
    campo: str | None = None,
    valor_anterior: Any = None,
    valor_novo: Any = None,
    comentario: str | None = None,
    ocorrido_em: datetime | None = None,
    origem: str = "SISTEMA",
    origem_ref: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> HistoricoEvento:
    # antes de qualquer coisa: por aqui passa TODA gravacao da trilha, e evento
    # com digest que nao fecha e pior do que evento nenhum
    _exigir_valor_estavel("valor_anterior", valor_anterior)
    _exigir_valor_estavel("valor_novo", valor_novo)

    ultimo = s.execute(
        select(HistoricoEvento).order_by(desc(HistoricoEvento.id)).limit(1)
    ).scalar_one_or_none()
    anterior = ultimo.hash_atual if ultimo else None

    evento = HistoricoEvento(
        entidade=entidade,
        entidade_id=entidade_id,
        processo_id=processo_id,
        tipo_evento=tipo_evento,
        descricao=descricao,
        comentario=comentario,
        campo=campo,
        valor_anterior=valor_anterior,
        valor_novo=valor_novo,
        usuario_id=usuario.id if usuario else None,
        usuario_nome=usuario_nome or (usuario.nome if usuario else "sistema"),
        ocorrido_em=ocorrido_em or agora_utc(),
        registrado_em=agora_utc(),
        origem=origem,
        origem_ref=origem_ref,
        ip=ip,
        user_agent=user_agent,
        hash_anterior=anterior,
    )
    evento.hash_atual = _digerir(evento, anterior)
    s.add(evento)
    s.flush()
    return evento


def registrar_diferencas(
    s: Session,
    *,
    entidade: str,
    entidade_id: int,
    antes: dict,
    depois: dict,
    usuario: UsuarioAtual | None,
    processo_id: int | None = None,
    tipo_evento: str = "CAMPO_ALTERADO",
) -> list[HistoricoEvento]:
    """RN-14: cada campo registrado individualmente."""
    eventos = []
    for campo in sorted(set(antes) | set(depois)):
        a, d = antes.get(campo), depois.get(campo)
        if a == d:
            continue
        eventos.append(
            registrar(
                s,
                entidade=entidade,
                entidade_id=entidade_id,
                tipo_evento=tipo_evento,
                descricao=f"{campo}: {a!r} -> {d!r}",
                campo=campo,
                valor_anterior=a,
                valor_novo=d,
                usuario=usuario,
                processo_id=processo_id,
            )
        )
    return eventos


# ---------------------------------------------------------------------
# Conferir o encadeamento: a janela na tela, a cadeia inteira por fora
# ---------------------------------------------------------------------
# **O defeito que esta secao existe para impedir (Q-2).** `/auditoria` chamava
# `cadeia_integra` a cada abertura: a tabela INTEIRA percorrida e um SHA-256
# recalculado por evento, dentro da requisicao, com o lock de escrita do SQLite
# na mao — porque toda transacao deste sistema abre com `BEGIN IMMEDIATE`
# (RN-03, `app/banco.py`) e o toma ja no SELECT do cookie.
#
# Medido no banco descartavel: ~55 us por evento — 43 ms com 1.292 eventos,
# 1.147 ms com 25.292, 2.743 ms com 50.292. Projetando, em ~90 mil eventos a
# conferencia passa dos 5 s de `busy_timeout` e uma unica abertura de
# `/auditoria` derruba a tela de todos os outros com "database is locked". E nao
# e hipotese distante: a importacao do Trello e da planilha gravou 7.634 eventos
# de uma vez, e seis pessoas trabalhando geram evento a cada ato.
#
# A saida e separar duas perguntas que estavam coladas numa funcao so:
#
#   1. "o que estou vendo confere?" — `janela_integra`, sobre os 100 eventos da
#      pagina. Custo constante, ~6 ms, e e o que a tela responde a cada abertura;
#   2. "a trilha inteira ainda fecha?" — `conferir_fora_da_transacao`, ato
#      deliberado (botao ou rotina agendada), que solta a transacao ANTES de
#      percorrer e guarda o resultado em `conferencia_cadeia`.

# Quantas linhas o cursor traz por vez no passe completo. Existe porque o passe
# completo e o unico lugar do sistema que le a trilha inteira: sem lote, a
# `Result` materializa 90 mil linhas de uma vez para conferir uma de cada vez.
_LOTE_DA_CADEIA = 1000

# As colunas que a conferencia le, e so elas. Ela percorre COLUNAS e nao
# entidades ORM de proposito: `_digerir` acessa o evento por atributo, e a `Row`
# do Core responde por atributo do mesmo jeito — o que permite passar por 90 mil
# eventos sem encher o mapa de identidade da sessao com 90 mil objetos que
# ninguem vai usar de novo.
#
# A lista precisa cobrir tudo o que `_digerir` le. Ela nao se atualiza sozinha —
# mas tambem nao erra em silencio: campo acrescentado ao digest e esquecido aqui
# vira `AttributeError` na primeira conferencia, e nao um digest que fecha sobre
# menos do que deveria.
_COLUNAS_DA_CADEIA = (
    HistoricoEvento.id,
    HistoricoEvento.entidade,
    HistoricoEvento.entidade_id,
    HistoricoEvento.tipo_evento,
    HistoricoEvento.descricao,
    HistoricoEvento.campo,
    HistoricoEvento.valor_anterior,
    HistoricoEvento.valor_novo,
    HistoricoEvento.usuario_nome,
    HistoricoEvento.ocorrido_em,
    HistoricoEvento.hash_anterior,
    HistoricoEvento.hash_atual,
)

# O `hash_atual` do evento imediatamente anterior a cada um da janela. E o que
# ancora a janela na cadeia: sem ele a conferencia da pagina provaria apenas que
# cada evento fecha consigo mesmo, e um trecho inteiro reescrito de forma
# coerente passaria. Subconsulta correlacionada, uma busca de indice por evento.
_ANTERIOR = aliased(HistoricoEvento)
_HASH_DO_ANTERIOR = (
    select(_ANTERIOR.hash_atual)
    .where(_ANTERIOR.id < HistoricoEvento.id)
    .order_by(desc(_ANTERIOR.id))
    .limit(1)
    .scalar_subquery()
)


class ConferenciaEmCurso(RuntimeError):
    """Ja ha uma conferencia completa rodando nesta maquina."""


# Uma conferencia completa por vez. Nao e o lock do banco — este defeito era
# justamente o de segurar aquele —, e sim a trava contra o segundo clique: o
# passe completo custa segundos de CPU e le a trilha inteira, e seis pessoas
# clicando no botao ao mesmo tempo fariam seis passes identicos, gravando seis
# linhas com a mesma resposta. Recusar e melhor do que enfileirar: quem chegou
# depois quer o resultado, e o resultado ja esta a caminho.
_CONFERENCIA_EM_CURSO = threading.Lock()

ORIGEM_BOTAO = "BOTAO"
ORIGEM_ROTINA = "ROTINA"


def _conferir(eventos: Iterable[Any]) -> tuple[bool, int | None, int]:
    """Percorre eventos JA ORDENADOS por id e refaz o encadeamento.

    Devolve (integra, id_do_primeiro_defeito, quantos_foram_conferidos). O
    contador para no defeito, e nao no fim: quem le a linha guardada precisa
    saber ate onde a afirmacao alcanca.
    """
    anterior: str | None = None
    total = 0
    for evento in eventos:
        total += 1
        if evento.hash_anterior != anterior:
            return False, evento.id, total
        if evento.hash_atual != _digerir(evento, anterior):
            return False, evento.id, total
        anterior = evento.hash_atual
    return True, None, total


def cadeia_integra(s: Session) -> tuple[bool, int | None]:
    """Reconfere a cadeia INTEIRA. Devolve (ok, id_do_primeiro_defeito).

    **Nao chame isto de dentro de uma requisicao.** O custo cresce com a tabela e
    a transacao da requisicao esta com o lock de escrita na mao; e exatamente o
    defeito Q-2. Dentro da aplicacao ha duas portas, e so duas:
    `janela_integra` para a tela e `conferir_fora_da_transacao` para o passe
    completo. Um teste de AST guarda a regra
    (`testes/integracao/test_concorrencia_auditoria.py`).

    Ela continua publica porque e a definicao de referencia do que "cadeia
    integra" significa, e e por ela que os testes conferem a trilha depois de um
    cenario — fora de requisicao, com dezenas de eventos.
    """
    integra, defeito, _total = _conferir(
        s.execute(select(*_COLUNAS_DA_CADEIA).order_by(HistoricoEvento.id))
    )
    return integra, defeito


def janela_integra(
    s: Session, eventos: Sequence[HistoricoEvento]
) -> tuple[bool, int | None]:
    """Confere so os eventos exibidos — e a costura de cada um com o anterior.

    E o que `/auditoria` responde a cada abertura. Duas perguntas por evento:

    1. **o corpo confere com o proprio digest?** `hash_atual` e refeito sobre o
       evento como ele esta no banco. Qualquer alteracao de conteudo cai aqui —
       e `hash_anterior` entra no digest, entao alterar o elo tambem cai;
    2. **o elo aponta para quem esta mesmo atras?** `hash_anterior` e comparado
       com o `hash_atual` do evento imediatamente anterior NA TABELA, buscado
       por `_HASH_DO_ANTERIOR`. Sem esta segunda pergunta, um trecho reescrito
       inteiro — cada evento coerente com o vizinho falso — passaria pela
       primeira sem levantar nada.

    A janela vem filtrada (usuario, entidade, tipo), entao os eventos exibidos
    quase nunca sao vizinhos na cadeia. Por isso cada um e ancorado no SEU
    antecessor real, e nao no anterior da lista: comparar com o anterior da lista
    acusaria adulteracao em toda tela com filtro.
    """
    if not eventos:
        return True, None

    ids = [evento.id for evento in eventos]
    ancora = {
        evento_id: hash_do_anterior
        for evento_id, hash_do_anterior in s.execute(
            select(HistoricoEvento.id, _HASH_DO_ANTERIOR).where(
                HistoricoEvento.id.in_(ids)
            )
        )
    }

    # em ordem de cadeia, para "o primeiro defeito" ser o primeiro de verdade e
    # nao o primeiro da tela (que vem do mais novo para o mais velho)
    for evento in sorted(eventos, key=lambda e: e.id):
        if evento.hash_anterior != ancora.get(evento.id):
            return False, evento.id
        if evento.hash_atual != _digerir(evento, evento.hash_anterior):
            return False, evento.id
    return True, None


def ultima_conferencia(s: Session) -> ConferenciaCadeia | None:
    """A conferencia completa mais recente — a que a tela data."""
    return s.execute(
        select(ConferenciaCadeia).order_by(desc(ConferenciaCadeia.id)).limit(1)
    ).scalar_one_or_none()


def conferir_fora_da_transacao(
    s: Session,
    *,
    usuario: UsuarioAtual | None = None,
    origem: str = ORIGEM_BOTAO,
) -> ConferenciaCadeia:
    """A UNICA forma de conferir a cadeia inteira de dentro da aplicacao.

    Mesmo molde de `pdf.converter_fora_da_transacao`, e pelo mesmo motivo: a
    operacao demora e a transacao da requisicao esta com o unico lock de escrita
    do banco na mao desde o SELECT do cookie (RN-03).

    **Por que o commit mora AQUI e nao na linha de cima de quem chama.** Um
    `commit()` solto nao resolve, e isso ja custou uma versao no `exportar_tudo`
    da 1.22.2: entre o commit e a operacao lenta havia SELECTs, e cada SELECT
    reabre a transacao com `BEGIN IMMEDIATE`. Com o commit e o passe na MESMA
    chamada nao existe linha entre os dois onde alguem possa, meses depois,
    encaixar uma leitura inocente.

    **A conexao do passe e explicitamente `AUTOCOMMIT`**, e nao a sessao de quem
    chamou. Reusar a sessao seria reabrir a transacao — e tomar o lock de novo —
    na primeira linha lida; e uma conexao nova do engine nasceria com o mesmo
    `BEGIN IMMEDIATE`. Em WAL, leitor que nao pede o lock de escrita nao bloqueia
    ninguem, que e o ponto inteiro desta funcao. E o mesmo caminho que o
    `VACUUM INTO` do backup ja usa (`servicos/backup.py`).

    Depois do passe a linha do resultado e gravada numa transacao NOVA e curta —
    milissegundos, com a resposta ja pronta na mao.

    **Nada disto entra em `historico_evento`.** Conferir a trilha nao e um ato
    sobre o processo; escreve-lo na propria trilha faria toda rotina noturna
    acrescentar um elo a cadeia que ela acabou de conferir, e um ano de
    conferencias diarias respondendo "integra" seria o maior tipo de evento da
    base. Quem, quando e o que deu ficam em `conferencia_cadeia`, que e a linha
    do laudo.
    """
    if not _CONFERENCIA_EM_CURSO.acquire(blocking=False):
        raise ConferenciaEmCurso(
            "Uma conferência da cadeia inteira já está em andamento. "
            "Aguarde e recarregue a tela — o resultado aparece aqui."
        )
    try:
        from app.banco import obter_engine

        s.commit()
        iniciada_em = agora_utc()
        relogio = time.monotonic()
        consulta = select(*_COLUNAS_DA_CADEIA).order_by(HistoricoEvento.id)
        with obter_engine().connect().execution_options(
            isolation_level="AUTOCOMMIT"
        ) as con:
            integra, defeito, total = _conferir(
                con.execute(consulta).yield_per(_LOTE_DA_CADEIA)
            )
            ultimo = con.execute(select(func.max(HistoricoEvento.id))).scalar()
        duracao_ms = int((time.monotonic() - relogio) * 1000)
    finally:
        _CONFERENCIA_EM_CURSO.release()

    registro = ConferenciaCadeia(
        iniciada_em=iniciada_em,
        concluida_em=agora_utc(),
        duracao_ms=duracao_ms,
        eventos=total,
        ultimo_evento_id=ultimo,
        integra=integra,
        primeiro_defeito_id=defeito,
        origem=origem,
        usuario_id=usuario.id if usuario else None,
    )
    s.add(registro)
    s.commit()
    return registro


def registrar_acesso_sensivel(
    s: Session,
    usuario: UsuarioAtual,
    campo: str,
    *,
    servidor_id: int | None = None,
    processo_id: int | None = None,
    finalidade: str | None = None,
) -> AcessoDadoSensivel:
    """RN-23 - toda leitura de exposicao, parecer nominal e anexo RESTRITO."""
    registro = AcessoDadoSensivel(
        usuario_id=usuario.id,
        servidor_id=servidor_id,
        processo_id=processo_id,
        campo=campo,
        finalidade=finalidade or "consulta operacional do modulo Adicional Ocupacional",
    )
    s.add(registro)
    s.flush()
    return registro


def leitura_de_terceiro(usuario: UsuarioAtual, servidor_id: int | None) -> bool:
    """A pergunta que decide o registro: o dado lido e de OUTRA pessoa?

    E a mesma pergunta de `epi_ficha.exigir_leitura_da_ficha`, e a resposta esta
    escrita ali desde a fatia 3: quem decide e a relacao titular/terceiro, nao a
    permissao de exibir nome.

    `servidor_id` nulo devolve `False` porque nao ha "sobre quem": a linha
    gravaria que alguem leu alguma coisa, que e exatamente o registro que
    `anexo_acesso.Dono` descreve como incapaz de sustentar investigacao nenhuma.

    Conta sem `servidor_id` — toda a equipe da CSSO — le sempre como terceiro, e
    esta certo: quem nao e o titular de linha nenhuma nao tem leitura propria.
    """
    if servidor_id is None:
        return False
    return usuario.servidor_id != servidor_id


def registrar_leitura_nominal(
    s: Session,
    usuario: UsuarioAtual,
    campo: str,
    *,
    servidor_id: int | None,
    processo_id: int | None = None,
    finalidade: str | None = None,
) -> AcessoDadoSensivel | None:
    """Registra a leitura NOMINAL de terceiro. Decide e grava numa chamada so.

    O criterio antigo era `usuario.ve_dado_nominal` — `exposicao.ver or
    epi.ficha` (`rbac.ve_dado_nominal`). Ele descrevia bem enquanto quem nao
    tinha a permissao tambem nao alcancava a linha: registrar leitura de codigo
    opaco seria ruido, e foi esse o argumento que a busca global usou. Mas as
    telas alcancavam a linha inteira sem a permissao, e o arranjo virou o pior
    possivel: o unico perfil que le o parecer alheio era o unico que nao deixava
    rastro. O art. 37 da LGPD e o `docs/ROPA.md` §6 prometem "quem, qual campo,
    sobre quem" — e a promessa nao pode depender de o leitor ter permissao de
    ver nome, porque quem ve o nome sem ela e justamente quem interessa.

    **O titular lendo o proprio dado nao entra.** Tres motivos, na ordem em que
    pesam:

    1. E o exercicio do art. 18, II — o direito que faz o perfil existir. Gravar
       o titular como linha de acesso a dado sensivel transforma em suspeita o
       ato que a lei garante, e a tabela deixa de responder o que ela existe para
       responder.
    2. Volume. Com milhares de contas de servidor, a leitura do proprio dado e a
       esmagadora maioria do trafego — cada login, cada olhada no proprio
       processo. O sinal (a leitura de terceiro) afoga no ruido, que e a mesma
       razao pela qual a busca global nao registra.
    3. Nao e decisao nova: `epi_ficha.exigir_leitura_da_ficha` ja decide assim
       desde a fatia 3, e o anexo do comprovante assinado ja segue essa regra.
       Escrever aqui um criterio diferente refaria a divergencia que
       `anexo_acesso` foi escrito para fechar.

    Devolve `None` quando nao gravou, para quem precisar saber.
    """
    if not leitura_de_terceiro(usuario, servidor_id):
        return None
    return registrar_acesso_sensivel(
        s,
        usuario,
        campo,
        servidor_id=servidor_id,
        processo_id=processo_id,
        finalidade=finalidade,
    )
