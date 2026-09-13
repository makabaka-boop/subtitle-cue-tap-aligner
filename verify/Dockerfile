# Python 3.12 + Node 20 + Playwright browsers are preinstalled in this image.
FROM mcr.microsoft.com/playwright:v1.52.0-noble

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Browsers matching this Playwright release already live in the base image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY verify-entrypoint.sh /usr/local/bin/verify-entrypoint.sh
RUN chmod +x /usr/local/bin/verify-entrypoint.sh

# Run as the owner of the bind-mounted workspace.
RUN useradd --uid 1000 --create-home verify
USER verify
