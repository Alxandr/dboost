###################################################################################
#
# CLIENT BUILDERS
#
###################################################################################

FROM docker.io/node:lts as client-builder
WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

###################################################################################
#
# SERVER BUILDERS
#
###################################################################################

FROM docker.io/lukemathwalker/cargo-chef:latest-rust-slim-bookworm AS chef
ARG TARGETARCH=amd64

ENV CARGO_TERM_COLOR=always
RUN apt-get update && apt-get install -y curl ca-certificates clang && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /mold

ADD https://github.com/rui314/mold/releases/download/v2.1.0/mold-2.1.0-x86_64-linux.tar.gz /mold/mold-amd64.tar.gz
ADD https://github.com/rui314/mold/releases/download/v2.1.0/mold-2.1.0-aarch64-linux.tar.gz /mold/mold-arm64.tar.gz

RUN tar -xvf /mold/mold-${TARGETARCH}.tar.gz --strip-components 1 -C /mold \
	&& mv /mold/bin/mold /usr/bin/mold \
	&& chmod +x /usr/bin/mold

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
ARG GIT_REF="unknown"
COPY --from=planner /app/recipe.json recipe.json

# Build dependencies - this is the caching Docker layer!
RUN cargo chef cook --release --workspace --recipe-path recipe.json

# Build application
COPY . .
RUN cargo build --release --workspace

###################################################################################
#
# RUNTIME BASE IMAGE
#
###################################################################################

FROM docker.io/debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y curl tini && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

###################################################################################
#
# TARGETS
#
###################################################################################

# AWS DEPLOY JOB
FROM runtime as deployer
COPY --from=builder "/app/target/release/dbost-jobs-deploy" /usr/local/bin
CMD ["sh", "-c", "/usr/local/bin/dbost-jobs-deploy"]

# DB MIGRATOR JOB IMAGE
FROM runtime as migrator
COPY --from=builder "/app/target/release/dbost-migration" /usr/local/bin
CMD ["sh", "-c", "/usr/local/bin/dbost-migration"]

# DB CLEANER JOB IMAGE
FROM runtime as db-cleaner
COPY --from=builder "/app/target/release/dbost-jobs-db-cleanup" /usr/local/bin
CMD ["sh", "-c", "/usr/local/bin/dbost-jobs-db-cleanup"]

# DBOST WEB IMAGE
FROM runtime as web
COPY --from=builder /app/target/release/dbost /usr/local/bin
COPY --from=client-builder /app/public /var/www/public
ENV WEB_PUBLIC_PATH=/var/www/public

EXPOSE 8000

CMD ["/usr/local/bin/dbost"]
