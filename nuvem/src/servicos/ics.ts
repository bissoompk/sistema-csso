/**
 * A agenda da turma em iCalendar (.ics, RFC 5545), sem dependência.
 *
 * Um VEVENT por dia da turma. Com hora (`turma.hora_inicio`/`hora_fim`), o
 * evento vai em UTC: o horário do negócio é o de Brasília (America/Sao_Paulo,
 * UTC−3 fixo desde 2019, a mesma conta de `inscricao_publica._expira_em`), e o
 * UTC dispensa o bloco VTIMEZONE que um TZID exigiria. Sem hora, o dia é
 * inteiro (`VALUE=DATE`, fim exclusivo no dia seguinte).
 *
 * O endereço vem de `emissao_certificado.url_base_validacao` (parâmetro
 * `certificado.url_publica`, `CSSO_URL_PUBLICA` ou `URL`) — nunca fixo. Dele
 * sai também o domínio do UID.
 *
 * **UID estável.** `turma-<codigo>@<host>` na turma de um dia; na de vários,
 * cada dia é um evento próprio e leva a data no meio
 * (`turma-<codigo>-AAAAMMDD@<host>`): dois VEVENTs com o mesmo UID e sem
 * RECURRENCE-ID são o MESMO evento para o calendário, que guardaria só um.
 * Baixar de novo depois de uma mudança de hora ou de local atualiza o evento
 * em vez de duplicá-lo.
 */
import type { Executor } from "../db/cliente.js";
import { somar_dias } from "../dominio/datas.js";

export const TIPO_ICS = "text/calendar; charset=utf-8";

/** O mínimo da turma que a agenda lê (a `TurmaCarregada` serve). */
export interface TurmaDaAgenda {
  id: number;
  codigo: string;
  situacao: string;
  data_inicio: string;
  data_fim: string;
  hora_inicio: string | null;
  hora_fim: string | null;
  local: string | null;
  campus?: { nome: string } | null;
  treinamento: { nome: string };
  unidade_promotora?: { sigla: string | null; nome_extenso: string } | null;
  /** Preenchido quando a turma está na vitrine pública. */
  divulgada_em?: Date | null;
}

/** Diferença do horário de Brasília para o UTC, em horas (sem horário de verão). */
const FUSO_HORAS = 3;

// ---------------------------------------------------------------------
// A gramática do RFC 5545
// ---------------------------------------------------------------------
/** TEXT (§3.3.11): barra, ponto e vírgula, vírgula e quebra de linha escapados. */
export function escapar(texto: string): string {
  return texto
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Dobra (§3.1): nenhuma linha passa de 75 octetos (sem o CRLF); a
 * continuação começa com um espaço, que conta nos 75. Corta entre caracteres,
 * nunca no meio de um caractere UTF-8 de vários bytes.
 */
export function dobrar(linha: string): string {
  const partes: string[] = [];
  let atual = "";
  let bytes = 0;
  let limite = 75;
  for (const ch of linha) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > limite) {
      partes.push(atual);
      atual = " ";
      bytes = 1;
      limite = 75;
    }
    atual += ch;
    bytes += n;
  }
  partes.push(atual);
  return partes.join("\r\n");
}

const dois = (n: number) => String(n).padStart(2, "0");

/** 'AAAA-MM-DD' → 'AAAAMMDD'. */
function data_ics(dia: string): string {
  return dia.replaceAll("-", "");
}

/** Dia e hora de Brasília → instante UTC no formato `AAAAMMDDTHHMMSSZ`. */
export function instante_utc(dia: string, hora: string): string {
  const [a, m, d] = dia.split("-").map(Number) as [number, number, number];
  const [h, min, s] = (hora + ":00:00").split(":").map(Number) as [number, number, number];
  return carimbo(new Date(Date.UTC(a, m - 1, d, h + FUSO_HORAS, min, s || 0)));
}

/** Um `Date` no formato UTC do iCalendar. */
export function carimbo(quando: Date): string {
  return (
    `${quando.getUTCFullYear()}${dois(quando.getUTCMonth() + 1)}${dois(quando.getUTCDate())}` +
    `T${dois(quando.getUTCHours())}${dois(quando.getUTCMinutes())}${dois(quando.getUTCSeconds())}Z`
  );
}

/** O domínio do UID: o host da URL base, ou "sisa.invalid" se ela não for URL. */
export function dominio_do_uid(url_base: string): string {
  try {
    return new URL(url_base).hostname || "sisa.invalid";
  } catch {
    return "sisa.invalid";
  }
}

function dias(turma: TurmaDaAgenda): string[] {
  const saida: string[] = [];
  for (let d = turma.data_inicio; d <= turma.data_fim; d = somar_dias(d, 1)) saida.push(d);
  return saida;
}

/** "Auditório do Campus JK, Campus JK" — local e campus, o que houver. */
function onde(turma: TurmaDaAgenda): string {
  return [turma.local, turma.campus?.nome].filter((x): x is string => Boolean(x && x.trim())).join(", ");
}

// ---------------------------------------------------------------------
// O calendário
// ---------------------------------------------------------------------
/**
 * O .ics da turma, como texto (linhas em CRLF, já dobradas). `link` é o
 * endereço que vai na descrição; `agora` é o DTSTAMP.
 */
export function gerar(turma: TurmaDaAgenda, opcoes: { url_base: string; link: string; agora?: Date }): string {
  const agora = opcoes.agora ?? new Date();
  const host = dominio_do_uid(opcoes.url_base);
  const todos = dias(turma);
  const varios = todos.length > 1;
  const local = onde(turma);
  const promotor = turma.unidade_promotora?.sigla || turma.unidade_promotora?.nome_extenso || "Sisa";
  const linhas: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//UFVJM//Sistema SISA//PT-BR`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  todos.forEach((dia, i) => {
    const uid = varios ? `turma-${turma.codigo}-${data_ics(dia)}@${host}` : `turma-${turma.codigo}@${host}`;
    const resumo =
      `${turma.treinamento.nome} (${turma.codigo})` + (varios ? ` — dia ${i + 1} de ${todos.length}` : "");
    const descricao =
      `Turma ${turma.codigo} · ${turma.treinamento.nome}\n` + `Promoção: ${promotor} / UFVJM\n` + `${opcoes.link}`;
    linhas.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${carimbo(agora)}`);
    if (turma.hora_inicio) {
      linhas.push(`DTSTART:${instante_utc(dia, turma.hora_inicio)}`);
      if (turma.hora_fim) linhas.push(`DTEND:${instante_utc(dia, turma.hora_fim)}`);
    } else {
      linhas.push(`DTSTART;VALUE=DATE:${data_ics(dia)}`, `DTEND;VALUE=DATE:${data_ics(somar_dias(dia, 1))}`);
      // o dia inteiro não ocupa a agenda de quem o recebe
      linhas.push("TRANSP:TRANSPARENT");
    }
    linhas.push(`SUMMARY:${escapar(resumo)}`);
    if (local) linhas.push(`LOCATION:${escapar(local)}`);
    linhas.push(`DESCRIPTION:${escapar(descricao)}`, `URL:${opcoes.link}`);
    linhas.push(`STATUS:${turma.situacao === "CANCELADA" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  });
  linhas.push("END:VCALENDAR");
  return linhas.map(dobrar).join("\r\n") + "\r\n";
}

/**
 * O endereço da turma que vai na descrição. A turma divulgada leva à ficha
 * pública (abre sem entrar); a outra, à lista "Meus treinamentos" de quem recebe,
 * porque `/turmas/{id}` é da equipe e dá 403 para o servidor.
 */
export function link_da_turma(url_base: string, turma: { codigo: string; divulgada_em?: Date | null }): string {
  const base = url_base.replace(/\/+$/, "");
  return turma.divulgada_em ? `${base}/cursos/${turma.codigo}` : `${base}/turmas/minhas`;
}

/** O arquivo pronto: nome, bytes e o texto. A URL base é a do sistema. */
export async function da_turma(
  tx: Executor,
  turma: TurmaDaAgenda,
  agora: Date = new Date(),
): Promise<{ nome: string; bytes: Uint8Array; texto: string }> {
  // import tardio: `emissao_certificado` importa a turma, que importa os avisos, que importam daqui
  const { url_base_validacao } = await import("./emissao_certificado.js");
  const url_base = await url_base_validacao(tx);
  const texto = gerar(turma, { url_base, link: link_da_turma(url_base, turma), agora });
  return { nome: `${turma.codigo}.ics`, bytes: new Uint8Array(Buffer.from(texto, "utf8")), texto };
}
