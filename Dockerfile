# Stage 1: Build
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json .
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

RUN apk add --no-cache git openssh-client tini

WORKDIR /app

COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/package.json .

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN mkdir -p /data /workspace/repo

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
