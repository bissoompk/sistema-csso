/**
 * O povoamento de Demandas do ambiente de teste.
 * Porte do trecho "Demandas" de `ferramentas/ambiente_teste_cli.py`.
 *
 * Sete, e a lista não é arbitrária — ela cobre os três estados e os QUATRO
 * desfechos, mais os dois casos que só se veem com o tempo passado: a atrasada
 * (o vermelho na lista e a linha no sino) e a que virou processo, ligada a um
 * processo que EXISTE neste mesmo ambiente (`23086.100002/<ano>-DV`, criado
 * pelo povoamento de Processos). Sem ela, o desfecho mais importante seria
 * clicável na tela e não levaria a lugar nenhum.
 *
 * Tem de rodar DEPOIS dos processos (a demanda 5 aponta para um deles) e ANTES
 * do bloco que envelhece pendências (a demanda com prazo tem de estar na
 * conta; o prazo da em-andamento é longo, 25 dias, para ela não ser uma das
 * duas escolhidas).
 *
 * Passa pelos serviços (`servicos/demandas`): a pendência do prazo, a
 * transição ao encaminhar e a trilha nascem como nasceriam pela tela.
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../../src/db/cliente.js";
import * as e from "../../src/db/esquema/index.js";
import { hoje_iso, somar_dias } from "../../src/dominio/datas.js";
import * as servico_demandas from "../../src/servicos/demandas.js";
import { nup_dv } from "../../src/servicos/nup.js";
import type { UsuarioAtual } from "../../src/servicos/rbac.js";

export interface ContextoPovoar {
  /** a conta semeada `login`, resolvida como a sessão a resolveria */
  atual: (login: string) => Promise<UsuarioAtual>;
  /** o resumo impresso no fim */
  resumo: Record<string, number>;
}

/** `nup_de` do Python: o NUP de teste com o DV certo. */
export function nup_de(sequencial: number, ano: number): string {
  const seq = String(sequencial).padStart(6, "0");
  return `23086.${seq}/${ano}-${nup_dv(`23086${seq}${ano}`)}`;
}

export async function povoar_demandas(tx: Executor, ctx: ContextoPovoar): Promise<void> {
  const hoje = hoje_iso();
  const dias = (n: number) => somar_dias(hoje, n);
  const coord = await ctx.atual("coordenador");
  const secretaria = await ctx.atual("secretaria");
  const engenheiro = await ctx.atual("engenheiro");

  const pessoa = async (siape: string) => {
    const [sv] = await tx.select().from(e.servidor).where(eq(e.servidor.siape, siape));
    if (!sv) throw new Error(`servidor de teste ausente: ${siape}`);
    return sv;
  };
  const unidade = async (sigla: string) => {
    const [u] = await tx.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla));
    if (!u) throw new Error(`unidade ausente: ${sigla}`);
    return u;
  };
  const famed = await unidade("FAMED");
  const progep = await unidade("PROGEP");

  // 1) ABERTA, sem prazo — o caso mais comum: chegou, está na fila, e ninguém
  // prometeu data. Não abre pendência.
  await servico_demandas.registrar(tx, coord, {
    assunto: "Chefia da FAMED pergunta se o laboratório precisa de laudo novo",
    canal: "EMAIL",
    solicitante_nome: "Chefia da Faculdade de Medicina de Diamantina",
    solicitante_unidade_uorg_id: famed.id,
    data_chegada: dias(-6),
    descricao:
      "Perguntou por e-mail se a mudança de bancada no laboratório de " +
      "análises clínicas exige laudo novo. Dado de teste.",
  });

  // 2) ABERTA e ATRASADA — o vermelho da lista e a linha no sino.
  await servico_demandas.registrar(tx, coord, {
    assunto: "Ofício da PROGEP pede posição sobre revezamento no CME",
    canal: "OFICIO",
    solicitante_nome: "Pró-Reitoria de Gestão de Pessoas",
    solicitante_unidade_uorg_id: progep.id,
    data_chegada: dias(-20),
    prazo: dias(-4),
    descricao:
      "Pediu manifestação da CSSO sobre a escala de revezamento na " + "central de esterilização. Dado de teste.",
  });

  // 3) EM_ANDAMENTO, com prazo e com dois encaminhamentos
  const em_curso = await servico_demandas.registrar(tx, secretaria, {
    assunto: "Servidor do LEAC pede avaliação do posto para adicional",
    canal: "PRESENCIAL",
    solicitante_nome: "Adelaide Nunes Prata",
    solicitante_servidor_id: (await pessoa("3010011")).id,
    solicitante_unidade_uorg_id: famed.id,
    data_chegada: dias(-12),
    prazo: dias(25),
    responsavel_id: engenheiro.id,
    descricao: "Veio ao balcão perguntar como pedir a avaliação do posto de " + "trabalho. Dado de teste.",
  });
  await servico_demandas.encaminhar(tx, secretaria, em_curso, {
    para_quem: "Engenharia de Segurança do Trabalho",
    pedido: "Agendar a inspeção do posto e dizer se cabe laudo próprio.",
    data_encaminhamento: dias(-10),
  });
  await servico_demandas.encaminhar(tx, engenheiro, em_curso, {
    para_quem: "Chefia da FAMED",
    pedido: "Confirmar por escrito a rotina de trabalho no posto.",
    data_encaminhamento: dias(-3),
  });

  // 4) ENCERRADA / RESOLVIDA
  const resolvida = await servico_demandas.registrar(tx, coord, {
    assunto: "Dúvida sobre validade do CA da luva nitrílica",
    canal: "TELEFONE",
    solicitante_nome: "Almoxarifado do Campus JK",
    data_chegada: dias(-15),
  });
  await servico_demandas.encerrar(tx, coord, resolvida, {
    desfecho: "RESOLVIDA",
    relato:
      "Respondi por telefone: o CA do lote vence em outubro e o " + "sistema já avisa 60 dias antes. Dado de teste.",
  });

  // 5) ENCERRADA / VIROU_PROCESSO — ligada a um processo que EXISTE aqui
  const virou = await servico_demandas.registrar(tx, coord, {
    assunto: "Pedido de adicional de insalubridade chegou por e-mail",
    canal: "EMAIL",
    solicitante_nome: "Kátia Lousada Ferrão",
    solicitante_servidor_id: (await pessoa("3010112")).id,
    data_chegada: dias(-30),
  });
  const nup = nup_de(100002, Number(hoje.slice(0, 4)));
  const [processo_gerado] = await tx.select().from(e.processo).where(eq(e.processo.nup, nup));
  if (!processo_gerado) {
    throw new Error(
      `povoar_demandas: o processo ${nup} não existe — povoe os processos antes das demandas ` +
        "(a demanda 5 existe para provar o link até ele).",
    );
  }
  await servico_demandas.encerrar(tx, coord, virou, {
    desfecho: "VIROU_PROCESSO",
    processo_id: processo_gerado.id,
    relato: "Autuado no SEI e instruído pela CSSO. Dado de teste.",
  });

  // 6) ENCERRADA / ENCAMINHADA — a bola está com outro setor, com data
  const encaminhada = await servico_demandas.registrar(tx, secretaria, {
    assunto: "Pedido de mudança de lotação por incompatibilidade de horário",
    canal: "EMAIL",
    solicitante_nome: "Juvenal Ataíde Brandão",
    solicitante_servidor_id: (await pessoa("3010101")).id,
    data_chegada: dias(-25),
  });
  await servico_demandas.encerrar(tx, secretaria, encaminhada, {
    desfecho: "ENCAMINHADA",
    setor: "PROGEP — Diretoria de Administração de Pessoal",
    data_desfecho: dias(-22),
  });

  // 7) ENCERRADA / SEM_PROVIDENCIA — a decisão de não fazer nada, com motivo
  const sem_providencia = await servico_demandas.registrar(tx, coord, {
    assunto: "Solicitação de EPI para empresa de limpeza terceirizada",
    canal: "PRESENCIAL",
    solicitante_nome: "Encarregado da empresa contratada",
    data_chegada: dias(-9),
  });
  await servico_demandas.encerrar(tx, coord, sem_providencia, {
    desfecho: "SEM_PROVIDENCIA",
    relato:
      "O EPI de empregado de empresa contratada é obrigação do " +
      "empregador (NR-6). Orientei a dirigir o pedido à contratante e " +
      "avisei a fiscalização do contrato. Dado de teste.",
  });

  ctx.resumo["demandas"] = 7;
}
