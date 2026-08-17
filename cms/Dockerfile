# Bewusst bookworm-slim statt alpine (anders als dashboard/Dockerfile):
# sharp bringt native Bibliotheken mit, und die glibc-Builds sind die von sharp
# selbst getesteten. Auf musl gibt es zwar Prebuilds, aber die Fehlersuche bei
# einem fehlgeschlagenen Bild-Upload auf einem Produktivsystem ist die
# eingesparten ~40 MB Image-Groesse nicht wert.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Next kopiert bei output:standalone nur, was der Trace findet — sharps native
# Binaries liegen ausserhalb davon und muessen explizit mit.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
EXPOSE 3002
ENV PORT=3002
CMD ["node", "server.js"]
