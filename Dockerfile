FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=4321 INSTANCE_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The instance folder has to exist, and belong to the unprivileged user, before it is declared
# a volume: Docker seeds a new named volume from the image's directory, ownership included.
# Without this the container starts as `node` against a root-owned /data and every request
# fails with "unable to open database file".
#
# A bind mount brings its own ownership instead, so the host directory must be writable by
# uid 1000 (`chown -R 1000:1000 ./instances/acme`) or by whatever `--user` you pass.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 4321
USER node
CMD ["node", "dist/server/entry.mjs"]
