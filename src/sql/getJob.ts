import { Job, WithPgClient } from "../interfaces";
import { CompiledSharedOptions } from "../lib";

export async function getJob(
  compiledSharedOptions: CompiledSharedOptions,
  withPgClient: WithPgClient,
  workerId: string,
  supportedTaskNames: string[],
  useNodeTime: boolean,
  flagsToSkip: string[] | null,
): Promise<Job | undefined> {
  const {
    escapedWorkerSchema,
    workerSchema,
    options: { noPreparedStatements },
  } = compiledSharedOptions;

  let i = 2;
  const hasFlags = flagsToSkip && flagsToSkip.length > 0;
  const flagsClause = hasFlags
    ? `and ((flags ?| $${++i}::text[]) is not true)`
    : "";
  const now = useNodeTime ? `$${++i}::timestamptz` : "now()";

  const queueClause = `and (
      jobs.job_queue_id is null
      or exists (
        select 1
        from ${escapedWorkerSchema}.job_queues
        where job_queues.id = jobs.job_queue_id
        and job_queues.is_available = true
        for update
        skip locked
      )
    )`;

  // TODO: rewrite the task_id check
  const text = `\
with j as (
  select jobs.job_queue_id, jobs.priority, jobs.run_at, jobs.id
    from ${escapedWorkerSchema}.jobs
    where jobs.is_available = true
    and run_at <= ${now}
    and task_id in (
      select id
      from ${escapedWorkerSchema}.tasks
      where identifier = any($2::text[])
    )
    ${queueClause}
    ${flagsClause}
    order by priority asc, run_at asc
    limit 1
    for update
    skip locked
),
q as (
  update ${escapedWorkerSchema}.job_queues
    set
      locked_by = $1::text,
      locked_at = ${now}
    from j
    where job_queues.id = j.job_queue_id
)
  update ${escapedWorkerSchema}.jobs
    set
      attempts = jobs.attempts + 1,
      locked_by = $1::text,
      locked_at = ${now}
    from j
    where jobs.id = j.id
    returning *, (select identifier from ${escapedWorkerSchema}.tasks where tasks.id = jobs.task_id) as task_identifier`;
  // TODO: breaking change; change this to more optimal:
  // `RETURNING id, job_queue_id, task_id, payload`,
  const values = [
    workerId,
    supportedTaskNames,
    ...(hasFlags ? [flagsToSkip!] : []),
    ...(useNodeTime ? [new Date().toISOString()] : []),
  ];
  const name = noPreparedStatements
    ? undefined
    : `get_job${hasFlags ? "F" : ""}${useNodeTime ? "N" : ""}/${workerSchema}`;

  const {
    rows: [jobRow],
  } = await withPgClient((client) =>
    client.query<Job>({
      text,
      values,
      name,
    }),
  );
  return jobRow;
}
