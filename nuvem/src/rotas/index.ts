/**
 * As rotas, na MESMA ordem do `principal.py` — a ordem decide quem casa
 * primeiro quando dois caminhos se sobrepõem.
 */
import type { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { rotas as saude } from "./saude.js";
import { rotas as autenticacao } from "./autenticacao.js";
import { rotas as api } from "./api.js";
import { rotas as aplicativo } from "./aplicativo.js";
import { rotas as celular } from "./celular.js";
import { rotas as validacao } from "./validacao.js";
import { rotas as painel } from "./painel.js";
import { rotas as modulos } from "./modulos.js";
import { rotas as busca } from "./busca.js";
import { rotas as kanban } from "./kanban.js";
import { rotas as processos } from "./processos.js";
import { rotas as pareceres } from "./pareceres.js";
import { rotas as laudos } from "./laudos.js";
import { rotas as adicionais } from "./adicionais.js";
import { rotas as servidores } from "./servidores.js";
import { rotas as catalogos } from "./catalogos.js";
import { rotas as treinamentos } from "./treinamentos.js";
import { rotas as turmas } from "./turmas.js";
import { rotas as certificados } from "./certificados.js";
import { rotas as epis } from "./epis.js";
import { rotas as epi_fichas } from "./epi_fichas.js";
import { rotas as epi_estoque } from "./epi_estoque.js";
import { rotas as epi_requisicoes } from "./epi_requisicoes.js";
import { rotas as epi_indicadores } from "./epi_indicadores.js";
import { rotas as demandas } from "./demandas.js";
import { rotas as usuarios } from "./usuarios.js";
import { rotas as relatorios } from "./relatorios.js";
import { rotas as auditoria } from "./auditoria.js";
import { rotas as configuracao } from "./configuracao.js";
import { rotas as importacao } from "./importacao.js";

export const ROTAS: Hono<Ambiente>[] = [
  saude,
  autenticacao,
  api,
  aplicativo,
  celular,
  validacao,
  painel,
  modulos,
  busca,
  kanban,
  processos,
  pareceres,
  laudos,
  adicionais,
  servidores,
  catalogos,
  treinamentos,
  turmas,
  certificados,
  epis,
  epi_fichas,
  epi_estoque,
  epi_requisicoes,
  epi_indicadores,
  demandas,
  usuarios,
  relatorios,
  auditoria,
  configuracao,
  importacao,
];
