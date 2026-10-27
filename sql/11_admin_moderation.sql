-- Admin moderation: creator/admin roles, mutes, deletion of any
-- public message, ban/unban, role assignment.
--
-- Roles (public.profiles.role):
--   'user'    regular player (default);
--   'creator' site owner: everything an admin has, plus deleting whole
--             clubs, forum threads, and blog posts, and managing admin roles;
--   'admin'   moderator with public-message powers only.
--
-- Moderators (admins) may:
--   * delete ANY public message (global chat, club chat, forum replies),
--     one by one; game chat and DMs are not public and are never
--     moderated; whole clubs, threads, and blog posts are out of scope;
--   * mute the author of a public message for N minutes (default 15),
--     which blocks the global chat, club chat, forum, and blog
--     (games and DMs stay untouched);
--   * ban/unban accounts (a ban ends the offender's active games as a
--     forfeit "opponent blocked") and delete accounts;
--   * assign user/creator/admin roles.
--
-- Deleting a whole club / forum thread / blog post is reserved for the
-- creator; an admin cannot do it at any level.
--
-- Hierarchy guard: the creator cannot be muted, banned, deleted, or
-- demoted; an admin answers only to the creator; self-actions are denied.
-- Idempotent; depends on 02/03/04/05/06/08.

-- 1. Role column
alter table public.profiles
    add column if not exists role text not null default 'user'
    check (role in ('user','creator','admin'));

-- initial role assignment (idempotent; matches 0 rows on a fresh database)
update public.profiles set role = 'creator' where username = 'top_igrok_best' and role <> 'creator';

-- 2. Mutes
create table if not exists public.mutes (
    user_id    uuid primary key references public.profiles(id) on delete cascade,
    muted_by   uuid references public.profiles(id) on delete set null,
    until      timestamptz not null,
    reason     text,
    created_at timestamptz not null default now()
);

alter table public.mutes enable row level security;
-- each user reads only their own mute status (the UI can hint "muted");
-- everything else goes through security definer functions
drop policy if exists "mutes_select_own" on public.mutes;
create policy "mutes_select_own" on public.mutes for select to authenticated
    using (user_id = auth.uid());

-- 3. Helpers (security definer, called from policies and RPCs)
create or replace function public.p_role(p_uid uuid)
returns text language sql stable security definer set search_path = public as
$$ select coalesce((select role from public.profiles where id = p_uid), 'user') $$;

create or replace function public.is_muted(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.mutes m where m.user_id = p_uid and m.until > now()) $$;

create or replace function public.mute_until(p_uid uuid)
returns timestamptz language sql stable security definer set search_path = public as
$$ select (select max(until) from public.mutes m where m.user_id = p_uid and m.until > now()) $$;

-- verifies the caller is a moderator and returns their role
create or replace function public._require_mod()
returns text language plpgsql security definer set search_path = public as $$
declare v_role text := public.p_role(auth.uid());
begin
    if v_role not in ('creator','admin') then
        raise exception 'Недостаточно прав: действие только для создателя или админа';
    end if;
    return v_role;
end $$;

-- no action may target an equal or higher role
create or replace function public._mod_can_touch(p_caller_role text, p_target uuid, p_what text)
returns void language plpgsql security definer set search_path = public as $$
declare v_target_role text;
begin
    select role into v_target_role from public.profiles where id = p_target;
    if not found then raise exception 'Игрок не найден'; end if;
    if v_target_role = 'creator' then
        raise exception 'Создателя сайта % нельзя', p_what;
    end if;
    if v_target_role = 'admin' and p_caller_role <> 'creator' then
        raise exception '% админа может только создатель сайта', initcap(p_what);
    end if;
end $$;

-- 4. Mute: apply / remove
create or replace function public.admin_mute(p_target uuid, p_minutes int default 15, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid   uuid := auth.uid();
    v_caller text;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    v_caller := public._require_mod();
    if p_target is null then raise exception 'Игрок не указан'; end if;
    if p_target = v_uid then raise exception 'Нельзя замутить самого себя'; end if;
    perform public._mod_can_touch(v_caller, p_target, 'замутить');
    if p_minutes not between 1 and 10080 then
        raise exception 'Минуты: от 1 до 10080 (7 суток)';
    end if;
    insert into public.mutes (user_id, muted_by, until, reason)
    values (p_target, v_uid,
            greatest(coalesce((select until from public.mutes where user_id = p_target), now()), now())
                + make_interval(mins => p_minutes),
            nullif(btrim(coalesce(p_reason, '')), ''))
    on conflict (user_id) do update
        set until    = excluded.until,
            muted_by = excluded.muted_by,
            reason   = coalesce(excluded.reason, public.mutes.reason),
            created_at = now();
end $$;

create or replace function public.admin_unmute(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    perform public._require_mod();
    delete from public.mutes where user_id = p_target;
end $$;

-- 5. Delete any public message
-- p_kind: 'global' (global chat) | 'club' (club chat) | 'forum_reply' (forum reply)
-- Game chat and DMs are not public messages and are never deleted here.
create or replace function public.admin_delete_public_message(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    perform public._require_mod();
    if p_id is null then raise exception 'Сообщение не указано'; end if;
    if p_kind = 'global' then
        delete from public.chat_messages where id = p_id;
    elsif p_kind = 'club' then
        delete from public.club_chat where id = p_id;
    elsif p_kind = 'forum_reply' then
        delete from public.forum_replies where id = p_id;
    else
        raise exception 'Неизвестный тип сообщения';
    end if;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Сообщение не найдено (возможно, уже удалено)'; end if;
end $$;

-- 6. Delete club / forum thread / blog post
-- Whole content units are deleted by the site creator only; moderators
-- delete individual public messages (see 5).
create or replace function public.admin_delete_club(p_club_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    if public.p_role(auth.uid()) <> 'creator' then
        raise exception 'Недостаточно прав: клуб может удалить только создатель сайта';
    end if;
    delete from public.clubs where id = p_club_id;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Клуб не найден (возможно, уже удалён)'; end if;
end $$;

create or replace function public.admin_delete_thread(p_thread_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    if public.p_role(auth.uid()) <> 'creator' then
        raise exception 'Недостаточно прав: тему может удалить только создатель сайта';
    end if;
    delete from public.forum_threads where id = p_thread_id;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Тема не найдена (возможно, уже удалена)'; end if;
end $$;

create or replace function public.admin_delete_blog_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    if public.p_role(auth.uid()) <> 'creator' then
        raise exception 'Недостаточно прав: пост может удалить только создатель сайта';
    end if;
    delete from public.blog_posts where id = p_post_id;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Пост не найден (возможно, уже удалён)'; end if;
end $$;

-- 7. Ban / unban
create or replace function public.admin_ban(p_target uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid    uuid := auth.uid();
    v_caller text;
    g        games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    v_caller := public._require_mod();
    if p_target is null then raise exception 'Игрок не указан'; end if;
    if p_target = v_uid then raise exception 'Нельзя забанить самого себя'; end if;
    perform public._mod_can_touch(v_caller, p_target, 'забанить');

    update public.profiles
    set is_banned = true,
        ban_reason = nullif(btrim(coalesce(p_reason, '')), '')
    where id = p_target;

    -- active games: forfeit loss for the banned player ("opponent blocked")
    for g in select * from public.games
             where status = 'active' and (white = p_target or black = p_target)
    loop
        perform public._finish_game(
            g.id,
            case when g.white = p_target then '0-1' else '1-0' end,
            case when g.white = p_target then g.black else g.white end,
            'forfeit');
    end loop;

    -- leave the pairing queue and remove their waiting challenges
    delete from public.seeks where user_id = p_target;
    delete from public.games where status = 'waiting' and (white = p_target or black = p_target);
end $$;

create or replace function public.admin_unban(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    perform public._require_mod();
    update public.profiles set is_banned = false, ban_reason = null where id = p_target;
    delete from public.mutes where user_id = p_target;
end $$;

-- 8. Delete account
-- Deletes the auth.users row, cascading to the profile and all of its
-- content (games, messages, clubs, etc.).
create or replace function public.admin_delete_account(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid          uuid := auth.uid();
    v_caller       text;
    v_target_role  text;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    v_caller := public._require_mod();
    if p_target is null then raise exception 'Игрок не указан'; end if;
    if p_target = v_uid then raise exception 'Свой аккаунт нельзя удалить через модерацию'; end if;
    select role into v_target_role from public.profiles where id = p_target;
    if not found then raise exception 'Игрок не найден'; end if;
    if v_target_role = 'creator' then
        raise exception 'Аккаунт создателя сайта удалить нельзя';
    end if;
    if v_target_role = 'admin' and v_caller <> 'creator' then
        raise exception 'Аккаунт админа может удалить только создатель сайта';
    end if;
    delete from auth.users where id = p_target;
    if not found then raise exception 'Аккаунт не найден'; end if;
end $$;

-- 9. Assign role (user / creator / admin)
create or replace function public.admin_set_role(p_target uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid         uuid := auth.uid();
    v_caller      text;
    v_target_role text;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    v_caller := public._require_mod();
    if p_role not in ('user','creator','admin') then raise exception 'Неизвестный статус'; end if;
    if p_target is null then raise exception 'Игрок не указан'; end if;
    if p_target = v_uid then raise exception 'Нельзя менять свой собственный статус'; end if;
    select role into v_target_role from public.profiles where id = p_target;
    if not found then raise exception 'Игрок не найден'; end if;
    if v_target_role = 'creator' then
        raise exception 'Статус создателя сайта изменить нельзя';
    end if;
    if v_target_role = 'admin' and v_caller <> 'creator' then
        raise exception 'Статус админа может менять только создатель сайта';
    end if;
    update public.profiles set role = p_role where id = p_target;
end $$;

-- 10. Mutes apply in public places
-- Global chat: writing while muted is denied (games and DMs untouched)
create or replace function public.send_global_chat(p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row chat_messages%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if public.is_muted(v_uid) then
        raise exception 'Вы в муте: публичные сообщения недоступны ещё % мин.',
            greatest(1, ceil(extract(epoch from (public.mute_until(v_uid) - now())) / 60)::int);
    end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
        raise exception 'Сообщение должно быть от 1 до 500 символов';
    end if;
    -- rate limit: one message per 800 ms
    if exists (select 1 from public.chat_messages c
               where c.user_id = v_uid
                 and c.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into public.chat_messages (user_id, body)
    values (v_uid, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

-- Club chat: the same
create or replace function public.send_club_chat(p_club_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row club_chat%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if public.is_muted(v_uid) then
        raise exception 'Вы в муте: публичные сообщения недоступны ещё % мин.',
            greatest(1, ceil(extract(epoch from (public.mute_until(v_uid) - now())) / 60)::int);
    end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
        raise exception 'Сообщение должно быть от 1 до 500 символов';
    end if;
    if not exists (select 1 from club_members m
                   where m.club_id = p_club_id and m.user_id = v_uid) then
        raise exception 'Чат клуба доступен только участникам клуба';
    end if;
    -- rate limit: one message per 800 ms
    if exists (select 1 from club_chat c
               where c.user_id = v_uid
                 and c.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into club_chat (club_id, user_id, body)
    values (p_club_id, v_uid, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

-- Forum and blog: enforced in the INSERT policies below (direct inserts)

-- 11. Policies: no forum or blog writes while muted
drop policy if exists "threads_insert_auth" on public.forum_threads;
create policy "threads_insert_auth" on public.forum_threads for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
        and not public.is_muted(auth.uid())
    );

drop policy if exists "replies_insert_auth" on public.forum_replies;
create policy "replies_insert_auth" on public.forum_replies for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
        and exists (select 1 from public.forum_threads t where t.id = thread_id)
        and not public.is_muted(auth.uid())
    );

drop policy if exists "blog_insert_auth" on public.blog_posts;
create policy "blog_insert_auth" on public.blog_posts for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned = false)
        and not public.is_muted(auth.uid())
    );

-- 12. Permissions
revoke execute on function public.admin_mute(uuid, int, text)        from public, anon;
revoke execute on function public.admin_unmute(uuid)                 from public, anon;
revoke execute on function public.admin_delete_public_message(text, uuid) from public, anon;
revoke execute on function public.admin_delete_club(uuid)            from public, anon;
revoke execute on function public.admin_delete_thread(uuid)          from public, anon;
revoke execute on function public.admin_delete_blog_post(uuid)       from public, anon;
revoke execute on function public.admin_ban(uuid, text)              from public, anon;
revoke execute on function public.admin_unban(uuid)                  from public, anon;
revoke execute on function public.admin_delete_account(uuid)         from public, anon;
revoke execute on function public.admin_set_role(uuid, text)         from public, anon;
revoke execute on function public.p_role(uuid)                       from public, anon, authenticated;
revoke execute on function public._require_mod()                     from public, anon, authenticated;
revoke execute on function public._mod_can_touch(text, uuid, text)   from public, anon, authenticated;

grant execute on function public.admin_mute(uuid, int, text)         to authenticated;
grant execute on function public.admin_unmute(uuid)                  to authenticated;
grant execute on function public.admin_delete_public_message(text, uuid) to authenticated;
grant execute on function public.admin_delete_club(uuid)             to authenticated;
grant execute on function public.admin_delete_thread(uuid)           to authenticated;
grant execute on function public.admin_delete_blog_post(uuid)        to authenticated;
grant execute on function public.admin_ban(uuid, text)               to authenticated;
grant execute on function public.admin_unban(uuid)                   to authenticated;
grant execute on function public.admin_delete_account(uuid)          to authenticated;
grant execute on function public.admin_set_role(uuid, text)          to authenticated;

-- is_muted/mute_until back the policies and are handy for the UI
grant execute on function public.is_muted(uuid)                      to authenticated;
grant execute on function public.mute_until(uuid)                    to authenticated;
