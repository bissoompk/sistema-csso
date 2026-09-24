/** Porte de `app/rotas/epi_estoque.py`. (ainda não portado) */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";

export const rotas = new Hono<Ambiente>();
