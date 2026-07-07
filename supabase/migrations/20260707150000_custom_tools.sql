-- Custom tools ("Мои инструменты") — the user teaches an agent a NEW skill without us
-- coding it: either a plain HTTP endpoint (URL + auth + parameter schema) or a whole MCP
-- server (a community tool bundle). Each enabled row becomes a callable function the model
-- can pick during runAgentTools. Secrets (auth headers) are read server-side only.
-- Account-scoped via RLS like the rest of the schema.

create table if not exists public.custom_tools (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  kind          text not null default 'http' check (kind in ('http', 'mcp')),
  name          text not null,                                 -- function name the model calls (a-z0-9_)
  description   text not null default '',                      -- when to use it (the model reads this)
  -- HTTP tool
  method        text not null default 'POST' check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url           text not null default '',                      -- may contain {{param}} placeholders
  headers       jsonb not null default '{}'::jsonb,            -- static headers incl. Authorization (secret)
  params        jsonb not null default '[]'::jsonb,            -- [{name,type,description,required}]
  body_template text not null default '',                     -- optional JSON body with {{param}} placeholders
  -- MCP server
  mcp_url       text not null default '',                      -- streamable-HTTP MCP endpoint
  mcp_headers   jsonb not null default '{}'::jsonb,            -- auth headers for the MCP server (secret)
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.custom_tools enable row level security;

-- Owner manages their own tools from the UI. The reply bots read enabled rows with the
-- service_role key (bypasses RLS) to build the tool list, like the other server-side flows.
drop policy if exists custom_tools_acc on public.custom_tools;
create policy custom_tools_acc on public.custom_tools for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists custom_tools_acc_idx on public.custom_tools (account_id, created_at desc);
