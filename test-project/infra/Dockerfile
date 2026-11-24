FROM node:18
USER root
ENV DB_PASSWORD="super_secret_123"
ADD https://example.com/payload.tar.gz /tmp
EXPOSE 3306
CMD ["node", "app.js"]
