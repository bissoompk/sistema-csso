/**
 * O checklist de campo da investigação (fatia F4), seções 0 a 8.
 *
 * Gerado na primeira abertura da aba: a base fixa (seções 0 a 7) e os pontos
 * específicos (seção 8), escolhidos pela espécie do acidente e por palavras
 * INTEIRAS do caso (relato, local, atividade e agente causador). No legado a
 * escolha era por pedaço de palavra — "press" casava com "impressora", "moto"
 * com "motorista"; aqui o casamento é por palavra, sem acento e sem caixa.
 * Sem IA (D2): a lista é determinística.
 *
 * Cada item tem marcado e observação. Itens da base e específicos não se
 * apagam; o item MANUAL acrescentado pela equipe se desativa.
 *
 * Os textos dos itens são um ponto de partida da equipe de segurança do
 * trabalho, a revisar por ela (DESVIOS.md, F4).
 */
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { acidente_agente_causador, acidente_cat_sp, acidente_checklist_item } from "../db/esquema/index.js";
import { ComunicacaoRecusada, type ContextoCatSp, type Ocorrencia } from "./acidente_comunicacao.js";
import { editavel } from "./acidente_investigacao.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export type ItemChecklist = typeof acidente_checklist_item.$inferSelect;

export const SECOES: readonly string[] = [
  "Preparação",
  "Trabalho habitual",
  "Mudanças",
  "Barreiras",
  "Sinais de alerta",
  "Documentos",
  "Entrevistas",
  "Registros visuais",
  "Pontos específicos do caso",
];

/** A base: seções 0 a 7, iguais em todo caso. */
export const BASE: readonly (readonly [number, string])[] = [
  [0, "Definir o objetivo da análise e quem participa da equipe"],
  [0, "Avisar a chefia da unidade e combinar a visita ao local"],
  [0, "Levar o termo de consentimento para gravar entrevistas; sem consentimento registrado, não gravar"],
  [0, "Separar a comunicação (CAT/SP) e as versões dela para a visita"],
  [1, "Descrever a tarefa como costuma ser feita quando dá certo"],
  [1, "Identificar o procedimento escrito ou a ordem de serviço da tarefa, se houver"],
  [1, "Registrar a diferença entre o prescrito e o que se faz de fato"],
  [2, "Mudanças no indivíduo: experiência na tarefa, troca de função, jornada"],
  [2, "Mudanças na tarefa: urgência, improviso, etapa nova ou suprimida"],
  [2, "Mudanças no material: equipamento, ferramenta ou produto diferente, defeito, manutenção"],
  [2, "Mudanças no meio: piso, iluminação, ruído, clima, arranjo físico, outras equipes"],
  [3, "Barreiras físicas (proteções, guarda-corpo, enclausuramento): existiam? funcionaram?"],
  [3, "Barreiras funcionais (intertravamento, bloqueio, permissão de trabalho)"],
  [3, "Barreiras simbólicas (sinalização, avisos, demarcação)"],
  [3, "Barreiras administrativas (procedimento, treinamento, supervisão)"],
  [4, "Houve quase acidente ou queixa anterior parecida no setor?"],
  [4, "Houve pedido de manutenção, compra ou EPI ainda não atendido?"],
  [5, "Consultar o PGR (inventário de riscos do posto)"],
  [5, "Consultar o PCMSO e o ASO do acidentado (só o que é necessário, pelo médico do trabalho)"],
  [5, "Consultar a ficha de EPI do acidentado e os treinamentos em vigor"],
  [6, "Entrevistar o acidentado, quando possível"],
  [6, "Entrevistar testemunhas e colegas da tarefa"],
  [6, "Entrevistar a chefia imediata"],
  [7, "Fotografar o local, o equipamento e as condições (nunca a lesão)"],
  [7, "Fazer croqui do local com medidas, se ajudar a explicar"],
];

/** Os pontos específicos (seção 8): as palavras inteiras que os acionam, e os itens. */
export const ESPECIFICOS: Readonly<Record<string, { palavras: readonly string[]; itens: readonly string[] }>> = {
  altura: {
    palavras: ["altura", "escada", "andaime", "telhado", "laje", "plataforma", "queda de nivel", "cesto aereo"],
    itens: [
      "Trabalho em altura: havia análise de risco e permissão de trabalho (NR-35)?",
      "Pontos de ancoragem, cinto e talabarte: existiam, estavam em uso e em condição?",
      "Treinamento de NR-35 do trabalhador em vigor?",
    ],
  },
  eletrico: {
    palavras: ["eletrico", "eletrica", "choque", "energizado", "tomada", "quadro de distribuicao", "fiacao", "curto"],
    itens: [
      "Serviço em eletricidade: havia desenergização e bloqueio (NR-10)?",
      "Trabalhador autorizado e com treinamento de NR-10 em vigor?",
      "Instalação com aterramento, proteção e prontuário?",
    ],
  },
  maquina: {
    palavras: ["maquina", "prensa", "serra", "torno", "esmeril", "furadeira", "betoneira", "engrenagem", "policorte", "lixadeira"],
    itens: [
      "Máquina com proteções fixas e móveis no lugar e funcionando (NR-12)?",
      "Dispositivo de parada de emergência acessível e funcionando?",
      "Manutenção da máquina em dia e registrada?",
    ],
  },
  trajeto: {
    palavras: ["transito", "veiculo", "carro", "moto", "motocicleta", "bicicleta", "onibus", "atropelamento", "colisao", "rodovia"],
    itens: [
      "Trajeto: o percurso era o habitual entre a residência e o trabalho?",
      "Há boletim de ocorrência? Anexar à investigação, se houver",
      "Veículo oficial? Conferir condutor autorizado, manutenção e escala",
    ],
  },
  quimico: {
    palavras: ["quimico", "quimica", "acido", "solvente", "reagente", "produto de limpeza", "vapor", "gas", "derramamento"],
    itens: [
      "Ficha de informação de segurança (FISPQ/FDS) do produto disponível no local?",
      "Armazenamento, rotulagem e ventilação adequados?",
      "EPI indicado para o produto estava disponível e em uso?",
    ],
  },
  corte: {
    palavras: ["corte", "faca", "estilete", "vidro", "lamina", "tesoura", "bisturi", "perfurocortante", "agulha"],
    itens: [
      "Ferramenta de corte adequada e em condição?",
      "Descarte de perfurocortantes em recipiente próprio?",
      "Luva de proteção indicada estava disponível e em uso?",
    ],
  },
  fogo: {
    palavras: ["fogo", "incendio", "chama", "queimadura", "explosao", "solda", "macarico", "inflamavel"],
    itens: [
      "Extintores e rotas de fuga sinalizados e desobstruídos?",
      "Trabalho a quente com permissão e vigilância?",
      "Armazenamento de inflamáveis conforme a NR-20?",
    ],
  },
  biologico: {
    palavras: ["biologico", "sangue", "secrecao", "material biologico", "laboratorio de microbiologia", "animal", "mordida", "picada"],
    itens: [
      "Exposição a material biológico: conduta pós-exposição foi seguida (encaminhamento imediato)?",
      "Vacinação e EPI do trabalhador conferidos pelo médico do trabalho",
      "Procedimento de biossegurança do laboratório disponível e seguido?",
    ],
  },
  obito: {
    palavras: ["obito", "fatal", "falecimento"],
    itens: [
      "Óbito: comunicar imediatamente a autoridade policial e preservar o local",
      "Comunicar a PROGEP e o SIASS no mesmo dia",
      "Prever acolhimento da equipe e da família pela unidade",
    ],
  },
};

/** Sem acento, minúsculo e com um espaço entre palavras: para casar palavra inteira. */
export function normalizar(texto: string): string {
  return ` ${texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** Os temas específicos do caso: pela espécie e pelas palavras inteiras do texto. */
export function temas_do_caso(texto: string, especie: string, houve_obito = false): string[] {
  const alvo = normalizar(texto);
  const temas = new Set<string>();
  for (const [tema, { palavras }] of Object.entries(ESPECIFICOS)) {
    if (palavras.some((p) => alvo.includes(` ${normalizar(p).trim()} `))) temas.add(tema);
  }
  if (especie === "TRAJETO") temas.add("trajeto");
  if (houve_obito) temas.add("obito");
  return Object.keys(ESPECIFICOS).filter((t) => temas.has(t));
}

async function _texto_do_caso(tx: Executor, ocorrencia: Ocorrencia): Promise<{ texto: string; obito: boolean }> {
  const [cat] = await tx
    .select({ contexto: acidente_cat_sp.contexto_congelado })
    .from(acidente_cat_sp)
    .where(and(eq(acidente_cat_sp.ocorrencia_id, ocorrencia.id), eq(acidente_cat_sp.versao, ocorrencia.cat_sp_versao)));
  const ctx = (cat?.contexto ?? null) as ContextoCatSp | null;
  const partes = [ocorrencia.local_especificacao, ctx?.relato.descricao ?? "", ctx?.relato.atividade_no_momento ?? ""];
  if (ocorrencia.agente_causador_id) {
    const [ag] = await tx
      .select({ rotulo: acidente_agente_causador.rotulo, grupo: acidente_agente_causador.grupo })
      .from(acidente_agente_causador)
      .where(eq(acidente_agente_causador.id, ocorrencia.agente_causador_id));
    if (ag) partes.push(ag.rotulo, ag.grupo ?? "");
  }
  const obito = (ctx?.saude_declarada ?? []).some((s) => s.houve_obito === "SIM");
  return { texto: partes.join(" \n "), obito };
}

/** Os itens ativos; na primeira abertura, gera a base e os específicos. */
export async function itens(tx: Executor, ocorrencia: Ocorrencia): Promise<ItemChecklist[]> {
  const existentes = await tx
    .select()
    .from(acidente_checklist_item)
    .where(eq(acidente_checklist_item.ocorrencia_id, ocorrencia.id))
    .orderBy(asc(acidente_checklist_item.secao), asc(acidente_checklist_item.ordem));
  if (existentes.length) return existentes.filter((i) => i.ativo);
  const { texto, obito } = await _texto_do_caso(tx, ocorrencia);
  const linhas: (typeof acidente_checklist_item.$inferInsert)[] = BASE.map(([secao, t], i) => ({
    ocorrencia_id: ocorrencia.id,
    secao,
    ordem: i + 1,
    texto: t,
    origem: "BASE",
  }));
  let ordem = 1;
  for (const tema of temas_do_caso(texto, ocorrencia.especie, obito)) {
    for (const t of ESPECIFICOS[tema]!.itens) linhas.push({ ocorrencia_id: ocorrencia.id, secao: 8, ordem: ordem++, texto: t, origem: "ESPECIFICO" });
  }
  return tx.insert(acidente_checklist_item).values(linhas).returning();
}

/** Grava o que está marcado e as observações de todos os itens ativos. */
export async function salvar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  marcados: ReadonlySet<number>,
  observacoes: ReadonlyMap<number, string>,
): Promise<number> {
  usuario.exigir("acidente.investigar");
  if (!editavel(ocorrencia)) throw new ComunicacaoRecusada(`O checklist de ${ocorrencia.protocolo} está travado: o relatório já saiu.`, null);
  const atuais = await itens(tx, ocorrencia);
  let mudou = 0;
  for (const item of atuais) {
    const marcado = marcados.has(item.id);
    const obs = (observacoes.get(item.id) ?? "").trim().slice(0, 1000) || null;
    if (marcado === item.marcado && obs === item.observacao) continue;
    await tx.update(acidente_checklist_item).set({ marcado, observacao: obs }).where(eq(acidente_checklist_item.id, item.id));
    mudou += 1;
  }
  if (mudou) {
    await auditoria.registrar(tx, {
      entidade: "acidente_ocorrencia",
      entidade_id: ocorrencia.id,
      tipo_evento: auditoria.ACIDENTE_CHECKLIST_SALVO,
      descricao: `${ocorrencia.protocolo}: checklist salvo (${mudou} item(ns) alterado(s)).`,
      usuario,
    });
  }
  return mudou;
}

/** O item que a equipe acrescenta, numa seção. */
export async function acrescentar(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  secao: number,
  texto: string,
): Promise<void> {
  usuario.exigir("acidente.investigar");
  if (!editavel(ocorrencia)) throw new ComunicacaoRecusada(`O checklist de ${ocorrencia.protocolo} está travado: o relatório já saiu.`, null);
  if (!Number.isInteger(secao) || secao < 0 || secao > 8) throw new ComunicacaoRecusada("Escolha a seção na lista.", "a seção");
  const t = (texto ?? "").trim();
  if (!t || t.length > 300) throw new ComunicacaoRecusada("Escreva o item (até 300 caracteres).", "o item");
  const atuais = await itens(tx, ocorrencia);
  const ordem = Math.max(0, ...atuais.filter((i) => i.secao === secao).map((i) => i.ordem)) + 1;
  await tx.insert(acidente_checklist_item).values({ ocorrencia_id: ocorrencia.id, secao, ordem, texto: t, origem: "MANUAL" });
  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_CHECKLIST_SALVO,
    descricao: `${ocorrencia.protocolo}: item acrescentado ao checklist (seção ${secao}).`,
    usuario,
  });
}

/** Desativa um item MANUAL (os da base e os específicos ficam: marcar "não se aplica" é a observação). */
export async function desativar(tx: Executor, usuario: UsuarioAtual, ocorrencia: Ocorrencia, id: number): Promise<void> {
  usuario.exigir("acidente.investigar");
  if (!editavel(ocorrencia)) throw new ComunicacaoRecusada(`O checklist de ${ocorrencia.protocolo} está travado: o relatório já saiu.`, null);
  const r = await tx
    .update(acidente_checklist_item)
    .set({ ativo: false })
    .where(
      and(
        eq(acidente_checklist_item.id, id),
        eq(acidente_checklist_item.ocorrencia_id, ocorrencia.id),
        eq(acidente_checklist_item.origem, "MANUAL"),
      ),
    )
    .returning({ id: acidente_checklist_item.id });
  if (!r.length) throw new ComunicacaoRecusada("Só o item acrescentado pela equipe sai da lista; os da base ficam (use a observação).", null);
}
