CREATE TABLE "turma_ajudante" (
	"turma_id" integer NOT NULL,
	"usuario_id" integer NOT NULL,
	"inscricoes" boolean DEFAULT false NOT NULL,
	"presenca" boolean DEFAULT false NOT NULL,
	"emissao" boolean DEFAULT false NOT NULL,
	"designado_por" integer NOT NULL,
	"designado_em" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_turma_ajudante" PRIMARY KEY("turma_id","usuario_id"),
	CONSTRAINT "ck_turma_ajudante_papel" CHECK (inscricoes OR presenca OR emissao)
);
--> statement-breakpoint
ALTER TABLE "treinamento" ADD COLUMN "criado_por" integer;--> statement-breakpoint
ALTER TABLE "turma_ajudante" ADD CONSTRAINT "fk_turma_ajudante_turma" FOREIGN KEY ("turma_id") REFERENCES "public"."turma"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turma_ajudante" ADD CONSTRAINT "fk_turma_ajudante_usuario" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turma_ajudante" ADD CONSTRAINT "fk_turma_ajudante_designado_por" FOREIGN KEY ("designado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_turma_ajudante_usuario" ON "turma_ajudante" USING btree ("usuario_id");--> statement-breakpoint
ALTER TABLE "treinamento" ADD CONSTRAINT "fk_treinamento_criado_por" FOREIGN KEY ("criado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- O DONO de quem já existe (23/10/2026), pela trilha: a conta do evento de
-- criação. Sem evento (ou evento sem conta, o "sistema" da importação), fica
-- nulo = "sem dono", e só a hierarquia superior altera (`dono_turma.ts`).
UPDATE "treinamento" AS t SET "criado_por" = (
	SELECT h."usuario_id" FROM "historico_evento" AS h
	WHERE h."entidade" = 'treinamento' AND h."entidade_id" = t."id"
		AND h."tipo_evento" = 'TREINAMENTO_CRIADO' AND h."usuario_id" IS NOT NULL
	ORDER BY h."id" LIMIT 1
) WHERE t."criado_por" IS NULL;--> statement-breakpoint
UPDATE "turma" AS t SET "criado_por" = (
	SELECT h."usuario_id" FROM "historico_evento" AS h
	WHERE h."entidade" = 'turma' AND h."entidade_id" = t."id"
		AND h."tipo_evento" = 'TURMA_CRIADA' AND h."usuario_id" IS NOT NULL
	ORDER BY h."id" LIMIT 1
) WHERE t."criado_por" IS NULL;