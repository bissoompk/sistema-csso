"""O comprovante de entrega de EPI: contexto congelado e impressão em .docx.

Fatia 2 do módulo Gestão de EPI. Está aqui a mesma divisão que o parecer e o
certificado já têm: este arquivo guarda o **contexto** e o **render** (como
`documento.py` e `certificado.py`), e `epi_ficha.py` guarda as regras de negócio
(como `parecer.py` e `emissao_certificado.py`).

**Por que existe um documento, e por que ele é papel.** A decisão 8 (18/08/2026)
fixou que o comprovante de EPI é papel assinado no ato e digitalizado depois:
assinatura em tela tem valor probatório mais fraco e exigiria dispositivo no
almoxarifado, e transformar cada par de luva num documento do SEI não se
sustenta. O sistema imprime, o servidor assina, e o PDF volta como
`Anexo(categoria='FICHA_EPI', assinado=True)`.

**O que o documento diz é o que valia no dia da entrega.** `montar_contexto` tem
uma única porta de saída para registro gravado, e ela lê `contexto_congelado` —
nunca o catálogo de hoje. É a RN-15 aplicada ao EPI: renomear "Luva nitrílica"
para "Luva de procedimento" em 2027 não pode reescrever uma entrega de 2024.

**E o documento não carrega a data em que foi impresso**, de propósito. A
segunda via de um comprovante de 2024 tem de sair com texto idêntico ao da
primeira — mesma disciplina do texto de ouro do parecer —, e um carimbo de
"emitido em" faria cada reimpressão divergir da anterior por construção. Quem
imprimiu e quando fica na trilha de auditoria, que é onde essa informação
pertence.

O modelo (`comprovante_epi_v1.docx`) é produzido por
`ferramentas/gerar_modelo_comprovante_epi.py` e pode ser substituído por um
desenhado no Word, desde que use os mesmos marcadores — a mesma liberdade que o
modelo do parecer tem.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from app.config import obter_config
from app.servicos import datas_br, documento, textos

MODELO = "comprovante_epi_v1.docx"
SUBPASTA = "epi"
TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# O termo que o servidor assina. Fica aqui, em código, e não em `texto_padrao`:
# ele é a razão de ser do papel — sem as obrigações declaradas, o que se colhe é
# um recibo de entrega, não um termo de responsabilidade.
#
# A citação é à **NR-6 como um todo**, sem número de item, e isso é deliberado.
# O conteúdo das obrigações é o da norma; o dispositivo exato ainda não foi
# conferido contra a redação vigente, e há uma questão aberta antes dela — as NRs
# são instrumento da CLT e o titular aqui é servidor estatutário, o que está
# registrado como pendência no `docs/ROPA.md` §9, item 1. Citar item e alínea que
# eu não conferi seria dar ao papel uma precisão que ele não tem.
TERMO_RESPONSABILIDADE = (
    "Declaro ter recebido o equipamento de proteção individual acima "
    "discriminado, em perfeitas condições de uso, e ter sido orientado quanto "
    "ao seu uso, guarda e conservação.\n"
    "Comprometo-me, nos termos da NR-6, a: usar o equipamento apenas para a "
    "finalidade a que se destina; responsabilizar-me por sua guarda e "
    "conservação; comunicar ao setor qualquer alteração que o torne impróprio "
    "para uso; e cumprir as determinações sobre o uso adequado.\n"
    "Estou ciente de que a devolução, a troca por desgaste, o extravio ou a "
    "danificação devem ser comunicados à CSSO, e de que o equipamento é de uso "
    "pessoal e intransferível."
)

ROTULO_TIPO = {
    "ENTREGA": "COMPROVANTE DE ENTREGA DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
    "DEVOLUCAO": "COMPROVANTE DE DEVOLUÇÃO DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
    "SUBSTITUICAO": "COMPROVANTE DE SUBSTITUIÇÃO DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
    "DESCARTE": "COMPROVANTE DE DESCARTE DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
    "ESTORNO": "ESTORNO DE REGISTRO DA FICHA DE EPI",
}


@dataclass
class ContextoComprovante:
    """Tudo o que o comprovante imprime — e nada que dependa do banco de hoje.

    Todo campo é `str`, `int` ou `date`. Não há FK, não há objeto do ORM e não há
    consulta: depois de congelado, este contexto sobrevive a renomear o item, a
    inativar o lote, a transferir o servidor de unidade e a desativar a conta de
    quem entregou.
    """

    # --- identificação do registro ---
    # `registro_id` NÃO entra no congelado, e isso é uma consequência direta da
    # trava do banco: o id só existe depois do INSERT, e gravar o congelado
    # depois seria alterar uma coluna de conteúdo — que a tabela recusa. Também
    # não faria sentido congelá-lo: é a chave primária da própria linha, o único
    # dado que não pode divergir dela. `descongelar` o recebe de volta da linha.
    registro_id: int
    tipo: str
    data_evento: date
    quantidade: int
    unidade_medida: str

    # --- quem recebeu, como estava no dia ---
    servidor_nome: str
    siape: str
    cargo: str
    funcao: str
    unidade: str
    posto: str

    # --- o que foi entregue, como estava no dia ---
    epi_nome: str
    categoria: str
    fabricante: str
    modelo: str
    normas: str
    numero_ca: str
    validade_ca: date | None
    lote: str
    tamanho: str
    previsao_troca: date | None

    # --- rastreabilidade da compra pública ---
    pregao: str
    item_pregao: str
    empenho: str
    nota_fiscal: str
    fornecedor: str

    # --- quem entregou e por quem responde ---
    entregue_por: str
    motivo: str

    # --- cabeçalho institucional ---
    setor_sigla: str
    setor_nome: str
    setor_endereco: str
    cidade: str

    termo: str = TERMO_RESPONSABILIDADE

    CAMPOS_CONGELADOS = (
        "tipo", "data_evento", "quantidade", "unidade_medida",
        "servidor_nome", "siape", "cargo", "funcao", "unidade", "posto",
        "epi_nome", "categoria", "fabricante", "modelo", "normas", "numero_ca",
        "validade_ca", "lote", "tamanho", "previsao_troca",
        "pregao", "item_pregao", "empenho", "nota_fiscal", "fornecedor",
        "entregue_por", "motivo",
        "setor_sigla", "setor_nome", "setor_endereco", "cidade", "termo",
    )

    # as três datas viram texto ISO no congelado e voltam a `date` no descongelar
    _DATAS = ("data_evento", "validade_ca", "previsao_troca")

    def congelar(self) -> dict:
        """A forma que vai para `epi_ficha_registro.contexto_congelado`.

        Data vira texto ISO explicitamente, e não pela conversão implícita do
        `JSONTexto`: a coluna serializa com `default=str`, então um `date` iria
        e voltaria como texto de qualquer modo — mas em silêncio, e
        `descongelar` teria de adivinhar quais chaves eram datas. Escrito aqui,
        o par congelar/descongelar é simétrico e verificável.
        """
        dados = {campo: getattr(self, campo) for campo in self.CAMPOS_CONGELADOS}
        for campo in self._DATAS:
            valor = dados[campo]
            dados[campo] = valor.isoformat() if valor is not None else None
        return dados

    @classmethod
    def descongelar(cls, dados: dict, *, registro_id: int) -> "ContextoComprovante":
        valores = {campo: dados.get(campo) for campo in cls.CAMPOS_CONGELADOS}
        for campo in cls._DATAS:
            bruto = valores.get(campo)
            valores[campo] = date.fromisoformat(bruto[:10]) if bruto else None
        return cls(registro_id=registro_id, **valores)

    # -----------------------------------------------------------------
    @property
    def titulo(self) -> str:
        return ROTULO_TIPO.get(self.tipo, ROTULO_TIPO["ENTREGA"])

    @property
    def identificacao_do_equipamento(self) -> str:
        """Fabricante, marca e modelo numa linha só, sem travessão órfão."""
        partes = [p for p in (self.fabricante, self.modelo) if p]
        return " · ".join(partes) or "—"

    @property
    def aquisicao(self) -> str:
        """Pregão, item, empenho e nota fiscal — o que amarra o EPI à compra.

        Vazio quando a entrega não veio de lote (entrega de balcão): imprimir
        "Pregão: — · Empenho: —" ocuparia uma linha para dizer nada.
        """
        rotulados = (
            ("Pregão", self.pregao),
            ("Item", self.item_pregao),
            ("Empenho", self.empenho),
            ("Nota fiscal", self.nota_fiscal),
            ("Fornecedor", self.fornecedor),
        )
        presentes = [f"{rotulo}: {valor}" for rotulo, valor in rotulados if valor]
        return " · ".join(presentes)

    def como_dicionario(self) -> dict:
        def data(valor: date | None) -> str:
            return datas_br.numerica(valor) if valor else "—"

        return {
            "titulo": self.titulo,
            "registro": f"{self.registro_id:06d}",
            "setor_sigla": self.setor_sigla,
            "setor_nome": self.setor_nome,
            "setor_endereco": self.setor_endereco,
            "cidade": self.cidade,
            "servidor_nome": self.servidor_nome,
            "siape": self.siape,
            "cargo": self.cargo or "—",
            "funcao": self.funcao or "—",
            "unidade": self.unidade or "—",
            "posto": self.posto or "—",
            "epi_nome": self.epi_nome,
            "categoria": self.categoria,
            "identificacao": self.identificacao_do_equipamento,
            # RichText: norma de EPI vem uma por linha, dentro da mesma célula —
            # o mesmo `_rich` que o parecer usa nos postos de trabalho
            "normas": documento.rich_multilinha(self.normas) or "—",
            # o CA é o que constitui o equipamento como EPI (NR-6): sai em
            # destaque e com a validade ao lado, nunca só o número
            "numero_ca": self.numero_ca or "não se aplica",
            "validade_ca": data(self.validade_ca),
            "lote": self.lote or "—",
            "tamanho": self.tamanho or "—",
            "quantidade": f"{self.quantidade} {self.unidade_medida.lower()}",
            "data_evento": data(self.data_evento),
            "data_extenso": datas_br.por_extenso(self.data_evento),
            "previsao_troca": data(self.previsao_troca),
            "aquisicao": self.aquisicao or "—",
            "entregue_por": self.entregue_por,
            "motivo": self.motivo or "—",
            "termo": documento.rich_multilinha(self.termo) or "",
        }

    def obrigatorios_faltantes(self) -> list[str]:
        exigidos = {
            "servidor_nome": "nome do servidor",
            "siape": "matrícula SIAPE",
            "epi_nome": "nome do EPI",
            "categoria": "categoria da NR-6",
            "entregue_por": "quem entregou",
        }
        return [rotulo for campo, rotulo in exigidos.items() if not getattr(self, campo)]


def caminho_saida(registro_id: int, ano: int) -> Path:
    """`dados/documentos/epi/{ano}/Comprovante_EPI_000123.docx`.

    Por ano, como o parecer, o certificado e a lista de presença, porque é assim
    que o setor arquiva e é assim que o backup separa.
    """
    cfg = obter_config()
    pasta = cfg.caminho(cfg.dir_documentos) / SUBPASTA / str(ano)
    return pasta / f"Comprovante_EPI_{registro_id:06d}.docx"


def renderizar(contexto: ContextoComprovante, destino: Path) -> dict:
    """Passa pelo mecanismo único de documento do sistema.

    Dois mecanismos de documento seriam dois lugares para o hash de integridade
    divergir, e o parecer já provou que um só basta.
    """
    return documento.renderizar_modelo(
        MODELO,
        contexto.como_dicionario(),
        destino,
        dica="Rode python -m ferramentas.gerar_modelo_comprovante_epi.",
    )


def nome_para_download(contexto: ContextoComprovante) -> str:
    """`Comprovante_EPI_000123_Marco_Antonio.docx` — legível na pasta de quem baixa."""
    partes = [
        "Comprovante_EPI",
        f"{contexto.registro_id:06d}",
        textos.slug_ascii(contexto.servidor_nome)[:60],
    ]
    return "_".join(p for p in partes if p) + ".docx"


__all__ = [
    "MODELO",
    "ROTULO_TIPO",
    "SUBPASTA",
    "TERMO_RESPONSABILIDADE",
    "TIPO_DOCX",
    "ContextoComprovante",
    "caminho_saida",
    "nome_para_download",
    "renderizar",
]
