create extension if not exists pgcrypto;

create table if not exists public.ratings (
  id text primary key,
  platform_id text not null,
  vibe integer not null check (vibe between 1 and 5),
  refuel integer not null check (refuel between 1 and 5),
  seating integer not null check (seating between 1 and 5),
  pride text not null check (pride in ('yes', 'complicated', 'no')),
  umbrella boolean not null,
  comment text,
  created_at timestamptz not null default now(),
  device_id text not null
);

create table if not exists public.name_proposals (
  id text primary key,
  platform_id text not null,
  name text not null check (char_length(name) between 1 and 30),
  votes integer not null default 1,
  created_at timestamptz not null default now(),
  device_id text
);

create or replace function public.vote_name_proposal(proposal_id_input text, delta_input integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.name_proposals
  set votes = greatest(0, votes + delta_input)
  where id = proposal_id_input;
end;
$$;

alter table public.ratings enable row level security;
alter table public.name_proposals enable row level security;

drop policy if exists "public read ratings" on public.ratings;
create policy "public read ratings"
on public.ratings
for select
to anon, authenticated
using (true);

drop policy if exists "public insert ratings" on public.ratings;
create policy "public insert ratings"
on public.ratings
for insert
to anon, authenticated
with check (true);

drop policy if exists "public read proposals" on public.name_proposals;
create policy "public read proposals"
on public.name_proposals
for select
to anon, authenticated
using (true);

drop policy if exists "public insert proposals" on public.name_proposals;
create policy "public insert proposals"
on public.name_proposals
for insert
to anon, authenticated
with check (true);

grant select, insert on public.ratings to anon, authenticated;
grant select, insert on public.name_proposals to anon, authenticated;
grant execute on function public.vote_name_proposal(text, integer) to anon, authenticated;
