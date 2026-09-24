/**
 * /config — parâmetros operacionais, backup e exportação.
 * Porte de `app/rotas/configuracao.py`.
 *
 * Quem abre `/config`, e por que são duas permissões e não uma: a tela guarda
 * **parâmetro do processo** (SLA, setor emissor, autoridade destinatária) e
 * **operação da máquina** (onde o dado mora, backup, exportação). A ROTA aceita
 * qualquer uma das duas; a TELA reparte — os cartões de processo pedem
 * `processo.ver`, os de máquina abrem para quem entrou.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { obterConfig, VERSAO } from "../config.js";
import { autoridade_destinataria, setor_emissor } from "../db/esquema/index.js";
import { PermissaoNegada, type UsuarioAtual } from "../servicos/rbac.js";
import * as auditoria from "../servicos/auditoria.js";
import * as servico_backup from "../servicos/backup.js";
import * as sei from "../servicos/sei.js";
import { SLA_PADRAO, gravar_sla, sla_vigente } from "../servicos/processo.js";
import { obterArmazenamento, pastaLocal } from "../servicos/armazenamento.js";
import { dicionario } from "../dicionario.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { marcarDownload, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

export const PERMISSOES_CONFIG: readonly string[] = ["processo.ver", "backup.executar"];

/** Qualquer uma de `PERMISSOES_CONFIG` — nunca as duas. */
function _exigir_config(usuario: UsuarioAtual): void {
  if (!PERMISSOES_CONFIG.some((codigo) => usuario.pode(codigo))) {
    throw new PermissaoNegada(
      PERMISSOES_CONFIG[0]!,
      "A configuração do sistema abre para quem instrui processo " +
        "(`processo.ver`) ou para quem opera a máquina (`backup.executar`).",
    );
  }
}

/**
 * Onde o dado mora NESTA instalação. No Python eram caminhos de disco
 * (`cfg.caminho_banco`, `dir_anexos`...); na nuvem são o Postgres (sem a senha
 * da URL), o bucket do Storage e os prefixos de backup e exportação.
 */
function _onde_mora() {
  const cfg = obterConfig();
  let banco = "—";
  try {
    const u = new URL(cfg.bancoUrl);
    banco = `PostgreSQL ${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    /* URL ausente: o aviso de configuração já diz */
  }
  const arquivos = cfg.supabaseUrl
    ? `Supabase Storage, bucket privado “${cfg.bucketArquivos}”`
    : `pasta local ${pastaLocal()}`;
  return {
    banco,
    anexos: `${arquivos} — anexos/`,
    documentos: `${arquivos} — documentos/`,
    backup: `${arquivos} — ${servico_backup.PREFIXO_BACKUP}/ (cifrado)`,
    exportacao: `${arquivos} — ${servico_backup.PREFIXO_EXPORTACAO}/ (em claro)`,
  };
}

async function _tela(c: Ctx, usuario: UsuarioAtual, recado: { mensagem?: string | null; erro?: string | null } = {}) {
  _exigir_config(usuario);
  const tx = c.get("tx");
  const cfg = obterConfig();
  // o que é do processo só é CONSULTADO por quem pode vê-lo
  const do_processo = usuario.pode("processo.ver");
  return pagina(c, "paginas/config.html", usuario, {
    cfg: { ambiente: cfg.ambiente, epi_local_retirada: cfg.epiLocalRetirada },
    onde: _onde_mora(),
    versao: VERSAO,
    do_processo,
    sla: dicionario(do_processo ? await sla_vigente(tx) : {}),
    sla_padrao: SLA_PADRAO,
    setores: do_processo ? await tx.select().from(setor_emissor) : [],
    destinatarios: do_processo ? await tx.select().from(autoridade_destinataria) : [],
    passos_sei: do_processo ? sei.PASSOS_INCLUSAO : [],
    versao_sei: sei.VERSAO_SEI_ALVO,
    mensagem: recado.mensagem ?? null,
    erro: recado.erro ?? null,
  });
}

rotas.get("/config", async (c) => {
  const usuario = await usuarioLogado(c);
  return _tela(c, usuario, { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null });
});

/** RN-16 — o prazo de cada coluna é decisão do setor, não constante de código. */
rotas.post("/config/sla", async (c) => {
  const usuario = await usuarioLogado(c);
  const f = await formulario(c);
  const valores: Record<string, number> = {};
  for (const coluna of Object.keys(SLA_PADRAO)) {
    const bruto = f.texto(`sla_${coluna}`).trim();
    if (/^\d+$/.test(bruto)) valores[coluna] = Number(bruto);
  }
  try {
    await gravar_sla(c.get("tx"), valores, usuario);
  } catch (falha) {
    if (!(falha instanceof PermissaoNegada)) throw falha;
    return _tela(c, usuario, { erro: falha.message });
  }
  return _tela(c, usuario, { mensagem: "SLA atualizado." });
});

rotas.post("/config/backup", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("backup.executar");
  const tx = c.get("tx");
  let resultado: servico_backup.ResultadoBackup;
  try {
    resultado = await servico_backup.fazer_backup(tx);
  } catch (falha) {
    if (!(falha instanceof servico_backup.DestinoProibido)) throw falha;
    return _tela(c, usuario, { erro: falha.message });
  }
  await auditoria.registrar(tx, {
    entidade: "sistema",
    entidade_id: 0,
    tipo_evento: "BACKUP_EXECUTADO",
    descricao:
      `${resultado.nome} (${resultado.tamanho} bytes, cifrado, ` +
      `banco (${resultado.tabelas} tabelas) + ${resultado.arquivos} arquivo(s) de anexos).`,
    usuario,
  });
  return _tela(c, usuario, {
    mensagem: `Backup cifrado gerado: ${resultado.chave} — banco e ${resultado.arquivos} arquivo(s) de anexos.`,
  });
});

/**
 * POST, e não GET: o que sai daqui é um zip EM CLARO com o banco inteiro.
 *
 * Na nuvem a resposta passa fácil dos 6 MB de corpo da função do Netlify: com
 * o Storage, a cópia gravada é entregue por URL assinada de 60 s; na pasta
 * local, o zip sai direto na resposta.
 */
rotas.post("/config/exportar-tudo", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("exportar");
  const tx = c.get("tx");
  const alvo = await servico_backup.exportar_tudo(tx);
  await auditoria.registrar(tx, {
    entidade: "sistema",
    entidade_id: 0,
    tipo_evento: "EXPORTACAO_COMPLETA",
    descricao: alvo.nome,
    usuario,
  });
  const arm = obterArmazenamento();
  if (arm.urlAssinada) return redirecionar(c, await arm.urlAssinada(alvo.chave, 60, alvo.nome));
  marcarDownload(c);
  return c.body(alvo.bytes as unknown as ArrayBuffer, 200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${alvo.nome}"`,
  });
});
