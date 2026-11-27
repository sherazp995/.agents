/**
 * Which laptop runs a thread's work (README, "Failover"). A thread belongs to
 * the laptop that handled its first message (thread_hosts). Its tasks run
 * there while that laptop is ready; when it is not, the default laptop takes
 * them. Two kinds of task never move: a guest turn (a laptop named in a
 * thread another laptop owns) and a reminder task (it runs as the person that
 * laptop's config names).
 */

import { HOST_FRESH_SECONDS } from './lease.js'

/** Where a scheduler on this laptop may take work; null host means failover is off and every task is local. */
export type Placement = { readonly host: string | null; readonly isDefault: boolean }

/** SQL true when laptop `name` (an SQL expression) is seen recently and on the database's newest build. */
export function hostReadySql(name: string): string {
  return `EXISTS (SELECT 1 FROM failover_hosts ready
                   WHERE ready.name = ${name}
                     AND ready.last_seen_at > now() - make_interval(secs => ${HOST_FRESH_SECONDS})
                     AND ready.build_migration >= COALESCE((SELECT max(name) FROM schema_migrations), ''))`
}

/**
 * SQL true when the autonomous task aliased `task` may run on the laptop in
 * parameter `hostParam` (text, null with failover off), given whether that
 * laptop is the default (`defaultParam`, boolean). Used inside each atomic
 * lease grab, not only when listing, so two laptops ticking together cannot
 * both take a task.
 */
export function taskRunsHereSql(task: string, hostParam: string, defaultParam: string): string {
  return `(${hostParam}::text IS NULL OR EXISTS (
    SELECT 1 FROM sessions place_s
     WHERE place_s.id = ${task}.session_id
       AND CASE
             WHEN place_s.guest_host IS NOT NULL THEN place_s.guest_host = ${hostParam}::text
             WHEN ${task}.pinned_host IS NOT NULL THEN ${task}.pinned_host = ${hostParam}::text
             ELSE EXISTS (SELECT 1 FROM thread_hosts place_th
                           WHERE place_th.workspace_id = place_s.workspace_id AND place_th.adapter = place_s.adapter
                             AND place_th.thread_ref = place_s.thread_ref AND place_th.host = ${hostParam}::text)
               OR (${defaultParam}::boolean AND NOT EXISTS (
                     SELECT 1 FROM thread_hosts place_th
                      WHERE place_th.workspace_id = place_s.workspace_id AND place_th.adapter = place_s.adapter
                        AND place_th.thread_ref = place_s.thread_ref AND ${hostReadySql('place_th.host')}))
           END))`
}
