"""Os contratos da API JSON (`/api/v1`) — o que entra e o que sai.

Pydantic aqui faz o que `Form("")` faz nas telas: recusa o que nao tem forma
antes de o servico rodar. A diferenca e que a API responde JSON sempre, e
por isso a recusa de forma (422) vem no formato de `Erro`, igual a recusa de
regra — quem consome a API le UM formato de erro, nao dois.

Regra da casa que vale igual aqui: **o servico e a autoridade**. Nenhum
esquema repete uma regra de negocio (RN-24, RN-25, RN-19...); eles so dizem
o tipo de cada campo. A regra continua onde esta, e a API a chama.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class Erro(BaseModel):
    """Toda recusa da API tem esta forma, seja de permissao, de forma ou de regra."""

    erro: str
    motivos: list[str] = Field(default_factory=list)


class Eu(BaseModel):
    id: int
    nome: str
    login: str
    perfis: list[str]
    permissoes: list[str]
    servidor_id: int | None
    versao: str


class ServidorResumo(BaseModel):
    """Uma linha do seletor de quem recebe — ja passada pela RN-19.

    `rotulo` e o que a tela pode escrever: nome com SIAPE para quem pode ler
    o nome, identificador opaco para quem nao pode. `nominal` diz qual dos dois
    foi, para o cliente nao precisar adivinhar pelo formato.
    """

    id: int
    rotulo: str
    nominal: bool


class ItemResumo(BaseModel):
    id: int
    nome: str
    unidade_medida: str
    quantidade_padrao: int
    quantidade_maxima: int | None
    regra_de_quantidade: str
    tamanhos: list[str]
    exige_ca: bool
    numero_ca: str | None
    validade_ca: date | None


class LoteResumo(BaseModel):
    entrada_id: int
    rotulo: str
    saldo: int
    impedimento: str
    pode_sair: bool
    tamanho: str | None
    numero_ca: str | None
    validade_ca: date | None


class NovaEntrega(BaseModel):
    servidor_id: int
    item_id: int
    quantidade: int = Field(gt=0)
    entrada_id: int | None = None
    tamanho: str = ""
    data_evento: date | None = None
    observacao: str = ""
    justificativa_excecao: str = ""


class EntregaRegistrada(BaseModel):
    registro_id: int
    servidor_id: int
    ficha: str
    comprovante: str
    mensagem: str


class LinhaFicha(BaseModel):
    registro_id: int
    tipo: str
    data: date
    epi: str
    quantidade: int
    tamanho: str | None
    numero_ca: str | None
    validade_ca: date | None
    lote: str | None
    previsao_troca: date | None
    estornado: bool
    sem_comprovante: bool
    ca_vencido: bool
    troca_vencida: bool


class Ficha(BaseModel):
    servidor_id: int
    servidor: str
    nominal: bool
    linhas: list[LinhaFicha]


class TurmaResumo(BaseModel):
    id: int
    codigo: str
    treinamento: str
    situacao: str
    data_inicio: date
    data_fim: date
    dias: list[date]
    carga_efetiva: str
    inscritos: int


class PresencaDia(BaseModel):
    presente: bool
    horas: str


class LinhaPresenca(BaseModel):
    inscricao_id: int
    participante: str
    nominal: bool
    por_dia: dict[str, PresencaDia]
    horas: str
    frequencia: str
    aprovado: bool
    situacao: str


class GradePresenca(BaseModel):
    turma_id: int
    codigo: str
    dias: list[date]
    carga_efetiva: str
    retificando: bool
    linhas: list[LinhaPresenca]


class NovaPresenca(BaseModel):
    inscricao_id: int
    data: date
    presente: bool = True
    horas: str = ""
    justificativa: str = ""
    motivo: str = ""


class PendenciaResumo(BaseModel):
    """Uma linha da fila — a descricao ja passada pela RN-19 no servidor."""

    id: int
    tipo: str
    rotulo_tipo: str
    descricao: str
    prazo: date | None
    atrasada: bool
    responsavel: str | None
    onde: str | None


class Pendencias(BaseModel):
    abertas: int
    atrasadas: int
    itens: list[PendenciaResumo]
