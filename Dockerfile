FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
CMD ["npm", "start"]
