/**
 * A CAT/SP no formato do Anexo III do Manual de Perícia Oficial em Saúde do
 * Servidor Público Federal (3ª ed., 2017), em PDF, para a perícia do SIASS.
 *
 * É o ÚNICO lugar em que o CPF sai por inteiro. Por isso o PDF não é guardado: é
 * montado a cada pedido, de uma pessoa por vez, e cada pedido registra o acesso
 * à identificação e à saúde (nível 2) com a finalidade «instruir a perícia».
 * Exige as duas permissões, `acidente.identificacao_ver` e
 * `acidente.saude_detalhe_ver`.
 *
 * O nexo causal não é conclusão do sistema: sai da decisão pericial vigente
 * (reconhecido → Sim; não reconhecido → Não; sem decisão ou outro → Encaminhar).
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidente_agente_causador,
  acidente_agente_doenca,
  acidente_situacao_geradora,
  campus as tabela_campus,
  cargo as tabela_cargo,
  unidade_uorg as tabela_unidade,
} from "../db/esquema/index.js";
import { ROTULO_ESPECIE, ROTULO_LOCAL_TIPO, ROTULO_SIM_NAO_NAO_SEI, ROTULO_SEXO } from "../dominio/acidente.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as comunicacao from "./acidente_comunicacao.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import * as identificacao from "./acidente_identificacao.js";
import * as saude from "./acidente_saude.js";
import * as siass from "./acidente_siass.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import { desenhar, type Bloco } from "./acidente_relatorio_pdf.js";

export class AnexoRecusado extends RegraViolada {}

const _data = (iso: string | null | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const _v = (v: string | number | null | undefined): string => (v === null || v === undefined || v === "" ? "—" : String(v));

/** Sim / Não / Encaminhar, a partir da decisão pericial vigente. */
export function nexo_causal(decisoes: { resultado: string; vigente: boolean }[]): string {
  const vigente = decisoes.find((d) => d.vigente);
  if (!vigente) return "ENCAMINHAR";
  if (vigente.resultado === "ACIDENTE_EM_SERVICO_RECONHECIDO") return "SIM";
  if (vigente.resultado === "NAO_RECONHECIDO") return "NAO";
  return "ENCAMINHAR";
}

const ROTULO_NEXO: Record<string, string> = { SIM: "Sim", NAO: "Não", ENCAMINHAR: "Encaminhar" };
const ROTULO_TIPO: Record<string, string> = { TIPICO: "Típico", DOENCA: "Doença", TRAJETO: "Trajeto" };

/** Monta os blocos do Anexo III de um acidentado. Grava os dois acessos. */
export async function blocos_do_acidentado(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, acidentado_id: number): Promise<{ blocos: Bloco[]; ordem: number }> {
  usuario.exigir("acidente.identificacao_ver");
  usuario.exigir("acidente.saude_detalhe_ver");
  const { acidentados } = await comunicacao.envolvidos_de(tx, ocorrencia.id);
  const a = acidentados.find((x) => x.id === acidentado_id);
  if (!a) throw new AnexoRecusado("Acidentado não encontrado.");
  const ident = await identificacao.ler_para_siass(tx, usuario, ocorrencia, acidentado_id);
  const sd = await saude.ler(tx, usuario, ocorrencia, acidentado_id, 2, "INSTRUCAO_PERICIA");
  const situacao = await siass.situacao(tx, ocorrencia.id);
  const [campus] = ocorrencia.campus_id ? await tx.select().from(tabela_campus).where(eq(tabela_campus.id, ocorrencia.campus_id)) : [];
  const [cargo] = a.cargo_id ? await tx.select().from(tabela_cargo).where(eq(tabela_cargo.id, a.cargo_id)) : [];
  const [unidade] = a.unidade_uorg_id ? await tx.select().from(tabela_unidade).where(eq(tabela_unidade.id, a.unidade_uorg_id)) : [];
  const [agente] = ocorrencia.agente_causador_id ? await tx.select().from(acidente_agente_causador).where(eq(acidente_agente_causador.id, ocorrencia.agente_causador_id)) : [];
  const [doenca] = ocorrencia.agente_doenca_id ? await tx.select().from(acidente_agente_doenca).where(eq(acidente_agente_doenca.id, ocorrencia.agente_doenca_id)) : [];
  const [situ] = ocorrencia.situacao_geradora_id ? await tx.select().from(acidente_situacao_geradora).where(eq(acidente_situacao_geradora.id, ocorrencia.situacao_geradora_id)) : [];
  const d = sd.detalhe;
  const campo = (rotulo: string, texto: string | number | null | undefined): Bloco => ({ t: "campo", rotulo, texto: _v(texto) });
  const tipo = ocorrencia.especie === "DOENCA_TRABALHO" ? "DOENCA" : ocorrencia.especie === "TRAJETO" ? "TRAJETO" : "TIPICO";
  const nome = a.servidor?.nome ?? a.nome_externo ?? `Pessoa ${a.ordem}`;
  const e = ident.endereco;
  const b: Bloco[] = [
    { t: "titulo", texto: "Comunicação de Acidente em Serviço — Serviço Público Federal (CAT/SP)" },
    { t: "paragrafo", texto: `Anexo III do Manual de Perícia Oficial em Saúde do Servidor Público Federal · protocolo ${ocorrencia.protocolo} · acidentado nº ${a.ordem}.` },
    { t: "aviso", texto: "Documento com dados pessoais e de saúde, gerado para a perícia do SIASS. Não encaminhar fora dela." },
    { t: "secao", texto: "Dados do servidor" },
    campo("Nome", nome),
    campo("Matrícula SIAPE", a.servidor?.siape ?? a.siape),
    campo("Cargo / função", [cargo?.nome, a.funcao].filter(Boolean).join(" / ") || null),
    campo("Lotação de exercício", unidade?.nome_oficial ?? null),
    campo("Sexo", ident.sexo ? ROTULO_SEXO[ident.sexo] : null),
    campo("CPF", ident.cpf),
    campo("RG", ident.rg),
    campo("Data de nascimento", _data(ident.data_nascimento) || null),
    campo("Endereço", [e.logradouro, e.numero, e.complemento, e.bairro, [e.cidade, e.uf].filter(Boolean).join("/"), e.cep].filter(Boolean).join(", ") || null),
    campo("Telefone", ident.telefone),
    campo("E-mail", ident.email),
    { t: "secao", texto: "Acidente ou doença" },
    campo("Tipo", `${ROTULO_TIPO[tipo]} (${ROTULO_ESPECIE[ocorrencia.especie] ?? ocorrencia.especie})`),
    campo("Data e hora do acidente", `${_data(ocorrencia.data_evento)}${ocorrencia.hora_evento ? ` ${String(ocorrencia.hora_evento).slice(0, 5)}` : ""}`),
    campo("Após quantas horas de trabalho", ocorrencia.minutos_apos_inicio_jornada === null ? null : `${Math.floor(ocorrencia.minutos_apos_inicio_jornada / 60)} h ${ocorrencia.minutos_apos_inicio_jornada % 60} min`),
    campo("Houve afastamento", ROTULO_SIM_NAO_NAO_SEI[sd.fatos.houve_afastamento ?? ""] ?? null),
    campo("Último dia trabalhado", _data(ocorrencia.ultimo_dia_trabalho) || null),
    campo("Parte(s) do corpo atingida(s) — Tabela I", sd.partes.join("; ") || null),
    campo("Agente causador do acidente — Tabela II", agente?.rotulo ?? null),
    campo("Agente causador da doença — Tabela III", doenca?.rotulo ?? null),
    campo("Situação geradora — Tabela IV", situ?.rotulo ?? null),
    campo("Houve registro policial", ocorrencia.transito_registro_policial ? ROTULO_SIM_NAO_NAO_SEI[ocorrencia.transito_registro_policial] : null),
    campo("Houve morte", ROTULO_SIM_NAO_NAO_SEI[sd.fatos.houve_obito ?? ""] ?? null),
    { t: "secao", texto: "Local do acidente / doença" },
    campo("Local", ROTULO_LOCAL_TIPO[ocorrencia.local_tipo] ?? ocorrencia.local_tipo),
    campo("Especificação do local", ocorrencia.local_especificacao),
    campo("CNPJ", ocorrencia.local_cnpj_contratada),
    campo("UF / município", [ocorrencia.local_uf, ocorrencia.local_municipio ?? campus?.cidade].filter(Boolean).join(" / ") || null),
  ];
  const testemunhas = ident.testemunhas.slice(0, 2);
  testemunhas.forEach((t, i) => {
    const c = t.contato;
    b.push({ t: "secao", texto: `Testemunha ${i + 1}` });
    b.push(campo("Nome", t.nome));
    b.push(campo("Endereço", c ? [c.logradouro, c.numero, c.complemento, c.bairro, [c.municipio, c.uf].filter(Boolean).join("/"), c.cep].filter(Boolean).join(", ") || null : null));
    b.push(campo("Telefone", c?.telefone));
  });
  if (ident.testemunhas.length > 2) b.push({ t: "paragrafo", texto: `Há mais ${ident.testemunhas.length - 2} testemunha(s) na ocorrência, fora do espaço do formulário.` });
  b.push({ t: "secao", texto: "Atendimento de saúde" });
  b.push(
    campo("Unidade de atendimento", d?.primeiro_socorro_unidade),
    campo("Data e hora do atendimento", d?.atendimento_em ? d.atendimento_em.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null),
    campo("Houve internação", ROTULO_SIM_NAO_NAO_SEI[sd.fatos.houve_internacao ?? ""] ?? null),
    campo("Duração provável do tratamento", d?.duracao_tratamento_dias === null || d?.duracao_tratamento_dias === undefined ? null : `${d.duracao_tratamento_dias} dias`),
    campo("Deverá afastar-se durante o tratamento", d?.deve_afastar ? ROTULO_SIM_NAO_NAO_SEI[d.deve_afastar] : null),
    campo("Descrição e natureza da lesão", [d?.descricao_lesao, sd.natureza].filter(Boolean).join(" — ") || null),
    campo("Diagnóstico provável", d?.diagnostico_provavel),
    campo("CID", d?.cid),
    campo("Observações", d?.observacoes_saude),
    { t: "secao", texto: "Nexo causal" },
    campo("Houve nexo causal", ROTULO_NEXO[nexo_causal(situacao.decisoes)]),
    { t: "paragrafo", texto: "O nexo causal é estabelecido pela perícia oficial em saúde; aqui consta o que ela decidiu, ou «Encaminhar» enquanto não houver decisão." },
  );
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_ANEXO_III_EMITIDO,
    descricao: `${ocorrencia.protocolo}: CAT/SP no formato do Anexo III emitida para o acidentado nº ${a.ordem}, para a perícia do SIASS.`,
    usuario,
  });
  return { blocos: b, ordem: a.ordem };
}

export async function gerar_pdf(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, acidentado_id: number): Promise<{ nome: string; bytes: Uint8Array }> {
  const { blocos, ordem } = await blocos_do_acidentado(tx, usuario, ocorrencia, acidentado_id);
  const bytes = await desenhar(blocos, `CAT/SP ${ocorrencia.protocolo} — Anexo III`, `${ocorrencia.protocolo} · Anexo III · acidentado ${ordem} · emitido em ${new Date().toLocaleDateString("pt-BR")}`);
  return { nome: `CAT-SP-${ocorrencia.protocolo.replace(/[^A-Za-z0-9]+/g, "-")}-${ordem}.pdf`, bytes };
}
