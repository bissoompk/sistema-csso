/**
 * /usuarios e /perfis — governança de acesso e habilitação técnica.
 * Porte de `app/rotas/usuarios.py`.
 */
import { Hono } from "hono";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { desfazer } from "../nucleo/contexto.js";
import { ErroHttp } from "../nucleo/erros.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import {
  agora_utc,
  atribuicao,
  campus,
  perfil as tabela_perfil,
  profissional_habilitado,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { vigente_em } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as datas_br from "../servicos/datas_br.js";
import {
  GRUPOS_PERMISSAO_TELA,
  MATRIZ_PERFIS,
  eh_conta_de_governo,
  perfis_vigentes,
  type UsuarioAtual,
} from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

type Digitado = Record<string, string | number>;

/**
 * A tela, com os três popups de cadastro em branco ou com o digitado.
 * `digitado` traz uma FORMA (`conta`, `perfil`, `habilitacao`) porque a recusa
 * precisa dizer qual deles reabrir. Não entra na URL. A forma `conta-hab` é a
 * edição da conta ligada a um profissional habilitado: um popup por linha, e
 * `usuario_alvo` diz qual.
 */
async function _tela_lista(
  c: Ctx,
  usuario: UsuarioAtual,
  recado: { mensagem?: string | null; erro?: string | null; digitado?: Digitado } = {},
) {
  const tx = c.get("tx");
  const hoje = hoje_iso();
  const usuarios = await tx.select().from(tabela_usuario).orderBy(asc(tabela_usuario.nome));
  const todas = await tx.query.atribuicao.findMany({ with: { perfil: true }, orderBy: [asc(atribuicao.id)] });
  const atribuicoes: Record<number, typeof todas> = {};
  const vigentes_por_usuario: Record<number, typeof todas> = {};
  for (const u of usuarios) {
    atribuicoes[u.id] = todas.filter((a) => a.usuario_id === u.id);
    vigentes_por_usuario[u.id] = atribuicoes[u.id]!.filter((a) => vigente_em(a, hoje));
  }
  // quem a tela marca como conta de administração (a senha só o superintendente redefine)
  const perfis_de_governo = new Set(
    (await tx.query.perfil.findMany({ with: { perfil_permissoes: { with: { permissao: true } } } }))
      .filter((pf) => pf.ativo && eh_conta_de_governo(pf.perfil_permissoes.map((pp) => pp.permissao.codigo)))
      .map((pf) => pf.id),
  );
  const contas_de_governo = usuarios
    .filter((u) => vigentes_por_usuario[u.id]!.some((a) => perfis_de_governo.has(a.perfil_id)))
    .map((u) => u.id);
  // A conta que, inativada, deixaria o sistema sem quem conceda perfil: a
  // linha dela não oferece "Inativar" (a rota recusa do mesmo jeito, D66).
  const ultima_que_concede = (await _contas_que_concedem(tx)).filter((id) => usuarios.some((u) => u.id === id && u.ativo));
  // Nome e SIAPE de todo servidor só vão para a página de quem vincula conta a
  // servidor (`perfil.conceder`) E lê dado nominal (`exposicao.ver`): o
  // `admin_ti` abre esta tela e não lê dado nominal (RN-19). Conceder perfil não
  // traz a leitura nominal por si.
  const vincula = usuario.pode("perfil.conceder") && usuario.pode("exposicao.ver");
  const servidores = vincula ? await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)) : [];
  const rotulo_servidor: Record<number, string> = {};
  const sugestao_servidor: Record<number, string> = {};
  for (const s of servidores) rotulo_servidor[s.id] = _rotulo_servidor(s);
  for (const u of usuarios) {
    if (u.servidor_id !== null || !vincula) continue;
    const sugerido = _unico_pelo_email(servidores, usuarios, u.email);
    if (sugerido) sugestao_servidor[u.id] = _rotulo_servidor(sugerido);
  }
  return pagina(c, "paginas/usuarios.html", usuario, {
    usuarios,
    contas_de_governo,
    ultima_que_concede: ultima_que_concede.length === 1 ? ultima_que_concede[0] : null,
    perfis: await tx.select().from(tabela_perfil).orderBy(asc(tabela_perfil.codigo)),
    campi: await tx.select().from(campus).orderBy(asc(campus.sigla)),
    atribuicoes,
    vigentes_por_usuario,
    habilitados: await tx.select().from(profissional_habilitado).orderBy(asc(profissional_habilitado.id)),
    servidores,
    rotulo_servidor,
    sugestao_servidor,
    hoje,
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
    digitado: recado.digitado ?? {},
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
 * Ato normativo em branco não barra mais a concessão (19/10/2026): ela entra
 * com o ato "pendente", dizendo quem concedeu e quando, e o ato real se
 * escreve depois em Gerir. A autorização continua na trilha — o que saiu foi a
 * tela que não deixava trabalhar enquanto a portaria não era publicada.
 */
export function ato_pendente(usuario: Pick<UsuarioAtual, "login">, hoje: string = hoje_iso()): string {
  return `Pendente — informado por ${usuario.login} em ${datas_br.numerica(hoje)}`;
}

/** Grava a concessão e o evento. Quem chama já conferiu `perfil.conceder`. */
async function _conceder(
  tx: Executor,
  usuario: UsuarioAtual,
  perfil: { id: number; codigo: string },
  d: { usuario_id: number; campus_id: string; vigencia_inicio: string; vigencia_fim: string; ato_normativo: string },
): Promise<void> {
  const ato = d.ato_normativo.trim() || ato_pendente(usuario);
  const [nova] = await tx
    .insert(atribuicao)
    .values({
      usuario_id: d.usuario_id,
      perfil_id: perfil.id,
      campus_id: /^\d+$/.test(d.campus_id) ? Number(d.campus_id) : null,
      vigencia_inicio: _data_ou(d.vigencia_inicio, hoje_iso())!,
      vigencia_fim: _data_ou(d.vigencia_fim, null),
      ato_normativo: ato,
      concedido_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: nova!.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao: `Perfil ${perfil.codigo} concedido — ato: ${ato}`,
    usuario,
  });
}

/**
 * As contas ATIVAS com concessão vigente de perfil que tem `perfil.conceder` —
 * opcionalmente sem a atribuição `sem_atribuicao` ou sem a conta `sem_conta`.
 */
async function _contas_que_concedem(
  tx: Executor,
  fora: { sem_atribuicao?: number; sem_conta?: number } = {},
): Promise<number[]> {
  const hoje = hoje_iso();
  const todas = await tx.query.atribuicao.findMany({
    with: { usuario: true, perfil: { with: { perfil_permissoes: { with: { permissao: true } } } } },
  });
  const ids = todas
    .filter(
      (a) =>
        a.id !== fora.sem_atribuicao &&
        a.usuario_id !== fora.sem_conta &&
        vigente_em(a, hoje) &&
        a.usuario.ativo &&
        a.perfil.ativo &&
        a.perfil.perfil_permissoes.some((pp) => pp.permissao.codigo === "perfil.conceder"),
    )
    .map((a) => a.usuario_id);
  return [...new Set(ids)];
}

/**
 * Sobra alguém que concede perfil se a atribuição `sem_atribuicao` deixar de
 * valer, ou se a conta `sem_conta` for inativada? Sem ninguém, o sistema fica
 * sem quem crie conta ou conceda perfil — e só volta por SQL. Conta inativa
 * não conta: ela não entra.
 */
async function _restaria_quem_concede(
  tx: Executor,
  fora: { sem_atribuicao?: number; sem_conta?: number },
): Promise<boolean> {
  return (await _contas_que_concedem(tx, fora)).length > 0;
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
  const { permissoes } = await perfis_vigentes(tx, alvo.id);
  if (!usuario.pode("perfil.conceder") && eh_conta_de_governo(permissoes)) {
    return "é conta de administração; só quem concede perfil (o superintendente) a inativa ou reativa.";
  }
  if (alvo.ativo && permissoes.has("perfil.conceder") && !(await _restaria_quem_concede(tx, { sem_conta: alvo.id }))) {
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
 * - conta de administração (`eh_conta_de_governo`) só por quem concede perfil;
 * - as demais, por quem tem `usuario.resetar_senha` ou concede perfil.
 *
 * A conta comum continua redefinível pelo `admin_ti` — é ele quem atende a
 * senha esquecida. O que segura esse caso é a troca obrigatória (o dono
 * percebe na próxima entrada) e o evento `SENHA_RESETADA` na trilha.
 * Devolve o motivo da recusa, ou `null`.
 */
async function _recusa_de_redefinicao(tx: Executor, usuario: UsuarioAtual, alvo_id: number): Promise<string | null> {
  if (alvo_id === usuario.id) return "a própria senha se troca em Trocar senha, informando a atual.";
  if (usuario.pode("perfil.conceder")) return null;
  const { permissoes } = await perfis_vigentes(tx, alvo_id);
  if (eh_conta_de_governo(permissoes)) {
    return "é conta de administração; só quem concede perfil (o superintendente) redefine.";
  }
  return usuario.pode("usuario.resetar_senha") ? null : "falta a permissão usuario.resetar_senha.";
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

rotas.post("/usuarios", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const f = await formulario(c);
  exigidos(f, "login", "nome", "email");
  const tx = c.get("tx");
  // Login e e-mail são UNIQUE no banco: sem esta conferência a duplicata subia
  // como erro de integridade e levava junto o que foi digitado.
  const limpos = { login: f.texto("login").trim(), nome: f.texto("nome").trim(), email: f.texto("email").trim() };
  // Perfil e servidor são opcionais e entram na MESMA transação: conta criada
  // num passo e perfil concedido noutro era conta que nascia sem abrir nada.
  const perfil_id = f.inteiro("perfil_id");
  const extras = {
    campus_id: f.texto("campus_id"),
    ato_normativo: f.texto("ato_normativo"),
    servidor: f.texto("servidor").trim(),
  };
  const digitado: Digitado = { forma: "conta", ...limpos, ...extras, perfil_id: perfil_id ?? "" };
  const [ja] = await tx
    .select()
    .from(tabela_usuario)
    .where(or(eq(tabela_usuario.login, limpos.login), eq(tabela_usuario.email, limpos.email)))
    .limit(1);
  if (ja) {
    const qual = ja.login === limpos.login ? "login" : "e-mail";
    return _tela_lista(c, usuario, { erro: `Já existe conta com este ${qual}: ${ja.nome}.`, digitado });
  }
  // conceder perfil e vincular a servidor são atos de governo, como em Gerir
  const governa = usuario.pode("perfil.conceder");
  if (!governa && (perfil_id !== null || extras.servidor)) {
    return _tela_lista(c, usuario, {
      erro: "Perfil e servidor pedem a permissão perfil.conceder: crie a conta sem eles.",
      digitado,
    });
  }
  let perfil: typeof tabela_perfil.$inferSelect | undefined;
  if (perfil_id !== null) {
    [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.id, perfil_id));
    if (!perfil) throw new ErroHttp(422, "perfil inexistente");
  }
  let servidor: Servidor | null = null;
  let pelo_email = false;
  if (extras.servidor) {
    const achado = await _resolver_servidor(tx, extras.servidor, null);
    if (achado.erro) return _tela_lista(c, usuario, { erro: `Conta não criada: ${achado.erro}`, digitado });
    servidor = achado.servidor;
  } else if (governa) {
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
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: novo!.id,
    tipo_evento: "USUARIO_CRIADO",
    descricao: `Conta '${f.texto("login")}' criada.`,
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
    await _conceder(tx, usuario, perfil, { usuario_id: novo!.id, vigencia_inicio: "", vigencia_fim: "", ...extras });
  }
  const detalhes = [
    perfil ? `perfil ${perfil.codigo}` : null,
    servidor ? `vinculada a ${servidor.nome}${pelo_email ? " pelo e-mail" : ""}` : null,
  ].filter(Boolean);
  // A senha provisória sai no CORPO, nunca na URL: no `?mensagem=` ela ficava
  // no histórico do navegador e em qualquer registro de acesso do caminho.
  return _senha_na_tela(
    c,
    usuario,
    `Conta criada${detalhes.length ? ` (${detalhes.join("; ")})` : ""}. Senha provisória: ${provisoria}`,
  );
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
  const achado = await _resolver_servidor(tx, f.texto("servidor"), alvo.id);
  if (achado.erro) return _tela_lista(c, usuario, { erro: `${alvo.nome}: ${achado.erro}` });
  const novo_id = achado.servidor?.id ?? null;
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
  return _senha_na_tela(c, usuario, `Nova senha provisória de ${alvo.login}: ${provisoria}`);
});

rotas.post("/usuarios/:id{[0-9]+}/inativar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const tx = c.get("tx");
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
  const dados = {
    usuario_id,
    campus_id: f.texto("campus_id"),
    vigencia_inicio: f.texto("vigencia_inicio"),
    vigencia_fim: f.texto("vigencia_fim"),
    ato_normativo: f.texto("ato_normativo"),
  };
  const digitado: Digitado = { forma: "perfil", usuario_alvo: usuario_id, perfil_id, ...dados };
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario_id));
  if (!alvo) return _tela_lista(c, usuario, { erro: "Escolha a conta que vai receber o perfil.", digitado });
  const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.id, perfil_id));
  if (!perfil) throw new ErroHttp(422, "perfil inexistente");
  await _conceder(tx, usuario, perfil, dados);
  const pendente = !dados.ato_normativo.trim();
  return redirecionar(
    c,
    comMensagem("/usuarios", pendente ? "Perfil concedido, com o ato normativo pendente." : "Perfil concedido."),
  );
});

/**
 * Encerra a concessão. `vigencia_fim` vira ONTEM, e não hoje: a vigência é
 * inclusiva (`vigente_em`), e encerrar com fim hoje deixaria o perfil valendo
 * até a meia-noite. Nada se apaga — a linha fica, com o fim, para a trilha.
 */
rotas.post("/usuarios/atribuicoes/:id{[0-9]+}/encerrar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const tx = c.get("tx");
  const a = await tx.query.atribuicao.findFirst({
    where: eq(atribuicao.id, Number(c.req.param("id"))),
    with: { usuario: true, perfil: { with: { perfil_permissoes: { with: { permissao: true } } } } },
  });
  if (!a) return redirecionar(c, "/usuarios");
  const fim = somar_dias(hoje_iso(), -1);
  if (a.vigencia_fim !== null && a.vigencia_fim <= fim) {
    return redirecionar(c, comMensagem("/usuarios", "Esta concessão já estava encerrada."));
  }
  const concede = a.perfil.perfil_permissoes.some((pp) => pp.permissao.codigo === "perfil.conceder");
  if (concede && !(await _restaria_quem_concede(tx, { sem_atribuicao: a.id }))) {
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
  let conta: { id: number; nome: string } | undefined;
  if (conta_id !== null) {
    [conta] = await tx
      .select({ id: tabela_usuario.id, nome: tabela_usuario.nome })
      .from(tabela_usuario)
      .where(eq(tabela_usuario.id, conta_id));
    // Volta com o popup DESTA linha aberto e a conta que se escolheu, e não
    // com a faixa no topo da lista: a recusa é do formulário de edição.
    if (!conta) {
      return _tela_lista(c, usuario, {
        erro: "Conta não encontrada.",
        digitado: { forma: "conta-hab", usuario_alvo: id, usuario_id: bruto },
      });
    }
  }
  if (habilitado.usuario_id === (conta?.id ?? null)) return redirecionar(c, "/usuarios");
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
  if (e_externo && !v.justificativa_art10_par5!.trim()) {
    // `erro`, e não `mensagem`: a habilitação NÃO foi registrada. E a recusa
    // devolve os onze campos, que o "voltar" do navegador não devolve.
    return _tela_lista(c, usuario, {
      erro: "Habilitação externa exige justificativa do art. 10, §5º.",
      digitado: { forma: "habilitacao", ...v },
    });
  }
  let habilitado;
  try {
    [habilitado] = await tx
      .insert(profissional_habilitado)
      .values({
        nome: v.nome!.trim(),
        siape: v.siape!.trim() || null,
        habilitacao: v.habilitacao!,
        titulo_assinatura: v.titulo_assinatura!.trim(),
        conselho: v.conselho || null,
        registro_conselho: v.registro_conselho || null,
        externo: e_externo,
        justificativa_art10_par5: v.justificativa_art10_par5!.trim() || null,
        usuario_id: /^\d+$/.test(v.usuario_alvo_id!) ? Number(v.usuario_alvo_id) : null,
        vigencia_inicio: _data_ou(v.vigencia_inicio!, hoje_iso())!,
        atestado_por: usuario.id,
        atestado_em: agora_utc(),
      })
      .returning();
  } catch (erro) {
    // valor fora do vocabulário do banco (habilitação): 422, como a validação
    // do FastAPI, e não 500
    desfazer(c);
    throw new ErroHttp(422, `Habilitação recusada pelo banco: ${(erro as Error).message}`);
  }
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
 * As permissões do perfil nos grupos de tela (M75), cada uma com o texto em
 * português e o código ao lado. Permissão que o banco tem e o código não
 * conhece (semeada por versão futura, ou à mão) vai para "Outras", com a
 * descrição gravada — some da tela, nunca.
 */
function _grupos_de(permissoes: { codigo: string; descricao: string | null }[]) {
  const codigos = new Set(permissoes.map((p) => p.codigo));
  const grupos: { rotulo: string; itens: { codigo: string; texto: string }[] }[] = [];
  const conhecidas = new Set<string>();
  for (const [rotulo, textos] of GRUPOS_PERMISSAO_TELA) {
    const itens = Object.entries(textos)
      .filter(([codigo]) => codigos.has(codigo))
      .map(([codigo, texto]) => ({ codigo, texto }));
    for (const codigo of Object.keys(textos)) conhecidas.add(codigo);
    if (itens.length) grupos.push({ rotulo, itens });
  }
  const outras = permissoes
    .filter((p) => !conhecidas.has(p.codigo))
    .map((p) => ({ codigo: p.codigo, texto: p.descricao || p.codigo }));
  if (outras.length) grupos.push({ rotulo: "Outras", itens: outras });
  return grupos;
}

rotas.get("/perfis", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("processo.ver");
  const tx = c.get("tx");
  const perfis = await tx.query.perfil.findMany({
    orderBy: [asc(tabela_perfil.codigo)],
    with: { perfil_permissoes: { with: { permissao: true } } },
  });
  return pagina(c, "paginas/perfis.html", usuario, {
    // a `secondary=` do Python: as permissões do perfil, já ordenadas por código
    perfis: perfis.map((p) => {
      const permissoes = p.perfil_permissoes.map((pp) => pp.permissao).sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
      return { ...p, permissoes, grupos: _grupos_de(permissoes) };
    }),
    matriz: MATRIZ_PERFIS,
  });
});
