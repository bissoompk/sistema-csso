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
 * 9. o PDF — na nuvem não há LibreOffice (PORTE.md §8): não é gravado, sai na
 *    hora do congelado, com o QR, por `pdf_do_certificado` (`certificado_pdf.ts`).
 */
import { ambienteDeProducao } from "./instalacao.js";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  agora_utc,
  anexo as tabela_anexo,
  certificado as tabela_certificado,
  certificado_modelo as tabela_modelo,
  inscricao as tabela_inscricao,
  parametro as tabela_parametro,
} from "../db/esquema/index.js";
import {
  AssinaturaInstrutor,
  Certificado as C,
  CertificadoModelo,
  PADRAO_CODIGO_CURTO,
  ROTULO_VINCULO,
  Turma as T,
  montar_numero_impresso,
  prefixo_do_numero,
  sugerir_codigo_curto,
} from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as anexo_acesso from "./anexo_acesso.js";
import * as auditoria from "./auditoria.js";
import * as campos_certificado from "./campos_certificado.js";
import * as servico_certificado from "./certificado.js";
import { ContextoCertificado } from "./certificado.js";
import { CAMPO_CPF_INSTRUTOR, CAMPO_CPF_PARTICIPANTE } from "./cpf_certificado.js";
import * as datas_br from "./datas_br.js";
import * as documento from "./documento.js";
import { carimbar_tarja } from "./docx_baixo_nivel.js";
import * as numeracao from "./numeracao.js";
import { setor_emissor_vigente } from "./parecer.js";
import { nome_exibicao } from "./participante.js";
import * as certificado_pdf from "./certificado_pdf.js";
import * as conversor_pdf from "./conversor_pdf.js";
import * as servico_presenca from "./presenca.js";
import * as servico_servidores from "./servidores.js";
import { ESCOPO_PROPRIO, aplicar_escopo, type UsuarioAtual } from "./rbac.js";
import * as setor_equipe from "./setor_equipe.js";
import * as textos from "./textos.js";
import * as titular_externo from "./titular_externo.js";
import PizZip from "pizzip";
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
  // a mesma porta do `ferramentas/servidor-local.ts` (que define PORTA quando falta)
  return `http://127.0.0.1:${(process.env.PORTA ?? "").trim() || "8766"}`;
}

/**
 * O endereço público foi DECLARADO (parâmetro, `CSSO_URL_PUBLICA` ou a `URL`
 * que o Netlify define para o site)? O recuo de desenvolvimento (`127.0.0.1`)
 * não vale para um certificado de verdade: a URL vai congelada no texto do
 * documento e não se corrige depois de impresso. Em produção
 * (`CSSO_AMBIENTE=producao`) a emissão fica bloqueada sem ela (`validar`).
 * DESVIO: a `URL` do Netlify passou a contar — é o endereço em que o site
 * responde; quem quiser outro define o parâmetro.
 */
export async function url_publica_declarada(tx: Executor): Promise<boolean> {
  const [parametro] = await tx.select().from(tabela_parametro).where(eq(tabela_parametro.chave, PARAMETRO_URL_PUBLICA));
  return Boolean(
    (parametro?.valor ?? "").trim() || (process.env.CSSO_URL_PUBLICA ?? "").trim() || (process.env.URL ?? "").trim(),
  );
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
  // a LEITURA, por padrão. O ato passa a dele (`certificado.anular` em anular e
  // corrigir): pelo alcance da leitura, o perfil recortado num campus agia em
  // outro quando outra concessão alargava a leitura (D9) — e, com a concessão
  // do titular (D16), corrigia o próprio certificado emitido fora do campus dele
  permissao: string | readonly string[] = ["certificado.ver", "treinamento.ver"],
): Promise<CertificadoRegistro | null> {
  const [achado] = await tx
    .select()
    .from(tabela_certificado)
    .where(
      and(
        // o próprio pela `treinamento.ver`, o de outro pela `certificado.ver`:
        // o alcance de cada uma é o dela (D1/D9), e o rigor decide abaixo
        aplicar_escopo(usuario, tabela_certificado, permissao),
        // NUVEM: o alcance de equipe só chega ao certificado das turmas do
        // setor (`setor_equipe.ts`); o do próprio titular, de qualquer setor
        usuario.escopo_de(permissao) === ESCOPO_PROPRIO
          ? undefined
          : setor_equipe.condicao_setor_certificado(usuario, true),
        eq(tabela_certificado.id, certificado_id),
      ),
    );
  return achado ?? null;
}

/**
 * Segregação nos atos sobre o documento (D9/D16): ninguém anula nem corrige o
 * PRÓPRIO certificado. Corrigir é anular e reemitir com o dado novo — sobre o
 * próprio, é dar a si mesmo um documento que outra pessoa não conferiu.
 * Devolve o motivo, ou `null`.
 */
export function recusa_de_ato_sobre_o_proprio(
  usuario: UsuarioAtual,
  certificado: Pick<CertificadoRegistro, "servidor_id">,
): string | null {
  if (usuario.servidor_id === null || certificado.servidor_id !== usuario.servidor_id) return null;
  return "Este certificado é seu: anular ou corrigir o próprio certificado é ato de outra pessoa da equipe.";
}

/**
 * Devolve `true` quando a leitura é do certificado de OUTRA pessoa. Ler o
 * próprio exige `treinamento.ver`; ler o de outro exige `certificado.ver` — a
 * mesma assimetria da ficha de EPI.
 */
export function exigir_leitura_do_certificado(
  usuario: UsuarioAtual,
  servidor_id: number | null,
  // o terceirizado e o discente não têm `servidor_id`: quem chama diz se o
  // certificado é do participante ligado à conta (`do_titular_externo`)
  proprio_externo = false,
): boolean {
  const propria = proprio_externo || (usuario.servidor_id !== null && usuario.servidor_id === servidor_id);
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
anexo_acesso.declarar_porta("certificado_do_titular_externo", (tx, usuario, id) =>
  titular_externo.eh_titular_externo(usuario) ? do_titular_externo_por_id(tx, usuario, id) : Promise.resolve(null),
);
anexo_acesso.declarar_porta("exigir_leitura_do_certificado", (usuario, servidor_id) => {
  exigir_leitura_do_certificado(usuario, servidor_id);
});

/**
 * O certificado é do participante ligado à conta do terceirizado/discente
 * (`titular_externo.ts`)? Sempre `false` para quem não é titular externo — o
 * servidor responde pelo `servidor_id`.
 */
export async function do_titular_externo(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: Pick<CertificadoRegistro, "participante_id">,
): Promise<boolean> {
  const proprio = await titular_externo.id_do_participante_da_conta(tx, usuario);
  return proprio !== null && proprio === certificado.participante_id;
}

/**
 * A leitura do terceirizado/discente: o certificado `certificado_id` só se for
 * do participante ligado à conta. `aplicar_escopo` não serve aqui — o escopo
 * próprio dele recorta por `servidor_id`, que a conta não tem.
 */
export async function do_titular_externo_por_id(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado_id: number,
): Promise<CertificadoRegistro | null> {
  const proprio = await titular_externo.id_do_participante_da_conta(tx, usuario);
  if (proprio === null) return null;
  const [achado] = await tx
    .select()
    .from(tabela_certificado)
    .where(and(eq(tabela_certificado.id, certificado_id), eq(tabela_certificado.participante_id, proprio)));
  return achado ?? null;
}

/**
 * A condição de "meus certificados": `servidor_id` fixo no da conta, sem
 * `aplicar_escopo` (não alarga quando o escopo do perfil alargar). `-1` no
 * lugar de null para não virar `servidor_id IS NULL`. Para o terceirizado e o
 * discente, o participante ligado à conta (`participante_id`, de
 * `titular_externo.id_do_participante_da_conta`).
 */
export function consulta_do_titular(usuario: UsuarioAtual, participante_id: number | null = null) {
  if (titular_externo.eh_titular_externo(usuario)) return eq(tabela_certificado.participante_id, participante_id ?? -1);
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
 * ponteiro, cai no modelo genérico vigente — havendo mais de um, o mais
 * recente com o mapa completo (DESVIO: antes a emissão parava no empate).
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
    orderBy: [desc(tabela_modelo.criado_em), desc(tabela_modelo.id)],
  })) as unknown as ModeloCarregado[];
  if (genericos.length) {
    // o mais recente cujo mapa cobre o arquivo; nenhum cobrindo, o mais recente (e a validação diz o que falta)
    const escolhido =
      genericos.find((m) => servico_certificado.conferir_modelo(m, CertificadoModelo.marcadores_mapeados(m)).ok) ??
      genericos[0]!;
    return [
      escolhido,
      `'${treinamento.nome}' não tem modelo próprio — sai no modelo genérico ${CertificadoModelo.rotulo(escolhido)}`,
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
  opcoes: {
    quando?: string | null;
    // NUVEM: a aba Emissão lê os valores da turma inteira de uma vez e passa aqui
    valores_turma?: campos_certificado.Valores;
    valores_inscricao?: campos_certificado.Valores;
  } = {},
): Promise<Validacao> {
  const quando = opcoes.quando ?? datas_br.hoje();
  const v = new Validacao();
  const turma = inscricao.turma;

  // NUVEM: em produção o endereço do QR tem de ter sido declarado (ver
  // `url_publica_declarada`) — o recuo para a URL do Netlify não vale ali.
  if (ambienteDeProducao() && !(await url_publica_declarada(tx))) {
    v.bloqueios.push(
      "o endereço público de validação (parâmetro certificado.url_publica) não foi definido — " +
        "ele fica congelado no QR do certificado; defina-o antes da primeira emissão (PRODUCAO.md)",
    );
  }

  if (turma.situacao !== "CONCLUIDA") {
    v.bloqueios.push(`${turma.codigo} ainda não foi concluída — o certificado atesta um curso que terminou`);
  }
  // o reprovado leva UM bloqueio, com os motivos do fecho: as conferências de
  // frequência e nota abaixo repetiriam os mesmos motivos (M34)
  const reprovado = inscricao.situacao === "REPROVADO";
  if (reprovado) {
    v.bloqueios.push(
      `${nome_exibicao(inscricao.participante)} está ${servico_presenca.frase_de_reprovacao(turma, inscricao)}`,
    );
  } else if (inscricao.situacao !== "APROVADO") {
    v.bloqueios.push(
      `${nome_exibicao(inscricao.participante)} está ${inscricao.situacao.toLowerCase()} e não tem resultado de aprovação`,
    );
  }

  // reconferidas a partir dos lançamentos, e não lidas da coluna derivada
  const frequencia = servico_presenca.frequencia_de(inscricao);
  if (!reprovado && servico_presenca.comparar(frequencia, turma.frequencia_minima_percentual) < 0) {
    v.bloqueios.push(
      `frequência de ${servico_presenca.numero(frequencia)}% abaixo do ` +
        `mínimo de ${servico_presenca.numero(turma.frequencia_minima_percentual)}%`,
    );
  }
  if (!reprovado && turma.nota_minima_aprovacao !== null) {
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
  if (!modelo.tags.length) {
    v.bloqueios.push(`o modelo ${rotulo} não tem nenhuma tag no dicionário — o certificado sairia em branco`);
  }
  const desconhecidos = Object.values(mapa)
    .filter((campo) => !Object.hasOwn(servico_certificado.CAMPOS_CERTIFICADO, campo))
    .sort();
  if (desconhecidos.length) {
    v.bloqueios.push(`o modelo ${rotulo} aponta campo que não existe no vocabulário: ` + desconhecidos.join(", "));
  }

  const conferencia = servico_certificado.conferir_modelo(modelo, CertificadoModelo.marcadores_mapeados(modelo));
  if (!conferencia.ok) {
    if (!conferencia.arquivo_encontrado) {
      v.bloqueios.push(`o arquivo '${modelo.arquivo}' do modelo ${rotulo} não foi encontrado — envie o .docx de novo em /treinamentos/modelos`);
    } else {
      // sem esta guarda o certificado sai com `{{ nome }}` impresso no papel
      v.bloqueios.push(`o .docx de ${rotulo} tem marcador sem linha no dicionário: ` + conferencia.sem_mapa.join(", "));
    }
  } else {
    const sha = servico_certificado.sha256_do_modelo(modelo);
    if (modelo.arquivo_sha256 && sha && sha !== modelo.arquivo_sha256) {
      v.avisos.push(
        `o arquivo de ${rotulo} mudou desde o cadastro (SHA-256 diferente do registrado): confira o layout`,
      );
    }
  }

  // NUVEM: campos de turma/participante e texto fixo obrigatórios em branco
  if (modelo.tags.some((t) => campos_certificado.tipo_de(t) !== "SISTEMA")) {
    const [da_turma, do_participante] = await _valores_livres(tx, inscricao, opcoes);
    const livres = campos_certificado.resolver(modelo, da_turma, do_participante);
    v.bloqueios.push(...campos_certificado.pendencias(modelo, livres));
  }
  return v;
}

async function _valores_livres(
  tx: Executor,
  inscricao: InscricaoCarregada,
  dados: { valores_turma?: campos_certificado.Valores; valores_inscricao?: campos_certificado.Valores } = {},
): Promise<[campos_certificado.Valores, campos_certificado.Valores]> {
  return Promise.all([
    dados.valores_turma ?? campos_certificado.valores_da_turma(tx, inscricao.turma_id),
    dados.valores_inscricao ??
      campos_certificado.valores_das_inscricoes(tx, [inscricao.id]).then((v) => v[inscricao.id] ?? {}),
  ]);
}

// ---------------------------------------------------------------------
// Montagem do contexto
// ---------------------------------------------------------------------
async function _dados_do_instrutor(tx: Executor, vinculo: VinculoInstrutor, pede_cpf = false) {
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
    // CPF só quando o modelo o pede (minimização; `cpf_certificado.ts`)
    ...(pede_cpf && instrutor.cpf ? { cpf: instrutor.cpf } : {}),
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
  d: {
    numero: number;
    ano: number;
    data_emissao: string;
    chave: string;
    modelo: ModeloCarregado;
    avisos?: string[];
    // NUVEM (22/10/2026): `CSSO-NR35-2026-0001`; ausente = rótulo antigo
    numero_impresso?: string | null;
  },
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
  // o CPF entra no congelado só se algum marcador do modelo o pede
  const campos_do_mapa = new Set(Object.values(mapa));
  const pede_cpf_instrutor = campos_do_mapa.has(CAMPO_CPF_INSTRUTOR);
  const instrutores = [];
  for (const [n, v] of instrutores_que_assinam(turma).entries()) {
    // só o principal (o primeiro que assina) é o "responsável pela formação"
    instrutores.push(await _dados_do_instrutor(tx, v, pede_cpf_instrutor && n === 0));
  }
  // NUVEM: texto fixo e campos de turma/participante, resolvidos e congelados
  const [da_turma, do_participante] = await _valores_livres(tx, inscricao);
  const campos_livres = campos_certificado.resolver(d.modelo, da_turma, do_participante);

  return new ContextoCertificado({
    participante_nome: nome_exibicao(participante),
    participante_identificador: participante.identificador_publico,
    participante_vinculo: ROTULO_VINCULO[participante.vinculo] ?? participante.vinculo,
    participante_organizacao: participante.organizacao || (servidor ? "UFVJM" : ""),
    participante_siape: servidor ? servidor.siape : "",
    participante_lotacao: await _lotacao_na_data(tx, inscricao, turma.data_inicio),
    participante_cpf: campos_do_mapa.has(CAMPO_CPF_PARTICIPANTE) ? participante.cpf || null : null,
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
    turma_descricao: turma.descricao || "",
    turma_unidade_promotora: turma.unidade_promotora ? turma.unidade_promotora.nome_extenso : "",
    turma_campus: turma.campus ? turma.campus.nome : "",
    turma_campus_cidade: turma.campus ? turma.campus.cidade : "",
    data_base_vencimento: base,
    nota_final: inscricao.nota_final,
    frequencia_percentual: servico_presenca.frequencia_de(inscricao),
    nota_minima: turma.nota_minima_aprovacao,
    frequencia_minima: turma.frequencia_minima_percentual,
    instrutores,
    numero: d.numero,
    ano: d.ano,
    numero_impresso: d.numero_impresso ?? null,
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
    modelo_sha256: servico_certificado.sha256_do_modelo(d.modelo),
    modelo_chave: servico_certificado.chave_do_modelo(d.modelo),
    modelo_versao: d.modelo.versao,
    mapa_tags: { ...mapa },
    campos_livres,
    tags_obrigatorias: d.modelo.tags
      .filter((t) => t.obrigatorio)
      .map((t) => t.marcador)
      .sort(),
    avisos: [...(d.avisos ?? [])],
    // o PDF da emissão nova sai com as frases inteiras; o de antes, como saiu
    redacao: servico_certificado.REDACAO_ATUAL,
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

/**
 * NUVEM (22/10/2026): a chave do certificado novo é o número impresso mais 5
 * sorteados (`CSSO-NR35-2026-0001-K7QMX`). `gerar` existe para o teste; a
 * chave antiga (`gerar_chave(ano)`) não é mais emitida, só validada.
 */
async function _chave_inedita(tx: Executor, numero_impresso: string): Promise<string> {
  for (let i = 0; i < TENTATIVAS_CHAVE; i++) {
    const chave = servico_certificado.gerar_chave_do_numero(numero_impresso);
    const [ja] = await tx
      .select({ id: tabela_certificado.id })
      .from(tabela_certificado)
      .where(eq(tabela_certificado.chave_validacao, chave))
      .limit(1);
    if (!ja) return chave;
  }
  throw new EmissaoBloqueada(["não foi possível sortear uma chave de validação inédita"]);
}

/**
 * O código curto do treinamento como entra no número. A coluna é NOT NULL e a
 * trava preenche a sugestão, mas o treinamento carregado em memória pode vir
 * de antes da migração (ou de um teste): fora do formato, vale a sugestão — o
 * CHECK do número impresso não pode ser o primeiro a reclamar.
 */
function _codigo_curto(inscricao: InscricaoCarregada): string {
  const t = inscricao.turma.treinamento;
  const gravado = (t.codigo_curto ?? "").trim().toUpperCase();
  return _RE_CODIGO_CURTO.test(gravado) ? gravado : sugerir_codigo_curto(t.nome, t.codigo);
}

const _RE_CODIGO_CURTO = new RegExp(`^(?:${PADRAO_CODIGO_CURTO})$`);

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

  // 4. o número, só agora. O interno (numero/ano) continua a sequência anual
  // única; o IMPRESSO (22/10/2026) é sigla do setor promotor + código curto
  // do treinamento + ano + sequência anual daquele prefixo.
  const numero = await numeracao.proximo_numero_certificado(tx, ano);
  const prefixo = prefixo_do_numero(inscricao.turma.unidade_promotora?.sigla ?? null, _codigo_curto(inscricao));
  const { numero_impresso } = await numeracao.proximo_numero_impresso(tx, prefixo, ano, montar_numero_impresso);
  // 5. a chave: o número impresso + 5 sorteados (o QR e o link de validação)
  const chave = await _chave_inedita(tx, numero_impresso);

  // 6. montar e congelar ANTES de renderizar
  const contexto = await montar_contexto_para_emitir(tx, inscricao, {
    numero,
    ano,
    numero_impresso,
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
      numero_impresso,
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
    valor_novo: {
      numero: certificado.numero,
      ano: certificado.ano,
      numero_impresso: certificado.numero_impresso,
      hash_conteudo: certificado.hash_conteudo,
    },
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

  // 9. o PDF não é gravado: sai na hora, do congelado e com o QR, por
  // `pdf_do_certificado` (NUVEM: sem LibreOffice, ver `certificado_pdf.ts`).
  // Por isso não há aviso de "PDF indisponível" nem `PDF_NAO_GERADO`.
  void opcoes.gerar_pdf;
  const aviso_pdf: string | null = null;
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
/**
 * A frase da tarja do certificado anulado — "ANULADO em 21/10/2026 —
 * substituído por 14/2026" —, ou `null` para o que vale. Vai na SAÍDA (PDF e
 * Word): o congelado e o hash ficam como na emissão.
 */
export async function tarja_do_anulado(tx: Executor, certificado: CertificadoRegistro): Promise<string | null> {
  if (!C.anulado(certificado)) return null;
  const quando = datas_br.data_local(certificado.anulado_em);
  let frase = "ANULADO" + (quando ? ` em ${datas_br.numerica(quando)}` : "");
  if (certificado.substituido_por_id) {
    const [s] = await tx
      .select({ numero: tabela_certificado.numero, ano: tabela_certificado.ano, numero_impresso: tabela_certificado.numero_impresso })
      .from(tabela_certificado)
      .where(eq(tabela_certificado.id, certificado.substituido_por_id));
    if (s) return `${frase} — substituído por ${C.rotulo(s)}`;
  }
  frase += " — este certificado não vale mais";
  return frase;
}

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
 * foi anulado precisa do papel — mas ele sai com a tarja de ANULADO
 * (`tarja_do_anulado`), para não circular como válido.
 */
export async function segunda_via(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: CertificadoRegistro,
  _opcoes: { gerar_pdf?: boolean } = {},
): Promise<ResultadoSegundaVia> {
  // chamada pelo efeito: é ela que levanta para quem não pode ler
  exigir_leitura_do_certificado(usuario, certificado.servidor_id, await do_titular_externo(tx, usuario, certificado));
  const via = await _reimprimir(tx, certificado, usuario, "");
  // a segunda via do PRÓPRIO certificado não entra em `acesso_dado_sensivel`
  await auditoria.registrar_leitura_nominal(tx, usuario, "certificado", {
    servidor_id: certificado.servidor_id,
    finalidade: "segunda via do certificado de treinamento",
  });
  return via;
}

/**
 * NUVEM: a segunda via que o PRÓPRIO participante baixa pelo link que recebeu
 * no e-mail (`acesso_participante.ts`) — sem conta, e por isso sem usuário na
 * trilha. Quem chama já conferiu que o certificado é do dono do link.
 */
export async function segunda_via_do_titular(
  tx: Executor,
  certificado: CertificadoRegistro,
): Promise<ResultadoSegundaVia> {
  return _reimprimir(tx, certificado, null, " · pelo link de acesso do participante");
}

async function _reimprimir(
  tx: Executor,
  certificado: CertificadoRegistro,
  usuario: UsuarioAtual | null,
  como: string,
): Promise<ResultadoSegundaVia> {
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
      `(${contexto.participante_identificador}) · ${info.hash_conteudo.slice(0, 12)}${como}`,
    usuario,
  });
  // a tarja depois do hash: o texto conferido é o da emissão
  const tarja = await tarja_do_anulado(tx, certificado);
  const bytes = tarja ? carimbar_tarja(info.bytes, tarja) : info.bytes;
  return { docx: destino, bytes, hash_conteudo: info.hash_conteudo, confere, aviso };
}

/**
 * O certificado em PDF, com o QR da validação (`certificado_pdf.ts`). Passa
 * pela segunda via: a mesma regra de leitura, a conferência do texto contra o
 * da emissão e a mesma linha na trilha — o PDF é uma reimpressão do congelado.
 */
export async function pdf_do_certificado(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: CertificadoRegistro,
): Promise<{ nome: string; bytes: Uint8Array; aviso: string | null }> {
  const via = await segunda_via(tx, usuario, certificado);
  const bytes = await certificado_pdf.gerar_pdf([montar_contexto(tx, certificado)], [await tarja_do_anulado(tx, certificado)]);
  return { nome: caminho_saida(certificado, "pdf").split("/").pop()!, bytes, aviso: via.aviso };
}

/**
 * Certificado de modelo enviado pela tela: o layout é o do .docx do setor, e o
 * PDF daqui é o desenho da casa (`certificado_pdf.ts`), que não sabe dele — sem
 * os campos livres e com outro texto. Para esses, o papel é o Word.
 */
export function do_modelo_enviado(certificado: { contexto_congelado: Record<string, unknown> }): boolean {
  return Boolean(certificado.contexto_congelado?.["modelo_chave"]);
}

/**
 * O PDF fiel do certificado de modelo enviado: a segunda via em .docx passa
 * pelo conversor (LibreOffice) uma vez e fica guardada. Lança
 * `ConversorIndisponivel` sem conversor ou com ele fora do ar.
 */
export async function pdf_do_modelo_enviado(
  tx: Executor,
  usuario: UsuarioAtual,
  certificado: CertificadoRegistro,
): Promise<{ nome: string; bytes: Uint8Array }> {
  // o guardado não passa pela segunda via: a leitura é conferida aqui
  exigir_leitura_do_certificado(usuario, certificado.servidor_id, await do_titular_externo(tx, usuario, certificado));
  const congelado = certificado.contexto_congelado as Record<string, unknown>;
  const chave = conversor_pdf.chave_do_pdf(
    certificado.id,
    certificado.hash_conteudo ?? "",
    String(congelado["modelo_sha256"] ?? ""),
    (await tarja_do_anulado(tx, certificado)) ?? "",
  );
  const bytes = await conversor_pdf.pdf_guardado_ou_convertido(
    chave,
    async () => (await segunda_via(tx, usuario, certificado)).bytes,
  );
  return { nome: caminho_saida(certificado, "pdf").split("/").pop()!, bytes };
}

/**
 * O papel do certificado para o próprio participante, pelo link do e-mail: o
 * mesmo que a ficha baixa (PDF da casa, PDF fiel do modelo enviado ou o Word),
 * sem usuário (`segunda_via_do_titular`).
 */
export async function arquivo_do_titular(
  tx: Executor,
  certificado: CertificadoRegistro,
): Promise<{ nome: string; bytes: Uint8Array; tipo: string }> {
  const nome_pdf = caminho_saida(certificado, "pdf").split("/").pop()!;
  // o titular baixa só PDF (25/10/2026): o modelo enviado sai pelo conversor;
  // sem ele, ou com ele fora do ar, sai o PDF da casa — nunca o Word
  if (do_modelo_enviado(certificado) && conversor_pdf.configurado()) {
    const congelado = certificado.contexto_congelado as Record<string, unknown>;
    const chave = conversor_pdf.chave_do_pdf(
      certificado.id,
      certificado.hash_conteudo ?? "",
      String(congelado["modelo_sha256"] ?? ""),
      (await tarja_do_anulado(tx, certificado)) ?? "",
    );
    try {
      const bytes = await conversor_pdf.pdf_guardado_ou_convertido(
        chave,
        async () => (await segunda_via_do_titular(tx, certificado)).bytes,
      );
      return { nome: nome_pdf, bytes, tipo: certificado_pdf.TIPO_PDF };
    } catch (erro) {
      if (!(erro instanceof conversor_pdf.ConversorIndisponivel)) throw erro;
      console.error(`[certificado ${certificado.id}] ${erro.message}`);
    }
  }
  await segunda_via_do_titular(tx, certificado);
  const bytes = await certificado_pdf.gerar_pdf([montar_contexto(tx, certificado)], [await tarja_do_anulado(tx, certificado)]);
  return { nome: nome_pdf, bytes, tipo: certificado_pdf.TIPO_PDF };
}

/** Os .docx vigentes da turma num .zip, na ordem do número (o "todos" do Word). */
export async function word_da_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: { id: number; codigo: string },
): Promise<{ nome: string; bytes: Uint8Array } | null> {
  const certificados = Object.values(await certificados_da_turma(tx, turma)).sort(
    (a, b) => a.ano - b.ano || a.numero - b.numero,
  );
  if (!certificados.length) return null;
  const zip = new PizZip();
  for (const certificado of certificados) {
    const via = await segunda_via(tx, usuario, certificado);
    zip.file(via.docx.split("/").pop()!, via.bytes);
  }
  const codigo = textos.slug_ascii(turma.codigo.replaceAll("-", "_")).replaceAll("_", "-");
  return { nome: `Certificados_${codigo}.zip`, bytes: zip.generate({ type: "uint8array", compression: "DEFLATE" }) };
}

/** Todos os certificados vigentes da turma num PDF só, na ordem do número. */
export async function pdf_da_turma(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: { id: number; codigo: string },
): Promise<{ nome: string; bytes: Uint8Array } | null> {
  const certificados = Object.values(await certificados_da_turma(tx, turma)).sort(
    (a, b) => a.ano - b.ano || a.numero - b.numero,
  );
  if (!certificados.length) return null;
  for (const certificado of certificados) await segunda_via(tx, usuario, certificado);
  const bytes = await certificado_pdf.gerar_pdf(certificados.map((c) => montar_contexto(tx, c)));
  const codigo = textos.slug_ascii(turma.codigo.replaceAll("-", "_")).replaceAll("_", "-");
  return { nome: `Certificados_${codigo}.pdf`, bytes };
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
