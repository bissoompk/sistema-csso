/**
 * O comprovante de entrega de EPI: contexto congelado e impressão em .docx.
 * Porte de `app/servicos/comprovante_epi.py`.
 *
 * Mesma divisão do parecer e do certificado: aqui o **contexto** e o
 * **render**; em `epi_ficha.ts`, as regras.
 *
 * **Por que é papel.** A decisão 8 (18/08/2026) fixou que o comprovante é papel
 * assinado no ato e digitalizado depois. O sistema imprime, o servidor assina,
 * e o PDF volta como `Anexo(categoria='FICHA_EPI', assinado=true)`.
 *
 * **O que o documento diz é o que valia no dia da entrega** (RN-15): a única
 * porta de saída para registro gravado lê `contexto_congelado`, nunca o
 * catálogo de hoje. E o documento não carrega a data em que foi impresso: a
 * segunda via tem de sair com texto idêntico ao da primeira.
 *
 * Na nuvem o .docx vai para o armazenamento (`armazenamento.ts`), e não para
 * uma pasta local; PDF não há (PORTE.md §8) — o comprovante já era .docx.
 */
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import * as textos from "./textos.js";

export const MODELO = "comprovante_epi_v1.docx";
export const SUBPASTA = "epi";
export const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// O termo que o servidor assina. Fica em código: sem as obrigações declaradas o
// que se colhe é um recibo, não um termo de responsabilidade. A citação é à
// NR-6 como um todo, sem item — o dispositivo exato ainda não foi conferido
// (ROPA §9, item 1).
export const TERMO_RESPONSABILIDADE =
  "Declaro ter recebido o equipamento de proteção individual acima " +
  "discriminado, em perfeitas condições de uso, e ter sido orientado quanto " +
  "ao seu uso, guarda e conservação.\n" +
  "Comprometo-me, nos termos da NR-6, a: usar o equipamento apenas para a " +
  "finalidade a que se destina; responsabilizar-me por sua guarda e " +
  "conservação; comunicar ao setor qualquer alteração que o torne impróprio " +
  "para uso; e cumprir as determinações sobre o uso adequado.\n" +
  "Estou ciente de que a devolução, a troca por desgaste, o extravio ou a " +
  "danificação devem ser comunicados à CSSO, e de que o equipamento é de uso " +
  "pessoal e intransferível.";

export const ROTULO_TIPO: Record<string, string> = {
  ENTREGA: "COMPROVANTE DE ENTREGA DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
  DEVOLUCAO: "COMPROVANTE DE DEVOLUÇÃO DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
  SUBSTITUICAO: "COMPROVANTE DE SUBSTITUIÇÃO DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
  DESCARTE: "COMPROVANTE DE DESCARTE DE EQUIPAMENTO DE PROTEÇÃO INDIVIDUAL",
  ESTORNO: "ESTORNO DE REGISTRO DA FICHA DE EPI",
};

export const CAMPOS_CONGELADOS = [
  "tipo", "data_evento", "quantidade", "unidade_medida",
  "servidor_nome", "siape", "cargo", "funcao", "unidade", "posto",
  "epi_nome", "categoria", "fabricante", "modelo", "normas", "numero_ca",
  "validade_ca", "lote", "tamanho", "previsao_troca",
  "pregao", "item_pregao", "empenho", "nota_fiscal", "fornecedor",
  "entregue_por", "motivo",
  "setor_sigla", "setor_nome", "setor_endereco", "cidade", "termo",
] as const;

// as três datas: texto ISO no congelado, 'AAAA-MM-DD' aqui também
const DATAS = ["data_evento", "validade_ca", "previsao_troca"] as const;

export interface DadosComprovante {
  registro_id: number;
  tipo: string;
  data_evento: string;
  quantidade: number;
  unidade_medida: string;
  servidor_nome: string;
  siape: string;
  cargo: string;
  funcao: string;
  unidade: string;
  posto: string;
  epi_nome: string;
  categoria: string;
  fabricante: string;
  modelo: string;
  normas: string;
  numero_ca: string;
  validade_ca: string | null;
  lote: string;
  tamanho: string;
  previsao_troca: string | null;
  pregao: string;
  item_pregao: string;
  empenho: string;
  nota_fiscal: string;
  fornecedor: string;
  entregue_por: string;
  motivo: string;
  setor_sigla: string;
  setor_nome: string;
  setor_endereco: string;
  cidade: string;
  termo?: string;
}

/**
 * Tudo o que o comprovante imprime — e nada que dependa do banco de hoje.
 *
 * `registro_id` NÃO entra no congelado: o id só existe depois do INSERT, e
 * gravar o congelado depois seria alterar coluna de conteúdo — que a trava
 * recusa. `descongelar` o recebe de volta da linha.
 */
export class ContextoComprovante {
  registro_id!: number;
  tipo!: string;
  data_evento!: string;
  quantidade!: number;
  unidade_medida!: string;
  servidor_nome!: string;
  siape!: string;
  cargo!: string;
  funcao!: string;
  unidade!: string;
  posto!: string;
  epi_nome!: string;
  categoria!: string;
  fabricante!: string;
  modelo!: string;
  normas!: string;
  numero_ca!: string;
  validade_ca!: string | null;
  lote!: string;
  tamanho!: string;
  previsao_troca!: string | null;
  pregao!: string;
  item_pregao!: string;
  empenho!: string;
  nota_fiscal!: string;
  fornecedor!: string;
  entregue_por!: string;
  motivo!: string;
  setor_sigla!: string;
  setor_nome!: string;
  setor_endereco!: string;
  cidade!: string;
  termo: string = TERMO_RESPONSABILIDADE;

  constructor(d: DadosComprovante) {
    Object.assign(this, d);
    if (d.termo === undefined || d.termo === null) this.termo = TERMO_RESPONSABILIDADE;
  }

  /** A forma que vai para `epi_ficha_registro.contexto_congelado`. */
  congelar(): Record<string, unknown> {
    const dados: Record<string, unknown> = {};
    for (const campo of CAMPOS_CONGELADOS) dados[campo] = (this as any)[campo] ?? null;
    for (const campo of DATAS) {
      const v = dados[campo] as string | null;
      dados[campo] = v ? v.slice(0, 10) : null;
    }
    return dados;
  }

  static descongelar(dados: Record<string, unknown>, opcoes: { registro_id: number }): ContextoComprovante {
    const valores: Record<string, unknown> = {};
    for (const campo of CAMPOS_CONGELADOS) valores[campo] = dados[campo] ?? null;
    for (const campo of DATAS) {
      const bruto = valores[campo] as string | null;
      valores[campo] = bruto ? String(bruto).slice(0, 10) : null;
    }
    return new ContextoComprovante({ registro_id: opcoes.registro_id, ...(valores as any) });
  }

  get titulo(): string {
    return ROTULO_TIPO[this.tipo] ?? ROTULO_TIPO["ENTREGA"]!;
  }

  /** Fabricante, marca e modelo numa linha só, sem travessão órfão. */
  get identificacao_do_equipamento(): string {
    return [this.fabricante, this.modelo].filter((p) => p).join(" · ") || "—";
  }

  /** Pregão, item, empenho e nota fiscal — vazio na entrega de balcão. */
  get aquisicao(): string {
    const rotulados: [string, string][] = [
      ["Pregão", this.pregao],
      ["Item", this.item_pregao],
      ["Empenho", this.empenho],
      ["Nota fiscal", this.nota_fiscal],
      ["Fornecedor", this.fornecedor],
    ];
    return rotulados
      .filter(([, valor]) => valor)
      .map(([rotulo, valor]) => `${rotulo}: ${valor}`)
      .join(" · ");
  }

  como_dicionario(): Record<string, unknown> {
    const data = (valor: string | null) => (valor ? datas_br.numerica(valor) : "—");
    return {
      titulo: this.titulo,
      registro: String(this.registro_id).padStart(6, "0"),
      setor_sigla: this.setor_sigla,
      setor_nome: this.setor_nome,
      setor_endereco: this.setor_endereco,
      cidade: this.cidade,
      servidor_nome: this.servidor_nome,
      siape: this.siape,
      cargo: this.cargo || "—",
      funcao: this.funcao || "—",
      unidade: this.unidade || "—",
      posto: this.posto || "—",
      epi_nome: this.epi_nome,
      categoria: this.categoria,
      identificacao: this.identificacao_do_equipamento,
      // norma de EPI vem uma por linha, dentro da mesma célula
      normas: documento.rich_multilinha(this.normas) ?? "—",
      // o CA é o que constitui o equipamento como EPI (NR-6)
      numero_ca: this.numero_ca || "não se aplica",
      validade_ca: data(this.validade_ca),
      lote: this.lote || "—",
      tamanho: this.tamanho || "—",
      quantidade: `${this.quantidade} ${(this.unidade_medida ?? "").toLowerCase()}`,
      data_evento: data(this.data_evento),
      data_extenso: datas_br.por_extenso(this.data_evento),
      previsao_troca: data(this.previsao_troca),
      aquisicao: this.aquisicao || "—",
      entregue_por: this.entregue_por,
      motivo: this.motivo || "—",
      termo: documento.rich_multilinha(this.termo) ?? "",
    };
  }

  obrigatorios_faltantes(): string[] {
    const exigidos: [keyof ContextoComprovante, string][] = [
      ["servidor_nome", "nome do servidor"],
      ["siape", "matrícula SIAPE"],
      ["epi_nome", "nome do EPI"],
      ["categoria", "categoria da NR-6"],
      ["entregue_por", "quem entregou"],
    ];
    return exigidos.filter(([campo]) => !this[campo]).map(([, rotulo]) => rotulo);
  }
}

/**
 * A chave no armazenamento: `documentos/epi/{ano}/Comprovante_EPI_000123.docx`.
 * Por ano, como o parecer e o certificado.
 */
export function caminho_saida(registro_id: number, ano: number): string {
  return `documentos/${SUBPASTA}/${ano}/Comprovante_EPI_${String(registro_id).padStart(6, "0")}.docx`;
}

/** Passa pelo mecanismo único de documento do sistema. */
export function renderizar(contexto: ContextoComprovante, destino: string | null) {
  return documento.renderizar_modelo(MODELO, contexto.como_dicionario(), {
    destino,
    dica: "Rode ferramentas/converter-modelos-docx.ts.",
  });
}

/** `Comprovante_EPI_000123_Marco_Antonio.docx`. */
export function nome_para_download(contexto: ContextoComprovante): string {
  const partes = [
    "Comprovante_EPI",
    String(contexto.registro_id).padStart(6, "0"),
    textos.slug_ascii(contexto.servidor_nome).slice(0, 60),
  ];
  return partes.filter((p) => p).join("_") + ".docx";
}
