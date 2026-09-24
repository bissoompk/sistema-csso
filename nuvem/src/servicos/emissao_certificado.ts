/**
 * Regras da emissão do certificado: validação, congelamento, lote e anulação.
 * Porte de `app/servicos/emissao_certificado.py`.
 *
 * **RN-15 é o coração da fatia.** Um certificado emitido reimprime do
 * congelado, nunca do catálogo de hoje. `montar_contexto` tem uma única porta
 * de saída para certificado emitido, e ela lê `contexto_congelado`.
 *
 * A ordem da emissão é a do §4 do desenho, e a ordem importa:
 *
 * 1. `usuario.exigir("certificado.emitir")`
 * 2. recusar se a inscrição já tem certificado não anulado (RN-14)
 * 3. validar tudo — turma, resultado, assinatura, modelo, tags obrigatórias
 * 4. **só agora** consumir o número
 * 5. gerar a chave de validação
 * 6. montar o contexto e **congelar antes de renderizar**
 * 7. renderizar o .docx
 * 8. auditar
 * 9. o PDF — que na nuvem não existe (`pdf.disponivel()` é falso): sai o .docx
 *    com o aviso que o Python já dava sem LibreOffice (PORTE.md §8).
 */
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  anexo as tabela_anexo,
  certificado as tabela_certificado,
  certificado_modelo as tabela_modelo,
  inscricao as tabela_inscricao,
  parametro as tabela_parametro,
} from "../db/esquema/index.js";
import { AssinaturaInstrutor, Certificado as C, CertificadoModelo, ROTULO_VINCULO, Turma as T } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexo_acesso from "./anexo_acesso.js";
import * as auditoria from "./auditoria.js";
import * as servico_certificado from "./certificado.js";
import { ContextoCertificado } from "./certificado.js";
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import * as numeracao from "./numeracao.js";
import { setor_emissor_vigente } from "./parecer.js";
import { nome_exibicao } from "./participante.js";
import * as servico_pdf from "./pdf.js";
import * as servico_presenca from "./presenca.js";
import * as servico_servidores from "./servidores.js";
import { aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import {
  COM_TAGS,
  inscricoes_da_turma,
  type InscricaoCarregada,
  type ModeloCarregado,
  type TurmaCarregada,
  type VinculoInstrutor,
} from "./turma.js";

export const CERTIFICADO_EMITIDO = "CERTIFICADO_EMITIDO";
export const CERTIFICADO_ANULADO = "CERTIFICADO_ANULADO";
export const CERTIFICADO_SEGUNDA_VIA = "CERTIFICADO_SEGUNDA_VIA";
export const CERTIFICADO_DIVERGENTE = "CERTIFICADO_DIVERGENTE";
export const CERTIFICADO_LOTE = "CERTIFICADO_LOTE";

export const SUBPASTA = "certificados";
export const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const PARAMETRO_URL_PUBLICA = "certificado.url_publica";

// tentativas de sorteio antes de desistir (~49 bits de entropia)
export const TENTATIVAS_CHAVE = 5;

export type CertificadoRegistro = typeof tabela_certificado.$inferSelect;

/**
 * O que impede este certificado de sair, tudo de uma vez — lista, e não
 * primeiro erro, pela mesma razão do `DadosIncompletos` do parecer.
 */
export class EmissaoBloqueada extends RegraViolada {
  constructor(public motivos: string[]) {
    super("Emissão bloqueada: " + motivos.join("; "));
  }
}

/** Anulação recusada (o `ValueError` do Python). */
export class AnulacaoRecusada extends RegraViolada {}

export class Validacao {
  bloqueios: string[] = [];
  avisos: string[] = [];
  get ok(): boolean {
    return this.bloqueios.length === 0;
  }
}

// ---------------------------------------------------------------------
// Leitura auxiliar
// ---------------------------------------------------------------------
/**
 * A raiz do endereço público, sem barra no fim. Vem de `parametro`
 * (`certificado.url_publica`), e não do ambiente: é o endereço pelo qual a
 * instituição publica o certificado, e o coordenador o ajusta.
 *
 * DESVIO: sem parâmetro, o Python caía em `http(s)://{host}:{porta}` do
 * `.env`. Na nuvem não há host nem porta locais: cai em `CSSO_URL_PUBLICA`,
 * depois na `URL` que o Netlify define para o site, e só então no endereço de
 * desenvolvimento.
 */
export async function url_base_validacao(tx: Executor): Promise<string> {
  const [parametro] = await tx.select().from(tabela_parametro).where(eq(tabela_parametro.chave, PARAMETRO_URL_PUBLICA));
  if (parametro && (parametro.valor ?? "").trim()) return parametro.valor.trim().replace(/\/+$/, "");
  const doAmbiente = (process.env.CSSO_URL_PUBLICA || process.env.URL || "").trim();
  if (doAmbiente) return doAmbiente.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORTA || "8765"}`;
}

/**
 * Uma leitura só, já filtrada pelo escopo do perfil. `certificado.campus_id` e
 * `servidor_id` existem exatamente para isto (§8). A ficha, a segunda via, a
 * anulação e o anexo alcançam a MESMA linha por aqui.
 */
export async function no_escopo(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_id: number,
): Promise<CertificadoRegistro | null> {
  const [achado] = await tx
    .select()
    .from(tabela_certificado)
    .where(and(aplicar_escopo(usuario, tabela_certificado), eq(tabela_certificado.id, certificado_id)));
  return achado ?? null;
}

/**
 * Devolve `true` quando a leitura é do certificado de OUTRA pessoa. Ler o
 * próprio exige `treinamento.ver`; ler o de outro exige `certificado.ver` — a
 * mesma assimetria da ficha de EPI.
 */
export function exigir_leitura_do_certificado(usuario: UsuarioAtual, servidor_id: number | null): boolean {
  const propria = usuario.servidor_id !== null && usuario.servidor_id === servidor_id;
  if (propria) {
    usuario.exigir("treinamento.ver");
    return false;
  }
  usuario.exigir("certificado.ver");
  return true;
}

// O download do anexo do certificado herda a regra DAQUI (anexo_acesso.ts):
// a mesma linha e o mesmo rigor da ficha.
anexo_acesso.declarar_porta("certificado_no_escopo", (tx, usuario, id) => no_escopo(tx, usuario, id));
anexo_acesso.declarar_porta("exigir_leitura_do_certificado", (usuario, servidor_id) => {
  exigir_leitura_do_certificado(usuario, servidor_id);
});

/**
 * A condição de "meus certificados": `servidor_id` fixo no da conta, sem
 * `aplicar_escopo` (não alarga quando o escopo do perfil alargar). `-1` no
 * lugar de null para não virar `servidor_id IS NULL`.
 */
export function consulta_do_titular(usuario: UsuarioAtual) {
  return eq(tabela_certificado.servidor_id, usuario.servidor_id ?? -1);
}

/** O não anulado. É a mesma consulta que `presenca.certificado_ativo` faz. */
export function certificado_da_inscricao(tx: Executor, inscricao: { id: number }) {
  return servico_presenca.certificado_ativo(tx, inscricao);
}

/** `{inscricao_id: certificado não anulado}` — uma consulta para a aba toda. */
export async function certificados_da_turma(
  tx: Executor,
  turma: { id: number },
): Promise<Record<number, CertificadoRegistro>> {
  const linhas = await tx
    .select({ c: tabela_certificado })
    .from(tabela_certificado)
    .innerJoin(tabela_inscricao, eq(tabela_inscricao.id, tabela_certificado.inscricao_id))
    .where(and(eq(tabela_inscricao.turma_id, turma.id), ne(tabela_certificado.situacao, "ANULADO")));
  return Object.fromEntries(linhas.map(({ c }) => [c.inscricao_id, c]));
}

/**
 * Qual layout sai, e o aviso quando a escolha merece um. **O ponteiro manda**
 * (`treinamento.modelo_vigente_id`); versão superada avisa e segue. Sem
 * ponteiro, cai no modelo genérico vigente — havendo mais de um, a emissão para.
 */
export async function modelo_da_turma(tx: Executor, turma: TurmaCarregada): Promise<[ModeloCarregado | null, string]> {
  const treinamento = turma.treinamento;
  if (treinamento.modelo_vigente) {
    const modelo = treinamento.modelo_vigente;
    if (!modelo.vigente) {
      return [
        modelo,
        `o catálogo aponta ${CertificadoModelo.rotulo(modelo)}, que é uma versão superada — ` +
          "o certificado sai com esse layout; se não for o desejado, " +
          "aponte a versão vigente em /treinamentos/catalogo antes de emitir",
      ];
    }
    return [modelo, ""];
  }
  const genericos = (await tx.query.certificado_modelo.findMany({
    where: and(isNull(tabela_modelo.treinamento_id), eq(tabela_modelo.vigente, true)),
    with: COM_TAGS as never,
    orderBy: [asc(tabela_modelo.id)],
  })) as unknown as ModeloCarregado[];
  if (genericos.length === 1) {
    return [
      genericos[0]!,
      `'${treinamento.nome}' não tem modelo próprio — saiu no modelo genérico ${CertificadoModelo.rotulo(genericos[0]!)}`,
    ];
  }
  return [null, ""];
}

export function instrutores_que_assinam(turma: TurmaCarregada): VinculoInstrutor[] {
  return [...turma.instrutores]
    .sort((a, b) => a.ordem - b.ordem || a.assinatura_instrutor_id - b.assinatura_instrutor_id)
    .filter((v) => v.assina_certificado);
}

/**
 * `documentos/certificados/{ano}/Certificado_0007-2026_TUR-…_Nome.docx` — a
 * chave no armazenamento (o `dados/documentos/...` do Python).
 */
export function caminho_saida(certificado: CertificadoRegistro, extensao = "docx"): string {
  const congelado = (certificado.contexto_congelado ?? {}) as Record<string, unknown>;
  const turma_codigo = String(congelado.turma_codigo ?? "");
  const nome = String(congelado.participante_nome ?? "");
  const partes = [
    "Certificado",
    `${String(certificado.numero).padStart(4, "0")}-${certificado.ano}`,
    textos.slug_ascii(turma_codigo.replaceAll("-", "_")).replaceAll("_", "-"),
    [...textos.slug_ascii(nome)].slice(0, 60).join(""),
  ];
  return `documentos/${SUBPASTA}/${certificado.ano}/${partes.filter((p) => p).join("_")}.${extensao}`;
}

// ---------------------------------------------------------------------
// Validação (§4, passo 3)
// ---------------------------------------------------------------------
/**
 * Tudo o que precisa ser verdade para o certificado sair. Roda também fora da
 * emissão: a aba 4 usa esta função para dizer quem está apto antes do clique.
 */
export async function validar(
  tx: Executor,
  inscricao: InscricaoCarregada,
  opcoes: { quando?: string | null } = {},
): Promise<Validacao> {
  const quando = opcoes.quando ?? datas_br.hoje();
  const v = new Validacao();
  const turma = inscricao.turma;

  if (turma.situacao !== "CONCLUIDA") {
    v.bloqueios.push(`${turma.codigo} ainda não foi concluída — o certificado atesta um curso que terminou`);
  }
  if (inscricao.situacao === "REPROVADO") {
    const motivos = servico_presenca.avaliar(turma, inscricao).motivos;
    v.bloqueios.push(
      `${nome_exibicao(inscricao.participante)} está reprovado` + (motivos.length ? ` (${motivos.join("; ")})` : ""),
    );
  } else if (inscricao.situacao !== "APROVADO") {
    v.bloqueios.push(
      `${nome_exibicao(inscricao.participante)} está ${inscricao.situacao.toLowerCase()} e não tem resultado de aprovação`,
    );
  }

  // reconferidas a partir dos lançamentos, e não lidas da coluna derivada
  const frequencia = servico_presenca.frequencia_de(inscricao);
  if (servico_presenca.comparar(frequencia, turma.frequencia_minima_percentual) < 0) {
    v.bloqueios.push(
      `frequência de ${servico_presenca.numero(frequencia)}% abaixo do ` +
        `mínimo de ${servico_presenca.numero(turma.frequencia_minima_percentual)}%`,
    );
  }
  if (turma.nota_minima_aprovacao !== null) {
    if (inscricao.nota_final === null) {
      v.bloqueios.push(
        `a turma exige nota mínima de ${servico_presenca.numero(turma.nota_minima_aprovacao)} e não há nota lançada`,
      );
    } else if (servico_presenca.comparar(inscricao.nota_final, turma.nota_minima_aprovacao) < 0) {
      v.bloqueios.push(
        `nota ${servico_presenca.numero(inscricao.nota_final)} abaixo da ` +
          `mínima ${servico_presenca.numero(turma.nota_minima_aprovacao)}`,
      );
    }
  }

  const assinantes = instrutores_que_assinam(turma);
  if (!assinantes.length) {
    v.bloqueios.push(`${turma.codigo} não tem nenhum instrutor marcado para assinar o certificado`);
  }
  for (const vinculo of assinantes) {
    if (!AssinaturaInstrutor.vigente_em(vinculo.instrutor, quando)) {
      v.bloqueios.push(
        `a assinatura de ${AssinaturaInstrutor.nome_exibicao(vinculo.instrutor)} não vigora em ${datas_br.numerica(quando)}`,
      );
    }
  }

  const [modelo, aviso_modelo] = await modelo_da_turma(tx, turma);
  if (aviso_modelo) v.avisos.push(aviso_modelo);
  if (modelo === null) {
    v.bloqueios.push(
      `'${turma.treinamento.nome}' não tem modelo de certificado — aponte ` +
        "um em /treinamentos/catalogo ou cadastre um modelo genérico",
    );
    return v;
  }

  const mapa = CertificadoModelo.mapa_de_tags(modelo);
  const rotulo = CertificadoModelo.rotulo(modelo);
  if (!Object.keys(mapa).length) {
    v.bloqueios.push(`o modelo ${rotulo} não tem nenhuma tag no dicionário — o certificado sairia em branco`);
  }
  const desconhecidos = Object.values(mapa)
    .filter((campo) => !Object.hasOwn(servico_certificado.CAMPOS_CERTIFICADO, campo))
    .sort();
  if (desconhecidos.length) {
    v.bloqueios.push(`o modelo ${rotulo} aponta campo que não existe no vocabulário: ` + desconhecidos.join(", "));
  }

  const conferencia = servico_certificado.conferir_modelo(modelo.arquivo, mapa);
  if (!conferencia.ok) {
    if (!conferencia.arquivo_encontrado) {
      v.bloqueios.push(`o arquivo '${modelo.arquivo}' não está em app/templates/certificados/`);
    } else {
      // sem esta guarda o certificado sai com `{{ nome }}` impresso no papel
      v.bloqueios.push(`o .docx de ${rotulo} tem marcador sem linha no dicionário: ` + conferencia.sem_mapa.join(", "));
    }
  } else {
    const sha = servico_certificado.sha256_do_modelo(modelo.arquivo);
    if (modelo.arquivo_sha256 && sha && sha !== modelo.arquivo_sha256) {
      v.avisos.push(
        `o arquivo de ${rotulo} mudou desde o cadastro (SHA-256 diferente do registrado): confira o layout`,
      );
    }
  }
  return v;
}

// ---------------------------------------------------------------------
// Montagem do contexto
// ---------------------------------------------------------------------
async function _dados_do_instrutor(tx: Executor, vinculo: VinculoInstrutor) {
  const instrutor = vinculo.instrutor;
  let rubrica: string | null = null;
  if (instrutor.imagem_anexo_id !== null) {
    const [anexo] = await tx.select().from(tabela_anexo).where(eq(tabela_anexo.id, instrutor.imagem_anexo_id));
    rubrica = anexo ? anexo.sha256 : null;
  }
  return {
    nome: AssinaturaInstrutor.nome_exibicao(instrutor),
    titulo: instrutor.titulo || "",
    conselho: instrutor.conselho || "",
    registro: AssinaturaInstrutor.registro_completo(instrutor),
    // o SHA-256, e não o `anexo_id`: trocar a rubrica passa a ser detectável
    rubrica_sha256: rubrica,
  };
}

/**
 * A unidade em que o participante estava NA DATA DA TURMA — não a de hoje.
 */
async function _lotacao_na_data(tx: Executor, inscricao: InscricaoCarregada, quando: string): Promise<string> {
  const servidor = inscricao.participante.servidor;
  if (!servidor) return "";
  const lotacao = await servico_servidores.lotacao_em(tx, servidor.id, quando);
  let unidade = lotacao?.unidade ?? null;
  if (!unidade && servidor.unidade_uorg_id !== null) {
    unidade = (await tx.query.unidade_uorg.findFirst({ where: (u, { eq: e }) => e(u.id, servidor.unidade_uorg_id!) })) ?? null;
  }
  return unidade ? unidade.nome_extenso : "";
}

/**
 * O contexto do catálogo de HOJE — usado uma única vez, na emissão. Depois de
 * congelado, `montar_contexto` nunca mais passa por aqui.
 */
export async function montar_contexto_para_emitir(
  tx: Executor,
  inscricao: InscricaoCarregada,
  d: { numero: number; ano: number; data_emissao: string; chave: string; modelo: ModeloCarregado; avisos?: string[] },
): Promise<ContextoCertificado> {
  const turma = inscricao.turma;
  const treinamento = turma.treinamento;
  const participante = inscricao.participante;
  const servidor = participante.servidor;
  const setor = await setor_emissor_vigente(tx, d.data_emissao);
  const validade = Number(treinamento.validade_meses || 0);
  const base = T.data_base(turma);
  const vencimento = validade > 0 ? datas_br.somar_meses(base, validade) : null;
  const mapa = CertificadoModelo.mapa_de_tags(d.modelo);
  const instrutores = [];
  for (const v of instrutores_que_assinam(turma)) instrutores.push(await _dados_do_instrutor(tx, v));

  return new ContextoCertificado({
    participante_nome: nome_exibicao(participante),
    participante_identificador: participante.identificador_publico,
    participante_vinculo: ROTULO_VINCULO[participante.vinculo] ?? participante.vinculo,
    participante_organizacao: participante.organizacao || (servidor ? "UFVJM" : ""),
    participante_siape: servidor ? servidor.siape : "",
    participante_lotacao: await _lotacao_na_data(tx, inscricao, turma.data_inicio),
    treinamento_nome: treinamento.nome,
    treinamento_norma: treinamento.norma_referencia || "",
    // o conteúdo inteiro como TEXTO, e não a FK
    treinamento_conteudo: treinamento.conteudo_programatico || "",
    validade_meses: validade,
    turma_codigo: turma.codigo,
    turma_data_inicio: turma.data_inicio,
    turma_data_fim: turma.data_fim,
    carga_horaria: T.carga_efetiva(turma),
    turma_local: turma.local || "",
    turma_unidade_promotora: turma.unidade_promotora ? turma.unidade_promotora.nome_extenso : "",
    turma_campus: turma.campus ? turma.campus.nome : "",
    data_base_vencimento: base,
    nota_final: inscricao.nota_final,
    frequencia_percentual: servico_presenca.frequencia_de(inscricao),
    nota_minima: turma.nota_minima_aprovacao,
    frequencia_minima: turma.frequencia_minima_percentual,
    instrutores,
    numero: d.numero,
    ano: d.ano,
    data_emissao: d.data_emissao,
    chave_validacao: d.chave,
    data_vencimento: vencimento,
    url_validacao: `${await url_base_validacao(tx)}/validar/${d.chave}`,
    setor_sigla: setor ? setor.sigla_composta : "",
    setor_nome: setor ? setor.nome_extenso : "",
    setor_endereco: setor ? setor.endereco || "" : "",
    cidade: setor ? setor.cidade : "Diamantina",
    modelo_id: d.modelo.id,
    modelo_arquivo: d.modelo.arquivo,
    modelo_sha256: servico_certificado.sha256_do_modelo(d.modelo.arquivo),
    modelo_versao: d.modelo.versao,
    mapa_tags: { ...mapa },
    tags_obrigatorias: d.modelo.tags
      .filter((t) => t.obrigatorio)
      .map((t) => t.marcador)
      .sort(),
    avisos: [...(d.avisos ?? [])],
  });
}

/**
 * RN-15: certificado emitido reimprime do congelado, não do catálogo de hoje.
 * É a única porta de leitura de contexto de um certificado gravado.
 */
export function montar_contexto(_tx: Executor | null, certificado: CertificadoRegistro): ContextoCertificado {
  return ContextoCertificado.descongelar(certificado.contexto_congelado as Record<string, unknown>);
}

// ---------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------
export interface ResultadoEmissao {
  certificado: CertificadoRegistro;
  /** a chave do .docx no armazenamento (o `Path` do Python) */
  docx: string;
  /** os bytes do .docx (a rota devolve; o teste extrai o texto) */
  bytes: Uint8Array;
  pdf: string | null;
  aviso_pdf: string | null;
  avisos: string[];
}

async function _chave_inedita(tx: Executor, ano: number): Promise<string> {
  for (let i = 0; i < TENTATIVAS_CHAVE; i++) {
    const chave = servico_certificado.gerar_chave(ano);
    const [ja] = await tx
      .select({ id: tabela_certificado.id })
      .from(tabela_certificado)
      .where(eq(tabela_certificado.chave_validacao, chave))
      .limit(1);
    if (!ja) return chave;
  }
  throw new EmissaoBloqueada(["não foi possível sortear uma chave de validação inédita"]);
}

/** Emite o certificado da inscrição, na ordem do §4 do desenho. */
export async function emitir(
  tx: Executor,
  usuario: UsuarioAtual,
  inscricao: InscricaoCarregada,
  opcoes: { data_emissao?: string | null; gerar_pdf?: boolean } = {},
): Promise<ResultadoEmissao> {
  usuario.exigir("certificado.emitir");

  // 2. RN-14: um documento por vez. A reemissão passa pela anulação.
  const ja = await certificado_da_inscricao(tx, inscricao);
  if (ja) {
    throw new EmissaoBloqueada([
      `${nome_exibicao(inscricao.participante)} já tem o certificado ${C.rotulo(ja)}: anule-o com o motivo antes de reemitir`,
    ]);
  }

  const hoje = opcoes.data_emissao ?? datas_br.hoje();
  const ano = datas_br.partes(hoje)[0];
  // 3. validar TUDO antes de gastar número
  const validacao = await validar(tx, inscricao, { quando: hoje });
  if (!validacao.ok) throw new EmissaoBloqueada(validacao.bloqueios);

  const [modelo] = await modelo_da_turma(tx, inscricao.turma);
  if (modelo === null) throw new EmissaoBloqueada(["não há modelo de certificado para esta turma"]);

  // 4. o número, só agora
  const numero = await numeracao.proximo_numero_certificado(tx, ano);
  // 5. a chave
  const chave = await _chave_inedita(tx, ano);

  // 6. montar e congelar ANTES de renderizar
  const contexto = await montar_contexto_para_emitir(tx, inscricao, {
    numero,
    ano,
    data_emissao: hoje,
    chave,
    modelo,
    avisos: validacao.avisos,
  });
  const faltantes = await contexto.obrigatorios_faltantes();
  if (faltantes.length) throw new EmissaoBloqueada(["marcador obrigatório sem valor: " + faltantes.join(", ")]);

  const turma = inscricao.turma;
  const [linha] = await tx
    .insert(tabela_certificado)
    .values({
      inscricao_id: inscricao.id,
      numero,
      ano,
      chave_validacao: chave,
      situacao: "EMITIDO",
      data_emissao: hoje,
      data_base_vencimento: contexto.data_base_vencimento,
      data_vencimento: contexto.data_vencimento,
      validade_meses_congelada: contexto.validade_meses,
      // o que sai no papel é o que fica guardado, e nesta ordem
      contexto_congelado: contexto.congelar(),
      modelo_id: modelo.id,
      modelo_arquivo: modelo.arquivo,
      modelo_sha256: contexto.modelo_sha256,
      servidor_id: inscricao.participante.servidor_id,
      campus_id: turma.campus_id,
      treinamento_id: turma.treinamento_id,
      participante_id: inscricao.participante_id,
      emitido_por: usuario.id,
      emitido_em: agora_utc(),
    })
    .returning();
  let certificado = linha!;

  // 7. renderizar
  const destino = caminho_saida(certificado);
  const info = await servico_certificado.renderizar(contexto, destino);
  [certificado] = (await tx
    .update(tabela_certificado)
    .set({ arquivo_docx: destino, hash_conteudo: info.hash_conteudo })
    .where(eq(tabela_certificado.id, certificado.id))
    .returning()) as [CertificadoRegistro];

  // 8. trilha — RN-19 na ESCRITA: o documento é nominal, a prosa da trilha não
  await auditoria.registrar(tx, {
    entidade: "certificado",
    entidade_id: certificado.id,
    tipo_evento: CERTIFICADO_EMITIDO,
    descricao:
      `Certificado ${C.rotulo(certificado)} de ${contexto.participante_identificador} · ` +
      `${turma.codigo} · ${contexto.treinamento_nome} · chave ${chave}`,
    usuario,
    valor_novo: { numero: certificado.numero, ano: certificado.ano, hash_conteudo: certificado.hash_conteudo },
  });
  for (const aviso of validacao.avisos) {
    await auditoria.registrar(tx, {
      entidade: "certificado",
      entidade_id: certificado.id,
      tipo_evento: "AVISO",
      descricao: aviso,
      usuario,
    });
  }

  // 9. o PDF. Na nuvem é sempre o ramo "sem LibreOffice": o .docx é o
  // documento, com o aviso, e a trilha não ganha `PDF_NAO_GERADO`.
  let aviso_pdf: string | null = null;
  if (opcoes.gerar_pdf ?? true) {
    const conversao = servico_pdf.converter_fora_da_transacao(tx, destino, destino.replace(/\.docx$/, ".pdf"));
    aviso_pdf = conversao.aviso;
    if (conversao.aviso !== null && !conversao.indisponivel) {
      await auditoria.registrar(tx, {
        entidade: "certificado",
        entidade_id: certificado.id,
        tipo_evento: auditoria.PDF_NAO_GERADO,
        descricao:
          `Certificado ${C.rotulo(certificado)} emitido, mas o PDF não ficou ` +
          `anexado. O .docx está em ${destino.split("/").pop()} e vale como o ` +
          `documento; reimprima pela segunda via. Detalhe: ${conversao.aviso}`,
        usuario,
      });
    }
  }
  return { certificado, docx: destino, bytes: info.bytes, pdf: null, aviso_pdf, avisos: [...validacao.avisos] };
}

// ---------------------------------------------------------------------
// Lote
// ---------------------------------------------------------------------
export class ItemDoLote {
  constructor(
    readonly inscricao: InscricaoCarregada,
    readonly certificado: CertificadoRegistro | null = null,
    readonly erro: string | null = null,
  ) {}
  get ok(): boolean {
    return this.certificado !== null;
  }
}

export class RelatorioDoLote {
  itens: ItemDoLote[] = [];
  get emitidos(): ItemDoLote[] {
    return this.itens.filter((i) => i.ok);
  }
  get travados(): ItemDoLote[] {
    return this.itens.filter((i) => !i.ok);
  }
  get resumo(): string {
    if (!this.itens.length) return "ninguém apto a emitir";
    return `${this.emitidos.length} emitido(s), ${this.travados.length} travado(s)`;
  }
}

/**
 * Uma turma de trinta pessoas não se emite uma a uma.
 *
 * **Um item que falha no meio não derruba os que já saíram nem os que vêm
 * depois.** DESVIO: no Python cada certificado tinha a própria transação
 * (`s.commit()` por item). Aqui a requisição inteira é UMA transação (a
 * função do Netlify), e cada item roda num SAVEPOINT: o item que falha desfaz
 * só o que ele escreveu (número inclusive), e os outros ficam. A diferença é
 * que nada do lote é gravado se a requisição inteira cair depois — o Python
 * já teria comitado os primeiros.
 */
export async function emitir_lote(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  opcoes: { inscricao_ids?: number[] | null; gerar_pdf?: boolean; data_emissao?: string | null } = {},
): Promise<RelatorioDoLote> {
  usuario.exigir("certificado.emitir");
  const escolhidas = opcoes.inscricao_ids ? new Set(opcoes.inscricao_ids) : null;
  const alvos = (await inscricoes_da_turma(tx, turma)).filter((i) => escolhidas === null || escolhidas.has(i.id));
  const ja_emitidos = await certificados_da_turma(tx, turma);
  const relatorio = new RelatorioDoLote();
  for (const inscricao of alvos) {
    // quem já tem certificado simplesmente não entra de novo
    if (Object.hasOwn(ja_emitidos, inscricao.id)) continue;
    if (inscricao.situacao !== "APROVADO") continue;
    try {
      const emitido = await tx.transaction(async (sp) =>
        emitir(sp as Executor, usuario, inscricao, { gerar_pdf: opcoes.gerar_pdf, data_emissao: opcoes.data_emissao }),
      );
      relatorio.itens.push(new ItemDoLote(inscricao, emitido.certificado));
    } catch (erro) {
      relatorio.itens.push(new ItemDoLote(inscricao, null, (erro as Error).message));
    }
  }
  await auditoria.registrar(tx, {
    entidade: "turma",
    entidade_id: turma.id,
    tipo_evento: CERTIFICADO_LOTE,
    descricao: `${turma.codigo}: ${relatorio.resumo}`,
    usuario,
  });
  return relatorio;
}

// ---------------------------------------------------------------------
// Anulação
// ---------------------------------------------------------------------
/**
 * `situacao = 'ANULADO'`, com motivo obrigatório. O documento não é apagado:
 * anular é o que libera a reemissão e o que faz a página pública responder
 * ANULADO.
 */
export async function anular(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: CertificadoRegistro,
  motivo: string | null | undefined,
  opcoes: { substituido_por?: CertificadoRegistro | null } = {},
): Promise<CertificadoRegistro> {
  usuario.exigir("certificado.anular");
  const limpo = (motivo ?? "").trim();
  if (!limpo) {
    throw new AnulacaoRecusada(
      "Anular exige o motivo: é o único registro que sobra para quem " +
        "receber o papel antigo e perguntar por que ele não vale mais.",
    );
  }
  if (C.anulado(certificado)) throw new AnulacaoRecusada(`O certificado ${C.rotulo(certificado)} já está anulado.`);

  const campos: Partial<CertificadoRegistro> = {
    situacao: "ANULADO",
    motivo_anulacao: limpo,
    anulado_em: agora_utc(),
    anulado_por: usuario.id,
  };
  if (opcoes.substituido_por) campos.substituido_por_id = opcoes.substituido_por.id;
  await tx.update(tabela_certificado).set(campos).where(eq(tabela_certificado.id, certificado.id));
  Object.assign(certificado, campos);

  await auditoria.registrar(tx, {
    entidade: "certificado",
    entidade_id: certificado.id,
    tipo_evento: CERTIFICADO_ANULADO,
    descricao: `Certificado ${C.rotulo(certificado)} anulado: ${limpo}`,
    campo: "situacao",
    valor_anterior: "EMITIDO",
    valor_novo: "ANULADO",
    comentario: limpo,
    usuario,
  });
  return certificado;
}

// ---------------------------------------------------------------------
// Segunda via
// ---------------------------------------------------------------------
export interface ResultadoSegundaVia {
  docx: string;
  bytes: Uint8Array;
  hash_conteudo: string;
  confere: boolean;
  aviso: string | null;
}

/**
 * Reimprime do congelado e confere o hash contra o da emissão. Certificado
 * anulado também tem segunda via: quem precisa juntar ao processo o papel que
 * foi anulado precisa do papel.
 */
export async function segunda_via(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: CertificadoRegistro,
  _opcoes: { gerar_pdf?: boolean } = {},
): Promise<ResultadoSegundaVia> {
  // chamada pelo efeito: é ela que levanta para quem não pode ler
  exigir_leitura_do_certificado(usuario, certificado.servidor_id);
  const contexto = montar_contexto(tx, certificado);
  const destino = caminho_saida(certificado);
  const info = await servico_certificado.renderizar(contexto, destino);
  const confere = certificado.hash_conteudo === null || certificado.hash_conteudo === info.hash_conteudo;
  let aviso: string | null = null;
  if (!confere) {
    aviso =
      `O texto reimpresso do certificado ${C.rotulo(certificado)} não confere ` +
      "com o da emissão — o arquivo do modelo provavelmente foi trocado " +
      "fora do sistema. A segunda via saiu assim mesmo e a divergência foi " +
      "registrada na trilha.";
    await auditoria.registrar(tx, {
      entidade: "certificado",
      entidade_id: certificado.id,
      tipo_evento: CERTIFICADO_DIVERGENTE,
      descricao: aviso,
      campo: "hash_conteudo",
      valor_anterior: certificado.hash_conteudo,
      valor_novo: info.hash_conteudo,
      usuario,
    });
  }
  await auditoria.registrar(tx, {
    entidade: "certificado",
    entidade_id: certificado.id,
    tipo_evento: CERTIFICADO_SEGUNDA_VIA,
    descricao:
      `Segunda via do certificado ${C.rotulo(certificado)} ` +
      `(${contexto.participante_identificador}) · ${info.hash_conteudo.slice(0, 12)}`,
    usuario,
  });
  // a segunda via do PRÓPRIO certificado não entra em `acesso_dado_sensivel`
  await auditoria.registrar_leitura_nominal(tx, usuario, "certificado", {
    servidor_id: certificado.servidor_id,
    finalidade: "segunda via do certificado de treinamento",
  });
  return { docx: destino, bytes: info.bytes, hash_conteudo: info.hash_conteudo, confere, aviso };
}

/** A trilha do certificado, mais nova primeiro (a ficha). */
export async function trilha(tx: Executor, certificado_id: number) {
  const { historico_evento } = await import("../db/esquema/index.js");
  return tx
    .select()
    .from(historico_evento)
    .where(and(eq(historico_evento.entidade, "certificado"), eq(historico_evento.entidade_id, certificado_id)))
    .orderBy(desc(historico_evento.id));
}

/** Os bytes renderizados, para quem precisa só do texto (os testes). */
export function texto_do_docx(bytes: Uint8Array): string {
  return documento.extrair_texto(bytes);
}
