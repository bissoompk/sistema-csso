/**
 * RN-12 (anexos com dedup por SHA-256) e a regra do dono do anexo
 * (`anexo_acesso`). Porte do que é de serviço em `test_anexos_acesso.py`; as
 * provas por rota (`GET /anexos/{id}` perfil a perfil) entram com a rota e com
 * os módulos donos (processo, parecer, ficha de EPI, certificado), que
 * declaram as suas portas.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-anexos-"));

import { bancoLimpo, criarUsuario, naTransacao } from "./ajuda";
import * as anexos from "../src/servicos/anexos";
import * as anexo_acesso from "../src/servicos/anexo_acesso";
import { ArmazenamentoLocal, definirArmazenamento, obterArmazenamento, conferirChave } from "../src/servicos/armazenamento";
import * as esquema from "../src/db/esquema/index";
import { CATEGORIAS_ANEXO } from "../src/dominio/auditoria";
import { UsuarioAtual } from "../src/servicos/rbac";

const { db } = await bancoLimpo();
definirArmazenamento(null);

const conta = await criarUsuario(db, { login: "anexador", perfis: ["coordenador_csso"] });
const quem = (permissoes: string[], servidor_id: number | null = null, id = conta.id) =>
  new UsuarioAtual({ id, login: "anexador", nome: "Anexador", permissoes, perfis: [], servidor_id });
const [servidor] = await db.insert(esquema.servidor).values({ siape: "7654321", nome: "Servidora de Teste" }).returning();

const bytes = (s: string) => new TextEncoder().encode(s);

let n = 0;
beforeEach(() => {
  n++;
});

afterAll(() => {
  delete process.env.CSSO_DIR_ARQUIVOS;
});

describe("anexos", () => {
  it("categorias: a lista do serviço é a lista do CHECK", () => {
    expect([...anexos.CATEGORIAS].sort()).toEqual([...CATEGORIAS_ANEXO].sort());
  });

  it("guarda, deduplica pelo SHA-256 e não grava o blob duas vezes", async () => {
    const conteudo = bytes(`parecer assinado ${n}`);
    const r1 = await naTransacao((tx) =>
      anexos.guardar(tx, {
        entidade: "processo",
        entidade_id: 100 + n,
        nome_original: "Parecer Técnico — Fulano.PDF",
        conteudo,
        mime_type: "application/pdf",
        categoria: "LAUDO",
        usuario: quem([]),
      }),
    );
    expect(r1.duplicado).toBe(false);
    expect(r1.anexo.sha256).toBe(anexos.digerir(conteudo));
    expect(r1.anexo.storage_key).toBe(`${r1.anexo.sha256.slice(0, 2)}/${r1.anexo.sha256}`);
    expect(r1.anexo.nome_arquivo).toBe("Parecer_Tecnico_Fulano.pdf");
    expect(r1.anexo.nivel_acesso).toBe("PUBLICO");
    expect(await anexos.ler_conteudo(r1.anexo)).toEqual(conteudo);

    // o mesmo arquivo no mesmo dono: duplicado, e a trilha diz
    const r2 = await naTransacao((tx) =>
      anexos.guardar(tx, {
        entidade: "processo",
        entidade_id: 100 + n,
        nome_original: "copia.pdf",
        conteudo,
        mime_type: "application/pdf",
        categoria: "LAUDO",
        usuario: quem([]),
      }),
    );
    expect(r2.duplicado).toBe(true);
    expect(r2.anexo.id).toBe(r1.anexo.id);
    const eventos = await db
      .select()
      .from(esquema.historico_evento)
      .where(and(eq(esquema.historico_evento.entidade, "anexo"), eq(esquema.historico_evento.entidade_id, r1.anexo.id)));
    expect(eventos.map((e) => e.tipo_evento).sort()).toEqual(["ANEXO_DUPLICADO", "ANEXO_ENVIADO"]);

    // o mesmo arquivo em OUTRO dono: linha nova, blob compartilhado
    const r3 = await naTransacao((tx) =>
      anexos.guardar(tx, {
        entidade: "processo",
        entidade_id: 200 + n,
        nome_original: "x.pdf",
        conteudo,
        mime_type: "application/pdf",
        categoria: "FORMULARIO",
        usuario: quem([]),
      }),
    );
    expect(r3.duplicado).toBe(false);
    expect(r3.tambem_em).toBe(2);
    expect(r3.anexo.storage_key).toBe(r1.anexo.storage_key);
    expect(r3.anexo.nivel_acesso).toBe("RESTRITO");
  });

  it("rn12: um PARECER_ASSINADO ativo por parecer — o novo desativa o anterior", async () => {
    const guardar = (texto: string) =>
      naTransacao((tx) =>
        anexos.guardar(tx, {
          entidade: "parecer_tecnico",
          entidade_id: 900 + n,
          nome_original: "assinado.pdf",
          conteudo: bytes(texto),
          mime_type: "application/pdf",
          categoria: "PARECER_ASSINADO",
          usuario: quem([]),
          assinado: true,
        }),
      );
    const a = await guardar(`v1 ${n}`);
    const b = await guardar(`v2 ${n}`);
    const ativos = await anexos.listar(db, "parecer_tecnico", 900 + n);
    expect(ativos.map((x) => x.id)).toEqual([b.anexo.id]);
    expect(a.anexo.id).not.toBe(b.anexo.id);
  });

  it("categoria inválida é recusada", async () => {
    await expect(
      naTransacao((tx) =>
        anexos.guardar(tx, {
          entidade: "processo",
          entidade_id: 1,
          nome_original: "a.txt",
          conteudo: bytes("a"),
          mime_type: "text/plain",
          categoria: "QUALQUER",
          usuario: quem([]),
        }),
      ),
    ).rejects.toThrow("categoria inválida: QUALQUER");
  });

  it("desvio da nuvem: arquivo acima de 4 MB é recusado com a saída escrita", async () => {
    const grande = new Uint8Array(anexos.LIMITE_BYTES + 1);
    const erro = await naTransacao((tx) =>
      anexos.guardar(tx, {
        entidade: "processo",
        entidade_id: 1,
        nome_original: "grande.pdf",
        conteudo: grande,
        mime_type: "application/pdf",
        categoria: "LAUDO",
        usuario: quem([]),
      }),
    ).catch((e) => e);
    expect(erro).toBeInstanceOf(anexos.AnexoGrandeDemais);
    expect(erro.message).toMatch(/limite é 4 MB/);
    expect(erro.message).toMatch(/Reduza o PDF/);
    // e o File do formulário é recusado antes de ser lido
    const arquivo = new File([grande], "grande.pdf", { type: "application/pdf" });
    await expect(
      naTransacao((tx) =>
        anexos.guardar_arquivo(tx, arquivo, { entidade: "processo", entidade_id: 1, categoria: "LAUDO", usuario: quem([]) }),
      ),
    ).rejects.toBeInstanceOf(anexos.AnexoGrandeDemais);
  });

  it("o armazenamento local não aceita chave que sai da pasta", async () => {
    for (const ruim of ["../x", "/etc/passwd", "a//b", "a/./b", "a\\b", ""]) {
      expect(() => conferirChave(ruim)).toThrow();
    }
    expect(obterArmazenamento()).toBeInstanceOf(ArmazenamentoLocal);
    await expect(obterArmazenamento().ler("anexos/zz/inexistente")).rejects.toThrow(/ausente/);
  });
});

describe("anexo_acesso: quem vê o dono baixa o anexo", () => {
  async function anexo_de(entidade: string, entidade_id: number, categoria = "LAUDO") {
    const r = await naTransacao((tx) =>
      anexos.guardar(tx, {
        entidade,
        entidade_id,
        nome_original: "doc.pdf",
        conteudo: bytes(`${entidade} ${entidade_id} ${n} ${Math.random()}`),
        mime_type: "application/pdf",
        categoria,
        usuario: quem([]),
      }),
    );
    return r.anexo;
  }

  it("anexo inexistente ou inativo: a mesma frase", async () => {
    await expect(anexo_acesso.autorizar(db, quem([]), null)).rejects.toThrow(anexo_acesso.INDISPONIVEL);
    const a = await anexo_de("processo", 5000 + n);
    await expect(anexo_acesso.autorizar(db, quem([]), { ...a, ativo: false })).rejects.toBeInstanceOf(
      anexo_acesso.AnexoForaDeAlcance,
    );
  });

  it("entidade sem resolvedor nega, e diz o nome dela", async () => {
    const a = await anexo_de("turma", 1);
    const erro = await anexo_acesso.autorizar(db, quem(["processo.ver"]), a).catch((e) => e);
    expect(erro).toBeInstanceOf(anexo_acesso.DonoNaoDeclarado);
    expect(erro.message).toContain("'turma'");
  });

  it("resolvedor declarado, mas o módulo dono ainda não deu a porta: nega", async () => {
    // Hoje todo módulo dono declara a sua porta ao ser carregado (e o app os
    // carrega); a porta é retirada só durante o teste, para a regra do lado
    // seguro continuar provada.
    const a = await anexo_de("certificado", 1, "CERTIFICADO");
    const guardada = anexo_acesso.PORTAS.certificado_no_escopo;
    delete anexo_acesso.PORTAS.certificado_no_escopo;
    try {
      const erro = await anexo_acesso.autorizar(db, quem(["certificado.ver"]), a).catch((e) => e);
      expect(erro).toBeInstanceOf(anexo_acesso.DonoNaoDeclarado);
    } finally {
      if (guardada) anexo_acesso.PORTAS.certificado_no_escopo = guardada;
    }
  });

  it("a permissão do dono vem antes do banco (processo.ver)", async () => {
    const a = await anexo_de("processo", 6000 + n);
    await expect(anexo_acesso.autorizar(db, quem([]), a)).rejects.toThrow(/processo.ver/);
  });

  it("com a porta do dono: libera, e a leitura de terceiro deixa as duas linhas", async () => {
    anexo_acesso.declarar_porta("parecer_no_escopo", async (_tx, _u, id) =>
      id === 7000 + n ? { id, servidor_id: servidor!.id, processo_id: null } : null,
    );
    const a = await anexo_de("parecer_tecnico", 7000 + n, "PARECER_ASSINADO");
    const leitor = quem(["parecer.ver"]);
    const dono = await naTransacao((tx) => anexo_acesso.liberar(tx, leitor, a));
    expect(dono.servidor_id).toBe(servidor!.id);
    const acessos = await db
      .select()
      .from(esquema.acesso_dado_sensivel)
      .where(eq(esquema.acesso_dado_sensivel.campo, "anexo.PARECER_ASSINADO"));
    expect(acessos.length).toBeGreaterThan(0);
    expect(acessos.at(-1)!.finalidade).toBe("leitura de documento anexado ao parecer técnico");
    const baixado = await db
      .select()
      .from(esquema.historico_evento)
      .where(and(eq(esquema.historico_evento.tipo_evento, "ANEXO_BAIXADO"), eq(esquema.historico_evento.entidade_id, a.id)));
    expect(baixado).toHaveLength(1);
    // a descrição não repete o nome do arquivo (§L-2)
    expect(baixado[0]!.descricao).toBe(`Anexo ${a.id} (PARECER_ASSINADO) baixado — parecer_tecnico ${7000 + n}.`);

    // fora do escopo: a mesma frase de "não existe"
    const outro = await anexo_de("parecer_tecnico", 8000 + n);
    await expect(anexo_acesso.autorizar(db, leitor, outro)).rejects.toThrow(anexo_acesso.INDISPONIVEL);
  });

  it("o titular lendo o próprio anexo: só a trilha, sem linha de acesso sensível", async () => {
    anexo_acesso.declarar_porta("parecer_no_escopo", async (_tx, _u, id) => ({ id, servidor_id: servidor!.id, processo_id: null }));
    const a = await anexo_de("parecer_tecnico", 9000 + n);
    const antes = (await db.select().from(esquema.acesso_dado_sensivel)).length;
    await naTransacao((tx) => anexo_acesso.liberar(tx, quem(["parecer.ver"], servidor!.id), a));
    expect((await db.select().from(esquema.acesso_dado_sensivel)).length).toBe(antes);
    const baixado = await db
      .select()
      .from(esquema.historico_evento)
      .where(and(eq(esquema.historico_evento.tipo_evento, "ANEXO_BAIXADO"), eq(esquema.historico_evento.entidade_id, a.id)));
    expect(baixado).toHaveLength(1);
  });
});
