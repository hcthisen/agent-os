FROM node:20-alpine

COPY scripts/init-secrets.mjs /scripts/init-secrets.mjs

CMD ["node", "/scripts/init-secrets.mjs"]
