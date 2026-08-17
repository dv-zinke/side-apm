FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "-r", "@opentelemetry/auto-instrumentations-node/register", "server.js"]
