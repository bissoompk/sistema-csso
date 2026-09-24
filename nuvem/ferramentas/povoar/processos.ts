/**
 * O povoamento de Processos SEI / Adicional Ocupacional do ambiente de teste.
 * Porte dos trechos "Portarias e laudos", "Processos", "Pareceres" e "L2
 * superado" de `ferramentas/ambiente_teste_cli.py`.
 *
 * Ordem e conteúdo são os do Python: duas portarias, três laudos (L1, L2, L3),
 * onze processos — um em cada coluna do kanban, três fora do SLA, um no
 * repositório —, três pareceres (dois emitidos e assinados, um rascunho de
 * agente químico), dois adicionais concedidos, e o L2 superado pelo L3, que
 * põe o rascunho em reavaliação pela cascata da RN-11.
 *
 * **Por que passa pelos serviços.** Numeração (RN-03), contexto congelado
 * (RN-15), máquina de estados e a cadeia de auditoria moram nos serviços. Onde
 * não há serviço (criar processo, laudo, portaria, rascunho de parecer),
 * imita-se a rota — inclusive o `auditoria.registrar` que ela faria.
 *
 * Quem chama (`ferramentas/ambiente-teste.ts`) passa a transação e o `ctx`
 * (`atual(login)` e `resumo`), depois de criar as contas, os servidores (com
 * lotação) e as habilitações — a coordenadora "Nádia Quintanilha Serra" é a
 * signatária. `envelhecer_pendencias` é o passo final do Python (roda depois de
 * TODOS os módulos terem aberto as suas pendências).
 */
import { asc, eq, like } from "drizzle-orm";
import type { Executor } from "../../src/db/cliente.js";
import * as e from "../../src/db/esquema/index.js";
import { agora_utc } from "../../src/db/esquema/base.js";
import { hoje_iso, somar_dias } from "../../src/dominio/datas.js";
import * as anexos from "../../src/servicos/anexos.js";
import * as auditoria from "../../src/servicos/auditoria.js";
import * as direito from "../../src/servicos/direito.js";
import * as documento from "../../src/servicos/documento.js";
import { nup_dv } from "../../src/servicos/nup.js";
import * as servico_parecer from "../../src/servicos/parecer.js";
import * as pendencias from "../../src/servicos/pendencias.js";
import * as servico_processo from "../../src/servicos/processo.js";
import * as servidores from "../../src/servicos/servidores.js";
import type { UsuarioAtual } from "../../src/servicos/rbac.js";

export interface ContextoPovoar {
  /** a conta semeada `login`, resolvida como a sessão a resolveria */
  atual: (login: string) => Promise<UsuarioAtual>;
  /** o resumo impresso no fim (`resumo["processos"] = 11` ...) */
  resumo: Record<string, number>;
}

// O PDF falso de formulário e de comprovante: o que se testa nas telas é o
// anexo existir, ter categoria e ter SHA-256 — não o conteúdo.
export const PDF_FALSO =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n";

export const SIGNATARIA = "Nádia Quintanilha Serra";

type Processo = typeof e.processo.$inferSelect;

async function um<T>(consulta: Promise<T[]>, o_que: string): Promise<T> {
  const [linha] = await consulta;
  if (!linha) throw new Error(`povoar processos: não achei ${o_que}`);
  return linha;
}

export function nup_de(sequencial: number, ano: number): string {
  const seq = String(sequencial).padStart(6, "0");
  return `23086.${seq}/${ano}-${nup_dv(`23086${seq}${ano}`)}`;
}

export async function povoar_processos(tx: Executor, ctx: ContextoPovoar): Promise<void> {
  const hoje = hoje_iso();
  const ano = Number(hoje.slice(0, 4));
  const unidade = (sigla: string) => um(tx.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla)), sigla);
  const pessoa = (siape: string) => um(tx.select().from(e.servidor).where(eq(e.servidor.siape, siape)), siape);

  // -----------------------------------------------------------------
  // Portarias e laudos. Laudo não tem serviço de criação (a rota POST /laudos
  // monta a linha); superar um laudo, sim — e é por `marcar_laudo_superado` que
  // a cascata da RN-11 abre as pendências de reavaliação.
  // -----------------------------------------------------------------
  const famed = await unidade("FAMED");
  const iect = await unidade("IECT");
  const insal = await um(tx.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE")), "insalubridade");
  const signataria = await um(
    tx.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.nome, SIGNATARIA)),
    SIGNATARIA,
  );
  for (const [sigla, u, numero, dias] of [
    ["FAMED", famed, "12", 760],
    ["IECT", iect, "07", 540],
  ] as const) {
    const dia = somar_dias(hoje, -dias);
    const [a, m, d] = dia.split("-");
    await tx.insert(e.portaria_localizacao).values({
      unidade_emissora_id: u.id,
      numero,
      ano: Number(a),
      data_publicacao: dia,
      texto_original: `PORTARIA/${sigla} Nº ${numero}, DE ${Number(d)} DE ${m} DE ${a} (dado de teste)`,
    });
  }
  const laudos: [string, number, number, number][] = [
    [`26255-000.301/${ano - 2}`, ano - 2, famed.id, 800],
    [`26255-000.302/${ano - 2}`, ano - 2, iect.id, 790],
    [`26255-000.303/${ano}`, ano, iect.id, 60],
  ];
  for (const [numero_siape, ano_laudo, unidade_uorg_id, dias] of laudos) {
    await tx.insert(e.laudo_tecnico).values({
      numero_siape,
      ano: ano_laudo,
      tipo_adicional_id: insal.id,
      unidade_uorg_id,
      data_emissao: somar_dias(hoje, -dias),
      subscritor_id: signataria.id,
      status: "VIGENTE",
    });
  }
  ctx.resumo.laudos = laudos.length;

  // -----------------------------------------------------------------
  // Processos: um em cada coluna do kanban, três fora do SLA.
  // -----------------------------------------------------------------
  const anexar = (usuario: UsuarioAtual, processo: Processo, categoria: string, nome: string) =>
    anexos.guardar(tx, {
      entidade: "processo",
      entidade_id: processo.id,
      nome_original: nome,
      conteudo: new TextEncoder().encode(PDF_FALSO + `%${categoria}:${processo.id}`),
      mime_type: "application/pdf",
      categoria,
      usuario,
      processo_id: processo.id,
    });

  /** Imita `POST /processos/novo` — não há serviço de criação de processo. */
  const criar_processo = async (
    usuario: UsuarioAtual,
    o: {
      sequencial: number;
      codigo_tipo: string;
      servidor: { id: number } | null;
      unidade: { id: number } | null;
      observacoes: string;
      estado_inicial?: string;
      repositorio?: boolean;
      dias_atras?: number;
    },
  ): Promise<Processo> => {
    const estado = o.estado_inicial ?? "RECEBIDO";
    const tipo = await um(tx.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, o.codigo_tipo)), o.codigo_tipo);
    const coluna = estado === "NAO_INICIADO" ? "NAO_INICIADO" : "A_FAZER";
    const etapa = await um(tx.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, coluna)), coluna);
    const [processo] = await tx
      .insert(e.processo)
      .values({
        nup: nup_de(o.sequencial, ano),
        tipo_processo_id: tipo.id,
        etapa_id: etapa.id,
        estado_tecnico: estado,
        servidor_id: o.servidor ? o.servidor.id : null,
        unidade_uorg_id: o.unidade ? o.unidade.id : null,
        data_autuacao: somar_dias(hoje, -(o.dias_atras ?? 30)),
        ano_referencia: ano,
        observacoes: o.observacoes,
        origem_repositorio: o.repositorio ?? false,
        responsavel_id: usuario.id,
      })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "processo",
      entidade_id: processo!.id,
      processo_id: processo!.id,
      tipo_evento: "PROCESSO_CRIADO",
      descricao: `Processo ${processo!.nup} criado.`,
      usuario,
    });
    return processo!;
  };

  /**
   * Empurra a entrada na etapa para trás, para o SLA estourar. É a única coisa
   * que esta ferramenta escreve direto numa coluna de estado: `mover` carimba
   * `entrou_na_etapa_em` com o agora, e o único jeito honesto de ter cartão
   * vermelho na tela seria esperar quarenta dias. Simula a passagem do tempo —
   * não contorna regra nenhuma, e não mexe em número, hash nem trilha.
   */
  const envelhecer = async (processo: Processo, dias: number) => {
    await tx
      .update(e.processo)
      .set({ entrou_na_etapa_em: new Date(agora_utc().getTime() - dias * 86_400_000) })
      .where(eq(e.processo.id, processo.id));
  };

  const coord = await ctx.atual("coordenador");
  const tecnico = await ctx.atual("tecnico");
  const dodo = await unidade("DODO");
  const fammuc = await unidade("FAMMUC");
  const ica = await unidade("ICA");
  const mover = (p: Processo, destino: string, quem: UsuarioAtual, o: servico_processo.OpcoesMover = {}) =>
    servico_processo.mover(tx, p, destino, quem, o);
  const documentos = async (p: Processo) => {
    await anexar(coord, p, "PORTARIA", "portaria_localizacao.pdf");
    await anexar(coord, p, "FORMULARIO", "formulario_art17.pdf");
  };

  // 1) Não iniciado, no quadro — e o gêmeo no repositório (aba Backlog). Com
  // só um deles, uma das duas telas nasceria vazia, e vazia sem erro nenhum.
  await criar_processo(coord, {
    sequencial: 100001,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010101"),
    unidade: null,
    observacoes: "Migrado do Trello, ainda sem triagem. Dado de teste.",
    estado_inicial: "NAO_INICIADO",
    dias_atras: 400,
  });
  await criar_processo(coord, {
    sequencial: 100011,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010101"),
    unidade: null,
    observacoes: "Cartão do repositório Adicional Ocupacional. Dado de teste.",
    estado_inicial: "NAO_INICIADO",
    repositorio: true,
    dias_atras: 430,
  });

  // 2) Recém-chegado, dentro do prazo (coluna A fazer)
  await criar_processo(coord, {
    sequencial: 100002,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010112"),
    unidade: famed,
    observacoes: "Solicitação recebida da PROGEP. Dado de teste.",
    dias_atras: 3,
  });

  // 3) Parado em triagem há 41 dias — SLA da coluna A fazer é 15
  const p3 = await criar_processo(coord, {
    sequencial: 100003,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010099"),
    unidade: dodo,
    observacoes: "Aguardando conferência dos documentos. Dado de teste.",
    dias_atras: 60,
  });
  await mover(p3, "EM_TRIAGEM", coord);
  await envelhecer(p3, 41);

  // 4) Pendente de documento há 35 dias — SLA da coluna Aguardando é 20
  const p5 = await criar_processo(coord, {
    sequencial: 100005,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010044"),
    unidade: fammuc,
    observacoes: "Aguardando o formulário do art. 17 corrigido. Dado de teste.",
    dias_atras: 70,
  });
  await documentos(p5);
  await mover(p5, "EM_TRIAGEM", coord);
  await mover(p5, "PENDENTE_DOCUMENTO", coord);
  await envelhecer(p5, 35);

  // 5) Sobrestado (coluna Aguardando), com o estado anterior guardado
  const p6 = await criar_processo(coord, {
    sequencial: 100006,
    codigo_tipo: "APOSENTADORIA_ESPECIAL",
    servidor: await pessoa("3010123"),
    unidade: null,
    observacoes: "Sobrestado à espera de decisão administrativa. Dado de teste.",
    dias_atras: 120,
  });
  await documentos(p6);
  await mover(p6, "EM_TRIAGEM", coord);
  await mover(p6, "PENDENTE_DOCUMENTO", coord);
  await mover(p6, "SOBRESTADO", coord, { comentario: "Sobrestado a pedido da unidade." });

  // 6) Aguardando quantificação há 95 dias — o agente químico da RN-06
  const p7 = await criar_processo(coord, {
    sequencial: 100007,
    codigo_tipo: "PARECER_TECNICO",
    servidor: await pessoa("3010055"),
    unidade: ica,
    observacoes: "Agente químico: falta o relatório de ensaio. Dado de teste.",
    dias_atras: 140,
  });
  await documentos(p7);
  await mover(p7, "EM_TRIAGEM", coord);
  await mover(p7, "AGUARDANDO_INSPECAO", coord);
  await mover(p7, "INSPECIONADO", tecnico);
  await mover(p7, "AGUARDANDO_QUANTIFICACAO", tecnico);
  await envelhecer(p7, 95);

  // 7) Indeferido tecnicamente (coluna Concluído), com o inciso do art. 11
  const p10 = await criar_processo(coord, {
    sequencial: 100010,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010088"),
    unidade: null,
    observacoes: "Atividade-meio, sem exposição ao agente. Dado de teste.",
    dias_atras: 90,
  });
  await documentos(p10);
  await mover(p10, "EM_TRIAGEM", coord);
  await mover(p10, "INDEFERIDO_TECNICAMENTE", coord, {
    inciso_art11: "II",
    comentario: "Atividade administrativa, sem exposição habitual.",
  });

  // 8) e 9) os que levam parecer: um em elaboração, dois até o SEI
  const ate_parecer = async (p: Processo) => {
    await documentos(p);
    await mover(p, "EM_TRIAGEM", coord);
    await mover(p, "AGUARDANDO_INSPECAO", coord);
    await mover(p, "INSPECIONADO", tecnico);
    await mover(p, "LAUDO_EM_ELABORACAO", tecnico);
    await mover(p, "LAUDO_EMITIDO", tecnico);
    await mover(p, "PARECER_EM_ELABORACAO", tecnico);
  };
  const p4 = await criar_processo(coord, {
    sequencial: 100004,
    codigo_tipo: "PARECER_TECNICO",
    servidor: await pessoa("3010022"),
    unidade: iect,
    observacoes: "Parecer em elaboração — laboratório de química. Dado de teste.",
    dias_atras: 45,
  });
  await ate_parecer(p4);
  const p8 = await criar_processo(coord, {
    sequencial: 100008,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010011"),
    unidade: famed,
    observacoes: "Parecer emitido e assinado, a incluir no SEI. Dado de teste.",
    dias_atras: 150,
  });
  await ate_parecer(p8);
  const p9 = await criar_processo(coord, {
    sequencial: 100009,
    codigo_tipo: "ADICIONAL_OCUPACIONAL",
    servidor: await pessoa("3010077"),
    unidade: famed,
    observacoes: "Processo encerrado com direito reconhecido. Dado de teste.",
    dias_atras: 300,
  });
  await ate_parecer(p9);
  ctx.resumo.processos = 11;

  // -----------------------------------------------------------------
  // Pareceres. O rascunho imita `GET /processos/{id}/parecer` (não há serviço
  // de criação); a emissão passa por `parecer.emitir`, que é onde estão o
  // número da RN-03, o congelado da RN-15 e o documento.
  // -----------------------------------------------------------------
  const montar_rascunho = async (
    usuario: UsuarioAtual,
    processo: Processo,
    o: { laudo: { id: number }; portaria: { id: number; data_publicacao: string }; agente_descricao: string; texto_reavaliacao?: string | null },
  ) => {
    const concessao = await um(tx.select().from(e.tipo_movimento).where(eq(e.tipo_movimento.codigo, "CONCESSAO")), "CONCESSAO");
    const marco = await um(
      tx.select().from(e.tipo_marco_inicial).where(eq(e.tipo_marco_inicial.codigo, "PORTARIA_LOCALIZACAO")),
      "marco",
    );
    const destinatario = await um(
      tx.select().from(e.autoridade_destinataria).orderBy(asc(e.autoridade_destinataria.id)).limit(1),
      "destinatário",
    );
    const agente = await um(
      tx.select().from(e.agente_nocivo).where(eq(e.agente_nocivo.descricao, o.agente_descricao)),
      o.agente_descricao,
    );
    const tipo_risco = await um(tx.select().from(e.tipo_risco).where(eq(e.tipo_risco.id, agente.tipo_risco_id)), "risco");
    const percentual = await um(
      tx.select().from(e.percentual_aplicavel).where(eq(e.percentual_aplicavel.id, agente.percentual_sugerido_id!)),
      "percentual sugerido",
    );
    const lotacao = await servidores.lotacao_vigente(tx, processo.servidor_id!);
    const alteracao = await um(tx.select().from(e.texto_padrao).where(eq(e.texto_padrao.codigo, "COMUNICAR_SEST")), "COMUNICAR_SEST");
    const unidade_uorg_id = lotacao ? lotacao.unidade_uorg_id : processo.unidade_uorg_id;
    const [rascunho] = await tx
      .insert(e.parecer_tecnico)
      .values({
        numero: 0,
        ano,
        situacao: "RASCUNHO",
        processo_id: processo.id,
        servidor_id: processo.servidor_id,
        laudo_id: o.laudo.id,
        tipo_adicional_id: insal.id,
        tipo_movimento_id: concessao.id,
        unidade_uorg_id,
        portaria_id: o.portaria.id,
        destinatario_id: destinatario.id,
        signatario_id: signataria.id,
        tipo_marco_id: marco.id,
        data_marco_inicial: o.portaria.data_publicacao,
        texto_recomendacao:
          "Reconhecer o direito ao adicional de insalubridade caracterizado " +
          `pela exposição ao ${tipo_risco.nome}, a partir da data da ` +
          "Portaria de Localização.",
        texto_alteracao: alteracao.template.replaceAll("{{sigla_unidade_emissora}}", "CSSO/Sisa"),
        texto_reavaliacao: o.texto_reavaliacao ?? null,
        criado_por: usuario.id,
        modelo_arquivo: documento.MODELO_V1,
      })
      .returning();
    if (lotacao && lotacao.postos.length) {
      let ordem = 1;
      for (const posto of lotacao.postos) {
        await tx.insert(e.parecer_posto).values({ parecer_id: rascunho!.id, posto_trabalho_id: posto.id, ordem: ordem++ });
      }
    } else if (unidade_uorg_id) {
      // sem posto o parecer não valida: pega o primeiro da unidade
      const [posto] = await tx
        .select()
        .from(e.posto_trabalho)
        .where(eq(e.posto_trabalho.unidade_uorg_id, unidade_uorg_id))
        .orderBy(asc(e.posto_trabalho.id))
        .limit(1);
      if (posto) await tx.insert(e.parecer_posto).values({ parecer_id: rascunho!.id, posto_trabalho_id: posto.id, ordem: 1 });
    }
    await tx.insert(e.exposicao).values({
      parecer_id: rascunho!.id,
      agente_nocivo_id: agente.id,
      percentual_id: percentual.id,
      fundamentacao_id: agente.fundamentacao_id!,
      principal: true,
      horas_exposicao_mensais: "160",
      jornada_mensal_horas: "160",
      classificacao_exposicao: "PERMANENTE",
      percentual_jornada: "100",
      tempo_exposicao: "Habitual e permanente",
    });
    return (await servico_parecer.carregar(tx, rascunho!.id))!;
  };

  const reavaliacao = await um(tx.select().from(e.texto_padrao).where(eq(e.texto_padrao.codigo, "QUIMICO_QUANTITATIVA")), "QUIMICO_QUANTITATIVA");
  const portaria_de = async (sigla: string) => {
    const u = await unidade(sigla);
    return um(
      tx.select().from(e.portaria_localizacao).where(eq(e.portaria_localizacao.unidade_emissora_id, u.id)).orderBy(asc(e.portaria_localizacao.id)).limit(1),
      `portaria ${sigla}`,
    );
  };
  const laudo_de = (final: string) =>
    um(tx.select().from(e.laudo_tecnico).where(like(e.laudo_tecnico.numero_siape, `%${final}%`)).orderBy(asc(e.laudo_tecnico.id)).limit(1), final);

  // A ORDEM importa: `uq_parecer` é UNIQUE(numero, ano) e todo rascunho nasce
  // com número 0. Os dois que vão ser emitidos vêm primeiro (a emissão consome
  // número de verdade, RN-03) e o rascunho que FICA rascunho é o último.
  const pronto = await montar_rascunho(coord, p8, {
    laudo: await laudo_de("000.301"),
    portaria: await portaria_de("FAMED"),
    agente_descricao: "Contato permanente com material infecto-contagiante",
  });
  await servico_parecer.emitir(tx, pronto, coord, { gerar_pdf: false });
  await servico_parecer.assinar(tx, pronto, coord);
  for (const destino of ["PARECER_PRONTO_P_ASSINATURA", "PARECER_ASSINADO", "INSERIDO_NO_SEI"]) {
    await mover(p8, destino, coord);
  }

  const encerrado = await montar_rascunho(coord, p9, {
    laudo: await laudo_de("000.301"),
    portaria: await portaria_de("FAMED"),
    agente_descricao: "Contato permanente com material infecto-contagiante",
  });
  await servico_parecer.emitir(tx, encerrado, coord, { gerar_pdf: false });
  await servico_parecer.assinar(tx, encerrado, coord);
  for (const destino of ["PARECER_PRONTO_P_ASSINATURA", "PARECER_ASSINADO", "INSERIDO_NO_SEI", "DEVOLVIDO_A_PROGEP", "CONCLUIDO"]) {
    await mover(p9, destino, coord);
  }

  // Direito: proposto pelo parecer emitido e concedido por portaria
  for (const [parecer_emitido, dias] of [
    [pronto, 120],
    [encerrado, 260],
  ] as const) {
    const vigencia = await direito.propor(tx, parecer_emitido, coord);
    await direito.conceder(tx, vigencia, coord, {
      portaria_concessao: `PORTARIA/PROGEP Nº ${dias}/${ano} (teste)`,
      data_portaria: somar_dias(hoje, -dias),
      data_inicio: somar_dias(hoje, -dias),
    });
  }

  // RASCUNHO: agente químico, com o texto de reavaliação da RN-06 já escrito.
  // É o último, e por isso é o único que sobra com número 0 no ano.
  await montar_rascunho(coord, p4, {
    laudo: await laudo_de("000.302"),
    portaria: await portaria_de("IECT"),
    agente_descricao: "Manipulação de produtos químicos",
    texto_reavaliacao: reavaliacao.template,
  });
  ctx.resumo.pareceres = 3;
  ctx.resumo.adicionais_vigentes = 2;

  // L2 superado: a cascata da RN-11 põe o parecer derivado em reavaliação e
  // abre a pendência. Só depois de o rascunho existir.
  const l2 = await laudo_de("000.302");
  const l3 = await laudo_de("000.303");
  await servico_parecer.marcar_laudo_superado(
    tx,
    l2,
    coord,
    "Nova avaliação quantitativa do laboratório de química.",
    l3,
  );
}

/**
 * O passo final do Python: quase todas as pendências já nasceram sozinhas
 * (emissão de parecer, laudo superado, CA a vencer, comprovante de EPI...).
 * Falta envelhecer duas — sem tempo passado não há tarefa atrasada, e o sino
 * nasceria todo verde, que é o único estado que não precisa ser testado. Roda
 * DEPOIS de todos os módulos terem aberto as suas.
 */
export async function envelhecer_pendencias(tx: Executor, ctx: ContextoPovoar): Promise<void> {
  const hoje = hoje_iso();
  const abertas = await pendencias.abertas(tx);
  const no_prazo = abertas.filter((p) => !pendencias.atrasada(p, hoje));
  for (const [p, dias] of no_prazo.slice(0, 2).map((p, i) => [p, [18, 5][i]!] as const)) {
    await tx.update(e.pendencia).set({ prazo: somar_dias(hoje, -dias) }).where(eq(e.pendencia.id, p.id));
  }
  ctx.resumo.pendencias = abertas.length;
  const todas = await tx.select().from(e.pendencia).where(eq(e.pendencia.concluida, false));
  ctx.resumo.pendencias_atrasadas = todas.filter((p) => pendencias.atrasada(p, hoje)).length;
}

