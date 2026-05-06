FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p .sessions .checkpoints .seen exports

EXPOSE 3000

CMD ["node", "src/api/index.js"]
