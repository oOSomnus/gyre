/**
 * AI commit messages for the Git pane, from omp's own CLI.
 *
 * omp's git UI calls `generateGitCommit` in process. Importing it into the
 * gateway would pull omp's whole SDK into the compiled binary, so Gyre runs
 * `omp commit --legacy --dry-run` instead: the same generator, with the user's
 * omp settings and model auth, printing the message without committing. See
 * docs/architecture.md ("Coupling points").
 */
import { GitError, type GitRepo } from "./git";
import { type OmpCli, stripAnsi } from "./omp-cli";

const GENERATE_TIMEOUT_MS = 180_000;
const MARKER = "Generated commit message:\n";
const WARNING = /generated message requires manual correction:\s*(.+)/;

export const GENERATE_ARGS = ["commit", "--legacy", "--dry-run", "--no-changelog"];

/** Pull the message (and omp's validation warning) out of `omp commit --dry-run` output. */
export function parseDryRun(result: { code: number; stdout: string; stderr: string }): { message: string; validationError: string | null } {
	const stdout = stripAnsi(result.stdout);
	const stderr = stripAnsi(result.stderr);
	const at = stdout.lastIndexOf(MARKER);
	if (result.code !== 0 || at < 0) {
		const reason = stderr.trim().split("\n").filter(Boolean).at(-1) ?? stdout.trim().split("\n").filter(Boolean).at(-1);
		throw new GitError(`omp could not generate a commit message${reason ? `: ${reason}` : ""}`, 502);
	}
	const message = stdout.slice(at + MARKER.length).replace(/\s+$/, "");
	if (!message) throw new GitError("omp returned an empty commit message", 502);
	return { message, validationError: WARNING.exec(stderr)?.[1]?.trim() ?? null };
}

/**
 * Generate a message for the staged changes. omp stages everything when the
 * index is empty, so this refuses unless something is staged, and holds the
 * repository's lock so the pane cannot unstage while omp reads the index.
 */
export function generateCommitMessage(repo: GitRepo, omp: Pick<OmpCli, "run">): Promise<{ message: string; validationError: string | null }> {
	return repo.exclusive(async () => {
		const status = await repo.status();
		if (!status.files.some(f => !f.untracked && !f.conflicted && f.index !== ".")) throw new GitError("stage changes before generating a message");
		return parseDryRun(await omp.run(GENERATE_ARGS, repo.root, GENERATE_TIMEOUT_MS));
	});
}
