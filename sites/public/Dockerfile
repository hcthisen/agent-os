FROM nginx:1.27-alpine

COPY . /opt/agent-os/public-default/
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.d/40-init-public-volume.sh /docker-entrypoint.d/40-init-public-volume.sh

RUN chmod +x /docker-entrypoint.d/40-init-public-volume.sh && \
    find /opt/agent-os/public-default -type d -exec chmod 0777 {} \; && \
    find /opt/agent-os/public-default -type f -exec chmod 0666 {} \;

EXPOSE 80
