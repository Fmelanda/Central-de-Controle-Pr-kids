ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && \
    chown -R node:node /app && \
    chmod +x /usr/local/bin/docker-entrypoint.sh
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
