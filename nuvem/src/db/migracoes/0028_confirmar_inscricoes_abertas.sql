-- 25/10/2026: a inscrição com vaga nasce CONFIRMADA (ninguém precisa aprovar).
-- As que esperavam o clique em "Confirmar", em turma ainda não encerrada,
-- passam a confirmadas, e a tarefa de confirmar de cada uma fecha.
UPDATE "inscricao" i SET "situacao" = 'CONFIRMADA', "confirmada_em" = now()
  FROM "turma" t
  WHERE t."id" = i."turma_id" AND i."situacao" = 'INSCRITA'
    AND t."situacao" IN ('PLANEJADA', 'INSCRICOES_ABERTAS', 'EM_ANDAMENTO');
--> statement-breakpoint
UPDATE "pendencia" p SET "concluida" = true, "concluida_em" = now()
  FROM "inscricao" i
  WHERE p."tipo" = 'TURMA_INSCRICAO_A_CONFIRMAR' AND p."concluida" = false
    AND p."chave" = 'inscricao-' || i."id" || '-a-confirmar' AND i."situacao" = 'CONFIRMADA';
