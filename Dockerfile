FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --registry https://registry.npmmirror.com && \
    npm rebuild esbuild
COPY . .
RUN npm run build:node

FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
EXPOSE 5678

CMD ["node", "dist/server.js"]
