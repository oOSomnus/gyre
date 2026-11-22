/**
 * Plan-mode prompts. Adapted from omp's own `prompts/system/plan-mode-active.md`
 * and `plan-mode-approved.md` (omp 19.1.0), with the native `propose` tool
 * replaced by this extension's `submit_plan`. Keep in sync when bumping omp;
 * `test/contract.test.ts` fails if the native templates change shape.
 */

export function planModeContext(params: { planFilePath?: string; planExists: boolean; revision: number }): string {
	const planFile =
		params.planExists && params.planFilePath
			? `Existing plan: \`${params.planFilePath}\`; read, incrementally update with \`edit\`. Different task → retain it; create \`local://<slug>-plan.md\`.`
			: "Choose short kebab-case task `<slug>`; create `local://<slug>-plan.md` (e.g. `local://auth-token-refresh-plan.md`). File NEVER renamed on approval; submit this same file to `submit_plan`.";
	return `<critical>
Plan mode active.
- Working tree/system read-only: NEVER create, edit, delete, or rename working-tree files; NEVER run state-changing commands (\`git commit\`, \`npm install\`, migrations) or otherwise change the system. Direct file-tool writes outside \`local://\` are blocked; shell restrictions rely on these instructions.
- \`local://\`: session-local planning artifacts; MAY create/update only when needed for the plan; NEVER delete/rename.
- Canonical plan: MUST write \`local://<slug>-plan.md\`.

Submitting: call the \`submit_plan\` tool with the plan file (\`local://<slug>-plan.md\`) and a short title. The user reviews it in Gyre, then either approves (full write access restored, possibly in a fresh or compacted context) or sends feedback, which arrives as the next message: revise the same file and call \`submit_plan\` again.

NEVER ask the user to exit plan mode or request approval in prose or with \`ask\`; approval ONLY through \`submit_plan\`. After \`submit_plan\` returns, end your turn.
</critical>

## What a plan is

Plan: execution spec, not design doc. Approval may clear/compact the conversation; another engineer/fresh agent implements solely from the file. A competent implementer unfamiliar with the conversation MUST execute top-to-bottom with ZERO design decisions; file contains every choice.

Detail removes implementer decisions, not padding. A plan with Non-Goals, Alternatives, or risk matrices but an open decision, or a brief plan forcing a choice, FAILED. Decision-completeness > brevity.

## Plan file

${planFile}

\`edit\`: incremental edits only. \`write\`: create/full replacement only. MUST record findings as learned; NEVER defer all writing to the end.

## Ground every claim

Resolve unknowns by discovery, not questions.
- Discoverable facts — locations, behavior, signatures, configs: MUST discover with \`glob\`, \`grep\`, \`read\`, or parallel \`scout\` subagents (via \`task\`). Every asserted path, symbol, signature, behavior: actually read this session. Unconfirmed: mark inline \`unverified — confirm first\`; NEVER state guesses as settled. Ask only if exploration leaves multiple real candidates; give recommendation.
- Preferences/tradeoffs — intent, UX, scope edges, performance vs. simplicity: not code-derivable. Ask early via \`ask\`: 2–4 mutually exclusive options, recommended default preselected. Unanswered → use default; record under Assumptions.

Every question MUST alter plan or resolve load-bearing choice; batch. NEVER ask what exploration answers or filler.
${params.revision > 0 ? "\n## Revision\n\nThe user sent feedback on the previous revision. Address every point in the same plan file, then call `submit_plan` again.\n" : ""}
## Workflow

<procedure>
1. **Understand** — request and supporting code. Scope spans areas → parallel \`scout\` subagents via \`task\`, distinct focuses. Find reusable code before proposing new.
2. **Design** — draft approach from findings, briefly weigh tradeoffs, commit.
3. **Review** — read intended files; validate approach against code and literal request; \`ask\` resolves remaining preferences.
4. **Write** — plan per **Plan contents**.
</procedure>

## Plan contents

Scannable markdown; depth follows change.

- **Context** — literal ask, need, intended end state; 2–4 sentences.
- **Approach** — load-bearing ordered change steps, grouped by behavior. Each step: concrete edit (verb, exact target, new behavior); existing functions/utilities to reuse, with paths; exact signatures/literals for new or changed symbols; every callsite for renames/removals; error handling for new paths.
- **Critical files & anchors** — ≤5 files disambiguating non-obvious work.
- **Verification** — end-to-end proof with ≥1 new-behavior check: concrete input → expected observable output. Exact commands and prerequisites.
- **Assumptions & contingencies** — only user-overridable decisions, with pre-decided fallbacks.

NEVER include Non-Goals, Out of Scope, Alternatives Considered, Risks/Mitigations or Future Work sections, and NEVER plan a mechanical cleanup tail.

<critical>
Before submitting: an engineer unfamiliar with the conversation can execute every step without a design decision and determine success at each step.

Turn ends ONLY:
1. \`ask\` gathers requirements/chooses approaches; OR
2. \`submit_plan\` submits the plan file.

MUST continue until decision-complete.
</critical>`;
}

export function planDecisionReminder(): string {
	return "<system-reminder>Plan mode: your turn ended without a decision. Continue planning, then either call `ask` for a load-bearing preference or call `submit_plan` with the finished `local://<slug>-plan.md`. Do not ask for approval in prose.</system-reminder>";
}

export function planApprovedPrompt(params: { planFilePath: string; planContent: string; contextPreserved: boolean; notes?: string }): string {
	const notes = params.notes?.trim() ? `\n<approval-notes>\n${params.notes.trim()}\n</approval-notes>\n` : "";
	return `Plan approved.
${params.contextPreserved ? "- History usable; the plan below authoritative if it conflicts with earlier exploration.\n" : ""}
<instruction>
Full plan inlined below; durable copy at \`${params.planFilePath}\` (identical content).
Execute plan step-by-step with full tool access; MUST verify each step before next.
NEVER re-read \`${params.planFilePath}\` while the inline plan is intact; the path is for subagent handoff and recovery only.
Before execution: initialize todo tracking with \`todo\` if available; update it after each completed step.
</instruction>
${notes}
<plan path="${params.planFilePath}">
${params.planContent}
</plan>

<critical>
Inline plan compressed, expired, or unrecoverable: NEVER stop; read \`${params.planFilePath}\`.
Read failure: report exact path and error; NEVER guess.
MUST continue until complete.
</critical>`;
}

export function planFeedbackPrompt(params: { revision: number; feedback: string }): string {
	return `Plan review feedback on revision ${params.revision}:

${params.feedback.trim() || "The user rejected the plan without comments. Ask what to change with `ask`, or rethink the weakest decisions."}

Revise the same plan file to address every point, then call \`submit_plan\` again.`;
}
