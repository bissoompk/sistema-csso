/**
 * Segundo passe (28/10/2026): a turma concluída sem instrutor que assina ficava
 * sem saída — a emissão era recusada e o vínculo, travado. Agora o instrutor
 * ainda se marca enquanto nenhum certificado saiu da turma; depois do primeiro,
 * vale a regra de sempre (anula e reemite).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Banco } from "../src/db/cliente.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo } from "./ajuda.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";

let db: Banco;
beforeEach(async () => {
  db = (await bancoLimpo()).db;
});

describe("instrutor da turma concluída", () => {
  it("sem certificado emitido, troca-se o instrutor; depois do primeiro certificado, não", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    expect(cen.turma.situacao).toBe("CONCLUIDA");
    expect(await servico_turma.instrutor_mutavel(db, cen.turma)).toBe(true);

    // quem concluiu sem marcar quem assina: desvincula e vincula de novo, sem recusa
    await servico_turma.desvincular_instrutor(db, usuario, cen.turma, cen.instrutor.id);
    expect(cen.turma.instrutores).toHaveLength(0);
    await servico_turma.vincular_instrutor(db, usuario, cen.turma, { ...cen.instrutor, servidor: null } as never);
    expect(cen.turma.instrutores).toHaveLength(1);

    await servico.emitir(db, usuario, cen.inscricao);
    expect(await servico_turma.instrutor_mutavel(db, cen.turma)).toBe(false);
    await expect(servico_turma.desvincular_instrutor(db, usuario, cen.turma, cen.instrutor.id)).rejects.toThrow(
      /Turma encerrada não muda de instrutor/,
    );
  });

  it("a turma em andamento continua mudando de instrutor", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    expect(await servico_turma.instrutor_mutavel(db, { ...cen.turma, situacao: "EM_ANDAMENTO" })).toBe(true);
  });

  it("a turma cancelada nunca muda", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    expect(await servico_turma.instrutor_mutavel(db, { ...cen.turma, situacao: "CANCELADA" })).toBe(false);
  });
});
