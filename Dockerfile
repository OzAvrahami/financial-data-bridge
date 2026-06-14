FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p runtime/sessions runtime/checkpoints runtime/seen runtime/exports

EXPOSE 3000

CMD ["node", "packages/bridge-core/src/api/index.js"]
