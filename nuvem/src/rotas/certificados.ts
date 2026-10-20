/**
 * /certificados — os emitidos, a ficha, a segunda via e a anulação.
 * Porte de `app/rotas/certificados.py`.
 *
 * A emissão em si mora na aba 4 de `/turmas/{id}`; aqui ficam a consulta, a
 * segunda via a partir do congelado e a anulação. Nenhuma regra mora neste
 * arquivo: a guarda que importa é a do serviço (`emissao_certificado.ts`).
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import { certificado as tabela_certificado, treinamento as tabela_treinamento } from "../db/esquema/index.js";
import {
  Certificado as C,
  DIAS_AVISO_RECICLAGEM,
  ROTULO_CERTIFICADO,
  ROTULO_RECICLAGEM,
  ROTULO_TIPO_TAG,
  SITUACOES_CERTIFICADO,
} from "../dominio/treinamento.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import * as auditoria from "../servicos/auditoria.js";
import { CAMPOS_CERTIFICADO, normalizar_chave } from "../servicos/certificado.js";
import * as datas_br from "../servicos/datas_br.js";
import * as servico from "../servicos/emissao_certificado.js";
import { COM_PARTICIPANTE } from "../servicos/participante.js";
import { aplicar_escopo, type UsuarioAtual } from "../servicos/rbac.js";
import { numeroDaPagina, pagina, recortarConsulta, redirecionar } from "../web.js";
import { TIPO_PDF } from "../servicos/certificado_pdf.js";
import * as conversor_pdf from "../servicos/conversor_pdf.js";
import * as reciclagem from "../servicos/reciclagem.js";
import * as fila_emissao from "../servicos/fila_emissao.js";
import * as email from "../servicos/email.js";
import * as envio_certificado from "../servicos/envio_certificado.js";
import { parece_cpf } from "../servicos/textos.js";
import { baixar } from "./turmas.js";
import { erro as _erro, id_opcional, recados, volta as _volta, vista_certificado } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const CERTIFICADOS = "/certificados";
export const MEUS = `${CERTIFICADOS}/meus`;
export const VENCIMENTOS = `${CERTIFICADOS}/vencimentos`;
export const FILA = `${CERTIFICADOS}/fila`;
export const EMAILS = `${CERTIFICADOS}/emails`;

/** Os certificados de uma página, com o que a lista lê (participante e treinamento). */
async function _pagina_de_certificados(c: Ctx, onde: SQL | undefined) {
  const tx = c.get("tx");
  return recortarConsulta(
    async () => Number((await tx.select({ n: count() }).from(tabela_certificado).where(onde))[0]?.n ?? 0),
    async (limite, deslocamento) =>
      (
        await tx.query.certificado.findMany({
          where: onde,
          with: { participante: { with: COM_PARTICIPANTE }, treinamento: true } as never,
          orderBy: [desc(tabela_certificado.ano), desc(tabela_certificado.numero)],
          limit: limite,
          offset: deslocamento,
        })
      ).map((x) => vista_certificado(x as Record<string, any>)),
    numeroDaPagina(c),
  );
}

// =====================================================================
// Lista
// =====================================================================
rotas.get(CERTIFICADOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  const tx = c.get("tx");
  const situacao = c.req.query("situacao") ?? "";
  const treinamento_id = c.req.query("treinamento_id") ?? "";
  const busca = c.req.query("busca") ?? "";
  const filtros: (SQL | undefined)[] = [aplicar_escopo(usuario, tabela_certificado)];
  if ((SITUACOES_CERTIFICADO as readonly string[]).includes(situacao)) filtros.push(eq(tabela_certificado.situacao, situacao));
  const alvo = id_opcional(treinamento_id);
  if (alvo !== null) filtros.push(eq(tabela_certificado.treinamento_id, alvo));
  const limpa = busca.trim();
  // busca pela CHAVE, e não por nome: é o que o suporte faz com o papel na mão
  if (limpa) filtros.push(eq(tabela_certificado.chave_validacao, normalizar_chave(limpa)));
  const recorte = await _pagina_de_certificados(c, and(...filtros));
  const hoje = datas_br.hoje();
  return pagina(c, "paginas/certificados.html", usuario, {
    itens: recorte.itens,
    recorte,
    hoje,
    situacao_publica: Object.fromEntries(recorte.itens.map((x) => [x.id, C.situacao_publica(x as never, hoje)])),
    rotulo_certificado: ROTULO_CERTIFICADO,
    situacoes: SITUACOES_CERTIFICADO.map((codigo) => [codigo, ROTULO_CERTIFICADO[codigo]]),
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    filtro_situacao: situacao,
    filtro_treinamento: treinamento_id,
    busca,
    ...recados(c),
  });
});

// =====================================================================
// Monitor de reciclagem — o em vigor de cada pessoa, pelo vencimento
// =====================================================================
rotas.get(VENCIMENTOS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  const tx = c.get("tx");
  const situacao = c.req.query("situacao") ?? "";
  const treinamento_id = c.req.query("treinamento_id") ?? "";
  const busca = c.req.query("busca") ?? "";
  // o CPF não se busca (RN-21): dizer, em vez de devolver "ninguém"
  const busca_cpf = parece_cpf(busca);
  const hoje = datas_br.hoje();
  const { itens, contagem } = await reciclagem.monitor(tx, usuario, hoje, {
    situacao,
    treinamento_id: id_opcional(treinamento_id),
    busca: busca_cpf ? "" : busca,
  });
  return pagina(c, "paginas/certificados_vencimentos.html", usuario, {
    itens,
    contagem,
    hoje,
    dias_aviso: DIAS_AVISO_RECICLAGEM,
    situacoes: Object.entries(ROTULO_RECICLAGEM),
    rotulo_reciclagem: ROTULO_RECICLAGEM,
    treinamentos: await tx
      .select()
      .from(tabela_treinamento)
      .where(gt(tabela_treinamento.validade_meses, 0))
      .orderBy(asc(tabela_treinamento.nome)),
    filtro_situacao: situacao,
    filtro_treinamento: treinamento_id,
    busca,
    busca_cpf,
  });
});

// =====================================================================
// Fila de emissão — todas as turmas, pela etapa de cada inscrição
// =====================================================================
async function _tela_fila(c: Ctx, usuario: UsuarioAtual, d: { mensagem?: string | null; erro?: string | null; travados?: fila_emissao.ResultadoFila["travados"] } = {}) {
  const tx = c.get("tx");
  const etapa = c.req.query("etapa") ?? "AGUARDANDO";
  const treinamento_id = c.req.query("treinamento_id") ?? "";
  const busca = c.req.query("busca") ?? "";
  const busca_cpf = parece_cpf(busca);
  const { itens, contagem, cortado } = await fila_emissao.fila(tx, usuario, {
    etapa,
    treinamento_id: id_opcional(treinamento_id),
    busca: busca_cpf ? "" : busca,
  });
  return pagina(c, "paginas/certificados_fila.html", usuario, {
    itens,
    contagem,
    cortado,
    limite: fila_emissao.LIMITE_LINHAS,
    etapas: fila_emissao.ETAPAS.map((e) => [e, fila_emissao.ROTULO_ETAPA[e]]),
    filtro_etapa: (fila_emissao.ETAPAS as readonly string[]).includes(etapa) ? etapa : "AGUARDANDO",
    filtro_treinamento: treinamento_id,
    busca,
    busca_cpf,
    treinamentos: await tx.select().from(tabela_treinamento).orderBy(asc(tabela_treinamento.nome)),
    pode_emitir: usuario.pode("certificado.emitir"),
    travados: d.travados ?? [],
    ...recados(c),
    ...(d.mensagem ? { mensagem: d.mensagem } : {}),
    ...(d.erro ? { erro: d.erro } : {}),
  });
}

rotas.get(FILA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  return _tela_fila(c, usuario);
});

rotas.post(`${FILA}/emitir`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.ver");
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const f = await formulario(c);
  const ids = [...new Set(f.todos("inscricao_id").map((v) => id_opcional(v)).filter((v): v is number => v !== null))];
  if (!ids.length) return _erro(c, FILA, "Marque quem vai receber o certificado.");
  const resultado = await fila_emissao.emitir_escolhidas(tx, usuario, ids);
  const frase =
    `${resultado.emitidos} certificado(s) emitido(s)` +
    (resultado.travados.length ? `, ${resultado.travados.length} travado(s) — o motivo está abaixo.` : ".");
  // o travado fica na tela com o motivo: o recado da URL não cabe a lista
  if (resultado.travados.length) {
    return _tela_fila(c, usuario, { [resultado.emitidos ? "mensagem" : "erro"]: frase, travados: resultado.travados });
  }
  return _volta(c, FILA, frase);
});

// =====================================================================
// Meus certificados — a tela do titular (antes de /certificados/{id})
// =====================================================================
/**
 * O certificado do próprio servidor. Tela separada de `/certificados`: a
 * permissão do item de menu é outra (`treinamento.ver`) e o filtro é fixo no
 * `servidor_id` da conta.
 */
rotas.get(MEUS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("treinamento.ver");
  const recorte = await _pagina_de_certificados(c, servico.consulta_do_titular(usuario));
  const hoje = datas_br.hoje();
  return pagina(c, "paginas/certificados_meus.html", usuario, {
    itens: recorte.itens,
    recorte,
    hoje,
    situacao_publica: Object.fromEntries(recorte.itens.map((x) => [x.id, C.situacao_publica(x as never, hoje)])),
    // a conta sem cadastro de servidor não é erro: é a tela dizendo por que está vazia
    sem_servidor: usuario.servidor_id === null,
  });
});

/** Para onde volta quem pediu um certificado que não alcança. */
function _volta_da_ficha(usuario: UsuarioAtual): string {
  return usuario.pode("certificado.ver") ? CERTIFICADOS : MEUS;
}

/**
 * A linha e a relação com ela: `[certificado | null, de_outro]`. A ordem dos três
 * passos evita transformar a URL num enumerador: quem não tem `certificado.ver`
 * nem cadastro de servidor leva o 403 antes de o banco ser tocado; `no_escopo`
 * decide QUAL linha; `exigir_leitura_do_certificado` decide o RIGOR.
 */
async function _abrir(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_id: number,
): Promise<[servico.CertificadoRegistro | null, boolean]> {
  if (!usuario.pode("certificado.ver") && usuario.servidor_id === null) usuario.exigir("certificado.ver");
  const certificado = await servico.no_escopo(tx, usuario, certificado_id);
  if (!certificado) return [null, false];
  return [certificado, servico.exigir_leitura_do_certificado(usuario, certificado.servidor_id)];
}

// =====================================================================
// Ficha
// =====================================================================
/** O congelado, o hash, a trilha e o link público. */
rotas.get(`${CERTIFICADOS}/:certificado_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const [certificado] = await _abrir(tx, usuario, Number(c.req.param("certificado_id")));
  if (!certificado) return redirecionar(c, _volta_da_ficha(usuario));
  // ler o certificado nominal de OUTRA pessoa entra em `acesso_dado_sensivel`
  await auditoria.registrar_leitura_nominal(tx, usuario, "certificado", {
    servidor_id: certificado.servidor_id,
    finalidade: "consulta da ficha do certificado de treinamento",
  });
  const contexto = servico.montar_contexto(tx, certificado);
  let substituto = null;
  if (certificado.substituido_por_id) {
    const [s] = await tx.select().from(tabela_certificado).where(eq(tabela_certificado.id, certificado.substituido_por_id));
    substituto = s ? vista_certificado(s as Record<string, any>) : null;
  }
  const hoje = datas_br.hoje();
  return pagina(c, "paginas/certificado_ficha.html", usuario, {
    certificado: vista_certificado(certificado as Record<string, any>),
    contexto,
    campos: CAMPOS_CERTIFICADO,
    rotulo_tipo_tag: ROTULO_TIPO_TAG,
    substituto,
    hoje,
    situacao_publica: C.situacao_publica(certificado, hoje),
    rotulo_certificado: ROTULO_CERTIFICADO,
    eventos: await servico.trilha(tx, certificado.id),
    envios: usuario.pode("certificado.emitir") ? await envio_certificado.envios_do_certificado(tx, certificado.id) : [],
    destinatario: usuario.pode("certificado.emitir") ? await envio_certificado.destinatario(tx, certificado) : "",
    rotulo_envio: email.ROTULO_SITUACAO,
    ...recados(c),
  });
});

// =====================================================================
// Segunda via
// =====================================================================
/**
 * A segunda via, reimpressa **do congelado**. Sai também para certificado
 * anulado: quem precisa juntar ao processo o papel anulado precisa do papel.
 */
rotas.get(`${CERTIFICADOS}/:certificado_id{[0-9]+}/documento`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const [certificado] = await _abrir(tx, usuario, Number(c.req.param("certificado_id")));
  if (!certificado) return redirecionar(c, _volta_da_ficha(usuario));
  const resultado = await servico.segunda_via(tx, usuario, certificado);
  return baixar(c, resultado.bytes, resultado.docx.split("/").pop()!, servico.TIPO_DOCX);
});

/** O certificado em PDF, com o QR da validação: o papel que circula. */
rotas.get(`${CERTIFICADOS}/:certificado_id{[0-9]+}/pdf`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const [certificado] = await _abrir(tx, usuario, Number(c.req.param("certificado_id")));
  if (!certificado) return redirecionar(c, _volta_da_ficha(usuario));
  // modelo enviado: o PDF da casa não é o papel dele. Sai o do conversor
  // (LibreOffice); sem ele, ou com ele fora do ar, o link leva ao Word
  if (servico.do_modelo_enviado(certificado)) {
    if (conversor_pdf.configurado()) {
      try {
        const fiel = await servico.pdf_do_modelo_enviado(tx, usuario, certificado);
        return baixar(c, fiel.bytes, fiel.nome, TIPO_PDF);
      } catch (erro) {
        if (!(erro instanceof conversor_pdf.ConversorIndisponivel)) throw erro;
        console.error(`[certificado ${certificado.id}] ${erro.message}`);
      }
    }
    return redirecionar(c, `${CERTIFICADOS}/${certificado.id}/documento`);
  }
  const resultado = await servico.pdf_do_certificado(tx, usuario, certificado);
  return baixar(c, resultado.bytes, resultado.nome, TIPO_PDF);
});

// =====================================================================
// Envio por e-mail
// =====================================================================
/** Envia (ou reenvia) este certificado ao e-mail do participante. */
rotas.post(`${CERTIFICADOS}/:certificado_id{[0-9]+}/email`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  const certificado_id = Number(c.req.param("certificado_id"));
  const destino = `${CERTIFICADOS}/${certificado_id}`;
  const r = await envio_certificado.pedir_envio(c.get("tx"), usuario, [certificado_id], { reenviar: true });
  if (!r.enfileirados) {
    return _erro(c, destino, r.sem_email ? "O participante não tem e-mail cadastrado." : "Este certificado não pode ser enviado.");
  }
  await email.acordar_envio();
  return _volta(c, destino, envio_certificado.resumo(r));
});

/** A caixa de saída: o que foi, o que está na fila, o que falhou. */
rotas.get(EMAILS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const situacao = c.req.query("situacao") ?? "";
  const filtro = Object.hasOwn(email.ROTULO_SITUACAO, situacao) ? situacao : "";
  return pagina(c, "paginas/emails.html", usuario, {
    itens: await email.caixa(tx, { situacao: filtro || undefined }),
    contagem: await email.contagem(tx),
    filtro,
    rotulos: email.ROTULO_SITUACAO,
    ...recados(c),
  });
});

rotas.post(`${EMAILS}/processar`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  // na transação da tela (o pool é de uma conexão): cada envio, um savepoint
  const r = await email.processar_fila(c.get("tx"), { prazo_ms: 8_000, limite: 10 });
  if (r.desligado) return _erro(c, EMAILS, "O envio de e-mail não está configurado.");
  return _volta(c, EMAILS, `${r.enviados} enviado(s), ${r.falhas} falha(s) nesta rodada.`);
});

rotas.post(`${EMAILS}/:email_id{[0-9]+}/:acao{tentar|cancelar}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.emitir");
  const tx = c.get("tx");
  const id = Number(c.req.param("email_id"));
  if (c.req.param("acao") === "tentar") {
    if (!(await email.reenfileirar(tx, id))) return _erro(c, EMAILS, "Só e-mail que falhou volta para a fila.");
    await email.acordar_envio();
    return _volta(c, EMAILS, "De volta à fila.");
  }
  if (!(await email.cancelar(tx, id))) return _erro(c, EMAILS, "Só e-mail na fila ou que falhou pode ser cancelado.");
  return _volta(c, EMAILS, "Envio cancelado.");
});

// =====================================================================
// Anulação
// =====================================================================
/** Anular libera a reemissão sem apagar o histórico (RN-14). */
rotas.post(`${CERTIFICADOS}/:certificado_id{[0-9]+}/anular`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("certificado.anular");
  const tx = c.get("tx");
  const f = await formulario(c);
  const certificado_id = Number(c.req.param("certificado_id"));
  const certificado = await servico.no_escopo(tx, usuario, certificado_id);
  if (!certificado) return redirecionar(c, CERTIFICADOS);
  const destino = `${CERTIFICADOS}/${certificado_id}`;
  try {
    await tx.transaction((sp) => servico.anular(sp as Executor, usuario, certificado, f.texto("motivo")));
  } catch (erro) {
    if (erro instanceof servico.AnulacaoRecusada) return _erro(c, destino, erro.message);
    throw erro;
  }
  return _volta(
    c,
    destino,
    `Certificado ${C.rotulo(certificado)} anulado. Para reemitir, volte à turma e emita de novo.`,
  );
});
