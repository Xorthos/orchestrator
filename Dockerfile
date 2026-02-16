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

RUN mkdir -p /data

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
