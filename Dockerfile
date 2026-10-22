FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js ./
COPY lib ./lib
COPY views ./views
COPY public ./public
# As configurações do painel ficam em DATA_DIR (no Railway, o volume montado; sem volume, /app/storage).
# Roda como root de propósito: o Railway monta o volume como root, e com outro usuário o servidor não
# conseguiria gravar nele (as alterações do painel sumiriam a cada reinício).
RUN mkdir -p /app/storage && chown node:node /app/storage
EXPOSE 8080
CMD ["node", "server.js"]
