"""Converte o .docx de mala direta do parecer em um modelo docxtpl.

Uso:
    python -m ferramentas.converter_modelo_maladireta ORIGINAL.docx SAIDA_v1.docx [--v2 SAIDA_v2.docx]

O que faz:
  * varre document.xml e TODOS os headers/footers;
  * trata as duas formas de campo do Word:
      - <w:fldSimple w:instr=" MERGEFIELD X ">
      - a sequencia fldChar begin -> instrText -> separate -> resultado -> end
    (inclusive quando o resultado atravessa varios paragrafos, como a
    Fundamentacao Legal);
  * substitui cada campo por UM unico run com {{ chave }}, herdando o rPr do run
    interno - e isso que elimina o run splitting que quebra o docxtpl;
  * converte em campo as 4 linhas do cabecalho que dependem do setor emissor;
  * envolve o paragrafo da Reavaliacao em {%p if reavaliacao %} ... {%p endif %};
  * preserva os asteriscos de nota (texto estatico do modelo).

O modelo v1 e congelado como esta, com o defeito de rotulo incluido
("No do Laudo Tecnico:" acima do numero do PARECER). O v2 corrige o rotulo.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from docx import Document
from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# MERGEFIELD -> chave Jinja (snake_case ASCII)
MAPA_CAMPOS: dict[str, str] = {
    "Nº_do_Parecer": "numero_parecer",
    "Ano": "ano",
    "DATA": "data_extenso",
    "Laudo_de_": "laudo_de",
    "Unidade": "unidade",
    "Posto_de_Trabalho": "posto_trabalho",
    "UORG": "uorg_formatado",
    "Tipo_de_Laudo": "tipo_laudo",
    "Nº_do_Processo": "numero_processo_sei",
    "Nome_do_Servidor": "nome_servidor",
    "Matricula": "matricula",
    "Cargo": "cargo",
    "Função": "funcao",
    "Laudo_SIAPE": "laudo_siape",
    "Agente_nocivo_à_saúde": "agente_nocivo",
    "Tipo_de_Risco": "tipo_risco",
    "Percentual_Aplicável": "percentual_aplicavel",
    "Portaria_de_Localização": "portaria_localizacao",
    "Fundamentação_Legal": "fundamentacao_legal",
    "Alteração": "alteracao",
    "Recomendação_Técnica": "recomendacao_tecnica",
    "Reavaliação": "reavaliacao",
    "Pró_Reitor": "pro_reitor",
    # artefato da mala direta que sobrou no rodape; sempre renderizado vazio
    "Data_da_Solicitação_no_SEST": "data_solicitacao_sest_rodape",
}

# Chaves que carregam quebra de linha -> RichText com \a e {{r chave }}
CHAVES_RICHTEXT: frozenset[str] = frozenset(
    {
        "posto_trabalho",
        "agente_nocivo",
        "fundamentacao_legal",
        "alteracao",
        "recomendacao_tecnica",
        "reavaliacao",
    }
)

# Linhas do cabecalho que passam a vir de setor_emissor (congelado na emissao)
LINHAS_CABECALHO: tuple[tuple[str, str], ...] = (
    ("Seção de", "nome_extenso_emissor"),
    ("Rodovia MGT", "endereco_emissor"),
    ("Fone:", "telefone_emissor"),
)

# Paragrafos que o modelo original trazia fixos mas que sao DADO no sistema:
# tratamento e cargo vem de autoridade_destinataria; a assinatura vem de
# profissional_habilitado (sem isso um segundo subscritor habilitado nao
# conseguiria assinar). Chave = texto exato do paragrafo no corpo.
PARAGRAFOS_ESTATICOS: dict[str, str] = {
    "A sua senhoria, a senhora:": "{{ tratamento_destinatario }}",
    "Pró-reitora de Gestão de Pessoas": "{{ pro_reitor_cargo }}",
    "Fabrício Raimundi Andrade": "{{ assinante_nome }}",
    "Mat. SIAPE 2165804": "Mat. SIAPE {{ assinante_matricula }}",
    "Eng. Seg. do Trabalho": "{{ assinante_titulo }}",
}

ROTULO_V1 = "Laudo"  # defeito preservado: "Nº do Laudo Técnico:" sobre o nº do parecer
ROTULO_V2 = "Parecer"

_RE_MERGEFIELD = re.compile(r"MERGEFIELD\s+\"?([^\s\\\"]+)\"?")


class CampoDesconhecido(ValueError):
    pass


# ---------------------------------------------------------------------
# utilitarios de XML
# ---------------------------------------------------------------------
def _novo_run(modelo_rpr, texto: str):
    run = etree.SubElement(etree.Element(W + "tmp"), W + "r")
    if modelo_rpr is not None:
        run.append(_copia(modelo_rpr))
    t = etree.SubElement(run, W + "t")
    t.text = texto
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return run


def _copia(el):
    return etree.fromstring(etree.tostring(el))


def _rpr_de(run):
    return run.find(W + "rPr")


def _placeholder(chave: str) -> str:
    return "{{r %s }}" % chave if chave in CHAVES_RICHTEXT else "{{ %s }}" % chave


def _nome_campo(instrucao: str) -> str | None:
    m = _RE_MERGEFIELD.search(instrucao)
    return m.group(1) if m else None


def _chave(nome: str) -> str:
    if nome not in MAPA_CAMPOS:
        raise CampoDesconhecido(
            f"MERGEFIELD '{nome}' nao esta no mapa. Acrescente em MAPA_CAMPOS "
            "antes de converter - nunca chute a chave."
        )
    return MAPA_CAMPOS[nome]


def contar_asteriscos(root) -> int:
    """So o texto visivel (w:t). Os '\\*' das instrucoes nao contam."""
    return sum((t.text or "").count("*") for t in root.iter(W + "t"))


# ---------------------------------------------------------------------
# conversao de campos
# ---------------------------------------------------------------------
def _converter_fldsimple(root) -> int:
    convertidos = 0
    for fld in list(root.iter(W + "fldSimple")):
        nome = _nome_campo(fld.get(W + "instr") or "")
        if not nome:
            continue
        interno = fld.find(W + "r")
        run = _novo_run(_rpr_de(interno) if interno is not None else None, _placeholder(_chave(nome)))
        pai = fld.getparent()
        pai.replace(fld, run)
        convertidos += 1
    return convertidos


def _converter_fldchar(root) -> int:
    """Percorre os runs em ordem de documento resolvendo os campos complexos."""
    convertidos = 0
    while True:
        runs = list(root.iter(W + "r"))
        inicio = None
        for i, run in enumerate(runs):
            fld = run.find(W + "fldChar")
            if fld is not None and fld.get(W + "fldCharType") == "begin":
                inicio = i
                break
        if inicio is None:
            return convertidos

        profundidade = 0
        fim = None
        instrucao: list[str] = []
        idx_separate = None
        for j in range(inicio, len(runs)):
            fld = runs[j].find(W + "fldChar")
            tipo = fld.get(W + "fldCharType") if fld is not None else None
            if tipo == "begin":
                profundidade += 1
            elif tipo == "separate" and profundidade == 1:
                idx_separate = j
            elif tipo == "end":
                profundidade -= 1
                if profundidade == 0:
                    fim = j
                    break
            for it in runs[j].iter(W + "instrText"):
                instrucao.append(it.text or "")
        if fim is None:
            raise ValueError("campo sem fldChar end - .docx corrompido")

        nome = _nome_campo("".join(instrucao))
        alvo = runs[inicio : fim + 1]
        if not nome:
            # campo que nao e MERGEFIELD (PAGE, DATE...): deixa como esta
            for run in alvo:
                for fld in run.findall(W + "fldChar"):
                    fld.set(W + "fldCharType", "ignorado")
            continue

        modelo_rpr = None
        if idx_separate is not None and idx_separate + 1 <= fim - 1:
            modelo_rpr = _rpr_de(runs[idx_separate + 1])
        if modelo_rpr is None:
            modelo_rpr = _rpr_de(runs[inicio])

        novo = _novo_run(modelo_rpr, _placeholder(_chave(nome)))
        p_inicio = runs[inicio].getparent()
        p_fim = runs[fim].getparent()
        p_inicio.insert(list(p_inicio).index(runs[inicio]), novo)

        for run in alvo:
            run.getparent().remove(run)

        if p_fim is not p_inicio:
            # resultado atravessou paragrafos: traz o que sobrou do ultimo
            # paragrafo (ex.: o '*' apos a Fundamentacao Legal) e remove os
            # paragrafos intermediarios agora vazios.
            corpo = p_inicio.getparent()
            filhos = list(corpo)
            i_ini, i_fim = filhos.index(p_inicio), filhos.index(p_fim)
            for restante in list(p_fim):
                if restante.tag == W + "pPr":
                    continue
                p_fim.remove(restante)
                p_inicio.append(restante)
            for intermediario in filhos[i_ini + 1 : i_fim + 1]:
                corpo.remove(intermediario)

        convertidos += 1


def _converter_cabecalho(root) -> int:
    """Substitui as linhas do cabecalho que dependem do setor emissor."""
    trocas = 0
    for paragrafo in root.iter(W + "p"):
        texto = "".join(t.text or "" for t in paragrafo.iter(W + "t"))
        for prefixo, chave in LINHAS_CABECALHO:
            if texto.strip().startswith(prefixo):
                runs = paragrafo.findall(W + "r")
                if not runs:
                    continue
                novo = _novo_run(_rpr_de(runs[0]), _placeholder(chave))
                paragrafo.insert(list(paragrafo).index(runs[0]), novo)
                for run in runs:
                    paragrafo.remove(run)
                trocas += 1
                break
    return trocas


def _converter_paragrafos_estaticos(root) -> int:
    trocas = 0
    for paragrafo in root.iter(W + "p"):
        texto = "".join(t.text or "" for t in paragrafo.iter(W + "t")).strip()
        destino = PARAGRAFOS_ESTATICOS.get(texto)
        if destino is None:
            continue
        runs = paragrafo.findall(W + "r")
        if not runs:
            continue
        novo = _novo_run(_rpr_de(runs[0]), destino)
        paragrafo.insert(list(paragrafo).index(runs[0]), novo)
        for run in runs:
            paragrafo.remove(run)
        trocas += 1
    return trocas


def _converter_linha_titulo(root) -> int:
    """'... – SEST/DASA/PROGEP    Diamantina, ' vira campo."""
    trocas = 0
    for paragrafo in root.iter(W + "p"):
        runs = paragrafo.findall(W + "r")
        for run in runs:
            for t in run.iter(W + "t"):
                bruto = t.text or ""
                if "SEST/DASA/" in bruto:
                    t.text = bruto.replace(
                        "SEST/DASA/", "{{ sigla_unidade_emissora }}"
                    )
                    # o 'PROGEP' do run seguinte faz parte da sigla antiga
                    idx = list(paragrafo).index(run)
                    for seguinte in list(paragrafo)[idx + 1 :]:
                        if seguinte.tag != W + "r":
                            continue
                        alvo = seguinte.find(W + "t")
                        if alvo is not None and (alvo.text or "").strip() == "PROGEP":
                            paragrafo.remove(seguinte)
                        break
                    trocas += 1
                elif re.fullmatch(r"\s*Diamantina,\s*", bruto):
                    t.text = bruto.replace("Diamantina,", "{{ cidade }},")
                    trocas += 1
    return trocas


def _envolver_reavaliacao(root) -> bool:
    """{%p if reavaliacao %} ... {%p endif %} em volta do paragrafo do campo."""
    for paragrafo in root.iter(W + "p"):
        texto = "".join(t.text or "" for t in paragrafo.iter(W + "t"))
        if "{{r reavaliacao }}" not in texto:
            continue
        corpo = paragrafo.getparent()
        indice = list(corpo).index(paragrafo)
        abre = _paragrafo_tag(paragrafo, "{%p if reavaliacao %}")
        fecha = _paragrafo_tag(paragrafo, "{%p endif %}")
        corpo.insert(indice, abre)
        corpo.insert(indice + 2, fecha)
        return True
    return False


def _paragrafo_tag(modelo, texto: str):
    p = etree.SubElement(etree.Element(W + "tmp"), W + "p")
    ppr = modelo.find(W + "pPr")
    if ppr is not None:
        p.append(_copia(ppr))
    p.append(_novo_run(None, texto))
    return p


def _trocar_rotulo_laudo(root, novo: str) -> bool:
    """v2: 'Nº do Laudo Técnico:' -> 'Nº do Parecer Técnico:' (so o rotulo que
    fica acima do numero do parecer)."""
    for paragrafo in root.iter(W + "p"):
        textos = list(paragrafo.iter(W + "t"))
        junto = "".join(t.text or "" for t in textos)
        if junto.replace(" ", "").startswith("NºdoLaudoTécnico"):
            for t in textos:
                if t.text and "Laudo" in t.text:
                    t.text = t.text.replace("Laudo", novo)
                    return True
    return False


# ---------------------------------------------------------------------
# orquestracao
# ---------------------------------------------------------------------
def _remover_mala_direta(doc) -> bool:
    """Tira o vinculo com a fonte de dados: o modelo deixa de ser mala direta."""
    settings = doc.settings.element
    alvo = settings.find(W + "mailMerge")
    if alvo is None:
        return False
    settings.remove(alvo)
    return True


def _partes(doc):
    yield doc.element.body
    for secao in doc.sections:
        for parte in (
            secao.header,
            secao.footer,
            secao.first_page_header,
            secao.first_page_footer,
            secao.even_page_header,
            secao.even_page_footer,
        ):
            if parte is not None:
                yield parte._element


def converter(origem: Path, destino: Path, versao: str = "v1") -> dict[str, int]:
    doc = Document(str(origem))
    relatorio = {
        "fldSimple": 0,
        "fldChar": 0,
        "cabecalho": 0,
        "titulo": 0,
        "estaticos": 0,
    }

    asteriscos_antes = sum(contar_asteriscos(p) for p in _partes(doc))

    for parte in _partes(doc):
        relatorio["fldSimple"] += _converter_fldsimple(parte)
        relatorio["fldChar"] += _converter_fldchar(parte)
        relatorio["cabecalho"] += _converter_cabecalho(parte)
        relatorio["titulo"] += _converter_linha_titulo(parte)

    relatorio["estaticos"] = _converter_paragrafos_estaticos(doc.element.body)

    _envolver_reavaliacao(doc.element.body)
    _remover_mala_direta(doc)
    if versao == "v2":
        _trocar_rotulo_laudo(doc.element.body, ROTULO_V2)

    asteriscos_depois = sum(contar_asteriscos(p) for p in _partes(doc))
    relatorio["asteriscos_antes"] = asteriscos_antes
    relatorio["asteriscos_depois"] = asteriscos_depois

    destino.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(destino))
    return relatorio


def principal(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origem", type=Path)
    parser.add_argument("destino_v1", type=Path)
    parser.add_argument("--v2", type=Path, default=None)
    args = parser.parse_args(argv)

    rel = converter(args.origem, args.destino_v1, "v1")
    print(f"v1 -> {args.destino_v1}: {rel}")
    if rel["asteriscos_antes"] != rel["asteriscos_depois"]:
        print("ATENCAO: contagem de asteriscos mudou na conversao!", file=sys.stderr)
        return 1
    if args.v2:
        rel2 = converter(args.origem, args.v2, "v2")
        print(f"v2 -> {args.v2}: {rel2}")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
