begin;

create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null,
  avatar_url text,
  role text not null default 'user' check (role in ('admin', 'user')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 160),
  description text not null default '',
  task_type text not null check (task_type in ('public', 'personal')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status text not null default 'Pending' check (status in ('Pending', 'In Progress', 'Submitted', 'Completed', 'Rejected')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'Pending' check (status in ('Pending', 'In Progress', 'Submitted', 'Completed', 'Rejected')),
  submitted_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (task_id, user_id)
);

create table public.star_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  task_id uuid not null references public.tasks(id) on delete restrict,
  stars integer not null default 1 check (stars = 1),
  created_at timestamptz not null default now(),
  awarded_by uuid references public.profiles(id) on delete set null,
  unique (task_id, user_id)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  type text not null check (type in ('new_task', 'task_approved', 'task_rejected')),
  related_task_id uuid references public.tasks(id) on delete set null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.email_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  task_id uuid references public.tasks(id) on delete set null,
  email_type text not null check (email_type in ('new_task', 'task_approved', 'task_rejected')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (user_id, task_id, email_type)
);

create index task_assignments_user_status_idx on public.task_assignments(user_id, status, created_at desc);
create index task_assignments_task_status_idx on public.task_assignments(task_id, status);
create index star_transactions_created_at_idx on public.star_transactions(created_at desc);
create index notifications_user_unread_idx on public.notifications(user_id, is_read, created_at desc);
create index tasks_created_at_idx on public.tasks(created_at desc);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and is_active
  );
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and is_active
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_task_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_task_updated_at();

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignments enable row level security;
alter table public.star_transactions enable row level security;
alter table public.notifications enable row level security;
alter table public.email_logs enable row level security;

revoke all on public.profiles, public.tasks, public.task_assignments, public.star_transactions, public.notifications, public.email_logs from anon, authenticated;
grant select on public.profiles, public.tasks, public.task_assignments, public.star_transactions, public.notifications, public.email_logs to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy tasks_read_assigned_or_admin on public.tasks
  for select to authenticated using (
    (select public.is_admin()) or ((select public.is_active_user()) and exists (
      select 1 from public.task_assignments a
      where a.task_id = tasks.id and a.user_id = (select auth.uid())
    ))
  );

create policy assignments_read_self_or_admin on public.task_assignments
  for select to authenticated using ((user_id = (select auth.uid()) and (select public.is_active_user())) or (select public.is_admin()));

create policy stars_read_self_or_admin on public.star_transactions
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy notifications_read_self on public.notifications
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_active_user()));

create policy email_logs_read_admin on public.email_logs
  for select to authenticated using ((select public.is_admin()));

create or replace function public.create_task(
  p_title text,
  p_description text,
  p_task_type text,
  p_priority text,
  p_due_date timestamptz default null,
  p_assigned_user uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_id uuid;
  v_count integer;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Title must be 1 to 160 characters'; end if;
  if p_task_type not in ('public', 'personal') then raise exception 'Invalid task type'; end if;
  if p_priority not in ('low', 'medium', 'high') then raise exception 'Invalid priority'; end if;
  if p_task_type = 'personal' and p_assigned_user is null then raise exception 'Choose a user for a personal task'; end if;
  if p_task_type = 'public' and p_assigned_user is not null then raise exception 'Public tasks cannot target one user'; end if;

  insert into public.tasks (title, description, task_type, priority, created_by, due_date)
  values (trim(p_title), coalesce(p_description, ''), p_task_type, p_priority, auth.uid(), p_due_date)
  returning id into v_task_id;

  if p_task_type = 'public' then
    insert into public.task_assignments (task_id, user_id)
    select v_task_id, id from public.profiles where is_active;
  else
    if not exists (select 1 from public.profiles where id = p_assigned_user and is_active) then
      raise exception 'Selected user is not active';
    end if;
    insert into public.task_assignments (task_id, user_id) values (v_task_id, p_assigned_user);
  end if;

  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'No active users are available for assignment'; end if;

  insert into public.notifications (user_id, title, message, type, related_task_id)
  select a.user_id, 'New task assigned', 'You have a new task: ' || trim(p_title), 'new_task', v_task_id
  from public.task_assignments a where a.task_id = v_task_id;

  return v_task_id;
end;
$$;

create or replace function public.set_assignment_status(p_assignment_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_id uuid;
  v_current_status text;
begin
  if not public.is_active_user() then raise exception 'Active account required'; end if;
  select task_id, status into v_task_id, v_current_status
  from public.task_assignments where id = p_assignment_id and user_id = auth.uid() for update;
  if not found then raise exception 'Task assignment not found'; end if;
  if p_status not in ('In Progress', 'Submitted') then raise exception 'Invalid status'; end if;
  if v_current_status in ('Submitted', 'Completed') then raise exception 'This task cannot be changed in its current state'; end if;

  update public.task_assignments
  set status = p_status,
      submitted_at = case when p_status = 'Submitted' then now() else null end,
      rejection_reason = null
  where id = p_assignment_id;

  update public.tasks t set status = case
    when exists (select 1 from public.task_assignments a where a.task_id = v_task_id and a.status = 'Submitted') then 'Submitted'
    when exists (select 1 from public.task_assignments a where a.task_id = v_task_id and a.status = 'In Progress') then 'In Progress'
    when not exists (select 1 from public.task_assignments a where a.task_id = v_task_id and a.status <> 'Completed') then 'Completed'
    when exists (select 1 from public.task_assignments a where a.task_id = v_task_id and a.status = 'Rejected') then 'Rejected'
    else 'Pending' end
  where t.id = v_task_id;
end;
$$;

create or replace function public.review_task(p_assignment_id uuid, p_decision text, p_rejection_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.task_assignments%rowtype;
  v_task_title text;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'Invalid review decision'; end if;
  if p_decision = 'reject' and length(trim(coalesce(p_rejection_reason, ''))) = 0 then
    raise exception 'A reason is required when rejecting a task';
  end if;

  select * into v_assignment from public.task_assignments where id = p_assignment_id for update;
  if not found or v_assignment.status <> 'Submitted' then raise exception 'Only submitted tasks can be reviewed'; end if;
  select title into v_task_title from public.tasks where id = v_assignment.task_id;

  update public.task_assignments
  set status = case when p_decision = 'approve' then 'Completed' else 'Rejected' end,
      completed_at = case when p_decision = 'approve' then now() else null end,
      reviewed_at = now(), reviewed_by = auth.uid(),
      rejection_reason = case when p_decision = 'reject' then trim(p_rejection_reason) else null end
  where id = p_assignment_id;

  if p_decision = 'approve' then
    insert into public.star_transactions (user_id, task_id, stars, awarded_by)
    values (v_assignment.user_id, v_assignment.task_id, 1, auth.uid())
    on conflict (task_id, user_id) do nothing;
    insert into public.notifications (user_id, title, message, type, related_task_id)
    values (v_assignment.user_id, 'Task approved', 'Your task was approved: ' || v_task_title, 'task_approved', v_assignment.task_id);
  else
    insert into public.notifications (user_id, title, message, type, related_task_id)
    values (v_assignment.user_id, 'Task needs another pass', 'Your task was rejected: ' || v_task_title, 'task_rejected', v_assignment.task_id);
  end if;

  update public.tasks t set status = case
    when exists (select 1 from public.task_assignments a where a.task_id = v_assignment.task_id and a.status = 'Submitted') then 'Submitted'
    when exists (select 1 from public.task_assignments a where a.task_id = v_assignment.task_id and a.status = 'In Progress') then 'In Progress'
    when not exists (select 1 from public.task_assignments a where a.task_id = v_assignment.task_id and a.status <> 'Completed') then 'Completed'
    when exists (select 1 from public.task_assignments a where a.task_id = v_assignment.task_id and a.status = 'Rejected') then 'Rejected'
    else 'Pending' end
  where t.id = v_assignment.task_id;

  return jsonb_build_object('task_id', v_assignment.task_id, 'user_id', v_assignment.user_id, 'decision', p_decision);
end;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_user() then raise exception 'Active account required'; end if;
  update public.notifications set is_read = true
  where id = p_notification_id and user_id = auth.uid();
end;
$$;

create or replace function public.mark_all_notifications_read()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_user() then raise exception 'Active account required'; end if;
  update public.notifications set is_read = true
  where user_id = auth.uid() and not is_read;
end;
$$;

create or replace function public.update_task(
  p_task_id uuid,
  p_title text,
  p_description text,
  p_priority text,
  p_due_date timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Title must be 1 to 160 characters'; end if;
  if p_priority not in ('low', 'medium', 'high') then raise exception 'Invalid priority'; end if;
  update public.tasks
  set title = trim(p_title), description = coalesce(p_description, ''), priority = p_priority, due_date = p_due_date
  where id = p_task_id;
  if not found then raise exception 'Task not found'; end if;
end;
$$;

create or replace function public.delete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  delete from public.tasks where id = p_task_id;
  if not found then raise exception 'Task not found'; end if;
end;
$$;

create or replace function public.set_user_active(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_count integer;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if p_user_id = auth.uid() and not p_is_active then raise exception 'You cannot deactivate your own account'; end if;
  if not p_is_active and exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    select count(*) into v_admin_count from public.profiles where role = 'admin' and is_active;
    if v_admin_count <= 1 then raise exception 'The last active admin cannot be deactivated'; end if;
  end if;
  update public.profiles set is_active = p_is_active where id = p_user_id;
  if not found then raise exception 'User not found'; end if;
end;
$$;

create or replace function public.leaderboard_scores(p_period_start timestamptz, p_period_end timestamptz)
returns table (user_id uuid, full_name text, avatar_url text, stars bigint, approved_tasks bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.full_name, p.avatar_url,
         coalesce(sum(s.stars), 0)::bigint, count(s.id)::bigint
  from public.profiles p
  left join public.star_transactions s
    on s.user_id = p.id and s.created_at >= p_period_start and s.created_at < p_period_end
  where p.is_active
    and (select auth.uid()) is not null
    and p_period_start < p_period_end
  group by p.id, p.full_name, p.avatar_url
  order by coalesce(sum(s.stars), 0) desc, count(s.id) desc, p.full_name asc, p.id asc;
$$;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles where role = 'user'),
    'active_users', (select count(*) from public.profiles where role = 'user' and is_active),
    'total_tasks', (select count(*) from public.tasks),
    'completed_tasks', (select count(*) from public.task_assignments where status = 'Completed'),
    'pending_approvals', (select count(*) from public.task_assignments where status = 'Submitted'),
    'tasks_created_this_month', (select count(*) from public.tasks where created_at >= v_month_start),
    'stars_this_month', (select coalesce(sum(stars), 0) from public.star_transactions where created_at >= v_month_start)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.claim_email(p_user_id uuid, p_task_id uuid, p_email_type text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  insert into public.email_logs (user_id, task_id, email_type, status)
  values (p_user_id, p_task_id, p_email_type, 'sending')
  on conflict (user_id, task_id, email_type) do update
    set status = 'sending', error_message = null, sent_at = null
    where public.email_logs.status = 'failed'
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finish_email(p_log_id uuid, p_status text, p_error_message text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_status not in ('sent', 'failed') then raise exception 'Invalid email status'; end if;
  update public.email_logs
  set status = p_status,
      sent_at = case when p_status = 'sent' then now() else null end,
      error_message = case when p_status = 'failed' then left(p_error_message, 1000) else null end
  where id = p_log_id;
end;
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;
revoke all on function public.create_task(text, text, text, text, timestamptz, uuid) from public, anon;
grant execute on function public.create_task(text, text, text, text, timestamptz, uuid) to authenticated;
revoke all on function public.set_assignment_status(uuid, text) from public, anon;
grant execute on function public.set_assignment_status(uuid, text) to authenticated;
revoke all on function public.review_task(uuid, text, text) from public, anon;
grant execute on function public.review_task(uuid, text, text) to authenticated;
revoke all on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_all_notifications_read() to authenticated;
revoke all on function public.update_task(uuid, text, text, text, timestamptz) from public, anon;
grant execute on function public.update_task(uuid, text, text, text, timestamptz) to authenticated;
revoke all on function public.delete_task(uuid) from public, anon;
grant execute on function public.delete_task(uuid) to authenticated;
revoke all on function public.set_user_active(uuid, boolean) from public, anon;
grant execute on function public.set_user_active(uuid, boolean) to authenticated;
revoke all on function public.leaderboard_scores(timestamptz, timestamptz) from public, anon;
grant execute on function public.leaderboard_scores(timestamptz, timestamptz) to authenticated;
revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
revoke all on function public.claim_email(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_email(uuid, uuid, text) to service_role;
revoke all on function public.finish_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finish_email(uuid, text, text) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
      execute 'alter publication supabase_realtime add table public.notifications';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'star_transactions') then
      execute 'alter publication supabase_realtime add table public.star_transactions';
    end if;
  end if;
end;
$$;

commit;