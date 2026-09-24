/**
 * Fase 4 — os cinco relatórios de reconciliação da migração.
 * Porte de `app/servicos/reconciliacao.py`.
 *
 *   1. órfãos de processo    — cartões/linhas sem NUP
 *   2. órfãos de parecer     — pareceres sem processo, e processos que
 *                              deveriam ter parecer e não têm
 *   3. conflito de numeração — o mesmo número apontando para coisas diferentes
 *   4. NUPs com DV inválido  — digitados sem conferência
 *   5. divergência de marco  — marco inicial que não bate com a portaria
 *
 * Nenhum deles resolve nada sozinho: expõem para o Fabrício decidir.
 */
import { asc, desc, eq, isNotNull, like } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  migracao_rejeitada,
  parecer_tecnico,
  processo as tabela_processo,
  stg_planilha_parecer,
  stg_trello_cartao,
} from "../db/esquema/index.js";
import * as datas_br from "./datas_br.js";
import * as servico_nup from "./nup.js";
import { parecer_candidato } from "./importacao_trello.js";

export interface Achado {
  referencia: string;
  detalhe: string;
  processo_id: number | null;
  parecer_id: number | null;
}

function achado(referencia: string, detalhe: string, ids: { processo_id?: number; parecer_id?: number } = {}): Achado {
  return { referencia, detalhe, processo_id: ids.processo_id ?? null, parecer_id: ids.parecer_id ?? null };
}

export class Reconciliacao {
  orfaos_processo: Achado[] = [];
  orfaos_parecer: Achado[] = [];
  conflitos_numeracao: Achado[] = [];
  nups_dv_invalido: Achado[] = [];
  divergencias_marco: Achado[] = [];

  get total(): number {
    return (
      this.orfaos_processo.length +
      this.orfaos_parecer.length +
      this.conflitos_numeracao.length +
      this.nups_dv_invalido.length +
      this.divergencias_marco.length
    );
  }

  como_secoes(): [string, string, Achado[]][] {
    return [
      [
        "Órfãos de processo",
        "cartões e linhas sem NUP — precisam do número real para virar processo",
        this.orfaos_processo,
      ],
      ["Órfãos de parecer", "pareceres sem processo vinculado, e o contrário", this.orfaos_parecer],
      [
        "Conflito de numeração",
        "o mesmo número apontando para coisas diferentes — não resolver automaticamente, decidir caso a caso",
        this.conflitos_numeracao,
      ],
      ["NUPs com dígito verificador inválido", "entraram com a flag de dispensa; confirmar no SEI", this.nups_dv_invalido],
      [
        "Divergência de marco inicial",
        "a data do marco não bate com a publicação da portaria (RN-05)",
        this.divergencias_marco,
      ],
    ];
  }
}

async function _orfaos_processo(tx: Executor): Promise<Achado[]> {
  const achados: Achado[] = [];
  for (const cartao of await tx.select().from(stg_trello_cartao).orderBy(asc(stg_trello_cartao.id))) {
    if (!servico_nup.extrair(cartao.descricao).length) {
      achados.push(achado(`trello:${cartao.card_id}`, `cartão '${cartao.nome}' na lista '${cartao.lista}' sem NUP`));
    }
  }
  for (const linha of await tx.select().from(stg_planilha_parecer).orderBy(asc(stg_planilha_parecer.id))) {
    if (linha.col_b_numero_parecer && !linha.col_k_numero_processo) {
      achados.push(
        achado(
          `${linha.arquivo}:${linha.linha_origem}`,
          `parecer ${linha.col_b_numero_parecer}/${linha.col_d_ano || "?"} sem nº de processo na planilha`,
        ),
      );
    }
  }
  // NUPs sintéticos criados na migração do Trello (ano 1900)
  for (const processo of await tx
    .select()
    .from(tabela_processo)
    .where(like(tabela_processo.nup, "23086.%/1900-%"))
    .orderBy(asc(tabela_processo.id))) {
    achados.push(
      achado(processo.nup, "NUP sintético gerado na migração — substituir pelo número real", { processo_id: processo.id }),
    );
  }
  return achados;
}

async function _orfaos_parecer(tx: Executor): Promise<Achado[]> {
  const achados: Achado[] = [];
  for (const parecer of await tx.select().from(parecer_tecnico).orderBy(asc(parecer_tecnico.id))) {
    if (parecer.situacao === "RESERVADO") continue;
    const ref = `${parecer.numero}/${parecer.ano}`;
    if (parecer.processo_id === null) achados.push(achado(ref, "parecer sem processo vinculado", { parecer_id: parecer.id }));
    if (parecer.laudo_id === null && parecer.situacao !== "RASCUNHO") {
      achados.push(
        achado(ref, "parecer sem laudo — não há peça que caracterize a exposição", { parecer_id: parecer.id }),
      );
    }
  }
  return achados;
}

async function _conflitos_numeracao(tx: Executor): Promise<Achado[]> {
  const achados: Achado[] = [];
  const pareceres = new Map<string, { id: number; servidor: { nome: string } | null }>();
  for (const p of await tx.query.parecer_tecnico.findMany({
    with: { servidor: true },
    orderBy: [asc(parecer_tecnico.id)],
  })) {
    pareceres.set(`${p.numero}/${p.ano}`, p);
  }
  for (const cartao of await tx
    .select()
    .from(stg_trello_cartao)
    .where(isNotNull(stg_trello_cartao.parecer_candidato))
    .orderBy(asc(stg_trello_cartao.id))) {
    const candidato = cartao.parecer_candidato || parecer_candidato(cartao.nome);
    if (!candidato || !candidato.includes("/")) continue;
    const [numero, ano] = candidato.split("/");
    const parecer = pareceres.get(`${Number(numero)}/${Number(ano)}`);
    if (!parecer) {
      achados.push(
        achado(
          `trello:${cartao.card_id}`,
          `o título '${cartao.nome}' aponta o parecer ${candidato}, que não existe na planilha`,
        ),
      );
      continue;
    }
    const nome_no_cartao = (cartao.nome || "").toUpperCase();
    const nome_no_parecer = (parecer.servidor ? parecer.servidor.nome : "").toUpperCase();
    // `.split()[0]` do Python: a primeira palavra, cortando em qualquer branco
    const primeiro = nome_no_parecer.trim().split(/\s+/)[0] ?? "";
    if (nome_no_parecer && !nome_no_cartao.includes(primeiro)) {
      achados.push(
        achado(
          candidato,
          `o cartão '${cartao.nome}' aponta o parecer ${candidato}, ` +
            `mas na planilha esse número é de '${parecer.servidor!.nome}'`,
          { parecer_id: parecer.id },
        ),
      );
    }
  }
  for (const parecer of await tx
    .select()
    .from(parecer_tecnico)
    .where(eq(parecer_tecnico.situacao, "RESERVADO"))
    .orderBy(asc(parecer_tecnico.id))) {
    achados.push(
      achado(
        `${parecer.numero}/${parecer.ano}`,
        "número reservado e nunca preenchido — conferir se não existe parecer assinado com ele",
        { parecer_id: parecer.id },
      ),
    );
  }
  return achados;
}

async function _nups_dv_invalido(tx: Executor): Promise<Achado[]> {
  const achados: Achado[] = [];
  for (const processo of await tx.select().from(tabela_processo).orderBy(asc(tabela_processo.id))) {
    const resultado = servico_nup.validar(processo.nup);
    if (!resultado.dv_ok) {
      achados.push(
        achado(
          processo.nup,
          "dígito verificador não confere" + (processo.nup_dv_dispensado ? " (dispensa registrada)" : ""),
          { processo_id: processo.id },
        ),
      );
    }
  }
  return achados;
}

async function _divergencias_marco(tx: Executor): Promise<Achado[]> {
  const achados: Achado[] = [];
  for (const parecer of await tx.query.parecer_tecnico.findMany({
    with: { tipo_marco: true, portaria: true },
    orderBy: [asc(parecer_tecnico.id)],
  })) {
    if (parecer.data_marco_inicial === null || parecer.tipo_marco === null) continue;
    const ref = `${parecer.numero}/${parecer.ano}`;
    if (parecer.tipo_marco.codigo !== "PORTARIA_LOCALIZACAO") {
      if (!parecer.justificativa_marco) {
        achados.push(
          achado(
            ref,
            `marco '${parecer.tipo_marco.rotulo}' em ${datas_br.numerica(parecer.data_marco_inicial)} sem justificativa`,
            { parecer_id: parecer.id },
          ),
        );
      }
      continue;
    }
    if (parecer.portaria === null) {
      achados.push(
        achado(ref, "marco é a portaria de localização, mas não há portaria vinculada", { parecer_id: parecer.id }),
      );
    } else if (parecer.data_marco_inicial !== parecer.portaria.data_publicacao) {
      achados.push(
        achado(
          ref,
          `marco ${datas_br.numerica(parecer.data_marco_inicial)} × portaria ` +
            `${datas_br.numerica(parecer.portaria.data_publicacao)}`,
          { parecer_id: parecer.id },
        ),
      );
    }
  }
  return achados;
}

export async function reconciliar(tx: Executor): Promise<Reconciliacao> {
  const r = new Reconciliacao();
  r.orfaos_processo = await _orfaos_processo(tx);
  r.orfaos_parecer = await _orfaos_parecer(tx);
  r.conflitos_numeracao = await _conflitos_numeracao(tx);
  r.nups_dv_invalido = await _nups_dv_invalido(tx);
  r.divergencias_marco = await _divergencias_marco(tx);
  return r;
}

export async function rejeitadas(tx: Executor, limite = 200) {
  return tx.select().from(migracao_rejeitada).orderBy(desc(migracao_rejeitada.id)).limit(limite);
}
