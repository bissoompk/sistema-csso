/**
 * O povoamento de Treinamentos e Certificados do ambiente de teste.
 * Porte do trecho "Certificados e Treinamentos" de `ferramentas/ambiente_teste_cli.py`.
 *
 * Mesmo conteúdo do Python: três treinamentos (NR-35, NR-32, NR-06), o modelo
 * específico do NR-35 E o genérico (os dois ramos de `modelo_da_turma`), duas
 * assinaturas (interna e externa), cinco turmas — uma em cada situação — e os
 * certificados da turma concluída.
 *
 * **Por que passa pelos serviços.** Numeração, máquinas de estado, contexto
 * congelado e trilha moram neles. Onde o Python insere direto (catálogo,
 * modelos, assinaturas), insere-se direto aqui.
 *
 * Quem chama (`ferramentas/ambiente-teste.ts`) passa a transação e o `ctx`, e
 * já criou as contas de `CONTAS` e os servidores de `SERVIDORES`.
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../../src/db/cliente.js";
import * as e from "../../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../../src/dominio/datas.js";
import type { UsuarioAtual } from "../../src/servicos/rbac.js";
import * as emissao_certificado from "../../src/servicos/emissao_certificado.js";
import * as servico_participante from "../../src/servicos/participante.js";
import * as presenca from "../../src/servicos/presenca.js";
import * as servico_turma from "../../src/servicos/turma.js";

export interface ContextoPovoar {
  atual: (login: string) => Promise<UsuarioAtual>;
  resumo: Record<string, number>;
}

// {marcador no .docx: código do campo} — o `MAPA_SUGERIDO` de
// `ferramentas/gerar_modelo_certificado.py`, que casa com certificado_padrao_v1.docx
export const MAPA_SUGERIDO: Readonly<Record<string, string>> = {
  nome_do_aluno: "participante_nome",
  identificador: "participante_identificador",
  vinculo: "participante_vinculo",
  curso: "treinamento_nome",
  carga: "treinamento_carga_horaria",
  norma: "treinamento_norma",
  conteudo: "treinamento_conteudo",
  periodo: "turma_periodo_extenso",
  local: "turma_local",
  promotora: "turma_unidade_promotora",
  frequencia: "frequencia_percentual",
  numero_certificado: "certificado_rotulo",
  data_extenso: "certificado_data_extenso",
  vencimento: "certificado_data_vencimento",
  chave: "certificado_chave",
  url_validacao: "certificado_url_validacao",
  instrutores: "turma_instrutores",
  assinante: "assinante_nome",
  assinante_titulo: "assinante_titulo",
  rubrica: "assinante_rubrica",
  setor_nome: "setor_emissor_nome",
  setor_sigla: "setor_emissor_sigla",
  cidade: "cidade",
};

// marcadores que não podem sair em branco no papel
export const OBRIGATORIOS: readonly string[] = [
  "nome_do_aluno",
  "curso",
  "carga",
  "periodo",
  "numero_certificado",
  "data_extenso",
  "chave",
  "assinante",
];

export async function povoar_treinamentos(tx: Executor, ctx: ContextoPovoar): Promise<void> {
  const hoje = hoje_iso();
  const coord = await ctx.atual("coordenador");
  const secretaria = await ctx.atual("secretaria");

  // --- catálogo ------------------------------------------------------
  const catalogo = await tx
    .insert(e.treinamento)
    .values([
      {
        codigo: "NR-35",
        nome: "Trabalho em Altura — NR-35",
        carga_horaria_horas: "8",
        conteudo_programatico:
          "Análise de risco\nSistemas de ancoragem\nEquipamentos de proteção contra quedas\nResgate e emergência",
        validade_meses: 24,
        norma_referencia: "NR-35",
        obrigatorio: true,
      },
      {
        codigo: "NR-32",
        nome: "Segurança em Serviços de Saúde — NR-32",
        carga_horaria_horas: "16",
        conteudo_programatico: "Riscos biológicos\nPerfurocortantes\nQuímicos em serviços de saúde",
        validade_meses: 12,
        norma_referencia: "NR-32",
      },
      {
        codigo: "NR-06",
        nome: "Uso e conservação de EPI — NR-6",
        carga_horaria_horas: "4",
        conteudo_programatico: "Guarda e conservação\nHigienização\nDescarte",
        validade_meses: 0,
        norma_referencia: "NR-6",
      },
    ])
    .returning();

  // o específico (apontado por `modelo_vigente_id`) e o genérico: os dois ramos
  // de `modelo_da_turma`. Genérico é UM só — dois empatariam e a emissão bloquearia.
  async function modelo(nome: string, treinamento_id: number | null) {
    const [alvo] = await tx
      .insert(e.certificado_modelo)
      .values({
        treinamento_id,
        nome,
        arquivo: "certificado_padrao_v1.docx",
        versao: 1,
        vigente: true,
        criado_por: coord.id,
      })
      .returning();
    let ordem = 1;
    for (const [marcador, campo] of Object.entries(MAPA_SUGERIDO)) {
      await tx.insert(e.certificado_modelo_tag).values({
        modelo_id: alvo!.id,
        marcador,
        campo,
        ordem: ordem++,
        obrigatorio: OBRIGATORIOS.includes(marcador),
      });
    }
    return alvo!;
  }
  const especifico = await modelo("Padrão NR-35", catalogo[0]!.id);
  await tx.update(e.treinamento).set({ modelo_vigente_id: especifico.id }).where(eq(e.treinamento.id, catalogo[0]!.id));
  await modelo("Padrão da casa", null);

  // instrutor interno aponta para um servidor (`ck_assinatura_vinculo`)
  const [interno] = await tx.select().from(e.servidor).where(eq(e.servidor.siape, "3010088"));
  await tx.insert(e.assinatura_instrutor).values([
    {
      servidor_id: interno!.id,
      nome: interno!.nome,
      titulo: "Engenheiro de Segurança do Trabalho",
      conselho: "CREA",
      registro_conselho: "MG-111111",
      externo: false,
      vigencia_inicio: "2021-01-01",
    },
    {
      nome: "Vitalina Escobar Rangel",
      titulo: "Técnica de Segurança do Trabalho",
      organizacao: "Instituto de Teste",
      externo: true,
      vigencia_inicio: "2022-01-01",
    },
  ]);

  // --- turmas --------------------------------------------------------
  const [dia] = await tx.select().from(e.campus).where(eq(e.campus.sigla, "DIA"));
  const treino = async (codigo: string) =>
    (await tx.select().from(e.treinamento).where(eq(e.treinamento.codigo, codigo)))[0]!;
  const nr35 = await treino("NR-35");
  const nr32 = await treino("NR-32");
  const nr06 = await treino("NR-06");
  const instrutor = (await tx.query.assinatura_instrutor.findFirst({
    with: { servidor: true },
    orderBy: (a, { asc }) => [asc(a.id)],
  }))!;

  async function inscritos(
    turma: servico_turma.TurmaCarregada,
    siapes: string[],
    externos: [string, string, string][] = [],
  ) {
    const criadas: servico_turma.InscricaoCarregada[] = [];
    for (const siape of siapes) {
      const [servidor] = await tx.select().from(e.servidor).where(eq(e.servidor.siape, siape));
      const pessoa = await servico_participante.de_servidor(tx, servidor!, secretaria);
      criadas.push(await servico_turma.inscrever(tx, secretaria, turma, pessoa));
    }
    for (const [nome, vinculo, organizacao] of externos) {
      const pessoa = await servico_participante.criar_externo(tx, { nome, vinculo, organizacao, usuario: secretaria });
      criadas.push(await servico_turma.inscrever(tx, secretaria, turma, pessoa));
    }
    return criadas;
  }
  const dias = (n: number) => somar_dias(hoje, n);

  // 1) PLANEJADA — existe na agenda e ainda não recebe inscrito
  const planejada = await servico_turma.criar_turma(tx, coord, {
    treinamento: nr35,
    data_inicio: dias(30),
    data_fim: dias(30),
    local: "Auditório do Campus JK",
    campus_id: dia!.id,
    vagas: 20,
  });
  await servico_turma.vincular_instrutor(tx, coord, planejada, instrutor);

  // 2) INSCRICOES_ABERTAS — com gente inscrita e vaga sobrando
  const abertas = await servico_turma.criar_turma(tx, coord, {
    treinamento: nr06,
    data_inicio: dias(12),
    data_fim: dias(12),
    local: "Sala de treinamento da CSSO",
    campus_id: dia!.id,
    vagas: 8,
    inscricao_aberta_ate: dias(10),
  });
  await servico_turma.vincular_instrutor(tx, coord, abertas, instrutor);
  await servico_turma.mudar_situacao(tx, coord, abertas, "INSCRICOES_ABERTAS");
  await inscritos(abertas, ["3010011", "3010022", "3010033"], [["Wagner Estrela Lopes", "TERCEIRIZADO", "Empresa de Teste"]]);

  // 3) EM_ANDAMENTO com presença lançada em parte da turma
  const andamento = await servico_turma.criar_turma(tx, coord, {
    treinamento: nr32,
    data_inicio: dias(-1),
    data_fim: dias(-1),
    local: "Anfiteatro da FAMED",
    campus_id: dia!.id,
    vagas: 15,
  });
  await servico_turma.vincular_instrutor(tx, coord, andamento, instrutor);
  const lista = await inscritos(andamento, ["3010044", "3010055", "3010066"]);
  await servico_turma.mudar_situacao(tx, coord, andamento, "EM_ANDAMENTO");
  for (const inscricao of lista.slice(0, 2)) {
    await presenca.lancar_presenca(tx, coord, inscricao, { data: andamento.data_inicio, presente: true, horas: "16" });
  }

  // 4) CONCLUIDA com certificados emitidos — o caminho inteiro
  const concluida = await servico_turma.criar_turma(tx, coord, {
    treinamento: nr35,
    data_inicio: dias(-9),
    data_fim: dias(-9),
    local: "Campo de treinamento — Campus JK",
    campus_id: dia!.id,
    vagas: 10,
    nota_minima_aprovacao: "7",
  });
  await servico_turma.vincular_instrutor(tx, coord, concluida, instrutor);
  // quem ministra a turma não se inscreve nela
  const turma_lista = await inscritos(concluida, ["3010011", "3010077", "3010099"]);
  await servico_turma.mudar_situacao(tx, coord, concluida, "EM_ANDAMENTO");
  for (const [inscricao, nota] of [
    [turma_lista[0]!, "9.5"],
    [turma_lista[1]!, "8.0"],
  ] as const) {
    await presenca.lancar_presenca(tx, coord, inscricao, { data: concluida.data_inicio, presente: true, horas: "8" });
    await presenca.lancar_nota(tx, coord, inscricao, nota);
  }
  // o terceiro nunca compareceu: a apuração o fecha como ausente/reprovado
  await servico_turma.mudar_situacao(tx, coord, concluida, "CONCLUIDA");

  // 5) CANCELADA — turma que não aconteceu, com motivo registrado
  const cancelada = await servico_turma.criar_turma(tx, coord, {
    treinamento: nr06,
    data_inicio: dias(20),
    data_fim: dias(20),
    local: "Sala de treinamento da CSSO",
    campus_id: dia!.id,
  });
  await servico_turma.mudar_situacao(tx, coord, cancelada, "CANCELADA", { motivo: "Instrutor indisponível na data." });
  ctx.resumo["turmas"] = 5;

  // --- certificados da turma concluída -------------------------------
  let emitidos = 0;
  const recarregada = (await servico_turma.carregar_turma(tx, concluida.id))!;
  // na ordem do banco (id), como a consulta do Python — a numeração depende dela
  const da_turma = (await servico_turma.inscricoes_da_turma(tx, recarregada)).sort((a, b) => a.id - b.id);
  for (const inscricao of da_turma) {
    if ((await emissao_certificado.validar(tx, inscricao)).ok) {
      await emissao_certificado.emitir(tx, coord, inscricao, { gerar_pdf: false });
      emitidos++;
    }
  }
  ctx.resumo["certificados"] = emitidos;
}
