/**
 * /treinamentos/* — catálogo, modelos de certificado e assinaturas.
 * Porte de `app/rotas/treinamentos.py`.
 *
 * As três telas seguem o padrão de `/catalogos`: lista com edição em linha,
 * formulário de cadastro embaixo e diff campo a campo na auditoria.
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, isNull, ne, or } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import {
  assinatura_instrutor as tabela_assinatura,
  certificado_modelo as tabela_modelo,
  certificado_modelo_tag as tabela_tag,
  confere_regex,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
} from "../db/esquema/index.js";
import {
  AssinaturaInstrutor,
  CertificadoModelo,
  ORIENTACOES,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_MARCADOR,
  Treinamento,
} from "../dominio/treinamento.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import * as auditoria from "../servicos/auditoria.js";
import * as certificado from "../servicos/certificado.js";
import * as datas_br from "../servicos/datas_br.js";
import { normalizar_decimal } from "../servicos/presenca.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { COM_TAGS } from "../servicos/turma.js";
import { pagina, redirecionar, salvar_com_diff } from "../web.js";
import {
  data_iso,
  erro as _erro,
  id_opcional,
  marcado,
  recados,
  texto_ou_nulo,
  volta as _volta,
  vista_assinatura,
  vista_modelo,
  vista_treinamento,
} from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const CATALOGO = "/treinamentos/catalogo";
export const MODELOS = "/treinamentos/modelos";
export const ASSINATURAS = "/treinamentos/assinaturas";

export const VINCULOS_INSTRUTOR: [string, string][] = [
  ["0", "Servidor da UFVJM"],
  ["1", "Externo"],
];

/** Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita. */
function _horas(valor: string): string | null {
  const horas = normalizar_decimal((valor ?? "").trim().replace(",", "."));
  if (horas === null) return null;
  return Number(horas) > 0 ? horas : null;
}

function _inteiro(valor: string, minimo = 0): number | null {
  const texto = (valor ?? "").trim();
  if (!/^\d+$/.test(texto)) return null;
  const n = Number(texto);
  return n >= minimo ? n : null;
}

/**
 * O nome do .docx, sem pasta. Devolve null quando não serve: a emissão resolve
 * o caminho só pelo nome, e gravar a pasta faria o banco dizer uma coisa e o
 * disco outra.
 */
function _arquivo_de_modelo(valor: string): string | null {
  const nome = (valor ?? "").trim().split(/[\\/]/).pop() ?? "";
  return nome.toLowerCase().endsWith(".docx") ? nome : null;
}

async function _modelo(tx: Executor, id: number) {
  const m = await tx.query.certificado_modelo.findFirst({
    where: eq(tabela_modelo.id, id),
    with: { ...COM_TAGS, treinamento: true } as never,
  });
  return (m as any) ?? null;
}

async function _assinatura(tx: Executor, id: number) {
  return (await tx.query.assinatura_instrutor.findFirst({ where: eq(tabela_assinatura.id, id), with: { servidor: true } })) ?? null;
}

/**
 * Confere o que a linha do catálogo aponta. Devolve o erro, ou "" quando vai.
 * Versão superada e assinatura inativa continuam aceitas quando já são o valor
 * gravado.
 */
async function _confere_vinculos(
  tx: Executor,
  treinamento: typeof tabela_treinamento.$inferSelect,
  modelo_id: number | null,
  instrutor_id: number | null,
): Promise<string> {
  if (modelo_id !== null) {
    const modelo = await _modelo(tx, modelo_id);
    if (!modelo) return "Modelo de certificado não encontrado.";
    if (modelo.treinamento_id !== null && modelo.treinamento_id !== treinamento.id) {
      return `O modelo ${CertificadoModelo.rotulo(modelo)} é de outro treinamento — escolha um do próprio treinamento ou um genérico.`;
    }
    if (!modelo.vigente && modelo_id !== treinamento.modelo_vigente_id) {
      return `${CertificadoModelo.rotulo(modelo)} é versão superada — aponte a versão vigente.`;
    }
  }
  if (instrutor_id !== null) {
    const instrutor = await _assinatura(tx, instrutor_id);
    if (!instrutor) return "Assinatura de instrutor não encontrada.";
    if (!instrutor.ativo && instrutor_id !== treinamento.instrutor_padrao_id) {
      return `A assinatura de ${AssinaturaInstrutor.nome_exibicao(instrutor)} está inativa.`;
    }
  }
  return "";
}

async function _modelos_ordenados(tx: Executor) {
  const itens = await tx.query.certificado_modelo.findMany({
    with: { ...COM_TAGS, treinamento: true } as never,
    orderBy: [asc(tabela_modelo.nome), desc(tabela_modelo.versao)],
  });
  return (itens as any[]).map(vista_modelo);
}

type Recado = { mensagem?: string | null; erro?: string | null; digitado?: Record<string, string> | null };

// =====================================================================
// Catálogo de treinamentos
// =====================================================================
async function _tela_catalogo(c: Ctx, usuario: UsuarioAtual, d: Recado = {}): Promise<Response> {
  const tx = c.get("tx");
  const itens = await tx.query.treinamento.findMany({
    with: { modelo_vigente: { with: COM_TAGS }, instrutor_padrao: { with: { servidor: true } } } as never,
    orderBy: [asc(tabela_treinamento.nome)],
  });
  const instrutores = await tx.query.assinatura_instrutor.findMany({
    with: { servidor: true },
    orderBy: [asc(tabela_assinatura.nome)],
  });
  return pagina(c, "paginas/treinamentos_catalogo.html", usuario, {
    itens: (itens as any[]).map(vista_treinamento),
    modelos: await _modelos_ordenados(tx),
    instrutores: instrutores.map(vista_assinatura),
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
  });
}

rotas.get(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  return _tela_catalogo(c, usuario, recados(c));
});

rotas.post(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado antes da primeira recusa
  const digitado = {
    codigo: f.texto("codigo"),
    nome: f.texto("nome"),
    carga_horaria_horas: f.texto("carga_horaria_horas"),
    // o default NÃO é "0": campo apagado não vira "não expira" em silêncio
    validade_meses: f.texto("validade_meses"),
    norma_referencia: f.texto("norma_referencia"),
    conteudo_programatico: f.texto("conteudo_programatico"),
    obrigatorio: f.texto("obrigatorio"),
  };
  const recusar = (mensagem: string) => _tela_catalogo(c, usuario, { erro: mensagem, digitado });

  const codigo_limpo = digitado.codigo.trim().toUpperCase();
  const nome_limpo = digitado.nome.trim();
  if (!confere_regex(codigo_limpo, PADRAO_CODIGO_TREINAMENTO)) {
    return recusar(
      "Código inválido: use letras maiúsculas, números, ponto, hífen ou sublinhado (NR-35, PRIM_SOCORROS).",
    );
  }
  const horas = _horas(digitado.carga_horaria_horas);
  if (horas === null) return recusar("Carga horária inválida: informe um número maior que zero.");
  const meses = _inteiro(digitado.validade_meses);
  if (meses === null) return recusar("Validade inválida: informe meses inteiros, ou 0 para não expira.");
  const [ja] = await tx
    .select()
    .from(tabela_treinamento)
    .where(or(eq(tabela_treinamento.codigo, codigo_limpo), eq(tabela_treinamento.nome, nome_limpo)));
  if (ja) return recusar(`Já existe treinamento com esse código ou nome (${ja.codigo}).`);

  const [treinamento] = await tx
    .insert(tabela_treinamento)
    .values({
      codigo: codigo_limpo,
      nome: nome_limpo,
      carga_horaria_horas: horas,
      validade_meses: meses,
      norma_referencia: texto_ou_nulo(digitado.norma_referencia),
      conteudo_programatico: texto_ou_nulo(digitado.conteudo_programatico),
      obrigatorio: marcado(digitado.obrigatorio),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "treinamento",
    entidade_id: treinamento!.id,
    tipo_evento: "TREINAMENTO_CRIADO",
    descricao:
      `${treinamento!.codigo} · ${treinamento!.nome} · ` +
      `${horas}h · validade ${Treinamento.validade_rotulo(treinamento!)}`,
    usuario,
  });
  return _volta(c, CATALOGO, `Treinamento ${codigo_limpo} cadastrado.`);
});

rotas.post(`${CATALOGO}/:treinamento_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const treinamento_id = Number(c.req.param("treinamento_id"));
  const f = await formulario(c);
  const horas = _horas(f.texto("carga_horaria_horas"));
  if (horas === null) return _erro(c, CATALOGO, "Carga horária inválida: informe um número maior que zero.");
  const meses = _inteiro(f.texto("validade_meses"));
  if (meses === null) return _erro(c, CATALOGO, "Validade inválida: informe meses inteiros, ou 0 para não expira.");
  const nome_limpo = f.texto("nome").trim();
  const [homonimo] = await tx
    .select()
    .from(tabela_treinamento)
    .where(and(eq(tabela_treinamento.nome, nome_limpo), ne(tabela_treinamento.id, treinamento_id)));
  if (homonimo) return _erro(c, CATALOGO, `Já existe outro treinamento chamado '${nome_limpo}'.`);
  const [alvo] = await tx.select().from(tabela_treinamento).where(eq(tabela_treinamento.id, treinamento_id));
  if (!alvo) return redirecionar(c, CATALOGO);
  const modelo_escolhido = id_opcional(f.texto("modelo_vigente_id"));
  const instrutor_escolhido = id_opcional(f.texto("instrutor_padrao_id"));
  const problema = await _confere_vinculos(tx, alvo, modelo_escolhido, instrutor_escolhido);
  if (problema) return _erro(c, CATALOGO, problema);
  return salvar_com_diff(
    c,
    usuario,
    tabela_treinamento,
    treinamento_id,
    {
      nome: nome_limpo,
      carga_horaria_horas: horas,
      validade_meses: meses,
      norma_referencia: texto_ou_nulo(f.texto("norma_referencia")),
      conteudo_programatico: texto_ou_nulo(f.texto("conteudo_programatico")),
      modelo_vigente_id: modelo_escolhido,
      instrutor_padrao_id: instrutor_escolhido,
      obrigatorio: marcado(f.texto("obrigatorio")),
      ativo: marcado(f.texto("ativo")),
    },
    { permissao: "treinamento.gerenciar", rotulo: "Treinamento", volta: CATALOGO },
  );
});

// =====================================================================
// Modelos de certificado e o dicionário de tags
// =====================================================================
async function _tela_modelos(c: Ctx, usuario: UsuarioAtual, d: Recado = {}) {
  const tx = c.get("tx");
  return pagina(c, "paginas/certificado_modelos.html", usuario, {
    itens: await _modelos_ordenados(tx),
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    orientacoes: ORIENTACOES,
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
  });
}

rotas.get(MODELOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  return _tela_modelos(c, usuario, recados(c));
});

/** A mesma pergunta de unicidade de `criar_modelo` e `editar_modelo`. */
function _mesmo_dono(alvo: number | null) {
  return alvo === null ? isNull(tabela_modelo.treinamento_id) : eq(tabela_modelo.treinamento_id, alvo);
}

rotas.post(MODELOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const digitado = {
    nome: f.texto("nome"),
    arquivo: f.texto("arquivo"),
    treinamento_id: f.texto("treinamento_id"),
    orientacao: f.texto("orientacao") || "PAISAGEM",
    observacao: f.texto("observacao"),
  };
  const recusar = (mensagem: string) => _tela_modelos(c, usuario, { erro: mensagem, digitado });
  const nome_limpo = digitado.nome.trim();
  const arquivo_limpo = _arquivo_de_modelo(digitado.arquivo);
  if (arquivo_limpo === null) return recusar("O modelo é um .docx de app/templates/certificados/.");
  if (!(ORIENTACOES as readonly string[]).includes(digitado.orientacao)) return recusar("Orientação inválida.");
  const alvo = id_opcional(digitado.treinamento_id);
  const [ja] = await tx
    .select()
    .from(tabela_modelo)
    .where(and(eq(tabela_modelo.nome, nome_limpo), _mesmo_dono(alvo)))
    .limit(1);
  if (ja) return recusar(`'${nome_limpo}' já existe — publique uma nova versão na ficha do modelo.`);
  const [modelo] = await tx
    .insert(tabela_modelo)
    .values({
      treinamento_id: alvo,
      nome: nome_limpo,
      arquivo: arquivo_limpo,
      orientacao: digitado.orientacao,
      observacao: texto_ou_nulo(digitado.observacao),
      criado_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo",
    entidade_id: modelo!.id,
    tipo_evento: "CERTIFICADO_MODELO_CRIADO",
    descricao: `${CertificadoModelo.rotulo(modelo!)} · ${modelo!.arquivo}`,
    usuario,
  });
  return _volta(c, `${MODELOS}/${modelo!.id}`, "Modelo cadastrado. Monte o dicionário de tags.");
});

rotas.get(`${MODELOS}/:modelo_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo = await _modelo(tx, Number(c.req.param("modelo_id")));
  if (!modelo) return redirecionar(c, MODELOS);
  vista_modelo(modelo);
  return pagina(c, "paginas/certificado_modelo.html", usuario, {
    modelo,
    conferencia: certificado.conferir_modelo(modelo.arquivo, CertificadoModelo.mapa_de_tags(modelo)),
    campos_por_grupo: certificado.campos_por_grupo(),
    campos: certificado.CAMPOS_CERTIFICADO,
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    orientacoes: ORIENTACOES,
    ...recados(c),
  });
});

rotas.post(`${MODELOS}/:modelo_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const volta = `${MODELOS}/${modelo_id}`;
  const f = await formulario(c);
  const [modelo] = await tx.select().from(tabela_modelo).where(eq(tabela_modelo.id, modelo_id));
  if (!modelo) return redirecionar(c, MODELOS);
  if (!modelo.vigente) {
    return _erro(c, volta, "Versão superada não se edita — ela é o layout de certificados já emitidos.");
  }
  const arquivo_limpo = _arquivo_de_modelo(f.texto("arquivo"));
  if (arquivo_limpo === null) return _erro(c, volta, "O modelo é um .docx de app/templates/certificados/.");
  const orientacao = f.texto("orientacao") || "PAISAGEM";
  if (!(ORIENTACOES as readonly string[]).includes(orientacao)) return _erro(c, volta, "Orientação inválida.");
  const nome_limpo = f.texto("nome").trim();
  const alvo = id_opcional(f.texto("treinamento_id"));
  // a mesma conferência de `criar_modelo`, excluindo o próprio id; as versões do
  // próprio modelo dividem o nome, então só se confere quando ele muda
  if (nome_limpo !== modelo.nome || alvo !== modelo.treinamento_id) {
    const [ja] = await tx
      .select()
      .from(tabela_modelo)
      .where(and(eq(tabela_modelo.nome, nome_limpo), ne(tabela_modelo.id, modelo_id), _mesmo_dono(alvo)))
      .limit(1);
    if (ja) {
      return _erro(
        c,
        volta,
        `Já existe outro modelo chamado '${nome_limpo}' — publique uma nova versão dele em vez de renomear este.`,
      );
    }
  }
  return salvar_com_diff(
    c,
    usuario,
    tabela_modelo,
    modelo_id,
    {
      nome: nome_limpo,
      arquivo: arquivo_limpo,
      treinamento_id: alvo,
      orientacao,
      observacao: texto_ou_nulo(f.texto("observacao")),
    },
    { permissao: "treinamento.gerenciar", rotulo: "Modelo", volta },
  );
});

/**
 * Clona modelo e dicionário para a versão seguinte e aposenta a anterior. Só a
 * versão vigente publica a seguinte: clonar uma superada ressuscitaria o mapa
 * dela e reverteria em silêncio qual dado vai em qual marcador.
 */
rotas.post(`${MODELOS}/:modelo_id{[0-9]+}/versao`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const atual = await _modelo(tx, modelo_id);
  if (!atual) return redirecionar(c, MODELOS);
  if (!atual.vigente) {
    return _erro(
      c,
      `${MODELOS}/${modelo_id}`,
      "Versão superada não se edita — publique a nova versão a partir da que está vigente, para não perder o mapa dela.",
    );
  }
  const irmas = await tx
    .select()
    .from(tabela_modelo)
    .where(and(eq(tabela_modelo.nome, atual.nome), _mesmo_dono(atual.treinamento_id)));
  for (const antiga of irmas) {
    await tx.update(tabela_modelo).set({ vigente: false }).where(eq(tabela_modelo.id, antiga.id));
  }
  const [nova] = await tx
    .insert(tabela_modelo)
    .values({
      treinamento_id: atual.treinamento_id,
      nome: atual.nome,
      arquivo: atual.arquivo,
      orientacao: atual.orientacao,
      observacao: atual.observacao,
      versao: Math.max(...irmas.map((m) => m.versao)) + 1,
      vigente: true,
      criado_por: usuario.id,
    })
    .returning();
  for (const tag of atual.tags as (typeof tabela_tag.$inferSelect)[]) {
    await tx.insert(tabela_tag).values({
      modelo_id: nova!.id,
      marcador: tag.marcador,
      campo: tag.campo,
      ordem: tag.ordem,
      obrigatorio: tag.obrigatorio,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo",
    entidade_id: nova!.id,
    tipo_evento: "CERTIFICADO_MODELO_VERSIONADO",
    descricao: `${CertificadoModelo.rotulo(nova!)} a partir de v${atual.versao} (${atual.tags.length} tags)`,
    usuario,
  });
  return _volta(c, `${MODELOS}/${nova!.id}`, `Versão v${nova!.versao} publicada.`);
});

rotas.post(`${MODELOS}/:modelo_id{[0-9]+}/tags`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const volta = `${MODELOS}/${modelo_id}`;
  const f = await formulario(c);
  const modelo = await _modelo(tx, modelo_id);
  if (!modelo) return redirecionar(c, MODELOS);
  if (!modelo.vigente) return _erro(c, volta, "Versão superada não se edita.");
  const limpo = f.texto("marcador").trim();
  const campo = f.texto("campo");
  if (!confere_regex(limpo, PADRAO_MARCADOR)) {
    return _erro(
      c,
      volta,
      `Marcador inválido: '${limpo}'. Use letra ou sublinhado no começo, depois letras, números e sublinhado.`,
    );
  }
  // nunca chutar a chave: campo desconhecido sairia em branco no papel
  if (!Object.hasOwn(certificado.CAMPOS_CERTIFICADO, campo)) return _erro(c, volta, `Campo desconhecido: '${campo}'.`);
  if (Object.hasOwn(CertificadoModelo.mapa_de_tags(modelo), limpo)) {
    return _erro(c, volta, `O marcador '${limpo}' já está mapeado neste modelo.`);
  }
  // default vazio: sem número, a tag cai no fim da lista
  const posicao = _inteiro(f.texto("ordem"), 1) || modelo.tags.length + 1;
  const [tag] = await tx
    .insert(tabela_tag)
    .values({ modelo_id: modelo.id, marcador: limpo, campo, ordem: posicao, obrigatorio: marcado(f.texto("obrigatorio")) })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo_tag",
    entidade_id: tag!.id,
    tipo_evento: "MODELO_TAG_MAPEADA",
    descricao: `${CertificadoModelo.rotulo(modelo)}: {{ ${limpo} }} ← ${campo}`,
    usuario,
  });
  return _volta(c, volta, `Marcador '${limpo}' mapeado para ${campo}.`);
});

rotas.post(`${MODELOS}/:modelo_id{[0-9]+}/tags/:tag_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const tag_id = Number(c.req.param("tag_id"));
  const volta = `${MODELOS}/${modelo_id}`;
  const f = await formulario(c);
  const [tag] = await tx.select().from(tabela_tag).where(eq(tabela_tag.id, tag_id));
  if (!tag || tag.modelo_id !== modelo_id) return redirecionar(c, volta);
  const [modelo] = await tx.select().from(tabela_modelo).where(eq(tabela_modelo.id, modelo_id));
  if (!modelo!.vigente) return _erro(c, volta, "Versão superada não se edita.");
  if (marcado(f.texto("remover"))) {
    await auditoria.registrar(tx, {
      entidade: "certificado_modelo_tag",
      entidade_id: tag.id,
      tipo_evento: "MODELO_TAG_REMOVIDA",
      descricao: `${CertificadoModelo.rotulo(modelo!)}: {{ ${tag.marcador} }} ← ${tag.campo}`,
      usuario,
    });
    await tx.delete(tabela_tag).where(eq(tabela_tag.id, tag.id));
    return _volta(c, volta, `Marcador '${tag.marcador}' removido do mapa.`);
  }
  const campo = f.texto("campo");
  if (!Object.hasOwn(certificado.CAMPOS_CERTIFICADO, campo)) return _erro(c, volta, `Campo desconhecido: '${campo}'.`);
  return salvar_com_diff(
    c,
    usuario,
    tabela_tag,
    tag_id,
    { campo, ordem: _inteiro(f.texto("ordem"), 1) || tag.ordem, obrigatorio: marcado(f.texto("obrigatorio")) },
    { permissao: "treinamento.gerenciar", rotulo: "Mapa de tags", volta },
  );
});

// =====================================================================
// Assinaturas de instrutor
// =====================================================================
async function _tela_assinaturas(c: Ctx, usuario: UsuarioAtual, d: Recado = {}) {
  const tx = c.get("tx");
  const itens = (
    await tx.query.assinatura_instrutor.findMany({ with: { servidor: true }, orderBy: [asc(tabela_assinatura.nome)] })
  ).map(vista_assinatura);
  const em_uso: Record<number, number> = {};
  for (const a of itens) {
    const [linha] = await tx
      .select({ n: count() })
      .from(tabela_treinamento)
      .where(eq(tabela_treinamento.instrutor_padrao_id, a.id));
    em_uso[a.id] = Number(linha?.n ?? 0);
  }
  return pagina(c, "paginas/assinaturas.html", usuario, {
    itens,
    servidores: await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)),
    vinculos: VINCULOS_INSTRUTOR,
    em_uso,
    hoje: datas_br.hoje(),
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
  });
}

rotas.get(ASSINATURAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("assinatura.gerenciar");
  return _tela_assinaturas(c, usuario, recados(c));
});

/**
 * Valida o vínculo e devolve [campos, erro]. Instrutor da UFVJM precisa de
 * servidor: sem isso o nome do assinante divergiria do cadastro.
 */
async function _dados_da_assinatura(
  tx: Executor,
  d: { externo: boolean; servidor_id: number | null; nome: string; vigencia_inicio: string; vigencia_fim: string },
): Promise<[Record<string, unknown> | null, string]> {
  if (!d.externo && d.servidor_id === null) return [null, "Instrutor da UFVJM precisa estar vinculado a um servidor."];
  let servidor: typeof tabela_servidor.$inferSelect | null = null;
  if (d.servidor_id) {
    const [achado] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, d.servidor_id));
    servidor = achado ?? null;
  }
  if (d.servidor_id !== null && servidor === null) return [null, "Servidor não encontrado."];
  // `nome` é NOT NULL; para o interno ele nasce do cadastro
  const nome_limpo = (d.nome ?? "").trim() || (servidor ? servidor.nome : "");
  if (!nome_limpo) return [null, "Informe o nome do instrutor."];
  const inicio = data_iso(d.vigencia_inicio ?? "");
  if (inicio === null) return [null, "Informe o início da vigência (AAAA-MM-DD)."];
  let fim: string | null = null;
  if ((d.vigencia_fim ?? "").trim()) {
    fim = data_iso(d.vigencia_fim);
    if (fim === null) return [null, "Fim de vigência inválido."];
    if (fim < inicio) return [null, "O fim da vigência não pode ser anterior ao início."];
  }
  return [
    { servidor_id: servidor ? servidor.id : null, nome: nome_limpo, externo: d.externo, vigencia_inicio: inicio, vigencia_fim: fim },
    "",
  ];
}

function _campos_do_formulario(f: Formulario) {
  return {
    nome: f.texto("nome"),
    servidor_id: f.texto("servidor_id"),
    titulo: f.texto("titulo"),
    conselho: f.texto("conselho"),
    registro_conselho: f.texto("registro_conselho"),
    organizacao: f.texto("organizacao"),
    externo: f.texto("externo"),
    vigencia_inicio: f.texto("vigencia_inicio"),
    vigencia_fim: f.texto("vigencia_fim"),
  };
}

rotas.post(ASSINATURAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("assinatura.gerenciar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const digitado = _campos_do_formulario(f);
  const e_externo = marcado(digitado.externo);
  const [campos, problema] = await _dados_da_assinatura(tx, {
    externo: e_externo,
    servidor_id: e_externo ? null : id_opcional(digitado.servidor_id),
    nome: digitado.nome,
    vigencia_inicio: digitado.vigencia_inicio,
    vigencia_fim: digitado.vigencia_fim,
  });
  // tudo o que foi digitado volta: eram nove campos perdidos por esquecer o servidor
  if (campos === null) return _tela_assinaturas(c, usuario, { erro: problema, digitado });
  const [assinatura] = await tx
    .insert(tabela_assinatura)
    .values({
      ...(campos as any),
      titulo: texto_ou_nulo(digitado.titulo),
      conselho: (texto_ou_nulo(digitado.conselho) ?? "").toUpperCase() || null,
      registro_conselho: texto_ou_nulo(digitado.registro_conselho),
      organizacao: texto_ou_nulo(digitado.organizacao),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "assinatura_instrutor",
    entidade_id: assinatura!.id,
    tipo_evento: "ASSINATURA_INSTRUTOR_CRIADA",
    descricao:
      assinatura!.nome +
      (assinatura!.titulo ? ` · ${assinatura!.titulo}` : "") +
      (assinatura!.externo ? " · externo" : " · servidor"),
    usuario,
  });
  return _volta(c, ASSINATURAS, `Assinatura de ${assinatura!.nome} cadastrada.`);
});

rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("assinatura.gerenciar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const digitado = _campos_do_formulario(f);
  const e_externo = marcado(digitado.externo);
  const [campos, problema] = await _dados_da_assinatura(tx, {
    externo: e_externo,
    servidor_id: e_externo ? null : id_opcional(digitado.servidor_id),
    nome: digitado.nome,
    vigencia_inicio: digitado.vigencia_inicio,
    vigencia_fim: digitado.vigencia_fim,
  });
  if (campos === null) return _erro(c, ASSINATURAS, problema);
  return salvar_com_diff(
    c,
    usuario,
    tabela_assinatura,
    Number(c.req.param("assinatura_id")),
    {
      ...campos,
      titulo: texto_ou_nulo(digitado.titulo),
      conselho: (texto_ou_nulo(digitado.conselho) ?? "").toUpperCase() || null,
      registro_conselho: texto_ou_nulo(digitado.registro_conselho),
      organizacao: texto_ou_nulo(digitado.organizacao),
      ativo: marcado(f.texto("ativo")),
    },
    { permissao: "assinatura.gerenciar", rotulo: "Assinatura", volta: ASSINATURAS },
  );
});
