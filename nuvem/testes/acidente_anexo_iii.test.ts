/**
 * A CAT/SP no formato do Anexo III (PDF para a perícia do SIASS): só quem tem a
 * identificação e o detalhe de saúde a emite; cada emissão registra os dois
 * acessos e um evento sem dado; o CPF sai inteiro SÓ aqui; o nexo causal vem da
 * decisão pericial. Dados fictícios (CPF de teste com verificador válido).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as anexo from "../src/servicos/acidente_anexo_iii.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Cliente } from "./ajuda.js";
import { dados, envolvido, titular } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

async function aberta() {
  const { usuario } = await titular(db);
  const oc = await db.transaction((tx) =>
    comunicacao.comunicar(
      tx,
      usuario,
      dados({
        envolvidos: [
          envolvido({
            sou_eu: true,
            identificacao: {
              sexo: "FEMININO", cpf: "529.982.247-25", rg: "MG-1", data_nascimento: "1985-04-20", cep: "39100-000",
              logradouro: "Rua dos Testes Inventados", numero: "1", complemento: null, bairro: "Centro", cidade: "Diamantina",
              uf: "MG", telefone: "38999991234", email: null,
            },
          }),
        ],
      }),
    ),
  );
  const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
  return { oc, env: env!, usuario };
}

describe("nexo_causal", () => {
  it("sem decisão é Encaminhar; reconhecido é Sim; não reconhecido é Não; a substituída não vale", () => {
    expect(anexo.nexo_causal([])).toBe("ENCAMINHAR");
    expect(anexo.nexo_causal([{ resultado: "ACIDENTE_EM_SERVICO_RECONHECIDO", vigente: true }])).toBe("SIM");
    expect(anexo.nexo_causal([{ resultado: "NAO_RECONHECIDO", vigente: true }])).toBe("NAO");
    expect(anexo.nexo_causal([{ resultado: "OUTRO", vigente: true }])).toBe("ENCAMINHAR");
    expect(anexo.nexo_causal([{ resultado: "NAO_RECONHECIDO", vigente: false }, { resultado: "ACIDENTE_EM_SERVICO_RECONHECIDO", vigente: true }])).toBe("SIM");
  });
});

describe("o PDF do Anexo III", () => {
  it("o médico emite: leva o CPF inteiro, registra os dois acessos e um evento sem dado", async () => {
    const { oc, env } = await aberta();
    const medico = await usuarioAtual(db, "medico_trabalho");
    const blocos = await db.transaction((tx) => anexo.blocos_do_acidentado(tx, medico, oc, env.id));
    const texto = JSON.stringify(blocos.blocos);
    expect(texto).toContain("529.982.247-25");
    expect(texto).toContain("Nexo causal");
    expect(texto).toContain("Encaminhar");
    const campos = (await db.select().from(e.acesso_dado_sensivel)).map((a) => a.campo);
    expect(campos).toEqual(expect.arrayContaining(["acidente_identificacao"]));
    expect(campos.length).toBeGreaterThanOrEqual(2);
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_ANEXO_III_EMITIDO"));
    expect(ev!.descricao).toContain(oc.protocolo);
    expect(ev!.descricao).not.toMatch(/52998|Rua dos Testes/);
  });

  it("gera um PDF de verdade", async () => {
    const { oc, env } = await aberta();
    const medico = await usuarioAtual(db, "medico_trabalho");
    const r = await db.transaction((tx) => anexo.gerar_pdf(tx, medico, oc, env.id));
    expect(Buffer.from(r.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(r.nome).toMatch(/^CAT-SP-.*\.pdf$/);
  });

  it("quem só tem a identificação (técnico) é negado, e nada é registrado", async () => {
    const { oc, env } = await aberta();
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    await expect(db.transaction((tx) => anexo.gerar_pdf(tx, tecnico, oc, env.id))).rejects.toBeInstanceOf(PermissaoNegada);
    expect(await db.select().from(e.acesso_dado_sensivel)).toHaveLength(0);
  });

  it("o próprio acidentado não emite por aqui", async () => {
    const { oc, env, usuario } = await aberta();
    await expect(db.transaction((tx) => anexo.gerar_pdf(tx, usuario, oc, env.id))).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("acidentado de outra ocorrência é recusado", async () => {
    const { oc } = await aberta();
    const medico = await usuarioAtual(db, "medico_trabalho");
    await expect(db.transaction((tx) => anexo.gerar_pdf(tx, medico, oc, 999999))).rejects.toBeInstanceOf(anexo.AnexoRecusado);
  });
});

describe("pela rota", () => {
  it("o médico baixa o PDF; o técnico recebe a negativa", async () => {
    const { oc, env } = await aberta();
    const medico = await entrar(novoCliente(), "medico_trabalho");
    const r = await medico.get(`/acidentes/${oc.id}/anexo-iii/${env.id}.pdf`, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/pdf");
    const tecnico = await entrar(novoCliente(), "tecnico_seguranca");
    expect((await tecnico.get(`/acidentes/${oc.id}/anexo-iii/${env.id}.pdf`, { seguir: false })).status).toBeGreaterThanOrEqual(403);
  });

  it("acidentado inexistente na URL dá 404, e a Saúde e a Identificação sem o parâmetro também (e não 500)", async () => {
    const { oc } = await aberta();
    const medico = await entrar(novoCliente(), "medico_trabalho");
    expect((await medico.get(`/acidentes/${oc.id}/anexo-iii/999999.pdf`, { seguir: false })).status).toBe(404);
    expect((await medico.get(`/acidentes/${oc.id}/saude?finalidade=INVESTIGACAO`, { seguir: false })).status).toBe(404);
    expect((await medico.get(`/acidentes/${oc.id}/identificacao?finalidade=INVESTIGACAO`, { seguir: false })).status).toBe(404);
  });
});
