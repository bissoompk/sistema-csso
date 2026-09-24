/**
 * /certificados — os emitidos, a ficha, a segunda via e a anulação.
 * Porte de `app/rotas/certificados.py`.
 *
 * A emissão em si mora na aba 4 de `/turmas/{id}`; aqui ficam a consulta, a
 * segunda via a partir do congelado e a anulação. Nenhuma regra mora neste
 * arquivo: a guarda que importa é a do serviço (`emissao_certificado.ts`).
 */
import { Hono } from "hono";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import type { Executor } from "../db/cliente.js";
import { certificado as tabela_certificado, treinamento as tabela_treinamento } from "../db/esquema/index.js";
import { Certificado as C, ROTULO_CERTIFICADO, SITUACOES_CERTIFICADO } from "../dominio/treinamento.js";
import { formulario, usuarioLogado } from "../dependencias.js";
import * as auditoria from "../servicos/auditoria.js";
import { CAMPOS_CERTIFICADO, normalizar_chave } from "../servicos/certificado.js";
import * as datas_br from "../servicos/datas_br.js";
import * as servico from "../servicos/emissao_certificado.js";
import { COM_PARTICIPANTE } from "../servicos/participante.js";
import { aplicar_escopo, type UsuarioAtual } from "../servicos/rbac.js";
import { numeroDaPagina, pagina, recortarConsulta, redirecionar } from "../web.js";
import { baixar } from "./turmas.js";
import { erro as _erro, id_opcional, recados, volta as _volta, vista_certificado } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

export const CERTIFICADOS = "/certificados";
export const MEUS = `${CERTIFICADOS}/meus`;

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
    substituto,
    hoje,
    situacao_publica: C.situacao_publica(certificado, hoje),
    rotulo_certificado: ROTULO_CERTIFICADO,
    eventos: await servico.trilha(tx, certificado.id),
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
