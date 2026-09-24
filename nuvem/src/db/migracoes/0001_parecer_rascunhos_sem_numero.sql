ALTER TABLE "parecer_tecnico" DROP CONSTRAINT "uq_parecer";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parecer" ON "parecer_tecnico" USING btree ("numero","ano") WHERE numero > 0;