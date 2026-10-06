FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force && apt-get purge -y make g++ && apt-get autoremove -y
COPY server ./server
COPY public ./public
COPY sandbox ./sandbox
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 SANDBOX_MODE=socket SANDBOX_SOCKET=/sock/sandbox.sock
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
