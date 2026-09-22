"""Regras da emissao do certificado: validacao, congelamento, lote e anulacao.

Fatia 4 do modulo Certificados e Treinamentos. Esta a mesma divisao que o
parecer ja tem: `certificado.py` guarda o vocabulario, o contexto e o render
(como `documento.py`), e aqui ficam as regras de negocio (como `parecer.py`).

**RN-15 e o coracao da fatia.** Um certificado emitido reimprime do congelado,
nunca do catalogo de hoje. Trocar a carga horaria do treinamento, corrigir o
conteudo programatico, cadastrar um instrutor novo, publicar outra versao do
modelo ou **editar o mapa de tags** nao pode mudar um papel que ja circulou.
`montar_contexto` tem uma unica porta de saida para certificado emitido, e ela
le `contexto_congelado`.

A ordem da emissao e a do SS4 do desenho, e a ordem importa:

1. `usuario.exigir("certificado.emitir")`
2. recusar se a inscricao ja tem certificado nao anulado (RN-14)
3. validar tudo — turma, resultado, assinatura, modelo, tags obrigatorias
4. **so agora** consumir o numero
5. gerar a chave de validacao
6. montar o contexto e **congelar antes de renderizar**
7. renderizar o .docx
8. auditar
9. **fora da transacao**, converter em PDF (degradando sem LibreOffice) e anexar

O passo 4 depois do 3 nao e detalhe: numero consumido nao volta para a
sequencia, e validar depois de consumir gastaria um numero a cada tentativa
recusada — foi por isso que o parecer tambem deixa `proximo_numero` para o fim.

O passo 9 depois do 8, e nao no meio dele, tambem nao e detalhe, e a razao esta
em `pdf.converter_fora_da_transacao`: a conversao chama o LibreOffice, que leva
segundos, e este banco tem UM escritor. Enquanto o PDF estava no meio da
transacao, uma emissao segurava o lock de escrita do sistema inteiro pelo tempo
todo do subprocesso — e a partir da segunda pessoa isso e "database is locked"
na tela dos outros. O passo 9 roda com a emissao ja comitada; ver
`_pdf_depois_da_emissao` para o que acontece quando ele falha ali.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    Certificado,
    CertificadoModelo,
    Inscricao,
    Turma,
    agora_utc,
)
from app.modelos.treinamento import ROTULO_VINCULO
from app.servicos import (
    anexos,
    auditoria,
    certificado as servico_certificado,
    datas_br,
    numeracao,
    pdf as servico_pdf,
    presenca as servico_presenca,
    servidores as servico_servidores,
    textos,
)
from app.servicos.certificado import ContextoCertificado
from app.servicos.parecer import setor_emissor_vigente
from app.servicos.rbac import UsuarioAtual

CERTIFICADO_EMITIDO = "CERTIFICADO_EMITIDO"
CERTIFICADO_ANULADO = "CERTIFICADO_ANULADO"
CERTIFICADO_SEGUNDA_VIA = "CERTIFICADO_SEGUNDA_VIA"
CERTIFICADO_DIVERGENTE = "CERTIFICADO_DIVERGENTE"
CERTIFICADO_LOTE = "CERTIFICADO_LOTE"

SUBPASTA = "certificados"
TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

PARAMETRO_URL_PUBLICA = "certificado.url_publica"

# tentativas de sorteio antes de desistir. Com ~49 bits de entropia, duas
# colisoes seguidas sao um evento que nao acontece — o laco existe para que a
# emissao nao morra num IntegrityError caso aconteca.
TENTATIVAS_CHAVE = 5


class EmissaoBloqueada(ValueError):
    """O que impede este certificado de sair, tudo de uma vez.

    Lista em vez de primeiro-erro pela mesma razao do `DadosIncompletos` do
    parecer: quem vai emitir trinta certificados precisa saber tudo o que falta
    numa passada, e nao descobrir um problema por tentativa.
    """

    def __init__(self, motivos: list[str]):
        self.motivos = motivos
        super().__init__("Emissão bloqueada: " + "; ".join(motivos))


@dataclass
class Validacao:
    bloqueios: list[str] = field(default_factory=list)
    avisos: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.bloqueios


# ---------------------------------------------------------------------
# Leitura auxiliar
# ---------------------------------------------------------------------
def url_base_validacao(s: Session) -> str:
    """A raiz do endereco publico, sem barra no fim.

    Vem de `parametro`, e nao do `.env`: o `.env` e infraestrutura (porta,
    caminho) e isto e o endereco pelo qual a instituicao publica o certificado —
    coisa que o coordenador ajusta quando o TI decidir o proxy reverso (SS11,
    item 7). Sem parametro, cai no host de desenvolvimento, que e honesto: o
    sistema ainda nao esta exposto.
    """
    from app.config import obter_config
    from app.modelos import Parametro

    parametro = s.get(Parametro, PARAMETRO_URL_PUBLICA)
    if parametro is not None and (parametro.valor or "").strip():
        return parametro.valor.strip().rstrip("/")
    cfg = obter_config()
    return f"http://{cfg.host}:{cfg.porta}"


def no_escopo(s: Session, usuario: UsuarioAtual, certificado_id: int) -> Certificado | None:
    """Uma leitura so, ja filtrada pelo escopo do perfil.

    `certificado.campus_id` e `certificado.servidor_id` existem exatamente para
    isto (SS8): sem eles, `aplicar_escopo` cairia em `where(False)` para o perfil
    de escopo proprio e a tela ficaria vazia sem nenhum erro.

    Saiu de `rotas/certificados.py` para ca quando o download do anexo passou a
    herdar a autorizacao do dono: a ficha, a segunda via, a anulacao e o anexo
    tem de alcancar a MESMA linha, e quatro copias da consulta divergem na
    primeira que alguem apertar.
    """
    from app.servicos.rbac import aplicar_escopo

    consulta = aplicar_escopo(
        select(Certificado).where(Certificado.id == certificado_id),
        usuario,
        Certificado,
    )
    return s.execute(consulta).scalar_one_or_none()


def exigir_leitura_do_certificado(
    usuario: UsuarioAtual, servidor_id: int | None
) -> bool:
    """Devolve `True` quando a leitura e do certificado de OUTRA pessoa.

    Gemea de `epi_ficha.exigir_leitura_da_ficha`, e a escolha de copiar a forma e
    deliberada: `certificado.ver` tem a mesma natureza de `epi.ficha` — a
    descricao dela em `rbac.PERMISSOES` diz "certificado nominal e dados do
    participante", ou seja, e a permissao de ler o de OUTRO. Conceder essa
    permissao ao perfil de escopo proprio faria o servidor alcancar o proprio
    papel, mas ao preco de mudar o que a permissao significa: `semear_rbac` nunca
    remove permissao de perfil, e toda rota futura guardada por `certificado.ver`
    passaria a abrir para ele em silencio, dependendo de a rota lembrar do
    escopo. Foi essa classe de folga que a 1.35.0 fechou.

    Ler o proprio exige `treinamento.ver`, que o perfil ja tem por desenho
    (`desenho_certificados.md` §8, "escopo proprio"), e nao entra em
    `acesso_dado_sensivel`: e a LGPD art. 18, II, e a decisao de 1.35.0 de que
    ler o proprio dado nao gera registro de acesso. Ler o de outro exige a
    permissao **e** e registrado — a mesma assimetria da ficha de EPI.

    Mora aqui, e nao na rota, pelo motivo que a ficha de EPI ja pagou: a ficha, a
    segunda via e o download do anexo do certificado (`anexo_acesso`) fazem a
    MESMA pergunta, e tres copias divergem na primeira correcao.
    """
    propria = usuario.servidor_id is not None and usuario.servidor_id == servidor_id
    if propria:
        usuario.exigir("treinamento.ver")
        return False
    usuario.exigir("certificado.ver")
    return True


def consulta_do_titular(usuario: UsuarioAtual):
    """A consulta de "meus certificados": `servidor_id` fixo no da conta.

    Nao chama `aplicar_escopo` de proposito, e isso e mais estreito e nao menos:
    `aplicar_escopo` responde ao ESCOPO DO PERFIL, e para um perfil de unidade
    ele devolveria o campus inteiro. Aqui a pergunta e outra — "o que e meu" —, e
    a resposta nao pode alargar quando o escopo do perfil alargar.

    Conta sem `servidor_id` (a do `admin_ti`, a da secretaria que nao esta
    amarrada a um cadastro) nao e erro nem tela negada: e uma lista vazia com a
    explicacao na tela, porque a conta simplesmente nao tem titular de quem
    falar. `-1` no lugar de `None` para nao virar `servidor_id IS NULL`, que
    casaria com todo certificado de participante externo.
    """
    return select(Certificado).where(
        Certificado.servidor_id == (usuario.servidor_id or -1)
    )


def certificado_da_inscricao(s: Session, inscricao: Inscricao) -> Certificado | None:
    """O nao anulado. E a mesma consulta que `presenca.certificado_ativo` faz."""
    return servico_presenca.certificado_ativo(s, inscricao)


def certificados_da_turma(s: Session, turma: Turma) -> dict[int, Certificado]:
    """`{inscricao_id: certificado nao anulado}` — uma consulta para a aba toda."""
    linhas = s.execute(
        select(Certificado)
        .join(Inscricao, Inscricao.id == Certificado.inscricao_id)
        .where(Inscricao.turma_id == turma.id, Certificado.situacao != "ANULADO")
    ).scalars()
    return {c.inscricao_id: c for c in linhas}


def modelo_da_turma(s: Session, turma: Turma) -> tuple[CertificadoModelo | None, str]:
    """Qual layout sai, e o aviso quando a escolha merece um.

    **O ponteiro manda.** `treinamento.modelo_vigente_id` e um ato do setor;
    publicar a v2 de um modelo NAO o move sozinho, e a 1.9.0 deixou isso a
    vista com o rotulo "(superada)" no seletor do catalogo. Saltar
    automaticamente para a versao mais nova seria trocar o layout de uma turma
    ja planejada sem que ninguem tivesse decidido — e o layout do certificado e
    justamente a coisa que o setor desenha e conferiu. Quando o ponteiro estiver
    numa versao superada, a emissao **avisa** e segue: bloquear obrigaria a
    mexer no catalogo para emitir um certificado que esta correto.

    Sem ponteiro, cai no modelo generico vigente (`treinamento_id IS NULL`).
    Havendo mais de um generico vigente, nao ha escolha obvia e a emissao para:
    escolher o primeiro seria sortear o papel de alguem.
    """
    treinamento = turma.treinamento
    if treinamento.modelo_vigente is not None:
        modelo = treinamento.modelo_vigente
        if not modelo.vigente:
            return modelo, (
                f"o catálogo aponta {modelo.rotulo}, que é uma versão superada — "
                "o certificado sai com esse layout; se não for o desejado, "
                "aponte a versão vigente em /treinamentos/catalogo antes de emitir"
            )
        return modelo, ""

    genericos = list(
        s.execute(
            select(CertificadoModelo).where(
                CertificadoModelo.treinamento_id.is_(None),
                CertificadoModelo.vigente.is_(True),
            )
        ).scalars()
    )
    if len(genericos) == 1:
        return genericos[0], (
            f"'{treinamento.nome}' não tem modelo próprio — saiu no modelo "
            f"genérico {genericos[0].rotulo}"
        )
    return None, ""


def instrutores_que_assinam(turma: Turma) -> list:
    return [
        vinculo
        for vinculo in sorted(
            turma.instrutores, key=lambda v: (v.ordem, v.assinatura_instrutor_id)
        )
        if vinculo.assina_certificado
    ]


def caminho_saida(certificado: Certificado, extensao: str = "docx") -> Path:
    """`dados/documentos/certificados/{ano}/Certificado_0007-2026_TUR-…_Nome.docx`.

    Por ano, como o parecer e a lista de presenca, porque e assim que o setor
    arquiva e e assim que o backup separa.
    """
    from app.config import obter_config

    cfg = obter_config()
    pasta = cfg.caminho(cfg.dir_documentos) / SUBPASTA / str(certificado.ano)
    congelado = certificado.contexto_congelado or {}
    turma_codigo = str(congelado.get("turma_codigo") or "")
    nome = str(congelado.get("participante_nome") or "")
    partes = [
        "Certificado",
        f"{certificado.numero:04d}-{certificado.ano}",
        # o codigo da turma ja casa TUR-AAAA-NNNN e e por ele que alguem procura
        # o arquivo na pasta; `slug_ascii` trocaria os hifens por sublinhados
        textos.slug_ascii(turma_codigo.replace("-", "_")).replace("_", "-"),
        textos.slug_ascii(nome)[:60],
    ]
    return pasta / ("_".join(p for p in partes if p) + f".{extensao}")


# ---------------------------------------------------------------------
# Validacao (SS4, passo 3)
# ---------------------------------------------------------------------
def validar(
    s: Session, inscricao: Inscricao, *, quando: date | None = None
) -> Validacao:
    """Tudo o que precisa ser verdade para o certificado sair.

    Roda tambem fora da emissao: a aba 4 usa esta funcao para dizer quem esta
    apto **antes** de alguem clicar. Uma segunda conta para a tela seria a forma
    mais barata de a tela dizer "apto" e a emissao recusar.
    """
    quando = quando or date.today()
    v = Validacao()
    turma = inscricao.turma

    if turma.situacao != "CONCLUIDA":
        v.bloqueios.append(
            f"{turma.codigo} ainda não foi concluída — o certificado atesta um "
            "curso que terminou"
        )
    if inscricao.situacao == "REPROVADO":
        motivos = servico_presenca.avaliar(turma, inscricao).motivos
        v.bloqueios.append(
            f"{inscricao.participante.nome_exibicao} está reprovado"
            + (f" ({'; '.join(motivos)})" if motivos else "")
        )
    elif inscricao.situacao != "APROVADO":
        v.bloqueios.append(
            f"{inscricao.participante.nome_exibicao} está "
            f"{inscricao.situacao.lower()} e não tem resultado de aprovação"
        )

    # A frequencia e a nota sao reconferidas a partir dos lancamentos, e nao
    # lidas da coluna: a coluna e derivada, e emitir com base numa copia deixaria
    # aberta a hipotese de o papel discordar da folha que o sustenta.
    frequencia = servico_presenca.frequencia_de(inscricao)
    if frequencia < turma.frequencia_minima_percentual:
        v.bloqueios.append(
            f"frequência de {servico_presenca.numero(frequencia)}% abaixo do "
            f"mínimo de {servico_presenca.numero(turma.frequencia_minima_percentual)}%"
        )
    if turma.nota_minima_aprovacao is not None:
        if inscricao.nota_final is None:
            v.bloqueios.append(
                "a turma exige nota mínima de "
                f"{servico_presenca.numero(turma.nota_minima_aprovacao)} e não há "
                "nota lançada"
            )
        elif inscricao.nota_final < turma.nota_minima_aprovacao:
            v.bloqueios.append(
                f"nota {servico_presenca.numero(inscricao.nota_final)} abaixo da "
                f"mínima {servico_presenca.numero(turma.nota_minima_aprovacao)}"
            )

    assinantes = instrutores_que_assinam(turma)
    if not assinantes:
        v.bloqueios.append(
            f"{turma.codigo} não tem nenhum instrutor marcado para assinar o "
            "certificado"
        )
    for vinculo in assinantes:
        if not vinculo.instrutor.vigente_em(quando):
            v.bloqueios.append(
                f"a assinatura de {vinculo.instrutor.nome_exibicao} não vigora em "
                f"{datas_br.numerica(quando)}"
            )

    modelo, aviso_modelo = modelo_da_turma(s, turma)
    if aviso_modelo:
        v.avisos.append(aviso_modelo)
    if modelo is None:
        v.bloqueios.append(
            f"'{turma.treinamento.nome}' não tem modelo de certificado — aponte "
            "um em /treinamentos/catalogo ou cadastre um modelo genérico"
        )
        return v

    mapa = modelo.mapa_de_tags
    if not mapa:
        v.bloqueios.append(
            f"o modelo {modelo.rotulo} não tem nenhuma tag no dicionário — o "
            "certificado sairia em branco"
        )
    desconhecidos = sorted(
        campo
        for campo in mapa.values()
        if campo not in servico_certificado.CAMPOS_CERTIFICADO
    )
    if desconhecidos:
        # o achado 6 da revisao da fatia 1: `publicar_versao` clonava as tags sem
        # revalidar, entao um campo aposentado do vocabulario viajava adiante em
        # silencio. Aqui ele para.
        v.bloqueios.append(
            f"o modelo {modelo.rotulo} aponta campo que não existe no "
            "vocabulário: " + ", ".join(desconhecidos)
        )

    # `ConferenciaDoModelo.ok` e o mesmo criterio que a tela do modelo mostra:
    # arquivo presente E nenhum marcador sem linha no dicionario. As mensagens
    # abaixo separam os dois casos porque o conserto de cada um e outro — um
    # pede o arquivo na pasta, o outro pede uma linha no mapa.
    conferencia = servico_certificado.conferir_modelo(modelo.arquivo, mapa)
    if not conferencia.ok:
        if not conferencia.arquivo_encontrado:
            v.bloqueios.append(
                f"o arquivo '{modelo.arquivo}' não está em app/templates/certificados/"
            )
        else:
            # sem esta guarda o certificado sai com `{{ nome }}` impresso no papel
            v.bloqueios.append(
                f"o .docx de {modelo.rotulo} tem marcador sem linha no dicionário: "
                + ", ".join(conferencia.sem_mapa)
            )
    else:
        sha = servico_certificado.sha256_do_modelo(modelo.arquivo)
        if modelo.arquivo_sha256 and sha and sha != modelo.arquivo_sha256:
            # SS3: o arquivo foi trocado por fora, sem passar pela tela. Avisa e
            # segue — bloquear impediria o setor de corrigir o layout entre duas
            # emissoes —, mas o SHA que vai para o congelado e o do arquivo que
            # de fato imprimiu.
            v.avisos.append(
                f"o arquivo de {modelo.rotulo} mudou desde o cadastro "
                "(SHA-256 diferente do registrado): confira o layout"
            )
    return v


# ---------------------------------------------------------------------
# Montagem do contexto
# ---------------------------------------------------------------------
def _dados_do_instrutor(s: Session, vinculo) -> dict:
    instrutor = vinculo.instrutor
    rubrica = None
    if instrutor.imagem_anexo_id is not None:
        from app.modelos import Anexo

        anexo = s.get(Anexo, instrutor.imagem_anexo_id)
        rubrica = anexo.sha256 if anexo is not None else None
    return {
        "nome": instrutor.nome_exibicao,
        "titulo": instrutor.titulo or "",
        "conselho": instrutor.conselho or "",
        "registro": instrutor.registro_completo,
        # o SHA-256, e nao o `anexo_id`: trocar o arquivo da rubrica passa a ser
        # detectavel, e um id continuaria apontando para o registro certo com o
        # conteudo errado (SS4)
        "rubrica_sha256": rubrica,
    }


def _lotacao_na_data(s: Session, inscricao: Inscricao, quando: date) -> str:
    """A unidade em que o participante estava NA DATA DA TURMA.

    Nao a de hoje: o certificado descreve o que aconteceu, e quem mudou de
    unidade depois nao fez o curso na unidade nova.
    """
    servidor = inscricao.participante.servidor
    if servidor is None:
        return ""
    lotacao = servico_servidores.lotacao_em(s, servidor.id, quando)
    unidade = (lotacao.unidade if lotacao else None) or servidor.unidade
    return unidade.nome_extenso if unidade else ""


def montar_contexto_para_emitir(
    s: Session,
    inscricao: Inscricao,
    *,
    numero: int,
    ano: int,
    data_emissao: date,
    chave: str,
    modelo: CertificadoModelo,
    avisos: list[str] | None = None,
) -> ContextoCertificado:
    """O contexto do catalogo de HOJE — usado uma unica vez, na emissao.

    Depois de congelado, `montar_contexto` nunca mais passa por aqui.
    """
    turma = inscricao.turma
    treinamento = turma.treinamento
    participante = inscricao.participante
    servidor = participante.servidor
    setor = setor_emissor_vigente(s, data_emissao)
    validade = int(treinamento.validade_meses or 0)
    base = turma.data_base
    vencimento = datas_br.somar_meses(base, validade) if validade > 0 else None
    mapa = modelo.mapa_de_tags

    return ContextoCertificado(
        participante_nome=participante.nome_exibicao,
        participante_identificador=participante.identificador_publico,
        participante_vinculo=ROTULO_VINCULO.get(
            participante.vinculo, participante.vinculo
        ),
        participante_organizacao=(
            participante.organizacao or ("UFVJM" if servidor is not None else "")
        ),
        participante_siape=servidor.siape if servidor is not None else "",
        participante_lotacao=_lotacao_na_data(s, inscricao, turma.data_inicio),
        treinamento_nome=treinamento.nome,
        treinamento_norma=treinamento.norma_referencia or "",
        # o conteudo inteiro como TEXTO, e nao a FK: renomear o treinamento ou
        # reescrever o programa depois nao pode mudar o papel
        treinamento_conteudo=treinamento.conteudo_programatico or "",
        validade_meses=validade,
        turma_codigo=turma.codigo,
        turma_data_inicio=turma.data_inicio,
        turma_data_fim=turma.data_fim,
        carga_horaria=Decimal(turma.carga_efetiva),
        turma_local=turma.local or "",
        turma_unidade_promotora=(
            turma.unidade_promotora.nome_extenso if turma.unidade_promotora else ""
        ),
        turma_campus=turma.campus.nome if turma.campus else "",
        data_base_vencimento=base,
        nota_final=inscricao.nota_final,
        frequencia_percentual=servico_presenca.frequencia_de(inscricao),
        nota_minima=turma.nota_minima_aprovacao,
        frequencia_minima=turma.frequencia_minima_percentual,
        instrutores=[
            _dados_do_instrutor(s, v) for v in instrutores_que_assinam(turma)
        ],
        numero=numero,
        ano=ano,
        data_emissao=data_emissao,
        chave_validacao=chave,
        data_vencimento=vencimento,
        url_validacao=f"{url_base_validacao(s)}/validar/{chave}",
        setor_sigla=setor.sigla_composta if setor else "",
        setor_nome=setor.nome_extenso if setor else "",
        setor_endereco=(setor.endereco or "") if setor else "",
        cidade=setor.cidade if setor else "Diamantina",
        modelo_id=modelo.id,
        modelo_arquivo=modelo.arquivo,
        modelo_sha256=servico_certificado.sha256_do_modelo(modelo.arquivo),
        modelo_versao=modelo.versao,
        mapa_tags=dict(mapa),
        tags_obrigatorias=tuple(
            sorted(tag.marcador for tag in modelo.tags if tag.obrigatorio)
        ),
        avisos=list(avisos or []),
    )


def montar_contexto(s: Session, certificado: Certificado) -> ContextoCertificado:
    """RN-15: certificado emitido reimprime do congelado, nao do catalogo de hoje.

    Sem isto, renomear um treinamento, republicar o modelo ou — pior — editar o
    dicionario de tags mudaria um documento que ja circulou. E a unica porta de
    leitura de contexto de um certificado gravado: nao ha ramo alternativo que
    volte ao banco, e e essa ausencia que faz a regra valer.
    """
    _ = s  # a assinatura espelha `parecer.montar_contexto`; o congelado basta
    return ContextoCertificado.descongelar(certificado.contexto_congelado)


# ---------------------------------------------------------------------
# Emissao
# ---------------------------------------------------------------------
@dataclass
class ResultadoEmissao:
    certificado: Certificado
    docx: Path
    pdf: Path | None
    aviso_pdf: str | None
    avisos: list[str]


def _chave_inedita(s: Session, ano: int) -> str:
    for _ in range(TENTATIVAS_CHAVE):
        chave = servico_certificado.gerar_chave(ano)
        ja = s.execute(
            select(Certificado.id).where(Certificado.chave_validacao == chave)
        ).first()
        if ja is None:
            return chave
    raise EmissaoBloqueada(  # pragma: no cover - 5 colisoes em 49 bits
        ["não foi possível sortear uma chave de validação inédita"]
    )


def emitir(
    s: Session,
    usuario: UsuarioAtual,
    inscricao: Inscricao,
    *,
    data_emissao: date | None = None,
    gerar_pdf: bool = True,
) -> ResultadoEmissao:
    """Emite o certificado da inscricao, na ordem do SS4 do desenho."""
    usuario.exigir("certificado.emitir")

    # 2. RN-14: um documento por vez. A reemissao passa pela anulacao.
    ja = certificado_da_inscricao(s, inscricao)
    if ja is not None:
        raise EmissaoBloqueada(
            [
                f"{inscricao.participante.nome_exibicao} já tem o certificado "
                f"{ja.rotulo}: anule-o com o motivo antes de reemitir"
            ]
        )

    hoje = data_emissao or date.today()
    # 3. validar TUDO antes de gastar numero
    validacao = validar(s, inscricao, quando=hoje)
    if not validacao.ok:
        raise EmissaoBloqueada(validacao.bloqueios)

    modelo, _aviso = modelo_da_turma(s, inscricao.turma)
    if modelo is None:  # pragma: no cover - `validar` ja bloqueou este caso
        raise EmissaoBloqueada(["não há modelo de certificado para esta turma"])

    # 4. o numero, so agora
    numero = numeracao.proximo_numero_certificado(s, hoje.year)
    # 5. a chave
    chave = _chave_inedita(s, hoje.year)

    # 6. montar e congelar ANTES de renderizar
    contexto = montar_contexto_para_emitir(
        s,
        inscricao,
        numero=numero,
        ano=hoje.year,
        data_emissao=hoje,
        chave=chave,
        modelo=modelo,
        avisos=validacao.avisos,
    )
    faltantes = contexto.obrigatorios_faltantes()
    if faltantes:
        raise EmissaoBloqueada(
            ["marcador obrigatório sem valor: " + ", ".join(faltantes)]
        )

    turma = inscricao.turma
    certificado = Certificado(
        inscricao_id=inscricao.id,
        numero=numero,
        ano=hoje.year,
        chave_validacao=chave,
        situacao="EMITIDO",
        data_emissao=hoje,
        data_base_vencimento=contexto.data_base_vencimento,
        data_vencimento=contexto.data_vencimento,
        validade_meses_congelada=contexto.validade_meses,
        # o que sai no papel e o que fica guardado, e nesta ordem
        contexto_congelado=contexto.congelar(),
        modelo_id=modelo.id,
        modelo_arquivo=modelo.arquivo,
        modelo_sha256=contexto.modelo_sha256,
        servidor_id=inscricao.participante.servidor_id,
        campus_id=turma.campus_id,
        treinamento_id=turma.treinamento_id,
        participante_id=inscricao.participante_id,
        emitido_por=usuario.id,
        emitido_em=agora_utc(),
    )
    s.add(certificado)
    s.flush()

    # 7. renderizar
    destino = caminho_saida(certificado)
    info = servico_certificado.renderizar(contexto, destino)
    certificado.arquivo_docx = str(destino)
    certificado.hash_conteudo = info["hash_conteudo"]

    # 8. trilha
    auditoria.registrar(
        s,
        entidade="certificado",
        entidade_id=certificado.id,
        tipo_evento=CERTIFICADO_EMITIDO,
        # RN-19 na ESCRITA. O DOCUMENTO continua nominal — `participante_nome`
        # segue no contexto congelado (RN-15) e sai impresso no certificado,
        # que nomeia quem se formou por definicao. O que sai daqui e o nome
        # dentro da PROSA da trilha, que se le sob `auditoria.ver` — permissao
        # que nao e de ler nome. O rotulo e a chave ja identificam a emissao.
        descricao=(
            f"Certificado {certificado.rotulo} de "
            f"{contexto.participante_identificador} · {turma.codigo} · "
            f"{contexto.treinamento_nome} · chave {chave}"
        ),
        usuario=usuario,
        valor_novo={
            "numero": certificado.numero,
            "ano": certificado.ano,
            "hash_conteudo": certificado.hash_conteudo,
        },
    )
    for aviso in validacao.avisos:
        auditoria.registrar(
            s,
            entidade="certificado",
            entidade_id=certificado.id,
            tipo_evento="AVISO",
            descricao=aviso,
            usuario=usuario,
        )
    s.flush()

    # 9. o PDF, por ultimo e do lado de fora da transacao. Ver
    # `pdf.converter_fora_da_transacao`: o LibreOffice leva segundos e este banco
    # tem um escritor so. Ate aqui ja esta gravado tudo o que e prova — numero
    # (RN-03), congelado (RN-15), `.docx` com o hash e a cadeia de auditoria.
    resultado_pdf: Path | None = None
    aviso_pdf: str | None = None
    if gerar_pdf:
        resultado_pdf, aviso_pdf = _pdf_depois_da_emissao(
            s, certificado, usuario, destino
        )

    return ResultadoEmissao(
        certificado, destino, resultado_pdf, aviso_pdf, list(validacao.avisos)
    )


def _pdf_depois_da_emissao(
    s: Session, certificado: Certificado, usuario: UsuarioAtual, destino: Path
) -> tuple[Path | None, str | None]:
    """Converte com o lock solto e grava o anexo numa transacao nova e curta.

    **O que muda em relacao ao parecer.** Aqui o PDF nao e so entrega: quando
    sai, ele vira anexo de categoria CERTIFICADO e o certificado passa a
    aponta-lo. Essa gravacao acontece DEPOIS do commit da emissao, numa transacao
    propria — que quem chamou (a rota, ou `emitir_lote`) comita junto com o
    resto. Sao dois commits onde antes havia um; o resultado no banco e o mesmo,
    e o lock de escrita fica livre durante os segundos do LibreOffice.

    **Se a segunda gravacao falhar**, o certificado continua emitido, valido e
    com o `.docx` no disco — falta so o anexo do PDF, que e conveniencia. Por
    isso ela nao pode escapar como excecao: em `emitir_lote` o `except` do laco
    faria `rollback` de uma emissao JA comitada e depois listaria como "travado"
    um certificado que existe, com o numero consumido. Um item do lote nao pode
    virar mentira no relatorio por causa de um anexo.
    """
    conversao = servico_pdf.converter_fora_da_transacao(
        s, destino, destino.with_suffix(".pdf")
    )
    falha = conversao.aviso
    if conversao.caminho is not None:
        try:
            guardado = anexos.guardar_arquivo(
                s,
                conversao.caminho,
                entidade="certificado",
                entidade_id=certificado.id,
                mime_type="application/pdf",
                categoria="CERTIFICADO",
                usuario=usuario,
            )
            certificado.arquivo_pdf_anexo_id = guardado.anexo.id
        except Exception as erro:  # noqa: BLE001 - nunca falhe a emissao pelo PDF
            s.rollback()
            falha = f"{servico_pdf.AVISO_SEM_PDF} (anexo: {erro})"

    if falha is not None and not conversao.indisponivel:
        auditoria.registrar(
            s,
            entidade="certificado",
            entidade_id=certificado.id,
            tipo_evento=auditoria.PDF_NAO_GERADO,
            descricao=(
                f"Certificado {certificado.rotulo} emitido, mas o PDF não ficou "
                f"anexado. O .docx está em {destino.name} e vale como o "
                f"documento; reimprima pela segunda via. Detalhe: {falha}"
            ),
            usuario=usuario,
        )
        return None, falha
    return conversao.caminho, conversao.aviso


# ---------------------------------------------------------------------
# Lote
# ---------------------------------------------------------------------
@dataclass
class ItemDoLote:
    inscricao: Inscricao
    certificado: Certificado | None = None
    erro: str | None = None

    @property
    def ok(self) -> bool:
        return self.certificado is not None


@dataclass
class RelatorioDoLote:
    itens: list[ItemDoLote] = field(default_factory=list)

    @property
    def emitidos(self) -> list[ItemDoLote]:
        return [i for i in self.itens if i.ok]

    @property
    def travados(self) -> list[ItemDoLote]:
        return [i for i in self.itens if not i.ok]

    @property
    def resumo(self) -> str:
        if not self.itens:
            return "ninguém apto a emitir"
        return f"{len(self.emitidos)} emitido(s), {len(self.travados)} travado(s)"


def emitir_lote(
    s: Session,
    usuario: UsuarioAtual,
    turma: Turma,
    *,
    inscricao_ids: list[int] | None = None,
    gerar_pdf: bool = True,
    data_emissao: date | None = None,
) -> RelatorioDoLote:
    """Uma turma de trinta pessoas nao se emite uma a uma.

    **Uma transacao por certificado**, e e isso que faz o lote valer: um item
    que falha no meio nao derruba os que ja sairam nem os que vem depois. Sem o
    commit por item, a primeira excecao desfaria o lote inteiro — inclusive os
    numeros ja consumidos — e o setor teria de recomecar do zero descobrindo um
    problema por vez.

    A permissao e exigida aqui, antes do laco: numa turma sem ninguem apto o
    laco nunca rodaria e quem nao pode emitir receberia "nenhum certificado
    emitido" em vez de "permissao negada".
    """
    usuario.exigir("certificado.emitir")
    from app.servicos.turma import inscricoes_da_turma

    escolhidas = None if inscricao_ids is None else set(inscricao_ids)
    alvos = [
        inscricao
        for inscricao in inscricoes_da_turma(s, turma)
        if escolhidas is None or inscricao.id in escolhidas
    ]
    ja_emitidos = certificados_da_turma(s, turma)
    relatorio = RelatorioDoLote()
    for inscricao in alvos:
        if inscricao.id in ja_emitidos:
            # no lote isso nao e erro: quem ja tem certificado simplesmente nao
            # entra de novo, e dizer "ja tem" trinta vezes esconderia o que
            # realmente travou
            continue
        if inscricao.situacao != "APROVADO":
            continue
        try:
            emitido = emitir(
                s,
                usuario,
                inscricao,
                gerar_pdf=gerar_pdf,
                data_emissao=data_emissao,
            )
        except Exception as erro:  # noqa: BLE001 - o lote registra e segue
            s.rollback()
            relatorio.itens.append(ItemDoLote(inscricao=inscricao, erro=str(erro)))
            continue
        s.commit()
        relatorio.itens.append(
            ItemDoLote(inscricao=inscricao, certificado=emitido.certificado)
        )

    auditoria.registrar(
        s,
        entidade="turma",
        entidade_id=turma.id,
        tipo_evento=CERTIFICADO_LOTE,
        descricao=f"{turma.codigo}: {relatorio.resumo}",
        usuario=usuario,
    )
    s.flush()
    return relatorio


# ---------------------------------------------------------------------
# Anulacao
# ---------------------------------------------------------------------
def anular(
    s: Session,
    usuario: UsuarioAtual,
    certificado: Certificado,
    motivo: str,
    *,
    substituido_por: Certificado | None = None,
) -> Certificado:
    """`situacao = 'ANULADO'`, com motivo obrigatorio. O documento nao e apagado.

    Nada some por clique: a politica de retencao do sistema vale aqui como
    vale no parecer. Anular e o que libera a reemissao (o indice parcial
    `uq_certificado_ativo` so conta o nao anulado) e o que faz a pagina publica
    passar a responder ANULADO — que e justamente o que da sentido a anulacao.
    """
    usuario.exigir("certificado.anular")
    limpo = (motivo or "").strip()
    if not limpo:
        raise ValueError(
            "Anular exige o motivo: é o único registro que sobra para quem "
            "receber o papel antigo e perguntar por que ele não vale mais."
        )
    if certificado.anulado:
        raise ValueError(f"O certificado {certificado.rotulo} já está anulado.")

    certificado.situacao = "ANULADO"
    certificado.motivo_anulacao = limpo
    certificado.anulado_em = agora_utc()
    certificado.anulado_por = usuario.id
    if substituido_por is not None:
        certificado.substituido_por_id = substituido_por.id

    auditoria.registrar(
        s,
        entidade="certificado",
        entidade_id=certificado.id,
        tipo_evento=CERTIFICADO_ANULADO,
        descricao=f"Certificado {certificado.rotulo} anulado: {limpo}",
        campo="situacao",
        valor_anterior="EMITIDO",
        valor_novo="ANULADO",
        comentario=limpo,
        usuario=usuario,
    )
    s.flush()
    return certificado


# ---------------------------------------------------------------------
# Segunda via
# ---------------------------------------------------------------------
@dataclass
class ResultadoSegundaVia:
    docx: Path
    hash_conteudo: str
    confere: bool
    aviso: str | None = None


def segunda_via(
    s: Session,
    usuario: UsuarioAtual,
    certificado: Certificado,
    *,
    gerar_pdf: bool = False,
) -> ResultadoSegundaVia:
    """Reimprime do congelado e confere o hash contra o da emissao.

    Certificado anulado tambem tem segunda via, de proposito: quem precisa
    juntar ao processo o papel que foi anulado precisa do papel. O que a
    anulacao muda e a resposta da pagina publica, nao a existencia do documento.

    A conferencia do hash e barata e vale muito: se o texto reimpresso divergir
    do da emissao, alguma coisa fora do congelado entrou no documento — na
    pratica, o `.docx` do modelo trocado por fora. A segunda via sai assim
    mesmo, com aviso, e a divergencia entra na trilha. Recusar a impressao
    deixaria o setor sem o documento **e** sem a informacao.
    """
    # Chamada pelo efeito, e nao pelo retorno: e ela que levanta para quem nao
    # pode ler o certificado. A relacao titular/terceiro que ela devolve deixou
    # de ser lida aqui — quem faz essa pergunta agora e `registrar_leitura_nominal`.
    exigir_leitura_do_certificado(usuario, certificado.servidor_id)
    contexto = montar_contexto(s, certificado)
    destino = caminho_saida(certificado)
    info = servico_certificado.renderizar(contexto, destino)
    confere = (
        certificado.hash_conteudo is None
        or certificado.hash_conteudo == info["hash_conteudo"]
    )
    aviso = None
    if not confere:
        aviso = (
            f"O texto reimpresso do certificado {certificado.rotulo} não confere "
            "com o da emissão — o arquivo do modelo provavelmente foi trocado "
            "fora do sistema. A segunda via saiu assim mesmo e a divergência foi "
            "registrada na trilha."
        )
        auditoria.registrar(
            s,
            entidade="certificado",
            entidade_id=certificado.id,
            tipo_evento=CERTIFICADO_DIVERGENTE,
            descricao=aviso,
            campo="hash_conteudo",
            valor_anterior=certificado.hash_conteudo,
            valor_novo=info["hash_conteudo"],
            usuario=usuario,
        )

    # a segunda via de um documento nominal e leitura de dado de pessoa
    # identificada: quem tirou e quando entra na trilha, como na lista de
    # presenca e no parecer nominal
    auditoria.registrar(
        s,
        entidade="certificado",
        entidade_id=certificado.id,
        tipo_evento=CERTIFICADO_SEGUNDA_VIA,
        descricao=(
            f"Segunda via do certificado {certificado.rotulo} "
            f"({contexto.participante_identificador}) · {info['hash_conteudo'][:12]}"
        ),
        usuario=usuario,
    )
    # A segunda via do PROPRIO certificado nao entra em `acesso_dado_sensivel`.
    # E a mesma decisao que a 1.35.0 tomou para a ficha de EPI e que o
    # `docs/ROPA.md` §6 registra — a tabela responde "quem leu o dado de quem",
    # e o titular lendo o dele mesmo enche a tabela de linhas que nao respondem
    # pergunta nenhuma. A trilha acima continua gravando a segunda via em todos
    # os casos: quantas vias sairam e de quem e outra pergunta, e essa vale
    # sempre.
    #
    # A condicao era `de_outro and servidor_id is not None`, escrita aqui e mais
    # duas vezes no sistema. Ela agora e lida uma vez so, em
    # `auditoria.leitura_de_terceiro`: e a mesma pergunta, e a proxima correcao
    # de criterio nao pode alcancar duas copias e esquecer a terceira.
    auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo="certificado",
        servidor_id=certificado.servidor_id,
        finalidade="segunda via do certificado de treinamento",
    )
    s.flush()

    # Por ultimo, e depois do commit, pelo mesmo motivo do passo 9 da emissao.
    # Aqui `gerar_pdf` e False por padrao e nenhuma rota o liga hoje — o que
    # torna esta linha, hoje, teoria. Ela e corrigida junto assim mesmo: a
    # proxima pessoa que ligar o parametro nao vai reler esta funcao inteira, e o
    # ponto do padrao e nao sobrar uma copia do defeito esperando ser acordada.
    if gerar_pdf:
        servico_pdf.converter_fora_da_transacao(
            s, destino, destino.with_suffix(".pdf")
        )

    return ResultadoSegundaVia(destino, info["hash_conteudo"], confere, aviso)


__all__ = [
    "CERTIFICADO_ANULADO",
    "CERTIFICADO_DIVERGENTE",
    "CERTIFICADO_EMITIDO",
    "CERTIFICADO_LOTE",
    "CERTIFICADO_SEGUNDA_VIA",
    "PARAMETRO_URL_PUBLICA",
    "TIPO_DOCX",
    "EmissaoBloqueada",
    "ItemDoLote",
    "RelatorioDoLote",
    "ResultadoEmissao",
    "ResultadoSegundaVia",
    "Validacao",
    "anular",
    "caminho_saida",
    "certificado_da_inscricao",
    "certificados_da_turma",
    "consulta_do_titular",
    "emitir",
    "emitir_lote",
    "exigir_leitura_do_certificado",
    "instrutores_que_assinam",
    "modelo_da_turma",
    "montar_contexto",
    "montar_contexto_para_emitir",
    "segunda_via",
    "url_base_validacao",
    "validar",
]
