FROM node:20-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm install --production

# Copy all source files
COPY . .

# Ensure data directory and empty member store
RUN mkdir -p data && \
    [ -f data/members.json ] || echo '[]' > data/members.json && \
    [ -f data/stock.json ] || echo '{}' > data/stock.json

# Set permissions for non-root user
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
