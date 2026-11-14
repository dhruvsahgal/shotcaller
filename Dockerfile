FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY app ./app
COPY public ./public
COPY prompts ./prompts
COPY scripts/validate-collector-output.mjs ./scripts/validate-collector-output.mjs
COPY docker-entrypoint.sh ./
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3030)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
