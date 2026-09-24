/**
 * A protecao contra deriva da trava da ficha de EPI (o teste que o Python tinha
 * ao lado de `_FICHA_CONGELADA`), mais as duas conferencias de "duas listas do
 * mesmo conjunto" que o porte criou.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { ROTULO_ESTADO, ROTULO_ESTADO_TELA, ESTADOS_PROCESSO } from '../../src/dominio/estados';
import { epi_ficha_registro } from '../../src/db/esquema';
import { FICHA_COMPLETAVEL, FICHA_CONGELADA, TRIGGERS } from '../../src/db/travas';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const travas = readFileSync(path.join(aqui, '../../src/db/travas.sql'), 'utf8');

describe('trava da ficha de EPI', () => {
  it('toda coluna da ficha e congelada OU completavel, e nenhuma e as duas', () => {
    const colunas = Object.values(getTableColumns(epi_ficha_registro)).map((c) => c.name).sort();
    const declaradas = [...FICHA_CONGELADA, ...FICHA_COMPLETAVEL].sort();
    expect(declaradas).toEqual(colunas);
    expect(new Set(declaradas).size).toBe(declaradas.length);
  });

  it('cada congelada aparece na funcao com IS DISTINCT FROM', () => {
    for (const coluna of FICHA_CONGELADA) {
      expect(travas).toContain(`NEW.${coluna} IS DISTINCT FROM OLD.${coluna}`);
    }
  });

  it('cada completavel so se preenche uma vez (de nulo para valor)', () => {
    for (const coluna of FICHA_COMPLETAVEL) {
      expect(travas).toContain(`(OLD.${coluna} IS NOT NULL AND NEW.${coluna} IS DISTINCT FROM OLD.${coluna})`);
    }
  });

  it('toda trigger listada e criada em travas.sql, e nenhuma a mais', () => {
    const criadas = [...travas.matchAll(/^CREATE TRIGGER (\w+)/gm)].map((m) => m[1]);
    expect(criadas).toEqual([...TRIGGERS]);
  });
});

describe('rotulos do processo', () => {
  it('o mapa ASCII e o da tela tem as mesmas chaves, e cobrem todos os estados', () => {
    expect(Object.keys(ROTULO_ESTADO_TELA).sort()).toEqual(Object.keys(ROTULO_ESTADO).sort());
    expect(Object.keys(ROTULO_ESTADO).sort()).toEqual([...ESTADOS_PROCESSO].sort());
  });
});
