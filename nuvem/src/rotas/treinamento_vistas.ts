/**
 * As `@property` do SQLAlchemy que os templates de Treinamentos e Certificados
 * leem (`t.topicos`, `m.rotulo`, `a.nome_exibicao`, `i.participante.nome_exibicao`...).
 *
 * Não existe no Python: lá o template chamava a propriedade do objeto do ORM.
 * Aqui o registro do Drizzle é objeto simples, e estas funções devolvem o MESMO
 * objeto com as propriedades calculadas como getters — o template portado lê
 * igual, e ninguém recalcula regra no Nunjucks. Também mora aqui o recado das
 * rotas do módulo (`_aviso`, `_volta`, `_erro`). O `salvar_com_diff` de
 * catálogo mora em `src/web.ts`.
 */
import type { Ctx } from "../nucleo/contexto.js";
import {
  AssinaturaInstrutor,
  Certificado,
  CertificadoModelo,
  Inscricao,
  Participante,
  Treinamento,
  Turma,
} from "../dominio/treinamento.js";
import { redirecionar } from "../web.js";

type Obj = Record<string, any>;

/** Acrescenta getters a um objeto (sem copiar: o template vê o mesmo registro). */
function com<T extends Obj>(alvo: T, props: Record<string, (o: T) => unknown>): T {
  if (!alvo || (alvo as Obj).__vista) return alvo;
  for (const [nome, f] of Object.entries(props)) {
    Object.defineProperty(alvo, nome, { get: () => f(alvo), enumerable: false, configurable: true });
  }
  Object.defineProperty(alvo, "__vista", { value: true, enumerable: false });
  return alvo;
}

export function vista_assinatura<T extends Obj | null | undefined>(a: T): T {
  if (!a) return a;
  return com(a as Obj, {
    nome_exibicao: (o) => AssinaturaInstrutor.nome_exibicao(o as never),
    registro_completo: (o) => AssinaturaInstrutor.registro_completo(o as never),
    vigente_em: (o) => (quando: string) => AssinaturaInstrutor.vigente_em(o as never, quando),
  }) as T;
}

export function vista_modelo<T extends Obj | null | undefined>(m: T): T {
  if (!m) return m;
  const obj = m as Obj;
  if (obj.treinamento) vista_treinamento(obj.treinamento);
  return com(obj, {
    rotulo: (o) => CertificadoModelo.rotulo(o as never),
    mapa_de_tags: (o) => (o.tags ? CertificadoModelo.mapa_de_tags(o as never) : {}),
  }) as T;
}

export function vista_treinamento<T extends Obj | null | undefined>(t: T): T {
  if (!t) return t;
  const obj = t as Obj;
  if (obj.modelo_vigente) vista_modelo(obj.modelo_vigente);
  if (obj.instrutor_padrao) vista_assinatura(obj.instrutor_padrao);
  return com(obj, {
    topicos: (o) => Treinamento.topicos(o as never),
    expira: (o) => Treinamento.expira(o as never),
    validade_rotulo: (o) => Treinamento.validade_rotulo(o as never),
  }) as T;
}

export function vista_participante<T extends Obj | null | undefined>(p: T): T {
  if (!p) return p;
  return com(p as Obj, {
    nome_exibicao: (o) => Participante.nome_exibicao(o as never),
    email_exibicao: (o) => (o.emails ? Participante.email_exibicao(o as never) : ""),
    e_servidor: (o) => Participante.e_servidor(o as never),
  }) as T;
}

export function vista_turma<T extends Obj | null | undefined>(t: T): T {
  if (!t) return t;
  const obj = t as Obj;
  if (obj.treinamento) vista_treinamento(obj.treinamento);
  for (const v of obj.instrutores ?? []) vista_assinatura(v.instrutor);
  return com(obj, {
    carga_efetiva: (o) => (o.treinamento ? Turma.carga_efetiva(o as never) : o.carga_horaria_horas),
    data_base: (o) => Turma.data_base(o as never),
    rotulo: (o) => (o.treinamento ? Turma.rotulo(o as never) : o.codigo),
    aceita_inscricao: (o) => Turma.aceita_inscricao(o as never),
    encerrada: (o) => Turma.encerrada(o as never),
  }) as T;
}

export function vista_inscricao<T extends Obj | null | undefined>(i: T): T {
  if (!i) return i;
  const obj = i as Obj;
  if (obj.participante) vista_participante(obj.participante);
  if (obj.turma) vista_turma(obj.turma);
  return com(obj, {
    ocupa_vaga: (o) => Inscricao.ocupa_vaga(o as never),
    horas_presentes: (o) => (o.presencas ? Inscricao.horas_presentes(o as never) : "0"),
    compareceu: (o) => (o.presencas ? Inscricao.compareceu(o as never) : false),
  }) as T;
}

export function vista_certificado<T extends Obj | null | undefined>(c: T): T {
  if (!c) return c;
  const obj = c as Obj;
  if (obj.participante) vista_participante(obj.participante);
  if (obj.treinamento) vista_treinamento(obj.treinamento);
  if (obj.modelo) vista_modelo(obj.modelo);
  if (obj.inscricao) vista_inscricao(obj.inscricao);
  return com(obj, {
    rotulo: (o) => Certificado.rotulo(o as never),
    anulado: (o) => Certificado.anulado(o as never),
  }) as T;
}

// ---------------------------------------------------------------------
// O recado das rotas do módulo
// ---------------------------------------------------------------------
/**
 * O recado vai codificado (`quote`, espaço como %20): o nome do treinamento, o
 * motivo e o código vêm do que foi digitado, e um `&` ou `#` cortava o recado.
 * A ÂNCORA VAI POR ÚLTIMO: o fragmento encerra a URL.
 */
export function aviso(c: Ctx, destino: string, campo: string, mensagem: string, ancora = ""): Response {
  const separador = destino.includes("?") ? "&" : "?";
  return redirecionar(c, `${destino}${separador}${campo}=${encodeURIComponent(mensagem)}${ancora}`);
}

/** Deu certo. Banner verde. */
export function volta(c: Ctx, destino: string, mensagem: string, ancora = ""): Response {
  return aviso(c, destino, "mensagem", mensagem, ancora);
}

/** Não deu. Banner vermelho — a cor é a informação. */
export function erro(c: Ctx, destino: string, mensagem: string, ancora = ""): Response {
  return aviso(c, destino, "erro", mensagem, ancora);
}

/** `?mensagem=` e `?erro=` da query, como o FastAPI os entregava à rota. */
export function recados(c: Ctx): { mensagem: string | null; erro: string | null } {
  return { mensagem: c.req.query("mensagem") ?? null, erro: c.req.query("erro") ?? null };
}

/** `int(valor) if valor.strip().isdigit() else None`. */
export function id_opcional(valor: string | null | undefined): number | null {
  const v = (valor ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** `(valor or "").strip() or None`. */
export function texto_ou_nulo(valor: string | null | undefined): string | null {
  return (valor ?? "").trim() || null;
}

/** Caixa marcada: o formulário manda "1". */
export function marcado(valor: string | null | undefined): boolean {
  return valor === "1";
}

/** `date.fromisoformat` — só 'AAAA-MM-DD' de verdade (dia que existe). */
export function data_iso(valor: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return valor.trim();
}

