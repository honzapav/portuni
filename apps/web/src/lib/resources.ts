// The window's shared resources (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 4), one instance each for the
// life of the window. A component reads them through lib/use-resource.ts;
// a mutation's caller `set`s the answer or `invalidate`s what it changed
// (the invalidation lives at the call site, not in api.ts, so api.ts does
// not import this module).

import {
  fetchAccountUsers,
  fetchActors,
  fetchMe,
  fetchNodeAccess,
  fetchNodeAccessRequests,
  fetchNodeFolderUrl,
  fetchUsers,
  type Actor,
  type MeResponse,
  type User,
} from "../api";
import {
  fetchRunnerDefaults,
  fetchRunnerModels,
  listRunnerInstances,
  listRunners,
  type RunnerInfo,
  type RunnerInstanceSummary,
} from "./runners";
import { createKeyedResource, createResource } from "./resource";
import { createRunnerResources } from "./runner-resources";
import type { AccessRequest, AccountUser, NodeAccessResponse } from "../types";

export const meResource = createResource<MeResponse>(fetchMe);
export const actorsResource = createResource<Actor[]>(() => fetchActors());
export const usersResource = createResource<User[]>(fetchUsers);
export const accountUsersResource = createResource<AccountUser[]>(fetchAccountUsers);

export const runnersResource = createResource<RunnerInfo[]>(listRunners);
export const runnerInstancesResource = createResource<RunnerInstanceSummary[]>(listRunnerInstances);
export const { runnerModels, runnerDefaults } = createRunnerResources({ fetchRunnerModels, fetchRunnerDefaults });

// After an instance was created, changed, deleted or made an org default:
// the instance list, and every model or defaults answer, may differ.
export function invalidateRunnerResources(): void {
  runnerInstancesResource.invalidate();
  runnerModels.invalidate();
  runnerDefaults.invalidate();
}

// Per-node detail data, keyed by node id: fetched once per node per
// window, so a remount of the detail pane (collapse, editor close, a
// view switch) costs nothing.
type FolderUrlValue = { url: string | null; remote_name?: string };
export const folderUrlByNode = createKeyedResource<string, FolderUrlValue>(async (nodeId) => {
  const r = await fetchNodeFolderUrl(nodeId);
  return { url: r.url ?? null, remote_name: r.remote_name };
});
export const nodeAccessByNode = createKeyedResource<string, NodeAccessResponse>(fetchNodeAccess);
export const nodeAccessRequestsByNode = createKeyedResource<string, AccessRequest[]>(fetchNodeAccessRequests);
