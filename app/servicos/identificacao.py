"""RN-19 num lugar so: como o servidor aparece na tela.

Por que existe: a supressao da identificacao nominal estava reescrita em cada
template, e cada copia decidia sozinha. `/servidores` chamava
`textos.identificador_opaco`; `/processos` e `/adicionais` formatavam o proprio
id do banco (`SRV-0007`), que nao e opaco coisa nenhuma — e enumeravel, e igual
para todos os usuarios e nunca batia com o `SRV-7f3a` que a outra tela mostrava
para a mesma pessoa; o painel e o cartao do kanban, as duas telas que mais gente
abre, nao suprimiam nada.

A regra nao volta a se espalhar porque tela nenhuma decide mais: ela chama
`identificar(...)` e recebe pronto o que pode escrever. Quem decide e esta
funcao, e o teste `test_rn19_nenhum_template_le_nome_de_servidor_direto` recusa
template que leia `servidor.nome` ou `servidor.siape` por fora dela — e onde ha
motivo, o motivo fica escrito na lista de dispensas, nao subentendido.

Ha um segundo caminho pelo qual o nome chega a tela, e ele nao passa por campo
nenhum: o TEXTO LIVRE que o sistema escreveu no ato do evento — a `descricao`
da trilha de auditoria e a da pendencia. Ali o nome esta no meio de uma frase,
e por isso `identificar()` nunca o ve. Quem trata desse caso e `texto_livre()`,
abaixo, e o argumento de por que ele suprime a frase inteira em vez de raspar o
nome de dentro dela esta escrito la.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.servicos import textos
from app.servicos.autenticacao import COOKIE_SESSAO
from app.servicos.rbac import UsuarioAtual

# Nao ha servidor vinculado — nada a suprimir, nada a revelar.
SEM_SERVIDOR = "—"

# O que fica no lugar da frase que a trilha (ou a pendencia) gravou. Diz que ha
# texto e que ele foi escondido: "—" se leria como "nao houve descricao", e uma
# linha do tempo sem descricao nenhuma parece trilha quebrada, nao trilha
# protegida.
TEXTO_SUPRIMIDO = "conteúdo suprimido (RN-19)"


@dataclass(frozen=True)
class Identificacao:
    """O que a tela pode escrever sobre a pessoa, ja decidido.

    `nome` NUNCA e o nome real quando `nominal` e falso: e o identificador
    opaco. Assim o template que so imprime `{{ identificar(x) }}` — o caso
    comum — nao consegue vazar nem esquecendo de olhar `nominal`.
    """

    nominal: bool
    nome: str
    siape: str
    servidor_id: int | None = None

    def __str__(self) -> str:
        return self.nome

    @property
    def com_siape(self) -> str:
        """'Fulano · SIAPE 1110654' — a forma do cadastro de servidores."""
        if self.nominal and self.siape:
            return f"{self.nome} · SIAPE {self.siape}"
        return self.nome

    @property
    def suprimida(self) -> bool:
        """Ha alguem ali e o nome foi escondido — diferente de nao haver ninguem."""
        return not self.nominal and self.servidor_id is not None


def semente_de(request) -> str:
    """A semente do identificador opaco e o prefixo do cookie de sessao.

    Duas consequencias, e as duas sao a intencao: dentro da mesma sessao o mesmo
    servidor recebe sempre o mesmo `SRV-xxxx`, senao a tela nao serviria para
    trabalhar; e entre sessoes — e entre usuarios diferentes ao mesmo tempo — o
    codigo muda, entao ninguem monta dossie estavel nem cruza planilha pelo
    codigo. Por isso a semente vem do pedido, e nao do banco.
    """
    if request is None:
        return ""
    return (request.cookies.get(COOKIE_SESSAO) or "")[:16]


def pode_ver_nominal(usuario: UsuarioAtual | None, servidor_id: int | None) -> bool:
    """`exposicao.ver` — ou ser o proprio titular.

    O titular vendo o proprio nome nao e vazamento: e o perfil
    `servidor_consulta` inteiro, que existe para a consulta do art. 18, II da
    LGPD e de proposito nao tem `exposicao.ver`. Sem esta linha ele abriria o
    proprio processo e leria `SRV-7f3a`.
    """
    if usuario is None:
        return False
    if usuario.ve_dado_nominal:
        return True
    return servidor_id is not None and usuario.servidor_id == servidor_id


def casa_a_busca(alvo: str, servidor, usuario: UsuarioAtual | None) -> bool:
    """RN-19 do lado do FILTRO: o nome so casa para quem pode ver AQUELE nome.

    A supressao da exibicao nao vale nada sozinha. A lista esconde o nome de
    quem nao tem permissao nominal, mas um filtro que continuasse casando por
    nome devolveria UMA linha e amarraria o nome ao `SRV-xxxx` da sessao — a
    ligacao exata que a supressao existe para impedir. Esconder a coluna nao
    adianta se o filtro responde "sim, e este".

    O criterio e por LINHA, e nao por permissao em bloco: `pode_ver_nominal` ja
    sabe que quem tem `exposicao.ver` (ou `epi.ficha`) ve todos e que o titular
    ve o proprio (LGPD art. 18, II). Assim quem podia buscar por nome continua
    buscando, e o servidor que consulta o proprio cadastro se acha.

    O SIAPE vale para todo mundo: e a chave que `/servidores` declara ("A chave
    e o SIAPE — nunca o nome"), quem procura ja a traz do processo no SEI, e sem
    ela a lista longa fica sem filtro nenhum. O e-mail institucional entra na
    classe do nome, e nao na do SIAPE: `nome.sobrenome@` e o nome escrito de
    outro jeito.

    Mora aqui, e nao em cada rota, porque esta funcao ja existia tres vezes —
    `/servidores`, a fila de EPI e agora a busca global — e a copia que
    esquecesse `pode_ver_nominal` seria justamente o oraculo. `alvo` vem
    normalizado por `textos.chave_busca`.
    """
    if servidor is None:
        return False
    if alvo in (servidor.siape or ""):
        return True
    if not pode_ver_nominal(usuario, getattr(servidor, "id", None)):
        return False
    return alvo in textos.chave_busca(servidor.nome) or alvo in textos.chave_busca(
        getattr(servidor, "email", "") or ""
    )


def texto_livre(
    texto: str | None,
    usuario: UsuarioAtual | None,
    *,
    sobre=None,
    vazio: str = SEM_SERVIDOR,
) -> str:
    """RN-19 na PROSA: a `descricao` da trilha e a da pendencia.

    O nome saia por aqui porque aqui nao ha campo. `Rascunho de requisicao de
    EPI para Gorete Vasconcelos Pimenta (SIAPE 3010077) aberto por Rosalina
    Teixeira Bopp` e uma frase inteira gravada no ato do evento; nao existe
    `servidor.nome` para `identificar()` interceptar, e por isso a supressao
    montada na exibicao e no filtro passava ao largo dela.

    **Suprime a frase inteira, e nao o nome dentro dela.** A tentacao e raspar
    o nome por substituicao, e ela nao se sustenta por duas razoes que se
    somam: (a) texto livre nao tem esquema — nenhuma varredura sabe dizer quais
    palavras de uma frase arbitraria sao nome de pessoa, e a que errar erra
    para o lado de deixar passar; (b) a frase nomeia gente que a tela nao
    carregou (o requerente, a chefia, quem entregou o EPI), entao nem a lista de
    nomes a raspar existe. Suprimir por permissao e a unica regra que se pode
    provar; raspar por padrao so pareceria mais elegante.

    **Nao reescreve nada.** A `descricao` entra no digest SHA-256 da cadeia
    (`auditoria._digerir`), entao corrigir o passado quebraria a conferencia que
    da valor probatorio a trilha — e a trilha vale justamente por nao poder ser
    corrigida. A decisao fica na LEITURA porque e o unico lado em que ainda ha
    escolha. A outra metade — parar de escrever nome em `descricao` nova, como
    `anexo_acesso.py:220-222` ja decidiu para nome de arquivo e `direito.py:243`
    ja pratica com `servidor #{id}` — e definitiva, mas so vale para o que ainda
    nao foi gravado; as duas nao se substituem.

    Essa outra metade agora tem guarda propria:
    `test_rn19_nenhuma_prosa_nova_grava_nome_de_pessoa` varre `app/` pela arvore
    de sintaxe e recusa `descricao=`, `motivo=`, `finalidade=` e
    `justificativa=` que interpolem identificacao de pessoa. Com ela, o que
    chega aqui de agora em diante e prosa que ja nao identifica ninguem sozinha,
    e esta funcao passa a ser a rede de seguranca do que esta gravado desde
    antes — que continua sendo a maior parte da trilha.

    `sobre` e a entidade de quem e o texto, quando a tela sabe: a ficha da
    requisicao sabe (`requisicao`), a lista de `/pendencias` nao. Sabendo, o
    titular le a propria trilha (LGPD art. 18, II) — sem isso o perfil que
    existe para consultar o proprio processo leria a propria historia
    suprimida. Nao sabendo, cai em `pode_ver_nominal(usuario, None)`, que e o
    lado seguro: so quem ve nome de qualquer pessoa le a frase.
    """
    if not texto:
        return vazio
    _, servidor_id = _resolver(sobre)
    if pode_ver_nominal(usuario, servidor_id):
        return texto
    return TEXTO_SUPRIMIDO


def _resolver(alvo) -> tuple[object | None, int | None]:
    """Aceita o `Servidor`, quem aponta para ele (processo, parecer, vigencia)
    ou so o id — porque a tela as vezes tem o objeto e as vezes so a chave, e
    obrigar cada uma a saber qual dos tres tem e o convite a esquecer."""
    if alvo is None:
        return None, None
    if isinstance(alvo, int):
        return None, alvo
    if hasattr(alvo, "servidor_id") or hasattr(alvo, "servidor"):
        return getattr(alvo, "servidor", None), getattr(alvo, "servidor_id", None)
    return alvo, getattr(alvo, "id", None)


def identificar(
    alvo,
    usuario: UsuarioAtual | None,
    semente: str,
    *,
    vazio: str = SEM_SERVIDOR,
) -> Identificacao:
    servidor, servidor_id = _resolver(alvo)
    if servidor is not None and servidor_id is None:
        servidor_id = getattr(servidor, "id", None)
    if servidor is None and servidor_id is None:
        return Identificacao(nominal=False, nome=vazio, siape="")

    if servidor is not None and pode_ver_nominal(usuario, servidor_id):
        return Identificacao(
            nominal=True,
            nome=servidor.nome,
            siape=servidor.siape or "",
            servidor_id=servidor_id,
        )
    # Sem o objeto carregado sobra o id, e com o id so da para o codigo opaco -
    # que e o lado seguro do erro.
    return Identificacao(
        nominal=False,
        nome=textos.identificador_opaco(servidor_id, semente),
        siape="",
        servidor_id=servidor_id,
    )
