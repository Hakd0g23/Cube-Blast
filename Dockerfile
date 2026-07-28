FROM node:22-bookworm-slim

WORKDIR /app

# Copied and installed before the rest of the source so this layer is only
# invalidated when dependencies actually change, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci
# Installs Chromium + OS-level deps matching the exact `playwright` npm
# version pinned above (used by tests/drag-resize.playwright.mjs and
# tools/sprite-bake/bake.mjs) — avoids depending on Microsoft's separate
# playwright:*-jammy image tags, which lag npm releases.
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 8000

# Static site, no build step: editing files under the bind mount takes
# effect on the next browser refresh, same as the README's prior
# `python3 -m http.server` workflow.
CMD ["npx", "serve", "-l", "8000", "."]
