/**
 * A Decision is what one Hook returns for one Event. Hooks return a Decision
 * (or nothing); they never write output or exit. The dispatcher combines
 * every Hook's Decision into one Outcome and a Host translator renders it.
 */
export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "ask"; readonly reason: string }
  | { readonly kind: "context"; readonly text: string };

export const allow = (): Decision => ({ kind: "allow" });
export const block = (reason: string): Decision => ({ kind: "block", reason });
export const ask = (reason: string): Decision => ({ kind: "ask", reason });
export const addContext = (text: string): Decision => ({ kind: "context", text });

/** One Hook's Decision, labelled with the Hook that made it. */
export interface HookDecision {
  readonly hook: string;
  readonly decision: Decision;
}

/** The combined result of every Hook for one Event, ready for a Host translator. */
export interface Outcome {
  /** Strongest permission Decision: block beats ask, ask beats allow. undefined when no Hook expressed one. */
  readonly permission: "block" | "ask" | "allow" | undefined;
  /** Reasons from the Hooks that produced the winning permission, each prefixed with the Hook name. */
  readonly reason: string | undefined;
  /** Added context from every Hook, in order. */
  readonly context: string | undefined;
}

const rank = { allow: 1, ask: 2, block: 3 } as const;

export function combineDecisions(decisions: readonly HookDecision[]): Outcome {
  let permission: Outcome["permission"];
  for (const { decision } of decisions) {
    if (decision.kind === "context") continue;
    if (permission === undefined || rank[decision.kind] > rank[permission]) permission = decision.kind;
  }

  const reasons = decisions.flatMap(({ hook, decision }) =>
    decision.kind === permission && "reason" in decision ? [`[hardhooks/${hook}] ${decision.reason}`] : [],
  );
  const contexts = decisions.flatMap(({ decision }) => (decision.kind === "context" ? [decision.text] : []));

  return {
    permission,
    reason: reasons.length > 0 ? reasons.join("\n") : undefined,
    context: contexts.length > 0 ? contexts.join("\n\n") : undefined,
  };
}
