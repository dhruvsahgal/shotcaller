FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY app ./app
COPY public ./public
COPY prompts ./prompts
COPY docker-entrypoint.sh ./
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
