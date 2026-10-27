/**
 * Os indicadores do módulo de acidentes (fatia F8): contagens por ano, espécie,
 * campus e unidade, e — só para quem lê o detalhe clínico — os casos com
 * afastamento e os dias perdidos (D12: sem taxas de frequência e de gravidade,
 * que pedem horas-homem trabalhadas por unidade; ficam para um parâmetro anual).
 *
 * **RN-19.** Toda célula com menos de 5 casos sai suprimida («—»), com a
 * supressão secundária que o resto do sistema já usa (`suprimir`): nunca sobra
 * UMA célula escondida sozinha, senão o total a devolve por subtração. Com as
 * dezenas de casos por ano de uma universidade, quase todo recorte por unidade
 * cai na supressão — é esperado, e a tela diz isso.
 *
 * O recorte é o do alcance de quem pede (escopo e ocorrência restrita), sem as
 * canceladas, pela data do acidente.
 */
import { and, between, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_saude, acidentado, acidente_ocorrencia, campus as tabela_campus, unidade_uorg } from "../db/esquema/index.js";
import { ROTULO_ESPECIE } from "../dominio/acidente.js";
import { LIMIAR_SUPRESSAO, MARCA_SUPRIMIDO, suprimir } from "../rotas/relatorios.js";
import { escopo_ocorrencias, filtro_restrita } from "./acidente_acesso.js";
import type { UsuarioAtual } from "./rbac.js";

export interface Indicadores {
  periodo: { inicio: string; fim: string };
  total: string;
  por_ano: Record<string, string>;
  por_especie: Record<string, string>;
  por_campus: Record<string, string>;
  por_unidade: Record<string, string>;
  /** só com `acidente.saude_detalhe_ver`; `null` sem a permissão */
  afastamento: { casos: string; dias: string } | null;
  limiar: number;
}

function _contar(chaves: string[]): Record<string, number> {
  const saida: Record<string, number> = {};
  for (const k of chaves) saida[k] = (saida[k] ?? 0) + 1;
  return saida;
}

export async function calcular(tx: Executor, usuario: UsuarioAtual, periodo: { inicio: string; fim: string }): Promise<Indicadores> {
  const condicoes = [
    escopo_ocorrencias(usuario),
    filtro_restrita(usuario),
    ne(acidente_ocorrencia.estado, "CANCELADA"),
    between(acidente_ocorrencia.data_evento, periodo.inicio, periodo.fim),
  ].filter((c): c is SQL => !!c);
  const linhas = await tx
    .select({
      id: acidente_ocorrencia.id,
      data: acidente_ocorrencia.data_evento,
      especie: acidente_ocorrencia.especie,
      campus: tabela_campus.sigla,
      unidade_sigla: unidade_uorg.sigla,
      unidade_nome: unidade_uorg.nome_oficial,
    })
    .from(acidente_ocorrencia)
    .leftJoin(tabela_campus, eq(tabela_campus.id, acidente_ocorrencia.campus_id))
    .leftJoin(unidade_uorg, eq(unidade_uorg.id, acidente_ocorrencia.local_unidade_uorg_id))
    .where(and(...condicoes));

  const por_ano = _contar(linhas.map((l) => l.data.slice(0, 4)));
  const por_especie = _contar(linhas.map((l) => ROTULO_ESPECIE[l.especie] ?? l.especie));
  const por_campus = _contar(linhas.map((l) => l.campus ?? "Sem campus"));
  const por_unidade = _contar(linhas.map((l) => l.unidade_sigla ?? l.unidade_nome ?? "Sem unidade informada"));

  let afastamento: Indicadores["afastamento"] = null;
  if (usuario.pode("acidente.saude_detalhe_ver") && linhas.length) {
    const [soma] = await tx
      .select({ casos: sql<number>`count(*)::int`, dias: sql<number>`coalesce(sum(${acidente_saude.dias_afastamento}), 0)::int` })
      .from(acidente_saude)
      .innerJoin(acidentado, eq(acidentado.id, acidente_saude.acidentado_id))
      .where(and(inArray(acidentado.ocorrencia_id, linhas.map((l) => l.id)), eq(acidente_saude.houve_afastamento, "SIM")));
    const casos = soma?.casos ?? 0;
    // a soma de dias de menos de 5 casos identificaria quem se afastou
    afastamento = casos >= LIMIAR_SUPRESSAO ? { casos: String(casos), dias: String(soma?.dias ?? 0) } : { casos: MARCA_SUPRIMIDO, dias: MARCA_SUPRIMIDO };
  }
  return {
    periodo,
    total: suprimir({ total: linhas.length }, false)["total"]!,
    por_ano: suprimir(por_ano, false),
    por_especie: suprimir(por_especie, false),
    por_campus: suprimir(por_campus, false),
    por_unidade: suprimir(por_unidade, false),
    afastamento,
    limiar: LIMIAR_SUPRESSAO,
  };
}
