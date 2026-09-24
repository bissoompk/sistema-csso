/** Metodos de `app/modelos/demanda.py`. */

import { hoje_iso } from './datas';

export const Demanda = {
  /**
   * Vermelho na tela. A regra e a mesma de `Pendencia.atrasada`, e e de
   * proposito: a demanda com prazo aparece no MESMO sino, e duas contas de
   * atraso divergentes fariam a fila e a lista discordarem sobre a mesma linha.
   */
  atrasada(demanda: { estado: string; prazo: string | null }, hoje: string = hoje_iso()): boolean {
    if (demanda.estado === 'ENCERRADA' || demanda.prazo === null) return false;
    return demanda.prazo < hoje;
  },
};
