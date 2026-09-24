/**
 * Seeds obrigatórios (§5 do prompt) — valores reais, conferidos nos documentos.
 * Porte de `app/servicos/sementes.py`.
 *
 * Regra transversal: nomes de posto, unidade, cargo e portaria são gravados byte
 * a byte como aparecem no documento de origem. O sistema nunca normaliza caixa
 * nesses campos.
 *
 * Idempotente: rodar duas vezes não duplica nada.
 *
 * Diferença de forma: no Python `semear()` terminava com `s.commit()`. Aqui o
 * serviço recebe o executor e não fecha transação (PORTE.md §2); quem chama
 * (`ferramentas/semear.ts`, o `globalSetup` dos testes) abre e fecha.
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import type { Executor } from "../db/cliente.js";
import {
  agente_nocivo,
  autoridade_destinataria,
  campus,
  cargo,
  epi_categoria,
  epi_motivo_recusa,
  fluxo_etapa,
  fundamentacao_legal,
  perfil,
  perfil_permissao,
  percentual_aplicavel,
  permissao,
  posto_trabalho,
  profissional_habilitado,
  setor_emissor,
  texto_padrao,
  tipo_adicional,
  tipo_marco_inicial,
  tipo_movimento,
  tipo_processo,
  tipo_risco,
  unidade_uorg,
} from "../db/esquema/index.js";
import { MATRIZ_PERFIS, PERMISSOES, modulo_da_permissao } from "./rbac.js";

// =====================================================================
// Textos literais (aspas curvas em ambos - §5)
// =====================================================================
export const TEXTO_NR15_AX14 =
  "“Trabalhos e operações em contato permanente com material infecto-contagiante, " +
  "em: laboratórios de análise clínica e histopatologia”\n" +
  "Anexo 14 da NR 15 e Instrução Normativa 15/2022.";
export const TEXTO_NR15_AX13 =
  "“Fabricação e manipulação de ácido oxálico, nítrico sulfúrico, clorídrico, " +
  "fosfórico, pícrico.”\n" +
  "“Manipulação de álcalis cáusticos.”\n" +
  "Anexo 13 da NR 15 e Instrução Normativa 15/2022.";

// A negativa que faz a decisão 3 do coordenador virar comportamento de sistema.
// O último período é o que separa um "não" de um encaminhamento.
export const TEXTO_RECUSA_VINCULO =
  "O equipamento de proteção individual do empregado de empresa contratada é " +
  "obrigação do empregador, nos termos da NR-6. A UFVJM não fornece EPI a " +
  "pessoal terceirizado; o pedido deve ser dirigido à empresa contratante, e a " +
  "fiscalização do contrato pode ser acionada se o fornecimento não estiver " +
  "ocorrendo.";

export const ENDERECO_UFVJM = "Rodovia MGT 367 - Km 583, nº 5000 - Alto da Jacuba - CEP 39100-000";
export const TELEFONE_UFVJM = "Fone: (38) 3532-1200 e (38) 3532-6000";

type Linha = Record<string, any>;

/**
 * O `_obter_ou_criar` do Python: procura pelas `chaves` (igualdade; `null` vira
 * `IS NULL`, como o `filter_by(x=None)` do SQLAlchemy) e só cria se não achar.
 * Quem já existe NÃO é atualizado com `valores`.
 */
async function _obter_ou_criar<T extends PgTable>(
  tx: Executor,
  tabela: T,
  chaves: Record<string, unknown>,
  valores: Record<string, unknown> = {},
): Promise<Linha> {
  const colunas = tabela as unknown as Record<string, PgColumn>;
  const condicoes: SQL[] = Object.entries(chaves).map(([k, v]) => {
    const coluna = colunas[k];
    if (!coluna) throw new Error(`coluna ${k} inexistente`);
    return v === null || v === undefined ? isNull(coluna) : eq(coluna, v);
  });
  const [achado] = await (tx as any).select().from(tabela).where(and(...condicoes)).limit(1);
  if (achado) return achado;
  const [criado] = await (tx as any)
    .insert(tabela)
    .values({ ...chaves, ...valores })
    .returning();
  return criado;
}

// =====================================================================
export async function semear_rbac(tx: Executor): Promise<void> {
  for (const [codigo, descricao] of Object.entries(PERMISSOES)) {
    const p = await _obter_ou_criar(
      tx,
      permissao,
      { codigo },
      { descricao, modulo: modulo_da_permissao(codigo) },
    );
    // descrição e módulo também são reconferidos em quem já existe: passam a ser
    // propriedade do código. Perfil e atribuição continuam intocados.
    if (p.descricao !== descricao || p.modulo !== modulo_da_permissao(codigo)) {
      await tx
        .update(permissao)
        .set({ descricao, modulo: modulo_da_permissao(codigo) })
        .where(eq(permissao.id, p.id));
    }
  }
  const permissoes = new Map((await tx.select().from(permissao)).map((p) => [p.codigo, p]));

  for (const [codigo, dados] of Object.entries(MATRIZ_PERFIS)) {
    const pf = await _obter_ou_criar(
      tx,
      perfil,
      { codigo },
      { nome: dados.nome, base_normativa: dados.base_normativa ?? null },
    );
    const atuais = new Set(
      (
        await tx
          .select({ codigo: permissao.codigo })
          .from(perfil_permissao)
          .innerJoin(permissao, eq(permissao.id, perfil_permissao.permissao_id))
          .where(eq(perfil_permissao.perfil_id, pf.id))
      ).map((l) => l.codigo),
    );
    // NUNCA remove permissão de perfil — só acrescenta o que falta (ver rbac.ts)
    for (const cod of dados.permissoes) {
      if (!atuais.has(cod)) {
        await tx.insert(perfil_permissao).values({ perfil_id: pf.id, permissao_id: permissoes.get(cod)!.id });
        atuais.add(cod);
      }
    }
  }
}

export async function semear_organizacao(
  tx: Executor,
): Promise<{ campus: Record<string, Linha>; uorg: Record<string, Linha> }> {
  const campi: Record<string, [string, string, boolean]> = {
    DIA: ["Campus JK / Diamantina", "Diamantina", false],
    MUC: ["Campus do Mucuri", "Teófilo Otoni", false],
    // avançados: default assumido, confirmar com o Fabrício (PENDENCIAS.md)
    JAN: ["Campus Avançado de Janaúba", "Janaúba", true],
    UNA: ["Campus Avançado de Unaí", "Unaí", true],
  };
  const objetos_campus: Record<string, Linha> = {};
  for (const [sigla, [nome, cidade, avancado]] of Object.entries(campi)) {
    objetos_campus[sigla] = await _obter_ou_criar(tx, campus, { sigla }, { nome, cidade, uf: "MG", avancado });
  }

  // (codigo, sigla, nome_oficial, nome_extenso, tipo, campus, emite_portaria, pai)
  const unidades: [string | null, string, string, string, string, string, boolean, string | null][] = [
    ["250", "FAMED", "FACULDADE DE MEDICINA DE DIAMANTINA", "Faculdade de Medicina de Diamantina", "FACULDADE", "DIA", true, null],
    ["259", "FAMMUC", "FACULDADE DE MEDICINA DO MUCURI", "Faculdade de Medicina do Mucuri", "FACULDADE", "MUC", true, null],
    ["260", "IECT", "INSTITUTO DE ENG., CIENCIA E TECNOLOGIA", "Instituto de Engenharia, Ciência e Tecnologia (IECT)", "INSTITUTO", "MUC", true, null],
    ["261", "ICA", "INSTITUTO DE CIENCIAS AGRARIAS", "Instituto de Ciências Agrárias", "INSTITUTO", "UNA", true, null],
    // códigos UORG de FCBS e FCA pendentes de confirmação (PENDENCIAS.md)
    [null, "FCBS", "FACULDADE DE CIENCIAS BIOLOGICAS E DA SAUDE", "Faculdade de Ciências Biológicas e da Saúde", "FACULDADE", "DIA", true, null],
    [null, "FCA", "FACULDADE DE CIENCIAS AGRARIAS", "Faculdade de Ciências Agrárias", "FACULDADE", "DIA", true, null],
    ["234", "DZO", "DEPARTAMENTO DE ZOOTECNIA", "Departamento de Zootecnia", "DEPARTAMENTO", "DIA", false, "FCA"],
    ["243", "DODO", "DEPARTAMENTO DE ODONTOLOGIA", "Departamento de Odontologia", "DEPARTAMENTO", "DIA", false, "FCBS"],
    [null, "PROGEP", "PRO-REITORIA DE GESTAO DE PESSOAS", "Pró-Reitoria de Gestão de Pessoas", "PRO_REITORIA", "DIA", false, null],
    [null, "Sisa", "SUPERINTENDENCIA INTEGRADA DE SAUDE", "Superintendência Integrada de Saúde", "SUPERINTENDENCIA", "DIA", false, null],
    [null, "CSSO", "COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL", "Coordenadoria de Segurança e Saúde Ocupacional", "COORDENADORIA", "DIA", false, "Sisa"],
    [null, "SecSisa", "SECRETARIA DA SISA", "Secretaria da Sisa", "SECRETARIA", "DIA", false, "Sisa"],
    [null, "CSQV", "COORDENADORIA DE SAUDE E QUALIDADE DE VIDA", "Coordenadoria de Saúde e Qualidade de Vida", "COORDENADORIA", "DIA", false, "Sisa"],
    [null, "CPOS", "COORDENADORIA DE PERICIA OFICIAL EM SAUDE", "Coordenadoria de Perícia Oficial em Saúde", "COORDENADORIA", "DIA", false, "Sisa"],
    [null, "CPEL", "COORDENADORIA DE PROMOCAO E EDUCACAO EM SAUDE", "Coordenadoria de Promoção e Educação em Saúde", "COORDENADORIA", "DIA", false, "Sisa"],
  ];
  const objetos_uorg: Record<string, Linha> = {};
  for (const [codigo, sigla, oficial, extenso, tipo, cp, emite] of unidades) {
    const chave: Record<string, unknown> = codigo ? { codigo_uorg: codigo } : { nome_oficial: oficial };
    const valores: Record<string, unknown> = {
      sigla,
      nome_oficial: oficial,
      nome_extenso: extenso,
      tipo,
      campus_id: objetos_campus[cp]!.id,
      emite_portaria: emite,
    };
    for (const k of Object.keys(chave)) delete valores[k];
    objetos_uorg[sigla] = await _obter_ou_criar(tx, unidade_uorg, chave, valores);
  }
  for (const [, sigla, , , , , , pai] of unidades) {
    if (pai) {
      const unidade_pai_id = objetos_uorg[pai]!.id;
      await tx.update(unidade_uorg).set({ unidade_pai_id }).where(eq(unidade_uorg.id, objetos_uorg[sigla]!.id));
      objetos_uorg[sigla]!.unidade_pai_id = unidade_pai_id;
    }
  }

  // postos - caixa exatamente como no documento de origem
  const postos: [string, string, string | null][] = [
    ["DODO", "Central de Esterilização de Materiais (CME)", "CME"],
    ["FAMMUC", "Laboratório de Agentes Patológicos (LAP)", "LAP"],
    ["IECT", "Laboratório de Química", null],
    ["ICA", "Laboratório de Química", null],
    ["DZO", "Laboratório de Aquicultura, Ecologia Aquática e Limnologia", null],
    ["FAMED", "Laboratório Escola de análises Clínicas (LEAC)", "LEAC"],
    ["FAMED", "Laboratório de Doenças Infecciosas e Parasitárias", null],
  ];
  for (const [sigla, nome, sigla_posto] of postos) {
    await _obter_ou_criar(
      tx,
      posto_trabalho,
      { unidade_uorg_id: objetos_uorg[sigla]!.id, nome },
      { sigla: sigla_posto },
    );
  }

  for (const nome of ["TECNICO DE LABORATORIO AREA", "Técnica de Laboratório / Zootecnia"]) {
    await _obter_ou_criar(tx, cargo, { nome });
  }
  return { campus: objetos_campus, uorg: objetos_uorg };
}

export async function semear_dominios(
  tx: Executor,
): Promise<{ risco: Record<string, Linha>; adicional: Record<string, Linha>; fundamentacao: Record<string, Linha> }> {
  const riscos: Record<string, string> = {
    BIOLOGICO: "Agente Biológico",
    QUIMICO: "Agente Químico",
    FISICO: "Agente Físico",
    ASSOCIACAO: "Associação de Agentes",
  };
  const objetos_risco: Record<string, Linha> = {};
  for (const [c, n] of Object.entries(riscos)) {
    objetos_risco[c] = await _obter_ou_criar(tx, tipo_risco, { codigo: c }, { nome: n });
  }

  const base_nao_acumula = "IN 15/2022, art. 4º — não acumulam entre si; caráter transitório.";
  const adicionais: [string, string, string, string, boolean][] = [
    ["INSALUBRIDADE", "Adicional de Insalubridade", "adicional de insalubridade", `Lei 8.270/91, art. 12, I e §3º. ${base_nao_acumula}`, true],
    ["PERICULOSIDADE", "Adicional de Periculosidade", "adicional de periculosidade", `Lei 8.270/91, art. 12, II. ${base_nao_acumula}`, false],
    ["IRRADIACAO_IONIZANTE", "Adicional de Irradiação Ionizante", "adicional de irradiação ionizante", `Lei 8.270/91, art. 12, §1º. ${base_nao_acumula}`, false],
    ["RAIOS_X", "Gratificação por Trabalhos com Raios X", "gratificação por trabalhos com raios X", `Lei 8.270/91, art. 12, §2º. ${base_nao_acumula}`, false],
  ];
  const objetos_adicional: Record<string, Linha> = {};
  for (const [c, n, nr, bl, ativo] of adicionais) {
    objetos_adicional[c] = await _obter_ou_criar(
      tx,
      tipo_adicional,
      { codigo: c },
      { nome: n, nome_recomendacao: nr, base_legal: bl, ativo },
    );
  }

  const percentuais: [string, string, string, string][] = [
    ["INSALUBRIDADE", "MINIMO", "Mínimo (5%)", "5.00"],
    ["INSALUBRIDADE", "MEDIO", "Médio (10%)", "10.00"],
    ["INSALUBRIDADE", "MAXIMO", "Máximo (20%)", "20.00"],
    ["IRRADIACAO_IONIZANTE", "MINIMO", "Mínimo (5%)", "5.00"],
    ["IRRADIACAO_IONIZANTE", "MEDIO", "Médio (10%)", "10.00"],
    ["IRRADIACAO_IONIZANTE", "MAXIMO", "Máximo (20%)", "20.00"],
    ["PERICULOSIDADE", "UNICO", "10%", "10.00"],
    ["RAIOS_X", "UNICO", "10%", "10.00"],
  ];
  for (const [cod_adicional, grau, rotulo, valor] of percentuais) {
    await _obter_ou_criar(
      tx,
      percentual_aplicavel,
      { tipo_adicional_id: objetos_adicional[cod_adicional]!.id, grau },
      // numeric em modo texto: o Decimal do Python, sem passar por float
      { rotulo, valor, base_calculo: "vencimento do cargo efetivo" },
    );
  }

  const movimentos: [string, string, boolean][] = [
    ["CONCESSAO", "concessão", true],
    ["REVISAO", "revisão", true],
    ["REDUCAO", "redução", true],
    ["CANCELAMENTO", "cancelamento", false],
    ["REAVALIACAO", "reavaliação", true],
  ];
  for (const [codigo, nome, gera] of movimentos) {
    await _obter_ou_criar(tx, tipo_movimento, { codigo }, { nome, gera_direito: gera });
  }

  const fundamentos: Record<string, Linha> = {
    NR15_AX14_INFECTO: await _obter_ou_criar(
      tx,
      fundamentacao_legal,
      { codigo: "NR15_AX14_INFECTO" },
      { norma: "NR-15", anexo: "Anexo 14", tipo_risco_id: objetos_risco.BIOLOGICO!.id, texto: TEXTO_NR15_AX14 },
    ),
    NR15_AX13_ACIDOS_ALCALIS: await _obter_ou_criar(
      tx,
      fundamentacao_legal,
      { codigo: "NR15_AX13_ACIDOS_ALCALIS" },
      { norma: "NR-15", anexo: "Anexo 13", tipo_risco_id: objetos_risco.QUIMICO!.id, texto: TEXTO_NR15_AX13 },
    ),
  };

  const [medio_insalubridade] = await tx
    .select()
    .from(percentual_aplicavel)
    .where(
      and(
        eq(percentual_aplicavel.tipo_adicional_id, objetos_adicional.INSALUBRIDADE!.id),
        eq(percentual_aplicavel.grau, "MEDIO"),
      ),
    );

  await _obter_ou_criar(
    tx,
    agente_nocivo,
    { descricao: "Contato permanente com material infecto-contagiante" },
    {
      tipo_risco_id: objetos_risco.BIOLOGICO!.id,
      fundamentacao_id: fundamentos.NR15_AX14_INFECTO!.id,
      percentual_sugerido_id: medio_insalubridade!.id,
      exige_reavaliacao_quantitativa: false,
    },
  );
  const canonico_quim = await _obter_ou_criar(
    tx,
    agente_nocivo,
    { descricao: "Manipulação de produtos químicos" },
    {
      tipo_risco_id: objetos_risco.QUIMICO!.id,
      fundamentacao_id: fundamentos.NR15_AX13_ACIDOS_ALCALIS!.id,
      percentual_sugerido_id: medio_insalubridade!.id,
      exige_reavaliacao_quantitativa: true,
    },
  );
  // sinônimo -> canônico (de-para que ALTERA SEMÂNTICA: exige aprovação do Fabrício)
  await _obter_ou_criar(
    tx,
    agente_nocivo,
    { descricao: "Manuseio de substâncias químicas" },
    {
      tipo_risco_id: objetos_risco.QUIMICO!.id,
      fundamentacao_id: fundamentos.NR15_AX13_ACIDOS_ALCALIS!.id,
      percentual_sugerido_id: medio_insalubridade!.id,
      exige_reavaliacao_quantitativa: true,
      agente_canonico_id: canonico_quim.id,
    },
  );

  const marcos: [string, string, string | null][] = [
    ["PORTARIA_LOCALIZACAO", "data da Portaria de Localização", "IN 15/2022, art. 13 e parágrafo único"],
    ["PORTARIA_CONCESSAO", "data da Portaria de Concessão", "IN 15/2022, art. 13"],
    ["SOLICITACAO_SEST", "data da solicitação", null],
    ["INICIO_EXERCICIO", "data de início do exercício no posto", null],
  ];
  for (const [codigo, rotulo, base] of marcos) {
    await _obter_ou_criar(tx, tipo_marco_inicial, { codigo }, { rotulo, base_legal: base });
  }

  const tipos_processo: [string, string, string][] = [
    ["ADICIONAL_OCUPACIONAL", "Adicional Ocupacional", "#F2D600"],
    ["APOSENTADORIA_ESPECIAL", "Aposentadoria Especial", "#0079BF"],
    ["PARECER_TECNICO", "Parecer Técnico", "#EB5A46"],
    ["PGR", "PGR", "#61BD4F"],
    ["RITS", "RITS", "#C377E0"],
    ["ACIDENTE", "Acidente em Serviço", "#FF9F1A"],
    ["PGD", "PGD", "#00C2E0"],
    ["REVEZAMENTO", "Revezamento", "#51E898"],
    ["CONSULTA_NORMATIVA", "Consulta Normativa", "#B3BAC5"],
  ];
  for (const [codigo, nome, cor] of tipos_processo) {
    await _obter_ou_criar(tx, tipo_processo, { codigo }, { nome, cor_hex: cor });
  }

  const etapas: [number, string, string, string, boolean][] = [
    [1, "NAO_INICIADO", "Não Iniciado", "FLUXO", false],
    [2, "A_FAZER", "A fazer", "FLUXO", false],
    [3, "EM_ANDAMENTO", "Em andamento", "FLUXO", false],
    [4, "AGUARDANDO", "Aguardando", "FLUXO", false],
    [5, "CONCLUIDO", "Concluído", "FLUXO", true],
    [6, "BACKLOG_ADICIONAL", "Repositório Adicional Ocupacional", "REPOSITORIO", false],
    [7, "BACKLOG_CAMPI_AVANCADOS", "Repositório Campi Avançados", "REPOSITORIO", false],
    [8, "ARQUIVO_APOSENTADORIA", "Arquivo Aposentadoria Especial", "REPOSITORIO", true],
  ];
  for (const [ordem, codigo, nome, tipo, terminal] of etapas) {
    await _obter_ou_criar(tx, fluxo_etapa, { codigo }, { nome, ordem, tipo, terminal });
  }
  return { risco: objetos_risco, adicional: objetos_adicional, fundamentacao: fundamentos };
}

export async function semear_textos(tx: Executor): Promise<void> {
  const textos: [string, string, boolean, string][] = [
    [
      "ALTERACAO",
      "COMUNICAR_SEST",
      true,
      "Qualquer alteração na execução das atividades técnicas do servidor, bem como " +
        "mudanças em sua carga horária, deverá ser comunicada ao " +
        "{{sigla_unidade_emissora}}.",
    ],
    [
      "REAVALIACAO",
      "QUIMICO_QUANTITATIVA",
      true,
      "Os agentes químicos devem ser avaliados quantitativamente para fins de " +
        "prevenção e controle do risco. Após a realização da avaliação quantitativa " +
        "dos agentes químicos um novo laudo deverá ser elaborado.",
    ],
    [
      "RECOMENDACAO",
      "RECONHECER_DIREITO_PORTARIA_V1",
      true,
      "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela " +
        "exposição ao {{tipo_risco}}, a partir da data da Portaria de Localização: " +
        "{{data_marco_extenso_capitalizado}}",
    ],
    [
      "RECOMENDACAO",
      "RECONHECER_DIREITO_PORTARIA_V2",
      true,
      "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela " +
        "exposição ao {{tipo_risco}}, a partir da portaria de localização " +
        "{{data_marco_extenso}}",
    ],
    [
      "RECOMENDACAO",
      "RECONHECER_DIREITO_SOLICITACAO",
      true,
      "Reconhecer o direito ao {{tipo_adicional_recomendacao}} caracterizado pela " +
        "exposição ao {{tipo_risco}}, a partir da data da solicitação " +
        "{{data_marco_numerica}}",
    ],
    // ATENÇÃO: o rodapé cita o art. 17 para o "Formulário", mas o art. 17 da IN
    // 15/2022 trata da responsabilização de peritos e dirigentes. Não corrigir
    // sozinho - texto guardado literal e sinalizado em PENDENCIAS.md.
    [
      "RODAPE_RESPONSABILIDADE",
      "FORMULARIO_ART17",
      true,
      "*É de responsabilidade do servidor e suas chefias (conforme Art. 17 da IN " +
        "15/2022) as informações documentadas no “Formulário” que registra o tipo de " +
        "trabalho e o tempo de exposição ao risco.",
    ],
    // Somente leitura: parágrafos estáticos do .docx, nunca alimentam o render.
    [
      "PREAMBULO",
      "ENCAMINHAMENTO",
      false,
      "Encaminhamos, para ciência e devidas providências, o parecer técnico " +
        "referente à solicitação de {{laudo_de}} do adicional ocupacional.",
    ],
    ["ASSUNTO", "PADRAO", false, "Processo de adicional ocupacional"],
    [
      "ENCERRAMENTO",
      "TENDO_EM_VISTA",
      false,
      "Tendo em vista os documentos constantes no presente processo, emitimos o " + "seguinte parecer:",
    ],
  ];
  for (const [categoria, codigo, renderizado, template] of textos) {
    await _obter_ou_criar(
      tx,
      texto_padrao,
      { categoria, codigo, versao: 1 },
      { template, renderizado_pelo_modelo: renderizado },
    );
  }
}

export async function semear_emissores(tx: Executor): Promise<void> {
  await _obter_ou_criar(
    tx,
    autoridade_destinataria,
    { nome: "MARINA FERREIRA DA COSTA" },
    {
      cargo: "Pró-reitora de Gestão de Pessoas",
      tratamento: "A sua senhoria, a senhora:",
      vigencia_inicio: "2025-01-01",
    },
  );
  // Três vigências, extraídas dos pareceres assinados (ver PENDENCIAS.md):
  //  * até 2025: "Serviço Especializado em Segurança do Trabalho" (parecer 1/2025);
  //  * em 2026, mesma sigla, "Seção de Segurança do Trabalho" (1, 2 e 8/2026);
  //  * a partir de 19/06/2026, CSSO/Sisa (Resolução Consu 11/2026).
  const comum = {
    unidade_sei: "csso.sisa",
    email: "csso.sisa@ufvjm.edu.br",
    endereco: ENDERECO_UFVJM,
    telefone: TELEFONE_UFVJM,
    cidade: "Diamantina",
  };
  await _obter_ou_criar(
    tx,
    setor_emissor,
    { sigla_composta: "SEST/DASA/PROGEP", vigencia_inicio: "2019-01-01" },
    { ...comum, nome_extenso: "Serviço Especializado em Segurança do Trabalho", vigencia_fim: "2025-12-31" },
  );
  await _obter_ou_criar(
    tx,
    setor_emissor,
    { sigla_composta: "SEST/DASA/PROGEP", vigencia_inicio: "2026-01-01" },
    { ...comum, nome_extenso: "Seção de Segurança do Trabalho", vigencia_fim: "2026-06-18" },
  );
  await _obter_ou_criar(
    tx,
    setor_emissor,
    { sigla_composta: "CSSO/Sisa", vigencia_inicio: "2026-06-19" },
    {
      ...comum,
      nome_extenso: "Coordenadoria de Segurança e Saúde Ocupacional",
      base_normativa: "Resolução Consu UFVJM nº 11/2026",
    },
  );
  // IN 15/2022, art. 10, §2, I. Fátima (técnica de segurança do trabalho) NÃO
  // entra nesta tabela: a habilitação exigida é médico do trabalho, engenheiro
  // ou arquiteto de segurança do trabalho. Isso não é opinião - é a lei.
  await _obter_ou_criar(
    tx,
    profissional_habilitado,
    { nome: "Fabrício Raimundi Andrade" },
    {
      siape: "2165804",
      habilitacao: "ENG_SEG_TRABALHO",
      titulo_assinatura: "Eng. Seg. do Trabalho",
      vigencia_inicio: "2019-01-01",
    },
  );
}

/**
 * Catálogos semeados do módulo de EPI: a taxonomia da NR-6 e as recusas.
 * A categoria é semeada porque no legado era texto livre em quatro grafias; o
 * motivo de recusa, porque texto livre não se conta.
 */
export async function semear_epi(tx: Executor): Promise<void> {
  // (codigo, nome, letra do Anexo I da NR-6)
  const categorias: [string, string, string][] = [
    ["PROT_CABECA", "Proteção da cabeça", "A"],
    ["PROT_OLHOS_FACE", "Proteção dos olhos e face", "B"],
    ["PROT_AUDITIVA", "Proteção auditiva", "C"],
    ["PROT_RESPIRATORIA", "Proteção respiratória", "D"],
    ["PROT_TRONCO", "Proteção do tronco", "E"],
    ["PROT_MEMBROS_SUPERIORES", "Proteção dos membros superiores", "F"],
    ["PROT_MEMBROS_INFERIORES", "Proteção dos membros inferiores", "G"],
    ["PROT_CORPO_INTEIRO", "Proteção do corpo inteiro", "H"],
    ["PROT_QUEDAS_DESNIVEL", "Proteção contra quedas com diferença de nível", "I"],
  ];
  let ordem = 1;
  for (const [codigo, nome, letra] of categorias) {
    await _obter_ou_criar(tx, epi_categoria, { codigo }, { nome, referencia_nr6: letra, ordem });
    ordem += 1;
  }

  // (codigo, rotulo, base normativa, exige complemento, texto)
  const motivos: [string, string, string | null, boolean, string][] = [
    ["VINCULO_NAO_ATENDIDO", "Vínculo não atendido", "NR-6", false, TEXTO_RECUSA_VINCULO],
    [
      "SEM_EXPOSICAO",
      "Sem exposição ao risco",
      null,
      false,
      "A atividade descrita não expõe ao risco contra o qual o equipamento " +
        "protege. O fornecimento pressupõe exposição identificada no posto de " +
        "trabalho; havendo alteração na atividade, o pedido pode ser " +
        "reapresentado com a descrição atualizada.",
    ],
    [
      "EPI_INADEQUADO",
      "EPI inadequado ao risco",
      "NR-6",
      false,
      "O equipamento solicitado não protege contra o risco declarado. Nos " +
        "termos da NR-6, o EPI fornecido deve ser adequado ao risco a que a " +
        "pessoa está exposta; o equipamento adequado é indicado na análise.",
    ],
    [
      "SEM_TREINAMENTO",
      "Treinamento não comprovado",
      "NR-6, NR-35",
      false,
      "O uso do equipamento solicitado depende de treinamento cuja " +
        "realização não foi comprovada. O fornecimento fica condicionado à " +
        "capacitação; comprovado o treinamento, o pedido pode ser " +
        "reapresentado.",
    ],
    [
      "DENTRO_DA_VIDA_UTIL",
      "Dentro da vida útil",
      null,
      false,
      "O equipamento já foi entregue e ainda está dentro da vida útil " +
        "registrada na ficha de EPI, sem devolução do anterior nem " +
        "justificativa de dano, perda ou desgaste prematuro.",
    ],
    [
      "ACIMA_DO_MAXIMO",
      "Acima da quantidade máxima",
      null,
      false,
      "A quantidade solicitada excede o máximo previsto para o item no " +
        "período, e a exceção não foi autorizada. A exceção é possível, exige " +
        "justificativa e fica registrada em nome de quem a autoriza.",
    ],
    [
      "COMPETENCIA_DE_ENSINO",
      "Competência do curso ou departamento",
      null,
      false,
      "O equipamento destina-se a atividade de ensino. Nesse caso o " +
        "fornecimento é do curso ou do departamento responsável pela " +
        "atividade.",
    ],
    // o único que exige complemento: sem ele a negativa não diz nada
    ["OUTRO", "Outro motivo", null, true, "Pedido indeferido pelo motivo descrito a seguir."],
  ];
  for (const [codigo, rotulo, base, complemento, texto] of motivos) {
    await _obter_ou_criar(
      tx,
      epi_motivo_recusa,
      { codigo },
      { rotulo, texto, base_normativa: base, exige_complemento: complemento },
    );
  }
}

/** Tudo, na ordem do Python. Quem chama dá o COMMIT (ver o cabeçalho). */
export async function semear(tx: Executor): Promise<void> {
  await semear_rbac(tx);
  await semear_organizacao(tx);
  await semear_dominios(tx);
  await semear_textos(tx);
  await semear_emissores(tx);
  await semear_epi(tx);
}
