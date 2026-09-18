# swarm-teamd — the Swarm team daemon (FSL-1.1-ALv2, source-available; not part of the
# Apache-2.0 free tier). Built by release.yml after `bun run build:team`; context is the repo root:
#   docker build -f packages/team/Dockerfile -t swarm-teamd .
#   docker run -p 7878:7878 -v swarm-team:/data -e SWARM_TEAM_TOKEN=… swarm-teamd
# or write /data/team.toml once with: docker run -it -v swarm-team:/data swarm-teamd setup
FROM oven/bun:1-slim
LABEL org.opencontainers.image.source="https://github.com/ra3orblade/swarm" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.title="swarm-teamd" \
      org.opencontainers.image.description="Swarm team daemon: the self-hosted control plane for a team of Swarm machines"
WORKDIR /app
COPY npm-team/dist/swarm-teamd.js npm-team/LICENSE.md ./
RUN mkdir -p /data && chown bun:bun /data
ENV SWARM_HOME=/data SWARM_TEAM_HOST=0.0.0.0 SWARM_TEAM_PORT=7878
VOLUME /data
EXPOSE 7878
USER bun
ENTRYPOINT ["bun", "/app/swarm-teamd.js"]
