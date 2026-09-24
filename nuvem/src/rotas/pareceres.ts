/**
 * Editor do parecer técnico: formulário + pré-visualização + emissão.
 * Porte de `app/rotas/pareceres.py`.
 *
 * Sobre as recusas: no Python a rota fazia `s.commit()` antes de relançar a
 * `PermissaoNegada` da emissão/assinatura, para o `ASSINATURA_NEGADA` ficar na
 * trilha. Aqui lançar desfaz a transação da requisição (`app.ts`); por isso a
 * rota DESENHA a tela de 403 e retorna normalmente — o mesmo resultado para
 * quem vê, e o evento continua gravado.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp, PermissaoNegada } from "../nucleo/erros.js";
import { formulario, usuarioCom, usuarioLogado } from "../dependencias.js";
import { marcarDownload, pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  agente_nocivo,
  autoridade_destinataria,
  exposicao as tabela_exposicao,
  historico_evento,
  laudo_tecnico,
  parecer_posto,
  parecer_tecnico,
  percentual_aplicavel,
  portaria_localizacao,
  posto_trabalho,
  profissional_habilitado,
  setor_emissor,
  texto_padrao,
  tipo_adicional,
  tipo_marco_inicial,
  tipo_movimento,
  unidade_uorg,
} from "../db/esquema/index.js";
import { UnidadeUorg } from "../dominio/organizacao.js";
import * as repo from "../repositorios/processos.js";
import { analisar_portaria } from "../servicos/importacao_planilha.js";
import * as auditoria from "../servicos/auditoria.js";
import * as datas_br from "../servicos/datas_br.js";
import * as documento from "../servicos/documento.js";
import * as numeracao from "../servicos/numeracao.js";
import * as servico from "../servicos/parecer.js";
import type { ParecerCompleto } from "../servicos/parecer.js";
import * as servico_pdf from "../servicos/pdf.js";
import { AVISO_SEM_PDF } from "../servicos/pdf.js";
import * as servico_servidores from "../servicos/servidores.js";
import { obterArmazenamento } from "../servicos/armazenamento.js";
import { TextoProibido } from "../servicos/textos.js";
import { pode_subscrever, type UsuarioAtual } from "../servicos/rbac.js";
import { disposicao } from "./processos.js";

export const rotas = new Hono<Ambiente>();

/**
 * O 422 do `Form(...)` do FastAPI com a frase do `principal.py`: diz QUAIS
 * campos faltaram (só os que faltaram) e que nada foi gravado.
 */
function _incompleto(faltando: string[]): never {
  const lista = faltando.join(", ") || "um campo obrigatório";
  throw new ErroHttp(
    422,
    `O envio chegou sem ${lista}. Volte, preencha o que falta e envie de novo — nada foi gravado.`,
  );
}

function _id(c: Ctx, nome = "parecer_id"): number {
  const v = c.req.param(nome);
  if (!v || !/^\d+$/.test(v)) throw new ErroHttp(422, `Parâmetro inválido: ${nome}`);
  return Number(v);
}

/** `UnidadeUorg.uorg_bruto` era `@property`; a tela a lê como atributo. */
const com_uorg_bruto = <U extends { codigo_uorg: string | null; nome_oficial: string }>(u: U) => ({
  ...u,
  uorg_bruto: UnidadeUorg.uorg_bruto(u),
});

async function _catalogos(c: Ctx) {
  const tx = c.get("tx");
  const textos_de = (categoria: string) =>
    tx
      .select()
      .from(texto_padrao)
      .where(and(eq(texto_padrao.categoria, categoria), eq(texto_padrao.vigente, true)))
      .orderBy(asc(texto_padrao.id));
  return {
    tipos_adicional: await tx.select().from(tipo_adicional).where(eq(tipo_adicional.ativo, true)).orderBy(asc(tipo_adicional.id)),
    movimentos: await tx.select().from(tipo_movimento).where(eq(tipo_movimento.ativo, true)).orderBy(asc(tipo_movimento.id)),
    marcos: await tx.select().from(tipo_marco_inicial).orderBy(asc(tipo_marco_inicial.id)),
    destinatarios: await tx.select().from(autoridade_destinataria).orderBy(asc(autoridade_destinataria.id)),
    signatarios: await tx.select().from(profissional_habilitado).orderBy(asc(profissional_habilitado.id)),
    setores: await tx.select().from(setor_emissor).orderBy(asc(setor_emissor.id)),
    laudos: await tx.query.laudo_tecnico.findMany({ with: { unidade: true }, orderBy: [asc(laudo_tecnico.numero_siape)] }),
    portarias: await tx
      .select()
      .from(portaria_localizacao)
      .orderBy(desc(portaria_localizacao.data_publicacao), asc(portaria_localizacao.id)),
    unidades_emissoras: await tx
      .select()
      .from(unidade_uorg)
      .where(eq(unidade_uorg.emite_portaria, true))
      .orderBy(asc(unidade_uorg.nome_extenso)),
    unidades: (await tx.select().from(unidade_uorg).orderBy(asc(unidade_uorg.nome_extenso))).map(com_uorg_bruto),
    postos: await tx.query.posto_trabalho.findMany({ with: { unidade: true }, orderBy: [asc(posto_trabalho.nome)] }),
    agentes: await tx.select().from(agente_nocivo).where(eq(agente_nocivo.ativo, true)).orderBy(asc(agente_nocivo.id)),
    percentuais: await tx.query.percentual_aplicavel.findMany({
      with: { tipo_adicional: true },
      orderBy: [asc(percentual_aplicavel.id)],
    }),
    recomendacoes: await textos_de("RECOMENDACAO"),
    alteracoes: await textos_de("ALTERACAO"),
    reavaliacoes: await textos_de("REAVALIACAO"),
  };
}

/**
 * O que a tela mostra ao lado de cada exposição — e o que ela **diz**. A data
 * de referência é a **da avaliação**, nesta ordem: `epi_avaliado_em`,
 * `data_avaliacao` da exposição, a emissão, e só então hoje. Leitura pura.
 */
async function _painel_de_epi(c: Ctx, parecer: ParecerCompleto) {
  const epi_ficha = await import("../servicos/epi_ficha.js");
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const painel: Record<string, unknown> = {};
  for (const exposicao of parecer.exposicoes) {
    const referencia = exposicao.epi_avaliado_em || exposicao.data_avaliacao || parecer.data_emissao || hoje;
    painel[exposicao.id] = {
      referencia,
      entregas: parecer.servidor_id ? await epi_ficha.entregas_ate(tx, parecer.servidor_id, referencia) : [],
      pode_neutralizar: servico.epi_pode_neutralizar(parecer, exposicao),
    };
  }
  return dicionario(painel);
}

/** A tela de 403 SEM desfazer a transação (ver o cabeçalho). */
function _negado(c: Ctx, usuario: UsuarioAtual, erro: PermissaoNegada): Promise<Response> {
  return pagina(c, "paginas/erro.html", usuario, { titulo: "403 — acesso negado", detalhe: erro.message, codigo: erro.codigo }, 403);
}

rotas.get("/processos/:processo_id{[0-9]+}/parecer", async (c) => {
  const usuario = await usuarioCom(c, "parecer.criar");
  const tx = c.get("tx");
  const processo = await repo.por_id(tx, usuario, _id(c, "processo_id"));
  if (processo === null) return redirecionar(c, "/processos");

  const hoje = datas_br.hoje();
  const rascunho: Partial<typeof parecer_tecnico.$inferInsert> = {
    numero: 0,
    ano: Number(hoje.slice(0, 4)),
    situacao: "RASCUNHO",
    processo_id: processo.id,
    servidor_id: processo.servidor_id,
    unidade_uorg_id: processo.unidade_uorg_id,
    criado_por: usuario.id,
    modelo_arquivo: documento.MODELO_V1,
  };
  // a lotação vigente já diz unidade, UORG e postos: o rascunho nasce preenchido
  const lotacao = processo.servidor_id ? await servico_servidores.lotacao_vigente(tx, processo.servidor_id) : null;
  if (lotacao !== null) {
    rascunho.unidade_uorg_id = lotacao.unidade_uorg_id || rascunho.unidade_uorg_id;
    rascunho.uorg_id = lotacao.uorg_id;
  }
  const [destinatario] = await tx.select().from(autoridade_destinataria).orderBy(asc(autoridade_destinataria.id)).limit(1);
  if (destinatario) rascunho.destinatario_id = destinatario.id;
  const setor = await servico.setor_emissor_vigente(tx, hoje);
  if (setor) rascunho.setor_emissor_id = setor.id;
  const [novo] = await tx
    .insert(parecer_tecnico)
    .values(rascunho as typeof parecer_tecnico.$inferInsert)
    .returning();
  if (lotacao !== null) {
    let ordem = 1;
    for (const posto of lotacao.postos) {
      await tx.insert(parecer_posto).values({ parecer_id: novo!.id, posto_trabalho_id: posto.id, ordem: ordem++ });
    }
  }
  await auditoria.registrar(tx, {
    entidade: "parecer_tecnico",
    entidade_id: novo!.id,
    processo_id: processo.id,
    tipo_evento: "PARECER_RASCUNHO_CRIADO",
    descricao: `Rascunho de parecer criado para o processo ${processo.nup}.`,
    usuario,
  });
  return redirecionar(c, `/pareceres/${novo!.id}`);
});

/**
 * O editor, com o que a rota GET não pode receber por query string: o que a
 * pessoa enviou e foi recusado por conflito de versão (`nao_gravado`).
 */
async function _desenhar_editor(
  c: Ctx,
  usuario: UsuarioAtual,
  parecer_id: number,
  o: { mensagem?: string | null; erro?: string | null; nao_gravado?: [string, string][] } = {},
): Promise<Response> {
  usuario.exigir("parecer.ver");
  const tx = c.get("tx");
  // A MESMA resposta para "não existe" e "fora do seu escopo".
  const parecer = await servico.no_escopo(tx, usuario, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");

  await auditoria.registrar_leitura_nominal(tx, usuario, "parecer_tecnico.nominal", {
    servidor_id: parecer.servidor_id,
    processo_id: parecer.processo_id,
  });

  const validacao = await servico.validar(tx, parecer);
  const contexto = await servico.montar_contexto(tx, parecer);
  return pagina(c, "paginas/parecer_editor.html", usuario, {
    parecer,
    contexto,
    c: contexto,
    data_extenso: datas_br.por_extenso(contexto.data_emissao),
    validacao,
    numeros_usados: await servico.numeros_usados(tx, parecer),
    pode_assinar: await pode_subscrever(tx, usuario),
    epi: await _painel_de_epi(c, parecer),
    epi_valores: servico.EPI_NEUTRALIZA_VALORES,
    epi_alega: servico.EPI_ALEGA_NEUTRALIZACAO,
    mensagem: o.mensagem !== undefined ? o.mensagem : (c.req.query("mensagem") ?? null),
    erro: o.erro !== undefined ? o.erro : (c.req.query("erro") ?? null),
    nao_gravado: o.nao_gravado ?? [],
    // o botão "Gerar PDF" diz antes do clique se o PDF sai nesta instalação
    pdf_disponivel: servico_pdf.disponivel(),
    AVISO_SEM_PDF,
    ...(await _catalogos(c)),
  });
}

rotas.get("/pareceres/:parecer_id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  return _desenhar_editor(c, usuario, _id(c));
});

// Os campos que a pessoa escreve (e não escolhe numa lista), com o rótulo da
// tela. São os que doem perder.
const _CAMPOS_ESCRITOS: readonly (readonly [keyof ParecerCompleto, string])[] = [
  ["texto_recomendacao", "Recomendação"],
  ["texto_alteracao", "Texto de alteração"],
  ["texto_reavaliacao", "Texto de reavaliação"],
  ["justificativa_marco", "Justificativa do marco inicial"],
  ["numero", "Número"],
  ["data_emissao", "Data de emissão"],
  ["data_marco_inicial", "Data do marco inicial"],
  ["horas_semanais_fonte", "Horas semanais (fonte)"],
];

/** O `str()` do Python para o valor gravado (`Decimal('12.00')` sai '12.00'). */
function _como_texto(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return String(valor);
}

/** O que a pessoa enviou e difere do que está gravado AGORA, para reaplicar. */
function _nao_gravado(parecer: ParecerCompleto, dados: FormData): [string, string][] {
  const saida: [string, string][] = [];
  for (const [campo, rotulo] of _CAMPOS_ESCRITOS) {
    if (!dados.has(campo)) continue;
    const enviado = String(dados.get(campo) ?? "").trim();
    const gravado = _como_texto(parecer[campo]).trim();
    if (enviado && enviado !== gravado) saida.push([rotulo, enviado]);
  }
  return saida;
}

/** Quem salvou por último, e quando — a pergunta que a pessoa faria em seguida. */
async function _frase_do_conflito(c: Ctx, parecer: ParecerCompleto, usuario: UsuarioAtual): Promise<string> {
  const [ultimo] = await c
    .get("tx")
    .select()
    .from(historico_evento)
    .where(and(eq(historico_evento.entidade, "parecer_tecnico"), eq(historico_evento.entidade_id, parecer.id)))
    .orderBy(desc(historico_evento.id))
    .limit(1);
  let quem: string;
  if (!ultimo) quem = "Este parecer foi salvo por outra tela";
  else if (ultimo.usuario_id === usuario.id) {
    quem = `Você mesmo salvou este parecer em outra aba (${datas_br.local_formatado(ultimo.ocorrido_em)})`;
  } else {
    quem = `${ultimo.usuario_nome} salvou este parecer em ${datas_br.local_formatado(ultimo.ocorrido_em)}`;
  }
  return (
    `${quem} enquanto você editava. Nada do que você enviou foi gravado, para ` +
    "não apagar o que foi salvo antes. A tela mostra a versão atual; o que você " +
    "tinha escrito está no quadro “Não gravado”, para conferir e reaplicar."
  );
}

const _int_ou_none = (v: unknown) =>
  typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null;

function _data_ou_none(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ErroHttp(422, `data inválida: ${v}`);
  return v;
}

const CAMPOS_AUDITADOS = [
  "ano",
  "data_emissao",
  "laudo_id",
  "tipo_adicional_id",
  "tipo_movimento_id",
  "portaria_id",
  "tipo_marco_id",
  "data_marco_inicial",
  "texto_recomendacao",
  "texto_alteracao",
  "texto_reavaliacao",
  "signatario_id",
  "destinatario_id",
  "setor_emissor_id",
  "unidade_uorg_id",
  "uorg_id",
] as const;

rotas.post("/pareceres/:parecer_id{[0-9]+}", async (c) => {
  const usuario = await usuarioCom(c, "parecer.editar");
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");
  if (parecer.situacao === "EMITIDO" || parecer.situacao === "ASSINADO") {
    return _desenhar_editor(c, usuario, parecer_id, {
      erro: "Parecer emitido é imutável (RN-14). Crie uma nova versão.",
    });
  }
  const dados = (await formulario(c)).dados;
  const get = (k: string) => (typeof dados.get(k) === "string" ? (dados.get(k) as string) : null);

  // Trava otimista. O formulário leva a `versao` que estava gravada quando a
  // tela foi desenhada; se o banco já está em outra, alguém salvou no meio do
  // caminho. Formulário sem o campo passa como antes.
  const versao_lida = _int_ou_none(dados.get("versao_lida"));
  if (versao_lida !== null && versao_lida !== parecer.versao) {
    return _desenhar_editor(c, usuario, parecer_id, {
      erro: await _frase_do_conflito(c, parecer, usuario),
      nao_gravado: _nao_gravado(parecer, dados),
    });
  }

  const antes: Record<string, unknown> = {};
  for (const campo of CAMPOS_AUDITADOS) antes[campo] = parecer[campo];

  // Número editável enquanto rascunho. O ano é conferido contra o número ANTES
  // de ser gravado: o formulário salva inteiro ou não salva.
  const ano_bruto = get("ano");
  const ano_pedido = ano_bruto ? Number(ano_bruto) : parecer.ano;
  if (!Number.isInteger(ano_pedido)) throw new ErroHttp(422, "ano inválido");
  const numero_pedido = (get("numero") ?? "").trim();
  let pretendido: number | null = null;
  if (/^\d+$/.test(numero_pedido) && Number(numero_pedido) !== parecer.numero) {
    pretendido = Number(numero_pedido);
    const [ocupado] = await tx
      .select()
      .from(parecer_tecnico)
      .where(
        and(
          eq(parecer_tecnico.numero, pretendido),
          eq(parecer_tecnico.ano, ano_pedido),
          ne(parecer_tecnico.id, parecer.id),
        ),
      );
    if (ocupado) {
      return _desenhar_editor(c, usuario, parecer_id, {
        erro:
          `o número ${pretendido}/${ano_pedido} já pertence a outro parecer ` +
          `(${ocupado.situacao.toLowerCase()}) — escolha outro`,
      });
    }
  }

  const p: Partial<typeof parecer_tecnico.$inferInsert> = { ano: ano_pedido };
  if (pretendido !== null) p.numero = pretendido;
  p.data_emissao = _data_ou_none(dados.get("data_emissao"));
  p.laudo_id = _int_ou_none(dados.get("laudo_id"));
  p.tipo_adicional_id = _int_ou_none(dados.get("tipo_adicional_id"));
  p.tipo_movimento_id = _int_ou_none(dados.get("tipo_movimento_id"));
  p.portaria_id = _int_ou_none(dados.get("portaria_id"));
  p.tipo_marco_id = _int_ou_none(dados.get("tipo_marco_id"));
  p.data_marco_inicial = _data_ou_none(dados.get("data_marco_inicial"));
  p.justificativa_marco = get("justificativa_marco") || null;
  p.texto_alteracao = get("texto_alteracao") || null;
  p.texto_reavaliacao = get("texto_reavaliacao") || null;
  p.signatario_id = _int_ou_none(dados.get("signatario_id"));
  p.destinatario_id = _int_ou_none(dados.get("destinatario_id"));
  p.setor_emissor_id = _int_ou_none(dados.get("setor_emissor_id"));
  p.parecer_anterior_id = _int_ou_none(dados.get("parecer_anterior_id"));
  // Unidade e UORG são campos distintos no documento; UORG em branco = usar a Unidade
  p.unidade_uorg_id = _int_ou_none(dados.get("unidade_uorg_id"));
  p.uorg_id = _int_ou_none(dados.get("uorg_id"));
  p.modelo_arquivo = get("modelo_arquivo") || documento.MODELO_V1;
  const horas = get("horas_semanais_fonte");
  if (horas && !Number.isFinite(Number(horas))) throw new ErroHttp(422, "horas_semanais_fonte inválido");
  p.horas_semanais_fonte = horas ? String(Number(horas)) : null;
  p.area_radiologica = get("area_radiologica") || null;

  // RN-05: o marco derivado da portaria é preenchido automaticamente
  const [tipo_marco] = p.tipo_marco_id
    ? await tx.select().from(tipo_marco_inicial).where(eq(tipo_marco_inicial.id, p.tipo_marco_id))
    : [];
  if (tipo_marco && tipo_marco.codigo === "PORTARIA_LOCALIZACAO" && p.portaria_id) {
    const [portaria] = await tx.select().from(portaria_localizacao).where(eq(portaria_localizacao.id, p.portaria_id));
    if (portaria) p.data_marco_inicial = portaria.data_publicacao;
  }

  // recomendação: literal (migrada) ou montada do catálogo
  const texto_livre = get("texto_recomendacao");
  const codigo_modelo = get("recomendacao_modelo");
  if (codigo_modelo && p.data_marco_inicial && !parecer.texto_recomendacao_literal) {
    const [modelo] = await tx
      .select()
      .from(texto_padrao)
      .where(and(eq(texto_padrao.categoria, "RECOMENDACAO"), eq(texto_padrao.codigo, codigo_modelo)));
    const principal = servico.exposicao_principal(parecer);
    const [tipo] = p.tipo_adicional_id
      ? await tx.select().from(tipo_adicional).where(eq(tipo_adicional.id, p.tipo_adicional_id))
      : [];
    if (modelo && tipo && principal !== null) {
      p.texto_recomendacao = servico.montar_recomendacao(
        codigo_modelo,
        tipo.nome_recomendacao,
        principal.agente_nocivo.tipo_risco.nome,
        p.data_marco_inicial,
        modelo.template,
      );
    } else if (texto_livre) {
      p.texto_recomendacao = texto_livre;
    }
  } else if (texto_livre !== null) {
    p.texto_recomendacao = texto_livre || null;
  }

  p.versao = parecer.versao + 1;
  await tx.update(parecer_tecnico).set(p).where(eq(parecer_tecnico.id, parecer.id));

  if (pretendido !== null) {
    const anterior = parecer.numero;
    await auditoria.registrar(tx, {
      entidade: "parecer_tecnico",
      entidade_id: parecer.id,
      processo_id: parecer.processo_id,
      tipo_evento: "NUMERO_DEFINIDO_MANUALMENTE",
      descricao: `Número definido à mão: ${anterior || "(vazio)"} → ${pretendido}`,
      campo: "numero",
      valor_anterior: anterior,
      valor_novo: pretendido,
      usuario,
    });
    // mantém a sequência à frente do maior número já usado
    await numeracao.recontar_sequencia(tx);
  }

  // postos do parecer
  const escolhidos = dados
    .getAll("posto_id")
    .filter((v): v is string => typeof v === "string" && /^\d+$/.test(v))
    .map(Number);
  if (escolhidos.length) {
    await tx.delete(parecer_posto).where(eq(parecer_posto.parecer_id, parecer.id));
    let ordem = 1;
    for (const posto_id of escolhidos) {
      await tx.insert(parecer_posto).values({ parecer_id: parecer.id, posto_trabalho_id: posto_id, ordem: ordem++ });
    }
  }

  const depois: Record<string, unknown> = {};
  const gravado = { ...parecer, ...p } as Record<string, unknown>;
  for (const campo of CAMPOS_AUDITADOS) depois[campo] = gravado[campo];
  await auditoria.registrar_diferencas(tx, {
    entidade: "parecer_tecnico",
    entidade_id: parecer.id,
    antes,
    depois,
    usuario,
    processo_id: parecer.processo_id,
  });
  return redirecionar(c, `/pareceres/${parecer.id}`);
});

/** Cadastra a portaria sem sair do editor — e já vincula ao parecer. */
rotas.post("/pareceres/:parecer_id{[0-9]+}/portaria", async (c) => {
  const usuario = await usuarioCom(c, "parecer.editar");
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const f = await formulario(c);
  const unidade_emissora_id = f.inteiro("unidade_emissora_id");
  if (!f.tem("texto_original") || unidade_emissora_id === null) {
    _incompleto([
      ...(f.tem("texto_original") ? [] : ["texto_original"]),
      ...(unidade_emissora_id === null ? ["unidade_emissora_id"] : []),
    ]);
  }
  const texto_original = f.texto("texto_original");
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");

  const analise = analisar_portaria(texto_original);
  const data_publicacao = f.texto("data_publicacao");
  const quando = data_publicacao || (analise ? analise.data : null);
  if (quando === null) {
    return _desenhar_editor(c, usuario, parecer_id, {
      erro: "não consegui ler a data no texto da portaria — informe a data de publicação no campo ao lado",
    });
  }
  const numero_norm = (f.texto("numero") || (analise ? analise.numero : "")).trim().replace(/^0+/, "") || "0";
  const ano = Number(quando.slice(0, 4));

  let [portaria] = await tx
    .select()
    .from(portaria_localizacao)
    .where(
      and(
        eq(portaria_localizacao.unidade_emissora_id, unidade_emissora_id),
        eq(portaria_localizacao.numero, numero_norm),
        eq(portaria_localizacao.ano, ano),
      ),
    );
  if (!portaria) {
    [portaria] = await tx
      .insert(portaria_localizacao)
      .values({ unidade_emissora_id, numero: numero_norm, ano, data_publicacao: quando, texto_original: texto_original.trim() })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "portaria_localizacao",
      entidade_id: portaria!.id,
      processo_id: parecer.processo_id,
      tipo_evento: "PORTARIA_CRIADA",
      descricao: texto_original.trim(),
      usuario,
    });
  }
  const novos: Partial<typeof parecer_tecnico.$inferInsert> = { portaria_id: portaria!.id };
  // RN-05: com marco na portaria, a data do marco é a da publicação
  if (parecer.tipo_marco && parecer.tipo_marco.codigo === "PORTARIA_LOCALIZACAO") {
    novos.data_marco_inicial = portaria!.data_publicacao;
  }
  await tx.update(parecer_tecnico).set(novos).where(eq(parecer_tecnico.id, parecer.id));
  return redirecionar(c, `/pareceres/${parecer_id}`);
});

rotas.post("/pareceres/:parecer_id{[0-9]+}/exposicoes", async (c) => {
  const usuario = await usuarioCom(c, "parecer.editar");
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const f = await formulario(c);
  const agente_nocivo_id = f.inteiro("agente_nocivo_id");
  const percentual_id = f.inteiro("percentual_id");
  if (agente_nocivo_id === null || percentual_id === null) {
    _incompleto([
      ...(agente_nocivo_id === null ? ["agente_nocivo_id"] : []),
      ...(percentual_id === null ? ["percentual_id"] : []),
    ]);
  }
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null || parecer.situacao === "EMITIDO" || parecer.situacao === "ASSINADO") {
    return redirecionar(c, `/pareceres/${parecer_id}`);
  }

  const [agente] = await tx.select().from(agente_nocivo).where(eq(agente_nocivo.id, agente_nocivo_id));
  if (!agente || agente.fundamentacao_id === null) {
    return _desenhar_editor(c, usuario, parecer_id, { erro: "Agente sem fundamentação legal no catálogo." });
  }
  if (parecer.exposicoes.some((e) => e.agente_nocivo_id === agente_nocivo_id)) {
    return _desenhar_editor(c, usuario, parecer_id, { erro: "Esse agente já está no parecer." });
  }

  const virar_principal = f.texto("principal") === "1" || !parecer.exposicoes.length;
  if (virar_principal) {
    await tx.update(tabela_exposicao).set({ principal: false }).where(eq(tabela_exposicao.parecer_id, parecer.id));
  }

  const numero = (nome: string) => {
    const v = f.texto(nome);
    if (!v) return null;
    if (!Number.isFinite(Number(v))) throw new ErroHttp(422, `${nome} inválido`);
    return Number(v);
  };
  const classificacao = f.texto("classificacao") || null;
  const rascunho = servico.aplicar_classificacao(
    {
      horas_exposicao_mensais: numero("horas_exposicao_mensais") as number | null,
      jornada_mensal_horas: numero("jornada_mensal_horas") as number | null,
      percentual_jornada: null as number | string | null,
      classificacao_exposicao: null as string | null,
      classificacao_origem: "CALCULADA",
    },
    classificacao,
  );
  const aviso = servico.divergencia_de_classificacao(rascunho, classificacao);
  const texto = (v: number | string | null) => (v === null ? null : String(v));
  const [exposicao] = await tx
    .insert(tabela_exposicao)
    .values({
      parecer_id: parecer.id,
      agente_nocivo_id,
      percentual_id,
      fundamentacao_id: agente.fundamentacao_id,
      principal: virar_principal,
      horas_exposicao_mensais: texto(rascunho.horas_exposicao_mensais),
      jornada_mensal_horas: texto(rascunho.jornada_mensal_horas),
      percentual_jornada: texto(rascunho.percentual_jornada),
      classificacao_exposicao: rascunho.classificacao_exposicao,
      classificacao_origem: rascunho.classificacao_origem,
      excecao_art9_par_unico: f.texto("excecao_art9") === "1",
      justificativa_art9: f.texto("justificativa_art9") || null,
    })
    .returning();
  if (aviso) {
    await auditoria.registrar(tx, {
      entidade: "exposicao",
      entidade_id: exposicao!.id,
      processo_id: parecer.processo_id,
      tipo_evento: "CLASSIFICACAO_DIVERGENTE",
      descricao: aviso,
      usuario,
    });
  }

  // RN-06 - agente que exige quantitativa puxa o texto de reavaliação
  if (agente.exige_reavaliacao_quantitativa && !parecer.texto_reavaliacao) {
    const [modelo] = await tx
      .select()
      .from(texto_padrao)
      .where(and(eq(texto_padrao.categoria, "REAVALIACAO"), eq(texto_padrao.codigo, "QUIMICO_QUANTITATIVA")));
    if (modelo) {
      await tx.update(parecer_tecnico).set({ texto_reavaliacao: modelo.template }).where(eq(parecer_tecnico.id, parecer.id));
    }
  }

  const [percentual] = await tx.select().from(percentual_aplicavel).where(eq(percentual_aplicavel.id, percentual_id));
  await auditoria.registrar(tx, {
    entidade: "exposicao",
    entidade_id: exposicao!.id,
    processo_id: parecer.processo_id,
    tipo_evento: "EXPOSICAO_ADICIONADA",
    descricao: `${agente.descricao} · ${percentual?.rotulo ?? ""}`,
    usuario,
  });
  return redirecionar(c, `/pareceres/${parecer_id}`);
});

/**
 * A decisão do §7.1. A regra mora no serviço; aqui só se devolve a recusa. O
 * serviço recusa ANTES de gravar, então a recusa não tem o que desfazer.
 */
rotas.post("/pareceres/:parecer_id{[0-9]+}/exposicoes/:exposicao_id{[0-9]+}/epi", async (c) => {
  const usuario = await usuarioCom(c, "parecer.editar");
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const exposicao_id = _id(c, "exposicao_id");
  const f = await formulario(c);
  if (!f.tem("epi_neutraliza")) _incompleto(["epi_neutraliza"]);
  const parecer = await servico.carregar(tx, parecer_id);
  const exposicao = parecer?.exposicoes.find((e) => e.id === exposicao_id);
  if (!parecer || !exposicao) return redirecionar(c, `/pareceres/${parecer_id}`);
  try {
    await servico.registrar_avaliacao_de_epi(tx, parecer, exposicao, usuario, {
      valor: f.texto("epi_neutraliza"),
      justificativa: f.texto("justificativa_epi"),
    });
  } catch (erro) {
    if (erro instanceof servico.AvaliacaoDeEpiRecusada) {
      return _desenhar_editor(c, usuario, parecer_id, { erro: erro.motivos.join(" · ") });
    }
    if (erro instanceof TextoProibido) return _desenhar_editor(c, usuario, parecer_id, { erro: erro.message });
    throw erro;
  }
  return redirecionar(c, `/pareceres/${parecer_id}`);
});

rotas.post("/pareceres/:parecer_id{[0-9]+}/exposicoes/:exposicao_id{[0-9]+}/excluir", async (c) => {
  await usuarioCom(c, "parecer.editar");
  const tx = c.get("tx");
  const parecer_id = _id(c);
  await tx
    .delete(tabela_exposicao)
    .where(and(eq(tabela_exposicao.id, _id(c, "exposicao_id")), eq(tabela_exposicao.parecer_id, parecer_id)));
  return redirecionar(c, `/pareceres/${parecer_id}`);
});

rotas.post("/pareceres/:parecer_id{[0-9]+}/emitir", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");
  let resultado: servico.ResultadoEmissao;
  try {
    resultado = await servico.emitir(tx, parecer, usuario);
  } catch (erro) {
    if (erro instanceof servico.EmissaoBloqueada) {
      return _desenhar_editor(c, usuario, parecer_id, { erro: erro.motivos.join(" · ") });
    }
    if (erro instanceof PermissaoNegada) return _negado(c, usuario, erro);
    throw erro;
  }
  let mensagem = `Parecer ${parecer.rotulo} emitido.`;
  if (resultado.aviso_pdf) mensagem += " " + AVISO_SEM_PDF;
  return redirecionar(c, `/pareceres/${parecer_id}?mensagem=${encodeURIComponent(mensagem)}`);
});

rotas.post("/pareceres/:parecer_id{[0-9]+}/assinar", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");
  try {
    await servico.assinar(tx, parecer, usuario);
  } catch (erro) {
    if (erro instanceof PermissaoNegada) return _negado(c, usuario, erro);
    if (erro instanceof servico.EmissaoBloqueada) {
      return _desenhar_editor(c, usuario, parecer_id, { erro: erro.motivos.join(" · ") });
    }
    throw erro;
  }
  return redirecionar(c, `/pareceres/${parecer_id}?mensagem=${encodeURIComponent("Parecer assinado.")}`);
});

rotas.post("/pareceres/:parecer_id{[0-9]+}/anular", async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const parecer_id = _id(c);
  const f = await formulario(c);
  if (!f.tem("motivo")) _incompleto(["motivo"]);
  const parecer = await servico.carregar(tx, parecer_id);
  if (parecer === null) return redirecionar(c, "/processos");
  try {
    await servico.anular(tx, parecer, usuario, f.texto("motivo"));
  } catch (erro) {
    // No Python o motivo em branco era `ValueError` sem tratamento (500); aqui
    // a recusa volta ao editor com a frase do serviço.
    if (erro instanceof servico.AnulacaoSemMotivo) {
      return _desenhar_editor(c, usuario, parecer_id, { erro: erro.message });
    }
    throw erro;
  }
  return redirecionar(c, `/pareceres/${parecer_id}?mensagem=${encodeURIComponent("Parecer anulado.")}`);
});

/**
 * Entrega do parecer (arquivo ou prévia) para id inexistente é 404, não 303 —
 * e a MESMA frase para "não existe" e "fora do escopo". O registro da leitura
 * nominal mora AQUI, e não em cada uma das três rotas de saída.
 */
async function _exigir_parecer(c: Ctx, usuario: UsuarioAtual, parecer_id: number): Promise<ParecerCompleto> {
  const tx = c.get("tx");
  const parecer = await servico.no_escopo(tx, usuario, parecer_id);
  if (parecer === null) throw new ErroHttp(404, "O parecer não existe ou está fora do seu escopo.");
  await auditoria.registrar_leitura_nominal(tx, usuario, "parecer_tecnico.documento", {
    servidor_id: parecer.servidor_id,
    processo_id: parecer.processo_id,
    finalidade: "emissão de via do parecer técnico nominal",
  });
  return parecer;
}

/**
 * O `.docx` do parecer no armazenamento; reimpressão fiel quando falta (RN-15:
 * usa o contexto e o modelo congelados na emissão).
 */
async function _docx(c: Ctx, parecer: ParecerCompleto): Promise<[string, Uint8Array]> {
  const tx = c.get("tx");
  const contexto = await servico.montar_contexto(tx, parecer);
  const chave = documento.caminho_saida(
    parecer.numero,
    parecer.ano,
    contexto.sigla_unidade_emissora || "CSSO",
    contexto.nome_servidor,
    "docx",
  );
  const armazenamento = obterArmazenamento();
  if (await armazenamento.existe(chave)) return [chave, await armazenamento.ler(chave)];
  try {
    const info = await documento.renderizar(contexto, chave, parecer.modelo_arquivo);
    return [chave, info.bytes];
  } catch (erro) {
    // DESVIO (corrige defeito do Python): o `.docx` de um rascunho incompleto
    // levantava `DadosIncompletos` (um `ValueError` sem tratador) e a resposta
    // era 500. A recusa é a mesma frase do serviço, com o que falta.
    if (erro instanceof documento.DadosIncompletos) throw new ErroHttp(422, erro.message);
    throw erro;
  }
}

function _servir_docx(c: Ctx, chave: string, bytes: Uint8Array): Response {
  marcarDownload(c);
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "content-disposition": disposicao(chave.split("/").pop()!),
  });
}

rotas.get("/pareceres/:parecer_id{[0-9]+}/docx", async (c) => {
  const usuario = await usuarioCom(c, "parecer.ver");
  const parecer = await _exigir_parecer(c, usuario, _id(c));
  const [chave, bytes] = await _docx(c, parecer);
  return _servir_docx(c, chave, bytes);
});

/**
 * A reimpressão — e a segunda chance do PDF. Na nuvem não há conversão
 * (DESVIOS.md): sai o `.docx`, como saía no Python sem LibreOffice.
 */
rotas.get("/pareceres/:parecer_id{[0-9]+}/pdf", async (c) => {
  const usuario = await usuarioCom(c, "parecer.ver");
  const parecer = await _exigir_parecer(c, usuario, _id(c));
  const [chave, bytes] = await _docx(c, parecer);
  const resultado = servico_pdf.converter_fora_da_transacao(c.get("tx"), chave, chave.replace(/\.docx$/, ".pdf"));
  if (!resultado.gerado) return _servir_docx(c, chave, bytes);
  const pdf = await obterArmazenamento().ler(resultado.caminho!);
  marcarDownload(c);
  return c.body(pdf as unknown as ArrayBuffer, 200, {
    "content-type": "application/pdf",
    "content-disposition": disposicao(resultado.caminho!.split("/").pop()!),
  });
});

/** Fragmento HTMX com a pré-visualização em papel timbrado. */
rotas.get("/pareceres/:parecer_id{[0-9]+}/previa", async (c) => {
  const usuario = await usuarioCom(c, "parecer.ver");
  const parecer = await _exigir_parecer(c, usuario, _id(c));
  const contexto = await servico.montar_contexto(c.get("tx"), parecer);
  return pagina(c, "partes/previa_parecer.html", usuario, {
    parecer,
    c: contexto,
    data_extenso: datas_br.por_extenso(contexto.data_emissao),
  });
});
