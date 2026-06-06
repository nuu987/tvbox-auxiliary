# Typescript compile
FROM docker.1ms.run/node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts --registry https://registry.npmmirror.com && \
    npm rebuild esbuild

COPY . .

RUN npm run build:node

# Runtime copy
FROM docker.1ms.run/node:20-alpine
WORKDIR /app

COPY --from=builder /app/dist ./dist
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN apk add --no-cache tzdata
RUN mkdir -p /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
ENV TZ=Asia/Shanghai
VOLUME /app/data
EXPOSE 5678

CMD ["node", "dist/server.js"]
