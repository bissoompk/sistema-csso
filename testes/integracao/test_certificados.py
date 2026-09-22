"""Fatia 4 de Certificados e Treinamentos: a emissão congelada.

O critério de pronto da fatia é uma frase: **o certificado sai, e a segunda via
sai idêntica**. É o que o teste-espelho da RN-15 verifica, e ele é o teste que
importa deste arquivo — os outros protegem as bordas.

Um teste-espelho que passa por acidente não vale nada: se as alterações
intermediárias não mudariam o documento nem sem congelamento, ele confirma o
óbvio. Por isso cada teste de congelamento aqui traz, junto, a **prova de que a
alteração morde**: monta o contexto a partir do catálogo de hoje e exige que o
texto renderizado seja DIFERENTE. Sem essa segunda asserção o primeiro `assert`
seria decoração.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modelos import (
    AssinaturaInstrutor,
    Certificado,
    CertificadoModelo,
    CertificadoModeloTag,
    Inscricao,
    Servidor,
    Treinamento,
    Usuario,
)
from app.servicos import certificado as servico_certificado
from app.servicos import documento
from app.servicos import emissao_certificado as servico
from app.servicos import participante as servico_participante
from app.servicos import presenca as servico_presenca
from app.servicos import turma as servico_turma
from app.servicos.autenticacao import gerar_hash
from app.servicos.rbac import PermissaoNegada, UsuarioAtual
from app.servicos.textos import normalizar_fluxo
from ferramentas.gerar_modelo_certificado import MAPA_SUGERIDO, OBRIGATORIOS
from testes.integracao.conftest import entrar

INICIO = date.today() - timedelta(days=2)
MODELO_ARQUIVO = "certificado_padrao_v1.docx"

TODAS = frozenset(
    {
        "treinamento.ver", "treinamento.gerenciar", "assinatura.gerenciar",
        "turma.criar", "turma.inscrever", "turma.concluir", "turma.avaliar",
        "certificado.emitir", "certificado.anular", "certificado.ver",
    }
)


# =====================================================================
# Montagem
# =====================================================================
def _usuario(sessao, permissoes=TODAS, login="operador") -> UsuarioAtual:
    """Um `UsuarioAtual` com linha real em `usuario`.

    A linha precisa existir porque `emitido_por`, `anulado_por` e a trilha de
    auditoria apontam para ela por chave estrangeira.
    """
    registro = Usuario(
        login=login,
        nome=f"Operador {login}",
        email=f"{login}@teste.ufvjm.edu.br",
        senha_hash=gerar_hash("SenhaDeTeste2026"),
        precisa_trocar_senha=False,
    )
    sessao.add(registro)
    sessao.flush()
    return UsuarioAtual(
        id=registro.id,
        login=login,
        nome=registro.nome,
        permissoes=frozenset(permissoes),
        perfis=("coordenador_csso",),
    )


def _modelo_com_tags(sessao, treinamento, *, nome="Padrão", versao=1) -> CertificadoModelo:
    modelo = CertificadoModelo(
        treinamento_id=treinamento.id,
        nome=nome,
        arquivo=MODELO_ARQUIVO,
        versao=versao,
        vigente=True,
    )
    sessao.add(modelo)
    sessao.flush()
    for ordem, (marcador, campo) in enumerate(MAPA_SUGERIDO.items(), start=1):
        sessao.add(
            CertificadoModeloTag(
                modelo_id=modelo.id,
                marcador=marcador,
                campo=campo,
                ordem=ordem,
                obrigatorio=marcador in OBRIGATORIOS,
            )
        )
    sessao.flush()
    return modelo


def _cenario(sessao, usuario, *, nota_minima=None, presente=True, horas="8", extras=()):
    """Catálogo, modelo, turma concluída e uma inscrita aprovada.

    `extras` são `(siape, nome, horas)` de mais participantes, inscritos ANTES
    do fecho — que é a única ordem possível: turma concluída não recebe
    inscrição, e é assim que tem de ser.
    """
    treinamento = Treinamento(
        codigo="NR-35",
        nome="Trabalho em Altura — NR-35",
        carga_horaria_horas=Decimal(8),
        conteudo_programatico=(
            "Normas e regulamentos aplicáveis\n"
            "Análise de risco e condições impeditivas\n"
            "Equipamentos de proteção individual para trabalho em altura"
        ),
        validade_meses=24,
        norma_referencia="NR-35",
    )
    sessao.add(treinamento)
    sessao.flush()

    modelo = _modelo_com_tags(sessao, treinamento)
    treinamento.modelo_vigente_id = modelo.id

    instrutor = AssinaturaInstrutor(
        nome="Fabrício Raimundi Andrade",
        titulo="Engenheiro de Segurança do Trabalho",
        conselho="CREA",
        registro_conselho="MG-123456",
        externo=True,
        vigencia_inicio=date(2020, 1, 1),
    )
    sessao.add(instrutor)

    servidor = Servidor(siape="1110654", nome="Marco Antônio Alves Schetino")
    sessao.add(servidor)
    sessao.flush()

    turma = servico_turma.criar_turma(
        sessao,
        usuario,
        treinamento=treinamento,
        data_inicio=INICIO,
        data_fim=INICIO,
        local="Auditório do Campus JK",
        nota_minima_aprovacao=nota_minima,
    )
    servico_turma.vincular_instrutor(sessao, usuario, turma, instrutor)
    pessoa = servico_participante.de_servidor(sessao, servidor, usuario)
    inscricao = servico_turma.inscrever(sessao, usuario, turma, pessoa)

    outras = []
    for siape, nome, horas_extra in extras:
        outro_servidor = Servidor(siape=siape, nome=nome)
        sessao.add(outro_servidor)
        sessao.flush()
        outra_pessoa = servico_participante.de_servidor(sessao, outro_servidor, usuario)
        outras.append(servico_turma.inscrever(sessao, usuario, turma, outra_pessoa))

    servico_turma.mudar_situacao(sessao, usuario, turma, "EM_ANDAMENTO")
    if presente:
        servico_presenca.lancar_presenca(
            sessao, usuario, inscricao, data=INICIO, presente=True, horas=Decimal(horas)
        )
    for outra, (_siape, _nome, horas_extra) in zip(outras, extras, strict=True):
        servico_presenca.lancar_presenca(
            sessao, usuario, outra, data=INICIO, presente=True, horas=Decimal(horas_extra)
        )
    if nota_minima is not None:
        servico_presenca.lancar_nota(sessao, usuario, inscricao, Decimal("9.5"))
    servico_turma.mudar_situacao(sessao, usuario, turma, "CONCLUIDA")
    sessao.flush()
    # `vincular_instrutor` grava a linha de `turma_instrutor` por `s.add`, e não
    # por `turma.instrutores.append`: a coleção já carregada não a enxerga. Na
    # aplicação isso não aparece, porque a rota comita e a requisição seguinte
    # relê; aqui, com uma sessão só do começo ao fim, é preciso expirar.
    sessao.expire_all()
    return {
        "treinamento": treinamento,
        "modelo": modelo,
        "instrutor": instrutor,
        "turma": turma,
        "inscricao": inscricao,
        "servidor": servidor,
        "outras": outras,
    }


@pytest.fixture()
def cenario_certificado(sessao):
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario)
    dados["usuario"] = usuario
    return dados


def _texto(caminho) -> str:
    return normalizar_fluxo(documento.extrair_texto(caminho))


def _texto_do_catalogo_de_hoje(sessao, cert: Certificado, inscricao, tmp_path) -> str:
    """Como o documento sairia SE não houvesse congelamento.

    Reconstrói o contexto a partir do catálogo de hoje, com o mesmo número, ano,
    data e chave — para que a única diferença possível seja o que mudou no
    catálogo — e renderiza. É esta função que impede o teste-espelho de passar
    por acidente.
    """
    modelo, _aviso = servico.modelo_da_turma(sessao, inscricao.turma)
    contexto = servico.montar_contexto_para_emitir(
        sessao,
        inscricao,
        numero=cert.numero,
        ano=cert.ano,
        data_emissao=cert.data_emissao,
        chave=cert.chave_validacao,
        modelo=modelo,
    )
    destino = tmp_path / "como_seria_hoje.docx"
    servico_certificado.renderizar(contexto, destino)
    return _texto(destino)


# =====================================================================
# O teste-espelho da RN-15
# =====================================================================
def test_segunda_via_sai_identica_com_o_catalogo_inteiro_trocado(
    sessao, cenario_certificado, tmp_path
):
    """Emitir, mudar TUDO embaixo, reimprimir: texto idêntico.

    O que muda entre a emissão e a segunda via: nome, carga horária, conteúdo
    programático, norma e validade do treinamento; o local da turma; o nome e o
    título do instrutor; o **mapa de tags**; e a versão do modelo. Cada uma
    dessas mudanças sozinha alteraria o documento — é o que a asserção final
    verifica —, e nenhuma pode alterar um papel que já circulou.
    """
    usuario = cenario_certificado["usuario"]
    inscricao = cenario_certificado["inscricao"]

    emitido = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False)
    cert = emitido.certificado
    antes = _texto(emitido.docx)
    assert cert.contexto_congelado, "a emissão tem de congelar o contexto"
    assert "Marco Antônio Alves Schetino" in antes
    assert "Trabalho em Altura" in antes
    assert cert.chave_validacao in antes

    # ---- agora o catálogo inteiro muda embaixo do certificado ----
    treinamento = cenario_certificado["treinamento"]
    treinamento.nome = "Brigada de Incêndio — OUTRO CURSO"
    treinamento.carga_horaria_horas = Decimal(40)
    treinamento.conteudo_programatico = "Conteúdo programático completamente trocado"
    treinamento.norma_referencia = "NR-23"
    treinamento.validade_meses = 60

    turma = cenario_certificado["turma"]
    turma.local = "Sala trocada depois da emissão"

    instrutor = cenario_certificado["instrutor"]
    instrutor.nome = "Outro Instrutor Qualquer"
    instrutor.titulo = "Título trocado"

    # a troca mais silenciosa de todas: o mapa de tags. Depois dela, o marcador
    # do nome do aluno passa a receber o nome do assinante e vice-versa.
    modelo = cenario_certificado["modelo"]
    por_marcador = {tag.marcador: tag for tag in modelo.tags}
    por_marcador["nome_do_aluno"].campo = "assinante_nome"
    por_marcador["assinante"].campo = "participante_nome"

    # e uma versão nova do modelo, publicada e apontada pelo catálogo
    modelo.vigente = False
    nova_versao = _modelo_com_tags(sessao, treinamento, versao=2)
    por_marcador_v2 = {tag.marcador: tag for tag in nova_versao.tags}
    por_marcador_v2["nome_do_aluno"].campo = "assinante_nome"
    por_marcador_v2["assinante"].campo = "participante_nome"
    treinamento.modelo_vigente_id = nova_versao.id

    sessao.flush()
    sessao.expire_all()

    # ---- reimprime ----
    cert = sessao.get(Certificado, cert.id)
    segunda = servico.segunda_via(sessao, usuario, cert)
    depois = _texto(segunda.docx)

    assert depois == antes, "a segunda via tem de sair idêntica à primeira"
    assert segunda.confere, "o hash da reimpressão tem de bater com o da emissão"
    assert segunda.hash_conteudo == cert.hash_conteudo
    assert "Brigada de Incêndio" not in depois
    assert "Outro Instrutor Qualquer" not in depois
    assert "Sala trocada" not in depois

    # ---- e a prova de que o teste não passou por acidente ----
    inscricao = sessao.get(Inscricao, inscricao.id)
    como_seria = _texto_do_catalogo_de_hoje(sessao, cert, inscricao, tmp_path)
    assert como_seria != antes, (
        "as alterações intermediárias não mudariam o documento nem sem "
        "congelamento — o teste-espelho estaria passando por acidente"
    )
    assert "Brigada de Incêndio" in como_seria


def test_o_mapa_de_tags_congelado_e_o_que_manda_na_reimpressao(
    sessao, cenario_certificado, tmp_path
):
    """Trocar só o mapa de tags, e mais nada, não pode mexer no papel.

    É a falha que o §4 do desenho chama de a mais silenciosa possível deste
    módulo: sem congelar QUAL CAMPO alimenta QUAL MARCADOR, a segunda via sairia
    com o nome do instrutor no campo do participante. Congelar os valores não
    basta — este teste é o que separa as duas coisas.
    """
    usuario = cenario_certificado["usuario"]
    inscricao = cenario_certificado["inscricao"]
    emitido = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False)
    cert = emitido.certificado
    antes = _texto(emitido.docx)

    modelo = cenario_certificado["modelo"]
    por_marcador = {tag.marcador: tag for tag in modelo.tags}
    por_marcador["nome_do_aluno"].campo = "assinante_nome"
    por_marcador["assinante"].campo = "participante_nome"
    sessao.flush()
    sessao.expire_all()

    cert = sessao.get(Certificado, cert.id)
    inscricao = sessao.get(Inscricao, inscricao.id)
    assert _texto(servico.segunda_via(sessao, usuario, cert).docx) == antes

    como_seria = _texto_do_catalogo_de_hoje(sessao, cert, inscricao, tmp_path)
    assert como_seria != antes, (
        "a troca do mapa de tags precisa mudar o documento quando o mapa NÃO "
        "está congelado, senão este teste não prova nada"
    )
    # e a troca é exatamente a catástrofe descrita no desenho: o nome do
    # instrutor onde deveria estar o do participante
    assert "Certificamos que Fabrício Raimundi Andrade" in como_seria
    assert "Certificamos que Marco Antônio Alves Schetino" in antes


def test_contexto_congelado_sobrevive_a_ida_e_volta_pelo_banco(
    sessao, cenario_certificado
):
    """`congelar` -> JSON -> `descongelar` devolve os mesmos tipos.

    Tipo importa tanto quanto valor: `Decimal('8.0')` e a string `'8.0'`
    formatam diferente, e a segunda via sairia com outra carga horária sem que
    nenhum dado tivesse mudado.
    """
    usuario = cenario_certificado["usuario"]
    emitido = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    )
    original = servico_certificado.ContextoCertificado.descongelar(
        emitido.certificado.contexto_congelado
    )
    sessao.commit()
    sessao.expire_all()

    cert = sessao.get(Certificado, emitido.certificado.id)
    voltou = servico.montar_contexto(sessao, cert)

    assert isinstance(voltou.carga_horaria, Decimal)
    assert isinstance(voltou.data_emissao, date)
    assert isinstance(voltou.mapa_tags, dict)
    assert voltou.congelar() == original.congelar()
    assert voltou.como_dicionario().keys() == original.como_dicionario().keys()
    # o mapa de tags está mesmo lá dentro, com todos os marcadores
    assert set(voltou.mapa_tags) == set(MAPA_SUGERIDO)
    assert voltou.tags_obrigatorias == tuple(sorted(OBRIGATORIOS))


# =====================================================================
# A chave de validação — nasce aqui, a página pública é a fatia 5
# =====================================================================
def test_chave_tem_formato_alfabeto_e_digito_verificador():
    chave = servico_certificado.gerar_chave(2026)
    prefixo, ano, bloco1, bloco2, digito = chave.split("-")
    assert prefixo == "CSSO"
    assert ano == "2026"
    assert len(bloco1) == len(bloco2) == 5
    assert len(digito) == 1
    assert servico_certificado.chave_valida(chave)

    # alfabeto sem os caracteres que se confundem no papel e ao telefone
    sorteados = bloco1 + bloco2 + digito
    assert not (set(sorteados) & set("01OILU"))


@pytest.mark.parametrize("posicao", [10, 12, 16, 20])
def test_um_caractere_trocado_e_recusado_pelo_digito_verificador(posicao):
    """O DV descarta 29 de cada 30 digitações erradas ANTES de tocar no banco."""
    chave = servico_certificado.montar_chave(2026, "K7QMX3FTB9")
    original = chave[posicao]
    trocado = next(c for c in servico_certificado._ALFABETO_CHAVE if c != original)
    errada = chave[:posicao] + trocado + chave[posicao + 1 :]
    assert servico_certificado.chave_valida(chave)
    assert not servico_certificado.chave_valida(errada)


def test_transposicao_de_dois_caracteres_e_recusada():
    """O peso pela posição existe para isto: trocar dois vizinhos de lugar é o
    erro típico de quem copia do papel, e sem peso o DV não o veria."""
    chave = servico_certificado.montar_chave(2026, "K7QMX3FTB9")
    trocada = servico_certificado.montar_chave(2026, "7KQMX3FTB9")
    assert chave[-1] != trocada[-1]


def test_normalizar_chave_nao_conserta_caractere_ambiguo():
    assert servico_certificado.normalizar_chave(" csso-2026-k7qmx-3ftb9-h ") == (
        "CSSO-2026-K7QMX-3FTB9-H"
    )
    # `O` não vira `0`: o alfabeto já exclui os dois, então um `O` digitado é
    # erro de digitação, e o DV é quem deve dizê-lo
    assert "O" in servico_certificado.normalizar_chave("csso-2026-KOQMX-3FTB9-H")


def test_a_chave_gravada_e_valida_e_unica(sessao, cenario_certificado):
    usuario = cenario_certificado["usuario"]
    cert = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    ).certificado
    assert servico_certificado.chave_valida(cert.chave_validacao)
    assert cert.chave_validacao.startswith(f"CSSO-{cert.ano}-")
    # e é a mesma chave que foi para o papel e para o congelado
    assert cert.contexto_congelado["chave_validacao"] == cert.chave_validacao


# =====================================================================
# Recusas
# =====================================================================
def test_reprovado_nao_recebe_certificado(sessao):
    """Frequência abaixo do mínimo reprova, e reprovado não tem certificado."""
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario, horas="4")  # 4h de 8h = 50%
    assert dados["inscricao"].situacao == "REPROVADO"

    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    assert "reprovado" in str(erro.value).lower()
    assert sessao.execute(select(Certificado)).first() is None


def test_turma_nao_concluida_nao_emite(sessao):
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario)
    turma = dados["turma"]
    # volta o cenário para antes do fecho, escrevendo direto: a máquina de
    # estados não admite reabrir turma concluída, e é justamente por isso que o
    # caso precisa ser montado à mão para ser testado
    turma.situacao = "EM_ANDAMENTO"
    dados["inscricao"].situacao = "PRESENTE"
    sessao.flush()

    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    assert "não foi concluída" in str(erro.value)


def test_turma_sem_instrutor_que_assina_nao_emite(sessao):
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario)
    for vinculo in dados["turma"].instrutores:
        vinculo.assina_certificado = False
    sessao.flush()
    sessao.expire_all()

    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    assert "instrutor marcado para assinar" in str(erro.value)


def test_marcador_sem_linha_no_dicionario_bloqueia_a_emissao(sessao):
    """Sem esta guarda o certificado sai com `{{ nome_do_aluno }}` no papel."""
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario)
    orfa = next(t for t in dados["modelo"].tags if t.marcador == "nome_do_aluno")
    sessao.delete(orfa)
    sessao.flush()
    sessao.expire_all()

    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    assert "marcador sem linha no dicionário" in str(erro.value)
    assert "nome_do_aluno" in str(erro.value)


def test_campo_fora_do_vocabulario_bloqueia_a_emissao(sessao):
    """O achado 6 da revisão da fatia 1: a clonagem de versão carregava adiante,
    em silêncio, um campo aposentado do vocabulário. Aqui ele para."""
    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario)
    tag = next(t for t in dados["modelo"].tags if t.marcador == "curso")
    tag.campo = "campo_que_nao_existe"
    sessao.flush()
    sessao.expire_all()

    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    assert "não existe no vocabulário" in str(erro.value)


def test_emitir_sem_permissao_e_negado(sessao, cenario_certificado):
    sem = _usuario(sessao, permissoes=TODAS - {"certificado.emitir"}, login="sem_emitir")
    with pytest.raises(PermissaoNegada):
        servico.emitir(sessao, sem, cenario_certificado["inscricao"], gerar_pdf=False)
    assert sessao.execute(select(Certificado)).first() is None


def test_segunda_via_sem_permissao_de_ver_e_negada(sessao, cenario_certificado):
    usuario = cenario_certificado["usuario"]
    cert = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    ).certificado
    sem = _usuario(sessao, permissoes=TODAS - {"certificado.ver"}, login="sem_ver")
    with pytest.raises(PermissaoNegada):
        servico.segunda_via(sessao, sem, cert)


def test_numero_nao_e_consumido_quando_a_emissao_e_recusada(sessao):
    """O número vem DEPOIS da validação, e é isso que este teste protege.

    Se a ordem se invertesse, cada tentativa recusada gastaria um número da
    sequência do ano e a numeração do certificado passaria a ter buracos que
    ninguém sabe explicar.
    """
    from sqlalchemy import text

    usuario = _usuario(sessao)
    dados = _cenario(sessao, usuario, horas="4")  # reprovado
    with pytest.raises(servico.EmissaoBloqueada):
        servico.emitir(sessao, usuario, dados["inscricao"], gerar_pdf=False)
    consumido = sessao.execute(
        text("SELECT ultimo_numero FROM certificado_sequencia WHERE ano = :a"),
        {"a": date.today().year},
    ).scalar()
    assert consumido in (None, 0)


# =====================================================================
# Anulação e reemissão
# =====================================================================
def test_anular_libera_a_reemissao_e_o_numero_nao_volta(sessao, cenario_certificado):
    """RN-14 aplicada ao certificado: anular não apaga, e reemitir dá número novo."""
    usuario = cenario_certificado["usuario"]
    inscricao = cenario_certificado["inscricao"]
    primeiro = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False).certificado
    numero_antigo = primeiro.numero
    chave_antiga = primeiro.chave_validacao

    # com o primeiro válido, a reemissão é recusada
    with pytest.raises(servico.EmissaoBloqueada) as erro:
        servico.emitir(sessao, usuario, inscricao, gerar_pdf=False)
    assert "já tem o certificado" in str(erro.value)

    servico.anular(sessao, usuario, primeiro, "nome social")
    segundo = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False).certificado

    assert primeiro.situacao == "ANULADO"
    assert primeiro.motivo_anulacao == "nome social"
    assert primeiro.anulado_em is not None
    # o documento não é apagado: continua consultável, com a chave que circulou
    assert primeiro.chave_validacao == chave_antiga
    # número consumido não volta para a sequência
    assert segundo.numero == numero_antigo + 1
    assert segundo.chave_validacao != chave_antiga
    assert segundo.situacao == "EMITIDO"


def test_anular_exige_motivo_e_nao_anula_duas_vezes(sessao, cenario_certificado):
    usuario = cenario_certificado["usuario"]
    cert = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    ).certificado
    with pytest.raises(ValueError, match="motivo"):
        servico.anular(sessao, usuario, cert, "   ")
    assert cert.situacao == "EMITIDO"

    servico.anular(sessao, usuario, cert, "erro de digitação no nome")
    with pytest.raises(ValueError, match="já está anulado"):
        servico.anular(sessao, usuario, cert, "de novo")


def test_anular_sem_permissao_e_negado(sessao, cenario_certificado):
    usuario = cenario_certificado["usuario"]
    cert = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    ).certificado
    tecnico = _usuario(
        sessao, permissoes=TODAS - {"certificado.anular"}, login="tecnico"
    )
    with pytest.raises(PermissaoNegada):
        servico.anular(sessao, tecnico, cert, "motivo qualquer")
    assert cert.situacao == "EMITIDO"


def test_segunda_via_de_certificado_anulado_continua_saindo(
    sessao, cenario_certificado
):
    """Quem precisa juntar ao processo o papel anulado precisa do papel.

    O que a anulação muda é a resposta da página pública (fatia 5), não a
    existência do documento.
    """
    usuario = cenario_certificado["usuario"]
    emitido = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    )
    antes = _texto(emitido.docx)
    servico.anular(sessao, usuario, emitido.certificado, "reemissão por nome social")
    sessao.flush()

    segunda = servico.segunda_via(sessao, usuario, emitido.certificado)
    assert _texto(segunda.docx) == antes
    assert segunda.confere
    assert emitido.certificado.situacao_publica(date.today()) == "ANULADO"


# =====================================================================
# Lote
# =====================================================================
def test_lote_emite_todos_e_um_item_que_trava_nao_derruba_os_outros(sessao):
    """O relatório do lote diz o que saiu e o que travou, com o motivo.

    A montagem é: quatro inscritos, um reprovado (nem entra), um que já tem
    certificado (nem entra), um que trava no meio do laço e um que sai. O que
    importa é que o item travado fique **entre** os outros: se o lote fosse uma
    transação só, ele derrubaria o que veio antes.
    """
    usuario = _usuario(sessao)
    dados = _cenario(
        sessao,
        usuario,
        extras=[
            ("2220001", "Ana Lima", "8"),
            ("3330002", "Bruno Sá", "8"),
            ("4440003", "Carla Dias", "2"),  # 25% de frequência: reprovada
        ],
    )
    turma = dados["turma"]
    ana, bruno, carla = dados["outras"]
    assert carla.situacao == "REPROVADO"

    # a Ana já tem certificado antes de o lote rodar
    ja = servico.emitir(sessao, usuario, ana, gerar_pdf=False).certificado
    sessao.commit()

    # e o Bruno trava por um motivo de verdade: a folha dele sumiu, mas a coluna
    # derivada continua dizendo 100%. A emissão recalcula a frequência a partir
    # dos lançamentos em vez de acreditar na coluna, e é isso que a pega — o
    # papel não pode afirmar uma frequência que a folha não sustenta.
    bruno.presencas.clear()
    sessao.flush()
    assert bruno.frequencia_percentual == Decimal("100.00")  # a coluna, obsoleta
    sessao.commit()

    relatorio = servico.emitir_lote(sessao, usuario, turma, gerar_pdf=False)
    por_id = {i.inscricao.id: i for i in relatorio.itens}

    # quem já tinha certificado e quem está reprovado nem entram no relatório:
    # repetir "já tem" trinta vezes esconderia o que de fato travou
    assert ja.inscricao_id not in por_id
    assert carla.id not in por_id
    assert por_id[bruno.id].erro and not por_id[bruno.id].ok
    assert por_id[dados["inscricao"].id].ok
    assert len(relatorio.emitidos) == 1
    assert len(relatorio.travados) == 1
    assert relatorio.resumo == "1 emitido(s), 1 travado(s)"

    # o que saiu ficou gravado, apesar da falha do vizinho — e o rollback do
    # item travado não levou junto o número já consumido pelos que passaram
    emitidos = list(sessao.execute(select(Certificado)).scalars())
    assert len(emitidos) == 2
    assert {c.numero for c in emitidos} == {1, 2}


def test_lote_sem_permissao_e_negado_antes_do_laco(sessao, cenario_certificado):
    """Numa turma sem ninguém apto o laço nunca rodaria, e a pessoa receberia
    'nenhum certificado emitido' em vez de 'permissão negada'."""
    sem = _usuario(sessao, permissoes=frozenset({"treinamento.ver"}), login="so_le")
    with pytest.raises(PermissaoNegada):
        servico.emitir_lote(sessao, sem, cenario_certificado["turma"], gerar_pdf=False)


# =====================================================================
# A guarda que a fatia 3 deixou marcada
# =====================================================================
def test_retificar_resultado_de_quem_tem_certificado_e_recusado(
    sessao, cenario_certificado
):
    """§11, item 12: documento que circulou se anula e se reemite.

    Sem esta guarda, corrigir a presença por trás do certificado deixaria o
    papel afirmando um resultado que o sistema não afirma mais — e, no limite,
    um REPROVADO convivendo com um certificado válido.
    """
    usuario = cenario_certificado["usuario"]
    inscricao = cenario_certificado["inscricao"]
    cert = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False).certificado

    with pytest.raises(servico_turma.RegraDaTurma) as erro:
        servico_presenca.lancar_presenca(
            sessao,
            usuario,
            inscricao,
            data=INICIO,
            presente=True,
            horas=Decimal(4),
            motivo="corrigindo a folha",
        )
    assert cert.rotulo in str(erro.value)
    assert "não se reescreve" in str(erro.value)

    with pytest.raises(servico_turma.RegraDaTurma):
        servico_presenca.lancar_nota(
            sessao, usuario, inscricao, Decimal(3), motivo="corrigindo a nota"
        )

    # nada mudou: nem a frequência, nem a nota, nem o resultado
    sessao.expire_all()
    inscricao = sessao.get(Inscricao, inscricao.id)
    assert inscricao.situacao == "APROVADO"
    assert inscricao.frequencia_percentual == Decimal("100.00")
    assert inscricao.nota_final is None


def test_anulado_o_certificado_a_retificacao_volta_a_ser_possivel(
    sessao, cenario_certificado
):
    """A guarda é sobre certificado VÁLIDO. Anulado, o caminho normal reabre —
    é assim que a correção acontece: anula, corrige, reemite."""
    usuario = cenario_certificado["usuario"]
    inscricao = cenario_certificado["inscricao"]
    cert = servico.emitir(sessao, usuario, inscricao, gerar_pdf=False).certificado
    servico.anular(sessao, usuario, cert, "presença lançada errado")
    sessao.flush()

    servico_presenca.lancar_presenca(
        sessao,
        usuario,
        inscricao,
        data=INICIO,
        presente=True,
        horas=Decimal(4),
        motivo="folha refeita depois da anulação",
    )
    assert inscricao.frequencia_percentual == Decimal("50.00")
    assert inscricao.situacao == "REPROVADO"


# =====================================================================
# Trilha de auditoria
# =====================================================================
def test_a_emissao_entra_na_trilha_sem_quebrar_a_cadeia(sessao, cenario_certificado):
    """A cadeia de hashes tem de continuar íntegra depois de emitir e anular.

    `valor_novo` da emissão leva número, ano e hash — nenhum `Decimal` disfarçado
    de texto, que é o que quebra o digest quando volta do banco como `float`.
    """
    from app.modelos import HistoricoEvento
    from app.servicos import auditoria

    usuario = cenario_certificado["usuario"]
    cert = servico.emitir(
        sessao, usuario, cenario_certificado["inscricao"], gerar_pdf=False
    ).certificado
    servico.segunda_via(sessao, usuario, cert)
    servico.anular(sessao, usuario, cert, "teste da trilha")
    sessao.commit()

    tipos = [
        e.tipo_evento
        for e in sessao.execute(
            select(HistoricoEvento).where(
                HistoricoEvento.entidade == "certificado",
                HistoricoEvento.entidade_id == cert.id,
            )
        ).scalars()
    ]
    assert servico.CERTIFICADO_EMITIDO in tipos
    assert servico.CERTIFICADO_SEGUNDA_VIA in tipos
    assert servico.CERTIFICADO_ANULADO in tipos

    ok, defeito = auditoria.cadeia_integra(sessao)
    assert ok, f"cadeia de auditoria quebrada no evento {defeito}"


# =====================================================================
# Pela porta da frente
# =====================================================================
def _sessao():
    from app import banco as mod_banco

    return mod_banco.sessao()


@pytest.fixture()
def cenario_http(app_cliente, contas, banco):
    """O mesmo cenário, gravado e comitado, para os testes que passam por HTTP."""
    with _sessao() as s:
        montador = _usuario(s, login="montador")
        dados = _cenario(s, montador, extras=[("2220001", "Ana Lima", "8")])
        ids = {
            "turma_id": dados["turma"].id,
            "inscricao_id": dados["inscricao"].id,
            "outra_id": dados["outras"][0].id,
        }
    return {"cliente": app_cliente, **ids}


def _certificados_gravados() -> list[dict]:
    with _sessao() as s:
        return [
            {
                "id": c.id,
                "rotulo": c.rotulo,
                "situacao": c.situacao,
                "chave": c.chave_validacao,
            }
            for c in s.execute(select(Certificado).order_by(Certificado.id)).scalars()
        ]


def test_emitir_pela_aba_de_emissao_e_ver_a_ficha(cenario_http, contas):
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    turma_id = cenario_http["turma_id"]

    aba = cliente.get(f"/turmas/{turma_id}?aba=emissao")
    assert aba.status_code == 200
    assert "Emissão dos certificados" in aba.text
    assert "apto" in aba.text

    resposta = cliente.post(
        f"/turmas/{turma_id}/certificados",
        data={"inscricao_id": str(cenario_http["inscricao_id"])},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "emitido" in cliente.get(resposta.headers["location"]).text

    gravados = _certificados_gravados()
    assert len(gravados) == 1
    ficha = cliente.get(f"/certificados/{gravados[0]['id']}")
    assert ficha.status_code == 200
    assert "Marco Antônio Alves Schetino" in ficha.text
    assert gravados[0]["chave"] in ficha.text
    # a ficha mostra o dicionário congelado, que é o que responde "por que o
    # certificado diz isto?" depois que o catálogo mudou
    assert "dicionário de tags congelado" in ficha.text.lower()
    assert "nome_do_aluno" in ficha.text


def test_emissao_em_lote_pela_tela(cenario_http, contas):
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    resposta = cliente.post(
        f"/turmas/{cenario_http['turma_id']}/certificados",
        data={},
        follow_redirects=False,
    )
    assert resposta.status_code == 303
    assert "2 emitido(s), 0 travado(s)" in cliente.get(resposta.headers["location"]).text
    assert len(_certificados_gravados()) == 2


def test_a_emissao_em_lote_diz_quantos_numeros_vai_consumir(cenario_http, contas):
    """"Emitir em lote" era um clique que consumia N números sem dizer quantos.

    O único número na tela era o contador "0 emitido(s)", que conta o oposto. Um
    número de certificado não volta — anular não o libera, e a reemissão recebe
    outro —, então a contagem tem de estar no rótulo ANTES do clique, e a
    confirmação tem de dizer de quem são os certificados que vão sair.
    """
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    aba = cliente.get(f"/turmas/{cenario_http['turma_id']}?aba=emissao").text

    assert "Emitir 2 certificado(s)…" in aba, "o rótulo não diz quantos"
    assert 'href="#emitir-lote"' in aba, "o botão de destaque ainda executa a ação"
    assert 'id="emitir-lote"' in aba
    assert "consome 2 número(s) da sequência do ano" in aba
    assert "número consumido não volta" in aba
    # de quem são os certificados, nominalmente: é o que permite conferir a
    # lista antes de gastar a numeração
    assert "Marco Antônio Alves Schetino" in aba
    assert "Ana Lima" in aba


def test_emitido_o_lote_a_confirmacao_some(cenario_http, contas):
    """Sem ninguém apto, o convite a consumir número não pode continuar na tela."""
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    cliente.post(
        f"/turmas/{cenario_http['turma_id']}/certificados", data={}, follow_redirects=False
    )
    aba = cliente.get(f"/turmas/{cenario_http['turma_id']}?aba=emissao").text
    assert 'id="emitir-lote"' not in aba
    assert "Ninguém apto a emitir nesta turma agora" in aba


def test_lista_e_busca_por_chave(cenario_http, contas):
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    cliente.post(
        f"/turmas/{cenario_http['turma_id']}/certificados",
        data={"inscricao_id": str(cenario_http["inscricao_id"])},
        follow_redirects=False,
    )
    gravado = _certificados_gravados()[0]

    lista = cliente.get("/certificados")
    assert lista.status_code == 200
    assert gravado["rotulo"] in lista.text

    # a busca é pela CHAVE, que é o que o suporte tem quando alguém liga com o
    # papel na mão — e em caixa baixa, porque é assim que se digita
    achou = cliente.get(f"/certificados?busca={gravado['chave'].lower()}")
    assert "Marco Antônio" in achou.text
    vazio = cliente.get("/certificados?busca=CSSO-2026-AAAAA-AAAAA-A")
    assert "Nenhum certificado nesta seleção" in vazio.text


def test_segunda_via_pela_rota_sai_em_docx(cenario_http, contas):
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    cliente.post(
        f"/turmas/{cenario_http['turma_id']}/certificados",
        data={"inscricao_id": str(cenario_http["inscricao_id"])},
        follow_redirects=False,
    )
    gravado = _certificados_gravados()[0]
    resposta = cliente.get(f"/certificados/{gravado['id']}/documento")
    assert resposta.status_code == 200
    assert resposta.headers["content-type"].startswith(
        "application/vnd.openxmlformats"
    )
    assert resposta.content[:2] == b"PK"  # .docx é um zip


def test_anular_pela_tela_exige_motivo_e_nao_grava_a_recusa(cenario_http, contas):
    """Recusa é retorno normal, e retorno normal comita: sem o rollback da rota,
    a anulação sem motivo deixaria rastro."""
    cliente = cenario_http["cliente"]
    entrar(cliente, contas, "coordenador_csso")
    cliente.post(
        f"/turmas/{cenario_http['turma_id']}/certificados",
        data={"inscricao_id": str(cenario_http["inscricao_id"])},
        follow_redirects=False,
    )
    gravado = _certificados_gravados()[0]

    recusa = cliente.post(
        f"/certificados/{gravado['id']}/anular", data={"motivo": "   "},
        follow_redirects=False,
    )
    assert recusa.status_code == 303
    assert "motivo" in cliente.get(recusa.headers["location"]).text
    assert _certificados_gravados()[0]["situacao"] == "EMITIDO"

    ok = cliente.post(
        f"/certificados/{gravado['id']}/anular",
        data={"motivo": "nome social"},
        follow_redirects=False,
    )
    assert ok.status_code == 303
    assert _certificados_gravados()[0]["situacao"] == "ANULADO"
    ficha = cliente.get(f"/certificados/{gravado['id']}")
    assert "Anulado" in ficha.text
    assert "nome social" in ficha.text


@pytest.mark.parametrize(
    "perfil,pode_ver,pode_emitir,pode_anular",
    [
        ("coordenador_csso", True, True, True),
        ("engenheiro_seguranca", True, True, True),
        ("tecnico_seguranca", True, True, False),
        ("secretaria_csso", True, True, False),
        ("consulta_progep", True, False, False),
        ("auditor_interno", True, False, False),
        ("servidor_consulta", False, False, False),
        ("admin_ti", False, False, False),
    ],
)
def test_permissao_por_perfil_em_cada_rota(
    cenario_http, contas, perfil, pode_ver, pode_emitir, pode_anular
):
    """A tabela do §8, conferida rota a rota.

    O técnico de segurança emite e **não** anula: consumir número é operação
    técnica, desfazer documento que circulou é decisão de coordenação — a mesma
    simetria do parecer, em que ele emite e não assina.

    O `servidor_consulta` desta tabela é a conta **sem** cadastro de servidor: o
    certificado do cenário é de outra pessoa, e ele leva 403 nas três rotas como
    sempre levou. O caso do TITULAR — a mesma conta amarrada ao `Servidor` do
    certificado — mora em `test_servidor_titular.py`, e lá ele abre as duas
    primeiras com `treinamento.ver` e continua sem a lista do setor. As duas
    tabelas dizem coisas diferentes e as duas valem: `certificado.ver` continua
    sendo a permissão de ler o certificado de OUTRO.
    """
    cliente = cenario_http["cliente"]
    turma_id, inscricao_id = cenario_http["turma_id"], cenario_http["inscricao_id"]

    entrar(cliente, contas, "coordenador_csso")
    cliente.post(
        f"/turmas/{turma_id}/certificados",
        data={"inscricao_id": str(inscricao_id)},
        follow_redirects=False,
    )
    gravado = _certificados_gravados()[0]

    entrar(cliente, contas, perfil)
    esperado = 200 if pode_ver else 403
    assert cliente.get("/certificados").status_code == esperado, "/certificados"
    assert cliente.get(f"/certificados/{gravado['id']}").status_code == esperado
    assert (
        cliente.get(f"/certificados/{gravado['id']}/documento").status_code == esperado
    )

    emissao = cliente.post(
        f"/turmas/{turma_id}/certificados",
        data={"inscricao_id": str(cenario_http["outra_id"])},
        follow_redirects=False,
    )
    assert emissao.status_code == (303 if pode_emitir else 403)

    anulacao = cliente.post(
        f"/certificados/{gravado['id']}/anular",
        data={"motivo": "teste de permissão"},
        follow_redirects=False,
    )
    assert anulacao.status_code == (303 if pode_anular else 403)
    if not pode_anular:
        assert _certificados_gravados()[0]["situacao"] == "EMITIDO"


def test_rotas_de_certificado_exigem_sessao(app_cliente):
    for caminho in ("/certificados", "/certificados/1", "/certificados/1/documento"):
        resposta = app_cliente.get(caminho, follow_redirects=False)
        assert resposta.status_code == 303
        assert "/login" in resposta.headers["location"]
