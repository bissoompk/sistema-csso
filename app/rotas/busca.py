"""/buscar — a caixa do cabeçalho, agora atravessando o sistema inteiro.

A tela é um índice: seis blocos, cada um guardado pela permissão que a sua rota
de destino exige, e cada linha levando à tela que de fato abre para quem
perguntou. Quem monta os blocos é `servicos.busca`; aqui fica a rota, o recado do
CPF e a decisão de auditoria — que está logo abaixo, porque é a única coisa desta
tela que se decide uma vez e não se vê mais.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.dependencias import SessaoDep, UsuarioDep
from app.modelos.estados import ROTULO_EPI_REQUISICAO
from app.servicos import busca as servico, textos
from app.web import pagina

rotas = APIRouter(tags=["busca"])


@rotas.get("/buscar")
def tela(request: Request, s: SessaoDep, usuario: UsuarioDep, q: str = ""):
    """A busca global. Abre para qualquer sessão; cada bloco se guarda sozinho.

    **Não exige permissão nenhuma**, de propósito. A permissão vive nos blocos —
    é lá que ela pode negar alguma coisa —, e um 403 na tela inteira devolveria
    ao almoxarife exatamente o que a 1.27.0 tinha acabado de tirar dele: um campo
    de texto que responde "acesso negado". Sem nenhum bloco visível a tela abre e
    diz isso em português, que é o mesmo recuo de `/modulos`.

    **Não grava `acesso_dado_sensivel`, e a decisão é deliberada.** A RN-23
    registra a LEITURA do dado sensível — exposição, parecer nominal, anexo
    restrito, ficha de EPI de outra pessoa —, e é por isso que `/servidores/{id}`
    e `/epis/fichas/{id}` gravam. Nenhuma lista grava: `/servidores`,
    `/processos` e a fila de EPI mostram a mesma identificação (já suprimida pela
    RN-19) e não escrevem linha nenhuma. Esta tela é uma lista de listas, e três
    razões a mantêm assim:

    1. **O que se registra é a porta, não o índice.** Quem achou o nome aqui
       ainda precisa clicar, e o clique cai numa rota que já conta. Registrar os
       dois lados contaria a mesma leitura duas vezes.
    2. **Registrar tudo apaga o sinal.** `acesso_dado_sensivel` é a tabela que o
       auditor lê para perguntar "quem abriu a ficha de quantas pessoas". Uma
       linha por busca — e busca é o gesto que mais se repete num sistema com
       `Ctrl+K` — afogaria as leituras de verdade em ruído. Diluir a trilha é
       custo de privacidade, não ganho.
    3. **Escrever aqui custaria o lock.** A gravação abriria transação de escrita
       (RN-03, `BEGIN IMMEDIATE`) na tela mais acionada do sistema, e uma leitura
       de índice não pode disputar o lock com quem está gravando um parecer.

    O que a busca **não** deixa de proteger é o que importa: ela nunca casa por
    nome para quem não pode ler aquele nome, e nunca devolve linha que a tela de
    destino esconderia.
    """
    termo = (q or "").strip()
    return pagina(
        request,
        "paginas/busca.html",
        usuario=usuario,
        q=q,
        termo=termo,
        # a caixa do cabeçalho não pode esvaziar quando a pessoa cai no
        # resultado: é dela que a próxima tentativa parte
        busca=termo,
        blocos=servico.buscar(s, usuario, termo),
        # o que a busca cobre PARA ESTA PESSOA — a tela usa para dizer onde
        # procurou. O que ficou de fora não é nomeado em lugar nenhum: dizer
        # "há um bloco de laudos que você não vê" já é dizer que há laudos.
        cobertura=servico.cobertura(usuario),
        # o estado da requisição é chave de banco, e a fila já o traduz por este
        # mapa: repetir a tradução no template criaria a segunda cópia que
        # divergiria no primeiro estado novo
        rotulos_requisicao=ROTULO_EPI_REQUISICAO,
        recado_cpf=servico.RECADO_CPF if textos.parece_cpf(termo) else "",
    )
