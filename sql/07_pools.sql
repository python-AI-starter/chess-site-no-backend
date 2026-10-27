-- Rating pools: bullet / blitz / rapid / classic. Starting rating 1000.
-- A game's class follows the estimated duration est = initial + 40*increment
-- (seconds): est < 180 bullet (ultra-bullet has no pool; controls shorter
-- than 30 s are banned because parallel 15+0 streams load the database
-- like a DDOS), est < 480 blitz, est < 1620 rapid, otherwise classic.
-- Idempotent; depends on 02/03/04/05/06.

-- 1. Pool columns
alter table public.profiles
    add column if not exists rating_bullet  int not null default 1000,
    add column if not exists rating_blitz   int not null default 1000,
    add column if not exists rating_rapid   int not null default 1000,
    add column if not exists rating_classic int not null default 1000,
    add column if not exists games_bullet   int not null default 0,
    add column if not exists games_blitz    int not null default 0,
    add column if not exists games_rapid    int not null default 0,
    add column if not exists games_classic  int not null default 0;

-- starting rating 1000
alter table public.profiles alter column rating set default 1000;

create index if not exists profiles_rating_bullet_idx  on public.profiles (rating_bullet desc);
create index if not exists profiles_rating_blitz_idx   on public.profiles (rating_blitz desc);
create index if not exists profiles_rating_rapid_idx   on public.profiles (rating_rapid desc);
create index if not exists profiles_rating_classic_idx on public.profiles (rating_classic desc);

-- 1.1 Minimum time control: 30 seconds
-- Ultra-bullet (games under 30 s, e.g. 15+0) is disabled: with several
-- parallel games the move stream loads the database like a DDOS. The
-- client already enforces a 1 minute minimum; this adds the same guard
-- at the database/RPC level.
alter table public.games drop constraint if exists games_initial_ms_check;
alter table public.games
    add constraint games_initial_ms_check check (initial_ms between 30000 and 7200000);

-- 2. Game class
create or replace function public.game_time_class(p_initial_ms int, p_increment_ms int)
returns text language sql immutable as $$
    select case
        when (p_initial_ms + 40 * p_increment_ms) / 1000 < 180  then 'bullet'
        when (p_initial_ms + 40 * p_increment_ms) / 1000 < 480  then 'blitz'
        when (p_initial_ms + 40 * p_increment_ms) / 1000 < 1620 then 'rapid'
        else 'classic'
    end
$$;

-- 3. Finalization: Elo for global and pool ratings
create or replace function public._finish_game(
    p_game_id uuid, p_result text, p_winner uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
    g            games%rowtype;
    v_counted    boolean;
    v_rw         int;
    v_rb         int;
    v_score_w    float;
    v_expected_w float;
    v_delta_w    int;
    -- pool
    v_class      text;
    v_rw_c       int;
    v_rb_c       int;
    v_delta_w_c  int;
    v_pool_delta jsonb;
begin
    select * into g from games where id = p_game_id for update;
    if not found then return; end if;
    if g.status in ('finished','aborted') then return; end if; -- idempotent

    v_counted := coalesce(jsonb_array_length(g.moves), 0) >= 2; -- both players moved

    v_pool_delta := null;
    if v_counted and g.white is not null and g.black is not null then
        -- rating and stats only when both sides moved; deltas are computed
        -- before writing so games updates in a single statement
        v_score_w := case when p_result = '1-0' then 1.0
                          when p_result = '0-1' then 0.0 else 0.5 end;

        -- global rating
        select rating into v_rw from profiles where id = g.white;
        select rating into v_rb from profiles where id = g.black;

        if g.rated and v_rw is not null and v_rb is not null then
            v_expected_w := 1.0 / (1.0 + power(10.0, (v_rb - v_rw)::float / 400.0));
            v_delta_w    := round(32 * (v_score_w - v_expected_w))::int;
        else
            v_delta_w := 0;
        end if;

        -- pool (separate Elo per class)
        v_class := public.game_time_class(g.initial_ms, g.increment_ms);
        if v_class = 'bullet' then
            select rating_bullet into v_rw_c from profiles where id = g.white;
            select rating_bullet into v_rb_c from profiles where id = g.black;
        elsif v_class = 'blitz' then
            select rating_blitz into v_rw_c from profiles where id = g.white;
            select rating_blitz into v_rb_c from profiles where id = g.black;
        elsif v_class = 'rapid' then
            select rating_rapid into v_rw_c from profiles where id = g.white;
            select rating_rapid into v_rb_c from profiles where id = g.black;
        else
            select rating_classic into v_rw_c from profiles where id = g.white;
            select rating_classic into v_rb_c from profiles where id = g.black;
        end if;

        if g.rated and v_rw_c is not null and v_rb_c is not null then
            v_delta_w_c := round(32 * (v_score_w
                - 1.0 / (1.0 + power(10.0, (v_rb_c - v_rw_c)::float / 400.0))))::int;
        else
            v_delta_w_c := 0;
        end if;

        v_pool_delta := jsonb_build_object(
            'white', v_delta_w, 'black', -v_delta_w,
            'class', v_class,
            'white_class', v_delta_w_c, 'black_class', -v_delta_w_c);
    else
        v_delta_w := 0;
        v_delta_w_c := 0;
        v_class := null;
    end if;

    -- the result is always recorded (including first-move flags and
    -- cheats) in a single update
    update games set status = 'finished', result = p_result, winner = p_winner,
                     reason = p_reason, finished_at = now(),
                     rating_delta = v_pool_delta
    where id = g.id;

    if not v_counted then return; end if;
    if g.white is null or g.black is null then return; end if;

    -- white
    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '1-0' then 1 else 0 end),
        losses = losses + (case when p_result = '0-1' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating + v_delta_w) else rating end,
        games_bullet   = games_bullet   + (case when v_class = 'bullet'  then 1 else 0 end),
        games_blitz    = games_blitz    + (case when v_class = 'blitz'   then 1 else 0 end),
        games_rapid    = games_rapid    + (case when v_class = 'rapid'   then 1 else 0 end),
        games_classic  = games_classic  + (case when v_class = 'classic' then 1 else 0 end),
        rating_bullet  = case when g.rated and v_class = 'bullet'
                               then greatest(100, rating_bullet + v_delta_w_c) else rating_bullet end,
        rating_blitz   = case when g.rated and v_class = 'blitz'
                               then greatest(100, rating_blitz + v_delta_w_c) else rating_blitz end,
        rating_rapid   = case when g.rated and v_class = 'rapid'
                               then greatest(100, rating_rapid + v_delta_w_c) else rating_rapid end,
        rating_classic = case when g.rated and v_class = 'classic'
                               then greatest(100, rating_classic + v_delta_w_c) else rating_classic end
    where id = g.white;

    -- black
    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '0-1' then 1 else 0 end),
        losses = losses + (case when p_result = '1-0' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating - v_delta_w) else rating end,
        games_bullet   = games_bullet   + (case when v_class = 'bullet'  then 1 else 0 end),
        games_blitz    = games_blitz    + (case when v_class = 'blitz'   then 1 else 0 end),
        games_rapid    = games_rapid    + (case when v_class = 'rapid'   then 1 else 0 end),
        games_classic  = games_classic  + (case when v_class = 'classic' then 1 else 0 end),
        rating_bullet  = case when g.rated and v_class = 'bullet'
                               then greatest(100, rating_bullet - v_delta_w_c) else rating_bullet end,
        rating_blitz   = case when g.rated and v_class = 'blitz'
                               then greatest(100, rating_blitz - v_delta_w_c) else rating_blitz end,
        rating_rapid   = case when g.rated and v_class = 'rapid'
                               then greatest(100, rating_rapid - v_delta_w_c) else rating_rapid end,
        rating_classic = case when g.rated and v_class = 'classic'
                               then greatest(100, rating_classic - v_delta_w_c) else rating_classic end
    where id = g.black;
end $$;

-- 4. Permissions
-- game_time_class stays internal; not exposed
revoke execute on function public.game_time_class(int, int) from public, anon;
-- _finish_game remains unreachable directly (internal calls only)
revoke execute on function public._finish_game(uuid, text, uuid, text) from public, anon, authenticated;
