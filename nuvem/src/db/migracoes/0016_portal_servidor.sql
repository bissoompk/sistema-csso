CREATE TABLE "certificado_sequencia_prefixo" (
	"prefixo" varchar(24) NOT NULL,
	"ano" integer NOT NULL,
	"ultimo_numero" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_certificado_sequencia_prefixo" PRIMARY KEY("prefixo","ano")
);
--> statement-breakpoint
ALTER TABLE "certificado" DROP CONSTRAINT "ck_certificado_chave";--> statement-breakpoint
ALTER TABLE "certificado" ALTER COLUMN "chave_validacao" SET DATA TYPE varchar(48);--> statement-breakpoint
ALTER TABLE "unidade_uorg" ADD COLUMN "cor_setor" varchar(12);--> statement-breakpoint
ALTER TABLE "unidade_uorg" ADD COLUMN "icone_setor" varchar(24);--> statement-breakpoint
ALTER TABLE "certificado" ADD COLUMN "numero_impresso" varchar(40);--> statement-breakpoint
ALTER TABLE "treinamento" ADD COLUMN "codigo_curto" varchar(10) DEFAULT '' NOT NULL;--> statement-breakpoint
-- NUVEM (escrito à mão, depois do drizzle-kit): o código curto de cada
-- treinamento que já existe, pela regra de `sugerir_codigo_curto`
-- (`dominio/treinamento.ts`), repetida aqui e na trava de `travas.sql`. A
-- equipe edita depois, no catálogo. Antes do UNIQUE: o '' do padrão repetido
-- derrubaria a constraint.
CREATE OR REPLACE FUNCTION csso_sem_acento_maiusculo(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(translate(coalesce(p, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'))
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION csso_sugerir_codigo_curto(p_nome text, p_codigo text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  fonte text := csso_sem_acento_maiusculo(coalesce(p_nome, '') || ' ' || coalesce(p_codigo, ''));
  nr text[];
  base text;
  iniciais text := '';
  palavra text;
BEGIN
  nr := regexp_match(fonte, '(^|[^A-Z0-9_])NR\s*[-–—]?\s*0*([0-9]{1,2})([^A-Z0-9_]|$)');
  IF nr IS NOT NULL THEN
    RETURN 'NR' || nr[2];
  END IF;
  base := left(regexp_replace(csso_sem_acento_maiusculo(p_codigo), '[^A-Z0-9]', '', 'g'), 10);
  IF length(base) >= 2 THEN
    RETURN base;
  END IF;
  FOR palavra IN SELECT w FROM regexp_split_to_table(csso_sem_acento_maiusculo(p_nome), '[^A-Z0-9]+') AS w LOOP
    IF length(palavra) >= 3 AND palavra NOT IN ('DAS', 'DOS', 'NOS', 'NAS', 'PARA', 'COM', 'POR') THEN
      iniciais := iniciais || left(palavra, 1);
    END IF;
  END LOOP;
  iniciais := left(iniciais, 6);
  IF length(iniciais) >= 2 THEN
    RETURN iniciais;
  END IF;
  base := left(regexp_replace(csso_sem_acento_maiusculo(p_nome), '[^A-Z0-9]', '', 'g'), 4);
  IF length(base) >= 2 THEN
    RETURN base;
  END IF;
  RETURN 'TR';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION csso_codigo_curto_livre(p_base text, p_id integer) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  candidato text := p_base;
  i integer := 2;
BEGIN
  WHILE EXISTS (SELECT 1 FROM treinamento WHERE codigo_curto = candidato AND id IS DISTINCT FROM p_id) LOOP
    candidato := left(p_base, 10 - length(i::text)) || i::text;
    i := i + 1;
  END LOOP;
  RETURN candidato;
END;
$$;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, nome, codigo FROM treinamento ORDER BY id LOOP
    UPDATE treinamento
      SET codigo_curto = csso_codigo_curto_livre(csso_sugerir_codigo_curto(r.nome, r.codigo), r.id)
      WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "hora_inicio" time;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "hora_fim" time;--> statement-breakpoint
ALTER TABLE "turma" ADD COLUMN "aceita_comunidade_externa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_hist_entidade_quando" ON "historico_evento" USING btree ("entidade","entidade_id","ocorrido_em");--> statement-breakpoint
ALTER TABLE "certificado" ADD CONSTRAINT "uq_certificado_numero_impresso" UNIQUE("numero_impresso");--> statement-breakpoint
ALTER TABLE "treinamento" ADD CONSTRAINT "uq_treinamento_codigo_curto" UNIQUE("codigo_curto");--> statement-breakpoint
ALTER TABLE "unidade_uorg" ADD CONSTRAINT "ck_uorg_cor_setor" CHECK (cor_setor IS NULL OR cor_setor IN ('azul','verde','petroleo','roxo','marinho','vinho','ambar','grafite'));--> statement-breakpoint
ALTER TABLE "unidade_uorg" ADD CONSTRAINT "ck_uorg_icone_setor" CHECK (icone_setor IS NULL OR icone_setor IN ('shield-plus','heart-pulse','clipboard2-check','mortarboard','building','people','award','journal-bookmark','person-badge'));--> statement-breakpoint
ALTER TABLE "certificado" ADD CONSTRAINT "ck_certificado_numero_impresso" CHECK (numero_impresso ~ '^(?:[A-Z0-9]{1,12}-[A-Z0-9]{2,10}-\d{4}-\d{4,6})$');--> statement-breakpoint
ALTER TABLE "certificado" ADD CONSTRAINT "ck_certificado_chave_do_numero" CHECK (numero_impresso IS NULL OR chave_validacao LIKE numero_impresso || '-%');--> statement-breakpoint
ALTER TABLE "certificado" ADD CONSTRAINT "ck_certificado_chave" CHECK (chave_validacao ~ '^(?:(?:CSSO-\d{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ])|(?:[A-Z0-9]{1,12}-[A-Z0-9]{2,10}-\d{4}-\d{4,6}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}))$');--> statement-breakpoint
ALTER TABLE "treinamento" ADD CONSTRAINT "ck_treinamento_codigo_curto" CHECK (codigo_curto ~ '^(?:[A-Z0-9]{2,10})$');--> statement-breakpoint
ALTER TABLE "turma" ADD CONSTRAINT "ck_turma_horas" CHECK (hora_fim IS NULL OR (hora_inicio IS NOT NULL AND hora_fim > hora_inicio));;--> statement-breakpoint
-- NUVEM (escrito à mão): a proposta de cor e ícone dos setores da Sisa
-- (DESVIOS.md, "Portal do servidor"), uma vez só; daí em diante quem muda é o
-- cadastro do setor promotor. Mesma lista de `APARENCIA_SETOR_INICIAL`.
UPDATE "unidade_uorg" SET "cor_setor" = v.cor, "icone_setor" = v.icone
FROM (VALUES
  ('COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL', 'azul', 'shield-plus'),
  ('COORDENADORIA DE SAUDE E QUALIDADE DE VIDA', 'verde', 'heart-pulse'),
  ('COORDENADORIA DE PERICIA OFICIAL EM SAUDE', 'petroleo', 'clipboard2-check'),
  ('COORDENADORIA DE PROMOCAO E EDUCACAO EM SAUDE', 'roxo', 'mortarboard'),
  ('SECRETARIA DA SISA', 'marinho', 'building')
) AS v(nome, cor, icone)
WHERE "unidade_uorg"."nome_oficial" = v.nome;--> statement-breakpoint
-- NUVEM (escrito à mão): "Comunidade externa" passa a depender de marcação na
-- turma. A turma que JÁ tem link público aceitava visitante e "outro": ela
-- continua aceitando (o link está no cartaz), e a equipe desmarca se quiser.
UPDATE "turma" SET "aceita_comunidade_externa" = true WHERE "inscricao_publica";
