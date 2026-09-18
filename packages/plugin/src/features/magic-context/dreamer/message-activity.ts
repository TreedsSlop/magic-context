import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    readOpenCodeOldestMessageTimesSince,
    selectProjectSessions,
} from "./retrospective-raw-provider";

/**
 * The "did any session actually change" signal the dreamer gates on. Scopes a
 * project's ROOT sessions via context.db (session_projects ⋈ session_meta) and
 * counts message activity from the authoritative opencode.db — never from a
 * denormalized copy. session_projects.updated_at records when a session was
 * first bound to a project, not its last activity, so it is not used here.
 */
export interface MessageActivityProvider {
    /**
     * Root sessions of the project with at least one message newer than `sinceMs`
     * (null → all root sessions, for the never-run case). Returns null when
     * opencode.db is unavailable — callers must fall back to conservative
     * behavior ("unknown" is not "no work").
     */
    countRootSessionsWithMessagesSince(
        projectIdentity: string,
        sinceMs: number | null,
    ): number | null;
}

export function createMessageActivityProvider(deps: {
    contextDb: Database;
    openOpenCodeDb: () => Database | null;
}): MessageActivityProvider & { dispose(): void } {
    let sharedDb: Database | null | undefined;
    let sharedDbOpened = false;
    // The declared sharedDb type includes `undefined` (the closed state), so the
    // return type is inferred rather than narrowed — the caller's `if (!db)`
    // guard treats both missing states identically.
    const resolveDb = () => {
        if (!sharedDbOpened) {
            sharedDbOpened = true;
            sharedDb = deps.openOpenCodeDb();
        }
        return sharedDb;
    };
    return {
        countRootSessionsWithMessagesSince(projectIdentity, sinceMs) {
            const db = resolveDb();
            if (!db) return null;
            const sessions = selectProjectSessions(deps.contextDb, projectIdentity);
            if (sinceMs === null) return sessions.length;
            return readOpenCodeOldestMessageTimesSince(
                db,
                sessions.map((s) => s.session_id),
                sinceMs,
            ).size;
        },
        dispose() {
            if (sharedDb) closeQuietly(sharedDb);
            sharedDb = undefined;
            sharedDbOpened = false;
        },
    };
}
