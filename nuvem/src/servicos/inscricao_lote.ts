/**
 * A inscrição em lote: a lista colada da planilha, uma pessoa por linha.
 *
 * Cada célula se reconhece pelo conteúdo, e não pela coluna — a planilha de
 * cada setor tem uma ordem: sete dígitos são SIAPE, o que tem @ é e-mail, o
 * primeiro texto é o nome e o segundo é a organização. Telefone e cargo não
 * são guardados (o sistema não tem onde, de propósito), e o CPF nem chega
 * aqui: a porta do formulário o mascara (`dependencias.semCpf`), e ele entra
 * só pelo campo próprio da inscrição, quando o certificado o exige.
 *
 * A pessoa é a mesma das portas de um por um (`rotas/turmas.ts`): SIAPE é o
 * servidor da base; e-mail conhecido é o participante que já existe; o nome,
 * para quem pode ver nome, casa com UM servidor ou UM externo já cadastrado —
 * dois com o mesmo nome é recusa, não palpite. O que sobra vira externo novo.
 *
 * Cada linha corre no seu savepoint: a que falha (sem vaga, já inscrita) não
 * desfaz as outras. Conferir é a mesma passada dentro de um savepoint que se
 * desfaz no fim — a conferência diz exatamente o que a gravação faria.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  inscricao as tabela_inscricao,
  participante as tabela_participante,
  servidor as tabela_servidor,
} from "../db/esquema/index.js";
import { ROTULO_INSCRICAO } from "../dominio/estados.js";
import { VINCULOS_PARTICIPANTE } from "../dominio/treinamento.js";
import * as duplicados from "./duplicados.js";
import * as servico_participante from "./participante.js";
import { DadosDoParticipante, nome_exibicao, type ParticipanteCarregado } from "./participante.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";
import * as servico_turma from "./turma.js";
import { RegraDaTurma, type TurmaCarregada } from "./turma.js";

/** Uma turma recebe lista grande, mas não a base inteira por engano. */
export const LIMITE_LINHAS = 300;

export interface LinhaLida {
  numero: number;
  nome: string;
  siape: string;
  email: string;
  organizacao: string;
  /** o que a linha trouxe e o sistema não guarda */
  ignorados: string[];
  erro: string;
}

/**
 * `A_DECIDIR` (23/10/2026): a linha parece um cadastro que já existe, e quem
 * lê nomes escolhe — "usar este" ou "criar novo". Não é inscrita enquanto não
 * houver escolha (decisão do dono: perguntar linha a linha, nunca casar
 * sozinho pelo nome parecido).
 */
export type Resultado = "INSCRITA" | "JA_INSCRITA" | "RECUSADA" | "A_DECIDIR";

/** A escolha de uma linha: o id do cadastro parecido, ou criar um novo. */
export type Escolha = number | "novo";

export interface Desfecho {
  numero: number;
  resultado: Resultado;
  /** a assinatura da linha (o texto dela), que liga a escolha à linha mesmo que a lista seja renumerada */
  chave: string;
  /** com quem a linha parece (só em `A_DECIDIR`, e só quem o usuário pode identificar) */
  parecidos: duplicados.ParecidoNaTela[];
  /** a escolha que chegou para esta linha, para a tela marcar de novo */
  escolha: string;
  /** quem a linha virou, como a tela pode mostrar */
  quem: string;
  /** por qual porta a pessoa foi achada (ou criada) */
  como: string;
  motivo: string;
  ignorados: string[];
  /** a linha como foi colada, para voltar à caixa quando recusada */
  texto: string;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_SIAPE = /^\d{6,7}$/;
// o que sobra de um telefone: 10 ou 11 dígitos, com ou sem DDD e pontuação
const RE_TELEFONE = /^\+?[\d\s().-]{8,20}$/;
// cabeçalho da planilha colado junto
const CABECALHOS = new Set(["nome", "nome completo", "participante", "servidor", "aluno"]);

function _celulas(linha: string): string[] {
  const separador = linha.includes("\t") ? "\t" : linha.includes(";") ? ";" : ",";
  return linha
    .split(separador)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** As linhas da caixa de texto, já com cada célula no seu lugar. */
export function ler_lista(texto: string): { linhas: LinhaLida[]; brutas: Map<number, string> } {
  const linhas: LinhaLida[] = [];
  const brutas = new Map<number, string>();
  (texto ?? "").split(/\r\n|\r|\n/).forEach((bruta, i) => {
    const celulas = _celulas(bruta);
    if (!celulas.length) return;
    if (CABECALHOS.has(textos.chave_busca(celulas[0]))) return;
    const lida: LinhaLida = { numero: i + 1, nome: "", siape: "", email: "", organizacao: "", ignorados: [], erro: "" };
    for (const celula of celulas) {
      const compacta = celula.replace(/\s+/g, "");
      if (celula.includes(textos.CPF_MASCARADO) || (/^\d{11}$/.test(compacta) && textos.cpf_valido(compacta))) {
        lida.ignorados.push("CPF");
      } else if (RE_SIAPE.test(compacta) && !lida.siape) {
        lida.siape = compacta.padStart(7, "0");
      } else if (RE_EMAIL.test(compacta) && !lida.email) {
        lida.email = compacta;
      } else if (/\d/.test(celula) && RE_TELEFONE.test(celula)) {
        lida.ignorados.push("telefone");
      } else if (/\d/.test(celula) && !/\p{L}/u.test(celula)) {
        lida.erro = `“${celula}” não é SIAPE (7 dígitos), e-mail nem nome.`;
      } else if (!lida.nome) {
        lida.nome = celula;
      } else if (!lida.organizacao) {
        lida.organizacao = celula;
      } else {
        lida.ignorados.push("cargo/função");
      }
    }
    if (!lida.erro && !lida.nome && !lida.siape && !lida.email) lida.erro = "Linha sem nome, SIAPE ou e-mail.";
    linhas.push(lida);
    brutas.set(lida.numero, textos.mascarar_cpf(bruta.trim()));
  });
  return { linhas, brutas };
}

class LinhaRecusada extends Error {}

/** A linha parece cadastro existente e espera a escolha de quem lê nomes. */
class LinhaPergunta extends Error {
  constructor(readonly parecidos: duplicados.ParecidoNaTela[]) {
    super("Parece com cadastro que já existe: escolha “usar este” ou “criar novo” e confira de novo.");
  }
}

/** A assinatura de uma linha: o texto dela sem acento, caixa nem espaço sobrando. */
export function chave_da_linha(texto: string): string {
  return createHash("sha256").update(textos.chave_busca(texto), "utf8").digest("hex").slice(0, 12);
}

function _quem(usuario: UsuarioAtual, pessoa: ParticipanteCarregado): string {
  if (pessoa.servidor && !servico_participante.pode_identificar(usuario, pessoa)) {
    return `SIAPE ${pessoa.servidor.siape}`;
  }
  return nome_exibicao(pessoa);
}

/**
 * Quem pode casar pelo nome: casar diria de quem é o nome (RN-19).
 *
 * D29: é a mesma pergunta que a turma faz para MOSTRAR o nome
 * (`participante.pode_identificar`): `certificado.ver` — quem opera a emissão
 * lê o nome de quem está na turma — ou `exposicao.ver`. Era `ve_dado_nominal`,
 * e a secretaria lia o nome do inscrito na ficha e não conseguia inscrever o
 * mesmo nome em lote; o almoxarife, com `epi.ficha`, conseguia, embora turma
 * não seja tela de EPI. Exportada para a tela do lote dizer o mesmo que o
 * serviço faz.
 */
export function casa_nome(usuario: UsuarioAtual): boolean {
  return usuario.pode("certificado.ver") || usuario.pode("exposicao.ver");
}

async function _por_nome(tx: Executor, nome: string): Promise<[ParticipanteCarregado | null, string]> {
  const alvo = textos.chave_busca(nome);
  // servidor da base: o nome do cadastro, não o de um participante
  const servidores = (await tx.select().from(tabela_servidor)).filter((s) => textos.chave_busca(s.nome) === alvo);
  if (servidores.length > 1) {
    throw new LinhaRecusada(`Há ${servidores.length} servidores com este nome: informe o SIAPE.`);
  }
  if (servidores.length === 1) return [await servico_participante.de_servidor(tx, servidores[0]!), "servidor, pelo nome"];
  const externos = (
    await tx
      .select({ id: tabela_participante.id, nome: tabela_participante.nome })
      .from(tabela_participante)
      .where(and(eq(tabela_participante.ativo, true), isNull(tabela_participante.mesclado_em_id)))
  ).filter((p) => p.nome !== null && textos.chave_busca(p.nome) === alvo);
  if (externos.length > 1) {
    throw new LinhaRecusada(`Há ${externos.length} participantes externos com este nome: informe o e-mail.`);
  }
  if (externos.length === 1) return [(await servico_participante.carregar(tx, externos[0]!.id))!, "já participou, pelo nome"];
  return [null, ""];
}

/**
 * Quem a linha é. A ordem de sempre (SIAPE, e-mail, nome exato), e antes de
 * criar externo novo a pergunta do critério único (`duplicados.procurar`):
 *
 * - quem lê nomes recebe "parece com …" (`LinhaPergunta`) e escolhe, linha a
 *   linha, "usar este" ou "criar novo" — o "criar novo" grava o par como
 *   pessoas diferentes;
 * - o e-mail conhecido com nome que NÃO parece o do cadastro também pergunta
 *   (era a linha caindo calada na pessoa errada: o e-mail do setor, da mãe);
 * - quem não lê nomes não pode receber a pergunta (RN-19): o externo nasce e,
 *   havendo parecido, fica marcado como suspeito para quem lê nomes conferir.
 */
async function _pessoa(
  tx: Executor,
  usuario: UsuarioAtual,
  l: LinhaLida,
  padrao: { vinculo: string; organizacao: string },
  escolha: Escolha | undefined,
): Promise<[ParticipanteCarregado, string]> {
  if (l.siape) {
    const [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, l.siape));
    if (!servidor) throw new LinhaRecusada(`SIAPE ${l.siape} não está no cadastro de servidores.`);
    const pessoa = await servico_participante.de_servidor(tx, servidor, usuario);
    await servico_participante.registrar_email(tx, pessoa, l.email);
    return [pessoa, "servidor, pelo SIAPE"];
  }
  const pergunta = casa_nome(usuario);
  const parecidos = async () =>
    duplicados.procurar(tx, { nome: l.nome, emails: [l.email] }, { limite: 50 });
  if (typeof escolha === "number" && pergunta) {
    // "usar este": só vale um dos parecidos da linha, e que o usuário pode identificar
    const alvo = duplicados.visiveis(await parecidos(), usuario).find((p) => p.pessoa.id === escolha);
    if (alvo) {
      await servico_participante.registrar_email(tx, alvo.pessoa, l.email);
      return [alvo.pessoa, "escolhido na conferência"];
    }
  }
  if (l.email) {
    const pessoa = await servico_participante.por_email(tx, l.email);
    if (pessoa) {
      const confere = !l.nome || duplicados.nomes_parecidos(nome_exibicao(pessoa), l.nome);
      if (confere || !pergunta) return [pessoa, "já participou, pelo e-mail"];
      if (escolha !== "novo") {
        const vistos = duplicados.visiveis(await parecidos(), usuario);
        throw new LinhaPergunta(duplicados.na_tela(vistos.length ? vistos : [{ pessoa, motivo: "EMAIL" }], usuario));
      }
    }
  }
  if (l.nome && pergunta && escolha !== "novo") {
    const [pessoa, como] = await _por_nome(tx, l.nome);
    if (pessoa) {
      await servico_participante.registrar_email(tx, pessoa, l.email);
      return [pessoa, como];
    }
  }
  if (!l.nome) throw new LinhaRecusada("Sem nome, e o e-mail não é de ninguém cadastrado.");
  const achados = l.nome || l.email ? await parecidos() : [];
  const vistos = pergunta ? duplicados.visiveis(achados, usuario) : [];
  if (vistos.length && escolha !== "novo") throw new LinhaPergunta(duplicados.na_tela(vistos, usuario));
  const pessoa = await servico_participante.criar_externo(tx, {
    nome: l.nome,
    vinculo: padrao.vinculo,
    usuario,
    email: l.email,
    organizacao: l.organizacao || padrao.organizacao,
  });
  if (escolha === "novo") {
    // "criar novo" é a resposta "não é a mesma pessoa" para cada parecido mostrado
    for (const p of vistos) await duplicados.marcar_distintos(tx, usuario, pessoa.id, p.pessoa.id, "LOTE");
    return [pessoa, "externo novo (conferido)"];
  }
  // a marca é silenciosa: dizer "parece alguém" a quem não lê nomes seria
  // dizer que esse alguém existe
  if (!pergunta && achados.length) await duplicados.marcar_suspeito(tx, pessoa, usuario);
  return [pessoa, "externo novo"];
}

/**
 * Inscreve cada linha no seu savepoint. `simular` desfaz tudo no fim: é a
 * conferência, que passa pelas mesmas guardas (vaga, duplicidade, turma
 * aberta) que a gravação.
 */
export async function processar(
  tx: Executor,
  usuario: UsuarioAtual,
  turma: TurmaCarregada,
  texto: string,
  padrao: { vinculo: string; organizacao: string },
  simular: boolean,
  escolhas: ReadonlyMap<string, Escolha> = new Map(),
): Promise<Desfecho[]> {
  usuario.exigir("turma.inscrever");
  if (!(VINCULOS_PARTICIPANTE as readonly string[]).includes(padrao.vinculo) || padrao.vinculo === "SERVIDOR") {
    throw new RegraDaTurma("Escolha o vínculo de quem não é servidor: terceirizado, discente, visitante ou outro.");
  }
  const { linhas, brutas } = ler_lista(texto);
  if (!linhas.length) throw new RegraDaTurma("A lista está vazia: cole uma pessoa por linha.");
  if (linhas.length > LIMITE_LINHAS) {
    throw new RegraDaTurma(`A lista tem ${linhas.length} linhas; o limite é ${LIMITE_LINHAS} por vez.`);
  }
  const passada = async (sp: Executor): Promise<Desfecho[]> => {
    const desfechos: Desfecho[] = [];
    const vistos = new Set<number>();
    for (const l of linhas) {
      const texto_linha = brutas.get(l.numero)!;
      const chave = chave_da_linha(texto_linha);
      const escolha = escolhas.get(chave);
      const base = {
        numero: l.numero,
        quem: l.nome || l.siape || l.email,
        como: "",
        motivo: "",
        ignorados: l.ignorados,
        texto: texto_linha,
        chave,
        parecidos: [] as duplicados.ParecidoNaTela[],
        escolha: escolha === undefined ? "" : String(escolha),
      };
      if (l.erro) {
        desfechos.push({ ...base, resultado: "RECUSADA", motivo: l.erro });
        continue;
      }
      try {
        const desfecho = await sp.transaction(async (linha_sp) => {
          const t = linha_sp as Executor;
          const [pessoa, como] = await _pessoa(t, usuario, l, padrao, escolha);
          const quem = _quem(usuario, pessoa);
          if (vistos.has(pessoa.id)) {
            return { ...base, quem, como, resultado: "JA_INSCRITA" as const, motivo: "Repetida na lista." };
          }
          vistos.add(pessoa.id);
          const [ja] = await t
            .select({ situacao: tabela_inscricao.situacao })
            .from(tabela_inscricao)
            .where(and(eq(tabela_inscricao.turma_id, turma.id), eq(tabela_inscricao.participante_id, pessoa.id)));
          if (ja) {
            const situacao = (ROTULO_INSCRICAO[ja.situacao] ?? ja.situacao).toLowerCase();
            return { ...base, quem, como, resultado: "JA_INSCRITA" as const, motivo: `Já consta na turma como ${situacao}.` };
          }
          await servico_turma.inscrever(t, usuario, turma, pessoa);
          return { ...base, quem, como, resultado: "INSCRITA" as const };
        });
        desfechos.push(desfecho);
      } catch (erro) {
        if (erro instanceof LinhaPergunta) {
          desfechos.push({ ...base, resultado: "A_DECIDIR", motivo: erro.message, parecidos: erro.parecidos });
          continue;
        }
        if (erro instanceof LinhaRecusada || erro instanceof RegraDaTurma || erro instanceof DadosDoParticipante) {
          desfechos.push({ ...base, resultado: "RECUSADA", motivo: erro.message });
          continue;
        }
        throw erro;
      }
    }
    return desfechos;
  };
  if (!simular) return passada(tx);
  let conferido: Desfecho[] = [];
  try {
    await tx.transaction(async (sp) => {
      conferido = await passada(sp as Executor);
      throw new Simulacao();
    });
  } catch (erro) {
    if (!(erro instanceof Simulacao)) throw erro;
  }
  return conferido;
}

class Simulacao extends Error {}
