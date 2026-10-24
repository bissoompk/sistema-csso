-- Limpeza de dados de teste (24/10/2026): a trilha deixa de ter chave
-- estrangeira para `processo` e `usuario`. Ela e append-only (nao se reescreve
-- para deixar de apontar) e, com a chave, o processo e a conta citados nela
-- nunca saiam. O evento antigo fica com o numero (nenhuma das duas colunas
-- entra no digest da cadeia). Ver o comentario de `historico_evento` em
-- `src/db/esquema/auditoria.ts` e DESVIOS.md, "Limpar dados de teste".
ALTER TABLE "historico_evento" DROP CONSTRAINT "historico_evento_processo_id_processo_id_fk";
--> statement-breakpoint
ALTER TABLE "historico_evento" DROP CONSTRAINT "historico_evento_usuario_id_usuario_id_fk";
