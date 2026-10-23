/**
 * /config — parâmetros operacionais, backup e exportação.
 * Porte de `app/rotas/configuracao.py`.
 *
 * Configurações conforme o perfil (23/10/2026): cada bloco da tela tem DONO —
 * um módulo e uma permissão — e só aparece a quem tem os dois
 * (`blocos_config`). Os blocos de Processos SEI (setor emissor, autoridade,
 * SLA, integração com o SEI) somem com o módulo em "Sem acesso"; a retirada de
 * EPI é de quem gere EPI; onde o dado mora e o backup, de quem opera a máquina.
 * O título de seção sem bloco não sai, e a conta sem bloco nenhum não entra
 * (403 com recado curto) nem vê a engrenagem do cabeçalho — a engrenagem chama
 * a MESMA função (`ve_config`, global dos templates).
 *
 * Era `processo.ver` (D47): o servidor comum (`servidor_consulta`) tem essa
 * permissão para acompanhar o PRÓPRIO processo, e entrava aqui lendo o host do
 * banco e os caminhos de disco da instalação. Continua fora: ler o setor exige,
 * além do módulo, quem instrui processo ou gere catálogo.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { obterConfig, VERSAO } from "../config.js";
import { autoridade_destinataria, setor_emissor } from "../db/esquema/index.js";
import { EscopoNaoDeclarado, PermissaoNegada, type UsuarioAtual } from "../servicos/rbac.js";
import { modulo_nivelado, permissoes_do_modulo } from "../servicos/niveis_modulo.js";
import * as auditoria from "../servicos/auditoria.js";
import * as servico_backup from "../servicos/backup.js";
import { RotinaFalhou, conferir_senha_do_backup } from "../servicos/rotinas.js";
import * as sei from "../servicos/sei.js";
import { SLA_PADRAO, gravar_sla, sla_vigente } from "../servicos/processo.js";
import { COLUNAS_KANBAN } from "../dominio/estados.js";
import { obterArmazenamento, pastaLocal } from "../servicos/armazenamento.js";
import { dicionario } from "../dicionario.js";
import "../servicos/pendencias.js"; // liga o sino da casca
import { global, marcarDownload, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

/** `pode_na_equipe` sem derrubar a tela: perfil sem escopo declarado conta como equipe. */
function _na_equipe(usuario: UsuarioAtual, permissao: string): boolean {
  try {
    return usuario.pode_na_equipe(permissao);
  } catch (erro) {
    if (erro instanceof EscopoNaoDeclarado) return true;
    throw erro;
  }
}

/**
 * O módulo está liberado para a conta: alguma permissão dele, já com o nível
 * por módulo aplicado ("Sem acesso" tira todas — `niveis_modulo.ts`), e no
 * trabalho da equipe, não só sobre o que é do titular.
 *
 * PONTO DE TROCA: quando existir a função única `tem_acesso_ao_modulo`
 * (liberação "Sem acesso esconde o módulo"), este corpo vira a chamada dela.
 */
export function tem_acesso_ao_modulo(usuario: UsuarioAtual, codigo: string): boolean {
  const m = modulo_nivelado(codigo);
  if (!m) return false;
  return permissoes_do_modulo(m).some((p) => usuario.pode(p) && _na_equipe(usuario, p));
}

/** As permissões de quem GERE EPI (o "Retirada de EPI" é de quem atende o pedido). */
export const PERMISSOES_GESTAO_EPI: readonly string[] = ["epi.catalogo", "epi.entregar", "epi.estoque", "epi.analisar"];

/** O que cada conta vê em /config — bloco a bloco. */
export interface BlocosConfig {
  /** Setor emissor + autoridade destinatária (leitura) */
  setor_emissor: boolean;
  /** SLA por coluna (leitura) */
  sla: boolean;
  /** o formulário do SLA (POST /config/sla) */
  editar_sla: boolean;
  /** os links para os catálogos de setor/autoridade */
  catalogos: boolean;
  /** Integração com o SEI (e o passo a passo) */
  integracao_sei: boolean;
  /** Retirada de EPI (leitura do .env) */
  retirada_epi: boolean;
  /** Onde o dado mora (host do banco, caminhos) */
  onde_mora: boolean;
  /** o botão e o POST do backup cifrado */
  backup: boolean;
  /** o botão e o POST da exportação completa */
  exportar_tudo: boolean;
  /** a seção "Configuração do setor" tem algum bloco */
  secao_setor: boolean;
  /** a seção "Sistema" tem algum bloco */
  secao_sistema: boolean;
  /** sobra algum bloco — abre a tela e mostra a engrenagem */
  algum: boolean;
}

/**
 * O mapa bloco → módulo/permissão, num lugar só. A rota GET, as POST, o
 * template e a engrenagem de `base.html` leem daqui.
 */
export function blocos_config(usuario: UsuarioAtual): BlocosConfig {
  const processos = tem_acesso_ao_modulo(usuario, "processos-sei");
  // quem ajusta o setor: instrui processo ou gere catálogo. `processo.ver`
  // sozinho (servidor comum, auditor, PROGEP) não basta — D47.
  const do_setor = processos && (usuario.pode("processo.editar") || usuario.pode("catalogo.gerenciar"));
  const editar_sla = do_setor && usuario.pode("catalogo.gerenciar") && usuario.pode("processo.editar");
  const retirada_epi =
    tem_acesso_ao_modulo(usuario, "epis") &&
    PERMISSOES_GESTAO_EPI.some((p) => usuario.pode(p) && _na_equipe(usuario, p));
  const onde_mora = usuario.pode("backup.executar");
  const backup = usuario.pode("backup.executar");
  const exportar_tudo = pode_exportar_tudo(usuario) && usuario.pode("exposicao.ver");
  const secao_setor = do_setor || retirada_epi;
  const secao_sistema = onde_mora || backup || exportar_tudo;
  return {
    setor_emissor: do_setor,
    sla: do_setor,
    editar_sla,
    catalogos: do_setor && usuario.pode("catalogo.gerenciar"),
    integracao_sei: do_setor,
    retirada_epi,
    onde_mora,
    backup,
    exportar_tudo,
    secao_setor,
    secao_sistema,
    algum: secao_setor || secao_sistema,
  };
}

/** A engrenagem do cabeçalho (`base.html`) usa a mesma conta da rota. */
export function ve_config(usuario: UsuarioAtual | null | undefined): boolean {
  return !!usuario && blocos_config(usuario).algum;
}
global("ve_config", ve_config);

function _exigir_config(usuario: UsuarioAtual): BlocosConfig {
  const blocos = blocos_config(usuario);
  if (!blocos.algum) {
    throw new PermissaoNegada(
      "configuracao",
      "Não há configuração liberada para o seu perfil de acesso.",
    );
  }
  return blocos;
}

/** Recusa o POST cujo bloco a conta não vê — a tela não é a barreira. */
function _exigir_bloco(ok: boolean, codigo: string, mensagem: string): void {
  if (!ok) throw new PermissaoNegada(codigo, mensagem);
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
  const blocos = _exigir_config(usuario);
  const tx = c.get("tx");
  const cfg = obterConfig();
  // o que a conta não vê nem vai ao contexto
  const do_processo = blocos.setor_emissor;
  return pagina(c, "paginas/config.html", usuario, {
    cfg: { ambiente: cfg.ambiente, epi_local_retirada: blocos.retirada_epi ? cfg.epiLocalRetirada : "" },
    blocos,
    pode_exportar_tudo: blocos.exportar_tudo,
    onde: blocos.onde_mora ? _onde_mora() : null,
    versao: VERSAO,
    // o código da coluna é chave do parâmetro; a tela mostra o rótulo do quadro
    rotulo_coluna: Object.fromEntries(COLUNAS_KANBAN),
    sla: dicionario(blocos.sla ? await sla_vigente(tx) : {}),
    sla_padrao: SLA_PADRAO,
    setores: do_processo ? await tx.select().from(setor_emissor) : [],
    destinatarios: do_processo ? await tx.select().from(autoridade_destinataria) : [],
    passos_sei: blocos.integracao_sei ? sei.PASSOS_INCLUSAO : [],
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
  usuario.exigir("catalogo.gerenciar");
  // e o módulo Processos SEI em Operação: o catálogo sozinho não grava o prazo
  // de um quadro que a conta nem vê
  _exigir_bloco(
    blocos_config(usuario).editar_sla,
    "processo.editar",
    "Editar o SLA é de quem opera o módulo Processos SEI e gere os catálogos.",
  );
  const f = await formulario(c);
  const valores: Record<string, number> = {};
  for (const coluna of Object.keys(SLA_PADRAO)) {
    const bruto = f.texto(`sla_${coluna}`).trim();
    if (/^\d+$/.test(bruto)) valores[coluna] = Number(bruto);
  }
  await gravar_sla(c.get("tx"), valores, usuario);
  return _tela(c, usuario, { mensagem: "SLA atualizado." });
});

rotas.post("/config/backup", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("backup.executar");
  const tx = c.get("tx");
  let resultado: servico_backup.ResultadoBackup;
  try {
    // a mesma recusa da rotina diária: desde que a senha do backup deixou de
    // barrar a subida do sistema, é aqui que ela barra o botão
    conferir_senha_do_backup();
    resultado = await servico_backup.fazer_backup(tx);
  } catch (falha) {
    if (!(falha instanceof servico_backup.DestinoProibido || falha instanceof RotinaFalhou)) throw falha;
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
 * Quem leva o banco INTEIRO em claro. Não basta `exportar`: sete perfis a têm
 * (técnico, consulta PROGEP, auditor...), e o zip traz tudo o que o escopo, a
 * RN-19 e a porta dos anexos negam a eles — mais o hash de senha de todas as
 * contas. Fica com quem responde pelo sistema: quem concede perfil
 * (superintendência) ou quem gere o catálogo (coordenação). DESVIO do Python,
 * que pedia só `exportar` (ver DESVIOS.md, "Produção — segurança").
 */
export function pode_exportar_tudo(usuario: UsuarioAtual): boolean {
  return usuario.pode("exportar") && (usuario.pode("perfil.conceder") || usuario.pode("catalogo.gerenciar"));
}

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
  if (!pode_exportar_tudo(usuario)) {
    throw new PermissaoNegada(
      "exportar",
      "A exportação completa (o banco inteiro, em claro) é só de quem responde pelo sistema: " +
        "a superintendência (Sisa) ou a coordenação da CSSO.",
    );
  }
  // RN-19 (revisão de privacidade, 25/09/2026): o zip é o banco em claro, com
  // nome e SIAPE de todo servidor. `exportar` sozinho não é permissão nominal —
  // na matriz ele sempre anda com `exposicao.ver`, mas um perfil montado sem
  // ela levaria o cadastro inteiro por aqui.
  usuario.exigir("exposicao.ver");
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
