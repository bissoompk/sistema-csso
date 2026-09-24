/** Porte de `app/rotas/pareceres.py`. (ainda não portado) */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";

export const rotas = new Hono<Ambiente>();
