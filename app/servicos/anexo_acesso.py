"""Quem pode ver o dono do anexo pode baixar o anexo — e nada além disso.

`GET /anexos/{id}` nasceu como conveniência da ficha do processo e cobrava
**só login**: quem tivesse conta baixava qualquer arquivo por contagem de
inteiros. Medido em `entrada/implantacao/00_PRONTIDAO.md` §A-1: o
`almoxarife_sesmt` — cuja base normativa diz "não lê parecer" — e o
`servidor_consulta` — que existe para o titular ver o **próprio** processo
(LGPD art. 18, II) — liam o parecer assinado de qualquer servidor. O parecer
nomeia uma pessoa e descreve a exposição dela a agente nocivo; o comprovante de
EPI traz a assinatura manuscrita digitalizada, que o `docs/ROPA.md` §4.3 chama
de o item mais sensível do módulo. Nada disso entrava em `acesso_dado_sensivel`:
a varredura não deixava linha nenhuma.

**A correção não é uma regra nova de anexo. Anexo não tem autorização própria:
ele herda a de quem o carrega.** `anexo.entidade` + `anexo.entidade_id` já dizem
a quem o arquivo pertence, e cada dono tem uma tela cuja regra já foi decidida e
já está amarrada por teste — o escopo do repositório de processo, `epi.ficha`
contra ficha própria, o escopo do certificado. Este módulo faz uma coisa só:
resolve o dono e delega a ele. Escrever aqui uma segunda regra seria fabricar a
divergência — a tela apertaria e o download continuaria frouxo, ou o contrário,
e ninguém veria até alguém medir.

O nível de acesso do anexo **não** decide nada, e era ele que decidia: sete das
dezesseis categorias nascem `PUBLICO` (`anexos.NIVEL_POR_CATEGORIA`), inclusive
`PARECER_ASSINADO`. "Público" ali quer dizer *não precisa de tratamento
especial dentro do módulo*, e nunca quis dizer *qualquer conta baixa*. A
categoria continua decidindo o que sempre decidiu — retenção — e o dono decide
acesso.

Entidade sem resolvedor declarado **nega**, como todo o resto do RBAC deste
sistema (`rbac.py:1-6`). Categoria nova entra com o módulo que a cria, e o
módulo que a cria sabe de quem ela é; um caminho permissivo aqui reabriria a
porta, calado, na próxima fatia — que foi exatamente como esta rota chegou até
aqui.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.modelos import Anexo, Certificado, EpiFichaRegistro, ParecerTecnico
from app.servicos import auditoria
from app.servicos.rbac import PermissaoNegada, UsuarioAtual

ANEXO_BAIXADO = "ANEXO_BAIXADO"

# Uma frase só, para os quatro casos: id que não existe, anexo desativado, dono
# fora do escopo e entidade sem regra. A rota devolve a mesma resposta para
# todos porque distinguir "não existe" de "não pode" mantém a enumeração viva —
# ela deixa de baixar o arquivo e passa a responder "este id existe", que é o
# mesmo oráculo com um passo a mais. Quem tem direito ao arquivo chega nele pela
# tela do dono, e ali a mensagem é específica.
INDISPONIVEL = "O anexo não existe ou está fora do seu alcance."


class AnexoForaDeAlcance(PermissaoNegada):
    """O anexo não existe, não está ativo, ou o dono não é alcançável."""

    def __init__(self, detalhe: str = INDISPONIVEL) -> None:
        super().__init__("anexo", detalhe)


class DonoNaoDeclarado(AnexoForaDeAlcance):
    """Entidade dona sem regra em `RESOLVEDORES` — nega, e diz o nome dela.

    Mesmo espírito de `EscopoNaoDeclarado`: negar em vez de cair num padrão
    permissivo, e dizer qual entidade ficou de fora para que isso se conserte em
    minutos em vez de virar um vazamento que ninguém sabe que existe.
    """

    def __init__(self, entidade: str) -> None:
        self.entidade = entidade
        super().__init__(
            f"Anexos de '{entidade}' não têm regra de acesso declarada em "
            "`app/servicos/anexo_acesso.py`. Enquanto não tiverem, o download é "
            "negado — avise o administrador do sistema."
        )


@dataclass(frozen=True)
class Dono:
    """A quem o anexo pertence, e o que o registro de acesso precisa saber.

    `servidor_id` é o "sobre quem" do registro (LGPD art. 37): sem ele a linha
    grava que alguém leu alguma coisa, e é isso que a porta de trás do
    `FICHA_EPI` produzia — registro que existe e não sustenta investigação
    nenhuma.
    """

    entidade: str
    servidor_id: int | None
    processo_id: int | None
    finalidade: str


def _dono_processo(s: Session, usuario: UsuarioAtual, anexo: Anexo) -> Dono:
    """A mesma porta de `GET /processos/{id}`: a permissão e o escopo do repositório."""
    from app.repositorios import processos as repo

    usuario.exigir("processo.ver")
    processo = repo.por_id(s, usuario, anexo.entidade_id)
    if processo is None:
        raise AnexoForaDeAlcance()
    return Dono(
        "processo",
        processo.servidor_id,
        processo.id,
        "consulta de anexo do processo de adicional ocupacional",
    )


def _dono_parecer(s: Session, usuario: UsuarioAtual, anexo: Anexo) -> Dono:
    """A mesma porta de `GET /pareceres/{id}`: `parecer.ver` mais o escopo.

    O anexo do parecer é o parecer **assinado**: o documento nominal em si, o
    que fundamenta o adicional. Até a 1.34.0 esta era a única leitura escopada
    de parecer do sistema, e o comentário que morava aqui descrevia a leitura
    sem escopo do editor como "folga dele, não regra a copiar" — o que era justo
    entre nove colegas da CSSO e deixou de ser quando `parecer.ver` passou a ir
    para milhares de contas. A regra virou uma só, `parecer.no_escopo`, e este
    módulo chama a mesma que a tela: era a existência de **duas** leituras que
    fazia o anexo assinado ficar mais protegido que o parecer que o gerou.
    """
    from app.servicos import parecer as servico_parecer

    usuario.exigir("parecer.ver")
    parecer = servico_parecer.no_escopo(s, usuario, anexo.entidade_id)
    if parecer is None:
        raise AnexoForaDeAlcance()
    return Dono(
        ParecerTecnico.__tablename__,
        parecer.servidor_id,
        parecer.processo_id,
        "leitura de documento anexado ao parecer técnico",
    )


def _dono_ficha_epi(s: Session, usuario: UsuarioAtual, anexo: Anexo) -> Dono:
    """A regra da ficha, chamada onde ela mora — não uma cópia dela.

    `exigir_leitura_da_ficha` é a mesma função que a tela da ficha e a porta da
    frente do comprovante usam. Era a existência de uma **segunda** regra aqui
    (`exposicao.ver`, que não é `epi.ficha`) que deixava o download do
    comprovante assinado com rigor diferente do da tela que o exibe.
    """
    from app.servicos import epi_ficha

    registro = s.get(EpiFichaRegistro, anexo.entidade_id)
    if registro is None:
        raise AnexoForaDeAlcance()
    epi_ficha.exigir_leitura_da_ficha(usuario, registro.servidor_id)
    return Dono(
        EpiFichaRegistro.__tablename__,
        registro.servidor_id,
        None,
        "leitura do comprovante assinado de entrega de EPI",
    )


def _dono_certificado(s: Session, usuario: UsuarioAtual, anexo: Anexo) -> Dono:
    """A mesma leitura de `/certificados/{id}` — a regra do dono e o escopo.

    Era `usuario.exigir("certificado.ver")` cru, e o defeito era o mesmo que
    `_dono_ficha_epi` ja descreve: uma SEGUNDA regra para o mesmo documento. Com
    o titular alcancando a propria ficha e a propria segunda via, um `exigir`
    solto aqui deixaria o PDF anexado mais fechado que o .docx reimpresso do
    mesmo certificado — e a assimetria so apareceria para quem tentasse.
    """
    from app.servicos import emissao_certificado

    # o mesmo primeiro passo de `rotas/certificados._abrir`: quem nao tem a
    # permissao nem cadastro de servidor leva 403 antes de o banco ser tocado, e
    # nao um "fora de alcance" que contaria se o anexo existe
    if not usuario.pode("certificado.ver") and usuario.servidor_id is None:
        usuario.exigir("certificado.ver")
    certificado = emissao_certificado.no_escopo(s, usuario, anexo.entidade_id)
    if certificado is None:
        raise AnexoForaDeAlcance()
    emissao_certificado.exigir_leitura_do_certificado(
        usuario, certificado.servidor_id
    )
    return Dono(
        Certificado.__tablename__,
        certificado.servidor_id,
        None,
        "leitura de documento anexado ao certificado de treinamento",
    )


# A lista fechada. Cada linha é um módulo que já decidiu quem vê o dono; o que
# não está aqui não desce. As categorias previstas e ainda sem tela — turma,
# item de EPI, acidente — entram junto com o módulo que passar a gravá-las.
RESOLVEDORES: dict[str, Callable[[Session, UsuarioAtual, Anexo], Dono]] = {
    "processo": _dono_processo,
    ParecerTecnico.__tablename__: _dono_parecer,
    EpiFichaRegistro.__tablename__: _dono_ficha_epi,
    Certificado.__tablename__: _dono_certificado,
}


def autorizar(s: Session, usuario: UsuarioAtual, anexo: Anexo | None) -> Dono:
    """Devolve o dono, ou levanta. Não escreve nada."""
    if anexo is None or not anexo.ativo:
        raise AnexoForaDeAlcance()
    resolvedor = RESOLVEDORES.get(anexo.entidade)
    if resolvedor is None:
        raise DonoNaoDeclarado(anexo.entidade)
    return resolvedor(s, usuario, anexo)


def registrar_leitura(
    s: Session, usuario: UsuarioAtual, anexo: Anexo, dono: Dono
) -> None:
    """Duas linhas, porque são duas perguntas diferentes numa investigação.

    `acesso_dado_sensivel` responde **de quem é o dado que foi lido** — a coluna
    `servidor_id`, que é a que a porta de trás do `FICHA_EPI` deixava nula, e a
    finalidade, que ela preenchia com o padrão genérico do outro módulo. É a
    tabela que o `docs/ROPA.md` §6 promete e a que responde "quem abriu a ficha
    de quantas pessoas".

    `historico_evento` responde **qual arquivo** — `entidade='anexo'` com o id —,
    e responde de forma que não se apaga: a trilha é encadeada por SHA-256 e o
    banco recusa `UPDATE` e `DELETE`. Sem ela o registro diria a pessoa e o
    tipo do documento, e não qual dos documentos dela saiu.

    A descrição não repete o nome do arquivo. `parecer-fulano-de-tal.pdf` é
    identificação nominal escrita de outro jeito (§L-2), e a trilha do processo
    é visível a quem tem `processo.ver` sem ter `exposicao.ver`.

    **As duas linhas não obedecem à mesma condição, e é de propósito.** A trilha
    sai sempre — "qual arquivo saiu" vale para o titular também, e é ela que
    responde quantas vias de um documento circularam. `acesso_dado_sensivel`
    passa por `registrar_leitura_nominal`: até a 1.36.0 nenhum titular alcançava
    anexo nenhum e a diferença não existia; desde que ele abre o próprio
    comprovante e o próprio certificado, gravar essa leitura seria tratar o art.
    18, II como suspeita — o oposto do que a 1.35.0 decidiu, e a mesma decisão
    que a ficha, o certificado e a segunda via já aplicam.
    """
    auditoria.registrar_leitura_nominal(
        s,
        usuario,
        campo=f"anexo.{anexo.categoria}",
        servidor_id=dono.servidor_id,
        processo_id=dono.processo_id,
        finalidade=dono.finalidade,
    )
    auditoria.registrar(
        s,
        entidade="anexo",
        entidade_id=anexo.id,
        processo_id=dono.processo_id,
        tipo_evento=ANEXO_BAIXADO,
        descricao=(
            f"Anexo {anexo.id} ({anexo.categoria}) baixado — "
            f"{dono.entidade} {anexo.entidade_id}."
        ),
        usuario=usuario,
    )


def liberar(s: Session, usuario: UsuarioAtual, anexo: Anexo | None) -> Dono:
    """Autoriza **e** registra, nesta ordem, numa chamada só.

    As duas juntas de propósito: separá-las devolveria a quem escrever a próxima
    rota de download a chance de fazer a primeira e esquecer a segunda — que é
    metade do defeito que este módulo existe para fechar.
    """
    dono = autorizar(s, usuario, anexo)
    registrar_leitura(s, usuario, anexo, dono)
    return dono
