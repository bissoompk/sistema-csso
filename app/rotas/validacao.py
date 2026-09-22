"""/validar — a página pública que confirma um certificado pela chave.

Fatia 5 do desenho de Certificados, e a única rota deste sistema que **não pede
sessão**. A exceção é declarada aqui, testada em
`testes/integracao/test_validacao_publica.py` e conferida pelo invariante
`test_so_estas_rotas_abrem_sem_sessao`: negado por padrão continua valendo, e o
que muda é que a lista das exceções passou a existir por escrito.

**Por que ela existe agora.** `emissao_certificado.montar_contexto_para_emitir`
grava `url_validacao = "{url_base}/validar/{chave}"` em todo certificado, o
docxtpl a imprime no papel e no QR, e a ficha a exibe. A rota não existia: cada
certificado que saiu do setor circula com um endereço que responde 404, e papel
não se corrige depois de entregue.

**Por que sem login.** A página serve a quem NÃO tem conta — o órgão, a banca de
concurso, o fiscal de contrato, a empresa que recebeu o certificado e quer saber
se ele é autêntico. Quem tem conta aqui já abre `/certificados` ou
`/certificados/meus`, e é justamente quem não precisa dela. Exigir login não
tornaria a página mais segura: tornaria-a inútil, porque o único público que ela
tem ficaria de fora.

**O que ela custa hoje: nada de novo.** A rota é alcançável exatamente de onde
todas as outras já são — a rede do setor —, e publicar o sistema na internet
continua sendo decisão institucional a tomar com o TI, registrada como tal no
`docs/ROPA.md` §6. Esta rota não a toma nem a antecipa; ela garante que, no dia
em que for tomada, o endereço impresso responda.

**O que ela nunca mostra:** o nome de quem se formou. A regra e o argumento moram
em `servicos/validacao_certificado.py`, junto do limite por IP e da conferência
de nome que entra no lugar da exibição.

A tela sai pela mesma casca das telas anteriores à sessão (`sem_casca`), e não
por um segundo layout: `base.html` já tem o interruptor, com o argumento escrito
lá — um `base_publica.html` duplicaria `<head>`, rodapé e o salto para o conteúdo
para tirar uma `<aside>` que, sem `usuario`, já não é desenhada.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse

from app.dependencias import SessaoDep
from app.servicos import validacao_certificado as servico
from app.servicos.certificado import normalizar_chave
from app.web import pagina

rotas = APIRouter(tags=["validacao"])

VALIDAR = "/validar"

# A chave vai na URL porque é assim que o QR do papel a carrega. O `maxlength`
# do formulário e o corte aqui são o mesmo número: chave é de tamanho fixo, e um
# caminho de 4 KB só serviria para encher o registro de acesso.
TAMANHO_MAXIMO_CHAVE = 40


def _sem_rastro(resposta):
    """`noindex` e `no-store` na resposta pública.

    `no-store` porque a página responde sobre um documento de uma pessoa e não
    pode ficar no cache do navegador de um balcão compartilhado; `noindex`
    porque uma página de validação indexada convida exatamente a varredura que o
    limite por IP existe para conter. Vão aqui e não no middleware de segurança:
    lá o `setdefault` vale para toda resposta do sistema, e `no-store` em toda
    tela autenticada seria uma decisão de desempenho tomada de lado.
    """
    resposta.headers["x-robots-tag"] = "noindex, nofollow"
    resposta.headers["cache-control"] = "no-store"
    return resposta


def _tela(
    request: Request,
    *,
    resposta: servico.Resposta | None = None,
    digitada: str = "",
    confere: bool | None = None,
    nome_digitado: str = "",
    excedeu: bool = False,
    status: int = 200,
):
    saida = pagina(
        request,
        "paginas/validacao.html",
        usuario=None,
        resposta=resposta,
        digitada=digitada,
        confere=confere,
        nome_digitado=nome_digitado,
        excedeu=excedeu,
        hoje=date.today(),
        limite_curto=servico.LIMITE_CURTO,
    )
    saida.status_code = status
    return _sem_rastro(saida)


@rotas.get(VALIDAR)
def formulario(request: Request):
    """A tela sem chave: só o campo e a explicação do que ela responde."""
    return _tela(request)


@rotas.post(VALIDAR)
def enviar(request: Request, chave: str = Form("")):
    """O campo digitado vira URL.

    Redireciona em vez de responder no POST para que o endereço da resposta seja
    o MESMO que está impresso no papel — quem conferiu por digitação e quem leu o
    QR terminam na mesma URL, e ela pode ser copiada para um processo.
    """
    limpa = normalizar_chave(chave)[:TAMANHO_MAXIMO_CHAVE]
    if not limpa:
        return _sem_rastro(RedirectResponse(VALIDAR, status_code=303))
    return _sem_rastro(RedirectResponse(f"{VALIDAR}/{limpa}", status_code=303))


@rotas.get(VALIDAR + "/{chave}")
def validar(request: Request, s: SessaoDep, chave: str):
    """A resposta: autêntico ou não, e nunca de quem.

    O limite por IP é cobrado ANTES da consulta, e conta a tentativa mesmo quando
    a chave é válida: contar só o erro convidaria a varrer com chaves conhecidas.
    """
    ip = request.client.host if request.client else None
    if not servico.dentro_do_limite(ip):
        # 429, e a tela diz o que fazer. Um 403 aqui misturaria "você excedeu" com
        # "você não pode", que são coisas diferentes para quem só digitou errado.
        return _tela(request, digitada=chave, excedeu=True, status=429)
    resposta = servico.consultar(s, chave[:TAMANHO_MAXIMO_CHAVE])
    return _tela(request, resposta=resposta, digitada=normalizar_chave(chave))


@rotas.post(VALIDAR + "/{chave}/conferir")
def conferir(request: Request, s: SessaoDep, chave: str, nome: str = Form("")):
    """Confere / não confere — um bit, no lugar do nome.

    Passa pelo mesmo limite por IP da consulta, e é isso que torna inviável
    reconstruir um nome por tentativa: sem o limite, um bit por requisição ainda
    é um oráculo.
    """
    ip = request.client.host if request.client else None
    if not servico.dentro_do_limite(ip):
        return _tela(request, digitada=chave, excedeu=True, status=429)
    limpa = normalizar_chave(chave)[:TAMANHO_MAXIMO_CHAVE]
    resposta = servico.consultar(s, limpa)
    confere = servico.confere_o_nome(s, limpa, nome) if resposta.encontrado else None
    return _tela(
        request,
        resposta=resposta,
        digitada=limpa,
        confere=confere,
        # o que foi digitado volta para a tela: sem isso, "não confere" some junto
        # com o texto que o produziu e a pessoa não sabe se errou a digitação
        nome_digitado=(nome or "").strip(),
    )
