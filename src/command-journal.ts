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

export type JournalLifecyclePhase = "command_accepted" | "command_started" | "command_finished";

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
  entriesWritten: number;
  writeErrors: number;
  entriesScanned: number;
  malformedEntries: number;
  unsupportedVersionEntries: number;
  recoveredOutcomes: number;
  recoveredInFlightFailures: number;
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
  /** Version stamp written into entries. */
  serverVersion?: string;
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

export class DurableCommandJournal {
  private readonly enabled: boolean;
  private readonly journalPath: string;
  private readonly serverVersion: string;
  private readonly fsyncOnWrite: boolean;

  private initialized = false;
  private laneSequences = new Map<string, number>();

  private entriesWritten = 0;
  private writeErrors = 0;
  private entriesScanned = 0;
  private malformedEntries = 0;
  private unsupportedVersionEntries = 0;
  private recoveredOutcomes = 0;
  private recoveredInFlightFailures = 0;

  constructor(options: DurableCommandJournalOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION;
    this.fsyncOnWrite = options.fsyncOnWrite ?? false;

    if (options.filePath) {
      this.journalPath = options.filePath;
    } else {
      const dataDir =
        options.dataDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "server");
      const fileName = options.fileName ?? DEFAULT_JOURNAL_FILE;
      this.journalPath = path.join(dataDir, fileName);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getJournalPath(): string {
    return this.journalPath;
  }

  getStats(): CommandJournalStats {
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      journalPath: this.journalPath,
      schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
      entriesWritten: this.entriesWritten,
      writeErrors: this.writeErrors,
      entriesScanned: this.entriesScanned,
      malformedEntries: this.malformedEntries,
      unsupportedVersionEntries: this.unsupportedVersionEntries,
      recoveredOutcomes: this.recoveredOutcomes,
      recoveredInFlightFailures: this.recoveredInFlightFailures,
    };
  }

  private async ensureJournalFileExists(): Promise<void> {
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
    try {
      await fs.access(this.journalPath);
    } catch {
      await fs.writeFile(this.journalPath, "", "utf-8");
    }
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

  private parseEntry(line: string): CommandJournalEntryV1 | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.malformedEntries += 1;
      return null;
    }

    if (!isObject(parsed)) {
      this.malformedEntries += 1;
      return null;
    }

    const schemaVersion = parsed.schemaVersion;
    if (typeof schemaVersion !== "number") {
      this.malformedEntries += 1;
      return null;
    }

    if (schemaVersion > CURRENT_JOURNAL_SCHEMA_VERSION) {
      this.unsupportedVersionEntries += 1;
      return null;
    }

    if (schemaVersion < CURRENT_JOURNAL_SCHEMA_VERSION) {
      // Foundation policy: no automatic migration from older schemas yet.
      // Skip older records deterministically instead of making unsafe assumptions.
      this.unsupportedVersionEntries += 1;
      return null;
    }

    if (parsed.kind !== "command_lifecycle" || !isLifecyclePhase(parsed.phase)) {
      this.malformedEntries += 1;
      return null;
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
      this.malformedEntries += 1;
      return null;
    }

    if (parsed.dependsOn !== undefined && !isStringArray(parsed.dependsOn)) {
      this.malformedEntries += 1;
      return null;
    }

    if (
      parsed.ifSessionVersion !== undefined &&
      (typeof parsed.ifSessionVersion !== "number" || !Number.isFinite(parsed.ifSessionVersion))
    ) {
      this.malformedEntries += 1;
      return null;
    }

    if (parsed.phase === "command_finished") {
      if (typeof parsed.success !== "boolean") {
        this.malformedEntries += 1;
        return null;
      }
      if (parsed.response !== undefined && !isResponse(parsed.response)) {
        this.malformedEntries += 1;
        return null;
      }
    }

    return parsed as unknown as CommandJournalEntryV1;
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

  private appendRecord(record: CommandJournalEntryV1): void {
    const line = `${JSON.stringify(record)}\n`;

    try {
      fsRegular.mkdirSync(path.dirname(this.journalPath), { recursive: true });
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

      this.appendRecord(recoveryEntry);
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

    this.appendRecord(entry);
    return laneSequence;
  }
}
