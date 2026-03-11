/**
 * Durable Command Journal (Level 4 foundation)
 *
 * Responsibilities:
 * - Append-only command lifecycle journaling (accepted/start/finished)
 * - Deterministic per-lane sequence numbering
 * - Startup rehydration of completed command outcomes
 * - Deterministic recovery classification for pre-crash in-flight commands
 */

import fsRegular from "fs";
import fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import type { CommandOutcomeRecord } from "./command-replay-store.js";
import { SYNTHETIC_ID_PREFIX } from "./command-replay-store.js";
import type { RpcResponse } from "./types.js";

const CURRENT_JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_JOURNAL_FILE = "command-journal.jsonl";
const UNKNOWN_SERVER_VERSION = "0.0.0-unknown";

/** Linux virtual filesystems that are unsuitable for durable journal storage. */
const UNSUPPORTED_JOURNAL_ROOTS = ["/proc", "/sys"] as const;

/** Default number of history entries returned by get_command_history. */
export const DEFAULT_COMMAND_HISTORY_LIMIT = 100;
/** Hard cap for history responses to keep payloads bounded. */
export const MAX_COMMAND_HISTORY_LIMIT = 500;
/** Guardrail: max non-empty journal lines scanned per history query. */
const DEFAULT_HISTORY_SCAN_MAX_ENTRIES = 20_000;
/** Guardrail: max wall-clock scan duration per history query (ms). */
const DEFAULT_HISTORY_SCAN_MAX_DURATION_MS = 1_000;

/**
 * In-process lock reference counts for journal lock paths.
 * Prevents premature lock-file removal when multiple journal instances in one process
 * share the same path (common in tests and embedded setups).
 */
const lockRefCountsByPath = new Map<string, number>();

function readPackageVersion(): string {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const raw = fsRegular.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : UNKNOWN_SERVER_VERSION;
  } catch {
    return UNKNOWN_SERVER_VERSION;
  }
}

const DEFAULT_SERVER_VERSION = readPackageVersion();

function isUnderUnsupportedJournalRoot(candidatePath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  const resolved = path.resolve(candidatePath);
  return UNSUPPORTED_JOURNAL_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
}

export type JournalLifecyclePhase = "command_accepted" | "command_started" | "command_finished";

export type JournalAppendFailurePolicy = "best_effort" | "fail_closed";

export interface DurableJournalRedactionHooks {
  /**
   * Optional transform applied before a lifecycle record is persisted.
   * Must preserve identity/integrity fields (commandId, lane, phase, etc.).
   */
  beforePersist?: (entry: CommandJournalEntryV1) => CommandJournalEntryV1;
  /**
   * Optional transform applied to command-history query results before returning.
   * Useful for redacting persistence data for export/reporting surfaces.
   */
  beforeExport?: (
    result: CommandHistoryResult,
    context: { query: CommandHistoryQuery }
  ) => CommandHistoryResult;
}

export interface CommandJournalEntryV1 {
  schemaVersion: 1;
  kind: "command_lifecycle";
  phase: JournalLifecyclePhase;
  recordedAt: number;
  serverVersion: string;

  commandId: string;
  commandType: string;
  laneKey: string;
  laneSequence: number;
  fingerprint: string;
  explicitId: boolean;

  sessionId?: string;
  dependsOn?: string[];
  ifSessionVersion?: number;
  idempotencyKey?: string;

  success?: boolean;
  error?: string;
  sessionVersion?: number;
  replayed?: boolean;
  timedOut?: boolean;
  response?: RpcResponse;

  /** True when this terminal outcome was synthesized during crash recovery. */
  recovered?: boolean;
  /** Recovery classification reason (only when recovered=true). */
  recoveryReason?: string;
}

export interface CommandJournalAppendInput {
  phase: JournalLifecyclePhase;
  commandId: string;
  commandType: string;
  laneKey: string;
  fingerprint: string;
  explicitId: boolean;

  sessionId?: string;
  dependsOn?: string[];
  ifSessionVersion?: number;
  idempotencyKey?: string;

  success?: boolean;
  error?: string;
  sessionVersion?: number;
  replayed?: boolean;
  timedOut?: boolean;
  response?: RpcResponse;

  recovered?: boolean;
  recoveryReason?: string;
}

export interface RecoveredInFlightCommand {
  commandId: string;
  commandType: string;
  laneKey: string;
  fingerprint: string;
  lastPhase: "command_accepted" | "command_started";
  reason: string;
}

export interface CommandJournalRecoverySummary {
  enabled: boolean;
  journalPath: string;
  schemaVersion: number;
  entriesScanned: number;
  malformedEntries: number;
  unsupportedVersionEntries: number;
  recoveredOutcomes: CommandOutcomeRecord[];
  recoveredInFlight: RecoveredInFlightCommand[];
  recoveredInFlightFailures: number;
}

export interface CommandJournalStats {
  enabled: boolean;
  initialized: boolean;
  journalPath: string;
  schemaVersion: number;
  appendFailurePolicy: JournalAppendFailurePolicy;
  redaction: {
    beforePersistHookEnabled: boolean;
    beforeExportHookEnabled: boolean;
  };
  entriesWritten: number;
  writeErrors: number;
  entriesScanned: number;
  malformedEntries: number;
  unsupportedVersionEntries: number;
  recoveredOutcomes: number;
  recoveredInFlightFailures: number;
  retention: {
    enabled: boolean;
    maxEntries?: number;
    maxAgeMs?: number;
    maxBytes?: number;
  };
  compaction: {
    runs: number;
    droppedEntries: number;
    lastCompactionAt?: number;
    lastEntriesBefore: number;
    lastEntriesAfter: number;
    lastBytesBefore: number;
    lastBytesAfter: number;
  };
}

export interface CommandHistoryQuery {
  /** Optional session filter (exact match). */
  sessionId?: string;
  /** Optional command ID filter (exact match). */
  commandId?: string;
  /** Optional lower timestamp bound (inclusive, ms since epoch). */
  fromTimestamp?: number;
  /** Optional upper timestamp bound (inclusive, ms since epoch). */
  toTimestamp?: number;
  /** Max entries returned (default 100, max 500). */
  limit?: number;
}

export interface CommandHistoryEntry {
  recordedAt: number;
  phase: JournalLifecyclePhase;
  commandId: string;
  commandType: string;
  laneKey: string;
  laneSequence: number;
  fingerprint: string;
  explicitId: boolean;
  sessionId?: string;
  dependsOn?: string[];
  ifSessionVersion?: number;
  idempotencyKey?: string;
  success?: boolean;
  error?: string;
  sessionVersion?: number;
  replayed?: boolean;
  timedOut?: boolean;
  recovered?: boolean;
  recoveryReason?: string;
}

export interface CommandHistoryResult {
  enabled: boolean;
  journalPath: string;
  schemaVersion: number;
  maxItemsReturned: number;
  truncated: boolean;
  entries: CommandHistoryEntry[];
}

export interface JournalRetentionPolicy {
  /** Keep at most this many terminal command outcomes (newest-first). */
  maxEntries?: number;
  /** Keep terminal outcomes newer than now - maxAgeMs. */
  maxAgeMs?: number;
  /** Keep compacted journal at or below this size when possible. */
  maxBytes?: number;
}

export interface JournalCompactionResult {
  ran: boolean;
  entriesBefore: number;
  entriesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  droppedEntries: number;
}

export interface DurableCommandJournalOptions {
  /** Enable durable journaling (default: false, feature-flagged). */
  enabled?: boolean;
  /** Directory for journal files (default: ~/.pi/agent/server). */
  dataDir?: string;
  /** Journal file name inside dataDir (default: command-journal.jsonl). */
  fileName?: string;
  /** Absolute journal file path override (takes precedence over dataDir/fileName). */
  filePath?: string;
  /** fsync after each append (default: false, throughput-biased). */
  fsyncOnWrite?: boolean;
  /** Append failure handling policy. best_effort logs + continues; fail_closed fails command flow. */
  appendFailurePolicy?: JournalAppendFailurePolicy;
  /** Redaction hooks for persistence/export surfaces. */
  redaction?: DurableJournalRedactionHooks;
  /** Retention/compaction policy (Level 4.4 scaffold). */
  retention?: JournalRetentionPolicy;
  /** Version stamp written into entries. */
  serverVersion?: string;
  /**
   * Enforce single-writer lock file to prevent multi-process compaction/append races.
   * Default: true.
   */
  enforceSingleWriter?: boolean;
  /** Max non-empty lines scanned per get_command_history query (default: 20,000). */
  historyScanMaxEntries?: number;
  /** Max wall-clock scan time per get_command_history query in ms (default: 1,000). */
  historyScanMaxDurationMs?: number;
}

interface InFlightRecoveryState {
  commandId: string;
  commandType: string;
  laneKey: string;
  fingerprint: string;
  explicitId: boolean;
  sessionId?: string;
  dependsOn?: string[];
  ifSessionVersion?: number;
  idempotencyKey?: string;
  lastPhase: "command_accepted" | "command_started";
}

type ParseEntryFailure = "malformed" | "unsupported_version";

type ParseEntryResult =
  | { ok: true; entry: CommandJournalEntryV1 }
  | { ok: false; reason: ParseEntryFailure };

interface IndexedJournalEntry {
  entry: CommandJournalEntryV1;
  index: number;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLifecyclePhase(value: unknown): value is JournalLifecyclePhase {
  return (
    value === "command_accepted" || value === "command_started" || value === "command_finished"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isResponse(value: unknown): value is RpcResponse {
  if (!isObject(value)) return false;
  return (
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean"
  );
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isHistoryEntryLike(value: unknown): value is CommandHistoryEntry {
  if (!isObject(value)) return false;

  return (
    typeof value.recordedAt === "number" &&
    isLifecyclePhase(value.phase) &&
    typeof value.commandId === "string" &&
    typeof value.commandType === "string" &&
    typeof value.laneKey === "string" &&
    typeof value.laneSequence === "number" &&
    typeof value.fingerprint === "string" &&
    typeof value.explicitId === "boolean" &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn)) &&
    (value.ifSessionVersion === undefined || typeof value.ifSessionVersion === "number") &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === "string") &&
    (value.success === undefined || typeof value.success === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.sessionVersion === undefined || typeof value.sessionVersion === "number") &&
    (value.replayed === undefined || typeof value.replayed === "boolean") &&
    (value.timedOut === undefined || typeof value.timedOut === "boolean") &&
    (value.recovered === undefined || typeof value.recovered === "boolean") &&
    (value.recoveryReason === undefined || typeof value.recoveryReason === "string")
  );
}

function isHistoryResultLike(value: unknown): value is CommandHistoryResult {
  if (!isObject(value)) return false;

  return (
    typeof value.enabled === "boolean" &&
    typeof value.journalPath === "string" &&
    typeof value.schemaVersion === "number" &&
    typeof value.maxItemsReturned === "number" &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => isHistoryEntryLike(entry))
  );
}

const PERSISTENCE_IMMUTABLE_FIELDS: ReadonlyArray<keyof CommandJournalEntryV1> = [
  "schemaVersion",
  "kind",
  "phase",
  "recordedAt",
  "serverVersion",
  "commandId",
  "commandType",
  "laneKey",
  "laneSequence",
  "fingerprint",
  "explicitId",
];

export class DurableCommandJournal {
  private readonly enabled: boolean;
  private readonly journalPath: string;
  private readonly serverVersion: string;
  private readonly fsyncOnWrite: boolean;
  private readonly appendFailurePolicy: JournalAppendFailurePolicy;
  private readonly redactionHooks?: DurableJournalRedactionHooks;
  private readonly retentionMaxEntries?: number;
  private readonly retentionMaxAgeMs?: number;
  private readonly retentionMaxBytes?: number;
  private readonly enforceSingleWriter: boolean;
  private readonly historyScanMaxEntries: number;
  private readonly historyScanMaxDurationMs: number;
  private readonly lockPath: string;

  private initialized = false;
  private lockAcquired = false;
  private laneSequences = new Map<string, number>();

  private entriesWritten = 0;
  private writeErrors = 0;
  private entriesScanned = 0;
  private malformedEntries = 0;
  private unsupportedVersionEntries = 0;
  private recoveredOutcomes = 0;
  private recoveredInFlightFailures = 0;
  private compactionRuns = 0;
  private compactionDroppedEntries = 0;
  private lastCompactionAt?: number;
  private lastCompactionEntriesBefore = 0;
  private lastCompactionEntriesAfter = 0;
  private lastCompactionBytesBefore = 0;
  private lastCompactionBytesAfter = 0;

  constructor(options: DurableCommandJournalOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION;
    this.fsyncOnWrite = options.fsyncOnWrite ?? false;
    this.appendFailurePolicy =
      options.appendFailurePolicy === "fail_closed" ? "fail_closed" : "best_effort";
    this.redactionHooks = options.redaction;
    this.retentionMaxEntries = toPositiveInteger(options.retention?.maxEntries);
    this.retentionMaxAgeMs = toPositiveInteger(options.retention?.maxAgeMs);
    this.retentionMaxBytes = toPositiveInteger(options.retention?.maxBytes);
    this.enforceSingleWriter = options.enforceSingleWriter ?? true;
    this.historyScanMaxEntries =
      toPositiveInteger(options.historyScanMaxEntries) ?? DEFAULT_HISTORY_SCAN_MAX_ENTRIES;
    this.historyScanMaxDurationMs =
      toPositiveInteger(options.historyScanMaxDurationMs) ?? DEFAULT_HISTORY_SCAN_MAX_DURATION_MS;

    if (options.filePath) {
      this.journalPath = options.filePath;
    } else {
      const dataDir =
        options.dataDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "server");
      const fileName = options.fileName ?? DEFAULT_JOURNAL_FILE;
      this.journalPath = path.join(dataDir, fileName);
    }

    this.lockPath = `${this.journalPath}.lock`;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getJournalPath(): string {
    return this.journalPath;
  }

  getAppendFailurePolicy(): JournalAppendFailurePolicy {
    return this.appendFailurePolicy;
  }

  hasRetentionPolicy(): boolean {
    return (
      this.retentionMaxEntries !== undefined ||
      this.retentionMaxAgeMs !== undefined ||
      this.retentionMaxBytes !== undefined
    );
  }

  getStats(): CommandJournalStats {
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      journalPath: this.journalPath,
      schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
      appendFailurePolicy: this.appendFailurePolicy,
      redaction: {
        beforePersistHookEnabled: typeof this.redactionHooks?.beforePersist === "function",
        beforeExportHookEnabled: typeof this.redactionHooks?.beforeExport === "function",
      },
      entriesWritten: this.entriesWritten,
      writeErrors: this.writeErrors,
      entriesScanned: this.entriesScanned,
      malformedEntries: this.malformedEntries,
      unsupportedVersionEntries: this.unsupportedVersionEntries,
      recoveredOutcomes: this.recoveredOutcomes,
      recoveredInFlightFailures: this.recoveredInFlightFailures,
      retention: {
        enabled: this.hasRetentionPolicy(),
        maxEntries: this.retentionMaxEntries,
        maxAgeMs: this.retentionMaxAgeMs,
        maxBytes: this.retentionMaxBytes,
      },
      compaction: {
        runs: this.compactionRuns,
        droppedEntries: this.compactionDroppedEntries,
        lastCompactionAt: this.lastCompactionAt,
        lastEntriesBefore: this.lastCompactionEntriesBefore,
        lastEntriesAfter: this.lastCompactionEntriesAfter,
        lastBytesBefore: this.lastCompactionBytesBefore,
        lastBytesAfter: this.lastCompactionBytesAfter,
      },
    };
  }

  private assertJournalPathSupported(): void {
    if (isUnderUnsupportedJournalRoot(this.journalPath)) {
      throw new Error(
        `Journal path '${this.journalPath}' is under unsupported virtual filesystem root (${UNSUPPORTED_JOURNAL_ROOTS.join(
          ", "
        )})`
      );
    }
  }

  private async ensureJournalFileExists(): Promise<void> {
    this.assertJournalPathSupported();
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
    try {
      await fs.access(this.journalPath);
    } catch {
      await fs.writeFile(this.journalPath, "", "utf-8");
    }
  }

  private readLockOwnerPid(): number | undefined {
    try {
      const raw = fsRegular.readFileSync(this.lockPath, "utf-8").trim();
      if (!raw) return undefined;

      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return parsed.pid;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // EPERM means process exists but we lack permission to signal it.
      return err?.code === "EPERM";
    }
  }

  private acquireProcessLock(): void {
    if (!this.enabled || !this.enforceSingleWriter) {
      return;
    }

    if (this.lockAcquired) {
      return;
    }

    const inProcessRefs = lockRefCountsByPath.get(this.lockPath) ?? 0;
    if (inProcessRefs > 0) {
      lockRefCountsByPath.set(this.lockPath, inProcessRefs + 1);
      this.lockAcquired = true;
      return;
    }

    const createFreshLockFile = () => {
      const fd = fsRegular.openSync(this.lockPath, "wx");
      try {
        const payload = JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          journalPath: this.journalPath,
        });
        fsRegular.writeSync(fd, `${payload}\n`, undefined, "utf-8");
      } finally {
        fsRegular.closeSync(fd);
      }
    };

    try {
      createFreshLockFile();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "EEXIST") {
        throw error;
      }

      const ownerPid = this.readLockOwnerPid();
      if (ownerPid !== undefined && ownerPid !== process.pid && this.isPidAlive(ownerPid)) {
        throw new Error(
          `Journal path '${this.journalPath}' is already in use by PID ${ownerPid} (lock file: ${this.lockPath})`
        );
      }

      // Stale lock (owner dead/unreadable) or re-entry from same PID after missed cleanup.
      try {
        fsRegular.rmSync(this.lockPath, { force: true });
      } catch {
        // Ignore stale lock cleanup errors; next create attempt will fail if still held.
      }

      try {
        createFreshLockFile();
      } catch (retryError) {
        const retryErr = retryError as NodeJS.ErrnoException;
        if (retryErr?.code === "EEXIST") {
          const retryOwnerPid = this.readLockOwnerPid();
          throw new Error(
            `Journal path '${this.journalPath}' is already in use by PID ${retryOwnerPid ?? "unknown"} (lock file: ${this.lockPath})`
          );
        }
        throw retryError;
      }
    }

    lockRefCountsByPath.set(this.lockPath, 1);
    this.lockAcquired = true;
  }

  private releaseProcessLock(): void {
    if (!this.enforceSingleWriter || !this.lockAcquired) {
      return;
    }

    this.lockAcquired = false;

    const refs = lockRefCountsByPath.get(this.lockPath);
    if (refs === undefined) {
      return;
    }

    if (refs > 1) {
      lockRefCountsByPath.set(this.lockPath, refs - 1);
      return;
    }

    lockRefCountsByPath.delete(this.lockPath);

    const ownerPid = this.readLockOwnerPid();
    if (ownerPid !== undefined && ownerPid !== process.pid) {
      return;
    }

    try {
      fsRegular.rmSync(this.lockPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  dispose(): void {
    this.releaseProcessLock();
  }

  private bumpLaneSequenceFromRecord(record: CommandJournalEntryV1): void {
    const current = this.laneSequences.get(record.laneKey) ?? 0;
    if (record.laneSequence > current) {
      this.laneSequences.set(record.laneKey, record.laneSequence);
    }
  }

  private nextLaneSequence(laneKey: string): number {
    const next = (this.laneSequences.get(laneKey) ?? 0) + 1;
    this.laneSequences.set(laneKey, next);
    return next;
  }

  private parseEntryInternal(line: string): ParseEntryResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed" };
    }

    if (!isObject(parsed)) {
      return { ok: false, reason: "malformed" };
    }

    const schemaVersion = parsed.schemaVersion;
    if (typeof schemaVersion !== "number") {
      return { ok: false, reason: "malformed" };
    }

    if (schemaVersion > CURRENT_JOURNAL_SCHEMA_VERSION) {
      return { ok: false, reason: "unsupported_version" };
    }

    if (schemaVersion < CURRENT_JOURNAL_SCHEMA_VERSION) {
      // Foundation policy: no automatic migration from older schemas yet.
      // Skip older records deterministically instead of making unsafe assumptions.
      return { ok: false, reason: "unsupported_version" };
    }

    if (parsed.kind !== "command_lifecycle" || !isLifecyclePhase(parsed.phase)) {
      return { ok: false, reason: "malformed" };
    }

    if (
      typeof parsed.recordedAt !== "number" ||
      typeof parsed.serverVersion !== "string" ||
      typeof parsed.commandId !== "string" ||
      typeof parsed.commandType !== "string" ||
      typeof parsed.laneKey !== "string" ||
      typeof parsed.laneSequence !== "number" ||
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.explicitId !== "boolean"
    ) {
      return { ok: false, reason: "malformed" };
    }

    if (parsed.dependsOn !== undefined && !isStringArray(parsed.dependsOn)) {
      return { ok: false, reason: "malformed" };
    }

    if (
      parsed.ifSessionVersion !== undefined &&
      (typeof parsed.ifSessionVersion !== "number" || !Number.isFinite(parsed.ifSessionVersion))
    ) {
      return { ok: false, reason: "malformed" };
    }

    if (parsed.phase === "command_finished") {
      if (typeof parsed.success !== "boolean") {
        return { ok: false, reason: "malformed" };
      }
      if (parsed.response !== undefined && !isResponse(parsed.response)) {
        return { ok: false, reason: "malformed" };
      }
    }

    return { ok: true, entry: parsed as unknown as CommandJournalEntryV1 };
  }

  private parseEntry(line: string): CommandJournalEntryV1 | null {
    const parsed = this.parseEntryInternal(line);
    if (parsed.ok) {
      return parsed.entry;
    }

    if (parsed.reason === "unsupported_version") {
      this.unsupportedVersionEntries += 1;
    } else {
      this.malformedEntries += 1;
    }

    return null;
  }

  private makeOutcomeFromFinishedEntry(
    entry: CommandJournalEntryV1
  ): CommandOutcomeRecord | undefined {
    if (!entry.explicitId) return undefined;
    if (entry.commandId.startsWith(SYNTHETIC_ID_PREFIX)) return undefined;
    if (entry.replayed) return undefined;
    if (!entry.response || !isResponse(entry.response)) return undefined;

    return {
      commandId: entry.commandId,
      commandType: entry.commandType,
      laneKey: entry.laneKey,
      fingerprint: entry.fingerprint,
      success: entry.success ?? entry.response.success,
      error: entry.error,
      response: entry.response,
      sessionVersion: entry.sessionVersion,
      finishedAt: entry.recordedAt,
    };
  }

  private clampHistoryLimit(requested?: number): number {
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
      return DEFAULT_COMMAND_HISTORY_LIMIT;
    }

    const asInt = Math.floor(requested);
    if (asInt <= 0) {
      return DEFAULT_COMMAND_HISTORY_LIMIT;
    }

    return Math.min(asInt, MAX_COMMAND_HISTORY_LIMIT);
  }

  private matchesHistoryQuery(entry: CommandJournalEntryV1, query: CommandHistoryQuery): boolean {
    if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) {
      return false;
    }

    if (query.commandId !== undefined && entry.commandId !== query.commandId) {
      return false;
    }

    if (
      query.fromTimestamp !== undefined &&
      Number.isFinite(query.fromTimestamp) &&
      entry.recordedAt < query.fromTimestamp
    ) {
      return false;
    }

    if (
      query.toTimestamp !== undefined &&
      Number.isFinite(query.toTimestamp) &&
      entry.recordedAt > query.toTimestamp
    ) {
      return false;
    }

    return true;
  }

  private toHistoryEntry(entry: CommandJournalEntryV1): CommandHistoryEntry {
    return {
      recordedAt: entry.recordedAt,
      phase: entry.phase,
      commandId: entry.commandId,
      commandType: entry.commandType,
      laneKey: entry.laneKey,
      laneSequence: entry.laneSequence,
      fingerprint: entry.fingerprint,
      explicitId: entry.explicitId,
      sessionId: entry.sessionId,
      dependsOn: entry.dependsOn,
      ifSessionVersion: entry.ifSessionVersion,
      idempotencyKey: entry.idempotencyKey,
      success: entry.success,
      error: entry.error,
      sessionVersion: entry.sessionVersion,
      replayed: entry.replayed,
      timedOut: entry.timedOut,
      recovered: entry.recovered,
      recoveryReason: entry.recoveryReason,
    };
  }

  private applyPersistenceRedaction(entry: CommandJournalEntryV1): CommandJournalEntryV1 {
    const hook = this.redactionHooks?.beforePersist;
    if (!hook) {
      return entry;
    }

    const redacted = hook(cloneJsonValue(entry));

    if (!isObject(redacted)) {
      throw new Error("redaction.beforePersist must return a journal entry object");
    }

    const candidate = redacted as CommandJournalEntryV1;

    for (const field of PERSISTENCE_IMMUTABLE_FIELDS) {
      if (candidate[field] !== entry[field]) {
        throw new Error(
          `redaction.beforePersist cannot modify immutable field '${field}' (commandId=${entry.commandId})`
        );
      }
    }

    if (entry.phase === "command_finished") {
      if (candidate.success !== entry.success) {
        throw new Error(
          `redaction.beforePersist cannot modify terminal success for commandId=${entry.commandId}`
        );
      }

      if (candidate.response !== undefined && !isResponse(candidate.response)) {
        throw new Error(
          `redaction.beforePersist produced non-response payload for commandId=${entry.commandId}`
        );
      }

      if (candidate.response !== undefined && candidate.response.command !== entry.commandType) {
        throw new Error(
          `redaction.beforePersist cannot modify response.command for commandId=${entry.commandId}`
        );
      }

      const isReplayCriticalTerminal =
        entry.explicitId && !entry.commandId.startsWith(SYNTHETIC_ID_PREFIX) && !entry.replayed;

      if (isReplayCriticalTerminal) {
        if (!candidate.response || !isResponse(candidate.response)) {
          throw new Error(
            `redaction.beforePersist cannot remove replay-critical response for commandId=${entry.commandId}`
          );
        }

        if (candidate.response.id !== entry.commandId) {
          throw new Error(
            `redaction.beforePersist cannot modify replay-critical response.id for commandId=${entry.commandId}`
          );
        }
      }
    }

    const parsed = this.parseEntryInternal(JSON.stringify(candidate));
    if (!parsed.ok) {
      throw new Error(
        `redaction.beforePersist produced invalid entry for commandId=${entry.commandId} (${parsed.reason})`
      );
    }

    return parsed.entry;
  }

  private applyExportRedaction(
    result: CommandHistoryResult,
    query: CommandHistoryQuery
  ): CommandHistoryResult {
    const hook = this.redactionHooks?.beforeExport;
    if (!hook) {
      return result;
    }

    const redacted = hook(cloneJsonValue(result), {
      query: cloneJsonValue(query),
    });

    if (!isHistoryResultLike(redacted)) {
      throw new Error("redaction.beforeExport must return a valid command history result");
    }

    return redacted;
  }

  async queryHistory(query: CommandHistoryQuery = {}): Promise<CommandHistoryResult> {
    const limit = this.clampHistoryLimit(query.limit);

    if (!this.enabled) {
      return this.applyExportRedaction(
        {
          enabled: false,
          journalPath: this.journalPath,
          schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
          maxItemsReturned: limit,
          truncated: false,
          entries: [],
        },
        query
      );
    }

    if (!this.initialized) {
      throw new Error("DurableCommandJournal.queryHistory called before initialize()");
    }

    await this.ensureJournalFileExists();

    let raw = "";
    try {
      raw = await fs.readFile(this.journalPath, "utf-8");
    } catch {
      raw = "";
    }

    const lines = raw.split(/\r?\n/);
    const entries: CommandHistoryEntry[] = [];
    let truncated = false;
    let scannedNonEmptyLines = 0;
    const scanStartedAt = Date.now();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;

      scannedNonEmptyLines += 1;
      const elapsedMs = Date.now() - scanStartedAt;
      if (
        scannedNonEmptyLines > this.historyScanMaxEntries ||
        elapsedMs > this.historyScanMaxDurationMs
      ) {
        truncated = true;
        break;
      }

      const parsed = this.parseEntryInternal(line);
      if (!parsed.ok) {
        continue;
      }

      const entry = parsed.entry;
      if (!this.matchesHistoryQuery(entry, query)) {
        continue;
      }

      if (entries.length < limit) {
        entries.push(this.toHistoryEntry(entry));
      } else {
        truncated = true;
        break;
      }
    }

    return this.applyExportRedaction(
      {
        enabled: true,
        journalPath: this.journalPath,
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        maxItemsReturned: limit,
        truncated,
        entries,
      },
      query
    );
  }

  private readIndexedEntriesForCompaction(): {
    entries: IndexedJournalEntry[];
    nonEmptyLineCount: number;
    bytesBefore: number;
  } {
    let raw = "";
    try {
      raw = fsRegular.readFileSync(this.journalPath, "utf-8");
    } catch {
      return {
        entries: [],
        nonEmptyLineCount: 0,
        bytesBefore: 0,
      };
    }

    const entries: IndexedJournalEntry[] = [];
    let nonEmptyLineCount = 0;

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      nonEmptyLineCount += 1;

      const parsed = this.parseEntryInternal(line);
      if (!parsed.ok) {
        continue;
      }

      entries.push({
        entry: parsed.entry,
        index: nonEmptyLineCount,
      });
    }

    return {
      entries,
      nonEmptyLineCount,
      bytesBefore: Buffer.byteLength(raw, "utf-8"),
    };
  }

  private entrySerializedBytes(entry: CommandJournalEntryV1): number {
    return Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf-8");
  }

  private buildRetainedCompactionEntries(
    entries: IndexedJournalEntry[],
    now = Date.now()
  ): IndexedJournalEntry[] {
    const inFlightByCommandId = new Map<string, IndexedJournalEntry>();
    const terminalOutcomeByCommandId = new Map<string, IndexedJournalEntry>();

    for (const indexed of entries) {
      const { entry } = indexed;

      if (entry.phase === "command_accepted") {
        inFlightByCommandId.set(entry.commandId, indexed);
        continue;
      }

      if (entry.phase === "command_started") {
        inFlightByCommandId.set(entry.commandId, indexed);
        continue;
      }

      // command_finished
      inFlightByCommandId.delete(entry.commandId);

      const outcome = this.makeOutcomeFromFinishedEntry(entry);
      if (outcome) {
        terminalOutcomeByCommandId.set(entry.commandId, indexed);
      }
    }

    // Only explicit non-synthetic in-flight commands are replay-relevant across restarts.
    // Synthetic IDs are ephemeral and must not dominate retained terminal outcomes.
    const retainableInFlightByCommandId = new Map<string, IndexedJournalEntry>();
    for (const [commandId, indexed] of inFlightByCommandId) {
      if (!indexed.entry.explicitId) {
        continue;
      }
      if (commandId.startsWith(SYNTHETIC_ID_PREFIX)) {
        continue;
      }
      retainableInFlightByCommandId.set(commandId, indexed);
    }

    // In-flight state dominates old terminal outcomes for the same command ID.
    for (const commandId of retainableInFlightByCommandId.keys()) {
      terminalOutcomeByCommandId.delete(commandId);
    }

    let terminalEntries = [...terminalOutcomeByCommandId.values()].sort(
      (a, b) => a.index - b.index
    );

    if (this.retentionMaxAgeMs !== undefined) {
      const cutoff = now - this.retentionMaxAgeMs;
      terminalEntries = terminalEntries.filter((indexed) => indexed.entry.recordedAt >= cutoff);
    }

    if (
      this.retentionMaxEntries !== undefined &&
      terminalEntries.length > this.retentionMaxEntries
    ) {
      terminalEntries = terminalEntries.slice(-this.retentionMaxEntries);
    }

    const inFlightEntries = [...retainableInFlightByCommandId.values()].sort(
      (a, b) => a.index - b.index
    );

    const retained = [...inFlightEntries, ...terminalEntries].sort((a, b) => a.index - b.index);

    if (this.retentionMaxBytes !== undefined) {
      let totalBytes = retained.reduce(
        (sum, indexed) => sum + this.entrySerializedBytes(indexed.entry),
        0
      );

      if (totalBytes > this.retentionMaxBytes) {
        for (let i = 0; i < retained.length && totalBytes > this.retentionMaxBytes; i++) {
          const candidate = retained[i];
          if (!candidate || candidate.entry.phase !== "command_finished") {
            continue;
          }

          totalBytes -= this.entrySerializedBytes(candidate.entry);
          retained.splice(i, 1);
          i -= 1;
        }
      }
    }

    return retained;
  }

  private buildCompactedContent(entries: IndexedJournalEntry[]): {
    content: string;
    bytes: number;
  } {
    if (entries.length === 0) {
      return { content: "", bytes: 0 };
    }

    const content = `${entries.map((indexed) => JSON.stringify(indexed.entry)).join("\n")}\n`;
    return {
      content,
      bytes: Buffer.byteLength(content, "utf-8"),
    };
  }

  compactNow(): JournalCompactionResult {
    if (!this.enabled || !this.hasRetentionPolicy()) {
      return {
        ran: false,
        entriesBefore: 0,
        entriesAfter: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        droppedEntries: 0,
      };
    }

    this.assertJournalPathSupported();
    fsRegular.mkdirSync(path.dirname(this.journalPath), { recursive: true });
    if (!fsRegular.existsSync(this.journalPath)) {
      fsRegular.writeFileSync(this.journalPath, "", "utf-8");
    }
    this.acquireProcessLock();

    const { entries, nonEmptyLineCount, bytesBefore } = this.readIndexedEntriesForCompaction();
    const retained = this.buildRetainedCompactionEntries(entries);
    const { content, bytes: bytesAfter } = this.buildCompactedContent(retained);

    const droppedEntries = Math.max(0, nonEmptyLineCount - retained.length);
    const shouldRewrite = droppedEntries > 0 || bytesAfter !== bytesBefore;

    if (shouldRewrite) {
      const tempPath = `${this.journalPath}.${process.pid}.${Date.now()}.${Math.floor(
        Math.random() * 1_000_000_000
      )}.tmp`;
      try {
        fsRegular.writeFileSync(tempPath, content, "utf-8");
        fsRegular.renameSync(tempPath, this.journalPath);
      } finally {
        if (fsRegular.existsSync(tempPath)) {
          fsRegular.rmSync(tempPath, { force: true });
        }
      }
    }

    this.compactionRuns += 1;
    this.compactionDroppedEntries += droppedEntries;
    this.lastCompactionAt = Date.now();
    this.lastCompactionEntriesBefore = nonEmptyLineCount;
    this.lastCompactionEntriesAfter = retained.length;
    this.lastCompactionBytesBefore = bytesBefore;
    this.lastCompactionBytesAfter = bytesAfter;

    return {
      ran: true,
      entriesBefore: nonEmptyLineCount,
      entriesAfter: retained.length,
      bytesBefore,
      bytesAfter,
      droppedEntries,
    };
  }

  private appendRecord(record: CommandJournalEntryV1): void {
    const line = `${JSON.stringify(record)}\n`;

    try {
      fsRegular.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      this.acquireProcessLock();
      const fd = fsRegular.openSync(this.journalPath, "a");
      try {
        fsRegular.writeSync(fd, line, undefined, "utf-8");
        if (this.fsyncOnWrite) {
          fsRegular.fsyncSync(fd);
        }
      } finally {
        fsRegular.closeSync(fd);
      }

      this.entriesWritten += 1;
    } catch (error) {
      this.writeErrors += 1;
      throw error;
    }
  }

  async initialize(): Promise<CommandJournalRecoverySummary> {
    if (!this.enabled) {
      this.initialized = true;
      return {
        enabled: false,
        journalPath: this.journalPath,
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        entriesScanned: 0,
        malformedEntries: 0,
        unsupportedVersionEntries: 0,
        recoveredOutcomes: [],
        recoveredInFlight: [],
        recoveredInFlightFailures: 0,
      };
    }

    if (this.initialized) {
      return {
        enabled: true,
        journalPath: this.journalPath,
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        entriesScanned: this.entriesScanned,
        malformedEntries: this.malformedEntries,
        unsupportedVersionEntries: this.unsupportedVersionEntries,
        recoveredOutcomes: [],
        recoveredInFlight: [],
        recoveredInFlightFailures: this.recoveredInFlightFailures,
      };
    }

    await this.ensureJournalFileExists();
    this.acquireProcessLock();

    // Apply retention/compaction policy before startup rehydration so recovered
    // outcomes match retained durable history.
    this.compactNow();

    // Reset mutable recovery state for deterministic startup behavior.
    this.laneSequences.clear();
    this.entriesScanned = 0;
    this.malformedEntries = 0;
    this.unsupportedVersionEntries = 0;
    this.recoveredOutcomes = 0;
    this.recoveredInFlightFailures = 0;

    const inFlight = new Map<string, InFlightRecoveryState>();
    const recoveredOutcomeById = new Map<string, CommandOutcomeRecord>();

    const fileStream = fsRegular.createReadStream(this.journalPath, { encoding: "utf-8" });
    let rl: ReturnType<typeof readline.createInterface> | undefined;

    try {
      rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        this.entriesScanned += 1;
        const entry = this.parseEntry(line);
        if (!entry) continue;

        this.bumpLaneSequenceFromRecord(entry);

        if (entry.phase === "command_accepted") {
          inFlight.set(entry.commandId, {
            commandId: entry.commandId,
            commandType: entry.commandType,
            laneKey: entry.laneKey,
            fingerprint: entry.fingerprint,
            explicitId: entry.explicitId,
            sessionId: entry.sessionId,
            dependsOn: entry.dependsOn,
            ifSessionVersion: entry.ifSessionVersion,
            idempotencyKey: entry.idempotencyKey,
            lastPhase: "command_accepted",
          });
          continue;
        }

        if (entry.phase === "command_started") {
          const existing = inFlight.get(entry.commandId);
          if (existing) {
            existing.lastPhase = "command_started";
          } else {
            inFlight.set(entry.commandId, {
              commandId: entry.commandId,
              commandType: entry.commandType,
              laneKey: entry.laneKey,
              fingerprint: entry.fingerprint,
              explicitId: entry.explicitId,
              sessionId: entry.sessionId,
              dependsOn: entry.dependsOn,
              ifSessionVersion: entry.ifSessionVersion,
              idempotencyKey: entry.idempotencyKey,
              lastPhase: "command_started",
            });
          }
          continue;
        }

        // command_finished
        inFlight.delete(entry.commandId);

        const outcome = this.makeOutcomeFromFinishedEntry(entry);
        if (outcome) {
          recoveredOutcomeById.set(outcome.commandId, outcome);
        }
      }
    } finally {
      rl?.close();
      fileStream.destroy();
    }

    const recoveredInFlight: RecoveredInFlightCommand[] = [];

    // Deterministic crash recovery policy (foundation):
    // Pre-crash in-flight explicit commands are marked failed and journaled as terminal outcomes.
    for (const state of inFlight.values()) {
      if (!state.explicitId || state.commandId.startsWith(SYNTHETIC_ID_PREFIX)) {
        continue;
      }

      const reason =
        "Command did not finish before previous shutdown and was marked failed during recovery";
      const response: RpcResponse = {
        id: state.commandId,
        type: "response",
        command: state.commandType,
        success: false,
        error: reason,
      };

      const now = Date.now();
      const recoveryOutcome: CommandOutcomeRecord = {
        commandId: state.commandId,
        commandType: state.commandType,
        laneKey: state.laneKey,
        fingerprint: state.fingerprint,
        success: false,
        error: reason,
        response,
        sessionVersion: undefined,
        finishedAt: now,
      };
      recoveredOutcomeById.set(state.commandId, recoveryOutcome);

      recoveredInFlight.push({
        commandId: state.commandId,
        commandType: state.commandType,
        laneKey: state.laneKey,
        fingerprint: state.fingerprint,
        lastPhase: state.lastPhase,
        reason,
      });

      const recoveryEntry: CommandJournalEntryV1 = {
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        kind: "command_lifecycle",
        phase: "command_finished",
        recordedAt: now,
        serverVersion: this.serverVersion,

        commandId: state.commandId,
        commandType: state.commandType,
        laneKey: state.laneKey,
        laneSequence: this.nextLaneSequence(state.laneKey),
        fingerprint: state.fingerprint,
        explicitId: state.explicitId,

        sessionId: state.sessionId,
        dependsOn: state.dependsOn,
        ifSessionVersion: state.ifSessionVersion,
        idempotencyKey: state.idempotencyKey,

        success: false,
        error: reason,
        response,

        recovered: true,
        recoveryReason: "restart_inflight_marked_failed",
      };

      this.appendRecord(this.applyPersistenceRedaction(recoveryEntry));
    }

    const recoveredOutcomes = [...recoveredOutcomeById.values()];
    this.recoveredOutcomes = recoveredOutcomes.length;
    this.recoveredInFlightFailures = recoveredInFlight.length;
    this.initialized = true;

    return {
      enabled: true,
      journalPath: this.journalPath,
      schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
      entriesScanned: this.entriesScanned,
      malformedEntries: this.malformedEntries,
      unsupportedVersionEntries: this.unsupportedVersionEntries,
      recoveredOutcomes,
      recoveredInFlight,
      recoveredInFlightFailures: recoveredInFlight.length,
    };
  }

  appendLifecycle(input: CommandJournalAppendInput): number | null {
    if (!this.enabled) return null;

    if (!this.initialized) {
      throw new Error("DurableCommandJournal.appendLifecycle called before initialize()");
    }

    const laneSequence = this.nextLaneSequence(input.laneKey);

    const entry: CommandJournalEntryV1 = {
      schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
      kind: "command_lifecycle",
      phase: input.phase,
      recordedAt: Date.now(),
      serverVersion: this.serverVersion,

      commandId: input.commandId,
      commandType: input.commandType,
      laneKey: input.laneKey,
      laneSequence,
      fingerprint: input.fingerprint,
      explicitId: input.explicitId,

      sessionId: input.sessionId,
      dependsOn: input.dependsOn,
      ifSessionVersion: input.ifSessionVersion,
      idempotencyKey: input.idempotencyKey,

      success: input.success,
      error: input.error,
      sessionVersion: input.sessionVersion,
      replayed: input.replayed,
      timedOut: input.timedOut,
      response: input.response,

      recovered: input.recovered,
      recoveryReason: input.recoveryReason,
    };

    this.appendRecord(this.applyPersistenceRedaction(entry));
    return laneSequence;
  }
}
