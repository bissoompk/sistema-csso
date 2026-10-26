# Paridade IntegraSST × nuvem: Treinamentos, Certificados e Inscrições

Auditoria somente leitura, 21/10/2026. Lidos por completo: `entrada/integrasst/Certificados_Backend.js` (todas as 30 funções `api_*` e auxiliares), `Certificados_Frontend.html` (8 views/cartões, 7 modais, todo o JS), `Certificados_PublicForm.html`, `Validador_Frontend.html`, e as rotas `?validar=` / `?inscricao=` em `Core.js:70-115`. Do lado da nuvem: `src/rotas/{turmas,certificados,treinamentos,inscricao_publica,validacao}.ts`, `src/servicos/{inscricao_publica,turma,emissao_certificado,fila_emissao,lista_presenca,treinamento_indicadores,validacao_certificado}.ts`, `src/dominio/estados.ts`, `src/modulos.ts` e os templates correspondentes.

O que `nuvem/DESVIOS.md` já registra ("Treinamentos e Certificados", "Simplificação… / Treinamentos e certificados", "Paridade com o IntegraSST (20/10/2026)", "Corrigir e excluir (20/10/2026)") não se repete aqui como lacuna. Só se cita.

Observação sobre o próprio IntegraSST: a função `encerrarInscricao()` (Frontend:1222) **não tem botão**. Nenhuma linha da tabela de turmas a chama. No legado, o encerramento só acontece de forma automática, por prazo vencido ou por lotação, dentro de `api_listarTurmasAbertas` (Backend:608-621). O operador pode **reabrir** (Frontend:1045), mas não pode encerrar manualmente.

---

## 1. Lacunas (c): o que AINDA falta na nuvem, por prioridade

| # | Prioridade | Lacuna | IntegraSST | Nuvem hoje | Justificativa |
|---|---|---|---|---|---|
| 1 | **Alta** | **Aceitar em lote os pedidos do link público** ("aceitar todos" / "aceitar os marcados") | Não precisa: o formulário grava `Inscrito` direto (Backend:991) | Cada pedido `AGUARDANDO_EMAIL` exige abrir a gaveta "ações" e clicar em "Aceitar" (`turma_ficha.html:403-421`, POST `turmas.ts:1024`). Não há ação em massa. | A conferência pela CSSO é desvio registrado. Com ela, porém, uma turma de 30 pessoas passa de 0 cliques no legado a cerca de 60 cliques e 30 recargas de página. É a maior regressão de esforço do módulo. Sugestão: caixas de marcação mais "Aceitar os marcados", cada um no seu savepoint, como `inscricao_lote`. |
| 2 | **Alta** | **Pedido pelo link com a turma lotada** | Com `ocupadas >= limite`, a turma vira `LOTADA` (Backend:617-621) e o formulário público responde "encerradas ou lotadas" (Backend:894) | `inscricao_publica.pedir` (servico:250-308) confere situação, prazo e o teto de 200 pedidos em espera, mas **não confere vaga**. O cartaz continua dizendo "Pedir a vaga" com zero vagas. A recusa só aparece depois, quando a CSSO tenta aceitar. | A pessoa recebe "Pedido recebido" sem nenhuma chance real de vaga, e a CSSO ganha trabalho para recusar. Sugestão: sem vaga, o cartaz mostra "turma lotada" (ou "lista de espera") e não oferece o formulário. Pode também mostrar "N vagas livres". |
| 3 | **Média** | **Atalho de "turma aberta com link" na criação** (equivalente ao choice-card) | Escolher o tipo de turma (Frontend:457-484), preencher um formulário e clicar em "Gerar Link Público": a turma nasce `ABERTA` e o link já existe | A turma nasce `PLANEJADA` (`turmas.html:143`). Depois é preciso: ficha, "Abrir inscrições" (que leva a `#situacao`), o POST da situação, a aba Inscrições e "Gerar o link e o QR". Gerar o link com a turma planejada é recusado (`inscricao_publica.gerar_link`, servico:87-88), e sem "inscrições até" também (servico:81-85). | São 4 passos a mais, e há duas recusas pelo caminho para quem não conhece a máquina de estados. Sugestão: no popup "Abrir turma", uma caixa "abrir já para inscrições e gerar o link" que, com "inscrições até" preenchido, faz PLANEJADA → INSCRICOES_ABERTAS e mostra `turma_link.html`. |
| 4 | **Média** | **Botões "Copiar" e "Abrir" no link gerado** | O modal tem campo e botão "Copiar Link" (Frontend:1238-1247) | `turma_link.html:22-28` traz só um `<input readonly>` e o QR. Não há botão de copiar, link para abrir/testar, nem download do QR (a tela manda usar "botão direito, salvar imagem"). | O link aparece uma vez só, e isso é desvio registrado. Por isso, perder a cópia custa trocar o link e redistribuir o cartaz. Copiar com um clique e "baixar QR (PNG)" reduzem esse risco. Custo baixo, uns 10 linhas de JS e uma rota. |
| 5 | **Média** | **Emissão em lote sem orçamento de tempo** | Um certificado por chamada, com barra de progresso (Frontend:1491-1573). O que foi gerado fica gravado. | `emitir_lote` (`emissao_certificado.ts:702-734`) emite todos na mesma requisição, sem limite de quantidade nem de tempo. DESVIOS (seção Treinamentos) admite que, se a requisição cair, nada do lote fica gravado. | Numa função do Netlify, com cerca de 150 ms por ida ao banco e geração de .docx mais upload por certificado, uma turma grande pode estourar o tempo e voltar inteira para trás, sem progresso visível. **A verificar com medição.** Se confirmado: fatiar (por exemplo, 15 por POST com "continuar") ou mandar para a função de fundo, como o e-mail. |
| 6 | **Média** | **Ações rápidas na lista de turmas** | Cada linha de "Gestão de Turmas" tem "Gerir participantes (N)", "Copiar Link", Concluir e Excluir (Frontend:1038-1053) | `turmas.html:85-110` só lista. Toda ação exige abrir a ficha e ir à aba certa. | Para quem opera várias turmas abertas ao mesmo tempo, cada consulta custa dois cliques a mais. No mínimo: indicador "link no ar" e prazo de inscrição na linha, com link direto para `?aba=inscricoes`. |
| 7 | **Baixa** | **Turma com prazo vencido continua "Inscrições abertas" na lista** | Muda sozinha para `ENCERRADA (PRAZO)` (Backend:608-612) | O pedido é barrado depois de "inscrições até" (`turma.aberta_a_pedido_proprio`, turma.ts:962-964), mas a situação não muda e a lista mostra a pílula "Inscrições abertas" (`turmas.html:96`). A ficha diz "ligado, mas fora do prazo" (`turma_ficha.html:330`). | Informação enganosa na lista. Basta um selo "prazo encerrado" na linha. Não precisa mudar estado. |
| 8 | **Baixa** | **Colunas da lista de turmas**: instrutor, unidade promotora, fim do prazo de inscrição | "Instrutor / Local / Setor" e "Até: dd/mm" (Frontend:1055) | Colunas Código, Treinamento, Período, Local, Campus, Inscritos, Situação (`turmas.html:85-86`) | Ajuda a localizar a turma. |
| 9 | **Baixa** | **Filtro por setor promotor** na fila de emissão e na lista de turmas | `filtroSetorFila` (Frontend:240-249) e filtro de setor no modal de presença (Frontend:637-646) | A fila filtra por etapa, treinamento e busca (`certificados_fila.html:36-51`). `/turmas` filtra por situação e treinamento. Só `/treinamentos/indicadores` tem setor. | Útil quando várias seções (Perícia, Promoção, SST, DASA) usam o mesmo sistema. |
| 10 | **Baixa** | **Cartaz público sem instrutor(es) e sem setor promotor** | `lblInstrutor` e `lblSetor` (PublicForm:83-84) | `inscricao_publica.html:30-37` mostra período, carga, local/campus, "inscrições até" e descrição | A pessoa decide se vai ao curso também por quem dá a aula e por quem promove. Dado público, sem risco LGPD. |
| 11 | **Baixa** | **Dica "como deve sair no certificado"** no campo de nome do cartaz | Placeholder "Como deverá sair no certificado" (PublicForm:91) | Rótulo seco "Nome completo" (`inscricao_publica.html:59`) | O nome digitado vira o do certificado do externo. Corrigir depois custa uma correção com motivo. |
| 12 | **Baixa** | **Linhas em branco e conteúdo programático na lista de presença** | 5 linhas em branco para quem chega sem inscrição e o conteúdo programático no cabeçalho (Frontend:1298-1300) | `lista_presenca.montar_contexto` (lista_presenca.ts:63-80): sem linhas extras, sem tópicos | Quem aparece sem inscrição assina à mão em qualquer lugar. Isso depende do modelo .docx da lista. |
| 13 | **Baixa** | **Aviso de reciclagem no formulário de turma** ("este treinamento exige reciclagem a cada N meses") | `_atualizarVisibilidadeVencimento` (Frontend:1157-1175) | O popup só mostra a carga no `<option>` (`turmas.html:156`). "Data base do vencimento" tem dica genérica. | Na nuvem a data base vazia usa o término, o que é melhor. O aviso só ajuda quem precisa preencher a data base de outra forma. |
| 14 | **Baixa** | **Validação pública: "a vencer em 30 dias", local e data de início** | `statusValidade` `a_vencer` (Backend:1789), local, data (Validador:186-209) | `validacao.html:60-126`: autêntico, vencido ou anulado, mais o vencimento em data. Sem "a vencer", sem local. | O empregador que confere o papel ganha um aviso útil. A ausência de nome, nota e PDF é de propósito (ver b-13). |
| 15 | **Baixa** | **Contato na página de "não reconhecido"** | E-mail `dasa@ufvjm.edu.br` (Validador:243) | "Fale com a CSSO" sem endereço (`validacao.html:55-56`) | Um parâmetro de contato da CSSO resolve. |

Fora da tabela, por ser trivial: no legado, os indicadores mostram uma linha "Exibindo dados de dd/mm/aaaa até dd/mm/aaaa — Setor X" (Frontend:964-972). Na nuvem o período fica só no `<select>`.

---

## 2. Itens com equivalente (a)

| IntegraSST | Nuvem |
|---|---|
| Cartão 1, Modelos (cadastro e edição, carga, conteúdo, instrutor padrão, validade em meses, dicionário de tags) | Catálogo `/treinamentos/catalogo` (treinamentos.ts:183-306), com validade, carga, conteúdo e instrutor padrão. Modelos `/treinamentos/modelos` (treinamentos.ts:397-909), com mapa de marcadores, sugestão e exemplo preenchido |
| Excluir modelo (vira "Inativo") | Versão e vigência do modelo (`certificado_modelo.html:16-46`). Treinamento: excluir se nunca usado, senão desativar (treinamentos.ts:306) |
| Cartão 2, Criar turma (treinamento, data, local, instrutor(es), vagas, data limite, data base, descrição, setor promotor) | Popup "Abrir turma" (`turmas.html:139-211`, POST turmas.ts:360), com campus, nota e frequência mínimas a mais. Instrutores na ficha (turmas.ts:797) |
| "Reutilizar descrição anterior" | "usar a da última turma deste treinamento" (`turmas.html:198-200`, ficha:1250). Já está em DESVIOS (Paridade) |
| Cartão 3, Gestão de turmas: tabela, ocupação "N / M vagas" | `/turmas` com "18 de 20" (`turmas.html:94-95`) e a ficha com "N vaga(s) livre(s) de M" (`turma_ficha.html:353-354`) |
| Reabrir inscrições | "Abrir inscrições", PLANEJADA → INSCRICOES_ABERTAS (estados.ts:423, `macros.html:202`, POST turmas.ts:638) |
| Encerrar inscrições (no legado só automático) | "Fechar inscrições", INSCRICOES_ABERTAS → PLANEJADA (estados.ts:426, `macros.html:201`), e prazo que barra o pedido (turma.ts:962) |
| Concluir turma (manda os inscritos à fila) | "Concluir turma…" com confirmação e apuração (`turma_ficha.html:228-231`), mais "Registrar turma já realizada" (turmas.ts:766) |
| Gerir participantes: listar, remover, adicionar | Aba Inscrições (`turma_ficha.html:347-500`): busca, inscrever, cadastrar externo, cancelar com motivo, corrigir externo, CPF |
| Turma fechada, registro manual de N participantes de uma vez | "Inscrever em lote" colando da planilha (turmas.ts:953-985, `turma_lote.html`) e "Registrar turma já realizada" |
| Link público: gerar e copiar | "Gerar o link e o QR" / "Gerar um link novo" / "Desligar o link" (`turma_ficha.html:325-346`, turmas.ts:990-1022, `turma_link.html`). O QR é a mais |
| Formulário público: dados da turma, envio e mensagem final | `/inscricao/:token` (`inscricao_publica.html`, rotas/inscricao_publica.ts:64-98): turma, descrição, formulário, "Pedido recebido" |
| Formulário público: turma encerrada ou link inválido | "Link de inscrição inválido" (html:19-24) e motivo `fechada` (html:49-52) |
| Cartão 4, Presença e notas (faltou e nota por pessoa) | Aba "Presença e notas", com grade por dia, "Marcar todos presentes", folha de um dia e nota por linha (turmas.ts:1178-1325, `turma_ficha.html:676-860`) |
| Imprimir folha de assinatura | "Lista de presença" em .docx (turmas.ts:1483, `turma_ficha.html:12-14`) |
| Cartão 5, Fila e emissão em lote (marcar todos, filtros, busca, paginação) | `/certificados/fila` com etapas Aguardando, Travado, Emitido, Inscrito, Faltou, Reprovado (`fila_emissao.ts:31`), busca, marcação e "Emitir os marcados" (certificados.ts:270-300). Na turma, "Emitir os certificados" (turmas.ts:1342) |
| Status "Erro: …" na linha | Etapa "Travado" com o motivo da validação (DESVIOS, Paridade) |
| Abrir PDF do certificado | `/certificados/:id/pdf` e `/documento`, `/turmas/:id/certificados.pdf` e `.zip` (certificados.ts:420-455, turmas.ts:1454-1480) |
| 3. Disparar e-mails | "Enviar por e-mail os marcados" (fila), "…os não enviados" (turma, turmas.ts:1328), reenviar (certificados.ts:457) e a fila `/certificados/emails` |
| Cartão 6, Monitor de vencimentos (situação, busca, paginação) | `/certificados/vencimentos` (certificados.ts:157-216), com aviso por e-mail, aviso automático e pendência |
| Cartão 7, Assinaturas (upload de PNG/JPG, prévia, excluir) | `/treinamentos/assinaturas` com rubrica (treinamentos.ts:979-1240) e miniatura (`assinaturas.html:69`) |
| Cartão 8, Indicadores (turmas, participantes, emitidos, faltas, pendentes, inscritos, ativas, concluídas, taxa de aprovação, por setor, top treinamentos) | `/treinamentos/indicadores` (treinamentos.ts:1244-1290, `treinamentos_indicadores.html`), com os mesmos 9 cartões e as 2 distribuições |
| Presets "Ano atual / Ano anterior / Todo período" | `PERIODOS` (treinamentos.ts:1224-1241), em `<select>` em vez de 3 botões |
| Validador `?validar=chave` | `/validar/:chave` (validacao.ts:90), mais o formulário para digitar a chave (validacao.ts:73-88) |
| Busca na fila por nome, CPF ou ID | Busca em `/certificados` e na fila por nome, SIAPE, PTC, turma e número (DESVIOS, Paridade). O CPF não entra, por decisão |

## 3. Existe, mas diferente de propósito (b)

| # | Item | Diferença | Onde está registrado |
|---|---|---|---|
| b-1 | Data do curso em texto livre ("10 a 12 de maio") | Início e término como datas | DESVIOS, Paridade: "a data é gerada do início e do fim" |
| b-2 | Três passos (protocolos, PDFs, e-mails) com barra de progresso | Emitir é um passo (número e chave); o e-mail vai à parte, em fila de fundo | DESVIOS, Paridade: "emitir é um passo só"; Envio de e-mail |
| b-3 | PDF em pasta do Drive, link público | PDF gerado na hora (pdf-lib), sem gravar | DESVIOS, "Certificado em PDF com QR"; Paridade |
| b-4 | Inscrição pública grava `Inscrito` direto e ocupa vaga | Pedido `AGUARDANDO_EMAIL` conferido pela CSSO, sem ocupar vaga | DESVIOS, Paridade: Inscrição pública por link |
| b-5 | Link `?inscricao=<ID da turma>`, permanente e copiável a qualquer hora | Token de 192 bits mostrado uma vez, guardado em hash, que expira em "inscrições até" | DESVIOS, Paridade: "O token… é mostrado uma vez" |
| b-6 | Campos do formulário público: Nome*, CPF*, Cargo, E-mail*, WhatsApp | Nome, Vínculo, SIAPE (servidor), E-mail opcional, Organização e consentimento LGPD. Sem CPF, cargo e telefone | DESVIOS, Paridade ("sem CPF"; lote: "CPF, telefone e cargo são lidos e descartados"); "CPF só para certificado" |
| b-7 | "Inscrição Confirmada!" | "Pedido recebido… a CSSO confere" (`inscricao_publica.ts:53-55`) | Consequência de b-4 |
| b-8 | Excluir turma apaga a turma e todos os alunos, em qualquer situação | Excluir só turma sem história; o resto se cancela com motivo | DESVIOS, "Corrigir e excluir": Excluir turma |
| b-9 | "Excluir PDF e refazer" (limpa número e chave e volta a Pendente) | Anular com motivo ou "Corrigir certificado" (anula e reemite num ato) | DESVIOS, "Corrigir e excluir": Corrigir certificado |
| b-10 | "Apagar registro" do aluno (deleteRow) | Cancelar a inscrição com motivo (`turma_ficha.html:432-441`). A trilha fica | Desenho de origem (inscrição não se apaga). Não está em DESVIOS por não ser desvio do Python |
| b-11 | Instrutor(es) digitados livremente, vários, já na criação | Instrutor padrão vinculado sozinho; os demais na ficha, entre assinaturas cadastradas | DESVIOS, Simplificação: "Instrutor padrão na turma" |
| b-12 | Data base de vencimento obrigatória quando há validade | Vazia vale o término | Dica em `turmas.html:186-188` (decisão da nuvem) |
| b-13 | Validador mostra nome completo, CPF parcial, nota e botão "Baixar PDF" | Mostra o identificador `PTC-…`, confere o nome por digitação, sem nota e sem documento | `validacao.html:160-180` e cabeçalho de `servicos/validacao_certificado.ts`. Não tem item próprio em DESVIOS; o caso de CPF está em "CPF só para certificado" |
| b-14 | Histórico de descrições de **todas** as turmas (lista clicável) | Só "a da última turma deste treinamento" | DESVIOS, Paridade: Descrição do evento |
| b-15 | Hub de cartões 1 a 8 com o guia de 4 passos | Menu lateral com 12 itens e o cartão "Primeiros passos" em `/turmas` vazia | DESVIOS, "Telas mais objetivas" |
| b-16 | Mapeamento de tags com `{{TAG}}` livre e Slides | Marcadores do .docx (`{{x}}` e `«x»`), sugestão e campos livres | DESVIOS, "Modelo de certificado enviado pela tela"; "Campos do certificado além do sistema" |
| b-17 | E-mail com link de download e chave | E-mail com o certificado em anexo (segunda via) | DESVIOS, Paridade: Envio de e-mail |

## 4. Não deve ser portado (d)

- RG / `ALU_IDENTIDADE` (Backend:1381, Frontend:921). Recusado por LGPD (DESVIOS, Paridade, "Ficou de fora").
- WhatsApp: campo no formulário público e no manual, e botão `wa.me` na fila (Frontend:1434). Recusado (idem).
- CPF obrigatório na inscrição, CPF parcial na tela, busca e validador. O CPF existe só para certificado e nunca aparece em tela (DESVIOS, "CPF só para certificado").
- Google Slides e Drive: ID do slide, ID da pasta, "Abrir Slide/Pasta", `makeCopy`, `sleep(6000)`, exportação com repetição, `_injetarComAutoFit`. A nuvem usa .docx e pdf-lib, e o PDF da casa já quebra linhas (`certificado_pdf.ts:92-110`).
- QR por `api.qrserver.com` (terceiro). A nuvem desenha o QR localmente (`servicos/qr.ts`).
- `setupCertificadosDatabase`, `encontrarColuna` e colunas criadas sob demanda: coisa de planilha.
- Prefixo do ID `XXXX-AAAA-NNN` tirado da última palavra do treinamento. A nuvem usa a sequência `NN/AAAA` (numeracao).
- Setores promotores fixos no HTML. A nuvem lê as unidades do cadastro.
- Chave por `Math.random` (20 caracteres). A nuvem usa sorteio criptográfico.

---

## 5. Inventário de UX comparado

### 5.1 Navegação

**IntegraSST** (SPA de uma tela, `switchView`):
```
Menu lateral "Certificados" (Index.html:302) ─► HUB cert-dashboard-view
   ├─ Guia 01-04 (só texto: Modelos › Turmas › Presença › Gere e Dispare)
   ├─ [1] Modelos (Slides) ─────► view cert-modelos-view ─► modal modalModeloCertificado
   ├─ [2] Criar Nova Turma ─────► modal modalEscolhaTipoTurma (choice-card)
   │                                 ├─ Turma Aberta (Link) ─► modal modalNovaInscricao
   │                                 └─ Turma Fechada (Manual) ─► modal modalCadastrarTurma (N linhas de alunos)
   ├─ [3] Gestão de Turmas ─────► view cert-inscricoes-view ─► modal modalGerirAlunosTurma
   │                                 └─ "Copiar Link" ─► modal appAlertModal (campo + Copiar)
   ├─ [4] Presença / Notas ─────► modal modalGestaoPresencaNotas (setor › treinamento › data › Buscar) ─► janela de impressão
   ├─ [5] Fila e Emissão Lote ──► view cert-lista-view (3 botões de lote + barra de progresso)
   ├─ [6] Vencimentos (NR) ─────► view cert-vencimentos-view
   ├─ [7] Assinaturas Digitais ─► view cert-assinaturas-view
   └─ [8] Indicadores ──────────► view cert-indicadores-view
Públicas: ?inscricao=<ID> (PublicForm), ?validar=<chave> (Validador)
Feedback: appAlertModal ("Entendi") depois de quase toda ação; appConfirmModal antes de ação destrutiva ou de lote.
```
Total: 1 hub, 6 views, 7 modais de trabalho, 2 modais genéricos e 2 páginas públicas.

**Nuvem** (páginas servidas pelo servidor, menu lateral do módulo, `src/modulos.ts:247-339`):
```
Módulo "Certificados e Treinamentos" (12 itens no menu):
  Turmas /turmas ─► popup "Abrir turma" ─► ficha /turmas/:id com 4 abas:
        Turma (dados, situação, instrutores, corrigir, excluir, cancelar)
        Inscrições (link público, tabela com gaveta "ações", corrigir, CPF, procurar e inscrever, externo, lote)
        Presença e notas (grade por dia, folha de um dia, marcar todos)
        Emissão (campos do certificado, emitir, PDF/ZIP, e-mail, reemitir)
     + /turmas/:id/inscricoes/lote, página do link (turma_link), lista de presença .docx
  Meus treinamentos · Meus certificados (titular)
  Certificados · Fila de emissão · E-mails · Reciclagem · Indicadores
  Catálogo · Modelos (lista ► ficha do modelo) · Instrutores · Participantes (mesclar)
Públicas: /inscricao/:token, /validar[/:chave], /certificados/acesso[/:token]
Feedback: mensagem na página de volta (303 + aviso); popup de confirmação só em concluir, cancelar, excluir, emitir em lote e anular.
```
Total: cerca de 14 telas internas, 3 públicas e popups por ação.

### 5.2 Passos por tarefa (cliques contados a partir do módulo aberto; digitação não conta)

| Tarefa | IntegraSST | Nuvem | Diferença |
|---|---|---|---|
| **Criar turma com inscrição por link e obter o link** | Cartão 2, choice "Turma Aberta", formulário, "Gerar Link Público", "Entendi", cartão 3 (a criação deixa o usuário no hub), "Copiar Link", "Copiar", "Entendi". **≈9 cliques, 3 telas.** O link pode ser copiado de novo a qualquer momento (2 cliques). | Turmas, "Abrir turma", formulário, salvar (cai na ficha), "Abrir inscrições" (âncora), botão "Abrir inscrições" (POST), aba Inscrições, "Gerar o link e o QR", copiar à mão (Ctrl+C), "Voltar à turma". **≈9 a 10 cliques, 3 telas, e o formulário recusa se faltar "inscrições até".** Perdeu o link? É preciso trocar por outro e redistribuir. | Esforço parecido. A nuvem exige conhecer a máquina de estados (lacunas 3 e 4). |
| **Criar turma "fechada" com lista de participantes** | Cartão 2, "Turma Fechada", formulário com N linhas ("+ participante" por linha), salvar, "Entendi". **≈4 + N cliques, 1 modal.** | Abrir turma, salvar, aba Inscrições, "Inscrever em lote", colar, "Conferir", "Inscrever". **≈7 cliques, para qualquer N** (ou, para servidores já na base, procurar e "inscrever" a cada um). | A nuvem é melhor para N > 3 (colar da planilha). |
| **Participante se inscreve pelo link** | Abre, preenche 3 obrigatórios (nome, CPF, e-mail) e 2 opcionais, "Confirmar". Fica **inscrito na hora**. CSSO: 0 cliques. | Abre, preenche nome, vínculo, SIAPE (servidor), e-mail opcional, organização e marca o consentimento, "Pedir a vaga". CSSO: **2 cliques por pedido** (gaveta e "Aceitar"), com recarga de página. | Regressão grande no lado da CSSO (lacuna 1). Para a pessoa: um campo a mais (vínculo) e uma caixa a marcar; CPF e WhatsApp saem. |
| **Adicionar 1 participante avulso** | Cartão 3, "Gerir participantes", preencher a linha, "Adicionar", "Entendi". **4 cliques.** | Turmas, ficha, aba Inscrições, digitar e "Procurar", "inscrever". **4 a 5 cliques.** Se a pessoa não estiver na base: "Cadastrar participante externo", formulário, enviar (+2). | Equivalente. |
| **Lançar presença e nota** | Cartão 4, (setor), treinamento, data, "Buscar", marcar faltas e digitar notas, "Salvar", "Entendi". **≈6 cliques + 1 por falta.** A turma é localizada por treinamento e texto da data, e há uma só "presença" por pessoa. | Turmas, ficha, aba Presença, "Marcar todos presentes" (turma de 1 dia) ou "Lançar a folha de um dia"; desmarcar faltas célula a célula; nota por linha (troca parcial, sem botão salvar). **≈4 cliques + 1 por falta.** Depois, "Concluir turma…" e confirmar (+3). | Equivalente. A nuvem controla por dia e calcula a frequência. |
| **Emitir os certificados de uma turma** | Cartão 5, filtrar o curso, marcar todos, "1. Gerar Protocolos", confirmar, "Entendi", **marcar de novo** (a tabela recarrega), "2. Gerar PDFs", confirmar, esperar cerca de 10 a 20 s por certificado (`sleep(6000)` e exportação), "Entendi". **≈10 cliques e vários minutos.** | Ficha, aba Emissão, "Emitir os certificados", confirmar (a confirmação diz quantos números vai usar). **≈4 cliques, uma requisição.** Também pela fila, com os aptos já marcados: 2 cliques. | A nuvem é bem melhor. Risco de tempo em lote grande (lacuna 5). |
| **Enviar os certificados por e-mail** | Na fila: marcar (de novo), "3. Disparar E-mails", confirmar, esperar a barra, "Entendi". **≈4 cliques**, um por um no navegador (a aba tem de ficar aberta). | Aba Emissão, "Enviar por e-mail os não enviados" (1 clique), ou na fila, etapa Emitidos, marcar e "Enviar". O envio é em segundo plano e o resultado aparece em `/certificados/emails`. | A nuvem é melhor: não depende da aba aberta e tem repetição automática. |
| **Ver vencimentos / reciclagem** | Cartão 6, filtrar situação ou texto. **1 a 2 cliques**, só leitura. | Reciclagem, ficha de situação e busca. **1 a 2 cliques**, mais "Avisar por e-mail os marcados" e o aviso automático noturno. | A nuvem é melhor. |
| **Corrigir um certificado errado** | Fila, "Excluir PDF e refazer", confirmar, "Entendi", e repetir os passos 2 e 3 da emissão para essa linha. **≈8 cliques** (o número e a chave se perdem). | Ficha do certificado, "Corrigir certificado", formulário com motivo, enviar. **≈3 cliques**, com substituto encadeado. | A nuvem é melhor. |
| **Encerrar e reabrir inscrições** | Encerrar: não existe botão (só automático por prazo ou lotação). Reabrir: cartão 3, "Reabrir", confirmar, "Entendi" (3 cliques). | Ficha, aba Turma, "Fechar inscrições" ou "Abrir inscrições" (1 POST). **2 a 3 cliques.** Fechar não desliga o token, mas o cartaz passa a mostrar o motivo (`fechada`). | Equivalente. Na nuvem não há fechamento automático por lotação (lacuna 2) nem selo de prazo vencido na lista (lacuna 7). |

### 5.3 Principais diferenças de UX, em síntese

1. **Hub × menu.** O legado concentra tudo num hub com 8 cartões numerados e um guia de 4 passos que ensina a ordem do trabalho. A nuvem espalha em 12 itens de menu e 4 abas na ficha. É mais completa, mas não mostra a sequência depois do primeiro uso (o "Primeiros passos" só aparece com `/turmas` vazia).
2. **Modal × página.** O legado trabalha em modais sobre a mesma tela e confirma tudo com "Entendi". A nuvem navega por páginas e popups, com retorno por 303. São menos cliques de confirmação e mais navegação entre abas.
3. **Centro na turma × centro na fila.** No legado, a fila global (cartão 5) é o lugar da emissão. Na nuvem, o ponto natural é a aba Emissão da turma; a fila global existe, mas é secundária.
4. **Link público.** No legado, o link é eterno, copiável a qualquer hora e grava a inscrição direto. Na nuvem, o link é seguro (hash, expira, aparece uma vez, tem QR), mas custa mais à CSSO: aceitar um a um, não poder recopiar e precisar abrir as inscrições antes. As lacunas 1 a 4 concentram quase todo o esforço extra do módulo.
5. **Emissão e e-mail.** A nuvem reduz o processo de 3 etapas (cerca de 10 cliques e minutos de espera com a aba aberta) a 1 ou 2 cliques, com e-mail em fila de fundo. É o maior ganho de esforço.
