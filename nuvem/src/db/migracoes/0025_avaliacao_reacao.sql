CREATE TABLE "avaliacao_reacao_convite" (
	"inscricao_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expira_em" date NOT NULL,
	CONSTRAINT "pk_avaliacao_reacao_convite" PRIMARY KEY("inscricao_id"),
	CONSTRAINT "uq_avaliacao_convite_token" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "avaliacao_reacao_resposta" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"turma_id" integer NOT NULL,
	"versao" varchar(10) NOT NULL,
	"nota_conteudo" smallint NOT NULL,
	"nota_instrutor" smallint NOT NULL,
	"nota_material" smallint NOT NULL,
	"nota_local" smallint NOT NULL,
	"nota_carga" smallint NOT NULL,
	"nota_recomendaria" smallint NOT NULL,
	"comentario" text,
	"respondida_em" date NOT NULL,
	CONSTRAINT "pk_avaliacao_reacao_resposta" PRIMARY KEY("id"),
	CONSTRAINT "ck_avaliacao_resposta_notas" CHECK (nota_conteudo BETWEEN 1 AND 5 AND nota_instrutor BETWEEN 1 AND 5 AND nota_material BETWEEN 1 AND 5 AND nota_local BETWEEN 1 AND 5 AND nota_carga BETWEEN 1 AND 5 AND nota_recomendaria BETWEEN 1 AND 5),
	CONSTRAINT "ck_avaliacao_resposta_comentario" CHECK (comentario IS NULL OR char_length(comentario) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "inscricao" ADD COLUMN "avaliacao_respondida" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "avaliacao_reacao_convite" ADD CONSTRAINT "fk_avaliacao_convite_inscricao" FOREIGN KEY ("inscricao_id") REFERENCES "public"."inscricao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avaliacao_reacao_resposta" ADD CONSTRAINT "fk_avaliacao_resposta_turma" FOREIGN KEY ("turma_id") REFERENCES "public"."turma"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_avaliacao_convite_expira" ON "avaliacao_reacao_convite" USING btree ("expira_em");--> statement-breakpoint
CREATE INDEX "ix_avaliacao_resposta_turma" ON "avaliacao_reacao_resposta" USING btree ("turma_id");