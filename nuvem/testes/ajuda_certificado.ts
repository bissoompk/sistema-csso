/**
 * A montagem dos testes de Certificados: o `_usuario`, o `_modelo_com_tags` e o
 * `_cenario` de `testes/integracao/test_certificados.py` (que o
 * `test_validacao_publica.py` também importa de lá).
 *
 * Diferença de forma: no Python o cenário vivia numa sessão só e o teste fazia
 * `expire_all()` para reler; aqui cada serviço grava direto no banco (o
 * executor é o `db`, sem transação aberta) e o cenário devolve a inscrição
 * RECARREGADA depois do fecho da turma — a apuração lê as inscrições de novo,
 * e o objeto de antes ficaria dizendo "inscrita".
 */
import { eq } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as autenticacao from "../src/servicos/autenticacao.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import * as servico_turma from "../src/servicos/turma.js";
import { MAPA_SUGERIDO, OBRIGATORIOS } from "../ferramentas/povoar/treinamentos.js";
import { SENHA_TESTE } from "./ajuda.js";

export { MAPA_SUGERIDO, OBRIGATORIOS };

export const INICIO = somar_dias(datas_br.hoje(), -2);
export const MODELO_ARQUIVO = "certificado_padrao_v1.docx";

export const TODAS: ReadonlySet<string> = new Set([
  "treinamento.ver",
  "treinamento.gerenciar",
  "assinatura.gerenciar",
  "turma.criar",
  "turma.inscrever",
  "turma.concluir",
  "turma.avaliar",
  "certificado.emitir",
  "certificado.anular",
  "certificado.ver",
]);

/** Um `UsuarioAtual` com linha real em `usuario` (as FKs da trilha apontam para ela). */
export async function _usuario(db: Executor, permissoes: Iterable<string> = TODAS, login = "operador"): Promise<UsuarioAtual> {
  const [registro] = await db
    .insert(e.usuario)
    .values({
      login,
      nome: `Operador ${login}`,
      email: `${login}@teste.ufvjm.edu.br`,
      senha_hash: await autenticacao.gerar_hash(SENHA_TESTE),
      precisa_trocar_senha: false,
    })
    .returning();
  return new UsuarioAtual({
    id: registro!.id,
    login,
    nome: registro!.nome,
    permissoes: [...permissoes],
    perfis: ["coordenador_csso"],
  });
}

export async function _modelo_com_tags(
  db: Executor,
  treinamento: { id: number },
  d: { nome?: string; versao?: number } = {},
) {
  const [modelo] = await db
    .insert(e.certificado_modelo)
    .values({
      treinamento_id: treinamento.id,
      nome: d.nome ?? "Padrão",
      arquivo: MODELO_ARQUIVO,
      versao: d.versao ?? 1,
      vigente: true,
    })
    .returning();
  let ordem = 1;
  for (const [marcador, campo] of Object.entries(MAPA_SUGERIDO)) {
    await db.insert(e.certificado_modelo_tag).values({
      modelo_id: modelo!.id,
      marcador,
      campo,
      ordem: ordem++,
      obrigatorio: OBRIGATORIOS.includes(marcador),
    });
  }
  return modelo!;
}

export interface Cenario {
  treinamento: typeof e.treinamento.$inferSelect;
  modelo: typeof e.certificado_modelo.$inferSelect;
  instrutor: typeof e.assinatura_instrutor.$inferSelect;
  turma: servico_turma.TurmaCarregada;
  inscricao: servico_turma.InscricaoCarregada;
  servidor: typeof e.servidor.$inferSelect;
  outras: servico_turma.InscricaoCarregada[];
}

/**
 * Catálogo, modelo, turma concluída e uma inscrita aprovada. `extras` são
 * `[siape, nome, horas]` inscritos ANTES do fecho.
 */
export async function _cenario(
  db: Executor,
  usuario: UsuarioAtual,
  d: { nota_minima?: string | null; presente?: boolean; horas?: string; extras?: [string, string, string][] } = {},
): Promise<Cenario> {
  const presente = d.presente ?? true;
  const horas = d.horas ?? "8";
  const extras = d.extras ?? [];
  const [treinamento] = await db
    .insert(e.treinamento)
    .values({
      codigo: "NR-35",
      nome: "Trabalho em Altura — NR-35",
      carga_horaria_horas: "8",
      conteudo_programatico:
        "Normas e regulamentos aplicáveis\n" +
        "Análise de risco e condições impeditivas\n" +
        "Equipamentos de proteção individual para trabalho em altura",
      validade_meses: 24,
      norma_referencia: "NR-35",
    })
    .returning();
  const modelo = await _modelo_com_tags(db, treinamento!);
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, treinamento!.id));

  const [instrutor] = await db
    .insert(e.assinatura_instrutor)
    .values({
      nome: "Fabrício Raimundi Andrade",
      titulo: "Engenheiro de Segurança do Trabalho",
      conselho: "CREA",
      registro_conselho: "MG-123456",
      externo: true,
      vigencia_inicio: "2020-01-01",
    })
    .returning();
  const [servidor] = await db.insert(e.servidor).values({ siape: "1110654", nome: "Marco Antônio Alves Schetino" }).returning();

  const [t] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, treinamento!.id));
  const turma = await servico_turma.criar_turma(db, usuario, {
    treinamento: t!,
    data_inicio: INICIO,
    data_fim: INICIO,
    local: "Auditório do Campus JK",
    nota_minima_aprovacao: d.nota_minima ?? null,
  });
  await servico_turma.vincular_instrutor(db, usuario, turma, { ...instrutor!, servidor: null });
  const pessoa = await servico_participante.de_servidor(db, servidor!, usuario);
  const inscricao = await servico_turma.inscrever(db, usuario, turma, pessoa);

  const outras: servico_turma.InscricaoCarregada[] = [];
  for (const [siape, nome] of extras) {
    const [outro] = await db.insert(e.servidor).values({ siape, nome }).returning();
    const outra_pessoa = await servico_participante.de_servidor(db, outro!, usuario);
    outras.push(await servico_turma.inscrever(db, usuario, turma, outra_pessoa));
  }

  await servico_turma.mudar_situacao(db, usuario, turma, "EM_ANDAMENTO");
  if (presente) {
    await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: INICIO, presente: true, horas });
  }
  for (let i = 0; i < outras.length; i++) {
    await servico_presenca.lancar_presenca(db, usuario, outras[i]!, { data: INICIO, presente: true, horas: extras[i]![2] });
  }
  if (d.nota_minima !== undefined && d.nota_minima !== null) {
    await servico_presenca.lancar_nota(db, usuario, inscricao, "9.5");
  }
  await servico_turma.mudar_situacao(db, usuario, turma, "CONCLUIDA");

  // o `expire_all()` do Python: relê o que a apuração gravou
  const turma_fresca = (await servico_turma.carregar_turma(db, turma.id))!;
  const reler = async (i: { id: number }) => (await servico_turma.carregar_inscricao(db, i.id, turma_fresca))!;
  const [m] = await db.select().from(e.certificado_modelo).where(eq(e.certificado_modelo.id, modelo.id));
  return {
    treinamento: t!,
    modelo: m!,
    instrutor: instrutor!,
    turma: turma_fresca,
    inscricao: await reler(inscricao),
    servidor: servidor!,
    outras: await Promise.all(outras.map(reler)),
  };
}
