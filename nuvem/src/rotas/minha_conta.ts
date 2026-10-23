/**
 * /minha-conta — a conta vista e cuidada pela própria pessoa (22/10/2026).
 *
 * Abre para TODA conta logada, sem permissão nenhuma: o que se mexe aqui é
 * sempre a conta da sessão, nunca um id vindo da URL ou do formulário. Por
 * isso não há `exigir(...)` — e por isso nenhuma rota daqui toca em perfil,
 * atribuição, vínculo de servidor ou habilitação: esses continuam em
 * /usuarios, com as permissões de governança.
 *
 * - Nome, telefone e ramal: editáveis; a trilha diz QUAIS campos mudaram,
 *   nunca o número (CONTA_DADOS_ALTERADOS_PELO_TITULAR).
 * - E-mail: é a credencial de entrada. Trocá-lo pede a senha atual, conferida
 *   com o mesmo teto de tentativas da troca de senha (M74), e a unicidade é
 *   sem caixa, como no login (D12, migração 0012).
 * - Senha: a tela leva a /trocar-senha, que já tem a política, a barra de
 *   força e o encerramento das outras sessões. Repetir o formulário aqui seria
 *   um segundo lugar para a mesma regra.
 * - Sessões: a lista das abertas (com "encerrar") saiu no mesmo dia, por
 *   decisão do usuário; no lugar, a sessão parada cai sozinha em 60 minutos,
 *   com aviso aos 55 (DESVIOS.md, "Desligamento por inatividade").
 * - Perfis e vínculo de servidor: só leitura.
 * - "Meu perfil" do Portal do servidor (22/10/2026): a mesma tela, em seções
 *   `<details>` — Dados funcionais (só leitura, sem POST), Contato e acesso,
 *   Segurança, Treinamentos e certificados (resumo de
 *   `certificados_titular.do_titular`) e Privacidade. Sem CPF, RG ou
 *   nascimento: o perfil não os mostra.
 *
 * Ver DESVIOS.md, "Minha conta (22/10/2026)".
 */
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { obterConfig } from "../config.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import {
  atribuicao,
  campus as tabela_campus,
  servidor as tabela_servidor,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import { hoje_iso } from "../dominio/datas.js";
import { vigente_em } from "../dominio/organizacao.js";
import * as auditoria from "../servicos/auditoria.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as certificados_titular from "../servicos/certificados_titular.js";
import { numero as numero_br } from "../servicos/presenca.js";
import { postos_atuais } from "../servicos/servidores.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { comMensagem, pagina, redirecionar } from "../web.js";
import { INICIO, ipDoCliente } from "./autenticacao.js";
import { _duplicada } from "./usuarios.js";

export const rotas = new Hono<Ambiente>();

export const CAMINHO = "/minha-conta";

// ---------------------------------------------------------------------
// Validação de contato
// ---------------------------------------------------------------------

/** Só o que se escreve num número de telefone: dígito, espaço, parênteses, hífen e "+". */
const RE_CONTATO = /^[0-9 ()+-]*$/;
export const TELEFONE_MAX = 30;
export const RAMAL_MAX = 12;

function _digitos(valor: string): number {
  return valor.replace(/\D/g, "").length;
}

/**
 * Telefone: vazio (apaga) ou de 8 a 15 dígitos — 8 é o fixo sem DDD, 15 é o
 * teto do E.164 —, até 30 caracteres com a formatação. Devolve a recusa ou `null`.
 */
export function recusa_telefone(valor: string): string | null {
  if (!valor) return null;
  if (valor.length > TELEFONE_MAX) return `o telefone tem mais de ${TELEFONE_MAX} caracteres.`;
  if (!RE_CONTATO.test(valor)) {
    return "o telefone aceita só números, espaço, parênteses, hífen e +; exemplo: (38) 99999-1234.";
  }
  const n = _digitos(valor);
  if (n < 8 || n > 15) return "o telefone precisa ter de 8 a 15 dígitos; exemplo: (38) 99999-1234.";
  return null;
}

/** Ramal: vazio (apaga) ou de 1 a 8 dígitos, até 12 caracteres. */
export function recusa_ramal(valor: string): string | null {
  if (!valor) return null;
  if (valor.length > RAMAL_MAX) return `o ramal tem mais de ${RAMAL_MAX} caracteres.`;
  if (!RE_CONTATO.test(valor)) return "o ramal aceita só números, espaço, parênteses, hífen e +.";
  const n = _digitos(valor);
  if (n < 1 || n > 8) return "o ramal precisa ter de 1 a 8 dígitos.";
  return null;
}

// ---------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------

/** As iniciais do cabeçalho: a primeira e a última palavra com letra ("Mariana Alves Rocha" → "MR"). */
export function iniciais(nome: string | null | undefined): string {
  const palavras = (nome ?? "")
    .split(/\s+/)
    .filter((p) => /\p{L}/u.test(p) && !/^(d[aeo]s?|e)$/i.test(p));
  if (!palavras.length) return "?";
  const letra = (p: string) => ([...p].find((x) => /\p{L}/u.test(x)) ?? "").toLocaleUpperCase("pt-BR");
  return palavras.length === 1 ? letra(palavras[0]!) : letra(palavras[0]!) + letra(palavras.at(-1)!);
}

type Digitado = { nome?: string; telefone?: string; ramal?: string; email?: string };

async function _tela(
  c: Ctx,
  usuario: UsuarioAtual,
  extra: { erro_dados?: string; erro_email?: string; digitado?: Digitado } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const [conta] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario.id));
  const hoje = hoje_iso();

  // Os perfis: os vigentes e os que ainda vão começar (a concessão futura é
  // o "por que eu ainda não vejo a tela X?" que a pessoa vem perguntar).
  const concessoes = (
    await tx.query.atribuicao.findMany({
      where: eq(atribuicao.usuario_id, usuario.id),
      with: { perfil: true },
    })
  )
    .filter((a) => a.perfil?.ativo && (vigente_em(a, hoje) || a.vigencia_inicio > hoje))
    .sort((a, b) => a.vigencia_inicio.localeCompare(b.vigencia_inicio) || a.id - b.id);
  const ids_campus = [...new Set(concessoes.map((a) => a.campus_id).filter((i): i is number => i !== null))];
  const campi = new Map(
    (ids_campus.length ? await tx.select().from(tabela_campus).where(inArray(tabela_campus.id, ids_campus)) : []).map(
      (x) => [x.id, x],
    ),
  );
  const perfis = concessoes.map((a) => ({
    nome: a.perfil.nome,
    codigo: a.perfil.codigo,
    coordenadoria: a.coordenadoria,
    campus: a.campus_id === null ? null : (campi.get(a.campus_id) ?? null),
    vigencia_inicio: a.vigencia_inicio,
    vigencia_fim: a.vigencia_fim,
    futura: a.vigencia_inicio > hoje,
  }));

  const servidor =
    conta?.servidor_id != null
      ? ((await tx.query.servidor.findFirst({
          where: eq(tabela_servidor.id, conta.servidor_id),
          with: { cargo: true, unidade: { with: { campus: true } } },
        })) ?? null)
      : null;
  const [postos, certificados] = servidor
    ? await Promise.all([postos_atuais(tx, servidor.id), certificados_titular.do_titular(tx, servidor.id, hoje)])
    : [[], null];

  // "Meu perfil" (Portal do servidor, 22/10/2026): o resumo de treinamentos.
  // Válido é o que ainda vale hoje: no prazo, a vencer, ou sem vencimento.
  const resumo_certificados = certificados
    ? {
        validos: certificados.resumo.validos + certificados.resumo.a_vencer + certificados.resumo.indeterminados,
        horas: numero_br(String(certificados.resumo.horas)),
        em_emissao: certificados.em_emissao.length,
      }
    : null;

  return pagina(c, "paginas/minha_conta.html", usuario, {
    conta,
    perfis,
    servidor,
    postos,
    iniciais: iniciais(servidor?.nome ?? conta?.nome ?? usuario.nome),
    resumo_certificados,
    inatividade_minutos: obterConfig().sessaoInatividadeMinutos,
    mensagem: c.req.query("mensagem") ?? null,
    TELEFONE_MAX,
    RAMAL_MAX,
    ...extra,
  });
}

rotas.get(CAMINHO, async (c) => {
  const usuario = await usuarioLogado(c);
  return _tela(c, usuario);
});

/** Nome, telefone e ramal. O e-mail é outro formulário: ele pede a senha. */
rotas.post(`${CAMINHO}/dados`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const novos = {
    nome: f.texto("nome").trim().replace(/\s+/g, " "),
    telefone: f.texto("telefone").trim(),
    ramal: f.texto("ramal").trim(),
  };
  const recusar = (motivo: string) =>
    _tela(c, usuario, { erro_dados: `Os dados não foram alterados: ${motivo}`, digitado: novos });
  if (!novos.nome) return recusar("o nome não fica em branco.");
  if ([...novos.nome].length > 160) return recusar("o nome tem mais de 160 caracteres.");
  const recusa = recusa_telefone(novos.telefone) ?? recusa_ramal(novos.ramal);
  if (recusa) return recusar(recusa);

  const [atual] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario.id)).for("update");
  if (!atual) return redirecionar(c, "/login");
  const gravar = { nome: novos.nome, telefone: novos.telefone || null, ramal: novos.ramal || null };
  const mudou = (["nome", "telefone", "ramal"] as const).filter((k) => (atual[k] ?? null) !== gravar[k]);
  if (!mudou.length) return redirecionar(c, comMensagem(CAMINHO, "Nada mudou."));
  await tx.update(tabela_usuario).set(gravar).where(eq(tabela_usuario.id, atual.id));
  // Só os NOMES dos campos: o número de telefone não vai para a trilha, que é
  // lida por quem audita e não se apaga (é encadeada).
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: atual.id,
    tipo_evento: auditoria.CONTA_DADOS_ALTERADOS_PELO_TITULAR,
    descricao: `Conta '${atual.login}': ${mudou.join(", ")} alterado(s) pela própria conta.`,
    campo: mudou.join(","),
    usuario,
    ip: ipDoCliente(c),
    user_agent: c.req.header("user-agent") ?? null,
  });
  return redirecionar(c, comMensagem(CAMINHO, "Dados atualizados."));
});

/**
 * O e-mail é a credencial de entrada: trocá-lo pede a senha atual. A conferência
 * é a da troca de senha (`conferir_senha_atual`), com o mesmo contador do login
 * — sem ela, a sessão esquecida aberta numa máquina compartilhada trocava o
 * e-mail e a conta ia junto.
 */
rotas.post(`${CAMINHO}/email`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const f = await formulario(c);
  const email = f.texto("email").trim();
  const senha_atual = f.texto("senha_atual");
  const recusar = (motivo: string) =>
    _tela(c, usuario, { erro_email: `O e-mail não foi alterado: ${motivo}`, digitado: { email } });
  const [atual] = await tx.select().from(tabela_usuario).where(eq(tabela_usuario.id, usuario.id));
  if (!atual) return redirecionar(c, "/login");
  if (!email) return recusar("o e-mail não fica em branco.");
  if (email.length > 160) return recusar("o e-mail tem mais de 160 caracteres.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return recusar("isto não parece um e-mail (nome@ufvjm.edu.br).");
  if (email === atual.email) return redirecionar(c, comMensagem(CAMINHO, "Nada mudou."));
  if (!senha_atual) return recusar("digite a sua senha atual para confirmar.");

  const contexto = { usuario, ip: ipDoCliente(c), user_agent: c.req.header("user-agent") ?? null };
  const recusa = await autenticacao.conferir_senha_atual(tx, atual.id, senha_atual, contexto);
  if (recusa?.bloqueada) {
    deleteCookie(c, autenticacao.COOKIE_SESSAO, { path: "/" });
    return pagina(c, "paginas/login.html", null, { erro: recusa.mensagem, proximo: INICIO, login: atual.login });
  }
  if (recusa) return recusar(recusa.mensagem);

  // Sem caixa e cruzado com o login (D12): a mesma conferência de /usuarios.
  // A mensagem não diz de quem é: esta tela abre para qualquer conta, e ela não
  // pode virar um jeito de descobrir o dono de um e-mail.
  if (await _duplicada(tx, { login: atual.login, email }, atual.id)) {
    return recusar("ele já é usado por outra conta. Se o e-mail é seu, fale com a coordenação.");
  }
  await tx.update(tabela_usuario).set({ email }).where(eq(tabela_usuario.id, atual.id));
  await auditoria.registrar(tx, {
    entidade: "usuario",
    entidade_id: atual.id,
    tipo_evento: auditoria.EMAIL_ALTERADO_PELO_TITULAR,
    descricao: `Conta '${atual.login}': e-mail de entrada alterado pela própria conta, com a senha atual conferida.`,
    campo: "email",
    valor_anterior: atual.email,
    valor_novo: email,
    ...contexto,
  });
  return redirecionar(
    c,
    comMensagem(CAMINHO, `E-mail alterado. A partir de agora você entra com ${email}.`),
  );
});
