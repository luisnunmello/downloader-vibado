FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY views ./views
COPY public ./public
# ffmpeg cuts videos (the "Cut video" feature). Remove this line to keep the image small and turn the feature off.
RUN apk add --no-cache ffmpeg

# Uploaded files live in /data, which docker-compose mounts as a volume.
ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
