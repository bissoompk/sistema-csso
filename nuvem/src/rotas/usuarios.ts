/**
 * /usuarios e /perfis — governança de acesso e habilitação técnica.
 * Porte de `app/rotas/usuarios.py`.
 */
import { Hono } from "hono";
import { asc, eq, or } from "drizzle-orm";
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
import { hoje_iso } from "../dominio/datas.js";
import { vigente_em } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as autenticacao from "../servicos/autenticacao.js";
import { MATRIZ_PERFIS, type UsuarioAtual } from "../servicos/rbac.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { comMensagem, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

type Digitado = Record<string, string | number>;

/**
 * A tela, com os três popups de cadastro em branco ou com o digitado.
 * `digitado` traz uma FORMA (`conta`, `perfil`, `habilitacao`) porque a recusa
 * precisa dizer qual deles reabrir. Não entra na URL.
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
  return pagina(c, "paginas/usuarios.html", usuario, {
    usuarios,
    perfis: await tx.select().from(tabela_perfil).orderBy(asc(tabela_perfil.codigo)),
    campi: await tx.select().from(campus).orderBy(asc(campus.sigla)),
    atribuicoes,
    vigentes_por_usuario,
    habilitados: await tx.select().from(profissional_habilitado).orderBy(asc(profissional_habilitado.id)),
    servidores: await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome)),
    hoje,
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
    digitado: recado.digitado ?? {},
  });
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
  const [ja] = await tx
    .select()
    .from(tabela_usuario)
    .where(or(eq(tabela_usuario.login, limpos.login), eq(tabela_usuario.email, limpos.email)))
    .limit(1);
  if (ja) {
    const qual = ja.login === limpos.login ? "login" : "e-mail";
    return _tela_lista(c, usuario, {
      erro: `Já existe conta com este ${qual}: ${ja.nome}.`,
      digitado: { forma: "conta", ...limpos },
    });
  }
  const provisoria = autenticacao.senha_provisoria();
  const [novo] = await tx
    .insert(tabela_usuario)
    .values({ ...limpos, senha_hash: await autenticacao.gerar_hash(provisoria), precisa_trocar_senha: true })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: novo!.id,
    tipo_evento: "USUARIO_CRIADO",
    descricao: `Conta '${f.texto("login")}' criada.`,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", `Conta criada. Senha provisória: ${provisoria}`));
});

rotas.post("/usuarios/:id{[0-9]+}/senha", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.resetar_senha");
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (!alvo) return redirecionar(c, "/usuarios");
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
  return redirecionar(c, comMensagem("/usuarios", `Nova senha provisória de ${alvo.login}: ${provisoria}`));
});

rotas.post("/usuarios/:id{[0-9]+}/inativar", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("usuario.criar_conta");
  const tx = c.get("tx");
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, Number(c.req.param("id"))));
  if (alvo) {
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
  }
  return redirecionar(c, "/usuarios");
});

rotas.post("/usuarios/:id{[0-9]+}/atribuicoes", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("perfil.conceder");
  const f = await formulario(c);
  exigidos(f, "perfil_id", "ato_normativo");
  const tx = c.get("tx");
  // O formulário posta em `/usuarios/0/atribuicoes` e diz o alvo em
  // `usuario_alvo`: resolver no servidor vale com e sem JavaScript.
  let usuario_id = Number(c.req.param("id"));
  const usuario_alvo = f.texto("usuario_alvo");
  if (usuario_id === 0 && /^\d+$/.test(usuario_alvo)) usuario_id = Number(usuario_alvo);
  const perfil_id = f.inteiro("perfil_id");
  if (perfil_id === null) throw new ErroHttp(422, "perfil_id inválido");
  const ato_normativo = f.texto("ato_normativo");
  const campus_id = f.texto("campus_id");
  const vigencia_inicio = f.texto("vigencia_inicio");
  const vigencia_fim = f.texto("vigencia_fim");
  const digitado: Digitado = {
    forma: "perfil",
    usuario_alvo: usuario_id,
    perfil_id,
    campus_id,
    vigencia_inicio,
    vigencia_fim,
    ato_normativo,
  };
  // `required` só barra o campo VAZIO; um espaço passava, e a concessão entrava
  // na auditoria com autorização em branco (Resolução Consu 11/2026, art. 11, IX).
  if (!ato_normativo.trim()) {
    return _tela_lista(c, usuario, {
      erro: "Sem o ato normativo não há concessão: é ele que autoriza o perfil.",
      digitado,
    });
  }
  const [alvo] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario_id));
  if (!alvo) return _tela_lista(c, usuario, { erro: "Escolha a conta que vai receber o perfil.", digitado });
  const [perfil] = await tx.select().from(tabela_perfil).where(eq(tabela_perfil.id, perfil_id));
  if (!perfil) throw new ErroHttp(422, "perfil inexistente");
  const [nova] = await tx
    .insert(atribuicao)
    .values({
      usuario_id,
      perfil_id,
      campus_id: /^\d+$/.test(campus_id) ? Number(campus_id) : null,
      vigencia_inicio: _data_ou(vigencia_inicio, hoje_iso())!,
      vigencia_fim: _data_ou(vigencia_fim, null),
      ato_normativo: ato_normativo.trim(),
      concedido_por: usuario.id,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "atribuicao",
    entidade_id: nova!.id,
    tipo_evento: "PERFIL_CONCEDIDO",
    descricao: `Perfil ${perfil.codigo} concedido — ato: ${ato_normativo.trim()}`,
    usuario,
  });
  return redirecionar(c, comMensagem("/usuarios", "Perfil concedido."));
});

/** A habilitação confere, não o cargo (IN 15/2022, art. 10, §2º, I). */
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
    perfis: perfis.map((p) => ({
      ...p,
      permissoes: p.perfil_permissoes.map((pp) => pp.permissao).sort((a, b) => (a.codigo < b.codigo ? -1 : 1)),
    })),
    matriz: MATRIZ_PERFIS,
  });
});
