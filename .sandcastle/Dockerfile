FROM node:22-bookworm

# Base tooling + Tauri 2 Linux build dependencies so the agent can run
# `cargo check` / `cargo test` / `cargo clippy` in apps/desktop. libdbus-1-dev
# is for the keyring crate (secret-service backend on Linux).
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  build-essential \
  pkg-config \
  libssl-dev \
  libdbus-1-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# UID/GID alignment with the host user (sandcastle docker build-image defaults).
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Agent CLI.
RUN npm install -g @anthropic-ai/claude-code@latest

# Rust toolchain, shared system-wide so the agent user can use it without a
# per-user rustup install. Version matches CI (stable) and Cargo.toml's
# rust-version floor.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --component clippy \
  && chmod -R a+w $RUSTUP_HOME $CARGO_HOME

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR} and overrides
# the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
