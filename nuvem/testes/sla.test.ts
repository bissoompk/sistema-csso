/**
 * SLA configurável (RN-16) e checklist modelo — cada teste com banco próprio.
 * Porte das partes de `test_pendencias_e_sla.py`.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { agora_utc } from "../src/db/esquema/base.js";
import { ChecklistModelo } from "../src/dominio/dominios.js";
import { SLA_PADRAO, aplicar_checklist_modelo, gravar_sla, resumir, sla_vigente } from "../src/servicos/processo.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo } from "./ajuda";
import { atores, cenario } from "./ajuda_processos";

await bancoLimpo();

describe("SLA configurável (RN-16) e checklist modelo", () => {
  it("SLA cai no padrão sem configuração", async () => {
    const { db: limpo } = await bancoLimpo();
    expect(await sla_vigente(limpo)).toEqual(SLA_PADRAO);
  });

  it("gravar SLA muda o alerta; zero desliga; ignora o inválido; exige permissão", async () => {
    const { db: limpo } = await bancoLimpo();
    const { COORDENADOR } = await atores(limpo);
    const c = await cenario(limpo);
    await limpo
      .update(e.processo)
      .set({ estado_tecnico: "EM_TRIAGEM", entrou_na_etapa_em: new Date(agora_utc().getTime() - 10 * 86_400_000) })
      .where(eq(e.processo.id, c.processo_id));
    const processo = (await limpo.select().from(e.processo).where(eq(e.processo.id, c.processo_id)))[0]!;
    expect((await resumir(limpo, processo)).atrasado).toBe(false); // padrão A_FAZER = 15
    await gravar_sla(limpo, { A_FAZER: 5 }, COORDENADOR);
    expect((await sla_vigente(limpo)).A_FAZER).toBe(5);
    expect((await resumir(limpo, processo)).atrasado).toBe(true);
    const [ev] = await limpo.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "SLA_ALTERADO"));
    expect(ev!.descricao).toBe("SLA de A_FAZER: 15 -> 5 dias");

    await gravar_sla(limpo, { A_FAZER: 0 }, COORDENADOR);
    expect((await resumir(limpo, processo)).atrasado).toBe(false);

    await gravar_sla(limpo, { COLUNA_QUE_NAO_EXISTE: 3 }, COORDENADOR);
    await limpo.update(e.parametro).set({ valor: "não é número" }).where(eq(e.parametro.chave, "sla.A_FAZER"));
    expect((await sla_vigente(limpo)).A_FAZER).toBe(SLA_PADRAO.A_FAZER);

    const sem = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["processo.ver"], perfis: [] });
    await expect(gravar_sla(limpo, { A_FAZER: 1 }, sem)).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("aplicar checklist modelo é idempotente e entra no resumo", async () => {
    const { db: limpo } = await bancoLimpo();
    const { COORDENADOR } = await atores(limpo);
    const c = await cenario(limpo);
    const [modelo] = await limpo
      .insert(e.checklist_modelo)
      .values({ nome: "Instrução do adicional", itens: "Portaria de localização\nFormulário do art. 17\nInspeção realizada" })
      .returning();
    const processo = (await limpo.select().from(e.processo).where(eq(e.processo.id, c.processo_id)))[0]!;
    const chk = await aplicar_checklist_modelo(limpo, processo, modelo!, COORDENADOR);
    const itens = await limpo.select().from(e.checklist_item).where(eq(e.checklist_item.checklist_id, chk.id)).orderBy(e.checklist_item.ordem);
    expect(itens).toHaveLength(3);
    expect(itens[0]!.descricao).toBe("Portaria de localização");
    const de_novo = await aplicar_checklist_modelo(limpo, processo, modelo!, COORDENADOR);
    expect(de_novo.id).toBe(chk.id);
    const resumo = await resumir(limpo, processo);
    expect([resumo.checklist_total, resumo.checklist_feitos]).toEqual([3, 0]);
  });

  it("modelo ignora linhas vazias", () => {
    expect(ChecklistModelo.lista_de_itens({ itens: "  a  \n\n\n  b\n   \n" })).toEqual(["a", "b"]);
  });

});
