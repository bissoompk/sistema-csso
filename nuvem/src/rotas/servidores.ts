/**
 * /servidores — cadastro com SIAPE como chave. RN-19 aplicado na exibição.
 * Porte de `app/rotas/servidores.py`.
 *
 * A regra da busca por nome — o oráculo que a RN-19 tem de fechar — mora em
 * `servicos/identificacao.casa_a_busca`; o rótulo de cada pessoa sai por
 * `identificar(...)` no template.
 */
import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import type { Executor } from "../db/cliente.js";
import {
  adicional_vigencia,
  cargo as tabela_cargo,
  parecer_tecnico,
  posto_trabalho,
  processo as tabela_processo,
  servidor as tabela_servidor,
  servidor_lotacao,
  unidade_uorg,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { UnidadeUorg } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as identificacao from "../servicos/identificacao.js";
import * as importacao_servidores from "../servicos/importacao_servidores.js";
import { linha_csv } from "../servicos/csv.js";
import * as servico_servidores from "../servicos/servidores.js";
import * as textos from "../servicos/textos.js";
import { PERMISSAO_DA_BASE, aplicar_escopo, type UsuarioAtual } from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, marcarDownload, numeroDaPagina, pagina, recortar, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const SITUACOES = servico_servidores.SITUACOES_SERVIDOR;

type Unidade = typeof unidade_uorg.$inferSelect;

/** A `@property uorg_bruto` do modelo, como campo pronto para o template. */
export function com_uorg_bruto<U extends Unidade | null | undefined>(u: U): U extends Unidade ? U & { uorg_bruto: string } : U {
  if (!u) return u as any;
  return { ...u, uorg_bruto: UnidadeUorg.uorg_bruto(u) } as any;
}

export async function unidades_ordenadas(tx: Executor) {
  const linhas = await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso));
  return linhas.map((u) => com_uorg_bruto(u));
}

async function postos_ordenados(tx: Executor) {
  return tx.query.posto_trabalho.findMany({ with: { unidade: true }, orderBy: [asc(posto_trabalho.nome)] });
}

/**
 * A ficha desta URL, no escopo de quem pediu — ou `null`. A única leitura de
 * `Servidor` por id das telas de cadastro: era o `s.get` espalhado que fazia a
 * lista apertar e a ficha continuar aberta.
 */
export async function _servidor_no_escopo(
  tx: Executor,
  usuario: UsuarioAtual,
  servidor_id: number,
  // a permissão da tela que lê (ou escreve): o alcance é o dela, e não o da
  // conta (D1/D9) — quem lê o próprio cadastro pela concessão do titular não
  // corrige o dos outros por ter `processo.editar` em outro alcance
  permissao: string | readonly string[] = "processo.ver",
) {
  const [sv] = await tx
    .select()
    .from(tabela_servidor)
    .where(and(aplicar_escopo(usuario, tabela_servidor, permissao), eq(tabela_servidor.id, servidor_id)));
  return sv ?? null;
}

/**
 * A leitura da base compartilhada: o `processo.ver` (o do titular lê o próprio
 * cadastro) ou a base derivada (`PERMISSAO_DA_BASE`), que fica com quem está
 * "Sem acesso" a Processos SEI e trabalha noutro módulo (23/10/2026). O
 * alcance é a união das duas — o mesmo da concessão que a dava.
 */
const LEITURA_DA_BASE: readonly string[] = ["processo.ver", PERMISSAO_DA_BASE];

function _exigir_leitura_da_base(usuario: UsuarioAtual): void {
  if (!LEITURA_DA_BASE.some((p) => usuario.pode(p))) usuario.exigir("processo.ver");
}

type Digitado = Record<string, string | number[]>;

/**
 * A lista, com o popup de cadastro em branco ou com o que foi digitado.
 *
 * `digitado` NÃO entra na URL: o SIAPE e o nome de uma pessoa não podem viajar
 * no `Location`, que vai parar no log e no histórico do navegador. Recusar é
 * renderizar a própria tela de novo, com o popup reaberto por cima da lista.
 */
async function _tela_lista(c: Ctx, usuario: UsuarioAtual, q = "", extra: { erro?: string; digitado?: Digitado } = {}) {
  const tx = c.get("tx");
  // A lista aberta é ferramenta de trabalho para quem instrui processo:
  // `ESCOPO_PROPRIO` devolve o titular e mais nada. Supressão de nome não é
  // supressão de pessoa.
  let itens = await tx.query.servidor.findMany({
    where: aplicar_escopo(usuario, tabela_servidor, LEITURA_DA_BASE),
    with: { cargo: true, unidade: true, uorg: true },
    orderBy: [asc(tabela_servidor.nome)],
  });
  if (q) {
    const alvo = textos.chave_busca(q);
    itens = itens.filter((sv) => identificacao.casa_a_busca(alvo, sv, usuario));
  }
  // O recorte vem DEPOIS do filtro: `casa_a_busca` aplica a RN-19 linha a
  // linha e não cabe na consulta.
  const recorte = recortar(itens, numeroDaPagina(c));
  const servidores = recorte.itens.map((sv) => ({ ...sv, unidade: com_uorg_bruto(sv.unidade), uorg: com_uorg_bruto(sv.uorg) }));
  return pagina(c, "paginas/servidores.html", usuario, {
    servidores,
    recorte,
    busca: q,
    cargos: await tx.select().from(tabela_cargo).orderBy(asc(tabela_cargo.nome)),
    unidades: await unidades_ordenadas(tx),
    postos: await postos_ordenados(tx),
    erro: extra.erro ?? null,
    digitado: extra.digitado ?? {},
  });
}

rotas.get("/servidores", async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_leitura_da_base(usuario);
  return _tela_lista(c, usuario, c.req.query("q") ?? "");
});

function _inteiros(valores: string[]): number[] {
  return valores.filter((v) => /^\d+$/.test(v)).map(Number);
}

rotas.post("/servidores", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.criar");
  const f = await formulario(c);
  const tx = c.get("tx");
  const siape = f.texto("siape").trim();
  const nome = f.texto("nome");
  const cargo_id = f.texto("cargo_id");
  const funcao = f.texto("funcao");
  const unidade_uorg_id = f.texto("unidade_uorg_id");
  const uorg_id = f.texto("uorg_id");
  const email = f.texto("email");
  const postos = _inteiros(f.todos("posto_id"));
  // Tudo o que foi digitado, guardado antes da primeira recusa: o voltar do
  // navegador não devolve um formulário enviado por POST.
  const digitado: Digitado = { siape, nome, cargo_id, funcao, unidade_uorg_id, uorg_id, email, posto_id: postos };
  if (!/^\d{7}$/.test(siape)) {
    return _tela_lista(c, usuario, "", {
      erro: "A matrícula SIAPE tem exatamente 7 dígitos, sem ponto nem traço.",
      digitado,
    });
  }
  // D70: o `required` do nome deixa passar espaços, e a ficha sem nome não
  // se acha por busca nenhuma — a edição já recusava, o cadastro não
  if (!nome.trim()) {
    return _tela_lista(c, usuario, "", { erro: "Informe o nome do servidor: ele não pode ficar em branco.", digitado });
  }
  const [existente] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, siape));
  if (existente) {
    // A ficha é o destino certo; o que faltava era dizer por que se está nela
    // — e que nada do que foi digitado foi gravado.
    return redirecionar(
      c,
      comMensagem(
        `/servidores/${existente.id}`,
        `O SIAPE ${siape} já estava cadastrado — esta é a ficha dele. ` +
          "Nada foi criado: o que você digitou não substituiu o cadastro.",
      ),
    );
  }
  let email_conferido: string | null;
  try {
    email_conferido = await servico_servidores.conferir_email(tx, email);
  } catch (erro) {
    if (!(erro instanceof servico_servidores.LotacaoInvalida)) throw erro;
    const motivo = erro.message.charAt(0).toUpperCase() + erro.message.slice(1);
    return _tela_lista(c, usuario, "", { erro: `${motivo}.`, digitado });
  }
  const [servidor] = await tx
    .insert(tabela_servidor)
    .values({
      siape,
      nome: nome.trim(),
      cargo_id: cargo_id ? Number(cargo_id) : null,
      funcao: funcao || null,
      unidade_uorg_id: unidade_uorg_id ? Number(unidade_uorg_id) : null,
      uorg_id: uorg_id ? Number(uorg_id) : null,
      email: email_conferido,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "servidor",
    entidade_id: servidor!.id,
    tipo_evento: "SERVIDOR_CRIADO",
    descricao: `Servidor SIAPE ${siape} cadastrado.`,
    usuario,
  });
  // abre o primeiro período da linha do tempo com o que foi cadastrado
  await servico_servidores.registrar_lotacao_inicial(tx, servidor!, usuario, { postos });
  return redirecionar(c, `/servidores/${servidor!.id}`);
});

// =====================================================================
// Carga por planilha: prévia, depois confirmação
// =====================================================================
/** O modelo para baixar: só o cabeçalho, no `;` do Excel brasileiro. */
rotas.get("/servidores/modelo.csv", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.criar");
  marcarDownload(c);
  return c.body("\uFEFF" + linha_csv([...importacao_servidores.CABECALHO]), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="modelo_servidores.csv"',
  });
});

/**
 * Roda a carga e mostra linha a linha o que acontece. Na prévia a transação é
 * desfeita; as linhas voltam no formulário de confirmação (no corpo do POST,
 * nunca na URL), e confirmar roda o mesmo código de novo, agora gravando.
 */
async function _carga(c: Ctx, usuario: UsuarioAtual, linhas: importacao_servidores.LinhaArquivo[], aplicar: boolean) {
  const resultado = await importacao_servidores.importar(c.get("tx"), usuario, linhas);
  if (!aplicar) desfazer(c);
  return pagina(c, "paginas/servidores_importar.html", usuario, {
    resultado,
    aplicado: aplicar,
    linhas_json: aplicar ? "" : JSON.stringify(linhas),
  });
}

rotas.post("/servidores/importar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.criar");
  const f = await formulario(c);
  const arquivo = f.dados.get("arquivo");
  if (!(arquivo instanceof File) || !arquivo.size) {
    return _tela_lista(c, usuario, "", { erro: "Escolha o arquivo .csv ou .xlsx com os servidores." });
  }
  let linhas;
  try {
    linhas = await importacao_servidores.ler_arquivo(arquivo.name, new Uint8Array(await arquivo.arrayBuffer()));
  } catch (erro) {
    if (!(erro instanceof importacao_servidores.ArquivoRecusado)) throw erro;
    return _tela_lista(c, usuario, "", { erro: erro.message });
  }
  return _carga(c, usuario, linhas, false);
});

rotas.post("/servidores/importar/confirmar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.criar");
  const f = await formulario(c);
  let linhas;
  try {
    linhas = importacao_servidores.linhas_de_json(f.texto("linhas"));
  } catch (erro) {
    if (!(erro instanceof importacao_servidores.ArquivoRecusado)) throw erro;
    return _tela_lista(c, usuario, "", { erro: erro.message });
  }
  return _carga(c, usuario, linhas, true);
});

/** Corrige nome, SIAPE, e-mail e situação. Lotação muda pelo histórico. */
rotas.post("/servidores/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  // a permissão antes da consulta de escopo e do formulário (D77); o serviço
  // exige de novo — e RN-19: quem não lê nome e SIAPE também não os corrige
  usuario.exigir("processo.editar");
  usuario.exigir("exposicao.ver");
  const id = Number(c.req.param("id"));
  const tx = c.get("tx");
  const servidor = await _servidor_no_escopo(tx, usuario, id, "processo.editar");
  if (!servidor) return redirecionar(c, "/servidores");
  const f = await formulario(c);
  try {
    await servico_servidores.atualizar_cadastro(tx, servidor, usuario, {
      nome: f.texto("nome"),
      siape: f.texto("siape"),
      email: f.texto("email"),
      situacao: f.texto("situacao") || "ATIVO",
    });
  } catch (erro) {
    if (!(erro instanceof servico_servidores.LotacaoInvalida)) throw erro;
    desfazer(c);
    return _ficha(c, usuario, id, { erro: erro.message });
  }
  return redirecionar(c, comMensagem(`/servidores/${id}`, "Cadastro atualizado."));
});

/** Muda unidade/UORG/postos/cargo abrindo um período novo — nada é sobrescrito. */
rotas.post("/servidores/:id{[0-9]+}/lotacao", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.editar");
  const id = Number(c.req.param("id"));
  const tx = c.get("tx");
  const servidor = await _servidor_no_escopo(tx, usuario, id, "processo.editar");
  if (!servidor) return redirecionar(c, "/servidores");
  const f = await formulario(c);
  const inteiro = (chave: string) => {
    const valor = f.texto(chave);
    return /^\d+$/.test(valor) ? Number(valor) : null;
  };
  try {
    const a_partir_de = f.texto("a_partir_de").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a_partir_de)) {
      // o `date.fromisoformat` do Python levantava ValueError (500); aqui a
      // recusa volta à ficha, que é o que a pessoa precisa para corrigir
      throw new servico_servidores.LotacaoInvalida(`data inválida: '${a_partir_de}'`);
    }
    await servico_servidores.alterar_lotacao(tx, servidor, usuario, {
      unidade_uorg_id: inteiro("unidade_uorg_id"),
      uorg_id: inteiro("uorg_id"),
      postos: _inteiros(f.todos("posto_id")),
      cargo_id: inteiro("cargo_id"),
      funcao: f.texto("funcao"),
      a_partir_de,
      documento: f.texto("documento"),
      observacao: f.texto("observacao"),
    });
  } catch (erro) {
    if (!(erro instanceof servico_servidores.LotacaoInvalida)) throw erro;
    desfazer(c);
    return _ficha(c, usuario, id, { erro: erro.message });
  }
  return redirecionar(c, comMensagem(`/servidores/${id}`, "Lotação alterada."));
});

rotas.post("/servidores/:id{[0-9]+}/lotacao/:lotacao{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.editar");
  const id = Number(c.req.param("id"));
  const tx = c.get("tx");
  const f = await formulario(c);
  const [lotacao] = await tx
    .select()
    .from(servidor_lotacao)
    .where(eq(servidor_lotacao.id, Number(c.req.param("lotacao"))));
  if (lotacao && lotacao.servidor_id === id) {
    await servico_servidores.corrigir_lotacao(tx, lotacao, usuario, {
      documento: f.texto("documento"),
      observacao: f.texto("observacao"),
    });
  }
  return redirecionar(c, `/servidores/${id}`);
});

async function _ficha(c: Ctx, usuario: UsuarioAtual, servidor_id: number, recado: { mensagem?: string | null; erro?: string | null } = {}) {
  _exigir_leitura_da_base(usuario);
  const tx = c.get("tx");
  // Mesma resposta para "não existe" e "fora do seu escopo".
  const achado = await _servidor_no_escopo(tx, usuario, servidor_id, LEITURA_DA_BASE);
  if (!achado) return redirecionar(c, "/servidores");

  await auditoria.registrar_leitura_nominal(tx, usuario, "servidor.ficha", { servidor_id: achado.id });

  const servidor = await tx.query.servidor.findFirst({
    where: eq(tabela_servidor.id, achado.id),
    with: { cargo: true, unidade: true, uorg: true },
  });
  // Processos, pareceres e adicionais são do módulo Processos SEI: quem está
  // "Sem acesso" a ele abre a ficha pela base e não os vê — salvo os da
  // própria ficha, que são do titular (23/10/2026).
  const ve_processos =
    usuario.pode_na_equipe("processo.ver") || (usuario.servidor_id !== null && usuario.servidor_id === achado.id && usuario.pode("processo.ver"));
  const processos = ve_processos
    ? await tx.select().from(tabela_processo).where(eq(tabela_processo.servidor_id, achado.id))
    : [];
  const pareceres = ve_processos
    ? await tx.query.parecer_tecnico.findMany({
        where: eq(parecer_tecnico.servidor_id, achado.id),
        with: { laudo: true },
        orderBy: [desc(parecer_tecnico.ano), desc(parecer_tecnico.numero)],
      })
    : [];
  const vigencias = ve_processos
    ? await tx.query.adicional_vigencia.findMany({
        where: eq(adicional_vigencia.servidor_id, achado.id),
        with: { tipo_adicional: true, percentual: true },
      })
    : [];
  // A ficha de EPI entra como seção desta tela (§9 do desenho do módulo). A
  // visibilidade segue a regra da tela do módulo — `epi.ficha`, ou ser o
  // próprio titular —, e não `processo.ver`.
  const epi_visivel =
    usuario.pode("epi.ficha") || (usuario.servidor_id !== null && usuario.servidor_id === achado.id);
  let epi_linhas: { sem_comprovante: boolean }[] = [];
  if (epi_visivel) {
    // importado aqui, e não no topo: a base não pode deixar de abrir porque o
    // módulo de EPI está em manutenção
    const epi_ficha = await import("../servicos/epi_ficha.js");
    epi_linhas = await epi_ficha.linha_do_tempo(tx, achado.id);
  }
  const lotacoes = (await servico_servidores.historico(tx, achado.id))
    .reverse()
    .map((l) => ({ ...l, aberta: l.vigencia_fim === null, uorg: com_uorg_bruto(l.uorg), unidade: com_uorg_bruto(l.unidade) }));
  return pagina(c, "paginas/servidor_ficha.html", usuario, {
    servidor,
    ve_processos,
    epi_visivel,
    // só as cinco últimas: o resumo aponta para a tela do módulo
    epi_linhas: epi_linhas.slice(0, 5),
    epi_total: epi_linhas.length,
    epi_pendentes: epi_linhas.filter((l) => l.sem_comprovante).length,
    processos,
    pareceres,
    vigencias,
    lotacoes,
    postos_atuais: await servico_servidores.postos_atuais(tx, achado.id),
    inconsistencias: await servico_servidores.inconsistencias(tx, achado.id),
    situacoes: SITUACOES,
    unidades: await unidades_ordenadas(tx),
    postos: await tx.select().from(posto_trabalho).orderBy(asc(posto_trabalho.nome)),
    cargos: await tx.select().from(tabela_cargo).orderBy(asc(tabela_cargo.nome)),
    hoje: hoje_iso(),
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
  });
}

rotas.get("/servidores/:id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  return _ficha(c, usuario, Number(c.req.param("id")), {
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});
