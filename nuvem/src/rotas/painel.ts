/**
 * / — o painel do Processos SEI.
 * Porte de `app/rotas/painel.py`.
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioCom } from "../dependencias.js";
import { pagina } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  agente_nocivo,
  exposicao,
  historico_evento,
  laudo_tecnico,
  parecer_tecnico,
  tipo_risco,
} from "../db/esquema/index.js";
import * as repo from "../repositorios/processos.js";
import * as datas_br from "../servicos/datas_br.js";
import { habilitados_vigentes } from "../servicos/parecer.js";
import { resumir } from "../servicos/processo.js";
import { LIMIAR_SUPRESSAO, suprimir } from "./relatorios.js";

export const rotas = new Hono<Ambiente>();

// Quantas linhas do cartão cabem sem o painel virar lista. O número TOTAL vai
// junto e é o que o contador publica: cortar a lista é decisão de tela, cortar
// o número é o painel mentindo.
export const MOSTRADOS_NO_CARTAO = 8;

// A visão de `/processos` que o cartão linka. O contador e o link têm de
// continuar apontando para o mesmo recorte.
export const FILA_PRECISAM = "/processos?precisam=1";

/** O `round()` do Python: metade vai para o par. */
export function arredondar_python(x: number): number {
  const piso = Math.floor(x);
  const resto = x - piso;
  if (resto > 0.5) return piso + 1;
  if (resto < 0.5) return piso;
  return piso % 2 === 0 ? piso : piso + 1;
}

function dias_entre(inicio: string, fim: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(fim) - d(inicio)) / 86_400_000);
}

rotas.get("/", async (c) => {
  const usuario = await usuarioCom(c, "processo.ver");
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const exercicio = Number(hoje.slice(0, 4));
  const kpis: Record<string, number | null> = { ...(await repo.indicadores(tx, usuario, exercicio)) };

  kpis.subscritores_habilitados = (await habilitados_vigentes(tx, hoje)).length;

  const emitidos = await tx.query.parecer_tecnico.findMany({
    where: and(inArray(parecer_tecnico.situacao, ["EMITIDO", "ASSINADO"]), eq(parecer_tecnico.ano, exercicio)),
    with: { processo: true },
    orderBy: [asc(parecer_tecnico.id)],
  });
  const tempos = emitidos
    .filter((p) => p.data_emissao && p.processo && p.processo.data_autuacao)
    .map((p) => dias_entre(p.processo!.data_autuacao!, p.data_emissao!));
  kpis.tempo_medio_emissao = tempos.length ? arredondar_python(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null;

  const por_mes: Record<number, number> = {};
  for (let mes = 1; mes <= 12; mes++) por_mes[mes] = 0;
  for (const parecer of emitidos) {
    if (parecer.data_emissao) por_mes[Number(parecer.data_emissao.slice(5, 7))]! += 1;
  }

  // RN-19 também aqui, e com a MESMA função de `/relatorios`: publicar cru o que
  // lá sai suprimido fazia do painel a porta dos fundos da supressão.
  const contagem_por_risco: Record<string, number> = {};
  for (const { nome, n } of await tx
    .select({ nome: tipo_risco.nome, n: count() })
    .from(exposicao)
    .innerJoin(agente_nocivo, eq(agente_nocivo.id, exposicao.agente_nocivo_id))
    .innerJoin(tipo_risco, eq(tipo_risco.id, agente_nocivo.tipo_risco_id))
    .groupBy(tipo_risco.nome)) {
    contagem_por_risco[nome] = n;
  }
  const por_risco = suprimir(contagem_por_risco, usuario.ve_dado_nominal);

  // O cartão "Precisam de você hoje" e o link dele contam a MESMA coisa, porque
  // são a mesma consulta: o filtro `precisam` do repositório aplica
  // `processo.precisa_de_atencao`. `por_pagina` alto, e não paginação: o total
  // é o que o cartão publica.
  const [lista, total_precisam] = await repo.listar(
    tx,
    usuario,
    new repo.Filtro({ precisam: true, por_pagina: 100000 }),
  );
  const resumos = [];
  for (const p of lista) resumos.push(await resumir(tx, p));
  // `sorted(..., key=-dias)`: estável, como o do Python
  const precisam_de_voce = resumos.sort((a, b) => b.dias_no_estado - a.dias_no_estado).slice(0, MOSTRADOS_NO_CARTAO);

  const laudos_sem_conferencia = (
    await tx.query.laudo_tecnico.findMany({
      where: eq(laudo_tecnico.status, "VIGENTE"),
      with: { unidade: true },
      orderBy: [asc(laudo_tecnico.id)],
    })
  ).filter(
    (laudo) =>
      laudo.data_ultima_conferencia === null || datas_br.meses_entre(laudo.data_ultima_conferencia, hoje) > 24,
  );

  const eventos = await tx.select().from(historico_evento).orderBy(desc(historico_evento.id)).limit(10);

  // Primeiro acesso: a conta nasce superintendente, que governa acesso mas não
  // opera processo. Sem esta dica o coordenador trava no primeiro minuto.
  const precisa_de_perfil_operacional = usuario.pode("perfil.conceder") && !usuario.pode("processo.criar");

  return pagina(c, "paginas/painel.html", usuario, {
    precisa_de_perfil_operacional,
    kpis,
    exercicio,
    por_mes: dicionario(por_mes),
    por_risco: dicionario(por_risco),
    limiar: LIMIAR_SUPRESSAO,
    precisam_de_voce,
    total_precisam,
    fila_precisam: FILA_PRECISAM,
    laudos_sem_conferencia,
    eventos,
  });
});
