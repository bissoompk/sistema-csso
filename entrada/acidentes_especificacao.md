# Módulo "Análise de Acidentes" (CAT/SP) no Sistema SISA: análise do legado e especificação

**Data:** 22/10/2026

**Situação:** só análise e especificação. Nada foi editado em `nuvem/`.

**Fontes lidas:**
- Legado em `entrada/catsp/`: `Code.gs` (3.629 linhas), `Index.html` (1.885 linhas), `LISTAS.csv`, `CONFIG.csv`, `cabecalhos.json` e `appsscript.json`.
- Destino em `nuvem/`: `src/modulos.ts`, `servicos/rbac.ts`, `niveis_modulo.ts`, `sementes.ts`, `auditoria.ts`, `pendencias.ts`, `anexos.ts`, `anexo_acesso.ts`, `email.ts`, `epi_*`, `certificado_pdf.ts`, `retificacao.ts`, `inscricao_publica.ts`, `validacao.ts`, `db/esquema/*`, `db/travas.*`, `DESVIOS.md`, `../docs/ROPA.md` e `../docs/POLITICA_RETENCAO.md`.

> **Três achados mudam o desenho.**
> 1. **O módulo já está previsto no SISA.** `modulos.ts` declara `codigo: "acidentes"`, "Análise de Acidentes", com `disponivel: false`, ícone `heart-pulse`. `anexos.ts` já tem as categorias `CAT_SP`, `RELATORIO_INVESTIGACAO` e `EVIDENCIA_ACIDENTE`, todas `RESTRITO` e já presentes na CHECK. `textos.ts` já tem `CONTEXTO_NEXO_OCUPACIONAL`. O tipo de processo `ACIDENTE` já é semeado. A letra **G** de máquina de estados está reservada à ocorrência de acidente. Além disso, **ROPA §1.3/§4.3/§4.4/§9 e POLITICA_RETENCAO §2.4 já fixam** nomes de tabela (`acidente_*`, `acidentado`), nomes de permissão (`acidente.saude_ver`, `acidente.saude_detalhe_ver`, `acidente.saude_registrar`) e regras. **A especificação segue esses nomes.** Por isso o prefixo é `acidente.*`, e não `cat.*`.
> 2. **O legado coleta o que o SISA proíbe:** CPF, RG, data de nascimento, sexo, endereço residencial, telefone pessoal e texto livre de saúde (ROPA §4.3 e §4.5). **Paridade não pode ser literal.** Esses campos saem.
> 3. **A IA do legado (Gemini/OpenAI) bate de frente com a ROPA §5.1.** O texto é: "ligar qualquer API externa exige emenda prévia deste registro"; a preferência é por modelo local; a decisão 6 diz que IA não é prioridade. O mesmo vale para a transcrição por Web Speech API, que no Chrome envia o áudio ao Google.

---

## 1. O que o CAT/SP faz hoje, por fluxo

**Arquitetura.** É um Web App do Apps Script com `access: ANYONE_ANONYMOUS` e `executeAs: USER_DEPLOYING`. Um único SPA (`Index.html`) chama funções do `Code.gs` por `google.script.run`. A base é uma planilha com as abas CONFIG, COMUNICACOES (74 colunas físicas), ANALISES_MAPA (33), PLANO_ACAO (11), ANEXOS (10), RELATORIOS (9), AUDITORIA (6), LISTAS (362 linhas) e USUARIOS (6). Os arquivos ficam no Drive, numa pasta por caso. A versão no código é `3.7.26`; o CONFIG.csv diz `3.7.2024`, provável conversão do Sheets, e o cabeçalho do arquivo diz 3.7.14.

### 1.1 Comunicação

**Quem registra.** Só há dois caminhos de fato:
- **Público sem login**, a tela inicial. Grava `OrigemRegistro = "Comunicante"` e `CriadoPor = "comunicante"`.
- **SST logada**, pela opção "Nova comunicação pela SST". Grava `OrigemRegistro = "Segurança do Trabalho"`.

"Chefia imediata" e "Outro" existem na lista ORIGEM_REGISTRO, mas o código nunca os atribui, e o cliente não pode enviá-los porque são campo de sistema. Também não há servidor logado nem chefia logada.

**Seções do formulário (`renderComunicacaoForm`).** As 5 seções aparecem abertas e recolhíveis, com chips de passo e barra "X% dos obrigatórios".
1. **Servidores envolvidos**, em cartões repetíveis ("+ Adicionar outro servidor").
   - Identificação: nome (obrigatório), sexo, data de nascimento, CPF (só máscara, sem dígito verificador), RG, e-mail, celular, fixo.
   - Endereço completo; padrão UF = MG.
   - Dados funcionais: IdentificacaoUnica, Órgão (padrão UFVJM), Lotação, SIAPE, Cargo, Função.
   - Por envolvido: CondicaoNoAcidente (CONDICAO_ENVOLVIDO), HouveLesao e HouveAfastamentoIndividual.
   - O 1º envolvido é copiado para as colunas planas. Todos vão em `ServidoresEnvolvidosJSON`, mais `QuantidadeServidoresEnvolvidos` e `ServidoresEnvolvidosResumo`. O resumo **inclui CPF** e vai no e-mail.
2. **Acidente.**
   - DataAcidente, HoraAcidente e TipoAcidente são obrigatórios.
   - AposQuantasHorasTrabalho (texto livre), UltimoDiaTrabalho, HouveAfastamento, HouveMorte.
   - ParteCorpoAtingida: seleção múltipla em PARTE_CORPO.
   - Agente causador do acidente, agente causador da doença e situação geradora: datalist pesquisável, que aceita valor fora da lista.
   - Bloco condicional de trânsito/trajeto (BO, número do BO, vítima de terceiros). Aparece por heurística de cerca de 20 palavras e é limpo quando escondido.
   - AtividadeNoMomento.
   - DescricaoAcidente, obrigatória.
3. **Local:** LocalTipo; EspecificacaoLocal (obrigatória); CNPJ (sem validação); Órgão; UF; Município.
4. **Testemunhas e atendimento:**
   - **Exatamente 2 testemunhas fixas**, cada uma com nome, telefone e endereço.
   - Unidade, data e hora do atendimento; internação.
5. **Responsável pela comunicação e anexos:**
   - EmitenteNome e EmitenteEmail são obrigatórios; EmitenteTelefone é opcional.
   - TipoCAT fica oculto e é sempre "Inicial".
   - A declaração de veracidade aparece na tela.
   - **Não há aviso LGPD.**

**Rascunho local** em `localStorage`, com 700 ms de atraso. A restauração é manual e os anexos não entram no rascunho.

**Validação no cliente:** campos obrigatórios e `checkValidity`. Não valida CPF, CEP, data futura nem coerência entre datas.

**No servidor (`saveComunicacao`):**
- Honeypot `_hp_url`.
- Limite de taxa: 20 envios por minuto no total e 5 por `clientId` a cada 10 min. O `clientId` vem do `localStorage`, então é trivial de contornar.
- Valida os anexos e só então toma o ScriptLock de 30 s.
- Número pela função `nextProtocol_`: `CAT-AAAA-NNNN`, onde **N é a contagem de linhas do ano + 1**. Apagar uma linha gera protocolo duplicado.
- Cria a pasta no Drive com o nome `protocolo - NomeServidor - data`, ou seja, **o nome do servidor fica no nome da pasta**.
- Grava os anexos, depois a linha, depois a auditoria `CRIAR_COMUNICACAO`, depois o e-mail à SST.
- **Devolve ao cliente público o registro inteiro**, com as URLs do Drive.
- O formulário público consegue gravar `ObservacoesSST`, porque esse campo não está entre os de sistema.

### 1.2 Anexos e gravações

**Comunicação.** O cliente limita a 6 MB por arquivo. O servidor aceita até 10 anexos, 10 MB cada e 30 MB por envio. O MIME vem **declarado pelo cliente**; são aceitos `image/*`, `audio/*`, `video/webm`, pdf, doc, docx e txt. Tudo vai em base64 numa única chamada, sem barra de progresso. Cada anexo vira uma linha em ANEXOS, com Tipo = "Comunicação".

**Gravação de campo.**
- MediaRecorder grava `audio/webm` numa **janela pop-up** (por causa do iframe do Apps Script), com limite de 6 MB.
- O áudio volta por `postMessage('*')`, **sem conferir a origem**.
- `saveAnaliseAudio` grava com Tipo "Gravação de campo", acrescenta a URL em `GravacoesURLs` e **rebaixa o status para "Em análise SST" sem condição** (bug).
- Também há upload de áudio externo.
- **Transcrição** por Web Speech API (`webkitSpeechRecognition`, pt-BR). Há um bug: `$('TranscricaoEntrevistas')` procura um `id` que não existe, então o texto nunca chega ao campo.
- O aviso "peça autorização antes de gravar" aparece na tela, mas não há registro do consentimento.

### 1.3 Triagem e status

- **STATUS:** Recebida, Em triagem, Aguardando complementação, Em análise SST, Relatório emitido, Encaminhada ao SIASS, Concluída, Cancelada.
- **Não há máquina de estados.** `updateStatus` aceita qualquer valor da lista vindo de qualquer estado (de Cancelada para Recebida, por exemplo) e sobrescreve `ObservacoesSST`.
- **Transições automáticas:**
  - `saveAnalise` passa para "Em análise SST", exceto quando o status já está avançado;
  - `saveAnaliseAudio` e `gerarRelatorio` (que passa para "Relatório emitido") mudam o status **sem essa proteção**, então podem regredir o caso.
- **Não existe tela de triagem.** O que há é o cartão "Status" dentro da tela de análise.

### 1.4 Complementação

Existe só como status. Não há canal para o comunicante complementar nem e-mail pedindo complemento. A SST corrige os dados com "Corrigir dados da comunicação" (`corrigirComunicacao`), que reaproveita o formulário inteiro. A auditoria guarda **só os nomes dos campos**, sem o valor anterior.

### 1.5 Análise MAPA

**Campos de ANALISES_MAPA**, todos texto livre:
- ObjetivoAnalise, EquipeAnalise, TrabalhoHabitual, DiferencaPrescritoReal.
- **LinhaDoTempo** (texto livre, não estruturada).
- Mudanças no Indivíduo, na Tarefa, no Material e no Meio de trabalho.
- **Barreiras** Físicas, Funcionais, Simbólicas, Administrativas e Ausentes.
- RelatosCampo, TranscricaoEntrevistas, GravacoesURLs, Evidências, SinteseExplicativa, AmpliacaoConceitual.
- Selects SIM/NÃO: AmbienteFatorAcidente, CaracterizadoAcidenteServicoSST, RequerAberturaCATSIASS.
- RecomendacoesObservacoes.
- NexoCausalPerito, "reservado ao perito".
- StatusAnalise, Analista, UltimoAutosave, ChecklistCampoJSON.
- RetificacaoRelatorio (errata).

**Autosave.** A cada digitação grava em `localStorage`; depois de 2,5 s sem digitar, chama `saveAnalise(..., _autosave:true)`. O indicador mostra "Salvo automaticamente às HH:MM". Não há controle de concorrência, e **cada autosave gera uma linha de auditoria**. O rascunho local é inútil, porque o servidor o sobrescreve quando o caso é aberto.

**Checklist de campo.** `gerarChecklistCampo` monta uma base fixa (`buildChecklistBaseMAPA_`) com estas seções:
- 0 Preparação, inclusive o consentimento para gravar;
- 1 Trabalho habitual;
- 2 Mudanças;
- 3 Barreiras;
- 4 Sinais de alerta;
- 5 Documentos (PGR, PCMSO, ASO);
- 6 Entrevistas;
- 7 Registros visuais;
- 8 Pontos específicos, escolhidos por expressões regulares sobre o texto do caso: altura, elétrico, máquina, trajeto, químico, corte, fogo, biológico e óbito. Há falsos positivos: "press" casa com "impressora", "moto" com "motorista".

Depois tenta enriquecer a base com IA. Cada item tem `{texto, marcado, obs}`. A lista pode ser salva no caso (`salvarChecklistCampo`, em JSON), impressa ou copiada para "Relatos de campo", e entra no relatório.

### 1.6 Assistente de IA

**Provedores.** Gemini é o padrão: `gemini-2.5-flash`, com fallbacks `2.5-flash-lite`, `2.0-flash-lite` e `2.0-flash`, 3 tentativas por modelo e backoff. A alternativa é OpenAI `gpt-4.1-mini` pela Responses API com `json_schema` estrito. As chaves ficam em Script Properties. As funções `configurar*KeyManual` mandam colar a chave no código, então **ela fica no histórico de versões**.

**Três usos:**
- `gerarSugestaoMapaIA`: preenche 21 campos MAPA e devolve também o plano sugerido (até 8 ações), a coleta mínima, o roteiro de entrevista, as evidências mínimas, as lacunas e os alertas.
- `gerarSugestaoPlanoAcaoIA`: até 10 ações, priorizando engenharia e organização do trabalho.
- `gerarChecklistCampo`.

Nenhum dos três grava nada: o retorno vai à tela, e a substituição ou o acréscimo é confirmado por `confirm()`. A auditoria registra `IA_SUGESTAO_*`.

**O que vai para o provedor.** `redactComunicacaoForAI_` tira CPF, RG, data de nascimento, contatos, endereço, emitente, testemunhas, BO e URLs, e troca o nome por "Servidor 1". Mesmo assim, ainda vão:
- dados de saúde (parte do corpo, agente da doença, afastamento, morte, internação, atendimento);
- quase-identificadores (lotação, cargo, data, hora, local);
- a descrição livre;
- **a análise inteira sem redação**: transcrições, relatos, analista e `GravacoesURLs`;
- o plano atual sem redação;
- os nomes de arquivo.

O padrão "teste gratuito" do Gemini permite ao Google usar os dados.

**Bug.** `extractOpenAIText_` duplica o texto, o que produz JSON inválido.

### 1.7 Plano de ação

- **Colunas:** Achado, Ação, TipoAcao (TIPO_ACAO), Responsável (texto livre), Prazo (data), Prioridade (padrão Média) e Status (STATUS_ACAO, padrão Pendente).
- **`savePlano` apaga todas as linhas do caso e regrava.** O ID muda a cada salvamento, então não há histórico, e não há trava.
- Não há alerta de prazo, evidência de conclusão nem vínculo com usuário.

### 1.8 Relatório

**`gerarRelatorio`.** Toma o ScriptLock, reserva a versão `max+1` com a observação "Em geração…" e cria um **Google Docs** a partir do código. O documento leva capa com logos da UFVJM e da DASA em base64, cabeçalho e rodapé, e 21 seções:
- finalidade e retificações;
- identificação;
- **servidor com nome, sexo, data de nascimento, CPF, RG, e-mail, telefones e SIAPE**;
- demais envolvidos;
- acidente; trânsito; local; descrição; atendimento; testemunhas;
- metodologia; evidências com URL; trabalho habitual; linha do tempo; mudanças; barreiras; relatos, transcrição, gravações e checklist;
- ampliação; síntese; conclusão técnica; recomendações; plano; assinatura.

**Saída.** Exporta PDF, grava em RELATORIOS (versão, Doc, PDF, link de download) e passa o caso para "Relatório emitido".

**Defeitos:**
- **`shareReportFilesForDownload_` deixa o Doc e o PDF como "qualquer pessoa com o link"**. É o risco de LGPD mais grave do legado.
- O Doc continua editável depois de emitido.
- A assinatura é o login "sest".
- Retificar é só um campo de texto, que se repete nas versões seguintes.
- Quando a geração falha, os arquivos ficam órfãos no Drive.

### 1.9 SIASS

**Não há integração.** Existem o status "Encaminhada ao SIASS", o select "Requer abertura de CAT/SP no SIASS?" e o campo de nexo do perito. Não há data de envio, número da CAT no SIASS nem registro da decisão pericial.

### 1.10 Notificações por e-mail

- **Um único e-mail de negócio:** `notifySST_`, enviado para `sest@ufvjm.edu.br` (configurável na aba CONFIG, que qualquer editor da planilha altera) quando a comunicação é criada.
- **Conteúdo:** protocolo, tipo, data, local, emitente, **resumo dos envolvidos com CPF e SIAPE** e a **descrição completa**.
- **Ninguém mais recebe nada:** nem o comunicante, nem o servidor, nem o responsável pela ação.
- `enviarEmailTesteSST` fica exposta sem token.

### 1.11 Perfis e usuários

- **Uma conta compartilhada**, login `sest`, perfil fixo `SST_ADMIN`.
- **Senha:**
  - hash SHA-256 de uma única iteração com salt, em Script Properties;
  - **a senha inicial fica em texto claro** em `UFVJM_CAT_ADMIN_INITIAL_PWD` e no `Logger`;
  - a troca obrigatória não é imposta no servidor;
  - `alterarSenhaSST` não exige token e não derruba as sessões abertas.
- **Sessão:** token de 2 UUIDs, válido por 6 h com renovação a cada uso.
- **Sem limite de tentativas** de login.
- **A aba USUARIOS está órfã:** nada no código a lê.
- **Sem tela de usuários e sem tela de auditoria.**

### 1.12 Auditoria

- **Aba AUDITORIA** (DataHora, Usuário, Ação, Protocolo, Detalhes). É editável, não tem encadeamento e `audit_` engole os próprios erros.
- **O usuário registrado é sempre "sest"**, então não há responsabilização individual.
- **Eventos:** SETUP, LOGIN_*, ALTERAR_SENHA, RATE_LIMIT_*, SPAM_HONEYPOT, CRIAR/CORRIGIR_COMUNICACAO, ALTERAR_STATUS, SALVAR_ANALISE, SALVAR_GRAVACAO_CAMPO, SALVAR_PLANO_ACAO, CHECKLIST_CAMPO, SALVAR_CHECKLIST_CAMPO, IA_SUGESTAO_*, CONFIG_*_KEY, GERAR_RELATORIO_*, EMAIL_*.

### 1.13 Anti-abuso e funções expostas

O anti-abuso é honeypot mais o limite de taxa. Não há captcha.

**Risco crítico:** toda função de topo sem `_` no nome é chamável por anônimo, e várias fazem estrago:
- `diagnosticoInstalacao` e `setup` **devolvem a senha inicial**;
- `getBootstrapJson` expõe `spreadsheetId` e roda `setup()`;
- `removerGeminiKey` e `definirProvedorIA*` alteram a configuração de IA;
- `testarIntegracao*` consome cota;
- `enviarEmailTesteSST` envia e-mail;
- `alterarSenhaSST` vira oráculo de senha.

Outros riscos:
- Injeção de fórmula na planilha, porque `appendRow` recebe valores que começam com "=".
- O registro inteiro com CPF vai a `listComunicacoes`.
- A busca por `JSON.stringify` casa com os nomes das chaves.

### 1.14 Limites e pastas no Drive

- Uma pasta raiz fixa e uma subpasta por caso (comunicação, gravações, relatório Doc e PDF).
- Limites: 10 anexos, 10 MB por arquivo, 30 MB por envio, 6 MB no cliente e no áudio.
- Não há gatilhos de tempo, painel de indicadores, exportação nem paginação. O painel tem 4 contadores calculados por substring no cliente.

### 1.15 Listas: comparação entre `LISTAS.csv` e `LISTS` do `Code.gs`

**São idênticas byte a byte:** 15 listas, 362 itens, mesma ordem e mesma grafia, inclusive nos erros. A explicação é que `seedLists_` regrava a aba a partir do código a cada setup.

| Lista | Itens | Observação |
|---|---|---|
| SIM_NAO | 2 | SIM; NÃO |
| CONDICAO_ENVOLVIDO | 9 | Servidor acidentado; Servidor envolvido sem lesão; Condutor; Passageiro; Pedestre; Ciclista; Motociclista; Testemunha envolvida; Outro |
| STATUS | 8 | ver §1.3 |
| ORIGEM_REGISTRO | 4 | Comunicante; Segurança do Trabalho; Chefia imediata; Outro |
| TIPO_CAT | 2 | Inicial; Reabertura |
| SEXO | 4 | (não será migrada; ROPA §4.3) |
| TIPO_ACIDENTE | 5 | Típico; Trajeto; Doença relacionada ao trabalho; Incidente / quase acidente; Outro |
| LOCAL_TIPO | 10 | Estabelecimento da UFVJM; Via interna; Estacionamento; Portaria/acesso; Carga e descarga; Laboratório; Hospital/serviço de saúde; Via pública; Área rural; Outro |
| PARTE_CORPO | 44 | "N. DESCRIÇÃO (detalhe)", com N de 1 a 44 |
| AGENTE_CAUSADOR_ACIDENTE | 199 | "N. ITEM - GRUPO" |
| AGENTE_CAUSADOR_DOENCA | 30 | sem número |
| SITUACAO_GERADORA | 30 | sem número |
| TIPO_ACAO | 9 | Engenharia/proteção coletiva; Organização do trabalho; Sinalização; Manutenção; Procedimento; Treinamento/orientação; EPI; Gestão/planejamento; Outra |
| PRIORIDADE | 3 | Alta; Média; Baixa |
| STATUS_ACAO | 4 | Pendente; Em andamento; Concluída; Cancelada |

**Divergências e defeitos que o SISA precisa tratar:**
1. **Entre o CSV e o código: nenhuma divergência.**
2. **Os números das listas são índices sequenciais embutidos no texto, não códigos oficiais.** Faltam os códigos da NBR 14280, os das Tabelas I a IV da CAT/SP e os das Tabelas 13 a 15 do eSocial. No SISA o número vira coluna `ordem` e o texto sai sem o prefixo "N. ". Uma coluna `codigo_oficial` fica opcional, para preencher depois.
3. **Erros de grafia:** SUSBSTÂNCIA, INGESTAO, MANDIBULA, MULTIPLAS, MUSCULO, MASARICO, DESLISANTE, "TORQUES, TENAZ- " sem espaço, "BRAÇO (entre o punho a o ombro)".
4. **Itens truncados ou defeituosos:** agente 108 termina em vírgula; 134 tem "?" no lugar do hífen; 165 está cortado ("…TRICLORETILENO, A"); 127 usa travessão "–".
5. **Recomendação:** semear com a grafia corrigida e guardar `rotulo_legado` para casar a migração.
6. **Duplicações conceituais:** "Esforço excessivo…" e "Inalação/ingestão/absorção…" aparecem em AGENTE_CAUSADOR_DOENCA e em SITUACAO_GERADORA. É herança da norma; mantém-se.
7. **Falta a lista "natureza da lesão",** que a ROPA §4.4 exige no nível 1. Precisa ser fornecida; ver a decisão D11.
8. **A palavra "DOENÇA" aparece em rótulos de catálogo**, como "Doença relacionada ao trabalho" e "COM TRANSMISSÃO DE DOENÇA". O filtro RN-21 só vale para texto livre, então o catálogo semeado não passa por ele. Mas a descrição do acidente passa a usar `CONTEXTO_NEXO_OCUPACIONAL`, que dispensa "doença" só nos campos narrativos de ocorrência e investigação.

**Colunas renomeadas no legado:** `CriadoPorEmail` virou `CriadoPor`, `AnalistaEmail` virou `Analista` e `Email` (da AUDITORIA) virou `Usuario`. Os registros antigos guardam o autor na coluna velha, e a migração precisa juntar os dois campos.

**CONFIG.csv:** o cabeçalho está fundido na primeira linha. Não contém segredos, só os IDs da planilha e da pasta.

---

## 2. Paridade item a item (legado → SISA)

Legenda: **R** = reaproveita o que o SISA já tem; **N** = novo; **M** = muda de propósito (melhoria ou exigência da LGPD); **X** = não será portado.

| # | Legado | SISA | Tipo |
|---|---|---|---|
| 1 | Comunicação pública sem login | Formulário por **link com token** no padrão `/inscricao/:token`, com honeypot, limite por IP antes de olhar o token, teto de pedidos em espera, resposta sem oráculo, POST-redirect-GET e cookie de recebido. Ver D1 | R + N |
| 2 | Comunicação pela SST | `/acidentes/comunicar` logado, para quem tem `acidente.comunicar` | N |
| 3 | (não existia) servidor logado comunica | O mesmo formulário via `PERMISSOES_DO_TITULAR`. O acidentado vem preenchido a partir de `usuario.servidor_id` | N |
| 4 | Origem "Chefia imediata" nunca usada | Campo `origem` atribuído pelo servidor (titular, chefia declarada, SST ou público). Não existe chefia modelada no SISA: ver D9 | M |
| 5 | Vários servidores envolvidos (JSON numa célula) | Tabela `acidentado`, uma linha por envolvido, com `servidor_id` (autocompletar por SIAPE ou nome a partir de `servidor`) **ou** identificação externa (`participante_id` ou nome mais matrícula ou crachá) | R + M |
| 6 | Nome, sexo, data de nascimento, CPF, RG, endereço, e-mail e telefones pessoais | **Não entram** (ROPA §4.3/§4.5). Do servidor cadastrado vem o *snapshot* de cargo, função, lotação (`unidade_uorg`), campus e SIAPE. Para o externo, só nome, identificação externa, vínculo, empresa e contato institucional para a investigação | X / R |
| 7 | Lotação, cargo, função digitados | Congelados de `servidor` e `servidor_lotacao` no ato | R |
| 8 | Duas testemunhas fixas, com endereço | Tabela `acidente_testemunha`, com N linhas, nome, vínculo e contato. **Sem endereço** | M |
| 9 | Emitente (nome, e-mail, telefone) | Comunicante: conta logada ou nome mais e-mail mais vínculo (público). Base legal pendente (ROPA §9, item 5) | M |
| 10 | Parte do corpo, houve afastamento, morte, internação, atendimento | Tabela própria `acidente_saude` (ROPA §4.4) em 2 níveis com permissões próprias e acesso registrado com finalidade escolhida antes. Ver D4 sobre o que o comunicante pode declarar | M |
| 11 | Agente causador, agente da doença, situação geradora (datalist livre) | Catálogos fechados semeados (FK), sem texto livre | R (sementes) + N |
| 12 | Descrição e atividade (texto livre) | Texto com `exigir_texto_limpo` e `CONTEXTO_NEXO_OCUPACIONAL`. CPF é mascarado pelo `formulario()`; CID é recusado | R |
| 13 | Bloco de trânsito por heurística | Condicional declarativo (`data-mostra-quando`) pela espécie "Trajeto" ou pelo tipo de local "Via pública/Via interna/Estacionamento". Sem lista de palavras | R |
| 14 | Anexos de 10 MB, 30 MB por envio, MIME declarado | `anexos.guardar` com **4 MB por arquivo** (limite da função Netlify), SHA-256 e dedup, categoria `EVIDENCIA_ACIDENTE` (RESTRITO). Conferência pelos bytes no padrão `epi_catalogo_anexos` (`eh_pdf`, `conferir_imagem`); **foto de lesão é proibida**. Resolvedor novo em `anexo_acesso.ts`. Um arquivo por requisição | R + M |
| 15 | Pasta no Drive por caso | Não existe. Os bytes vão para o Supabase Storage privado, chave `anexos/<sha>`, e o nome não carrega dado pessoal | R |
| 16 | Status livre | Máquina **G** em `dominio/estados.ts` (`TRANSICOES_ACIDENTE` e `exigir_transicao_acidente`), com eventos na trilha. A retificação não regride o estado | R + M |
| 17 | Complementação (só status) | Ato "pedir complementação" com texto do que falta e pendência para o responsável. O comunicante logado vê o pedido em "Minhas comunicações" e responde por um formulário curto. O público recebe e-mail só se D6 permitir. A resposta vira versão nova da CAT/SP | N |
| 18 | Corrigir comunicação (sobrescreve) | **Retificação**: a CAT/SP é versionada e append-only (`acidente_cat_sp`). A correção gera versão N+1 com motivo e `substitui_id`, no padrão `retificacao.ts`. "Não existe caminho de edição nem de exclusão" (POLITICA §2.4) | R + M |
| 19 | Análise MAPA (texto livre) | `acidente_investigacao` com os mesmos campos MAPA mais linha do tempo estruturada (`acidente_evento_linha`) e barreiras estruturadas (`acidente_barreira`: tipo, situação, descrição). O nexo vai para `acidente_decisao_pericial` (é do perito) | R + M |
| 20 | Autosave no servidor a cada 2,5 s | Rascunho local do `csso.js` (`data-rascunho-local` com `data-rascunho-versao`) **mais** salvamento explícito com controle otimista (`versao`). Uma auditoria por salvamento, com `registrar_diferencas` | R + M |
| 21 | Checklist de campo (base fixa mais IA) | Base fixa portada para código (`acidente_checklist.ts`) com as seções 0–8 e regras específicas por **espécie, tipo de local e agente de catálogo** em vez de regex sobre texto. Itens persistidos em linhas, impressão por `data-imprimir` | R + M |
| 22 | Gravação de áudio em pop-up | `public/estaticos/js/gravador.js` (MediaRecorder na própria página, porque não há iframe, CSP `self`). Envio como anexo de áudio de até 4 MB (cerca de 15 min em opus), ligado a `acidente_entrevista` com **consentimento registrado** (quem consentiu, quando, quem registrou) | N |
| 23 | Transcrição por Web Speech API | **Não portar** (envia áudio ao Google: ROPA §5.1). Transcrição digitada no campo `relato` da entrevista | X |
| 24 | Assistente de IA (Gemini/OpenAI) | **Fora da v1** (ROPA §5.1, decisão 6). No lugar dele: checklist determinístico, textos de ajuda "(i)" (`ui.info`) e roteiro de entrevista fixo. Ver D2 | X / M |
| 25 | Plano de ação (apaga e regrava) | `acidente_acao` com ID estável, responsável `usuario_id` (ou unidade mais nome livre), prazo `DataPura`, estado com transição, evidência de conclusão (anexo), **pendência por ação** com prazo, cancelamento com motivo e nunca delete | R + N |
| 26 | Relatório em Google Docs, PDF público por link | PDF gerado no próprio sistema com **pdf-lib**, no molde de `certificado_pdf.ts`, a partir de **contexto congelado** com hash. Duas variantes: completa (SIASS) e **sem saúde** (contratada e fiscal, ROPA §5). Download só por `anexo_acesso`, com leitura registrada. Ver D3 | R + M |
| 27 | Versões do relatório e errata | `acidente_relatorio` append-only, retificação com motivo e `substitui_id`. A versão anterior continua legível e marcada como "retificada" | R |
| 28 | Assinatura "sest" | Nome do emissor (usuário individual) e, se aplicável, registro profissional (`profissional_habilitado`). Assinatura oficial continua no SEI | R |
| 29 | Encaminhamento ao SIASS (só status) | `acidente_encaminhamento` (data, meio, NUP SEI, versão enviada) e `acidente_decisao_pericial` (resultado, data, número da CAT no SIASS, observação sem a palavra "doença") | N |
| 30 | E-mail à SST com CPF e descrição | `email.enfileirar` na transação, no padrão `epi_email.ts`: **só protocolo, o que aconteceu e o link**. Flag `CSSO_ACIDENTE_EMAIL=sim`, destino do setor por variável de ambiente. Ver D6 | R |
| 31 | Conta única "sest" | Contas individuais do SISA (Argon2id, bloqueio após 5 tentativas, sessão revogável) e RBAC por perfil com níveis por módulo | R |
| 32 | Auditoria em planilha | `auditoria.registrar` (encadeada por hash, append-only, conferida toda noite) e `acesso_dado_sensivel` | R |
| 33 | Funções expostas, senha em claro | Inexistente por construção: cada rota faz `usuario.exigir(...)` e o CSRF é por origem | R |
| 34 | Painel com 4 contadores | Hub de cartões (`acoes-hub`/`acao-hub`, `grade-resumo`) e fila paginada com filtros. Nenhum número sem link para a lista | R + N |
| 35 | (não existia) indicadores | `/acidentes/indicadores` com série por ano, espécie, campus e unidade, supressão n<5 (RN-19) e CSV com `neutralizar_formula`. TF/TG dependem de horas-homem trabalhadas; ver D12 | N |
| 36 | (não existia) prazo do art. 214 | Pendência `ACIDENTE_PRAZO_COMUNICACAO` com prazo de data do evento + 10 dias, varrida na rotina noturna | R + N |
| 37 | (não existia) Meu espaço | "Minhas comunicações de acidente" em `MEU_ESPACO_GRUPOS`. O titular vê a própria ocorrência inteira, inclusive a saúde (ROPA §7). Eventos em `EVENTOS_DO_TITULAR` ("Minha atividade") | R |
| 38 | (não existia) cruzamento com EPI | Na ficha da ocorrência, link para a ficha de EPI do acidentado (leitura registrada por `exigir_leitura_da_ficha`) | R |
| 39 | Celular (folha inferior, 44 px) | `table.empilhavel` com `data-coluna`, `details.recolhido`, campos de 16 px ou mais, `inputmode`, sem rolagem lateral a 360 px | R |
| 40 | ≈28 registros na planilha | Ferramenta de importação única (`ferramentas/importar-catsp.ts`), executada localmente. Ver D5 | N |

---

## 3. Esquema, permissões, eventos, pendências, rotas, telas e LGPD

### 3.1 Domínio (`src/dominio/acidente.ts`): tuplas, rótulos e máquina G

**Estados da ocorrência (máquina G):**
- `RECEBIDA` → `EM_TRIAGEM` | `CANCELADA`
- `EM_TRIAGEM` → `AGUARDANDO_COMPLEMENTACAO` | `EM_INVESTIGACAO` | `CANCELADA`
- `AGUARDANDO_COMPLEMENTACAO` → `EM_TRIAGEM` (resposta recebida ou retomada pela SST) | `CANCELADA`
- `EM_INVESTIGACAO` → `RELATORIO_EMITIDO`. O primeiro relatório emitido faz a transição sozinho. A retificação **mantém** o estado.
- `RELATORIO_EMITIDO` → `ENCAMINHADA_SIASS` | `CONCLUIDA` (quando não requer CAT/SP no SIASS, com motivo)
- `ENCAMINHADA_SIASS` → `CONCLUIDA` (exige decisão pericial registrada **ou** motivo de conclusão sem decisão)
- Finais: `CONCLUIDA` e `CANCELADA`. Cancelar exige motivo, de uma lista fechada mais texto: duplicada, comunicação indevida, não é acidente em serviço, outro.
- Reabertura: em vez de voltar o estado, cria uma ocorrência nova com `tipo_cat = REABERTURA` e `reabre_id`, como no TIPO_CAT do legado.

**Tuplas:**

| Tupla | Valores |
|---|---|
| `ESPECIES` | TIPICO, TRAJETO, DOENCA_TRABALHO (rótulo "Doença relacionada ao trabalho"), INCIDENTE (rótulo "Incidente / quase acidente"), OUTRO |
| `TIPOS_CAT` | INICIAL, REABERTURA |
| `ORIGENS` | TITULAR, CHEFIA, SST, PUBLICO, MIGRACAO |
| `LOCAIS_TIPO` | Os 10 do legado (ESTABELECIMENTO_UFVJM, VIA_INTERNA, ESTACIONAMENTO, PORTARIA, CARGA_DESCARGA, LABORATORIO, SERVICO_SAUDE, VIA_PUBLICA, AREA_RURAL, OUTRO) |
| `CONDICOES_ENVOLVIDO` | Os 9 do legado (ACIDENTADO, ENVOLVIDO_SEM_LESAO, CONDUTOR, PASSAGEIRO, PEDESTRE, CICLISTA, MOTOCICLISTA, TESTEMUNHA_ENVOLVIDA, OUTRO) |
| `VINCULOS_ACIDENTADO` | SERVIDOR, TERCEIRIZADO, ESTUDANTE, BOLSISTA, RESIDENTE, VISITANTE, OUTRO (ROPA §3) |
| `SIM_NAO_NAO_SEI` | SIM, NAO, NAO_SABE (o comunicante pode não saber) |
| `TIPOS_ACAO` | Os 9 do legado |
| `PRIORIDADES` | ALTA, MEDIA, BAIXA |
| `ESTADOS_ACAO` | PENDENTE, EM_ANDAMENTO, CONCLUIDA, CANCELADA (transições: P→EA→C; P/EA→X com motivo) |
| `TIPOS_BARREIRA` | FISICA, FUNCIONAL, SIMBOLICA, ADMINISTRATIVA |
| `SITUACOES_BARREIRA` | EXISTIA_FUNCIONOU, EXISTIA_FALHOU, AUSENTE (substitui "Barreiras ausentes" como coluna) |
| `DIMENSOES_MUDANCA` | INDIVIDUO, TAREFA, MATERIAL, MEIO |
| `CARACTERIZACAO` | SIM, NAO, INCONCLUSIVO (parecer técnico da CSSO, não nexo) |
| `RESULTADOS_PERICIA` | ACIDENTE_EM_SERVICO_RECONHECIDO, NAO_RECONHECIDO, OUTRO |
| `MEIOS_ENCAMINHAMENTO` | SEI, SIASS_SISTEMA, EMAIL_INSTITUCIONAL, PRESENCIAL |
| `FINALIDADES_SAUDE` | INVESTIGACAO, CLASSIFICACAO_GRAVIDADE, INSTRUCAO_PERICIA, ATENDIMENTO_AO_TITULAR, AUDITORIA (lista fechada, escolhida antes de ver) |
| `LATERALIDADES` | DIREITA, ESQUERDA, BILATERAL, NAO_SE_APLICA |

### 3.2 Tabelas

Arquivo `src/db/esquema/acidente.ts`, reexportado em `index.ts`, com relações em `relacoes.ts`. Convenções: `id` identity, enums como varchar com CHECK `lista_sql(TUPLA)`, `MomentoUTC`, `DataPura`, `*_por` como FK de `usuario`, constraints nomeadas (`fk_`, `ck_`, `uq_`, `ix_`).

**Catálogos semeados** (por `semear_acidentes` em `sementes.ts`, idempotente, com `ativo` e sem delete): `acidente_parte_corpo` (44), `acidente_agente_causador` (199, com `grupo` separado do texto), `acidente_agente_doenca` (30), `acidente_situacao_geradora` (30) e `acidente_natureza_lesao` (lista pendente, D11).
- Colunas: `id`, `ordem`, `rotulo` (grafia corrigida), `rotulo_legado`, `codigo_oficial` (anulável), `ativo`.
- Os catálogos curtos (espécie, local, condição, tipo de ação) ficam como tuplas em código.

**Núcleo:**

| Tabela | Colunas principais | Regras |
|---|---|---|
| `acidente_cat_sp_sequencia` | `ano` PK, `ultimo_numero` | Entra em `numeracao.SEQUENCIAS`; `proximo_numero_cat_sp` |
| `acidente_ocorrencia` | `id`, `protocolo` (`CAT-AAAA-NNNN`, D7), `ano`, `numero` (uq ano+numero, CHECKs de coerência como em `epi_requisicao`), `estado` (G), `especie`, `tipo_cat`, `reabre_id`, `origem`, `data_evento` DataPura, `hora_evento`, `minutos_apos_inicio_jornada` int, `ultimo_dia_trabalho`, `local_tipo`, `local_especificacao`, `campus_id` (FK, escopo E), `local_unidade_uorg_id`, `local_municipio`, `local_uf`, `local_cnpj_contratada`, `transito_registro_policial` (S/N/NS), `transito_numero_bo`, `transito_vitima_terceiros`, `agente_causador_id`, `agente_doenca_id`, `situacao_geradora_id` (FKs de catálogo), `servidor_id` (acidentado principal, para `aplicar_escopo` no escopo P), `responsavel_id` (usuário da CSSO que conduz), `prazo_comunicacao` (data_evento + 10), `cancelamento_motivo`/`_texto`, `concluida_em`, `criado_por` (anulável no público), `criado_em`, `versao` | Sem delete por trigger. UPDATE só nas colunas de trâmite (`estado`, `responsavel_id`, `cancelamento_*`, `concluida_em`, `versao`). Os fatos do evento só mudam por retificação, que gera uma CAT/SP nova e atualiza as colunas espelho na mesma transação; a trigger confere que existe versão de CAT/SP mais nova |
| `acidente_cat_sp` | `id`, `ocorrencia_id`, `versao` (uq ocorrencia+versao), `contexto_congelado` jsonb (fatos do evento, acidentados, testemunhas, comunicante, declarações de saúde **em chave separada**), `hash_conteudo`, `motivo_retificacao` (obrigatório se versao>1), `substitui_id`, `origem` (COMUNICACAO, COMPLEMENTACAO, RETIFICACAO_SST, MIGRACAO), `registrada_por`, `registrada_em` | **Append-only** (3 triggers `trg_acidente_cat_sp_sem_update/delete/truncate`). Guarda permanente |
| `acidentado` | `id`, `ocorrencia_id`, `ordem`, `vinculo`, `servidor_id` (anulável), `participante_id` (anulável), `nome_externo`, `identificacao_externa` (matrícula ou crachá; CHECK contra padrão de CPF via `check_regex`), `empresa_contratada`, `fiscal_contrato_servidor_id`, `condicao`, `houve_lesao` (S/N/NS), snapshot `cargo_id`/`funcao`/`unidade_uorg_id`/`campus_id`/`siape`, `contato_investigacao` (e-mail institucional ou ramal) | CHECK de exatamente uma identificação (servidor, participante ou nome externo). Sem delete. Permanente |
| `acidente_testemunha` | `id`, `ocorrencia_id`, `nome`, `vinculo`, `servidor_id` (anulável), `contato` | Sem delete; correção por retificação da CAT/SP |
| `acidente_comunicante` | `ocorrencia_id` PK, `usuario_id` (anulável), `nome`, `email`, `vinculo`, `declarou_veracidade_em`, `ip` (público; expurgo em 90 dias pela rotina, como `ip_inscricao`) | Base legal pendente (ROPA §9.5) |
| `acidente_saude` | `id`, `acidentado_id` (uq), **nível 1**: `natureza_lesao_id`, `lateralidade`, `houve_atendimento`, `houve_afastamento`, `houve_internacao`, `houve_obito`, `houve_sequela`; **nível 2**: `dias_afastamento`, `afastamento_inicio`, `afastamento_retorno`, `dias_internacao`, `data_obito`, `dias_debitados`, `primeiro_socorro_por`, `primeiro_socorro_unidade`, `atendimento_em`; `origem` (DECLARADO_COMUNICANTE \| REGISTRADO_MEDICO), `registrado_por`, `registrado_em`, `detalhe_expurgado_em`, `versao` | Partes do corpo em `acidente_saude_parte` (N:N com catálogo). Leitura por **serviço único** `acidente_saude.ler(tx, usuario, acidentado_id, nivel, finalidade)`. UPDATE só por `acidente.saude_registrar`, com diff na trilha; sem delete; o expurgo do nível 2 é ato manual com simulação (POLITICA §2.4) |
| `acidente_investigacao` | `ocorrencia_id` PK, `responsavel_id`, `equipe` (texto), `objetivo`, `trabalho_habitual`, `prescrito_real`, `mudanca_individuo`, `mudanca_tarefa`, `mudanca_material`, `mudanca_meio`, `relatos_campo`, `evidencias_texto`, `sintese`, `ampliacao_conceitual`, `ambiente_fator` (S/N), `caracterizacao` (SIM/NAO/INCONCLUSIVO), `requer_cat_siass` (S/N), `recomendacoes`, `versao` (controle otimista), `atualizado_por`, `atualizado_em` | Editável até haver relatório; depois, edição só para nova versão do relatório (retificação). Sem delete |
| `acidente_evento_linha` | `id`, `ocorrencia_id`, `momento` (data e hora ou rótulo relativo, "T-10min"), `descricao`, `ordem`, `ativo` | Linha do tempo estruturada; desativar em vez de apagar |
| `acidente_barreira` | `id`, `ocorrencia_id`, `tipo`, `situacao`, `descricao`, `ativo` | — |
| `acidente_checklist_item` | `id`, `ocorrencia_id`, `secao`, `ordem`, `texto`, `marcado`, `observacao`, `origem` (BASE \| ESPECIFICO \| MANUAL), `ativo` | Gerado da base no 1º acesso |
| `acidente_entrevista` | `id`, `ocorrencia_id`, `entrevistado_nome`, `entrevistado_vinculo`, `realizada_em`, `entrevistadores`, `relato` (texto, restrito), `consentiu_gravacao` bool, `consentimento_registrado_por`, `anexo_audio_id` (FK `anexo`) | CHECK: áudio só se `consentiu_gravacao`. Permanente e restrito |
| `acidente_evidencia` | `id`, `ocorrencia_id`, `anexo_id`, `descricao`, `citada_no_relatorio` (marcada na emissão) | Não citada: 5 anos (POLITICA §2.4) |
| `acidente_unidade_exposicao` | `id`, `ocorrencia_id`, `unidade_uorg_id`, `posto_trabalho_id`, `inicio`, `fim` | Só para DOENCA_TRABALHO |
| `acidente_acao` | `id`, `ocorrencia_id`, `numero` (sequencial no caso), `achado`, `acao`, `tipo_acao`, `responsavel_usuario_id`, `responsavel_unidade_uorg_id`, `responsavel_texto`, `prazo` DataPura, `prioridade`, `estado`, `conclusao_texto`, `conclusao_anexo_id`, `concluida_em`, `cancelamento_motivo`, `criada_por`, `criada_em`, `versao` | Sem delete. Mudanças com diff (RN-14). Permanente |
| `acidente_relatorio` | `id`, `ocorrencia_id`, `versao`, `variante` (COMPLETA \| SEM_SAUDE), `contexto_congelado` jsonb, `hash_conteudo`, `anexo_id` (PDF, categoria `RELATORIO_INVESTIGACAO`), `motivo_retificacao`, `substitui_id`, `emitido_por`, `emitido_em` | **Append-only**. As duas variantes da mesma versão saem no mesmo ato |
| `acidente_encaminhamento` | `id`, `ocorrencia_id`, `relatorio_id`, `meio`, `nup_sei` (máscara NUP já existente), `encaminhado_em`, `encaminhado_por`, `observacao` | Append-only |
| `acidente_decisao_pericial` | `id`, `ocorrencia_id`, `resultado`, `decidida_em`, `numero_cat_siass`, `observacao` (RN-21 **sem** a dispensa de "doença"), `registrada_por`, `registrada_em`, `substitui_id` | Append-only; correção gera nova linha |
| `acidente_link_publico` | `id`, `campus_id` (ou geral), `token_sha256`, `ativo`, `gerado_por`, `gerado_em`, `desligado_em` | No padrão `gerar_link`/`desligar_link`; só existe se D1 escolher o link |

**Ajustes em tabelas existentes:**
- `acesso_dado_sensivel` ganha `acidentado_id` (ROPA §9.6), para registrar "sobre quem" quando o acidentado não é servidor.
- `pendencia` não muda; usa a âncora genérica `entidade`/`entidade_id`.

**Travas** (`travas.sql`, espelhadas em `travas.ts`):
- append-only em `acidente_cat_sp`, `acidente_relatorio`, `acidente_encaminhamento` e `acidente_decisao_pericial`;
- sem delete em `acidente_ocorrencia`, `acidentado`, `acidente_testemunha`, `acidente_saude`, `acidente_acao` e `acidente_entrevista`;
- colunas congeladas em `acidente_ocorrencia` (os fatos do evento só mudam junto com uma CAT/SP nova);
- `acidente_saude`: o nível 2 só pode ir para NULL quando `detalhe_expurgado_em` é preenchido na mesma linha.

**Migração:** `0017_acidentes.sql` (ou o número seguinte livre, depois do Portal do servidor). É uma única migração com todas as tabelas, gerada por `npm run db:gerar`.

### 3.3 Permissões e níveis do módulo

| Permissão | O que libera | Onde entra |
|---|---|---|
| `acidente.comunicar` | Registrar comunicação logado e responder complementação da própria | `MODULOS_NIVELADOS.acidentes.escrita` **e** `PERMISSOES_DO_TITULAR` (todo servidor com conta comunica) |
| `acidente.ver` | Hub, fila e ficha (sem saúde) | `consulta`; titular em escopo P (vê as próprias) |
| `acidente.triar` | Assumir, mudar estado, pedir complementação, cancelar, retificar a CAT/SP, gerar e desligar o link público | `escrita` |
| `acidente.investigar` | MAPA, checklist, linha do tempo, barreiras, entrevistas, evidências e plano de ação | `escrita` |
| `acidente.siass` | Registrar encaminhamento e decisão pericial; concluir | `escrita` |
| `acidente.relatorio_emitir` | Emitir e retificar o relatório técnico | `PERMISSOES_SO_DO_PERFIL` (é ato técnico assinado; segue o cargo, como assinatura e habilitação) |
| `acidente.saude_ver` | Nível 1 | `PERMISSOES_SO_DO_PERFIL` (ROPA §4.4) |
| `acidente.saude_detalhe_ver` | Nível 2 | `PERMISSOES_SO_DO_PERFIL` |
| `acidente.saude_registrar` | Registrar e corrigir saúde | `PERMISSOES_SO_DO_PERFIL` |
| (existentes) `indicador.ver` e `exportar` | Indicadores e CSV | Já são só do perfil |

```ts
// niveis_modulo.ts, entrada nova em MODULOS_NIVELADOS
{ codigo: "acidentes", nome: "Análise de Acidentes",
  consulta: ["acidente.ver"],
  escrita: ["acidente.comunicar", "acidente.triar", "acidente.investigar", "acidente.siass"] }
```

**Matriz de perfis proposta** (D10):
- `coordenador_csso` e `superintendente` (derivado): todas.
- `engenheiro_seguranca` e `tecnico_seguranca`: ver, comunicar, triar, investigar, siass, relatorio_emitir e saude_ver.
- `medico_trabalho`: ver, comunicar, siass, saude_ver, saude_detalhe_ver e saude_registrar.
- `secretaria_csso`: ver, comunicar, triar (sem saúde).
- `auditor_interno` (S): ver, sem saúde.
- `consulta_progep`: nada (a decidir).
- `servidor_consulta` (P): comunicar e ver.
- `admin_ti`: nada.
- `almoxarife_sesmt`: comunicar.

**Pontos a tocar** (todos compartilhados):
- `rbac.ts`: `PERMISSOES` (descrição ASCII), `GRUPOS_PERMISSAO_TELA` (grupo "Acidentes", cada chave uma única vez), `MATRIZ_PERFIS`, `PERMISSOES_COORDENADOR`, `MODULO_POR_PERMISSAO` (`"ACIDENTES"`), `PERMISSOES_DO_TITULAR` e `PERMISSAO_DE_LEITURA_POR_TABELA`.
- `niveis_modulo.ts`.
- `pendencias.PERMISSOES_VER`.
- `modulos.ts`: `disponivel: true`, `itens`, `itens_previstos: []`, Meu espaço.
- **Testes que cobram:** `rbac.test.ts`, `niveis_modulo.test.ts`, `sementes.test.ts`, `correcoes_base.test.ts:468`, `modulos.test.ts:91` (conjunto de previstos passa a {CISSP, PGR}), `correcoes_visual.test.ts:104` e `test_link_no_menu_sempre_abre`.

### 3.4 Eventos de auditoria

Todos em `MAIUSCULO`, com até 40 caracteres e entidade `acidente_ocorrencia`, salvo indicação.

| Grupo | Eventos |
|---|---|
| Comunicação | `ACIDENTE_COMUNICADO`, `ACIDENTE_COMUNICACAO_PUBLICA` (sem usuário; descrição sem nome), `ACIDENTE_ACIDENTADO_VINCULADO` (casou o externo com servidor ou participante), `ACIDENTE_PUBLICO_HONEYPOT` (sem conteúdo) |
| Trâmite | `ACIDENTE_ASSUMIDO`, `ACIDENTE_ESTADO_ALTERADO` (anterior e novo), `ACIDENTE_COMPLEMENTACAO_PEDIDA`, `ACIDENTE_COMPLEMENTACAO_RESPONDIDA`, `ACIDENTE_CANCELADO`, `ACIDENTE_CAT_SP_RETIFICADA` (versão e motivo) |
| Saúde | `ACIDENTE_SAUDE_REGISTRADA`, `ACIDENTE_SAUDE_ALTERADA` (só os nomes dos campos e o nível; **sem valores** na trilha), `ACIDENTE_SAUDE_EXPURGO_PARCIAL`, `ACIDENTE_SAUDE_FORA_RESPONSAVEL` (acesso de quem não conduz o caso, ROPA §4.4) e o registro `acesso_dado_sensivel` em cada abertura |
| Investigação | `ACIDENTE_INVESTIGACAO_SALVA` (com `registrar_diferencas`), `ACIDENTE_CHECKLIST_SALVO`, `ACIDENTE_ENTREVISTA_REGISTRADA`, `ACIDENTE_GRAVACAO_ANEXADA`, `ACIDENTE_EVIDENCIA_ANEXADA` (mais o `ANEXO_ENVIADO` genérico) |
| Plano | `ACIDENTE_ACAO_CRIADA`, `ACIDENTE_ACAO_ALTERADA`, `ACIDENTE_ACAO_CONCLUIDA`, `ACIDENTE_ACAO_CANCELADA` |
| Relatório e SIASS | `ACIDENTE_RELATORIO_EMITIDO`, `ACIDENTE_RELATORIO_RETIFICADO`, `ACIDENTE_ENCAMINHADO_SIASS`, `ACIDENTE_DECISAO_PERICIAL`, `ACIDENTE_CONCLUIDO` |
| Outros | `ACIDENTE_EMAIL_ENFILEIRADO` (sem endereço, no padrão EPI), `ACIDENTE_LINK_GERADO`, `ACIDENTE_LINK_DESLIGADO`, `ACIDENTE_IMPORTADO` (migração) |

Os que interessam ao titular entram em `atividade_titular.EVENTOS_DO_TITULAR`: comunicado, complementação pedida, relatório emitido, encaminhado e concluído.

### 3.5 Pendências (`pendencias.TIPOS`, `PERMISSAO_CONCLUIR_POR_TIPO`, `_LUGAR_DA_ENTIDADE`)

| Tipo | Prazo | Responsável | Conclui |
|---|---|---|---|
| `ACIDENTE_TRIAR` | 2 dias | Fila da CSSO (sem responsável) e depois quem assumiu | `acidente.triar`; fecha ao sair de RECEBIDA |
| `ACIDENTE_PRAZO_COMUNICACAO` | data_evento + 10 dias (art. 214) | Responsável | Fecha ao encaminhar ao SIASS ou ao concluir; varrida na rotina noturna (`TIPOS_VARRIDOS`) |
| `ACIDENTE_COMPLEMENTACAO` | 5 dias | Comunicante logado (`responsavel_id`) | Fecha ao responder; o vencimento avisa a SST |
| `ACIDENTE_SAUDE_REGISTRAR` | 5 dias | Médico do trabalho (fila por perfil) | `acidente.saude_registrar` |
| `ACIDENTE_INVESTIGAR` | 30 dias (a decidir) | Responsável | Fecha ao emitir o relatório |
| `ACIDENTE_ACAO_PRAZO` | prazo da ação | `responsavel_usuario_id` ou o responsável do caso | Fecha ao concluir ou cancelar a ação |
| `ACIDENTE_AGUARDA_PERICIA` | 60 dias | Responsável | Fecha com a decisão pericial |

### 3.6 Rotas e telas

Arquivos de rota: `src/rotas/acidentes*.ts`, cada um com `export const rotas`, registrados em `rotas/index.ts`. Os ids na rota usam `:id{[0-9]+}`.

| Rota | Permissão | Tela |
|---|---|---|
| `GET /acidentes` | `acidente.ver` | **Hub** `acidentes_painel.html`: título e subtítulo, e `div.acoes-hub` com `a.acao-hub` coloridos, cada um sob `{% if usuario.pode(...) %}`: **Comunicar acidente** (azul), **Triagem** (amarelo, `contagem urgente` "N novas"), **Em investigação** (roxo), **Plano de ação** (teal, "N vencidas"), **Encaminhar ao SIASS** (escuro, "N no prazo de 10 dias"), **Indicadores**, **Link público**. Abaixo, `grade-resumo` com os cartões "Prazo do art. 214 vencendo", "Aguardando complementação" e "Aguardando perícia", todos com link para a lista filtrada (só número, RN-19). Versão `pessoal` para o escopo P: "Minhas comunicações" e "Comunicar" |
| `GET/POST /acidentes/comunicar` | `acidente.comunicar` | Formulário em seções `details.recolhido` (1 Acidentado(s), 2 O que aconteceu, 3 Onde, 4 Testemunhas, 5 Declaração e envio). Envolvidos repetíveis por HTMX (`partes/acidente_envolvido.html`), autocompletar de servidor, condicional `data-mostra-quando`, rascunho local `data-rascunho-local`. A recusa re-renderiza com `digitado`/`campo_erro`. Um anexo opcional (≤4 MB); os demais vão depois, na ficha |
| `GET /acidentes/fila` | `acidente.ver` | `table.empilhavel` com filtros de estado, espécie, campus, período, responsável e protocolo; `ui.paginacao`. Nome só se `ve_nome_na_linha` |
| `GET /acidentes/:id` | `acidente.ver` (no escopo) | **Ficha** com `ui.abas`: Comunicação (CAT/SP vigente e versões), Envolvidos, **Saúde** (bloqueada; mostra "escolha a finalidade" antes de abrir), Investigação, Checklist, Entrevistas e evidências, Plano de ação, Relatórios, SIASS, Histórico. Ações no cabeçalho como `popup_cadastro` (Assumir, Mudar estado, Pedir complementação, Retificar, Cancelar com `classe_botao="perigo"`). Link para a ficha de EPI do acidentado |
| `POST /acidentes/:id/assumir`, `/estado`, `/complementacao`, `/cancelar`, `/retificar` | `acidente.triar` | Popups |
| `GET/POST /acidentes/:id/complementar` | titular ou comunicante logado | Formulário curto de resposta |
| `GET /acidentes/:id/saude?finalidade=…` e `POST /acidentes/:id/saude` | `acidente.saude_ver` / `_detalhe_ver` / `_registrar` | `partes/acidente_saude.html`. O GET sem finalidade mostra só o seletor |
| `GET/POST /acidentes/:id/investigacao` | `acidente.investigar` | Editor MAPA com `ui.info` em cada campo (os textos de ajuda do legado, l.203-324), `versao` oculta (conflito dá 409 e tela de comparação), linha do tempo e barreiras por HTMX |
| `GET/POST /acidentes/:id/checklist` | `acidente.investigar` | Itens com caixa e observação; `data-imprimir` |
| `POST /acidentes/:id/entrevistas`, `/evidencias` (multipart) | `acidente.investigar` | Gravador (`gravador.js`, `data-gravador`) com a caixa "consentimento obtido" obrigatória antes de gravar |
| `GET/POST /acidentes/:id/acoes`, `POST /acidentes/:id/acoes/:n/{estado,concluir,cancelar}` | `acidente.investigar` | Tabela empilhável; popup por ação |
| `GET /acidentes/acoes` | `acidente.ver` | Plano consolidado; filtros vencidas, minhas, por unidade |
| `POST /acidentes/:id/relatorio` e `/relatorio/retificar` | `acidente.relatorio_emitir` | Prévia, motivo, emitir |
| `GET /acidentes/:id/relatorio/:versao/:variante.pdf` | `acidente.ver` (+ saúde para COMPLETA) | Via `anexo_acesso.liberar`; `cache-control: private`, `marcarDownload` |
| `POST /acidentes/:id/siass`, `/decisao`, `/concluir` | `acidente.siass` | Popups |
| `GET /acidentes/minhas` | `acidente.ver` (titular) | `do_titular=true`; id vindo da sessão |
| `GET /acidentes/indicadores`, `GET /acidentes/indicadores/exportar` | `indicador.ver` (+ `exportar`) | `ui.distribuicao`, supressão n<5, CSV com BOM e `neutralizar_formula` |
| `GET/POST /acidente/:token` (público, D1) | sem sessão | `acidente_publico.html` sem casca (`usuario=null`); `_sem_rastro`, `referrer-policy: no-referrer`, aviso LGPD curto com `<details>` "Saiba mais" e declaração de veracidade obrigatória |

**Menu** (`modulos.ts`, módulo `acidentes`): Painel (`/acidentes`, `acidente.ver`), Comunicar (`acidente.comunicar`), Fila (`acidente.ver`), Plano de ação (`acidente.ver`), Indicadores (`indicador.ver`). Meu espaço ganha o grupo "Acidentes", com "Minhas comunicações" e `do_titular=true`.

**CSP e celular:**
- Nada de `<style>` nem `onclick`.
- Todo comportamento novo vai por atributo `data-` em `csso.js`, ou em `gravador.js`, um arquivo próprio carregado só na ficha, com `defer`.
- Confirmação por popup, nunca `confirm()`.
- Não há `Permissions-Policy` hoje, então o microfone fica liberado na mesma origem; convém declarar `microphone=(self)` explicitamente.
- Tabelas `empilhavel` com `data-coluna`.
- Teste `celular_acidentes.test.ts` (sem rolagem lateral a 360, 390 e 768 px).

### 3.7 E-mail

Arquivo `servicos/acidente_email.ts`, no padrão de `epi_email.ts`. Fica ligado só com a flag `CSSO_ACIDENTE_EMAIL=sim`; o destino do setor vem de `CSSO_ACIDENTE_EMAIL_SETOR`. Corpo: **protocolo, o que aconteceu e link**. Nunca leva nome, descrição ou saúde.
- **Nova comunicação:** vai ao setor.
- **Confirmação de recebimento:** vai ao comunicante logado.
- **Pedido de complementação:** vai ao comunicante logado, e ao público só se D6 permitir.
- **Prazo de ação:** vai ao responsável (pela rotina).
- **Relatório emitido e caso concluído:** vão ao acidentado servidor com conta, e só com link.

### 3.8 LGPD (dado de saúde é sensível)

1. **Portão antes da produção.** O sistema hoje não trata dado de saúde (ROPA §0). A fatia que cria `acidente_saude` exige a **emenda da ROPA** que torna vigentes §1.3, §4.3 e §4.4 e a POLITICA §2.4, mais a resposta às pendências §9.4 (menor de idade), §9.5 (comunicante e testemunha) e §9.6 (`acidentado_id` em `acesso_dado_sensivel`).
2. **Minimização.**
   - **Ficam fora:** CPF, RG, data de nascimento, sexo, endereço e telefone pessoal, CID, diagnóstico, texto clínico, foto de lesão.
   - **Saúde só em catálogo fechado e campos tipados**, nunca em texto livre. A descrição do acidente fala do evento, não do corpo, e o `ui.info` explica isso.
   - **Filtro de texto:** `exigir_texto_limpo` com `CONTEXTO_NEXO_OCUPACIONAL` nos campos narrativos.
3. **Acesso em dois níveis.** A separação é física (tabela e serviço próprios). A finalidade é escolhida **antes** de ver, toda abertura gera `acesso_dado_sensivel` e o acesso fora do responsável gera um evento na trilha.
4. **RN-19.** Identificador opaco `SRV-xxxx` para quem não tem permissão nominal; agregados com n<5 suprimidos. Com dezenas de casos por ano, quase todo recorte por unidade cai na supressão, e isso é esperado. As rotas novas entram em `privacidade_varredura.test.ts`.
5. **Compartilhamento.** A perícia do SIASS recebe a variante COMPLETA; a contratada e o fiscal recebem a SEM_SAUDE (ROPA §5). **Nenhum link público.**
6. **Retenção (POLITICA §2.4).**
   - Permanente: CAT/SP (todas as versões), ocorrência, investigação, relatório, decisão pericial, acidentado, núcleo de saúde, entrevista, unidade de exposição, ação e evidência citada.
   - 5 anos: evidência não citada e `acesso_dado_sensivel`.
   - O expurgo parcial do nível 2 é proposta pendente (§2.5.3) e manual.
   - IP do público: 90 dias.
   - Corpo de e-mail: 90 dias (já existe).
7. **Direitos do titular.** O acidentado servidor vê a própria ocorrência inteira. Pedido de eliminação é indeferido com base no art. 16, I e II. O não servidor é atendido pelo e-mail do setor.
8. **Terceiros.** Nenhuma API externa: sem IA, sem consulta de CNPJ, sem Web Speech. O SMTP institucional já está declarado como mudança de fluxo (ROPA §5.1).

---

## 4. Fatias de implantação

**Premissas:**
- Começar só **depois** do merge do Portal do servidor (migração 0016), porque ele toca os mesmos registros centrais.
- **Nenhum deploy em produção antes da F6 e do portão da LGPD.** Por isso as permissões podem ser declaradas todas na F0 sem "conceder cedo" em produção: o código vai junto, num deploy só.

**Arquivos compartilhados** (posse exclusiva da F0 e da costura final; ninguém mais toca neles): `rbac.ts`, `niveis_modulo.ts`, `modulos.ts`, `pendencias.ts`, `anexo_acesso.ts`, `sementes.ts`, `numeracao.ts`, `estados.ts`, `db/esquema/index.ts`, `relacoes.ts`, `seguranca.ts` (acesso sensível), `travas.sql`/`travas.ts`, `migracoes/`, `rotas/index.ts`, `rotinas.ts`, `atividade_titular.ts`, `csso.css`, `icones.txt`/`icones.svg`, `DESVIOS.md`, `../docs/ROPA.md` e `POLITICA_RETENCAO.md`.

**Contrato entre fatias:**
- A F0 deixa pronta a ficha `acidente_ficha.html`, com `{% include "partes/acidente_aba_<nome>.html" ignore missing %}` para cada aba, e as rotas vazias registradas em `rotas/index.ts` (arquivos com `export const rotas = new Hono()`).
- Cada fatia preenche **apenas os seus arquivos**.
- As contagens do hub ficam em `acidente_contagens.ts`, que pertence à F8. As fatias anteriores mostram os cartões sem contagem.

| Fatia | Valor | Arquivos (posse exclusiva) | Depende de | Testes |
|---|---|---|---|---|
| **F0 Fundação** (serial, um agente) | Base de tudo | `dominio/acidente.ts`, `db/esquema/acidente.ts`, migração `0017_acidentes`, travas, `semear_acidentes` (catálogos corrigidos com `rotulo_legado`), sequência e `proximo_numero_cat_sp`, máquina G, todas as permissões, matriz e níveis, tipos de pendência, resolvedor `acidente_ocorrencia` em `anexo_acesso`, módulo `disponivel:true` com itens, coluna `acidentado_id`, esqueleto das rotas e da ficha, ícones | Portal mergeado | `acidente_esquema.test.ts` (travas: UPDATE/DELETE recusados, CAT/SP append-only, colunas congeladas), `acidente_catalogos.test.ts` (44/199/30/30, idempotência, sem prefixo "N. "), `acidente_estados.test.ts` (todas as transições válidas e inválidas), atualização de `numeracao`, `rbac`, `niveis_modulo`, `sementes`, `modulos` e `correcoes_base` |
| **F1 Comunicar, fila e triagem** | Substitui o legado no dia a dia | `servicos/acidente_comunicacao.ts`, `acidente_triagem.ts`, `acidente_email.ts`, `rotas/acidentes.ts`, `templates/paginas/acidentes_painel.html`, `acidentes_comunicar.html`, `acidentes_fila.html`, `acidentes_minhas.html`, `partes/acidente_envolvido.html`, `partes/acidente_aba_comunicacao.html`, `partes/acidente_aba_envolvidos.html` | F0 | `acidente_comunicacao.test.ts` (titular comunica; vários envolvidos; externo sem CPF; CPF digitado é recusado ou mascarado; protocolo sequencial; CAT/SP v1 congelada; pendência de 10 dias), `acidente_triagem.test.ts` (transições, complementação e resposta, retificação gera v2 sem regredir o estado, cancelar exige motivo), `acidente_escopo.test.ts` (P vê só a própria; E pelo campus; sem permissão dá 403), `acidente_email.test.ts` (corpo sem nome nem descrição; flag desligada não enfileira) |
| **F2 Formulário público** (se D1 = link) | Comunicação por quem não tem conta | `servicos/acidente_publico.ts`, `rotas/acidente_publico.ts`, `paginas/acidente_publico.html`, `paginas/acidente_link.html` | F1 (usa o serviço de criar) | `acidente_publico.test.ts` (token errado dá a mesma resposta; limite por IP antes do token; honeypot não grava; teto de espera; cookie PRG; consentimento e declaração obrigatórios; IP expurgado pela rotina; `_sem_rastro`) |
| **F3 Saúde** | Cumpre a ROPA §4.4 | `servicos/acidente_saude.ts`, `rotas/acidente_saude.ts`, `partes/acidente_aba_saude.html` | F1 | `acidente_saude.test.ts` (nível 1 e nível 2 por perfil; finalidade obrigatória antes do conteúdo; `acesso_dado_sensivel` em toda abertura; evento fora do responsável; titular vê tudo; trilha sem valores; expurgo parcial só com `detalhe_expurgado_em`), varredura de privacidade |
| **F4 Investigação MAPA** | Coração técnico | `servicos/acidente_investigacao.ts`, `acidente_checklist.ts`, `acidente_entrevista.ts`, `rotas/acidente_investigacao.ts`, `partes/acidente_aba_{investigacao,checklist,entrevistas}.html`, `public/estaticos/js/gravador.js` | F1 | `acidente_investigacao.test.ts` (controle otimista dá 409; diff na trilha; edição travada após o relatório), `acidente_checklist.test.ts` (base com 9 seções; específicos por espécie e agente; sem falsos positivos de texto), `acidente_entrevista.test.ts` (áudio sem consentimento é recusado; 4 MB; tipo conferido pelos bytes; foto, se houver, não pode ser de lesão, como aviso de interface) |
| **F5 Plano de ação** | Prevenção acompanhada | `servicos/acidente_acao.ts`, `rotas/acidente_acoes.ts`, `paginas/acidentes_acoes.html`, `partes/acidente_aba_acoes.html` | F1 | `acidente_acao.test.ts` (ID estável; transições; cancelar exige motivo; pendência por ação, que fecha ao concluir; nunca delete; e-mail de prazo pela rotina) |
| **F6 Relatório PDF** | Produto final para o SIASS | `servicos/acidente_relatorio.ts`, `acidente_relatorio_pdf.ts` (pdf-lib), `rotas/acidente_relatorio.ts`, `partes/acidente_aba_relatorios.html` | F3, F4, F5 | `acidente_relatorio.test.ts` (contexto congelado e hash; reimpressão idêntica; retificação v2 com motivo e `substitui_id`; v1 legível; SEM_SAUDE não contém nenhum campo de saúde, com teste de texto extraído; download registra leitura; estado não regride; caracteres pt-BR fora do WinAnsi tratados) |
| **F7 SIASS e conclusão** | Fecha o ciclo | `servicos/acidente_siass.ts`, `rotas/acidente_siass.ts`, `partes/acidente_aba_siass.html` | F1 (paralela à F6, com contrato sobre o `relatorio_id`) | `acidente_siass.test.ts` (encaminhar exige relatório; decisão append-only; concluir exige decisão ou motivo; observação pericial recusa "doença"; pendências fecham) |
| **F8 Hub e indicadores** | Gestão | `servicos/acidente_contagens.ts`, `acidente_indicadores.ts`, `rotas/acidente_indicadores.ts`, `paginas/acidentes_indicadores.html` e a parte de contagens do `acidentes_painel.html` (combinada com a F1: a F8 só acrescenta macros de contagem) | F1–F5 | `acidente_indicadores.test.ts` (n<5 suprimido, com supressão secundária; CSV com BOM e fórmula neutralizada; permissão antes do período), `acidente_painel.test.ts` (todo número com link; versão pessoal), `celular_acidentes.test.ts` |
| **F9 Migração dos 28** | Continuidade histórica | `ferramentas/importar-catsp.ts` e `testes/acidente_importacao.test.ts` (com planilha fictícia) | F6 | Mapeamento de colunas legadas e novas; descarte dos campos proibidos (teste: nenhum CPF chega ao banco); protocolo preservado e sequência continuando depois dele; listas casadas por `rotulo_legado`; idempotência |
| **Costura final** (serial) | Pronto para produção | Emenda da ROPA, POLITICA e DESVIOS; `privacidade_varredura`; `EVENTOS_DO_TITULAR`; passos novos de `rotinas.ts`; ajuste fino de `csso.css` | Todas | Suíte inteira; varredura; conferência da cadeia |
| **F10 IA** (condicional, D2) | Opcional | `servicos/acidente_ia.ts` e configuração | Emenda da ROPA e contrato | Redação testada; nada é gravado sem aceite; trilha |

**Paralelismo:**
- Ordem obrigatória: F0, depois F1.
- Em seguida, **F2, F3, F4 e F5 em paralelo**.
- Depois, F6 e F7 em paralelo; F8 junto.
- F9 e a costura no fim.

As fatias que precisarem de algo num arquivo compartilhado (um tipo de pendência novo, um evento do titular) **anotam o pedido** num arquivo próprio `docs/pedidos_costura_<fatia>.md` em vez de editar o compartilhado; a costura aplica todos.

---

## 5. Decisões que o usuário precisa tomar

**D1. Formulário público sem login, ou só logado?**
- *Contexto:* o legado é 100% anônimo, e por isso houve spam possível, funções expostas e dados no Drive. No SISA, servidor só tem conta se alguém a criou, e terceirizados e estudantes não têm. A ROPA §6 trata página pública como decisão institucional (exposição de rede).
- *Alternativas:*
  - (a) só logado (titular e SST);
  - (b) link com token, no padrão `/inscricao/:token`, divulgado internamente (intranet, e-mail institucional, cartaz no setor), regenerável;
  - (c) URL aberta permanente.
- **Recomendação: (a) na primeira entrega, (b) logo depois (F2).** Com (b): só honeypot, limite por IP, teto de pendentes e "nasce RECEBIDA e só conta depois da triagem". Nada de anexo no público ou, no máximo, 1 arquivo de 4 MB. Nunca (c).

**D2. Manter o assistente de IA?**
- *Contexto:* a ROPA §5.1 proíbe API externa sem emenda prévia. A decisão 6 diz que IA não é prioridade. O legado envia saúde, quase-identificadores e transcrições, e no Gemini gratuito os dados podem ir para treinamento.
- *Alternativas:*
  - (a) sem IA; checklist e roteiro determinísticos;
  - (b) modelo local (na infraestrutura da UFVJM);
  - (c) API de terceiro com contrato de operador (LGPD arts. 39/46), sem retenção e sem treino, chave só em variável de ambiente, envio só do texto da investigação já redigido e sem saúde, aceite humano campo a campo e trilha.
- **Recomendação: (a) agora.** (c) só depois da emenda e do contrato. O provedor fica para a decisão do encarregado. Nunca chave no repositório nem no banco.

**D3. Relatório PDF no próprio sistema, em vez de Google Docs?**
- *Alternativas:*
  - (a) pdf-lib, como no certificado: sem dependência e funciona no Netlify;
  - (b) modelo .docx (docxtemplater) mais Gotenberg opcional: layout editável pelo setor, mas depende de serviço externo para virar PDF;
  - (c) manter Google Docs: não, porque cria link público e Doc editável e é API externa.
- **Recomendação: (a)**, com .docx opcional para o setor editar antes de assinar no SEI. A assinatura oficial continua no SEI.

**D4. O comunicante pode declarar fatos de saúde?**
- *Contexto:* o legado pergunta sobre afastamento, morte, internação, atendimento e parte do corpo. A ROPA diz que quem registra saúde é o médico do trabalho.
- *Alternativas:*
  - (a) o comunicante não declara nada de saúde;
  - (b) declara só parte do corpo (catálogo) e os fatos SIM/NÃO/NÃO SEI (atendimento, afastamento, internação, óbito), gravados com `origem = DECLARADO_COMUNICANTE` e confirmados pelo médico (pendência `ACIDENTE_SAUDE_REGISTRAR`).
- **Recomendação: (b).** Sem isso a triagem fica cega para gravidade e óbito. Precisa constar na emenda da ROPA.

**D5. Migrar os cerca de 28 registros da planilha?**
- *Alternativas:*
  - (a) não migrar e arquivar a planilha e a pasta em local institucional restrito;
  - (b) importar só os campos permitidos (fatos do evento, envolvidos casados com `servidor` por SIAPE, análise, plano, relatórios PDF antigos baixados manualmente como anexo), descartando CPF, RG, data de nascimento, sexo e endereço, com protocolo original preservado;
  - (c) importar tudo: proibido.
- **Recomendação: (b).** A planilha e o Drive originais ficam arquivados, porque a CAT/SP é prova e o PDF antigo é o original. **Revogar já os links públicos dos relatórios no Drive** (independe do SISA). Rodar o importador localmente, sem commitar dados.

**D6. Quem recebe e-mail?**
- **Recomendação:**
  - setor (endereço por variável de ambiente) na comunicação nova;
  - comunicante logado: confirmação e pedido de complementação;
  - responsável pela ação: prazo;
  - acidentado servidor: relatório emitido e caso concluído.
  - Sempre só protocolo e link.
  - **Comunicante público: nada** (padrão anti-spam da inscrição), ou só se o domínio for `@ufvjm.edu.br`.
  - Chefia: não, enquanto não houver chefia modelada (D9).
- Tudo atrás da flag `CSSO_ACIDENTE_EMAIL`.

**D7. Numeração do protocolo.**
- *Alternativas:*
  - (a) manter `CAT-AAAA-NNNN`, com continuidade para os 28; a sequência pula os números já ocupados;
  - (b) prefixo novo (`ACD-`), deixando os antigos como estão.
- **Recomendação: (a).** O número é consumido no envio (RN-03, nunca MAX+1). O número da CAT no SIASS vai em campo próprio.

**D8. Autosave da análise.**
- *Alternativas:*
  - (a) rascunho local mais "Salvar" com controle otimista;
  - (b) salvamento automático no servidor a cada N minutos, com uma auditoria por janela.
- **Recomendação: (a).** É o padrão da casa e não incha a trilha. (b) pode vir depois, se houver perda real de trabalho.

**D9. Chefia.**
- *Contexto:* não há chefia modelada no SISA.
- *Alternativas:*
  - (a) a chefia comunica como titular, marcando "sou a chefia imediata";
  - (b) modelar chefia por unidade (projeto maior, que afeta outros módulos).
- **Recomendação: (a).**

**D10. Matriz de perfis.** Confirmar a §3.3, em especial três pontos: se a secretaria tria, se a PROGEP e o auditor veem, e se o técnico de segurança emite relatório.

**D11. Catálogo "natureza da lesão"** (exigido pela ROPA, inexistente no legado).
- *Alternativas:*
  - (a) usar a tabela da NBR 14280 ou a tabela 17 do eSocial;
  - (b) uma lista curta própria.
- **Recomendação: (a).** É preciso fornecer a lista oficial; não inventar. Decidir também se vale buscar os **códigos oficiais** das quatro listas legadas (coluna `codigo_oficial`).

**D12. Taxas de frequência e de gravidade.**
- *Contexto:* exigem horas-homem trabalhadas por unidade, que o SISA não tem.
- *Alternativas:*
  - (a) só contagens e dias perdidos;
  - (b) parâmetro anual de HHT por campus, informado à mão.
- **Recomendação: (a) agora, (b) depois.**

**D13. Prazos de pendência** (triagem 2 dias, complementação 5, investigação 30, perícia 60) e o **prazo de 10 dias** contado da data do evento ou do conhecimento. Recomendação: da data do evento, com a prorrogação registrada (o art. 214 é prorrogável).

**D14. Pendências da ROPA §9.** Precisam de resposta antes da primeira ocorrência real: menor de idade (item 4), base legal de comunicante e testemunha (item 5) e o "sobre quem" para não servidor (item 6; recomendação: coluna `acidentado_id`).

---

## 6. Riscos

1. **Legado em produção expõe dados hoje.** São relatórios com CPF, RG, endereço e saúde abertos por link, e funções anônimas que devolvem a senha inicial. **Mitigação imediata, sem esperar o SISA:** revogar o compartilhamento público no Drive, trocar a senha do "sest" e restringir o acesso do Web App, ou renomear as funções com `_`.
2. **Portão da LGPD trava a entrega.** Sem a emenda da ROPA e sem o encarregado (ROPA §9.3, pendente desde a v1.0), a fatia de saúde não pode ir para produção. Planejar F0 a F5 sem depender dessa data, mas sem deploy.
3. **Expectativa de paridade literal.** Os usuários do legado vão sentir falta de CPF, endereço, IA e transcrição automática. É preciso comunicar que isso é exigência legal e não regressão, e oferecer as compensações: autocompletar pelo cadastro, checklist e roteiro.
4. **Limite de 4 MB e 6 MB por requisição** (Netlify). Áudio longo ou vídeo não cabe. Mitigação: gravações curtas por trecho, várias entrevistas, compressão opus. Se necessário, upload direto ao Storage com URL assinada (exige desenho próprio).
5. **Conflito com o agente do Portal do servidor** nos arquivos centrais (`rbac`, `modulos`, `pendencias`, migrações, `csso.css`). Mitigação: começar depois do merge, F0 serial, numeração da migração conferida no rebase.
6. **Catálogos com defeito.** Corrigir a grafia quebra o casamento com o legado. Mitigação: `rotulo_legado`. Sem os códigos oficiais, a integração futura com o eSocial ou o SIASS exigirá tabela de correspondência.
7. **Volume baixo** (dezenas por ano). A supressão RN-19 vai esconder quase todo recorte por unidade, e indicador "vazio" pode parecer defeito. Explicar na tela (`ui.distribuicao` com nota).
8. **Imutabilidade mal desenhada.** Se as colunas congeladas da ocorrência não estiverem alinhadas com as versões da CAT/SP, ou a retificação vira reescrita, ou o sistema trava correções legítimas. Mitigação: testes de trigger na F0 e o padrão `retificacao.ts`.
9. **Gravação de entrevista.** O consentimento precisa ficar registrado. O relato é dado de terceiro, de guarda permanente; o acesso tem de ser restrito e auditado.
10. **Fonte do PDF.** Helvetica WinAnsi não cobre todos os caracteres (o travessão do catálogo e símbolos especiais viram "?"). Mitigação: normalizar o texto (`Fontes.limpo`) e testar com os catálogos completos.
11. **Migração com dado pessoal.** A planilha exportada contém CPF e saúde. Rodar o importador só localmente, nunca colocar o arquivo no repositório, apagar a cópia depois e registrar em ata.
12. **Prazo de 10 dias com SST pequena.** Pendências e e-mail só ajudam se o setor estiver configurado. Sem SMTP (`CSSO_SMTP_URL`), o e-mail fica PENDENTE em silêncio. Conferir em `/emails`.

---

## 7. DECISÕES DO USUÁRIO (23/10/2026) — valem sobre as recomendações acima

- D1: (a) só logado na 1ª entrega; (b) link com token logo depois (F2). Nunca URL aberta.
- D2: sem IA. Checklist e roteiro determinísticos.
- D3: PDF no SISA (pdf-lib), com .docx opcional para o setor editar antes de assinar no SEI.
- D4: comunicante declara só parte do corpo (catálogo) e SIM/NÃO/NÃO SEI (atendimento, afastamento, internação, óbito), origem DECLARADO_COMUNICANTE, confirmação pelo médico.
- D5: migrar só os campos permitidos (sem CPF, RG, nascimento, sexo, endereço), protocolo preservado; importador local, sem dados no repositório.
- D6: e-mail ao setor (nova comunicação), comunicante logado (confirmação, complementação), responsável pela ação (prazo), acidentado servidor (relatório emitido, concluído). Comunicante público não recebe. Só protocolo e link. Flag CSSO_ACIDENTE_EMAIL, desligado por padrão.
- D7: manter CAT-AAAA-NNNN, sequência anual, pula números já ocupados pelos migrados; nº SIASS em campo próprio.
- D8: rascunho local + Salvar com controle otimista.
- D9: chefia comunica com a própria conta e marca "sou a chefia imediata".
- D10: matriz da §3.3 com: secretaria TRIA (sem saúde); técnico de segurança EMITE relatório; auditor interno NÃO vê; consulta_progep NÃO vê.
- D11: natureza da lesão pela tabela oficial (NBR 14280 / eSocial tabela 17); coluna codigo_oficial nas listas; corrigir grafias/itens cortados guardando rotulo_legado.
- D12: só contagens e dias perdidos agora; HHT por campus depois.
- D13: prazo de 10 dias contado da data do acidente, prorrogação registrada com motivo; pendências: triagem 2, complementação 5, investigação 30, perícia 60 dias.
- D14a: menor de idade: registra, marca, restringe à SST e pede responsável legal.
- D14b: base legal obrigação legal/política pública (LGPD art. 7º II e III) + aviso de privacidade no formulário.
- D14c: cadastro próprio de acidentado não servidor (nome e vínculo, sem CPF); acesso_dado_sensivel aponta para ele (acidentado_id).
