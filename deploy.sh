#!/usr/bin/env bash
set -Eeuo pipefail

# Anchor paths to this script, including when launched outside the repository.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$repo_root"
compose=(docker compose --project-directory "$repo_root" --file "$repo_root/compose.yaml")
demo_db='data/demo/secureops-demo.db'

print_help() {
  cat <<'HELP'
SecureOps MCP local containers (Docker Compose v2)

Usage: ./deploy.sh <command> [arguments]
  build                  Build production, checks, and demo images
  start                  Build, seed absent fictional resources, and start MCP
  stop                   Stop MCP; retain its container and database volume
  restart                Build and recreate MCP; preserve database and identities
  status                 Show this project's containers
  logs                   Follow MCP diagnostics (Ctrl+C stops following)
  mcp                    Connect protocol stdio to the running MCP container
  cli <command> [flags]  Run the CLI in the running container
  seed                   Add absent demo resources without resetting state
  check                  Build and run lint, types, coverage tests, build, and formatting
  coverage               Build and run coverage tests
  demo:setup             Reset the disposable demo DB and create a review request
  demo:resume <id>       Resume a reviewed demo proposal without resetting
  help                   Show this help

Aliases: secureops:build, secureops:start, secureops:stop, secureops:restart.
Reviewer/audit CLI commands require a real terminal. Example:
  ./deploy.sh cli reviewer:init --db-path data/demo/secureops-demo.db

MCP uses stdio; no TCP ports are opened or published.
HELP
}

fail() { printf '%s\n' "$1" >&2; exit 2; }
require_no_args() { (($# == 0)) || fail 'This command takes no arguments.'; }

action="${1:-help}"
if (($# > 0)); then shift; fi
case "$action" in
  secureops:build|secureops:start|secureops:stop|secureops:restart)
    action="${action#secureops:}" ;;
esac
case "$action" in
  help|-h|--help) require_no_args "$@"; print_help; exit 0 ;;
  build|start|stop|restart|status|logs|mcp|seed|check|coverage|demo:setup)
    require_no_args "$@" ;;
  cli) (($# > 0)) || fail 'Usage: ./deploy.sh cli <command> [flags]' ;;
  demo:resume)
    (($# == 1)) || fail 'Usage: ./deploy.sh demo:resume <proposal-id>'
    [[ "$1" =~ ^proposal-[a-z0-9-]{1,55}$ ]] || fail 'Invalid proposal ID.' ;;
  *) fail "Unknown command: $action. Use ./deploy.sh help." ;;
esac

command -v docker >/dev/null 2>&1 || fail 'Docker is required.'
docker compose version >/dev/null

seed_database() {
  "${compose[@]}" run --rm -T --no-deps secureops npm run db:seed -- --db-path "$demo_db"
}

case "$action" in
  build) "${compose[@]}" build secureops checks demo ;;
  start|restart)
    "${compose[@]}" build secureops
    seed_database
    if [[ "$action" == restart ]]; then
      "${compose[@]}" up -d --no-build --no-deps --force-recreate secureops
    else
      "${compose[@]}" up -d --no-build --no-deps secureops
    fi
    "${compose[@]}" ps secureops ;;
  stop) "${compose[@]}" stop secureops ;;
  status) "${compose[@]}" ps --all ;;
  logs) "${compose[@]}" logs --follow --tail 100 secureops ;;
  mcp)
    # exec replaces the shell: stdout and stdin belong entirely to JSON-RPC.
    exec "${compose[@]}" exec -T secureops node dist/mcp/stdio.js ;;
  cli) exec "${compose[@]}" exec secureops node dist/cli/index.js "$@" ;;
  seed)
    "${compose[@]}" build secureops
    seed_database ;;
  check|coverage)
    "${compose[@]}" build checks
    if [[ "$action" == coverage ]]; then
      "${compose[@]}" run --rm -T --no-deps checks npm run test:coverage
    else
      "${compose[@]}" run --rm -T --no-deps checks
    fi ;;
  demo:setup|demo:resume)
    "${compose[@]}" build demo
    if [[ "$action" == demo:setup ]]; then
      "${compose[@]}" run --rm -T --no-deps demo
    else
      "${compose[@]}" run --rm -T --no-deps demo npm run demo:local -- resume --proposal-id "$1"
    fi ;;
esac
