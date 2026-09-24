/**
 * /relatorios — indicadores, lacunas de numeração e fila de conferência.
 * Porte de `app/rotas/relatorios.py`.
 *
 * RN-19: toda visão agregada aplica supressão de célula n<5 e supressão
 * secundária; recorte com menos de 5 servidores exige `exposicao.ver`.
 */
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioCom } from "../dependencias.js";
import { marcarDownload, pagina } from "../web.js";
import { dicionario } from "../dicionario.js";
import { adicional_vigencia, laudo_tecnico, parecer_tecnico, processo } from "../db/esquema/index.js";
import * as repo from "../repositorios/processos.js";
import * as datas_br from "../servicos/datas_br.js";
import { lacunas_de_numeracao } from "../servicos/numeracao.js";

export const rotas = new Hono<Ambiente>();

export const LIMIAR_SUPRESSAO = 5;
export const MARCA_SUPRIMIDO = "—";
export const RODAPE_FILA_LAUDOS =
  "o laudo não tem prazo de validade (IN 15/2022, art. 10, §3º); esta lista é " +
  "apenas fila de trabalho, não vencimento.";

type Contagens = Record<string, number>;

function _primarias(contagens: Contagens): Set<string> {
  return new Set(Object.entries(contagens).filter(([, v]) => v < LIMIAR_SUPRESSAO).map(([k]) => k));
}

/**
 * Nunca deixa sobrar UMA célula suprimida sozinha numa distribuição.
 *
 * Com uma só escondida, quem tiver o total da distribuição a recupera por
 * subtração. Com duas, a subtração devolve a SOMA das duas, que não nomeia
 * ninguém. É o único motivo de a supressão secundária existir.
 */
function _com_secundaria(contagens: Contagens, marcadas: Set<string>): Set<string> {
  if (marcadas.size !== 1) return marcadas;
  const sobreviventes = Object.keys(contagens).filter((k) => !marcadas.has(k));
  if (!sobreviventes.length) return marcadas;
  // `min(key=...)` do Python: o primeiro dos empatados
  const menor = sobreviventes.reduce((a, b) => (contagens[b]! < contagens[a]! ? b : a));
  return new Set([...marcadas, menor]);
}

function _formatar(contagens: Contagens, marcadas: Set<string>): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(contagens)) saida[k] = marcadas.has(k) ? MARCA_SUPRIMIDO : String(v);
  return saida;
}

/**
 * Supressão primária (n<5) + secundária (esconde a menor sobrevivente quando
 * só uma célula foi suprimida, senão a diferença a revela).
 */
export function suprimir(contagens: Contagens, pode_ver: boolean): Record<string, string> {
  if (pode_ver) return _formatar(contagens, new Set());
  return _formatar(contagens, _com_secundaria(contagens, _primarias(contagens)));
}

/** Um grupo e as células dele, já suprimidos de forma consistente. */
export interface LinhaAninhada {
  rotulo: string;
  valor: string;
  folhas: [string, string][];
  readonly suprimido: boolean;
}

function linha(rotulo: string, valor: string, folhas: [string, string][]): LinhaAninhada {
  return {
    rotulo,
    valor,
    folhas,
    get suprimido() {
      return valor === MARCA_SUPRIMIDO;
    },
  };
}

/**
 * Distribuição com margem: o total do grupo É a margem das células dele.
 *
 * Três regras, e cada uma fecha uma das portas:
 * 1. **Secundária DENTRO do grupo** — senão o total do campus menos as
 *    visíveis devolve exatamente a escondida.
 * 2. **Total suprimido não convive com folha visível** — somar as folhas o
 *    devolveria.
 * 3. **Nunca UM total sozinho** — a mesma lógica da secundaria, um nível acima.
 */
export function suprimir_aninhado(grupos: Record<string, Contagens>, pode_ver: boolean): LinhaAninhada[] {
  const totais: Contagens = {};
  for (const [rotulo, folhas] of Object.entries(grupos)) {
    totais[rotulo] = Object.values(folhas).reduce((a, b) => a + b, 0);
  }
  if (pode_ver) {
    return Object.keys(grupos).map((rotulo) =>
      linha(
        rotulo,
        String(totais[rotulo]),
        Object.entries(grupos[rotulo]!).map(([k, v]) => [k, String(v)] as [string, string]),
      ),
    );
  }
  const marcadas: Record<string, Set<string>> = {};
  for (const [rotulo, folhas] of Object.entries(grupos)) marcadas[rotulo] = _com_secundaria(folhas, _primarias(folhas));
  // grupo de folha única: o total É a folha, então esconder só a folha não
  // esconde nada
  let marcados_grupo = new Set([
    ..._primarias(totais),
    ...Object.entries(marcadas)
      .filter(([, m]) => m.size === 1)
      .map(([r]) => r),
  ]);
  marcados_grupo = _com_secundaria(totais, marcados_grupo);
  for (const rotulo of marcados_grupo) marcadas[rotulo] = new Set(Object.keys(grupos[rotulo]!));

  const formatados = _formatar(totais, marcados_grupo);
  return Object.keys(grupos).map((rotulo) =>
    linha(rotulo, formatados[rotulo]!, Object.entries(_formatar(grupos[rotulo]!, marcadas[rotulo]!))),
  );
}

rotas.get("/relatorios", async (c) => {
  const usuario = await usuarioCom(c, "indicador.ver");
  const tx = c.get("tx");
  const bruto = c.req.query("exercicio") ?? "";
  const ano = /^\d+$/.test(bruto) && Number(bruto) ? Number(bruto) : Number(datas_br.hoje().slice(0, 4));

  const por_unidade: Contagens = {};
  for (const p of await tx.query.processo.findMany({ with: { unidade: true }, orderBy: [asc(processo.id)] })) {
    const nome = p.unidade ? p.unidade.nome_extenso : "(sem unidade)";
    por_unidade[nome] = (por_unidade[nome] ?? 0) + 1;
  }

  const por_risco: Contagens = {};
  for (const parecer of await tx.query.parecer_tecnico.findMany({
    with: {
      exposicoes: { with: { agente_nocivo: { with: { tipo_risco: true } } }, orderBy: (e, { asc: a }) => [a(e.id)] },
    },
    orderBy: [asc(parecer_tecnico.id)],
  })) {
    const principal = parecer.exposicoes.find((e) => e.principal);
    if (principal) {
      const nome = principal.agente_nocivo.tipo_risco.nome;
      por_risco[nome] = (por_risco[nome] ?? 0) + 1;
    }
  }

  const anos = [
    ...new Set((await tx.selectDistinct({ ano: parecer_tecnico.ano }).from(parecer_tecnico)).map((l) => l.ano)),
  ].sort((a, b) => a - b);
  const lacunas: Record<string, number[]> = {};
  for (const a of anos) lacunas[a] = await lacunas_de_numeracao(tx, a);

  const hoje = datas_br.hoje();
  const laudos_fila: [unknown, number | null][] = [];
  for (const laudo of await tx.query.laudo_tecnico.findMany({
    where: eq(laudo_tecnico.status, "VIGENTE"),
    with: { unidade: true },
    orderBy: [asc(laudo_tecnico.id)],
  })) {
    const meses = laudo.data_ultima_conferencia ? datas_br.meses_entre(laudo.data_ultima_conferencia, hoje) : null;
    if (laudo.data_ultima_conferencia === null || meses! > 24) laudos_fila.push([laudo, meses]);
  }

  const vigencias_por_laudo: Contagens = {};
  for (const v of await tx.query.adicional_vigencia.findMany({
    where: eq(adicional_vigencia.estado, "VIGENTE"),
    with: { parecer: { with: { laudo: true } } },
    orderBy: [asc(adicional_vigencia.id)],
  })) {
    const laudo = v.parecer ? v.parecer.laudo : null;
    const chave = laudo ? laudo.numero_siape : "(sem laudo)";
    vigencias_por_laudo[chave] = (vigencias_por_laudo[chave] ?? 0) + 1;
  }

  return pagina(c, "paginas/relatorios.html", usuario, {
    exercicio: ano,
    por_unidade: dicionario(suprimir(por_unidade, usuario.ve_dado_nominal)),
    por_risco: dicionario(suprimir(por_risco, usuario.ve_dado_nominal)),
    lacunas: dicionario(lacunas),
    laudos_fila,
    vigencias_por_laudo: dicionario(vigencias_por_laudo),
    rodape_fila: RODAPE_FILA_LAUDOS,
    limiar: LIMIAR_SUPRESSAO,
  });
});

/** O `csv.writer(delimiter=";")` do Python: aspas só quando precisa. */
export function linha_csv(campos: unknown[]): string {
  return (
    campos
      .map((v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      })
      .join(";") + "\r\n"
  );
}

rotas.get("/relatorios/exportar-processos", async (c) => {
  const usuario = await usuarioCom(c, "exportar");
  const tx = c.get("tx");
  const filtro = new repo.Filtro({
    q: c.req.query("q") || null,
    estado: c.req.query("estado") || null,
    por_pagina: 100000,
  });
  const [itens] = await repo.listar(tx, usuario, filtro);

  let texto = linha_csv(["NUP", "Estado", "Servidor", "SIAPE", "Unidade", "Responsável", "Autuação", "Prazo"]);
  const nominal = usuario.ve_dado_nominal;
  for (const p of itens) {
    texto += linha_csv([
      p.nup,
      p.estado_tecnico,
      nominal ? (p.servidor ? p.servidor.nome : "") : MARCA_SUPRIMIDO,
      nominal ? (p.servidor ? p.servidor.siape : "") : MARCA_SUPRIMIDO,
      p.unidade ? p.unidade.nome_extenso : "",
      p.responsavel ? p.responsavel.nome : "",
      p.data_autuacao ?? "",
      p.prazo ?? "",
    ]);
  }
  marcarDownload(c);
  return c.body("﻿" + texto, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="processos.csv"',
  });
});
