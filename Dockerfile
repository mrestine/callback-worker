# --- build: compile TS -> dist/ -------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime: prod deps + dist + prompts --------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY prompts ./prompts
RUN mkdir -p /app/data /app/secrets

CMD ["node", "dist/main.js"]
