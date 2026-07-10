-- Durable queue for Telegram (#8): pgmq queue + RPC wrappers + a single-drainer lease.
create extension if not exists pgmq;
do $$ begin perform pgmq.create('tg_jobs'); exception when others then null; end $$;

create or replace function public.q_send(payload jsonb) returns bigint language sql security definer set search_path=pgmq,public as $$ select pgmq.send('tg_jobs', payload) $$;
create or replace function public.q_read(qty int, vt int default 30) returns setof pgmq.message_record language sql security definer set search_path=pgmq,public as $$ select * from pgmq.read('tg_jobs', vt, qty) $$;
create or replace function public.q_delete(mid bigint) returns boolean language sql security definer set search_path=pgmq,public as $$ select pgmq.delete('tg_jobs', mid) $$;
create or replace function public.q_len() returns bigint language sql security definer set search_path=pgmq,public as $$ select count(*)::bigint from pgmq.q_tg_jobs $$;

-- Lease: exactly one worker drains at a time (advisory locks don't survive the transaction pooler).
create table if not exists public.worker_lease (id int primary key, locked_until timestamptz not null default now());
insert into public.worker_lease(id, locked_until) values (1, now()) on conflict (id) do nothing;
create or replace function public.acquire_worker_lease(secs int default 60) returns boolean language sql as $$ update public.worker_lease set locked_until = now() + make_interval(secs => secs) where id = 1 and locked_until < now() returning true $$;
create or replace function public.release_worker_lease() returns boolean language sql as $$ update public.worker_lease set locked_until = now() where id = 1 returning true $$;

grant execute on function public.q_send(jsonb), public.q_read(int,int), public.q_delete(bigint), public.q_len(), public.acquire_worker_lease(int), public.release_worker_lease() to service_role;
