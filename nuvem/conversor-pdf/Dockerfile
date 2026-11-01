# O conversor de PDF (Gotenberg/LibreOffice) com as fontes que os modelos de
# certificado usam. A imagem padrão só traz um conjunto básico de fontes: o
# modelo que pede uma ausente sai em outra (Noto Sans), de largura diferente.
# Passo a passo em `PRODUCAO.md` §2.1.1.
#
# As fontes vêm dos pacotes do Debian (licença livre, OFL): nada é baixado nem
# guardado no repositório. Para somar outra, acrescente o pacote abaixo
# (`apt-cache search fonts-` lista os nomes) e publique de novo.
FROM gotenberg/gotenberg:8

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-montserrat fonts-open-sans \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f
# a imagem original roda sem privilégio: volta a ele
USER gotenberg
