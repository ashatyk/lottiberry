# syntax=docker/dockerfile:1.7

############ Build ############
FROM node:22-bookworm AS base

# install node
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential python3 pkg-config \
  libcairo2-dev libpango1.0-dev libjpeg-dev libpng-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

# ---- Dependencies ----
FROM base AS dependencies
#copy current context
COPY . .
#for faster install
# install and copy production node_modules aside
# then install ALL node_modules, including 'devDependencies'
RUN npm set progress=false \
    && npm config set depth 0 \
    && npm i --only=production \
    && cp -R node_modules prod_node_modules \
    && npm i

RUN npm run build

# ---- Release ----
FROM base AS release
# copy production node_modules
COPY --from=dependencies /app/prod_node_modules ./node_modules
COPY --from=dependencies /app/dist ./dist

ENV PORT 3000
CMD echo ${PORT}
#node in production
ENV NODE_ENV production

EXPOSE ${PORT}

#run under 'node' user for security reasons
USER node

#same as npm run serve but better for Handling Kernel signals
CMD ["node","./dist/server.js"]
