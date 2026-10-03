# The tenant worker (R-22): PowerShell 7 with the ExchangeOnlineManagement module, behind a small
# Node HTTP server (server.mjs). Built on its own, never into the backend image.
#
#   docker build -t mailexpert-tenant-worker deploy/tenant-worker
#   docker run --rm --entrypoint node mailexpert-tenant-worker --test /app/worker.test.mjs
#
# Pins: the module 3.10.x needs PowerShell 7.6+, and Microsoft publishes no 7.6 image on MCR yet
# (2026-10), so 3.9.2 on 7.5 (R-22: "pin 3.9.2 on 7.4+"). The base is pinned by digest: the 7.5 tag
# moves. The image is amd64 only (the base has no arm64 manifest).
# node 22.23.3, pinned like the base: only its binary is copied.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node

FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04@sha256:042240d57ec9e47e511033b92625a8d95875ee5860af3015992c248b58a8be81

ARG EXO_MODULE_VERSION=3.9.2
# HOME on /tmp: pwsh writes its config and module cache there, and the container runs with a
# read-only root file system (/tmp is a tmpfs in docker-compose.yml).
ENV HOME=/tmp \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    POWERSHELL_UPDATECHECK=Off \
    TENANT_PFX_PATH=/certs/app.pfx \
    TENANT_PFX_PASSWORD_FILE=/run/secrets/tenant_pfx_password \
    TENANT_WORKER_PORT=8080

# The install runs as root with HOME=/tmp: what it leaves there is removed. The module's import
# looks into the all-users Scripts/InstalledScriptInfos folder (PowerShellGet); without it the
# unprivileged worker user is refused there and the import fails.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command \
      "\$ErrorActionPreference = 'Stop'; \
       Install-PSResource -Name ExchangeOnlineManagement -Version '${EXO_MODULE_VERSION}' -Scope AllUsers -TrustRepository -Quiet; \
       \$m = Get-Module -ListAvailable ExchangeOnlineManagement; \
       if (\$m.Version.ToString() -ne '${EXO_MODULE_VERSION}') { throw \"ExchangeOnlineManagement \$(\$m.Version) installed\" }" \
 && rm -rf /tmp/.config /tmp/.local /tmp/.cache /tmp/* \
 && mkdir -p /opt/microsoft/powershell/7/Scripts/InstalledScriptInfos \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin worker

COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --chown=root:root ops.mjs server.mjs runner.ps1 runner.lib.ps1 cert.ps1 worker.test.mjs ./

USER worker
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.TENANT_WORKER_PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/server.mjs"]
