/**
 * Pendências (RN-06) — o serviço e o sino.
 * Porte das partes de serviço de `test_pendencias_e_sla.py` e das regras de
 * quem vê e quem fecha. A TELA /pendencias é do porte de Processos; o sino que
 * decora toda tela é ligado por `servicos/pendencias.ts` e é conferido aqui em
 * /demandas.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as pendencias from "../src/servicos/pendencias.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type AmbienteDeTeste } from "./ajuda";

const HOJE = hoje_iso();
let amb: AmbienteDeTeste = await bancoLimpo();
let coord: UsuarioAtual;
beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  coord = await usuarioAtual(amb.db, "coordenador_csso");
});

const conta = (permissoes: string[], perfis: string[] = [], id = 999_999) =>
  new UsuarioAtual({ id, login: "x", nome: "x", permissoes, perfis });

describe("abrir, concluir, reabrir", () => {
  it("abrir é idempotente pela chave", async () => {
    const primeira = await pendencias.abrir(amb.db, { tipo: "CONFERIR_LAUDO", chave: "conferir:laudo:1", descricao: "Conferir o laudo", usuario: coord });
    const segunda = await pendencias.abrir(amb.db, { tipo: "CONFERIR_LAUDO", chave: "conferir:laudo:1", descricao: "outro texto", usuario: coord });
    expect(segunda.id).toBe(primeira.id);
    expect(await amb.db.select().from(e.pendencia)).toHaveLength(1);
  });

  it("o prazo padrão vem do tipo", async () => {
    const p = await pendencias.abrir(amb.db, { tipo: "INCLUIR_NO_SEI", chave: "sei:x", descricao: "incluir", usuario: coord });
    expect(p.prazo).toBe(somar_dias(HOJE, pendencias.TIPOS.INCLUIR_NO_SEI![1]));
    expect(p.responsavel_id).toBe(coord.id);
  });

  it("atrasada, conclusão e contagem do sino", async () => {
    const p = await pendencias.abrir(amb.db, { tipo: "CONFERIR_LAUDO", chave: "c:1", descricao: "x", usuario: coord, prazo: somar_dias(HOJE, -1) });
    expect(pendencias.atrasada(p)).toBe(true);
    expect(await pendencias.contar_abertas(amb.db, coord)).toEqual([1, 1]);
    await pendencias.concluir(amb.db, p, coord);
    expect(p.concluida && p.concluida_em).toBeTruthy();
    expect(pendencias.atrasada(p)).toBe(false);
    expect(await pendencias.contar_abertas(amb.db, coord)).toEqual([0, 0]);
    // concluir de novo não muda nada
    await pendencias.concluir(amb.db, p, coord);
    const eventos = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "PENDENCIA_CONCLUIDA"));
    expect(eventos).toHaveLength(1);
  });

  it("reabrir devolve a MESMA tarefa, e a ida e a volta ficam na trilha", async () => {
    const p = await pendencias.abrir(amb.db, { tipo: "EPI_SEM_ESTOQUE", chave: "epi:1", descricao: "sem estoque", usuario: coord });
    await pendencias.concluir(amb.db, p, coord);
    await pendencias.reabrir(amb.db, p, coord, "a reserva foi solta");
    const [linha] = await amb.db.select().from(e.pendencia).where(eq(e.pendencia.id, p.id));
    expect([linha!.concluida, linha!.concluida_em, linha!.concluida_por]).toEqual([false, null, null]);
    const tipos = (await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "pendencia"))).map((x) => x.tipo_evento);
    expect(tipos).toEqual(["PENDENCIA_ABERTA", "PENDENCIA_CONCLUIDA", "PENDENCIA_REABERTA"]);
  });

  it("a rotina fecha sem pôr o nome de ninguém", async () => {
    const p = await pendencias.abrir(amb.db, { tipo: "CA_A_VENCER", chave: "ca:1", descricao: "CA vence" });
    await pendencias.concluir_pela_rotina(amb.db, p, "o CA foi renovado");
    expect(p.concluida_por).toBeNull();
    const [ev] = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "PENDENCIA_CONCLUIDA"));
    expect(ev!.usuario_nome).toBe("rotina de varredura");
    expect(ev!.descricao).toContain("o CA foi renovado");
  });

  it("meia âncora é recusada", async () => {
    await expect(pendencias.abrir(amb.db, { tipo: "X", chave: "k", descricao: "d", entidade: "demanda" })).rejects.toThrow(/andam juntos/);
  });

  it("os tipos que ainda não nascem continuam declarados, e todo rótulo é legível", () => {
    for (const t of ["CONFERIR_LAUDO", "REGISTRO_DE_OPCAO", "CONFLITO_NUMERACAO", "DEMANDA_COM_PRAZO"]) {
      expect(pendencias.TIPOS).toHaveProperty(t);
    }
    expect(Object.values(pendencias.TIPOS).every(([rotulo]) => rotulo.trim())).toBe(true);
  });

  it("a fila ordena por prazo, e sem prazo vai para o fim", async () => {
    await pendencias.abrir(amb.db, { tipo: "X", chave: "a", descricao: "a", usuario: coord, prazo: somar_dias(HOJE, 5) });
    await pendencias.abrir(amb.db, { tipo: "X", chave: "b", descricao: "b", usuario: coord, prazo: somar_dias(HOJE, -5) });
    const lista = await pendencias.abertas(amb.db, coord);
    expect(lista.map((p) => p.chave)).toEqual(["b", "a"]);
  });
});

describe("quem vê e quem fecha", () => {
  it("vê quem opera algum módulo; admin_ti não", () => {
    expect(pendencias.pode_ver(conta(["processo.ver"]))).toBe(true);
    expect(pendencias.pode_ver(conta(["epi.ver"]))).toBe(true);
    expect(pendencias.pode_ver(conta(["demanda.ver"]))).toBe(true);
    expect(pendencias.pode_ver(conta(["indicador.ver", "auditoria.ver"]))).toBe(false);
    expect(pendencias.pode_ver(null)).toBe(false);
    expect(() => pendencias.exigir_ver(conta(["indicador.ver"]))).toThrow(PermissaoNegada);
  });

  it("o dono fecha a própria tarefa sem permissão de escrita; a dos outros pede escrita", () => {
    const leitor = conta(["demanda.ver"], [], 42);
    expect(pendencias.pode_concluir(leitor, { responsavel_id: 42 })).toBe(true);
    expect(pendencias.pode_concluir(leitor, { responsavel_id: 7 })).toBe(false);
    expect(pendencias.pode_concluir(conta(["processo.ver", "processo.editar"]), { responsavel_id: 7 })).toBe(true);
    expect(() => pendencias.exigir_concluir(leitor, { responsavel_id: 7 })).toThrow(/escrita no módulo/);
  });

  it("o escopo próprio só vê o que a regra atribuiu a ele", async () => {
    const titular = await usuarioAtual(amb.db, "servidor_consulta");
    await pendencias.abrir(amb.db, { tipo: "X", chave: "dele", descricao: "dele", responsavel_id: titular.id });
    await pendencias.abrir(amb.db, { tipo: "X", chave: "do setor", descricao: "Entregue a Fulano de Tal", usuario: coord });
    expect((await pendencias.abertas(amb.db, titular)).map((p) => p.chave)).toEqual(["dele"]);
    expect(await pendencias.abertas(amb.db, coord)).toHaveLength(2);
    expect((await pendencias.abertas(amb.db, coord, true)).map((p) => p.chave)).toEqual(["do setor"]);
  });

  it("titular_de acha o servidor pela âncora e cai em null no resto", async () => {
    const p = await pendencias.abrir(amb.db, { tipo: "X", chave: "sem", descricao: "d", entidade: "demanda", entidade_id: 1 });
    const mapa = await pendencias.titular_de(amb.db, [p]);
    expect(mapa.get(p.id)).toBeNull();
  });
});

describe("o sino na casca", () => {
  it("conta de verdade, pela transação da requisição", async () => {
    for (const n of [1, 2, 3]) {
      await pendencias.abrir(amb.db, { tipo: "INCLUIR_NO_SEI", chave: `sino:${n}`, descricao: `incluir ${n}`, usuario: coord });
    }
    await entrar(amb.cliente, "coordenador_csso");
    const corpo = (await amb.cliente.get("/demandas")).text;
    expect(corpo).toContain('class="sino');
    expect(corpo).toContain('<span class="contador">3</span>');
  });

  it("quem não vê pendências não ganha o sino", async () => {
    await entrar(amb.cliente, "admin_ti");
    expect((await amb.cliente.get("/usuarios")).text).not.toContain('class="sino');
  });
});
