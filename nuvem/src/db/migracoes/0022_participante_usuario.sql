ALTER TABLE "participante" ADD COLUMN "usuario_id" integer;--> statement-breakpoint
ALTER TABLE "participante" ADD CONSTRAINT "fk_participante_usuario" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participante" ADD CONSTRAINT "uq_participante_usuario" UNIQUE("usuario_id");