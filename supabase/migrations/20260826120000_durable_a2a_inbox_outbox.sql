-- ADR 001/002 extension: tenant-safe durable delivery for compact agent-to-agent messages.

create table runtime.a2a_outbox_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  message_id uuid not null,
  protocol_version text not null default '1.0',
  from_agent_id text not null,
  to_agent_id text not null,
  intent text not null,
  sender_lease_epoch bigint not null,
  message jsonb not null,
  message_hash text not null,
  status text not null default 'pending',
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint a2a_outbox_account_id_id_key unique (account_id, id),
  constraint a2a_outbox_message_key unique (account_id, workflow_id, message_id),
  constraint a2a_outbox_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint a2a_outbox_protocol_check check (protocol_version = '1.0'),
  constraint a2a_outbox_agent_check check (
    from_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and to_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and from_agent_id <> to_agent_id
  ),
  constraint a2a_outbox_intent_check check (intent in ('handoff', 'query', 'approval_request', 'result', 'error')),
  constraint a2a_outbox_sender_epoch_check check (sender_lease_epoch > 0),
  constraint a2a_outbox_message_uuidv7_check check (substring(message_id::text from 15 for 1) = '7'),
  constraint a2a_outbox_message_object_check check (jsonb_typeof(message) = 'object'),
  constraint a2a_outbox_message_size_check check (octet_length(message::text) <= 16384),
  constraint a2a_outbox_message_hash_check check (message_hash ~ '^[0-9a-f]{64}$'),
  constraint a2a_outbox_no_secret_keys_check check (
    message::text !~* '"(authorization|cookie|password|passwd|secret|api_?key|access_?token|refresh_?token|service_?role(_?key)?|private_?key)"[[:space:]]*:'
  ),
  constraint a2a_outbox_message_identity_check check (
    message ->> 'version' = protocol_version
    and message ->> 'account_id' = account_id::text
    and message ->> 'workflow_id' = workflow_id::text
    and message ->> 'message_id' = message_id::text
    and message ->> 'from_agent_id' = from_agent_id
    and message ->> 'to_agent_id' = to_agent_id
    and message ->> 'intent' = intent
    and (message ->> 'sender_lease_epoch')::bigint = sender_lease_epoch
  ),
  constraint a2a_outbox_status_check check (status in ('pending', 'delivering', 'delivered', 'failed')),
  constraint a2a_outbox_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint a2a_outbox_lease_epoch_check check (lease_epoch >= 0),
  constraint a2a_outbox_lease_integrity_check check (
    (status = 'delivering' and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (status <> 'delivering' and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint a2a_outbox_delivery_integrity_check check (
    (status = 'delivered' and delivered_at is not null and next_attempt_at is null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  constraint a2a_outbox_retry_integrity_check check (
    (status = 'pending' and attempt_count > 0 and next_attempt_at is not null)
    or (status = 'pending' and attempt_count = 0 and next_attempt_at is null)
    or status <> 'pending'
  ),
  constraint a2a_outbox_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create index a2a_outbox_claim_idx
  on runtime.a2a_outbox_messages (coalesce(next_attempt_at, created_at), created_at, id)
  where status in ('pending', 'delivering');

create table runtime.a2a_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  message_id uuid not null,
  protocol_version text not null default '1.0',
  from_agent_id text not null,
  to_agent_id text not null,
  intent text not null,
  sender_lease_epoch bigint not null,
  message jsonb not null,
  message_hash text not null,
  status text not null default 'delivered',
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  processed_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint a2a_inbox_account_id_id_key unique (account_id, id),
  constraint a2a_inbox_message_key unique (account_id, workflow_id, message_id),
  constraint a2a_inbox_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint a2a_inbox_protocol_check check (protocol_version = '1.0'),
  constraint a2a_inbox_agent_check check (
    from_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and to_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and from_agent_id <> to_agent_id
  ),
  constraint a2a_inbox_intent_check check (intent in ('handoff', 'query', 'approval_request', 'result', 'error')),
  constraint a2a_inbox_sender_epoch_check check (sender_lease_epoch > 0),
  constraint a2a_inbox_message_uuidv7_check check (substring(message_id::text from 15 for 1) = '7'),
  constraint a2a_inbox_message_object_check check (jsonb_typeof(message) = 'object'),
  constraint a2a_inbox_message_size_check check (octet_length(message::text) <= 16384),
  constraint a2a_inbox_message_hash_check check (message_hash ~ '^[0-9a-f]{64}$'),
  constraint a2a_inbox_no_secret_keys_check check (
    message::text !~* '"(authorization|cookie|password|passwd|secret|api_?key|access_?token|refresh_?token|service_?role(_?key)?|private_?key)"[[:space:]]*:'
  ),
  constraint a2a_inbox_message_identity_check check (
    message ->> 'version' = protocol_version
    and message ->> 'account_id' = account_id::text
    and message ->> 'workflow_id' = workflow_id::text
    and message ->> 'message_id' = message_id::text
    and message ->> 'from_agent_id' = from_agent_id
    and message ->> 'to_agent_id' = to_agent_id
    and message ->> 'intent' = intent
    and (message ->> 'sender_lease_epoch')::bigint = sender_lease_epoch
  ),
  constraint a2a_inbox_status_check check (status in ('delivered', 'processing', 'processed', 'failed')),
  constraint a2a_inbox_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint a2a_inbox_lease_epoch_check check (lease_epoch >= 0),
  constraint a2a_inbox_lease_integrity_check check (
    (status = 'processing' and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (status <> 'processing' and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint a2a_inbox_processed_integrity_check check (
    (status = 'processed' and processed_at is not null)
    or (status <> 'processed' and processed_at is null)
  ),
  constraint a2a_inbox_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create index a2a_inbox_claim_idx
  on runtime.a2a_inbox_messages (received_at, id)
  where status in ('delivered', 'processing');

alter table runtime.a2a_outbox_messages enable row level security;
alter table runtime.a2a_inbox_messages enable row level security;
revoke all on runtime.a2a_outbox_messages, runtime.a2a_inbox_messages from public, anon, authenticated;

create function public.runtime_enqueue_a2a_message(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_message jsonb
)
returns table (enqueue_status text, outbox_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_message_id uuid;
  v_hash text;
  v_outbox_id uuid;
  v_existing_hash text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' or octet_length(p_message::text) > 16384 then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;

  select run.* into v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if not found
    or v_run.current_state <> 'running'
    or v_run.lease_epoch <> p_expected_epoch
    or v_run.claim_token <> p_claim_token
    or v_run.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'workflow fence rejected';
  end if;

  begin
    v_message_id := (p_message ->> 'message_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end;

  if p_message ->> 'version' <> '1.0'
    or p_message ->> 'account_id' <> p_account_id::text
    or p_message ->> 'workflow_id' <> p_workflow_id::text
    or (p_message ->> 'sender_lease_epoch')::bigint <> p_expected_epoch then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;

  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_message::text, 'UTF8'), 'sha256'), 'hex');

  insert into runtime.a2a_outbox_messages (
    account_id, workflow_id, message_id, protocol_version, from_agent_id, to_agent_id,
    intent, sender_lease_epoch, message, message_hash
  ) values (
    p_account_id, p_workflow_id, v_message_id, p_message ->> 'version',
    p_message ->> 'from_agent_id', p_message ->> 'to_agent_id', p_message ->> 'intent',
    p_expected_epoch, p_message, v_hash
  )
  on conflict on constraint a2a_outbox_message_key do nothing
  returning id into v_outbox_id;

  if v_outbox_id is not null then
    return query select 'created'::text, v_outbox_id, v_message_id;
    return;
  end if;

  select item.id, item.message_hash into v_outbox_id, v_existing_hash
  from runtime.a2a_outbox_messages as item
  where item.account_id = p_account_id
    and item.workflow_id = p_workflow_id
    and item.message_id = v_message_id;

  if v_existing_hash <> v_hash then
    raise exception using errcode = '23505', message = 'a2a idempotency collision';
  end if;
  return query select 'duplicate'::text, v_outbox_id, v_message_id;
end;
$$;

create function public.runtime_claim_a2a_outbox(
  p_worker_id text,
  p_lease_duration_seconds integer default 60,
  p_limit integer default 10
)
returns table (
  account_id uuid, outbox_id uuid, workflow_id uuid, message_id uuid, message jsonb,
  claim_token uuid, lease_epoch bigint, lease_until timestamptz, attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160
    or p_lease_duration_seconds not between 5 and 600
    or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid a2a claim parameters';
  end if;
  if exists (
    select 1 from runtime.system_controls as controls
    where controls.singleton and (controls.kill_switch_active or controls.claims_paused)
  ) then return; end if;

  return query
  with candidates as (
    select item.id
    from runtime.a2a_outbox_messages as item
    where item.attempt_count < item.max_attempts
      and (
        (item.status = 'pending' and (item.next_attempt_at is null or item.next_attempt_at <= clock_timestamp()))
        or (item.status = 'delivering' and item.lease_until <= clock_timestamp())
      )
    order by coalesce(item.next_attempt_at, item.created_at), item.created_at, item.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update runtime.a2a_outbox_messages as item
    set status = 'delivering',
        lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        claim_token = gen_random_uuid(),
        lease_epoch = item.lease_epoch + 1,
        attempt_count = item.attempt_count + 1,
        next_attempt_at = null,
        last_error_code = null,
        updated_at = clock_timestamp()
    from candidates
    where item.id = candidates.id
    returning item.*
  )
  select claimed.account_id, claimed.id, claimed.workflow_id, claimed.message_id, claimed.message,
         claimed.claim_token, claimed.lease_epoch, claimed.lease_until, claimed.attempt_count
  from claimed;
end;
$$;

create function public.runtime_finish_a2a_delivery(
  p_account_id uuid,
  p_outbox_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_delivered boolean,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item runtime.a2a_outbox_messages%rowtype;
  v_status text;
begin
  select item.* into v_item
  from runtime.a2a_outbox_messages as item
  where item.account_id = p_account_id and item.id = p_outbox_id
  for update;
  if not found or v_item.status <> 'delivering' or v_item.lease_epoch <> p_expected_epoch
    or v_item.claim_token <> p_claim_token or v_item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'a2a delivery fence rejected';
  end if;
  if not p_delivered and (p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using errcode = '22023', message = 'invalid a2a delivery result';
  end if;

  v_status := case when p_delivered then 'delivered'
    when v_item.attempt_count >= v_item.max_attempts then 'failed' else 'pending' end;
  update runtime.a2a_outbox_messages as item
  set status = v_status,
      lease_holder = null, lease_until = null, claim_token = null,
      delivered_at = case when p_delivered then clock_timestamp() else null end,
      next_attempt_at = case when v_status = 'pending'
        then clock_timestamp() + pg_catalog.make_interval(secs => least(300, (2 ^ least(v_item.attempt_count, 8))::integer))
        else null end,
      last_error_code = case when p_delivered then null else p_error_code end,
      updated_at = clock_timestamp()
  where item.account_id = p_account_id and item.id = p_outbox_id;
  return v_status;
end;
$$;

create function public.runtime_receive_a2a_message(p_message jsonb)
returns table (receive_status text, inbox_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_workflow_id uuid;
  v_message_id uuid;
  v_hash text;
  v_inbox_id uuid;
  v_existing_hash text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' or octet_length(p_message::text) > 16384 then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  begin
    v_account_id := (p_message ->> 'account_id')::uuid;
    v_workflow_id := (p_message ->> 'workflow_id')::uuid;
    v_message_id := (p_message ->> 'message_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end;
  if p_message ->> 'version' <> '1.0' then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  if not exists (
    select 1 from runtime.workflow_runs as run
    where run.account_id = v_account_id and run.id = v_workflow_id
  ) then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_message::text, 'UTF8'), 'sha256'), 'hex');
  if not exists (
    select 1 from runtime.a2a_outbox_messages as sent
    where sent.account_id = v_account_id
      and sent.workflow_id = v_workflow_id
      and sent.message_id = v_message_id
      and sent.message_hash = v_hash
      and sent.sender_lease_epoch = (p_message ->> 'sender_lease_epoch')::bigint
      and sent.status in ('delivering', 'delivered')
  ) then
    raise exception using errcode = '55000', message = 'a2a source proof rejected';
  end if;
  insert into runtime.a2a_inbox_messages (
    account_id, workflow_id, message_id, protocol_version, from_agent_id, to_agent_id,
    intent, sender_lease_epoch, message, message_hash
  ) values (
    v_account_id, v_workflow_id, v_message_id, p_message ->> 'version',
    p_message ->> 'from_agent_id', p_message ->> 'to_agent_id', p_message ->> 'intent',
    (p_message ->> 'sender_lease_epoch')::bigint, p_message, v_hash
  )
  on conflict on constraint a2a_inbox_message_key do nothing
  returning id into v_inbox_id;
  if v_inbox_id is not null then
    return query select 'created'::text, v_inbox_id, v_message_id;
    return;
  end if;
  select item.id, item.message_hash into v_inbox_id, v_existing_hash
  from runtime.a2a_inbox_messages as item
  where item.account_id = v_account_id and item.workflow_id = v_workflow_id and item.message_id = v_message_id;
  if v_existing_hash <> v_hash then
    raise exception using errcode = '23505', message = 'a2a idempotency collision';
  end if;
  return query select 'duplicate'::text, v_inbox_id, v_message_id;
end;
$$;

create function public.runtime_claim_a2a_inbox(
  p_worker_id text,
  p_to_agent_id text,
  p_lease_duration_seconds integer default 60,
  p_limit integer default 10
)
returns table (
  account_id uuid, inbox_id uuid, workflow_id uuid, message_id uuid, message jsonb,
  claim_token uuid, lease_epoch bigint, lease_until timestamptz, attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160
    or p_to_agent_id is null or p_to_agent_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_lease_duration_seconds not between 5 and 600
    or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid a2a claim parameters';
  end if;
  if exists (
    select 1 from runtime.system_controls as controls
    where controls.singleton and (controls.kill_switch_active or controls.claims_paused)
  ) then return; end if;
  return query
  with candidates as (
    select item.id
    from runtime.a2a_inbox_messages as item
    where item.to_agent_id = p_to_agent_id
      and item.attempt_count < item.max_attempts
      and (item.status = 'delivered' or (item.status = 'processing' and item.lease_until <= clock_timestamp()))
    order by item.received_at, item.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update runtime.a2a_inbox_messages as item
    set status = 'processing', lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        claim_token = gen_random_uuid(), lease_epoch = item.lease_epoch + 1,
        attempt_count = item.attempt_count + 1, last_error_code = null, updated_at = clock_timestamp()
    from candidates where item.id = candidates.id
    returning item.*
  )
  select claimed.account_id, claimed.id, claimed.workflow_id, claimed.message_id, claimed.message,
         claimed.claim_token, claimed.lease_epoch, claimed.lease_until, claimed.attempt_count
  from claimed;
end;
$$;

create function public.runtime_finish_a2a_processing(
  p_account_id uuid,
  p_inbox_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_processed boolean,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item runtime.a2a_inbox_messages%rowtype;
  v_status text;
begin
  select item.* into v_item from runtime.a2a_inbox_messages as item
  where item.account_id = p_account_id and item.id = p_inbox_id for update;
  if not found or v_item.status <> 'processing' or v_item.lease_epoch <> p_expected_epoch
    or v_item.claim_token <> p_claim_token or v_item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'a2a processing fence rejected';
  end if;
  if not p_processed and (p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using errcode = '22023', message = 'invalid a2a processing result';
  end if;
  v_status := case when p_processed then 'processed'
    when v_item.attempt_count >= v_item.max_attempts then 'failed' else 'delivered' end;
  update runtime.a2a_inbox_messages as item
  set status = v_status, lease_holder = null, lease_until = null, claim_token = null,
      processed_at = case when p_processed then clock_timestamp() else null end,
      last_error_code = case when p_processed then null else p_error_code end,
      updated_at = clock_timestamp()
  where item.account_id = p_account_id and item.id = p_inbox_id;
  return v_status;
end;
$$;

revoke all on function public.runtime_enqueue_a2a_message(uuid, uuid, bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.runtime_claim_a2a_outbox(text, integer, integer) from public, anon, authenticated;
revoke all on function public.runtime_finish_a2a_delivery(uuid, uuid, bigint, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.runtime_receive_a2a_message(jsonb) from public, anon, authenticated;
revoke all on function public.runtime_claim_a2a_inbox(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.runtime_finish_a2a_processing(uuid, uuid, bigint, uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.runtime_enqueue_a2a_message(uuid, uuid, bigint, uuid, jsonb) to service_role;
grant execute on function public.runtime_claim_a2a_outbox(text, integer, integer) to service_role;
grant execute on function public.runtime_finish_a2a_delivery(uuid, uuid, bigint, uuid, boolean, text) to service_role;
grant execute on function public.runtime_receive_a2a_message(jsonb) to service_role;
grant execute on function public.runtime_claim_a2a_inbox(text, text, integer, integer) to service_role;
grant execute on function public.runtime_finish_a2a_processing(uuid, uuid, bigint, uuid, boolean, text) to service_role;

comment on table runtime.a2a_outbox_messages is 'Lease-fenced durable A2A delivery queue; browser roles have no access.';
comment on table runtime.a2a_inbox_messages is 'Idempotent durable A2A receive queue; browser roles have no access.';
