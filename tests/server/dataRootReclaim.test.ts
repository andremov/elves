import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  acquireDataRootOwnershipReclaimingAbsent,
  canonicalDataRoot,
  ownershipMarkerPath,
  type PidProbeResult,
} from '../../server/dataRootOwnership'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A data root whose marker was left by `owner` (as a hard-killed server leaves it). */
async function strandedMarker(owner: { pid: number; hostname: string }) {
  const base = await mkdtemp(join(tmpdir(), 'elves-reclaim-test-'))
  cleanups.push(base)
  const dataRoot = join(base, 'data')
  const runtimeRoot = join(base, 'runtime')
  await mkdir(dataRoot)
  const canonical = await canonicalDataRoot(dataRoot)
  const markerPath = ownershipMarkerPath(canonical, runtimeRoot)
  await mkdir(markerPath, { recursive: true })
  await writeFile(join(markerPath, 'owner.json'), JSON.stringify({
    ...owner, startedAt: '2026-11-21T00:00:00.000Z', instanceId: 'stranded', format: 1, canonicalRoot: canonical,
  }))
  return { dataRoot, runtimeRoot, markerPath }
}

const opts = (runtimeRoot: string, probe: PidProbeResult) => ({
  runtimeRoot, hostname: 'this-host', probePid: () => probe, pid: 4242, instanceId: 'fresh',
})

test('reclaims a marker left on this host by a process that no longer exists', async () => {
  const { dataRoot, runtimeRoot, markerPath } = await strandedMarker({ pid: 999_999_991, hostname: 'this-host' })
  const { ownership, reclaimed } = await acquireDataRootOwnershipReclaimingAbsent(dataRoot, opts(runtimeRoot, 'absent'))
  expect(reclaimed?.pid).toBe(999_999_991)
  expect(JSON.parse(await readFile(join(markerPath, 'owner.json'), 'utf8')).instanceId).toBe('fresh')
  await ownership.release()
})

test('acquires normally, reclaiming nothing, when no marker exists', async () => {
  const base = await mkdtemp(join(tmpdir(), 'elves-reclaim-test-'))
  cleanups.push(base)
  await mkdir(join(base, 'data'))
  const { ownership, reclaimed } = await acquireDataRootOwnershipReclaimingAbsent(join(base, 'data'), opts(join(base, 'runtime'), 'absent'))
  expect(reclaimed).toBeUndefined()
  await ownership.release()
})

test('still fails closed for a live owner, an unclear probe, or another host', async () => {
  const cases = [
    { owner: { pid: 7, hostname: 'this-host' }, probe: 'live' as const },
    { owner: { pid: 7, hostname: 'this-host' }, probe: 'ambiguous' as const },
    { owner: { pid: 7, hostname: 'other-host' }, probe: 'absent' as const },
  ]
  for (const { owner, probe } of cases) {
    const { dataRoot, runtimeRoot, markerPath } = await strandedMarker(owner)
    await expect(acquireDataRootOwnershipReclaimingAbsent(dataRoot, opts(runtimeRoot, probe)))
      .rejects.toMatchObject({ name: 'DataRootOwnershipError' })
    // The original marker is untouched.
    expect(JSON.parse(await readFile(join(markerPath, 'owner.json'), 'utf8')).instanceId).toBe('stranded')
  }
})
