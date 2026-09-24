/**
 * Histórico datado de lotação e cargo do servidor.
 * Porte de `testes/integracao/test_lotacao.py`.
 *
 * O `papeis.COORDENADOR` do Python (todas as permissões do adicional, perfil
 * coordenador) vira um `UsuarioAtual` montado à mão com o id da conta
 * `coordenador_csso` — o `registrado_por` é FK de verdade no Postgres.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as servico from "../src/servicos/servidores.js";
import { PermissaoNegada, UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste } from "./ajuda";

const HOJE = hoje_iso();

const TODAS = [
  "processo.ver", "processo.criar", "processo.editar", "processo.status",
  "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
  "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
  "laudo.criar", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
  "catalogo.gerenciar",
];

let amb: AmbienteDeTeste = await bancoLimpo();
let coord: UsuarioAtual;
type Servidor = typeof e.servidor.$inferSelect;
let marco: Servidor;

async function unidade(codigo: string) {
  const [u] = await amb.db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, codigo));
  return u!;
}
const _outra_unidade = () => unidade("261");

async function _postos_da_famed(famed_id: number) {
  return amb.db
    .select()
    .from(e.posto_trabalho)
    .where(eq(e.posto_trabalho.unidade_uorg_id, famed_id))
    .orderBy(asc(e.posto_trabalho.nome));
}

beforeEach(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
  coord = new UsuarioAtual({ id: conta!.id, login: "coord", nome: "Coordenador", permissoes: TODAS, perfis: ["coordenador_csso"] });

  const famed = await unidade("250");
  const [cargo] = await amb.db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA"));
  const [leac] = await amb.db
    .select()
    .from(e.posto_trabalho)
    .where(and(eq(e.posto_trabalho.unidade_uorg_id, famed.id), eq(e.posto_trabalho.nome, "Laboratório Escola de análises Clínicas (LEAC)")));
  [marco] = (await amb.db
    .insert(e.servidor)
    .values({ siape: "1110654", nome: "Marco Antônio Alves Schetino", cargo_id: cargo!.id, unidade_uorg_id: famed.id })
    .returning()) as [Servidor];
  await servico.registrar_lotacao_inicial(amb.db, marco, coord, { inicio: "2019-03-01", documento: "Posse", postos: [leac!.id] });
});

describe("serviço de lotação", () => {
  it("lotação inicial abre o primeiro período", async () => {
    const linha = await servico.historico(amb.db, marco.id);
    expect(linha).toHaveLength(1);
    expect(linha[0]!.vigencia_inicio).toBe("2019-03-01");
    expect(linha[0]!.vigencia_fim).toBeNull();
  });

  it("lotação inicial é idempotente", async () => {
    await servico.registrar_lotacao_inicial(amb.db, marco, coord);
    expect(await servico.historico(amb.db, marco.id)).toHaveLength(1);
  });

  it("mudança fecha o anterior na véspera", async () => {
    const ica = await _outra_unidade();
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: ica.id,
      cargo_id: marco.cargo_id,
      funcao: null,
      a_partir_de: "2024-05-10",
      documento: "PORTARIA/ICA Nº 12, DE 09 DE MAIO DE 2024",
    });
    const linha = await servico.historico(amb.db, marco.id);
    expect(linha).toHaveLength(2);
    expect(linha[0]!.vigencia_fim).toBe("2024-05-09"); // véspera
    expect(linha[1]!.vigencia_inicio).toBe("2024-05-10");
    expect(linha[1]!.vigencia_fim).toBeNull();
    expect(await servico.inconsistencias(amb.db, marco.id)).toEqual([]);
  });

  it("o cadastro passa a refletir o período atual", async () => {
    const ica = await _outra_unidade();
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: ica.id,
      cargo_id: null,
      funcao: "Chefia do laboratório",
      a_partir_de: HOJE,
    });
    expect(marco.unidade_uorg_id).toBe(ica.id);
    expect(marco.funcao).toBe("Chefia do laboratório");
    const [gravado] = await amb.db.select().from(e.servidor).where(eq(e.servidor.id, marco.id));
    expect(gravado!.unidade_uorg_id).toBe(ica.id);
  });

  it("mudança futura não altera o cadastro ainda", async () => {
    const ica = await _outra_unidade();
    const antes = marco.unidade_uorg_id;
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: ica.id,
      cargo_id: null,
      funcao: null,
      a_partir_de: somar_dias(HOJE, 30),
    });
    expect(marco.unidade_uorg_id).toBe(antes);
    expect(await servico.historico(amb.db, marco.id)).toHaveLength(2);
  });

  it("onde o servidor estava naquela data", async () => {
    const famed = marco.unidade_uorg_id;
    const ica = (await _outra_unidade()).id;
    await servico.alterar_lotacao(amb.db, marco, coord, { unidade_uorg_id: ica, cargo_id: null, funcao: null, a_partir_de: "2024-05-10" });
    expect((await servico.lotacao_em(amb.db, marco.id, "2020-01-01"))!.unidade_uorg_id).toBe(famed);
    expect((await servico.lotacao_em(amb.db, marco.id, "2024-05-09"))!.unidade_uorg_id).toBe(famed);
    expect((await servico.lotacao_em(amb.db, marco.id, "2024-05-10"))!.unidade_uorg_id).toBe(ica);
    expect(await servico.lotacao_em(amb.db, marco.id, "2018-01-01")).toBeNull();
  });

  it("data anterior ao período atual é recusada", async () => {
    await expect(
      servico.alterar_lotacao(amb.db, marco, coord, {
        unidade_uorg_id: (await _outra_unidade()).id,
        cargo_id: null,
        funcao: null,
        a_partir_de: "2018-01-01",
      }),
    ).rejects.toThrow(/depois do início/);
  });

  it("mudança sem mudança é recusada", async () => {
    const atuais = (await servico.postos_atuais(amb.db, marco.id)).map((p) => p.id);
    await expect(
      servico.alterar_lotacao(amb.db, marco, coord, {
        unidade_uorg_id: marco.unidade_uorg_id,
        uorg_id: marco.uorg_id,
        postos: atuais,
        cargo_id: marco.cargo_id,
        funcao: marco.funcao,
        a_partir_de: HOJE,
      }),
    ).rejects.toThrow(/nada mudou/);
  });

  it("posto de outra unidade é recusado", async () => {
    const ica = await _outra_unidade();
    const leac = (await servico.postos_atuais(amb.db, marco.id))[0]!.id;
    await expect(
      servico.alterar_lotacao(amb.db, marco, coord, { unidade_uorg_id: ica.id, postos: [leac], cargo_id: null, funcao: null, a_partir_de: HOJE }),
    ).rejects.toThrow(/pertence a outra unidade/);
  });

  it("alteração fica na auditoria", async () => {
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: (await _outra_unidade()).id,
      cargo_id: null,
      funcao: null,
      a_partir_de: "2024-05-10",
      documento: "PORTARIA/ICA Nº 12",
    });
    const eventos = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "LOTACAO_ALTERADA"));
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos[0]!.descricao).toContain("unidade");
    expect(eventos[0]!.descricao).toContain("PORTARIA/ICA Nº 12");
  });

  it("sem permissão não altera", async () => {
    const leitor = new UsuarioAtual({ id: 1, login: "x", nome: "x", permissoes: ["processo.ver"], perfis: [] });
    await expect(
      servico.alterar_lotacao(amb.db, marco, leitor, { unidade_uorg_id: null, cargo_id: null, funcao: "x", a_partir_de: HOJE }),
    ).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("cadastro sem histórico ganha período de origem", async () => {
    const [servidor] = await amb.db.insert(e.servidor).values({ siape: "1473142", nome: "Gabriela Silva" }).returning();
    expect(await servico.historico(amb.db, servidor!.id)).toEqual([]);
    await servico.alterar_lotacao(amb.db, servidor!, coord, {
      unidade_uorg_id: (await _outra_unidade()).id,
      cargo_id: null,
      funcao: null,
      a_partir_de: HOJE,
    });
    expect(await servico.historico(amb.db, servidor!.id)).toHaveLength(2);
    expect(await servico.inconsistencias(amb.db, servidor!.id)).toEqual([]);
  });

  it("recusa em cadastro sem histórico não deixa período fantasma", async () => {
    // o defeito que o Python corrigiu: o período de origem gravado ANTES das
    // checagens ficava para trás quando a mudança era recusada
    const [servidor] = await amb.db.insert(e.servidor).values({ siape: "1473142", nome: "Gabriela Silva" }).returning();
    await expect(
      servico.alterar_lotacao(amb.db, servidor!, coord, { unidade_uorg_id: null, cargo_id: null, funcao: null, a_partir_de: HOJE }),
    ).rejects.toThrow(/nada mudou/);
    expect(await servico.historico(amb.db, servidor!.id)).toEqual([]);
  });

  it("inconsistência detecta lacuna", async () => {
    const linha = await servico.historico(amb.db, marco.id);
    await amb.db.update(e.servidor_lotacao).set({ vigencia_fim: "2024-01-01" }).where(eq(e.servidor_lotacao.id, linha[0]!.id));
    await amb.db.insert(e.servidor_lotacao).values({ servidor_id: marco.id, unidade_uorg_id: marco.unidade_uorg_id, vigencia_inicio: "2024-03-01" });
    expect((await servico.inconsistencias(amb.db, marco.id)).some((p) => p.includes("lacuna"))).toBe(true);
  });

  it("servidor atende mais de um posto", async () => {
    const postos = await _postos_da_famed(marco.unidade_uorg_id!);
    expect(postos.length).toBeGreaterThanOrEqual(2);
    const escolhidos = postos.slice(0, 2).map((p) => p.id);
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: marco.unidade_uorg_id,
      postos: escolhidos,
      cargo_id: marco.cargo_id,
      funcao: null,
      a_partir_de: "2024-05-10",
    });
    expect((await servico.postos_atuais(amb.db, marco.id)).map((p) => p.id)).toEqual(escolhidos);
    // o período anterior guarda o posto de então — é o que prova a exposição passada
    const anterior = (await servico.lotacao_em(amb.db, marco.id, "2020-01-01"))!;
    expect(anterior.postos.map((p) => p.nome)).toEqual(["Laboratório Escola de análises Clínicas (LEAC)"]);
  });

  it("a ordem dos postos é preservada", async () => {
    const postos = await _postos_da_famed(marco.unidade_uorg_id!);
    const invertidos = postos.slice(0, 2).map((p) => p.id).reverse();
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: marco.unidade_uorg_id,
      postos: invertidos,
      cargo_id: marco.cargo_id,
      funcao: null,
      a_partir_de: "2024-05-10",
    });
    expect((await servico.postos_atuais(amb.db, marco.id)).map((p) => p.id)).toEqual(invertidos);
  });

  it("UORG é campo próprio e pode divergir da unidade", async () => {
    const ica = await _outra_unidade();
    const famed = marco.unidade_uorg_id;
    await servico.alterar_lotacao(amb.db, marco, coord, {
      unidade_uorg_id: famed,
      uorg_id: ica.id,
      cargo_id: marco.cargo_id,
      funcao: null,
      a_partir_de: "2024-05-10",
    });
    const vigente = (await servico.lotacao_vigente(amb.db, marco.id))!;
    expect(vigente.unidade_uorg_id).toBe(famed);
    expect(vigente.uorg_id).toBe(ica.id);
    expect(marco.uorg_id).toBe(ica.id);
  });

  it("correção no mesmo dia não cria período de duração zero", async () => {
    const [servidor] = await amb.db.insert(e.servidor).values({ siape: "1473142", nome: "Gabriela Silva" }).returning();
    await servico.registrar_lotacao_inicial(amb.db, servidor!, coord);
    const ica = await _outra_unidade();
    await servico.alterar_lotacao(amb.db, servidor!, coord, { unidade_uorg_id: ica.id, cargo_id: null, funcao: null, a_partir_de: HOJE });
    const linha = await servico.historico(amb.db, servidor!.id);
    expect(linha).toHaveLength(1);
    expect(linha[0]!.unidade_uorg_id).toBe(ica.id);
  });

  it("corrigir só mexe em documento e observação", async () => {
    const lotacao = (await servico.historico(amb.db, marco.id))[0]!;
    const inicio = lotacao.vigencia_inicio;
    await servico.corrigir_lotacao(amb.db, lotacao, coord, { documento: "Termo de posse nº 3", observacao: "conferido" });
    const depois = (await servico.historico(amb.db, marco.id))[0]!;
    expect(depois.documento).toBe("Termo de posse nº 3");
    expect(depois.vigencia_inicio).toBe(inicio);
  });
});

// ---------------------------------------------------------------------
describe("telas de servidor", () => {
  it("a ficha mostra e altera", async () => {
    const cliente = amb.cliente;
    await entrar(cliente, "coordenador_csso");
    const criado = await cliente.post("/servidores", { siape: "1110655", nome: "Marco Antônio Segundo" }, { seguir: false });
    const caminho = criado.location!;
    const corpo = (await cliente.get(caminho)).text;
    expect(corpo).toContain("Lotação e cargo");
    expect(corpo).toContain("Registrar mudança");
    const famed = await unidade("250");
    const r = await cliente.post(
      `${caminho}/lotacao`,
      { a_partir_de: HOJE, unidade_uorg_id: String(famed.id), funcao: "Chefia", documento: "PORTARIA/FAMED Nº 35" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const depois = (await cliente.get(caminho)).text;
    expect(depois).toContain("PORTARIA/FAMED Nº 35");
    expect(depois).toContain("atual");
  });

  it("o cadastro já aceita postos e UORG, e é editável depois", async () => {
    const cliente = amb.cliente;
    await entrar(cliente, "coordenador_csso");
    const famed = await unidade("250");
    const ica = await unidade("261");
    const postos = (await _postos_da_famed(famed.id)).slice(0, 2).map((p) => p.id);
    expect(postos).toHaveLength(2);
    const criado = await cliente.post(
      "/servidores",
      { siape: "1110656", nome: "Marco Terceiro", unidade_uorg_id: String(famed.id), uorg_id: String(ica.id), posto_id: postos.map(String) },
      { seguir: false },
    );
    const caminho = criado.location!;
    const [servidor] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "1110656"));
    expect(servidor!.uorg_id).toBe(ica.id);
    expect((await servico.postos_atuais(amb.db, servidor!.id)).map((p) => p.id)).toEqual(postos);

    const r = await cliente.post(
      caminho,
      { nome: "Marco Terceiro da Silva", siape: "1110656", email: "marco@ufvjm.edu.br", situacao: "APOSENTADO" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [editado] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "1110656"));
    expect(editado!.situacao).toBe("APOSENTADO");
    expect(editado!.email).toBe("marco@ufvjm.edu.br");
  });

  it("SIAPE de outro servidor é recusado na edição", async () => {
    const cliente = amb.cliente;
    await entrar(cliente, "coordenador_csso");
    const segundo = await cliente.post("/servidores", { siape: "1473142", nome: "Gabriela" }, { seguir: false });
    const r = await cliente.post(segundo.location!, { nome: "Gabriela", siape: "1110654", email: "", situacao: "ATIVO" });
    expect(r.text).toContain("já é de");
    const [ainda] = await amb.db.select().from(e.servidor).where(eq(e.servidor.siape, "1473142"));
    expect(ainda).toBeDefined();
  });

  it("SIAPE já cadastrado diz por que caiu na ficha do outro", async () => {
    const cliente = amb.cliente;
    await entrar(cliente, "coordenador_csso");
    const repetido = await cliente.post("/servidores", { siape: "1110654", nome: "Outro Nome" }, { seguir: false });
    expect(repetido.status).toBe(303);
    expect(repetido.location!.startsWith(`/servidores/${marco.id}?`)).toBe(true);
    const tela = await cliente.get(repetido.location!);
    expect(tela.text).toContain("já estava cadastrado");
    expect(tela.text).toContain("Nada foi criado");
  });

  it("SIAPE mal digitado reabre o popup com o que foi digitado", async () => {
    const cliente = amb.cliente;
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post("/servidores", { siape: "12345", nome: "Fulana de Teste", funcao: "Técnica" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("exatamente 7 dígitos");
    expect(r.text).toContain('value="Fulana de Teste"');
    expect(r.text).toMatch(/<dialog[^>]*id="novo-servidor"[^>]*\sopen>/);
  });
});
