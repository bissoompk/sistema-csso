/**
 * NUVEM (Início com os cartões dos módulos, 23/10/2026): a "Visão geral" da
 * equipe, em `/inicio` — a porta de entrada do sistema, como a `#home-view` do
 * IntegraSST (`entrada/integrasst/Index.html`): um cartão grande por módulo que
 * a pessoa abre, com o selo do que espera nele, e os módulos ainda por vir,
 * bloqueados, logo abaixo.
 *
 * QUEM TEM CARTÃO É O MENU QUE DECIDE. O cartão de um módulo aparece se o
 * módulo abre ao menos uma tela para a pessoa (`Modulo.itens_de`, o mesmo
 * filtro da lateral) e leva à porta de entrada dele (`porta_de_entrada`). A
 * Visão geral não tem regra de acesso própria: ela não pode oferecer um módulo
 * que a lateral esconde, nem esconder um que a lateral oferece.
 *
 * OS SELOS SÃO BARATOS. A tela é medida em idas ao banco
 * (`testes/idas_ao_banco`): a de EPI é a `contagens_numa_ida` (uma), a de
 * Certificados é uma consulta com as duas contagens, e Processos e Demandas
 * contam as pendências DA PESSOA que a casca já leu para o sino
 * (`sino_antecipado`) — nenhuma ida a mais. Nada aqui nomeia ninguém (RN-19):
 * são só números, e quem quer saber de quem é abre a fila.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  pendencia as tabela_pendencia,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import {
  MODULOS,
  PROCESSOS_SEI,
  base_de,
  icone_de,
  meu_espaco_de,
  porta_de_entrada,
  type Modulo,
} from "../modulos.js";
import { ESCOPO_PROPRIO, EscopoNaoDeclarado, type UsuarioAtual } from "./rbac.js";
import * as epi_contagens from "./epi_contagens.js";
import { modulo_nivelado } from "./niveis_modulo.js";
import { tem_acesso_ao_modulo } from "./acesso_modulo.js";
import { consulta_no_escopo } from "./turma.js";

/** O selo vermelho do cartão: o número e o que ele conta, por extenso. */
export interface Selo {
  total: number;
  /** "3 pedidos a analisar · 1 comunicação a tratar": vai escrito no cartão */
  detalhe: string;
}

export interface CartaoModulo {
  /** vira a classe `mod-{codigo}`, que escolhe as cores (tokens em `csso.css`) */
  codigo: string;
  nome: string;
  frase: string;
  icone: string;
  href: string;
  rotulo_botao: string;
  selo: Selo | null;
}

export interface CartaoPrevisto {
  codigo: string;
  nome: string;
  frase: string;
  icone: string;
}

export interface VisaoGeral {
  primeiro_nome: string;
  cartoes: CartaoModulo[];
  previstos: CartaoPrevisto[];
}

/**
 * A frase curta de cada cartão. O `resumo` do módulo (`modulos.ts`) é o texto
 * do mapa, de duas ou três linhas; no cartão cabe uma, como no IntegraSST. O
 * módulo sem frase aqui usa o resumo.
 */
const FRASES: Readonly<Record<string, string>> = {
  [PROCESSOS_SEI]: "Do requerimento ao parecer assinado: processos de adicional ocupacional, laudos e o direito concedido.",
  epis: "Catálogo, estoque, pedidos analisados item a item e a entrega registrada na ficha.",
  acidentes: "Comunicação do acidente em serviço, investigação técnica e plano de ação.",
  certificados: "Turmas, inscrições, presença, emissão do certificado e o controle da reciclagem.",
};

/** Os tipos de pendência que se cumprem em cada cartão (`pendencias.TIPOS`). */
const TIPOS_DE: Readonly<Record<string, readonly string[]>> = {
  [PROCESSOS_SEI]: [
    "AVALIACAO_QUANTITATIVA",
    "REAVALIACAO_LAUDO",
    "INCLUIR_NO_SEI",
    "CONFERIR_LAUDO",
    "REGISTRO_DE_OPCAO",
    "CONFLITO_NUMERACAO",
    "REAVALIAR_ADICIONAL_POR_EPI",
  ],
  demandas: ["DEMANDA_COM_PRAZO", "DEMANDA_DESFECHO_A_LER"],
};

/** "1 pedido" / "3 pedidos". */
function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** O primeiro nome da conta, para a saudação ("Nádia"). */
export function primeiro_nome(nome: string | null | undefined): string {
  return (nome ?? "").trim().split(/\s+/)[0] ?? "";
}

/** A pendência aberta, como a casca a lê para o sino. */
type PendenciaLida = { responsavel_id: number | null; concluida: boolean; tipo?: string | null; n?: number };

/**
 * As pendências abertas da pessoa por cartão. Usa a leitura do sino quando a
 * casca já a fez (com o `tipo`); sem ela, uma consulta só, com o mesmo recorte.
 */
async function _pendencias_minhas(
  tx: Executor,
  usuario: UsuarioAtual,
  lidas: readonly PendenciaLida[] | undefined,
): Promise<Record<string, number>> {
  let minhas: { tipo?: string | null; n?: number }[];
  if (lidas && lidas.every((p) => p.tipo !== undefined)) {
    minhas = lidas.filter((p) => !p.concluida && p.responsavel_id === usuario.id);
  } else {
    minhas = await tx
      .select({ tipo: tabela_pendencia.tipo })
      .from(tabela_pendencia)
      .where(and(eq(tabela_pendencia.concluida, false), eq(tabela_pendencia.responsavel_id, usuario.id)));
  }
  const por: Record<string, number> = {};
  for (const [codigo, tipos] of Object.entries(TIPOS_DE)) {
    por[codigo] = minhas.filter((p) => p.tipo && tipos.includes(p.tipo)).reduce((t, p) => t + (p.n ?? 1), 0);
  }
  return por;
}

function _selo_de_pendencias(n: number): Selo | null {
  return n > 0 ? { total: n, detalhe: plural(n, "pendência sua", "pendências suas") } : null;
}

function _da_equipe(usuario: UsuarioAtual, permissao: string): boolean {
  if (!usuario.pode(permissao)) return false;
  try {
    return usuario.pode_na_equipe(permissao) && usuario.escopo_de(permissao) !== ESCOPO_PROPRIO;
  } catch (erro) {
    if (erro instanceof EscopoNaoDeclarado) return false;
    throw erro;
  }
}

/**
 * O selo de Certificados numa ida ao banco: a fila de emissão (aprovado em
 * turma concluída sem certificado em vigor — é o "aguardando" e o "travado" de
 * `fila_emissao`, sem a validação de cada um, que é cara e não muda o número)
 * no alcance de `certificado.ver`, e os pedidos pelo link a conferir no de
 * `turma.inscrever`, como o hub de `/treinamentos`.
 */
async function _selo_certificados(tx: Executor, usuario: UsuarioAtual): Promise<Selo | null> {
  const ve_fila = _da_equipe(usuario, "certificado.ver");
  const confere = _da_equipe(usuario, "turma.inscrever");
  if (!ve_fila && !confere) return null;
  const fila = ve_fila
    ? tx
        .select({ n: sql<number>`count(${tabela_inscricao.id})`.as("n") })
        .from(tabela_inscricao)
        .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
        .leftJoin(
          tabela_certificado,
          and(eq(tabela_certificado.inscricao_id, tabela_inscricao.id), eq(tabela_certificado.situacao, "EMITIDO")),
        )
        .where(
          and(
            consulta_no_escopo(usuario, "certificado.ver"),
            eq(tabela_inscricao.situacao, "APROVADO"),
            eq(tabela_turma.situacao, "CONCLUIDA"),
            isNull(tabela_certificado.id),
          ),
        )
    : null;
  const pedidos = confere
    ? tx
        .select({ n: sql<number>`count(${tabela_inscricao.id})`.as("n") })
        .from(tabela_inscricao)
        .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
        .where(and(consulta_no_escopo(usuario, "turma.inscrever"), eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")))
    : null;
  const colunas = [fila ? sql`(${fila}) AS fila` : sql`0 AS fila`, pedidos ? sql`(${pedidos}) AS pedidos` : sql`0 AS pedidos`];
  const linhas = (await tx.execute(sql`SELECT ${sql.join(colunas, sql`, `)}`)) as unknown as { fila?: unknown; pedidos?: unknown }[];
  const n_fila = Number(linhas[0]?.fila ?? 0);
  const n_pedidos = Number(linhas[0]?.pedidos ?? 0);
  const partes: string[] = [];
  if (n_fila) partes.push(plural(n_fila, "certificado a emitir", "certificados a emitir"));
  if (n_pedidos) partes.push(plural(n_pedidos, "pedido de inscrição a decidir", "pedidos de inscrição a decidir"));
  return n_fila + n_pedidos > 0 ? { total: n_fila + n_pedidos, detalhe: partes.join(" · ") } : null;
}

async function _selo_epi(tx: Executor, usuario: UsuarioAtual): Promise<Selo | null> {
  const c = await epi_contagens.contagens_numa_ida(tx, usuario);
  const pedidos = c.a_analisar?.total ?? 0;
  const comunicacoes = c.comunicacoes?.total ?? 0;
  const partes: string[] = [];
  if (pedidos) partes.push(plural(pedidos, "pedido a analisar", "pedidos a analisar"));
  if (comunicacoes) partes.push(plural(comunicacoes, "comunicação a tratar", "comunicações a tratar"));
  return pedidos + comunicacoes > 0 ? { total: pedidos + comunicacoes, detalhe: partes.join(" · ") } : null;
}

/** Quem administra: cria conta ou concede perfil (`/usuarios`), ou opera o backup (`/config`). */
function _administracao(usuario: UsuarioAtual): CartaoModulo | null {
  const usuarios = base_de(usuario).find((i) => i.caminho === "/usuarios");
  const sistema = usuario.pode("backup.executar");
  if (!usuarios && !sistema) return null;
  return {
    codigo: "administracao",
    nome: "Administração",
    frase: usuarios
      ? "Contas, perfis e permissões de acesso, a trilha de auditoria e a configuração do sistema."
      : "A configuração do sistema: onde o dado mora, backup e exportação.",
    icone: "gear",
    href: usuarios ? usuarios.caminho : "/config",
    rotulo_botao: "Acessar",
    selo: null,
  };
}

/**
 * Se a pessoa tem o MÓDULO, pelas permissões dele já com os níveis aplicados
 * (`niveis_modulo.MODULOS_NIVELADOS`: o "Sem acesso" do perfil ou da exceção
 * da pessoa tira todas). As permissões efetivas da sessão já vêm com o nível
 * (`rbac.perfis_vigentes`), então basta perguntar por uma do módulo, por
 * perfil de equipe — a do titular (escopo próprio) não abre o cartão da equipe.
 *
 * Isto vale ALÉM de `itens_de`: o menu também oferece telas por permissão
 * transversal (o "Importar" de Processos SEI pede `catalogo.gerenciar`; os
 * relatórios, `indicador.ver`), que não se liberam por módulo. Com o módulo
 * em "Sem acesso", essas telas avulsas não fazem do módulo um cartão.
 * Módulo sem mapa de níveis (nenhum hoje) segue só o `itens_de`.
 */
function _tem_o_modulo(usuario: UsuarioAtual, codigo: string): boolean {
  // a regra é uma só (`acesso_modulo.ts`), a mesma do menu, do mapa e das rotas
  return modulo_nivelado(codigo) ? tem_acesso_ao_modulo(usuario, codigo) : true;
}

/**
 * Os cartões da Visão geral, na ordem da lateral: os módulos, as Demandas
 * (da base), o Meu espaço e a Administração; e os módulos previstos.
 */
export async function visao_geral(
  tx: Executor,
  usuario: UsuarioAtual,
  lidas?: readonly PendenciaLida[],
): Promise<VisaoGeral> {
  const abertos: Modulo[] = MODULOS.filter(
    (m) => m.disponivel && m.itens_de(usuario).length > 0 && _tem_o_modulo(usuario, m.codigo),
  );
  const codigos = new Set(abertos.map((m) => m.codigo));
  const demandas =
    (_tem_o_modulo(usuario, "demandas") ? base_de(usuario).find((i) => i.caminho === "/demandas") : null) ?? null;
  const precisa_pendencias = codigos.has(PROCESSOS_SEI) || demandas !== null;
  // as idas ao banco saem juntas (o banco fica longe — `db/cliente.ts`)
  const [pendencias, selo_epi, selo_cert] = await Promise.all([
    precisa_pendencias ? _pendencias_minhas(tx, usuario, lidas) : Promise.resolve({} as Record<string, number>),
    codigos.has("epis") ? _selo_epi(tx, usuario) : Promise.resolve(null),
    codigos.has("certificados") ? _selo_certificados(tx, usuario) : Promise.resolve(null),
  ]);
  const selos: Record<string, Selo | null> = {
    [PROCESSOS_SEI]: _selo_de_pendencias(pendencias[PROCESSOS_SEI] ?? 0),
    epis: selo_epi,
    certificados: selo_cert,
  };

  const cartoes: CartaoModulo[] = abertos.map((m) => ({
    codigo: m.codigo,
    nome: m.nome,
    frase: FRASES[m.codigo] ?? m.resumo,
    icone: icone_de(m.codigo) ?? "grid-1x2",
    href: porta_de_entrada(m, usuario),
    rotulo_botao: "Acessar módulo",
    selo: selos[m.codigo] ?? null,
  }));
  if (demandas) {
    cartoes.push({
      codigo: "demandas",
      nome: "Demandas",
      frase: "O que chegou por e-mail ou no balcão e ainda não virou processo SEI, com prazo e desfecho.",
      icone: icone_de("/demandas") ?? "list-check",
      href: demandas.caminho,
      rotulo_botao: "Acessar",
      selo: _selo_de_pendencias(pendencias.demandas ?? 0),
    });
  }
  const meu = meu_espaco_de(usuario);
  if (meu.length) {
    cartoes.push({
      codigo: "meu-espaco",
      nome: "Meu espaço",
      frase: "O que é seu: treinamentos e certificados, a ficha e os pedidos de EPI, a sua atividade.",
      icone: "person",
      href: meu[0]!.caminho,
      rotulo_botao: "Acessar",
      selo: null,
    });
  }
  const admin = _administracao(usuario);
  if (admin) cartoes.push(admin);

  const previstos: CartaoPrevisto[] = MODULOS.filter((m) => !m.disponivel).map((m) => ({
    codigo: m.codigo,
    nome: m.nome,
    frase: m.resumo,
    icone: icone_de(m.codigo) ?? "lock",
  }));
  return { primeiro_nome: primeiro_nome(usuario.nome), cartoes, previstos };
}
