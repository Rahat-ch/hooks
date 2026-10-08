/**
 * Commands that are themselves only known at run time: `$CMD args`,
 * `bash -c "$CMD"`, `eval "$(…)"`, `base64 -d x | sh`, `"$@"`. No Guard can
 * see what they run, so with `askDynamicCommands` (on under `strict`) they
 * ask. Under `standard` they are allowed, as before: they are rare in an
 * agent's commands, and asking would mostly catch setup idioms such as
 * `eval "$(pyenv init -)"`.
 *
 * Not counted: a run-time value inside a script that is otherwise seen
 * (`bash -c "cd $DIR && make"`), which the other rules judge as written;
 * `$(which x)`, which the shell analysis resolves to `x`; and the user's own
 * editor or pager (`$EDITOR`, `$VISUAL`, `$PAGER`), unless the command line
 * itself sets the variable. `"$@"` is not exempt: its value is whatever the
 * caller passes, e.g. `bash -c '"$@"' _ rm -rf ~`.
 */
import type { SimpleCommand } from "../../shell";
import type { Finding } from "./deletes";

/** Variables naming a program the user chose for themselves. */
const userPrograms = ["EDITOR", "VISUAL", "PAGER"];

/** `$EDITOR`, `${EDITOR}`, `${EDITOR:-vi}` or `${EDITOR-vi}`. */
const userProgramWord = new RegExp(`^\\$(?:(${userPrograms.join("|")})|\\{(${userPrograms.join("|")})(?::?-[\\w./-]*)?\\})$`);

/**
 * Whether `word` is one of the user's own program variables that the
 * command line never assigns: every mention in `source` is an expansion.
 */
function userProgram(word: string, source: string): boolean {
  const match = userProgramWord.exec(word);
  const name = match?.[1] ?? match?.[2];
  if (name === undefined) return false;
  return !new RegExp(`(^|[^$\\w{])${name}\\b`).test(source);
}

function reason(command: SimpleCommand): string {
  const text = command.argv.join(" ");
  const shown = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return (
    `What \`${shown}\` runs is only known at run time (a variable, a substitution or piped text), ` +
    "so no Guard can check it, and `askDynamicCommands` (on under the strict Preset) asks first. " +
    "Write the command out literally if you can."
  );
}

export function dynamicFindings(commands: readonly SimpleCommand[], source: string): Finding[] {
  for (const command of commands) {
    if (!command.executes || !command.dynamicProgram) continue;
    if (userProgram(command.argv[0] ?? "", source)) continue;
    return [{ decision: "ask", reason: reason(command) }];
  }
  return [];
}
