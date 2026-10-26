/**
 * /treinamentos/* — catálogo, modelos de certificado e assinaturas.
 * Porte de `app/rotas/treinamentos.py`.
 *
 * As três telas seguem o padrão de `/catalogos`: lista com edição em linha,
 * formulário de cadastro embaixo e diff campo a campo na auditoria.
 */
import { Hono } from "hono";
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import { and, asc, count, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import {
  anexo as tabela_anexo,
  assinatura_instrutor as tabela_assinatura,
  instrutor_qualificacao as tabela_qualificacao,
  certificado_modelo as tabela_modelo,
  certificado_modelo_tag as tabela_tag,
  confere_regex,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import {
  AssinaturaInstrutor,
  CertificadoModelo,
  ORIENTACOES,
  PADRAO_CODIGO_CURTO,
  PADRAO_CODIGO_TREINAMENTO,
  PADRAO_MARCADOR,
  TAMANHO_MAXIMO_CODIGO_CURTO,
  sugerir_codigo_curto,
  ROTULO_TIPO_TAG,
  TIPOS_TAG,
  type TipoTag,
  Treinamento,
  ROTULO_VINCULO,
} from "../dominio/treinamento.js";
import { CAMPO_CPF_CERTIFICADO, formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import * as cpf_certificado from "../servicos/cpf_certificado.js";
import * as anexos from "../servicos/anexos.js";
import * as qualificacao from "../servicos/qualificacao_instrutor.js";
import * as auditoria from "../servicos/auditoria.js";
import * as dono_turma from "../servicos/dono_turma.js";
import * as exclusao_cadastro from "../servicos/exclusao_cadastro.js";
import * as duplicados from "../servicos/duplicados.js";
import * as mesclagem from "../servicos/mesclagem.js";
import * as servico_participante from "../servicos/participante.js";
import * as campos_certificado from "../servicos/campos_certificado.js";
import * as certificado from "../servicos/certificado.js";
import * as envio from "../servicos/modelo_certificado_envio.js";
import { obterArmazenamento } from "../servicos/armazenamento.js";
import * as datas_br from "../servicos/datas_br.js";
import * as textos from "../servicos/textos.js";
import * as indicadores from "../servicos/treinamento_indicadores.js";
import * as setor_promotor from "../servicos/setor_promotor.js";
import * as hub from "../servicos/hub_treinamentos.js";
import * as setor_equipe from "../servicos/setor_equipe.js";
import { LIMIAR_SUPRESSAO, MARCA_SUPRIMIDO, suprimir } from "./relatorios.js";
import { dicionario } from "../dicionario.js";
import { normalizar_decimal } from "../servicos/presenca.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { COM_TAGS } from "../servicos/turma.js";
import { pagina, redirecionar, salvar_com_diff } from "../web.js";
import { baixar } from "./turmas.js";
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

export const INICIO = "/treinamentos";
export const CATALOGO = "/treinamentos/catalogo";
export const MODELOS = "/treinamentos/modelos";
export const ASSINATURAS = "/treinamentos/assinaturas";
export const PARTICIPANTES = "/treinamentos/participantes";
export const SETORES = setor_promotor.TELA;

// NUVEM: o início de vigência de quem foi cadastrado sem data ("desde sempre").
// `vigencia_inicio` é NOT NULL; uma data bem anterior a qualquer turma basta.
export const VIGENCIA_DESDE_SEMPRE = "2000-01-01";

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

/**
 * O que a tela recebe além dos dados: o recado da faixa, o que foi digitado e,
 * na recusa de uma EDIÇÃO, de qual registro ela veio (`editando_id`) — é ele
 * que diz ao template qual popup volta aberto. Nulo é o popup de cadastro.
 */
type Recado = {
  mensagem?: string | null;
  erro?: string | null;
  digitado?: Record<string, string> | null;
  editando_id?: number | null;
};

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
    // NUVEM: quem altera cada treinamento (`dono_turma.ts`); os outros só consultam
    direitos: await dono_turma.direitos_nos_treinamentos(tx, usuario, itens as { id: number; criado_por: number | null }[]),
    modelos: await _modelos_ordenados(tx),
    instrutores: instrutores.map(vista_assinatura),
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
    editando_id: d.editando_id ?? null,
    padrao_codigo_curto: PADRAO_CODIGO_CURTO,
    tamanho_codigo_curto: TAMANHO_MAXIMO_CODIGO_CURTO,
  });
}

// ---------------------------------------------------------------------
// O código curto (22/10/2026): entra no número do certificado novo
// (`CSSO-NR35-2026-0001`). Obrigatório, único, 2 a 10 letras/algarismos em
// caixa alta. Mudar não mexe no certificado já emitido: o número impresso é
// gravado e imutável (trava `trg_certificado_numero_imutavel`).
// ---------------------------------------------------------------------
const _RE_CODIGO_CURTO = new RegExp(`^(?:${PADRAO_CODIGO_CURTO})$`);
const MENSAGEM_CODIGO_CURTO_INVALIDO =
  "Código curto inválido: de 2 a 10 letras (sem acento) ou algarismos, sem traço nem espaço (NR35, BRIG, PSOC).";

/** Caixa alta e sem espaço nas pontas — o resto o padrão confere. */
function _codigo_curto_digitado(bruto: string): string {
  return bruto.trim().toUpperCase();
}

/**
 * A sugestão livre: `sugerir_codigo_curto` e, se já é de outro treinamento,
 * algarismo no fim — pela MESMA função do banco que a trava usa
 * (`csso_codigo_curto_livre`), para a tela e a trava nunca discordarem.
 */
async function _codigo_curto_livre(tx: Executor, base: string, treinamento_id: number | null): Promise<string> {
  const linhas = await tx.execute<{ livre: string }>(
    sql`SELECT csso_codigo_curto_livre(${base}, ${treinamento_id}::integer) AS livre`,
  );
  return linhas[0]?.livre ?? base;
}

/** O treinamento (outro que não `exceto_id`) que já usa o código curto. */
async function _dono_do_codigo_curto(tx: Executor, codigo_curto: string, exceto_id: number | null) {
  const [dono] = await tx
    .select({ id: tabela_treinamento.id, codigo: tabela_treinamento.codigo, nome: tabela_treinamento.nome })
    .from(tabela_treinamento)
    .where(
      exceto_id === null
        ? eq(tabela_treinamento.codigo_curto, codigo_curto)
        : and(eq(tabela_treinamento.codigo_curto, codigo_curto), ne(tabela_treinamento.id, exceto_id)),
    );
  return dono ?? null;
}

async function _mensagem_duplicado(tx: Executor, codigo_curto: string, dono: { nome: string }, id: number | null) {
  const livre = await _codigo_curto_livre(tx, codigo_curto, id);
  return (
    `O código curto ${codigo_curto} já é do treinamento “${dono.nome}”: cada treinamento tem o seu, ` +
    `porque ele entra no número do certificado. Escolha outro (por exemplo, ${livre}).`
  );
}

// =====================================================================
// Início — a porta do módulo (o "Centro de Certificações" do IntegraSST)
// =====================================================================
/** Os passos do trabalho em cartões, cada um com o que espera nele. */
rotas.get(INICIO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  const hoje = datas_br.hoje();
  const r = await hub.resumo(c.get("tx"), usuario, hoje);
  return pagina(c, "paginas/treinamentos_inicio.html", usuario, {
    r,
    cartoes: hub.cartoes(usuario, r),
    hoje,
    sem_setor_promotor: setor_equipe.sem_setor(usuario),
  });
});

rotas.get(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  // o cadastro dos cursos é da equipe; o titular (D16) escolhe turma em Meus treinamentos
  usuario.exigir_na_equipe("treinamento.ver");
  return _tela_catalogo(c, usuario, recados(c));
});

/** Código a partir do nome, no padrão e no tamanho da coluna (30), sem repetir. */
async function _codigo_do_nome(tx: Executor, nome: string): Promise<string> {
  // corta na palavra: "SEGURANCA_NO_TRABALHO_EM_M" virava código de quem tinha
  // escrito "Segurança no Trabalho em Máquinas"
  const inteiro = textos.slug_ascii(nome).toUpperCase();
  let base = inteiro.slice(0, 26);
  if (inteiro.length > 26 && inteiro[26] !== "_" && base.includes("_")) base = base.slice(0, base.lastIndexOf("_"));
  base = base.replace(/_+$/, "") || "TREINAMENTO";
  for (let n = 1; ; n++) {
    const candidato = n === 1 ? base : `${base}_${n}`;
    const [ja] = await tx
      .select({ id: tabela_treinamento.id })
      .from(tabela_treinamento)
      .where(eq(tabela_treinamento.codigo, candidato));
    if (!ja) return candidato;
  }
}

rotas.post(CATALOGO, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado antes da primeira recusa
  const digitado = {
    codigo: f.texto("codigo"),
    codigo_curto: f.texto("codigo_curto"),
    nome: f.texto("nome"),
    carga_horaria_horas: f.texto("carga_horaria_horas"),
    // NUVEM: vazio no cadastro é 0 (não expira), o default do formulário
    validade_meses: f.texto("validade_meses").trim() || "0",
    norma_referencia: f.texto("norma_referencia"),
    conteudo_programatico: f.texto("conteudo_programatico"),
    obrigatorio: f.texto("obrigatorio"),
  };
  const recusar = (mensagem: string) => _tela_catalogo(c, usuario, { erro: mensagem, digitado });

  const nome_limpo = digitado.nome.trim();
  if (!nome_limpo) return recusar("Informe o nome do treinamento.");
  // NUVEM: código em branco sai do nome ("Brigada de incêndio" → BRIGADA_DE_INCENDIO)
  const codigo_limpo = digitado.codigo.trim().toUpperCase() || (await _codigo_do_nome(tx, nome_limpo));
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
  // o código curto: digitado, ou a sugestão a partir do nome (já livre)
  let codigo_curto = _codigo_curto_digitado(digitado.codigo_curto);
  if (!codigo_curto) {
    // só o código DIGITADO conta: o que sai do nome (BRIGADA_DE_INCENDIO) daria
    // "BRIGADADEI" no lugar das iniciais — e o navegador sugere sem ele
    codigo_curto = await _codigo_curto_livre(tx, sugerir_codigo_curto(nome_limpo, digitado.codigo.trim() || null), null);
  } else {
    if (!_RE_CODIGO_CURTO.test(codigo_curto)) return recusar(MENSAGEM_CODIGO_CURTO_INVALIDO);
    const dono = await _dono_do_codigo_curto(tx, codigo_curto, null);
    if (dono) return recusar(await _mensagem_duplicado(tx, codigo_curto, dono, null));
  }

  const [treinamento] = await tx
    .insert(tabela_treinamento)
    .values({
      codigo: codigo_limpo,
      codigo_curto,
      nome: nome_limpo,
      carga_horaria_horas: horas,
      validade_meses: meses,
      norma_referencia: texto_ou_nulo(digitado.norma_referencia),
      conteudo_programatico: texto_ou_nulo(digitado.conteudo_programatico),
      obrigatorio: marcado(digitado.obrigatorio),
      // NUVEM: o dono do treinamento (`dono_turma.ts`)
      criado_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "treinamento",
    entidade_id: treinamento!.id,
    tipo_evento: "TREINAMENTO_CRIADO",
    descricao:
      `${treinamento!.codigo} · ${treinamento!.nome} · ` +
      `${horas}h · validade ${Treinamento.validade_rotulo(treinamento!)} · código curto ${treinamento!.codigo_curto}`,
    usuario,
  });
  // o nome, que é o que a pessoa digitou; o código gerado sozinho não dizia nada
  return _volta(c, CATALOGO, `Treinamento “${nome_limpo}” cadastrado (código ${codigo_limpo}).`);
});

rotas.post(`${CATALOGO}/:treinamento_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const treinamento_id = Number(c.req.param("treinamento_id"));
  const f = await formulario(c);
  // Tudo o que o popup de edição mandou, para a recusa devolver — antes ela
  // voltava à lista com a faixa vermelha, e o que fora escrito no popup se perdia.
  const digitado = {
    nome: f.texto("nome"),
    codigo_curto: f.texto("codigo_curto"),
    carga_horaria_horas: f.texto("carga_horaria_horas"),
    validade_meses: f.texto("validade_meses"),
    norma_referencia: f.texto("norma_referencia"),
    conteudo_programatico: f.texto("conteudo_programatico"),
    modelo_vigente_id: f.texto("modelo_vigente_id"),
    instrutor_padrao_id: f.texto("instrutor_padrao_id"),
    obrigatorio: f.texto("obrigatorio", ""),
    ativo: f.texto("ativo", ""),
  };
  const recusar = (mensagem: string) =>
    _tela_catalogo(c, usuario, { erro: mensagem, digitado, editando_id: treinamento_id });
  const horas = _horas(digitado.carga_horaria_horas);
  if (horas === null) return recusar("Carga horária inválida: informe um número maior que zero.");
  const meses = _inteiro(digitado.validade_meses);
  if (meses === null) return recusar("Validade inválida: informe meses inteiros, ou 0 para não expira.");
  const nome_limpo = digitado.nome.trim();
  const [homonimo] = await tx
    .select()
    .from(tabela_treinamento)
    .where(and(eq(tabela_treinamento.nome, nome_limpo), ne(tabela_treinamento.id, treinamento_id)));
  if (homonimo) return recusar(`Já existe outro treinamento chamado '${nome_limpo}'.`);
  const [alvo] = await tx.select().from(tabela_treinamento).where(eq(tabela_treinamento.id, treinamento_id));
  if (!alvo) return redirecionar(c, CATALOGO);
  // NUVEM: só o dono do treinamento (ou quem está acima dele) altera
  await dono_turma.exigir_alterar_treinamento(tx, usuario, alvo);
  // O código curto é obrigatório: o popup o exige; quem posta sem o campo
  // (formulário antigo, integração) mantém o de hoje — nunca o apaga.
  const codigo_curto = _codigo_curto_digitado(digitado.codigo_curto) || alvo.codigo_curto;
  if (codigo_curto !== alvo.codigo_curto) {
    if (!_RE_CODIGO_CURTO.test(codigo_curto)) return recusar(MENSAGEM_CODIGO_CURTO_INVALIDO);
    const dono = await _dono_do_codigo_curto(tx, codigo_curto, treinamento_id);
    if (dono) return recusar(await _mensagem_duplicado(tx, codigo_curto, dono, treinamento_id));
  }
  const modelo_escolhido = id_opcional(digitado.modelo_vigente_id);
  const instrutor_escolhido = id_opcional(digitado.instrutor_padrao_id);
  const problema = await _confere_vinculos(tx, alvo, modelo_escolhido, instrutor_escolhido);
  if (problema) return recusar(problema);
  return salvar_com_diff(
    c,
    usuario,
    tabela_treinamento,
    treinamento_id,
    {
      nome: nome_limpo,
      // a mudança vai para a trilha (CAMPO_ALTERADO, por `salvar_com_diff`)
      codigo_curto,
      carga_horaria_horas: horas,
      validade_meses: meses,
      norma_referencia: texto_ou_nulo(digitado.norma_referencia),
      conteudo_programatico: texto_ou_nulo(digitado.conteudo_programatico),
      modelo_vigente_id: modelo_escolhido,
      instrutor_padrao_id: instrutor_escolhido,
      obrigatorio: marcado(digitado.obrigatorio),
      ativo: marcado(digitado.ativo),
    },
    { permissao: "treinamento.gerenciar", rotulo: "Treinamento", volta: CATALOGO },
  );
});

// =====================================================================
// NUVEM: setores promotores — as unidades que o seletor "Unidade promotora"
// da turma oferece (`servicos/setor_promotor.ts`)
// =====================================================================
async function _tela_setores(c: Ctx, usuario: UsuarioAtual, d: Recado = {}): Promise<Response> {
  const tx = c.get("tx");
  const gerencia = usuario.pode(setor_promotor.PERMISSAO);
  const [promotores, turmas_por_unidade, candidatas] = await Promise.all([
    tx.query.unidade_uorg.findMany({
      where: eq(tabela_unidade.promove_treinamento, true),
      with: { campus: true },
      orderBy: [asc(tabela_unidade.nome_extenso)],
    }),
    tx
      .select({ id: tabela_turma.unidade_promotora_id, n: count() })
      .from(tabela_turma)
      .groupBy(tabela_turma.unidade_promotora_id),
    // só quem inclui precisa da lista inteira da UFVJM
    gerencia
      ? tx
          .select()
          .from(tabela_unidade)
          .where(and(eq(tabela_unidade.promove_treinamento, false), eq(tabela_unidade.ativo, true)))
          .orderBy(asc(tabela_unidade.nome_extenso))
      : Promise.resolve([]),
  ]);
  const turmas = new Map(turmas_por_unidade.map((l) => [l.id, Number(l.n)]));
  // a unidade que promoveu turma e saiu da lista: os filtros ainda a mostram
  const fora = turmas_por_unidade.filter((l) => l.id !== null && !promotores.some((u) => u.id === l.id)).length;
  return pagina(c, "paginas/setores_promotores.html", usuario, {
    promotores: promotores.map((u) => ({ ...u, turmas: turmas.get(u.id) ?? 0 })),
    candidatas,
    gerencia,
    fora_da_lista_com_turma: fora,
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
  });
}

rotas.get(SETORES, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  return _tela_setores(c, usuario, recados(c));
});

/** Inclui a unidade na lista (`unidade_id`) — diff na trilha, como os catálogos. */
rotas.post(SETORES, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(setor_promotor.PERMISSAO);
  const f = await formulario(c);
  const unidade_id = id_opcional(f.texto("unidade_id"));
  if (unidade_id === null) return _erro(c, SETORES, "Escolha a unidade que passa a promover treinamentos.");
  try {
    const u = await setor_promotor.marcar(c.get("tx"), usuario, unidade_id, true);
    return _volta(c, SETORES, `${u.nome_extenso} passa a aparecer no seletor “Unidade promotora” das turmas.`);
  } catch (e) {
    if (e instanceof setor_promotor.SetorPromotorRecusado) return _erro(c, SETORES, e.message);
    throw e;
  }
});

/** Retira da lista. A turma que já aponta para a unidade fica com ela. */
rotas.post(`${SETORES}/:unidade_id{[0-9]+}/retirar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(setor_promotor.PERMISSAO);
  try {
    const u = await setor_promotor.marcar(c.get("tx"), usuario, Number(c.req.param("unidade_id")), false);
    return _volta(
      c,
      SETORES,
      `${u.nome_extenso} saiu da lista: não aparece mais em turma nova. ` +
        "As turmas que já a têm continuam com ela, e os certificados emitidos não mudam.",
    );
  } catch (e) {
    if (e instanceof setor_promotor.SetorPromotorRecusado) return _erro(c, SETORES, e.message);
    throw e;
  }
});

/** O treinamento cadastrado por engano, que nunca teve turma (`exclusao_cadastro.ts`). */
rotas.post(`${CATALOGO}/:treinamento_id{[0-9]+}/excluir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  // NUVEM: só o dono do treinamento (ou quem está acima dele) exclui
  const [alvo] = await c
    .get("tx")
    .select({ id: tabela_treinamento.id, criado_por: tabela_treinamento.criado_por })
    .from(tabela_treinamento)
    .where(eq(tabela_treinamento.id, Number(c.req.param("treinamento_id"))));
  if (alvo) await dono_turma.exigir_alterar_treinamento(c.get("tx"), usuario, alvo);
  try {
    const codigo = await c
      .get("tx")
      .transaction((sp) => exclusao_cadastro.excluir_treinamento(sp as Executor, usuario, Number(c.req.param("treinamento_id"))));
    return _volta(c, CATALOGO, `Treinamento ${codigo} excluído.`);
  } catch (erro) {
    if (erro instanceof exclusao_cadastro.ExclusaoRecusada) return _erro(c, CATALOGO, erro.message);
    throw erro;
  }
});

// =====================================================================
// Modelos de certificado e o dicionário de tags
// =====================================================================
/**
 * NUVEM: lê, converte e grava o .docx enviado. Devolve a mensagem de recusa
 * (texto) quando o arquivo não serve. O convertido vai para o armazenamento
 * endereçado pelo conteúdo — o mesmo arquivo enviado duas vezes ocupa um só.
 */
async function _guardar_envio(docx: File) {
  if (!docx.name.toLowerCase().endsWith(".docx")) {
    return "Envie um arquivo .docx (documento do Word). PDF, .doc e .odt não servem como modelo.";
  }
  let preparado: ReturnType<typeof envio.preparar_envio>;
  try {
    preparado = envio.preparar_envio(new Uint8Array(await docx.arrayBuffer()));
  } catch (e) {
    if (e instanceof envio.ModeloInvalido) return e.message;
    throw e;
  }
  const chave = envio.chave_no_armazenamento(preparado.enviado.sha256_convertido);
  const armazenamento = obterArmazenamento();
  if (!(await armazenamento.existe(chave))) await armazenamento.gravar(chave, preparado.convertido, envio.TIPO_DOCX);
  return { ...preparado, arquivo: envio.nome_do_arquivo(docx.name) };
}

/**
 * Uma linha por marcador do arquivo, na ordem do documento: o rótulo, o trecho
 * ao redor, o campo mapeado (se houver) e a sugestão. Lê o vocabulário inteiro
 * a cada vez — campo novo em `CAMPOS_CERTIFICADO` aparece aqui sem mexer na tela.
 */
function _linhas_do_mapa(modelo: any) {
  const por_marcador = new Map<string, any>((modelo.tags as any[]).map((t) => [t.marcador, t]));
  return certificado.marcadores_detalhados(modelo).map((m) => {
    const tag = por_marcador.get(m.marcador) ?? null;
    const sugestao = certificado.sugerir_campo(m);
    const tipo: string = tag?.tipo ?? "SISTEMA";
    return {
      ...m,
      tag,
      tipo,
      campo: tag ? (tag.campo as string) : null,
      sugestao,
      sugestao_rotulo: sugestao ? certificado.CAMPOS_CERTIFICADO[sugestao]!.rotulo : null,
      // o que o seletor mostra escolhido: o mapa gravado, senão a sugestão;
      // preenchimento à parte aparece como "@TIPO"
      escolhido: tag ? (tipo === "SISTEMA" ? (tag.campo as string) : `@${tipo}`) : (sugestao ?? ""),
      // texto fixo ou nome do campo; sem nada gravado, o próprio texto do Word
      detalhe: (tag?.texto_fixo || tag?.rotulo || _nome_sugerido(m)) as string,
    };
  });
}

/**
 * O nome que a caixa propõe para o campo livre: o texto do marcador; quando ele
 * é só lacuna («___», «___ %»), o rótulo que vem antes no Word ("Primeiros
 * socorros: «___»" → "Primeiros socorros").
 */
function _nome_sugerido(m: { marcador: string; rotulo: string; antes?: string }): string {
  if (/\p{L}/u.test(m.rotulo)) return m.rotulo !== m.marcador ? m.rotulo : "";
  const ultimo = (m.antes ?? "").split(/\s\/\s|[.»]\s/).pop() ?? "";
  return ultimo.replace(/[:\-–\s]+$/u, "").replace(/^[\s/«…]+/u, "").trim().slice(0, 80);
}

async function _tela_modelos(c: Ctx, usuario: UsuarioAtual, d: Recado = {}) {
  const tx = c.get("tx");
  return pagina(c, "paginas/certificado_modelos.html", usuario, {
    itens: await _modelos_ordenados(tx),
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    arquivos: certificado.arquivos_de_modelo(),
    limite_mb: envio.LIMITE_BYTES / 1024 / 1024,
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
  if (!nome_limpo) return recusar("Dê um nome ao modelo.");
  // NUVEM: o .docx enviado pela tela; sem ele, um dos layouts que vêm com o sistema
  const docx = f.arquivo("docx");
  let enviado: Exclude<Awaited<ReturnType<typeof _guardar_envio>>, string> | null = null;
  if (docx) {
    const recebido = await _guardar_envio(docx);
    if (typeof recebido === "string") return recusar(recebido);
    enviado = recebido;
  }
  const arquivo_limpo = enviado ? enviado.arquivo : _arquivo_de_modelo(digitado.arquivo);
  if (arquivo_limpo === null) return recusar("Escolha o arquivo .docx do modelo.");
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
      arquivo_sha256: enviado ? enviado.sha256_origem : null,
      arquivo_enviado: enviado ? enviado.enviado : null,
      orientacao: digitado.orientacao,
      observacao: texto_ou_nulo(digitado.observacao),
      criado_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo",
    entidade_id: modelo!.id,
    tipo_evento: "CERTIFICADO_MODELO_CRIADO",
    descricao:
      `${CertificadoModelo.rotulo(modelo!)} · ${modelo!.arquivo}` +
      (enviado ? ` (enviado pela tela, ${enviado.enviado.marcadores.length} marcadores)` : ""),
    usuario,
  });
  return _volta(
    c,
    `${MODELOS}/${modelo!.id}`,
    enviado
      ? `Modelo cadastrado com ${enviado.enviado.marcadores.length} marcador(es). Escolha o dado de cada um e salve.`
      : "Modelo cadastrado. Escolha o dado de cada marcador e salve.",
  );
});

/**
 * A ficha do modelo. Recebe recado porque a edição de uma linha do mapa de
 * marcadores, recusada, volta a ela com o popup daquela linha aberto e o que
 * foi digitado (`editando_id` é o id da tag).
 */
async function _tela_modelo(c: Ctx, usuario: UsuarioAtual, modelo_id: number, d: Recado = {}): Promise<Response> {
  const tx = c.get("tx");
  const modelo = await _modelo(tx, modelo_id);
  if (!modelo) return redirecionar(c, MODELOS);
  vista_modelo(modelo);
  const conferencia = certificado.conferir_modelo(modelo, CertificadoModelo.marcadores_mapeados(modelo));
  const linhas = conferencia.arquivo_encontrado ? _linhas_do_mapa(modelo) : [];
  return pagina(c, "paginas/certificado_modelo.html", usuario, {
    tipos_tag: TIPOS_TAG.map((t) => [t, ROTULO_TIPO_TAG[t]]),
    rotulo_tipo_tag: ROTULO_TIPO_TAG,
    modelo,
    conferencia,
    linhas,
    faltam: linhas.filter((l) => !l.tag).length,
    enviado: Boolean(modelo.arquivo_enviado),
    limite_mb: envio.LIMITE_BYTES / 1024 / 1024,
    // os sem mapa que o "aplicar sugestões" resolve
    com_sugestao: linhas.filter((l) => !l.tag && l.sugestao),
    campos_por_grupo: certificado.campos_por_grupo(),
    campos: certificado.CAMPOS_CERTIFICADO,
    arquivos: certificado.arquivos_de_modelo(),
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    // os treinamentos que hoje emitem com ESTA versão: são eles que a nova pode herdar
    apontam: await tx
      .select()
      .from(tabela_treinamento)
      .where(eq(tabela_treinamento.modelo_vigente_id, modelo.id))
      .orderBy(asc(tabela_treinamento.nome)),
    orientacoes: ORIENTACOES,
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
    editando_id: d.editando_id ?? null,
  });
}

rotas.get(`${MODELOS}/:modelo_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  return _tela_modelo(c, usuario, Number(c.req.param("modelo_id")), recados(c));
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
  // o arquivo enviado pela tela só muda publicando uma versão nova com outro .docx
  const arquivo_limpo = modelo.arquivo_enviado ? modelo.arquivo : _arquivo_de_modelo(f.texto("arquivo"));
  if (arquivo_limpo === null) return _erro(c, volta, "Escolha o arquivo .docx do modelo.");
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
  const f = await formulario(c);
  // NUVEM: a versão nova pode trazer outro .docx; sem ele, o layout continua o mesmo
  const docx = f.arquivo("docx");
  let novo_arquivo: Exclude<Awaited<ReturnType<typeof _guardar_envio>>, string> | null = null;
  if (docx) {
    const recebido = await _guardar_envio(docx);
    if (typeof recebido === "string") return _erro(c, `${MODELOS}/${modelo_id}`, recebido);
    novo_arquivo = recebido;
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
      arquivo: novo_arquivo ? novo_arquivo.arquivo : atual.arquivo,
      arquivo_sha256: novo_arquivo ? novo_arquivo.sha256_origem : atual.arquivo_sha256,
      arquivo_enviado: novo_arquivo ? novo_arquivo.enviado : atual.arquivo_enviado,
      orientacao: atual.orientacao,
      observacao: atual.observacao,
      versao: Math.max(...irmas.map((m) => m.versao)) + 1,
      vigente: true,
      criado_por: usuario.id,
    })
    .returning();
  // o dicionário inteiro, inclusive o tipo de preenchimento, o texto fixo e o
  // rótulo dos campos de turma/participante (os valores digitados nas turmas
  // são guardados pelo marcador e continuam valendo); com arquivo novo, só vai
  // junto o mapa dos marcadores que ele ainda tem
  const no_novo = novo_arquivo ? new Set(novo_arquivo.enviado.marcadores.map((m) => m.marcador)) : null;
  const clonadas = (atual.tags as (typeof tabela_tag.$inferSelect)[])
    .filter((t) => !no_novo || no_novo.has(t.marcador))
    .map((tag) => ({
      modelo_id: nova!.id,
      marcador: tag.marcador,
      campo: tag.campo,
      ordem: tag.ordem,
      obrigatorio: tag.obrigatorio,
      tipo: tag.tipo,
      texto_fixo: tag.texto_fixo,
      rotulo: tag.rotulo,
    }));
  if (clonadas.length) await tx.insert(tabela_tag).values(clonadas);
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo",
    entidade_id: nova!.id,
    tipo_evento: "CERTIFICADO_MODELO_VERSIONADO",
    descricao:
      `${CertificadoModelo.rotulo(nova!)} a partir de v${atual.versao} (${clonadas.length} tags)` +
      (novo_arquivo ? ` · arquivo novo ${novo_arquivo.arquivo}` : ""),
    usuario,
  });
  // Repontar é escolha de quem publica, feita na hora e um evento por
  // treinamento — e não efeito colateral silencioso de publicar. Sem a escolha,
  // o certificado seguia saindo com o layout superado até alguém lembrar de
  // trocar no catálogo (dívida técnica fechada em 18/10/2026).
  let repontados = 0;
  if (f.texto("repontar") === "1") {
    const alvo = await tx.select().from(tabela_treinamento).where(eq(tabela_treinamento.modelo_vigente_id, atual.id));
    for (const t of alvo) {
      await tx.update(tabela_treinamento).set({ modelo_vigente_id: nova!.id }).where(eq(tabela_treinamento.id, t.id));
      await auditoria.registrar(tx, {
        entidade: "treinamento",
        entidade_id: t.id,
        tipo_evento: "TREINAMENTO_MODELO_REPONTADO",
        descricao: `${t.nome}: certificado passa de v${atual.versao} para v${nova!.versao} (${nova!.nome})`,
        campo: "modelo_vigente_id",
        valor_anterior: atual.id,
        valor_novo: nova!.id,
        usuario,
      });
      repontados += 1;
    }
  }
  return _volta(
    c,
    `${MODELOS}/${nova!.id}`,
    `Versão v${nova!.versao} publicada.` +
      (repontados ? ` ${repontados} treinamento(s) passa(m) a emitir com ela.` : ""),
  );
});

/**
 * NUVEM: a linha do dicionário como foi digitada. Na tabela da ficha o texto
 * fixo e o nome do campo dividem uma caixa só (`detalhe`), lida conforme o tipo.
 */
function _tag_digitada(f: Formulario, tipo_padrao: string) {
  const tipo = f.texto("tipo") || tipo_padrao;
  const detalhe = f.texto("detalhe");
  return campos_certificado.dados_da_tag({
    tipo,
    campo: f.texto("campo"),
    texto_fixo: f.texto("texto_fixo") || (tipo === "TEXTO_FIXO" ? detalhe : ""),
    rotulo: f.texto("rotulo") || (tipo === "TURMA" || tipo === "PARTICIPANTE" ? detalhe : ""),
  });
}

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
  if (!confere_regex(limpo, PADRAO_MARCADOR)) {
    return _erro(
      c,
      volta,
      `Marcador inválido: '${limpo}'. Use letra ou sublinhado no começo, depois letras, números e sublinhado.`,
    );
  }
  // tipo do sistema: campo fechado no vocabulário (nunca chutar a chave)
  const [dados, recusa] = _tag_digitada(f, "SISTEMA");
  if (!dados) return _erro(c, volta, recusa);
  if (Object.hasOwn(CertificadoModelo.marcadores_mapeados(modelo), limpo)) {
    return _erro(c, volta, `O marcador '${limpo}' já está mapeado neste modelo.`);
  }
  // default vazio: sem número, a tag cai no fim da lista
  const posicao = _inteiro(f.texto("ordem"), 1) || modelo.tags.length + 1;
  const [tag] = await tx
    .insert(tabela_tag)
    .values({ modelo_id: modelo.id, marcador: limpo, ...dados, ordem: posicao, obrigatorio: marcado(f.texto("obrigatorio")) })
    .returning();
  const destino = campos_certificado.descrever_tag(tag!);
  await auditoria.registrar(tx, {
    entidade: "certificado_modelo_tag",
    entidade_id: tag!.id,
    tipo_evento: "MODELO_TAG_MAPEADA",
    descricao: `${CertificadoModelo.rotulo(modelo)}: {{ ${limpo} }} ← ${destino}`,
    usuario,
  });
  return _volta(c, volta, `Marcador '${limpo}' mapeado para ${destino}.`);
});

/**
 * NUVEM: mapeia de uma vez os marcadores do arquivo ainda sem linha que têm
 * sugestão em `MAPA_SUGERIDO` — o dicionário do layout padrão. Um evento de
 * trilha por tag, como o mapeamento manual; o que já está mapeado não muda.
 */
rotas.post(`${MODELOS}/:modelo_id{[0-9]+}/tags/sugeridas`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const volta = `${MODELOS}/${modelo_id}`;
  const modelo = await _modelo(tx, modelo_id);
  if (!modelo) return redirecionar(c, MODELOS);
  if (!modelo.vigente) return _erro(c, volta, "Versão superada não se edita.");
  const conferencia = certificado.conferir_modelo(modelo, CertificadoModelo.marcadores_mapeados(modelo));
  if (!conferencia.arquivo_encontrado) {
    return _erro(c, volta, `O arquivo '${modelo.arquivo}' não foi encontrado — não há marcadores para mapear.`);
  }
  const sem_tag = _linhas_do_mapa(modelo).filter((l) => !l.tag);
  const a_mapear = sem_tag.filter((l) => l.sugestao);
  if (!a_mapear.length) return _erro(c, volta, "Nenhum marcador sem dado tem sugestão — escolha à mão.");
  let ordem = modelo.tags.length;
  for (const { marcador, sugestao } of a_mapear) {
    const campo = sugestao!;
    const [tag] = await tx
      .insert(tabela_tag)
      .values({
        modelo_id: modelo.id,
        marcador,
        campo,
        ordem: ++ordem,
        // no modelo enviado, todo dado escolhido bloqueia se vier vazio (menos "deixar em branco")
        obrigatorio: certificado.OBRIGATORIOS.includes(marcador) || (!!modelo.arquivo_enviado && campo !== "em_branco"),
      })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "certificado_modelo_tag",
      entidade_id: tag!.id,
      tipo_evento: "MODELO_TAG_MAPEADA",
      descricao: `${CertificadoModelo.rotulo(modelo)}: {{ ${marcador} }} ← ${campo} (sugerido)`,
      usuario,
    });
  }
  const restam = sem_tag.length - a_mapear.length;
  return _volta(
    c,
    volta,
    `${a_mapear.length} marcador(es) ligado(s) pela sugestão.` + (restam ? ` Faltam ${restam}: escolha o dado de cada um.` : ""),
  );
});

/**
 * NUVEM: salva o mapa inteiro de uma vez — um seletor por marcador do arquivo
 * (`campo__<marcador>`; vazio = sem dado) e a caixa "vazio bloqueia"
 * (`obrigatorio__<marcador>`). Linha nova é um `MODELO_TAG_MAPEADA`, troca de
 * campo vai para a trilha campo a campo, e esvaziar remove a linha.
 */
rotas.post(`${MODELOS}/:modelo_id{[0-9]+}/mapa`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const volta = `${MODELOS}/${modelo_id}`;
  const f = await formulario(c);
  const modelo = await _modelo(tx, modelo_id);
  if (!modelo) return redirecionar(c, MODELOS);
  if (!modelo.vigente) return _erro(c, volta, "Versão superada não se edita.");
  const linhas = certificado.conferir_modelo(modelo, {}).arquivo_encontrado ? _linhas_do_mapa(modelo) : [];
  if (!linhas.length) {
    return _erro(c, volta, `O arquivo '${modelo.arquivo}' não foi encontrado — não há marcadores para mapear.`);
  }
  // "@TIPO" no seletor é preenchimento à parte (texto fixo, campo da turma ou
  // do participante), com o texto/nome na caixa ao lado; o resto é campo do sistema
  type Escolha = { tipo: string; campo: string; texto_fixo: string | null; rotulo: string | null };
  const escolha_de = (marcador: string): Escolha | string | null => {
    const valor = f.texto(`campo__${marcador}`);
    if (!valor) return null;
    const detalhe = f.texto(`detalhe__${marcador}`).trim();
    if (valor.startsWith("@")) {
      const tipo = valor.slice(1);
      if (!(TIPOS_TAG as readonly string[]).includes(tipo) || tipo === "SISTEMA") return `Preenchimento desconhecido: '${valor}'.`;
      if (!detalhe) {
        return tipo === "TEXTO_FIXO"
          ? `Escreva o texto fixo de “${marcador}”.`
          : `Dê um nome ao campo de “${marcador}” (é o que aparece na turma).`;
      }
      return tipo === "TEXTO_FIXO"
        ? { tipo, campo: "", texto_fixo: detalhe, rotulo: null }
        : { tipo, campo: "", texto_fixo: null, rotulo: detalhe };
    }
    if (!Object.hasOwn(certificado.CAMPOS_CERTIFICADO, valor)) return `Campo desconhecido: '${valor}'.`;
    return { tipo: "SISTEMA", campo: valor, texto_fixo: null, rotulo: null };
  };
  // confere tudo antes de gravar: uma escolha inválida não deixa meio mapa salvo
  const escolhas = new Map<string, Escolha | null>();
  for (const l of linhas) {
    if (!f.tem(`campo__${l.marcador}`)) continue;
    const e = escolha_de(l.marcador);
    if (typeof e === "string") return _erro(c, volta, e);
    escolhas.set(l.marcador, e);
  }
  let ordem = Math.max(0, ...(modelo.tags as { ordem: number }[]).map((t) => t.ordem));
  let mudou = 0;
  let faltam = 0;
  for (const l of linhas) {
    const tag = l.tag as typeof tabela_tag.$inferSelect | null;
    // linha que não veio no formulário fica como está
    if (!escolhas.has(l.marcador)) {
      if (!tag) faltam += 1;
      continue;
    }
    const e = escolhas.get(l.marcador)!;
    if (!e) {
      faltam += 1;
      if (!tag) continue;
      await auditoria.registrar(tx, {
        entidade: "certificado_modelo_tag",
        entidade_id: tag.id,
        tipo_evento: "MODELO_TAG_REMOVIDA",
        descricao: `${CertificadoModelo.rotulo(modelo)}: {{ ${tag.marcador} }} ← ${tag.campo || tag.rotulo || tag.texto_fixo}`,
        usuario,
      });
      await tx.delete(tabela_tag).where(eq(tabela_tag.id, tag.id));
      mudou += 1;
      continue;
    }
    const obrigatorio = e.campo !== "em_branco" && marcado(f.texto(`obrigatorio__${l.marcador}`));
    const valores = { ...e, obrigatorio };
    const descreve = e.tipo === "SISTEMA" ? e.campo : `${ROTULO_TIPO_TAG[e.tipo as TipoTag]}: ${e.texto_fixo ?? e.rotulo}`;
    if (!tag) {
      const [nova] = await tx
        .insert(tabela_tag)
        .values({ modelo_id: modelo.id, marcador: l.marcador, ordem: ++ordem, ...valores })
        .returning();
      await auditoria.registrar(tx, {
        entidade: "certificado_modelo_tag",
        entidade_id: nova!.id,
        tipo_evento: "MODELO_TAG_MAPEADA",
        descricao: `${CertificadoModelo.rotulo(modelo)}: {{ ${l.marcador} }} ← ${descreve}`,
        usuario,
      });
      mudou += 1;
      continue;
    }
    const antes = {
      tipo: tag.tipo,
      campo: tag.campo,
      texto_fixo: tag.texto_fixo,
      rotulo: tag.rotulo,
      obrigatorio: tag.obrigatorio,
    };
    if (Object.entries(valores).every(([k, v]) => (antes as Record<string, unknown>)[k] === v)) continue;
    await tx.update(tabela_tag).set(valores).where(eq(tabela_tag.id, tag.id));
    await auditoria.registrar_diferencas(tx, {
      entidade: "certificado_modelo_tag",
      entidade_id: tag.id,
      antes,
      depois: valores,
      usuario,
    });
    mudou += 1;
  }
  return _volta(
    c,
    volta,
    (mudou ? `Mapa salvo (${mudou} alteração(ões)).` : "Nada mudou no mapa.") +
      (faltam
        ? ` Faltam ${faltam} marcador(es) sem dado — a emissão fica bloqueada até completar.`
        : " Todos os marcadores têm dado."),
  );
});

/** NUVEM: o .docx do modelo preenchido com os valores de exemplo, para conferir o layout. */
rotas.get(`${MODELOS}/:modelo_id{[0-9]+}/exemplo`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const tx = c.get("tx");
  const modelo_id = Number(c.req.param("modelo_id"));
  const modelo = await _modelo(tx, modelo_id);
  if (!modelo) return redirecionar(c, MODELOS);
  if (!certificado.conferir_modelo(modelo, {}).arquivo_encontrado) {
    return _erro(c, `${MODELOS}/${modelo_id}`, `O arquivo '${modelo.arquivo}' não foi encontrado — não há o que preencher.`);
  }
  const bytes = await certificado.renderizar_exemplo(modelo);
  const nome = `exemplo_${textos.slug_ascii(modelo.nome).toLowerCase() || "modelo"}_v${modelo.versao}.docx`;
  return baixar(c, bytes, nome, envio.TIPO_DOCX);
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
      descricao: `${CertificadoModelo.rotulo(modelo!)}: {{ ${tag.marcador} }} ← ${campos_certificado.descrever_tag(tag)}`,
      usuario,
    });
    await tx.delete(tabela_tag).where(eq(tabela_tag.id, tag.id));
    return _volta(c, volta, `Marcador '${tag.marcador}' removido do mapa.`);
  }
  // formulário antigo (sem `tipo`) continua sendo campo do sistema
  const [dados, recusa] = _tag_digitada(f, tag.tipo);
  if (!dados) {
    // A recusa reabre o popup DESTA linha com o que foi digitado, em vez de
    // voltar à ficha com a faixa vermelha e o popup fechado.
    const digitado = {
      tipo: f.texto("tipo"),
      campo: f.texto("campo"),
      detalhe: f.texto("detalhe"),
      ordem: f.texto("ordem"),
      obrigatorio: f.texto("obrigatorio", ""),
    };
    return _tela_modelo(c, usuario, modelo_id, { erro: recusa, digitado, editando_id: tag_id });
  }
  return salvar_com_diff(
    c,
    usuario,
    tabela_tag,
    tag_id,
    { ...dados, ordem: _inteiro(f.texto("ordem"), 1) || tag.ordem, obrigatorio: marcado(f.texto("obrigatorio")) },
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
  )
    // o número não chega ao template: só a máscara (sem dígito) ou "não informado"
    .map(({ cpf, ...a }) => ({ ...a, cpf_exibicao: cpf_certificado.exibir(cpf), tem_cpf: Boolean(cpf) }))
    .map(vista_assinatura);
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
    // quantas qualificações ativas cada um tem, e quantas vencem ou venceram
    qualificacoes: await qualificacao.resumo_por_instrutor(tx, datas_br.hoje()),
    hoje: datas_br.hoje(),
    // o início gravado quando o campo veio em branco: a tela o escreve "desde sempre"
    desde_sempre: VIGENCIA_DESDE_SEMPRE,
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
    editando_id: d.editando_id ?? null,
  });
}

/**
 * "Instrutores" é do módulo Certificados e Treinamentos, mas a permissão é só
 * do perfil (`assinatura.gerenciar`): com "Sem acesso" ao módulo ela sobrava e
 * segurava o módulo no menu (23/10/2026). A tela e as ações pedem as duas.
 */
function _exigir_instrutores(usuario: UsuarioAtual): void {
  usuario.exigir("assinatura.gerenciar");
  exigir_acesso_ao_modulo(usuario, "certificados");
}

// o menu diz "Instrutores": o endereço digitado por esse nome leva à mesma tela
rotas.get("/treinamentos/instrutores", (c) => redirecionar(c, ASSINATURAS));

rotas.get(ASSINATURAS, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
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
  // vazio = desde sempre: o curso já dado no mês passado tem de poder ser assinado
  const inicio = (d.vigencia_inicio ?? "").trim() ? data_iso(d.vigencia_inicio) : VIGENCIA_DESDE_SEMPRE;
  if (inicio === null) return [null, "Início da vigência inválido (AAAA-MM-DD), ou deixe vazio para desde sempre."];
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
  _exigir_instrutores(usuario);
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
  // (menos o CPF, que não volta à tela nem na recusa)
  if (campos === null) return _tela_assinaturas(c, usuario, { erro: problema, digitado });
  let cpf: string | null | undefined;
  try {
    cpf = cpf_certificado.ler_campo(f.texto(CAMPO_CPF_CERTIFICADO));
  } catch (erro) {
    if (erro instanceof cpf_certificado.CpfInvalido) return _tela_assinaturas(c, usuario, { erro: erro.message, digitado });
    throw erro;
  }
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
  if (cpf) await cpf_certificado.definir_do_instrutor(tx, usuario, assinatura!.id, cpf);
  return _volta(c, ASSINATURAS, `Assinatura de ${assinatura!.nome} cadastrada.`);
});

rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const tx = c.get("tx");
  const assinatura_id = Number(c.req.param("assinatura_id"));
  const f = await formulario(c);
  // A recusa reabre o popup DESTE instrutor com o que foi digitado — menos o
  // CPF, que não volta à tela nem na recusa (`cpf_certificado.ts`, RN-19).
  const digitado = { ..._campos_do_formulario(f), ativo: f.texto("ativo", ""), apagar_cpf: f.texto("apagar_cpf", "") };
  const recusar = (mensagem: string) =>
    _tela_assinaturas(c, usuario, { erro: mensagem, digitado, editando_id: assinatura_id });
  const e_externo = marcado(digitado.externo);
  const [campos, problema] = await _dados_da_assinatura(tx, {
    externo: e_externo,
    servidor_id: e_externo ? null : id_opcional(digitado.servidor_id),
    nome: digitado.nome,
    vigencia_inicio: digitado.vigencia_inicio,
    vigencia_fim: digitado.vigencia_fim,
  });
  if (campos === null) return recusar(problema);
  // O CPF fica FORA do `salvar_com_diff`: o diff grava antes → depois na
  // trilha, e do CPF a trilha guarda só o fato (`cpf_certificado.ts`).
  try {
    const cpf = cpf_certificado.ler_campo(f.texto(CAMPO_CPF_CERTIFICADO), marcado(digitado.apagar_cpf));
    if (cpf !== undefined) {
      await cpf_certificado.definir_do_instrutor(tx, usuario, assinatura_id, cpf);
    }
  } catch (erro) {
    if (erro instanceof cpf_certificado.CpfInvalido) return recusar(erro.message);
    throw erro;
  }
  return salvar_com_diff(
    c,
    usuario,
    tabela_assinatura,
    assinatura_id,
    {
      ...campos,
      titulo: texto_ou_nulo(digitado.titulo),
      conselho: (texto_ou_nulo(digitado.conselho) ?? "").toUpperCase() || null,
      registro_conselho: texto_ou_nulo(digitado.registro_conselho),
      organizacao: texto_ou_nulo(digitado.organizacao),
      ativo: marcado(digitado.ativo),
    },
    { permissao: "assinatura.gerenciar", rotulo: "Instrutor", volta: ASSINATURAS },
  );
});

/** O instrutor cadastrado por engano, que nunca esteve em turma. */
rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}/excluir`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  try {
    const nome = await c
      .get("tx")
      .transaction((sp) => exclusao_cadastro.excluir_instrutor(sp as Executor, usuario, Number(c.req.param("assinatura_id"))));
    return _volta(c, ASSINATURAS, `Instrutor ${nome} excluído.`);
  } catch (erro) {
    if (erro instanceof exclusao_cadastro.ExclusaoRecusada) return _erro(c, ASSINATURAS, erro.message);
    throw erro;
  }
});

/**
 * A rubrica em imagem: PNG ou JPEG, os dois que o .docx e o PDF da casa
 * desenham. O tipo é lido dos primeiros bytes, não do nome nem do que o
 * navegador declara — o certificado não pode sair com uma imagem que nenhum
 * dos dois sabe abrir.
 */
function _tipo_da_rubrica(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}/rubrica`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const tx = c.get("tx");
  const instrutor = await _assinatura(tx, Number(c.req.param("assinatura_id")));
  if (!instrutor) return _erro(c, ASSINATURAS, "Instrutor não encontrado.");
  const nome = AssinaturaInstrutor.nome_exibicao(instrutor);
  const f = await formulario(c);
  if (marcado(f.texto("remover"))) {
    if (instrutor.imagem_anexo_id === null) return _volta(c, ASSINATURAS, `${nome} já está sem rubrica.`);
    // o anexo fica: certificado já emitido guardou o SHA-256 dele e a segunda
    // via redesenha a mesma rubrica
    await tx.update(tabela_assinatura).set({ imagem_anexo_id: null }).where(eq(tabela_assinatura.id, instrutor.id));
    await auditoria.registrar(tx, {
      entidade: "assinatura_instrutor",
      entidade_id: instrutor.id,
      tipo_evento: "RUBRICA_INSTRUTOR_REMOVIDA",
      descricao: `${nome}: rubrica retirada; os próximos certificados saem sem a imagem.`,
      usuario,
    });
    return _volta(c, ASSINATURAS, `Rubrica de ${nome} retirada.`);
  }
  const imagem = f.arquivo("imagem");
  if (!imagem || imagem.size === 0) return _erro(c, ASSINATURAS, "Escolha a imagem da rubrica (PNG ou JPEG).");
  if (imagem.size > anexos.LIMITE_BYTES) return _erro(c, ASSINATURAS, new anexos.AnexoGrandeDemais(imagem.size).message);
  const bytes = new Uint8Array(await imagem.arrayBuffer());
  const tipo = _tipo_da_rubrica(bytes);
  if (tipo === null) return _erro(c, ASSINATURAS, "A rubrica precisa ser uma imagem PNG ou JPEG.");
  const { anexo } = await anexos.guardar(tx, {
    entidade: "assinatura_instrutor",
    entidade_id: instrutor.id,
    nome_original: imagem.name || `rubrica.${tipo === "image/png" ? "png" : "jpg"}`,
    conteudo: bytes,
    mime_type: tipo,
    categoria: "RUBRICA_INSTRUTOR",
    usuario,
  });
  if (anexo.id === instrutor.imagem_anexo_id) return _volta(c, ASSINATURAS, `${nome} já usa esta mesma rubrica.`);
  await tx.update(tabela_assinatura).set({ imagem_anexo_id: anexo.id }).where(eq(tabela_assinatura.id, instrutor.id));
  await auditoria.registrar(tx, {
    entidade: "assinatura_instrutor",
    entidade_id: instrutor.id,
    tipo_evento: "RUBRICA_INSTRUTOR_DEFINIDA",
    descricao:
      `${nome}: rubrica '${anexo.nome_original}' (SHA-256 ${anexo.sha256.slice(0, 12)}…). ` +
      "Vale para os certificados emitidos daqui em diante.",
    usuario,
  });
  return _volta(c, ASSINATURAS, `Rubrica de ${nome} guardada.`);
});

// a miniatura da tela: quem gerencia instrutores vê a rubrica que vai ao papel
rotas.get(`${ASSINATURAS}/:assinatura_id{[0-9]+}/rubrica`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const tx = c.get("tx");
  const instrutor = await _assinatura(tx, Number(c.req.param("assinatura_id")));
  const [anexo] =
    instrutor?.imagem_anexo_id != null
      ? await tx.select().from(tabela_anexo).where(eq(tabela_anexo.id, instrutor.imagem_anexo_id))
      : [];
  if (!anexo) return c.text("Sem rubrica.", 404);
  const conteudo = await anexos.ler_conteudo(anexo);
  return c.body(conteudo as unknown as ArrayBuffer, 200, {
    "content-type": anexos.tipo_para_servir(anexo.mime_type),
    "cache-control": "private, no-store",
  });
});

// =====================================================================
// Qualificações do instrutor (24/10/2026, `servicos/qualificacao_instrutor.ts`)
// =====================================================================
/** A ficha do instrutor: as qualificações dele, com o comprovante. */
export function qualificacoes_de(instrutor_id: number): string {
  return `${ASSINATURAS}/${instrutor_id}/qualificacoes`;
}

async function _tela_qualificacoes(
  c: Ctx,
  usuario: UsuarioAtual,
  instrutor: NonNullable<Awaited<ReturnType<typeof _assinatura>>>,
  d: Recado = {},
) {
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const treinamentos = await tx
    .select({ id: tabela_treinamento.id, codigo: tabela_treinamento.codigo, nome: tabela_treinamento.nome, ativo: tabela_treinamento.ativo })
    .from(tabela_treinamento)
    .orderBy(asc(tabela_treinamento.nome));
  const nome_do_treinamento = new Map(treinamentos.map((t) => [t.id, `${t.codigo} · ${t.nome}`]));
  const itens = (await qualificacao.do_instrutor(tx, instrutor.id)).map((q) => ({
    ...q,
    treinamento_rotulo: q.treinamento_id !== null ? (nome_do_treinamento.get(q.treinamento_id) ?? null) : null,
    situacao: qualificacao.situacao(q, hoje),
  }));
  // o cadastro escolhe entre os ativos; o inativo só aparece no rótulo de quem já aponta para ele
  const { cpf: _cpf, ...sem_cpf } = instrutor;
  return pagina(c, "paginas/instrutor_qualificacoes.html", usuario, {
    instrutor: vista_assinatura(sem_cpf),
    itens,
    treinamentos: treinamentos.filter((t) => t.ativo),
    hoje,
    dias_aviso: qualificacao.DIAS_AVISO,
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
  });
}

rotas.get(`${ASSINATURAS}/:assinatura_id{[0-9]+}/qualificacoes`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const instrutor = await _assinatura(c.get("tx"), Number(c.req.param("assinatura_id")));
  if (!instrutor) return _erro(c, ASSINATURAS, "Instrutor não encontrado.");
  return _tela_qualificacoes(c, usuario, instrutor, recados(c));
});

rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}/qualificacoes`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const tx = c.get("tx");
  const instrutor = await _assinatura(tx, Number(c.req.param("assinatura_id")));
  if (!instrutor) return _erro(c, ASSINATURAS, "Instrutor não encontrado.");
  const f = await formulario(c);
  const digitado = {
    descricao: f.texto("descricao"),
    treinamento_id: f.texto("treinamento_id"),
    norma: f.texto("norma"),
    instituicao: f.texto("instituicao"),
    data_emissao: f.texto("data_emissao"),
    valida_ate: f.texto("valida_ate"),
  };
  const recusar = (mensagem: string) => _tela_qualificacoes(c, usuario, instrutor, { erro: mensagem, digitado });
  const valida_ate = digitado.valida_ate.trim() ? data_iso(digitado.valida_ate) : null;
  if (digitado.valida_ate.trim() && valida_ate === null) return recusar("Válida até: data inválida (ou deixe vazio para sem validade).");
  const arquivo = f.arquivo("comprovante");
  const comprovante =
    arquivo && arquivo.size > 0 ? { nome: arquivo.name, conteudo: new Uint8Array(await arquivo.arrayBuffer()) } : null;
  try {
    // num savepoint: a recusa depois do INSERT (o comprovante) não deixa a linha sem arquivo
    await tx.transaction((sp) =>
      qualificacao.cadastrar(
        sp as Executor,
        usuario,
        instrutor.id,
        {
          descricao: digitado.descricao,
          treinamento_id: id_opcional(digitado.treinamento_id),
          norma: texto_ou_nulo(digitado.norma),
          instituicao: digitado.instituicao,
          data_emissao: data_iso(digitado.data_emissao),
          valida_ate,
        },
        comprovante,
      ),
    );
  } catch (erro) {
    if (erro instanceof qualificacao.QualificacaoRecusada || erro instanceof anexos.AnexoGrandeDemais) {
      return recusar(erro.message);
    }
    throw erro;
  }
  return _volta(c, qualificacoes_de(instrutor.id), `Qualificação «${digitado.descricao.trim()}» cadastrada.`);
});

rotas.post(`${ASSINATURAS}/:assinatura_id{[0-9]+}/qualificacoes/:qualificacao_id{[0-9]+}/inativar`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const instrutor_id = Number(c.req.param("assinatura_id"));
  const volta = qualificacoes_de(instrutor_id);
  try {
    const q = await qualificacao.inativar(c.get("tx"), usuario, instrutor_id, Number(c.req.param("qualificacao_id")));
    return _volta(c, volta, `Qualificação «${q.descricao}» inativada.`);
  } catch (erro) {
    if (erro instanceof qualificacao.QualificacaoRecusada) return _erro(c, volta, erro.message);
    throw erro;
  }
});

// o endereço da qualificação (o link da pendência): a linha dela na ficha do instrutor
rotas.get("/treinamentos/qualificacoes/:qualificacao_id{[0-9]+}", async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_instrutores(usuario);
  const id = Number(c.req.param("qualificacao_id"));
  const [q] = await c
    .get("tx")
    .select({ instrutor_id: tabela_qualificacao.instrutor_id })
    .from(tabela_qualificacao)
    .where(eq(tabela_qualificacao.id, id));
  if (!q) return _erro(c, ASSINATURAS, "Qualificação não encontrada.");
  return redirecionar(c, `${qualificacoes_de(q.instrutor_id)}#qualificacao-${id}`);
});

// =====================================================================
// Indicadores de treinamento
// =====================================================================
export const INDICADORES = "/treinamentos/indicadores";

export const PERIODOS: [string, string][] = [
  ["ano_atual", "Ano atual"],
  ["ano_anterior", "Ano anterior"],
  ["todo", "Todo o período"],
  ["intervalo", "De… até…"],
];

/** O período pedido, em datas: [de, até, código]. Torto cai no ano atual. */
export function periodo_de(codigo: string, de: string, ate: string, hoje: string): [string | null, string | null, string] {
  const ano = Number(hoje.slice(0, 4));
  if (codigo === "ano_anterior") return [`${ano - 1}-01-01`, `${ano - 1}-12-31`, codigo];
  if (codigo === "todo") return [null, null, codigo];
  if (codigo === "intervalo") {
    const inicio = data_iso(de);
    const fim = data_iso(ate);
    if (inicio || fim) return [inicio, fim, codigo];
  }
  return [`${ano}-01-01`, `${ano}-12-31`, "ano_atual"];
}

rotas.get(INDICADORES, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("indicador.ver");
  // NUVEM: os indicadores de treinamento são do trabalho do setor — contam as
  // turmas do setor promotor da conta (`setor_equipe.ts`)
  usuario.exigir_na_equipe("treinamento.ver");
  const tx = c.get("tx");
  const [de, ate, periodo] = periodo_de(
    c.req.query("periodo") ?? "",
    c.req.query("de") ?? "",
    c.req.query("ate") ?? "",
    datas_br.hoje(),
  );
  const setor = id_opcional(c.req.query("setor") ?? "");
  // intervalo de trás para a frente não se conserta em silêncio: a tela diz
  const invertido = periodo === "intervalo" && de !== null && ate !== null && de > ate;
  const r = await indicadores.calcular(tx, usuario, { de, ate, unidade_promotora_id: setor });
  // `exposicao.ver` cobrindo o alcance de `indicador.ver`: `ve_dado_nominal`
  // somava `epi.ficha`, que só é nominal nas telas de EPI (D15)
  const nominal = usuario.ve_dado_nominal_em("indicador.ver");
  // RN-19: contagem de PESSOAS abaixo do limiar vira "—" para quem não vê
  // nome; turma é evento, não pessoa, e sai sempre
  const suprime = (n: number) => !nominal && n !== 0 && n < LIMIAR_SUPRESSAO;
  const pessoas = (n: number) => (suprime(n) ? MARCA_SUPRIMIDO : String(n));
  const cartoes_pessoas = Object.fromEntries(
    (["participantes", "pessoas_distintas", "aguardando_confirmacao", "aprovados", "reprovados", "faltas", "emitidos", "pendentes"] as const).map(
      (k) => [k, pessoas(r[k])],
    ),
  );
  return pagina(c, "paginas/treinamentos_indicadores.html", usuario, {
    r,
    nominal,
    cartoes_pessoas,
    // o destaque do cartão sai do valor EXIBIDO: "—" amarelo diria que não é zero
    pendentes_em_alerta: cartoes_pessoas.pendentes !== "0" && cartoes_pessoas.pendentes !== MARCA_SUPRIMIDO,
    // taxa sobre poucas pessoas é a mesma reidentificação, em porcentagem; e
    // com um dos dois lados suprimido ela devolveria o lado escondido
    // (12 aprovados a 85,7% são 2 reprovados)
    taxa:
      r.taxa_aprovacao === null ||
      (!nominal && (r.aprovados + r.reprovados < LIMIAR_SUPRESSAO || suprime(r.aprovados) || suprime(r.reprovados)))
        ? null
        : textos_numero(r.taxa_aprovacao),
    ...(invertido ? { erro: "A data inicial é posterior à final. Troque as datas para ver os números do intervalo." } : {}),
    invertido,
    turmas_por_setor: dicionario(Object.fromEntries(Object.entries(r.turmas_por_setor).map(([k, v]) => [k, String(v)]))),
    participantes_por_treinamento: dicionario(suprimir(r.participantes_por_treinamento, nominal)),
    setores: await indicadores.setores_promotores(tx, usuario),
    sem_setor_promotor: setor_equipe.sem_setor(usuario),
    periodos: PERIODOS,
    periodo,
    de: de ?? "",
    ate: ate ?? "",
    setor: setor ? String(setor) : "",
    limiar: LIMIAR_SUPRESSAO,
    top: indicadores.TOP_TREINAMENTOS,
  });
});

function textos_numero(n: number): string {
  return `${String(n).replace(".", ",")}%`;
}

// =====================================================================
// Participantes — juntar cadastros da mesma pessoa
// =====================================================================
/** Os possíveis duplicados e a busca, para escolher quem fica e quem se junta. */
rotas.get(PARTICIPANTES, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("participante.mesclar");
  const tx = c.get("tx");
  const busca = (c.req.query("busca") ?? "").trim();
  // o atalho "juntar com outro cadastro" da ficha (23/10/2026): a pessoa e
  // quem parece com ela, pelo critério único (`duplicados.procurar`)
  const de = id_opcional(c.req.query("de"));
  const origem = de !== null ? await servico_participante.carregar(tx, de) : null;
  const do_atalho =
    origem && origem.ativo && origem.mesclado_em_id === null
      ? [origem, ...(await duplicados.procurar(tx, duplicados.alvo_do_cadastro(origem), { limite: 20 })).map((p) => p.pessoa)]
      : [];
  const achados = busca
    ? await mesclagem.fichas(tx, await servico_participante.buscar(tx, busca, usuario, 30))
    : do_atalho.length
      ? await mesclagem.fichas(tx, do_atalho)
      : [];
  const grupos = busca || do_atalho.length ? [] : await mesclagem.possiveis_duplicados(tx);
  return pagina(c, "paginas/participantes.html", usuario, {
    // `termo`, e não `busca`: a casca copia `busca` para o campo da busca
    // global do cabeçalho, e o mesmo texto nos dois campos confundia
    termo: busca,
    de_identificador: do_atalho.length ? origem!.identificador_publico : null,
    de_id: do_atalho.length ? origem!.id : null,
    achados,
    sugerido_achados: achados.length ? mesclagem.sugerido(achados) : null,
    difere_achados: achados.length ? _o_que_difere(achados, mesclagem.sugerido(achados)) : {},
    grupos: grupos.map((g) => {
      const sugerido = mesclagem.sugerido(g);
      return { fichas: g, sugerido, difere: _o_que_difere(g, sugerido) };
    }),
    rotulo_vinculo: ROTULO_VINCULO,
    ...recados(c),
  });
});

/**
 * O que cada cadastro do grupo tem de diferente do que a tela sugere manter —
 * `{ficha_id: {campo: true}}`. A tela marca essas células, para a comparação
 * não depender de ler linha por linha; o sugerido não leva marca (é a régua).
 * Nome sem acento nem caixa: "Joana Ávila" e "joana avila" não diferem.
 */
function _o_que_difere(fichas: mesclagem.Ficha[], sugerido: number | null): Record<number, Record<string, boolean>> {
  const regua = fichas.find((f) => f.id === sugerido) ?? fichas[0];
  if (!regua) return {};
  const forma = {
    nome: (x: mesclagem.Ficha) => textos.chave_busca(x.nome),
    organizacao: (x: mesclagem.Ficha) => textos.chave_busca(x.organizacao ?? ""),
    vinculo: (x: mesclagem.Ficha) => x.vinculo,
    emails: (x: mesclagem.Ficha) => [...x.emails].map((m) => m.toLowerCase()).sort().join(","),
  };
  return Object.fromEntries(
    fichas.map((f) => [
      f.id,
      Object.fromEntries(Object.entries(forma).map(([campo, de]) => [campo, f.id !== regua.id && de(f) !== de(regua)])),
    ]),
  );
}

rotas.post(`${PARTICIPANTES}/mesclar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("participante.mesclar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const volta = f.texto("volta").startsWith(PARTICIPANTES) ? f.texto("volta") : PARTICIPANTES;
  const mantido = Number(f.texto("mantido_id"));
  const absorvidos = f
    .todos("absorvido_id")
    .map(Number)
    .filter((id) => Number.isInteger(id) && id !== mantido);
  if (!Number.isInteger(mantido) || !absorvidos.length) {
    return _erro(c, volta, "Marque quem fica (“manter”) e ao menos um cadastro para juntar a ele.");
  }
  const total = { inscricoes: 0, certificados: 0, emails: 0 };
  try {
    await tx.transaction(async (sp) => {
      for (const id of absorvidos) {
        const r = await mesclagem.mesclar(sp as Executor, usuario, mantido, id, f.texto("motivo"));
        total.inscricoes += r.inscricoes;
        total.certificados += r.certificados;
        total.emails += r.emails;
      }
    });
  } catch (erro) {
    if (erro instanceof mesclagem.MesclagemRecusada) return _erro(c, volta, `Nada foi juntado. ${erro.message}`);
    throw erro;
  }
  return _volta(
    c,
    volta,
    `${absorvidos.length} cadastro(s) juntado(s): ${total.inscricoes} inscrição(ões), ` +
      `${total.certificados} certificado(s) e ${total.emails} e-mail(s) passaram para quem ficou.`,
  );
});
