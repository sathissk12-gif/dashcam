FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000 7788 8088 1078
CMD ["node", "backend/server.js"]
