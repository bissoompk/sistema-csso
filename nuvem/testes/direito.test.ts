/**
 * Máquina B — o direito concedido. RN-09 e RN-21.
 * Porte de `testes/integracao/test_direito.py`, mais as rotas de `/adicionais`.
 *
 * Os testes de serviço rodam numa transação desfeita no fim (`desfeita`); os
 * de rota, num banco novo por teste.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Executor } from "../src/db/cliente.js";
import * as direito from "../src/servicos/direito.js";
import * as servico_parecer from "../src/servicos/parecer.js";
import type { ParecerCompleto } from "../src/servicos/parecer.js";
import { TransicaoInvalida } from "../src/dominio/estados.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, naTransacao, type AmbienteDeTeste } from "./ajuda";
import { atores, cenario, desfeita, erroNoSavepoint, parecerDe, type Atores, type Cenario } from "./ajuda_processos";

const { db } = await bancoLimpo();

/** O fixture `emitido`: o cenário do 1/2025, emitido. */
function comEmitido(f: (tx: Executor, coord: UsuarioAtual, c: Cenario, p: ParecerCompleto, a: Atores) => Promise<void>) {
  return desfeita(db, async (tx) => {
    const a = await atores(tx);
    const c = await cenario(tx);
    const p = await parecerDe(tx, c.parecer_id);
    await servico_parecer.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
    await f(tx, a.COORDENADOR, c, p, a);
  });
}

const PORTARIA = { portaria_concessao: "Portaria 1", data_portaria: "2025-01-02", data_inicio: "2025-01-01" };

/** Um segundo parecer do mesmo servidor, para testar a não acumulação. */
async function segundo_parecer(tx: Executor, original: ParecerCompleto): Promise<ParecerCompleto> {
  const [novo] = await tx
    .insert(e.parecer_tecnico)
    .values({
      numero: 99,
      ano: 2025,
      situacao: "EMITIDO",
      processo_id: original.processo_id,
      servidor_id: original.servidor_id,
      laudo_id: original.laudo_id,
      tipo_adicional_id: original.tipo_adicional_id,
      tipo_movimento_id: original.tipo_movimento_id,
      unidade_uorg_id: original.unidade_uorg_id,
      portaria_id: original.portaria_id,
      destinatario_id: original.destinatario_id,
      signatario_id: original.signatario_id,
      tipo_marco_id: original.tipo_marco_id,
      data_marco_inicial: original.data_marco_inicial,
      data_emissao: original.data_emissao,
      texto_recomendacao: original.texto_recomendacao,
    })
    .returning();
  const x = original.exposicoes[0]!;
  await tx.insert(e.exposicao).values({
    parecer_id: novo!.id,
    agente_nocivo_id: x.agente_nocivo_id,
    percentual_id: x.percentual_id,
    fundamentacao_id: x.fundamentacao_id,
    principal: true,
  });
  return parecerDe(tx, novo!.id);
}

async function eventos(tx: Executor, tipo: string) {
  return tx.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, tipo));
}

describe("máquina B (serviço)", () => {
  it("propor a partir do parecer — idempotente", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      expect(v.estado).toBe("PROPOSTO");
      expect(v.servidor_id).toBe(p.servidor_id);
      expect(v.percentual_id).toBe(p.exposicoes[0]!.percentual_id);
      expect((await direito.propor(tx, p, coord)).id).toBe(v.id);
    }));

  it("propor exige parecer emitido", () =>
    desfeita(db, async (tx) => {
      const a = await atores(tx);
      const c = await cenario(tx);
      await expect(direito.propor(tx, await parecerDe(tx, c.parecer_id), a.COORDENADOR)).rejects.toThrow(
        /emitido ou assinado/,
      );
    }));

  it("propor recusa movimento que não gera direito", () =>
    comEmitido(async (tx, coord, c) => {
      const [cancelamento] = await tx.select().from(e.tipo_movimento).where(eq(e.tipo_movimento.codigo, "CANCELAMENTO"));
      await tx
        .update(e.parecer_tecnico)
        .set({ tipo_movimento_id: cancelamento!.id })
        .where(eq(e.parecer_tecnico.id, c.parecer_id));
      await expect(direito.propor(tx, await parecerDe(tx, c.parecer_id), coord)).rejects.toThrow(/não gera direito/);
    }));

  it("conceder exige a portaria", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await expect(
        direito.conceder(tx, v, coord, { portaria_concessao: "   ", data_portaria: "2025-03-01", data_inicio: "2024-09-17" }),
      ).rejects.toThrow(/portaria de concessão/);
    }));

  it("conceder coloca em vigor", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, {
        portaria_concessao: "Portaria PROGEP nº 120/2025",
        data_portaria: "2025-03-01",
        data_inicio: "2024-09-17",
      });
      expect(v.estado).toBe("VIGENTE");
      expect(v.data_inicio).toBe("2024-09-17");
      expect((await direito.vigente_do_servidor(tx, v.servidor_id))!.id).toBe(v.id);
      expect((await eventos(tx, "DIREITO_VIGENTE")).length).toBeGreaterThan(0);
    }));

  it("RN-09: sem registro de opção não concede o segundo", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const primeiro = await direito.propor(tx, p, coord);
      await direito.conceder(tx, primeiro, coord, {
        portaria_concessao: "Portaria PROGEP nº 1/2025",
        data_portaria: "2025-01-02",
        data_inicio: "2025-01-01",
      });
      const segundo = await direito.propor(tx, await segundo_parecer(tx, p), coord);
      await expect(
        direito.conceder(tx, segundo, coord, {
          portaria_concessao: "Portaria PROGEP nº 2/2025",
          data_portaria: "2025-06-01",
          data_inicio: "2025-06-01",
        }),
      ).rejects.toThrow(/registro de opção/);
      expect(primeiro.estado).toBe("VIGENTE");
      expect(segundo.estado).toBe("PROPOSTO");
    }));

  it("RN-09: com registro de opção encadeia as datas", () =>
    comEmitido(async (tx, coord, _c, p, a) => {
      const primeiro = await direito.propor(tx, p, coord);
      await direito.conceder(tx, primeiro, coord, {
        portaria_concessao: "Portaria PROGEP nº 1/2025",
        data_portaria: "2025-01-02",
        data_inicio: "2025-01-01",
      });
      const segundo = await direito.propor(tx, await segundo_parecer(tx, p), coord);
      const [registro] = await tx
        .insert(e.anexo)
        .values({
          entidade: "adicional_vigencia",
          entidade_id: segundo.id,
          nome_arquivo: "opcao.pdf",
          nome_original: "opcao.pdf",
          mime_type: "application/pdf",
          tamanho_bytes: 10,
          sha256: "f".repeat(64),
          storage_key: "ff/" + "f".repeat(64),
          categoria: "OUTRO",
          enviado_por: a.coord_id,
        })
        .returning();
      await tx
        .update(e.adicional_vigencia)
        .set({ registro_opcao_anexo_id: registro!.id })
        .where(eq(e.adicional_vigencia.id, segundo.id));
      segundo.registro_opcao_anexo_id = registro!.id;

      await direito.conceder(tx, segundo, coord, {
        portaria_concessao: "Portaria PROGEP nº 2/2025",
        data_portaria: "2025-06-01",
        data_inicio: "2025-06-01",
      });
      expect(segundo.estado).toBe("VIGENTE");
      const [anterior] = await tx.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.id, primeiro.id));
      expect(anterior!.estado).toBe("CESSADO");
      // sem lacuna nem sobreposição: o anterior termina na véspera
      expect(anterior!.data_fim).toBe("2025-05-31");
      expect(await direito.lacunas_na_linha_do_tempo(tx, segundo.servidor_id)).toEqual([]);
    }));

  it("o índice único impede dois vigentes", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const primeiro = await direito.propor(tx, p, coord);
      await direito.conceder(tx, primeiro, coord, PORTARIA);
      const erro = await erroNoSavepoint(tx, (sp) =>
        sp.insert(e.adicional_vigencia).values({
          servidor_id: primeiro.servidor_id,
          parecer_id: primeiro.parecer_id,
          tipo_adicional_id: primeiro.tipo_adicional_id,
          percentual_id: primeiro.percentual_id,
          estado: "VIGENTE",
        }),
      );
      const causa = (erro as { cause?: Error } | null)?.cause;
      expect(`${erro?.message} ${causa?.message ?? ""}`).toContain("uq_adicional_vigente");
    }));

  it("RN-21: afastamento legal não cita gestação", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, PORTARIA);
      await direito.suspender_por_afastamento_legal(tx, v, coord);
      expect(v.estado).toBe("SUSPENSO");
      expect(v.motivo_suspensao).toBe("AFASTAMENTO_LEGAL");
      expect(v.base_legal_suspensao).toBe("Lei 8.112/90, art. 69, p.ú.");
      for (const evento of await eventos(tx, "DIREITO_SUSPENSO")) {
        const texto = (evento.descricao || "").toLowerCase();
        for (const proibido of ["gesta", "gravid", "lacta"]) expect(texto).not.toContain(proibido);
      }
    }));

  it("motivo de suspensão fora do enum", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, PORTARIA);
      await expect(direito.suspender(tx, v, coord, { motivo: "GESTACAO" })).rejects.toThrow(
        /motivo de suspensão inválido/,
      );
    }));

  it("retomar depois de suspender", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, PORTARIA);
      await direito.suspender(tx, v, coord, { motivo: "AFASTAMENTO_DO_LOCAL" });
      await direito.retomar(tx, v, coord, "2025-08-01");
      expect(v.estado).toBe("VIGENTE");
      expect(v.motivo_suspensao).toBeNull();
      const [gravado] = await tx.select().from(e.adicional_vigencia).where(eq(e.adicional_vigencia.id, v.id));
      expect(gravado!.estado).toBe("VIGENTE");
      expect(gravado!.data_inicio).toBe("2025-08-01");
    }));

  it("cessar recusa data anterior ao início", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, { ...PORTARIA, data_inicio: "2025-06-01" });
      await expect(direito.cessar(tx, v, coord, { data_fim: "2025-01-01" })).rejects.toThrow(/anterior ao início/);
    }));

  it("cessado é terminal", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.cessar(tx, v, coord, { data_fim: "2025-12-31" });
      expect(v.estado).toBe("CESSADO");
      await expect(direito.retomar(tx, v, coord, "2026-01-01")).rejects.toBeInstanceOf(TransicaoInvalida);
    }));

  it("alterar percentual registra o antes e o depois", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, PORTARIA);
      const [insal] = await tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE"));
      const [maximo] = await tx
        .select()
        .from(e.percentual_aplicavel)
        .where(and(eq(e.percentual_aplicavel.tipo_adicional_id, insal!.id), eq(e.percentual_aplicavel.grau, "MAXIMO")));
      const anterior = v.percentual_id;
      await direito.alterar(tx, v, coord, { percentual_id: maximo!.id, motivo: "nova quantificação" });
      expect(v.percentual_id).toBe(maximo!.id);
      const [evento] = await eventos(tx, "DIREITO_ALTERADO");
      expect(evento!.valor_anterior).toBe(anterior);
      expect(evento!.valor_novo).toBe(maximo!.id);
    }));

  it("reavaliar abre pendência", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const v = await direito.propor(tx, p, coord);
      await direito.conceder(tx, v, coord, PORTARIA);
      await direito.reavaliar(tx, v, coord, "mudança de layout do laboratório");
      expect(v.estado).toBe("EM_REAVALIACAO");
      const [pend] = await tx.select().from(e.pendencia).where(eq(e.pendencia.tipo, "REAVALIACAO_LAUDO"));
      expect(pend).toBeTruthy();
      expect(pend!.concluida).toBe(false);
    }));

  it("sem permissão não propõe", () =>
    comEmitido(async (tx, _coord, _c, p) => {
      const consulta = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["parecer.ver"], perfis: [] });
      await expect(direito.propor(tx, p, consulta)).rejects.toBeInstanceOf(PermissaoNegada);
    }));

  it("lacuna na linha do tempo é detectada", () =>
    comEmitido(async (tx, coord, _c, p) => {
      const primeiro = await direito.propor(tx, p, coord);
      await direito.conceder(tx, primeiro, coord, PORTARIA);
      await direito.cessar(tx, primeiro, coord, { data_fim: "2025-03-31" });
      const segundo = await direito.propor(tx, await segundo_parecer(tx, p), coord);
      await direito.conceder(tx, segundo, coord, {
        portaria_concessao: "Portaria 2",
        data_portaria: "2025-06-01",
        data_inicio: "2025-06-01",
      });
      const problemas = await direito.lacunas_na_linha_do_tempo(tx, segundo.servidor_id);
      expect(problemas.some((x) => x.includes("lacuna"))).toBe(true);
    }));
});

// =====================================================================
// As rotas de /adicionais
// =====================================================================
describe("rotas de /adicionais", () => {
  let amb: AmbienteDeTeste;
  let ids: Cenario & { parecer: number };

  beforeEach(async () => {
    amb = await bancoLimpo();
    await contas(amb.db);
    ids = await naTransacao(async (tx) => {
      const a = await atores(tx);
      const c = await cenario(tx);
      const p = await parecerDe(tx, c.parecer_id);
      await servico_parecer.emitir(tx, p, a.COORDENADOR, { gerar_pdf: false });
      return { ...c, parecer: p.id };
    });
  });

  it("propor, conceder, suspender, retomar, alterar e cessar pela tela", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    let r = await cliente.get("/adicionais");
    expect(r.text).toContain("Pareceres emitidos sem direito registrado");
    r = await cliente.post(`/adicionais/propor/${ids.parecer}`, {}, { seguir: false });
    expect(decodeURIComponent(r.location!.replaceAll("+", " "))).toContain("Direito proposto a partir de");
    const [v] = await amb.db.select().from(e.adicional_vigencia);
    expect(v!.estado).toBe("PROPOSTO");

    r = await cliente.post(
      `/adicionais/${v!.id}/conceder`,
      { portaria_concessao: "Portaria PROGEP nº 1/2025", data_portaria: "2025-01-02", data_inicio: "2025-01-01" },
      { seguir: false },
    );
    expect(decodeURIComponent(r.location!.replaceAll("+", " "))).toContain("Adicional em vigor.");
    r = await cliente.post(`/adicionais/${v!.id}/suspender`, { motivo: "GESTACAO" }, { seguir: false });
    expect(decodeURIComponent(r.location!.replaceAll("+", " "))).toContain("motivo de suspensão inválido");
    r = await cliente.post(`/adicionais/${v!.id}/suspender`, { motivo: "AFASTAMENTO_DO_LOCAL" }, { seguir: false });
    expect(r.location).toContain("mensagem=");
    r = await cliente.post(`/adicionais/${v!.id}/retomar`, { data_inicio: "2025-08-01" }, { seguir: false });
    expect(r.location).toContain("mensagem=");
    const [maximo] = await amb.db.select().from(e.percentual_aplicavel).where(eq(e.percentual_aplicavel.grau, "MAXIMO"));
    r = await cliente.post(`/adicionais/${v!.id}/alterar`, { percentual_id: maximo!.id, motivo: "nova medição" }, { seguir: false });
    expect(r.location).toContain("mensagem=");
    r = await cliente.post(`/adicionais/${v!.id}/cessar`, { data_fim: "2025-12-31" }, { seguir: false });
    expect(r.location).toContain("mensagem=");
    const [fim] = await amb.db.select().from(e.adicional_vigencia);
    expect(fim!.estado).toBe("CESSADO");
    // cessado é terminal: a tela devolve a recusa da máquina
    r = await cliente.post(`/adicionais/${v!.id}/retomar`, { data_inicio: "2026-01-01" }, { seguir: false });
    expect(r.location).toContain("erro=");
    const tela = await cliente.get("/adicionais?estado=CESSADO");
    expect(tela.status).toBe(200);
    expect(tela.text).toContain("cessado");
  });

  it("vigência inexistente volta com a frase, e quem não emite recebe 403", async () => {
    const cliente = await entrar(amb.novoCliente(), "coordenador_csso");
    const r = await cliente.post("/adicionais/999999/cessar", { data_fim: "2025-12-31" }, { seguir: false });
    expect(decodeURIComponent(r.location!.replaceAll("+", " "))).toContain("Adicional não encontrado.");
    const secretaria = await entrar(amb.novoCliente(), "secretaria_csso");
    const negado = await secretaria.post(`/adicionais/propor/${ids.parecer}`, {}, { seguir: false });
    expect(negado.status).toBe(403);
  });

  it("/adicionais exige processo.ver (admin_ti não entra)", async () => {
    const admin = await entrar(amb.novoCliente(), "admin_ti");
    expect((await admin.get("/adicionais", { cabecalhos: { accept: "text/html" } })).status).toBe(403);
  });
});
