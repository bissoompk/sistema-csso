/**
 * /ocorrencias — ocorrências de urgência e emergência (28/10/2026): o registro
 * geral, de qualquer pessoa na universidade, sem CAT/SP. A regra mora em
 * `servicos/ocorrencia.ts`.
 *
 * Duas portas, como no módulo de acidentes: quem só alcança o que é seu
 * (servidor, terceirizado, discente) registra e vê as PRÓPRIAS sem passar por
 * "acesso ao módulo"; a equipe (`ocorrencia.ver`) vê todas e, com
 * `ocorrencia.tratar`, assume, acompanha e conclui. Enquanto o módulo está
 * seguro na produção (`ocorrenciasLiberado`), toda rota dele é 404.
 */
import { Hono } from "hono";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { ErroHttp, RegraViolada } from "../nucleo/erros.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import { ocorrenciasLiberado } from "../config.js";
import {
  MEIOS_DESLOCAMENTO,
  NIVEIS_ENSINO,
  ROTULO_MEIO_DESLOCAMENTO,
  ROTULO_NIVEL_ENSINO,
  ROTULO_SIM_NAO,
  ROTULO_SITUACAO,
  ROTULO_TIPO,
  ROTULO_VINCULO,
  SITUACOES,
  SITUACOES_ENCERRADAS,
  TIPOS,
  VINCULOS,
  tipos_da_lista,
} from "../dominio/ocorrencia.js";
import { exigir_acesso_ao_modulo } from "../servicos/acesso_modulo.js";
import { linha_csv } from "../servicos/csv.js";
import { data_local, hoje, local_formatado } from "../servicos/datas_br.js";
import { ESCOPO_PROPRIO, type UsuarioAtual } from "../servicos/rbac.js";
import * as servico from "../servicos/ocorrencia.js";
import { comMensagem, marcarDownload, pagina, redirecionar } from "../web.js";

export const rotas = new Hono<Ambiente>();

const _liberado = async (_c: Ctx, seguir: () => Promise<void>) => {
  if (!ocorrenciasLiberado()) throw new ErroHttp(404, "Página não encontrada.");
  await seguir();
};
rotas.use("/ocorrencias", _liberado);
rotas.use("/ocorrencias/*", _liberado);

export const PAINEL = "/ocorrencias";
export const REGISTRAR = "/ocorrencias/registrar";
export const MINHAS = "/ocorrencias/minhas";
export const FILA = "/ocorrencias/fila";
export const EXPORTAR = "/ocorrencias/exportar";
export const INDICADORES = "/ocorrencias/indicadores";

const ROTULOS = {
  ROTULO_SITUACAO,
  ROTULO_TIPO,
  ROTULO_VINCULO,
  ROTULO_NIVEL_ENSINO,
  ROTULO_SIM_NAO,
  ROTULO_MEIO_DESLOCAMENTO,
  TIPOS,
  VINCULOS,
  NIVEIS_ENSINO,
  MEIOS_DESLOCAMENTO,
  SITUACOES,
};

function _recados(c: Ctx) {
  return { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null };
}

/** A porta do titular: o escopo próprio não é da equipe do módulo e não passa por "acesso ao módulo". */
async function _porta_titular(c: Ctx, permissao: string): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  usuario.exigir(permissao);
  if (usuario.escopo_de(permissao) !== ESCOPO_PROPRIO) exigir_acesso_ao_modulo(usuario, "ocorrencias");
  return usuario;
}

/** A porta da equipe: a permissão e o acesso ao módulo. */
async function _porta_equipe(c: Ctx, ...permissoes: string[]): Promise<UsuarioAtual> {
  const usuario = await usuarioLogado(c);
  for (const p of permissoes) usuario.exigir(p);
  exigir_acesso_ao_modulo(usuario, "ocorrencias");
  return usuario;
}

/** A ocorrência com os tipos já por extenso, para a lista. */
function _vestir(o: servico.Ocorrencia) {
  return { ...o, tipos_rotulos: tipos_da_lista(o.tipos).map((t) => ROTULO_TIPO[t] ?? t).join(", ") };
}

const _data = (v: string | undefined) => (v ?? "").match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? null;

function _filtro(c: Ctx): servico.Filtro {
  const campus = Number(c.req.query("campus") ?? "");
  return {
    situacao: c.req.query("situacao") ?? "",
    campus_id: Number.isInteger(campus) && campus > 0 ? campus : null,
    tipo: c.req.query("tipo") ?? "",
    vinculo: c.req.query("vinculo") ?? "",
    de: _data(c.req.query("de")),
    ate: _data(c.req.query("ate")),
  };
}

// =====================================================================
// Painel
// =====================================================================
rotas.get(PAINEL, async (c) => {
  const usuario = await usuarioLogado(c);
  const equipe = usuario.pode("ocorrencia.ver");
  if (equipe) exigir_acesso_ao_modulo(usuario, "ocorrencias");
  else usuario.exigir("ocorrencia.registrar");
  const tx = c.get("tx");
  const contagem = await servico.contagem_por_situacao(tx, usuario);
  return pagina(c, "paginas/ocorrencias_painel.html", usuario, {
    pessoal: !equipe,
    contagem,
    total: Object.values(contagem).reduce((s, n) => s + n, 0),
    pode_registrar: usuario.pode("ocorrencia.registrar"),
    pode_indicadores: equipe && usuario.pode("indicador.ver"),
    ...ROTULOS,
    ..._recados(c),
  });
});

// =====================================================================
// Registrar
// =====================================================================
async function _tela_registrar(c: Ctx, usuario: UsuarioAtual, extra: Record<string, unknown> = {}, status = 200) {
  const tx = c.get("tx");
  return pagina(
    c,
    "paginas/ocorrencias_registrar.html",
    usuario,
    { campi: await servico.campi(tx), d: {}, tipos_marcados: [], ...ROTULOS, ...extra },
    status,
  );
}

rotas.get(REGISTRAR, async (c) => {
  const usuario = await _porta_titular(c, "ocorrencia.registrar");
  return _tela_registrar(c, usuario, { d: { pessoa_vinculo: "ESTUDANTE", eh_a_pessoa: "" } });
});

rotas.post(REGISTRAR, async (c) => {
  const usuario = await _porta_titular(c, "ocorrencia.registrar");
  const f = await formulario(c);
  const campo = (n: string) => f.texto(n).trim();
  const d: servico.DadosOcorrencia = {
    data_hora: campo("data_hora"),
    campus_id: f.inteiro("campus_id") ?? 0,
    local_descricao: campo("local_descricao"),
    tipos: f.todos("tipo"),
    tipo_outro: campo("tipo_outro"),
    descricao: campo("descricao"),
    observacoes: campo("observacoes"),
    durante_atividade: campo("durante_atividade"),
    eh_a_pessoa: f.texto("eh_a_pessoa") === "1",
    pessoa_nome: campo("pessoa_nome"),
    pessoa_vinculo: campo("pessoa_vinculo"),
    pessoa_vinculo_outro: campo("pessoa_vinculo_outro"),
    nivel_ensino: campo("nivel_ensino"),
    curso: campo("curso"),
    setor_lotacao: campo("setor_lotacao"),
    acidente_em_servico: campo("acidente_em_servico"),
    empresa: campo("empresa"),
    funcao: campo("funcao"),
    notificante_telefone: campo("notificante_telefone"),
    encaminhada_pronto_atendimento: f.texto("encaminhada") === "sim",
    meio_deslocamento: campo("meio_deslocamento"),
    meio_deslocamento_outro: campo("meio_deslocamento_outro"),
  };
  let nova: servico.Ocorrencia;
  try {
    nova = await c.get("tx").transaction((sp) => servico.registrar(sp as Parameters<typeof servico.registrar>[0], usuario, d));
  } catch (erro) {
    if (!(erro instanceof RegraViolada)) throw erro;
    return _tela_registrar(
      c,
      usuario,
      {
        d: { ...Object.fromEntries([...f.dados.entries()].filter(([, v]) => typeof v === "string")), eh_a_pessoa: f.texto("eh_a_pessoa"), encaminhada: f.texto("encaminhada") },
        tipos_marcados: f.todos("tipo"),
        erro_form: erro.message,
      },
      422,
    );
  }
  const equipe = usuario.pode("ocorrencia.ver");
  return redirecionar(
    c,
    comMensagem(equipe ? `/ocorrencias/${nova.id}` : MINHAS, `Ocorrência ${nova.protocolo} registrada. A equipe foi avisada pela fila e vai acompanhar.`),
  );
});

// =====================================================================
// As minhas
// =====================================================================
rotas.get(MINHAS, async (c) => {
  const usuario = await _porta_titular(c, "ocorrencia.registrar");
  // o recorte "só as minhas" vale mesmo para a equipe: aqui é a lista pessoal
  const todas = await servico.listar(c.get("tx"), usuario, {}, 500);
  const minhas = todas.filter((o) => o.registrado_por === usuario.id);
  return pagina(c, "paginas/ocorrencias_minhas.html", usuario, { ocorrencias: minhas.map(_vestir), ...ROTULOS, ..._recados(c) });
});

// =====================================================================
// A fila da equipe
// =====================================================================
rotas.get(FILA, async (c) => {
  const usuario = await _porta_equipe(c, "ocorrencia.ver");
  const filtro = _filtro(c);
  const tx = c.get("tx");
  const ocorrencias = await servico.listar(tx, usuario, filtro, 500);
  return pagina(c, "paginas/ocorrencias_fila.html", usuario, {
    ocorrencias: ocorrencias.map(_vestir),
    filtro,
    campi: await servico.campi(tx),
    campus_nome: Object.fromEntries((await servico.campi(tx)).map((k) => [k.id, k.nome])),
    pode_exportar: usuario.pode("exportar"),
    // o mesmo recorte para o link da planilha
    consulta: new URLSearchParams(
      Object.entries({ situacao: filtro.situacao, campus: filtro.campus_id ? String(filtro.campus_id) : "", tipo: filtro.tipo, vinculo: filtro.vinculo, de: filtro.de, ate: filtro.ate })
        .filter(([, v]) => v)
        .map(([k, v]) => [k, String(v)]),
    ).toString(),
    ...ROTULOS,
    ..._recados(c),
  });
});

// =====================================================================
// A planilha: sem o nome da pessoa e sem o relato (dado sensível)
// =====================================================================
export async function exportar(tx: Parameters<typeof servico.listar>[0], usuario: UsuarioAtual, filtro: servico.Filtro = {}) {
  usuario.exigir("ocorrencia.ver");
  usuario.exigir("exportar");
  exigir_acesso_ao_modulo(usuario, "ocorrencias");
  const campi = new Map((await servico.campi(tx)).map((k) => [k.id, k.nome]));
  const linhas = await servico.listar(tx, usuario, filtro, 5000);
  let texto = linha_csv([
    "Protocolo", "Data e hora", "Campus", "Local", "Tipos", "Vínculo da pessoa", "Durante o trabalho/estudo",
    "Encaminhada a pronto atendimento", "Meio de deslocamento", "Situação",
  ]);
  for (const o of linhas) {
    texto += linha_csv([
      o.protocolo,
      local_formatado(o.data_hora),
      campi.get(o.campus_id) ?? "",
      o.local_descricao,
      tipos_da_lista(o.tipos).map((t) => ROTULO_TIPO[t] ?? t).join(" | "),
      ROTULO_VINCULO[o.pessoa_vinculo] ?? o.pessoa_vinculo,
      o.durante_atividade ? (ROTULO_SIM_NAO[o.durante_atividade] ?? "") : "",
      o.encaminhada_pronto_atendimento ? "Sim" : "Não",
      o.meio_deslocamento ? (ROTULO_MEIO_DESLOCAMENTO[o.meio_deslocamento] ?? "") : "",
      ROTULO_SITUACAO[o.situacao] ?? o.situacao,
    ]);
  }
  return { nome: `ocorrencias-${hoje()}.csv`, corpo: new TextEncoder().encode("﻿" + texto) };
}

rotas.get(EXPORTAR, async (c) => {
  const usuario = await _porta_equipe(c, "ocorrencia.ver", "exportar");
  const { nome, corpo } = await exportar(c.get("tx"), usuario, _filtro(c));
  marcarDownload(c);
  return c.body(corpo as unknown as ArrayBuffer, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${nome}"`,
  });
});

// =====================================================================
// Indicadores
// =====================================================================
rotas.get(INDICADORES, async (c) => {
  const usuario = await _porta_equipe(c, "ocorrencia.ver", "indicador.ver");
  const filtro = _filtro(c);
  const tx = c.get("tx");
  return pagina(c, "paginas/ocorrencias_indicadores.html", usuario, {
    ind: await servico.indicadores(tx, usuario, filtro),
    filtro,
    campi: await servico.campi(tx),
    ...ROTULOS,
  });
});

// =====================================================================
// A ficha
// =====================================================================
rotas.get("/ocorrencias/:id{[0-9]+}", async (c) => {
  const usuario = await _porta_titular(c, "ocorrencia.registrar").catch(async () => _porta_equipe(c, "ocorrencia.ver"));
  const tx = c.get("tx");
  const o = await servico.carregar(tx, usuario, Number(c.req.param("id")));
  const equipe = usuario.pode("ocorrencia.ver");
  const campi = Object.fromEntries((await servico.campi(tx)).map((k) => [k.id, k.nome]));
  return pagina(c, "paginas/ocorrencia_ficha.html", usuario, {
    o,
    equipe,
    pode_tratar: equipe && usuario.pode("ocorrencia.tratar") && !SITUACOES_ENCERRADAS.has(o.situacao),
    encerrada: SITUACOES_ENCERRADAS.has(o.situacao),
    campus: campi[o.campus_id] ?? "",
    tipos: tipos_da_lista(o.tipos),
    acompanhamentos: equipe ? await servico.acompanhamentos(tx, o.id) : [],
    cat_protocolo: await servico.protocolo_do_acidente(tx, o.acidente_id),
    pode_comunicar_acidente: usuario.pode("acidente.comunicar"),
    pode_vincular: equipe && usuario.pode("ocorrencia.tratar") && usuario.pode("acidente.ver"),
    ...ROTULOS,
    ..._recados(c),
  });
});

type Acao = (tx: Parameters<typeof servico.assumir>[0], u: UsuarioAtual, o: servico.Ocorrencia, f: Awaited<ReturnType<typeof formulario>>) => Promise<string>;

function _acao(sufixo: string, executar: Acao) {
  rotas.post(`/ocorrencias/:id{[0-9]+}/${sufixo}`, async (c) => {
    const usuario = await _porta_equipe(c, "ocorrencia.ver", "ocorrencia.tratar");
    const f = await formulario(c);
    const id = Number(c.req.param("id"));
    const volta = `/ocorrencias/${id}`;
    try {
      const texto = await c.get("tx").transaction(async (sp) => {
        const tx = sp as Parameters<typeof servico.assumir>[0];
        const o = await servico.carregar(tx, usuario, id);
        return executar(tx, usuario, o, f);
      });
      return redirecionar(c, comMensagem(volta, texto));
    } catch (erro) {
      if (!(erro instanceof RegraViolada)) throw erro;
      return redirecionar(c, comMensagem(volta, erro.message, "erro"));
    }
  });
}

_acao("assumir", async (tx, u, o) => {
  await servico.assumir(tx, u, o);
  return `${o.protocolo} assumida: a ocorrência está em acompanhamento.`;
});
_acao("acompanhar", async (tx, u, o, f) => {
  await servico.acompanhar(tx, u, o, f.texto("texto"));
  return "Acompanhamento registrado.";
});
_acao("concluir", async (tx, u, o, f) => {
  await servico.concluir(tx, u, o, f.texto("conclusao"));
  return `${o.protocolo} concluída.`;
});
_acao("cancelar", async (tx, u, o, f) => {
  await servico.cancelar(tx, u, o, f.texto("motivo"));
  return `${o.protocolo} cancelada.`;
});
_acao("vincular-acidente", async (tx, u, o, f) => {
  await servico.vincular_acidente(tx, u, o, f.texto("protocolo_cat"));
  return `${o.protocolo} vinculada à comunicação de acidente.`;
});
