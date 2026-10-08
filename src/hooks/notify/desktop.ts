/**
 * Native desktop notifications: which program shows one on this platform, and
 * the exact command line. Title and body are always passed as separate
 * arguments or environment variables, never spliced into a script, so a
 * message can't inject code.
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Environment } from "../../environment";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

export interface Command {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The Environment's PATH (Windows spells it `Path`). */
function searchPath(env: Environment): readonly string[] {
  const key = Object.keys(env.env).find((name) => name.toUpperCase() === "PATH");
  const value = key === undefined ? "" : (env.env[key] ?? "");
  // PATH names real directories on this machine, so split it the way this OS does.
  return value.split(delimiter).filter((dir) => dir !== "");
}

/** The first of `programs` found on the Environment's PATH. */
function findProgram(env: Environment, programs: readonly string[]): string | undefined {
  const dirs = searchPath(env);
  return programs.find((program) =>
    dirs.some((dir) => {
      const path = join(dir, program);
      return existsSync(path) && statSync(path).isFile();
    }),
  );
}

/** AppleScript reading title and body from argv, so neither is ever parsed as script. */
function appleScript(sound: boolean): string[] {
  const display = "display notification (item 2 of argv) with title (item 1 of argv)";
  return ["on run argv", sound ? `${display} sound name "Glass"` : display, "end run"];
}

/**
 * A Windows toast through the WinRT API in Windows PowerShell 5.1 (pwsh 7
 * can't load WinRT types). Title and body arrive in environment variables.
 */
function toastScript(sound: boolean): string {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $xml.GetElementsByTagName('text')",
    "$text.Item(0).AppendChild($xml.CreateTextNode($env:HARDHOOKS_NOTIFY_TITLE)) > $null",
    "$text.Item(1).AppendChild($xml.CreateTextNode($env:HARDHOOKS_NOTIFY_BODY)) > $null",
    "$audio = $xml.CreateElement('audio')",
    sound
      ? "$audio.SetAttribute('src', 'ms-winsoundevent:Notification.Default')"
      : "$audio.SetAttribute('silent', 'true')",
    "$xml.DocumentElement.AppendChild($audio) > $null",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    // PowerShell's own AppUserModelID: a toast must show under a registered app.
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join("; ");
}

/** The native notification command for this platform, or undefined when none is installed. */
export function desktopCommand(notification: Notification, sound: boolean, env: Environment): Command | undefined {
  const { title, body } = notification;
  if (env.platform === "darwin") {
    const program = findProgram(env, ["terminal-notifier", "osascript"]);
    if (program === "terminal-notifier") {
      const args = ["-title", title, "-message", body, "-group", `hardhooks-${title}`];
      return { command: program, args: sound ? [...args, "-sound", "default"] : args };
    }
    if (program === "osascript") {
      return { command: program, args: [...appleScript(sound).flatMap((line) => ["-e", line]), title, body] };
    }
    return undefined;
  }
  if (env.platform === "win32") {
    if (findProgram(env, ["powershell.exe"]) === undefined) return undefined;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", toastScript(sound)],
      env: { ...env.env, HARDHOOKS_NOTIFY_TITLE: title, HARDHOOKS_NOTIFY_BODY: body },
    };
  }
  // Linux, the BSDs and other freedesktop systems.
  if (findProgram(env, ["notify-send"]) === undefined) return undefined;
  const hint = sound ? "--hint=string:sound-name:message-new-instant" : "--hint=boolean:suppress-sound:true";
  return { command: "notify-send", args: ["--app-name=hardhooks", hint, "--", title, body] };
}
