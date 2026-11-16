# syntax=docker/dockerfile:1
# Multi-stage build: the build stage has devDeps (pdfkit) so it can (re)generate
# the pdf/docx fixtures if needed; the runtime stage installs only prod deps.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build-time fixture generation is safe to fail (committed binaries exist);
# it also warms node_modules so the later copy step is a filesystem move.
COPY scripts ./scripts
COPY fixtures/corpus ./fixtures/corpus
RUN node --disable-warning=ExperimentalWarning scripts/make-pdf-fixture.js && \
    node --disable-warning=ExperimentalWarning scripts/make-docx-fixture.js || true

# --- runtime stage ---
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY --from=build /app/fixtures ./fixtures
COPY README.md ./

# RAG-Desk defaults fully offline (no LLM, no embedding, no external calls).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
