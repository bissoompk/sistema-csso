/**
 * Link que leva a 403 não aparece (teste visual de 27/10/2026): o "Plano de
 * ação" some do menu de quem não investiga nem encaminha ao SIASS, o titular não
 * ganha o link da ficha nem do catálogo de cursos que a equipe lê, e a conta da
 * equipe sem Processos SEI abre a visão geral em `/` em vez do 403.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";

let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  novoCliente = amb.novoCliente;
  await contas(amb.db);
});

const como = (login: string) => entrar(novoCliente(), login);

describe("links que dariam 403", () => {
  it("a secretaria não vê o Plano de ação no menu, e quem investiga vê", async () => {
    const sec = await como("secretaria_csso");
    expect((await sec.get("/acidentes")).text).not.toContain('href="/acidentes/acoes');
    const tec = await como("tecnico_seguranca");
    expect((await tec.get("/acidentes")).text).toContain('href="/acidentes/acoes');
  });

  it("o servidor não vê o link do catálogo de cursos nem o da ficha completa", async () => {
    const srv = await como("servidor_consulta");
    expect((await srv.get("/turmas/minhas")).text).not.toContain('href="/treinamentos/catalogo"');
    expect((await srv.get("/minha-conta")).text).not.toContain('href="/servidores/');
  });

  it("a equipe de treinamento ainda vê o link do catálogo", async () => {
    const coord = await como("coordenador_csso");
    const r = await coord.get("/turmas/minhas");
    if (r.text.includes("Nenhuma turma aberta agora —")) expect(r.text).toContain('href="/treinamentos/catalogo"');
  });

  it("almoxarife e admin vão de / para a visão geral, sem 403", async () => {
    for (const login of ["almoxarife_sesmt", "admin_ti"]) {
      const c = await como(login);
      const r = await c.get("/", { seguir: false });
      expect([login, r.status]).toEqual([login, 303]);
      expect(r.location).toContain("/inicio");
    }
  });
});
