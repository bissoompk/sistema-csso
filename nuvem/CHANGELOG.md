# Changelog — Sistema SISA (nuvem)

## 2.0.0 — preparação para dados reais (novembro de 2026)

Revisão pré-produção com agentes (36), 28 achados confirmados, tratados em quatro lotes.

### Segurança e conta
- Segundo fator de entrada opcional (TOTP, com 8 códigos de recuperação); a administração
  pode desligá-lo em `/usuarios`.
- Senha mínima de 8 caracteres para todos.
- Limite por IP do link do participante passou para o banco.
- Modelo `.docx`: o tamanho descompactado é conferido de verdade (zip bomb).
- `nodemailer` 10.3.1; `hono` e `vite` atualizados (`npm audit fix`).

### Dados e privacidade
- Trilha de servidores só com identificadores (campo alterado, sem valores).
- Planilhas importadas apagadas do Storage após 7 dias.
- Matrícula SIAPE com mais de 7 dígitos vai para pendência, não é cortada.

### Operação
- O build só migra e semeia em produção.
- Aviso diário por e-mail (`CSSO_ALERTA_EMAIL`) com backup atrasado, cadeia rompida, rotina parada
  ou e-mail parado.
- Rotinas noturnas (cadeia, expurgos, pendências) rodam na função de fundo, depois do backup.
- Dockerfile do conversor de PDF com as fontes Montserrat e Open Sans.

### Correções
- Comunicação de acidente enviada duas vezes (duplo clique) não gera dois protocolos.
- Entrega de EPI e requisição travam a linha contra corrida.
- Cadastro duplicado responde 409 com mensagem clara.

### Ainda pendente (fora do código)
Encarregado (DPO), contratos com os operadores, região da função no Netlify, backup com
recuperação até um ponto no tempo (plano Pro do Supabase), publicação da imagem do conversor.
