/**
 * / — o painel do Processos SEI.
 * Porte de `app/rotas/painel.py`.
 */
import { JANELA_A_VENCER_DIAS } from "../dominio/treinamento.js";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import type { Ambiente } from "../nucleo/contexto.js";
import { exigir, usuarioLogado } from "../dependencias.js";
import { pagina, redirecionar } from "../web.js";
import { dicionario } from "../dicionario.js";
import {
  agente_nocivo,
  campus,
  cargo,
  epi_ficha_registro,
  epi_requisicao,
  exposicao,
  historico_evento,
  inscricao,
  laudo_tecnico,
  parecer_tecnico,
  participante,
  percentual_aplicavel,
  servidor,
  sessao,
  tipo_adicional,
  tipo_risco,
  treinamento,
  turma,
  unidade_uorg,
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
import * as certificados_titular from "../servicos/certificados_titular.js";
import { turmas_abertas } from "../servicos/turma.js";
import { cartao_meu_espaco, e_externo, icone_de, meu_espaco_de, primeira_tela } from "../modulos.js";

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
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const hoje = datas_br.hoje();
  // Condição "titular" do menu (Portal do servidor): a conta ligada a servidor
  // abre o Início dela mesmo sem `processo.ver`. Sem vínculo, vale a permissão
  // de sempre (403 com o nome dela). O terceirizado e o discente não têm o
  // Início do servidor (adicional, EPI e lotação moram no cadastro de servidor):
  // vão para a primeira tela do "Meu espaço" deles.
  if (!usuario.pode("processo.ver")) {
    if (usuario.servidor_id === null) {
      if (e_externo(usuario)) {
        const destino = primeira_tela(usuario);
        if (destino !== "/") return redirecionar(c, destino);
      }
      exigir(usuario, "processo.ver");
    }
    return pagina(c, "paginas/painel.html", usuario, await inicio_do_servidor(tx, usuario, hoje));
  }
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
// Início do servidor (o painel do titular, Portal do servidor 22/10/2026)
// ---------------------------------------------------------------------
// Quantos dias à frente um certificado conta como "a vencer": a janela ÚNICA
// do sistema (`JANELA_A_VENCER_DIAS`, 60 dias desde 22/10/2026; eram 90).
export const JANELA_CERTIFICADO_DIAS = JANELA_A_VENCER_DIAS;
// Quantos dias à frente a turma confirmada vira aviso azul ("sua turma começa").
export const DIAS_AVISO_TURMA = 7;
// Quantos certificados o "Últimos certificados" mostra.
export const ULTIMOS_CERTIFICADOS = 2;
// As inscrições que ainda levam a pessoa a uma turma.
const INSCRICAO_EM_CURSO = ["AGUARDANDO_EMAIL", "INSCRITA", "CONFIRMADA"];
// O pedido de EPI "em aberto": enviado e ainda não terminado. O rascunho não
// conta (ainda não é pedido de ninguém), e indeferido, atendido e cancelado
// já terminaram.
export const EPI_PEDIDO_EM_ABERTO: readonly string[] = ["ENVIADA", "EM_ANALISE", "ANALISADA", "EM_ATENDIMENTO"];

/** Os atalhos do Início: o caminho de um item do "Meu espaço" e a frase curta. */
const ATALHOS_DO_INICIO: readonly { caminho: string; descricao: string }[] = [
  { caminho: "/turmas/minhas", descricao: "Inscrições e turmas abertas" },
  { caminho: "/certificados/meus", descricao: "Baixar e validar" },
  { caminho: "/epis/fichas/minha", descricao: "O que você recebeu" },
  { caminho: "/epis/requisicoes/nova", descricao: "Novo pedido ao SESMT" },
  { caminho: "/minha-atividade", descricao: "Tudo o que aconteceu" },
  { caminho: "/minha-conta", descricao: "Contato, senha e e-mail" },
];

export interface AvisoDoInicio {
  /** `erro` (vermelho), `alerta` (amarelo) ou `info` (azul) */
  nivel: "erro" | "alerta" | "info";
  icone: string;
  titulo: string;
  texto: string;
  link: { href: string; rotulo: string } | null;
}

export interface ChipDoInicio {
  icone: string;
  texto: string;
}

/** "MARIANA" → "Mariana"; o nome já escrito com caixa mista fica como está. */
function _primeiro_nome(nome: string): string {
  const primeiro = nome.trim().split(/\s+/)[0] ?? "";
  if (primeiro && primeiro === primeiro.toLocaleUpperCase("pt-BR")) {
    return primeiro.charAt(0) + primeiro.slice(1).toLocaleLowerCase("pt-BR");
  }
  return primeiro;
}

/**
 * O acesso ANTERIOR ao de agora. `usuario.ultimo_login_em` é regravado a cada
 * entrada (`autenticacao.entrar`): lido aqui, ele é o login desta sessão, e
 * "Último acesso: agora" não diz nada. O anterior é a sessão mais nova aberta
 * ANTES desse login; sem ela (primeiro acesso, ou sessões já expurgadas), o
 * chip não aparece.
 */
async function _acesso_anterior(tx: Executor, usuario_id: number): Promise<Date | null> {
  // A segunda sessão mais nova (pela ordem de criação, o id): comparar
  // `criada_em` com `ultimo_login_em` falhava quando os dois logins caíam no
  // mesmo instante gravado.
  const [linha] = await tx
    .select({ quando: sessao.criada_em })
    .from(sessao)
    .where(eq(sessao.usuario_id, usuario_id))
    .orderBy(desc(sessao.id))
    .offset(1)
    .limit(1);
  const quando = linha?.quando ?? null;
  if (quando === null) return null;
  return quando instanceof Date ? quando : new Date(quando as unknown as string);
}

/**
 * O Início do titular, todo preso ao `servidor_id` da conta — nenhuma
 * consulta aqui lê dado de outra pessoa, e por isso nenhuma passa pela
 * supressão (é o próprio titular lendo o que é dele, LGPD art. 18, II). Conta
 * sem servidor vinculado vê os cartões vazios, com a frase que explica.
 *
 * Só LÊ: os certificados vêm de `certificados_titular.do_titular` (o mesmo
 * cartão de "Meus certificados"), as turmas de `turma.turmas_abertas`, a troca
 * vencida de `epi_ficha.troca_devida_em` (RN-32 inteira). O adicional e os
 * processos só para quem tem `processo.ver`.
 */
export async function inicio_do_servidor(tx: Executor, usuario: UsuarioAtual, hoje: string) {
  const servidor_id = usuario.servidor_id;
  const ve_processo = usuario.pode("processo.ver");
  const ve_treinamento = usuario.pode("treinamento.ver");
  const ve_epi = usuario.pode("epi.ver");
  const limite_turma = datas_br.somar_dias(hoje, DIAS_AVISO_TURMA);
  const nada = <T>(v: T) => Promise.resolve(v);

  const [
    [meus, total_meus],
    vigencias,
    inscricoes_em_curso,
    certificados,
    abertas,
    entregas,
    pedidos_abertos,
    ficha,
    anterior,
    epi,
  ] = await Promise.all([
    ve_processo ? repo.listar(tx, usuario, new repo.Filtro({ por_pagina: 5 })) : nada([[], 0] as Awaited<ReturnType<typeof repo.listar>>),
    servidor_id === null || !ve_processo ? nada([]) : linha_do_tempo(tx, servidor_id),
    servidor_id === null
      ? nada([])
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
          .orderBy(asc(turma.data_inicio), asc(turma.id)),
    certificados_titular.do_titular(tx, servidor_id, hoje),
    ve_treinamento ? turmas_abertas(tx, hoje) : nada([]),
    servidor_id === null
      ? nada([])
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
    servidor_id === null
      ? nada([{ n: 0 }])
      : tx
          .select({ n: count() })
          .from(epi_requisicao)
          .where(and(eq(epi_requisicao.servidor_id, servidor_id), inArray(epi_requisicao.estado, [...EPI_PEDIDO_EM_ABERTO]))),
    servidor_id === null
      ? nada([])
      : tx
          .select({
            nome: servidor.nome,
            cargo: cargo.nome,
            sigla: unidade_uorg.sigla,
            unidade: unidade_uorg.nome_extenso,
            campus: campus.nome,
            cidade: campus.cidade,
          })
          .from(servidor)
          .leftJoin(cargo, eq(cargo.id, servidor.cargo_id))
          .leftJoin(unidade_uorg, eq(unidade_uorg.id, servidor.unidade_uorg_id))
          .leftJoin(campus, eq(campus.id, unidade_uorg.campus_id))
          .where(eq(servidor.id, servidor_id)),
    _acesso_anterior(tx, usuario.id),
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
  const resumos = await resumir_varios(tx, meus);

  // --- boas-vindas: o primeiro nome e os chips (sem SIAPE e sem CPF) ---
  const dados = ficha[0] ?? null;
  const primeiro_nome = _primeiro_nome(dados?.nome || usuario.nome);
  const chips: ChipDoInicio[] = [];
  if (dados?.sigla || dados?.unidade) {
    chips.push({ icone: "building", texto: [dados.sigla, dados.unidade].filter(Boolean).join(" · ") });
  }
  if (dados?.cargo) chips.push({ icone: "person-badge", texto: dados.cargo });
  if (dados?.campus) {
    const com_cidade = dados.cidade && !dados.campus.includes(dados.cidade);
    chips.push({ icone: "geo-alt", texto: com_cidade ? `${dados.campus} · ${dados.cidade}` : dados.campus });
  }
  if (anterior) chips.push({ icone: "clock", texto: `Último acesso ${datas_br.local_formatado(anterior)}` });

  // O cartão de identificação da lateral com a lotação, já que ela foi lida.
  const cartao = cartao_meu_espaco(usuario);
  const linha_lotacao = dados ? [dados.sigla || dados.unidade, dados.campus].filter(Boolean).join(" · ") : "";
  const cartao_completo = cartao ? { ...cartao, linha: linha_lotacao || null } : null;

  // --- certificados: só os EM VIGOR (o superado por uma reciclagem não avisa) ---
  const em_vigor = certificados.cartoes.filter((c) => !c.superado_por);
  const vencidos = em_vigor.filter((c) => c.situacao.tipo === "vencido");
  const a_vencer = em_vigor
    .filter((c) => c.situacao.tipo === "a_vencer")
    .sort((a, b) => (a.data_vencimento ?? "").localeCompare(b.data_vencimento ?? ""));
  const validos = em_vigor.filter((c) => ["valido", "a_vencer", "indeterminado"].includes(c.situacao.tipo));
  const proximo = certificados.resumo.proximo_a_vencer;
  const nome_curto = (c: { norma: string; treinamento: string }) => c.norma || c.treinamento;

  // --- avisos por severidade: só quando existem ---
  const reciclagem = ve_treinamento ? { href: "/turmas/minhas", rotulo: "Ver turmas de reciclagem" } : null;
  const avisos: AvisoDoInicio[] = [];
  for (const c of vencidos) {
    avisos.push({
      nivel: "erro",
      icone: "x-circle",
      titulo: `${nome_curto(c)} vencido em ${datas_br.numerica(c.data_vencimento!)}`,
      texto: `${c.treinamento}. Inscreva-se numa turma de reciclagem para renovar.`,
      link: reciclagem,
    });
  }
  if (devidas.length) {
    const nomes = devidas.slice(0, 3).map((r) => r.nome_epi_snapshot).join(", ");
    const resto = devidas.length > 3 ? ` e mais ${devidas.length - 3}` : "";
    avisos.push({
      nivel: "erro",
      icone: "x-circle",
      titulo: devidas.length === 1 ? "EPI com troca vencida" : `${devidas.length} EPI com troca vencida`,
      texto: `${nomes}${resto}: a troca prevista já passou.`,
      link: usuario.pode("epi.requisitar")
        ? { href: "/epis/requisicoes/nova", rotulo: "Pedir a troca" }
        : ve_epi
          ? { href: "/epis/fichas/minha", rotulo: "Ver minha ficha de EPI" }
          : null,
    });
  }
  for (const c of a_vencer) {
    const dias = "dias" in c.situacao ? c.situacao.dias : 0;
    avisos.push({
      nivel: "alerta",
      icone: "exclamation-triangle",
      titulo: `${nome_curto(c)} vence em ${dias} ${dias === 1 ? "dia" : "dias"} (${datas_br.numerica(c.data_vencimento!)})`,
      texto: `${c.treinamento}. Procure uma turma de reciclagem antes do vencimento.`,
      link: reciclagem,
    });
  }
  for (const t of inscricoes_em_curso) {
    if (t.situacao_inscricao !== "CONFIRMADA" || t.data_inicio < hoje || t.data_inicio > limite_turma) continue;
    avisos.push({
      nivel: "info",
      icone: "calendar-event",
      titulo: t.data_inicio === hoje ? "Sua turma começa hoje" : `Sua turma começa em ${datas_br.numerica(t.data_inicio)}`,
      texto: `${t.treinamento}${t.local ? ` · ${t.local}` : ""}.`,
      link: ve_treinamento ? { href: "/turmas/minhas", rotulo: "Ver detalhes" } : null,
    });
  }

  // --- atalhos: os do "Meu espaço" que abrem para esta conta ---
  const do_menu = new Map(meu_espaco_de(usuario).map((i) => [i.caminho, i]));
  const atalhos = ATALHOS_DO_INICIO.flatMap(({ caminho, descricao }) => {
    const item = do_menu.get(caminho);
    if (!item) return [];
    return [{ rotulo: item.rotulo, caminho, descricao, icone: icone_de(item.rotulo) ?? icone_de(caminho) }];
  });

  return {
    inicio_do_servidor: true,
    epi,
    tem_servidor: servidor_id !== null,
    primeiro_nome,
    chips,
    avisos,
    ve_processo,
    ve_treinamento,
    ve_epi,
    cartoes: {
      validos: validos.length,
      emitidos: certificados.resumo.emitidos,
      horas: String(certificados.resumo.horas).replace(".", ","),
      a_vencer: a_vencer.length,
      proximo: proximo ? { nome: proximo.norma || proximo.treinamento, data: proximo.data_vencimento } : null,
      turmas_abertas: abertas.length,
      inscrito_em: inscricoes_em_curso.length,
      epi_abertos: Number(pedidos_abertos[0]?.n ?? 0),
      trocas_vencidas: devidas.length,
    },
    adicional,
    meus_processos: resumos,
    total_meus,
    ultimos_certificados: certificados.cartoes.slice(0, ULTIMOS_CERTIFICADOS),
    total_certificados: certificados.cartoes.length,
    atalhos,
    cartao_meu_espaco: cartao_completo,
    hoje,
  };
}
