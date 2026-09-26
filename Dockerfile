# Bot WhatsApp + Mistral : processus permanent (WebSocket Baileys + SQLite + Socket.io)
FROM node:20-bookworm-slim

# Outils de compilation au cas où better-sqlite3 doit compiler (prebuilds sinon)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# /data = volume persistant (bot.db + auth_info). Voir railway.json / dashboard.
VOLUME ["/data"]

CMD ["node", "server.js"]
