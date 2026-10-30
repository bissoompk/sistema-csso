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
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import {
  assinatura_instrutor as tabela_assinatura,
  campus as tabela_campus,
  certificado as tabela_certificado,
  inscricao as tabela_inscricao,
  participante as e_participante,
  servidor as tabela_servidor,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import * as avaliacao_reacao from "../servicos/avaliacao_reacao.js";
import * as duplicados from "../servicos/duplicados.js";
import * as mesclagem from "../servicos/mesclagem.js";
import {
  ESTADOS_TURMA,
  ROTULO_INSCRICAO,
  ROTULO_TURMA,
  ROTULO_TURMA_TELA,
  TransicaoInvalida,
  destinos_de_turma,
} from "../dominio/estados.js";
import { AssinaturaInstrutor, Certificado as C, ROTULO_VINCULO, VINCULOS_PARTICIPANTE } from "../dominio/treinamento.js";
import { CAMPO_CPF_CERTIFICADO, formulario, usuarioLogado } from "../dependencias.js";
import * as cpf_certificado from "../servicos/cpf_certificado.js";
import * as servico_emissao from "../servicos/emissao_certificado.js";
import * as campos_certificado from "../servicos/campos_certificado.js";
import * as identificacao from "../servicos/identificacao.js";
import { atores_para_tela } from "../servicos/privacidade.js";
import { TIPO_PDF } from "../servicos/certificado_pdf.js";
import * as ics from "../servicos/ics.js";
import * as inscricao_lote from "../servicos/inscricao_lote.js";
import * as inscricao_publica from "../servicos/inscricao_publica.js";
import * as local_treinamento from "../servicos/local_treinamento.js";
import * as retificacao from "../servicos/retificacao.js";
import * as dono_turma from "../servicos/dono_turma.js";
import * as email from "../servicos/email.js";
import * as envio_certificado from "../servicos/envio_certificado.js";
import { qr_png } from "../servicos/qr.js";
import * as servico_lista from "../servicos/lista_presenca.js";
import * as servico_participante from "../servicos/participante.js";
import { DadosDoParticipante, nome_exibicao } from "../servicos/participante.js";
import * as pedidos_link from "../servicos/pedidos_link.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as servico_presenca from "../servicos/presenca.js";
import * as qualificacao_instrutor from "../servicos/qualificacao_instrutor.js";
import * as setor_promotor from "../servicos/setor_promotor.js";
import * as setor_equipe from "../servicos/setor_equipe.js";
import * as vitrine from "../servicos/vitrine.js";
import * as vitrine_arte from "../servicos/vitrine_arte.js";
import * as aviso_interesse from "../servicos/aviso_interesse.js";
import * as anexos from "../servicos/anexos.js";
import * as servico_turma from "../servicos/turma.js";
import { RegraDaTurma, type InscricaoCarregada, type TurmaCarregada } from "../servicos/turma.js";
import * as datas_br from "../servicos/datas_br.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import * as titular_externo from "../servicos/titular_externo.js";
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
  if (dia === null) throw new CampoInvalido(`${invalido(rotulo)}: use AAAA-MM-DD (o dia tem de existir).`);
  return dia;
}

/** O `str.capitalize()` do Python: primeira maiúscula, o resto minúsculo. */
function primeira_maiuscula(texto: string): string {
  return texto ? texto[0]!.toUpperCase() + texto.slice(1).toLowerCase() : texto;
}

/**
 * "A data de início é inválida", "O número de vagas é inválido", "As horas do
 * dia são inválidas": o artigo do rótulo decide a concordância. Antes saía "O
 * número de vagas inválido" — sem o verbo, e no feminino para todo mundo.
 */
function invalido(rotulo: string): string {
  const artigo = rotulo.split(" ")[0]!.toLowerCase();
  const fim = { o: "é inválido", a: "é inválida", os: "são inválidos", as: "são inválidas" }[artigo] ?? "é inválido";
  return `${primeira_maiuscula(rotulo)} ${fim}`;
}

/** Aceita 8, 8,5 e 8.5 — a vírgula é o separador que o setor digita. */
function _decimal(valor: string, rotulo: string, padrao: string | null = null): string | null {
  const bruto = (valor ?? "").trim().replace(",", ".");
  if (!bruto) return padrao;
  const numero = servico_presenca.normalizar_decimal(bruto);
  if (numero === null) throw new CampoInvalido(`${invalido(rotulo)}: informe um número.`);
  return numero;
}

function _inteiro(valor: string, rotulo: string): number | null {
  const bruto = (valor ?? "").trim();
  if (!bruto) return null;
  if (!/^\d+$/.test(bruto)) throw new CampoInvalido(`${invalido(rotulo)}: informe um número inteiro.`);
  return Number(bruto);
}

/**
 * Uma leitura só, pela porta do serviço (`turma.no_escopo`). `permissao` é a
 * do ato da rota: o alcance é o dela, e não o da conta (D9) — quem lê turmas
 * de dois campi e inscreve só num, inscreve só naquele.
 */
function _turma_no_escopo(
  tx: Executor,
  usuario: UsuarioAtual,
  turma_id: number,
  permissao: string | readonly string[] = "treinamento.ver",
) {
  return servico_turma.no_escopo(tx, usuario, turma_id, permissao);
}

/**
 * NUVEM: a turma do ATO de alteração — a do escopo da permissão e, por cima,
 * a regra de dono (`dono_turma.ts`): quem não é dono, superior nem ajudante do
 * papel recebe 403 com o aviso, antes de qualquer gravação.
 */
async function _turma_para_alterar(
  tx: Executor,
  usuario: UsuarioAtual,
  turma_id: number,
  permissao: string | readonly string[],
  papel: dono_turma.Papel,
): Promise<TurmaCarregada | null> {
  const turma = await _turma_no_escopo(tx, usuario, turma_id, permissao);
  if (turma) await dono_turma.exigir_alterar_turma(tx, usuario, turma, papel);
  return turma;
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
    setor?: string;
    turno?: string;
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
  // o setor promotor, como o filtro do IntegraSST
  const setor = id_opcional(d.setor ?? "");
  if (setor !== null) filtros.push(eq(tabela_turma.unidade_promotora_id, setor));
  // o turno, pela hora de início (lista fechada em `servico_turma.TURNOS`)
  const turno = servico_turma.ler_turno(d.turno);
  if (turno) filtros.push(servico_turma.condicao_turno(turno));
  const itens = (
    (await tx.query.turma.findMany({
      where: and(...filtros),
      with: servico_turma.COM_TURMA as never,
      orderBy: (t, { desc }) => [desc(t.ano), desc(t.numero)],
    })) as unknown as TurmaCarregada[]
  ).map(vista_turma);
  // Instalação sem turma nenhuma: a tela diz por onde começar, em vez de só
  // oferecer "Abrir turma" sem treinamento para escolher.
  // A conta sem setor promotor não está "começando": o aviso dela é outro.
  const comecando =
    !itens.length && !situacao && alvo === null && !turno && usuario.pode("turma.criar") && !setor_equipe.sem_setor(usuario);
  // tudo junto: uma ida ao banco, e não uma por turma (ver `db/cliente.ts`)
  const [ocupadas, treinamentos, campi, unidades, [instrutor], setores_usados] = await Promise.all([
    Promise.all(itens.map((turma) => servico_turma.inscricoes_que_ocupam_vaga(tx, turma))),
    tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    tx.select().from(tabela_campus).orderBy(asc(tabela_campus.nome)),
    tx.select().from(tabela_unidade).orderBy(asc(tabela_unidade.nome_extenso)),
    comecando
      ? tx.select({ id: tabela_assinatura.id }).from(tabela_assinatura).where(eq(tabela_assinatura.ativo, true)).limit(1)
      : Promise.resolve([]),
    tx
      .selectDistinct({ id: tabela_turma.unidade_promotora_id })
      .from(tabela_turma)
      .where(and(servico_turma.consulta_no_escopo(usuario), isNotNull(tabela_turma.unidade_promotora_id))),
  ]);
  const usados_como_setor = new Set(setores_usados.map((s) => s.id));
  const meus = setor_equipe.ve_todos(usuario) ? null : new Set(usuario.setores_promotores);
  const inscritos: Record<number, number> = {};
  itens.forEach((turma, i) => (inscritos[turma.id] = ocupadas[i]!));
  // os pedidos do link a conferir, por turma: o que pede ação na linha
  const pedidos: Record<number, number> = {};
  if (itens.length) {
    const linhas = await tx
      .select({ turma_id: tabela_inscricao.turma_id, n: count() })
      .from(tabela_inscricao)
      .where(and(inArray(tabela_inscricao.turma_id, itens.map((x) => x.id)), eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")))
      .groupBy(tabela_inscricao.turma_id);
    for (const l of linhas) pedidos[l.turma_id] = Number(l.n);
  }
  const hoje = datas_br.hoje();
  const link_no_ar: Record<number, boolean> = {};
  for (const turma of itens) link_no_ar[turma.id] = inscricao_publica.link_no_ar(turma, hoje);
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
    pedidos,
    link_no_ar,
    hoje,
    pode_inscrever: usuario.pode("turma.inscrever"),
    filtro_setor: setor ? String(setor) : "",
    // NUVEM: os setores promotores de hoje e qualquer unidade que já promoveu
    // turma — a turma antiga, de unidade fora da lista, continua encontrável.
    // Quem não vê todos os setores filtra entre os seus (`setor_equipe.ts`)
    setores_do_filtro: unidades.filter(
      (u) => (u.promove_treinamento || usados_como_setor.has(u.id)) && (meus === null || meus.has(u.id)),
    ),
    // só treinamento ativo entra no seletor de nova turma
    treinamentos: treinamentos.filter((t) => t.ativo),
    // o filtro lista todos: turma antiga de curso desativado continua encontrável
    treinamentos_do_filtro: treinamentos,
    campi,
    // NUVEM: na turma nova, só os setores promotores (`setor_promotor.ts`) —
    // e, para quem não vê todos, só os seus; com um só, ele já vem escolhido
    unidades: unidades.filter((u) => u.promove_treinamento && (meus === null || meus.has(u.id))),
    setor_padrao: meus !== null && meus.size === 1 ? String([...meus][0]) : "",
    dica_setor_promotor: meus === null ? setor_promotor.DICA : setor_promotor.DICA_DOS_MEUS,
    sem_setor_promotor: setor_equipe.sem_setor(usuario),
    descricoes: await _ultimas_descricoes(tx),
    // NUVEM (24/10/2026): os locais cadastrados ativos, para o seletor "Local"
    locais: await local_treinamento.opcoes(tx),
    situacoes: ESTADOS_TURMA.map((codigo) => [codigo, ROTULO_TURMA_TELA[codigo]]),
    filtro_situacao: situacao,
    filtro_treinamento: treinamento_id,
    filtro_turno: turno,
    turnos: servico_turma.TURNOS,
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
    setor: c.req.query("setor") ?? "",
    turno: c.req.query("turno") ?? "",
    ...recados(c),
  });
});

// =====================================================================
// "Meus treinamentos" — a tela do próprio servidor (antes de /turmas/{id})
// =====================================================================
// =====================================================================
// Pedidos pelo link — conferir de uma vez, de todas as turmas
// =====================================================================
export const PEDIDOS = `${TURMAS}/pedidos`;

async function _tela_pedidos(c: Ctx, usuario: UsuarioAtual, d: { mensagem?: string | null; erro?: string | null; travados?: pedidos_link.ResultadoLote["travados"] } = {}) {
  return pagina(c, "paginas/turmas_pedidos.html", usuario, {
    turmas: await pedidos_link.a_conferir(c.get("tx"), usuario),
    sem_setor_promotor: setor_equipe.sem_setor(usuario),
    rotulo_vinculo: ROTULO_VINCULO,
    travados: d.travados ?? [],
    ...recados(c),
    ...(d.mensagem ? { mensagem: d.mensagem } : {}),
    ...(d.erro ? { erro: d.erro } : {}),
  });
}

rotas.get(PEDIDOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  return _tela_pedidos(c, usuario);
});

/**
 * Aceitar ou recusar os pedidos marcados. Vem desta tela ou da aba Inscrições
 * da turma (`volta`); o que travar (turma lotada, por exemplo) fica como
 * estava e volta na tela com o motivo.
 */
rotas.post(PEDIDOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const f = await formulario(c);
  const volta_turma = id_opcional(f.texto("turma_id"));
  const volta = volta_turma ? `${TURMAS}/${volta_turma}?aba=inscricoes` : PEDIDOS;
  const ids = [...new Set(f.todos("inscricao_id").map((v) => id_opcional(v)).filter((v): v is number => v !== null))];
  if (!ids.length) return _erro(c, volta, "Marque os pedidos.");
  const aceitar = f.texto("acao") !== "recusar";
  let resultado: pedidos_link.ResultadoLote;
  try {
    resultado = await pedidos_link.decidir(c.get("tx"), usuario, ids, aceitar ? "INSCRITA" : "CANCELADA", f.texto("motivo") || null);
  } catch (erro) {
    if (erro instanceof RegraViolada) return _erro(c, volta, erro.message);
    throw erro;
  }
  const frase =
    `${resultado.feitos} pedido(s) ${aceitar ? "aceito(s): já ocupam vaga" : "recusado(s)"}` +
    (resultado.travados.length
      ? `; ${resultado.travados.length} não ${resultado.travados.length > 1 ? "puderam" : "pôde"}: ` +
        resultado.travados.map((x) => `${x.quem} — ${x.motivo.replace(/\.$/, "")}`).join("; ")
      : "") +
    // a turma em que se marcou mais do que cabe: nenhum dela foi aceito
    resultado.excedidas
      .map(
        (x) =>
          `. ${x.codigo}: ${x.marcados} pedidos marcados e ` +
          (x.vagas === 0
            ? "a turma está lotada — nenhum foi aceito"
            : `${x.vagas === 1 ? "1 vaga livre" : `${x.vagas} vagas livres`} — nenhum foi aceito; ` +
              `desmarque ${x.marcados - x.vagas} e aceite de novo`),
      )
      .join("") +
    ".";
  const problema = resultado.travados.length || resultado.excedidas.length;
  if (problema && !volta_turma) {
    return _tela_pedidos(c, usuario, { [resultado.feitos ? "mensagem" : "erro"]: frase, travados: resultado.travados });
  }
  return resultado.feitos && !resultado.excedidas.length ? _volta(c, volta, frase) : _erro(c, volta, frase);
});

export const MINHAS = `${TURMAS}/minhas`;

/** "Restam 3 vagas", "Resta 1 vaga", "Lotada", "Sem limite de vagas". */
export function frase_das_vagas(restantes: number | null): string {
  if (restantes === null) return "Sem limite de vagas";
  if (restantes <= 0) return "Lotada";
  return restantes === 1 ? "Resta 1 vaga" : `Restam ${restantes} vagas`;
}

rotas.get(MINHAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const minhas_inscricoes = (await servico_turma.inscricoes_do_titular(tx, usuario)).map(vista_inscricao);
  // a situação REAL de cada turma em que já há inscrição minha — a cancelada
  // também: "já inscrito" para quem desistiu era o rótulo que enganava
  const minha_situacao: Record<number, string> = {};
  for (const i of minhas_inscricoes) minha_situacao[i.turma_id] = servico_turma.situacao_para_o_titular(i.situacao);
  const restantes: Record<number, number | null> = {};
  // os filtros GET: o turno (lista fechada) e o treinamento — este é o destino
  // do "Inscrever-se na reciclagem" do cartão do certificado
  // (`/turmas/minhas?treinamento={id}#abertas`); id que não existe é ignorado
  const turno = servico_turma.ler_turno(c.req.query("turno"));
  const pedido_treinamento = id_opcional(c.req.query("treinamento"));
  const [treinamento_filtro] =
    pedido_treinamento === null
      ? []
      : await tx
          .select({ id: tabela_treinamento.id, nome: tabela_treinamento.nome })
          .from(tabela_treinamento)
          .where(eq(tabela_treinamento.id, pedido_treinamento));
  const todas_abertas = (await servico_turma.turmas_abertas(tx, hoje)).map(vista_turma);
  const abertas = todas_abertas.filter(
    (t) =>
      (!treinamento_filtro || t.treinamento_id === treinamento_filtro.id) &&
      (!turno || servico_turma.turno_de(t.hora_inicio) === turno),
  );
  for (const turma of abertas) restantes[turma.id] = await servico_turma.vagas_restantes(tx, turma);
  // a lotada vai para o fim: quem procura vaga lê de cima para baixo
  abertas.sort((a, b) => Number(restantes[a.id] === 0) - Number(restantes[b.id] === 0));
  // a vitrine por dentro: o mesmo cartão público de /cursos, com o contexto de quem pede
  const cursos = [];
  const contexto_cartao: Record<string, { id: number; situacao: string; pode_pedir: boolean; divulgada: boolean; horario: string; vagas: string }> = {};
  for (const t of abertas) {
    const curso = await vitrine.curso_publico(tx, t as TurmaCarregada, hoje);
    cursos.push(curso);
    contexto_cartao[curso.codigo] = {
      id: t.id,
      situacao: minha_situacao[t.id] ?? "",
      pode_pedir: usuario.pode("turma.inscrever_se"),
      divulgada: Boolean(t.divulgada_em),
      horario: servico_turma.horario_curto(t),
      vagas: frase_das_vagas(restantes[t.id] ?? null),
    };
  }
  return pagina(c, "paginas/turmas_minhas.html", usuario, {
    hoje,
    abertas,
    cursos,
    contexto_cartao,
    vagas_restantes: restantes,
    frase_vagas: Object.fromEntries(abertas.map((t) => [t.id, frase_das_vagas(restantes[t.id] ?? null)])),
    minha_situacao,
    inscricoes: minhas_inscricoes,
    desistivel: Object.fromEntries(minhas_inscricoes.map((i) => [i.id, servico_turma.pode_desistir(i, hoje)])),
    pode_pedir: usuario.pode("turma.inscrever_se"),
    filtro_turno: turno,
    turnos: servico_turma.TURNOS,
    treinamento_filtro: treinamento_filtro ?? null,
    total_abertas: todas_abertas.length,
    // "Adicionar à agenda": a inscrição viva de turma que não foi cancelada
    com_agenda: Object.fromEntries(minhas_inscricoes.map((i) => [i.id, servico_turma.tem_agenda(i)])),
    // a avaliação de reação: o botão na turma que terminou e que ele frequentou
    avaliavel: Object.fromEntries(minhas_inscricoes.map((i) => [i.id, avaliacao_reacao.pode_avaliar(i, hoje)])),
    // conta sem titular (nem servidor ligado, nem terceirizado/discente) não é
    // erro: é a tela dizendo por que está vazia
    sem_servidor: !titular_externo.tem_titular(usuario),
    ...recados(c),
  });
});

/**
 * A agenda (.ics) da turma em que o titular está inscrito. Como o resto de
 * "Meus treinamentos", a rota não aceita "quem": o titular sai da sessão, e a
 * turma em que ele não tem inscrição viva responde 404 — a mesma resposta da
 * turma que não existe.
 */
rotas.get(`${MINHAS}/:turma_id{[0-9]+}/agenda.ics`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const minha = (await servico_turma.inscricoes_do_titular(tx, usuario)).find((i) => i.turma_id === turma_id);
  if (!minha || !servico_turma.tem_agenda(minha)) return c.text("Turma não encontrada entre as suas inscrições.", 404);
  const agenda = await ics.da_turma(tx, minha.turma);
  const resposta = baixar(c, agenda.bytes, agenda.nome, ics.TIPO_ICS);
  resposta.headers.set("cache-control", "no-store");
  return resposta;
});

/**
 * O servidor pede a própria vaga. **A rota não aceita "quem"**: o único
 * parâmetro é a turma, e o titular sai da sessão.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscrever-me`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever_se");
  const turma = await _turma_no_escopo(c.get("tx"), usuario, Number(c.req.param("turma_id")), "turma.inscrever_se");
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
    `Inscrição confirmada em ${turma.codigo}. A vaga é sua; se não puder ir, desista até a véspera ` +
      "para liberá-la a outra pessoa.",
  );
});

/** A própria desistência. Mesma disciplina: nenhum "quem" entra por aqui. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/desistir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever_se");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")), "turma.inscrever_se");
  if (!turma) return redirecionar(c, MINHAS);
  const minha = (await servico_turma.inscricoes_do_titular(tx, usuario)).find((i) => i.turma_id === turma.id);
  if (!minha) return _erro(c, MINHAS, `Você não tem inscrição em ${turma.codigo}.`);
  const era_pedido = minha.situacao === "AGUARDANDO_EMAIL";
  try {
    await _no_savepoint(c, (sp) => servico_turma.desistir(sp, usuario, minha, { motivo: texto_ou_nulo(f.texto("motivo")) }));
  } catch (erro) {
    if (erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) return _erro(c, MINHAS, erro.message);
    throw erro;
  }
  if (era_pedido) {
    return _volta(c, MINHAS, `Pedido de vaga em ${turma.codigo} retirado. O registro fica, com o motivo — nada foi apagado.`);
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
    "local_id",
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
    "abertura",
    "hora_inicio",
    "hora_fim",
    "aceita_comunidade_externa",
  ];
  const digitado: Record<string, string> = Object.fromEntries(campos.map((k) => [k, f.texto(k)]));
  const recusar = (mensagem: string) => _tela_lista(c, usuario, { erro: mensagem, digitado });

  const [treinamento] = await tx
    .select()
    .from(tabela_treinamento)
    .where(eq(tabela_treinamento.id, id_opcional(digitado.treinamento_id) ?? 0));
  if (!treinamento) return recusar("Escolha o treinamento da turma.");
  const com_link = digitado.abertura === "LINK";
  if (com_link && !digitado.inscricao_aberta_ate) {
    return recusar("Turma aberta com link precisa de “inscrições até”: é a data em que o link deixa de funcionar.");
  }
  let turma: TurmaCarregada;
  let token: string | null = null;
  try {
    turma = await _no_savepoint(c, async (sp) => {
      const inicio = _data(digitado.data_inicio!, "a data de início")!;
      const fim = _data(digitado.data_fim!, "a data de término")!;
      // o link fecha quando a turma começa (`aberta_a_pedido_proprio`): recusado
      // aqui, antes de a turma existir, a frase não cita um código que não vai ficar
      if (com_link && inicio <= datas_br.hoje()) {
        throw new CampoInvalido("Turma com link público precisa começar depois de hoje: a partir do início, quem inscreve é a equipe responsável.");
      }
      let criada = await servico_turma.criar_turma(sp, usuario, {
        treinamento,
        data_inicio: inicio,
        data_fim: fim,
        local: texto_ou_nulo(digitado.local),
        local_id: id_opcional(digitado.local_id),
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
        hora_inicio: texto_ou_nulo(digitado.hora_inicio),
        hora_fim: texto_ou_nulo(digitado.hora_fim),
        aceita_comunidade_externa: marcado(digitado.aceita_comunidade_externa),
      });
      // o atalho "turma aberta com link": tudo ou nada, no mesmo savepoint
      if (com_link) {
        criada = await servico_turma.mudar_situacao(sp, usuario, criada, "INSCRICOES_ABERTAS");
        token = await inscricao_publica.gerar_link(sp, usuario, criada);
      }
      return criada;
    });
  } catch (erro) {
    if (erro instanceof CampoInvalido || erro instanceof RegraDaTurma || erro instanceof TransicaoInvalida) {
      return recusar(erro.message);
    }
    throw erro;
  }
  if (token) return _tela_link(c, usuario, turma, token);
  // os avisos do local (capacidade, choque de sala) não impedem: vão no recado
  const avisos = await local_treinamento.avisos_da_turma(tx, turma);
  return _volta(c, `${TURMAS}/${turma.id}`, `Turma ${turma.codigo} aberta.${local_treinamento.frase_dos_avisos(avisos)}`);
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

/** NUVEM: designar ajudante pede a permissão de abrir/editar turma, e ser dono ou superior. */
export const PERMISSAO_DESIGNAR = "turma.criar";

// quem opera a turma (e lê o bloco das regras da máquina); o resto é participante
const PERMISSOES_DE_QUEM_GERENCIA = ["turma.criar", "turma.inscrever", "turma.avaliar", "turma.concluir"];

/**
 * A ficha, com a aba pedida. Serve ao GET e às recusas que precisam devolver a
 * tela com o que foi digitado (o "é a mesma pessoa?" do cadastro de externo):
 * `extras` vai por cima do contexto.
 */
async function _tela_ficha(
  c: Ctx,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  d: { aba?: string; busca?: string; extras?: Record<string, unknown>; status?: number } = {},
): Promise<Response> {
  const tx = c.get("tx");
  vista_turma(turma);
  const hoje = datas_br.hoje();
  // NUVEM (23/10/2026): a regra de dono, decidida UMA vez para a ficha toda
  // (`dono_turma.ts`). O template pergunta `pode_aqui('permissão')` — a
  // permissão do RBAC E o papel na turma — no lugar de `usuario.pode(...)`.
  const direito = await dono_turma.direito_na_turma(tx, usuario, turma);
  const pode_aqui = (permissao: string) => dono_turma.pode_aqui(usuario, direito, permissao);
  // quem só lê o cartaz recebe uma aba só, e as nominais nem são carregadas
  const ve_nominal = PERMISSOES_DAS_ABAS_NOMINAIS.some((p) => usuario.pode(p));
  const abas = ve_nominal ? ABAS : ABAS.slice(0, 1);
  let aba = d.aba ?? "turma";
  if (!abas.some(([chave]) => chave === aba)) aba = "turma";
  const busca = d.busca ?? "";
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
    [modelo_emissao, aviso_modelo],
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
      // NUVEM: os setores promotores e, se a turma já aponta para outra, ela;
      // quem não vê todos os setores só move a turma entre os seus
      setor_promotor.opcoes(
        tx,
        turma.unidade_promotora_id,
        setor_equipe.ve_todos(usuario) ? null : usuario.setores_promotores,
      ),
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
      { ...cert, rotulo: C.rotulo(cert), so_word: servico_emissao.do_modelo_enviado(cert) },
    ]),
  );
  // algum de modelo enviado: o "todos" sai em Word (.zip), não no PDF da casa
  const certificados_em_word = Object.values(certificados).some((cert) => cert.so_word);
  // NUVEM: o último envio por e-mail de cada certificado (aba Emissão)
  const envios =
    aba === "emissao" && pode_aqui("certificado.emitir")
      ? await envio_certificado.ultimo_envio_por_certificado(
          tx,
          Object.values(certificados).map((cert) => cert.id),
        )
      : {};

  // excluir só aparece onde poderia dar certo; os motivos vão na camada
  const impedimentos_exclusao =
    aba === "turma" && pode_aqui("turma.concluir") && ["PLANEJADA", "INSCRICOES_ABERTAS"].includes(turma.situacao)
      ? await servico_turma.impedimentos_da_exclusao(tx, turma)
      : null;

  // o aviso de "sem modelo próprio" é o mesmo para todo inscrito: sai uma vez,
  // no topo da aba, e não repetido em cada linha da tabela
  const avisos_linha: Record<number, string[]> = {};
  for (const [id, v] of Object.entries(aptidao)) avisos_linha[Number(id)] = v.avisos.filter((a) => a !== aviso_modelo);

  // quem não opera a turma vê só o cartaz, a situação e a própria inscrição
  const gerencia = PERMISSOES_DE_QUEM_GERENCIA.some((p) => usuario.pode(p));
  // os ajudantes: a lista para quem é da equipe; os candidatos, só para quem designa
  const [ajudantes, candidatos_ajudante] = await Promise.all([
    gerencia ? dono_turma.ajudantes_da_turma(tx, turma.id) : Promise.resolve([]),
    gerencia && direito.designa && usuario.pode(PERMISSAO_DESIGNAR)
      ? dono_turma.candidatos_a_ajudante(tx, turma)
      : Promise.resolve([]),
  ]);
  const minha_inscricao =
    !gerencia && titular_externo.tem_titular(usuario)
      ? ((await servico_turma.inscricoes_do_titular(tx, usuario)).find((i) => i.turma_id === turma.id) ?? null)
      : null;

  // o link só se gera onde daria certo; com a turma fechada fica só "desligar"
  const link_impedimento =
    turma.inscricao_aberta_ate === null
      ? "Defina antes até quando a turma recebe inscrição (“inscrições até”, em Editar dados da turma)."
      : servico_turma.aberta_a_pedido_proprio(turma, hoje).replace(servico_turma.FALE_COM_A_EQUIPE, "");
  const destinos_possiveis = destinos_de_turma(turma.situacao);
  // NUVEM (24/10/2026): o instrutor sem qualificação que o habilite a este
  // treinamento nas datas da turma — aviso, não bloqueio (`qualificacao_instrutor.ts`).
  // Vale para os vinculados e para os da lista de escolha do "Vincular".
  const avisos_qualificacao = gerencia
    ? await qualificacao_instrutor.avisos_da_turma(tx, turma, [
        ...turma.instrutores.map((v) => v.instrutor),
        ...(instrutores_livres as { id: number; nome: string; servidor: { nome: string } | null }[]),
      ])
    : {};

  return pagina(c, "paginas/turma_ficha.html", usuario, {
    turma,
    hoje,
    gerencia,
    // turma não é tela de EPI: `epi.ficha` não mostra nome aqui (D15)
    nominais_rn19: identificacao.NOMINAIS_FORA_DO_EPI,
    minha_inscricao: minha_inscricao ? vista_inscricao(minha_inscricao) : null,
    minha_situacao: minha_inscricao ? servico_turma.situacao_para_o_titular(minha_inscricao.situacao) : "",
    // o servidor que abre a ficha de uma turma com inscrições abertas pede dali mesmo
    pode_pedir_aqui:
      !gerencia &&
      !minha_inscricao &&
      usuario.pode("turma.inscrever_se") &&
      titular_externo.tem_titular(usuario) &&
      !servico_turma.aberta_a_pedido_proprio(turma, hoje) &&
      vagas_restantes !== 0,
    link_impedimento,
    // a vitrine pública (/cursos): quem publica, o que falta e as listas fixas
    vitrine_pode: vitrine.pode_divulgar(usuario, turma),
    vitrine_pendencias: vitrine.pendencias(turma),
    vitrine_publicos: vitrine.PUBLICOS,
    vitrine_modalidades: vitrine.MODALIDADES,
    vitrine_arte_declaracao: vitrine_arte.DECLARACAO,
    // só contagem: ninguém da equipe vê quem pediu aviso
    vitrine_aviso: {
      aguardando: (await aviso_interesse.contar_para_turma(tx, turma)).aguardando,
      ativo: await aviso_interesse.ativo(tx),
      pode_ligar: usuario.pode("treinamento.gerenciar"),
    },
    aviso_modelo: aba === "emissao" ? aviso_modelo : "",
    avisos_linha,
    impedimentos_exclusao,
    descricao_anterior: (await _ultimas_descricoes(tx, turma.id))[turma.treinamento_id] ?? "",
    // NUVEM (24/10/2026): o seletor de local da edição e os avisos do local
    // (capacidade e choque de sala), que não impedem nada
    locais: aba === "turma" ? await local_treinamento.opcoes(tx, turma.local_id) : [],
    avisos_local: aba === "turma" ? await local_treinamento.avisos_da_turma(tx, turma) : [],
    link_no_ar: inscricao_publica.link_no_ar(turma),
    publico: inscricao_publica.publico_da_turma(turma),
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
    // concluir, só turma que já terminou, de qualquer origem (a guarda é do serviço)
    destinos: destinos_possiveis
      .filter((codigo) => !(codigo === "CONCLUIDA" && turma.data_fim > hoje))
      .map((codigo) => [codigo, ROTULO_TURMA_TELA[codigo]]),
    // e o dia em que o "Concluir" aparece, para a tela dizer por que ele não está lá
    conclui_a_partir:
      destinos_possiveis.includes("CONCLUIDA") && turma.data_fim > hoje && pode_aqui("turma.concluir") ? turma.data_fim : null,
    // o atalho "turma já realizada": datas passadas e nada lançado ainda
    ja_realizada:
      ["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"].includes(turma.situacao) &&
      turma.data_fim <= datas_br.hoje() &&
      pode_aqui("turma.avaliar") &&
      pode_aqui("turma.concluir"),
    lancamento_aberto: turma.situacao === "CONCLUIDA" || servico_presenca.aceita_lancamento(turma),
    permissao_por_destino: servico_turma.PERMISSAO_POR_SITUACAO_TURMA,
    instrutores_livres,
    instrutor_mutavel: await servico_turma.instrutor_mutavel(tx, turma),
    avisos_qualificacao,
    achados,
    servidores_achados,
    busca,
    campi,
    unidades,
    dica_setor_promotor: setor_equipe.ve_todos(usuario) ? setor_promotor.DICA : setor_promotor.DICA_DOS_MEUS,
    // --- aba 3 ---
    dias: servico_presenca.dias_da_turma(turma),
    // a caixa marcada vale a carga do dia; quem chegou atrasado se ajusta à parte
    horas_padrao: Object.fromEntries(servico_presenca.horas_por_dia(turma)),
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
    pode_preencher_turma: campos_certificado.pode_preencher_turma(usuario) && direito.pode(dono_turma.EMISSAO),
    pode_preencher_participante:
      usuario.pode(campos_certificado.PERMISSAO_CAMPO_PARTICIPANTE) && direito.pode(dono_turma.EMISSAO),
    // NUVEM: o dono, o direito de quem lê e os ajudantes (`dono_turma.ts`)
    direito,
    pode_aqui,
    // a aba "Avaliação de reação" (página própria, `rotas/avaliacao_reacao.ts`)
    ve_avaliacao_reacao: avaliacao_reacao.ve_resultado(usuario),
    ajudantes,
    candidatos_ajudante,
    papeis_ajudante: dono_turma.PAPEIS_DE_AJUDANTE,
    ...recados(c),
    ...(d.extras ?? {}),
  }, d.status);
}

rotas.get(`${TURMAS}/:turma_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const turma = await _turma_no_escopo(c.get("tx"), usuario, Number(c.req.param("turma_id")));
  if (!turma) return redirecionar(c, TURMAS);
  return _tela_ficha(c, usuario, turma, { aba: c.req.query("aba") ?? "turma", busca: c.req.query("busca") ?? "" });
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.criar", dono_turma.GERAL);
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
      } as Partial<servico_turma.TurmaRegistro>;
      // a hora e o público só mudam quando o formulário os traz: quem posta
      // a edição sem esses campos (versão antiga da tela, teste) não os apaga
      if (f.tem("hora_inicio")) campos.hora_inicio = texto_ou_nulo(f.texto("hora_inicio"));
      if (f.tem("hora_fim")) campos.hora_fim = texto_ou_nulo(f.texto("hora_fim"));
      if (f.tem("publico_no_formulario")) {
        campos.aceita_comunidade_externa = marcado(f.texto("aceita_comunidade_externa"));
      }
      // o local cadastrado só muda quando o formulário traz o seletor (vazio =
      // "outro local"); sem ele, vale o texto (`servico_turma.editar_turma`)
      if (f.tem("local_id")) campos.local_id = id_opcional(f.texto("local_id"));
      await servico_turma.editar_turma(sp, usuario, turma, campos);
    });
  } catch (erro) {
    if (erro instanceof CampoInvalido || erro instanceof RegraDaTurma) return _erro(c, destino, erro.message);
    throw erro;
  }
  const avisos = await local_treinamento.avisos_da_turma(tx, turma);
  return _volta(c, destino, `Turma atualizada.${local_treinamento.frase_dos_avisos(avisos)}`);
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/situacao`, async (c) => {
  const usuario = await usuarioLogado(c);
  // quem não tem nenhuma das permissões de destino nem chega a mandar o
  // formulário (M84); a específica do destino vem logo depois de lê-lo
  const de_destino = [...new Set(Object.values(servico_turma.PERMISSAO_POR_SITUACAO_TURMA))];
  if (!de_destino.some((p) => usuario.pode(p))) usuario.exigir(de_destino[0]!);
  const tx = c.get("tx");
  const f = await formulario(c);
  // a permissão depende do destino (`PERMISSAO_POR_SITUACAO_TURMA`); destino
  // desconhecido segue para o serviço, que o recusa com a mensagem dele
  // (`Object.hasOwn`, como no serviço: "constructor" não é destino de ninguém)
  const pedido = f.texto("destino");
  if (Object.hasOwn(servico_turma.PERMISSAO_POR_SITUACAO_TURMA, pedido)) {
    usuario.exigir(servico_turma.PERMISSAO_POR_SITUACAO_TURMA[pedido]!);
  }
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(
    tx,
    usuario,
    turma_id,
    // o alcance é o da permissão do destino (D9); `Object.hasOwn` pela mesma
    // razão de acima — "constructor" devolveria a função do protótipo
    Object.hasOwn(servico_turma.PERMISSAO_POR_SITUACAO_TURMA, pedido)
      ? servico_turma.PERMISSAO_POR_SITUACAO_TURMA[pedido]!
      : de_destino,
    dono_turma.GERAL,
  );
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
  const rotulo = ROTULO_TURMA_TELA[turma.situacao]!.toLowerCase();
  return _volta(c, volta, `${turma.codigo}: ${rotulo}.`);
});

/** A turma CONCLUÍDA com dado errado, corrigida com motivo (`retificacao.retificar_turma`). */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/retificar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.concluir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.concluir", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const destino = `${TURMAS}/${turma_id}`;
  let r: retificacao.ResultadoTurma;
  try {
    const data_inicio = _data(f.texto("data_inicio"), "a data de início")!;
    const data_fim = _data(f.texto("data_fim"), "a data de término")!;
    // o período invertido é o erro de digitação, e a frase tem de dizer isso —
    // não "há presença fora do período novo", que é a trava seguinte
    servico_turma.conferir_periodo(data_inicio, data_fim);
    r = await _no_savepoint(c, (sp) =>
      retificacao.retificar_turma(
        sp,
        usuario,
        turma,
        {
          data_inicio,
          data_fim,
          local: texto_ou_nulo(f.texto("local")),
          descricao: texto_ou_nulo(f.texto("descricao")),
          campus_id: id_opcional(f.texto("campus_id")),
          unidade_promotora_id: id_opcional(f.texto("unidade_promotora_id")),
          carga_horaria_horas: _decimal(f.texto("carga_horaria_horas"), "a carga horária"),
          data_base_vencimento: _data(f.texto("data_base_vencimento"), "a data base", false),
          observacoes: texto_ou_nulo(f.texto("observacoes")),
        },
        f.texto("motivo"),
      ),
    );
  } catch (erro) {
    if (erro instanceof CampoInvalido || erro instanceof RegraDaTurma) return _erro(c, destino, erro.message);
    throw erro;
  }
  if (!r.mudou) return _volta(c, destino, "Nada a corrigir: os dados são os mesmos.");
  let frase = `${turma.codigo}: dados corrigidos.`;
  if (r.reapurados) frase += ` O resultado de ${r.reapurados} inscrito(s) mudou com a carga nova.`;
  if (r.em_vigor) {
    return _volta(
      c,
      `${destino}?aba=emissao`,
      frase + ` ${r.em_vigor} certificado(s) em vigor continuam com o dado antigo: use “Reemitir os certificados”.`,
    );
  }
  return _volta(c, destino, frase);
});

/** Anula e reemite todos os certificados em vigor da turma, com os dados de hoje. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/certificados/retificar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.anular");
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "certificado.anular", dono_turma.EMISSAO);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=emissao`;
  let r: retificacao.ResultadoLote;
  try {
    r = await retificacao.retificar_certificados_da_turma(tx, usuario, turma, f.texto("motivo"));
  } catch (erro) {
    if (erro instanceof retificacao.RetificacaoRecusada) return _erro(c, volta, erro.message);
    throw erro;
  }
  let frase = `${r.reemitidos.length} certificado(s) reemitido(s)`;
  if (r.reemitidos.length) frase += `: ${r.reemitidos.map((x) => `${x.antigo} → ${x.novo}`).join(", ")}`;
  frase += ".";
  if (r.travados.length) {
    frase += ` ${r.travados.length} ficaram como estavam: ` + r.travados.map((x) => `${x.certificado} (${x.motivo})`).join("; ");
    return _erro(c, volta, frase);
  }
  return _volta(c, volta, frase);
});

/**
 * Excluir a turma aberta por engano, antes de acontecer (`excluir_turma`). A que
 * já tem história — presença, certificado, pedido do próprio participante —
 * se cancela.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/excluir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.concluir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.concluir", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const codigo = turma.codigo;
  try {
    await _no_savepoint(c, (sp) => servico_turma.excluir_turma(sp, usuario, turma, f.texto("motivo")));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, `${TURMAS}/${turma_id}`, erro.message);
    throw erro;
  }
  return _volta(c, TURMAS, `Turma ${codigo} excluída. O código não volta para a sequência.`);
});

/**
 * NUVEM: "Registrar turma já realizada" — presença de todos pela carga e a
 * turma concluída num clique (com nota mínima, só a presença). As regras são
 * do serviço (`presenca.registrar_turma_realizada`); tudo num savepoint.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/realizada`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  usuario.exigir("turma.concluir");
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.avaliar", dono_turma.GERAL);
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
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  const alvo = id_opcional(f.texto("assinatura_instrutor_id"));
  if (alvo === null) return _erro(c, volta, "Escolha o instrutor.");
  let nome = "";
  let aviso = "";
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
    // a qualificação não bloqueia: o aviso vai junto da confirmação, e fica na ficha
    aviso = (await qualificacao_instrutor.aviso_ao_escalar(tx, turma, instrutor)) ?? "";
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, `${nome} vinculado à turma.` + (aviso ? ` Atenção: ${aviso}` : ""));
});

// =====================================================================
// NUVEM: ajudantes da turma (`dono_turma.ts`) — o dono (ou quem está acima
// dele) designa quem opera a turma, e em quais papéis
// =====================================================================
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/ajudantes`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(PERMISSAO_DESIGNAR);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, PERMISSAO_DESIGNAR, dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  const conta_id = id_opcional(f.texto("usuario_id"));
  if (conta_id === null) return _erro(c, volta, "Escolha a conta do ajudante.");
  try {
    await _no_savepoint(c, (sp) => dono_turma.designar_ajudante(sp, usuario, turma, conta_id, f.todos("papel")));
  } catch (erro) {
    if (erro instanceof dono_turma.AjudanteRecusado) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, "Ajudante designado. Ele opera a turma só nos papéis marcados.");
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/ajudantes/:usuario_id{[0-9]+}/retirar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(PERMISSAO_DESIGNAR);
  const tx = c.get("tx");
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, PERMISSAO_DESIGNAR, dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}`;
  try {
    await _no_savepoint(c, (sp) => dono_turma.retirar_ajudante(sp, usuario, turma, Number(c.req.param("usuario_id"))));
  } catch (erro) {
    if (erro instanceof dono_turma.AjudanteRecusado) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, "Ajudante retirado: a conta volta a só consultar a turma.");
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

/**
 * Depois de criar o externo novo (23/10/2026): o "não é: cadastrar como pessoa
 * nova" grava o par com cada parecido que a tela mostrou; e o parecido que
 * quem cadastrou NÃO pôde ver (RN-19 — a pergunta não foi feita) deixa o
 * cadastro marcado como suspeito, para quem lê nomes conferir.
 */
async function _conferencia_do_externo(
  tx: Executor,
  usuario: UsuarioAtual,
  pessoa: servico_participante.ParticipanteCarregado,
  mostrados: string[],
  confirmou_novo: boolean,
): Promise<void> {
  const achados = await duplicados.procurar(tx, duplicados.alvo_do_cadastro(pessoa), { limite: 50 });
  if (!achados.length) return;
  const ids = new Set(mostrados.map((v) => id_opcional(v)).filter((v): v is number => v !== null));
  if (confirmou_novo) {
    for (const p of duplicados.visiveis(achados, usuario)) {
      if (ids.has(p.pessoa.id)) await duplicados.marcar_distintos(tx, usuario, pessoa.id, p.pessoa.id, "FICHA_TURMA");
    }
  }
  if (achados.some((p) => !servico_participante.pode_identificar(usuario, p.pessoa))) {
    await duplicados.marcar_suspeito(tx, pessoa, usuario);
  }
}

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.inscrever", dono_turma.INSCRICOES);
  if (!turma) return redirecionar(c, TURMAS);
  // inscrito um da lista, a mesma busca volta aberta para o próximo
  const busca = f.texto("busca").trim();
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes${busca ? `&busca=${encodeURIComponent(busca)}` : ""}`;
  const d = Object.fromEntries(
    ["participante_id", "servidor_id", "nome", "vinculo", "email", "organizacao", "matricula_externa", "observacao"].map(
      (k) => [k, f.texto(k)],
    ),
  );
  // Externo novo: antes de criar a segunda linha da mesma pessoa, a pergunta.
  // `confirmar_novo` é a resposta "não, é outra pessoa"; "sim" volta com o
  // `participante_id` do cadastro que já existe.
  const externo_novo = id_opcional(d.participante_id) === null && id_opcional(d.servidor_id) === null && d.nome!.trim();
  // Servidor da base escolhido (23/10/2026): se ele já tem cadastro de EXTERNO
  // parecido (fez curso antes de estar no SIAPE), a pergunta vem antes de criar
  // o ponteiro — era assim que nascia o par externo + servidor. Só para quem
  // lê os nomes (RN-19); "juntar" pede `participante.mesclar`.
  const servidor_escolhido = id_opcional(d.participante_id) === null ? id_opcional(d.servidor_id) : null;
  let juntar_externo: number | null = null;
  let distintos_do_servidor: number[] = [];
  if (servidor_escolhido !== null) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, servidor_escolhido));
    if (servidor) {
      const [ja] = await tx
        .select({ id: e_participante.id })
        .from(e_participante)
        .where(eq(e_participante.servidor_id, servidor.id));
      const externos = duplicados.visiveis(
        await duplicados.procurar(
          tx,
          { nome: servidor.nome, emails: [servidor.email], participante_id: ja?.id ?? null, e_servidor: true },
          { so_externos: true },
        ),
        usuario,
      );
      const ids_mostrados = new Set(externos.map((p) => p.pessoa.id));
      const pedido_juntar = id_opcional(f.texto("juntar_externo_id"));
      if (pedido_juntar !== null && ids_mostrados.has(pedido_juntar) && usuario.pode("participante.mesclar")) {
        juntar_externo = pedido_juntar;
      } else if (f.texto("confirmar_servidor") === "depois") {
        // inscrever o servidor sem decidir: o par fica nos possíveis duplicados
      } else if (f.texto("confirmar_servidor") === "1") {
        distintos_do_servidor = f
          .todos("parecido_id")
          .map((v) => id_opcional(v))
          .filter((v): v is number => v !== null && ids_mostrados.has(v));
      } else if (externos.length) {
        return _tela_ficha(c, usuario, turma, {
          aba: "inscricoes",
          busca,
          extras: {
            servidor_parecidos: duplicados.na_tela(externos, usuario),
            servidor_escolhido: { id: servidor.id, nome: servidor.nome, siape: servidor.siape },
            pode_juntar: usuario.pode("participante.mesclar"),
          },
        });
      }
    }
  }
  if (externo_novo && f.texto("confirmar_novo") !== "1") {
    const parecidos = await servico_participante.parecidos(tx, { nome: d.nome!, email: d.email }, usuario);
    if (parecidos.length) {
      return _tela_ficha(c, usuario, turma, {
        aba: "inscricoes",
        busca,
        extras: {
          parecidos: parecidos.map(vista_participante),
          // o CPF não volta: a recusa nunca ecoa o número (`cpf_certificado.ts`)
          externo_digitado: { ...d, tinha_cpf: Boolean(f.texto(CAMPO_CPF_CERTIFICADO).trim()) },
        },
      });
    }
  }
  let pessoa: servico_participante.ParticipanteCarregado;
  try {
    // CPF opcional, só para o certificado (`cpf_certificado.ts`): conferido
    // ANTES de gravar qualquer coisa, e a recusa não ecoa o número
    const cpf = cpf_certificado.ler_campo(f.texto(CAMPO_CPF_CERTIFICADO));
    // o savepoint é o que impede o pior caso desta rota: o participante externo
    // gravado antes de a inscrição ser recusada
    pessoa = await _no_savepoint(c, async (sp) => {
      const p = await _resolver_participante(sp, usuario, d);
      if (juntar_externo !== null) {
        // "é a mesma pessoa": o externo se junta ao servidor ANTES de inscrever
        await mesclagem.mesclar(
          sp,
          usuario,
          p.id,
          juntar_externo,
          `Mesma pessoa: servidor escolhido da base na ficha de ${turma.codigo}`,
        );
      }
      for (const outro of distintos_do_servidor) {
        await duplicados.marcar_distintos(sp, usuario, p.id, outro, "FICHA_TURMA");
      }
      if (externo_novo) await _conferencia_do_externo(sp, usuario, p, f.todos("parecido_id"), f.texto("confirmar_novo") === "1");
      await servico_turma.inscrever(sp, usuario, turma, p, { observacao: texto_ou_nulo(d.observacao) });
      if (cpf) await cpf_certificado.definir_do_participante(sp, usuario, p, cpf);
      return p;
    });
  } catch (erro) {
    if (
      erro instanceof CampoInvalido ||
      erro instanceof DadosDoParticipante ||
      erro instanceof RegraDaTurma ||
      erro instanceof mesclagem.MesclagemRecusada ||
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
  const contagem = { INSCRITA: 0, JA_INSCRITA: 0, RECUSADA: 0, A_DECIDIR: 0 };
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
    casa_nome: inscricao_lote.casa_nome(usuario),
    erro: d.erro ?? null,
  });
}

rotas.get(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/lote`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const turma = await _turma_para_alterar(c.get("tx"), usuario, Number(c.req.param("turma_id")), "turma.inscrever", dono_turma.INSCRICOES);
  if (!turma) return redirecionar(c, TURMAS);
  return _tela_lote(c, usuario, turma);
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/lote`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.inscrever", dono_turma.INSCRICOES);
  if (!turma) return redirecionar(c, TURMAS);
  const f = await formulario(c);
  const d = { texto: f.texto("lista"), vinculo: f.texto("vinculo"), organizacao: f.texto("organizacao").trim() };
  const gravar = f.texto("acao") === "inscrever";
  // "parece com …": a escolha de cada linha (`escolha_<chave da linha>`), "novo" ou o id
  const escolhas = new Map<string, inscricao_lote.Escolha>();
  for (const [campo, valor] of f.dados.entries()) {
    const m = /^escolha_([0-9a-f]{12})$/.exec(campo);
    if (!m || typeof valor !== "string") continue;
    if (valor === "novo") escolhas.set(m[1]!, "novo");
    else if (/^\d+$/.test(valor)) escolhas.set(m[1]!, Number(valor));
  }
  let desfechos: inscricao_lote.Desfecho[];
  try {
    desfechos = await inscricao_lote.processar(tx, usuario, turma, d.texto, d, !gravar, escolhas);
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _tela_lote(c, usuario, turma, { ...d, erro: erro.message });
    throw erro;
  }
  if (!gravar) return _tela_lote(c, usuario, turma, { ...d, desfechos });
  // gravado: na caixa ficam só as recusadas e as que esperam a escolha, para
  // corrigir (ou decidir) e mandar de novo
  const recusadas = desfechos
    .filter((x) => x.resultado === "RECUSADA" || x.resultado === "A_DECIDIR")
    .map((x) => x.texto);
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
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=inscricoes`;
  let token: string;
  try {
    token = await _no_savepoint(c, (sp) => inscricao_publica.gerar_link(sp, usuario, turma));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _tela_link(c, usuario, turma, token);
});

/** Rever o link no ar (e o QR): só para quem gera, com trilha. Link antigo, sem sal, pede para gerar de novo. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/link-publico/ver`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const token = await inscricao_publica.ver_link(tx, usuario, turma);
  if (token === null) {
    return _erro(
      c,
      `${TURMAS}/${turma.id}?aba=inscricoes`,
      "Este link não pode ser revisto: é de antes da opção de rever, ou não está no ar. Gere um novo.",
    );
  }
  return _tela_link(c, usuario, turma, token);
});

/** O endereço, o QR e a mensagem pronta (na geração e ao rever o link). */
async function _tela_link(c: Ctx, usuario: UsuarioAtual, turma: TurmaCarregada, token: string): Promise<Response> {
  const endereco = `${await servico_emissao.url_base_validacao(c.get("tx"))}${inscricao_publica.CAMINHO}/${token}`;
  const resposta = await pagina(c, "paginas/turma_link.html", usuario, {
    turma: vista_turma(turma),
    publico: inscricao_publica.publico_da_turma(turma),
    endereco,
    qr: `data:image/png;base64,${Buffer.from(qr_png(endereco, 8)).toString("base64")}`,
  });
  resposta.headers.set("cache-control", "no-store");
  return resposta;
}

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/link-publico/desligar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  await inscricao_publica.desligar_link(tx, usuario, turma);
  return _volta(c, `${TURMAS}/${turma.id}?aba=inscricoes`, "Link público desligado: o endereço deixou de funcionar.");
});

/** Publica a turma na vitrine pública (/cursos), ou a retira dela. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/vitrine`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=inscricoes`;
  try {
    await _no_savepoint(c, (sp) =>
      vitrine.configurar(sp, usuario, turma, {
        divulgar: f.texto("divulgar") === "sim",
        titulo: f.texto("titulo_vitrine"),
        modalidade: f.texto("modalidade"),
        publico: f.todos("publico"),
        pre_requisito: f.texto("pre_requisito"),
      }),
    );
  } catch (erro) {
    if (erro instanceof vitrine.VitrineRecusada || erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, turma.divulgar_na_vitrine ? "Turma publicada na vitrine de cursos." : "Dados da vitrine salvos; a turma não está publicada.");
});

/** Liga ou desliga o aviso de interesse da vitrine (vale para todas as turmas). */
rotas.post(`${TURMAS}/vitrine/aviso-interesse`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const f = await formulario(c);
  const ligado = f.texto("ligado") === "sim";
  await _no_savepoint(c, (sp) => aviso_interesse.definir_ativo(sp, usuario, ligado));
  const volta = f.texto("volta").startsWith(`${TURMAS}/`) ? f.texto("volta") : TURMAS;
  return _volta(c, volta, ligado ? "Aviso de interesse da vitrine ligado." : "Aviso de interesse da vitrine desligado.");
});

/**
 * Pedido do titular sobre o aviso de interesse (LGPD art. 18). O e-mail vai por
 * POST, nunca na URL. A equipe confere a identidade fora do sistema; aqui só
 * consulta (contagem por tipo) e apaga.
 */
const TITULAR = `${TURMAS}/vitrine/titular`;

async function _tela_titular(c: Ctx, usuario: UsuarioAtual, extra: Record<string, unknown> = {}) {
  return pagina(c, "paginas/aviso_titular.html", usuario, { caminho: TITULAR, ...extra });
}

rotas.get(TITULAR, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  return _tela_titular(c, usuario);
});

rotas.post(`${TITULAR}/consultar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const f = await formulario(c);
  const email_informado = f.texto("email").trim();
  try {
    const achados = await _no_savepoint(c, (sp) => aviso_interesse.consultar_do_titular(sp, usuario, email_informado));
    return _tela_titular(c, usuario, { email: email_informado, achados });
  } catch (erro) {
    if (!(erro instanceof aviso_interesse.CadastroInvalido)) throw erro;
    return _tela_titular(c, usuario, { email: email_informado, erro: "Informe um e-mail válido." });
  }
});

rotas.post(`${TITULAR}/apagar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.gerenciar");
  const f = await formulario(c);
  const email_informado = f.texto("email").trim();
  try {
    const n = await _no_savepoint(c, (sp) => aviso_interesse.apagar_do_titular(sp, usuario, email_informado));
    return _tela_titular(c, usuario, { apagados: n });
  } catch (erro) {
    if (!(erro instanceof aviso_interesse.CadastroInvalido)) throw erro;
    return _tela_titular(c, usuario, { email: email_informado, erro: "Informe um e-mail válido." });
  }
});

/** Envia a arte da turma para a vitrine (um arquivo por requisição), ou a retira. */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/vitrine/arte`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=inscricoes`;
  const arquivo = f.arquivo("arte");
  if (!arquivo) return _erro(c, volta, "Escolha o arquivo da arte (PNG, JPEG ou WEBP).");
  const conteudo = new Uint8Array(await arquivo.arrayBuffer());
  try {
    await _no_savepoint(c, (sp) =>
      vitrine_arte.enviar(sp, usuario, turma, {
        conteudo,
        nome_original: arquivo.name || "arte",
        alt: f.texto("arte_alt"),
        declaracao: f.texto("declaracao") === "sim",
      }),
    );
  } catch (erro) {
    if (erro instanceof vitrine_arte.ArteRecusada || erro instanceof anexos.AnexoGrandeDemais) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, "Arte gravada. Os metadados da imagem (como a localização) foram removidos.");
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/vitrine/arte/remover`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.criar");
  const tx = c.get("tx");
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.criar", dono_turma.GERAL);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}?aba=inscricoes`;
  try {
    await _no_savepoint(c, (sp) => vitrine_arte.remover(sp, usuario, turma));
  } catch (erro) {
    if (erro instanceof vitrine_arte.ArteRecusada) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, "Arte retirada: a vitrine volta a usar a capa gerada.");
});

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/:inscricao_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  // toda situação que se escolhe aqui pede `turma.inscrever` (PERMISSAO_POR_SITUACAO_INSCRICAO)
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.inscrever", dono_turma.INSCRICOES);
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

rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/:inscricao_id{[0-9]+}/reativar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.concluir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.concluir", dono_turma.INSCRICOES);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes`;
  const inscricao = await servico_turma.carregar_inscricao(tx, Number(c.req.param("inscricao_id")), turma);
  if (!inscricao || inscricao.turma_id !== turma.id) return redirecionar(c, volta);
  try {
    await _no_savepoint(c, (sp) => servico_turma.reativar_inscricao(sp, usuario, inscricao, f.texto("motivo")));
  } catch (erro) {
    if (erro instanceof RegraDaTurma) return _erro(c, volta, erro.message);
    throw erro;
  }
  return _volta(c, volta, `${nome_exibicao(inscricao.participante)}: inscrição reativada.`);
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
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.inscrever", dono_turma.INSCRICOES);
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

/**
 * Corrigir o cadastro do participante externo (nome, vínculo, organização) pela
 * linha da inscrição. Vale para o que ainda vai sair; certificado já emitido
 * se corrige pela ficha dele, que anula e reemite.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/inscricoes/:inscricao_id{[0-9]+}/participante`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.inscrever");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.inscrever", dono_turma.INSCRICOES);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma_id}?aba=inscricoes`;
  const inscricao = await servico_turma.carregar_inscricao(tx, Number(c.req.param("inscricao_id")), turma);
  if (!inscricao || inscricao.turma_id !== turma.id) return redirecionar(c, volta);
  if (inscricao.participante.servidor_id !== null) {
    return _erro(c, volta, "O nome de servidor vem do cadastro de servidores: corrija-o lá.");
  }
  let mudou: string[];
  try {
    mudou = await _no_savepoint(c, (sp) =>
      retificacao.corrigir_participante(sp, usuario, inscricao.participante, {
        nome: f.texto("nome"),
        vinculo: f.texto("vinculo"),
        organizacao: f.texto("organizacao"),
      }),
    );
  } catch (erro) {
    if (erro instanceof retificacao.RetificacaoRecusada) return _erro(c, volta, erro.message);
    throw erro;
  }
  const quem = inscricao.participante.identificador_publico;
  if (!mudou.length) return _volta(c, volta, `${quem}: nada a corrigir.`);
  const emitidos = await tx
    .select({ id: tabela_certificado.id })
    .from(tabela_certificado)
    .where(and(eq(tabela_certificado.participante_id, inscricao.participante_id), eq(tabela_certificado.situacao, "EMITIDO")));
  return _volta(
    c,
    volta,
    `${quem}: ${mudou.join(", ")} corrigido(s).` +
      (emitidos.length
        ? ` ${emitidos.length} certificado(s) já emitido(s) continuam com o dado antigo — use “Corrigir certificado” na ficha de cada um.`
        : ""),
  );
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
    hoje: datas_br.hoje(),
    horas_padrao: Object.fromEntries(servico_presenca.horas_por_dia(turma)),
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
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.avaliar", dono_turma.PRESENCA);
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
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.avaliar", dono_turma.PRESENCA);
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

/**
 * A folha inteira num envio só (`presenca.salvar_folha`): `presente` traz a
 * chave `<inscricao_id>_<dia>` de cada caixa marcada, `h_<chave>` as horas
 * ajustadas, `n_<inscricao_id>` a nota e `apagar_nota` o pedido de apagá-la. O
 * que travar volta escrito, e o resto fica gravado.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/presencas/folha`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "turma.avaliar", dono_turma.PRESENCA);
  if (!turma) return redirecionar(c, TURMAS);
  const volta = `${TURMAS}/${turma.id}${PRESENCAS}`;
  const horas = new Map<string, string>();
  const notas = new Map<number, string | null>();
  try {
    for (const [campo, valor] of f.dados) {
      if (typeof valor !== "string" || !valor.trim()) continue;
      const celula = /^h_(\d+_\d{4}-\d{2}-\d{2})$/.exec(campo);
      if (celula) horas.set(celula[1]!, _decimal(valor, "as horas do dia")!);
      const nota = /^n_(\d+)$/.exec(campo);
      if (nota) notas.set(Number(nota[1]), _decimal(valor, "a nota"));
    }
  } catch (erro) {
    if (erro instanceof CampoInvalido) return _erro(c, volta, erro.message, ANCORA_GRADE);
    throw erro;
  }
  for (const valor of f.todos("apagar_nota")) {
    const id = id_opcional(valor);
    if (id !== null) notas.set(id, null);
  }
  // RN-19: a recusa nomeia a pessoa só para quem pode ler o nome dela
  const quem = (i: InscricaoCarregada) =>
    servico_participante.pode_identificar(usuario, i.participante) ? nome_exibicao(i.participante) : "uma inscrição";
  const r = await servico_presenca.salvar_folha(
    tx,
    usuario,
    turma,
    { marcadas: new Set(f.todos("presente")), horas, notas, motivo: texto_ou_nulo(f.texto("motivo")) },
    quem,
  );
  const feito = [
    r.presencas ? `${r.presencas} presença(s)` : "",
    r.notas ? `${r.notas} nota(s)` : "",
  ].filter(Boolean);
  const frase = feito.length ? `Folha salva: ${feito.join(" e ")} gravada(s).` : "Nada mudou na folha.";
  if (r.recusas.length) {
    return _erro(c, volta, `${feito.length ? frase + " " : ""}Ficaram como estavam — ${r.recusas.join("; ")}.`, ANCORA_GRADE);
  }
  return _volta(c, volta, frase, ANCORA_GRADE);
});

/** Uma COLUNA da grade: todo mundo presente naquele dia (a folha em papel). */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/presencas/dia`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.avaliar", dono_turma.PRESENCA);
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
  usuario.exigir("turma.avaliar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "turma.avaliar", dono_turma.PRESENCA);
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
  const turma = await _turma_para_alterar(tx, usuario, Number(c.req.param("turma_id")), "certificado.emitir", dono_turma.EMISSAO);
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
  const turma = await _turma_para_alterar(tx, usuario, turma_id, "certificado.emitir", dono_turma.EMISSAO);
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
      `Certificado ${C.rotulo(resultado.certificado)} emitido para ` +
        `${nome_exibicao(inscricao.participante)}.${aviso}`,
    );
  }

  const relatorio = await servico_emissao.emitir_lote(tx, usuario, turma);
  // nada emitido é o retorno de uma ação que não aconteceu: sai em vermelho
  if (!relatorio.itens.length) return _erro(c, volta, "Ninguém apto a emitir nesta turma.");
  // o que travou diz por quê (25/10/2026): só os motivos, sem repetir e sem
  // nome — a mensagem vai na URL
  const motivos = [...new Set(relatorio.travados.map((i) => (i.erro ?? "").replace(/^Emissão bloqueada: /, "")).filter(Boolean))];
  const porque = motivos.length ? ` Travou porque ${motivos.slice(0, 2).join("; ")}.` : "";
  return _volta(c, volta, `${turma.codigo}: ${relatorio.resumo}.${porque}`.slice(0, 600));
});

/**
 * NUVEM: os campos de turma que o modelo de certificado declara (ex.: "Local
 * de atuação do brigadista"). Cada campo vem como `v_<marcador>`.
 */
rotas.post(`${TURMAS}/:turma_id{[0-9]+}/campos-certificado`, async (c) => {
  const usuario = await usuarioLogado(c);
  // qualquer uma das duas (`campos_certificado.pode_preencher_turma`)
  if (!campos_certificado.pode_preencher_turma(usuario)) usuario.exigir(campos_certificado.PERMISSOES_CAMPO_TURMA[0]);
  const tx = c.get("tx");
  const f = await formulario(c);
  const turma_id = Number(c.req.param("turma_id"));
  const turma = await _turma_para_alterar(tx, usuario, turma_id, campos_certificado.PERMISSOES_CAMPO_TURMA, dono_turma.EMISSAO);
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
  const turma = await _turma_para_alterar(tx, usuario, turma_id, campos_certificado.PERMISSAO_CAMPO_PARTICIPANTE, dono_turma.EMISSAO);
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
  const turma = await _turma_no_escopo(tx, usuario, turma_id, "certificado.ver");
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
  const turma = await _turma_no_escopo(tx, usuario, turma_id, "certificado.ver");
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
  const turma = await _turma_no_escopo(tx, usuario, Number(c.req.param("turma_id")), "turma.avaliar");
  if (!turma) return redirecionar(c, TURMAS);
  const resultado = await servico_lista.gerar(tx, usuario, turma);
  return baixar(c, resultado.bytes, resultado.arquivo!.split("/").pop()!, servico_lista.TIPO_DOCX);
});
