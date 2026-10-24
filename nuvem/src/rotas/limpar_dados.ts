/**
 * /config/limpar-dados — Limpar dados de teste (24/10/2026). Para o
 * Administrador do sistema zerar os dados de movimento depois de testar no
 * ambiente de produção. O motor é `servicos/limpeza.ts` (o mesmo da
 * ferramenta `limpar-treinamentos`); aqui ficam as trancas da tela:
 *
 * 1. **Dupla tranca de quem**: a permissão `dados.limpar` (que só o perfil
 *    Administrador do sistema tem) E o perfil vigente — conta com a permissão
 *    posta à mão noutro perfil não passa.
 * 2. **Primeiro a simulação** (`/simular`): o motor inteiro numa sub-transação
 *    desfeita, que devolve as contagens por tabela e os problemas do grafo de
 *    chaves estrangeiras (com problema, a tela não oferece executar).
 * 3. **Confirmação forte** (`/executar`): a frase exata, a senha atual
 *    (`conferir_senha_atual`, com o contador do login) e a identidade do banco
 *    mostrada na tela. A combinação de módulos é revalidada no POST — o
 *    formulário da simulação não é a barreira.
 * 4. **Backup antes**: o mesmo backup cifrado de /config, DENTRO da trava (o
 *    que ele leva é exatamente o que sai) e antes de qualquer DELETE. Sem
 *    armazenamento persistente, ou com o backup falhando, nada se apaga.
 * 5. **Uma transação por limpeza**: a da requisição. Os arquivos órfãos saem
 *    do armazenamento só depois do COMMIT (`depoisDoCommit`).
 */
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { depoisDoCommit } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { obterConfig } from "../config.js";
import * as auditoria from "../servicos/auditoria.js";
import * as autenticacao from "../servicos/autenticacao.js";
import * as servico_backup from "../servicos/backup.js";
import * as limpeza from "../servicos/limpeza.js";
import { ambienteDeProducao, identidadeDoBanco } from "../servicos/instalacao.js";
import { RotinaFalhou, conferir_senha_do_backup } from "../servicos/rotinas.js";
import { PermissaoNegada, tem_administrador_sistema, type UsuarioAtual } from "../servicos/rbac.js";
import { pagina } from "../web.js";
import { ipDoCliente } from "./autenticacao.js";

export const rotas = new Hono<Ambiente>();

export const CAMINHO = "/config/limpar-dados";
export const PERMISSAO = "dados.limpar";
/** A frase que se digita para executar — exata, maiúsculas e espaços inclusive. */
export const FRASE = "APAGAR DADOS DE TESTE";

/** Quem vê o bloco em /config e abre a tela: a permissão E o perfil vigente. */
export function pode_limpar(usuario: UsuarioAtual): boolean {
  return usuario.pode(PERMISSAO) && tem_administrador_sistema(usuario.perfis);
}

function _exigir(usuario: UsuarioAtual): void {
  usuario.exigir(PERMISSAO);
  if (!tem_administrador_sistema(usuario.perfis)) {
    throw new PermissaoNegada(
      PERMISSAO,
      "Limpar os dados de teste é só de quem tem o perfil Administrador do sistema vigente.",
    );
  }
}

/** A identidade do banco que se digita (a mesma da ferramenta de linha de comando). */
function _identidade(): string {
  try {
    return identidadeDoBanco(obterConfig().bancoUrl);
  } catch {
    return "—";
  }
}

/**
 * O backup NÃO protege nada se mora no disco da função (some no fim do
 * pedido): em produção, sem o Storage configurado, a limpeza é recusada.
 */
export function backup_indisponivel(): string | null {
  const cfg = obterConfig();
  if (cfg.supabaseUrl && !cfg.supabaseChaveServico) {
    return "o armazenamento está mal configurado (SUPABASE_URL sem SUPABASE_SERVICE_ROLE_KEY): o backup não tem onde ficar.";
  }
  if (!cfg.supabaseUrl && (ambienteDeProducao() || process.env.NETLIFY)) {
    return "não há armazenamento persistente configurado (SUPABASE_URL): o backup ficaria no disco da função e sumiria.";
  }
  return null;
}

interface Escolha {
  modulos: string[];
  contas: boolean;
}

function _escolha(f: Awaited<ReturnType<typeof formulario>>): Escolha {
  return { modulos: f.todos("modulo").filter(Boolean), contas: f.texto("contas") === "1" };
}

function _plano(usuario: UsuarioAtual, e: Escolha): limpeza.Plano {
  return limpeza.plano_dos_modulos(e.modulos, { contas: e.contas ? { executor_id: usuario.id } : null });
}

function _descricao(plano: limpeza.Plano, backup: string | null) {
  return (antes: limpeza.Contagens) =>
    `Limpeza dos dados de teste pela tela (/config/limpar-dados). Módulos: ${plano.modulos.join(", ")}. ` +
    `Apagado: ${limpeza.resumo_contagens(antes)}.` +
    (backup ? ` Backup feito antes: ${backup}.` : "") +
    " A trilha não se apaga: os eventos antigos ficam.";
}

async function _tela(
  c: Ctx,
  usuario: UsuarioAtual,
  extra: Record<string, unknown> = {},
  status = 200,
): Promise<Response> {
  return pagina(
    c,
    "paginas/limpar_dados.html",
    usuario,
    {
      modulos: limpeza.CODIGOS_MODULO.map((codigo) => limpeza.MODULOS[codigo]),
      contas_texto: limpeza.CONTAS_TEXTO,
      identidade: _identidade(),
      frase: FRASE,
      sem_backup: backup_indisponivel(),
      escolha: { modulos: [], contas: false },
      simulacao: null,
      problemas: [],
      resultado: null,
      erro: null,
      ...extra,
    },
    status,
  );
}

/** As linhas da tabela de contagens: só o que não é zero, e o total. */
function _linhas(c: limpeza.Contagens) {
  const apagar = Object.entries(c.apagar)
    .filter(([, n]) => n > 0)
    .map(([tabela, n]) => ({ tabela, n }));
  const desvincular = Object.entries(c.desvincular)
    .filter(([, n]) => n > 0)
    .map(([tabela, n]) => ({ tabela, n }));
  return { apagar, desvincular, total: limpeza.total_a_apagar(c), mantidas: Object.keys(c.mantidas).length };
}

rotas.get(CAMINHO, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir(usuario);
  return _tela(c, usuario);
});

rotas.post(`${CAMINHO}/simular`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir(usuario);
  const f = await formulario(c);
  const escolha = _escolha(f);
  let plano: limpeza.Plano;
  try {
    plano = _plano(usuario, escolha);
  } catch (erro) {
    if (!(erro instanceof limpeza.PlanoInvalido)) throw erro;
    return _tela(c, usuario, { escolha, erro: erro.message }, 422);
  }
  const r = await limpeza.simular(c.get("tx"), plano, {
    tipo_evento: auditoria.DADOS_DE_TESTE_APAGADOS,
    usuario,
    descricao: _descricao(plano, null),
  });
  return _tela(c, usuario, {
    escolha,
    problemas: r.problemas,
    simulacao: r.resultado ? { ..._linhas(r.resultado.antes), ms: r.resultado.ms, modulos: plano.modulos } : null,
  });
});

rotas.post(`${CAMINHO}/executar`, async (c) => {
  const usuario = await usuarioLogado(c);
  _exigir(usuario);
  const tx = c.get("tx");
  const f = await formulario(c);
  const escolha = _escolha(f);
  const recusar = (erro: string, status = 422) => _tela(c, usuario, { escolha, erro }, status);

  let plano: limpeza.Plano;
  try {
    plano = _plano(usuario, escolha);
  } catch (erro) {
    if (!(erro instanceof limpeza.PlanoInvalido)) throw erro;
    return recusar(erro.message);
  }
  // a frase e a identidade antes da senha: errar o que se copia não gasta tentativa
  if (f.texto("frase").trim() !== FRASE) return recusar(`Digite a frase exatamente: ${FRASE}. Nada foi apagado.`);
  if (f.texto("identidade").trim() !== _identidade()) {
    return recusar("A identidade do banco não confere com a mostrada na tela. Nada foi apagado.");
  }
  const senha = f.texto("senha_atual");
  if (!senha) return recusar("Digite a sua senha atual. Nada foi apagado.");
  const contexto = { usuario, ip: ipDoCliente(c), user_agent: c.req.header("user-agent") ?? null };
  const recusa = await autenticacao.conferir_senha_atual(tx, usuario.id, senha, contexto);
  if (recusa?.bloqueada) {
    deleteCookie(c, autenticacao.COOKIE_SESSAO, { path: "/" });
    return pagina(c, "paginas/login.html", null, { erro: recusa.mensagem, proximo: CAMINHO, login: usuario.login });
  }
  // a recusa da senha é retorno normal: o contador de tentativas é gravado
  if (recusa) return recusar(`${recusa.mensagem} Nada foi apagado.`);

  const sem = backup_indisponivel();
  if (sem) return recusar(`Backup indisponível neste ambiente: ${sem} Sem backup, a limpeza não roda. Nada foi apagado.`, 409);
  try {
    conferir_senha_do_backup();
  } catch (falha) {
    if (!(falha instanceof RotinaFalhou)) throw falha;
    return recusar(`Backup indisponível: ${falha.message} Nada foi apagado.`, 409);
  }

  let backup: servico_backup.ResultadoBackup | null = null;
  let resultado: limpeza.Resultado;
  try {
    // savepoint: falha do backup, do grafo ou da conferência desfaz tudo o que a
    // limpeza fez, e a tela diz por quê (a senha conferida continua gravada)
    resultado = await tx.transaction(async (sp) =>
      limpeza.executar(sp, plano, {
        simular: false,
        recusar_vazio: true,
        tipo_evento: auditoria.DADOS_DE_TESTE_APAGADOS,
        usuario,
        descricao: (antes) => _descricao(plano, backup?.chave ?? null)(antes),
        antes_de_apagar: async (sp2) => {
          try {
            backup = await servico_backup.fazer_backup(sp2);
          } catch (falha) {
            throw new BackupFalhou(falha instanceof Error ? falha.message : String(falha));
          }
          await auditoria.registrar(sp2, {
            entidade: "sistema",
            entidade_id: 0,
            tipo_evento: "BACKUP_EXECUTADO",
            descricao:
              `${backup.nome} (${backup.tamanho} bytes, cifrado, banco (${backup.tabelas} tabelas) + ` +
              `${backup.arquivos} arquivo(s) de anexos), antes da limpeza dos dados de teste.`,
            usuario,
          });
        },
      }),
    );
  } catch (erro) {
    if (erro instanceof limpeza.NadaAApagar) {
      return _tela(c, usuario, { escolha, erro: "Nada a apagar: os módulos marcados já estão vazios. Nada foi feito (nem backup)." });
    }
    if (erro instanceof BackupFalhou) {
      return recusar(`O backup não terminou bem (${erro.message}). Nada foi apagado.`, 409);
    }
    if (erro instanceof limpeza.GrafoNaoConfere) {
      return _tela(c, usuario, { escolha, problemas: erro.problemas, erro: "O grafo de chaves não confere. Nada foi apagado." }, 409);
    }
    if (erro instanceof Error && erro.message.startsWith("conferência final falhou")) {
      return recusar(`${erro.message.split("\n")[0]} ${erro.message.split("\n").slice(1).join(" ")}`, 409);
    }
    throw erro;
  }
  const arquivos = resultado.arquivos;
  depoisDoCommit(c, async () => {
    const r = await limpeza.apagar_orfaos(arquivos, true);
    if (r.falhas) console.error("limpeza de dados de teste: arquivos órfãos que não saíram", { falhas: r.falhas });
  });
  const feito = backup as servico_backup.ResultadoBackup | null;
  return _tela(c, usuario, {
    resultado: {
      ..._linhas(resultado.antes),
      ms: resultado.ms,
      modulos: plano.modulos,
      backup: feito ? { chave: feito.chave, tamanho: feito.tamanho, arquivos: feito.arquivos } : null,
      arquivos: arquivos.chaves.length + arquivos.listagens.length,
    },
  });
});

class BackupFalhou extends Error {}
