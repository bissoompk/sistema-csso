/**
 * Os indicadores do módulo de acidentes (fatia F8): a tela e o CSV. A regra e a
 * supressão (RN-19, n<5) moram em `servicos/acidente_indicadores`. A permissão
 * vem ANTES do período: quem não pode recebe 403, e não o 422 de uma data torta.
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { linha_csv } from "../servicos/csv.js";
import * as indicadores from "../servicos/acidente_indicadores.js";
import { marcarDownload, pagina } from "../web.js";
import { hoje } from "../servicos/datas_br.js";
import * as acidentes from "./acidentes.js";
import { periodo_da_consulta } from "./epi_indicadores.js";

export const rotas = new Hono<Ambiente>();

export const INDICADORES = "/acidentes/indicadores";
export const EXPORTAR = "/acidentes/indicadores/exportar";

function _periodo(c: import("../nucleo/contexto.js").Ctx) {
  return periodo_da_consulta({ exercicio: c.req.query("exercicio"), inicio: c.req.query("inicio"), fim: c.req.query("fim") });
}

rotas.get(INDICADORES, async (c) => {
  const usuario = await acidentes.porta(c, "indicador.ver", "acidente.ver");
  const periodo = _periodo(c);
  const dados = await indicadores.calcular(c.get("tx"), usuario, periodo);
  const ano = Number(hoje().slice(0, 4));
  return pagina(c, "paginas/acidentes_indicadores.html", usuario, {
    ind: dados,
    periodo,
    anos: [ano, ano - 1, ano - 2, ano - 3],
    pode_exportar: usuario.pode("exportar"),
  });
});

rotas.get(EXPORTAR, async (c) => {
  const usuario = await acidentes.porta(c, "indicador.ver", "acidente.ver", "exportar");
  const periodo = _periodo(c);
  const d = await indicadores.calcular(c.get("tx"), usuario, periodo);
  // UTF-8 com BOM e ponto e vírgula, como as outras exportações; `linha_csv` neutraliza fórmula
  let corpo = "﻿" + linha_csv(["dimensao", "categoria", "casos"]) + linha_csv(["periodo", `${periodo.inicio} a ${periodo.fim}`, d.total]);
  const bloco = (dimensao: string, valores: Record<string, string>) => {
    for (const [categoria, casos] of Object.entries(valores)) corpo += linha_csv([dimensao, categoria, casos]);
  };
  bloco("ano", d.por_ano);
  bloco("especie", d.por_especie);
  bloco("campus", d.por_campus);
  bloco("unidade", d.por_unidade);
  if (d.afastamento) {
    corpo += linha_csv(["afastamento", "casos com afastamento", d.afastamento.casos]);
    corpo += linha_csv(["afastamento", "dias perdidos", d.afastamento.dias]);
  }
  marcarDownload(c);
  return c.body(new TextEncoder().encode(corpo) as unknown as ArrayBuffer, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="acidentes-indicadores-${periodo.inicio}_a_${periodo.fim}.csv"`,
  });
});
