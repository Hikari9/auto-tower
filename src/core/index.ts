import type { SqlDatabase } from '../storage/database.js';
import {
  type CompletionGuardRegistry,
  createCompletionGuardRegistry,
} from './guards.js';
import {
  createScheduler,
  NO_RUNNERS,
  type RunnerPool,
  type Scheduler,
} from './scheduler.js';
import { createMissionService, type MissionService } from './service.js';

export interface CoreDependencies {
  db: SqlDatabase;
  /** Defaults to the core guards. Later tasks register more on the returned registry. */
  guards?: CompletionGuardRegistry;
  pool?: RunnerPool;
  clock?: () => Date;
  newId?: (prefix: string) => string;
  maxEventsPerMission?: number;
}

export interface Core {
  missions: MissionService;
  scheduler: Scheduler;
  guards: CompletionGuardRegistry;
}

/** Wires the mission service and scheduler over one database. */
export function createCore(deps: CoreDependencies): Core {
  const guards = deps.guards ?? createCompletionGuardRegistry();
  const missions = createMissionService({
    db: deps.db,
    guards,
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
    ...(deps.maxEventsPerMission === undefined
      ? {}
      : { maxEventsPerMission: deps.maxEventsPerMission }),
  });
  const scheduler = createScheduler({
    service: missions,
    pool: deps.pool ?? NO_RUNNERS,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
  return { missions, scheduler, guards };
}
