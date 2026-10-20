# From the repository root:
#   docker build -f broker/Dockerfile -t flood-broker .
#   docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 flood-broker
FROM rust:1-bookworm AS build
WORKDIR /src
COPY rust/ rust/
RUN cd rust && cargo build --locked --release -p flood-broker

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/rust/target/release/flood-broker /usr/local/bin/flood-broker
ENV HOST=0.0.0.0 PORT=8787
USER nobody
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["flood-broker"]
