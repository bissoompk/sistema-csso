/**
 * / — o painel do Processos SEI.
 * Porte de `app/rotas/painel.py`.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte, notInArray } from "drizzle-orm";
import type { Ambiente } from "../nucleo/contexto.js";
import { usuarioCom } from "../dependencias.js";
import { pagina } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  agente_nocivo,
  certificado,
  epi_ficha_registro,
  exposicao,
  historico_evento,
  inscricao,
  laudo_tecnico,
  parecer_tecnico,
  participante,
  percentual_aplicavel,
  tipo_adicional,
  tipo_risco,
  treinamento,
  turma,
} from "../db/esquema/index.js";
import * as repo from "../repositorios/processos.js";
import * as datas_br from "../servicos/datas_br.js";
import { habilitados_vigentes } from "../servicos/parecer.js";
import { resumir_varios } from "../servicos/processo.js";
import { ESTADO_ALTERADO } from "../servicos/auditoria.js";
import { rotulo_tela_do_ascii } from "../dominio/estados.js";
import { LIMIAR_SUPRESSAO, suprimir } from "./relatorios.js";
import * as identificacao from "../servicos/identificacao.js";
import { atores_para_tela } from "../servicos/privacidade.js";
import { ESCOPO_PROPRIO, aplicar_escopo, type UsuarioAtual } from "../servicos/rbac.js";
import { linha_do_tempo } from "../servicos/direito.js";
import { troca_devida_em } from "../servicos/epi_ficha.js";
import * as epi_contagens from "../servicos/epi_contagens.js";
import type { Executor } from "../db/cliente.js";

export const rotas = new Hono<Ambiente>();

// Quantas linhas do cartão cabem sem o painel virar lista. O número TOTAL vai
// junto e é o que o contador publica: cortar a lista é decisão de tela, cortar
// o número é o painel mentindo.
export const MOSTRADOS_NO_CARTAO = 8;

// A visão de `/processos` que o cartão linka. O contador e o link têm de
// continuar apontando para o mesmo recorte.
export const FILA_PRECISAM = "/processos?precisam=1";

/** O `round()` do Python: metade vai para o par. */
export function arredondar_python(x: number): number {
  const piso = Math.floor(x);
  const resto = x - piso;
  if (resto > 0.5) return piso + 1;
  if (resto < 0.5) return piso;
  return piso % 2 === 0 ? piso : piso + 1;
}

function dias_entre(inicio: string, fim: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(fim) - d(inicio)) / 86_400_000);
}

rotas.get("/", async (c) => {
  const usuario = await usuarioCom(c, "processo.ver");
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  const exercicio = Number(hoje.slice(0, 4));
  // Lido ANTES de disparar as consultas: perfil sem escopo declarado lança aqui,
  // e lançar no meio da lista abaixo deixaria as já disparadas sem dono.
  // Pela permissão do painel, e não pela conta (D1): o `admin_ti` ligado a
  // servidor lê só os próprios processos, e o painel dele é o do titular.
  const so_o_proprio = usuario.escopo_de("processo.ver") === ESCOPO_PROPRIO;
  // Quem só alcança o PRÓPRIO dado (servidor) não tem painel de setor: os KPIs
  // da instituição, a distribuição por risco e os "Últimos eventos" (que para
  // ele eram dez linhas de "conteúdo suprimido" sobre o que ele mesmo fez) não
  // dizem nada a ele. Abre o "Início do servidor": o adicional, os processos,
  // o treinamento, os certificados e o EPI DELE.
  if (so_o_proprio) return pagina(c, "paginas/painel.html", usuario, await inicio_do_servidor(tx, usuario, hoje));
  // Os blocos do painel não dependem uns dos outros: saem juntos, e as
  // consultas seguem lado a lado pela conexão (o banco fica longe — ver
  // `db/cliente.ts`).
  const [indicadores, habilitados, emitidos, contagem_risco, [lista, total_precisam], laudos_vigentes, ultimos, epi] =
    await Promise.all([
      repo.indicadores(tx, usuario, exercicio),
      habilitados_vigentes(tx, hoje),
      // Os pareceres e as exposições com o MESMO escopo dos processos ao lado:
      // o cartão "Em andamento" já contava só o alcance de quem lê, e os dois
      // blocos vizinhos contavam a instituição inteira.
      tx.query.parecer_tecnico.findMany({
        where: and(
          inArray(parecer_tecnico.situacao, ["EMITIDO", "ASSINADO"]),
          eq(parecer_tecnico.ano, exercicio),
          aplicar_escopo(usuario, parecer_tecnico, "parecer.ver"),
        ),
        with: { processo: true },
        orderBy: [asc(parecer_tecnico.id)],
      }),
      tx
        .select({ nome: tipo_risco.nome, n: count() })
        .from(exposicao)
        .innerJoin(parecer_tecnico, eq(parecer_tecnico.id, exposicao.parecer_id))
        .innerJoin(agente_nocivo, eq(agente_nocivo.id, exposicao.agente_nocivo_id))
        .innerJoin(tipo_risco, eq(tipo_risco.id, agente_nocivo.tipo_risco_id))
        .where(aplicar_escopo(usuario, parecer_tecnico, "parecer.ver"))
        .groupBy(tipo_risco.nome),
      // O cartão "Precisam de você hoje" e o link dele contam a MESMA coisa,
      // porque são a mesma consulta: o filtro `precisam` do repositório aplica
      // `processo.precisa_de_atencao`. `por_pagina` alto, e não paginação: o
      // total é o que o cartão publica.
      repo.listar(tx, usuario, new repo.Filtro({ precisam: true, por_pagina: 100000 })),
      tx.query.laudo_tecnico.findMany({
        where: eq(laudo_tecnico.status, "VIGENTE"),
        with: { unidade: true },
        orderBy: [asc(laudo_tecnico.id)],
      }),
      tx
        .select()
        .from(historico_evento)
        .where(so_o_proprio ? eq(historico_evento.usuario_id, usuario.id) : undefined)
        .orderBy(desc(historico_evento.id))
        .limit(10),
      // fatia G: o que espera a equipe de EPI (só para quem faz o ato; sem a
      // permissão, nenhuma consulta; com ela, as duas contagens numa ida só)
      epi_contagens.contagens_numa_ida(tx, usuario),
    ]);
  const kpis: Record<string, number | null> = { ...indicadores };
  kpis.subscritores_habilitados = habilitados.length;

  // Par com autuação DEPOIS da emissão é dado errado (a autuação digitada no
  // futuro, ou trocada com outra data): fica fora da média, que nunca sai
  // negativa por causa de um processo só.
  const tempos = emitidos
    .filter((p) => p.data_emissao && p.processo && p.processo.data_autuacao)
    .filter((p) => p.processo!.data_autuacao! <= p.data_emissao!)
    .map((p) => dias_entre(p.processo!.data_autuacao!, p.data_emissao!));
  kpis.tempo_medio_emissao = tempos.length ? arredondar_python(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null;

  const por_mes: Record<number, number> = {};
  for (let mes = 1; mes <= 12; mes++) por_mes[mes] = 0;
  for (const parecer of emitidos) {
    if (parecer.data_emissao) por_mes[Number(parecer.data_emissao.slice(5, 7))]! += 1;
  }

  // RN-19 também aqui, e com a MESMA função de `/relatorios`: publicar cru o que
  // lá sai suprimido fazia do painel a porta dos fundos da supressão.
  const contagem_por_risco: Record<string, number> = {};
  for (const { nome, n } of contagem_risco) contagem_por_risco[nome] = n;
  // nominal pela leitura de parecer (D1/D9): quem lê o nome só em parte dos
  // pareceres que conta lê a distribuição suprimida
  const nominal_risco = usuario.ve_dado_nominal_em("parecer.ver");
  const por_risco = suprimir(contagem_por_risco, nominal_risco);

  const [resumos, eventos] = await Promise.all([
    resumir_varios(tx, lista),
    // Revisão de privacidade (25/09/2026): "Últimos eventos" atravessa o
    // sistema inteiro. Quem só alcança o PRÓPRIO dado (`servidor_consulta`) vê
    // só o que ele mesmo fez — os eventos dos outros diziam quem pediu EPI,
    // quem se inscreveu —, e o nome de quem agiu passa pela RN-19 quando a
    // conta é de um servidor (`atores_para_tela`). Laudo só para quem tem
    // `laudo.ver`: a fila abria link que dava 403.
    atores_para_tela(
      tx,
      ultimos,
      usuario,
      identificacao.semente_de({ cookies: { get: (n: string) => getCookie(c, n) ?? null } }),
    ),
  ]);
  // `sorted(..., key=-dias)`: estável, como o do Python
  const precisam_de_voce = resumos.sort((a, b) => b.dias_no_estado - a.dias_no_estado).slice(0, MOSTRADOS_NO_CARTAO);

  const laudos_sem_conferencia = laudos_vigentes.filter(
    (laudo) =>
      laudo.data_ultima_conferencia === null || datas_br.meses_entre(laudo.data_ultima_conferencia, hoje) > 24,
  );

  return pagina(c, "paginas/painel.html", usuario, {
    inicio_do_servidor: false,
    kpis,
    exercicio,
    por_mes: dicionario(por_mes),
    por_risco: dicionario(por_risco),
    nominal_risco,
    limiar: LIMIAR_SUPRESSAO,
    precisam_de_voce,
    total_precisam,
    fila_precisam: FILA_PRECISAM,
    epi,
    laudos_sem_conferencia: usuario.pode("laudo.ver") ? laudos_sem_conferencia : [],
    // a trilha de estado é gravada em ASCII com "->" (entra no digest da
    // cadeia): a tela acentua só na exibição, como a aba Histórico da ficha
    eventos: eventos.map((ev) => ({
      ...ev,
      descricao_tela: ev.tipo_evento === ESTADO_ALTERADO ? rotulo_tela_do_ascii(ev.descricao) : ev.descricao,
    })),
  });
});

// ---------------------------------------------------------------------
// Início do servidor (escopo próprio)
// ---------------------------------------------------------------------
// Quantos dias à frente um certificado conta como "a vencer": a mesma janela
// de três meses do aviso de reciclagem — tempo de achar turma e se inscrever.
export const JANELA_CERTIFICADO_DIAS = 90;
// As inscrições que ainda levam a pessoa a uma turma.
const INSCRICAO_EM_CURSO = ["AGUARDANDO_EMAIL", "INSCRITA", "CONFIRMADA"];

/**
 * Os cartões do servidor, todos presos ao `servidor_id` da conta — nenhuma
 * consulta aqui lê dado de outra pessoa, e por isso nenhuma passa pela
 * supressão (é o próprio titular lendo o que é dele, LGPD art. 18, II). Conta
 * sem servidor vinculado vê os cartões vazios, com a frase que explica.
 */
export async function inicio_do_servidor(tx: Executor, usuario: UsuarioAtual, hoje: string) {
  const servidor_id = usuario.servidor_id;
  const limite_certificado = datas_br.somar_dias(hoje, JANELA_CERTIFICADO_DIAS);
  const [[meus, total_meus], vigencias, proximas, certificados, entregas, epi] = await Promise.all([
    repo.listar(tx, usuario, new repo.Filtro({ por_pagina: 5 })),
    servidor_id === null ? Promise.resolve([]) : linha_do_tempo(tx, servidor_id),
    servidor_id === null
      ? Promise.resolve([])
      : tx
          .select({
            turma_id: turma.id,
            codigo: turma.codigo,
            treinamento: treinamento.nome,
            data_inicio: turma.data_inicio,
            data_fim: turma.data_fim,
            local: turma.local,
            situacao_inscricao: inscricao.situacao,
          })
          .from(inscricao)
          .innerJoin(participante, eq(participante.id, inscricao.participante_id))
          .innerJoin(turma, eq(turma.id, inscricao.turma_id))
          .innerJoin(treinamento, eq(treinamento.id, turma.treinamento_id))
          .where(
            and(
              eq(participante.servidor_id, servidor_id),
              inArray(inscricao.situacao, INSCRICAO_EM_CURSO),
              notInArray(turma.situacao, ["CONCLUIDA", "CANCELADA"]),
              gte(turma.data_fim, hoje),
            ),
          )
          .orderBy(asc(turma.data_inicio), asc(turma.id))
          .limit(1),
    servidor_id === null
      ? Promise.resolve([])
      : tx
          .select({
            id: certificado.id,
            treinamento: treinamento.nome,
            data_vencimento: certificado.data_vencimento,
          })
          .from(certificado)
          .innerJoin(treinamento, eq(treinamento.id, certificado.treinamento_id))
          .where(
            and(
              eq(certificado.servidor_id, servidor_id),
              eq(certificado.situacao, "EMITIDO"),
              isNotNull(certificado.data_vencimento),
              lte(certificado.data_vencimento, limite_certificado),
            ),
          )
          .orderBy(asc(certificado.data_vencimento)),
    servidor_id === null
      ? Promise.resolve([])
      : tx
          .select()
          .from(epi_ficha_registro)
          .where(
            and(
              eq(epi_ficha_registro.servidor_id, servidor_id),
              eq(epi_ficha_registro.tipo, "ENTREGA"),
              isNotNull(epi_ficha_registro.previsao_troca),
              lt(epi_ficha_registro.previsao_troca, hoje),
            ),
          )
          .orderBy(asc(epi_ficha_registro.previsao_troca)),
    // fatia G: a conta de escopo próprio no processo pode atender EPI de um
    // campus (D1: o alcance é por permissão)
    epi_contagens.contagens_numa_ida(tx, usuario),
  ]);

  // O adicional: a vigência mais recente diz o estado; o percentual e o tipo
  // vêm do catálogo. Sem vigência nenhuma, o cartão diz que não há.
  const atual = vigencias.length ? vigencias[vigencias.length - 1]! : null;
  let adicional: { estado: string; tipo: string | null; percentual: string | null; desde: string | null } | null = null;
  if (atual) {
    const [percentual] = await tx
      .select({ rotulo: percentual_aplicavel.rotulo, valor: percentual_aplicavel.valor, tipo: tipo_adicional.nome })
      .from(percentual_aplicavel)
      .innerJoin(tipo_adicional, eq(tipo_adicional.id, percentual_aplicavel.tipo_adicional_id))
      .where(eq(percentual_aplicavel.id, atual.percentual_id));
    adicional = {
      estado: atual.estado,
      tipo: percentual?.tipo ?? null,
      percentual: percentual ? percentual.rotulo : null,
      desde: atual.data_inicio,
    };
  }

  // A troca vencida segue a RN-32 inteira (estorno, devolução e substituição
  // tiram a linha da cobrança): a regra é a de `epi_ficha`, só importada.
  const devidas: (typeof epi_ficha_registro.$inferSelect)[] = [];
  for (const r of entregas) if (await troca_devida_em(tx, r, hoje)) devidas.push(r);

  const [resumos] = await Promise.all([resumir_varios(tx, meus)]);
  return {
    inicio_do_servidor: true,
    epi,
    tem_servidor: servidor_id !== null,
    adicional,
    meus_processos: resumos,
    total_meus,
    proximo_treinamento: proximas[0] ?? null,
    certificados_a_vencer: certificados,
    trocas_vencidas: devidas.map((r) => ({
      id: r.id,
      nome: r.nome_epi_snapshot,
      previsao_troca: r.previsao_troca,
    })),
    hoje,
  };
}
