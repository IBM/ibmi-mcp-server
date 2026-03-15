/**
 * @fileoverview `ibmi completion bash|zsh|fish` — generate shell completion scripts.
 * @module cli/commands/completion
 */

import { Command } from "commander";
import { ExitCode } from "../utils/exit-codes.js";

/** Top-level commands. */
const COMMANDS = [
  "config",
  "system",
  "schemas",
  "tables",
  "columns",
  "related",
  "validate",
  "sql",
  "tool",
  "tools",
  "toolsets",
  "completion",
];

/** Config subcommands. */
const CONFIG_SUBCOMMANDS = ["show"];

/** System subcommands. */
const SYSTEM_SUBCOMMANDS = [
  "list",
  "show",
  "add",
  "remove",
  "default",
  "test",
  "config-path",
];

/** Global options. */
const GLOBAL_OPTIONS = [
  "--system",
  "--format",
  "--raw",
  "--stream",
  "--tools",
  "--output",
  "--watch",
  "--no-color",
  "--version",
  "--help",
];

/** Format choices. */
const FORMAT_CHOICES = ["table", "json", "csv", "markdown"];

/**
 * Generate a bash completion script.
 */
function generateBash(): string {
  return `# bash completion for ibmi
# Add to ~/.bashrc: eval "$(ibmi completion bash)"

_ibmi_completions() {
  local cur prev commands config_commands system_commands global_opts format_choices
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="${COMMANDS.join(" ")}"
  config_commands="${CONFIG_SUBCOMMANDS.join(" ")}"
  system_commands="${SYSTEM_SUBCOMMANDS.join(" ")}"
  global_opts="${GLOBAL_OPTIONS.join(" ")}"
  format_choices="${FORMAT_CHOICES.join(" ")}"

  # Complete --format values
  if [[ "\${prev}" == "--format" ]]; then
    COMPREPLY=( $(compgen -W "\${format_choices}" -- "\${cur}") )
    return 0
  fi

  # Complete --system from config
  if [[ "\${prev}" == "--system" ]]; then
    local systems
    if command -v yq &>/dev/null && [[ -f ~/.ibmi/config.yaml ]]; then
      systems=$(yq -r '.systems | keys | .[]' ~/.ibmi/config.yaml 2>/dev/null)
    elif command -v python3 &>/dev/null && [[ -f ~/.ibmi/config.yaml ]]; then
      systems=$(python3 -c "import yaml; c=yaml.safe_load(open('$HOME/.ibmi/config.yaml')); print(' '.join(c.get('systems',{}).keys()))" 2>/dev/null)
    fi
    COMPREPLY=( $(compgen -W "\${systems}" -- "\${cur}") )
    return 0
  fi

  # Complete file paths for --file, --tools, --output
  if [[ "\${prev}" == "--file" || "\${prev}" == "--tools" || "\${prev}" == "--output" ]]; then
    COMPREPLY=( $(compgen -f -- "\${cur}") )
    return 0
  fi

  # Complete config subcommands
  if [[ "\${COMP_WORDS[1]}" == "config" && \${COMP_CWORD} -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "\${config_commands}" -- "\${cur}") )
    return 0
  fi

  # Complete system subcommands
  if [[ "\${COMP_WORDS[1]}" == "system" && \${COMP_CWORD} -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "\${system_commands}" -- "\${cur}") )
    return 0
  fi

  # Complete top-level commands
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  # Complete global options
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${global_opts}" -- "\${cur}") )
    return 0
  fi
}

complete -F _ibmi_completions ibmi
`;
}

/**
 * Generate a zsh completion script.
 */
function generateZsh(): string {
  return `#compdef ibmi
# zsh completion for ibmi
# Add to ~/.zshrc: eval "$(ibmi completion zsh)"

_ibmi() {
  local -a commands config_commands system_commands format_choices global_opts

  commands=(
${COMMANDS.map((c) => `    '${c}:${c} command'`).join("\n")}
  )

  config_commands=(
${CONFIG_SUBCOMMANDS.map((c) => `    '${c}:${c}'`).join("\n")}
  )

  system_commands=(
${SYSTEM_SUBCOMMANDS.map((c) => `    '${c}:${c}'`).join("\n")}
  )

  format_choices=(table json csv markdown)

  global_opts=(
    '--system[Target system name]:system name:'
    '--format[Output format]:format:(table json csv markdown)'
    '--raw[Output as JSON]'
    '--stream[Stream results as NDJSON]'
    '--tools[Path to YAML tool files]:file:_files'
    '--output[Write output to file]:file:_files'
    '--watch[Re-run at interval]:seconds:'
    '--no-color[Disable colored output]'
    '--help[Show help]'
    '--version[Show version]'
  )

  _arguments -C \\
    $global_opts \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'ibmi commands' commands
      ;;
    args)
      case $words[1] in
        config)
          _describe -t config_commands 'config subcommands' config_commands
          ;;
        system)
          _describe -t system_commands 'system subcommands' system_commands
          ;;
      esac
      ;;
  esac
}

_ibmi "$@"
`;
}

/**
 * Generate a fish completion script.
 */
function generateFish(): string {
  const lines = [
    "# fish completion for ibmi",
    "# Add to fish config: ibmi completion fish | source",
    "",
    "# Disable file completions by default",
    "complete -c ibmi -f",
    "",
    "# Top-level commands",
  ];

  for (const cmd of COMMANDS) {
    lines.push(
      `complete -c ibmi -n '__fish_use_subcommand' -a '${cmd}' -d '${cmd} command'`,
    );
  }

  lines.push("", "# Config subcommands");
  for (const sub of CONFIG_SUBCOMMANDS) {
    lines.push(
      `complete -c ibmi -n '__fish_seen_subcommand_from config' -a '${sub}' -d '${sub}'`,
    );
  }

  lines.push("", "# System subcommands");
  for (const sub of SYSTEM_SUBCOMMANDS) {
    lines.push(
      `complete -c ibmi -n '__fish_seen_subcommand_from system' -a '${sub}' -d '${sub}'`,
    );
  }

  lines.push("", "# Global options");
  lines.push(
    "complete -c ibmi -l system -d 'Target system name' -x",
    "complete -c ibmi -l format -d 'Output format' -x -a 'table json csv markdown'",
    "complete -c ibmi -l raw -d 'Output as JSON'",
    "complete -c ibmi -l stream -d 'Stream results as NDJSON'",
    "complete -c ibmi -l tools -d 'Path to YAML tool files' -r -F",
    "complete -c ibmi -l output -d 'Write output to file' -r -F",
    "complete -c ibmi -l watch -d 'Re-run at interval (seconds)' -x",
    "complete -c ibmi -l no-color -d 'Disable colored output'",
  );

  return lines.join("\n") + "\n";
}

/**
 * Register `ibmi completion bash|zsh|fish`.
 */
export function registerCompletionCommand(program: Command): void {
  program
    .command("completion [shell]")
    .description("Generate shell completion script (bash, zsh, fish)")
    .action((shell?: string) => {
      const target = shell?.toLowerCase() ?? detectShell();

      switch (target) {
        case "bash":
          process.stdout.write(generateBash());
          break;
        case "zsh":
          process.stdout.write(generateZsh());
          break;
        case "fish":
          process.stdout.write(generateFish());
          break;
        default:
          process.stderr.write(
            `Unknown shell: ${target}. Supported: bash, zsh, fish\n`,
          );
          process.exitCode = ExitCode.USAGE;
      }
    });
}

/**
 * Auto-detect the current shell from the SHELL environment variable.
 */
function detectShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}
