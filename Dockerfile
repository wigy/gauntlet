FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY tools ./tools
COPY public ./public

RUN npm run build

# Saved players, "My levels" and imported arcade maps all live in /data (mount a volume there). The arcade maps are
# Atari's layouts, so they are never baked into the image: run the importers in the container, they write to
# /data/arcade (Gauntlet) and /data/arcade2 (Gauntlet II).
ENV DATA_DIR=/data
RUN mkdir -p /data && chmod 777 /data \
  && rm -rf public/levels/gauntlet1 public/levels/gauntlet2 \
  && ln -s /data/arcade public/levels/gauntlet1 && ln -s /data/arcade2 public/levels/gauntlet2 \
  && ln -s /data/import-cache .import-cache

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "mkdir -p /data/arcade /data/arcade2 /data/import-cache && exec npx tsx server/main.ts"]
