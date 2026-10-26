ALTER TABLE "participante_mesclagem" ADD COLUMN "desfeita_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participante_mesclagem" ADD COLUMN "desfeita_por" integer;--> statement-breakpoint
ALTER TABLE "participante_mesclagem" ADD COLUMN "desfeita_motivo" text;--> statement-breakpoint
ALTER TABLE "participante_mesclagem" ADD CONSTRAINT "fk_mesclagem_desfeita_por" FOREIGN KEY ("desfeita_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participante_mesclagem" ADD CONSTRAINT "ck_mesclagem_desfeita" CHECK ((desfeita_em IS NULL) = (desfeita_motivo IS NULL));