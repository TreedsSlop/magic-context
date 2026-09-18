/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { createMessageActivityProvider } from "./message-activity";

const PROJECT_IDENTITY = "/repo/project";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs.splice(0)) closeQuietly(db);
});

function track(db: Database): Database {
    dbs.push(db);
    return db;
}

function freshContextDb(): Database {
    const db = track(new Database(":memory:"));
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function freshOpenCodeDb(): Database {
    const db = track(new Database(":memory:"));
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT
        );
    `);
    return db;
}

function registerSession(
    contextDb: Database,
    sessionId: string,
    updatedAt: number,
    isSubagent = 0,
): void {
    contextDb
        .prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionId, "opencode", PROJECT_IDENTITY, updatedAt);
    contextDb
        .prepare("INSERT INTO session_meta (session_id, is_subagent) VALUES (?, ?)")
        .run(sessionId, isSubagent);
}

function addMessage(openDb: Database, sessionId: string, ts: number): void {
    openDb
        .prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        )
        .run(`${sessionId}-${ts}`, sessionId, ts, ts, "{}");
}

describe("MessageActivityProvider", () => {
    test("sinceMs=null counts all ROOT sessions, subagents excluded", () => {
        const contextDb = freshContextDb();
        registerSession(contextDb, "root1", 100);
        registerSession(contextDb, "root2", 200);
        registerSession(contextDb, "sub1", 300, 1);
        const provider = createMessageActivityProvider({
            contextDb,
            openOpenCodeDb: () => freshOpenCodeDb(),
        });

        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, null)).toBe(2);
        provider.dispose();
    });

    test("counts root sessions with ≥1 message newer than sinceMs; subagent activity does not count", () => {
        const contextDb = freshContextDb();
        const openDb = freshOpenCodeDb();
        registerSession(contextDb, "root1", 100);
        registerSession(contextDb, "root2", 200);
        registerSession(contextDb, "root3", 300);
        registerSession(contextDb, "sub1", 400, 1);
        addMessage(openDb, "root1", 100); // stale (≤ sinceMs)
        addMessage(openDb, "root2", 200); // fresh
        addMessage(openDb, "root3", 300); // fresh
        addMessage(openDb, "sub1", 999); // newest, but a subagent → ignored
        const provider = createMessageActivityProvider({ contextDb, openOpenCodeDb: () => openDb });

        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, 150)).toBe(2);
        provider.dispose();
    });

    test("returns null when opencode.db is unavailable", () => {
        const contextDb = freshContextDb();
        registerSession(contextDb, "root1", 100);
        const provider = createMessageActivityProvider({
            contextDb,
            openOpenCodeDb: () => null,
        });

        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, null)).toBeNull();
        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, 150)).toBeNull();
        provider.dispose();
    });

    test("no project sessions → 0 when opencode.db is present", () => {
        const contextDb = freshContextDb();
        const openDb = freshOpenCodeDb();
        // Messages exist but no session_projects row binds them to the project.
        addMessage(openDb, "orphan", 100);
        const provider = createMessageActivityProvider({ contextDb, openOpenCodeDb: () => openDb });

        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, null)).toBe(0);
        expect(provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, 50)).toBe(0);
        provider.dispose();
    });

    test("dispose() closes the open handle without throwing", () => {
        const contextDb = freshContextDb();
        const openDb = freshOpenCodeDb();
        registerSession(contextDb, "root1", 100);
        addMessage(openDb, "root1", 100);
        const provider = createMessageActivityProvider({ contextDb, openOpenCodeDb: () => openDb });

        provider.countRootSessionsWithMessagesSince(PROJECT_IDENTITY, 0);
        expect(() => provider.dispose()).not.toThrow();
        // Idempotent: a second dispose is a no-op, not an error.
        expect(() => provider.dispose()).not.toThrow();
    });
});
