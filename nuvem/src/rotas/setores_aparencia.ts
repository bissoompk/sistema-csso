/**
 * NUVEM (Portal do servidor, 22/10/2026): a cor e o ícone do setor promotor,
 * escolhidos na tela de Treinamentos → Setores promotores. A tela (GET) é a de
 * `treinamentos.ts`; aqui fica só o POST da aparência.
 *
 * A paleta é FECHADA (`dominio/organizacao.ts`): o popup oferece só as chaves
 * de `CORES_SETOR`/`ICONES_SETOR`, e o serviço recusa qualquer outra — quem
 * forjar um valor recebe o aviso, não um 500 do CHECK do banco. Vazio é a cor
 * do sistema (e, no ícone, selo sem ícone).
 */
import { Hono } from "hono";
import type { Ambiente } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import {
  CORES_SETOR,
  ICONES_SETOR,
  ROTULO_COR_SETOR,
  ROTULO_ICONE_SETOR,
} from "../dominio/organizacao.js";
import * as setor_promotor from "../servicos/setor_promotor.js";
import { global } from "../web.js";
import { erro as _erro, volta as _volta } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

/**
 * As opções do popup "Aparência", para o template da tela de setores (que é
 * montada em `treinamentos.ts`): global, para a lista vir sempre do domínio e
 * nunca de uma cópia escrita à mão no HTML.
 */
export const PALETA_SETOR = {
  cores: CORES_SETOR.map((valor) => ({ valor, rotulo: ROTULO_COR_SETOR[valor] })),
  icones: ICONES_SETOR.map((valor) => ({ valor, rotulo: ROTULO_ICONE_SETOR[valor] })),
} as const;
global("PALETA_SETOR", PALETA_SETOR);

/** `""` (ou só espaços) é "do sistema"; o resto vai como veio, para o serviço julgar. */
function _escolha(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

rotas.post(`${setor_promotor.TELA}/:unidade_id{[0-9]+}/aparencia`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(setor_promotor.PERMISSAO);
  const f = await formulario(c);
  const unidade_id = Number(c.req.param("unidade_id"));
  try {
    const u = await setor_promotor.definir_aparencia(
      c.get("tx"),
      usuario,
      unidade_id,
      _escolha(f.texto("cor")),
      _escolha(f.texto("icone")),
    );
    const cor = u.cor_setor ? ROTULO_COR_SETOR[u.cor_setor as keyof typeof ROTULO_COR_SETOR] : "a cor do sistema";
    return _volta(
      c,
      setor_promotor.TELA,
      `Aparência de ${u.sigla ?? u.nome_extenso} gravada (${cor.toLowerCase()}` +
        `${u.icone_setor ? `, ${ROTULO_ICONE_SETOR[u.icone_setor as keyof typeof ROTULO_ICONE_SETOR].toLowerCase()}` : ", sem ícone"}). ` +
        "Vale para o selo do setor nos certificados e no portal do servidor.",
    );
  } catch (e) {
    if (e instanceof setor_promotor.SetorPromotorRecusado) return _erro(c, setor_promotor.TELA, e.message);
    throw e;
  }
});
