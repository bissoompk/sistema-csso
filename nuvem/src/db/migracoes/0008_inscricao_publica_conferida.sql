ALTER TABLE "inscricao" DROP CONSTRAINT "ck_inscricao_email_confirmado";--> statement-breakpoint
ALTER TABLE "inscricao" ADD COLUMN "conferida_por" integer;--> statement-breakpoint
ALTER TABLE "inscricao" ADD COLUMN "conferida_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inscricao" ADD CONSTRAINT "fk_inscricao_conferida_por" FOREIGN KEY ("conferida_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inscricao" ADD CONSTRAINT "ck_inscricao_email_confirmado" CHECK (origem = 'INTERNA' OR situacao IN ('AGUARDANDO_EMAIL','CANCELADA') OR email_confirmado_em IS NOT NULL OR conferida_por IS NOT NULL);