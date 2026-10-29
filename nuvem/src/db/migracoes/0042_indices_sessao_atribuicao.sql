CREATE INDEX "ix_atribuicao_usuario" ON "atribuicao" USING btree ("usuario_id","vigencia_fim");--> statement-breakpoint
CREATE INDEX "ix_sessao_usuario" ON "sessao" USING btree ("usuario_id","revogada");--> statement-breakpoint
CREATE INDEX "ix_sessao_expira" ON "sessao" USING btree ("expira_em");