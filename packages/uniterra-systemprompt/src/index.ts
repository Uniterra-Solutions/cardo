/**
 * @uniterra-solutions/uniterra-systemprompt — app-wide working rules injected into the system prompt.
 *
 * Registered as a built-in extension (see packages/runtime). Appends a
 * compact set of working rules to the system prompt of every agent turn,
 * keeping them active for the whole app session.
 *
 * Platform contract: the entry is a default-exported factory (pi's loader
 * does `jiti.import(path, { default: true })` then `typeof factory ===
 * "function"`). All other modules in this package use named exports.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const WORKING_RULES = `## Working rules

1. Never use emoji in replies.
2. Talk less, work more; only ask when something genuinely needs user clarification.
3. Do not over-engineer; never make unrequested refactors or changes.
4. Match comment density to code complexity — prefer precise names and concise code; comment only when logic is not self-evident (e.g. abstract iteration).
5. Code is liability, not asset: write not one line more than needed to fully satisfy the user's requirements.
6. Research the latest usage and APIs of external libraries before writing code; never write from memory.
7. Develop test-driven: understand the logic, write tests for each piece of business logic, make the minimal change to pass, then refactor to clean and elegant code.
8. Reply in the user's language by default, unless the user explicitly asks for a specific language.`;

export default function generalExtension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${WORKING_RULES}`,
  }));
}
