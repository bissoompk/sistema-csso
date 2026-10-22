CREATE TABLE "equipe_setor_promotor" (
	"usuario_id" integer NOT NULL,
	"unidade_uorg_id" integer NOT NULL,
	"vinculado_por" integer,
	"vinculado_em" timestamp with time zone NOT NULL,
	CONSTRAINT "equipe_setor_promotor_usuario_id_unidade_uorg_id_pk" PRIMARY KEY("usuario_id","unidade_uorg_id")
);
--> statement-breakpoint
CREATE TABLE "perfil_nivel_modulo" (
	"perfil_id" integer NOT NULL,
	"modulo" varchar(32) NOT NULL,
	"nivel" varchar(12) NOT NULL,
	"alterado_por" integer,
	"alterado_em" timestamp with time zone NOT NULL,
	CONSTRAINT "perfil_nivel_modulo_perfil_id_modulo_pk" PRIMARY KEY("perfil_id","modulo"),
	CONSTRAINT "ck_perfil_nivel_modulo" CHECK (nivel IN ('SEM_ACESSO','CONSULTA','OPERACAO'))
);
--> statement-breakpoint
CREATE TABLE "usuario_nivel_modulo" (
	"usuario_id" integer NOT NULL,
	"modulo" varchar(32) NOT NULL,
	"nivel" varchar(12) NOT NULL,
	"alterado_por" integer,
	"alterado_em" timestamp with time zone NOT NULL,
	CONSTRAINT "usuario_nivel_modulo_usuario_id_modulo_pk" PRIMARY KEY("usuario_id","modulo"),
	CONSTRAINT "ck_usuario_nivel_modulo" CHECK (nivel IN ('SEM_ACESSO','CONSULTA','OPERACAO'))
);
--> statement-breakpoint
ALTER TABLE "equipe_setor_promotor" ADD CONSTRAINT "equipe_setor_promotor_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipe_setor_promotor" ADD CONSTRAINT "equipe_setor_promotor_unidade_uorg_id_unidade_uorg_id_fk" FOREIGN KEY ("unidade_uorg_id") REFERENCES "public"."unidade_uorg"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipe_setor_promotor" ADD CONSTRAINT "equipe_setor_promotor_vinculado_por_usuario_id_fk" FOREIGN KEY ("vinculado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perfil_nivel_modulo" ADD CONSTRAINT "perfil_nivel_modulo_perfil_id_perfil_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfil"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perfil_nivel_modulo" ADD CONSTRAINT "perfil_nivel_modulo_alterado_por_usuario_id_fk" FOREIGN KEY ("alterado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuario_nivel_modulo" ADD CONSTRAINT "usuario_nivel_modulo_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuario_nivel_modulo" ADD CONSTRAINT "usuario_nivel_modulo_alterado_por_usuario_id_fk" FOREIGN KEY ("alterado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- NUVEM (escrito à mão, depois do drizzle-kit): turmas por setor promotor.
-- Até aqui só a CSSO operava o módulo de Certificados e Treinamentos, e toda
-- turma era dela. Para ninguém perder acesso no dia da implantação, toda conta
-- com perfil de equipe da CSSO vigente (ou futuro) entra no setor CSSO. Roda uma
-- vez, com a migração; daí em diante quem vincula é a coordenação, em /usuarios
-- (com trilha). `vinculado_por` nulo = "pela migração 0014". Os perfis que veem
-- todos os setores (`turma.todos_os_setores`) não precisam de vínculo.
INSERT INTO "equipe_setor_promotor" ("usuario_id", "unidade_uorg_id", "vinculado_em")
SELECT DISTINCT a."usuario_id", u."id", now()
FROM "atribuicao" a
JOIN "perfil" p ON p."id" = a."perfil_id"
CROSS JOIN (
  SELECT "id" FROM "unidade_uorg"
  WHERE "nome_oficial" = 'COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL'
  ORDER BY "id" LIMIT 1
) u
WHERE p."codigo" IN ('coordenador_csso', 'engenheiro_seguranca', 'medico_trabalho',
                     'tecnico_seguranca', 'secretaria_csso', 'almoxarife_sesmt')
  AND (a."vigencia_fim" IS NULL OR a."vigencia_fim" >= CURRENT_DATE)
ON CONFLICT DO NOTHING;
