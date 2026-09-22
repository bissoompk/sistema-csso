"""Fase 2 - importacao da planilha de pareceres (.xlsx).

Principios (SS10):
  * staging obrigatorio - as 25 colunas entram como texto puro;
  * idempotencia por (origem_migracao, origem_ref) - a carga roda muitas vezes;
  * nada descartado em silencio - o rejeitado vai para migracao_rejeitada;
  * preservar o literal - portaria.texto_original, cargo_snapshot, coluna V.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modelos import (
    AgenteNocivo,
    Cargo,
    Exposicao,
    FluxoEtapa,
    LaudoTecnico,
    MigracaoRejeitada,
    ParecerPosto,
    ParecerTecnico,
    PercentualAplicavel,
    PortariaLocalizacao,
    PostoTrabalho,
    Processo,
    Servidor,
    StgPlanilhaParecer,
    TipoAdicional,
    TipoMarcoInicial,
    TipoMovimento,
    TipoProcesso,
    UnidadeUorg,
)
from app.servicos import auditoria, datas_br, nup as servico_nup, pendencias, textos
from app.servicos.rbac import UsuarioAtual

ORIGEM = "PLANILHA"

COLUNAS = [
    "col_a_data_solicitacao",
    "col_b_numero_parecer",
    "col_c_nome_servidor",
    "col_d_ano",
    "col_e_data",
    "col_f_laudo_de",
    "col_g_unidade",
    "col_h_posto_trabalho",
    "col_i_uorg",
    "col_j_tipo_laudo",
    "col_k_numero_processo",
    "col_l_matricula",
    "col_m_cargo",
    "col_n_funcao",
    "col_o_laudo_siape",
    "col_p_agente_nocivo",
    "col_q_tipo_risco",
    "col_r_percentual",
    "col_s_portaria",
    "col_t_fundamentacao",
    "col_u_alteracao",
    "col_v_recomendacao",
    "col_w_reavaliacao",
    "col_x_pro_reitor",
    "col_Y_sem_cabecalho",
]

# COMPLETA exige C, E, K, L, O, P, R, S, T, V
COLUNAS_COMPLETA = (
    "col_c_nome_servidor",
    "col_e_data",
    "col_k_numero_processo",
    "col_l_matricula",
    "col_o_laudo_siape",
    "col_p_agente_nocivo",
    "col_r_percentual",
    "col_s_portaria",
    "col_t_fundamentacao",
    "col_v_recomendacao",
)

# de-para de grafia observada na planilha (nunca normaliza caixa; corrige erro)
DEPARA_POSTO = {"Central de Esterelização de Materiais (CME)": "Central de Esterilização de Materiais (CME)"}

RE_PORTARIA = re.compile(
    r"(?i)portaria\s*[/\s]\s*(?P<emissor>[A-Za-zÀ-ÿ]+)\s*n[ºo°]?\.?\s*(?P<numero>\d+)"
    r"(?:/(?:\d{4}|[A-Za-z]+))?\s*,?\s*de\s+(?P<dia>\d{1,2})\s+de\s+(?P<mes>\w+)\s+"
    r"de\s+(?P<ano>\d{4})"
)

RE_MARCO_PORTARIA = (
    re.compile(r"(?i)a partir da data da Portaria de Localização:?\s*(.+)"),
    re.compile(r"(?i)a partir da portaria de localização\s*(.+)"),
)
RE_MARCO_SOLICITACAO = re.compile(r"(?i)a partir da data da solicitação\s*(.+)")


@dataclass
class PortariaAnalisada:
    emissor: str
    numero: str
    data: date
    texto: str


def analisar_portaria(texto: str | None) -> PortariaAnalisada | None:
    if not texto:
        return None
    m = RE_PORTARIA.search(str(texto))
    if not m:
        return None
    mes = datas_br.indice_mes(m.group("mes"))
    if mes is None:
        return None
    return PortariaAnalisada(
        emissor=m.group("emissor").upper(),
        numero=m.group("numero").lstrip("0") or "0",
        data=date(int(m.group("ano")), mes, int(m.group("dia"))),
        texto=str(texto).strip(),
    )


@dataclass
class MarcoExtraido:
    codigo: str
    data: date | None
    texto: str


def extrair_marco(recomendacao: str | None) -> MarcoExtraido | None:
    """A coluna A esta 100% vazia; a data do marco vive dentro da recomendacao."""
    if not recomendacao:
        return None
    for padrao in RE_MARCO_PORTARIA:
        m = padrao.search(recomendacao)
        if m:
            bruto = m.group(1).strip()
            return MarcoExtraido("PORTARIA_LOCALIZACAO", datas_br.analisar(bruto), bruto)
    m = RE_MARCO_SOLICITACAO.search(recomendacao)
    if m:
        bruto = m.group(1).strip()
        return MarcoExtraido("SOLICITACAO_SEST", datas_br.analisar(bruto), bruto)
    return None


@dataclass
class LinhaRelatorio:
    linha: int
    classificacao: str
    numero: int | None
    ano: int | None
    acao: str
    pendencias: list[str] = field(default_factory=list)
    divergencias: list[str] = field(default_factory=list)


@dataclass
class RelatorioImportacao:
    arquivo: str
    linhas: list[LinhaRelatorio] = field(default_factory=list)
    rejeitadas: list[tuple[str, str]] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.linhas)

    def contar(self, classificacao: str) -> int:
        return sum(1 for l in self.linhas if l.classificacao == classificacao)


# ---------------------------------------------------------------------
def _texto(valor) -> str | None:
    if valor is None:
        return None
    if isinstance(valor, str):
        limpo = valor.strip()
        return limpo or None
    return str(valor)


def carregar_staging(s: Session, caminho: Path) -> list[StgPlanilhaParecer]:
    wb = load_workbook(str(caminho), data_only=True)
    ws = wb.worksheets[0]
    registros: list[StgPlanilhaParecer] = []
    for indice, linha in enumerate(ws.iter_rows(min_row=2), start=2):
        valores = [c.value for c in linha[:25]] + [None] * max(0, 25 - len(linha))
        if all(v in (None, "") for v in valores):
            continue
        chave = {"arquivo": caminho.name, "linha_origem": indice}
        registro = s.execute(
            select(StgPlanilhaParecer).filter_by(**chave)
        ).scalar_one_or_none()
        if registro is None:
            registro = StgPlanilhaParecer(**chave)
            s.add(registro)
        for nome, valor in zip(COLUNAS, valores, strict=False):
            if nome == "col_e_data":
                data = datas_br.data_de_planilha(valor)
                setattr(registro, nome, data.isoformat() if data else _texto(valor))
            else:
                setattr(registro, nome, _texto(valor))
        registros.append(registro)
    s.flush()
    return registros


def classificar(registro: StgPlanilhaParecer) -> str:
    preenchidas = sum(
        1 for nome in COLUNAS if nome != "col_b_numero_parecer" and getattr(registro, nome)
    )
    tem_numero = bool(registro.col_b_numero_parecer)
    if tem_numero and preenchidas <= (len(COLUNAS) - 1) - 8:
        # numero preenchido e >= 8 das 24 demais colunas vazias
        if preenchidas <= 2:
            return "RESERVA"
    if all(getattr(registro, nome) for nome in COLUNAS_COMPLETA):
        return "COMPLETA"
    if tem_numero and preenchidas <= 2:
        return "RESERVA"
    return "PARCIAL"


# ---------------------------------------------------------------------
# Resolucao de entidades
# ---------------------------------------------------------------------
def resolver_unidade(s: Session, uorg_bruto: str | None, nome_extenso: str | None):
    codigo = textos.codigo_uorg(uorg_bruto)
    if codigo:
        unidade = s.execute(
            select(UnidadeUorg).where(UnidadeUorg.codigo_uorg == codigo)
        ).scalar_one_or_none()
        if unidade:
            return unidade
    if nome_extenso:
        alvo = textos.chave_busca(nome_extenso)
        for unidade in s.execute(select(UnidadeUorg)).scalars():
            if textos.chave_busca(unidade.nome_extenso) == alvo:
                return unidade
    return None


def resolver_postos(s: Session, unidade, bruto: str | None) -> list[PostoTrabalho]:
    if not bruto or unidade is None:
        return []
    partes = [p.strip() for p in re.split(r"[\n/]", str(bruto)) if p.strip()]
    encontrados: list[PostoTrabalho] = []
    for parte in partes:
        nome = DEPARA_POSTO.get(parte, parte)
        posto = s.execute(
            select(PostoTrabalho).where(
                PostoTrabalho.unidade_uorg_id == unidade.id, PostoTrabalho.nome == nome
            )
        ).scalar_one_or_none()
        if posto is None:
            alvo = textos.chave_busca(nome)
            for candidato in s.execute(
                select(PostoTrabalho).where(PostoTrabalho.unidade_uorg_id == unidade.id)
            ).scalars():
                if textos.chave_busca(candidato.nome) == alvo:
                    posto = candidato
                    break
        if posto is None:
            posto = PostoTrabalho(unidade_uorg_id=unidade.id, nome=nome)
            s.add(posto)
            s.flush()
        encontrados.append(posto)
    return encontrados


def resolver_servidor(s: Session, siape: str | None, nome: str | None, cargo, unidade):
    """Chave = SIAPE, nunca o nome."""
    if not siape:
        return None
    limpo = re.sub(r"\D", "", str(siape)).zfill(7)[-7:]
    if not re.fullmatch(r"\d{7}", limpo):
        return None
    servidor = s.execute(select(Servidor).where(Servidor.siape == limpo)).scalar_one_or_none()
    if servidor is None:
        servidor = Servidor(
            siape=limpo,
            nome=(nome or f"SERVIDOR {limpo}").strip(),
            cargo_id=cargo.id if cargo else None,
            unidade_uorg_id=unidade.id if unidade else None,
        )
        s.add(servidor)
        s.flush()
    return servidor


def resolver_cargo(s: Session, nome: str | None):
    if not nome:
        return None
    cargo = s.execute(select(Cargo).where(Cargo.nome == nome.strip())).scalar_one_or_none()
    if cargo is None:
        cargo = Cargo(nome=nome.strip())
        s.add(cargo)
        s.flush()
    return cargo


def resolver_agente(s: Session, descricao: str | None) -> AgenteNocivo | None:
    if not descricao:
        return None
    agente = s.execute(
        select(AgenteNocivo).where(AgenteNocivo.descricao == descricao.strip())
    ).scalar_one_or_none()
    if agente is None:
        alvo = textos.chave_busca(descricao)
        for candidato in s.execute(select(AgenteNocivo)).scalars():
            if textos.chave_busca(candidato.descricao) == alvo:
                agente = candidato
                break
    # de-para de sinonimo -> canonico (unico que altera semantica)
    if agente is not None and agente.agente_canonico_id:
        return s.get(AgenteNocivo, agente.agente_canonico_id)
    return agente


def resolver_portaria(s: Session, texto: str | None, unidade_padrao):
    analise = analisar_portaria(texto)
    if analise is None:
        return None, analise
    emissor = s.execute(
        select(UnidadeUorg).where(UnidadeUorg.sigla == analise.emissor)
    ).scalar_one_or_none()
    if emissor is None:
        alvo = textos.chave_busca(analise.emissor)
        for candidato in s.execute(select(UnidadeUorg)).scalars():
            if candidato.sigla and textos.chave_busca(candidato.sigla) == alvo:
                emissor = candidato
                break
    if emissor is None:
        emissor = unidade_padrao
    if emissor is None:
        return None, analise

    portaria = s.execute(
        select(PortariaLocalizacao).where(
            PortariaLocalizacao.unidade_emissora_id == emissor.id,
            PortariaLocalizacao.numero == analise.numero,
            PortariaLocalizacao.ano == analise.data.year,
        )
    ).scalar_one_or_none()
    if portaria is None:
        portaria = PortariaLocalizacao(
            unidade_emissora_id=emissor.id,
            numero=analise.numero,
            ano=analise.data.year,
            data_publicacao=analise.data,
            texto_original=analise.texto,
        )
        s.add(portaria)
        s.flush()
    return portaria, analise


def resolver_laudo(s: Session, numero: str | None, unidade, tipo_adicional):
    if not numero:
        return None
    limpo = numero.strip()
    if not re.fullmatch(r"\d{5}-\d{3}\.\d{3}/\d{4}", limpo):
        return None
    laudo = s.execute(
        select(LaudoTecnico).where(LaudoTecnico.numero_siape == limpo)
    ).scalar_one_or_none()
    if laudo is None:
        laudo = LaudoTecnico(
            numero_siape=limpo,
            ano=int(limpo[-4:]),
            tipo_adicional_id=tipo_adicional.id,
            unidade_uorg_id=unidade.id,
        )
        s.add(laudo)
        s.flush()
    return laudo


def resolver_processo(s: Session, bruto: str | None, servidor, unidade, tipo_processo, etapa):
    if not bruto:
        return None, None
    resultado = servico_nup.validar(bruto)
    if not resultado.formato_ok:
        return None, resultado
    processo = s.execute(
        select(Processo).where(Processo.nup == resultado.valor)
    ).scalar_one_or_none()
    if processo is None:
        processo = Processo(
            nup=resultado.valor,
            tipo_processo_id=tipo_processo.id,
            etapa_id=etapa.id,
            estado_tecnico="CONCLUIDO",
            situacao="CONCLUIDO",
            data_conclusao=date.today(),
            servidor_id=servidor.id if servidor else None,
            unidade_uorg_id=unidade.id if unidade else None,
            nup_dv_dispensado=not resultado.dv_ok,
            origem_migracao=ORIGEM,
            origem_ref=f"nup:{resultado.valor}",
        )
        s.add(processo)
        s.flush()
    return processo, resultado


# ---------------------------------------------------------------------
def importar(
    s: Session, caminho: Path, usuario: UsuarioAtual, aplicar: bool = True
) -> RelatorioImportacao:
    relatorio = RelatorioImportacao(arquivo=caminho.name)
    registros = carregar_staging(s, caminho)

    tipo_processo = s.execute(
        select(TipoProcesso).where(TipoProcesso.codigo == "ADICIONAL_OCUPACIONAL")
    ).scalar_one()
    etapa_concluido = s.execute(
        select(FluxoEtapa).where(FluxoEtapa.codigo == "CONCLUIDO")
    ).scalar_one()
    insalubridade = s.execute(
        select(TipoAdicional).where(TipoAdicional.codigo == "INSALUBRIDADE")
    ).scalar_one()

    ano_vizinho: int | None = None
    for registro in registros:
        classificacao = classificar(registro)
        registro.classificacao = classificacao
        numero = _numero(registro.col_b_numero_parecer)
        ano = _numero(registro.col_d_ano)
        ano_inferido = False
        if ano is None and numero is not None:
            ano = ano_vizinho
            ano_inferido = ano is not None
        if ano:
            ano_vizinho = ano

        linha = LinhaRelatorio(
            linha=registro.linha_origem,
            classificacao=classificacao,
            numero=numero,
            ano=ano,
            acao="ignorada",
        )

        if numero is None or ano is None:
            _rejeitar(
                s,
                relatorio,
                ref=f"{caminho.name}:{registro.linha_origem}",
                motivo="linha sem número de parecer ou sem ano identificável",
                payload={c: getattr(registro, c) for c in COLUNAS},
            )
            linha.acao = "rejeitada"
            relatorio.linhas.append(linha)
            continue

        if not aplicar:
            linha.acao = "simulada"
            relatorio.linhas.append(linha)
            continue

        parecer = _obter_parecer(s, numero, ano, caminho, registro, usuario)
        parecer.ano_inferido = ano_inferido
        if ano_inferido:
            auditoria.registrar(
                s,
                entidade="parecer_tecnico",
                entidade_id=parecer.id,
                tipo_evento=auditoria.ANO_INFERIDO,
                descricao=(
                    f"Linha {registro.linha_origem}: ano ausente, herdado da linha "
                    f"vizinha não vazia ({ano})."
                ),
                usuario=usuario,
                origem="MIGRACAO_PLANILHA",
                origem_ref=f"{caminho.name}:{registro.linha_origem}",
            )

        if classificacao == "RESERVA":
            parecer.situacao = "RESERVADO"
            linha.acao = "reservado"
            relatorio.linhas.append(linha)
            continue

        _preencher(
            s,
            parecer,
            registro,
            linha,
            tipo_processo=tipo_processo,
            etapa=etapa_concluido,
            insalubridade=insalubridade,
            usuario=usuario,
        )
        parecer.situacao = "EMITIDO" if classificacao == "COMPLETA" and not linha.pendencias else "RASCUNHO"
        linha.acao = "emitido" if parecer.situacao == "EMITIDO" else "rascunho"
        relatorio.linhas.append(linha)

    s.flush()
    return relatorio


def _numero(valor: str | None) -> int | None:
    if valor is None:
        return None
    limpo = re.sub(r"\D", "", str(valor))
    return int(limpo) if limpo else None


def _obter_parecer(
    s: Session,
    numero: int,
    ano: int,
    caminho: Path,
    registro: StgPlanilhaParecer,
    usuario: UsuarioAtual | None = None,
) -> ParecerTecnico:
    """O parecer da linha: o mesmo de sempre por `origem_ref`, ou o que já ocupa
    o número.

    **O reencontro por (numero, ano) é deliberado e continua.** A planilha é
    editada entre uma carga e outra e a linha 40 vira 41; sem ele, a segunda
    carga criaria um segundo 12/2025 e a numeração passaria a ter dois donos.

    O que ele NÃO pode ser é silencioso quando o ocupante **não veio da
    migração**: aí o número foi consumido dentro do sistema, por alguém, e a
    carga estaria reescrevendo o conteúdo de um parecer vivo e carimbando nele a
    origem da planilha. Isso é o `CONFLITO_NUMERACAO` que `pendencias.TIPOS`
    declarava desde o começo e que nenhuma linha abria — a tarefa existia, o
    gatilho é este, e ele estava aqui o tempo todo.
    """
    ref = f"{caminho.name}:{registro.linha_origem}"
    parecer = s.execute(
        select(ParecerTecnico).where(
            ParecerTecnico.origem_migracao == ORIGEM, ParecerTecnico.origem_ref == ref
        )
    ).scalar_one_or_none()
    if parecer is None:
        parecer = s.execute(
            select(ParecerTecnico).where(
                ParecerTecnico.numero == numero, ParecerTecnico.ano == ano
            )
        ).scalar_one_or_none()
        if parecer is not None and parecer.origem_migracao is None:
            _conflito_de_numeracao(s, parecer, ref, usuario)
    if parecer is None:
        parecer = ParecerTecnico(numero=numero, ano=ano, situacao="RASCUNHO")
        s.add(parecer)
    parecer.numero = numero
    parecer.ano = ano
    parecer.origem_migracao = ORIGEM
    parecer.origem_ref = ref
    s.flush()
    return parecer


def _conflito_de_numeracao(
    s: Session, parecer: ParecerTecnico, ref: str, usuario: UsuarioAtual | None
) -> None:
    """Tarefa com dono e prazo para o número que a carga encontrou ocupado.

    Não recusa a linha: recusar deixaria a planilha pela metade e a decisão de
    qual dos dois documentos fica com `N/AAAA` não é de quem roda a carga — é de
    quem responde pela numeração, com os dois na mão. A carga segue, e a tarefa
    diz exatamente o que conferir. O evento vai junto para a trilha, porque a
    pendência se fecha e a trilha não.
    """
    chave = f"conflito-numeracao:parecer:{parecer.id}"
    pendencias.abrir(
        s,
        tipo="CONFLITO_NUMERACAO",
        chave=chave,
        descricao=(
            f"O número {parecer.numero}/{parecer.ano} já era de um parecer criado "
            f"no sistema (situação {parecer.situacao}) e a carga da planilha "
            f"({ref}) escreveu por cima dele. Confira qual dos dois documentos "
            "fica com este número e renumere o outro."
        ),
        usuario=usuario,
        parecer_id=parecer.id,
        processo_id=parecer.processo_id,
    )
    auditoria.registrar(
        s,
        entidade="parecer_tecnico",
        entidade_id=parecer.id,
        processo_id=parecer.processo_id,
        tipo_evento="CONFLITO_NUMERACAO",
        descricao=(
            f"Carga da planilha ({ref}) assumiu o número {parecer.numero}/"
            f"{parecer.ano}, que já pertencia a um parecer do sistema."
        ),
        usuario=usuario,
        origem="MIGRACAO_PLANILHA",
        origem_ref=ref,
    )


def _preencher(
    s: Session,
    parecer: ParecerTecnico,
    registro: StgPlanilhaParecer,
    linha: LinhaRelatorio,
    *,
    tipo_processo,
    etapa,
    insalubridade,
    usuario: UsuarioAtual,
) -> None:
    from app.modelos import AutoridadeDestinataria, ProfissionalHabilitado, SetorEmissor

    unidade = resolver_unidade(s, registro.col_i_uorg, registro.col_g_unidade)
    if unidade is None:
        linha.pendencias.append("UORG não reconhecida")
    cargo = resolver_cargo(s, registro.col_m_cargo)
    servidor = resolver_servidor(
        s, registro.col_l_matricula, registro.col_c_nome_servidor, cargo, unidade
    )
    if servidor is None:
        linha.pendencias.append("matrícula SIAPE ausente")

    processo, resultado_nup = resolver_processo(
        s, registro.col_k_numero_processo, servidor, unidade, tipo_processo, etapa
    )
    if processo is None:
        linha.pendencias.append("sem número de processo (NUP)")
    elif resultado_nup and not resultado_nup.dv_ok:
        linha.divergencias.append(f"NUP com DV inválido: {resultado_nup.valor}")

    laudo = resolver_laudo(s, registro.col_o_laudo_siape, unidade, insalubridade) if unidade else None
    if laudo is None:
        linha.pendencias.append("laudo técnico ausente")

    portaria, analise = resolver_portaria(s, registro.col_s_portaria, unidade)
    if portaria is None:
        linha.pendencias.append("portaria de localização ausente")

    movimento = None
    if registro.col_f_laudo_de:
        alvo = textos.chave_busca(registro.col_f_laudo_de)
        for candidato in s.execute(select(TipoMovimento)).scalars():
            if textos.chave_busca(candidato.nome) == alvo:
                movimento = candidato
                break

    parecer.processo_id = processo.id if processo else None
    parecer.servidor_id = servidor.id if servidor else None
    parecer.unidade_uorg_id = unidade.id if unidade else None
    parecer.laudo_id = laudo.id if laudo else None
    parecer.portaria_id = portaria.id if portaria else None
    parecer.tipo_adicional_id = insalubridade.id
    parecer.tipo_movimento_id = movimento.id if movimento else None
    parecer.cargo_snapshot = registro.col_m_cargo
    parecer.funcao_snapshot = registro.col_n_funcao
    parecer.data_emissao = datas_br.analisar(registro.col_e_data)
    if parecer.data_emissao and parecer.data_emissao.year != parecer.ano:
        linha.divergencias.append(
            f"data {parecer.data_emissao.isoformat()} não bate com o ano {parecer.ano}"
        )
        parecer.data_emissao = None

    parecer.texto_alteracao = registro.col_u_alteracao
    parecer.texto_reavaliacao = registro.col_w_reavaliacao
    parecer.texto_recomendacao = registro.col_v_recomendacao
    parecer.texto_recomendacao_literal = bool(registro.col_v_recomendacao)
    parecer.modelo_arquivo = "modelo_parecer_v1.docx"

    destinatario = None
    if registro.col_x_pro_reitor:
        destinatario = s.execute(
            select(AutoridadeDestinataria).where(
                AutoridadeDestinataria.nome == registro.col_x_pro_reitor.strip()
            )
        ).scalar_one_or_none()
    destinatario = destinatario or s.execute(select(AutoridadeDestinataria)).scalars().first()
    parecer.destinatario_id = destinatario.id if destinatario else None

    signatario = s.execute(select(ProfissionalHabilitado)).scalars().first()
    parecer.signatario_id = signatario.id if signatario else None

    if parecer.data_emissao:
        setor = None
        for candidato in s.execute(select(SetorEmissor)).scalars():
            if candidato.vigencia_inicio <= parecer.data_emissao and (
                candidato.vigencia_fim is None or candidato.vigencia_fim >= parecer.data_emissao
            ):
                setor = candidato
        if setor:
            parecer.setor_emissor_id = setor.id
            parecer.sigla_emissora_snapshot = setor.sigla_composta
            parecer.nome_emissor_snapshot = setor.nome_extenso
            parecer.endereco_emissor_snapshot = setor.endereco
            parecer.telefone_emissor_snapshot = setor.telefone

    # postos
    postos = resolver_postos(s, unidade, registro.col_h_posto_trabalho)
    parecer.postos.clear()
    s.flush()
    for ordem, posto in enumerate(postos, start=1):
        s.add(ParecerPosto(parecer_id=parecer.id, posto_trabalho_id=posto.id, ordem=ordem))
    if not postos:
        linha.pendencias.append("posto de trabalho ausente")

    # exposicao
    agente = resolver_agente(s, registro.col_p_agente_nocivo)
    percentual = None
    if registro.col_r_percentual:
        alvo = textos.chave_busca(registro.col_r_percentual)
        for candidato in s.execute(
            select(PercentualAplicavel).where(
                PercentualAplicavel.tipo_adicional_id == insalubridade.id
            )
        ).scalars():
            if textos.chave_busca(candidato.rotulo) == alvo:
                percentual = candidato
                break
    if percentual is None:
        linha.pendencias.append("Percentual aplicável ausente")
    if agente is None:
        linha.pendencias.append("agente nocivo não reconhecido")

    if agente is not None and percentual is not None and agente.fundamentacao_id:
        ja = s.execute(
            select(Exposicao).where(
                Exposicao.parecer_id == parecer.id,
                Exposicao.agente_nocivo_id == agente.id,
            )
        ).scalar_one_or_none()
        if ja is None:
            s.add(
                Exposicao(
                    parecer_id=parecer.id,
                    agente_nocivo_id=agente.id,
                    percentual_id=percentual.id,
                    fundamentacao_id=agente.fundamentacao_id,
                    principal=True,
                )
            )
        # RN-06: o parecer migrado ja saiu, mas a avaliacao quantitativa continua
        # devida - a migracao e justamente onde essa divida aparece.
        if agente.exige_reavaliacao_quantitativa:
            pendencias.abrir(
                s,
                tipo="AVALIACAO_QUANTITATIVA",
                chave=f"quantitativa:migrado:parecer:{parecer.id}",
                descricao=(
                    f"Parecer {parecer.numero}/{parecer.ano} (migrado): avaliar "
                    f"quantitativamente '{agente.descricao}' e elaborar novo laudo."
                ),
                usuario=usuario,
                processo_id=processo.id if processo else None,
                parecer_id=parecer.id,
            )

    # marco embutido na recomendacao (coluna A esta 100% vazia)
    marco = extrair_marco(registro.col_v_recomendacao)
    if marco is not None:
        tipo_marco = s.execute(
            select(TipoMarcoInicial).where(TipoMarcoInicial.codigo == marco.codigo)
        ).scalar_one_or_none()
        parecer.tipo_marco_id = tipo_marco.id if tipo_marco else None
        parecer.data_marco_inicial = marco.data
        if marco.codigo == "SOLICITACAO_SEST" and processo is not None and marco.data:
            processo.data_solicitacao_sest = marco.data
        if (
            marco.codigo == "PORTARIA_LOCALIZACAO"
            and analise is not None
            and marco.data
            and marco.data != analise.data
        ):
            linha.divergencias.append(
                f"marco {marco.data.isoformat()} diverge da portaria "
                f"{analise.data.isoformat()}"
            )
    else:
        linha.pendencias.append("marco inicial não identificado na recomendação")

    s.flush()


def _rejeitar(
    s: Session, relatorio: RelatorioImportacao, *, ref: str, motivo: str, payload: dict
) -> None:
    ja = s.execute(
        select(MigracaoRejeitada).where(
            MigracaoRejeitada.origem == ORIGEM, MigracaoRejeitada.ref == ref
        )
    ).scalar_one_or_none()
    if ja is None:
        s.add(
            MigracaoRejeitada(
                origem=ORIGEM,
                ref=ref,
                motivo=motivo,
                payload=payload,
                # RN-23: payload expurgado 90 dias apos o encerramento da migracao
                expurgar_apos=date.today() + timedelta(days=90),
            )
        )
        s.flush()
    relatorio.rejeitadas.append((ref, motivo))
