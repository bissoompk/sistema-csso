ALTER TABLE "turma" ADD COLUMN "divulgar_na_vitrine" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "divulgada_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "titulo_vitrine" varchar(160);--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "modalidade" varchar(12) DEFAULT 'PRESENCIAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "publico_alvo" varchar(16)[] DEFAULT '{}'::varchar[] NOT NULL;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "pre_requisito" varchar(300);--> statement-breakpoint
CREATE INDEX "ix_turma_vitrine" ON "turma" USING btree ("situacao","data_inicio") WHERE divulgar_na_vitrine;--> statement-breakpoint
ALTER TABLE "turma" ADD CONSTRAINT "ck_turma_modalidade" CHECK (modalidade IN ('PRESENCIAL','EAD','HIBRIDO'));