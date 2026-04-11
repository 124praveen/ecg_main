# Use Node.js base image with Debian (has apt-get for installing Java)
FROM node:20-slim

# Install Java Runtime (needed for bsedecoder-2.0.0.jar)
RUN apt-get update && \
    apt-get install -y --no-install-recommends default-jre-headless && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify Java is available
RUN java -version

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the backend code
COPY . .

# Expose port (Render sets PORT env var)
EXPOSE 3001

CMD ["node", "server.js"]
