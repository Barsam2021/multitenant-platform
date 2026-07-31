FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx curl bash git age rclone gzip
RUN curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc

# Nixpacks v1.41.0 (gepinnt, siehe 01_architecture_blueprint.md § 6)
RUN curl -sSL -o /tmp/nixpacks.tar.gz \
      https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks \
    && chmod +x /usr/local/bin/nixpacks \
    && rm /tmp/nixpacks.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/index.js"]
