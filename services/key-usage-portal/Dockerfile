FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
ARG PORTAL_BASE_PATH=/
RUN PORTAL_BASE_PATH=${PORTAL_BASE_PATH} npm run build

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --from=build --chown=node:node /build/dist ./web/dist
USER node
EXPOSE 8080
CMD ["node", "server/main.mjs"]
