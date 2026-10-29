/**
 * O motor da limpeza de dados de teste (24/10/2026) — o de
 * `ferramentas/limpar-treinamentos.ts` (23/10/2026), generalizado para os
 * módulos e para as contas. Quem usa: a tela `/config/limpar-dados` (só o
 * Administrador do sistema, com backup antes) e a própria ferramenta de linha
 * de comando (o módulo de treinamentos, com cópia local).
 *
 * Um PLANO diz o que sai e o que fica:
 *
 * - `apagar`: tabelas esvaziadas por inteiro;
 * - `parciais`: tabelas de que só uma parte sai — a linha sai se uma condição
 *   de `onde` vale, ou se a coluna de `seguir` aponta para linha que sai (e não
 *   sai se uma de `exceto` vale). `anexo` e `pendencia` ganham sozinhos a
 *   âncora (`entidade`/`entidade_id`) de tudo o que sai; `anexo` ganha também
 *   o arquivo apontado por chave estrangeira de linha que sai, e perde o que
 *   uma linha que FICA ainda aponta;
 * - `desvincular`: `tabela.coluna` de linha que fica, zerada quando o alvo sai;
 * - `travas`: os gatilhos de DELETE do próprio módulo (a "prova" que não se
 *   apaga pela aplicação: a CAT/SP, a ficha de EPI, o encaminhamento) que são
 *   SUSPENSOS dentro da transação, pelo nome, e religados antes do commit. A
 *   trava da trilha (`historico_evento`) e a da marca de produção
 *   (`instalacao`) nunca entram — `TABELAS_INTOCAVEIS`.
 *
 * Como roda, sempre numa transação de quem chama, nesta ordem:
 *
 * 1. trava (ACCESS EXCLUSIVE) tudo o que o plano toca;
 * 2. lê do catálogo do Postgres as chaves estrangeiras e confere: nenhuma linha
 *    que FICA aponta para linha que SAI sem estar declarada; nenhum gatilho de
 *    DELETE fora de `travas`; as listas existem. Problema = nada é gravado;
 * 3. fixa, ANTES de mexer em qualquer coisa, os ids de cada tabela parcial;
 * 4. (`antes_de_apagar`: a cópia local da ferramenta, o backup da tela);
 * 5. suspende as travas do módulo, desvincula, apaga por DELETE na ordem
 *    topológica (filhos antes dos pais; nunca TRUNCATE ... CASCADE), religa as
 *    travas e confere que estão ligadas;
 * 6. registra UM evento na trilha pela via oficial (`auditoria.registrar`),
 *    só com contagens;
 * 7. confere: o que devia zerar zerou, o que devia ficar ficou (contagem de
 *    toda tabela que o plano não toca, menos as que mudam sozinhas).
 *
 * `simular` faz tudo isso e lança `Simulado` no fim, para o ROLLBACK.
 * Os arquivos órfãos do armazenamento (`apagar_orfaos`) saem só DEPOIS do commit.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import * as auditoria from "./auditoria.js";
import * as ativar_acesso from "./ativar_acesso.js";
import * as pedido_conta from "./pedido_conta.js";
import * as aviso_cadastro from "./aviso_cadastro_existente.js";
import * as aviso_reciclagem from "./aviso_reciclagem.js";
import * as avaliacao_reacao from "./avaliacao_reacao.js";
import * as avisos_inscricao from "./avisos_inscricao.js";
import * as acesso_participante from "./acesso_participante.js";
import * as envio_certificado from "./envio_certificado.js";
import * as epi_email from "./epi_email.js";
import * as acidente_email from "./acidente_email.js";
import * as governanca from "./governanca.js";
import { TOPO_DA_HIERARQUIA, type UsuarioAtual } from "./rbac.js";

// =====================================================================
// O plano
// =====================================================================
export interface Parcial {
  /** condições SQL (OU); `{ids:tabela}` e `{c:nome}` viram a lista fixada */
  onde?: readonly string[];
  /** colunas de chave estrangeira: a linha sai quando o alvo dela sai */
  seguir?: readonly string[];
  /** condições SQL (OU) que seguram a linha, mesmo marcada */
  exceto?: readonly string[];
}

/** Arquivos gerados (não anexo) que ficam órfãos: chaves e listagens por prefixo. */
export interface ArquivosOrfaos {
  chaves: string[];
  /** apaga, em `prefixo`, o arquivo cujo nome começa por um de `inicios` */
  listagens: { prefixo: string; inicios: string[] }[];
}

export interface Plano {
  /** os códigos dos módulos (e `contas`), para a trilha e a tela */
  modulos: readonly string[];
  apagar: readonly string[];
  parciais: Readonly<Record<string, Parcial>>;
  desvincular: readonly string[];
  travas: readonly string[];
  /** os arquivos gerados que saem com o plano (lidos antes de apagar) */
  arquivos: readonly ((tx: Executor) => Promise<ArquivosOrfaos>)[];
  /** listas fixadas DEPOIS da trava e antes de tudo (`{c:nome}`) */
  conjuntos?: (tx: Executor) => Promise<Record<string, number[]>>;
  /** conferência a mais, no fim (a governança, na limpeza de contas) */
  conferir_depois?: (tx: Executor) => Promise<string[]>;
}

/** Nem a limpeza passa pela trava destas: a trilha e a marca de produção. */
export const TABELAS_INTOCAVEIS: readonly string[] = ["historico_evento", "instalacao"];

/**
 * Tabelas que mudam sozinhas enquanto a limpeza roda (login, registro de
 * acesso, rotina, link público, fila de e-mail) e que o plano não trava: ficam
 * fora da conferência "o que fica, ficou" — senão um login no meio desfaria a
 * limpeza à toa. A trilha é conferida à parte (ganha exatamente os eventos da
 * limpeza e do backup).
 */
export const TABELAS_VOLATEIS: readonly string[] = [
  "historico_evento",
  "sessao",
  "registro_acesso",
  "limite_login_ip",
  "rotina_execucao",
  "conferencia_cadeia",
  "ativacao_acesso",
  "pedido_conta",
  "acesso_participante",
  "acesso_dado_sensivel",
  "email_saida",
];

// =====================================================================
// Os módulos
// =====================================================================
export type CodigoModulo = "treinamentos" | "acidentes" | "ocorrencias" | "epi" | "processos";
export const CODIGOS_MODULO: readonly CodigoModulo[] = ["treinamentos", "acidentes", "ocorrencias", "epi", "processos"];
export const CONTAS = "contas";

export interface ModuloLimpeza {
  codigo: CodigoModulo;
  nome: string;
  /** o que sai e o que fica, em português de tela */
  apaga: string;
  mantem: string;
  apagar: readonly string[];
  tipos_email: readonly string[];
  tipos_pendencia?: readonly string[];
  desvincular: readonly string[];
  travas: readonly string[];
  parciais?: Readonly<Record<string, Parcial>>;
  arquivos?: (tx: Executor) => Promise<ArquivosOrfaos>;
}

type Linhas = Record<string, unknown>[];

async function consultar(tx: Executor, consulta: string): Promise<Linhas> {
  return (await tx.execute(sql.raw(consulta))) as unknown as Linhas;
}

/** Nome de tabela ou coluna: só o que o esquema usa (nada vem de formulário, mas confere). */
function ident(nome: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) throw new Error(`identificador inesperado: ${nome}`);
  return `"${nome}"`;
}

const lista_texto = (itens: readonly string[]) => itens.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");

/** `IN (...)` de inteiros que funciona vazio (o `NOT IN (NULL)` não apagaria nada). */
export function em(ids: readonly number[]): string {
  return `(SELECT unnest('{${ids.map((i) => Math.trunc(Number(i))).join(",")}}'::bigint[]))`;
}

async function arquivos_de_treinamento(tx: Executor): Promise<ArquivosOrfaos> {
  const { caminho_saida } = await import("./lista_presenca.js");
  const chaves: string[] = [];
  const certs = await consultar(tx, `SELECT id, arquivo_docx FROM public.certificado`);
  for (const c of certs) if (c.arquivo_docx) chaves.push(String(c.arquivo_docx));
  for (const t of await consultar(tx, `SELECT ano, codigo FROM public.turma`)) {
    chaves.push(caminho_saida({ ano: Number(t.ano), codigo: String(t.codigo) }));
  }
  // PDFs em cache: `certificados-pdf/<id>-<resumo>.pdf`
  const inicios = certs.map((c) => `${Number(c.id)}-`);
  return { chaves, listagens: inicios.length ? [{ prefixo: "certificados-pdf", inicios }] : [] };
}

async function arquivos_de_epi(tx: Executor): Promise<ArquivosOrfaos> {
  const { caminho_saida } = await import("./comprovante_epi.js");
  const linhas = await consultar(tx, `SELECT id, data_evento FROM public.epi_ficha_registro`);
  return {
    chaves: linhas.map((l) => caminho_saida(Number(l.id), Number(String(l.data_evento).slice(0, 4)))),
    listagens: [],
  };
}

async function arquivos_de_processos(tx: Executor): Promise<ArquivosOrfaos> {
  // o .docx do parecer: `documentos/<ano>/Parecer_Tecnico_<NN>-<ano>_<sigla>[_<servidor>].docx`
  const linhas = await consultar(tx, `SELECT numero, ano FROM public.parecer_tecnico WHERE numero IS NOT NULL`);
  const por_ano = new Map<number, string[]>();
  for (const l of linhas) {
    const ano = Number(l.ano);
    const inicio = `Parecer_Tecnico_${String(Number(l.numero)).padStart(2, "0")}-${ano}_`;
    por_ano.set(ano, [...(por_ano.get(ano) ?? []), inicio]);
  }
  return { chaves: [], listagens: [...por_ano].map(([ano, inicios]) => ({ prefixo: `documentos/${ano}`, inicios })) };
}

/**
 * A numeração de cada módulo (`servicos/numeracao.ts`). Apagar a linha do ano
 * faz o próximo número ser o 1: depois da limpeza dos testes os protocolos
 * recomeçam (decisão de 25/10/2026). Quem quer manter passa as tabelas em
 * `manter` — a ferramenta de linha de comando faz isso.
 */
export const NUMERACAO: Readonly<Record<CodigoModulo, readonly string[]>> = {
  treinamentos: ["turma_sequencia", "certificado_sequencia", "certificado_sequencia_prefixo"],
  acidentes: ["acidente_cat_sp_sequencia"],
  ocorrencias: ["ocorrencia_sequencia"],
  epi: ["epi_requisicao_sequencia"],
  processos: ["parecer_sequencia"],
};

export const MODULOS: Readonly<Record<CodigoModulo, ModuloLimpeza>> = {
  treinamentos: {
    codigo: "treinamentos",
    nome: "Treinamentos e certificados",
    apaga:
      "treinamentos, turmas, inscrições, presenças, certificados emitidos, participantes (e e-mails, juntados e " +
      "pares), instrutores e as qualificações deles, locais de treinamento, avaliação de reação, o vínculo EPI × " +
      "treinamento, os links de acesso do participante, e os anexos, pendências e e-mails do módulo",
    mantem: "os modelos de certificado (perdem só o vínculo com o treinamento). A numeração das turmas e dos certificados volta a zero",
    apagar: [
      "treinamento",
      "turma",
      "turma_instrutor",
      "turma_ajudante",
      "turma_presenca",
      "aviso_cadastro",
      "inscricao",
      "participante",
      "participante_email",
      "participante_mesclagem",
      "participante_par_distinto",
      "certificado",
      "certificado_valor_turma",
      "certificado_valor_inscricao",
      "assinatura_instrutor",
      "instrutor_qualificacao",
      "acesso_participante",
      "epi_item_treinamento",
      "avaliacao_reacao_convite",
      "avaliacao_reacao_resposta",
      "local_treinamento",
      // a numeração volta a zero (decisão de 25/10/2026): os arquivos com o
      // número antigo saem junto, depois do commit
      ...NUMERACAO.treinamentos,
    ],
    tipos_email: [
      envio_certificado.TIPO,
      aviso_reciclagem.TIPO,
      aviso_cadastro.TIPO_AVISO,
      aviso_cadastro.TIPO_REPETIDO,
      avaliacao_reacao.TIPO_EMAIL,
      avisos_inscricao.TIPO_ACEITA,
      avisos_inscricao.TIPO_RECUSADA,
      acesso_participante.TIPO_EMAIL,
    ],
    // o modelo fica, e passa a genérico; o acidentado fica (é do módulo de acidentes)
    desvincular: ["certificado_modelo.treinamento_id", "acidentado.participante_id"],
    travas: [],
    arquivos: arquivos_de_treinamento,
  },
  acidentes: {
    codigo: "acidentes",
    nome: "Acidentes",
    apaga:
      "as ocorrências e tudo o que pende delas: comunicação e comunicantes, envolvidos e testemunhas (com a identificação pessoal e o contato), saúde, " +
      "triagem e complementação, CAT/SP, investigação (MAPA, linha do tempo, barreiras, checklist, entrevistas, " +
      "evidências, plano de ação), relatório, encaminhamento ao SIASS, decisão pericial, os links públicos de " +
      "comunicação, e os anexos, pendências e e-mails do módulo",
    mantem: "os catálogos (parte do corpo, agente, situação, natureza da lesão). A numeração da CAT/SP volta a zero",
    apagar: [
      "acidente_ocorrencia",
      "acidentado",
      "acidente_testemunha",
      "acidente_testemunha_contato",
      "acidente_identificacao",
      "acidente_comunicante",
      "acidente_complementacao",
      "acidente_saude",
      "acidente_saude_parte",
      "acidente_cat_sp",
      "acidente_investigacao",
      "acidente_evento_linha",
      "acidente_barreira",
      "acidente_checklist_item",
      "acidente_entrevista",
      "acidente_evidencia",
      "acidente_unidade_exposicao",
      "acidente_acao",
      "acidente_relatorio",
      "acidente_encaminhamento",
      "acidente_decisao_pericial",
      "acidente_link_publico",
      ...NUMERACAO.acidentes,
    ],
    tipos_email: [acidente_email.TIPO_NOVA_SETOR, acidente_email.TIPO_CONFIRMACAO, acidente_email.TIPO_COMPLEMENTACAO],
    // a ocorrência de urgência/emergência que apontava para a CAT/SP fica, sem o vínculo
    desvincular: ["acesso_dado_sensivel.acidente_id", "acesso_dado_sensivel.acidentado_id", "ocorrencia.acidente_id"],
    travas: [
      "trg_acidente_ocorrencia_sem_delete",
      "trg_acidentado_sem_delete",
      "trg_acidente_testemunha_sem_delete",
      "trg_acidente_complementacao_sem_delete",
      "trg_acidente_saude_sem_delete",
      "trg_acidente_cat_sp_sem_delete",
      "trg_acidente_investigacao_sem_delete",
      "trg_acidente_entrevista_sem_delete",
      "trg_acidente_acao_sem_delete",
      "trg_acidente_relatorio_sem_delete",
      "trg_acidente_encaminhamento_sem_delete",
      "trg_acidente_decisao_sem_delete",
    ],
  },
  ocorrencias: {
    codigo: "ocorrencias",
    nome: "Ocorrências de urgência e emergência",
    apaga: "as ocorrências registradas e o acompanhamento da equipe",
    mantem: "o cadastro de campi. A numeração dos protocolos volta a zero",
    apagar: ["ocorrencia_acompanhamento", "ocorrencia", ...NUMERACAO.ocorrencias],
    tipos_email: [],
    desvincular: [],
    travas: [],
  },
  epi: {
    codigo: "epi",
    nome: "EPI",
    apaga:
      "as requisições e os itens delas, as fichas (entregas, devoluções, estornos), as entradas de estoque " +
      "(lotes) e os movimentos, as comunicações do titular, e os anexos (comprovantes), pendências e e-mails do módulo",
    mantem: "o catálogo de EPI (itens, categorias, motivos de recusa, foto e orientação). A numeração dos pedidos volta a zero",
    apagar: [
      "epi_requisicao",
      "epi_requisicao_item",
      "epi_ficha_registro",
      "epi_entrada_estoque",
      "epi_movimento_estoque",
      "epi_comunicacao_titular",
      ...NUMERACAO.epi,
    ],
    tipos_email: [
      epi_email.TIPO_ABERTURA_SETOR,
      epi_email.TIPO_ABERTURA_REQUERENTE,
      epi_email.TIPO_DECISAO,
      epi_email.TIPO_RETIRADA,
    ],
    desvincular: [],
    travas: ["trg_epi_ficha_sem_delete", "trg_epi_movimento_sem_delete", "trg_epi_comunicacao_sem_delete"],
    arquivos: arquivos_de_epi,
  },
  processos: {
    codigo: "processos",
    nome: "Processos e demandas",
    apaga:
      "os processos SEI (e checklists), pareceres (postos e exposições), laudos (e postos), adicionais (vigências), " +
      "demandas e encaminhamentos, e os anexos, pendências e documentos gerados deles",
    mantem:
      "os catálogos do adicional (agentes, fundamentação, percentuais, textos), setor emissor, autoridade, " +
      "profissionais habilitados, portarias de localização e as tabelas de importação. A numeração dos pareceres " +
      "volta a zero",
    apagar: [
      "processo",
      "checklist",
      "checklist_item",
      "parecer_tecnico",
      "parecer_posto",
      "exposicao",
      "adicional_vigencia",
      "laudo_tecnico",
      "laudo_posto",
      "demanda",
      "demanda_encaminhamento",
      ...NUMERACAO.processos,
    ],
    tipos_email: [],
    desvincular: ["acesso_dado_sensivel.processo_id"],
    travas: ["trg_demanda_encaminhamento_sem_delete"],
    arquivos: arquivos_de_processos,
  },
};

/** O que a caixa "Apagar também servidores e contas" diz na tela. */
export const CONTAS_TEXTO = {
  nome: "Servidores e contas",
  apaga:
    "os servidores e as contas de usuário, com as atribuições, sessões, níveis por módulo, equipes de setor, " +
    "lotações, pedidos de conta, links de ativação e registros de leitura de dado sensível delas",
  mantem:
    "a sua conta, as contas que têm (ou tiveram) o perfil Administrador do sistema ou Superintendente ou um " +
    "perfil que concede perfil, e os servidores ligados a elas. Os perfis, setores, campi e catálogos ficam sempre",
};

/**
 * As contas que a limpeza de contas NUNCA apaga: a de quem limpa, e toda conta
 * com atribuição (vigente, futura ou passada) de perfil do topo ou de perfil
 * que concede perfil — o sistema não pode ficar sem governo (`governanca.ts`).
 */
export async function contas_preservadas(tx: Executor, executor_id: number): Promise<number[]> {
  const linhas = await consultar(
    tx,
    `SELECT DISTINCT a.usuario_id AS id
       FROM public.atribuicao a JOIN public.perfil p ON p.id = a.perfil_id
      WHERE p.codigo IN (${lista_texto(TOPO_DA_HIERARQUIA)})
         OR EXISTS (SELECT 1 FROM public.perfil_permissao pp JOIN public.permissao pe ON pe.id = pp.permissao_id
                     WHERE pp.perfil_id = p.id AND pe.codigo = 'perfil.conceder')`,
  );
  return [...new Set([Math.trunc(executor_id), ...linhas.map((l) => Number(l.id))])].sort((a, b) => a - b);
}

export class PlanoInvalido extends Error {}

/**
 * Junta os módulos marcados (e as contas) num plano. `contas` exige os quatro
 * módulos: servidor e conta são citados por todos eles, e apagar a pessoa
 * deixando o processo dela não fecha.
 */
export function plano_dos_modulos(
  modulos: readonly string[],
  opcoes: { contas?: { executor_id: number } | null; manter?: readonly string[] } = {},
): Plano {
  const escolhidos = CODIGOS_MODULO.filter((c) => modulos.includes(c));
  const desconhecidos = modulos.filter((m) => !(CODIGOS_MODULO as readonly string[]).includes(m));
  if (desconhecidos.length) throw new PlanoInvalido(`módulo desconhecido: ${desconhecidos.join(", ")}`);
  if (!escolhidos.length) throw new PlanoInvalido("marque ao menos um módulo.");
  if (opcoes.contas && escolhidos.length !== CODIGOS_MODULO.length) {
    throw new PlanoInvalido(
      "«Apagar também servidores e contas» só vai junto com os quatro módulos: servidor e conta são citados por todos eles.",
    );
  }
  const manter = new Set(opcoes.manter ?? []);
  const apagar = escolhidos.flatMap((c) => MODULOS[c].apagar).filter((t) => !manter.has(t));
  const tipos_email = escolhidos.flatMap((c) => MODULOS[c].tipos_email);
  const tipos_pendencia = escolhidos.flatMap((c) => MODULOS[c].tipos_pendencia ?? []);
  const desvincular = new Set(escolhidos.flatMap((c) => MODULOS[c].desvincular));
  const travas = escolhidos.flatMap((c) => MODULOS[c].travas);
  const parciais: Record<string, Parcial> = {
    anexo: {},
    pendencia: {
      onde: tipos_pendencia.length ? [`tipo IN (${lista_texto(tipos_pendencia)})`] : [],
      seguir: ["processo_id", "parecer_id", "laudo_id"],
    },
    email_saida: {
      onde: tipos_email.length ? [`tipo IN (${lista_texto(tipos_email)})`] : [],
      seguir: ["certificado_id", "inscricao_id"],
    },
  };
  const arquivos = escolhidos.flatMap((c) => (MODULOS[c].arquivos ? [MODULOS[c].arquivos!] : []));
  const plano: Plano = {
    modulos: [...escolhidos, ...(opcoes.contas ? [CONTAS] : [])],
    apagar,
    parciais,
    desvincular: [],
    travas,
    arquivos,
  };
  if (opcoes.contas) {
    const executor = opcoes.contas.executor_id;
    const contas_email = [
      ativar_acesso.TIPO_LINK,
      ativar_acesso.TIPO_NEUTRO,
      ativar_acesso.TIPO_AVISO_ATIVADO,
      ativar_acesso.TIPO_TROCA_EMAIL,
      pedido_conta.TIPO_NEUTRO,
      pedido_conta.TIPO_RECUSA,
      pedido_conta.TIPO_CONFIRMAR,
      pedido_conta.TIPO_APROVADO,
    ];
    parciais.email_saida = { ...parciais.email_saida, onde: [...parciais.email_saida!.onde!, `tipo IN (${lista_texto(contas_email)})`] };
    parciais.pendencia = {
      ...parciais.pendencia,
      onde: [...parciais.pendencia!.onde!, `tipo IN (${lista_texto([pedido_conta.TIPO_PENDENCIA])})`],
    };
    Object.assign(parciais, {
      usuario: { onde: [`id NOT IN {c:preservadas}`] },
      servidor: {
        onde: [`id NOT IN (SELECT servidor_id FROM public.usuario WHERE servidor_id IS NOT NULL AND id IN {c:preservadas})`],
      },
      atribuicao: { seguir: ["usuario_id"] },
      sessao: { seguir: ["usuario_id"] },
      equipe_setor_promotor: { seguir: ["usuario_id"] },
      usuario_nivel_modulo: { seguir: ["usuario_id"] },
      servidor_lotacao: { seguir: ["servidor_id"] },
      lotacao_posto: { seguir: ["lotacao_id"] },
      portaria_servidor: { seguir: ["servidor_id"] },
      acesso_dado_sensivel: { seguir: ["usuario_id"] },
      // sem chave estrangeira: o link de ativar acesso da conta ou do servidor que sai
      ativacao_acesso: { onde: [`usuario_id IN {ids:usuario}`, `servidor_id IN {ids:servidor}`] },
    } satisfies Record<string, Parcial>);
    plano.apagar = [...apagar, "pedido_conta"];
    for (const d of [
      "atribuicao.concedido_por",
      "equipe_setor_promotor.vinculado_por",
      "usuario_nivel_modulo.alterado_por",
      "perfil_nivel_modulo.alterado_por",
      "certificado_modelo.criado_por",
      "conferencia_cadeia.usuario_id",
      "anexo.enviado_por",
      "email_saida.criado_por",
      "pendencia.responsavel_id",
      "pendencia.concluida_por",
      "profissional_habilitado.usuario_id",
      "profissional_habilitado.atestado_por",
      "profissional_habilitado.servidor_id",
      "servidor_lotacao.registrado_por",
      "acesso_dado_sensivel.servidor_id",
    ]) {
      desvincular.add(d);
    }
    plano.conjuntos = async (tx) => ({ preservadas: await contas_preservadas(tx, executor) });
    plano.conferir_depois = async (tx) => {
      const sobram = await governanca.contas_que_concedem(tx);
      return sobram.length ? [] : ["nenhuma conta ativa concede perfil depois da limpeza: o sistema ficaria sem governo"];
    };
  }
  // desvincular coluna de tabela que sai inteira não faz sentido
  const sai = new Set(plano.apagar);
  plano.desvincular = [...desvincular].filter((d) => !sai.has(d.split(".")[0]!));
  return plano;
}

// =====================================================================
// Catálogo do Postgres
// =====================================================================
export interface Fk {
  nome: string;
  filho: string;
  pai: string;
  colunas: string[];
  colunas_pai: string[];
  cascata: boolean;
}

const _arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : String(v).replace(/[{}]/g, "").split(",").filter(Boolean));

export async function chaves_estrangeiras(tx: Executor): Promise<Fk[]> {
  const linhas = await consultar(
    tx,
    `SELECT c.conname AS nome, f.relname AS filho, p.relname AS pai, c.confdeltype AS tipo,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS colunas,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS colunas_pai
       FROM pg_constraint c
       JOIN pg_class f ON f.oid = c.conrelid
       JOIN pg_class p ON p.oid = c.confrelid
       JOIN pg_namespace nf ON nf.oid = f.relnamespace AND nf.nspname = 'public'
       JOIN pg_namespace np ON np.oid = p.relnamespace AND np.nspname = 'public'
      WHERE c.contype = 'f'`,
  );
  return linhas.map((l) => ({
    nome: String(l.nome),
    filho: String(l.filho),
    pai: String(l.pai),
    colunas: _arr(l.colunas),
    colunas_pai: _arr(l.colunas_pai),
    cascata: l.tipo === "c",
  }));
}

/** Ordem de DELETE: filhos antes dos pais (só entre as tabelas da lista). */
export function ordem_topologica(tabelas: readonly string[], fks: Fk[]): string[] {
  const conjunto = new Set(tabelas);
  // arestas "o pai só sai depois do filho"; as em cascata se resolvem sozinhas
  // e só são largadas quando formam ciclo (participante <-> participante_email)
  const arestas = fks.filter((f) => f.filho !== f.pai && conjunto.has(f.filho) && conjunto.has(f.pai));
  const ordem: string[] = [];
  const pendentes = new Set(tabelas);
  let comCascata = true;
  while (pendentes.size) {
    const bloqueado = (t: string) =>
      arestas.some((f) => f.pai === t && pendentes.has(f.filho) && (comCascata || !f.cascata));
    const livre = tabelas.filter((t) => pendentes.has(t) && !bloqueado(t));
    if (!livre.length) {
      if (comCascata) {
        comCascata = false;
        continue;
      }
      throw new Error("ciclo de chaves estrangeiras entre as tabelas a apagar que a cascata não resolve");
    }
    for (const t of livre) {
      ordem.push(t);
      pendentes.delete(t);
    }
    comCascata = true;
  }
  return ordem;
}

// =====================================================================
// A análise (só leitura): o grafo, os ids fixados, os problemas
// =====================================================================
export interface Analise {
  problemas: string[];
  /** a ordem de DELETE de tudo o que sai (inteiras e parciais) */
  ordem: string[];
  fks: Fk[];
  /** ids que saem das parciais com `id` */
  ids: Map<string, number[]>;
  /** o filtro, já resolvido, das parciais sem `id` (só listas fixadas) */
  filtros: Map<string, string>;
  /** as tabelas da conferência "o que fica, ficou" */
  mantidas: string[];
  /** `tabela.coluna` desvinculada -> a condição da linha que aponta para o que sai */
  desvinculos: Map<string, string>;
}

/** Ancoradas por `entidade`/`entidade_id`: ganham a âncora de tudo o que sai. */
const ANCORADAS = ["anexo", "pendencia"];

export async function analisar(tx: Executor, plano: Plano): Promise<Analise> {
  const problemas: string[] = [];
  const vazio = (): Analise => ({
    problemas,
    ordem: [],
    fks: [],
    ids: new Map(),
    filtros: new Map(),
    mantidas: [],
    desvinculos: new Map(),
  });
  const existentes = new Set(
    (await consultar(tx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((l) => String(l.tablename)),
  );
  const desv_tabelas = plano.desvincular.map((d) => d.split(".")[0]!);
  for (const t of [...plano.apagar, ...Object.keys(plano.parciais), ...desv_tabelas]) {
    if (!existentes.has(t)) problemas.push(`a tabela '${t}' da lista não existe neste banco (esquema diferente do esperado)`);
  }
  if (problemas.length) return vazio();

  const apagar = new Set(plano.apagar);
  const parciais = new Set(Object.keys(plano.parciais));
  for (const t of parciais) if (apagar.has(t)) problemas.push(`a tabela '${t}' está ao mesmo tempo inteira e parcial no plano`);
  const sai = (t: string) => apagar.has(t) || parciais.has(t);
  for (const t of TABELAS_INTOCAVEIS) if (sai(t)) problemas.push(`a tabela '${t}' não se apaga, nem pela limpeza`);

  const colunas = new Map<string, Map<string, boolean>>();
  for (const l of await consultar(
    tx,
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`,
  )) {
    const t = String(l.table_name);
    if (!colunas.has(t)) colunas.set(t, new Map());
    colunas.get(t)!.set(String(l.column_name), l.is_nullable === "YES");
  }
  const tem_id = (t: string) => colunas.get(t)?.has("id") ?? false;

  const fks = await chaves_estrangeiras(tx);
  const fk_da = (t: string, c: string) => fks.find((f) => f.filho === t && f.colunas.length === 1 && f.colunas[0] === c);

  // --- gatilhos: DELETE nas tabelas que saem, fora das travas declaradas, é recusa
  const gatilhos = await consultar(
    tx,
    `SELECT c.relname AS tabela, t.tgname AS gatilho, t.tgtype AS tipo
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  const travas = new Set(plano.travas);
  for (const g of gatilhos) {
    const tabela = String(g.tabela);
    const nome = String(g.gatilho);
    const tipo = Number(g.tipo);
    const de_delete = (tipo & 8) !== 0;
    const de_update = (tipo & 16) !== 0;
    if (sai(tabela) && de_delete && !travas.has(nome)) {
      problemas.push(`a tabela ${tabela} tem o gatilho ${nome} em DELETE fora das travas do módulo: a limpeza não passa por cima de trava`);
    }
    if (desv_tabelas.includes(tabela) && de_update) {
      problemas.push(`a tabela ${tabela} (a desvincular) tem o gatilho ${nome} em UPDATE: a limpeza não passa por cima de trava`);
    }
  }
  for (const nome of travas) {
    const g = gatilhos.find((x) => String(x.gatilho) === nome);
    if (!g) {
      problemas.push(`a trava ${nome} do plano não existe neste banco`);
      continue;
    }
    const tabela = String(g.tabela);
    if (TABELAS_INTOCAVEIS.includes(tabela)) problemas.push(`a trava ${nome} é de ${tabela}: essa não se suspende nunca`);
    else if (!sai(tabela)) problemas.push(`a trava ${nome} é de ${tabela}, que o plano não apaga`);
    else if ((Number(g.tipo) & 8) === 0) problemas.push(`a trava ${nome} não é de DELETE: só a de DELETE se suspende`);
  }

  // --- desvincular: chave estrangeira de uma coluna, que aceita nulo
  for (const d of plano.desvincular) {
    const [t, c] = d.split(".") as [string, string];
    const f = fk_da(t, c);
    if (!f) problemas.push(`${d} (a desvincular) não é chave estrangeira de uma coluna`);
    else if (colunas.get(t)?.get(c) !== true) problemas.push(`${d} (a desvincular) não aceita nulo`);
  }
  // --- quem é apontado por chave estrangeira e sai em parte precisa de `id` (os ids se fixam)
  for (const f of fks) {
    if (parciais.has(f.pai) && (!tem_id(f.pai) || f.colunas_pai.join() !== "id")) {
      problemas.push(`${f.filho}.${f.colunas.join(",")} aponta para ${f.pai}, que sai em parte e não é apontada por id`);
    }
  }
  if (problemas.length) return vazio();

  // --- as parciais: monta e fixa, na ordem de dependência
  const conjuntos = plano.conjuntos ? await plano.conjuntos(tx) : {};
  const ids = new Map<string, number[]>();
  const filtros = new Map<string, string>();
  const definicoes = new Map<string, { onde: string[]; exceto: string[] }>();
  const sai_inteira = [...apagar];
  for (const [t, p] of Object.entries(plano.parciais)) {
    const onde = [...(p.onde ?? [])];
    const exceto = [...(p.exceto ?? [])];
    for (const c of p.seguir ?? []) {
      const f = fk_da(t, c);
      if (!f) {
        problemas.push(`${t}.${c} (seguir) não é chave estrangeira de uma coluna`);
        continue;
      }
      if (apagar.has(f.pai)) onde.push(`${ident(c)} IS NOT NULL`);
      else if (parciais.has(f.pai) && f.pai !== t) onde.push(`${ident(c)} IN {ids:${f.pai}}`);
    }
    if (ANCORADAS.includes(t)) {
      if (sai_inteira.length) onde.push(`entidade IN (${lista_texto(sai_inteira)})`);
      for (const outra of parciais) {
        if (outra === t || ANCORADAS.includes(outra) || !tem_id(outra)) continue;
        onde.push(`(entidade = '${outra}' AND entidade_id IN {ids:${outra}})`);
      }
    }
    if (t === "anexo") {
      // o arquivo apontado por linha que sai sai junto; o que uma linha que fica ainda aponta, fica
      for (const f of fks.filter((x) => x.pai === "anexo" && x.colunas.length === 1)) {
        const col = ident(f.colunas[0]!);
        if (apagar.has(f.filho)) onde.push(`id IN (SELECT ${col} FROM public.${ident(f.filho)} WHERE ${col} IS NOT NULL)`);
        else if (parciais.has(f.filho) && tem_id(f.filho)) {
          onde.push(`id IN (SELECT ${col} FROM public.${ident(f.filho)} WHERE ${col} IS NOT NULL AND id IN {ids:${f.filho}})`);
          exceto.push(`id IN (SELECT ${col} FROM public.${ident(f.filho)} WHERE ${col} IS NOT NULL AND id NOT IN {ids:${f.filho}})`);
        } else if (!parciais.has(f.filho)) {
          exceto.push(`id IN (SELECT ${col} FROM public.${ident(f.filho)} WHERE ${col} IS NOT NULL)`);
        }
      }
      // e o ancorado no que fica (a orientação antiga do item de EPI que a ficha apontava) também fica
      const ficam = [...existentes].filter((x) => !sai(x));
      if (ficam.length) exceto.push(`entidade IN (${lista_texto(ficam)})`);
      for (const outra of parciais) {
        if (outra === t || ANCORADAS.includes(outra) || !tem_id(outra)) continue;
        exceto.push(`(entidade = '${outra}' AND entidade_id NOT IN {ids:${outra}})`);
      }
    }
    definicoes.set(t, { onde, exceto });
  }
  if (problemas.length) return vazio();

  const resolver = (texto: string): string | null => {
    let pendente = false;
    const r = texto.replace(/\{(ids|c):([a-z_]+)\}/g, (_m, tipo: string, nome: string) => {
      if (tipo === "c") {
        if (!Object.hasOwn(conjuntos, nome)) throw new Error(`conjunto ${nome} não fixado pelo plano`);
        return em(conjuntos[nome]!);
      }
      const fixados = ids.get(nome);
      if (!fixados) {
        pendente = true;
        return "";
      }
      return em(fixados);
    });
    return pendente ? null : r;
  };
  const faltam = new Set(definicoes.keys());
  while (faltam.size) {
    let andou = false;
    for (const t of [...faltam]) {
      const d = definicoes.get(t)!;
      const onde = d.onde.map(resolver);
      const exceto = d.exceto.map(resolver);
      if ([...onde, ...exceto].some((x) => x === null)) continue;
      let filtro = onde.length ? `(${onde.join(" OR ")})` : "false";
      if (exceto.length) filtro = `${filtro} AND NOT (${exceto.join(" OR ")})`;
      if (tem_id(t)) {
        const linhas = await consultar(tx, `SELECT id FROM public.${ident(t)} WHERE ${filtro} ORDER BY id`);
        ids.set(t, linhas.map((l) => Number(l.id)));
      } else {
        filtros.set(t, filtro);
      }
      faltam.delete(t);
      andou = true;
    }
    if (!andou) throw new Error(`dependência circular entre as parciais: ${[...faltam].join(", ")}`);
  }
  const filtro_de = (t: string): string => (ids.has(t) ? `id IN ${em(ids.get(t)!)}` : filtros.get(t)!);

  // --- as referências: nenhuma linha que fica aponta para linha que sai, salvo as declaradas
  const desvincular = new Set(plano.desvincular);
  const desvinculos = new Map<string, string>();
  const contar = async (t: string, onde: string) =>
    Number((await consultar(tx, `SELECT count(*)::int AS n FROM public.${ident(t)} WHERE ${onde}`))[0]!.n);
  for (const f of fks) {
    if (!sai(f.pai)) continue;
    if (apagar.has(f.filho) && apagar.has(f.pai)) continue;
    const cols = f.colunas.map(ident);
    let aponta: string;
    if (apagar.has(f.pai)) aponta = cols.map((c) => `${c} IS NOT NULL`).join(" AND ");
    else if (cols.length === 1) aponta = `${cols[0]} IN ${em(ids.get(f.pai) ?? [])}`;
    else {
      problemas.push(`${f.filho}.${f.colunas.join(",")} aponta para ${f.pai} (sai em parte) por chave composta`);
      continue;
    }
    const chave = `${f.filho}.${f.colunas.join(",")}`;
    if (desvincular.has(chave)) {
      desvinculos.set(chave, aponta);
      continue;
    }
    if (apagar.has(f.filho)) continue;
    // o filho que sai em parte: só a parte que FICA importa
    const onde = parciais.has(f.filho) ? `(${aponta}) AND NOT (${filtro_de(f.filho)})` : aponta;
    const n = await contar(f.filho, onde);
    if (n > 0) {
      problemas.push(
        `${chave} referencia ${f.pai} (que sai) em ${n} linha(s) que ficam: tabela ou coluna fora da lista`,
      );
    }
  }

  const tocadas = new Set([...apagar, ...parciais]);
  const volateis = new Set(TABELAS_VOLATEIS);
  const mantidas = [...existentes].filter((t) => !tocadas.has(t) && !volateis.has(t)).sort();
  let ordem: string[] = [];
  try {
    ordem = ordem_topologica([...plano.apagar, ...Object.keys(plano.parciais)], fks);
  } catch (erro) {
    problemas.push((erro as Error).message);
  }
  return { problemas, ordem, fks, ids, filtros, mantidas, desvinculos };
}

// =====================================================================
// Contagens
// =====================================================================
export interface Contagens {
  /** linhas que saem, por tabela (parciais só as marcadas) */
  apagar: Record<string, number>;
  /** a contagem total das parciais, para conferir o que sobra */
  total_parcial: Record<string, number>;
  /** linhas que ficam e perdem o vínculo, por `tabela.coluna` */
  desvincular: Record<string, number>;
  mantidas: Record<string, number>;
}

async function contar(tx: Executor, tabela: string, onde?: string): Promise<number> {
  const [l] = await consultar(tx, `SELECT count(*)::int AS n FROM public.${ident(tabela)}${onde ? ` WHERE ${onde}` : ""}`);
  return Number(l!.n);
}

export async function contagens(tx: Executor, plano: Plano, a: Analise): Promise<Contagens> {
  const apagar: Record<string, number> = {};
  const total_parcial: Record<string, number> = {};
  const desvincular: Record<string, number> = {};
  const mantidas: Record<string, number> = {};
  for (const t of plano.apagar) apagar[t] = await contar(tx, t);
  for (const t of Object.keys(plano.parciais)) {
    apagar[t] = await contar(tx, t, a.ids.has(t) ? `id IN ${em(a.ids.get(t)!)}` : a.filtros.get(t)!);
    total_parcial[t] = await contar(tx, t);
  }
  for (const [chave, aponta] of a.desvinculos) desvincular[chave] = await contar(tx, chave.split(".")[0]!, aponta);
  for (const t of a.mantidas) mantidas[t] = await contar(tx, t);
  return { apagar, total_parcial, desvincular, mantidas };
}

/** O filtro SQL da parte que sai de uma tabela do plano (inteira: `true`). */
export function filtro_da_tabela(plano: Plano, a: Analise, tabela: string): string {
  if (plano.apagar.includes(tabela)) return "true";
  if (a.ids.has(tabela)) return `id IN ${em(a.ids.get(tabela)!)}`;
  return a.filtros.get(tabela) ?? "false";
}

export function total_a_apagar(c: Contagens): number {
  return Object.values(c.apagar).reduce((x, y) => x + y, 0) + Object.values(c.desvincular).reduce((x, y) => x + y, 0);
}

/** "tabela=n, ..." só com o que não é zero (ou tudo, se tudo é zero). Sem dado pessoal: só números. */
export function resumo_contagens(c: Contagens): string {
  const partes = Object.entries(c.apagar).filter(([, n]) => n > 0);
  const linhas = (partes.length ? partes : Object.entries(c.apagar)).map(([t, n]) => `${t}=${n}`);
  const desv = Object.entries(c.desvincular).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`);
  return linhas.join(", ") + (desv.length ? `; desvinculados: ${desv.join(", ")}` : "");
}

// =====================================================================
// A execução (dentro de uma transação de quem chama)
// =====================================================================
export interface Resultado {
  antes: Contagens;
  depois: Contagens;
  ordem: string[];
  arquivos: ArquivosOrfaos;
  ms: number;
}

export class Simulado extends Error {
  constructor(public resultado: Resultado) {
    super("simulação: rollback");
  }
}

/** O grafo não fecha: nada foi gravado. */
export class GrafoNaoConfere extends Error {
  constructor(public problemas: string[]) {
    super(`grafo de chaves não confere:\n  - ${problemas.join("\n  - ")}`);
  }
}

/** Os módulos marcados já estão vazios: nada foi feito. */
export class NadaAApagar extends Error {
  constructor() {
    super("nada a apagar: os módulos marcados já estão vazios");
  }
}

export interface OpcoesExecucao {
  simular: boolean;
  tipo_evento: string;
  /** a âncora do evento na trilha (padrão `sistema`) */
  entidade?: string;
  /** quem fez: a conta (tela) ou o nome do ator (linha de comando) */
  usuario?: UsuarioAtual | null;
  usuario_nome?: string;
  descricao: (antes: Contagens) => string;
  /** com tudo vazio, não faz nada (nem o backup, nem o evento): lança `NadaAApagar` */
  recusar_vazio?: boolean;
  /** depois da trava e das contagens, antes de mexer (só na execução real) */
  antes_de_apagar?: (tx: Executor, antes: Contagens, a: Analise) => Promise<void>;
}

async function arquivos_orfaos(tx: Executor, plano: Plano, a: Analise): Promise<ArquivosOrfaos> {
  const { chave_do_blob, chave_no_armazenamento } = await import("./anexos.js");
  const chaves = new Set<string>();
  const listagens: ArquivosOrfaos["listagens"] = [];
  const saem = a.ids.get("anexo") ?? [];
  if (saem.length) {
    // o blob é endereçado pelo conteúdo: só sai se nenhum anexo que fica (nem modelo de certificado) o usa
    const blobs = await consultar(
      tx,
      `SELECT DISTINCT storage_key FROM public.anexo WHERE id IN ${em(saem)}
          AND storage_key NOT IN (SELECT storage_key FROM public.anexo WHERE id NOT IN ${em(saem)})`,
    );
    const modelos = new Set(
      (await consultar(tx, `SELECT arquivo_enviado FROM public.certificado_modelo WHERE arquivo_enviado IS NOT NULL`))
        .map((l) => {
          const v = typeof l.arquivo_enviado === "string" ? JSON.parse(l.arquivo_enviado) : l.arquivo_enviado;
          const sha = (v as { sha256_convertido?: string } | null)?.sha256_convertido;
          return sha && /^[0-9a-f]{64}$/.test(sha) ? chave_do_blob(sha) : "";
        })
        .filter(Boolean),
    );
    for (const b of blobs) if (!modelos.has(String(b.storage_key))) chaves.add(chave_no_armazenamento(String(b.storage_key)));
  }
  for (const gerar of plano.arquivos) {
    const r = await gerar(tx);
    for (const c of r.chaves) chaves.add(c);
    listagens.push(...r.listagens);
  }
  return { chaves: [...chaves].sort(), listagens };
}

export async function executar(tx: Executor, plano: Plano, o: OpcoesExecucao): Promise<Resultado> {
  const inicio = Date.now();
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '15s'`));
  const tocadas = [
    ...new Set([...plano.apagar, ...Object.keys(plano.parciais), ...plano.desvincular.map((d) => d.split(".")[0]!)]),
  ].sort();
  await tx.execute(sql.raw(`LOCK TABLE ${tocadas.map((t) => `public.${ident(t)}`).join(", ")} IN ACCESS EXCLUSIVE MODE`));

  const a = await analisar(tx, plano);
  if (a.problemas.length) throw new GrafoNaoConfere(a.problemas);
  const antes = await contagens(tx, plano, a);
  if (o.recusar_vazio && total_a_apagar(antes) === 0) throw new NadaAApagar();
  const arquivos = await arquivos_orfaos(tx, plano, a);
  if (!o.simular && o.antes_de_apagar) await o.antes_de_apagar(tx, antes, a);
  // a trilha não é travada (todo pedido escreve nela): confere-se o evento DESTA limpeza
  const [ultimo] = await consultar(tx, `SELECT coalesce(max(id), 0)::bigint AS id FROM public.historico_evento`);
  const trilha_antes = Number(ultimo!.id);

  // 1. as travas do módulo, suspensas pelo nome (e só dentro desta transação)
  const travas_de = new Map<string, string>();
  if (plano.travas.length) {
    for (const l of await consultar(
      tx,
      `SELECT c.relname AS tabela, t.tgname AS gatilho FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname IN (${lista_texto(plano.travas)})`,
    )) {
      travas_de.set(String(l.gatilho), String(l.tabela));
    }
  }
  for (const [g, t] of travas_de) await tx.execute(sql.raw(`ALTER TABLE public.${ident(t)} DISABLE TRIGGER ${ident(g)}`));
  // 2. o que fica perde o vínculo com o que sai
  for (const [chave, aponta] of a.desvinculos) {
    const [t, c] = chave.split(".") as [string, string];
    await tx.execute(sql.raw(`UPDATE public.${ident(t)} SET ${ident(c)} = NULL WHERE ${aponta}`));
  }
  // 3. filhos antes dos pais; as parciais pelos ids fixados antes
  for (const t of a.ordem) {
    if (plano.apagar.includes(t)) await tx.execute(sql.raw(`DELETE FROM public.${ident(t)}`));
    else if (a.ids.has(t)) {
      const fixados = a.ids.get(t)!;
      if (fixados.length) await tx.execute(sql.raw(`DELETE FROM public.${ident(t)} WHERE id IN ${em(fixados)}`));
    } else await tx.execute(sql.raw(`DELETE FROM public.${ident(t)} WHERE ${a.filtros.get(t)!}`));
  }
  // 4. as travas de volta, e conferidas
  for (const [g, t] of travas_de) await tx.execute(sql.raw(`ALTER TABLE public.${ident(t)} ENABLE TRIGGER ${ident(g)}`));
  const erros: string[] = [];
  const desligadas = await consultar(
    tx,
    `SELECT t.tgname AS gatilho FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'O'`,
  );
  for (const d of desligadas) erros.push(`o gatilho ${d.gatilho} ficou desligado`);

  // 5. a trilha: UM evento, pela via oficial
  await auditoria.registrar(tx, {
    entidade: o.entidade ?? "sistema",
    entidade_id: 0,
    tipo_evento: o.tipo_evento,
    descricao: o.descricao(antes),
    usuario: o.usuario ?? null,
    usuario_nome: o.usuario_nome,
  });

  // 6. conferência: zerou o que devia, ficou o que devia
  const depois = await contagens(tx, plano, a);
  for (const [t, n] of Object.entries(depois.apagar)) if (n !== 0) erros.push(`${t} ainda tem ${n} linha(s)`);
  for (const [t, n] of Object.entries(depois.desvincular)) if (n !== 0) erros.push(`${t} ainda aponta para o que saiu em ${n} linha(s)`);
  for (const [t, n] of Object.entries(antes.mantidas)) {
    if (depois.mantidas[t] !== n) erros.push(`${t}: eram ${n}, deveria ficar ${n}, ficou ${depois.mantidas[t]}`);
  }
  for (const [t, n] of Object.entries(antes.total_parcial)) {
    const esperado = n - antes.apagar[t]!;
    if (depois.total_parcial[t] !== esperado) erros.push(`${t}: deveria sobrar ${esperado}, sobrou ${depois.total_parcial[t]}`);
  }
  const novos = await contar(
    tx,
    "historico_evento",
    `id > ${trilha_antes} AND tipo_evento IN (${lista_texto([o.tipo_evento])})`,
  );
  if (novos !== 1) erros.push(`a trilha devia ganhar 1 evento ${o.tipo_evento} e ganhou ${novos}`);
  if (plano.conferir_depois) erros.push(...(await plano.conferir_depois(tx)));
  if (erros.length) throw new Error(`conferência final falhou (nada foi gravado):\n  - ${erros.join("\n  - ")}`);

  const resultado: Resultado = { antes, depois, ordem: a.ordem, arquivos, ms: Date.now() - inicio };
  if (o.simular) throw new Simulado(resultado);
  return resultado;
}

/** Simula numa sub-transação (savepoint) e devolve o que seria feito — nada fica. */
export async function simular(
  tx: Executor,
  plano: Plano,
  o: Omit<OpcoesExecucao, "simular" | "antes_de_apagar">,
): Promise<{ resultado: Resultado | null; problemas: string[] }> {
  try {
    await tx.transaction((sp) => executar(sp, plano, { ...o, simular: true }));
  } catch (erro) {
    if (erro instanceof Simulado) return { resultado: erro.resultado, problemas: [] };
    if (erro instanceof GrafoNaoConfere) return { resultado: null, problemas: erro.problemas };
    throw erro;
  }
  throw new Error("a simulação não desfez a transação");
}

// =====================================================================
// Armazenamento (depois do commit)
// =====================================================================
export interface RelatorioArmazenamento {
  encontrados: number;
  apagados: number;
  falhas: number;
}

export async function apagar_orfaos(arquivos: ArquivosOrfaos, apagar: boolean): Promise<RelatorioArmazenamento> {
  const { obterArmazenamento } = await import("./armazenamento.js");
  const arm = obterArmazenamento();
  const todas = new Set(arquivos.chaves);
  let falhas = 0;
  for (const { prefixo, inicios } of arquivos.listagens) {
    try {
      for (const item of await arm.listar(prefixo)) {
        if (inicios.some((i) => item.nome.startsWith(i))) todas.add(item.chave);
      }
    } catch {
      falhas += 1;
    }
  }
  let encontrados = 0;
  let apagados = 0;
  for (const chave of todas) {
    try {
      if (!(await arm.existe(chave))) continue;
      encontrados += 1;
      if (apagar) {
        await arm.remover(chave);
        apagados += 1;
      }
    } catch {
      falhas += 1;
    }
  }
  return { encontrados, apagados, falhas };
}
