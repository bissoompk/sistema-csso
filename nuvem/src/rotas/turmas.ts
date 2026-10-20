/**
 * /turmas — turma de treinamento, inscrição interna, presença e nota.
 * Porte de `app/rotas/turmas.py`.
 *
 * A ficha da turma tem as quatro abas do fluxo do legado (Turma, Inscrições,
 * Presença e notas, Emissão). Nenhuma regra mora aqui: as rotas leem o
 * formulário, chamam os serviços e traduzem a recusa em mensagem na tela.
 *
 * **O `s.rollback()` da recusa.** No Python a rota desfazia o que o serviço já
 * tinha escrito antes de devolver o aviso. Aqui toda ação que pode ser recusada
 * roda num SAVEPOINT da transação da requisição (`tx.transaction(...)`): a
 * recusa desfaz só o savepoint, e a tela que sai depois (o aviso, a lista
 * reaberta, a linha da grade) lê o banco como estava antes da ação.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import {
  assinatura_instrutor as tabela_assinatura,
  campus as tabela_campus,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import {
  ESTADOS_TURMA,
  ROTULO_INSCRICAO,
  ROTULO_TURMA,
  TransicaoInvalida,
  destinos_de_turma,
} from "../dominio/estados.js";
import { AssinaturaInstrutor, ROTULO_VINCULO, VINCULOS_PARTICIPANTE } from "../dominio/treinamento.js";
import { CAMPO_CPF_CERTIFICADO, formulario, usuarioLogado } from "../dependencias.js";
import * as cpf_certificado from "../servicos/cpf_certificado.js";
import * as servico_emissao from "../servicos/emissao_certificado.js";
import * as campos_certificado from "../servicos/campos_certificado.js";
import * as identificacao from "../servicos/identificacao.js";
import { atores_para_tela } from "../servicos/privacidade.js";
import { TIPO_PDF } from "../servicos/certificado_pdf.js";
import * as inscricao_lote from "../servicos/inscricao_lote.js";
import * as inscricao_publica from "../servicos/inscricao_publica.js";
import * as email from "../servicos/email.js";
import * as envio_certificado from "../servicos/envio_certificado.js";
import { qr_png } from "../servicos/qr.js";
import * as servico_lista from "../servicos/lista_presenca.js";
import * as servico_participante from "../servicos/participante.js";
import { DadosDoParticipante, nome_exibicao } from "../servicos/participante.js";
import * as servico_presenca from "../servicos/presenca.js";
import * as servico_turma from "../servicos/turma.js";
import { RegraDaTurma, type InscricaoCarregada, type TurmaCarregada } from "../servicos/turma.js";
import * as datas_br from "../servicos/datas_br.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { fragmento, marcarDownload, pagina, redirecionar } from "../web.js";
import {
  data_iso,
  erro as _erro,
  id_opcional,
  marcado,
  recados,
  texto_ou_nulo,
  volta as _volta,
  vista_assinatura,
  vista_inscricao,
  vista_participante,
  vista_turma,
} from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const TURMAS = "/turmas";
export const ABAS: [string, string][] = [
  ["turma", "Turma"],
  ["inscricoes", "Inscrições"],
  ["presencas", "Presença e notas"],
  ["emissao", "Emissão"],
];

// A aba 1 é o CARTAZ e abre para quem só tem `treinamento.ver`. As outras três
// são NOMINAIS: exigem uma destas permissões. Ver que o curso existe e ver
// quem está nele são duas perguntas diferentes.
export const PERMISSOES_DAS_ABAS_NOMINAIS = ["certificado.ver", "turma.inscrever", "turma.avaliar"];
// as quatro abas estão entregues; a lista fica para a próxima fatia declarar a dela
export const ABAS_PREVISTAS: [string, string][] = [];

/** Formato que a rota recusa antes de chegar ao serviço. */
export class CampoInvalido extends Error {}

/** A recusa que a rota traduz em aviso (as mesmas classes que o Python pegava). */
function e_recusa(erro: unknown): erro is Error {
  return (
    erro instanceof CampoInvalido ||
    erro instanceof RegraDaTurma ||
    erro instanceof TransicaoInvalida ||
    erro instanceof DadosDoParticipante
  );
}

/**
 * Campo de data vazio NÃO vira hoje nem 01/01: vira recusa (ou `null`, quando
 * a data é opcional).
 */
function _data(valor: string, rotulo: string, obrigatoria = true): string | null {
  const bruto = (valor ?? "").trim();
  if (!bruto) {
    if (obrigatoria) throw new CampoInvalido(`Informe ${rotulo} (AAAA-MM-DD).`);
    return null;
  }
  const dia = data_iso(bruto);
  if (dia === null) throw new CampoInvalido(`${primeira_maiuscula(rotulo)} inválida: use AAAA-MM-DD.`);
  return dia;
}

/** O `str.capitalize()` do Python: primeira maiúscula, o resto minúsculo. */
function primeira_maiuscula(texto: string): string {
  return texto ? texto[0]!.toUpperCase() + texto.slice(1).toLowerCase() : texto;
}

/** Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita. */
function _decimal(valor: string, rotulo: string, padrao: string | null = null): string | null {
  const bruto = (valor ?? "").trim().replace(",", ".");
  if (!bruto) return padrao;
  const numero = servico_presenca.normalizar_decimal(bruto);
  if (numero === null) throw new CampoInvalido(`${primeira_maiuscula(rotulo)} inválida: informe um número.`);
  return numero;
}

function _inteiro(valor: string, rotulo: string): number | null {
  const bruto = (valor ?? "").trim();
  if (!bruto) return null;
  if (!/^\d+$/.test(bruto)) throw new CampoInvalido(`${primeira_maiuscula(rotulo)} inválido: informe um número inteiro.`);
  return Number(bruto);
}

/** Uma leitura só, pela porta do serviço (`turma.no_escopo`). */
function _turma_no_escopo(tx: Executor, usuario: UsuarioAtual, turma_id: number) {
  return servico_turma.no_escopo(tx, usuario, turma_id);
}

/** A ação que pode ser recusada, num savepoint (o `s.rollback()` do Python). */
function _no_savepoint<T>(c: Ctx, f: (sp: Executor) => Promise<T>): Promise<T> {
  return c.get("tx").transaction(async (sp) => f(sp as Executor));
}

/** O `FileResponse` do Starlette: o .docx como anexo, com o nome do arquivo. */
export function baixar(c: Ctx, bytes: Uint8Array, nome: string, tipo: string): Response {
  marcarDownload(c);
  const ascii = /^[\x20-\x7e]+$/.test(nome) && !nome.includes('"');
  const disposicao = ascii
    ? `attachment; filename="${nome}"`
    : `attachment; filename*=utf-8''${encodeURIComponent(nome)}`;
  return c.body(bytes as never, 200, { "content-type": tipo, "content-disposition": disposicao });
}

// =====================================================================
// Lista
// =====================================================================
async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  d: {
    situacao?: string;
    treinamento_id?: string;
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, string> | null;
  } = {},
) {
  const tx = c.get("tx");
  const situacao = d.situacao ?? "";
  const treinamento_id = d.treinamento_id ?? "";
  const filtros = [servico_turma.consulta_no_escopo(usuario)];
  if ((ESTADOS_TURMA as readonly string[]).includes(situacao)) filtros.push(eq(tabela_turma.situacao, situacao));
  const alvo = id_opcional(treinamento_id);
  if (alvo !== null) filtros.push(eq(tabela_turma.treinamento_id, alvo));
  const itens = (
    (await tx.query.turma.findMany({
      where: and(...filtros),
      with: servico_turma.COM_TURMA as never,
      orderBy: (t, { desc }) => [desc(t.ano), desc(t.numero)],
    })) as unknown as TurmaCarregada[]
  ).map(vista_turma);
  // Instalação sem turma nenhuma: a tela diz por onde começar, em vez de só
  // oferecer "Abrir turma" sem treinamento para escolher.
  const comecando = !itens.length && !situacao && alvo === null && usuario.pode("turma.criar");
  // tudo junto: uma ida ao banco, e não uma por turma (ver `db/cliente.ts`)
  const [ocupadas, treinamentos, campi, unidades, [instrutor]] = await Promise.all([
    Promise.all(itens.map((turma) => servico_turma.inscricoes_que_ocupam_vaga(tx, turma))),
    tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    tx.select().from(tabela_campus).orderBy(asc(tabela_campus.nome)),
    tx.select().from(tabela_unidade).orderBy(asc(tabela_unidade.nome_extenso)),
    comecando
      ? tx.select({ id: tabela_assinatura.id }).from(tabela_assinatura).where(eq(tabela_assinatura.ativo, true)).limit(1)
      : Promise.resolve([]),
  ]);
  const inscritos: Record<number, number> = {};
  itens.forEach((turma, i) => (inscritos[turma.id] = ocupadas[i]!));
  let primeiros_passos: { rotulo: string; feito: boolean; href: string | null; dica: string }[] | null = null;
  if (comecando) {
    const tem_treinamento = treinamentos.some((t) => t.ativo);
    primeiros_passos = [
      {
        rotulo: "Cadastrar o treinamento no catálogo",
        feito: tem_treinamento,
        href: "/treinamentos/catalogo",
        dica: "Nome, carga horária e conteúdo programático.",
      },
      {
        rotulo: "Cadastrar o instrutor",
        feito: Boolean(instrutor),
        href: "/treinamentos/assinaturas",
        dica: "Quem assina o certificado. De fora da UFVJM: marque “externo”.",
      },
      {
        rotulo: "Abrir a turma",
        feito: false,
        href: null,
        dica: "No botão “Abrir turma”, acima. Curso já dado: use as datas reais.",
      },
      {
        rotulo: "Inscrever, registrar a presença e emitir os certificados",
        feito: false,
        href: null,
        dica: "Na ficha da turma. Curso já dado: “Registrar turma já realizada” faz presença e conclusão de uma vez.",
      },
    ];
  }
  return pagina(c, "paginas/turmas.html", usuario, {
    primeiros_passos,
    itens,
    inscritos,
    // só treinamento ativo entra no seletor de nova turma
    treinamentos: treinamentos.filter((t) => t.ativo),
    // o filtro lista todos: turma antiga de curso desativado continua encontrável
    treinamentos_do_filtro: treinamentos,
    campi,
    unidades,
    descricoes: await _ultimas_descricoes(tx),
    situacoes: ESTADOS_TURMA.map((codigo) => [codigo, ROTULO_TURMA[codigo]]),
    filtro_situacao: situacao,
    filtro_treinamento: treinamento_id,
    digitado: d.digitado ?? {},
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
  });
}

/**
 * A descrição da turma mais recente de cada treinamento (`{treinamento_id:
 * texto}`), para "usar a da turma anterior". `fora` deixa a própria turma de
 * fora, na edição.
 */
async function _ultimas_descricoes(tx: Executor, fora: number | null = null): Promise<Record<number, string>> {
  const linhas = await tx
    .select({ treinamento_id: tabela_turma.treinamento_id, descricao: tabela_turma.descricao, id: tabela_turma.id })
    .from(tabela_turma)
    .where(isNotNull(tabela_turma.descricao))
    .orderBy(desc(tabela_turma.data_inicio), desc(tabela_turma.id));
  const saida: Record<number, string> = {};
  for (const l of linhas) {
    if (l.id === fora || Object.hasOwn(saida, l.treinamento_id)) continue;
    saida[l.treinamento_id] = l.descricao!;
  }
  return saida;
}

rotas.get(TURMAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  return _tela_lista(c, usuario, {
    situacao: c.req.query("situacao") ?? "",
    treinamento_id: c.req.query("treinamento_id") ?? "",
    ...recados(c),
  });
});

// =====================================================================
// "Meus treinamentos" — a tela do próprio servidor (antes de /turmas/{id})
// =====================================================================
export const MINHAS = `${TURMAS}/minhas`;

rotas.get(MINHAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const minhas_inscricoes = (await servico_turma.inscricoes_do_titular(tx, usuario)).map(vista_inscricao);
  const ja_inscrito = [...new Set(minhas_inscricoes.map((i) => i.turma_id))];
  const abertas = (await servico_turma.turmas_abertas(tx, hoje)).map(vista_turma);
  const inscritos: Record<number, number> = {};
  const restantes: Record<number, number | null> = {};
  for (const turma of abertas) {
    inscritos[turma.id] = await servico_turma.inscricoes_que_ocupam_vaga(tx, turma);
    restantes[turma.id] = await servico_turma.vagas_restantes(tx, turma);
  }
  return pagina(c, "paginas/turmas_minhas.html", usuario, {
    hoje,
    abertas,
    // "18 de 20" diz mais do que "18"
    inscritos,
    vagas_restantes: restantes,
    ja_inscrito,
    inscricoes: minhas_inscricoes,
    desistivel: Object.fromEntries(minhas_inscricoes.map((i) => [i.id, servico_turma.pode_desistir(i, hoje)])),
    pode_pedir: usuario.pode("turma.inscrever_se"),
    // conta sem cadastro de servidor não é erro: é a tela dizendo por que está vazia
    sem_servidor: usuario.servidor_id === null,
    ...recados(c),
  });
});

/**
 * O servidor pede a própria vaga. **A rota não aceita "quem"**: o único
 * parâmetro é a turma, e o titular sai da sessão.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscrever-me`, async (c) => {
  const usuario = await usuarioLogado(c);
  const turma = await _turma_no_escopo(c.get("tx"), usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, MINHAS);
  try {
    await _no_savepoint(c, (sp) => servico_turma.inscrever_se(sp, usuario, turma));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, MINHAS, erro.message);
    throw erro;
  }
  return _volta(
    c,
    MINHAS,
    `Inscrição pedida em ${turma.codigo}. A vaga já está reservada para você ` +
      "e a CSSO confirma — enquanto isso a inscrição fica como “inscrita”.",
  );
});

/** A própria desistência. Mesma disciplina: nenhum "quem" entra por aqui. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/desistir`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, MINHAS);
  const minha = (await servico_turma.inscricoes_do_titular(tx, usuario)).find((i) => i.turma_id === turma.id);
  if (!minha) return _erro(c, MINHAS, `Você não tem inscrição em ${turma.codigo}.`);
  try {
    await _no_savepoint(c, (sp) => servico_turma.desistir(sp, usuario, minha, { motivo: texto_ou_nulo(f.texto("motivo")) }));
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, MINHAS, erro.message);
    throw erro;
  }
  return _volta(
    c,
    MINHAS,
    `Desistência registrada em ${turma.codigo}. A vaga voltou para a turma e o motivo ficou escrito — nada foi apagado.`,
  );
});

rotas.post(TURMAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  // Tudo o que foi digitado, guardado antes da primeira recusa
  const campos = [
    "treinamento_id",
    "data_inicio",
    "data_fim",
    "local",
    "descricao",
    "campus_id",
    "unidade_promotora_id",
    "carga_horaria_horas",
    "data_base_vencimento",
    "vagas",
    "inscricao_aberta_ate",
    "nota_minima_aprovacao",
    "frequencia_minima_percentual",
    "observacoes",
  ];
  const digitado: Record<string, string> = Object.fromEntries(campos.map((k) => [k, f.texto(k)]));
  const recusar = (mensagem: string) => _tela_lista(c, usuario, { erro: mensagem, digitado });

  const [treinamento] = await tx
    .select()
    .from(tabela_treinamento)
    .where(eq(tabela_treinamento.id, id_opcional(digitado.treinamento_id) ?? 0));
  if (!treinamento) return recusar("Escolha o treinamento da turma.");
  let turma: TurmaCarregada;
  try {
    turma = await _no_savepoint(c, async (sp) => {
      const inicio = _data(digitado.data_inicio!, "a data de início")!;
      const fim = _data(digitado.data_fim!, "a data de término")!;
      return servico_turma.criar_turma(sp, usuario, {
        treinamento,
        data_inicio: inicio,
        data_fim: fim,
        local: texto_ou_nulo(digitado.local),
        descricao: texto_ou_nulo(digitado.descricao),
        campus_id: id_opcional(digitado.campus_id),
        unidade_promotora_id: id_opcional(digitado.unidade_promotora_id),
        carga_horaria_horas: _decimal(digitado.carga_horaria_horas!, "a carga horária"),
        data_base_vencimento: _data(digitado.data_base_vencimento!, "a data base", false),
        vagas: _inteiro(digitado.vagas!, "o número de vagas"),
        inscricao_aberta_ate: _data(digitado.inscricao_aberta_ate!, "o fim das inscrições", false),
        nota_minima_aprovacao: _decimal(digitado.nota_minima_aprovacao!, "a nota mínima"),
        frequencia_minima_percentual: _decimal(digitado.frequencia_minima_percentual!, "a frequência mínima", "75")!,
        observacoes: texto_ou_nulo(digitado.observacoes),
      });
    });
  } catch (erro) {
    if (erro instanceof CampoInvalido || erro instanceof RegraDaTurma) return recusar(erro.message);
    throw erro;
  }
  return _volta(c, `${TURMAS}/${turma.id}`, `Turma ${turma.codigo} aberta.`);
});

// =====================================================================
// Ficha da turma
// =====================================================================
/** Quem ainda pode ser vinculado: ativo, vigente na data e não vinculado. */
async function _instrutores_livres(tx: Executor, turma: TurmaCarregada) {
  const ja = new Set(turma.instrutores.map((v) => v.assinatura_instrutor_id));
  const todos = await tx.query.assinatura_instrutor.findMany({
    where: eq(tabela_assinatura.ativo, true),
    with: { servidor: true },
    orderBy: [asc(tabela_assinatura.nome)],
  });
  return todos
    .filter((i) => !ja.has(i.id) && AssinaturaInstrutor.vigente_em(i, turma.data_inicio))
    .map(vista_assinatura);
}

rotas.get(`${TURMAS}/:turma_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  vista_turma(turma);
  // quem só lê o cartaz recebe uma aba só, e as nominais nem são carregadas
  const ve_nominal = PERMISSOES_DAS_ABAS_NOMINAIS.some((p) => usuario.pode(p));
  const abas = ve_nominal ? ABAS : ABAS.slice(0, 1);
  let aba = c.req.query("aba") ?? "turma";
  if (!abas.some(([chave]) => chave === aba)) aba = "turma";
  const busca = c.req.query("busca") ?? "";
  const tem_busca = Boolean(busca.trim()) && ve_nominal;
  // As leituras da ficha não dependem umas das outras: saem juntas, numa ida
  // ao banco (ver `db/cliente.ts`).
  const na_emissao = aba === "emissao" && ve_nominal;
  const [
    inscritas,
    participantes,
    achados_srv,
    grade,
    certificados_por_inscricao,
    vagas_restantes,
    instrutores_livres,
    campi,
    unidades,
    [modelo_emissao],
    valores_turma,
    valores_inscritos,
    trilha_campos,
  ] = await Promise.all([
      ve_nominal ? servico_turma.inscricoes_da_turma(tx, turma) : Promise.resolve([]),
      // `usuario=` NÃO é opcional na busca: sem ele ela não casa por nome
      tem_busca ? servico_participante.buscar(tx, busca, usuario) : Promise.resolve([]),
      tem_busca ? servico_participante.buscar_servidores(tx, busca, usuario) : Promise.resolve([]),
      ve_nominal ? servico_presenca.grade_da_turma(tx, turma) : Promise.resolve([]),
      aba === "emissao"
        ? servico_emissao.certificados_da_turma(tx, turma)
        : Promise.resolve({} as Awaited<ReturnType<typeof servico_emissao.certificados_da_turma>>),
      servico_turma.vagas_restantes(tx, turma),
      _instrutores_livres(tx, turma),
      tx.select().from(tabela_campus).orderBy(asc(tabela_campus.nome)),
      tx.select().from(tabela_unidade).orderBy(asc(tabela_unidade.nome_extenso)),
      // NUVEM: campos de turma/participante do modelo (aba Emissão)
      na_emissao ? servico_emissao.modelo_da_turma(tx, turma) : Promise.resolve([null, ""] as const),
      na_emissao ? campos_certificado.valores_da_turma(tx, turma.id) : Promise.resolve({}),
      na_emissao ? campos_certificado.valores_dos_inscritos(tx, turma.id) : Promise.resolve({}),
      na_emissao
        ? campos_certificado.trilha_da_turma(tx, turma.id).then((eventos) =>
            atores_para_tela(
              tx,
              eventos,
              usuario,
              identificacao.semente_de({ cookies: { get: (n: string) => getCookie(c, n) ?? null } }),
            ),
          )
        : Promise.resolve([]),
    ]);
  const inscricoes = inscritas.map(vista_inscricao);
  const achados = participantes.map(vista_participante);
  let servidores_achados: unknown[] = [];
  if (tem_busca) {
    const do_achado = achados_srv.length
      ? await tx
          .select()
          .from(tabela_unidade)
          .where(
            inArray(
              tabela_unidade.id,
              achados_srv.map((s) => s.unidade_uorg_id ?? -1),
            ),
          )
      : [];
    servidores_achados = achados_srv.map((s) => ({ ...s, unidade: do_achado.find((u) => u.id === s.unidade_uorg_id) ?? null }));
  }

  const aptidao: Record<number, servico_emissao.Validacao> = {};
  if (aba === "emissao") {
    const validacoes = await Promise.all(
      inscricoes.map((inscricao) =>
        servico_emissao.validar(tx, inscricao, {
          valores_turma,
          valores_inscricao: (valores_inscritos as Record<number, campos_certificado.Valores>)[inscricao.id] ?? {},
        }),
      ),
    );
    inscricoes.forEach((inscricao, i) => (aptidao[inscricao.id] = validacoes[i]!));
  }
  for (const linha of grade) vista_inscricao(linha.inscricao);
  const certificados = Object.fromEntries(
    Object.entries(certificados_por_inscricao).map(([k, cert]) => [
      k,
      { ...cert, rotulo: `${cert.numero}/${cert.ano}`, so_word: servico_emissao.do_modelo_enviado(cert) },
    ]),
  );
  // algum de modelo enviado: o "todos" sai em Word (.zip), não no PDF da casa
  const certificados_em_word = Object.values(certificados).some((cert) => cert.so_word);
  // NUVEM: o último envio por e-mail de cada certificado (aba Emissão)
  const envios =
    aba === "emissao" && usuario.pode("certificado.emitir")
      ? await envio_certificado.ultimo_envio_por_certificado(
          tx,
          Object.values(certificados).map((cert) => cert.id),
        )
      : {};

  return pagina(c, "paginas/turma_ficha.html", usuario, {
    turma,
    descricao_anterior: (await _ultimas_descricoes(tx, turma.id))[turma.treinamento_id] ?? "",
    link_no_ar: inscricao_publica.link_no_ar(turma),
    certificados_em_word,
    envios,
    rotulo_envio: email.ROTULO_SITUACAO,
    aba,
    abas,
    abas_previstas: ABAS_PREVISTAS,
    inscricoes,
    rotulo_vinculo: ROTULO_VINCULO,
    vinculos: VINCULOS_PARTICIPANTE.filter((v) => v !== "SERVIDOR"),
    vagas_restantes,
    // de planejada direto a concluída, só turma que já terminou (a guarda é do serviço)
    destinos: destinos_de_turma(turma.situacao)
      .filter((codigo) => !(turma.situacao === "PLANEJADA" && codigo === "CONCLUIDA" && turma.data_fim > datas_br.hoje()))
      .map((codigo) => [codigo, ROTULO_TURMA[codigo]]),
    // o atalho "turma já realizada": datas passadas e nada lançado ainda
    ja_realizada:
      ["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"].includes(turma.situacao) &&
      turma.data_fim <= datas_br.hoje() &&
      usuario.pode("turma.avaliar") &&
      usuario.pode("turma.concluir"),
    lancamento_aberto: turma.situacao === "CONCLUIDA" || servico_presenca.aceita_lancamento(turma),
    permissao_por_destino: servico_turma.PERMISSAO_POR_SITUACAO_TURMA,
    instrutores_livres,
    achados,
    servidores_achados,
    busca,
    campi,
    unidades,
    // --- aba 3 ---
    dias: servico_presenca.dias_da_turma(turma),
    grade,
    contagem: ve_nominal ? await servico_presenca.contagem_por_situacao(tx, turma) : {},
    carga_efetiva: turma.carga_horaria_horas || turma.treinamento.carga_horaria_horas,
    retificando: turma.situacao === "CONCLUIDA",
    // --- aba 4: a mesma função que a emissão usa decide quem aparece como apto
    aptidao,
    certificados,
    // NUVEM: campos que o modelo pede à turma e a cada participante
    modelo_emissao,
    campos_turma: campos_certificado.campos_da_turma(modelo_emissao),
    campos_participante: campos_certificado.campos_do_participante(modelo_emissao),
    valores_turma,
    valores_inscritos,
    trilha_campos,
    pode_preencher_turma: campos_certificado.pode_preencher_turma(usuario),
    pode_preencher_participante: usuario.pode(campos_certificado.PERMISSAO_CAMPO_PARTICIPANTE),
    ...recados(c),
  });
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const destino = `${TURMAS}/${turma_id}`;
  try {
    await _no_savepoint(c, async (sp) => {
      const campos = {
        data_inicio: _data(f.texto("data_inicio"), "a data de início")!,
        data_fim: _data(f.texto("data_fim"), "a data de término")!,
        local: texto_ou_nulo(f.texto("local")),
        descricao: texto_ou_nulo(f.texto("descricao")),
        campus_id: id_opcional(f.texto("campus_id")),
        unidade_promotora_id: id_opcional(f.texto("unidade_promotora_id")),
        carga_horaria_horas: _decimal(f.texto("carga_horaria_horas"), "a carga horária"),
        data_base_vencimento: _data(f.texto("data_base_vencimento"), "a data base", false),
        vagas: _inteiro(f.texto("vagas"), "o número de vagas"),
        inscricao_aberta_ate: _data(f.texto("inscricao_aberta_ate"), "o fim das inscrições", false),
        nota_minima_aprovacao: _decimal(f.texto("nota_minima_aprovacao"), "a nota mínima"),
        frequencia_minima_percentual: _decimal(f.texto("frequencia_minima_percentual"), "a frequência mínima", "75")!,
        observacoes: texto_ou_nulo(f.texto("observacoes")),
      };
      await servico_turma.editar_turma(sp, usuario, turma, campos);
    });
  } catch (erro) {
    if (erro instanceof CampoInvalido || erro instanceof RegraDaTurma) return _erro(c, destino, erro.message);
    throw erro;
  }
  return _volta(c, destino, "Turma atualizada.");
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/situacao`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  try {
    await _no_savepoint(c, (sp) =>
      servico_turma.mudar_situacao(sp, usuario, turma, f.texto("destino"), { motivo: f.texto("motivo") }),
    );
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, volta, erro.message);
    throw erro;
  }
  // concluída, o próximo passo é emitir: a volta já cai na aba
  if (turma.situacao === "CONCLUIDA") {
    return _volta(c, `${volta}?aba=emissao`, `${turma.codigo}: concluída. Confira os dados e emita os certificados.`);
  }
  const rotulo = { INSCRICOES_ABERTAS: "inscrições abertas" }[turma.situacao as string] ?? ROTULO_TURMA[turma.situacao]!.toLowerCase();
  return _volta(c, volta, `${turma.codigo}: ${rotulo}.`);
});

/**
 * NUVEM: "Registrar turma já realizada" — presença de todos pela carga e a
 * turma concluída num clique (com nota mínima, só a presença). As regras são
 * do serviço (`presenca.registrar_turma_realizada`); tudo num savepoint.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/realizada`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  let feito: servico_presenca.TurmaRealizada;
  try {
    feito = await _no_savepoint(c, (sp) => servico_presenca.registrar_turma_realizada(sp, usuario, turma));
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, volta, erro.message);
    throw erro;
  }
  if (!feito.concluida) {
    return _volta(
      c,
      `${volta}${PRESENCAS}`,
      `${feito.presentes} presença(s) lançada(s). A turma exige nota mínima: lance as notas e depois conclua a turma.`,
    );
  }
  return _volta(
    c,
    `${volta}?aba=emissao`,
    `${turma.codigo} registrada como realizada: ${feito.presentes} presença(s) e turma concluída. Emita os certificados.`,
  );
});

// =====================================================================
// Instrutores
// =====================================================================
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/instrutores`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  const alvo = id_opcional(f.texto("assinatura_instrutor_id"));
  if (alvo === null) return _erro(c, volta, "Escolha o instrutor.");
  let nome = "";
  try {
    if (marcado(f.texto("remover"))) {
      await _no_savepoint(c, (sp) => servico_turma.desvincular_instrutor(sp, usuario, turma, alvo));
      return _volta(c, volta, "Instrutor desvinculado da turma.");
    }
    const instrutor = await tx.query.assinatura_instrutor.findFirst({
      where: eq(tabela_assinatura.id, alvo),
      with: { servidor: true },
    });
    if (!instrutor) return _erro(c, volta, "Assinatura de instrutor não encontrada.");
    nome = AssinaturaInstrutor.nome_exibicao(instrutor);
    await _no_savepoint(c, (sp) =>
      servico_turma.vincular_instrutor(sp, usuario, turma, instrutor, {
        assina_certificado: marcado(f.texto("assina_certificado")),
      }),
    );
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, `${nome} vinculado à turma.`);
});

// =====================================================================
// Inscrições — aba 2
// =====================================================================
/**
 * Três portas para a mesma coisa: participante já cadastrado, servidor da
 * base, ou externo novo. Servidor vira ponteiro, nunca cópia de nome.
 */
async function _resolver_participante(
  tx: Executor,
  usuario: UsuarioAtual,
  d: Record<string, string>,
): Promise<servico_participante.ParticipanteCarregado> {
  const escolhido = id_opcional(d.participante_id);
  if (escolhido !== null) {
    const pessoa = await servico_participante.carregar(tx, escolhido);
    if (!pessoa) throw new CampoInvalido("Participante não encontrado.");
    // e-mail digitado junto com participante já existente é endereço novo da mesma pessoa
    await servico_participante.registrar_email(tx, pessoa, d.email);
    return pessoa;
  }
  const alvo_servidor = id_opcional(d.servidor_id);
  if (alvo_servidor !== null) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, alvo_servidor));
    if (!servidor) throw new CampoInvalido("Servidor não encontrado.");
    const pessoa = await servico_participante.de_servidor(tx, servidor, usuario);
    await servico_participante.registrar_email(tx, pessoa, d.email);
    return pessoa;
  }
  if (!(d.nome ?? "").trim()) {
    throw new CampoInvalido(
      "Escolha alguém já cadastrado, um servidor da base, ou informe o nome de um participante externo.",
    );
  }
  return servico_participante.criar_externo(tx, {
    nome: d.nome!,
    vinculo: (d.vinculo || "OUTRO").trim().toUpperCase(),
    usuario,
    email: d.email,
    organizacao: d.organizacao,
    matricula_externa: d.matricula_externa,
  });
}

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  // inscrito um da lista, a mesma busca volta aberta para o próximo
  const busca = f.texto("busca").trim();
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes${busca ? `&busca=${encodeURIComponent(busca)}` : ""}`;
  const d = Object.fromEntries(
    ["participante_id", "servidor_id", "nome", "vinculo", "email", "organizacao", "matricula_externa", "observacao"].map(
      (k) => [k, f.texto(k)],
    ),
  );
  let pessoa: servico_participante.ParticipanteCarregado;
  try {
    // CPF opcional, só para o certificado (`cpf_certificado.ts`): conferido
    // ANTES de gravar qualquer coisa, e a recusa não ecoa o número
    const cpf = cpf_certificado.ler_campo(f.texto(CAMPO_CPF_CERTIFICADO));
    // o savepoint é o que impede o pior caso desta rota: o participante externo
    // gravado antes de a inscrição ser recusada
    pessoa = await _no_savepoint(c, async (sp) => {
      const p = await _resolver_participante(sp, usuario, d);
      await servico_turma.inscrever(sp, usuario, turma, p, { observacao: texto_ou_nulo(d.observacao) });
      if (cpf) await cpf_certificado.definir_do_participante(sp, usuario, p, cpf);
      return p;
    });
  } catch (erro) {
    if (
      erro instanceof CampoInvalido ||
      erro instanceof DadosDoParticipante ||
      erro instanceof RegraDaTurma ||
      erro instanceof cpf_certificado.CpfInvalido
    ) {
      return _erro(c, volta, erro.message);
    }
    throw erro;
  }
  return _volta(c, volta, `${nome_exibicao(pessoa)} inscrito(a) em ${turma.codigo}.`);
});

// =====================================================================
// Inscrição em lote — a lista colada da planilha (`inscricao_lote.ts`)
// =====================================================================
async function _tela_lote(
  c: Ctx,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  d: {
    texto?: string;
    vinculo?: string;
    organizacao?: string;
    desfechos?: inscricao_lote.Desfecho[] | null;
    gravado?: boolean;
    erro?: string | null;
  } = {},
) {
  const desfechos = d.desfechos ?? null;
  const contagem = { INSCRITA: 0, JA_INSCRITA: 0, RECUSADA: 0 };
  for (const x of desfechos ?? []) contagem[x.resultado] += 1;
  return pagina(c, "paginas/turma_lote.html", usuario, {
    turma: vista_turma(turma),
    vagas_restantes: await servico_turma.vagas_restantes(c.get("tx"), turma),
    texto: d.texto ?? "",
    vinculo: d.vinculo ?? "TERCEIRIZADO",
    organizacao: d.organizacao ?? "",
    vinculos: VINCULOS_PARTICIPANTE.filter((v) => v !== "SERVIDOR"),
    rotulo_vinculo: ROTULO_VINCULO,
    desfechos,
    contagem,
    gravado: d.gravado ?? false,
    limite: inscricao_lote.LIMITE_LINHAS,
    casa_nome: usuario.ve_dado_nominal,
    erro: d.erro ?? null,
  });
}

rotas.get(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/lote`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const turma = await _turma_no_escopo(c.get("tx"), usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  return _tela_lote(c, usuario, turma);
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/lote`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  const f = await formulario(c);
  const d = { texto: f.texto("lista"), vinculo: f.texto("vinculo"), organizacao: f.texto("organizacao").trim() };
  const gravar = f.texto("acao") === "inscrever";
  let desfechos: inscricao_lote.Desfecho[];
  try {
    desfechos = await inscricao_lote.processar(tx, usuario, turma, d.texto, d, !gravar);
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _tela_lote(c, usuario, turma, { ...d, erro: erro.message });
    throw erro;
  }
  if (!gravar) return _tela_lote(c, usuario, turma, { ...d, desfechos });
  // gravado: na caixa ficam só as recusadas, para corrigir e mandar de novo
  const recusadas = desfechos.filter((x) => x.resultado === "RECUSADA").map((x) => x.texto);
  return _tela_lote(c, usuario, turma, { ...d, texto: recusadas.join("\n"), desfechos, gravado: true });
});

// =====================================================================
// O link público de inscrição (ver `servicos/inscricao_publica.ts`)
// =====================================================================
/**
 * Gera (ou troca) o link e o mostra NESTA resposta, com o QR: o banco guarda
 * só o hash, e um 303 com o token na URL o deixaria no histórico e no log.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/link-publico`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=inscricoes`;
  let token: string;
  try {
    token = await _no_savepoint(c, (sp) => inscricao_publica.gerar_link(sp, usuario, turma));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  const endereco = `${await servico_emissao.url_base_validacao(tx)}${inscricao_publica.CAMINHO}/${token}`;
  const resposta = await pagina(c, "paginas/turma_link.html", usuario, {
    turma: vista_turma(turma),
    endereco,
    qr: `data:image/png;base64,${Buffer.from(qr_png(endereco, 6)).toString("base64")}`,
  });
  resposta.headers.set("cache-control", "no-store");
  return resposta;
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/link-publico/desligar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  await inscricao_publica.desligar_link(tx, usuario, turma);
  return _volta(c, `${TURMAS}/${turma.id}?aba=inscricoes`, "Link público desligado: o endereço deixou de funcionar.");
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/:inscricao_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes`;
  const inscricao = await servico_turma.carregar_inscricao(tx, Number(c.req.param("inscricao_id")), turma);
  if (!inscricao || inscricao.turma_id !== turma.id) return redirecionar(c, volta);
  try {
    await _no_savepoint(c, (sp) =>
      servico_turma.mudar_situacao_inscricao(sp, usuario, inscricao, f.texto("destino"), { motivo: f.texto("motivo") }),
    );
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(
    c,
    volta,
    `${nome_exibicao(inscricao.participante)}: ${ROTULO_INSCRICAO[inscricao.situacao]!.toLowerCase()}.`,
  );
});

/**
 * O CPF do participante, só para o certificado que a norma exige
 * (`cpf_certificado.ts`). Quem inscreve é quem gerencia o participante; a
 * resposta nunca traz o número, nem na recusa.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/:inscricao_id{[0-9]+}/cpf`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes`;
  const inscricao = await servico_turma.carregar_inscricao(tx, Number(c.req.param("inscricao_id")), turma);
  if (!inscricao || inscricao.turma_id !== turma.id) return redirecionar(c, volta);
  let cpf: string | null | undefined;
  try {
    cpf = cpf_certificado.ler_campo(f.texto(CAMPO_CPF_CERTIFICADO), marcado(f.texto("apagar_cpf")));
  } catch (erro) {
    if (erro instanceof cpf_certificado.CpfInvalido) return _erro(c, volta, erro.message);
    throw erro;
  }
  if (cpf === undefined) return _erro(c, volta, "Digite o CPF, ou marque “apagar”.");
  const mudou = await cpf_certificado.definir_do_participante(tx, usuario, inscricao.participante, cpf);
  const quem = inscricao.participante.identificador_publico;
  if (!mudou) return _volta(c, volta, `${quem}: CPF sem alteração.`);
  return _volta(c, volta, cpf === null ? `${quem}: CPF apagado.` : `${quem}: CPF gravado para o certificado.`);
});

// =====================================================================
// Presença e notas — aba 3
// =====================================================================
const PRESENCAS = "?aba=presencas";
// a âncora do 303: quem estava na linha 27 da grade volta à linha 27
const ANCORA_GRADE = "#grade-presenca";

/** A inscrição precisa ser DESTA turma (o escopo filtra a turma, não a inscrição). */
async function _inscricao_da_turma(
  tx: Executor,
  turma: TurmaCarregada,
  inscricao_id: number | null,
): Promise<InscricaoCarregada | null> {
  if (inscricao_id === null) return null;
  const inscricao = await servico_turma.carregar_inscricao(tx, inscricao_id, turma);
  if (!inscricao || inscricao.turma_id !== turma.id) return null;
  return inscricao;
}

/**
 * O que decide o formato da resposta é o cabeçalho: `HX-Request` só existe
 * quando quem chamou foi o htmx. E a recusa de regra volta em 200, com o
 * motivo dentro da célula acionada.
 */
function _e_htmx(c: Ctx): boolean {
  return c.req.header("HX-Request") === "true";
}

/** A linha da grade daquele inscrito, pronta para substituir a que está lá. */
function _linha_trocada(
  c: Ctx,
  turma: TurmaCarregada,
  inscricao: InscricaoCarregada,
  d: { recusa?: string | null; recusa_onde?: string | null; digitado_horas?: string; digitado_nota?: string } = {},
) {
  vista_turma(turma);
  vista_inscricao(inscricao);
  return fragmento(c, "partes/linha_presenca.html", {
    turma,
    linha: servico_presenca.linha_da_grade(turma, inscricao),
    dias: servico_presenca.dias_da_turma(turma),
    // a guarda que decide é a do serviço (`_exigir_lancamento`), que já correu
    pode_lancar: true,
    retificando: turma.situacao === "CONCLUIDA",
    recusa: d.recusa ?? null,
    recusa_onde: d.recusa_onde ?? null,
    digitado_horas: d.digitado_horas ?? "",
    digitado_nota: d.digitado_nota ?? "",
  });
}

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/presencas`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}${PRESENCAS}`;
  const inscricao = await _inscricao_da_turma(tx, turma, id_opcional(f.texto("inscricao_id")));
  if (!inscricao) return _erro(c, volta, "Inscrição não encontrada nesta turma.", ANCORA_GRADE);
  const parcial = _e_htmx(c);
  try {
    await _no_savepoint(c, async (sp) => {
      const dia = _data(f.texto("data"), "o dia do lançamento")!;
      await servico_presenca.lancar_presenca(sp, usuario, inscricao, {
        data: dia,
        presente: marcado(f.texto("presente")),
        horas: _decimal(f.texto("horas"), "as horas do dia"),
        justificativa: texto_ou_nulo(f.texto("justificativa")),
        motivo: texto_ou_nulo(f.texto("motivo")),
      });
    });
  } catch (erro) {
    if (!e_recusa(erro)) throw erro;
    if (parcial) {
      // o objeto em memória pode ter andado antes da recusa: relê do banco
      const fresca = (await servico_turma.carregar_inscricao(tx, inscricao.id))!;
      return _linha_trocada(c, fresca.turma, fresca, {
        recusa: erro.message,
        recusa_onde: f.texto("data").trim(),
        digitado_horas: f.texto("horas"),
      });
    }
    return _erro(c, volta, erro.message, ANCORA_GRADE);
  }
  if (parcial) return _linha_trocada(c, turma, inscricao);
  return _volta(
    c,
    volta,
    `${nome_exibicao(inscricao.participante)}: ${servico_presenca.numero(inscricao.frequencia_percentual)}% de frequência.`,
    ANCORA_GRADE,
  );
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/presencas/todos`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}${PRESENCAS}`;
  let alcancadas: InscricaoCarregada[];
  try {
    alcancadas = await _no_savepoint(c, (sp) =>
      servico_presenca.marcar_todos_presentes(sp, usuario, turma, { motivo: texto_ou_nulo(f.texto("motivo")) }),
    );
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, volta, erro.message, ANCORA_GRADE);
    throw erro;
  }
  return _volta(c, volta, `${alcancadas.length} presença(s) lançada(s).`, ANCORA_GRADE);
});

/** Uma COLUNA da grade: todo mundo presente naquele dia (a folha em papel). */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/presencas/dia`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}${PRESENCAS}`;
  let dia = "";
  let alcancadas: InscricaoCarregada[];
  try {
    alcancadas = await _no_savepoint(c, async (sp) => {
      dia = _data(f.texto("data"), "o dia da coluna")!;
      return servico_presenca.marcar_dia_presente(sp, usuario, turma, {
        data: dia,
        horas: _decimal(f.texto("horas"), "as horas do dia"),
        motivo: texto_ou_nulo(f.texto("motivo")),
      });
    });
  } catch (erro) {
    if (e_recusa(erro)) return _erro(c, volta, erro.message, ANCORA_GRADE);
    throw erro;
  }
  return _volta(c, volta, `${alcancadas.length} presença(s) em ${datas_br.numerica(dia)}.`, ANCORA_GRADE);
});

/**
 * Nota de 0 a 10, ou o pedido explícito de apagá-la. Campo vazio **não** apaga
 * a nota: apagar tem botão próprio.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/notas`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}${PRESENCAS}`;
  const inscricao = await _inscricao_da_turma(tx, turma, id_opcional(f.texto("inscricao_id")));
  if (!inscricao) return _erro(c, volta, "Inscrição não encontrada nesta turma.", ANCORA_GRADE);
  const parcial = _e_htmx(c);
  const nota = f.texto("nota");
  try {
    await _no_savepoint(c, async (sp) => {
      let valor: string | null;
      if (marcado(f.texto("apagar"))) {
        valor = null;
      } else {
        valor = _decimal(nota, "a nota");
        if (valor === null) {
          throw new CampoInvalido(
            "Informe a nota (0 a 10) ou use “apagar nota” — campo em branco não apaga o que já está lançado.",
          );
        }
      }
      await servico_presenca.lancar_nota(sp, usuario, inscricao, valor, { motivo: texto_ou_nulo(f.texto("motivo")) });
    });
  } catch (erro) {
    if (!e_recusa(erro)) throw erro;
    if (parcial) {
      const fresca = (await servico_turma.carregar_inscricao(tx, inscricao.id))!;
      return _linha_trocada(c, fresca.turma, fresca, { recusa: erro.message, recusa_onde: "nota", digitado_nota: nota });
    }
    return _erro(c, volta, erro.message, ANCORA_GRADE);
  }
  if (parcial) return _linha_trocada(c, turma, inscricao);
  return _volta(
    c,
    volta,
    `${nome_exibicao(inscricao.participante)}: nota ${servico_presenca.numero(inscricao.nota_final)}.`,
    ANCORA_GRADE,
  );
});

// =====================================================================
// Emissão — aba 4
// =====================================================================
/**
 * Emite um certificado, ou o lote inteiro quando `inscricao_id` vem vazio. O
 * lote isola cada certificado num savepoint, dentro do serviço.
 */
/**
 * Envia por e-mail os certificados emitidos da turma que ainda não foram (o
 * que já foi não sai de novo: reenviar é pela ficha do certificado).
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/certificados/email`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=emissao`;
  const ids = Object.values(await servico_emissao.certificados_da_turma(tx, turma)).map((cert) => cert.id);
  if (!ids.length) return _erro(c, volta, "Nenhum certificado emitido nesta turma.");
  const r = await envio_certificado.pedir_envio(tx, usuario, ids);
  if (r.enfileirados) await email.acordar_envio();
  return (r.enfileirados ? _volta : _erro)(c, volta, envio_certificado.resumo(r));
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/certificados`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=emissao`;

  const alvo = id_opcional(f.texto("inscricao_id"));
  if (alvo !== null) {
    const inscricao = await _inscricao_da_turma(tx, turma, alvo);
    if (!inscricao) return _erro(c, volta, "Inscrição não encontrada nesta turma.");
    let resultado: servico_emissao.ResultadoEmissao;
    try {
      resultado = await _no_savepoint(c, (sp) => servico_emissao.emitir(sp, usuario, inscricao));
    } catch (erro) {
      if (erro instanceof servico_emissao.EmissaoBloqueada) return _erro(c, volta, erro.message);
      throw erro;
    }
    const aviso = resultado.aviso_pdf ? ` ${resultado.aviso_pdf}` : "";
    return _volta(
      c,
      volta,
      `Certificado ${resultado.certificado.numero}/${resultado.certificado.ano} emitido para ` +
        `${nome_exibicao(inscricao.participante)}.${aviso}`,
    );
  }

  const relatorio = await servico_emissao.emitir_lote(tx, usuario, turma);
  // nada emitido é o retorno de uma ação que não aconteceu: sai em vermelho
  if (!relatorio.itens.length) return _erro(c, volta, "Ninguém apto a emitir nesta turma.");
  return _volta(c, volta, `${turma.codigo}: ${relatorio.resumo}.`);
});

/**
 * NUVEM: os campos de turma que o modelo de certificado declara (ex.: "Local
 * de atuação do brigadista"). Cada campo vem como `v_<marcador>`.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/campos-certificado`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=emissao`;
  const [modelo] = await servico_emissao.modelo_da_turma(tx, turma);
  if (!modelo) return _erro(c, volta, "A turma não tem modelo de certificado.");
  const digitados: campos_certificado.Valores = {};
  for (const tag of campos_certificado.campos_da_turma(modelo)) {
    // campo enviado em branco apaga; campo ausente fica como está
    if (f.tem(`v_${tag.marcador}`)) digitados[tag.marcador] = f.texto(`v_${tag.marcador}`);
  }
  let mudaram = 0;
  try {
    mudaram = await _no_savepoint(c, (sp) => campos_certificado.gravar_valores_turma(sp, usuario, turma, modelo, digitados));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message, "#campos-turma");
    throw erro;
  }
  return _volta(c, volta, mudaram ? `${mudaram} campo(s) da turma salvo(s).` : "Nada mudou.", "#campos-turma");
});

/**
 * NUVEM: os campos de participante (ex.: nota de cada disciplina), numa grade
 * só. Cada célula vem como `v_<inscricao_id>_<marcador>`; cada inscrição grava
 * no seu savepoint — a que tem certificado válido é recusada sem derrubar as
 * outras.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/campos-participante`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(campos_certificado.PERMISSAO_CAMPO_PARTICIPANTE);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=emissao`;
  const [modelo] = await servico_emissao.modelo_da_turma(tx, turma);
  if (!modelo) return _erro(c, volta, "A turma não tem modelo de certificado.");
  const tags = campos_certificado.campos_do_participante(modelo);
  const [inscricoes, atuais] = await Promise.all([
    servico_turma.inscricoes_da_turma(tx, turma),
    campos_certificado.valores_dos_inscritos(tx, turma.id),
  ]);
  let mudaram = 0;
  const recusas: string[] = [];
  for (const inscricao of inscricoes) {
    const digitados: campos_certificado.Valores = {};
    for (const tag of tags) {
      const nome = `v_${inscricao.id}_${tag.marcador}`;
      if (f.tem(nome)) digitados[tag.marcador] = f.texto(nome);
    }
    if (!Object.keys(digitados).length) continue;
    try {
      mudaram += await _no_savepoint(c, (sp) =>
        campos_certificado.gravar_valores_inscricao(sp, usuario, inscricao, modelo, digitados, atuais[inscricao.id] ?? {}),
      );
    } catch (erro) {
      if (erro instanceof RegraDaTurma) recusas.push(erro.message);
      else throw erro;
    }
  }
  if (recusas.length) {
    return _erro(c, volta, `${mudaram} valor(es) salvo(s). Recusado: ${recusas.join(" ")}`, "#campos-participante");
  }
  return _volta(c, volta, mudaram ? `${mudaram} valor(es) salvo(s).` : "Nada mudou.", "#campos-participante");
});

/** Os .docx vigentes da turma num .zip (modelo enviado: o papel é o Word). */
rotas.get(`${TURMAS}/:turma_id{[0-9]+}/certificados.zip`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const resultado = await servico_emissao.word_da_turma(tx, usuario, turma);
  if (!resultado) return _erro(c, `${TURMAS}/${turma_id}?aba=emissao`, "Nenhum certificado emitido nesta turma.");
  return baixar(c, resultado.bytes, resultado.nome, "application/zip");
});

/** Os certificados vigentes da turma num PDF só, para imprimir de uma vez. */
rotas.get(`${TURMAS}/:turma_id{[0-9]+}/certificados.pdf`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_no_escopo(tx, usuario, turma_id);
  if (!turma) return redirecionar(c, TURMAS);
  const resultado = await servico_emissao.pdf_da_turma(tx, usuario, turma);
  if (!resultado) return _erro(c, `${TURMAS}/${turma_id}?aba=emissao`, "Nenhum certificado emitido nesta turma.");
  return baixar(c, resultado.bytes, resultado.nome, TIPO_PDF);
});

/**
 * A folha que vai ao campo para assinar, em .docx. Regerada a cada pedido:
 * quem entrou na turma na véspera precisa estar nela.
 */
rotas.get(`${TURMAS}/:turma_id{[0-9]+}/lista-presenca`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  const resultado = await servico_lista.gerar(tx, usuario, turma);
  return baixar(c, resultado.bytes, resultado.arquivo!.split("/").pop()!, servico_lista.TIPO_DOCX);
});
