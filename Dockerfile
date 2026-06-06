# Typescript compile
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./

RUN npm ci && npm rebuild esbuild

COPY . .

RUN npm run build:node

# Runtime copy
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/dist ./dist
RUN apk add --no-cache tzdata
RUN mkdir -p /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
ENV TZ=Asia/Shanghai
VOLUME /app/data
EXPOSE 5678

CMD ["node", "dist/server.js"]
