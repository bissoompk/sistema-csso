/**
 * Ajuda dos testes do Processos SEI: os `atores` e o `cenario` do
 * `testes/integracao/conftest.py` (o caso do Parecer 1/2025, Marco Antônio) e
 * os papéis de `testes/integracao/papeis.py`.
 */
import { and, eq } from "drizzle-orm";
import type { Executor } from "../src/db/cliente.js";
import * as e from "../src/db/esquema/index.js";
import { MODELO_V1 } from "../src/servicos/documento.js";
import * as servico from "../src/servicos/parecer.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { criarUsuario } from "./ajuda.js";

export const TODAS: readonly string[] = [
  "processo.ver", "processo.criar", "processo.editar", "processo.status",
  "processo.atribuir", "parecer.ver", "parecer.criar", "parecer.editar",
  "parecer.emitir", "parecer.assinar", "parecer.anular", "laudo.ver",
  "laudo.criar", "anexo.enviar", "exposicao.ver", "exportar", "indicador.ver",
  "catalogo.gerenciar",
];

// Fátima: emite e move o kanban, mas NÃO assina nem subscreve laudo.
export const SEM_ASSINATURA = TODAS.filter((p) => !["parecer.assinar", "laudo.criar", "parecer.anular"].includes(p));

export interface Atores {
  COORDENADOR: UsuarioAtual;
  TECNICA: UsuarioAtual;
  coord_id: number;
  fatima_id: number;
}

let _seq = 0;

/** As contas reais (as FKs de auditoria e `emitido_por` apontam para elas). */
export async function atores(db: Executor): Promise<Atores> {
  const sufixo = ++_seq === 1 ? "" : String(_seq);
  const coord = await criarUsuario(db, { login: `coord${sufixo}`, nome: "Coordenador" });
  const fatima = await criarUsuario(db, { login: `fatima${sufixo}`, nome: "Fátima" });
  return {
    coord_id: coord.id,
    fatima_id: fatima.id,
    COORDENADOR: new UsuarioAtual({
      id: coord.id,
      login: coord.login,
      nome: "Coordenador",
      permissoes: TODAS,
      perfis: ["coordenador_csso"],
    }),
    TECNICA: new UsuarioAtual({
      id: fatima.id,
      login: fatima.login,
      nome: "Fátima",
      permissoes: SEM_ASSINATURA,
      perfis: ["tecnico_seguranca"],
    }),
  };
}

async function pegar<T>(consulta: Promise<T[]>): Promise<T> {
  const [linha] = await consulta;
  if (!linha) throw new Error("semente ausente");
  return linha;
}

export interface Cenario {
  parecer_id: number;
  processo_id: number;
  laudo_id: number;
  servidor_id: number;
  portaria_id: number;
}

/**
 * O caso do Parecer 1/2025 montado direto no banco. `nup`/`siape` mudam para
 * o mesmo arquivo poder montar mais de um cenário no mesmo banco.
 */
export async function cenario(
  db: Executor,
  o: { nup?: string; siape?: string; laudo?: string; ano?: number; numero_portaria?: string } = {},
): Promise<Cenario> {
  const famed = await pegar(db.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.codigo_uorg, "250")));
  const cargo = await pegar(db.select().from(e.cargo).where(eq(e.cargo.nome, "TECNICO DE LABORATORIO AREA")));
  const insal = await pegar(db.select().from(e.tipo_adicional).where(eq(e.tipo_adicional.codigo, "INSALUBRIDADE")));
  const concessao = await pegar(db.select().from(e.tipo_movimento).where(eq(e.tipo_movimento.codigo, "CONCESSAO")));
  const marco = await pegar(
    db.select().from(e.tipo_marco_inicial).where(eq(e.tipo_marco_inicial.codigo, "PORTARIA_LOCALIZACAO")),
  );
  const destinatario = await pegar(db.select().from(e.autoridade_destinataria).orderBy(e.autoridade_destinataria.id).limit(1));
  const signatario = await pegar(
    db.select().from(e.profissional_habilitado).where(eq(e.profissional_habilitado.nome, "Fabrício Raimundi Andrade")),
  );
  const agente = await pegar(
    db
      .select()
      .from(e.agente_nocivo)
      .where(eq(e.agente_nocivo.descricao, "Contato permanente com material infecto-contagiante")),
  );
  const medio = await pegar(
    db
      .select()
      .from(e.percentual_aplicavel)
      .where(and(eq(e.percentual_aplicavel.tipo_adicional_id, insal.id), eq(e.percentual_aplicavel.grau, "MEDIO"))),
  );
  const leac = await pegar(
    db
      .select()
      .from(e.posto_trabalho)
      .where(
        and(
          eq(e.posto_trabalho.unidade_uorg_id, famed.id),
          eq(e.posto_trabalho.nome, "Laboratório Escola de análises Clínicas (LEAC)"),
        ),
      ),
  );
  const ldip = await pegar(
    db
      .select()
      .from(e.posto_trabalho)
      .where(
        and(
          eq(e.posto_trabalho.unidade_uorg_id, famed.id),
          eq(e.posto_trabalho.nome, "Laboratório de Doenças Infecciosas e Parasitárias"),
        ),
      ),
  );

  const [servidor] = await db
    .insert(e.servidor)
    .values({
      siape: o.siape ?? "1110654",
      nome: "Marco Antônio Alves Schetino",
      cargo_id: cargo.id,
      unidade_uorg_id: famed.id,
    })
    .returning();
  const [portaria] = await db
    .insert(e.portaria_localizacao)
    .values({
      unidade_emissora_id: famed.id,
      numero: o.numero_portaria ?? "35",
      ano: 2024,
      data_publicacao: "2024-09-17",
      texto_original: "PORTARIA/FAMED Nº 35, DE 17 DE SETEMBRO DE 2024",
    })
    .returning();
  const [laudo] = await db
    .insert(e.laudo_tecnico)
    .values({
      numero_siape: o.laudo ?? "26255-000.125/2019",
      ano: Number((o.laudo ?? "26255-000.125/2019").slice(-4)),
      tipo_adicional_id: insal.id,
      unidade_uorg_id: famed.id,
      data_emissao: "2019-06-01",
      subscritor_id: signatario.id,
    })
    .returning();
  const etapa = await pegar(db.select().from(e.fluxo_etapa).where(eq(e.fluxo_etapa.codigo, "EM_ANDAMENTO")));
  const tipo = await pegar(db.select().from(e.tipo_processo).where(eq(e.tipo_processo.codigo, "ADICIONAL_OCUPACIONAL")));
  const [processo] = await db
    .insert(e.processo)
    .values({
      nup: o.nup ?? "23086.021284/2024-56",
      tipo_processo_id: tipo.id,
      etapa_id: etapa.id,
      estado_tecnico: "PARECER_EM_ELABORACAO",
      servidor_id: servidor!.id,
      unidade_uorg_id: famed.id,
      data_autuacao: "2024-10-01",
    })
    .returning();
  const [parecer] = await db
    .insert(e.parecer_tecnico)
    .values({
      numero: 0,
      ano: o.ano ?? 2025,
      situacao: "RASCUNHO",
      processo_id: processo!.id,
      servidor_id: servidor!.id,
      laudo_id: laudo!.id,
      tipo_adicional_id: insal.id,
      tipo_movimento_id: concessao.id,
      unidade_uorg_id: famed.id,
      portaria_id: portaria!.id,
      destinatario_id: destinatario.id,
      signatario_id: signatario.id,
      tipo_marco_id: marco.id,
      data_marco_inicial: "2024-09-17",
      data_emissao: `${o.ano ?? 2025}-02-11`,
      texto_recomendacao:
        "Reconhecer o direito ao adicional de insalubridade caracterizado pela " +
        "exposição ao Agente Biológico, a partir da data da Portaria de " +
        "Localização: 17 de setembro de 2024",
      texto_alteracao:
        "Qualquer alteração na execução das atividades técnicas do servidor, bem " +
        "como mudanças em sua carga horária, deverá ser comunicada ao Serviço " +
        "Especializado em Segurança do Trabalho – SEST.",
      modelo_arquivo: MODELO_V1,
    })
    .returning();
  await db.insert(e.parecer_posto).values([
    { parecer_id: parecer!.id, posto_trabalho_id: leac.id, ordem: 1 },
    { parecer_id: parecer!.id, posto_trabalho_id: ldip.id, ordem: 2 },
  ]);
  await db.insert(e.exposicao).values({
    parecer_id: parecer!.id,
    agente_nocivo_id: agente.id,
    percentual_id: medio.id,
    fundamentacao_id: agente.fundamentacao_id!,
    principal: true,
    horas_exposicao_mensais: "160",
    jornada_mensal_horas: "160",
    classificacao_exposicao: "PERMANENTE",
    percentual_jornada: "100",
  });
  return {
    parecer_id: parecer!.id,
    processo_id: processo!.id,
    laudo_id: laudo!.id,
    servidor_id: servidor!.id,
    portaria_id: portaria!.id,
  };
}

/** O parecer do cenário com a árvore carregada (o objeto do ORM do Python). */
export async function parecerDe(db: Executor, id: number): Promise<servico.ParecerCompleto> {
  const p = await servico.carregar(db, id);
  if (!p) throw new Error(`parecer ${id} ausente`);
  return p;
}

// =====================================================================
// Isolamento por teste dentro do mesmo banco (o `sessao` do conftest, que
// morria com o teste): o corpo roda numa transação que é SEMPRE desfeita.
// =====================================================================
class Desfazer extends Error {}

/** Roda `f` numa transação e a desfaz no fim — o banco volta como estava. */
export async function desfeita<T>(db: { transaction: Executor["transaction"] }, f: (tx: Executor) => Promise<T>): Promise<T> {
  let resultado: T | undefined;
  try {
    await (db as any).transaction(async (tx: Executor) => {
      resultado = await f(tx);
      throw new Desfazer();
    });
  } catch (erro) {
    if (!(erro instanceof Desfazer)) throw erro;
  }
  return resultado as T;
}

/**
 * O erro que `f` levanta, contido num SAVEPOINT: no PostgreSQL um erro de SQL
 * aborta a transação inteira, e o teste precisa continuar depois dele (o
 * `sessao.rollback()` depois do `pytest.raises` do Python).
 */
export async function erroNoSavepoint(tx: Executor, f: (sp: Executor) => Promise<unknown>): Promise<Error | null> {
  try {
    await (tx as any).transaction(async (sp: Executor) => {
      await f(sp);
    });
    return null;
  } catch (erro) {
    return erro as Error;
  }
}
