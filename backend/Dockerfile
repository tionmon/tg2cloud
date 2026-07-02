FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && npm prune --omit=dev
RUN mkdir -p /app/data/tmp /app/data/uploads
EXPOSE 51947
CMD ["node", "dist/index.js"]
