/**
 * Opt-in webhook delivery (ntfy or Slack) through a detached `curl`, which
 * ships with macOS, Windows 10+ and nearly every Linux. No shell is involved,
 * and `--data-raw`/`--url` stop a message or URL from being read as a file
 * (`@path`) or an option.
 */
import type { Command, Notification } from "./desktop";

export type WebhookKind = "ntfy" | "slack";

export interface Webhook {
  readonly url: string;
  readonly kind: WebhookKind;
}

export function webhookCommand(notification: Notification, webhook: Webhook): Command {
  const text = `${notification.title}: ${notification.body}`;
  const payload =
    webhook.kind === "slack"
      ? ["--header", "Content-Type: application/json", "--data-raw", JSON.stringify({ text })]
      : ["--data-raw", text];
  return {
    command: "curl",
    args: ["--silent", "--show-error", "--max-time", "10", ...payload, "--url", webhook.url],
  };
}
