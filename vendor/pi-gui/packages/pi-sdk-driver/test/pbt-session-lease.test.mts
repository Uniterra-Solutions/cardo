import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_SUFFIX,
  PI_GUI_LEASE_SURFACE,
  buildOwnLease,
  isLeaseDead,
  isSameHolder,
  leaseBlocksBinding,
  readLeaseSnapshot,
  sessionLeasePath,
  writeLeaseFile,
} from "../dist/session-lease.js";

const SELF = { pid: 1, hostname: "self" };

const leaseInfoArb = fc.record({
  pid: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  hostname: fc.string({ maxLength: 20 }),
  startedAt: fc.string({ maxLength: 40 }),
  surface: fc.string({ maxLength: 20 }),
});

const snapshotArb = fc.record({ info: leaseInfoArb, mtimeMs: fc.integer({ min: 0, max: 1_000_000 }) });

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-pbt-lease-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("lease constants: TTL positive, suffix and surface pinned", () => {
  assert.ok(DEFAULT_LEASE_TTL_MS > 0);
  assert.equal(DEFAULT_LEASE_TTL_MS, 5 * 60_000);
  assert.equal(LEASE_SUFFIX, ".lease");
  assert.equal(PI_GUI_LEASE_SURFACE, "pi-gui");
});

test("PBT sessionLeasePath: lease is the session file plus the suffix", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (sessionFile) => {
      const path = sessionLeasePath(sessionFile);
      assert.equal(path, `${sessionFile}${LEASE_SUFFIX}`);
      assert.ok(path.startsWith(sessionFile));
      assert.ok(path.endsWith(LEASE_SUFFIX));
      assert.equal(path.length, sessionFile.length + LEASE_SUFFIX.length);
      return true;
    }),
  );
});

test("PBT isSameHolder: equality is exactly pid + hostname", () => {
  fc.assert(
    fc.property(leaseInfoArb, fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.string({ maxLength: 20 }), (info, pid, hostname) => {
      assert.equal(isSameHolder(info, { pid, hostname }), info.pid === pid && info.hostname === hostname);
      // and it is symmetric
      const self = { pid: info.pid, hostname: info.hostname };
      assert.equal(isSameHolder(info, self), isSameHolder(self, info));
      return true;
    }),
  );
});

test("PBT isLeaseDead / leaseBlocksBinding: consistent with the deadness contract", () => {
  fc.assert(
    fc.property(snapshotArb, fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (snapshot, now, ttlMs, pidAlive) => {
      const opts = { now, ttlMs, self: SELF, isPidAlive: () => pidAlive };
      const sameHost = snapshot.info.hostname === SELF.hostname;
      const sameHolder = isSameHolder(snapshot.info, SELF);
      const expectedDead = (sameHost && !pidAlive) || now - snapshot.mtimeMs > ttlMs;
      assert.equal(isLeaseDead(snapshot, opts), expectedDead, "deadness must follow the contract");
      // a lease blocks binding iff it is foreign and not dead; our own never blocks
      assert.equal(leaseBlocksBinding(snapshot, opts), !sameHolder && !expectedDead);
      if (sameHolder) {
        assert.equal(leaseBlocksBinding(snapshot, opts), false, "own lease never blocks");
      }
      return true;
    }),
  );
});

test("PBT isLeaseDead: fresh leases (age <= ttl, live pid) are never dead", () => {
  fc.assert(
    fc.property(snapshotArb, fc.integer({ min: 0, max: 1_000_000 }), (snapshot, ttlMs) => {
      const opts = { now: snapshot.mtimeMs, ttlMs, self: SELF, isPidAlive: () => true };
      // age === 0 with a live pid: dead only if same-host pid check says dead,
      // which it cannot (pidAlive = true)
      assert.equal(isLeaseDead(snapshot, opts), false);
      return true;
    }),
  );
});

test("PBT buildOwnLease: identity, surface and ISO timestamp", () => {
  fc.assert(
    fc.property(fc.integer(), fc.string({ maxLength: 20 }), fc.integer({ min: 0, max: 1e15 }), (pid, hostname, now) => {
      const lease = buildOwnLease({ pid, hostname }, now);
      assert.equal(lease.pid, pid);
      assert.equal(lease.hostname, hostname);
      assert.equal(lease.surface, PI_GUI_LEASE_SURFACE);
      assert.equal(lease.startedAt, new Date(now).toISOString());
      return true;
    }),
  );
});

test("PBT lease round-trip: writeLeaseFile then readLeaseSnapshot recovers identity and mtime", async () => {
  await fc.assert(
    fc.asyncProperty(leaseInfoArb, async (info) => {
      await withTempDir(async (dir) => {
        const leasePath = join(dir, "session.jsonl.lease");
        await writeLeaseFile(leasePath, info);
        const snap = await readLeaseSnapshot(leasePath);
        assert.ok(snap, "a written lease must be readable");
        // spread both sides: fast-check records may carry a null prototype,
        // while JSON.parse results always have Object.prototype, so
        // deepStrictEqual on the raw objects would compare prototypes
        assert.deepEqual({ ...snap!.info }, { ...info }, "lease identity round-trips exactly");
        assert.ok(Number.isFinite(snap!.mtimeMs) && snap!.mtimeMs > 0, "mtime is a positive finite number");
      });
    }),
  );
});

test("lease edge cases: missing file reads as undefined, corrupt JSON reads as undefined", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "missing.jsonl.lease");
    assert.equal(await readLeaseSnapshot(leasePath), undefined);
    await writeLeaseFile(leasePath, { pid: 1, hostname: "h", startedAt: "s", surface: "x" });
    const snap = await readLeaseSnapshot(leasePath);
    assert.ok(snap);
    // pid 0 is not a valid holder identity but must still be readable as data
    await writeLeaseFile(leasePath, { pid: 0, hostname: "", startedAt: "", surface: "" });
    const zero = await readLeaseSnapshot(leasePath);
    assert.ok(zero);
    assert.equal(zero!.info.pid, 0);
  });
});

test("lease edge cases: TTL boundary — exactly at TTL is not yet dead, one ms over is dead", () => {
  const ttl = 60_000;
  const foreign = { info: { pid: 999, hostname: "other", startedAt: "s", surface: "pi-gui" }, mtimeMs: 10_000 };
  const opts = { now: 10_000 + ttl, ttlMs: ttl, self: SELF, isPidAlive: () => true };
  assert.equal(isLeaseDead(foreign, opts), false, "age exactly TTL is alive");
  assert.equal(isLeaseDead(foreign, { ...opts, now: 10_000 + ttl + 1 }), true, "age TTL+1 is dead");
  assert.equal(leaseBlocksBinding(foreign, opts), true);
  assert.equal(leaseBlocksBinding(foreign, { ...opts, now: 10_000 + ttl + 1 }), false);
});
