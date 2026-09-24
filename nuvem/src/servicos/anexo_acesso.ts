/**
 * Quem pode ver o dono do anexo pode baixar o anexo — e nada além disso.
 * Porte de `app/servicos/anexo_acesso.py`.
 *
 * **Anexo não tem autorização própria: ele herda a de quem o carrega.**
 * `anexo.entidade` + `anexo.entidade_id` dizem a quem o arquivo pertence, e
 * cada dono tem uma tela cuja regra já foi decidida. Este módulo resolve o
 * dono e delega a ele. O nível de acesso do anexo NÃO decide nada (ele decide
 * retenção). Entidade sem resolvedor declarado **nega**.
 *
 * **Adaptação do porte.** No Python cada resolvedor importava, de dentro da
 * função, a regra do módulo dono (`repositorios.processos.por_id`,
 * `parecer.no_escopo`, `epi_ficha.exigir_leitura_da_ficha`,
 * `emissao_certificado.no_escopo`/`exigir_leitura_do_certificado`). Aqui os
 * quatro resolvedores e a lista fechada continuam neste arquivo, com a mesma
 * forma; a regra do dono entra por `PORTAS`, que o módulo dono preenche ao ser
 * carregado (`declarar_porta(...)`). Porta não declarada NEGA com
 * `DonoNaoDeclarado` — o mesmo lado seguro do Python para entidade sem regra.
 * Isso também quebra o ciclo de import (o dono importa auditoria/anexos).
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { epi_ficha_registro } from "../db/esquema/index.js";
import * as auditoria from "./auditoria.js";
import type { Anexo } from "./anexos.js";
import { PermissaoNegada, type UsuarioAtual } from "./rbac.js";

export const ANEXO_BAIXADO = "ANEXO_BAIXADO";

// Uma frase só, para os quatro casos (id inexistente, anexo desativado, dono
// fora do escopo, entidade sem regra): distinguir "não existe" de "não pode"
// mantém a enumeração viva.
export const INDISPONIVEL = "O anexo não existe ou está fora do seu alcance.";

/** O anexo não existe, não está ativo, ou o dono não é alcançável. */
export class AnexoForaDeAlcance extends PermissaoNegada {
  constructor(detalhe: string = INDISPONIVEL) {
    super("anexo", detalhe);
  }
}

/** Entidade dona sem regra declarada — nega, e diz o nome dela. */
export class DonoNaoDeclarado extends AnexoForaDeAlcance {
  constructor(public entidade: string) {
    super(
      `Anexos de '${entidade}' não têm regra de acesso declarada em ` +
        "`src/servicos/anexo_acesso.ts`. Enquanto não tiverem, o download é " +
        "negado — avise o administrador do sistema.",
    );
  }
}

/** A quem o anexo pertence, e o que o registro de acesso precisa saber. */
export interface Dono {
  entidade: string;
  servidor_id: number | null;
  processo_id: number | null;
  finalidade: string;
}

type ComServidor = { id: number; servidor_id: number | null; processo_id?: number | null };

/** As regras dos módulos donos, preenchidas por eles (ver o cabeçalho). */
export interface Portas {
  /** `repositorios/processos.por_id` — a porta de `GET /processos/{id}` (escopo do repositório). */
  processo_por_id?: (tx: Executor, usuario: UsuarioAtual, id: number) => Promise<ComServidor | null>;
  /** `parecer.no_escopo`. */
  parecer_no_escopo?: (tx: Executor, usuario: UsuarioAtual, id: number) => Promise<ComServidor | null>;
  /** `epi_ficha.exigir_leitura_da_ficha` — levanta quando não pode. */
  exigir_leitura_da_ficha?: (usuario: UsuarioAtual, servidor_id: number) => void;
  /** `emissao_certificado.no_escopo`. */
  certificado_no_escopo?: (tx: Executor, usuario: UsuarioAtual, id: number) => Promise<ComServidor | null>;
  /** `emissao_certificado.exigir_leitura_do_certificado` — levanta quando não pode. */
  exigir_leitura_do_certificado?: (usuario: UsuarioAtual, servidor_id: number | null) => void;
}

export const PORTAS: Portas = {};

export function declarar_porta<K extends keyof Portas>(nome: K, funcao: NonNullable<Portas[K]>): void {
  PORTAS[nome] = funcao;
}

function porta<K extends keyof Portas>(nome: K, entidade: string): NonNullable<Portas[K]> {
  const f = PORTAS[nome];
  if (!f) throw new DonoNaoDeclarado(entidade);
  return f as NonNullable<Portas[K]>;
}

/** A mesma porta de `GET /processos/{id}`: a permissão e o escopo do repositório. */
async function dono_processo(tx: Executor, usuario: UsuarioAtual, anexo: Anexo): Promise<Dono> {
  usuario.exigir("processo.ver");
  const processo = await porta("processo_por_id", "processo")(tx, usuario, anexo.entidade_id);
  if (!processo) throw new AnexoForaDeAlcance();
  return {
    entidade: "processo",
    servidor_id: processo.servidor_id,
    processo_id: processo.id,
    finalidade: "consulta de anexo do processo de adicional ocupacional",
  };
}

/** A mesma porta de `GET /pareceres/{id}`: `parecer.ver` mais o escopo. */
async function dono_parecer(tx: Executor, usuario: UsuarioAtual, anexo: Anexo): Promise<Dono> {
  usuario.exigir("parecer.ver");
  const parecer = await porta("parecer_no_escopo", "parecer_tecnico")(tx, usuario, anexo.entidade_id);
  if (!parecer) throw new AnexoForaDeAlcance();
  return {
    entidade: "parecer_tecnico",
    servidor_id: parecer.servidor_id,
    processo_id: parecer.processo_id ?? null,
    finalidade: "leitura de documento anexado ao parecer técnico",
  };
}

/** A regra da ficha, chamada onde ela mora — não uma cópia dela. */
async function dono_ficha_epi(tx: Executor, usuario: UsuarioAtual, anexo: Anexo): Promise<Dono> {
  const exigir = porta("exigir_leitura_da_ficha", "epi_ficha_registro");
  const [registro] = await tx
    .select({ servidor_id: epi_ficha_registro.servidor_id })
    .from(epi_ficha_registro)
    .where(eq(epi_ficha_registro.id, anexo.entidade_id));
  if (!registro) throw new AnexoForaDeAlcance();
  exigir(usuario, registro.servidor_id);
  return {
    entidade: "epi_ficha_registro",
    servidor_id: registro.servidor_id,
    processo_id: null,
    finalidade: "leitura do comprovante assinado de entrega de EPI",
  };
}

/** A mesma leitura de `/certificados/{id}` — a regra do dono e o escopo. */
async function dono_certificado(tx: Executor, usuario: UsuarioAtual, anexo: Anexo): Promise<Dono> {
  // o mesmo primeiro passo de `rotas/certificados._abrir`: quem não tem a
  // permissão nem cadastro de servidor leva 403 antes de o banco ser tocado
  if (!usuario.pode("certificado.ver") && usuario.servidor_id === null) {
    usuario.exigir("certificado.ver");
  }
  const certificado = await porta("certificado_no_escopo", "certificado")(tx, usuario, anexo.entidade_id);
  if (!certificado) throw new AnexoForaDeAlcance();
  porta("exigir_leitura_do_certificado", "certificado")(usuario, certificado.servidor_id);
  return {
    entidade: "certificado",
    servidor_id: certificado.servidor_id,
    processo_id: null,
    finalidade: "leitura de documento anexado ao certificado de treinamento",
  };
}

// A lista fechada. O que não está aqui não desce.
export const RESOLVEDORES: Readonly<Record<string, (tx: Executor, usuario: UsuarioAtual, anexo: Anexo) => Promise<Dono>>> =
  Object.freeze({
    processo: dono_processo,
    parecer_tecnico: dono_parecer,
    epi_ficha_registro: dono_ficha_epi,
    certificado: dono_certificado,
  });

/** Devolve o dono, ou levanta. Não escreve nada. */
export async function autorizar(tx: Executor, usuario: UsuarioAtual, anexo: Anexo | null | undefined): Promise<Dono> {
  if (!anexo || !anexo.ativo) throw new AnexoForaDeAlcance();
  const resolvedor = Object.hasOwn(RESOLVEDORES, anexo.entidade) ? RESOLVEDORES[anexo.entidade] : undefined;
  if (!resolvedor) throw new DonoNaoDeclarado(anexo.entidade);
  return resolvedor(tx, usuario, anexo);
}

/**
 * Duas linhas, porque são duas perguntas: `acesso_dado_sensivel` responde de
 * quem é o dado lido (só leitura de terceiro); `historico_evento` responde
 * qual arquivo saiu (sempre). A descrição não repete o nome do arquivo (§L-2).
 */
export async function registrar_leitura(tx: Executor, usuario: UsuarioAtual, anexo: Anexo, dono: Dono): Promise<void> {
  await auditoria.registrar_leitura_nominal(tx, usuario, `anexo.${anexo.categoria}`, {
    servidor_id: dono.servidor_id,
    processo_id: dono.processo_id,
    finalidade: dono.finalidade,
  });
  await auditoria.registrar(tx, {
    entidade: "anexo",
    entidade_id: anexo.id,
    processo_id: dono.processo_id,
    tipo_evento: ANEXO_BAIXADO,
    descricao: `Anexo ${anexo.id} (${anexo.categoria}) baixado — ${dono.entidade} ${anexo.entidade_id}.`,
    usuario,
  });
}

/** Autoriza **e** registra, nesta ordem, numa chamada só. */
export async function liberar(tx: Executor, usuario: UsuarioAtual, anexo: Anexo | null | undefined): Promise<Dono> {
  const dono = await autorizar(tx, usuario, anexo);
  await registrar_leitura(tx, usuario, anexo!, dono);
  return dono;
}
