# O sistema rodando num servidor Linux

Escrito na versão 1.43.0, na homologação em `srv-home` (Ubuntu 26.04).

Este arquivo é para a máquina que **fica ligada** e atende a rede — no lugar de
um PC de trabalho, onde o sistema só existe enquanto alguém está logado. O que
muda em relação ao Windows são três coisas: quem sobe o sistema (systemd, e não
um `.bat` na pasta Inicializar), quem faz o backup (um *timer*, e não a Tarefa
Agendada) e o caminho do LibreOffice (o `pdf.py` já procura `/usr/bin/soffice`).

> **Com que dados.** Esta homologação roda com o **ambiente de teste**: banco
> próprio em `dados-teste/`, gente inventada, porta 8766. Dado real de servidor
> da UFVJM **não** vai para máquina fora da instituição: o controlador é a
> UFVJM (`docs/ROPA.md`), e a `POLITICA_RETENCAO.md` §5 exige autorização
> formal e contrato para qualquer destino de terceiro. Para o dado real sair do
> PC do setor, o caminho é a infraestrutura institucional — e antes dela, o
> encarregado (DPO) indicado, que segue pendente.

---

## 1. O que precisa estar na máquina

```bash
sudo apt install libreoffice-writer      # PDF; sem ele sai o .docx com aviso
curl -LsSf https://astral.sh/uv/install.sh | sh   # se ainda não houver uv
cd /caminho/do/projeto && uv sync --extra dev
```

`libreoffice-writer` basta: o sistema só converte `.docx`. O pacote
`libreoffice` completo traz Calc, Impress e Draw, que aqui não servem para
nada.

## 2. Montar o ambiente e o HTTPS

```bash
uv run python -m ferramentas.ambiente_teste_cli --host 0.0.0.0
uv run python -m ferramentas.certificado_tls srv-home 172.16.1.20 --pasta dados-teste/tls
```

Os nomes são **todos** os endereços pelos quais as estações abrem o sistema.
Acrescente os que faltarem (o IP do Tailscale, por exemplo). Ponha as duas
linhas que o comando imprime no fim de `dados-teste/.env`. O passo a passo do
HTTPS, incluindo a instalação da raiz nas estações, está em
`docs/HTTPS_NA_REDE.md`.

## 3. Instalar o serviço

Os modelos estão em `ferramentas/systemd/`, com `%PASTA%` e `%USUARIO%` no
lugar do que muda de máquina para máquina — caminho de usuário não entra em
arquivo versionado. Este comando troca os dois e instala:

```bash
PASTA=$(pwd)
for u in csso.service csso-backup.service csso-backup.timer; do
  sed -e "s#%PASTA%#$PASTA#g" -e "s#%USUARIO%#$USER#g" "ferramentas/systemd/$u" \
    | sudo tee "/etc/systemd/system/$u" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now csso.service csso-backup.timer
```

Conferir:

```bash
systemctl status csso.service          # tem de dizer "active (running)"
journalctl -u csso -n 20               # a janela que o INICIAR.bat mostrava
systemctl list-timers csso-backup      # quando é o próximo backup
```

O serviço sobe no boot, sem ninguém logado, e reinicia sozinho se cair
(`Restart=on-failure`).

## 4. Conferir de outra máquina

```
https://srv-home:8766/
```

Contas do ambiente de teste, senha `teste2026`: `coordenador`, `engenheiro`,
`tecnico`, `medico`, `secretaria`, `almoxarife`, `admin`, `servidor`.

Se não abrir de fora, o sistema está ligado e quem barra é o firewall:

```bash
sudo ufw status                        # inactive = não é ele
sudo ufw allow from 172.16.1.0/24 to any port 8766 proto tcp
```

Libere **a faixa da rede local**, não a porta para todo mundo: abrir para tudo
entrega a tela de login a qualquer máquina que alcance o servidor.

## 5. Atualizar para uma versão nova

```bash
cd /caminho/do/projeto
git pull
uv sync --extra dev
sudo systemctl restart csso.service
```

A migração do banco roda sozinha no `lifespan` (Alembic). Se a atualização
mexeu no front (`frontend/`), o bundle já vem pronto em `app/estaticos/app/`.

## 6. O que esta máquina ainda não tem, e uma de verdade teria

Homologação não é produção, e a diferença é honesta escrever:

- **Nada disso está sob a UFVJM.** Máquina, disco e rede são de terceiro em
  relação ao controlador (§ do quadro lá em cima).
- **O backup fica no mesmo disco** (`dados-teste/backups`). Backup que morre
  com a máquina não é backup; num servidor de verdade, o destino é outro disco
  ou outra máquina (`CSSO_BACKUP_DESTINO`).
- **Não há monitoramento**: se o serviço morrer de um jeito que o `Restart` não
  cubra, ninguém fica sabendo.
- **A senha do backup (`CSSO_BACKUP_SENHA`)** vive no `.env` da mesma máquina.
  É aceitável em homologação; em produção, a perda da senha é a perda do
  backup.

## 7. Parar e desinstalar

```bash
sudo systemctl disable --now csso.service csso-backup.timer
sudo rm /etc/systemd/system/csso{,-backup}.service /etc/systemd/system/csso-backup.timer
sudo systemctl daemon-reload
```

Isso derruba e desinstala o serviço; a pasta do projeto e os dados de teste
ficam como estão.
