#!/bin/sh
# PreToolUse guard: refuse destructive or credential-reading shell commands.
# Reads the hook JSON on stdin; exit 2 blocks the tool call and forwards stderr.
# Stdin is read with a 2 s cap so a missing EOF can never hang the agent.
input=$(node -e '
let d = "";
const t = setTimeout(() => { process.stdout.write(d); process.exit(0); }, 2000);
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => { clearTimeout(t); process.stdout.write(d); });
')

block() {
  echo "Blocked by guard-shell: $1" >&2
  exit 2
}

case "$input" in
  *"git push --force"*|*"git push -f"*|*"push --force-with-lease"*) block "force push" ;;
  *"git reset --hard"*) block "git reset --hard" ;;
  *".aws"*|*".ssh"*|*"local/share/kiro-cli"*) block "reads a protected credential path" ;;
esac

# rm -rf is only allowed on relative paths that stay inside the repo.
if printf '%s' "$input" | grep -Eq 'rm +(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r +-f|-f +-r)'; then
  if printf '%s' "$input" | grep -Eq 'rm +[^"]*( |=)(/|~|\$HOME|\.\.)'; then
    block "rm -rf outside the repo"
  fi
fi

exit 0
