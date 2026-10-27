-- Permission hardening: mutating RPCs are restricted to authenticated;
-- the private _finish_game is callable by no one from outside.

-- game/account services: revoke from PUBLIC, grant to authenticated
revoke execute on function public.make_move(uuid, text)           from public;
revoke execute on function public.resign(uuid)                    from public;
revoke execute on function public.abort_game(uuid)                from public;
revoke execute on function public.claim_flag(uuid)                from public;
revoke execute on function public.claim_abandon(uuid)             from public;
revoke execute on function public.offer_draw(uuid)                from public;
revoke execute on function public.accept_draw(uuid)               from public;
revoke execute on function public.decline_draw(uuid)              from public;
revoke execute on function public.request_takeback(uuid)          from public;
revoke execute on function public.accept_takeback(uuid)           from public;
revoke execute on function public.decline_takeback(uuid)          from public;
revoke execute on function public.send_chat(uuid, text)           from public;
revoke execute on function public.send_club_chat(uuid, text)      from public;
revoke execute on function public.set_username(text)              from public;
revoke execute on function public.quick_pair(int, int)            from public;
revoke execute on function public.cancel_seek()                   from public;
-- create_challenge has the 5-argument canonical form (p_invitee added
-- in 06); the revoke/grant below use the same signature
revoke execute on function public.create_challenge(int, int, boolean, text, uuid) from public;
revoke execute on function public.cancel_waiting_game(uuid)       from public;
revoke execute on function public.join_game(uuid)                 from public;

grant execute on function public.make_move(uuid, text)           to authenticated;
grant execute on function public.resign(uuid)                    to authenticated;
grant execute on function public.abort_game(uuid)                to authenticated;
grant execute on function public.claim_flag(uuid)                to authenticated;
grant execute on function public.claim_abandon(uuid)             to authenticated;
grant execute on function public.offer_draw(uuid)                to authenticated;
grant execute on function public.accept_draw(uuid)               to authenticated;
grant execute on function public.decline_draw(uuid)              to authenticated;
grant execute on function public.request_takeback(uuid)          to authenticated;
grant execute on function public.accept_takeback(uuid)           to authenticated;
grant execute on function public.decline_takeback(uuid)          to authenticated;
grant execute on function public.send_chat(uuid, text)           to authenticated;
grant execute on function public.send_club_chat(uuid, text)      to authenticated;
grant execute on function public.set_username(text)              to authenticated;
grant execute on function public.quick_pair(int, int)            to authenticated;
grant execute on function public.cancel_seek()                   to authenticated;
grant execute on function public.create_challenge(int, int, boolean, text, uuid) to authenticated;
grant execute on function public.cancel_waiting_game(uuid)       to authenticated;
grant execute on function public.join_game(uuid)                 to authenticated;

-- private finalization function: not callable externally
revoke execute on function public._finish_game(uuid, text, uuid, text) from public;
revoke execute on function public._finish_game(uuid, text, uuid, text) from authenticated;
revoke execute on function public._finish_game(uuid, text, uuid, text) from anon;

-- public services (spectators/lobby) stay available to everyone:
-- get_game_state(uuid), server_now_ms(), chess_san, chess_get_moves, etc.
