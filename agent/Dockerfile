FROM python:3.12-slim

# Install git (required for worktree operations)
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better layer caching)
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e "."

# Copy source
COPY . .

# Non-root user for security
RUN useradd -m -u 1000 ponenix \
    && mkdir -p /home/ponenix/.pnx \
    && chown -R ponenix:ponenix /app /home/ponenix/.pnx
USER ponenix

ENV HOME=/home/ponenix
ENV PNX_REPOS_DIR=/home/ponenix/.pnx/repos

EXPOSE 8001

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
