# Global variable declaration:
# Build to serve under Subdirectory BASE_URL if provided, eg: "ARG BASE_URL=/pdf/", otherwise leave blank: "ARG BASE_URL="
ARG BASE_URL=

# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY vendor ./vendor
ENV HUSKY=0
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 60000 && \
    npm config set fetch-retry-maxtimeout 300000 && \
    npm config set fetch-timeout 600000 && \
    npm ci
COPY . .

# Build without type checking (vite build only)
# Pass SIMPLE_MODE environment variable if provided
ARG SIMPLE_MODE=true
ENV SIMPLE_MODE=$SIMPLE_MODE
ARG COMPRESSION_MODE=all
ENV COMPRESSION_MODE=$COMPRESSION_MODE

# Railway environment variables for API integration
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

ARG VITE_USE_CDN=true
ENV VITE_USE_CDN=$VITE_USE_CDN

# global arg to local arg
ARG BASE_URL
ENV BASE_URL=$BASE_URL

RUN if [ -z "$BASE_URL" ]; then \
    npm run build -- --mode production; \
    else \
    npm run build -- --base=${BASE_URL} --mode production; \
    fi

# Production stage
FROM nginxinc/nginx-unprivileged:stable-alpine-slim

LABEL org.opencontainers.image.source="https://github.com/Champ-Deep/ChamPDF"
LABEL org.opencontainers.image.url="https://github.com/Champ-Deep/ChamPDF"

# global arg to local arg
ARG BASE_URL

# Set this to "true" to disable Nginx listening on IPv6
ENV DISABLE_IPV6=false

# Backend URL for the /api/ reverse proxy. Override at runtime (e.g. on
# Railway, set BACKEND_URL to the private URL of the FastAPI service).
# When unset, /api/ requests will 502 because nothing is listening on
# localhost:8000 inside this container.
ENV BACKEND_URL=http://localhost:8000

# Route nginx.conf through the unprivileged image's envsubst entrypoint
# so ${BACKEND_URL} is substituted at container start. Output dir is
# overridden so the templated file lands at /etc/nginx/nginx.conf
# (not the default /etc/nginx/conf.d/). The filter restricts substitution
# to BACKEND_URL only, so nginx's own $host/$uri/$remote_addr/etc.
# variables are left untouched.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx
ENV NGINX_ENVSUBST_FILTER=^BACKEND_URL$

COPY --chown=nginx:nginx --from=builder /app/dist /usr/share/nginx/html${BASE_URL%/}
COPY --chown=nginx:nginx nginx.conf /etc/nginx/templates/nginx.conf.template
COPY --chown=nginx:nginx --chmod=755 nginx-backend-url-normalize.envsh /docker-entrypoint.d/19-normalize-backend-url.envsh
COPY --chown=nginx:nginx --chmod=755 nginx-ipv6.sh /docker-entrypoint.d/99-disable-ipv6.sh
RUN mkdir -p /etc/nginx/tmp && chown -R nginx:nginx /etc/nginx/tmp

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
