/**
 * O que a página inicial do módulo mostra: quanto espera em cada passo do
 * trabalho. É o "Centro de Certificações e Inscrições" do IntegraSST, que
 * abria em cartões numerados; aqui cada cartão diz também o que há nele.
 *
 * Só conta: as listas moram nas telas para onde cada cartão leva, e as
 * contagens são as delas (a fila de emissão, o monitor de reciclagem, a caixa
 * de e-mails), para que o número do cartão e o da tela nunca discordem.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  inscricao as tabela_inscricao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
} from "../db/esquema/index.js";
import * as envio_certificado from "./envio_certificado.js";
import * as fila_emissao from "./fila_emissao.js";
import type { UsuarioAtual } from "./rbac.js";
import * as reciclagem from "./reciclagem.js";
import * as servico_turma from "./turma.js";

/** Quantas turmas a vir a página lista abaixo dos cartões. */
export const PROXIMAS = 6;

export interface ProximaTurma {
  id: number;
  codigo: string;
  treinamento: string;
  data_inicio: string;
  data_fim: string;
  local: string | null;
  situacao: string;
}

export interface ResumoHub {
  turmas: Record<string, number>;
  pedidos_a_conferir: number;
  fila: Record<fila_emissao.Etapa, number>;
  reciclagem: Record<string, number>;
  emails: Record<string, number> | null;
  proximas: ProximaTurma[];
}

export async function resumo(tx: Executor, usuario: UsuarioAtual, hoje: string): Promise<ResumoHub> {
  // Cada contagem com a permissão da tela para onde o cartão leva (D9): as
  // turmas e as próximas com a de `/turmas` (`treinamento.ver`); os pedidos
  // com a do ato de conferir (`turma.inscrever`), como `pedidos_link.a_conferir`.
  // Com a leitura no lugar do ato, quem lê turmas em todo campus e confere
  // pedidos só no seu via no cartão um número que a fila não mostra.
  const escopo = servico_turma.consulta_no_escopo(usuario, "treinamento.ver");
  const escopo_dos_pedidos = servico_turma.consulta_no_escopo(usuario, "turma.inscrever");

  const por_situacao = await tx
    .select({ situacao: tabela_turma.situacao, n: count() })
    .from(tabela_turma)
    .where(escopo)
    .groupBy(tabela_turma.situacao);
  const turmas: Record<string, number> = {};
  for (const linha of por_situacao) turmas[linha.situacao] = Number(linha.n);

  const [pedidos] = await tx
    .select({ n: count() })
    .from(tabela_inscricao)
    .innerJoin(tabela_turma, eq(tabela_turma.id, tabela_inscricao.turma_id))
    .where(and(escopo_dos_pedidos, eq(tabela_inscricao.situacao, "AGUARDANDO_EMAIL")));

  const { contagem: fila } = await fila_emissao.fila(tx, usuario, {});
  const { contagem: recicl } = await reciclagem.monitor(tx, usuario, hoje, {});

  const proximas = await tx
    .select({
      id: tabela_turma.id,
      codigo: tabela_turma.codigo,
      treinamento: tabela_treinamento.nome,
      data_inicio: tabela_turma.data_inicio,
      data_fim: tabela_turma.data_fim,
      local: tabela_turma.local,
      situacao: tabela_turma.situacao,
    })
    .from(tabela_turma)
    .innerJoin(tabela_treinamento, eq(tabela_treinamento.id, tabela_turma.treinamento_id))
    .where(and(escopo, inArray(tabela_turma.situacao, ["PLANEJADA", "INSCRICOES_ABERTAS", "EM_ANDAMENTO"])))
    .orderBy(asc(tabela_turma.data_inicio), asc(tabela_turma.id))
    .limit(PROXIMAS);

  return {
    turmas,
    pedidos_a_conferir: Number(pedidos?.n ?? 0),
    fila,
    reciclagem: recicl,
    // NUVEM: a caixa do setor de quem lê, como a tela de envios
    emails: usuario.pode("certificado.emitir") ? await envio_certificado.contagem_do_setor(tx, usuario) : null,
    proximas,
  };
}

// ---------------------------------------------------------------------
// Os cartões da página
// ---------------------------------------------------------------------
export interface CartaoHub {
  numero: number;
  href: string;
  icone: string;
  cor: string;
  titulo: string;
  descricao: string;
  contagem: { texto: string; classe: string } | null;
}

/**
 * Os cartões na ordem do trabalho (catálogo → turma → presença → emissão →
 * reciclagem), só os que o perfil abre, numerados SEM buraco: a secretaria,
 * que não vê "Instrutores", não lê 1–6 e 8. Os nomes são os do menu
 * (`modulos.ts`), e a descrição não promete o que o perfil não faz — "corrigir
 * e anular" só para quem anula, o ".docx" só para quem cuida dos modelos.
 */
export function cartoes(usuario: UsuarioAtual, r: ResumoHub): CartaoHub[] {
  const abertas = r.turmas.INSCRICOES_ABERTAS ?? 0;
  const andamento = r.turmas.EM_ANDAMENTO ?? 0;
  const gerencia = usuario.pode("treinamento.gerenciar");
  const anula = usuario.pode("certificado.anular");
  const lista: Omit<CartaoHub, "numero">[] = [];
  lista.push({
    href: "/treinamentos/catalogo",
    icone: "journal-bookmark",
    cor: "roxo",
    titulo: gerencia ? "Treinamentos e modelos" : "Treinamentos",
    descricao: gerencia
      ? "Treinamentos, validade da reciclagem e o modelo (.docx) do certificado."
      : "Treinamentos, carga horária e validade da reciclagem.",
    contagem: null,
  });
  if (usuario.pode("assinatura.gerenciar")) {
    lista.push({
      href: "/treinamentos/assinaturas",
      icone: "pen-fill",
      cor: "escuro",
      titulo: "Instrutores",
      descricao: "Quem assina o certificado: nome, título e rubrica.",
      contagem: null,
    });
  }
  lista.push({
    href: "/turmas",
    icone: "collection-fill",
    cor: "amarelo",
    titulo: "Turmas",
    descricao: usuario.pode("turma.criar")
      ? "Abrir a turma, inscrever pela lista ou divulgar o link público com QR."
      : "As turmas, as inscrições e o link público.",
    contagem: { texto: `${abertas} com inscrição aberta · ${andamento} em andamento`, classe: abertas ? "atencao" : "" },
  });
  if (usuario.pode("turma.inscrever")) {
    lista.push({
      href: "/turmas/pedidos",
      icone: "person-check",
      cor: "escuro",
      titulo: "Pedidos pelo link",
      descricao: "Quem se inscreveu pelo link e espera a conferência.",
      contagem: {
        texto: `${r.pedidos_a_conferir} a conferir`,
        classe: r.pedidos_a_conferir ? "urgente" : "ok",
      },
    });
  }
  lista.push({
    href: "/turmas?situacao=EM_ANDAMENTO",
    icone: "list-check",
    cor: "teal",
    titulo: "Presença e notas",
    descricao: "As turmas em andamento: lançar a presença de cada dia, a nota e concluir.",
    contagem: { texto: `${andamento} em andamento`, classe: "" },
  });
  lista.push({
    href: "/certificados/fila",
    icone: "printer-fill",
    cor: "verde",
    titulo: "Fila de emissão",
    descricao: usuario.pode("certificado.emitir")
      ? "Emitir os certificados dos aprovados, de todas as turmas, e mandar por e-mail."
      : "Aprovados sem certificado, de todas as turmas.",
    contagem: {
      texto: `${r.fila.AGUARDANDO} aguardando` + (r.fila.TRAVADO ? ` · ${r.fila.TRAVADO} travado(s)` : ""),
      classe: r.fila.AGUARDANDO ? "atencao" : "ok",
    },
  });
  lista.push({
    href: "/certificados",
    icone: "file-earmark-check",
    cor: "azul",
    titulo: "Emitidos",
    descricao: anula ? "Busca, segunda via, corrigir e anular." : "Busca e segunda via dos emitidos.",
    contagem: { texto: `${r.fila.EMITIDO} emitido(s)`, classe: "" },
  });
  if (r.emails) {
    lista.push({
      href: "/certificados/emails",
      icone: "envelope-paper",
      cor: "azul",
      titulo: "Envios por e-mail",
      descricao: "O que foi enviado, o que está na fila e o que falhou.",
      contagem: {
        texto: `${r.emails.PENDENTE ?? 0} na fila` + (r.emails.FALHOU ? ` · ${r.emails.FALHOU} com falha` : ""),
        classe: r.emails.FALHOU ? "urgente" : "",
      },
    });
  }
  lista.push({
    href: "/certificados/vencimentos",
    icone: "shield-exclamation",
    cor: "vermelho",
    titulo: "Reciclagem",
    descricao: "Quem venceu e quem vence em 30 dias.",
    contagem: {
      texto: `${r.reciclagem.VENCIDO ?? 0} vencido(s) · ${r.reciclagem.A_VENCER ?? 0} a vencer`,
      classe: r.reciclagem.VENCIDO ? "urgente" : "",
    },
  });
  if (usuario.pode("indicador.ver")) {
    lista.push({
      href: "/treinamentos/indicadores",
      icone: "bar-chart-fill",
      cor: "laranja",
      titulo: "Indicadores",
      descricao: "Turmas, participantes e emissão por período e setor promotor.",
      contagem: null,
    });
  }
  return lista.map((c, i) => ({ ...c, numero: i + 1 }));
}
