/**
 * F4 do módulo de acidentes: entrevistas e evidências. Áudio sem consentimento
 * registrado é recusado; teto de 4 MB; o tipo vem dos bytes, não do que o
 * navegador declara; relato e arquivos são restritos a quem investiga (o
 * titular não baixa a gravação); a trilha não leva nome. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as entrevista from "../src/servicos/acidente_entrevista.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { em_investigacao } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function arquivo(bytes: Uint8Array, nome: string, tipo: string) {
  return new File([bytes.slice().buffer as ArrayBuffer], nome, { type: tipo });
}

describe("o tipo pelos bytes", () => {
  it("reconhece os áudios e as evidências aceitos, e recusa o resto", () => {
    expect(entrevista.tipo_do_audio(WEBM)).toBe("audio/webm");
    expect(entrevista.tipo_do_audio(new TextEncoder().encode("OggS....."))).toBe("audio/ogg");
    expect(entrevista.tipo_do_audio(new TextEncoder().encode("<html>oi</html>"))).toBeNull();
    expect(entrevista.tipo_da_evidencia(PNG)).toBe("image/png");
    expect(entrevista.tipo_da_evidencia(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(entrevista.tipo_da_evidencia(new TextEncoder().encode("MZ executavel"))).toBeNull();
  });
});

describe("entrevistas", () => {
  it("áudio sem consentimento é recusado; com ele, fica quem registrou o consentimento", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const sem = await cli.post(
      `/acidentes/${oc.id}/entrevistas`,
      { entrevistado_nome: "Colega Fictício", relato: "Viu a bandeja cair.", audio: arquivo(WEBM, "g.webm", "audio/webm") },
      { seguir: false },
    );
    expect(sem.status).toBe(422);
    expect(sem.text).toContain("consentimento");
    expect(await db.select().from(e.acidente_entrevista)).toHaveLength(0);
    const com = await cli.post(
      `/acidentes/${oc.id}/entrevistas`,
      { entrevistado_nome: "Colega Fictício", relato: "Viu a bandeja cair.", consentiu_gravacao: "1", audio: arquivo(WEBM, "g.webm", "audio/webm") },
      { seguir: false },
    );
    expect(com.status).toBe(303);
    const [ent] = await db.select().from(e.acidente_entrevista);
    expect(ent!.anexo_audio_id).not.toBeNull();
    expect(ent!.consentimento_registrado_por).not.toBeNull();
    const [anexo] = await db.select().from(e.anexo).where(eq(e.anexo.id, ent!.anexo_audio_id!));
    expect(anexo!.categoria).toBe("EVIDENCIA_ACIDENTE");
    expect(anexo!.nivel_acesso).toBe("RESTRITO");
    expect(anexo!.mime_type).toBe("audio/webm");
  });

  it("o tipo declarado não vale: HTML com cara de áudio é recusado", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(
      `/acidentes/${oc.id}/entrevistas`,
      { entrevistado_nome: "X", consentiu_gravacao: "1", audio: arquivo(new TextEncoder().encode("<script>alert(1)</script>"), "a.webm", "audio/webm") },
      { seguir: false },
    );
    expect(r.status).toBe(422);
  });

  it("acima de 4 MB é recusado", async () => {
    const { oc } = await em_investigacao(db);
    const grande = new Uint8Array(4 * 1024 * 1024 + 10);
    grande.set(WEBM, 0);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(
      `/acidentes/${oc.id}/entrevistas`,
      { entrevistado_nome: "X", consentiu_gravacao: "1", audio: arquivo(grande, "g.webm", "audio/webm") },
      { seguir: false },
    );
    expect(r.status).toBe(422);
    expect(r.text).toContain("limite");
  });

  it("a trilha não leva o nome do entrevistado nem o relato", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    await cli.post(`/acidentes/${oc.id}/entrevistas`, { entrevistado_nome: "Pessoa Entrevistada", relato: "Contou que a prateleira balançava." });
    const evs = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_ENTREVISTA_REGISTRADA"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.descricao).not.toContain("Pessoa Entrevistada");
    expect(evs[0]!.descricao).not.toContain("prateleira");
  });
});

describe("evidências e acesso", () => {
  it("a evidência entra pelos bytes; o titular não a baixa, quem investiga sim", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(`/acidentes/${oc.id}/evidencias`, { arquivo: arquivo(PNG, "local.png", "image/png"), descricao: "Prateleira" }, { seguir: false });
    expect(r.status).toBe(303);
    const [ev] = await db.select().from(e.acidente_evidencia);
    expect((await cli.get(`/anexos/${ev!.anexo_id}`, { seguir: false })).status).toBe(200);
    const tit = await entrar(novoCliente(), "servidor_consulta");
    expect((await tit.get(`/anexos/${ev!.anexo_id}`, { seguir: false })).status).not.toBe(200);
    // e a aba é restrita para ele
    expect((await tit.get(`/acidentes/${oc.id}?aba=entrevistas`)).text).toContain("Restrito à equipe que investiga");
  });

  it("evidência que não é PDF nem imagem é recusada", async () => {
    const { oc } = await em_investigacao(db);
    const cli = await entrar(novoCliente(), "tecnico_seguranca");
    const r = await cli.post(`/acidentes/${oc.id}/evidencias`, { arquivo: arquivo(new TextEncoder().encode("MZ"), "x.png", "image/png") }, { seguir: false });
    expect(r.status).toBe(422);
  });
});
