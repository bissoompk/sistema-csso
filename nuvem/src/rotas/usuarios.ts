/**
 * /usuarios e /perfis — governança de acesso e habilitação técnica.
 * Porte de `app/rotas/usuarios.py`.
 */
import { Hono } from "hono";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import {
  agora_utc,
  atribuicao,
  campus,
  historico_evento,
  perfil as tabela_perfil,
  perfil_nivel_modulo,
  profissional_habilitado,
  usuario_nivel_modulo,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { vigente_em } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as datas_br from "../servicos/datas_br.js";
import * as governanca from "../servicos/governanca.js";
import * as liberacao from "../servicos/liberacao_modulo.js";
import * as niveis_modulo from "../servicos/niveis_modulo.js";
import {
  ESCOPO_AGREGADO,
  ESCOPO_POR_PERFIL,
  ESCOPO_PROPRIO,
  ESCOPO_TOTAL,
  ESCOPO_UNIDADE,
  TEXTO_PERMISSAO,
  PERFIL_ADMINISTRADOR_SISTEMA,
  PERFIL_POR_VINCULO,
  PERFIS_EXTERNOS,
  PERMISSAO_DA_BASE,
  PERMISSOES_DO_TITULAR,
  SO_DO_TECNICO_HABILITADO,
  aceita_nivel_modulo,
  MODULO_LIBERAVEL_AO_TITULAR,
  alcance_da_concessao,
  cobre_inteiro,
  eh_conta_de_governo,
  perfis_vigentes,
  recusa_do_administrador_sistema,
  tem_administrador_sistema,
  type UsuarioAtual,
} from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

type Digitado = Record<string, string | number>;

/**
 * O alcance de cada escopo, escrito para quem concede perfil (D24). A chave é
 * a letra de `ESCOPO_POR_PERFIL`; o texto só aparece na tela.
 */
export const ESCOPO_TELA: Readonly<Record<string, string>> = {
  [ESCOPO_TOTAL]: "total — todos os registros, de todos os campi",
  [ESCOPO_UNIDADE]: "unidade — a coordenadoria, no campus da concessão (ou em todos)",
  [ESCOPO_AGREGADO]: "sem dado — só a administração técnica (conta, senha, auditoria, backup)",
  [ESCOPO_PROPRIO]: "próprio — só o que é do titular",
};

/** O escopo de um perfil por extenso; perfil sem escopo declarado diz isso. */
function _escopo_do_perfil(codigo: string): string {
  const nivel = Object.hasOwn(ESCOPO_POR_PERFIL, codigo) ? ESCOPO_POR_PERFIL[codigo]! : null;
  return nivel && Object.hasOwn(ESCOPO_TELA, nivel) ? ESCOPO_TELA[nivel]! : "sem escopo declarado — nega tudo";
}

type PerfilComPermissoes = typeof tabela_perfil.$inferSelect & { permissoes: Set<string> };

/** Todos os perfis com o conjunto de códigos de cada um: uma leitura só por tela. */
async function _perfis_com_permissoes(tx: Executor): Promise<Map<number, PerfilComPermissoes>> {
  const perfis = await tx.query.perfil.findMany({ with: { perfil_permissoes: { with: { permissao: true } } } });
  return new Map(
    perfis.map(({ perfil_permissoes, ...pf }) => [
      pf.id,
      { ...pf, permissoes: new Set(perfil_permissoes.map((pp) => pp.permissao.codigo)) },
    ]),
  );
}

/**
 * As permissões da concessão que `usuario` NÃO tem — ou tem com alcance menor
 * do que a concessão daria. As do titular dadas por perfil de escopo próprio
 * (o `servidor_consulta`) não contam: valem só sobre o que é do próprio dono,
 * e toda conta ligada a servidor já as tem.
 *
 * "Tem" é pelo alcance dos perfis de quem age (`alcance_da_equipe`), e não
 * por `usuario.pode` (D2, resíduo): o superintendente recortado num campus
 * concedia perfil sem campus, ou o `auditor_interno` (escopo total), porque o
 * CONJUNTO de permissões cabia no dele; e a concessão do titular fazia contar
 * como "tem" o `processo.ver` e o `parecer.ver` do próprio dado.
 */
function _alem_do_que_tem(
  usuario: UsuarioAtual,
  concessoes: { perfil: string; campus_id?: number | null; permissoes: Iterable<string> }[],
): string[] {
  const alem = new Set<string>();
  for (const c of concessoes) {
    const proprio = ESCOPO_POR_PERFIL[c.perfil] === ESCOPO_PROPRIO;
    // perfil sem escopo declarado nega tudo: não alarga nada de ninguém
    const dela = Object.hasOwn(ESCOPO_POR_PERFIL, c.perfil) ? alcance_da_concessao(c.perfil, c.campus_id ?? null) : null;
    for (const p of c.permissoes) {
      if (proprio && PERMISSOES_DO_TITULAR.has(p)) continue;
      // a base derivada não se concede: o que a sustenta (`processo.ver` e o
      // módulo) já entra na comparação pela própria permissão (23/10/2026)
      if (p === PERMISSAO_DA_BASE) continue;
      if (usuario.pode(p) && (dela === null || cobre_inteiro(usuario.alcance_da_equipe(p), dela))) continue;
      alem.add(p);
    }
  }
  return [...alem].sort();
}

/**
 * A trava do perfil do topo sobre UMA conta: se ela tem (vigente ou futuro) o
 * Administrador do sistema, só outro Administrador do sistema mexe nela —
 * senão o superintendente redefinia a senha, inativava ou encerrava o perfil
 * de quem está acima dele. Devolve o motivo, ou `null`.
 */
async function _recusa_sobre_administrador(tx: Executor, usuario: UsuarioAtual, alvo_id: number): Promise<string | null> {
  if (tem_administrador_sistema(usuario.perfis)) return null;
  const { perfis } = await perfis_vigentes(tx, alvo_id, null, { incluir_futuras: true });
  return recusa_do_administrador_sistema(usuario, perfis);
}

function _lista_curta(codigos: string[]): string {
  return codigos.length > 3 ? `${codigos.slice(0, 3).join(", ")} e mais ${codigos.length - 3}` : codigos.join(", ");
}

/**
 * A tela, com os popups de cadastro em branco ou com o digitado.
 * `digitado` traz uma FORMA (`conta`, `perfil`, `habilitacao`, `dados`,
 * `hab-corrigir`, `hab-encerrar`) porque a recusa precisa dizer qual deles
 * reabrir. Não entra na URL. A forma `conta-hab` é a edição da conta ligada a
 * um profissional habilitado: um popup por linha, e `usuario_alvo` diz qual —
 * o mesmo vale para `dados` (a conta) e para as duas formas `hab-*`.
 */
async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  recado: { mensagem?: string | null; erro?: string | null; digitado?: Digitado } = {},
) {
  const tx = c.get("tx");
  const hoje = hoje_iso();
  const agora = agora_utc();
  // As leituras da tela não dependem umas das outras: saem juntas, e na mesma
  // conexão viram uma ida só ao banco (`db/cliente.ts`). Uma atrás da outra,
  // eram onze idas — o grosso dos 2 s que a tela levava.
  const vincula = usuario.pode("perfil.conceder") && usuario.pode("exposicao.ver");
  const administra = usuario.pode("perfil.conceder");
  const [
    usuarios,
    todas,
    perfis_completos,
    ultima_que_concede,
    servidores,
    campi,
    fim_cobertura,
    perfis,
    excecoes,
    setores_da_conta,
    setores,
    habilitados,
  ] = await Promise.all([
    tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome)),
    tx.query.atribuicao.findMany({ with: { perfil: true }, orderBy: [asc(atribuicao.id)] }),
    _perfis_com_permissoes(tx),
    governanca.contas_que_concedem(tx),
    // Nome e SIAPE de todo servidor só vão para a página de quem vincula conta a
    // servidor (`perfil.conceder`) E lê dado nominal (`exposicao.ver`): o
    // `admin_ti` abre esta tela e não lê dado nominal (RN-19). Conceder perfil não
    // traz a leitura nominal por si.
    vincula ? tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)) : Promise.resolve([]),
    tx.select().from(campus).orderBy(asc(campus.sigla)),
    // O sino avisa quem concede; a tela de quem concede avisa também (D17).
    administra ? governanca.fim_da_cobertura(tx, hoje) : Promise.resolve(null),
    tx.select().from(tabela_perfil).orderBy(asc(tabela_perfil.codigo)),
    // Liberação por módulo e setores promotores (22/10/2026): só para quem
    // administra acesso, que é quem grava as duas coisas na gaveta "Gerir"
    administra ? liberacao.excecoes_por_conta(tx) : Promise.resolve(new Map()),
    administra ? liberacao.setores_por_conta(tx) : Promise.resolve(new Map()),
    administra ? liberacao.setores_promotores(tx) : Promise.resolve([]),
    tx.select().from(profissional_habilitado).orderBy(asc(profissional_habilitado.id)),
  ]);
  const atribuicoes: Record<number, typeof todas> = {};
  const vigentes_por_usuario: Record<number, typeof todas> = {};
  for (const u of usuarios) {
    atribuicoes[u.id] = todas.filter((a) => a.usuario_id === u.id);
    vigentes_por_usuario[u.id] = atribuicoes[u.id]!.filter((a) => vigente_em(a, hoje));
  }
  // quem a tela marca como conta de administração (a senha só o superintendente redefine)
  const perfis_de_governo = new Set(
    [...perfis_completos.values()].filter((pf) => pf.ativo && eh_conta_de_governo(pf.permissoes)).map((pf) => pf.id),
  );
  // vigente OU futura (D18): a conta que recebe superintendente com início na
  // semana que vem já é de administração hoje — é a mesma pergunta da trava
  const valem_ou_vao_valer = (u: { id: number }) =>
    atribuicoes[u.id]!.filter((a) => vigente_em(a, hoje) || a.vigencia_inicio > hoje);
  const contas_de_governo = usuarios
    .filter((u) => valem_ou_vao_valer(u).some((a) => perfis_de_governo.has(a.perfil_id)))
    .map((u) => u.id);
  // A recusa de redefinição de cada linha, escrita antes do clique (D4): a
  // mesma regra de `_recusa_de_redefinicao`, com as concessões já lidas.
  const recusa_senha: Record<number, string | null> = {};
  if (usuario.pode("perfil.conceder") || usuario.pode("usuario.resetar_senha")) {
    for (const u of usuarios) {
      // com o campus de cada concessão: a comparação é de alcance (D2/D4)
      const concessoes = valem_ou_vao_valer(u).flatMap((a) => {
        const pf = perfis_completos.get(a.perfil_id);
        return pf && pf.ativo ? [{ perfil: pf.codigo, campus_id: a.campus_id ?? null, permissoes: pf.permissoes }] : [];
      });
      recusa_senha[u.id] = _motivo_de_redefinicao(usuario, u.id, concessoes);
    }
  }
  // "bloqueado até HH:MM" só enquanto vale (D7): o `bloqueado_ate` vencido fica
  // gravado até o próximo login certo, e a etiqueta lia-se como bloqueio eterno
  const bloqueio_ate: Record<number, string> = {};
  for (const u of usuarios) {
    if (u.bloqueado_ate && u.bloqueado_ate > agora) {
      const l = datas_br.local(u.bloqueado_ate)!;
      bloqueio_ate[u.id] = `${String(l.hora).padStart(2, "0")}:${String(l.minuto).padStart(2, "0")}`;
    }
  }
  // A conta que, inativada, deixaria o sistema sem quem conceda perfil: a
  // linha dela não oferece "Inativar" (a rota recusa do mesmo jeito, D66).
  const rotulo_servidor: Record<number, string> = {};
  const sugestao_servidor: Record<number, string> = {};
  for (const s of servidores) rotulo_servidor[s.id] = _rotulo_servidor(s);
  for (const u of usuarios) {
    if (u.servidor_id !== null || !vincula) continue;
    const sugerido = _unico_pelo_email(servidores, usuarios, u.email);
    if (sugerido) sugestao_servidor[u.id] = _rotulo_servidor(sugerido);
  }
  const sigla_campus: Record<number, string> = {};
  for (const cp of campi) sigla_campus[cp.id] = cp.sigla;
  const aviso_cobertura =
    fim_cobertura !== null && fim_cobertura <= somar_dias(hoje, governanca.JANELA_DE_AVISO_DIAS)
      ? governanca.texto_do_aviso(fim_cobertura)
      : null;
  // "Conceder perfil" a partir de Gerir chega com o alvo na URL (D13): o popup
  // abre com a conta escolhida, sem script. Só quem concede, e só conta que
  // pode receber (ativa e não a própria).
  let digitado = recado.digitado ?? {};
  const conceder_a = c.req.method === "GET" ? Number(c.req.query("conceder") ?? "") : NaN;
  if (
    !recado.digitado &&
    usuario.pode("perfil.conceder") &&
    usuarios.some((u) => u.id === conceder_a && u.ativo && u.id !== usuario.id)
  ) {
    digitado = { forma: "perfil", usuario_alvo: conceder_a };
  }
  return pagina(c, "paginas/usuarios.html", usuario, {
    excecoes: Object.fromEntries(excecoes),
    setores_da_conta: Object.fromEntries(setores_da_conta),
    setores,
    modulos_nivelados: niveis_modulo.MODULOS_NIVELADOS,
    rotulo_nivel: niveis_modulo.ROTULO_NIVEL,
    // a conta tem perfil de equipe vigente ou futuro (a exceção vale sobre ele)
    tem_perfil_de_equipe: Object.fromEntries(
      usuarios.map((u) => [
        u.id,
        valem_ou_vao_valer(u).some((a) => {
          const pf = perfis_completos.get(a.perfil_id);
          return !!pf && pf.ativo && aceita_nivel_modulo(pf.codigo);
        }),
      ]),
    ),
    // a conta do servidor sem perfil de equipe: a exceção só libera os próprios
    // processos e o adicional (Processos SEI), que por padrão ela não vê
    titular_liberavel: Object.fromEntries(
      usuarios.map((u) => [
        u.id,
        u.servidor_id !== null &&
          !valem_ou_vao_valer(u).some((a) => PERFIS_EXTERNOS.includes(perfis_completos.get(a.perfil_id)?.codigo ?? "")),
      ]),
    ),
    modulo_liberavel_ao_titular: MODULO_LIBERAVEL_AO_TITULAR,
    usuarios,
    // quem pode RECEBER perfil (D13): ativa e não a própria (D2)
    contas_que_recebem: usuarios.filter((u) => u.ativo && u.id !== usuario.id),
    contas_de_governo,
    recusa_senha,
    bloqueio_ate,
    ultima_que_concede: ultima_que_concede.length === 1 ? ultima_que_concede[0] : null,
    perfis,
    // o select de concessão só oferece perfil ativo, com o escopo ao lado (D23/D24)
    // o Administrador do sistema só aparece para quem também o é (só ele o concede)
    perfis_ativos: perfis
      .filter((p) => p.ativo && (p.codigo !== PERFIL_ADMINISTRADOR_SISTEMA || tem_administrador_sistema(usuario.perfis)))
      .map((p) => ({ ...p, escopo: _escopo_do_perfil(p.codigo) })),
    campi,
    sigla_campus,
    atribuicoes,
    vigentes_por_usuario,
    habilitados,
    servidores,
    rotulo_servidor,
    sugestao_servidor,
    aviso_cobertura,
    hoje,
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
    digitado,
  });
}

type Servidor = typeof tabela_servidor.$inferSelect;
type Conta = typeof tabela_usuario.$inferSelect;

/** "1234567 — Nome": o que o datalist mostra e o que volta no formulário. */
function _rotulo_servidor(s: Pick<Servidor, "siape" | "nome">): string {
  return `${s.siape} — ${s.nome}`;
}

/**
 * O servidor de e-mail igual ao da conta, se for UM só e nenhuma conta o tiver
 * vinculado. É a sugestão de Gerir e o vínculo automático da criação de conta.
 */
function _unico_pelo_email(servidores: Servidor[], contas: Conta[], email: string): Servidor | null {
  const alvo = email.trim().toLowerCase();
  if (!alvo) return null;
  const iguais = servidores.filter((s) => (s.email ?? "").trim().toLowerCase() === alvo);
  if (iguais.length !== 1) return null;
  return contas.some((c) => c.servidor_id === iguais[0]!.id) ? null : iguais[0]!;
}

/**
 * O servidor digitado: "SIAPE — nome" (o datalist), só o SIAPE ou o nome
 * exato. Em branco devolve `servidor: null`; o que não acha volta em `erro`.
 */
async function _resolver_servidor(
  tx: Executor,
  bruto: string,
  conta_id: number | null,
): Promise<{ servidor: Servidor | null; erro?: string }> {
  const texto = bruto.trim();
  if (!texto) return { servidor: null };
  const siape = texto.match(/^(\d{7})(\D|$)/)?.[1];
  const achados = siape
    ? await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, siape))
    : await tx
        .select()
        .from(tabela_servidor)
        .where(sql`lower(${tabela_servidor.nome}) = lower(${texto})`);
  if (achados.length !== 1) {
    return {
      servidor: null,
      erro: achados.length
        ? `há ${achados.length} servidores com o nome '${texto}'; informe o SIAPE.`
        : `servidor não encontrado: '${texto}'. Use o SIAPE ou escolha da lista.`,
    };
  }
  const servidor = achados[0]!;
  // um servidor, uma conta: dois logins no mesmo `servidor_id` abririam a
  // mesma ficha de EPI e os mesmos certificados para duas pessoas
  const [outra] = await tx
    .select()
    .from(tabela_usuario)
    .where(
      and(
        eq(tabela_usuario.servidor_id, servidor.id),
        conta_id === null ? undefined : ne(tabela_usuario.id, conta_id),
      ),
    )
    .limit(1);
  if (outra) return { servidor: null, erro: `${servidor.nome} já está vinculado à conta '${outra.login}'.` };
  return { servidor };
}

/**
 * A conta que já usa este login ou este e-mail, SEM caixa (D12): a entrada
 * compara em minúsculas (`autenticacao.autenticar`), e "Fulano" e "fulano"
 * eram duas contas disputando a mesma credencial. O índice único em
 * `lower(login)`/`lower(email)` (migração 0012) segura a corrida; esta
 * conferência é a que devolve o popup com o digitado.
 */
/**
 * O e-mail é o login (23/10/2026): tem de ser um e-mail, e caber na coluna.
 * Devolve o motivo da recusa, ou `null`.
 */
export function recusa_de_email(email: string): string | null {
  if (email.length > 160) return "o e-mail tem mais de 160 caracteres.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "isto não parece um e-mail (nome@ufvjm.edu.br).";
  return null;
}

export async function _duplicada(
  tx: Executor,
  d: { login: string; email: string },
  fora: number | null = null,
): Promise<{ conta: Conta; qual: "login" | "e-mail" } | null> {
  const [ja] = await tx
    .select()
    .from(tabela_usuario)
    .where(
      and(
        // cruzado também (D12, resíduo): a entrada aceita login OU e-mail no
        // mesmo campo, e o login de uma conta igual ao e-mail de outra era a
        // mesma credencial disputada — a de menor id ganhava, e as falhas de
        // uma bloqueavam a outra
        or(
          sql`lower(${tabela_usuario.login}) = lower(${d.login})`,
          sql`lower(${tabela_usuario.email}) = lower(${d.email})`,
          sql`lower(${tabela_usuario.login}) = lower(${d.email})`,
          sql`lower(${tabela_usuario.email}) = lower(${d.login})`,
        ),
        fora === null ? undefined : ne(tabela_usuario.id, fora),
      ),
    )
    .limit(1);
  if (!ja) return null;
  const login = d.login.toLowerCase();
  return { conta: ja, qual: ja.login.toLowerCase() === login || ja.email.toLowerCase() === login ? "login" : "e-mail" };
}

/**
 * Ato normativo em branco não barra mais a concessão (19/10/2026): ela entra
 * com o ato "pendente", dizendo quem concedeu e quando, e o ato real se
 * escreve depois em Gerir. A autorização continua na trilha — o que saiu foi a
 * tela que não deixava trabalhar enquanto a portaria não era publicada.
 */
export function ato_pendente(usuario: Pick<UsuarioAtual, "login">, hoje: string = hoje_iso()): string {
  return `Pendente — informado por ${usuario.login} em ${datas_br.numerica(hoje)}`;
}

/**
 * Segregação de funções na concessão (D2). Quem concede perfil não concede:
 *
 * - à própria conta — o superintendente que dava a si mesmo `coordenador_csso`
 *   passava a assinar parecer, e `auditor_interno`, a ler tudo;
 * - perfil que dá permissão que ele mesmo não tem: ninguém concede mais do que
 *   tem. Ficam de fora as do ato técnico (`SO_DO_TECNICO_HABILITADO`), que só
 *   valem somadas a habilitação atestada — e a habilitação tem a própria
 *   segregação (D3) —, e as do titular em perfil de escopo próprio.
 *
 * Devolve o motivo, ou `null`.
 */
function _recusa_de_segregacao(
  usuario: UsuarioAtual,
  alvo_id: number | null,
  perfil: PerfilComPermissoes,
  campus_id: number | null,
): string | null {
  if (alvo_id === usuario.id) {
    return "ninguém concede perfil à própria conta: peça a outra pessoa que concede perfil.";
  }
  // o perfil do topo: só quem já o tem o concede (nem o superintendente)
  if (perfil.codigo === PERFIL_ADMINISTRADOR_SISTEMA && !tem_administrador_sistema(usuario.perfis)) {
    return `só quem é ${perfil.nome} concede o perfil ${perfil.nome} — nem o superintendente.`;
  }
  const alem = _alem_do_que_tem(usuario, [{ perfil: perfil.codigo, campus_id, permissoes: perfil.permissoes }]).filter(
    (p) => !SO_DO_TECNICO_HABILITADO.has(p),
  );
  if (alem.length) {
    return (
      `o perfil ${perfil.nome}${campus_id === null ? "" : " neste campus"} dá permissões que você não tem, ` +
      `ou com alcance maior que o seu (${_lista_curta(alem)}), e ninguém concede mais do que tem.`
    );
  }
  return null;
}

/**
 * O campus escolhido no popup: vazio é "todos os campi"; número, um campus que
 * existe. Qualquer outra coisa (forjada ou corrompida) é recusada (D23,
 * resíduo): caía em `null`, e o erro ALARGAVA a concessão em silêncio.
 */
async function _campus_escolhido(
  tx: Executor,
  bruto: string,
): Promise<{ campus_id: number | null; sigla: string } | { erro: string }> {
  const texto = bruto.trim();
  if (!texto) return { campus_id: null, sigla: "todos os campi" };
  if (!/^\d+$/.test(texto)) return { erro: "campus inválido." };
  const [cp] = await tx.select().from(campus).where(eq(campus.id, Number(texto)));
  if (!cp) return { erro: "campus inexistente." };
  return { campus_id: cp.id, sigla: `campus ${cp.sigla}` };
}

interface DadosConcessao {
  campus_id: string;
  vigencia_inicio: string;
  vigencia_fim: string;
  ato_normativo: string;
}

/**
 * Confere e grava a concessão, com o evento. Quem chama já conferiu
 * `perfil.conceder` e tomou a trava de governança. Devolve o motivo da
 * recusa (D2, D23), ou `null` se gravou. A recusa de segregação fica na
 * trilha (`PERFIL_CONCESSAO_RECUSADA`), como a da redefinição de senha.
 */
async function _conceder(
  tx: Executor,
  usuario: UsuarioAtual,
  perfil: PerfilComPermissoes,
  alvo: Conta,
  d: DadosConcessao,
): Promise<string | null> {
  const hoje = hoje_iso();
  if (!perfil.ativo) return `o perfil ${perfil.nome} está inativo e não se concede.`;
  if (!alvo.ativo) return `a conta de ${alvo.nome} está inativa: reative-a antes de conceder perfil.`;
  const escolhido = await _campus_escolhido(tx, d.campus_id);
  if ("erro" in escolhido) return escolhido.erro;
  const { campus_id, sigla } = escolhido;
  const segregacao = _recusa_de_segregacao(usuario, alvo.id, perfil, campus_id);
  if (segregacao) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: "PERFIL_CONCESSAO_RECUSADA",
      descricao: `Concessão do perfil ${perfil.codigo} a '${alvo.login}' recusada: ${segregacao}`,
      usuario,
    });
    return segregacao;
  }
  const inicio = _data_ou(d.vigencia_inicio, hoje)!;
  const fim = _data_ou(d.vigencia_fim, null);
  if (fim !== null && fim < inicio) return "a vigência termina antes de começar.";
  if (fim !== null && fim < hoje) return "a vigência já terminou: uma concessão que nunca vale não se grava.";
  // a mesma concessão (conta, perfil, campus) com vigência que se sobrepõe:
  // duas linhas iguais na tela e duas para encerrar
  const sem_termo = "9999-12-31";
  const repetida = (
    await tx.select().from(atribuicao).where(and(eq(atribuicao.usuario_id, alvo.id), eq(atribuicao.perfil_id, perfil.id)))
  ).find(
    (a) =>
      (a.campus_id ?? null) === campus_id &&
      a.vigencia_inicio <= (fim ?? sem_termo) &&
      (a.vigencia_fim ?? sem_termo) >= inicio,
  );
  if (repetida) {
    return (
      `${alvo.nome} já tem o perfil ${perfil.nome} (${sigla}) de ${datas_br.numerica(repetida.vigencia_inicio)} ` +
      `a ${repetida.vigencia_fim ? datas_br.numerica(repetida.vigencia_fim) : "sem termo"}. Encerre aquela concessão antes.`
    );
  }
  const ato = d.ato_normativo.trim() || ato_pendente(usuario);
  const [nova] = await tx
    .insert(atribuicao)
    .values({
      usuario_id: alvo.id,
      perfil_id: perfil.id,
      campus_id,
      vigencia_inicio: inicio,
      vigencia_fim: fim,
      ato_normativo: ato,
      concedido_por: usuario.id,
    })
    .returning();
  // D27: a quem, onde e até quando. O texto dos eventos antigos não muda.
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: nova!.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao:
      `Perfil ${perfil.codigo} concedido a '${alvo.login}' (${sigla}; vigência ${datas_br.numerica(inicio)} ` +
      `a ${fim ? datas_br.numerica(fim) : "sem termo"}) — ato: ${ato}`,
    usuario,
  });
  if (perfil.permissoes.has("perfil.conceder")) await governanca.sincronizar_aviso_de_cobertura(tx, hoje);
  return null;
}

/**
 * Inativar é tirar a conta do sistema (e derrubar as sessões dela). As travas
 * são as da redefinição de senha e do encerramento de perfil, pelos mesmos
 * motivos (D66):
 *
 * - a própria conta não se inativa — quem faz isso se tranca fora;
 * - conta de administração (`eh_conta_de_governo`) só por quem concede perfil:
 *   sem a trava, o `admin_ti` desligava o superintendente;
 * - a última conta ativa que concede perfil não se inativa: ninguém mais
 *   criaria conta nem concederia acesso, e o sistema só voltaria por SQL.
 *
 * Reativar passa pela segunda trava também (reabrir conta de administração é
 * ato de governo); as outras duas não se aplicam. Devolve o motivo, ou `null`.
 */
async function _recusa_de_inativacao(
  tx: Executor,
  usuario: UsuarioAtual,
  alvo: { id: number; ativo: boolean },
): Promise<string | null> {
  if (alvo.ativo && alvo.id === usuario.id) {
    return "a própria conta não se inativa — peça a outra pessoa que administra o sistema.";
  }
  const do_topo = await _recusa_sobre_administrador(tx, usuario, alvo.id);
  if (do_topo) return do_topo;
  // a trava de governo olha também a concessão futura (D18): sem isso, o
  // `admin_ti` inativava hoje a conta que vira superintendente na semana que vem
  const { permissoes: vigentes_ou_futuras } = await perfis_vigentes(tx, alvo.id, null, { incluir_futuras: true });
  if (!usuario.pode("perfil.conceder") && eh_conta_de_governo(vigentes_ou_futuras)) {
    return "é conta de administração; só quem concede perfil (o superintendente) a inativa ou reativa.";
  }
  // a última que concede é a que concede HOJE: a futura ainda não segura o sistema
  const { permissoes } = await perfis_vigentes(tx, alvo.id);
  if (
    alvo.ativo &&
    permissoes.has("perfil.conceder") &&
    !(await governanca.contas_que_concedem(tx, { sem_conta: alvo.id })).length
  ) {
    return (
      "é a última conta ativa que concede perfil, e sem ela ninguém mais cria conta nem concede acesso. " +
      "Conceda esse perfil a outra conta antes."
    );
  }
  return null;
}

/**
 * Redefinir é passar a conhecer a senha da conta. Sem trava, o `admin_ti` —
 * que pela matriz não vê conteúdo técnico — tomava a conta do superintendente
 * e via tudo, ou a de outro `admin_ti` e apagava o rastro de quem fez o quê
 * (revisão de segurança, 25/09/2026). A regra:
 *
 * - a própria senha não se redefine: troca-se em /trocar-senha, sabendo a atual;
 * - quem concede perfil redefine as demais;
 * - conta de administração (`eh_conta_de_governo`) só por quem concede perfil —
 *   contando a concessão com início futuro (D18): redefinida hoje, a conta
 *   chegaria ao dia do início com `perfil.conceder` e a senha de quem redefiniu;
 * - as outras, por quem tem `usuario.resetar_senha` E tem tudo o que a conta
 *   tem (D4). Era "qualquer conta que não seja de governo": o `admin_ti`
 *   redefinia a do médico, entrava com a provisória, fazia ele mesmo a troca
 *   obrigatória e passava a ler exposição nominal e assinar parecer.
 *
 * A conta comum (só as permissões do titular, ou nenhum perfil) continua
 * redefinível pelo `admin_ti` — é ele quem atende a senha esquecida. O que
 * segura esse caso é a troca obrigatória (o dono percebe na próxima entrada)
 * e o evento `SENHA_RESETADA` na trilha. Devolve o motivo da recusa, ou `null`.
 */
function _motivo_de_redefinicao(
  usuario: UsuarioAtual,
  alvo_id: number,
  concessoes: { perfil: string; permissoes: Iterable<string> }[],
): string | null {
  if (alvo_id === usuario.id) return "a própria senha se troca em Trocar senha, informando a atual.";
  const do_topo = recusa_do_administrador_sistema(usuario, concessoes.map((c) => c.perfil));
  if (do_topo) return do_topo;
  if (usuario.pode("perfil.conceder")) return null;
  if (eh_conta_de_governo(concessoes.flatMap((c) => [...c.permissoes]))) {
    return "é conta de administração; só quem concede perfil (o superintendente) redefine.";
  }
  if (!usuario.pode("usuario.resetar_senha")) return "falta a permissão usuario.resetar_senha.";
  const alem = _alem_do_que_tem(usuario, concessoes);
  if (alem.length) {
    return (
      `a conta tem permissões que você não tem (${_lista_curta(alem)}); ` +
      "só quem concede perfil (o superintendente) a redefine."
    );
  }
  return null;
}

async function _recusa_de_redefinicao(tx: Executor, usuario: UsuarioAtual, alvo_id: number): Promise<string | null> {
  if (alvo_id === usuario.id) return _motivo_de_redefinicao(usuario, alvo_id, []);
  const { concessoes } = await perfis_vigentes(tx, alvo_id, null, { incluir_futuras: true });
  return _motivo_de_redefinicao(usuario, alvo_id, concessoes);
}

/** A tela com a senha provisória no recado — e sem cache (`no-store`). */
async function _senha_na_tela(c: Ctx, usuario: UsuarioAtual, mensagem: string): Promise<Response> {
  const r = await _tela_lista(c, usuario, { mensagem });
  r.headers.set("cache-control", "no-store");
  return r;
}

/** Campo obrigatório ausente: o 422 do `Form(...)` do FastAPI. */
function exigidos(f: Formulario, ...nomes: string[]): void {
  const faltando = nomes.filter((n) => typeof f.dados.get(n) !== "string");
  if (faltando.length) throw new ErroHttp(422, `Campo obrigatório ausente: ${faltando.join(", ")}`);
}

function _data_ou(bruto: string, padrao: string | null): string | null {
  if (!bruto) return padrao;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) throw new ErroHttp(422, `Data inválida: ${bruto}`);
  return bruto;
}

rotas.get("/usuarios", async (c) => {
  const usuario = await usuarioLogado(c);
  if (!(usuario.pode("usuario.criar_conta") || usuario.pode("perfil.conceder"))) usuario.exigir("usuario.criar_conta");
  return _tela_lista(c, usuario, { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null });
});

/**
 * Concede o perfil que o vínculo da conta decide (servidor, terceirizado ou
 * discente). É regra do cadastro, e não escolha de quem cria: por isso não passa
 * pela segregação de `_conceder` (quem só cria conta também a aplica). O ato diz
 * de onde veio.
 */
async function _conceder_do_vinculo(
  tx: Executor,
  usuario: UsuarioAtual,
  conta: { id: number; login: string },
  vinculo: string,
  codigo: string,
): Promise<void> {
  const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.codigo, codigo));
  if (!perfil || !perfil.ativo) throw new Error(`perfil '${codigo}' ausente ou inativo: o banco não foi semeado`);
  await tx.insert(atribuicao).values({
    usuario_id: conta.id,
    perfil_id: perfil.id,
    vigencia_inicio: hoje_iso(),
    ato_normativo: `Vínculo informado no cadastro da conta (${vinculo.toLowerCase()})`,
    concedido_por: usuario.id,
  });
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: conta.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao: `Perfil ${codigo} concedido a '${conta.login}' pelo vínculo informado no cadastro (${vinculo.toLowerCase()}).`,
    usuario,
  });
}

rotas.post("/usuarios", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const f = await formulario(c);
  exigidos(f, "nome", "email");
  const tx = c.get("tx");
  // O login é o e-mail cadastrado, aparado e em minúsculas (23/10/2026): o
  // formulário não tem mais o campo, e um `login` que ainda venha é ignorado.
  const email = f.texto("email").trim();
  const limpos = { login: autenticacao.login_do_email(email), nome: f.texto("nome").trim(), email };
  // Perfil e servidor são opcionais e entram na MESMA transação: conta criada
  // num passo e perfil concedido noutro era conta que nascia sem abrir nada.
  const perfil_id = f.inteiro("perfil_id");
  const extras = {
    campus_id: f.texto("campus_id"),
    ato_normativo: f.texto("ato_normativo"),
    servidor: f.texto("servidor").trim(),
  };
  // O vínculo decide o perfil (23/10/2026): servidor → `servidor_consulta`,
  // terceirizado → `terceirizado`, discente → `discente`. Em branco é conta de
  // equipe, e o perfil é o escolhido (ou nenhum).
  const vinculo = f.texto("vinculo").trim();
  const digitado: Digitado = { forma: "conta", ...limpos, ...extras, perfil_id: perfil_id ?? "", vinculo };
  if (!limpos.nome || !limpos.email) {
    return _tela_lista(c, usuario, { erro: "Nome e e-mail não ficam em branco.", digitado });
  }
  const invalido = recusa_de_email(limpos.email);
  if (invalido) return _tela_lista(c, usuario, { erro: `Conta não criada: ${invalido}`, digitado });
  // Login e e-mail são UNIQUE no banco (sem caixa, D12): sem esta conferência
  // a duplicata subia como erro de integridade e levava junto o que foi digitado.
  const ja = await _duplicada(tx, limpos);
  if (ja) {
    return _tela_lista(c, usuario, {
      erro: `Conta não criada: o e-mail ${limpos.email} já é o login da conta de ${ja.conta.nome}. Cada conta entra com um e-mail próprio.`,
      digitado,
    });
  }
  if (vinculo && !Object.hasOwn(PERFIL_POR_VINCULO, vinculo)) {
    return _tela_lista(c, usuario, { erro: "Conta não criada: escolha o vínculo na lista.", digitado });
  }
  const externo = vinculo === "TERCEIRIZADO" || vinculo === "DISCENTE";
  // terceirizado e discente não são servidores: a conta deles nunca se liga a
  // um (é o vínculo com servidor que traz o pedido de EPI)
  if (externo && extras.servidor) {
    return _tela_lista(c, usuario, {
      erro: `Conta não criada: ${vinculo === "TERCEIRIZADO" ? "terceirizado" : "discente"} não se vincula a servidor. Deixe o campo Servidor em branco.`,
      digitado,
    });
  }
  // conceder perfil e vincular a servidor são atos de governo, como em Gerir
  const governa = usuario.pode("perfil.conceder");
  if (vinculo === "SERVIDOR" && !governa) {
    return _tela_lista(c, usuario, {
      erro:
        "Conta não criada: a conta de servidor nasce sozinha quando o servidor ativo com e-mail institucional é " +
        "cadastrado em Servidores. Vincular uma conta a servidor aqui pede a permissão perfil.conceder.",
      digitado,
    });
  }
  if (!governa && (perfil_id !== null || extras.servidor)) {
    return _tela_lista(c, usuario, {
      erro: "Perfil e servidor pedem a permissão perfil.conceder: crie a conta sem eles.",
      digitado,
    });
  }
  let perfil: PerfilComPermissoes | undefined;
  if (perfil_id !== null) {
    perfil = (await _perfis_com_permissoes(tx)).get(perfil_id);
    if (!perfil) throw new ErroHttp(422, "perfil inexistente");
    // a conta é nova (não é a de quem cria); a segregação que sobra é a do
    // "mais do que tem" e o perfil inativo — conferidos antes de a conta existir
    const escolhido = await _campus_escolhido(tx, extras.campus_id);
    const recusa = !perfil.ativo
      ? `o perfil ${perfil.nome} está inativo e não se concede.`
      : "erro" in escolhido
        ? escolhido.erro
        : _recusa_de_segregacao(usuario, null, perfil, escolhido.campus_id);
    if (recusa) return _tela_lista(c, usuario, { erro: `Conta não criada: ${recusa}`, digitado });
    await governanca.travar(tx);
  }
  let servidor: Servidor | null = null;
  let pelo_email = false;
  if (extras.servidor) {
    const achado = await _resolver_servidor(tx, extras.servidor, null);
    if (achado.erro) return _tela_lista(c, usuario, { erro: `Conta não criada: ${achado.erro}`, digitado });
    servidor = achado.servidor;
  } else if (governa && !externo) {
    // em branco, o e-mail decide: servidor com o mesmo e-mail, se for um só
    const mesmo_email = await tx
      .select()
      .from(tabela_servidor)
      .where(sql`lower(${tabela_servidor.email}) = lower(${limpos.email})`);
    const vinculadas = mesmo_email.length === 1
      ? await tx.select().from(tabela_usuario).where(eq(tabela_usuario.servidor_id, mesmo_email[0]!.id))
      : [];
    servidor = _unico_pelo_email(mesmo_email, vinculadas, limpos.email);
    pelo_email = servidor !== null;
  }
  if (vinculo === "SERVIDOR" && !servidor) {
    return _tela_lista(c, usuario, {
      erro:
        "Conta não criada: o vínculo servidor pede o servidor do cadastro. Informe o SIAPE no campo Servidor " +
        "(ou cadastre a pessoa em Servidores, com o e-mail institucional: a conta nasce sozinha).",
      digitado,
    });
  }
  const provisoria = autenticacao.senha_provisoria();
  const [novo] = await tx
    .insert(tabela_usuario)
    .values({
      ...limpos,
      servidor_id: servidor?.id ?? null,
      senha_hash: await autenticacao.gerar_hash(provisoria),
      precisa_trocar_senha: true,
    })
    .returning();
  // o login APARADO, o que foi gravado (D27); os eventos antigos ficam como estão
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: novo!.id,
    tipo_evento: "USUARIO_CRIADO",
    descricao: `Conta '${novo!.login}' criada.`,
    usuario,
  });
  if (servidor) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: novo!.id,
      tipo_evento: "SERVIDOR_VINCULADO",
      descricao: `Conta '${novo!.login}' vinculada ao servidor ${servidor.siape}${pelo_email ? " (pelo e-mail)" : ""}.`,
      campo: "servidor_id",
      valor_anterior: null,
      valor_novo: servidor.id,
      usuario,
    });
  }
  if (perfil) {
    const recusa = await _conceder(tx, usuario, perfil, novo!, { vigencia_inicio: "", vigencia_fim: "", ...extras });
    // o campus e a segregação já foram conferidos antes de a conta existir
    if (recusa) throw new ErroHttp(422, recusa);
  }
  // o perfil do vínculo é regra, não escolha: entra sem a segregação do "mais
  // do que tem" (o perfil do titular é o menor que existe), e não repete o
  // escolhido acima
  const perfil_do_vinculo = vinculo ? PERFIL_POR_VINCULO[vinculo]! : null;
  if (perfil_do_vinculo && perfil?.codigo !== perfil_do_vinculo) {
    await _conceder_do_vinculo(tx, usuario, novo!, vinculo, perfil_do_vinculo);
  }
  const detalhes = [
    perfil_do_vinculo ? `vínculo ${vinculo.toLowerCase()}, perfil ${perfil_do_vinculo}` : null,
    perfil ? `perfil ${perfil.codigo}` : null,
    servidor ? `vinculada a ${servidor.nome}${pelo_email ? " pelo e-mail" : ""}` : null,
  ].filter(Boolean);
  // A conta criada sem perfil não abre nada: quem a criou sem poder conceder
  // precisa saber que o próximo passo é de outra pessoa.
  const sem_perfil =
    perfil || perfil_do_vinculo ? "" : " Ela ainda não abre nada: o perfil é concedido por quem concede perfil.";
  // A senha provisória sai no CORPO, nunca na URL: no `?mensagem=` ela ficava
  // no histórico do navegador e em qualquer registro de acesso do caminho.
  return _senha_na_tela(
    c,
    usuario,
    `Conta criada${detalhes.length ? ` (${detalhes.join("; ")})` : ""}.${sem_perfil} ` +
      `A pessoa entra com o e-mail ${novo!.email}. Senha provisória: ${provisoria}`,
  );
});

/**
 * Corrige nome e e-mail da conta (D11). O e-mail é a credencial de entrada e a
 * base do vínculo automático com o servidor; o login É o e-mail (23/10/2026):
 * mudou o e-mail, o login acompanha, e o formulário não tem mais o campo. Se o
 * e-mail não muda, o login fica como está (a conta de teste segue com o nome de
 * usuário antigo). Por isso:
 *
 * - conta de administração (vigente ou futura) só por quem concede perfil;
 * - login e e-mail de OUTRA conta só por quem poderia redefinir a senha dela
 *   (`_recusa_de_redefinicao`): trocar a credencial é o mesmo poder;
 * - a duplicidade se confere sem caixa (D12).
 *
 * Cada campo mudado é um evento `USUARIO_ALTERADO`, com antes e depois.
 */
rotas.post("/usuarios/:id{[0-9]+}/dados", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const f = await formulario(c);
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (!alvo) return redirecionar(c, "/usuarios");
  const email = f.texto("email").trim();
  const novos = {
    nome: f.texto("nome").trim(),
    login: email === alvo.email ? alvo.login : autenticacao.login_do_email(email),
    email,
  };
  const digitado: Digitado = { forma: "dados", usuario_alvo: alvo.id, ...novos };
  const recusar = (motivo: string) =>
    _tela_lista(c, usuario, { erro: `Os dados de ${alvo.nome} não foram alterados: ${motivo}`, digitado });
  if (!novos.nome || !novos.email) return recusar("nome e e-mail não ficam em branco.");
  const invalido = recusa_de_email(novos.email);
  if (invalido) return recusar(invalido);
  const proprio = alvo.id === usuario.id;
  const do_topo = proprio ? null : await _recusa_sobre_administrador(tx, usuario, alvo.id);
  if (do_topo) return recusar(do_topo);
  if (!proprio && !usuario.pode("perfil.conceder")) {
    const { permissoes } = await perfis_vigentes(tx, alvo.id, null, { incluir_futuras: true });
    if (eh_conta_de_governo(permissoes)) {
      return recusar("é conta de administração; só quem concede perfil (o superintendente) a altera.");
    }
  }
  const credencial = novos.login !== alvo.login || novos.email.toLowerCase() !== alvo.email.toLowerCase();
  if (credencial && !proprio) {
    const recusa = await _recusa_de_redefinicao(tx, usuario, alvo.id);
    if (recusa) return recusar(`o e-mail é o login da conta, e ${recusa}`);
  }
  const ja = await _duplicada(tx, novos, alvo.id);
  if (ja) return recusar(`o e-mail ${novos.email} já é o login da conta de ${ja.conta.nome}. Cada conta entra com um e-mail próprio.`);
  const mudou = (["nome", "login", "email"] as const).filter((campo) => novos[campo] !== alvo[campo]);
  if (!mudou.length) return redirecionar(c, comMensagem("/usuarios", "Nada mudou."));
  await tx.update(tabela_usuario).set(novos).where(eq(tabela_usuario.id, alvo.id));
  for (const campo of mudou) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: "USUARIO_ALTERADO",
      descricao: `Conta '${alvo.login}': ${campo} alterado.`,
      campo,
      valor_anterior: alvo[campo],
      valor_novo: novos[campo],
      usuario,
    });
  }
  return redirecionar(c, comMensagem("/usuarios", `Dados da conta de ${novos.nome} atualizados.`));
});

/**
 * Vincula a conta ao servidor (em branco, desvincula). É o `servidor_id` que dá
 * o escopo PRÓPRIO: "minha ficha de EPI", "meus certificados". Ato de governo
 * (`perfil.conceder`): quem vincula a própria conta a outro servidor passa a
 * ler o que é dele.
 */
rotas.post("/usuarios/:id{[0-9]+}/servidor", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (!alvo) return redirecionar(c, "/usuarios");
  const do_topo = await _recusa_sobre_administrador(tx, usuario, alvo.id);
  if (do_topo) return _tela_lista(c, usuario, { erro: `${alvo.nome}: ${do_topo}` });
  const achado = await _resolver_servidor(tx, f.texto("servidor"), alvo.id);
  if (achado.erro) return _tela_lista(c, usuario, { erro: `${alvo.nome}: ${achado.erro}` });
  const novo_id = achado.servidor?.id ?? null;
  if (novo_id !== null) {
    const { perfis: do_alvo } = await perfis_vigentes(tx, alvo.id, null, { incluir_futuras: true });
    if (do_alvo.some((p) => PERFIS_EXTERNOS.includes(p))) {
      return _tela_lista(c, usuario, {
        erro: `${alvo.nome}: conta de terceirizado ou discente não se vincula a servidor. Encerre antes esse perfil, se a pessoa virou servidora.`,
      });
    }
  }
  if (novo_id === alvo.servidor_id) return redirecionar(c, comMensagem("/usuarios", "Nada mudou."));
  await tx.update(tabela_usuario).set({ servidor_id: novo_id }).where(eq(tabela_usuario.id, alvo.id));
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: novo_id === null ? "SERVIDOR_DESVINCULADO" : "SERVIDOR_VINCULADO",
    descricao: achado.servidor
      ? `Conta '${alvo.login}' vinculada ao servidor ${achado.servidor.siape}.`
      : `Conta '${alvo.login}' desvinculada do servidor.`,
    campo: "servidor_id",
    valor_anterior: alvo.servidor_id,
    valor_novo: novo_id,
    usuario,
  });
  return redirecionar(
    c,
    comMensagem(
      "/usuarios",
      achado.servidor ? `${alvo.nome} vinculada a ${achado.servidor.nome}.` : `${alvo.nome} sem servidor vinculado.`,
    ),
  );
});

rotas.post("/usuarios/:id{[0-9]+}/senha", async (c) => {
  const usuario = await usuarioLogado(c);
  if (!usuario.pode("perfil.conceder")) usuario.exigir("usuario.resetar_senha");
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (!alvo) return redirecionar(c, "/usuarios");
  const recusa = await _recusa_de_redefinicao(tx, usuario, alvo.id);
  if (recusa) {
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: "SENHA_RESET_RECUSADO",
      descricao: `Redefinição da senha de '${alvo.login}' recusada: ${recusa}`,
      usuario,
    });
    return _tela_lista(c, usuario, { erro: `A senha de ${alvo.nome} não foi redefinida: ${recusa}` });
  }
  const provisoria = autenticacao.senha_provisoria();
  await tx
    .update(tabela_usuario)
    .set({
      senha_hash: await autenticacao.gerar_hash(provisoria),
      precisa_trocar_senha: true,
      tentativas_falhas: 0,
      bloqueado_ate: null,
    })
    .where(eq(tabela_usuario.id, alvo.id));
  await autenticacao.revogar_do_usuario(tx, alvo.id);
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: "SENHA_RESETADA",
    descricao: `Senha de '${alvo.login}' redefinida e sessões revogadas.`,
    usuario,
  });
  return _senha_na_tela(c, usuario, `Nova senha provisória de ${alvo.login}: ${provisoria}. A pessoa entra com o e-mail ${alvo.email}.`);
});

/**
 * Desbloqueia a conta presa pelas tentativas falhas (D7), sem trocar a senha:
 * quem esqueceu a senha usa "Resetar senha"; quem só errou cinco vezes não
 * precisa perder a que tem.
 *
 * Não revela a senha, mas tem a trava de quem redefine (`_recusa_de_redefinicao`):
 * o bloqueio é o que limita a adivinhação da senha de UMA conta. Se o
 * `admin_ti` desbloqueasse a do superintendente ou a do médico logo depois de
 * cada bloqueio, ele adivinharia, sem limite além do teto por IP, a senha
 * justamente das contas que ele não pode redefinir (D4/D18).
 */
rotas.post("/usuarios/:id{[0-9]+}/desbloquear", async (c) => {
  const usuario = await usuarioLogado(c);
  if (!usuario.pode("perfil.conceder")) usuario.exigir("usuario.resetar_senha");
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (!alvo) return redirecionar(c, "/usuarios");
  if (!alvo.bloqueado_ate || alvo.bloqueado_ate <= agora_utc()) {
    return redirecionar(c, comMensagem("/usuarios", `A conta de ${alvo.nome} não está bloqueada.`));
  }
  const recusa =
    alvo.id === usuario.id
      ? "a própria conta não se desbloqueia: espere o bloqueio vencer, ou peça a outra pessoa."
      : await _recusa_de_redefinicao(tx, usuario, alvo.id);
  if (recusa) return _tela_lista(c, usuario, { erro: `A conta de ${alvo.nome} não foi desbloqueada: ${recusa}` });
  await tx
    .update(tabela_usuario)
    .set({ tentativas_falhas: 0, bloqueado_ate: null })
    .where(eq(tabela_usuario.id, alvo.id));
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: alvo.id,
    tipo_evento: "CONTA_DESBLOQUEADA",
    descricao: `Conta '${alvo.login}' desbloqueada (as tentativas falhas voltaram a zero).`,
    campo: "bloqueado_ate",
    valor_anterior: alvo.bloqueado_ate.toISOString(),
    valor_novo: null,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", `Conta de ${alvo.nome} desbloqueada.`));
});

rotas.post("/usuarios/:id{[0-9]+}/inativar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const tx = c.get("tx");
  // D17: duas inativações ao mesmo tempo passavam as duas pela trava da última
  await governanca.travar(tx);
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (alvo) {
    const recusa = await _recusa_de_inativacao(tx, usuario, alvo);
    if (recusa) {
      const ato = alvo.ativo ? "inativada" : "reativada";
      return _tela_lista(c, usuario, { erro: `A conta de ${alvo.nome} não foi ${ato}: ${recusa}` });
    }
    const ativo = !alvo.ativo;
    await tx.update(tabela_usuario).set({ ativo }).where(eq(tabela_usuario.id, alvo.id));
    if (!ativo) await autenticacao.revogar_do_usuario(tx, alvo.id);
    await auditoria.registrar(tx, {
      entidade: "usuario",
      entidade_id: alvo.id,
      tipo_evento: ativo ? "USUARIO_ATIVADO" : "USUARIO_INATIVADO",
      descricao: `Conta '${alvo.login}' ${ativo ? "ativada" : "inativada"}.`,
      usuario,
    });
    await governanca.sincronizar_aviso_de_cobertura(tx);
    return redirecionar(c, comMensagem("/usuarios", `Conta de ${alvo.nome} ${ativo ? "reativada" : "inativada"}.`));
  }
  return redirecionar(c, "/usuarios");
});

rotas.post("/usuarios/:id{[0-9]+}/atribuicoes", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  exigidos(f, "perfil_id");
  const tx = c.get("tx");
  // O formulário posta em `/usuarios/0/atribuicoes` e diz o alvo em
  // `usuario_alvo`: resolver no servidor vale com e sem JavaScript.
  let usuario_id = Number(c.req.param("id"));
  const usuario_alvo = f.texto("usuario_alvo");
  if (usuario_id === 0 && /^\d+$/.test(usuario_alvo)) usuario_id = Number(usuario_alvo);
  const perfil_id = f.inteiro("perfil_id");
  if (perfil_id === null) throw new ErroHttp(422, "perfil_id inválido");
  const dados: DadosConcessao = {
    campus_id: f.texto("campus_id"),
    vigencia_inicio: f.texto("vigencia_inicio"),
    vigencia_fim: f.texto("vigencia_fim"),
    ato_normativo: f.texto("ato_normativo"),
  };
  const digitado: Digitado = { forma: "perfil", usuario_alvo: usuario_id, perfil_id, ...dados };
  // D17: a concessão entra na mesma fila do encerramento e da inativação
  await governanca.travar(tx);
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario_id));
  if (!alvo) return _tela_lista(c, usuario, { erro: "Escolha a conta que vai receber o perfil.", digitado });
  const perfil = (await _perfis_com_permissoes(tx)).get(perfil_id);
  if (!perfil) throw new ErroHttp(422, "perfil inexistente");
  const recusa = await _conceder(tx, usuario, perfil, alvo, dados);
  if (recusa) return _tela_lista(c, usuario, { erro: `Perfil não concedido: ${recusa}`, digitado });
  const pendente = !dados.ato_normativo.trim();
  let mensagem = pendente ? "Perfil concedido, com o ato normativo pendente." : "Perfil concedido.";
  // concessão de quem concede com fim marcado: diz já se a cobertura vai acabar
  if (perfil.permissoes.has("perfil.conceder") && dados.vigencia_fim) {
    const fim = await governanca.fim_da_cobertura(tx);
    if (fim !== null) mensagem += ` Atenção: ${governanca.texto_do_aviso(fim)}`;
  }
  return redirecionar(c, comMensagem("/usuarios", mensagem));
});

/**
 * Encerra a concessão. `vigencia_fim` vira ONTEM, e não hoje: a vigência é
 * inclusiva (`vigente_em`), e encerrar com fim hoje deixaria o perfil valendo
 * até a meia-noite. Nada se apaga — a linha fica, com o fim, para a trilha.
 *
 * A concessão que ainda nem começou não se "encerra" (D23): o fim de ontem
 * ficava antes do início. Ela se CANCELA — o fim vira a véspera do início, o
 * intervalo vazio que diz "nunca valeu", com o evento `PERFIL_CANCELADO`.
 */
rotas.post("/usuarios/atribuicoes/:id{[0-9]+}/encerrar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const tx = c.get("tx");
  // D17: dois encerramentos ao mesmo tempo passavam os dois pela trava da última
  await governanca.travar(tx);
  const a = await tx.query.atribuicao.findFirst({
    where: eq(atribuicao.id, Number(c.req.param("id"))),
    with: { usuario: true, perfil: { with: { perfil_permissoes: { with: { permissao: true } } } } },
  });
  if (!a) return redirecionar(c, "/usuarios");
  const hoje = hoje_iso();
  if (a.vigencia_inicio > hoje) {
    const vespera = somar_dias(a.vigencia_inicio, -1);
    await tx.update(atribuicao).set({ vigencia_fim: vespera }).where(eq(atribuicao.id, a.id));
    await auditoria.registrar(tx, {
      entidade: "atribuicao",
      entidade_id: a.id,
      tipo_evento: "PERFIL_CANCELADO",
      descricao: `Concessão futura do perfil ${a.perfil.codigo} a '${a.usuario.login}' cancelada antes do início.`,
      campo: "vigencia_fim",
      valor_anterior: a.vigencia_fim,
      valor_novo: vespera,
      usuario,
    });
    await governanca.sincronizar_aviso_de_cobertura(tx, hoje);
    return redirecionar(
      c,
      comMensagem("/usuarios", `Concessão futura do perfil ${a.perfil.codigo} de ${a.usuario.nome} cancelada.`),
    );
  }
  const fim = somar_dias(hoje, -1);
  if (a.vigencia_fim !== null && a.vigencia_fim <= fim) {
    return redirecionar(c, comMensagem("/usuarios", "Esta concessão já estava encerrada."));
  }
  if (a.perfil.codigo === PERFIL_ADMINISTRADOR_SISTEMA && !tem_administrador_sistema(usuario.perfis)) {
    return _tela_lista(c, usuario, {
      erro:
        `O perfil ${a.perfil.nome} de ${a.usuario.nome} não foi encerrado: só outro ${a.perfil.nome} ` +
        "encerra esse perfil — nem o superintendente.",
    });
  }
  const concede = a.perfil.perfil_permissoes.some((pp) => pp.permissao.codigo === "perfil.conceder");
  if (concede && !(await governanca.contas_que_concedem(tx, { sem_atribuicao: a.id })).length) {
    return _tela_lista(c, usuario, {
      erro:
        `O perfil ${a.perfil.codigo} de ${a.usuario.nome} não foi encerrado: é a última concessão vigente ` +
        "de quem concede perfil, e sem ela ninguém mais cria conta nem concede acesso. Conceda-o a outra conta antes.",
    });
  }
  await tx.update(atribuicao).set({ vigencia_fim: fim }).where(eq(atribuicao.id, a.id));
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: a.id,
    tipo_evento: "PERFIL_ENCERRADO",
    descricao: `Perfil ${a.perfil.codigo} de '${a.usuario.login}' encerrado.`,
    campo: "vigencia_fim",
    valor_anterior: a.vigencia_fim,
    valor_novo: fim,
    usuario,
  });
  if (concede) await governanca.sincronizar_aviso_de_cobertura(tx, hoje);
  return redirecionar(c, comMensagem("/usuarios", `Perfil ${a.perfil.codigo} de ${a.usuario.nome} encerrado.`));
});

/** Corrige o ato normativo da concessão: o "Pendente" e o "BOOTSTRAP" viram o ato real. */
rotas.post("/usuarios/atribuicoes/:id{[0-9]+}/ato", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  const tx = c.get("tx");
  const a = await tx.query.atribuicao.findFirst({
    where: eq(atribuicao.id, Number(c.req.param("id"))),
    with: { usuario: true, perfil: true },
  });
  if (!a) return redirecionar(c, "/usuarios");
  const ato = f.texto("ato_normativo").trim();
  if (!ato) return _tela_lista(c, usuario, { erro: "Informe o ato normativo que autoriza o perfil." });
  if (ato === a.ato_normativo) return redirecionar(c, comMensagem("/usuarios", "Nada mudou."));
  await tx.update(atribuicao).set({ ato_normativo: ato }).where(eq(atribuicao.id, a.id));
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: a.id,
    tipo_evento: "ATO_NORMATIVO_ALTERADO",
    descricao: `Ato normativo do perfil ${a.perfil.codigo} de '${a.usuario.login}' alterado.`,
    campo: "ato_normativo",
    valor_anterior: a.ato_normativo,
    valor_novo: ato,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", "Ato normativo atualizado."));
});

/**
 * Segregação e consistência do vínculo entre habilitação e conta (D3, D25).
 * Quem atesta habilitação NÃO:
 *
 * - liga habilitação à própria conta — junto com a autoconcessão (D2), uma
 *   pessoa só passava a assinar parecer e laudo, contornando a RN-01;
 * - atesta o próprio SIAPE (a habilitação sem conta, ligada depois).
 *
 * - liga habilitação a conta cuja senha ele já conheceu: criada por ele
 *   (`USUARIO_CRIADO`) ou redefinida por ele (`SENHA_RESETADA`). Era a
 *   conta-fantoche (D3, resíduo): o superintendente criava uma conta nova com
 *   perfil de coordenador, via a senha provisória na tela, atestava uma
 *   habilitação sem SIAPE ligada a ela, entrava como ela, fazia a troca
 *   obrigatória e assinava parecer e laudo — sozinho.
 *
 * E a conta escolhida tem de existir, estar ativa, não ter outra habilitação
 * vigente, já ter sido assumida pelo dono (sem senha provisória) e, na
 * habilitação interna, estar vinculada ao servidor do SIAPE da habilitação —
 * que passa a ser obrigatório. Só a habilitação externa (art. 10, §5º, com a
 * justificativa registrada) se liga a conta sem servidor; se as duas pontas
 * dizem o SIAPE, ele tem de bater. Devolve o motivo, ou `null`.
 * `habilitacao_id` é a linha que se edita (fica fora da conferência de "outra
 * habilitação").
 */
async function _recusa_de_vinculo_habilitacao(
  tx: Executor,
  usuario: UsuarioAtual,
  d: { conta_id: number | null; siape: string | null; habilitacao_id: number | null; externo: boolean },
): Promise<string | null> {
  if (d.siape && usuario.servidor_id !== null) {
    const [meu] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, usuario.servidor_id));
    if (meu?.siape === d.siape) return "quem atesta habilitação não atesta a própria: peça a outra pessoa que atesta.";
  }
  if (d.conta_id === null) return null;
  if (d.conta_id === usuario.id) {
    return "quem atesta habilitação não a liga à própria conta: peça a outra pessoa que atesta.";
  }
  const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, d.conta_id));
  if (!conta) return "Conta não encontrada.";
  if (!conta.ativo) return `a conta de ${conta.nome} está inativa.`;
  const hoje = hoje_iso();
  const outra = (
    await tx.select().from(profissional_habilitado).where(eq(profissional_habilitado.usuario_id, conta.id))
  ).find((h) => h.id !== d.habilitacao_id && (vigente_em(h, hoje) || h.vigencia_inicio > hoje));
  if (outra) return `a conta de ${conta.nome} já está ligada à habilitação de ${outra.nome}.`;
  const conheceu = await tx
    .select({ id: historico_evento.id })
    .from(historico_evento)
    .where(
      and(
        eq(historico_evento.entidade, "usuario"),
        eq(historico_evento.entidade_id, conta.id),
        eq(historico_evento.usuario_id, usuario.id),
        inArray(historico_evento.tipo_evento, ["USUARIO_CRIADO", "SENHA_RESETADA"]),
      ),
    )
    .limit(1);
  if (conheceu.length) {
    return (
      `quem atesta habilitação não a liga a conta que ele criou ou cuja senha redefiniu (${conta.login}): ` +
      "peça a outra pessoa que atesta."
    );
  }
  if (conta.precisa_trocar_senha) {
    return `a conta de ${conta.nome} ainda está com a senha provisória: o dono precisa entrar e trocá-la antes.`;
  }
  if (!d.externo) {
    if (!d.siape) return "a habilitação interna se liga a uma conta pelo SIAPE do profissional: informe o SIAPE.";
    if (conta.servidor_id === null) {
      return `a conta de ${conta.nome} não está vinculada a servidor: vincule-a ao servidor do SIAPE ${d.siape} antes.`;
    }
  }
  if (d.siape && conta.servidor_id !== null) {
    const [dela] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, conta.servidor_id));
    if (dela && dela.siape !== d.siape) {
      return `o SIAPE da habilitação (${d.siape}) não é o do servidor vinculado à conta de ${conta.nome}.`;
    }
  }
  return null;
}

/** Recusa de segregação vai para a trilha, como a da senha e a do perfil. */
async function _registrar_recusa_habilitacao(
  tx: Executor,
  usuario: UsuarioAtual,
  entidade_id: number | null,
  descricao: string,
): Promise<void> {
  await auditoria.registrar(tx, {
    entidade: entidade_id === null ? "usuario" : "profissional_habilitado",
    entidade_id: entidade_id ?? usuario.id,
    tipo_evento: "HABILITACAO_RECUSADA",
    descricao,
    usuario,
  });
}

function _de_segregacao(motivo: string): boolean {
  return motivo.startsWith("quem atesta");
}

/** A habilitação confere, não o cargo (IN 15/2022, art. 10, §2º, I). */
/**
 * Liga (ou desliga) o profissional habilitado a uma conta do sistema. Sem o
 * vínculo, quem tem a habilitação não consegue emitir nem assinar parecer em
 * nome dela (`rbac.pode_subscrever` procura a habilitação pela conta) — e a
 * habilitação semeada nasce sem conta.
 */
rotas.post("/habilitacoes/:id{[0-9]+}/conta", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("habilitacao.atestar");
  const f = await formulario(c);
  const tx = c.get("tx");
  const id = Number(c.req.param("id"));
  const [habilitado] = await tx.select().from(profissional_habilitado).where(eq(profissional_habilitado.id, id));
  if (!habilitado) return redirecionar(c, "/usuarios");
  const bruto = f.texto("usuario_id").trim();
  // Vazio desliga a conta; qualquer outra coisa que não seja número é recusada
  // como conta inexistente, e não lida como "desligar".
  const conta_id = bruto === "" ? null : /^\d+$/.test(bruto) ? Number(bruto) : 0;
  if (habilitado.usuario_id === conta_id) return redirecionar(c, "/usuarios");
  let conta: { id: number; nome: string } | undefined;
  if (conta_id !== null) {
    const recusa = await _recusa_de_vinculo_habilitacao(tx, usuario, {
      conta_id,
      siape: habilitado.siape,
      habilitacao_id: habilitado.id,
      externo: habilitado.externo,
    });
    // Volta com o popup DESTA linha aberto e a conta que se escolheu, e não
    // com a faixa no topo da lista: a recusa é do formulário de edição.
    if (recusa) {
      if (_de_segregacao(recusa)) {
        await _registrar_recusa_habilitacao(
          tx,
          usuario,
          id,
          `Vínculo de ${habilitado.nome} à conta ${conta_id} recusado: ${recusa}`,
        );
      }
      return _tela_lista(c, usuario, {
        erro: recusa.charAt(0).toUpperCase() + recusa.slice(1),
        digitado: { forma: "conta-hab", usuario_alvo: id, usuario_id: bruto },
      });
    }
    [conta] = await tx
      .select({ id: tabela_usuario.id, nome: tabela_usuario.nome })
      .from(tabela_usuario)
      .where(eq(tabela_usuario.id, conta_id));
  }
  await tx
    .update(profissional_habilitado)
    .set({ usuario_id: conta?.id ?? null })
    .where(eq(profissional_habilitado.id, id));
  await auditoria.registrar(tx, {
    entidade: "profissional_habilitado",
    entidade_id: id,
    tipo_evento: conta ? "HABILITACAO_VINCULADA" : "HABILITACAO_DESVINCULADA",
    descricao: conta
      ? `${habilitado.nome} (${habilitado.titulo_assinatura}) ligado à conta ${conta.nome}.`
      : `${habilitado.nome} (${habilitado.titulo_assinatura}) desligado da conta.`,
    campo: "usuario_id",
    valor_anterior: habilitado.usuario_id === null ? null : String(habilitado.usuario_id),
    valor_novo: conta ? String(conta.id) : null,
    usuario,
  });
  return redirecionar(
    c,
    comMensagem("/usuarios", conta ? `${habilitado.nome} ligado à conta ${conta.nome}.` : "Habilitação desligada da conta."),
  );
});

/**
 * Corrige título, conselho e registro da habilitação (D10) — o que sai na
 * assinatura do parecer. Cada campo mudado é um `HABILITACAO_CORRIGIDA`, com
 * antes e depois. Quem atesta não corrige a própria (a mesma segregação de D3).
 */
rotas.post("/habilitacoes/:id{[0-9]+}/corrigir", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("habilitacao.atestar");
  const f = await formulario(c);
  const tx = c.get("tx");
  const id = Number(c.req.param("id"));
  const [h] = await tx.select().from(profissional_habilitado).where(eq(profissional_habilitado.id, id));
  if (!h) return redirecionar(c, "/usuarios");
  const novos = {
    titulo_assinatura: f.texto("titulo_assinatura").trim(),
    conselho: f.texto("conselho").trim() || null,
    registro_conselho: f.texto("registro_conselho").trim() || null,
  };
  const digitado: Digitado = {
    forma: "hab-corrigir",
    usuario_alvo: id,
    titulo_assinatura: novos.titulo_assinatura,
    conselho: novos.conselho ?? "",
    registro_conselho: novos.registro_conselho ?? "",
  };
  const recusar = (erro: string) => _tela_lista(c, usuario, { erro, digitado });
  if (!novos.titulo_assinatura) return recusar("O título na assinatura não fica em branco.");
  if (novos.titulo_assinatura.length > 60) return recusar("O título na assinatura tem no máximo 60 caracteres.");
  if ((novos.conselho ?? "").length > 8) return recusar("O conselho tem no máximo 8 caracteres (a sigla: CREA, CRM, CAU).");
  if ((novos.registro_conselho ?? "").length > 30) return recusar("O registro tem no máximo 30 caracteres.");
  if (h.usuario_id === usuario.id) {
    return recusar("Quem atesta habilitação não corrige a própria: peça a outra pessoa que atesta.");
  }
  const mudou = (["titulo_assinatura", "conselho", "registro_conselho"] as const).filter((k) => novos[k] !== h[k]);
  if (!mudou.length) return redirecionar(c, comMensagem("/usuarios", "Nada mudou."));
  await tx.update(profissional_habilitado).set(novos).where(eq(profissional_habilitado.id, id));
  for (const campo of mudou) {
    await auditoria.registrar(tx, {
      entidade: "profissional_habilitado",
      entidade_id: id,
      tipo_evento: "HABILITACAO_CORRIGIDA",
      descricao: `Habilitação de ${h.nome}: ${campo} corrigido.`,
      campo,
      valor_anterior: h[campo],
      valor_novo: novos[campo],
      usuario,
    });
  }
  return redirecionar(c, comMensagem("/usuarios", `Habilitação de ${h.nome} corrigida.`));
});

/**
 * Encerra a habilitação (D10): a aposentadoria, a saída da UFVJM, a
 * especialização que deixou de valer. O fim padrão é ONTEM, pelo mesmo motivo
 * do perfil (vigência inclusiva); pode-se informar outra data, desde que não
 * antes da véspera do início. Depois do fim ela some da escolha de signatário
 * (`pode_subscrever` e a lista de pareceres olham a vigência). Nada se apaga.
 */
rotas.post("/habilitacoes/:id{[0-9]+}/encerrar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("habilitacao.atestar");
  const f = await formulario(c);
  const tx = c.get("tx");
  const id = Number(c.req.param("id"));
  const [h] = await tx.select().from(profissional_habilitado).where(eq(profissional_habilitado.id, id));
  if (!h) return redirecionar(c, "/usuarios");
  const bruto = f.texto("vigencia_fim");
  const digitado: Digitado = { forma: "hab-encerrar", usuario_alvo: id, vigencia_fim: bruto };
  const vespera = somar_dias(h.vigencia_inicio, -1);
  const ontem = somar_dias(hoje_iso(), -1);
  const fim = _data_ou(bruto, ontem < vespera ? vespera : ontem)!;
  if (fim < vespera) {
    return _tela_lista(c, usuario, {
      erro: `O fim não pode ser antes de ${datas_br.numerica(h.vigencia_inicio)}, o início da habilitação.`,
      digitado,
    });
  }
  if (h.vigencia_fim !== null && h.vigencia_fim <= fim) {
    return redirecionar(c, comMensagem("/usuarios", "Esta habilitação já estava encerrada."));
  }
  await tx.update(profissional_habilitado).set({ vigencia_fim: fim }).where(eq(profissional_habilitado.id, id));
  await auditoria.registrar(tx, {
    entidade: "profissional_habilitado",
    entidade_id: id,
    tipo_evento: "HABILITACAO_ENCERRADA",
    descricao: `Habilitação de ${h.nome} (${h.titulo_assinatura}) encerrada em ${datas_br.numerica(fim)}.`,
    campo: "vigencia_fim",
    valor_anterior: h.vigencia_fim,
    valor_novo: fim,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", `Habilitação de ${h.nome} encerrada.`));
});

rotas.post("/habilitacoes", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("habilitacao.atestar");
  const f = await formulario(c);
  exigidos(f, "nome", "habilitacao", "titulo_assinatura");
  const tx = c.get("tx");
  const campos = [
    "nome",
    "siape",
    "habilitacao",
    "titulo_assinatura",
    "usuario_alvo_id",
    "conselho",
    "registro_conselho",
    "vigencia_inicio",
    "externo",
    "justificativa_art10_par5",
  ];
  const v = Object.fromEntries(campos.map((k) => [k, f.texto(k)])) as Record<string, string>;
  const e_externo = v.externo === "1";
  // `erro`, e não `mensagem`: a habilitação NÃO foi registrada. E a recusa
  // devolve os onze campos, que o "voltar" do navegador não devolve.
  const recusar = (erro: string) => _tela_lista(c, usuario, { erro, digitado: { forma: "habilitacao", ...v } });
  if (e_externo && !v.justificativa_art10_par5!.trim()) {
    return recusar("Habilitação externa exige justificativa do art. 10, §5º.");
  }
  // o vocabulário do banco conferido aqui (D25): era o erro cru do Postgres
  if (!["ENG_SEG_TRABALHO", "MED_TRABALHO", "ARQ_SEG_TRABALHO"].includes(v.habilitacao!)) {
    return recusar("Habilitação desconhecida.");
  }
  const siape = v.siape!.trim() || null;
  if (siape !== null && !/^\d{7}$/.test(siape)) return recusar("O SIAPE tem sete dígitos.");
  const bruto_conta = v.usuario_alvo_id!.trim();
  const conta_id = bruto_conta === "" ? null : /^\d+$/.test(bruto_conta) ? Number(bruto_conta) : 0;
  const recusa = await _recusa_de_vinculo_habilitacao(tx, usuario, {
    conta_id,
    siape,
    habilitacao_id: null,
    externo: e_externo,
  });
  if (recusa) {
    if (_de_segregacao(recusa)) {
      await _registrar_recusa_habilitacao(tx, usuario, null, `Atestação de ${v.nome!.trim()} recusada: ${recusa}`);
    }
    return recusar(recusa.charAt(0).toUpperCase() + recusa.slice(1));
  }
  const [habilitado] = await tx
    .insert(profissional_habilitado)
    .values({
      nome: v.nome!.trim(),
      siape,
      habilitacao: v.habilitacao!,
      titulo_assinatura: v.titulo_assinatura!.trim(),
      conselho: v.conselho || null,
      registro_conselho: v.registro_conselho || null,
      externo: e_externo,
      justificativa_art10_par5: v.justificativa_art10_par5!.trim() || null,
      usuario_id: conta_id,
      vigencia_inicio: _data_ou(v.vigencia_inicio!, hoje_iso())!,
      atestado_por: usuario.id,
      atestado_em: agora_utc(),
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "profissional_habilitado",
    entidade_id: habilitado!.id,
    tipo_evento: e_externo ? auditoria.HABILITACAO_EXTERNA_ATESTADA : "HABILITACAO_ATESTADA",
    descricao: `${v.nome!.trim()} — ${v.habilitacao} (${v.titulo_assinatura!.trim()}).`,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", "Habilitação registrada."));
});

/**
 * A matriz abre para quem opera (`processo.ver`) e para quem governa acesso
 * (D24): o `admin_ti` cria conta, e a matriz é o que diz o que a conta vai
 * abrir — o link estava em /usuarios e dava 403 justamente para ele.
 */
/**
 * O contexto COMUM das duas telas de perfil (23/10/2026): o cálculo é o de
 * `liberacao.perfis_com_niveis`, o texto de cada permissão é o mesmo
 * dicionário e o "Do titular" é o mesmo conjunto. A Matriz só lê; o Acesso
 * por módulo edita. `testes/matriz_harmonia.test.ts` compara as duas.
 */
async function _contexto_dos_perfis(tx: Executor, usuario: UsuarioAtual) {
  const perfis = (await liberacao.perfis_com_niveis(tx, usuario)).map((p) => ({
    ...p,
    escopo_texto: _escopo_do_perfil(p.codigo),
  }));
  return {
    perfis,
    pode_ajustar: usuario.pode("perfil.conceder"),
    rotulo_nivel: niveis_modulo.ROTULO_NIVEL,
    textos_permissao: TEXTO_PERMISSAO,
    titular: [...PERMISSOES_DO_TITULAR].sort(),
  };
}

/**
 * A matriz abre para quem opera (`processo.ver`) e para quem governa acesso
 * (D24): o `admin_ti` cria conta, e a matriz é o que diz o que a conta vai
 * abrir — o link estava em /usuarios e dava 403 justamente para ele.
 */
rotas.get("/perfis", async (c) => {
  const usuario = await usuarioLogado(c);
  // `processo.ver` de EQUIPE: a do titular (D16) não abre a matriz de perfis
  if (!(usuario.pode("usuario.criar_conta") || usuario.pode("perfil.conceder"))) usuario.exigir_na_equipe("processo.ver");
  return pagina(c, "paginas/perfis.html", usuario, await _contexto_dos_perfis(c.get("tx"), usuario));
});

// =====================================================================
// Liberação por módulo (22/10/2026)
// =====================================================================
/** O valor do formulário para "linha ausente": padrão do perfil / seguir o perfil. */
const PADRAO_FORM = "PADRAO";

function _nivel_do_form(bruto: string): niveis_modulo.Nivel | null | undefined {
  if (bruto === PADRAO_FORM) return null;
  return niveis_modulo.eh_nivel(bruto) ? bruto : undefined;
}

/**
 * A tabela módulo × nível de UM perfil (o da `?perfil=`, ou o primeiro que se
 * ajusta). Abre para quem abre a matriz; só quem administra acesso grava.
 */
async function _tela_niveis(
  c: Ctx,
  usuario: UsuarioAtual,
  recado: { mensagem?: string | null; erro?: string | null; perfil?: string | null } = {},
) {
  const tx = c.get("tx");
  const contexto = await _contexto_dos_perfis(tx, usuario);
  // as abas são os perfis ATIVOS, na ordem da Matriz; o que não se ajusta
  // aparece também (só leitura, com a nota): as duas telas listam o mesmo
  const ativos = contexto.perfis.filter((p) => p.ativo);
  const pedido = recado.perfil ?? c.req.query("perfil") ?? "";
  const atual = ativos.find((p) => p.codigo === pedido) ?? ativos.find((p) => p.aceita) ?? ativos[0] ?? null;
  return pagina(c, "paginas/perfis_niveis.html", usuario, {
    ...contexto,
    perfis: ativos,
    atual,
    so_do_perfil: niveis_modulo.PERMISSOES_SO_DO_PERFIL,
    // não `modulos`: é o nome da navegação da casca
    modulos_nivelados: niveis_modulo.MODULOS_NIVELADOS,
    mensagem: recado.mensagem ?? c.req.query("mensagem") ?? null,
    erro: recado.erro ?? null,
  });
}

function _exigir_matriz(usuario: UsuarioAtual): void {
  // a mesma porta de /perfis
  if (!(usuario.pode("usuario.criar_conta") || usuario.pode("perfil.conceder"))) usuario.exigir_na_equipe("processo.ver");
}

rotas.get("/perfis/niveis", async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir_matriz(usuario);
  return _tela_niveis(c, usuario);
});

/**
 * Grava o nível de cada módulo de um perfil. Tudo ou nada: a recusa de um
 * módulo (subir o próprio perfil, dar o que não tem) desfaz os outros, e a
 * tela volta dizendo qual.
 */
rotas.post("/perfis/:id{[0-9]+}/niveis", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  const tx = c.get("tx");
  const [pf] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.id, Number(c.req.param("id"))));
  if (!pf) throw new ErroHttp(404, "perfil inexistente");
  let recusa: string | null = null;
  let mudou = 0;
  try {
    await tx.transaction(async (sp) => {
      for (const m of niveis_modulo.MODULOS_NIVELADOS) {
        if (!f.tem(`nivel_${m.codigo}`)) continue;
        const nivel = _nivel_do_form(f.texto(`nivel_${m.codigo}`));
        if (nivel === undefined) throw new ErroHttp(422, `nível inválido para ${m.codigo}`);
        const antes = await sp.select().from(perfil_nivel_modulo).where(and(eq(perfil_nivel_modulo.perfil_id, pf.id), eq(perfil_nivel_modulo.modulo, m.codigo)));
        if ((antes[0]?.nivel ?? null) === nivel) continue;
        const r = await liberacao.alterar_nivel_perfil(sp as Executor, usuario, pf.id, m.codigo, nivel);
        if (r) {
          recusa = `${m.nome}: ${r}`;
          throw new _Desfazer();
        }
        mudou += 1;
      }
    });
  } catch (erro) {
    if (!(erro instanceof _Desfazer)) throw erro;
  }
  if (recusa) return _tela_niveis(c, usuario, { erro: `Nada foi gravado. ${recusa}`, perfil: pf.codigo });
  const msg = mudou ? `Níveis do perfil ${pf.nome} gravados.` : "Nada mudou.";
  return redirecionar(c, comMensagem(`/perfis/niveis?perfil=${encodeURIComponent(pf.codigo)}`, msg));
});

/** Desfaz o ponto de salvamento sem ser erro de verdade. */
class _Desfazer extends Error {}

/** A exceção da conta em cada módulo: dá ou retira, por cima do perfil. */
rotas.post("/usuarios/:id{[0-9]+}/niveis", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  const tx = c.get("tx");
  const alvo_id = Number(c.req.param("id"));
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, alvo_id));
  if (!alvo) throw new ErroHttp(404, "conta inexistente");
  if (alvo.id === usuario.id) {
    return _tela_lista(c, usuario, {
      erro: "Ninguém altera o acesso da própria conta: peça a outra pessoa que administra acesso.",
    });
  }
  const do_topo = await _recusa_sobre_administrador(tx, usuario, alvo.id);
  if (do_topo) return _tela_lista(c, usuario, { erro: `Acesso de ${alvo.nome} não alterado: ${do_topo}` });
  let recusa: string | null = null;
  let mudou = 0;
  try {
    await tx.transaction(async (sp) => {
      const atuais = niveis_modulo.niveis_de(
        await sp.select().from(usuario_nivel_modulo).where(eq(usuario_nivel_modulo.usuario_id, alvo.id)),
      );
      for (const m of niveis_modulo.MODULOS_NIVELADOS) {
        if (!f.tem(`nivel_${m.codigo}`)) continue;
        const nivel = _nivel_do_form(f.texto(`nivel_${m.codigo}`));
        if (nivel === undefined) throw new ErroHttp(422, `nível inválido para ${m.codigo}`);
        if ((atuais[m.codigo] ?? null) === nivel) continue;
        const r = await liberacao.alterar_nivel_pessoa(sp as Executor, usuario, alvo.id, m.codigo, nivel);
        if (r) {
          recusa = `${m.nome}: ${r}`;
          throw new _Desfazer();
        }
        mudou += 1;
      }
    });
  } catch (erro) {
    if (!(erro instanceof _Desfazer)) throw erro;
  }
  if (recusa) return _tela_lista(c, usuario, { erro: `Acesso de ${alvo.nome} não alterado. ${recusa}` });
  return redirecionar(
    c,
    comMensagem("/usuarios", mudou ? `Acesso por módulo de ${alvo.nome} gravado.` : "Nada mudou no acesso por módulo."),
  );
});

/** Os setores promotores da conta: as turmas que ela vê e gere. */
rotas.post("/usuarios/:id{[0-9]+}/setores", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  const tx = c.get("tx");
  const alvo_id = Number(c.req.param("id"));
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, alvo_id));
  if (!alvo) throw new ErroHttp(404, "conta inexistente");
  const do_topo = alvo.id === usuario.id ? null : await _recusa_sobre_administrador(tx, usuario, alvo.id);
  if (do_topo) return _tela_lista(c, usuario, { erro: `Setores de ${alvo.nome} não alterados: ${do_topo}` });
  const escolhidos = f.todos("setor").filter((v) => /^\d+$/.test(v)).map(Number);
  const recusa = await liberacao.definir_setores(tx, usuario, alvo.id, escolhidos);
  if (recusa) return _tela_lista(c, usuario, { erro: `Setores de ${alvo.nome} não alterados: ${recusa}` });
  return redirecionar(c, comMensagem("/usuarios", `Setores promotores de ${alvo.nome} gravados.`));
});
