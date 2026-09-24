/**
 * /catalogos/* — catálogos versionados do domínio.
 * Porte de `app/rotas/catalogos.py`.
 *
 * Recusa de CADASTRO renderiza a tela com o popup reaberto e o que foi
 * digitado; recusa de EDIÇÃO em linha redireciona com `?erro=` (a linha da
 * tabela é o formulário e volta do banco intacta).
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, getTableName, ne } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import {
  agente_nocivo,
  campus,
  cargo,
  checklist_modelo,
  fundamentacao_legal,
  percentual_aplicavel,
  portaria_localizacao,
  posto_trabalho,
  servidor,
  texto_padrao,
  tipo_processo,
  tipo_risco,
  unidade_uorg,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { ChecklistModelo } from "../dominio/dominios.js";
import { ROTULO_ESTADO_TELA } from "../dominio/estados.js";
import { UnidadeUorg } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as textos from "../servicos/textos.js";
import { analisar_portaria } from "../servicos/importacao_planilha.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const CATALOGOS: readonly (readonly [string, string])[] = [
  ["campi", "Campi"],
  ["unidades-uorg", "Unidades / UORG"],
  ["postos-trabalho", "Postos de trabalho"],
  ["cargos", "Cargos"],
  ["agentes-nocivos", "Agentes nocivos"],
  ["tipos-risco", "Tipos de risco"],
  ["fundamentacoes-legais", "Fundamentações legais"],
  ["percentuais", "Percentuais aplicáveis"],
  ["textos-padrao", "Textos padrão"],
  ["portarias", "Portarias de localização"],
  ["checklists-modelo", "Checklists modelo"],
];

export const TIPOS_UNIDADE: readonly (readonly [string, string])[] = [
  ["FACULDADE", "Faculdade"],
  ["INSTITUTO", "Instituto"],
  ["DEPARTAMENTO", "Departamento"],
  ["PRO_REITORIA", "Pró-Reitoria"],
  ["DIRETORIA", "Diretoria"],
  ["COORDENADORIA", "Coordenadoria"],
  ["SUPERINTENDENCIA", "Superintendência"],
  ["SECRETARIA", "Secretaria"],
  ["OUTRO", "Outro"],
];

/** O recado vai codificado: quase toda mensagem daqui cita o que foi digitado. */
function _volta(c: Ctx, destino: string, mensagem: string) {
  return redirecionar(c, comMensagem(destino, mensagem));
}
/** A recusa de edição volta no banner vermelho, e não no verde. */
function _erro(c: Ctx, destino: string, mensagem: string) {
  return redirecionar(c, comMensagem(destino, mensagem, "erro"));
}

/** Campo obrigatório ausente: o 422 do `Form(...)` do FastAPI. */
function exigidos(f: Formulario, ...nomes: string[]): void {
  const faltando = nomes.filter((n) => typeof f.dados.get(n) !== "string");
  if (faltando.length) throw new ErroHttp(422, `Campo obrigatório ausente: ${faltando.join(", ")}`);
}
function _int(f: Formulario, nome: string): number {
  const v = f.inteiro(nome);
  if (v === null) throw new ErroHttp(422, `Campo inteiro inválido: ${nome}`);
  return v;
}
function _int_ou_nulo(bruto: string): number | null {
  return /^\d+$/.test(bruto) ? Number(bruto) : null;
}
function _texto(valor: string | null | undefined): string | null {
  return (valor ?? "").trim() || null;
}
function _data_iso(bruto: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) throw new ErroHttp(422, `Data inválida: ${bruto}`);
  return bruto;
}

/**
 * Edição de catálogo: exige a permissão, grava e audita campo a campo. É o
 * `web.salvar_com_diff` do Python — a regra é a mesma em todo catálogo.
 * Editar é seguro para o que já saiu: o parecer emitido reimprime do conteúdo
 * congelado (RN-15).
 */
export async function salvar_com_diff(
  c: Ctx,
  usuario: UsuarioAtual,
  tabela: PgTable,
  registro_id: number,
  campos: Record<string, unknown>,
  d: { permissao: string; rotulo: string; volta: string },
) {
  usuario.exigir(d.permissao);
  const tx = c.get("tx");
  const coluna_id = (tabela as unknown as Record<string, PgColumn>)["id"]!;
  const [registro] = (await tx.select().from(tabela).where(eq(coluna_id, registro_id))) as Record<string, unknown>[];
  if (!registro) return redirecionar(c, d.volta);
  const antes = Object.fromEntries(Object.keys(campos).map((k) => [k, registro[k] ?? null]));
  await tx.update(tabela).set(campos as never).where(eq(coluna_id, registro_id));
  await auditoria.registrar_diferencas(tx, {
    entidade: getTableName(tabela),
    entidade_id: registro_id,
    antes,
    depois: campos,
    usuario,
  });
  return _volta(c, d.volta, `${d.rotulo} atualizado.`);
}

const comUorg = <T extends typeof unidade_uorg.$inferSelect>(u: T) => ({ ...u, uorg_bruto: UnidadeUorg.uorg_bruto(u) });

async function _itens(tx: Executor, nome: string): Promise<{ itens: unknown[]; extra: Record<string, unknown> }> {
  const extra: Record<string, unknown> = {};
  switch (nome) {
    case "campi":
      return { itens: await tx.select().from(campus).orderBy(asc(campus.sigla)), extra };
    case "unidades-uorg":
      return {
        itens: (
          await tx.query.unidade_uorg.findMany({ with: { campus: true }, orderBy: [asc(unidade_uorg.nome_oficial)] })
        ).map(comUorg),
        extra,
      };
    case "postos-trabalho":
      return {
        itens: await tx.query.posto_trabalho.findMany({ with: { unidade: true }, orderBy: [asc(posto_trabalho.nome)] }),
        extra,
      };
    case "agentes-nocivos":
      return {
        itens: await tx.query.agente_nocivo.findMany({
          with: { tipo_risco: true, fundamentacao: true },
          orderBy: [asc(agente_nocivo.descricao)],
        }),
        extra,
      };
    case "tipos-risco":
      return { itens: await tx.select().from(tipo_risco).orderBy(asc(tipo_risco.id)), extra };
    case "fundamentacoes-legais":
      return { itens: await tx.select().from(fundamentacao_legal).orderBy(asc(fundamentacao_legal.id)), extra };
    case "percentuais":
      return {
        itens: await tx.query.percentual_aplicavel.findMany({
          with: { tipo_adicional: true },
          orderBy: [asc(percentual_aplicavel.id)],
        }),
        extra,
      };
    case "textos-padrao":
      return {
        itens: await tx.select().from(texto_padrao).orderBy(asc(texto_padrao.categoria), asc(texto_padrao.codigo)),
        extra,
      };
    case "portarias":
      extra.emissoras = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.emite_portaria, true));
      return {
        itens: await tx.query.portaria_localizacao.findMany({
          with: { unidade_emissora: true },
          orderBy: [desc(portaria_localizacao.data_publicacao)],
        }),
        extra,
      };
    case "checklists-modelo": {
      const modelos = await tx.query.checklist_modelo.findMany({
        with: { tipo_processo: true },
        orderBy: [asc(checklist_modelo.nome)],
      });
      return { itens: modelos.map((m) => ({ ...m, lista_de_itens: ChecklistModelo.lista_de_itens(m) })), extra };
    }
    case "cargos": {
      const itens = await tx.select().from(cargo).orderBy(asc(cargo.nome));
      // quantos servidores estão em cada cargo: renomear um cargo em uso muda o
      // que aparece nas telas, e quem edita precisa saber disso
      const usos = await tx
        .select({ cargo_id: servidor.cargo_id, n: count() })
        .from(servidor)
        .groupBy(servidor.cargo_id);
      const por = new Map(usos.map((u) => [u.cargo_id, u.n]));
      extra.em_uso = Object.fromEntries(itens.map((cg) => [cg.id, por.get(cg.id) ?? 0]));
      return { itens, extra };
    }
    default:
      return { itens: [], extra };
  }
}

/** A tela do catálogo, com o popup de cadastro em branco ou com o digitado. */
async function _tela(
  c: Ctx,
  usuario: UsuarioAtual,
  nome: string,
  recado: { mensagem?: string | null; erro?: string | null; digitado?: Record<string, unknown> } = {},
) {
  const tx = c.get("tx");
  const { itens, extra } = await _itens(tx, nome);
  const rotulo = CATALOGOS.find(([chave]) => chave === nome)?.[1];
  const legivel = nome.replaceAll("-", " ");
  const titulo_catalogo = rotulo ?? legivel.charAt(0).toUpperCase() + legivel.slice(1).toLowerCase();
  return pagina(c, "paginas/catalogo_lista.html", usuario, {
    nome,
    titulo_catalogo,
    catalogos: CATALOGOS,
    // os macros do template leem `editavel` do contexto (no Jinja o `set` do
    // bloco era visível ao macro; no Nunjucks, não)
    editavel: usuario.pode("catalogo.gerenciar"),
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
    digitado: recado.digitado ?? {},
    campi: await tx.select().from(campus).orderBy(asc(campus.sigla)),
    tipos: TIPOS_UNIDADE,
    riscos: await tx.select().from(tipo_risco).orderBy(asc(tipo_risco.nome)),
    fundamentacoes: await tx.select().from(fundamentacao_legal).orderBy(asc(fundamentacao_legal.codigo)),
    unidades: await tx.query.unidade_uorg.findMany({ with: { campus: true }, orderBy: [asc(unidade_uorg.nome_extenso)] }),
    tipos_processo: await tx.select().from(tipo_processo).orderBy(asc(tipo_processo.id)),
    // só os códigos, na ordem do rótulo de tela
    estados: Object.entries(ROTULO_ESTADO_TELA)
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([codigo]) => codigo),
    itens,
    ...extra,
  });
}

rotas.get("/catalogos", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.ver");
  return pagina(c, "paginas/catalogos.html", usuario, { catalogos: CATALOGOS });
});

rotas.get("/catalogos/:nome", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.ver");
  return _tela(c, usuario, c.req.param("nome"), {
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

// ---------------------------------------------------------------------
// Cadastros
// ---------------------------------------------------------------------
/** RN-10: o número é normalizado sem zeros à esquerda; o literal fica preservado. */
rotas.post("/catalogos/portarias", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "texto_original", "unidade_emissora_id");
  const tx = c.get("tx");
  const texto_original = f.texto("texto_original");
  const unidade_emissora_id = _int(f, "unidade_emissora_id");
  const data_publicacao = f.texto("data_publicacao");
  const numero = f.texto("numero");
  const digitado = { texto_original, unidade_emissora_id, data_publicacao, numero };
  const analise = analisar_portaria(texto_original);
  const quando = data_publicacao ? _data_iso(data_publicacao) : analise ? analise.data : null;
  const numero_norm = (numero || (analise ? analise.numero : "")).replace(/^0+/, "") || "0";
  if (quando === null) {
    return _tela(c, usuario, "portarias", {
      erro: "Informe a data de publicação: ela não saiu do texto original.",
      digitado,
    });
  }
  const ano = Number(quando.slice(0, 4));
  const [existente] = await tx
    .select()
    .from(portaria_localizacao)
    .where(
      and(
        eq(portaria_localizacao.unidade_emissora_id, unidade_emissora_id),
        eq(portaria_localizacao.numero, numero_norm),
        eq(portaria_localizacao.ano, ano),
      ),
    );
  if (existente) {
    return _tela(c, usuario, "portarias", { erro: "Portaria já cadastrada (001, 01 e 1 são a mesma).", digitado });
  }
  const [portaria] = await tx
    .insert(portaria_localizacao)
    .values({ unidade_emissora_id, numero: numero_norm, ano, data_publicacao: quando, texto_original: texto_original.trim() })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "portaria_localizacao",
    entidade_id: portaria!.id,
    tipo_evento: "PORTARIA_CRIADA",
    descricao: texto_original.trim(),
    usuario,
  });
  return _volta(c, "/catalogos/portarias", "Portaria cadastrada.");
});

/** Catálogo versionado: nunca sobrescreve; cria a versão seguinte. */
rotas.post("/catalogos/textos-padrao", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "categoria", "codigo", "template");
  const tx = c.get("tx");
  const categoria = f.texto("categoria");
  const codigo = f.texto("codigo");
  const onde = and(eq(texto_padrao.categoria, categoria), eq(texto_padrao.codigo, codigo));
  const atuais = await tx.select().from(texto_padrao).where(onde);
  const proxima = Math.max(0, ...atuais.map((t) => t.versao)) + 1;
  if (atuais.length) await tx.update(texto_padrao).set({ vigente: false }).where(onde);
  const [novo] = await tx
    .insert(texto_padrao)
    .values({
      categoria,
      codigo,
      versao: proxima,
      template: textos.aspas_curvas(f.texto("template")),
      vigente: true,
      dispositivo_conferido_em: hoje_iso(),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "texto_padrao",
    entidade_id: novo!.id,
    tipo_evento: "TEXTO_VERSIONADO",
    descricao: `${categoria}/${codigo} v${proxima}`,
    usuario,
  });
  return _volta(c, "/catalogos/textos-padrao", `Nova versão v${proxima} criada.`);
});

rotas.post("/catalogos/campi", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "sigla", "nome", "cidade");
  const tx = c.get("tx");
  const sigla = f.texto("sigla").trim().toUpperCase();
  const uf = f.texto("uf", "MG").trim().toUpperCase().slice(0, 2);
  const avancado = f.texto("avancado") === "1";
  const [existente] = await tx.select().from(campus).where(eq(campus.sigla, sigla));
  let mensagem: string;
  if (existente) {
    // sigla já cadastrada atualiza em vez de duplicar (como no Python, sem trilha)
    await tx
      .update(campus)
      .set({ nome: f.texto("nome").trim(), cidade: f.texto("cidade").trim(), uf, avancado })
      .where(eq(campus.id, existente.id));
    mensagem = `Campus ${sigla} atualizado.`;
  } else {
    const [novo] = await tx
      .insert(campus)
      .values({ sigla, nome: f.texto("nome").trim(), cidade: f.texto("cidade").trim(), uf: uf || "MG", avancado })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "campus",
      entidade_id: novo!.id,
      tipo_evento: "CAMPUS_CRIADO",
      descricao: `${sigla} · ${novo!.nome} · ${novo!.cidade}`,
      usuario,
    });
    mensagem = `Campus ${sigla} cadastrado.`;
  }
  return _volta(c, "/catalogos/campi", mensagem);
});

/** A caixa do nome oficial é preservada byte a byte: é ela que sai no UORG do parecer. */
rotas.post("/catalogos/unidades-uorg", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "nome_oficial", "nome_extenso", "tipo", "campus_id");
  const tx = c.get("tx");
  const campus_id = _int(f, "campus_id");
  const codigo = f.texto("codigo_uorg").trim() || null;
  if (codigo) {
    const [ja] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.codigo_uorg, codigo));
    if (ja) {
      const digitado = Object.fromEntries(
        ["nome_oficial", "nome_extenso", "tipo", "codigo_uorg", "sigla", "unidade_pai_id", "emite_portaria"].map((k) => [
          k,
          f.texto(k),
        ]),
      );
      return _tela(c, usuario, "unidades-uorg", {
        erro: `Já existe unidade com o código ${codigo}.`,
        digitado: { ...digitado, campus_id },
      });
    }
  }
  const [unidade] = await tx
    .insert(unidade_uorg)
    .values({
      codigo_uorg: codigo,
      sigla: f.texto("sigla").trim() || null,
      nome_oficial: f.texto("nome_oficial").trim(),
      nome_extenso: f.texto("nome_extenso").trim(),
      tipo: f.texto("tipo"),
      campus_id,
      unidade_pai_id: _int_ou_nulo(f.texto("unidade_pai_id")),
      emite_portaria: f.texto("emite_portaria") === "1",
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "unidade_uorg",
    entidade_id: unidade!.id,
    tipo_evento: "UNIDADE_CRIADA",
    descricao: `${UnidadeUorg.uorg_bruto(unidade!)} (${unidade!.tipo})`,
    usuario,
  });
  return _volta(c, "/catalogos/unidades-uorg", "Unidade cadastrada.");
});

/** O nome do posto sai no parecer exatamente como for digitado — inclusive a caixa. */
rotas.post("/catalogos/postos-trabalho", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "unidade_uorg_id", "nome");
  const tx = c.get("tx");
  const unidade_uorg_id = _int(f, "unidade_uorg_id");
  const limpo = f.texto("nome").trim();
  const [existente] = await tx
    .select()
    .from(posto_trabalho)
    .where(and(eq(posto_trabalho.unidade_uorg_id, unidade_uorg_id), eq(posto_trabalho.nome, limpo)));
  if (existente) {
    return _tela(c, usuario, "postos-trabalho", {
      erro: "Esse posto já existe nesta unidade.",
      digitado: { unidade_uorg_id, nome: f.texto("nome"), sigla: f.texto("sigla"), descricao: f.texto("descricao") },
    });
  }
  const [posto] = await tx
    .insert(posto_trabalho)
    .values({ unidade_uorg_id, nome: limpo, sigla: _texto(f.texto("sigla")), descricao: _texto(f.texto("descricao")) })
    .returning();
  const [unidade] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.id, unidade_uorg_id));
  await auditoria.registrar(tx, {
    entidade: "posto_trabalho",
    entidade_id: posto!.id,
    tipo_evento: "POSTO_CRIADO",
    descricao: `${posto!.nome} — ${unidade ? unidade.nome_extenso : ""}`,
    usuario,
  });
  return _volta(c, "/catalogos/postos-trabalho", "Posto cadastrado.");
});

/**
 * Cadastra ou renomeia um cargo. Uma rota, dois formulários: a linha da tabela
 * manda `cargo_id` e o popup não — é `cargo_id` que decide para onde a recusa
 * volta. Renomear é seguro: o parecer congela o cargo em `cargo_snapshot`.
 */
rotas.post("/catalogos/cargos", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "nome");
  const tx = c.get("tx");
  const nome = f.texto("nome");
  const codigo_siape = f.texto("codigo_siape");
  const cargo_id = f.texto("cargo_id");
  const limpo = nome.trim();
  const editando = /^\d+$/.test(cargo_id);
  const recusar = (mensagem: string) =>
    editando
      ? _erro(c, "/catalogos/cargos", mensagem)
      : _tela(c, usuario, "cargos", { erro: mensagem, digitado: { nome, codigo_siape } });

  if (!limpo) return recusar("O nome do cargo não pode ficar em branco.");
  const codigo = codigo_siape.trim() || null;
  const [homonimo] = await tx.select().from(cargo).where(eq(cargo.nome, limpo));
  let mensagem: string;
  if (editando) {
    const [atual] = await tx.select().from(cargo).where(eq(cargo.id, Number(cargo_id)));
    if (!atual) return redirecionar(c, "/catalogos/cargos");
    if (homonimo && homonimo.id !== atual.id) return recusar(`Já existe outro cargo chamado '${limpo}'.`);
    const antes = { nome: atual.nome, codigo_siape: atual.codigo_siape };
    const depois = { nome: limpo, codigo_siape: codigo };
    await tx.update(cargo).set(depois).where(eq(cargo.id, atual.id));
    await auditoria.registrar_diferencas(tx, { entidade: "cargo", entidade_id: atual.id, antes, depois, usuario });
    mensagem = `Cargo '${limpo}' atualizado.`;
  } else {
    if (homonimo) return recusar(`O cargo '${limpo}' já está cadastrado.`);
    const [novo] = await tx.insert(cargo).values({ nome: limpo, codigo_siape: codigo }).returning();
    await auditoria.registrar(tx, {
      entidade: "cargo",
      entidade_id: novo!.id,
      tipo_evento: "CARGO_CRIADO",
      descricao: limpo + (codigo ? ` (código SIAPE ${codigo})` : ""),
      usuario,
    });
    mensagem = `Cargo '${limpo}' cadastrado.`;
  }
  return _volta(c, "/catalogos/cargos", mensagem);
});

rotas.post("/catalogos/checklists-modelo", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "nome", "itens");
  const tx = c.get("tx");
  const nome = f.texto("nome").trim();
  const itens = f.texto("itens");
  const tipo_processo_id = _int_ou_nulo(f.texto("tipo_processo_id"));
  const estado_alvo = f.texto("estado_alvo") || null;
  const [existente] = await tx.select().from(checklist_modelo).where(eq(checklist_modelo.nome, nome));
  let mensagem: string;
  if (existente) {
    await tx
      .update(checklist_modelo)
      .set({ itens, tipo_processo_id, estado_alvo })
      .where(eq(checklist_modelo.id, existente.id));
    mensagem = "Modelo atualizado.";
  } else {
    const [modelo] = await tx.insert(checklist_modelo).values({ nome, itens, tipo_processo_id, estado_alvo }).returning();
    await auditoria.registrar(tx, {
      entidade: "checklist_modelo",
      entidade_id: modelo!.id,
      tipo_evento: "CHECKLIST_MODELO_CRIADO",
      descricao: `${modelo!.nome} (${ChecklistModelo.lista_de_itens(modelo!).length} itens)`,
      usuario,
    });
    mensagem = "Modelo cadastrado.";
  }
  return _volta(c, "/catalogos/checklists-modelo", mensagem);
});

rotas.post("/catalogos/agentes-nocivos", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("catalogo.gerenciar");
  const f = await formulario(c);
  exigidos(f, "descricao", "tipo_risco_id");
  const tx = c.get("tx");
  const descricao = f.texto("descricao").trim();
  const [agente] = await tx
    .insert(agente_nocivo)
    .values({
      descricao,
      tipo_risco_id: _int(f, "tipo_risco_id"),
      fundamentacao_id: _int_ou_nulo(f.texto("fundamentacao_id")),
      exige_reavaliacao_quantitativa: f.texto("exige_quantitativa") === "1",
      agente_canonico_id: _int_ou_nulo(f.texto("agente_canonico_id")),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "agente_nocivo",
    entidade_id: agente!.id,
    tipo_evento: "AGENTE_CRIADO",
    descricao,
    usuario,
  });
  return _volta(c, "/catalogos/agentes-nocivos", "Agente cadastrado.");
});

// ---------------------------------------------------------------------
// Edições em linha (sempre com diff campo a campo na auditoria)
// ---------------------------------------------------------------------
const GERENCIAR = "catalogo.gerenciar";

rotas.post("/catalogos/campi/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "nome", "cidade");
  return salvar_com_diff(
    c,
    usuario,
    campus,
    Number(c.req.param("id")),
    {
      nome: f.texto("nome").trim(),
      cidade: f.texto("cidade").trim(),
      uf: f.texto("uf", "MG").trim().toUpperCase().slice(0, 2) || "MG",
      avancado: f.texto("avancado") === "1",
    },
    { permissao: GERENCIAR, rotulo: "Campus", volta: "/catalogos/campi" },
  );
});

rotas.post("/catalogos/unidades-uorg/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "nome_oficial", "nome_extenso", "tipo", "campus_id");
  const id = Number(c.req.param("id"));
  const codigo = _texto(f.texto("codigo_uorg"));
  if (codigo) {
    const [ja] = await c
      .get("tx")
      .select()
      .from(unidade_uorg)
      .where(and(eq(unidade_uorg.codigo_uorg, codigo), ne(unidade_uorg.id, id)));
    if (ja) return _erro(c, "/catalogos/unidades-uorg", `O código ${codigo} já é de outra unidade.`);
  }
  return salvar_com_diff(
    c,
    usuario,
    unidade_uorg,
    id,
    {
      codigo_uorg: codigo,
      sigla: _texto(f.texto("sigla")),
      nome_oficial: f.texto("nome_oficial").trim(),
      nome_extenso: f.texto("nome_extenso").trim(),
      tipo: f.texto("tipo"),
      campus_id: _int(f, "campus_id"),
      emite_portaria: f.texto("emite_portaria") === "1",
      ativo: f.texto("ativo") === "1",
    },
    { permissao: GERENCIAR, rotulo: "Unidade", volta: "/catalogos/unidades-uorg" },
  );
});

rotas.post("/catalogos/postos-trabalho/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "nome", "unidade_uorg_id");
  const id = Number(c.req.param("id"));
  const limpo = f.texto("nome").trim();
  const unidade_uorg_id = _int(f, "unidade_uorg_id");
  const [ja] = await c
    .get("tx")
    .select()
    .from(posto_trabalho)
    .where(
      and(eq(posto_trabalho.unidade_uorg_id, unidade_uorg_id), eq(posto_trabalho.nome, limpo), ne(posto_trabalho.id, id)),
    );
  if (ja) return _erro(c, "/catalogos/postos-trabalho", "Já existe esse posto nesta unidade.");
  return salvar_com_diff(
    c,
    usuario,
    posto_trabalho,
    id,
    {
      nome: limpo,
      unidade_uorg_id,
      sigla: _texto(f.texto("sigla")),
      descricao: _texto(f.texto("descricao")),
      ativo: f.texto("ativo") === "1",
    },
    { permissao: GERENCIAR, rotulo: "Posto", volta: "/catalogos/postos-trabalho" },
  );
});

rotas.post("/catalogos/tipos-risco/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "nome");
  return salvar_com_diff(
    c,
    usuario,
    tipo_risco,
    Number(c.req.param("id")),
    { nome: f.texto("nome").trim() },
    { permissao: GERENCIAR, rotulo: "Tipo de risco", volta: "/catalogos/tipos-risco" },
  );
});

rotas.post("/catalogos/fundamentacoes-legais/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "norma", "texto");
  return salvar_com_diff(
    c,
    usuario,
    fundamentacao_legal,
    Number(c.req.param("id")),
    {
      norma: f.texto("norma").trim(),
      anexo: _texto(f.texto("anexo")),
      // aspas retas viram curvas uma vez, aqui — nunca a cada render
      texto: textos.aspas_curvas(f.texto("texto")),
      vigente: f.texto("vigente") === "1",
      dispositivo_conferido_em: hoje_iso(),
    },
    { permissao: GERENCIAR, rotulo: "Fundamentação", volta: "/catalogos/fundamentacoes-legais" },
  );
});

/** Só o rótulo. O VALOR é a lei (Lei 8.270/91, art. 12). */
rotas.post("/catalogos/percentuais/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "rotulo");
  return salvar_com_diff(
    c,
    usuario,
    percentual_aplicavel,
    Number(c.req.param("id")),
    { rotulo: f.texto("rotulo").trim() },
    { permissao: GERENCIAR, rotulo: "Rótulo do percentual", volta: "/catalogos/percentuais" },
  );
});

rotas.post("/catalogos/agentes-nocivos/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "descricao", "tipo_risco_id");
  return salvar_com_diff(
    c,
    usuario,
    agente_nocivo,
    Number(c.req.param("id")),
    {
      descricao: f.texto("descricao").trim(),
      tipo_risco_id: _int(f, "tipo_risco_id"),
      fundamentacao_id: _int_ou_nulo(f.texto("fundamentacao_id")),
      exige_reavaliacao_quantitativa: f.texto("exige_quantitativa") === "1",
      ativo: f.texto("ativo") === "1",
    },
    { permissao: GERENCIAR, rotulo: "Agente nocivo", volta: "/catalogos/agentes-nocivos" },
  );
});

rotas.post("/catalogos/portarias/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "texto_original", "data_publicacao", "numero");
  const quando = _data_iso(f.texto("data_publicacao"));
  return salvar_com_diff(
    c,
    usuario,
    portaria_localizacao,
    Number(c.req.param("id")),
    {
      texto_original: f.texto("texto_original").trim(),
      data_publicacao: quando,
      ano: Number(quando.slice(0, 4)),
      numero: f.texto("numero").trim().replace(/^0+/, "") || "0",
    },
    { permissao: GERENCIAR, rotulo: "Portaria", volta: "/catalogos/portarias" },
  );
});

rotas.post("/catalogos/checklists-modelo/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  exigidos(f, "nome", "itens");
  return salvar_com_diff(
    c,
    usuario,
    checklist_modelo,
    Number(c.req.param("id")),
    { nome: f.texto("nome").trim(), itens: f.texto("itens"), ativo: f.texto("ativo") === "1" },
    { permissao: GERENCIAR, rotulo: "Modelo", volta: "/catalogos/checklists-modelo" },
  );
});
