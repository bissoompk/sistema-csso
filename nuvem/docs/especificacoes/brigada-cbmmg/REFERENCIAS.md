# Brigada orgânica (CBMMG) — referências normativas

Lote 4 do plano de Treinamentos (25/11/2026): turma em TEMPOS, disciplinas com nota
e o certificado "Brigada CBMMG v1".

## Portaria CBMMG nº 54/2020, com as atualizações (Portaria nº 77, de 11/02/2025)

- **Endereço oficial do PDF:**
  https://www.bombeiros.mg.gov.br/storage/files/shares/portarias/Portaria%2054_Centros%20de%20forma%C3%A7%C3%A3o_com_atualiza%C3%A7%C3%B5es_vers%C3%A3o_final.pdf
- **Baixado em:** 25/11/2026, às 06h37 (horário de Brasília)
- **Arquivo:** 1.684.821 bytes; SHA-256
  `892833fa4fc199ce285412cdd6fbe30ae9c982d67ab1592e50122ddf91f2c98d`
- **Metadados do PDF:** criado em 18/02/2025 (Microsoft Word 2016)

O PDF não fica no repositório. Se o arquivo baixado de novo tiver outro SHA-256, a portaria
mudou: releia os dispositivos abaixo antes de mexer no modelo.

### Dispositivos que o sistema segue

| Dispositivo | O que diz, em resumo | Onde mora no sistema |
|---|---|---|
| Art. 40, caput | Certificado para quem tem, em cada disciplina, aproveitamento mínimo de 70% e frequência mínima de 75% da carga | Apuração da turma em TEMPOS: nota ≥ 70 em cada disciplina e frequência ≥ 75% |
| Art. 42, § 3º | A nota final é a média aritmética das notas parciais das disciplinas | `inscricao.nota_final` (escala 100), com duas casas |
| Art. 43, II, a–j | O que o certificado do brigadista orgânico contém (nome e CPF do aluno, curso, carga, período, centro de formação com CNPJ, responsável com CPF e assinatura, credenciamento ou registro, disciplinas com notas e cargas no verso, local de atuação, data de expedição) | Modelo "Brigada CBMMG v1" e os bloqueios da emissão |
| Arts. 59, 63 | Quem pode dar o nível básico: engenheiro de segurança do trabalho, engenheiro ou arquiteto com especialização em segurança do trabalho, técnico em segurança do trabalho, militar das Forças Armadas | `assinatura_instrutor.profissao` |
| Anexo G | Brigadista orgânico nível básico: 10 tempos (5 teóricos e 5 práticos); 1 tempo = 50 min | Disciplinas do treinamento |
| Anexo I | Modelo referencial do certificado (anverso e verso) | Modelo "Brigada CBMMG v1" |

### Decisões do coordenador sobre o Anexo I (25/11/2026)

- **Identidade (RG):** não entra; o certificado segue o art. 43, II. O modelo fica pronto
  para receber o campo depois, sem mexer em certificado já emitido.
- **Citação legal da carga** ("conforme Lei Estadual nº 22.839/2018 e Portaria 54/2020 do
  CBMMG"): é um campo editável do modelo, não um texto fixo no código.
- **"Cada tempo (t) equivale a 50 minutos":** sai só no verso do certificado de brigada. É o
  único lugar do sistema em que essa equivalência aparece escrita. Nada é convertido nem
  exibido em horas.

## Onde está no sistema (lote 4)

| O quê | Onde |
|---|---|
| Disciplinas do treinamento (agrupador + linhas teórica/prática, em tempos) | `treinamento_disciplina`, `treinamento_disciplina_linha`; tela: Catálogo, editar o treinamento em tempos. Travam (tipo e tempos) depois da primeira turma; o nome se corrige até o primeiro certificado |
| Nota de cada disciplina (0 a 100) e nota final (média simples, duas casas) | `inscricao_nota_disciplina`; `inscricao.nota_final` com `nota_escala = 100`; tela: aba Presenças da turma |
| Profissão e credenciamento CBMMG do instrutor | `assinatura_instrutor.profissao` e `credenciamento_cbmmg`; tela: Assinaturas |
| Centro de Formação (nome e CNPJ) | parâmetros `brigada.centro_formacao_nome` e `brigada.centro_formacao_cnpj`; tela: Catálogo, "Centro de formação da brigada" |
| Endereço completo do local do curso | cadastro de Locais (`local_treinamento.endereco`) + cidade/UF do campus da turma |
| Local de atuação do brigadista | `inscricao.local_atuacao` (padrão: `turma.local_atuacao_padrao`) |
| Responsável pela formação | `turma.responsavel_formacao_id` (vazio = o primeiro instrutor que assina) |
| Origem e citação da validade | `treinamento.validade_origem` (NORMA / INSTITUCIONAL = "política interna") e `validade_citacao` |
| Modelo "Brigada CBMMG v1" | `modelos-docx/certificados/certificado_brigada_cbmmg_v1.docx`, gerado por `ferramentas/gerar-certificado-brigada.mjs` a partir de `modelos-docx/origem/Modelo_Certificado_Brigadista_Organico_CSSO.docx`; a citação legal da carga é o texto fixo `citacao_legal`, editável na ficha do modelo |
| PDF da brigada (frente e verso) | `src/servicos/certificado_pdf.ts`, `textos_da_brigada` e `desenhar_brigada` |
| Paridade .docx × PDF | `testes/certificado_brigada.test.ts` |
