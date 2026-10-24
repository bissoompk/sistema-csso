/**
 * Apagar o treinamento ou o instrutor cadastrado por engano — e só esse.
 *
 * O que já serviu a alguma turma não se apaga: a turma, o certificado e a
 * trilha apontam para ele. Para esse, o caminho é desmarcar "ativo", que tira
 * das listas de escolha sem desmentir o que já aconteceu. A tela diz isso
 * quando recusa.
 */
import { count, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  assinatura_instrutor as tabela_assinatura,
  certificado as tabela_certificado,
  certificado_modelo as tabela_modelo,
  instrutor_qualificacao as tabela_qualificacao,
  treinamento as tabela_treinamento,
  turma as tabela_turma,
  turma_instrutor as tabela_turma_instrutor,
} from "../db/esquema/index.js";
import { AssinaturaInstrutor } from "../dominio/treinamento.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";

export class ExclusaoRecusada extends RegraViolada {}

async function _quantos(tx: Executor, consulta: Promise<{ n: number }[]>): Promise<number> {
  const [linha] = await consulta;
  return Number(linha?.n ?? 0);
}

export async function excluir_treinamento(tx: Executor, usuario: UsuarioAtual, treinamento_id: number): Promise<string> {
  usuario.exigir("treinamento.gerenciar");
  const [alvo] = await tx.select().from(tabela_treinamento).where(eq(tabela_treinamento.id, treinamento_id));
  if (!alvo) throw new ExclusaoRecusada("Treinamento não encontrado.");
  const turmas = await _quantos(
    tx,
    tx.select({ n: count() }).from(tabela_turma).where(eq(tabela_turma.treinamento_id, alvo.id)),
  );
  const certificados = await _quantos(
    tx,
    tx.select({ n: count() }).from(tabela_certificado).where(eq(tabela_certificado.treinamento_id, alvo.id)),
  );
  if (turmas || certificados) {
    throw new ExclusaoRecusada(
      `${alvo.codigo} já tem ${turmas} turma(s)${certificados ? ` e ${certificados} certificado(s)` : ""}: ` +
        "não se exclui. Desmarque “ativo” para tirá-lo das listas de escolha.",
    );
  }
  const modelos = await _quantos(
    tx,
    tx.select({ n: count() }).from(tabela_modelo).where(eq(tabela_modelo.treinamento_id, alvo.id)),
  );
  if (modelos) {
    throw new ExclusaoRecusada(
      `${alvo.codigo} tem ${modelos} modelo(s) de certificado próprio(s): aponte-os para outro treinamento, ou ` +
        "desmarque “ativo”.",
    );
  }
  // a qualificação de instrutor que aponta para ele é comprovante guardado: não some junto
  const qualificacoes = await _quantos(
    tx,
    tx.select({ n: count() }).from(tabela_qualificacao).where(eq(tabela_qualificacao.treinamento_id, alvo.id)),
  );
  if (qualificacoes) {
    throw new ExclusaoRecusada(
      `${alvo.codigo} é o treinamento de ${qualificacoes} qualificação(ões) de instrutor: não se exclui. ` +
        "Desmarque “ativo” para tirá-lo das listas de escolha.",
    );
  }
  await tx.delete(tabela_treinamento).where(eq(tabela_treinamento.id, alvo.id));
  await auditoria.registrar(tx, {
    entidade: "treinamento",
    entidade_id: alvo.id,
    tipo_evento: "TREINAMENTO_EXCLUIDO",
    descricao: `${alvo.codigo} · ${alvo.nome} excluído do catálogo (nunca teve turma)`,
    valor_anterior: { codigo: alvo.codigo, nome: alvo.nome, carga_horaria_horas: alvo.carga_horaria_horas },
    usuario,
  });
  return alvo.codigo;
}

export async function excluir_instrutor(tx: Executor, usuario: UsuarioAtual, assinatura_id: number): Promise<string> {
  usuario.exigir("assinatura.gerenciar");
  const alvo = await tx.query.assinatura_instrutor.findFirst({
    where: eq(tabela_assinatura.id, assinatura_id),
    with: { servidor: true } as never,
  });
  if (!alvo) throw new ExclusaoRecusada("Instrutor não encontrado.");
  const nome = AssinaturaInstrutor.nome_exibicao(alvo as never);
  const turmas = await _quantos(
    tx,
    tx
      .select({ n: count() })
      .from(tabela_turma_instrutor)
      .where(eq(tabela_turma_instrutor.assinatura_instrutor_id, alvo.id)),
  );
  if (turmas) {
    throw new ExclusaoRecusada(
      `${nome} está em ${turmas} turma(s): não se exclui. Desmarque “ativo”, ou feche a vigência, ` +
        "para tirá-lo das próximas turmas.",
    );
  }
  // o comprovante de qualificação é guardado: quem o tem não se apaga
  const qualificacoes = await _quantos(
    tx,
    tx.select({ n: count() }).from(tabela_qualificacao).where(eq(tabela_qualificacao.instrutor_id, alvo.id)),
  );
  if (qualificacoes) {
    throw new ExclusaoRecusada(
      `${nome} tem ${qualificacoes} qualificação(ões) cadastrada(s): não se exclui. Desmarque “ativo” para tirá-lo das próximas turmas.`,
    );
  }
  // instrutor padrão de algum treinamento: o treinamento só perde a sugestão
  const padrao_de = await tx
    .update(tabela_treinamento)
    .set({ instrutor_padrao_id: null })
    .where(eq(tabela_treinamento.instrutor_padrao_id, alvo.id))
    .returning({ codigo: tabela_treinamento.codigo });
  await tx.delete(tabela_assinatura).where(eq(tabela_assinatura.id, alvo.id));
  await auditoria.registrar(tx, {
    entidade: "assinatura_instrutor",
    entidade_id: alvo.id,
    tipo_evento: "ASSINATURA_INSTRUTOR_EXCLUIDA",
    descricao:
      `${nome} excluído dos instrutores (nunca esteve em turma)` +
      (padrao_de.length ? `; deixou de ser o instrutor padrão de ${padrao_de.map((t) => t.codigo).join(", ")}` : ""),
    usuario,
  });
  return nome;
}
